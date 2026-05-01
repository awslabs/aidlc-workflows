# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Stage 1: Discover aidlc-docs directory and artifact files."""

from __future__ import annotations

from pathlib import Path


def find_aidlc_docs(project_root: Path) -> Path | None:
    """Recursively search for aidlc-docs directory from project root."""
    # Direct child first
    direct = project_root / "aidlc-docs"
    if direct.is_dir():
        return direct

    # Check if root itself contains aidlc artifacts (e.g. inception/ at root)
    if (project_root / "inception").is_dir() or (project_root / "construction").is_dir():
        return project_root

    # Recursive search (max depth 3)
    for depth in range(1, 4):
        for p in project_root.rglob("aidlc-docs"):
            if p.is_dir():
                return p
        for p in project_root.rglob("inception"):
            if p.is_dir() and (p.parent / "construction").is_dir() or (p.parent / "aidlc-state.md").exists():
                return p.parent

    return None


def discover_artifacts(aidlc_root: Path) -> dict[str, list[Path]]:
    """Categorize discovered markdown files by artifact type."""
    result: dict[str, list[Path]] = {
        "requirements": [],
        "stories": [],
        "units": [],
        "components": [],
        "code_plans": [],
        "code_files": [],  # Actual source code
        "tests": [],
        "designs": [],
        "state": [],
        "other": [],
    }

    for md_file in sorted(aidlc_root.rglob("*.md")):
        rel = md_file.relative_to(aidlc_root).as_posix().lower()
        name = md_file.name.lower()

        if "requirement" in name and "verification" not in name:
            result["requirements"].append(md_file)
        elif "unit-of-work" in name or "unit_of_work" in name:
            result["units"].append(md_file)
        elif ("stories" in name or "story" in name) and "unit" not in name:
            result["stories"].append(md_file)
        elif "component" in name:
            result["components"].append(md_file)
        elif "code-generation" in name or "code_generation" in name:
            result["code_plans"].append(md_file)
        elif "test" in name:
            result["tests"].append(md_file)
        elif "aidlc-state" in name:
            result["state"].append(md_file)
        elif any(x in rel for x in ["application-design", "functional-design", "nfr"]):
            result["designs"].append(md_file)
        else:
            result["other"].append(md_file)

    return result


def discover_source_code(project_root: Path) -> list[Path]:
    """Discover source code files in the project.

    Scans src/, lib/, and common code directories for Python, JavaScript, TypeScript files.
    Excludes: test files, __pycache__, node_modules, .git, venv, etc.
    """
    code_files: list[Path] = []

    # Common source directories
    source_dirs = ["src", "lib", "app", "packages"]
    exclude_patterns = {
        "__pycache__", ".pytest_cache", "node_modules", ".git",
        "venv", ".venv", "dist", "build", ".next", ".nuxt",
        "coverage", ".coverage", "htmlcov"
    }

    # File extensions to include
    code_extensions = {".py", ".js", ".ts", ".tsx", ".jsx"}

    for dir_name in source_dirs:
        src_dir = project_root / dir_name
        if not src_dir.is_dir():
            continue

        for code_file in src_dir.rglob("*"):
            # Skip if not a file
            if not code_file.is_file():
                continue

            # Skip if wrong extension
            if code_file.suffix not in code_extensions:
                continue

            # Skip if in excluded directory
            if any(excl in code_file.parts for excl in exclude_patterns):
                continue

            # Skip test files (but keep them if they're in tests/ for dedicated test parsing)
            rel_path = str(code_file.relative_to(project_root)).lower()
            if "test_" in code_file.name or "_test." in code_file.name or ".test." in code_file.name:
                if "tests/" not in rel_path and "test/" not in rel_path:
                    continue  # Skip inline test files

            code_files.append(code_file)

    return sorted(code_files)
