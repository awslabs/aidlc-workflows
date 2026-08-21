// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, function:writeActiveDirectiveMarker
//
// CLI-contract test for code-generation JOINING the unit-major walk (the
// deferred follow-up of the original unit-major increment: "widening the
// walk's block filter"). mechanism = cli.
//
// THE FEATURE: under `Construction Iteration: unit-major`, the walk's inner
// block is now EVERY in-scope per-unit Construction stage in graph order -
// the four inline design stages plus code-generation (mode: subagent). For
// each unit in Bolt DAG topo order, the engine emits design 3.1-3.4 then
// code-generation for THAT unit before the next unit begins, so the first
// working code lands after ONE unit's design documents, not after every
// unit's. The autonomous swarm never fires under unit-major (the walk owns
// the build; its coverage signal is DISK, the swarm's is SWARM_UNIT_CONVERGED
// audit rows - two owners would re-fan already-built units). Gate machinery
// is unchanged: the per-stage gates cascade at the end of the walk once the
// whole (stage x unit) grid, code-generation included, is covered.
//
// t209 pins the walk ordering + knob write path; t210 pins knob-off
// byte-equivalence and the swarm suppression + its negative control. THIS
// file pins the seams the widened block newly touches:
//   1. the full five-gate cascade order across report approvals,
//   2. code-generation's own gate presenting LAST, on the last unit,
//   3. a degenerate scope whose per-unit block is code-generation ONLY
//      (poc-like: every design stage skipped) still walks correctly,
//   4. the early-approve guard extends to code-generation coverage,
//   5. a revision that uncovers only code-generation/alpha re-enters the walk
//      at exactly that pair.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-orchestrate.ts):
// constructionUnitMajorBlock (no mode filter), emitUnitMajorRunStage, the
// emitForSlug unit-major branch (no inline test), and
// eligibleAutonomousSwarmBatches's unit-major refusal. NONE are exported, so
// behaviour is observed on the JSON directives of the spawned engine - the
// same process boundary t209/t210 drive.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { artifactFilename } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;

