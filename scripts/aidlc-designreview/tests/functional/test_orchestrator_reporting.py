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
Functional tests: Orchestrator → real Reporting pipeline.

Mocks upstream components (validators, parsers, AI) but uses real:
  ReportBuilder, MarkdownFormatter, HTMLFormatter, Jinja2 templates.

Verifies the orchestrator correctly wires stages together and produces
actual report files on disk.
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from design_reviewer.orchestration.orchestrator import ReviewOrchestrator
from design_reviewer.reporting.html_formatter import HTMLFormatter
from design_reviewer.reporting.markdown_formatter import (
    MarkdownFormatter,
    ReportWriteError,
)
from design_reviewer.reporting.report_builder import ReportBuilder

# Patch DesignData at source so _parse_artifacts doesn't fail on raw_content
_DESIGN_DATA_PATCH = "design_reviewer.parsing.models.DesignData"


@pytest.fixture
def mock_upstream():
    """Mock all upstream components (Units 2-4)."""
    validator = MagicMock()
    validator.validate_structure.return_value = MagicMock(artifacts=[])

    loader = MagicMock()
    loader.load_multiple_artifacts.return_value = ([], {})

    return {
        "structure_validator": validator,
        "artifact_discoverer": MagicMock(),
        "artifact_loader": loader,
        "app_design_parser": MagicMock(),
        "func_design_parser": MagicMock(),
        "tech_env_parser": MagicMock(),
    }


def _configure_agent_mock(mock, review_result):
    """Configure an agent orchestrator mock for both legacy and per-phase calls."""
    mock.execute_review.return_value = review_result
    mock.run_critique.return_value = review_result.critique
    alts = review_result.alternatives
    gaps = review_result.gaps
    mock.run_phase2.return_value = (alts, gaps, {"alternatives": 5.0, "gap": 5.0})
    mock.build_review_result.return_value = review_result
    return mock


@pytest.fixture
def mock_agent_orchestrator(review_result_healthy):
    """AI agent orchestrator that returns a canned ReviewResult."""
    return _configure_agent_mock(MagicMock(), review_result_healthy)


@pytest.fixture
def real_orchestrator(mock_upstream, mock_agent_orchestrator):
    """Orchestrator with mocked upstream but real reporting components."""
    console = MagicMock()
    console.status.return_value.__enter__ = MagicMock(return_value=None)
    console.status.return_value.__exit__ = MagicMock(return_value=False)
    return ReviewOrchestrator(
        structure_validator=mock_upstream["structure_validator"],
        artifact_discoverer=mock_upstream["artifact_discoverer"],
        artifact_loader=mock_upstream["artifact_loader"],
        app_design_parser=mock_upstream["app_design_parser"],
        func_design_parser=mock_upstream["func_design_parser"],
        tech_env_parser=mock_upstream["tech_env_parser"],
        agent_orchestrator=mock_agent_orchestrator,
        report_builder=ReportBuilder(),
        markdown_formatter=MarkdownFormatter(),
        html_formatter=HTMLFormatter(),
        console=console,
    )


@patch(_DESIGN_DATA_PATCH, new=MagicMock)
class TestOrchestratorProducesFiles:
    """Orchestrator with real reporting produces actual report files."""

    def test_healthy_review_writes_both_files(
        self, real_orchestrator, project_info, output_paths
    ):
        report = real_orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=output_paths,
            project_info=project_info,
        )

        assert output_paths.markdown_path.exists()
        assert output_paths.html_path.exists()
        assert output_paths.markdown_path.stat().st_size > 0
        assert output_paths.html_path.stat().st_size > 0
        assert report is not None

    def test_markdown_file_contains_expected_content(
        self, real_orchestrator, project_info, output_paths
    ):
        real_orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=output_paths,
            project_info=project_info,
        )

        text = output_paths.markdown_path.read_text(encoding="utf-8")
        assert "my-app" in text
        assert "Consider Adding Retry Logic" in text
        assert "Excellent" in text

    def test_html_file_is_standalone(
        self, real_orchestrator, project_info, output_paths
    ):
        real_orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=output_paths,
            project_info=project_info,
        )

        html = output_paths.html_path.read_text(encoding="utf-8")
        assert "<style" in html
        assert "<script" in html
        assert 'rel="stylesheet"' not in html


