// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-learnings:surface, subcommand:aidlc-runtime:compile
//
// A per-Unit stage's notes (its memory.md diary) sat in a stage-named folder
// directly under `construction/`, beside the Unit folders, so the record showed
// every per-Unit stage's name twice and people opened the wrong one. A solo
// run now keeps each Unit's notes in the Unit's own `construction/<unit>/<stage>/`,
// as a team-owned Unit and a wave Unit already did. A diary older work left at
// `construction/<stage>/memory.md` stays where it is and is still read, by the
// learnings step and by the runtime graph's counts.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
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

process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const RP = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;
const DASH = "—"; // the diary line's separator
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

function project(iteration: "unit-major" | "stage-major", stance: boolean): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const row = (mark: string, slug: string) => `- [${mark}] ${slug} ${DASH} EXECUTE`;
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: unit notes
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
${stance ? "- **Skeleton Stance**: on\n" : ""}- **Construction Iteration**: ${iteration}
- **Unit Ownership**: solo

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
${row("x", "units-generation")}

### CONSTRUCTION PHASE
${row("-", "functional-design")}
${row(" ", "nfr-requirements")}
${row(" ", "nfr-design")}
${row(" ", "infrastructure-design")}
${row(" ", "code-generation")}
${row(" ", "build-and-test")}

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  // The engine makes a diary from the installed template.
  const shared = join(p, ".claude", "knowledge", "aidlc-shared");
  mkdirSync(shared, { recursive: true });
  copyFileSync(join(AIDLC_SRC, "knowledge", "aidlc-shared", "memory-template.md"), join(shared, "memory-template.md"));
  seedBoltDag(p, ["alpha", "beta"]);
  return p;
}

function next(p: string) {
  const env = { ...process.env, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" };
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), p, [], { env });
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as { kind: string; stage: string; unit?: string; memory_path: string };
}

function diary(p: string, ...parts: string[]): string {
  return join(seededRecordDir(p), "construction", ...parts, "memory.md");
}

function write(path: string, lines: string[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function surface(p: string): { memory_entries_total: number; phase: string } {
  // seedBoltDag writes the graph's Unit plan alone; a compiled graph has rows too.
  const graphPath = join(seededRecordDir(p), "runtime-graph.json");
  writeFileSync(graphPath, JSON.stringify({ stages: [], ...JSON.parse(readFileSync(graphPath, "utf-8")) }));
  const result = spawnSync(process.execPath, [
    join(AIDLC_SRC, "tools", "aidlc-learnings.ts"), "surface", "--slug", "functional-design", "--project-dir", p,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

describe("t-unit-notes-in-unit-folder a solo Unit keeps its stage notes in its own folder", () => {
  test("a Unit's step names the Unit's own diary, makes it there, and makes no stage folder", () => {
    const p = project("unit-major", true);
    const directive = next(p);
    expect(directive).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha" });
    expect(directive.memory_path).toBe(`${RP}/construction/alpha/functional-design/memory.md`);
    expect(existsSync(diary(p, "alpha", "functional-design"))).toBe(true);
    expect(existsSync(join(seededRecordDir(p), "construction", "functional-design"))).toBe(false);
  });

  test("the walking-skeleton ask, which names no Unit, makes no stage folder either", () => {
    const p = project("unit-major", false);
    const directive = next(p);
    expect(directive).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    expect(directive.unit).toBeUndefined();
    expect(directive.memory_path).toBe(`${RP}/construction/alpha/functional-design/memory.md`);
    expect(existsSync(join(seededRecordDir(p), "construction", "functional-design"))).toBe(false);
  });

  test("the stage's learnings step counts every Unit's notes and the notes older work left in the stage diary", () => {
    const p = project("stage-major", true);
    write(diary(p, "functional-design"), [
      "## Interpretations",
      `- 2026-10-05T10:00:00Z [unit alpha] ${DASH} alpha keeps its own store; it owns the data`,
      "",
      "## Open questions",
    ]);
    write(diary(p, "alpha", "functional-design"), ["## Tradeoffs", `- 2026-11-05T10:00:00Z ${DASH} one list over a grid; fewer clicks`]);
    write(diary(p, "beta", "functional-design"), ["## Deviations", `- 2026-11-05T11:00:00Z ${DASH} kept the old route; the person asked`]);
    const out = surface(p);
    expect(out.phase).toBe("construction");
    expect(out.memory_entries_total).toBe(3);
  });

  test("the runtime graph counts a per-Unit stage's notes in every Unit's diary and older work's, a wave copy once", () => {
    const p = project("stage-major", true);
    const note = `- 2026-08-12T00:00:00Z ${DASH} preserve this note; verbatim context`;
    write(diary(p, "alpha", "functional-design"), ["## Interpretations", note]);
    write(diary(p, "beta", "functional-design"), ["## Tradeoffs", `- 2026-11-05T11:00:00Z ${DASH} kept one store; two would drift`]);
    // Older work: an untagged note, and the copy the retired wave fan-in made of alpha's.
    write(diary(p, "functional-design"), [
      "## Interpretations",
      `- 2026-08-11T00:00:00Z ${DASH} every Unit logs in UTC; the team asked for it`,
      "",
      note,
      "<!-- aidlc-wave-memory:alpha:0123456789abcdef -->",
      "",
      "## Open questions",
    ]);
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
    appendAuditEntry("STAGE_STARTED", { Stage: "functional-design", Agent: "aidlc-architect-agent" }, p);
    const compiled = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-runtime.ts"), "--project-dir", p, "compile"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
    });
    expect(compiled.status, compiled.stderr).toBe(0);
    const graph = JSON.parse(readFileSync(join(seededRecordDir(p), "runtime-graph.json"), "utf-8"));
    const row = graph.stages.find((s: { stage_slug: string }) => s.stage_slug === "functional-design");
    expect(row.memory_path).toBe(`${RP}/construction/functional-design/memory.md`);
    expect(row.memory_entries).toBe(3);
    expect(row.memory_breakdown).toMatchObject({ interpretations: 2, tradeoffs: 1 });
  });
});
