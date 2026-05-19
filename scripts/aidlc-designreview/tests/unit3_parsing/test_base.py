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


"""Tests for BaseParser utilities — extract_section, validate_content, extract_code_blocks."""

from unittest.mock import MagicMock

import pytest
from pydantic import BaseModel

from design_reviewer.foundation.exceptions import ParsingError
from design_reviewer.parsing.base import BaseParser


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.warning = MagicMock()
    logger.info = MagicMock()
    logger.debug = MagicMock()
    return logger


class ConcreteParser(BaseParser):
    """Minimal concrete subclass for testing BaseParser utilities."""

    def parse(self, content: str) -> BaseModel:
        return BaseModel()


def make_parser() -> ConcreteParser:
    return ConcreteParser(make_mock_logger())


class TestExtractSection:
    def test_extracts_top_level_section(self):
        content = "# Section A\nContent A\n# Section B\nContent B"
        parser = make_parser()
        result = parser.extract_section(content, "# Section A")
        assert result == "Content A"

    def test_extracts_nested_section(self):
        content = "# H1\n## Section\nContent\n## Other\nOther content"
        parser = make_parser()
        result = parser.extract_section(content, "## Section")
        assert result == "Content"

    def test_stops_at_next_same_level_heading(self):
        content = "## A\nContent A\n## B\nContent B"
        parser = make_parser()
        result = parser.extract_section(content, "## A")
        assert result == "Content A"
        assert "Content B" not in result

    def test_includes_lower_level_headings(self):
        content = "## Section\nIntro\n### Sub\nSub content\n## Next"
        parser = make_parser()
        result = parser.extract_section(content, "## Section")
        assert "Intro" in result
        assert "### Sub" in result
        assert "Sub content" in result
        assert "## Next" not in result

    def test_goes_to_eof_when_no_next_same_level(self):
        content = "# Only Section\nAll this content\nshould be included"
        parser = make_parser()
        result = parser.extract_section(content, "# Only Section")
        assert "All this content" in result
        assert "should be included" in result

    def test_returns_none_and_logs_warning_when_not_found(self):
        content = "# Existing\nContent"
        mock_logger = make_mock_logger()
        parser = ConcreteParser(mock_logger)
        result = parser.extract_section(content, "# Missing")
        assert result is None
        mock_logger.warning.assert_called_once()
        assert "Missing" in mock_logger.warning.call_args[0][0]

    def test_case_insensitive_match(self):
        content = "## Components\nComp content"
        parser = make_parser()
        result = parser.extract_section(content, "## components")
        assert result == "Comp content"

    def test_heading_with_hash_prefix_in_search_text(self):
        content = "## Section\nContent"
        parser = make_parser()
        # Both with and without # prefix should work
        assert parser.extract_section(content, "## Section") == "Content"
        assert parser.extract_section(content, "Section") == "Content"

    def test_ignores_headings_inside_code_blocks(self):
        content = (
            "## Real Section\nContent\n```\n# Not a heading\n```\nMore content\n## Next"
        )
        parser = make_parser()
        result = parser.extract_section(content, "## Real Section")
        assert result is not None
        assert "Content" in result
        assert "More content" in result

    def test_returns_none_for_empty_content(self):
        parser = make_parser()
        result = parser.extract_section("", "## Heading")
        assert result is None

    def test_stops_at_higher_level_heading(self):
        content = "## Sub\nContent\n# Top\nTop content"
        parser = make_parser()
        result = parser.extract_section(content, "## Sub")
        assert result == "Content"
        assert "Top content" not in result


class TestValidateContent:
    def test_passes_for_non_empty_string(self):
        parser = make_parser()
        parser.validate_content("Some content", "test artifact")  # Should not raise

    def test_raises_for_empty_string(self):
        parser = make_parser()
        with pytest.raises(ParsingError) as exc_info:
            parser.validate_content("", "test artifact")
        assert "test artifact" in str(exc_info.value)

    def test_raises_for_whitespace_only(self):
        parser = make_parser()
        with pytest.raises(ParsingError):
            parser.validate_content("   \n\t  ", "test artifact")

    def test_raises_for_none(self):
        parser = make_parser()
        with pytest.raises(ParsingError):
            parser.validate_content(None, "test artifact")

    def test_error_includes_artifact_description(self):
        parser = make_parser()
        with pytest.raises(ParsingError) as exc_info:
            parser.validate_content("", "APPLICATION_DESIGN artifacts")
        assert "APPLICATION_DESIGN" in str(exc_info.value)


class TestExtractCodeBlocks:
    def test_extracts_single_code_block(self):
        content = "Text\n```python\ndef foo(): pass\n```\nMore text"
        parser = make_parser()
        blocks = parser.extract_code_blocks(content)
        assert len(blocks) == 1
        assert "def foo(): pass" in blocks[0]

    def test_extracts_multiple_code_blocks(self):
        content = "```\nblock1\n```\nMiddle\n```\nblock2\n```"
        parser = make_parser()
        blocks = parser.extract_code_blocks(content)
        assert len(blocks) == 2

    def test_returns_empty_list_for_no_blocks(self):
        content = "# Just text\nNo code here"
        parser = make_parser()
        blocks = parser.extract_code_blocks(content)
        assert blocks == []
