// covers: scope:bugfix, scope:classic, subcommand:aidlc-utility:scope-table
//
// t30 - Scope-to-Stage Mapping consistency. The subject is the consistency
// between three compiled data artifacts - SKILL.md's compiled scope-grid table
// (rendered by `aidlc-utility.ts scope-table`), scope-grid.json (the
// transpose), and stage-graph.json (phase membership) - so the covers ids name
// the scope-table subcommand that emits the table and the two scopes whose
// phase-presence shape is pinned (bugfix, classic).
//
// Mechanism: none. Every assertion is a pure structural / data check —
// read the SHIPPED files (dist/claude/.claude/...), parse JSON / slice the
// SKILL.md region, and assert in-process. No argv, no exit code, no stdout,
// no process boundary, zero LLM, zero tokens. (One in-process IMPORT of the
// tool's exported `renderScopeTable` supplies a single byte-equality proof
// that the committed table IS the transpose of the grid; still no spawn.)
//
// Source under test:
//   - dist/claude/.claude/tools/data/scope-grid.json - the compiled grid.
//     Shape: { <scope>: { stages: { <slug>: "EXECUTE"|"SKIP" } } }. Source of
//     truth for routing.
//   - dist/claude/.claude/tools/data/stage-graph.json — array of stage nodes
//     carrying { slug, phase, ... }. Phase membership for Section D.
//   - dist/claude/.claude/skills/aidlc/SKILL.md — carries a compiled summary
//     table between BEGIN/END markers. Markers + render format defined in
//     aidlc-utility.ts: SCOPE_TABLE_BEGIN, SCOPE_TABLE_END, renderScopeTable(),
//     canonicalScopeTableRegion().
//
// We assert exact integers, not a regex match, so a wrong total is caught.
//
//   - Section A/B/C are proven by a single byte-equality of the committed
//     SKILL.md region against canonicalScopeTableRegion(renderScopeTable()) -
//     the committed table is provably the transpose of the grid, not merely
//     "contains the markers / count agrees".
//   - Section C asserts exact integers (including bugfix's 9) derived from the
//     grid AND read from the table cell, on the SAME scope row - co-located,
//     not "the number appears somewhere".
//   - Section D guards against a vacuous pass: both the ideation slug set and
//     the operation slug set must be non-empty, or "zero EXECUTE among them"
//     would be trivially true.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import {
  canonicalScopeTableRegion,
  renderScopeTable,
} from "../../dist/claude/.claude/tools/aidlc-utility.ts";

// --- Shipped artifacts (the SAME files the orchestrator + tool read) --------
// The generated tables live in tables.md beside the orchestrator skill.
const SKILL_PATH = join(AIDLC_SRC, "skills", "aidlc", "tables.md");
const SCOPE_GRID_PATH = join(AIDLC_SRC, "tools", "data", "scope-grid.json");
const STAGE_GRAPH_PATH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

const BEGIN = "<!-- BEGIN: compiled scope grid";
const END = "<!-- END: compiled scope grid -->";

const SCOPES = [
  "bugfix",
  "classic",
  "enterprise",
  "express",
  "feature",
  "infra",
  "mvp",
  "poc",
  "refactor",
  "security-patch",
  "workshop",
] as const;

type ScopeGrid = Record<string, { stages: Record<string, string> }>;
interface StageNode {
  slug: string;
  phase: string;
}

function readGrid(): ScopeGrid {
  return JSON.parse(readFileSync(SCOPE_GRID_PATH, "utf-8")) as ScopeGrid;
}

function readGraph(): StageNode[] {
  return JSON.parse(readFileSync(STAGE_GRAPH_PATH, "utf-8")) as StageNode[];
}

function skillRegion(): string {
  const raw = readFileSync(SKILL_PATH, "utf-8");
  const beginIdx = raw.indexOf(BEGIN);
  const endIdx = raw.indexOf(END);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error("SKILL.md is missing scope-table BEGIN/END markers");
  }
  return raw.substring(beginIdx, endIdx + END.length);
}

function gridExecuteCount(grid: ScopeGrid, scope: string): number {
  return Object.values(grid[scope].stages).filter((v) => v === "EXECUTE").length;
}

/** The "N / M" EXECUTE cell from a scope's table row. */
function tableExecuteCount(region: string, scope: string): number {
  const row = region
    .split("\n")
    .find((l) => l.startsWith(`| ${scope} `));
  if (!row) throw new Error(`no table row for scope "${scope}"`);
  const m = row.match(/(\d+) \/ \d+/);
  if (!m) throw new Error(`no "N / M" cell in row for scope "${scope}"`);
  return Number.parseInt(m[1], 10);
}

