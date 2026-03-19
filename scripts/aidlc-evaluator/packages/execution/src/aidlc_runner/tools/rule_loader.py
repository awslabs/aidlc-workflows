"""AIDLC rule loading tool.

Provides a tool for agents to dynamically read AIDLC rule files on demand,
keeping context window usage low by only loading rules as the workflow needs them.
"""

from __future__ import annotations

from pathlib import Path

from strands import tool


def make_rule_loader(rules_dir: Path) -> object:
    """Create a rule loader tool bound to a specific rules directory.

    Args:
        rules_dir: Path to the cloned/copied aidlc-rules directory
                   (the folder containing aws-aidlc-rules/ and aws-aidlc-rule-details/).

    Returns:
        A tool-decorated function: load_rule.
    """
    rules_dir = rules_dir.resolve()

    @tool
    def load_rule(rule_path: str) -> str:
        """Load an AIDLC rule file by path.

        Use this to read AIDLC workflow rules as you progress through stages.

        Args:
            rule_path: Path relative to the rules directory. Examples:
                - 'core-workflow' (shorthand for aws-aidlc-rules/core-workflow.md)
                - 'common/process-overview.md' (loads from aws-aidlc-rule-details/)
                - 'inception/requirements-analysis.md' (loads from aws-aidlc-rule-details/)
                - 'construction/code-generation.md' (loads from aws-aidlc-rule-details/)
        """
        # Handle the core-workflow shorthand
        if rule_path in ("core-workflow", "core-workflow.md"):
            target = rules_dir / "aws-aidlc-rules" / "core-workflow.md"
        else:
            # Default: look in aws-aidlc-rule-details/
            target = rules_dir / "aws-aidlc-rule-details" / rule_path
            if not target.suffix:
                target = target.with_suffix(".md")

        resolved = target.resolve()
        # Safety: stay within rules_dir
        if not str(resolved).startswith(str(rules_dir)):
            return f"Error: Path traversal denied: {rule_path}"

        if not resolved.exists():
            # List available rules to help the agent
            available = _list_available_rules(rules_dir)
            return f"Error: Rule file not found: {rule_path}\n\nAvailable rules:\n{available}"

        return resolved.read_text(encoding="utf-8")

    return load_rule


def _list_available_rules(rules_dir: Path) -> str:
    """List all available rule files for error messages."""
    lines = []

    core = rules_dir / "aws-aidlc-rules" / "core-workflow.md"
    if core.exists():
        lines.append("  core-workflow (shorthand)")

    details_dir = rules_dir / "aws-aidlc-rule-details"
    if details_dir.exists():
        for md_file in sorted(details_dir.rglob("*.md")):
            rel = md_file.relative_to(details_dir)
            lines.append(f"  {rel}")

    return "\n".join(lines) if lines else "  (no rules found)"
