"""Tests for zip extraction, YAML parsing, run classification, and trend assembly.

Tests use tmp_path and real YAML files to avoid excessive mocking.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest
import yaml
from conftest import make_run
from trend_reports.collector import (
    classify_run,
    collect_from_zip,
    compute_deltas,
    extract_zip,
    find_yaml_files,
    load_baseline,
    parse_contract_tests,
    parse_qualitative,
    parse_quality_report,
    parse_run_meta,
    parse_run_metrics,
    parse_test_results,
    sort_runs,
)
from trend_reports.models import (
    CollectorError,
    RunType,
    SemVer,
)


def _write_yaml(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        yaml.safe_dump(data, f, default_flow_style=False)


def _make_report_zip(tmp_path: Path, yaml_files: dict[str, dict]) -> Path:
    """Create a report zip with YAML file contents."""
    zip_path = tmp_path / "report.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        for filename, data in yaml_files.items():
            zf.writestr(filename, yaml.safe_dump(data))
    return zip_path


# ---------------------------------------------------------------------------
# Zip handling
# ---------------------------------------------------------------------------


class TestExtractZip:
    def test_normal_extraction(self, tmp_path):
        zip_path = tmp_path / "test.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("hello.txt", "world")

        result = extract_zip(zip_path, tmp_path)
        assert result.exists()
        assert (result / "hello.txt").read_text() == "world"

    def test_corrupt_zip_raises(self, tmp_path):
        bad_zip = tmp_path / "bad.zip"
        bad_zip.write_bytes(b"not a zip")
        with pytest.raises(CollectorError, match="Corrupt zip"):
            extract_zip(bad_zip, tmp_path)


class TestFindYamlFiles:
    def test_all_present(self, tmp_path):
        for name in [
            "run-meta.yaml",
            "run-metrics.yaml",
            "test-results.yaml",
            "contract-test-results.yaml",
            "quality-report.yaml",
            "qualitative-comparison.yaml",
        ]:
            (tmp_path / name).write_text("key: value")
        result = find_yaml_files(tmp_path)
        assert len(result) == 6

    def test_none_present(self, tmp_path):
        result = find_yaml_files(tmp_path)
        assert len(result) == 0

    def test_partial(self, tmp_path):
        (tmp_path / "run-meta.yaml").write_text("key: value")
        result = find_yaml_files(tmp_path)
        assert len(result) == 1
        assert "run-meta" in result


# ---------------------------------------------------------------------------
# YAML parsers
# ---------------------------------------------------------------------------


class TestParseRunMeta:
    def test_normal(self, tmp_path):
        path = tmp_path / "run-meta.yaml"
        _write_yaml(
            path,
            {
                "run_folder": "run-001",
                "config": {"rules_ref": "v0.1.5", "executor_model": "claude-3"},
                "vision_file": "test_cases/sci-calc/vision.md",
                "started_at": "2026-01-01T00:00:00Z",
                "completed_at": "2026-01-01T01:00:00Z",
                "status": "completed",
            },
        )
        meta = parse_run_meta(path)
        assert meta.run_id == "run-001"
        assert meta.config.rules_ref == "v0.1.5"
        assert meta.config.model == "claude-3"
        assert meta.config.target_project == "sci-calc"

    def test_missing_config(self, tmp_path):
        path = tmp_path / "run-meta.yaml"
        _write_yaml(path, {"run_folder": "run-002"})
        meta = parse_run_meta(path)
        assert meta.config.rules_ref == ""
        assert meta.config.model == ""


class TestParseRunMetrics:
    def test_normal(self, tmp_path):
        path = tmp_path / "run-metrics.yaml"
        _write_yaml(
            path,
            {
                "tokens": {
                    "total": {"total_tokens": 9000000, "input_tokens": 5000000},
                    "per_agent": {
                        "executor": {"total_tokens": 8000000, "input_tokens": 4000000},
                    },
                },
                "timing": {
                    "total_wall_clock_ms": 600000,
                    "handoffs": [
                        {"handoff": 1, "node_id": "executor", "duration_ms": 300000},
                    ],
                },
                "errors": {"throttle_events": 0, "timeout_events": 0},
                "context_size": {"total": {"max_tokens": 100000}},
            },
        )
        metrics = parse_run_metrics(path)
        assert metrics.total_tokens == 9000000
        assert metrics.execution_time_seconds == 600.0
        assert len(metrics.agent_tokens) == 1
        assert len(metrics.handoffs) == 1
        assert metrics.max_context_tokens == 100000

    def test_empty(self, tmp_path):
        path = tmp_path / "run-metrics.yaml"
        _write_yaml(path, {})
        metrics = parse_run_metrics(path)
        assert metrics.total_tokens == 0
        assert metrics.execution_time_seconds == 0.0


class TestParseTestResults:
    def test_normal(self, tmp_path):
        path = tmp_path / "test-results.yaml"
        _write_yaml(
            path,
            {
                "test": {"parsed_results": {"passed": 175, "failed": 0, "total": 175}},
            },
        )
        result = parse_test_results(path)
        assert result.passed == 175
        assert result.failed == 0
        assert result.total == 175

    def test_none_values(self, tmp_path):
        path = tmp_path / "test-results.yaml"
        _write_yaml(
            path,
            {
                "test": {"parsed_results": {"passed": None, "failed": None}},
            },
        )
        result = parse_test_results(path)
        assert result.passed == 0
        assert result.failed == 0


class TestParseContractTests:
    def test_normal(self, tmp_path):
        path = tmp_path / "contract-test-results.yaml"
        _write_yaml(
            path,
            {
                "total": 88,
                "passed": 85,
                "failed": 3,
                "cases": [
                    {"path": "/api/calc", "method": "GET", "passed": True},
                    {
                        "path": "/api/err",
                        "method": "POST",
                        "passed": False,
                        "expected_status": 400,
                        "actual_status": 200,
                    },
                ],
            },
        )
        result = parse_contract_tests(path)
        assert result.total == 88
        assert result.passed == 85
        assert len(result.failures) == 1
        assert result.failures[0].endpoint == "/api/err"

    def test_zero_total(self, tmp_path):
        path = tmp_path / "contract-test-results.yaml"
        _write_yaml(path, {"total": 0, "passed": 0, "failed": 0})
        result = parse_contract_tests(path)
        assert result.pass_rate == 0.0


class TestParseQualityReport:
    def test_with_security(self, tmp_path):
        path = tmp_path / "quality-report.yaml"
        _write_yaml(
            path,
            {
                "lint": {"findings": [{"file": "a.py"}]},
                "security": {"available": True, "findings": [{"issue": "x"}]},
                "summary": {"lint_total": 1},
            },
        )
        result = parse_quality_report(path)
        assert result.lint_findings == 1
        assert result.security_findings == 1
        assert result.security_scanner_available is True

    def test_without_security(self, tmp_path):
        path = tmp_path / "quality-report.yaml"
        _write_yaml(path, {"lint": {}, "summary": {}})
        result = parse_quality_report(path)
        assert result.security_findings == -1
        assert result.security_scanner_available is False


class TestParseQualitative:
    def test_normal(self, tmp_path):
        path = tmp_path / "qualitative-comparison.yaml"
        _write_yaml(
            path,
            {
                "overall_score": 0.898,
                "phases": [
                    {
                        "phase": "inception",
                        "avg_overall": 0.87,
                        "documents": [
                            {"path": "docs/requirements.md", "overall": 0.95},
                        ],
                    },
                    {
                        "phase": "construction",
                        "avg_overall": 0.92,
                        "documents": [
                            {"path": "docs/build-instructions.md", "overall": 0.90},
                        ],
                    },
                ],
            },
        )
        result = parse_qualitative(path)
        assert result.overall_score == 0.898
        assert result.inception_score == 0.87
        assert result.construction_score == 0.92
        assert len(result.document_scores) == 2

    def test_empty_phases(self, tmp_path):
        path = tmp_path / "qualitative-comparison.yaml"
        _write_yaml(path, {"overall_score": 0.5, "phases": []})
        result = parse_qualitative(path)
        assert result.inception_score == 0.0
        assert result.construction_score == 0.0
        assert result.document_scores == []


# ---------------------------------------------------------------------------
# Run classification
# ---------------------------------------------------------------------------


class TestClassifyRun:
    def test_release(self):
        run_type, label, semver, pr = classify_run("v0.1.5")
        assert run_type == RunType.RELEASE
        assert label == "v0.1.5"
        assert semver == SemVer(0, 1, 5)
        assert pr is None

    def test_main(self):
        run_type, label, semver, pr = classify_run("main")
        assert run_type == RunType.MAIN
        assert label == "main"
        assert semver is None

    def test_pr(self):
        run_type, label, semver, pr = classify_run("pr-42")
        assert run_type == RunType.PR
        assert label == "PR #42"
        assert pr == 42

    def test_unknown_format(self):
        run_type, label, semver, pr = classify_run("some-branch")
        assert run_type == RunType.RELEASE
        assert label == "some-branch"
        assert semver is None


# ---------------------------------------------------------------------------
# Sorting and deltas
# ---------------------------------------------------------------------------


class TestSortRuns:
    def test_releases_sorted_by_semver(self):
        runs = [
            make_run("v0.1.2"),
            make_run("v0.1.0"),
            make_run("v0.1.1"),
        ]
        sorted_runs = sort_runs(runs)
        assert [r.label for r in sorted_runs] == ["v0.1.0", "v0.1.1", "v0.1.2"]

    def test_main_after_releases(self):
        runs = [
            make_run("main", run_type=RunType.MAIN, semver=None),
            make_run("v0.1.0"),
        ]
        sorted_runs = sort_runs(runs)
        assert sorted_runs[0].label == "v0.1.0"
        assert sorted_runs[1].label == "main"

    def test_pr_after_main(self):
        runs = [
            make_run("PR #42", run_type=RunType.PR, semver=None, pr_number=42),
            make_run("main", run_type=RunType.MAIN, semver=None),
            make_run("v0.1.0"),
        ]
        sorted_runs = sort_runs(runs)
        assert [r.label for r in sorted_runs] == ["v0.1.0", "main", "PR #42"]

    def test_empty_list(self):
        assert sort_runs([]) == []


class TestComputeDeltas:
    def test_two_runs(self):
        runs = [
            make_run("v0.1.0", passed=100, qualitative_score=0.85, total_tokens=1000000),
            make_run("v0.1.1", passed=120, qualitative_score=0.90, total_tokens=1200000),
        ]
        deltas = compute_deltas(runs)
        assert len(deltas) == 1
        assert deltas[0].from_label == "v0.1.0"
        assert deltas[0].to_label == "v0.1.1"
        assert deltas[0].unit_tests_delta == 20
        assert abs(deltas[0].qualitative_delta - 0.05) < 0.001
        assert deltas[0].token_delta == 200000

    def test_empty_list(self):
        assert compute_deltas([]) == []

    def test_single_run(self):
        assert compute_deltas([make_run("v0.1.0")]) == []


# ---------------------------------------------------------------------------
# Baseline loading
# ---------------------------------------------------------------------------


class TestLoadBaseline:
    def test_file_exists(self, tmp_path):
        path = tmp_path / "golden.yaml"
        _write_yaml(
            path,
            {
                "execution": {"wall_clock_ms": 1200000, "total_tokens": 9000000},
                "unit_tests": {"passed": 192, "total": 192},
                "contract_tests": {"passed": 88, "total": 88},
                "code_quality": {"lint_total": 18},
                "qualitative": {
                    "overall_score": 0.891,
                    "document_scores": {"requirements.md": 0.97, "components.md": 0.98},
                },
            },
        )
        bl = load_baseline(path)
        assert bl.unit_tests_passed == 192
        assert bl.qualitative_overall == 0.891
        assert bl.execution_time_seconds == 1200.0
        assert bl.document_scores["requirements.md"] == 0.97

    def test_file_missing(self, tmp_path):
        bl = load_baseline(tmp_path / "nonexistent.yaml")
        assert bl.unit_tests_passed == 0
        assert bl.qualitative_overall == 0.0


# ---------------------------------------------------------------------------
# collect_from_zip
# ---------------------------------------------------------------------------


class TestCollectFromZip:
    def test_full_zip(self, tmp_path):
        zip_path = _make_report_zip(
            tmp_path,
            {
                "run-meta.yaml": {
                    "run_folder": "run-001",
                    "config": {"rules_ref": "v0.1.5"},
                },
                "run-metrics.yaml": {
                    "tokens": {"total": {"total_tokens": 9000000}},
                    "timing": {"total_wall_clock_ms": 600000},
                },
                "test-results.yaml": {
                    "test": {"parsed_results": {"passed": 175, "failed": 0, "total": 175}},
                },
                "contract-test-results.yaml": {"total": 88, "passed": 88, "failed": 0},
                "quality-report.yaml": {"lint": {}, "summary": {"lint_total": 0}},
                "qualitative-comparison.yaml": {"overall_score": 0.898, "phases": []},
            },
        )
        run = collect_from_zip(zip_path, tmp_path / "work")
        assert run.label == "v0.1.5"
        assert run.run_type == RunType.RELEASE
        assert run.unit_tests.passed == 175
        assert run.qualitative.overall_score == 0.898

    def test_missing_run_meta_raises(self, tmp_path):
        zip_path = _make_report_zip(
            tmp_path,
            {
                "test-results.yaml": {"test": {"parsed_results": {}}},
            },
        )
        with pytest.raises(CollectorError, match="run-meta.yaml missing"):
            collect_from_zip(zip_path, tmp_path / "work")

    def test_missing_optional_files_use_defaults(self, tmp_path):
        zip_path = _make_report_zip(
            tmp_path,
            {
                "run-meta.yaml": {
                    "run_folder": "run-002",
                    "config": {"rules_ref": "v0.1.0"},
                },
            },
        )
        run = collect_from_zip(zip_path, tmp_path / "work")
        assert run.unit_tests.passed == 0
        assert run.contract_tests.total == 0
        assert run.qualitative.overall_score == 0.0
