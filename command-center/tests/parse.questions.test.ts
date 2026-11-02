import { expect, test } from "bun:test";
import { parseQuestions } from "../../core/command-center/server/parse/questions";

const INLINE = `# Feasibility Questions
## Context already decided (not re-asked — carried forward as-is)
- **IaC**: Terraform
- **Runtime**: Fargate
## Q1. Does an existing framework cover this?
Some prompt text.
- A. Not yet verified
- B. Already checked: nothing covers this.
- X. Other (please specify)

[Answer]: B

## Q2 — Which region?
- A. us-east-1
- X. Other (please specify)

[Answer]: X. eu-west-1 because of data residency
`;
const BATCHED = `## Q1: One client or many?
- A. One shared
- B. Per system
- X. Other (please specify)
## Q2: Isolation?
- A. Bulkheads
- X. Other (please specify)

[Answer Q1]: A
[Answer Q2]:
`;

// The shape a real run writes: worded headings, options with no `- ` bullet, and a "select all that apply" answer.
const WORDED = `# Practices Discovery — Questions

This paragraph introduces the file and is not a question.

## Question 1 — Way of working: how should changes reach the main branch?
Short-lived branches are the default.

A. Short-lived branches, squash-merged (suggested)
B. Keep every commit
X. Other (please specify)

[Answer]: A

### Question 2 — Hard rules the team must follow? (select all that apply)
A. NEVER hardcode secrets
B. ALWAYS encrypt at rest
C. ALWAYS use least-privilege roles
X. Other (please specify)

[Answer]: B, C
`;

test("worded headings, un-bulleted options and a multi-select answer", () => {
  const r = parseQuestions(WORDED);
  expect(r.questions.map((q) => q.id)).toEqual(["Q1", "Q2"]);
  expect(r.questions[0]!.title).toBe("Way of working: how should changes reach the main branch?");
  expect(r.questions[0]!.prompt).toBe("Short-lived branches are the default.");
  expect(r.questions[0]!.options.map((o) => o.key)).toEqual(["A", "B", "X"]);
  expect(r.questions[0]!.answer).toBe("A");
  expect(r.questions[0]!.answers).toEqual(["A"]);
  expect(r.questions[1]!.title).toBe("Hard rules the team must follow? (select all that apply)");
  expect(r.questions[1]!.answers).toEqual(["B", "C"]);
  expect(r.questions[1]!.answer).toBe("B"); // first key, for anything that still reads one answer
  expect(r.questions[1]!.answerText).toBeNull();
});

test("every heading shape normalises to Q<n>", () => {
  const md = "## Q1. one\n- A. x\n## Q2: two\n- A. x\n## Q3 — three\n- A. x\n### Q4 four\n- A. x\n## Question 5 — five\n- A. x\n#### Question 6: six\n- A. x\n";
  const r = parseQuestions(md);
  expect(r.questions.map((q) => [q.id, q.title])).toEqual([["Q1", "one"], ["Q2", "two"], ["Q3", "three"], ["Q4", "four"], ["Q5", "five"], ["Q6", "six"]]);
});

test("batched multi-select answers, by worded or short key", () => {
  const md = "## Question 9 — Hard rules?\n- A. a\n- B. b\n- C. c\n- D. d\n## Question 10 — Proof?\n- A. a\n- B. b\n\n[Answer Q9]: C, D\n[Answer Question 10]: A and B\n";
  const r = parseQuestions(md);
  expect(r.questions[0]!.answers).toEqual(["C", "D"]);
  expect(r.questions[1]!.answers).toEqual(["A", "B"]);
});

test("extra keys count only when the answer is keys and nothing else", () => {
  const keysOnly = parseQuestions("## Q1. a\n- A. x\n- B. y\n- C. z\n- D. w\n[Answer]: C, D\n## Q2. b\n- A. x\n- B. y\n[Answer]: a,b\n## Q3. c\n- A. x\n- B. y\n[Answer]: A and B\n");
  expect(keysOnly.questions.map((q) => q.answers)).toEqual([["C", "D"], ["A", "B"], ["A", "B"]]);
  // Anything after the keys makes it one answer plus free text, kept verbatim — a second key is never assumed.
  const prose = parseQuestions("## Q1. a\n- A. x\n- B. y\n[Answer]: A, e.g. with caveat\n## Q2. b\n- A. x\n- X. Other\n[Answer]: X, a lot of things\n## Q3. c\n- A. x\n- B. y\n[Answer]: B and a half\n## Q4. d\n- A. x\n- B. y\n[Answer]: A, B — both apply\n");
  expect(prose.questions.map((q) => [q.answers, q.answerText])).toEqual([
    [["A"], "e.g. with caveat"],
    [["X"], "a lot of things"],
    [["B"], "and a half"],
    [["A"], "B — both apply"],
  ]);
});

