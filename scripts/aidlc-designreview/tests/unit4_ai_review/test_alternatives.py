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


"""Tests for AlternativesAgent."""

from unittest.mock import MagicMock

import pytest

from src.design_reviewer.ai_review.alternatives import AlternativesAgent
from src.design_reviewer.ai_review.models import (
    AgentStatus,
    AlternativesResult,
    CritiqueFinding,
    CritiqueResult,
    Severity,
)
from src.design_reviewer.foundation.exceptions import BedrockAPIError


def _mock_response(text, input_tokens=100, output_tokens=50):
    """Create a mock Strands AgentResult with metrics (dict, matching real SDK)."""
    resp = MagicMock()
    resp.__str__ = lambda self: text
    resp.metrics.accumulated_usage = {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": input_tokens + output_tokens,
    }
    return resp


class TestAlternativesAgentExecute:
    def test_valid_response_with_rich_fields(
        self, mock_singletons, sample_design_data, alternatives_response_text
    ):
        mock_singletons["strands_instance"].return_value = _mock_response(
            alternatives_response_text, 400, 250
        )

        agent = AlternativesAgent()
        result = agent.execute(sample_design_data)

        assert isinstance(result, AlternativesResult)
        assert result.status == AgentStatus.COMPLETED
        assert len(result.suggestions) == 3

        # First suggestion is the current approach
        current = result.suggestions[0]
        assert "Current Approach" in current.title
        assert current.overview != ""
        assert current.what_changes != ""
        assert len(current.advantages) >= 2
        assert len(current.disadvantages) >= 2
        assert current.implementation_complexity == "low"
        assert current.complexity_justification != ""

        # Second suggestion has trade_offs (legacy) and new fields
        alt2 = result.suggestions[1]
        assert "Event-Driven" in alt2.title
        assert len(alt2.trade_offs) == 4
        assert alt2.trade_offs[0].type == "pro"
        assert len(alt2.advantages) >= 2
        assert len(alt2.disadvantages) >= 2
        assert alt2.implementation_complexity == "high"

    def test_recommendation_parsed(
        self, mock_singletons, sample_design_data, alternatives_response_text
    ):
        mock_singletons["strands_instance"].return_value = _mock_response(
            alternatives_response_text, 400, 250
        )

        agent = AlternativesAgent()
        result = agent.execute(sample_design_data)

        assert result.recommendation != ""
        assert "Alternative 2" in result.recommendation

    def test_related_finding_id_linked(
        self, mock_singletons, sample_design_data, alternatives_response_text
    ):
        mock_singletons["strands_instance"].return_value = _mock_response(
            alternatives_response_text, 400, 250
        )

        agent = AlternativesAgent()
        result = agent.execute(sample_design_data)

        assert result.suggestions[0].related_finding_id == "abc123def4567890"
        assert result.suggestions[2].related_finding_id is None

    def test_with_critique_result(self, mock_singletons, sample_design_data):
        critique = CritiqueResult(
            findings=[
                CritiqueFinding(
                    id="finding123abc4567",
                    title="Issue",
                    severity=Severity.HIGH,
                    description="desc",
                    location="loc",
                    recommendation="rec",
                )
            ]
        )

        mock_singletons["strands_instance"].return_value = _mock_response(
            '{"suggestions": []}', 100, 50
        )

        agent = AlternativesAgent()
        agent.execute(sample_design_data, critique_result=critique)

        call_args = mock_singletons["prompt_manager"].build_agent_prompt.call_args
        context = call_args[0][1]
        assert "constraints" in context
        assert "finding123abc4567" in context["constraints"]

    def test_without_critique_result(self, mock_singletons, sample_design_data):
        mock_singletons["strands_instance"].return_value = _mock_response(
            '{"suggestions": []}', 100, 50
        )

        agent = AlternativesAgent()
        agent.execute(sample_design_data)

        call_args = mock_singletons["prompt_manager"].build_agent_prompt.call_args
        context = call_args[0][1]
        assert context["constraints"] == ""

    def test_malformed_response_raises_error_due_to_validation(
        self, mock_singletons, sample_design_data, malformed_response_text
    ):
        """Test malformed response raises error due to schema validation (security feature)."""
        mock_singletons["strands_instance"].return_value = _mock_response(
            malformed_response_text, 100, 50
        )

        agent = AlternativesAgent()
        # With schema validation enabled, malformed responses now raise BedrockAPIError
        # This is the desired security behavior to catch prompt injection attempts
        with pytest.raises(BedrockAPIError, match="Response schema validation failed"):
            agent.execute(sample_design_data)

    def test_bedrock_error_propagates(self, mock_singletons, sample_design_data):
        mock_singletons["strands_instance"].side_effect = RuntimeError("timeout")

        agent = AlternativesAgent()
        with pytest.raises(BedrockAPIError):
            agent.execute(sample_design_data)

    def test_token_usage_stored_in_result(
        self, mock_singletons, sample_design_data, alternatives_response_text
    ):
        mock_singletons["strands_instance"].return_value = _mock_response(
            alternatives_response_text, 400, 250
        )

        agent = AlternativesAgent()
        result = agent.execute(sample_design_data)

        assert result.token_usage == {"input_tokens": 400, "output_tokens": 250}
