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
Data models for Unit 4: AI Review.

Defines enums, finding models, agent result models, and aggregate review results.
All result models are frozen (immutable) Pydantic models.
"""

from enum import StrEnum
from typing import Dict, List, Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


class Severity(StrEnum):
    """Standardized severity levels for findings."""

    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class AgentStatus(StrEnum):
    """Agent execution outcome status."""

    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    TIMED_OUT = "timed_out"


# --- Finding Models ---


class TradeOff(BaseModel):
    """A single pro or con within an alternative suggestion."""

    model_config = ConfigDict(frozen=True)

    type: Literal["pro", "con"]
    description: str


class CritiqueFinding(BaseModel):
    """A single critique finding representing a design issue or concern."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(default_factory=lambda: uuid4().hex[:16])
    title: str
    severity: Severity
    description: str
    location: str
    recommendation: str


class AlternativeSuggestion(BaseModel):
    """A single alternative design suggestion."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(default_factory=lambda: uuid4().hex[:16])
    title: str
    overview: str = ""
    what_changes: str = ""
    advantages: List[str] = Field(default_factory=list)
    disadvantages: List[str] = Field(default_factory=list)
    implementation_complexity: Optional[str] = None
    complexity_justification: str = ""
    # Legacy fields kept for backward compatibility
    description: str = ""
    trade_offs: List[TradeOff] = Field(default_factory=list)
    related_finding_id: Optional[str] = None


class GapFinding(BaseModel):
    """A single gap finding representing missing or incomplete design elements."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(default_factory=lambda: uuid4().hex[:16])
    title: str
    description: str
    severity: Severity
    category: str
    recommendation: str


# --- Agent Result Models ---


class CritiqueResult(BaseModel):
    """Complete output from the CritiqueAgent."""

    model_config = ConfigDict(frozen=True)

    findings: List[CritiqueFinding] = Field(default_factory=list)
    agent_name: str = "critique"
    status: AgentStatus = AgentStatus.COMPLETED
    error_message: Optional[str] = None
    raw_response: Optional[str] = None
    token_usage: Optional[Dict[str, int]] = None


class AlternativesResult(BaseModel):
    """Complete output from the AlternativesAgent."""

    model_config = ConfigDict(frozen=True)

    suggestions: List[AlternativeSuggestion] = Field(default_factory=list)
    recommendation: str = ""
    agent_name: str = "alternatives"
    status: AgentStatus = AgentStatus.COMPLETED
    error_message: Optional[str] = None
    raw_response: Optional[str] = None
    token_usage: Optional[Dict[str, int]] = None


class GapAnalysisResult(BaseModel):
    """Complete output from the GapAnalysisAgent."""

    model_config = ConfigDict(frozen=True)

    findings: List[GapFinding] = Field(default_factory=list)
    agent_name: str = "gap"
    status: AgentStatus = AgentStatus.COMPLETED
    error_message: Optional[str] = None
    raw_response: Optional[str] = None
    token_usage: Optional[Dict[str, int]] = None


# --- Aggregate Result Models ---


class ReviewSummary(BaseModel):
    """Auto-generated statistics summarizing review results."""

    model_config = ConfigDict(frozen=True)

    total_critique_findings: int = 0
    total_alternative_suggestions: int = 0
    total_gap_findings: int = 0
    severity_counts: Dict[str, int] = Field(default_factory=dict)
    agents_completed: int = 0
    agents_failed: int = 0
    agents_skipped: int = 0


class ReviewResult(BaseModel):
    """Top-level aggregate model containing all AI review results."""

    model_config = ConfigDict(frozen=True)

    critique: Optional[CritiqueResult] = None
    alternatives: Optional[AlternativesResult] = None
    gaps: Optional[GapAnalysisResult] = None
    summary: ReviewSummary = Field(default_factory=ReviewSummary)
