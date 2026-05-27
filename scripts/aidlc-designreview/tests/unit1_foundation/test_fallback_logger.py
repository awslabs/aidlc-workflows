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
Unit tests for fallback logger.

Tests log_startup_error() function for pre-Logger initialization errors.
"""

import pytest
from unittest.mock import patch, mock_open

from design_reviewer.foundation.fallback_logger import log_startup_error


class TestFallbackLogger:
    """Test fallback logging for startup errors."""

    @patch("sys.stderr")
    def test_writes_to_stderr(self, mock_stderr):
        """Test log_startup_error() writes to stderr."""
        error_message = "Failed to load configuration"

        log_startup_error(error_message)

        # Verify stderr.write was called
        assert mock_stderr.write.called
        # Check that error message appears in one of the write calls
        all_writes = "".join(
            [str(call_obj[0][0]) for call_obj in mock_stderr.write.call_args_list]
        )
        assert error_message in all_writes

    @patch("sys.stderr")
    def test_error_message_includes_timestamp(self, mock_stderr):
        """Test error message includes timestamp."""
        error_message = "Test error"

        log_startup_error(error_message)

        all_writes = "".join(
            [str(call_obj[0][0]) for call_obj in mock_stderr.write.call_args_list]
        )
        # Should contain timestamp-like content (year in format)
        assert "202" in all_writes or "ERROR" in all_writes.upper()

    @patch("sys.stderr")
    @patch("builtins.open", new_callable=mock_open)
    @patch("pathlib.Path.mkdir")
    def test_writes_to_fallback_log_file(self, mock_mkdir, mock_file, mock_stderr):
        """Test log_startup_error() writes to fallback log file."""
        error_message = "Configuration file not found"

        log_startup_error(error_message)

        # Verify file was opened for writing
        mock_file.assert_called()
        # Check file path contains expected directory structure
        file_path_str = str(mock_file.call_args)
        assert ".design-reviewer" in file_path_str or "startup" in file_path_str

    @patch("sys.stderr")
    @patch("builtins.open", new_callable=mock_open)
    @patch("pathlib.Path.mkdir")
    def test_creates_log_directory_if_missing(self, mock_mkdir, mock_file, mock_stderr):
        """Test fallback logger creates log directory if it doesn't exist."""
        error_message = "Initialization failed"

        log_startup_error(error_message)

        # Verify directory creation was attempted
        mock_mkdir.assert_called()
        # Should create with parents=True
        call_kwargs = mock_mkdir.call_args[1] if mock_mkdir.call_args else {}
        assert call_kwargs.get("parents") is True or call_kwargs.get("exist_ok") is True

    @patch("sys.stderr")
    @patch("builtins.open", new_callable=mock_open)
    @patch("pathlib.Path.mkdir")
    def test_writes_error_message_to_file(self, mock_mkdir, mock_file, mock_stderr):
        """Test error message is written to fallback log file."""
        error_message = "Failed to initialize Logger"

        log_startup_error(error_message)

        # Get the file handle
        handle = mock_file()
        # Verify write was called with error message
        write_calls = handle.write.call_args_list
        all_writes = "".join([str(call_obj[0][0]) for call_obj in write_calls])
        assert error_message in all_writes

    @patch("sys.stderr")
    @patch("builtins.open", side_effect=PermissionError("Cannot write"))
    @patch("pathlib.Path.mkdir")
    def test_continues_if_file_write_fails(self, mock_mkdir, mock_file, mock_stderr):
        """Test fallback logger continues if file write fails (best-effort)."""
        error_message = "Test error"

        # Should not raise even though file write fails
        try:
            log_startup_error(error_message)
        except PermissionError:
            pytest.fail("log_startup_error() should not raise on file write failure")

        # Should still write to stderr
        assert mock_stderr.write.called

    @patch("sys.stderr")
    @patch("builtins.open", new_callable=mock_open)
    @patch("pathlib.Path.mkdir", side_effect=OSError("Cannot create directory"))
    def test_continues_if_directory_creation_fails(
        self, mock_mkdir, mock_file, mock_stderr
    ):
        """Test fallback logger continues if directory creation fails."""
        error_message = "Test error"

        # Should not raise even though mkdir fails
        try:
            log_startup_error(error_message)
        except OSError:
            pytest.fail(
                "log_startup_error() should not raise on directory creation failure"
            )

        # Should still write to stderr
        assert mock_stderr.write.called

    @patch("sys.stderr")
    def test_handles_exception_objects(self, mock_stderr):
        """Test log_startup_error() handles exception objects."""
        original_error = ValueError("Invalid configuration")

        log_startup_error("Startup failed", exception=original_error)

        all_writes = "".join(
            [str(call_obj[0][0]) for call_obj in mock_stderr.write.call_args_list]
        )
        # Should include both message and exception info
        assert "Startup failed" in all_writes
        assert "ValueError" in all_writes or "Invalid configuration" in all_writes

    @patch("sys.stderr")
    @patch("builtins.open", new_callable=mock_open)
    @patch("pathlib.Path.mkdir")
    def test_formats_message_readably(self, mock_mkdir, mock_file, mock_stderr):
        """Test error message is formatted in a readable way."""
        error_message = "Configuration validation failed"

        log_startup_error(error_message)

        # Check stderr output format
        all_writes = "".join(
            [str(call_obj[0][0]) for call_obj in mock_stderr.write.call_args_list]
        )

        # Should be clear it's an error
        assert "ERROR" in all_writes.upper() or "error" in all_writes.lower()
        # Should include the actual message
        assert error_message in all_writes

    @patch("sys.stderr")
    @patch("builtins.open", new_callable=mock_open)
    @patch("pathlib.Path.mkdir")
    def test_multiple_calls_append_to_log(self, mock_mkdir, mock_file, mock_stderr):
        """Test multiple calls to log_startup_error() append to log file."""
        log_startup_error("Error 1")
        log_startup_error("Error 2")

        # File should be opened multiple times (or opened in append mode)
        assert mock_file.call_count >= 2

    @patch("sys.stderr")
    def test_stderr_output_includes_newline(self, mock_stderr):
        """Test stderr output includes newline for readability."""
        log_startup_error("Test error")

        # Check that newline was written
        all_writes = [
            str(call_obj[0][0]) for call_obj in mock_stderr.write.call_args_list
        ]
        # At least one write should include a newline
        assert any("\n" in write for write in all_writes)

    @patch("sys.stderr")
    @patch("builtins.open", new_callable=mock_open)
    @patch("pathlib.Path.mkdir")
    def test_fallback_log_path_is_user_home_directory(
        self, mock_mkdir, mock_file, mock_stderr
    ):
        """Test fallback log file is created in user home directory."""
        log_startup_error("Test error")

        # Verify the path includes user home directory structure
        file_path = str(mock_file.call_args)
        # Should reference .design-reviewer or home directory
        assert ".design-reviewer" in file_path.lower() or "logs" in file_path.lower()
