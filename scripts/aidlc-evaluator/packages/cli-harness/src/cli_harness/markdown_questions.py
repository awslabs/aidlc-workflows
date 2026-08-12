"""Parse and atomically update canonical AI-DLC Markdown questions."""

from __future__ import annotations

import os
import re
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path

from cli_harness.interaction import (
    MAX_ANSWER_BYTES,
    MAX_ARTIFACT_BYTES,
    resolve_artifact_path,
    sha256_file,
)

_HEADING_RE = re.compile(r"(?m)^(?P<marks>#{2,6})[ \t]+(?P<title>[^\r\n]+?)[ \t]*$")
_ANSWER_RE = re.compile(r"(?m)^(?P<prefix>[ \t]*\[Answer\]:[ \t]*)(?P<inline>[^\r\n]*)")
_OPTION_RE = re.compile(r"(?m)^[ \t]*(?P<label>[A-Z])(?:\)|\.)[ \t]+(?P<text>[^\r\n]+?)\s*$")
_MAX_QUESTIONS = 100


@dataclass(frozen=True)
class MarkdownOption:
    label: str
    text: str
    is_other: bool


@dataclass(frozen=True)
class MarkdownQuestion:
    question_id: str
    heading: str
    prompt: str
    options: tuple[MarkdownOption, ...]
    answer: str
    answer_start: int
    answer_end: int

    @property
    def pending(self) -> bool:
        return not self.answer.strip()


@dataclass(frozen=True)
class ParsedQuestions:
    path: Path
    content: str
    title: str
    questions: tuple[MarkdownQuestion, ...]

    @property
    def pending_questions(self) -> tuple[MarkdownQuestion, ...]:
        return tuple(question for question in self.questions if question.pending)


def _is_other(text: str) -> bool:
    normalized = re.sub(r"[^a-záéíóúüñ]+", " ", text.casefold()).strip()
    words = set(normalized.split())
    return bool(words & {"other", "otro", "otra"})


def _answer_end(content: str, marker: re.Match[str], next_heading_start: int) -> int:
    inline = marker.group("inline")
    if not inline.strip():
        return marker.end("inline")
    line_end = content.find("\n", marker.end())
    if line_end < 0:
        return len(content)
    separator = re.search(r"\r?\n[ \t]*\r?\n", content[line_end:next_heading_start])
    return line_end + separator.start() if separator else line_end


def parse_questions(path: Path, *, workspace: Path | None = None) -> ParsedQuestions:
    """Parse blocks from `[Answer]:` markers, independent of visible heading text."""
    resolved = resolve_artifact_path(workspace, path) if workspace else path.resolve(strict=True)
    if resolved.stat().st_size > MAX_ARTIFACT_BYTES:
        raise ValueError(f"question document exceeds {MAX_ARTIFACT_BYTES} bytes")
    content = resolved.read_text(encoding="utf-8")
    headings = list(_HEADING_RE.finditer(content))
    markers = list(_ANSWER_RE.finditer(content))
    if len(markers) > _MAX_QUESTIONS:
        raise ValueError(f"question document exceeds {_MAX_QUESTIONS} questions")

    blocks: list[tuple[re.Match[str], re.Match[str]]] = []
    previous_marker_end = 0
    for marker in markers:
        eligible_headings = [
            heading
            for heading in headings
            if previous_marker_end <= heading.start() < marker.start()
        ]
        if not eligible_headings:
            raise ValueError("[Answer]: marker has no enclosing question heading")
        blocks.append((eligible_headings[-1], marker))
        previous_marker_end = marker.end()

    questions: list[MarkdownQuestion] = []
    for index, (heading, marker) in enumerate(blocks, start=1):
        block_end = blocks[index][0].start() if index < len(blocks) else len(content)
        options = tuple(
            MarkdownOption(
                label=match.group("label"),
                text=match.group("text").strip(),
                is_other=_is_other(match.group("text")),
            )
            for match in _OPTION_RE.finditer(content, heading.end(), marker.start())
        )
        first_option = next(
            iter(_OPTION_RE.finditer(content, heading.end(), marker.start())),
            None,
        )
        prompt_end = first_option.start() if first_option else marker.start()
        prompt = content[heading.end() : prompt_end].strip()
        start = marker.start("inline")
        end = _answer_end(content, marker, block_end)
        answer = content[start:end].strip()
        questions.append(
            MarkdownQuestion(
                question_id=f"q-{index}",
                heading=heading.group("title").strip(),
                prompt=prompt,
                options=options,
                answer=answer,
                answer_start=start,
                answer_end=end,
            )
        )
    title_match = re.search(r"(?m)^#[ \t]+([^\r\n]+)", content)
    return ParsedQuestions(
        path=resolved,
        content=content,
        title=title_match.group(1).strip() if title_match else resolved.stem,
        questions=tuple(questions),
    )


def _content_without_answers(parsed: ParsedQuestions) -> str:
    content = parsed.content
    for question in reversed(parsed.questions):
        content = (
            content[: question.answer_start]
            + "<CANONICAL_ANSWER_SPAN>"
            + content[question.answer_end :]
        )
    return re.sub(
        r"(\[Answer\]:)[ \t]*<CANONICAL_ANSWER_SPAN>",
        r"\1<CANONICAL_ANSWER_SPAN>",
        content,
    )


