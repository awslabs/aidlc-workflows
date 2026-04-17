"""Orchestrator — detect project type, run appropriate analyzers, produce report."""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

import yaml

from quantitative.analyzers import (
    run_bandit,
    run_cpd,
    run_eslint,
    run_npm_audit,
    run_ruff,
    run_semgrep,
)
from quantitative.models import QualityReport, ToolResult

_PYTHON_MARKERS = ("pyproject.toml", "setup.py", "setup.cfg", "requirements.txt")
_NODE_MARKERS = ("package.json",)

_MAX_SEARCH_DEPTH = 3
_SKIP_DIRS = frozenset({
    ".venv", "venv", ".env", "env", "node_modules",
    "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
    ".git", ".hg", ".svn", "target", "dist", "build",
    ".tox", ".nox", ".cache",
})


def _detect_project(workspace: Path) -> tuple[str, Path] | None:
    """BFS for a project root with a recognizable marker.

    Returns (project_type, project_root) or None.
    """
    if not workspace.is_dir():
        return None

    def _check(d: Path) -> str | None:
        for m in _PYTHON_MARKERS:
            if (d / m).exists():
                return "python"
        for m in _NODE_MARKERS:
            if (d / m).exists():
                return "node"
        return None

    pt = _check(workspace)
    if pt:
        return pt, workspace

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
            pt = _check(child)
            if pt:
                return pt, child
            queue.append((child, depth + 1))

    return None


def _run_python_analyzers(
    project_root: Path,
    pmd_path: str | None = None,
) -> tuple[ToolResult, ToolResult, ToolResult, ToolResult]:
    lint = run_ruff(project_root)
    security = run_bandit(project_root)
    semgrep = run_semgrep(project_root)
    duplication = run_cpd(project_root, language="python", pmd_path=pmd_path)
    return lint, security, semgrep, duplication


def _run_node_analyzers(
    project_root: Path,
    pmd_path: str | None = None,
) -> tuple[ToolResult, ToolResult, ToolResult, ToolResult]:
    lint = run_eslint(project_root)
    security = run_npm_audit(project_root)
    semgrep = run_semgrep(project_root)
    duplication = run_cpd(project_root, language="node", pmd_path=pmd_path)
    return lint, security, semgrep, duplication


def scan_workspace(workspace: Path, pmd_path: str | None = None) -> QualityReport | None:
    """Run lint + security + duplication analysis on a workspace directory.

    Returns a QualityReport, or None if no recognizable project is found.
    """
    detection = _detect_project(workspace)
    if detection is None:
        return None

    project_type, project_root = detection

    if project_type == "python":
        lint, security, semgrep, duplication = _run_python_analyzers(project_root, pmd_path=pmd_path)
    elif project_type == "node":
        lint, security, semgrep, duplication = _run_node_analyzers(project_root, pmd_path=pmd_path)
    else:
        return None

    report = QualityReport(
        project_type=project_type,
        project_root=str(project_root.relative_to(workspace))
        if project_root != workspace else ".",
        lint=lint,
        security=security,
        semgrep=semgrep,
        duplication=duplication,
    )
    report.compute_summary()
    return report


def write_report(report: QualityReport, output_path: Path) -> None:
    """Serialize a QualityReport to YAML."""
    data = asdict(report)
    with open(output_path, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False)


def print_report(report: QualityReport) -> None:
    """Print a human-readable summary to stdout."""
    print(f"\nProject type: {report.project_type}")
    print(f"Project root: {report.project_root}")

    if report.lint:
        _print_tool("Linter", report.lint)
    if report.security:
        _print_tool("Security (bandit)", report.security)
    if report.semgrep:
        _print_tool("Security (semgrep)", report.semgrep)
    if report.duplication:
        _print_tool("Duplication (CPD)", report.duplication)

    if report.summary:
        print(f"\nSummary:")
        for k, v in report.summary.items():
            print(f"  {k}: {v}")


def _print_tool(label: str, result: ToolResult) -> None:
    if not result.available:
        print(f"\n{label} ({result.tool}): NOT AVAILABLE — {result.error}")
        return
    count = len(result.findings)
    status = "clean" if count == 0 else f"{count} finding(s)"
    print(f"\n{label} ({result.tool} {result.version}): {status}")
    if result.error:
        print(f"  Error: {result.error}")
    for f in result.findings[:20]:
        if hasattr(f, "file"):
            print(f"  {f.file}:{f.line} [{f.code}] {f.message}")
        elif hasattr(f, "files"):
            locs = ", ".join(f"{e['file']}:{e['line']}" for e in f.files)
            print(f"  {f.lines} lines across {locs}")
    if count > 20:
        print(f"  ... and {count - 20} more")
