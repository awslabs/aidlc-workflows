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
Configuration manager singleton for Design Reviewer.

Loads, validates, and provides immutable access to application configuration.
"""

from pathlib import Path
from typing import Optional

import yaml
from pydantic import ValidationError

from .config_models import AWSConfig, ConfigModel, LogConfig, ReviewSettings
from .exceptions import (
    ConfigFileNotFoundError,
    ConfigValidationError,
    InvalidCredentialsError,
)


class ConfigManager:
    """
    Singleton configuration manager.

    Loads configuration from config.yaml, merges with defaults, validates,
    and provides immutable access to configuration.
    """

    _instance: Optional["ConfigManager"] = None
    _config: Optional[ConfigModel] = None

    # Known valid models
    KNOWN_MODELS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]

    # Mapping from short names to full Amazon Bedrock model IDs (cross-region inference)
    BEDROCK_MODEL_IDS = {
        "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1",
        "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6",
        "claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    }

    @classmethod
    def to_bedrock_model_id(cls, short_name: str) -> str:
        """Map a short model name to the full Amazon Bedrock model ID."""
        return cls.BEDROCK_MODEL_IDS.get(short_name, short_name)

    @classmethod
    def initialize(cls, config_path: str = "config.yaml") -> "ConfigManager":
        """
        Initialize singleton configuration manager.

        Args:
            config_path: Path to configuration file

        Returns:
            ConfigManager singleton instance

        Raises:
            ConfigFileNotFoundError: If config file not found
            ConfigValidationError: If configuration validation fails
            InvalidCredentialsError: If AWS credentials invalid
            RuntimeError: If already initialized
        """
        if cls._instance is not None:
            raise RuntimeError(
                "ConfigManager already initialized. Call get_instance() to access existing instance."
            )

        instance = cls()
        instance._config = instance._load_and_validate(config_path)
        cls._instance = instance

        return instance

    @classmethod
    def get_instance(cls) -> "ConfigManager":
        """
        Get singleton configuration manager instance.

        Returns:
            ConfigManager singleton instance

        Raises:
            RuntimeError: If not initialized
        """
        if cls._instance is None:
            raise RuntimeError(
                "ConfigManager not initialized. Call ConfigManager.initialize(config_path) first."
            )
        return cls._instance

    @classmethod
    def reset(cls) -> None:
        """Reset singleton for testing. NOT for production use."""
        cls._instance = None
        cls._config = None

    def _load_and_validate(self, config_path: str) -> ConfigModel:
        """
        Load and validate configuration.

        Args:
            config_path: Path to configuration file

        Returns:
            Validated ConfigModel

        Raises:
            ConfigFileNotFoundError: If config file not found
            ConfigValidationError: If validation fails
            InvalidCredentialsError: If credentials invalid
        """
        # 1. Load user config
        user_config_path = Path(config_path).expanduser()
        if not user_config_path.exists():
            raise ConfigFileNotFoundError(str(user_config_path))

        try:
            with open(user_config_path, "r", encoding="utf-8") as f:
                user_config_dict = yaml.safe_load(f)
        except yaml.YAMLError as e:
            raise ConfigValidationError(f"Invalid YAML: {e}") from e
        except Exception as e:
            raise ConfigValidationError(f"Failed to read config file: {e}") from e

        # 2. Load default config (bundled with app)
        # For now, create default dict (in full implementation, would load from default-config.yaml)
        default_config_dict = {
            "review": {
                "severity_threshold": "medium",
                "enable_alternatives": True,
                "enable_gap_analysis": True,
            },
            "logging": {
                "log_file_path": "logs/design-reviewer.log",
                "log_level": "INFO",
                "max_log_size_mb": 10,
                "backup_count": 5,
            },
        }

        # 3. Merge configs (user overrides defaults)
        merged_config_dict = {**default_config_dict, **user_config_dict}

        # 4. Validate with Pydantic
        try:
            config = ConfigModel(**merged_config_dict)
        except ValidationError as e:
            raise ConfigValidationError(str(e)) from e

        # 5. Validate business rules (post-validation pattern)
        self._validate_business_rules(config)

        return config

    def _validate_business_rules(self, config: ConfigModel) -> None:
        """
        Validate business rules after Pydantic validation.

        Args:
            config: ConfigModel to validate

        Raises:
            ConfigValidationError: If business rule validation fails
            InvalidCredentialsError: If AWS credentials invalid
        """
        # BR-C1: profile_name is now required (validated by Pydantic)
        # SECURITY: Long-term credentials removed - only IAM roles/profiles/STS supported

        # BR-C4: Model name must be in known models list
        if config.models.default_model not in self.KNOWN_MODELS:
            raise ConfigValidationError(
                f"Unknown default model: {config.models.default_model}. "
                f"Known models: {', '.join(self.KNOWN_MODELS)}",
                field="models.default_model",
            )

        # Validate per-agent model overrides
        for agent, model in [
            ("critique", config.models.critique_model),
            ("alternatives", config.models.alternatives_model),
            ("gap", config.models.gap_model),
        ]:
            if model is not None and model not in self.KNOWN_MODELS:
                raise ConfigValidationError(
                    f"Unknown {agent} model: {model}. "
                    f"Known models: {', '.join(self.KNOWN_MODELS)}",
                    field=f"models.{agent}_model",
                )

        # BR-C5: Severity threshold must be valid
        valid_severities = ["critical", "high", "medium", "low"]
        if config.review.severity_threshold not in valid_severities:
            raise ConfigValidationError(
                f"Invalid severity threshold: {config.review.severity_threshold}. "
                f"Valid values: {', '.join(valid_severities)}",
                field="review.severity_threshold",
            )

        # BR-C6: Log level must be valid
        valid_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        if config.logging.log_level.upper() not in valid_levels:
            raise ConfigValidationError(
                f"Invalid log level: {config.logging.log_level}. "
                f"Valid values: {', '.join(valid_levels)}",
                field="logging.log_level",
            )

    def get_config(self) -> ConfigModel:
        """
        Get complete configuration.

        Returns:
            Immutable ConfigModel
        """
        if self._config is None:
            raise RuntimeError("Configuration not loaded")
        return self._config

    def get_aws_config(self) -> AWSConfig:
        """
        Get AWS configuration.

        Returns:
            Immutable AWSConfig
        """
        return self.get_config().aws

    def get_model_config(self, agent_name: Optional[str] = None) -> str:
        """
        Get model configuration for specific agent or default.

        Args:
            agent_name: Agent name (critique, alternatives, gap) or None for default

        Returns:
            Model name to use
        """
        models = self.get_config().models

        if agent_name == "critique" and models.critique_model:
            return models.critique_model
        elif agent_name == "alternatives" and models.alternatives_model:
            return models.alternatives_model
        elif agent_name == "gap" and models.gap_model:
            return models.gap_model
        else:
            return models.default_model

    def get_review_settings(self) -> ReviewSettings:
        """
        Get review settings.

        Returns:
            Immutable ReviewSettings
        """
        return self.get_config().review

    def get_log_config(self) -> LogConfig:
        """
        Get logging configuration.

        Returns:
            Immutable LogConfig
        """
        return self.get_config().logging

    def log_config_summary(self, logger) -> None:
        """
        Log configuration summary.

        Args:
            logger: Logger instance to use
        """
        config = self.get_config()
        logger.info("Configuration loaded successfully")
        logger.info(f"AWS Region: {config.aws.region}")
        logger.info(f"AWS Profile: {config.aws.profile_name or 'explicit credentials'}")
        logger.info(f"Default Model: {config.models.default_model}")
        logger.info(f"Severity Threshold: {config.review.severity_threshold}")
        logger.info(f"Alternatives Enabled: {config.review.enable_alternatives}")
        logger.info(f"Gap Analysis Enabled: {config.review.enable_gap_analysis}")
        logger.info(f"Log Level: {config.logging.log_level}")
