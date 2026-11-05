"""Parse and atomically update canonical AI-DLC questionnaire Markdown."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from aidlc_interactive.security import MAX_ANSWER_BYTES, atomic_write, resolve_artifact, sha256_file

_HEADING_RE = re.compile(r"(?m)^(?P<marks>#{2,6})[ \t]+(?P<title>[^\r\n]+?)[ \t]*$")
_ANSWER_RE = re.compile(r"(?m)^(?P<prefix>[ \t]*\[Answer\]:[ \t]*)(?P<answer>[^\r\n]*)$")
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
class ParsedQuestionnaire:
    workspace: Path
    path: Path
    relative_path: str
    content: str
    title: str
    questions: tuple[MarkdownQuestion, ...]

    @property
    def pending_questions(self) -> tuple[MarkdownQuestion, ...]:
        return tuple(question for question in self.questions if question.pending)


def _is_other(text: str) -> bool:
    normalized = re.sub(r"[^a-záéíóúüñ]+", " ", text.casefold()).strip()
    return bool(set(normalized.split()) & {"other", "otro", "otra"})


def parse_questionnaire(workspace: Path, artifact: Path) -> ParsedQuestionnaire:
    path, relative = resolve_artifact(workspace, artifact)
    content = path.read_text(encoding="utf-8")
    headings = list(_HEADING_RE.finditer(content))
    markers = list(_ANSWER_RE.finditer(content))
    if not markers:
        raise ValueError("questionnaire has no [Answer]: markers")
    if len(markers) > _MAX_QUESTIONS:
        raise ValueError("questionnaire exceeds the question limit")

    questions: list[MarkdownQuestion] = []
    prior_marker_end = 0
    for index, marker in enumerate(markers, start=1):
        eligible = [
            heading for heading in headings if prior_marker_end <= heading.start() < marker.start()
        ]
        if not eligible:
            raise ValueError("[Answer]: marker has no structural question heading")
        heading = eligible[-1]
        options = tuple(
            MarkdownOption(
                label=match.group("label"),
                text=match.group("text").strip(),
                is_other=_is_other(match.group("text")),
            )
            for match in _OPTION_RE.finditer(content, heading.end(), marker.start())
        )
        if not options:
            raise ValueError(f"question {index} has no selectable options")
        labels = [option.label for option in options]
        if len(labels) != len(set(labels)):
            raise ValueError(f"question {index} has duplicate option labels")
        other = [option for option in options if option.is_other]
        if len(other) != 1 or options[-1] is not other[0]:
            raise ValueError(f"question {index} must end with exactly one Other option")
        first_option = next(_OPTION_RE.finditer(content, heading.end(), marker.start()))
        questions.append(
            MarkdownQuestion(
                question_id=f"q-{index}",
                heading=heading.group("title").strip(),
                prompt=content[heading.end() : first_option.start()].strip(),
                options=options,
                answer=marker.group("answer").strip(),
                answer_start=marker.start("answer"),
                answer_end=marker.end("answer"),
            )
        )
        prior_marker_end = marker.end()

    title_match = re.search(r"(?m)^#[ \t]+([^\r\n]+)", content)
    return ParsedQuestionnaire(
        workspace=workspace.expanduser().resolve(strict=True),
        path=path,
        relative_path=relative,
        content=content,
        title=title_match.group(1).strip() if title_match else path.stem,
        questions=tuple(questions),
    )


def _validate_answer(question: MarkdownQuestion, answer: str) -> str:
    if not isinstance(answer, str) or not answer.strip():
        raise ValueError(f"answer for {question.question_id} is empty")
    answer = answer.strip()
    if "\n" in answer or "\r" in answer:
        raise ValueError(f"answer for {question.question_id} must be a single line")
    if len(answer.encode("utf-8")) > MAX_ANSWER_BYTES:
        raise ValueError(f"answer for {question.question_id} exceeds the size limit")
    labels = {option.label for option in question.options if not option.is_other}
    other = next(option for option in question.options if option.is_other)
    if answer in labels:
        return answer
    prefix = f"{other.label}:"
    if answer.startswith(prefix) and answer[len(prefix) :].strip():
        return f"{prefix} {answer[len(prefix) :].strip()}"
    raise ValueError(f"answer for {question.question_id} is not a valid option")


def apply_answers(
    parsed: ParsedQuestionnaire,
    answers: dict[str, str],
    *,
    expected_sha256: str,
) -> ParsedQuestionnaire:
    pending = {question.question_id: question for question in parsed.pending_questions}
    if set(answers) != set(pending):
        raise ValueError("submitted answers must exactly match all pending questions")
    replacements: list[tuple[int, int, str]] = []
    for question_id, question in pending.items():
        replacements.append(
            (
                question.answer_start,
                question.answer_end,
                _validate_answer(question, answers[question_id]),
            )
        )
    updated = parsed.content
    for start, end, answer in reversed(replacements):
        updated = updated[:start] + answer + updated[end:]
    if updated == parsed.content:
        raise ValueError("submitted answers did not change the questionnaire")
    atomic_write(parsed.path, updated, expected_sha256=expected_sha256)
    reparsed = parse_questionnaire(parsed.workspace, Path(parsed.relative_path))
    if reparsed.pending_questions:
        raise RuntimeError("atomic update left unanswered questions")
    if sha256_file(reparsed.path) == expected_sha256:
        raise RuntimeError("atomic update did not change the artifact digest")
    return reparsed
