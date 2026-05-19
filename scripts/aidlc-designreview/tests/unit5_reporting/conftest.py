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
Shared test fixtures for Unit 5: Reporting tests.
"""

from datetime import datetime
from pathlib import Path

import pytest

from design_reviewer.ai_review.models import (
    AgentStatus,
    AlternativeSuggestion,
    AlternativesResult,
    CritiqueFinding,
    CritiqueResult,
    GapAnalysisResult,
    GapFinding,
    ReviewResult,
    ReviewSummary,
    Severity,
    TradeOff,
)
from design_reviewer.reporting.models import (
    ActionOption,
    AgentStatusInfo,
    ExecutiveSummary,
    KeyFinding,
    ProjectInfo,
    QualityLabel,
    RecommendedAction,
    ReportData,
    ReportMetadata,
)


@pytest.fixture
def sample_critique_findings():
    """Sample critique findings spanning all severities."""
    return [
        CritiqueFinding(
            id="crit-001",
            title="Missing Error Handling",
            severity=Severity.CRITICAL,
            description="No error handling in payment flow.",
            location="src/payment.py",
            recommendation="Add try/except with proper error recovery.",
        ),
        CritiqueFinding(
            id="crit-002",
            title="SQL Injection Risk",
            severity=Severity.HIGH,
            description="User input passed directly to SQL query.",
            location="src/db.py",
            recommendation="Use parameterized queries.",
        ),
        CritiqueFinding(
            id="crit-003",
            title="Missing Logging",
            severity=Severity.MEDIUM,
            description="No logging in authentication module.",
            location="src/auth.py",
            recommendation="Add structured logging.",
        ),
        CritiqueFinding(
            id="crit-004",
            title="Magic Number",
            severity=Severity.LOW,
            description="Hardcoded timeout value of 30.",
            location="src/config.py",
            recommendation="Extract to configuration constant.",
        ),
    ]


@pytest.fixture
def sample_gap_findings():
    """Sample gap findings."""
    return [
        GapFinding(
            id="gap-001",
            title="No Disaster Recovery Plan",
            severity=Severity.HIGH,
            description="No documented disaster recovery procedures.",
            category="reliability",
            recommendation="Document DR procedures with RTO/RPO targets.",
        ),
        GapFinding(
            id="gap-002",
            title="Missing API Documentation",
            severity=Severity.MEDIUM,
            description="Public API endpoints lack OpenAPI spec.",
            category="documentation",
            recommendation="Generate OpenAPI spec from code annotations.",
        ),
    ]


@pytest.fixture
def sample_alternative_suggestions():
    """Sample alternative suggestions."""
    return [
        AlternativeSuggestion(
            id="alt-001",
            title="Event-Driven Architecture",
            description="Consider event-driven approach for payment processing.",
            trade_offs=[
                TradeOff(type="pro", description="Better decoupling"),
                TradeOff(type="con", description="Increased complexity"),
            ],
            related_finding_id="crit-001",
        ),
    ]


@pytest.fixture
def sample_critique_result(sample_critique_findings):
    """A CritiqueResult with sample findings."""
    return CritiqueResult(
        findings=sample_critique_findings,
        status=AgentStatus.COMPLETED,
    )


@pytest.fixture
def sample_alternatives_result(sample_alternative_suggestions):
    """An AlternativesResult with sample suggestions."""
    return AlternativesResult(
        suggestions=sample_alternative_suggestions,
        status=AgentStatus.COMPLETED,
    )


@pytest.fixture
def sample_gap_result(sample_gap_findings):
    """A GapAnalysisResult with sample findings."""
    return GapAnalysisResult(
        findings=sample_gap_findings,
        status=AgentStatus.COMPLETED,
    )


@pytest.fixture
def sample_review_result(
    sample_critique_result, sample_alternatives_result, sample_gap_result
):
    """A complete ReviewResult with all agent results."""
    return ReviewResult(
        critique=sample_critique_result,
        alternatives=sample_alternatives_result,
        gaps=sample_gap_result,
        summary=ReviewSummary(
            total_critique_findings=4,
            total_alternative_suggestions=1,
            total_gap_findings=2,
            severity_counts={"critical": 1, "high": 2, "medium": 2, "low": 1},
            agents_completed=3,
            agents_failed=0,
            agents_skipped=0,
        ),
    )


@pytest.fixture
def sample_project_info():
    """Sample project info for report building."""
    return ProjectInfo(
        project_path=Path("/test/project"),
        project_name="test-project",
        review_timestamp=datetime(2026, 3, 11, 10, 0, 0),
        tool_version="0.1.0",
        models_used={"critique": "claude-opus-4-6"},
    )


@pytest.fixture
def sample_report_metadata():
    """Sample report metadata."""
    return ReportMetadata(
        review_timestamp=datetime(2026, 3, 11, 10, 0, 0),
        tool_version="0.1.0",
        project_path="/test/project",
        project_name="test-project",
        review_duration=45.5,
        models_used={"critique": "claude-opus-4-6"},
        severity_counts={"critical": 1, "high": 2, "medium": 2, "low": 1},
    )


@pytest.fixture
def sample_executive_summary():
    """Sample executive summary."""
    return ExecutiveSummary(
        quality_label=QualityLabel.NEEDS_IMPROVEMENT,
        quality_score=20,
        top_findings=[
            KeyFinding(
                title="Missing Error Handling",
                severity=Severity.CRITICAL,
                description="No error handling in payment flow.",
                source_agent="critique",
                finding_id="crit-001",
            ),
        ],
        recommended_action=RecommendedAction.EXPLORE_ALTERNATIVES,
        all_actions=[
            ActionOption(action="Approve", description="Design meets standards."),
            ActionOption(
                action="Request Changes",
                description="Significant issues found.",
            ),
            ActionOption(
                action="Explore Alternatives",
                description="Consider alternatives.",
                is_recommended=True,
            ),
        ],
        severity_distribution={"critical": 1, "high": 2, "medium": 2, "low": 1},
    )


@pytest.fixture
def sample_report_data(sample_report_metadata, sample_executive_summary):
    """Complete ReportData for formatter testing."""
    return ReportData(
        metadata=sample_report_metadata,
        executive_summary=sample_executive_summary,
        critique_findings=[
            CritiqueFinding(
                id="crit-001",
                title="Missing Error Handling",
                severity=Severity.CRITICAL,
                description="No error handling in payment flow.",
                location="src/payment.py",
                recommendation="Add try/except with proper error recovery.",
            ),
            CritiqueFinding(
                id="crit-002",
                title="SQL Injection Risk",
                severity=Severity.HIGH,
                description="User input passed directly to SQL query.",
                location="src/db.py",
                recommendation="Use parameterized queries.",
            ),
        ],
        alternative_suggestions=[
            AlternativeSuggestion(
                id="alt-001",
                title="Event-Driven Architecture",
                description="Consider event-driven approach.",
                trade_offs=[
                    TradeOff(type="pro", description="Better decoupling"),
                    TradeOff(type="con", description="Increased complexity"),
                ],
            ),
        ],
        gap_findings=[
            GapFinding(
                id="gap-001",
                title="No Disaster Recovery Plan",
                severity=Severity.HIGH,
                description="No documented DR procedures.",
                category="reliability",
                recommendation="Document DR procedures.",
            ),
        ],
        agent_statuses=[
            AgentStatusInfo(
                agent_name="critique",
                status=AgentStatus.COMPLETED,
                finding_count=2,
            ),
            AgentStatusInfo(
                agent_name="alternatives",
                status=AgentStatus.COMPLETED,
                finding_count=1,
            ),
            AgentStatusInfo(
                agent_name="gap",
                status=AgentStatus.COMPLETED,
                finding_count=1,
            ),
        ],
    )
