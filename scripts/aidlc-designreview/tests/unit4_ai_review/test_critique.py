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


"""Tests for CritiqueAgent."""

import json
from unittest.mock import MagicMock

import pytest

from src.design_reviewer.ai_review.critique import CritiqueAgent
from src.design_reviewer.ai_review.models import AgentStatus, CritiqueResult, Severity
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


class TestCritiqueAgentExecute:
    def test_valid_response_produces_findings(
        self, mock_singletons, sample_design_data, critique_response_text
    ):
        mock_singletons["strands_instance"].return_value = _mock_response(
            critique_response_text, 500, 300
        )

        agent = CritiqueAgent()
        result = agent.execute(sample_design_data)

        assert isinstance(result, CritiqueResult)
        assert result.status == AgentStatus.COMPLETED
        assert len(result.findings) == 3
        assert result.findings[0].title == "Missing Error Handling in Data Pipeline"
        assert result.findings[0].severity == Severity.HIGH
        assert result.findings[2].severity == Severity.CRITICAL

    def test_malformed_response_raises_error_due_to_validation(
        self, mock_singletons, sample_design_data, malformed_response_text
    ):
        """Test malformed response raises error due to schema validation (security feature)."""
        mock_singletons["strands_instance"].return_value = _mock_response(
            malformed_response_text, 100, 50
        )

        agent = CritiqueAgent()
        # With schema validation enabled, malformed responses now raise BedrockAPIError
        # This is the desired security behavior to catch prompt injection attempts
        with pytest.raises(BedrockAPIError, match="Response schema validation failed"):
            agent.execute(sample_design_data)

    def test_context_markers_populated(self, mock_singletons, sample_design_data):
        mock_singletons["strands_instance"].return_value = _mock_response(
            '{"findings": []}', 50, 20
        )

        agent = CritiqueAgent()
        agent.execute(sample_design_data)

        call_args = mock_singletons["prompt_manager"].build_agent_prompt.call_args
        assert call_args[0][0] == "critique"
        context = call_args[0][1]
        assert "design_document" in context
        assert "patterns" in context
        assert "severity_threshold" in context

    def test_bedrock_api_error_propagates(self, mock_singletons, sample_design_data):
        mock_singletons["strands_instance"].side_effect = RuntimeError(
            "Service unavailable"
        )

        agent = CritiqueAgent()
        with pytest.raises(BedrockAPIError):
            agent.execute(sample_design_data)

    def test_invalid_severity_skipped(self, mock_singletons, sample_design_data):
        raw = json.dumps(
            {
                "findings": [
                    {
                        "title": "Good",
                        "severity": "high",
                        "description": "d",
                        "location": "l",
                        "recommendation": "r",
                    },
                    {
                        "title": "Bad",
                        "severity": "invalid_sev",
                        "description": "d",
                        "location": "l",
                        "recommendation": "r",
                    },
                ]
            }
        )
        mock_singletons["strands_instance"].return_value = _mock_response(raw, 50, 20)

        agent = CritiqueAgent()
        result = agent.execute(sample_design_data)

        assert len(result.findings) == 1
        assert result.findings[0].title == "Good"

    def test_token_usage_stored_in_result(
        self, mock_singletons, sample_design_data, critique_response_text
    ):
        mock_singletons["strands_instance"].return_value = _mock_response(
            critique_response_text, 500, 300
        )

        agent = CritiqueAgent()
        result = agent.execute(sample_design_data)

        assert result.token_usage == {"input_tokens": 500, "output_tokens": 300}
