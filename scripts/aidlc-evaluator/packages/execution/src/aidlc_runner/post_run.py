"""Post-run test evaluation — detect project type, install deps, run tests."""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from shared.io import atomic_yaml_dump

from aidlc_runner.config import RunnerConfig
from shared.sandbox import is_docker_available, sandbox_run

_MAX_OUTPUT_CHARS = 10_000
_MAX_SEARCH_DEPTH = 3

# Project markers in priority order.
_PROJECT_MARKERS: list[tuple[str, str, str, str]] = [
    # (marker_file, project_type, install_cmd, test_cmd)
    ("pyproject.toml", "python", 'uv pip install -qq -e ".[dev]"', "uv run pytest --tb=short -q --no-header -o console_output_style=classic"),
    ("package.json", "node", "npm install", "npm test"),
    ("Cargo.toml", "rust", "cargo build", "cargo test"),
    ("go.mod", "go", "go build ./...", "go test ./..."),
    ("setup.py", "python-legacy", 'pip install -e ".[dev]"', "python -m pytest --tb=short -q --no-header -o console_output_style=classic"),
]

_SKIP_DIRS = frozenset({
    ".venv", "venv", ".env", "env",
    "node_modules",
    "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
    ".git", ".hg", ".svn",
    "target",  # Rust/Maven build output
    "dist", "build", ".tox", ".nox",
    ".cache",
})


@dataclass
class ProjectInfo:
    project_type: str
    install_cmd: str
    test_cmd: str
    project_root: Path


def _check_markers(directory: Path) -> ProjectInfo | None:
    """Check a single directory for project marker files."""
    for marker_file, project_type, install_cmd, test_cmd in _PROJECT_MARKERS:
        if (directory / marker_file).exists():
            return ProjectInfo(
                project_type=project_type,
                install_cmd=install_cmd,
                test_cmd=test_cmd,
                project_root=directory,
            )
    return None


def detect_project(workspace: Path) -> ProjectInfo | None:
    """Detect the project type from marker files in workspace/.

    Performs a breadth-first search starting at workspace/ and descending up
    to ``_MAX_SEARCH_DEPTH`` levels.  Hidden directories (dot-prefixed) and
    common vendor/cache directories are skipped to avoid false positives and
    slow traversal through large dependency trees.

    Returns ProjectInfo or None if no recognisable project found.
    """
    if not workspace.is_dir():
        return None

    result = _check_markers(workspace)
    if result is not None:
        return result

    # BFS through subdirectories up to _MAX_SEARCH_DEPTH levels deep.
    queue: list[tuple[Path, int]] = [(workspace, 0)]
    while queue:
        current, depth = queue.pop(0)
        if depth >= _MAX_SEARCH_DEPTH:
            continue
        try:
            children = sorted(
                p for p in current.iterdir()
                if p.is_dir() and not p.name.startswith(".") and p.name not in _SKIP_DIRS
            )
        except OSError:
            continue
        for child in children:
            result = _check_markers(child)
            if result is not None:
                return result
            queue.append((child, depth + 1))

    return None


