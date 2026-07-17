// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// CLI-contract port of tests/integration/t120-classify-roundtrip.sh (TAP plan 19),
// mechanism = cli. The walking-skeleton classify round-trip: the ONE knowledge
// round-trip the v0.6.0 engine DEFERS rather than decides (per the v0.6.0
// engine design; review Major A). The first Construction Bolt's gate
// depends on the walking-skeleton STANCE, which an LLM resolves by reading a
// team's free-form `## Walking Skeleton` prose — no parser turns free English
// into a stance. So the engine honours the boundary with a three-step round-trip:
//   (1) `next` over a Construction-at-Bolt-1 state emits a `run-stage` for the
//       skeleton-gate stage with gate = the sentinel "unresolved";
//   (2) the conductor classifies the prose and hands the typed stance back via
//       `report --skeleton-stance <on|off|scope-dependent>` (recorded in the
//       `Skeleton Stance` state field; NO transition committed);
//   (3) the FOLLOW-UP `next` reads the recorded stance and re-emits the SAME
//       stage with the now-DETERMINED boolean gate.
// The engine still owns the transition — only a typed stance ever crosses back in.
//
// Why SPAWN (not in-process): every .sh step shells out to the engine binary
// `bun aidlc-orchestrate.ts next|report` over a seeded state fixture and diffs
// the emitted directive JSON on stdout / the `Skeleton Stance` field
// aidlc-state.ts writes to disk through report's `set-skeleton-stance` spawn.
// The contract under test IS the subprocess boundary plus that file side effect;
// an in-process twin would lose the report → aidlc-state.ts subprocess seam and
// the directive-on-stdout shell the .sh's `2>&1` captures. It NEVER calls a
// model — the conductor's prose-classify step is the LLM's job (proven in the
// prose-orchestrator workflow tier); this corpus is the deterministic mirror of
// the ENGINE half of the round-trip. Mirrors the t118.cli.test.ts harness.
//
// Source under test (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   :715 computeGate(node, scope, stateContent): GateValue
//          - skeleton-gate stage + NO stance recorded → GATE_UNRESOLVED
//            (= "unresolved", aidlc-directive.ts:37) — the round-trip sentinel
//          - skeleton-gate stage + stance recorded   → resolveSkeletonGate(...)
//          - every other EXECUTE stage               → true
//   :534 resolveSkeletonGate(stance, scope): boolean — true for on/off/scope-
//          dependent (the stance picks the ceremony, not whether a gate fires)
//   :501 isSkeletonGateStage(node, scope) — first construction EXECUTE stage of
//          the scope (feature → functional-design)
//   :1641 handleSkeletonStanceReport(stance, projectDir): void
//          - invalid stance value      → error `Unknown --skeleton-stance "<v>"`
//          - no state file             → error `No workflow state found ...`
//          - off the skeleton-gate stage → error `... is not the skeleton-gate
//            stage for scope "<scope>" ...`
//          - valid + parked on skeleton stage → spawns aidlc-state.ts
//            set-skeleton-stance, then emits a `print` (re-run next)
//
// The DETERMINED gate is `true` for every stance (aidlc-orchestrate.ts:534-553):
// per the verified resolution prose (SKILL.md:655-720), skeleton-on always-gates
// Bolt 1, and skeleton-off runs Bolt 1 as a regular Bolt whose batch gate is
// still presented (Construction Autonomy Mode unset → gated until the post-Bolt-1
// ladder). The stance picks the CEREMONY, not whether a gate is presented; the
// gate axis is on for all construction work. The round-trip earns its keep by
// DETERMINING the boolean the engine could not compute, not by it differing.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh per-stance loop (3 stances × 4 = 12):
//     [s] step 1: next → run-stage(functional-design) gate:"unresolved"
//         -> test "[<s>] step 1 ..." (kind|stage|gate co-located on the parsed directive)
//     [s] step 2: report --skeleton-stance <s> → print
//         -> test "[<s>] step 2 (print) ..." (directive.kind === "print")
//     [s] step 2: stance recorded in the `Skeleton Stance` state field
//         -> test "[<s>] step 2 (state) ..." (`**Skeleton Stance**: <s>` on disk)
//     [s] step 3: next → run-stage(functional-design) gate:true
//         -> test "[<s>] step 3 ..." (kind|stage|gate co-located, gate === true)
//   .sh backward-compat (1): non-skeleton construction stage → boolean gate:true
//     -> test "backward-compat ..."
//   .sh negative 1 (2): invalid stance → error + names the rejected value
//     -> test "negative: invalid stance ..." (kind === "error" AND message names "bogus")
//   .sh negative 2 (2): stance off the skeleton-gate stage → error + explains
//     -> test "negative: off the skeleton-gate stage ..." (kind === "error" AND
//        message carries the verbatim `is not the skeleton-gate stage for scope`)
//   .sh negative 3 (2): stance with no state file → error + verbatim no-state wording
//     -> test "negative: no state file ..." (kind === "error" AND `No workflow state found`)
//
// 19 .sh asserts -> 19 expect()-bearing test() cases (the .sh's two-observable
// `assert_eq "a|b|c"` lines are kept as multiple expect()s inside one test(),
// matching the single `ok` line the .sh emitted for each).
//
// FIXTURE DISCIPLINE (mirrors create_test_project + seed_state_file +
// cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject, toPortablePath-converted on Windows so audit.md the tools
// may write round-trips when read back), seeded from the same on-disk fixtures
// the .sh used (state-construction-bolt1.md, state-construction.md). Nothing is
// written under tests/fixtures/**. All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const ORCHESTRATE = join(TOOLS, "aidlc-orchestrate.ts");

