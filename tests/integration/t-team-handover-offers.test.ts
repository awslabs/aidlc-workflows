// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-unit:share, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:land, subcommand:aidlc-unit:pin, function:planMadeElsewhere, function:codeGenerationStepOnRecord
//
// In team-owned Construction on the workspace's own repository, each hand-over
// between people is put to the person as one question at the moment it is due,
// and a yes runs it: share the plan with the teams, take a Unit in another
// clone, publish a finished Unit, review and merge a published one, push main
// after a land. Each question is put once in its state; the reply that does not
// take it runs `next`, which never puts it again (no self-loop), and typed
// commands work as before.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActiveDirectiveMarker, readUnitScopeStamp } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationStepOnRecord } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  approveMerge,
  asLeadsOwnCheckout as ranTheWorkHere,
  cleanupTempDirs,
  clone,
  git,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  tempDirs,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

type Choice = { label: string; detail?: string; command?: string };

function choicesOf(directive: Record<string, unknown>): Choice[] {
  return (directive.choices ?? []) as Choice[];
}

function labels(directive: Record<string, unknown>): string[] {
  return choicesOf(directive).map((choice) => choice.label);
}

function commandFor(directive: Record<string, unknown>, label: string): string {
  const command = choicesOf(directive).find((choice) => choice.label === label)?.command;
  expect(command, JSON.stringify(directive)).toBeTruthy();
  return command as string;
}

function isHandover(directive: Record<string, unknown>, kind?: string): boolean {
  if (directive.kind !== "ask" || directive.ask_type !== "team-handover") return false;
  return kind === undefined || ((directive.handovers ?? []) as string[]).includes(kind);
}

// The lead's own checkout (asLeadsOwnCheckout), with the walking skeleton's
// stance settled, as the first Construction step does before the walk starts
// a Unit.
function asLeadsOwnCheckout(dir: string): void {
  writeFileSync(
    seededStateFile(dir),
    readFileSync(seededStateFile(dir), "utf-8")
      .replace("- **Unit Gate Rhythm**: per-stage\n", "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on\n"),
  );
  ranTheWorkHere(dir);
}

function boardText(directive: Record<string, unknown>): string {
  expect(directive.kind, JSON.stringify(directive)).toBe("notice");
  return String(directive.message);
}

