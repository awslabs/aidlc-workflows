"""Tests for HTML trend report rendering.

Smoke tests verify the output is valid HTML with expected sections.
"""

from __future__ import annotations

from conftest import make_run
from trend_reports.models import (
    BaselineMetrics,
    TrendData,
)
from trend_reports.render_html import render_trend_html


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


class TestRenderTrendHtml:
    def test_output_is_html(self):
        trend = _make_trend("v0.1.0", "v0.1.1")
        result = render_trend_html(trend)
        assert "<html" in result
        assert "</html>" in result

    def test_contains_section_anchors(self):
        trend = _make_trend("v0.1.0", "v0.1.1", "v0.1.2")
        result = render_trend_html(trend)
        for section_id in [
            "a-executive-summary",
            "b-functional-correctness",
            "c-qualitative-evaluation",
            "d-efficiency-cost-metrics",
            "e-code-quality",
            "f-stability-reliability",
            "g-version-over-version-deltas",
            "h-pre-release-data-points",
        ]:
            assert section_id in result, f"Missing anchor {section_id}"

    def test_contains_version_labels(self):
        trend = _make_trend("v0.1.0", "v0.1.1")
        result = render_trend_html(trend)
        assert "v0.1.0" in result
        assert "v0.1.1" in result

    def test_empty_runs_no_crash(self):
        trend = TrendData(
            runs=[],
            baseline=BaselineMetrics(),
            repo="test/repo",
            generated_at="2026-01-01T00:00:00Z",
        )
        result = render_trend_html(trend)
        assert "<html" in result

    def test_self_contained(self):
        """Output should have embedded CSS, no external references."""
        trend = _make_trend("v0.1.0")
        result = render_trend_html(trend)
        assert "<style>" in result
