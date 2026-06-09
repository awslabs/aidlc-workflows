// covers: audit:RECOVERY_COMPLETED
//
// CLI-contract port of tests/unit/t35-tool-recovery-completed.sh (TAP plan 11),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-state.ts acknowledge-compaction|resume ...` is
// preserved by SPAWNING the real CLI via node:child_process spawnSync (BUN +
// the tool .ts path + --project-dir <p>), asserting on res.status / res.stdout
// + res.stderr exactly as the .sh asserted on $? / grep, plus on the audit.md
// the tool writes — the PROCESS boundary, not in-process handler calls. An
// in-process twin would lose the exit-code half (Tests 5-8 rely on the tool's
// error() -> emitError -> process.exit(1) shell, aidlc-lib.ts:1546) AND the
// resume-JSON-to-stdout half (Test 9).
//
// AUDIT EVENT UNIT: this .cli file credits the RECOVERY_COMPLETED audit event
// (covers KEY audit:RECOVERY_COMPLETED). The tool emits it via emitAudit(pd,
// "RECOVERY_COMPLETED", {Choice, "Current Stage"}) at aidlc-state.ts:990; the
// audit block renders `## Recovery Completed` / `**Event**: RECOVERY_COMPLETED`
// / `**Choice**: <c>` / `**Current Stage**: <s>` per EVENT_HEADINGS
// (aidlc-audit.ts:150) + appendAuditEntryUnlocked (aidlc-audit.ts:256-267).
//
// CONTRACT (aidlc-state.ts handleAcknowledgeCompaction:942-998 +
// handleResume:872-932):
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
// PARITY NOTES (every .sh `ok` line maps to an expect() below; STRONGER adds
// noted):
//   - .sh Test 1  assert_grep '^**Event**: RECOVERY_COMPLETED'  -> Test 1:
//       recoveryCompletedCount === 1 (STRONGER: exact count against a seeded
//       baseline that contains NO RECOVERY_COMPLETED, not a bare presence
//       grep) + res.status === 0 (STRONGER: .sh discarded $? with `|| true`).
//   - .sh Test 2  assert_grep '**Choice**: review'              -> Test 2:
//       auditField(RECOVERY_COMPLETED,"Choice") === "review" (STRONGER: exact
//       value scoped to the RECOVERY_COMPLETED block, not a file-wide grep).
//   - .sh Test 3  assert_grep '**Current Stage**:'              -> Test 3:
//       auditField "Current Stage" === "feasibility" (STRONGER: the .sh only
//       grepped the label's presence; we pin the exact value from the seeded
//       state-mid-ideation.md Current Stage, plus presence via !== "").
//   - .sh Test 4  for choice in continue review restart: '**Choice**: $choice'
//       (3 asserts) -> Tests 4a/4b/4c: one test() per choice, each pins
//       auditField "Choice" === <choice> (STRONGER, exact, block-scoped).
//   - .sh Test 5  invalid --choice  $? == 1                     -> Test 5:
//       res.status === 1 + "Invalid --choice" error asserted (STRONGER) + NO
//       RECOVERY_COMPLETED row (STRONGER, validate-then-emit).
//   - .sh Test 6  missing --choice  $? == 1                     -> Test 6:
//       res.status === 1 + "Usage:" error asserted (STRONGER) + NO row.
//   - .sh Test 7  no SESSION_COMPACTED  $? == 1                 -> Test 7:
//       res.status === 1 + "No pending compaction" error (STRONGER) + NO row.
//   - .sh Test 8  stage activity followed compaction  $? == 1   -> Test 8:
//       res.status === 1 + "No pending compaction" error (STRONGER) + NO row.
//   - .sh Test 9  resume grep '"compaction_pending":false' $?==0 -> Test 9:
//       parsed resume JSON .compaction_pending === false (STRONGER: parse the
//       real JSON object the tool prints, not a substring grep) + resume
//       res.status === 0 (STRONGER).
//
// 11 .sh asserts -> 11 expect()-bearing test() cases here (Test 4's 3 inner
// `ok` lines become 4a/4b/4c, keeping one observable per case).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file
// + seed_state_file + inject_session_compacted + cleanup_test_project per
// case): each case uses a FRESH temp project dir (createTestProject, which
// toPortablePath-converts on Windows so audit.md — written by the tool via
// forward-slash helpers — round-trips when read back). Audit-emitting cases
// seed audit-sample.md (which contains NONE of the events asserted here, so
// post-fire counts are unambiguous), seed state-mid-ideation.md (Current
// Stage = feasibility), and inject a SESSION_COMPACTED block byte-for-byte
// matching the .sh's inject_session_compacted heredoc. All temp dirs cleaned
// in afterAll. NOTHING is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
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

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-state.ts <args...> --project-dir <p>`. Mirrors `bun "$STATE" ...`. */
function state(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [STATE, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/**
 * Fresh project seeded exactly as the .sh's per-case prelude:
 *   create_test_project + seed_audit_file + seed_state_file state-mid-ideation
 *   (+ optional inject_session_compacted).
 */
function proj(opts: { compacted?: boolean } = {}): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAuditFile(p);
  seedStateFile(p, STATE_MID_IDEATION);
  if (opts.compacted) injectSessionCompacted(p);
  return p;
}

/**
 * Append a SESSION_COMPACTED block to a project's audit.md — byte-for-byte the
 * heredoc the .sh's inject_session_compacted writes (t35:34-45).
 */
function injectSessionCompacted(p: string): void {
  appendFileSync(
    auditPath(p),
    "\n## Session Compacted\n" +
      "**Timestamp**: 2026-05-03T00:00:00Z\n" +
      "**Event**: SESSION_COMPACTED\n" +
      "**Source**: compact\n" +
      "\n---\n",
    "utf-8",
  );
}

/**
 * Append a STAGE_STARTED block AFTER a SESSION_COMPACTED — byte-for-byte the
 * .sh's Test 8 heredoc (t35:136-144). Simulates the user working past a
 * compaction without acknowledging it.
 */
function injectStageStarted(p: string): void {
  appendFileSync(
    auditPath(p),
    "\n## Stage Start\n" +
      "**Timestamp**: 2026-05-03T00:05:00Z\n" +
      "**Event**: STAGE_STARTED\n" +
      "**Stage**: intent-capture\n" +
      "\n---\n",
    "utf-8",
  );
}

/** Count audit blocks with `**Event**: <ev>`. Mirrors the .sh's `^**Event**: <ev>` grep, as an exact count. */
function auditEventCount(file: string, ev: string): number {
  if (!existsSync(file)) return 0;
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Resets at `## ` headings and `---` separators; splits `**label**: value` on
 * the literal `**: ` separator. Mirrors auditField in t31.cli.test.ts. Returns
 * "" when absent (block-scoped).
 */
