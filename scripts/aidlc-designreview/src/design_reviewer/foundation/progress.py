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
Progress bar utilities using Rich library.

Provides context manager for progress bars with automatic cleanup.
"""

from contextlib import contextmanager
from typing import Generator

from rich.progress import Progress, TaskID


class ProgressUpdater:
    """Helper for updating progress within context."""

    def __init__(self, progress: Progress, task: TaskID):
        """
        Initialize progress updater.

        Args:
            progress: Rich Progress instance
            task: Task ID
        """
        self._progress = progress
        self._task = task

    def update(self, completed: int) -> None:
        """
        Update progress to specific completion value.

        Args:
            completed: Number of completed steps
        """
        self._progress.update(self._task, completed=completed)

    def advance(self, amount: int = 1) -> None:
        """
        Advance progress by amount.

        Args:
            amount: Number of steps to advance
        """
        self._progress.advance(self._task, advance=amount)

    def set_description(self, description: str) -> None:
        """
        Update progress bar description.

        Args:
            description: New description
        """
        self._progress.update(self._task, description=description)


@contextmanager
def progress_bar(
    description: str, total: int
) -> Generator[ProgressUpdater, None, None]:
    """
    Context manager for progress bars with automatic cleanup.

    Args:
        description: Progress bar description
        total: Total number of steps

    Yields:
        ProgressUpdater: Object for updating progress

    Example:
        >>> with progress_bar("Loading patterns", total=15) as progress:
        ...     for i, pattern_file in enumerate(pattern_files):
        ...         pattern = load_pattern(pattern_file)
        ...         progress.update(i + 1)
    """
    with Progress() as progress:
        task = progress.add_task(description, total=total)
        try:
            yield ProgressUpdater(progress, task)
        finally:
            # Rich Progress's __exit__ stops progress bar automatically
            pass
