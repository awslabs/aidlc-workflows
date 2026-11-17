// covers: `unit push --replace`, the replace of a pushed Unit branch on the
// person's yes. Every repository's branch on its remote is read before any
// push and leased on what this build's last push left there (its own
// UNIT_PUSHED row; on the workspace's own repository the one record commit on
// it; a clean merge of main made by the merge offer's yes); a commit anyone
// else put there pushes nothing anywhere; the branch a repository merges into
// is never replaced. And before that: a Unit branch on its remote ahead of the
// person's (the host's merge of main on its pull request, a suggestion
// committed there) is brought in first by the level step and pushed as a
// fast-forward; where those commits change a file the build changes, the
// refusal names the file and offers only the ways that can go. Real clones of
// bare remotes, through the shipped tools.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  codeGeneratedAgain,
  finishBuild,
  git,
  refundsTakenInClone,
  run,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const REPLACE_WAY = "Ask the person whether to replace refunds there with this build (the build pushed before leaves that branch; " +
  "a pull request open from it stays the same one), or to push it as a new branch, refunds-2 (it needs a pull request of its own)";

// Pushed, turned down, and redone from main in each of `repos`, so the next
// push finds the branch on the remote holding the build pushed before.
function redone(repos: string[] = ["billing"]) {
  const taken = refundsTakenInClone();
  const { home, alice, record } = taken;
  codeGenerated(alice, record);
  finishBuild(record);
  expect(run(UNIT, ["push"], alice).status).toBe(0);
  git(home.dir, ["fetch", "-q", "origin"]);
  expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "rebuild it on the new main"], home.dir).status).toBe(0);
  for (const repo of repos) {
    const dir = join(alice, repo);
    git(dir, ["switch", "-q", "main"]);
    git(dir, ["branch", "-q", "-D", "refunds"]);
    git(dir, ["switch", "-q", "-c", "refunds", "main"]);
  }
  mkdirSync(join(alice, "billing", "lib"), { recursive: true });
  writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 2;\n");
  mkdirSync(join(alice, "checkout-api", "src"), { recursive: true });
  writeFileSync(join(alice, "checkout-api", "src", "refunds.ts"), "export const refunds = 2;\n");
  return taken;
}

const tipOn = (host: string): string => git(host, ["rev-parse", "refunds"]);

// Pushed once; then someone on billing's host puts a commit on top of its
// branch: the host's merge of a newer main ("Update branch"), or a suggestion
// committed there, changing `file`.
function pushedThenOnTop(how: "update-branch" | "suggestion", file = "CHANGES.md") {
  const taken = refundsTakenInClone();
  codeGenerated(taken.alice, taken.record);
  expect(run(UNIT, ["push"], taken.alice).status).toBe(0);
  const host = cloneOf(taken.hosts.billing, "reviewer");
  mkdirSync(join(host, "lib"), { recursive: true });
  if (how === "update-branch") {
    writeFileSync(join(host, file), "on main\n");
    git(host, ["add", "-A"]);
    git(host, ["commit", "-q", "-m", "main moves on"]);
    git(host, ["push", "-q", "origin", "HEAD:main"]);
    git(host, ["fetch", "-q", "origin", "refunds"]);
    git(host, ["switch", "-q", "-c", "refunds", "origin/refunds"]);
    git(host, ["merge", "-q", "--no-edit", "-m", "Merge branch 'main' into refunds", "main"]);
  } else {
    git(host, ["fetch", "-q", "origin", "refunds"]);
    git(host, ["switch", "-q", "-c", "refunds", "origin/refunds"]);
    writeFileSync(join(host, file), "a suggestion\n");
    git(host, ["add", "-A"]);
    git(host, ["commit", "-q", "-m", "Apply suggestion from review"]);
  }
  git(host, ["push", "-q", "origin", "refunds"]);
  return { ...taken, onTop: git(host, ["rev-parse", "HEAD"]) };
}

