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
Application — initializes all components and runs the review pipeline.

Pattern 5.6: Dependency wiring in constructor, per-exception error handling.
"""

import logging
from pathlib import Path
from typing import Optional

from rich.console import Console

from design_reviewer.foundation.config_manager import ConfigManager
from design_reviewer.foundation.exceptions import (
    AIReviewError,
    ConfigurationError,
    DesignReviewerError,
    ParsingError,
    StructureValidationError,
    ValidationError,
)
from design_reviewer.reporting.markdown_formatter import ReportWriteError
from design_reviewer.reporting.models import OutputPaths, QualityThresholds

logger = logging.getLogger(__name__)

# Exit code mapping (BR-5.28)
EXIT_CODE_MAP = {
    ConfigurationError: 1,
    ValidationError: 2,
    StructureValidationError: 2,
    ParsingError: 3,
    AIReviewError: 4,
    ReportWriteError: 4,
}


class Application:
    """Top-level application object that wires dependencies and runs the review.

    D5.1=B: All components created in constructor, wired in run().
    D5.2=B: Per-exception-type error handling with tailored messages.
    """

    def __init__(self, config_path: Optional[str] = None):
        self._config_path = config_path
        self._console = Console()

    def run(self, aidlc_docs: Path, output: Optional[str] = None) -> int:
        """Execute the review and return an exit code.

        Returns:
            0 on success, non-zero on error (BR-5.28).
        """
        try:
            # Initialize configuration
            config_manager = ConfigManager.initialize(
                self._config_path or "config.yaml"
            )
            config = config_manager.get_config()

            # Initialize logger
            from design_reviewer.foundation.logger import Logger

            app_logger = Logger.initialize(
                log_file_path=config.logging.log_file_path,
                log_level=config.logging.log_level,
                max_log_size_mb=config.logging.max_log_size_mb,
                backup_count=config.logging.backup_count,
            )

            # Create output paths
            output_paths = OutputPaths.from_base(output)

            # Create Unit 2 components (validation & discovery)
            from design_reviewer.validation.scanner import ArtifactScanner
            from design_reviewer.validation.classifier import ArtifactClassifier
            from design_reviewer.validation.discoverer import ArtifactDiscoverer
            from design_reviewer.validation.loader import ArtifactLoader
            from design_reviewer.validation.validator import StructureValidator
            from design_reviewer.ai_review.bedrock_client import create_bedrock_client

            aidlc_docs_resolved = aidlc_docs.resolve()
            bedrock_client = create_bedrock_client()
            scanner = ArtifactScanner(aidlc_docs_resolved, app_logger)
            classifier = ArtifactClassifier(
                bedrock_client,
                config.models.default_model,
                app_logger,
            )
            discoverer = ArtifactDiscoverer(scanner, classifier, app_logger)
            structure_validator = StructureValidator(
                aidlc_docs_resolved,
                discoverer,
                app_logger,
            )
            artifact_loader = ArtifactLoader(app_logger)

            # Create Unit 3 components (parsing)
            from design_reviewer.parsing import (
                ApplicationDesignParser,
                FunctionalDesignParser,
                TechnicalEnvironmentParser,
            )

            app_design_parser = ApplicationDesignParser(app_logger)
            func_design_parser = FunctionalDesignParser(app_logger)
            tech_env_parser = TechnicalEnvironmentParser(app_logger)

            # Create Unit 4 components (AI review)
            # PatternLibrary and PromptManager are initialized here (needed by agent execute())
            from design_reviewer.foundation.pattern_library import PatternLibrary
            from design_reviewer.foundation.prompt_manager import PromptManager
            from design_reviewer.ai_review import (
                AgentOrchestrator,
                CritiqueAgent,
                AlternativesAgent,
                GapAnalysisAgent,
            )

            patterns_dir = getattr(config, "patterns_directory", None)
            prompts_dir = getattr(config, "prompts_directory", None)
            PatternLibrary.initialize(
                patterns_dir if isinstance(patterns_dir, str) else "config/patterns"
            )
            PromptManager.initialize(
                prompts_dir if isinstance(prompts_dir, str) else "config/prompts"
            )

            agents = [CritiqueAgent(), AlternativesAgent(), GapAnalysisAgent()]
            agent_orchestrator = AgentOrchestrator(agents)

            # Create Unit 5 reporting components
            from design_reviewer.reporting import (
                HTMLFormatter,
                MarkdownFormatter,
                ReportBuilder,
            )

            thresholds = self._load_quality_thresholds(config)
            report_builder = ReportBuilder(quality_thresholds=thresholds)
            markdown_formatter = MarkdownFormatter()
            html_formatter = HTMLFormatter()

            # Create orchestrator with all dependencies (BR-5.20)
            from design_reviewer.orchestration import ReviewOrchestrator

            orchestrator = ReviewOrchestrator(
                structure_validator=structure_validator,
                artifact_discoverer=discoverer,
                artifact_loader=artifact_loader,
                app_design_parser=app_design_parser,
                func_design_parser=func_design_parser,
                tech_env_parser=tech_env_parser,
                agent_orchestrator=agent_orchestrator,
                report_builder=report_builder,
                markdown_formatter=markdown_formatter,
                html_formatter=html_formatter,
                console=self._console,
            )

            # Build project info
            from datetime import datetime
            from design_reviewer.reporting.models import ProjectInfo

            models_used = {
                "critique": config_manager.get_model_config("critique"),
                "alternatives": config_manager.get_model_config("alternatives"),
                "gap": config_manager.get_model_config("gap"),
            }
            project_info = ProjectInfo(
                project_path=aidlc_docs_resolved,
                project_name=aidlc_docs_resolved.name,
                review_timestamp=datetime.now(),
                tool_version="0.1.0",
                models_used=models_used,
            )

            # Execute review
            orchestrator.execute_review(
                aidlc_docs_path=aidlc_docs_resolved,
                output_paths=output_paths,
                project_info=project_info,
            )

            self._console.print(
                f"[bold green]Review complete.[/bold green] "
                f"Reports written to: {output_paths.markdown_path}, {output_paths.html_path}"
            )
            return 0

        except ConfigurationError as exc:
            self._log_error("Configuration Error", exc)
            return 1
        except (ValidationError, StructureValidationError) as exc:
            self._log_error("Structure Validation Error", exc)
            return 2
        except ParsingError as exc:
            self._log_error("Parsing Error", exc)
            return 3
        except (AIReviewError, ReportWriteError) as exc:
            self._log_error("Execution Error", exc)
            return 4
        except DesignReviewerError as exc:
            self._log_error("Error", exc)
            return 1
        except Exception as exc:
            self._log_error("Unexpected Error", exc)
            return 1
        finally:
            from design_reviewer.foundation.pattern_library import PatternLibrary
            from design_reviewer.foundation.prompt_manager import PromptManager

            for singleton in (PatternLibrary, PromptManager, ConfigManager):
                try:
                    singleton.reset()
                except Exception:  # noqa: BLE001  # nosec B110 — intentional: cleanup must not propagate errors
                    pass

    def _log_error(self, category: str, exc: Exception) -> None:
        """Display error with Rich formatting (BR-5.32)."""
        self._console.print(f"[bold red]{category}:[/bold red] {exc}")
        if hasattr(exc, "suggested_fix") and exc.suggested_fix:
            self._console.print(f"[dim]{exc.suggested_fix}[/dim]")
        logger.error("%s: %s", category, exc)

    def _load_quality_thresholds(self, config) -> QualityThresholds:
        """Load quality thresholds from config or use defaults (BR-5.2)."""
        try:
            review = getattr(config, "review", None)
            if review and hasattr(review, "quality_thresholds"):
                qt = review.quality_thresholds
                if isinstance(qt, dict):
                    return QualityThresholds(**qt)
        except Exception:  # noqa: BLE001  # nosec B110 — intentional: malformed config falls back to defaults
            pass
        return QualityThresholds()
