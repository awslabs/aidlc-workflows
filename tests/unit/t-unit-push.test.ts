// covers: subcommand:aidlc-unit:push, subcommand:aidlc-unit:turned-down, subcommand:aidlc-unit:merged, audit:UNIT_PUSHED, audit:UNIT_MERGED, function:checkTeamResults, function:renderUnitBoard, function:teamsAcrossReposLine, function:homeResultsPastUnitStages
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
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { hooksHealthReadDir, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
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
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");

afterEach(cleanupTeamBuild);

describe("teams build Units across repos when the workspace is in git", () => {
  test("choosing teams on work across repos goes through, and the home asks who builds which Unit", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    expect(next(home.dir).ask_type).toBe("unit-assignment");
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
        "checkout-api and billing; your other changes are still yours, uncommitted. Switch back to main any time.",
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

  test("a file that held their own uncommitted change when the Unit was taken: only the Unit's change goes, theirs stays theirs", () => {
    const { hosts, alice, record } = refundsTaken(undefined, (dir) => {
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
    const { hosts, alice, record } = refundsTaken();
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
    finishBuild(record);
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    expect(String(ask.question)).toContain("It changed checkout-api and billing.");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toStartWith("Pushed branch refunds in checkout-api and billing.");
    expect(git(hosts["checkout-api"], ["show", "refunds:src/refunds.ts"])).toBe("export const refunds = 1;");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
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
    expect(help.out).toContain("Usage: aidlc-unit push [--branch <name>]");
    for (const repo of ["checkout-api", "billing"]) {
      expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: join(alice, repo) }).status).not.toBe(0);
      expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: hosts[repo as "billing"] }).status).not.toBe(0);
      expect(git(join(alice, repo), ["branch", "--show-current"])).toBe("main");
    }
    expect((claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { result?: unknown }).result).toBeUndefined();
    const rebase = run(UNIT, ["rebase", "-h"], alice);
    expect(rebase.status, rebase.out).toBe(0);
    expect(rebase.out).toContain("Usage: aidlc-unit rebase");
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
    expect(String(pushed.json?.notice)).toContain("The home did not take refunds's result:");
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Unit Push**: unsent");
    const again = next(alice);
    expect(again.ask_type, JSON.stringify(again)).toBe("unit-push");
    expect(again.question).toBe("Refunds is pushed, but the home did not take its result just now. Do you want me to send it again?");
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Unit Push**: pushed");
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

  test("a Unit that changed a repo the home's plan did not list: it is added once, said once, and goes home with the push", () => {
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
      "ledger was not in the home's plan; refunds changed it, so it is now among refunds's repos and went with the push.",
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
      "Refunds is built and you approved it. It changed checkout-api and billing. Commit its changes on branch " +
        "refunds in each and push them?",
    );
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Push", "Not now"]);
    expect(choices[1].command).toEndWith("aidlc-unit.ts push --later");
    const later = run(UNIT, ["push", "--later"], alice);
    expect(later.status, later.out).toBe(0);
    expect(later.json?.notice).toBe("Nothing is pushed. I'll push refunds when you want it to go home.");
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
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
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
    expect((seen.change_notices ?? []) as string[]).toContain("I've told the teams checkout-api merged refunds.");
    const written = git(home.remote, ["rev-parse", ref]);
    const after = next(home.dir);
    expect(git(home.remote, ["rev-parse", ref])).toBe(written);
    expect(JSON.stringify(after.change_notices ?? [])).not.toContain("I've told the teams");
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
      "- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)",
      "- checkout-ui, web: held for web, not taken yet",
      "- reporting, here: waits on refunds",
    ].join("\n"));
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    expect(String(next(home.dir).narration)).toContain(
      "- refunds, payments: checkout-api merged, billing not merged yet (1 of 2 merged)",
    );
    mergeOnHost(hosts.billing, "refunds", "merge");
    const after = next(home.dir);
    const merged = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged).toHaveLength(1);
    expect(merged[0].block).toContain("**Built By**: alice");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    expect(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds", "code-generation", "code-summary.md"), "utf-8"))
      .toBe("# Code summary\n\nRefunds.\n");
    // reporting waited on refunds and is the home's to build now, as the home's own work.
    expect(after.kind, JSON.stringify(after)).toBe("run-stage");
    expect(after.unit).toBe("reporting");
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
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("reporting");
    expect(readAuditShardEvents(laptop).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    expect(readFileSync(join(laptop, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds", "code-generation", "code-summary.md"), "utf-8"))
      .toBe("# Code summary\n\nRefunds.\n");
  });

  test("what a team sent shows at the home's next step, with no fetch by the lead", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(String(next(home.dir).narration)).toContain(
      "- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)",
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
    expect(String(step.narration)).toContain("- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)");
    expect((step.change_notices ?? []) as string[]).toEqual([
      "origin could not be reached just now, so the board may be behind: it shows what your last fetch brought.",
    ]);
  });

  test("a turn-down reaches the team at its next step, with no fetch by the team, in its own workspace repo too", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
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
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD], alice).status).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    codeGenerated(alice, join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!));
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir).status).toBe(0);
    expect((next(alice).change_notices ?? []) as string[]).toContain(
      'refunds was turned down in billing at the home: "billing needs the ledger entry too".',
    );
  });

  test("code a team merged into the workspace itself is the work's own: the home never asks whether it is existing code", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
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
    // The source list's own check refuses it (its reason, whole), with the way back.
    expect(said, pushed.out).toStartWith("refunds's Code Generation record names what it wrote in a way its repos do not have (");
    expect(said).toContain("src/refunds.ts");
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
    expect(said, pushed.out).toStartWith("refunds's Code Generation record names what it wrote in a way its repos do not have (");
    expect(said).toContain("checkout-api/src/refunds.ts");
    expect(said).toEndWith(" report --result resumed --choice redo --target code-generation` and follow what it returns.");
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/refunds"], { cwd: hosts["checkout-api"] }).status).not.toBe(0);
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
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "t-unit-push-past-unit-stages" };
    const step = next(home.dir, chat);
    const said = ((step.change_notices ?? []) as string[]).filter((line) => line.startsWith("refunds (from payments) is back but not recorded yet"));
    expect(said, JSON.stringify(step)).toEqual([
      "refunds (from payments) is back but not recorded yet: main skipped the Unit stages (functional-design to " +
        "code-generation) when it moved on to build-and-test, so there is nothing on main to record the Unit in. " +
        "This work takes it in once it is back on functional-design, and going back starts the Unit stages again here.",
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

  test("the board names the agent's commands for the lead's words: a repo turned it down, or merged it where the check cannot see", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const board = next(home.dir);
    expect(board.kind).toBe("print");
    expect(String(board.board_note)).toContain("aidlc-unit.ts turned-down <unit> --repo <repo> --request-file aidlc/.aidlc-request-text/unit-turned-down.txt");
    expect(String(board.board_note)).toContain("aidlc-unit.ts merged <unit> --repo <repo> --request-file aidlc/.aidlc-request-text/unit-merged.txt");
  });

  test("the lead's word that a repo merged where the check cannot see: kept in their words, and the Unit is done", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    expect(String(next(home.dir).narration)).toContain("checkout-api merged, billing not merged yet (1 of 2 merged)");
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "billing merged it by hand last night"], home.dir);
    expect(said.status, said.out).toBe(0);
    expect(said.json?.notice).toBe("billing counts as merged for refunds, in your words.");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    const merged = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged[0]?.block).toContain('billing (by your word: "billing merged it by hand last night")');
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
      'refunds was turned down in billing at the home: "billing needs the ledger entry too".',
    );
    expect(step.ask_type, JSON.stringify(step)).toBe("unit-turned-down");
    // Not now: it reads as not finished, and the question is not put again; the agent keeps the offer.
    const later = personsNext(alice, chat, "t-unit-push-waits");
    expect(later.kind, JSON.stringify(later)).toBe("print");
    const offers = later.offers as Array<{ question: string; choices: Array<{ label: string; command?: string }> }>;
    expect(offers[0].question).toBe(
      "refunds is not finished: it was turned down at the home and waits for your change and a new push. " +
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
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
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
  });

  test("a turn-down at the home reaches the team once, in the home's words", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry too"], home.dir);
    expect(down.status, down.out).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    const line = 'refunds was turned down in billing at the home: "billing needs the ledger entry too".';
    expect((next(alice).change_notices ?? []) as string[]).toContain(line);
  });
});

