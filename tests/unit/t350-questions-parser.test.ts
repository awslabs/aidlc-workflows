import { describe, expect, test } from "bun:test";
import {
  parseQuestionsMarkdown,
  validateQuestionAnswers,
  type ReviewQuestion,
} from "../../core/tools/aidlc-review-ui-render.ts";

const QUESTIONS_MARKDOWN = `# Architecture questions

Introductory prose outside a question.

## Q1: Runtime model
Which runtime should host the service?

Use the supported deployment targets.

A. Bun service
B. Node service
X. Other (please specify)

[Answer]: B
[Note]: Existing operations support favors Node.

## Q2. Required capabilities (SeLeCt AlL tHaT aPpLy)
Choose every capability needed at launch.
A. Audit trail
B. Metrics
C. Tracing
X. Other (please specify)
[Answer]: A, B
[Note]:

## Q3: Exception handling
Choose one policy.
A. Fail closed
X. Other (please specify)
[Answer]: X — Retry queue
[Note]: Discuss queue ownership.

## Consolidated Summary Confirmation
The decisions above establish the launch baseline.

- Runtime: Node
- Capabilities: audit and metrics
- Looks correct
- Request changes

[Answer]:

## Requested Changes Feedback
What should change?
[Answer]:
`;

function parsedQuestions(): ReviewQuestion[] {
  return parseQuestionsMarkdown(QUESTIONS_MARKDOWN);
}

describe("t350 questions Markdown parser", () => {
  test("parses single-select, multi-select, Other, answers, and notes", () => {
    expect(parsedQuestions()).toEqual([
      {
        id: "Q1",
        title: "Q1: Runtime model",
        prompt: "Which runtime should host the service?\n\nUse the supported deployment targets.",
        options: [
          { letter: "A", text: "Bun service" },
          { letter: "B", text: "Node service" },
          { letter: "X", text: "Other (please specify)" },
        ],
        multi: false,
        answer: "B",
        note: "Existing operations support favors Node.",
        confirmation: false,
      },
      {
        id: "Q2",
        title: "Q2. Required capabilities (SeLeCt AlL tHaT aPpLy)",
        prompt: "Choose every capability needed at launch.",
        options: [
          { letter: "A", text: "Audit trail" },
          { letter: "B", text: "Metrics" },
          { letter: "C", text: "Tracing" },
          { letter: "X", text: "Other (please specify)" },
        ],
        multi: true,
        answer: "A, B",
        note: null,
        confirmation: false,
      },
      {
        id: "Q3",
        title: "Q3: Exception handling",
        prompt: "Choose one policy.",
        options: [
          { letter: "A", text: "Fail closed" },
          { letter: "X", text: "Other (please specify)" },
        ],
        multi: false,
        answer: "X — Retry queue",
        note: "Discuss queue ownership.",
        confirmation: false,
      },
      {
        id: "summary-confirmation",
        title: "Consolidated Summary Confirmation",
        prompt: [
          "The decisions above establish the launch baseline.",
          "",
          "- Runtime: Node",
          "- Capabilities: audit and metrics",
        ].join("\n"),
        options: [
          { letter: null, text: "Looks correct" },
          { letter: null, text: "Request changes" },
        ],
        multi: false,
        answer: null,
        note: null,
        confirmation: true,
      },
    ]);
  });

  test("recognizes the exact Q heading grammar and only top-level ATX H2 sections", () => {
    const source = `## Q1
A. valid
[Answer]:

## Q2.
A. valid
[Answer]:

## Q3: With title
A. valid
[Answer]:

## Q4.With title
A. not a question
[Answer]:

## Q5:No space
A. not a question
[Answer]:

## Q06: Leading zero
A. not a question
[Answer]:

## Q0: Zero
A. not a question
[Answer]:

### Q7: H3
A. not a question
[Answer]:

> ## Q8: Block quote
> A. not a question

- ## Q9: List item
  A. not a question

Q10: Setext
------------
A. not a question

\`\`\`markdown
## Q11: Fenced example
A. not a question
[Answer]: hidden
\`\`\`

    ## Q12: Indented code

<pre>
## Q13: Raw HTML example
A. not a question
</pre>

<!--
## Q14: Commented example
A. not a question
-->

## Q15: Visible title ###
A. valid
[Answer]:
`;

    expect(parseQuestionsMarkdown(source).map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "Q1", title: "Q1" },
      { id: "Q2", title: "Q2." },
      { id: "Q3", title: "Q3: With title" },
      { id: "Q15", title: "Q15: Visible title" },
    ]);
  });

  test("ignores malformed sections and treats malformed option lines as prose", () => {
    const source = `## Overview
A. not a question

## Question 1
A. not a question

## Q1: Valid
Prompt text.
a. lowercase is not an option
AA. long label is not an option
A) wrong punctuation is not an option
A. Accepted
B.    Also accepted
C.
[Answer]:

## Consolidated summary confirmation
- Looks correct
- Request changes
[Answer]:
`;

    const questions = parseQuestionsMarkdown(source);
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("Q1");
    expect(questions[0].options).toEqual([
      { letter: "A", text: "Accepted" },
      { letter: "B", text: "Also accepted" },
    ]);
    expect(questions[0].prompt).toBe([
      "Prompt text.",
      "a. lowercase is not an option",
      "AA. long label is not an option",
      "A) wrong punctuation is not an option",
      "C.",
    ].join("\n"));
  });

  test("detects multi-select from prompt text and stops prompt parsing at Note", () => {
    const [question] = parseQuestionsMarkdown(`## Q1: Capabilities
Choose capabilities (SELECT ALL THAT APPLY).
A. One
B. Two
[Note]: Awaiting owner input.
Trailing material is not prompt text.
[Answer]: A
`);

    expect(question.multi).toBe(true);
    expect(question.prompt).toBe("Choose capabilities (SELECT ALL THAT APPLY).");
    expect(question.answer).toBe("A");
    expect(question.note).toBe("Awaiting owner input.");
  });

  test("does not parse structural markers from literal Markdown contexts", () => {
    const [question] = parseQuestionsMarkdown(`## Q1: Visible
Prompt.
\`\`\`text
A. fenced option
[Answer]: hidden
\`\`\`
    B. indented option
    [Note]: hidden
<pre>
C. raw HTML option
[Answer]: hidden
</pre>
D. visible option
[Answer]: D
`);

    expect(question.options).toEqual([{ letter: "D", text: "visible option" }]);
    expect(question.answer).toBe("D");
    expect(question.note).toBeNull();
  });
});