describe("step 1: the lead shares the plan with the teams", () => {
  test("Several teams, claims open, a remote: the first Unit step is the share offer, once", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    const offer = nextDirective(lead);
    expect(isHandover(offer, "share"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toContain("Share them now?");
    expect(String(offer.question)).toContain("push main to origin");
    expect(labels(offer)).toEqual(["Share them with the teams", "Build them here for now"]);
    expect(commandFor(offer, "Share them with the teams")).toMatch(/ unit share$/);
    expect(commandFor(offer, "Build them here for now")).toMatch(/ next$/);
    // No self-loop: the reply that does not take it runs next, and the walk goes on.
    const walk = nextDirective(lead);
    expect(isHandover(walk), JSON.stringify(walk)).toBe(false);
    expect(walk).toMatchObject({ kind: "run-stage", unit: "alpha" });
  });

  test("share commits, pushes main, and this checkout shows the board", () => {
    const { seed: lead, remote } = makeSeed();
    asLeadsOwnCheckout(lead);
    writeFileSync(join(lead, "notes.txt"), "an untracked note\n");
    expect(String(nextDirective(lead).question)).toContain("notes.txt");
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    expect(JSON.parse(shared.stdout)).toMatchObject({ shared: true, branch: "main", remote: "origin" });
    expect(git(remote, ["rev-parse", "main"])).toBe(git(lead, ["rev-parse", "HEAD"]));
    expect(git(lead, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    const board = boardText(nextDirective(lead));
    expect(board).toContain("# Team Construction Dispatcher");
  });

  test("share refused: the commit is kept, next offers share again and starts no Unit here", () => {
    const { seed: lead, remote } = makeSeed();
    const other = clone(remote, "other");
    writeFileSync(join(other, "README.md"), "someone else pushed first\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-m", "a colleague's commit"]);
    git(other, ["push", "origin", "main"]);
    asLeadsOwnCheckout(lead);
    expect(isHandover(nextDirective(lead), "share")).toBe(true);
    const before = git(lead, ["rev-parse", "HEAD"]);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).not.toBe(0);
    expect(shared.out).toContain("pull main, then share again");
    expect(git(lead, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(git(lead, ["status", "--porcelain"])).toBe("");
    const again = nextDirective(lead);
    expect(isHandover(again, "share"), JSON.stringify(again)).toBe(true);
  });

  test("share whose commit git refuses (the team's own pre-commit hook): next offers share again and starts no Unit here", () => {
    const { seed: lead, remote } = makeSeed();
    const hooks = join(lead, "..", `${lead.split(/[\\/]/).pop()}-hooks`);
    mkdirSync(hooks, { recursive: true });
    tempDirs.push(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho \"the team's pre-commit check said no\" >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    git(lead, ["config", "core.hooksPath", hooks]);
    asLeadsOwnCheckout(lead);
    expect(isHandover(nextDirective(lead), "share")).toBe(true);
    const before = git(lead, ["rev-parse", "HEAD"]);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).not.toBe(0);
    expect(shared.out).toContain("the team's pre-commit check said no");
    expect(shared.out).toContain("Then share again.");
    expect(git(lead, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(remote, ["rev-parse", "main"])).toBe(before);
    const again = nextDirective(lead);
    expect(isHandover(again, "share"), JSON.stringify(again)).toBe(true);
  });

  test("the lead's own checkout building a Unit here pushes main for backup: the walk goes on, no board", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    expect(isHandover(nextDirective(lead), "share")).toBe(true);
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", unit: "alpha" });
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "backup"]);
    git(lead, ["push", "origin", "main"]);
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", unit: "alpha" });
  });
});

describe("step 2: another clone takes a Unit", () => {
  test("a teammate's fresh clone is offered the Units it can take; Not now shows the board, never the walk, never again", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    const mate = clone(remote, "mate");
    const offer = nextDirective(mate);
    expect(isHandover(offer, "join"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toContain("Take one for your team?");
    expect(labels(offer)).toEqual(["Take alpha", "Take beta", "Not now"]);
    expect(commandFor(offer, "Take alpha")).toMatch(/ next --claim alpha$/);
    expect(commandFor(offer, "Not now")).toMatch(/ next$/);
    const board = nextDirective(mate);
    expect(isHandover(board)).toBe(false);
    expect(boardText(board)).toContain("# Team Construction Dispatcher");
    expect(boardText(nextDirective(mate))).toContain("# Team Construction Dispatcher");
  });

  // The live run: a team built its first Unit in its own clone (that Unit's
  // rows are in the clone's own shard), the lead merged and pushed it, and the
  // team pulled main: its next Unit is offered, never a typed claim.
  test("a team's clone after its Unit lands and it pulls is offered the next Unit", () => {
    const { seed: lead, remote } = makeSeed(parallelDependencyBody());
    const { checkout } = prepareCandidate(remote, "alpha", "team-a");
    approveMerge(lead, "alpha");
    expect(runMergeTool(UNIT, ["land", "alpha"], lead).status).toBe(0);
    git(lead, ["push", "origin", "main"]);
    git(checkout, ["pull", "-q", "--ff-only", "origin", "main"]);
    const offer = nextDirective(checkout);
    expect(isHandover(offer, "join"), JSON.stringify(offer)).toBe(true);
    expect(labels(offer)).toEqual(["Take beta", "Not now"]);
  });

  test("the participant marker keeps today's picker", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    const mate = clone(remote, "mate");
    expect(runMergeTool(UNIT, ["participate"], mate).status).toBe(0);
    expect(nextDirective(mate)).toMatchObject({ kind: "ask", ask_type: "unit-claim" });
  });
});

// The claimed checkout with its Unit worked through every stage, Current Stage
// where the walk leaves it (the Unit's last stage).
function doneIn(checkout: string): Record<string, unknown> {
  writeFileSync(
    seededStateFile(checkout),
    readFileSync(seededStateFile(checkout), "utf-8")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"),
  );
  return nextDirective(checkout);
}

describe("step 3: a team publishes its finished Unit", () => {
  test("a claimed Unit done: the publish offer, once; Not now gives the done notice; publish --commit publishes", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "team-a", { publish: false });
    const offer = doneIn(checkout);
    expect(isHandover(offer, "publish"), JSON.stringify(offer)).toBe(true);
    expect(offer.unit).toBe("alpha");
    expect(String(offer.question)).toContain("for review on main?");
    expect(labels(offer)).toEqual(["Commit and publish", "Not now"]);
    expect(commandFor(offer, "Commit and publish")).toMatch(/ unit publish alpha --commit$/);
    // The offer is the step after Code Generation, as the done notice is: the
    // Unit's own commit is not held to its plan.
    const state = readFileSync(seededStateFile(checkout), "utf-8");
    expect(codeGenerationStepOnRecord(checkout, state, readActiveDirectiveMarker(checkout, state))).toBe(false);
    const notice = nextDirective(checkout);
    expect(notice).toMatchObject({ kind: "notice", unit: "alpha" });
    expect(String(notice.message)).toContain('Unit "alpha" is complete and approved in this checkout');
    expect(String(notice.message)).not.toContain("aidlc unit publish");
    expect(isHandover(nextDirective(checkout))).toBe(false);
    writeFileSync(join(checkout, "src", "alpha-extra.ts"), "export const extra = 1;\n");
    const claimRef = readUnitScopeStamp(checkout)?.claim_ref as string;
    const claimBefore = git(remote, ["rev-parse", claimRef]);
    const published = runMergeTool(UNIT, ["publish", "alpha", "--commit"], checkout);
    expect(published.status, published.out).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({ published: true, unit: "alpha" });
    expect(git(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(git(remote, ["rev-parse", claimRef])).not.toBe(claimBefore);
  });

  test("publish without --commit still refuses a dirty tree, as today", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "team-a", { publish: false });
    writeFileSync(join(checkout, "src", "alpha.ts"), "export const alpha = \"edited\";\n");
    const published = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(published.status).not.toBe(0);
    expect(published.out).toContain("commit the candidate first");
  });
});

