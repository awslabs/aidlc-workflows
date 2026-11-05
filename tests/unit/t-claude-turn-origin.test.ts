// Who started a Claude Code turn, from the host's own marks
// (core/tools/aidlc-claude-turn-origin.ts, and claudeTranscriptOrigin's
// `turnOrigin`). Claude Code 2.1.278 and 2.1.318, captured live: a scheduled
// wake-up hands the prompt hook the same keys as a typed prompt, and its turn's
// own transcript row lands only after the hook returns; before the turn, Claude
// Code writes the fire's queued prompt (`queue-operation` enqueue) and the fire
// (`system` `scheduled_task_fire`), which reach the file about 100 ms after the
// fire. The hook's `source` field (defined, not sent by those builds) decides
// first when a build sends it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHookSourceOrigin, claudeScheduledFireOrigin } from "../../core/tools/aidlc-claude-turn-origin.ts";
import { claudeTranscriptOrigin } from "../../core/tools/aidlc-lib.ts";

const TICK = "Say the word tock. On the third scheduled run, cancel this scheduled task with CronDelete.";
const at = (ms: number) => new Date(Date.UTC(2026, 10, 5, 3, 2, 0) + ms).toISOString();
const fire = (uuid: string, prompt: string, ms: number) => [
  { type: "queue-operation", operation: "enqueue", timestamp: at(ms + 2), sessionId: "s", content: prompt },
  { type: "queue-operation", operation: "dequeue", timestamp: at(ms + 9), sessionId: "s" },
  { type: "system", subtype: "scheduled_task_fire", content: "Running scheduled task (Nov 5 3:02am)", timestamp: at(ms), uuid, taskId: "7ccf1082", prompt },
];
const turn = (promptId: string, content: string, extra: Record<string, unknown>) =>
  ({ type: "user", promptId, message: { role: "user", content }, timestamp: at(0), ...extra });

function withTranscript(rows: Array<Record<string, unknown>>, check: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "t-claude-turn-origin-"));
  try {
    const path = join(dir, "e9c1317e-0000-4000-8000-000000000000.jsonl");
    writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf-8");
    check(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the hook payload's own source", () => {
  test("a wake-up, a task notice or a poll event is the host's; the composer is the person's; sdk and none decide nothing", () => {
    for (const source of ["loop_wakeup", "schedule_wakeup", "system", "poll_event"]) {
      expect(claudeHookSourceOrigin(source)).toEqual({ origin: { kind: "host", reason: source, source: "record" } });
    }
    expect(claudeHookSourceOrigin("user")).toEqual({ origin: { kind: "person", source: "record" } });
    // The desktop app sends its own notes and the person's messages alike as sdk.
    expect(claudeHookSourceOrigin("sdk")).toEqual({ origin: null });
    for (const source of [undefined, null, "", "later_kind", 3]) expect(claudeHookSourceOrigin(source)).toBeNull();
  });
});

describe("a scheduled wake-up's fire on the transcript", () => {
  test("a fire whose turn has not started, with this prompt queued, is the host's", () => {
    withTranscript([turn("p0", "hello", { turnOrigin: "human" }), ...fire("f1", TICK, 60_000)], (path) => {
      expect(claudeScheduledFireOrigin(path, "p1", TICK, 0)).toEqual({ kind: "host", reason: "scheduled", source: "record" });
      // Another text, or a prompt riding a turn already on record, is not the fire's.
      expect(claudeScheduledFireOrigin(path, "p1", "Approve", 0)).toBeNull();
      expect(claudeScheduledFireOrigin(path, "p0", TICK, 0)).toBeNull();
    });
  });

  test("a fire whose own turn row names it is spent; one queued behind another turn still counts", () => {
    withTranscript([
      ...fire("f1", TICK, 60_000),
      turn("t1", TICK, { turnOrigin: "scheduled", scheduledFireId: "f1" }),
    ], (path) => expect(claudeScheduledFireOrigin(path, "t2", TICK, 0)).toBeNull());
    withTranscript([
      ...fire("f2", TICK, 60_000),
      turn("a1", "Approve", { turnOrigin: "human", promptSource: "queued" }),
    ], (path) => expect(claudeScheduledFireOrigin(path, "t2", TICK, 0)?.kind).toBe("host"));
  });

  test("the fire's own queued prompt is the one stamped at or after it, not the person's queued beside it", () => {
    withTranscript([
      { type: "queue-operation", operation: "enqueue", timestamp: at(59_000), sessionId: "s", content: "Approve" },
      ...fire("f1", TICK, 60_000),
    ], (path) => {
      expect(claudeScheduledFireOrigin(path, "p1", "Approve", 0)).toBeNull();
      expect(claudeScheduledFireOrigin(path, "p1", TICK, 0)?.kind).toBe("host");
    });
  });

  test("it waits for the fire's rows only until the deadline, and not at all once they are there", () => {
    withTranscript([turn("p0", "hello", { turnOrigin: "human" })], (path) => {
      const until = performance.now() + 150;
      expect(claudeScheduledFireOrigin(path, "p1", "Approve", until)).toBeNull();
      expect(performance.now()).toBeGreaterThanOrEqual(until);
    });
    withTranscript(fire("f1", TICK, 60_000), (path) => {
      const start = performance.now();
      expect(claudeScheduledFireOrigin(path, "p1", TICK, start + 5_000)?.kind).toBe("host");
      expect(performance.now() - start).toBeLessThan(1_000);
    });
    expect(claudeScheduledFireOrigin(join(tmpdir(), "no-such-transcript.jsonl"), "p1", TICK, 0)).toBeNull();
    expect(claudeScheduledFireOrigin(undefined, "p1", TICK, 0)).toBeNull();
  });
});

describe("the wake-up's own transcript row", () => {
  test("`turnOrigin: scheduled` is the host's when the row is there", () => {
    withTranscript([turn("t1", TICK, { turnOrigin: "scheduled", scheduledFireId: "f1" })], (path) => {
      expect(claudeTranscriptOrigin(path, "t1", TICK)).toEqual({ kind: "host", reason: "scheduled", source: "record" });
    });
  });
});
