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
Logger singleton for Design Reviewer application.

Provides simple logging interface with async queue-based logging,
credential scrubbing, and context management.
"""

import atexit
import logging
import re
from contextvars import ContextVar
from typing import Any, Dict, Optional

from .logger_factory import LoggerFactory


# Module-level context variable for thread-safe logging context
log_context: ContextVar[Dict[str, str]] = ContextVar("log_context", default={})


class Logger:
    """
    Singleton logger with async logging, credential scrubbing, and context management.
    """

    _instance: Optional["Logger"] = None
    _logger: Optional[logging.Logger] = None
    _queue_listener: Optional[Any] = None

    # Credential patterns for first-layer scrubbing
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

    @classmethod
    def initialize(
        cls,
        log_file_path: str = "logs/design-reviewer.log",
        log_level: str = "INFO",
        max_log_size_mb: int = 10,
        backup_count: int = 5,
    ) -> "Logger":
        """
        Initialize singleton logger instance.

        Args:
            log_file_path: Path to log file
            log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
            max_log_size_mb: Maximum log file size in MB before rotation
            backup_count: Number of backup log files to keep

        Returns:
            Logger singleton instance

        Raises:
            RuntimeError: If logger already initialized
        """
        if cls._instance is not None:
            raise RuntimeError(
                "Logger already initialized. Call get_instance() to access existing instance."
            )

        # Create logger via factory
        logger = LoggerFactory.create_logger(
            log_file_path=log_file_path,
            log_level=log_level,
            max_log_size_mb=max_log_size_mb,
            backup_count=backup_count,
            context_getter=cls._get_context,
        )

        # Store logger and queue listener
        cls._logger = logger
        cls._queue_listener = getattr(logger, "_queue_listener", None)

        # Start queue listener
        if cls._queue_listener:
            cls._queue_listener.start()

        # Register shutdown handler
        atexit.register(cls.shutdown)

        # Create and store singleton instance
        cls._instance = cls()

        return cls._instance

    @classmethod
    def get_instance(cls) -> "Logger":
        """
        Get singleton logger instance.

        Returns:
            Logger singleton instance

        Raises:
            RuntimeError: If logger not initialized
        """
        if cls._instance is None:
            raise RuntimeError(
                "Logger not initialized. Call Logger.initialize() first."
            )
        return cls._instance

    @classmethod
    def shutdown(cls) -> None:
        """
        Shutdown logger and flush all logs.

        Called automatically on exit via atexit.
        """
        if cls._queue_listener is not None:
            cls._queue_listener.stop()
            cls._queue_listener = None

    @classmethod
    def reset(cls) -> None:
        """Reset singleton for testing. NOT for production use."""
        cls.shutdown()
        cls._instance = None
        cls._logger = None

    # Context management methods

    @staticmethod
    def set_context(component: str, operation: Optional[str] = None) -> None:
        """
        Set logging context for current execution context.

        Args:
            component: Component name (e.g., "ConfigManager")
            operation: Optional operation name (e.g., "load")
        """
        context = {"component": component}
        if operation:
            context["operation"] = operation
        log_context.set(context)

    @staticmethod
    def clear_context() -> None:
        """Clear logging context."""
        log_context.set({})

    @staticmethod
    def _get_context() -> Dict[str, str]:
        """Get current logging context."""
        return log_context.get()

    # Credential scrubbing (first defense layer)

    def _scrub_credentials(self, message: str) -> str:
        """
        Scrub credentials from message (first defense layer).

        Args:
            message: Log message

        Returns:
            Scrubbed message
        """
        scrubbed = message
        for pattern, replacement in self.CREDENTIAL_PATTERNS:
            scrubbed = re.sub(pattern, replacement, scrubbed)
        return scrubbed

    # Logging methods

    def debug(self, message: str, **kwargs) -> None:
        """
        Log debug message with credential scrubbing.

        Args:
            message: Log message
            **kwargs: Additional context to log
        """
        if self._logger:
            scrubbed_message = self._scrub_credentials(message)
            self._logger.debug(scrubbed_message, extra=kwargs)

    def info(self, message: str, **kwargs) -> None:
        """
        Log info message with credential scrubbing.

        Args:
            message: Log message
            **kwargs: Additional context to log
        """
        if self._logger:
            scrubbed_message = self._scrub_credentials(message)
            self._logger.info(scrubbed_message, extra=kwargs)

    def warning(self, message: str, **kwargs) -> None:
        """
        Log warning message with credential scrubbing.

        Args:
            message: Log message
            **kwargs: Additional context to log
        """
        if self._logger:
            scrubbed_message = self._scrub_credentials(message)
            self._logger.warning(scrubbed_message, extra=kwargs)

    def error(self, message: str, **kwargs) -> None:
        """
        Log error message with credential scrubbing.

        Args:
            message: Log message
            **kwargs: Additional context to log
        """
        if self._logger:
            scrubbed_message = self._scrub_credentials(message)
            self._logger.error(scrubbed_message, extra=kwargs)

    def critical(self, message: str, **kwargs) -> None:
        """
        Log critical message with credential scrubbing.

        Args:
            message: Log message
            **kwargs: Additional context to log
        """
        if self._logger:
            scrubbed_message = self._scrub_credentials(message)
            self._logger.critical(scrubbed_message, extra=kwargs)

    def exception(self, message: str, **kwargs) -> None:
        """
        Log exception message with traceback and credential scrubbing.

        Args:
            message: Log message
            **kwargs: Additional context to log
        """
        if self._logger:
            scrubbed_message = self._scrub_credentials(message)
            self._logger.exception(scrubbed_message, extra=kwargs)
