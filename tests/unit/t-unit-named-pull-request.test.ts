// covers: subcommand:aidlc-unit:merged, audit:UNIT_MERGED, function:checkTeamResults, function:renderUnitBoard
//
// The lead names a pull request as a Unit's build (a partner team that can read
// a repository and push only to its fork): the number goes on the plan as the
// lead's word, and the Unit counts as merged once git shows that pull request's
// last head merged in that repository. AI-DLC reads no other pull request, and
// keeps nothing in a code clone for it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  DEPENDENCIES,
  git,
  HOME_RECORD,
  makePlanHome,
  makePlanHomeWithRemote,
  mergeOnHost,
  next,
  ORCH,
  planFrom,
  planRefOf,
  planWordAt,
  refundsTakenInClone,
  run,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");

afterEach(cleanupTeamBuild);

// A partner's pull request on a code host: a branch of commits pushed to the
// host's own ref for the number, as GitHub keeps refs/pull/<n>/head.
function partnerPullRequest(host: string, number: number, files: Record<string, string>, ref = `refs/pull/${number}/head`): string {
  const dir = join(tempDir("partner"), "repo");
  git(tempDir("partner-parent"), ["clone", "-q", host, dir]);
  git(dir, ["config", "user.name", "partner"]);
  git(dir, ["config", "user.email", "partner@example.test"]);
  git(dir, ["switch", "-q", "-c", "partner-work"]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "Checkout UI"]);
  const head = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["push", "-q", "origin", `${head}:${ref}`]);
  return head;
}

