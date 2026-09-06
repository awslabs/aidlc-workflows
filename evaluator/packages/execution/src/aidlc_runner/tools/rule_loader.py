"""AIDLC rule loading tool.

Provides a tool for agents to dynamically read AIDLC rule files on demand,
keeping context window usage low by only loading rules as the workflow needs them.
"""

from __future__ import annotations

from pathlib import Path

from strands import tool


def make_rule_loader(rules_dir: Path) -> object:
    """Create a rule loader tool bound to a specific rules directory.

    For v2 layouts, rules_dir points to the src/ folder which contains:
        skills/<skill-name>/SKILL.md
        skills/<skill-name>/validation-spec.md
        aidlc-common/protocols/
        aidlc-common/conventions/

    For v1 layouts, rules_dir points to the aidlc-rules/ folder which contains:
        aws-aidlc-rules/core-workflow.md
        aws-aidlc-rule-details/<phase>/<rule>.md

    Args:
        rules_dir: Path to the root of the rules tree (src/ for v2, aidlc-rules/ for v1).

    Returns:
        A tool-decorated function: load_rule.
    """
    rules_dir = rules_dir.resolve()
    _is_v2 = (rules_dir / "skills").is_dir()

    @tool
    def load_rule(rule_path: str) -> str:
        """Load an AIDLC rule or skill file by path.

        For v2 layouts, supported path forms:
            - 'skills/<skill-name>'             → skills/<skill-name>/SKILL.md
            - 'skills/<skill-name>/SKILL'       → skills/<skill-name>/SKILL.md
            - 'skills/<skill-name>/validation-spec' → skills/<skill-name>/validation-spec.md
            - 'aidlc-common/protocols/<name>'   → aidlc-common/protocols/<name>.md
            - 'aidlc-common/conventions/<name>' → aidlc-common/conventions/<name>.md
            - 'skills/aidlc-orchestrator/CATALOGUE' → skills/aidlc-orchestrator/CATALOGUE.md
            - Any bare path relative to the src/ root

        For v1 layouts, supported path forms:
            - 'core-workflow'                   → aws-aidlc-rules/core-workflow.md
            - 'common/<name>'                   → aws-aidlc-rule-details/common/<name>.md
            - 'inception/<name>'                → aws-aidlc-rule-details/inception/<name>.md
            - 'construction/<name>'             → aws-aidlc-rule-details/construction/<name>.md

        Args:
            rule_path: Path to the rule file (see above).
        """
        if _is_v2:
            target = _resolve_v2(rules_dir, rule_path)
        else:
            target = _resolve_v1(rules_dir, rule_path)

        resolved = target.resolve()
        # is_relative_to (not str.startswith) so a sibling dir cannot escape the
        # rules boundary via prefix match. rules_dir is already resolved above.
        if not resolved.is_relative_to(rules_dir):
            return f"Error: Path traversal denied: {rule_path}"

        if not resolved.exists():
            available = _list_available_rules(rules_dir, _is_v2)
            return f"Error: Rule file not found: {rule_path}\n\nAvailable rules:\n{available}"

        return resolved.read_text(encoding="utf-8")

    return load_rule


def _resolve_v2(rules_dir: Path, rule_path: str) -> Path:
    """Resolve a rule path against a v2 src/ layout."""
    p = Path(rule_path)

    # If path starts with 'skills/' and resolves to a directory, append SKILL.md
    candidate = rules_dir / p
    if candidate.is_dir():
        return candidate / "SKILL.md"

    # Append .md if no suffix
    if not p.suffix:
        candidate = rules_dir / p.with_suffix(".md")
    else:
        candidate = rules_dir / p

    return candidate


def _resolve_v1(rules_dir: Path, rule_path: str) -> Path:
    """Resolve a rule path against a v1 aidlc-rules/ layout."""
    if rule_path in ("core-workflow", "core-workflow.md"):
        return rules_dir / "aws-aidlc-rules" / "core-workflow.md"

    target = rules_dir / "aws-aidlc-rule-details" / rule_path
    if not target.suffix:
        target = target.with_suffix(".md")
    return target


def _list_available_rules(rules_dir: Path, is_v2: bool) -> str:
    """List all available rule files for error messages."""
    lines = []

    if is_v2:
        skills_dir = rules_dir / "skills"
        if skills_dir.exists():
            for md_file in sorted(skills_dir.rglob("*.md")):
                rel = md_file.relative_to(rules_dir)
                lines.append(f"  {rel}")
        common_dir = rules_dir / "aidlc-common"
        if common_dir.exists():
            for md_file in sorted(common_dir.rglob("*.md")):
                rel = md_file.relative_to(rules_dir)
                lines.append(f"  {rel}")
    else:
        core = rules_dir / "aws-aidlc-rules" / "core-workflow.md"
        if core.exists():
            lines.append("  core-workflow (shorthand)")
        details_dir = rules_dir / "aws-aidlc-rule-details"
        if details_dir.exists():
            for md_file in sorted(details_dir.rglob("*.md")):
                rel = md_file.relative_to(details_dir)
                lines.append(f"  {rel}")

    return "\n".join(lines) if lines else "  (no rules found)"
