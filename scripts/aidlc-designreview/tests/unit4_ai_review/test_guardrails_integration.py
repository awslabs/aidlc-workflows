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


"""Tests for Bedrock Guardrails integration in BaseAgent."""

from unittest.mock import MagicMock, patch

import pytest

from src.design_reviewer.ai_review.base import BaseAgent


class ConcreteAgent(BaseAgent):
    """Concrete implementation of BaseAgent for testing."""

    def execute(self, design_data, **kwargs):
        return {"test": True}


class TestGuardrailsIntegration:
    """Test that Bedrock Guardrails are properly wired from config to BedrockModel."""

    def test_guardrails_disabled_by_default(self, mock_singletons):
        """When guardrail_id is None, no guardrail config is passed to BedrockModel."""
        # Default mock has guardrail_id = None
        ConcreteAgent("critique")

        bedrock_kwargs = mock_singletons["bedrock_model_class"].call_args[1]
        assert "guardrail_id" not in bedrock_kwargs
        assert "guardrail_version" not in bedrock_kwargs

    def test_guardrails_enabled_when_configured(self, mock_config_manager):
        """When guardrail_id is set in config, it's passed to BedrockModel."""
        # Configure guardrails in mock config
        mock_aws = mock_config_manager.get_aws_config.return_value
        mock_aws.guardrail_id = "test-guardrail-id"
        mock_aws.guardrail_version = "1"

        mock_prompt_mgr = MagicMock()
        mock_prompt_mgr.build_agent_prompt.return_value = "Test prompt"

        with (
            patch(
                "src.design_reviewer.ai_review.base.ConfigManager.get_instance",
                return_value=mock_config_manager,
            ),
            patch(
                "src.design_reviewer.ai_review.base.PromptManager.get_instance",
                return_value=mock_prompt_mgr,
            ),
            patch("src.design_reviewer.ai_review.base.StrandsAgent") as mock_strands_cls,
            patch(
                "src.design_reviewer.ai_review.base.BedrockModel"
            ) as mock_bedrock_model_cls,
            patch(
                "src.design_reviewer.ai_review.base.boto3.Session"
            ) as mock_boto_session,
        ):
            ConcreteAgent("critique")

            # Verify guardrail parameters passed to BedrockModel
            bedrock_kwargs = mock_bedrock_model_cls.call_args[1]
            assert bedrock_kwargs["guardrail_id"] == "test-guardrail-id"
            assert bedrock_kwargs["guardrail_version"] == "1"
            assert bedrock_kwargs["model_id"] == "us.anthropic.claude-opus-4-6-v1"
            assert bedrock_kwargs["boto_session"] == mock_boto_session.return_value

    def test_guardrails_default_to_draft_version(self, mock_config_manager):
        """When guardrail_version is None, defaults to 'DRAFT'."""
        # Configure guardrails with no version
        mock_aws = mock_config_manager.get_aws_config.return_value
        mock_aws.guardrail_id = "test-guardrail-id"
        mock_aws.guardrail_version = None  # No version specified

        mock_prompt_mgr = MagicMock()
        mock_prompt_mgr.build_agent_prompt.return_value = "Test prompt"

        with (
            patch(
                "src.design_reviewer.ai_review.base.ConfigManager.get_instance",
                return_value=mock_config_manager,
            ),
            patch(
                "src.design_reviewer.ai_review.base.PromptManager.get_instance",
                return_value=mock_prompt_mgr,
            ),
            patch("src.design_reviewer.ai_review.base.StrandsAgent") as mock_strands_cls,
            patch(
                "src.design_reviewer.ai_review.base.BedrockModel"
            ) as mock_bedrock_model_cls,
            patch(
                "src.design_reviewer.ai_review.base.boto3.Session"
            ) as mock_boto_session,
        ):
            ConcreteAgent("critique")

            # Verify guardrail_version defaults to "DRAFT"
            bedrock_kwargs = mock_bedrock_model_cls.call_args[1]
            assert bedrock_kwargs["guardrail_id"] == "test-guardrail-id"
            assert bedrock_kwargs["guardrail_version"] == "DRAFT"

    def test_guardrails_enabled_log_message(self, caplog, mock_config_manager):
        """When guardrails enabled, info log message is emitted."""
        mock_aws = mock_config_manager.get_aws_config.return_value
        mock_aws.guardrail_id = "test-guardrail-123"
        mock_aws.guardrail_version = "2"

        mock_prompt_mgr = MagicMock()
        mock_prompt_mgr.build_agent_prompt.return_value = "Test prompt"

        with (
            patch(
                "src.design_reviewer.ai_review.base.ConfigManager.get_instance",
                return_value=mock_config_manager,
            ),
            patch(
                "src.design_reviewer.ai_review.base.PromptManager.get_instance",
                return_value=mock_prompt_mgr,
            ),
            patch("src.design_reviewer.ai_review.base.StrandsAgent"),
            patch("src.design_reviewer.ai_review.base.BedrockModel"),
            patch("src.design_reviewer.ai_review.base.boto3.Session"),
            caplog.at_level("INFO"),
        ):
            ConcreteAgent("critique")

            # Verify info log contains guardrail details
            assert "Bedrock Guardrails ENABLED" in caplog.text
            assert "test-guardrail-123" in caplog.text
            assert "version 2" in caplog.text
            assert "critique" in caplog.text

    def test_guardrails_disabled_warning_log(self, caplog, mock_config_manager):
        """When guardrails disabled, warning log message is emitted."""
        # Default mock has guardrail_id = None
        mock_prompt_mgr = MagicMock()
        mock_prompt_mgr.build_agent_prompt.return_value = "Test prompt"

        with (
            patch(
                "src.design_reviewer.ai_review.base.ConfigManager.get_instance",
                return_value=mock_config_manager,
            ),
            patch(
                "src.design_reviewer.ai_review.base.PromptManager.get_instance",
                return_value=mock_prompt_mgr,
            ),
            patch("src.design_reviewer.ai_review.base.StrandsAgent"),
            patch("src.design_reviewer.ai_review.base.BedrockModel"),
            patch("src.design_reviewer.ai_review.base.boto3.Session"),
            caplog.at_level("WARNING"),
        ):
            ConcreteAgent("critique")

            # Verify warning log contains recommendation
            assert "Bedrock Guardrails NOT configured" in caplog.text
            assert "STRONGLY RECOMMENDED" in caplog.text
            assert "docs/ai-security/BEDROCK_GUARDRAILS.md" in caplog.text
            assert "critique" in caplog.text
