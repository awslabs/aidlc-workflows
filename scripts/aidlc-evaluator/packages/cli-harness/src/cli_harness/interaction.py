"""Typed interaction domain for CLI review gates."""

from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
MAX_ANSWER_BYTES = 16 * 1024
MAX_FEEDBACK_BYTES = 256 * 1024
MAX_ANSWERS = 100
_MAX_GATE_ID_LENGTH = 160
_MAX_PROVIDER_LENGTH = 64
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_GATE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")


class InteractionType(StrEnum):
    """Kinds of human interaction supported by the harness."""

    QUESTIONS = "questions"
    APPROVAL = "approval"


class InteractionOutcome(StrEnum):
    """Closed set of decisions returned by an interaction provider."""

    ANSWERS_SUBMITTED = "answers_submitted"
    APPROVED = "approved"
    CHANGES_REQUESTED = "changes_requested"
    CANCELLED = "cancelled"
    UNAVAILABLE = "unavailable"


_ALLOWED_OUTCOMES = {
    InteractionType.QUESTIONS: {
        InteractionOutcome.ANSWERS_SUBMITTED,
        InteractionOutcome.CANCELLED,
        InteractionOutcome.UNAVAILABLE,
    },
    InteractionType.APPROVAL: {
        InteractionOutcome.APPROVED,
        InteractionOutcome.CHANGES_REQUESTED,
        InteractionOutcome.CANCELLED,
        InteractionOutcome.UNAVAILABLE,
    },
}


def _parse_datetime(value: datetime | str, field_name: str) -> datetime:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"{field_name} must be an ISO-8601 timestamp") from exc
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError(f"{field_name} must be timezone-aware")
    return value.astimezone(UTC)


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _validate_common(
    gate_id: str,
    interaction_type: InteractionType | str,
    artifact_path: Path | str,
    digest_sha256: str,
    provider: str,
) -> tuple[InteractionType, Path]:
    if not isinstance(gate_id, str) or not gate_id or len(gate_id) > _MAX_GATE_ID_LENGTH:
        raise ValueError("gate_id is empty or too long")
    if not _GATE_ID_RE.fullmatch(gate_id):
        raise ValueError("gate_id contains unsupported characters")
    try:
        parsed_type = InteractionType(interaction_type)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"unknown interaction type: {interaction_type!r}") from exc
    if not isinstance(artifact_path, (Path, str)):
        raise ValueError("artifact_path must be a path string")
    path = Path(artifact_path)
    if not path.is_absolute():
        raise ValueError("artifact_path must be resolved and absolute")
    if not isinstance(digest_sha256, str) or not _SHA256_RE.fullmatch(digest_sha256):
        raise ValueError("digest_sha256 must be a lowercase SHA-256 hex digest")
    if not isinstance(provider, str) or not provider or len(provider) > _MAX_PROVIDER_LENGTH:
        raise ValueError("provider is empty or too long")
    return parsed_type, path


def resolve_artifact_path(
    workspace: Path,
    artifact_path: Path,
    *,
    must_exist: bool = True,
) -> Path:
    """Resolve an artifact and reject paths escaping the workspace."""
    root = workspace.resolve(strict=True)
    candidate = artifact_path if artifact_path.is_absolute() else root / artifact_path
    resolved = candidate.resolve(strict=must_exist)
    if not resolved.is_relative_to(root):
        raise ValueError(f"artifact path is outside workspace: {artifact_path}")
    if must_exist and not resolved.is_file():
        raise ValueError(f"artifact is not a regular file: {resolved}")
    return resolved


