// covers: scope:bugfix, scope:feature, scope:mvp, scope:security-patch, scope:infra, scope:refactor
//
// CLI-contract port of tests/integration/t130-scope-runners.sh (TAP plan 12),
// mechanism = cli. The .sh carried NO `# covers:` header (it predates the
// covers-registry convention); its SUBJECT is the per-scope first-EXECUTE-stage
// routing the scope runners drive through the engine. So this twin credits the
// `scope:` units it genuinely proves — the same units the .sh exercised by
// initialising under each scope and resolving its opening move. (Confirmed valid
// scope unitIds in tests/.coverage-registry.json: all enumerate from
// data/scope-grid.json.)
//
// COVERAGE EXTENSION (the post-MR11 delivery audit, §6/§7): the .sh proved the
// four first-BATCH scopes; the same engine drive trivially extends to the two
// remaining scopes the audit flagged UNCOVERED — infra and refactor — by adding
// their measured first-EXECUTE move to the CASES table below. Each is the
// identical assertion shape (run-stage + first-EXECUTE stage + baked persona)
// over the same real `aidlc-orchestrate next --scope <s>` drive, so it covers
// the scope at the same cli strength, not by a weaker mention. enterprise/poc/
// workshop are covered by their own tui scope run-throughs; bugfix/feature/mvp/
// security-patch/infra/refactor are the cli-routed set this corpus owns.
//
// WHAT THE .sh PROVED (t130-scope-runners.sh:1-12 prose + the loop at :42-70):
//   For each first-batch scope the runner's shell makes the SAME first move —
//   `aidlc-orchestrate.ts next --scope <scope>` over a real init,
//   and the test pins that
//     (a) the engine resolves a `run-stage` directive,
//     (b) it lands on that scope's first EXECUTE stage (the brownfield
//         conditional stages SKIP on an empty greenfield workspace, so
//         security-patch's reverse-engineering is greenfield-skipped and the
//         engine lands on requirements-analysis), and
//     (c) the directive carries the conductor persona — decision D-E: the runner
//         does NOT load the persona by hand; the ENGINE bakes it into the FIRST
//         run-stage of the workflow.
//   The exhaustive drive-to-done per scope is t118's corpus; t130 pins only that
//   the runner's baked-scope FIRST move reaches the engine and carries the persona.
//
// WHY SPAWN (mechanism cli, not in-process): the .sh shells out to TWO binaries
// per case — `aidlc-utility.ts init --scope …` (a state-writing
// MUTATION) then `aidlc-orchestrate.ts next --scope … ` (the engine's read-only
// directive emit) — against a temp project holding a FULL copy of the shipped
// .claude/. Both run FROM THE COPY (`bun <proj>/.claude/tools/…`) so the engine
// resolves the graph, the stage files, AND `../aidlc-common/conductor.md`
// (aidlc-orchestrate.ts:351, CONDUCTOR_PERSONA_PATH resolved relative to the
// tool module) from the copied tree. An in-process twin would lose the init→next
// process seam AND the cwd-independent persona resolution the corpus exists to
// pin. spawnCount = all (init + next per scope).
//
// SOURCE UNDER TEST:
//   - aidlc-orchestrate.ts buildRunStageDirective (:742) — kind:"run-stage",
//     stage = resolved graph node slug; bakes conductor_persona on the FIRST
//     run-stage (isFirstRunStageOfWorkflow, :385 -> readConductorPersona, :357).
//   - The per-scope first-EXECUTE-stage routing the engine derives from the
//     compiled scope grid (verified live: bugfix->requirements-analysis,
//     feature->intent-capture, mvp->intent-capture, security-patch->
//     requirements-analysis).
//
// Old TAP -> new test parity (1:1; the .sh emitted 3 `ok` lines per scope ->
// each is one expect() here, grouped under one test() per scope = STRONGER:
// kind + stage + persona asserted together on the SAME parsed directive object,
// not three independent greps; the .sh's plan 12 = 4 scopes x 3 assertions, this
// twin extends to 6 scopes x 3 = 18 with the two audit-flagged scopes added):
//   .sh "aidlc-<scope>: baked-scope first move -> run-stage"            -> directive.kind === "run-stage"
//   .sh "aidlc-<scope>: lands on first EXECUTE stage (<want>)"          -> directive.stage === <want>
//   .sh "aidlc-<scope>: directive carries the conductor persona"        -> typeof directive.conductor_persona === "string" && length > 0
//
// FIXTURE DISCIPLINE (mirrors the .sh's make_project at :32-40 — mktemp -d,
// cp -r "$SRC" "$proj/.claude", init --scope <s>, then rm -rf): each
// scope gets a FRESH integration project (setupIntegrationProject copies the
// shipped dist/claude/.claude into <proj>/.claude exactly as the .sh's cp -r),
// is initialised via the COPIED utility tool, then the COPIED engine
// resolves `next --scope <s>`. Nothing is written under tests/fixtures/**; all
// temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  cleanupTestProject,
  resetAidlcEnv,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test

