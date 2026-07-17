// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-state:set-construction-iteration
//
// CLI-contract test for opt-in UNIT-MAJOR construction design iteration.
// mechanism = cli.
//
// THE FEATURE: by default the engine walks the inline per-unit Construction
// DESIGN stages stage-major (functional-design for every unit, then
// nfr-requirements for every unit, ...). When the state file records
// `Construction Iteration: unit-major` under `## Runtime State`, the engine
// walks unit-major instead: for each unit in Bolt build order (outer), for each
// design stage in graph order (inner), it emits the FIRST uncovered (stage, unit)
// pair with the gate suppressed (false), so one unit's four design documents are
// authored consecutively before the next unit begins. The four per-stage gates
// are UNCHANGED: they fire late, in stage order, once the whole (stage x unit)
// grid is covered (the fully-covered walk delegates to the stage-major
// pick === null branch, presenting the current stage's real gate on the last
// unit; handleApprove then advances to the next design stage, whose next re-emits
// its gate, so the four gates cascade). code-generation (mode: subagent) is never
// part of this walk. The early-approve per-unit coverage guard is unchanged.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   - readConstructionIteration (strict read; only "unit-major" activates it),
//     constructionDesignBlock, emitUnitMajorRunStage, and the emitForSlug routing
//     branch (inline + unit-major -> emitUnitMajorRunStage).
//   - aidlc-state.ts set-construction-iteration (the knob's write path).
// NONE are exported (the tools have zero exports), so the behaviour is observable
// only on the JSON directive the spawned engine emits, MECHANISM = cli: SPAWN
// `bun aidlc-orchestrate.ts next|report` / `bun aidlc-state.ts
// set-construction-iteration` and assert on the parsed output, the SAME process
// boundary t186 (per-unit iteration) drives.
//
// FIXTURE DISCIPLINE (mirrors t186): each case uses a FRESH temp project. We
// write a CLEAN single-row-per-slug Construction state pivoted to
// functional-design with its checkbox in-flight ([-]), the `Skeleton Stance`
// recorded so the feature-scope skeleton gate resolves, the
// `Construction Iteration: unit-major` field under `## Runtime State`, and a
// bolt_dag runtime-graph.json with units [alpha, beta]. Per-unit artifact dirs
// are seeded to control coverage. All temp dirs are cleaned in afterEach.

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
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");

// The record-relative prefix every resolved per-unit path is rooted at.
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;

// Each inline design stage's produces[] (verified frontmatter). A unit is
// "covered" for a stage once all of its produces exist on disk.
const PRODUCES: Record<string, string[]> = {
  "functional-design": [
    "business-logic-model",
    "business-rules",
    "domain-entities",
    "frontend-components",
  ],
  "nfr-requirements": [
    "performance-requirements",
    "security-requirements",
    "scalability-requirements",
    "reliability-requirements",
    "tech-stack-decisions",
  ],
  "nfr-design": [
    "performance-design",
    "security-design",
    "scalability-design",
    "reliability-design",
    "logical-components",
  ],
  "infrastructure-design": [
    "deployment-architecture",
    "infrastructure-services",
    "monitoring-design",
    "cicd-pipeline",
    "shared-infrastructure",
  ],
};
// The four inline design stages, in graph order (the walk's inner list).
const BLOCK = [
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
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
 * A CLEAN Construction-phase state file pivoted to functional-design, in-flight.
 * `skeletonStance` records the resolved walking-skeleton stance so the
 * feature-scope skeleton-gate stage emits a boolean gate. `iteration`, when set,
 * writes the `Construction Iteration` field under a `## Runtime State` section.
 */
function constructionState(opts: {
  skeletonStance?: string;
  iteration?: string;
}): string {
  const stanceLine = opts.skeletonStance
    ? `- **Skeleton Stance**: ${opts.skeletonStance}\n`
    : "";
  // Mirror the real state template: a `## Runtime State` section always ships
  // (with Revision Count), so setOrInsertField updates-in-place. Construction
  // Iteration is appended only when the case sets it.
  const iterationLine = opts.iteration
    ? `- **Construction Iteration**: ${opts.iteration}\n`
    : "";
  return `# AI-DLC State Tracking

## Project Information
- **Project**: unit-major iteration test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7
${stanceLine}
## Runtime State
- **Revision Count**: 0
${iterationLine}
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
- **Current Stage**: functional-design
- **Status**: Running
`;
}

/** Mark `unit` COVERED for `slug` by writing each of its produces artifacts. */
function coverUnit(proj: string, unit: string, slug: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of PRODUCES[slug]) {
    writeFileSync(join(dir, `${name}.md`), `# ${name} for ${unit}\n`);
  }
}

