// covers: subcommand:aidlc-utility:scope-change
//
// CLI-contract port of tests/unit/t36-utility-scope-change.sh (TAP plan 7),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-utility.ts scope-change ...` is preserved by
// SPAWNING the real CLI via node:child_process spawnSync (BUN + the tool
// .ts path), asserting on res.status / the aidlc-state.md the tool rewrites
// / the audit.md it appends to — the PROCESS boundary, not an in-process
// handleScopeChange() call. An in-process twin would lose the exit-code half
// the .sh's Tests 4 & 5 rely on: the tool's reject path is die() ->
// emitError() -> process.exit(1) (aidlc-utility.ts:74-84 -> aidlc-lib.ts:1546),
// only observable across the process boundary.
//
// CONTRACT CONFIRMED FROM SOURCE (read this session):
//   - handleScopeChange (aidlc-utility.ts:2193-2350):
//       * `--scope` required -> die("--scope is required for scope-change")
//         when absent (line 2194-2195).
//       * unknown target -> die(`Unknown scope: ${newScope}. ...`) before any
//         state mutation (line 2210-2212), AFTER the state-file existence
//         check (so a seeded state is required to reach the scope-validation
//         arm).
//       * on success: setField(content,"Scope",newScope) (line 2299) +
//         rewrites Stage Progress / counts / Last Updated, then writes state,
//         then appendAuditEvent("SCOPE_CHANGED", {Old Scope, New Scope,
//         Stage Count Delta, Stages in Scope, Depth}) (line 2335-2341).
//       * Current Stage is NOT touched — the rewrite preserves the
//         `## Current Status` block; only the `## Stage Progress` checkbox
//         section + the numbered fields are rebuilt. (Mirrors .sh Test 6.)
//   - The 9 canonical scopes are exactly the keys of
//     data/scope-mapping.json: enterprise, feature, mvp, poc, bugfix,
//     refactor, infra, security-patch, workshop (verified by reading the
//     JSON keys) — identical to the .sh's Test-3 loop list.
//   - Audit row shape (aidlc-audit.ts:256-267): a `## Scope Changed` heading,
//     then `**Timestamp**:`, `**Event**: SCOPE_CHANGED`, then one
//     `**<key>**: <value>` line per field, terminated by `---`. The .sh
//     grepped `^\*\*Event\*\*: SCOPE_CHANGED` and `\*\*Old Scope\*\*: feature`;
//     here we count the event row and read the Old Scope field block-scoped.
//   - state-mid-ideation.md fixture carries `**Scope**: feature` and
//     `**Current Stage**: feasibility` (read this session) — the .sh's Test 7
//     "Old Scope=feature" and Test 6 "Current Stage preserved" both lean on
//     that fixture content.
//
// PARITY NOTES (each .sh assertion -> an expect() below; several STRONGER):
//   - .sh Test 1  assert_grep state '\*\*Scope\*\*: mvp'           -> Test 1:
//       getField(state,"Scope") === "mvp" (STRONGER: exact field value via
//       the same setField/getField round-trip the tool uses, not a file-wide
//       substring grep) + res.status === 0 (the .sh swallowed $? with
//       `|| true`; we pin clean exit).
//   - .sh Test 2  assert_grep audit '^\*\*Event\*\*: SCOPE_CHANGED'  -> Test 2:
//       scopeChangedCount(audit) === 1 (STRONGER: counts the row against the
//       seeded audit-sample.md baseline — which contains NO SCOPE_CHANGED —
//       rather than a bare presence grep) + res.status === 0.
//   - .sh Test 3  loop: each of 9 scopes -> state '\*\*Scope\*\*: <t>'  ->
//       Test 3: per-scope sub-test, getField(state,"Scope") === target exact,
//       all 9 targets (the .sh emitted a single `ok` after the loop; we keep
//       one expect per scope so a single bad scope is pinpointed — STRONGER).
//   - .sh Test 4  invalid scope: $? == 1                          -> Test 4:
//       res.status === 1 (same observable) + stderr/stdout names the bad scope
//       ("Unknown scope") (STRONGER: the .sh only checked rc).
//   - .sh Test 5  missing --scope flag: $? == 1                   -> Test 5:
//       res.status === 1 + "--scope is required" message asserted (STRONGER).
//   - .sh Test 6  Current Stage line identical before/after       -> Test 6:
//       getField(before,"Current Stage") === getField(after,"Current Stage")
//       (same observable — the preserved Current Stage value).
//   - .sh Test 7  assert_grep audit '\*\*Old Scope\*\*: feature'    -> Test 7:
//       auditField(audit,"SCOPE_CHANGED","Old Scope") === "feature" (STRONGER:
//       exact value scoped to the SCOPE_CHANGED block, not a file-wide grep) +
//       New Scope === "mvp" asserted too (the comment says the row records
//       BOTH From and To; the .sh only grepped Old Scope, so the New Scope
//       assert is a STRONGER addition matching the .sh's stated intent).
//
// 7 .sh asserts -> 7 expect()-bearing test() cases here (Test 3 keeps its
// single .sh `ok` semantics but iterates 9 scopes inside one case with one
// expect per scope).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file
// + seed_state_file + cleanup_test_project per case): each case uses a FRESH
// temp project dir (createTestProject, which toPortablePath-converts on
// Windows so audit.md / state.md — written by the tool via forward-slash
// helpers — round-trip when read back). Audit-emitting cases seed
// audit-sample.md (which contains NO SCOPE_CHANGED, so post-fire counts are
// unambiguous) and state-mid-ideation.md (Scope=feature) exactly as the .sh
// did. NOTHING is written under tests/fixtures/**. All temp dirs cleaned in
// afterAll.

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
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
// The .sh seeds this fixture for every case (state-mid-ideation.md: Scope=feature,
// Current Stage=feasibility).
const STATE_MID_IDEATION = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "state-mid-ideation.md",
);

