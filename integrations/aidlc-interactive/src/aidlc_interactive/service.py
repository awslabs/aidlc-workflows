"""Provider-neutral interaction orchestration."""

from __future__ import annotations

import hashlib
import secrets
import sys
from pathlib import Path

from aidlc_interactive.config import InteractionConfig, load_config
from aidlc_interactive.markdown.questions import apply_answers, parse_questionnaire
from aidlc_interactive.models import (
    InteractionRequest,
    InteractionType,
    ProviderResult,
    ResultStatus,
)
from aidlc_interactive.registry import get_provider
from aidlc_interactive.security import (
    protected_artifact_digests,
    resolve_artifact,
    resolve_workspace,
    sha256_file,
)

_EXPECTED_PROVIDER_ERRORS = (OSError, UnicodeError, ValueError)
_EXPECTED_UPDATE_ERRORS = (OSError, RuntimeError, UnicodeError, ValueError)


def _interaction_id(interaction_type: InteractionType, relative: str, digest: str) -> str:
    nonce = secrets.token_hex(16)
    source = f"{interaction_type.value}:{relative}:{digest}:{nonce}".encode()
    return f"{interaction_type.value}:{hashlib.sha256(source).hexdigest()[:32]}"


def build_request(
    workspace: Path,
    artifact: Path,
    interaction_type: InteractionType,
    config: InteractionConfig,
) -> InteractionRequest:
    root = resolve_workspace(workspace)
    resolved, relative = resolve_artifact(root, artifact)
    digest = sha256_file(resolved)
    return InteractionRequest(
        interaction_id=_interaction_id(interaction_type, relative, digest),
        interaction_type=interaction_type,
        workspace=root,
        artifact_path=resolved,
        artifact_relative=relative,
        presented_sha256=digest,
        timeout_seconds=config.timeout_seconds,
    )


def _fallback(request: InteractionRequest, provider: str, reason: str) -> ProviderResult:
    return ProviderResult.fallback(request, provider, reason)


def _result_is_bound(result: ProviderResult, request: InteractionRequest, provider: str) -> bool:
    return (
        result.interaction_id == request.interaction_id
        and result.interaction_type is request.interaction_type
        and result.artifact_relative == request.artifact_relative
        and result.presented_sha256 == request.presented_sha256
        and result.provider == provider
    )


def interact(
    workspace: Path,
    artifact: Path,
    interaction_type: InteractionType,
    *,
    config: InteractionConfig | None = None,
    interactive_session: bool | None = None,
) -> ProviderResult:
    selected = config or load_config(workspace)[0]
    request = build_request(workspace, artifact, interaction_type, selected)
    if selected.mode == "markdown":
        return _fallback(request, selected.provider, "markdown_mode")
    if interactive_session is None:
        interactive_session = sys.stdin.isatty() and sys.stdout.isatty()
    if not interactive_session:
        return _fallback(request, selected.provider, "non_interactive_session")
    try:
        provider = get_provider(selected.provider, selected)
    except ValueError:
        return _fallback(request, selected.provider, "unknown_provider")
    try:
        availability = provider.is_available()
    except _EXPECTED_PROVIDER_ERRORS:
        return _fallback(request, selected.provider, "provider_unavailable")
    if not availability.available:
        return _fallback(request, selected.provider, availability.reason_code)
    try:
        protected_before = protected_artifact_digests(request.workspace)
        result = (
            provider.show_questionnaire(request)
            if interaction_type is InteractionType.QUESTIONNAIRE
            else provider.show_review(request)
        )
        protected_after = protected_artifact_digests(request.workspace)
    except _EXPECTED_PROVIDER_ERRORS:
        return _fallback(request, selected.provider, "provider_error")
    if protected_after != protected_before:
        return _fallback(request, selected.provider, "protected_artifact_changed")
    if not isinstance(result, ProviderResult) or not _result_is_bound(
        result, request, selected.provider
    ):
        return _fallback(request, selected.provider, "binding_mismatch")
    if result.status is not ResultStatus.COMPLETED:
        return result
    try:
        if sha256_file(request.artifact_path) != request.presented_sha256:
            return _fallback(request, selected.provider, "stale_artifact")
    except _EXPECTED_PROVIDER_ERRORS:
        return _fallback(request, selected.provider, "artifact_validation_failed")
    if interaction_type is InteractionType.QUESTIONNAIRE:
        try:
            parsed = parse_questionnaire(request.workspace, Path(request.artifact_relative))
            updated = apply_answers(
                parsed,
                result.answers,
                expected_sha256=request.presented_sha256,
            )
            current_sha256 = sha256_file(updated.path)
        except _EXPECTED_UPDATE_ERRORS:
            return _fallback(request, selected.provider, "canonical_update_failed")
        return ProviderResult(
            status=result.status,
            interaction_type=result.interaction_type,
            provider=result.provider,
            interaction_id=result.interaction_id,
            artifact_relative=result.artifact_relative,
            presented_sha256=result.presented_sha256,
            current_sha256=current_sha256,
            decision=result.decision,
            reason_code=result.reason_code,
            answers=result.answers,
        )
    return ProviderResult(
        status=result.status,
        interaction_type=result.interaction_type,
        provider=result.provider,
        interaction_id=result.interaction_id,
        artifact_relative=result.artifact_relative,
        presented_sha256=result.presented_sha256,
        current_sha256=request.presented_sha256,
        decision=result.decision,
        reason_code=result.reason_code,
        feedback=result.feedback,
    )
