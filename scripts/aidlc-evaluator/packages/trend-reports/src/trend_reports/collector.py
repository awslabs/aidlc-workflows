"""Zip/directory extraction, YAML parsing, run classification, and trend assembly."""

from __future__ import annotations

import logging
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .models import (
    AgentTokens,
    BaselineMetrics,
    CodeQualityMetrics,
    CollectorError,
    ContractTestFailure,
    ContractTestResults,
    DocumentScore,
    HandoffMetrics,
    QualitativeComparison,
    RunConfig,
    RunData,
    RunMeta,
    RunMetrics,
    RunType,
    SemVer,
    TrendData,
    UnitTestResults,
    VersionDelta,
)

logger = logging.getLogger(__name__)

# The YAML files we expect inside every report bundle (zip or directory).
REQUIRED_YAML = {
    "run-meta": "run-meta.yaml",
    "run-metrics": "run-metrics.yaml",
    "test-results": "test-results.yaml",
    "contract-test-results": "contract-test-results.yaml",
    "quality-report": "quality-report.yaml",
    "qualitative-comparison": "qualitative-comparison.yaml",
}


# ---------------------------------------------------------------------------
# Zip handling
# ---------------------------------------------------------------------------


def extract_zip(zip_path: Path, dest_dir: Path) -> Path:
    """Extract a report zip and return the directory containing the YAML files.

    The zips are flat (files at root level), so we extract into a
    subdirectory named after the zip stem.
    """
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            subdir = dest_dir / zip_path.stem
            subdir.mkdir(parents=True, exist_ok=True)
            zf.extractall(subdir)
    except zipfile.BadZipFile as exc:
        raise CollectorError(f"Corrupt zip: {zip_path}") from exc

    return subdir


def find_yaml_files(run_dir: Path) -> dict[str, Path]:
    """Locate the expected YAML files inside *run_dir*.

    Returns a dict keyed by short name (e.g. ``"run-meta"``) with
    :class:`Path` values.  Logs a warning for any missing file.
    """
    found: dict[str, Path] = {}
    for key, filename in REQUIRED_YAML.items():
        path = run_dir / filename
        if path.exists():
            found[key] = path
        else:
            logger.warning("Missing %s in %s", filename, run_dir)
    return found


# ---------------------------------------------------------------------------
# YAML parsers — one per file type
# ---------------------------------------------------------------------------


def _load_yaml(path: Path) -> dict:
    with open(path) as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise CollectorError(f"Expected YAML dict in {path}, got {type(data).__name__}")
    return data


def parse_run_meta(yaml_path: Path) -> RunMeta:
    raw = _load_yaml(yaml_path)
    cfg = raw.get("config", {})
    return RunMeta(
        run_id=raw.get("run_folder", ""),
        config=RunConfig(
            rules_ref=cfg.get("rules_ref", ""),
            model=cfg.get("executor_model", ""),
            target_project=raw.get("vision_file", "").split("/")[1]
            if "/" in raw.get("vision_file", "")
            else "",
        ),
        start_time=str(raw.get("started_at", "")),
        end_time=str(raw.get("completed_at", "")),
        status=str(raw.get("status", "")),
    )