/** Cover every (block stage x unit) pair (the fully-covered design grid). */
function coverFullGrid(proj: string, units: string[]): void {
  for (const u of units) for (const s of BLOCK) coverUnit(proj, u, s);
}

/** Seed a fresh unit-major Construction project. Returns the proj dir. */
function seedProject(iteration?: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(
    seededStateFile(proj),
    constructionState({ skeletonStance: "on", iteration }),
  );
  return proj;
}

interface NextRun {
  directive: Directive;
  stderr: string;
}

/** Run `aidlc-orchestrate.ts next`, capturing both its directive and diagnostics. */
function runNextWithStderr(proj: string): NextRun {
  const r = spawnSync(BUN, [ORCH, "next", "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  try {
    return {
      directive: JSON.parse((r.stdout ?? "").trim()) as Directive,
      stderr: r.stderr ?? "",
    };
  } catch {
    throw new Error(
      `runNext did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`,
    );
  }
}

function runNext(proj: string): Directive {
  return runNextWithStderr(proj).directive;
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

/** Run `aidlc-state.ts set-construction-iteration <value>`; return rc + output. */
function setIteration(proj: string, value: string): { rc: number; out: string } {
  const r = spawnSync(
    BUN,
    [STATE, "set-construction-iteration", value, "--project-dir", proj],
    { encoding: "utf-8", env: process.env },
  );
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function seedStaleKindDependency(proj: string): void {
  writeFileSync(
    join(seededRecordDir(proj), "runtime-graph.json"),
    `${JSON.stringify({ stages: [] }, null, 2)}\n`,
  );
  const dir = join(seededRecordDir(proj), "inception", "units-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "unit-of-work-dependency.md"),
    [
      "# Unit of Work Dependency",
      "",
      "```yaml",
      "units:",
      "  - name: contract",
      "    kind: spec",
      "    depends_on: []",
      "```",
      "",
    ].join("\n"),
  );
}

describe("t209 opt-in unit-major construction design iteration", () => {
  // 1: empty coverage under unit-major -> the walk starts at the first unit, first
  // block stage: functional-design/alpha, gate suppressed.
  test("1: empty grid emits functional-design/alpha, gate false", () => {
    const proj = seedProject("unit-major");
    seedBoltDag(proj, ["alpha", "beta"]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
    expect(d.unit).toBe("alpha");
    expect(d.gate).toBe(false);
  }, 30000);

  // 2: THE PIVOTAL ORDERING ASSERTION. With functional-design/alpha covered, the
  // unit-major walk stays on alpha and moves to the NEXT block stage
  // (nfr-requirements/alpha), NOT functional-design/beta (which is what
  // stage-major would emit). One unit's design documents are authored
  // consecutively.
  test("2: fd/alpha covered emits nfr-requirements/alpha (not functional-design/beta)", () => {
    const proj = seedProject("unit-major");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design");
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("nfr-requirements");
    expect(d.unit).toBe("alpha");
    expect(d.gate).toBe(false);
    expect(d.produces).toContain(
      `${RP}/construction/alpha/nfr-requirements/performance-requirements.md`,
    );
  }, 30000);

  // 3: only after alpha is covered for ALL FOUR block stages does the walk move to
  // the next unit: functional-design/beta.
  test("3: alpha covered for all four block stages emits functional-design/beta", () => {
    const proj = seedProject("unit-major");
    seedBoltDag(proj, ["alpha", "beta"]);
    for (const s of BLOCK) coverUnit(proj, "alpha", s);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
    expect(d.unit).toBe("beta");
    expect(d.gate).toBe(false);
  }, 30000);

  // 4: with the whole (stage x unit) grid covered, the fully-covered walk
  // delegates to the stage-major pick === null branch for the CURRENT stage
  // (functional-design), presenting its REAL gate on the last unit (beta). This is
  // the start of the late gate cascade.
  test("4: full grid presents functional-design's real gate on the last unit", () => {
    const proj = seedProject("unit-major");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverFullGrid(proj, ["alpha", "beta"]);
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
    expect(d.unit).toBe("beta");
    expect(d.gate).toBe(true);
  }, 30000);

  // 5: the early-approve coverage guard is unchanged. With beta uncovered,
  // approving functional-design is refused by the existing per-unit guard.
  test("5: early approve while a unit is uncovered is refused", () => {
    const proj = seedProject("unit-major");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "functional-design");
    const d = runReport(proj, [
      "--stage",
      "functional-design",
      "--result",
      "approved",
    ]);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("functional-design");
    expect(d.message).toContain("beta");
    expect(d.message).toContain("per-unit");
  }, 30000);

  // 6: revision re-entry. From a fully-covered grid, deleting one artifact of
  // nfr-design/alpha leaves the grid uncovered again; the next `next` re-enters the
  // walk and emits EXACTLY that uncovered pair (nfr-design/alpha), gate false.
  test("6: a revision that uncovers nfr-design/alpha re-emits exactly that pair", () => {
    const proj = seedProject("unit-major");
    seedBoltDag(proj, ["alpha", "beta"]);
    coverFullGrid(proj, ["alpha", "beta"]);
    // Remove one produces artifact of nfr-design/alpha (overwrite the dir with a
    // partial set): rewrite it with all but the first artifact missing.
    const dir = join(seededRecordDir(proj), "construction", "alpha", "nfr-design");
    // Delete one file by rewriting the directory contents minus one artifact.
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(join(dir, `${PRODUCES["nfr-design"][0]}.md`));
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("nfr-design");
    expect(d.unit).toBe("alpha");
    expect(d.gate).toBe(false);
  }, 30000);

  // 7a: subcommand validation, a bogus value is rejected with a non-zero exit.
  test("7a: set-construction-iteration rejects an invalid value", () => {
    const proj = seedProject();
    const r = setIteration(proj, "bogus");
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Invalid construction iteration");
  }, 30000);

  // 7b: subcommand write: set-construction-iteration unit-major writes the field
  // under ## Runtime State, and the engine then walks unit-major (fd/alpha covered
  // -> nfr-requirements/alpha, the pivotal order), proving the round-trip.
  test("7b: set-construction-iteration unit-major writes the field and activates the walk", () => {
    const proj = seedProject(); // no field yet
    seedBoltDag(proj, ["alpha", "beta"]);
    const r = setIteration(proj, "unit-major");
    expect(r.rc).toBe(0);
    const state = readFileSync(seededStateFile(proj), "utf-8");
    expect(state).toContain("- **Construction Iteration**: unit-major");
    coverUnit(proj, "alpha", "functional-design");
    const d = runNext(proj);
    expect(d.stage).toBe("nfr-requirements");
    expect(d.unit).toBe("alpha");
  }, 30000);

  test("8: stale DAG healing preserves unit kinds and warns exactly once per next", () => {
    const proj = seedProject("unit-major");
    seedStaleKindDependency(proj);

    const run = runNextWithStderr(proj);
    const d = run.directive;
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
    expect(d.unit).toBe("contract");
    expect(d.gate).toBe(false);

    // A spec unit owes business rules and domain entities, but not the
    // service/ui-only functional-design artifacts. The kind comes from the
    // dependency artifact because the cached graph deliberately has no DAG.
    expect(d.produces).toContain(
      `${RP}/construction/contract/functional-design/business-rules.md`,
    );
    expect(d.produces).toContain(
      `${RP}/construction/contract/functional-design/domain-entities.md`,
    );
    expect(d.produces?.some((path) => path.endsWith("/business-logic-model.md"))).toBe(false);
    expect(d.produces?.some((path) => path.endsWith("/frontend-components.md"))).toBe(false);

    const warning =
      "runtime-graph.json has no bolt_dag; recomputed 1 unit batch(es)";
    expect(run.stderr.split(warning).length - 1).toBe(1);
  }, 30000);
});
