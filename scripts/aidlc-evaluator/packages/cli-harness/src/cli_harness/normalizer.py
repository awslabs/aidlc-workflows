"""Output normalization — map CLI workspace output to evaluation-compatible layout."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import yaml


def normalize_output(
    source_dir: Path,
    output_dir: Path,
    adapter_name: str,
    model_hint: str = "",
    elapsed_seconds: float = 0.0,
    token_usage: dict | None = None,
) -> Path:
    """Write run-meta.yaml and run-metrics.yaml for a completed CLI run.

    Adapters now work directly in ``<output_dir>/workspace/`` and move
    ``aidlc-docs/`` up to ``<output_dir>/aidlc-docs/`` themselves, so this
    function only generates the metadata files.

    Args:
        source_dir: The workspace directory (``<output_dir>/workspace/``).
        output_dir: The run output directory.
        adapter_name: Name of the CLI adapter (e.g., "kiro-cli").
        model_hint: Optional model identifier for run-meta.
        elapsed_seconds: Wall clock time for the run.
        token_usage: Optional dict with token counts, cost, and model breakdown
                     (from stream-json result parsing).

    Returns:
        Path to the output_dir.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    dst_workspace = output_dir / "workspace"
    dst_docs = output_dir / "aidlc-docs"

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
            "executor_model": model_hint or f"cli:{adapter_name}",
            "simulator_model": "human",
            "aws_region": "",
        },
    }
    meta_path = output_dir / "run-meta.yaml"
    with open(meta_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(meta, f, default_flow_style=False, sort_keys=False)

    # Generate run-metrics.yaml matching the execution pipeline schema
    tu = token_usage or {}
    input_tokens = tu.get("input_tokens", 0)
    output_tokens = tu.get("output_tokens", 0)
    cache_read = tu.get("cache_read_tokens", 0)
    cache_write = tu.get("cache_write_tokens", 0)
    total_tokens = tu.get("total_tokens", input_tokens + output_tokens + cache_read + cache_write)
    num_turns = tu.get("num_turns", 0)
    duration_ms = int(elapsed_seconds * 1000)
    duration_api_ms = tu.get("duration_api_ms", 0)
    model_id = tu.get("model", f"cli:{adapter_name}")

    # tokens section — CLI adapters have a single "executor" agent, no simulator
    # No repeated context since CLI adapters are single-session
    tokens_section: dict = {
        "total": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
        },
        "per_agent": {
            "executor": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
                "cache_read_tokens": cache_read,
                "cache_write_tokens": cache_write,
            },
        },
        "repeated_context": {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        },
        "api_total": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
        },
    }

    # timing section — CLI adapters run as a single executor session
    # Emit one handoff entry for the whole run (not per-turn, to avoid noise)
    handoffs = [{
        "handoff": 1,
        "node_id": "executor",
        "duration_ms": duration_api_ms or duration_ms,
    }]

    timing_section: dict = {
        "total_wall_clock_ms": duration_ms,
        "handoffs": handoffs,
    }

    # handoff_patterns section
    handoff_patterns: dict = {
        "total_handoffs": 1,
        "sequence": ["executor"],
        "per_agent": {
            "executor": {
                "turn_count": num_turns,
                "total_duration_ms": duration_api_ms or duration_ms,
                "avg_turn_duration_ms": (duration_api_ms or duration_ms) // max(num_turns, 1),
            },
        },
    }

    # errors section
    errors_section: dict = {
        "throttle_events": 0,
        "timeout_events": 0,
        "failed_tool_calls": 0,
        "model_error_events": 0,
        "service_unavailable_events": 0,
        "validation_error_events": 0,
        "details": [],
    }

    # model_params section
    model_params_section: dict = {
        "executor": {
            "model_id": model_id,
            "provider": "bedrock",
        },
        "aws_region": "",
    }

    metrics = {
        "tokens": tokens_section,
        "timing": timing_section,
        "handoff_patterns": handoff_patterns,
        "artifacts": {
            "workspace": _count_workspace_files(dst_workspace),
            "aidlc_docs": _count_doc_files(dst_docs) if dst_docs.is_dir() else {},
        },
        "errors": errors_section,
        "model_params": model_params_section,
    }
    # Add cost if available (not in the reference schema but useful)
    if tu.get("total_cost_usd"):
        metrics["cost_usd"] = tu["total_cost_usd"]
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
