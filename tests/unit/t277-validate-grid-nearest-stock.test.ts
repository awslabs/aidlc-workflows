// covers: function:nearestStockScopes
//
// t277 - deterministic stock-scope distance in validate-grid.
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const COMPOSER_AGENT = join(AIDLC_SRC, "agents", "aidlc-composer-agent.md");

function bugfixPlusTwo(): Record<string, "EXECUTE" | "SKIP"> {
  const grid = { ...loadScopeGrid().bugfix.stages };
  grid["practices-discovery"] = "EXECUTE";
  grid["ci-pipeline"] = "EXECUTE";
  return grid;
}

function featureMinus(...slugs: string[]): Record<string, "EXECUTE" | "SKIP"> {
  const grid = { ...loadScopeGrid().feature.stages };
  for (const slug of slugs) grid[slug] = "SKIP";
  return grid;
}

describe("t277 nearestStockScopes (in-process, shipped grid)", () => {
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

  test("an empty grid is invalid and cannot rank as an exact stock match", () => {
    const stageCount = Object.keys(loadScopeGrid().bugfix.stages).length;
    const r = validateGrid({});
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toContain(
      `Grid is missing ${stageCount} compiled stage entries`,
    );
    expect(r.nearest_stock?.[0]?.diff).toBe(stageCount);
    expect(nearestStockScopes({})[0].diff).toBe(stageCount);
  });

  test("a partial stock grid counts the omitted stage as a difference", () => {
    const partial = { ...loadScopeGrid().bugfix.stages };
    delete partial["intent-capture"];
    const r = validateGrid(partial);
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toContain(
      "Grid is missing 1 compiled stage entry: intent-capture",
    );
    expect(r.nearest_stock?.[0]).toEqual({
      scope: "bugfix",
      diff: 1,
      differs: ["intent-capture"],
    });
  });

  test("stock adoption revalidates the 9-stage proposal as the 7-stage bugfix grid", () => {
    const proposed = validateGrid(bugfixPlusTwo());
    const adopted = validateGrid(loadScopeGrid().bugfix.stages);
    expect(proposed.summary?.execute).toBe(9);
    expect(adopted.summary?.execute).toBe(7);
    expect(adopted.nearest_stock?.[0]).toEqual({
      scope: "bugfix",
      diff: 0,
      differs: [],
    });

    const contract = readFileSync(COMPOSER_AGENT, "utf-8");
    expect(contract).toContain(
      "After adoption, validate the adopted stock grid again",
    );
    expect(contract).toContain(
      'convert it to `mode: "custom"`',
    );
    expect(contract).toMatch(
      /update EVERY row whose decision differs\s+from the final proposal grid/,
    );
  });

  test("in-flight feature minus two preserves the requested delta despite a nearby stock grid", () => {
    const proposed = featureMinus("market-research", "team-formation");
    const validation = validateGrid(proposed, { strict: true });
    expect(validation.valid).toBe(true);
    expect(validation.summary?.execute).toBe(31);
    expect(validation.summary?.skip).toBe(2);
    expect(validation.nearest_stock?.[0]).toEqual({
      scope: "enterprise",
      diff: 2,
      differs: ["market-research", "team-formation"],
    });

    const contract = readFileSync(COMPOSER_AGENT, "utf-8");
    expect(contract).toContain("In-flight branch - never match or synthesize");
    expect(contract).toContain('Set `mode: "in-flight"`');
    expect(contract).toContain("NEVER adopt a stock grid");
    expect(contract).toContain("`changes.skip` / `changes.add` slug arrays");
  });

  test("final folded distance is the sole authority when the mechanical grid was nearer stock", () => {
    const mechanical = featureMinus("market-research", "team-formation");
    const final = featureMinus(
      "market-research",
      "team-formation",
      "rough-mockups",
    );
    expect(validateGrid(mechanical).nearest_stock?.[0]?.diff).toBe(2);
    expect(validateGrid(final).nearest_stock?.[0]?.diff).toBe(3);

    const contract = readFileSync(COMPOSER_AGENT, "utf-8");
    const step7 = contract.slice(
      contract.indexOf("### Step 7:"),
      contract.indexOf("### Step 8:"),
    );
    expect(step7).toContain("Route solely on");
    expect(step7).toContain("The mechanical screen's distance never overrides");
    expect(step7).not.toContain("SMALLER");
    expect(step7).not.toContain("If either distance");
  });
});

describe("t277 validate-grid CLI carries nearest_stock", () => {
  test("the JSON body ranks bugfix at diff 2 for the bugfix+2 proposal", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-t277-"));
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

  test("the CLI rejects an empty proposal instead of reporting a zero-stage match", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-t277-empty-"));
    try {
      const proposal = join(dir, "p.json");
      writeFileSync(proposal, "{}", "utf-8");
      const r = spawnSync(
        BUN,
        [GRAPH_TOOL, "validate-grid", "--proposal", proposal],
        { encoding: "utf-8" },
      );
      expect(r.status).toBe(1);
      const body = JSON.parse(r.stdout) as {
        valid: boolean;
        errors: string[];
        nearest_stock: Array<{ diff: number }>;
      };
      expect(body.valid).toBe(false);
      expect(body.errors.join("\n")).toContain("compiled stage entries");
      expect(body.nearest_stock[0].diff).toBe(
        Object.keys(loadScopeGrid().bugfix.stages).length,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("composer-authored grid entries are excluded from nearest_stock", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-t277-composed-"));
    try {
      const gridPath = join(dir, "scope-grid.json");
      const proposal = join(dir, "p.json");
      const shippedGrid = JSON.parse(
        readFileSync(join(AIDLC_SRC, "tools", "data", "scope-grid.json"), "utf-8"),
      ) as Record<string, { stages: Record<string, "EXECUTE" | "SKIP"> }>;
      shippedGrid["aaa-composed"] = {
        stages: { ...shippedGrid.bugfix.stages },
      };
      writeFileSync(gridPath, JSON.stringify(shippedGrid), "utf-8");
      writeFileSync(proposal, JSON.stringify(shippedGrid.bugfix.stages), "utf-8");

      const r = spawnSync(
        BUN,
        [GRAPH_TOOL, "validate-grid", "--proposal", proposal],
        {
          encoding: "utf-8",
          env: { ...process.env, AIDLC_SCOPE_GRID: gridPath },
        },
      );
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout) as {
        nearest_stock: Array<{ scope: string; diff: number; differs: string[] }>;
      };
      expect(body.nearest_stock[0]).toEqual({ scope: "bugfix", diff: 0, differs: [] });
      expect(body.nearest_stock.some((row) => row.scope === "aaa-composed")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
