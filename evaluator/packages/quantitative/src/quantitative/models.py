"""Data models for code quality analysis results."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class LintFinding:
    file: str
    line: int
    column: int
    code: str
    message: str
    severity: str  # "error", "warning", "info"


@dataclass
class SecurityFinding:
    file: str
    line: int
    code: str
    message: str
    severity: str  # "high", "medium", "low"
    confidence: str  # "high", "medium", "low"
    cwe: str | None = None


@dataclass
class DuplicationFinding:
    files: list[dict]  # each: {"file": str, "line": int, "endline": int}
    tokens: int = 0
    lines: int = 0
    codefragment: str = ""


@dataclass
class ToolResult:
    tool: str
    version: str | None
    available: bool
    exit_code: int | None = None
    error: str | None = None
    findings: list = field(default_factory=list)


@dataclass
class QualityReport:
    project_type: str
    project_root: str
    lint: ToolResult | None = None
    security: ToolResult | None = None
    semgrep: ToolResult | None = None
    duplication: ToolResult | None = None
    summary: dict = field(default_factory=dict)

    def compute_summary(self) -> None:
        s: dict = {}
        if self.lint and self.lint.available:
            findings = self.lint.findings
            s["lint_total"] = len(findings)
            s["lint_errors"] = sum(1 for f in findings if f.severity == "error")
            s["lint_warnings"] = sum(1 for f in findings if f.severity == "warning")

        sec_findings: list = []
        has_security_tool = False
        if self.security and self.security.available:
            sec_findings.extend(self.security.findings)
            has_security_tool = True
        if self.semgrep and self.semgrep.available:
            sec_findings.extend(self.semgrep.findings)
            has_security_tool = True
        if has_security_tool:
            s["security_total"] = len(sec_findings)
            s["security_high"] = sum(1 for f in sec_findings if f.severity == "high")
            s["security_medium"] = sum(1 for f in sec_findings if f.severity == "medium")
            s["security_low"] = sum(1 for f in sec_findings if f.severity == "low")

        if self.duplication and self.duplication.available:
            dup_findings = self.duplication.findings
            s["duplication_blocks"] = len(dup_findings)
            s["duplication_lines"] = sum(f.lines for f in dup_findings)
            s["duplication_tokens"] = sum(f.tokens for f in dup_findings)

        self.summary = s
