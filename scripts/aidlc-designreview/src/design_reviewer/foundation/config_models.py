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
Pydantic configuration models for Design Reviewer.

All models are frozen (immutable) and self-documenting with Field descriptions.
"""

from typing import Optional

from pydantic import BaseModel, Field


class AWSConfig(BaseModel):
    """
    AWS configuration for Amazon Bedrock access.

    SECURITY: Only temporary credentials via IAM roles, profiles, or STS are supported.
    Long-term credentials (aws_access_key_id/aws_secret_access_key) are NOT supported
    to follow security recommendations.
    """

    model_config = {"frozen": True, "extra": "allow"}

    region: str = Field(..., description="AWS region (e.g., us-east-1)")
    profile_name: str = Field(
        ...,
        description="AWS profile name from ~/.aws/credentials or ~/.aws/config. "
        "Profile must use IAM roles, SSO, or temporary credentials. "
        "Long-term access keys are not supported for security reasons.",
    )

    # Amazon Bedrock Guardrails configuration (optional)
    guardrail_id: Optional[str] = Field(
        None,
        description="Amazon Bedrock Guardrail ID for content filtering and safety controls. "
        "See docs/ai-security/BEDROCK_GUARDRAILS.md for setup instructions.",
    )
    guardrail_version: Optional[str] = Field(
        None,
        description="Amazon Bedrock Guardrail version (e.g., '1', '2', or 'DRAFT'). "
        "Required if guardrail_id is specified.",
    )


class ModelConfig(BaseModel):
    """Model configuration for AI agents."""

    model_config = {"frozen": True, "extra": "allow"}

    default_model: str = Field(
        "claude-opus-4-6",
        description="Default model for all agents (claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5)",
    )
    critique_model: Optional[str] = Field(
        None, description="Model for critique agent (overrides default_model)"
    )
    alternatives_model: Optional[str] = Field(
        None, description="Model for alternatives agent (overrides default_model)"
    )
    gap_model: Optional[str] = Field(
        None, description="Model for gap analysis agent (overrides default_model)"
    )


class ReviewSettings(BaseModel):
    """Review configuration settings."""

    model_config = {"frozen": True, "extra": "allow"}

    severity_threshold: str = Field(
        "medium", description="Minimum severity to report (critical, high, medium, low)"
    )
    enable_alternatives: bool = Field(True, description="Enable alternatives analysis")
    enable_gap_analysis: bool = Field(True, description="Enable gap analysis")


class LogConfig(BaseModel):
    """Logging configuration."""

    model_config = {"frozen": True, "extra": "allow"}

    log_file_path: str = Field(
        "logs/design-reviewer.log", description="Path to log file"
    )
    log_level: str = Field(
        "INFO", description="Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)"
    )
    max_log_size_mb: int = Field(
        10, description="Maximum log file size in MB before rotation"
    )
    backup_count: int = Field(5, description="Number of backup log files to keep")


class ConfigModel(BaseModel):
    """Root configuration model."""

    model_config = {"frozen": True, "extra": "allow"}

    aws: AWSConfig = Field(..., description="AWS configuration")
    models: ModelConfig = Field(..., description="Model configuration")
    review: ReviewSettings = Field(
        default_factory=ReviewSettings, description="Review settings"
    )
    logging: LogConfig = Field(
        default_factory=LogConfig, description="Logging configuration"
    )
