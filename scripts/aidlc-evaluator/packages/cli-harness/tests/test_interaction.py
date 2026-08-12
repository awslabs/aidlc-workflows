"""Tests for typed interaction models and serialization properties."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from cli_harness.interaction import (
    InteractionOutcome,
    InteractionResult,
    InteractionType,
    PendingInteraction,
    resolve_artifact_path,
)
from hypothesis import given, seed, settings
from hypothesis import strategies as st


def test_pending_interaction_round_trip(tmp_path: Path) -> None:
    artifact = tmp_path / "plan.md"
    artifact.write_text("# Plan\n", encoding="utf-8")
    pending = PendingInteraction.create(
        gate_id="approval:abc123",
        interaction_type=InteractionType.APPROVAL,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="manual",
    )
    assert PendingInteraction.from_dict(pending.to_dict()) == pending


@seed(20260812)
@settings(max_examples=50)
@given(answer=st.text(alphabet=st.characters(blacklist_categories=("Cs",)), max_size=200))
def test_result_serialization_round_trip(answer: str) -> None:
    artifact = (Path.cwd() / "hypothesis-questions.md").resolve()
    result = InteractionResult(
        gate_id="questions:roundtrip",
        interaction_type=InteractionType.QUESTIONS,
        outcome=InteractionOutcome.ANSWERS_SUBMITTED,
        artifact_path=artifact,
        digest_sha256="a" * 64,
        provider="plannotator",
        decided_at=datetime(2026, 8, 12, tzinfo=UTC),
        answers={"q-1": answer},
    )
    assert InteractionResult.from_dict(result.to_dict()) == result


def test_unknown_outcome_is_rejected(tmp_path: Path) -> None:
    artifact = (tmp_path / "plan.md").resolve()
    artifact.write_text("# Plan\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unknown interaction outcome"):
        InteractionResult(
            gate_id="approval:unknown",
            interaction_type=InteractionType.APPROVAL,
            outcome="silently_approved",  # type: ignore[arg-type]
            artifact_path=artifact,
            digest_sha256="b" * 64,
            provider="unsafe",
        )


def test_invalid_transition_is_rejected(tmp_path: Path) -> None:
    artifact = (tmp_path / "questions.md").resolve()
    artifact.write_text("# Questions\n", encoding="utf-8")
    with pytest.raises(ValueError, match="invalid for"):
        InteractionResult(
            gate_id="questions:bad-transition",
            interaction_type=InteractionType.QUESTIONS,
            outcome=InteractionOutcome.APPROVED,
            artifact_path=artifact,
            digest_sha256="c" * 64,
            provider="manual",
        )


def test_workspace_escape_is_rejected(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("outside", encoding="utf-8")
    with pytest.raises(ValueError, match="outside workspace"):
        resolve_artifact_path(workspace, outside)


_VALID_TRANSITIONS = (
    (InteractionType.QUESTIONS, InteractionOutcome.ANSWERS_SUBMITTED),
    (InteractionType.QUESTIONS, InteractionOutcome.CANCELLED),
    (InteractionType.QUESTIONS, InteractionOutcome.UNAVAILABLE),
    (InteractionType.APPROVAL, InteractionOutcome.APPROVED),
    (InteractionType.APPROVAL, InteractionOutcome.CHANGES_REQUESTED),
    (InteractionType.APPROVAL, InteractionOutcome.CANCELLED),
    (InteractionType.APPROVAL, InteractionOutcome.UNAVAILABLE),
)


@seed(20260812)
@settings(max_examples=35)
@given(transition=st.sampled_from(_VALID_TRANSITIONS), digest=st.binary(min_size=32, max_size=32))
def test_valid_transition_serialization_property(
    transition: tuple[InteractionType, InteractionOutcome],
    digest: bytes,
) -> None:
    interaction_type, outcome = transition
    result = InteractionResult(
        gate_id="property:transition",
        interaction_type=interaction_type,
        outcome=outcome,
        artifact_path=(Path.cwd() / "property-artifact.md").resolve(),
        digest_sha256=digest.hex(),
        provider="property",
        feedback="revise" if outcome is InteractionOutcome.CHANGES_REQUESTED else None,
    )

    assert InteractionResult.from_dict(result.to_dict()) == result


def test_gate_ids_are_nonce_bound_and_result_matching_checks_all_bindings(
    tmp_path: Path,
) -> None:
    from dataclasses import replace
    from datetime import timedelta

    from cli_harness.interaction import create_gate_id, result_matches_pending

    artifact = tmp_path / "plan.md"
    artifact.write_text("# Plan\n", encoding="utf-8")
    first = create_gate_id(InteractionType.APPROVAL, artifact, tmp_path)
    second = create_gate_id(InteractionType.APPROVAL, artifact, tmp_path)
    assert first != second
    assert first.startswith("approval:")

    pending = PendingInteraction.create(
        gate_id=first,
        interaction_type=InteractionType.APPROVAL,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="plannotator",
    )
    matching = InteractionResult(
        gate_id=pending.gate_id,
        interaction_type=pending.interaction_type,
        outcome=InteractionOutcome.APPROVED,
        artifact_path=pending.artifact_path,
        digest_sha256=pending.digest_sha256,
        provider=pending.provider,
        decided_at=pending.created_at,
    )
    assert result_matches_pending(pending, matching)
    assert not result_matches_pending(pending, replace(matching, gate_id="approval:other"))
    assert not result_matches_pending(pending, replace(matching, digest_sha256="0" * 64))
    assert not result_matches_pending(pending, replace(matching, provider="other"))
    assert not result_matches_pending(
        pending,
        replace(matching, decided_at=pending.created_at - timedelta(microseconds=1)),
    )
