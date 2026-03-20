"""Metrics collection and persistence for AIDLC Runner — Phase 1 instrumentation."""

from __future__ import annotations

import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from shared.io import atomic_yaml_dump
from strands.multiagent.base import MultiAgentResult

from aidlc_runner.config import RunnerConfig

# File extensions considered "source code"
_SOURCE_EXTENSIONS = frozenset({
    ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rs",
    ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".swift", ".kt",
    ".scala", ".sh", ".bash", ".sql", ".html", ".css", ".scss",
})

# File names / extensions considered "config"
_CONFIG_FILENAMES = frozenset({
    "pyproject.toml", "package.json", "package-lock.json", "tsconfig.json",
    "cargo.toml", "makefile", "dockerfile", "docker-compose.yml",
    "docker-compose.yaml", ".gitignore", ".eslintrc.json", ".prettierrc",
    "ruff.toml", "setup.cfg", "setup.py", "requirements.txt",
})

_CONFIG_EXTENSIONS = frozenset({".toml", ".ini", ".cfg"})

# Generated lock/dependency files that inflate LOC counts
_LOCK_FILENAMES = frozenset({
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "poetry.lock", "uv.lock", "pipfile.lock", "cargo.lock",
    "composer.lock", "gemfile.lock", "bun.lockb",
})


def _is_test_file(path: Path) -> bool:
    """Heuristic: file is a test if its name or parent directory suggests tests."""
    name = path.name.lower()
    parts = [p.lower() for p in path.parts]
    if any(p in ("tests", "test", "__tests__", "spec") for p in parts):
        return True
    if name.startswith("test_") or name.endswith("_test.py") or name.endswith(".test.js"):
        return True
    if name.endswith("_test.ts") or name.endswith(".test.ts") or name.endswith(".test.tsx"):
        return True
    if name.endswith("_spec.py") or name.endswith(".spec.js") or name.endswith(".spec.ts"):
        return True
    return False


def _is_config_file(path: Path) -> bool:
    """Heuristic: file is a config/build file."""
    if path.name.lower() in _CONFIG_FILENAMES:
        return True
    if path.suffix.lower() in _CONFIG_EXTENSIONS:
        return True
    if path.suffix.lower() in (".yaml", ".yml"):
        return True
    return False


def _count_lines(path: Path) -> int:
    """Count lines in a text file, returning 0 for binary/unreadable files."""
    try:
        return len(path.read_text(encoding="utf-8", errors="strict").splitlines())
    except (UnicodeDecodeError, OSError):
        return 0


def _scan_artifacts(run_folder: Path) -> dict[str, Any]:
    """Scan workspace/ and aidlc-docs/ to count generated artifacts.

    Returns a dict with workspace and aidlc_docs sections.
    """
    workspace = run_folder / "workspace"
    aidlc_docs = run_folder / "aidlc-docs"

    # --- workspace ---
    source_files = 0
    test_files = 0
    config_files = 0
    other_files = 0
    total_loc = 0

    if workspace.exists():
        for f in workspace.rglob("*"):
            if not f.is_file():
                continue
            rel = f.relative_to(workspace)
            is_lock = f.name.lower() in _LOCK_FILENAMES
            if _is_test_file(rel):
                test_files += 1
            elif f.suffix.lower() in _SOURCE_EXTENSIONS:
                source_files += 1
            elif _is_config_file(rel):
                config_files += 1
            else:
                other_files += 1
            if not is_lock:
                total_loc += _count_lines(f)

    ws_total = source_files + test_files + config_files + other_files

    # --- aidlc-docs ---
    inception_files = 0
    construction_files = 0
    other_doc_files = 0

    if aidlc_docs.exists():
        for f in aidlc_docs.rglob("*"):
            if not f.is_file():
                continue
            rel = f.relative_to(aidlc_docs)
            parts = rel.parts
            if parts and parts[0] == "inception":
                inception_files += 1
            elif parts and parts[0] == "construction":
                construction_files += 1
            else:
                other_doc_files += 1

    doc_total = inception_files + construction_files + other_doc_files

    return {
        "workspace": {
            "source_files": source_files,
            "test_files": test_files,
            "config_files": config_files,
            "other_files": other_files,
            "total_files": ws_total,
            "total_lines_of_code": total_loc,
        },
        "aidlc_docs": {
            "inception_files": inception_files,
            "construction_files": construction_files,
            "other_files": other_doc_files,
            "total_files": doc_total,
        },
    }


