// What the Decisions cards actually render: every chosen option of a multi-select is marked, and an answer the
// server could not match to an option is shown verbatim instead of marking one.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentCard, Card } from "../ui/src/lenses/Decisions";

const multi = {
  id: "Q9", title: "Hard rules? (select all that apply)", prompt: "",
  options: [{ key: "A", text: "No hardcoded secrets" }, { key: "B", text: "Encrypt at rest" }, { key: "C", text: "Least-privilege roles" }, { key: "X", text: "Other (please specify)" }],
  answer: "B", answers: ["B", "C"], answerText: null,
};

test("a file-backed multi-select marks every chosen option, open or collapsed", () => {
  const open = renderToStaticMarkup(<Card q={multi} open onToggle={() => {}} />);
  expect(open.match(/✓ CHOSEN/g)?.length).toBe(2);
  expect(open.match(/class="opt sel"/g)?.length).toBe(2);
  expect(open).toContain("Encrypt at rest");
  expect(open).toContain("Least-privilege roles");
  const shut = renderToStaticMarkup(<Card q={multi} open={false} onToggle={() => {}} />);
  expect(shut).toContain("✓ B, C");
});

test("an unanswered file-backed question still says it is waiting on you", () => {
  const html = renderToStaticMarkup(<Card q={{ ...multi, answer: null, answers: [] }} open onToggle={() => {}} />);
  expect(html).toContain("Waiting on you");
  expect(html).not.toContain("✓ CHOSEN");
});

test("an agent decision renders its questions as cards with the chosen options marked", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:02:00Z", stage: "nfr-requirements", unit: null, decision: "Questions 1-2: branching, hard rules",
    answerText: "Q1: Short-lived branches, squash; Q2: Encrypt at rest, Least-privilege roles",
    questions: [
      { id: "Q1", title: "branching", options: ["Short-lived branches squash", "Keep every commit"], answer: ["Short-lived branches squash"], answerRaw: "Short-lived branches, squash" },
      { id: "Q2", title: "hard rules", options: ["No hardcoded secrets", "Encrypt at rest", "Least-privilege roles"], answer: ["Encrypt at rest", "Least-privilege roles"], answerRaw: "Encrypt at rest, Least-privilege roles" },
    ],
  }} />);
  expect(html).toContain("Q1 — branching");
  expect(html).toContain("Q2 — hard rules");
  expect(html).toContain("Keep every commit"); // every option is listed, not just the chosen one
  expect(html.match(/✓ CHOSEN/g)?.length).toBe(3);
  expect(html).not.toContain("Recorded answer");
});

test("an agent answer that matched no option is shown as the recorded answer, and none is marked", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:04:00Z", stage: "nfr-requirements", unit: null, decision: "Question 3: deployment",
    answerText: "Q3: whatever I typed instead",
    questions: [{ id: "Q3", title: "deployment", options: ["Deploy from my machine", "Dev and prod with approval"], answer: null, answerRaw: "whatever I typed instead" }],
  }} />);
  expect(html).toContain("Recorded answer");
  expect(html).toContain("whatever I typed instead");
  expect(html).not.toContain("✓ CHOSEN");
});

test("an agent decision with no answer yet is marked as waiting on you", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:07:00Z", stage: "code-generation", unit: null, decision: "Pick a storage shape", answerText: null,
    questions: [{ id: "", title: "Pick a storage shape", options: ["Rows", "Documents"], answer: null, answerRaw: null }],
  }} />);
  expect(html).toContain("Waiting on you");
  expect(html).not.toContain("✓ CHOSEN");
  expect(html).toContain("Documents");
});

test("an answer that named no question is shown in full on the decision, not dropped", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:02:00Z", stage: "nfr-requirements", unit: null, decision: "Questions 1-2: branching, hard rules",
    answerText: "whichever you think best", unassigned: ["whichever you think best"],
    questions: [
      { id: "Q1", title: "branching", options: ["Short-lived branches", "Keep every commit"], answer: null, answerRaw: null },
      { id: "Q2", title: "hard rules", options: ["Encrypt at rest", "No rules"], answer: null, answerRaw: null },
    ],
  }} />);
  expect(html).toContain("Recorded answer");
  expect(html).toContain("whichever you think best");
  expect(html).not.toContain("✓ CHOSEN");
  expect(html).not.toContain("Waiting on you");
});

test("answer pieces that named no question are shown as well as the ones that did", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:02:00Z", stage: "nfr-requirements", unit: null, decision: "Question 9: hard rules",
    answerText: "Q9: Encrypt at rest; No rules: Use my selections", unassigned: ["No rules: Use my selections"],
    questions: [{ id: "Q9", title: "hard rules", options: ["Encrypt at rest", "No rules"], answer: ["Encrypt at rest"], answerRaw: "Encrypt at rest" }],
  }} />);
  expect(html).toContain("✓ CHOSEN");
  expect(html).toContain("No rules: Use my selections");
});

