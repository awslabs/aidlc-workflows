"""Interactive Plannotator, manual, auto-fallback, and disabled providers."""

from __future__ import annotations

import json
import select
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from cli_harness.interaction import (
    MAX_FEEDBACK_BYTES,
    InteractionOutcome,
    InteractionResult,
    InteractionType,
    PendingInteraction,
    sha256_file,
)
from cli_harness.markdown_questions import (
    MarkdownQuestion,
    extract_submitted_answers,
    parse_questions,
    restore_canonical_content,
)
from cli_harness.provenance import ProvenanceEvidence, verify_plannotator

if TYPE_CHECKING:
    from cli_harness.adapter import AdapterConfig

_MAX_OUTPUT_BYTES = 1024 * 1024


def _result(
    pending: PendingInteraction,
    outcome: InteractionOutcome,
    *,
    provider: str,
    digest_sha256: str | None = None,
    answers: dict[str, str] | None = None,
    feedback: str | None = None,
) -> InteractionResult:
    return InteractionResult(
        gate_id=pending.gate_id,
        interaction_type=pending.interaction_type,
        outcome=outcome,
        artifact_path=pending.artifact_path,
        digest_sha256=digest_sha256 or pending.digest_sha256,
        provider=provider,
        answers=answers or {},
        feedback=feedback,
    )


class NoneInteractionProvider:
    """Fail-closed provider for explicitly disabled interaction."""

    name = "none"

    @property
    def evidence(self) -> dict[str, Any]:
        return {"mode": "none", "available": False, "reason": "interaction disabled"}

    def interact(self, pending: PendingInteraction) -> InteractionResult:
        return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)


class ManualInteractionProvider:
    """Safe terminal fallback requiring an explicit human decision."""

    name = "manual"

    def __init__(
        self,
        *,
        input_fn: Callable[[str], str] = input,
        output: Any = sys.stderr,
        timeout_seconds: int | None = None,
    ) -> None:
        self._input = input_fn
        self._output = output
        self._timeout = timeout_seconds

    @property
    def evidence(self) -> dict[str, Any]:
        return {"mode": "manual", "available": True}

    def _read(self, prompt: str) -> str:
        if self._timeout is None or self._input is not input:
            return self._input(prompt)
        print(prompt, end="", file=self._output, flush=True)
        if sys.platform == "win32":
            import msvcrt

            deadline = time.monotonic() + self._timeout
            characters: list[str] = []
            while time.monotonic() < deadline:
                if not msvcrt.kbhit():
                    time.sleep(0.05)
                    continue
                character = msvcrt.getwch()
                if character in {"\r", "\n"}:
                    print(file=self._output, flush=True)
                    return "".join(characters)
                if character == "\x03":
                    raise KeyboardInterrupt
                if character == "\b":
                    if characters:
                        characters.pop()
                    continue
                characters.append(character)
            raise TimeoutError("manual interaction timed out")

        readable, _, _ = select.select([sys.stdin], [], [], self._timeout)
        if not readable:
            raise TimeoutError("manual interaction timed out")
        line = sys.stdin.readline()
        if line == "":
            raise EOFError
        return line.rstrip("\r\n")

    def _ask(self, prompt: str) -> str:
        try:
            return self._read(prompt).strip().casefold()
        except (EOFError, KeyboardInterrupt, TimeoutError):
            return "cancel"

    def interact(self, pending: PendingInteraction) -> InteractionResult:
        print(
            f"\nManual {pending.interaction_type.value} gate: {pending.artifact_path}",
            file=self._output,
            flush=True,
        )
        if pending.interaction_type is InteractionType.QUESTIONS:
            try:
                before = parse_questions(pending.artifact_path)
                if sha256_file(pending.artifact_path) != pending.digest_sha256:
                    return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)
            except (OSError, UnicodeError, ValueError):
                return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)

            decision = self._ask("Edit the [Answer]: fields, then type 'submitted' (or 'cancel'): ")
            answers: dict[str, str] | None = None
            if decision == "submitted":
                try:
                    after = parse_questions(pending.artifact_path)
                    answers = extract_submitted_answers(before, after)
                except (OSError, UnicodeError, ValueError):
                    answers = None
            try:
                restore_canonical_content(
                    pending.artifact_path,
                    before.content,
                    workspace=pending.artifact_path.parent,
                )
            except (OSError, UnicodeError, ValueError, RuntimeError):
                return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)

            if decision != "submitted":
                return _result(pending, InteractionOutcome.CANCELLED, provider=self.name)
            if answers is None:
                return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)
            return _result(
                pending,
                InteractionOutcome.ANSWERS_SUBMITTED,
                provider=self.name,
                answers=answers,
            )

        decision = self._ask("Type 'approve', 'changes', or 'cancel': ")
        if decision == "approve":
            try:
                current_digest = sha256_file(pending.artifact_path)
            except (OSError, ValueError):
                return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)
            if current_digest != pending.digest_sha256:
                return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)
            return _result(pending, InteractionOutcome.APPROVED, provider=self.name)
        if decision == "changes":
            try:
                feedback = self._read("Describe the requested changes: ").strip()
            except (EOFError, KeyboardInterrupt, TimeoutError):
                feedback = ""
            if not feedback or len(feedback.encode("utf-8")) > MAX_FEEDBACK_BYTES:
                return _result(pending, InteractionOutcome.CANCELLED, provider=self.name)
            return _result(
                pending,
                InteractionOutcome.CHANGES_REQUESTED,
                provider=self.name,
                feedback=feedback,
            )
        return _result(pending, InteractionOutcome.CANCELLED, provider=self.name)


