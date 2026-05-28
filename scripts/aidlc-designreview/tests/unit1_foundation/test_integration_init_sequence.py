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
Integration tests for Unit 1 initialization sequence.

Tests complete initialization sequence for Logger, ConfigManager,
PromptManager, and PatternLibrary.
"""

import pytest
from unittest.mock import Mock, patch
import yaml

from design_reviewer.foundation.logger import Logger
from design_reviewer.foundation.config_manager import ConfigManager
from design_reviewer.foundation.prompt_manager import PromptManager
from design_reviewer.foundation.pattern_library import PatternLibrary
from design_reviewer.foundation.exceptions import (
    ConfigFileNotFoundError,
    PromptFileNotFoundError,
    PatternFileNotFoundError,
)


def _create_config_file(tmp_path):
    """Create a valid config file for testing."""
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        yaml.dump(
            {
                "aws": {"region": "us-east-1", "profile_name": "default"},
                "models": {"default_model": "claude-sonnet-4-6"},
            }
        )
    )
    return config_file


def _create_prompt_files(tmp_path):
    """Create valid prompt files for testing."""
    prompts_dir = tmp_path / "prompts"
    prompts_dir.mkdir()

    prompt_template = """---
agent: {agent}
version: 1
---
You are the {agent} agent. <!-- INSERT: patterns -->"""

    for agent in ["critique", "alternatives", "gap"]:
        (prompts_dir / f"{agent}-v1.md").write_text(prompt_template.format(agent=agent))

    return prompts_dir


def _create_pattern_files(tmp_path):
    """Create valid pattern files for testing."""
    patterns_dir = tmp_path / "patterns"
    patterns_dir.mkdir()

    pattern_template = """# {name}

## Category
{category}

## Description
A test pattern for {name}.

## When to Use
Use when testing {name}.

## Example
Example usage of {name}.
"""

    categories = {
        "layered-architecture": ("Layered Architecture", "System Architecture"),
        "microservices": ("Microservices", "System Architecture"),
        "event-driven": ("Event-Driven Architecture", "System Architecture"),
        "repository": ("Repository", "Data Management"),
        "cqrs": ("CQRS", "Data Management"),
        "event-sourcing": ("Event Sourcing", "Data Management"),
        "api-gateway": ("API Gateway", "Communication"),
        "message-broker": ("Message Broker", "Communication"),
        "rpc": ("RPC", "Communication"),
        "load-balancer": ("Load Balancer", "Scalability"),
        "caching": ("Caching", "Scalability"),
        "cdn": ("CDN", "Scalability"),
        "circuit-breaker": ("Circuit Breaker", "Reliability"),
        "retry": ("Retry", "Reliability"),
        "bulkhead": ("Bulkhead", "Reliability"),
    }

    from design_reviewer.foundation.pattern_library import PatternLibrary

    for filename in PatternLibrary.PATTERN_FILES:
        name, category = categories[filename.replace(".md", "")]
        (patterns_dir / filename).write_text(
            pattern_template.format(name=name, category=category)
        )

    return patterns_dir


class TestCompleteInitializationSequence:
    """Test complete initialization sequence for all foundation components."""

    def setup_method(self):
        """Reset all singletons before each test."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None
        ConfigManager._instance = None
        ConfigManager._config = None
        PromptManager._instance = None
        PromptManager._prompts = {}
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_successful_initialization_sequence(self, mock_create_logger, tmp_path):
        """Test successful initialization of all components in correct order."""
        # 1. Setup Logger mock
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        # 2. Create real config, prompt, and pattern files
        config_file = _create_config_file(tmp_path)
        prompts_dir = _create_prompt_files(tmp_path)
        patterns_dir = _create_pattern_files(tmp_path)

        # Execute initialization sequence
        logger = Logger.initialize(
            log_file_path=str(tmp_path / "test.log"),
            log_level="INFO",
        )

        config_manager = ConfigManager.initialize(config_path=str(config_file))

        prompt_manager = PromptManager.initialize(prompts_directory=str(prompts_dir))

        pattern_library = PatternLibrary.initialize(
            patterns_directory=str(patterns_dir)
        )

        # Verify all components initialized successfully
        assert logger is not None
        assert config_manager is not None
        assert prompt_manager is not None
        assert pattern_library is not None

        # Verify singletons can be retrieved
        assert Logger.get_instance() is logger
        assert ConfigManager.get_instance() is config_manager
        assert PromptManager.get_instance() is prompt_manager
        assert PatternLibrary.get_instance() is pattern_library

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_components_can_interact(self, mock_create_logger, tmp_path):
        """Test initialized components can interact correctly."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        config_file = _create_config_file(tmp_path)
        prompts_dir = _create_prompt_files(tmp_path)
        patterns_dir = _create_pattern_files(tmp_path)

        Logger.initialize(
            log_file_path=str(tmp_path / "test.log"),
            log_level="INFO",
        )
        ConfigManager.initialize(config_path=str(config_file))
        PromptManager.initialize(prompts_directory=str(prompts_dir))
        PatternLibrary.initialize(patterns_directory=str(patterns_dir))

        # 1. ConfigManager can provide settings
        config = ConfigManager.get_instance()
        aws_config = config.get_aws_config()
        assert aws_config.region == "us-east-1"

        # 2. PromptManager can build prompts with PatternLibrary data
        pm = PromptManager.get_instance()
        pl = PatternLibrary.get_instance()

        formatted_patterns = pl.format_patterns_for_prompt()
        prompt = pm.build_agent_prompt("critique", {"patterns": formatted_patterns})

        assert len(prompt) > 0
        # Patterns should be injected into prompt
        assert "Layered Architecture" in prompt or "Pattern:" in prompt

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_logger_initialization_failure_stops_sequence(self, mock_create_logger):
        """Test failure in Logger initialization prevents subsequent steps."""
        mock_create_logger.side_effect = Exception("Logger creation failed")

        with pytest.raises(Exception) as exc_info:
            Logger.initialize(
                log_file_path="/tmp/test.log",
                log_level="INFO",
            )

        assert "Logger creation failed" in str(exc_info.value)

        # Subsequent components should not be initialized
        with pytest.raises(RuntimeError):
            ConfigManager.get_instance()

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_config_failure_stops_sequence(self, mock_create_logger):
        """Test failure in ConfigManager stops sequence (fail-fast)."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        Logger.initialize(
            log_file_path="/tmp/test.log",
            log_level="INFO",
        )

        # ConfigManager fails - file doesn't exist
        with pytest.raises(ConfigFileNotFoundError):
            ConfigManager.initialize(config_path="/nonexistent/config.yaml")

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_prompt_failure_stops_sequence(self, mock_create_logger, tmp_path):
        """Test failure in PromptManager stops sequence (fail-fast)."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        Logger.initialize(
            log_file_path=str(tmp_path / "test.log"),
            log_level="INFO",
        )

        config_file = _create_config_file(tmp_path)
        ConfigManager.initialize(config_path=str(config_file))

        # PromptManager fails (empty directory, missing required agents)
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()
        (prompts_dir / "critique-v1.md").write_text("Critique only")

        with pytest.raises(PromptFileNotFoundError):
            PromptManager.initialize(prompts_directory=str(prompts_dir))

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_pattern_failure_stops_sequence(self, mock_create_logger, tmp_path):
        """Test failure in PatternLibrary stops sequence (fail-fast)."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        Logger.initialize(
            log_file_path=str(tmp_path / "test.log"),
            log_level="INFO",
        )

        config_file = _create_config_file(tmp_path)
        ConfigManager.initialize(config_path=str(config_file))

        prompts_dir = _create_prompt_files(tmp_path)
        PromptManager.initialize(prompts_directory=str(prompts_dir))

        # PatternLibrary fails - only partial files
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        # Only create 3 of 15 expected files
        for name in PatternLibrary.PATTERN_FILES[:3]:
            (patterns_dir / name).write_text(
                "# Test\n\n## Category\nTest\n\n## Description\nTest\n\n"
                "## When to Use\nTest\n\n## Example\nTest"
            )

        with pytest.raises(PatternFileNotFoundError):
            PatternLibrary.initialize(patterns_directory=str(patterns_dir))


