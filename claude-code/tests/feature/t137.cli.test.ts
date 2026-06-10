// covers: audit:ERROR_LOGGED
//
// CLI-contract port of tests/feature/t123-failure-injection.sh (renumbered to t137 for milestone 2; TAP plan 8),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-state.ts <sub> ...` / `bun aidlc-utility.ts init`
// is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status (== $rc) and on the
// audit.md / aidlc-state.md the tools write — the PROCESS boundary, including
// the process.exit(1) that the .sh's `$?` arm relies on (emitError ->
// process.exit(1), aidlc-lib.ts:1546). An in-process twin would lose the
// exit-code half every failure case hinges on.
//
// THE COVERED UNIT — audit:ERROR_LOGGED. This file exercises the
// failure-injection paths whose observable is the ERROR_LOGGED audit row
// emitted by emitError (aidlc-lib.ts:1504-1547). emitError fires its
// ERROR_LOGGED append ONLY when stateFilePath(projectDir) exists
// (aidlc-lib.ts:1513) — Failure 4 (read-only state.md, file present) is the
// case that lands a fresh ERROR_LOGGED row, and Test 8 asserts the count
// climbs. The row format is `**Event**: ERROR_LOGGED` (aidlc-audit.ts:258,
// heading "Error Logged" aidlc-audit.ts:149), Tool/Command/Error fields
// (aidlc-lib.ts:1528-1538).
//
// CHAOS CONTRACT under test (the .sh's four failure injections):
//   F1. Permission-denied on audit.md during a transition — audit-first means
//       appendAuditEntry throws BEFORE writeStateFile, so the tool exits 1 and
//       aidlc-state.md is byte-identical to its pre-injection snapshot.
//   F2. Missing audit.md — appendAuditEntry -> appendAuditEntryUnlocked ->
//       ensureAuditFile (aidlc-audit.ts:254) recreates it; gate-start exits 0.
//   F3. Corrupted state (no Scope) — handleAdvance refuses with an error that
//       names the missing "Scope" field (aidlc-state.ts:290-293); exits 1.
//   F4. Read-only state.md — the audit emit succeeds (ERROR_LOGGED lands) but
//       writeStateFile can't write, so the tool exits 1 AND a fresh
//       ERROR_LOGGED row is appended (the covered observable).
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several are
// STRONGER than the original):
//   - .sh 1  assert_eq 1 $rc (acknowledge, audit.md 0444)         -> Test 1:
//       res.status === 1 (same observable).
//   - .sh 2  state file unchanged after audit-write failure       -> Test 2:
//       readFileSync(state) === snapshot (same observable — exact byte
//       equality of the whole state file, as the .sh's string compare did).
//   - .sh 3  assert_eq 0 $rc (gate-start, audit.md missing)       -> Test 3:
//       res.status === 0 (same observable).
//   - .sh 4  audit.md recreated on demand                         -> Test 4:
//       existsSync(audit) === true (same observable). STRONGER: also assert
//       the recreated file carries the STAGE_AWAITING_APPROVAL row gate-start
//       emits, proving it was rebuilt-and-written, not merely touched.
//   - .sh 5  assert_eq 1 $rc (advance, corrupted state)           -> Test 5:
//       res.status === 1 (same observable).
//   - .sh 6  error message mentions the missing Scope field       -> Test 6:
//       combined stdout+stderr contains "Scope" (same observable as the .sh's
//       `echo "$out" | grep -q "Scope"`, out = 2>&1). STRONGER: pin the exact
//       refusal sentence "no Scope field".
//   - .sh 7  assert_eq 1 $rc (gate-start, state.md 0444)          -> Test 7:
//       res.status === 1 (same observable).
//   - .sh 8  ERROR_LOGGED emitted on state-write failure          -> Test 8:
//       errorLoggedCount(after) > errorLoggedCount(before) (same observable
//       as the .sh's grep-count delta). STRONGER: also assert the new row's
//       Tool field is "aidlc-state", proving the row came from the state
//       tool's emitError path and not some pre-seeded event.
//
// 8 .sh asserts -> 8 expect()-bearing test() cases here, one observable each.
//
// PLATFORM SKIP (mirrors the .sh's root-skip at lines 30-33): the three
// chmod-injection cases (F1, F4) rely on chmod 0444 actually denying writes.
// On native Windows chmod is a near-no-op (and the suite never runs the .sh
// there either — it's bash). We gate F1/F4 behind a runIfChmod guard so the
// file stays green on Windows CI while preserving full coverage on
// macOS/Linux. F2 and F3 carry no chmod and always run. (The .sh's root skip
// is unreachable here: tests don't run as uid 0.)
//
// FIXTURE DISCIPLINE (mirrors create_test_project + cleanup_test_project per
// case): each case uses a FRESH temp project dir (createTestProject, which
// toPortablePath-converts on Windows so audit.md / aidlc-state.md — written
// by the tools via forward-slash path helpers — round-trip when read back).
// F3 copies the SAME tests/fixtures/audit-sample.md the .sh used (read-only
// source copy; nothing is WRITTEN under tests/fixtures). All temp dirs are
// cleaned in afterAll, and every chmod is restored to 0644 in a finally so a
// failed assertion can't leave an unremovable read-only dir behind.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  FIXTURES_DIR,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const UTIL = join(TOOLS, "aidlc-utility.ts");
const STATE = join(TOOLS, "aidlc-state.ts");

