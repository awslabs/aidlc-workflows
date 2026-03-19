"""File operation tools scoped to the run folder.

These tools are created via factory functions that bind a specific run_folder,
ensuring all file access stays within the run boundary.
"""

from __future__ import annotations

from pathlib import Path

from strands import tool


def _resolve_safe(run_folder: Path, relative_path: str) -> Path:
    """Resolve a relative path within the run folder, preventing traversal."""
    resolved = (run_folder / relative_path).resolve()
    run_resolved = run_folder.resolve()
    if not str(resolved).startswith(str(run_resolved)):
        raise ValueError(f"Path traversal denied: {relative_path}")
    return resolved


def make_file_tools(run_folder: Path) -> list:
    """Create file operation tools bound to a specific run folder.

    Args:
        run_folder: Absolute path to the run folder.

    Returns:
        List of tool-decorated functions: [read_file, write_file, list_files].
    """
    run_folder = run_folder.resolve()

    @tool
    def read_file(path: str) -> str:
        """Read the contents of a file in the run folder.

        Args:
            path: File path relative to the run folder (e.g. 'aidlc-docs/aidlc-state.md').
        """
        try:
            target = _resolve_safe(run_folder, path)
            if not target.exists():
                return f"Error: File not found: {path}"
            if not target.is_file():
                return f"Error: Not a file: {path}"
            return target.read_text(encoding="utf-8")
        except ValueError as e:
            return f"Error: {e}"

    @tool
    def write_file(path: str, content: str) -> str:
        """Write content to a file in the run folder. Creates parent directories if needed.

        Args:
            path: Relative to run folder (e.g. 'aidlc-docs/inception/requirements.md').
            content: The text content to write to the file.
        """
        try:
            target = _resolve_safe(run_folder, path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return f"Written: {path} ({len(content)} chars)"
        except ValueError as e:
            return f"Error: {e}"

    @tool
    def list_files(directory: str = ".") -> str:
        """List files and directories within a path in the run folder.

        Args:
            directory: Directory path relative to the run folder. Defaults to the run folder root.
        """
        try:
            target = _resolve_safe(run_folder, directory)
            if not target.exists():
                return f"Error: Directory not found: {directory}"
            if not target.is_dir():
                return f"Error: Not a directory: {directory}"
            entries = sorted(target.iterdir())
            lines = []
            for entry in entries:
                rel = entry.relative_to(run_folder)
                suffix = "/" if entry.is_dir() else ""
                lines.append(f"  {rel}{suffix}")
            if not lines:
                return f"(empty directory: {directory})"
            return "\n".join(lines)
        except ValueError as e:
            return f"Error: {e}"

    return [read_file, write_file, list_files]