// The host merges a pull request by its head: a squash with the number in its
// subject (GitHub's form), or a merge commit.
function mergePullRequest(host: string, ref: string, how: "squash" | "merge", subject: string): string {
  const dir = join(tempDir("maintainer"), "repo");
  git(tempDir("maintainer-parent"), ["clone", "-q", host, dir]);
  git(dir, ["config", "user.name", "maintainer"]);
  git(dir, ["config", "user.email", "maintainer@example.test"]);
  git(dir, ["fetch", "-q", "origin", ref]);
  if (how === "squash") {
    git(dir, ["merge", "-q", "--squash", "FETCH_HEAD"]);
    git(dir, ["commit", "-q", "-m", subject]);
  } else {
    git(dir, ["merge", "-q", "--no-ff", "-m", subject, "FETCH_HEAD"]);
  }
  git(dir, ["push", "-q", "origin", "main"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

const UI = { "src/checkout-ui.ts": "export const checkoutUi = 1;\n" };

function name(dir: string, unit: string, repo: string, number: string, words = "pull request 7 in checkout-web is the partner's build of checkout-ui") {
  return run(UNIT, ["merged", unit, "--repo", repo, "--pull-request", number, "--person-words", words], dir);
}

function board(dir: string): string {
  const looked = run(ORCH, ["team-board"], dir);
  expect(looked.status, looked.out).toBe(0);
  return looked.out;
}

const merges = (dir: string, unit: string): number =>
  readAuditShardEvents(dir).filter((row) => row.event === "UNIT_MERGED" && row.block.includes(`**Unit**: ${unit}`)).length;

describe("the lead names a pull request as a Unit's build", () => {
  test("the naming goes on the plan as the lead's word, and nothing is counted merged before git shows it", () => {
    const home = makePlanHome();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    const clone = join(home.dir, "checkout-web");
    const refsBefore = git(clone, ["for-each-ref", "--format=%(refname)"]);
    const plan = Object.values(home.hosts)[0];
    const before = git(plan, ["rev-parse", planRefOf(home.id8)]);
    const named = name(home.dir, "checkout-ui", "checkout-web", "7");
    expect(named.status, named.out).toBe(0);
    expect(String(named.json?.notice)).toBe("Written on the plan: pull request 7 in checkout-web is the build of checkout-ui. " +
      "checkout-ui counts as merged once git shows that pull request merged in checkout-web.");
    const word = planWordAt(home, "checkout-ui") as Record<string, unknown>;
    expect(word.pull_requests).toEqual([{
      repo: "checkout-web", number: 7, words: "pull request 7 in checkout-web is the partner's build of checkout-ui", at: expect.any(String),
    }]);
    expect(word.said_merged).toBeUndefined();
    expect(word.done).toBeUndefined();
    expect(git(plan, ["log", "-1", "--format=%s", planRefOf(home.id8)])).toEndWith(": pull request 7 in checkout-web named as the build of checkout-ui");
    expect(git(plan, ["rev-parse", `${planRefOf(home.id8)}^`])).toBe(before);
    expect(git(clone, ["for-each-ref", "--format=%(refname)"])).toBe(refsBefore);
    expect(merges(home.dir, "checkout-ui")).toBe(0);
    expect(board(home.dir)).toContain("- checkout-ui: its build is pull request 7 in checkout-web, not merged yet");
  });

  test("a number that is not a positive whole number gets the usage, and nothing is written or counted", () => {
    const home = makePlanHome();
    const plan = Object.values(home.hosts)[0];
    const before = git(plan, ["rev-parse", planRefOf(home.id8)]);
    for (const bad of ["0", "x", "-3", "7.5"]) {
      const named = name(home.dir, "checkout-ui", "checkout-web", bad);
      expect(named.status, bad).not.toBe(0);
      expect(named.out, bad).toContain("--pull-request <n>");
    }
    expect(git(plan, ["rev-parse", planRefOf(home.id8)])).toBe(before);
    expect(merges(home.dir, "checkout-ui")).toBe(0);
  });

  for (const how of ["squash", "merge"] as const) {
    test(`merged on the host by a ${how}: the lead's next look counts the Unit merged and writes it on the plan, once`, () => {
      const home = makePlanHome();
      const web = home.hosts["checkout-web"];
      partnerPullRequest(web, 7, UI);
      expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
      mergePullRequest(web, "refs/pull/7/head", how, "Checkout UI (#7)");
      const seen = next(home.dir);
      expect((seen.change_notices ?? []) as string[], JSON.stringify(seen).slice(0, 600)).toContain("checkout-ui is merged in checkout-web. Written on the plan.");
      expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true, verdicts: [expect.objectContaining({ repo: "checkout-web", merged: true })] });
      expect(merges(home.dir, "checkout-ui")).toBe(1);
      expect(board(home.dir)).toContain("- checkout-ui: its build is pull request 7 in checkout-web, done");
      next(home.dir);
      expect(merges(home.dir, "checkout-ui")).toBe(1);
      expect(git(join(home.dir, "checkout-web"), ["for-each-ref", "refs/aidlc/"])).toBe("");
    });
  }

  test("already merged when the lead names it: said with where git saw it, and counted at once", () => {
    const home = makePlanHome();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    const squash = mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    const named = name(home.dir, "checkout-ui", "checkout-web", "7");
    expect(named.status, named.out).toBe(0);
    expect(String(named.json?.notice)).toBe("Written on the plan: pull request 7 in checkout-web is the build of checkout-ui, and git shows it merged in " +
      `checkout-web at ${squash.slice(0, 7)} "Checkout UI (#7)". checkout-ui is recorded as merged here.`);
    expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true });
    expect(merges(home.dir, "checkout-ui")).toBe(1);
  });

  test("already merged when the lead names it, with the lead's sign-off on: said with where git saw it, and that it waits for the sign-off", () => {
    const home = makePlanHome();
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    const squash = mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    const named = name(home.dir, "checkout-ui", "checkout-web", "7");
    expect(named.status, named.out).toBe(0);
    expect(String(named.json?.notice)).toBe("Written on the plan: pull request 7 in checkout-web is the build of checkout-ui, and git shows it merged in " +
      `checkout-web at ${squash.slice(0, 7)} "Checkout UI (#7)". checkout-ui waits for your sign-off.`);
    expect(planWordAt(home, "checkout-ui")?.done).toBeUndefined();
  });

  test("a pull request whose content main does not have is not merged", () => {
    const home = makePlanHome();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    partnerPullRequest(web, 8, { "src/other.ts": "export const other = 1;\n" });
    mergePullRequest(web, "refs/pull/8/head", "squash", "Other (#8)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    next(home.dir);
    expect(planWordAt(home, "checkout-ui")?.done).toBeUndefined();
    expect(board(home.dir)).toContain("- checkout-ui: its build is pull request 7 in checkout-web, not merged yet");
  });

  test("the host keeps no head for that number: the naming is written, and the line says git cannot read it", () => {
    const home = makePlanHome();
    const named = name(home.dir, "checkout-ui", "checkout-web", "7");
    expect(named.status, named.out).toBe(0);
    expect(String(named.json?.notice)).toBe("Written on the plan: pull request 7 in checkout-web is the build of checkout-ui. " +
      "But checkout-web has no pull request 7 that git can read, so checkout-ui is not counted merged by it. " +
      "If the number is wrong, give me the right one; if checkout-ui is merged some other way, say so.");
    expect((planWordAt(home, "checkout-ui") as Record<string, unknown>).pull_requests).toHaveLength(1);
  });

  test("the repository is not cloned here: the naming is written, the clone is offered, and the board says it is not read here", () => {
    const home = makePlanHome();
    partnerPullRequest(home.hosts["checkout-web"], 7, UI);
    renameSync(join(home.dir, "checkout-web"), join(tempDir("moved"), "checkout-web"));
    const named = name(home.dir, "checkout-ui", "checkout-web", "7");
    expect(named.status, named.out).toBe(0);
    expect(String(named.json?.notice)).toBe("Written on the plan: pull request 7 in checkout-web is the build of checkout-ui. " +
      "checkout-web is not cloned in this workspace, so I cannot read that pull request yet. " +
      "Say if you want me to clone checkout-web here; the next step then reads it.");
    expect(board(home.dir)).toContain("- checkout-ui: its build is pull request 7 in checkout-web, not read here: checkout-web is not cloned in this workspace");
    // The board offers the clone a build is offered, from this workspace's own list.
    const step = next(home.dir);
    expect(JSON.stringify(step.offers ?? []), JSON.stringify(step).slice(0, 600)).toContain("intent add-repo checkout-web");
  });

  test("the lead's other computer reads the Unit done on the plan and records it there too", () => {
    const home = makePlanHomeWithRemote();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    const laptop = cloneOf(home.remote, "laptop");
    expect(merges(laptop, "checkout-ui")).toBe(0);
    // The lead carries the work on there, as the lead.
    const offer = next(laptop);
    const carry = ((offer.choices ?? []) as Array<{ label: string; command?: string }>).find((choice) => choice.label.includes("as the lead"));
    const pick = /--pick (\S+)/.exec(carry?.command ?? "")?.[1];
    expect(pick, JSON.stringify(offer).slice(0, 600)).toBeString();
    const switched = run(join(AIDLC_SRC, "tools", "aidlc.ts"), ["engine", "intent", "switch", pick!], laptop);
    expect(switched.status, switched.out).toBe(0);
    next(laptop);
    expect(merges(laptop, "checkout-ui")).toBe(1);
  });

  test("before Build and Test, a Unit built only by a named pull request is said once to have no code summary or test instructions here", () => {
    const home = makePlanHome();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    const jumped = run(JUMP, ["execute", "--target", "build-and-test", "--direction", "forward"], home.dir);
    expect(jumped.status, jumped.out).toBe(0);
    const step = next(home.dir);
    expect(JSON.stringify(step), JSON.stringify(step).slice(0, 800))
      .toContain("checkout-ui's build is pull request 7 in checkout-web, so its code summary and test instructions are not here: Build and Test runs without them.");
  });

  test("two named pull requests in two repositories: written as each merges, done once both are", () => {
    const home = makePlanHome();
    partnerPullRequest(home.hosts["checkout-web"], 7, UI);
    partnerPullRequest(home.hosts.billing, 3, { "lib/ui-hook.ts": "export const hook = 1;\n" });
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    expect(name(home.dir, "checkout-ui", "billing", "3", "and pull request 3 in billing").status).toBe(0);
    expect(board(home.dir)).toContain("- checkout-ui: its build is pull request 7 in checkout-web and pull request 3 in billing, " +
      "checkout-web not merged yet, billing not merged yet (0 of 2 merged)");
    mergePullRequest(home.hosts["checkout-web"], "refs/pull/7/head", "squash", "Checkout UI (#7)");
    const first = next(home.dir);
    expect((first.change_notices ?? []) as string[], JSON.stringify(first).slice(0, 600)).toContain("checkout-web merged checkout-ui. Written on the plan.");
    expect(planWordAt(home, "checkout-ui")?.done).toBeUndefined();
    mergePullRequest(home.hosts.billing, "refs/pull/3/head", "merge", "Merge pull request #3");
    const second = next(home.dir);
    expect((second.change_notices ?? []) as string[], JSON.stringify(second).slice(0, 600))
      .toContain("checkout-ui is merged in checkout-web and billing. Written on the plan.");
    expect(merges(home.dir, "checkout-ui")).toBe(1);
  });

  test("with the lead's sign-off on: merged, asked at the board, done at the sign-off", () => {
    const home = makePlanHome();
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    partnerPullRequest(home.hosts["checkout-web"], 7, UI);
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    mergePullRequest(home.hosts["checkout-web"], "refs/pull/7/head", "squash", "Checkout UI (#7)");
    const seen = next(home.dir);
    expect(planWordAt(home, "checkout-ui")?.done).toBeUndefined();
    expect(JSON.stringify(seen)).toContain("checkout-ui's build is pull request 7 in checkout-web: checkout-web merged. Sign it off?");
    const signed = run(UNIT, ["sign-off", "checkout-ui", "--person-words", "sign it off"], home.dir);
    expect(signed.status, signed.out).toBe(0);
    expect(String(signed.json?.notice)).toBe("Signed off checkout-ui; every repo it changed has merged, so it is done.");
    expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true });
    expect(merges(home.dir, "checkout-ui")).toBe(1);
  });

  test("the host does not answer at a look: the line that it could not be reached, never that it has no such pull request", () => {
    const home = makePlanHome();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    renameSync(web, `${web}-gone`);
    const step = next(home.dir);
    expect(JSON.stringify(step.change_notices ?? []), JSON.stringify(step).slice(0, 600)).toContain("checkout-web could not be reached just now");
    expect(JSON.stringify(step)).not.toContain("has no pull request 7");
  });

  test("a team's take offer lists a Unit whose build is a named pull request as being built, with no start for it", () => {
    const { home } = refundsTakenInClone();
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    // Nothing else is open, so the offer is the list alone.
    const offer = next(cloneOf(home.remote, "bob"));
    expect(String(offer.narration), JSON.stringify(offer).slice(0, 600))
      .toContain("Being built: refunds (by alice in payments), checkout-ui (its build is pull request 7 in checkout-web). Nothing is ready to take yet.");
    expect(JSON.stringify(offer)).not.toContain("Start checkout-ui");
  });

  test("a take not pushed yet that the lead names a pull request for: the board says both, and done counts for the lead's walk", () => {
    const home = makePlanHomeWithRemote();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", ...planFrom(home)], bob).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    partnerPullRequest(home.hosts["checkout-web"], 7, UI);
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    expect(board(home.dir)).toMatch(/- checkout-ui: building since \d{1,2} [A-Z][a-z]{2}, taken by bob; its build is pull request 7 in checkout-web, not merged yet/);
    mergePullRequest(home.hosts["checkout-web"], "refs/pull/7/head", "squash", "Checkout UI (#7)");
    next(home.dir);
    const row = readAuditShardEvents(home.dir).find((entry) => entry.event === "UNIT_MERGED" && entry.block.includes("**Unit**: checkout-ui"));
    expect(row?.block ?? "").toContain("**Attempt Generation**: 1");
    expect(board(home.dir)).toContain("- checkout-ui: its build is pull request 7 in checkout-web, done");
  });

  // A Unit with a pushed result: the merge check reads the number the lead
  // named where the squash's message names none.
  test("a pushed Unit whose squash names no number: the number the lead names is read, merged, and the lead is not asked", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const fixDir = join(tempDir("reviewer"), "repo");
    git(tempDir("reviewer-parent"), ["clone", "-q", "--branch", "refunds", hosts["checkout-api"], fixDir]);
    git(fixDir, ["config", "user.name", "reviewer"]);
    git(fixDir, ["config", "user.email", "reviewer@example.test"]);
    writeFileSync(join(fixDir, "src", "refunds.ts"), "export const refunds = 1; // reviewed\n");
    git(fixDir, ["commit", "-q", "-am", "review fix"]);
    git(fixDir, ["push", "-q", "origin", "refunds", "HEAD:refs/pull/41/head"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(hosts["checkout-api"], ["branch", "-q", "-D", "refunds"]);
    git(join(home.dir, "checkout-api"), ["fetch", "-q", "--prune", "origin"]);
    const named = name(home.dir, "refunds", "checkout-api", "41", "pull request 41 is refunds");
    expect(named.status, named.out).toBe(0);
    const seen = next(home.dir);
    expect(planWordAt(home, "refunds"), JSON.stringify(seen).slice(0, 600)).toMatchObject({ done: true });
    expect(JSON.stringify(seen)).not.toContain("changing every file of refunds");
  });

});

