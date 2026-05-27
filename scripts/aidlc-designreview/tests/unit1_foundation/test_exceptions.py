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
Unit tests for foundation exception hierarchy.

Tests all exception types, messages, context, and exception chaining.
"""

from design_reviewer.foundation.exceptions import (
    DesignReviewerError,
    ConfigurationError,
    ConfigFileNotFoundError,
    ConfigValidationError,
    InvalidCredentialsError,
    PromptLoadError,
    PromptFileNotFoundError,
    PromptParseError,
    PatternLoadError,
    PatternFileNotFoundError,
    InvalidPatternCountError,
)


class TestBaseException:
    """Test the base DesignReviewerError exception."""

    def test_base_exception_message(self):
        """Test base exception includes message."""
        error = DesignReviewerError("Test error message")
        assert str(error) == "Test error message"
        assert isinstance(error, Exception)

    def test_base_exception_with_cause(self):
        """Test exception chaining preserves original error."""
        original = ValueError("Original error")
        chained = DesignReviewerError("Wrapped error")

        try:
            raise chained from original
        except DesignReviewerError as e:
            assert e.__cause__ is original
            assert str(e.__cause__) == "Original error"


class TestConfigurationExceptions:
    """Test configuration-related exceptions."""

    def test_config_file_not_found_error_message(self):
        """Test ConfigFileNotFoundError includes helpful message."""
        file_path = "/home/user/.design-reviewer/config.yaml"
        error = ConfigFileNotFoundError(file_path)

        error_msg = str(error)
        assert file_path in error_msg
        assert "not found" in error_msg.lower()
        assert "create" in error_msg.lower() or "example" in error_msg.lower()

    def test_config_file_not_found_is_configuration_error(self):
        """Test ConfigFileNotFoundError inherits from ConfigurationError."""
        error = ConfigFileNotFoundError("/path/to/config.yaml")
        assert isinstance(error, ConfigurationError)
        assert isinstance(error, DesignReviewerError)

    def test_config_validation_error_with_details(self):
        """Test ConfigValidationError includes validation details."""
        error = ConfigValidationError(
            "Field 'aws.region' is required", field="aws.region"
        )

        error_msg = str(error)
        assert "aws.region" in error_msg
        assert "validation" in error_msg.lower() or "field" in error_msg.lower()

    def test_config_validation_error_suggests_fix(self):
        """Test ConfigValidationError includes suggested fix."""
        error = ConfigValidationError("Invalid value for field 'model'")
        error_msg = str(error)

        assert (
            "check" in error_msg.lower()
            or "fix" in error_msg.lower()
            or "correct" in error_msg.lower()
        )

    def test_invalid_credentials_error_message(self):
        """Test InvalidCredentialsError provides clear guidance."""
        error = InvalidCredentialsError("AWS credentials not configured")
        error_msg = str(error)

        assert "credentials" in error_msg.lower()
        assert "aws" in error_msg.lower()
        assert "profile" in error_msg.lower() or "access" in error_msg.lower()

    def test_configuration_error_chaining(self):
        """Test configuration errors chain from original exceptions."""
        original = ValueError("Invalid YAML syntax")
        chained = ConfigValidationError("Failed to parse config")

        try:
            raise chained from original
        except ConfigValidationError as e:
            assert e.__cause__ is original


class TestPromptLoadExceptions:
    """Test prompt loading exceptions."""

    def test_prompt_file_not_found_error_message(self):
        """Test PromptFileNotFoundError includes agent name and path."""
        file_path = "/config/prompts/critique-v1.md"
        error = PromptFileNotFoundError(file_path, "critique")

        error_msg = str(error)
        assert "critique" in error_msg
        assert file_path in error_msg
        assert "not found" in error_msg.lower()

    def test_prompt_file_not_found_is_prompt_load_error(self):
        """Test PromptFileNotFoundError inherits from PromptLoadError."""
        error = PromptFileNotFoundError("/path/to/gap-v1.md", "gap")
        assert isinstance(error, PromptLoadError)
        assert isinstance(error, DesignReviewerError)

    def test_prompt_parse_error_with_details(self):
        """Test PromptParseError includes parsing details."""
        file_path = "/config/prompts/alternatives-v1.md"
        parse_error = "Invalid YAML frontmatter"
        error = PromptParseError(file_path, parse_error)

        error_msg = str(error)
        assert file_path in error_msg
        assert parse_error in error_msg
        assert "parse" in error_msg.lower()

    def test_prompt_parse_error_suggests_fix(self):
        """Test PromptParseError suggests how to fix."""
        error = PromptParseError("/prompts/test.md", "YAML parse error")
        error_msg = str(error)

        assert "yaml" in error_msg.lower() or "format" in error_msg.lower()

    def test_prompt_load_error_chaining(self):
        """Test prompt errors chain from file system exceptions."""
        original = FileNotFoundError("File does not exist")
        chained = PromptFileNotFoundError("/prompts/critique-v1.md", "critique")

        try:
            raise chained from original
        except PromptFileNotFoundError as e:
            assert e.__cause__ is original


class TestPatternLoadExceptions:
    """Test pattern loading exceptions."""

    def test_pattern_file_not_found_error_message(self):
        """Test PatternFileNotFoundError includes pattern name and path."""
        file_path = "/config/patterns/circuit-breaker.md"
        error = PatternFileNotFoundError(file_path, "circuit-breaker")

        error_msg = str(error)
        assert "circuit-breaker" in error_msg
        assert file_path in error_msg
        assert "not found" in error_msg.lower()

    def test_pattern_file_not_found_is_pattern_load_error(self):
        """Test PatternFileNotFoundError inherits from PatternLoadError."""
        error = PatternFileNotFoundError("/patterns/retry.md", "retry")
        assert isinstance(error, PatternLoadError)
        assert isinstance(error, DesignReviewerError)

    def test_invalid_pattern_count_error_with_expected_actual(self):
        """Test InvalidPatternCountError includes expected vs actual count."""
        error = InvalidPatternCountError(actual_count=12, expected_count=15)

        error_msg = str(error)
        assert "15" in error_msg
        assert "12" in error_msg
        assert "expected" in error_msg.lower()

    def test_invalid_pattern_count_suggests_fix(self):
        """Test InvalidPatternCountError suggests checking pattern directory."""
        error = InvalidPatternCountError(actual_count=10, expected_count=15)
        error_msg = str(error)

        assert "pattern" in error_msg.lower()
        assert "missing" in error_msg.lower() or "directory" in error_msg.lower()

    def test_pattern_load_error_chaining(self):
        """Test pattern errors chain from parsing exceptions."""
        original = UnicodeDecodeError("utf-8", b"", 0, 1, "invalid start byte")
        chained = PatternFileNotFoundError("/patterns/caching.md", "caching")

        try:
            raise chained from original
        except PatternFileNotFoundError as e:
            assert e.__cause__ is original


class TestExceptionHierarchy:
    """Test exception inheritance and hierarchy."""

    def test_all_exceptions_inherit_from_base(self):
        """Test all custom exceptions inherit from DesignReviewerError."""
        exceptions = [
            ConfigurationError("test"),
            ConfigFileNotFoundError("/path"),
            ConfigValidationError("test"),
            InvalidCredentialsError("test"),
            PromptLoadError("test"),
            PromptFileNotFoundError("/path", "agent"),
            PromptParseError("/path", "error"),
            PatternLoadError("test"),
            PatternFileNotFoundError("/path", "pattern"),
            InvalidPatternCountError(actual_count=10, expected_count=15),
        ]

        for exc in exceptions:
            assert isinstance(exc, DesignReviewerError)
            assert isinstance(exc, Exception)

    def test_exception_categories(self):
        """Test exception categorization by type."""
        config_exceptions = [
            ConfigFileNotFoundError("/path"),
            ConfigValidationError("error"),
            InvalidCredentialsError("error"),
        ]
        for exc in config_exceptions:
            assert isinstance(exc, ConfigurationError)

        prompt_exceptions = [
            PromptFileNotFoundError("/path", "agent"),
            PromptParseError("/path", "error"),
        ]
        for exc in prompt_exceptions:
            assert isinstance(exc, PromptLoadError)

        pattern_exceptions = [
            PatternFileNotFoundError("/path", "pattern"),
            InvalidPatternCountError(actual_count=10, expected_count=15),
        ]
        for exc in pattern_exceptions:
            assert isinstance(exc, PatternLoadError)


class TestExceptionContext:
    """Test exception context and debugging information."""

    def test_exceptions_provide_actionable_context(self):
        """Test all exceptions include actionable information."""
        test_cases = [
            (
                ConfigFileNotFoundError("/config.yaml"),
                ["config.yaml", "copy", "example"],
            ),
            (ConfigValidationError("Invalid field", field="test"), ["field"]),
            (InvalidCredentialsError("No credentials"), ["credentials", "aws"]),
            (
                PromptFileNotFoundError("/prompts/critique.md", "critique"),
                ["critique", "prompt"],
            ),
            (PromptParseError("/prompt.md", "YAML error"), ["yaml", "parse"]),
            (
                PatternFileNotFoundError("/patterns/retry.md", "retry"),
                ["retry", "pattern"],
            ),
            (
                InvalidPatternCountError(actual_count=12, expected_count=15),
                ["15", "12", "expected"],
            ),
        ]

        for exception, required_keywords in test_cases:
            error_msg = str(exception).lower()
            for keyword in required_keywords:
                assert keyword.lower() in error_msg, (
                    f"{exception.__class__.__name__} should include '{keyword}' in message"
                )

    def test_exception_chaining_preserves_context(self):
        """Test exception chaining preserves full error context."""
        try:
            try:
                raise FileNotFoundError("config.yaml not found")
            except FileNotFoundError as e:
                raise ConfigFileNotFoundError("/home/user/config.yaml") from e
        except ConfigFileNotFoundError as e:
            assert e.__cause__ is not None
            assert isinstance(e.__cause__, FileNotFoundError)
            assert "config.yaml" in str(e.__cause__)
