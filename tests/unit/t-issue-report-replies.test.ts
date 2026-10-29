// matchReplies(): did each reply the person typed reach AI-DLC's record? A
// reply is matched to a HUMAN_TURN a few seconds around it; when both carry a
// session, only the same session's turn counts, so a second chat open at the
// same time cannot answer for it.

import { expect, test } from "bun:test";
import { type AuditRow, matchReplies, rowSession } from "../../core/skills/aidlc-issue-report/scripts/lib-audit.ts";
import type { Prompt } from "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts";

const at = (s: number) => `2026-10-29T01:00:${String(s).padStart(2, "0")}.000Z`;
const turn = (s: number, session?: string): AuditRow => {
  const r: AuditRow = { ts: at(s), event: "HUMAN_TURN", fields: {}, intent: "i" };
  if (session) rowSession.set(r, session);
  return r;
};
const typed = (s: number, session?: string): Prompt => ({ tool: "codex", ts: at(s), text: "x", ...(session ? { session } : {}) });

test("another session's turn does not record this reply", () => {
  const r = matchReplies([typed(30, "s1")], [turn(0, "s1"), turn(32, "s2")]);
  expect(r.recorded).toBe(0);
  expect(r.notRecorded.length).toBe(1);
});

test("the same session's turn records it", () => {
  expect(matchReplies([typed(30, "s1")], [turn(0, "s1"), turn(32, "s1")]).recorded).toBe(1);
});

test("without a session on either side, the time alone decides", () => {
  expect(matchReplies([typed(30)], [turn(0), turn(32, "s2")]).recorded).toBe(1);
});

test("a reply that was not about the AI-DLC work is not expected in its record", () => {
  const offTopic: Prompt = { ...typed(30, "s1"), engineAfter: false };
  expect(matchReplies([offTopic], [turn(0, "s1")]).checked).toBe(0);
});

test("with no HUMAN_TURN at all, every reply an AI-DLC command followed is listed as not recorded", () => {
  const r = matchReplies([{ ...typed(10), engineAfter: true }, { ...typed(20), engineAfter: true }, typed(30)], []);
  expect(r.checked).toBe(2);
  expect(r.notRecorded.length).toBe(2);
});

test("the HUMAN_TURN of the report's own request is not the run's", async () => {
  const { withoutReportTurns } = await import("../../core/skills/aidlc-issue-report/scripts/lib-audit.ts");
  const report: Prompt = { ...typed(40), report: true };
  const rows = withoutReportTurns([turn(41)], [typed(10), report]);
  expect(rows).toEqual([]);
  const r = matchReplies([{ ...typed(10), engineAfter: true }, report], rows);
  expect(r.notRecorded.length).toBe(1);
});
