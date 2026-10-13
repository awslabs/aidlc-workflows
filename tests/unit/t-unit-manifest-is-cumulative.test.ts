// covers: file:aidlc-common/stages/construction/code-generation.md
//
// A Unit's source manifest is its whole claim for the stage, kept across a
// reopen, because the engine measures changed source from the stage's start
// and a rejection never moves it (#2490).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const ROOTS = {
  core: join(REPO_ROOT, "core"),
  "dist/claude": join(REPO_ROOT, "dist", "claude", ".claude"),
} as const;

describe.each(Object.entries(ROOTS))("Unit source manifest across attempts (%s)", (_name, root) => {
  test("Code Generation tells a reopened Unit to keep its earlier claims", () => {
    const stage = readFileSync(join(root, "aidlc-common", "stages", "construction", "code-generation.md"), "utf-8")
      .replace(/\s+/g, " ");
    expect(stage).toContain("a reopened unit keeps the paths its earlier attempts listed");
    expect(stage).toContain("The manifest is the unit's whole claim for this stage, not one attempt's");
    expect(stage).toContain("keep every path an earlier attempt listed and add the paths this attempt writes");
  });
});