test("a partly matched multi-select marks nothing and shows what was recorded", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:02:00Z", stage: "nfr-requirements", unit: null, decision: "Question 1: hard rules", answerText: "Q1: Encrypt at rest, my own extra rule",
    questions: [{ id: "Q1", title: "hard rules", options: ["No hardcoded secrets", "Encrypt at rest", "Least-privilege roles"], answer: null, answerRaw: "Encrypt at rest, my own extra rule" }],
  }} />);
  expect(html).not.toContain("✓ CHOSEN");
  expect(html).toContain("Recorded answer");
  expect(html).toContain("my own extra rule");
});

test("an answer that argues against an option marks nothing", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:02:00Z", stage: "nfr-requirements", unit: null, decision: "Question 1: storage", answerText: "Q1: Not Postgres, use DynamoDB",
    questions: [{ id: "Q1", title: "storage", options: ["Postgres", "DynamoDB", "SQLite"], answer: null, answerRaw: "Not Postgres, use DynamoDB" }],
  }} />);
  expect(html).not.toContain("✓ CHOSEN");
  expect(html).toContain("Not Postgres, use DynamoDB");
});

test("an ask that could not be matched to the recorded answer says so instead of guessing", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:00:00Z", stage: "nfr-requirements", unit: null, decision: "First ask, never answered", answerText: null, unresolved: true,
    questions: [{ id: "", title: "First ask, never answered", options: ["Rows", "Documents"], answer: null, answerRaw: null }],
  }} />);
  expect(html).toContain("Waiting on you");
  expect(html).toContain("could not be matched to this ask");
  expect(html).not.toContain("✓ CHOSEN");
});

test("an answer that belongs to no single ask is shown once, labelled as unmatched", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:01:00Z", stage: "nfr-requirements", unit: null, decision: "Second ask", answerText: null, unresolved: true, strayAnswers: ["Rows"],
    questions: [{ id: "", title: "Second ask", options: ["Rows", "Columns"], answer: null, answerRaw: null }],
  }} />);
  expect(html).toContain("not matched to a specific ask");
  expect(html).toContain("Rows");
  expect(html).not.toContain("✓ CHOSEN");
  expect(html).toContain("Waiting on you");
});

test("an answer and a later amendment both appear on the card", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:01:00Z", stage: "code-generation", unit: null, decision: "Only ask", answerText: "Rows", strayAnswers: ["Actually, Documents"],
    questions: [{ id: "", title: "Only ask", options: ["Rows", "Documents"], answer: ["Rows"], answerRaw: "Rows" }],
  }} />);
  expect(html).toContain("✓ CHOSEN");
  expect(html).toContain("not matched to a specific ask");
  expect(html).toContain("Actually, Documents");
});

test("two recorded lines with the same text are both rendered", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:01:00Z", stage: "code-generation", unit: null, decision: "Only ask", answerText: "Rows", strayAnswers: ["Rows again", "Rows again"],
    questions: [{ id: "", title: "Only ask", options: ["Rows", "Documents"], answer: ["Rows"], answerRaw: "Rows" }],
  }} />);
  expect(html.match(/Rows again/g)?.length).toBe(2);
});

test("an answer piece for a question the ask never offered is shown on the card", () => {
  const html = renderToStaticMarkup(<AgentCard d={{
    ts: "2026-08-14T09:01:00Z", stage: "nfr-requirements", unit: null, decision: "Question 1: a; Question 2: b",
    answerText: "Q1: x; Q2: p; Q3: a surprise", unassigned: ["Q3: a surprise"],
    questions: [
      { id: "Q1", title: "a", options: ["x", "y"], answer: ["x"], answerRaw: "x" },
      { id: "Q2", title: "b", options: ["p", "q"], answer: ["p"], answerRaw: "p" },
    ],
  }} />);
  expect(html).toContain("Also recorded");
  expect(html).toContain("Q3: a surprise");
  expect(html.match(/✓ CHOSEN/g)?.length).toBe(2);
});

test("a file-backed answer with free text beside a listed option still shows that text", () => {
  const html = renderToStaticMarkup(<Card q={{
    id: "Q1", title: "Way of working?", prompt: "", options: [{ key: "A", text: "Short-lived branches" }, { key: "B", text: "Keep every commit" }],
    answer: "A", answers: ["A"], answerText: "B — both apply",
  }} open onToggle={() => {}} />);
  expect(html).toContain("✓ CHOSEN");
  expect(html).toContain("Recorded answer");
  expect(html).toContain("B — both apply");
});
