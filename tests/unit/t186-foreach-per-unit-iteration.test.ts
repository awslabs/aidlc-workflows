// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// CLI-contract test for issue #368, the engine drives per-unit `for_each`
// iteration for the inline per-unit Construction stages. mechanism = cli.
//
// THE BUG (#368): a multi-unit Construction phase produced design/code for ONLY
// the first unit, because `next` emitted ONE run-stage directive carrying the
// literal `{unit-name}` placeholder and nothing iterated. THE FIX: on a `next`
// that lands on an in-flight per-unit Construction stage (off the swarm path),
// the engine reads the ordered unit list (the compiled Bolt DAG, flattened),
// finds the FIRST unit whose `produces[]` artifacts are not all on disk under
// `<recordPrefix>/construction/<unit>/<slug>/`, and emits a run-stage for THAT
// concrete unit with `directive.unit` set. The gate is suppressed (false) on
// every unit except the last uncovered one (which carries the real gate). When
// no unit DAG exists the engine degrades to today's single `{unit-name}`
// directive (zero behaviour change). A deterministic coverage guard on the
// approve path refuses an early approve while units remain.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   - orderedUnits / unitCovered / nextUncoveredUnit / emitPerUnitRunStage /
//     emitForSlug, the per-unit iteration core, wired into BOTH handleNext call
//     sites after tryEmitSwarm returns false.
//   - the §3d coverage guard in handleReport (refuses approve while >1 uncovered).
//   - aidlc-directive.ts, the optional `unit` field on RunStageDirective.
// NONE are exported (the tool has zero exports), so the behaviour is observable
// only on the JSON directive the spawned engine emits to stdout, MECHANISM =
// cli: SPAWN `bun aidlc-orchestrate.ts next|report` and assert on the parsed
// directive, the SAME process boundary t116 (emit/parse) and t135 (bolt_dag
// seeding) drive.
//
// FIXTURE DISCIPLINE (mirrors t135's seedCodegenProject + t116's fresh-temp-per-
// emit): each case uses a FRESH temp project (createTestProject seeds the
// per-intent workspace shell + default record). We write a CLEAN single-row-per-
// slug Construction state (NOT the synthetic duplicate-row state-construction.md
// fixture, that models a representation the engine never writes), pivot Current
// Stage to the per-unit stage and flip its checkbox in-flight, write a bolt_dag
// runtime-graph.json with units [alpha, beta], and seed per-unit artifact dirs to
// control coverage. The `Skeleton Stance` field is recorded so functional-design
// (the feature-scope skeleton-gate stage) resolves its gate to a boolean rather
// than emitting the unresolved sentinel, isolating the per-unit behaviour. All
// temp dirs are cleaned in afterEach.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  resetAidlcEnv,
  seedBoltDag,
  seedBoltDagBatches,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath; // the bun running this test
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

// The record-relative prefix every resolved per-unit path is rooted at, the
// active intent's record dir (relativeRecordDir over the seeded default intent).
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;

// functional-design's REQUIRED produces[] (verified frontmatter), the artifacts
// that constitute a unit's coverage for that stage. frontend-components is
// declared under optional_produces and is exempt from per-unit coverage, so it
// is deliberately NOT in this set.
const FD_REQUIRED_PRODUCES = [
  "business-logic-model",
  "business-rules",
  "domain-entities",
];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  produces?: string[];
  message?: string;
  [k: string]: unknown;
}

/**
 * A CLEAN Construction-phase state file: one checkbox row per slug (the shape
 * the engine actually writes, NOT the synthetic duplicate-row fixture), Current
 * Stage pivoted to `current` and marked in-flight ([-]). `skeletonStance`, when
 * set, records the resolved walking-skeleton stance so the feature-scope
 * skeleton-gate stage (functional-design) emits a boolean gate rather than the
 * unresolved sentinel.
 */
function constructionState(current: string, skeletonStance?: string): string {
  const stanceLine = skeletonStance
    ? `- **Skeleton Stance**: ${skeletonStance}\n`
    : "";
  return `# AI-DLC State Tracking

## Project Information
- **Project**: per-unit iteration test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7
${stanceLine}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

### INCEPTION PHASE
- [-] application-design — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`;
}

/** Add the autonomy grant after the Scope line, so code-generation swarms. */
function setAutonomous(proj: string): void {
  const statePath = seededStateFile(proj);
  const state = readFileSync(statePath, "utf-8").replace(
    /^(- \*\*Scope\*\*: .*)$/m,
    "$1\n- **Construction Autonomy Mode**: autonomous",
  );
  writeFileSync(statePath, state);
}