test("a sub-heading inside a question does not close it: deeper headings keep the options and answer", () => {
  const md = "## Question 1 — Way of working?\nSome prompt.\n\nA. Short-lived branches\nB. Keep every commit\nX. Other (please specify)\n\n### Notes\nThese notes belong to the question, not to a new section.\n\n[Answer]: B\n\n## Question 2 — Next?\nA. one\n\n[Answer]: A\n";
  const r = parseQuestions(md);
  expect(r.questions.map((q) => q.id)).toEqual(["Q1", "Q2"]);
  expect(r.questions[0]!.options.map((o) => o.key)).toEqual(["A", "B", "X"]);
  expect(r.questions[0]!.answer).toBe("B");
  expect(r.questions[1]!.answer).toBe("A");
});

test("a heading at the question's own level or shallower still closes it", () => {
  const r = parseQuestions("### Q1. a\n- A. x\n### Other section\n[Answer]: A\n## Q2. b\n- A. y\n[Answer]: A\n");
  expect(r.questions[0]!.answer).toBeNull(); // the [Answer] after a same-level heading is no longer the question's
  expect(r.questions[1]!.answer).toBe("A");
});

test("inline answers, context block, Other free text", () => {
  const r = parseQuestions(INLINE);
  expect(r.context).toEqual(["IaC: Terraform", "Runtime: Fargate"]);
  expect(r.questions.map((q) => [q.id, q.answer])).toEqual([["Q1", "B"], ["Q2", "X"]]);
  expect(r.questions[0]!.options.map((o) => o.key)).toEqual(["A", "B", "X"]);
  expect(r.questions[1]!.answerText).toBe("eu-west-1 because of data residency");
  expect(r.questions[0]!.title).toBe("Does an existing framework cover this?");
});
test("batched answers; blank answer is null (waiting)", () => {
  const r = parseQuestions(BATCHED);
  expect(r.questions.map((q) => q.answer)).toEqual(["A", null]);
});

test("answer letter with trailing explanation, lowercase, and option text", () => {
  const r = parseQuestions("## Q1. a\n- A. x\n- B. y\n[Answer]: B \u2014 because reasons\n## Q2. b\n- A. x\n[Answer]: b\n## Q3. c\n- A. x\n[Answer]: A. us-east-1 (N. Virginia)\n## Q4. d\n- A. x\n[Answer]: Banana\n");
  expect(r.questions.map((q) => [q.answer, q.answerText])).toEqual([["B", "because reasons"], ["B", null], ["A", "us-east-1 (N. Virginia)"], ["X", "Banana"]]);
});

test("wrapped option lines continue the option above (up to a blank line, option, answer or heading)", () => {
  const md = "## Q1. Retry bound?\nWhat bound?\n- A. Reuse the scaffold's defaults (max 3 retries, base 0.1s /\n  cap 2.0s per delay) AND commit a ceiling\n  of ~10s total.\n- B. A larger budget\n- X. Other (please specify)\n\n[Answer]: A\n\nA trailing note that is not an option.\n## Q2. Next\n- A. one\n  two\n[Answer]: A\n";
  const r = parseQuestions(md);
  expect(r.questions[0]!.options.map((o) => o.text)).toEqual(["Reuse the scaffold's defaults (max 3 retries, base 0.1s / cap 2.0s per delay) AND commit a ceiling of ~10s total.", "A larger budget", "Other (please specify)"]);
  expect(r.questions[0]!.prompt).toBe("What bound?");
  expect(r.questions[1]!.options[0]!.text).toBe("one two");
  expect(r.questions[1]!.answer).toBe("A");
});
