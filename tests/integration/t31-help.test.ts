// covers: subcommand:aidlc-utility:help
//
// Mechanism = cli. We SPAWN the real binary via
// node:child_process spawnSync (the BUN running this test + the tool .ts) so
// the assertions observe the PROCESS boundary - res.status AND res.stdout -
// not an in-process renderHelpText() return.
//
// WHY A SPAWN (not an import of renderHelpText): the contract under test is
// the `help` SUBCOMMAND — `bun aidlc-utility.ts help` — including its exit
// code and that it writes the compiled text to STDOUT (handleHelp ->
// process.stdout.write, aidlc-utility.ts). The covers id is
// subcommand:aidlc-utility:help, so the subprocess dispatch arm
// (aidlc-utility.ts `case "help"`) is the seam being credited. An
// in-process renderHelpText() twin would lose the exit-0 + stdout-routing half
// the subcommand contract owns.
//
// CONTRACT CONFIRMED: help text is no longer a static constant — renderHelpText()
// (aidlc-utility.ts) compiles the scope block live from
// loadScopeMapping() (aidlc-lib.ts) over validScopes() (aidlc-lib.ts),
// so stage counts ("All 33 stages" / "9 of 33 stages") are derived from the
// shipped scope-grid EXECUTE/Total tallies, not hardcoded. This guards stale
// counts.
//
// NO AUDIT / NO STATE / NO PROJECT DIR: `help` is a pure read-only renderer.
// It emits no audit event, writes no file, and needs no --project-dir / temp
// project. So there is NO createTestProject / seedAuditFile / toPortablePath
// fixture here - there is nothing on disk to round-trip. (Contrast
// tests/unit/t31.test.ts / tests/integration/t90.test.ts, which DO read back
// files the tool wrote and therefore need the temp-project + portable-path
// helpers.)
//
// Additional contracts:
//   S1: res.status === 0 - we pin a clean exit on the subcommand dispatch.
//   S2: All shipped scope names appear.
//   S3: Workshop retains its Minimal testStrategy override; the help renderer
//       appends ", <ts> test strategy" when def.testStrategy is set.
//   S4: "--test-strategy" + "--version" utility flags present — documented in
//       HELP_TEXT_TAIL (aidlc-utility.ts) but unasserted by the .sh.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const BUN = process.execPath;
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
 * Spawn `bun aidlc-utility.ts help` once. No --project-dir / env: help
 * is a pure renderer with no workflow-state dependency.
 */
function runHelp(): CliResult {
  const res = spawnSync(BUN, [TOOL, "help"], { encoding: "utf-8" });
  return { status: res.status ?? -1, stdout: res.stdout ?? "" };
}

// Capture once; each test() re-reads from the shared, immutable capture.
const HELP = runHelp();

describe("t31 aidlc-utility help — CLI contract (migrated from t31-help-text-consistency.sh, plan 19)", () => {
  // --- Subcommand exits clean. ---
  test("S1: help exits 0", () => {
    expect(HELP.status).toBe(0);
  });

  test("S5: human help uses plain ASCII separators", () => {
    expect(HELP.stdout).toStartWith("AI-DLC - AI-Driven Development Life Cycle");
    expect(HELP.stdout).toContain("Describe what to build - the agent proposes a plan, you confirm it");
    expect(HELP.stdout).not.toContain("\u2014");
    expect(HELP.stdout).not.toContain("\u2192");
  });

  // --- All scope names appear (compiled from scope-mapping.json). ---
  // Keep the compiled help surface pinned to every shipped scope.
  const SCOPES = [
    "enterprise",
    "feature",
    "mvp",
    "poc",
    "bugfix",
    "refactor",
    "infra",
    "security-patch",
    "classic",
    "workshop",
    "express",
  ] as const;

  for (const scope of SCOPES) {
    test(`help text lists ${scope} scope`, () => {
      expect(HELP.stdout).toContain(scope);
    });
  }

  // --- All utility commands appear. ---
  // The engine auto-creates; the workspace shell ships in dist/. The help text
  // omits --init/--force and lists the intent/space verb families.
  const UTILITIES = [
    "--status",
    "--doctor",
    "--help",
    "--stage",
    "--phase",
    "--scope",
    "--test-strategy", // S4
    "--version", // S4
    "intent",
    "space",
  ] as const;

  for (const flag of UTILITIES) {
    test(`help text lists ${flag} utility`, () => {
      expect(HELP.stdout).toContain(flag);
    });
  }

  // --init/--force must be ABSENT from help (regression guard - a re-introduced
  // flag in the help reds here).
  for (const gone of ["--init", "--force"] as const) {
    test(`help text does NOT list the retired ${gone}`, () => {
      expect(HELP.stdout).not.toContain(gone);
    });
  }

  // --- Stage-count semantics (compiled from scope-mapping.json EXECUTE/Total). ---
  test("enterprise/feature shows 'All 33 stages'", () => {
    // execute === total -> "All <total> stages" (aidlc-utility.ts renderHelpText).
    expect(HELP.stdout).toContain("All 33 stages");
  });

  test("bugfix shows compiled '9 of 33 stages' count", () => {
    // execute !== total -> "<execute> of <total> stages"; bugfix tallies 9
    // EXECUTE of 33.
    expect(HELP.stdout).toContain("9 of 33 stages");
  });

  test("classic row shows '(default)' marker", () => {
    const classicLine = HELP.stdout
      .split("\n")
      .find((line) => line.trimStart().startsWith("classic"));
    expect(classicLine).toContain("(default)");
  });
});
