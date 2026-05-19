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
Tests for Unit 5 CLI entry point.

Tests Click CliRunner: --aidlc-docs required, --output optional,
--help, --version, exit codes, invalid args.
"""

from pathlib import Path

import pytest
from click.testing import CliRunner

from design_reviewer.cli.cli import main


@pytest.fixture
def runner():
    return CliRunner()


@pytest.fixture
def valid_docs_dir(tmp_path):
    """Create a temporary directory that exists for --aidlc-docs."""
    docs = tmp_path / "aidlc-docs"
    docs.mkdir()
    return docs


class TestHelpAndVersion:
    def test_help_flag(self, runner):
        result = runner.invoke(main, ["--help"])
        assert result.exit_code == 0
        assert "aidlc-docs" in result.output
        assert "output" in result.output

    def test_version_flag(self, runner):
        result = runner.invoke(main, ["--version"])
        assert result.exit_code == 0
        assert "0.1.0" in result.output
        assert "design-reviewer" in result.output


class TestRequiredArguments:
    def test_missing_aidlc_docs_fails(self, runner):
        result = runner.invoke(main, [])
        assert result.exit_code != 0
        assert (
            "aidlc-docs" in result.output.lower() or "missing" in result.output.lower()
        )

    def test_nonexistent_aidlc_docs_fails(self, runner):
        result = runner.invoke(main, ["--aidlc-docs", "/nonexistent/path/xyz123"])
        assert result.exit_code != 0


class TestValidInvocation:
    def test_with_valid_docs_dir(self, runner, valid_docs_dir, mock_application):
        mock_cls, mock_app = mock_application
        result = runner.invoke(main, ["--aidlc-docs", str(valid_docs_dir)])
        assert result.exit_code == 0
        mock_app.run.assert_called_once()
        call_kwargs = mock_app.run.call_args
        assert call_kwargs.kwargs["aidlc_docs"] == Path(str(valid_docs_dir))

    def test_with_output_option(self, runner, valid_docs_dir, mock_application):
        mock_cls, mock_app = mock_application
        result = runner.invoke(
            main,
            ["--aidlc-docs", str(valid_docs_dir), "--output", "custom/report"],
        )
        assert result.exit_code == 0
        call_kwargs = mock_app.run.call_args
        assert call_kwargs.kwargs["output"] == "custom/report"

    def test_with_config_option(self, runner, valid_docs_dir, mock_application):
        mock_cls, mock_app = mock_application
        result = runner.invoke(
            main,
            ["--aidlc-docs", str(valid_docs_dir), "--config", "my-config.yaml"],
        )
        assert result.exit_code == 0
        mock_cls.assert_called_once_with(config_path="my-config.yaml")

    def test_output_defaults_to_none(self, runner, valid_docs_dir, mock_application):
        mock_cls, mock_app = mock_application
        runner.invoke(main, ["--aidlc-docs", str(valid_docs_dir)])
        call_kwargs = mock_app.run.call_args
        assert call_kwargs.kwargs["output"] is None


class TestExitCodes:
    def test_nonzero_exit_from_application(
        self, runner, valid_docs_dir, mock_application
    ):
        mock_cls, mock_app = mock_application
        mock_app.run.return_value = 2
        result = runner.invoke(main, ["--aidlc-docs", str(valid_docs_dir)])
        assert result.exit_code == 2
