// covers: subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land

// A Unit that would not land was found out only after the person approved
// its merge: land refused on source conflicts with a Unit that landed after
// this one published, and the approval was spent. Pin now tries the merge with
// main before it asks the merge question, and refuses a conflict there with
// the Unit owner's next step. Main here is what pin tried the merge with, so
// when the lead has not pushed a landing yet, the step says to push main first.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readUnitMergeTransaction } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  UNIT,
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

// The seed's src/shared.ts with its first line changed.
function sharedWith(left: string): string {
  return `export const left = "${left}";\n` +
    'export const keep1 = "same";\n' +
    'export const keep2 = "same";\n' +
    'export const keep3 = "same";\n' +
    'export const right = "base";\n';
}

describe("t326 pin tries a team Unit's merge with main before the merge question", () => {
  test("a conflict with a Unit that landed since publish is refused at pin, before the merge question", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-conflict", { sharedText: sharedWith("alpha") });
    prepareCandidate(remote, "beta", "beta-conflict", { sharedText: sharedWith("beta") });
    gateAndLand(seed, "beta");
    git(seed, ["push", "origin", "main"]);

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).not.toBe(0);
    expect(pin.out).toContain('Unit \\"alpha\\" source conflicts: src/shared.ts. Nothing was pinned.');
    expect(pin.out).toContain("(not this one), merge origin/main, resolve these files and publish alpha again");
    // origin/main has beta's landing, so merging it is the whole step.
    expect(pin.out).not.toContain("push main");
    expect(pin.out).not.toContain("merge_gate");
    expect(readUnitMergeTransaction(seed, "alpha")).toBeNull();
  });

  test("with the landing not pushed yet, the step says to push main first", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-unpushed", { sharedText: sharedWith("alpha") });
    prepareCandidate(remote, "beta", "beta-unpushed", { sharedText: sharedWith("beta") });
    // The lead answers "Not now" to pushing main after beta lands.
    gateAndLand(seed, "beta");

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).not.toBe(0);
    expect(pin.out).toContain('Unit \\"alpha\\" source conflicts: src/shared.ts. Nothing was pinned.');
    expect(pin.out).toContain("Main here has commits origin/main does not have yet");
    expect(pin.out).toContain("push main first (aidlc unit share, or git push origin HEAD:main). Then, in the checkout");
    expect(pin.out).toContain("merge origin/main, resolve these files and publish alpha again");
    expect(readUnitMergeTransaction(seed, "alpha")).toBeNull();

    // Once main is pushed, merging origin/main brings beta's landing to alpha,
    // and the step is the merge alone.
    git(seed, ["push", "origin", "main"]);
    const again = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(again.status, again.out).not.toBe(0);
    expect(again.out).toContain("source conflicts: src/shared.ts.");
    expect(again.out).not.toContain("push main");
  });
});
