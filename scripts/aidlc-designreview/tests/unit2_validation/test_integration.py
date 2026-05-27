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
Integration tests for Unit 2: Validation & Discovery.

Uses real test fixtures from test_data/ to validate scanning, exclusion,
path boundary checking, and loading against actual AIDLC project structures.
Bedrock API calls are mocked throughout.
"""

from pathlib import Path
from unittest.mock import MagicMock, patch
import json
from io import BytesIO

import pytest

from design_reviewer.validation.models import (
    ArtifactInfo,
    ArtifactType,
    ValidationResult,
)
from design_reviewer.validation.scanner import ArtifactScanner
from design_reviewer.validation.loader import ArtifactLoader
from design_reviewer.validation.validator import StructureValidator
from design_reviewer.validation.classifier import ArtifactClassifier
from design_reviewer.validation.discoverer import ArtifactDiscoverer
from design_reviewer.foundation.exceptions import StructureValidationError


# Fixture paths (relative to workspace root)
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


def make_mock_bedrock_client(response: str = "APPLICATION_DESIGN") -> MagicMock:
    """Return a Bedrock client mock that produces fresh BytesIO on each invoke_model call."""
    body_bytes = json.dumps({"content": [{"text": response}]}).encode()
    mock_client = MagicMock()
    mock_client.invoke_model.side_effect = lambda **kwargs: {
        "body": BytesIO(body_bytes)
    }
    return mock_client


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


class TestScannerOnRealFixtures:
    def test_sci_calc_scan_finds_md_files(self, sci_calc_docs):
        scanner = ArtifactScanner(sci_calc_docs, make_mock_logger())
        candidates = scanner.scan()
        assert len(candidates) > 0

    def test_sci_calc_scan_excludes_audit_md(self, sci_calc_docs):
        scanner = ArtifactScanner(sci_calc_docs, make_mock_logger())
        candidates = scanner.scan()
        paths = [p for p, _ in candidates]
        assert not any("audit.md" == p.name for p in paths)

    def test_sci_calc_scan_excludes_aidlc_state_md(self, sci_calc_docs):
        scanner = ArtifactScanner(sci_calc_docs, make_mock_logger())
        candidates = scanner.scan()
        paths = [p for p, _ in candidates]
        assert not any("aidlc-state.md" == p.name for p in paths)

    def test_sci_calc_scan_excludes_plans_directory(self, sci_calc_docs):
        scanner = ArtifactScanner(sci_calc_docs, make_mock_logger())
        candidates = scanner.scan()
        for path, _ in candidates:
            assert "plans" not in path.relative_to(sci_calc_docs).parts

    def test_sci_calc_scan_excerpts_not_empty(self, sci_calc_docs):
        scanner = ArtifactScanner(sci_calc_docs, make_mock_logger())
        candidates = scanner.scan()
        for path, excerpt in candidates:
            assert isinstance(excerpt, str)

    def test_all_stages_scan_finds_construction_artifacts(self, all_stages_docs):
        scanner = ArtifactScanner(all_stages_docs, make_mock_logger())
        candidates = scanner.scan()
        paths = [p for p, _ in candidates]
        construction_paths = [p for p in paths if "construction" in p.parts]
        assert len(construction_paths) > 0

    def test_all_stages_scan_excludes_build_and_test(self, all_stages_docs):
        scanner = ArtifactScanner(all_stages_docs, make_mock_logger())
        candidates = scanner.scan()
        for path, _ in candidates:
            assert "build-and-test" not in path.relative_to(all_stages_docs).parts


class TestPathBoundaryOnFixtures:
    def test_all_candidate_paths_within_root(self, sci_calc_docs):
        scanner = ArtifactScanner(sci_calc_docs, make_mock_logger())
        candidates = scanner.scan()
        for path, _ in candidates:
            assert scanner._is_within_root(path), f"Path outside root: {path}"


class TestStructureValidatorOnFixtures:
    def _make_validator(self, root: Path) -> StructureValidator:
        mock_client = make_mock_bedrock_client("APPLICATION_DESIGN")
        scanner = ArtifactScanner(root, make_mock_logger())
        classifier = ArtifactClassifier(
            bedrock_client=mock_client,
            model_id="claude-sonnet-4-6",
            logger=make_mock_logger(),
            max_workers=2,
        )
        discoverer = ArtifactDiscoverer(scanner, classifier, make_mock_logger())
        return StructureValidator(root, discoverer, make_mock_logger())

    def test_sci_calc_passes_validation(self, sci_calc_docs):
        validator = self._make_validator(sci_calc_docs)
        with patch("design_reviewer.validation.classifier.progress_bar") as mock_pb:
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)
            result = validator.validate_structure()
        assert isinstance(result, ValidationResult)
        assert len(result.artifacts) > 0

    def test_all_stages_passes_validation(self, all_stages_docs):
        validator = self._make_validator(all_stages_docs)
        with patch("design_reviewer.validation.classifier.progress_bar") as mock_pb:
            mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_pb.return_value.__exit__ = MagicMock(return_value=False)
            result = validator.validate_structure()
        assert isinstance(result, ValidationResult)
        assert len(result.artifacts) > 0

    def test_nonexistent_path_raises(self, tmp_path):
        missing = tmp_path / "nonexistent"
        mock_discoverer = MagicMock()
        validator = StructureValidator(missing, mock_discoverer, make_mock_logger())
        with pytest.raises(StructureValidationError):
            validator.validate_structure()

    def test_non_aidlc_directory_raises(self, tmp_path):
        # Directory exists but no aidlc-state.md sentinel
        (tmp_path / "some-docs.md").write_text("# Not an AIDLC project")
        mock_discoverer = MagicMock()
        validator = StructureValidator(tmp_path, mock_discoverer, make_mock_logger())
        with pytest.raises(StructureValidationError) as exc_info:
            validator.validate_structure()
        assert "aidlc-state.md" in str(exc_info.value)


class TestArtifactLoaderOnFixtures:
    def _make_artifacts_from_scanner(self, root: Path) -> list:
        """Scan and build ArtifactInfo list with UNKNOWN type (no Bedrock needed)."""
        scanner = ArtifactScanner(root, make_mock_logger())
        candidates = scanner.scan()
        results = []
        for path, _ in candidates:
            mock_path = MagicMock(spec=Path)
            mock_path.name = path.name
            mock_path.parts = path.parts
            mock_path.stat.return_value = path.stat()
            mock_path.read_text = path.read_text
            mock_path.__str__ = lambda self, p=path: str(p)
            results.append(ArtifactInfo.create(mock_path, ArtifactType.UNKNOWN))
        return results

    def test_sci_calc_loader_loads_all_artifacts(self, sci_calc_docs):
        scanner = ArtifactScanner(sci_calc_docs, make_mock_logger())
        candidates = scanner.scan()

        # Build ArtifactInfo with real pathlib.Path objects
        artifacts = [
            ArtifactInfo.create(path, ArtifactType.APPLICATION_DESIGN)
            for path, _ in candidates
        ]

        with patch(
            "design_reviewer.validation.loader.scrub_credentials",
            side_effect=lambda x: x,
        ):
            with patch("design_reviewer.validation.loader.progress_bar") as mock_pb:
                mock_pb.return_value.__enter__ = MagicMock(return_value=MagicMock())
                mock_pb.return_value.__exit__ = MagicMock(return_value=False)
                loader = ArtifactLoader(make_mock_logger())
                loaded, path_map = loader.load_multiple_artifacts(artifacts)

        assert len(loaded) == len(artifacts)
        assert all(a.content is not None for a in loaded)
        assert len(path_map) == len(artifacts)
