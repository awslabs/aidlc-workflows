"""Example and property-based tests for canonical Markdown question updates."""

from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from cli_harness.interaction import sha256_file
from cli_harness.markdown_questions import (
    apply_answers_atomic,
    find_pending_question_document,
    parse_questions,
)
from hypothesis import given, seed, settings
from hypothesis import strategies as st

QUESTION_DOC = """# Decisions

Unrelated introduction stays byte-for-byte identical.

## Question 1
Choose a mode.

A) Fast

B) Safe

C) Other (describe below)

[Answer]:

## Question 2
Choose a target.

A) Local

E) Other (please describe)

[Answer]: E:\nmultiline detail

## Question 3
Choose again.

A) First

X) Other (please describe)

[Answer]: X
"""


def test_parser_recognizes_other_by_text_not_letter(tmp_path: Path) -> None:
    path = tmp_path / "questions.md"
    path.write_text(QUESTION_DOC, encoding="utf-8")
    parsed = parse_questions(path)
    assert [option.label for option in parsed.questions[0].options if option.is_other] == ["C"]
    assert [option.label for option in parsed.questions[1].options if option.is_other] == ["E"]
    assert [option.label for option in parsed.questions[2].options if option.is_other] == ["X"]
    assert parsed.questions[1].answer == "E:\nmultiline detail"
    assert [question.question_id for question in parsed.pending_questions] == ["q-1"]


def test_atomic_update_changes_only_answer_span(tmp_path: Path) -> None:
    path = tmp_path / "questions.md"
    path.write_text(QUESTION_DOC, encoding="utf-8")
    updated = apply_answers_atomic(path, {"q-1": "B"}, workspace=tmp_path)
    assert not updated.pending_questions
    assert updated.content == QUESTION_DOC.replace("[Answer]:\n", "[Answer]:B\n", 1)


@seed(20260812)
@settings(max_examples=50)
@given(
    answer=st.text(
        alphabet=st.sampled_from(list("ABCXYZ 0123456789áéíóú")),
        min_size=1,
        max_size=80,
    )
)
def test_answer_replacement_preserves_surrounding_markdown(answer: str) -> None:
    answer = answer.strip() or "A"
    prefix = "# Questions\n\n## Question 1\nPick.\n\nA) Alpha\n\nX) Other\n\n[Answer]: "
    suffix = "\n\n## Notes\nDo not alter this section.\n"
    with TemporaryDirectory() as directory:
        path = Path(directory) / "property-questions.md"
        path.write_text(prefix + suffix, encoding="utf-8")
        apply_answers_atomic(path, {"q-1": answer}, workspace=Path(directory))
        assert path.read_text(encoding="utf-8") == prefix + answer + suffix


def test_inline_answer_without_blank_separator_preserves_following_content(
    tmp_path: Path,
) -> None:
    content = (
        "# Questions\n\n## Question 1\nPick.\n\nA) Alpha\n\nB) Beta\n\n"
        "[Answer]: A\nDo not erase this note.\n"
    )
    path = tmp_path / "questions.md"
    path.write_text(content, encoding="utf-8")

    updated = apply_answers_atomic(path, {"q-1": "B"}, workspace=tmp_path)

    assert updated.content == content.replace("[Answer]: A", "[Answer]: B")
    assert "Do not erase this note." in updated.content


def test_atomic_answers_reject_stale_presented_digest(tmp_path: Path) -> None:
    path = tmp_path / "questions.md"
    path.write_text(
        "# Questions\n\n## Question 1\nPick.\n\nA) Alpha\n\n[Answer]:\n",
        encoding="utf-8",
    )
    presented_digest = sha256_file(path)
    path.write_text(
        path.read_text(encoding="utf-8") + "\nChanged concurrently.\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="changed after it was presented"):
        apply_answers_atomic(
            path,
            {"q-1": "A"},
            workspace=tmp_path,
            expected_sha256=presented_digest,
        )


def test_clarification_heading_is_detected_from_answer_marker(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    docs = workspace / "aidlc-docs"
    docs.mkdir(parents=True)
    path = docs / "clarifications.md"
    path.write_text(
        "# Clarifications\n\n### Clarification Question 1\nChoose.\n\n"
        "A) First\n\nX) Other\n\n[Answer]:\n",
        encoding="utf-8",
    )

    parsed = find_pending_question_document(docs, workspace=workspace)

    assert parsed is not None
    assert parsed.questions[0].heading == "Clarification Question 1"
    assert parsed.pending_questions[0].question_id == "q-1"


def test_answer_marker_without_structural_heading_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "malformed.md"
    path.write_text("# Top-level only\n\n[Answer]:\n", encoding="utf-8")

    with pytest.raises(ValueError, match="no enclosing question heading"):
        parse_questions(path)