// On native Windows, chmod 0444 doesn't actually deny writes, so the three
// permission-injection cases cannot be exercised faithfully. Gate them.
const CHMOD_WORKS = process.platform !== "win32";
const runIfChmod = CHMOD_WORKS ? test : test.skip;

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) {
    // Defensive: restore writability before removal in case a case bailed
    // out after chmod-ing but before its finally ran.
    try {
      chmodSync(join(d, "aidlc-docs", "audit.md"), 0o644);
    } catch {
      /* file may not exist */
    }
    try {
      chmodSync(join(d, "aidlc-docs", "aidlc-state.md"), 0o644);
    } catch {
      /* file may not exist */
    }
    cleanupTestProject(d);
  }
});

/** Fresh temp project (create_test_project). */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");
const statePath = (p: string): string =>
  join(p, "aidlc-docs", "aidlc-state.md");

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/**
 * `AIDLC_WORKFLOW_INTENT=chaos bun aidlc-utility.ts init --scope bugfix
 * --project-dir <p> --test-run` (t123:43-44). Mirrors the .sh's init.
 */
function init(p: string): CliResult {
  const res = spawnSync(
    BUN,
    [UTIL, "init", "--scope", "bugfix", "--project-dir", p, "--test-run"],
    { encoding: "utf-8", env: { ...process.env, AIDLC_WORKFLOW_INTENT: "chaos" } },
  );
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Spawn `bun aidlc-state.ts <args...> --project-dir <p>`. Mirrors `bun "$STATE" ...`. */
function state(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [STATE, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * Count audit blocks with `**Event**: ERROR_LOGGED`. Mirrors the .sh's
 * `grep -cE '^\*\*Event\*\*: ERROR_LOGGED'`.
 */
function errorLoggedCount(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => /^\*\*Event\*\*: ERROR_LOGGED$/.test(l)).length;
}

/** Whole-file presence (unanchored substring, mirrors a bare grep). */
function fileContains(file: string, needle: string): boolean {
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf-8").includes(needle);
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Resets at `## ` headings and `---` separators. Used by Test 8's STRONGER
 * Tool-field check. Returns "" when absent.
 */
function auditField(file: string, ev: string, key: string): string {
  if (!existsSync(file)) return "";
  let matched = false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (line.startsWith("## ") || line === "---") {
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
      if (pos > 0 && stripped.slice(0, pos) === key) {
        return stripped.slice(pos + 4);
      }
    }
  }
  return "";
}

// ============================================================
// Failure 1: permission-denied on audit.md during a transition.
// Audit-first: appendAuditEntry throws before writeStateFile, so the tool
// exits 1 and aidlc-state.md is unchanged. (.sh Tests 1-2)
// ============================================================

describe("t137 F1 — read-only audit.md (audit-first holds)", () => {
  runIfChmod(
    "1: acknowledge-compaction exits 1 when audit.md is read-only; 2: state unchanged",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0); // sanity: scaffolding succeeded

      const audit = auditPath(p);
      const state2 = statePath(p);

      // Inject a SESSION_COMPACTED event so acknowledge-compaction has
      // something to act on (mirrors the .sh's cat >> heredoc, lines 50-57).
      writeFileSync(
        audit,
        `${readFileSync(audit, "utf-8")}
## Session Compacted
**Timestamp**: 2026-05-03T00:00:00Z
**Event**: SESSION_COMPACTED

---
`,
        "utf-8",
      );

      const stateBefore = readFileSync(state2, "utf-8");

      chmodSync(audit, 0o444);
      let r: CliResult;
      try {
        r = state(
          ["acknowledge-compaction", "--choice", "continue"],
          p,
        );
      } finally {
        chmodSync(audit, 0o644);
      }

      // .sh Test 1: assert_eq 1 $rc.
      expect(r.status).toBe(1);
      // .sh Test 2: state file byte-unchanged after the audit-write failure.
      expect(readFileSync(state2, "utf-8")).toBe(stateBefore);
    },
    30000,
  );
});

