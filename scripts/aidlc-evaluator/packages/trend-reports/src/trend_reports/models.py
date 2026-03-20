"""Data models for trend reporting."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class TrendReportError(Exception):
    """Base exception for all trend report errors."""


class FetchError(TrendReportError):
    """Raised when a gh CLI fetch operation fails."""


class CollectorError(TrendReportError):
    """Raised when data collection or parsing fails."""


# ---------------------------------------------------------------------------
# Enums and value types
# ---------------------------------------------------------------------------


class RunType(Enum):
    RELEASE = "release"
    MAIN = "main"
    PR = "pr"


@dataclass(frozen=True, order=True)
class SemVer:
    """Semantic version, comparable via tuple ordering."""

    major: int
    minor: int
    patch: int

    @classmethod
    def parse(cls, tag: str) -> SemVer:
        """Parse 'v0.1.3' or '0.1.3' into SemVer."""
        m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", tag)
        if not m:
            raise ValueError(f"Cannot parse semver from '{tag}'")
        return cls(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    def __str__(self) -> str:
        return f"v{self.major}.{self.minor}.{self.patch}"


# ---------------------------------------------------------------------------
# Per-YAML-file models
# ---------------------------------------------------------------------------


@dataclass
class RunConfig:
    """Subset of run-meta.yaml -> config."""

    rules_ref: str
    model: str = ""
    target_project: str = ""


@dataclass
class RunMeta:
    """Parsed from run-meta.yaml."""

    run_id: str
    config: RunConfig
    start_time: str = ""
    end_time: str = ""
    status: str = ""


@dataclass
class AgentTokens:
    """Token breakdown for a single agent."""

    agent_name: str
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass
class HandoffMetrics:
    """Metrics for a single handoff segment."""

    handoff_number: int
    agent: str = ""
    duration_seconds: float = 0.0
    tokens: int = 0


@dataclass
class RunMetrics:
    """Parsed from run-metrics.yaml."""

    total_tokens: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cache_read_tokens: int = 0
    total_cache_write_tokens: int = 0
    execution_time_seconds: float = 0.0
    num_handoffs: int = 0
    max_context_tokens: int = 0
    avg_context_tokens: float = 0.0
    median_context_tokens: float = 0.0
    agent_tokens: list[AgentTokens] = field(default_factory=list)
    handoffs: list[HandoffMetrics] = field(default_factory=list)
    server_startup_success: bool = True
    error_count: int = 0


@dataclass
class UnitTestResults:
    """Parsed from test-results.yaml."""

    passed: int = 0
    failed: int = 0
    errors: int = 0
    skipped: int = 0
    total: int = 0


@dataclass
class ContractTestFailure:
    """A single contract test failure."""

    endpoint: str = ""
    method: str = ""
    expected_status: int = 0
    actual_status: int = 0
    description: str = ""


@dataclass
class ContractTestResults:
    """Parsed from contract-test-results.yaml."""

    total: int = 0
    passed: int = 0
    failed: int = 0
    pass_rate: float = 0.0
    failures: list[ContractTestFailure] = field(default_factory=list)


@dataclass
class CodeQualityMetrics:
    """Parsed from quality-report.yaml."""

    lint_findings: int = 0
    security_findings: int = -1
    security_scanner_available: bool = False
    source_file_count: int = 0
    test_file_count: int = 0
    total_lines_of_code: int = 0
    artifact_counts: dict[str, int] = field(default_factory=dict)


@dataclass
class DocumentScore:
    """Score for a single document in qualitative comparison."""

    document_name: str
    overall_score: float = 0.0
    phase: str = ""
    completeness: float = 0.0
    accuracy: float = 0.0
    clarity: float = 0.0


@dataclass
class QualitativeComparison:
    """Parsed from qualitative-comparison.yaml."""

    overall_score: float = 0.0
    inception_score: float = 0.0
    construction_score: float = 0.0
    document_scores: list[DocumentScore] = field(default_factory=list)
    unmatched_reference_docs: list[str] = field(default_factory=list)
    unmatched_candidate_docs: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Composite models
# ---------------------------------------------------------------------------


@dataclass
class RunData:
    """All data for a single evaluation run (one zip bundle)."""

    label: str
    run_type: RunType
    semver: SemVer | None
    pr_number: int | None
    meta: RunMeta
    metrics: RunMetrics
    unit_tests: UnitTestResults
    contract_tests: ContractTestResults
    code_quality: CodeQualityMetrics
    qualitative: QualitativeComparison


@dataclass
class BaselineMetrics:
    """Golden baseline reference values."""

    unit_tests_passed: int = 0
    unit_tests_total: int = 0
    contract_tests_passed: int = 0
    contract_tests_total: int = 0
    lint_findings: int = 0
    qualitative_overall: float = 0.0
    execution_time_seconds: float = 0.0
    total_tokens: int = 0
    document_scores: dict[str, float] = field(default_factory=dict)


@dataclass
class TrendData:
    """Complete assembled dataset for trend rendering."""

    runs: list[RunData]
    baseline: BaselineMetrics
    repo: str = ""
    generated_at: str = ""


@dataclass
class VersionDelta:
    """Computed delta between two consecutive runs."""

    from_label: str
    to_label: str
    unit_tests_delta: int = 0
    contract_tests_delta: int = 0
    qualitative_delta: float = 0.0
    token_delta: int = 0
    time_delta_seconds: float = 0.0


@dataclass
class GateResult:
    """Result of regression gate check."""

    passed: bool
    regressions: list[str] = field(default_factory=list)
    latest_label: str = ""
    comparison_label: str = ""
