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
FunctionalDesignParser — concatenates FUNCTIONAL_DESIGN artifacts from all units.

Each unit's files are grouped under a `# Unit: {unit_name}` header so AI agents
understand which unit each design artifact belongs to.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Dict, List

from design_reviewer.foundation.exceptions import ParsingError
from design_reviewer.foundation.logger import Logger
from design_reviewer.parsing.base import BaseParser
from design_reviewer.parsing.models import FunctionalDesignModel
from design_reviewer.validation.models import ArtifactInfo

_UNIT_HEADER = "---\n# Unit: {unit_name}\n---\n"
_FILE_HEADER = "## Source: {filename}\n\n"


class FunctionalDesignParser(BaseParser):
    """
    Parses functional-design artifacts from all units into one combined model.

    Units are sorted alphabetically. Within each unit, files are sorted alphabetically.
    Each unit section is preceded by a `# Unit: {unit_name}` header.
    """

    def __init__(self, logger: Logger) -> None:
        super().__init__(logger)

    def parse(
        self,
        content_map: Dict[Path, str],
        artifact_infos: List[ArtifactInfo],
    ) -> FunctionalDesignModel:
        """
        Concatenate all FUNCTIONAL_DESIGN artifact contents across all units.

        Args:
            content_map: {path: content} for FUNCTIONAL_DESIGN artifacts.
            artifact_infos: ArtifactInfo objects providing unit_name metadata.

        Returns:
            FunctionalDesignModel with multi-unit aggregated raw content.

        Raises:
            ParsingError: If files are present but all content is empty.
        """
        start = time.perf_counter()
        result = self._do_parse(content_map, artifact_infos)
        elapsed = time.perf_counter() - start
        self._logger.info(
            f"Parsed FUNCTIONAL_DESIGN artifacts in {elapsed:.3f}s "
            f"({result.source_count} files, {len(result.unit_names)} units)"
        )
        return result

    def _do_parse(
        self,
        content_map: Dict[Path, str],
        artifact_infos: List[ArtifactInfo],
    ) -> FunctionalDesignModel:
        if not content_map:
            self._logger.warning(
                "No functional-design artifacts provided; "
                "FunctionalDesignModel will have empty content"
            )
            return FunctionalDesignModel(
                raw_content="", file_paths=[], unit_names=[], source_count=0
            )

        # Build path -> unit_name lookup from ArtifactInfo
        path_to_unit: Dict[Path, str] = {
            info.path: (info.unit_name or "unknown")
            for info in artifact_infos
            if info.path in content_map
        }

        # Group paths by unit_name, sort units and files alphabetically
        units: Dict[str, List[Path]] = {}
        for path in content_map:
            unit_name = path_to_unit.get(path, "unknown")
            units.setdefault(unit_name, []).append(path)

        parts: List[str] = []
        included_paths: List[Path] = []
        unit_names: List[str] = []

        for unit_name in sorted(units.keys()):
            unit_paths = sorted(units[unit_name], key=lambda p: p.name)
            unit_parts: List[str] = []

            for path in unit_paths:
                content = content_map[path]
                if not content or not content.strip():
                    self._logger.warning(
                        f"Empty content in functional-design file: {path.name} "
                        f"(unit: {unit_name})"
                    )
                    continue
                unit_parts.append(_FILE_HEADER.format(filename=path.name) + content)
                included_paths.append(path)

            if unit_parts:
                unit_block = _UNIT_HEADER.format(unit_name=unit_name) + "\n".join(
                    unit_parts
                )
                parts.append(unit_block)
                unit_names.append(unit_name)

        if not parts:
            raise ParsingError(
                "All functional-design files were empty",
                context={
                    "file_path": None,
                    "section": None,
                    "error_message": f"{len(content_map)} files attempted, all empty",
                    "raw_content": "",
                },
            )

        return FunctionalDesignModel(
            raw_content="\n\n".join(parts),
            file_paths=included_paths,
            unit_names=unit_names,
            source_count=len(included_paths),
        )
