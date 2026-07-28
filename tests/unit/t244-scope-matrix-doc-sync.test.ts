// covers: doc:docs/guide/05-scopes-and-depth.md(scope-stage-matrix), file:tools/data/scope-grid.json, file:tools/data/stage-graph.json
//
// t244 — Doc drift guard for the Stage-by-Scope Matrix in
// docs/guide/05-scopes-and-depth.md.
//
// Mechanism: none. Every byte inspected is a static file checked into the
// repo: the compiled grid + graph under dist/claude/.claude/tools/data/ and
// the guide chapter. No spawn, no LLM, no env seam.
//
// Subject (two ground-truth sources cross-checked against the doc table):
//   A. dist/claude/.claude/tools/data/scope-grid.json  — the EXECUTE/SKIP
//        grid, itself a drift-guarded transpose of each stage's `scopes:`
//        frontmatter (t124 pins the transpose; `aidlc-graph compile --check`
//        pins the bytes). This chain means the doc table is transitively
//        pinned to the authored frontmatter without re-parsing it here.
//   B. dist/claude/.claude/tools/data/stage-graph.json — stage numbers,
//        display names, and phases (drives row identity + ordering).
//   C. docs/guide/05-scopes-and-depth.md               — the markdown table
//        between the `<!-- BEGIN scope-stage-matrix ... -->` /
//        `<!-- END scope-stage-matrix -->` markers: one collapsed
//        initialization row (0.1–0.3, all-scope), one row per
//        non-initialization stage (✓ = EXECUTE, empty = SKIP), and a
//        per-scope **Total stages** footer.
//
// This mirrors t132's discipline: derive the truth independently, then
// assert the doc agrees in BOTH directions (forward: every grid cell is
// rendered correctly; reverse: the doc has no extra/duplicate/unknown rows
// or columns, and its own totals row is arithmetically consistent with its
// cells). Adding a scope, retagging a stage's `scopes:` list, or renaming a
// stage recompiles the grid/graph and trips this test until the doc table is
// regenerated to match.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";

const GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");
const GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const DOC = join(REPO_ROOT, "docs", "guide", "05-scopes-and-depth.md");

const BEGIN_MARKER = "<!-- BEGIN scope-stage-matrix";
const END_MARKER = "<!-- END scope-stage-matrix -->";
const CHECK = "\u2713"; // ✓
const INIT_ROW_LABEL = "0.1\u20130.3"; // 0.1–0.3 (en dash)

// --- Ground truth A: the compiled EXECUTE/SKIP grid --------------------------
type ScopeGrid = Record<string, { stages: Record<string, string> }>;
const grid = JSON.parse(readFileSync(GRID, "utf-8")) as ScopeGrid;

// --- Ground truth B: stage numbers/names/phases ------------------------------
interface GraphStage {
  slug: string;
  number: string;
  name: string;
  phase: string;
}
const graph = JSON.parse(readFileSync(GRAPH, "utf-8")) as GraphStage[];
const initStages = graph.filter((s) => s.phase === "initialization");
const bodyStages = graph.filter((s) => s.phase !== "initialization");

// --- Doc region + structural table parse -------------------------------------
interface DocTable {
  /** scope column names, backticks stripped, in doc order */
  scopes: string[];
  /** collapsed initialization row cells (per scope column) */
  initCells: string[];
  /** stage number -> { name, cells (per scope column) } */
  rows: Map<string, { name: string; cells: string[] }>;
  /** stage numbers in doc order (for duplicate detection) */
  rowNumbers: string[];
  /** per-scope totals from the footer row */
  totals: number[];
}

function extractRegion(): string {
  const doc = readFileSync(DOC, "utf-8");
  const begin = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error("scope-stage-matrix markers missing or out of order");
  }
  // Validate the BEGIN marker line is a complete HTML comment (ends with -->).
  const beginLineEnd = doc.indexOf("\n", begin);
  const beginLine = doc.slice(begin, beginLineEnd === -1 ? undefined : beginLineEnd);
  if (!beginLine.trimEnd().endsWith("-->")) {
    throw new Error("BEGIN marker is not a complete HTML comment (missing closing -->)");
  }
  // A second BEGIN would mean a stale duplicate of the table elsewhere.
  if (doc.indexOf(BEGIN_MARKER, begin + 1) !== -1) {
    throw new Error("duplicate scope-stage-matrix BEGIN marker");
  }
  return doc.slice(begin, end);
}

