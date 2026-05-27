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
Functional tests: CLI → Application → error handling paths.

Uses Click's CliRunner with the real CLI entry point and patches
Application.run() to simulate various exit codes and error scenarios.
Tests the full Click parsing → Application → exit code pipeline.
"""

from pathlib import Path
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from design_reviewer.cli.cli import main


@pytest.fixture
def runner():
    return CliRunner()


@pytest.fixture
def valid_docs_dir(tmp_path):
    """Create a minimal directory that passes Click's exists=True check."""
    docs = tmp_path / "aidlc-docs"
    docs.mkdir()
    return docs


class TestCLIHelpAndVersion:
    """CLI --help and --version work without any Application instantiation."""

    def test_help_output(self, runner):
        result = runner.invoke(main, ["--help"])
        assert result.exit_code == 0
        assert "aidlc-docs" in result.output
        assert "AI-powered design review" in result.output

    def test_version_output(self, runner):
        result = runner.invoke(main, ["--version"])
        assert result.exit_code == 0
        assert "0.1.0" in result.output


class TestCLIArgumentValidation:
    """Click validates arguments before reaching Application."""

    def test_missing_required_aidlc_docs(self, runner):
        result = runner.invoke(main, [])
        assert result.exit_code != 0
        assert (
            "aidlc-docs" in result.output.lower() or "missing" in result.output.lower()
        )

    def test_nonexistent_aidlc_docs_path(self, runner, tmp_path):
        bad_path = str(tmp_path / "does-not-exist")
        result = runner.invoke(main, ["--aidlc-docs", bad_path])
        assert result.exit_code != 0


class TestCLIToApplicationWiring:
    """CLI properly creates Application and passes arguments."""

    @patch("design_reviewer.cli.application.Application")
    def test_successful_review_exits_zero(self, mock_app_cls, runner, valid_docs_dir):
        mock_app_cls.return_value.run.return_value = 0
        result = runner.invoke(main, ["--aidlc-docs", str(valid_docs_dir)])
        assert result.exit_code == 0
        mock_app_cls.return_value.run.assert_called_once()

    @patch("design_reviewer.cli.application.Application")
    def test_config_error_exits_one(self, mock_app_cls, runner, valid_docs_dir):
        mock_app_cls.return_value.run.return_value = 1
        result = runner.invoke(main, ["--aidlc-docs", str(valid_docs_dir)])
        assert result.exit_code == 1

    @patch("design_reviewer.cli.application.Application")
    def test_validation_error_exits_two(self, mock_app_cls, runner, valid_docs_dir):
        mock_app_cls.return_value.run.return_value = 2
        result = runner.invoke(main, ["--aidlc-docs", str(valid_docs_dir)])
        assert result.exit_code == 2

    @patch("design_reviewer.cli.application.Application")
    def test_parsing_error_exits_three(self, mock_app_cls, runner, valid_docs_dir):
        mock_app_cls.return_value.run.return_value = 3
        result = runner.invoke(main, ["--aidlc-docs", str(valid_docs_dir)])
        assert result.exit_code == 3

    @patch("design_reviewer.cli.application.Application")
    def test_ai_review_error_exits_four(self, mock_app_cls, runner, valid_docs_dir):
        mock_app_cls.return_value.run.return_value = 4
        result = runner.invoke(main, ["--aidlc-docs", str(valid_docs_dir)])
        assert result.exit_code == 4

    @patch("design_reviewer.cli.application.Application")
    def test_config_option_passed_to_application(
        self, mock_app_cls, runner, valid_docs_dir, tmp_path
    ):
        mock_app_cls.return_value.run.return_value = 0
        config_path = str(tmp_path / "custom-config.yaml")
        result = runner.invoke(
            main,
            ["--aidlc-docs", str(valid_docs_dir), "--config", config_path],
        )
        assert result.exit_code == 0
        mock_app_cls.assert_called_once_with(config_path=config_path)

    @patch("design_reviewer.cli.application.Application")
    def test_output_option_passed_to_run(
        self, mock_app_cls, runner, valid_docs_dir, tmp_path
    ):
        mock_app_cls.return_value.run.return_value = 0
        output_path = str(tmp_path / "my-review")
        result = runner.invoke(
            main,
            ["--aidlc-docs", str(valid_docs_dir), "--output", output_path],
        )
        assert result.exit_code == 0
        call_kwargs = mock_app_cls.return_value.run.call_args
        assert (
            str(call_kwargs.kwargs.get("output") or call_kwargs[1].get("output"))
            == output_path
        )