describe("a Unit branch on its remote ahead of the person's", () => {
  test("the host's merge of main on it is brought in first, and the push goes on top of it", () => {
    const { alice, hosts, onTop } = pushedThenOnTop("update-branch");
    codeGeneratedAgain(alice);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toStartWith("refunds on origin in billing had a commit on top of yours (\"Merge branch 'main' " +
      "into refunds\"), so I brought it into your refunds here first. Pushed branch refunds in checkout-api and billing.");
    expect(git(hosts.billing, ["merge-base", "--is-ancestor", onTop, "refunds"])).toBe("");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 2;");
  });

  test("a suggestion committed on the host is brought in the same way", () => {
    const { alice, hosts, onTop } = pushedThenOnTop("suggestion");
    codeGeneratedAgain(alice);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["merge-base", "--is-ancestor", onTop, "refunds"])).toBe("");
  });

  test("a suggestion that changes a file this build changes: the file named, only the new branch offered, and nothing of it replaced", () => {
    const { alice, hosts, onTop } = pushedThenOnTop("suggestion", "lib/refund.ts");
    codeGeneratedAgain(alice);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    const said = String(refused.json?.error);
    expect(said).toStartWith("refunds was not pushed: on origin in billing its branch has a commit on top of what was pushed there before " +
      "(\"Apply suggestion from review\"), and that commit changes lib/refund.ts, which this build changes too. That commit stays on " +
      "refunds there and is not in the new branch. Ask the person whether to push it as a new branch, refunds-2; on their yes, run `");
    expect(said).not.toContain("--replace");
    expect(tipOn(hosts.billing)).toBe(onTop);
  });

  test("the host's merge of main that changes a file this build changes: the file named, and the replace says that commit leaves too", () => {
    const lines = (first: string, last: string): string => `${first}\nb\nc\nd\n${last}\n`;
    const { alice, hosts, record } = refundsTakenInClone((alice) => {
      const billing = join(alice, "billing");
      mkdirSync(join(billing, "lib"), { recursive: true });
      writeFileSync(join(billing, "lib", "refund.ts"), lines("a", "e"));
      git(billing, ["add", "-A"]);
      git(billing, ["commit", "-q", "-m", "refund lines"]);
      git(billing, ["push", "-q", "origin", "HEAD:main"]);
    });
    codeGenerated(alice, record);
    writeFileSync(join(alice, "billing", "lib", "refund.ts"), lines("A", "e"));
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    // Main changes another line of it; the host merges main into the branch cleanly.
    const host = cloneOf(hosts.billing, "reviewer");
    writeFileSync(join(host, "lib", "refund.ts"), lines("a", "E"));
    git(host, ["commit", "-q", "-am", "main moves on"]);
    git(host, ["push", "-q", "origin", "HEAD:main"]);
    git(host, ["fetch", "-q", "origin", "refunds"]);
    git(host, ["switch", "-q", "-c", "refunds", "origin/refunds"]);
    git(host, ["merge", "-q", "--no-edit", "-m", "Merge branch 'main' into refunds", "main"]);
    git(host, ["push", "-q", "origin", "refunds"]);
    git(join(alice, "billing"), ["fetch", "-q", "origin", "main"]);
    writeFileSync(join(alice, "billing", "lib", "refund.ts"), lines("A2", "e"));
    const said = String(run(UNIT, ["push"], alice).json?.error);
    expect(said).toStartWith("refunds was not pushed: on origin in billing its branch has a commit on top of what was pushed there before " +
      "(\"Merge branch 'main' into refunds\"), and that commit changes lib/refund.ts, which this build changes too. Ask the person whether " +
      "to replace refunds there with this build (the build pushed before and that commit leave that branch; a pull request open from it " +
      "stays the same one), or to push it as a new branch, refunds-2");
  });

  test("a fetch that fails before the push adds no line, and the push goes on", () => {
    const { alice, hosts, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const billing = join(alice, "billing");
    git(billing, ["config", "remote.origin.pushurl", hosts.billing]);
    git(billing, ["config", "remote.origin.url", join(tempDir("gone"), "billing.git")]);
    codeGeneratedAgain(alice);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toStartWith("Pushed branch refunds in checkout-api and billing.");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 2;");
  });
});