// The skeleton-gate stage for the fixture's scope (feature): the first
// Construction EXECUTE stage. Frozen here; matches firstInScopeStageOfPhase(
// "construction", "feature") and the Bolt-1 fixture's own Current Stage.
const SKELETON_STAGE = "functional-design";

// Scope is resolved partly from AWS_AIDLC_DEFAULT_SCOPE — start from a known
// clean env so a developer's exported value can't shadow the seeded fixture.
// Mirrors the .sh's reset_aidlc_env (line 68).
resetAidlcEnv();

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

function run(tool: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [tool, ...args], { encoding: "utf-8" });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Fresh temp project seeded from a FIXTURES_DIR state fixture. */
function projWithState(fixtureName: string): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedStateFile(p, join(FIXTURES_DIR, fixtureName));
  return p;
}

/** Fresh CLEAN temp project — aidlc-docs/ exists, no state file (negative 3). */
function cleanProj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

// P9: state lives in the seeded per-intent record the subprocess resolves via
// the active-intent cursor (the flat aidlc-docs/ root is retired).
const statePath = (p: string): string => seededStateFile(p);

// Parse the single directive JSON the engine emits on stdout (the .sh's
// json_field python helper, but a real JSON.parse of the whole object — STRONGER
// than the .sh's per-field substring extraction since it validates the shape).
// biome-ignore lint/suspicious/noExplicitAny: directives are a typed union; the test reads scalar fields
function directive(r: CliResult): any {
  return JSON.parse(r.stdout.trim());
}

