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
Unit tests for PromptManager singleton.

Tests singleton pattern, prompt loading, version selection, YAML parsing,
dynamic marker extraction, and prompt building.
"""

import pytest

from design_reviewer.foundation.prompt_manager import PromptManager
from design_reviewer.foundation.exceptions import (
    PromptFileNotFoundError,
    PromptParseError,
)


def _create_prompt_files(prompts_dir, agents=None, versions=None, contents=None):
    """Helper to create prompt files in a directory.

    Args:
        prompts_dir: Directory to create files in
        agents: Dict of agent_name -> content, or None for defaults
        versions: Dict of agent_name -> list of versions, or None for [1]
        contents: Dict of agent_name -> content override
    """
    if agents is None:
        agents = {
            "critique": "Critique prompt",
            "alternatives": "Alternatives prompt",
            "gap": "Gap prompt",
        }
    if versions is None:
        versions = {agent: [1] for agent in agents}

    for agent, content in agents.items():
        for v in versions.get(agent, [1]):
            actual_content = content
            if contents and agent in contents:
                actual_content = contents[agent]
            (prompts_dir / f"{agent}-v{v}.md").write_text(actual_content)


class TestPromptManagerSingleton:
    """Test PromptManager singleton pattern."""

    def setup_method(self):
        """Reset singleton before each test."""
        PromptManager._instance = None
        PromptManager._prompts = {}

    def test_get_instance_fails_before_initialization(self):
        """Test get_instance() raises error if not initialized."""
        with pytest.raises(RuntimeError) as exc_info:
            PromptManager.get_instance()

        assert "not initialized" in str(exc_info.value).lower()

    def test_initialize_creates_singleton(self, tmp_path):
        """Test initialize() creates singleton instance."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()
        _create_prompt_files(prompts_dir)

        pm = PromptManager.initialize(prompts_directory=str(prompts_dir))

        assert PromptManager._instance is not None
        assert pm is PromptManager._instance

    def test_initialize_twice_raises_error(self, tmp_path):
        """Test calling initialize() twice raises RuntimeError."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()
        _create_prompt_files(prompts_dir)

        PromptManager.initialize(prompts_directory=str(prompts_dir))

        with pytest.raises(RuntimeError, match="already initialized"):
            PromptManager.initialize(prompts_directory=str(prompts_dir))


class TestPromptLoading:
    """Test prompt loading from markdown files."""

    def setup_method(self):
        """Reset singleton before each test."""
        PromptManager._instance = None
        PromptManager._prompts = {}

    def test_loads_all_required_agents(self, tmp_path):
        """Test loading prompts for all required agents (critique, alternatives, gap)."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()
        _create_prompt_files(prompts_dir)

        pm = PromptManager.initialize(prompts_directory=str(prompts_dir))

        assert pm.get_prompt("critique") is not None
        assert pm.get_prompt("alternatives") is not None
        assert pm.get_prompt("gap") is not None

    def test_raises_error_if_required_agent_missing(self, tmp_path):
        """Test raises error if required agent prompt is missing."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()
        # Only create critique and alternatives, missing gap
        (prompts_dir / "critique-v1.md").write_text("Critique prompt")
        (prompts_dir / "alternatives-v1.md").write_text("Alternatives prompt")

        with pytest.raises(PromptFileNotFoundError):
            PromptManager.initialize(prompts_directory=str(prompts_dir))

    def test_loads_prompt_content(self, tmp_path):
        """Test prompt content is loaded correctly."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()
        _create_prompt_files(
            prompts_dir,
            contents={
                "critique": "Critique system prompt content",
                "alternatives": "Alternatives system prompt content",
                "gap": "Gap system prompt content",
            },
        )

        pm = PromptManager.initialize(prompts_directory=str(prompts_dir))
        critique_prompt = pm.get_prompt("critique")

        assert "Critique system prompt content" in critique_prompt.system_prompt


