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
Unit tests for Logger singleton wrapper.

Tests singleton initialization, logging methods, credential scrubbing,
context management, and queue lifecycle.
"""

import pytest
from unittest.mock import Mock, patch

from design_reviewer.foundation.logger import Logger


class TestLoggerSingleton:
    """Test Logger singleton pattern."""

    def setup_method(self):
        """Reset singleton before each test."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None

    def test_get_instance_fails_before_initialization(self):
        """Test get_instance() raises error if not initialized."""
        with pytest.raises(RuntimeError) as exc_info:
            Logger.get_instance()

        assert "not initialized" in str(exc_info.value).lower()

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_initialize_creates_singleton(self, mock_create_logger):
        """Test initialize() creates singleton instance."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        instance = Logger.initialize(
            log_file_path="/tmp/test.log",
            log_level="INFO",
        )

        assert Logger._instance is not None
        assert isinstance(instance, Logger)

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_initialize_twice_raises_error(self, mock_create_logger):
        """Test calling initialize() twice raises RuntimeError."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        Logger.initialize(
            log_file_path="/tmp/test.log",
            log_level="INFO",
        )

        with pytest.raises(RuntimeError, match="already initialized"):
            Logger.initialize(
                log_file_path="/tmp/test.log",
                log_level="INFO",
            )

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_get_instance_returns_initialized_logger(self, mock_create_logger):
        """Test get_instance() returns logger after initialization."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        Logger.initialize(
            log_file_path="/tmp/test.log",
            log_level="INFO",
        )

        instance = Logger.get_instance()
        assert instance is not None
        assert isinstance(instance, Logger)


class TestLoggingMethods:
    """Test logging methods (debug, info, warning, error, critical)."""

    def setup_method(self):
        """Reset singleton and initialize with mock logger."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None

        self.mock_logger = Mock()
        self.mock_logger._queue_listener = Mock()

        with patch(
            "design_reviewer.foundation.logger.LoggerFactory.create_logger"
        ) as mock_create:
            mock_create.return_value = self.mock_logger
            Logger.initialize(
                log_file_path="/tmp/test.log",
                log_level="DEBUG",
            )

        self.logger = Logger.get_instance()

    def test_debug_method_calls_underlying_logger(self):
        """Test debug() calls underlying logger with correct level."""
        self.logger.debug("Debug message")
        self.mock_logger.debug.assert_called_once()

    def test_info_method_calls_underlying_logger(self):
        """Test info() calls underlying logger with correct level."""
        self.logger.info("Info message")
        self.mock_logger.info.assert_called_once()

    def test_warning_method_calls_underlying_logger(self):
        """Test warning() calls underlying logger with correct level."""
        self.logger.warning("Warning message")
        self.mock_logger.warning.assert_called_once()

    def test_error_method_calls_underlying_logger(self):
        """Test error() calls underlying logger with correct level."""
        self.logger.error("Error message")
        self.mock_logger.error.assert_called_once()

    def test_critical_method_calls_underlying_logger(self):
        """Test critical() calls underlying logger with correct level."""
        self.logger.critical("Critical message")
        self.mock_logger.critical.assert_called_once()

    def test_exception_method_calls_underlying_logger(self):
        """Test exception() logs exception info."""
        try:
            raise ValueError("Test exception")
        except ValueError:
            self.logger.exception("Exception occurred")

        self.mock_logger.exception.assert_called_once()


