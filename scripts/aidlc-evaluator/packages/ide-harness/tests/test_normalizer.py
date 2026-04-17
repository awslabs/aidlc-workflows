"""Tests for output normalization."""

from pathlib import Path

import yaml

from ide_harness.normalizer import normalize_output


def test_normalize_creates_run_meta(tmp_path: Path) -> None:
    """normalize_output should create run-meta.yaml."""
    source = tmp_path / "source"
    source.mkdir()
    (source / "aidlc-docs").mkdir()
    (source / "aidlc-docs" / "test.md").write_text("# Test")

    output = tmp_path / "output"
    normalize_output(source, output, adapter_name="test", elapsed_seconds=120.5)

    meta_path = output / "run-meta.yaml"
    assert meta_path.exists()
    meta = yaml.safe_load(meta_path.read_text())
    assert meta["status"] == "completed"
    assert meta["execution_time_ms"] == 120500
    assert meta["config"]["executor_model"] == "ide:test"


def test_normalize_copies_aidlc_docs(tmp_path: Path) -> None:
    """normalize_output should copy aidlc-docs to output."""
    source = tmp_path / "source"
    (source / "aidlc-docs" / "inception").mkdir(parents=True)
    (source / "aidlc-docs" / "inception" / "requirements.md").write_text("# Reqs")

    output = tmp_path / "output"
    normalize_output(source, output, adapter_name="test")

    assert (output / "aidlc-docs" / "inception" / "requirements.md").exists()


def test_normalize_copies_workspace_files(tmp_path: Path) -> None:
    """normalize_output should copy non-aidlc files to workspace/."""
    source = tmp_path / "source"
    source.mkdir()
    (source / "main.py").write_text("print('hello')")
    (source / "tests").mkdir()
    (source / "tests" / "test_main.py").write_text("def test_it(): pass")

    output = tmp_path / "output"
    normalize_output(source, output, adapter_name="test")

    assert (output / "workspace" / "main.py").exists()
    assert (output / "workspace" / "tests" / "test_main.py").exists()


def test_normalize_creates_metrics(tmp_path: Path) -> None:
    """normalize_output should create run-metrics.yaml with file counts."""
    source = tmp_path / "source"
    source.mkdir()
    (source / "app.py").write_text("x = 1\ny = 2\n")

    output = tmp_path / "output"
    normalize_output(source, output, adapter_name="test", elapsed_seconds=60)

    metrics_path = output / "run-metrics.yaml"
    assert metrics_path.exists()
    metrics = yaml.safe_load(metrics_path.read_text())
    assert metrics["timing"]["total_wall_clock_ms"] == 60000
    assert metrics["artifacts"]["workspace"]["source_files"] == 1