describe("t120 walking-skeleton classify round-trip (migrated from t120-classify-roundtrip.sh, plan 19)", () => {
  // ===========================================================================
  // The round-trip, end-to-end, per stance (3 stances × 4 = 12). Each stance
  // seeds a FRESH copy of the Bolt-1 fixture (the round-trip mutates state) and
  // drives next → report --skeleton-stance <s> → next. The DETERMINED gate is
  // `true` for every stance (resolveSkeletonGate, :534).
  // ===========================================================================
  for (const stance of ["on", "off", "scope-dependent"] as const) {
    test(`[${stance}] step 1: next → run-stage(${SKELETON_STAGE}) gate:"unresolved" (engine defers the skeleton gate)`, () => {
      const p = projWithState("state-construction-bolt1.md");
      const d = directive(run(ORCHESTRATE, ["next", "--project-dir", p]));
      expect(d.kind).toBe("run-stage");
      expect(d.stage).toBe(SKELETON_STAGE);
      // The sentinel — a STRING, not a boolean (GATE_UNRESOLVED === "unresolved").
      expect(d.gate).toBe("unresolved");
    }, 30000);

    test(`[${stance}] step 2 (print): report --skeleton-stance ${stance} → print (stance accepted, re-run next)`, () => {
      const p = projWithState("state-construction-bolt1.md");
      // Park on the skeleton gate first (step 1) — the report guard requires it.
      run(ORCHESTRATE, ["next", "--project-dir", p]);
      const d = directive(
        run(ORCHESTRATE, [
          "report",
          "--skeleton-stance",
          stance,
          "--project-dir",
          p,
        ]),
      );
      // A `print` (re-run next), NOT a done/transition — no commit crossed back.
      expect(d.kind).toBe("print");
    }, 30000);

    test(`[${stance}] step 2 (state): stance recorded in the Skeleton Stance state field`, () => {
      const p = projWithState("state-construction-bolt1.md");
      run(ORCHESTRATE, ["next", "--project-dir", p]);
      run(ORCHESTRATE, [
        "report",
        "--skeleton-stance",
        stance,
        "--project-dir",
        p,
      ]);
      // aidlc-state.ts set-skeleton-stance writes `**Skeleton Stance**: <s>`
      // (mirrors the .sh's assert_grep '\*\*Skeleton Stance\*\*: <stance>').
      const body = readFileSync(statePath(p), "utf-8");
      expect(body.includes(`**Skeleton Stance**: ${stance}`)).toBe(true);
    }, 30000);

    test(`[${stance}] step 3: next → run-stage(${SKELETON_STAGE}) gate:true (determined from stance)`, () => {
      const p = projWithState("state-construction-bolt1.md");
      run(ORCHESTRATE, ["next", "--project-dir", p]);
      run(ORCHESTRATE, [
        "report",
        "--skeleton-stance",
        stance,
        "--project-dir",
        p,
      ]);
      const d = directive(run(ORCHESTRATE, ["next", "--project-dir", p]));
      expect(d.kind).toBe("run-stage");
      expect(d.stage).toBe(SKELETON_STAGE);
      // No longer the sentinel — a DETERMINED boolean. STRONGER than a string
      // diff: assert the JSON type is boolean AND the value is true.
      expect(typeof d.gate).toBe("boolean");
      expect(d.gate).toBe(true);
    }, 30000);
  }

  // ===========================================================================
  // Backward-compat: a non-skeleton run-stage keeps its BOOLEAN gate (1).
  // state-construction.md has Current Stage=functional-design ALREADY completed,
  // so next advances to nfr-design — a non-first construction stage — which must
  // emit a plain boolean gate:true, never "unresolved". Proves the deferral does
  // not leak to every construction stage.
  // ===========================================================================
  test("backward-compat: a non-skeleton construction stage emits boolean gate:true, never the sentinel", () => {
    const p = projWithState("state-construction.md");
    const d = directive(run(ORCHESTRATE, ["next", "--project-dir", p]));
    // STRONGER than the .sh (which only checked the value): assert the gate is a
    // BOOLEAN true (not the string sentinel), and it is not on functional-design.
    expect(typeof d.gate).toBe("boolean");
    expect(d.gate).toBe(true);
    expect(d.gate).not.toBe("unresolved");
  }, 30000);

  // ===========================================================================
  // Negative path 1: invalid stance value → error (2). Only on/off/scope-
  // dependent are accepted; anything else is a hard error rather than a silent
  // write (handleSkeletonStanceReport, :1645).
  // ===========================================================================
  test("negative: report --skeleton-stance bogus → error directive naming the rejected value", () => {
    const p = projWithState("state-construction-bolt1.md");
    const d = directive(
      run(ORCHESTRATE, [
        "report",
        "--skeleton-stance",
        "bogus",
        "--project-dir",
        p,
      ]),
    );
    expect(d.kind).toBe("error");
    // The error names the rejected value verbatim (mirrors the .sh's
    // assert_contains on 'Unknown --skeleton-stance "bogus"').
    expect(d.message).toContain('Unknown --skeleton-stance "bogus"');
  }, 30000);

  // ===========================================================================
  // Negative path 2: stance reported off the skeleton-gate stage → error (2).
  // With Current Stage advanced to nfr-design (NOT the skeleton stage), the
  // conductor mis-fired — the engine surfaces it rather than writing the field at
  // the wrong moment (handleSkeletonStanceReport, :1681).
  // ===========================================================================
  test("negative: stance off the skeleton-gate stage (nfr-design) → error explaining it is not the skeleton-gate stage", () => {
    const p = projWithState("state-construction.md");
    const state = readFileSync(statePath(p), "utf-8");
    writeFileSync(
      statePath(p),
      state.replace(
        /^- \*\*Current Stage\*\*:.*$/m,
        "- **Current Stage**: nfr-design",
      ),
      "utf-8",
    );
    const d = directive(
      run(ORCHESTRATE, [
        "report",
        "--skeleton-stance",
        "on",
        "--project-dir",
        p,
      ]),
    );
    expect(d.kind).toBe("error");
    // Verbatim guard wording (the .sh grepped the raw directive for it).
    expect(d.message).toContain("is not the skeleton-gate stage for scope");
  }, 30000);

  // ===========================================================================
  // Negative path 3: stance reported with no state file → error (2).
  // cleanProj makes aidlc-docs/ but NO aidlc-state.md — there is nothing to
  // record a stance for (handleSkeletonStanceReport, :1655).
  // ===========================================================================
  test("negative: stance with no state file → error carrying the verbatim no-state wording", () => {
    const p = cleanProj();
    // Precondition: there genuinely is no state file (mirrors the .sh's bare
    // create_test_project with no seed_state_file).
    expect(existsSync(statePath(p))).toBe(false);
    const d = directive(
      run(ORCHESTRATE, [
        "report",
        "--skeleton-stance",
        "on",
        "--project-dir",
        p,
      ]),
    );
    expect(d.kind).toBe("error");
    expect(d.message).toContain("No active intent workflow state found");
  }, 30000);
});
