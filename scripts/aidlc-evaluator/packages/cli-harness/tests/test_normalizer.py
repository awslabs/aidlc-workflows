"""Tests for output normalization.

The normalizer now expects adapters to work directly in ``<output_dir>/workspace/``
and move ``aidlc-docs/`` up to ``<output_dir>/aidlc-docs/`` themselves.
The normalizer only writes ``run-meta.yaml`` and ``run-metrics.yaml``.
"""

from pathlib import Path

import yaml

from cli_harness.normalizer import normalize_output


def test_normalize_creates_run_meta(tmp_path: Path) -> None:
    """normalize_output should create run-meta.yaml."""
    output = tmp_path / "output"
    workspace = output / "workspace"
    workspace.mkdir(parents=True)

    normalize_output(workspace, output, adapter_name="test", elapsed_seconds=120.5)

    meta_path = output / "run-meta.yaml"
    assert meta_path.exists()
    meta = yaml.safe_load(meta_path.read_text())
    assert meta["status"] == "completed"
    assert meta["execution_time_ms"] == 120500
    assert meta["config"]["executor_model"] == "cli:test"


def test_normalize_creates_metrics_with_workspace(tmp_path: Path) -> None:
    """normalize_output should create run-metrics.yaml counting workspace files."""
    output = tmp_path / "output"
    workspace = output / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "app.py").write_text("x = 1\ny = 2\n")
    (workspace / "tests").mkdir()
    (workspace / "tests" / "test_app.py").write_text("def test_it(): pass")

    normalize_output(workspace, output, adapter_name="test", elapsed_seconds=60)

    metrics_path = output / "run-metrics.yaml"
    assert metrics_path.exists()
    metrics = yaml.safe_load(metrics_path.read_text())
    assert metrics["timing"]["total_wall_clock_ms"] == 60000
    assert metrics["artifacts"]["workspace"]["source_files"] == 1
    assert metrics["artifacts"]["workspace"]["test_files"] == 1


def test_normalize_counts_aidlc_docs(tmp_path: Path) -> None:
    """normalize_output should count aidlc-docs when present at output level."""
    output = tmp_path / "output"
    workspace = output / "workspace"
    workspace.mkdir(parents=True)
    # aidlc-docs already moved to output_dir by the adapter
    (output / "aidlc-docs" / "inception").mkdir(parents=True)
    (output / "aidlc-docs" / "inception" / "requirements.md").write_text("# Reqs")
    (output / "aidlc-docs" / "construction").mkdir(parents=True)
    (output / "aidlc-docs" / "construction" / "plan.md").write_text("# Plan")

    normalize_output(workspace, output, adapter_name="test")

    metrics = yaml.safe_load((output / "run-metrics.yaml").read_text())
    assert metrics["artifacts"]["aidlc_docs"]["inception_files"] == 1
    assert metrics["artifacts"]["aidlc_docs"]["construction_files"] == 1
    assert metrics["artifacts"]["aidlc_docs"]["total_files"] == 2


def test_normalize_with_token_usage(tmp_path: Path) -> None:
    """normalize_output should populate token data from token_usage dict."""
    output = tmp_path / "output"
    workspace = output / "workspace"
    workspace.mkdir(parents=True)

    token_usage = {
        "input_tokens": 1000,
        "output_tokens": 500,
        "total_tokens": 1500,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "num_turns": 5,
        "duration_api_ms": 50000,
        "model": "test-model",
    }

    normalize_output(workspace, output, adapter_name="test",
                     elapsed_seconds=60, token_usage=token_usage)

    metrics = yaml.safe_load((output / "run-metrics.yaml").read_text())
    assert metrics["tokens"]["total"]["input_tokens"] == 1000
    assert metrics["tokens"]["total"]["output_tokens"] == 500
    assert metrics["tokens"]["per_agent"]["executor"]["total_tokens"] == 1500
    assert metrics["handoff_patterns"]["per_agent"]["executor"]["turn_count"] == 5
    assert metrics["model_params"]["executor"]["model_id"] == "test-model"
