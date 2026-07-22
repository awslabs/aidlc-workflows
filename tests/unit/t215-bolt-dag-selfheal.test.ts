// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// CLI-contract tests for the orchestrator's bolt_dag self-heal path. The
// internal readBoltDagBatches helper is not exported, so this file claims the
// legitimate registry surfaces that exercise it: the real next and report
// subprocesses. Each case seeds a fresh per-intent record, writes the
// unit-of-work-dependency.md artifact when needed, and asserts on the emitted
// directive plus stderr observability.

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
const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;
const SEP = "\u2014";
const HEAL_NOTE =
  "aidlc-orchestrate: runtime-graph.json bolt_dag is missing or stale; recomputed 2 unit batch(es) from unit-of-work-dependency.md (check the runtime-compile hook)";
const FD_PRODUCES = [
  "business-logic-model",
  "business-rules",
  "domain-entities",
  "frontend-components",
];

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  units?: unknown;
  gate?: unknown;
  inputs?: string[];
  produces?: string[];
  message?: string;
  [k: string]: unknown;
}

interface RunResult {
  directive: Directive;
  stdout: string;
  stderr: string;
  status: number | null;
}

function row(marker: " " | "-" | "x", slug: string): string {
  return `- [${marker}] ${slug} ${SEP} EXECUTE`;
}

function constructionState(current: string, skeletonStance = "on"): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: bolt dag self heal test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7
- **Skeleton Stance**: ${skeletonStance}

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
${row(current === "functional-design" ? "-" : " ", "functional-design")}
${row(current === "nfr-requirements" ? "-" : " ", "nfr-requirements")}
${row(current === "nfr-design" ? "-" : " ", "nfr-design")}
${row(current === "infrastructure-design" ? "-" : " ", "infrastructure-design")}
${row(current === "code-generation" ? "-" : " ", "code-generation")}
${row(current === "build-and-test" ? "-" : " ", "build-and-test")}

### INCEPTION PHASE
${row("x", "application-design")}
${row("x", "units-generation")}

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`;
}

function inceptionState(current: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: bolt dag self heal test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 7

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
${row(current === "application-design" ? "-" : " ", "application-design")}
${row(current === "units-generation" ? "-" : " ", "units-generation")}

### CONSTRUCTION PHASE
${row(" ", "functional-design")}
${row(" ", "nfr-requirements")}
${row(" ", "nfr-design")}
${row(" ", "infrastructure-design")}
${row(" ", "code-generation")}
${row(" ", "build-and-test")}

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: ${current}
- **Status**: Running
`;
}

function seedProject(current: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(seededStateFile(proj), constructionState(current));
  return proj;
}

function seedInceptionProject(current: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  writeFileSync(seededStateFile(proj), inceptionState(current));
  return proj;
}