class TestVersionSelection:
    """Test latest version selection (find highest vN)."""

    def setup_method(self):
        """Reset singleton before each test."""
        PromptManager._instance = None
        PromptManager._prompts = {}

    def test_selects_highest_version_number(self, tmp_path):
        """Test selects latest version when multiple versions exist."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        # Create multiple versions for critique
        (prompts_dir / "critique-v1.md").write_text("Critique v1")
        (prompts_dir / "critique-v2.md").write_text("Critique v2")
        (prompts_dir / "critique-v3.md").write_text("Critique v3")
        (prompts_dir / "alternatives-v1.md").write_text("Alternatives v1")
        (prompts_dir / "gap-v1.md").write_text("Gap v1")

        pm = PromptManager.initialize(prompts_directory=str(prompts_dir))
        critique_prompt = pm.get_prompt("critique")

        assert critique_prompt.version == 3

    def test_each_agent_independent_version(self, tmp_path):
        """Test each agent has independent version numbering."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        # Different versions per agent
        for v in range(1, 6):
            (prompts_dir / f"critique-v{v}.md").write_text(f"Critique v{v}")
        for v in range(1, 3):
            (prompts_dir / f"alternatives-v{v}.md").write_text(f"Alternatives v{v}")
        (prompts_dir / "gap-v1.md").write_text("Gap v1")

        pm = PromptManager.initialize(prompts_directory=str(prompts_dir))

        assert pm.get_prompt("critique").version == 5
        assert pm.get_prompt("alternatives").version == 2
        assert pm.get_prompt("gap").version == 1


class TestYAMLFrontmatterParsing:
    """Test YAML frontmatter parsing."""

    def setup_method(self):
        """Reset singleton before each test."""
        PromptManager._instance = None
        PromptManager._prompts = {}

    def test_parses_yaml_frontmatter(self, tmp_path):
        """Test YAML frontmatter is parsed correctly."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        prompt_with_frontmatter = """---
agent: critique
version: 1
author: Design Reviewer Team
created_date: "2026-03-10"
description: System prompt for critique agent
tags:
  - critique
  - design-review
---
# Critique Agent

You are an expert architect."""

        (prompts_dir / "critique-v1.md").write_text(prompt_with_frontmatter)
        (prompts_dir / "alternatives-v1.md").write_text("Alternatives prompt")
        (prompts_dir / "gap-v1.md").write_text("Gap prompt")

        pm = PromptManager.initialize(prompts_directory=str(prompts_dir))
        critique_prompt = pm.get_prompt("critique")

        assert critique_prompt.metadata is not None
        assert critique_prompt.metadata.author == "Design Reviewer Team"
        assert (
            critique_prompt.metadata.description == "System prompt for critique agent"
        )

    def test_handles_prompt_without_frontmatter(self, tmp_path):
        """Test prompts without YAML frontmatter are handled."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        prompt_without_frontmatter = "# Critique Agent\n\nYou are an expert architect."

        (prompts_dir / "critique-v1.md").write_text(prompt_without_frontmatter)
        (prompts_dir / "alternatives-v1.md").write_text("Alternatives prompt")
        (prompts_dir / "gap-v1.md").write_text("Gap prompt")

        pm = PromptManager.initialize(prompts_directory=str(prompts_dir))
        critique_prompt = pm.get_prompt("critique")

        assert critique_prompt.system_prompt == prompt_without_frontmatter

    def test_raises_error_on_invalid_yaml(self, tmp_path):
        """Test raises error for invalid YAML frontmatter."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        invalid_yaml_prompt = """---
