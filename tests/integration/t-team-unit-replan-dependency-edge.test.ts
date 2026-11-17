// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, subcommand:aidlc-unit:status
//
// A revised Unit plan can make a Unit that is already claimed wait on another
// Unit that has not landed, and that claimed Unit could then land before the
// Unit it depends on. A Unit lands after every Unit it depends on: pin and land
// refuse until they have landed, saying which one the Unit now waits on, and
// `unit status` lists the claimed Unit with the same names as `blockedBy`.
// Nothing on main changes while the dependency is open, and once it lands the
// claimed Unit pins and lands as it is.
//
// `unit status` reads the pushed integration ref while the board reads local
// files, so each status read happens in a checkout that pulled main.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  approveMerge,
  cleanupTempDirs,
  clone,
  git,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import { makeReplanSeed, type PlannedUnit, replan } from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const U = (name: string, ...dependsOn: string[]): PlannedUnit => ({ name, depends_on: dependsOn });

// beta is claimed; the new plan has beta wait on gamma, which waits on alpha. Neither has landed.
const BETA_ON_NEW_GAMMA = [U("skeleton"), U("alpha", "skeleton"), U("beta", "skeleton", "gamma"), U("gamma", "alpha")];
// beta is claimed; the new plan has beta wait on alpha, an existing Unit nobody has landed.
const BETA_ON_ALPHA = [U("skeleton"), U("alpha", "skeleton"), U("beta", "skeleton", "alpha")];

/** What main's own steps wrote is committed and pushed, as the person commits it. */
function settle(main: string): void {
  git(main, ["add", "-A"]);
  git(main, ["commit", "--allow-empty", "-m", "main bookkeeping"]);
  git(main, ["push", "origin", "main"]);
}

/** Pin, gate and land on main, committing what the tools write between the steps. */
function landOnMain(main: string, unit: string): { status: number; out: string } {
  settle(main);
  try {
    approveMerge(main, unit);
  } catch (error) {
    // The pin, its dispatch bracket or the gate said no.
    return { status: 1, out: String(error) };
  }
  git(main, ["add", "-A"]);
  git(main, ["commit", "--allow-empty", "-m", "engine bookkeeping"]);
  let landed = runMergeTool(UNIT, ["land", unit], main);
  // The tools rewrite tracked engine files between the landing's steps; the
  // landing resumes where it stopped once those are committed.
  if (landed.status !== 0 && landed.out.includes("clean source worktree")) {
    git(main, ["add", "-A"]);
    git(main, ["commit", "--allow-empty", "-m", "engine bookkeeping"]);
    landed = runMergeTool(UNIT, ["land", unit], main);
  }
  return landed;
}

function statusOf(checkout: string): {
  claimable: string[];
  claimed: Array<{ unit: string; owner: string; generation: number; blockedBy?: string[] }>;
  out: string;
} {
  const status = runMergeTool(UNIT, ["status"], checkout);
  expect(status.status, status.out).toBe(0);
  return { ...JSON.parse(status.stdout), out: status.out };
}

/** beta claimed (nothing done yet), then the plan changes to `units`; main and beta's checkout are current. */
function betaClaimedThenPlan(units: PlannedUnit[]): { seed: string; remote: string; betaCheckout: string } {
  const { seed, remote } = makeReplanSeed(parallelDependencyBody());
  const betaCheckout = clone(remote, "beta-team");
  const claim = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], betaCheckout);
  expect(claim.status, claim.out).toBe(0);
  replan(seed, units);
  git(betaCheckout, ["pull", "--rebase", "origin", "main"]);
  return { seed, remote, betaCheckout };
}

/** The Unit's work done in the checkout that already holds its claim, and its candidate published. */
function workPublished(remote: string, unit: string, label: string, checkout?: string): void {
  const co = checkout ?? clone(remote, label);
  git(co, ["pull", "--rebase", "origin", "main"]);
  prepareCandidate(remote, unit, label, { checkout: co });
}

/** The sentence of a refusal; the tool prints it as {"error": "..."}. */
function refusal(result: { status: number; out: string }): string {
  expect(result.status, result.out).not.toBe(0);
  return result.out.includes('"error"') ? (JSON.parse(result.out.trim()) as { error: string }).error : result.out;
}

/** The refusal a person reads: the Unit, the Unit it now waits on, and that nothing changed. */
function expectWaitsOn(result: { status: number; out: string }, unit: string, dependency: string): void {
  const said = refusal(result);
  expect(said).toContain(`Unit "${unit}" now depends on "${dependency}", which has not landed on main yet; it lands after it does.`);
  expect(said).not.toContain("Cannot preserve");
}

