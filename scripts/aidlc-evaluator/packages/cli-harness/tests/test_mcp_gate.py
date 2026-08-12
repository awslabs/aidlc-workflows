"""Example and property-based tests for the fail-closed MCP gate service."""

from __future__ import annotations

import base64
import json
import subprocess
import tempfile
from dataclasses import replace
from pathlib import Path

import pytest
from cli_harness.interaction import (
    InteractionOutcome,
    InteractionResult,
    InteractionType,
    PendingInteraction,
    result_matches_pending,
    sha256_file,
)
from cli_harness.interaction_providers import PlannotatorInteractionProvider
from cli_harness.mcp_gate import (
    GateConcurrencyGuard,
    GateLedger,
    GateLedgerState,
    GateReviewConfig,
    GateReviewService,
)
from cli_harness.provenance import ProvenanceEvidence
from hypothesis import given, seed, settings
from hypothesis import strategies as st

QUESTION = """# Decisions

## Question 1
Choose one.

A) Alpha

B) Beta

X) Other

[Answer]:
"""


def _question_document(count: int) -> str:
    blocks = []
    for number in range(1, count + 1):
        blocks.append(
            f"""## Question {number}
Choose {number}.

A) Alpha

B) Beta

X) Other

[Answer]:
"""
        )
    return "# Decisions\n\n" + "\n".join(blocks)


class FakeProvider:
    name = "plannotator"
    evidence = {
        "verified": True,
        "version": "1.2.3",
        "digest_sha256": "f" * 64,
        "verification": "attestation",
    }

    def __init__(self, outcome: InteractionOutcome | None = None) -> None:
        self.outcome = outcome
        self.calls: list[PendingInteraction] = []

    def interact(self, pending: PendingInteraction) -> InteractionResult:
        self.calls.append(pending)
        outcome = self.outcome or (
            InteractionOutcome.ANSWERS_SUBMITTED
            if pending.interaction_type is InteractionType.QUESTIONS
            else InteractionOutcome.APPROVED
        )
        answers = {}
        if outcome is InteractionOutcome.ANSWERS_SUBMITTED:
            from cli_harness.markdown_questions import parse_questions

            parsed = parse_questions(pending.artifact_path, workspace=pending.artifact_path.parent)
            answers = {question.question_id: "A" for question in parsed.pending_questions}
        return InteractionResult(
            gate_id=pending.gate_id,
            interaction_type=pending.interaction_type,
            outcome=outcome,
            artifact_path=pending.artifact_path,
            digest_sha256=pending.digest_sha256,
            provider=self.name,
            answers=answers,
            feedback="revise this" if outcome is InteractionOutcome.CHANGES_REQUESTED else None,
        )


def _service(tmp_path: Path, provider: FakeProvider) -> GateReviewService:
    return GateReviewService(
        GateReviewConfig(workspace=tmp_path),
        provider_factory=lambda: provider,
    )


def _docs_path(tmp_path: Path, name: str) -> Path:
    path = tmp_path / "aidlc-docs" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def test_nested_twenty_question_interview_is_applied_atomically(tmp_path: Path) -> None:
    nested = tmp_path / "stack-sense-v3" / "aidlc-docs" / "inception" / "requirements"
    nested.mkdir(parents=True)
    artifact = nested / "requirement-verification-questions.md"
    original = _question_document(20)
    artifact.write_text(original, encoding="utf-8")
    provider = FakeProvider()

    response = _service(tmp_path, provider).review(
        "questions",
        str(artifact.relative_to(tmp_path)),
    )

    assert response.outcome.value == "answers_submitted"
    assert response.answer_count == 20
    assert response.artifact_path == str(artifact.relative_to(tmp_path))
    assert response.presented_sha256 != response.current_sha256
    updated = artifact.read_text(encoding="utf-8")
    assert updated.count("[Answer]:A") == 20
    assert updated.replace("[Answer]:A", "[Answer]:") == original
    assert provider.calls[0].interaction_type is InteractionType.QUESTIONS


def test_approval_and_requested_changes_are_digest_bound_and_private(tmp_path: Path) -> None:
    artifact = _docs_path(tmp_path, "plan.md")
    artifact.write_text("# Plan\n", encoding="utf-8")
    approved = _service(tmp_path, FakeProvider()).review("approval", "aidlc-docs/plan.md")
    requested = _service(
        tmp_path,
        FakeProvider(InteractionOutcome.CHANGES_REQUESTED),
    ).review("approval", "aidlc-docs/plan.md")

    assert approved.outcome.value == "approved"
    assert approved.presented_sha256 == approved.current_sha256
    assert requested.outcome.value == "changes_requested"
    assert requested.feedback_bytes == len("revise this".encode())
    assert requested.feedback_sha256
    assert requested.feedback_base64
    assert base64.b64decode(requested.feedback_base64).decode("utf-8") == "revise this"
    serialized = json.dumps(requested.to_dict())
    assert "revise this" not in serialized
    assert str(tmp_path) not in serialized


