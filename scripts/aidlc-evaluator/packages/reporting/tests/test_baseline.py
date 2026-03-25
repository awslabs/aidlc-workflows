"""Tests for reporting.baseline — promote, compare, and golden.yaml roundtrip."""

from pathlib import Path

import yaml

from reporting.baseline import (
    BaselineMetrics,
    ComparisonResult,
    compare,
    extract_baseline,
    load_baseline,
    promote,
    write_baseline,
)
from reporting.collector import (
    Artifacts,
    ContractResults,
    QualitativeResults,
    QualityReport,
    ReportData,
    RunMeta,
    RunMetrics,
    PhaseScore,
    TokenUsage,
)


def _make_report_data() -> ReportData:
    from reporting.collector import TestResults as TR
    return ReportData(
        meta=RunMeta(
            run_folder="runs/test-run-001",
            executor_model="claude-opus",
            simulator_model="claude-sonnet",
            total_handoffs=3,
        ),
        metrics=RunMetrics(
            total_tokens=TokenUsage(1000000, 50000, 1050000),
            wall_clock_ms=600000,
            artifacts=Artifacts(
                source_files=10, test_files=5, total_files=20,
                total_lines_of_code=2000, total_doc_files=12,
            ),
        ),
        tests=TR(
            status="completed", install_ok=True, test_ok=True,
            passed=100, failed=2, total=102, coverage_pct=88.5,
        ),
        contracts=ContractResults(total=50, passed=48, failed=2),
        quality=QualityReport(lint_errors=3, lint_warnings=7, lint_total=10),
        qualitative=QualitativeResults(
            overall_score=0.85,
            phases=[
                PhaseScore("inception", avg_overall=0.88),
                PhaseScore("construction", avg_overall=0.82),
            ],
        ),
    )


class TestExtractBaseline:
    def test_extracts_all_fields(self):
        data = _make_report_data()
        b = extract_baseline(data)
        assert b.run_folder == "runs/test-run-001"
        assert b.tests_passed == 100
        assert b.tests_failed == 2
        assert b.contract_passed == 48
        assert b.lint_errors == 3
        assert b.qualitative_score == 0.85
        assert b.inception_score == 0.88
        assert b.construction_score == 0.82
        assert b.lines_of_code == 2000
        assert b.total_tokens == 1050000

    def test_handles_missing_sections(self):
        data = ReportData(meta=RunMeta(run_folder="runs/empty"))
        b = extract_baseline(data)
        assert b.tests_passed == 0
        assert b.contract_passed == 0
        assert b.qualitative_score == 0.0


class TestWriteAndLoad:
    def test_roundtrip(self, tmp_path):
        b = BaselineMetrics(
            run_folder="runs/golden-run",
            promoted_at="2026-02-18T12:00:00+00:00",
            executor_model="claude-opus",
            tests_passed=192, tests_total=192,
            contract_passed=88, contract_total=88,
            lint_errors=5, lint_warnings=13, lint_total=18,
            qualitative_score=0.891,
            inception_score=0.89,
            construction_score=0.892,
            lines_of_code=3522,
            total_tokens=9835935,
        )
        path = tmp_path / "golden.yaml"
        write_baseline(b, path)

        loaded = load_baseline(path)
        assert loaded.run_folder == "runs/golden-run"
        assert loaded.tests_passed == 192
        assert loaded.contract_passed == 88
        assert loaded.lint_errors == 5
        assert loaded.qualitative_score == 0.891
        assert loaded.inception_score == 0.89
        assert loaded.lines_of_code == 3522
        assert loaded.total_tokens == 9835935

    def test_yaml_is_readable(self, tmp_path):
        b = BaselineMetrics(run_folder="runs/test", tests_passed=10, tests_total=10)
        path = tmp_path / "golden.yaml"
        write_baseline(b, path)

        with open(path) as f:
            raw = yaml.safe_load(f)
        assert raw["unit_tests"]["passed"] == 10
        assert "qualitative" in raw


