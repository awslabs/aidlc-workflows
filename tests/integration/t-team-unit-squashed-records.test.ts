// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:land, subcommand:aidlc-unit:share, subcommand:aidlc-orchestrate:next, function:scopeStampLanded, function:landedNotOnRemote
//
// A team whose integration branch is protected brings a landed Unit's records
// to it through a pull request: the lead lands, pushes the landing's commits to
// a branch, and the pull request merges them. When that pull request is
// squash-merged, the integration branch gets one commit with the landing's
// content and none of its commits (the claim commit, the landing's merge).
// Everything that asks whether the Unit's landing reached the integration
// branch still answers yes: the team's checkout is no longer held to the Unit
// once it holds the squashed branch, the lead is not offered a push of a
// landing the remote already has, and a land run again changes nothing.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
  UNIT,
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
});
