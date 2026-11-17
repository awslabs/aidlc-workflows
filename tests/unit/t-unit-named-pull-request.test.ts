// covers: subcommand:aidlc-unit:merged, audit:UNIT_MERGED, function:checkTeamResults, function:renderUnitBoard
//
// The lead names a pull request as a Unit's build (a partner team that can read
// a repository and push only to its fork): the number goes on the plan as the
// lead's word, and the Unit counts as merged once git shows that pull request's
// last head merged in that repository. AI-DLC reads no other pull request, and
// keeps nothing in a code clone for it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  git,
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
    expect(git(plan, ["log", "-1", "--format=%s", planRefOf(home.id8)])).toEndWith(": pull request 7 in checkout-web named the build of checkout-ui");
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
