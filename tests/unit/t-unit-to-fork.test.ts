// covers: `unit push --to-fork`, the push of a Unit's branch early to the
// person's fork, in their clone of the repository that refused the take's
// record: the branch made from the plan's main (through the remote at the
// plan's address, or by that address in a clone of the fork alone) with no
// upstream there, one empty commit only where the branch has none of its own,
// pushed with -u to the fork so the Unit's own push later goes there too; a
// refused push takes the empty commit back; only on the offer's mark. Real
// clones of bare remotes, through the shipped tools.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noteEngineAskMark } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import * as unitTool from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTeamBuild, cloneOf, codeGenerated, commitMessage, git, refundsTakenInClone, run, tempDir, UNIT } from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

// A contributor's clone of checkout-api (the repository refunds's record goes to)
// in GitHub's layout: origin their fork, upstream the plan's. The plan's main
// moves on after the fork was made, so the fork's main is older.
function forked(layout: "github" | "fork-only" = "github") {
  const taken = refundsTakenInClone();
  const api = join(taken.alice, "checkout-api");
  const fork = join(tempDir("fork"), "checkout-api.git");
  git(join(fork, ".."), ["clone", "-q", "--bare", taken.hosts["checkout-api"], fork]);
  const lead = cloneOf(taken.hosts["checkout-api"], "lead-api");
  writeFileSync(join(lead, "CHANGES.md"), "newer on the plan's main\n");
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-q", "-m", "plan main moves on"]);
  git(lead, ["push", "-q", "origin", "HEAD:main"]);
  if (layout === "github") {
    git(api, ["remote", "rename", "origin", "upstream"]);
    git(api, ["remote", "add", "origin", fork]);
  } else {
    git(api, ["remote", "set-url", "origin", fork]);
  }
  return { ...taken, api, fork, planMain: git(lead, ["rev-parse", "HEAD"]) };
}

const offered = (alice: string): void => noteEngineAskMark(alice, unitTool.toForkMark("refunds"));
const onFork = (fork: string, ref = "refunds"): number => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: fork }).status ?? 1;

describe("the push of a Unit's branch early to the person's fork", () => {
  test("the yes makes the branch from the plan's main with one empty commit and pushes it to the fork, its upstream there", () => {
    const { alice, api, fork, hosts, planMain } = forked();
    offered(alice);
    const yes = run(UNIT, ["push", "--to-fork"], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toBe("Pushed branch refunds to origin in checkout-api, with one empty commit, from upstream/main. " +
      "Open a PR in it your usual way. You're on refunds now in checkout-api. Switch back to main any time.");
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
    expect(String(yes.json?.notice)).toStartWith("Pushed branch refunds to origin in checkout-api, with one empty commit, from the plan's checkout-api main.");
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
    expect(String(yes.json?.notice)).toStartWith("Pushed branch refunds to origin in checkout-api from upstream/main.");
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
    expect(String(refused.json?.error)).toContain("The empty commit is taken back, and nothing was pushed. Say when to try again.");
    expect(git(api, ["rev-parse", "refunds"])).toBe(planMain);
    expect(onFork(fork)).not.toBe(0);
  });

  test("an agent with no offer behind the switch pushes nothing", () => {
    const { alice, fork } = forked();
    const said = run(UNIT, ["push", "--to-fork"], alice);
    expect(String(said.json?.notice)).toBe("No push of refunds to a fork was offered or asked for, so nothing was pushed.");
    expect(onFork(fork)).not.toBe(0);
  });

  test("forkRemoteOf: the one remote not at the plan's address, never one of several", () => {
    const { api, hosts } = forked();
    expect(unitTool.forkRemoteOf(api, hosts["checkout-api"])).toBe("origin");
    git(api, ["remote", "add", "mirror", join(tempDir("mirror"), "x.git")]);
    expect(unitTool.forkRemoteOf(api, hosts["checkout-api"])).toBeNull();
  });
});
