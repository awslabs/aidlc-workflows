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
Domain models for Unit 2: Validation & Discovery.

ArtifactType, ArtifactInfo, ValidationResult.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict


class ArtifactType(str, Enum):
    """Classifies a discovered AIDLC design artifact by content type."""

    APPLICATION_DESIGN = "APPLICATION_DESIGN"
    FUNCTIONAL_DESIGN = "FUNCTIONAL_DESIGN"
    TECHNICAL_ENVIRONMENT = "TECHNICAL_ENVIRONMENT"
    NFR_DESIGN = "NFR_DESIGN"
    NFR_REQUIREMENTS = "NFR_REQUIREMENTS"
    UNKNOWN = "UNKNOWN"


class ArtifactInfo(BaseModel):
    """
    Immutable representation of a discovered design artifact.

    Content is None until populated by ArtifactLoader via with_content().
    Use create() classmethod to build at discovery time.
    """

    model_config = ConfigDict(frozen=True)

    path: Path
    artifact_type: ArtifactType
    unit_name: Optional[str] = None
    file_name: str
    size_bytes: int
    discovered_at: datetime
    content: Optional[str] = None

    @classmethod
    def create(
        cls,
        path: Path,
        artifact_type: ArtifactType,
        unit_name: Optional[str] = None,
    ) -> "ArtifactInfo":
        """
        Factory for initial discovery — populates metadata from filesystem.

        Args:
            path: Absolute path to the artifact file.
            artifact_type: Type determined by AI classification.
            unit_name: Unit name extracted from construction/ subtree, or None.

        Returns:
            New ArtifactInfo with file_name, size_bytes, discovered_at populated.
        """
        return cls(
            path=path,
            artifact_type=artifact_type,
            unit_name=unit_name,
            file_name=path.name,
            size_bytes=path.stat().st_size,
            discovered_at=datetime.now(timezone.utc),
        )

    def with_content(self, content: str) -> "ArtifactInfo":
        """
        Return a new ArtifactInfo instance with content populated.

        Args:
            content: Raw UTF-8 file content.

        Returns:
            New frozen ArtifactInfo with content set.
        """
        return self.model_copy(update={"content": content})


@dataclass
class ValidationResult:
    """
    Outcome of structure validation, carrying discovered artifacts and warnings.

    Returned by StructureValidator.validate_structure().
    """

    artifacts: List[ArtifactInfo] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    artifact_counts: Dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.artifact_counts and self.artifacts:
            self.artifact_counts = self._compute_counts()

    def _compute_counts(self) -> Dict[str, int]:
        counts: Dict[str, int] = {t.value: 0 for t in ArtifactType}
        for artifact in self.artifacts:
            counts[artifact.artifact_type.value] += 1
        return counts
