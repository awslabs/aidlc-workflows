"""Golden baseline: promote a run's metrics and compare against them.

A golden.yaml captures the key numeric metrics from a run so future runs
can be compared for regressions or improvements without re-reading all
the individual YAML artifacts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from reporting.collector import ReportData, collect


@dataclass
class BaselineMetrics:
    """Flat numeric snapshot of a run's key evaluation metrics."""

    # Identity
    run_folder: str = ""
    promoted_at: str = ""
    executor_model: str = ""
    simulator_model: str = ""

    # Execution (aggregate)
    wall_clock_ms: int = 0
    total_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    handoffs: int = 0

    # Execution (per-agent tokens)
    executor_input_tokens: int = 0
    executor_output_tokens: int = 0
    executor_total_tokens: int = 0
    simulator_input_tokens: int = 0
    simulator_output_tokens: int = 0
    simulator_total_tokens: int = 0

    # Execution (repeated context and API totals)
    repeated_context_input_tokens: int = 0
    repeated_context_output_tokens: int = 0
    repeated_context_total_tokens: int = 0
    api_total_input_tokens: int = 0
    api_total_output_tokens: int = 0
    api_total_total_tokens: int = 0

    # Context size
    context_size_max: int = 0
    context_size_avg: int = 0
    context_size_median: int = 0

    # Artifacts
    source_files: int = 0
    test_files: int = 0
    total_files: int = 0
    lines_of_code: int = 0
    doc_files: int = 0

    # Unit tests
    tests_passed: int = 0
    tests_failed: int = 0
    tests_total: int = 0
    tests_pass_pct: float = 0.0
    coverage_pct: float | None = None

    # Contract tests
    contract_passed: int = 0
    contract_failed: int = 0
    contract_total: int = 0

    # Code quality
    lint_errors: int = 0
    lint_warnings: int = 0
    lint_total: int = 0
    security_total: int = 0
    security_high: int = 0
    duplication_blocks: int = 0

    # Qualitative
    qualitative_score: float = 0.0
    inception_score: float = 0.0
    construction_score: float = 0.0


def extract_baseline(data: ReportData) -> BaselineMetrics:
    """Extract a flat BaselineMetrics from a fully-collected ReportData."""
    b = BaselineMetrics(
        run_folder=data.meta.run_folder,
        promoted_at=datetime.now(UTC).isoformat(timespec="seconds"),
        executor_model=data.meta.executor_model,
        simulator_model=data.meta.simulator_model,
        wall_clock_ms=data.metrics.wall_clock_ms,
        total_tokens=data.metrics.total_tokens.total_tokens,
        input_tokens=data.metrics.total_tokens.input_tokens,
        output_tokens=data.metrics.total_tokens.output_tokens,
        handoffs=data.meta.total_handoffs,
        executor_input_tokens=data.metrics.executor_tokens.input_tokens,
        executor_output_tokens=data.metrics.executor_tokens.output_tokens,
        executor_total_tokens=data.metrics.executor_tokens.total_tokens,
        simulator_input_tokens=data.metrics.simulator_tokens.input_tokens,
        simulator_output_tokens=data.metrics.simulator_tokens.output_tokens,
        simulator_total_tokens=data.metrics.simulator_tokens.total_tokens,
        repeated_context_input_tokens=data.metrics.repeated_context_tokens.input_tokens,
        repeated_context_output_tokens=data.metrics.repeated_context_tokens.output_tokens,
        repeated_context_total_tokens=data.metrics.repeated_context_tokens.total_tokens,
        api_total_input_tokens=data.metrics.api_total_tokens.input_tokens,
        api_total_output_tokens=data.metrics.api_total_tokens.output_tokens,
        api_total_total_tokens=data.metrics.api_total_tokens.total_tokens,
        source_files=data.metrics.artifacts.source_files,
        test_files=data.metrics.artifacts.test_files,
        total_files=data.metrics.artifacts.total_files,
        lines_of_code=data.metrics.artifacts.total_lines_of_code,
        doc_files=data.metrics.artifacts.total_doc_files,
    )

    if data.metrics.context_size_total:
        b.context_size_max = data.metrics.context_size_total.max_tokens
        b.context_size_avg = data.metrics.context_size_total.avg_tokens
        b.context_size_median = data.metrics.context_size_total.median_tokens

    if data.tests:
        b.tests_passed = data.tests.passed
        b.tests_failed = data.tests.failed
        b.tests_total = data.tests.total
        b.tests_pass_pct = data.tests.pass_pct
        b.coverage_pct = data.tests.coverage_pct

    if data.contracts:
        b.contract_passed = data.contracts.passed
        b.contract_failed = data.contracts.failed
        b.contract_total = data.contracts.total

    if data.quality:
        b.lint_errors = data.quality.lint_errors
        b.lint_warnings = data.quality.lint_warnings
        b.lint_total = data.quality.lint_total
        b.security_total = data.quality.security_total
        b.security_high = data.quality.security_high
        b.duplication_blocks = data.quality.duplication_blocks

    if data.qualitative:
        b.qualitative_score = data.qualitative.overall_score
        for phase in data.qualitative.phases:
            if phase.phase == "inception":
                b.inception_score = phase.avg_overall
            elif phase.phase == "construction":
                b.construction_score = phase.avg_overall

    return b