describe("t-team-unit-replan-dependency-edge: a claimed Unit that now waits on a Unit that has not landed", () => {
  test("pin refuses a claimed Unit that depends on a new Unit, naming it, and nothing changes on main", () => {
    const { seed, remote, betaCheckout } = betaClaimedThenPlan(BETA_ON_NEW_GAMMA);
    workPublished(remote, "beta", "beta-team", betaCheckout);
    git(seed, ["pull", "--ff-only"]);
    const before = git(seed, ["rev-parse", "HEAD"]);
    const pin = runMergeTool(UNIT, ["pin", "beta"], seed);
    expectWaitsOn(pin, "beta", "gamma");
    expect(pin.out).toContain("Nothing was pinned or landed.");
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(seed, ["status", "--porcelain"])).toBe("");
    expect(unitProgressRow(seed, "beta")).not.toContain("[x]");
  });

  test("pin refuses a claimed Unit that now depends on an existing Unit that has not landed, naming it", () => {
    const { seed, remote, betaCheckout } = betaClaimedThenPlan(BETA_ON_ALPHA);
    workPublished(remote, "beta", "beta-team", betaCheckout);
    git(seed, ["pull", "--ff-only"]);
    const before = git(seed, ["rev-parse", "HEAD"]);
    const pin = runMergeTool(UNIT, ["pin", "beta"], seed);
    expectWaitsOn(pin, "beta", "alpha");
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(before);
    expect(unitProgressRow(seed, "beta")).not.toContain("[x]");
  });

  // beta's own entry changes when it gets a dependency, so a candidate published before the plan
  // changed is stale first: the owner builds on the new main and publishes again, and only then
  // does the unlanded dependency come up (the cases above).
  const STALE = "candidate is based on a stale Construction contract; rebase onto the current integration branch and publish again.";

  test("a candidate published before the plan gave the Unit its dependency is refused as stale at pin", () => {
    const { seed, remote } = makeReplanSeed(parallelDependencyBody());
    prepareCandidate(remote, "beta", "beta-team");
    replan(seed, BETA_ON_ALPHA);
    const before = git(seed, ["rev-parse", "HEAD"]);
    expect(refusal(runMergeTool(UNIT, ["pin", "beta"], seed))).toContain(STALE);
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(before);
    expect(unitProgressRow(seed, "beta")).not.toContain("[x]");
  });

  test("a candidate pinned and approved before the plan changed is refused as stale at land", () => {
    const { seed, remote } = makeReplanSeed(parallelDependencyBody());
    prepareCandidate(remote, "beta", "beta-team");
    settle(seed);
    approveMerge(seed, "beta");
    settle(seed);
    replan(seed, BETA_ON_ALPHA);
    expect(refusal(runMergeTool(UNIT, ["land", "beta"], seed))).toContain(STALE);
    expect(unitProgressRow(seed, "beta")).not.toContain("[x]");
  });

  test("unit status lists the claimed Unit with the Unit it waits on as blockedBy", () => {
    const { seed } = betaClaimedThenPlan(BETA_ON_NEW_GAMMA);
    const status = statusOf(seed);
    const beta = status.claimed.find((entry) => entry.unit === "beta");
    expect(beta, status.out).toBeDefined();
    expect(beta?.owner).toBe("beta-team");
    expect(beta?.blockedBy).toEqual(["gamma"]);
    // alpha is claimable and carries no blockedBy of its own.
    expect(status.claimable).toContain("alpha");
  });

  test("a claimed Unit whose dependencies have all landed carries no blockedBy", () => {
    const { seed } = betaClaimedThenPlan([U("skeleton"), U("alpha", "skeleton"), U("beta", "skeleton")]);
    const beta = statusOf(seed).claimed.find((entry) => entry.unit === "beta");
    expect(beta).toBeDefined();
    expect(beta).not.toHaveProperty("blockedBy");
  });

  test("once the new dependency has landed, the claimed Unit pins and lands", () => {
    const { seed, remote, betaCheckout } = betaClaimedThenPlan(BETA_ON_ALPHA);
    workPublished(remote, "beta", "beta-team", betaCheckout);
    workPublished(remote, "alpha", "alpha-team");
    git(seed, ["pull", "--ff-only"]);
    expectWaitsOn(runMergeTool(UNIT, ["pin", "beta"], seed), "beta", "alpha");
    const alpha = landOnMain(seed, "alpha");
    expect(alpha.status, alpha.out).toBe(0);
    settle(seed);
    expect(statusOf(seed).claimed.find((entry) => entry.unit === "beta")).not.toHaveProperty("blockedBy");
    const beta = landOnMain(seed, "beta");
    expect(beta.status, beta.out).toBe(0);
    expect(unitProgressRow(seed, "beta")).toContain("[x]");
  });
});
