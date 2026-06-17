// covers: subcommand:aidlc-utility:help
//
// CLI-contract port of tests/integration/t31-help-text-consistency.sh (TAP plan
// 19), mechanism = cli. The .sh captured `HELP_TEXT=$(bun "$TOOL" help 2>/dev/null)`
// once and ran 19 substring `assert_contains` checks against it. Equal-or-
// stronger migration: every one of those 19 substring assertions has a
// counterpart expect() below, and we SPAWN the real binary via
// node:child_process spawnSync (the BUN running this test + the tool .ts) so
// the assertions observe the PROCESS boundary — res.status AND res.stdout —
// not an in-process renderHelpText() return.
//
// WHY A SPAWN (not an import of renderHelpText): the contract under test is
// the `help` SUBCOMMAND — `bun aidlc-utility.ts help` — including its exit
// code and that it writes the compiled text to STDOUT (handleHelp ->
// process.stdout.write, aidlc-utility.ts:165-167). The covers id is
// subcommand:aidlc-utility:help, so the subprocess dispatch arm
// (aidlc-utility.ts:2815 `case "help"`) is the seam being credited. An
// in-process renderHelpText() twin would lose the exit-0 + stdout-routing half
// the subcommand contract owns.
//
// CONTRACT CONFIRMED: help text is no longer a static constant — renderHelpText()
// (aidlc-utility.ts:143-163) compiles the scope block live from
// loadScopeMapping() (aidlc-lib.ts:739) over validScopes() (aidlc-lib.ts:783),
// so stage counts ("All 32 stages" / "7 of 32 stages") are derived from the
// shipped scope-mapping.json EXECUTE/Total tallies, not hardcoded. This is the
// exact regression the .sh guards (the 6 stale counts that shipped pre-milestone-10).
//
// NO AUDIT / NO STATE / NO PROJECT DIR: `help` is a pure read-only renderer.
// It emits no audit event, writes no file, and needs no --project-dir / temp
// project. So there is NO createTestProject / seedAuditFile / toPortablePath
// fixture here — there is nothing on disk to round-trip. (Contrast t31.cli /
// t90.cli, which DO read back an audit.md the tool wrote and therefore need the
// temp-project + portable-path helpers. The .sh likewise sourced fixtures.sh
// but called none of create_test_project / seed_*.)
//
// PARITY MAP (every .sh `assert_contains` -> one expect() here; same observable
// substring of the captured help text):
//   .sh:28  "enterprise"        -> "lists enterprise scope"
//   .sh:29  "feature"           -> "lists feature scope"
//   .sh:30  "mvp"               -> "lists mvp scope"
//   .sh:31  "poc"               -> "lists poc scope"
//   .sh:32  "bugfix"            -> "lists bugfix scope"
//   .sh:33  "refactor"          -> "lists refactor scope"
//   .sh:34  "infra"             -> "lists infra scope"
//   .sh:35  "security-patch"    -> "lists security-patch scope"
//   .sh:38  "--status"          -> "lists --status utility"
//   .sh:39  "--init"            -> "lists --init utility"
//   .sh:40  "--doctor"          -> "lists --doctor utility"
//   .sh:41  "--help"            -> "lists --help utility"
//   .sh:47  "All 32 stages"     -> "enterprise/feature shows 'All 32 stages'"
//   .sh:48  "7 of 32 stages"    -> "bugfix shows compiled '7 of 32 stages'"
//   .sh:49  "(default)"         -> "feature row shows '(default)' marker"
//   .sh:52  "--force"           -> "lists --force flag"
//   .sh:55  "--stage"           -> "lists --stage utility"
//   .sh:56  "--phase"           -> "lists --phase utility"
//   .sh:57  "--scope"           -> "lists --scope utility"
//
// STRONGER ADDITIONS (assert MORE, never less):
//   S1: res.status === 0 — the .sh discarded `$?` (it captured stdout with
//       `2>/dev/null` and never checked the exit code); we pin a clean exit on
//       the subcommand dispatch.
//   S2: "workshop" scope present — the .sh HEADER comment claims "all 9 scope
//       names appear" but only directly asserted 8; workshop is the 9th
//       (visible in the live output, compiled from scope-mapping.json). Closing
//       the gap between the .sh's stated intent and its asserts.
//   S3: workshop's "minimal test strategy" surfaces — the .sh header (line 8)
//       says it tests "(d) workshop's minimal test strategy surfaces" but never
//       wrote that assert; renderHelpText appends ", <ts> test strategy" only
//       when def.testStrategy is set (aidlc-utility.ts:151-153), and workshop is
//       the only scope with one. This is the documented-but-missing fourth check.
//   S4: "--test-strategy" + "--version" utility flags present — documented in
//       HELP_TEXT_TAIL (aidlc-utility.ts:123-124) but unasserted by the .sh.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);

