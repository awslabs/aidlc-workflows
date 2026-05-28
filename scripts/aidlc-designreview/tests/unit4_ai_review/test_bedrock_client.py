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


"""Tests for bedrock_client factory module."""

from unittest.mock import MagicMock, patch

import pytest

from src.design_reviewer.ai_review.bedrock_client import create_bedrock_client


@pytest.fixture
def mock_config_for_bedrock():
    """Mock ConfigManager for bedrock client tests."""
    mock_config = MagicMock()

    mock_aws = MagicMock()
    mock_aws.region = "us-west-2"
    mock_aws.profile_name = "default"
    mock_config.get_aws_config.return_value = mock_aws

    mock_review = MagicMock()
    mock_review.sdk_read_timeout_seconds = 1200
    mock_config.get_review_settings.return_value = mock_review

    return mock_config


class TestCreateBedrockClientWithProfile:
    def test_profile_creates_session_client(self, mock_config_for_bedrock):
        mock_config_for_bedrock.get_aws_config.return_value.profile_name = "my-profile"

        with (
            patch(
                "src.design_reviewer.ai_review.bedrock_client.ConfigManager.get_instance",
                return_value=mock_config_for_bedrock,
            ),
            patch("src.design_reviewer.ai_review.bedrock_client.boto3") as mock_boto3,
        ):
            mock_session = MagicMock()
            mock_boto3.Session.return_value = mock_session

            create_bedrock_client()

            mock_boto3.Session.assert_called_once_with(profile_name="my-profile")
            mock_session.client.assert_called_once()
            call_args = mock_session.client.call_args
            assert call_args[0][0] == "bedrock-runtime"
            assert call_args[1]["region_name"] == "us-west-2"


class TestCreateBedrockClientWithProfileAuth:
    def test_profile_authentication_only(self, mock_config_for_bedrock):
        """Test that bedrock client only uses profile-based authentication."""
        with (
            patch(
                "src.design_reviewer.ai_review.bedrock_client.ConfigManager.get_instance",
                return_value=mock_config_for_bedrock,
            ),
            patch("src.design_reviewer.ai_review.bedrock_client.boto3") as mock_boto3,
        ):
            mock_session = MagicMock()
            mock_boto3.Session.return_value = mock_session

            create_bedrock_client()

            # Verify Session is created with profile_name
            mock_boto3.Session.assert_called_once_with(profile_name="default")

            # Verify client is created from session
            mock_session.client.assert_called_once()
            call_args = mock_session.client.call_args
            assert call_args[0][0] == "bedrock-runtime"
            assert call_args[1]["region_name"] == "us-west-2"


class TestCreateBedrockClientTimeoutConfig:
    def test_timeout_from_config(self, mock_config_for_bedrock):
        """Test that timeout configuration is properly applied."""
        mock_config_for_bedrock.get_review_settings.return_value.sdk_read_timeout_seconds = 600

        with (
            patch(
                "src.design_reviewer.ai_review.bedrock_client.ConfigManager.get_instance",
                return_value=mock_config_for_bedrock,
            ),
            patch("src.design_reviewer.ai_review.bedrock_client.boto3") as mock_boto3,
        ):
            mock_session = MagicMock()
            mock_boto3.Session.return_value = mock_session

            create_bedrock_client()

            # Verify Session is created
            mock_boto3.Session.assert_called_once_with(profile_name="default")

            # Verify client is created with config
            mock_session.client.assert_called_once()
            call_kwargs = mock_session.client.call_args[1]
            config = call_kwargs["config"]
            assert config.read_timeout == 600
            assert config.connect_timeout == 30

    def test_retries_disabled(self, mock_config_for_bedrock):
        """Test that SDK retries are disabled (handled by backoff library)."""
        with (
            patch(
                "src.design_reviewer.ai_review.bedrock_client.ConfigManager.get_instance",
                return_value=mock_config_for_bedrock,
            ),
            patch("src.design_reviewer.ai_review.bedrock_client.boto3") as mock_boto3,
        ):
            mock_session = MagicMock()
            mock_boto3.Session.return_value = mock_session

            create_bedrock_client()

            # Verify Session is created
            mock_boto3.Session.assert_called_once_with(profile_name="default")

            # Verify client is created with retries disabled
            mock_session.client.assert_called_once()
            call_kwargs = mock_session.client.call_args[1]
            config = call_kwargs["config"]
            assert config.retries == {"max_attempts": 0}