def parse_run_metrics(yaml_path: Path) -> RunMetrics:
    raw = _load_yaml(yaml_path)

    tokens = raw.get("tokens", {})
    total = tokens.get("total", {})
    per_agent = tokens.get("per_agent", {})

    agent_tokens: list[AgentTokens] = []
    for name, vals in per_agent.items():
        agent_tokens.append(
            AgentTokens(
                agent_name=name,
                input_tokens=vals.get("input_tokens", 0),
                output_tokens=vals.get("output_tokens", 0),
                total_tokens=vals.get("total_tokens", 0),
                cache_read_tokens=vals.get("cache_read_tokens", 0),
                cache_write_tokens=vals.get("cache_write_tokens", 0),
            )
        )

    timing = raw.get("timing", {})
    handoff_list = timing.get("handoffs", [])
    handoffs: list[HandoffMetrics] = []
    for h in handoff_list:
        handoffs.append(
            HandoffMetrics(
                handoff_number=h.get("handoff", 0),
                agent=h.get("node_id", ""),
                duration_seconds=h.get("duration_ms", 0) / 1000.0,
                tokens=0,
            )
        )

    hp = raw.get("handoff_patterns", {})
    errors = raw.get("errors", {})
    error_count = sum(
        [
            errors.get("throttle_events", 0),
            errors.get("timeout_events", 0),
            errors.get("failed_tool_calls", 0),
            errors.get("model_error_events", 0),
            errors.get("service_unavailable_events", 0),
            errors.get("validation_error_events", 0),
        ]
    )

    ctx = raw.get("context_size", {}).get("total", {})

    return RunMetrics(
        total_tokens=total.get("total_tokens", 0),
        total_input_tokens=total.get("input_tokens", 0),
        total_output_tokens=total.get("output_tokens", 0),
        total_cache_read_tokens=total.get("cache_read_tokens", 0),
        total_cache_write_tokens=total.get("cache_write_tokens", 0),
        execution_time_seconds=timing.get("total_wall_clock_ms", 0) / 1000.0,
        num_handoffs=hp.get("total_handoffs", len(handoff_list)),
        max_context_tokens=ctx.get("max_tokens", 0),
        avg_context_tokens=ctx.get("avg_tokens", 0.0),
        median_context_tokens=ctx.get("median_tokens", 0.0),
        agent_tokens=agent_tokens,
        handoffs=handoffs,
        server_startup_success=True,
        error_count=error_count,
    )


def parse_test_results(yaml_path: Path) -> UnitTestResults:
    raw = _load_yaml(yaml_path)
    parsed = raw.get("test", {}).get("parsed_results", {})
    passed = parsed.get("passed", 0) or 0
    failed = parsed.get("failed", 0) or 0
    errors = parsed.get("errors", 0) or 0
    skipped = parsed.get("skipped", 0) or 0
    total = parsed.get("total", 0) or 0
    return UnitTestResults(
        passed=passed,
        failed=failed,
        errors=errors,
        skipped=skipped,
        total=total,
    )


def parse_contract_tests(yaml_path: Path) -> ContractTestResults:
    raw = _load_yaml(yaml_path)
    total = raw.get("total", 0)
    passed = raw.get("passed", 0)
    failed = raw.get("failed", 0)
    pass_rate = passed / total if total > 0 else 0.0

    failures: list[ContractTestFailure] = []
    for case in raw.get("cases", []):
        if not case.get("passed", True):
            failures.append(
                ContractTestFailure(
                    endpoint=case.get("path", ""),
                    method=case.get("method", ""),
                    expected_status=case.get("expected_status", 0),
                    actual_status=case.get("actual_status", 0),
                    description=case.get("name", ""),
                )
            )

    return ContractTestResults(
        total=total,
        passed=passed,
        failed=failed,
        pass_rate=pass_rate,
        failures=failures,
    )


def parse_quality_report(yaml_path: Path) -> CodeQualityMetrics:
    raw = _load_yaml(yaml_path)
    lint = raw.get("lint", {})
    security = raw.get("security", {})
    summary = raw.get("summary", {})

    return CodeQualityMetrics(
        lint_findings=summary.get("lint_total", len(lint.get("findings", []))),
        security_findings=len(security.get("findings", []))
        if security.get("available", False)
        else -1,
        security_scanner_available=security.get("available", False),
        source_file_count=0,
        test_file_count=0,
        total_lines_of_code=0,
    )