// The 9 canonical scopes — exactly the .sh's Test-3 loop AND the keys of
// data/scope-mapping.json (verified this session).
const CANONICAL_SCOPES = [
  "enterprise",
  "feature",
  "mvp",
  "poc",
  "bugfix",
  "refactor",
  "infra",
  "security-patch",
  "workshop",
] as const;

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

const statePath = (p: string): string =>
  join(p, "aidlc-docs", "aidlc-state.md");
const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");

/**
 * Fresh temp project seeded with audit-sample.md + state-mid-ideation.md,
 * mirroring the .sh's per-case create_test_project + seed_audit_file +
 * seed_state_file "$REPO_ROOT/tests/fixtures/state-mid-ideation.md".
 */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAuditFile(p);
  seedStateFile(p, STATE_MID_IDEATION);
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn `bun aidlc-utility.ts scope-change <args...> --project-dir <p>`. */
function scopeChange(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [TOOL, "scope-change", ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/**
 * Value of `- **<key>**: <value>` from the aidlc-state.md body. Mirrors the
 * tool's own getField (aidlc-utility.ts) which the .sh's `grep '\*\*Scope\*\*:'`
 * observed. Returns "" when absent.
 */
function stateField(file: string, key: string): string {
  if (!existsSync(file)) return "";
  const re = new RegExp(`^- \\*\\*${key}\\*\\*: (.*)$`);
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return "";
}

/**
 * Count audit blocks with `**Event**: SCOPE_CHANGED`. Mirrors the .sh's
 * `^\*\*Event\*\*: SCOPE_CHANGED` grep, but as an exact count against the
 * seeded baseline (audit-sample.md carries no SCOPE_CHANGED).
 */
function scopeChangedCount(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l === "**Event**: SCOPE_CHANGED").length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Walks the file; resets at `## ` headings and `---` separators; splits
 * `**label**: value` on the literal `**: ` separator (audit-row shape per
 * aidlc-audit.ts:256-267). Block-scoped, so it pins Old Scope to the
 * SCOPE_CHANGED row exactly (STRONGER than the .sh's file-wide grep).
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

describe("t36 aidlc-utility scope-change — CLI contract (migrated from t36-utility-scope-change.sh, plan 7)", () => {
  // --- .sh Test 1: scope-change on active workflow mutates Scope field ---
  test("1: scope-change updates Scope field to mvp", () => {
    const p = proj();
    const r = scopeChange(["--scope", "mvp"], p);
    expect(r.status).toBe(0); // .sh swallowed $? with `|| true`; we pin clean exit
    expect(stateField(statePath(p), "Scope")).toBe("mvp");
  });

  // --- .sh Test 2: SCOPE_CHANGED audit event is emitted ---
  test("2: scope-change emits SCOPE_CHANGED", () => {
    const p = proj();
    const r = scopeChange(["--scope", "bugfix"], p);
    expect(r.status).toBe(0);
    // STRONGER: count against the seeded baseline (audit-sample.md has none).
    expect(scopeChangedCount(auditPath(p))).toBe(1);
  });

  // --- .sh Test 3: each of the 9 canonical scopes accepted as a target ---
  test("3: all 9 canonical scopes accepted as targets", () => {
    for (const target of CANONICAL_SCOPES) {
      const p = proj();
      scopeChange(["--scope", target], p);
      // The fixture starts at Scope=feature. For target===feature the tool
      // short-circuits ("Scope is already feature", exit 0) and leaves the
      // field at feature — which still satisfies `**Scope**: feature`, exactly
      // as the .sh's grep `^- \*\*Scope\*\*: feature$` did for that iteration.
      expect(stateField(statePath(p), "Scope")).toBe(target);
    }
  });

  // --- .sh Test 4: invalid target scope rejected ---
  test("4: invalid target scope rejected (exit 1)", () => {
    const p = proj();
    const r = scopeChange(["--scope", "totally-bogus"], p);
    expect(r.status).toBe(1); // same observable as the .sh's `assert_eq 1 $rc`
    // STRONGER: the .sh only checked rc; we assert the diagnostic names it.
    expect(r.out).toContain("Unknown scope");
  });

  // --- .sh Test 5: missing --scope flag rejected ---
  test("5: missing --scope flag rejected (exit 1)", () => {
    const p = proj();
    // No --scope (scopeChange always appends --project-dir, never --scope).
    const r = scopeChange([], p);
    expect(r.status).toBe(1);
    // STRONGER: assert the require-message fires (die path, aidlc-utility.ts:2195).
    expect(r.out).toContain("--scope is required");
  });

  // --- .sh Test 6: scope-change preserves Current Stage (doesn't kick back) ---
  test("6: Current Stage preserved across scope-change", () => {
    const p = proj();
    const before = stateField(statePath(p), "Current Stage");
    expect(before).toBe("feasibility"); // fixture sanity (state-mid-ideation.md)
    scopeChange(["--scope", "bugfix"], p);
    const after = stateField(statePath(p), "Current Stage");
    expect(after).toBe(before); // same observable as the .sh's before==after
  });

  // --- .sh Test 7: From-scope recorded in SCOPE_CHANGED event ---
  test("7: SCOPE_CHANGED records Old Scope=feature (and New Scope=mvp)", () => {
    const p = proj();
    scopeChange(["--scope", "mvp"], p);
    // state-mid-ideation.md starts at Scope=feature.
    // STRONGER: block-scoped exact-value read, not a file-wide grep.
    expect(auditField(auditPath(p), "SCOPE_CHANGED", "Old Scope")).toBe("feature");
    // STRONGER addition: the .sh comment says the row records BOTH From and To.
    expect(auditField(auditPath(p), "SCOPE_CHANGED", "New Scope")).toBe("mvp");
  });
});
