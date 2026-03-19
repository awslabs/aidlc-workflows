"""Collect all run artifacts into a unified report data structure."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml


@dataclass
class RunMeta:
    run_folder: str = ""
    started_at: str = ""
    completed_at: str = ""
    status: str = ""
    execution_time_ms: int = 0
    total_handoffs: int = 0
    node_history: list[str] = field(default_factory=list)
    executor_model: str = ""
    simulator_model: str = ""
    aws_region: str = ""
    rules_source: str = ""
    rules_repo: str = ""
    rules_ref: str = ""
    rules_local_path: str = ""
    vision_file: str = ""
    tech_env_file: str = ""


@dataclass
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


@dataclass
class HandoffTiming:
    handoff: int = 0
    node_id: str = ""
    duration_ms: int = 0


@dataclass
class Artifacts:
    source_files: int = 0
    test_files: int = 0
    config_files: int = 0
    total_files: int = 0
    total_lines_of_code: int = 0
    inception_files: int = 0
    construction_files: int = 0
    total_doc_files: int = 0


@dataclass
class ContextSizeStats:
    min_tokens: int = 0
    max_tokens: int = 0
    avg_tokens: int = 0
    median_tokens: int = 0
    sample_count: int = 0


@dataclass
class RunMetrics:
    total_tokens: TokenUsage = field(default_factory=TokenUsage)
    executor_tokens: TokenUsage = field(default_factory=TokenUsage)
    simulator_tokens: TokenUsage = field(default_factory=TokenUsage)
    repeated_context_tokens: TokenUsage = field(default_factory=TokenUsage)
    api_total_tokens: TokenUsage = field(default_factory=TokenUsage)
    wall_clock_ms: int = 0
    handoffs: list[HandoffTiming] = field(default_factory=list)
    artifacts: Artifacts = field(default_factory=Artifacts)
    errors: dict[str, int] = field(default_factory=dict)
    context_size_total: ContextSizeStats | None = None
    context_size_executor: ContextSizeStats | None = None
    context_size_simulator: ContextSizeStats | None = None


@dataclass
class TestResults:
    status: str = ""
    install_ok: bool = False
    test_ok: bool = False
    passed: int = 0
    failed: int = 0
    errors: int = 0
    total: int = 0
    pass_pct: float = 0.0
    coverage_pct: float | None = None


@dataclass
class LintFinding:
    file: str = ""
    line: int = 0
    code: str = ""
    message: str = ""
    severity: str = ""


@dataclass
class QualityReport:
    project_type: str = ""
    lint_tool: str = ""
    lint_version: str = ""
    lint_available: bool = False
    lint_findings: list[LintFinding] = field(default_factory=list)
    lint_total: int = 0
    lint_errors: int = 0
    lint_warnings: int = 0
    security_tool: str = ""
    security_available: bool = False
    security_total: int = 0
    security_high: int = 0
    semgrep_tool: str = ""
    semgrep_available: bool = False
    semgrep_total: int = 0
    semgrep_high: int = 0
    duplication_tool: str = ""
    duplication_available: bool = False
    duplication_blocks: int = 0
    duplication_lines: int = 0


@dataclass
class ContractCase:
    name: str = ""
    path: str = ""
    method: str = ""
    passed: bool = False
    expected_status: int = 0
    actual_status: int | None = None
    failures: list[str] = field(default_factory=list)
    latency_ms: float | None = None
    error: str | None = None


@dataclass
class ContractResults:
    total: int = 0
    passed: int = 0
    failed: int = 0
    errors: int = 0
    server_started: bool = False
    server_error: str | None = None
    cases: list[ContractCase] = field(default_factory=list)


@dataclass
class DocScore:
    path: str = ""
    intent: float = 0.0
    design: float = 0.0
    completeness: float = 0.0
    overall: float = 0.0
    notes: str = ""


@dataclass
class PhaseScore:
    phase: str = ""
    avg_intent: float = 0.0
    avg_design: float = 0.0
    avg_completeness: float = 0.0
    avg_overall: float = 0.0
    documents: list[DocScore] = field(default_factory=list)


@dataclass
class QualitativeResults:
    overall_score: float = 0.0
    phases: list[PhaseScore] = field(default_factory=list)
    unmatched_reference: list[str] = field(default_factory=list)
    unmatched_candidate: list[str] = field(default_factory=list)


@dataclass
class ReportData:
    """All data needed to render a consolidated report."""
    meta: RunMeta = field(default_factory=RunMeta)
    metrics: RunMetrics = field(default_factory=RunMetrics)
    tests: TestResults | None = None
    quality: QualityReport | None = None
    contracts: ContractResults | None = None
    qualitative: QualitativeResults | None = None
    comparison: Any | None = None  # ComparisonResult when baseline exists
    generated_at: str = ""


def _load_yaml(path: Path) -> dict | None:
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _parse_coverage(test_output: str) -> float | None:
    """Extract coverage percentage from pytest output."""
    import re
    m = re.search(r"Total coverage:\s*([\d.]+)%", test_output)
    if m:
        return float(m.group(1))
    m = re.search(r"TOTAL\s+\d+\s+\d+\s+(\d+)%", test_output)
    if m:
        return float(m.group(1))
    return None


def _parse_context_stats(d: dict) -> ContextSizeStats:
    """Parse a context_size stats dict from YAML into a ContextSizeStats."""
    return ContextSizeStats(
        min_tokens=d.get("min_tokens", 0),
        max_tokens=d.get("max_tokens", 0),
        avg_tokens=d.get("avg_tokens", 0),
        median_tokens=d.get("median_tokens", 0),
        sample_count=d.get("sample_count", 0),
    )


def collect(run_folder: Path) -> ReportData:
    """Read all YAML artifacts from a run folder into a ReportData."""
    report = ReportData(generated_at=datetime.now(UTC).isoformat(timespec="seconds"))

    # ── run-meta.yaml ──────────────────────────────────────────
    raw = _load_yaml(run_folder / "run-meta.yaml")
    if raw:
        cfg = raw.get("config", {})
        report.meta = RunMeta(
            run_folder=raw.get("run_folder", str(run_folder)),
            started_at=raw.get("started_at", ""),
            completed_at=raw.get("completed_at", ""),
            status=raw.get("status", ""),
            execution_time_ms=raw.get("execution_time_ms", 0),
            total_handoffs=raw.get("total_handoffs", 0),
            node_history=raw.get("node_history", []),
            executor_model=cfg.get("executor_model", ""),
            simulator_model=cfg.get("simulator_model", ""),
            aws_region=cfg.get("aws_region", ""),
            rules_source=cfg.get("rules_source", ""),
            rules_repo=cfg.get("rules_repo") or "",
            rules_ref=cfg.get("rules_ref") or "",
            rules_local_path=cfg.get("rules_local_path") or "",
            vision_file=raw.get("vision_file", ""),
            tech_env_file=raw.get("tech_env_file", ""),
        )

    # ── run-metrics.yaml ───────────────────────────────────────
    raw = _load_yaml(run_folder / "run-metrics.yaml")
    if raw:
        tok = raw.get("tokens", {})
        tot = tok.get("total", {})
        pa = tok.get("per_agent", {})
        ex = pa.get("executor", {})
        si = pa.get("simulator", {})
        repeated = tok.get("repeated_context", {})
        api_tot = tok.get("api_total", {})
        timing = raw.get("timing", {})
        art_ws = raw.get("artifacts", {}).get("workspace", {})
        art_doc = raw.get("artifacts", {}).get("aidlc_docs", {})
        errs = raw.get("errors", {})

        handoffs = []
        for h in timing.get("handoffs", []):
            handoffs.append(HandoffTiming(
                handoff=h.get("handoff", 0),
                node_id=h.get("node_id", ""),
                duration_ms=h.get("duration_ms", 0),
            ))

        report.metrics = RunMetrics(
            total_tokens=TokenUsage(tot.get("input_tokens", 0), tot.get("output_tokens", 0), tot.get("total_tokens", 0)),
            executor_tokens=TokenUsage(ex.get("input_tokens", 0), ex.get("output_tokens", 0), ex.get("total_tokens", 0)),
            simulator_tokens=TokenUsage(si.get("input_tokens", 0), si.get("output_tokens", 0), si.get("total_tokens", 0)),
            repeated_context_tokens=TokenUsage(repeated.get("input_tokens", 0), repeated.get("output_tokens", 0), repeated.get("total_tokens", 0)),
            api_total_tokens=TokenUsage(api_tot.get("input_tokens", 0), api_tot.get("output_tokens", 0), api_tot.get("total_tokens", 0)),
            wall_clock_ms=timing.get("total_wall_clock_ms", 0),
            handoffs=handoffs,
            artifacts=Artifacts(
                source_files=art_ws.get("source_files", 0),
                test_files=art_ws.get("test_files", 0),
                config_files=art_ws.get("config_files", 0),
                total_files=art_ws.get("total_files", 0),
                total_lines_of_code=art_ws.get("total_lines_of_code", 0),
                inception_files=art_doc.get("inception_files", 0),
                construction_files=art_doc.get("construction_files", 0),
                total_doc_files=art_doc.get("total_files", 0),
            ),
            errors={k: v for k, v in errs.items() if k != "details" and isinstance(v, int)},
        )

        # Context size stats (may be absent in older runs)
        ctx = raw.get("context_size", {})
        if ctx:
            report.metrics.context_size_total = _parse_context_stats(ctx.get("total", {}))
            ctx_pa = ctx.get("per_agent", {})
            if "executor" in ctx_pa:
                report.metrics.context_size_executor = _parse_context_stats(ctx_pa["executor"])
            if "simulator" in ctx_pa:
                report.metrics.context_size_simulator = _parse_context_stats(ctx_pa["simulator"])

    # ── test-results.yaml ──────────────────────────────────────
    raw = _load_yaml(run_folder / "test-results.yaml")
    if raw:
        parsed = raw.get("test", {}).get("parsed_results", {})
        test_output = raw.get("test", {}).get("output", "")
        _passed = parsed.get("passed") or 0
        _total = parsed.get("total") or 0
        report.tests = TestResults(
            status=raw.get("status", ""),
            install_ok=raw.get("install", {}).get("success", False),
            test_ok=raw.get("test", {}).get("success", False),
            passed=_passed,
            failed=parsed.get("failed") or 0,
            errors=parsed.get("errors") or 0,
            total=_total,
            pass_pct=(_passed / _total * 100) if _total > 0 else 0.0,
            coverage_pct=_parse_coverage(test_output),
        )

    # ── quality-report.yaml ────────────────────────────────────
    raw = _load_yaml(run_folder / "quality-report.yaml")
    if raw:
        lint = raw.get("lint", {})
        sec = raw.get("security", {})
        sem = raw.get("semgrep", {})
        dup = raw.get("duplication", {})
        summary = raw.get("summary", {})
        findings = []
        for f in lint.get("findings", []):
            findings.append(LintFinding(
                file=Path(f.get("file", "")).name,
                line=f.get("line", 0),
                code=f.get("code", ""),
                message=f.get("message", ""),
                severity=f.get("severity", ""),
            ))
        report.quality = QualityReport(
            project_type=raw.get("project_type", ""),
            lint_tool=lint.get("tool", ""),
            lint_version=lint.get("version") or "",
            lint_available=lint.get("available", False),
            lint_findings=findings,
            lint_total=summary.get("lint_total", 0),
            lint_errors=summary.get("lint_errors", 0),
            lint_warnings=summary.get("lint_warnings", 0),
            security_tool=sec.get("tool", ""),
            security_available=sec.get("available", False),
            security_total=summary.get("security_total", 0),
            security_high=summary.get("security_high", 0),
            semgrep_tool=sem.get("tool", ""),
            semgrep_available=sem.get("available", False),
            semgrep_total=len(sem.get("findings", [])),
            semgrep_high=sum(1 for f in sem.get("findings", []) if f.get("severity") == "high"),
            duplication_tool=dup.get("tool", ""),
            duplication_available=dup.get("available", False),
            duplication_blocks=summary.get("duplication_blocks", 0),
            duplication_lines=summary.get("duplication_lines", 0),
        )

    # ── contract-test-results.yaml ─────────────────────────────
    raw = _load_yaml(run_folder / "contract-test-results.yaml")
    if raw:
        cases = []
        for c in raw.get("cases", []):
            cases.append(ContractCase(
                name=c.get("name", ""),
                path=c.get("path", ""),
                method=c.get("method", ""),
                passed=c.get("passed", False),
                expected_status=c.get("expected_status", 0),
                actual_status=c.get("actual_status"),
                failures=c.get("failures", []),
                latency_ms=c.get("latency_ms"),
                error=c.get("error"),
            ))
        report.contracts = ContractResults(
            total=raw.get("total", 0),
            passed=raw.get("passed", 0),
            failed=raw.get("failed", 0),
            errors=raw.get("errors", 0),
            server_started=raw.get("server_started", False),
            server_error=raw.get("server_error"),
            cases=cases,
        )

    # ── qualitative-comparison.yaml ────────────────────────────
    raw = _load_yaml(run_folder / "qualitative-comparison.yaml")
    if raw:
        phases = []
        for p in raw.get("phases", []):
            docs = []
            for d in p.get("documents", []):
                docs.append(DocScore(
                    path=d.get("path", ""),
                    intent=d.get("intent_similarity", 0),
                    design=d.get("design_similarity", 0),
                    completeness=d.get("completeness", 0),
                    overall=d.get("overall", 0),
                    notes=d.get("notes", ""),
                ))
            phases.append(PhaseScore(
                phase=p.get("phase", ""),
                avg_intent=p.get("avg_intent", 0),
                avg_design=p.get("avg_design", 0),
                avg_completeness=p.get("avg_completeness", 0),
                avg_overall=p.get("avg_overall", 0),
                documents=docs,
            ))
        report.qualitative = QualitativeResults(
            overall_score=raw.get("overall_score", 0),
            phases=phases,
            unmatched_reference=raw.get("unmatched_reference", []),
            unmatched_candidate=raw.get("unmatched_candidate", []),
        )

    return report
