"""Tests for both Markdown and HTML renderers."""

from pathlib import Path

from reporting.collector import (
    Artifacts,
    ContractCase,
    ContractResults,
    DocScore,
    HandoffTiming,
    PhaseScore,
    QualitativeResults,
    QualityReport,
    LintFinding,
    ReportData,
    RunMeta,
    RunMetrics,
    TestResults,
    TokenUsage,
)
from reporting.render_html import render_html
from reporting.render_md import render_markdown


def _sample_data() -> ReportData:
    return ReportData(
        meta=RunMeta(
            run_folder="runs/20260218T125810-test",
            started_at="2026-02-18T12:58:13Z",
            completed_at="2026-02-18T13:22:44Z",
            status="Status.COMPLETED",
            execution_time_ms=1445460,
            total_handoffs=3,
            node_history=["executor", "simulator", "executor"],
            executor_model="claude-opus-4-6-v1",
            simulator_model="claude-sonnet-4-5",
            aws_region="us-west-2",
        ),
        metrics=RunMetrics(
            total_tokens=TokenUsage(9695968, 139967, 9835935),
            executor_tokens=TokenUsage(5671179, 76651, 5747830),
            simulator_tokens=TokenUsage(179972, 2412, 182384),
            wall_clock_ms=1445460,
            handoffs=[
                HandoffTiming(1, "executor", 975455),
                HandoffTiming(2, "simulator", 67876),
                HandoffTiming(3, "executor", 402145),
            ],
            artifacts=Artifacts(17, 18, 4, 72, 3522, 8, 5, 15),
        ),
        tests=TestResults(
            status="completed", install_ok=True, test_ok=True,
            passed=192, failed=0, errors=0, total=192, coverage_pct=91.3,
        ),
        quality=QualityReport(
            project_type="python", lint_tool="ruff", lint_version="0.15.1",
            lint_available=True,
            lint_findings=[
                LintFinding("app.py", 3, "I001", "Unsorted imports", "warning"),
                LintFinding("routes.py", 65, "E501", "Line too long", "error"),
            ],
            lint_total=2, lint_errors=1, lint_warnings=1,
        ),
        contracts=ContractResults(
            total=88, passed=88, failed=0, errors=0, server_started=True,
            cases=[
                ContractCase("health", "/health", "GET", True, 200, 200, latency_ms=4.5),
                ContractCase("add positive", "/api/v1/arithmetic/add", "POST", True, 200, 200, latency_ms=8.1),
            ],
        ),
        qualitative=QualitativeResults(
            overall_score=0.891,
            phases=[
                PhaseScore(
                    "inception", 0.9, 0.8875, 0.875, 0.89,
                    documents=[
                        DocScore("inception/component-dependency.md", 1.0, 0.95, 0.9, 0.96, "Highly aligned."),
                        DocScore("inception/component-methods.md", 1.0, 0.95, 0.85, 0.95, "Same methods."),
                    ],
                ),
                PhaseScore(
                    "construction", 0.88, 0.87, 0.86, 0.87,
                    documents=[
                        DocScore("construction/test-plan.md", 0.9, 0.85, 0.8, 0.85, "Good coverage."),
                    ],
                ),
            ],
        ),
        generated_at="2026-02-18T14:00:00Z",
    )


class TestMarkdown:
    def test_contains_header(self):
        md = render_markdown(_sample_data())
        assert "# AIDLC Evaluation Report" in md

    def test_contains_verdict_table(self):
        md = render_markdown(_sample_data())
        assert "## Verdict" in md
        assert "192/192" in md
        assert "88/88" in md

    def test_contains_token_usage(self):
        md = render_markdown(_sample_data())
        assert "## Token Usage" in md
        assert "Executor" in md

    def test_contains_qualitative_score(self):
        md = render_markdown(_sample_data())
        assert "0.891" in md
        assert "Inception" in md

    def test_contains_lint_findings(self):
        md = render_markdown(_sample_data())
        assert "`E501`" in md
        assert "`I001`" in md

    def test_write_to_file(self, tmp_path):
        from reporting.render_md import write_markdown
        path = tmp_path / "report.md"
        write_markdown(_sample_data(), path)
        text = path.read_text(encoding="utf-8")
        assert len(text) > 500
        assert "# AIDLC Evaluation Report" in text


class TestHTML:
    def test_contains_doctype(self):
        html = render_html(_sample_data())
        assert "<!DOCTYPE html>" in html

    def test_contains_verdict_cards(self):
        html = render_html(_sample_data())
        assert "192/192" in html
        assert "88/88" in html
        assert "badge-pass" in html

    def test_contains_score_ring(self):
        html = render_html(_sample_data())
        assert "ring-container" in html
        assert "89%" in html

    def test_contains_handoff_timeline(self):
        html = render_html(_sample_data())
        assert "Handoff Timeline" in html
        assert "executor" in html.lower()

    def test_contains_qualitative_bars(self):
        html = render_html(_sample_data())
        assert "phase-bars" in html
        assert "inception" in html.lower()

    def test_contains_lint_findings(self):
        html = render_html(_sample_data())
        assert "E501" in html
        assert "I001" in html

    def test_self_contained(self):
        """HTML report should be self-contained (inline CSS, no external sheets)."""
        html = render_html(_sample_data())
        assert "<style>" in html
        assert "Inter" in html

    def test_write_to_file(self, tmp_path):
        from reporting.render_html import write_html
        path = tmp_path / "report.html"
        write_html(_sample_data(), path)
        text = path.read_text(encoding="utf-8")
        assert len(text) > 2000
        assert "<!DOCTYPE html>" in text
