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


"""Tests for BaseAgent ABC."""

from unittest.mock import MagicMock

import pytest

from src.design_reviewer.ai_review.base import BaseAgent
from src.design_reviewer.foundation.exceptions import BedrockAPIError


class ConcreteAgent(BaseAgent):
    """Concrete implementation of BaseAgent for testing."""

    def execute(self, design_data, **kwargs):
        return {"test": True}


class TestBaseAgentConstruction:
    def test_creates_with_config(self, mock_singletons):
        agent = ConcreteAgent("critique")
        assert agent.agent_name == "critique"
        assert agent.model_id == "us.anthropic.claude-opus-4-6-v1"

    def test_creates_strands_agent_with_bedrock_model(self, mock_singletons):
        ConcreteAgent("critique")

        # With profile_name set, boto_session is created and region goes to session
        mock_singletons["boto_session"].assert_called_once_with(
            profile_name="test-profile", region_name="us-east-1"
        )

        # BedrockModel gets model_id, max_tokens, and the boto_session (no region_name)
        mock_singletons["bedrock_model_class"].assert_called_once()
        bedrock_kwargs = mock_singletons["bedrock_model_class"].call_args[1]
        assert bedrock_kwargs["model_id"] == "us.anthropic.claude-opus-4-6-v1"
        assert (
            bedrock_kwargs["boto_session"]
            == mock_singletons["boto_session"].return_value
        )
        assert "region_name" not in bedrock_kwargs

        # Verify StrandsAgent received the BedrockModel instance
        mock_singletons["strands_class"].assert_called_once()
        strands_kwargs = mock_singletons["strands_class"].call_args[1]
        assert (
            strands_kwargs["model"]
            == mock_singletons["bedrock_model_class"].return_value
        )


class TestBuildPrompt:
    def test_delegates_to_prompt_manager(self, mock_singletons):
        agent = ConcreteAgent("critique")
        result = agent._build_prompt({"app_design": "content"})
        mock_singletons["prompt_manager"].build_agent_prompt.assert_called_once_with(
            "critique", {"app_design": "content"}
        )
        assert result == "Test prompt content"


class TestInvokeModel:
    def test_returns_text_and_usage(self, mock_singletons):
        mock_response = MagicMock()
        mock_response.__str__ = lambda self: "Response text"
        mock_response.metrics.accumulated_usage = {
            "inputTokens": 100,
            "outputTokens": 50,
            "totalTokens": 150,
        }
        mock_singletons["strands_instance"].return_value = mock_response

        agent = ConcreteAgent("critique")
        text, usage = agent._invoke_model("test prompt")

        assert text == "Response text"
        assert usage["input_tokens"] == 100
        assert usage["output_tokens"] == 50

    def test_raises_bedrock_api_error_on_failure(self, mock_singletons):
        mock_singletons["strands_instance"].side_effect = RuntimeError("API failed")

        agent = ConcreteAgent("critique")
        with pytest.raises(BedrockAPIError, match="API failed"):
            agent._invoke_model("test prompt")


class TestExtractTokenUsage:
    def test_from_metrics_accumulated_usage_dict(self, mock_singletons):
        """Primary path: Strands SDK returns accumulated_usage as a dict."""
        agent = ConcreteAgent("critique")
        response = MagicMock()
        response.metrics.accumulated_usage = {
            "inputTokens": 200,
            "outputTokens": 100,
            "totalTokens": 300,
        }

        result = agent._extract_token_usage(response)
        assert result == {"input_tokens": 200, "output_tokens": 100}

    def test_from_metrics_accumulated_usage_object(self, mock_singletons):
        """Fallback: accumulated_usage as a dataclass with attributes."""
        agent = ConcreteAgent("critique")
        response = MagicMock()
        usage_obj = MagicMock()
        usage_obj.inputTokens = 200
        usage_obj.outputTokens = 100
        response.metrics.accumulated_usage = usage_obj

        result = agent._extract_token_usage(response)
        assert result == {"input_tokens": 200, "output_tokens": 100}

    def test_from_usage_dict_fallback(self, mock_singletons):
        """Fallback: response.usage dict."""
        agent = ConcreteAgent("critique")
        response = MagicMock(spec=["usage"])
        response.usage = {"inputTokens": 200, "outputTokens": 100}

        result = agent._extract_token_usage(response)
        assert result == {"input_tokens": 200, "output_tokens": 100}

    def test_fallback_zeros(self, mock_singletons):
        agent = ConcreteAgent("critique")
        response = MagicMock(spec=[])

        result = agent._extract_token_usage(response)
        assert result == {"input_tokens": 0, "output_tokens": 0}

    def test_usage_not_dict_falls_through(self, mock_singletons):
        agent = ConcreteAgent("critique")
        response = MagicMock(spec=["usage"])
        response.usage = "not a dict"

        result = agent._extract_token_usage(response)
        assert result == {"input_tokens": 0, "output_tokens": 0}

    def test_metrics_dict_with_zero_usage_falls_through(self, mock_singletons):
        """If metrics accumulated_usage has zeros, fall through to next check."""
        agent = ConcreteAgent("critique")
        response = MagicMock(spec=["metrics", "usage"])
        response.metrics.accumulated_usage = {
            "inputTokens": 0,
            "outputTokens": 0,
        }
        response.usage = {"inputTokens": 150, "outputTokens": 75}

        result = agent._extract_token_usage(response)
        assert result == {"input_tokens": 150, "output_tokens": 75}


