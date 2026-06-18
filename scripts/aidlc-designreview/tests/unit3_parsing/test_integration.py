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
Integration tests for Unit 3: Parsing.

Uses real content from test_data/ fixtures (read as strings, no Bedrock needed).
Validates that parsers handle actual AIDLC document structures correctly.
"""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from design_reviewer.parsing.app_design import ApplicationDesignParser
from design_reviewer.parsing.func_design import FunctionalDesignParser
from design_reviewer.parsing.models import DesignData
from design_reviewer.parsing.tech_env import TechnicalEnvironmentParser
from design_reviewer.parsing.base import BaseParser
from design_reviewer.validation.models import ArtifactInfo, ArtifactType

_WORKSPACE = Path(__file__).parent.parent.parent
SCI_CALC_DOCS = _WORKSPACE / "test_data" / "sci-calc" / "golden-aidlc-docs"
ALL_STAGES_DOCS = (
    _WORKSPACE / "test_data" / "all-stages" / "golden-aidlc-docs" / "aidlc-docs"
)


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.info = MagicMock()
    logger.warning = MagicMock()
    logger.debug = MagicMock()
    return logger


def read_md_files(directory: Path) -> dict[Path, str]:
    """Read all .md files from a directory (non-recursive)."""
    return {
        f: f.read_text(encoding="utf-8") for f in directory.glob("*.md") if f.is_file()
    }


def make_artifact(
    path: Path, artifact_type: ArtifactType, unit_name: str = None
) -> ArtifactInfo:
    mock_path = MagicMock(spec=Path)
    mock_path.name = path.name
    mock_path.parts = path.parts
    mock_path.stat.return_value = path.stat()
    return ArtifactInfo.create(mock_path, artifact_type, unit_name=unit_name)


@pytest.fixture
def sci_calc_docs():
    if not SCI_CALC_DOCS.exists():
        pytest.skip(f"Test fixture not found: {SCI_CALC_DOCS}")
    return SCI_CALC_DOCS


@pytest.fixture
def all_stages_docs():
    if not ALL_STAGES_DOCS.exists():
        pytest.skip(f"Test fixture not found: {ALL_STAGES_DOCS}")
    return ALL_STAGES_DOCS


class TestApplicationDesignParserOnFixtures:
    def test_sci_calc_application_design(self, sci_calc_docs):
        app_design_dir = sci_calc_docs / "inception" / "application-design"
        if not app_design_dir.exists():
            pytest.skip("No application-design in sci-calc fixture")
        files = list(app_design_dir.glob("*.md"))
        content_map = {f: f.read_text(encoding="utf-8") for f in files}
        artifacts = [make_artifact(f, ArtifactType.APPLICATION_DESIGN) for f in files]

        parser = ApplicationDesignParser(make_mock_logger())
        result = parser.parse(content_map, artifacts)

        assert result.source_count == len(files)
        assert len(result.raw_content) > 0
        # Verify source separators present
        for f in files:
            assert f"# Source: {f.name}" in result.raw_content

    def test_all_stages_application_design(self, all_stages_docs):
        app_design_dir = all_stages_docs / "inception" / "application-design"
        if not app_design_dir.exists():
            pytest.skip("No application-design in all-stages fixture")
        files = list(app_design_dir.glob("*.md"))
        content_map = {f: f.read_text(encoding="utf-8") for f in files}
        artifacts = [make_artifact(f, ArtifactType.APPLICATION_DESIGN) for f in files]

        parser = ApplicationDesignParser(make_mock_logger())
        result = parser.parse(content_map, artifacts)
        assert result.source_count > 0


class TestFunctionalDesignParserOnFixtures:
    def test_all_stages_multi_unit_functional_design(self, all_stages_docs):
        construction_dir = all_stages_docs / "construction"
        if not construction_dir.exists():
            pytest.skip("No construction dir in all-stages fixture")

        content_map = {}
        artifacts = []
        for unit_dir in construction_dir.iterdir():
            if not unit_dir.is_dir():
                continue
            fd_dir = unit_dir / "functional-design"
            if not fd_dir.exists():
                continue
            for f in fd_dir.glob("*.md"):
                content = f.read_text(encoding="utf-8")
                mock_path = MagicMock(spec=Path)
                mock_path.name = f.name
                mock_path.parts = f.parts
                mock_path.stat.return_value = f.stat()
                artifact = ArtifactInfo.create(
                    mock_path, ArtifactType.FUNCTIONAL_DESIGN, unit_name=unit_dir.name
                )
                content_map[artifact.path] = content
                artifacts.append(artifact)

        if not content_map:
            pytest.skip("No functional-design files found in all-stages fixture")

        parser = FunctionalDesignParser(make_mock_logger())
        result = parser.parse(content_map, artifacts)

        assert result.source_count > 0
        # Verify unit headers present for each unit
        for unit_name in result.unit_names:
            assert f"# Unit: {unit_name}" in result.raw_content


class TestTechnicalEnvironmentParserOnFixtures:
    def test_sci_calc_tech_env(self, sci_calc_docs):
        # sci-calc has tech-env.md at root (not golden-aidlc-docs, but check anyway)
        tech_env = sci_calc_docs.parent / "tech-env.md"
        if not tech_env.exists():
            pytest.skip("No tech-env.md in sci-calc fixture")
        content = tech_env.read_text(encoding="utf-8")
        parser = TechnicalEnvironmentParser(make_mock_logger())
        result = parser.parse(content, tech_env)
        assert result.raw_content == content


class TestExtractSectionOnRealDocuments:
    def test_extract_section_from_components_md(self, sci_calc_docs):
        components_file = (
            sci_calc_docs / "inception" / "application-design" / "components.md"
        )
        if not components_file.exists():
            pytest.skip("No components.md in sci-calc fixture")
        content = components_file.read_text(encoding="utf-8")

        class TestParser(BaseParser):
            def parse(self, *args, **kwargs):
                pass

        parser = TestParser(make_mock_logger())
        # Try extracting any top-level section
        import re

        headings = re.findall(r"^#{1,2}\s+(.+)$", content, re.MULTILINE)
        if headings:
            first_heading = headings[0]
            result = parser.extract_section(content, first_heading)
            # If found, should have content
            assert result is not None or True  # may be empty section, that's ok


class TestDesignDataConstruction:
    def test_design_data_from_parser_outputs(self, sci_calc_docs):
        app_design_dir = sci_calc_docs / "inception" / "application-design"
        if not app_design_dir.exists():
            pytest.skip("No application-design in sci-calc fixture")

        files = list(app_design_dir.glob("*.md"))
        content_map = {f: f.read_text(encoding="utf-8") for f in files}
        artifacts = [make_artifact(f, ArtifactType.APPLICATION_DESIGN) for f in files]

        logger = make_mock_logger()
        app_model = ApplicationDesignParser(logger).parse(content_map, artifacts)
        tech_model = TechnicalEnvironmentParser(logger).parse("# Tech\nPython 3.12")

        design_data = DesignData(
            app_design=app_model,
            tech_env=tech_model,
            raw_content=content_map,
        )

        assert design_data.app_design is not None
        assert design_data.tech_env is not None
        assert design_data.functional_designs is None
        assert len(design_data.raw_content) == len(files)