function auditField(file: string, ev: string, key: string): string {
  if (!existsSync(file)) return "";
  let matched = false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
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
  // --- Test 1: pending compaction -> acknowledge emits RECOVERY_COMPLETED ---
  test("1: acknowledge with pending compaction emits RECOVERY_COMPLETED", () => {
    const p = proj({ compacted: true });
    const r = state(["acknowledge-compaction", "--choice", "continue"], p);
    expect(r.status).toBe(0); // STRONGER: .sh swallowed $? with `|| true`
    expect(auditEventCount(auditPath(p), RC)).toBe(1); // STRONGER: exact count vs presence grep
    // STRONGER: JSON ack on stdout records the acknowledgement.
    expect(r.stdout).toContain('"acknowledged":true');
  });

  // --- Test 2: records Choice field ---
  test("2: RECOVERY_COMPLETED records Choice", () => {
    const p = proj({ compacted: true });
    state(["acknowledge-compaction", "--choice", "review"], p);
    expect(auditField(auditPath(p), RC, "Choice")).toBe("review");
  });

  // --- Test 3: records Current Stage field ---
  test("3: RECOVERY_COMPLETED records Current Stage", () => {
    const p = proj({ compacted: true });
    state(["acknowledge-compaction", "--choice", "continue"], p);
    // STRONGER than the .sh (which only grepped the label): pin the exact
    // value from the seeded state-mid-ideation.md Current Stage = feasibility.
    expect(auditField(auditPath(p), RC, "Current Stage")).toBe("feasibility");
  });

  // --- Test 4: all three valid choices accepted (split per-choice) ---
  for (const choice of ["continue", "review", "restart"] as const) {
    test(`4 (${choice}): choice=${choice} accepted -> Choice=${choice}`, () => {
      const p = proj({ compacted: true });
      const r = state(["acknowledge-compaction", "--choice", choice], p);
      expect(r.status).toBe(0);
      expect(auditField(auditPath(p), RC, "Choice")).toBe(choice);
    });
  }

  // --- Test 5: invalid --choice rejected (exit 1, no emit) ---
  test("5: invalid --choice exits 1, no RECOVERY_COMPLETED emitted", () => {
    const p = proj({ compacted: true });
    const r = state(["acknowledge-compaction", "--choice", "bogus"], p);
    expect(r.status).toBe(1);
    // STRONGER: assert the diagnostic AND that nothing was emitted.
    expect(r.out).toContain("Invalid --choice");
    expect(auditEventCount(auditPath(p), RC)).toBe(0);
  });

  // --- Test 6: missing --choice rejected (exit 1, no emit) ---
  test("6: missing --choice exits 1, no RECOVERY_COMPLETED emitted", () => {
    const p = proj({ compacted: true });
    const r = state(["acknowledge-compaction"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Usage:");
    expect(auditEventCount(auditPath(p), RC)).toBe(0);
  });

  // --- Test 7: no SESSION_COMPACTED -> refuses (exit 1, no emit) ---
  test("7: refuses when no pending compaction (exit 1, no emit)", () => {
    // No injectSessionCompacted — audit-sample.md alone has no SESSION_COMPACTED.
    const p = proj();
    const r = state(["acknowledge-compaction", "--choice", "continue"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("No pending compaction");
    expect(auditEventCount(auditPath(p), RC)).toBe(0);
  });

  // --- Test 8: stage activity already followed compaction -> refuses ---
  test("8: refuses when stage activity already followed the compaction (exit 1, no emit)", () => {
    const p = proj({ compacted: true });
    injectStageStarted(p); // STAGE_STARTED after SESSION_COMPACTED closes the window
    const r = state(["acknowledge-compaction", "--choice", "continue"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("No pending compaction");
    expect(auditEventCount(auditPath(p), RC)).toBe(0);
  });

  // --- Test 9: after acknowledge, resume reports compaction_pending=false ---
  test("9: resume reports compaction_pending:false after acknowledge", () => {
    const p = proj({ compacted: true });
    const ack = state(["acknowledge-compaction", "--choice", "continue"], p);
    expect(ack.status).toBe(0);
    // RECOVERY_COMPLETED is in handleResume's detection-exclusion regex
    // (aidlc-state.ts:908), so the pending window closes.
    const r = state(["resume"], p);
    expect(r.status).toBe(0); // STRONGER: .sh swallowed $? with `|| true`
    // STRONGER: parse the real JSON object the tool prints, not a substring grep.
    const parsed = JSON.parse(r.stdout) as { compaction_pending: boolean };
    expect(parsed.compaction_pending).toBe(false);
  });
});
