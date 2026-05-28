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
ReportBuilder — builds ReportData from ReviewResult.

Handles quality score calculation, top findings deduplication,
recommended action mapping, and partial AI review results (Pattern 5.5).
"""

from typing import Dict, List, Optional

from design_reviewer.ai_review.models import (
    CritiqueFinding,
    CritiqueResult,
    GapAnalysisResult,
    GapFinding,
    ReviewResult,
    Severity,
)

from .models import (
    ActionOption,
    AgentStatusInfo,
    ConfigSummary,
    ExecutiveSummary,
    KeyFinding,
    ProjectInfo,
    QualityLabel,
    QualityThresholds,
    RecommendedAction,
    ReportData,
    ReportMetadata,
    TokenUsage,
)

# BR-5.1: Severity weights for quality score calculation
SEVERITY_WEIGHTS: Dict[Severity, int] = {
    Severity.CRITICAL: 4,
    Severity.HIGH: 3,
    Severity.MEDIUM: 2,
    Severity.LOW: 1,
}


class ReportBuilder:
    """Builds ReportData from ReviewResult and project info."""

    def __init__(self, quality_thresholds: Optional[QualityThresholds] = None):
        self._thresholds = quality_thresholds or QualityThresholds()

    def build_report(
        self,
        review_result: ReviewResult,
        project_info: ProjectInfo,
        execution_time: float,
        _stage_timings: Dict[str, float],
        token_usage: Optional[Dict[str, TokenUsage]] = None,
        agent_execution_times: Optional[Dict[str, float]] = None,
        config_summary: Optional[ConfigSummary] = None,
    ) -> ReportData:
        """Build complete ReportData from review results."""
        # Extract findings from available agent results (Pattern 5.5)
        critique_findings = self._get_critique_findings(review_result.critique)
        alternative_suggestions = (
            review_result.alternatives.suggestions if review_result.alternatives else []
        )
        alternatives_recommendation = (
            review_result.alternatives.recommendation
            if review_result.alternatives
            else ""
        )
        gap_findings = self._get_gap_findings(review_result.gaps)

        # Calculate severity counts and quality score
        all_scored_findings = list(critique_findings) + list(gap_findings)
        severity_counts = self._count_severities(all_scored_findings)
        quality_score = self._calculate_quality_score(all_scored_findings)
        quality_label = self._score_to_label(quality_score)

        # Build executive summary
        top_findings = self._select_top_findings(critique_findings, gap_findings)
        recommended_action = self._label_to_action(quality_label)
        all_actions = self._build_action_options(recommended_action)
        executive_summary = ExecutiveSummary(
            quality_label=quality_label,
            quality_score=quality_score,
            top_findings=top_findings,
            recommended_action=recommended_action,
            all_actions=all_actions,
            severity_distribution=severity_counts,
        )

        # Build metadata
        metadata = ReportMetadata(
            review_timestamp=project_info.review_timestamp,
            tool_version=project_info.tool_version,
            project_path=str(project_info.project_path),
            project_name=project_info.project_name,
            review_duration=execution_time,
            models_used=project_info.models_used,
            agent_execution_times=agent_execution_times or {},
            token_usage=token_usage or {},
            config_settings=config_summary or ConfigSummary(),
            severity_counts=severity_counts,
        )

        # Build agent statuses
        agent_statuses = self._build_agent_statuses(
            review_result, agent_execution_times or {}
        )

        return ReportData(
            metadata=metadata,
            executive_summary=executive_summary,
            critique_findings=list(critique_findings),
            alternative_suggestions=list(alternative_suggestions),
            alternatives_recommendation=alternatives_recommendation,
            gap_findings=list(gap_findings),
            agent_statuses=agent_statuses,
        )

    def _get_critique_findings(
        self, critique: Optional[CritiqueResult]
    ) -> List[CritiqueFinding]:
        if critique is None:
            return []
        return list(critique.findings)

    def _get_gap_findings(self, gaps: Optional[GapAnalysisResult]) -> List[GapFinding]:
        if gaps is None:
            return []
        return list(gaps.findings)

    def _calculate_quality_score(
        self, findings: List[CritiqueFinding | GapFinding]
    ) -> int:
        """Calculate weighted quality score (BR-5.1)."""
        return sum(SEVERITY_WEIGHTS.get(f.severity, 1) for f in findings)

    def _score_to_label(self, score: int) -> QualityLabel:
        """Map score to quality label using configurable thresholds (BR-5.2)."""
        if score <= self._thresholds.excellent_max_score:
            return QualityLabel.EXCELLENT
        elif score <= self._thresholds.good_max_score:
            return QualityLabel.GOOD
        elif score <= self._thresholds.needs_improvement_max_score:
            return QualityLabel.NEEDS_IMPROVEMENT
        else:
            return QualityLabel.POOR

    def _label_to_action(self, label: QualityLabel) -> RecommendedAction:
        """Map quality label to recommended action (BR-5.7)."""
        if label in (QualityLabel.EXCELLENT, QualityLabel.GOOD):
            return RecommendedAction.APPROVE
        elif label == QualityLabel.NEEDS_IMPROVEMENT:
            return RecommendedAction.EXPLORE_ALTERNATIVES
        else:
            return RecommendedAction.REQUEST_CHANGES

    def _select_top_findings(
        self,
        critique_findings: List[CritiqueFinding],
        gap_findings: List[GapFinding],
    ) -> List[KeyFinding]:
        """Select top 3-5 key findings, deduplicated by topic (BR-5.4)."""
        candidates: List[KeyFinding] = []

        for f in critique_findings:
            candidates.append(
                KeyFinding(
                    title=f.title,
                    severity=f.severity,
                    description=f.description,
                    source_agent="critique",
                    finding_id=f.id,
                )
            )

        for f in gap_findings:
            candidates.append(
                KeyFinding(
                    title=f.title,
                    severity=f.severity,
                    description=f.description,
                    source_agent="gap",
                    finding_id=f.id,
                )
            )

        # Sort by severity (critical first)
        severity_order = {
            Severity.CRITICAL: 0,
            Severity.HIGH: 1,
            Severity.MEDIUM: 2,
            Severity.LOW: 3,
        }
        candidates.sort(key=lambda kf: severity_order.get(kf.severity, 4))

        # Deduplicate by topic key (use lowercase title as proxy)
        seen_topics: set[str] = set()
        deduplicated: List[KeyFinding] = []
        for kf in candidates:
            topic_key = kf.title.lower().strip()
            if topic_key not in seen_topics:
                seen_topics.add(topic_key)
                deduplicated.append(kf)
            if len(deduplicated) >= 5:
                break

        return deduplicated[:5]

    def _build_action_options(
        self, recommended: RecommendedAction
    ) -> List[ActionOption]:
        """Build all three action options with one highlighted (BR-5.6, BR-5.8)."""
        return [
            ActionOption(
                action="Approve",
                description="The design meets quality standards with minor or no issues.",
                is_recommended=(recommended == RecommendedAction.APPROVE),
            ),
            ActionOption(
                action="Request Changes",
                description="Significant issues found that should be addressed before proceeding.",
                is_recommended=(recommended == RecommendedAction.REQUEST_CHANGES),
            ),
            ActionOption(
                action="Explore Alternatives",
                description="Consider alternative approaches to improve the design.",
                is_recommended=(recommended == RecommendedAction.EXPLORE_ALTERNATIVES),
            ),
        ]

    def _count_severities(
        self, findings: List[CritiqueFinding | GapFinding]
    ) -> Dict[str, int]:
        counts: Dict[str, int] = {s.value: 0 for s in Severity}
        for f in findings:
            counts[f.severity.value] = counts.get(f.severity.value, 0) + 1
        return counts

    def _build_agent_statuses(
        self,
        review_result: ReviewResult,
        agent_execution_times: Dict[str, float],
    ) -> List[AgentStatusInfo]:
        statuses: List[AgentStatusInfo] = []

        if review_result.critique is not None:
            statuses.append(
                AgentStatusInfo(
                    agent_name="critique",
                    status=review_result.critique.status,
                    error_message=review_result.critique.error_message,
                    finding_count=len(review_result.critique.findings),
                    execution_time=agent_execution_times.get("critique"),
                )
            )

        if review_result.alternatives is not None:
            statuses.append(
                AgentStatusInfo(
                    agent_name="alternatives",
                    status=review_result.alternatives.status,
                    error_message=review_result.alternatives.error_message,
                    finding_count=len(review_result.alternatives.suggestions),
                    execution_time=agent_execution_times.get("alternatives"),
                )
            )

        if review_result.gaps is not None:
            statuses.append(
                AgentStatusInfo(
                    agent_name="gap",
                    status=review_result.gaps.status,
                    error_message=review_result.gaps.error_message,
                    finding_count=len(review_result.gaps.findings),
                    execution_time=agent_execution_times.get("gap"),
                )
            )

        return statuses
