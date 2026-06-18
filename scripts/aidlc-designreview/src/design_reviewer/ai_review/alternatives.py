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
Alternatives agent for Unit 4: AI Review.

Generates alternative design approaches linked to critique findings.
Story 6.3.
"""

import json
import logging

from ..foundation.exceptions import BedrockAPIError
from ..foundation.pattern_library import PatternLibrary
from ..parsing.models import DesignData
from .base import BaseAgent
from .models import (
    AgentStatus,
    AlternativesResult,
    AlternativeSuggestion,
    CritiqueResult,
    TradeOff,
)
from .response_parser import parse_response

logger = logging.getLogger("design_reviewer")


class AlternativesAgent(BaseAgent):
    """Generates alternative design approaches addressing critique findings."""

    # SECURITY: Enable response schema validation
    _expected_response_keys = {"suggestions"}

    def __init__(self) -> None:
        super().__init__(agent_name="alternatives")

    def execute(
        self,
        design_data: DesignData,
        critique_result: CritiqueResult = None,
        **kwargs,
    ) -> AlternativesResult:
        """
        Execute alternatives analysis.

        Args:
            design_data: Parsed design artifacts from Unit 3.
            critique_result: Optional critique results for finding links.

        Returns:
            AlternativesResult with design suggestions.
        """
        # Step 1: Build context with critique findings
        critique_text = ""
        if critique_result and critique_result.findings:
            critique_text = json.dumps(
                [
                    {
                        "id": f.id,
                        "title": f.title,
                        "severity": f.severity.value,
                        "description": f.description,
                        "location": f.location,
                    }
                    for f in critique_result.findings
                ],
                indent=2,
            )

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

        context = {
            "design_document": "\n\n".join(parts)
            if parts
            else "(No design document content provided)",
            "patterns": PatternLibrary.get_instance().format_patterns_for_prompt(),
            "constraints": critique_text,
        }

        # Step 2: Build prompt
        prompt = self._build_prompt(context)

        # Step 3: Invoke model
        try:
            raw_text, usage = self._invoke_model(prompt)
        except BedrockAPIError:
            raise

        # Step 4: Parse and transform
        parsed = parse_response(raw_text, {"suggestions": list})

        suggestions = []
        raw_on_result = None

        recommendation = ""

        if "parse_error" in parsed:
            logger.warning(
                "Alternatives agent: partial parse — %s", parsed["parse_error"]
            )
            raw_on_result = parsed.get("raw_response", raw_text)
        elif "suggestions" in parsed:
            recommendation = parsed.get("recommendation", "")
            for suggestion_dict in parsed["suggestions"]:
                try:
                    trade_offs = [
                        TradeOff(type=t["type"], description=t["description"])
                        for t in suggestion_dict.get("trade_offs", [])
                    ]
                    suggestion = AlternativeSuggestion(
                        title=suggestion_dict.get("title", "Untitled"),
                        overview=suggestion_dict.get("overview", ""),
                        what_changes=suggestion_dict.get("what_changes", ""),
                        advantages=suggestion_dict.get("advantages", []),
                        disadvantages=suggestion_dict.get("disadvantages", []),
                        implementation_complexity=suggestion_dict.get(
                            "implementation_complexity"
                        ),
                        complexity_justification=suggestion_dict.get(
                            "complexity_justification", ""
                        ),
                        description=suggestion_dict.get("description", ""),
                        trade_offs=trade_offs,
                        related_finding_id=suggestion_dict.get("related_finding_id"),
                    )
                    suggestions.append(suggestion)
                except (ValueError, KeyError) as e:
                    logger.warning("Skipping malformed alternative suggestion: %s", e)

        # Step 5: Return result
        return AlternativesResult(
            suggestions=suggestions,
            recommendation=recommendation,
            agent_name="alternatives",
            status=AgentStatus.COMPLETED,
            error_message=None,
            raw_response=raw_on_result,
            token_usage=usage,
        )