def sha256_file(path: Path, *, max_bytes: int = MAX_ARTIFACT_BYTES) -> str:
    """Hash a bounded regular file using SHA-256."""
    stat = path.stat()
    if not path.is_file():
        raise ValueError(f"artifact is not a regular file: {path}")
    if stat.st_size > max_bytes:
        raise ValueError(f"artifact exceeds {max_bytes} bytes: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as artifact:
        for chunk in iter(lambda: artifact.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_gate_id(
    interaction_type: InteractionType,
    artifact_path: Path,
    workspace: Path,
) -> str:
    """Create a nonce-bound identifier for one canonical artifact version."""
    parsed_type = InteractionType(interaction_type)
    artifact = resolve_artifact_path(workspace, artifact_path)
    relative = artifact.relative_to(workspace.resolve(strict=True))
    nonce = secrets.token_hex(16)
    identity = f"{parsed_type.value}:{relative}:{sha256_file(artifact)}:{nonce}"
    suffix = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
    return f"{parsed_type.value}:{suffix}"


def result_matches_pending(
    pending: PendingInteraction,
    decision: InteractionResult,
    *,
    require_digest: bool = True,
) -> bool:
    """Return whether a decision is fully bound to a pending interaction."""
    provider_matches = decision.provider == pending.provider or (
        pending.provider == "auto" and decision.provider in {"plannotator", "manual"}
    )
    return (
        decision.gate_id == pending.gate_id
        and decision.interaction_type is pending.interaction_type
        and decision.artifact_path == pending.artifact_path
        and decision.decided_at >= pending.created_at
        and provider_matches
        and (not require_digest or decision.digest_sha256 == pending.digest_sha256)
    )


@dataclass(frozen=True)
class PendingInteraction:
    """A specific artifact version awaiting a human decision."""

    gate_id: str
    interaction_type: InteractionType
    artifact_path: Path
    digest_sha256: str
    provider: str
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        parsed_type, path = _validate_common(
            self.gate_id,
            self.interaction_type,
            self.artifact_path,
            self.digest_sha256,
            self.provider,
        )
        object.__setattr__(self, "interaction_type", parsed_type)
        object.__setattr__(self, "artifact_path", path)
        object.__setattr__(self, "created_at", _parse_datetime(self.created_at, "created_at"))

    @classmethod
    def create(
        cls,
        *,
        gate_id: str,
        interaction_type: InteractionType,
        workspace: Path,
        artifact_path: Path,
        provider: str,
    ) -> PendingInteraction:
        resolved = resolve_artifact_path(workspace, artifact_path)
        return cls(
            gate_id=gate_id,
            interaction_type=interaction_type,
            artifact_path=resolved,
            digest_sha256=sha256_file(resolved),
            provider=provider,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate_id": self.gate_id,
            "type": self.interaction_type.value,
            "artifact_path": str(self.artifact_path),
            "digest_sha256": self.digest_sha256,
            "provider": self.provider,
            "created_at": _timestamp(self.created_at),
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> PendingInteraction:
        if not isinstance(value, dict):
            raise ValueError("pending interaction must be an object")
        return cls(
            gate_id=value.get("gate_id"),
            interaction_type=value.get("type"),
            artifact_path=value.get("artifact_path"),
            digest_sha256=value.get("digest_sha256"),
            provider=value.get("provider"),
            created_at=value.get("created_at"),
        )


@dataclass(frozen=True)
class InteractionResult:
    """Validated decision returned by an interaction provider."""

    gate_id: str
    interaction_type: InteractionType
    outcome: InteractionOutcome
    artifact_path: Path
    digest_sha256: str
    provider: str
    decided_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    answers: dict[str, str] = field(default_factory=dict)
    feedback: str | None = None

    def __post_init__(self) -> None:
        parsed_type, path = _validate_common(
            self.gate_id,
            self.interaction_type,
            self.artifact_path,
            self.digest_sha256,
            self.provider,
        )
        try:
            outcome = InteractionOutcome(self.outcome)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"unknown interaction outcome: {self.outcome!r}") from exc
        if outcome not in _ALLOWED_OUTCOMES[parsed_type]:
            raise ValueError(f"outcome {outcome.value!r} is invalid for {parsed_type.value!r}")
        if not isinstance(self.answers, dict) or len(self.answers) > MAX_ANSWERS:
            raise ValueError("answers must be a bounded object")
        normalized_answers: dict[str, str] = {}
        for key, answer in self.answers.items():
            if not isinstance(key, str) or not key or len(key) > _MAX_GATE_ID_LENGTH:
                raise ValueError("answer IDs must be non-empty bounded strings")
            if not isinstance(answer, str) or len(answer.encode("utf-8")) > MAX_ANSWER_BYTES:
                raise ValueError(f"answer for {key!r} exceeds the size limit")
            normalized_answers[key] = answer
        if self.feedback is not None:
            if not isinstance(self.feedback, str):
                raise ValueError("feedback must be a string")
            if len(self.feedback.encode("utf-8")) > MAX_FEEDBACK_BYTES:
                raise ValueError("feedback exceeds the size limit")
        if outcome is InteractionOutcome.ANSWERS_SUBMITTED and self.feedback:
            raise ValueError("question results cannot contain feedback")
        if outcome is InteractionOutcome.CHANGES_REQUESTED and not self.feedback:
            raise ValueError("changes_requested requires feedback")
        object.__setattr__(self, "interaction_type", parsed_type)
        object.__setattr__(self, "outcome", outcome)
        object.__setattr__(self, "artifact_path", path)
        object.__setattr__(self, "decided_at", _parse_datetime(self.decided_at, "decided_at"))
        object.__setattr__(self, "answers", normalized_answers)

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate_id": self.gate_id,
            "type": self.interaction_type.value,
            "outcome": self.outcome.value,
            "artifact_path": str(self.artifact_path),
            "digest_sha256": self.digest_sha256,
            "provider": self.provider,
            "decided_at": _timestamp(self.decided_at),
            "answers": dict(self.answers),
            "feedback": self.feedback,
        }

    def to_audit_dict(self) -> dict[str, Any]:
        """Return metadata safe for AdapterResult.extra without response content."""
        value = self.to_dict()
        value["answer_ids"] = sorted(self.answers)
        value["answer_count"] = len(self.answers)
        value.pop("answers")
        if self.feedback is not None:
            encoded = self.feedback.encode("utf-8")
            value["feedback_bytes"] = len(encoded)
            value["feedback_sha256"] = hashlib.sha256(encoded).hexdigest()
        value.pop("feedback")
        return value

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> InteractionResult:
        if not isinstance(value, dict):
            raise ValueError("interaction result must be an object")
        return cls(
            gate_id=value.get("gate_id"),
            interaction_type=value.get("type"),
            outcome=value.get("outcome"),
            artifact_path=value.get("artifact_path"),
            digest_sha256=value.get("digest_sha256"),
            provider=value.get("provider"),
            decided_at=value.get("decided_at"),
            answers=value.get("answers", {}),
            feedback=value.get("feedback"),
        )


@runtime_checkable
class InteractionProvider(Protocol):
    """Provider contract shared by Kiro and future harnesses."""

    @property
    def name(self) -> str:
        """Stable provider identifier."""

    @property
    def evidence(self) -> dict[str, Any]:
        """Non-sensitive provenance and fallback evidence."""

    def interact(self, pending: PendingInteraction) -> InteractionResult:
        """Present one pending interaction and return a typed decision."""
