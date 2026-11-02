// The Decisions lens over a run that batches its asks: DECISION_RECORDED rows pack several questions into one
// cell, and the answer lands in the next QUESTION_ANSWERED for the same stage.
import { expect, test } from "bun:test";
import { lensCtx, decisionsLens } from "../../core/command-center/server/lenses";
import { recordDirOf } from "../../core/command-center/server/model/intent";
import { listIntents } from "../../core/command-center/server/parse/registry";
import { loadCatalog } from "../../core/command-center/server/parse/stage-graph";
import { AUDIT_HEADER, block, makeWorkspace } from "./fixtures/make";

const STAGE = "nfr-requirements";
const BATCHED = AUDIT_HEADER
  + block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "How would you like to answer the questions?", Options: "Guide me,I'll edit the file,Chat" })
  + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Guide me" })
  + block("2026-08-14T09:01:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Questions 1-2: branching, hard rules", Options: "Q1: Short-lived branches squash / Keep every commit / Straight to main; Q2: No hardcoded secrets / Encrypt at rest / Least-privilege roles" })
  + block("2026-08-14T09:02:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: Short-lived branches, squash; Q2: Encrypt at rest, Least-privilege roles" })
  + block("2026-08-14T09:03:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 3: deployment; Question 4: answer-quality checks", Options: "Q3: Deploy from my machine / Dev and prod with approval; Q4: Advisory only / Gate the build" })
  + block("2026-08-14T09:04:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q3: whatever I typed instead; Q4: Advisory only" })
  // Two asks in a row, then their two answers in the same order: each decision takes its own.
  + block("2026-08-14T09:05:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Which notes should be remembered?", Options: "Note one,Note two" })
  + block("2026-08-14T09:05:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Anything to add for next time?", Options: "Nothing to add,Add a note" })
  + block("2026-08-14T09:06:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Note two" })
  + block("2026-08-14T09:06:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Nothing to add" })
  // Still waiting: no QUESTION_ANSWERED follows, and the stage closes right after.
  + block("2026-08-14T09:07:00Z", "DECISION_RECORDED", { Stage: "code-generation", Decision: "Pick a storage shape", Options: "Rows,Documents" })
  + block("2026-08-14T09:08:00Z", "GATE_APPROVED", { Stage: "code-generation" })
  + block("2026-08-14T09:09:00Z", "QUESTION_ANSWERED", { Stage: "code-generation", Details: "Rows" });

const QUESTIONS_FILE = `# Practices — Questions

## Question 1 — Way of working: how should changes reach the main branch?
A. Short-lived branches, squash-merged (suggested)
B. Keep every commit
X. Other (please specify)

[Answer]: A

## Question 2 — Hard rules? (select all that apply)
A. NEVER hardcode secrets
B. ALWAYS encrypt at rest
C. ALWAYS use least-privilege roles
X. Other (please specify)

[Answer]: B, C
`;

async function lens() {
  const ws = await makeWorkspace({ extraShard: BATCHED, questions: { [`construction/${STAGE}/${STAGE}-questions.md`]: QUESTIONS_FILE } });
  const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  return decisionsLens(await lensCtx(ws, ref!, recordDirOf(ws, ref!), cat.stages));
}

test("a worded questions file becomes a group of cards, multi-select included", async () => {
  const { groups } = await lens();
  const g = groups.find((x) => x.stage === STAGE)!;
  expect(g.questions.map((q) => q.id)).toEqual(["Q1", "Q2"]);
  expect(g.questions[0]!.options.length).toBe(3);
  expect(g.questions[0]!.answers).toEqual(["A"]);
  expect(g.questions[1]!.answers).toEqual(["B", "C"]);
});

test("each DECISION_RECORDED carries the next QUESTION_ANSWERED for its stage, used once", async () => {
  const { agentDecisions } = await lens();
  const mine = agentDecisions.filter((d) => d.stage === STAGE);
  expect(mine.map((d) => d.answerText)).toEqual([
    "Guide me",
    "Q1: Short-lived branches, squash; Q2: Encrypt at rest, Least-privilege roles",
    "Q3: whatever I typed instead; Q4: Advisory only",
    "Note two",
    "Nothing to add",
  ]);
});

