"""Fail-closed orchestration for workspace-scoped AI-DLC MCP gates."""

from __future__ import annotations

import base64
import hashlib
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

from cli_harness.interaction import (
    InteractionOutcome,
    InteractionProvider,
    InteractionType,
    PendingInteraction,
    create_gate_id,
    resolve_artifact_path,
    result_matches_pending,
    sha256_file,
)
from cli_harness.interaction_providers import PlannotatorInteractionProvider
from cli_harness.markdown_questions import apply_answers_atomic, parse_questions
from cli_harness.provenance import PLANNOTATOR_REPOSITORY, verify_plannotator

_MAX_PATH_CHARS = 4096
_MAX_TIMEOUT_SECONDS = 7200
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_PROTECTED_ARTIFACTS = {"aidlc-state.md", "audit.md"}


class GateToolOutcome(StrEnum):
    """Privacy-safe outcomes returned through MCP."""

    ANSWERS_SUBMITTED = "answers_submitted"
    APPROVED = "approved"
    CHANGES_REQUESTED = "changes_requested"
    BLOCKED_MANUAL_REQUIRED = "blocked_manual_required"


class GateLedgerState(StrEnum):
    """Legal process-local ledger states."""

    ACTIVE = "active"
    CONSUMED = "consumed"
    ABANDONED = "abandoned"


@dataclass(frozen=True)
class GateReviewConfig:
    """Trusted launch configuration for one workspace MCP server."""

    workspace: Path
    verification: str = "attestation"
    expected_sha256: str | None = None
    timeout_seconds: int = 1800

    def __post_init__(self) -> None:
        workspace = self.workspace.resolve(strict=True)
        if not workspace.is_dir():
            raise ValueError("workspace must be a directory")
        if self.verification not in {"attestation", "checksum"}:
            raise ValueError("verification must be attestation or checksum")
        expected = self.expected_sha256
        if self.verification == "checksum":
            if not expected or not _SHA256_RE.fullmatch(expected):
                raise ValueError("checksum verification requires a valid SHA-256")
            expected = expected.lower()
        elif expected is not None:
            raise ValueError("expected SHA-256 is valid only in checksum mode")
        if (
            not isinstance(self.timeout_seconds, int)
            or isinstance(self.timeout_seconds, bool)
            or not 1 <= self.timeout_seconds <= _MAX_TIMEOUT_SECONDS
        ):
            raise ValueError(f"timeout must be between 1 and {_MAX_TIMEOUT_SECONDS} seconds")
        object.__setattr__(self, "workspace", workspace)
        object.__setattr__(self, "expected_sha256", expected)


@dataclass(frozen=True)
class GateToolResponse:
    """Closed response projection with bounded, encoded reviewer feedback."""

    outcome: GateToolOutcome
    reason_code: str
    interaction_type: str | None = None
    artifact_path: str | None = None
    gate_id: str | None = None
    presented_sha256: str | None = None
    current_sha256: str | None = None
    provider: str | None = None
    answer_count: int | None = None
    feedback_bytes: int | None = None
    feedback_sha256: str | None = None
    feedback_base64: str | None = None
    plannotator_version: str | None = None
    plannotator_sha256: str | None = None
    verification: str | None = None

    @property
    def blocking(self) -> bool:
        return self.outcome is GateToolOutcome.BLOCKED_MANUAL_REQUIRED

    def to_dict(self) -> dict[str, Any]:
        value = {
            "outcome": self.outcome.value,
            "reason_code": self.reason_code,
            "blocking": self.blocking,
            "interaction_type": self.interaction_type,
            "artifact_path": self.artifact_path,
            "gate_id": self.gate_id,
            "presented_sha256": self.presented_sha256,
            "current_sha256": self.current_sha256,
            "provider": self.provider,
            "answer_count": self.answer_count,
            "feedback_bytes": self.feedback_bytes,
            "feedback_sha256": self.feedback_sha256,
            "feedback_base64": self.feedback_base64,
            "plannotator_version": self.plannotator_version,
            "plannotator_sha256": self.plannotator_sha256,
            "verification": self.verification,
        }
        return {key: item for key, item in value.items() if item is not None}


