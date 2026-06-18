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


"""Tests for TechnicalEnvironmentParser."""

from pathlib import Path
from unittest.mock import MagicMock


from design_reviewer.parsing.models import TechnicalEnvironmentModel
from design_reviewer.parsing.tech_env import TechnicalEnvironmentParser


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.info = MagicMock()
    logger.warning = MagicMock()
    return logger


def make_parser() -> TechnicalEnvironmentParser:
    return TechnicalEnvironmentParser(make_mock_logger())


class TestTechnicalEnvironmentParser:
    def test_returns_content_unchanged(self):
        content = "# Technical Environment\n## Tech Stack\nPython 3.12"
        parser = make_parser()
        result = parser.parse(content, Path("/docs/technical-environment.md"))
        assert result.raw_content == content

    def test_empty_string_returns_empty_model_without_raising(self):
        parser = make_parser()
        result = parser.parse("")
        assert isinstance(result, TechnicalEnvironmentModel)
        assert result.raw_content == ""

    def test_none_content_returns_empty_model_without_raising(self):
        parser = make_parser()
        result = parser.parse(None)
        assert isinstance(result, TechnicalEnvironmentModel)
        assert result.raw_content == ""

    def test_empty_content_logs_warning(self):
        mock_logger = make_mock_logger()
        parser = TechnicalEnvironmentParser(mock_logger)
        parser.parse("")
        mock_logger.warning.assert_called_once()
        assert "technical-environment" in mock_logger.warning.call_args[0][0].lower()

    def test_none_content_logs_warning(self):
        mock_logger = make_mock_logger()
        parser = TechnicalEnvironmentParser(mock_logger)
        parser.parse(None)
        mock_logger.warning.assert_called_once()

    def test_file_path_stored_in_model(self):
        path = Path("/docs/technical-environment.md")
        parser = make_parser()
        result = parser.parse("# Tech\nContent", path)
        assert result.file_path == path

    def test_file_path_defaults_to_none(self):
        parser = make_parser()
        result = parser.parse("Content")
        assert result.file_path is None

    def test_elapsed_time_logged(self):
        mock_logger = make_mock_logger()
        parser = TechnicalEnvironmentParser(mock_logger)
        parser.parse("# Tech\nContent")
        info_calls = [str(c) for c in mock_logger.info.call_args_list]
        assert any("TECHNICAL_ENVIRONMENT" in c for c in info_calls)

    def test_whitespace_only_returns_empty_model(self):
        parser = make_parser()
        result = parser.parse("   \n\t  ")
        assert result.raw_content == ""
