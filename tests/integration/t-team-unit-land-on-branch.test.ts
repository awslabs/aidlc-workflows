// covers: subcommand:aidlc-unit:pin, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:land, subcommand:aidlc-unit:share

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readAllAuditShards,
  readApplicableTeamUnitScopeStamp,
  readUnitMergeTransaction,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  UNIT,
  approveMerge,
  cleanupTempDirs,
  clone,
  git,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

// A team whose integration branch takes changes only by review (a protected
// one, say) lands on a branch of its own: the lead's main checkout is on a branch of its own
// (records/u1, cut from the remote's main), and a team Unit lands there, as a
// side-by-side batch lands on the branch checked out (#3091). Pin names that
// branch, the merge gate shows and records it, land requires it, and main,
// here and on the remote, is not touched. Nothing is pushed or offered for
// push: the branch reaches main when the person merges it there.

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const BRANCH = "records/u1";

function onRecordsBranch(lead: string): void {
  git(lead, ["fetch", "origin", "main"]);
  git(lead, ["switch", "-c", BRANCH, "origin/main"]);
}

function mergeGateRow(lead: string, unit: string): string {
  const rows = readAllAuditShards(lead).split(/\n---\n/).filter((block) =>
    block.includes("**Event**: GATE_APPROVED") && block.includes("**Stage**: unit-merge") &&
    block.includes(`**Unit**: ${unit}\n`)
  );
  return rows.at(-1) ?? "";
}

function pinToBranch(lead: string, unit: string): Record<string, string> {
  const pin = runMergeTool(UNIT, ["pin", unit], lead);
  expect(pin.status, pin.out).toBe(0);
  return JSON.parse(pin.stdout).merge_gate as Record<string, string>;
}

function landOnBranch(lead: string, unit: string): Record<string, unknown> {
  const gate = runMergeTool(UNIT, ["gate", unit, "--decision", "approve", "--user-input", "Approve"], lead);
  expect(gate.status, gate.out).toBe(0);
  expect(JSON.parse(gate.stdout).land.command).toContain(`--target ${BRANCH}`);
  expect(mergeGateRow(lead, unit)).toContain(`**Target branch**: ${BRANCH}`);
  const landed = runMergeTool(UNIT, ["land", unit], lead);
  expect(landed.status, landed.out).toBe(0);
  return JSON.parse(landed.stdout) as Record<string, unknown>;
}

// A refusal's words, as the tool prints them in its JSON error.
function refusal(out: string): string {
  try {
    return (JSON.parse(out.trim().split("\n").at(-1) ?? "") as { error?: string }).error ?? out;
  } catch {
    return out;
  }
}

function isPushOffer(directive: Record<string, unknown>): boolean {
  return directive.kind === "ask" && directive.ask_type === "team-handover" &&
    ((directive.handovers ?? []) as string[]).includes("push");
}

