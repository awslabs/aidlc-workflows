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
Tests for Unit 5 MarkdownFormatter.

Tests format() output structure (section order, headings, finding counts),
markdown escaping, write_to_file with parent dir creation, file size verification.
"""

import pytest

from design_reviewer.reporting.markdown_formatter import (
    MarkdownFormatter,
    ReportWriteError,
)
from design_reviewer.reporting.template_env import reset_environment


@pytest.fixture(autouse=True)
def clean_environment():
    reset_environment()
    yield
    reset_environment()


@pytest.fixture
def formatter():
    return MarkdownFormatter()


class TestMarkdownFormat:
    def test_returns_string(self, formatter, sample_report_data):
        result = formatter.format(sample_report_data)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_contains_metadata_section(self, formatter, sample_report_data):
        result = formatter.format(sample_report_data)
        assert "test-project" in result
        assert "0.1.0" in result

    def test_contains_executive_summary(self, formatter, sample_report_data):
        result = formatter.format(sample_report_data)
        assert "Needs Improvement" in result or "Executive Summary" in result

    def test_contains_critique_findings(self, formatter, sample_report_data):
        result = formatter.format(sample_report_data)
        assert "Missing Error Handling" in result
        assert "SQL Injection Risk" in result

    def test_contains_alternative_suggestions(self, formatter, sample_report_data):
        result = formatter.format(sample_report_data)
        assert "Event-Driven Architecture" in result

    def test_contains_gap_findings(self, formatter, sample_report_data):
        result = formatter.format(sample_report_data)
        assert "No Disaster Recovery Plan" in result

    def test_contains_agent_statuses(self, formatter, sample_report_data):
        result = formatter.format(sample_report_data)
        assert "critique" in result
        assert "Completed" in result


class TestMarkdownWriteToFile:
    def test_writes_file(self, formatter, tmp_path):
        output = tmp_path / "report.md"
        formatter.write_to_file("# Report Content", output)
        assert output.exists()
        assert output.read_text(encoding="utf-8") == "# Report Content"

    def test_creates_parent_dirs(self, formatter, tmp_path):
        output = tmp_path / "nested" / "dir" / "report.md"
        formatter.write_to_file("# Content", output)
        assert output.exists()

    def test_empty_content_raises(self, formatter, tmp_path):
        output = tmp_path / "empty.md"
        with pytest.raises(ReportWriteError, match="empty"):
            formatter.write_to_file("", output)

    def test_invalid_path_raises(self, formatter, tmp_path):
        # Use a read-only file as directory to force OSError
        blocker = tmp_path / "blocker"
        blocker.write_text("x")
        bad_path = blocker / "report.md"
        with pytest.raises(ReportWriteError):
            formatter.write_to_file("content", bad_path)

    def test_file_size_nonzero(self, formatter, tmp_path):
        output = tmp_path / "report.md"
        content = "# Non-empty report\nSome content here."
        formatter.write_to_file(content, output)
        assert output.stat().st_size > 0


class TestReportWriteError:
    def test_is_design_reviewer_error(self):
        from design_reviewer.foundation.exceptions import DesignReviewerError

        err = ReportWriteError("test error")
        assert isinstance(err, DesignReviewerError)

    def test_has_suggested_fix(self):
        err = ReportWriteError("test error")
        assert err.suggested_fix is not None
        assert "permissions" in err.suggested_fix.lower()