test("an unanswered ask stays unanswered: a later answer past the gate is not borrowed", async () => {
  const { agentDecisions } = await lens();
  const d = agentDecisions.find((x) => x.decision === "Pick a storage shape")!;
  expect(d.answerText).toBeNull();
  expect(d.questions[0]!.answer).toBeNull();
  expect(d.questions[0]!.answerRaw).toBeNull();
});

test("an unlabelled ask is one question titled by the decision, its answer matched", async () => {
  const { agentDecisions } = await lens();
  const d = agentDecisions.find((x) => x.decision.startsWith("How would you like"))!;
  expect(d.questions).toEqual([{ id: "", title: "How would you like to answer the questions?", options: ["Guide me", "I'll edit the file", "Chat"], answer: ["Guide me"], answerRaw: "Guide me" }]);
});

test("a packed ask splits into per-question options; labels come from the decision; multi-select marks each", async () => {
  const { agentDecisions } = await lens();
  const d = agentDecisions.find((x) => x.decision.startsWith("Questions 1-2"))!;
  expect(d.questions.map((q) => [q.id, q.title])).toEqual([["Q1", "branching"], ["Q2", "hard rules"]]);
  expect(d.questions[0]!.options).toEqual(["Short-lived branches squash", "Keep every commit", "Straight to main"]);
  expect(d.questions[0]!.answer).toEqual(["Short-lived branches squash"]);
  expect(d.questions[1]!.answer).toEqual(["Encrypt at rest", "Least-privilege roles"]);
  expect(d.questions[1]!.answerRaw).toBe("Encrypt at rest, Least-privilege roles");
});

test("`Question 9: …; Question 10: …` labels by id; an answer that matches nothing stays verbatim", async () => {
  const { agentDecisions } = await lens();
  const d = agentDecisions.find((x) => x.decision.startsWith("Question 3"))!;
  expect(d.questions.map((q) => [q.id, q.title])).toEqual([["Q3", "deployment"], ["Q4", "answer-quality checks"]]);
  expect(d.questions[0]!.answer).toBeNull();
  expect(d.questions[0]!.answerRaw).toBe("whatever I typed instead");
  expect(d.questions[1]!.answer).toEqual(["Advisory only"]);
});

async function decisions(shard: string) {
  const ws = await makeWorkspace({ extraShard: AUDIT_HEADER + shard });
  const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  return (await decisionsLens(await lensCtx(ws, ref!, recordDirOf(ws, ref!), cat.stages))).agentDecisions;
}

test("labels are used only when they count out: otherwise the question keeps its Q<n>", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Questions 1-3: one, two", Options: "Q1: a / b; Q2: c / d; Q3: e / f" }));
  expect(d[0]!.questions.map((q) => q.title)).toEqual(["", "", ""]);
  expect(d[0]!.questions.map((q) => q.id)).toEqual(["Q1", "Q2", "Q3"]);
});

test("an answer that names no question is kept verbatim on the decision, never dropped", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Questions 1-2: branching, hard rules", Options: "Q1: Short-lived branches / Keep every commit; Q2: Encrypt at rest / No rules" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "whichever you think best" }));
  expect(d[0]!.answerText).toBe("whichever you think best");
  expect(d[0]!.questions.map((q) => [q.answer, q.answerRaw])).toEqual([[null, null], [null, null]]);
});

test("answer pieces that name no question are carried verbatim alongside the ones that do", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 9: hard rules; Question 10: proof", Options: "Q9: Encrypt at rest / Least-privilege roles / None; Q10: You deploy then I smoke test / Mocked tests only" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q9: Encrypt at rest, Least-privilege roles; No rules: Use my selections; Q10: You deploy then I smoke test" }));
  expect(d[0]!.questions[0]!.answer).toEqual(["Encrypt at rest", "Least-privilege roles"]);
  expect(d[0]!.questions[1]!.answer).toEqual(["You deploy then I smoke test"]);
  expect(d[0]!.unassigned).toEqual(["No rules: Use my selections"]);
});

test("a partly matched answer marks nothing: all of it must land on options, or none does", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: hard rules; Question 2: prod only?", Options: "Q1: No hardcoded secrets / Encrypt at rest / Least-privilege roles; Q2: Yes / No" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: Encrypt at rest, my own extra rule; Q2: Yes, but only for prod" }));
  expect(d[0]!.questions.map((q) => q.answer)).toEqual([null, null]);
  expect(d[0]!.questions.map((q) => q.answerRaw)).toEqual(["Encrypt at rest, my own extra rule", "Yes, but only for prod"]);
});

