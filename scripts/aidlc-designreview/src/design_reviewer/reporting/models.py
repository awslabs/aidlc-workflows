# Copyright (c) 2026 AIDLC Design Reviewer Contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""
Domain models for Unit 5: Reporting, Orchestration & CLI.

All models are frozen (immutable) Pydantic models per BR-5.33.
"""

from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from design_reviewer.ai_review.models import (
    AgentStatus,
    AlternativeSuggestion,
    CritiqueFinding,
    GapFinding,
    Severity,
)


# --- Enums ---


class QualityLabel(StrEnum):
    """Overall design quality assessment label."""

    EXCELLENT = "Excellent"
    GOOD = "Good"
    NEEDS_IMPROVEMENT = "Needs Improvement"
    POOR = "Poor"


class RecommendedAction(StrEnum):
    """Recommended action based on quality assessment."""

    APPROVE = "Approve"
    REQUEST_CHANGES = "Request Changes"
    EXPLORE_ALTERNATIVES = "Explore Alternatives"


# --- Report Data Models ---


class TokenUsage(BaseModel):
    """Token counts for a single agent invocation."""

    model_config = ConfigDict(frozen=True)

    input_tokens: int = 0
    output_tokens: int = 0


class QualityThresholds(BaseModel):
    """Configurable quality score thresholds (BR-5.2)."""

    model_config = ConfigDict(frozen=True)

    excellent_max_score: int = 5
    good_max_score: int = 15
    needs_improvement_max_score: int = 30

    @model_validator(mode="after")
    def validate_ordering(self) -> "QualityThresholds":
        if not (
            self.excellent_max_score
            < self.good_max_score
            < self.needs_improvement_max_score
        ):
            raise ValueError(
                f"Thresholds must be ascending: excellent({self.excellent_max_score}) "
                f"< good({self.good_max_score}) < needs_improvement({self.needs_improvement_max_score})"
            )
        return self


class ConfigSummary(BaseModel):
    """Summary of key configuration settings used for the review."""

    model_config = ConfigDict(frozen=True)

    severity_threshold: str = "medium"
    alternatives_enabled: bool = True
    gap_analysis_enabled: bool = True
    quality_thresholds: QualityThresholds = Field(default_factory=QualityThresholds)


class ReportMetadata(BaseModel):
    """Metadata included in report header (BR-5.11)."""

    model_config = ConfigDict(frozen=True)

    review_timestamp: datetime
    tool_version: str
    project_path: str
    project_name: str
    review_duration: float
    models_used: Dict[str, str] = Field(default_factory=dict)
    agent_execution_times: Dict[str, float] = Field(default_factory=dict)
    token_usage: Dict[str, TokenUsage] = Field(default_factory=dict)
    config_settings: ConfigSummary = Field(default_factory=ConfigSummary)
    severity_counts: Dict[str, int] = Field(default_factory=dict)


class KeyFinding(BaseModel):
    """Simplified finding for executive summary (BR-5.4)."""

    model_config = ConfigDict(frozen=True)

    title: str
    severity: Severity
    description: str
    source_agent: str
    finding_id: str


class ActionOption(BaseModel):
    """One of three action options in the executive summary (BR-5.6)."""

    model_config = ConfigDict(frozen=True)

    action: str
    description: str
    is_recommended: bool = False


class ExecutiveSummary(BaseModel):
    """Executive summary with quality assessment and recommendations (BR-5.5)."""

    model_config = ConfigDict(frozen=True)

    quality_label: QualityLabel
    quality_score: int
    top_findings: List[KeyFinding] = Field(default_factory=list)
    recommended_action: RecommendedAction
    all_actions: List[ActionOption] = Field(default_factory=list)
    severity_distribution: Dict[str, int] = Field(default_factory=dict)


class AgentStatusInfo(BaseModel):
    """Status information for a single agent execution."""

    model_config = ConfigDict(frozen=True)

    agent_name: str
    status: AgentStatus
    execution_time: Optional[float] = None
    error_message: Optional[str] = None
    finding_count: int = 0


class ReportData(BaseModel):
    """Top-level report data structure passed to formatters."""

    model_config = ConfigDict(frozen=True)

    metadata: ReportMetadata
    executive_summary: ExecutiveSummary
    critique_findings: List[CritiqueFinding] = Field(default_factory=list)
    alternative_suggestions: List[AlternativeSuggestion] = Field(default_factory=list)
    alternatives_recommendation: str = ""
    gap_findings: List[GapFinding] = Field(default_factory=list)
    agent_statuses: List[AgentStatusInfo] = Field(default_factory=list)


# --- Orchestration / CLI Models ---


class ProjectInfo(BaseModel):
    """Project info collected at CLI level, passed to ReportBuilder."""

    model_config = ConfigDict(frozen=True)

    project_path: Path
    project_name: str
    review_timestamp: datetime
    tool_version: str
    models_used: Dict[str, str] = Field(default_factory=dict)


class OutputPaths(BaseModel):
    """Resolved output file paths (BR-5.25, BR-5.26)."""

    model_config = ConfigDict(frozen=True)

    base_path: Path
    markdown_path: Path
    html_path: Path

    @classmethod
    def from_base(cls, base: Optional[str] = None) -> "OutputPaths":
        """Create OutputPaths from an optional base path string.

        When no base is given, generates a timestamped filename like
        ``review-20260312-170155.md``.
        """
        if base:
            base_path = Path(base)
        else:
            from datetime import datetime

            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            base_path = Path(f"./review-{stamp}")
        return cls(
            base_path=base_path,
            markdown_path=base_path.with_suffix(".md"),
            html_path=base_path.with_suffix(".html"),
        )
