"""AIDLC rules evaluation trend reporting tool.

Usage:
    from trend_reports import collect_trend_data, render_trend_markdown
    trend = collect_trend_data(bundle_paths, baseline_path, repo, work_dir)
    markdown = render_trend_markdown(trend)

CLI:
    python -m trend_reports trend --baseline golden.yaml --format all
"""

from trend_reports.collector import (
    collect_from_directory,
    collect_trend_data,
    compute_deltas,
    sort_runs,
)
from trend_reports.gate import check_regressions
from trend_reports.models import (
    BaselineMetrics,
    GateResult,
    RunData,
    RunType,
    SemVer,
    TrendData,
    TrendReportError,
    VersionDelta,
)
from trend_reports.render_html import render_trend_html
from trend_reports.render_md import render_trend_markdown
from trend_reports.render_yaml import render_trend_yaml

__all__ = [
    "BaselineMetrics",
    "GateResult",
    "RunData",
    "RunType",
    "SemVer",
    "TrendData",
    "TrendReportError",
    "VersionDelta",
    "check_regressions",
    "collect_from_directory",
    "collect_trend_data",
    "compute_deltas",
    "render_trend_html",
    "render_trend_markdown",
    "render_trend_yaml",
    "sort_runs",
]
