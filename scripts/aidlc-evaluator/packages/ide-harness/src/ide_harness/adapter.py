"""Abstract adapter interface for IDE automation."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class AdapterConfig:
    """Configuration for an IDE adapter run."""

    vision_path: Path
    output_dir: Path
    rules_path: Path
    tech_env_path: Path | None = None
    prompt_template: str | None = None
    timeout_seconds: int = 7200  # 2 hours max


@dataclass
class AdapterResult:
    """Result from an IDE adapter run."""

    success: bool
    output_dir: Path
    aidlc_docs_dir: Path | None = None
    workspace_dir: Path | None = None
    error: str | None = None
    elapsed_seconds: float = 0.0
    token_estimate: int | None = None
    extra: dict = field(default_factory=dict)


class IDEAdapter(ABC):
    """Abstract base for IDE-specific automation adapters."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable IDE name (e.g., 'Cursor', 'Cline')."""
        ...

    @abstractmethod
    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify IDE is installed, configured, and accessible.

        Returns:
            (ok, message) — True with a success message, or False with
            a description of what's missing.
        """
        ...

    @abstractmethod
    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the AIDLC process through the IDE and capture outputs.

        The implementation should:
        1. Set up a clean workspace with vision.md, tech-env.md, and rules
        2. Launch the IDE or connect to a running instance
        3. Send the AIDLC prompt to the IDE's AI chat
        4. Monitor for completion (all AIDLC phases done)
        5. Extract aidlc-docs/ and workspace/ from the IDE output
        6. Generate run-meta.yaml with timing and adapter info
        """
        ...