class TestCompare:
    def test_identical_runs(self):
        a = BaselineMetrics(
            tests_passed=100, tests_total=100,
            contract_passed=50, contract_total=50,
            lint_errors=0, qualitative_score=0.9,
        )
        result = compare(a, a)
        assert result.improved == 0
        assert result.regressed == 0
        assert result.unchanged == 31  # 29 + 2 new token metrics (repeated_context, api_total)

    def test_improved_tests(self):
        golden = BaselineMetrics(tests_passed=90, tests_total=100, tests_pass_pct=90.0)
        current = BaselineMetrics(tests_passed=95, tests_total=100, tests_pass_pct=95.0)
        result = compare(current, golden)
        improved = [d for d in result.deltas if d.name == "Tests Pass %"]
        assert len(improved) == 1
        assert improved[0].direction == "improved"
        assert improved[0].delta == 5.0

    def test_regressed_quality(self):
        golden = BaselineMetrics(qualitative_score=0.9)
        current = BaselineMetrics(qualitative_score=0.7)
        result = compare(current, golden)
        qual = [d for d in result.deltas if d.name == "Qualitative Score"]
        assert len(qual) == 1
        assert qual[0].direction == "regressed"
        assert result.regressed >= 1

    def test_fewer_lint_errors_is_improvement(self):
        golden = BaselineMetrics(lint_errors=10)
        current = BaselineMetrics(lint_errors=3)
        result = compare(current, golden)
        lint = [d for d in result.deltas if d.name == "Lint Errors"]
        assert lint[0].direction == "improved"

    def test_more_lint_errors_is_regression(self):
        golden = BaselineMetrics(lint_errors=3)
        current = BaselineMetrics(lint_errors=10)
        result = compare(current, golden)
        lint = [d for d in result.deltas if d.name == "Lint Errors"]
        assert lint[0].direction == "regressed"

    def test_fewer_tokens_is_improvement(self):
        golden = BaselineMetrics(total_tokens=10000000)
        current = BaselineMetrics(total_tokens=8000000)
        result = compare(current, golden)
        tok = [d for d in result.deltas if d.name == "Total Tokens"]
        assert tok[0].direction == "improved"

    def test_mixed_results(self):
        golden = BaselineMetrics(
            tests_passed=100, tests_total=100,
            lint_errors=5, qualitative_score=0.85,
        )
        current = BaselineMetrics(
            tests_passed=105, tests_total=105,
            lint_errors=10, qualitative_score=0.90,
        )
        result = compare(current, golden)
        assert result.improved > 0
        assert result.regressed > 0


class TestPromote:
    def test_promote_creates_file(self, tmp_path):
        run = tmp_path / "run-001"
        run.mkdir()
        (run / "run-meta.yaml").write_text(yaml.safe_dump({
            "run_folder": str(run), "status": "COMPLETED",
            "config": {"executor_model": "opus"},
        }))

        golden_path = tmp_path / "golden.yaml"
        baseline = promote(run, golden_path)
        assert golden_path.exists()
        assert baseline.executor_model == "opus"

        loaded = load_baseline(golden_path)
        assert loaded.executor_model == "opus"


class TestReportIntegration:
    def test_markdown_includes_comparison(self):
        from reporting.render_md import render_markdown
        data = _make_report_data()
        golden = BaselineMetrics(
            tests_passed=90, tests_total=100,
            lint_errors=5, qualitative_score=0.80,
        )
        current = extract_baseline(data)
        data.comparison = compare(current, golden)

        md = render_markdown(data)
        assert "Baseline Comparison" in md
        assert "Improved" in md
        assert "Regressed" in md

    def test_html_includes_comparison(self):
        from reporting.render_html import render_html
        data = _make_report_data()
        golden = BaselineMetrics(
            tests_passed=90, tests_total=100,
            lint_errors=5, qualitative_score=0.80,
        )
        current = extract_baseline(data)
        data.comparison = compare(current, golden)

        html = render_html(data)
        assert "Baseline Comparison" in html
        assert "delta-improved" in html
        assert "delta-regressed" in html

    def test_no_comparison_when_absent(self):
        from reporting.render_md import render_markdown
        data = _make_report_data()
        md = render_markdown(data)
        assert "Baseline Comparison" not in md


class TestRealBaseline:
    def test_load_real_golden(self):
        path = Path(__file__).resolve().parents[3] / "test_cases" / "sci-calc" / "golden.yaml"
        if not path.exists():
            return
        b = load_baseline(path)
        assert b.tests_passed == 180
        assert b.contract_passed == 88
        assert b.qualitative_score == 0.8544
