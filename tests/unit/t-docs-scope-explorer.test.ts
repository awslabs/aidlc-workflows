// covers: file:scripts/docs-scope-explorer.ts, doc:docs/guide/05-scopes-and-depth.md(scope-explorer), doc:docs/guide/workflow-profiles.md(scope-explorer), file:tools/data/scope-grid.json, file:tools/data/stage-graph.json
//
// Drift guard for the interactive scope explorer
// (docs/guide/assets/scope-explorer.html), rendered by
// scripts/docs-scope-explorer.ts from the compiled stage graph and scope grid,
// the same ground truth t244 checks the chapter's tables against.
//
// Mechanism: none. The renderer is called in-process on the compiled data and
// its output is compared byte for byte with the committed page. Retagging a
// stage's `scopes:` list, renaming a stage, or adding a scope changes the
// grid, and this test fails until `bun scripts/docs-scope-explorer.ts` is
// rerun and its output committed.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";
import { loadScopeMetadata } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { HTML_PATH, loadExplorerData, renderHtml } from "../../scripts/docs-scope-explorer.ts";

const grid = JSON.parse(readFileSync(join(AIDLC_SRC, "tools", "data", "scope-grid.json"), "utf-8")) as Record<
  string,
  { stages: Record<string, string> }
>;
const data = await loadExplorerData();
const REGEN = "stale: run `bun scripts/docs-scope-explorer.ts` and commit the result";
const EXPLORER_URL = "https://awslabs.github.io/aidlc-workflows/guide/assets/scope-explorer.html";

describe("t-docs-scope-explorer generated page", () => {
  test("1: data — every compiled scope is present with exactly its EXECUTE stages and its review cap", () => {
    expect(data.scopes.map((s) => s.name).sort()).toEqual(Object.keys(grid).sort());
    const meta = loadScopeMetadata() as Record<string, { reviewCap?: string }>;
    for (const scope of data.scopes) {
      const expected = data.stages.filter((s) => grid[scope.name].stages[s.slug] === "EXECUTE").map((s) => s.slug);
      expect(scope.stages, `stages of ${scope.name}`).toEqual(expected);
      expect(scope.reviewCap, `review cap of ${scope.name}`).toBe(meta[scope.name].reviewCap ?? "");
    }
  });

  test("2: data — scopes are ordered by stage count, then name", () => {
    const keys = data.scopes.map((s) => [-s.stages.length, s.name] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    expect(keys).toEqual(sorted);
  });

  test("3: rendering is deterministic", () => {
    expect(renderHtml(data)).toBe(renderHtml(data));
  });

  test("4: committed scope-explorer.html matches the compiled grid", () => {
    expect(readFileSync(HTML_PATH, "utf-8"), REGEN).toBe(renderHtml(data));
  });

  test("5: both scope guides link to the explorer", () => {
    for (const page of ["05-scopes-and-depth.md", "workflow-profiles.md"]) {
      const doc = readFileSync(join(REPO_ROOT, "docs", "guide", page), "utf-8");
      expect(doc, page).toContain(`href="${EXPLORER_URL}"`);
    }
  });
});
