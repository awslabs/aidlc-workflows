"""Tests for YAML data export and serialization roundtrip."""

from __future__ import annotations

import yaml
from trend_reports.models import (
    BaselineMetrics,
    CodeQualityMetrics,
    ContractTestResults,
    QualitativeComparison,
    RunConfig,
    RunData,
    RunMeta,
    RunMetrics,
    RunType,
    SemVer,
    TrendData,
    UnitTestResults,
)
from trend_reports.render_yaml import render_trend_yaml


def _make_trend() -> TrendData:
    run = RunData(
        label="v0.1.0",
        run_type=RunType.RELEASE,
        semver=SemVer(0, 1, 0),
        pr_number=None,
        meta=RunMeta(run_id="run-001", config=RunConfig(rules_ref="v0.1.0")),
        metrics=RunMetrics(total_tokens=9000000),
        unit_tests=UnitTestResults(passed=175, total=175),
        contract_tests=ContractTestResults(total=88, passed=88),
        code_quality=CodeQualityMetrics(),
        qualitative=QualitativeComparison(overall_score=0.898),
    )
    return TrendData(
        runs=[run],
        baseline=BaselineMetrics(unit_tests_passed=192, qualitative_overall=0.891),
        repo="test/repo",
        generated_at="2026-01-01T00:00:00Z",
    )


class TestRenderTrendYaml:
    def test_roundtrip(self):
        trend = _make_trend()
        yaml_str = render_trend_yaml(trend)
        parsed = yaml.safe_load(yaml_str)
        assert parsed["repo"] == "test/repo"
        assert len(parsed["runs"]) == 1
        assert parsed["runs"][0]["label"] == "v0.1.0"
        assert parsed["runs"][0]["unit_tests"]["passed"] == 175

    def test_run_type_serialized_as_value(self):
        trend = _make_trend()
        yaml_str = render_trend_yaml(trend)
        parsed = yaml.safe_load(yaml_str)
        assert parsed["runs"][0]["run_type"] == "release"

    def test_empty_runs(self):
        trend = TrendData(
            runs=[],
            baseline=BaselineMetrics(),
            repo="test/repo",
            generated_at="2026-01-01T00:00:00Z",
        )
        yaml_str = render_trend_yaml(trend)
        parsed = yaml.safe_load(yaml_str)
        assert parsed["runs"] == []

    def test_output_is_string(self):
        trend = _make_trend()
        result = render_trend_yaml(trend)
        assert isinstance(result, str)
