// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:land, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:share, subcommand:aidlc-orchestrate:next, function:scopeStampLanded, function:landedNotOnRemote
//
// A team whose integration branch is protected brings a landed Unit's records
// to it through a pull request: the lead lands, pushes the landing's commits to
// a branch, and the pull request merges them. When that pull request is
// squash-merged, the integration branch gets one commit with the landing's
// content and none of its commits (the claim commit, the landing's merge).
// Everything that asks whether the Unit's landing reached the integration
// branch still answers yes: the team's checkout is no longer held to the Unit
// once it holds the squashed branch, the lead is not offered a push of a
// landing the remote already has, a land run again changes nothing, and a
// Unit branch that took the landing's commits is told, by publish and pin, to
// merge the squashed main.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  UNIT,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

// The pull request of the lead's landing, squash-merged: the
// landing's commits go to a branch on the remote, and the remote's main gets
// one new commit on the main it had, with the branch's tree.
function squashRecordsPullRequest(lead: string, remote: string, unit: string): string {
  git(lead, ["push", "origin", `HEAD:refs/heads/records/${unit}`]);
  const squashed = git(remote, [
    "-c", "user.name=host", "-c", "user.email=host@example.test",
    "commit-tree", `refs/heads/records/${unit}^{tree}`, "-p", "refs/heads/main",
    "-m", `Records of ${unit} (#1)`,
  ]);
  git(remote, ["update-ref", "refs/heads/main", squashed]);
  return squashed;
}

// The checkout on the remote's main as it is now: a fresh checkout of it.
function onRemoteMain(checkout: string): void {
  git(checkout, ["fetch", "-q", "origin"]);
  git(checkout, ["checkout", "-q", "-B", "main", "origin/main"]);
}

function landedOnRemoteAsSquash(dependencies?: string): {
  lead: string;
  remote: string;
  team: string;
  squashed: string;
  mergeOid: string;
} {
  const { seed: lead, remote } = makeSeed(dependencies);
  const { checkout: team } = prepareCandidate(remote, "alpha", "alpha-team");
  gateAndLand(lead, "alpha");
  const mergeOid = String(JSON.parse(runMergeTool(UNIT, ["land", "alpha"], lead).stdout).git_commit_oid);
  const squashed = squashRecordsPullRequest(lead, remote, "alpha");
  // The squash has the landing's content and none of its commits.
  expect(notAncestor(remote, mergeOid, "refs/heads/main")).toBe(true);
  expect(git(remote, ["rev-parse", "refs/heads/main^{tree}"])).toBe(git(lead, ["rev-parse", "HEAD^{tree}"]));
  return { lead, remote, team, squashed, mergeOid };
}

function notAncestor(dir: string, oid: string, of: string): boolean {
  return runGit(dir, ["merge-base", "--is-ancestor", oid, of]) !== 0;
}

function runGit(dir: string, args: string[]): number {
  return Bun.spawnSync(["git", ...args], { cwd: dir }).exitCode;
}

function handovers(directive: Record<string, unknown>): unknown[] {
  return directive.ask_type === "team-handover" ? (directive.handovers as unknown[]) ?? [] : [];
}

const SQUASHED_LANDING = 'merged the landing of "alpha" commit by commit, and origin/main has it squashed';

// Alpha landed; the beta team's branch merged alpha's landing as its own
// commits (from the records branch); then alpha's records pull request was
// squash-merged. Beta's work is committed and not published.
function betaHoldingSquashedLanding(): { lead: string; beta: string } {
  const { seed: lead, remote } = makeSeed(parallelDependencyBody());
  prepareCandidate(remote, "alpha", "alpha-team");
  gateAndLand(lead, "alpha");
  git(lead, ["push", "origin", "HEAD:refs/heads/records/alpha"]);
  const { checkout: beta } = prepareCandidate(remote, "beta", "beta-team", {
    afterClaim: (checkout) => {
      git(checkout, ["fetch", "-q", "origin", "records/alpha"]);
      git(checkout, ["merge", "-q", "--no-edit", "FETCH_HEAD"]);
    },
    publish: false,
  });
  squashRecordsPullRequest(lead, remote, "alpha");
  return { lead, beta };
}

// The team merges the squashed main into its Unit branch. Plain git: the
// squashed main and this branch both changed the Unit Progress table since
// the main they share, so the merge stops on aidlc-state.md. This branch's
// table already has the landing's rows, so its own side is the resolution.
function mergeSquashedMain(beta: string): void {
  git(beta, ["fetch", "-q", "origin"]);
  expect(runGit(beta, ["merge", "-q", "--no-edit", "origin/main"])).not.toBe(0);
  const state = relative(beta, seededStateFile(beta));
  expect(git(beta, ["diff", "--name-only", "--diff-filter=U"])).toBe(state);
  git(beta, ["checkout", "--ours", "--", state]);
  git(beta, ["add", "-A"]);
  git(beta, ["commit", "-qm", "merge the squashed main"]);
}