def parse_qualitative(yaml_path: Path) -> QualitativeComparison:
    raw = _load_yaml(yaml_path)

    overall = raw.get("overall_score", 0.0)
    phases = raw.get("phases", [])
    inception_score = 0.0
    construction_score = 0.0
    doc_scores: list[DocumentScore] = []

    for phase in phases:
        phase_name = phase.get("phase", "")
        avg_overall = phase.get("avg_overall", 0.0)
        if phase_name == "inception":
            inception_score = avg_overall
        elif phase_name == "construction":
            construction_score = avg_overall

        for doc in phase.get("documents", []):
            doc_scores.append(
                DocumentScore(
                    document_name=Path(doc.get("path", "")).name,
                    overall_score=doc.get("overall", 0.0),
                    phase=phase_name,
                    completeness=doc.get("completeness", 0.0),
                    accuracy=doc.get("design_similarity", 0.0),
                    clarity=doc.get("intent_similarity", 0.0),
                )
            )

    return QualitativeComparison(
        overall_score=overall,
        inception_score=inception_score,
        construction_score=construction_score,
        document_scores=doc_scores,
        unmatched_reference_docs=raw.get("unmatched_reference", []),
        unmatched_candidate_docs=raw.get("unmatched_candidate", []),
    )


# ---------------------------------------------------------------------------
# Run classification
# ---------------------------------------------------------------------------


def classify_run(rules_ref: str) -> tuple[RunType, str, SemVer | None, int | None]:
    """Determine run type, display label, semver, and PR number from rules_ref."""
    if rules_ref == "main":
        return RunType.MAIN, "main", None, None
    if rules_ref.startswith("pr-"):
        num = int(rules_ref.split("-", 1)[1])
        return RunType.PR, f"PR #{num}", None, num
    try:
        sv = SemVer.parse(rules_ref)
        return RunType.RELEASE, str(sv), sv, None
    except ValueError:
        # Unknown format — treat as release-like
        return RunType.RELEASE, rules_ref, None, None


# ---------------------------------------------------------------------------
# Collection pipeline
# ---------------------------------------------------------------------------


def _collect_from_run_dir(run_dir: Path, source_label: str) -> RunData:
    """Parse YAML files in *run_dir* into a RunData.

    *source_label* is used in error messages (e.g. the zip path or directory).
    """
    yaml_files = find_yaml_files(run_dir)

    if "run-meta" not in yaml_files:
        raise CollectorError(f"run-meta.yaml missing from {source_label} — cannot classify run")

    meta = parse_run_meta(yaml_files["run-meta"])
    run_type, label, semver, pr_number = classify_run(meta.config.rules_ref)

    metrics = (
        parse_run_metrics(yaml_files["run-metrics"])
        if "run-metrics" in yaml_files
        else RunMetrics()
    )
    unit_tests = (
        parse_test_results(yaml_files["test-results"])
        if "test-results" in yaml_files
        else UnitTestResults()
    )
    contract_tests = (
        parse_contract_tests(yaml_files["contract-test-results"])
        if "contract-test-results" in yaml_files
        else ContractTestResults()
    )
    code_quality = (
        parse_quality_report(yaml_files["quality-report"])
        if "quality-report" in yaml_files
        else CodeQualityMetrics()
    )
    qualitative = (
        parse_qualitative(yaml_files["qualitative-comparison"])
        if "qualitative-comparison" in yaml_files
        else QualitativeComparison()
    )

    # Backfill artifact counts from run-metrics if available
    if "run-metrics" in yaml_files:
        raw_metrics = _load_yaml(yaml_files["run-metrics"])
        workspace = raw_metrics.get("artifacts", {}).get("workspace", {})
        code_quality.source_file_count = workspace.get("source_files", 0)
        code_quality.test_file_count = workspace.get("test_files", 0)
        code_quality.total_lines_of_code = workspace.get("total_lines_of_code", 0)

    return RunData(
        label=label,
        run_type=run_type,
        semver=semver,
        pr_number=pr_number,
        meta=meta,
        metrics=metrics,
        unit_tests=unit_tests,
        contract_tests=contract_tests,
        code_quality=code_quality,
        qualitative=qualitative,
    )


def collect_from_zip(zip_path: Path, work_dir: Path) -> RunData:
    """Extract a zip bundle and parse all YAML files into a RunData."""
    run_dir = extract_zip(zip_path, work_dir)
    return _collect_from_run_dir(run_dir, source_label=str(zip_path))


def collect_from_directory(dir_path: Path) -> RunData:
    """Parse all YAML files from a plain directory into a RunData.

    Unlike :func:`collect_from_zip`, no extraction step is needed.
    The directory must contain the expected YAML files directly.
    """
    if not dir_path.is_dir():
        raise CollectorError(f"Not a directory: {dir_path}")
    return _collect_from_run_dir(dir_path, source_label=str(dir_path))


