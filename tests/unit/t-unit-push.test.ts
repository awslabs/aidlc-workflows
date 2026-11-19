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
//
// The home's side is in t-unit-push-home, the workspace's own repository in
// t-unit-push-own-repo.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeGeneratedAgain,
  codeHost,
  ENV,
  git,
  makeHome,
  next,
  ORCH,
  finishBuild,
  recordAt,
  recordHost,
  refundsTakenInClone,
  run,
  tellsWhatToType,
  STATE,
  tempDir,
  UNIT,
  UTILITY,
  takeIn,
  commitMessage,
  commitMessageFile,
  expectDraftStep,
  TICKET_HOOK_WORDS,
  TICKET_RULE_WORDS,
  ticketKeyHook,
  ticketKeyRule,
  sharePlan,
  planFrom,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
// AI-DLC never says what a teammate sees: a team's record in aidlc/ is the team's to share.
const TEAMMATES_SEE = "teammates see where this work stands";

afterEach(cleanupTeamBuild);

// A host's post-receive hook, printing to the person through git as hosts do.
// Printed with echo: a host's address can hold % signs.
function hostPrints(host: string, script: string): void {
  const hook = join(host, "hooks", "post-receive");
  writeFileSync(hook, `#!/bin/sh\nexec 1>&2\n${script}`);
  chmodSync(hook, 0o755);
}

// What GitHub prints after a push: its pull request block for a branch the push
// created and, for a repo whose default branch has alerts, its Dependabot block
// on every push.
function printsLikeGitHub(host: string, repo: string, alerts = false): void {
  hostPrints(host, `while read old new ref; do
  b=\${ref#refs/heads/}
  case "$old" in *[!0]*) continue;; esac
  echo ""
  echo "Create a pull request for '$b' on GitHub by visiting:"
  echo "     https://github.com/owner/${repo}/pull/new/$b"
  echo ""
done
${alerts ? `echo ""
echo "GitHub found 2 vulnerabilities on owner/${repo}'s default branch (1 high, 1 moderate). To find out more, visit:"
echo "     https://github.com/owner/${repo}/security/dependabot"
echo ""
` : ""}`);
}

// What GitLab prints after a push of a branch: the link to create its merge
// request, its branch %2F-encoded in the address, and once one is open (here,
// after the first push) the link to view it.
function printsLikeGitLab(host: string, repo: string): void {
  hostPrints(host, `while read old new ref; do
  b=\${ref#refs/heads/}
  enc=$(printf '%s' "$b" | sed 's#/#%2F#g')
  echo ""
  case "$old" in
    *[!0]*)
      echo "View merge request for $b:"
      echo "  https://gitlab.example.invalid/team/${repo}/-/merge_requests/12";;
    *)
      echo "To create a merge request for $b, visit:"
      echo "  https://gitlab.example.invalid/team/${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=$enc";;
  esac
  echo ""
done
`);
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
    expect(String(step.question)).toStartWith("Do you want me to share the plan? I'd put it in checkout-api:");
  });
});

