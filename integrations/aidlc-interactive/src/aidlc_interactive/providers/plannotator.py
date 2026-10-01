"""Plannotator interaction provider."""

from __future__ import annotations

import json
import os
import shutil
import subprocess  # nosec B404 — required for fixed, shell-free provider executables.
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from aidlc_interactive.config import InteractionConfig
from aidlc_interactive.markdown.questions import MarkdownQuestion, parse_questionnaire
from aidlc_interactive.models import (
    Availability,
    Decision,
    InteractionRequest,
    InteractionType,
    ProviderResult,
    ResultStatus,
)
from aidlc_interactive.security import (
    MAX_ANSWER_BYTES,
    MAX_FEEDBACK_BYTES,
    MAX_PROVIDER_OUTPUT_BYTES,
    sha256_file,
)

_REPOSITORY = "backnotprop/plannotator"
_ARTIFACT_SNAPSHOT = "{artifact_snapshot}"
_READ_CHUNK_BYTES = 64 * 1024


@dataclass(frozen=True)
class _ProcessResult:
    returncode: int | None
    stdout: str = ""
    reason_code: str | None = None


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def _bounded_process(
    command: list[str],
    *,
    cwd: Path,
    stdin_text: str | None,
    timeout_seconds: int,
    environment: dict[str, str] | None = None,
) -> _ProcessResult:
    input_path: Path | None = None
    input_stream: BinaryIO | None = None
    if stdin_text is not None:
        input_path = cwd / ".provider-input.json"
        input_path.write_text(stdin_text, encoding="utf-8")
        input_path.chmod(0o400)
        input_stream = input_path.open("rb")
    try:
        try:
            # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
            process = subprocess.Popen(  # nosec B603 — resolved executable, fixed arguments
                command,
                cwd=str(cwd),
                env=environment,
                stdin=input_stream if input_stream is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
            )
        except OSError:
            return _ProcessResult(None, reason_code="provider_unavailable")
        if process.stdout is None or process.stderr is None:
            _stop_process(process)
            return _ProcessResult(None, reason_code="provider_unavailable")

        overflow = threading.Event()
        stdout = bytearray()
        stderr = bytearray()

        def drain(stream: BinaryIO, destination: bytearray) -> None:
            descriptor = stream.fileno()
            while True:
                try:
                    chunk = os.read(descriptor, _READ_CHUNK_BYTES)
                except OSError:
                    return
                if not chunk:
                    return
                remaining = MAX_PROVIDER_OUTPUT_BYTES - len(destination)
                if remaining > 0:
                    destination.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    overflow.set()
                    return

        readers = (
            threading.Thread(target=drain, args=(process.stdout, stdout), daemon=True),
            threading.Thread(target=drain, args=(process.stderr, stderr), daemon=True),
        )
        for reader in readers:
            reader.start()

        deadline = time.monotonic() + timeout_seconds
        reason_code: str | None = None
        while process.poll() is None:
            if overflow.is_set():
                reason_code = "provider_output_too_large"
                _stop_process(process)
                break
            if time.monotonic() >= deadline:
                reason_code = "provider_timeout"
                _stop_process(process)
                break
            time.sleep(0.01)
        for reader in readers:
            reader.join(timeout=2)
        if any(reader.is_alive() for reader in readers):
            _stop_process(process)
            for reader in readers:
                reader.join(timeout=1)
        process.stdout.close()
        process.stderr.close()
        if any(reader.is_alive() for reader in readers):
            return _ProcessResult(None, reason_code="provider_unavailable")
        if overflow.is_set():
            reason_code = "provider_output_too_large"
        if reason_code is not None:
            return _ProcessResult(process.returncode, reason_code=reason_code)
        try:
            decoded = stdout.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return _ProcessResult(process.returncode, reason_code="invalid_provider_result")
        return _ProcessResult(process.returncode, stdout=decoded)
    finally:
        if input_stream is not None:
            input_stream.close()
        if input_path is not None:
            input_path.unlink(missing_ok=True)


