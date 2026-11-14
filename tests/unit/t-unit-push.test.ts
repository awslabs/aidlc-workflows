// covers: subcommand:aidlc-unit:push, subcommand:aidlc-unit:turned-down, subcommand:aidlc-unit:merged, audit:UNIT_PUSHED, audit:UNIT_MERGED, function:checkTeamResults, function:renderUnitBoard, function:teamsAcrossReposLine, function:homeResultsPastUnitStages, function:pastUnitStages, function:resultAtTip
//
// A Unit's build goes home (#2410, item 5). Teams build Units across repos when
// the workspace is in git. At the build's end the person is offered the push;
// it commits exactly the files the Unit's Code Generation recorded writing, on
// the Unit's branch in each repo, pushes them with the person's own git, and
// sends the result home on the claim. The person's other uncommitted work is
// never committed. The home checks each repo's integration branch, shows how
// far the Unit merged, and records it done once every repo merged, so the
// Units waiting on it open. A turn-down at the home reaches the team once.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { hooksHealthReadDir, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { pastUnitStages } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { CHECK_IN_LINE, pullRequestHeadRefs } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { AIDLC_SRC, fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  bashLine,
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeGeneratedAgain,
  codeHost,
  ENV,
  git,
  HOME_RECORD,
  homeState,
  makeHome,
  mergeOnHost,
  next,
  ORCH,
  finishBuild,
  hook,
  personsChat,
  personsNext,
  refundsTaken,
  run,
  tellsWhatToType,
  STATE,
  tempDir,
  UNIT,
  UTILITY,
  takeIn,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

// A claim's result, as the tests read it.
type SentResult = { repos: Array<{ repo: string; base: string; heads: string[] }> };

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");

afterEach(cleanupTeamBuild);

// A commit on a Unit's branch on its code host that AI-DLC did not push: a
// review fix by hand with plain git, or the host's own "Commit suggestion".
function commitOnHost(host: string, branch: string, files: Record<string, string>, message: string): string {
  const dir = join(tempDir("reviewer"), "repo");
  git(tempDir("reviewer-parent"), ["clone", "-q", "--branch", branch, host, dir]);
  git(dir, ["config", "user.name", "reviewer"]);
  git(dir, ["config", "user.email", "reviewer@example.test"]);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  git(dir, ["commit", "-q", "-am", message]);
  git(dir, ["push", "-q", "origin", branch]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// A pull request squashed on its code host in the host's own words, its branch
// deleted after. GitLab's merge commit method puts the squash under a merge
// commit (`mergeCommit`, its message).
function squashOnHost(host: string, branch: string, message: string, mergeCommit?: string): void {
  const dir = join(tempDir("squasher"), "repo");
  git(tempDir("squasher-parent"), ["clone", "-q", host, dir]);
  git(dir, ["config", "user.name", "reviewer"]);
  git(dir, ["config", "user.email", "reviewer@example.test"]);
  git(dir, ["fetch", "-q", "origin", branch]);
  git(dir, ["merge", "-q", "--squash", `origin/${branch}`]);
  git(dir, ["commit", "-q", "-m", message]);
  if (mergeCommit !== undefined) {
    const squash = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["reset", "-q", "--hard", "HEAD^"]);
    git(dir, ["merge", "-q", "--no-ff", "-m", mergeCommit, squash]);
  }
  git(dir, ["push", "-q", "origin", "main"]);
  git(host, ["branch", "-q", "-D", branch]);
}

describe("teams build Units across repos when the workspace is in git", () => {
  test("choosing teams on work across repos goes through, and no question of who builds which Unit is put", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    // Every Unit is open for any team: the step after is the offer to share the plan.
    const step = next(home.dir);
    expect(step.ask_type, JSON.stringify(step).slice(0, 400)).not.toBe("unit-assignment");
    expect(String(step.question)).toStartWith("The Units are open for any team to take. Share the plan with them now?");
  });
});