describe("the push", () => {
  test("commits only the Unit's files on its branch in each repo, pushes them, and sends the result home", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    // Their own work in progress in checkout-api stays theirs.
    writeFileSync(join(alice, "checkout-api", "README.md"), "# checkout-api\n\nmy notes\n");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice).toBe(
      "Pushed branch refunds in checkout-api and billing. Get it merged your usual way. You're on refunds now in " +
        "checkout-api and billing; your other changes are still yours, uncommitted. Switch back to main any time.",
    );
    expect(git(hosts["checkout-api"], ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toEqual(["README.md", "src/refunds.ts"]);
    // On the Unit's branch, as their own hands would put them; their note came along, uncommitted.
    expect(git(join(alice, "checkout-api"), ["branch", "--show-current"])).toBe("refunds");
    expect(git(join(alice, "checkout-api"), ["status", "--porcelain"])).toBe("M README.md");
    expect(git(join(alice, "checkout-api"), ["show", "-s", "--format=%an", "refunds"])).toBe("alice");
    const claim = recordAt(home, "refunds")?.json as {
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

  // A git on PATH that cannot list a commit's files, as a commit unreadable
  // here would leave it (a shell script, so not on Windows).
  test.skipIf(process.platform === "win32")("git cannot list the files of the commit it pushed: no result is sent, the push's own end follows, and a push again sends it", () => {
    const { home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    const bin = tempDir("unlisting-git");
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
    writeFileSync(join(bin, "git"), "#!/bin/sh\nif [ \"$1\" = ls-tree ] && [ \"$2\" = -r ] && [ \"$3\" = --full-tree ]; then " +
      `echo "fatal: not a tree object" >&2; exit 128; fi\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const pushed = run(UNIT, ["push"], alice, { ...ENV, PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(pushed.status, pushed.out).toBe(0);
    const unlisted = (repo: string): string => `Pushed branch refunds in ${repo}, but git could not list the files of that commit ` +
      '(git says "fatal: not a tree object"), so refunds\'s result is not sent. Say when to send it again.';
    expect(pushed.json?.notice).toBe(`${unlisted("checkout-api")} ${unlisted("billing")} Get it merged your usual way. ` +
      "You're on refunds now in checkout-api and billing. Switch back to main any time.");
    expect((recordAt(home, "refunds")?.json as { result?: unknown } | undefined)?.result).toBeUndefined();
    expect(JSON.stringify(next(alice))).not.toContain("Its last push did not go through.");
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    const claim = recordAt(home, "refunds")?.json as { result: { repos: Array<{ paths: Record<string, string | null> }> } };
    expect(Object.values(claim.result.repos[0].paths).every((blob) => blob !== null)).toBe(true);
  });

  // A live run (Claude Code, Windows Server): the agent ran next at once after
  // the push and put the next question with none of the push's lines.
  test("from a chat, the push's lines ride the step that follows, said once", () => {
    const { alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "push-chat" };
    const pushed = run(UNIT, ["push"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice, pushed.out).toBeUndefined();
    const step = next(alice, chat);
    const said = ((step.change_notices ?? []) as string[]).join(" ");
    expect(said, JSON.stringify(step).slice(0, 800)).toContain("Pushed branch refunds in checkout-api and billing.");
    expect(said).not.toContain(TEAMMATES_SEE);
    expect(JSON.stringify(next(alice, chat))).not.toContain("Pushed branch refunds");
  });

  test("a file that held their own uncommitted change when the Unit was taken: only the Unit's change goes, theirs stays theirs", () => {
    const { hosts, alice, record } = refundsTakenInClone((dir) => {
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
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    const hooks = join(alice, "billing", ".git", "hooks");
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'lint: lib/refund.ts needs a header' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    const stopped = run(UNIT, ["push"], alice);
    expect(stopped.status).not.toBe(0);
    expect(String(stopped.json?.error)).toStartWith("The commit in billing did not go through: lint: lib/refund.ts needs a header. ");
    // checkout-api came first and was not pushed either; the line says where they are.
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/refunds"], { cwd: hosts["checkout-api"] }).status).not.toBe(0);
    expect(String(stopped.json?.error)).toEndWith(
      "Nothing was pushed. You're on refunds now in checkout-api and billing. Switch back to main any time. " +
        "If it is the commit message, tell me the one to use, and I will commit with it and push again.",
    );
    // Their commit-msg hook shapes the message, as it would for their own commit.
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(hooks, "commit-msg"), "#!/bin/sh\nprintf 'REF-1 %s' \"$(cat \"$1\")\" > \"$1\"\n");
    chmodSync(join(hooks, "commit-msg"), 0o755);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(git(hosts.billing, ["log", "-1", "--format=%s", "refunds"])).toStartWith("REF-1 refunds: ");
  });

  test("the Unit's branch starts from the shared integration branch, so their own unpushed commits stay on their branch", () => {
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone();
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
    expect(finish?.command, JSON.stringify(asked.choices)).toEndWith(`aidlc-unit.ts push --finish-merge --commit-message-file ${commitMessageFile(record)}`);
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
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone();
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
      "billing is in the middle of a merge, so nothing was committed or pushed. Finish it (git commit) or take it back out " +
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
    const { hosts, home, alice, record } = refundsTakenInClone();
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
    const tip = git(recordHost(home), ["rev-parse", `refs/aidlc/claims/${fixtureIntentId8(home.dir)}/refunds`]).trim();
    const sent = JSON.parse(git(recordHost(home), ["show", `${tip}:result/construction/refunds/code-generation/traceability.json`])) as typeof table;
    expect(sent.coverage.map((entry) => entry.target)).toEqual(["checkout-api/src/refunds.ts", "billing/lib/refund.ts"]);
    expect(readFileSync(join(stage, "traceability.json"), "utf-8")).toContain(".aidlc-worktrees/refunds/checkout-api/src/refunds.ts");
  });

  test("the build wrote a file their .gitignore leaves out: the push leaves it out too, says so once, and pushes the rest", () => {
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone((alice) => {
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
    const plan = sharePlan(home);
    const alice = cloneOf(home.remote, "alice");
    for (const name of ["checkout-api", "billing"]) cloneCode(hosts[name as "billing"], join(alice, ".."), `${name}-mine`, "alice");
    writeFileSync(join(alice, "aidlc", "repos.local.json"), `${JSON.stringify({ repos: [
      { name: "checkout-api", path: "../checkout-api-mine" },
      { name: "billing", path: "../billing-mine" },
    ] })}\n`);
    expect(takeIn("payments", ["refunds", ...planFrom(plan)], alice).status).toBe(0);
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
    const tip = git(recordHost(plan), ["rev-parse", `refs/aidlc/claims/${plan.id8}/refunds`]).trim();
    const sent = JSON.parse(git(recordHost(plan), ["show", `${tip}:result/construction/refunds/code-generation/traceability.json`])) as typeof table;
    expect(sent.coverage.map((entry) => entry.target)).toEqual(["checkout-api/src/refunds.ts", "billing/lib/refund.ts"]);
    expect(readFileSync(join(stage, "traceability.json"), "utf-8")).toContain("../checkout-api-mine/src/refunds.ts");
  });

  test("a team whose branch names must start with feature/: push --branch takes their name, and every later use keeps it", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
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
    const claim = recordAt(home, "refunds")?.json as { result: { repos: Array<{ branch: string }> } };
    expect(claim.result.repos.map((repo) => repo.branch)).toEqual(["feature/refunds", "feature/refunds"]);
    // A later push, with the Unit's files changed again, keeps their name.
    writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 2;\n");
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toStartWith("Pushed branch feature/refunds in");
    expect(git(hosts.billing, ["show", "feature/refunds:lib/refund.ts"])).toBe("export const refund = 2;");
  });

  test("the push question names the branch the person gave", () => {
    const { alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace("## Runtime State\n", "## Runtime State\n- **Unit Branch**: feature/refunds\n"));
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    expect(String(ask.question)).toContain("Commit its changes on branch feature/refunds in each and push them, with this commit message?");
  });

  test("push --help and rebase --help print their usage and change nothing", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    const help = run(UNIT, ["push", "--help"], alice);
    expect(help.status, help.out).toBe(0);
    expect(help.out).toContain("unit push [--branch <name>]");
    for (const repo of ["checkout-api", "billing"]) {
      expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: join(alice, repo) }).status).not.toBe(0);
      expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: hosts[repo as "billing"] }).status).not.toBe(0);
      expect(git(join(alice, repo), ["branch", "--show-current"])).toBe("main");
    }
    expect((recordAt(home, "refunds")?.json as { result?: unknown }).result).toBeUndefined();
    const rebase = run(UNIT, ["rebase", "-h"], alice);
    expect(rebase.status, rebase.out).toBe(0);
    expect(rebase.out).toContain("unit rebase");
  });

  test("a repo whose git signs its commits gets a signed Unit commit", () => {
    const { hosts, alice, record } = refundsTakenInClone();
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

  test("a result a rule of the lead's host refuses: said once in its words, not offered again in that chat, and sent once it is let through", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    // refunds's record is in checkout-api, whose host refuses records by a rule.
    const hook = join(hosts["checkout-api"], "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/aidlc/claims/*|refs/heads/aidlc/claims/*) echo 'claims are closed today' >&2; exit 1;; esac; done\n");
    chmodSync(hook, 0o755);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-push" };
    const pushed = run(UNIT, ["push"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      "checkout-api did not take the result of refunds: claims are closed today (pre-receive hook declined). A rule on its host " +
        "refuses it: ask whoever owns checkout-api to let your pushes to refs/aidlc/claims/ or to branches under aidlc/claims/ through, " +
        "then ask me to send it again.",
    );
    expect(String(pushed.json?.notice)).not.toContain("Do you want me to send it again?");
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Unit Push**: unsent");
    const after = next(alice, chat);
    expect(after.ask_type ?? null, JSON.stringify(after)).not.toBe("unit-push");
    expect(JSON.stringify(after)).not.toContain("has not taken the result of refunds yet");
    // The words-only step there does not promise a push question next.
    const words = next(alice, chat, ["--resume", "where were we?"]);
    expect(String(words.message)).not.toContain("its push is the next step");
    // Its take is recorded there, so a chat that made no push is asked, as before.
    const again = next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-other" });
    expect(again.ask_type, JSON.stringify(again)).toBe("unit-push");
    expect(again.question).toBe("refunds is pushed, but checkout-api did not take its result just now. Do you want me to send it again?");
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    expect(run(UNIT, ["push"], alice, chat).status).toBe(0);
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Unit Push**: pushed");
  });

  test("a result the lead's project could not be reached for, while the code went: offered again at the next step, as ever", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    // refunds's record's repository, checkout-api, goes away while billing's code is pushed, and comes back after.
    const api = hosts["checkout-api"];
    const away = `${api}.away`;
    const hook = join(hosts.billing, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\n[ -d '${api}' ] && mv '${api}' '${away}'\nexit 0\n`);
    chmodSync(hook, 0o755);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-offline" };
    const pushed = run(UNIT, ["push"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(existsSync(away), pushed.out).toBe(true);
    renameSync(away, api);
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    expect(String(pushed.json?.notice)).toContain("checkout-api did not take refunds's result:");
    expect(String(pushed.json?.notice)).toContain("Do you want me to send it again?");
    const again = next(alice, chat);
    expect(again.ask_type, JSON.stringify(again)).toBe("unit-push");
    expect(run(UNIT, ["push"], alice, chat).status).toBe(0);
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Unit Push**: pushed");
  });

  // The record a take wrote was taken away by hand: the push records the take
  // again before its result, as for a take its repository did not take then.
  test("a push when the Unit's record is not there now: its code goes, and the take and its result are written there again", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    git(hosts["checkout-api"], ["update-ref", "-d", `refs/aidlc/claims/${fixtureIntentId8(home.dir)}/refunds`]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["rev-parse", "--verify", "refunds"])).toMatch(/^[0-9a-f]{40}/);
    expect(recordAt(home, "refunds")?.json).toMatchObject({ status: "claimed", taken_by: "alice" });
    expect(recordAt(home, "refunds")?.json.result).toBeDefined();
    expect(existsSync(join(alice, "aidlc", "handoff")), "no result file is written").toBe(false);
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Unit Push**: pushed");
  });

  test("a push after a turn-down keeps the lead's word that a repo merged only where that repo's head did not change", () => {
    const { home, alice, record } = refundsTakenInClone();
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
    const claim = recordAt(home, "refunds")?.json as Record<string, unknown>;
    expect(claim.said_merged).toBeUndefined();
    expect(claim.turned_down).toBeUndefined();
  });

  test("a Unit that changed a repo the lead's plan did not list: it is added once, said once, and goes home with the push", () => {
    const { alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    const hook = join(hosts.billing, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'branch protection: refunds needs a ticket' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status).not.toBe(0);
    expect(String(pushed.json?.error)).toBe(
      "The push of refunds in billing was refused: branch protection: refunds needs a ticket (pre-receive hook declined). " +
        "Nothing was retried. You're on refunds now in checkout-api and billing. Switch back to main any time. " +
        "If it is the commit message, tell me the one to use, and I will commit with it and push again.",
    );
  });

  // After a plain git push the host's own lines give the person the link to
  // open the review; the push line keeps them, each repo with its own, and what
  // follows an address starts on a new line, so nothing is read as part of it.
  test("the host's own link after a push comes with the push line, each repo with its own, and a later push reads as today", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    printsLikeGitHub(hosts["checkout-api"], "checkout-api", true);
    printsLikeGitHub(hosts.billing, "billing");
    printsLikeGitHub(home.remote, "workspace");
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const notice = String(pushed.json?.notice);
    expect(notice).toStartWith(
      "Pushed branch refunds in checkout-api and billing. checkout-api's host says: Create a pull request for 'refunds' on GitHub " +
        "by visiting: https://github.com/owner/checkout-api/pull/new/refunds\nbilling's host says: Create a pull request for " +
        "'refunds' on GitHub by visiting: https://github.com/owner/billing/pull/new/refunds\n" +
        "You're on refunds now in checkout-api and billing. Switch back to main any time.",
    );
    // Not the repo's alerts, nothing of the claim's push, none of git's own lines.
    for (const absent of ["vulnerabilities", "claim/", "refs/aidlc", "-host-", "[new branch]", "set up to track"]) expect(notice).not.toContain(absent);
    // A review fix pushed again: the host prints no link about the branch now.
    codeGeneratedAgain(alice);
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toBe(
      "Pushed branch refunds in checkout-api and billing. Get it merged your usual way.",
    );
  });

  test("a branch named as its repo: the host's alert about the repo is not about the branch", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    printsLikeGitHub(hosts["checkout-api"], "checkout-api", true);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push", "--branch", "checkout-api"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const notice = String(pushed.json?.notice);
    expect(notice).toStartWith(
      "Pushed branch checkout-api in checkout-api and billing. checkout-api's host says: Create a pull request for 'checkout-api' " +
        "on GitHub by visiting: https://github.com/owner/checkout-api/pull/new/checkout-api\nGet it merged in billing your usual way.",
    );
    expect(notice).not.toContain("vulnerabilities");
  });

  test("a host that prints nothing about the branch with a link: the push line reads as today", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    for (const host of [hosts["checkout-api"], hosts.billing]) {
      hostPrints(host, 'echo "Analyzing objects... (3/3) (5 ms)"\necho "Storing packfile... done (40 ms)"\necho "Storing index... done (30 ms)"\n');
    }
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice).toBe(
      "Pushed branch refunds in checkout-api and billing. Get it merged your usual way. You're on refunds now in " +
        "checkout-api and billing. Switch back to main any time.",
    );
  });

  test("the push again after one repo's host refused it: the link for the repo it pushed now, and the way to get it merged for the other", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    printsLikeGitHub(hosts["checkout-api"], "checkout-api");
    printsLikeGitHub(hosts.billing, "billing");
    const refuse = join(hosts.billing, "hooks", "pre-receive");
    writeFileSync(refuse, "#!/bin/sh\necho 'billing is closed today' >&2\nexit 1\n");
    chmodSync(refuse, 0o755);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).not.toBe(0);
    writeFileSync(refuse, "#!/bin/sh\nexit 0\n");
    // checkout-api went the first time, so its host has nothing new to say.
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(again.json?.notice).toBe(
      "Pushed branch refunds in checkout-api and billing. billing's host says: Create a pull request for 'refunds' on GitHub by " +
        `visiting: https://github.com/owner/billing/pull/new/refunds\nGet it merged in checkout-api your usual way.`,
    );
  });

  // GitLab says "merge request" in its own words; nothing decides which host it is.
  test("on GitLab the person reads the host's merge request words and no PR, from a chat and on a later push", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    printsLikeGitLab(hosts["checkout-api"], "checkout-api");
    codeGenerated(alice, record);
    writeFileSync(join(record, "construction", "refunds", "code-generation", "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation",
      unit: "refunds",
      version: 1,
      writes: [{ repo: "checkout-api", path: "src/refunds.ts" }],
    }, null, 2)}\n`);
    finishBuild(record);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "gitlab-chat" };
    const pushed = run(UNIT, ["push", "--branch", "feature/refunds"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    const said = ((next(alice, chat).change_notices ?? []) as string[]).find((line) => line.startsWith("Pushed branch")) ?? "";
    expect(said).toBe(
      "Pushed branch feature/refunds in checkout-api. Its host says: To create a merge request for feature/refunds, visit: " +
        "https://gitlab.example.invalid/team/checkout-api/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Frefunds\n" +
        `You're on feature/refunds now in checkout-api. Switch back to main any time.`,
    );
    expect(said).not.toMatch(/\bPR\b|pull request/i);
    // A review fix pushed again, with the merge request open: GitLab's link to it.
    codeGeneratedAgain(alice);
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(again.json?.notice).toBe(
      "Pushed branch feature/refunds in checkout-api. Its host says: View merge request for feature/refunds: " +
        `https://gitlab.example.invalid/team/checkout-api/-/merge_requests/12`,
    );
  });

  // A live run on opencode: the push question was left open in one chat; in a
  // new chat "where were we?" got the words step, which never named the push,
  // and the person was asked to carry on to a next stage there is none of.
  test("words in a new chat while the push question is open: the step names the push, and going on puts it again", () => {
    const { alice, record } = refundsTakenInClone();
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
    const { hosts, home, alice, record } = refundsTakenInClone();
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
    expect(push.command).toEndWith(`aidlc-unit.ts push --branch refunds-v2 --commit-message-file ${commitMessageFile(record)}`);
    // A push that names no branch never moves it back onto the first build's.
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    expect(String(refused.json?.error)).toEndWith("push --branch refunds-v2`.");
    // A push given the message: the way on it names carries the message on.
    const withIt = run(UNIT, ["push", "--commit-message-file", commitMessageFile(record)], alice);
    expect(withIt.status, withIt.out).not.toBe(0);
    expect(String(withIt.json?.error)).toContain(`push --branch refunds-v2 --commit-message-file ${commitMessageFile(record)}\``);
    expect(git(join(alice, "billing"), ["branch", "--show-current"])).toBe("refunds-v2");
    const pushed = run(UNIT, ["push", "--branch", "refunds-v2"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds-v2:MERGED.md"])).toBe("on main since");
    expect(git(hosts.billing, ["show", "refunds-v2:lib/refund.ts"])).toBe("export const refund = 2;");
  });

  test("back on main after a push, with the Unit's files changed again: the next push carries them onto its branch, and nothing of theirs moves", () => {
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { hosts, alice, record } = refundsTakenInClone();
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
    const { home, alice, record } = refundsTakenInClone();
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
    expect(String(end.done_note)).toContain(`aidlc-unit.ts push --commit-message-file ${commitMessageFile(record)}\` and say its notice line;`);
  });

  test("a push at work that is no Unit's build says what push is for", () => {
    const { home } = refundsTakenInClone();
    const said = run(UNIT, ["push"], home.dir);
    expect(said.status).not.toBe(0);
    expect(String(said.json?.error)).toBe("push is for a Unit's build; this work is not one.");
  });

  test("the build's end offers the push; not now pushes nothing, and the end says so once", () => {
    const { alice, record } = refundsTakenInClone();
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
        "refunds in each and push them, with this commit message?\n\nrefunds: fixture",
    );
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Push", "Not now"]);
    expect(choices[1].command).toEndWith("aidlc-unit.ts push --later");
    const later = run(UNIT, ["push", "--later"], alice);
    expect(later.status, later.out).toBe(0);
    expect(later.json?.notice).toBe("Nothing is pushed. I'll push refunds when you ask.");
    expect(tellsWhatToType(ask.question, ask.choices, later.json?.notice)).toBe(false);
    const end = next(alice);
    expect(end.kind, JSON.stringify(end)).toBe("done");
    expect((end.change_notices ?? []) as string[]).toContain(
      "refunds is built and approved, and not pushed yet. Do you want me to push it now, with this commit message?\n\nrefunds: fixture",
    );
    expect(String(end.done_note)).toContain(`aidlc-unit.ts push --commit-message-file ${commitMessageFile(record)}\` and say its notice line;`);
  });
});

