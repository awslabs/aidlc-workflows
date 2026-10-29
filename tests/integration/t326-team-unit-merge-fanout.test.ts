// covers: subcommand:aidlc-orchestrate:next, function:cachedClaimFanoutActive, function:validateLiveUnitScope, function:buildTeamConstructionBoard
//
// After a team Unit lands, its claim stays live, so the guard still counts the
// fan-out as active in every unscoped checkout. `next` reads that same check:
// it shows the dispatcher board (or a participant's claim question) instead of
// the next Unit's stage, so a claim runs only on the person's own
// `/aidlc --claim`, and the guard's refusal names that step.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  ORCH,
  STATE,
  UNIT,
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

// A pinned landing plus four checkouts' tool calls: the generous workload backstop.
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

function claimRefs(remote: string): string {
  return git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/claim/"]);
}

describe("t326 an unscoped checkout after a team Unit lands", () => {
  test("shows the board, not the next Unit's stage, and claims only on the person's word", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);
    const refsAfterLanding = claimRefs(remote);
    expect(refsAfterLanding).toContain("/alpha");
    expect(refsAfterLanding).not.toContain("/beta");

    // The lead's main, where alpha landed: the board with beta's claim step.
    const lead = nextDirective(seed);
    expect(lead.kind).toBe("notice");
    expect(lead.message as string).toContain("# Team Construction Dispatcher");
    expect(lead.message as string).toContain("`/aidlc --claim beta`");

    // The guard's refusal names the person's step.
    const unscopedStart = runMergeTool(
      STATE,
      ["unit", "start", "--stage", "functional-design", "--unit", "beta"],
      seed,
    );
    expect(unscopedStart.status).not.toBe(0);
    expect(unscopedStart.out).toContain("/aidlc --claim <unit> --team <label>");

    // A fresh clone of the landed main routes the same way.
    const fresh = clone(remote, "fresh");
    const freshNext = nextDirective(fresh);
    expect(freshNext.kind).toBe("notice");
    expect(freshNext.message as string).toContain("`/aidlc --claim beta`");

    // A participant clone gets the claim question.
    const participant = clone(remote, "participant");
    const joined = runMergeTool(UNIT, ["participate"], participant);
    expect(joined.status, joined.out).toBe(0);
    expect(nextDirective(participant)).toMatchObject({
      kind: "ask",
      ask_type: "unit-claim",
      claimable_units: ["beta"],
    });
    expect(claimRefs(remote)).toBe(refsAfterLanding);

    // The person's own claim goes through, and the claimed checkout runs beta.
    const claimStep = runMergeTool(
      ORCH,
      ["next", "--claim", "beta", "--team", "beta-team"],
      fresh,
    );
    expect(claimStep.status, claimStep.out).toBe(0);
    expect(JSON.parse(claimStep.stdout).message).toContain("--claim beta --team beta-team");
    const claimed = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], fresh);
    expect(claimed.status, claimed.out).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ claimed: true, unit: "beta", owner: "beta-team" });
    expect(nextDirective(fresh)).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "beta",
    });

    // With beta taken and nothing left to claim, the lead's main shows the board.
    git(seed, ["fetch", "origin"]);
    const taken = nextDirective(seed);
    expect(taken.kind).toBe("notice");
    expect(taken.message as string).toContain("beta (beta-team)");
  });
});
