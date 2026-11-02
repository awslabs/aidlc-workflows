// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:status
//
// While main was back at Units Generation, a Unit could be claimed from the
// plan nobody had approved: a Unit that existed only in the draft plan was
// handed out, and its owner built on a plan that could still change.
//
// A Unit is claimed once the revised plan is approved and on main. Until
// then `aidlc unit claim` refuses, for an existing Unit as much as for one
// only the draft plan has, and says nothing was claimed; after the approval
// is pushed, both claim.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupTempDirs,
  clone,
  git,
  runMergeTool,
  UNIT,
} from "../harness/team-unit-merge.ts";
import {
  approveDeliveryPlanning,
  approveUnitsGeneration,
  currentStage,
  dagBody,
  makeReplanSeed,
  type PlannedUnit,
  reopenUnitsGeneration,
  writeUnitPlan,
} from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const START: PlannedUnit[] = [
  { name: "skeleton", depends_on: [] },
  { name: "alpha", depends_on: ["skeleton"] },
  { name: "beta", depends_on: ["skeleton"] },
];
const WITH_GAMMA: PlannedUnit[] = [...START, { name: "gamma", depends_on: ["skeleton"] }];

const REFUSAL = "Main is changing the Unit plan (Units Generation is open again on origin/main)";

/** Main back at Units Generation with the edited plan pushed, not yet approved. */
function draftPlanPushed(): { seed: string; remote: string } {
  const { seed, remote } = makeReplanSeed(dagBody(START));
  const jump = reopenUnitsGeneration(seed);
  expect(jump.status, jump.out).toBe(0);
  writeUnitPlan(seed, WITH_GAMMA);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "plan edit, not approved"]);
  git(seed, ["push", "origin", "main"]);
  expect(currentStage(seed)).toBe("units-generation");
  return { seed, remote };
}

function claimedUnits(checkout: string): string[] {
  const status = runMergeTool(UNIT, ["status"], checkout);
  expect(status.status, status.out).toBe(0);
  return (JSON.parse(status.stdout).claimed as Array<{ unit: string }>).map((entry) => entry.unit);
}

describe("t-team-unit-replan-claim-waits: no Unit is claimed while the plan is being changed", () => {
  test("an existing, unclaimed Unit is refused while main is back at Units Generation", () => {
    const { seed, remote } = draftPlanPushed();
    const betaClone = clone(remote, "beta-team");
    const claimed = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], betaClone);
    expect(claimed.status, claimed.out).not.toBe(0);
    expect(claimed.out).toContain(REFUSAL);
    expect(claimed.out).toContain("a Unit is claimed once the revised plan is approved and on main. Nothing was claimed.");
    expect(claimedUnits(seed)).toEqual([]);
  });

  test("a Unit that exists only in the pushed, unapproved plan is refused the same way", () => {
    const { seed, remote } = draftPlanPushed();
    const gammaClone = clone(remote, "gamma-team");
    const claimed = runMergeTool(UNIT, ["claim", "gamma", "--team", "gamma-team"], gammaClone);
    expect(claimed.status, claimed.out).not.toBe(0);
    expect(claimed.out).toContain(REFUSAL);
    expect(claimed.out).toContain("Nothing was claimed.");
    expect(claimedUnits(seed)).toEqual([]);
  });

  test("once the revised plan is approved and pushed, the existing Unit and the new Unit both claim", () => {
    const { seed, remote } = draftPlanPushed();
    const betaClone = clone(remote, "beta-team");
    const gammaClone = clone(remote, "gamma-team");
    expect(runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], betaClone).status).not.toBe(0);
    expect(runMergeTool(UNIT, ["claim", "gamma", "--team", "gamma-team"], gammaClone).status).not.toBe(0);

    approveUnitsGeneration(seed);
    approveDeliveryPlanning(seed);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "Revised Unit plan"]);
    git(seed, ["push", "origin", "main"]);

    const beta = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], betaClone);
    expect(beta.status, beta.out).toBe(0);
    const gamma = runMergeTool(UNIT, ["claim", "gamma", "--team", "gamma-team"], gammaClone);
    expect(gamma.status, gamma.out).toBe(0);
    expect(claimedUnits(seed).sort()).toEqual(["beta", "gamma"]);
  });
});
