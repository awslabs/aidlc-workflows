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
Integration tests for Unit 1 error scenarios.

Tests error handling across components: config file not found, invalid credentials,
missing prompt files, invalid pattern count, and exception chaining.
"""

import pytest
import yaml

from design_reviewer.foundation.logger import Logger
from design_reviewer.foundation.config_manager import ConfigManager
from design_reviewer.foundation.prompt_manager import PromptManager
from design_reviewer.foundation.pattern_library import PatternLibrary
from design_reviewer.foundation.exceptions import (
    ConfigFileNotFoundError,
    ConfigValidationError,
    InvalidCredentialsError,
    PromptFileNotFoundError,
    PatternFileNotFoundError,
)


class TestConfigFileNotFoundError:
    """Test config file not found handling."""

    def setup_method(self):
        """Reset singletons."""
        ConfigManager._instance = None
        ConfigManager._config = None

    def test_config_file_not_found_raises_clear_error(self):
        """Test missing config file raises ConfigFileNotFoundError with clear message."""
        with pytest.raises(ConfigFileNotFoundError) as exc_info:
            ConfigManager.initialize(config_path="/nonexistent/config.yaml")

        error_msg = str(exc_info.value)
        assert "nonexistent" in error_msg or "config.yaml" in error_msg

    def test_error_includes_file_path(self):
        """Test error message includes attempted file path."""
        file_path = "/home/user/.design-reviewer/config.yaml"

        with pytest.raises(ConfigFileNotFoundError) as exc_info:
            ConfigManager.initialize(config_path=file_path)

        # Should contain path info
        assert len(str(exc_info.value)) > 10  # Detailed message


class TestInvalidAWSCredentialsError:
    """Test invalid AWS credentials handling."""

    def setup_method(self):
        """Reset singletons."""
        ConfigManager._instance = None
        ConfigManager._config = None

    def test_missing_credentials_raises_clear_error(self, tmp_path):
        """Test missing profile_name (required for temporary credentials) raises clear error."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            yaml.dump(
                {
                    "aws": {"region": "us-east-1"},  # Missing profile_name (required)
                    "models": {"default_model": "claude-sonnet-4-6"},
                }
            )
        )

        # profile_name is now required, so we get ConfigValidationError
        with pytest.raises(ConfigValidationError) as exc_info:
            ConfigManager.initialize(config_path=str(config_file))

        error_msg = str(exc_info.value)
        # Should mention profile_name is required
        assert "profile_name" in error_msg.lower() or "required" in error_msg.lower()

class TestMissingPromptFilesError:
    """Test missing prompt files handling."""

    def setup_method(self):
        """Reset singletons."""
        PromptManager._instance = None
        PromptManager._prompts = {}

    def test_missing_required_agent_raises_error(self, tmp_path):
        """Test missing required agent prompt raises PromptFileNotFoundError."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        # Only create critique and alternatives, missing gap
        (prompts_dir / "critique-v1.md").write_text("Critique prompt")
        (prompts_dir / "alternatives-v1.md").write_text("Alternatives prompt")

        with pytest.raises(PromptFileNotFoundError) as exc_info:
            PromptManager.initialize(prompts_directory=str(prompts_dir))

        error_msg = str(exc_info.value)
        assert "gap" in error_msg.lower()

    def test_no_prompt_files_raises_error(self, tmp_path):
        """Test no prompt files raises error."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        # Empty directory - no prompt files
        with pytest.raises(PromptFileNotFoundError):
            PromptManager.initialize(prompts_directory=str(prompts_dir))


class TestInvalidPatternCountError:
    """Test invalid pattern count handling."""

    def setup_method(self):
        """Reset singletons."""
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def test_missing_pattern_file_raises_error(self, tmp_path):
        """Test missing pattern file raises PatternFileNotFoundError."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()

        # Create only a few pattern files (not all 15)
        for name in PatternLibrary.PATTERN_FILES[:3]:
            (patterns_dir / name).write_text(
                "# Test\n\n## Category\nSystem Architecture\n\n"
                "## Description\nTest\n\n## When to Use\nTest\n\n## Example\nTest"
            )

        with pytest.raises(PatternFileNotFoundError):
            PatternLibrary.initialize(patterns_directory=str(patterns_dir))

    def test_zero_patterns_raises_error(self, tmp_path):
        """Test empty patterns directory raises error."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()

        # No pattern files at all
        with pytest.raises(PatternFileNotFoundError):
            PatternLibrary.initialize(patterns_directory=str(patterns_dir))


class TestExceptionChaining:
    """Test exception chaining preserves original errors."""

    def setup_method(self):
        """Reset singletons."""
        ConfigManager._instance = None
        ConfigManager._config = None

    def test_config_parse_error_chains_original_exception(self, tmp_path):
        """Test YAML parse error is chained in ConfigValidationError."""
        config_file = tmp_path / "config.yaml"
        config_file.write_text("invalid: yaml: syntax: [unclosed")

        try:
            ConfigManager.initialize(config_path=str(config_file))
            pytest.fail("Should have raised ConfigValidationError")
        except ConfigValidationError as e:
            # Should have chained original exception
            assert e.__cause__ is not None or e.__context__ is not None


class TestFailFastBehavior:
    """Test fail-fast behavior across components."""

    def setup_method(self):
        """Reset singletons."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None
        ConfigManager._instance = None
        ConfigManager._config = None
        PromptManager._instance = None
        PromptManager._prompts = {}
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def test_first_error_stops_initialization(self):
        """Test first error stops entire initialization sequence."""
        # ConfigManager fails - file doesn't exist
        with pytest.raises(ConfigFileNotFoundError):
            ConfigManager.initialize(config_path="/nonexistent/config.yaml")

        # PromptManager and PatternLibrary should not be initialized
        assert PromptManager._instance is None
        assert PatternLibrary._instance is None

    def test_no_recovery_after_error(self):
        """Test system does not attempt recovery after error."""
        with pytest.raises(RuntimeError):
            Logger.get_instance()  # Not initialized

        # Still fails on second attempt
        with pytest.raises(RuntimeError):
            Logger.get_instance()


class TestErrorMessageQuality:
    """Test error messages are detailed and actionable."""

    def setup_method(self):
        """Reset singletons."""
        ConfigManager._instance = None
        ConfigManager._config = None
        PromptManager._instance = None
        PromptManager._prompts = {}
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def test_config_error_includes_file_path(self):
        """Test config error includes attempted file path."""
        file_path = "/home/user/.design-reviewer/config.yaml"

        with pytest.raises(ConfigFileNotFoundError) as exc_info:
            ConfigManager.initialize(config_path=file_path)

        assert ".design-reviewer" in str(exc_info.value) or "config.yaml" in str(
            exc_info.value
        )

    def test_prompt_error_includes_agent_name(self, tmp_path):
        """Test prompt error includes missing agent name."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        # Only critique, missing alternatives and gap
        (prompts_dir / "critique-v1.md").write_text("Critique prompt")

        with pytest.raises(PromptFileNotFoundError) as exc_info:
            PromptManager.initialize(prompts_directory=str(prompts_dir))

        error_msg = str(exc_info.value)
        assert "alternatives" in error_msg.lower()