describe("a team Unit lands on the branch the main checkout is on", () => {
  test("pin names the branch, the gate records it, land lands there, and main is not touched", () => {
    const { seed: lead, remote } = makeSeed(parallelDependencyBody());
    onRecordsBranch(lead);
    const mainHere = git(lead, ["rev-parse", "main"]);
    const mainThere = git(remote, ["rev-parse", "main"]);

    prepareCandidate(remote, "alpha", "alpha-team");
    const terms = pinToBranch(lead, "alpha");
    expect(terms.target_branch).toBe(BRANCH);
    expect(terms.ask).toContain(`into ${BRANCH}`);
    expect(terms.ask).toContain(`it reaches main when ${BRANCH} is merged there`);
    const pinned = readUnitMergeTransaction(lead, "alpha");
    expect(pinned?.landing_branch).toBe(BRANCH);
    expect(pinned?.integration_branch).toBe("main");

    const alpha = landOnBranch(lead, "alpha");
    expect(alpha.landed).toBe(true);
    expect(alpha.notice).toBe(
      `alpha landed on ${BRANCH}; it reaches main when ${BRANCH} is merged into main.`,
    );
    expect(alpha.next_step).toBeUndefined();
    expect(git(lead, ["branch", "--show-current"])).toBe(BRANCH);
    expect(readFileSync(join(lead, "src", "alpha.ts"), "utf-8")).toContain("team");
    expect(unitProgressRow(lead, "alpha")).toContain("| alpha | alpha-team | [x] |");
    expect(git(lead, ["rev-parse", "main"])).toBe(mainHere);
    expect(git(remote, ["rev-parse", "main"])).toBe(mainThere);

    // Nothing offers to push, and a share pushes nothing: the landing is not
    // on main until the branch is merged there.
    expect(isPushOffer(nextDirective(lead))).toBe(false);
    const share = runMergeTool(UNIT, ["share"], lead);
    expect(share.status, share.out).not.toBe(0);
    expect(share.out).toContain(
      `alpha landed on ${BRANCH}, not main; it reaches main when ${BRANCH} is merged there.`,
    );
    expect(git(remote, ["rev-parse", "main"])).toBe(mainThere);
    expect(() => git(remote, ["rev-parse", "--verify", `refs/heads/${BRANCH}`])).toThrow();

    // A second Unit lands on the same branch, now ahead of main.
    prepareCandidate(remote, "beta", "beta-team");
    expect(pinToBranch(lead, "beta").target_branch).toBe(BRANCH);
    expect(landOnBranch(lead, "beta").landed).toBe(true);
    expect(readFileSync(join(lead, "src", "beta.ts"), "utf-8")).toContain("team");
    expect(git(lead, ["rev-parse", "main"])).toBe(mainHere);
    expect(git(remote, ["rev-parse", "main"])).toBe(mainThere);
  });

  // A dependent Unit opens for a claim once its dependency is on main: the
  // team builds on its code, which only the merged branch gives it.
  test("once the branch is merged into main, the landed Unit's claim is over and a Unit that depends on it lands there", () => {
    const { seed: lead, remote } = makeSeed();
    onRecordsBranch(lead);
    const alphaTeam = prepareCandidate(remote, "alpha", "alpha-team").checkout;
    pinToBranch(lead, "alpha");
    expect(landOnBranch(lead, "alpha").landed).toBe(true);
    // The person pushes the branch and merges it into main with a merge
    // commit.
    git(lead, ["push", "origin", BRANCH]);
    const reviewer = clone(remote, "reviewer");
    git(reviewer, ["fetch", "origin", BRANCH]);
    git(reviewer, ["merge", "--no-ff", "-m", "Merge the records", `origin/${BRANCH}`]);
    git(reviewer, ["push", "origin", "main"]);

    git(alphaTeam, ["pull", "--ff-only", "origin", "main"]);
    expect(readApplicableTeamUnitScopeStamp(alphaTeam)).toBeNull();

    prepareCandidate(remote, "beta", "beta-team");
    git(lead, ["pull", "--ff-only", "origin", "main"]);
    expect(pinToBranch(lead, "beta").target_branch).toBe(BRANCH);
    expect(landOnBranch(lead, "beta").landed).toBe(true);
    expect(unitProgressRow(lead, "beta")).toContain("| beta | beta-team | [x] |");
  });

  test("a checkout switched after the pin is refused, and a branch behind main is stale", () => {
    const { seed: lead, remote } = makeSeed(parallelDependencyBody());
    onRecordsBranch(lead);
    prepareCandidate(remote, "alpha", "alpha-team");
    approveMerge(lead, "alpha");
    expect(mergeGateRow(lead, "alpha")).toContain(`**Target branch**: ${BRANCH}`);

    git(lead, ["switch", "main"]);
    const switched = runMergeTool(UNIT, ["land", "alpha"], lead);
    expect(switched.status, switched.out).not.toBe(0);
    expect(refusal(switched.out)).toContain(`Unit landing expected branch "${BRANCH}", found "main".`);
    const target = runMergeTool(UNIT, ["land", "alpha", "--target", "main"], lead);
    expect(target.status, target.out).not.toBe(0);
    expect(refusal(target.out)).toContain(`merge gate approved target "${BRANCH}", not "main".`);

    git(lead, ["switch", BRANCH]);
    const other = clone(remote, "other");
    git(other, ["commit", "--allow-empty", "-m", "another team's change"]);
    git(other, ["push", "origin", "main"]);
    const stale = runMergeTool(UNIT, ["land", "alpha"], lead);
    expect(stale.status, stale.out).not.toBe(0);
    expect(refusal(stale.out)).toContain(`local target "${BRANCH}" is stale`);
  });

  test("on the integration branch itself, pin names it and records no other landing branch", () => {
    const { seed: lead, remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-team");
    const terms = pinToBranch(lead, "alpha");
    expect(terms.target_branch).toBe("main");
    expect(terms.ask).not.toContain("reaches main");
    expect(readUnitMergeTransaction(lead, "alpha")).not.toHaveProperty("landing_branch");
    const gate = runMergeTool(UNIT, ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"], lead);
    expect(gate.status, gate.out).toBe(0);
    expect(mergeGateRow(lead, "alpha")).toContain("**Target branch**: main");
  });
});