def extract_submitted_answers(
    before: ParsedQuestions,
    after: ParsedQuestions,
) -> dict[str, str]:
    """Extract only newly filled answers when all non-answer bytes are unchanged."""
    if _content_without_answers(before) != _content_without_answers(after):
        raise ValueError("manual edit changed content outside [Answer]: spans")
    if len(before.questions) != len(after.questions):
        raise ValueError("manual edit changed the canonical question set")
    answers: dict[str, str] = {}
    for original, submitted in zip(before.questions, after.questions, strict=True):
        if original.question_id != submitted.question_id:
            raise ValueError("manual edit changed question identities")
        if not original.pending:
            if original.answer != submitted.answer:
                raise ValueError("manual edit changed an existing answer")
            continue
        answer = submitted.answer.strip()
        if not answer:
            raise ValueError(f"answer for {original.question_id} is empty")
        if "\n" in answer or "\r" in answer:
            raise ValueError(f"answer for {original.question_id} must be a single line")
        if len(answer.encode("utf-8")) > MAX_ANSWER_BYTES:
            raise ValueError(f"answer for {original.question_id} exceeds the size limit")
        answers[original.question_id] = answer
    return answers


def _write_atomic(path: Path, content: str, *, mode: int) -> None:
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temp_name = temporary.name
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temp_name, stat.S_IMODE(mode))
        os.replace(temp_name, path)
        temp_name = None
    finally:
        if temp_name is not None:
            Path(temp_name).unlink(missing_ok=True)


def restore_canonical_content(
    path: Path,
    content: str,
    *,
    workspace: Path,
) -> None:
    """Atomically restore a canonical artifact after out-of-process manual editing."""
    resolved = resolve_artifact_path(workspace, path)
    mode = resolved.stat().st_mode
    _write_atomic(resolved, content, mode=mode)
    if resolved.read_text(encoding="utf-8") != content:
        raise RuntimeError("canonical artifact restoration failed")


def _replace_answers(parsed: ParsedQuestions, answers: dict[str, str]) -> str:
    known = {question.question_id for question in parsed.questions}
    unknown = set(answers) - known
    if unknown:
        raise ValueError(f"answers contain unknown question IDs: {sorted(unknown)}")
    content = parsed.content
    replacements: list[tuple[int, int, str]] = []
    for question in parsed.questions:
        if question.question_id not in answers:
            continue
        answer = answers[question.question_id]
        if not isinstance(answer, str) or not answer.strip():
            raise ValueError(f"answer for {question.question_id} is empty")
        if "\n" in answer or "\r" in answer:
            raise ValueError(f"answer for {question.question_id} must be a single line")
        if len(answer.encode("utf-8")) > MAX_ANSWER_BYTES:
            raise ValueError(f"answer for {question.question_id} exceeds the size limit")
        replacements.append((question.answer_start, question.answer_end, answer.strip()))
    for start, end, answer in reversed(replacements):
        content = content[:start] + answer + content[end:]
    return content


def apply_answers_atomic(
    path: Path,
    answers: dict[str, str],
    *,
    workspace: Path,
    expected_sha256: str | None = None,
) -> ParsedQuestions:
    """Replace only answer spans when the canonical source still matches review."""
    parsed = parse_questions(path, workspace=workspace)
    if expected_sha256 is not None and sha256_file(parsed.path) != expected_sha256:
        raise ValueError("question artifact changed after it was presented")
    updated = _replace_answers(parsed, answers)
    if updated == parsed.content and answers:
        raise ValueError("answers did not change the document")

    mode = parsed.path.stat().st_mode
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=parsed.path.parent,
            prefix=f".{parsed.path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temp_name = temporary.name
            temporary.write(updated)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temp_name, stat.S_IMODE(mode))
        if expected_sha256 is not None and sha256_file(parsed.path) != expected_sha256:
            raise ValueError("question artifact changed while answers were being prepared")
        os.replace(temp_name, parsed.path)
        temp_name = None
    finally:
        if temp_name is not None:
            Path(temp_name).unlink(missing_ok=True)

    reparsed = parse_questions(parsed.path, workspace=workspace)
    expected = _replace_answers(parsed, answers)
    if reparsed.content != expected:
        raise RuntimeError("atomic question update failed preservation verification")
    return reparsed


def find_pending_question_document(aidlc_docs: Path, *, workspace: Path) -> ParsedQuestions | None:
    """Return the most recently modified document with unanswered questions."""
    candidates: list[ParsedQuestions] = []
    if not aidlc_docs.is_dir():
        return None
    for path in aidlc_docs.rglob("*.md"):
        if path.name in {"aidlc-state.md", "audit.md"}:
            continue
        try:
            parsed = parse_questions(path, workspace=workspace)
        except (OSError, UnicodeError):
            continue
        if parsed.pending_questions:
            candidates.append(parsed)
    if not candidates:
        return None
    return max(candidates, key=lambda parsed: (parsed.path.stat().st_mtime_ns, str(parsed.path)))
