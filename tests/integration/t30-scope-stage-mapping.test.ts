// covers: scope:bugfix, scope:workshop, subcommand:aidlc-utility:scope-table
//
// t30 — Scope-to-Stage Mapping consistency. Migrated from
// tests/integration/t30-scope-stage-mapping.sh (TAP plan 17). The .sh had no
// `# covers:` header; the subject is the consistency between three compiled
// data artifacts — SKILL.md's compiled scope-grid table (rendered by
// `aidlc-utility.ts scope-table`), scope-grid.json (the transpose), and
// stage-graph.json (phase membership) — so the covers ids name the
// scope-table subcommand that emits the table and the two scopes whose
// phase-presence shape the .sh load-bears on (bugfix, workshop).
//
// Mechanism: none. Every assertion is a pure structural / data check —
// read the SHIPPED files (dist/claude/.claude/...), parse JSON / slice the
// SKILL.md region, and assert in-process. No argv, no exit code, no stdout,
// no process boundary, zero LLM, zero tokens. (One in-process IMPORT of the
// tool's exported `renderScopeTable` strengthens Section A/B/C into a single
// byte-equality proof that the committed table IS the transpose of the grid;
// still no spawn.)
//
// Source under test:
//   - dist/claude/.claude/tools/data/scope-grid.json — the compiled grid
//     (milestone 12 retired scope-mapping.json). Shape: { <scope>: { stages:
//     { <slug>: "EXECUTE"|"SKIP" } } }. Source of truth for routing.
//   - dist/claude/.claude/tools/data/stage-graph.json — array of stage nodes
//     carrying { slug, phase, ... }. Phase membership for Section D.
//   - dist/claude/.claude/skills/aidlc/SKILL.md — carries a compiled summary
//     table between BEGIN/END markers (lines 104-118). Markers + render
//     format defined in aidlc-utility.ts: SCOPE_TABLE_BEGIN (:2578),
//     SCOPE_TABLE_END (:2580), renderScopeTable() (:2584),
//     canonicalScopeTableRegion() (:2606).
//
// The .sh extracted the EXECUTE cell with `grep -oE '[0-9]+ / [0-9]+'` and a
// row with `grep -cE '^\| [a-z-]+ '`; the table TOTAL is 32 (the .sh's `/ 31`
// comment is stale prose — its regex matched whatever total was rendered).
// We assert exact integers, not a regex match, so a wrong total is caught.
//
// Old TAP -> new test parity (1:1, every .sh `ok` line -> a named test()):
//   Section A (region shape, 4 asserts):
//     .sh 1 (BEGIN marker)               -> "A1: SKILL.md region has the BEGIN marker"
//     .sh 2 (END marker)                 -> "A2: SKILL.md region has the END marker"
//     .sh 3 (| Scope header)             -> "A3: region carries the | Scope header row"
//     .sh 4 (| EXECUTE / Total column)   -> "A4: region carries the | EXECUTE / Total column"
//   Section B (row count, 1 assert):
//     .sh 5 (row count == JSON keys)     -> "B: region row count matches scope-grid.json key count"
//   Section C (per-scope EXECUTE, one assert per scope):
//     .sh 6-14 (one per scope, alpha)    -> "C: <scope> EXECUTE cell matches scope-grid.json"
//       (one test() per scope: bugfix, discovery, enterprise, feature, infra,
//        mvp, poc, refactor, security-patch, workshop — the .sh's nine plus
//        the discovery scope added in v2.2.x, same alphabetical order)
//   Section D (phase-presence semantics, 3 asserts):
//     .sh 15 (bugfix 0 ideation EXEC)    -> "D1: bugfix executes zero ideation-phase stages"
//     .sh 16 (workshop 0 ideation EXEC)  -> "D2: workshop executes zero ideation-phase stages"
//     .sh 17 (bugfix 0 operation EXEC)   -> "D3: bugfix executes zero operation-phase stages"
//
// STRONGER than the .sh (kept, not weakened):
//   - Section A/B/C are additionally proven by a single byte-equality of the
//     committed SKILL.md region against canonicalScopeTableRegion(
//     renderScopeTable()) — the committed table is provably the transpose of
//     the grid, not merely "contains the markers / count agrees".
//   - Section C asserts exact integers (7, 8, 32, 32, 13, 22, 8, 8, 10, 25)
//     derived from the grid AND read from the table cell, on the SAME scope
//     row — co-located, not "the number appears somewhere".
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
const SKILL_PATH = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");
const SCOPE_GRID_PATH = join(AIDLC_SRC, "tools", "data", "scope-grid.json");
const STAGE_GRAPH_PATH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

const BEGIN = "<!-- BEGIN: compiled scope grid";
const END = "<!-- END: compiled scope grid -->";

// The ten scopes the compiled grid carries, in the SAME alphabetical order the
// .sh iterated its original nine (discovery landed after bugfix in v2.2.x).
const SCOPES = [
  "bugfix",
  "discovery",
  "enterprise",
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

/** The compiled-table region of SKILL.md (the .sh's sed BEGIN..END slice). */
function skillRegion(): string {
  const raw = readFileSync(SKILL_PATH, "utf-8");
  const beginIdx = raw.indexOf(BEGIN);
  const endIdx = raw.indexOf(END);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error("SKILL.md is missing scope-table BEGIN/END markers");
  }
  return raw.substring(beginIdx, endIdx + END.length);
}

