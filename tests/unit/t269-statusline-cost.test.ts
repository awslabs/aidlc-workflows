// covers: function:fmtTokens, function:costSegment
//
// t269 - statusline cost segment (aidlc-statusline.ts). The statusline renders
// the cost segment ONLY when the ledger exists and carries data (no env gate,
// but no ledger => no segment), and must NEVER error out of a cost read. Two
// pure units, imported in-process from the shipped dist hook (main() is guarded
// by import.meta.main, so importing the module does not block on Bun.stdin):
//   (1) fmtTokens - compact k/M formatting + boundaries.
//   (2) costSegment - renders `up<in> down<out> $<usd>` from the rolled-up
//       ledger (loadLedger, FAST - never re-parses the transcript), tokens-only
//       when the cost is unknown, and "" on a missing ledger / any failure.
//
// Fixtures write a real usage-ledger.json under <tmp>/aidlc/.aidlc-sessions/ via
// the shipped updateLedger, so the ledger path resolution is exercised for real.
//
// MECHANISM: none. Deterministic, in-process, fixture-based; zero tokens, zero
// network.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fmtTokens,
  costSegment,
} from "../../dist/claude/.claude/hooks/aidlc-statusline.ts";
import {
  updateLedger,
  computeCost,
  writeCurrentTranscriptPath,
  type TokenCounts,
  type UsageRow,
} from "../../dist/claude/.claude/tools/aidlc-usage.ts";
import { writeSessionIntentUuid } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const tempDirs: string[] = [];
function mkProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-statusline-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
});

// Build a UsageRow with computed usd (mirrors t267-usage's helper).
function row(
  uuid: string,
  model: string,
  o: { input?: number; output?: number; cacheRead?: number },
): UsageRow {
  const counts: TokenCounts = {
    input: o.input ?? 0,
    output: o.output ?? 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: o.cacheRead ?? 0,
  };
  return {
    uuid,
    msgId: "",
    timestamp: "2026-07-23T04:22:43.957Z",
    model,
    isSidechain: false,
    sourceKey: "main",
    agentId: null,
    agentType: "main",
    counts,
    usd: computeCost(counts, model).usd,
  };
}

describe("fmtTokens", () => {
  test("boundaries: sub-1k integer, k, M, trimming, guards", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(-5)).toBe("0");
    expect(fmtTokens(NaN)).toBe("0");
    expect(fmtTokens(1)).toBe("1");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1000)).toBe("1k"); // trailing .0 trimmed
    expect(fmtTokens(1234)).toBe("1.2k");
    expect(fmtTokens(12345)).toBe("12.3k");
    expect(fmtTokens(999999)).toBe("1000k"); // just under 1M
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(3_400_000)).toBe("3.4M");
  });
});

describe("costSegment", () => {
  test("known-model ledger is isolated to the session-stamped workflow", () => {
    const dir = mkProject();
    // 1e6 input opus => $5.00; 2500 output => 2500x25/1e6 = $0.0625.
    // Total 5.0625 => "5.06" (toFixed(2)).
    writeSessionIntentUuid(dir, "session-a", "workflow-a");
    updateLedger(
      dir,
      [row("m1", "converse/us.anthropic.claude-opus-4-8", { input: 1_000_000, output: 2500 })],
      null,
      {
        workflowKey: "intent:workflow-a",
        sessionKey: "transcript:/some/transcript.jsonl",
      },
    );
    updateLedger(
      dir,
      [row("m2", "converse/us.anthropic.claude-opus-4-8", { input: 2_000_000 })],
      null,
      {
        workflowKey: "intent:workflow-b",
        sessionKey: "transcript:/other/transcript.jsonl",
      },
    );
    const seg = costSegment(dir, "/some/transcript.jsonl", "session-a");
    expect(seg).toBe("↑1M ↓2.5k $5.06");
  });

  test("session_id selects the session when transcript_path is unavailable", () => {
    const dir = mkProject();
    const transcript = "/some/session-c.jsonl";
    writeSessionIntentUuid(dir, "session-c", "workflow-c");
    writeCurrentTranscriptPath(dir, "session-c", transcript);
    updateLedger(
      dir,
      [row("m3", "converse/us.anthropic.claude-opus-4-8", { input: 1_000_000 })],
      null,
      {
        workflowKey: "intent:workflow-c",
        sessionKey: `transcript:${transcript}`,
      },
    );

    expect(costSegment(dir, undefined, "session-c")).toBe("↑1M ↓0 $5.00");
  });

  test("tokens-only / unknown-model ledger => tokens, NEVER a fake $0", () => {
    const dir = mkProject();
    updateLedger(dir, [row("x1", "gpt-4o", { input: 1500, output: 300 })], null);
    const seg = costSegment(dir);
    expect(seg).toBe("↑1.5k ↓300");
    expect(seg).not.toContain("$");
  });

  test("missing ledger => '' (never errors)", () => {
    const dir = mkProject();
    expect(costSegment(dir, "/no/transcript.jsonl")).toBe("");
    expect(costSegment(dir)).toBe("");
  });

  test("empty project dir => '' (no throw)", () => {
    expect(costSegment("")).toBe("");
  });

  test("zero-token ledger => '' (no empty up-0 down-0 render)", () => {
    const dir = mkProject();
    // Fold a row with all-zero counts and an unknown model (usd 0).
    updateLedger(dir, [row("z1", "gpt-4o", {})], null);
    expect(costSegment(dir)).toBe("");
  });
});
