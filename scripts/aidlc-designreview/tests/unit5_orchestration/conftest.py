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
Shared test fixtures for Unit 5: Orchestration tests.
"""

from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from design_reviewer.ai_review.models import (
    AgentStatus,
    CritiqueFinding,
    CritiqueResult,
    AlternativesResult,
    GapAnalysisResult,
    ReviewResult,
    ReviewSummary,
    Severity,
)
from design_reviewer.reporting.models import OutputPaths, ProjectInfo


@pytest.fixture
def mock_structure_validator():
    mock = MagicMock()
    mock.validate_structure.return_value = MagicMock(artifacts=[])
    return mock


@pytest.fixture
def mock_artifact_discoverer():
    mock = MagicMock()
    mock.discover.return_value = MagicMock()
    return mock


@pytest.fixture
def mock_artifact_loader():
    mock = MagicMock()
    mock.load_multiple_artifacts.return_value = ([], {})
    return mock


@pytest.fixture
def mock_app_design_parser():
    mock = MagicMock()
    mock.parse.return_value = MagicMock()
    return mock


@pytest.fixture
def mock_func_design_parser():
    mock = MagicMock()
    mock.parse.return_value = MagicMock()
    return mock


@pytest.fixture
def mock_tech_env_parser():
    mock = MagicMock()
    mock.parse.return_value = MagicMock()
    return mock


@pytest.fixture
def mock_agent_orchestrator():
    mock = MagicMock()
    critique_result = CritiqueResult(
        findings=[
            CritiqueFinding(
                id="c1",
                title="Test Finding",
                severity=Severity.LOW,
                description="D",
                location="L",
                recommendation="R",
            ),
        ],
        status=AgentStatus.COMPLETED,
    )
    alternatives_result = AlternativesResult(status=AgentStatus.COMPLETED)
    gap_result = GapAnalysisResult(status=AgentStatus.COMPLETED)
    review_result = ReviewResult(
        critique=critique_result,
        alternatives=alternatives_result,
        gaps=gap_result,
        summary=ReviewSummary(
            total_critique_findings=1,
            agents_completed=3,
            severity_counts={"low": 1},
        ),
    )
    mock.execute_review.return_value = review_result
    mock.run_critique.return_value = critique_result
    mock.run_phase2.return_value = (
        alternatives_result,
        gap_result,
        {"alternatives": 5.0, "gap": 5.0},
    )
    mock.build_review_result.return_value = review_result
    return mock


@pytest.fixture
def mock_report_builder():
    mock = MagicMock()
    # build_report returns a MagicMock that acts as ReportData
    mock.build_report.return_value = MagicMock()
    return mock


@pytest.fixture
def mock_markdown_formatter():
    mock = MagicMock()
    mock.format.return_value = "# Markdown Report"
    mock.write_to_file.return_value = None
    return mock


@pytest.fixture
def mock_html_formatter():
    mock = MagicMock()
    mock.format.return_value = "<html>Report</html>"
    mock.write_to_file.return_value = None
    return mock


@pytest.fixture
def mock_console():
    mock = MagicMock()
    mock.status.return_value.__enter__ = MagicMock()
    mock.status.return_value.__exit__ = MagicMock(return_value=False)
    return mock


@pytest.fixture
def sample_output_paths(tmp_path):
    return OutputPaths(
        base_path=tmp_path / "review",
        markdown_path=tmp_path / "review.md",
        html_path=tmp_path / "review.html",
    )


@pytest.fixture
def sample_project_info():
    return ProjectInfo(
        project_path=Path("/test/project"),
        project_name="test-project",
        review_timestamp=datetime(2026, 3, 11, 10, 0, 0),
        tool_version="0.1.0",
        models_used={},
    )