describe("step 4: a published Unit is reviewed and merged", () => {
  test("the lead's board sees a team's publish without a typed fetch and offers review; Not now leaves a board line", () => {
    const { seed: lead, remote } = makeSeed();
    asLeadsOwnCheckout(lead);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "lead's record"]);
    git(lead, ["push", "origin", "main"]);
    prepareCandidate(remote, "alpha", "team-a");
    const offer = nextDirective(lead);
    expect(isHandover(offer, "review"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toContain("alpha is ready from team-a");
    expect(labels(offer)).toEqual(["Review and merge alpha", "Not now"]);
    expect(commandFor(offer, "Review and merge alpha")).toMatch(/ unit pin alpha$/);
    const board = nextDirective(lead);
    expect(isHandover(board)).toBe(false);
    expect(boardText(board)).toContain("`alpha` is ready from team-a to review and merge");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], lead);
    expect(pin.status, pin.out).toBe(0);
    expect(JSON.parse(pin.stdout).merge_gate).toMatchObject({ strategy: "merge", target_branch: "main" });
  });

  // The live sighting: both teams claimed, built and published from their
  // clones; the lead's own checkout had fetched nothing since, so it held no
  // claim ref of its own, and its /aidlc walked the Units itself.
  test("teams' claims and publishes only on the remote: the lead's /aidlc gives the review, never the walk", () => {
    const { seed: lead, remote } = makeSeed(parallelDependencyBody());
    asLeadsOwnCheckout(lead);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "lead's record"]);
    git(lead, ["push", "origin", "main"]);
    prepareCandidate(remote, "alpha", "team-a");
    prepareCandidate(remote, "beta", "team-b");
    expect(git(lead, ["for-each-ref", "refs/remotes/origin/claim", "refs/heads/claim"])).toBe("");
    const offer = nextDirective(lead);
    expect(offer.kind, JSON.stringify(offer)).not.toBe("run-stage");
    expect(isHandover(offer, "review"), JSON.stringify(offer)).toBe(true);
    expect(labels(offer)).toEqual(["Review and merge alpha", "Review and merge beta", "Not now"]);
    const board = nextDirective(lead);
    expect(board.kind, JSON.stringify(board)).not.toBe("run-stage");
    expect(boardText(board)).toContain("`beta` is ready from team-b to review and merge");
  });

  test("the lead's own fresh clone: review and take in one question", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "team-a");
    const fresh = clone(remote, "fresh");
    const offer = nextDirective(fresh);
    expect(isHandover(offer, "review"), JSON.stringify(offer)).toBe(true);
    expect(isHandover(offer, "join")).toBe(true);
    expect(labels(offer)).toEqual(["Review and merge alpha", "Take beta", "Not now"]);
    expect(isHandover(nextDirective(fresh))).toBe(false);
  });
});

describe("step 5: main is pushed after a land", () => {
  test("land says run next only when the push is due; next offers it once; share pushes it", () => {
    const { seed: lead, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "team-a");
    approveMerge(lead, "alpha");
    const landed = runMergeTool(UNIT, ["land", "alpha"], lead);
    expect(landed.status, landed.out).toBe(0);
    const land = JSON.parse(landed.stdout);
    expect(land).toMatchObject({ landed: true, status: "complete" });
    expect(String(land.next_step)).toMatch(/ next`/);
    const offer = nextDirective(lead);
    expect(isHandover(offer, "push"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toContain("so the other teams see alpha");
    expect(labels(offer)).toEqual(["Push main", "Not now"]);
    expect(commandFor(offer, "Push main")).toMatch(/ unit share$/);
    expect(isHandover(nextDirective(lead), "push")).toBe(false);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    expect(git(remote, ["merge-base", "--is-ancestor", land.git_commit_oid, "main"])).toBe("");
    // What the push committed first, if anything, is named for the landing, never as the plan.
    expect(git(lead, ["log", "-1", "--format=%s"])).not.toBe("Share the plan with the teams");
    expect(git(lead, ["status", "--porcelain"])).toBe("");
  });

  test("a land already on origin is not offered", () => {
    const { seed: lead, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "team-a");
    approveMerge(lead, "alpha");
    expect(runMergeTool(UNIT, ["land", "alpha"], lead).status).toBe(0);
    git(lead, ["push", "origin", "main"]);
    expect(isHandover(nextDirective(lead), "push")).toBe(false);
  });
});
