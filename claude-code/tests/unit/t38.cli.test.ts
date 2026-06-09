// covers: subcommand:aidlc-utility:status
//
// CLI-contract port of tests/unit/t38-utility-status-gate-awareness.sh
// (TAP plan 5), mechanism = cli. Equal-or-stronger migration: every .sh
// assertion that shelled out to `bun aidlc-utility.ts status --project-dir
// <p>` is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status / combined stdout+stderr
// exactly as the .sh asserted on $? / 2>&1 output. The contract under test —
// gate-awareness in the `Status:` line — is a PROCESS-boundary effect
// (handleStatus reads the seeded state file off disk and writes the rendered
// status block to stdout), so it stays a spawn; an in-process twin would lose
// the exit-code half case 4 relies on.
//
// CONTRACT (aidlc-utility.ts handleStatus, lines 181-313):
//   - current stage's checkbox == [?] (awaiting-approval) ->
//       statusLine = `Awaiting your approval on <displayName>`  (line 223)
//   - current stage's checkbox == [R] (revising) ->
//       statusLine = `Revising <displayName> (revision <N> of 3)` when the
//       Revision Count field is present (line 231), else `Revising
//       <displayName>` (line 232) — never a literal "?" count.
//   - current stage's checkbox == [-] (in-progress) -> statusLine stays the
//       raw Status value ("Running"), no gate phrase leaks.
//   - <displayName> = the stage-graph `name` for the current slug; for the
//       feasibility slug used by state-mid-ideation.md that is
//       "Feasibility & Constraints" (stage-graph.json:221-223).
//   Checkbox -> state mapping: aidlc-lib.ts:62-63 ([?]->awaiting-approval,
//   [R]->revising), confirmed against handleStatus's currentCheckbox?.state
//   branches.
//
// PARITY NOTES (every .sh `ok` line maps to an expect()-bearing test() here;
// several are STRONGER than the original case-insensitive grep):
//   - .sh Test 1  grep -qi "awaiting your approval"            -> Test 1:
//       out contains the EXACT rendered phrase "Awaiting your approval on
//       Feasibility & Constraints" (STRONGER: exact display-name-bearing
//       phrase, not a case-insensitive substring) + exit 0.
//   - .sh Test 2  grep -qi "revising"                          -> Test 2:
//       out contains "Revising Feasibility & Constraints" (STRONGER: exact
//       display-name-bearing phrase) + exit 0.
//   - .sh Test 3  grep -qE "revision.*2.*of.*3"                -> Test 3:
//       out contains the EXACT "(revision 2 of 3)" substring (STRONGER:
//       exact count clause rather than a permissive .*2.*of.*3 regex).
//   - .sh Test 4  grep -qi "awaiting your approval\|revising" must be ABSENT
//       on a [-] stage                                         -> Test 4:
//       out does NOT contain "Awaiting your approval" AND does NOT contain
//       "Revising" (same negative observable, split for clarity) + the raw
//       "Status:         Running" line is present (STRONGER: confirms the
//       fallthrough renders the raw Status rather than merely lacking the
//       gate phrases) + exit 0.
//   - .sh Test 5  assert_eq 0 $? on missing Revision Count     -> Test 5:
//       res.status === 0 (same observable) + STRONGER additions: the
//       [R] branch still renders the bare "Revising Feasibility &
//       Constraints" phrase WITHOUT a "(revision" count clause (pins the
//       graceful-fallback path of line 232, the comment the .sh case name
//       describes but never asserted).
//
// 5 .sh asserts -> 5 expect()-bearing test() cases here (1:1).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file
// + sed_i mutate + cleanup_test_project per case): each case uses a FRESH temp
// project dir (createTestProject, which toPortablePath-converts on Windows so
// the project path round-trips), seeds state-mid-ideation.md via seedStateFile
// (= seed_state_file), then mutates the seeded aidlc-state.md in place via
// sedReplaceInFile / line-delete (= sed_i). All temp dirs cleaned in afterAll.
// NOTHING is written under tests/fixtures/**; the source fixture is only read.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
const STATE_FIXTURE = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "state-mid-ideation.md",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

const statePath = (p: string): string =>
  join(p, "aidlc-docs", "aidlc-state.md");

