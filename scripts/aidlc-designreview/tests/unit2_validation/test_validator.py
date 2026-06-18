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


"""Tests for StructureValidator — validation pipeline."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from design_reviewer.foundation.exceptions import StructureValidationError
from design_reviewer.validation.models import (
    ArtifactInfo,
    ArtifactType,
    ValidationResult,
)
from design_reviewer.validation.validator import StructureValidator


def make_mock_logger() -> MagicMock:
    logger = MagicMock()
    logger.info = MagicMock()
    logger.warning = MagicMock()
    logger.debug = MagicMock()
    return logger


def make_artifact(name: str, artifact_type: ArtifactType) -> ArtifactInfo:
    mock_path = MagicMock(spec=Path)
    mock_path.name = name
    mock_path.parts = ("aidlc-docs", "inception", name)
    mock_path.stat.return_value = MagicMock(st_size=100)
    mock_path.__str__ = lambda self: f"/aidlc-docs/inception/{name}"
    return ArtifactInfo.create(mock_path, artifact_type)


def make_validator(
    root: Path,
    artifacts: list | None = None,
) -> tuple[StructureValidator, MagicMock]:
    mock_discoverer = MagicMock()
    mock_discoverer.discover_artifacts.return_value = artifacts or []
    mock_logger = make_mock_logger()
    validator = StructureValidator(root, mock_discoverer, mock_logger)
    return validator, mock_logger


class TestCheckRootExists:
    def test_missing_root_raises_structure_validation_error(self, tmp_path):
        missing = tmp_path / "nonexistent"
        validator, _ = make_validator(missing)
        with pytest.raises(StructureValidationError) as exc_info:
            validator._check_root_exists()
        assert str(missing) in str(exc_info.value)

    def test_root_is_file_raises_structure_validation_error(self, tmp_path):
        file_path = tmp_path / "not-a-dir.md"
        file_path.write_text("content")
        validator, _ = make_validator(file_path)
        with pytest.raises(StructureValidationError):
            validator._check_root_exists()

    def test_valid_directory_passes(self, tmp_path):
        validator, _ = make_validator(tmp_path)
        validator._check_root_exists()  # Should not raise


class TestCheckSentinel:
    def test_missing_sentinel_raises_structure_validation_error(self, tmp_path):
        validator, _ = make_validator(tmp_path)
        with pytest.raises(StructureValidationError) as exc_info:
            validator._check_sentinel()
        assert "aidlc-state.md" in str(exc_info.value)

    def test_sentinel_present_passes(self, tmp_path):
        (tmp_path / "aidlc-state.md").write_text("# State")
        validator, _ = make_validator(tmp_path)
        validator._check_sentinel()  # Should not raise


class TestCheckArtifactsPresent:
    def test_empty_artifacts_raises_structure_validation_error(self, tmp_path):
        validator, _ = make_validator(tmp_path, artifacts=[])
        with pytest.raises(StructureValidationError) as exc_info:
            validator._check_artifacts_present([])
        assert "no design artifacts" in str(exc_info.value).lower()

    def test_non_empty_artifacts_passes(self, tmp_path):
        artifacts = [make_artifact("components.md", ArtifactType.APPLICATION_DESIGN)]
        validator, _ = make_validator(tmp_path, artifacts=artifacts)
        validator._check_artifacts_present(artifacts)  # Should not raise


class TestCheckTypePresence:
    def test_all_types_present_returns_no_warnings(self, tmp_path):
        validator, _ = make_validator(tmp_path)
        artifacts = [
            make_artifact("components.md", ArtifactType.APPLICATION_DESIGN),
            make_artifact("business-logic.md", ArtifactType.FUNCTIONAL_DESIGN),
            make_artifact(
                "technical-environment.md", ArtifactType.TECHNICAL_ENVIRONMENT
            ),
        ]
        warnings = validator._check_type_presence(artifacts)
        assert warnings == []

    def test_missing_application_design_returns_warning(self, tmp_path):
        validator, _ = make_validator(tmp_path)
        artifacts = [
            make_artifact("business-logic.md", ArtifactType.FUNCTIONAL_DESIGN),
            make_artifact(
                "technical-environment.md", ArtifactType.TECHNICAL_ENVIRONMENT
            ),
        ]
        warnings = validator._check_type_presence(artifacts)
        assert any("application-design" in w.lower() for w in warnings)

    def test_missing_functional_design_returns_warning(self, tmp_path):
        validator, _ = make_validator(tmp_path)
        artifacts = [
            make_artifact("components.md", ArtifactType.APPLICATION_DESIGN),
        ]
        warnings = validator._check_type_presence(artifacts)
        assert any("functional-design" in w.lower() for w in warnings)

    def test_missing_technical_environment_returns_warning(self, tmp_path):
        validator, _ = make_validator(tmp_path)
        artifacts = [
            make_artifact("components.md", ArtifactType.APPLICATION_DESIGN),
            make_artifact("business-logic.md", ArtifactType.FUNCTIONAL_DESIGN),
        ]
        warnings = validator._check_type_presence(artifacts)
        assert any("technical-environment" in w.lower() for w in warnings)


class TestValidateStructure:
    def test_full_pipeline_success(self, tmp_path):
        (tmp_path / "aidlc-state.md").write_text("sentinel")
        artifacts = [
            make_artifact("components.md", ArtifactType.APPLICATION_DESIGN),
            make_artifact("business-logic.md", ArtifactType.FUNCTIONAL_DESIGN),
            make_artifact(
                "technical-environment.md", ArtifactType.TECHNICAL_ENVIRONMENT
            ),
        ]
        validator, mock_logger = make_validator(tmp_path, artifacts=artifacts)
        result = validator.validate_structure()

        assert isinstance(result, ValidationResult)
        assert len(result.artifacts) == 3
        assert result.warnings == []
        mock_logger.info.assert_called()

    def test_missing_root_raises(self, tmp_path):
        missing = tmp_path / "nonexistent"
        validator, _ = make_validator(missing)
        with pytest.raises(StructureValidationError):
            validator.validate_structure()

    def test_missing_sentinel_raises(self, tmp_path):
        # root exists but no aidlc-state.md
        validator, _ = make_validator(tmp_path)
        with pytest.raises(StructureValidationError):
            validator.validate_structure()

    def test_empty_discovery_raises(self, tmp_path):
        (tmp_path / "aidlc-state.md").write_text("sentinel")
        validator, _ = make_validator(tmp_path, artifacts=[])
        with pytest.raises(StructureValidationError):
            validator.validate_structure()

    def test_missing_types_produce_warnings_not_exception(self, tmp_path):
        (tmp_path / "aidlc-state.md").write_text("sentinel")
        # Only UNKNOWN artifacts — all advisory types missing
        artifacts = [make_artifact("unknown.md", ArtifactType.UNKNOWN)]
        validator, mock_logger = make_validator(tmp_path, artifacts=artifacts)
        result = validator.validate_structure()

        assert len(result.warnings) == 3  # One per advisory type
        assert mock_logger.warning.call_count == 3

    def test_success_message_logged(self, tmp_path):
        (tmp_path / "aidlc-state.md").write_text("sentinel")
        artifacts = [make_artifact("components.md", ArtifactType.APPLICATION_DESIGN)]
        validator, mock_logger = make_validator(tmp_path, artifacts=artifacts)
        validator.validate_structure()

        success_calls = [
            c
            for c in mock_logger.info.call_args_list
            if "validation passed" in str(c).lower()
        ]
        assert len(success_calls) == 1

    def test_result_artifact_counts_populated(self, tmp_path):
        (tmp_path / "aidlc-state.md").write_text("sentinel")
        artifacts = [
            make_artifact("c1.md", ArtifactType.APPLICATION_DESIGN),
            make_artifact("c2.md", ArtifactType.APPLICATION_DESIGN),
            make_artifact("f1.md", ArtifactType.FUNCTIONAL_DESIGN),
        ]
        validator, _ = make_validator(tmp_path, artifacts=artifacts)
        result = validator.validate_structure()

        assert result.artifact_counts["APPLICATION_DESIGN"] == 2
        assert result.artifact_counts["FUNCTIONAL_DESIGN"] == 1
