"""Consent-driven setup, managed skill installation, and diagnostics."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aidlc_interactive.agents import agent_adapters
from aidlc_interactive.config import (
    InteractionConfig,
    global_config_path,
    load_config,
    render_config,
)
from aidlc_interactive.detection import detection_report
from aidlc_interactive.security import atomic_write


@dataclass(frozen=True)
class PlannedWrite:
    kind: str
    path: Path
    agent: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "path": str(self.path), "agent": self.agent}


def managed_manifest_path() -> Path:
    return global_config_path().with_name("install-manifest.json")


def setup_plan(
    workspace: Path,
    agents: list[str],
    provider: str,
    *,
    home: Path | None = None,
) -> dict[str, Any]:
    adapters = agent_adapters(home)
    unknown = set(agents) - set(adapters)
    if unknown:
        raise ValueError(f"unknown agents: {sorted(unknown)}")
    writes = [PlannedWrite("global_config", global_config_path())]
    writes.extend(PlannedWrite("skill", adapters[name].skill_path, name) for name in agents)
    writes.append(PlannedWrite("managed_manifest", managed_manifest_path()))
    return {
        "schema_version": 1,
        "provider": provider,
        "workspace": str(workspace.resolve()),
        "agents": agents,
        "writes": [write.to_dict() for write in writes],
        "provider_installation": {
            "automatic": False,
            "documentation": "https://docs.plannotator.ai/open-source/start/skills",
        },
    }


def apply_setup(
    workspace: Path,
    agents: list[str],
    provider: str,
    *,
    home: Path | None = None,
) -> dict[str, Any]:
    plan = setup_plan(workspace, agents, provider, home=home)
    adapters = agent_adapters(home)
    managed: list[dict[str, str]] = []
    pending_writes: list[tuple[Path, str, int]] = []
    for name in agents:
        adapter = adapters[name]
        content = adapter.render_skill(workspace)
        target = adapter.skill_path
        if target.is_symlink():
            raise FileExistsError(f"refusing to replace a symlinked skill: {target}")
        if target.exists() and target.read_text(encoding="utf-8") != content:
            raise FileExistsError(f"refusing to overwrite unmanaged skill: {target}")
        pending_writes.append((target, content, 0o644))
        managed.append({"agent": name, "path": str(target)})

    config_path = global_config_path()
    manifest_path = managed_manifest_path()
    if config_path.is_symlink() or manifest_path.is_symlink():
        raise FileExistsError("refusing to replace symlinked setup metadata")
    config = InteractionConfig(
        provider=provider,
        mode="markdown" if provider == "markdown" else "auto",
    )
    manifest = {
        "schema_version": 1,
        "provider": provider,
        "workspace": str(workspace.resolve()),
        "managed_skills": managed,
    }
    pending_writes.extend(
        [
            (config_path, render_config(config), 0o600),
            (manifest_path, json.dumps(manifest, indent=2, sort_keys=True) + "\n", 0o600),
        ]
    )
    snapshots = {
        path: path.read_text(encoding="utf-8") if path.exists() else None
        for path, _content, _mode in pending_writes
    }
    try:
        for path, content, mode in pending_writes:
            atomic_write(path, content, create_mode=mode)
    except (OSError, UnicodeError, ValueError):
        for path, original in reversed(snapshots.items()):
            if original is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, original)
        raise
    return {**plan, "applied": True}


def doctor(workspace: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    try:
        config, sources = load_config(workspace)
        checks.append(
            {
                "check": "configuration",
                "ok": True,
                "mode": config.mode,
                "provider": config.provider,
                "sources": sources,
            }
        )
    except (OSError, UnicodeError, ValueError) as exc:
        checks.append({"check": "configuration", "ok": False, "reason": str(exc)})
    report = detection_report()
    checks.extend(
        {
            "check": f"agent:{agent['agent']}",
            "ok": agent["available"],
            "required": False,
        }
        for agent in report["agents"]
    )
    checks.extend(
        {
            "check": f"provider:{provider['provider']}",
            "ok": provider["available"],
            "required": False,
        }
        for provider in report["providers"]
    )
    return {
        "schema_version": 1,
        "healthy": all(check["ok"] for check in checks if check.get("required", True)),
        "checks": checks,
    }
