// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:status
//
// While main is back at Units Generation, a teammate can still claim a Unit:
// the claim is the person's own request, and the plan main is revising is the
// one on main. The claim goes ahead on the plan as it stands there, for an
// existing Unit as much as for one only the pushed draft has, and its result
// says the risk once: if the approved plan changes that Unit's own entry, pin
// asks for a rebase (t-team-unit-replan-stale-candidate). Once the revised
// plan is approved and pushed, a claim carries no such line.

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

const WARNING = "Main is changing the Unit plan (Units Generation is open again on origin/main)";

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

function claim(checkout: string, unit: string): { claimed?: boolean; unit?: string; warning?: string } {
  const claimed = runMergeTool(UNIT, ["claim", unit, "--team", `${unit}-team`], checkout);
  expect(claimed.status, claimed.out).toBe(0);
  return JSON.parse(claimed.stdout);
}

describe("t-team-unit-replan-claim-warns: a claim while the plan is being changed goes ahead and says so once", () => {
  test("an existing, unclaimed Unit is claimed while main is back at Units Generation, with the risk said once", () => {
    const { seed, remote } = draftPlanPushed();
    const result = claim(clone(remote, "beta-team"), "beta");
    expect(result).toMatchObject({ claimed: true, unit: "beta" });
    expect(result.warning).toContain(WARNING);
    expect(result.warning).toContain(
      'if the approved plan changes "beta"\'s own entry, pin asks this checkout to rebase onto main and publish again.',
    );
    expect(result.warning!.split(WARNING)).toHaveLength(2);
    expect(claimedUnits(seed)).toEqual(["beta"]);
  });

  test("a Unit that exists only in the pushed, unapproved plan is claimed the same way", () => {
    const { seed, remote } = draftPlanPushed();
    const result = claim(clone(remote, "gamma-team"), "gamma");
    expect(result).toMatchObject({ claimed: true, unit: "gamma" });
    expect(result.warning).toContain(WARNING);
    expect(claimedUnits(seed)).toEqual(["gamma"]);
  });

  test("once the revised plan is approved and pushed, a claim says nothing about a plan change", () => {
    const { seed, remote } = draftPlanPushed();
    approveUnitsGeneration(seed);
    approveDeliveryPlanning(seed);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "Revised Unit plan"]);
    git(seed, ["push", "origin", "main"]);

    const beta = claim(clone(remote, "beta-team"), "beta");
    expect(beta.warning).toBeUndefined();
    const gamma = claim(clone(remote, "gamma-team"), "gamma");
    expect(gamma.warning).toBeUndefined();
    expect(claimedUnits(seed).sort()).toEqual(["beta", "gamma"]);
  });
});
