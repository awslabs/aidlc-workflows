"""Supported agent adapters."""

from __future__ import annotations

from pathlib import Path

from aidlc_interactive.agents.base import AgentAdapter


def agent_adapters(home: Path | None = None) -> dict[str, AgentAdapter]:
    root = (home or Path.home()).expanduser()
    return {
        "kiro": AgentAdapter("kiro", "kiro-cli", root / ".kiro" / "skills"),
        "claude-code": AgentAdapter("claude-code", "claude", root / ".claude" / "skills"),
        "codex": AgentAdapter("codex", "codex", root / ".agents" / "skills"),
    }
