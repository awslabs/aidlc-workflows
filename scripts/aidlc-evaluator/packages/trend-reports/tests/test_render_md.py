"""Tests for Markdown trend report rendering.

Smoke tests verify sections are present and the renderer does not crash on
various inputs. Does not validate exact Markdown formatting.
"""

from __future__ import annotations

from conftest import make_run
from trend_reports.models import (
    BaselineMetrics,
    TrendData,
)
from trend_reports.render_md import render_trend_markdown


def _make_trend(*labels: str) -> TrendData:
    runs = [
        make_run(label, qualitative_score=0.85 + i * 0.02)
        for i, label in enumerate(labels)
    ]
    return TrendData(
        runs=runs,
        baseline=BaselineMetrics(
            unit_tests_passed=192,
            qualitative_overall=0.891,
            total_tokens=9840000,
            execution_time_seconds=1446.0,
        ),
        repo="test/repo",
        generated_at="2026-01-01T00:00:00Z",
    )


class TestRenderTrendMarkdown:
    def test_output_is_string(self):
        trend = _make_trend("v0.1.0", "v0.1.1")
        result = render_trend_markdown(trend)
        assert isinstance(result, str)

    def test_contains_all_sections(self):
        trend = _make_trend("v0.1.0", "v0.1.1", "v0.1.2")
        result = render_trend_markdown(trend)
        for section in [
            "## A. Executive Summary",
            "## B. Functional Correctness",
            "## C. Qualitative Evaluation",
            "## D. Efficiency & Cost Metrics",
            "## E. Code Quality",
            "## F. Stability",
            "## G. Version-over-Version Deltas",
            "## H. Pre-Release",
        ]:
            assert section in result, f"Missing {section}"

    def test_contains_version_labels(self):
        trend = _make_trend("v0.1.0", "v0.1.1")
        result = render_trend_markdown(trend)
        assert "v0.1.0" in result
        assert "v0.1.1" in result

    def test_empty_runs_no_crash(self):
        trend = TrendData(
            runs=[],
            baseline=BaselineMetrics(),
            repo="test/repo",
            generated_at="2026-01-01T00:00:00Z",
        )
        result = render_trend_markdown(trend)
        assert isinstance(result, str)

    def test_single_run(self):
        trend = _make_trend("v0.1.0")
        result = render_trend_markdown(trend)
        assert "v0.1.0" in result
