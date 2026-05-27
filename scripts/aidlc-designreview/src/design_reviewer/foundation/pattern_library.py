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
Pattern library singleton for managing architectural patterns.
"""

from pathlib import Path
from typing import List, Optional


from .exceptions import InvalidPatternCountError, PatternFileNotFoundError
from .file_validator import FileValidator
from .pattern_models import Pattern


class PatternLibrary:
    """
    Singleton pattern library.

    Manages 15 core architectural patterns with System Architecture priority.
    """

    _instance: Optional["PatternLibrary"] = None
    _patterns: List[Pattern] = []

    EXPECTED_PATTERN_COUNT = 15
    PRIORITY_CATEGORY = "System Architecture"

    # Expected pattern files
    PATTERN_FILES = [
        "layered-architecture.md",
        "microservices.md",
        "event-driven.md",
        "repository.md",
        "cqrs.md",
        "event-sourcing.md",
        "api-gateway.md",
        "message-broker.md",
        "rpc.md",
        "load-balancer.md",
        "caching.md",
        "cdn.md",
        "circuit-breaker.md",
        "retry.md",
        "bulkhead.md",
    ]

    @classmethod
    def initialize(
        cls, patterns_directory: str = "config/patterns"
    ) -> "PatternLibrary":
        """
        Initialize singleton pattern library.

        Args:
            patterns_directory: Directory containing pattern files

        Returns:
            PatternLibrary singleton instance

        Raises:
            PatternFileNotFoundError: If required pattern file not found
            InvalidPatternCountError: If pattern count != 15
            RuntimeError: If already initialized
        """
        if cls._instance is not None:
            raise RuntimeError(
                "PatternLibrary already initialized. Call get_instance() to access existing instance."
            )

        instance = cls()
        instance._patterns = instance._load_all_patterns(patterns_directory)
        cls._instance = instance

        return instance

    @classmethod
    def get_instance(cls) -> "PatternLibrary":
        """
        Get singleton pattern library instance.

        Returns:
            PatternLibrary singleton instance

        Raises:
            RuntimeError: If not initialized
        """
        if cls._instance is None:
            raise RuntimeError(
                "PatternLibrary not initialized. Call PatternLibrary.initialize() first."
            )
        return cls._instance

    @classmethod
    def reset(cls) -> None:
        """Reset singleton for testing. NOT for production use."""
        cls._instance = None
        cls._patterns = []

    def _load_all_patterns(self, patterns_directory: str) -> List[Pattern]:
        """
        Load all pattern files.

        Args:
            patterns_directory: Directory containing pattern files

        Returns:
            List of Pattern objects, sorted by priority

        Raises:
            PatternFileNotFoundError: If pattern file not found
            InvalidPatternCountError: If pattern count != 15
        """
        patterns_dir = Path(patterns_directory).expanduser()
        patterns = []

        for pattern_file_name in self.PATTERN_FILES:
            pattern_file = patterns_dir / pattern_file_name

            if not pattern_file.exists():
                pattern_name = pattern_file_name.replace(".md", "")
                raise PatternFileNotFoundError(str(pattern_file), pattern_name)

            # Load and parse pattern
            pattern = self._load_pattern(pattern_file)
            patterns.append(pattern)

        # Validate count
        if len(patterns) != self.EXPECTED_PATTERN_COUNT:
            raise InvalidPatternCountError(len(patterns), self.EXPECTED_PATTERN_COUNT)

        # Sort: priority patterns first, then alphabetical
        patterns.sort(
            key=lambda p: (not p.is_priority, p.name)
        )  # nosemgrep: is-function-without-parentheses — is_priority is a Pydantic bool field, not a callable

        return patterns

    def _load_pattern(self, pattern_file: Path) -> Pattern:
        """
        Load and parse pattern file.

        Args:
            pattern_file: Path to pattern file

        Returns:
            Pattern object
        """
        # Validate and load file
        content = FileValidator.validate_file(pattern_file, "Pattern")

        # Parse markdown structure
        # Simple parsing: extract sections by headers
        lines = content.split("\n")

        name = ""
        category = ""
        description = ""
        when_to_use = ""
        example = ""

        current_section = None

        for line in lines:
            line = line.strip()

            if line.startswith("# "):
                name = line[2:].strip()
            elif line.startswith("## Category"):
                current_section = "category"
            elif line.startswith("## Description"):
                current_section = "description"
            elif line.startswith("## When to Use"):
                current_section = "when_to_use"
            elif line.startswith("## Example"):
                current_section = "example"
            elif line and not line.startswith("#"):
                if current_section == "category":
                    category += line + " "
                elif current_section == "description":
                    description += line + " "
                elif current_section == "when_to_use":
                    when_to_use += line + " "
                elif current_section == "example":
                    example += line + " "

        # Determine if priority (System Architecture category)
        is_priority = self.PRIORITY_CATEGORY.lower() in category.lower()

        return Pattern(
            name=name.strip(),
            category=category.strip(),
            description=description.strip(),
            when_to_use=when_to_use.strip(),
            example=example.strip(),
            is_priority=is_priority,
        )

    def get_all_patterns(self) -> List[Pattern]:
        """
        Get all patterns, sorted by priority.

        Returns:
            List of Pattern objects
        """
        return self._patterns.copy()

    def get_patterns_by_category(self, category: str) -> List[Pattern]:
        """
        Get patterns filtered by category.

        Args:
            category: Category name

        Returns:
            List of Pattern objects matching category
        """
        return [p for p in self._patterns if category.lower() in p.category.lower()]

    def format_patterns_for_prompt(self) -> str:
        """
        Format all patterns for AI prompt.

        Returns:
            Formatted string with all patterns
        """
        formatted = []

        for pattern in self._patterns:
            pattern_str = f"""
Pattern: {pattern.name}
Category: {pattern.category}
Description: {pattern.description}
When to Use: {pattern.when_to_use}
Example: {pattern.example}
---
"""
            formatted.append(pattern_str.strip())

        return "\n\n".join(formatted)