// Clear leaked AWS_AIDLC_DEFAULT_SCOPE so the scope resolves from the --scope
// flag / state, not a developer's shell env (parity with the .sh's pure env).
resetAidlcEnv();

// Per first-batch scope: the first EXECUTE stage the engine resolves on a fresh
// greenfield init. Mirrors the .sh's CASES at :26. Measured live
// against the shipped engine before authoring (see the SOURCE UNDER TEST note).
const CASES: ReadonlyArray<{ scope: string; wantStage: string }> = [
  { scope: "bugfix", wantStage: "requirements-analysis" },
  { scope: "feature", wantStage: "intent-capture" },
  { scope: "mvp", wantStage: "intent-capture" },
  // security-patch's first EXECUTE is reverse-engineering, but that brownfield
  // conditional stage greenfield-SKIPs on the empty workspace, so the engine
  // lands on the next EXECUTE: requirements-analysis (in scope so the
  // `requirements` artifact its downstream consumers hard-require has a
  // producer — scopes/aidlc-security-patch.md).
  { scope: "security-patch", wantStage: "requirements-analysis" },
  // infra skips ideation + application-code construction; practices-discovery is
  // its first EXECUTE stage (scopes/aidlc-infra.md). Measured live.
  { scope: "infra", wantStage: "practices-discovery" },
  // refactor's first EXECUTE is reverse-engineering, but that brownfield
  // conditional stage greenfield-SKIPs on the empty workspace (same as
  // security-patch's reverse-engineering), so the engine lands on the next
  // EXECUTE: requirements-analysis (scopes/aidlc-refactor.md). Measured live.
  { scope: "refactor", wantStage: "requirements-analysis" },
];

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** The copied tool path inside the integration project (the .sh ran the COPY). */
function tool(proj: string, name: string): string {
  return join(proj, ".claude", "tools", name);
}

// biome-ignore lint/suspicious/noExplicitAny: the directive is a typed union; the test reads scalar fields off the parsed object.
type Directive = any;

/**
 * make_project + first move (t130-scope-runners.sh:32-49): scaffold a full
 * integration project (copy of the shipped .claude/), init --scope <s>
 * via the COPIED utility tool, then resolve the runner's FIRST move
 * `aidlc-orchestrate.ts next --scope <s>` via the COPIED engine and parse the
 * single emitted directive JSON off stdout.
 */
function firstMoveDirective(scope: string): Directive {
  const proj = setupIntegrationProject();
  tempDirs.push(proj);

  const init = spawnSync(
    BUN,
    [
      tool(proj, "aidlc-utility.ts"),
      "intent-birth",
      "--scope",
      scope,
      "--project-dir",
      proj,
    ],
    { encoding: "utf-8" },
  );
  // init is a precondition (the .sh swallowed its output but it must succeed for
  // a workflow to exist); assert it so a broken init never masquerades as a
  // routing failure downstream.
  expect(init.status).toBe(0);

  const next = spawnSync(
    BUN,
    [
      tool(proj, "aidlc-orchestrate.ts"),
      "next",
      "--scope",
      scope,
      "--project-dir",
      proj,
    ],
    { encoding: "utf-8" },
  );
  return JSON.parse((next.stdout ?? "").trim());
}

describe("t130 scope runners — baked-scope first move through the engine (migrated from t130-scope-runners.sh, plan 12)", () => {
  for (const { scope, wantStage } of CASES) {
    test(`aidlc-${scope}: first move -> run-stage(${wantStage}) carrying the engine-delivered conductor persona`, () => {
      const d = firstMoveDirective(scope);
      // .sh assert 1: baked-scope first move resolves a run-stage directive.
      expect(d.kind).toBe("run-stage");
      // .sh assert 2: it lands on this scope's first EXECUTE stage.
      expect(d.stage).toBe(wantStage);
      // .sh assert 3: D-E — the engine bakes the conductor persona into the
      // FIRST run-stage (the runner never loads it by hand). STRONGER than the
      // .sh's `has_persona == "1"` flag: assert it is a non-empty string.
      expect(typeof d.conductor_persona).toBe("string");
      expect(d.conductor_persona.length).toBeGreaterThan(0);
    }, 60000);
  }
});
