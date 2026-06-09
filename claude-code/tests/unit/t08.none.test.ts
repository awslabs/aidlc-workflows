// covers: hook:aidlc-validate-state
//
// Port of tests/unit/t08-hook-validate-state.sh (TAP plan 14), mechanism = none.
// The unit under test is a HOOK — aidlc-validate-state.ts, the PreCompact hook
// that validates aidlc-state.md structure, writes a recovery breadcrumb, and
// emits SESSION_COMPACTED when an audit.md already exists. Hooks are
// mechanism=none: they resolve the project dir from the CLAUDE_PROJECT_DIR env
// var (aidlc-lib.ts:114-116) and have no exported pure function to import. So
// every .sh assertion is preserved by SPAWNING the hook via
// node:child_process spawnSync with CLAUDE_PROJECT_DIR set, exactly as the .sh
// ran `CLAUDE_PROJECT_DIR=<p> bun "$HOOK"`. We assert on res.stderr (the .sh's
// `2>&1` WARNING grep — the hook prints warnings via console.error,
// aidlc-validate-state.ts:40), on the recovery breadcrumb / heartbeat the hook
// writes, and on the SESSION_COMPACTED row it appends to audit.md.
//
// NO STDIN: unlike the SubagentStop/PostToolUse hooks (t09/t29), this PreCompact
// hook reads NOTHING from stdin — it only consumes the state file under
// CLAUDE_PROJECT_DIR. The .sh never piped a payload (`bun "$HOOK"` with no
// `echo ... |`), so neither do we.
//
// HOOK CONTRACT (aidlc-validate-state.ts):
//   - Always writes the heartbeat aidlc-docs/.aidlc-hooks-health/validate-state.last
//     (an ISO timestamp), even before the no-state-file early exit (lines 26-28).
//   - No state file -> process.exit(0) BEFORE any WARNING / breadcrumb / audit
//     work (line 30). So: no WARNING on stderr, no .aidlc-recovery.md.
//   - State file present -> validates `## Stage Progress` + `## Current Status`
//     (lines 36-37); missing sections print `WARNING: aidlc-state.md missing
//     sections: <names>` on stderr (line 40) and drive the breadcrumb's
//     `State file: INVALID — missing sections: ...` line (lines 43-45, 53).
//   - Always (when state exists) writes aidlc-docs/.aidlc-recovery.md carrying
//     `**Current stage**: <getField "Current Stage">` and
//     `**State file**: valid (all required sections present)` | `INVALID — ...`
//     (lines 47-55).
//   - SESSION_COMPACTED emitted via appendAuditEntry ONLY when audit.md already
//     exists (lines 58-59); the hook never auto-creates audit.md. The audit row
//     renders under `## Session Compacted` with `**Event**: SESSION_COMPACTED`
//     (aidlc-audit.ts:130, EVENT_HEADINGS) plus Current Stage + State Validity
//     fields (hook lines 61-67).
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several STRONGER):
//   - .sh Test 1  no state -> no WARNING on stderr                    -> Test 1:
//       res.stderr has no /WARNING/i (same observable; the .sh's
//       `echo "$OUTPUT" | grep -qi WARNING` was negated).
//   - .sh Test 2  no state -> heartbeat written anyway                -> Test 2:
//       heartbeat exists (same observable) + STRONGER: its contents are an ISO
//       timestamp (hook line 28 writes isoTimestamp()).
//   - .sh Test 3  no state -> no .aidlc-recovery.md breadcrumb        -> Test 3:
//       breadcrumb absent (same observable).
//   - .sh Test 4  valid mid-ideation fixture -> no WARNING            -> Test 4:
//       res.stderr has no /WARNING/i (same observable).
//   - .sh Test 5  state missing `## Stage Progress` -> WARNING names it -> Test 5:
//       res.stderr contains "Stage Progress" (same observable) + STRONGER: the
//       full canonical `WARNING: aidlc-state.md missing sections: Stage Progress`
//       diagnostic, scoped to stderr.
//   - .sh Test 6  state missing `## Current Status` -> WARNING names it -> Test 6:
//       res.stderr contains "Current Status" (same observable) + STRONGER: the
//       full canonical diagnostic line.
//   - .sh Test 7  valid fixture -> writes .aidlc-recovery.md          -> Test 7:
//       breadcrumb exists (same observable).
//   - .sh Test 8  breadcrumb contains stage + "valid" status (2 grep) -> Test 8a/8b:
//       breadcrumb contains "feasibility" AND "valid" (same observables) +
//       STRONGER: pins the exact `**Current stage**: feasibility` and
//       `**State file**: valid (all required sections present)` lines.
//   - .sh Test 9/10 breadcrumb shows INVALID when sections missing     -> Test 9:
//       breadcrumb contains "INVALID" (same observable) + STRONGER: the exact
//       `**State file**: INVALID — missing sections: Stage Progress` line.
//   - .sh Test 11 corrupted fixture (missing Stage Progress) -> WARNING -> Test 11:
//       res.stderr contains "Stage Progress" (same observable) + STRONGER: the
//       full canonical diagnostic naming the corrupted fixture's missing section.
//   - .sh Test 12 completed fixture -> no WARNING                      -> Test 12:
//       res.stderr has no /WARNING/i (same observable).
//   - .sh Test 13 audit.md present -> SESSION_COMPACTED emitted         -> Test 13:
//       SESSION_COMPACTED block count goes seed(0) -> 1 (STRONGER: counts the
//       appended row against the seeded baseline — audit-sample.md carries NO
//       SESSION_COMPACTED block — not a bare presence grep) + the new block's
//       exact Current Stage / State Validity field values, block-scoped.
//   - .sh Test 14 no audit.md -> hook does NOT auto-create audit.md     -> Test 14:
//       audit.md absent (same observable) + STRONGER: the hook still exits 0
//       (the breadcrumb path is independent of the audit emit) and the recovery
//       breadcrumb is still written (the primary signal per the hook's comment).
//
// 14 .sh asserts -> 15 expect()-bearing test() cases here (test 8's two greps
// kept as 8a + 8b to keep one observable per case, matching the .sh's two
// assert_grep lines under one plan slot).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file +
// seed_audit_file + cleanup_test_project per case): each case uses a FRESH temp
// project dir (createTestProject -> toPortablePath on Windows so the audit.md
// the hook writes via toPosix(auditFilePath) round-trips when read back).
// seedStateFile / seedAuditFile copy the same fixtures the .sh seeded
// (state-mid-ideation.md, state-corrupted.md, state-completed.md,
// audit-sample.md). All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOK = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "hooks",
  "aidlc-validate-state.ts",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh temp project (aidlc-docs/ scaffolded). Mirrors create_test_project. */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

