"""Language-aware static analysis runners.

Each analyzer wraps an external CLI tool (ruff, bandit, eslint, etc.),
runs it against the project, and parses its JSON/text output into our
standardized finding models.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import defusedxml.ElementTree as ET

from quantitative.models import (
    DuplicationFinding,
    LintFinding,
    SecurityFinding,
    ToolResult,
)

_TIMEOUT = 120


def _tool_version(cmd: str, cwd: Path | None = None) -> str | None:
    """Get the version string of a CLI tool, or None if not installed.

    Tries the tool directly first, then falls back to ``uv run <cmd>``
    so that project-local dev dependencies are found.
    """
    for argv in ([cmd, "--version"], ["uv", "run", cmd, "--version"]):
        if shutil.which(argv[0]) is None:
            continue
        try:
            # nosec B603 - Running static --version command for tool detection
            # nosemgrep: dangerous-subprocess-use-audit
            result = subprocess.run(
                argv, capture_output=True, text=True, timeout=10,
                cwd=str(cwd) if cwd else None,
            )
            if result.returncode != 0:
                continue
            first_line = result.stdout.strip().split("\n")[0]
            m = re.search(r"[\d]+\.[\d]+[\.\d]*", first_line)
            return m.group(0) if m else first_line
        except (subprocess.TimeoutExpired, OSError):
            continue
    return None


def _resolve_cmd(cmd: str, cwd: Path | None = None) -> list[str]:
    """Return [cmd] if on PATH, else ['uv', 'run', cmd] if uv is available.

    When using uv, the caller must pass cwd= to _run_tool so that uv
    resolves the tool from the project's virtual environment.
    """
    if shutil.which(cmd) is not None:
        return [cmd]
    if shutil.which("uv") is not None:
        return ["uv", "run", cmd]
    return []


def _run_tool(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    env = {**os.environ}
    # nosec B603 - Running security analysis tools (ruff, bandit, semgrep) with validated arguments
    # nosemgrep: dangerous-subprocess-use-audit
    return subprocess.run(
        cmd, cwd=str(cwd),
        capture_output=True, text=True, timeout=_TIMEOUT, env=env,
    )


# ---------------------------------------------------------------------------
# Python: ruff (linter)
# ---------------------------------------------------------------------------

def run_ruff(project_root: Path) -> ToolResult:
    """Run ruff linter and return parsed findings."""
    version = _tool_version("ruff", cwd=project_root)
    if version is None:
        return ToolResult(tool="ruff", version=None, available=False,
                          error="ruff not found on PATH or via uv")

    prefix = _resolve_cmd("ruff")
    if not prefix:
        return ToolResult(tool="ruff", version=None, available=False,
                          error="ruff not found on PATH or via uv")

    try:
        result = _run_tool(
            prefix + ["check", "--output-format=json", "--no-fix", "."],
            cwd=project_root,
        )
    except subprocess.TimeoutExpired:
        return ToolResult(tool="ruff", version=version, available=True,
                          error="timed out")

    findings: list[LintFinding] = []
    try:
        items = json.loads(result.stdout) if result.stdout.strip() else []
        for item in items:
            sev = "error" if item.get("code", "").startswith("E") else "warning"
            raw_path = item.get("filename", "?")
            try:
                rel_path = str(Path(raw_path).relative_to(project_root))
            except ValueError:
                rel_path = raw_path
            findings.append(LintFinding(
                file=rel_path,
                line=item.get("location", {}).get("row", 0),
                column=item.get("location", {}).get("column", 0),
                code=item.get("code", "?"),
                message=item.get("message", ""),
                severity=sev,
            ))
    except (json.JSONDecodeError, KeyError):
        pass

    return ToolResult(
        tool="ruff", version=version, available=True,
        exit_code=result.returncode, findings=findings,
    )


# ---------------------------------------------------------------------------
# Python: bandit (security scanner)
# ---------------------------------------------------------------------------

def run_bandit(project_root: Path) -> ToolResult:
    """Run bandit security scanner and return parsed findings."""
    version = _tool_version("bandit", cwd=project_root)
    if version is None:
        return ToolResult(tool="bandit", version=None, available=False,
                          error="bandit not found on PATH or via uv")

    prefix = _resolve_cmd("bandit")
    if not prefix:
        return ToolResult(tool="bandit", version=None, available=False,
                          error="bandit not found on PATH or via uv")

    src_dir = project_root / "src"
    target = str(src_dir) if src_dir.is_dir() else "."

    try:
        result = _run_tool(
            prefix + ["-r", target, "-f", "json", "-q"],
            cwd=project_root,
        )
    except subprocess.TimeoutExpired:
        return ToolResult(tool="bandit", version=version, available=True,
                          error="timed out")

    findings: list[SecurityFinding] = []
    output = result.stdout or result.stderr
    try:
        data = json.loads(output) if output.strip() else {}
        for item in data.get("results", []):
            findings.append(SecurityFinding(
                file=item.get("filename", "?"),
                line=item.get("line_number", 0),
                code=item.get("test_id", "?"),
                message=item.get("issue_text", ""),
                severity=item.get("issue_severity", "MEDIUM").lower(),
                confidence=item.get("issue_confidence", "MEDIUM").lower(),
                cwe=_extract_cwe(item),
            ))
    except (json.JSONDecodeError, KeyError):
        pass

    return ToolResult(
        tool="bandit", version=version, available=True,
        exit_code=result.returncode, findings=findings,
    )


def _extract_cwe(item: dict) -> str | None:
    cwe = item.get("issue_cwe", {})
    if isinstance(cwe, dict) and cwe.get("id"):
        return f"CWE-{cwe['id']}"
    return None


# ---------------------------------------------------------------------------
# JavaScript/TypeScript: eslint (linter)
# ---------------------------------------------------------------------------

def run_eslint(project_root: Path) -> ToolResult:
    """Run eslint and return parsed findings."""
    version = _tool_version("eslint")
    if version is None:
        npx = shutil.which("npx")
        if npx is None:
            return ToolResult(tool="eslint", version=None, available=False,
                              error="eslint/npx not found on PATH")
        cmd = ["npx", "eslint", ".", "--format=json"]
    else:
        cmd = ["eslint", ".", "--format=json"]

    try:
        result = _run_tool(cmd, cwd=project_root)
    except subprocess.TimeoutExpired:
        return ToolResult(tool="eslint", version=version, available=True,
                          error="timed out")

    findings: list[LintFinding] = []
    try:
        items = json.loads(result.stdout) if result.stdout.strip() else []
        for file_result in items:
            for msg in file_result.get("messages", []):
                sev_num = msg.get("severity", 1)
                sev = "error" if sev_num == 2 else "warning"
                findings.append(LintFinding(
                    file=file_result.get("filePath", "?"),
                    line=msg.get("line", 0),
                    column=msg.get("column", 0),
                    code=msg.get("ruleId", "?") or "parse-error",
                    message=msg.get("message", ""),
                    severity=sev,
                ))
    except (json.JSONDecodeError, KeyError):
        pass

    return ToolResult(
        tool="eslint", version=version or "npx", available=True,
        exit_code=result.returncode, findings=findings,
    )


# ---------------------------------------------------------------------------
# JavaScript/TypeScript: npm audit (security)
# ---------------------------------------------------------------------------

def run_npm_audit(project_root: Path) -> ToolResult:
    """Run npm audit and return parsed findings."""
    npm = shutil.which("npm")
    if npm is None:
        return ToolResult(tool="npm-audit", version=None, available=False,
                          error="npm not found on PATH")

    version = _tool_version("npm")
    lock_file = project_root / "package-lock.json"
    if not lock_file.exists():
        return ToolResult(tool="npm-audit", version=version, available=True,
                          error="no package-lock.json found")

    try:
        result = _run_tool(
            ["npm", "audit", "--json"],
            cwd=project_root,
        )
    except subprocess.TimeoutExpired:
        return ToolResult(tool="npm-audit", version=version, available=True,
                          error="timed out")

    findings: list[SecurityFinding] = []
    try:
        data = json.loads(result.stdout) if result.stdout.strip() else {}
        vulns = data.get("vulnerabilities", {})
        for name, info in vulns.items():
            findings.append(SecurityFinding(
                file=f"package: {name}",
                line=0,
                code=info.get("via", [{}])[0].get("source", "?") if info.get("via") else "?",
                message=info.get("via", [{}])[0].get("title", "") if info.get("via") else name,
                severity=info.get("severity", "medium").lower(),
                confidence="high",
                cwe=None,
            ))
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        pass

    return ToolResult(
        tool="npm-audit", version=version, available=True,
        exit_code=result.returncode, findings=findings,
    )


# ---------------------------------------------------------------------------
# Python: semgrep (security scanner)
# ---------------------------------------------------------------------------

_SEMGREP_SEVERITY_MAP = {
    "ERROR": "high",
    "WARNING": "medium",
    "INFO": "low",
}


def run_semgrep(project_root: Path) -> ToolResult:
    """Run semgrep security scanner and return parsed findings."""
    version = _tool_version("semgrep", cwd=project_root)
    if version is None:
        return ToolResult(tool="semgrep", version=None, available=False,
                          error="semgrep not found on PATH or via uv")

    prefix = _resolve_cmd("semgrep")
    if not prefix:
        return ToolResult(tool="semgrep", version=None, available=False,
                          error="semgrep not found on PATH or via uv")

    try:
        result = _run_tool(
            prefix + ["scan", "--config", "auto", "--json", str(project_root)],
            cwd=project_root,
        )
    except subprocess.TimeoutExpired:
        return ToolResult(tool="semgrep", version=version, available=True,
                          error="timed out")

    findings: list[SecurityFinding] = []
    try:
        data = json.loads(result.stdout) if result.stdout.strip() else {}
        for item in data.get("results", []):
            raw_sev = item.get("extra", {}).get("severity", "WARNING")
            sev = _SEMGREP_SEVERITY_MAP.get(raw_sev, "medium")
            raw_path = item.get("path", "?")
            try:
                rel_path = str(Path(raw_path).relative_to(project_root))
            except ValueError:
                rel_path = raw_path
            cwe_list = item.get("extra", {}).get("metadata", {}).get("cwe", [])
            cwe_str = cwe_list[0] if cwe_list else None
            findings.append(SecurityFinding(
                file=rel_path,
                line=item.get("start", {}).get("line", 0),
                code=item.get("check_id", "?"),
                message=item.get("extra", {}).get("message", ""),
                severity=sev,
                confidence=item.get("extra", {}).get("metadata", {}).get("confidence", "MEDIUM").lower(),
                cwe=cwe_str,
            ))
    except (json.JSONDecodeError, KeyError):
        pass

    return ToolResult(
        tool="semgrep", version=version, available=True,
        exit_code=result.returncode, findings=findings,
    )


# ---------------------------------------------------------------------------
# PMD CPD (Copy-Paste Detector) — code duplication
# ---------------------------------------------------------------------------

_CPD_LANGUAGE_MAP = {
    "python": "python",
    "node": "ecmascript",
}


def _resolve_pmd(configured_path: str | None = None) -> str | None:
    """Find the pmd executable.

    Uses *configured_path* when provided, otherwise searches PATH.
    """
    if configured_path:
        p = Path(configured_path).expanduser()
        if p.is_file():
            return str(p)
        return None
    for name in ("pmd", "pmd.bat"):
        found = shutil.which(name)
        if found:
            return found
    return None


def run_cpd(
    project_root: Path,
    language: str = "python",
    min_tokens: int = 100,
    pmd_path: str | None = None,
) -> ToolResult:
    """Run PMD CPD and return parsed duplication findings."""
    pmd = _resolve_pmd(pmd_path)
    if pmd is None:
        return ToolResult(tool="pmd-cpd", version=None, available=False,
                          error="pmd not found — set tools.pmd_path in config or install pmd on PATH")

    cpd_lang = _CPD_LANGUAGE_MAP.get(language, language)

    _CPD_EXCLUDES = {
        ".pytest_cache", "__pycache__", ".venv", "venv",
        "node_modules", ".git", ".tox", ".mypy_cache", ".ruff_cache",
        ".cache",
    }
    exclude_args: list[str] = []
    abs_root = project_root.resolve()
    for dirpath, dirnames, _ in os.walk(abs_root):
        matched = [d for d in dirnames if d in _CPD_EXCLUDES]
        for d in matched:
            rel = os.path.relpath(os.path.join(dirpath, d), abs_root)
            exclude_args.extend(["--exclude", f"./{rel}"])
        # prune so os.walk doesn't descend into excluded dirs
        dirnames[:] = [d for d in dirnames if d not in _CPD_EXCLUDES]

    try:
        result = _run_tool(
            [pmd, "cpd",
             "--minimum-tokens", str(min_tokens),
             "--dir", ".",
             "--language", cpd_lang,
             "--format", "xml",
             "--no-fail-on-violation",
             *exclude_args],
            cwd=project_root,
        )
    except subprocess.TimeoutExpired:
        return ToolResult(tool="pmd-cpd", version=None, available=True,
                          error="timed out")

    findings: list[DuplicationFinding] = []
    try:
        if result.stdout.strip():
            root = ET.fromstring(result.stdout)
            ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
            for dup in root.findall(f"{ns}duplication"):
                lines = int(dup.get("lines", 0))
                tokens = int(dup.get("tokens", 0))
                files = []
                for f_elem in dup.findall(f"{ns}file"):
                    raw_path = f_elem.get("path", "?")
                    try:
                        rel = str(Path(raw_path).relative_to(project_root))
                    except ValueError:
                        rel = raw_path
                    files.append({
                        "file": rel,
                        "line": int(f_elem.get("line", 0)),
                        "endline": int(f_elem.get("endline", 0)),
                    })
                codefragment_elem = dup.find(f"{ns}codefragment")
                codefragment = (codefragment_elem.text or "").strip() if codefragment_elem is not None else ""
                findings.append(DuplicationFinding(
                    files=files,
                    tokens=tokens,
                    lines=lines,
                    codefragment=codefragment[:500],
                ))
    except ET.ParseError:
        pass

    return ToolResult(
        tool="pmd-cpd", version=None, available=True,
        exit_code=result.returncode, findings=findings,
    )
