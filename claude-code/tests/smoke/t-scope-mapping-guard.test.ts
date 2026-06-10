// covers:
//
// Guard milestone 1's v0.6.0 fixture reconciliation: tests/harness must not read or
// mention the retired scope routing JSON. The custom harness now seeds scope
// metadata plus stage `scopes:` frontmatter into a temp project and lets compile
// derive the grid.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DEFAULT_HARNESS_DIR = join(REPO_ROOT, "tests", "harness");
const LEGACY_SCOPE_ROUTING_FILE = "scope-mapping.json";

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkFiles(p));
    } else {
      out.push(p);
    }
  }
  return out;
}

function legacyScopeRouteRefs(root: string): string[] {
  return walkFiles(root)
    .filter((p) => readFileSync(p, "utf8").includes(LEGACY_SCOPE_ROUTING_FILE))
    .map((p) => relative(REPO_ROOT, p));
}

describe("scope route fixture guard", () => {
  test("tests/harness has no retired scope routing JSON references", () => {
    const harnessDir = process.env.AIDLC_SCOPE_MAPPING_GUARD_DIR ?? DEFAULT_HARNESS_DIR;
    expect(legacyScopeRouteRefs(harnessDir)).toEqual([]);
  });
});