class TestCredentialScrubbing:
    """Test credential scrubbing in log messages (defense layer 1)."""

    def setup_method(self):
        """Reset singleton and initialize."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None

        self.mock_logger = Mock()
        self.mock_logger._queue_listener = Mock()

        with patch(
            "design_reviewer.foundation.logger.LoggerFactory.create_logger"
        ) as mock_create:
            mock_create.return_value = self.mock_logger
            Logger.initialize(
                log_file_path="/tmp/test.log",
                log_level="INFO",
            )

        self.logger = Logger.get_instance()

    def test_scrubs_aws_access_key_in_log_message(self):
        """Test AWS access key is scrubbed from log message."""
        message = "Loaded AWS credentials: AKIAIOSFODNN7EXAMPLE"
        self.logger.info(message)

        call_args = self.mock_logger.info.call_args
        logged_message = call_args[0][0]
        assert "AKIAIOSFODNN7EXAMPLE" not in logged_message
        assert "REDACTED" in logged_message

    def test_scrubs_aws_secret_key_in_log_message(self):
        """Test AWS secret key is scrubbed from log message."""
        message = "Secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        self.logger.info(message)

        call_args = self.mock_logger.info.call_args
        logged_message = call_args[0][0]
        assert "wJalrXUtnFEMI" not in logged_message
        assert "REDACTED" in logged_message

    def test_preserves_non_credential_content(self):
        """Test non-credential content is preserved in logs."""
        message = "Loaded configuration from /home/user/.design-reviewer/config.yaml"
        self.logger.info(message)

        call_args = self.mock_logger.info.call_args
        logged_message = call_args[0][0]
        assert "Loaded configuration" in logged_message
        assert ".design-reviewer/config.yaml" in logged_message


class TestContextManagement:
    """Test logging context management."""

    def setup_method(self):
        """Reset singleton and initialize."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None

        self.mock_logger = Mock()
        self.mock_logger._queue_listener = Mock()

        with patch(
            "design_reviewer.foundation.logger.LoggerFactory.create_logger"
        ) as mock_create:
            mock_create.return_value = self.mock_logger
            Logger.initialize(
                log_file_path="/tmp/test.log",
                log_level="INFO",
            )

        self.logger = Logger.get_instance()

    def test_set_context_stores_context(self):
        """Test set_context() stores component and operation."""
        Logger.set_context(component="ConfigManager", operation="load_config")

        context = Logger._get_context()
        assert context["component"] == "ConfigManager"
        assert context["operation"] == "load_config"

    def test_set_context_with_partial_data(self):
        """Test set_context() with only component."""
        Logger.set_context(component="PromptManager")

        context = Logger._get_context()
        assert context["component"] == "PromptManager"
        assert "operation" not in context

    def test_clear_context_removes_context(self):
        """Test clear_context() removes stored context."""
        Logger.set_context(component="PatternLibrary", operation="load_patterns")
        Logger.clear_context()

        context = Logger._get_context()
        assert not context or context.get("component") is None


class TestQueueLifecycle:
    """Test logging queue lifecycle (startup, shutdown)."""

    def setup_method(self):
        """Reset singleton before each test."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_shutdown_stops_queue_listener(self, mock_create_logger):
        """Test shutdown() stops the queue listener."""
        mock_logger = Mock()
        mock_listener = Mock()
        mock_logger._queue_listener = mock_listener
        mock_create_logger.return_value = mock_logger

        Logger.initialize(
            log_file_path="/tmp/test.log",
            log_level="INFO",
        )

        Logger.shutdown()

        mock_listener.stop.assert_called_once()

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    @patch("design_reviewer.foundation.logger.atexit.register")
    def test_atexit_handler_registered(self, mock_atexit, mock_create_logger):
        """Test shutdown is registered with atexit."""
        mock_logger = Mock()
        mock_logger._queue_listener = Mock()
        mock_create_logger.return_value = mock_logger

        Logger.initialize(
            log_file_path="/tmp/test.log",
            log_level="INFO",
        )

        mock_atexit.assert_called()

    @patch("design_reviewer.foundation.logger.LoggerFactory.create_logger")
    def test_multiple_shutdowns_safe(self, mock_create_logger):
        """Test calling shutdown() multiple times is safe."""
        mock_logger = Mock()
        mock_listener = Mock()
        mock_logger._queue_listener = mock_listener
        mock_create_logger.return_value = mock_logger

        Logger.initialize(
            log_file_path="/tmp/test.log",
            log_level="INFO",
        )

        Logger.shutdown()
        Logger.shutdown()  # Should not raise


class TestLogOutputCapture:
    """Test log output is actually written (integration-style tests)."""

    def setup_method(self):
        """Reset singleton before each test."""
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None

    def test_log_messages_are_captured(self, tmp_path):
        """Test log messages are written to file."""
        log_file = tmp_path / "test.log"

        Logger.initialize(
            log_file_path=str(log_file),
            log_level="INFO",
        )

        logger = Logger.get_instance()
        logger.info("Test message 1")
        logger.warning("Test message 2")

        Logger.shutdown()
        Logger._instance = None
        Logger._logger = None
        Logger._queue_listener = None
