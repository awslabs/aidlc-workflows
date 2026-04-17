"""Configuration loading and management for AIDLC Runner."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)


@dataclass
class AwsConfig:
    profile: str | None = None
    region: str | None = None


@dataclass
class ModelConfig:
    provider: str = "bedrock"
    model_id: str = "global.anthropic.claude-opus-4-6-v1"


@dataclass
class ModelsConfig:
    executor: ModelConfig = field(default_factory=ModelConfig)
    simulator: ModelConfig = field(default_factory=ModelConfig)


@dataclass
class AidlcConfig:
    rules_source: str = "git"
    rules_repo: str = "https://github.com/awslabs/aidlc-workflows.git"
    rules_local_path: str | None = None
    rules_ref: str = "main"


@dataclass
class SwarmConfig:
    max_handoffs: int = 200
    max_iterations: int = 200
    execution_timeout: float = 14400.0
    node_timeout: float = 3600.0


@dataclass
class RunsConfig:
    output_dir: str = "./runs"


@dataclass
class SandboxConfig:
    enabled: bool = True
    image: str = "aidlc-sandbox:latest"
    memory: str = "2g"
    cpus: int = 2


@dataclass
class ExecutionConfig:
    enabled: bool = True
    command_timeout: int = 120
    post_run_tests: bool = True
    post_run_timeout: int = 300
    sandbox: SandboxConfig = field(default_factory=SandboxConfig)


@dataclass
class RunnerConfig:
    aws: AwsConfig = field(default_factory=AwsConfig)
    models: ModelsConfig = field(default_factory=ModelsConfig)
    aidlc: AidlcConfig = field(default_factory=AidlcConfig)
    swarm: SwarmConfig = field(default_factory=SwarmConfig)
    runs: RunsConfig = field(default_factory=RunsConfig)
    execution: ExecutionConfig = field(default_factory=ExecutionConfig)


def _merge_dict_into_dataclass(dc: object, data: dict) -> None:
    """Recursively merge a dict into a dataclass instance."""
    for key, value in data.items():
        if not hasattr(dc, key):
            logger.warning("Unknown config key %r (ignored) — check for typos", key)
            continue
        current = getattr(dc, key)
        if isinstance(value, dict) and hasattr(current, "__dataclass_fields__"):
            _merge_dict_into_dataclass(current, value)
        elif value is not None:
            setattr(dc, key, value)


def load_config(
    config_path: str | Path | None = None,
    cli_overrides: dict | None = None,
) -> RunnerConfig:
    """Load configuration from YAML file and apply CLI overrides.

    Args:
        config_path: Path to YAML config file. If None, uses built-in defaults.
        cli_overrides: Dict of CLI argument overrides to apply on top.

    Returns:
        Fully resolved RunnerConfig.
    """
    config = RunnerConfig()

    if config_path is not None:
        path = Path(config_path)
        if path.exists():
            with open(path, encoding="utf-8") as f:
                yaml_data = yaml.safe_load(f) or {}
            _merge_dict_into_dataclass(config, yaml_data)

    if cli_overrides:
        _merge_dict_into_dataclass(config, cli_overrides)

    return config


def default_config_path() -> Path:
    """Return the path to the default.yaml config at the repo root.

    Checks for config/default.yaml relative to cwd first (the expected
    layout when run from the repo root), then falls back to a path
    relative to this source file for backwards compatibility.
    """
    cwd_candidate = Path.cwd() / "config" / "default.yaml"
    if cwd_candidate.is_file():
        return cwd_candidate
    return Path(__file__).resolve().parent.parent.parent / "config" / "default.yaml"
