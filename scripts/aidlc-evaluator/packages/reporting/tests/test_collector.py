"""Tests for reporting.collector — data model and YAML parsing."""

from pathlib import Path

import yaml

from reporting.collector import collect


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        yaml.safe_dump(data, f, default_flow_style=False)


def _minimal_run(tmp_path: Path) -> Path:
    """Create a minimal run folder with all YAML artifacts."""
    run = tmp_path / "run-001"
    run.mkdir()

    _write(run / "run-meta.yaml", {
        "run_folder": str(run),
        "started_at": "2026-02-18T12:00:00Z",
        "completed_at": "2026-02-18T13:00:00Z",
        "status": "Status.COMPLETED",
        "execution_time_ms": 3600000,
        "total_handoffs": 3,
        "node_history": ["executor", "simulator", "executor"],
        "config": {
            "executor_model": "claude-opus",
            "simulator_model": "claude-sonnet",
            "aws_region": "us-west-2",
        },
    })

    _write(run / "run-metrics.yaml", {
        "tokens": {
            "total": {"input_tokens": 1000000, "output_tokens": 50000, "total_tokens": 1050000},
            "per_agent": {
                "executor": {"input_tokens": 800000, "output_tokens": 40000, "total_tokens": 840000},
                "simulator": {"input_tokens": 200000, "output_tokens": 10000, "total_tokens": 210000},
            },
        },
        "timing": {
            "total_wall_clock_ms": 3600000,
            "handoffs": [
                {"handoff": 1, "node_id": "executor", "duration_ms": 2000000},
                {"handoff": 2, "node_id": "simulator", "duration_ms": 600000},
                {"handoff": 3, "node_id": "executor", "duration_ms": 1000000},
            ],
        },
        "artifacts": {
            "workspace": {"source_files": 10, "test_files": 5, "config_files": 2, "total_files": 17, "total_lines_of_code": 1500},
            "aidlc_docs": {"inception_files": 8, "construction_files": 5, "total_files": 13},
        },
        "errors": {"throttle_events": 0, "timeout_events": 0},
    })

    _write(run / "test-results.yaml", {
        "status": "completed",
        "install": {"success": True},
        "test": {
            "success": True,
            "output": "Total coverage: 91.3%\n192 passed in 0.87s",
            "parsed_results": {"passed": 192, "failed": 0, "errors": 0, "total": 192},
        },
    })

    _write(run / "quality-report.yaml", {
        "project_type": "python",
        "lint": {
            "tool": "ruff", "version": "0.15.1", "available": True,
            "findings": [
                {"file": "app.py", "line": 3, "code": "I001", "message": "Unsorted imports", "severity": "warning"},
                {"file": "routes.py", "line": 65, "code": "E501", "message": "Line too long", "severity": "error"},
            ],
        },
        "security": {"tool": "bandit", "available": False},
        "summary": {"lint_total": 2, "lint_errors": 1, "lint_warnings": 1},
    })

    _write(run / "contract-test-results.yaml", {
        "total": 10, "passed": 9, "failed": 1, "errors": 0, "server_started": True,
        "cases": [
            {"name": "health", "path": "/health", "method": "GET", "passed": True, "expected_status": 200, "actual_status": 200, "latency_ms": 5.2},
            {"name": "add", "path": "/api/v1/arithmetic/add", "method": "POST", "passed": False, "expected_status": 200, "actual_status": 500, "failures": ["status mismatch"]},
        ],
    })

    _write(run / "qualitative-comparison.yaml", {
        "overall_score": 0.89,
        "phases": [{
            "phase": "inception",
            "avg_intent": 0.95,
            "avg_design": 0.9,
            "avg_completeness": 0.85,
            "avg_overall": 0.9,
            "documents": [{
                "path": "inception/component-dependency.md",
                "intent_similarity": 0.95,
                "design_similarity": 0.9,
                "completeness": 0.85,
                "overall": 0.9,
                "notes": "Good alignment overall.",
            }],
        }],
    })

    return run


def test_collect_all_artifacts(tmp_path):
    run = _minimal_run(tmp_path)
    data = collect(run)

    assert data.meta.status == "Status.COMPLETED"
    assert data.meta.executor_model == "claude-opus"
    assert data.meta.total_handoffs == 3

    assert data.metrics.total_tokens.total_tokens == 1050000
    assert data.metrics.wall_clock_ms == 3600000
    assert len(data.metrics.handoffs) == 3
    assert data.metrics.artifacts.source_files == 10

    assert data.tests is not None
    assert data.tests.passed == 192
    assert data.tests.test_ok is True
    assert data.tests.coverage_pct == 91.3

    assert data.quality is not None
    assert data.quality.lint_total == 2
    assert data.quality.lint_errors == 1

    assert data.contracts is not None
    assert data.contracts.passed == 9
    assert data.contracts.failed == 1

    assert data.qualitative is not None
    assert data.qualitative.overall_score == 0.89
    assert len(data.qualitative.phases) == 1
    assert data.qualitative.phases[0].documents[0].intent == 0.95


def test_collect_missing_artifacts(tmp_path):
    run = tmp_path / "empty-run"
    run.mkdir()
    data = collect(run)

    assert data.meta.status == ""
    assert data.tests is None
    assert data.quality is None
    assert data.contracts is None
    assert data.qualitative is None


def test_collect_real_run():
    """Test against the real golden run if it exists."""
    real_run = Path(__file__).resolve().parents[3] / "runs" / "20260218T125810-b84d042dff254a72b4ffec926fe5ea99"
    if not real_run.exists():
        return

    data = collect(real_run)
    assert data.meta.total_handoffs == 3
    assert data.tests is not None
    assert data.tests.passed == 192
    assert data.contracts is not None
    assert data.contracts.passed == 88
    assert data.qualitative is not None
    assert data.qualitative.overall_score > 0.8
