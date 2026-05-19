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
ApplicationDesignParser — concatenates all APPLICATION_DESIGN artifacts.

Files are sorted alphabetically by name and joined with source separators.
Returns ApplicationDesignModel with raw combined markdown for AI agents.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Dict, List

from design_reviewer.foundation.exceptions import ParsingError
from design_reviewer.foundation.logger import Logger
from design_reviewer.parsing.base import BaseParser
from design_reviewer.parsing.models import ApplicationDesignModel
from design_reviewer.validation.models import ArtifactInfo

# Key section headings to check for (advisory warnings if absent)
_KEY_SECTIONS = ["Components", "Component Methods", "Services"]

_SOURCE_SEPARATOR = "---\n# Source: {filename}\n---\n"


class ApplicationDesignParser(BaseParser):
    """
    Parses application-design artifacts by concatenating all file contents.

    Sorting is alphabetical by filename for deterministic output.
    """

    def __init__(self, logger: Logger) -> None:
        super().__init__(logger)

    def parse(
        self,
        content_map: Dict[Path, str],
        artifact_infos: List[ArtifactInfo],
    ) -> ApplicationDesignModel:
        """
        Concatenate all APPLICATION_DESIGN artifact contents.

        Args:
            content_map: {path: content} for APPLICATION_DESIGN artifacts.
            artifact_infos: ArtifactInfo objects for metadata.

        Returns:
            ApplicationDesignModel with aggregated raw content.

        Raises:
            ParsingError: If files are present but all content is empty.
        """
        start = time.perf_counter()
        result = self._do_parse(content_map, artifact_infos)
        elapsed = time.perf_counter() - start
        self._logger.info(
            f"Parsed APPLICATION_DESIGN artifacts in {elapsed:.3f}s "
            f"({result.source_count} files)"
        )
        return result

    def _do_parse(
        self,
        content_map: Dict[Path, str],
        artifact_infos: List[ArtifactInfo],
    ) -> ApplicationDesignModel:
        if not content_map:
            self._logger.warning(
                "No application-design artifacts provided; "
                "ApplicationDesignModel will have empty content"
            )
            return ApplicationDesignModel(raw_content="", file_paths=[], source_count=0)

        # Sort paths alphabetically by filename for determinism
        sorted_paths = sorted(content_map.keys(), key=lambda p: p.name)

        parts: List[str] = []
        included_paths: List[Path] = []

        for path in sorted_paths:
            content = content_map[path]
            if not content or not content.strip():
                self._logger.warning(
                    f"Empty content in application-design file: {path.name}"
                )
                continue
            parts.append(_SOURCE_SEPARATOR.format(filename=path.name) + content)
            included_paths.append(path)

        if not parts:
            raise ParsingError(
                "All application-design files were empty",
                context={
                    "file_path": None,
                    "section": None,
                    "error_message": f"{len(content_map)} files attempted, all empty",
                    "raw_content": "",
                },
            )

        combined = "\n\n".join(parts)

        # Advisory check for key sections (BR-3.9)
        for section in _KEY_SECTIONS:
            if section.lower() not in combined.lower():
                self._logger.warning(
                    f"Key section '{section}' not found in application-design content"
                )

        return ApplicationDesignModel(
            raw_content=combined,
            file_paths=included_paths,
            source_count=len(included_paths),
        )
