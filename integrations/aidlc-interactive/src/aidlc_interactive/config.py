"""Global and workspace-local configuration without runtime dependencies."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, replace
from pathlib import Path

from aidlc_interactive.security import atomic_write

_ALLOWED_KEYS = {
    "schema_version",
    "mode",
    "provider",
    "timeout_seconds",
    "verification",
    "plannotator_sha256",
}


@dataclass(frozen=True)
class InteractionConfig:
    schema_version: int = 1
    mode: str = "auto"
    provider: str = "plannotator"
    timeout_seconds: int = 1800
    verification: str = "auto"
    plannotator_sha256: str | None = None

    def validate(self) -> InteractionConfig:
        if self.schema_version != 1:
            raise ValueError("unsupported configuration schema_version")
        if self.mode not in {"auto", "interactive", "markdown"}:
            raise ValueError("mode must be auto, interactive, or markdown")
        if not self.provider or len(self.provider) > 64:
            raise ValueError("provider is empty or too long")
        if not 1 <= self.timeout_seconds <= 7200:
            raise ValueError("timeout_seconds must be between 1 and 7200")
        if self.verification not in {"auto", "attestation", "checksum", "none"}:
            raise ValueError("verification mode is invalid")
        if self.verification == "checksum":
            digest = self.plannotator_sha256 or ""
            if len(digest) != 64 or any(
                character not in "0123456789abcdefABCDEF" for character in digest
            ):
                raise ValueError("checksum verification requires a SHA-256 digest")
        return replace(
            self,
            plannotator_sha256=(
                self.plannotator_sha256.lower() if self.plannotator_sha256 else None
            ),
        )


def global_config_path() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "aidlc" / "interaction.yaml"


def workspace_config_path(workspace: Path) -> Path:
    return workspace.expanduser().resolve() / ".aidlc" / "interaction.local.yaml"


def _parse_scalar(value: str) -> str | int | None:
    value = value.strip()
    if not value or value in {"null", "~"}:
        return None
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    try:
        return int(value)
    except ValueError:
        return value


def read_config(path: Path) -> dict[str, str | int | None]:
    if not path.is_file():
        return {}
    if path.stat().st_size > 64 * 1024:
        raise ValueError(f"configuration file is too large: {path}")
    values: dict[str, str | int | None] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"invalid configuration line {line_number}")
        key, raw_value = line.split(":", 1)
        key = key.strip()
        if key not in _ALLOWED_KEYS:
            raise ValueError(f"unknown configuration key: {key}")
        if key in values:
            raise ValueError(f"duplicate configuration key: {key}")
        values[key] = _parse_scalar(raw_value)
    return values


def _integer_value(
    values: dict[str, str | int | None],
    key: str,
    default: int,
) -> int:
    value = values.get(key, default)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError as exc:
            raise ValueError(f"{key} must be an integer") from exc
    raise ValueError(f"{key} must be an integer")


def load_config(workspace: Path) -> tuple[InteractionConfig, list[str]]:
    merged: dict[str, str | int | None] = {}
    sources: list[str] = []
    for path in (global_config_path(), workspace_config_path(workspace)):
        values = read_config(path)
        if values:
            merged.update(values)
            sources.append(str(path))
    config = InteractionConfig(
        schema_version=_integer_value(merged, "schema_version", 1),
        mode=str(merged.get("mode", "auto")),
        provider=str(merged.get("provider", "plannotator")),
        timeout_seconds=_integer_value(merged, "timeout_seconds", 1800),
        verification=str(merged.get("verification", "auto")),
        plannotator_sha256=(
            str(merged["plannotator_sha256"])
            if merged.get("plannotator_sha256") is not None
            else None
        ),
    ).validate()
    return config, sources


def render_config(config: InteractionConfig) -> str:
    value = config.validate()
    lines = [
        f"schema_version: {value.schema_version}",
        f"mode: {value.mode}",
        f"provider: {value.provider}",
        f"timeout_seconds: {value.timeout_seconds}",
        f"verification: {value.verification}",
    ]
    if value.plannotator_sha256:
        lines.append(f"plannotator_sha256: {value.plannotator_sha256}")
    return "\n".join(lines) + "\n"


def write_config(path: Path, config: InteractionConfig) -> None:
    atomic_write(path, render_config(config), create_mode=0o600)