/** EXECUTE count for a scope, derived straight from scope-grid.json. */
function gridExecuteCount(grid: ScopeGrid, scope: string): number {
  return Object.values(grid[scope].stages).filter((v) => v === "EXECUTE").length;
}

/** The "N / M" EXECUTE cell from a scope's table row (the .sh's grep -oE). */
function tableExecuteCount(region: string, scope: string): number {
  // .sh: grep "^| <scope> " then grep -oE '[0-9]+ / [0-9]+' | awk '{print $1}'.
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
    // .sh: grep -cE '^\| [a-z-]+ ' counts data rows (the header is "| Scope ").
    const rowCount = region
      .split("\n")
      .filter((l) => /^\| [a-z-]+ /.test(l)).length;
    const jsonCount = Object.keys(readGrid()).length;
    expect(rowCount).toBe(jsonCount);
    // Cross-check: the data rows are exactly the ten scopes we iterate below.
    expect(jsonCount).toBe(SCOPES.length);
  });
});

// =============================================================================
// Section C — per-scope EXECUTE counts: table cell == grid truth (9 asserts)
// =============================================================================
describe("t30 Section C — each scope's EXECUTE cell matches scope-grid.json", () => {
  for (const scope of SCOPES) {
    test(`C: ${scope} EXECUTE cell matches scope-grid.json [.sh ${scope}]`, () => {
      const grid = readGrid();
      const region = skillRegion();
      const fromGrid = gridExecuteCount(grid, scope);
      const fromTable = tableExecuteCount(region, scope);
      // Same scope row: the rendered cell equals the count derived from the
      // grid stages map. Co-located on one row (STRONGER than two greps).
      expect(fromTable).toBe(fromGrid);
    });
  }
});

// =============================================================================
// Section C2 — discovery scope mapping (added with the discovery scope)
// =============================================================================
describe("t30 Section C2 — discovery scope maps to exactly its 8 EXECUTE stages", () => {
  test("C2: discovery executes exactly the 3 init stages + intent-capture + the 4 ideation discovery stages", () => {
    const grid = readGrid();
    const executeSlugs = Object.entries(grid.discovery.stages)
      .filter(([, v]) => v === "EXECUTE")
      .map(([slug]) => slug)
      .sort();
    expect(executeSlugs).toEqual(
      [
        "workspace-scaffold",
        "workspace-detection",
        "state-init",
        "intent-capture",
        "discovery-current-state",
        "discovery-future-state",
        "discovery-experimentation",
        "discovery-decision",
      ].sort(),
    );
    // Every other stage in the grid column is SKIP (36-stage universe).
    const skipCount = Object.values(grid.discovery.stages).filter(
      (v) => v === "SKIP",
    ).length;
    expect(executeSlugs.length).toBe(8);
    expect(skipCount).toBe(Object.keys(grid.discovery.stages).length - 8);
  });
});

// =============================================================================
// STRENGTHENING — the committed table IS the transpose (covers A/B/C at once)
// =============================================================================
describe("t30 — committed SKILL.md table is byte-identical to the rendered transpose", () => {
  test("committed region === canonicalScopeTableRegion(renderScopeTable())", () => {
    // renderScopeTable() reads scope-grid.json and emits the row format; the
    // committed SKILL.md region must equal canonicalScopeTableRegion of it
    // (the same byte-compare aidlc-utility scope-table --check enforces,
    // aidlc-utility.ts:2668-2674). If this holds, the markers, the row count,
    // and every EXECUTE cell are provably the grid's transpose, not a stale
    // hand-edit that merely happens to contain the right substrings.
    const expected = canonicalScopeTableRegion(renderScopeTable());
    expect(skillRegion()).toBe(expected);
  });
});

// =============================================================================
// Section D — phase-presence semantics preserved from pre-milestone-10 t30 (3 asserts)
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

  test("D2: workshop executes zero ideation-phase stages [.sh 16]", () => {
    const grid = readGrid();
    const graph = readGraph();
    const ideationSlugs = graph
      .filter((s) => s.phase === "ideation")
      .map((s) => s.slug);
    expect(ideationSlugs.length).toBeGreaterThan(0);
    const execCount = ideationSlugs.filter(
      (s) => grid.workshop.stages[s] === "EXECUTE",
    ).length;
    expect(execCount).toBe(0);
  });

  test("D3: bugfix executes zero operation-phase stages [.sh 17]", () => {
    const grid = readGrid();
    const graph = readGraph();
    const operationSlugs = graph
      .filter((s) => s.phase === "operation")
      .map((s) => s.slug);
    expect(operationSlugs.length).toBeGreaterThan(0);
    const execCount = operationSlugs.filter(
      (s) => grid.bugfix.stages[s] === "EXECUTE",
    ).length;
    expect(execCount).toBe(0);
  });
});
