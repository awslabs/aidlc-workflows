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
Custom exception hierarchy for Design Reviewer.

All exceptions include detailed context and suggested fixes for fail-fast error handling.
"""

from typing import Any, Dict, Optional


class DesignReviewerError(Exception):
    """Base exception for all Design Reviewer errors."""

    def __init__(
        self,
        message: str,
        suggested_fix: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ):
        """
        Initialize exception with message, optional suggested fix, and optional context.

        Args:
            message: Error message describing what went wrong
            suggested_fix: Optional suggestion for how to fix the error
            context: Optional dict of additional error context (file_path, section, etc.)
        """
        self.message = message
        self.suggested_fix = suggested_fix
        self.context = context or {}

        full_message = message
        if suggested_fix:
            full_message = f"{message}\n\nSuggested Fix:\n{suggested_fix}"

        super().__init__(full_message)


# Configuration Errors


class ConfigurationError(DesignReviewerError):
    """Base exception for configuration-related errors."""

    pass


class ConfigFileNotFoundError(ConfigurationError):
    """Raised when configuration file is not found."""

    def __init__(self, config_path: str):
        message = f"Configuration file not found: {config_path}"
        suggested_fix = (
            "1. Copy example config: cp config/example-config.yaml config.yaml\n"
            "2. Edit config.yaml with your AWS credentials and preferences"
        )
        super().__init__(message, suggested_fix)
        self.config_path = config_path


class ConfigValidationError(ConfigurationError):
    """Raised when configuration validation fails."""

    def __init__(self, message: str, field: Optional[str] = None):
        suggested_fix = (
            "1. Check config.yaml syntax and structure\n"
            "2. Verify all required fields are present (aws, models)\n"
            "3. See config/example-config.yaml for valid configuration format"
        )
        if field:
            message = f"Configuration validation failed for field '{field}': {message}"
        super().__init__(message, suggested_fix)
        self.field = field


class InvalidCredentialsError(ConfigurationError):
    """Raised when AWS credentials are invalid or missing."""

    def __init__(self, message: str):
        suggested_fix = (
            "1. Provide either profile_name OR explicit credentials (access_key_id + secret_access_key)\n"
            "2. Check AWS credentials file: ~/.aws/credentials\n"
            "3. Verify credentials are valid and have Amazon Bedrock permissions"
        )
        super().__init__(message, suggested_fix)


# Prompt Loading Errors


class PromptLoadError(DesignReviewerError):
    """Base exception for prompt loading errors."""

    pass


class PromptFileNotFoundError(PromptLoadError):
    """Raised when required prompt file is not found."""

    def __init__(self, prompt_path: str, agent_name: str):
        message = f"Required prompt file not found: {prompt_path}"
        suggested_fix = (
            f"1. Verify prompt file exists for agent '{agent_name}'\n"
            f"2. Check prompts directory configuration\n"
            f"3. Expected format: {{agent}}-v{{N}}.md (e.g., critique-v1.md)"
        )
        super().__init__(message, suggested_fix)
        self.prompt_path = prompt_path
        self.agent_name = agent_name


class PromptParseError(PromptLoadError):
    """Raised when prompt file parsing fails."""

    def __init__(self, prompt_path: str, error: str):
        message = f"Failed to parse prompt file: {prompt_path}\nError: {error}"
        suggested_fix = (
            "1. Verify prompt file is valid UTF-8 text\n"
            "2. Check YAML frontmatter syntax (if present)\n"
            "3. Verify file is not corrupted"
        )
        super().__init__(message, suggested_fix)
        self.prompt_path = prompt_path
        self.error = error


# Pattern Loading Errors


class PatternLoadError(DesignReviewerError):
    """Base exception for pattern library errors."""

    pass


class PatternFileNotFoundError(PatternLoadError):
    """Raised when required pattern file is not found."""

    def __init__(self, pattern_path: str, pattern_name: str):
        message = f"Required pattern file not found: {pattern_path}"
        suggested_fix = (
            f"1. Verify pattern file '{pattern_name}.md' exists\n"
            f"2. Check patterns directory configuration\n"
            f"3. Pattern library requires all 15 core patterns"
        )
        super().__init__(message, suggested_fix)
        self.pattern_path = pattern_path
        self.pattern_name = pattern_name


class InvalidPatternCountError(PatternLoadError):
    """Raised when pattern library doesn't have exactly 15 patterns."""

    def __init__(self, actual_count: int, expected_count: int = 15):
        message = (
            f"Invalid pattern count: expected {expected_count}, found {actual_count}"
        )
        suggested_fix = (
            "1. Verify all 15 pattern files are present in patterns directory\n"
            "2. Check for missing or duplicate pattern files\n"
            "3. See config/patterns/ for required pattern list"
        )
        super().__init__(message, suggested_fix)
        self.actual_count = actual_count
        self.expected_count = expected_count


# Validation Errors (for Unit 2)


class ValidationError(DesignReviewerError):
    """Base exception for validation errors."""

    pass


class StructureValidationError(ValidationError):
    """Raised when AIDLC project structure validation fails."""

    pass


class MissingArtifactError(ValidationError):
    """Raised when required artifact is missing."""

    pass


# Parsing Errors (for Unit 3)


class ParsingError(DesignReviewerError):
    """Base exception for artifact parsing errors."""

    pass


class ArtifactParseError(ParsingError):
    """Raised when artifact parsing fails."""

    pass


class UnsupportedFormatError(ParsingError):
    """Raised when artifact format is not supported."""

    pass


# AI Review Errors (for Unit 4)


class AIReviewError(DesignReviewerError):
    """Base exception for AI review errors."""

    pass


class BedrockAPIError(AIReviewError):
    """Raised when Amazon Bedrock API call fails."""

    pass


class AgentExecutionError(AIReviewError):
    """Raised when AI agent execution fails."""

    pass


class ResponseParseError(AIReviewError):
    """Raised when AI agent response parsing fails."""

    pass