describe("t350 question answer validator", () => {
  test("normalizes accepted single, multi, Other, and note submissions", () => {
    expect(
      validateQuestionAnswers(parsedQuestions(), [
        { id: "Q1", labels: ["b"], note: "  Use existing support.  " },
        { id: "Q2", labels: ["a", "C"] },
        { id: "Q3", labels: ["x"], other: "  Send to a retry queue.  ", note: "  " },
      ]),
    ).toEqual([
      { id: "Q1", labels: ["B"], note: "Use existing support." },
      { id: "Q2", labels: ["A", "C"] },
      { id: "Q3", labels: ["X"], other: "Send to a retry queue.", note: "" },
    ]);
  });

  test("rejects non-array and non-plain entries", () => {
    expect(() => validateQuestionAnswers(parsedQuestions(), {})).toThrow(/must be an array/);
    expect(() => validateQuestionAnswers(parsedQuestions(), [null])).toThrow(/plain object/);
    expect(() => validateQuestionAnswers(parsedQuestions(), ["Q1"])).toThrow(/plain object/);
  });

  test("rejects duplicate, unknown, and confirmation ids", () => {
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [
        { id: "Q1", labels: ["A"] },
        { id: "Q1", labels: ["B"] },
      ]),
    ).toThrow(/duplicate question id "Q1"/);
    expect(() => validateQuestionAnswers(parsedQuestions(), [{ id: "Q99" }])).toThrow(
      /unknown question id "Q99"/,
    );
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "summary-confirmation" }]),
    ).toThrow(/read-only/);
  });

  test("rejects malformed, unknown, duplicate, and disallowed labels", () => {
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "Q1", labels: "A" }]),
    ).toThrow(/malformed labels/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "Q1", labels: [1] }]),
    ).toThrow(/malformed label/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "Q1", labels: ["AA"] }]),
    ).toThrow(/malformed label/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "Q1", labels: ["C"] }]),
    ).toThrow(/not valid for question "Q1"/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "Q1", labels: ["a", "A"] }]),
    ).toThrow(/repeats label "A"/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "Q1", labels: ["A", "B"] }]),
    ).toThrow(/accepts only one label/);
  });

  test("enforces the X Other pairing", () => {
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "Q3", labels: ["X"] }]),
    ).toThrow(/requires other text/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [
        { id: "Q3", labels: ["X"], other: "   " },
      ]),
    ).toThrow(/requires other text/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [
        { id: "Q3", labels: ["A"], other: "Retry queue" },
      ]),
    ).toThrow(/without label X/);
  });

  test("rejects non-string and unreasonable text fields", () => {
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: 1, labels: ["A"] }]),
    ).toThrow(/invalid id/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "Q1", note: 1 }]),
    ).toThrow(/invalid note/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [
        { id: "Q3", labels: ["X"], other: 1 },
      ]),
    ).toThrow(/invalid other text/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [{ id: "Q1", note: "n".repeat(65_537) }]),
    ).toThrow(/invalid note/);
    expect(() =>
      validateQuestionAnswers(parsedQuestions(), [
        { id: "Q3", labels: ["X"], other: "o".repeat(65_537) },
      ]),
    ).toThrow(/invalid other text/);
  });
});
