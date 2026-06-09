// covers: audit:ERROR_LOGGED
//
// CLI-contract port of tests/unit/t34-tool-error-logged.sh (TAP plan 11),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-state.ts|aidlc-log.ts|aidlc-jump.ts|aidlc-bolt.ts
// <bad-args> --project-dir <p>` is preserved by SPAWNING the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path), asserting on
// res.status / res.stderr exactly as the .sh asserted on $?, plus on the
// audit.md the tool writes through emitError -> appendAuditEntry. The
// contract under test is the PROCESS boundary (every tool CLI's error()
// helper routes through emitError, aidlc-lib.ts:1504-1547, which appends one
// ERROR_LOGGED block to the active workflow's audit.md best-effort, no-ops if
// no state file exists, and exits 1). An in-process emitError twin would lose
// the process.exit(1) half (Test 5) AND the cross-process recursion-guard
// behaviour (Test 11: the guard is process-local, so two fresh processes must
// yield two rows) — so all cases stay spawn-based.
//
// AUDIT-ROW SHAPE (confirmed against aidlc-audit.ts:256-267 emitter +
// aidlc-lib.ts:1528-1538 field map): emitError writes a block whose lines are
//   **Event**: ERROR_LOGGED
//   **Tool**: <tool>            (e.g. aidlc-state)
//   **Command**: <tool> <argv>  (process.argv.slice(2).join(" "), built from the
//                                FULL argv — confirmed aidlc-state.ts:1713 — so the
//                                trailing --project-dir <p> survives into the row;
//                                main() at :106-110 splices only its own local args
//                                copy, NOT process.argv)
//   **Error**: <msg>            (e.g. "Unknown subcommand: ...")
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several are
// STRONGER than the original grep):
//   - .sh Test 1  assert_grep "^**Event**: ERROR_LOGGED"        -> Test 1:
//       errorLoggedCount(audit) === 1 (STRONGER: exact count against a seeded
//       baseline that contains ZERO ERROR_LOGGED rows, not a bare presence
//       grep) + res.status === 1 + JSON error on stderr.
//   - .sh Test 2  assert_grep "**Tool**: aidlc-state"           -> Test 2:
//       auditField(ERROR_LOGGED,"Tool") === "aidlc-state" (STRONGER: exact
//       field value scoped to the ERROR_LOGGED block, not a file-wide grep).
//   - .sh Test 3  **Command**: aidlc-state bogus-cmd            -> Test 3:
//       auditField "Command" startsWith "aidlc-state bogus-cmd" (the .sh grep
//       was UNANCHORED; error() builds Command from the FULL argv so the row is
//       "aidlc-state bogus-cmd --project-dir <p>", matched on its prefix).
//       STRONGER: block-scoped + also asserts --project-dir survives into the row.
//   - .sh Test 4  **Error**: Unknown subcommand                 -> Test 4:
//       auditField "Error" startsWith "Unknown subcommand" (STRONGER: exact
//       block-scoped field, not a substring grep over the whole file).
//   - .sh Test 5  $? == 1                                       -> Test 5:
//       res.status === 1 (same observable).
//   - .sh Test 6  no state file -> audit.md NOT created         -> Test 6:
//       existsSync(audit) === false after a bogus command in a project with
//       aidlc-docs/ but no state file and no audit.md (same observable, the
//       no-op path of emitError's existsSync(stateFile) guard).
//   - .sh Test 7  aidlc-log error **Tool**: aidlc-log           -> Test 7:
//       auditField "Tool" === "aidlc-log" (STRONGER, exact) + count===1.
//   - .sh Test 8  aidlc-jump error **Tool**: aidlc-jump         -> Test 8:
//       auditField "Tool" === "aidlc-jump" (STRONGER, exact) + count===1.
//   - .sh Test 9  aidlc-bolt error **Tool**: aidlc-bolt         -> Test 9:
//       auditField "Tool" === "aidlc-bolt" (STRONGER, exact) + count===1.
//   - .sh Test 11 two invocations -> two ERROR_LOGGED entries   -> Test 11:
//       errorLoggedCount === 2 after two fresh spawns (process-local guard
//       does not over-guard across processes) (same observable).
//   - .sh Test 12 ERROR_LOGGED survives taxonomy validation     -> Test 12:
//       errorLoggedCount === 1 (the row actually lands; regression guard for
//       ERROR_LOGGED's presence in VALID_EVENT_TYPES, aidlc-audit.ts:65)
//       (same observable) + STRONGER: assert the surfaced JSON error on stderr
//       so the swallowed-write path can't pass on a missing row alone.
//
// 11 .sh asserts -> 11 expect()-bearing test() cases here (1:1; the .sh's
// missing "Test 10" slot is intentional in the source — there is no .sh case
// numbered 10, so none is ported).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file
// + seed_state_file + cleanup_test_project per case): each case uses a FRESH
// temp project dir (createTestProject, which toPortablePath-converts on
// Windows so audit.md — written by the tool — round-trips when read back).
// Audit-emitting cases seed audit-sample.md (which contains ZERO ERROR_LOGGED
// rows, so post-fire counts are unambiguous) AND state-mid-ideation.md (the
// state file emitError's existsSync guard requires before it emits). Test 6
// deliberately seeds NEITHER. All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const STATE = join(TOOLS_DIR, "aidlc-state.ts");
const LOG = join(TOOLS_DIR, "aidlc-log.ts");
const JUMP = join(TOOLS_DIR, "aidlc-jump.ts");
const BOLT = join(TOOLS_DIR, "aidlc-bolt.ts");

