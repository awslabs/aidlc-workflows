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
Unit tests for Pydantic configuration models.

Tests validation, immutability, forward compatibility, and field descriptions
for all configuration models.
"""

import pytest
from pydantic import ValidationError

from design_reviewer.foundation.config_models import (
    AWSConfig,
    ModelConfig,
    ReviewSettings,
    LogConfig,
    ConfigModel,
)


class TestAWSConfig:
    """Test AWSConfig model validation."""

    def test_valid_config_with_profile_name(self):
        """Test valid AWS config with profile_name (only supported authentication method)."""
        config = AWSConfig(
            region="us-east-1",
            profile_name="default",
        )

        assert config.region == "us-east-1"
        assert config.profile_name == "default"

    def test_region_is_required(self):
        """Test region field is required."""
        with pytest.raises(ValidationError) as exc_info:
            AWSConfig(profile_name="default")

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("region",) for error in errors)

    def test_aws_config_is_frozen(self):
        """Test AWSConfig is immutable (frozen=True)."""
        config = AWSConfig(region="us-east-1", profile_name="default")

        with pytest.raises(ValidationError):
            config.region = "us-west-2"

    def test_aws_config_allows_extra_fields(self):
        """Test AWSConfig allows extra fields (forward compatibility)."""
        config = AWSConfig(
            region="us-east-1",
            profile_name="default",
            future_field="future_value",
        )

        assert config.region == "us-east-1"


class TestModelConfig:
    """Test ModelConfig model validation."""

    def test_valid_model_config_with_defaults(self):
        """Test valid model config with default model."""
        config = ModelConfig(default_model="claude-sonnet-4-6")

        assert config.default_model == "claude-sonnet-4-6"
        assert config.critique_model is None
        assert config.alternatives_model is None
        assert config.gap_model is None

    def test_valid_model_config_with_per_agent_models(self):
        """Test valid model config with per-agent model overrides."""
        config = ModelConfig(
            default_model="claude-sonnet-4-6",
            critique_model="claude-opus-4-6",
            alternatives_model="claude-haiku-4-5",
            gap_model="claude-sonnet-4-6",
        )

        assert config.default_model == "claude-sonnet-4-6"
        assert config.critique_model == "claude-opus-4-6"
        assert config.alternatives_model == "claude-haiku-4-5"
        assert config.gap_model == "claude-sonnet-4-6"

    def test_default_model_has_default_value(self):
        """Test default_model has a default value when not provided."""
        config = ModelConfig()

        assert config.default_model == "claude-opus-4-6"

    def test_model_config_is_frozen(self):
        """Test ModelConfig is immutable."""
        config = ModelConfig(default_model="claude-sonnet-4-6")

        with pytest.raises(ValidationError):
            config.default_model = "claude-opus-4-6"

    def test_model_config_allows_extra_fields(self):
        """Test ModelConfig allows extra fields."""
        config = ModelConfig(
            default_model="claude-sonnet-4-6",
            future_agent_model="claude-opus-4-6",
        )

        assert config.default_model == "claude-sonnet-4-6"


class TestReviewSettings:
    """Test ReviewSettings model validation."""

    def test_valid_review_settings_with_defaults(self):
        """Test valid review settings with default values."""
        config = ReviewSettings(
            severity_threshold="medium",
            enable_alternatives=True,
            enable_gap_analysis=True,
        )

        assert config.severity_threshold == "medium"
        assert config.enable_alternatives is True
        assert config.enable_gap_analysis is True

    def test_all_severity_levels_accepted(self):
        """Test all severity levels are accepted."""
        for severity in ["low", "medium", "high"]:
            config = ReviewSettings(
                severity_threshold=severity,
                enable_alternatives=True,
                enable_gap_analysis=True,
            )
            assert config.severity_threshold == severity

    def test_boolean_flags_work_correctly(self):
        """Test boolean enable flags work correctly."""
        config = ReviewSettings(
            severity_threshold="high",
            enable_alternatives=False,
            enable_gap_analysis=False,
        )

        assert config.enable_alternatives is False
        assert config.enable_gap_analysis is False

    def test_review_settings_is_frozen(self):
        """Test ReviewSettings is immutable."""
        config = ReviewSettings(
            severity_threshold="medium",
            enable_alternatives=True,
            enable_gap_analysis=True,
        )

        with pytest.raises(ValidationError):
            config.severity_threshold = "high"

    def test_review_settings_allows_extra_fields(self):
        """Test ReviewSettings allows extra fields."""
        config = ReviewSettings(
            severity_threshold="medium",
            enable_alternatives=True,
            enable_gap_analysis=True,
            enable_future_analysis=True,
        )

        assert config.severity_threshold == "medium"


class TestLogConfig:
    """Test LogConfig model validation."""

    def test_valid_log_config_with_all_fields(self):
        """Test valid log config with all fields."""
        config = LogConfig(
            log_file_path="/var/log/design-reviewer.log",
            log_level="INFO",
            max_log_size_mb=10,
            backup_count=5,
        )

        assert config.log_file_path == "/var/log/design-reviewer.log"
        assert config.log_level == "INFO"
        assert config.max_log_size_mb == 10
        assert config.backup_count == 5

    def test_valid_log_levels_accepted(self):
        """Test all valid log levels are accepted."""
        for level in ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]:
            config = LogConfig(
                log_file_path="/tmp/test.log",
                log_level=level,
            )
            assert config.log_level == level

    def test_all_fields_have_defaults(self):
        """Test all LogConfig fields have defaults."""
        config = LogConfig()

        assert config.log_file_path is not None
        assert config.log_level is not None
        assert config.max_log_size_mb is not None
        assert config.backup_count is not None

    def test_log_config_is_frozen(self):
        """Test LogConfig is immutable."""
        config = LogConfig(
            log_file_path="/tmp/test.log",
            log_level="INFO",
        )

        with pytest.raises(ValidationError):
            config.log_level = "DEBUG"

    def test_log_config_allows_extra_fields(self):
        """Test LogConfig allows extra fields."""
        config = LogConfig(
            log_file_path="/tmp/test.log",
            log_level="INFO",
            future_setting="value",
        )

        assert config.log_file_path == "/tmp/test.log"


class TestConfigModel:
    """Test root ConfigModel validation."""

    def test_valid_config_model_with_all_sections(self):
        """Test valid complete configuration."""
        config = ConfigModel(
            aws=AWSConfig(
                region="us-east-1",
                profile_name="default",
            ),
            models=ModelConfig(
                default_model="claude-sonnet-4-6",
            ),
            review=ReviewSettings(
                severity_threshold="medium",
                enable_alternatives=True,
                enable_gap_analysis=True,
            ),
            logging=LogConfig(
                log_file_path="/tmp/test.log",
                log_level="INFO",
            ),
        )

        assert config.aws.region == "us-east-1"
        assert config.models.default_model == "claude-sonnet-4-6"
        assert config.review.severity_threshold == "medium"
        assert config.logging.log_level == "INFO"

    def test_aws_section_is_required(self):
        """Test aws section is required."""
        with pytest.raises(ValidationError) as exc_info:
            ConfigModel(
                models=ModelConfig(default_model="claude-sonnet-4-6"),
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("aws",) for error in errors)

    def test_models_section_is_required(self):
        """Test models section is required."""
        with pytest.raises(ValidationError) as exc_info:
            ConfigModel(
                aws=AWSConfig(region="us-east-1", profile_name="default"),
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("models",) for error in errors)

    def test_review_and_logging_optional(self):
        """Test review and logging sections are optional (have defaults)."""
        config = ConfigModel(
            aws=AWSConfig(region="us-east-1", profile_name="default"),
            models=ModelConfig(default_model="claude-sonnet-4-6"),
        )

        assert config.aws is not None
        assert config.models is not None
        assert config.review is not None
        assert config.logging is not None

    def test_config_model_is_frozen(self):
        """Test ConfigModel is immutable."""
        config = ConfigModel(
            aws=AWSConfig(region="us-east-1", profile_name="default"),
            models=ModelConfig(default_model="claude-sonnet-4-6"),
        )

        with pytest.raises(ValidationError):
            config.aws = AWSConfig(region="us-west-2", profile_name="default")

    def test_config_model_allows_extra_fields(self):
        """Test ConfigModel allows extra fields for forward compatibility."""
        config = ConfigModel(
            aws=AWSConfig(region="us-east-1", profile_name="default"),
            models=ModelConfig(default_model="claude-sonnet-4-6"),
            future_section={"key": "value"},
        )

        assert config.aws.region == "us-east-1"

    def test_nested_validation_propagates(self):
        """Test validation errors in nested models propagate correctly."""
        with pytest.raises(ValidationError) as exc_info:
            ConfigModel(
                aws="not_a_config",
                models=ModelConfig(default_model="claude-sonnet-4-6"),
            )

        errors = exc_info.value.errors()
        assert len(errors) > 0


class TestFieldDescriptions:
    """Test all models include Field descriptions for self-documentation."""

    def test_aws_config_has_field_descriptions(self):
        """Test AWSConfig fields have descriptions."""
        schema = AWSConfig.model_json_schema()
        properties = schema.get("properties", {})

        assert "description" in properties.get("region", {})
        assert "description" in properties.get("profile_name", {})

    def test_model_config_has_field_descriptions(self):
        """Test ModelConfig fields have descriptions."""
        schema = ModelConfig.model_json_schema()
        properties = schema.get("properties", {})

        assert "description" in properties.get("default_model", {})

    def test_review_settings_has_field_descriptions(self):
        """Test ReviewSettings fields have descriptions."""
        schema = ReviewSettings.model_json_schema()
        properties = schema.get("properties", {})

        assert "description" in properties.get("severity_threshold", {})

    def test_log_config_has_field_descriptions(self):
        """Test LogConfig fields have descriptions."""
        schema = LogConfig.model_json_schema()
        properties = schema.get("properties", {})

        assert "description" in properties.get("log_file_path", {})
        assert "description" in properties.get("log_level", {})
