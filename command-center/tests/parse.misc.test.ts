import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readReviewRecords } from "../../core/command-center/server/parse/reviews";
import { parseEmbeddedReview } from "../../core/command-center/server/parse/reviews";
import { parseLearnings } from "../../core/command-center/server/parse/learnings";
import { parseStageMemory } from "../../core/command-center/server/parse/memory";
import { readLedgerTokens } from "../../core/command-center/server/parse/ledger";
import { makeWorkspace } from "./fixtures/make";
import { countPractices } from "../../core/command-center/server/lenses";

test("embedded review with findings table", () => {
  const md = `# Doc\n\n## Review\n\n**Verdict:** NOT-READY\n**Reviewer:** aidlc-architecture-reviewer-agent\n**Iteration:** 1\n\n### Findings\n\n| # | Severity | Location | Finding | Recommendation |\n|---|---|---|---|---|\n| 1 | Major | §3 | Contradiction | Fix it |\n| 2 | Minor | §4 | Typo | Fix |\n`;
  const r = parseEmbeddedReview(md)!;
  expect(r.verdict).toBe("NOT-READY");
  expect(r.iteration).toBe(1);
  expect(r.findings.map((f) => f.severity)).toEqual(["Major", "Minor"]);
});
test("learnings from cid markers", () => {
  const l = parseLearnings({ "project.md": "## Corrections\n- Never invent a metric (learned 2026-08-12) <!-- cid:intent-capture:c7 -->\n- plain line\n" });
  expect(l).toEqual([{ stage: "intent-capture", cid: "c7", date: "2026-08-12", text: "Never invent a metric", file: "project.md" }]);
});
test("stage memory headings", () => {
  const m = parseStageMemory("## Interpretations\n- a\n## Deviations\n- gate deadlock\n## Tradeoffs\n## Open questions\n- which version?\n");
  expect(m.deviations).toEqual(["gate deadlock"]);
  expect(m.openQuestions).toEqual(["which version?"]);
});
test("ledger tokens by intent uuid; missing ledger is not recorded", async () => {
  const ws = await makeWorkspace();
  const t = await readLedgerTokens(ws, "u-1");
  expect(t.recorded && t.value.totals.input).toBe(1000);
  const ws2 = await makeWorkspace({ withLedger: false });
  const t2 = await readLedgerTokens(ws2, "u-1");
  expect(t2.recorded).toBe(false);
});

const FINDINGS = "### Findings\n\n| # | Severity | Location | Finding | Recommendation |\n|---|---|---|---|---|\n| 1 | Major | §3 | Contradiction | Fix it |\n";
const RESOLUTION = "### Finding Resolution Table\n\n| # | Original Severity | RESOLVED / NOT-RESOLVED | Evidence |\n|---|---|---|---|\n| 1 | Major | RESOLVED | Fixed in §3 |\n| 2 | Minor | not-resolved | Still open |\n";

test("resolution table and findings table in one review", () => {
  const r = parseEmbeddedReview(`## Review\n\n**Verdict:** READY\n\n${FINDINGS}\n${RESOLUTION}`)!;
  expect(r.findings).toEqual([
    { severity: "Major", location: "§3", finding: "Contradiction", status: null },
    { severity: "Major", location: "", finding: "Fixed in §3", status: "RESOLVED" },
    { severity: "Minor", location: "", finding: "Still open", status: "NOT-RESOLVED" },
  ]);
});
test("doc with only a resolution table", () => {
  const r = parseEmbeddedReview(`# D\n\n## Review\n**Verdict:** READY\n\n${RESOLUTION}`)!;
  expect(r.findings.map((f) => f.status)).toEqual(["RESOLVED", "NOT-RESOLVED"]);
});
test("## Review heading is matched whole; Reviewer Notes does not end or replace it; offset 0 works", () => {
  const r = parseEmbeddedReview(`## Review\n**Verdict:** READY\n\n## Reviewer Notes\nnothing\n`)!;
  expect(r.verdict).toBe("READY");
  expect(parseEmbeddedReview("# Doc\n\n## Review Summary\n**Verdict:** READY\n")).toBeNull();
});
test("section ends at next ## heading", () => {
  const r = parseEmbeddedReview(`## Review\n**Verdict:** READY\n\n## Appendix\n**Verdict:** BAD\n| 1 | Major | x | y | z |\n`)!;
  expect(r.verdict).toBe("READY");
  expect(r.findings).toEqual([]);
});
test("readReviewRecords reads nested json", async () => {
  const ws = await makeWorkspace();
  const rec = join(ws, "aidlc/spaces/default/intents/260811-demo");
  const d = join(rec, ".aidlc-engine/reviews/feasibility/stage/1");
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "1.json"), JSON.stringify({ stage: "feasibility", unit: null, iteration: 1, reviewer: "aidlc-architecture-reviewer-agent", verdict: "READY", findings: [{ severity: "Minor", location: "§1", finding: "Typo", status: "RESOLVED" }], recorded_at: "2026-08-12T17:30:00Z" }));
  const r = await readReviewRecords(rec);
  expect(r).toEqual([{ stage: "feasibility", unit: null, iteration: 1, reviewer: "aidlc-architecture-reviewer-agent", verdict: "READY", recordedAt: "2026-08-12T17:30:00Z", findings: [{ severity: "Minor", location: "§1", finding: "Typo", status: "RESOLVED" }] }]);
  expect(await readReviewRecords(join(ws, "nowhere"))).toEqual([]);
});

test("practices: bare NEVER/ALWAYS lines and bullets inside Forbidden/Mandated, comments ignored, --- ends a section", () => {
  const md = [
    "## Code Style", "- not a practice", "---", "",
    "## Forbidden", "", "<!-- Format: NEVER [behavior] (affirmed [date]) -->", "<!-- Example: NEVER throw across layers (affirmed 2026-05-17) -->", "<!--", "NEVER inside a multi-line comment", "-->",
    "NEVER place a sleep call in framework code. (affirmed 2026-08-12)", "never retry a failing test (affirmed 2026-08-12)", "- a bulleted forbidden rule", "Some prose that is not a rule.",
    "## Mandated", "<!-- Format: ALWAYS [behavior] -->", "ALWAYS inject credentials from the environment. (affirmed 2026-08-12)", "Always scope each test to unique keys.",
    "--- (affirmed 2026-08-12)", "ALWAYS after the rule line is not counted",
    "## Corrections", "- NEVER invent a metric (learned 2026-08-12) <!-- cid:intent-capture:c7 -->",
  ].join("\n");
  expect(countPractices(md)).toEqual({ mandated: 2, forbidden: 3 });
});
