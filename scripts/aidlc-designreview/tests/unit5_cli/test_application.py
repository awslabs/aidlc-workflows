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
Tests for Unit 5 Application class.

Tests dependency wiring, run() with mocked orchestrator (success, each
exception type -> exit code), error message formatting.
"""

from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import pytest

from design_reviewer.cli.application import Application, EXIT_CODE_MAP
from design_reviewer.foundation.exceptions import (
    AIReviewError,
    ConfigurationError,
    DesignReviewerError,
    ParsingError,
    StructureValidationError,
    ValidationError,
)
from design_reviewer.reporting.markdown_formatter import ReportWriteError

# All lazy-imported module paths that Application.run() uses.
# Must match the exact import paths used inside Application.run().
_LAZY_IMPORTS = [
    "design_reviewer.foundation.logger.Logger",
    "design_reviewer.ai_review.bedrock_client.create_bedrock_client",
    "design_reviewer.validation.scanner.ArtifactScanner",
    "design_reviewer.validation.classifier.ArtifactClassifier",
    "design_reviewer.validation.discoverer.ArtifactDiscoverer",
    "design_reviewer.validation.validator.StructureValidator",
    "design_reviewer.validation.loader.ArtifactLoader",
    "design_reviewer.parsing.app_design.ApplicationDesignParser",
    "design_reviewer.parsing.func_design.FunctionalDesignParser",
    "design_reviewer.parsing.tech_env.TechnicalEnvironmentParser",
    "design_reviewer.foundation.pattern_library.PatternLibrary",
    "design_reviewer.foundation.prompt_manager.PromptManager",
    "design_reviewer.ai_review.CritiqueAgent",
    "design_reviewer.ai_review.AlternativesAgent",
    "design_reviewer.ai_review.GapAnalysisAgent",
    "design_reviewer.ai_review.AgentOrchestrator",
    "design_reviewer.reporting.report_builder.ReportBuilder",
    "design_reviewer.reporting.markdown_formatter.MarkdownFormatter",
    "design_reviewer.reporting.html_formatter.HTMLFormatter",
    "design_reviewer.orchestration.ReviewOrchestrator",
]


@pytest.fixture
def app():
    return Application(config_path=None)


@pytest.fixture
def aidlc_docs(tmp_path):
    docs = tmp_path / "aidlc-docs"
    docs.mkdir()
    return docs


@pytest.fixture
def mock_all_deps():
    """Patch ConfigManager and all lazily-imported dependencies. Returns dict of mocks."""
    mocks = {}
    with ExitStack() as stack:
        mocks["ConfigManager"] = stack.enter_context(
            patch("design_reviewer.cli.application.ConfigManager")
        )
        mock_config = MagicMock()
        mock_config.review = None
        mock_cm_instance = mocks["ConfigManager"].initialize.return_value
        mock_cm_instance.get_config.return_value = mock_config
        mock_cm_instance.get_model_config.return_value = "claude-sonnet-4-6"

        for path in _LAZY_IMPORTS:
            name = path.rsplit(".", 1)[-1]
            mocks[name] = stack.enter_context(patch(path))

        yield mocks


class TestExitCodeMap:
    def test_configuration_error_code(self):
        assert EXIT_CODE_MAP[ConfigurationError] == 1

    def test_validation_error_code(self):
        assert EXIT_CODE_MAP[ValidationError] == 2

    def test_structure_validation_error_code(self):
        assert EXIT_CODE_MAP[StructureValidationError] == 2

    def test_parsing_error_code(self):
        assert EXIT_CODE_MAP[ParsingError] == 3

    def test_ai_review_error_code(self):
        assert EXIT_CODE_MAP[AIReviewError] == 4

    def test_report_write_error_code(self):
        assert EXIT_CODE_MAP[ReportWriteError] == 4


class TestApplicationRun:
    @patch("design_reviewer.cli.application.ConfigManager")
    def test_configuration_error_returns_1(self, mock_cm_cls, app, aidlc_docs):
        mock_cm_cls.initialize.side_effect = ConfigurationError("bad config")
        exit_code = app.run(aidlc_docs=aidlc_docs)
        assert exit_code == 1

    def test_validation_error_returns_2(self, app, aidlc_docs, mock_all_deps):
        mock_all_deps[
            "ReviewOrchestrator"
        ].return_value.execute_review.side_effect = StructureValidationError("invalid")
        exit_code = app.run(aidlc_docs=aidlc_docs)
        assert exit_code == 2

    def test_parsing_error_returns_3(self, app, aidlc_docs, mock_all_deps):
        mock_all_deps[
            "ReviewOrchestrator"
        ].return_value.execute_review.side_effect = ParsingError("parse error")
        exit_code = app.run(aidlc_docs=aidlc_docs)
        assert exit_code == 3

    def test_ai_review_error_returns_4(self, app, aidlc_docs, mock_all_deps):
        mock_all_deps[
            "ReviewOrchestrator"
        ].return_value.execute_review.side_effect = AIReviewError("AI failed")
        exit_code = app.run(aidlc_docs=aidlc_docs)
        assert exit_code == 4

    def test_report_write_error_returns_4(self, app, aidlc_docs, mock_all_deps):
        mock_all_deps[
            "ReviewOrchestrator"
        ].return_value.execute_review.side_effect = ReportWriteError("write failed")
        exit_code = app.run(aidlc_docs=aidlc_docs)
        assert exit_code == 4

    @patch("design_reviewer.cli.application.ConfigManager")
    def test_unexpected_error_returns_1(self, mock_cm_cls, app, aidlc_docs):
        mock_cm_cls.initialize.side_effect = RuntimeError("unexpected")
        exit_code = app.run(aidlc_docs=aidlc_docs)
        assert exit_code == 1

    @patch("design_reviewer.cli.application.ConfigManager")
    def test_design_reviewer_error_returns_1(self, mock_cm_cls, app, aidlc_docs):
        mock_cm_cls.initialize.side_effect = DesignReviewerError("generic")
        exit_code = app.run(aidlc_docs=aidlc_docs)
        assert exit_code == 1

    def test_success_returns_0(self, app, aidlc_docs, mock_all_deps):
        exit_code = app.run(aidlc_docs=aidlc_docs)
        assert exit_code == 0

    def test_config_manager_reset_called_on_success(
        self, app, aidlc_docs, mock_all_deps
    ):
        app.run(aidlc_docs=aidlc_docs)
        mock_all_deps["ConfigManager"].reset.assert_called()

    @patch("design_reviewer.cli.application.ConfigManager")
    def test_config_manager_reset_called_on_error(self, mock_cm_cls, app, aidlc_docs):
        mock_cm_cls.initialize.side_effect = ConfigurationError("bad config")
        app.run(aidlc_docs=aidlc_docs)
        mock_cm_cls.reset.assert_called()


class TestErrorMessageFormatting:
    @patch("design_reviewer.cli.application.ConfigManager")
    def test_error_message_displayed_on_console(self, mock_cm_cls, aidlc_docs):
        mock_cm_cls.initialize.side_effect = ConfigurationError("missing key")
        app = Application(config_path=None)
        app._console = MagicMock()
        app.run(aidlc_docs=aidlc_docs)
        app._console.print.assert_called()
        call_args = app._console.print.call_args_list[0][0][0]
        assert "Configuration Error" in call_args
        assert "missing key" in call_args


class TestQualityThresholds:
    def test_default_thresholds_when_no_config(self, app):
        mock_config = MagicMock()
        mock_config.review = None
        from design_reviewer.reporting.models import QualityThresholds

        thresholds = app._load_quality_thresholds(mock_config)
        assert thresholds == QualityThresholds()

    def test_custom_thresholds_from_config(self, app):
        mock_config = MagicMock()
        mock_config.review.quality_thresholds = {
            "excellent_max_score": 3,
            "good_max_score": 10,
            "needs_improvement_max_score": 20,
        }
        thresholds = app._load_quality_thresholds(mock_config)
        assert thresholds.excellent_max_score == 3
        assert thresholds.good_max_score == 10
        assert thresholds.needs_improvement_max_score == 20

    def test_invalid_thresholds_returns_defaults(self, app):
        mock_config = MagicMock()
        mock_config.review.quality_thresholds = {"excellent_max_score": "invalid"}
        thresholds = app._load_quality_thresholds(mock_config)
        from design_reviewer.reporting.models import QualityThresholds

        assert thresholds == QualityThresholds()