// The lead's call on a live run: Build and Test at the lead's project failed on
// a Unit a team built; its retry reopened that Unit's Code Generation at the
// lead's project, where nothing of it is built, and the board still said done.
describe("a team's done Unit that the lead's Build and Test sends back", () => {
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
    // The retry for refunds sends it back to payments; nothing of it is reopened here.
    const retry = next(home.dir, undefined, ["--stage", "code-generation", "--unit", "refunds"]);
    expect(String(retry.message), JSON.stringify(retry)).toContain("send-back refunds --request-file");
    expect(String(retry.message)).not.toContain("reopen --target");
    const words = "checkout-api sends no CORS headers for the web page";
    const sent = run(UNIT, ["send-back", "refunds", "--person-words", words], home.dir);
    expect(sent.status, sent.out).toBe(0);
    expect(sent.json?.notice).toBe("Sent refunds back to the payments team with your words. It waits for them here; nothing of it is rebuilt here.");
    const claim = claimPayload(home.remote, id8, "refunds") as Record<string, unknown>;
    expect(claim.done).toBeUndefined();
    expect(claim.result).toBeUndefined();
    // Nothing of it is built here: the board says it was sent back, never a turn-down in no repo.
    const board = String(next(home.dir).narration ?? "");
    expect(board).not.toContain("refunds, payments: done");
    expect(board, board).toContain("- refunds, payments: sent back from your Build and Test, back with payments");
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
});

// The lead's call on a live run: the lead sent a team's Unit back while that
// team's chat was on another of its builds, and "any news from the lead?"
// heard nothing; the lead's words reached only the build they were about.
describe("a team hears the lead's turn-down from any chat on its work", () => {
  test("on another of its builds, the turn-down of its Unit is said once, with how to go back to that build", () => {
    const { home, alice, record } = refundsTaken(["refunds=payments", "checkout-ui=payments"]);
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    // Its chat moves to its other Unit.
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"], home.dir).status).toBe(0);
    git(alice, ["fetch", "-q", "origin"]);
    const chat = personsChat("alice-chat");
    const step = personsNext(alice, chat, "alice-chat");
    const line = 'refunds was turned down in billing at the home: "needs the ledger entry". Its build is waiting for you; say so to go back to it.';
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 600)).toContain(line);
    expect(String(step.change_notices_note)).toContain(`take refunds --home ${HOME_RECORD}`);
    expect((personsNext(alice, chat, "alice-chat").change_notices ?? []) as string[]).not.toContain(line);
  });
});
