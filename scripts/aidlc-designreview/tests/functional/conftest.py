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
Shared fixtures for functional (cross-unit integration) tests.

These tests exercise real component interactions across units.
Only external dependencies (AWS/Bedrock) are mocked.
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
from design_reviewer.reporting.models import OutputPaths, ProjectInfo
from design_reviewer.reporting.template_env import reset_environment


@pytest.fixture(autouse=True)
def clean_template_env():
    """Reset Jinja2 singleton between tests."""
    reset_environment()
    yield
    reset_environment()


@pytest.fixture
def review_result_healthy():
    """A ReviewResult representing a healthy design (few low-severity findings)."""
    return ReviewResult(
        critique=CritiqueResult(
            findings=[
                CritiqueFinding(
                    id="c1",
                    title="Consider Adding Retry Logic",
                    severity=Severity.LOW,
                    description="The HTTP client does not retry on transient failures.",
                    location="src/client.py:45",
                    recommendation="Add exponential backoff for 429/503 responses.",
                ),
            ],
            status=AgentStatus.COMPLETED,
        ),
        alternatives=AlternativesResult(
            suggestions=[
                AlternativeSuggestion(
                    id="a1",
                    title="Circuit Breaker Pattern",
                    description="Use a circuit breaker instead of simple retry.",
                    trade_offs=[
                        TradeOff(type="pro", description="Prevents cascade failures"),
                        TradeOff(type="con", description="Adds state complexity"),
                    ],
                    related_finding_id="c1",
                ),
            ],
            status=AgentStatus.COMPLETED,
        ),
        gaps=GapAnalysisResult(
            findings=[
                GapFinding(
                    id="g1",
                    title="Missing Rate Limit Documentation",
                    severity=Severity.LOW,
                    description="API rate limits are not documented.",
                    category="documentation",
                    recommendation="Add rate limit section to API docs.",
                ),
            ],
            status=AgentStatus.COMPLETED,
        ),
        summary=ReviewSummary(
            total_critique_findings=1,
            total_alternative_suggestions=1,
            total_gap_findings=1,
            severity_counts={"low": 2},
            agents_completed=3,
        ),
    )


@pytest.fixture
def review_result_critical():
    """A ReviewResult representing a poor design (many critical findings)."""
    return ReviewResult(
        critique=CritiqueResult(
            findings=[
                CritiqueFinding(
                    id=f"c{i}",
                    title=f"Critical Security Flaw {i}",
                    severity=Severity.CRITICAL,
                    description=f"Unvalidated input in endpoint {i}.",
                    location=f"src/api/endpoint_{i}.py",
                    recommendation="Add input validation and sanitization.",
                )
                for i in range(8)
            ],
            status=AgentStatus.COMPLETED,
        ),
        alternatives=AlternativesResult(
            suggestions=[],
            status=AgentStatus.COMPLETED,
        ),
        gaps=GapAnalysisResult(
            findings=[
                GapFinding(
                    id="g1",
                    title="No Authentication",
                    severity=Severity.CRITICAL,
                    description="Endpoints lack authentication.",
                    category="security",
                    recommendation="Implement OAuth2 or API key auth.",
                ),
                GapFinding(
                    id="g2",
                    title="No Input Validation Framework",
                    severity=Severity.HIGH,
                    description="No centralized input validation.",
                    category="security",
                    recommendation="Use Pydantic for request validation.",
                ),
            ],
            status=AgentStatus.COMPLETED,
        ),
        summary=ReviewSummary(
            total_critique_findings=8,
            total_gap_findings=2,
            severity_counts={"critical": 9, "high": 1},
            agents_completed=3,
        ),
    )


@pytest.fixture
def review_result_partial():
    """A ReviewResult where alternatives agent failed."""
    return ReviewResult(
        critique=CritiqueResult(
            findings=[
                CritiqueFinding(
                    id="c1",
                    title="Hardcoded Config",
                    severity=Severity.MEDIUM,
                    description="Database URL is hardcoded.",
                    location="src/db.py:10",
                    recommendation="Use environment variables.",
                ),
            ],
            status=AgentStatus.COMPLETED,
        ),
        alternatives=AlternativesResult(
            suggestions=[],
            status=AgentStatus.FAILED,
            error_message="Bedrock timeout after 30s",
        ),
        gaps=None,
        summary=ReviewSummary(
            total_critique_findings=1,
            agents_completed=1,
            agents_failed=1,
            agents_skipped=1,
        ),
    )


@pytest.fixture
def project_info():
    """Standard project info for functional tests."""
    return ProjectInfo(
        project_path=Path("/projects/my-app"),
        project_name="my-app",
        review_timestamp=datetime(2026, 3, 12, 14, 30, 0),
        tool_version="0.1.0",
        models_used={"critique": "claude-opus-4-6", "gap": "claude-opus-4-6"},
    )


@pytest.fixture
def output_paths(tmp_path):
    """Output paths in a temp directory."""
    return OutputPaths(
        base_path=tmp_path / "review",
        markdown_path=tmp_path / "review.md",
        html_path=tmp_path / "review.html",
    )