/** Fresh project seeded with state-mid-ideation.md (create_test_project + seed_state_file). */
function seededProj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedStateFile(p, STATE_FIXTURE);
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn `bun aidlc-utility.ts status --project-dir <p>`. Mirrors `bun "$UTIL" status --project-dir "$PROJ"`. */
function status(p: string): CliResult {
  const res = spawnSync(BUN, [UTIL, "status", "--project-dir", p], {
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/**
 * In-place text replace on the seeded state file. Mirrors sed_i (fixtures.sh)
 * — the .sh used `sed_i 's/.../.../'` against $PROJ/aidlc-docs/aidlc-state.md.
 */
function sedState(p: string, pattern: RegExp, replacement: string): void {
  const f = statePath(p);
  writeFileSync(f, readFileSync(f, "utf-8").replace(pattern, replacement));
}

/** Delete every line matching `pattern` from the seeded state file (mirrors `sed_i '/.../d'`). */
function deleteStateLines(p: string, pattern: RegExp): void {
  const f = statePath(p);
  const kept = readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => !pattern.test(l))
    .join("\n");
  writeFileSync(f, kept);
}

describe("t38 aidlc-utility status — gate awareness (migrated from t38-utility-status-gate-awareness.sh, plan 5)", () => {
  // --- Test 1: [?] state -> "Awaiting your approval" phrase ---
  // state-mid-ideation has feasibility as [-]; flip it to [?].
  test("1: [?] state triggers 'Awaiting your approval' in --status", () => {
    const p = seededProj();
    sedState(p, /^- \[-\] feasibility/m, "- [?] feasibility");
    const r = status(p);
    expect(r.status).toBe(0);
    // STRONGER: exact rendered phrase (display name from stage-graph) instead
    // of the .sh's case-insensitive substring grep.
    expect(r.out).toContain("Awaiting your approval on Feasibility & Constraints");
  });

  // --- Test 2: [R] state -> "Revising" phrase ---
  test("2: [R] state triggers 'Revising' phrase in --status", () => {
    const p = seededProj();
    sedState(p, /^- \[-\] feasibility/m, "- [R] feasibility");
    sedState(p, /^- \*\*Revision Count\*\*: .*/m, "- **Revision Count**: 2");
    const r = status(p);
    expect(r.status).toBe(0);
    // STRONGER: exact display-name-bearing phrase rather than a bare
    // case-insensitive "revising" grep.
    expect(r.out).toContain("Revising Feasibility & Constraints");
  });

  // --- Test 3: [R] revision count 2 of 3 shown ---
  test("3: [R] revision count 2 of 3 shown", () => {
    const p = seededProj();
    sedState(p, /^- \[-\] feasibility/m, "- [R] feasibility");
    sedState(p, /^- \*\*Revision Count\*\*: .*/m, "- **Revision Count**: 2");
    const r = status(p);
    expect(r.status).toBe(0);
    // STRONGER: exact "(revision 2 of 3)" clause rather than the .sh's
    // permissive `revision.*2.*of.*3` regex.
    expect(r.out).toContain("(revision 2 of 3)");
  });

  // --- Test 4: [-] normal state -> no [?] / [R] phrases ---
  test("4: [-] normal state doesn't leak gate phrases", () => {
    const p = seededProj(); // feasibility stays [-]
    const r = status(p);
    expect(r.status).toBe(0);
    // Negative observable, split from the .sh's single OR-grep for clarity.
    expect(r.out).not.toContain("Awaiting your approval");
    expect(r.out).not.toContain("Revising");
    // STRONGER: confirms the fallthrough renders the RAW Status (Running)
    // rather than merely lacking the gate phrases (handleStatus:220).
    expect(r.out).toContain("Status:         Running");
  });

  // --- Test 5: Missing Revision Count falls back gracefully ---
  test("5: --status handles missing Revision Count gracefully", () => {
    const p = seededProj();
    sedState(p, /^- \[-\] feasibility/m, "- [R] feasibility");
    deleteStateLines(p, /^- \*\*Revision Count\*\*:/);
    const r = status(p);
    // Same observable as the .sh's assert_eq 0 $?: must not crash.
    expect(r.status).toBe(0);
    // STRONGER: the [R] branch still renders the bare "Revising" phrase, and
    // the absent-count fallback (handleStatus:232) omits any "(revision"
    // clause rather than rendering a literal "?" count.
    expect(r.out).toContain("Revising Feasibility & Constraints");
    expect(r.out).not.toContain("(revision");
  });
});
