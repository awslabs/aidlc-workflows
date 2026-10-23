"""Code evaluation — linting, security scanning, and code organization analysis.

Usage:
    from quantitative import scan_workspace, write_report
    report = scan_workspace(Path("runs/.../workspace"))
    write_report(report, Path("quality-report.yaml"))

CLI:
    python -m quantitative analyze <workspace> [-o quality-report.yaml]
"""

from quantitative.models import LintFinding, QualityReport, SecurityFinding, ToolResult
from quantitative.scanner import print_report, scan_workspace, write_report

__all__ = [
    "LintFinding",
    "QualityReport",
    "SecurityFinding",
    "ToolResult",
    "print_report",
    "scan_workspace",
    "write_report",
]
