// covers: audit:RECOVERY_COMPLETED
//
// Mechanism = cli. Every assertion about `bun aidlc-state.ts
// acknowledge-compaction|resume ...` (exit code, stdout, audit rows) is
// preserved by SPAWNING the real CLI via node:child_process spawnSync (BUN +
// the tool .ts path + --project-dir <p>), asserting on res.status / res.stdout
// + res.stderr, plus on the audit shards the tool writes - the
// PROCESS boundary, not in-process handler calls. An in-process twin
// would lose the exit-code half (Tests 5-8 rely on the tool's
// error() -> emitError -> process.exit(1) shell, aidlc-lib.ts) AND the
// resume-JSON-to-stdout half (Test 9).
//
// AUDIT EVENT UNIT: this test file credits the RECOVERY_COMPLETED audit event
// (covers KEY audit:RECOVERY_COMPLETED). The tool emits it via emitAudit(pd,
// "RECOVERY_COMPLETED", {Choice, "Current Stage"}) at aidlc-state.ts; the
// audit block renders `## Recovery Completed` / `**Event**: RECOVERY_COMPLETED`
// / `**Choice**: <c>` / `**Current Stage**: <s>` per EVENT_HEADINGS
// (aidlc-audit.ts) + appendAuditEntryUnlocked (aidlc-audit.ts).
//
// CONTRACT (aidlc-state.ts handleAcknowledgeCompaction + handleResume):
//   - acknowledge-compaction --choice <continue|review|restart> emits
//     RECOVERY_COMPLETED ONLY when a SESSION_COMPACTED is pending (i.e. no
//     STAGE_STARTED/STAGE_COMPLETED/GATE_APPROVED/SESSION_RESUMED/
//     RECOVERY_COMPLETED follows it in the audit tail).
//   - invalid / missing --choice -> error() -> exit 1.
//   - no pending compaction (or stage activity already followed) -> error() ->
//     exit 1, NO audit row written.
//   - RECOVERY_COMPLETED is in handleResume's detection-exclusion regex, so a
//     subsequent `resume` reports compaction_pending=false.
//
// FIXTURE DISCIPLINE: each case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so audit shards
// - written by the tool via forward-slash helpers - round-trip when read
// back), seeds audit-sample.md (which contains NONE of the events asserted
// here, so post-fire counts are unambiguous) and state-mid-ideation.md
// (Current Stage = feasibility); proj({ compacted: true }) also injects a
// SESSION_COMPACTED block. All temp dirs cleaned in afterAll. NOTHING is
// written under tests/fixtures/**.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seededAuditDir,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const STATE = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-state.ts",
);
const STATE_MID_IDEATION = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "state-mid-ideation.md",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// seedStateFile seeds the default intent's record so the active-intent
// cursor resolves; the baseline trail is planted in a shard named
// `0-seed.md` under the record's audit/ DIR. The name is LOW-SORTING
// (digit '0' precedes any hostname slug) so readAllAuditShards - which
// concatenates shards in FILENAME order - keeps the seeded SESSION_COMPACTED
// BEFORE the tool's RECOVERY_COMPLETED shard; handleResume's compaction detection
// is positional (lastIndexOf SESSION_COMPACTED, then scans the suffix for
// RECOVERY_COMPLETED), so ordering must hold. The SPAWNED tool mints its own
// clone-id and writes to `<host>-<clone>.md`, which sorts AFTER `0-seed.md`.
const seedShardPath = (p: string): string => join(seededAuditDir(p), "0-seed.md");
function seedBaselineShard(p: string): void {
  const auditDir = seededAuditDir(p);
  mkdirSync(auditDir, { recursive: true });
  copyFileSync(join(FIXTURES_DIR, "audit-sample.md"), seedShardPath(p));
}

interface CliResult {
  status: number;
  out: string;
  stdout: string;
}

