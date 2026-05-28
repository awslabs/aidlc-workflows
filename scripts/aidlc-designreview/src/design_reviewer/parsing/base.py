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
BaseParser — abstract base class for all Unit 3 parsers.

Provides:
- extract_section(): heading-position slicing via markdown-it-py token.map
- validate_content(): fail-fast ParsingError on empty content
- extract_code_blocks(): extract fenced code block contents
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, Optional

from markdown_it import MarkdownIt
from pydantic import BaseModel

from design_reviewer.foundation.exceptions import ParsingError
from design_reviewer.foundation.logger import Logger


class BaseParser(ABC):
    """
    Abstract base class for all Unit 3 parsers.

    Each subclass implements parse() and inherits shared markdown utilities.
    One MarkdownIt instance is created per parser instance (thread-safe,
    no per-call construction overhead).
    """

    def __init__(self, logger: Logger) -> None:
        self._logger = logger
        self._md = MarkdownIt()

    @abstractmethod
    def parse(self, *args, **kwargs) -> BaseModel:
        """Parse artifact content and return a typed Pydantic model."""

    def extract_section(self, content: str, heading_text: str) -> Optional[str]:
        """
        Extract content from a heading to the next same-or-higher-level heading (or EOF).

        Uses markdown-it-py token.map for accurate heading line detection.
        Headings inside fenced code blocks are automatically ignored by markdown-it-py.

        Args:
            content: Full markdown string to search.
            heading_text: Heading text to find (with or without leading # markers).
                         Matched case-insensitively.

        Returns:
            Content string between the heading and next boundary, stripped.
            None if heading not found (warning logged).
        """
        if not content:
            return None

        lines = content.splitlines(keepends=True)
        tokens = self._md.parse(content)

        # Build ordered list of (start_line, level, text) for each heading token
        headings: list[tuple[int, int, str]] = []
        i = 0
        while i < len(tokens):
            token = tokens[i]
            if token.type == "heading_open" and token.map:
                level = int(token.tag[1])  # "h1"->1, "h2"->2, etc.
                if i + 1 < len(tokens) and tokens[i + 1].type == "inline":
                    text = tokens[i + 1].content.strip()
                    headings.append((token.map[0], level, text))
                i += 3  # heading_open, inline, heading_close
            else:
                i += 1

        # Find the target heading (case-insensitive, strip leading # markers)
        clean_target = heading_text.lstrip("#").strip().lower()
        target_idx: Optional[int] = None
        target_level: Optional[int] = None
        target_line: Optional[int] = None

        for idx, (line_no, level, text) in enumerate(headings):
            if text.lower() == clean_target:
                target_idx = idx
                target_level = level
                target_line = line_no
                break

        if target_idx is None:
            self._logger.warning(
                f"Section '{heading_text}' not found ({len(headings)} headings scanned)"
            )
            return None

        # Find the end line: next heading at same or higher level (smaller number)
        end_line = len(lines)  # default: end of document
        for line_no, level, _ in headings[target_idx + 1 :]:
            if level <= target_level:
                end_line = line_no
                break

        # Slice content lines (skip the heading line itself)
        section_lines = lines[target_line + 1 : end_line]
        result = "".join(section_lines).strip()
        return result if result else None

    def validate_content(
        self, content: Optional[str], artifact_description: str
    ) -> None:
        """
        Raise ParsingError if content is None or whitespace-only.

        Args:
            content: Content string to validate.
            artifact_description: Human-readable description for error message.

        Raises:
            ParsingError: If content is empty or None.
        """
        if content is None or not content.strip():
            raise ParsingError(
                f"Empty content for {artifact_description}",
                context={
                    "artifact_description": artifact_description,
                    "section": None,
                    "raw_content": repr(content),
                },
            )

    def extract_code_blocks(self, content: str) -> List[str]:
        """
        Extract all fenced code block contents from markdown.

        Args:
            content: Markdown string.

        Returns:
            List of code block content strings (without fence markers).
        """
        tokens = self._md.parse(content)
        return [
            token.content for token in tokens if token.type == "fence" and token.content
        ]