const statePath = (p: string): string => join(p, "aidlc-docs", "aidlc-state.md");
const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");
const recoveryPath = (p: string): string =>
  join(p, "aidlc-docs", ".aidlc-recovery.md");
const heartbeatPath = (p: string): string =>
  join(p, "aidlc-docs", ".aidlc-hooks-health", "validate-state.last");

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the hook with CLAUDE_PROJECT_DIR=p (no stdin — the PreCompact hook reads
 * none). Mirrors the .sh's `CLAUDE_PROJECT_DIR=<p> bun "$HOOK"`. The hook
 * resolves the project dir from CLAUDE_PROJECT_DIR first (aidlc-lib.ts:116), so
 * the absolute hook path never shadows it.
 */
function runHook(p: string): HookResult {
  const res = spawnSync(BUN, [HOOK], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** Write a bare state file with only the given heading lines (mirrors the .sh heredocs). */
function writeState(p: string, content: string): void {
  mkdirSync(join(p, "aidlc-docs"), { recursive: true });
  writeFileSync(statePath(p), content, "utf-8");
}

/** Count `**Event**: SESSION_COMPACTED` block headings. Mirrors the .sh grep, as a count. */
function sessionCompactedCount(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l === "**Event**: SESSION_COMPACTED").length;
}

/**
 * Field values from the LAST audit block whose `**Event**:` is SESSION_COMPACTED.
 * The seed (audit-sample.md) carries none, so the hook-appended block is the
 * only — and last — one. Splits `**label**: value` on the literal `**: `
 * separator (mirrors auditField in t31.cli.test.ts / lastSubagentBlock in
 * t09.none.test.ts). Returns the field map; missing keys are absent.
 */
function lastCompactedBlock(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  let current: Record<string, string> | null = null;
  let last: Record<string, string> = {};
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (line.startsWith("## ")) {
      current = null;
      continue;
    }
    if (line === "---") {
      current = null;
      continue;
    }
    if (line === "**Event**: SESSION_COMPACTED") {
      current = { Event: "SESSION_COMPACTED" };
      last = current;
      continue;
    }
    if (current && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        current[stripped.slice(0, pos)] = stripped.slice(pos + 4);
      }
    }
  }
  return last;
}