function state(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [STATE, ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

function proj(opts: { compacted?: boolean } = {}): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedBaselineShard(p);
  seedStateFile(p, STATE_MID_IDEATION);
  if (opts.compacted) injectSessionCompacted(p);
  return p;
}

function injectSessionCompacted(p: string): void {
  appendFileSync(
    seedShardPath(p),
    "\n## Session Compacted\n" +
      "**Timestamp**: 2026-05-03T00:00:00Z\n" +
      "**Event**: SESSION_COMPACTED\n" +
      "**Source**: compact\n" +
      "\n---\n",
    "utf-8",
  );
}

/**
 * Append a STAGE_STARTED block AFTER a SESSION_COMPACTED. Simulates the user
 * working past a compaction without acknowledging it.
 */
function injectStageStarted(p: string): void {
  appendFileSync(
    seedShardPath(p),
    "\n## Stage Start\n" +
      "**Timestamp**: 2026-05-03T00:05:00Z\n" +
      "**Event**: STAGE_STARTED\n" +
      "**Stage**: intent-capture\n" +
      "\n---\n",
    "utf-8",
  );
}

function auditEventCount(body: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return body
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Value of <key> from the FIRST audit block containing it whose `**Event**:`
 * matches <ev>. Resets at `## ` headings and `---` separators; splits
 * `**label**: value` on the literal `**: ` separator. Mirrors auditField in
 * t31.test.ts. Returns "" when absent (block-scoped).
 */
function auditField(body: string, ev: string, key: string): string {
  let matched = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      matched = false;
      continue;
    }
    if (line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

const RC = "RECOVERY_COMPLETED";

describe("t35 acknowledge-compaction -> RECOVERY_COMPLETED (migrated from t35-tool-recovery-completed.sh, plan 11)", () => {
  test("1: acknowledge with pending compaction emits RECOVERY_COMPLETED", () => {
    const p = proj({ compacted: true });
    const r = state(["acknowledge-compaction", "--choice", "continue"], p);
    expect(r.status).toBe(0);
    expect(auditEventCount(readAllAuditShards(p), RC)).toBe(1);
    expect(r.stdout).toContain('"acknowledged":true');
  });

  test("2: RECOVERY_COMPLETED records Choice", () => {
    const p = proj({ compacted: true });
    state(["acknowledge-compaction", "--choice", "review"], p);
    expect(auditField(readAllAuditShards(p), RC, "Choice")).toBe("review");
  });

  test("3: RECOVERY_COMPLETED records Current Stage", () => {
    const p = proj({ compacted: true });
    state(["acknowledge-compaction", "--choice", "continue"], p);
    // Pin the exact value from the seeded state-mid-ideation.md (Current Stage =
    // feasibility).
    expect(auditField(readAllAuditShards(p), RC, "Current Stage")).toBe("feasibility");
  });

  for (const choice of ["continue", "review", "restart"] as const) {
    test(`4 (${choice}): choice=${choice} accepted -> Choice=${choice}`, () => {
      const p = proj({ compacted: true });
      const r = state(["acknowledge-compaction", "--choice", choice], p);
      expect(r.status).toBe(0);
      expect(auditField(readAllAuditShards(p), RC, "Choice")).toBe(choice);
    });
  }

  test("5: invalid --choice exits 1, no RECOVERY_COMPLETED emitted", () => {
    const p = proj({ compacted: true });
    const r = state(["acknowledge-compaction", "--choice", "bogus"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Invalid --choice");
    expect(auditEventCount(readAllAuditShards(p), RC)).toBe(0);
  });

  test("6: missing --choice exits 1, no RECOVERY_COMPLETED emitted", () => {
    const p = proj({ compacted: true });
    const r = state(["acknowledge-compaction"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Usage:");
    expect(auditEventCount(readAllAuditShards(p), RC)).toBe(0);
  });

  test("7: refuses when no pending compaction (exit 1, no emit)", () => {
    // No injectSessionCompacted — audit-sample.md alone has no SESSION_COMPACTED.
    const p = proj();
    const r = state(["acknowledge-compaction", "--choice", "continue"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("No pending compaction");
    expect(auditEventCount(readAllAuditShards(p), RC)).toBe(0);
  });

  test("8: refuses when stage activity already followed the compaction (exit 1, no emit)", () => {
    const p = proj({ compacted: true });
    injectStageStarted(p); // STAGE_STARTED after SESSION_COMPACTED closes the window
    const r = state(["acknowledge-compaction", "--choice", "continue"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("No pending compaction");
    expect(auditEventCount(readAllAuditShards(p), RC)).toBe(0);
  });

  test("9: resume reports compaction_pending:false after acknowledge", () => {
    const p = proj({ compacted: true });
    const ack = state(["acknowledge-compaction", "--choice", "continue"], p);
    expect(ack.status).toBe(0);
    // RECOVERY_COMPLETED is in handleResume's detection-exclusion regex
    // (aidlc-state.ts), so the pending window closes.
    const r = state(["resume"], p);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { compaction_pending: boolean };
    expect(parsed.compaction_pending).toBe(false);
  });
});