// A team whose commits follow a convention (a ticket key first, a sign-off
// line) commits the Unit the way it writes any commit: the push question shows
// the message the commit will carry (the agent's draft in the repo's own
// style, or today's message), and their own words replace it whole. Their hook
// or their host refusing it is said in its words with the one way on, and the
// step after it never puts the same push as if nothing happened. AI-DLC amends
// only the commit it made and could not push, never a commit of theirs.
const OWN_MESSAGE = "PAY-12 add refunds\r\n\r\nSigned-off-by: alice <alice@example.test>\r\n";
const AS_COMMITTED = "PAY-12 add refunds\n\nSigned-off-by: alice <alice@example.test>";
const WAY_ON = "If it is the commit message, tell me the one to use, and I will commit with it and push again.";
const LAST_PUSH = "Its last push did not go through.";
const UNREAD = "push --commit-message-file needs the commit message in a file directly inside " +
  "aidlc/.aidlc-engine/request-text/ in this project, written with your file tool. Nothing was committed or pushed.";
const BOTH = "refunds is built and you approved it. It changed checkout-api and billing.";
const pushBoth = (message: string, refused = false): string =>
  `${BOTH}${refused ? ` ${LAST_PUSH}` : ""} Commit its changes on branch refunds in each and push them, with this commit message?\n\n${message}`;
