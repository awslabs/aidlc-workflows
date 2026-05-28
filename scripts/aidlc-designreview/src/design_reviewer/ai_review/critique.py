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
Critique agent for Unit 4: AI Review.

Analyzes design artifacts for issues with severity-rated findings.
Story 6.2.
"""

import logging

from ..foundation.exceptions import BedrockAPIError
from ..foundation.pattern_library import PatternLibrary
from ..parsing.models import DesignData
from .base import BaseAgent
from .models import (
    AgentStatus,
    CritiqueFinding,
    CritiqueResult,
    Severity,
)
from .response_parser import parse_response

logger = logging.getLogger("design_reviewer")


class CritiqueAgent(BaseAgent):
    """Analyzes design artifacts for issues, anti-patterns, and design flaws."""

    # SECURITY: Enable response schema validation
    _expected_response_keys = {"findings"}

    def __init__(self) -> None:
        super().__init__(agent_name="critique")

    def execute(self, design_data: DesignData, **kwargs) -> CritiqueResult:
        """
        Execute critique analysis on design data.

        Args:
            design_data: Parsed design artifacts from Unit 3.

        Returns:
            CritiqueResult with severity-rated findings.
        """
        # Step 1: Build context — combine design artifacts into design_document
        from ..foundation.config_manager import ConfigManager

        parts = []
        if design_data.app_design and design_data.app_design.raw_content:
            parts.append(
                f"## Application Design\n\n{design_data.app_design.raw_content}"
            )
        if (
            design_data.functional_designs
            and design_data.functional_designs.raw_content
        ):
            parts.append(
                f"## Functional Design\n\n{design_data.functional_designs.raw_content}"
            )
        if design_data.tech_env and design_data.tech_env.raw_content:
            parts.append(
                f"## Technical Environment\n\n{design_data.tech_env.raw_content}"
            )

        config = ConfigManager.get_instance().get_config()
        severity = (
            getattr(config.review, "severity_threshold", "medium")
            if config.review
            else "medium"
        )

        context = {
            "design_document": "\n\n".join(parts)
            if parts
            else "(No design document content provided)",
            "patterns": PatternLibrary.get_instance().format_patterns_for_prompt(),
            "severity_threshold": severity,
        }

        # Step 2: Build prompt
        prompt = self._build_prompt(context)

        # Step 3: Invoke model
        try:
            raw_text, usage = self._invoke_model(prompt)
        except BedrockAPIError:
            raise

        # Step 4: Parse response
        parsed = parse_response(raw_text, {"findings": list})

        # Step 5: Transform to findings
        findings = []
        raw_on_result = None

        if "parse_error" in parsed:
            logger.warning("Critique agent: partial parse — %s", parsed["parse_error"])
            raw_on_result = parsed.get("raw_response", raw_text)
        elif "findings" in parsed:
            for finding_dict in parsed["findings"]:
                try:
                    finding = CritiqueFinding(
                        title=finding_dict.get("title", "Untitled"),
                        severity=Severity(finding_dict.get("severity", "medium")),
                        description=finding_dict.get("description", ""),
                        location=finding_dict.get("location", "Unknown"),
                        recommendation=finding_dict.get("recommendation", ""),
                    )
                    findings.append(finding)
                except (ValueError, KeyError) as e:
                    logger.warning("Skipping malformed critique finding: %s", e)

        # Step 6: Return result
        return CritiqueResult(
            findings=findings,
            agent_name="critique",
            status=AgentStatus.COMPLETED,
            error_message=None,
            raw_response=raw_on_result,
            token_usage=usage,
        )
