// covers: file:aidlc-common/stages/construction/code-generation.md
//
// A Unit's source manifest is measured from its attempt's source baseline: a
// rejection keeps that baseline, so a reopened Unit keeps its earlier claims,
// while a jump back into the stage takes a new one (#2490).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const ROOTS = {
  core: join(REPO_ROOT, "core"),
  "dist/claude": join(REPO_ROOT, "dist", "claude", ".claude"),
} as const;

describe.each(Object.entries(ROOTS))("Unit source manifest across attempts (%s)", (_name, root) => {
  const stage = (): string =>
    readFileSync(join(root, "aidlc-common", "stages", "construction", "code-generation.md"), "utf-8")
      .replace(/\s+/g, " ");

  test("a Unit reopened by a rejection keeps its earlier claims", () => {
    expect(stage()).toContain("a unit reopened by a rejection keeps the paths its earlier attempts listed");
    expect(stage()).toContain(
      "A rejection at the gate (Request Changes) keeps that baseline, so when the unit is reopened that way, keep every path an earlier attempt listed and add the paths this attempt writes",
    );
  });

  test("a jump back into the stage lists what changes from its new baseline", () => {
    expect(stage()).toContain(
      "A jump back into the stage, such as a Build and Test loop-back, takes a new baseline, so list what the unit changes from there.",
    );
  });
});
