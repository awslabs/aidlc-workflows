"""Shell command execution tool scoped to the run folder.

Created via a factory function that binds a specific run_folder and timeout,
ensuring all command execution stays within the run boundary.

Security: All command output is scrubbed for credentials before being returned
to prevent accidental exposure of AWS keys, tokens, or other secrets.
"""

from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path

from strands import tool

from shared.credential_scrubber import scrub_credentials

_MAX_OUTPUT_CHARS = 50_000


def _resolve_safe(run_folder: Path, relative_path: str) -> Path:
    """Resolve a relative path within the run folder, preventing traversal."""
    resolved = (run_folder / relative_path).resolve()
    run_resolved = run_folder.resolve()
    if not str(resolved).startswith(str(run_resolved)):
        raise ValueError(f"Path traversal denied: {relative_path}")
    return resolved


def make_run_command(run_folder: Path, timeout: int = 120) -> object:
    """Create a run_command tool bound to a specific run folder.

    Args:
        run_folder: Absolute path to the run folder.
        timeout: Default per-command timeout in seconds.

    Returns:
        A tool-decorated function for executing shell commands.
    """
    run_folder = run_folder.resolve()

    @tool
    def run_command(command: str, working_directory: str = "workspace") -> str:
        """Execute a shell command in the run folder.

        Use this during Build and Test to install dependencies, run tests, and
        fix issues. The command runs in a shell with the working directory set
        to the specified path (default: workspace/).

        Args:
            command: The shell command to execute.
            working_directory: Directory relative to the run folder to run in (default: workspace/).
        """
        if not command or not command.strip():
            return "[error: empty command]"

        try:
            cwd = _resolve_safe(run_folder, working_directory)
        except ValueError as e:
            return f"[error: {e}]"

        if not cwd.exists():
            return f"[error: working directory not found: {working_directory}]"
        if not cwd.is_dir():
            return f"[error: not a directory: {working_directory}]"

        # Build a restricted environment: preserve PATH for tool access,
        # set HOME to run_folder to avoid reading host user config.
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(run_folder),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "TERM": "dumb",
        }
        # Propagate common tool env vars if present (needed for uv, npm, etc.)
        for var in ("UV_CACHE_DIR", "UV_PYTHON", "NODE_PATH", "NPM_CONFIG_CACHE",
                     "VIRTUAL_ENV", "PYTHONPATH"):
            val = os.environ.get(var)
            if val is not None:
                env[var] = val

        try:
            # nosec B603 - Using shlex.split with shell=False and path validated via _resolve_safe
            # nosemgrep: dangerous-subprocess-use-audit
            result = subprocess.run(
                shlex.split(command),
                shell=False,
                cwd=str(cwd),
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
            output = result.stdout + result.stderr
            # Scrub credentials before truncation to ensure redaction markers are visible
            output = scrub_credentials(output)
            if len(output) > _MAX_OUTPUT_CHARS:
                output = output[:_MAX_OUTPUT_CHARS] + "\n... (output truncated)"
            return f"[exit code: {result.returncode}]\n{output}"

        except subprocess.TimeoutExpired as e:
            partial = ""
            if e.stdout:
                partial += e.stdout if isinstance(e.stdout, str) else e.stdout.decode("utf-8", errors="replace")
            if e.stderr:
                partial += e.stderr if isinstance(e.stderr, str) else e.stderr.decode("utf-8", errors="replace")
            # Scrub credentials from partial output
            partial = scrub_credentials(partial)
            return f"[error: command timed out after {timeout}s]\n{partial}"

        except OSError as e:
            return f"[error: {e}]"

    return run_command