invalid: yaml: syntax: [unclosed
---
Prompt content"""

        (prompts_dir / "critique-v1.md").write_text(invalid_yaml_prompt)
        (prompts_dir / "alternatives-v1.md").write_text("Alternatives prompt")
        (prompts_dir / "gap-v1.md").write_text("Gap prompt")

        with pytest.raises(PromptParseError):
            PromptManager.initialize(prompts_directory=str(prompts_dir))


class TestDynamicMarkerExtraction:
    """Test dynamic content marker extraction."""

    def setup_method(self):
        """Reset singleton before each test."""
        PromptManager._instance = None
        PromptManager._prompts = {}

    def test_extracts_dynamic_markers(self, tmp_path):
        """Test dynamic markers are extracted from prompt."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        prompt_with_markers = """# Critique Agent

## Design Document
<!-- INSERT: design_document -->

## Patterns
<!-- INSERT: patterns -->

## Settings
<!-- INSERT: severity_threshold -->"""

        (prompts_dir / "critique-v1.md").write_text(prompt_with_markers)
        (prompts_dir / "alternatives-v1.md").write_text("Alternatives")
        (prompts_dir / "gap-v1.md").write_text("Gap")

        pm = PromptManager.initialize(prompts_directory=str(prompts_dir))
        critique_prompt = pm.get_prompt("critique")

        assert "design_document" in critique_prompt.dynamic_markers
        assert "patterns" in critique_prompt.dynamic_markers
        assert "severity_threshold" in critique_prompt.dynamic_markers

    def test_handles_prompt_without_markers(self, tmp_path):
        """Test prompts without dynamic markers are handled."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        (prompts_dir / "critique-v1.md").write_text("Static prompt with no markers")
        (prompts_dir / "alternatives-v1.md").write_text("Alternatives")
        (prompts_dir / "gap-v1.md").write_text("Gap")

        pm = PromptManager.initialize(prompts_directory=str(prompts_dir))
        critique_prompt = pm.get_prompt("critique")

        assert critique_prompt.dynamic_markers == []


class TestBuildAgentPrompt:
    """Test build_agent_prompt() method replaces markers with context."""

    def setup_method(self):
        """Reset singleton and initialize with test prompts."""
        PromptManager._instance = None
        PromptManager._prompts = {}

    def _init_with_markers(self, tmp_path):
        """Initialize PromptManager with marker-containing prompts."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()

        self.prompt_with_markers = """# Critique Agent

Design Document:
<!-- INSERT: design_document -->

Available Patterns:
<!-- INSERT: patterns -->"""

        (prompts_dir / "critique-v1.md").write_text(self.prompt_with_markers)
        (prompts_dir / "alternatives-v1.md").write_text("Alternatives")
        (prompts_dir / "gap-v1.md").write_text("Gap")

        self.pm = PromptManager.initialize(prompts_directory=str(prompts_dir))

    def test_replaces_dynamic_markers_with_context(self, tmp_path):
        """Test dynamic markers are replaced with context values."""
        self._init_with_markers(tmp_path)

        context = {
            "design_document": "This is the design document content",
            "patterns": "Pattern 1\nPattern 2\nPattern 3",
        }

        built_prompt = self.pm.build_agent_prompt("critique", context)

        assert "This is the design document content" in built_prompt
        assert "Pattern 1\nPattern 2\nPattern 3" in built_prompt
        assert "<!-- INSERT: design_document -->" not in built_prompt
        assert "<!-- INSERT: patterns -->" not in built_prompt

    def test_handles_missing_context_values(self, tmp_path):
        """Test handling when context doesn't provide all markers."""
        self._init_with_markers(tmp_path)

        context = {
            "design_document": "Design content",
            # Missing "patterns"
        }

        built_prompt = self.pm.build_agent_prompt("critique", context)

        assert "Design content" in built_prompt

    def test_preserves_non_marker_content(self, tmp_path):
        """Test non-marker content is preserved."""
        self._init_with_markers(tmp_path)

        context = {
            "design_document": "Design",
            "patterns": "Patterns",
        }

        built_prompt = self.pm.build_agent_prompt("critique", context)

        assert "# Critique Agent" in built_prompt
        assert "Design Document:" in built_prompt
        assert "Available Patterns:" in built_prompt

    def test_empty_context_returns_original_prompt(self, tmp_path):
        """Test empty context returns original prompt with markers."""
        self._init_with_markers(tmp_path)

        built_prompt = self.pm.build_agent_prompt("critique", {})

        assert "# Critique Agent" in built_prompt

    def test_adds_security_delimiters_to_design_document(self, tmp_path):
        """Test security delimiters are added around design_document content."""
        self._init_with_markers(tmp_path)

        context = {
            "design_document": "User provided design content",
            "patterns": "Pattern content",
        }

        built_prompt = self.pm.build_agent_prompt("critique", context)

        # Verify delimiters are present
        assert "<!-- DESIGN DOCUMENT START -->" in built_prompt
        assert "<!-- DESIGN DOCUMENT END -->" in built_prompt

        # Verify content is wrapped
        assert (
            "<!-- DESIGN DOCUMENT START -->\nUser provided design content\n<!-- DESIGN DOCUMENT END -->"
            in built_prompt
        )

    def test_security_delimiters_not_added_to_other_markers(self, tmp_path):
        """Test security delimiters are only added to design_document, not other markers."""
        self._init_with_markers(tmp_path)

        context = {
            "design_document": "Design",
            "patterns": "Patterns",
        }

        built_prompt = self.pm.build_agent_prompt("critique", context)

        # Check patterns marker doesn't have delimiters
        assert "<!-- DESIGN DOCUMENT START -->" not in built_prompt.split(
            "Available Patterns:"
        )[1]
        # But design_document does
        assert "<!-- DESIGN DOCUMENT START -->" in built_prompt.split(
            "Design Document:"
        )[1]


class TestGetPromptMethod:
    """Test get_prompt() method."""

    def setup_method(self):
        """Reset singleton."""
        PromptManager._instance = None
        PromptManager._prompts = {}

    def _init_prompts(self, tmp_path):
        """Initialize PromptManager with test prompts."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()
        _create_prompt_files(prompts_dir)
        self.pm = PromptManager.initialize(prompts_directory=str(prompts_dir))

    def test_returns_prompt_data_for_valid_agent(self, tmp_path):
        """Test get_prompt() returns PromptData for valid agent."""
        self._init_prompts(tmp_path)

        prompt = self.pm.get_prompt("critique")
        assert prompt is not None
        assert prompt.agent_name == "critique"

    def test_raises_error_for_unknown_agent(self, tmp_path):
        """Test get_prompt() raises error for unknown agent."""
        self._init_prompts(tmp_path)

        with pytest.raises(KeyError):
            self.pm.get_prompt("unknown_agent")

    def test_cached_prompts_reused(self, tmp_path):
        """Test prompts are cached and reused on subsequent calls."""
        self._init_prompts(tmp_path)

        prompt1 = self.pm.get_prompt("critique")
        prompt2 = self.pm.get_prompt("critique")

        assert prompt1 is prompt2


class TestFileValidation:
    """Test FileValidator integration."""

    def setup_method(self):
        """Reset singleton before each test."""
        PromptManager._instance = None
        PromptManager._prompts = {}

    def test_uses_file_validator_for_each_file(self, tmp_path):
        """Test FileValidator is used to validate each prompt file."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()
        _create_prompt_files(prompts_dir)

        from unittest.mock import patch

        with patch(
            "design_reviewer.foundation.prompt_manager.FileValidator.validate_file"
        ) as mock_validator:
            mock_validator.side_effect = ["Critique", "Alternatives", "Gap"]
            PromptManager.initialize(prompts_directory=str(prompts_dir))

            assert mock_validator.call_count == 3

    def test_propagates_file_validation_errors(self, tmp_path):
        """Test file validation errors are propagated."""
        prompts_dir = tmp_path / "prompts"
        prompts_dir.mkdir()
        _create_prompt_files(prompts_dir)

        from unittest.mock import patch

        with patch(
            "design_reviewer.foundation.prompt_manager.FileValidator.validate_file"
        ) as mock_validator:
            mock_validator.side_effect = FileNotFoundError("File not found")

            with pytest.raises((PromptParseError, FileNotFoundError)):
                PromptManager.initialize(prompts_directory=str(prompts_dir))