def _usage_to_dict(usage: dict[str, int]) -> dict[str, int]:
    """Normalise a Usage TypedDict to a plain dict with snake_case keys."""
    return {
        "input_tokens": usage.get("inputTokens", 0),
        "output_tokens": usage.get("outputTokens", 0),
        "total_tokens": usage.get("totalTokens", 0),
        "cache_read_tokens": usage.get("cacheReadInputTokens", 0),
        "cache_write_tokens": usage.get("cacheWriteInputTokens", 0),
    }


class MetricsCollector:
    """Accumulates metrics during a run and serializes them to run-metrics.yaml.

    Live data (handoff timings, error events) is recorded via callbacks during
    execution. Token counts and artifact data are extracted post-run from the
    Strands result and the filesystem.
    """

    def __init__(self, config: RunnerConfig) -> None:
        self._config = config
        self._handoffs: list[dict[str, Any]] = []
        self._errors: list[dict[str, str]] = []
        self._context_samples: list[dict[str, Any]] = []

    # -- Live recording (called during execution) --

    def record_handoff(self, handoff_num: int, node_id: str, duration_ms: int) -> None:
        """Record a completed handoff with its duration."""
        self._handoffs.append({
            "handoff": handoff_num,
            "node_id": node_id,
            "duration_ms": duration_ms,
        })

    def record_error(self, error_type: str, message: str) -> None:
        """Record an error/retry event observed during streaming."""
        self._errors.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": error_type,
            "message": message,
        })

    def record_context_sample(self, agent_name: str, input_tokens: int) -> None:
        """Record the input token count from a single model invocation.

        Each sample represents the context window size at that point in the
        conversation — input_tokens grows as the message history accumulates.
        """
        self._context_samples.append({
            "agent": agent_name,
            "input_tokens": input_tokens,
        })

    # -- Post-run assembly --

    @staticmethod
    def _compute_context_stats(samples: list[int]) -> dict[str, int | float]:
        """Compute min/max/avg/median over a list of input-token counts."""
        if not samples:
            return {
                "min_tokens": 0,
                "max_tokens": 0,
                "avg_tokens": 0,
                "median_tokens": 0,
                "sample_count": 0,
            }
        return {
            "min_tokens": min(samples),
            "max_tokens": max(samples),
            "avg_tokens": int(statistics.mean(samples)),
            "median_tokens": int(statistics.median(samples)),
            "sample_count": len(samples),
        }

    def build_metrics(self, result: MultiAgentResult, run_folder: Path) -> dict[str, Any]:
        """Assemble the full metrics dict from the swarm result and run folder.

        Should be called after the swarm completes.
        """
        metrics: dict[str, Any] = {}

        # --- Tokens ---
        # Extract per-agent token counts (unique tokens per agent)
        per_agent: dict[str, dict[str, int]] = {}
        for node_id, node_result in result.results.items():
            per_agent[node_id] = _usage_to_dict(node_result.accumulated_usage)

        # Calculate sum of per-agent tokens (unique tokens across all agents)
        unique_total = {
            "input_tokens": sum(agent["input_tokens"] for agent in per_agent.values()),
            "output_tokens": sum(agent["output_tokens"] for agent in per_agent.values()),
            "total_tokens": sum(agent["total_tokens"] for agent in per_agent.values()),
            "cache_read_tokens": sum(agent["cache_read_tokens"] for agent in per_agent.values()),
            "cache_write_tokens": sum(agent["cache_write_tokens"] for agent in per_agent.values()),
        }

        # Get raw accumulated usage from all API calls (includes repeated context)
        api_total = _usage_to_dict(result.accumulated_usage)

        # Calculate repeated context (tokens re-sent across multiple turns)
        repeated_context = {
            "input_tokens": api_total["input_tokens"] - unique_total["input_tokens"],
            "output_tokens": api_total["output_tokens"] - unique_total["output_tokens"],
            "total_tokens": api_total["total_tokens"] - unique_total["total_tokens"],
            "cache_read_tokens": api_total["cache_read_tokens"] - unique_total["cache_read_tokens"],
            "cache_write_tokens": api_total["cache_write_tokens"] - unique_total["cache_write_tokens"],
        }

        metrics["tokens"] = {
            "total": unique_total,  # Sum of per-agent unique tokens
            "per_agent": per_agent,
            "repeated_context": repeated_context,  # Context re-sent on subsequent turns
            "api_total": api_total,  # Raw total from all API calls
        }

        # --- Timing ---
        metrics["timing"] = {
            "total_wall_clock_ms": result.execution_time,
            "handoffs": list(self._handoffs),
        }

        # --- Handoff patterns ---
        sequence = [h["node_id"] for h in self._handoffs]
        agent_stats: dict[str, dict[str, Any]] = {}
        for h in self._handoffs:
            nid = h["node_id"]
            if nid not in agent_stats:
                agent_stats[nid] = {"turn_count": 0, "total_duration_ms": 0}
            agent_stats[nid]["turn_count"] += 1
            agent_stats[nid]["total_duration_ms"] += h["duration_ms"]

        for stats in agent_stats.values():
            if stats["turn_count"] > 0:
                stats["avg_turn_duration_ms"] = stats["total_duration_ms"] // stats["turn_count"]
            else:
                stats["avg_turn_duration_ms"] = 0

        metrics["handoff_patterns"] = {
            "total_handoffs": len(self._handoffs),
            "sequence": sequence,
            "per_agent": agent_stats,
        }

        # --- Artifacts ---
        metrics["artifacts"] = _scan_artifacts(run_folder)

        # --- Errors ---
        error_counts: dict[str, int] = {}
        for e in self._errors:
            error_counts[e["type"]] = error_counts.get(e["type"], 0) + 1

        metrics["errors"] = {
            "throttle_events": error_counts.get("throttle", 0),
            "timeout_events": error_counts.get("timeout", 0),
            "failed_tool_calls": error_counts.get("failed_tool", 0),
            "model_error_events": error_counts.get("model_error", 0),
            "service_unavailable_events": error_counts.get("service_unavailable", 0),
            "validation_error_events": error_counts.get("validation_error", 0),
            "details": list(self._errors),
        }

        # --- Context size ---
        all_tokens = [s["input_tokens"] for s in self._context_samples]
        per_agent_tokens: dict[str, list[int]] = {}
        for s in self._context_samples:
            per_agent_tokens.setdefault(s["agent"], []).append(s["input_tokens"])

        metrics["context_size"] = {
            "total": self._compute_context_stats(all_tokens),
            "per_agent": {
                agent: self._compute_context_stats(tokens)
                for agent, tokens in per_agent_tokens.items()
            },
            "samples": list(self._context_samples),
        }

        # --- Model params ---
        metrics["model_params"] = {
            "executor": {
                "model_id": self._config.models.executor.model_id,
                "provider": self._config.models.executor.provider,
            },
            "simulator": {
                "model_id": self._config.models.simulator.model_id,
                "provider": self._config.models.simulator.provider,
            },
            "aws_region": self._config.aws.region,
        }

        return metrics

    def write(self, result: MultiAgentResult, run_folder: Path) -> Path:
        """Build metrics and write run-metrics.yaml to the run folder.

        Returns the path to the written file.
        """
        metrics = self.build_metrics(result, run_folder)
        out_path = run_folder / "run-metrics.yaml"
        atomic_yaml_dump(metrics, out_path)
        return out_path
