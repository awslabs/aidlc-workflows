// timeWindow(): which stretch of time collect.ts reads. The default runs from 7
// days before the last AI-DLC activity up to now: when the hooks stopped
// writing, the last audit row is before the trouble while the chat logs go on.
// A time that does not parse is left out with a note, never a crash.

import { expect, test } from "bun:test";
import { type AuditRow, timeWindow } from "../../core/skills/aidlc-issue-report/scripts/lib-audit.ts";

const H = 3_600_000;
const now = Date.parse("2026-10-29T12:00:00Z");
const row = (ts: string, event = "STAGE_STARTED"): AuditRow => ({ ts, event, fields: {}, intent: "i" });

test("a start with no end runs to now, past the last audit row", () => {
  const w = timeWindow({ since: "2026-10-29T00:00:00Z", rows: [row("2026-10-28T10:00:00Z")], now });
  expect(w.since).toBe(Date.parse("2026-10-29T00:00:00Z"));
  expect(w.until).toBe(now);
});

test("the default starts 7 days before the last AI-DLC activity and ends now", () => {
  const w = timeWindow({ rows: [row("2026-10-28T10:00:00Z")], now });
  expect(w.until).toBe(now);
  expect(w.since).toBe(Date.parse("2026-10-28T10:00:00Z") - 7 * 24 * H - 2 * H);
});

test("this skill's own doctor row does not move the default", () => {
  const w = timeWindow({ rows: [row("2026-10-28T10:00:00Z"), row("2026-10-29T11:00:00Z", "HEALTH_CHECKED")], now });
  expect(w.since).toBe(Date.parse("2026-10-28T10:00:00Z") - 7 * 24 * H - 2 * H);
});

test("a recorded time that does not parse, or a day count that is not one, cannot break the window", () => {
  const w = timeWindow({ rows: [row("2026-10-28T10:00:00Z"), row("not a time")], days: "Infinity", now });
  expect(Number.isFinite(w.since) && Number.isFinite(w.until)).toBe(true);
});

test("a time that does not parse is left out with a note", () => {
  const w = timeWindow({ since: "yesterday afternoon", until: "2026-10-29T25:00:00Z", rows: [row("2026-10-28T10:00:00Z")], now });
  expect(Number.isNaN(w.since) || Number.isNaN(w.until)).toBe(false);
  expect(w.notes.length).toBe(2);
});

test("an end before the start is swapped, not read as an empty window", () => {
  const w = timeWindow({ since: "2026-10-29T10:00:00Z", until: "2026-10-29T08:00:00Z", rows: [], now });
  expect(w.since).toBeLessThan(w.until);
  expect(w.notes.length).toBe(1);
});

test("the HUMAN_TURN rows at the end (the person asking for this report) do not move the window", () => {
  const rows: AuditRow[] = [
    { ts: "2026-10-01T10:00:00Z", event: "STAGE_STARTED", fields: {}, intent: "i" },
    { ts: "2026-10-28T09:00:00Z", event: "HUMAN_TURN", fields: {}, intent: "i" },
  ];
  const w = timeWindow({ rows, now: Date.parse("2026-10-28T09:05:00Z") });
  expect(w.lastActivity).toBe("2026-10-01T10:00:00Z");
  expect(w.until).toBe(Date.parse("2026-10-28T09:05:00Z"));
});

test("with nothing but HUMAN_TURN rows, the last of them sets the window", () => {
  const rows: AuditRow[] = [
    { ts: "2026-07-01T10:00:00Z", event: "HUMAN_TURN", fields: {}, intent: "i" },
    { ts: "2026-10-28T09:00:00Z", event: "HUMAN_TURN", fields: {}, intent: "i" },
  ];
  expect(timeWindow({ rows, now: Date.parse("2026-10-28T09:05:00Z") }).lastActivity).toBe("2026-10-28T09:00:00Z");
});
