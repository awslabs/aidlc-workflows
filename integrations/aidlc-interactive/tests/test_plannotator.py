from __future__ import annotations

import shutil
import sys
import tempfile
import textwrap
import time
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest.mock import patch

from aidlc_interactive.config import InteractionConfig
from aidlc_interactive.markdown.questions import MarkdownOption, MarkdownQuestion
from aidlc_interactive.models import Decision, InteractionRequest, InteractionType, ResultStatus
from aidlc_interactive.providers.plannotator import PlannotatorProvider
from aidlc_interactive.security import MAX_ANSWER_BYTES, MAX_PROVIDER_OUTPUT_BYTES
from aidlc_interactive.service import build_request

_HAS_PROVIDER_SANDBOX = (sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").is_file()) or (
    sys.platform.startswith("linux") and shutil.which("bwrap") is not None
)


class PlannotatorContractTests(unittest.TestCase):
    def _question(self) -> MarkdownQuestion:
        return MarkdownQuestion(
            question_id="q-1",
            heading="Question",
            prompt="Pick",
            options=(
                MarkdownOption("A", "Alpha", False),
                MarkdownOption("X", "Other", True),
            ),
            answer="",
            answer_start=0,
            answer_end=0,
        )

    def _request(self, workspace: Path) -> InteractionRequest:
        docs = workspace / "aidlc-docs"
        docs.mkdir()
        artifact = docs / "plan.md"
        artifact.write_text("# Plan\n", encoding="utf-8")
        return build_request(
            workspace,
            Path("aidlc-docs/plan.md"),
            InteractionType.REVIEW,
            InteractionConfig(mode="interactive", verification="none", timeout_seconds=5),
        )

    def _script_snapshot(self, source: str) -> Callable[[Path], tuple[Path | None, str]]:
        def create(directory: Path) -> tuple[Path | None, str]:
            executable = directory / "plannotator"
            executable.write_text(
                f"#!{sys.executable}\n{textwrap.dedent(source)}",
                encoding="utf-8",
            )
            executable.chmod(0o500)
            return executable, "test_snapshot"

        return create

    def test_selected_option_is_mapped_to_canonical_label(self) -> None:
        payload = {
            "decision": "submitted",
            "stage": "interview",
            "result": {
                "stage": "interview",
                "title": "Demo questionnaire",
                "goalSlug": "questionnaire-demo",
                "answers": [
                    {
                        "questionId": "q-1",
                        "selectedOptionIds": ["A"],
                        "customAnswer": "",
                        "completed": True,
                    }
                ],
            },
        }
        self.assertEqual(
            PlannotatorProvider._answers(payload, {"q-1": self._question()}), {"q-1": "A"}
        )

    def test_custom_answer_maps_to_declared_other_label(self) -> None:
        payload = {
            "decision": "submitted",
            "stage": "interview",
            "result": {
                "stage": "interview",
                "answers": [
                    {
                        "questionId": "q-1",
                        "selectedOptionIds": [],
                        "customAnswer": "Custom choice",
                        "completed": True,
                    }
                ],
            },
        }
        self.assertEqual(
            PlannotatorProvider._answers(payload, {"q-1": self._question()}),
            {"q-1": "X: Custom choice"},
        )

    def test_oversized_custom_answer_is_rejected_by_adapter(self) -> None:
        payload = {
            "decision": "submitted",
            "stage": "interview",
            "result": {
                "stage": "interview",
                "answers": [
                    {
                        "questionId": "q-1",
                        "selectedOptionIds": [],
                        "customAnswer": "é" * MAX_ANSWER_BYTES,
                        "completed": True,
                    }
                ],
            },
        }
        with self.assertRaisesRegex(ValueError, "size limit"):
            PlannotatorProvider._answers(payload, {"q-1": self._question()})

    def test_unknown_fields_are_rejected(self) -> None:
        payload = {
            "decision": "submitted",
            "stage": "interview",
            "result": {"stage": "interview", "answers": []},
            "command": "unsafe",
        }
        with self.assertRaisesRegex(ValueError, "unexpected"):
            PlannotatorProvider._answers(payload, {"q-1": self._question()})

    def test_windows_without_supported_sandbox_is_unavailable(self) -> None:
        provider = PlannotatorProvider(InteractionConfig(mode="interactive", verification="none"))
        with (
            patch(
                "aidlc_interactive.providers.plannotator.shutil.which",
                return_value="C:\\Tools\\plannotator.exe",
            ),
            patch("aidlc_interactive.providers.plannotator.sys.platform", "win32"),
        ):
            availability = provider.is_available()
        self.assertFalse(availability.available)
        self.assertEqual(availability.reason_code, "provider_sandbox_unavailable")

    def test_review_execution_error_returns_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            request = self._request(Path(directory))
            provider = PlannotatorProvider(
                InteractionConfig(mode="interactive", verification="none")
            )
            with patch.object(provider, "_run", side_effect=OSError("unavailable")):
                result = provider.show_review(request)
        self.assertEqual(result.status, ResultStatus.FALLBACK_REQUIRED)
        self.assertEqual(result.reason_code, "invalid_provider_result")

    @unittest.skipUnless(_HAS_PROVIDER_SANDBOX, "provider sandbox unavailable")
    def test_review_uses_private_snapshot_and_isolated_working_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            request = self._request(workspace)
            state = workspace / "aidlc-docs" / "aidlc-state.md"
            audit = workspace / "aidlc-docs" / "audit.md"
            state.write_text("# Canonical state\n", encoding="utf-8")
            audit.write_text("# Canonical audit\n", encoding="utf-8")
            script = f"""
                import json
                import sys
                from pathlib import Path

                live_audit = Path({str(audit)!r})
                try:
                    live_audit.write_text("# Escaped sandbox\\n", encoding="utf-8")
                except OSError:
                    pass
                else:
                    raise SystemExit(3)
                target = Path(sys.argv[2])
                target.chmod(0o600)
                target.write_text("# Mutated private snapshot\\n", encoding="utf-8")
                Path("aidlc-state.md").write_text(
                    "# Attempted state mutation\\n", encoding="utf-8"
                )
                Path("audit.md").write_text(
                    "# Attempted audit mutation\\n", encoding="utf-8"
                )
                print(json.dumps({{"decision": "approved"}}))
            """
            before = {
                request.artifact_path: request.artifact_path.read_bytes(),
                state: state.read_bytes(),
                audit: audit.read_bytes(),
            }
            provider = PlannotatorProvider(
                InteractionConfig(mode="interactive", verification="none", timeout_seconds=5)
            )
            with patch.object(
                provider,
                "_verified_snapshot",
                side_effect=self._script_snapshot(script),
            ):
                result = provider.show_review(request)
            self.assertEqual(result.decision, Decision.APPROVED)
            for path, content in before.items():
                self.assertEqual(path.read_bytes(), content)

    @unittest.skipUnless(_HAS_PROVIDER_SANDBOX, "provider sandbox unavailable")
    def test_stdout_and_stderr_limits_terminate_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            request = self._request(workspace)
            provider = PlannotatorProvider(
                InteractionConfig(mode="interactive", verification="none", timeout_seconds=5)
            )
            for descriptor in (1, 2):
                with self.subTest(descriptor=descriptor):
                    script = f"""
                        import os
                        import time
                        os.write({descriptor}, b"x" * {MAX_PROVIDER_OUTPUT_BYTES + 1})
                        time.sleep(10)
                    """
                    started = time.monotonic()
                    with patch.object(
                        provider,
                        "_verified_snapshot",
                        side_effect=self._script_snapshot(script),
                    ):
                        result = provider.show_review(request)
                    elapsed = time.monotonic() - started
                    self.assertEqual(result.status, ResultStatus.FALLBACK_REQUIRED)
                    self.assertEqual(result.reason_code, "provider_output_too_large")
                    self.assertLess(elapsed, 3)


if __name__ == "__main__":
    unittest.main()
