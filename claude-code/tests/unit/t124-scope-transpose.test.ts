// covers: function:transposeScopeGrid, function:canonicalScopeGridJson, function:compileStageGraph, function:subgraphForScope, subcommand:aidlc-graph:compile
//
// t124 — scope-shape transpose: per-stage `scopes:` frontmatter -> the
// compiled EXECUTE/SKIP grid (scope-grid.json). Migrated from
// tests/unit/t124-scope-transpose.sh (TAP plan 12). milestone 12 moved scope
// membership off scope-mapping.json onto each stage's `scopes:` list;
// `aidlc-graph compile` transposes those lists into scope-grid.json
// (a PURE transpose — no graph-closure, no predicate), emitted through the
// canonical sole-writer + drift-guarded by `compile --check`, the same
// discipline that protects stage-graph.json.
//
// Mechanism: MIXED (body-derived). The transpose semantics, canonical
// emitter, deterministic recompile, and grid<->subgraph parity are PURE
// in-process imports (mechanism none — zero LLM, zero tokens). The four
// process-boundary rows — `compile` writing scope-grid.json to disk, and
// `compile --check`'s exit codes on clean / stale / missing grids — drive
// the real CLI via spawnSync against the BUN runtime, isolated through the
// AIDLC_STAGE_GRAPH + AIDLC_SCOPE_GRID env seams (aidlc-graph.ts:161-185).
// process.exit(1) on drift (aidlc-graph.ts:1219,1236) is only observable on
// the spawned process's exit code, so those four stay spawns deliberately.
//
// Source under test (dist/claude/.claude/tools/aidlc-graph.ts):
//   :971  transposeScopeGrid(stages): ScopeGrid
//          - scope columns = SORTED UNION of every name any stage declares
//          - a stage naming a scope => EXECUTE under it; every other cell SKIP
//          - pure, no I/O
//   :992  canonicalScopeGridJson(grid): string
//          - JSON.stringify(grid, null, 2) + "\n"  (sole-writer, trailing NL)
//   :1013 compileStageGraph(): { json, gridJson, stages }
//          - gridJson = canonicalScopeGridJson(transposeScopeGrid(stages)) (:1146)
//   :740  subgraphForScope(scope): GraphStage[]
//          - the EXECUTE slice the grid drives, in numeric stage order
//   :1212 runCompileCheck(): byte-compares both compiled artifacts to disk;
//          process.exit(1) on stale/missing grid (:1232-1237)
//   :1293 compile CLI handler: writeFileAtomic(scopeGridPath(), gridJson) (:1308)
//   :183  scopeGridPath(): AIDLC_SCOPE_GRID ?? data/scope-grid.json (env seam)
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  (transposeScopeGrid is a callable export)        -> "transposeScopeGrid is a callable export"
//   .sh test 2  (scope columns = sorted union)                   -> "scope columns are the sorted union of declared names"
//   .sh test 3  (alpha: EXECUTE,SKIP,SKIP)                        -> "a stage naming a scope is EXECUTE under it; non-naming stages SKIP"
//   .sh test 4  (beta: EXECUTE,EXECUTE,SKIP)                      -> "two stages naming a scope both EXECUTE under it"
//   .sh test 5  (compile emits scope-grid.json)                  -> CLI "compile emits scope-grid.json beside stage-graph.json"
//   .sh test 6  (gridJson byte-identical across two compiles)    -> "compileStageGraph().gridJson is byte-identical across compiles"
//   .sh test 7  (canonicalScopeGridJson trailing newline)        -> "canonicalScopeGridJson emits a trailing newline"
//   .sh test 8  (canonicalScopeGridJson byte-stable)             -> "canonicalScopeGridJson is byte-stable across calls"
//   .sh test 9  (compile --check clean tree exits 0)             -> CLI "compile --check on a clean tree exits 0"
//   .sh test 10 (compile --check stale grid exits 1)             -> CLI "compile --check exits 1 on a stale scope-grid.json (drift guard)"
//   .sh test 11 (compile --check missing grid exits 1)           -> CLI "compile --check exits 1 when scope-grid.json is missing"
//   .sh test 12 (grid EXECUTE set == subgraphForScope, 9 scopes) -> "shipped grid EXECUTE set is cell-identical to subgraphForScope for all 9 scopes"

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import {
  __resetGraphCache,
  canonicalScopeGridJson,
  compileStageGraph,
  loadGraph,
  subgraphForScope,
  transposeScopeGrid,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";

const BUN = process.execPath; // the bun running this test
const GRAPH_TOOL = join(AIDLC_SRC, "tools", "aidlc-graph.ts");
const GRAPH_JSON = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const GRID_JSON = join(AIDLC_SRC, "tools", "data", "scope-grid.json");

// The nine scopes the shipped grid carries — the .sh's hard-coded list.
const SCOPES = [
  "enterprise",
  "feature",
  "mvp",
  "poc",
  "bugfix",
  "refactor",
  "infra",
  "security-patch",
  "workshop",
];

const tempFiles: string[] = [];

afterAll(() => {
  for (const f of tempFiles) rmSync(f, { recursive: true, force: true });
});

/** A throwaway grid/graph sandbox path under tmp, registered for teardown. */
function mkTempPath(tag: string): string {
  const p = join(
    mkdtempSync(join(tmpdir(), "aidlc-t124-")),
    `${tag}.json`,
  );
  tempFiles.push(join(p, ".."));
  return p;
}

/**
 * Run `bun aidlc-graph.ts <args>` with AIDLC_STAGE_GRAPH / AIDLC_SCOPE_GRID
 * pointed at sandbox copies — the .sh's env-isolation seam, so the real
 * shipped grid is never touched. Returns the spawnSync result (status +
 * captured streams).
 */
function runGraph(args: string[], graphPath: string, gridPath: string) {
  return spawnSync(BUN, [GRAPH_TOOL, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_STAGE_GRAPH: graphPath,
      AIDLC_SCOPE_GRID: gridPath,
    },
  });
}