// Each per-unit construction stage's produces[] (verified frontmatter).
const PRODUCES: Record<string, string[]> = {
  "functional-design": [
    "entities",
    "rules",
    "functional-spec",
    "frontend-components",
    "traceability",
  ],
  "nfr-requirements": [
    "performance-requirements",
    "security-requirements",
    "scalability-requirements",
    "reliability-requirements",
    "observability-requirements",
    "tech-stack-decisions",
    "traceability",
  ],
  "nfr-design": [
    "performance-design",
    "security-design",
    "scalability-design",
    "reliability-design",
    "observability-design",
    "logical-components",
    "traceability",
  ],
  "infrastructure-design": [
    "infrastructure-specification",
    "monitoring-design",
    "cicd-pipeline",
    "traceability",
  ],
  "code-generation": [
    "code-generation-plan",
    "unit-test-instructions",
    "code-summary",
    "traceability",
  ],
};
// The widened walk block, graph order: design stages then code-generation.
const BLOCK = [
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
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
 * A CLEAN Construction-phase state file under unit-major. `current` pivots
 * Current Stage; `checkboxes` overrides the per-stage checkbox rows (default:
 * functional-design in-flight, the rest pending). Mirrors t209's fixture.
 */
function constructionState(opts: {
  current?: string;
  checkboxes?: string;
}): string {
  const checkboxes =
    opts.checkboxes ??
    `- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE`;
  return `# AI-DLC State Tracking

## Project Information
- **Project**: unit-major code-gen test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
${checkboxes}

### INCEPTION PHASE
- [-] domain-design — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${opts.current ?? "functional-design"}
- **Status**: Running
`;
}

function coverUnit(proj: string, unit: string, slug: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of PRODUCES[slug]) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${name} for ${unit}\n`);
  }
}

function coverFullGrid(proj: string, units: string[]): void {
  for (const u of units) for (const s of BLOCK) coverUnit(proj, u, s);
}

function seedProject(opts: { current?: string; checkboxes?: string } = {}): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), constructionState(opts));
  return proj;
}

function runNext(proj: string): Directive {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = runOrchestrateNext(ORCH, proj, [], { env });
  if (r.directive === null) {
    throw new Error(
      `runNext did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`,
    );
  }
  return r.directive as Directive;
}

function activeDirectiveMarker(proj: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(seededRecordDir(proj), ".aidlc-active-directive.json"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

function runReport(proj: string, args: string[]): Directive {
  const r = spawnSync(BUN, [ORCH, "report", ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e: NodeJS.ProcessEnv = {
        ...process.env,
        // This routing fixture is intentionally not a Git checkout. Source
        // freshness is exercised end to end by t304; keep this test scoped to
        // the unit-major cascade instead of minting unbindable review receipts.
        AIDLC_SKIP_SOURCE_FRESHNESS: "1",
      };
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

function runStatusSync(proj: string, stage: string): void {
  const r = spawnSync(
    BUN,
    [UTILITY, "set-status", "--stage", stage, "--project-dir", proj],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_STATUSLINE_OWNER: `statusline:${process.pid}`,
      },
    },
  );
  if ((r.status ?? -1) !== 0) {
    throw new Error(`status sync failed: ${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
}

function logReviewReady(proj: string, stage: string, unit: string): void {
  const args = [
    LOG,
    "review",
    "--stage", stage,
    "--reviewer", "aidlc-architecture-reviewer-agent",
    "--unit", unit,
    "--iteration", "1",
    "--project-dir", proj,
  ];
  for (const suffix of [[], ["--verdict", "READY"]]) {
    const r = spawnSync(BUN, [...args, ...suffix], { encoding: "utf-8" });
    if ((r.status ?? -1) !== 0) {
      throw new Error(`review log failed: ${r.stdout ?? ""}${r.stderr ?? ""}`);
    }
  }
}

describe("t272 code-generation joins the unit-major walk", () => {
  test("task sync preserves the first-stage cursor, so the completed grid starts at its gate", () => {
    const proj = seedProject();
    seedBoltDag(proj, ["alpha"]);

    for (const stage of BLOCK) {
      const directive = runNext(proj);
      expect(directive.stage).toBe(stage);
      expect(directive.unit).toBe("alpha");
      runStatusSync(proj, stage);
      expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
        "- **Current Stage**: functional-design",
      );
      coverUnit(proj, "alpha", stage);
      logReviewReady(proj, stage, "alpha");
    }

    const gate = runNext(proj);
    expect(gate.stage).toBe("functional-design");
    expect(gate.gate).toBe(true);
  }, 60000);

  // 1: the full gate cascade is FIVE stages long and ends on code-generation.
  // From a fully-covered grid (code-gen included), approving each stage in
  // order walks Current Stage down the block; each intermediate `next`
  // presents the NEXT stage's real gate, and code-generation's gate is the
  // last of the cascade, presented on the last unit.
  test("1: five-gate cascade ends with code-generation's gate on the last unit", () => {
    const proj = seedProject();
    seedBoltDag(proj, ["alpha", "beta"]);
    coverFullGrid(proj, ["alpha", "beta"]);
    for (const unit of ["alpha", "beta"]) {
      for (const stage of BLOCK) logReviewReady(proj, stage, unit);
    }

    // The first fully-covered next presents functional-design's gate (t209
    // case 4 shape); approve the four design stages in cascade order.
    for (const stage of BLOCK.slice(0, 4)) {
      const gate = runNext(proj);
      expect(gate.kind).toBe("run-stage");
      expect(gate.stage).toBe(stage);
      expect(gate.gate).toBe(true);
      expect(gate.unit).toBe("beta");
      const after = runReport(proj, ["--stage", stage, "--result", "approved"]);
      expect(after.kind).not.toBe("error");
    }

    // The cascade's fifth and final gate: code-generation, real gate, last unit.
    const last = runNext(proj);
    expect(last.kind).toBe("run-stage");
    expect(last.stage).toBe("code-generation");
    expect(last.gate).toBe(true);
    expect(last.unit).toBe("beta");
    const settled = runReport(proj, [
      "--stage", "code-generation", "--result", "approved",
    ]);
    expect(settled.kind).not.toBe("error");

    // Post-cascade the workflow has left the per-unit block entirely.
    const next = runNext(proj);
    expect(next.stage).toBe("build-and-test");
  }, 60000);

  // 2: a degenerate block - every design stage completed ([x]) leaves
  // code-generation as the ONLY active block stage. The walk emits per-unit
  // code-generation directives in DAG order with the gate suppressed, exactly
  // like the stage-major per-unit path would (the walk degenerates cleanly).
  test("2: design stages all [x] leaves a code-generation-only walk", () => {
    const proj = seedProject({
      current: "code-generation",
      checkboxes: `- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE`,
    });
    seedBoltDag(proj, ["alpha", "beta"]);
    coverUnit(proj, "alpha", "code-generation");
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("code-generation");
    expect(d.unit).toBe("beta");
    expect(d.gate).toBe(false);
  }, 30000);

  // 3: the early-approve coverage guard covers code-generation. With beta's
  // code-generation uncovered (design grid complete), approving
  // code-generation is refused by the existing per-unit guard.
  test("3: early approve with beta's code-generation uncovered is refused", () => {
    const proj = seedProject({ current: "code-generation" });
    seedBoltDag(proj, ["alpha", "beta"]);
    coverFullGrid(proj, ["alpha"]);
    for (const s of BLOCK.slice(0, 4)) coverUnit(proj, "beta", s);
    const d = runReport(proj, [
      "--stage", "code-generation", "--result", "approved",
    ]);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("code-generation");
    expect(d.message).toContain("beta");
    expect(d.message).toContain("per-unit");
  }, 30000);

  // 4: revision re-entry through the widened block. From a fully-covered
  // grid, deleting one code-generation/alpha artifact re-enters the walk at
  // exactly (code-generation, alpha), gate suppressed - the same re-entry
  // t209 case 6 pins for a design stage.
  test("4: a revision that uncovers code-generation/alpha re-emits exactly that pair", () => {
    const proj = seedProject();
    seedBoltDag(proj, ["alpha", "beta"]);
    coverFullGrid(proj, ["alpha", "beta"]);
    const dir = join(
      seededRecordDir(proj), "construction", "alpha", "code-generation",
    );
    rmSync(join(dir, "code-summary.md"));
    const d = runNext(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("code-generation");
    expect(d.unit).toBe("alpha");
    expect(d.gate).toBe(false);
    expect(d.produces).toContain(
      `${RP}/construction/alpha/code-generation/code-summary.md`,
    );
    const state = readFileSync(seededStateFile(proj), "utf-8");
    expect(state).toContain("- **Current Stage**: functional-design");
    expect(activeDirectiveMarker(proj)).toMatchObject({
      version: 2,
      kind: "run-stage",
      stage: "code-generation",
      unit: "alpha",
      state_sha256: createHash("sha256").update(state, "utf-8").digest("hex"),
      delivery: "issued",
      needs_rehydrate: false,
      context_epoch: 0,
      stop_count: 0,
    });
  }, 30000);
});