class PlannotatorInteractionProvider:
    """Present AI-DLC questions and approvals in Plannotator."""

    name = "plannotator"

    def __init__(
        self,
        *,
        executable: Path,
        workspace: Path,
        timeout_seconds: int,
        provenance: ProvenanceEvidence,
        run_command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        if not provenance.verified or provenance.digest_sha256 is None:
            raise ValueError("Plannotator provenance must be verified before provider creation")
        source = executable.resolve(strict=True)
        self._private_directory = tempfile.TemporaryDirectory(prefix="aidlc-plannotator-")
        private_executable = Path(self._private_directory.name) / "plannotator"
        try:
            shutil.copyfile(source, private_executable, follow_symlinks=False)
            private_executable.chmod(0o500)
            copied_digest = sha256_file(private_executable, max_bytes=256 * 1024 * 1024)
            if copied_digest != provenance.digest_sha256:
                raise ValueError("Plannotator changed while creating the verified copy")
        except Exception:
            self._private_directory.cleanup()
            raise
        self._executable = private_executable
        self._workspace = workspace.resolve(strict=True)
        self._timeout = timeout_seconds
        self._run_command = run_command
        self._provenance = provenance

    @property
    def evidence(self) -> dict[str, Any]:
        return self._provenance.to_dict()

    def _run(self, args: list[str], *, stdin: str | None = None) -> tuple[int, str, str]:
        try:
            if (
                self._provenance.digest_sha256 is None
                or sha256_file(self._executable, max_bytes=256 * 1024 * 1024)
                != self._provenance.digest_sha256
            ):
                return 2, "", "provider executable changed after verification"
            # nosec B603 - executable was resolved and verified; all arguments are structured
            completed = self._run_command(
                [str(self._executable), *args],
                cwd=str(self._workspace),
                input=stdin,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return 2, "", "provider unavailable or timed out"
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        if len(stdout.encode("utf-8")) > _MAX_OUTPUT_BYTES:
            return 2, "", "provider stdout exceeded the size limit"
        if len(stderr.encode("utf-8")) > _MAX_OUTPUT_BYTES:
            return 2, "", "provider stderr exceeded the size limit"
        return completed.returncode, stdout, stderr

    @staticmethod
    def _json(stdout: str) -> dict[str, Any]:
        if not stdout.strip():
            raise ValueError("Plannotator returned empty stdout")
        try:
            value = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise ValueError("Plannotator returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("Plannotator JSON must be an object")
        return value

    @staticmethod
    def _question_bundle(
        pending: PendingInteraction,
    ) -> tuple[dict[str, Any], dict[str, MarkdownQuestion]]:
        parsed = parse_questions(pending.artifact_path, workspace=pending.artifact_path.parent)
        questions = parsed.pending_questions
        if not questions:
            raise ValueError("question artifact has no unanswered questions")
        by_id = {question.question_id: question for question in questions}
        rendered_questions = []
        for question in questions:
            other_options = [option for option in question.options if option.is_other]
            if len(other_options) != 1:
                raise ValueError("question must declare exactly one Other option")
            rendered_questions.append(
                {
                    "id": question.question_id,
                    "prompt": question.prompt or question.heading,
                    "description": f"Source: {pending.artifact_path.name}",
                    "answerMode": "single-custom",
                    "recommendedAnswer": "",
                    "recommendedOptionIds": [],
                    "options": [
                        {"id": option.label, "label": option.text}
                        for option in question.options
                        if not option.is_other
                    ],
                    "required": True,
                }
            )
        bundle = {
            "stage": "interview",
            "title": parsed.title,
            "goalSlug": pending.gate_id.replace(":", "-").replace(".", "-"),
            "questions": rendered_questions,
        }
        return bundle, by_id

    @staticmethod
    def _parse_question_answers(
        value: dict[str, Any],
        questions: dict[str, MarkdownQuestion],
    ) -> dict[str, str]:
        if set(value) - {"decision", "stage", "result"}:
            raise ValueError("unexpected top-level interview fields")
        if value.get("decision") != "submitted" or value.get("stage") != "interview":
            raise ValueError("interview was not submitted")
        result = value.get("result")
        if not isinstance(result, dict) or set(result) != {"stage", "answers"}:
            raise ValueError("invalid interview result fields")
        if result.get("stage") != "interview":
            raise ValueError("invalid interview result")
        raw_answers = result.get("answers")
        if not isinstance(raw_answers, list) or len(raw_answers) != len(questions):
            raise ValueError("interview answer count mismatch")
        answers: dict[str, str] = {}
        allowed_answer_fields = {
            "questionId",
            "selectedOptionIds",
            "customAnswer",
            "answer",
            "completed",
        }
        for raw in raw_answers:
            if not isinstance(raw, dict) or set(raw) - allowed_answer_fields:
                raise ValueError("interview answer contains unexpected fields")
            question_id = raw.get("questionId")
            if question_id not in questions or question_id in answers:
                raise ValueError("unknown or duplicate questionId")
            if raw.get("completed") is not True:
                raise ValueError(f"question {question_id} is incomplete")
            selected = raw.get("selectedOptionIds")
            custom = raw.get("customAnswer", "")
            rendered_answer = raw.get("answer", "")
            if not isinstance(selected, list) or not all(
                isinstance(item, str) for item in selected
            ):
                raise ValueError("selectedOptionIds must be a string array")
            if not isinstance(custom, str) or not isinstance(rendered_answer, str):
                raise ValueError("customAnswer and answer must be strings")
            if "\n" in custom or "\r" in custom:
                raise ValueError("customAnswer must be a single line")
            question = questions[question_id]
            other_options = [option for option in question.options if option.is_other]
            if len(other_options) != 1:
                raise ValueError(f"question {question_id} must declare one Other option")
            valid_options = {
                option.label: option for option in question.options if not option.is_other
            }
            if len(selected) == 1 and selected[0] in valid_options and not custom.strip():
                answers[question_id] = selected[0]
                continue
            if not selected and custom.strip():
                answers[question_id] = f"{other_options[0].label}: {custom.strip()}"
                continue
            raise ValueError(f"question {question_id} must select one option or provide Other text")
        return answers

    def _questions(self, pending: PendingInteraction) -> InteractionResult:
        try:
            bundle, questions = self._question_bundle(pending)
            rc, stdout, _ = self._run(
                ["setup-goal", "interview", "-", "--json"],
                stdin=json.dumps(bundle, ensure_ascii=False),
            )
            if rc != 0:
                return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)
            answers = self._parse_question_answers(self._json(stdout), questions)
            return _result(
                pending,
                InteractionOutcome.ANSWERS_SUBMITTED,
                provider=self.name,
                answers=answers,
            )
        except (OSError, UnicodeError, ValueError):
            return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)

    def _approval(self, pending: PendingInteraction) -> InteractionResult:
        rc, stdout, _ = self._run(
            [
                "annotate",
                str(pending.artifact_path),
                "--gate",
                "--json",
                "--require-approval",
            ]
        )
        if rc not in {0, 1}:
            return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)
        try:
            value = self._json(stdout)
            if set(value) - {"decision", "feedback"}:
                raise ValueError("unexpected approval fields")
            decision = value.get("decision")
            feedback = value.get("feedback")
            if feedback is not None and not isinstance(feedback, str):
                raise ValueError("feedback must be a string")
            if decision == "approved":
                current_digest = sha256_file(pending.artifact_path)
                if current_digest != pending.digest_sha256 or rc != 0:
                    return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)
                return _result(pending, InteractionOutcome.APPROVED, provider=self.name)
            if decision == "annotated" and feedback:
                return _result(
                    pending,
                    InteractionOutcome.CHANGES_REQUESTED,
                    provider=self.name,
                    feedback=feedback,
                )
            if decision == "dismissed":
                return _result(pending, InteractionOutcome.CANCELLED, provider=self.name)
        except (OSError, ValueError):
            pass
        return _result(pending, InteractionOutcome.UNAVAILABLE, provider=self.name)

    def interact(self, pending: PendingInteraction) -> InteractionResult:
        if pending.interaction_type is InteractionType.QUESTIONS:
            return self._questions(pending)
        return self._approval(pending)


