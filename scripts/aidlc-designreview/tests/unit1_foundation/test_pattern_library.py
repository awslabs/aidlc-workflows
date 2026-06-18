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
Unit tests for PatternLibrary singleton.

Tests singleton pattern, pattern loading, markdown parsing, priority sorting,
pattern retrieval, and formatting for prompts.
"""

import pytest

from design_reviewer.foundation.pattern_library import PatternLibrary
from design_reviewer.foundation.exceptions import PatternFileNotFoundError


# Pattern data for 15 patterns across 5 categories (3 each)
PATTERN_DATA = {
    "layered-architecture": ("Layered Architecture", "System Architecture"),
    "microservices": ("Microservices", "System Architecture"),
    "event-driven": ("Event-Driven", "System Architecture"),
    "repository": ("Repository", "Data Management"),
    "cqrs": ("CQRS", "Data Management"),
    "event-sourcing": ("Event Sourcing", "Data Management"),
    "api-gateway": ("API Gateway", "Communication"),
    "message-broker": ("Message Broker", "Communication"),
    "rpc": ("RPC", "Communication"),
    "load-balancer": ("Load Balancer", "Scalability"),
    "caching": ("Caching", "Scalability"),
    "cdn": ("CDN", "Scalability"),
    "circuit-breaker": ("Circuit Breaker", "Reliability"),
    "retry": ("Retry", "Reliability"),
    "bulkhead": ("Bulkhead", "Reliability"),
}


def _pattern_content(name, category):
    """Generate pattern markdown content."""
    return f"""# {name}

## Category
{category}

## Description
Description for {name} pattern.

## When to Use
Use when you need {name} functionality.

## Example
Example usage of {name} in a real system.
"""


def _create_all_patterns(patterns_dir):
    """Create all 15 pattern files."""
    for filename in PatternLibrary.PATTERN_FILES:
        key = filename.replace(".md", "")
        name, category = PATTERN_DATA[key]
        (patterns_dir / filename).write_text(_pattern_content(name, category))


class TestPatternLibrarySingleton:
    """Test PatternLibrary singleton pattern."""

    def setup_method(self):
        """Reset singleton before each test."""
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def test_get_instance_fails_before_initialization(self):
        """Test get_instance() raises error if not initialized."""
        with pytest.raises(RuntimeError) as exc_info:
            PatternLibrary.get_instance()

        assert "not initialized" in str(exc_info.value).lower()

    def test_initialize_creates_singleton(self, tmp_path):
        """Test initialize() creates singleton instance."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)

        pl = PatternLibrary.initialize(patterns_directory=str(patterns_dir))

        assert PatternLibrary._instance is not None
        assert pl is PatternLibrary._instance

    def test_initialize_twice_raises_error(self, tmp_path):
        """Test calling initialize() twice raises RuntimeError."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)

        PatternLibrary.initialize(patterns_directory=str(patterns_dir))

        with pytest.raises(RuntimeError, match="already initialized"):
            PatternLibrary.initialize(patterns_directory=str(patterns_dir))


class TestPatternLoading:
    """Test pattern loading from markdown files."""

    def setup_method(self):
        """Reset singleton before each test."""
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def test_loads_exactly_15_patterns(self, tmp_path):
        """Test library loads exactly 15 patterns."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)

        pl = PatternLibrary.initialize(patterns_directory=str(patterns_dir))
        patterns = pl.get_all_patterns()

        assert len(patterns) == 15

    def test_raises_error_if_pattern_file_missing(self, tmp_path):
        """Test raises PatternFileNotFoundError if a pattern file is missing."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()

        # Only create first 12 pattern files
        for filename in PatternLibrary.PATTERN_FILES[:12]:
            key = filename.replace(".md", "")
            name, category = PATTERN_DATA[key]
            (patterns_dir / filename).write_text(_pattern_content(name, category))

        with pytest.raises(PatternFileNotFoundError):
            PatternLibrary.initialize(patterns_directory=str(patterns_dir))

    def test_loads_patterns_from_all_categories(self, tmp_path):
        """Test patterns from all five categories are loaded."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)

        pl = PatternLibrary.initialize(patterns_directory=str(patterns_dir))
        patterns = pl.get_all_patterns()

        pattern_categories = set(p.category for p in patterns)
        assert "System Architecture" in pattern_categories
        assert "Data Management" in pattern_categories
        assert "Communication" in pattern_categories
        assert "Scalability" in pattern_categories
        assert "Reliability" in pattern_categories


