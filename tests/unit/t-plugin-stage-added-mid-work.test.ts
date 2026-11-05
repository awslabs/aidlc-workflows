// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-state:checkbox, function:withStageProgressRow, subcommand:aidlc-utility:recompose
//
// A stage a plugin adds after the work started has no row in the state file's
// Stage Progress. The work reaches it (the next stage walks the graph), but a
// transition onto it wrote nothing, so the stage never read as started or done,
// and its report failed: "Stage "probe-intent-check" is not present in the
// state file - cannot commit its transition." The stage's first transition now
// writes its row, after its phase's rows that come before it in the graph.
// A skip or an add the person asks for before the work reaches the stage
// writes the row first, so the plan keeps it.
//
// Mechanism: cli. Each case copies the built Claude install into a temp
// project, adds the plugin stage the way a plugin's compose does, compiles the
// graph with that install's own compile, and drives that install's tools.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { artifactFilename } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

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

// A plugin stage the feature scope skips (it runs only under enterprise), so
// the person adds it to the plan.
const ENTERPRISE_ONLY: Record<string, string> = {
  "probe-extra-check": PLUGIN_STAGES["probe-intent-check"]
    .replaceAll("probe-intent-check", "probe-extra-check")
    .replace("name: Probe Intent Check", "name: Probe Extra Check")
    .replace("  - feature", "  - enterprise"),
};

// A project with its own copy of the install, the plugin stages composed in.
function probeProject(units: string[], stages: Record<string, string> = PLUGIN_STAGES): Install {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  const harness = join(proj, ".claude");
  cpSync(AIDLC_SRC, harness, { recursive: true });
  for (const [slug, body] of Object.entries(stages)) {
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
    `- [x] code-generation ${SEP} EXECUTE`,
    `- [x] build-and-test ${SEP} EXECUTE`,
    `- [-] ci-pipeline ${SEP} EXECUTE`,
  ];
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: plugin stage added mid-work test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on
- **Unit Ownership**: solo

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
- **Current Stage**: ci-pipeline
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

// The plugin stage's report, written where the stage records its work.
function writeReport(install: Install): void {
  const dir = join(seededRecordDir(install.proj), "construction", "probe-intent-check");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, artifactFilename("probe-intent-check-report")), "# Probe intent check\n");
}

const rowsFrom = (install: Install, from: string) => {
  const rows = state(install).split("\n").filter((line) => /^- \[.\] \S+ /.test(line));
  return rows.slice(rows.findIndex((row) => row.includes(` ${from} `)));
};

describe("a stage a plugin adds after the work started", () => {
  test("its first transition writes its row, and its gate commits", () => {
    const install = probeProject(["alpha"]);
    expect(state(install)).not.toContain("probe-intent-check");

    const skipped = report(install, ["--stage", "ci-pipeline", "--result", "skipped", "--reason", "no pipeline for this test"]);
    expect(skipped.kind, JSON.stringify(skipped)).toBe("done");
    expect(state(install)).toContain("- **Current Stage**: probe-intent-check");
    expect(rowsFrom(install, "build-and-test")).toEqual([
      `- [x] build-and-test ${SEP} EXECUTE`,
      `- [S] ci-pipeline ${SEP} EXECUTE`,
      `- [-] probe-intent-check ${SEP} EXECUTE`,
    ]);

    expect(next(install)).toMatchObject({ kind: "run-stage", stage: "probe-intent-check" });
    writeReport(install);
    expect(report(install, ["--stage", "probe-intent-check", "--result", "awaiting-approval"]))
      .toMatchObject({ kind: "print" });
    expect(report(install, ["--stage", "probe-intent-check", "--result", "approved", "--user-input", "Approve"]).kind)
      .toBe("done");
    expect(state(install)).toContain(`- [x] probe-intent-check ${SEP} EXECUTE`);
  });

  test("a skip asked for before the work reaches it is recorded, and the work does not run it", () => {
    const install = probeProject(["alpha"]);
    const recomposed = run(install, "aidlc-utility", [
      "recompose", "--skip", "probe-intent-check", "--reason", "the person asked to skip it",
    ]);
    expect(recomposed.rc, recomposed.out).toBe(0);
    expect(recomposed.out).toContain("Recomposed: 1 skipped (probe-intent-check)");
    expect(rowsFrom(install, "ci-pipeline")).toEqual([
      `- [-] ci-pipeline ${SEP} EXECUTE`,
      `- [ ] probe-intent-check ${SEP} SKIP`,
    ]);

    const skipped = report(install, ["--stage", "ci-pipeline", "--result", "skipped", "--reason", "no pipeline for this test"]);
    expect(skipped.kind, JSON.stringify(skipped)).toBe("done");
    expect(state(install)).not.toContain("- **Current Stage**: probe-intent-check");
  });

  test("an add asked for before the work reaches it is recorded, and the work runs it", () => {
    const install = probeProject(["alpha"], ENTERPRISE_ONLY);
    const recomposed = run(install, "aidlc-utility", [
      "recompose", "--add", "probe-extra-check", "--reason", "the person asked to add it",
    ]);
    expect(recomposed.rc, recomposed.out).toBe(0);
    expect(recomposed.out).toContain("Recomposed: 0 skipped (none), 1 added (probe-extra-check)");
    expect(rowsFrom(install, "ci-pipeline")).toEqual([
      `- [-] ci-pipeline ${SEP} EXECUTE`,
      `- [ ] probe-extra-check ${SEP} EXECUTE`,
    ]);

    const skipped = report(install, ["--stage", "ci-pipeline", "--result", "skipped", "--reason", "no pipeline for this test"]);
    expect(skipped.kind, JSON.stringify(skipped)).toBe("done");
    expect(state(install)).toContain("- **Current Stage**: probe-extra-check");
  });

  test("a cursor an older engine already moved onto it commits its gate", () => {
    const install = probeProject(["alpha"]);
    writeFileSync(
      seededStateFile(install.proj),
      state(install)
        .replace(`- [-] ci-pipeline ${SEP} EXECUTE`, `- [S] ci-pipeline ${SEP} EXECUTE`)
        .replace("- **Current Stage**: ci-pipeline", "- **Current Stage**: probe-intent-check"),
    );
    writeReport(install);
    expect(report(install, ["--stage", "probe-intent-check", "--result", "awaiting-approval"]))
      .toMatchObject({ kind: "print" });
    expect(report(install, ["--stage", "probe-intent-check", "--result", "approved", "--user-input", "Approve"]).kind)
      .toBe("done");
    expect(rowsFrom(install, "ci-pipeline")).toEqual([
      `- [S] ci-pipeline ${SEP} EXECUTE`,
      `- [x] probe-intent-check ${SEP} EXECUTE`,
    ]);
  });
});