class TestSingletonAccessAfterInitialization:
    """Test singleton access works correctly after initialization."""

    def setup_method(self):
        """Reset all singletons."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None
        ConfigManager._instance = None
        ConfigManager._config = None
        PromptManager._instance = None
        PromptManager._prompts = {}
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_logger_accessible_after_init(self, mock_create_logger):
        """Test Logger.get_instance() works after initialization."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        logger = Logger.initialize(
            log_file_path="/tmp/test.log",
            log_level="INFO",
        )

        assert Logger.get_instance() is logger

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_multiple_singletons_accessible(self, mock_create_logger, tmp_path):
        """Test multiple singletons accessible after initialization."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        config_file = _create_config_file(tmp_path)

        logger = Logger.initialize(
            log_file_path=str(tmp_path / "test.log"),
            log_level="INFO",
        )
        config = ConfigManager.initialize(config_path=str(config_file))

        assert Logger.get_instance() is logger
        assert ConfigManager.get_instance() is config

    def test_singletons_fail_before_initialization(self):
        """Test get_instance() fails before initialization for all singletons."""
        with pytest.raises(RuntimeError):
            Logger.get_instance()

        with pytest.raises(RuntimeError):
            ConfigManager.get_instance()

        with pytest.raises(RuntimeError):
            PromptManager.get_instance()

        with pytest.raises(RuntimeError):
            PatternLibrary.get_instance()


class TestRealFileIntegration:
    """Test with real configuration/prompt/pattern files (optional integration tests)."""

    def setup_method(self):
        """Reset all singletons."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None
        ConfigManager._instance = None
        ConfigManager._config = None
        PromptManager._instance = None
        PromptManager._prompts = {}
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    @pytest.mark.skip(
        reason="Requires real files; run manually for integration testing"
    )
    def test_initialization_with_real_files(self, tmp_path):
        """Test initialization with actual config/prompt/pattern files."""
        pass