test("an answer that merely mentions an option word matches nothing", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: storage", Options: "Q1: Postgres / DynamoDB / SQLite" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: Not Postgres, use DynamoDB" }));
  expect(d[0]!.questions[0]!.answer).toBeNull();
  expect(d[0]!.questions[0]!.answerRaw).toBe("Not Postgres, use DynamoDB");
});

test("one answer for two asks goes to the ask whose options it names, not to the newest", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "First ask", Options: "Rows,Documents" })
    + block("2026-08-14T09:01:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Second ask", Options: "Nothing to add,Add a note" })
    + block("2026-08-14T09:02:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Rows" }));
  expect(d[0]!.answerText).toBe("Rows");
  expect(d[0]!.questions[0]!.answer).toEqual(["Rows"]);
  expect(d[1]!.answerText).toBeNull();
  expect(d[1]!.questions[0]!.answer).toBeNull();
  expect([d[0]!.unresolved, d[1]!.unresolved]).toEqual([false, false]); // the answer was placed with certainty
  expect([d[0]!.strayAnswers, d[1]!.strayAnswers]).toEqual([[], []]);
});

test("an unanswered ask does not take the next ask's answer", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "First ask, never answered", Options: "Rows,Documents" })
    + block("2026-08-14T09:01:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Second ask", Options: "Nothing to add,Add a note" })
    + block("2026-08-14T09:02:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Nothing to add" }));
  expect(d[0]!.answerText).toBeNull();
  expect(d[0]!.questions[0]!.answer).toBeNull();
  expect(d[1]!.answerText).toBe("Nothing to add");
  expect(d[1]!.questions[0]!.answer).toEqual(["Nothing to add"]);
});

test("an answer that could belong to either ask is given to neither, and shown once", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "First ask", Options: "Rows,Documents" })
    + block("2026-08-14T09:01:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Second ask", Options: "Rows,Columns" })
    + block("2026-08-14T09:02:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Rows" }));
  expect(d.map((x) => x.answerText)).toEqual([null, null]);
  expect(d.map((x) => x.questions[0]!.answer)).toEqual([null, null]);
  expect(d.map((x) => x.unresolved)).toEqual([true, true]);
  expect(d.map((x) => x.strayAnswers)).toEqual([[], ["Rows"]]); // shown once, on the newest ask of the run
});

test("a second answer to one ask — an amendment — is kept and shown, not discarded", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Only ask", Options: "Rows,Documents" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Rows" })
    + block("2026-08-14T09:02:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Actually, Documents" }));
  expect(d[0]!.answerText).toBe("Rows");
  expect(d[0]!.questions[0]!.answer).toEqual(["Rows"]);
  expect(d[0]!.strayAnswers).toEqual(["Actually, Documents"]);
});

test("a whole answer is only taken as one option when it is that option word for word", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: shape", Options: "Q1: Rows / Documents / Rows, Documents and more" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: Rows, Documents" }));
  expect(d[0]!.questions[0]!.answer).toEqual(["Rows", "Documents"]);
});

test("which ask an answer belongs to does not depend on the order the answers were recorded", async () => {
  const asks = block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Ask A", Options: "Rows,Ledger" })
    + block("2026-08-14T09:01:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Ask B", Options: "Rows,Columns" })
    + block("2026-08-14T09:02:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Ask C", Options: "Something else,Nothing" });
  const answers = (first: string, second: string) =>
    block("2026-08-14T09:03:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: first })
    + block("2026-08-14T09:04:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: second });
  // "Ledger" fits only ask A; "Rows" fits A and B, so it belongs to neither.
  const shown = (d: Awaited<ReturnType<typeof decisions>>) => d.map((x) => [x.decision, x.answerText, x.unresolved, x.strayAnswers]);
  expect(shown(await decisions(asks + answers("Ledger", "Rows")))).toEqual([
    ["Ask A", "Ledger", false, []],
    ["Ask B", null, true, []],
    ["Ask C", null, true, ["Rows"]],
  ]);
  expect(shown(await decisions(asks + answers("Rows", "Ledger")))).toEqual(shown(await decisions(asks + answers("Ledger", "Rows"))));
});

test("an answer recorded with no text at all takes no slot and raises no doubt", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Only ask", Options: "Rows,Documents" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "" })
    + block("2026-08-14T09:02:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Documents" }));
  expect(d[0]!.answerText).toBe("Documents");
  expect(d[0]!.unresolved).toBe(false);
  expect(d[0]!.strayAnswers).toEqual([]);
});