// ===========================================================================
// Pure transpose semantics on a synthetic 3-stage / 2-scope input (none).
// .sh tests 2-4 hand transposeScopeGrid a literal {slug,number,scopes} array.
// ===========================================================================
describe("transposeScopeGrid() — pure transpose (in-process)", () => {
  test("transposeScopeGrid is a callable export [.sh test 1]", () => {
    expect(typeof transposeScopeGrid).toBe("function");
  });

  // The synthetic input the .sh built: stage a -> {alpha,beta}, b -> {beta},
  // c -> {} (no scopes). transposeScopeGrid only reads slug + scopes.
  const synthetic = [
    { slug: "a", number: "0.1", scopes: ["alpha", "beta"] },
    { slug: "b", number: "0.2", scopes: ["beta"] },
    { slug: "c", number: "0.3", scopes: [] },
  ] as unknown as Parameters<typeof transposeScopeGrid>[0];

  test("scope columns are the sorted union of declared names [.sh test 2]", () => {
    const g = transposeScopeGrid(synthetic);
    // STRONGER than the .sh's "alpha,beta" join: assert exact key order AND
    // membership — c declares no scope, so it contributes no column.
    expect(Object.keys(g)).toEqual(["alpha", "beta"]);
  });

  test("a stage naming a scope is EXECUTE under it; non-naming stages SKIP [.sh test 3]", () => {
    const g = transposeScopeGrid(synthetic);
    // alpha column: only stage a named it.
    expect(g.alpha.stages).toEqual({ a: "EXECUTE", b: "SKIP", c: "SKIP" });
  });

  test("two stages naming a scope both EXECUTE under it [.sh test 4]", () => {
    const g = transposeScopeGrid(synthetic);
    // beta column: a and b both named it; c did not.
    expect(g.beta.stages).toEqual({ a: "EXECUTE", b: "EXECUTE", c: "SKIP" });
  });
});

// ===========================================================================
// Canonical emitter + deterministic recompile (none).
// .sh tests 6, 7, 8.
// ===========================================================================
describe("canonicalScopeGridJson() + compileStageGraph() determinism (in-process)", () => {
  test("canonicalScopeGridJson emits a trailing newline [.sh test 7]", () => {
    const s = canonicalScopeGridJson(transposeScopeGrid(loadGraph()));
    expect(s.endsWith("\n")).toBe(true);
  });

  test("canonicalScopeGridJson is byte-stable across calls [.sh test 8]", () => {
    const g = transposeScopeGrid(loadGraph());
    const h1 = createHash("sha256").update(canonicalScopeGridJson(g)).digest("hex");
    const h2 = createHash("sha256").update(canonicalScopeGridJson(g)).digest("hex");
    expect(h1).toBe(h2);
  });

  test("compileStageGraph().gridJson is byte-identical across compiles [.sh test 6]", () => {
    const h1 = createHash("sha256")
      .update(compileStageGraph().gridJson)
      .digest("hex");
    // The .sh reset the module cache between the two compiles to prove the
    // determinism survives a cold reload, not just memoisation.
    __resetGraphCache();
    const h2 = createHash("sha256")
      .update(compileStageGraph().gridJson)
      .digest("hex");
    expect(h1).toBe(h2);
  });
});

