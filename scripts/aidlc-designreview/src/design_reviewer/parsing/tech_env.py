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
TechnicalEnvironmentParser — passes technical-environment.md content through unchanged.

No structural extraction. AI agents receive the full markdown for context.
Empty/absent tech-env is advisory only — never raises ParsingError.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

from design_reviewer.foundation.logger import Logger
from design_reviewer.parsing.base import BaseParser
from design_reviewer.parsing.models import TechnicalEnvironmentModel


class TechnicalEnvironmentParser(BaseParser):
    """
    Returns the full content of technical-environment.md unchanged.
    """

    def __init__(self, logger: Logger) -> None:
        super().__init__(logger)

    def parse(
        self,
        content: Optional[str],
        file_path: Optional[Path] = None,
    ) -> TechnicalEnvironmentModel:
        """
        Return technical-environment content as-is.

        Args:
            content: Full markdown content of technical-environment.md.
            file_path: Source path for metadata (optional).

        Returns:
            TechnicalEnvironmentModel with raw content.
            Returns empty model (not an error) if content is absent.
        """
        start = time.perf_counter()
        result = self._do_parse(content, file_path)
        elapsed = time.perf_counter() - start
        self._logger.info(
            f"Parsed TECHNICAL_ENVIRONMENT artifacts in {elapsed:.3f}s (1 files)"
        )
        return result

    def _do_parse(
        self,
        content: Optional[str],
        file_path: Optional[Path],
    ) -> TechnicalEnvironmentModel:
        if content is None or not content.strip():
            self._logger.warning(
                "technical-environment.md content is empty or absent; "
                "technical context will be unavailable to AI review agents"
            )
            return TechnicalEnvironmentModel(raw_content="", file_path=file_path)

        return TechnicalEnvironmentModel(raw_content=content, file_path=file_path)