def _truncate(text: str, limit: int = _MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n... (output truncated)"


def _run_step(
    command: str,
    cwd: Path,
    timeout: int,
    use_sandbox: bool = False,
    sandbox_image: str = "aidlc-sandbox:latest",
    sandbox_memory: str = "2g",
    sandbox_cpus: int = 2,
) -> dict[str, Any]:
    """Run a subprocess step and return structured result.

    When *use_sandbox* is ``True`` and Docker is available the command
    runs inside a container via :func:`sandbox_run`.  Otherwise it falls
    back to direct host execution (with a warning when the caller asked
    for sandboxing but Docker is absent).
    """
    if use_sandbox and is_docker_available():
        result = sandbox_run(
            command,
            workspace=cwd,
            image=sandbox_image,
            timeout=timeout,
            network=True,
            memory=sandbox_memory,
            cpus=sandbox_cpus,
        )
        output = result.stdout + result.stderr
        data: dict[str, Any] = {
            "command": command,
            "exit_code": result.exit_code,
            "success": result.exit_code == 0,
            "output": _truncate(output),
            "sandboxed": True,
        }
        if result.timed_out:
            data["timed_out"] = True
        return data

    if use_sandbox:
        print(
            "[WARN] Docker not available — running on host without sandbox",
            file=sys.stderr,
        )

    # Host execution — use shlex.split to avoid shell=True
    env = {
        k: v for k, v in os.environ.items()
        if k not in ("VIRTUAL_ENV", "CONDA_PREFIX")
    }
    env["HOME"] = str(cwd)

    try:
        # nosec B603 - Using shlex.split with shell=False, executing generated project tests
        # nosemgrep: dangerous-subprocess-use-audit
        result_proc = subprocess.run(
            shlex.split(command),
            shell=False,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        output = result_proc.stdout + result_proc.stderr
        return {
            "command": command,
            "exit_code": result_proc.returncode,
            "success": result_proc.returncode == 0,
            "output": _truncate(output),
            "sandboxed": False,
        }
    except subprocess.TimeoutExpired as e:
        partial = ""
        if e.stdout:
            partial += e.stdout if isinstance(e.stdout, str) else e.stdout.decode("utf-8", errors="replace")
        if e.stderr:
            partial += e.stderr if isinstance(e.stderr, str) else e.stderr.decode("utf-8", errors="replace")
        return {
            "command": command,
            "exit_code": None,
            "success": False,
            "output": _truncate(partial),
            "timed_out": True,
            "sandboxed": False,
        }
    except OSError as e:
        return {
            "command": command,
            "exit_code": None,
            "success": False,
            "output": str(e),
            "sandboxed": False,
        }


# ---------------------------------------------------------------------------
# Test output parsers
# ---------------------------------------------------------------------------

def _parse_pytest(output: str) -> dict[str, int | None]:
    """Parse pytest summary line like '5 passed, 2 failed, 1 error in 3.2s'."""
    results: dict[str, int | None] = {"passed": None, "failed": None, "errors": None, "skipped": None}
    # Match the final summary line
    m = re.search(r"=+\s*([\d\w\s,]+)\s+in\s+[\d.]+", output)
    if not m:
        # Try shorter form: "5 passed"
        m = re.search(r"(\d+\s+passed(?:,\s*\d+\s+\w+)*)", output)
    if m:
        summary = m.group(1) if m else ""
        for key in ("passed", "failed", "error", "skipped", "warning", "deselected"):
            count_match = re.search(rf"(\d+)\s+{key}", summary)
            if count_match:
                mapped_key = "errors" if key == "error" else key
                if mapped_key in results:
                    results[mapped_key] = int(count_match.group(1))
    return results


def _parse_jest(output: str) -> dict[str, int | None]:
    """Parse Jest/Vitest summary."""
    results: dict[str, int | None] = {"passed": None, "failed": None, "errors": None, "skipped": None}
    # Jest: "Tests:       2 failed, 5 passed, 7 total"
    m = re.search(r"Tests:\s+(.+total)", output)
    if m:
        summary = m.group(1)
        for key, mapped in [("passed", "passed"), ("failed", "failed"), ("skipped", "skipped")]:
            count_match = re.search(rf"(\d+)\s+{key}", summary)
            if count_match:
                results[mapped] = int(count_match.group(1))
        return results
    # Vitest: "Tests  5 passed | 2 failed (7)"
    m = re.search(r"Tests\s+(.+\))", output)
    if m:
        summary = m.group(1)
        for key, mapped in [("passed", "passed"), ("failed", "failed")]:
            count_match = re.search(rf"(\d+)\s+{key}", summary)
            if count_match:
                results[mapped] = int(count_match.group(1))
    return results


def _parse_cargo(output: str) -> dict[str, int | None]:
    """Parse cargo test summary like 'test result: ok. 5 passed; 0 failed; 0 ignored'."""
    results: dict[str, int | None] = {"passed": None, "failed": None, "errors": None, "skipped": None}
    m = re.search(r"test result:.*?(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored", output)
    if m:
        results["passed"] = int(m.group(1))
        results["failed"] = int(m.group(2))
        results["skipped"] = int(m.group(3))
    return results


def _parse_go(output: str) -> dict[str, int | None]:
    """Parse go test output by counting --- PASS and --- FAIL lines."""
    results: dict[str, int | None] = {"passed": None, "failed": None, "errors": None, "skipped": None}
    passed = len(re.findall(r"--- PASS:", output))
    failed = len(re.findall(r"--- FAIL:", output))
    skipped = len(re.findall(r"--- SKIP:", output))
    if passed or failed or skipped:
        results["passed"] = passed
        results["failed"] = failed
        results["skipped"] = skipped
    return results


_PARSERS = {
    "python": _parse_pytest,
    "python-legacy": _parse_pytest,
    "node": _parse_jest,
    "rust": _parse_cargo,
    "go": _parse_go,
}


def parse_test_output(project_type: str, output: str) -> dict[str, int | None]:
    """Parse test output for the given project type.

    Returns a dict with keys: passed, failed, errors, skipped.
    Values are None if parsing fails for that field.
    """
    parser = _PARSERS.get(project_type)
    if parser is None:
        return {"passed": None, "failed": None, "errors": None, "skipped": None, "total": None}
    results = parser(output)
    # Compute total if we have any parsed values
    counts = [v for v in results.values() if v is not None]
    results["total"] = sum(counts) if counts else None
    return results


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_post_evaluation(
    run_folder: Path,
    config: RunnerConfig,
    use_sandbox: bool | None = None,
) -> Path | None:
    """Run post-run test evaluation on the generated workspace.

    Detects project type, installs dependencies, runs tests, parses results,
    and writes test-results.yaml.

    When *use_sandbox* is ``None`` the setting is read from
    ``config.execution.sandbox.enabled``.

    Returns the path to test-results.yaml, or None if no project was detected.
    """
    workspace = run_folder / "workspace"
    out_path = run_folder / "test-results.yaml"
    timeout = config.execution.post_run_timeout

    sandbox_cfg = config.execution.sandbox
    if use_sandbox is None:
        use_sandbox = sandbox_cfg.enabled

    if not workspace.exists():
        _write_results(out_path, {"status": "skipped", "reason": "no workspace directory"})
        return out_path

    project = detect_project(workspace)
    if project is None:
        _write_results(out_path, {"status": "skipped", "reason": "no recognised project markers"})
        return out_path

    project_root = project.project_root

    # Remove any host-created .venv before sandbox steps.
    # A host venv has symlinks to the host Python interpreter which are
    # broken inside the container.
    if use_sandbox:
        stale_venv = project_root / ".venv"
        if stale_venv.is_dir():
            shutil.rmtree(stale_venv)

    data: dict[str, Any] = {
        "status": "completed",
        "project_type": project.project_type,
        "project_root": str(project_root.relative_to(run_folder)),
    }

    # Install dependencies
    # In sandbox mode for Python projects, use `uv sync` which
    # auto-creates a fresh .venv and installs from the lockfile.
    install_cmd = project.install_cmd
    if use_sandbox and project.project_type in ("python", "python-legacy"):
        install_cmd = "uv sync --all-extras"
    install_result = _run_step(
        install_cmd, project_root, timeout,
        use_sandbox=use_sandbox,
        sandbox_image=sandbox_cfg.image,
        sandbox_memory=sandbox_cfg.memory,
        sandbox_cpus=sandbox_cfg.cpus,
    )
    data["install"] = install_result
    if install_result.get("timed_out"):
        data["status"] = "install_timeout"
    elif not install_result["success"]:
        data["status"] = "install_failed"

    # Run tests (even if install failed — may still produce useful output)
    test_result = _run_step(
        project.test_cmd, project_root, timeout,
        use_sandbox=use_sandbox,
        sandbox_image=sandbox_cfg.image,
        sandbox_memory=sandbox_cfg.memory,
        sandbox_cpus=sandbox_cfg.cpus,
    )
    data["test"] = test_result
    if test_result.get("timed_out"):
        data["status"] = "test_timeout"

    # Parse test output
    parsed = parse_test_output(project.project_type, test_result.get("output", ""))
    data["test"]["parsed_results"] = parsed

    _write_results(out_path, data)
    return out_path


def _write_results(path: Path, data: dict[str, Any]) -> None:
    atomic_yaml_dump(data, path)
