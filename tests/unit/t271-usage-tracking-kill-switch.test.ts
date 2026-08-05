// covers: function:usageTrackingDisabled
//
// t271-usage-tracking-kill-switch - AIDLC_DISABLE_USAGE_TRACKING=1 silences the
// whole usage seam: the producer writes no ledger and no transcript pointers,
// and every consumer (audit rollup fields, the statusline's session aggregate)
// returns empty - while an ALREADY-recorded ledger is left untouched on disk so
// re-enabling the flag restores history rather than restarting it.
//
// Mechanism: none. In-process imports from the shipped dist tree; deterministic
// fixtures in a temp project (same JSONL shape as t267-usage). Zero tokens.
// The flag is read at call time (never cached), so tests toggle it per-case and
// afterEach restores the untracked default.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  foldTranscriptIntoLedger,
  ledgerPath,
  readCurrentTranscriptPath,
  sessionUsageAggregate,
  stageUsageAuditFields,
  usageTrackingDisabled,
  workflowUsageAuditFields,
  writeCurrentTranscriptPath,
} from "../../dist/claude/.claude/tools/aidlc-usage.ts";

const tempDirs: string[] = [];
function mkProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-usage-kill-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  delete process.env.AIDLC_DISABLE_USAGE_TRACKING;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// One assistant turn, 100 output tokens on a priceable model (same minimal
// JSONL shape t267-usage fixtures use).
function transcriptFixture(dir: string): string {
  const transcript = join(dir, "session.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({
      uuid: "m1",
      timestamp: "t",
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        model: "converse/us.anthropic.claude-opus-4-8",
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
    })}\n`,
  );
  return transcript;
}

describe("t271 - AIDLC_DISABLE_USAGE_TRACKING kill switch", () => {
  test("flag parse: exactly '1' disables; unset/other values do not", () => {
    delete process.env.AIDLC_DISABLE_USAGE_TRACKING;
    expect(usageTrackingDisabled()).toBe(false);
    process.env.AIDLC_DISABLE_USAGE_TRACKING = "1";
    expect(usageTrackingDisabled()).toBe(true);
    // The AIDLC_DISABLE_* convention is the exact string "1" - "true"/"0"/""
    // do not disable (mirrors the reviewer-scope and review-freeze flags).
    for (const v of ["true", "0", "", "yes"]) {
      process.env.AIDLC_DISABLE_USAGE_TRACKING = v;
      expect(usageTrackingDisabled()).toBe(false);
    }
  });

  test("producer: disabled fold writes no ledger file and returns empty totals", () => {
    process.env.AIDLC_DISABLE_USAGE_TRACKING = "1";
    const dir = mkProject();
    const led = foldTranscriptIntoLedger(dir, transcriptFixture(dir), "stage-a", true);
    expect(led.totals.tokens.output).toBe(0);
    expect(existsSync(ledgerPath(dir))).toBe(false);
  });

  test("producer: disabled writeCurrentTranscriptPath persists nothing", () => {
    process.env.AIDLC_DISABLE_USAGE_TRACKING = "1";
    const dir = mkProject();
    writeCurrentTranscriptPath(dir, "sess-1", "/path/to/session.jsonl");
    delete process.env.AIDLC_DISABLE_USAGE_TRACKING;
    expect(readCurrentTranscriptPath(dir, "sess-1")).toBeNull();
    expect(readCurrentTranscriptPath(dir)).toBeNull();
  });

  test("consumers: disabled reads return empty even over a recorded ledger; the ledger file survives", () => {
    const dir = mkProject();
    // Record real usage with tracking ON.
    foldTranscriptIntoLedger(dir, transcriptFixture(dir), "stage-a", true);
    expect(existsSync(ledgerPath(dir))).toBe(true);
    const before = readFileSync(ledgerPath(dir), "utf-8");
    expect(stageUsageAuditFields(dir, "stage-a")["Tokens Out"]).toBe("100");
    expect(sessionUsageAggregate(dir, join(dir, "session.jsonl"))).not.toBeNull();

    // Flip the switch: every consumer goes quiet, nothing is deleted.
    process.env.AIDLC_DISABLE_USAGE_TRACKING = "1";
    expect(stageUsageAuditFields(dir, "stage-a")).toEqual({});
    expect(workflowUsageAuditFields(dir)).toEqual({});
    expect(sessionUsageAggregate(dir, join(dir, "session.jsonl"))).toBeNull();
    expect(readFileSync(ledgerPath(dir), "utf-8")).toBe(before);

    // Re-enable: history is intact, not restarted.
    delete process.env.AIDLC_DISABLE_USAGE_TRACKING;
    expect(stageUsageAuditFields(dir, "stage-a")["Tokens Out"]).toBe("100");
  });
});