@pytest.mark.parametrize(
    ("interaction_type", "artifact_path", "reason"),
    [
        ("unknown", "aidlc-docs/plan.md", "invalid_interaction_type"),
        ("approval", "../outside.md", "artifact_outside_workspace"),
        ("approval", "plan.md", "artifact_not_reviewable"),
        ("approval", "aidlc-docs/aidlc-state.md", "artifact_not_reviewable"),
        ("approval", "aidlc-docs/audit.md", "artifact_not_reviewable"),
        ("approval", "aidlc-docs/notes.txt", "artifact_not_reviewable"),
    ],
)
def test_invalid_requests_fail_closed(
    tmp_path: Path,
    interaction_type: str,
    artifact_path: str,
    reason: str,
) -> None:
    _docs_path(tmp_path, "plan.md").write_text("# Plan\n", encoding="utf-8")
    (tmp_path / "plan.md").write_text("# Unrelated root document\n", encoding="utf-8")
    _docs_path(tmp_path, "aidlc-state.md").write_text("# State\n", encoding="utf-8")
    _docs_path(tmp_path, "audit.md").write_text("# Audit\n", encoding="utf-8")
    _docs_path(tmp_path, "notes.txt").write_text("notes\n", encoding="utf-8")
    response = _service(tmp_path, FakeProvider()).review(interaction_type, artifact_path)
    assert response.blocking
    assert response.reason_code == reason


