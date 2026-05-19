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
ArtifactDiscoverer — facade composing ArtifactScanner and ArtifactClassifier.

Orchestrates the full discovery pipeline and logs a summary of all discovered
artifacts with type and count breakdown (Story 4.4).
"""

from __future__ import annotations

from typing import Dict, List

from design_reviewer.foundation.logger import Logger
from design_reviewer.validation.classifier import ArtifactClassifier
from design_reviewer.validation.models import ArtifactInfo, ArtifactType
from design_reviewer.validation.scanner import ArtifactScanner


class ArtifactDiscoverer:
    """
    Orchestrates scan → classify to produce a typed list of ArtifactInfo objects.

    Delegates filesystem work to ArtifactScanner and AI classification to
    ArtifactClassifier. Logs discovery summary after completion.
    """

    def __init__(
        self,
        scanner: ArtifactScanner,
        classifier: ArtifactClassifier,
        logger: Logger,
    ) -> None:
        self._scanner = scanner
        self._classifier = classifier
        self._logger = logger

    def discover_artifacts(self) -> List[ArtifactInfo]:
        """
        Run the full discovery pipeline.

        Returns:
            List of ArtifactInfo objects (no content populated).

        Raises:
            StructureValidationError: Propagated from ArtifactClassifier on Amazon Bedrock failure.
        """
        candidates = self._scanner.scan()
        artifacts = self._classifier.classify_all(candidates)
        self._log_discovery_summary(artifacts)
        return artifacts

    def _log_discovery_summary(self, artifacts: List[ArtifactInfo]) -> None:
        """
        Log the full artifact list with types and a count summary per type (Story 4.4).
        """
        if not artifacts:
            self._logger.info("Discovered 0 artifacts")
            return

        self._logger.info(f"Discovered {len(artifacts)} artifacts:")
        for artifact in sorted(
            artifacts, key=lambda a: (a.artifact_type.value, a.file_name)
        ):
            self._logger.info(
                f"  [{artifact.artifact_type.value:<25}] {artifact.file_name}  ({artifact.path})"
            )

        counts: Dict[str, int] = {t.value: 0 for t in ArtifactType}
        for artifact in artifacts:
            counts[artifact.artifact_type.value] += 1

        summary_parts = [
            f"{v} {k.lower().replace('_', '-')}" for k, v in counts.items() if v > 0
        ]
        self._logger.info(f"Summary: {', '.join(summary_parts)}")
