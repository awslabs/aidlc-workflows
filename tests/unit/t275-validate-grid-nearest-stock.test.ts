// covers: function:nearestStockScopes
//
// t275 - deterministic stock-scope distance in validate-grid.
//
// The composer's matched-vs-custom verdict used to rest on an LLM diff-count
// of the proposal against the stock grids, and the conductor could re-derive
// it post-approval with a different rule (exact equality), minting a custom
// scope for a proposal the persona's own +/-2 rule called a stock match.
// nearestStockScopes() makes the distance a validator-computed number:
// validate-grid now returns `nearest_stock` (stock scopes ranked by grid
// diff against the PROPOSAL), and both the composer and the conductor route
// on nearest_stock[0], never on their own recount.
//
// Pins:
//   1. SHAPE - nearest_stock rides every valid validate-grid result: one row
//      per stock scope, {scope, diff, differs}, sorted ascending by diff then
//      name, differs listing exactly the flipped slugs.
//   2. THE t193 BOUNDARY - stock bugfix + practices-discovery + ci-pipeline
//      (the scan-report shape that reds t193 when re-decided as custom) ranks
//      bugfix nearest at diff 2 with exactly those two slugs differing: the
//      +/-2 match rule resolves to MATCHED on the validator's number.
//   3. IDENTITY - a stock grid submitted verbatim ranks its own scope first
//      at diff 0.
//   4. CLI - the `validate-grid` JSON body carries nearest_stock (the
//      composer consumes the CLI, not the import).
//
// Mechanism: MIXED - in-process imports against the shipped grid for the
// arithmetic rows, one spawn for the CLI surface (same pattern as t190).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadScopeGrid,
  nearestStockScopes,
  validateGrid,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const BUN = process.execPath;
const GRAPH_TOOL = join(AIDLC_SRC, "tools", "aidlc-graph.ts");

function bugfixPlusTwo(): Record<string, "EXECUTE" | "SKIP"> {
  const grid = { ...loadScopeGrid().bugfix.stages };
  grid["practices-discovery"] = "EXECUTE";
  grid["ci-pipeline"] = "EXECUTE";
  return grid;
}

describe("t275 nearestStockScopes (in-process, shipped grid)", () => {
  test("a verbatim stock grid ranks its own scope first at diff 0", () => {
    const ranked = nearestStockScopes(loadScopeGrid().bugfix.stages);
    expect(ranked[0]).toEqual({ scope: "bugfix", diff: 0, differs: [] });
  });

  test("bugfix+2 (the scan-report shape) ranks bugfix nearest at diff 2", () => {
    const ranked = nearestStockScopes(bugfixPlusTwo());
    expect(ranked[0].scope).toBe("bugfix");
    expect(ranked[0].diff).toBe(2);
    expect([...ranked[0].differs].sort()).toEqual([
      "ci-pipeline",
      "practices-discovery",
    ]);
  });

  test("ranking is ascending by diff then scope name, one row per stock scope", () => {
    const ranked = nearestStockScopes(bugfixPlusTwo());
    expect(ranked.length).toBe(Object.keys(loadScopeGrid()).length);
    for (let i = 1; i < ranked.length; i++) {
      const prev = ranked[i - 1];
      const cur = ranked[i];
      expect(
        prev.diff < cur.diff ||
          (prev.diff === cur.diff && prev.scope.localeCompare(cur.scope) < 0),
      ).toBe(true);
      expect(cur.differs.length).toBe(cur.diff);
    }
  });

  test("validateGrid returns nearest_stock alongside summary", () => {
    const r = validateGrid(bugfixPlusTwo());
    expect(r.valid).toBe(true);
    expect(r.nearest_stock?.[0]?.scope).toBe("bugfix");
    expect(r.nearest_stock?.[0]?.diff).toBe(2);
  });
});

describe("t275 validate-grid CLI carries nearest_stock", () => {
  test("the JSON body ranks bugfix at diff 2 for the bugfix+2 proposal", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-t275-"));
    try {
      const proposal = join(dir, "p.json");
      writeFileSync(proposal, JSON.stringify(bugfixPlusTwo()), "utf-8");
      const r = spawnSync(
        BUN,
        [GRAPH_TOOL, "validate-grid", "--proposal", proposal],
        { encoding: "utf-8" },
      );
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout) as {
        nearest_stock: Array<{ scope: string; diff: number; differs: string[] }>;
      };
      expect(body.nearest_stock[0].scope).toBe("bugfix");
      expect(body.nearest_stock[0].diff).toBe(2);
      expect([...body.nearest_stock[0].differs].sort()).toEqual([
        "ci-pipeline",
        "practices-discovery",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
