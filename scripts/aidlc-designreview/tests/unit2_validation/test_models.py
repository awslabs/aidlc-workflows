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


"""Tests for validation domain models: ArtifactType, ArtifactInfo, ValidationResult."""

from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from design_reviewer.validation.models import (
    ArtifactInfo,
    ArtifactType,
    ValidationResult,
)


class TestArtifactType:
    def test_all_values_defined(self):
        values = {t.value for t in ArtifactType}
        assert values == {
            "APPLICATION_DESIGN",
            "FUNCTIONAL_DESIGN",
            "TECHNICAL_ENVIRONMENT",
            "NFR_DESIGN",
            "NFR_REQUIREMENTS",
            "UNKNOWN",
        }

    def test_is_string_enum(self):
        assert ArtifactType.FUNCTIONAL_DESIGN == "FUNCTIONAL_DESIGN"

    def test_from_string(self):
        assert ArtifactType("NFR_DESIGN") == ArtifactType.NFR_DESIGN


class TestArtifactInfoCreate:
    def _mock_path(
        self, name: str = "business-logic-model.md", size: int = 1024
    ) -> MagicMock:
        mock = MagicMock(spec=Path)
        mock.name = name
        mock.stat.return_value = MagicMock(st_size=size)
        return mock

    def test_create_populates_file_name(self):
        mock_path = self._mock_path("domain-entities.md")
        artifact = ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)
        assert artifact.file_name == "domain-entities.md"

    def test_create_populates_size_bytes(self):
        mock_path = self._mock_path(size=2048)
        artifact = ArtifactInfo.create(mock_path, ArtifactType.APPLICATION_DESIGN)
        assert artifact.size_bytes == 2048

    def test_create_populates_discovered_at_utc(self):
        mock_path = self._mock_path()
        before = datetime.now(timezone.utc)
        artifact = ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)
        after = datetime.now(timezone.utc)
        assert before <= artifact.discovered_at <= after

    def test_create_content_is_none(self):
        mock_path = self._mock_path()
        artifact = ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)
        assert artifact.content is None

    def test_create_with_unit_name(self):
        mock_path = self._mock_path()
        artifact = ArtifactInfo.create(
            mock_path,
            ArtifactType.FUNCTIONAL_DESIGN,
            unit_name="unit1-foundation-config",
        )
        assert artifact.unit_name == "unit1-foundation-config"

    def test_create_without_unit_name_defaults_none(self):
        mock_path = self._mock_path()
        artifact = ArtifactInfo.create(mock_path, ArtifactType.APPLICATION_DESIGN)
        assert artifact.unit_name is None


class TestArtifactInfoWithContent:
    def _make_artifact(self) -> ArtifactInfo:
        mock_path = MagicMock(spec=Path)
        mock_path.name = "business-rules.md"
        mock_path.stat.return_value = MagicMock(st_size=512)
        return ArtifactInfo.create(mock_path, ArtifactType.FUNCTIONAL_DESIGN)

    def test_with_content_returns_new_instance(self):
        original = self._make_artifact()
        updated = original.with_content("# Business Rules\n...")
        assert updated is not original

    def test_with_content_sets_content(self):
        original = self._make_artifact()
        content = "# Business Rules\nRule 1: ..."
        updated = original.with_content(content)
        assert updated.content == content

    def test_original_content_unchanged(self):
        original = self._make_artifact()
        original.with_content("some content")
        assert original.content is None

    def test_with_content_preserves_all_other_fields(self):
        original = self._make_artifact()
        updated = original.with_content("content")
        assert updated.path == original.path
        assert updated.artifact_type == original.artifact_type
        assert updated.file_name == original.file_name
        assert updated.size_bytes == original.size_bytes
        assert updated.discovered_at == original.discovered_at

    def test_frozen_model_raises_on_direct_assignment(self):
        artifact = self._make_artifact()
        with pytest.raises(
            Exception
        ):  # ValidationError or TypeError from Pydantic frozen
            artifact.content = "not allowed"


class TestValidationResult:
    def _make_artifacts(self) -> list:
        mock_path = MagicMock(spec=Path)
        mock_path.name = "components.md"
        mock_path.stat.return_value = MagicMock(st_size=100)

        mock_path2 = MagicMock(spec=Path)
        mock_path2.name = "business-logic-model.md"
        mock_path2.stat.return_value = MagicMock(st_size=200)

        return [
            ArtifactInfo.create(mock_path, ArtifactType.APPLICATION_DESIGN),
            ArtifactInfo.create(mock_path2, ArtifactType.FUNCTIONAL_DESIGN),
        ]

    def test_empty_result(self):
        result = ValidationResult()
        assert result.artifacts == []
        assert result.warnings == []
        assert result.artifact_counts == {}

    def test_artifact_counts_computed_from_artifacts(self):
        artifacts = self._make_artifacts()
        result = ValidationResult(artifacts=artifacts)
        assert result.artifact_counts["APPLICATION_DESIGN"] == 1
        assert result.artifact_counts["FUNCTIONAL_DESIGN"] == 1
        assert result.artifact_counts["UNKNOWN"] == 0

    def test_warnings_stored(self):
        result = ValidationResult(warnings=["No TECHNICAL_ENVIRONMENT found"])
        assert len(result.warnings) == 1
        assert "TECHNICAL_ENVIRONMENT" in result.warnings[0]
