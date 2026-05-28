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
Logger factory for creating configured logging infrastructure.

Creates async queue-based logging with file and console handlers,
credential scrubbing, and context injection.
"""

import logging
import re
from logging.handlers import QueueHandler, QueueListener, RotatingFileHandler
from pathlib import Path
from queue import Queue
from typing import Any

from rich.console import Console
from rich.logging import RichHandler


class CredentialScrubbingFilter(logging.Filter):
    """Logging filter that scrubs credentials from all log records."""

    # Credential patterns to scrub
    CREDENTIAL_PATTERNS = [
        (r"AKIA[0-9A-Z]{16}", "***REDACTED_ACCESS_KEY***"),
        (r"[A-Za-z0-9/+=]{40}", "***REDACTED_SECRET***"),
        (r'"aws_access_key_id"\s*:\s*"[^"]*"', '"aws_access_key_id": "***REDACTED***"'),
        (
            r'"aws_secret_access_key"\s*:\s*"[^"]*"',
            '"aws_secret_access_key": "***REDACTED***"',
        ),
        (r'profile_name["\']?\s*:\s*["\']?[^,}\s]*', 'profile_name: "***REDACTED***"'),
    ]

    def filter(self, record: logging.LogRecord) -> bool:
        """
        Filter log record - scrub credentials from message and args.

        Args:
            record: Log record to filter

        Returns:
            True (always allow record after scrubbing)
        """
        # Scrub message string
        if isinstance(record.msg, str):
            record.msg = self._scrub(record.msg)

        # Scrub args tuple
        if record.args:
            scrubbed_args = []
            for arg in record.args:
                if isinstance(arg, str):
                    scrubbed_args.append(self._scrub(arg))
                else:
                    scrubbed_args.append(arg)
            record.args = tuple(scrubbed_args)

        return True

    def _scrub(self, text: str) -> str:
        """Apply all credential scrubbing patterns."""
        scrubbed = text
        for pattern, replacement in self.CREDENTIAL_PATTERNS:
            scrubbed = re.sub(pattern, replacement, scrubbed)
        return scrubbed


class ContextFilter(logging.Filter):
    """Filter that injects context variables into log records."""

    def __init__(self, context_getter):
        """
        Initialize context filter.

        Args:
            context_getter: Callable that returns current context dict
        """
        super().__init__()
        self._context_getter = context_getter

    def filter(self, record: logging.LogRecord) -> bool:
        """
        Inject context variables into log record.

        Args:
            record: Log record to filter

        Returns:
            True (always allow record)
        """
        context = self._context_getter()
        record.component = context.get("component", "Unknown")
        record.operation = context.get("operation", None)
        return True


class JSONFormatter(logging.Formatter):
    """Formatter that outputs JSON for file logging."""

    def format(self, record: logging.LogRecord) -> str:
        """
        Format log record as JSON.

        Args:
            record: Log record to format

        Returns:
            JSON-formatted log string
        """
        import json
        from datetime import UTC, datetime

        log_data = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "component": getattr(record, "component", None),
            "operation": getattr(record, "operation", None),
            "message": record.getMessage(),
        }

        # Add exception info if present
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_data)


class PlainFormatter(logging.Formatter):
    """Simple formatter for console output."""

    def format(self, record: logging.LogRecord) -> str:
        """
        Format log record as plain text.

        Args:
            record: Log record to format

        Returns:
            Plain text log string
        """
        component = getattr(record, "component", None)
        if component:
            return f"[{component}] {record.getMessage()}"
        return record.getMessage()


class LoggerFactory:
    """Factory for creating configured logger with async infrastructure."""

    @staticmethod
    def create_logger(
        log_file_path: str,
        log_level: str = "INFO",
        max_log_size_mb: int = 10,
        backup_count: int = 5,
        context_getter: Any = None,
    ) -> logging.Logger:
        """
        Create logger with async queue-based infrastructure.

        Args:
            log_file_path: Path to log file
            log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
            max_log_size_mb: Maximum log file size in MB before rotation
            backup_count: Number of backup log files to keep
            context_getter: Callable that returns current logging context

        Returns:
            Configured logger instance
        """
        # 1. Create log queue
        log_queue: Queue = Queue(-1)  # Unlimited size

        # 2. Create file handler (JSON format, rotating)
        log_path = Path(log_file_path).expanduser()
        log_path.parent.mkdir(parents=True, exist_ok=True)

        file_handler = RotatingFileHandler(
            filename=str(log_path),
            maxBytes=max_log_size_mb * 1024 * 1024,
            backupCount=backup_count,
            encoding="utf-8",
        )
        file_handler.setFormatter(JSONFormatter())
        file_handler.setLevel(logging.DEBUG)  # Verbose to file

        # 3. Create console handler (Rich, normal verbosity)
        console_handler = RichHandler(
            console=Console(), rich_tracebacks=True, show_time=True, show_path=False
        )
        console_handler.setFormatter(PlainFormatter())
        console_handler.setLevel(getattr(logging, log_level.upper()))

        # 4. Create queue handler (all loggers write here)
        queue_handler = QueueHandler(log_queue)

        # 5. Create queue listener (async writes to handlers)
        queue_listener = QueueListener(
            log_queue, file_handler, console_handler, respect_handler_level=True
        )

        # 6. Configure logger
        logger = logging.getLogger("design_reviewer")
        logger.setLevel(logging.DEBUG)
        logger.handlers.clear()  # Clear any existing handlers
        logger.addHandler(queue_handler)

        # 7. Add filters
        logger.addFilter(CredentialScrubbingFilter())
        if context_getter:
            logger.addFilter(ContextFilter(context_getter))

        # 8. Store listener for lifecycle management
        logger._queue_listener = queue_listener  # type: ignore

        return logger
