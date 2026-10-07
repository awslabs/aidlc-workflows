// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:scope-change
//
// t214 - the scope-cost preview reaches the emitted routing strings (issue:
// preview the cost at scope confirmation). t213 pins the helper; this pins the
// STRINGS the user actually sees. Every expected number is computed inside the
// test from the shipped scope-grid.json + stage-graph.json - never a literal -
// so the assertions track the grid.
//
// Surfaces:
//   - the keyword-hit confirm (Branch 8) carries "N stages, G approval gates"
//     for the MATCHED scope (N: the stages after Initialization),
//   - the compose offer carries the express/classic/feature example trio,
//     computed from the grid, and still avoids the t198 `"feature" workflow` trap,
//   - the explicit-scope creation print carries the cost parenthetical, and
//   - scope-change stdout carries the "Approval gates:" line (greenfield
//     reverse-engineering adjustment applied, matching the handler).
//
// Mechanism: CLI spawn of the shipped dist engine (t198's convention) - no LLM,
// unit tier.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  for_each?: string;
}>;
const PHASE = new Map(GRAPH.map((s) => [s.slug, s.phase]));
const PER_UNIT = new Set(
  GRAPH.filter((s) => s.for_each === "unit-of-work").map((s) => s.slug),
);

// Independent derivation (mirrors gridCostSummary), applying the optional
// greenfield reverse-engineering adjustment so the scope-change expectation
// matches the handler's effective grid.
function counts(
  stages: Record<string, "EXECUTE" | "SKIP">,
  greenfieldAdjust = false,
): { execute: number; total: number; gates: number; shown: number; perUnitStages: number } {
  const st = { ...stages };
  if (greenfieldAdjust && st["reverse-engineering"] === "EXECUTE") {
    st["reverse-engineering"] = "SKIP";
  }
  const total = Object.keys(st).length;
  const hasUnitDag = st["units-generation"] === "EXECUTE";
  let execute = 0;
  let gates = 0;
  let shown = 0;
  let perUnitStages = 0;
  for (const [slug, action] of Object.entries(st)) {
    if (action !== "EXECUTE") continue;
    execute++;
    if (PHASE.get(slug) !== "initialization") {
      gates++;
      shown++;
    }
    if (hasUnitDag && PER_UNIT.has(slug)) perUnitStages++;
  }
  return { execute, total, gates, shown, perUnitStages };
}

function costClause(cost: ReturnType<typeof counts>): string {
  const perUnit = cost.perUnitStages > 0
    ? `, ${cost.perUnitStages} ${cost.perUnitStages === 1 ? "stage repeats" : "stages repeat"} per unit of work in Construction`
    : "";
  // The stages after Initialization: the count the progress line uses too.
  return `${cost.shown} stages, ${cost.gates} approval gates${perUnit}`;
}

interface RunResult {
  rc: number;
  out: string;
}

function runNext(proj: string, args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync(BUN, [ORCH, "next", ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env: {
      ...process.env,
      AIDLC_DISABLE_SENSORS: "0",
      AIDLC_DISABLE_LEARNINGS: "0",
      AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
      ...env,
    },
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function runUtility(proj: string, args: string[]): RunResult {
  const res = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

describe("t214 keyword-hit confirm carries the effective cost clause", () => {
  test("greenfield bugfix confirm adjusts reverse engineering and omits per-unit fan-out", () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["fix login bug"]).out);
    expect(d.kind).toBe("ask");
    const q = String(d.question);
    expect(q).toContain('"bugfix"');
    const bf = counts(GRID.bugfix.stages, true);
    // bugfix asks no learnings question and no summary confirmation, and says so up front.
    expect(q).toContain(`${costClause(bf)}; no learnings ritual or summary confirmation; lead agent only.`);
    expect(q).not.toContain("per unit of work");
  });

  test("brownfield bugfix confirm keeps nominal reverse-engineering counts", () => {
    proj = createTestProject();
    writeFileSync(join(proj, "app.ts"), "export const existing = true;\n");
    const d = directiveOf(runNext(proj, ["fix login bug"]).out);
    expect(d.kind).toBe("ask");
    const q = String(d.question);
    expect(q).toContain(costClause(counts(GRID.bugfix.stages)));
    expect(q).not.toContain("per unit of work");
  });
});

describe("t214 compose offer carries the example counts (no feature-workflow trap)", () => {
  test("offer names bugfix/express/classic/feature counts and avoids the t198 pinned substring", () => {
    proj = createTestProject();
    const d = directiveOf(
      runNext(proj, ["build a distributed cache layer with consistency guarantees"]).out,
    );
    expect(d.kind).toBe("ask");
    const q = String(d.question);
    expect(q).toContain("compose");
    const bugfix = counts(GRID.bugfix.stages, true);
    const express = counts(GRID.express.stages, true);
    const classic = counts(GRID.classic.stages, true);
    const feature = counts(GRID.feature.stages, true);
    // bugfix leads, so a bug the description gave no word for is still offered.
    expect(q).toContain(
      `e.g. bugfix = ${bugfix.shown} stages, express = ${express.shown}`,
    );
    expect(q).toContain(`classic = ${classic.shown}`);
    expect(q).toContain(`feature = ${feature.shown}`);
    expect(q).not.toContain("of 33");
    // t198:200 pins this substring's absence on the compose-offer arm.
    expect(q).not.toContain('"feature" workflow');
  });
});

describe("t214 every plan the offer lists carries the engine's own count", () => {
  // A host that shows the other plans as choices shows these numbers, so the
  // choices agree with the question ("classic = 17" in the question, "18 of 33
  // stages" on the classic choice was the agent's own count).
  function rowsAgree(d: Record<string, unknown>, greenfield: boolean): void {
    const rows = d.scope_commands as Array<{ scope: string; stages?: string }>;
    for (const [scope, entry] of Object.entries(GRID)) {
      const c = counts(entry.stages, greenfield);
      expect(rows.find((row) => row.scope === scope)?.stages, scope).toBe(`${c.shown} ${c.shown === 1 ? "stage" : "stages"}`);
    }
  }

  test("the compose offer's plans, on a new project", () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["build a distributed cache layer with consistency guarantees"]).out);
    expect(d.ask_type).toBe("compose-offer");
    rowsAgree(d, true);
    expect(String(d.question)).toContain(`classic = ${counts(GRID.classic.stages, true).shown}`);
    // Every count the question names is its plan's row count, so a choice that
    // shows a row's number can only differ from the question in wording.
    const rows = d.scope_commands as Array<{ scope: string; stages?: string }>;
    const named = [...String(d.question).matchAll(/\b([a-z][a-z-]*) = (\d+)\b/g)];
    expect(named.map(([, scope]) => scope)).toEqual(["bugfix", "express", "classic", "feature"]);
    for (const [, scope, n] of named) {
      expect(rows.find((row) => row.scope === scope)?.stages, scope).toBe(`${n} stages`);
    }
  });

  test("the plan offer's other plans, on existing code", () => {
    proj = createTestProject();
    writeFileSync(join(proj, "app.ts"), "export const existing = true;\n");
    const d = directiveOf(runNext(proj, ["fix login bug"]).out);
    expect(d.ask_type).toBe("scope-confirm");
    rowsAgree(d, false);
    expect(String(d.question)).toContain(costClause(counts(GRID.bugfix.stages)));
  });
});

