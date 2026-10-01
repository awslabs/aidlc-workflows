from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aidlc_interactive.config import InteractionConfig
from aidlc_interactive.models import (
    Availability,
    Decision,
    InteractionRequest,
    InteractionType,
    ProviderResult,
    ResultStatus,
)
from aidlc_interactive.registry import clear_registry_for_tests, register_provider
from aidlc_interactive.security import MAX_ANSWER_BYTES
from aidlc_interactive.service import interact

QUESTION = """# Decisions

## Question 1
Pick.

A) Alpha
X) Other

[Answer]:
"""


class FakeProvider:
    provider_id = "fake"

    def __init__(self, config: InteractionConfig) -> None:
        self.config = config

    def is_available(self) -> Availability:
        return Availability(True, self.provider_id, "available", verified=True)

    def show_questionnaire(self, request: InteractionRequest) -> ProviderResult:
        return ProviderResult(
            status=ResultStatus.COMPLETED,
            interaction_type=request.interaction_type,
            provider=self.provider_id,
            interaction_id=request.interaction_id,
            artifact_relative=request.artifact_relative,
            presented_sha256=request.presented_sha256,
            decision=Decision.SUBMITTED,
            answers={"q-1": "A"},
        )

    def show_review(self, request: InteractionRequest) -> ProviderResult:
        return ProviderResult(
            status=ResultStatus.COMPLETED,
            interaction_type=request.interaction_type,
            provider=self.provider_id,
            interaction_id=request.interaction_id,
            artifact_relative=request.artifact_relative,
            presented_sha256=request.presented_sha256,
            decision=Decision.APPROVED,
        )


class MismatchedProvider(FakeProvider):
    def show_review(self, request: InteractionRequest) -> ProviderResult:
        result = super().show_review(request)
        return ProviderResult(
            status=result.status,
            interaction_type=result.interaction_type,
            provider=result.provider,
            interaction_id="review:replayed-result",
            artifact_relative=result.artifact_relative,
            presented_sha256=result.presented_sha256,
            decision=result.decision,
        )


class MutatingProvider(FakeProvider):
    def show_review(self, request: InteractionRequest) -> ProviderResult:
        result = super().show_review(request)
        request.artifact_path.write_text("# Mutated during review\n", encoding="utf-8")
        return result


class ChangesProvider(FakeProvider):
    def show_review(self, request: InteractionRequest) -> ProviderResult:
        return ProviderResult(
            status=ResultStatus.COMPLETED,
            interaction_type=request.interaction_type,
            provider=self.provider_id,
            interaction_id=request.interaction_id,
            artifact_relative=request.artifact_relative,
            presented_sha256=request.presented_sha256,
            decision=Decision.CHANGES_REQUESTED,
            feedback="Revise the design",
        )


class OversizedAnswerProvider(FakeProvider):
    def show_questionnaire(self, request: InteractionRequest) -> ProviderResult:
        return ProviderResult(
            status=ResultStatus.COMPLETED,
            interaction_type=request.interaction_type,
            provider=self.provider_id,
            interaction_id=request.interaction_id,
            artifact_relative=request.artifact_relative,
            presented_sha256=request.presented_sha256,
            decision=Decision.SUBMITTED,
            answers={"q-1": f"X: {'z' * MAX_ANSWER_BYTES}"},
        )


class RaisingProvider(FakeProvider):
    def show_review(self, request: InteractionRequest) -> ProviderResult:
        raise UnicodeError("invalid provider encoding")