function writeDependencyArtifact(proj: string, body: string): void {
  const dir = join(seededRecordDir(proj), "inception", "units-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "unit-of-work-dependency.md"), body);
}

function seedAlphaBetaDependency(proj: string): void {
  writeDependencyArtifact(
    proj,
    [
      "# Unit of Work Dependency",
      "",
      "```yaml",
      "units:",
      "  - name: alpha",
      "    depends_on: []",
      "  - name: beta",
      "    depends_on: [alpha]",
      "```",
      "",
    ].join("\n"),
  );
}

function seedCyclicDependency(proj: string): void {
  writeDependencyArtifact(
    proj,
    [
      "# Unit of Work Dependency",
      "",
      "```yaml",
      "units:",
      "  - name: alpha",
      "    depends_on: [beta]",
      "  - name: beta",
      "    depends_on: [alpha]",
      "```",
      "",
    ].join("\n"),
  );
}

function seedDanglingDependency(proj: string): void {
  writeDependencyArtifact(
    proj,
    [
      "# Unit of Work Dependency",
      "",
      "```yaml",
      "units:",
      "  - name: alpha",
      "    depends_on: [missing]",
      "```",
      "",
    ].join("\n"),
  );
}

function seedGraphWithoutBoltDag(proj: string): void {
  writeFileSync(
    join(seededRecordDir(proj), "runtime-graph.json"),
    JSON.stringify({ stages: [] }, null, 2),
  );
}

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

function setAutonomous(proj: string): void {
  const statePath = seededStateFile(proj);
  const state = readFileSync(statePath, "utf-8").replace(
    /^(- \*\*Scope\*\*: .*)$/m,
    "$1\n- **Construction Autonomy Mode**: autonomous",
  );
  writeFileSync(statePath, state);
}

function runOrch(proj: string, args: string[]): RunResult {
  const r = spawnSync(BUN, [ORCH, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: (() => {
      const e = { ...process.env };
      delete e.AWS_AIDLC_DEFAULT_SCOPE;
      return e;
    })(),
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  try {
    return {
      directive: JSON.parse(stdout.trim()) as Directive,
      stdout,
      stderr,
      status: r.status,
    };
  } catch {
    throw new Error(
      `aidlc-orchestrate did not emit parseable JSON. status=${r.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
}

function runNext(proj: string): RunResult {
  return runOrch(proj, ["next"]);
}

function runReport(proj: string): RunResult {
  return runOrch(proj, [
    "report",
    "--stage",
    "functional-design",
    "--result",
    "approved",
  ]);
}

function logCapturedStderr(stderr: string): void {
  for (const line of stderr.trim().split(/\r?\n/)) {
    if (line.length > 0) console.error(line);
  }
}

describe("t215 bolt dag self-heal", () => {
  test("1: missing runtime graph heals from the dependency artifact on next", () => {
    const proj = seedProject("functional-design");
    seedAlphaBetaDependency(proj);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("run-stage");
    expect(r.directive.stage).toBe("functional-design");
    expect(r.directive.unit).toBe("alpha");
    expect(r.directive.produces).toContain(
      `${RP}/construction/alpha/functional-design/business-logic-model.md`,
    );
    expect(r.stderr).toContain(HEAL_NOTE);
    logCapturedStderr(r.stderr);
  }, 30000);

  test("2: runtime graph without a bolt_dag node heals from the dependency artifact", () => {
    const proj = seedProject("functional-design");
    seedGraphWithoutBoltDag(proj);
    seedAlphaBetaDependency(proj);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("run-stage");
    expect(r.directive.unit).toBe("alpha");
    expect(r.stderr).toContain(HEAL_NOTE);
    logCapturedStderr(r.stderr);
  }, 30000);

  test("3: no dependency artifact preserves the single placeholder degrade path", () => {
    const proj = seedProject("functional-design");
    const r = runNext(proj);
    expect(r.directive.kind).toBe("run-stage");
    expect(r.directive.stage).toBe("functional-design");
    expect(r.directive.unit).toBeUndefined();
    expect(r.directive.produces).toContain(
      `${RP}/construction/{unit-name}/functional-design/business-logic-model.md`,
    );
    expect(r.stderr).toBe("");
  }, 30000);

  test("4: cyclic dependency artifact with no graph emits a loud error", () => {
    const proj = seedProject("functional-design");
    seedCyclicDependency(proj);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("error");
    expect(r.directive.message).toContain("unit-of-work-dependency.md");
    expect(r.directive.message).toContain("cyclic");
    expect(r.stderr).toBe("");
  }, 30000);

  test("5: dangling dependency artifact with no graph emits a malformed error", () => {
    const proj = seedProject("functional-design");
    seedDanglingDependency(proj);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("error");
    expect(r.directive.message).toContain("unit-of-work-dependency.md");
    expect(r.directive.message).toContain("malformed");
    expect(r.directive.message).toContain("unknown unit");
    expect(r.stderr).toBe("");
  }, 30000);

  test("6: malformed authored dependency data fails closed despite a valid cached bolt_dag", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, ["gamma"]);
    seedDanglingDependency(proj);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("error");
    expect(r.directive.message).toContain("unit-of-work-dependency.md");
    expect(r.directive.message).toContain("malformed");
    expect(r.directive.message).toContain("unknown unit");
    expect(r.stderr).toBe("");
  }, 30000);

  test("6b: a valid but outdated cached bolt_dag heals from the authored artifact", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, ["alpha"]);
    seedAlphaBetaDependency(proj);
    coverUnit(proj, "alpha", "functional-design", FD_PRODUCES);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("run-stage");
    expect(r.directive.unit).toBe("beta");
    expect(r.stderr).toContain(HEAL_NOTE);
    logCapturedStderr(r.stderr);
  }, 30000);

  test("7: approve guard sees healed units and refuses uncovered per-unit work", () => {
    const proj = seedProject("functional-design");
    seedAlphaBetaDependency(proj);
    const r = runReport(proj);
    expect(r.directive.kind).toBe("error");
    expect(r.directive.message).toContain("functional-design");
    expect(r.directive.message).toContain("alpha");
    expect(r.directive.message).toContain("beta");
    expect(r.directive.message).toContain("per-unit");
    expect(r.stderr).toContain(HEAL_NOTE);
    logCapturedStderr(r.stderr);
  }, 30000);

  test("8: approve guard reports a malformed dependency artifact as an error", () => {
    const proj = seedProject("functional-design");
    seedDanglingDependency(proj);
    const r = runReport(proj);
    expect(r.directive.kind).toBe("error");
    expect(r.directive.message).toContain("unit list cannot be resolved");
    expect(r.directive.message).toContain("unit-of-work-dependency.md");
    expect(r.directive.message).toContain("malformed");
    expect(r.directive.message).toContain("before entering approval");
    expect(r.stderr).toBe("");
  }, 30000);

  test("9: autonomous code-generation swarm heals and emits the first batch", () => {
    const proj = seedProject("code-generation");
    seedAlphaBetaDependency(proj);
    setAutonomous(proj);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("invoke-swarm");
    expect(r.directive.units).toEqual(["alpha"]);
    expect(r.stderr).toContain(HEAL_NOTE);
    logCapturedStderr(r.stderr);
  }, 30000);

  test("10: healed per-unit iteration advances and settles from artifact coverage", () => {
    const proj = seedProject("functional-design");
    seedAlphaBetaDependency(proj);
    coverUnit(proj, "alpha", "functional-design", FD_PRODUCES);

    const betaRun = runNext(proj);
    expect(betaRun.directive.kind).toBe("run-stage");
    expect(betaRun.directive.unit).toBe("beta");
    expect(betaRun.directive.gate).toBe(false);
    expect(betaRun.stderr).toContain(HEAL_NOTE);
    logCapturedStderr(betaRun.stderr);

    coverUnit(proj, "beta", "functional-design", FD_PRODUCES);
    const settle = runNext(proj);
    expect(settle.directive.kind).toBe("run-stage");
    expect(settle.directive.unit).toBe("beta");
    expect(settle.directive.gate).toBe(true);
    expect(settle.stderr).toContain(HEAL_NOTE);
    logCapturedStderr(settle.stderr);
  }, 30000);

  test("11: non-per-unit stages do not trigger the read-side heal", () => {
    const proj = seedInceptionProject("application-design");
    seedAlphaBetaDependency(proj);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("run-stage");
    expect(r.directive.stage).toBe("application-design");
    expect(r.directive.unit).toBeUndefined();
    expect(r.directive.produces?.some((p) => p.includes("/construction/"))).toBe(false);
    expect(r.directive.inputs?.some((p) => p.includes("/construction/")) ?? false).toBe(false);
    expect(r.stderr).toBe("");
  }, 30000);

  // 12: a cached bolt_dag whose batches are EMPTY (a hand-corrupted graph; no
  // shipped writer emits an empty level) is a cache MISS, not an "ok" empty
  // plan. With a dependency artifact beside it the resolver heals to the real
  // units; the settle branch is never stranded on an undefined unit.
  test("12: empty cached batches are treated as a miss and heal from the artifact", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, []);
    seedAlphaBetaDependency(proj);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("run-stage");
    expect(r.directive.unit).toBe("alpha");
    expect(r.stderr).toContain(HEAL_NOTE);
    logCapturedStderr(r.stderr);
  }, 30000);

  // 12b: the same corrupted graph with NO dependency artifact degrades to the
  // single placeholder directive (the pre-existing behavior for that input),
  // never an exit-1 crash on an undefined unit.
  test("12b: empty cached batches with no artifact fall back to the degrade path", () => {
    const proj = seedProject("functional-design");
    seedBoltDag(proj, []);
    const r = runNext(proj);
    expect(r.directive.kind).toBe("run-stage");
    expect(r.directive.unit).toBeUndefined();
    expect(r.directive.produces).toContain(
      `${RP}/construction/{unit-name}/functional-design/business-logic-model.md`,
    );
    expect(r.stderr).toBe("");
  }, 30000);
});