/**
 * Mark `unit` COVERED for `slug` by writing each artifact in `producesNames`
 * under the resolved per-unit dir construction/<unit>/<slug>/ in the record.
 */
function coverUnit(
  proj: string,
  unit: string,
  slug: string,
  producesNames: string[],
): void {
  const dir = join(seededRecordDir(proj), "construction", unit, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of producesNames) {
    writeFileSync(join(dir, `${name}.md`), `# ${name} for ${unit}\n`);
  }
}

/** Seed a fresh Construction project pivoted to `current`. Returns the proj dir. */
function seedProject(current: string, skeletonStance?: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(seededStateFile(proj), constructionState(current, skeletonStance));
  return proj;
}

/** Run `aidlc-orchestrate.ts next` and parse the emitted directive. */
function runNext(proj: string): Directive {
  const r = spawnSync(BUN, [ORCH, "next", "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as Directive;
  } catch {
    throw new Error(
      `runNext did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`,
    );
  }
}

/** Run `aidlc-orchestrate.ts report ...` and parse the emitted directive. */
function runReport(proj: string, args: string[]): Directive {
  const r = spawnSync(BUN, [ORCH, "report", ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as Directive;
  } catch {
    throw new Error(
      `runReport did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`,
    );
  }
}

describe("t186 engine-driven per-unit for_each iteration (issue #368)", () => {
  // 1: per-unit emission, functional-design in-flight, NO artifacts, units
  // [alpha, beta] -> a run-stage for the FIRST unit (alpha), the real unit name
  // substituted into the produces path (NOT the {unit-name} placeholder).
  test("1: per-unit stage with no artifacts emits the first unit with paths substituted", () => {
    const proj = seedProject("functional-design", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
    expect(d.unit).toBe("alpha");
    expect(d.produces).toContain(
      `${RP}/construction/alpha/functional-design/business-logic-model.md`,
    );
    // The literal placeholder is gone, the real unit was substituted.
    expect(d.produces?.some((p) => p.includes("{unit-name}"))).toBe(false);
  }, 30000);

  // 2: gate suppressed on a non-last unit, alpha + beta both uncovered, so
  // alpha is NOT the last uncovered -> directive.gate === false.
  test("2: gate is suppressed (false) on a non-last unit", () => {
    const proj = seedProject("functional-design", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    const d = runNext(proj);
    expect(d.unit).toBe("alpha");
    expect(d.gate).toBe(false);
  }, 30000);

  // 3: iteration advance, cover alpha's full produces[] on disk -> next emits
  // unit=beta (the engine walks to the next uncovered unit).
  test("3: covering the first unit advances the iteration to the next unit", () => {
    const proj = seedProject("functional-design", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", FD_REQUIRED_PRODUCES);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.unit).toBe("beta");
    expect(d.produces).toContain(
      `${RP}/construction/beta/functional-design/business-logic-model.md`,
    );
  }, 30000);

  // 4: gate STILL suppressed on the LAST uncovered unit. alpha covered, beta the
  // only uncovered unit -> directive.unit=beta AND directive.gate===false. The
  // gate does NOT fire here: beta's artifacts do not exist yet, so the engine
  // suppresses the gate on EVERY uncovered unit (closing the last-unit hole). The
  // real gate fires only on the all-covered re-entry (case 9).
  test("4: gate stays suppressed (false) on the last uncovered unit (its artifacts do not exist yet)", () => {
    const proj = seedProject("functional-design", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", FD_REQUIRED_PRODUCES);
    const d = runNext(proj);
    expect(d.unit).toBe("beta");
    expect(d.gate).toBe(false);
  }, 30000);

  // 5: degrade with no DAG, no runtime-graph.json -> the engine emits today's
  // single {unit-name} placeholder directive with NO `unit` field (unchanged
  // single-iteration behaviour).
  test("5: no compiled unit DAG degrades to the single {unit-name} placeholder, no unit field", () => {
    const proj = seedProject("functional-design", "on");
    // Deliberately NO seedBoltDag, there is no runtime-graph.json.
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
    expect(d.unit).toBeUndefined();
    expect(d.produces).toContain(
      `${RP}/construction/{unit-name}/functional-design/business-logic-model.md`,
    );
  }, 30000);

  // 6: coverage guard on report, approve with alpha + beta both uncovered ->
  // kind=error naming the remaining units; the transition is NOT committed.
  test("6: approving early while units remain is refused with an error naming them", () => {
    const proj = seedProject("functional-design", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    const d = runReport(proj, [
      "--stage",
      "functional-design",
      "--result",
      "approved",
    ]);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("functional-design");
    expect(d.message).toContain("alpha");
    expect(d.message).toContain("beta");
    expect(d.message).toContain("per-unit");
  }, 30000);

  // 6b: coverage guard refuses even when only the LAST unit is uncovered (the
  // strict all-units rule, not just >1). alpha covered, beta not -> approve is
  // refused naming beta. This is the deterministic close of the last-unit hole.
  test("6b: approving with only the last unit uncovered is still refused", () => {
    const proj = seedProject("functional-design", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", FD_REQUIRED_PRODUCES);
    const d = runReport(proj, [
      "--stage",
      "functional-design",
      "--result",
      "approved",
    ]);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("beta");
    expect(d.message).not.toContain("alpha"); // alpha is covered, not named
  }, 30000);

  // 7: single-row case, a NON-per-unit stage (application-design) still emits
  // with NO `unit` field and its normal gate, even with a bolt_dag present (the
  // per-unit path must not perturb the non-per-unit single-directive case).
  test("7: a non-per-unit stage emits no unit field and its normal gate", () => {
    const proj = seedProject("application-design", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("application-design");
    expect(d.unit).toBeUndefined();
    expect(d.produces?.some((p) => p.includes("/construction/"))).toBe(false);
  }, 30000);

  // 8: second inline per-unit stage (nfr-requirements) iterates the same way,
  // proves the loop is keyed on for_each, not the functional-design slug.
  test("8: nfr-requirements (another inline per-unit stage) also iterates per unit", () => {
    const proj = seedProject("nfr-requirements", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("nfr-requirements");
    expect(d.unit).toBe("alpha");
    expect(d.gate).toBe(false);
  }, 30000);

  // 9: all-covered settle. Both units covered on disk but the checkbox is still
  // in-flight -> next emits the LAST unit with the stage's REAL gate (true), so
  // the single human approval is presented only after every unit is built.
  test("9: with every unit covered, next presents the real gate on the last unit", () => {
    const proj = seedProject("functional-design", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", FD_REQUIRED_PRODUCES);
    coverUnit(proj, "beta", "functional-design", FD_REQUIRED_PRODUCES);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
    expect(d.unit).toBe("beta"); // the last unit in topo order
    expect(d.gate).toBe(true);
  }, 30000);

  // 9b: with every unit covered, the approve is ALLOWED (the guard passes) and
  // the transition commits (kind=done, not error).
  test("9b: approving once every unit is covered is allowed and commits", () => {
    const proj = seedProject("functional-design", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design", FD_REQUIRED_PRODUCES);
    coverUnit(proj, "beta", "functional-design", FD_REQUIRED_PRODUCES);
    const d = runReport(proj, [
      "--stage",
      "functional-design",
      "--result",
      "approved",
    ]);
    expect(d.kind).toBe("done");
  }, 30000);

  // 10: re-reporting an ALREADY-completed ([x]) per-unit stage with a DAG present
  // but its artifacts ABSENT (a fresh clone / moved files) must NOT be intercepted
  // by the per-unit coverage guard. The guard is scoped to `stageCheckbox.state
  // !== "completed"` (review change 2), so an already-[x] stage skips it and falls
  // through to the normal forward-transition path (kind=done, not error). This is
  // the load-bearing proof of that scoping: the negative control in case 6 shows
  // an uncovered, NOT-completed stage with the same DAG DOES error ("2 of 2 units
  // ..."), so the only thing suppressing the error here is the completed-state
  // scope. (Functional-design is [x] while Current Stage is nfr-requirements, so
  // report commits a forward advance for it; the point is purely that the guard
  // does not fire, not which forward branch handles it.)
  test("10: the coverage guard does not block reporting an already-completed per-unit stage", () => {
    const proj = seedProject("nfr-requirements", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    // Mark functional-design completed in the seeded state; no artifacts on disk.
    const statePath = seededStateFile(proj);
    const state = readFileSync(statePath, "utf-8").replace(
      "- [-] functional-design — EXECUTE",
      "- [x] functional-design — EXECUTE",
    );
    writeFileSync(statePath, state);
    const d = runReport(proj, [
      "--stage",
      "functional-design",
      "--result",
      "approved",
    ]);
    // The guard must not fire on a completed stage; report commits the forward
    // transition (a done directive), never a per-unit coverage error.
    expect(d.kind).not.toBe("error");
  }, 30000);

  // 11: skeleton-gate precedence. functional-design is the FIRST construction
  // stage for feature scope (the walking-skeleton gate stage). With NO Skeleton
  // Stance recorded, the engine must emit the unresolved-gate sentinel and the
  // single {unit-name} placeholder (NO per-unit iteration yet); per-unit
  // iteration only begins after the stance is classified.
  test("11: skeleton-unresolved gate pre-empts per-unit iteration", () => {
    const proj = seedProject("functional-design"); // NO skeleton stance
    seedBoltDag(proj, ["alpha", "beta"]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
    expect(d.gate).toBe("unresolved");
    expect(d.unit).toBeUndefined();
    expect(d.produces).toContain(
      `${RP}/construction/{unit-name}/functional-design/business-logic-model.md`,
    );
  }, 30000);

  // 12: non-autonomous code-generation (mode: subagent, the swarm stage) iterates
  // per unit when the swarm does NOT fire (no autonomy grant) -> the engine drives
  // the same per-unit loop. This is the issue's headline case. code-generation is
  // NOT the skeleton-gate stage for feature scope (functional-design is), so no
  // stance is needed for it.
  test("12: non-autonomous code-generation iterates per unit (the issue headline)", () => {
    const proj = seedProject("code-generation", "on");
    seedBoltDag(proj, ["alpha", "beta"]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("code-generation");
    expect(d.unit).toBe("alpha");
    expect(d.gate).toBe(false);
    expect(d.produces).toContain(
      `${RP}/construction/alpha/code-generation/code-generation-plan.md`,
    );
  }, 30000);

  // 13: a report arriving at an autonomous swarm's batch boundary must not
  // complete the whole stage. Only a valid DAG with current-run convergence
  // rows for every unit can receive the report-side disk-coverage exemption.
  const CG_PRODUCES = ["code-generation-plan", "code-summary"];
  test("13: autonomous multi-batch swarm refuses approval before every batch converges", () => {
    const proj = seedProject("code-generation", "on");
    // code-generation must be in-flight (not pending) for an approve to be valid;
    // flip its checkbox [-] and mark the upstream construction stages [x] so the
    // report lands on the approve path, not the "still pending" guard.
    const statePath = seededStateFile(proj);
    let state = readFileSync(statePath, "utf-8");
    for (const s of [
      "functional-design",
      "nfr-requirements",
      "nfr-design",
      "infrastructure-design",
    ]) {
      state = state.replace(`- [-] ${s} — EXECUTE`, `- [x] ${s} — EXECUTE`)
        .replace(`- [ ] ${s} — EXECUTE`, `- [x] ${s} — EXECUTE`);
    }
    state = state.replace(
      "- [ ] code-generation — EXECUTE",
      "- [-] code-generation — EXECUTE",
    );
    writeFileSync(statePath, state);
    seedBoltDagBatches(proj, [["alpha"], ["beta"]]);
    setAutonomous(proj);
    // First batch (alpha) merged its artifacts; beta (batch 2) not yet.
    coverUnit(proj, "alpha", "code-generation", CG_PRODUCES);
    // The swarm wrote real source for batch 1 outside the aidlc/ tree, so the
    // #366 workspace_requires guard (code-generation is a code-producing stage)
    // sees source work and lets the approve through. Orthogonal to the per-unit
    // coverage guard under test; without it the approve is refused for "no source
    // work" before reaching the coverage-guard path. (The suite harness also sets
    // AIDLC_SKIP_ARTIFACT_GUARD, so this only matters when the file runs bare.)
    mkdirSync(join(proj, "src", "alpha"), { recursive: true });
    writeFileSync(join(proj, "src", "alpha", "index.ts"), "export const x = 1;\n");
    // next emits the swarm directive for the first batch (proves the swarm path).
    const nd = runNext(proj);
    expect(nd.kind).toBe("invoke-swarm");
    // A stray report at the first batch boundary must fail closed rather than
    // marking the stage complete and skipping beta.
    const d = runReport(proj, [
      "--stage",
      "code-generation",
      "--result",
      "approved",
    ]);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("(beta)");
  }, 30000);
});
