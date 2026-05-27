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
Unit tests for prompt data models.

Tests PromptMetadata and PromptData Pydantic models.
"""

import pytest
from pydantic import ValidationError

from design_reviewer.foundation.prompt_models import PromptMetadata, PromptData


class TestPromptMetadata:
    """Test PromptMetadata model."""

    def test_valid_metadata_with_all_fields(self):
        """Test valid metadata with all fields populated."""
        metadata = PromptMetadata(
            author="Design Reviewer Team",
            created_date="2026-03-10",
            updated_date="2026-03-10",
            description="System prompt for critique agent",
            tags=["critique", "design-review"],
        )

        assert metadata.author == "Design Reviewer Team"
        assert metadata.created_date == "2026-03-10"
        assert metadata.updated_date == "2026-03-10"
        assert metadata.description == "System prompt for critique agent"
        assert metadata.tags == ["critique", "design-review"]

    def test_metadata_all_fields_optional(self):
        """Test all metadata fields are optional."""
        metadata = PromptMetadata()

        assert metadata.author is None
        assert metadata.created_date is None
        assert metadata.updated_date is None
        assert metadata.description is None
        assert metadata.tags is None or metadata.tags == []

    def test_metadata_partial_fields(self):
        """Test metadata with only some fields."""
        metadata = PromptMetadata(
            author="Test Author",
            description="Test description",
        )

        assert metadata.author == "Test Author"
        assert metadata.description == "Test description"
        assert metadata.created_date is None

    def test_metadata_tags_as_list(self):
        """Test metadata accepts tags as list."""
        metadata = PromptMetadata(
            tags=["tag1", "tag2", "tag3"],
        )

        assert len(metadata.tags) == 3
        assert "tag1" in metadata.tags

    def test_metadata_empty_tags_list(self):
        """Test metadata with empty tags list."""
        metadata = PromptMetadata(tags=[])

        assert metadata.tags == []

    def test_metadata_accepts_various_date_formats(self):
        """Test metadata accepts various date string formats."""
        metadata1 = PromptMetadata(created_date="2026-03-10")
        assert metadata1.created_date == "2026-03-10"

        metadata2 = PromptMetadata(created_date="2026-03-10T14:30:00Z")
        assert metadata2.created_date == "2026-03-10T14:30:00Z"


class TestPromptData:
    """Test PromptData model."""

    def test_valid_prompt_data_with_all_fields(self):
        """Test valid PromptData with all fields."""
        metadata = PromptMetadata(author="Test Author")
        prompt_data = PromptData(
            agent_name="critique",
            version=1,
            file_path="/config/prompts/critique-v1.md",
            system_prompt="You are an expert architect...",
            dynamic_markers=["design_document", "patterns"],
            metadata=metadata,
        )

        assert prompt_data.agent_name == "critique"
        assert prompt_data.version == 1
        assert prompt_data.file_path == "/config/prompts/critique-v1.md"
        assert prompt_data.system_prompt.startswith("You are an expert")
        assert "design_document" in prompt_data.dynamic_markers
        assert prompt_data.metadata.author == "Test Author"

    def test_prompt_data_required_fields(self):
        """Test required fields in PromptData."""
        with pytest.raises(ValidationError):
            PromptData()

    def test_agent_name_is_required(self):
        """Test agent_name is required."""
        with pytest.raises(ValidationError) as exc_info:
            PromptData(
                version=1,
                file_path="/path/to/prompt.md",
                system_prompt="Test prompt",
                dynamic_markers=[],
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("agent_name",) for error in errors)

    def test_version_is_required(self):
        """Test version is required."""
        with pytest.raises(ValidationError) as exc_info:
            PromptData(
                agent_name="critique",
                file_path="/path/to/prompt.md",
                system_prompt="Test prompt",
                dynamic_markers=[],
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("version",) for error in errors)

    def test_file_path_is_required(self):
        """Test file_path is required."""
        with pytest.raises(ValidationError) as exc_info:
            PromptData(
                agent_name="critique",
                version=1,
                system_prompt="Test prompt",
                dynamic_markers=[],
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("file_path",) for error in errors)

    def test_system_prompt_is_required(self):
        """Test system_prompt is required."""
        with pytest.raises(ValidationError) as exc_info:
            PromptData(
                agent_name="critique",
                version=1,
                file_path="/path/to/prompt.md",
                dynamic_markers=[],
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("system_prompt",) for error in errors)

    def test_dynamic_markers_is_required(self):
        """Test dynamic_markers is a required field."""
        with pytest.raises(ValidationError) as exc_info:
            PromptData(
                agent_name="critique",
                version=1,
                file_path="/path/to/prompt.md",
                system_prompt="Test prompt",
            )

        errors = exc_info.value.errors()
        assert any(error["loc"] == ("dynamic_markers",) for error in errors)

    def test_metadata_optional(self):
        """Test metadata is optional."""
        prompt_data = PromptData(
            agent_name="critique",
            version=1,
            file_path="/path/to/prompt.md",
            system_prompt="Test prompt",
            dynamic_markers=[],
        )

        assert prompt_data.metadata is None

    def test_version_must_be_integer(self):
        """Test version must be an integer."""
        with pytest.raises(ValidationError):
            PromptData(
                agent_name="critique",
                version="one",
                file_path="/path/to/prompt.md",
                system_prompt="Test prompt",
                dynamic_markers=[],
            )

    def test_dynamic_markers_as_list(self):
        """Test dynamic_markers is stored as list."""
        prompt_data = PromptData(
            agent_name="critique",
            version=1,
            file_path="/path/to/prompt.md",
            system_prompt="Test prompt",
            dynamic_markers=["marker1", "marker2"],
        )

        assert isinstance(prompt_data.dynamic_markers, list)
        assert len(prompt_data.dynamic_markers) == 2

    def test_empty_dynamic_markers_list(self):
        """Test empty dynamic_markers list."""
        prompt_data = PromptData(
            agent_name="critique",
            version=1,
            file_path="/path/to/prompt.md",
            system_prompt="Test prompt",
            dynamic_markers=[],
        )

        assert prompt_data.dynamic_markers == []

    def test_system_prompt_can_be_long(self):
        """Test system_prompt can contain long text."""
        long_prompt = "You are an expert architect.\n" * 100
        prompt_data = PromptData(
            agent_name="critique",
            version=1,
            file_path="/path/to/prompt.md",
            system_prompt=long_prompt,
            dynamic_markers=[],
        )

        assert len(prompt_data.system_prompt) > 1000


class TestPromptDataWithMetadata:
    """Test PromptData with nested PromptMetadata."""

    def test_creates_with_metadata_object(self):
        """Test creating PromptData with PromptMetadata object."""
        metadata = PromptMetadata(
            author="Design Reviewer Team",
            created_date="2026-03-10",
            description="Test prompt",
            tags=["test"],
        )

        prompt_data = PromptData(
            agent_name="critique",
            version=1,
            file_path="/path/to/prompt.md",
            system_prompt="Test prompt",
            dynamic_markers=[],
            metadata=metadata,
        )

        assert prompt_data.metadata.author == "Design Reviewer Team"
        assert prompt_data.metadata.created_date == "2026-03-10"

    def test_creates_with_metadata_dict(self):
        """Test creating PromptData with metadata as dict."""
        prompt_data = PromptData(
            agent_name="critique",
            version=1,
            file_path="/path/to/prompt.md",
            system_prompt="Test prompt",
            dynamic_markers=[],
            metadata={
                "author": "Test Author",
                "description": "Test description",
            },
        )

        assert prompt_data.metadata.author == "Test Author"
        assert prompt_data.metadata.description == "Test description"

    def test_metadata_validation_propagates(self):
        """Test validation errors in metadata propagate correctly."""
        pass  # PromptMetadata currently has no strict validation


class TestPromptDataEdgeCases:
    """Test edge cases for PromptData."""

    def test_agent_name_can_be_any_string(self):
        """Test agent_name accepts various string values."""
        for agent_name in ["critique", "alternatives", "gap", "future-agent"]:
            prompt_data = PromptData(
                agent_name=agent_name,
                version=1,
                file_path="/path/to/prompt.md",
                system_prompt="Test",
                dynamic_markers=[],
            )
            assert prompt_data.agent_name == agent_name

    def test_version_can_be_large_number(self):
        """Test version can be large version number."""
        prompt_data = PromptData(
            agent_name="critique",
            version=999,
            file_path="/path/to/prompt.md",
            system_prompt="Test",
            dynamic_markers=[],
        )

        assert prompt_data.version == 999

    def test_file_path_can_be_absolute_or_relative(self):
        """Test file_path accepts absolute or relative paths."""
        for path in [
            "/absolute/path/prompt.md",
            "relative/path/prompt.md",
            "prompt.md",
        ]:
            prompt_data = PromptData(
                agent_name="critique",
                version=1,
                file_path=path,
                system_prompt="Test",
                dynamic_markers=[],
            )
            assert prompt_data.file_path == path

    def test_system_prompt_with_special_characters(self):
        """Test system_prompt with special characters."""
        prompt_with_special = "Test <!-- INSERT: marker --> test\n# Header\n**Bold**"
        prompt_data = PromptData(
            agent_name="critique",
            version=1,
            file_path="/path/to/prompt.md",
            system_prompt=prompt_with_special,
            dynamic_markers=[],
        )

        assert "<!-- INSERT: marker -->" in prompt_data.system_prompt
        assert "**Bold**" in prompt_data.system_prompt

    def test_multiple_dynamic_markers(self):
        """Test PromptData with multiple dynamic markers."""
        markers = [
            "design_document",
            "patterns",
            "severity_threshold",
            "constraints",
            "context",
        ]
        prompt_data = PromptData(
            agent_name="critique",
            version=1,
            file_path="/path/to/prompt.md",
            system_prompt="Test",
            dynamic_markers=markers,
        )

        assert len(prompt_data.dynamic_markers) == 5
        assert all(marker in prompt_data.dynamic_markers for marker in markers)
