# Copyright (c) 2026 AIDLC Design Reviewer Contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""
Base agent ABC for Unit 4: AI Review.

Provides Strands SDK integration, model invocation with backoff retry,
prompt building, and token usage extraction.
Patterns: 4.1 (Strands Wrapper), 4.2 (Dual Retry), 4.6 (Timing/Tokens).
"""

import json
import logging
import re
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Set, Tuple

import boto3
import backoff
from strands import Agent as StrandsAgent
from strands.models import BedrockModel

from ..foundation.config_manager import ConfigManager
from ..foundation.exceptions import BedrockAPIError
from ..foundation.prompt_manager import PromptManager
from .retry import is_retryable

logger = logging.getLogger("design_reviewer")


class BaseAgent(ABC):
    """
    Abstract base agent wrapping Strands SDK.

    Subclasses implement execute() for their specific analysis.
    """

    # Subclasses can override this to enable response schema validation
    _expected_response_keys: Optional[Set[str]] = None

    def __init__(self, agent_name: str) -> None:
        self.agent_name = agent_name

        config_mgr = ConfigManager.get_instance()
        self.model_id = config_mgr.to_bedrock_model_id(
            config_mgr.get_model_config(agent_name)
        )

        review_settings = config_mgr.get_review_settings()
        self.max_tokens = getattr(review_settings, f"max_tokens_{agent_name}", 65536)

        aws_config = config_mgr.get_aws_config()

        # SECURITY: Only use profile-based authentication (IAM roles, SSO, temporary credentials)
        boto_session = boto3.Session(
            profile_name=aws_config.profile_name,
            region_name=aws_config.region,
        )

        # SECURITY: Extract Bedrock Guardrails configuration (optional but strongly recommended)
        guardrail_config = {}
        if aws_config.guardrail_id:
            guardrail_config = {
                "guardrail_id": aws_config.guardrail_id,
                "guardrail_version": aws_config.guardrail_version or "DRAFT",
            }
            logger.info(
                "Bedrock Guardrails ENABLED for agent '%s': %s (version %s)",
                agent_name,
                guardrail_config["guardrail_id"],
                guardrail_config["guardrail_version"],
            )
        else:
            logger.warning(
                "⚠️  Bedrock Guardrails NOT configured for agent '%s'. "
                "This is acceptable for development/testing but STRONGLY RECOMMENDED "
                "for production. See docs/ai-security/BEDROCK_GUARDRAILS.md",
                agent_name,
            )

        bedrock_model = BedrockModel(
            model_id=self.model_id,
            max_tokens=self.max_tokens,
            boto_session=boto_session,
            **guardrail_config,  # Pass guardrails if configured
        )
        self._strands_agent = StrandsAgent(model=bedrock_model)

    @abstractmethod
    def execute(self, design_data: Any, **kwargs) -> Any:
        """Execute the agent's analysis on the provided design data."""
        ...

    def _build_prompt(self, context: Dict[str, str]) -> str:
        """Build prompt via PromptManager singleton."""
        prompt_manager = PromptManager.get_instance()
        return prompt_manager.build_agent_prompt(self.agent_name, context)

    @backoff.on_exception(
        backoff.expo,
        Exception,
        max_tries=4,
        base=2,
        giveup=lambda e: not is_retryable(e),
        on_backoff=lambda details: logging.getLogger("design_reviewer").warning(
            "Retry %d for agent invocation: %s",
            details["tries"],
            details["exception"],
        ),
    )
    def _invoke_model(self, prompt: str) -> Tuple[str, dict]:
        """
        Invoke model via Strands agent with backoff retry.

        Args:
            prompt: Input prompt (must be non-empty string).

        Returns:
            Tuple of (response_text, usage_metadata).

        Raises:
            BedrockAPIError: On API failure after retries exhausted or invalid input.
        """
        # SECURITY: Input validation before sending to Amazon Bedrock
        if not isinstance(prompt, str):
            raise BedrockAPIError(
                f"Invalid prompt type: expected str, got {type(prompt).__name__}"
            )

        if not prompt or not prompt.strip():
            raise BedrockAPIError("Empty prompt provided to Amazon Bedrock model")

        # Limit input size (Claude models support up to 200k tokens, ~800KB text)
        max_prompt_length = 750000  # ~750KB to stay well under token limits
        if len(prompt) > max_prompt_length:
            logger.warning(
                f"Prompt exceeds {max_prompt_length} chars, truncating for agent '%s'",
                self.agent_name,
            )
            prompt = prompt[:max_prompt_length] + "\n\n[Content truncated for length]"

        start = time.perf_counter()
        try:
            response = self._strands_agent(prompt)
            elapsed = time.perf_counter() - start
            text = str(response)

            # SECURITY: Validate response schema if subclass defines expected keys
            if self._expected_response_keys is not None:
                if not self._validate_response_schema(text, self._expected_response_keys):
                    logger.error(
                        "Response schema validation failed for agent '%s'. "
                        "Possible prompt injection or model malfunction.",
                        self.agent_name,
                    )
                    raise BedrockAPIError(
                        f"Response schema validation failed for agent '{self.agent_name}'. "
                        "This may indicate prompt injection or model output corruption."
                    )

            usage = self._extract_token_usage(response)
            logger.info(  # nosemgrep: python-logger-credential-disclosure — logs API usage token COUNTS (integers), not auth tokens or credentials
                "Agent '%s' completed in %.2fs (input: %s tokens, output: %s tokens)",
                self.agent_name,
                elapsed,
                usage.get("input_tokens", "?"),
                usage.get("output_tokens", "?"),
            )
            return text, usage
        except Exception as e:
            raise BedrockAPIError(str(e)) from e

    def _extract_token_usage(self, response: Any) -> dict:
        """
        Extract token counts from Strands AgentResult.

        Strands SDK returns metrics.accumulated_usage as a dict with
        keys 'inputTokens', 'outputTokens', 'totalTokens'.
        """
        # Strands SDK AgentResult: metrics.accumulated_usage (dict)
        if hasattr(response, "metrics") and hasattr(
            response.metrics, "accumulated_usage"
        ):
            usage = response.metrics.accumulated_usage
            if isinstance(usage, dict):
                input_tokens = usage.get("inputTokens", 0) or 0
                output_tokens = usage.get("outputTokens", 0) or 0
                if input_tokens or output_tokens:
                    return {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                    }
            else:
                # Handle case where accumulated_usage is a dataclass/object
                input_tokens = getattr(usage, "inputTokens", 0) or 0
                output_tokens = getattr(usage, "outputTokens", 0) or 0
                if input_tokens or output_tokens:
                    return {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                    }

        # Fallback: response.usage dict
        if hasattr(response, "usage") and isinstance(response.usage, dict):
            return {
                "input_tokens": response.usage.get("inputTokens", 0),
                "output_tokens": response.usage.get("outputTokens", 0),
            }

        return {"input_tokens": 0, "output_tokens": 0}

    def _extract_json_from_markdown(self, text: str) -> str:
        """
        Extract JSON from markdown code blocks if present.

        LLMs often wrap JSON in markdown code fences:
        ```json
        {"key": "value"}
        ```

        This method strips those fences if present, otherwise returns the original text.
        Uses the same regex pattern as response_parser.py for consistency.

        Args:
            text: Raw response text (may contain markdown)

        Returns:
            JSON string with markdown fences removed
        """
        text = text.strip()

        # Try to extract from markdown code block (same pattern as response_parser.py)
        code_block_match = re.search(r"```(?:json)?\s*\n(.*?)\n```", text, re.DOTALL)
        if code_block_match:
            return code_block_match.group(1).strip()

        # If no code block, try brace extraction as fallback
        first_brace = text.find("{")
        last_brace = text.rfind("}")
        if first_brace != -1 and last_brace > first_brace:
            return text[first_brace : last_brace + 1]

        return text

    def _validate_response_schema(self, response_text: str, expected_keys: Set[str]) -> bool:
        """
        Validate that model response conforms to expected JSON schema.

        This provides defense-in-depth against prompt injection: if an attacker
        manipulates the model into changing its output format, this validation
        will catch it.

        Args:
            response_text: Raw model response
            expected_keys: Set of required top-level JSON keys

        Returns:
            True if valid, False otherwise
        """
        try:
            # Extract JSON from markdown code blocks if present
            json_text = self._extract_json_from_markdown(response_text)
            parsed = json.loads(json_text)

            if not isinstance(parsed, dict):
                logger.warning(
                    "Response is not a JSON object for agent '%s'", self.agent_name
                )
                return False

            missing_keys = expected_keys - set(parsed.keys())
            if missing_keys:
                logger.warning(
                    "Response missing required keys for agent '%s': %s",
                    self.agent_name,
                    missing_keys,
                )
                return False

            return True
        except json.JSONDecodeError as e:
            logger.warning(
                "Invalid JSON response from agent '%s': %s", self.agent_name, e
            )
            return False
