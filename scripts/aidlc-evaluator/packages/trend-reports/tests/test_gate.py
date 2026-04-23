"""Tests for CI regression gate logic."""

from __future__ import annotations

from conftest import make_run, make_trend
from trend_reports.gate import check_regressions, find_latest_and_previous
from trend_reports.models import InfraFailure, InfraFailureReason, RunType


class TestCheckRegressions:
    def test_no_regressions_passes(self):
        r1 = make_run("v0.1.0", qualitative_score=0.85)
        r2 = make_run("v0.1.1", qualitative_score=0.90)
        result = check_regressions(make_trend(r1, r2))
        assert result.passed is True
        assert result.regressions == []

    def test_contract_test_regression(self):
        r1 = make_run("v0.1.0", contract_passed=88, contract_total=88)
        r2 = make_run("v0.1.1", contract_passed=85, contract_total=88)
        result = check_regressions(make_trend(r1, r2))
        assert result.passed is False
        assert any("contract" in r.lower() for r in result.regressions)

    def test_unit_test_failures_regression(self):
        r1 = make_run("v0.1.0", passed=100, failed=0)
        r2 = make_run("v0.1.1", passed=95, failed=5)
        result = check_regressions(make_trend(r1, r2))
        assert result.passed is False
        assert any("unit" in r.lower() or "test" in r.lower() for r in result.regressions)

    def test_qualitative_regression(self):
        r1 = make_run("v0.1.0", qualitative_score=0.90)
        r2 = make_run("v0.1.1", qualitative_score=0.85)
        result = check_regressions(make_trend(r1, r2))
        assert result.passed is False
        assert any("qualitative" in r.lower() for r in result.regressions)

    def test_small_qualitative_drop_not_regression(self):
        r1 = make_run("v0.1.0", qualitative_score=0.90)
        r2 = make_run("v0.1.1", qualitative_score=0.885)
        result = check_regressions(make_trend(r1, r2))
        assert result.passed is True

    def test_fewer_than_two_runs_passes(self):
        r1 = make_run("v0.1.0")
        result = check_regressions(make_trend(r1))
        assert result.passed is True

    def test_empty_runs_passes(self):
        result = check_regressions(make_trend())
        assert result.passed is True

    def test_labels_set(self):
        r1 = make_run("v0.1.0")
        r2 = make_run("v0.1.1")
        result = check_regressions(make_trend(r1, r2))
        assert result.latest_label == "v0.1.1"
        assert result.comparison_label == "v0.1.0"


class TestFindLatestAndPrevious:
    def test_empty_runs(self):
        trend = make_trend()
        latest, prev = find_latest_and_previous(trend)
        assert latest is None
        assert prev is None

    def test_single_run(self):
        r1 = make_run("v0.1.0")
        latest, prev = find_latest_and_previous(make_trend(r1))
        assert latest is r1
        assert prev is None

    def test_two_releases(self):
        r1 = make_run("v0.1.0")
        r2 = make_run("v0.1.1")
        latest, prev = find_latest_and_previous(make_trend(r1, r2))
        assert latest is r2
        assert prev is r1

    def test_latest_is_main(self):
        r1 = make_run("v0.1.0")
        r2 = make_run("v0.1.1")
        r_main = make_run("main", run_type=RunType.MAIN, semver=None)
        latest, prev = find_latest_and_previous(make_trend(r1, r2, r_main))
        assert latest is r_main
        assert prev is r2

    def test_latest_is_pr(self):
        r1 = make_run("v0.1.0")
        r_pr = make_run("PR #42", run_type=RunType.PR, semver=None, pr_number=42)
        latest, prev = find_latest_and_previous(make_trend(r1, r_pr))
        assert latest is r_pr
        assert prev is r1


class TestCheckRegressionsInfraFailure:
    def test_latest_infra_failure_skips_regression(self):
        """If latest run is an infra failure, gate passes with annotation."""
        r1 = make_run("v0.1.0", qualitative_score=0.90)
        r2 = make_run(
            "v0.1.1",
            qualitative_score=0.0,
            contract_passed=0,
            contract_total=88,
            infra_failure=InfraFailure(
                is_infra_failure=True,
                reasons=[InfraFailureReason.THROTTLED],
                summary="Infrastructure failure detected: bedrock_throttled",
            ),
        )
        result = check_regressions(make_trend(r1, r2))
        assert result.passed is True
        assert result.infra_failure_detected is True
        assert result.regressions == []
        assert "infrastructure" in result.infra_failure_summary.lower()

    def test_previous_infra_failure_finds_older_comparison(self):
        """If comparison run is infra failure, gate should find an older non-infra run."""
        r1 = make_run("v0.1.0", qualitative_score=0.90)
        r2 = make_run(
            "v0.1.1",
            qualitative_score=0.0,
            infra_failure=InfraFailure(
                is_infra_failure=True,
                reasons=[InfraFailureReason.SERVICE_UNAVAILABLE],
                summary="test",
            ),
        )
        r3 = make_run("v0.1.2", qualitative_score=0.91)
        result = check_regressions(make_trend(r1, r2, r3))
        assert result.passed is True
        assert result.comparison_label == "v0.1.0"

    def test_non_infra_failure_still_detects_regression(self):
        """Normal runs should still trigger regressions as before."""
        r1 = make_run("v0.1.0", qualitative_score=0.90)
        r2 = make_run("v0.1.1", qualitative_score=0.85)
        result = check_regressions(make_trend(r1, r2))
        assert result.passed is False
        assert result.infra_failure_detected is False

    def test_all_runs_infra_failure_gate_passes(self):
        """If all comparison candidates are infra failures, gate passes with annotation."""
        infra = InfraFailure(
            is_infra_failure=True,
            reasons=[InfraFailureReason.THROTTLED],
            summary="test",
        )
        r1 = make_run("v0.1.0", infra_failure=infra)
        r2 = make_run("v0.1.1", qualitative_score=0.90)
        result = check_regressions(make_trend(r1, r2))
        # Latest is not infra, but comparison is; should skip with annotation
        assert result.passed is True
        assert result.infra_failure_detected is True