def test_symlink_escape_and_completed_question_file_are_rejected(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside-gate.md"
    outside.write_text("# Outside\n", encoding="utf-8")
    link = _docs_path(tmp_path, "link.md")
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks unavailable")
    completed = _docs_path(tmp_path, "questions.md")
    completed.write_text(QUESTION.replace("[Answer]:", "[Answer]: A"), encoding="utf-8")

    escaped = _service(tmp_path, FakeProvider()).review("approval", "aidlc-docs/link.md")
    no_pending = _service(tmp_path, FakeProvider()).review("questions", "aidlc-docs/questions.md")
    assert escaped.reason_code == "artifact_outside_workspace"
    assert no_pending.reason_code == "no_pending_questions"


def test_busy_request_has_no_provider_or_ledger_side_effect(tmp_path: Path) -> None:
    artifact = _docs_path(tmp_path, "plan.md")
    artifact.write_text("# Plan\n", encoding="utf-8")
    provider = FakeProvider()
    guard = GateConcurrencyGuard()
    assert guard.try_acquire()
    service = GateReviewService(
        GateReviewConfig(workspace=tmp_path),
        provider_factory=lambda: provider,
        concurrency=guard,
    )

    response = service.review("approval", "aidlc-docs/plan.md")
    guard.release()
    assert response.reason_code == "busy"
    assert provider.calls == []


@pytest.mark.parametrize(
    ("outcome", "reason"),
    [
        (InteractionOutcome.CANCELLED, "cancelled"),
        (InteractionOutcome.UNAVAILABLE, "provider_unavailable"),
    ],
)
def test_provider_failures_block_and_cleanup_allows_next_request(
    tmp_path: Path,
    outcome: InteractionOutcome,
    reason: str,
) -> None:
    artifact = _docs_path(tmp_path, "plan.md")
    artifact.write_text("# Plan\n", encoding="utf-8")
    provider = FakeProvider(outcome)
    service = _service(tmp_path, provider)

    first = service.review("approval", "aidlc-docs/plan.md")
    provider.outcome = InteractionOutcome.APPROVED
    second = service.review("approval", "aidlc-docs/plan.md")
    assert first.reason_code == reason
    assert second.outcome.value == "approved"
    assert service.ledger.state(provider.calls[0].gate_id) is GateLedgerState.ABANDONED
    assert service.ledger.state(provider.calls[1].gate_id) is GateLedgerState.CONSUMED


def test_stale_artifact_and_binding_mismatch_are_rejected(tmp_path: Path) -> None:
    artifact = _docs_path(tmp_path, "plan.md")
    artifact.write_text("# Plan\n", encoding="utf-8")

    class MutatingProvider(FakeProvider):
        def interact(self, pending: PendingInteraction) -> InteractionResult:
            result = super().interact(pending)
            pending.artifact_path.write_text("# Changed\n", encoding="utf-8")
            return result

    stale = _service(tmp_path, MutatingProvider()).review("approval", "aidlc-docs/plan.md")
    artifact.write_text("# Plan\n", encoding="utf-8")

    class MismatchingProvider(FakeProvider):
        def interact(self, pending: PendingInteraction) -> InteractionResult:
            return replace(super().interact(pending), digest_sha256="0" * 64)

    mismatch = _service(tmp_path, MismatchingProvider()).review("approval", "aidlc-docs/plan.md")
    assert stale.reason_code == "stale_artifact"
    assert mismatch.reason_code == "binding_mismatch"


def test_unexpected_provider_exception_is_bounded_and_fail_closed(tmp_path: Path) -> None:
    artifact = _docs_path(tmp_path, "plan.md")
    artifact.write_text("# Plan\n", encoding="utf-8")
    diagnostics: list[str] = []

    def explode():
        raise RuntimeError(f"secret path: {tmp_path}")

    service = GateReviewService(
        GateReviewConfig(workspace=tmp_path),
        provider_factory=explode,
        diagnostic=diagnostics.append,
    )
    response = service.review("approval", "aidlc-docs/plan.md")
    assert response.reason_code == "internal_error"
    assert str(tmp_path) not in json.dumps(response.to_dict())
    assert diagnostics == ["gate blocked by RuntimeError"]


def test_real_provider_dispatches_questions_to_interview_and_approval_to_annotate(
    tmp_path: Path,
) -> None:
    executable = tmp_path / "plannotator"
    executable.write_bytes(b"verified executable")
    executable.chmod(0o500)
    digest = sha256_file(executable, max_bytes=256 * 1024 * 1024)
    evidence = ProvenanceEvidence(
        executable_path=executable,
        version="1.2.3",
        digest_sha256=digest,
        verification="checksum",
        verified=True,
        reason="checksum verified",
    )
    questions = _docs_path(tmp_path, "questions.md")
    questions.write_text(QUESTION, encoding="utf-8")
    approval = _docs_path(tmp_path, "plan.md")
    approval.write_text("# Plan\n", encoding="utf-8")
    calls: list[list[str]] = []

    def run_command(command, **_kwargs):
        calls.append(command)
        if "setup-goal" in command:
            output = {
                "decision": "submitted",
                "stage": "interview",
                "result": {
                    "stage": "interview",
                    "answers": [
                        {
                            "questionId": "q-1",
                            "completed": True,
                            "selectedOptionIds": ["A"],
                            "customAnswer": "",
                        }
                    ],
                },
            }
            return subprocess.CompletedProcess(command, 0, json.dumps(output), "")
        return subprocess.CompletedProcess(
            command,
            0,
            json.dumps({"decision": "approved", "feedback": None}),
            "",
        )

    provider = PlannotatorInteractionProvider(
        executable=executable,
        workspace=tmp_path,
        timeout_seconds=30,
        provenance=evidence,
        run_command=run_command,
    )
    question_pending = PendingInteraction.create(
        gate_id="questions:dispatch",
        interaction_type=InteractionType.QUESTIONS,
        workspace=tmp_path,
        artifact_path=questions,
        provider=provider.name,
    )
    approval_pending = PendingInteraction.create(
        gate_id="approval:dispatch",
        interaction_type=InteractionType.APPROVAL,
        workspace=tmp_path,
        artifact_path=approval,
        provider=provider.name,
    )

    assert provider.interact(question_pending).outcome is InteractionOutcome.ANSWERS_SUBMITTED
    assert provider.interact(approval_pending).outcome is InteractionOutcome.APPROVED
    assert calls[0][1:] == ["setup-goal", "interview", "-", "--json"]
    assert "annotate" not in calls[0]
    assert calls[1][1:] == [
        "annotate",
        str(approval),
        "--gate",
        "--json",
        "--require-approval",
    ]


@seed(20260812)
@settings(max_examples=40)
@given(commands=st.lists(st.sampled_from(("consume", "abandon")), min_size=1, max_size=20))
def test_ledger_stateful_transition_property(commands: list[str]) -> None:
    ledger = GateLedger()
    gate_id = "approval:stateful"
    ledger.begin(gate_id)
    model = GateLedgerState.ACTIVE
    for command in commands:
        target = GateLedgerState.CONSUMED if command == "consume" else GateLedgerState.ABANDONED
        if model is GateLedgerState.ACTIVE:
            getattr(ledger, command)(gate_id)
            model = target
        else:
            with pytest.raises(ValueError, match="not active"):
                getattr(ledger, command)(gate_id)
        assert ledger.state(gate_id) is model


@seed(20260812)
@settings(max_examples=35)
@given(field=st.sampled_from(("gate_id", "digest_sha256", "provider", "artifact_path")))
def test_binding_mutation_property(field: str) -> None:
    with tempfile.TemporaryDirectory() as directory:
        workspace = Path(directory)
        artifact = workspace / "plan.md"
        artifact.write_text("# Plan\n", encoding="utf-8")
        other = workspace / "other.md"
        other.write_text("# Other\n", encoding="utf-8")
        pending = PendingInteraction.create(
            gate_id="approval:binding",
            interaction_type=InteractionType.APPROVAL,
            workspace=workspace,
            artifact_path=artifact,
            provider="plannotator",
        )
        result = InteractionResult(
            gate_id=pending.gate_id,
            interaction_type=pending.interaction_type,
            outcome=InteractionOutcome.APPROVED,
            artifact_path=pending.artifact_path,
            digest_sha256=pending.digest_sha256,
            provider=pending.provider,
        )
        mutations = {
            "gate_id": "approval:other",
            "digest_sha256": "0" * 64,
            "provider": "other",
            "artifact_path": other.resolve(),
        }
        assert not result_matches_pending(pending, replace(result, **{field: mutations[field]}))