describe("the replace of a pushed Unit branch", () => {
  test("the refusal offers the replace beside the new branch, and the replace goes over the build this computer pushed", () => {
    const { hosts, alice } = redone();
    const before = tipOn(hosts.billing);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toContain(REPLACE_WAY);
    expect(String(refused.json?.error)).not.toContain("force");
    const replaced = run(UNIT, ["push", "--replace"], alice);
    expect(replaced.status, replaced.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 2;");
    const short = git(join(alice, "billing"), ["rev-parse", "--short", before]);
    expect(String(replaced.json?.notice)).toContain(`Pushed branch refunds in billing in place of the build pushed there before (it was at ${short}).`);
    expect(String(replaced.json?.notice)).not.toContain("Open a PR in billing");
    // The build replaced is still in this clone, by the commit the line names.
    expect(spawnSync("git", ["cat-file", "-e", `${short}^{commit}`], { cwd: join(alice, "billing") }).status).toBe(0);
  });

  test("a commit someone else put on the branch: nothing is replaced, in any repository, and the new branch is the way on", () => {
    const { hosts, alice } = redone(["billing", "checkout-api"]);
    const other = cloneOf(hosts.billing, "bob");
    git(other, ["fetch", "-q", "origin", "refunds"]);
    git(other, ["switch", "-q", "-c", "refunds", "origin/refunds"]);
    writeFileSync(join(other, "FIX.md"), "a fix by hand\n");
    git(other, ["add", "FIX.md"]);
    git(other, ["commit", "-q", "-m", "fix by hand"]);
    git(other, ["push", "-q", "origin", "refunds"]);
    const billing = tipOn(hosts.billing);
    const api = tipOn(hosts["checkout-api"]);
    const refused = run(UNIT, ["push", "--replace"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toStartWith("refunds was not pushed: its branch refunds on origin in billing is not where this " +
      "build's last push left it, so it was not replaced, and nothing was pushed. Ask the person whether to push it as a new branch, " +
      "refunds-2; on their yes, run `");
    expect(tipOn(hosts.billing)).toBe(billing);
    expect(tipOn(hosts["checkout-api"])).toBe(api);
  });

  test("a host rule that refuses the replace: its words and the new branch, never the replace offered again", () => {
    const { hosts, alice } = redone();
    git(hosts.billing, ["config", "receive.denyNonFastForwards", "true"]);
    const refused = run(UNIT, ["push", "--replace"], alice);
    expect(refused.status).not.toBe(0);
    const said = String(refused.json?.error);
    expect(said).toStartWith("The push of refunds in billing was refused: ");
    expect(said).toContain("Nothing was retried. Ask the person whether to push it as a new branch, refunds-2; on their yes, run `");
    expect(said).not.toContain("--replace");
  });

  test("--replace where a plain push goes pushes as a plain push", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push", "--replace"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toStartWith("Pushed branch refunds in checkout-api and billing. Open a PR in each your usual way.");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
  });

  test("never the branch a repository merges into: the Unit's own name where it is free, else its -2 form", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    const onMain = run(UNIT, ["push", "--branch", "main", "--replace"], alice);
    expect(onMain.status).not.toBe(0);
    expect(String(onMain.json?.error)).toStartWith("refunds was not pushed: it goes on main in checkout-api, the branch checkout-api " +
      "merges into, and AI-DLC never replaces that branch. Ask the person whether to push it as a new branch, refunds; on their yes, run `");
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: hosts["checkout-api"] }).status).not.toBe(0);
    // With refunds on the remote already, the -2 form.
    expect(run(UNIT, ["push", "--branch", "refunds"], alice).status).toBe(0);
    const again = run(UNIT, ["push", "--branch", "main", "--replace"], alice);
    expect(String(again.json?.error)).toContain("Ask the person whether to push it as a new branch, refunds-2; on their yes, run `");
    expect(git(hosts["checkout-api"], ["log", "-1", "--format=%s", "main"])).toBe("start");
  });
});
