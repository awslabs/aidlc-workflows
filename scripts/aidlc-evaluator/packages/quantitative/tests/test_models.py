"""Tests for quantitative data models."""

from quantitative.models import LintFinding, QualityReport, SecurityFinding, ToolResult


def test_compute_summary_lint_only():
    report = QualityReport(
        project_type="python",
        project_root=".",
        lint=ToolResult(
            tool="ruff", version="0.8.0", available=True, exit_code=1,
            findings=[
                LintFinding("a.py", 1, 1, "E501", "line too long", "error"),
                LintFinding("b.py", 2, 1, "W291", "trailing whitespace", "warning"),
                LintFinding("c.py", 3, 1, "E302", "expected 2 blank lines", "error"),
            ],
        ),
    )
    report.compute_summary()
    assert report.summary["lint_total"] == 3
    assert report.summary["lint_errors"] == 2
    assert report.summary["lint_warnings"] == 1


def test_compute_summary_security_only():
    report = QualityReport(
        project_type="python",
        project_root=".",
        security=ToolResult(
            tool="bandit", version="1.7.0", available=True, exit_code=1,
            findings=[
                SecurityFinding("s.py", 10, "B101", "assert used", "low", "high"),
                SecurityFinding("s.py", 20, "B608", "SQL injection", "high", "medium"),
            ],
        ),
    )
    report.compute_summary()
    assert report.summary["security_total"] == 2
    assert report.summary["security_high"] == 1
    assert report.summary["security_low"] == 1


def test_compute_summary_both():
    report = QualityReport(
        project_type="python",
        project_root=".",
        lint=ToolResult(tool="ruff", version="0.8.0", available=True, exit_code=0, findings=[]),
        security=ToolResult(tool="bandit", version="1.7.0", available=True, exit_code=0, findings=[]),
    )
    report.compute_summary()
    assert report.summary["lint_total"] == 0
    assert report.summary["lint_errors"] == 0
    assert report.summary["security_total"] == 0
    assert report.summary["security_high"] == 0


def test_compute_summary_unavailable_tool():
    report = QualityReport(
        project_type="python",
        project_root=".",
        lint=ToolResult(tool="ruff", version=None, available=False, error="not found"),
    )
    report.compute_summary()
    assert "lint_total" not in report.summary