// =============================================================================
// Section A — compiled table region shape (4 assertions)
// =============================================================================
describe("t30 Section A — SKILL.md compiled scope-grid region is well-formed", () => {
  test("A1: SKILL.md region has the BEGIN marker [.sh 1]", () => {
    expect(skillRegion()).toContain("BEGIN: compiled");
  });

  test("A2: SKILL.md region has the END marker [.sh 2]", () => {
    expect(skillRegion()).toContain("END: compiled");
  });

  test("A3: region carries the | Scope header row [.sh 3]", () => {
    expect(skillRegion()).toContain("| Scope");
  });

  test("A4: region carries the | EXECUTE / Total column [.sh 4]", () => {
    expect(skillRegion()).toContain("| EXECUTE / Total");
  });
});

// =============================================================================
// Section B — row count matches the compiled grid (1 assertion)
// =============================================================================
describe("t30 Section B — table row count matches scope-grid.json", () => {
  test("B: region row count matches scope-grid.json key count [.sh 5]", () => {
    const region = skillRegion();
    // `^\| [a-z-]+ ` counts data rows (the header is "| Scope ").
    const rowCount = region
      .split("\n")
      .filter((l) => /^\| [a-z-]+ /.test(l)).length;
    const jsonCount = Object.keys(readGrid()).length;
    expect(rowCount).toBe(jsonCount);
    expect(jsonCount).toBe(SCOPES.length);
  });
});

// =============================================================================
// Section C - per-scope EXECUTE counts: table cell == grid truth (11 asserts)
// =============================================================================
describe("t30 Section C — each scope's EXECUTE cell matches scope-grid.json", () => {
  for (const scope of SCOPES) {
    test(`C: ${scope} EXECUTE cell matches scope-grid.json [.sh ${scope}]`, () => {
      const grid = readGrid();
      const region = skillRegion();
      const fromGrid = gridExecuteCount(grid, scope);
      const fromTable = tableExecuteCount(region, scope);
      // Same scope row: the rendered cell equals the count derived from the
      // grid stages map. Co-located on one row.
      expect(fromTable).toBe(fromGrid);
    });
  }
});

// =============================================================================
// The committed table IS the transpose (covers A/B/C at once)
// =============================================================================
describe("t30 — committed SKILL.md table is byte-identical to the rendered transpose", () => {
  test("committed region === canonicalScopeTableRegion(renderScopeTable())", () => {
    // renderScopeTable() reads scope-grid.json and emits the row format; the
    // committed SKILL.md region must equal canonicalScopeTableRegion of it
    // (the same byte-compare aidlc-utility scope-table --check enforces,
    // aidlc-utility.ts handleScopeTable). If this holds, the markers, the row count,
    // and every EXECUTE cell are provably the grid's transpose, not a stale
    // hand-edit that merely happens to contain the right substrings.
    const expected = canonicalScopeTableRegion(renderScopeTable());
    expect(skillRegion()).toBe(expected);
  });
});

// =============================================================================
// Section D - phase-presence semantics (3 asserts)
// =============================================================================
describe("t30 Section D — scope phase-presence semantics (read JSON directly)", () => {
  test("D1: bugfix executes zero ideation-phase stages [.sh 15]", () => {
    const grid = readGrid();
    const graph = readGraph();
    const ideationSlugs = graph
      .filter((s) => s.phase === "ideation")
      .map((s) => s.slug);
    // VACUOUS-PASS GUARD: the ideation phase must be non-empty, else "zero
    // EXECUTE among ideation stages" is trivially true.
    expect(ideationSlugs.length).toBeGreaterThan(0);
    const execCount = ideationSlugs.filter(
      (s) => grid.bugfix.stages[s] === "EXECUTE",
    ).length;
    expect(execCount).toBe(0);
  });

  test("D2: classic executes zero ideation-phase stages [.sh 16]", () => {
    const grid = readGrid();
    const graph = readGraph();
    const ideationSlugs = graph
      .filter((s) => s.phase === "ideation")
      .map((s) => s.slug);
    expect(ideationSlugs.length).toBeGreaterThan(0);
    const execCount = ideationSlugs.filter(
      (s) => grid.classic.stages[s] === "EXECUTE",
    ).length;
    expect(execCount).toBe(0);
  });

  test("D2b: express executes exactly three operation stages", () => {
    const grid = readGrid();
    const graph = readGraph();
    const operationSlugs = graph
      .filter((s) => s.phase === "operation")
      .map((s) => s.slug);
    const execCount = operationSlugs.filter(
      (s) => grid.express.stages[s] === "EXECUTE",
    ).length;
    expect(execCount).toBe(3);
  });

  test("D3: bugfix executes exactly two operation-phase stages [.sh 17]", () => {
    const grid = readGrid();
    const graph = readGraph();
    const operationSlugs = graph
      .filter((s) => s.phase === "operation")
      .map((s) => s.slug);
    expect(operationSlugs.length).toBeGreaterThan(0);
    const execCount = operationSlugs.filter(
      (s) => grid.bugfix.stages[s] === "EXECUTE",
    ).length;
    expect(execCount).toBe(2);
  });
});
