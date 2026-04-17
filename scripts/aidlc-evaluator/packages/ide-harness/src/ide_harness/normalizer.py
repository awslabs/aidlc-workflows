"""Output normalization — map IDE workspace output to evaluation-compatible layout."""

from __future__ import annotations

import shutil
from datetime import UTC, datetime
from pathlib import Path

import yaml


def normalize_output(
    source_dir: Path,
    output_dir: Path,
    adapter_name: str,
    model_hint: str = "",
    elapsed_seconds: float = 0.0,
) -> Path:
    """Normalize IDE output into the run folder layout expected by run_evaluation.py.

    The expected layout is:
        <output_dir>/
            run-meta.yaml
            run-metrics.yaml
            aidlc-docs/
            workspace/

    Args:
        source_dir: The IDE's workspace directory containing generated files.
        output_dir: Where to write the normalized output.
        adapter_name: Name of the IDE adapter (e.g., "cursor").
        model_hint: Optional model identifier for run-meta.
        elapsed_seconds: Wall clock time for the run.

    Returns:
        Path to the output_dir.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Copy aidlc-docs if present in source
    src_docs = source_dir / "aidlc-docs"
    dst_docs = output_dir / "aidlc-docs"
    if src_docs.is_dir():
        if dst_docs.exists():
            shutil.rmtree(dst_docs)
        shutil.copytree(src_docs, dst_docs)

    # Copy workspace — everything except aidlc-docs and aidlc-rules
    dst_workspace = output_dir / "workspace"
    dst_workspace.mkdir(exist_ok=True)
    skip = {"aidlc-docs", "aidlc-rules", ".git", ".venv", "node_modules", "__pycache__"}
    for item in source_dir.iterdir():
        if item.name in skip:
            continue
        dst = dst_workspace / item.name
        if item.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(item, dst)
        else:
            shutil.copy2(item, dst)

    # Generate run-meta.yaml
    now = datetime.now(UTC).isoformat(timespec="seconds")
    meta = {
        "run_folder": str(output_dir),
        "started_at": now,
        "completed_at": now,
        "status": "completed",
        "execution_time_ms": int(elapsed_seconds * 1000),
        "total_handoffs": 0,
        "node_history": [],
        "config": {
            "executor_model": model_hint or f"ide:{adapter_name}",
            "simulator_model": "human",
            "aws_region": "",
        },
    }
    meta_path = output_dir / "run-meta.yaml"
    with open(meta_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(meta, f, default_flow_style=False, sort_keys=False)

    # Generate minimal run-metrics.yaml
    metrics = {
        "tokens": {
            "total": {
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
            },
        },
        "timing": {
            "total_wall_clock_ms": int(elapsed_seconds * 1000),
            "handoffs": [],
        },
        "artifacts": {
            "workspace": _count_workspace_files(dst_workspace),
            "aidlc_docs": _count_doc_files(dst_docs) if dst_docs.is_dir() else {},
        },
        "errors": {},
    }
    metrics_path = output_dir / "run-metrics.yaml"
    with open(metrics_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(metrics, f, default_flow_style=False, sort_keys=False)

    return output_dir


def _count_workspace_files(workspace: Path) -> dict:
    """Count files in the workspace by category."""
    if not workspace.is_dir():
        return {}

    source_exts = {".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".java"}
    test_patterns = {"test_", "_test.", ".test.", ".spec."}
    config_exts = {".yaml", ".yml", ".json", ".toml", ".cfg", ".ini"}

    source = test = config = other = 0
    total_lines = 0

    for f in workspace.rglob("*"):
        if not f.is_file():
            continue
        ext = f.suffix.lower()
        name = f.name.lower()

        is_test = any(p in name for p in test_patterns)
        if is_test and ext in source_exts:
            test += 1
        elif ext in source_exts:
            source += 1
            try:
                total_lines += len(f.read_text(errors="replace").splitlines())
            except OSError:
                pass
        elif ext in config_exts:
            config += 1
        else:
            other += 1

    return {
        "source_files": source,
        "test_files": test,
        "config_files": config,
        "other_files": other,
        "total_files": source + test + config + other,
        "total_lines_of_code": total_lines,
    }


def _count_doc_files(docs_dir: Path) -> dict:
    """Count AIDLC doc files by phase."""
    inception = construction = other = 0
    for f in docs_dir.rglob("*.md"):
        rel = str(f.relative_to(docs_dir))
        if rel.startswith("inception"):
            inception += 1
        elif rel.startswith("construction"):
            construction += 1
        else:
            other += 1
    return {
        "inception_files": inception,
        "construction_files": construction,
        "other_files": other,
        "total_files": inception + construction + other,
    }
