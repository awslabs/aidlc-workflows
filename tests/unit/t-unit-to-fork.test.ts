// covers: the fork offer, `ask_type: unit-to-fork`, put once at the step after
// a take its record's repository refused for want of access (never for a host
// rule on the record, never without a fork in the clone, never unattended),
// with the empty commit's message drafted first and the fork's address printed
// with no user name or token; and its yes, `unit push --to-fork`, the push of
// a Unit's branch early to the person's fork, in their clone of the repository
// that refused the take's record: the branch made from the plan's main
// (through the remote at the plan's address, or by that address in a clone of
// the fork alone) with no upstream there, one empty commit only where the
// branch has none of its own, pushed with -u to the fork so the Unit's own push
// later goes there too, and the replace leased on that early push; a refused
// push takes the empty commit back; only on the offer's mark; Not now removes
// the draft. Real clones of bare remotes, through the shipped tools.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noteEngineAskMark } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import * as unitTool from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  commitMessage,
  ENV,
  git,
  next,
  refundsTakenInClone,
  run,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

// A contributor's clone of checkout-api (the repository refunds's record goes to)
// in GitHub's layout: origin their fork, upstream the plan's. The plan's main
// moves on after the fork was made, so the fork's main is older. `refused`
// sets it up before the take, whose record push checkout-api then refuses:
// for access (the workspace's pushes to it go to an address with nothing
// there), or by a rule of its host on AI-DLC's record refs.
function forked(layout: "github" | "fork-only" = "github", refused?: "access" | "rule", forkAddress?: (fork: string) => string) {
  let made = { api: "", fork: "", planMain: "" };
  const lay = (alice: string): void => {
    const api = join(alice, "checkout-api");
    const host = git(api, ["remote", "get-url", "origin"]);
    const fork = join(tempDir("fork"), "checkout-api.git");
    git(join(fork, ".."), ["clone", "-q", "--bare", host, fork]);
    const lead = cloneOf(host, "lead-api");
    writeFileSync(join(lead, "CHANGES.md"), "newer on the plan's main\n");
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-q", "-m", "plan main moves on"]);
    git(lead, ["push", "-q", "origin", "HEAD:main"]);
    const at = forkAddress?.(fork) ?? fork;
    if (layout === "github") {
      git(api, ["remote", "rename", "origin", "upstream"]);
      git(api, ["remote", "add", "origin", at]);
    } else {
      git(api, ["remote", "set-url", "origin", at]);
    }
    if (refused === "access") git(alice, ["config", `url.${join(tempDir("no-access"), "none.git")}.pushInsteadOf`, host]);
    if (refused === "rule") {
      const hook = join(host, "hooks", "pre-receive");
      writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/aidlc/*) echo 'records are written by the bot' >&2; exit 1;; esac; done\n");
      chmodSync(hook, 0o755);
    }
    made = { api, fork, planMain: git(lead, ["rev-parse", "HEAD"]) };
  };
  if (refused !== undefined) return { ...refundsTakenInClone(lay), ...made };
  const taken = refundsTakenInClone();
  lay(taken.alice);
  return { ...taken, ...made };
}

const FORK_OFFER = (fork: string): string => `Your clone of checkout-api has a remote, origin, at ${fork}, which is not the address the plan ` +
  "has for checkout-api. Do you want me to push a branch for refunds there now, with one empty commit on it, for an early pull " +
  "request? Its message:\n\nrefunds: start";

// The steps after the take, as the agent takes them, until the fork offer or none.
function toForkStep(alice: string, env: NodeJS.ProcessEnv = ENV): Record<string, unknown> | null {
  for (let at = 0; at < 6; at++) {
    const step = next(alice, env);
    if (step.ask_type === "unit-to-fork") return step;
    if (step.kind !== "ask" || step.ask_type === "unit-clone") continue;
    return null;
  }
  return null;
}

const offered = (alice: string): void => noteEngineAskMark(alice, unitTool.toForkMark("refunds"));
const onFork = (fork: string, ref = "refunds"): number => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: fork }).status ?? 1;

describe("the push of a Unit's branch early to the person's fork", () => {
  test("the yes makes the branch from the plan's main with one empty commit and pushes it to the fork, its upstream there", () => {
    const { alice, api, fork, hosts, planMain } = forked();
    offered(alice);
    const yes = run(UNIT, ["push", "--to-fork"], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toBe("Pushed branch refunds to origin in checkout-api. It starts from upstream/main and has one empty " +
      "commit on it. Open a PR from it your usual way. You're on refunds now in checkout-api. Switch back to main any time.");
    expect(git(fork, ["rev-parse", "refunds~1"])).toBe(planMain);
    expect(git(fork, ["log", "-1", "--format=%s", "refunds"])).toBe("refunds: start");
    expect(git(fork, ["diff", "--name-only", "refunds~1", "refunds"])).toBe("");
    expect(git(api, ["config", "--get", "branch.refunds.remote"])).toBe("origin");
    expect(onFork(hosts["checkout-api"])).not.toBe(0);
  });

  test("the Unit's own push later goes to the fork on top of it, and a branch of the person's own does not take its place", () => {
    const { alice, api, fork, record } = forked();
    offered(alice);
    expect(run(UNIT, ["push", "--to-fork"], alice).status).toBe(0);
    const early = git(fork, ["rev-parse", "refunds"]);
    git(api, ["switch", "-q", "-c", "notes", "upstream/main"]);
    writeFileSync(join(api, "NOTES.md"), "mine\n");
    git(api, ["add", "NOTES.md"]);
    git(api, ["commit", "-q", "-m", "my notes"]);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(fork, ["rev-parse", "refunds~1"])).toBe(early);
    expect(git(fork, ["show", "refunds:src/refunds.ts"])).toBe("export const refunds = 1;");
  });

  test("a clone of the fork alone: the branch starts from the plan's main fetched by its address, and nothing is added to the clone", () => {
    const { alice, api, fork, planMain } = forked("fork-only");
    offered(alice);
    const remotes = git(api, ["remote"]);
    const yes = run(UNIT, ["push", "--to-fork"], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toStartWith("Pushed branch refunds to origin in checkout-api. It starts from main in the plan's " +
      "checkout-api and has one empty commit on it.");
    expect(git(fork, ["rev-parse", "refunds~1"])).toBe(planMain);
    expect(git(api, ["remote"])).toBe(remotes);
  });

  test("the person's own message replaces the draft whole", () => {
    const { alice, fork, record } = forked();
    offered(alice);
    const yes = run(UNIT, ["push", "--to-fork", "--commit-message-file", commitMessage(alice, record, "PAY-7 start refunds\n")], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(git(fork, ["log", "-1", "--format=%s", "refunds"])).toBe("PAY-7 start refunds");
  });

  test("a branch with a commit of its own gets no empty commit", () => {
    const { alice, api, fork } = forked();
    offered(alice);
    git(api, ["fetch", "-q", "upstream"]);
    git(api, ["switch", "-q", "-c", "refunds", "upstream/main"]);
    writeFileSync(join(api, "SKETCH.md"), "a start\n");
    git(api, ["add", "SKETCH.md"]);
    git(api, ["commit", "-q", "-m", "a sketch"]);
    const yes = run(UNIT, ["push", "--to-fork"], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toStartWith("Pushed branch refunds to origin in checkout-api. It starts from upstream/main. Open a PR");
    expect(git(fork, ["log", "-1", "--format=%s", "refunds"])).toBe("a sketch");
  });

  test("the fork refuses the push: its words, and the empty commit taken back", () => {
    const { alice, api, fork, planMain } = forked();
    offered(alice);
    const hook = join(fork, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'pushes are paused' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const refused = run(UNIT, ["push", "--to-fork"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toStartWith("The push of refunds to origin in checkout-api was refused: ");
    expect(String(refused.json?.error)).toContain("The empty commit is taken back, and nothing was pushed. Say when to try again. " +
      "You're on refunds now in checkout-api. Switch back to main any time.");
    expect(git(api, ["rev-parse", "refunds"])).toBe(planMain);
    expect(onFork(fork)).not.toBe(0);
  });

  test("an agent with no offer behind the switch pushes nothing", () => {
    const { alice, fork } = forked();
    const said = run(UNIT, ["push", "--to-fork"], alice);
    expect(String(said.json?.notice)).toBe("No push of refunds to a fork was offered or asked for, so nothing was pushed.");
    expect(onFork(fork)).not.toBe(0);
  });

  test("git refuses the empty commit for a reason of its own (signing): git's words, never their hook's", () => {
    const { alice, api, fork } = forked();
    offered(alice);
    git(api, ["config", "commit.gpgsign", "true"]);
    git(api, ["config", "gpg.program", join(tempDir("no-gpg"), "gpg")]);
    const refused = run(UNIT, ["push", "--to-fork"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toStartWith('The empty commit could not be made in checkout-api: git says "');
    expect(String(refused.json?.error)).toContain("Nothing was pushed. Say when to try again. You're on refunds now in checkout-api.");
    expect(onFork(fork)).not.toBe(0);
  });

  test("the offer, once, at the step after a take refused for access, its message drafted first; its yes pushes", () => {
    const { alice, fork, planMain } = forked("github", "access");
    const offer = toForkStep(alice);
    expect(offer, "the fork offer").not.toBeNull();
    expect(offer?.question).toBe(FORK_OFFER(fork));
    const choices = offer?.choices as Array<{ label: string; detail: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Push it to origin", "Not now"]);
    expect(choices[0].detail).toBe("Makes branch refunds from upstream/main with that one empty commit, with your own git, and pushes it " +
      "to origin. Opening the pull request stays with you. You're on refunds after it.");
    expect(choices[1].detail).toBe("Nothing is pushed and no commit is made; say when you want it pushed.");
    expect(String(choices[0].command)).toEndWith(`push --to-fork --commit-message-file ${String(offer?.commit_message_file)}`);
    expect(toForkStep(alice)).toBeNull();
    const yes = run(UNIT, ["push", "--to-fork", "--commit-message-file", String(offer?.commit_message_file)], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(git(fork, ["rev-parse", "refunds~1"])).toBe(planMain);
    expect(git(fork, ["log", "-1", "--format=%s", "refunds"])).toBe("refunds: start");
    expect(existsSync(join(alice, ...String(offer?.commit_message_file).split("/")))).toBe(false);
  });

  test("Not now pushes nothing and removes the draft", () => {
    const { alice, fork } = forked("github", "access");
    const offer = toForkStep(alice);
    const draft = join(alice, ...String(offer?.commit_message_file).split("/"));
    expect(existsSync(draft)).toBe(true);
    const later = run(UNIT, ["push", "--to-fork", "--later"], alice);
    expect(String(later.json?.notice)).toBe("Nothing is pushed and no commit is made; say when you want it pushed.");
    expect(existsSync(draft)).toBe(false);
    expect(onFork(fork)).not.toBe(0);
  });

  test("the address the offer prints has no user name or token from the remote's address", () => {
    const { alice } = forked("github", "access", () => "https://alice:ghp_secret0token@example.test/alice/checkout-api.git");
    const offer = toForkStep(alice);
    expect(String(offer?.question)).toContain("has a remote, origin, at https://example.test/alice/checkout-api.git, which is not");
    expect(String(offer?.question)).not.toContain("ghp_secret0token");
    expect(String(offer?.question)).not.toContain("alice:");
  });

  test("no offer: a host rule on the record's refs, AI-DLC's own clone with no fork, an unattended run, or a fork added after the take", () => {
    expect(toForkStep(forked("github", "rule").alice)).toBeNull();
    const own = refundsTakenInClone((alice) => {
      git(alice, ["config", `url.${join(tempDir("no-access"), "none.git")}.pushInsteadOf`, git(join(alice, "checkout-api"), ["remote", "get-url", "origin"])]);
    });
    expect(toForkStep(own.alice)).toBeNull();
    expect(toForkStep(forked("github", "access").alice, { ...ENV, AIDLC_UNATTENDED: "1" })).toBeNull();
    // The fork added once the build is under way: never offered mid-build.
    const later = refundsTakenInClone((alice) => {
      git(alice, ["config", `url.${join(tempDir("no-access"), "none.git")}.pushInsteadOf`, git(join(alice, "checkout-api"), ["remote", "get-url", "origin"])]);
    });
    const api = join(later.alice, "checkout-api");
    git(api, ["remote", "rename", "origin", "upstream"]);
    git(api, ["remote", "add", "origin", join(tempDir("late-fork"), "checkout-api.git")]);
    expect(toForkStep(later.alice)).toBeNull();
  });

  test("the early push, a rebase onto the plan's newer main, and the end push replaces the same branch on the fork", () => {
    const { alice, api, fork, hosts, record } = forked();
    offered(alice);
    expect(run(UNIT, ["push", "--to-fork"], alice).status).toBe(0);
    const early = git(fork, ["rev-parse", "refunds"]);
    const lead = cloneOf(hosts["checkout-api"], "lead-api-2");
    writeFileSync(join(lead, "MORE.md"), "newer again\n");
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-q", "-m", "plan main moves on again"]);
    git(lead, ["push", "-q", "origin", "HEAD:main"]);
    git(api, ["fetch", "-q", "upstream"]);
    git(api, ["rebase", "-q", "upstream/main"]);
    codeGenerated(alice, record);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toContain("push --replace");
    const replaced = run(UNIT, ["push", "--replace"], alice);
    expect(replaced.status, replaced.out).toBe(0);
    expect(git(fork, ["show", "refunds:src/refunds.ts"])).toBe("export const refunds = 1;");
    expect(git(fork, ["merge-base", "--is-ancestor", git(lead, ["rev-parse", "HEAD"]), "refunds"])).toBe("");
    expect(String(replaced.json?.notice)).toContain(`in place of the build pushed there before (it was at ${git(api, ["rev-parse", "--short", early])}).`);
  });

  test("where the plan names no branch, the remote's own main, recorded or asked for by its address", () => {
    const seed = join(tempDir("trunk-seed"), "repo");
    git(join(seed, ".."), ["init", "-q", "-b", "trunk", seed]);
    git(seed, ["config", "user.name", "t"]);
    git(seed, ["config", "user.email", "t@example.test"]);
    git(seed, ["commit", "-q", "--allow-empty", "-m", "start"]);
    const host = join(tempDir("trunk-host"), "host.git");
    git(join(host, ".."), ["clone", "-q", "--bare", seed, host]);
    const clone = join(tempDir("trunk-clone"), "repo");
    git(join(clone, ".."), ["clone", "-q", host, clone]);
    expect(unitTool.remoteMainOf(clone, host, "origin")).toBe("trunk");
    // A remote added by hand has no recorded HEAD: the repository says.
    git(clone, ["remote", "add", "upstream", host]);
    expect(unitTool.remoteMainOf(clone, host, "upstream")).toBe("trunk");
    expect(unitTool.remoteMainOf(clone, host)).toBe("trunk");
  });

  test("unitBuildOwnBranch: a Unit branch holding a merge of its own is still a build, an empty commit alone is not", () => {
    const dir = join(tempDir("own-branch"), "repo");
    git(join(dir, ".."), ["init", "-q", "-b", "main", dir]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "user.email", "t@example.test"]);
    git(dir, ["commit", "-q", "--allow-empty", "-m", "start"]);
    git(dir, ["switch", "-q", "-c", "side"]);
    writeFileSync(join(dir, "side.md"), "side\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "side"]);
    git(dir, ["switch", "-q", "main"]);
    git(dir, ["switch", "-q", "-c", "refunds"]);
    git(dir, ["merge", "-q", "--no-ff", "--no-edit", "side"]);
    // The side branch is on a remote, so the merge is the Unit branch's one commit of its own.
    git(dir, ["update-ref", "refs/remotes/origin/side", "side"]);
    git(dir, ["switch", "-q", "-c", "redo", "main"]);
    writeFileSync(join(dir, "redo.md"), "redo\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "redo"]);
    expect(unitTool.unitBuildOwnBranch(dir, "refunds")).toBe("redo");
    git(dir, ["branch", "-q", "-f", "refunds", "main"]);
    git(dir, ["switch", "-q", "refunds"]);
    git(dir, ["commit", "-q", "--allow-empty", "-m", "empty"]);
    git(dir, ["switch", "-q", "redo"]);
    expect(unitTool.unitBuildOwnBranch(dir, "refunds")).toBeNull();
  });

  test("forkRemoteOf: the one remote not at the plan's address, never one of several", () => {
    const { api, hosts } = forked();
    expect(unitTool.forkRemoteOf(api, hosts["checkout-api"])).toBe("origin");
    git(api, ["remote", "add", "mirror", join(tempDir("mirror"), "x.git")]);
    expect(unitTool.forkRemoteOf(api, hosts["checkout-api"])).toBeNull();
  });
});
