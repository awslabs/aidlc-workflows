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


"""Tests for FunctionalDesignParser."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from design_reviewer.foundation.exceptions import ParsingError
from design_reviewer.parsing.func_design import FunctionalDesignParser
from design_reviewer.parsing.models import FunctionalDesignModel
from design_reviewer.validation.models import ArtifactInfo, ArtifactType


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.info = MagicMock()
    logger.warning = MagicMock()
    return logger


def make_artifact(filename: str, unit_name: str) -> ArtifactInfo:
    mock_path = MagicMock(spec=Path)
    mock_path.name = filename
    mock_path.parts = (
        "/docs",
        "construction",
        unit_name,
        "functional-design",
        filename,
    )
    mock_path.stat.return_value = MagicMock(st_size=100)
    return ArtifactInfo.create(
        mock_path, ArtifactType.FUNCTIONAL_DESIGN, unit_name=unit_name
    )


def make_parser() -> FunctionalDesignParser:
    return FunctionalDesignParser(make_mock_logger())


class TestFunctionalDesignParserParse:
    def test_single_unit_produces_unit_header(self):
        artifact = make_artifact("business-logic-model.md", "unit1-foundation")
        path = artifact.path
        content_map = {path: "# Business Logic\nContent"}
        parser = make_parser()
        result = parser.parse(content_map, [artifact])
        assert "# Unit: unit1-foundation" in result.raw_content
        assert "# Business Logic" in result.raw_content

    def test_multiple_units_sorted_alphabetically(self):
        a1 = make_artifact("b-file.md", "unit2-validation")
        a2 = make_artifact("a-file.md", "unit1-foundation")
        content_map = {
            a1.path: "# U2 Content\n...",
            a2.path: "# U1 Content\n...",
        }
        parser = make_parser()
        result = parser.parse(content_map, [a1, a2])
        assert result.raw_content.index("unit1-foundation") < result.raw_content.index(
            "unit2-validation"
        )

    def test_unit_header_format(self):
        artifact = make_artifact("business-rules.md", "unit1-foundation-config")
        path = artifact.path
        content_map = {path: "# Rules\nContent"}
        parser = make_parser()
        result = parser.parse(content_map, [artifact])
        assert "# Unit: unit1-foundation-config" in result.raw_content

    def test_zero_files_returns_empty_model(self):
        parser = make_parser()
        result = parser.parse({}, [])
        assert isinstance(result, FunctionalDesignModel)
        assert result.raw_content == ""
        assert result.unit_names == []

    def test_zero_files_logs_warning(self):
        mock_logger = make_mock_logger()
        parser = FunctionalDesignParser(mock_logger)
        parser.parse({}, [])
        mock_logger.warning.assert_called()

    def test_all_empty_files_raises_parsing_error(self):
        artifact = make_artifact("business-logic-model.md", "unit1")
        path = artifact.path
        content_map = {path: "   "}
        parser = make_parser()
        with pytest.raises(ParsingError):
            parser.parse(content_map, [artifact])

    def test_unit_names_list_sorted(self):
        a1 = make_artifact("f1.md", "unit3-parsing")
        a2 = make_artifact("f2.md", "unit1-foundation")
        content_map = {a1.path: "# C1\n...", a2.path: "# C2\n..."}
        parser = make_parser()
        result = parser.parse(content_map, [a1, a2])
        assert result.unit_names == ["unit1-foundation", "unit3-parsing"]

    def test_source_count_correct(self):
        artifacts = [make_artifact(f"file{i}.md", f"unit{i}") for i in range(3)]
        content_map = {a.path: f"# Content {i}\n..." for i, a in enumerate(artifacts)}
        parser = make_parser()
        result = parser.parse(content_map, artifacts)
        assert result.source_count == 3

    def test_elapsed_time_logged(self):
        artifact = make_artifact("business-logic.md", "unit1")
        content_map = {artifact.path: "# Content\n..."}
        mock_logger = make_mock_logger()
        parser = FunctionalDesignParser(mock_logger)
        parser.parse(content_map, [artifact])
        info_calls = [str(c) for c in mock_logger.info.call_args_list]
        assert any("FUNCTIONAL_DESIGN" in c and "files" in c for c in info_calls)

    def test_file_header_included_for_each_file(self):
        artifact = make_artifact("domain-entities.md", "unit1")
        content_map = {artifact.path: "# Entities\nContent"}
        parser = make_parser()
        result = parser.parse(content_map, [artifact])
        assert "## Source: domain-entities.md" in result.raw_content
