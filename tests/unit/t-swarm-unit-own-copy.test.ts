// covers: file:aidlc-common/stages/inception/units-generation.md, file:aidlc-common/stages/construction/code-generation.md
//
// t-swarm-unit-own-copy: Units built side by side are each built in their own
// copy of the project, with none of their batch peers' work in it, so the
// workers who draw the Unit dependencies and plan each Unit's tests are told
// that a Unit whose code or tests need another Unit's code depends on it. The
// batches come from those edges alone (computeBatches); nothing in the engine
// can see that a test reaches into a peer's code, so this is the workers'
// knowledge, pinned in every harness tree the packager ships.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const TREES = [
  ["claude", ".claude"], ["codex", ".codex"], ["copilot", ".aidlc"], ["cursor", ".cursor"],
  ["kiro", ".kiro"], ["kiro-ide", ".kiro"], ["opencode", ".aidlc"],
] as const;
const stageFile = (harness: string, dir: string, phase: string, stage: string) =>
  join(REPO_ROOT, "dist", harness, dir, "aidlc-common", "stages", phase, `${stage}.md`);
// Markdown wraps lines; the sentence is read as one line of words.
const words = (path: string) => readFileSync(path, "utf-8").replace(/\s+/g, " ");

describe("t-swarm-unit-own-copy: a Unit's tests pass in its own copy of the project", () => {
  test.each(TREES)("%s: Units Generation draws an edge for every Unit whose code a Unit needs", (harness, dir) => {
    const path = stageFile(harness, dir, "inception", "units-generation");
    expect(existsSync(path), path).toBe(true);
    const text = words(path);
    expect(text).toContain(
      "A Unit depends on every Unit whose code its own code or tests need to build or pass.",
    );
    expect(text).toContain(
      "Units with no edge between them may be built at the same time, each in its own copy of the project with none " +
        "of the others' work in it, so each Unit's code and tests must pass with its own code, the Units it depends " +
        "on, and the project as it stands.",
    );
  });

  test.each(TREES)("%s: a side-by-side Unit's plan needs nothing from its batch peers", (harness, dir) => {
    const path = stageFile(harness, dir, "construction", "code-generation");
    expect(existsSync(path), path).toBe(true);
    expect(words(path)).toContain(
      "Built side by side, this Unit has its own copy of the project with none of the other Units of its batch in " +
        "it: plan code and tests that pass with this Unit's code, the Units it depends on, and the project as it " +
        "stands.",
    );
  });
});
