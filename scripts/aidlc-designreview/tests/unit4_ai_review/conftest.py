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
Shared test fixtures for Unit 4: AI Review tests.
"""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.design_reviewer.parsing.models import (
    ApplicationDesignModel,
    DesignData,
    FunctionalDesignModel,
    TechnicalEnvironmentModel,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixtures_dir():
    """Return path to test fixtures directory."""
    return FIXTURES_DIR


@pytest.fixture
def critique_response_json():
    """Load valid critique response fixture."""
    with open(FIXTURES_DIR / "critique_response_valid.json") as f:
        return json.load(f)


@pytest.fixture
def critique_response_text():
    """Load valid critique response as raw text."""
    with open(FIXTURES_DIR / "critique_response_valid.json") as f:
        return f.read()


@pytest.fixture
def alternatives_response_json():
    """Load valid alternatives response fixture."""
    with open(FIXTURES_DIR / "alternatives_response_valid.json") as f:
        return json.load(f)


@pytest.fixture
def alternatives_response_text():
    """Load valid alternatives response as raw text."""
    with open(FIXTURES_DIR / "alternatives_response_valid.json") as f:
        return f.read()


@pytest.fixture
def gap_response_json():
    """Load valid gap response fixture."""
    with open(FIXTURES_DIR / "gap_response_valid.json") as f:
        return json.load(f)


@pytest.fixture
def gap_response_text():
    """Load valid gap response as raw text."""
    with open(FIXTURES_DIR / "gap_response_valid.json") as f:
        return f.read()


@pytest.fixture
def malformed_response_text():
    """Load malformed response fixture."""
    with open(FIXTURES_DIR / "malformed_response.json") as f:
        return f.read()


@pytest.fixture
def sample_design_data():
    """Create a sample DesignData for testing agents."""
    return DesignData(
        app_design=ApplicationDesignModel(
            raw_content="# Application Design\n\nSample application design content.",
            file_paths=[Path("app-design.md")],
            source_count=1,
        ),
        functional_designs=FunctionalDesignModel(
            raw_content="# Functional Design\n\nSample functional design content.",
            file_paths=[Path("func-design.md")],
            unit_names=["unit1"],
            source_count=1,
        ),
        tech_env=TechnicalEnvironmentModel(
            raw_content="# Technical Environment\n\nPython 3.12, AWS Bedrock.",
        ),
        raw_content={Path("test.md"): "raw content"},
    )


@pytest.fixture
def mock_config_manager():
    """Create a mock ConfigManager singleton."""
    mock_config = MagicMock()
    mock_config.get_model_config.return_value = "claude-opus-4-6"
    mock_config.to_bedrock_model_id.return_value = "us.anthropic.claude-opus-4-6-v1"

    mock_aws = MagicMock()
    mock_aws.region = "us-east-1"
    mock_aws.profile_name = "test-profile"
    mock_aws.aws_access_key_id = None
    mock_aws.aws_secret_access_key = None
    mock_aws.guardrail_id = None  # No guardrails in default test config
    mock_aws.guardrail_version = None
    mock_config.get_aws_config.return_value = mock_aws

    mock_review = MagicMock()
    mock_review.enable_alternatives = True
    mock_review.enable_gap_analysis = True
    mock_review.agent_timeout_seconds = 1800
    mock_review.sdk_read_timeout_seconds = 1200
    mock_review.severity_threshold = "medium"
    mock_config.get_review_settings.return_value = mock_review

    # get_config().review for agents that access config directly
    mock_full_config = MagicMock()
    mock_full_config.review = mock_review
    mock_config.get_config.return_value = mock_full_config

    return mock_config


@pytest.fixture
def mock_singletons(mock_config_manager):
    """Patch all Unit 1 singletons for agent testing."""
    mock_prompt_mgr = MagicMock()
    mock_prompt_mgr.build_agent_prompt.return_value = "Test prompt content"

    mock_pattern_lib = MagicMock()
    mock_pattern_lib.format_patterns_for_prompt.return_value = "Pattern content"

    with (
        patch(
            "src.design_reviewer.ai_review.base.ConfigManager.get_instance",
            return_value=mock_config_manager,
        ),
        patch(
            "src.design_reviewer.ai_review.base.PromptManager.get_instance",
            return_value=mock_prompt_mgr,
        ),
        patch(
            "src.design_reviewer.ai_review.critique.PatternLibrary.get_instance",
            return_value=mock_pattern_lib,
        ),
        patch(
            "src.design_reviewer.ai_review.alternatives.PatternLibrary.get_instance",
            return_value=mock_pattern_lib,
        ),
        patch(
            "src.design_reviewer.ai_review.gap.PatternLibrary.get_instance",
            return_value=mock_pattern_lib,
        ),
        patch(
            "src.design_reviewer.ai_review.orchestrator.ConfigManager.get_instance",
            return_value=mock_config_manager,
        ),
        patch("src.design_reviewer.ai_review.base.StrandsAgent") as mock_strands_cls,
        patch(
            "src.design_reviewer.ai_review.base.BedrockModel"
        ) as mock_bedrock_model_cls,
        patch("src.design_reviewer.ai_review.base.boto3.Session") as mock_boto_session,
    ):
        mock_strands_instance = MagicMock()
        mock_strands_cls.return_value = mock_strands_instance

        yield {
            "config_manager": mock_config_manager,
            "prompt_manager": mock_prompt_mgr,
            "pattern_library": mock_pattern_lib,
            "strands_class": mock_strands_cls,
            "strands_instance": mock_strands_instance,
            "bedrock_model_class": mock_bedrock_model_cls,
            "boto_session": mock_boto_session,
        }