describe("the push", () => {
  test("commits only the Unit's files on its branch in each repo, pushes them, and sends the result home", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // Their own work in progress in checkout-api stays theirs.
    writeFileSync(join(alice, "checkout-api", "README.md"), "# checkout-api\n\nmy notes\n");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice).toBe(
      "Pushed branch refunds in checkout-api and billing. Open a PR in each your usual way. You're on refunds now in " +
        "checkout-api and billing; your other changes are still yours, uncommitted. Switch back to main any time. " +
        "Your teammates see where this work stands once aidlc/ is committed and pushed.",
    );
    expect(git(hosts["checkout-api"], ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toEqual(["README.md", "src/refunds.ts"]);
    // On the Unit's branch, as their own hands would put them; their note came along, uncommitted.
    expect(git(join(alice, "checkout-api"), ["branch", "--show-current"])).toBe("refunds");
    expect(git(join(alice, "checkout-api"), ["status", "--porcelain"])).toBe("M README.md");
    expect(git(join(alice, "checkout-api"), ["show", "-s", "--format=%an", "refunds"])).toBe("alice");
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as {
      result: { by: string; repos: Array<{ repo: string; branch: string; paths: Record<string, string> }>; outputs: string[] };
    };
    expect(claim.result.by).toBe("alice");
    expect(claim.result.repos.map((repo: { repo: string; branch: string }) => [repo.repo, repo.branch]))
      .toEqual([["checkout-api", "refunds"], ["billing", "refunds"]]);
    expect(Object.keys(claim.result.repos[0].paths)).toEqual(["src/refunds.ts"]);
    expect(claim.result.outputs).toContain("construction/refunds/code-generation/code-summary.md");
    const rows = readAuditShardEvents(alice, basename(record), "payments").filter((row) => row.event === "UNIT_PUSHED");
    expect(rows).toHaveLength(1);
  });

  // A live run (Claude Code, Windows Server): the agent ran next at once after
  // the push and put the next question with none of the push's lines.
  test("from a chat, the push's lines ride the step that follows, said once", () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "push-chat" };
    const pushed = run(UNIT, ["push"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice, pushed.out).toBeUndefined();
    const step = next(alice, chat);
    const said = ((step.change_notices ?? []) as string[]).join(" ");
    expect(said, JSON.stringify(step).slice(0, 800)).toContain("Pushed branch refunds in checkout-api and billing.");
    expect(said).toContain(CHECK_IN_LINE);
    expect(JSON.stringify(next(alice, chat))).not.toContain("Pushed branch refunds");
  });

  test("a file that held their own uncommitted change when the Unit was taken: only the Unit's change goes, theirs stays theirs", () => {
    const { hosts, alice, record } = refundsTaken((dir) => {
      writeFileSync(join(dir, "checkout-api", "README.md"), "# checkout-api\n\nmy secret note\n");
      writeFileSync(join(dir, "billing", "README.md"), "# billing (my note)\n");
    });
    codeGenerated(alice, record);
    // Code Generation also writes both READMEs: in checkout-api apart from their
    // note, in billing on the very line their note changed.
    writeFileSync(join(alice, "checkout-api", "README.md"), "Refunds API.\n\n# checkout-api\n\nmy secret note\n");
    writeFileSync(join(alice, "billing", "README.md"), "# billing service\n");
    const manifest = join(record, "construction", "refunds", "code-generation", "source-manifest.json");
    const written = JSON.parse(readFileSync(manifest, "utf-8")) as { writes: Array<{ repo: string; path: string }> };
    written.writes.push({ repo: "checkout-api", path: "README.md" }, { repo: "billing", path: "README.md" });
    writeFileSync(manifest, `${JSON.stringify(written, null, 2)}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts["checkout-api"], ["show", "refunds:README.md"])).toBe("Refunds API.\n\n# checkout-api");
    expect(git(hosts.billing, ["show", "refunds:README.md"])).toBe("# billing");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
    expect(String(pushed.json?.notice)).toContain(
      "README.md in billing is not in the commit: it already had a change of yours when refunds was taken, and " +
        "refunds's own change could not be kept apart from it. Both are still in the file, uncommitted.",
    );
    // Nothing of theirs in the working tree changed; their note is theirs, uncommitted.
    expect(readFileSync(join(alice, "checkout-api", "README.md"), "utf-8")).toBe("Refunds API.\n\n# checkout-api\n\nmy secret note\n");
    expect(readFileSync(join(alice, "billing", "README.md"), "utf-8")).toBe("# billing service\n");
    expect(git(join(alice, "checkout-api"), ["status", "--porcelain"]).split("\n")).toContain("M README.md");
    expect(git(join(alice, "billing"), ["status", "--porcelain"]).split("\n")).toContain("M README.md");
    // A second push carries the Unit's newer change on top of what it sent, still never their note.
    writeFileSync(join(alice, "checkout-api", "README.md"), "Refunds API.\n\n# checkout-api\n\nmy secret note\n\nSee docs.\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const sent = git(hosts["checkout-api"], ["show", "refunds:README.md"]);
    expect(sent).toContain("Refunds API.");
    expect(sent).not.toContain("my secret note");
  });

  test("their commit hooks run on the Unit's commit before anything is pushed: a hook that stops it is said in its words, and nothing went", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const hooks = join(alice, "billing", ".git", "hooks");
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'lint: lib/refund.ts needs a header' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    const stopped = run(UNIT, ["push"], alice);
    expect(stopped.status).not.toBe(0);
    expect(String(stopped.json?.error)).toStartWith("The commit in billing did not go through: lint: lib/refund.ts needs a header. ");
    // checkout-api came first and was not pushed either; the line says where they are.
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/refunds"], { cwd: hosts["checkout-api"] }).status).not.toBe(0);
    expect(String(stopped.json?.error)).toEndWith("Nothing was pushed. You're on refunds now in checkout-api and billing. Switch back to main any time.");
    // Their commit-msg hook shapes the message, as it would for their own commit.
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(hooks, "commit-msg"), "#!/bin/sh\nprintf 'REF-1 %s' \"$(cat \"$1\")\" > \"$1\"\n");
    chmodSync(join(hooks, "commit-msg"), 0o755);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(git(hosts.billing, ["log", "-1", "--format=%s", "refunds"])).toStartWith("REF-1 refunds: ");
  });

  test("the Unit's branch starts from the shared integration branch, so their own unpushed commits stay on their branch", () => {
    const { hosts, alice, record } = refundsTaken();
    const billing = join(alice, "billing");
    writeFileSync(join(billing, "NOTES.md"), "mine\n");
    git(billing, ["add", "NOTES.md"]);
    git(billing, ["commit", "-q", "-m", "my local notes"]);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"])).toBe("refunds: fixture");
    expect(String(pushed.json?.notice)).not.toContain("come along");
  });

  test("a working tree that does not allow it: the branch starts where they are, and the line names their commits that come along", () => {
    const { hosts, alice, record } = refundsTaken();
    const billing = join(alice, "billing");
    writeFileSync(join(billing, "README.md"), "# billing\n\nlocal\n");
    git(billing, ["commit", "-q", "-am", "local readme"]);
    // Their uncommitted edit on top of it keeps git from moving them to origin/main.
    writeFileSync(join(billing, "README.md"), "# billing\n\nlocal, still editing\n");
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      'Branch refunds in billing starts from where you were, so your commit not yet on origin/main comes along: "local readme".',
    );
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"]).split("\n")).toEqual(["refunds: fixture", "local readme"]);
    expect(readFileSync(join(billing, "README.md"), "utf-8")).toBe("# billing\n\nlocal, still editing\n");
  });

  test("their pre-push hook refuses the first push: the refusal names their commits that come along, before anything is published, and the retry says nothing again", () => {
    const { hosts, alice, record } = refundsTaken();
    const billing = join(alice, "billing");
    writeFileSync(join(billing, "README.md"), "# billing\n\nlocal\n");
    git(billing, ["commit", "-q", "-am", "wip: log billing calls"]);
    writeFileSync(join(billing, "README.md"), "# billing\n\nlocal, still editing\n");
    // Their hook turns the first push away, then lets the next one through.
    writeFileSync(join(billing, ".git", "refuse-once"), "");
    writeFileSync(join(billing, ".git", "hooks", "pre-push"),
      "#!/bin/sh\nif [ -f .git/refuse-once ]; then rm .git/refuse-once; echo 'pushes are paused' >&2; exit 1; fi\nexit 0\n");
    chmodSync(join(billing, ".git", "hooks", "pre-push"), 0o755);
    codeGenerated(alice, record);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toContain("The push of refunds in billing was refused");
    expect(String(refused.json?.error)).toContain(
      'Branch refunds in billing starts from where you were, so your commit not yet on origin/main comes along: "wip: log billing calls".',
    );
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: hosts.billing }).status).not.toBe(0);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).not.toContain("come along");
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"]).split("\n")).toEqual(["refunds: fixture", "wip: log billing calls"]);
  });

  test("their commit-msg hook refuses the Unit's commit and they commit its files on main themselves: the push carries that commit along, never branches past it", () => {
    const { hosts, alice, record } = refundsTaken();
    const billing = join(alice, "billing");
    // Their hook turns the first commit away.
    writeFileSync(join(billing, ".git", "refuse-once"), "");
    writeFileSync(join(billing, ".git", "hooks", "commit-msg"),
      "#!/bin/sh\nif [ -f .git/refuse-once ]; then rm .git/refuse-once; echo 'commit messages need a ticket' >&2; exit 1; fi\nexit 0\n");
    chmodSync(join(billing, ".git", "hooks", "commit-msg"), 0o755);
    codeGenerated(alice, record);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toContain("The commit in billing did not go through");
    // Back on main, they commit the Unit's file with their own words.
    git(billing, ["switch", "-q", "main"]);
    git(billing, ["add", "lib/refund.ts"]);
    git(billing, ["commit", "-q", "-m", "REF-7 refund handler"]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      'Branch refunds in billing starts from where you were, so your commit not yet on origin/main comes along: "REF-7 refund handler".',
    );
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"]).split("\n")).toEqual(["REF-7 refund handler"]);
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
    expect(git(billing, ["branch", "--show-current"])).toBe("refunds");
    expect(git(billing, ["log", "-1", "--format=%s", "main"])).toBe("REF-7 refund handler");
  });

  // A live run on Kiro CLI: the redo after a turn-down merged the newer main
  // into the Unit's branch and left the merge uncommitted; the person's "yes,
  // push it" was refused and they were asked again, twice.
  test("a merge under way on the Unit's own branch, nothing left to resolve: the push question offers to finish it, and the one yes finishes it and pushes", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    const billing = join(alice, "billing");
    const other = cloneOf(hosts.billing, "bob");
    writeFileSync(join(other, "MERGED.md"), "on main since\n");
    git(other, ["add", "MERGED.md"]);
    git(other, ["commit", "-q", "-m", "main moves on"]);
    git(other, ["push", "-q", "origin", "HEAD:main"]);
    git(billing, ["switch", "-q", "-c", "refunds"]);
    git(billing, ["fetch", "-q", "origin"]);
    git(billing, ["merge", "--no-commit", "--no-ff", "origin/main"]);
    const asked = next(alice);
    expect(asked.ask_type, JSON.stringify(asked).slice(0, 600)).toBe("unit-push");
    expect(String(asked.question)).toContain("billing is in the middle of a merge on refunds, with nothing left to resolve.");
    const finish = (asked.choices as Array<{ label: string; command?: string }>).find((entry) => entry.label === "Finish the merge and push");
    expect(finish?.command, JSON.stringify(asked.choices)).toEndWith("aidlc-unit.ts push --finish-merge");
    const pushed = run(UNIT, ["push", "--finish-merge"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds:MERGED.md"])).toBe("on main since");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: billing }).status).not.toBe(0);
  });

  // A live run on Kiro CLI: the redo's plan ran the merge with --no-commit
  // after Code Generation had staged the Unit's own new files; the push
  // question then said only "once it is finished or put aside".
  test("the Unit's own files staged with the merge still let the push finish it; a file of theirs that is neither keeps it theirs", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    const billing = join(alice, "billing");
    const other = cloneOf(hosts.billing, "bob");
    writeFileSync(join(other, "MERGED.md"), "on main since\n");
    git(other, ["add", "MERGED.md"]);
    git(other, ["commit", "-q", "-m", "main moves on"]);
    git(other, ["push", "-q", "origin", "HEAD:main"]);
    git(billing, ["switch", "-q", "-c", "refunds"]);
    git(billing, ["fetch", "-q", "origin"]);
    git(billing, ["merge", "--no-commit", "--no-ff", "origin/main"]);
    // The Unit's own file, staged while the merge is under way.
    git(billing, ["add", "lib/refund.ts"]);
    const asked = next(alice);
    expect(asked.ask_type, JSON.stringify(asked).slice(0, 600)).toBe("unit-push");
    expect(String(asked.question)).toContain("billing is in the middle of a merge on refunds, with nothing left to resolve.");
    // A staged file that is neither the merge's nor the Unit's is theirs to commit.
    writeFileSync(join(billing, "NOTES.md"), "mine\n");
    git(billing, ["add", "NOTES.md"]);
    const theirs = next(alice);
    expect(String(theirs.question ?? theirs.message ?? JSON.stringify(theirs))).not.toContain("with nothing left to resolve");
    git(billing, ["rm", "-q", "--cached", "NOTES.md"]);
    const pushed = run(UNIT, ["push", "--finish-merge"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds:MERGED.md"])).toBe("on main since");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
  });

  test("a merge left under way in a repo: the push commits nothing over it, says so in plain words with the way on, and goes once it is finished", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const billing = join(alice, "billing");
    // The integration branch moved on, and a merge of it into the Unit's branch is left resolved but not committed.
    const other = cloneOf(hosts.billing, "bob");
    writeFileSync(join(other, "MERGED.md"), "on main since\n");
    git(other, ["add", "MERGED.md"]);
    git(other, ["commit", "-q", "-m", "main moves on"]);
    git(other, ["push", "-q", "origin", "HEAD:main"]);
    git(billing, ["switch", "-q", "-c", "refunds"]);
    git(billing, ["fetch", "-q", "origin"]);
    git(billing, ["merge", "--no-commit", "--no-ff", "origin/main"]);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toStartWith(
      "billing is in the middle of a merge, so nothing was committed or pushed. Finish it (git commit) or put it aside " +
        "(git merge --abort), then I can push refunds.",
    );
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: hosts.billing }).status).not.toBe(0);
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: billing }).status).toBe(0);
    git(billing, ["commit", "-q", "--no-edit"]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds:MERGED.md"])).toBe("on main since");
  });

  test("the agent built in worktrees of its own and recorded them as checkouts: the push reads each as its repo's and sends both home", () => {
    const { hosts, home, alice, record } = refundsTaken();
    // Worktrees the agent made for the Unit, recorded with intent add-checkout.
    const trees = join(alice, ".aidlc-worktrees", "refunds");
    for (const repo of ["checkout-api", "billing"]) {
      git(join(alice, repo), ["worktree", "add", "-q", "-b", `payments/refunds-${repo}`, join(trees, repo)]);
      const added = run(UTILITY, ["intent", "add-checkout", join(".aidlc-worktrees", "refunds", repo)], alice);
      expect(added.status, added.out).toBe(0);
    }
    mkdirSync(join(trees, "checkout-api", "src"), { recursive: true });
    writeFileSync(join(trees, "checkout-api", "src", "refunds.ts"), "export const refunds = 1;\n");
    mkdirSync(join(trees, "billing", "lib"), { recursive: true });
    writeFileSync(join(trees, "billing", "lib", "refund.ts"), "export const refund = 1;\n");
    const stage = join(record, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation",
      unit: "refunds",
      version: 1,
      writes: [{ path: "checkout-api@checkout/src/refunds.ts" }, { path: "billing@checkout/lib/refund.ts" }],
    }, null, 2)}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nRefunds.\n");
    // Its traceability names the files where it built them, in its worktrees.
    const table = { coverage: [
      { id: "FR-1", status: "OK", target: ".aidlc-worktrees/refunds/checkout-api/src/refunds.ts" },
      { id: "FR-2", status: "OK", target: ".aidlc-worktrees/refunds/billing/lib/refund.ts" },
    ], upstream_ids: ["FR-1", "FR-2"] };
    writeFileSync(join(stage, "traceability.json"), `${JSON.stringify(table, null, 2)}\n`);
    finishBuild(record);
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    expect(String(ask.question)).toContain("It changed checkout-api and billing.");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toStartWith("Pushed branch refunds in checkout-api and billing.");
    expect(git(hosts["checkout-api"], ["show", "refunds:src/refunds.ts"])).toBe("export const refunds = 1;");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
    // What the lead's checks read names the repos, where the lead's project finds the files; the team's own record is as written.
    const tip = git(home.remote, ["rev-parse", `refs/heads/claim/${fixtureIntentId8(home.dir)}/refunds`]).trim();
    const sent = JSON.parse(git(home.remote, ["show", `${tip}:.aidlc-unit-result/construction/refunds/code-generation/traceability.json`])) as typeof table;
    expect(sent.coverage.map((entry) => entry.target)).toEqual(["checkout-api/src/refunds.ts", "billing/lib/refund.ts"]);
    expect(readFileSync(join(stage, "traceability.json"), "utf-8")).toContain(".aidlc-worktrees/refunds/checkout-api/src/refunds.ts");
  });

  test("the build wrote a file their .gitignore leaves out: the push leaves it out too, says so once, and pushes the rest", () => {
    const { hosts, alice, record } = refundsTaken();
    const billing = join(alice, "billing");
    writeFileSync(join(billing, ".gitignore"), "dist/\n");
    // The bundle registered as source for the review, as the build's own step did.
    writeFileSync(join(billing, ".aidlc-source-paths.json"), `${JSON.stringify({ version: 1, paths: ["dist/main.js"] })}\n`);
    git(billing, ["add", ".gitignore", ".aidlc-source-paths.json"]);
    git(billing, ["commit", "-q", "-m", "ignore the bundle"]);
    git(billing, ["push", "-q", "origin", "HEAD:main"]);
    codeGenerated(alice, record);
    mkdirSync(join(billing, "dist"), { recursive: true });
    writeFileSync(join(billing, "dist", "main.js"), "bundle();\n");
    const manifest = join(record, "construction", "refunds", "code-generation", "source-manifest.json");
    const written = JSON.parse(readFileSync(manifest, "utf-8")) as { writes: Array<{ repo: string; path: string }> };
    written.writes.push({ repo: "billing", path: "dist/main.js" });
    writeFileSync(manifest, `${JSON.stringify(written, null, 2)}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain("dist/main.js in billing is not in the commit: billing's .gitignore leaves it out.");
    expect(String(pushed.json?.notice)).not.toContain("-f");
    expect(git(hosts.billing, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).not.toContain("dist/main.js");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
  });

  test("every file the build wrote in a repo is one its .gitignore leaves out: that repo is not switched or pushed, and the line says so", () => {
    const { hosts, alice, record } = refundsTaken();
    const billing = join(alice, "billing");
    writeFileSync(join(billing, ".gitignore"), "lib/\n");
    writeFileSync(join(billing, ".aidlc-source-paths.json"), `${JSON.stringify({ version: 1, paths: ["lib/refund.ts"] })}\n`);
    git(billing, ["add", ".gitignore", ".aidlc-source-paths.json"]);
    git(billing, ["commit", "-q", "-m", "ignore lib"]);
    git(billing, ["push", "-q", "origin", "HEAD:main"]);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toStartWith("Pushed branch refunds in checkout-api.");
    expect(String(pushed.json?.notice)).toContain("lib/refund.ts in billing is not in the commit: billing's .gitignore leaves it out.");
    expect(git(billing, ["branch", "--show-current"])).toBe("main");
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: hosts.billing }).status).not.toBe(0);
  });

  // A live run: the manifest named whole folders and the build's tests left
  // __pycache__ in them, which the push committed, though the review never
  // counted them as source and the push question said only what the build wrote.
  // A file the repo tracks in such a folder (a committed bundle) is theirs to
  // ship: the build's change to it goes.
  test("the build names whole folders and its tests leave caches in them: the push carries what it wrote, deletions and tracked bundles too, and never the caches", () => {
    const { hosts, alice, record } = refundsTaken((alice) => {
      const billing = join(alice, "billing");
      mkdirSync(join(billing, "lib", "dist"), { recursive: true });
      writeFileSync(join(billing, "lib", "old.ts"), "export const old = 1;\n");
      writeFileSync(join(billing, "lib", "dist", "index.js"), "bundle(1);\n");
      git(billing, ["add", "lib/old.ts", "lib/dist/index.js"]);
      git(billing, ["commit", "-q", "-m", "old"]);
      git(billing, ["push", "-q", "origin", "HEAD:main"]);
    });
    codeGenerated(alice, record);
    const billing = join(alice, "billing");
    rmSync(join(billing, "lib", "old.ts"));
    writeFileSync(join(billing, "lib", "dist", "index.js"), "bundle(2);\n");
    mkdirSync(join(billing, "lib", "__pycache__"), { recursive: true });
    writeFileSync(join(billing, "lib", "__pycache__", "refund.cpython-312.pyc"), Buffer.from([0x61, 0x0d, 0x0d, 0x0a, 0, 1, 2, 3]));
    writeFileSync(join(billing, "lib", ".coverage"), "coverage data\n");
    mkdirSync(join(alice, "checkout-api", "src", "node_modules", "left"), { recursive: true });
    writeFileSync(join(alice, "checkout-api", "src", "node_modules", "left", "index.js"), "module.exports = 1;\n");
    const manifest = join(record, "construction", "refunds", "code-generation", "source-manifest.json");
    const written = JSON.parse(readFileSync(manifest, "utf-8")) as { writes: Array<{ repo: string; path: string }> };
    written.writes = [{ repo: "checkout-api", path: "src/" }, { repo: "billing", path: "lib/" }];
    writeFileSync(manifest, `${JSON.stringify(written, null, 2)}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toEqual(["README.md", "lib/dist/index.js", "lib/refund.ts"]);
    expect(git(hosts.billing, ["show", "refunds:lib/dist/index.js"])).toBe("bundle(2);");
    expect(git(hosts["checkout-api"], ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toEqual(["README.md", "src/refunds.ts"]);
    expect(String(pushed.json?.notice)).not.toMatch(/__pycache__|\.coverage|node_modules/);
    // What the tests left stays as it was, theirs; nothing is added to their ignore files.
    expect(git(billing, ["status", "--porcelain", "--untracked-files=all"]).split("\n").sort()).toEqual(["?? lib/.coverage", "?? lib/__pycache__/refund.cpython-312.pyc"]);
    expect(existsSync(join(billing, ".gitignore"))).toBe(false);
  });

  // A live run: a teammate kept the repos in folders of their own
  // (repos.local.json), so the Unit's traceability went home naming those
  // folders, and the lead's Build and Test trace missed 21 items.
  test("a teammate's repos kept elsewhere by repos.local.json: what goes home names the repos, never their folders", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    for (const name of ["checkout-api", "billing"]) cloneCode(hosts[name as "billing"], join(alice, ".."), `${name}-mine`, "alice");
    writeFileSync(join(alice, "aidlc", "repos.local.json"), `${JSON.stringify({ repos: [
      { name: "checkout-api", path: "../checkout-api-mine" },
      { name: "billing", path: "../billing-mine" },
    ] })}\n`);
    expect(takeIn("payments", ["refunds", "--home", HOME_RECORD], alice).status).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    mkdirSync(join(alice, "..", "checkout-api-mine", "src"), { recursive: true });
    writeFileSync(join(alice, "..", "checkout-api-mine", "src", "refunds.ts"), "export const refunds = 1;\n");
    mkdirSync(join(alice, "..", "billing-mine", "lib"), { recursive: true });
    writeFileSync(join(alice, "..", "billing-mine", "lib", "refund.ts"), "export const refund = 1;\n");
    const stage = join(record, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1,
      writes: [{ repo: "checkout-api", path: "src/refunds.ts" }, { repo: "billing", path: "lib/refund.ts" }],
    }, null, 2)}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nRefunds.\n");
    const table = { coverage: [
      { id: "FR-1", status: "OK", target: "../checkout-api-mine/src/refunds.ts" },
      { id: "FR-2", status: "OK", target: "../billing-mine/lib/refund.ts" },
    ], upstream_ids: ["FR-1", "FR-2"] };
    writeFileSync(join(stage, "traceability.json"), `${JSON.stringify(table, null, 2)}\n`);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const tip = git(home.remote, ["rev-parse", `refs/heads/claim/${fixtureIntentId8(home.dir)}/refunds`]).trim();
    const sent = JSON.parse(git(home.remote, ["show", `${tip}:.aidlc-unit-result/construction/refunds/code-generation/traceability.json`])) as typeof table;
    expect(sent.coverage.map((entry) => entry.target)).toEqual(["checkout-api/src/refunds.ts", "billing/lib/refund.ts"]);
    expect(readFileSync(join(stage, "traceability.json"), "utf-8")).toContain("../checkout-api-mine/src/refunds.ts");
  });

  test("a team whose branch names must start with feature/: push --branch takes their name, and every later use keeps it", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // Their own rule, as their pre-push hook keeps it in each repo.
    for (const repo of ["checkout-api", "billing"]) {
      const hook = join(alice, repo, ".git", "hooks", "pre-push");
      writeFileSync(hook, "#!/bin/sh\nwhile read lref lsha rref rsha; do case \"$rref\" in refs/heads/feature/*) ;; " +
        "*) echo 'branch names must start with feature/' >&2; exit 1;; esac; done\nexit 0\n");
      chmodSync(hook, 0o755);
    }
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toContain("branch names must start with feature/");
    const badName = run(UNIT, ["push", "--branch", "feature/..refunds"], alice);
    expect(badName.status).not.toBe(0);
    expect(String(badName.json?.error)).toStartWith('"feature/..refunds" is not a branch name git takes, so nothing was pushed.');
    const pushed = run(UNIT, ["push", "--branch", "feature/refunds"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toStartWith("Pushed branch feature/refunds in checkout-api and billing.");
    expect(git(hosts.billing, ["log", "-1", "--format=%s", "feature/refunds"])).toBe("refunds: fixture");
    // The branch the refused push made under the Unit's name is the one renamed, as their own hands would.
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: join(alice, "billing") }).status).not.toBe(0);
    expect(git(join(alice, "billing"), ["branch", "--show-current"])).toBe("feature/refunds");
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { result: { repos: Array<{ branch: string }> } };
    expect(claim.result.repos.map((repo) => repo.branch)).toEqual(["feature/refunds", "feature/refunds"]);
    // A later push, with the Unit's files changed again, keeps their name.
    writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 2;\n");
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toStartWith("Pushed branch feature/refunds in");
    expect(git(hosts.billing, ["show", "feature/refunds:lib/refund.ts"])).toBe("export const refund = 2;");
  });

  test("the push question names the branch the person gave", () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace("## Runtime State\n", "## Runtime State\n- **Unit Branch**: feature/refunds\n"));
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    expect(String(ask.question)).toContain("Commit its changes on branch feature/refunds in each and push them?");
  });

  test("push --help and rebase --help print their usage and change nothing", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const help = run(UNIT, ["push", "--help"], alice);
    expect(help.status, help.out).toBe(0);
    expect(help.out).toContain("unit push [--branch <name>]");
    for (const repo of ["checkout-api", "billing"]) {
      expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: join(alice, repo) }).status).not.toBe(0);
      expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: hosts[repo as "billing"] }).status).not.toBe(0);
      expect(git(join(alice, repo), ["branch", "--show-current"])).toBe("main");
    }
    expect((claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { result?: unknown }).result).toBeUndefined();
    const rebase = run(UNIT, ["rebase", "-h"], alice);
    expect(rebase.status, rebase.out).toBe(0);
    expect(rebase.out).toContain("unit rebase");
  });

  test("a repo whose git signs its commits gets a signed Unit commit", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const signer = join(tempDir("gpg"), "gpg.sh");
    writeFileSync(signer, "#!/bin/sh\ncat > /dev/null\necho '[GNUPG:] SIG_CREATED D 1 8 00 0 0' >&2\n" +
      "printf -- '-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n'\n");
    chmodSync(signer, 0o755);
    git(join(alice, "billing"), ["config", "commit.gpgSign", "true"]);
    git(join(alice, "billing"), ["config", "gpg.program", signer]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["cat-file", "commit", "refunds"])).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
    expect(git(hosts["checkout-api"], ["cat-file", "commit", "refunds"])).not.toContain("gpgsig");
  });

  test("a result the home did not take: the push is not counted as gone, and the next step offers it again", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    const hook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/heads/claim/*) echo 'claims are closed today' >&2; exit 1;; esac; done\n");
    chmodSync(hook, 0o755);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain("The lead's project did not take refunds's result:");
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Unit Push**: unsent");
    const again = next(alice);
    expect(again.ask_type, JSON.stringify(again)).toBe("unit-push");
    expect(again.question).toBe("refunds is pushed, but the lead's project did not take its result just now. Do you want me to send it again?");
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Unit Push**: pushed");
  });

  test("a push when the lead's project holds no claim for the Unit: its code goes, and its result is offered again", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    git(home.remote, ["update-ref", "-d", `refs/heads/claim/${fixtureIntentId8(home.dir)}/refunds`]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      "The lead's project did not take refunds's result: its claim is not there now. Do you want me to send it again?",
    );
    expect(git(hosts.billing, ["rev-parse", "--verify", "refunds"])).toMatch(/^[0-9a-f]{40}/);
    expect(existsSync(join(alice, "aidlc", "handoff")), "no result file is written").toBe(false);
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Unit Push**: unsent");
    const again = next(alice);
    expect(again.ask_type, JSON.stringify(again)).toBe("unit-push");
    expect(again.question).toBe("refunds is pushed, but the lead's project did not take its result just now. Do you want me to send it again?");
    const later = run(UNIT, ["push", "--later"], alice);
    expect(later.status, later.out).toBe(0);
    expect(next(alice).ask_type ?? null).not.toBe("unit-push");
  });

  test("a push after a turn-down keeps the lead's word that a repo merged only where that repo's head did not change", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "billing merged it by hand"], home.dir).status).toBe(0);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "checkout-api", "--person-words", "needs the ledger entry"], home.dir).status).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    // The team changes billing too: the lead's word was about the old billing change.
    writeFileSync(join(alice, "checkout-api", "src", "refunds.ts"), "export const refunds = 2;\n");
    writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 2;\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as Record<string, unknown>;
    expect(claim.said_merged).toBeUndefined();
    expect(claim.turned_down).toBeUndefined();
  });

  test("a Unit that changed a repo the lead's plan did not list: it is added once, said once, and goes home with the push", () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const ledger = codeHost("ledger");
    cloneCode(ledger, alice, "ledger", "alice");
    writeFileSync(join(alice, "ledger", "entries.ts"), "export const entry = 1;\n");
    const manifest = join(record, "construction", "refunds", "code-generation", "source-manifest.json");
    const written = JSON.parse(readFileSync(manifest, "utf-8")) as { writes: Array<{ repo: string; path: string }> };
    written.writes.push({ repo: "ledger", path: "entries.ts" });
    writeFileSync(manifest, `${JSON.stringify(written, null, 2)}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      "ledger was not in the lead's plan; refunds changed it, so it is now among refunds's repos and went with the push.",
    );
    expect(git(ledger, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toContain("entries.ts");
    // Added by hand at review time, it is the same one line.
    const again = run(UTILITY, ["intent", "add-repo", "ledger"], alice);
    expect(again.out).toContain("ledger is already one of this piece of work's repos");
  });

  test("a push a repo's host refuses is said once, in its words, and nothing is retried", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const hook = join(hosts.billing, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'branch protection: refunds needs a ticket' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status).not.toBe(0);
    expect(String(pushed.json?.error)).toBe(
      "The push of refunds in billing was refused: branch protection: refunds needs a ticket (pre-receive hook declined). " +
        "Nothing was retried. You're on refunds now in checkout-api and billing. Switch back to main any time.",
    );
  });

  // A live run on opencode: the push question was left open in one chat; in a
  // new chat "where were we?" got the words step, which never named the push,
  // and the person was asked to carry on to a next stage there is none of.
  test("words in a new chat while the push question is open: the step names the push, and going on puts it again", () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "first" }).ask_type).toBe("unit-push");
    const words = next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "second" }, ["--resume", "where were we?"]);
    expect(words.kind, JSON.stringify(words).slice(0, 500)).toBe("print");
    expect(String(words.message)).toContain("refunds is built and approved, and its push is the next step.");
    expect(String(words.message)).not.toContain("engine status");
    expect(next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "second" }).ask_type).toBe("unit-push");
  });

  // A live run on Kiro CLI: the redo after a turn-down was built on a new
  // branch from the newer main; the push switched back to the Unit's first
  // branch, committed the redo there without main's newer code, and pushed it.
  test("a redo built on its own branch from the newer main is pushed from that branch, never moved back onto the first build's", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "rebuild it on the newer main"], home.dir).status).toBe(0);
    expect(next(alice).ask_type).toBe("unit-turned-down");
    for (const [name, host] of Object.entries(hosts)) {
      const other = cloneOf(host, `bob-${name}`);
      writeFileSync(join(other, "MERGED.md"), "on main since\n");
      git(other, ["add", "MERGED.md"]);
      git(other, ["commit", "-q", "-m", "main moves on"]);
      git(other, ["push", "-q", "origin", "HEAD:main"]);
      const repo = join(alice, name);
      git(repo, ["fetch", "-q", "origin"]);
      git(repo, ["switch", "-q", "-c", "refunds-v2", "origin/main"]);
    }
    codeGeneratedAgain(alice);
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation" }, alice, basename(record), "payments");
    const asked = next(alice);
    expect(asked.ask_type, JSON.stringify(asked).slice(0, 500)).toBe("unit-push");
    expect(String(asked.question)).toContain("branch refunds-v2");
    const push = (asked.choices as Array<{ label: string; command?: string }>)[0];
    expect(push.command).toEndWith("aidlc-unit.ts push --branch refunds-v2");
    // A push that names no branch never moves it back onto the first build's.
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    expect(String(refused.json?.error)).toContain("push --branch refunds-v2");
    expect(git(join(alice, "billing"), ["branch", "--show-current"])).toBe("refunds-v2");
    const pushed = run(UNIT, ["push", "--branch", "refunds-v2"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds-v2:MERGED.md"])).toBe("on main since");
    expect(git(hosts.billing, ["show", "refunds-v2:lib/refund.ts"])).toBe("export const refund = 2;");
  });

  test("back on main after a push, with the Unit's files changed again: the next push carries them onto its branch, and nothing of theirs moves", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    // The way back the push's line offered, then Code Generation again on main.
    for (const repo of Object.keys(hosts)) git(join(alice, repo), ["switch", "-q", "main"]);
    const billing = join(alice, "billing");
    writeFileSync(join(billing, "NOTES.md"), "mine\n");
    codeGeneratedAgain(alice);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 2;");
    expect(git(hosts["checkout-api"], ["show", "refunds:src/refunds.ts"])).toBe("export const refunds = 2;");
    expect(git(billing, ["branch", "--show-current"])).toBe("refunds");
    expect(git(billing, ["status", "--porcelain"])).toBe("?? NOTES.md");
    expect(readFileSync(join(billing, "NOTES.md"), "utf-8")).toBe("mine\n");
  });

  // A live run on Kiro CLI: the redo after a turn-down merged the newer main
  // into the Unit's branch and dropped a file of the first build; Code
  // Generation listed it as deleted, and the push said it was "not there" and
  // offered to write it again, though its deletion was already committed.
  test("a file the Unit deleted whose deletion its branch already has is pushed as deleted, never said to be missing", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const api = join(alice, "checkout-api");
    git(api, ["switch", "-q", "refunds"]);
    git(api, ["rm", "-q", "src/refunds.ts"]);
    git(api, ["commit", "-q", "-m", "drop the first build's file"]);
    mkdirSync(join(api, "src"), { recursive: true });
    writeFileSync(join(api, "src", "refunds-v2.ts"), "export const refunds = 2;\n");
    const manifest = join(record, "construction", "refunds", "code-generation", "source-manifest.json");
    writeFileSync(manifest, `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1,
      writes: [{ repo: "checkout-api", path: "src/refunds.ts" }, { repo: "checkout-api", path: "src/refunds-v2.ts" },
        { repo: "billing", path: "lib/refund.ts" }],
    }, null, 2)}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.out).not.toContain("not there");
    const files = git(hosts["checkout-api"], ["ls-tree", "-r", "--name-only", "refunds"]).split("\n");
    expect(files).toContain("src/refunds-v2.ts");
    expect(files).not.toContain("src/refunds.ts");
  });

  test("their own change in the way of the Unit's branch: the push says git's words and the way on, touches nothing, and the next step does not offer it again", () => {
    const { hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const billing = join(alice, "billing");
    for (const repo of Object.keys(hosts)) git(join(alice, repo), ["switch", "-q", "main"]);
    // Their main moves on, and they are editing that file again.
    writeFileSync(join(billing, "README.md"), "# billing\n\nnew\n");
    git(billing, ["commit", "-q", "-am", "readme"]);
    writeFileSync(join(billing, "README.md"), "# billing\n\nnew, still editing\n");
    codeGeneratedAgain(alice);
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation" }, alice, basename(record), "payments");
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    const error = String(refused.json?.error);
    expect(error).toStartWith('Branch refunds could not be checked out in billing, so nothing was pushed. Git says: "');
    expect(error).toContain("README.md");
    expect(error).toEndWith('". Your own changes there stay as they are; once they are committed or put aside, I can push refunds. ' +
      "You're on refunds now in checkout-api. Switch back to main any time.");
    expect(tellsWhatToType(error)).toBe(false);
    expect(git(billing, ["branch", "--show-current"])).toBe("main");
    expect(git(billing, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(billing, ["diff", "--name-only"])).toBe("README.md");
    expect(git(billing, ["ls-files", "--others", "--exclude-standard"])).toBe("lib/refund.ts");
    expect(readFileSync(join(billing, "README.md"), "utf-8")).toBe("# billing\n\nnew, still editing\n");
    expect(readFileSync(join(billing, "lib", "refund.ts"), "utf-8")).toBe("export const refund = 2;\n");
    // The next step says where it stands once, and offers no push that fails the same way.
    const end = next(alice);
    expect(end.ask_type, JSON.stringify(end)).not.toBe("unit-push");
    expect((end.change_notices ?? []) as string[]).toContain(
      "refunds is built and approved, and not pushed: changes of yours in billing are in the way of its branch there. " +
        "Once they are committed or put aside, do you want me to push it?",
    );
    // Once they committed theirs, the push is offered and goes.
    git(billing, ["commit", "-q", "-am", "readme, done"]);
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 2;");
  });

  test("after a turn-down, once the redo's Code Generation is approved, the build's end offers the push again and never the redo", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"], home.dir).status).toBe(0);
    expect(next(alice).ask_type).toBe("unit-turned-down");
    codeGeneratedAgain(alice);
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation" }, alice, basename(record), "payments");
    const push = next(alice);
    expect(push.ask_type, JSON.stringify(push)).toBe("unit-push");
    // Not now: the end says it is not pushed, and the redo is not offered again.
    expect(run(UNIT, ["push", "--later"], alice).status).toBe(0);
    const end = next(alice);
    expect(end.kind, JSON.stringify(end)).toBe("done");
    expect(JSON.stringify(end)).not.toContain("back to Code Generation");
    expect(String(end.done_note)).toEndWith("aidlc-unit.ts push` and say its notice line.");
  });

  test("the build's end offers the push; not now pushes nothing, and the end says so once", () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // Every planned stage of the build done and approved.
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    expect(ask.question).toBe(
      "refunds is built and you approved it. It changed checkout-api and billing. Commit its changes on branch " +
        "refunds in each and push them?",
    );
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Push", "Not now"]);
    expect(choices[1].command).toEndWith("aidlc-unit.ts push --later");
    const later = run(UNIT, ["push", "--later"], alice);
    expect(later.status, later.out).toBe(0);
    expect(later.json?.notice).toBe(
      "Nothing is pushed. I'll push refunds when you want it to go to the lead. " +
        "Your teammates see where this work stands once aidlc/ is committed and pushed.",
    );
    expect(tellsWhatToType(ask.question, ask.choices, later.json?.notice)).toBe(false);
    const end = next(alice);
    expect(end.kind, JSON.stringify(end)).toBe("done");
    expect((end.change_notices ?? []) as string[]).toContain(
      "refunds is built and approved, and not pushed yet. Do you want me to push it now?",
    );
    expect(String(end.done_note)).toEndWith("aidlc-unit.ts push` and say its notice line.");
  });
});

