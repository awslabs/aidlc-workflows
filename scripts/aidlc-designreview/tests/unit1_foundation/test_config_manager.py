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
Unit tests for ConfigManager singleton.

Tests singleton pattern, config loading, merging, validation,
business rules, and config access methods.
"""

import pytest
import yaml
from unittest.mock import Mock

from design_reviewer.foundation.config_manager import ConfigManager
from design_reviewer.foundation.exceptions import (
    ConfigFileNotFoundError,
    ConfigValidationError,
    InvalidCredentialsError,
)


class TestConfigManagerSingleton:
    """Test ConfigManager singleton pattern."""

    def setup_method(self):
        """Reset singleton before each test."""
        ConfigManager._instance = None
        ConfigManager._config = None

    def test_get_instance_fails_before_initialization(self):
        """Test get_instance() raises error if not initialized."""
        with pytest.raises(RuntimeError) as exc_info:
            ConfigManager.get_instance()

        assert "not initialized" in str(exc_info.value).lower()

    def test_initialize_creates_singleton(self, tmp_path):
        """Test initialize() creates singleton instance."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1", "profile_name": "default"},
                    "models": {"default_model": "claude-sonnet-4-6"},
                }
            )
        )

        cm = ConfigManager.initialize(config_path=str(config_file))

        assert ConfigManager._instance is not None
        assert cm is ConfigManager._instance

    def test_initialize_twice_raises_error(self, tmp_path):
        """Test calling initialize() twice raises RuntimeError."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1", "profile_name": "default"},
                    "models": {"default_model": "claude-sonnet-4-6"},
                }
            )
        )

        ConfigManager.initialize(config_path=str(config_file))

        with pytest.raises(RuntimeError, match="already initialized"):
            ConfigManager.initialize(config_path=str(config_file))


class TestConfigLoading:
    """Test configuration loading from YAML files."""

    def setup_method(self):
        """Reset singleton before each test."""
        ConfigManager._instance = None
        ConfigManager._config = None

    def test_loads_user_config_file(self, tmp_path):
        """Test loading user configuration file."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-west-2", "profile_name": "myprofile"},
                    "models": {"default_model": "claude-opus-4-6"},
                }
            )
        )

        cm = ConfigManager.initialize(config_path=str(config_file))

        assert cm.get_aws_config().region == "us-west-2"
        assert cm.get_aws_config().profile_name == "myprofile"

    def test_handles_missing_user_config_file(self):
        """Test handling when user config file doesn't exist."""
        with pytest.raises(ConfigFileNotFoundError):
            ConfigManager.initialize(config_path="/nonexistent/config.yaml")

    def test_handles_invalid_yaml_syntax(self, tmp_path):
        """Test handling of invalid YAML syntax."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text("invalid: yaml: syntax: [unclosed")

        with pytest.raises(ConfigValidationError):
            ConfigManager.initialize(config_path=str(config_file))

    def test_config_merging_with_defaults(self, tmp_path):
        """Test user config merges with default config."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1", "profile_name": "default"},
                    "models": {"default_model": "claude-sonnet-4-6"},
                }
            )
        )

        cm = ConfigManager.initialize(config_path=str(config_file))

        assert cm.get_review_settings() is not None
        assert cm.get_log_config() is not None


class TestPydanticValidation:
    """Test Pydantic schema validation."""

    def setup_method(self):
        """Reset singleton before each test."""
        ConfigManager._instance = None
        ConfigManager._config = None

    def test_validates_required_fields(self, tmp_path):
        """Test Pydantic validates required fields."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1", "profile_name": "default"},
                    # Missing 'models' section
                }
            )
        )

        with pytest.raises(ConfigValidationError):
            ConfigManager.initialize(config_path=str(config_file))


class TestBusinessRulesValidation:
    """Test business rules validation (post-validation pattern)."""

    def setup_method(self):
        """Reset singleton before each test."""
        ConfigManager._instance = None
        ConfigManager._config = None

    def test_br_c1_requires_profile_name(self, tmp_path):
        """Test BR-C1: profile_name is required (no long-term credentials supported)."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1"},
                    "models": {"default_model": "claude-sonnet-4-6"},
                }
            )
        )

        with pytest.raises(ConfigValidationError):
            ConfigManager.initialize(config_path=str(config_file))

    def test_br_c1_accepts_profile_name(self, tmp_path):
        """Test BR-C1: profile_name is valid and required."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1", "profile_name": "default"},
                    "models": {"default_model": "claude-sonnet-4-6"},
                }
            )
        )

        cm = ConfigManager.initialize(config_path=str(config_file))
        assert cm.get_aws_config().profile_name == "default"

    def test_br_c4_validates_model_name_in_known_models(self, tmp_path):
        """Test BR-C4: model name must be in KNOWN_MODELS list."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1", "profile_name": "default"},
                    "models": {"default_model": "unknown-model-xyz"},
                }
            )
        )

        with pytest.raises(ConfigValidationError) as exc_info:
            ConfigManager.initialize(config_path=str(config_file))

        assert "model" in str(exc_info.value).lower()

    def test_br_c4_accepts_valid_model_names(self, tmp_path):
        """Test BR-C4: known model names are accepted."""
        for model in ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]:
            ConfigManager._instance = None
            ConfigManager._config = None

            config_file = tmp_path / "config.yaml"
            config_file.write_text(
                yaml.dump(
                    {
                        "aws": {"region": "us-east-1", "profile_name": "default"},
                        "models": {"default_model": model},
                    }
                )
            )

            cm = ConfigManager.initialize(config_path=str(config_file))
            # get_model_config returns a string (model name) not ModelConfig
            assert cm.get_model_config() == model

    def test_br_c5_validates_severity_threshold(self, tmp_path):
        """Test BR-C5: severity_threshold must be low/medium/high/critical."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1", "profile_name": "default"},
                    "models": {"default_model": "claude-sonnet-4-6"},
                    "review": {
                        "severity_threshold": "invalid",
                        "enable_alternatives": True,
                        "enable_gap_analysis": True,
                    },
                }
            )
        )

        with pytest.raises(ConfigValidationError):
            ConfigManager.initialize(config_path=str(config_file))

    def test_br_c6_validates_log_level(self, tmp_path):
        """Test BR-C6: log_level must be DEBUG/INFO/WARNING/ERROR/CRITICAL."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1", "profile_name": "default"},
                    "models": {"default_model": "claude-sonnet-4-6"},
                    "logging": {
                        "log_file_path": "/tmp/test.log",
                        "log_level": "INVALID",
                    },
                }
            )
        )

        with pytest.raises(ConfigValidationError):
            ConfigManager.initialize(config_path=str(config_file))


