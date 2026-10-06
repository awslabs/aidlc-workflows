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
// audit rows - two owners would re-fan already-built units). The per-stage
// approvals come due at the end of the walk once the whole (stage x unit)
// grid, code-generation included, is covered; with Unit checkpoints off they
// are one question (t-late-design-gates-one-approval pins that question).
//
// t209 pins the walk ordering + knob write path; t210 pins knob-off
// byte-equivalence and the swarm suppression + its negative control. THIS
// file pins the seams the widened block newly touches:
//   1. one late approval covering all five stages, in order, through to
//      Build and Test,
//   2. a lone Code Generation gate presenting on the last unit,
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

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  latestMainWorkflowStageRunFloorForProject,
  stateDigest,
  unitCompletedReceipts,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
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
const REVIEW_ARTIFACTS: Record<string, string> = {
  "functional-design": "functional-spec",
  "nfr-requirements": "security-requirements",
  "nfr-design": "security-design",
  "infrastructure-design": "cicd-pipeline",
  "code-generation": "code-generation-plan",
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
      join(seededRecordDir(proj), ".aidlc-engine/active-directive.json"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

function runReport(proj: string, args: string[]): Directive {
  const r = spawnSync(BUN, [ORCH, "report", ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: (() => {
      const e: NodeJS.ProcessEnv = {
        ...process.env,
        // This routing fixture is intentionally not a Git checkout. Source
        // freshness is exercised end to end by t314; keep this test scoped to
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
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

// A Unit's built Code Generation step: a ready plan beside its instructions,
// and the start and completion receipts the build records in this attempt
// (seeded at the stage's run floor, as case 1 seeds swarm convergence).
function buildUnit(proj: string, unit: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, "code-generation");
  writeFileSync(
    join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Steps\n\n- [x] Step 1: build `src/" + unit + ".ts`\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
  );
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun the tests.\n");
  const floor = latestMainWorkflowStageRunFloorForProject(proj, "code-generation", true, unit);
  for (const event of ["UNIT_STARTED", "UNIT_COMPLETED"]) {
    appendAuditEntry(event, { Stage: "code-generation", Unit: unit, "Run floor": floor }, proj);
  }
}

function logReviewReady(proj: string, stage: string, unit: string): void {
  const reviewer = "aidlc-architecture-reviewer-agent";
  const iteration = 1;
  const reviewArtifact = REVIEW_ARTIFACTS[stage];
  if (!reviewArtifact) throw new Error(`no review artifact fixture for ${stage}`);
  const artifact = join(
    seededRecordDir(proj),
    "construction",
    unit,
    stage,
    artifactFilename(reviewArtifact),
  );
  if (stage === "code-generation") {
    const dir = join(seededRecordDir(proj), "construction", unit, stage);
    writeFileSync(
      join(dir, "source-manifest.json"),
      `${JSON.stringify({ stage, unit, version: 1, writes: [] }, null, 2)}\n`,
    );
  }
  const args = [
    LOG,
    "review",
    "--stage", stage,
    "--reviewer", reviewer,
    "--unit", unit,
    "--iteration", String(iteration),
    "--project-dir", proj,
  ];
  const env = {
    ...process.env,
    AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
  };
  const request = spawnSync(BUN, args, { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
  if ((request.status ?? -1) !== 0) {
    throw new Error(`review request failed: ${request.stdout ?? ""}${request.stderr ?? ""}`);
  }
  appendFileSync(
    artifact,
    "\n## Review\n\n" +
      "**Verdict:** READY\n" +
      `**Reviewer:** ${reviewer}\n` +
      `**Iteration:** ${iteration}\n\n` +
      "### Findings\n\nNo blocking findings.\n",
    "utf-8",
  );
  const verdict = spawnSync(BUN, [...args, "--verdict", "READY"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  if ((verdict.status ?? -1) !== 0) {
    throw new Error(`review verdict failed: ${verdict.stdout ?? ""}${verdict.stderr ?? ""}`);
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
  });

  // 1: the late approvals are ONE question for all five stages. From a
  // fully-covered grid (code-gen included) the first gate lists them, on the
  // last unit, and one approval approves them in order.
  test("1: one late approval covers the five stages and the work moves on to Build and Test", () => {
    const proj = seedProject();
    seedBoltDag(proj, ["alpha", "beta"]);
    coverFullGrid(proj, ["alpha", "beta"]);
    for (const unit of ["alpha", "beta"]) {
      for (const stage of BLOCK) logReviewReady(proj, stage, unit);
    }

    const gate = runNext(proj);
    expect(gate).toMatchObject({ kind: "run-stage", stage: "functional-design", gate: true, unit: "beta" });
    expect((gate.approve_together as { stages: { slug: string }[] }).stages.map((s) => s.slug)).toEqual(BLOCK);
    const done = runReport(proj, ["--stage", "functional-design", "--result", "approved"]);
    expect(done.kind).toBe("done");

    // The workflow has left the per-unit block entirely.
    const next = runNext(proj);
    expect(next.stage).toBe("build-and-test");
  });

  test("5: once every Unit is built, the last Code Generation gate never asks about a plan again", () => {
    const sep = "\u2014";
    const proj = seedProject({
      current: "code-generation",
      checkboxes: [
        "- [x] functional-design", "- [x] nfr-requirements", "- [x] nfr-design",
        "- [x] infrastructure-design", "- [-] code-generation", "- [ ] build-and-test",
      ].map((row) => `${row} ${sep} EXECUTE`).join("\n"),
    });
    seedBoltDag(proj, ["alpha", "beta"]);
    coverFullGrid(proj, ["alpha", "beta"]);
    for (const unit of ["alpha", "beta"]) {
      for (const stage of BLOCK) logReviewReady(proj, stage, unit);
      buildUnit(proj, unit);
    }
    expect([...unitCompletedReceipts(proj, "code-generation")].sort()).toEqual(["alpha", "beta"]);
    const last = runNext(proj);
    expect(last).toMatchObject({
      kind: "run-stage", stage: "code-generation", gate: true, unit: "beta", build_settled: true,
    });
    expect(last.plan_approval).toBeUndefined();
    expect(last.ask_type).toBeUndefined();
  });

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
  });

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
    expect(d.message).toContain("work items are not complete");
  });

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
      state_sha256: stateDigest(state),
      delivery: "issued",
      needs_rehydrate: false,
      context_epoch: 0,
      stop_count: 0,
    });
  });
});
