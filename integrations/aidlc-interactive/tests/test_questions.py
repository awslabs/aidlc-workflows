from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aidlc_interactive.markdown.questions import apply_answers, parse_questionnaire
from aidlc_interactive.security import sha256_file

QUESTIONNAIRE = """# Decisions

Intro remains unchanged.

## Question 1
Choose a mode.

A) Fast
B) Safe
X) Other (describe)

[Answer]:

## Clarification 2
Choose a target.

A) Local
E) Other (please describe)

[Answer]:

## Notes
Preserve this section.
"""


class QuestionnaireTests(unittest.TestCase):
    def _document(self, root: Path, content: str = QUESTIONNAIRE) -> tuple[Path, Path]:
        docs = root / "aidlc-docs"
        docs.mkdir()
        path = docs / "questions.md"
        path.write_text(content, encoding="utf-8")
        return path, Path("aidlc-docs/questions.md")

    def test_answers_change_only_answer_spans(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            path, relative = self._document(workspace)
            digest = sha256_file(path)
            parsed = parse_questionnaire(workspace, relative)
            updated = apply_answers(
                parsed,
                {"q-1": "B", "q-2": "E: Remote target"},
                expected_sha256=digest,
            )
            expected = QUESTIONNAIRE.replace(
                "[Answer]:\n\n## Clarification 2",
                "[Answer]:B\n\n## Clarification 2",
            ).replace(
                "[Answer]:\n\n## Notes",
                "[Answer]:E: Remote target\n\n## Notes",
            )
            self.assertEqual(updated.content, expected)
            self.assertFalse(updated.pending_questions)

    def test_partial_submission_is_rejected_without_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            path, relative = self._document(workspace)
            original = path.read_text(encoding="utf-8")
            parsed = parse_questionnaire(workspace, relative)
            with self.assertRaisesRegex(ValueError, "exactly match"):
                apply_answers(parsed, {"q-1": "A"}, expected_sha256=sha256_file(path))
            self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_stale_digest_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            path, relative = self._document(workspace)
            parsed = parse_questionnaire(workspace, relative)
            digest = sha256_file(path)
            path.write_text(QUESTIONNAIRE + "Concurrent change.\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "changed"):
                apply_answers(
                    parsed,
                    {"q-1": "A", "q-2": "A"},
                    expected_sha256=digest,
                )

    def test_other_must_be_last_and_unique(self) -> None:
        malformed = "# Q\n\n## One\nPick.\n\nX) Other\nA) Alpha\n\n[Answer]:\n"
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, relative = self._document(workspace, malformed)
            with self.assertRaisesRegex(ValueError, "must end"):
                parse_questionnaire(workspace, relative)


if __name__ == "__main__":
    unittest.main()
