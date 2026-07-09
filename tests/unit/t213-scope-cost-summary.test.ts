// covers: function:gridCostSummary, function:scopeCostSummary, function:validateGrid, function:renderScopeTable
//
// t213 - the scope-cost summary helper (issue: preview the cost at scope
// confirmation). The confirm string, the birth print, the scope-change output,
// and the composer validator all read scopeCostSummary/gridCostSummary; this
// test pins those helpers against an INDEPENDENT derivation computed inside the
// test from the shipped scope-grid.json + stage-graph.json. Nothing is
// hardcoded (no literal 32/29) - both sides are computed from the shipped data,
// so a grid change moves both sides together and the pin still holds.
//
// Also proves the three cross-consistency points the design promises:
//   - the helper's execute/total agree with renderScopeTable's "EXECUTE / Total"
//     cell (the --help/scope-table surface, single source of stage counts),
//   - validateGrid(scope grid).summary equals scopeCostSummary(scope) (the
//     validator threads the same numbers the composer relays), and
//   - the unknown-scope / empty-grid edge cases.
//
// Mechanism: in-process imports from the shipped dist tools (unit tier, no
// LLM), same convention as t190.

import { describe, expect, test } from "bun:test";
import {
  gridCostSummary,
  scopeCostSummary,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { validateGrid } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { renderScopeTable } from "../../dist/claude/.claude/tools/aidlc-utility.ts";

// The shipped data files the runtime reads. Requiring them here gives the test
// an independent source to derive expected values from (t190's pattern).
const GRID = require("../../dist/claude/.claude/tools/data/scope-grid.json") as Record<
  string,
  { stages: Record<string, "EXECUTE" | "SKIP"> }
>;
const GRAPH = require("../../dist/claude/.claude/tools/data/stage-graph.json") as Array<{
  slug: string;
  phase: string;
  for_each?: string;
}>;

// The per-unit set the design documents (five Construction stages carrying
// for_each: unit-of-work). Derived from the graph, not hardcoded, so a future
// per-unit stage flows through.
const PER_UNIT = new Set(
  GRAPH.filter((s) => s.for_each === "unit-of-work").map((s) => s.slug),
);
const NODE = new Map(GRAPH.map((s) => [s.slug, s]));

interface Expected {
  total: number;
  execute: number;
  skip: number;
  gates: number;
  perUnitStages: number;
}

// Independent derivation of the cost of a grid, computed straight from the
// shipped JSON with no reference to the helper under test.
function derive(stages: Record<string, "EXECUTE" | "SKIP">): Expected {
  const total = Object.keys(stages).length;
  let execute = 0;
  let gates = 0;
  let perUnitStages = 0;
  for (const [slug, action] of Object.entries(stages)) {
    if (action !== "EXECUTE") continue;
    execute++;
    const node = NODE.get(slug);
    if (!node) continue;
    if (node.phase !== "initialization") gates++;
    if (node.for_each === "unit-of-work" || PER_UNIT.has(slug)) perUnitStages++;
  }
  return { total, execute, skip: total - execute, gates, perUnitStages };
}

describe("t213 scopeCostSummary matches an independent grid+graph derivation", () => {
  for (const name of Object.keys(GRID).sort()) {
    test(`${name}: helper equals derived cost`, () => {
      const got = scopeCostSummary(name);
      expect(got).not.toBeNull();
      expect(got).toEqual(derive(GRID[name].stages));
    });
  }
});

describe("t213 helper agrees with renderScopeTable's EXECUTE / Total cell", () => {
  test("every table row's counts equal the helper's execute/total", () => {
    const rows = renderScopeTable()
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| Scope") && !l.startsWith("|---"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      const name = cells[1];
      const m = cells[4].match(/^(\d+)\s*\/\s*(\d+)$/);
      expect(m).not.toBeNull();
      const cost = scopeCostSummary(name);
      expect(cost).not.toBeNull();
      expect(cost?.execute).toBe(Number((m as RegExpMatchArray)[1]));
      expect(cost?.total).toBe(Number((m as RegExpMatchArray)[2]));
    }
  });
});

describe("t213 validateGrid threads the same summary the helper computes", () => {
  test("validateGrid(feature grid).summary equals scopeCostSummary('feature')", () => {
    const r = validateGrid({ ...GRID.feature.stages });
    expect(r.summary).toEqual(scopeCostSummary("feature") ?? undefined);
  });

  test("validateGrid(bugfix grid).summary equals scopeCostSummary('bugfix')", () => {
    const r = validateGrid({ ...GRID.bugfix.stages });
    expect(r.summary).toEqual(scopeCostSummary("bugfix") ?? undefined);
  });
});

describe("t213 edge cases", () => {
  test("unknown scope returns null", () => {
    expect(scopeCostSummary("no-such-scope")).toBeNull();
  });

  test("empty grid returns all-zero", () => {
    expect(gridCostSummary({})).toEqual({
      total: 0,
      execute: 0,
      skip: 0,
      gates: 0,
      perUnitStages: 0,
    });
  });
});
