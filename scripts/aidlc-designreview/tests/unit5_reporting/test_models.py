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
Tests for Unit 5 reporting models.

Tests all Pydantic models (frozen, validation rules), enums,
OutputPaths.from_base(), QualityThresholds ordering validation.
"""

from datetime import datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from design_reviewer.ai_review.models import AgentStatus, Severity
from design_reviewer.reporting.models import (
    ActionOption,
    AgentStatusInfo,
    ConfigSummary,
    KeyFinding,
    OutputPaths,
    ProjectInfo,
    QualityLabel,
    QualityThresholds,
    RecommendedAction,
    ReportData,
    ReportMetadata,
    TokenUsage,
)


class TestQualityLabelEnum:
    def test_values(self):
        assert QualityLabel.EXCELLENT == "Excellent"
        assert QualityLabel.GOOD == "Good"
        assert QualityLabel.NEEDS_IMPROVEMENT == "Needs Improvement"
        assert QualityLabel.POOR == "Poor"

    def test_all_members(self):
        assert len(QualityLabel) == 4


class TestRecommendedActionEnum:
    def test_values(self):
        assert RecommendedAction.APPROVE == "Approve"
        assert RecommendedAction.REQUEST_CHANGES == "Request Changes"
        assert RecommendedAction.EXPLORE_ALTERNATIVES == "Explore Alternatives"

    def test_all_members(self):
        assert len(RecommendedAction) == 3


class TestTokenUsage:
    def test_defaults(self):
        tu = TokenUsage()
        assert tu.input_tokens == 0
        assert tu.output_tokens == 0

    def test_with_values(self):
        tu = TokenUsage(input_tokens=100, output_tokens=50)
        assert tu.input_tokens == 100
        assert tu.output_tokens == 50

    def test_frozen(self):
        tu = TokenUsage()
        with pytest.raises(ValidationError):
            tu.input_tokens = 999


class TestQualityThresholds:
    def test_defaults(self):
        qt = QualityThresholds()
        assert qt.excellent_max_score == 5
        assert qt.good_max_score == 15
        assert qt.needs_improvement_max_score == 30

    def test_custom_valid(self):
        qt = QualityThresholds(
            excellent_max_score=3,
            good_max_score=10,
            needs_improvement_max_score=25,
        )
        assert qt.excellent_max_score == 3

    def test_invalid_ordering_equal(self):
        with pytest.raises(ValidationError, match="ascending"):
            QualityThresholds(
                excellent_max_score=10,
                good_max_score=10,
                needs_improvement_max_score=30,
            )

    def test_invalid_ordering_descending(self):
        with pytest.raises(ValidationError, match="ascending"):
            QualityThresholds(
                excellent_max_score=30,
                good_max_score=15,
                needs_improvement_max_score=5,
            )

    def test_frozen(self):
        qt = QualityThresholds()
        with pytest.raises(ValidationError):
            qt.excellent_max_score = 99


class TestConfigSummary:
    def test_defaults(self):
        cs = ConfigSummary()
        assert cs.severity_threshold == "medium"
        assert cs.alternatives_enabled is True
        assert cs.gap_analysis_enabled is True
        assert isinstance(cs.quality_thresholds, QualityThresholds)

    def test_frozen(self):
        cs = ConfigSummary()
        with pytest.raises(ValidationError):
            cs.severity_threshold = "high"


class TestReportMetadata:
    def test_required_fields(self, sample_report_metadata):
        assert sample_report_metadata.review_timestamp == datetime(
            2026, 3, 11, 10, 0, 0
        )
        assert sample_report_metadata.tool_version == "0.1.0"
        assert sample_report_metadata.project_path == "/test/project"
        assert sample_report_metadata.project_name == "test-project"
        assert sample_report_metadata.review_duration == 45.5

    def test_optional_defaults(self):
        md = ReportMetadata(
            review_timestamp=datetime.now(),
            tool_version="0.1.0",
            project_path="/p",
            project_name="p",
            review_duration=1.0,
        )
        assert md.models_used == {}
        assert md.agent_execution_times == {}
        assert md.token_usage == {}
        assert isinstance(md.config_settings, ConfigSummary)
        assert md.severity_counts == {}

    def test_frozen(self, sample_report_metadata):
        with pytest.raises(ValidationError):
            sample_report_metadata.tool_version = "2.0"


class TestKeyFinding:
    def test_creation(self):
        kf = KeyFinding(
            title="Test Finding",
            severity=Severity.HIGH,
            description="A test",
            source_agent="critique",
            finding_id="f-001",
        )
        assert kf.title == "Test Finding"
        assert kf.severity == Severity.HIGH

    def test_frozen(self):
        kf = KeyFinding(
            title="T",
            severity=Severity.LOW,
            description="D",
            source_agent="gap",
            finding_id="f-002",
        )
        with pytest.raises(ValidationError):
            kf.title = "Changed"


class TestActionOption:
    def test_default_not_recommended(self):
        ao = ActionOption(action="Approve", description="Looks good")
        assert ao.is_recommended is False

    def test_recommended(self):
        ao = ActionOption(
            action="Approve", description="Looks good", is_recommended=True
        )
        assert ao.is_recommended is True


class TestExecutiveSummary:
    def test_creation(self, sample_executive_summary):
        assert sample_executive_summary.quality_label == QualityLabel.NEEDS_IMPROVEMENT
        assert sample_executive_summary.quality_score == 20
        assert len(sample_executive_summary.top_findings) == 1
        assert (
            sample_executive_summary.recommended_action
            == RecommendedAction.EXPLORE_ALTERNATIVES
        )
        assert len(sample_executive_summary.all_actions) == 3

    def test_frozen(self, sample_executive_summary):
        with pytest.raises(ValidationError):
            sample_executive_summary.quality_score = 0


class TestAgentStatusInfo:
    def test_creation(self):
        info = AgentStatusInfo(
            agent_name="critique",
            status=AgentStatus.COMPLETED,
            finding_count=5,
        )
        assert info.agent_name == "critique"
        assert info.execution_time is None
        assert info.error_message is None
        assert info.finding_count == 5

    def test_with_error(self):
        info = AgentStatusInfo(
            agent_name="gap",
            status=AgentStatus.FAILED,
            error_message="Timed out",
        )
        assert info.status == AgentStatus.FAILED
        assert info.error_message == "Timed out"


class TestReportData:
    def test_creation(self, sample_report_data):
        assert len(sample_report_data.critique_findings) == 2
        assert len(sample_report_data.alternative_suggestions) == 1
        assert len(sample_report_data.gap_findings) == 1
        assert len(sample_report_data.agent_statuses) == 3

    def test_empty_lists_defaults(
        self, sample_report_metadata, sample_executive_summary
    ):
        rd = ReportData(
            metadata=sample_report_metadata,
            executive_summary=sample_executive_summary,
        )
        assert rd.critique_findings == []
        assert rd.alternative_suggestions == []
        assert rd.gap_findings == []
        assert rd.agent_statuses == []

    def test_frozen(self, sample_report_data):
        with pytest.raises(ValidationError):
            sample_report_data.critique_findings = []


class TestProjectInfo:
    def test_creation(self, sample_project_info):
        assert sample_project_info.project_name == "test-project"
        assert sample_project_info.tool_version == "0.1.0"
        assert isinstance(sample_project_info.project_path, Path)

    def test_defaults(self):
        pi = ProjectInfo(
            project_path=Path("/p"),
            project_name="p",
            review_timestamp=datetime.now(),
            tool_version="0.1.0",
        )
        assert pi.models_used == {}

    def test_frozen(self, sample_project_info):
        with pytest.raises(ValidationError):
            sample_project_info.project_name = "changed"


class TestOutputPaths:
    def test_from_base_default(self):
        op = OutputPaths.from_base()
        # Timestamped: review-YYYYMMDD-HHMMSS
        assert str(op.base_path).startswith("review-")
        assert op.markdown_path.suffix == ".md"
        assert op.html_path.suffix == ".html"

    def test_from_base_custom(self):
        op = OutputPaths.from_base("output/report")
        assert op.base_path == Path("output/report")
        assert op.markdown_path == Path("output/report.md")
        assert op.html_path == Path("output/report.html")

    def test_from_base_none(self):
        op = OutputPaths.from_base(None)
        assert str(op.base_path).startswith("review-")

    def test_frozen(self):
        op = OutputPaths.from_base()
        with pytest.raises(ValidationError):
            op.base_path = Path("/other")