describe("t214 creation print carries the cost parenthetical", () => {
  test("next bugfix prints intent-create AND the computed cost", () => {
    proj = createTestProject();
    // A genuinely empty workspace creates instead of prompting to pick (t198:208).
    removeWorkspaceRecord(proj);
    const d = directiveOf(runNext(proj, ["bugfix"]).out);
    expect(d.kind).toBe("print");
    const m = String(d.message);
    expect(m).toContain("intent create --scope bugfix");
    const bf = counts(GRID.bugfix.stages, true);
    expect(m).toContain(`(${costClause(bf)}; no learnings ritual or summary confirmation; lead agent only)`);
    expect(m).not.toContain("per unit of work");
  });

  test("classic creation preview omits the off clause when summary confirmation is enabled", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const result = runNext(proj, [
      "--scope", "classic", "--summary-confirmation", "on", "add login support",
    ]);
    expect(result.rc, result.out).toBe(0);
    const d = directiveOf(result.out);
    expect(d.kind).toBe("print");
    const message = String(d.message);
    expect(message).toContain("--summary-confirmation on");
    // Advisory is a review cap; enabling summary confirmation leaves no disabled ceremony.
    expect(message).toContain("; lead agent only");
  });

  test("feature creation preview discloses the environment sensor kill switch", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const result = runNext(proj, ["--scope", "feature", "--sensors", "on"], {
      AIDLC_DISABLE_SENSORS: "1",
    });
    expect(result.rc, result.out).toBe(0);
    const d = directiveOf(result.out);
    expect(d.kind).toBe("print");
    expect(String(d.message).match(/; no [^)]*/)?.[0]).toBe("; no sensors; lead agent only");
  });

  for (const scope of ["classic", "feature"]) {
    test(`next ${scope} retains the derived per-unit clause`, () => {
      proj = createTestProject();
      removeWorkspaceRecord(proj);
      const d = directiveOf(runNext(proj, [scope]).out);
      expect(d.kind).toBe("print");
      const expected = counts(GRID[scope].stages, true);
      expect(expected.perUnitStages).toBeGreaterThan(0);
      expect(String(d.message)).toContain(costClause(expected));
      expect(String(d.message)).toContain("per unit of work");
      if (scope === "classic") {
        expect(String(d.message)).toContain(
          "; no summary confirmation; lead agent only",
        );
      } else {
        // feature keeps the first four ceremonies on but ships collaborators off.
        expect(String(d.message)).toContain("; lead agent only");
      }
    });
  }
});

describe("t214 scope-change stdout carries the stage and gate counts", () => {
  test("scope change --scope mvp says its stages and approval gates in one line", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const r = runUtility(proj, ["scope-change", "--scope", "mvp"]);
    expect(r.rc).toBe(0);
    // The fixture is Greenfield, so reverse-engineering EXECUTE -> SKIP.
    const mvp = counts(GRID.mvp.stages, true);
    expect(r.out).toContain(`Switched to mvp (the set of stages this work runs): ${mvp.shown} stages (`);
    expect(r.out).toContain(`, ${mvp.gates} approval gates`);
  });
});
