"""Read-only provider and agent detection."""

from __future__ import annotations

import shutil
from typing import Any

_AGENT_EXECUTABLES = {
    "kiro": "kiro-cli",
    "claude-code": "claude",
    "codex": "codex",
}


def detect_agents() -> list[dict[str, Any]]:
    return [
        {
            "agent": agent,
            "available": shutil.which(executable) is not None,
            "executable": executable,
        }
        for agent, executable in _AGENT_EXECUTABLES.items()
    ]


def detect_providers() -> list[dict[str, Any]]:
    return [
        {
            "provider": "plannotator",
            "available": shutil.which("plannotator") is not None,
            "preselected": shutil.which("plannotator") is not None,
        }
    ]


def detection_report() -> dict[str, Any]:
    providers = detect_providers()
    return {
        "schema_version": 1,
        "agents": detect_agents(),
        "providers": providers,
        "recommended_provider": "plannotator" if providers[0]["available"] else "markdown",
    }