describe("t08 aidlc-validate-state hook (migrated from t08-hook-validate-state.sh, plan 14)", () => {
  // --- Test 1: silent (no WARNING) when no state file ---
  test("1: no state file -> no WARNING on stderr", () => {
    const p = proj();
    rmSync(statePath(p), { force: true });
    const r = runHook(p);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/WARNING/i);
  });

  // --- Test 2: heartbeat written even without state file ---
  test("2: heartbeat written even without state file (ISO timestamp)", () => {
    const p = proj();
    rmSync(statePath(p), { force: true });
    runHook(p);
    expect(existsSync(heartbeatPath(p))).toBe(true);
    // STRONGER: the heartbeat carries an ISO timestamp (hook line 28).
    const ts = readFileSync(heartbeatPath(p), "utf-8").trim();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // --- Test 3: no recovery breadcrumb when no state file ---
  test("3: no recovery breadcrumb when no state file", () => {
    const p = proj();
    rmSync(statePath(p), { force: true });
    runHook(p);
    expect(existsSync(recoveryPath(p))).toBe(false);
  });

  // --- Test 4: valid mid-ideation fixture -> no WARNING ---
  test("4: valid mid-ideation fixture -> no WARNING", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    const r = runHook(p);
    expect(r.stderr).not.toMatch(/WARNING/i);
  });

  // --- Test 5: state missing `## Stage Progress` -> WARNING names it ---
  test("5: missing Stage Progress -> WARNING names the section", () => {
    const p = proj();
    writeState(
      p,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n",
    );
    const r = runHook(p);
    expect(r.stderr).toContain("Stage Progress");
    // STRONGER: the full canonical diagnostic line on stderr (hook line 40).
    expect(r.stderr).toContain(
      "WARNING: aidlc-state.md missing sections: Stage Progress",
    );
  });

  // --- Test 6: state missing `## Current Status` -> WARNING names it ---
  test("6: missing Current Status -> WARNING names the section", () => {
    const p = proj();
    writeState(
      p,
      "# AI-DLC State Tracking\n## Stage Progress\n### IDEATION PHASE\n- [-] feasibility — EXECUTE\n",
    );
    const r = runHook(p);
    expect(r.stderr).toContain("Current Status");
    // STRONGER: the full canonical diagnostic line on stderr.
    expect(r.stderr).toContain(
      "WARNING: aidlc-state.md missing sections: Current Status",
    );
  });

  // --- Test 7: valid fixture -> writes .aidlc-recovery.md ---
  test("7: valid fixture -> writes recovery breadcrumb", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    runHook(p);
    expect(existsSync(recoveryPath(p))).toBe(true);
  });

  // --- Test 8a: breadcrumb contains the current stage ---
  test("8a: breadcrumb contains the current stage (feasibility)", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    runHook(p);
    const breadcrumb = readFileSync(recoveryPath(p), "utf-8");
    expect(breadcrumb).toContain("feasibility");
    // STRONGER: pins the exact breadcrumb line (hook line 53).
    expect(breadcrumb).toContain("**Current stage**: feasibility");
  });

  // --- Test 8b: breadcrumb contains the valid status ---
  test("8b: breadcrumb reports valid state-file status", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    runHook(p);
    const breadcrumb = readFileSync(recoveryPath(p), "utf-8");
    expect(breadcrumb).toContain("valid");
    // STRONGER: pins the exact valid-status line (hook lines 44-45, 53).
    expect(breadcrumb).toContain(
      "**State file**: valid (all required sections present)",
    );
  });

  // --- Test 9/10: breadcrumb shows INVALID when sections missing ---
  test("9: breadcrumb shows INVALID when sections missing", () => {
    const p = proj();
    writeState(
      p,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n",
    );
    runHook(p);
    const breadcrumb = readFileSync(recoveryPath(p), "utf-8");
    expect(breadcrumb).toContain("INVALID");
    // STRONGER: pins the exact INVALID line naming the missing section (hook lines 43-44, 53).
    expect(breadcrumb).toContain(
      "**State file**: INVALID — missing sections: Stage Progress",
    );
  });

  // --- Test 11: corrupted fixture (missing Stage Progress) -> WARNING ---
  test("11: corrupted fixture -> WARNING names missing Stage Progress", () => {
    const p = proj();
    seedStateFile(p, "state-corrupted.md");
    const r = runHook(p);
    expect(r.stderr).toContain("Stage Progress");
    // STRONGER: the corrupted fixture (state-corrupted.md) carries `## Current
    // Status` but no `## Stage Progress`, so the canonical diagnostic names only
    // Stage Progress.
    expect(r.stderr).toContain(
      "WARNING: aidlc-state.md missing sections: Stage Progress",
    );
  });

  // --- Test 12: completed fixture -> no WARNING ---
  test("12: completed fixture -> no WARNING", () => {
    const p = proj();
    seedStateFile(p, "state-completed.md");
    const r = runHook(p);
    expect(r.stderr).not.toMatch(/WARNING/i);
  });

  // --- Test 13: audit.md present -> SESSION_COMPACTED emitted ---
  test("13: audit.md present -> emits SESSION_COMPACTED", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    seedAuditFile(p);
    const before = sessionCompactedCount(auditPath(p)); // seed baseline = 0
    runHook(p);
    // STRONGER: counts the appended row against the seeded baseline (the
    // audit-sample.md seed carries NO SESSION_COMPACTED block), not a bare grep.
    expect(sessionCompactedCount(auditPath(p))).toBe(before + 1);
    // STRONGER: the new block's exact field values, block-scoped (hook lines 61-67).
    const blk = lastCompactedBlock(auditPath(p));
    expect(blk.Event).toBe("SESSION_COMPACTED");
    expect(blk["Current Stage"]).toBe("feasibility");
    expect(blk["State Validity"]).toBe("valid");
  });

  // --- Test 14: no audit.md -> hook does NOT auto-create audit.md ---
  test("14: no audit.md -> hook does not auto-create it (breadcrumb still written)", () => {
    const p = proj();
    seedStateFile(p, "state-mid-ideation.md");
    rmSync(auditPath(p), { force: true });
    const r = runHook(p);
    expect(existsSync(auditPath(p))).toBe(false);
    // STRONGER: the audit emit is gated on audit.md presence, but the breadcrumb
    // path is independent — so the hook still exits 0 and still writes the
    // recovery breadcrumb (its primary signal, hook comment lines 7-8, 47).
    expect(r.status).toBe(0);
    expect(existsSync(recoveryPath(p))).toBe(true);
  });
});