// ===========================================================================
// Grid <-> subgraph parity for all 9 shipped scopes (none).
// .sh test 12: the shipped grid's EXECUTE set per scope == subgraphForScope's
// slugs per scope. The grid is the source the subgraph reads, so this is the
// round-trip invariant the runtime relies on.
// ===========================================================================
describe("scope-grid <-> subgraphForScope parity (in-process)", () => {
  test("shipped grid EXECUTE set is cell-identical to subgraphForScope for all 9 scopes [.sh test 12]", () => {
    const grid = JSON.parse(readFileSync(GRID_JSON, "utf-8")) as Record<
      string,
      { stages: Record<string, "EXECUTE" | "SKIP"> }
    >;
    const mismatches: string[] = [];
    for (const sc of SCOPES) {
      const execFromGrid = Object.entries(grid[sc].stages)
        .filter(([, action]) => action === "EXECUTE")
        .map(([slug]) => slug)
        .sort();
      const execFromSub = subgraphForScope(sc)
        .map((s) => s.slug)
        .sort();
      if (JSON.stringify(execFromGrid) !== JSON.stringify(execFromSub)) {
        mismatches.push(sc);
      }
    }
    // STRONGER than the .sh's ALL_MATCH string: assert no scope mismatched
    // AND that every scope was actually compared (all 9 present in the grid).
    expect(mismatches).toEqual([]);
    expect(SCOPES.every((sc) => grid[sc] !== undefined)).toBe(true);
  });
});

// ===========================================================================
// CLI env-seam cases (spawnSync) — the process-boundary rows.
// .sh tests 5, 9, 10, 11. These assert disk side-effects + exit codes that
// only the spawned `compile` / `compile --check` produce (process.exit(1) on
// drift is invisible to an in-process import).
// ===========================================================================
describe("aidlc-graph compile / --check (Bun spawnSync env seam)", () => {
  test("compile emits scope-grid.json beside stage-graph.json [.sh test 5]", () => {
    const graphPath = mkTempPath("graph");
    const gridPath = mkTempPath("grid");
    copyFileSync(GRAPH_JSON, graphPath);
    // Grid intentionally absent before compile.
    expect(existsSync(gridPath)).toBe(false);
    const r = runGraph(["compile"], graphPath, gridPath);
    expect(r.status).toBe(0);
    // The .sh asserted `[ -s "$TMP_GRID" ]` (exists AND non-empty).
    expect(existsSync(gridPath)).toBe(true);
    expect(statSync(gridPath).size).toBeGreaterThan(0);
  }, 30000);

  test("compile --check on a clean tree (graph + grid) exits 0 [.sh test 9]", () => {
    const graphPath = mkTempPath("graph");
    const gridPath = mkTempPath("grid");
    copyFileSync(GRAPH_JSON, graphPath);
    copyFileSync(GRID_JSON, gridPath);
    const r = runGraph(["compile", "--check"], graphPath, gridPath);
    expect(r.status).toBe(0);
  }, 30000);

  test("compile --check exits 1 on a stale scope-grid.json (drift guard) [.sh test 10]", () => {
    const graphPath = mkTempPath("graph");
    const gridPath = mkTempPath("grid");
    copyFileSync(GRAPH_JSON, graphPath);
    copyFileSync(GRID_JSON, gridPath);
    // Flip exactly one cell so the on-disk grid no longer matches the transpose
    // — the same single-cell mutation the .sh applied via bun -e.
    const j = JSON.parse(readFileSync(gridPath, "utf-8")) as Record<
      string,
      { stages: Record<string, "EXECUTE" | "SKIP"> }
    >;
    const firstScope = Object.keys(j)[0];
    const firstStage = Object.keys(j[firstScope].stages)[0];
    j[firstScope].stages[firstStage] =
      j[firstScope].stages[firstStage] === "EXECUTE" ? "SKIP" : "EXECUTE";
    writeFileSync(gridPath, `${JSON.stringify(j, null, 2)}\n`, "utf-8");
    const r = runGraph(["compile", "--check"], graphPath, gridPath);
    expect(r.status).toBe(1);
    // STRONGER than the .sh (exit-code only): the drift message names the
    // grid artifact, proving it was the grid check that tripped, not the
    // graph check (which sees an unmodified copy).
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain(
      "scope-grid.json is out of date",
    );
  }, 30000);

  test("compile --check exits 1 when scope-grid.json is missing [.sh test 11]", () => {
    const graphPath = mkTempPath("graph");
    const gridPath = mkTempPath("grid");
    copyFileSync(GRAPH_JSON, graphPath);
    // gridPath never created -> missing grid is treated like a stale one
    // (aidlc-graph.ts:1226-1237 reads "" on ENOENT, then byte-compares).
    expect(existsSync(gridPath)).toBe(false);
    const r = runGraph(["compile", "--check"], graphPath, gridPath);
    expect(r.status).toBe(1);
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain(
      "scope-grid.json is out of date",
    );
  }, 30000);
});
