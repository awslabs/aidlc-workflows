// covers: subcommand:aidlc-unit:land
//
// With the teams still building, main can be moved on past the Unit stages
// (a forward jump to Build and Test skips them on main). A land after that has
// no Unit stages on main to record the Unit in: it merges nothing, and says
// so, instead of merging and then stopping with the merge unrecorded. A land
// whose merge is already on main says the merge is there.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { readUnitMergeTransaction } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  UNIT,
  approveMerge,
  cleanupTempDirs,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");

function moveMainOnToBuildAndTest(seed: string): void {
  const jumped = runMergeTool(JUMP, ["execute", "--target", "build-and-test", "--direction", "forward"], seed);
  expect(jumped.status, jumped.out).toBe(0);
}

describe("land after main moved on past the Unit stages", () => {
  test("merges nothing and says why", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    approveMerge(seed, "alpha");
    moveMainOnToBuildAndTest(seed);
    const head = git(seed, ["rev-parse", "HEAD"]);

    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("was not merged");
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(join(seed, ".git", "MERGE_HEAD"))).toBe(false);
    expect(readUnitMergeTransaction(seed, "alpha")?.status).toBe("approved");
  });

  test("a merge already on main is named as merged and not yet recorded", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    approveMerge(seed, "alpha");
    const gitStep = runMergeTool(UNIT, ["land", "alpha", "--step", "git"], seed);
    expect(gitStep.status, gitStep.out).toBe(0);
    const mergeCommit = JSON.parse(gitStep.stdout).git_commit_oid as string;
    moveMainOnToBuildAndTest(seed);

    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain(`is merged into main at ${mergeCommit}`);
    expect(landed.out).toContain("not recorded");
  });
});
