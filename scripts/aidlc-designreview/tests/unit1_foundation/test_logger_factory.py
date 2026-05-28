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
Unit tests for LoggerFactory.

Tests logger creation, queue infrastructure, handlers, filters, and formatters.
"""

import logging

from design_reviewer.foundation.logger_factory import (
    LoggerFactory,
    CredentialScrubbingFilter,
    ContextFilter,
    JSONFormatter,
    PlainFormatter,
)


class TestCredentialScrubbingFilter:
    """Test credential scrubbing filter."""

    def test_scrubs_aws_access_key_id(self):
        """Test AWS access key ID is scrubbed."""
        filter_obj = CredentialScrubbingFilter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
            args=(),
            exc_info=None,
        )

        filter_obj.filter(record)
        assert "AKIAIOSFODNN7EXAMPLE" not in record.msg
        assert "REDACTED" in record.msg

    def test_scrubs_aws_secret_access_key(self):
        """Test AWS secret access key is scrubbed."""
        filter_obj = CredentialScrubbingFilter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            args=(),
            exc_info=None,
        )

        filter_obj.filter(record)
        assert "wJalrXUtnFEMI" not in record.msg
        assert "REDACTED" in record.msg

    def test_scrubs_multiple_credentials_in_one_message(self):
        """Test multiple credentials in one log message are all scrubbed."""
        filter_obj = CredentialScrubbingFilter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Config: access_key=AKIAIOSFODNN7EXAMPLE, secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            args=(),
            exc_info=None,
        )

        filter_obj.filter(record)
        assert "AKIAIOSFODNN7EXAMPLE" not in record.msg
        assert "wJalrXUtnFEMI" not in record.msg

    def test_preserves_non_credential_content(self):
        """Test non-credential content is preserved."""
        filter_obj = CredentialScrubbingFilter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Loaded configuration from /home/user/.design-reviewer/config.yaml",
            args=(),
            exc_info=None,
        )

        original_msg = record.msg
        filter_obj.filter(record)
        assert record.msg == original_msg

    def test_filter_always_returns_true(self):
        """Test filter always returns True (allows all records)."""
        filter_obj = CredentialScrubbingFilter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Test message",
            args=(),
            exc_info=None,
        )

        result = filter_obj.filter(record)
        assert result is True


class TestContextFilter:
    """Test context filter for injecting component/operation info."""

    def test_injects_component_context(self):
        """Test component name is injected into log record."""
        context_getter = lambda: {"component": "ConfigManager"}
        filter_obj = ContextFilter(context_getter)
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Test message",
            args=(),
            exc_info=None,
        )

        filter_obj.filter(record)
        assert hasattr(record, "component")
        assert record.component == "ConfigManager"

    def test_injects_operation_context(self):
        """Test operation name is injected into log record."""
        context_getter = lambda: {"operation": "load_config"}
        filter_obj = ContextFilter(context_getter)
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Test message",
            args=(),
            exc_info=None,
        )

        filter_obj.filter(record)
        assert hasattr(record, "operation")
        assert record.operation == "load_config"

    def test_empty_context_does_not_error(self):
        """Test empty context dictionary does not cause errors."""
        context_getter = lambda: {}
        filter_obj = ContextFilter(context_getter)
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Test message",
            args=(),
            exc_info=None,
        )

        result = filter_obj.filter(record)
        assert result is True


class TestJSONFormatter:
    """Test JSON formatter for file logging."""

    def test_formats_log_as_json(self):
        """Test log record is formatted as valid JSON."""
        import json

        formatter = JSONFormatter()
        record = logging.LogRecord(
            name="test.logger",
            level=logging.INFO,
            pathname="/path/to/file.py",
            lineno=42,
            msg="Test message",
            args=(),
            exc_info=None,
        )

        formatted = formatter.format(record)
        parsed = json.loads(formatted)

        assert "timestamp" in parsed
        assert "level" in parsed
        assert "message" in parsed
        assert parsed["message"] == "Test message"

    def test_includes_standard_fields(self):
        """Test JSON output includes standard fields."""
        import json

        formatter = JSONFormatter()
        record = logging.LogRecord(
            name="design_reviewer.foundation.config_manager",
            level=logging.WARNING,
            pathname="/path/to/config_manager.py",
            lineno=100,
            msg="Configuration validation warning",
            args=(),
            exc_info=None,
        )

        formatted = formatter.format(record)
        parsed = json.loads(formatted)

        assert parsed["level"] == "WARNING"
        assert parsed["message"] == "Configuration validation warning"

    def test_includes_context_fields_if_present(self):
        """Test context fields are included in JSON output."""
        import json

        formatter = JSONFormatter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Test",
            args=(),
            exc_info=None,
        )
        record.component = "PatternLibrary"
        record.operation = "load_patterns"

        formatted = formatter.format(record)
        parsed = json.loads(formatted)

        assert parsed.get("component") == "PatternLibrary"
        assert parsed.get("operation") == "load_patterns"


class TestPlainFormatter:
    """Test plain text formatter for console output."""

    def test_formats_log_as_plain_text(self):
        """Test log record is formatted as readable plain text."""
        formatter = PlainFormatter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Test message",
            args=(),
            exc_info=None,
        )

        formatted = formatter.format(record)
        assert "Test message" in formatted
        assert isinstance(formatted, str)

    def test_includes_component_if_present(self):
        """Test component is included in plain text output when present."""
        formatter = PlainFormatter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="Loading configuration",
            args=(),
            exc_info=None,
        )
        record.component = "ConfigManager"

        formatted = formatter.format(record)
        assert "ConfigManager" in formatted


class TestLoggerFactory:
    """Test LoggerFactory logger creation."""

    def test_creates_logger_instance(self, tmp_path):
        """Test logger is created successfully."""
        log_file = tmp_path / "test.log"

        logger = LoggerFactory.create_logger(
            log_file_path=str(log_file),
            log_level="INFO",
        )

        assert logger is not None
        assert isinstance(logger, logging.Logger)

    def test_creates_logger_with_correct_level(self, tmp_path):
        """Test logger is created with correct log level."""
        log_file = tmp_path / "test.log"

        logger = LoggerFactory.create_logger(
            log_file_path=str(log_file),
            log_level="DEBUG",
        )

        assert logger.level == logging.DEBUG

    def test_attaches_credential_scrubbing_filter(self, tmp_path):
        """Test credential scrubbing filter is attached to logger."""
        log_file = tmp_path / "test.log"

        logger = LoggerFactory.create_logger(
            log_file_path=str(log_file),
            log_level="INFO",
        )

        filter_types = [type(f) for f in logger.filters]
        assert CredentialScrubbingFilter in filter_types

    def test_attaches_context_filter_when_getter_provided(self, tmp_path):
        """Test context filter is attached when context_getter is provided."""
        log_file = tmp_path / "test.log"
        context_getter = lambda: {"component": "Test"}

        logger = LoggerFactory.create_logger(
            log_file_path=str(log_file),
            log_level="INFO",
            context_getter=context_getter,
        )

        filter_types = [type(f) for f in logger.filters]
        assert ContextFilter in filter_types

    def test_stores_queue_listener_on_logger(self, tmp_path):
        """Test queue listener is stored on logger for lifecycle management."""
        log_file = tmp_path / "test.log"

        logger = LoggerFactory.create_logger(
            log_file_path=str(log_file),
            log_level="INFO",
        )

        assert hasattr(logger, "_queue_listener")
        assert logger._queue_listener is not None
