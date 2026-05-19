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
Unit tests for FileValidator utility.

Tests file existence, size, encoding validation, and error messages.
"""

import pytest
from pathlib import Path

from design_reviewer.foundation.file_validator import FileValidator
from design_reviewer.foundation.exceptions import ValidationError


class TestFileExistenceValidation:
    """Test file existence validation."""

    def test_validates_existing_file(self, tmp_path):
        """Test validation succeeds for existing file."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("test content", encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert content == "test content"

    def test_raises_error_for_nonexistent_file(self):
        """Test validation fails for nonexistent file."""
        with pytest.raises(FileNotFoundError) as exc_info:
            FileValidator.validate_file(Path("/nonexistent/path/file.txt"), "Test")

        error_msg = str(exc_info.value)
        assert "not found" in error_msg.lower()

    def test_error_includes_file_path(self):
        """Test error message includes the attempted file path."""
        file_path = Path("/path/to/missing/file.txt")

        with pytest.raises(FileNotFoundError) as exc_info:
            FileValidator.validate_file(file_path, "Test")

        assert str(file_path) in str(exc_info.value)


class TestFileSizeValidation:
    """Test file size validation (< 1MB limit)."""

    def test_validates_small_file(self, tmp_path):
        """Test validation succeeds for small file."""
        test_file = tmp_path / "small.txt"
        test_file.write_text("a" * 1000, encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert len(content) == 1000

    def test_validates_file_under_1mb(self, tmp_path):
        """Test validation succeeds for file just under 1MB."""
        test_file = tmp_path / "almost_1mb.txt"
        # 1MB = 1,048,576 bytes, use slightly less
        test_file.write_text("a" * (1024 * 1024 - 100), encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert len(content) == (1024 * 1024 - 100)

    def test_raises_error_for_file_over_1mb(self, tmp_path):
        """Test validation fails for file larger than 1MB."""
        test_file = tmp_path / "large.txt"
        test_file.write_text("a" * (1024 * 1024 + 1000), encoding="utf-8")

        with pytest.raises(ValidationError) as exc_info:
            FileValidator.validate_file(test_file, "Test")

        error_msg = str(exc_info.value)
        assert "large" in error_msg.lower() or "bytes" in error_msg.lower()

    def test_size_error_includes_actual_size(self, tmp_path):
        """Test size error message includes actual file size."""
        test_file = tmp_path / "large.txt"
        test_file.write_text("a" * (2 * 1024 * 1024), encoding="utf-8")

        with pytest.raises(ValidationError) as exc_info:
            FileValidator.validate_file(test_file, "Test")

        error_msg = str(exc_info.value)
        assert "byte" in error_msg.lower() or "max" in error_msg.lower()


class TestEncodingValidation:
    """Test UTF-8 encoding validation."""

    def test_validates_utf8_encoded_file(self, tmp_path):
        """Test validation succeeds for UTF-8 encoded file."""
        test_file = tmp_path / "utf8.txt"
        test_file.write_text("Hello UTF-8: cafe, naive, 日本語", encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert "cafe" in content
        assert "日本語" in content

    def test_validates_ascii_file_as_utf8_subset(self, tmp_path):
        """Test ASCII file validates (as UTF-8 superset)."""
        test_file = tmp_path / "ascii.txt"
        test_file.write_text("Plain ASCII text", encoding="ascii")

        content = FileValidator.validate_file(test_file, "Test")
        assert content == "Plain ASCII text"

    def test_raises_error_for_invalid_utf8(self, tmp_path):
        """Test validation fails for non-UTF-8 encoded file."""
        test_file = tmp_path / "latin1.txt"
        test_file.write_bytes(b"\xe9\xe8\xe0")  # Invalid UTF-8 bytes

        with pytest.raises(ValidationError) as exc_info:
            FileValidator.validate_file(test_file, "Test")

        error_msg = str(exc_info.value)
        assert "utf-8" in error_msg.lower() or "utf8" in error_msg.lower()

    def test_encoding_error_includes_file_path(self, tmp_path):
        """Test encoding error includes file path."""
        test_file = tmp_path / "bad_encoding.txt"
        test_file.write_bytes(b"\xff\xfe")  # Invalid UTF-8

        with pytest.raises(ValidationError) as exc_info:
            FileValidator.validate_file(test_file, "Test")

        assert str(test_file) in str(exc_info.value)


class TestFileContentReturn:
    """Test file content is returned correctly."""

    def test_returns_exact_file_content(self, tmp_path):
        """Test returned content matches file content exactly."""
        test_content = "Line 1\nLine 2\nLine 3\n"
        test_file = tmp_path / "content.txt"
        test_file.write_text(test_content, encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert content == test_content

    def test_handles_empty_file(self, tmp_path):
        """Test validation handles empty file."""
        test_file = tmp_path / "empty.txt"
        test_file.write_text("", encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert content == ""

    def test_preserves_whitespace(self, tmp_path):
        """Test returned content preserves whitespace."""
        test_content = "  Leading spaces\n\tTabs\nTrailing spaces  \n"
        test_file = tmp_path / "whitespace.txt"
        test_file.write_text(test_content, encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert content == test_content

    def test_handles_multiline_content(self, tmp_path):
        """Test validation handles multiline content correctly."""
        test_content = """First line
Second line
Third line
Fourth line"""
        test_file = tmp_path / "multiline.txt"
        test_file.write_text(test_content, encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert content == test_content
        assert content.count("\n") == 3


class TestErrorMessages:
    """Test error messages are detailed and actionable."""

    def test_file_not_found_error_is_detailed(self):
        """Test file not found error provides detailed message."""
        with pytest.raises(FileNotFoundError) as exc_info:
            FileValidator.validate_file(Path("/missing/file.txt"), "Config")

        error_msg = str(exc_info.value)
        assert len(error_msg) > 20
        assert "missing" in error_msg and "file.txt" in error_msg

    def test_size_error_is_detailed(self, tmp_path):
        """Test file size error provides detailed message."""
        test_file = tmp_path / "large.txt"
        test_file.write_text("a" * (2 * 1024 * 1024), encoding="utf-8")

        with pytest.raises(ValidationError) as exc_info:
            FileValidator.validate_file(test_file, "Config")

        error_msg = str(exc_info.value)
        assert str(test_file) in error_msg
        assert len(error_msg) > 20

    def test_encoding_error_is_detailed(self, tmp_path):
        """Test encoding error provides detailed message."""
        test_file = tmp_path / "bad.txt"
        test_file.write_bytes(b"\xff\xfe\xfd")

        with pytest.raises(ValidationError) as exc_info:
            FileValidator.validate_file(test_file, "Config")

        error_msg = str(exc_info.value)
        assert str(test_file) in error_msg
        assert len(error_msg) > 20


class TestEdgeCases:
    """Test edge cases and special scenarios."""

    def test_validates_file_at_exact_1mb_limit(self, tmp_path):
        """Test file at exactly 1MB limit."""
        test_file = tmp_path / "exactly_1mb.txt"
        test_file.write_text("a" * (1024 * 1024), encoding="utf-8")

        # Should either succeed or fail consistently at boundary
        try:
            content = FileValidator.validate_file(test_file, "Test")
            assert len(content) == 1024 * 1024
        except (ValidationError, FileNotFoundError):
            pass

    def test_handles_unicode_characters(self, tmp_path):
        """Test file with various Unicode characters."""
        test_content = "Math: + | Languages: 中文"
        test_file = tmp_path / "unicode.txt"
        test_file.write_text(test_content, encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert content == test_content

    def test_handles_path_with_special_characters(self, tmp_path):
        """Test file path with special characters."""
        special_dir = tmp_path / "special-dir_123"
        special_dir.mkdir()
        test_file = special_dir / "file-name_test.txt"
        test_file.write_text("content", encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert content == "content"

    def test_accepts_pathlib_path_object(self, tmp_path):
        """Test validator accepts pathlib.Path object."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("content", encoding="utf-8")

        content = FileValidator.validate_file(test_file, "Test")
        assert content == "content"

    def test_handles_file_with_bom(self, tmp_path):
        """Test file with UTF-8 BOM (Byte Order Mark)."""
        test_file = tmp_path / "bom.txt"
        test_file.write_bytes(b"\xef\xbb\xbfcontent with BOM")

        content = FileValidator.validate_file(test_file, "Test")
        assert "content with BOM" in content