def _sandbox_available() -> bool:
    if sys.platform == "darwin":
        return Path("/usr/bin/sandbox-exec").is_file()
    if sys.platform.startswith("linux"):
        return shutil.which("bwrap") is not None
    return False


def _sandbox_literal(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace('"', '\\"')


def _sandbox_command(
    executable: Path,
    args: list[str],
    *,
    workspace: Path,
    session_directory: Path,
) -> list[str] | None:
    if sys.platform == "darwin":
        sandbox = Path("/usr/bin/sandbox-exec")
        if not sandbox.is_file():
            return None
        workspace_literal = _sandbox_literal(workspace)
        profile = (
            "(version 1) (allow default) "
            f'(deny file-read* (subpath "{workspace_literal}")) '
            f'(deny file-write* (subpath "{workspace_literal}"))'
        )
        return [str(sandbox), "-p", profile, str(executable), *args]
    if sys.platform.startswith("linux"):
        sandbox = shutil.which("bwrap")
        if sandbox is None:
            return None
        return [
            str(Path(sandbox).resolve()),
            "--die-with-parent",
            "--new-session",
            "--unshare-all",
            "--share-net",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--bind",
            str(session_directory),
            str(session_directory),
            "--tmpfs",
            str(workspace),
            "--chdir",
            str(session_directory),
            str(executable),
            *args,
        ]
    return None


def _provider_environment(session_directory: Path) -> dict[str, str]:
    allowed = {
        "DBUS_SESSION_BUS_ADDRESS",
        "DISPLAY",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "PATH",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    home = session_directory / "home"
    home.mkdir(mode=0o700)
    environment.update(
        {
            "HOME": str(home),
            "PWD": str(session_directory),
            "TMPDIR": str(session_directory),
        }
    )
    return environment


class PlannotatorProvider:
    provider_id = "plannotator"

    def __init__(self, config: InteractionConfig) -> None:
        self._config = config

    @classmethod
    def from_config(cls, config: InteractionConfig) -> PlannotatorProvider:
        return cls(config)

    def is_available(self) -> Availability:
        executable = shutil.which("plannotator")
        if executable is None:
            return Availability(False, self.provider_id, "provider_not_found")
        if not _sandbox_available():
            return Availability(False, self.provider_id, "provider_sandbox_unavailable")
        return Availability(
            True,
            self.provider_id,
            "provider_detected",
            executable=str(Path(executable).resolve()),
            verified=False,
        )

    def _verified_snapshot(self, directory: Path) -> tuple[Path | None, str]:
        executable = shutil.which("plannotator")
        if executable is None:
            return None, "provider_not_found"
        source = Path(executable).resolve(strict=True)
        snapshot = directory / (
            "plannotator.exe" if source.suffix.lower() == ".exe" else "plannotator"
        )
        shutil.copyfile(source, snapshot, follow_symlinks=False)
        snapshot.chmod(0o500)
        digest = sha256_file(snapshot, max_bytes=256 * 1024 * 1024)
        verification = self._config.verification
        expected = self._config.plannotator_sha256
        if verification == "checksum" or expected:
            if expected is None or digest != expected:
                return None, "checksum_mismatch"
            return snapshot, "checksum_verified"
        if verification in {"auto", "attestation"}:
            gh = shutil.which("gh")
            if gh is None:
                if verification == "attestation":
                    return None, "attestation_tool_not_found"
                return snapshot, "local_snapshot_verified"
            result = _bounded_process(
                [
                    str(Path(gh).resolve()),
                    "attestation",
                    "verify",
                    str(snapshot),
                    "--repo",
                    _REPOSITORY,
                ],
                cwd=directory,
                stdin_text=None,
                timeout_seconds=min(self._config.timeout_seconds, 60),
            )
            if result.reason_code is None and result.returncode == 0:
                return snapshot, "attestation_verified"
            if verification == "attestation":
                return None, result.reason_code or "attestation_failed"
            return snapshot, "local_snapshot_verified"
        return snapshot, "verification_disabled"

    def _run(
        self,
        request: InteractionRequest,
        args: list[str],
        *,
        stdin: str | None = None,
        snapshot_artifact: bool = False,
    ) -> _ProcessResult:
        with tempfile.TemporaryDirectory(prefix="aidlc-plannotator-") as directory:
            root = Path(directory)
            provider_directory = root / "provider"
            session_directory = root / "session"
            provider_directory.mkdir(mode=0o700)
            session_directory.mkdir(mode=0o700)
            executable, reason = self._verified_snapshot(provider_directory)
            if executable is None:
                return _ProcessResult(None, reason_code=reason)
            artifact_snapshot: Path | None = None
            if snapshot_artifact:
                artifact_snapshot = session_directory / "artifact.md"
                shutil.copyfile(request.artifact_path, artifact_snapshot, follow_symlinks=False)
                artifact_snapshot.chmod(0o400)
                if sha256_file(artifact_snapshot) != request.presented_sha256:
                    return _ProcessResult(None, reason_code="stale_artifact")
            resolved_args = [
                str(artifact_snapshot) if value == _ARTIFACT_SNAPSHOT else value for value in args
            ]
            command = _sandbox_command(
                executable,
                resolved_args,
                workspace=request.workspace,
                session_directory=session_directory,
            )
            if command is None:
                return _ProcessResult(None, reason_code="provider_sandbox_unavailable")
            return _bounded_process(
                command,
                cwd=session_directory,
                stdin_text=stdin,
                timeout_seconds=request.timeout_seconds,
                environment=_provider_environment(session_directory),
            )

    @staticmethod
    def _json(stdout: str) -> dict[str, Any]:
        try:
            value = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise ValueError("provider returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("provider JSON must be an object")
        return value

    @staticmethod
    def _bundle(request: InteractionRequest) -> tuple[dict[str, Any], dict[str, MarkdownQuestion]]:
        parsed = parse_questionnaire(request.workspace, Path(request.artifact_relative))
        pending = parsed.pending_questions
        if not pending:
            raise ValueError("questionnaire has no pending questions")
        by_id = {question.question_id: question for question in pending}
        questions = []
        for question in pending:
            questions.append(
                {
                    "id": question.question_id,
                    "prompt": question.prompt or question.heading,
                    "description": f"Source: {request.artifact_relative}",
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
        return (
            {
                "stage": "interview",
                "title": parsed.title,
                "goalSlug": request.interaction_id.replace(":", "-"),
                "questions": questions,
            },
            by_id,
        )

    @staticmethod
    def _answers(value: dict[str, Any], questions: dict[str, MarkdownQuestion]) -> dict[str, str]:
        if set(value) - {"decision", "stage", "result"}:
            raise ValueError("provider returned unexpected interview fields")
        if value.get("decision") != "submitted" or value.get("stage") != "interview":
            raise ValueError("interview was not submitted")
        result = value.get("result")
        allowed_result = {"stage", "answers", "title", "goalSlug"}
        required_result = {"stage", "answers"}
        if (
            not isinstance(result, dict)
            or set(result) - allowed_result
            or not required_result.issubset(result)
        ):
            raise ValueError("provider returned invalid interview result")
        if any(
            field in result and not isinstance(result[field], str)
            for field in ("title", "goalSlug")
        ):
            raise ValueError("provider returned invalid interview metadata")
        raw_answers = result.get("answers")
        if result.get("stage") != "interview" or not isinstance(raw_answers, list):
            raise ValueError("provider returned invalid answers")
        if len(raw_answers) != len(questions):
            raise ValueError("provider answer count mismatch")
        answers: dict[str, str] = {}
        allowed = {"questionId", "selectedOptionIds", "customAnswer", "answer", "completed"}
        for raw in raw_answers:
            if not isinstance(raw, dict) or set(raw) - allowed:
                raise ValueError("provider answer contains unexpected fields")
            question_id = raw.get("questionId")
            if question_id not in questions or question_id in answers:
                raise ValueError("provider returned unknown or duplicate questionId")
            if raw.get("completed") is not True:
                raise ValueError("provider returned an incomplete answer")
            selected = raw.get("selectedOptionIds", [])
            custom = raw.get("customAnswer", "")
            if not isinstance(selected, list) or not all(
                isinstance(item, str) for item in selected
            ):
                raise ValueError("selectedOptionIds must be a string array")
            if not isinstance(custom, str) or "\n" in custom or "\r" in custom:
                raise ValueError("custom answer must be a single line")
            question = questions[question_id]
            normal_labels = {option.label for option in question.options if not option.is_other}
            other = next(option for option in question.options if option.is_other)
            if len(selected) == 1 and selected[0] in normal_labels and not custom.strip():
                answer = selected[0]
            elif not selected and custom.strip():
                answer = f"{other.label}: {custom.strip()}"
            else:
                raise ValueError("answer must select one option or provide Other text")
            if len(answer.encode("utf-8")) > MAX_ANSWER_BYTES:
                raise ValueError("answer exceeds the size limit")
            answers[question_id] = answer
        return answers

    def show_questionnaire(self, request: InteractionRequest) -> ProviderResult:
        try:
            bundle, questions = self._bundle(request)
            outcome = self._run(
                request,
                ["setup-goal", "interview", "-", "--json"],
                stdin=json.dumps(bundle, ensure_ascii=False),
            )
            if outcome.reason_code is not None:
                return ProviderResult.fallback(request, self.provider_id, outcome.reason_code)
            if outcome.returncode != 0:
                return ProviderResult.fallback(request, self.provider_id, "provider_unavailable")
            answers = self._answers(self._json(outcome.stdout), questions)
            return ProviderResult(
                status=ResultStatus.COMPLETED,
                interaction_type=InteractionType.QUESTIONNAIRE,
                provider=self.provider_id,
                interaction_id=request.interaction_id,
                artifact_relative=request.artifact_relative,
                presented_sha256=request.presented_sha256,
                decision=Decision.SUBMITTED,
                answers=answers,
            )
        except (OSError, UnicodeError, ValueError):
            return ProviderResult.fallback(request, self.provider_id, "invalid_provider_result")

    def show_review(self, request: InteractionRequest) -> ProviderResult:
        try:
            outcome = self._run(
                request,
                [
                    "annotate",
                    _ARTIFACT_SNAPSHOT,
                    "--gate",
                    "--json",
                    "--require-approval",
                ],
                snapshot_artifact=True,
            )
            if outcome.reason_code is not None:
                return ProviderResult.fallback(request, self.provider_id, outcome.reason_code)
            if outcome.returncode not in {0, 1}:
                return ProviderResult.fallback(request, self.provider_id, "provider_unavailable")
            value = self._json(outcome.stdout)
            if set(value) - {"decision", "feedback"}:
                raise ValueError("provider returned unexpected review fields")
            decision = value.get("decision")
            feedback = value.get("feedback")
            if feedback is not None and not isinstance(feedback, str):
                raise ValueError("feedback must be a string")
            if feedback and len(feedback.encode("utf-8")) > MAX_FEEDBACK_BYTES:
                raise ValueError("feedback exceeds the size limit")
            if decision == "approved" and outcome.returncode == 0:
                return ProviderResult(
                    status=ResultStatus.COMPLETED,
                    interaction_type=InteractionType.REVIEW,
                    provider=self.provider_id,
                    interaction_id=request.interaction_id,
                    artifact_relative=request.artifact_relative,
                    presented_sha256=request.presented_sha256,
                    decision=Decision.APPROVED,
                )
            if decision == "annotated" and feedback:
                return ProviderResult(
                    status=ResultStatus.COMPLETED,
                    interaction_type=InteractionType.REVIEW,
                    provider=self.provider_id,
                    interaction_id=request.interaction_id,
                    artifact_relative=request.artifact_relative,
                    presented_sha256=request.presented_sha256,
                    decision=Decision.CHANGES_REQUESTED,
                    feedback=feedback,
                )
            reason = "cancelled" if decision == "dismissed" else "invalid_provider_result"
            return ProviderResult.fallback(request, self.provider_id, reason)
        except (OSError, UnicodeError, ValueError):
            return ProviderResult.fallback(request, self.provider_id, "invalid_provider_result")
