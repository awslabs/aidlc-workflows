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
Unit tests for progress bar utilities.

Tests progress_bar() context manager and ProgressUpdater helper class.
"""

import pytest
from unittest.mock import Mock, patch, MagicMock

from design_reviewer.foundation.progress import progress_bar, ProgressUpdater


def _make_mock_progress():
    """Create a mock Progress that supports context manager protocol."""
    mock_progress = MagicMock()
    mock_progress.__enter__ = Mock(return_value=mock_progress)
    mock_progress.__exit__ = Mock(return_value=False)
    return mock_progress


class TestProgressBar:
    """Test progress_bar() context manager."""

    @patch("design_reviewer.foundation.progress.Progress")
    def test_context_manager_yields_updater(self, mock_progress_class):
        """Test progress_bar() yields ProgressUpdater instance."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        with progress_bar(description="Test task", total=100) as updater:
            assert isinstance(updater, ProgressUpdater)

    @patch("design_reviewer.foundation.progress.Progress")
    def test_creates_progress_with_rich(self, mock_progress_class):
        """Test progress bar uses Rich Progress."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        with progress_bar(description="Processing", total=50):
            pass

        mock_progress_class.assert_called_once()

    @patch("design_reviewer.foundation.progress.Progress")
    def test_adds_task_with_description(self, mock_progress_class):
        """Test task is added with correct description."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        with progress_bar(description="Loading patterns", total=100):
            pass

        mock_progress_instance.add_task.assert_called_once_with(
            "Loading patterns", total=100
        )

    @patch("design_reviewer.foundation.progress.Progress")
    def test_context_manager_enters_and_exits(self, mock_progress_class):
        """Test progress context manager is properly entered and exited."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        with progress_bar(description="Test", total=100):
            pass

        mock_progress_instance.__enter__.assert_called_once()
        mock_progress_instance.__exit__.assert_called_once()

    @patch("design_reviewer.foundation.progress.Progress")
    def test_exits_on_exception(self, mock_progress_class):
        """Test progress context manager exits even when exception is raised."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        with pytest.raises(ValueError):
            with progress_bar(description="Test", total=100):
                raise ValueError("Test exception")

        mock_progress_instance.__exit__.assert_called_once()

    @patch("design_reviewer.foundation.progress.Progress")
    def test_cleanup_guaranteed_by_context_manager(self, mock_progress_class):
        """Test cleanup is guaranteed by context manager pattern."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        try:
            with progress_bar(description="Test", total=100):
                raise RuntimeError("Forced error")
        except RuntimeError:
            pass

        assert mock_progress_instance.__exit__.called


class TestProgressUpdater:
    """Test ProgressUpdater helper class."""

    def test_update_sets_completed_value(self):
        """Test update() sets completed value."""
        mock_progress = Mock()
        task_id = 1

        updater = ProgressUpdater(mock_progress, task_id)
        updater.update(completed=50)

        mock_progress.update.assert_called_with(task_id, completed=50)

    def test_advance_increments_progress(self):
        """Test advance() increments progress by specified amount."""
        mock_progress = Mock()
        task_id = 1

        updater = ProgressUpdater(mock_progress, task_id)
        updater.advance(amount=10)

        mock_progress.advance.assert_called_with(task_id, advance=10)

    def test_advance_defaults_to_one(self):
        """Test advance() defaults to incrementing by 1."""
        mock_progress = Mock()
        task_id = 1

        updater = ProgressUpdater(mock_progress, task_id)
        updater.advance()

        mock_progress.advance.assert_called_with(task_id, advance=1)

    def test_set_description_updates_task_description(self):
        """Test set_description() updates task description."""
        mock_progress = Mock()
        task_id = 1

        updater = ProgressUpdater(mock_progress, task_id)
        updater.set_description("New description")

        mock_progress.update.assert_called_with(task_id, description="New description")

    def test_multiple_updates_accumulate(self):
        """Test multiple update calls work correctly."""
        mock_progress = Mock()
        task_id = 1

        updater = ProgressUpdater(mock_progress, task_id)
        updater.update(completed=25)
        updater.update(completed=50)
        updater.update(completed=75)

        assert mock_progress.update.call_count == 3

    def test_multiple_advances_accumulate(self):
        """Test multiple advance calls work correctly."""
        mock_progress = Mock()
        task_id = 1

        updater = ProgressUpdater(mock_progress, task_id)
        updater.advance(5)
        updater.advance(10)
        updater.advance(15)

        assert mock_progress.advance.call_count == 3


class TestProgressBarIntegration:
    """Test progress bar integration scenarios."""

    @patch("design_reviewer.foundation.progress.Progress")
    def test_typical_usage_pattern(self, mock_progress_class):
        """Test typical usage pattern for progress bar."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        total_items = 10

        with progress_bar(
            description="Processing items", total=total_items
        ) as progress:
            for i in range(total_items):
                progress.advance()

        assert mock_progress_instance.advance.call_count == total_items

    @patch("design_reviewer.foundation.progress.Progress")
    def test_updating_description_during_progress(self, mock_progress_class):
        """Test updating description while progress is running."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        with progress_bar(description="Initial", total=3) as progress:
            progress.advance()
            progress.set_description("Step 1 complete")
            progress.advance()
            progress.set_description("Step 2 complete")
            progress.advance()

        update_calls = [
            call
            for call in mock_progress_instance.update.call_args_list
            if "description" in (call[1] if len(call) > 1 else {})
        ]
        assert len(update_calls) >= 2

    @patch("design_reviewer.foundation.progress.Progress")
    def test_mixed_update_and_advance(self, mock_progress_class):
        """Test mixing update() and advance() calls."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        with progress_bar(description="Processing", total=100) as progress:
            progress.advance(10)
            progress.update(completed=50)
            progress.advance(25)

        assert mock_progress_instance.advance.called
        assert mock_progress_instance.update.called

    @patch("design_reviewer.foundation.progress.Progress")
    def test_progress_with_none_total(self, mock_progress_class):
        """Test progress bar with indeterminate progress (total=None)."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        with progress_bar(description="Loading...", total=None) as progress:
            progress.advance()

        mock_progress_instance.add_task.assert_called_once_with(
            "Loading...", total=None
        )

    @patch("design_reviewer.foundation.progress.Progress")
    def test_progress_completed_at_100_percent(self, mock_progress_class):
        """Test progress reaches 100% when total is reached."""
        mock_progress_instance = _make_mock_progress()
        mock_progress_class.return_value = mock_progress_instance
        mock_progress_instance.add_task.return_value = 1

        total = 5

        with progress_bar(description="Test", total=total) as progress:
            for _ in range(total):
                progress.advance()

        assert mock_progress_instance.advance.call_count == total

    @patch("design_reviewer.foundation.progress.Progress")
    def test_nested_progress_bars_create_separate_instances(self, mock_progress_class):
        """Test that nested progress bars create separate instances."""
        mock_progress_instance1 = _make_mock_progress()
        mock_progress_instance2 = _make_mock_progress()
        mock_progress_class.side_effect = [
            mock_progress_instance1,
            mock_progress_instance2,
        ]
        mock_progress_instance1.add_task.return_value = 1
        mock_progress_instance2.add_task.return_value = 2

        with progress_bar(description="Outer", total=10) as outer:
            outer.advance()
            with progress_bar(description="Inner", total=5) as inner:
                inner.advance()

        assert mock_progress_class.call_count == 2
        assert mock_progress_instance1.__enter__.called
        assert mock_progress_instance2.__enter__.called
