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
Fallback logger for logging errors before Logger is initialized.

Writes to stderr and a fallback log file when the main Logger is not available.
"""

import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Optional


def log_startup_error(message: str, exception: Optional[Exception] = None) -> None:
    """
    Log startup errors before Logger is initialized.

    Writes to both console (stderr) and fallback log file.
    Attempts logging - if file write fails, console output still works.

    Args:
        message: Error message
        exception: Optional exception that caused the error
    """
    timestamp = datetime.now().isoformat()

    # 1. Console output (stderr)
    print(f"\n❌ STARTUP ERROR [{timestamp}]", file=sys.stderr)
    print(f"   {message}", file=sys.stderr)
    if exception:
        print(f"   Caused by: {type(exception).__name__}: {exception}", file=sys.stderr)
    print(file=sys.stderr)

    # 2. Fallback log file (attempts to write)
    try:
        fallback_log = Path.home() / ".design-reviewer" / "logs" / "startup-errors.log"
        fallback_log.parent.mkdir(parents=True, exist_ok=True)

        with open(fallback_log, "a", encoding="utf-8") as f:
            f.write(f"\n{'=' * 80}\n")
            f.write(f"[{timestamp}] STARTUP ERROR\n")
            f.write(f"{message}\n")
            if exception:
                f.write(f"Caused by: {type(exception).__name__}: {exception}\n")
                f.write(traceback.format_exc())
            f.write(f"{'=' * 80}\n")

    except Exception as log_error:
        # If fallback logging fails, only console is available
        print(
            f"   Warning: Could not write to fallback log: {log_error}", file=sys.stderr
        )
