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
File validation utility for safe file loading.

Validates file existence, size, and encoding before loading.
"""

from pathlib import Path

from .exceptions import ValidationError


class FileValidator:
    """Utility for validating files before loading."""

    MAX_FILE_SIZE = 1024 * 1024  # 1MB
    ALLOWED_ENCODING = "utf-8"

    @staticmethod
    def validate_file(file_path: Path, file_type: str) -> str:
        """
        Validate file and return contents.

        Args:
            file_path: Path to file
            file_type: Type description for error messages (e.g., "Prompt", "Pattern")

        Returns:
            File contents as string

        Raises:
            FileNotFoundError: File doesn't exist
            ValidationError: File too large or not UTF-8
        """
        # 1. Check existence
        if not file_path.exists():
            raise FileNotFoundError(
                f"{file_type} file not found: {file_path}\n"
                f"Suggested Fix: Verify file exists at expected location."
            )

        # 2. Check size
        file_size = file_path.stat().st_size
        if file_size > FileValidator.MAX_FILE_SIZE:
            raise ValidationError(
                f"{file_type} file too large: {file_size} bytes (max: {FileValidator.MAX_FILE_SIZE})\n"
                f"File: {file_path}\n"
                f"Suggested Fix: Check if file is correct. {file_type} files should be < 100KB.",
                suggested_fix=f"Verify {file_path} is the correct file",
            )

        # 3. Validate UTF-8 encoding
        try:
            content = file_path.read_text(encoding=FileValidator.ALLOWED_ENCODING)
        except UnicodeDecodeError as e:
            raise ValidationError(
                f"{file_type} file is not valid UTF-8: {file_path}\nError: {e}",
                suggested_fix="Verify file is saved as UTF-8 text",
            ) from e

        return content