test("an answer whose own text is one option is matched whole, commas and all", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: branching", Options: "Q1: Trunk-based squash / Trunk-based keep commits / Direct to main / GitFlow" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: Trunk-based, squash" }));
  expect(d[0]!.questions[0]!.answer).toEqual(["Trunk-based squash"]);
  expect(d[0]!.questions[0]!.answerRaw).toBe("Trunk-based, squash");
});

test("an answer piece for a question the ask never offered, or a repeated one, is kept verbatim", async () => {
  const unknown = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: a; Question 2: b", Options: "Q1: x / y; Q2: p / q" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: x; Q2: p; Q3: a surprise" }));
  expect(unknown[0]!.questions.map((q) => q.answer)).toEqual([["x"], ["p"]]);
  expect(unknown[0]!.unassigned).toEqual(["Q3: a surprise"]);
  const twice = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: a", Options: "Q1: x / y" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: x; Q1: y" }));
  expect(twice[0]!.questions[0]!.answerRaw).toBe("x");
  expect(twice[0]!.unassigned).toEqual(["Q1: y"]);
});

test("an option is only matched on whole words: SQL chooses neither SQLite nor a NoSQL store", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: storage", Options: "Q1: SQLite / NoSQL store / Rows and columns" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: SQL" }));
  expect(d[0]!.questions[0]!.answer).toBeNull();
  expect(d[0]!.questions[0]!.answerRaw).toBe("SQL");
});

test("a long truncation of one option counts, inside a multi-select too", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 9: hard rules", Options: "Q9: No hardcoded secrets / Private encrypted documents / Least-privilege roles / Never deploy to production / None" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q9: Least-privilege roles, Never deploy to prod" }));
  expect(d[0]!.questions[0]!.answer).toEqual(["Least-privilege roles", "Never deploy to production"]);
  expect(d[0]!.questions[0]!.answerRaw).toBe("Least-privilege roles, Never deploy to prod");
});

test("brackets round a qualifier do not hide the option it names", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 3: how big should the slices be?", Options: "Q3: Standard 10-14 / Coarse 6-8 / Fine 18+" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q3: Coarse (6-8)" }));
  expect(d[0]!.questions[0]!.answer).toEqual(["Coarse 6-8"]);
  expect(d[0]!.questions[0]!.answerRaw).toBe("Coarse (6-8)");
});

test("if dropping the brackets makes the answer fit two options, neither is marked", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: file size", Options: "Q1: Large (100 MB) / Large 100 MB / Small" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: Large 100 MB" }));
  expect(d[0]!.questions[0]!.answer).toBeNull();
  expect(d[0]!.questions[0]!.answerRaw).toBe("Large 100 MB");
});

test("a short truncation is not enough: it has to be most of the option it cuts short", async () => {
  const short = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: hard rules", Options: "Q1: Never deploy to production / Encrypt at rest" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: No" }));
  expect(short[0]!.questions[0]!.answer).toBeNull();
  expect(short[0]!.questions[0]!.answerRaw).toBe("No");
  // Two options cut short to the same text are ambiguous, so neither is marked.
  const both = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Question 1: branching", Options: "Q1: Trunk-based squashing / Trunk-based squashes" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: Trunk-based squash" }));
  expect(both[0]!.questions[0]!.answer).toBeNull();
  expect(both[0]!.questions[0]!.answerRaw).toBe("Trunk-based squash");
});

test("a decision with no unit does not take an answer recorded against a unit", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: "code-generation", Decision: "Pick a storage shape", Options: "Rows,Documents" })
    + block("2026-08-14T09:01:00Z", "QUESTION_ANSWERED", { Stage: "code-generation", Unit: "beta", Details: "Rows" }));
  expect(d[0]!.answerText).toBeNull();
  expect(d[0]!.questions[0]!.answer).toBeNull();
});

test("a label list survives extra words before the colon, as long as it still counts out", async () => {
  const d = await decisions(block("2026-08-14T09:00:00Z", "DECISION_RECORDED", { Stage: STAGE, Decision: "Questions 1-2 and follow-up 3: sign-in, visibility, file types", Options: "Q1: a / b; Q2: c / d; Q3: e / f" }));
  expect(d[0]!.questions.map((q) => q.title)).toEqual(["sign-in", "visibility", "file types"]);
});