describe("at the home", () => {
  test("while the home builds the walking skeleton, the claims are fetched once in a chat, not at every step", () => {
    const dependencies = "# Unit dependencies\n\n```yaml\nunits:\n  - name: orders\n    depends_on: []\n" +
      "  - name: refunds\n    depends_on: [orders]\n  - name: checkout-ui\n    depends_on: [orders]\n```\n";
    const home = makeHome({ dependencies, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const trace = join(tempDir("trace"), "trace2.json");
    for (let step = 0; step < 3; step++) {
      const directive = next(home.dir, { ...ENV, GIT_TRACE2_EVENT: trace });
      expect(directive.unit, JSON.stringify(directive)).toBe("orders");
    }
    // One look at the claims in the chat (an ls-remote, and a fetch only when the home has something new).
    const claimLooks = readFileSync(trace, "utf-8").split("\n").filter((line) => {
      if (!line.includes('"event":"start"')) return false;
      const argv = (JSON.parse(line) as { argv: string[] }).argv;
      return argv.includes("ls-remote") && argv.some((arg) => arg.includes("refs/heads/claim/"));
    });
    expect(claimLooks).toHaveLength(1);
  });

  test("a look at the board writes nothing back to the claim until the home sees a new merge", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const ref = `refs/heads/claim/${fixtureIntentId8(home.dir)}/refunds`;
    const pushed = git(home.remote, ["rev-parse", ref]);
    next(home.dir);
    next(home.dir);
    expect(git(home.remote, ["rev-parse", ref])).toBe(pushed);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    const seen = next(home.dir);
    expect(git(home.remote, ["rev-parse", ref])).not.toBe(pushed);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.verdicts).toEqual([
      expect.objectContaining({ repo: "checkout-api", merged: true }),
      { repo: "billing", merged: false },
    ]);
    // The one write the home makes for the teams, said once in plain words.
    expect((seen.change_notices ?? []) as string[]).toContain("I've told alice checkout-api merged refunds.");
    const written = git(home.remote, ["rev-parse", ref]);
    const after = next(home.dir);
    expect(git(home.remote, ["rev-parse", ref])).toBe(written);
    expect(JSON.stringify(after.change_notices ?? [])).not.toContain("I've told");
  });

  // The GitHub run's case 2: a review fix by hand, then a squash, the branch deleted.
  test("a review fix committed by hand on the Unit's branch, a look, then a squash with the branch deleted: merged", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const fix = commitOnHost(hosts["checkout-api"], "refunds", { "src/refunds.ts": "export const refunds = 1; // reviewed\n" }, "review fix");
    next(home.dir);
    // The lead's look keeps the branch's tip in a ref of AI-DLC's own, in that repo.
    const kept = `refs/aidlc/home/${fixtureIntentId8(home.dir)}/unit/refunds`;
    expect(git(join(home.dir, "checkout-api"), ["rev-parse", kept])).toBe(fix);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(hosts["checkout-api"], ["branch", "-q", "-D", "refunds"]);
    const seen = next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds"), JSON.stringify(seen)).toMatchObject({ done: true });
    expect((seen.change_notices ?? []) as string[]).toContain("I've told alice refunds is merged.");
  });

  // Case 2 with no look between the fix and the branch's deletion: the check
  // cannot see it, and the board asks the lead once.
  test("a fix, a squash and the branch's deletion all between two looks: the board names the commit once", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    commitOnHost(hosts["checkout-api"], "refunds", { "src/refunds.ts": "export const refunds = 1; // reviewed\n" }, "review fix");
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(hosts["checkout-api"], ["branch", "-q", "-D", "refunds"]);
    const squash = git(hosts["checkout-api"], ["rev-parse", "--short=7", "main"]);
    const line = `checkout-api has ${squash} "refunds (squashed)" changing every file of refunds; if that is refunds merged, say so.`;
    const chat = personsChat("t-unit-push-maybe-merged");
    const seen = personsNext(home.dir, chat, "t-unit-push-maybe-merged");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.verdicts).toEqual([
      { repo: "checkout-api", merged: false },
      expect.objectContaining({ repo: "billing", merged: true }),
    ]);
    expect((seen.change_notices ?? []) as string[], JSON.stringify(seen)).toContain(line);
    // Once in the chat.
    const again = personsNext(home.dir, chat, "t-unit-push-maybe-merged");
    expect(JSON.stringify(again.change_notices ?? []), JSON.stringify(again)).not.toContain("changing every file of refunds");
  });

  // Case 2 on GitHub and GitLab: the host keeps the pull request's last head
  // after its branch is deleted (refs/pull/<n>/head, refs/merge-requests/<n>/head),
  // and the squash names the pull request in the host's own words.
  for (const host of [
    { name: "GitHub", ref: "refs/pull/41/head", subject: "Refunds API (#41)" },
    { name: "GitLab", ref: "refs/merge-requests/41/head", subject: "Refunds API",
      mergeCommit: "Merge branch 'refunds' into 'main'\n\nRefunds API\n\nSee merge request payments/checkout-api!41" },
  ]) {
    test(`a fix, a squash and the branch's deletion between two looks, on ${host.name}: merged, and the lead is not asked`, () => {
      const { hosts, home, alice, record } = refundsTaken();
      codeGenerated(alice, record);
      expect(run(UNIT, ["push"], alice).status).toBe(0);
      git(home.dir, ["fetch", "-q", "origin"]);
      const fix = commitOnHost(hosts["checkout-api"], "refunds", { "src/refunds.ts": "export const refunds = 1; // reviewed\n" }, "review fix");
      git(hosts["checkout-api"], ["update-ref", host.ref, fix]);
      squashOnHost(hosts["checkout-api"], "refunds", host.subject, host.mergeCommit);
      mergeOnHost(hosts.billing, "refunds", "squash");
      const api = join(home.dir, "checkout-api");
      const refsBefore = git(api, ["for-each-ref", "--format=%(refname)"]);
      const chat = personsChat("t-unit-push-pr-head");
      const seen = personsNext(home.dir, chat, "t-unit-push-pr-head");
      expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds"), JSON.stringify(seen)).toMatchObject({ done: true });
      expect((seen.change_notices ?? []) as string[]).toContain("I've told alice refunds is merged.");
      expect(JSON.stringify(seen), JSON.stringify(seen)).not.toContain("changing every file of refunds");
      // Read with the lead's own git: no remote added, none of the host's refs kept here, and the head kept as
      // the Unit branch's tip in the ref the look keeps it in.
      const kept = `refs/aidlc/home/${fixtureIntentId8(home.dir)}/unit/refunds`;
      expect(git(api, ["remote"])).toBe("origin");
      expect(git(api, ["for-each-ref", "--format=%(refname)"]).split("\n").filter((ref) => !refsBefore.split("\n").includes(ref)))
        .toEqual([kept]);
      expect(git(api, ["rev-parse", kept])).toBe(fix);
    });
  }

  test("the pull request a merge names, in the hosts' own references: GitHub's squash (#41), GitLab's !41 or its address", () => {
    const both = ["refs/pull/41/head", "refs/merge-requests/41/head"];
    expect(pullRequestHeadRefs("Refunds API (#41)\n\n* review fix")).toEqual(both);
    expect(pullRequestHeadRefs("Merge branch 'refunds' into 'main'\n\nRefunds API\n\nSee merge request payments/checkout-api!41")).toEqual(both);
    expect(pullRequestHeadRefs("Merge branch 'refunds' into 'main'\r\n\r\nSee merge request https://gitlab.example/payments/checkout-api/-/merge_requests/41\r\n\r\nApproved-by: a reviewer <r@example.test>\r\n"))
      .toEqual(both);
    // No reference of either host: nothing read.
    for (const message of ["refunds: fixture", "Fix #41 in refunds", "Refunds API (#41) and more", "Refunds\n\nGreat work!41"]) {
      expect(pullRequestHeadRefs(message), message).toEqual([]);
    }
  });

  // Where the host keeps no such head, or the one the squash names is not the
  // Unit's, the check still cannot see it: the board asks the lead, as before.
  test("a squash that names a pull request whose head the host does not have, or whose head is not the Unit's: the board names the commit", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const host = hosts["checkout-api"];
    const fix = commitOnHost(host, "refunds", { "src/refunds.ts": "export const refunds = 1; // reviewed\n" }, "review fix");
    // A later head that holds the push but whose content main does not have (only the fix was squashed).
    const later = commitOnHost(host, "refunds", { "src/refunds.ts": "export const refunds = 1; // reviewed, then more\n" }, "more");
    git(host, ["update-ref", "refs/heads/refunds", fix]);
    squashOnHost(host, "refunds", "Refunds API (#41)");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const squash = git(host, ["rev-parse", "--short=7", "main"]);
    const line = `checkout-api has ${squash} "Refunds API (#41)" changing every file of refunds; if that is refunds merged, say so.`;
    // A host that keeps no such head; then another pull request's head under that number; then one that holds
    // the push and more.
    for (const [session, head] of [["t-unit-push-no-pr-head", null], ["t-unit-push-other-pr-head", "main~1"], ["t-unit-push-later-pr-head", later]]) {
      if (head !== null) git(host, ["update-ref", "refs/pull/41/head", git(host, ["rev-parse", head!])]);
      const seen = personsNext(home.dir, personsChat(session!), session!);
      expect((seen.change_notices ?? []) as string[], `${session} ${JSON.stringify(seen)}`).toContain(line);
    }
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.verdicts).toEqual([
      { repo: "checkout-api", merged: false },
      expect.objectContaining({ repo: "billing", merged: true }),
    ]);
    expect(git(join(home.dir, "checkout-api"), ["for-each-ref", `refs/aidlc/home/${fixtureIntentId8(home.dir)}/unit/refunds`])).toBe("");
  });

  // The team's side of case 2: its look sends the fix home, so a lead who
  // looks only after the branch is gone still sees the merge.
  test("a team's look at its pushed build sends a review fix by hand home, so a squash after the branch is gone reads merged", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const id8 = fixtureIntentId8(home.dir);
    const pushed = (claimPayload(home.remote, id8, "refunds")?.result as SentResult | undefined)?.repos.find((repo) => repo.repo === "checkout-api")?.heads;
    expect(pushed).toHaveLength(1);
    const fix = commitOnHost(hosts["checkout-api"], "refunds", { "src/refunds.ts": "export const refunds = 1; // reviewed\n" }, "review fix");
    next(alice);
    const sent = (claimPayload(home.remote, id8, "refunds")?.result as SentResult | undefined)?.repos.find((repo) => repo.repo === "checkout-api");
    expect(sent?.heads).toEqual([...pushed!, fix]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(hosts["checkout-api"], ["branch", "-q", "-D", "refunds"]);
    git(home.dir, ["fetch", "-q", "origin"]);
    const seen = next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds"), JSON.stringify(seen)).toMatchObject({ done: true });
  });

  test("a push again after a fix the person pushed with plain git keeps every head the branch had", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const api = join(alice, "checkout-api");
    writeFileSync(join(api, "src", "refunds.ts"), "export const refunds = 1; // by hand\n");
    git(api, ["commit", "-q", "-am", "fix by hand"]);
    git(api, ["push", "-q"]);
    const byHand = git(api, ["rev-parse", "HEAD"]);
    writeFileSync(join(api, "src", "refunds.ts"), "export const refunds = 1; // by hand, then AI-DLC\n");
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    const heads = (claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.result as SentResult | undefined)?.repos
      .find((repo) => repo.repo === "checkout-api")?.heads ?? [];
    expect(heads).toHaveLength(3);
    expect(heads[1]).toBe(byHand);
    expect(heads[2]).toBe(git(api, ["rev-parse", "HEAD"]));
  });

  // The GitHub run's case 3: the host's own commit of a review suggestion, then a squash, the branch kept.
  test("the host's commit of a review suggestion on the Unit's branch, then a squash: merged at the next look", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    commitOnHost(hosts["checkout-api"], "refunds", { "src/refunds.ts": "export const refunds = 1; // suggested\n" }, "Apply suggestions from code review");
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const seen = next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds"), JSON.stringify(seen)).toMatchObject({ done: true });
  });

  test("a Unit branch rewritten on the host is not read as the Unit: its squash leaves it not merged", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const other = join(tempDir("rewriter"), "repo");
    git(tempDir("rewriter-parent"), ["clone", "-q", hosts["checkout-api"], other]);
    git(other, ["config", "user.name", "reviewer"]);
    git(other, ["config", "user.email", "reviewer@example.test"]);
    git(other, ["switch", "-q", "-c", "refunds"]);
    mkdirSync(join(other, "src"), { recursive: true });
    writeFileSync(join(other, "src", "refunds.ts"), "export const somethingElse = 1;\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", "another change"]);
    git(other, ["push", "-q", "--force", "origin", "refunds"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.verdicts).toEqual([
      { repo: "checkout-api", merged: false },
      expect.objectContaining({ repo: "billing", merged: true }),
    ]);
  });

  // A live run (Lee, model 2): taking the team's Unit in wrote its records into
  // the lead's checkout, uncommitted, and no check-in line came.
  test("the lead's step that takes a team's merged Unit in says the check-in line, once", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const seen = next(home.dir);
    const notices = (seen.change_notices ?? []) as string[];
    expect(notices, JSON.stringify(seen)).toContain("I've told alice refunds is merged.");
    expect(notices.filter((line) => line === CHECK_IN_LINE), JSON.stringify(notices)).toHaveLength(1);
    const after = next(home.dir);
    expect((after.change_notices ?? []) as string[]).not.toContain(CHECK_IN_LINE);
  });

  test("a team's result brings home what Build and Test reads of the Unit, so its coverage check passes for team-built Units", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // What the team's Code Generation and NFR Requirements recorded for refunds.
    const table = { stage: "code-generation", upstream_ids: ["FR1"], coverage: [{ id: "FR1", status: "OK", target: "checkout-api/src/refunds.ts" }] };
    writeFileSync(join(record, "construction", "refunds", "code-generation", "traceability.json"), `${JSON.stringify(table, null, 2)}\n`);
    mkdirSync(join(record, "construction", "refunds", "nfr-requirements"), { recursive: true });
    writeFileSync(join(record, "construction", "refunds", "nfr-requirements", "performance-requirements.md"), "# Performance\n\nNFR1.1 fast refunds.\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    const homeUnit = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds");
    expect(JSON.parse(readFileSync(join(homeUnit, "code-generation", "traceability.json"), "utf-8"))).toEqual(table);
    expect(readFileSync(join(homeUnit, "nfr-requirements", "performance-requirements.md"), "utf-8")).toContain("NFR1.1");
    // The home has the merged code: Build and Test's cross-Unit coverage finds FR1 built.
    git(join(home.dir, "checkout-api"), ["pull", "-q", "origin", "main"]);
    const coverage = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-sensor-traceability.ts"), "--stage", "build-and-test"], {
      cwd: home.dir, encoding: "utf-8", env: { ...ENV, AIDLC_PROJECT_DIR: home.dir },
    });
    const result = JSON.parse(coverage.stdout) as { uncovered: string[] };
    expect(result.uncovered, coverage.stdout).not.toContain("FR1");
  });

  test("the board counts the merges, and the Unit is done once every repo merged; what waits on it opens", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const first = next(home.dir);
    expect(first.kind, JSON.stringify(first)).toBe("print");
    expect(String(first.narration)).toBe([
      "Units of fixture:",
      "- refunds, payments space: built by alice, checkout-api not merged yet, billing not merged yet (0 of 2 merged)",
      "- checkout-ui, open: waiting for a team to take it",
      "- reporting, open: waiting for a team to take it",
    ].join("\n"));
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    expect(String(next(home.dir).narration)).toContain(
      "- refunds, payments space: built by alice, checkout-api merged, billing not merged yet (1 of 2 merged)",
    );
    mergeOnHost(hosts.billing, "refunds", "merge");
    const after = next(home.dir);
    const merged = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged).toHaveLength(1);
    expect(merged[0].block).toContain("**Built By**: alice");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    expect(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds", "code-generation", "code-summary.md"), "utf-8"))
      .toBe("# Code summary\n\nRefunds.\n");
    expect(String(after.narration), JSON.stringify(after).slice(0, 600)).toContain("- refunds, payments space: built by alice, done");
    // reporting waited on refunds: on the lead's word to build it here, it starts now, as the home's own work.
    expect(run(UNIT, ["assign", "--here", "reporting", "--person-words", "we build reporting here"], home.dir).status).toBe(0);
    const building = next(home.dir);
    expect(building.kind, JSON.stringify(building).slice(0, 600)).toBe("run-stage");
    expect(building.unit).toBe("reporting");
    const started = run(STATE, ["unit", "start", "--stage", "functional-design", "--unit", "reporting"], home.dir);
    expect(started.status, started.out).toBe(0);
  });

  test("another machine or a fresh clone of the home reads a Unit done on its claim as done, and what waits on it opens", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    // The lead's laptop: the home's work as last pushed, without this machine's record of the merge.
    const laptop = cloneOf(home.remote, "lead-laptop");
    const picked = run(join(AIDLC_SRC, "tools", "aidlc.ts"), ["engine", "intent", "switch", HOME_RECORD], laptop);
    expect(picked.status, picked.out).toBe(0);
    const step = next(laptop);
    expect(String(step.narration), JSON.stringify(step).slice(0, 600)).toContain("- refunds, payments space: built by alice, done");
    expect(readAuditShardEvents(laptop).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    expect(readFileSync(join(laptop, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds", "code-generation", "code-summary.md"), "utf-8"))
      .toBe("# Code summary\n\nRefunds.\n");
    // reporting, built here on the lead's word, starts on the laptop too.
    expect(run(UNIT, ["assign", "--here", "reporting", "--person-words", "we build reporting here"], laptop).status).toBe(0);
    const building = next(laptop);
    expect(building.kind, JSON.stringify(building).slice(0, 600)).toBe("run-stage");
    expect(building.unit).toBe("reporting");
  });

  test("what a team sent shows at the home's next step, with no fetch by the lead", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(String(next(home.dir).narration)).toContain(
      "- refunds, payments space: built by alice, checkout-api not merged yet, billing not merged yet (0 of 2 merged)",
    );
  });

  test("a home remote that cannot be reached: the board is the last fetch's, with one line that it may be behind", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    git(home.dir, ["remote", "set-url", "origin", join(home.remote, "gone")]);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(String(step.narration)).toContain("- refunds, payments space: built by alice, checkout-api not merged yet, billing not merged yet (0 of 2 merged)");
    expect((step.change_notices ?? []) as string[]).toEqual([
      "origin could not be reached just now, so the board may be behind: it shows what your last fetch brought.",
    ]);
  });

  test("a turn-down reaches the team at its next step, with no fetch by the team, in its own workspace repo too", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    // payments keeps its own workspace repo, made from the home's: its pulls
    // never bring the home's claims.
    const seed = cloneOf(home.remote, "seed");
    const own = tempDir("payments-host");
    git(own, ["init", "-q", "--bare", "-b", "main"]);
    git(seed, ["remote", "set-url", "origin", own]);
    git(seed, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(own, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    expect(takeIn("payments", ["refunds", "--home", HOME_RECORD], alice).status).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    codeGenerated(alice, join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!));
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir).status).toBe(0);
    expect((next(alice).change_notices ?? []) as string[]).toContain(
      'refunds was turned down in billing by the lead: "billing needs the ledger entry too".',
    );
  });

  // A live run on Codex: its sandbox keeps the workspace's .git read-only, so
  // the news fetch could not write there, and the team heard "the home could
  // not be reached" and never its send-back. The step now says what stopped
  // it and the way on; run with write access to .git, the news comes.
  test.skipIf(process.platform === "win32")("news the team's .git cannot take in here is said as that, with the way on, never as the home being down", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir).status).toBe(0);
    // Every file and folder of the clone's .git read-only, as Codex's sandbox has it.
    const tree = (dir: string): string[] => [dir, ...readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() ? tree(join(dir, entry.name)) : [join(dir, entry.name)]))];
    const paths = tree(join(alice, ".git"));
    for (const path of paths) chmodSync(path, statSync(path).isDirectory() ? 0o555 : 0o444);
    // The person's chat, so every look a live step takes runs.
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    let blocked: ReturnType<typeof run>;
    const after: Array<ReturnType<typeof run>> = [];
    try {
      blocked = run(ORCH, ["next"], alice, chat);
      // Asked once in a chat: the steps after it go on (the Units to take,
      // offered once in a chat, then the build), and the build's says it plainly.
      after.push(run(ORCH, ["next"], alice, chat), run(ORCH, ["next"], alice, chat));
    } finally {
      for (const path of paths) chmodSync(path, statSync(path).isDirectory() ? 0o755 : 0o644);
    }
    expect(blocked.out).not.toContain("could not be reached");
    expect(blocked.status, blocked.out).not.toBe(0);
    expect(blocked.out).toContain("cannot be written in this session");
    expect(blocked.out).toContain("Run the same command again with write access to it");
    for (const step of after) {
      expect(step.status, step.out).toBe(0);
      expect(step.out).not.toContain("Run the same command again");
      expect(step.out).not.toContain("could not be reached");
    }
    expect(after.map((step) => step.out).join("\n")).toContain("News from the lead's project could not be taken in here");
    expect((next(alice, chat).change_notices ?? []) as string[]).toContain(
      'refunds was turned down in billing by the lead: "billing needs the ledger entry too".',
    );
  });

  test("code a team merged into the workspace itself is the work's own: the home never asks whether it is existing code", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    mkdirSync(join(home.dir, "services", "checkout-api", "src"), { recursive: true });
    writeFileSync(join(home.dir, "services", "checkout-api", "src", "refunds.ts"), "export const refunds = 1;\n");
    writeFileSync(join(home.dir, "package.json"), '{ "name": "platform" }\n');
    expect(next(home.dir).ask_type).not.toBe("project-type");
  });

  // A live run on opencode: the push was asked, the person went to run the
  // tests themselves, and their next chat's "where were we?" heard that the
  // work is finished, with no push offered.
  test("a built Unit whose push is still to offer is never called finished: a new chat's words get the push", () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    expect(next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "chat-1" }).ask_type).toBe("unit-push");
    const words = next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "chat-2" }, ["where were we?"]);
    expect(JSON.stringify(words)).not.toContain("is finished");
  });

  test("code written outside the Unit's repo is said in plain words, with the way back to Code Generation, and nothing is pushed", () => {
    const { hosts, alice, record } = refundsTaken();
    // Code Generation put the file at the workspace root, not in checkout-api.
    mkdirSync(join(alice, "src"), { recursive: true });
    writeFileSync(join(alice, "src", "refunds.ts"), "export const refunds = 1;\n");
    const stage = join(record, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [{ repo: "checkout-api", path: "src/refunds.ts" }],
    })}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status).not.toBe(0);
    const said = String(pushed.json?.error);
    // The source list's own check refuses it, said in plain words with the way back, never in the check's own terms.
    expect(said, pushed.out).toStartWith("refunds's Code Generation record names what it wrote in a way its repos do not have, so nothing was pushed.");
    expect(said).not.toMatch(/writes\[\d+\]|multi-repo intent/);
    expect(said).toEndWith(" report --result resumed --choice redo --target code-generation` and follow what it returns.");
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/refunds"], { cwd: hosts["checkout-api"] }).status).not.toBe(0);
  });

  // A live run: Code Generation wrote the files in the repo, and its manifest
  // gave them by their path from the workspace ("checkout-api/src/...").
  test("files in the repo that the manifest gives by their path from the workspace are never called outside it", () => {
    const { hosts, alice, record } = refundsTaken();
    mkdirSync(join(alice, "checkout-api", "src"), { recursive: true });
    writeFileSync(join(alice, "checkout-api", "src", "refunds.ts"), "export const refunds = 1;\n");
    writeFileSync(join(alice, "checkout-api", "src", "refund-routes.ts"), "export const routes = 1;\n");
    const stage = join(record, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [
        { repo: "checkout-api", path: "checkout-api/src/refunds.ts" },
        { repo: "checkout-api", path: "checkout-api/src/refund-routes.ts" },
      ],
    })}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status).not.toBe(0);
    const said = String(pushed.json?.error);
    expect(said, pushed.out).not.toContain("outside checkout-api");
    expect(said, pushed.out).toStartWith("refunds's Code Generation record names what it wrote in a way its repos do not have, so nothing was pushed.");
    expect(said).toEndWith(" report --result resumed --choice redo --target code-generation` and follow what it returns.");
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/refunds"], { cwd: hosts["checkout-api"] }).status).not.toBe(0);
  });

  // A live run: work in a one-repo project holding a git submodule recorded
  // the submodule as its only repo (as work did before a project's own
  // submodule stopped being recorded), and Code Generation wrote the Unit's
  // code in the project's own repo, where the person keeps it.
  test("work that records the project's submodule as its only repo: the push names the way on, and after it the code goes from the project's repo and the lead counts its merge", () => {
    const vendorHost = codeHost("vendor");
    const home = makeHome({ repos: { vendor: vendorHost } });
    writeFileSync(join(home.dir, ".gitignore"), readFileSync(join(home.dir, ".gitignore"), "utf-8").replace("/vendor/\n", ""));
    git(home.dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", vendorHost, "vendor"]);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    git(alice, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
    const took = takeIn("payments", ["refunds", "--home", HOME_RECORD], alice);
    expect(took.status, took.out).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    mkdirSync(join(alice, "src"), { recursive: true });
    writeFileSync(join(alice, "src", "refunds.ts"), "export const refunds = 1;\n");
    const stage = join(record, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [{ path: "src/refunds.ts" }],
    })}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nRefunds.\n");
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    const said = String(refused.json?.error);
    expect(said, refused.out).toStartWith(
      "refunds's Code Generation wrote its code in this project's own repo, and this work records vendor, a submodule of the " +
        "project, as its only repo, so nothing was pushed. Ask the person whether to take vendor off this work's repos",
    );
    expect(said).not.toContain("back to Code Generation");
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/refunds"], { cwd: alice }).status).not.toBe(0);
    // The person's yes: the named command, then the push again.
    expect(said).toContain("/aidlc-utility.ts intent remove-repo vendor`, then push refunds again.");
    const removed = run(UTILITY, ["intent", "remove-repo", "vendor"], alice);
    expect(removed.status, removed.out).toBe(0);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice), pushed.out).toStartWith("Pushed branch refunds in the repo.");
    expect(git(home.remote, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toContain("src/refunds.ts");
    expect(git(join(alice, "vendor"), ["status", "--porcelain"])).toBe("");
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/refunds"], { cwd: vendorHost }).status).not.toBe(0);
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as {
      result: { repos: Array<{ repo: string; branch: string }> };
    };
    expect(claim.result.repos.map((repo) => [repo.repo, repo.branch])).toEqual([[".", "refunds"]]);
    // Merged in the project's repo, the lead's next step counts it, with no word of theirs.
    mergeOnHost(home.remote, "refunds", "squash");
    git(home.dir, ["pull", "-q", "origin", "main"]);
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });

  // A live run: the same work in a teammate's fresh clone, where git leaves the
  // submodule's folder empty until it is checked out: the push question named
  // the submodule as the repo it changed, and the push stopped at "not at vendor
  // in this workspace", a dead end.
  test("in a fresh clone that has not checked the submodule out, the push question names the project's repo and the push names the same way on", () => {
    const vendorHost = codeHost("vendor");
    const home = makeHome({ repos: { vendor: vendorHost } });
    writeFileSync(join(home.dir, ".gitignore"), readFileSync(join(home.dir, ".gitignore"), "utf-8").replace("/vendor/\n", ""));
    git(home.dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", vendorHost, "vendor"]);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const took = takeIn("payments", ["refunds", "--home", HOME_RECORD], alice);
    expect(took.status, took.out).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    mkdirSync(join(alice, "src"), { recursive: true });
    writeFileSync(join(alice, "src", "refunds.ts"), "export const refunds = 1;\n");
    const stage = join(record, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [{ path: "src/refunds.ts" }],
    })}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nRefunds.\n");
    finishBuild(record);
    const asked = next(alice);
    expect(asked.ask_type, JSON.stringify(asked).slice(0, 400)).toBe("unit-push");
    expect(String(asked.question)).toContain("It changed the repo.");
    expect(String(asked.question)).not.toContain("It changed vendor.");
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    const said = String(refused.json?.error);
    expect(said, refused.out).toStartWith(
      "refunds's Code Generation wrote its code in this project's own repo, and this work records vendor, a submodule of the " +
        "project, as its only repo, so nothing was pushed.",
    );
    expect(said).not.toContain("is not at vendor");
    expect(run(UTILITY, ["intent", "remove-repo", "vendor"], alice).status).toBe(0);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toContain("src/refunds.ts");
  });

  test("a home moved on past the Unit stages records no Unit: the result stays on its claim, said once, and is recorded back on the Unit stages", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    // The lead moves the work on to Build and Test, skipping every Unit stage.
    const jumped = run(JUMP, ["execute", "--target", "build-and-test", "--direction", "forward"], home.dir);
    expect(jumped.status, jumped.out).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    // The board and status say where it is, read only, before any step records it.
    const row = "not recorded yet: it is recorded once the work is back on Functional Design";
    expect(run(ORCH, ["team-board"], home.dir).out).toMatch(new RegExp(`^- refunds, payments space: built by alice, .*${row}$`, "m"));
    expect(run(UTILITY, ["status"], home.dir).out).toMatch(new RegExp(`^- refunds, payments space: built by alice, .*${row}$`, "m"));
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "t-unit-push-past-unit-stages" };
    const step = next(home.dir, chat);
    const said = ((step.change_notices ?? []) as string[]).filter((line) => line.startsWith("refunds (from alice) is back but not recorded yet"));
    expect(said, JSON.stringify(step)).toEqual([
      "refunds (from alice) is back but not recorded yet: this work moved on to Build and Test past the Unit stages, " +
        "so it is recorded once the work is back on Functional Design, and Build and Test does not have its outputs " +
        "until then.",
    ]);
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toEqual([]);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.done).toBeUndefined();
    // Back on the Unit stages, the walk checks the result and records it.
    const back = run(JUMP, ["execute", "--target", "functional-design", "--direction", "backward"], home.dir);
    expect(back.status, back.out).toBe(0);
    next(home.dir, chat);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED").map((row) => row.block).join("\n")).toContain("refunds");
  });

  test("the way back named is the Unit stage the work left from, and a home still on the Unit stages is not past them", () => {
    const fromCodeGeneration = homeState()
      .replace(/^- \[-\] functional-design/m, "- [x] functional-design")
      .replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test");
    expect(pastUnitStages(fromCodeGeneration)).toEqual({ at: "Build and Test", back: "Code Generation" });
    expect(pastUnitStages(homeState())).toBeNull();
  });

  test("the board names the agent's commands for the lead's words: a repo turned it down, or merged it where the check cannot see", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const board = next(home.dir);
    expect(board.kind).toBe("print");
    expect(String(board.board_note)).toContain("aidlc-unit.ts turned-down <unit> --repo <repo> --request-file aidlc/.aidlc-engine/request-text/unit-turned-down.txt");
    expect(String(board.board_note)).toContain("aidlc-unit.ts merged <unit> --repo <repo> --request-file aidlc/.aidlc-engine/request-text/unit-merged.txt");
  });

  test("the lead's word that a repo merged where the check cannot see: kept in their words, and the Unit is done", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    expect(String(next(home.dir).narration)).toContain("checkout-api merged, billing not merged yet (1 of 2 merged)");
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "billing merged it by hand last night"], home.dir);
    expect(said.status, said.out).toBe(0);
    // Recorded when the lead says it, by the take-in the next step runs, with the check-in line.
    expect(said.json?.notice).toBe(`refunds is recorded as merged here. ${CHECK_IN_LINE}`);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    const merged = () => readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged()).toHaveLength(1);
    expect(merged()[0]?.block).toContain('billing (by your word: "billing merged it by hand last night")');
    // The next step records nothing again and says nothing of it again.
    const after = next(home.dir);
    expect(merged()).toHaveLength(1);
    expect(JSON.stringify(after.change_notices ?? [])).not.toContain(CHECK_IN_LINE);
    expect(JSON.stringify(after)).not.toContain("is recorded as merged here");
  });

  // A live run (the lead in a workspace of their own): the lead asked to record
  // a merge the board had seen, and only that; the agent ran merged, which put
  // their words on the claim and recorded nothing, and no check-in line came.
  test("the lead's word for a merge the check sees: recorded at once, saying so, with no next step", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "record the refunds merge, just the merge"], home.dir);
    expect(said.status, said.out).toBe(0);
    expect(said.json?.notice).toBe(`refunds is recorded as merged here. ${CHECK_IN_LINE}`);
    const rows = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(rows).toHaveLength(1);
    expect(rows[0].block).toContain("by your word");
  });

  test("the lead's word for one repo while another has not merged: nothing recorded, and the line says which", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "billing merged it"], home.dir);
    expect(said.status, said.out).toBe(0);
    expect(said.json?.notice).toBe("billing counts as merged for refunds, in your words. checkout-api has not merged it yet, so nothing is recorded here.");
    expect(readAuditShardEvents(home.dir).some((row) => row.event === "UNIT_MERGED")).toBe(false);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.done).toBeUndefined();
  });

  // A live run: the member said the merge request merged and the agent ran the
  // lead's merged at the team's build, which said the team had no result. The
  // lead's project checks the repos itself.
  test("the lead's merged, run at a team's build by git, says the lead's project checks it and writes nothing", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const before = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds");
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "billing is merged now"], alice);
    expect(said.status, said.out).not.toBe(0);
    expect(String(said.json?.error), said.out).toBe(
      "The lead's project checks at its own next step whether refunds merged; a merge it cannot see, the lead counts in " +
        "their own words there. Nothing needs sending from here.",
    );
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toEqual(before);
  });

  test("the lead's word that a repo turned a Unit down or merged it counts only with a turn of theirs behind it", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const guarded: NodeJS.ProcessEnv = { ...ENV, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "" };
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger"], home.dir, guarded);
    expect(down.status).not.toBe(0);
    expect(String(down.json?.error)).toStartWith("A turn-down is the person's own word: ask them first, then run this with their words.");
    const merged = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "merged by hand"], home.dir, guarded);
    expect(merged.status).not.toBe(0);
    expect(String(merged.json?.error)).toStartWith("That it merged is the person's own word: ask them first, then run this with their words.");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "billing merged it by hand" }, home.dir);
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "billing merged it by hand"], home.dir, guarded);
    expect(said.status, said.out).toBe(0);
  });

  test("a lead's word the hooks may have missed: no heartbeat names what happened to a reply, a fresh one ends the turn", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const chat = personsChat("t-unit-push-lead");
    const words = ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger"];
    const missed = run(UNIT, words, home.dir, chat);
    expect(missed.status).not.toBe(0);
    expect(String(missed.json?.error)).toStartWith("A turn-down is the person's own word: ask them first, then run this with their words. ");
    expect(String(missed.json?.error)).not.toContain("end your turn");
    // The prompt hook beat just now and no turn of theirs stands: the person has not answered this yet.
    const health = hooksHealthReadDir(home.dir);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    const waiting = run(UNIT, words, home.dir, chat);
    expect(String(waiting.json?.error)).toEndWith("The person has not answered yet: end your turn; their next reply answers it.");
  });

  test("the lead's own pre-push hook turns the board's send away: the line says the hook's words, and the next step sends it", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    next(home.dir);
    const hook = join(home.dir, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\necho 'run the test gate before you push: npm test' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const step = next(home.dir);
    const line = ((step.change_notices ?? []) as string[]).find((said) => said.startsWith("What the board shows here")) ?? "";
    expect(line).toStartWith("What the board shows here could not be sent to origin: run the test gate before you push: npm test");
    expect(line).toEndWith("The teams may not see it yet, and the next step sends it again.");
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });

  test("a verdict the home's remote does not take stays here, said once, and goes at the next step", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    next(home.dir);
    const hook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/heads/claim/*) echo 'claims are read-only today' >&2; exit 1;; esac; done\n");
    chmodSync(hook, 0o755);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const step = next(home.dir);
    const line = ((step.change_notices ?? []) as string[]).find((said) => said.startsWith("What the board shows here")) ?? "";
    expect(line).toStartWith("What the board shows here could not be sent to origin: claims are read-only today");
    expect(line).toEndWith("The teams may not see it yet, and the next step sends it again.");
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.done).toBeUndefined();
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
  });

  test("a team whose pushed build waits on the home hears a turn-down at its next step in the same chat, and the build never reads as finished", () => {
    // Every other Unit is open, so the team is offered one next.
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // The person's chat ran the build: its prompt hook has run in this record.
    const chat = personsChat("t-unit-push-waits");
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-push-waits", prompt: "build refunds" }).status).toBe(0);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    // Once in the chat, the Unit the team can start next comes first (reporting, early on refunds' push).
    const offer = personsNext(alice, chat, "t-unit-push-waits");
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 300)).toBe("unit-take");
    const first = personsNext(alice, chat, "t-unit-push-waits");
    expect(first.kind, JSON.stringify(first)).toBe("done");
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir).status).toBe(0);
    const step = personsNext(alice, chat, "t-unit-push-waits");
    expect((step.change_notices ?? []) as string[]).toContain(
      'refunds was turned down in billing by the lead: "billing needs the ledger entry too".',
    );
    expect(step.ask_type, JSON.stringify(step)).toBe("unit-turned-down");
    // Not now: it reads as not finished, and the question is not put again; the agent keeps the offer.
    const later = personsNext(alice, chat, "t-unit-push-waits");
    expect(later.kind, JSON.stringify(later)).toBe("print");
    const offers = later.offers as Array<{ question: string; choices: Array<{ label: string; command?: string }> }>;
    expect(offers[0].question).toBe(
      "refunds is not finished: it was turned down by the lead and waits for your change and a new push. " +
        "Do you want me to take it back to Code Generation?",
    );
    expect(offers[0].choices[0].command).toEndWith("report --result resumed --choice redo --target code-generation");
    // Pushed again, the turn-down is answered: the build is finished once more.
    writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 2;\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.turned_down).toBeUndefined();
    expect(personsNext(alice, chat, "t-unit-push-waits").kind).toBe("done");
  });

  test("after a turn-down the build asks whether to go back to Code Generation, and the person's yes takes it there", () => {
    // Every other Unit is open, so the team is offered one next.
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    // The first build's code plan, as its Code Generation wrote it (a live run
    // on Kiro CLI: after the turn-down this plan was put up for approval again).
    const stage = join(record, "construction", "refunds", "code-generation");
    writeFileSync(join(stage, "code-generation-plan.md"), "# Code plan\n\n- [ ] Write src/refunds.ts and lib/refund.ts.\n");
    writeFileSync(join(stage, "unit-test-instructions.md"), "# Unit tests\n\nRun bun test.\n");
    // The person's chat ran the build: its prompt hook has run in this record.
    const chat = personsChat("t-unit-push-turned-down");
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-push-turned-down", prompt: "build refunds" }).status).toBe(0);
    finishBuild(record);
    // The person approved the last stage: their earlier turns are spent.
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation" }, alice, basename(record), "payments");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(personsNext(alice, chat, "t-unit-push-turned-down").ask_type).toBe("unit-take");
    expect(personsNext(alice, chat, "t-unit-push-turned-down").kind).toBe("done");
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir).status).toBe(0);
    const ask = personsNext(alice, chat, "t-unit-push-turned-down");
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-turned-down");
    expect(ask.question).toBe(
      "Do you want me to take refunds back to Code Generation so you can change it and push it again? " +
        "That is what I'd do: billing needs the change before refunds can merge.",
    );
    const choices = ask.choices as Array<{ label: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Take refunds back to Code Generation", "Not now"]);
    expect(tellsWhatToType(ask.question, ask.choices, ask.change_notices)).toBe(false);
    expect(choices[0].command).toEndWith("report --result resumed --choice redo --target code-generation");
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).not.toContain("- **Status**: Completed");
    // The person says yes in their chat; the choice, the way back it prints, and the guard that lets it run.
    const said = hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-push-turned-down", prompt: "yes, take it back" });
    expect(said.status, said.out).toBe(0);
    const back = run(ORCH, ["report", "--result", "resumed", "--choice", "redo", "--target", "code-generation"], alice, chat);
    const jump = /`(bun \S+aidlc-jump\.ts execute [^`]+)`/.exec(String(back.json?.message))?.[1];
    expect(jump, back.out).toBeDefined();
    // The jump as the agent runs it, from the project's own tool tree.
    cpSync(AIDLC_SRC, join(alice, ".claude"), { recursive: true });
    const guard = hook(alice, chat, {
      hook_event_name: "PreToolUse", session_id: "t-unit-push-turned-down", tool_name: "Bash", tool_input: { command: jump },
    });
    expect(guard.status, guard.out).toBe(0);
    const ran = spawnSync("bash", ["-c", bashLine(jump!)], { cwd: alice, encoding: "utf-8", env: chat });
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    const step = next(alice, chat);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe("code-generation");
    // The redo's plan is written for the home's words, never the plan from before the turn-down put up again.
    expect(String(step.plan_note), JSON.stringify(step.plan_approval)).toContain(
      'refunds was turned down in billing by the lead: "billing needs the ledger entry too". Revise this plan and its test instructions for it',
    );
  });

  // A live run on Kiro CLI: after the lead's turn-down the team redid the Unit
  // from billing's newer main; the push was refused as non-fast-forward, its
  // branch on origin still holding the build that was turned down, and the
  // agent handed the person git's own ways, a force push among them.
  test("a redo built on the newer main whose branch on origin holds the turned-down build: the way on is a new branch the home follows", () => {
    const { home, hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "rebuild it on the new main"], home.dir).status).toBe(0);
    // The redo, from billing's main and not on top of the pushed branch.
    git(join(alice, "billing"), ["switch", "-q", "main"]);
    git(join(alice, "billing"), ["branch", "-q", "-D", "refunds"]);
    git(join(alice, "billing"), ["switch", "-q", "-c", "refunds", "main"]);
    mkdirSync(join(alice, "billing", "lib"), { recursive: true });
    writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 2;\n");
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    const said = String(refused.json?.error);
    expect(said, refused.out).toContain("its branch refunds on origin in billing still holds the build pushed before");
    expect(said).not.toContain("non-fast-forward");
    expect(said).toContain("aidlc-unit.ts push --branch refunds-2`");
    expect(said).toContain("AI-DLC never forces a push");
    const again = run(UNIT, ["push", "--branch", "refunds-2"], alice);
    expect(again.status, again.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds-2:lib/refund.ts"])).toBe("export const refund = 2;");
    expect(git(hosts.billing, ["rev-parse", "refunds"])).not.toBe(git(hosts.billing, ["rev-parse", "refunds-2"]));
  });

  test("a turn-down at the home reaches the team once, in the home's words", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir);
    expect(down.status, down.out).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    const line = 'refunds was turned down in billing by the lead: "billing needs the ledger entry too".';
    expect((next(alice).change_notices ?? []) as string[]).toContain(line);
  });
});

// The lead's call on a live run: Build and Test at the lead's project failed on
// a Unit a team built; its retry reopened that Unit's Code Generation at the
// lead's project, where nothing of it is built, and the board still said done.
describe("a team's done Unit that the lead's Build and Test sends back", () => {
  // A live run on Codex: the team's build was pushed and finished; after the
  // lead's Build and Test sent refunds back, "can you check again?" heard that
  // the work is finished, and the question that came named no repo.
  test("a finished, pushed build sent back reaches the team on their own words too, and its question names the lead's Build and Test", () => {
    const { home, hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(run(UNIT, ["send-back", "refunds", "--person-words", "checkout-api sends no CORS headers"], home.dir).status).toBe(0);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    const words = "the lead says they sent our refunds unit back to us. can you check again?";
    // Their words read as work under way, never as finished work; the agent's
    // step on from them is the build's own, which asks for the way back.
    const read = next(alice, chat, ["--", words]);
    expect(JSON.stringify(read)).not.toContain("is finished");
    expect(String(read.message), JSON.stringify(read).slice(0, 600)).toContain("Work is in progress on");
    const step = next(alice, chat);
    expect(step.ask_type, JSON.stringify(step).slice(0, 600)).toBe("unit-turned-down");
    expect([...((read.change_notices ?? []) as string[]), ...((step.change_notices ?? []) as string[])])
      .toContain('refunds was sent back from the lead\'s Build and Test: "checkout-api sends no CORS headers".');
    expect(String(step.question)).toBe("Do you want me to take refunds back to Code Generation so you can change it and push it again? " +
      "That is what I'd do: the lead's Build and Test needs the change before refunds can merge again.");
    expect(JSON.stringify(next(alice, chat))).toContain(
      "refunds is not finished: it was sent back from the lead's Build and Test and waits for your change and a new push.",
    );
    // A live run on Kiro CLI: the agent read "anything new for us?" as a request,
    // and the request was put the new-work question. In a build that waits for
    // its way back, the request goes with it, never asked where it belongs.
    const asked = next(alice, chat, ["--", "hi again, anything new for us?"]);
    const request = /--request (\S+)/.exec(String(asked.message))?.[1];
    expect(request, String(asked.message)).toBeString();
    const answered = next(alice, chat, ["--request", request!.replace(/[`'"]/g, "")]);
    expect(JSON.stringify(answered), JSON.stringify(answered).slice(0, 600)).not.toContain("Separate new piece of work");
    expect(JSON.stringify(answered)).toContain("Take refunds back to Code Generation");
  });

  test("goes back to its team in the failure's words, is not done here meanwhile, and is recorded again once it merges again", () => {
    const { home, hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    const id8 = fixtureIntentId8(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ done: true });
    const merges = () => readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED" && row.block.includes("**Unit**: refunds")).length;
    expect(merges()).toBe(1);
    // The retry for refunds sends it back to alice's build; nothing of it is reopened here.
    const retry = next(home.dir, undefined, ["--stage", "code-generation", "--unit", "refunds"]);
    expect(String(retry.message), JSON.stringify(retry)).toContain("send-back refunds --request-file");
    expect(String(retry.message)).not.toContain("reopen --target");
    const words = "checkout-api sends no CORS headers for the web page";
    const sent = run(UNIT, ["send-back", "refunds", "--person-words", words], home.dir);
    expect(sent.status, sent.out).toBe(0);
    expect(sent.json?.notice).toBe("Sent refunds back to alice with your words. It waits for them here; nothing of it is rebuilt here.");
    const claim = claimPayload(home.remote, id8, "refunds") as Record<string, unknown>;
    expect(claim.done).toBeUndefined();
    expect(claim.result).toBeUndefined();
    // Nothing of it is built here: the board says it was sent back, never a turn-down in no repo.
    const board = String(next(home.dir).narration ?? "");
    expect(board).not.toContain("refunds, payments: done");
    expect(board, board).toContain("- refunds, payments space: sent back from your Build and Test, back with alice");
    expect(board).not.toContain("turned down in ,");
    // payments hears it once, in the failure's words.
    git(alice, ["fetch", "-q", "origin"]);
    const line = `refunds was sent back from the lead's Build and Test: "${words}".`;
    expect((next(alice).change_notices ?? []) as string[]).toContain(line);
    // Built again (the fix in files of its own) and merged again: the lead's project records it again.
    for (const [repo, path] of [["checkout-api", "src/cors.ts"], ["billing", "lib/cors.ts"]]) {
      mkdirSync(join(alice, repo, path.split("/")[0]), { recursive: true });
      writeFileSync(join(alice, repo, ...path.split("/")), "export const cors = true;\n");
    }
    writeFileSync(join(record, "construction", "refunds", "code-generation", "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1,
      writes: [{ repo: "checkout-api", path: "src/cors.ts" }, { repo: "billing", path: "lib/cors.ts" }],
    }, null, 2)}\n`);
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ done: true });
    expect(merges()).toBe(2);
  });

  // A live run (the lead's Build and Test on Claude Code, two Units teams had
  // built and merged): the Build Failure question offered no fix here, the
  // person typed "Fix it here", the step offered only the send-back, so the way
  // was asked again; the second Unit's reopen was refused, and the next step
  // completed Code Generation from the old merge, so the fix was written in
  // Build and Test with no plan, review or Plan Approval.
  test("a team's merged Unit the lead's Build and Test names: the step names both ways, and the Build Failure keeps Retry with fix", () => {
    const { home } = twoMergedAtBuildAndTest();
    const message = String(next(home.dir, undefined, ["--stage", "code-generation", "--unit", "refunds"]).message);
    expect(message).toContain("send-back refunds --request-file");
    expect(message).toContain("aidlc-unit.ts assign --here refunds --request-file aidlc/.aidlc-engine/request-text/unit-assign.txt");
    // A merged Unit's release is refused once the lead's record is pushed: the take-back is assign's alone.
    expect(message).not.toContain("release refunds");
    expect(message).toContain("next --stage code-generation --unit refunds");
    expect(message).not.toContain("never reopened here");
    const prose = readFileSync(join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol-loopback.md"), "utf-8");
    expect(prose).toContain('someone else built and merged keeps "Retry with fix"');
    expect(prose).toContain("**Send it back to <who built it> with this failure**");
  });

  test("taken back to fix here: one reopen for both Units that the guard lets through, and Code Generation runs again, never completed from the merge", () => {
    const { home } = twoMergedAtBuildAndTest();
    cpSync(AIDLC_SRC, join(home.dir, ".claude"), { recursive: true });
    const session = "t-unit-push-fix-here";
    const chat = personsChat(session);
    const words = "Fix it here, in refunds and checkout-ui, then run Build and Test again.";
    expect(hook(home.dir, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: words }).status).toBe(0);
    const here = run(UNIT, ["assign", "--here", "refunds,checkout-ui", "--person-words", words], home.dir, chat);
    // From a chat the line rides the next step the agent speaks from.
    expect(here.json?.notice, here.out).toBeUndefined();
    const builtHere = "refunds is built here now, on top of what alice merged. checkout-ui is built here now, on top of what alice merged.";
    const print = next(home.dir, chat, ["--stage", "code-generation", "--unit", "refunds"]);
    const jump = /`(bun \S+aidlc-jump\.ts reopen [^`]+)`/.exec(String(print.message))?.[1];
    expect(jump, String(print.message)).toContain("--units refunds,checkout-ui ");
    const guard = hook(home.dir, chat, { hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", tool_input: { command: jump! } });
    expect(guard.status, guard.out).toBe(0);
    const ran = spawnSync("bash", ["-c", bashLine(jump!)], { cwd: home.dir, encoding: "utf-8", env: chat });
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    const completions = (): number =>
      readAuditShardEvents(home.dir).filter((row) => row.event === "STAGE_COMPLETED" && row.block.includes("**Stage**: code-generation")).length;
    const before = completions();
    // The reopen holds across every next look: Code Generation, its plan first,
    // the plan that came home with the merge revised for the lead's words, never
    // asked as it stands.
    for (let look = 0; look < 2; look++) {
      const step = next(home.dir, chat);
      expect(step.kind, JSON.stringify(step).slice(0, 600)).toBe("run-stage");
      expect(step.stage).toBe("code-generation");
      expect(String(step.narration)).toContain("Writing the code plan for Code Generation for ");
      expect(String(step.plan_note), JSON.stringify(step.plan_approval)).toContain(
        `was sent back from the lead's Build and Test: "${words}". Revise this plan and its test instructions for it`,
      );
      // Said once, with the first of them.
      expect(((step.change_notices ?? []) as string[]).includes(builtHere), JSON.stringify(step.change_notices)).toBe(look === 0);
    }
    expect(completions()).toBe(before);
    // The stages before it keep the work that merged.
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md");
    for (const unit of ["refunds", "checkout-ui"]) {
      expect(readFileSync(statePath, "utf-8"))
        .toMatch(new RegExp(`^\\| ${unit} \\| [^|]* \\| \\[x\\] \\| \\[x\\] \\| \\[x\\] \\| \\[x\\] \\| \\[R\\] \\|`, "m"));
    }
    // Reopened further back after that, it goes back to the earliest stage reopened.
    const back = spawnSync("bash", ["-c", bashLine("bun .claude/tools/aidlc-jump.ts reopen --target nfr-requirements --stages " +
      "nfr-requirements,nfr-design,infrastructure-design,code-generation --units refunds --scope feature")], {
      cwd: home.dir, encoding: "utf-8", env: chat,
    });
    expect(back.status, `${back.stdout}${back.stderr}`).toBe(0);
    // checkout-ui's Code Generation, in progress, goes first; refunds' row is open again from NFR Requirements.
    const earlier = next(home.dir, chat);
    expect(earlier.kind, JSON.stringify(earlier).slice(0, 600)).toBe("run-stage");
    expect(readFileSync(statePath, "utf-8")).toMatch(/^\| refunds \| [^|]* \| \[x\] \| (?!\[x\])/m);
  });

  // A live run on Codex: payments said "yes, go back to it and fix it" in the
  // chat of its finished refunds report; the take moved the chat onto
  // u1-refunds, and the redo's own printed jump was refused by AI-DLC's hook
  // ("Run AI-DLC's command exactly as the step gives it ..."), a dead end that
  // passed only on the person's "please try again".
  test("their yes in another build's chat takes the sent-back build to Code Generation: its printed jump runs", () => {
    const session = "t-unit-push-yes-elsewhere";
    const { alice, chat } = sentBackWhileOnFinishedBuild(session);
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "anything new for us?" }).status).toBe(0);
    next(alice, chat);
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "yes, go back to it and fix it" }).status).toBe(0);
    const back = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], alice, chat);
    expect(back.json?.resumed, back.out).toBe(true);
    const jump = redoJump(alice, chat);
    const guard = jumpGuard(alice, chat, session, jump);
    expect(guard.status, guard.out).toBe(0);
    const ran = spawnSync("bash", ["-c", bashLine(jump)], { cwd: alice, encoding: "utf-8", env: chat });
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    const step = next(alice, chat);
    expect(step.kind, JSON.stringify(step).slice(0, 600)).toBe("run-stage");
    expect(step.stage).toBe("code-generation");
  });

  test("the jump still waits for the person: a word spent where it was said never stands for it", () => {
    const session = "t-unit-push-jump-spent";
    // The chat's latest word is "build checkout-ui", spent by checkout-ui's approval.
    const { alice, chat } = sentBackWhileOnFinishedBuild(session, false);
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD], alice, chat).json?.resumed).toBe(true);
    expect(jumpGuard(alice, chat, session, redoJump(alice, chat)).status).toBe(2);
  });

  test("the jump still waits for the person: another chat's word, kept beside the finished build, is that chat's", () => {
    const session = "t-unit-push-jump-other-chat";
    const { alice, chat } = sentBackWhileOnFinishedBuild(session, false);
    // Said in a second chat while the finished build is selected: kept beside it, no turn written.
    const elsewhere = "t-unit-push-jump-other-chat-2";
    expect(hook(alice, personsChat(elsewhere), { hook_event_name: "UserPromptSubmit", session_id: elsewhere, prompt: "yes, go back to it" })
      .status).toBe(0);
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD], alice, chat).json?.resumed).toBe(true);
    expect(jumpGuard(alice, chat, session, redoJump(alice, chat)).status).toBe(2);
  });

  test("the work set to run on by itself after their yes spends it; their word on the build since stands, as before", () => {
    const session = "t-unit-push-jump-autonomous";
    const { alice, record, chat } = sentBackWhileOnFinishedBuild(session);
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "yes, go back to it and fix it" }).status).toBe(0);
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD], alice, chat).json?.resumed).toBe(true);
    const jump = redoJump(alice, chat);
    appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, alice, basename(record), "payments");
    expect(jumpGuard(alice, chat, session, jump).status).toBe(2);
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "please try again" }).status).toBe(0);
    const again = jumpGuard(alice, chat, session, jump);
    expect(again.status, again.out).toBe(0);
  });
});

// refunds and checkout-ui both in checkout-api for payments: one clone builds both.
const TWO_BUILDS_PLAN = `# Unit dependencies

\`\`\`yaml
units:
  - name: refunds
    kind: service
    repos: [checkout-api, billing]
    depends_on: []
  - name: checkout-ui
    kind: ui
    repos: [checkout-api]
    depends_on: []
\`\`\`
`;
const SENT_BACK_WORDS = "it's their refund-flow test that pulls billing into checkout-api's coverage";

// Code Generation's own outputs in a Unit's build, which its push brings to the
// lead's record.
function codeGenerationOutputs(record: string, unit: string): void {
  const stage = join(record, "construction", unit, "code-generation");
  mkdirSync(stage, { recursive: true });
  for (const file of ["code-generation-plan.md", "code-summary.md", "unit-test-instructions.md"]) {
    writeFileSync(join(stage, file), `# ${file}\n\n${unit}.\n`);
  }
  writeFileSync(join(stage, "traceability.json"), `${JSON.stringify({ stage: "code-generation", unit, entries: [] })}\n`);
}

// Payments' clone builds refunds and then checkout-ui; each is pushed and
// merged, and the lead's project is at its Build and Test.
function twoMergedAtBuildAndTest() {
  const { home, hosts, alice, record } = refundsTaken(undefined, TWO_BUILDS_PLAN);
  codeGenerated(alice, record);
  codeGenerationOutputs(record, "refunds");
  finishBuild(record);
  appendAuditEntry("GATE_APPROVED", { Stage: "code-generation" }, alice, basename(record), "payments");
  expect(run(UNIT, ["push"], alice).status).toBe(0);
  mergeOnHost(hosts["checkout-api"], "refunds", "squash");
  mergeOnHost(hosts.billing, "refunds", "squash");
  git(home.dir, ["fetch", "-q", "origin"]);
  next(home.dir);
  expect(takeIn("payments", ["checkout-ui", "--home", HOME_RECORD], alice).status).toBe(0);
  const intents = join(alice, "aidlc", "spaces", "payments", "intents");
  const ui = join(intents, readdirSync(intents).find((name) => name.endsWith("-checkout-ui"))!);
  writeFileSync(join(alice, "checkout-api", "src", "ui.ts"), "export const ui = 1;\n");
  codeGenerationOutputs(ui, "checkout-ui");
  writeFileSync(join(ui, "construction", "checkout-ui", "code-generation", "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation", unit: "checkout-ui", version: 1, writes: [{ repo: "checkout-api", path: "src/ui.ts" }],
  }, null, 2)}\n`);
  finishBuild(ui);
  appendAuditEntry("GATE_APPROVED", { Stage: "code-generation" }, alice, basename(ui), "payments");
  appendAuditEntry("WORKFLOW_COMPLETED", {}, alice, basename(ui), "payments");
  expect(run(UNIT, ["push"], alice).status).toBe(0);
  mergeOnHost(hosts["checkout-api"], "checkout-ui", "squash");
  git(home.dir, ["fetch", "-q", "origin"]);
  const step = next(home.dir);
  expect(step.stage, JSON.stringify(step).slice(0, 400)).toBe("build-and-test");
  // The lead checks the record in, as the check-in line asks at this step.
  git(home.dir, ["add", "aidlc"]);
  git(home.dir, ["commit", "-q", "-m", "the teams' merges taken in"]);
  git(home.dir, ["push", "-q", "origin", "HEAD:main"]);
  return { home, hosts, alice };
}

// One chat of payments' clone builds refunds (pushed, merged, done at the
// lead's project), then checkout-ui (pushed, merged, finished); then the
// lead's Build and Test sends refunds back. The chat looked once before, at
// the person's /aidlc (`typedLook`) or on the agent's own.
function sentBackWhileOnFinishedBuild(session: string, typedLook = true) {
  const { home, hosts, alice, record } = refundsTaken(undefined, TWO_BUILDS_PLAN);
  const chat = personsChat(session);
  expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "build refunds" }).status).toBe(0);
  codeGenerated(alice, record);
  finishBuild(record);
  appendAuditEntry("GATE_APPROVED", { Stage: "code-generation" }, alice, basename(record), "payments");
  expect(run(UNIT, ["push"], alice, chat).status).toBe(0);
  mergeOnHost(hosts["checkout-api"], "refunds", "squash");
  mergeOnHost(hosts.billing, "refunds", "squash");
  git(home.dir, ["fetch", "-q", "origin"]);
  next(home.dir);
  expect(takeIn("payments", ["checkout-ui", "--home", HOME_RECORD], alice, chat).status).toBe(0);
  const intents = join(alice, "aidlc", "spaces", "payments", "intents");
  const ui = join(intents, readdirSync(intents).find((name) => name.endsWith("-checkout-ui"))!);
  expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "build checkout-ui" }).status).toBe(0);
  writeFileSync(join(alice, "checkout-api", "src", "ui.ts"), "export const ui = 1;\n");
  const stage = join(ui, "construction", "checkout-ui", "code-generation");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation", unit: "checkout-ui", version: 1, writes: [{ repo: "checkout-api", path: "src/ui.ts" }],
  }, null, 2)}\n`);
  writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nThe refunds page.\n");
  finishBuild(ui);
  appendAuditEntry("GATE_APPROVED", { Stage: "code-generation" }, alice, basename(ui), "payments");
  appendAuditEntry("WORKFLOW_COMPLETED", {}, alice, basename(ui), "payments");
  expect(run(UNIT, ["push"], alice, chat).status).toBe(0);
  mergeOnHost(hosts["checkout-api"], "checkout-ui", "squash");
  git(home.dir, ["fetch", "-q", "origin"]);
  next(home.dir);
  // The chat's look at its finished build, before the lead's word.
  if (typedLook) expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "/aidlc" }).status).toBe(0);
  next(alice, chat);
  const sent = run(UNIT, ["send-back", "refunds", "--person-words", SENT_BACK_WORDS], home.dir);
  expect(sent.status, sent.out).toBe(0);
  return { home, hosts, alice, record, chat };
}

// This .git's FETCH_HEAD cannot be written while `step` runs: git's own stop in
// Codex's sandbox, which keeps the repository's .git read-only.
function withReadOnlyGit<T>(dir: string, step: () => T): T {
  const head = join(dir, ".git", "FETCH_HEAD");
  if (!existsSync(head)) writeFileSync(head, "");
  chmodSync(head, 0o444);
  chmodSync(join(dir, ".git"), 0o555);
  try {
    return step();
  } finally {
    chmodSync(join(dir, ".git"), 0o755);
    chmodSync(head, 0o644);
  }
}

// The redo the unit-turned-down question offers, as the agent runs it for the
// person's yes, up to the jump it prints; and the guard's verdict on that jump
// as the agent runs it, from the project's own tool tree.
function redoJump(alice: string, chat: NodeJS.ProcessEnv): string {
  const ask = next(alice, chat);
  expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-turned-down");
  const redo = run(ORCH, ["report", "--result", "resumed", "--choice", "redo", "--target", "code-generation"], alice, chat);
  const jump = /`(bun \S+aidlc-jump\.ts execute [^`]+)`/.exec(String(redo.json?.message))?.[1];
  expect(jump, redo.out).toBeDefined();
  cpSync(AIDLC_SRC, join(alice, ".claude"), { recursive: true });
  return jump!;
}

function jumpGuard(alice: string, chat: NodeJS.ProcessEnv, session: string, jump: string): { status: number; out: string } {
  return hook(alice, chat, { hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", tool_input: { command: jump } });
}

// The lead's call on a live run: the lead sent a team's Unit back while that
// team's chat was on another of its builds, and "any news from the lead?"
// heard nothing; the lead's words reached only the build they were about.
describe("a team hears the lead's turn-down from any chat on its work", () => {
  test("on another of its builds, the turn-down of its Unit is said once, with how to go back to that build", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    // Its chat moves to its other Unit.
    expect(takeIn("payments", ["checkout-ui", "--home", HOME_RECORD], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"], home.dir).status).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    const chat = personsChat("alice-chat");
    const step = personsNext(alice, chat, "alice-chat");
    const line = 'refunds was turned down in billing by the lead: "needs the ledger entry". Its build is waiting for you; say so to go back to it.';
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 600)).toContain(line);
    expect(String(step.change_notices_note)).toContain(`take refunds --home ${HOME_RECORD}`);
    expect((personsNext(alice, chat, "alice-chat").change_notices ?? []) as string[]).not.toContain(line);
  });

  // Live runs on Kiro IDE and Codex: in the chat of the team's finished build,
  // the first "anything new for us?" heard nothing; only a second ask heard
  // that the lead's Build and Test sent refunds back.
  const sentBack = `refunds was sent back from the lead's Build and Test: "${SENT_BACK_WORDS}". Its build is waiting for you; ` +
    "say so to go back to it.";

  test("in a finished build's chat, their first bare /aidlc hears the send-back of another build, once", () => {
    const session = "t-unit-push-finished-bare";
    const { alice, chat } = sentBackWhileOnFinishedBuild(session);
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "anything new for us?" }).status).toBe(0);
    const step = next(alice, chat);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 900)).toContain(sentBack);
    expect(String(step.change_notices_note)).toContain(`take refunds --home ${HOME_RECORD}`);
    expect((next(alice, chat).change_notices ?? []) as string[]).not.toContain(sentBack);
  });

  test("their first words hear it too, after a look this .git could not write stopped once for write access", () => {
    const session = "t-unit-push-finished-words";
    const { alice, chat } = sentBackWhileOnFinishedBuild(session);
    const words = "anything new for payments?";
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: words }).status).toBe(0);
    // Codex's sandbox: the step stops with the way on, once.
    const stopped = withReadOnlyGit(alice, () => run(ORCH, ["next", words], alice, chat));
    expect(stopped.status, stopped.out).not.toBe(0);
    expect(String(stopped.json?.error), stopped.out).toContain("Run the same command again with write access");
    // The same command with write access looks again and hears it.
    const again = run(ORCH, ["next", words], alice, chat);
    expect(again.status, again.out).toBe(0);
    expect((again.json?.change_notices ?? []) as string[], again.out.slice(0, 900)).toContain(sentBack);
  });

  test("a look this .git still cannot write after its one stop goes on, never a second stop", () => {
    const session = "t-unit-push-finished-refused";
    const { alice, chat } = sentBackWhileOnFinishedBuild(session);
    const words = "anything new for payments?";
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: words }).status).toBe(0);
    const [first, second, third] = withReadOnlyGit(alice, () => [1, 2, 3].map(() => run(ORCH, ["next", words], alice, chat)));
    expect(first.status, first.out).not.toBe(0);
    expect(second.status, second.out).toBe(0);
    expect(third.status, third.out).toBe(0);
  });
});
