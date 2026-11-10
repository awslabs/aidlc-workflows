// withoutReportTurns(): the HUMAN_TURN rows written while this report was made
// are the report's, not the run's. In the report's own session every row from
// two seconds before its first message on is left out; without a session on
// either side, only a row beside a report message is. Another chat's rows stay
// the run's. No reply is paired with a row.

import { expect, test } from "bun:test";
import { type AuditRow, rowSession, withoutReportTurns } from "../../core/skills/aidlc-issue-report/scripts/lib-audit.ts";
import type { Prompt } from "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts";

const at = (s: number) => `2026-10-29T01:00:${String(s).padStart(2, "0")}.000Z`;
const turn = (s: number, session?: string): AuditRow => {
  const r: AuditRow = { ts: at(s), event: "HUMAN_TURN", fields: {}, intent: "i" };
  if (session) rowSession.set(r, session);
  return r;
};
const typed = (s: number, session?: string): Prompt => ({ tool: "codex", ts: at(s), text: "x", ...(session ? { session } : {}) });
const report = (p: Prompt): Prompt => ({ ...p, report: true });

test("the report's own turns are left out from its first message on, the run's turns before it stay", () => {
  const run = turn(30, "s1");
  const rows = [run, turn(39, "s1"), turn(50, "s1")];
  expect(withoutReportTurns(rows, [typed(30, "s1"), report(typed(40, "s1")), report(typed(50, "s1"))])).toEqual([run]);
  // A run reply three seconds before the report's request keeps its own turn; one inside the two seconds does not.
  const close = turn(35, "s1");
  expect(withoutReportTurns([close, turn(38, "s1")], [typed(35, "s1"), report(typed(38, "s1"))])).toEqual([close]);
  expect(withoutReportTurns([turn(37, "s1")], [typed(37, "s1"), report(typed(38, "s1"))])).toEqual([]);
});

test("another session's turn at the report's time stays the run's", () => {
  const other = turn(41, "s-run");
  expect(withoutReportTurns([other, turn(42, "s-report")], [report(typed(40, "s-report"))])).toEqual([other]);
});

test("a report message with no session, or a row with none, is read by time, beside the message only", () => {
  const before = turn(10, "s2");
  const later = turn(55, "s2");
  expect(withoutReportTurns([before, turn(41, "s2"), later], [report(typed(40))])).toEqual([before, later]);
  const runLater = turn(55);
  expect(withoutReportTurns([turn(41), runLater], [report(typed(40, "s1"))])).toEqual([runLater]);
});

test("a Kiro report message keeps to its own session when a row names it, and is read by time when none does", () => {
  const kiro: Prompt = { tool: "kiro (v3: Kiro CLI)", ts: at(40), text: "x", session: "sess_r", sessionLoose: true, report: true };
  const other = turn(41, "sess_run");
  expect(withoutReportTurns([other, turn(42, "sess_r")], [kiro])).toEqual([other]);
  // The adapter recorded an id of its own for the report's chat: no row names sess_r.
  const earlier = turn(30, "s_c");
  const otherChatLater = turn(58, "s_c");
  expect(withoutReportTurns([earlier, turn(41, "kiro-legacy-1"), otherChatLater], [kiro])).toEqual([earlier, otherChatLater]);
  // A chat the run's own replies name keeps its turn at the report's time.
  const runChat = turn(43, "s_c");
  expect(withoutReportTurns([runChat, turn(41, "kiro-legacy-1")], [typed(30, "s_c"), kiro])).toEqual([runChat]);
});

test("with no report message, or one with no time of its own, every row stays", () => {
  const rows = [turn(10, "s1"), turn(50, "s1")];
  expect(withoutReportTurns(rows, [typed(10, "s1")])).toEqual(rows);
  expect(withoutReportTurns(rows, [{ ...report(typed(5, "s1")), noTime: true }])).toEqual(rows);
});
