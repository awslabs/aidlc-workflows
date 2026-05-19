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
Tests for Unit 5 ReportBuilder.

Tests quality score calculation, threshold mapping, top findings deduplication,
recommended action mapping, partial results (empty lists), all severity combinations.
"""

import pytest

from design_reviewer.ai_review.models import (
    AlternativesResult,
    CritiqueFinding,
    CritiqueResult,
    GapAnalysisResult,
    GapFinding,
    ReviewResult,
    Severity,
)
from design_reviewer.reporting.models import (
    QualityLabel,
    QualityThresholds,
    RecommendedAction,
)
from design_reviewer.reporting.report_builder import (
    SEVERITY_WEIGHTS,
    ReportBuilder,
)


@pytest.fixture
def builder():
    return ReportBuilder()


@pytest.fixture
def stage_timings():
    return {"validation": 1.0, "discovery": 0.5, "ai_review": 30.0}


def _make_review_result(critique_findings=None, gap_findings=None, alternatives=None):
    """Helper to build a ReviewResult with optional findings."""
    critique = (
        CritiqueResult(findings=critique_findings or [])
        if critique_findings is not None
        else None
    )
    gaps = (
        GapAnalysisResult(findings=gap_findings or [])
        if gap_findings is not None
        else None
    )
    alts = (
        AlternativesResult(suggestions=alternatives or [])
        if alternatives is not None
        else None
    )
    return ReviewResult(critique=critique, alternatives=alts, gaps=gaps)


class TestSeverityWeights:
    def test_critical_weight(self):
        assert SEVERITY_WEIGHTS[Severity.CRITICAL] == 4

    def test_high_weight(self):
        assert SEVERITY_WEIGHTS[Severity.HIGH] == 3

    def test_medium_weight(self):
        assert SEVERITY_WEIGHTS[Severity.MEDIUM] == 2

    def test_low_weight(self):
        assert SEVERITY_WEIGHTS[Severity.LOW] == 1


class TestQualityScoreCalculation:
    def test_no_findings_score_zero(self, builder, sample_project_info, stage_timings):
        result = _make_review_result(critique_findings=[], gap_findings=[])
        report = builder.build_report(result, sample_project_info, 31.5, _stage_timings=stage_timings)
        assert report.executive_summary.quality_score == 0

    def test_single_critical_finding(self, builder, sample_project_info, stage_timings):
        findings = [
            CritiqueFinding(
                id="c1",
                title="Critical Issue",
                severity=Severity.CRITICAL,
                description="D",
                location="L",
                recommendation="R",
            ),
        ]
        result = _make_review_result(critique_findings=findings, gap_findings=[])
        report = builder.build_report(result, sample_project_info, 31.5, _stage_timings=stage_timings)
        assert report.executive_summary.quality_score == 4

    def test_mixed_severities(self, builder, sample_project_info, stage_timings):
        findings = [
            CritiqueFinding(
                id="c1",
                title="Critical",
                severity=Severity.CRITICAL,
                description="D",
                location="L",
                recommendation="R",
            ),
            CritiqueFinding(
                id="c2",
                title="Low",
                severity=Severity.LOW,
                description="D",
                location="L",
                recommendation="R",
            ),
        ]
        gap_findings = [
            GapFinding(
                id="g1",
                title="High Gap",
                severity=Severity.HIGH,
                description="D",
                category="C",
                recommendation="R",
            ),
        ]
        result = _make_review_result(
            critique_findings=findings, gap_findings=gap_findings
        )
        report = builder.build_report(result, sample_project_info, 31.5, _stage_timings=stage_timings)
        # 4 (critical) + 1 (low) + 3 (high) = 8
        assert report.executive_summary.quality_score == 8

    def test_all_findings_combined(
        self, builder, sample_review_result, sample_project_info, stage_timings
    ):
        report = builder.build_report(
            sample_review_result, sample_project_info, 31.5, _stage_timings=stage_timings
        )
        # 4 critique (crit=4 + high=3 + med=2 + low=1) + 2 gap (high=3 + med=2) = 15
        assert report.executive_summary.quality_score == 15


class TestScoreToLabel:
    def test_excellent(self, builder, sample_project_info, stage_timings):
        """Score <= 5 -> Excellent."""
        findings = [
            CritiqueFinding(
                id="c1",
                title="Low",
                severity=Severity.LOW,
                description="D",
                location="L",
                recommendation="R",
            ),
        ]
        result = _make_review_result(critique_findings=findings, gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        assert report.executive_summary.quality_label == QualityLabel.EXCELLENT

    def test_good(self, builder, sample_project_info, stage_timings):
        """Score 6-15 -> Good."""
        findings = [
            CritiqueFinding(
                id="c1",
                title="High",
                severity=Severity.HIGH,
                description="D",
                location="L",
                recommendation="R",
            ),
            CritiqueFinding(
                id="c2",
                title="Medium",
                severity=Severity.MEDIUM,
                description="D",
                location="L",
                recommendation="R",
            ),
            CritiqueFinding(
                id="c3",
                title="Low",
                severity=Severity.LOW,
                description="D",
                location="L",
                recommendation="R",
            ),
        ]
        result = _make_review_result(critique_findings=findings, gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        # 3 + 2 + 1 = 6
        assert report.executive_summary.quality_label == QualityLabel.GOOD

    def test_needs_improvement(self, builder, sample_project_info, stage_timings):
        """Score 16-30 -> Needs Improvement."""
        findings = [
            CritiqueFinding(
                id=f"c{i}",
                title=f"Critical {i}",
                severity=Severity.CRITICAL,
                description="D",
                location="L",
                recommendation="R",
            )
            for i in range(5)
        ]
        result = _make_review_result(critique_findings=findings, gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        # 5 * 4 = 20
        assert report.executive_summary.quality_label == QualityLabel.NEEDS_IMPROVEMENT

    def test_poor(self, builder, sample_project_info, stage_timings):
        """Score > 30 -> Poor."""
        findings = [
            CritiqueFinding(
                id=f"c{i}",
                title=f"Critical {i}",
                severity=Severity.CRITICAL,
                description="D",
                location="L",
                recommendation="R",
            )
            for i in range(8)
        ]
        result = _make_review_result(critique_findings=findings, gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        # 8 * 4 = 32
        assert report.executive_summary.quality_label == QualityLabel.POOR

    def test_custom_thresholds(self, sample_project_info, stage_timings):
        thresholds = QualityThresholds(
            excellent_max_score=2,
            good_max_score=5,
            needs_improvement_max_score=10,
        )
        builder = ReportBuilder(quality_thresholds=thresholds)
        findings = [
            CritiqueFinding(
                id="c1",
                title="High",
                severity=Severity.HIGH,
                description="D",
                location="L",
                recommendation="R",
            ),
        ]
        result = _make_review_result(critique_findings=findings, gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        # score=3, good_max=5 -> Good
        assert report.executive_summary.quality_label == QualityLabel.GOOD


class TestLabelToAction:
    def test_excellent_approves(self, builder, sample_project_info, stage_timings):
        result = _make_review_result(critique_findings=[], gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        assert report.executive_summary.recommended_action == RecommendedAction.APPROVE

    def test_poor_requests_changes(self, builder, sample_project_info, stage_timings):
        findings = [
            CritiqueFinding(
                id=f"c{i}",
                title=f"Critical {i}",
                severity=Severity.CRITICAL,
                description="D",
                location="L",
                recommendation="R",
            )
            for i in range(10)
        ]
        result = _make_review_result(critique_findings=findings, gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        assert (
            report.executive_summary.recommended_action
            == RecommendedAction.REQUEST_CHANGES
        )


class TestTopFindingsDeduplication:
    def test_max_five_findings(self, builder, sample_project_info, stage_timings):
        findings = [
            CritiqueFinding(
                id=f"c{i}",
                title=f"Finding {i}",
                severity=Severity.MEDIUM,
                description="D",
                location="L",
                recommendation="R",
            )
            for i in range(10)
        ]
        result = _make_review_result(critique_findings=findings, gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        assert len(report.executive_summary.top_findings) <= 5

    def test_sorted_by_severity(self, builder, sample_project_info, stage_timings):
        findings = [
            CritiqueFinding(
                id="c1",
                title="Low Issue",
                severity=Severity.LOW,
                description="D",
                location="L",
                recommendation="R",
            ),
            CritiqueFinding(
                id="c2",
                title="Critical Issue",
                severity=Severity.CRITICAL,
                description="D",
                location="L",
                recommendation="R",
            ),
        ]
        result = _make_review_result(critique_findings=findings, gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        top = report.executive_summary.top_findings
        assert top[0].severity == Severity.CRITICAL
        assert top[1].severity == Severity.LOW

    def test_deduplicates_by_title(self, builder, sample_project_info, stage_timings):
        findings = [
            CritiqueFinding(
                id="c1",
                title="Same Title",
                severity=Severity.HIGH,
                description="D1",
                location="L",
                recommendation="R",
            ),
        ]
        gap_findings = [
            GapFinding(
                id="g1",
                title="same title",
                severity=Severity.HIGH,
                description="D2",
                category="C",
                recommendation="R",
            ),
        ]
        result = _make_review_result(
            critique_findings=findings, gap_findings=gap_findings
        )
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        # Both have "Same Title" (case-insensitive) so only 1 should appear
        assert len(report.executive_summary.top_findings) == 1


class TestPartialResults:
    def test_none_critique(self, builder, sample_project_info, stage_timings):
        result = ReviewResult(critique=None, alternatives=None, gaps=None)
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        assert report.critique_findings == []
        assert report.alternative_suggestions == []
        assert report.gap_findings == []
        assert report.executive_summary.quality_score == 0

    def test_none_alternatives(self, builder, sample_project_info, stage_timings):
        findings = [
            CritiqueFinding(
                id="c1",
                title="Issue",
                severity=Severity.LOW,
                description="D",
                location="L",
                recommendation="R",
            ),
        ]
        result = _make_review_result(critique_findings=findings)
        # alternatives is None
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        assert report.alternative_suggestions == []
        assert len(report.critique_findings) == 1


class TestActionOptions:
    def test_always_three_options(self, builder, sample_project_info, stage_timings):
        result = _make_review_result(critique_findings=[], gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        assert len(report.executive_summary.all_actions) == 3

    def test_one_recommended(self, builder, sample_project_info, stage_timings):
        result = _make_review_result(critique_findings=[], gap_findings=[])
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        recommended = [
            a for a in report.executive_summary.all_actions if a.is_recommended
        ]
        assert len(recommended) == 1


class TestAgentStatuses:
    def test_all_agents_present(
        self, builder, sample_review_result, sample_project_info, stage_timings
    ):
        report = builder.build_report(
            sample_review_result, sample_project_info, 31.5, stage_timings
        )
        names = [s.agent_name for s in report.agent_statuses]
        assert "critique" in names
        assert "alternatives" in names
        assert "gap" in names

    def test_none_agents_excluded(self, builder, sample_project_info, stage_timings):
        result = ReviewResult(critique=None, alternatives=None, gaps=None)
        report = builder.build_report(result, sample_project_info, 1.0, _stage_timings=stage_timings)
        assert report.agent_statuses == []


class TestSeverityCounts:
    def test_counts_all_severities(
        self, builder, sample_review_result, sample_project_info, stage_timings
    ):
        report = builder.build_report(
            sample_review_result, sample_project_info, 31.5, stage_timings
        )
        counts = report.metadata.severity_counts
        assert counts["critical"] == 1
        assert counts["high"] == 2
        assert counts["medium"] == 2
        assert counts["low"] == 1


class TestMetadata:
    def test_metadata_from_project_info(
        self, builder, sample_review_result, sample_project_info, stage_timings
    ):
        report = builder.build_report(
            sample_review_result, sample_project_info, 31.5, stage_timings
        )
        assert report.metadata.tool_version == "0.1.0"
        assert report.metadata.project_name == "test-project"
        assert report.metadata.review_duration == 31.5
