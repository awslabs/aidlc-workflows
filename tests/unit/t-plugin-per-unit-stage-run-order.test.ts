// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-state:lookup, subcommand:aidlc-graph:compile, function:stageRouteOrder, function:nextInScopeStage
//
// A plugin's per-Unit Construction stage runs with its Unit, wherever the
// compile numbers it. compileStageGraph numbers a new stage past its phase's
// highest number, so a plugin stage that runs per Unit right after Code
// Generation is 3.8, after Build and Test (3.6) and CI Pipeline (3.7). The
// routing walked graph-number order: the team fold moved from the last per-Unit
// stage to the plugin's once-per-intent stage and never ran Build and Test, solo
// work approved Code Generation and then ran Build and Test before the plugin
// stage's approval, and the next-stage hints named the graph neighbour. The
// compile now writes the graph in stageRouteOrder: each phase's per-Unit stages
// as one block.
//
// Mechanism: cli. Each case copies the built Claude install into a temp
// project, adds the two plugin stages the way a plugin's compose does, compiles
// the graph with that install's own compile (which seeds 3.8 and 3.9), and
// drives that install's tools.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
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
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);
resetAidlcEnv();

const BUN = process.execPath;
const SEP = "—";

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_SOURCE_FRESHNESS: "1",
};
for (const key of ["AWS_AIDLC_DEFAULT_SCOPE", "AIDLC_STAGE_GRAPH", "AIDLC_SCOPE_GRID", "AIDLC_SCOPE_MAPPING"]) {
  delete ENV[key];
}
// Run inside Claude Code, the host's session would make the simulated reviews
// read as verdicts no reviewer finished, which adds a notice line to `next`.
for (const key of Object.keys(ENV)) if (key.startsWith("CLAUDE")) delete ENV[key];

const PLUGIN_STAGES: Record<string, string> = {
  "probe-unit-check": `---
slug: probe-unit-check
number: 3.55
name: Probe Unit Check
plugin: probe
phase: construction
execution: ALWAYS
condition: Always executes for every unit, right after its Code Generation.
lead_agent: aidlc-developer-agent
support_agents: []
mode: inline
for_each: unit-of-work
produces:
  - probe-unit-check-report
consumes:
  - artifact: code-summary
    required: false
requires_stage:
  - code-generation
sensors: []
scopes:
  - feature
inputs: The Unit's code summary
outputs: probe-unit-check-report.md (under this stage's record dir, engine-resolved)
---

# Probe Unit Check

Write \`probe-unit-check-report.md\` naming the Unit checked.
`,
  "probe-intent-check": `---
slug: probe-intent-check
number: 3.65
name: Probe Intent Check
plugin: probe
phase: construction
execution: ALWAYS
condition: Always executes once after Build and Test.
lead_agent: aidlc-developer-agent
support_agents: []
mode: inline
produces:
  - probe-intent-check-report
consumes:
  - artifact: build-and-test-summary
    required: false
requires_stage:
  - build-and-test
sensors: []
scopes:
  - feature
inputs: Build and Test summary
outputs: probe-intent-check-report.md (under this stage's record dir, engine-resolved)
---

# Probe Intent Check

Write \`probe-intent-check-report.md\`.
`,
};

const PRODUCES: Record<string, string[]> = {
  "code-generation": ["code-generation-plan", "unit-test-instructions", "code-summary", "traceability"],
  "probe-unit-check": ["probe-unit-check-report"],
};
const BLOCK = ["code-generation", "probe-unit-check"];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  next_stage?: string | null;
  reviewer?: string;
  message?: string;
  [key: string]: unknown;
}

interface Install {
  proj: string;
  tool: (name: string) => string;
}