def write_baseline(baseline: BaselineMetrics, path: Path) -> None:
    """Write a golden.yaml file."""
    d: dict[str, Any] = {
        "run_folder": baseline.run_folder,
        "promoted_at": baseline.promoted_at,
        "executor_model": baseline.executor_model,
        "simulator_model": baseline.simulator_model,
        "execution": {
            "wall_clock_ms": baseline.wall_clock_ms,
            "total_tokens": baseline.total_tokens,
            "input_tokens": baseline.input_tokens,
            "output_tokens": baseline.output_tokens,
            "handoffs": baseline.handoffs,
            "executor": {
                "input_tokens": baseline.executor_input_tokens,
                "output_tokens": baseline.executor_output_tokens,
                "total_tokens": baseline.executor_total_tokens,
            },
            "simulator": {
                "input_tokens": baseline.simulator_input_tokens,
                "output_tokens": baseline.simulator_output_tokens,
                "total_tokens": baseline.simulator_total_tokens,
            },
            "repeated_context": {
                "input_tokens": baseline.repeated_context_input_tokens,
                "output_tokens": baseline.repeated_context_output_tokens,
                "total_tokens": baseline.repeated_context_total_tokens,
            },
            "api_total": {
                "input_tokens": baseline.api_total_input_tokens,
                "output_tokens": baseline.api_total_output_tokens,
                "total_tokens": baseline.api_total_total_tokens,
            },
        },
        "context_size": {
            "max_tokens": baseline.context_size_max,
            "avg_tokens": baseline.context_size_avg,
            "median_tokens": baseline.context_size_median,
        },
        "artifacts": {
            "source_files": baseline.source_files,
            "test_files": baseline.test_files,
            "total_files": baseline.total_files,
            "lines_of_code": baseline.lines_of_code,
            "doc_files": baseline.doc_files,
        },
        "unit_tests": {
            "passed": baseline.tests_passed,
            "failed": baseline.tests_failed,
            "total": baseline.tests_total,
            "pass_pct": baseline.tests_pass_pct,
            "coverage_pct": baseline.coverage_pct,
        },
        "contract_tests": {
            "passed": baseline.contract_passed,
            "failed": baseline.contract_failed,
            "total": baseline.contract_total,
        },
        "code_quality": {
            "lint_errors": baseline.lint_errors,
            "lint_warnings": baseline.lint_warnings,
            "lint_total": baseline.lint_total,
            "security_total": baseline.security_total,
            "security_high": baseline.security_high,
            "duplication_blocks": baseline.duplication_blocks,
        },
        "qualitative": {
            "overall_score": baseline.qualitative_score,
            "inception_score": baseline.inception_score,
            "construction_score": baseline.construction_score,
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(d, f, default_flow_style=False, sort_keys=False)


def load_baseline(path: Path) -> BaselineMetrics:
    """Read a golden.yaml into a BaselineMetrics."""
    with open(path, encoding="utf-8") as f:
        d = yaml.safe_load(f) or {}
    ex = d.get("execution", {})
    ex_agent = ex.get("executor", {})
    si_agent = ex.get("simulator", {})
    repeated = ex.get("repeated_context", {})
    api_tot = ex.get("api_total", {})
    ctx = d.get("context_size", {})
    art = d.get("artifacts", {})
    ut = d.get("unit_tests", {})
    ct = d.get("contract_tests", {})
    cq = d.get("code_quality", {})
    ql = d.get("qualitative", {})
    return BaselineMetrics(
        run_folder=d.get("run_folder", ""),
        promoted_at=d.get("promoted_at", ""),
        executor_model=d.get("executor_model", ""),
        simulator_model=d.get("simulator_model", ""),
        wall_clock_ms=ex.get("wall_clock_ms", 0),
        total_tokens=ex.get("total_tokens", 0),
        input_tokens=ex.get("input_tokens", 0),
        output_tokens=ex.get("output_tokens", 0),
        handoffs=ex.get("handoffs", 0),
        executor_input_tokens=ex_agent.get("input_tokens", 0),
        executor_output_tokens=ex_agent.get("output_tokens", 0),
        executor_total_tokens=ex_agent.get("total_tokens", 0),
        simulator_input_tokens=si_agent.get("input_tokens", 0),
        simulator_output_tokens=si_agent.get("output_tokens", 0),
        simulator_total_tokens=si_agent.get("total_tokens", 0),
        repeated_context_input_tokens=repeated.get("input_tokens", 0),
        repeated_context_output_tokens=repeated.get("output_tokens", 0),
        repeated_context_total_tokens=repeated.get("total_tokens", 0),
        api_total_input_tokens=api_tot.get("input_tokens", 0),
        api_total_output_tokens=api_tot.get("output_tokens", 0),
        api_total_total_tokens=api_tot.get("total_tokens", 0),
        context_size_max=ctx.get("max_tokens", 0),
        context_size_avg=ctx.get("avg_tokens", 0),
        context_size_median=ctx.get("median_tokens", 0),
        source_files=art.get("source_files", 0),
        test_files=art.get("test_files", 0),
        total_files=art.get("total_files", 0),
        lines_of_code=art.get("lines_of_code", 0),
        doc_files=art.get("doc_files", 0),
        tests_passed=ut.get("passed", 0),
        tests_failed=ut.get("failed", 0),
        tests_total=ut.get("total", 0),
        tests_pass_pct=ut.get("pass_pct", 0.0),
        coverage_pct=ut.get("coverage_pct"),
        contract_passed=ct.get("passed", 0),
        contract_failed=ct.get("failed", 0),
        contract_total=ct.get("total", 0),
        lint_errors=cq.get("lint_errors", 0),
        lint_warnings=cq.get("lint_warnings", 0),
        lint_total=cq.get("lint_total", 0),
        security_total=cq.get("security_total", 0),
        security_high=cq.get("security_high", 0),
        duplication_blocks=cq.get("duplication_blocks", 0),
        qualitative_score=ql.get("overall_score", 0),
        inception_score=ql.get("inception_score", 0),
        construction_score=ql.get("construction_score", 0),
    )


def promote(run_folder: Path, golden_path: Path) -> BaselineMetrics:
    """Collect a run's data and write it as a golden baseline."""
    data = collect(run_folder)
    baseline = extract_baseline(data)
    write_baseline(baseline, golden_path)
    return baseline


def promote_for_scenario(run_folder: Path, scenario_path: Path) -> BaselineMetrics:
    """Promote a run as the golden baseline for a scenario.

    Writes ``golden.yaml`` into *scenario_path* (the test-case directory).
    If the scenario has a ``scenario.yaml`` manifest, the ``golden_baseline``
    field is used to determine the filename; otherwise defaults to
    ``golden.yaml``.
    """
    golden_name = "golden.yaml"
    manifest = scenario_path / "scenario.yaml"
    if manifest.is_file():
        with open(manifest, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        golden_name = data.get("golden_baseline", golden_name)

    golden_path = scenario_path / golden_name
    return promote(run_folder, golden_path)


# ── Comparison ──────────────────────────────────────────────────────────


@dataclass
class MetricDelta:
    """A single metric compared between current run and golden baseline."""
    name: str
    category: str
    current: float | int | None
    golden: float | int | None
    delta: float | None = None
    pct_change: float | None = None
    direction: str = "unchanged"  # "improved", "regressed", "unchanged", "new"
    higher_is_better: bool = True


@dataclass
class ComparisonResult:
    """Full comparison of a run against a golden baseline."""
    golden_run: str = ""
    golden_promoted_at: str = ""
    current_run: str = ""
    improved: int = 0
    regressed: int = 0
    unchanged: int = 0
    deltas: list[MetricDelta] = field(default_factory=list)


def _classify(current: float | int | None, golden: float | int | None,
              higher_is_better: bool, tolerance: float = 0.001) -> tuple[str, float | None, float | None]:
    """Return (direction, delta, pct_change)."""
    if current is None or golden is None:
        return ("new" if golden is None else "unchanged"), None, None
    delta = float(current) - float(golden)
    pct = (delta / float(golden) * 100) if golden != 0 else (100.0 if delta != 0 else 0.0)
    if abs(delta) <= tolerance:
        return "unchanged", delta, pct
    if higher_is_better:
        return ("improved" if delta > 0 else "regressed"), delta, pct
    else:
        return ("improved" if delta < 0 else "regressed"), delta, pct


def compare(current: BaselineMetrics, golden: BaselineMetrics) -> ComparisonResult:
    """Compare current run metrics against a golden baseline."""
    result = ComparisonResult(
        golden_run=golden.run_folder,
        golden_promoted_at=golden.promoted_at,
        current_run=current.run_folder,
    )

    metrics_spec: list[tuple[str, str, Any, Any, bool]] = [
        # (name, category, current_val, golden_val, higher_is_better)
        ("Tests Pass %", "Unit Tests", current.tests_pass_pct, golden.tests_pass_pct, True),
        ("Tests Failed", "Unit Tests", current.tests_failed, golden.tests_failed, False),
        ("Coverage %", "Unit Tests", current.coverage_pct, golden.coverage_pct, True),
        ("Contract Passed", "Contract Tests", current.contract_passed, golden.contract_passed, True),
        ("Contract Failed", "Contract Tests", current.contract_failed, golden.contract_failed, False),
        ("Contract Total", "Contract Tests", current.contract_total, golden.contract_total, True),
        ("Lint Errors", "Code Quality", current.lint_errors, golden.lint_errors, False),
        ("Lint Warnings", "Code Quality", current.lint_warnings, golden.lint_warnings, False),
        ("Lint Total", "Code Quality", current.lint_total, golden.lint_total, False),
        ("Security Findings", "Code Quality", current.security_total, golden.security_total, False),
        ("Security High", "Code Quality", current.security_high, golden.security_high, False),
        ("Duplication Blocks", "Code Quality", current.duplication_blocks, golden.duplication_blocks, False),
        ("Qualitative Score", "Qualitative", current.qualitative_score, golden.qualitative_score, True),
        ("Inception Score", "Qualitative", current.inception_score, golden.inception_score, True),
        ("Construction Score", "Qualitative", current.construction_score, golden.construction_score, True),
        ("Source Files", "Artifacts", current.source_files, golden.source_files, True),
        ("Test Files", "Artifacts", current.test_files, golden.test_files, True),
        ("Lines of Code", "Artifacts", current.lines_of_code, golden.lines_of_code, True),
        ("Doc Files", "Artifacts", current.doc_files, golden.doc_files, True),
        ("Total Tokens", "Execution", current.total_tokens, golden.total_tokens, False),
        ("Executor Input Tokens", "Execution", current.executor_input_tokens, golden.executor_input_tokens, False),
        ("Executor Total Tokens", "Execution", current.executor_total_tokens, golden.executor_total_tokens, False),
        ("Simulator Input Tokens", "Execution", current.simulator_input_tokens, golden.simulator_input_tokens, False),
        ("Simulator Total Tokens", "Execution", current.simulator_total_tokens, golden.simulator_total_tokens, False),
        ("Repeated Context Tokens", "Execution", current.repeated_context_total_tokens, golden.repeated_context_total_tokens, False),
        ("API Total Tokens", "Execution", current.api_total_total_tokens, golden.api_total_total_tokens, False),
        ("Wall Clock (ms)", "Execution", current.wall_clock_ms, golden.wall_clock_ms, False),
        ("Handoffs", "Execution", current.handoffs, golden.handoffs, False),
        ("Context Size Max", "Context Size", current.context_size_max, golden.context_size_max, False),
        ("Context Size Avg", "Context Size", current.context_size_avg, golden.context_size_avg, False),
        ("Context Size Median", "Context Size", current.context_size_median, golden.context_size_median, False),
    ]

    for name, category, cur, gld, hib in metrics_spec:
        direction, delta, pct = _classify(cur, gld, hib)
        result.deltas.append(MetricDelta(
            name=name, category=category,
            current=cur, golden=gld,
            delta=delta, pct_change=pct,
            direction=direction, higher_is_better=hib,
        ))
        if direction == "improved":
            result.improved += 1
        elif direction == "regressed":
            result.regressed += 1
        else:
            result.unchanged += 1

    return result


def compare_run_to_baseline(run_folder: Path, golden_path: Path) -> ComparisonResult:
    """Convenience: collect a run, load a baseline, and compare."""
    data = collect(run_folder)
    current = extract_baseline(data)
    golden = load_baseline(golden_path)
    return compare(current, golden)


def compare_run_for_scenario(run_folder: Path, scenario_path: Path) -> ComparisonResult:
    """Compare a run against the golden baseline for a scenario.

    Reads the ``golden_baseline`` filename from ``scenario.yaml`` in
    *scenario_path*, falling back to ``golden.yaml``.
    """
    golden_name = "golden.yaml"
    manifest = scenario_path / "scenario.yaml"
    if manifest.is_file():
        with open(manifest, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        golden_name = data.get("golden_baseline", golden_name)

    golden_path = scenario_path / golden_name
    return compare_run_to_baseline(run_folder, golden_path)