class TestMarkdownParsing:
    """Test markdown parsing to extract pattern fields."""

    def setup_method(self):
        """Reset singleton before each test."""
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def _init_with_custom_content(self, tmp_path, content):
        """Initialize with same custom content for all patterns."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        for filename in PatternLibrary.PATTERN_FILES:
            (patterns_dir / filename).write_text(content)
        return PatternLibrary.initialize(patterns_directory=str(patterns_dir))

    def test_parses_pattern_name_from_h1(self, tmp_path):
        """Test pattern name is extracted from H1 heading."""
        content = """# Circuit Breaker

## Category
Reliability

## Description
Prevents cascading failures

## When to Use
Use when calling remote services

## Example
Payment service with circuit breaker
"""
        pl = self._init_with_custom_content(tmp_path, content)
        pattern = pl.get_all_patterns()[0]

        assert pattern.name == "Circuit Breaker"

    def test_parses_category_from_section(self, tmp_path):
        """Test category is extracted from ## Category section."""
        content = """# Test Pattern

## Category
Data Management

## Description
Test description

## When to Use
Test when to use

## Example
Test example
"""
        pl = self._init_with_custom_content(tmp_path, content)
        pattern = pl.get_all_patterns()[0]

        assert pattern.category == "Data Management"

    def test_parses_description_from_section(self, tmp_path):
        """Test description is extracted from ## Description section."""
        content = """# Test Pattern

## Category
System Architecture

## Description
This is a detailed description of the pattern.

## When to Use
Test when to use

## Example
Test example
"""
        pl = self._init_with_custom_content(tmp_path, content)
        pattern = pl.get_all_patterns()[0]

        assert "detailed description" in pattern.description

    def test_parses_when_to_use_from_section(self, tmp_path):
        """Test when_to_use is extracted from ## When to Use section."""
        content = """# Test Pattern

## Category
System Architecture

## Description
Test description

## When to Use
Use this pattern when you need to handle complex scenarios.

## Example
Test example
"""
        pl = self._init_with_custom_content(tmp_path, content)
        pattern = pl.get_all_patterns()[0]

        assert "complex scenarios" in pattern.when_to_use

    def test_parses_example_from_section(self, tmp_path):
        """Test example is extracted from ## Example section."""
        content = """# Test Pattern

## Category
System Architecture

## Description
Test description

## When to Use
Test when to use

## Example
A web application with presentation, business logic, and data layers.
"""
        pl = self._init_with_custom_content(tmp_path, content)
        pattern = pl.get_all_patterns()[0]

        assert "web application" in pattern.example


class TestPrioritySorting:
    """Test priority sorting (System Architecture first, then alphabetical)."""

    def setup_method(self):
        """Reset singleton before each test."""
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def test_system_architecture_patterns_come_first(self, tmp_path):
        """Test System Architecture patterns are sorted first."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)

        pl = PatternLibrary.initialize(patterns_directory=str(patterns_dir))
        patterns = pl.get_all_patterns()

        # First patterns should be System Architecture (3 of them)
        first_three = [p.category for p in patterns[:3]]
        assert all(cat == "System Architecture" for cat in first_three)

    def test_system_architecture_patterns_sorted_alphabetically(self, tmp_path):
        """Test System Architecture patterns are sorted alphabetically among themselves."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)

        pl = PatternLibrary.initialize(patterns_directory=str(patterns_dir))
        patterns = pl.get_all_patterns()

        sys_arch_patterns = [p for p in patterns if p.category == "System Architecture"]
        assert sys_arch_patterns[0].name == "Event-Driven"
        assert sys_arch_patterns[1].name == "Layered Architecture"
        assert sys_arch_patterns[2].name == "Microservices"

    def test_non_priority_patterns_sorted_alphabetically(self, tmp_path):
        """Test non-System Architecture patterns sorted alphabetically."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)

        pl = PatternLibrary.initialize(patterns_directory=str(patterns_dir))
        patterns = pl.get_all_patterns()

        non_sys_arch = [p for p in patterns if p.category != "System Architecture"]
        names = [p.name for p in non_sys_arch]
        assert names == sorted(names)


class TestPatternRetrieval:
    """Test pattern retrieval methods."""

    def setup_method(self):
        """Reset singleton."""
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def _init_library(self, tmp_path):
        """Initialize pattern library with all patterns."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)
        self.pl = PatternLibrary.initialize(patterns_directory=str(patterns_dir))

    def test_get_all_patterns_returns_all_15(self, tmp_path):
        """Test get_all_patterns() returns all 15 patterns."""
        self._init_library(tmp_path)
        patterns = self.pl.get_all_patterns()
        assert len(patterns) == 15

    def test_get_patterns_by_category_filters_correctly(self, tmp_path):
        """Test get_patterns_by_category() returns only patterns from that category."""
        self._init_library(tmp_path)
        reliability_patterns = self.pl.get_patterns_by_category("Reliability")

        assert len(reliability_patterns) == 3
        assert all("Reliability" in p.category for p in reliability_patterns)

    def test_get_patterns_by_category_returns_empty_for_unknown_category(
        self, tmp_path
    ):
        """Test get_patterns_by_category() returns empty list for unknown category."""
        self._init_library(tmp_path)
        unknown_patterns = self.pl.get_patterns_by_category("Unknown Category")
        assert len(unknown_patterns) == 0

    def test_get_patterns_by_category_for_all_categories(self, tmp_path):
        """Test get_patterns_by_category() works for all categories."""
        self._init_library(tmp_path)
        categories = [
            "System Architecture",
            "Data Management",
            "Communication",
            "Scalability",
            "Reliability",
        ]

        for category in categories:
            patterns = self.pl.get_patterns_by_category(category)
            assert len(patterns) == 3


