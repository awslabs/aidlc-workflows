"""Tests for metrics collection, artifact scanning, and YAML output."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from aidlc_runner.config import RunnerConfig
from aidlc_runner.metrics import MetricsCollector, _scan_artifacts
from aidlc_runner.progress import AgentProgressHandler, SwarmProgressHook


# ---------------------------------------------------------------------------
# Helpers — lightweight fakes for Strands result types
# ---------------------------------------------------------------------------


@dataclass
class FakeNodeResult:
    accumulated_usage: dict[str, int] = field(default_factory=lambda: {
        "inputTokens": 0, "outputTokens": 0, "totalTokens": 0,
    })


@dataclass
class FakeMultiAgentResult:
    accumulated_usage: dict[str, int] = field(default_factory=lambda: {
        "inputTokens": 0, "outputTokens": 0, "totalTokens": 0,
    })
    results: dict[str, FakeNodeResult] = field(default_factory=dict)
    execution_time: int = 0


# ---------------------------------------------------------------------------
# Artifact scanning
# ---------------------------------------------------------------------------


class TestScanArtifacts:
    def test_empty_workspace(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        (tmp_path / "aidlc-docs" / "inception").mkdir(parents=True)
        (tmp_path / "aidlc-docs" / "construction").mkdir(parents=True)

        result = _scan_artifacts(tmp_path)
        ws = result["workspace"]
        assert ws["source_files"] == 0
        assert ws["test_files"] == 0
        assert ws["config_files"] == 0
        assert ws["other_files"] == 0
        assert ws["total_files"] == 0
        assert ws["total_lines_of_code"] == 0

        docs = result["aidlc_docs"]
        assert docs["total_files"] == 0

    def test_source_files_counted(self, tmp_path: Path):
        ws = tmp_path / "workspace" / "src"
        ws.mkdir(parents=True)
        (ws / "main.py").write_text("print('hello')\nprint('world')\n")
        (ws / "utils.js").write_text("// util\n")
        (tmp_path / "aidlc-docs").mkdir()

        result = _scan_artifacts(tmp_path)
        assert result["workspace"]["source_files"] == 2
        assert result["workspace"]["total_lines_of_code"] == 3

    def test_test_files_by_name(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        (ws / "test_main.py").write_text("def test_it(): pass\n")
        (ws / "app.spec.js").write_text("describe('app', () => {})\n")
        (tmp_path / "aidlc-docs").mkdir()

        result = _scan_artifacts(tmp_path)
        assert result["workspace"]["test_files"] == 2
        assert result["workspace"]["source_files"] == 0

    def test_test_files_by_directory(self, tmp_path: Path):
        tests_dir = tmp_path / "workspace" / "tests"
        tests_dir.mkdir(parents=True)
        (tests_dir / "conftest.py").write_text("")
        (tests_dir / "helpers.py").write_text("x = 1\n")
        (tmp_path / "aidlc-docs").mkdir()

        result = _scan_artifacts(tmp_path)
        assert result["workspace"]["test_files"] == 2

    def test_config_files(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        (ws / "pyproject.toml").write_text("[project]\nname = 'x'\n")
        (ws / "Dockerfile").write_text("FROM python:3.13\n")
        (tmp_path / "aidlc-docs").mkdir()

        result = _scan_artifacts(tmp_path)
        assert result["workspace"]["config_files"] == 2

    def test_aidlc_docs_categorised(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        inc = tmp_path / "aidlc-docs" / "inception"
        con = tmp_path / "aidlc-docs" / "construction"
        inc.mkdir(parents=True)
        con.mkdir(parents=True)

        (inc / "requirements.md").write_text("# Req\n")
        (inc / "user-stories.md").write_text("# Stories\n")
        (con / "functional-design.md").write_text("# Design\n")
        (tmp_path / "aidlc-docs" / "audit.md").write_text("# Audit\n")

        result = _scan_artifacts(tmp_path)
        docs = result["aidlc_docs"]
        assert docs["inception_files"] == 2
        assert docs["construction_files"] == 1
        assert docs["other_files"] == 1
        assert docs["total_files"] == 4

    def test_lock_files_excluded_from_loc(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        (ws / "main.py").write_text("print('hello')\n")
        (ws / "package-lock.json").write_text("{\n" * 50000)
        (ws / "yarn.lock").write_text("dep:\n" * 10000)
        (tmp_path / "aidlc-docs").mkdir()

        result = _scan_artifacts(tmp_path)
        # Lock files are still counted in file totals but NOT in LOC
        assert result["workspace"]["total_lines_of_code"] == 1

    def test_nested_yaml_counted_as_config(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        (ws / ".github" / "workflows").mkdir(parents=True)
        (ws / ".github" / "workflows" / "ci.yml").write_text("name: CI\n")
        (tmp_path / "aidlc-docs").mkdir()

        result = _scan_artifacts(tmp_path)
        assert result["workspace"]["config_files"] == 1

    def test_binary_files_zero_loc(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        # Write bytes that are invalid UTF-8
        (ws / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\xff" * 50)
        (tmp_path / "aidlc-docs").mkdir()

        result = _scan_artifacts(tmp_path)
        assert result["workspace"]["other_files"] == 1
        assert result["workspace"]["total_lines_of_code"] == 0

    def test_missing_directories_handled(self, tmp_path: Path):
        # No workspace/ or aidlc-docs/ at all
        result = _scan_artifacts(tmp_path)
        assert result["workspace"]["total_files"] == 0
        assert result["aidlc_docs"]["total_files"] == 0


# ---------------------------------------------------------------------------
# MetricsCollector
# ---------------------------------------------------------------------------


class TestMetricsCollectorRecording:
    def test_record_handoff(self):
        collector = MetricsCollector(RunnerConfig())
        collector.record_handoff(1, "executor", 5000)
        collector.record_handoff(2, "simulator", 2000)

        assert len(collector._handoffs) == 2
        assert collector._handoffs[0] == {"handoff": 1, "node_id": "executor", "duration_ms": 5000}
        assert collector._handoffs[1] == {"handoff": 2, "node_id": "simulator", "duration_ms": 2000}

    def test_record_error(self):
        collector = MetricsCollector(RunnerConfig())
        collector.record_error("throttle", "Rate exceeded")

        assert len(collector._errors) == 1
        assert collector._errors[0]["type"] == "throttle"
        assert collector._errors[0]["message"] == "Rate exceeded"
        assert "timestamp" in collector._errors[0]

    def test_record_context_sample(self):
        collector = MetricsCollector(RunnerConfig())
        collector.record_context_sample("executor", 50000)
        collector.record_context_sample("simulator", 12000)
        collector.record_context_sample("executor", 80000)

        assert len(collector._context_samples) == 3
        assert collector._context_samples[0] == {"agent": "executor", "input_tokens": 50000}
        assert collector._context_samples[1] == {"agent": "simulator", "input_tokens": 12000}
        assert collector._context_samples[2] == {"agent": "executor", "input_tokens": 80000}


class TestMetricsCollectorBuild:
    def _make_result(self) -> FakeMultiAgentResult:
        return FakeMultiAgentResult(
            accumulated_usage={
                "inputTokens": 100000,
                "outputTokens": 40000,
                "totalTokens": 140000,
                "cacheReadInputTokens": 5000,
                "cacheWriteInputTokens": 2000,
            },
            results={
                "executor": FakeNodeResult(accumulated_usage={
                    "inputTokens": 70000,
                    "outputTokens": 30000,
                    "totalTokens": 100000,
                }),
                "simulator": FakeNodeResult(accumulated_usage={
                    "inputTokens": 30000,
                    "outputTokens": 10000,
                    "totalTokens": 40000,
                }),
            },
            execution_time=60000,
        )

    def test_tokens_section(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        (tmp_path / "aidlc-docs").mkdir()

        collector = MetricsCollector(RunnerConfig())
        metrics = collector.build_metrics(self._make_result(), tmp_path)

        # Check per-agent tokens
        executor = metrics["tokens"]["per_agent"]["executor"]
        assert executor["input_tokens"] == 70000
        assert executor["output_tokens"] == 30000
        assert executor["total_tokens"] == 100000

        simulator = metrics["tokens"]["per_agent"]["simulator"]
        assert simulator["input_tokens"] == 30000
        assert simulator["output_tokens"] == 10000
        assert simulator["total_tokens"] == 40000

        # Check total is sum of per-agent (unique tokens)
        total = metrics["tokens"]["total"]
        assert total["input_tokens"] == 100000  # 70k + 30k
        assert total["output_tokens"] == 40000  # 30k + 10k
        assert total["total_tokens"] == 140000  # 100k + 40k
        assert total["cache_read_tokens"] == 0
        assert total["cache_write_tokens"] == 0

        # Check repeated context (no repetition in this test case)
        repeated = metrics["tokens"]["repeated_context"]
        assert repeated["input_tokens"] == 0
        assert repeated["output_tokens"] == 0
        assert repeated["total_tokens"] == 0
        assert repeated["cache_read_tokens"] == 5000  # Cache only in api_total
        assert repeated["cache_write_tokens"] == 2000

        # Check api_total includes cache tokens
        api_total = metrics["tokens"]["api_total"]
        assert api_total["input_tokens"] == 100000
        assert api_total["output_tokens"] == 40000
        assert api_total["total_tokens"] == 140000
        assert api_total["cache_read_tokens"] == 5000
        assert api_total["cache_write_tokens"] == 2000

    def test_timing_section(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        (tmp_path / "aidlc-docs").mkdir()

        collector = MetricsCollector(RunnerConfig())
        collector.record_handoff(1, "executor", 5000)
        collector.record_handoff(2, "simulator", 3000)
        metrics = collector.build_metrics(self._make_result(), tmp_path)

        assert metrics["timing"]["total_wall_clock_ms"] == 60000
        assert len(metrics["timing"]["handoffs"]) == 2
        assert metrics["timing"]["handoffs"][0]["duration_ms"] == 5000

    def test_handoff_patterns(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        (tmp_path / "aidlc-docs").mkdir()

        collector = MetricsCollector(RunnerConfig())
        collector.record_handoff(1, "executor", 4000)
        collector.record_handoff(2, "simulator", 2000)
        collector.record_handoff(3, "executor", 6000)
        collector.record_handoff(4, "simulator", 3000)

        metrics = collector.build_metrics(self._make_result(), tmp_path)
        patterns = metrics["handoff_patterns"]
        assert patterns["total_handoffs"] == 4
        assert patterns["sequence"] == ["executor", "simulator", "executor", "simulator"]
        assert patterns["per_agent"]["executor"]["turn_count"] == 2
        assert patterns["per_agent"]["executor"]["total_duration_ms"] == 10000
        assert patterns["per_agent"]["executor"]["avg_turn_duration_ms"] == 5000
        assert patterns["per_agent"]["simulator"]["turn_count"] == 2
        assert patterns["per_agent"]["simulator"]["avg_turn_duration_ms"] == 2500

    def test_errors_section(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        (tmp_path / "aidlc-docs").mkdir()

        collector = MetricsCollector(RunnerConfig())
        collector.record_error("throttle", "Rate exceeded")
        collector.record_error("throttle", "Rate exceeded again")
        collector.record_error("model_error", "Model stream failed")

        metrics = collector.build_metrics(self._make_result(), tmp_path)
        errors = metrics["errors"]
        assert errors["throttle_events"] == 2
        assert errors["model_error_events"] == 1
        assert errors["timeout_events"] == 0
        assert len(errors["details"]) == 3

    def test_model_params_from_config(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        (tmp_path / "aidlc-docs").mkdir()

        config = RunnerConfig()
        collector = MetricsCollector(config)
        metrics = collector.build_metrics(self._make_result(), tmp_path)

        params = metrics["model_params"]
        assert params["executor"]["model_id"] == config.models.executor.model_id
        assert params["simulator"]["model_id"] == config.models.simulator.model_id
        assert params["aws_region"] == config.aws.region


class TestContextSizeStats:
    def test_compute_context_stats_basic(self):
        stats = MetricsCollector._compute_context_stats([10000, 50000, 30000, 90000])
        assert stats["min_tokens"] == 10000
        assert stats["max_tokens"] == 90000
        assert stats["avg_tokens"] == 45000
        assert stats["median_tokens"] == 40000  # median of [10000, 30000, 50000, 90000]
        assert stats["sample_count"] == 4

    def test_compute_context_stats_single(self):
        stats = MetricsCollector._compute_context_stats([42000])
        assert stats["min_tokens"] == 42000
        assert stats["max_tokens"] == 42000
        assert stats["avg_tokens"] == 42000
        assert stats["median_tokens"] == 42000
        assert stats["sample_count"] == 1

    def test_compute_context_stats_empty(self):
        stats = MetricsCollector._compute_context_stats([])
        assert stats["min_tokens"] == 0
        assert stats["max_tokens"] == 0
        assert stats["avg_tokens"] == 0
        assert stats["median_tokens"] == 0
        assert stats["sample_count"] == 0

    def test_context_size_in_build_metrics(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        (tmp_path / "aidlc-docs").mkdir()

        collector = MetricsCollector(RunnerConfig())
        collector.record_context_sample("executor", 25000)
        collector.record_context_sample("executor", 75000)
        collector.record_context_sample("simulator", 12000)

        result = FakeMultiAgentResult(
            accumulated_usage={"inputTokens": 100, "outputTokens": 50, "totalTokens": 150},
            results={"executor": FakeNodeResult(), "simulator": FakeNodeResult()},
            execution_time=1000,
        )
        metrics = collector.build_metrics(result, tmp_path)

        ctx = metrics["context_size"]
        assert ctx["total"]["sample_count"] == 3
        assert ctx["total"]["min_tokens"] == 12000
        assert ctx["total"]["max_tokens"] == 75000

        assert ctx["per_agent"]["executor"]["sample_count"] == 2
        assert ctx["per_agent"]["executor"]["min_tokens"] == 25000
        assert ctx["per_agent"]["executor"]["max_tokens"] == 75000

        assert ctx["per_agent"]["simulator"]["sample_count"] == 1
        assert ctx["per_agent"]["simulator"]["min_tokens"] == 12000

        assert len(ctx["samples"]) == 3

    def test_context_size_empty_when_no_samples(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        (tmp_path / "aidlc-docs").mkdir()

        collector = MetricsCollector(RunnerConfig())
        result = FakeMultiAgentResult(
            accumulated_usage={"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
            results={"executor": FakeNodeResult()},
            execution_time=1000,
        )
        metrics = collector.build_metrics(result, tmp_path)

        ctx = metrics["context_size"]
        assert ctx["total"]["sample_count"] == 0
        assert ctx["total"]["min_tokens"] == 0
        assert ctx["per_agent"] == {}
        assert ctx["samples"] == []


class TestMetricsCollectorWrite:
    def test_write_produces_valid_yaml(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        (tmp_path / "aidlc-docs").mkdir()

        result = FakeMultiAgentResult(
            accumulated_usage={"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
            results={"executor": FakeNodeResult(accumulated_usage={
                "inputTokens": 10, "outputTokens": 5, "totalTokens": 15,
            })},
            execution_time=1000,
        )

        collector = MetricsCollector(RunnerConfig())
        out_path = collector.write(result, tmp_path)

        assert out_path == tmp_path / "run-metrics.yaml"
        assert out_path.exists()

        with open(out_path) as f:
            data = yaml.safe_load(f)

        # Verify top-level keys
        assert "tokens" in data
        assert "timing" in data
        assert "handoff_patterns" in data
        assert "artifacts" in data
        assert "errors" in data
        assert "model_params" in data
        assert "context_size" in data


# ---------------------------------------------------------------------------
# Progress hooks integration with MetricsCollector
# ---------------------------------------------------------------------------


class TestAgentProgressHandlerContextSamples:
    def test_metadata_event_records_context_sample(self):
        collector = MetricsCollector(RunnerConfig())
        handler = AgentProgressHandler("executor", collector=collector)

        handler(event={"metadata": {"usage": {"inputTokens": 54321, "outputTokens": 1234, "totalTokens": 55555}}})

        assert len(collector._context_samples) == 1
        assert collector._context_samples[0] == {"agent": "executor", "input_tokens": 54321}

    def test_metadata_event_zero_tokens_skipped(self):
        collector = MetricsCollector(RunnerConfig())
        handler = AgentProgressHandler("executor", collector=collector)

        handler(event={"metadata": {"usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}}})

        assert len(collector._context_samples) == 0

    def test_metadata_event_no_collector_does_not_crash(self):
        handler = AgentProgressHandler("executor", collector=None)
        handler(event={"metadata": {"usage": {"inputTokens": 10000}}})

    def test_metadata_event_missing_usage_key(self):
        collector = MetricsCollector(RunnerConfig())
        handler = AgentProgressHandler("executor", collector=collector)

        handler(event={"metadata": {"metrics": {"latencyMs": 100}}})

        assert len(collector._context_samples) == 0

    def test_multiple_metadata_events_accumulated(self):
        collector = MetricsCollector(RunnerConfig())
        handler = AgentProgressHandler("executor", collector=collector)

        handler(event={"metadata": {"usage": {"inputTokens": 10000}}})
        handler(event={"metadata": {"usage": {"inputTokens": 30000}}})
        handler(event={"metadata": {"usage": {"inputTokens": 80000}}})

        assert len(collector._context_samples) == 3
        tokens = [s["input_tokens"] for s in collector._context_samples]
        assert tokens == [10000, 30000, 80000]


class TestAgentProgressHandlerErrors:
    def test_throttle_event_recorded(self):
        collector = MetricsCollector(RunnerConfig())
        handler = AgentProgressHandler("executor", collector=collector)

        handler(event={"throttlingException": {"message": "Rate exceeded"}})

        assert len(collector._errors) == 1
        assert collector._errors[0]["type"] == "throttle"
        assert "executor" in collector._errors[0]["message"]
        assert "Rate exceeded" in collector._errors[0]["message"]

    def test_model_stream_error_recorded(self):
        collector = MetricsCollector(RunnerConfig())
        handler = AgentProgressHandler("simulator", collector=collector)

        handler(event={"modelStreamErrorException": {"message": "Stream broken"}})

        assert len(collector._errors) == 1
        assert collector._errors[0]["type"] == "model_error"

    def test_service_unavailable_recorded(self):
        collector = MetricsCollector(RunnerConfig())
        handler = AgentProgressHandler("executor", collector=collector)

        handler(event={"serviceUnavailableException": {"message": "Service down"}})

        assert len(collector._errors) == 1
        assert collector._errors[0]["type"] == "service_unavailable"

    def test_no_collector_does_not_crash(self):
        handler = AgentProgressHandler("executor", collector=None)
        # Should not raise even with error events
        handler(event={"throttlingException": {"message": "Rate exceeded"}})

    def test_non_error_event_not_recorded(self):
        collector = MetricsCollector(RunnerConfig())
        handler = AgentProgressHandler("executor", collector=collector)

        handler(event={"contentBlockStart": {"start": {"toolUse": {"name": "write_file"}}}})

        assert len(collector._errors) == 0

    def test_tool_count_still_works_with_collector(self):
        collector = MetricsCollector(RunnerConfig())
        handler = AgentProgressHandler("executor", collector=collector)

        handler(event={"contentBlockStart": {"start": {"toolUse": {"name": "write_file"}}}})
        handler(event={"contentBlockStart": {"start": {"toolUse": {"name": "read_file"}}}})

        assert handler.tool_count == 2


class TestSwarmProgressHookRecording:
    def test_handoff_recorded_to_collector(self):
        collector = MetricsCollector(RunnerConfig())
        hook = SwarmProgressHook(collector=collector)

        # Simulate before/after node events
        before_event = _FakeBeforeNodeCallEvent("executor")
        hook._on_before_node(before_event)

        after_event = _FakeAfterNodeCallEvent("executor")
        hook._on_after_node(after_event)

        assert len(collector._handoffs) == 1
        assert collector._handoffs[0]["handoff"] == 1
        assert collector._handoffs[0]["node_id"] == "executor"
        assert collector._handoffs[0]["duration_ms"] >= 0

    def test_multiple_handoffs_numbered(self):
        collector = MetricsCollector(RunnerConfig())
        hook = SwarmProgressHook(collector=collector)

        for node_id in ["executor", "simulator", "executor"]:
            hook._on_before_node(_FakeBeforeNodeCallEvent(node_id))
            hook._on_after_node(_FakeAfterNodeCallEvent(node_id))

        assert len(collector._handoffs) == 3
        assert collector._handoffs[0]["handoff"] == 1
        assert collector._handoffs[1]["handoff"] == 2
        assert collector._handoffs[2]["handoff"] == 3

    def test_no_collector_does_not_crash(self):
        hook = SwarmProgressHook(collector=None)
        hook._on_before_node(_FakeBeforeNodeCallEvent("executor"))
        hook._on_after_node(_FakeAfterNodeCallEvent("executor"))
        # No exception raised


# ---------------------------------------------------------------------------
# Fake hook events (minimal stubs for testing)
# ---------------------------------------------------------------------------


class _FakeBeforeNodeCallEvent:
    def __init__(self, node_id: str):
        self.node_id = node_id


class _FakeAfterNodeCallEvent:
    def __init__(self, node_id: str):
        self.node_id = node_id