def load_baseline(golden_path: Path) -> BaselineMetrics:
    """Parse a golden.yaml baseline file into BaselineMetrics."""
    if not golden_path.exists():
        logger.warning("Golden baseline file %s not found — using empty baseline", golden_path)
        return BaselineMetrics()

    raw = _load_yaml(golden_path)

    execution = raw.get("execution", {})
    unit_tests = raw.get("unit_tests", {})
    contract_tests = raw.get("contract_tests", {})
    code_quality = raw.get("code_quality", {})
    qualitative = raw.get("qualitative", {})

    doc_scores: dict[str, float] = {}
    for name, score in qualitative.get("document_scores", {}).items():
        if isinstance(score, (int, float)):
            doc_scores[name] = float(score)

    return BaselineMetrics(
        unit_tests_passed=unit_tests.get("passed", 0),
        unit_tests_total=unit_tests.get("total", 0),
        contract_tests_passed=contract_tests.get("passed", 0),
        contract_tests_total=contract_tests.get("total", 0),
        lint_findings=code_quality.get("lint_total", 0),
        qualitative_overall=qualitative.get("overall_score", 0.0),
        execution_time_seconds=execution.get("wall_clock_ms", 0) / 1000.0,
        total_tokens=execution.get("total_tokens", 0),
        document_scores=doc_scores,
    )


# ---------------------------------------------------------------------------
# Sorting and deltas
# ---------------------------------------------------------------------------


def sort_runs(runs: list[RunData]) -> list[RunData]:
    """Sort runs: releases by semver ascending, then main, then PRs."""
    type_order = {RunType.RELEASE: 0, RunType.MAIN: 1, RunType.PR: 2}

    def _key(run: RunData) -> tuple:
        sv = (
            (run.semver.major, run.semver.minor, run.semver.patch)
            if run.semver
            else (999, 999, 999)
        )
        pr = run.pr_number or 0
        return (type_order[run.run_type], sv, pr)

    return sorted(runs, key=_key)


def compute_deltas(runs: list[RunData]) -> list[VersionDelta]:
    """Compute version-over-version deltas for consecutive runs."""
    deltas: list[VersionDelta] = []
    for prev, curr in zip(runs, runs[1:]):
        deltas.append(
            VersionDelta(
                from_label=prev.label,
                to_label=curr.label,
                unit_tests_delta=curr.unit_tests.passed - prev.unit_tests.passed,
                contract_tests_delta=curr.contract_tests.passed - prev.contract_tests.passed,
                qualitative_delta=curr.qualitative.overall_score - prev.qualitative.overall_score,
                token_delta=curr.metrics.total_tokens - prev.metrics.total_tokens,
                time_delta_seconds=curr.metrics.execution_time_seconds
                - prev.metrics.execution_time_seconds,
            )
        )
    return deltas


# ---------------------------------------------------------------------------
# Top-level collection
# ---------------------------------------------------------------------------


def collect_trend_data(
    bundle_paths: list[Path],
    baseline_path: Path,
    repo: str,
    work_dir: Path | None = None,
) -> TrendData:
    """Parse all bundles (zip files or directories) and assemble a TrendData."""
    import tempfile

    if work_dir is None:
        work_dir = Path(tempfile.mkdtemp(prefix="trend-collect-"))

    baseline = load_baseline(baseline_path)

    runs: list[RunData] = []
    for bp in bundle_paths:
        logger.info("Collecting data from %s …", bp.name)
        try:
            if bp.is_dir():
                run = collect_from_directory(bp)
            else:
                run = collect_from_zip(bp, work_dir)
            runs.append(run)
        except CollectorError as exc:
            logger.warning("Skipping %s: %s", bp.name, exc)

    if not runs:
        raise CollectorError("No runs could be parsed from the provided bundles.")

    runs = sort_runs(runs)

    return TrendData(
        runs=runs,
        baseline=baseline,
        repo=repo,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )
