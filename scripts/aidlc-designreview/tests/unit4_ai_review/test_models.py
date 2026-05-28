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


"""Tests for Unit 4 data models."""

import pytest
from pydantic import ValidationError

from src.design_reviewer.ai_review.models import (
    AgentStatus,
    AlternativesResult,
    AlternativeSuggestion,
    CritiqueFinding,
    CritiqueResult,
    GapAnalysisResult,
    GapFinding,
    ReviewResult,
    ReviewSummary,
    Severity,
    TradeOff,
)


class TestSeverityEnum:
    def test_values(self):
        assert Severity.CRITICAL == "critical"
        assert Severity.HIGH == "high"
        assert Severity.MEDIUM == "medium"
        assert Severity.LOW == "low"

    def test_from_string(self):
        assert Severity("critical") == Severity.CRITICAL
        assert Severity("low") == Severity.LOW

    def test_invalid_value(self):
        with pytest.raises(ValueError):
            Severity("invalid")


class TestAgentStatusEnum:
    def test_values(self):
        assert AgentStatus.COMPLETED == "completed"
        assert AgentStatus.FAILED == "failed"
        assert AgentStatus.SKIPPED == "skipped"
        assert AgentStatus.TIMED_OUT == "timed_out"


class TestTradeOff:
    def test_create_pro(self):
        t = TradeOff(type="pro", description="Better performance")
        assert t.type == "pro"
        assert t.description == "Better performance"

    def test_create_con(self):
        t = TradeOff(type="con", description="More complexity")
        assert t.type == "con"

    def test_invalid_type(self):
        with pytest.raises(ValidationError):
            TradeOff(type="neutral", description="test")

    def test_frozen(self):
        t = TradeOff(type="pro", description="test")
        with pytest.raises(ValidationError):
            t.description = "changed"


class TestCritiqueFinding:
    def test_create_with_defaults(self):
        f = CritiqueFinding(
            title="Test Finding",
            severity=Severity.HIGH,
            description="A test finding",
            location="design.md",
            recommendation="Fix it",
        )
        assert len(f.id) == 16
        assert f.title == "Test Finding"
        assert f.severity == Severity.HIGH

    def test_auto_generated_id(self):
        f1 = CritiqueFinding(
            title="A",
            severity="high",
            description="d",
            location="l",
            recommendation="r",
        )
        f2 = CritiqueFinding(
            title="B", severity="low", description="d", location="l", recommendation="r"
        )
        assert f1.id != f2.id
        assert len(f1.id) == 16

    def test_frozen(self):
        f = CritiqueFinding(
            title="T",
            severity="high",
            description="d",
            location="l",
            recommendation="r",
        )
        with pytest.raises(ValidationError):
            f.title = "changed"

    def test_severity_from_string(self):
        f = CritiqueFinding(
            title="T",
            severity="critical",
            description="d",
            location="l",
            recommendation="r",
        )
        assert f.severity == Severity.CRITICAL


class TestAlternativeSuggestion:
    def test_create_with_trade_offs(self):
        s = AlternativeSuggestion(
            title="Alt Approach",
            description="Use event-driven",
            trade_offs=[
                TradeOff(type="pro", description="Scalable"),
                TradeOff(type="con", description="Complex"),
            ],
            related_finding_id="abc123def4567890",
        )
        assert len(s.trade_offs) == 2
        assert s.related_finding_id == "abc123def4567890"

    def test_optional_related_finding(self):
        s = AlternativeSuggestion(
            title="T",
            description="D",
        )
        assert s.related_finding_id is None
        assert s.trade_offs == []

    def test_auto_generated_id(self):
        s = AlternativeSuggestion(title="T", description="D")
        assert len(s.id) == 16


class TestGapFinding:
    def test_create(self):
        g = GapFinding(
            title="Missing DR Plan",
            description="No disaster recovery",
            severity=Severity.HIGH,
            category="Reliability",
            recommendation="Add DR plan",
        )
        assert g.category == "Reliability"
        assert len(g.id) == 16

    def test_ai_determined_category(self):
        g = GapFinding(
            title="T",
            description="D",
            severity="medium",
            category="Custom AI Category",
            recommendation="R",
        )
        assert g.category == "Custom AI Category"


class TestCritiqueResult:
    def test_defaults(self):
        r = CritiqueResult()
        assert r.findings == []
        assert r.agent_name == "critique"
        assert r.status == AgentStatus.COMPLETED
        assert r.error_message is None
        assert r.raw_response is None

    def test_with_findings(self):
        findings = [
            CritiqueFinding(
                title="F1",
                severity="high",
                description="d",
                location="l",
                recommendation="r",
            )
        ]
        r = CritiqueResult(findings=findings)
        assert len(r.findings) == 1

    def test_failed_status(self):
        r = CritiqueResult(
            status=AgentStatus.FAILED,
            error_message="API error",
        )
        assert r.status == AgentStatus.FAILED
        assert r.error_message == "API error"


class TestAlternativesResult:
    def test_defaults(self):
        r = AlternativesResult()
        assert r.suggestions == []
        assert r.agent_name == "alternatives"

    def test_with_suggestions(self):
        suggestions = [AlternativeSuggestion(title="S1", description="D")]
        r = AlternativesResult(suggestions=suggestions)
        assert len(r.suggestions) == 1


class TestGapAnalysisResult:
    def test_defaults(self):
        r = GapAnalysisResult()
        assert r.findings == []
        assert r.agent_name == "gap"


class TestReviewSummary:
    def test_defaults(self):
        s = ReviewSummary()
        assert s.total_critique_findings == 0
        assert s.total_alternative_suggestions == 0
        assert s.total_gap_findings == 0
        assert s.severity_counts == {}
        assert s.agents_completed == 0

    def test_with_counts(self):
        s = ReviewSummary(
            total_critique_findings=3,
            total_alternative_suggestions=2,
            total_gap_findings=1,
            severity_counts={"critical": 1, "high": 2, "medium": 1},
            agents_completed=3,
        )
        assert s.total_critique_findings == 3
        assert s.severity_counts["critical"] == 1


class TestReviewResult:
    def test_defaults(self):
        r = ReviewResult()
        assert r.critique is None
        assert r.alternatives is None
        assert r.gaps is None
        assert r.summary is not None

    def test_with_all_results(self):
        r = ReviewResult(
            critique=CritiqueResult(),
            alternatives=AlternativesResult(),
            gaps=GapAnalysisResult(),
            summary=ReviewSummary(agents_completed=3),
        )
        assert r.critique is not None
        assert r.summary.agents_completed == 3

    def test_frozen(self):
        r = ReviewResult()
        with pytest.raises(ValidationError):
            r.critique = CritiqueResult()