describe("a landing whose pull request was squash-merged", () => {
  // (a) The team that built the Unit takes the squashed main: its checkout is
  // no longer held to the landed Unit, so it claims the next one there.
  test("the team's checkout on the squashed main is free of the landed Unit and claims the next", () => {
    const { team, mergeOid } = landedOnRemoteAsSquash();
    onRemoteMain(team);
    expect(notAncestor(team, mergeOid, "HEAD")).toBe(true);
    const claimed = runMergeTool(UNIT, ["claim", "beta", "--team", "alpha-team"], team);
    expect(claimed.status, claimed.out).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ claimed: true, unit: "beta" });
  });

  // (a) What keeps a checkout held stays: on the squashed main, a merged
  // cell alone, with no landing of this claim recorded, does not free it.
  test("a merged cell with no recorded landing of this claim keeps the checkout held", () => {
    const { remote } = makeSeed();
    const { checkout: team } = prepareCandidate(remote, "alpha", "alpha-team");
    // On main as the remote has it (no landing there), the team marks every
    // row merged by hand and commits it.
    onRemoteMain(team);
    const path = seededStateFile(team);
    const main = readFileSync(path, "utf-8");
    expect(main).not.toContain("| merged |");
    const edited = main
      .replace(/^\| unit \|(.*)\|$/m, "| unit |$1| merged |")
      .replace(/^\| --- \|(.*)\|$/m, "| --- |$1| --- |")
      .replace(/^\| (skeleton|alpha|beta) \|(.*)\|$/gm, (_line, unit: string, rest: string) =>
        `| ${unit} |${rest}| ${unit === "beta" ? "" : "[x]"} |`);
    writeFileSync(path, edited);
    git(team, ["commit", "-qam", "mark alpha merged by hand"]);
    const claimed = runMergeTool(UNIT, ["claim", "beta", "--team", "alpha-team"], team);
    expect(claimed.status).not.toBe(0);
    expect(JSON.parse(claimed.out).error).toContain('already scoped to Unit "alpha"');
  });

  // (b) The lead's main once it fetched the squashed main, and once it pulled
  // it into its own (a merge of the two): the remote has the landing, so no
  // push of it is offered.
  test("the lead that fetched the squashed main is not offered a push of the landing", () => {
    const { lead } = landedOnRemoteAsSquash();
    git(lead, ["fetch", "-q", "origin"]);
    expect(handovers(nextDirective(lead))).not.toContain("push");
  });

  test("the lead that pulled the squashed main into its own is not offered a push of the landing", () => {
    const { lead } = landedOnRemoteAsSquash();
    git(lead, ["-c", "pull.rebase=false", "pull", "-q", "--no-edit", "origin", "main"]);
    expect(handovers(nextDirective(lead))).not.toContain("push");
  });

  test("the lead on the squashed main: no push offer, and the share records no landing", () => {
    const { lead } = landedOnRemoteAsSquash();
    onRemoteMain(lead);
    expect(handovers(nextDirective(lead))).not.toContain("push");
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    expect(git(lead, ["log", "-1", "--format=%s"])).not.toContain("Record the alpha landing");
  });

  // (c) The land run again on the lead's squashed main.
  test("land run again on the squashed main reports the landing as done and changes nothing", () => {
    const { lead, mergeOid } = landedOnRemoteAsSquash();
    onRemoteMain(lead);
    const head = git(lead, ["rev-parse", "HEAD"]);
    const again = runMergeTool(UNIT, ["land", "alpha"], lead);
    expect(again.status, again.out).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ landed: true, status: "complete", git_commit_oid: mergeOid });
    expect(JSON.parse(again.stdout).next_step).toBeUndefined();
    expect(git(lead, ["rev-parse", "HEAD"])).toBe(head);
  });

  // (d) A Unit branch that merged another Unit's landing commit by commit
  // before that landing's pull request was squash-merged: pin reads what the
  // landing brought as this Unit's own change, and taking those records out
  // would not do (main has them). Publish and pin both say to merge the
  // squashed main; pin pins nothing, and once the team has merged and
  // published again, pin takes it and it lands.
  test("pin refuses a Unit branch holding the squashed landing's commits and says to merge the squashed main", () => {
    const { lead, beta } = betaHoldingSquashedLanding();
    const published = runMergeTool(UNIT, ["publish", "beta"], beta);
    expect(published.status, published.out).toBe(0);
    const note = String(JSON.parse(published.stdout).records_outside_unit_tree_note);
    expect(note).toContain(SQUASHED_LANDING);
    expect(note).toContain("Merge origin/main into this branch and publish again.");
    expect(note).not.toContain("git rm");
    onRemoteMain(lead);
    const head = git(lead, ["rev-parse", "HEAD"]);
    const pin = runMergeTool(UNIT, ["pin", "beta"], lead);
    expect(pin.status).not.toBe(0);
    const error = String(JSON.parse(pin.out).error);
    expect(error).toContain("outside claimed Unit record tree");
    expect(error).toContain(SQUASHED_LANDING);
    expect(error).toContain(
      "In the checkout where beta-team claimed beta (not this one), merge origin/main into its branch and " +
        "publish again; then pin beta again.",
    );
    expect(error).not.toContain("git rm");
    expect(git(lead, ["rev-parse", "HEAD"])).toBe(head);
    mergeSquashedMain(beta);
    const again = runMergeTool(UNIT, ["publish", "beta"], beta);
    expect(again.status, again.out).toBe(0);
    expect(JSON.parse(again.stdout).records_outside_unit_tree).toBeUndefined();
    gateAndLand(lead, "beta");
    expect(unitProgressRow(lead, "beta")).toMatch(/\| \[x\] \|$/);
  });
});
