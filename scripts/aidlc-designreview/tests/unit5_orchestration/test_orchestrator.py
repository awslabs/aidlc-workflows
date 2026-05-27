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
Tests for Unit 5 ReviewOrchestrator.

Tests execute_review pipeline (mocked components), stage timing recorded,
best-effort write behavior (one fails), Rich spinner integration (mocked Console).
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from design_reviewer.reporting.markdown_formatter import ReportWriteError
from design_reviewer.orchestration.orchestrator import ReviewOrchestrator


@pytest.fixture
def orchestrator(
    mock_structure_validator,
    mock_artifact_discoverer,
    mock_artifact_loader,
    mock_app_design_parser,
    mock_func_design_parser,
    mock_tech_env_parser,
    mock_agent_orchestrator,
    mock_report_builder,
    mock_markdown_formatter,
    mock_html_formatter,
    mock_console,
):
    return ReviewOrchestrator(
        structure_validator=mock_structure_validator,
        artifact_discoverer=mock_artifact_discoverer,
        artifact_loader=mock_artifact_loader,
        app_design_parser=mock_app_design_parser,
        func_design_parser=mock_func_design_parser,
        tech_env_parser=mock_tech_env_parser,
        agent_orchestrator=mock_agent_orchestrator,
        report_builder=mock_report_builder,
        markdown_formatter=mock_markdown_formatter,
        html_formatter=mock_html_formatter,
        console=mock_console,
    )


class TestExecuteReview:
    @patch("design_reviewer.parsing.models.DesignData", new=MagicMock)
    def test_full_pipeline_executes(
        self,
        orchestrator,
        mock_structure_validator,
        mock_artifact_discoverer,
        mock_artifact_loader,
        mock_agent_orchestrator,
        mock_report_builder,
        sample_output_paths,
        sample_project_info,
    ):
        result = orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=sample_output_paths,
            project_info=sample_project_info,
        )
        mock_structure_validator.validate_structure.assert_called_once()
        mock_artifact_loader.load_multiple_artifacts.assert_called_once()
        mock_agent_orchestrator.run_critique.assert_called_once()
        mock_agent_orchestrator.run_phase2.assert_called_once()
        mock_agent_orchestrator.build_review_result.assert_called_once()
        mock_report_builder.build_report.assert_called_once()
        assert result is not None

    @patch("design_reviewer.parsing.models.DesignData", new=MagicMock)
    def test_records_stage_timings(
        self,
        orchestrator,
        sample_output_paths,
        sample_project_info,
    ):
        orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=sample_output_paths,
            project_info=sample_project_info,
        )
        timings = orchestrator.stage_timings
        assert "validation" in timings
        assert "discovery" in timings
        assert "loading" in timings
        assert "parsing" in timings
        assert "ai_review" in timings
        assert "reporting" in timings
        for stage, t in timings.items():
            assert t >= 0, f"Stage {stage} has negative timing"

    @patch("design_reviewer.parsing.models.DesignData", new=MagicMock)
    def test_console_print_called(
        self,
        orchestrator,
        mock_console,
        sample_output_paths,
        sample_project_info,
    ):
        orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=sample_output_paths,
            project_info=sample_project_info,
        )
        # Console.print is called for each stage display (5 stages)
        assert mock_console.print.call_count >= 5

    @patch("design_reviewer.parsing.models.DesignData", new=MagicMock)
    def test_stage_timings_property_returns_copy(
        self,
        orchestrator,
        sample_output_paths,
        sample_project_info,
    ):
        orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=sample_output_paths,
            project_info=sample_project_info,
        )
        t1 = orchestrator.stage_timings
        t2 = orchestrator.stage_timings
        assert t1 == t2
        assert t1 is not t2


class TestBestEffortWriting:
    @patch("design_reviewer.parsing.models.DesignData", new=MagicMock)
    def test_markdown_failure_still_writes_html(
        self,
        orchestrator,
        mock_markdown_formatter,
        mock_html_formatter,
        sample_output_paths,
        sample_project_info,
    ):
        mock_markdown_formatter.format.side_effect = Exception("MD failed")
        with pytest.raises(ReportWriteError, match="Markdown"):
            orchestrator.execute_review(
                aidlc_docs_path=Path("/test/docs"),
                output_paths=sample_output_paths,
                project_info=sample_project_info,
            )
        # HTML formatter should still have been called
        mock_html_formatter.format.assert_called_once()

    @patch("design_reviewer.parsing.models.DesignData", new=MagicMock)
    def test_html_failure_still_wrote_markdown(
        self,
        orchestrator,
        mock_markdown_formatter,
        mock_html_formatter,
        sample_output_paths,
        sample_project_info,
    ):
        mock_html_formatter.format.side_effect = Exception("HTML failed")
        with pytest.raises(ReportWriteError, match="HTML"):
            orchestrator.execute_review(
                aidlc_docs_path=Path("/test/docs"),
                output_paths=sample_output_paths,
                project_info=sample_project_info,
            )
        # Markdown should have been written successfully
        mock_markdown_formatter.format.assert_called_once()
        mock_markdown_formatter.write_to_file.assert_called_once()

    @patch("design_reviewer.parsing.models.DesignData", new=MagicMock)
    def test_both_fail_reports_both_errors(
        self,
        orchestrator,
        mock_markdown_formatter,
        mock_html_formatter,
        sample_output_paths,
        sample_project_info,
    ):
        mock_markdown_formatter.format.side_effect = Exception("MD failed")
        mock_html_formatter.format.side_effect = Exception("HTML failed")
        with pytest.raises(ReportWriteError, match="Markdown.*HTML|HTML.*Markdown"):
            orchestrator.execute_review(
                aidlc_docs_path=Path("/test/docs"),
                output_paths=sample_output_paths,
                project_info=sample_project_info,
            )


class TestPipelineErrorPropagation:
    def test_validation_error_propagates(
        self,
        orchestrator,
        mock_structure_validator,
        sample_output_paths,
        sample_project_info,
    ):
        from design_reviewer.foundation.exceptions import StructureValidationError

        mock_structure_validator.validate_structure.side_effect = (
            StructureValidationError("bad structure")
        )
        with pytest.raises(StructureValidationError):
            orchestrator.execute_review(
                aidlc_docs_path=Path("/test/docs"),
                output_paths=sample_output_paths,
                project_info=sample_project_info,
            )

    def test_parsing_error_propagates(
        self,
        orchestrator,
        mock_app_design_parser,
        sample_output_paths,
        sample_project_info,
    ):
        from design_reviewer.foundation.exceptions import ParsingError

        mock_app_design_parser.parse.side_effect = ParsingError("parse failed")
        with pytest.raises(ParsingError):
            orchestrator.execute_review(
                aidlc_docs_path=Path("/test/docs"),
                output_paths=sample_output_paths,
                project_info=sample_project_info,
            )
