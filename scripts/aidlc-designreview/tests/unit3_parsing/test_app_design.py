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


"""Tests for ApplicationDesignParser."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from design_reviewer.foundation.exceptions import ParsingError
from design_reviewer.parsing.app_design import ApplicationDesignParser
from design_reviewer.parsing.models import ApplicationDesignModel
from design_reviewer.validation.models import ArtifactInfo, ArtifactType


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.info = MagicMock()
    logger.warning = MagicMock()
    return logger


def make_artifact(name: str) -> ArtifactInfo:
    mock_path = MagicMock(spec=Path)
    mock_path.name = name
    mock_path.parts = ("/docs", "inception", "application-design", name)
    mock_path.stat.return_value = MagicMock(st_size=100)
    return ArtifactInfo.create(mock_path, ArtifactType.APPLICATION_DESIGN)


def make_parser() -> ApplicationDesignParser:
    return ApplicationDesignParser(make_mock_logger())


class TestApplicationDesignParserParse:
    def test_single_file_returns_content(self):
        path = Path("/docs/inception/application-design/components.md")
        content_map = {path: "# Components\nComp A\nComp B"}
        artifacts = [make_artifact("components.md")]
        parser = make_parser()
        result = parser.parse(content_map, artifacts)
        assert isinstance(result, ApplicationDesignModel)
        assert "# Components" in result.raw_content
        assert result.source_count == 1

    def test_multiple_files_concatenated_alphabetically(self):
        p_z = Path("/docs/inception/application-design/z-last.md")
        p_a = Path("/docs/inception/application-design/a-first.md")
        content_map = {p_z: "# Last\nContent Z", p_a: "# First\nContent A"}
        artifacts = [make_artifact("z-last.md"), make_artifact("a-first.md")]
        parser = make_parser()
        result = parser.parse(content_map, artifacts)
        # a-first.md should appear before z-last.md
        assert result.raw_content.index("a-first.md") < result.raw_content.index(
            "z-last.md"
        )
        assert result.source_count == 2

    def test_includes_source_separators(self):
        path = Path("/docs/inception/application-design/components.md")
        content_map = {path: "# Components\n..."}
        artifacts = [make_artifact("components.md")]
        parser = make_parser()
        result = parser.parse(content_map, artifacts)
        assert "# Source: components.md" in result.raw_content

    def test_zero_files_returns_empty_model(self):
        parser = make_parser()
        result = parser.parse({}, [])
        assert isinstance(result, ApplicationDesignModel)
        assert result.raw_content == ""
        assert result.source_count == 0

    def test_zero_files_logs_warning(self):
        mock_logger = make_mock_logger()
        parser = ApplicationDesignParser(mock_logger)
        parser.parse({}, [])
        mock_logger.warning.assert_called()

    def test_all_empty_files_raises_parsing_error(self):
        path = Path("/docs/inception/application-design/components.md")
        content_map = {path: "   "}
        artifacts = [make_artifact("components.md")]
        parser = make_parser()
        with pytest.raises(ParsingError) as exc_info:
            parser.parse(content_map, artifacts)
        assert "empty" in str(exc_info.value).lower()

    def test_missing_components_section_logs_warning(self):
        path = Path("/docs/inception/application-design/other.md")
        content_map = {path: "# Other Section\nNo components here"}
        artifacts = [make_artifact("other.md")]
        mock_logger = make_mock_logger()
        parser = ApplicationDesignParser(mock_logger)
        parser.parse(content_map, artifacts)
        # Should have warned about missing key sections
        warning_calls = [str(c) for c in mock_logger.warning.call_args_list]
        assert any("Component" in w or "Service" in w for w in warning_calls)

    def test_elapsed_time_logged(self):
        path = Path("/docs/inception/application-design/components.md")
        content_map = {path: "# Components\nContent"}
        artifacts = [make_artifact("components.md")]
        mock_logger = make_mock_logger()
        parser = ApplicationDesignParser(mock_logger)
        parser.parse(content_map, artifacts)
        info_calls = [str(c) for c in mock_logger.info.call_args_list]
        assert any("APPLICATION_DESIGN" in c and "files" in c for c in info_calls)

    def test_source_count_matches_files(self):
        paths = {
            Path(f"/docs/file{i}.md"): f"# Section {i}\nContent {i}" for i in range(3)
        }
        artifacts = [make_artifact(f"file{i}.md") for i in range(3)]
        parser = make_parser()
        result = parser.parse(paths, artifacts)
        assert result.source_count == 3