const wentBefore = (repo: string): string => `${repo} keeps refunds's commit as it went before, so your message is not on it there.`;
const notOurs = (repo: string): string => `${repo} keeps its last commit as it is, so your message is not on it there: it is not ` +
  "the commit AI-DLC made for refunds and could not push.";
const hookDidNotTake = (repo: string, words: string): string => `${repo} keeps refunds's commit as it was, so your message is not ` +
  `on it there: its hook did not take your message (${words}).`;
const NOT_ON_IT = "so your message is not on it there";
const hostRefused = (repo: string): string =>
  `The push of refunds in ${repo} was refused: ${TICKET_RULE_WORDS} (pre-receive hook declined). Nothing was retried.`;
const withMessage = (alice: string, record: string, text: string): string[] =>
  ["push", "--commit-message-file", commitMessage(alice, record, text)];
const onHost = (host: string): boolean =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: host }).status === 0;
const heldFile = (alice: string, record: string): string => join(alice, ...commitMessageFile(record).split("/"));
const pushCommands = (ask: Record<string, unknown>): string[] =>
  (ask.choices as Array<{ label: string; command?: string }>).filter((choice) => choice.label !== "Not now").map((choice) => String(choice.command));

// A commit-msg hook that wants Conventional Commits, as commitlint keeps it.
const CONVENTIONAL_WORDS = "commitlint: type must be one of [feat, fix]";
function conventionalHook(repo: string): void {
  const file = join(repo, ".git", "hooks", "commit-msg");
  writeFileSync(file, `#!/bin/sh\nhead -n 1 "$1" | grep -qE '^(feat|fix)(\\(.+\\))?: ' && exit 0\necho '${CONVENTIONAL_WORDS}' >&2\nexit 1\n`);
  chmodSync(file, 0o755);
}

