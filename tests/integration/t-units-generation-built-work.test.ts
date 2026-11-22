// covers: stage:inception/units-generation, subcommand:aidlc-unit:land, file:tools/aidlc-sensor-traceability.ts
//
// A team main whose Unit has landed goes back to Units Generation. The stage's
// traceability check, run in main's checkout, must read which Units are
// finished from the Unit Progress table the engine keeps: a story on the landed
// Unit's row that nothing built is named, and one on the row of the Unit that
// has not landed is not. The harness's landed Unit has no Code Generation
// table, so the second case writes one into main's record.

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
const finding = (criteria: string) =>
  `US1.1: every Unit on its row is finished (alpha), and none of them built ${criteria}; add a Unit that is not finished to the row`;

// alpha claimed, worked and landed on main; built once.
const alphaLanded = builtOnce((): { seed: string; remote: string } => {
  const made = makeReplanSeed();
  prepareCandidate(made.remote, "alpha", "alpha-team");
  gateAndLand(made.seed, "alpha");
  git(made.seed, ["push", "origin", "main"]);
  return made;
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// The Unit plan in main's record, with stories, and the check's findings of
// this rule on it.
function unbuilt(main: string, stories: string, rows: string[]): string[] {
  const record = seededRecordDir(main);
  const dir = join(record, "inception", "units-generation");
  write(join(record, "inception", "user-stories", "stories.md"), stories);
  write(join(dir, "unit-of-work.md"), "# Units\n\n| Unit ID | Directory |\n|---|---|\n| U1 | alpha |\n| U2 | beta |\n");
  write(join(dir, "unit-of-work-story-map.md"), `# Story Map\n\n| Story | Unit ID | Directory |\n|---|---|---|\n${rows.join("\n")}\n`);
  const ids = rows.map((row) => row.split("|")[1].trim());
  const units = rows.map((row) => row.split("|")[2].trim());
  const table = join(dir, "traceability.json");
  write(table, `${JSON.stringify({
    stage: "units-generation",
    upstream_ids: ids,
    coverage: ids.map((id, index) => ({ id, status: "OK", target: units[index] })),
  })}\n`);
  const result = runMergeTool(SENSOR, ["--stage", "units-generation", "--output-path", table], main, false, { AIDLC_PROJECT_DIR: main });
  expect(result.stdout.trim().split(/\r?\n/), result.out).toHaveLength(1);
  return (JSON.parse(result.stdout).invalid_targets as string[]).filter((text) => text.includes("is finished"));
}

describe("t-units-generation-built-work: Units Generation reopened on a team main", () => {
  test("the landed Unit is read as finished, and the Unit that has not landed is not", () => {
    const { seed } = alphaLanded();
    const reopened = reopenUnitsGeneration(seed);
    expect(reopened.status, reopened.out).toBe(0);

    // The table after the jump back: the landed rows stay done and merged.
    const table = readFileSync(seededStateFile(seed), "utf-8").split(/\r?\n/).filter((line) => /^\| (skeleton|alpha|beta) /.test(line));
    expect(table.find((line) => line.startsWith("| alpha "))).toMatch(/\[x\] \|$/);
    expect(table.find((line) => line.startsWith("| beta "))).not.toMatch(/\[x\] \|$/);

    // Nothing built either story: only the one on the landed Unit's row is named.
    expect(unbuilt(
      seed,
      "# Stories\n\n## US1.1 Post an entry\n- AC1.1.1 saved once\n\n## US1.2 Edit a profile\n- AC1.2.1 the new name is shown\n",
      ["| US1.1 | U1 | alpha |", "| US1.2 | U2 | beta |"],
    )).toEqual([finding("AC1.1.1")]);
  });

  test("a story on the landed Unit's row that its Code Generation table does not build is listed", () => {
    const { seed } = alphaLanded();
    const reopened = reopenUnitsGeneration(seed);
    expect(reopened.status, reopened.out).toBe(0);

    const record = seededRecordDir(seed);
    write(join(seed, "src", "alpha.ts"), "export {};\n");
    write(join(record, "construction", "alpha", "code-generation", "traceability.json"), `${JSON.stringify({
      stage: "code-generation",
      unit: "alpha",
      upstream_ids: ["AC1.1.1", "AC1.1.2"],
      coverage: [
        { id: "AC1.1.1", status: "OK", target: "src/alpha.ts" },
        { id: "AC1.1.2", status: "Deferred", target: "later" },
      ],
    })}\n`);

    expect(unbuilt(
      seed,
      "# Stories\n\n## US1.1 Post an entry\n- AC1.1.1 saved once\n- AC1.1.2 shows its date\n",
      ["| US1.1 | U1 | alpha |"],
    )).toEqual([finding("AC1.1.2")]);
  });
});
