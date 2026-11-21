// covers: stage:inception/units-generation, subcommand:aidlc-unit:land, file:tools/aidlc-sensor-traceability.ts
//
// A team main whose Unit has landed goes back to Units Generation. The stage's
// traceability must know which Units are finished: `sensor-traceability --stage
// units-generation --built`, run in main's checkout, lists the landed Unit
// under `finished_units` from the Unit Progress table the engine keeps, and the
// Unit that has not landed is not in it. The harness's landed Unit has no Code
// Generation table, so that part of the check writes one into main's record.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AIDLC_SRC, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  builtOnce,
  cleanupTempDirs,
  cleanupWorlds,
  gateAndLand,
  git,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";
import { makeReplanSeed, reopenUnitsGeneration } from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);
afterAll(cleanupWorlds);

const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor-traceability.ts");

// alpha claimed, worked and landed on main; built once.
const alphaLanded = builtOnce((): { seed: string; remote: string } => {
  const made = makeReplanSeed();
  prepareCandidate(made.remote, "alpha", "alpha-team");
  gateAndLand(made.seed, "alpha");
  git(made.seed, ["push", "origin", "main"]);
  return made;
});

function built(main: string): { finished_units: string[]; started_units: string[]; unbuilt: Array<{ story: string; units: string[]; criteria: string[] }> } {
  const result = runMergeTool(SENSOR, ["--stage", "units-generation", "--built"], main, false, { AIDLC_PROJECT_DIR: main });
  expect(result.status, result.out).toBe(0);
  expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  return JSON.parse(result.stdout);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("t-units-generation-built-work: Units Generation reopened on a team main", () => {
  test("--built lists the landed Unit as finished, and the Units that have not landed are not", () => {
    const { seed } = alphaLanded();
    const reopened = reopenUnitsGeneration(seed);
    expect(reopened.status, reopened.out).toBe(0);

    // The table after the jump back: the landed rows stay done and merged.
    const table = readFileSync(seededStateFile(seed), "utf-8").split(/\r?\n/).filter((line) => /^\| (skeleton|alpha|beta) /.test(line));
    expect(table.find((line) => line.startsWith("| alpha "))).toMatch(/\[x\] \|$/);
    expect(table.find((line) => line.startsWith("| beta "))).not.toMatch(/\[x\] \|$/);

    const list = built(seed);
    expect(list.finished_units).toContain("alpha");
    expect(list.finished_units).not.toContain("beta");
    expect(list.unbuilt).toEqual([]);
  });

  test("a story on the landed Unit's row that its Code Generation table does not build is listed", () => {
    const { seed } = alphaLanded();
    const reopened = reopenUnitsGeneration(seed);
    expect(reopened.status, reopened.out).toBe(0);

    const record = seededRecordDir(seed);
    write(join(record, "inception", "user-stories", "stories.md"), "# Stories\n\n## US1.1 Post an entry\n- AC1.1.1 saved once\n- AC1.1.2 shows its date\n");
    write(join(record, "inception", "units-generation", "unit-of-work.md"), "# Units\n\n| Unit ID | Directory |\n|---|---|\n| U1 | alpha |\n");
    write(join(record, "inception", "units-generation", "unit-of-work-story-map.md"), "# Story Map\n\n| Story | Unit ID | Directory |\n|---|---|---|\n| US1.1 | U1 | alpha |\n");
    write(join(seed, "src", "alpha.ts"), "export {};\n");
    write(join(record, "construction", "alpha", "code-generation", "traceability.json"), `${JSON.stringify({
      stage: "code-generation",
      unit: "alpha",
      upstream_ids: ["AC1.1.1", "AC1.1.2"],
      coverage: [
        { id: "AC1.1.1", status: "OK", target: "src/alpha.ts" },
        { id: "AC1.1.2", status: "N/A", target: "later" },
      ],
    })}\n`);

    expect(built(seed).unbuilt).toEqual([{ story: "US1.1", units: ["alpha"], criteria: ["AC1.1.2"] }]);
  });
});