const takenBack = (dir: string, unit: string): number =>
  readAuditShardEvents(dir).filter((row) => row.event === "UNIT_MERGE_TAKEN_BACK" && row.block.includes(`**Unit**: ${unit}`)).length;

describe("the lead takes back a merge counted through a wrong number or by their word", () => {
  test("the right number given again: the earlier merge no longer stands, and the Unit counts once the right one merges", () => {
    const home = makePlanHome();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    partnerPullRequest(web, 8, { "src/other.ts": "export const other = 1;\n" });
    mergePullRequest(web, "refs/pull/8/head", "squash", "Other (#8)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "8", "pull request 8 is checkout-ui").status).toBe(0);
    expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true });
    const right = name(home.dir, "checkout-ui", "checkout-web", "7", "no, it is pull request 7");
    expect(right.status, right.out).toBe(0);
    expect(String(right.json?.notice)).toBe("Written on the plan: pull request 7 in checkout-web is the build of checkout-ui, in place of pull request 8, " +
      "and checkout-ui is no longer counted merged. checkout-ui counts as merged once git shows pull request 7 merged in checkout-web.");
    const word = planWordAt(home, "checkout-ui") as Record<string, unknown>;
    expect(word.done).toBeUndefined();
    expect(word.pull_requests).toEqual([expect.objectContaining({ repo: "checkout-web", number: 7 })]);
    expect(takenBack(home.dir, "checkout-ui")).toBe(1);
    const row = readAuditShardEvents(home.dir).find((entry) => entry.event === "UNIT_MERGE_TAKEN_BACK");
    expect(row?.block ?? "").toContain("**Attempt Generation**: 0");
    expect(board(home.dir)).toContain("- checkout-ui: its build is pull request 7 in checkout-web, not merged yet");
    mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    next(home.dir);
    expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true });
    expect(merges(home.dir, "checkout-ui")).toBe(2);
  });

  test("open-again on a Unit done through a named pull request: the naming and the merge come off, and it is open to take", () => {
    const home = makePlanHome();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    const opened = run(UNIT, ["release", "checkout-ui"], home.dir);
    expect(opened.status, opened.out).toBe(0);
    expect(String(opened.json?.notice)).toBe("Taken off the plan: pull request 7 in checkout-web is no longer named as checkout-ui's build, " +
      "and checkout-ui is no longer counted merged by it. checkout-ui is open for a person or a team to take.");
    const word = planWordAt(home, "checkout-ui") as Record<string, unknown>;
    expect(word.pull_requests).toBeUndefined();
    expect(word.done).toBeUndefined();
    expect(takenBack(home.dir, "checkout-ui")).toBe(1);
    expect(board(home.dir)).toContain("- checkout-ui, open: waiting for someone to take it");
  });

  test("open-again on a Unit counted merged by the lead's word alone: the word comes off, and it is open to take", () => {
    const home = makePlanHome();
    expect(run(UNIT, ["merged", "checkout-ui", "--repo", "checkout-web", "--person-words", "it merged by hand"], home.dir).status).toBe(0);
    expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true });
    const opened = run(UNIT, ["release", "checkout-ui"], home.dir);
    expect(opened.status, opened.out).toBe(0);
    expect(String(opened.json?.notice)).toBe("Taken off the plan: checkout-ui is no longer counted merged in checkout-web by your word. " +
      "checkout-ui is open for a person or a team to take.");
    expect((planWordAt(home, "checkout-ui") as Record<string, unknown>).said_merged).toBeUndefined();
    expect(takenBack(home.dir, "checkout-ui")).toBe(1);
  });

  test("open-again on a take not pushed that the lead counted merged by word: the word comes off, and the merge is taken back", () => {
    const home = makePlanHomeWithRemote();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", ...planFrom(home)], bob).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["merged", "checkout-ui", "--repo", "checkout-web", "--person-words", "it merged by hand"], home.dir).status).toBe(0);
    expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true });
    const opened = run(UNIT, ["release", "checkout-ui"], home.dir);
    expect(opened.status, opened.out).toBe(0);
    expect(String(opened.json?.notice)).toBe("Taken off the plan: checkout-ui is no longer counted merged in checkout-web by your word. " +
      "checkout-ui is open for a person or a team to take.");
    const word = planWordAt(home, "checkout-ui") as Record<string, unknown>;
    expect(word.said_merged).toBeUndefined();
    expect(word.done).toBeUndefined();
    expect(takenBack(home.dir, "checkout-ui")).toBe(1);
  });

  test("a pushed Unit counted merged by the lead's word, then a pull request named in that repository: the word's merge is taken back", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    next(home.dir);
    expect(run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "billing merged it by hand"], home.dir).status).toBe(0);
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
    const named = name(home.dir, "refunds", "billing", "9", "pull request 9 in billing is refunds");
    expect(named.status, named.out).toBe(0);
    expect(String(named.json?.notice)).toBe("Written on the plan: pull request 9 in billing is the build of refunds, in place of your word that " +
      "billing merged it, and refunds is no longer counted merged. refunds counts as merged once git shows pull request 9 merged in billing.");
    const word = planWordAt(home, "refunds") as Record<string, unknown>;
    expect(word.done).toBeUndefined();
    expect(word.said_merged).toBeUndefined();
    expect(takenBack(home.dir, "refunds")).toBe(1);
  });

  test("a Unit done through a named pull request that Build and Test sent back is not counted merged again by that pull request", () => {
    const home = makePlanHomeWithRemote();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", ...planFrom(home)], bob).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    partnerPullRequest(home.hosts["checkout-web"], 7, UI);
    mergePullRequest(home.hosts["checkout-web"], "refs/pull/7/head", "squash", "Checkout UI (#7)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    expect(merges(home.dir, "checkout-ui")).toBe(1);
    const sent = run(UNIT, ["send-back", "checkout-ui", "--person-words", "the totals are wrong"], home.dir);
    expect(sent.status, sent.out).toBe(0);
    next(home.dir);
    expect(planWordAt(home, "checkout-ui")?.done).toBeUndefined();
    expect(merges(home.dir, "checkout-ui")).toBe(1);
  });

  test("sent back from Build and Test, then a new pull request named: the send-back comes off, and it counts once that one merges", () => {
    const home = makePlanHomeWithRemote();
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", ...planFrom(home)], bob).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    expect(run(UNIT, ["send-back", "checkout-ui", "--person-words", "the totals are wrong"], home.dir).status).toBe(0);
    partnerPullRequest(web, 8, { "src/checkout-ui.ts": "export const checkoutUi = 2;\n" });
    expect(name(home.dir, "checkout-ui", "checkout-web", "8", "pull request 8 is the fix").status).toBe(0);
    expect((planWordAt(home, "checkout-ui") as Record<string, unknown>).turned_down).toBeUndefined();
    mergePullRequest(web, "refs/pull/8/head", "squash", "Checkout UI fix (#8)");
    next(home.dir);
    expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true });
    expect(merges(home.dir, "checkout-ui")).toBe(2);
  });

  test("a pushed Unit merged, then sent back from Build and Test, then a pull request named: the old merge is not counted again, the new one counts once it merges", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    next(home.dir);
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
    expect(merges(home.dir, "refunds")).toBe(1);
    expect(run(UNIT, ["send-back", "refunds", "--person-words", "the refund total is off by one"], home.dir).status).toBe(0);
    // Named a second after the send-back, as a person's next message comes.
    Bun.sleepSync(1100);
    partnerPullRequest(hosts["checkout-api"], 41, { "src/refunds.ts": "export const refunds = 2;\n" });
    expect(name(home.dir, "refunds", "checkout-api", "41", "pull request 41 is the fix").status).toBe(0);
    expect((planWordAt(home, "refunds") as Record<string, unknown>).turned_down).toBeDefined();
    next(home.dir);
    expect(planWordAt(home, "refunds")?.done).toBeUndefined();
    expect(merges(home.dir, "refunds")).toBe(1);
    // The pull request named after the send-back is read at each look, and counts once it
    // merges: that new build ends the send-back, so the record and the view both say merged.
    mergePullRequest(hosts["checkout-api"], "refs/pull/41/head", "squash", "Refunds fix (#41)");
    next(home.dir);
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
    expect((planWordAt(home, "refunds") as Record<string, unknown>).turned_down).toBeUndefined();
    expect(merges(home.dir, "refunds")).toBe(2);
    next(home.dir);
    expect(merges(home.dir, "refunds")).toBe(2);
  });

  test("a pushed Unit sent back, then a pull request named after it that git already shows merged: counted at the naming, and the send-back ends", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    next(home.dir);
    expect(run(UNIT, ["send-back", "refunds", "--person-words", "the refund total is off by one"], home.dir).status).toBe(0);
    partnerPullRequest(hosts["checkout-api"], 42, { "src/refunds.ts": "export const refunds = 3;\n" });
    mergePullRequest(hosts["checkout-api"], "refs/pull/42/head", "squash", "Refunds fix (#42)");
    const named = name(home.dir, "refunds", "checkout-api", "42", "pull request 42 is the fix");
    expect(named.status, named.out).toBe(0);
    expect(String(named.json?.notice)).toContain("refunds is recorded as merged here.");
    expect((planWordAt(home, "refunds") as Record<string, unknown>).turned_down).toBeUndefined();
    expect(merges(home.dir, "refunds")).toBe(2);
    next(home.dir);
    expect(merges(home.dir, "refunds")).toBe(2);
  });

  test("a repository named as the plan cannot hold it, or a Unit the plan does not have: refused, and nothing is written", () => {
    const home = makePlanHome();
    const plan = Object.values(home.hosts)[0];
    const before = git(plan, ["rev-parse", planRefOf(home.id8)]);
    for (const repo of ["acme/checkout-web", "checkout-web,billing", "https://example.test/acme/checkout-web.git"]) {
      const named = name(home.dir, "checkout-ui", repo, "7");
      expect(named.status, repo).not.toBe(0);
      expect(String(named.json?.error), repo).toStartWith(`Invalid --repo "${repo}": its name `);
    }
    const unknown = name(home.dir, "checkout-uix", "checkout-web", "7");
    expect(unknown.status).not.toBe(0);
    expect(String(unknown.json?.error)).toBe("checkout-uix is not one of this work's Units (refunds, checkout-ui, reporting).");
    expect(git(plan, ["rev-parse", planRefOf(home.id8)])).toBe(before);
    // A name the plan can hold that is not on the Unit's likely list is written as before.
    expect(name(home.dir, "checkout-ui", "billing", "7").status).toBe(0);
  });

  test("a Unit added here since the plan was shared: the share again is offered, and nothing is written", () => {
    const home = makePlanHome();
    const deps = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(deps, readFileSync(deps, "utf-8").replace("```\n", "  - name: ledger-sync\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
    const plan = Object.values(home.hosts)[0];
    const before = git(plan, ["rev-parse", planRefOf(home.id8)]);
    const named = name(home.dir, "ledger-sync", "billing", "7");
    expect(named.status).not.toBe(0);
    expect(String(named.json?.error)).toBe("The plan in checkout-api does not have ledger-sync yet: you added it after you shared the plan. " +
      "Do you want me to share it again?");
    expect(git(plan, ["rev-parse", planRefOf(home.id8)])).toBe(before);
  });

  test("a Unit with no likely repositories on the plan: a repository named as the plan cannot hold it gets the same refusal", () => {
    const home = makePlanHome({ dependencies: DEPENDENCIES.replace("    repos: [checkout-web]\n", "") });
    const plan = Object.values(home.hosts)[0];
    const before = git(plan, ["rev-parse", planRefOf(home.id8)]);
    const named = name(home.dir, "checkout-ui", "acme/checkout-web", "7");
    expect(named.status).not.toBe(0);
    expect(String(named.json?.error)).toBe('Invalid --repo "acme/checkout-web": its name is not one folder\'s name (no "/" or "\\", not "." or "..").');
    expect(git(plan, ["rev-parse", planRefOf(home.id8)])).toBe(before);
  });

  test("past the Unit stages, the take-back says Build and Test already started", () => {
    const home = makePlanHome();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    expect(run(JUMP, ["execute", "--target", "build-and-test", "--direction", "forward"], home.dir).status).toBe(0);
    const opened = run(UNIT, ["release", "checkout-ui"], home.dir);
    expect(opened.status, opened.out).toBe(0);
    expect(String(opened.json?.notice)).toEndWith(" Build and Test already started with checkout-ui counted merged. Say if you want to go back to it.");
  });

  test("open-again on a naming not merged yet: taken off, no merge taken back", () => {
    const home = makePlanHome();
    partnerPullRequest(home.hosts["checkout-web"], 7, UI);
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    const opened = run(UNIT, ["release", "checkout-ui"], home.dir);
    expect(opened.status, opened.out).toBe(0);
    expect(String(opened.json?.notice)).toBe("Taken off the plan: pull request 7 in checkout-web is no longer named as checkout-ui's build. " +
      "checkout-ui is open for a person or a team to take.");
    expect(takenBack(home.dir, "checkout-ui")).toBe(0);
  });

  test("a Unit that opened on the merge and was taken meanwhile stays taken, and the line names it", () => {
    const home = makePlanHomeWithRemote({ dependencies: DEPENDENCIES.replace("depends_on: [refunds]", "depends_on: [checkout-ui]") });
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 8, { "src/other.ts": "export const other = 1;\n" });
    mergePullRequest(web, "refs/pull/8/head", "squash", "Other (#8)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "8", "pull request 8 is checkout-ui").status).toBe(0);
    Bun.sleepSync(1100);
    const bob = cloneOf(home.remote, "bob");
    const took = run(UNIT, ["take", "reporting", ...planFrom(home)], bob);
    expect(took.status, took.out).toBe(0);
    // The lead's look reads bob's take: this computer says only what it has read.
    next(home.dir);
    partnerPullRequest(web, 7, UI);
    const right = name(home.dir, "checkout-ui", "checkout-web", "7", "no, it is pull request 7");
    expect(right.status, right.out).toBe(0);
    expect(String(right.json?.notice)).toEndWith(" reporting, which waited on checkout-ui, was taken meanwhile and stays taken.");
    expect(board(home.dir)).toMatch(/- reporting(, [a-z-]+ space)?: building since \d{1,2} [A-Z][a-z]{2}, taken by bob/);
  });

  test("open-again that only takes a naming off says so in the plan's commit, not that a merge was taken back", () => {
    const home = makePlanHome();
    partnerPullRequest(home.hosts["checkout-web"], 7, UI);
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    expect(run(UNIT, ["release", "checkout-ui"], home.dir).status).toBe(0);
    const plan = Object.values(home.hosts)[0];
    expect(git(plan, ["log", "-1", "--format=%s", planRefOf(home.id8)])).toEndWith(": pull request 7 in checkout-web no longer named as the build of checkout-ui");
  });

  test("with the lead's sign-off on, the right number in place of a counted merge needs a sign-off of its own", () => {
    const home = makePlanHome();
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    partnerPullRequest(web, 8, { "src/other.ts": "export const other = 1;\n" });
    mergePullRequest(web, "refs/pull/8/head", "squash", "Other (#8)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "8", "pull request 8 is checkout-ui").status).toBe(0);
    expect(run(UNIT, ["sign-off", "checkout-ui", "--person-words", "sign it off"], home.dir).status).toBe(0);
    expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true });
    expect(name(home.dir, "checkout-ui", "checkout-web", "7", "no, it is pull request 7").status).toBe(0);
    expect((planWordAt(home, "checkout-ui") as Record<string, unknown>).signoff).toBeUndefined();
    mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    const seen = next(home.dir);
    expect(planWordAt(home, "checkout-ui")?.done).toBeUndefined();
    expect(JSON.stringify(seen)).toContain("checkout-ui's build is pull request 7 in checkout-web: checkout-web merged. Sign it off?");
  });

  test("the same number given again for a Unit counted merged through it takes nothing back", () => {
    const home = makePlanHome();
    const web = home.hosts["checkout-web"];
    partnerPullRequest(web, 7, UI);
    mergePullRequest(web, "refs/pull/7/head", "squash", "Checkout UI (#7)");
    expect(name(home.dir, "checkout-ui", "checkout-web", "7").status).toBe(0);
    const again = name(home.dir, "checkout-ui", "checkout-web", "7", "pull request 7 again");
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).not.toContain("no longer counted merged");
    expect(String(again.json?.notice)).toEndWith("checkout-ui is recorded as merged here.");
    expect(takenBack(home.dir, "checkout-ui")).toBe(0);
    expect(merges(home.dir, "checkout-ui")).toBe(1);
    expect(planWordAt(home, "checkout-ui")).toMatchObject({ done: true });
  });
});
