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
ReviewOrchestrator — end-to-end review pipeline orchestration.

Pattern 5.3: Staged context manager for timing + Rich progress.
Pattern 5.4: Best-effort report writing.
BR-5.20: Constructor injection. BR-5.22: Return values between stages.
"""

import logging
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List

from rich.console import Console

from design_reviewer.reporting.markdown_formatter import (
    MarkdownFormatter,
    ReportWriteError,
)
from design_reviewer.reporting.html_formatter import HTMLFormatter
from design_reviewer.reporting.models import OutputPaths, ReportData, TokenUsage
from design_reviewer.reporting.report_builder import ReportBuilder

logger = logging.getLogger(__name__)


class ReviewOrchestrator:
    """Orchestrates the complete design review pipeline.

    Receives all dependencies via constructor injection (BR-5.20).
    Uses _stage() context manager for timing and progress display (Pattern 5.3).
    """

    def __init__(
        self,
        structure_validator,
        artifact_discoverer,
        artifact_loader,
        app_design_parser,
        func_design_parser,
        tech_env_parser,
        agent_orchestrator,
        report_builder: ReportBuilder,
        markdown_formatter: MarkdownFormatter,
        html_formatter: HTMLFormatter,
        console: Console | None = None,
    ):
        self._structure_validator = structure_validator
        self._artifact_discoverer = artifact_discoverer
        self._artifact_loader = artifact_loader
        self._app_design_parser = app_design_parser
        self._func_design_parser = func_design_parser
        self._tech_env_parser = tech_env_parser
        self._agent_orchestrator = agent_orchestrator
        self._report_builder = report_builder
        self._markdown_formatter = markdown_formatter
        self._html_formatter = html_formatter
        self._console = console or Console()
        self._stage_timings: Dict[str, float] = {}

    @property
    def stage_timings(self) -> Dict[str, float]:
        """Get recorded stage timings."""
        return dict(self._stage_timings)

    @contextmanager
    def _stage(self, stage_name: str, display_text: str, use_spinner: bool = False):
        """Context manager that times a stage and shows progress (Pattern 5.3).

        Args:
            stage_name: Key for stage_timings dict.
            display_text: Text to display to user.
            use_spinner: If True, show a Rich spinner during execution. Set to
                False (default) for stages that use their own progress bars to
                avoid overlapping live displays.
        """
        self._console.print(f"[bold blue]{display_text}...[/bold blue]")
        start = time.monotonic()
        try:
            if use_spinner:
                with self._console.status(f"[bold green]{display_text}..."):
                    yield
            else:
                yield
        finally:
            elapsed = time.monotonic() - start
            self._stage_timings[stage_name] = elapsed
            logger.info("Stage '%s' completed in %.1fs", stage_name, elapsed)

    def execute_review(
        self,
        aidlc_docs_path: Path,
        output_paths: OutputPaths,
        project_info=None,
    ) -> ReportData:
        """Execute the full review pipeline (BR-5.22: return values between stages).

        Returns:
            ReportData for the completed review.

        Raises:
            Any DesignReviewerError subclass — propagated to CLI (BR-5.23).
        """
        # Stage 1+2: Validate structure (includes artifact discovery + classification)
        # Has its own progress bar for classification, so no spinner
        with self._stage("validation", "Validating structure"):
            validation_result = self._structure_validator.validate_structure()

        # Record discovery timing under its own key for reporting
        self._stage_timings["discovery"] = 0.0

        # Stage 3: Load artifacts (has its own progress bar)
        with self._stage("loading", "Loading artifacts"):
            artifact_infos = validation_result.artifacts
            loaded_artifacts, content_map = (
                self._artifact_loader.load_multiple_artifacts(artifact_infos)
            )

        # Stage 4: Parse artifacts (fast, no progress bar needed)
        with self._stage("parsing", "Parsing artifacts"):
            design_data = self._parse_artifacts(loaded_artifacts, content_map)

        # Stage 5: AI review (long-running, per-agent status updates)
        self._console.print("[bold blue]Running AI review...[/bold blue]")
        ai_start = time.monotonic()
        critique_start = time.monotonic()
        with self._console.status(
            "[bold green]Phase 1/2: Analyzing design (critique agent)..."
        ):
            critique_result = self._agent_orchestrator.run_critique(design_data)
        critique_elapsed = time.monotonic() - critique_start
        with self._console.status(
            "[bold green]Phase 2/2: Generating alternatives & gap analysis..."
        ):
            alternatives_result, gap_result, phase2_timings = (
                self._agent_orchestrator.run_phase2(design_data, critique_result)
            )
        review_result = self._agent_orchestrator.build_review_result(
            critique_result, alternatives_result, gap_result
        )
        self._stage_timings["ai_review"] = time.monotonic() - ai_start
        logger.info(
            "Stage 'ai_review' completed in %.1fs", self._stage_timings["ai_review"]
        )
        agent_execution_times = {"critique": critique_elapsed}
        agent_execution_times.update(phase2_timings)

        # Collect token usage from agent results
        token_usage = self._collect_token_usage(
            critique_result, alternatives_result, gap_result
        )

        # Stage 6: Build and write reports
        with self._stage("reporting", "Generating reports"):
            total_time = sum(self._stage_timings.values())
            report_data = self._report_builder.build_report(
                review_result=review_result,
                project_info=project_info,
                execution_time=total_time,
                _stage_timings=self._stage_timings,
                agent_execution_times=agent_execution_times,
                token_usage=token_usage,
            )
            self._write_reports(report_data, output_paths)

        return report_data

    def _parse_artifacts(
        self,
        loaded_artifacts: list,
        content_map: Dict[Path, str],
    ) -> object:
        """Parse loaded artifacts through type-specific parsers."""
        from design_reviewer.parsing.models import DesignData
        from design_reviewer.validation.models import ArtifactType

        # Filter artifacts and content by type
        def _filter(artifact_type):
            infos = [a for a in loaded_artifacts if a.artifact_type == artifact_type]
            cmap = {a.path: content_map[a.path] for a in infos if a.path in content_map}
            return infos, cmap

        app_infos, app_content = _filter(ArtifactType.APPLICATION_DESIGN)
        func_infos, func_content = _filter(ArtifactType.FUNCTIONAL_DESIGN)
        tech_infos, tech_content = _filter(ArtifactType.TECHNICAL_ENVIRONMENT)

        # ApplicationDesignParser.parse(content_map, artifact_infos)
        app_design = self._app_design_parser.parse(app_content, app_infos)

        # FunctionalDesignParser.parse(content_map, artifact_infos)
        func_design = self._func_design_parser.parse(func_content, func_infos)

        # TechnicalEnvironmentParser.parse(content, file_path) — single file
        tech_content_str = (
            next(iter(tech_content.values()), None) if tech_content else None
        )
        tech_path = next(iter(tech_content.keys()), None) if tech_content else None
        tech_env = self._tech_env_parser.parse(tech_content_str, tech_path)

        return DesignData(
            app_design=app_design,
            functional_designs=func_design,
            tech_env=tech_env,
            raw_content=content_map,
        )

    @staticmethod
    def _collect_token_usage(
        critique_result, alternatives_result, gap_result
    ) -> Dict[str, "TokenUsage"]:
        """Extract token usage from agent results into TokenUsage models."""
        usage: Dict[str, TokenUsage] = {}
        for name, result in [
            ("critique", critique_result),
            ("alternatives", alternatives_result),
            ("gap", gap_result),
        ]:
            if result and getattr(result, "token_usage", None):
                usage[name] = TokenUsage(
                    input_tokens=result.token_usage.get("input_tokens", 0),
                    output_tokens=result.token_usage.get("output_tokens", 0),
                )
        return usage

    def _write_reports(
        self, report_data: ReportData, output_paths: OutputPaths
    ) -> None:
        """Write both report formats with best-effort approach (Pattern 5.4)."""
        errors: List[str] = []

        # Markdown
        try:
            md_content = self._markdown_formatter.format(report_data)
            self._markdown_formatter.write_to_file(
                md_content, output_paths.markdown_path
            )
        except Exception as exc:
            logger.error("Failed to write markdown report: %s", exc)
            errors.append(f"Markdown: {exc}")

        # HTML
        try:
            html_content = self._html_formatter.format(report_data)
            self._html_formatter.write_to_file(html_content, output_paths.html_path)
        except Exception as exc:
            logger.error("Failed to write HTML report: %s", exc)
            errors.append(f"HTML: {exc}")

        if errors:
            raise ReportWriteError(f"Report write failures: {'; '.join(errors)}")