class AutoInteractionProvider:
    """Prefer verified Plannotator and safely fall back to manual interaction."""

    name = "auto"

    def __init__(
        self,
        *,
        plannotator: PlannotatorInteractionProvider | None,
        manual: ManualInteractionProvider,
        provenance: ProvenanceEvidence,
    ) -> None:
        self._plannotator = plannotator
        self._manual = manual
        self._provenance = provenance
        self._fallback_count = 0

    @property
    def evidence(self) -> dict[str, Any]:
        value = self._provenance.to_dict()
        value.update({"mode": "auto", "fallback_count": self._fallback_count})
        return value

    def interact(self, pending: PendingInteraction) -> InteractionResult:
        if self._plannotator is not None:
            result = self._plannotator.interact(pending)
            if result.outcome not in {
                InteractionOutcome.CANCELLED,
                InteractionOutcome.UNAVAILABLE,
            }:
                return result
        self._fallback_count += 1
        return self._manual.interact(pending)


def build_interaction_provider(
    config: AdapterConfig,
    workspace: Path,
    *,
    manual_input: Callable[[str], str] = input,
) -> (
    NoneInteractionProvider
    | ManualInteractionProvider
    | PlannotatorInteractionProvider
    | AutoInteractionProvider
):
    """Build the configured provider and enforce provenance policy."""
    mode = config.interaction_provider
    if mode == "none":
        return NoneInteractionProvider()
    manual = ManualInteractionProvider(
        input_fn=manual_input,
        timeout_seconds=config.interaction_timeout_seconds,
    )
    if mode == "manual":
        return manual
    provenance = verify_plannotator(
        verification=config.plannotator_verification,
        expected_sha256=config.plannotator_sha256,
        cwd=workspace,
        timeout_seconds=config.interaction_timeout_seconds,
    )
    plannotator = None
    if provenance.verified and provenance.executable_path is not None:
        plannotator = PlannotatorInteractionProvider(
            executable=provenance.executable_path,
            workspace=workspace,
            timeout_seconds=config.interaction_timeout_seconds,
            provenance=provenance,
        )
    if mode == "plannotator":
        if plannotator is None:
            raise RuntimeError(f"Plannotator verification failed: {provenance.reason}")
        return plannotator
    if mode == "auto":
        return AutoInteractionProvider(
            plannotator=plannotator,
            manual=manual,
            provenance=provenance,
        )
    raise ValueError(f"unknown interaction provider: {mode}")