/** Split a markdown table row into trimmed cells (drops the outer pipes). */
function cells(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const INIT_STAGE_LABEL = `Initialization (all ${initStages.length} stages)`;
const TOTALS_LABEL = "**Total stages**";

/** Validate that a line is a well-formed Markdown table separator with the expected column count. */
function validateSeparator(line: string, expectedColumns: number): void {
  const sepCells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  if (sepCells.length !== expectedColumns) {
    throw new Error(
      `separator column count (${sepCells.length}) does not match header (${expectedColumns})`,
    );
  }
  for (const cell of sepCells) {
    if (!/^:?-{3,}:?$/.test(cell)) {
      throw new Error(`invalid separator cell: "${cell}" — expected a Markdown delimiter (e.g. ---, :---:)`);
    }
  }
}

function parseDocTable(): DocTable {
  const allLines = extractRegion().split("\n");
  const pipeIndices = allLines
    .map((l, i) => (l.trim().startsWith("|") ? i : -1))
    .filter((i) => i !== -1);
  if (pipeIndices.length < 3) throw new Error("matrix table not found inside markers");
  // The table must be one contiguous block — no blank lines mid-table.
  for (let i = 1; i < pipeIndices.length; i++) {
    if (pipeIndices[i] !== pipeIndices[i - 1] + 1) {
      throw new Error(
        `table is not contiguous: gap at line ${pipeIndices[i - 1] + 1} — blank or non-pipe line interrupts the Markdown table`,
      );
    }
  }
  const lines = pipeIndices.map((i) => allLines[i]);

  const header = cells(lines[0]);
  // Validate the fixed header columns.
  if (header[0] !== "#") {
    throw new Error(`expected header[0] to be "#", got "${header[0]}"`);
  }
  if (header[1] !== "Stage") {
    throw new Error(`expected header[1] to be "Stage", got "${header[1]}"`);
  }
  // header: [ "#", "Stage", "`scope`", ... ]
  const scopes = header.slice(2).map((c) => c.replace(/`/g, ""));

  // Validate the separator row (lines[1]) is a proper Markdown delimiter.
  validateSeparator(lines[1], header.length);

  let initCells: string[] | undefined;
  const rows = new Map<string, { name: string; cells: string[] }>();
  const rowNumbers: string[] = [];
  let totals: number[] | undefined;

  for (const line of lines.slice(2)) {
    const c = cells(line);
    if (c.length !== header.length) {
      throw new Error(
        `row column count (${c.length}) does not match header (${header.length}): "${line.trim()}"`,
      );
    }
    const [num, label] = [c[0], c[1]];
    const body = c.slice(2);
    if (num === INIT_ROW_LABEL) {
      if (initCells) throw new Error("duplicate collapsed initialization row");
      if (label !== INIT_STAGE_LABEL) {
        throw new Error(
          `initialization row label mismatch: expected "${INIT_STAGE_LABEL}", got "${label}"`,
        );
      }
      for (const cell of body) {
        if (cell !== CHECK && cell !== "") {
          throw new Error(`invalid cell content in initialization row: "${cell}" — expected "${CHECK}" or empty`);
        }
      }
      initCells = body;
    } else if (num === "" && label === TOTALS_LABEL) {
      if (totals) throw new Error("duplicate **Total stages** footer row");
      totals = body.map((t) => {
        const stripped = t.replace(/\*/g, "");
        if (!/^\d+$/.test(stripped)) {
          throw new Error(`non-numeric total cell: "${t}"`);
        }
        return Number.parseInt(stripped, 10);
      });
    } else {
      if (rows.has(num)) throw new Error(`duplicate stage row: ${num}`);
      for (const cell of body) {
        if (cell !== CHECK && cell !== "") {
          throw new Error(`invalid cell content in stage ${num}: "${cell}" — expected "${CHECK}" or empty`);
        }
      }
      rowNumbers.push(num);
      rows.set(num, { name: label, cells: body });
    }
  }
  if (!initCells) throw new Error("collapsed initialization row (0.1\u20130.3) not found");
  if (!totals) throw new Error("**Total stages** footer row not found");
  return { scopes, initCells, rows, rowNumbers, totals };
}

const doc = parseDocTable();

describe("t244 stage-by-scope matrix doc drift guard", () => {
  // --- Ground truth sanity ---
  test("1: ground truth — compiled grid and graph are non-empty and consistent", () => {
    expect(Object.keys(grid).length).toBeGreaterThan(0);
    expect(graph.length).toBeGreaterThan(0);
    expect(initStages.length).toBe(3);
    // The collapsed init-row label must match the actual init stage numbers from the graph.
    const initNums = initStages.map((s) => s.number);
    expect(INIT_ROW_LABEL).toBe(`${initNums[0]}\u2013${initNums[initNums.length - 1]}`);
    // Every grid column covers exactly the graph's stage set.
    const slugs = graph.map((s) => s.slug).sort();
    for (const scope of Object.keys(grid)) {
      expect(Object.keys(grid[scope].stages).sort()).toEqual(slugs);
    }
  });

  // --- Columns: doc scope set == compiled grid scope set ---
  test("2: columns — doc scope columns equal the compiled grid's scopes (no missing, extra, or duplicate)", () => {
    expect(new Set(doc.scopes).size).toBe(doc.scopes.length);
    expect([...doc.scopes].sort()).toEqual(Object.keys(grid).sort());
  });

  // --- Rows forward: every non-initialization stage is a row, correctly named ---
  test("3: rows forward — every non-initialization stage appears once with its graph number and name", () => {
    for (const s of bodyStages) {
      const row = doc.rows.get(s.number);
      expect(row, `missing row for stage ${s.number} (${s.slug})`).toBeDefined();
      expect(row!.name).toBe(s.name);
    }
  });

  // --- Rows reverse: the doc has no unknown or duplicate stage rows ---
  test("4: rows reverse — no unknown or duplicate stage rows in the doc, in document order", () => {
    expect(new Set(doc.rowNumbers).size).toBe(doc.rowNumbers.length);
    expect(doc.rowNumbers).toEqual(bodyStages.map((s) => s.number));
  });

  // --- Cells: every ✓/empty cell matches the grid's EXECUTE/SKIP ---
  test("5: cells — every stage-row cell matches the compiled EXECUTE/SKIP grid", () => {
    for (const s of bodyStages) {
      const row = doc.rows.get(s.number)!;
      expect(row.cells.length).toBe(doc.scopes.length);
      doc.scopes.forEach((scope, i) => {
        const expected = grid[scope].stages[s.slug] === "EXECUTE" ? CHECK : "";
        expect(
          row.cells[i],
          `cell mismatch at stage ${s.number} (${s.slug}) x scope ${scope}`,
        ).toBe(expected);
      });
    }
  });

  // --- Collapsed init row: doc all-✓ AND the grid actually warrants collapsing ---
  test("6: init row — collapsed 0.1\u20130.3 row is all-\u2713 and every init stage is EXECUTE under every scope", () => {
    expect(doc.initCells).toEqual(doc.scopes.map(() => CHECK));
    for (const s of initStages) {
      for (const scope of doc.scopes) {
        expect(
          grid[scope].stages[s.slug],
          `init stage ${s.slug} not EXECUTE under ${scope} — the collapsed row is no longer valid`,
        ).toBe("EXECUTE");
      }
    }
  });

  // --- Totals forward: footer equals the grid's per-scope EXECUTE counts ---
  test("7: totals forward — footer totals equal the grid's per-scope EXECUTE counts", () => {
    const expected = doc.scopes.map(
      (scope) => Object.values(grid[scope].stages).filter((v) => v === "EXECUTE").length,
    );
    expect(doc.totals).toEqual(expected);
  });

  // --- Totals reverse: footer is arithmetically whole against the doc's own cells ---
  test("8: totals reverse — footer totals equal the doc's own \u2713 count per column (+3 init)", () => {
    doc.scopes.forEach((scope, i) => {
      let count = doc.initCells[i] === CHECK ? initStages.length : 0;
      for (const num of doc.rowNumbers) {
        if (doc.rows.get(num)!.cells[i] === CHECK) count += 1;
      }
      expect(count, `totals column for ${scope} inconsistent with its cells`).toBe(
        doc.totals[i],
      );
    });
  });
});
