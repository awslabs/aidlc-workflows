"""Tests for data models, enums, exceptions, and SemVer parsing."""

from __future__ import annotations

import pytest
from trend_reports.models import (
    BaselineMetrics,
    CollectorError,
    FetchError,
    GateResult,
    RunType,
    SemVer,
    TrendReportError,
)


class TestSemVer:
    def test_parse_with_v_prefix(self):
        sv = SemVer.parse("v1.2.3")
        assert sv == SemVer(1, 2, 3)

    def test_parse_without_v_prefix(self):
        sv = SemVer.parse("0.1.5")
        assert sv == SemVer(0, 1, 5)

    def test_parse_large_numbers(self):
        sv = SemVer.parse("v999.888.777")
        assert sv == SemVer(999, 888, 777)

    def test_parse_invalid_empty(self):
        with pytest.raises(ValueError, match="Cannot parse semver"):
            SemVer.parse("")

    def test_parse_invalid_text(self):
        with pytest.raises(ValueError, match="Cannot parse semver"):
            SemVer.parse("abc")

    def test_parse_invalid_two_parts(self):
        with pytest.raises(ValueError, match="Cannot parse semver"):
            SemVer.parse("1.2")

    def test_str(self):
        assert str(SemVer(0, 1, 5)) == "v0.1.5"

    def test_ordering(self):
        assert SemVer(0, 1, 0) < SemVer(0, 2, 0)
        assert SemVer(0, 1, 5) < SemVer(0, 1, 6)
        assert SemVer(0, 1, 9) < SemVer(1, 0, 0)

    def test_equality(self):
        assert SemVer(1, 2, 3) == SemVer(1, 2, 3)

    def test_frozen(self):
        sv = SemVer(1, 2, 3)
        with pytest.raises(AttributeError):
            sv.major = 5  # type: ignore[misc]


class TestRunType:
    def test_values(self):
        assert RunType.RELEASE.value == "release"
        assert RunType.MAIN.value == "main"
        assert RunType.PR.value == "pr"


class TestExceptions:
    def test_fetch_error_is_trend_report_error(self):
        assert issubclass(FetchError, TrendReportError)

    def test_collector_error_is_trend_report_error(self):
        assert issubclass(CollectorError, TrendReportError)


class TestDataclassDefaults:
    def test_baseline_metrics_defaults(self):
        bl = BaselineMetrics()
        assert bl.unit_tests_passed == 0
        assert bl.qualitative_overall == 0.0
        assert bl.document_scores == {}

    def test_gate_result_defaults(self):
        gr = GateResult(passed=True)
        assert gr.regressions == []
        assert gr.latest_label == ""
