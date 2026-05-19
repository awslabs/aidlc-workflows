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
StructureValidator — entry gate for the review workflow.

Validates the aidlc-docs directory is an existing AIDLC project with sufficient
design artifacts. Critical failures raise StructureValidationError; missing
artifact types log advisory warnings only.
"""

from __future__ import annotations

from pathlib import Path
from typing import List

from design_reviewer.foundation.exceptions import StructureValidationError
from design_reviewer.foundation.logger import Logger
from design_reviewer.validation.discoverer import ArtifactDiscoverer
from design_reviewer.validation.models import (
    ArtifactInfo,
    ArtifactType,
    ValidationResult,
)

# Sentinel file that confirms this is an AIDLC project root
_SENTINEL_FILE = "aidlc-state.md"

# Artifact types that produce advisory warnings when absent (not fatal)
_ADVISORY_TYPES = [
    ArtifactType.APPLICATION_DESIGN,
    ArtifactType.FUNCTIONAL_DESIGN,
    ArtifactType.TECHNICAL_ENVIRONMENT,
]


class StructureValidator:
    """
    Validates the aidlc-docs project structure before review execution.

    Validation pipeline:
        1. Root directory must exist and be a directory (fatal)
        2. aidlc-state.md sentinel must be present (fatal — confirms AIDLC project)
        3. At least one artifact must be discoverable (fatal)
        4. Missing artifact types → advisory warnings (non-fatal)
        5. Log success summary
    """

    def __init__(
        self,
        aidlc_docs_path: Path,
        discoverer: ArtifactDiscoverer,
        logger: Logger,
    ) -> None:
        self._root = aidlc_docs_path
        self._discoverer = discoverer
        self._logger = logger

    def validate_structure(self) -> ValidationResult:
        """
        Execute the full validation pipeline.

        Returns:
            ValidationResult with discovered artifacts and advisory warnings.

        Raises:
            StructureValidationError: For any critical validation failure.
        """
        self._logger.info(f"Validating AIDLC project structure at: {self._root}")

        self._check_root_exists()
        self._check_sentinel()

        artifacts = self._discoverer.discover_artifacts()
        self._check_artifacts_present(artifacts)

        warnings = self._check_type_presence(artifacts)
        for warning in warnings:
            self._logger.warning(warning)

        self._log_success(artifacts)
        return ValidationResult(artifacts=artifacts, warnings=warnings)

    def _check_root_exists(self) -> None:
        """Step 1 — Root directory must exist and be a directory."""
        if not self._root.exists() or not self._root.is_dir():
            raise StructureValidationError(
                f"aidlc-docs path does not exist or is not a directory: {self._root}",
                context={
                    "missing_paths": [str(self._root)],
                    "expected": "an existing directory",
                    "hint": "Check that the --aidlc-docs argument points to an existing folder",
                },
            )

    def _check_sentinel(self) -> None:
        """Step 2 — aidlc-state.md must be present at the root."""
        sentinel = self._root / _SENTINEL_FILE
        if not sentinel.exists():
            raise StructureValidationError(
                f"This directory does not appear to be an AIDLC project "
                f"(aidlc-state.md not found): {self._root}",
                context={
                    "missing_paths": [str(sentinel)],
                    "expected": f"{_SENTINEL_FILE} (AIDLC project sentinel file)",
                    "hint": (
                        "Verify --aidlc-docs points to an AIDLC project root "
                        f"containing {_SENTINEL_FILE}"
                    ),
                },
            )

    def _check_artifacts_present(self, artifacts: List[ArtifactInfo]) -> None:
        """Step 3 — At least one artifact must have been discovered."""
        if not artifacts:
            raise StructureValidationError(
                "aidlc-docs directory exists but contains no design artifacts",
                context={
                    "missing_paths": [str(self._root)],
                    "expected": "at least one design artifact (.md file) under aidlc-docs",
                    "hint": (
                        "Verify the AIDLC project has completed at least the "
                        "Application Design stage"
                    ),
                },
            )

    def _check_type_presence(self, artifacts: List[ArtifactInfo]) -> List[str]:
        """
        Step 4 — Check for expected artifact types; return advisory warnings for absent types.

        Does NOT raise exceptions — missing types reduce review quality but don't block it.
        """
        present_types = {a.artifact_type for a in artifacts}
        warnings: List[str] = []

        type_messages = {
            ArtifactType.APPLICATION_DESIGN: (
                "No application-design artifacts found. "
                "Review quality may be limited (missing component definitions)."
            ),
            ArtifactType.FUNCTIONAL_DESIGN: (
                "No functional-design artifacts found. "
                "Review quality may be limited (missing business logic models)."
            ),
            ArtifactType.TECHNICAL_ENVIRONMENT: (
                "technical-environment.md not found. "
                "Technical context will be unavailable to AI review agents."
            ),
        }

        for artifact_type in _ADVISORY_TYPES:
            if artifact_type not in present_types:
                warnings.append(type_messages[artifact_type])

        return warnings

    def _log_success(self, artifacts: List[ArtifactInfo]) -> None:
        """Step 5 — Log validation success with artifact count breakdown (Story 3.6)."""
        from collections import Counter

        counts = Counter(a.artifact_type.value for a in artifacts)
        parts = [
            f"{counts.get(t.value, 0)} {t.value.lower().replace('_', '-')}"
            for t in ArtifactType
            if counts.get(t.value, 0) > 0
        ]
        self._logger.info(
            f"Structure validation passed: {len(artifacts)} artifacts found "
            f"({', '.join(parts)})"
        )