describe("the person's own commit message", () => {
  test("with no message given, the Unit's commit carries today's message, whole, in each repo", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    for (const host of Object.values(hosts)) expect(git(host, ["log", "-1", "--format=%B", "refunds"])).toBe("refunds: fixture");
  });

  test("their commit-msg hook that wants a ticket key refuses the Unit's commit in its own words, and nothing went", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    for (const repo of Object.keys(hosts)) ticketKeyHook(join(alice, repo));
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toStartWith(`The commit in checkout-api did not go through: ${TICKET_HOOK_WORDS}. Nothing was pushed.`);
    for (const host of Object.values(hosts)) expect(onHost(host)).toBe(false);
  });

  test("their host's rule on commit messages refuses the push in its words, and the Unit's commit there went nowhere", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    ticketKeyRule(hosts.billing);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toStartWith(hostRefused("billing"));
    expect(git(hosts["checkout-api"], ["log", "-1", "--format=%s", "refunds"])).toBe("refunds: fixture");
    expect(onHost(hosts.billing)).toBe(false);
    expect(git(join(alice, "billing"), ["log", "-1", "--format=%s", "refunds"])).toBe("refunds: fixture");
  });

  test("the push question shows the message it will carry: the agent drafts it once, over today's message, and the question shows the draft as git will take it", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    // The agent's own step, said to nobody: the file holds today's message until it drafts over it.
    const draft = next(alice, ENV, [], ORCH, { stopAtDraft: true });
    const file = expectDraftStep(alice, draft);
    expect(file).toBe(commitMessageFile(record));
    expect(readFileSync(heldFile(alice, record), "utf-8").trim()).toBe("refunds: fixture");
    writeFileSync(heldFile(alice, record), "feat(refunds): add the refund handler  \r\n\r\n\r\nRefs PAY-12\r\n");
    const ask = next(alice, ENV, [], ORCH, { stopAtDraft: true });
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    expect(ask.question).toBe(pushBoth("feat(refunds): add the refund handler\n\nRefs PAY-12"));
    expect(ask.commit_message_file).toBe(file);
    for (const command of pushCommands(ask)) expect(command).toEndWith(`push --commit-message-file ${file}`);
    expect(tellsWhatToType(ask.question, ask.choices)).toBe(false);
    // Asked again, it is the same question: the draft step is given once.
    expect(next(alice, ENV, [], ORCH, { stopAtDraft: true }).question).toBe(ask.question);
    const pushed = run(UNIT, ["push", "--commit-message-file", file], alice);
    expect(pushed.status, pushed.out).toBe(0);
    for (const host of Object.values(hosts)) expect(git(host, ["log", "-1", "--format=%B", "refunds"])).toBe("feat(refunds): add the refund handler\n\nRefs PAY-12");
    expect(existsSync(heldFile(alice, record)), "the message file is spent").toBe(false);
  });

  test("their own message goes on the Unit's commit whole, from the file the agent wrote, in every repo it changed", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    for (const repo of Object.keys(hosts)) ticketKeyHook(join(alice, repo));
    const pushed = run(UNIT, withMessage(alice, record, OWN_MESSAGE), alice);
    expect(pushed.status, pushed.out).toBe(0);
    // Their ticket key and their sign-off line, as git commits any message: the CRs of a Windows file are git's to drop.
    for (const host of Object.values(hosts)) expect(git(host, ["log", "-1", "--format=%B", "refunds"])).toBe(AS_COMMITTED);
    expect(existsSync(heldFile(alice, record)), "the message file is spent").toBe(false);
  });

  test("a direct push with no message commits today's message, even with a draft there", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(next(alice).ask_type).toBe("unit-push");
    writeFileSync(heldFile(alice, record), "feat(refunds): add the refund handler\n");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    for (const host of Object.values(hosts)) expect(git(host, ["log", "-1", "--format=%B", "refunds"])).toBe("refunds: fixture");
    expect(existsSync(heldFile(alice, record)), "a push that went spends the build's message").toBe(false);
  });

  test("a read-only look writes no file and shows today's message", () => {
    const { alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    const probe = next(alice, { ...ENV, AIDLC_STOP_HOOK_PROBE: "1" }, [], ORCH, { stopAtDraft: true });
    expect(probe.ask_type, JSON.stringify(probe)).toBe("unit-push");
    expect(probe.question).toBe(pushBoth("refunds: fixture"));
    for (const command of pushCommands(probe)) expect(command).toEndWith("aidlc-unit.ts push");
    expect(existsSync(heldFile(alice, record))).toBe(false);
  });

  test("a message file that is there but empty, or a link: today's message, no flag, and no draft step", () => {
    const { alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    commitMessage(alice, record, " \n");
    const empty = next(alice, ENV, [], ORCH, { stopAtDraft: true });
    expect(empty.ask_type, JSON.stringify(empty)).toBe("unit-push");
    expect(empty.question).toBe(pushBoth("refunds: fixture"));
    for (const command of pushCommands(empty)) expect(command).toEndWith("aidlc-unit.ts push");
    if (process.platform !== "win32") {
      const elsewhere = join(tempDir("message-elsewhere"), "message.txt");
      writeFileSync(elsewhere, "feat: from outside the project\n");
      rmSync(heldFile(alice, record));
      symlinkSync(elsewhere, heldFile(alice, record));
      const linked = next(alice, ENV, [], ORCH, { stopAtDraft: true });
      expect(linked.question).toBe(pushBoth("refunds: fixture"));
      for (const command of pushCommands(linked)) expect(command).toEndWith("aidlc-unit.ts push");
    }
  });

  test("their commit-msg hook refuses the Unit's commit: the line says the way on once, the next push question says the last push did not go through, and their message goes", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    for (const repo of Object.keys(hosts)) ticketKeyHook(join(alice, repo));
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toBe(
      `The commit in checkout-api did not go through: ${TICKET_HOOK_WORDS}. Nothing was pushed. You're on refunds now in ` +
        `checkout-api. Switch back to main any time. ${WAY_ON}`,
    );
    const again = next(alice);
    expect(again.ask_type, JSON.stringify(again)).toBe("unit-push");
    expect(again.question).toBe(pushBoth("refunds: fixture", true));
    expect(String(again.question)).not.toContain("tell me the one to use");
    expect(tellsWhatToType(again.question, again.choices, refused.json?.error)).toBe(false);
    // A message their hook refuses too: the same line in the hook's words, with the same way on.
    const second = run(UNIT, withMessage(alice, record, "PAY12 add refunds\n"), alice);
    expect(second.status).not.toBe(0);
    expect(String(second.json?.error)).toBe(`The commit in checkout-api did not go through: ${TICKET_HOOK_WORDS}. Nothing was pushed. ${WAY_ON}`);
    expect(next(alice).question).toBe(pushBoth("PAY12 add refunds", true));
    const pushed = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(pushed.status, pushed.out).toBe(0);
    for (const host of Object.values(hosts)) expect(git(host, ["log", "--format=%s", "main..refunds"])).toBe("PAY-12 add refunds");
    expect(next(alice).ask_type ?? null).not.toBe("unit-push");
  });

  test("their host's rule on commit messages: their message goes on the commit AI-DLC made and could not push, a second refusal says the way on again, and what went is never rewritten", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    ticketKeyRule(hosts.billing);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toBe(
      `${hostRefused("billing")} You're on refunds now in checkout-api and billing. Switch back to main any time. ${WAY_ON}`,
    );
    const went = git(hosts["checkout-api"], ["rev-parse", "refunds"]);
    const second = run(UNIT, withMessage(alice, record, "PAY12 add refunds\n"), alice);
    expect(second.status).not.toBe(0);
    expect(String(second.json?.error)).toBe(`${hostRefused("billing")} ${WAY_ON}`);
    // AI-DLC's own commit took their message in its place, never as a second commit on top.
    expect(git(join(alice, "billing"), ["log", "--format=%s", "origin/main..refunds"])).toBe("PAY12 add refunds");
    const pushed = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"])).toBe("PAY-12 add refunds");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 1;");
    expect(git(hosts["checkout-api"], ["rev-parse", "refunds"])).toBe(went);
    expect(String(pushed.json?.notice)).toContain(wentBefore("checkout-api"));
  });

  test("their own commits that come along: the host's refusal names no way on the retry cannot keep, and their message changes nothing of theirs", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    const billing = join(alice, "billing");
    writeFileSync(join(billing, "README.md"), "# billing\n\nlocal\n");
    git(billing, ["commit", "-q", "-am", "wip: log billing calls"]);
    // Their uncommitted edit on top keeps git from starting the Unit's branch at origin/main.
    writeFileSync(join(billing, "README.md"), "# billing\n\nlocal, still editing\n");
    codeGenerated(alice, record);
    ticketKeyRule(hosts.billing);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toBe(
      `${hostRefused("billing")} You're on refunds now in checkout-api and billing. Switch back to main any time. ` +
        'Branch refunds in billing starts from where you were, so your commit not yet on origin/main comes along: "wip: log billing calls".',
    );
    const again = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(again.status).not.toBe(0);
    expect(String(again.json?.error)).toBe(hostRefused("billing"));
    expect(git(billing, ["log", "--format=%s", "origin/main..refunds"]).split("\n")).toEqual(["PAY-12 add refunds", "wip: log billing calls"]);
    expect(readFileSync(join(billing, "README.md"), "utf-8")).toBe("# billing\n\nlocal, still editing\n");
  });

  test("a commit of their own is never amended: their message, given after they committed the Unit's files themselves, leaves it as it is and says so", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    const billing = join(alice, "billing");
    writeFileSync(join(billing, ".git", "refuse-once"), "");
    writeFileSync(join(billing, ".git", "hooks", "commit-msg"),
      "#!/bin/sh\nif [ -f .git/refuse-once ]; then rm .git/refuse-once; echo 'commit messages need a ticket' >&2; exit 1; fi\nexit 0\n");
    chmodSync(join(billing, ".git", "hooks", "commit-msg"), 0o755);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).not.toBe(0);
    // Back on main, they commit the Unit's file with their own words.
    git(billing, ["switch", "-q", "main"]);
    git(billing, ["add", "lib/refund.ts"]);
    git(billing, ["commit", "-q", "-m", "REF-7 refund handler"]);
    const pushed = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"])).toBe("REF-7 refund handler");
    // checkout-api's commit is the one AI-DLC made and could not push: it takes their message.
    expect(git(hosts["checkout-api"], ["log", "--format=%s", "main..refunds"])).toBe("PAY-12 add refunds");
    expect(String(pushed.json?.notice)).toContain(notOurs("billing"));
  });

  test("a commit the person amended themselves after a refusal is theirs: never amended again", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    ticketKeyRule(hosts.billing);
    expect(run(UNIT, ["push"], alice).status).not.toBe(0);
    const billing = join(alice, "billing");
    git(billing, ["commit", "-q", "--amend", "-m", "PAY-1 my own words"]);
    const pushed = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"])).toBe("PAY-1 my own words");
    expect(String(pushed.json?.notice)).toContain(notOurs("billing"));
  });

  test("a host refusal of commits the person made by hand: the next push question says the last push did not go through", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    const billing = join(alice, "billing");
    codeGenerated(alice, record);
    finishBuild(record);
    git(billing, ["add", "lib/refund.ts"]);
    git(billing, ["commit", "-q", "-m", "refund handler, by hand"]);
    ticketKeyRule(hosts.billing);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toStartWith(hostRefused("billing"));
    expect(String(refused.json?.error)).not.toContain(WAY_ON);
    expect(String(next(alice).question)).toContain(LAST_PUSH);
  });

  test("in a single-branch clone, a commit that went is never amended, and with its remote out of reach nothing is", () => {
    const { hosts, alice, record } = refundsTakenInClone((clone) => {
      // As git clone --single-branch leaves it: a push writes no copy of the Unit's branch here.
      git(join(clone, "checkout-api"), ["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
    });
    codeGenerated(alice, record);
    ticketKeyRule(hosts.billing);
    expect(run(UNIT, ["push"], alice).status).not.toBe(0);
    const api = join(alice, "checkout-api");
    const went = git(hosts["checkout-api"], ["rev-parse", "refunds"]);
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/refunds"], { cwd: api }).status).not.toBe(0);
    // checkout-api's remote out of reach: AI-DLC cannot tell its commit went, so it is left as it is.
    const address = git(api, ["remote", "get-url", "origin"]);
    git(api, ["remote", "set-url", "origin", join(tempDir("gone"), "nowhere.git")]);
    expect(run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice).status).not.toBe(0);
    expect(git(api, ["rev-parse", "refunds"])).toBe(went);
    git(api, ["remote", "set-url", "origin", address]);
    const pushed = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts["checkout-api"], ["rev-parse", "refunds"])).toBe(went);
    expect(git(api, ["rev-parse", "refunds"])).toBe(went);
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"])).toBe("PAY-12 add refunds");
    expect(String(pushed.json?.notice)).toContain(wentBefore("checkout-api"));
  });

  test("a hook that resets inside AI-DLC's commit never makes a commit of theirs take the message", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    const billing = join(alice, "billing");
    writeFileSync(join(billing, "README.md"), "# billing\n\nlocal\n");
    git(billing, ["commit", "-q", "-am", "local readme"]);
    writeFileSync(join(billing, "README.md"), "# billing\n\nlocal, still editing\n");
    // As lint-staged does when a pre-commit check fails: it resets, then refuses.
    writeFileSync(join(billing, ".git", "refuse-once"), "");
    writeFileSync(join(billing, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nif [ -f .git/refuse-once ]; then rm .git/refuse-once; git reset -q HEAD; echo 'lint: needs a header' >&2; exit 1; fi\nexit 0\n");
    chmodSync(join(billing, ".git", "hooks", "pre-commit"), 0o755);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).not.toBe(0);
    const pushed = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"]).split("\n")).toEqual(["PAY-12 add refunds", "local readme"]);
    expect(git(hosts["checkout-api"], ["log", "--format=%s", "main..refunds"])).toBe("PAY-12 add refunds");
  });

  test("two repos with different message rules: an amend one of them refuses leaves that commit as it was, says so, and the push goes on", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    ticketKeyHook(join(alice, "checkout-api"));
    conventionalHook(join(alice, "billing"));
    expect(run(UNIT, ["push"], alice).status).not.toBe(0);
    const second = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(second.status).not.toBe(0);
    expect(String(second.json?.error)).toStartWith(`The commit in billing did not go through: ${CONVENTIONAL_WORDS}. Nothing was pushed.`);
    const pushed = run(UNIT, withMessage(alice, record, "feat: add refunds\n"), alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts["checkout-api"], ["log", "--format=%s", "main..refunds"])).toBe("PAY-12 add refunds");
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"])).toBe("feat: add refunds");
    expect(String(pushed.json?.notice)).toContain(hookDidNotTake("checkout-api", TICKET_HOOK_WORDS));
  });

  test("a newer Unit change is always committed: in the commit AI-DLC could not push, and an amend carrying it that their hook refuses stops the push", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    ticketKeyRule(hosts.billing);
    const file = String(next(alice).commit_message_file);
    expect(run(UNIT, ["push", "--commit-message-file", file], alice).status).not.toBe(0);
    const billing = join(alice, "billing");
    writeFileSync(join(billing, "lib", "refund.ts"), "export const refund = 2;\n");
    expect(run(UNIT, ["push", "--commit-message-file", file], alice).status).not.toBe(0);
    expect(git(billing, ["log", "--format=%s", "origin/main..refunds"])).toBe("refunds: fixture");
    expect(git(billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 2;");
    // Their hook now turns the same message down: the amend with the newer change stops, and nothing goes.
    ticketKeyHook(billing);
    writeFileSync(join(billing, "lib", "refund.ts"), "export const refund = 3;\n");
    const stopped = run(UNIT, ["push", "--commit-message-file", file], alice);
    expect(stopped.status).not.toBe(0);
    expect(String(stopped.json?.error)).toStartWith(`The commit in billing did not go through: ${TICKET_HOOK_WORDS}. Nothing was pushed.`);
    expect(git(billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 2;");
    expect(onHost(hosts.billing)).toBe(false);
  });

  test("a hook that reshapes the message: a plain retry neither amends again nor says the message is not on a commit", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    const billing = join(alice, "billing");
    writeFileSync(join(billing, ".git", "hooks", "commit-msg"), "#!/bin/sh\nprintf 'REF-1 %s' \"$(cat \"$1\")\" > \"$1\"\n");
    chmodSync(join(billing, ".git", "hooks", "commit-msg"), 0o755);
    writeFileSync(join(hosts.billing, "refuse-once"), "");
    writeFileSync(join(hosts.billing, "hooks", "pre-receive"),
      "#!/bin/sh\nif [ -f refuse-once ]; then rm refuse-once; echo 'pushes are paused' >&2; exit 1; fi\nexit 0\n");
    chmodSync(join(hosts.billing, "hooks", "pre-receive"), 0o755);
    const file = String(next(alice).commit_message_file);
    expect(run(UNIT, ["push", "--commit-message-file", file], alice).status).not.toBe(0);
    const made = git(billing, ["rev-parse", "refunds"]);
    expect(git(billing, ["log", "-1", "--format=%s", "refunds"])).toBe("REF-1 refunds: fixture");
    const pushed = run(UNIT, ["push", "--commit-message-file", file], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["rev-parse", "refunds"])).toBe(made);
    expect(String(pushed.json?.notice)).not.toContain(NOT_ON_IT);
  });

  test("a push again after one that went, with the same message: no line says the message is not on a commit", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    expect(run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice).status).toBe(0);
    const again = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).not.toContain(NOT_ON_IT);
    // Another message then: the commits went, so that is the line, never that they are not AI-DLC's.
    const other = run(UNIT, withMessage(alice, record, "PAY-13 other words\n"), alice);
    expect(other.status, other.out).toBe(0);
    expect(String(other.json?.notice)).toContain("checkout-api and billing keep refunds's commit as it went before, so your message is not on it there");
    expect(String(other.json?.notice)).not.toContain("it is not the commit AI-DLC made");
    for (const host of Object.values(hosts)) expect(git(host, ["log", "--format=%s", "main..refunds"])).toBe("PAY-12 add refunds");
  });

  test("a push that failed at the remote after its commit: the next push question says it did not go through, and their message amends that commit", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    const billing = join(alice, "billing");
    const address = git(billing, ["remote", "get-url", "origin"]);
    git(billing, ["remote", "set-url", "origin", join(tempDir("gone"), "nowhere.git")]);
    expect(run(UNIT, ["push"], alice).status).not.toBe(0);
    git(billing, ["remote", "set-url", "origin", address]);
    expect(String(next(alice).question)).toContain(LAST_PUSH);
    const pushed = run(UNIT, withMessage(alice, record, "PAY-12 add refunds\n"), alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(hosts.billing, ["log", "--format=%s", "main..refunds"])).toBe("PAY-12 add refunds");
  });

  test("the push question says the last push did not go through until a push goes", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    ticketKeyRule(hosts.billing);
    expect(run(UNIT, ["push"], alice).status).not.toBe(0);
    expect(String(next(alice).question)).toContain(LAST_PUSH);
    writeFileSync(join(hosts.billing, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    // The redo after a turn-down is asked as any push is: a fresh draft, no word of the refusal.
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"], home.dir).status).toBe(0);
    expect(next(alice).ask_type).toBe("unit-turned-down");
    codeGeneratedAgain(alice);
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation" }, alice, basename(record), "payments");
    const draft = next(alice, ENV, [], ORCH, { stopAtDraft: true });
    expectDraftStep(alice, draft);
    const push = next(alice);
    expect(push.ask_type, JSON.stringify(push)).toBe("unit-push");
    expect(String(push.question)).not.toContain(LAST_PUSH);
  });

  test("after Not now, the line that offers the push again shows the message it will carry, and yes pushes with it", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    expectDraftStep(alice, next(alice, ENV, [], ORCH, { stopAtDraft: true }));
    writeFileSync(heldFile(alice, record), "feat(refunds): add the refund handler\n");
    expect(next(alice).question).toBe(pushBoth("feat(refunds): add the refund handler"));
    expect(run(UNIT, ["push", "--later"], alice).status).toBe(0);
    const end = next(alice);
    expect(end.kind, JSON.stringify(end)).toBe("done");
    expect((end.change_notices ?? []) as string[]).toContain(
      "refunds is built and approved, and not pushed yet. Do you want me to push it now, with this commit message?\n\n" +
        "feat(refunds): add the refund handler",
    );
    const file = commitMessageFile(record);
    expect(String(end.done_note)).toContain(`aidlc-unit.ts push --commit-message-file ${file}\` and say its notice line;`);
    expect(String(end.done_note)).toEndWith("with your file tool, never a shell, exactly as they gave it.");
    expect(run(UNIT, ["push", "--commit-message-file", file], alice).status).toBe(0);
    for (const host of Object.values(hosts)) expect(git(host, ["log", "-1", "--format=%s", "refunds"])).toBe("feat(refunds): add the refund handler");
  });

  test("the push question names the message file for the agent, and the send-again question does not", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-push");
    expect(ask.commit_message_file).toBe(commitMessageFile(record));
    expect(String(ask.question_note)).toContain("The commit message the question shows is the one in the file commit_message_file names: " +
      "when they give their own, write it there with your file tool, never a shell, exactly as they gave it, in place of the one shown, " +
      "then run the command of the push choice they pick.");
    // The code went and the lead's project did not take the result: a message has nothing to go on.
    const claims = join(hosts["checkout-api"], "hooks", "pre-receive");
    writeFileSync(claims, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/aidlc/claims/*|refs/heads/aidlc/claims/*) echo 'claims are closed today' >&2; exit 1;; esac; done\n");
    chmodSync(claims, 0o755);
    expect(run(UNIT, ["push", "--commit-message-file", String(ask.commit_message_file)], alice).status).toBe(0);
    const again = next(alice);
    expect(again.question, JSON.stringify(again)).toBe("refunds is pushed, but checkout-api did not take its result just now. Do you want me to send it again?");
    expect(again.commit_message_file).toBeUndefined();
    expect(String(again.question_note)).not.toContain("commit_message_file");
  });

  test("a message file outside its folder, or an empty one, is refused in the flag's own words, and nothing is committed", () => {
    const { hosts, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    writeFileSync(join(alice, "message.txt"), "PAY-12 add refunds\n");
    const outside = run(UNIT, ["push", "--commit-message-file", "message.txt"], alice);
    expect(outside.status).not.toBe(0);
    expect(String(outside.json?.error)).toBe(UNREAD);
    const empty = run(UNIT, withMessage(alice, record, " \n"), alice);
    expect(empty.status).not.toBe(0);
    expect(String(empty.json?.error)).toBe(UNREAD);
    for (const repo of Object.keys(hosts)) expect(git(join(alice, repo), ["branch", "--show-current"])).toBe("main");
  });
});