class TestConfigAccessMethods:
    """Test configuration access methods."""

    def setup_method(self):
        """Reset singleton and initialize with test config."""
        ConfigManager._instance = None
        ConfigManager._config = None

        self.test_config_dict = {
            "aws": {"region": "us-east-1", "profile_name": "test-profile"},
            "models": {
                "default_model": "claude-sonnet-4-6",
                "critique_model": "claude-opus-4-6",
            },
            "review": {
                "severity_threshold": "high",
                "enable_alternatives": False,
                "enable_gap_analysis": True,
            },
            "logging": {
                "log_file_path": "/var/log/test.log",
                "log_level": "DEBUG",
            },
        }

    def test_get_config_returns_complete_config(self, tmp_path):
        """Test get_config() returns complete ConfigModel."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(yaml.dump(self.test_config_dict))

        cm = ConfigManager.initialize(config_path=str(config_file))
        config = cm.get_config()

        assert config.aws.region == "us-east-1"
        assert config.models.default_model == "claude-sonnet-4-6"
        assert config.review.severity_threshold == "high"
        assert config.logging.log_level == "DEBUG"

    def test_get_aws_config_returns_aws_section(self, tmp_path):
        """Test get_aws_config() returns AWS configuration."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(yaml.dump(self.test_config_dict))

        cm = ConfigManager.initialize(config_path=str(config_file))
        aws_config = cm.get_aws_config()

        assert aws_config.region == "us-east-1"
        assert aws_config.profile_name == "test-profile"

    def test_get_model_config_returns_default_model(self, tmp_path):
        """Test get_model_config() returns default model name."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(yaml.dump(self.test_config_dict))

        cm = ConfigManager.initialize(config_path=str(config_file))
        model_name = cm.get_model_config()

        assert model_name == "claude-sonnet-4-6"

    def test_get_model_config_returns_agent_override(self, tmp_path):
        """Test get_model_config() returns agent-specific override."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(yaml.dump(self.test_config_dict))

        cm = ConfigManager.initialize(config_path=str(config_file))
        model_name = cm.get_model_config(agent_name="critique")

        assert model_name == "claude-opus-4-6"

    def test_get_review_settings_returns_review_section(self, tmp_path):
        """Test get_review_settings() returns review settings."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(yaml.dump(self.test_config_dict))

        cm = ConfigManager.initialize(config_path=str(config_file))
        review_settings = cm.get_review_settings()

        assert review_settings.severity_threshold == "high"
        assert review_settings.enable_alternatives is False
        assert review_settings.enable_gap_analysis is True

    def test_get_log_config_returns_logging_section(self, tmp_path):
        """Test get_log_config() returns logging configuration."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(yaml.dump(self.test_config_dict))

        cm = ConfigManager.initialize(config_path=str(config_file))
        log_config = cm.get_log_config()

        assert log_config.log_file_path == "/var/log/test.log"
        assert log_config.log_level == "DEBUG"


class TestConfigurationSummaryLogging:
    """Test configuration summary logging."""

    def setup_method(self):
        """Reset singleton before each test."""
        ConfigManager._instance = None
        ConfigManager._config = None

    def test_log_config_summary(self, tmp_path):
        """Test log_config_summary() logs configuration details."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1", "profile_name": "default"},
                    "models": {"default_model": "claude-sonnet-4-6"},
                }
            )
        )

        cm = ConfigManager.initialize(config_path=str(config_file))

        mock_logger = Mock()
        cm.log_config_summary(mock_logger)

        mock_logger.info.assert_called()
        log_calls = [str(call) for call in mock_logger.info.call_args_list]
        assert any("config" in str(call).lower() for call in log_calls)