// ============================================================
// Failure 2: missing audit.md — ensureAuditFile recovers, gate-start exits 0
// and the audit file is recreated. (.sh Tests 3-4) — no chmod, always runs.
// ============================================================

describe("t137 F2 — missing audit.md (ensureAuditFile recovers)", () => {
  test(
    "3: gate-start exits 0 when audit.md was missing; 4: audit.md recreated",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0);

      // Remove audit.md (mirrors the .sh's `rm "$audit"`, line 89).
      rmSync(auditPath(p));
      expect(existsSync(auditPath(p))).toBe(false); // precondition

      const r = state(["gate-start", "requirements-analysis"], p);

      // .sh Test 3: assert_eq 0 $rc — ensureAuditFile recovers, no crash.
      expect(r.status).toBe(0);
      // .sh Test 4: audit.md recreated on demand.
      expect(existsSync(auditPath(p))).toBe(true);
      // STRONGER than the .sh's bare `[ -f ... ]`: the recreated file carries
      // the STAGE_AWAITING_APPROVAL row gate-start emits, proving it was
      // rebuilt-and-written, not merely touched.
      expect(fileContains(auditPath(p), "**Event**: STAGE_AWAITING_APPROVAL")).toBe(
        true,
      );
    },
    30000,
  );
});

// ============================================================
// Failure 3: corrupted state (no Scope) — advance refuses, naming the field.
// (.sh Tests 5-6) — no chmod, always runs.
// ============================================================

describe("t137 F3 — corrupted state.md (advance refuses, names Scope)", () => {
  test("5: advance exits 1 on corrupted state; 6: error names Scope", () => {
    const p = proj();
    mkdirSync(join(p, "aidlc-docs"), { recursive: true });
    // State file valid markdown but missing Scope / Current Stage
    // (mirrors the .sh heredoc, lines 109-114).
    writeFileSync(
      statePath(p),
      `# AI-DLC State Tracking

## Project Information
- **Project**: corrupted test
`,
      "utf-8",
    );
    // Copy the SAME fixture the .sh used (read-only source copy).
    writeFileSync(
      auditPath(p),
      readFileSync(join(FIXTURES_DIR, "audit-sample.md"), "utf-8"),
      "utf-8",
    );

    const r = state(["advance", "requirements-analysis"], p);

    // .sh Test 5: assert_eq 1 $rc.
    expect(r.status).toBe(1);
    // .sh Test 6: `echo "$out" | grep -q "Scope"` (out captured 2>&1).
    expect(r.out).toContain("Scope");
    // STRONGER: pin the exact refusal sentence (aidlc-state.ts:290-293).
    expect(r.out).toContain("no Scope field");
  });
});

// ============================================================
// Failure 4: read-only state.md — emitError lands an ERROR_LOGGED row (the
// covered observable) even though writeStateFile can't write; tool exits 1.
// (.sh Tests 7-8)
// ============================================================

describe("t137 F4 — read-only state.md (ERROR_LOGGED emitted)", () => {
  runIfChmod(
    "7: gate-start exits 1 when state.md is read-only; 8: ERROR_LOGGED emitted",
    () => {
      const p = proj();
      expect(init(p).status).toBe(0);

      const audit = auditPath(p);
      const state2 = statePath(p);

      // Count pre-existing ERROR_LOGGED rows (0 on a clean init).
      const errorBefore = errorLoggedCount(audit);

      chmodSync(state2, 0o444);
      let r: CliResult;
      try {
        r = state(["gate-start", "requirements-analysis"], p);
      } finally {
        chmodSync(state2, 0o644);
      }

      // .sh Test 7: assert_eq 1 $rc.
      expect(r.status).toBe(1);

      // .sh Test 8: ERROR_LOGGED count climbed (emitError fired on the
      // state-write failure path; state.md existed so the guard at
      // aidlc-lib.ts:1513 let the row through).
      const errorAfter = errorLoggedCount(audit);
      expect(errorAfter).toBeGreaterThan(errorBefore);
      // STRONGER than the .sh's bare count delta: the new ERROR_LOGGED row
      // came from the state tool's emitError (Tool: "aidlc-state",
      // aidlc-lib.ts:1528-1538 / aidlc-state.ts:1713).
      expect(auditField(audit, "ERROR_LOGGED", "Tool")).toBe("aidlc-state");
    },
    30000,
  );
});
