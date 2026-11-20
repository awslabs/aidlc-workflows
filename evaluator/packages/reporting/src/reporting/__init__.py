"""Consolidated report generation aggregating all evaluation dimensions.

Usage:
    from reporting import collect, write_markdown, write_html
    data = collect(Path("runs/20260218T.../"))
    write_markdown(data, Path("runs/.../report.md"))
    write_html(data, Path("runs/.../report.html"))

CLI:
    python -m reporting generate <run-folder> [--format markdown|html|both]
"""

from reporting.baseline import (
    BaselineMetrics,
    ComparisonResult,
    compare,
    compare_run_to_baseline,
    extract_baseline,
    load_baseline,
    promote,
    write_baseline,
)
from reporting.collector import ReportData, collect
from reporting.render_html import render_html, write_html
from reporting.render_md import render_markdown, write_markdown

__all__ = [
    "BaselineMetrics",
    "ComparisonResult",
    "ReportData",
    "collect",
    "compare",
    "compare_run_to_baseline",
    "extract_baseline",
    "load_baseline",
    "promote",
    "render_html",
    "render_markdown",
    "write_baseline",
    "write_html",
    "write_markdown",
]