// The .sh seeds every audit-emitting case with this state fixture (its
// existence is what flips emitError from no-op to emit).
const STATE_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "state-mid-ideation.md");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** create_test_project + seed_audit_file + seed_state_file (the .sh's standard prelude). */
function seededProj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAuditFile(p);
  seedStateFile(p, STATE_FIXTURE);
  return p;
}

/** create_test_project ONLY — aidlc-docs/ exists, but no state file, no audit.md (Test 6). */
function bareProj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stderr: string;
}

/** Spawn `bun <tool> <args...> --project-dir <p>`. Mirrors `bun "$TOOL" ... --project-dir "$PROJ"`. */
function run(tool: string, args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stderr = res.stderr ?? "";
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${stderr}`,
    stderr,
  };
}

/** Count `**Event**: ERROR_LOGGED` lines. Mirrors the .sh's `grep -c '^\*\*Event\*\*: ERROR_LOGGED'`. */
function errorLoggedCount(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l === "**Event**: ERROR_LOGGED").length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Resets at `## ` headings and `---` separators; splits `**label**: value`
 * on the literal `**: ` separator. Mirrors auditField in t31.cli.test.ts.
 * Returns "" when absent (block-scoped).
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

// ============================================================
// aidlc-state — the primary emitError driver (.sh Tests 1-6, 11, 12)
// ============================================================

describe("t34 ERROR_LOGGED via emitError (migrated from t34-tool-error-logged.sh, plan 11)", () => {
  test("1: aidlc-state bogus-cmd emits exactly one ERROR_LOGGED", () => {
    const p = seededProj();
    const r = run(STATE, ["bogus-cmd"], p);
    // STRONGER than the .sh presence grep: exact count against a zero-baseline seed.
    expect(errorLoggedCount(auditPath(p))).toBe(1);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"error"'); // JSON error on stderr (emitError, lib.ts:1545)
  });

  test("2: ERROR_LOGGED has Tool=aidlc-state", () => {
    const p = seededProj();
    run(STATE, ["bogus-cmd"], p);
    expect(auditField(auditPath(p), "ERROR_LOGGED", "Tool")).toBe("aidlc-state");
  });

  test("3: ERROR_LOGGED Command starts with the failing invocation", () => {
    const p = seededProj();
    run(STATE, ["bogus-cmd"], p);
    // .sh grepped '**Command**: aidlc-state bogus-cmd' — an UNANCHORED substring
    // match. error() (aidlc-state.ts:1713) builds the Command from the FULL
    // process.argv.slice(2), which still carries the trailing --project-dir <p>
    // (main() splices only its own local args copy, NOT process.argv). So the
    // recorded Command is "aidlc-state bogus-cmd --project-dir <p>", which the
    // .sh's unanchored grep matched on its prefix. STRONGER than the file-wide
    // grep: this assert is block-scoped to the ERROR_LOGGED entry, and pins the
    // exact "aidlc-state bogus-cmd" prefix + that --project-dir survives into the row.
    const command = auditField(auditPath(p), "ERROR_LOGGED", "Command");
    expect(command).toStartWith("aidlc-state bogus-cmd");
    expect(command).toContain("--project-dir");
  });

  test("4: ERROR_LOGGED records the Error message", () => {
    const p = seededProj();
    run(STATE, ["bogus-cmd"], p);
    // .sh grepped '**Error**: Unknown subcommand'; assert the exact field
    // begins with that diagnostic (STRONGER: block-scoped, not file-wide).
    expect(auditField(auditPath(p), "ERROR_LOGGED", "Error")).toStartWith("Unknown subcommand");
  });

  test("5: error() exits with code 1", () => {
    const p = seededProj();
    const r = run(STATE, ["bogus-cmd"], p);
    expect(r.status).toBe(1);
  });

  test("6: no-op when no state file (audit.md not created)", () => {
    // aidlc-docs/ exists (createTestProject), but no state file and no audit.md.
    // emitError's existsSync(stateFilePath) guard (lib.ts:1513) makes it a no-op.
    const p = bareProj();
    const r = run(STATE, ["bogus-cmd"], p);
    expect(existsSync(auditPath(p))).toBe(false);
    // Tool still errors out (the no-op only suppresses the audit emit).
    expect(r.status).toBe(1);
  });

  test("11: two invocations produce two ERROR_LOGGED entries (process-local guard)", () => {
    const p = seededProj();
    run(STATE, ["bogus-1"], p);
    run(STATE, ["bogus-2"], p);
    // The recursion guard is process-local; each spawn is a fresh process.
    expect(errorLoggedCount(auditPath(p))).toBe(2);
  });

  test("12: ERROR_LOGGED survives taxonomy validation (row actually lands)", () => {
    // Regression guard: if ERROR_LOGGED were removed from VALID_EVENT_TYPES,
    // appendAuditEntry would throw, emitError would swallow it, and the row
    // would be missing. Assert it lands AND that the JSON error surfaced (so a
    // silently-swallowed write can't masquerade as success).
    const p = seededProj();
    const r = run(STATE, ["bogus"], p);
    expect(errorLoggedCount(auditPath(p))).toBe(1);
    expect(r.stderr).toContain('"error"');
  });
});

// ============================================================
// Cross-tool: aidlc-log / aidlc-jump / aidlc-bolt all route their
// error() helper through the same emitError (.sh Tests 7-9).
// ============================================================

describe("t34 emitError is shared across tool CLIs", () => {
  test("7: aidlc-log error routes through emitError (Tool=aidlc-log)", () => {
    const p = seededProj();
    run(LOG, ["bogus"], p);
    expect(errorLoggedCount(auditPath(p))).toBe(1);
    expect(auditField(auditPath(p), "ERROR_LOGGED", "Tool")).toBe("aidlc-log");
  });

  test("8: aidlc-jump error routes through emitError (Tool=aidlc-jump)", () => {
    const p = seededProj();
    // `preview` is not a valid aidlc-jump subcommand (valid: resolve, execute,
    // aidlc-jump.ts:65) — so the unknown-subcommand error() fires, regardless
    // of the --to flag. Mirrors the .sh's `aidlc-jump preview --to non-existent-slug`.
    run(JUMP, ["preview", "--to", "non-existent-slug"], p);
    expect(errorLoggedCount(auditPath(p))).toBe(1);
    expect(auditField(auditPath(p), "ERROR_LOGGED", "Tool")).toBe("aidlc-jump");
  });

  test("9: aidlc-bolt error routes through emitError (Tool=aidlc-bolt)", () => {
    const p = seededProj();
    run(BOLT, ["bogus"], p);
    expect(errorLoggedCount(auditPath(p))).toBe(1);
    expect(auditField(auditPath(p), "ERROR_LOGGED", "Tool")).toBe("aidlc-bolt");
  });
});
