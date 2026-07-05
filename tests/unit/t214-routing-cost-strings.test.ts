// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:scope-change
//
// t214 - the scope-cost preview reaches the emitted routing strings (issue:
// preview the cost at scope confirmation). t213 pins the helper; this pins the
// STRINGS the user actually sees. Every expected number is computed inside the
// test from the shipped scope-grid.json + stage-graph.json - never a literal -
// so the assertions track the grid.
//
// Surfaces:
//   - the keyword-hit confirm (Branch 8) carries "N of T stages, G approval
//     gates" for the MATCHED scope,
//   - the compose offer carries the "bugfix = N of T stages" example fragment
//     and still avoids the t198 `"feature" workflow` trap,
//   - the explicit-scope birth print carries the cost parenthetical, and
//   - scope-change stdout carries the "Approval gates:" line (greenfield
//     reverse-engineering adjustment applied, matching the handler).
//
// Mechanism: CLI spawn of the shipped dist engine (t198's convention) - no LLM,
// unit tier.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  resetAidlcEnv,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");

const GRID = require("../../dist/claude/.claude/tools/data/scope-grid.json") as Record<
  string,
  { stages: Record<string, "EXECUTE" | "SKIP"> }
>;
const GRAPH = require("../../dist/claude/.claude/tools/data/stage-graph.json") as Array<{
  slug: string;
  phase: string;
}>;
const PHASE = new Map(GRAPH.map((s) => [s.slug, s.phase]));

// Independent derivation (mirrors gridCostSummary), applying the optional
// greenfield reverse-engineering adjustment so the scope-change expectation
// matches the handler's effective grid.
function counts(
  stages: Record<string, "EXECUTE" | "SKIP">,
  greenfieldAdjust = false,
): { execute: number; total: number; gates: number } {
  const st = { ...stages };
  if (greenfieldAdjust && st["reverse-engineering"] === "EXECUTE") {
    st["reverse-engineering"] = "SKIP";
  }
  const total = Object.keys(st).length;
  let execute = 0;
  let gates = 0;
  for (const [slug, action] of Object.entries(st)) {
    if (action !== "EXECUTE") continue;
    execute++;
    if (PHASE.get(slug) !== "initialization") gates++;
  }
  return { execute, total, gates };
}

interface RunResult {
  rc: number;
  out: string;
}

function runNext(proj: string, args: string[]): RunResult {
  const res = spawnSync(BUN, [ORCH, "next", ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function runUtility(proj: string, args: string[]): RunResult {
  const res = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function directiveOf(out: string): Record<string, unknown> {
  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  expect(line).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

let proj = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

describe("t214 keyword-hit confirm carries the cost clause", () => {
  test('bugfix confirm names "N of T stages, G approval gates"', () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["fix login bug"]).out);
    expect(d.kind).toBe("ask");
    const q = String(d.question);
    expect(q).toContain('"bugfix"');
    const bf = counts(GRID.bugfix.stages);
    expect(q).toContain(`${bf.execute} of ${bf.total} stages, ${bf.gates} approval gates`);
  });
});

describe("t214 compose offer carries the example counts (no feature-workflow trap)", () => {
  test('offer names "bugfix = N of T stages" and avoids the t198 pinned substring', () => {
    proj = createTestProject();
    const d = directiveOf(
      runNext(proj, ["build a distributed cache layer with consistency guarantees"]).out,
    );
    expect(d.kind).toBe("ask");
    const q = String(d.question);
    expect(q).toContain("compose");
    const bf = counts(GRID.bugfix.stages);
    expect(q).toContain(`bugfix = ${bf.execute} of ${bf.total} stages`);
    // t198:200 pins this substring's absence on the compose-offer arm.
    expect(q).not.toContain('"feature" workflow');
  });
});

describe("t214 birth print carries the cost parenthetical", () => {
  test("next bugfix prints intent-birth AND the computed cost", () => {
    proj = createTestProject();
    // A genuinely empty workspace births instead of prompting to pick (t198:208).
    removeWorkspaceRecord(proj);
    const d = directiveOf(runNext(proj, ["bugfix"]).out);
    expect(d.kind).toBe("print");
    const m = String(d.message);
    expect(m).toContain("intent-birth --scope bugfix");
    const bf = counts(GRID.bugfix.stages);
    expect(m).toContain(`(${bf.execute} of ${bf.total} stages, ${bf.gates} approval gates`);
  });
});

describe("t214 scope-change stdout carries the Approval gates line", () => {
  test("scope-change --scope mvp prints Stages in scope AND Approval gates", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const r = runUtility(proj, ["scope-change", "--scope", "mvp"]);
    expect(r.rc).toBe(0);
    // The fixture is Greenfield, so reverse-engineering EXECUTE -> SKIP.
    const mvp = counts(GRID.mvp.stages, true);
    expect(r.out).toContain(`Stages in scope: ${mvp.execute}`);
    expect(r.out).toContain(`Approval gates: ${mvp.gates}`);
  });
});