class TestValidateResponseSchema:
    """Test response schema validation."""

    def test_valid_response_with_all_keys(self, mock_singletons):
        """Test valid JSON response with all required keys."""
        agent = ConcreteAgent("critique")
        response_text = '{"findings": [], "extra_key": "ignored"}'
        expected_keys = {"findings"}

        result = agent._validate_response_schema(response_text, expected_keys)
        assert result is True

    def test_missing_required_keys(self, mock_singletons):
        """Test response missing required keys."""
        agent = ConcreteAgent("critique")
        response_text = '{"extra_key": "value"}'
        expected_keys = {"findings"}

        result = agent._validate_response_schema(response_text, expected_keys)
        assert result is False

    def test_invalid_json(self, mock_singletons):
        """Test invalid JSON response."""
        agent = ConcreteAgent("critique")
        response_text = "Not valid JSON at all"
        expected_keys = {"findings"}

        result = agent._validate_response_schema(response_text, expected_keys)
        assert result is False

    def test_response_not_object(self, mock_singletons):
        """Test response that's valid JSON but not an object."""
        agent = ConcreteAgent("critique")
        response_text = '["array", "not", "object"]'
        expected_keys = {"findings"}

        result = agent._validate_response_schema(response_text, expected_keys)
        assert result is False

    def test_multiple_required_keys(self, mock_singletons):
        """Test validation with multiple required keys."""
        agent = ConcreteAgent("critique")
        response_text = '{"suggestions": [], "recommendation": "text"}'
        expected_keys = {"suggestions", "recommendation"}

        result = agent._validate_response_schema(response_text, expected_keys)
        assert result is True

    def test_partial_keys_missing(self, mock_singletons):
        """Test when some but not all required keys are present."""
        agent = ConcreteAgent("critique")
        response_text = '{"suggestions": []}'
        expected_keys = {"suggestions", "recommendation"}

        result = agent._validate_response_schema(response_text, expected_keys)
        assert result is False


class TestInvokeModelWithValidation:
    """Test _invoke_model with schema validation enabled."""

    def test_validation_disabled_by_default(self, mock_singletons):
        """Test validation is skipped when _expected_response_keys is None."""
        mock_response = MagicMock()
        mock_response.__str__ = lambda self: '{"unexpected": "format"}'
        mock_response.metrics.accumulated_usage = {
            "inputTokens": 100,
            "outputTokens": 50,
        }
        mock_singletons["strands_instance"].return_value = mock_response

        agent = ConcreteAgent("critique")
        # ConcreteAgent doesn't set _expected_response_keys, so validation is off
        text, usage = agent._invoke_model("test prompt")

        assert text == '{"unexpected": "format"}'
        assert usage["input_tokens"] == 100

    def test_validation_enabled_with_valid_response(self, mock_singletons):
        """Test validation passes when response has expected keys."""
        mock_response = MagicMock()
        mock_response.__str__ = lambda self: '{"findings": []}'
        mock_response.metrics.accumulated_usage = {
            "inputTokens": 100,
            "outputTokens": 50,
        }
        mock_singletons["strands_instance"].return_value = mock_response

        # Create agent with validation enabled
        class ValidatingAgent(BaseAgent):
            _expected_response_keys = {"findings"}

            def execute(self, design_data, **kwargs):
                return {"test": True}

        agent = ValidatingAgent("critique")
        text, usage = agent._invoke_model("test prompt")

        assert text == '{"findings": []}'
        assert usage["input_tokens"] == 100

    def test_validation_enabled_with_invalid_response(self, mock_singletons):
        """Test validation raises error when response missing keys."""
        mock_response = MagicMock()
        mock_response.__str__ = lambda self: '{"wrong_key": "value"}'
        mock_response.metrics.accumulated_usage = {
            "inputTokens": 100,
            "outputTokens": 50,
        }
        mock_singletons["strands_instance"].return_value = mock_response

        # Create agent with validation enabled
        class ValidatingAgent(BaseAgent):
            _expected_response_keys = {"findings"}

            def execute(self, design_data, **kwargs):
                return {"test": True}

        agent = ValidatingAgent("critique")
        with pytest.raises(
            BedrockAPIError, match="Response schema validation failed"
        ):
            agent._invoke_model("test prompt")

    def test_validation_logs_security_warning(self, caplog, mock_singletons):
        """Test validation failure logs security-relevant error."""
        mock_response = MagicMock()
        mock_response.__str__ = lambda self: "Not JSON"
        mock_response.metrics.accumulated_usage = {
            "inputTokens": 100,
            "outputTokens": 50,
        }
        mock_singletons["strands_instance"].return_value = mock_response

        # Create agent with validation enabled
        class ValidatingAgent(BaseAgent):
            _expected_response_keys = {"findings"}

            def execute(self, design_data, **kwargs):
                return {"test": True}

        agent = ValidatingAgent("critique")
        with pytest.raises(BedrockAPIError), caplog.at_level("ERROR"):
            agent._invoke_model("test prompt")

        assert "Response schema validation failed" in caplog.text
        assert "prompt injection" in caplog.text
