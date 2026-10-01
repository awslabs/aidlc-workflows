"""Agent skill installation adapters."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path


@dataclass(frozen=True)
class AgentAdapter:
    agent_id: str
    executable: str
    skill_root: Path

    @property
    def skill_path(self) -> Path:
        return self.skill_root / "aidlc-interactive" / "SKILL.md"

    def is_available(self) -> bool:
        return shutil.which(self.executable) is not None

    def render_skill(self, workspace: Path) -> str:
        workspace.resolve(strict=True)
        return (
            files("aidlc_interactive")
            .joinpath("resources/skills/SKILL.md.template")
            .read_text(encoding="utf-8")
        )