@patch(_DESIGN_DATA_PATCH, new=MagicMock)
class TestOrchestratorWithDifferentResults:
    """Orchestrator produces correct quality labels for different inputs."""

    def test_critical_review_produces_poor_report(
        self, mock_upstream, review_result_critical, project_info, output_paths
    ):
        mock_ai = _configure_agent_mock(MagicMock(), review_result_critical)
        console = MagicMock()
        console.status.return_value.__enter__ = MagicMock(return_value=None)
        console.status.return_value.__exit__ = MagicMock(return_value=False)

        orchestrator = ReviewOrchestrator(
            **mock_upstream,
            agent_orchestrator=mock_ai,
            report_builder=ReportBuilder(),
            markdown_formatter=MarkdownFormatter(),
            html_formatter=HTMLFormatter(),
            console=console,
        )

        report = orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=output_paths,
            project_info=project_info,
        )

        text = output_paths.markdown_path.read_text(encoding="utf-8")
        assert "Poor" in text
        assert "Request Changes" in text
        assert report.executive_summary.quality_score == 39

    def test_partial_review_handles_failed_agents(
        self, mock_upstream, review_result_partial, project_info, output_paths
    ):
        mock_ai = _configure_agent_mock(MagicMock(), review_result_partial)
        console = MagicMock()
        console.status.return_value.__enter__ = MagicMock(return_value=None)
        console.status.return_value.__exit__ = MagicMock(return_value=False)

        orchestrator = ReviewOrchestrator(
            **mock_upstream,
            agent_orchestrator=mock_ai,
            report_builder=ReportBuilder(),
            markdown_formatter=MarkdownFormatter(),
            html_formatter=HTMLFormatter(),
            console=console,
        )

        report = orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=output_paths,
            project_info=project_info,
        )

        text = output_paths.markdown_path.read_text(encoding="utf-8")
        assert "Hardcoded Config" in text
        assert "Failed" in text
        assert len(report.critique_findings) == 1


@patch(_DESIGN_DATA_PATCH, new=MagicMock)
class TestOrchestratorTimings:
    """Orchestrator records stage timings through real execution."""

    def test_all_stages_have_timings(
        self, real_orchestrator, project_info, output_paths
    ):
        real_orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=output_paths,
            project_info=project_info,
        )

        timings = real_orchestrator.stage_timings
        assert "validation" in timings
        assert "discovery" in timings
        assert "loading" in timings
        assert "parsing" in timings
        assert "ai_review" in timings
        assert "reporting" in timings
        for stage, t in timings.items():
            assert t >= 0, f"Stage {stage} has negative timing"

    def test_timings_appear_in_report_metadata(
        self, real_orchestrator, project_info, output_paths
    ):
        report = real_orchestrator.execute_review(
            aidlc_docs_path=Path("/test/docs"),
            output_paths=output_paths,
            project_info=project_info,
        )

        # Report should record a non-zero execution time
        assert report.metadata.review_duration > 0


@patch(_DESIGN_DATA_PATCH, new=MagicMock)
class TestOrchestratorBestEffortWriting:
    """Best-effort report writing: one formatter failing doesn't prevent the other."""

    def test_bad_markdown_path_still_writes_html(
        self, mock_upstream, mock_agent_orchestrator, project_info, tmp_path
    ):
        console = MagicMock()
        console.status.return_value.__enter__ = MagicMock(return_value=None)
        console.status.return_value.__exit__ = MagicMock(return_value=False)

        # Create a blocker file so markdown path is invalid
        blocker = tmp_path / "blocker"
        blocker.write_text("x")

        from design_reviewer.reporting.models import OutputPaths

        bad_paths = OutputPaths(
            base_path=tmp_path / "review",
            markdown_path=blocker / "review.md",  # file-as-directory
            html_path=tmp_path / "review.html",
        )

        orchestrator = ReviewOrchestrator(
            **mock_upstream,
            agent_orchestrator=mock_agent_orchestrator,
            report_builder=ReportBuilder(),
            markdown_formatter=MarkdownFormatter(),
            html_formatter=HTMLFormatter(),
            console=console,
        )

        with pytest.raises(ReportWriteError, match="Markdown"):
            orchestrator.execute_review(
                aidlc_docs_path=Path("/test/docs"),
                output_paths=bad_paths,
                project_info=project_info,
            )

        # HTML should still have been written
        assert bad_paths.html_path.exists()
        html = bad_paths.html_path.read_text(encoding="utf-8")
        assert "<html" in html.lower()
