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
HTMLFormatter — renders ReportData to standalone HTML using Jinja2 template.

Satisfies ReportFormatter Protocol (Pattern 5.1).
HTML autoescaping handled by shared Jinja2 Environment (BR-5.13).
"""

from pathlib import Path

from design_reviewer.foundation.exceptions import DesignReviewerError

from .models import ReportData
from .template_env import get_environment

TEMPLATE_NAME = "html_report.jinja2"


class ReportWriteError(DesignReviewerError):
    """Raised when report file writing fails."""

    def __init__(self, message: str):
        super().__init__(
            message,
            suggested_fix="Check file permissions and disk space at the output path.",
        )


class HTMLFormatter:
    """Renders ReportData to standalone HTML format and writes to file."""

    def format(self, report_data: ReportData) -> str:
        """Render report data to an HTML string."""
        env = get_environment()
        template = env.get_template(TEMPLATE_NAME)
        return template.render(  # nosemgrep: direct-use-of-jinja2 — CLI tool; HTML autoescape enabled for .html.jinja2 templates via shared environment (BR-5.13)
            metadata=report_data.metadata,
            executive_summary=report_data.executive_summary,
            critique_findings=report_data.critique_findings,
            alternative_suggestions=report_data.alternative_suggestions,
            alternatives_recommendation=report_data.alternatives_recommendation,
            gap_findings=report_data.gap_findings,
            agent_statuses=report_data.agent_statuses,
        )

    def write_to_file(self, content: str, output_path: Path) -> None:
        """Write HTML content to file with parent dir creation and verification."""
        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(content, encoding="utf-8")
            if output_path.stat().st_size == 0:
                raise ReportWriteError(f"Written file is empty: {output_path}")
        except ReportWriteError:
            raise
        except OSError as exc:
            raise ReportWriteError(
                f"Failed to write HTML report to {output_path}: {exc}"
            ) from exc
