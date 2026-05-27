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
ArtifactScanner — recursive filesystem scan, exclusion filtering, path boundary validation.

Produces a list of (path, content_excerpt) tuples ready for AI classification.
"""

from __future__ import annotations

import itertools
from pathlib import Path
from typing import List, Tuple

from design_reviewer.foundation.logger import Logger

# Files excluded by name regardless of location (case-insensitive)
EXCLUDED_FILENAMES: frozenset[str] = frozenset(
    {"audit.md", "aidlc-state.md", "readme.md"}
)

# Directory names whose contents are excluded (at any depth)
EXCLUDED_DIRECTORIES: frozenset[str] = frozenset({"plans", "build-and-test"})

# Number of lines to read for AI classification
EXCERPT_LINE_COUNT: int = 100


class ArtifactScanner:
    """
    Scans the aidlc-docs directory recursively for .md files.

    Applies exclusion filters and path boundary validation, then reads
    a content excerpt from each candidate file for downstream classification.
    """

    def __init__(self, aidlc_docs_path: Path, logger: Logger) -> None:
        self._root = aidlc_docs_path
        self._logger = logger

    def scan(self) -> List[Tuple[Path, str]]:
        """
        Full scan pipeline: rglob → filter → boundary check → read excerpt.

        Returns:
            List of (absolute_path, first_100_lines) for each candidate file.
        """
        self._logger.info(f"Scanning for artifacts under: {self._root}")
        all_md = list(self._root.rglob("*.md"))
        self._logger.debug(f"Found {len(all_md)} .md files before filtering")

        filtered = self._apply_exclusions(all_md)
        self._logger.debug(f"{len(filtered)} files after exclusion filtering")

        candidates: List[Tuple[Path, str]] = []
        for path in filtered:
            if not self._is_within_root(path):
                self._logger.warning(
                    f"Excluded path outside aidlc-docs root (symlink): {path}"
                )
                continue
            excerpt = self._read_excerpt(path)
            candidates.append((path, excerpt))

        self._logger.info(f"Scan complete: {len(candidates)} candidate artifacts")
        return candidates

    def _apply_exclusions(self, files: List[Path]) -> List[Path]:
        """Filter out non-artifact files by name and by parent directory name."""
        result: List[Path] = []
        for f in files:
            if f.name.lower() in EXCLUDED_FILENAMES:
                continue
            relative_parts = set(f.relative_to(self._root).parts)
            if relative_parts & EXCLUDED_DIRECTORIES:
                continue
            result.append(f)
        return result

    def _is_within_root(self, candidate: Path) -> bool:
        """
        Return True if candidate resolves within the aidlc-docs root.

        Uses Path.parents for a robust containment check that handles
        symlinks (via resolve()) and avoids string prefix edge cases.
        """
        try:
            resolved_candidate = candidate.resolve()
            resolved_root = self._root.resolve()
            return (
                resolved_root in resolved_candidate.parents
                or resolved_candidate == resolved_root
            )
        except (OSError, RuntimeError):
            # Broken symlink or resolution failure — exclude the path
            return False

    def _read_excerpt(self, path: Path) -> str:
        """
        Read the first EXCERPT_LINE_COUNT lines of a file.

        Returns empty string on any read error (classification will assign UNKNOWN).
        """
        try:
            with path.open(encoding="utf-8", errors="replace") as fh:
                lines = list(itertools.islice(fh, EXCERPT_LINE_COUNT))
            return "".join(lines)
        except OSError:
            self._logger.debug(f"Could not read excerpt from {path}")
            return ""
