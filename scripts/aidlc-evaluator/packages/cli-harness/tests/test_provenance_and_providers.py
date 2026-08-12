"""Tests for Plannotator provenance, JSON validation, and safe fallback outcomes."""

import hashlib
import io
import json
import subprocess
from pathlib import Path

import pytest
from cli_harness.interaction import InteractionOutcome, InteractionType, PendingInteraction
from cli_harness.interaction_providers import (
    ManualInteractionProvider,
    PlannotatorInteractionProvider,
)
from cli_harness.provenance import ProvenanceEvidence, verify_plannotator


def _executable(tmp_path: Path) -> Path:
    path = tmp_path / "plannotator"
    path.write_text("#!/bin/sh\necho 'plannotator test'\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def _evidence(executable: Path) -> ProvenanceEvidence:
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    return ProvenanceEvidence(executable, "test", digest, "checksum", True, "ok")


def test_checksum_verification_records_path_version_and_digest(
    tmp_path: Path,
    monkeypatch,
) -> None:
    executable = _executable(tmp_path)
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    monkeypatch.setattr(
        "cli_harness.provenance.shutil.which",
        lambda name: str(executable) if name == "plannotator" else None,
    )
    evidence = verify_plannotator(
        verification="checksum",
        expected_sha256=digest,
        cwd=tmp_path,
        timeout_seconds=5,
    )
    assert evidence.verified
    assert evidence.executable_path == executable.resolve()
    assert evidence.digest_sha256 == digest
    assert evidence.version == "plannotator test"


def test_altered_binary_fails_checksum(tmp_path: Path, monkeypatch) -> None:
    executable = _executable(tmp_path)
    monkeypatch.setattr("cli_harness.provenance.shutil.which", lambda _: str(executable))
    evidence = verify_plannotator(
        verification="checksum",
        expected_sha256="0" * 64,
        cwd=tmp_path,
        timeout_seconds=5,
    )
    assert not evidence.verified
    assert evidence.reason == "checksum mismatch"


def test_plannotator_custom_answer_maps_to_declared_other_label(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    artifact = tmp_path / "questions.md"
    artifact.write_text(
        "# Questions\n\n## Question 1\nMode?\n\nA) Fast\n\nX) Other\n\n[Answer]: \n",
        encoding="utf-8",
    )
    pending = PendingInteraction.create(
        gate_id="questions:test",
        interaction_type=InteractionType.QUESTIONS,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="plannotator",
    )
    payload = {
        "decision": "submitted",
        "stage": "interview",
        "result": {
            "stage": "interview",
            "answers": [
                {
                    "questionId": "q-1",
                    "selectedOptionIds": [],
                    "customAnswer": "custom mode",
                    "answer": "custom mode",
                    "completed": True,
                }
            ],
        },
    }

    seen_executables: list[Path] = []

    def run_command(command, **_kwargs):
        seen_executables.append(Path(command[0]))
        return subprocess.CompletedProcess([], 0, json.dumps(payload), "")

    evidence = _evidence(executable)
    provider = PlannotatorInteractionProvider(
        executable=executable,
        workspace=tmp_path,
        timeout_seconds=5,
        provenance=evidence,
        run_command=run_command,
    )
    bundle, _ = provider._question_bundle(pending)
    assert [option["id"] for option in bundle["questions"][0]["options"]] == ["A"]

    result = provider.interact(pending)
    assert result.outcome is InteractionOutcome.ANSWERS_SUBMITTED
    assert result.answers == {"q-1": "X: custom mode"}
    assert seen_executables[0] != executable
    assert hashlib.sha256(seen_executables[0].read_bytes()).hexdigest() == evidence.digest_sha256


def test_plannotator_rejects_unknown_nested_fields(tmp_path: Path) -> None:
    artifact = tmp_path / "questions.md"
    artifact.write_text(
        "# Questions\n\n## Question 1\nMode?\n\nA) Fast\n\nX) Other\n\n[Answer]:\n",
        encoding="utf-8",
    )
    pending = PendingInteraction.create(
        gate_id="questions:strict-json",
        interaction_type=InteractionType.QUESTIONS,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="plannotator",
    )
    _, questions = PlannotatorInteractionProvider._question_bundle(pending)
    payload = {
        "decision": "submitted",
        "stage": "interview",
        "result": {
            "stage": "interview",
            "answers": [
                {
                    "questionId": "q-1",
                    "selectedOptionIds": ["A"],
                    "customAnswer": "",
                    "completed": True,
                }
            ],
            "unexpected": "field",
        },
    }

    with pytest.raises(ValueError, match="result fields"):
        PlannotatorInteractionProvider._parse_question_answers(payload, questions)

    payload["result"].pop("unexpected")
    payload["result"]["answers"][0]["unexpected"] = "field"
    with pytest.raises(ValueError, match="unexpected fields"):
        PlannotatorInteractionProvider._parse_question_answers(payload, questions)


def test_invalid_json_and_manual_eof_never_approve(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    artifact = tmp_path / "plan.md"
    artifact.write_text("# Plan\n", encoding="utf-8")
    pending = PendingInteraction.create(
        gate_id="approval:test",
        interaction_type=InteractionType.APPROVAL,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="plannotator",
    )
    evidence = _evidence(executable)
    provider = PlannotatorInteractionProvider(
        executable=executable,
        workspace=tmp_path,
        timeout_seconds=5,
        provenance=evidence,
        run_command=lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, "not-json", ""),
    )
    assert provider.interact(pending).outcome is InteractionOutcome.UNAVAILABLE

    manual = ManualInteractionProvider(input_fn=lambda _prompt: (_ for _ in ()).throw(EOFError()))
    assert manual.interact(pending).outcome is InteractionOutcome.CANCELLED


def test_stale_digest_rejects_approval(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    artifact = tmp_path / "plan.md"
    artifact.write_text("# Plan v1\n", encoding="utf-8")
    pending = PendingInteraction.create(
        gate_id="approval:stale",
        interaction_type=InteractionType.APPROVAL,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="plannotator",
    )
    artifact.write_text("# Plan v2\n", encoding="utf-8")
    evidence = _evidence(executable)
    provider = PlannotatorInteractionProvider(
        executable=executable,
        workspace=tmp_path,
        timeout_seconds=5,
        provenance=evidence,
        run_command=lambda *_args, **_kwargs: subprocess.CompletedProcess(
            [], 0, '{"decision":"approved"}', ""
        ),
    )
    assert provider.interact(pending).outcome is InteractionOutcome.UNAVAILABLE


def test_checksum_mismatch_never_executes_untrusted_binary(
    tmp_path: Path,
    monkeypatch,
) -> None:
    marker = tmp_path / "executed"
    executable = tmp_path / "plannotator"
    executable.write_text(
        f"#!/bin/sh\ntouch '{marker}'\necho malicious\n",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    monkeypatch.setattr("cli_harness.provenance.shutil.which", lambda _: str(executable))

    evidence = verify_plannotator(
        verification="checksum",
        expected_sha256="0" * 64,
        cwd=tmp_path,
        timeout_seconds=5,
    )

    assert not evidence.verified
    assert evidence.reason == "checksum mismatch"
    assert not marker.exists()


def test_manual_timeout_is_cancelled_fail_closed(
    tmp_path: Path,
    monkeypatch,
) -> None:
    artifact = tmp_path / "plan.md"
    artifact.write_text("# Plan\n", encoding="utf-8")
    pending = PendingInteraction.create(
        gate_id="approval:timeout",
        interaction_type=InteractionType.APPROVAL,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="manual",
    )
    monkeypatch.setattr(
        "cli_harness.interaction_providers.select.select",
        lambda *_args, **_kwargs: ([], [], []),
    )
    provider = ManualInteractionProvider(output=io.StringIO(), timeout_seconds=1)

    assert provider.interact(pending).outcome is InteractionOutcome.CANCELLED


def test_version_check_executes_digest_matched_private_copy(
    tmp_path: Path,
    monkeypatch,
) -> None:
    executable = _executable(tmp_path)
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    commands: list[list[str]] = []
    monkeypatch.setattr(
        "cli_harness.provenance.shutil.which",
        lambda name: str(executable) if name == "plannotator" else None,
    )

    def run_command(command, **_kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, "plannotator test", "")

    monkeypatch.setattr("cli_harness.provenance.subprocess.run", run_command)
    evidence = verify_plannotator(
        verification="checksum",
        expected_sha256=digest,
        cwd=tmp_path,
        timeout_seconds=5,
    )

    assert evidence.verified
    assert Path(commands[0][0]) != executable
    assert Path(commands[0][0]).name == "plannotator"


def test_attestation_and_version_use_the_same_private_snapshot(
    tmp_path: Path,
    monkeypatch,
) -> None:
    executable = _executable(tmp_path)
    gh = tmp_path / "gh"
    gh.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    gh.chmod(0o755)
    commands: list[list[str]] = []
    monkeypatch.setattr(
        "cli_harness.provenance.shutil.which",
        lambda name: str(executable) if name == "plannotator" else str(gh),
    )

    def run_command(command, **_kwargs):
        commands.append(command)
        stdout = "plannotator test" if command[1] == "--version" else "verified"
        return subprocess.CompletedProcess(command, 0, stdout, "")

    monkeypatch.setattr("cli_harness.provenance.subprocess.run", run_command)
    evidence = verify_plannotator(
        verification="attestation",
        expected_sha256=None,
        cwd=tmp_path,
        timeout_seconds=5,
    )

    assert evidence.verified
    attested_snapshot = Path(commands[0][3])
    versioned_snapshot = Path(commands[1][0])
    assert attested_snapshot == versioned_snapshot
    assert attested_snapshot != executable


def test_manual_questions_restore_original_and_return_only_answers(tmp_path: Path) -> None:
    artifact = tmp_path / "questions.md"
    original = "# Questions\n\n## Decision\nPick.\n\nA) Alpha\n\n[Answer]:\n"
    artifact.write_text(original, encoding="utf-8")
    pending = PendingInteraction.create(
        gate_id="questions:manual",
        interaction_type=InteractionType.QUESTIONS,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="manual",
    )

    def submit(_prompt: str) -> str:
        artifact.write_text(original.replace("[Answer]:", "[Answer]: A"), encoding="utf-8")
        return "submitted"

    result = ManualInteractionProvider(input_fn=submit).interact(pending)

    assert result.outcome is InteractionOutcome.ANSWERS_SUBMITTED
    assert result.answers == {"q-1": "A"}
    assert artifact.read_text(encoding="utf-8") == original


def test_manual_questions_reject_and_restore_out_of_span_edits(tmp_path: Path) -> None:
    artifact = tmp_path / "questions.md"
    original = "# Questions\n\n## Decision\nPick.\n\nA) Alpha\n\n[Answer]:\n"
    artifact.write_text(original, encoding="utf-8")
    pending = PendingInteraction.create(
        gate_id="questions:corruption",
        interaction_type=InteractionType.QUESTIONS,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="manual",
    )

    def corrupt(_prompt: str) -> str:
        artifact.write_text(
            original.replace("## Decision", "## CORRUPTED").replace("[Answer]:", "[Answer]: A"),
            encoding="utf-8",
        )
        return "submitted"

    result = ManualInteractionProvider(input_fn=corrupt).interact(pending)

    assert result.outcome is InteractionOutcome.UNAVAILABLE
    assert artifact.read_text(encoding="utf-8") == original


def test_plannotator_rejects_multiline_custom_answer(tmp_path: Path) -> None:
    artifact = tmp_path / "questions.md"
    artifact.write_text(
        "# Questions\n\n## Decision\nPick.\n\nX) Other\n\n[Answer]:\n",
        encoding="utf-8",
    )
    pending = PendingInteraction.create(
        gate_id="questions:multiline",
        interaction_type=InteractionType.QUESTIONS,
        workspace=tmp_path,
        artifact_path=artifact,
        provider="plannotator",
    )
    bundle, questions = PlannotatorInteractionProvider._question_bundle(pending)
    assert bundle["questions"]
    payload = {
        "decision": "submitted",
        "stage": "interview",
        "result": {
            "stage": "interview",
            "answers": [
                {
                    "questionId": "q-1",
                    "selectedOptionIds": ["X"],
                    "customAnswer": "payload\n\n## Injected\n[Answer]: forged",
                    "completed": True,
                }
            ],
        },
    }

    with pytest.raises(ValueError, match="single line"):
        PlannotatorInteractionProvider._parse_question_answers(payload, questions)
