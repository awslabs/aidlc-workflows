"""Shared test fixtures and factory functions for trend-reports tests."""

from __future__ import annotations

from trend_reports.models import (
    BaselineMetrics,
    CodeQualityMetrics,
    ContractTestResults,
    DocumentScore,
    QualitativeComparison,
    RunConfig,
    RunData,
    RunMeta,
    RunMetrics,
    RunType,
    SemVer,
    TrendData,
    UnitTestResults,
)


def make_run(
    label: str = "v0.1.0",
    run_type: RunType = RunType.RELEASE,
    semver: SemVer | None = None,
    pr_number: int | None = None,
    passed: int = 100,
    failed: int = 0,
    qualitative_score: float = 0.9,
    total_tokens: int = 1_000_000,
    time_seconds: float = 600.0,
    contract_passed: int = 88,
    contract_total: int = 88,
    document_scores: list[DocumentScore] | None = None,
    inception_score: float = 0.0,
    construction_score: float = 0.0,
) -> RunData:
    """Create a RunData instance for testing."""
    if semver is None and run_type == RunType.RELEASE:
        try:
            semver = SemVer.parse(label)
        except ValueError:
            pass
    return RunData(
        label=label,
        run_type=run_type,
        semver=semver,
        pr_number=pr_number,
        meta=RunMeta(run_id="test", config=RunConfig(rules_ref=label)),
        metrics=RunMetrics(
            total_tokens=total_tokens,
            execution_time_seconds=time_seconds,
        ),
        unit_tests=UnitTestResults(passed=passed, failed=failed, total=passed + failed),
        contract_tests=ContractTestResults(
            total=contract_total,
            passed=contract_passed,
            failed=contract_total - contract_passed,
            pass_rate=contract_passed / contract_total if contract_total else 0.0,
        ),
        code_quality=CodeQualityMetrics(),
        qualitative=QualitativeComparison(
            overall_score=qualitative_score,
            inception_score=inception_score,
            construction_score=construction_score,
            document_scores=document_scores or [],
        ),
    )


def make_trend(*runs: RunData, baseline: BaselineMetrics | None = None) -> TrendData:
    """Create a TrendData instance for testing."""
    return TrendData(
        runs=list(runs),
        baseline=baseline or BaselineMetrics(),
        repo="test/repo",
        generated_at="2026-01-01T00:00:00Z",
    )
