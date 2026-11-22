// covers: subcommand:aidlc-unit:land, subcommand:aidlc-state:fold-unit-merge, audit:UNIT_MERGED

// Main's state gets its Unit Progress table from the first `next` that walks
// Construction there. A project whose first Unit was claimed from a worktree
// never ran that walk on main, so landing the Unit stopped at the state step:
// the fold folds one Unit's row into the existing table and refused "State has
// no Unit Progress section." With no table, the fold now writes the whole
// authoritative section, as a plain refresh does.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  approveMerge,
  cleanupTempDirs,
  makeSeed,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

function withoutUnitProgress(state: string): string {
  return state.replace(/^## Unit Progress\n[\s\S]*?(?=^## )/m, "");
}

describe("landing a Unit on a main with no Unit Progress table", () => {
  test("the state step writes the table with the landed Unit merged", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "first-claim");
    approveMerge(seed, "alpha");
    const gitStep = runMergeTool(UNIT, ["land", "alpha", "--step", "git"], seed);
    expect(gitStep.status, gitStep.out).toBe(0);

    const state = seededStateFile(seed);
    writeFileSync(state, withoutUnitProgress(readFileSync(state, "utf-8")));
    expect(readFileSync(state, "utf-8")).not.toContain("## Unit Progress");

    const stateStep = runMergeTool(UNIT, ["land", "alpha", "--step", "state"], seed);
    expect(stateStep.status, stateStep.out).toBe(0);
    const folded = readFileSync(state, "utf-8");
    expect(folded).toContain("## Unit Progress");
    expect(folded.indexOf("## Unit Progress")).toBeLessThan(folded.indexOf("## Current Status"));
    const alpha = unitProgressRow(seed, "alpha").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(alpha[0]).toBe("alpha");
    expect(alpha.slice(2)).toEqual(alpha.slice(2).map(() => "[x]"));
    expect(unitProgressRow(seed, "skeleton")).not.toBe("");
    expect(unitProgressRow(seed, "beta")).toContain("[ ]");

    const auditStep = runMergeTool(UNIT, ["land", "alpha", "--step", "audit"], seed);
    expect(auditStep.status, auditStep.out).toBe(0);
    expect(JSON.parse(auditStep.stdout).landed).toBe(true);
  });
});