class TestApplicationErrorHandling:
    """Application.run() handles exceptions and returns correct exit codes."""

    @patch("design_reviewer.cli.application.ConfigManager")
    def test_config_error_returns_one(self, mock_cm):
        from design_reviewer.cli.application import Application
        from design_reviewer.foundation.exceptions import ConfigurationError

        mock_cm.initialize.side_effect = ConfigurationError("bad config")
        app = Application()
        code = app.run(aidlc_docs=Path("/test/docs"))
        assert code == 1

    @patch("design_reviewer.cli.application.ConfigManager")
    @patch("design_reviewer.foundation.logger.Logger")
    @patch("design_reviewer.ai_review.bedrock_client.create_bedrock_client")
    @patch("design_reviewer.validation.scanner.ArtifactScanner")
    @patch("design_reviewer.validation.classifier.ArtifactClassifier")
    @patch("design_reviewer.validation.discoverer.ArtifactDiscoverer")
    @patch("design_reviewer.validation.validator.StructureValidator")
    @patch("design_reviewer.validation.loader.ArtifactLoader")
    @patch("design_reviewer.parsing.app_design.ApplicationDesignParser")
    @patch("design_reviewer.parsing.func_design.FunctionalDesignParser")
    @patch("design_reviewer.parsing.tech_env.TechnicalEnvironmentParser")
    @patch("design_reviewer.foundation.pattern_library.PatternLibrary")
    @patch("design_reviewer.foundation.prompt_manager.PromptManager")
    @patch("design_reviewer.ai_review.AgentOrchestrator")
    @patch("design_reviewer.ai_review.CritiqueAgent")
    @patch("design_reviewer.ai_review.AlternativesAgent")
    @patch("design_reviewer.ai_review.GapAnalysisAgent")
    @patch("design_reviewer.reporting.report_builder.ReportBuilder")
    @patch("design_reviewer.reporting.markdown_formatter.MarkdownFormatter")
    @patch("design_reviewer.reporting.html_formatter.HTMLFormatter")
    @patch("design_reviewer.orchestration.ReviewOrchestrator")
    def test_validation_error_returns_two(self, mock_orch, *mocks):
        from design_reviewer.cli.application import Application
        from design_reviewer.foundation.exceptions import StructureValidationError

        # The last positional mock (first @patch) is ConfigManager
        mock_cm = mocks[-1]
        mock_cm.initialize.return_value.get_model_config.return_value = (
            "claude-sonnet-4-6"
        )

        mock_orch.return_value.execute_review.side_effect = StructureValidationError(
            "invalid structure"
        )
        app = Application()
        code = app.run(aidlc_docs=Path("/test/docs"))
        assert code == 2

    @patch("design_reviewer.cli.application.ConfigManager")
    def test_config_manager_reset_called_on_success(self, mock_cm):
        """ConfigManager.reset() is always called in the finally block."""
        from design_reviewer.cli.application import Application
        from design_reviewer.foundation.exceptions import ConfigurationError

        mock_cm.initialize.side_effect = ConfigurationError("fail")
        app = Application()
        app.run(aidlc_docs=Path("/test/docs"))
        mock_cm.reset.assert_called_once()

    @patch("design_reviewer.cli.application.ConfigManager")
    def test_unexpected_error_returns_one(self, mock_cm):
        from design_reviewer.cli.application import Application

        mock_cm.initialize.side_effect = RuntimeError("unexpected")
        app = Application()
        code = app.run(aidlc_docs=Path("/test/docs"))
        assert code == 1