interface CliResult {
  status: number;
  stdout: string;
}

/**
 * Spawn `bun aidlc-utility.ts help` once. Mirrors the .sh's
 * `HELP_TEXT=$(bun "$TOOL" help 2>/dev/null)`. No --project-dir / env: help
 * is a pure renderer with no filesystem or workflow-state dependency.
 */
function runHelp(): CliResult {
  const res = spawnSync(BUN, [TOOL, "help"], { encoding: "utf-8" });
  return { status: res.status ?? -1, stdout: res.stdout ?? "" };
}

// Capture once (the .sh captured once and asserted 19 times over the same
// string); each test() re-reads from the shared, immutable capture.
const HELP = runHelp();

describe("t31 aidlc-utility help — CLI contract (migrated from t31-help-text-consistency.sh, plan 19)", () => {
  // --- STRONGER: subcommand exits clean (the .sh never checked $?). ---
  test("S1: help exits 0", () => {
    expect(HELP.status).toBe(0);
  });

  // --- All scope names appear (compiled from scope-mapping.json). ---
  // The .sh directly asserted 8 of these; "workshop" (S2) closes the gap with
  // the .sh header's "all 9 scope names" claim.
  const SCOPES = [
    "enterprise",
    "feature",
    "mvp",
    "poc",
    "bugfix",
    "refactor",
    "infra",
    "security-patch",
    "workshop", // S2: 9th scope, header-claimed but unasserted in the .sh
  ] as const;

  for (const scope of SCOPES) {
    test(`help text lists ${scope} scope`, () => {
      expect(HELP.stdout).toContain(scope);
    });
  }

  // --- All utility commands appear. ---
  // The .sh asserted --status/--init/--doctor/--help (Utilities block) and
  // --stage/--phase/--scope (jump utilities) and --force. S4 added
  // --test-strategy/--version. P4 RETIRED the user-facing --init/--force (the
  // engine auto-births; the workspace shell ships in dist/) and added the
  // intent/space verb families — so the help text drops --init/--force and lists
  // the verbs instead.
  const UTILITIES = [
    "--status",
    "--doctor",
    "--help",
    "--stage",
    "--phase",
    "--scope",
    "--test-strategy", // S4
    "--version", // S4
    "intent", // P4: the intent verb family
    "space", // P4: the space verb family
  ] as const;

  for (const flag of UTILITIES) {
    test(`help text lists ${flag} utility`, () => {
      expect(HELP.stdout).toContain(flag);
    });
  }

  // P4: the retired flags must be ABSENT from help (regression guard — a
  // re-introduced --init/--force in the help reds here).
  for (const gone of ["--init", "--force"] as const) {
    test(`help text does NOT list the retired ${gone}`, () => {
      expect(HELP.stdout).not.toContain(gone);
    });
  }

  // --- Stage-count semantics (compiled from scope-mapping.json EXECUTE/Total). ---
  test("enterprise/feature shows 'All 32 stages'", () => {
    // execute === total -> "All <total> stages" (aidlc-utility.ts:156-157).
    expect(HELP.stdout).toContain("All 32 stages");
  });

  test("bugfix shows compiled '7 of 32 stages' count", () => {
    // execute !== total -> "<execute> of <total> stages"; bugfix tallies 7
    // EXECUTE of 32 (was the stale "~8 stages" pre-milestone-10).
    expect(HELP.stdout).toContain("7 of 32 stages");
  });

  test("feature row shows '(default)' marker", () => {
    // defaultMarker fires only for name === "feature" (aidlc-utility.ts:155).
    expect(HELP.stdout).toContain("(default)");
  });

  // --- STRONGER S3: workshop's "minimal test strategy" surfaces (the .sh
  // header line 8 names this as check (d) but never wrote the assert). ---
  test("S3: workshop row surfaces 'minimal test strategy'", () => {
    expect(HELP.stdout).toContain("minimal test strategy");
  });
});