class GateLedger:
    """Thread-safe single-consumption state for gates in this MCP process."""

    def __init__(self) -> None:
        self._states: dict[str, GateLedgerState] = {}
        self._lock = threading.Lock()

    def begin(self, gate_id: str) -> None:
        with self._lock:
            if gate_id in self._states:
                raise ValueError("gate ID was already registered")
            self._states[gate_id] = GateLedgerState.ACTIVE

    def consume(self, gate_id: str) -> None:
        self._transition(gate_id, GateLedgerState.CONSUMED)

    def abandon(self, gate_id: str) -> None:
        self._transition(gate_id, GateLedgerState.ABANDONED)

    def _transition(self, gate_id: str, target: GateLedgerState) -> None:
        with self._lock:
            if self._states.get(gate_id) is not GateLedgerState.ACTIVE:
                raise ValueError("gate is not active")
            self._states[gate_id] = target

    def state(self, gate_id: str) -> GateLedgerState | None:
        with self._lock:
            return self._states.get(gate_id)


class GateConcurrencyGuard:
    """Non-blocking single-flight guard for browser interactions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def try_acquire(self) -> bool:
        return self._lock.acquire(blocking=False)

    def release(self) -> None:
        self._lock.release()


class _GateBlockedError(Exception):
    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


class _ProviderManager:
    """Lazily create one verified private Plannotator provider per process."""

    def __init__(self, config: GateReviewConfig) -> None:
        self._config = config
        self._provider: InteractionProvider | None = None
        self._lock = threading.Lock()

    def get(self) -> InteractionProvider:
        with self._lock:
            if self._provider is not None:
                return self._provider
            evidence = verify_plannotator(
                verification=self._config.verification,
                expected_sha256=self._config.expected_sha256,
                cwd=self._config.workspace,
                timeout_seconds=self._config.timeout_seconds,
            )
            if not evidence.verified or evidence.executable_path is None:
                raise _GateBlockedError("provenance_failed")
            self._provider = PlannotatorInteractionProvider(
                executable=evidence.executable_path,
                workspace=self._config.workspace,
                timeout_seconds=self._config.timeout_seconds,
                provenance=evidence,
            )
            return self._provider


ProviderFactory = Callable[[], InteractionProvider]
DiagnosticSink = Callable[[str], None]


class GateReviewService:
    """Run one fully bound human gate and return only privacy-safe metadata."""

    def __init__(
        self,
        config: GateReviewConfig,
        *,
        provider_factory: ProviderFactory | None = None,
        ledger: GateLedger | None = None,
        concurrency: GateConcurrencyGuard | None = None,
        diagnostic: DiagnosticSink | None = None,
    ) -> None:
        self._config = config
        manager = _ProviderManager(config)
        self._provider_factory = provider_factory or manager.get
        self._ledger = ledger or GateLedger()
        self._concurrency = concurrency or GateConcurrencyGuard()
        self._diagnostic = diagnostic or (lambda _message: None)

    @property
    def ledger(self) -> GateLedger:
        return self._ledger

    def review(self, interaction_type: str, artifact_path: str) -> GateToolResponse:
        """Review an explicit AI-DLC artifact; every exceptional path blocks."""
        safe_type = (
            interaction_type
            if isinstance(interaction_type, str) and interaction_type in {"questions", "approval"}
            else None
        )
        if not self._concurrency.try_acquire():
            return self._blocked("busy", interaction_type=safe_type)

        pending: PendingInteraction | None = None
        relative_path: str | None = None
        try:
            parsed_type = self._validate_type(interaction_type)
            artifact, relative_path = self._validate_artifact(artifact_path)
            if parsed_type is InteractionType.QUESTIONS:
                parsed = parse_questions(artifact, workspace=self._config.workspace)
                if not parsed.pending_questions:
                    raise _GateBlockedError("no_pending_questions")

            provider = self._provider_factory()
            if provider.name != "plannotator":
                raise _GateBlockedError("provider_not_allowed")
            pending = PendingInteraction.create(
                gate_id=create_gate_id(parsed_type, artifact, self._config.workspace),
                interaction_type=parsed_type,
                workspace=self._config.workspace,
                artifact_path=artifact,
                provider=provider.name,
            )
            self._ledger.begin(pending.gate_id)
            decision = provider.interact(pending)

            if not result_matches_pending(pending, decision, require_digest=True):
                raise _GateBlockedError("binding_mismatch")
            if sha256_file(pending.artifact_path) != pending.digest_sha256:
                raise _GateBlockedError("stale_artifact")

            if parsed_type is InteractionType.QUESTIONS:
                response = self._complete_questions(pending, decision, provider, relative_path)
            else:
                response = self._complete_approval(pending, decision, provider, relative_path)
            self._ledger.consume(pending.gate_id)
            return response
        except _GateBlockedError as exc:
            return self._blocked(
                exc.reason_code,
                interaction_type=safe_type,
                artifact_path=relative_path,
                pending=pending,
            )
        except (OSError, UnicodeError, ValueError, RuntimeError) as exc:
            self._diagnostic(f"gate blocked by {type(exc).__name__}")
            return self._blocked(
                "internal_error",
                interaction_type=safe_type,
                artifact_path=relative_path,
                pending=pending,
            )
        except Exception as exc:  # pragma: no cover - defensive MCP boundary
            self._diagnostic(f"gate blocked by unexpected {type(exc).__name__}")
            return self._blocked(
                "internal_error",
                interaction_type=safe_type,
                artifact_path=relative_path,
                pending=pending,
            )
        finally:
            if (
                pending is not None
                and self._ledger.state(pending.gate_id) is GateLedgerState.ACTIVE
            ):
                self._ledger.abandon(pending.gate_id)
            self._concurrency.release()

    @staticmethod
    def _validate_type(interaction_type: str) -> InteractionType:
        if not isinstance(interaction_type, str):
            raise _GateBlockedError("invalid_interaction_type")
        try:
            return InteractionType(interaction_type)
        except ValueError as exc:
            raise _GateBlockedError("invalid_interaction_type") from exc

    def _validate_artifact(self, artifact_path: str) -> tuple[Path, str]:
        if (
            not isinstance(artifact_path, str)
            or not artifact_path
            or len(artifact_path) > _MAX_PATH_CHARS
        ):
            raise _GateBlockedError("invalid_artifact_path")
        supplied = Path(artifact_path)
        if supplied.is_absolute():
            raise _GateBlockedError("invalid_artifact_path")
        try:
            artifact = resolve_artifact_path(self._config.workspace, supplied)
        except (OSError, ValueError) as exc:
            raise _GateBlockedError("artifact_outside_workspace") from exc
        relative = artifact.relative_to(self._config.workspace)
        if (
            artifact.suffix.lower() != ".md"
            or artifact.name in _PROTECTED_ARTIFACTS
            or "aidlc-docs" not in relative.parts
        ):
            raise _GateBlockedError("artifact_not_reviewable")
        try:
            sha256_file(artifact)
        except (OSError, ValueError) as exc:
            raise _GateBlockedError("artifact_not_reviewable") from exc
        return artifact, relative.as_posix()

    def _complete_questions(
        self,
        pending: PendingInteraction,
        decision: Any,
        provider: InteractionProvider,
        relative_path: str,
    ) -> GateToolResponse:
        if decision.outcome is InteractionOutcome.CANCELLED:
            raise _GateBlockedError("cancelled")
        if decision.outcome is InteractionOutcome.UNAVAILABLE:
            raise _GateBlockedError("provider_unavailable")
        if decision.outcome is not InteractionOutcome.ANSWERS_SUBMITTED or not decision.answers:
            raise _GateBlockedError("invalid_result")
        reparsed = apply_answers_atomic(
            pending.artifact_path,
            decision.answers,
            workspace=self._config.workspace,
            expected_sha256=pending.digest_sha256,
        )
        if reparsed.pending_questions:
            raise _GateBlockedError("answers_incomplete")
        return self._success(
            GateToolOutcome.ANSWERS_SUBMITTED,
            pending,
            provider,
            relative_path,
            current_sha256=sha256_file(pending.artifact_path),
            answer_count=len(decision.answers),
        )

    def _complete_approval(
        self,
        pending: PendingInteraction,
        decision: Any,
        provider: InteractionProvider,
        relative_path: str,
    ) -> GateToolResponse:
        if decision.outcome is InteractionOutcome.CANCELLED:
            raise _GateBlockedError("cancelled")
        if decision.outcome is InteractionOutcome.UNAVAILABLE:
            raise _GateBlockedError("provider_unavailable")
        if decision.outcome is InteractionOutcome.APPROVED:
            return self._success(
                GateToolOutcome.APPROVED,
                pending,
                provider,
                relative_path,
                current_sha256=pending.digest_sha256,
            )
        if decision.outcome is InteractionOutcome.CHANGES_REQUESTED and decision.feedback:
            encoded = decision.feedback.encode("utf-8")
            return self._success(
                GateToolOutcome.CHANGES_REQUESTED,
                pending,
                provider,
                relative_path,
                current_sha256=pending.digest_sha256,
                feedback_bytes=len(encoded),
                feedback_sha256=hashlib.sha256(encoded).hexdigest(),
                feedback_base64=base64.b64encode(encoded).decode("ascii"),
            )
        raise _GateBlockedError("invalid_result")

    @staticmethod
    def _evidence(provider: InteractionProvider) -> dict[str, str | None]:
        evidence = provider.evidence
        return {
            "plannotator_version": evidence.get("version"),
            "plannotator_sha256": evidence.get("digest_sha256"),
            "verification": evidence.get("verification"),
        }

    def _success(
        self,
        outcome: GateToolOutcome,
        pending: PendingInteraction,
        provider: InteractionProvider,
        relative_path: str,
        *,
        current_sha256: str,
        answer_count: int | None = None,
        feedback_bytes: int | None = None,
        feedback_sha256: str | None = None,
        feedback_base64: str | None = None,
    ) -> GateToolResponse:
        return GateToolResponse(
            outcome=outcome,
            reason_code="completed",
            interaction_type=pending.interaction_type.value,
            artifact_path=relative_path,
            gate_id=pending.gate_id,
            presented_sha256=pending.digest_sha256,
            current_sha256=current_sha256,
            provider=pending.provider,
            answer_count=answer_count,
            feedback_bytes=feedback_bytes,
            feedback_sha256=feedback_sha256,
            feedback_base64=feedback_base64,
            **self._evidence(provider),
        )

    @staticmethod
    def _blocked(
        reason_code: str,
        *,
        interaction_type: str | None = None,
        artifact_path: str | None = None,
        pending: PendingInteraction | None = None,
    ) -> GateToolResponse:
        return GateToolResponse(
            outcome=GateToolOutcome.BLOCKED_MANUAL_REQUIRED,
            reason_code=reason_code,
            interaction_type=interaction_type,
            artifact_path=artifact_path,
            gate_id=pending.gate_id if pending else None,
            presented_sha256=pending.digest_sha256 if pending else None,
            provider=pending.provider if pending else None,
        )


__all__ = [
    "GateConcurrencyGuard",
    "GateLedger",
    "GateLedgerState",
    "GateReviewConfig",
    "GateReviewService",
    "GateToolOutcome",
    "GateToolResponse",
    "PLANNOTATOR_REPOSITORY",
]