class TestFormatPatternsForPrompt:
    """Test format_patterns_for_prompt() method."""

    def setup_method(self):
        """Reset singleton."""
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def _init_library(self, tmp_path):
        """Initialize pattern library."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)
        self.pl = PatternLibrary.initialize(patterns_directory=str(patterns_dir))

    def test_formats_all_patterns_as_string(self, tmp_path):
        """Test format_patterns_for_prompt() returns formatted string."""
        self._init_library(tmp_path)
        formatted = self.pl.format_patterns_for_prompt()

        assert isinstance(formatted, str)
        assert len(formatted) > 0

    def test_formatted_string_includes_all_pattern_names(self, tmp_path):
        """Test formatted string includes pattern names."""
        self._init_library(tmp_path)
        formatted = self.pl.format_patterns_for_prompt()

        assert "Layered Architecture" in formatted
        assert "Microservices" in formatted

    def test_formatted_string_includes_categories(self, tmp_path):
        """Test formatted string includes category information."""
        self._init_library(tmp_path)
        formatted = self.pl.format_patterns_for_prompt()

        assert "System Architecture" in formatted
        assert "Reliability" in formatted

    def test_formatted_string_includes_descriptions(self, tmp_path):
        """Test formatted string includes pattern descriptions."""
        self._init_library(tmp_path)
        formatted = self.pl.format_patterns_for_prompt()

        assert "Description" in formatted or "description" in formatted.lower()

    def test_formatted_string_is_ai_readable(self, tmp_path):
        """Test formatted string is structured for AI consumption."""
        self._init_library(tmp_path)
        formatted = self.pl.format_patterns_for_prompt()

        has_structure = any(
            [
                "\n\n" in formatted,
                "##" in formatted,
                "-" in formatted,
                "1." in formatted,
            ]
        )
        assert has_structure


class TestFileValidation:
    """Test FileValidator integration."""

    def setup_method(self):
        """Reset singleton before each test."""
        PatternLibrary._instance = None
        PatternLibrary._patterns = []

    def test_uses_file_validator_for_each_file(self, tmp_path):
        """Test FileValidator is used to validate each pattern file."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)

        from unittest.mock import patch

        with patch(
            "design_reviewer.foundation.pattern_library.FileValidator.validate_file"
        ) as mock_validator:
            mock_validator.return_value = _pattern_content(
                "Test", "System Architecture"
            )
            PatternLibrary.initialize(patterns_directory=str(patterns_dir))

            assert mock_validator.call_count == 15

    def test_propagates_file_validation_errors(self, tmp_path):
        """Test file validation errors are propagated."""
        patterns_dir = tmp_path / "patterns"
        patterns_dir.mkdir()
        _create_all_patterns(patterns_dir)

        from unittest.mock import patch

        with patch(
            "design_reviewer.foundation.pattern_library.FileValidator.validate_file"
        ) as mock_validator:
            mock_validator.side_effect = FileNotFoundError("Pattern file not found")

            with pytest.raises(FileNotFoundError):
                PatternLibrary.initialize(patterns_directory=str(patterns_dir))