class ProtectedMutatingProvider(FakeProvider):
    def show_review(self, request: InteractionRequest) -> ProviderResult:
        result = super().show_review(request)
        (request.workspace / "aidlc-docs" / "audit.md").write_text(
            "# Provider mutation\n", encoding="utf-8"
        )
        return result


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        clear_registry_for_tests()
        register_provider("fake", FakeProvider)
        self.config = InteractionConfig(provider="fake", mode="interactive")

    def tearDown(self) -> None:
        clear_registry_for_tests()

    def _artifact(self, root: Path, name: str, content: str) -> Path:
        docs = root / "aidlc-docs"
        docs.mkdir(exist_ok=True)
        path = docs / name
        path.write_text(content, encoding="utf-8")
        return Path("aidlc-docs") / name

    def test_questionnaire_result_updates_canonical_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            artifact = self._artifact(workspace, "questions.md", QUESTION)
            result = interact(
                workspace,
                artifact,
                InteractionType.QUESTIONNAIRE,
                config=self.config,
                interactive_session=True,
            )
            self.assertEqual(result.decision, Decision.SUBMITTED)
            self.assertNotEqual(result.presented_sha256, result.current_sha256)
            self.assertIn("[Answer]:A", (workspace / artifact).read_text(encoding="utf-8"))

    def test_review_returns_digest_bound_approval_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            artifact = self._artifact(workspace, "plan.md", "# Plan\n")
            before = (workspace / artifact).read_bytes()
            result = interact(
                workspace,
                artifact,
                InteractionType.REVIEW,
                config=self.config,
                interactive_session=True,
            )
            self.assertEqual(result.decision, Decision.APPROVED)
            self.assertEqual(result.presented_sha256, result.current_sha256)
            self.assertEqual((workspace / artifact).read_bytes(), before)

    def test_non_interactive_session_requires_markdown_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            artifact = self._artifact(workspace, "plan.md", "# Plan\n")
            result = interact(
                workspace,
                artifact,
                InteractionType.REVIEW,
                config=self.config,
                interactive_session=False,
            )
            self.assertEqual(result.status, ResultStatus.FALLBACK_REQUIRED)
            self.assertEqual(result.reason_code, "non_interactive_session")

    def test_stale_review_approval_falls_back(self) -> None:
        clear_registry_for_tests()
        register_provider("fake", MutatingProvider)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            artifact = self._artifact(workspace, "plan.md", "# Plan\n")
            result = interact(
                workspace,
                artifact,
                InteractionType.REVIEW,
                config=self.config,
                interactive_session=True,
            )
            self.assertEqual(result.status, ResultStatus.FALLBACK_REQUIRED)
            self.assertEqual(result.reason_code, "stale_artifact")

    def test_replayed_result_with_another_interaction_id_falls_back(self) -> None:
        clear_registry_for_tests()
        register_provider("fake", MismatchedProvider)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            artifact = self._artifact(workspace, "plan.md", "# Plan\n")
            result = interact(
                workspace,
                artifact,
                InteractionType.REVIEW,
                config=self.config,
                interactive_session=True,
            )
            self.assertEqual(result.status, ResultStatus.FALLBACK_REQUIRED)
            self.assertEqual(result.reason_code, "binding_mismatch")

    def test_changes_requested_returns_untrusted_feedback_without_writes(self) -> None:
        clear_registry_for_tests()
        register_provider("fake", ChangesProvider)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            artifact = self._artifact(workspace, "plan.md", "# Plan\n")
            before = (workspace / artifact).read_bytes()
            result = interact(
                workspace,
                artifact,
                InteractionType.REVIEW,
                config=self.config,
                interactive_session=True,
            )
            self.assertEqual(result.decision, Decision.CHANGES_REQUESTED)
            self.assertEqual(result.feedback, "Revise the design")
            self.assertEqual((workspace / artifact).read_bytes(), before)

    def test_oversized_answer_requires_fallback_instead_of_failed(self) -> None:
        clear_registry_for_tests()
        register_provider("fake", OversizedAnswerProvider)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            artifact = self._artifact(workspace, "questions.md", QUESTION)
            result = interact(
                workspace,
                artifact,
                InteractionType.QUESTIONNAIRE,
                config=self.config,
                interactive_session=True,
            )
            self.assertEqual(result.status, ResultStatus.FALLBACK_REQUIRED)
            self.assertEqual(result.reason_code, "canonical_update_failed")
            self.assertEqual((workspace / artifact).read_text(encoding="utf-8"), QUESTION)

    def test_provider_exception_requires_fallback_instead_of_failed(self) -> None:
        clear_registry_for_tests()
        register_provider("fake", RaisingProvider)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            artifact = self._artifact(workspace, "plan.md", "# Plan\n")
            result = interact(
                workspace,
                artifact,
                InteractionType.REVIEW,
                config=self.config,
                interactive_session=True,
            )
            self.assertEqual(result.status, ResultStatus.FALLBACK_REQUIRED)
            self.assertEqual(result.reason_code, "provider_error")

    def test_protected_artifact_change_invalidates_provider_result(self) -> None:
        clear_registry_for_tests()
        register_provider("fake", ProtectedMutatingProvider)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            artifact = self._artifact(workspace, "plan.md", "# Plan\n")
            self._artifact(workspace, "audit.md", "# Audit\n")
            result = interact(
                workspace,
                artifact,
                InteractionType.REVIEW,
                config=self.config,
                interactive_session=True,
            )
            self.assertEqual(result.status, ResultStatus.FALLBACK_REQUIRED)
            self.assertEqual(result.reason_code, "protected_artifact_changed")


if __name__ == "__main__":
    unittest.main()