// A project with its own copy of the install, the plugin stages composed in.
function probeProject(ownership: "team" | "solo", units: string[]): Install {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  const harness = join(proj, ".claude");
  cpSync(AIDLC_SRC, harness, { recursive: true });
  for (const [slug, body] of Object.entries(PLUGIN_STAGES)) {
    writeFileSync(join(harness, "aidlc-common", "stages", "construction", `${slug}.md`), body);
  }
  const tool = (name: string) => join(harness, "tools", `${name}.ts`);
  const compiled = spawnSync(BUN, [tool("aidlc-graph"), "compile"], {
    cwd: proj,
    encoding: "utf-8",
    env: ENV,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  if (compiled.status !== 0) throw new Error(`compile failed: ${compiled.stdout}${compiled.stderr}`);
  const rows = [
    ...["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"].map(
      (slug) => `- [S] ${slug} ${SEP} SKIP`,
    ),
    `- [-] code-generation ${SEP} EXECUTE`,
    `- [ ] build-and-test ${SEP} EXECUTE`,
    `- [ ] ci-pipeline ${SEP} EXECUTE`,
    `- [ ] probe-unit-check ${SEP} EXECUTE`,
    `- [ ] probe-intent-check ${SEP} EXECUTE`,
  ];
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: plugin per-Unit stage route test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on
- **Unit Ownership**: ${ownership}

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Plan Approval**: off (set by you)

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
${rows.join("\n")}

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
- **Last Updated**: 2026-10-20T00:00:00Z
`);
  seedBoltDag(proj, units);
  return { proj, tool };
}

function run(install: Install, name: string, args: string[]): { rc: number; out: string } {
  const result = spawnSync(BUN, [install.tool(name), ...args, "--project-dir", install.proj], {
    encoding: "utf-8",
    env: ENV,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { rc: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function next(install: Install): Directive {
  const result = runOrchestrateNext(install.tool("aidlc-orchestrate"), install.proj, [], { env: ENV });
  if (!result.directive) throw new Error(`next failed: ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.directive as Directive;
}

function report(install: Install, args: string[]): Directive {
  const { out } = run(install, "aidlc-orchestrate", ["report", ...args]);
  try {
    return JSON.parse(out.trim()) as Directive;
  } catch {
    throw new Error(`report failed: ${out}`);
  }
}

function state(install: Install): string {
  return readFileSync(seededStateFile(install.proj), "utf-8");
}

function cover(install: Install, unit: string, stage: string): void {
  const dir = join(seededRecordDir(install.proj), "construction", unit, stage);
  mkdirSync(dir, { recursive: true });
  for (const artifact of PRODUCES[stage]) {
    writeFileSync(join(dir, artifactFilename(artifact)), `# ${artifact} for ${unit}\n`);
  }
  if (stage === "code-generation") {
    writeFileSync(
      join(dir, artifactFilename("code-generation-plan")),
      `# Plan for ${unit}\n\n## Steps\n\n- [x] Step 1: build \`src/${unit}.ts\`\n\n` +
        renderTestingContract(resolveTestingPosture(install.proj)),
    );
    writeFileSync(
      join(dir, "source-manifest.json"),
      `${JSON.stringify({ stage, unit, version: 1, writes: [] }, null, 2)}\n`,
    );
  }
}

// The reviewer's READY verdict for one Unit's stage, through the review tool.
function reviewReady(install: Install, stage: string, unit: string, reviewer: string): void {
  const base = ["review", "--stage", stage, "--reviewer", reviewer, "--unit", unit, "--iteration", "1"];
  let request = run(install, "aidlc-log", base);
  if (request.rc !== 0) throw new Error(`review request failed: ${request.out}`);
  // The stage's checks run before its first review request and say what they
  // found; the same request again records it.
  if ((JSON.parse(request.out) as { kind?: string }).kind === "print") request = run(install, "aidlc-log", base);
  const { reviewFile } = JSON.parse(request.out) as { reviewFile: string };
  appendFileSync(
    join(install.proj, reviewFile),
    `**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`,
  );
  const verdict = run(install, "aidlc-log", [...base, "--verdict", "READY"]);
  if (verdict.rc !== 0) throw new Error(`review verdict failed: ${verdict.out}`);
}

describe("a plugin's per-Unit stage numbered after Build and Test runs with its Unit", () => {
  test("the compile keeps its number, and writes the graph with it in the per-Unit block", () => {
    const install = probeProject("solo", ["alpha"]);
    const graph = JSON.parse(
      readFileSync(join(install.proj, ".claude", "tools", "data", "stage-graph.json"), "utf-8"),
    ) as Array<{ slug: string; number: string; phase: string }>;
    const number = (slug: string) => graph.find((stage) => stage.slug === slug)?.number;
    expect([number("build-and-test"), number("ci-pipeline"), number("probe-unit-check"), number("probe-intent-check")])
      .toEqual(["3.6", "3.7", "3.8", "3.9"]);
    expect(graph.filter((stage) => stage.phase === "construction").map((stage) => stage.slug).slice(-5))
      .toEqual(["code-generation", "probe-unit-check", "build-and-test", "ci-pipeline", "probe-intent-check"]);

    const lookup = (slug: string) => run(install, "aidlc-state", ["lookup", "next-stage", slug, "feature"]).out.trim();
    expect(lookup("code-generation")).toBe("probe-unit-check");
    expect(lookup("probe-unit-check")).toBe("build-and-test");
  });

  test("the compile refuses a per-Unit stage that requires a stage run once after the Units", () => {
    const install = probeProject("solo", ["alpha"]);
    const stage = join(install.proj, ".claude", "aidlc-common", "stages", "construction", "probe-unit-check.md");
    writeFileSync(stage, PLUGIN_STAGES["probe-unit-check"].replace("  - code-generation\n", "  - build-and-test\n"));
    const compiled = spawnSync(BUN, [install.tool("aidlc-graph"), "compile"], { cwd: install.proj, encoding: "utf-8", env: ENV });
    expect(compiled.status).not.toBe(0);
    expect(`${compiled.stdout}${compiled.stderr}`).toContain(
      'Stage "probe-unit-check" runs once per Unit of Work, but it requires "build-and-test", which runs once for the whole intent after the Units.',
    );
  });

  const blockRows = (install: Install) =>
    state(install).split("\n").filter((line) => /^- \[.\] (code-generation|probe-unit-check|build-and-test) /.test(line)).sort();
  const finishedBlock = [
    `- [-] build-and-test ${SEP} EXECUTE`,
    `- [x] code-generation ${SEP} EXECUTE`,
    `- [x] probe-unit-check ${SEP} EXECUTE`,
  ];

  for (const units of [["alpha"], ["alpha", "beta"]]) {
    test(`team, ${units.length} Unit(s): each Unit walks the block, its gates name the next stage, and the work moves on to Build and Test`, () => {
      const install = probeProject("team", units);
      const hints: Array<string | null | undefined> = [];
      for (const unit of units) {
        for (const stage of BLOCK) {
          const body = next(install);
          expect(body).toMatchObject({ kind: "run-stage", stage, unit, gate: false });
          const started = run(install, "aidlc-state", ["unit", "start", "--stage", stage, "--unit", unit]);
          expect(started.rc, started.out).toBe(0);
          cover(install, unit, stage);
          if (stage === "code-generation") {
            expect(next(install)).toMatchObject({ kind: "run-stage", stage, unit, plan_approval: { status: "approved" } });
          }
          const completed = run(install, "aidlc-state", ["unit", "complete", "--stage", stage, "--unit", unit]);
          expect(completed.rc, completed.out).toBe(0);
          if (body.reviewer) reviewReady(install, stage, unit, body.reviewer);

          const gate = next(install);
          expect(gate).toMatchObject({ kind: "run-stage", stage, unit, gate: true });
          hints.push(gate.next_stage);
          const args = ["--stage", stage, "--unit", unit];
          expect(report(install, [...args, "--result", "awaiting-approval"]).kind).toBe("print");
          expect(report(install, [...args, "--result", "approved", "--user-input", "Approve"]).kind).toBe("done");
        }
      }

      // The next `next` folds the last Unit's approval into the state.
      const after = next(install);
      expect(state(install)).toContain("- **Current Stage**: build-and-test");
      expect(blockRows(install)).toEqual(finishedBlock);
      expect(state(install)).not.toMatch(/\[[x?-]\] probe-intent-check/);
      expect(after).toMatchObject({ kind: "run-stage", stage: "build-and-test", next_stage: "CI Pipeline" });
      expect(hints).toEqual(units.flatMap(() => ["Probe Unit Check", "Build and Test"]));
    });
  }

  test("solo: the block's approvals all come before Build and Test", () => {
    const install = probeProject("solo", ["alpha", "beta"]);
    for (const unit of ["alpha", "beta"]) {
      for (const stage of BLOCK) {
        const body = next(install);
        expect(body).toMatchObject({ kind: "run-stage", stage, unit, gate: false });
        cover(install, unit, stage);
        if (body.reviewer) reviewReady(install, stage, unit, body.reviewer);
        if (stage === "code-generation") {
          const floor = latestMainWorkflowStageRunFloorForProject(install.proj, stage, true, unit);
          for (const event of ["UNIT_STARTED", "UNIT_COMPLETED"]) {
            appendAuditEntry(event, { Stage: stage, Unit: unit, "Run floor": floor }, install.proj);
          }
        }
      }
    }

    // Unit checkpoints are off, so the block's approvals are one question,
    // asked on the last Unit, and its Approve option names Build and Test.
    const gate = next(install);
    expect(gate).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "beta", gate: true });
    expect((gate.approve_together as { stages: { slug: string }[] }).stages.map((s) => s.slug)).toEqual(BLOCK);
    const shown = report(install, ["--stage", "code-generation", "--result", "awaiting-approval"]);
    expect(shown).toMatchObject({ kind: "print", next_stage: "Build and Test" });
    expect(report(install, ["--stage", "code-generation", "--result", "approved", "--user-input", "Approve"]).kind)
      .toBe("done");
    expect(state(install)).toContain("- **Current Stage**: build-and-test");
    expect(blockRows(install)).toEqual(finishedBlock);
    expect(next(install)).toMatchObject({ kind: "run-stage", stage: "build-and-test" });
  });
});
