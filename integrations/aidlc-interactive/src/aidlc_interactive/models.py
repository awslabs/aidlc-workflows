"""Typed, provider-neutral interaction models."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class InteractionType(StrEnum):
    QUESTIONNAIRE = "questionnaire"
    REVIEW = "review"


class Decision(StrEnum):
    SUBMITTED = "submitted"
    APPROVED = "approved"
    CHANGES_REQUESTED = "changes_requested"


class ResultStatus(StrEnum):
    COMPLETED = "completed"
    FALLBACK_REQUIRED = "fallback_required"
    FAILED = "failed"


_ALLOWED_DECISIONS = {
    InteractionType.QUESTIONNAIRE: {Decision.SUBMITTED},
    InteractionType.REVIEW: {Decision.APPROVED, Decision.CHANGES_REQUESTED},
}


@dataclass(frozen=True)
class Availability:
    available: bool
    provider: str
    reason_code: str
    executable: str | None = None
    verified: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "provider": self.provider,
            "reason_code": self.reason_code,
            "verified": self.verified,
        }


@dataclass(frozen=True)
class InteractionRequest:
    interaction_id: str
    interaction_type: InteractionType
    workspace: Path
    artifact_path: Path
    artifact_relative: str
    presented_sha256: str
    timeout_seconds: int

    def __post_init__(self) -> None:
        if not self.interaction_id or len(self.interaction_id) > 160:
            raise ValueError("interaction_id is empty or too long")
        if not self.workspace.is_absolute() or not self.artifact_path.is_absolute():
            raise ValueError("workspace and artifact paths must be absolute")
        if not _SHA256_RE.fullmatch(self.presented_sha256):
            raise ValueError("presented_sha256 must be lowercase SHA-256")
        if not 1 <= self.timeout_seconds <= 7200:
            raise ValueError("timeout_seconds must be between 1 and 7200")


@dataclass(frozen=True)
class ProviderResult:
    status: ResultStatus
    interaction_type: InteractionType
    provider: str
    interaction_id: str
    artifact_relative: str
    presented_sha256: str
    decision: Decision | None = None
    current_sha256: str | None = None
    reason_code: str = "completed"
    answers: dict[str, str] = field(default_factory=dict, repr=False)
    feedback: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.status is ResultStatus.COMPLETED:
            if self.decision not in _ALLOWED_DECISIONS[self.interaction_type]:
                raise ValueError("decision is invalid for this interaction type")
        elif self.decision is not None:
            raise ValueError("non-completed results cannot carry a decision")
        if self.current_sha256 is not None and not _SHA256_RE.fullmatch(self.current_sha256):
            raise ValueError("current_sha256 must be lowercase SHA-256")
        if self.interaction_type is InteractionType.QUESTIONNAIRE and self.feedback:
            raise ValueError("questionnaire results cannot contain feedback")
        if self.decision is Decision.CHANGES_REQUESTED and not self.feedback:
            raise ValueError("changes_requested requires feedback")

    @classmethod
    def fallback(
        cls,
        request: InteractionRequest,
        provider: str,
        reason_code: str,
    ) -> ProviderResult:
        return cls(
            status=ResultStatus.FALLBACK_REQUIRED,
            interaction_type=request.interaction_type,
            provider=provider,
            interaction_id=request.interaction_id,
            artifact_relative=request.artifact_relative,
            presented_sha256=request.presented_sha256,
            reason_code=reason_code,
        )

    def to_dict(self, *, include_feedback: bool = True) -> dict[str, Any]:
        value: dict[str, Any] = {
            "schema_version": 1,
            "interaction": self.interaction_type.value,
            "status": self.status.value,
            "decision": self.decision.value if self.decision else None,
            "provider": self.provider,
            "interaction_id": self.interaction_id,
            "artifact": self.artifact_relative,
            "presented_sha256": self.presented_sha256,
            "current_sha256": self.current_sha256,
            "reason_code": self.reason_code,
        }
        if self.answers:
            value["answer_count"] = len(self.answers)
        if include_feedback and self.feedback is not None:
            value["feedback"] = self.feedback
        return value
