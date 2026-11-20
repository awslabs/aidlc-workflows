// covers: subcommand:aidlc-unit:push, audit:UNIT_PUSHED
//
// A Unit on the workspace's own repository, built by teams (#2410, item 5):
// its branch made at the push in that repository, its pull request read against
// the branch the work merges into, AI-DLC's record riding in it, main brought
// in, and a change to a file of AI-DLC's record put aside for that and put
// back. AI-DLC's own files (its record, its install) are never said to be the
// person's uncommitted changes, at the push or at an early start. The push in
// code repositories is in t-unit-push, the home in t-unit-push-home.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, REPO_ROOT, seededStateFile } from "../harness/fixtures.ts";
import { typedHarnessName } from "../../core/tools/aidlc-runtime-paths.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneOf,
  commitOnHost,
  ENV,
  finishBuild,
  git,
  hook,
  makeHome,
  next,
  personsChat,
  run,
  STATE,
  tempDir,
  UNIT,
  takeIn,
  commitMessage,
  squashOnHost,
  TICKET_RULE_WORDS,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
// AI-DLC never says what a teammate sees: a team's record in aidlc/ is the team's to share.
const TEAMMATES_SEE = "teammates see where this work stands";

afterEach(cleanupTeamBuild);

// Work whose code is the workspace's own repository, built by teams: each
// Unit's branch is made at the push in that repository ("."), and its pull
// request is read by the reviewer against the branch the work merges into.
describe("a Unit on the workspace's own repository", () => {
  const UNITS = "# Unit dependencies\n\n```yaml\nunits:\n" +
    "  - name: refunds\n    kind: service\n    depends_on: []\n" +
    "  - name: checkout-ui\n    kind: ui\n    depends_on: []\n" +
    "  - name: reporting\n    kind: service\n    depends_on: [refunds]\n```\n";

  // Teams chosen on the workspace's own repository, with its remote recorded
  // as the work's home, as choosing teams on a remote records it.
  function oneRepoTeams(dependencies = UNITS): ReturnType<typeof makeHome> {
    const home = makeHome({ repos: {}, dependencies });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const path = seededStateFile(home.dir);
    const state = readFileSync(path, "utf-8");
    if (!state.includes("- **Home Location**:")) {
      writeFileSync(path, state.replace("## Runtime State\n", `## Runtime State\n- **Home Location**: ${home.remote}\n`));
    }
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    // The plan shared in the workspace's own repository, the work's one repository.
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    return home;
  }
  // A take's --plan and --from for this work, whose plan is in the workspace's own repository.
  const fromHome = (home: ReturnType<typeof makeHome>): string[] => ["--plan", fixtureIntentId8(home.dir), "--from", home.remote];

  function leadCommits(home: ReturnType<typeof makeHome>, branch: string, file: string): string {
    if (git(home.dir, ["branch", "--show-current"]) !== branch) git(home.dir, ["switch", "-q", branch]);
    writeFileSync(join(home.dir, file), `${file}\n`);
    git(home.dir, ["add", "--", file]);
    git(home.dir, ["commit", "-q", "-m", `lead: ${file}`]);
    git(home.dir, ["push", "-q", "origin", branch]);
    return git(home.dir, ["rev-parse", "HEAD"]);
  }

  // The team's take of a Unit and its Code Generation, in the workspace itself; the build's record folder.
  function builtHere(dir: string, unit: string, file: string): string {
    const took = takeIn("payments", [unit, "--plan", fixtureIntentId8(dir, undefined, "default"), "--from", git(dir, ["remote", "get-url", "origin"])], dir);
    expect(took.status, took.out).toBe(0);
    const intents = join(dir, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith(`-${unit}`))!);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", file), `export const built = "${unit}";\n`);
    const stage = join(record, "construction", unit, "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit, version: 1, writes: [{ path: `src/${file}` }],
    })}\n`);
    writeFileSync(join(stage, "code-summary.md"), `# Code summary\n\n${unit}.\n`);
    return record;
  }

  // What the Unit's pull request shows: the files it changes from where it left
  // the branch it merges into, AI-DLC's record aside.
  const prFiles = (host: string, into: string, branch: string): string[] =>
    git(host, ["diff", "--name-only", `${into}...${branch}`]).split("\n").filter((path) => path !== "" && !path.startsWith("aidlc/"));

  // A squash of the Unit's branch into `into` on the host, the branch deleted after.
  function squashInto(host: string, into: string, branch: string): void {
    const dir = join(tempDir("merger"), "repo");
    git(tempDir("merger-parent"), ["clone", "-q", "--branch", into, host, dir]);
    git(dir, ["config", "user.name", "reviewer"]);
    git(dir, ["config", "user.email", "reviewer@example.test"]);
    git(dir, ["fetch", "-q", "origin", branch]);
    git(dir, ["merge", "-q", "--squash", `origin/${branch}`]);
    git(dir, ["commit", "-q", "-m", `${branch} (squashed)`]);
    git(dir, ["push", "-q", "origin", into]);
    git(host, ["branch", "-D", branch]);
  }

  test("its branch starts from the lead's main as fetched, never from the clone's own main left behind", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    // The lead's main moves on after the take read the plan.
    const leadsTip = leadCommits(home, "main", "LEAD-NOTES.md");
    expect(git(alice, ["rev-parse", "main"])).not.toBe(leadsTip);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(spawnSync("git", ["merge-base", "--is-ancestor", leadsTip, "refunds"], { cwd: home.remote }).status, pushed.out).toBe(0);
    expect(prFiles(home.remote, "main", "refunds")).toEqual(["src/refunds.ts"]);
    expect(String(pushed.json?.notice)).not.toContain("come along");
  });

  test("the next Unit's branch starts from the lead's main, never from the merged and deleted branch of the one before", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    squashInto(home.remote, "main", "refunds");
    expect(git(alice, ["branch", "--show-current"])).toBe("refunds");
    builtHere(alice, "checkout-ui", "cart.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(prFiles(home.remote, "main", "checkout-ui"), pushed.out).toEqual(["src/cart.ts"]);
    expect(git(home.remote, ["log", "--format=%s", "main..checkout-ui"])).not.toContain("refunds");
  });

  test("a clone with a commit of its own on main: the branch starts where they are, and the line names the commit that comes along", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    writeFileSync(join(alice, "MY-NOTES.md"), "mine\n");
    git(alice, ["add", "--", "MY-NOTES.md"]);
    git(alice, ["commit", "-q", "-m", "my notes"]);
    builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      'Branch refunds in the repo starts from where you were, so your commit not yet on origin/main comes along: "my notes".',
    );
    expect(prFiles(home.remote, "main", "refunds")).toEqual(["MY-NOTES.md", "src/refunds.ts"]);
  });

  test("a team whose Way of Working names develop: the branch starts from develop, and the lead's look sees it merged there", () => {
    const home = oneRepoTeams();
    const team = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(team, readFileSync(team, "utf-8").replace("## Way of Working\n", "## Way of Working\n\n- **Integration branch**: develop\n"));
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "we merge into develop"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    git(home.dir, ["switch", "-q", "-c", "develop"]);
    git(home.dir, ["push", "-q", "-u", "origin", "develop"]);
    // The lead shares the plan again, with the branch it now names.
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const developsTip = leadCommits(home, "develop", "DEVELOP-ONLY.md");
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(spawnSync("git", ["merge-base", "--is-ancestor", developsTip, "refunds"], { cwd: home.remote }).status, pushed.out).toBe(0);
    expect(prFiles(home.remote, "develop", "refunds")).toEqual(["src/refunds.ts"]);
    squashInto(home.remote, "develop", "refunds");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    // No plan is shared in this repository, so the lead's own record keeps the merge it saw.
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED").map((row) => row.block).join("\n")).toContain("refunds");
  });
  // AI-DLC's record of the build rides in the Unit's pull request: a second
  // commit after the Unit's code, AI-DLC's own message, or the person's own
  // with its first line marked as the record, so a rule their code commit
  // meets the record meets too.
  const recordWent = (unit: string): string =>
    `AI-DLC's record of ${unit} went with it, in a commit of its own.`;
  const committed = (host: string, rev: string): string[] =>
    git(host, ["diff-tree", "-r", "--no-commit-id", "--name-only", rev]).split("\n").filter(Boolean);

  // Main moved under a Unit built here: the lead's own commit of the Unit's file.
  function mainMovedHere() {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    mkdirSync(join(home.dir, "src"), { recursive: true });
    leadCommits(home, "main", "src/refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    return { home, alice, record };
  }

  test("main moved under a Unit built here: the offer names the repo, a clash waits with the build's record untouched, and the undo puts it back", () => {
    const { alice, record } = mainMovedHere();
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 500)).toBe("unit-main-moved");
    expect(ask.question).toBe("origin/main in the repo has a change to src/refunds.ts that refunds's branch does not have, and refunds " +
      "changes that file too, so its pull request may show a clash. Do you want me to bring origin/main into refunds now? I'd merge it " +
      "with your own git and push refunds again.");
    const state = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    const yes = run(UNIT, ["push", "--merge-main"], alice);
    expect(String(yes.json?.error)).toStartWith("origin/main and refunds both change src/refunds.ts in the repo in ways git cannot put together");
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toBe(state);
    const undone = run(UNIT, ["push", "--undo-merge"], alice);
    expect(String(undone.json?.notice)).toBe("I undid the merge of origin/main into refunds in the repo; refunds is as it was there, and nothing was pushed.");
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toBe(state);
  });

  test("a file of AI-DLC's record that main changes, with a change here not committed: said as what it is, with the step, nothing merged", () => {
    const team = join("aidlc", "spaces", "default", "memory", "team.md");
    const { home, alice } = mainMovedHere();
    writeFileSync(join(home.dir, team), `${readFileSync(join(home.dir, team), "utf-8")}\nA lead's rule.\n`);
    git(home.dir, ["commit", "-q", "-am", "lead: a rule"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    next(alice);
    writeFileSync(join(alice, team), `${readFileSync(join(alice, team), "utf-8")}\nA learning kept here.\n`);
    const said = run(UNIT, ["push", "--merge-main"], alice);
    expect(String(said.json?.error)).toStartWith("aidlc/spaces/default/memory/team.md, a file of AI-DLC's record in the repo, has a change " +
      "here that is not committed, and origin/main changes it too, so nothing was merged or pushed. Say if you want me to put that " +
      "change aside, bring origin/main in and put it back. On their yes, run `");
    expect(String(said.json?.error)).toContain("unit push --merge-main --put-aside`.");
    // Without the person's yes to it, the same command again puts nothing aside.
    expect(String(run(UNIT, ["push", "--merge-main"], alice).json?.error)).toStartWith("aidlc/spaces/default/memory/team.md, a file of AI-DLC's");
    expect(readFileSync(join(alice, team), "utf-8")).toContain("A learning kept here.");
  });

  // Main moved under a Unit built here, merging cleanly with it, and main
  // changes a file of AI-DLC's record that has a change here too: `ours`
  // writes the change here, `theirs` main's, over the committed text.
  function recordInTheWay(file: string, theirs: (text: string) => string, ours: (text: string) => string, clash = false, crlf = false,
    initial = "{\"a\": 1}\n", alongside: Record<string, string> = {}) {
    const lines = (first: string, last: string): string => `${first}\nb\nc\nd\n${last}\n`;
    const home = oneRepoTeams();
    mkdirSync(join(home.dir, "src"), { recursive: true });
    if (!clash) writeFileSync(join(home.dir, "src", "refunds.ts"), lines("a", "e"));
    mkdirSync(join(home.dir, dirname(file)), { recursive: true });
    if (!existsSync(join(home.dir, file))) writeFileSync(join(home.dir, file), initial);
    for (const [path, text] of Object.entries(alongside)) writeFileSync(join(home.dir, path), text);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "--allow-empty", "-m", "lead: before the take"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    // Git for Windows as installed: files checked out with CRLF, stored with LF.
    if (crlf) {
      git(alice, ["config", "core.autocrlf", "true"]);
      rmSync(join(alice, file));
      git(alice, ["checkout", "--", file]);
      expect(readFileSync(join(alice, file), "utf-8")).toContain("\r\n");
    }
    const record = builtHere(alice, "refunds", "refunds.ts");
    if (clash) leadCommits(home, "main", "src/refunds.ts");
    else {
      writeFileSync(join(alice, "src", "refunds.ts"), lines("A", "e"));
      writeFileSync(join(home.dir, "src", "refunds.ts"), lines("a", "E"));
      git(home.dir, ["commit", "-q", "-am", "lead: refunds moves on"]);
      git(home.dir, ["push", "-q", "origin", "main"]);
    }
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    writeFileSync(join(home.dir, file), theirs(readFileSync(join(home.dir, file), "utf-8")));
    git(home.dir, ["commit", "-q", "-am", "lead: the record moves on"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    expect(next(alice).ask_type).toBe("unit-main-moved");
    const here = ours(readFileSync(join(alice, file), "utf-8"));
    writeFileSync(join(alice, file), here);
    return { home, alice, record, here };
  }
  const TEAM = "aidlc/spaces/default/memory/team.md";
  const leadsRule = (text: string): string => `${text}\nA lead's rule.\n`;
  const learning = (text: string): string => `A learning kept here.\n${text}`;

  test("on the yes the change is put aside, origin/main brought in and pushed, and the change is back on top, not committed", () => {
    const { home, alice } = recordInTheWay(TEAM, leadsRule, learning);
    const yes = run(UNIT, ["push", "--merge-main", "--put-aside"], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toContain("Merged origin/main into refunds in the repo and pushed refunds.");
    expect(String(yes.json?.notice)).toContain("The change to aidlc/spaces/default/memory/team.md is back, on top of origin/main's, still not committed.");
    const now = readFileSync(join(alice, TEAM), "utf-8");
    expect(now).toContain("A learning kept here.");
    expect(now).toContain("A lead's rule.");
    expect(git(home.remote, ["show", `refunds:${TEAM}`])).not.toContain("A learning kept here.");
  });

  test("a clash in another file: the change is back all the same, and the finish never takes it into the merge commit", () => {
    const { alice } = recordInTheWay(TEAM, leadsRule, learning, true);
    const yes = run(UNIT, ["push", "--merge-main", "--put-aside"], alice);
    expect(String(yes.json?.error)).toStartWith("origin/main and refunds both change src/refunds.ts in the repo in ways git cannot put together");
    expect(String(yes.json?.error)).toContain("The change to aidlc/spaces/default/memory/team.md is back, on top of origin/main's, still not committed.");
    expect(readFileSync(join(alice, TEAM), "utf-8")).toContain("A learning kept here.");
    writeFileSync(join(alice, "src", "refunds.ts"), "export const built = \"both\";\n");
    git(alice, ["add", "src/refunds.ts"]);
    const finished = run(UNIT, ["push", "--merge-main"], alice);
    expect(finished.status, finished.out).toBe(0);
    expect(git(alice, ["show", `HEAD:${TEAM}`])).not.toContain("A learning kept here.");
    expect(git(alice, ["show", `HEAD:${TEAM}`])).toContain("A lead's rule.");
    expect(readFileSync(join(alice, TEAM), "utf-8")).toContain("A learning kept here.");
  });

  test("a merge their hook refuses is undone, and the change is back exactly as it was, unsaid", () => {
    const { alice, here } = recordInTheWay(TEAM, leadsRule, learning);
    const hooks = join(alice, ".git", "hooks");
    writeFileSync(join(hooks, "pre-merge-commit"), "#!/bin/sh\necho 'no merges on Fridays' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-merge-commit"), 0o755);
    const refused = run(UNIT, ["push", "--merge-main", "--put-aside"], alice);
    expect(String(refused.json?.error)).toStartWith("Your hook in the repo did not take the merge of origin/main into refunds");
    expect(String(refused.json?.error)).not.toContain("The change to");
    expect(readFileSync(join(alice, TEAM), "utf-8")).toBe(here);
  });

  test("a push refused after the merge: the change is back on top all the same", () => {
    const { home, alice } = recordInTheWay(TEAM, leadsRule, learning);
    const hook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'pushes are paused' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const refused = run(UNIT, ["push", "--merge-main", "--put-aside"], alice);
    expect(String(refused.json?.error)).toStartWith("Merged origin/main into refunds in the repo, and the push was refused");
    expect(String(refused.json?.error)).toContain("The change to aidlc/spaces/default/memory/team.md is back, on top of origin/main's, still not committed.");
  });

  test("a change git will not put aside: git's own first line, and the file as it was", () => {
    const { alice, here } = recordInTheWay(TEAM, leadsRule, learning);
    writeFileSync(join(alice, ".git", "index.lock"), "");
    const said = String(run(UNIT, ["push", "--merge-main", "--put-aside"], alice).json?.error);
    expect(said).toStartWith(`${TEAM} could not be put aside in the repo: git says "fatal: Unable to create`);
    expect(said).toContain("Nothing was merged or pushed. Say when to try again.");
    expect(readFileSync(join(alice, TEAM), "utf-8")).toBe(here);
  });

  test("a clone that checks files out with CRLF: the change is back on top, with its line endings, and back exactly as it was after an undo", () => {
    const crlfLearning = (text: string): string => `A learning kept here.\r\n${text}`;
    const { alice } = recordInTheWay(TEAM, leadsRule, crlfLearning, false, true);
    const yes = run(UNIT, ["push", "--merge-main", "--put-aside"], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toContain("The change to aidlc/spaces/default/memory/team.md is back, on top of origin/main's, still not committed.");
    const now = readFileSync(join(alice, TEAM), "utf-8");
    expect(now).toContain("A learning kept here.\r\n");
    expect(now).toContain("A lead's rule.\r\n");
    const undone = recordInTheWay(TEAM, leadsRule, crlfLearning, false, true);
    const hooks = join(undone.alice, ".git", "hooks");
    writeFileSync(join(hooks, "pre-merge-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooks, "pre-merge-commit"), 0o755);
    const refused = run(UNIT, ["push", "--merge-main", "--put-aside"], undone.alice);
    expect(String(refused.json?.error)).not.toContain("The change to");
    expect(readFileSync(join(undone.alice, TEAM), "utf-8")).toBe(undone.here);
  });

  test("where the two meet: a text file of the record holds both, marked, Markdown or not", () => {
    const meets = recordInTheWay(TEAM, leadsRule, (text) => `${text}\nA learning kept here.\n`);
    const yes = run(UNIT, ["push", "--merge-main", "--put-aside"], meets.alice);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toContain("The change to aidlc/spaces/default/memory/team.md did not go back cleanly on top of origin/main's, " +
      "so both are in the file now, marked where they meet, still not committed. Say if you want me to put the two together and show you.");
    expect(readFileSync(join(meets.alice, TEAM), "utf-8")).toContain("<<<<<<< origin/main");
    // Any other file of the record only people and workers read takes the same way: both kept on disk, never only in git.
    const text = "aidlc/knowledge/notes.txt";
    const notes = recordInTheWay(text, () => "two\n", () => "three\n", false, false, "one\n");
    const again = run(UNIT, ["push", "--merge-main", "--put-aside"], notes.alice);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toContain(`The change to ${text} did not go back cleanly on top of origin/main's, so both are in the ` +
      "file now, marked where they meet, still not committed.");
    expect(readFileSync(join(notes.alice, text), "utf-8")).toContain("three");
  });

  // repos.json in AI-DLC's record: the team's list, with one repository and a comment.
  const LIST = "aidlc/repos.json";
  const LISTED = "// The team's repositories.\n{\n  \"repos\": [\n    { \"name\": \"ledger\", \"url\": \"https://example.test/team/ledger.git\" }\n  ]\n}\n";
  const adds = (entry: string) => (text: string): string =>
    text.replace('"url": "https://example.test/team/ledger.git" }', `"url": "https://example.test/team/ledger.git" },\n    ${entry}`);

  test("repos.json where both add a different repository: put together by the tool, both listed, its comment kept", () => {
    const { alice } = recordInTheWay(LIST, adds('{ "name": "audit", "url": "https://example.test/team/audit.git" }'),
      adds('{ "name": "notes", "url": "https://example.test/team/notes.git" }'), false, false, LISTED);
    const yes = run(UNIT, ["push", "--merge-main", "--put-aside"], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toContain(`The change to ${LIST} is back, on top of origin/main's, still not committed.`);
    const now = readFileSync(join(alice, LIST), "utf-8");
    expect(now).toStartWith("// The team's repositories.");
    expect(now).toContain("https://example.test/team/audit.git");
    expect(now).toContain("https://example.test/team/notes.git");
    expect(now).not.toContain("<<<<<<<");
  });

  test("repos.json where the two list one repository differently: that difference said and asked, the list readable", () => {
    const { alice } = recordInTheWay(LIST, adds('{ "name": "notes", "url": "https://example.test/team/notes.git" }'),
      adds('{ "name": "notes", "path": "../notes" }'), false, false, LISTED);
    const yes = run(UNIT, ["push", "--merge-main", "--put-aside"], alice);
    expect(yes.status, yes.out).toBe(0);
    const said = String(yes.json?.notice);
    const kept = /kept for now, not for good, as ([0-9a-f]+)\./.exec(said)?.[1] ?? "";
    expect(said).toContain(`The change to ${LIST} did not go back cleanly on top of origin/main's: origin/main lists notes at ` +
      "https://example.test/team/notes.git, and the change lists it at ../notes. The file stays as origin/main has it; say which of the two " +
      `to keep for notes, and I'll put the rest together. I have the change kept for now, not for good, as ${kept}.`);
    expect(readFileSync(join(alice, LIST), "utf-8")).not.toContain("../notes");
    expect(git(alice, ["show", kept])).toContain("../notes");
  });

  test("repos.json where both changed the same repository: the list readable, the change kept for now, said with its offer first", () => {
    const { alice } = recordInTheWay(LIST, (text) => text.replace("ledger.git", "ledger-moved.git"),
      (text) => text.replace("ledger.git", "ledger-mine.git"), false, false, LISTED);
    const yes = run(UNIT, ["push", "--merge-main", "--put-aside"], alice);
    expect(yes.status, yes.out).toBe(0);
    const said = String(yes.json?.notice);
    const kept = /kept for now, not for good, as ([0-9a-f]+)\./.exec(said)?.[1] ?? "";
    expect(said).toContain(`The change to ${LIST} did not go back cleanly on top of origin/main's, so the file stays as origin/main has it. ` +
      `Say if you want me to put the two together and show you. I have the change kept for now, not for good, as ${kept}.`);
    expect(readFileSync(join(alice, LIST), "utf-8")).toContain("ledger-moved.git");
    expect(git(alice, ["show", kept])).toContain("ledger-mine.git");
  });

  test("a state file, or a file git cannot merge as text, that would not go back: the step does not start, and the file is as it was", () => {
    // A file a tool parses: a JSON file of the record here; the lead's own state file, read by the state tool.
    const parsed = "aidlc/team-notes.json";
    const staged = recordInTheWay(parsed, () => "{\"a\": 2}\n", () => "{\"a\": 3}\n");
    for (const args of [["--merge-main"], ["--merge-main", "--put-aside"]]) {
      const said = run(UNIT, ["push", ...args], staged.alice);
      expect(said.status).not.toBe(0);
      expect(String(said.json?.error)).toStartWith(`${parsed}, a file of AI-DLC's record in the repo, has a change here that is not committed, ` +
        "and origin/main changes it in a way git cannot put together with it, so nothing was merged or pushed. The two have to be settled " +
        "before I can bring origin/main in: say if you want me to show you both.");
      expect(readFileSync(join(staged.alice, parsed), "utf-8")).toBe(staged.here);
    }
    const leadsState = (dir: string): string => relative(dir, seededStateFile(dir)).split("\\").join("/");
    const state = recordInTheWay(leadsState(oneRepoTeams().dir), (text) => `${text}\n<!-- the lead's -->\n`, (text) => `${text}\n<!-- mine -->\n`);
    expect(String(run(UNIT, ["push", "--merge-main", "--put-aside"], state.alice).json?.error)).toContain(
      "a file of AI-DLC's record in the repo, has a change here that is not committed, and origin/main changes it in a way git cannot put together");
    const picture = "aidlc/knowledge/diagram.bin";
    const binary = recordInTheWay(picture, () => "PNG\0two\n", () => "PNG\0three\n", false, false, "PNG\0one\n");
    const said = run(UNIT, ["push", "--merge-main", "--put-aside"], binary.alice);
    expect(String(said.json?.error)).toStartWith(`${picture}, a file of AI-DLC's record in the repo, has a change here that is not committed`);
    expect(readFileSync(join(binary.alice, picture), "utf-8")).toBe(binary.here);
    // A team's .gitattributes may have git diff such a file as text: what git merges it as is what counts.
    const marked = recordInTheWay(picture, () => "PNG\0two\n", () => "PNG\0three\n", false, false, "PNG\0one\n", { ".gitattributes": "*.bin diff\n" });
    const tried = run(UNIT, ["push", "--merge-main", "--put-aside"], marked.alice);
    expect(String(tried.json?.error)).toStartWith(`${picture}, a file of AI-DLC's record in the repo, has a change here that is not committed`);
    expect(readFileSync(join(marked.alice, picture), "utf-8")).toBe(marked.here);
  });

  test("a Unit built here whose branch starts from the plan's branch is not offered a merge of main", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    leadCommits(home, "main", "LEAD-NOTES.md");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(next(alice).ask_type ?? null).not.toBe("unit-main-moved");
  });

  test("the replace of a Unit's branch here leases on its code and the one record commit AI-DLC put on it", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const before = git(home.remote, ["rev-parse", "refunds"]);
    // Their redo folds the branch's two commits into one of its own, then changes the Unit's file again.
    git(alice, ["reset", "-q", "--soft", "HEAD~2"]);
    git(alice, ["commit", "-q", "-m", "refunds again"]);
    writeFileSync(join(alice, "src", "refunds.ts"), "export const built = \"refunds, again\";\n");
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toContain("Ask the person whether to replace refunds there with this build");
    const replaced = run(UNIT, ["push", "--replace"], alice);
    expect(replaced.status, replaced.out).toBe(0);
    expect(git(home.remote, ["show", "refunds:src/refunds.ts"])).toBe('export const built = "refunds, again";');
    expect(spawnSync("git", ["merge-base", "--is-ancestor", before, "refunds"], { cwd: home.remote }).status).not.toBe(0);
  });

  test("AI-DLC's record of the build goes with the Unit's branch as a second commit after its code: the build's own folder and the new space's own files, nothing of the lead's record, nothing git ignores", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    // A change of theirs to the lead's record in this clone stays theirs.
    const leads = join(alice, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(leads, `${readFileSync(leads, "utf-8")}\nmy note\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"]).split("\n")).toEqual(["refunds: AI-DLC's record", "refunds: fixture"]);
    expect(committed(home.remote, "refunds~1")).toEqual(["src/refunds.ts"]);
    const recorded = committed(home.remote, "refunds");
    const own = record.slice(alice.length + 1).replaceAll("\\", "/");
    expect(recorded).toContain(`${own}/aidlc-state.md`);
    expect(recorded.some((path) => path.startsWith("aidlc/spaces/payments/memory/")), recorded.join(", ")).toBe(true);
    expect(recorded.filter((path) => !path.startsWith("aidlc/spaces/payments/"))).toEqual([]);
    expect(recorded.filter((path) => path.includes("/.aidlc-"))).toEqual([]);
    expect(git(alice, ["status", "--porcelain", "--", "aidlc/spaces/default"])).toBe("M aidlc/spaces/default/memory/team.md");
    expect(git(alice, ["status", "--porcelain", "--", "aidlc/spaces/payments"])).toBe("");
    expect(String(pushed.json?.notice)).toContain(recordWent("refunds"));
    // Their change to the lead's record stays uncommitted; aidlc/ is AI-DLC's record, so the line names no change of theirs.
    expect(String(pushed.json?.notice)).not.toContain("your other changes are still yours");
  });

  const OTHER_CHANGES = "; your other changes are still yours, uncommitted.";
  // AI-DLC's install as each teammate's `aidlc config` leaves it in their clone: uncommitted.
  function configured(dir: string, harness: string): string {
    const result = spawnSync(process.execPath, [
      join(REPO_ROOT, "core", "tools", "aidlc-init.ts"), "config", "--project-dir", dir,
      "--from", join(REPO_ROOT, "dist-release", harness), "--harness", typedHarnessName(harness), "--mcp", "none",
    ], { cwd: dir, encoding: "utf-8", env: ENV, timeout: NATIVE_STARTUP_TIMEOUT_MS });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return git(dir, ["status", "--porcelain"]);
  }

  for (const harness of ["claude", "codex"]) {
    test(`${harness}: AI-DLC's install left uncommitted is not said to be the person's at the push, and a file of theirs beside it is`, () => {
      const home = oneRepoTeams();
      const alice = cloneOf(home.remote, "alice");
      const install = configured(alice, harness);
      expect(install).toContain(harness === "codex" ? "?? .codex/" : "?? .claude/");
      builtHere(alice, "refunds", "refunds.ts");
      const pushed = run(UNIT, ["push"], alice);
      expect(pushed.status, pushed.out).toBe(0);
      expect(String(pushed.json?.notice)).toContain("You're on refunds now in the repo. Switch back to main any time.");
      expect(String(pushed.json?.notice)).not.toContain("your other changes are still yours");
      expect(git(alice, ["status", "--porcelain"])).toBe(install);
      if (harness !== "codex") return;
      builtHere(alice, "checkout-ui", "cart.ts");
      writeFileSync(join(alice, "NOTES.md"), "my note\n");
      const again = run(UNIT, ["push"], alice);
      expect(again.status, again.out).toBe(0);
      expect(String(again.json?.notice)).toContain(OTHER_CHANGES);
    });
  }

  test("an earlier Unit's record, written to after its push, is not said to be the person's at the next Unit's push", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    // Their next message in the chat goes into refunds' record, the work still selected.
    const said = hook(alice, personsChat("chat-1"), { hook_event_name: "UserPromptSubmit", session_id: "chat-1", prompt: "I will take checkout-ui." });
    expect(said.status, said.out).toBe(0);
    const earlier = git(alice, ["status", "--porcelain"]);
    expect(earlier).toMatch(/^M aidlc\/spaces\/payments\/intents\/[^/]+-refunds\/audit\/[^/]+\.md$/);
    builtHere(alice, "checkout-ui", "cart.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).not.toContain("your other changes are still yours");
    expect(git(alice, ["status", "--porcelain"])).toBe(earlier);
  });

  // An early start here: AI-DLC's own files (its new space, the build's record,
  // its install) are not the person's, so a clone with nothing of theirs
  // uncommitted is switched.
  function earlyTake(ownChange: boolean, harness?: string, recordChange = false): { dana: string; home: ReturnType<typeof makeHome>; notice: string } {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const dana = cloneOf(home.remote, "dana");
    if (harness !== undefined) configured(dana, harness);
    if (ownChange) writeFileSync(join(dana, "NOTES.md"), "my note\n");
    if (recordChange) {
      const leads = join(dana, "aidlc", "spaces", "default", "memory", "team.md");
      writeFileSync(leads, `${readFileSync(leads, "utf-8")}\nmy note\n`);
    }
    const took = takeIn("data", ["reporting", ...fromHome(home), "--early"], dana);
    expect(took.status, took.out).toBe(0);
    return { dana, home, notice: String(took.json?.notice) };
  }

  test("an early start with nothing of theirs uncommitted puts them on the Unit's branch, at the pushed head it waits on", () => {
    const { dana, home, notice } = earlyTake(false);
    expect(notice).toContain(
      "It starts early on the pushed branch of refunds in the repo. It may still change before it merges. You are on branch reporting in the repo now.",
    );
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    expect(git(dana, ["rev-parse", "HEAD"])).toBe(git(home.remote, ["rev-parse", "refunds"]));
  });

  test("an early start in a clone with AI-DLC's install left uncommitted puts them on the Unit's branch all the same", () => {
    const { dana, notice } = earlyTake(false, "claude");
    expect(notice).toContain("You are on branch reporting in the repo now.");
    expect(notice).not.toContain("your uncommitted changes kept you");
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    expect(git(dana, ["status", "--porcelain"])).toContain("?? .claude/");
  });

  test("an early start with a change of theirs under aidlc/ only puts them on the Unit's branch, the change still there", () => {
    const { dana, notice } = earlyTake(false, undefined, true);
    expect(notice).toContain("You are on branch reporting in the repo now.");
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    expect(git(dana, ["status", "--porcelain", "--", "aidlc/spaces/default"])).toBe("M aidlc/spaces/default/memory/team.md");
    expect(readFileSync(join(dana, "aidlc", "spaces", "default", "memory", "team.md"), "utf-8")).toEndWith("\nmy note\n");
  });

  test("an early start with a change of theirs uncommitted keeps them on their branch, and says so", () => {
    const { dana, notice } = earlyTake(true);
    expect(notice).toContain("Branch reporting in the repo starts there; your uncommitted changes kept you on your branch, so switch when you are ready.");
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
  });

  // A review on GitLab: a suggestion committed on the Unit's branch, then a
  // squash under GitLab's merge commit with the branch deleted, before the
  // lead's look. The team's own look reads the merge request's last head, as
  // the lead's does.
  test("on the workspace's own repository, a suggestion commit then a squash under GitLab's merge commit with the branch deleted: the builder's own look counts it merged, and another teammate takes what waits on it without starting early", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    finishBuild(builtHere(alice, "refunds", "refunds.ts"));
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const fix = commitOnHost(home.remote, "refunds", { "src/refunds.ts": "export const built = \"refunds\"; // suggested\n" }, "Apply 1 suggestion(s) to 1 file(s)");
    git(home.remote, ["update-ref", "refs/merge-requests/2/head", fix]);
    squashOnHost(home.remote, "refunds", "Refunds", "Merge branch 'refunds' into 'main'\n\nRefunds\n\nSee merge request payments/checkout!2");
    writeFileSync(join(alice, "aidlc", "spaces", "payments", "intents", "active-intent"), "");
    const look = next(alice, ENV, ["--units"]);
    expect(String(look.question), JSON.stringify(look)).toContain("Merged: refunds (pushed by alice in payments).");
    expect(String(look.question)).not.toContain("Being built: refunds");
    expect(((look.choices ?? []) as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start reporting");
    const took = takeIn("reports", ["reporting", ...fromHome(home)], cloneOf(home.remote, "wen"));
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("reporting is yours.");
  });

  test("the lead's look reads the squash of the Unit's pull request, record and all, as merged, and the Unit's result names only its code", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    // Nothing else of theirs is left out of git here, so the line that asks them to check in is not said, and nothing
    // is said to be still theirs: the record this push commits is AI-DLC's.
    expect(String(pushed.json?.notice)).toEndWith(recordWent("refunds"));
    expect(String(pushed.json?.notice)).not.toContain(TEAMMATES_SEE);
    expect(String(pushed.json?.notice)).not.toContain("your other changes are still yours");
    const sent = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as {
      result: { repos: Array<{ repo: string; heads: string[]; paths: Record<string, string | null> }> };
    };
    expect(sent.result.repos.map((repo) => [repo.repo, Object.keys(repo.paths)])).toEqual([[".", ["src/refunds.ts"]]]);
    // Its code commit, under the record's, and a look of the team's sends nothing more.
    expect(sent.result.repos[0].heads.at(-1)).toBe(git(home.remote, ["rev-parse", "refunds~1"]));
    next(alice);
    const after = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as typeof sent;
    expect(after.result.repos.map((repo) => [repo.heads.at(-1), Object.keys(repo.paths)]))
      .toEqual([[git(home.remote, ["rev-parse", "refunds~1"]), ["src/refunds.ts"]]]);
    squashInto(home.remote, "main", "refunds");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    // No plan is shared in this repository, so the lead's own record keeps the merge it saw.
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED").map((row) => row.block).join("\n")).toContain("refunds");
  });

  // A host rule on the Unit's branch, as a GitLab push rule on messages checks it.
  function keyRuleOn(host: string, branch: string): void {
    const file = join(host, "hooks", "pre-receive");
    writeFileSync(file, `#!/bin/sh\nwhile read old new ref; do\n  [ "$ref" = refs/heads/${branch} ] || continue\n` +
      "  for c in $(git rev-list \"$new\" --not --all); do\n" +
      `    git log -1 --format=%s "$c" | grep -qE '^[A-Z]+-[0-9]+ ' || { echo "${TICKET_RULE_WORDS}" >&2; exit 1; }\n` +
      "  done\ndone\nexit 0\n");
    chmodSync(file, 0o755);
  }

  test("their own message under their host's ticket rule: the Unit's code and its record both carry their key, and both go", () => {
    const home = oneRepoTeams();
    keyRuleOn(home.remote, "refunds");
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push", "--commit-message-file", commitMessage(alice, record, "PAY-7 refund handler\n")], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"]).split("\n"))
      .toEqual(["PAY-7 refund handler (AI-DLC's record)", "PAY-7 refund handler"]);
  });

  // Their commit-msg hook keeps subjects to 50 characters: their own message
  // fits, the record's longer one does not.
  test("their hook refuses the record's commit: the Unit's code is pushed, the record is not, and the line says so in the hook's words", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const hook = join(alice, ".git", "hooks", "commit-msg");
    writeFileSync(hook, "#!/bin/sh\n[ $(head -n 1 \"$1\" | wc -c) -le 51 ] && exit 0\necho 'commit-msg: subject is longer than 50 characters' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const record = builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push", "--commit-message-file", commitMessage(alice, record, "PAY-7 refund handler for the checkout totals\n")], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"])).toBe("PAY-7 refund handler for the checkout totals");
    expect(git(alice, ["rev-parse", "refunds"])).toBe(git(home.remote, ["rev-parse", "refunds"]));
    const said = String(pushed.json?.notice);
    // Said once, in this computer's words, and nothing after it about the record.
    expect(said.split("AI-DLC's record of refunds did not go with it").length, said).toBe(2);
    expect(said).toEndWith("AI-DLC's record of refunds did not go with it: commit-msg: subject is longer than 50 characters.");
  });

  // A host rule on the record's files, as a GitLab push rule on file names or a
  // secret scan refuses them: the code is pushed, the record stays theirs.
  test("their host refuses the record's files: the Unit's code is pushed, the record is not, and nothing of theirs changed", () => {
    const home = oneRepoTeams();
    const file = join(home.remote, "hooks", "pre-receive");
    writeFileSync(file, "#!/bin/sh\nwhile read old new ref; do\n  [ \"$ref\" = refs/heads/refunds ] || continue\n" +
      "  if git diff --name-only \"$old\" \"$new\" 2>/dev/null | grep -q '^aidlc/'; then echo 'GitLab: File name aidlc/ is prohibited' >&2; exit 1; fi\n" +
      "done\nexit 0\n");
    chmodSync(file, 0o755);
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"])).toBe("refunds: fixture");
    expect(git(alice, ["rev-parse", "refunds"])).toBe(git(home.remote, ["rev-parse", "refunds"]));
    expect(git(alice, ["status", "--porcelain", "--", "aidlc/spaces/payments"])).toBe("?? aidlc/spaces/payments/");
    const said = String(pushed.json?.notice);
    expect(said.split("AI-DLC's record of refunds did not go with it").length, said).toBe(2);
    expect(said).toEndWith("AI-DLC's record of refunds did not go with it: GitLab: File name aidlc/ is prohibited (pre-receive hook declined).");
  });

  // A push-time scan in their clone (a pre-push hook) that refuses the push of
  // the Unit's record ref `times` times, as a secret scanner's false hit does.
  function scanRefusesRecord(clone: string, times: number): void {
    const left = join(clone, ".git", "scan-left");
    writeFileSync(left, String(times));
    const scan = join(clone, ".git", "hooks", "pre-push");
    writeFileSync(scan, "#!/bin/sh\nwhile read lref lsha rref rsha; do\n  case \"$rref\" in refs/aidlc/claims/*|refs/heads/aidlc/claims/*)\n" +
      `    n=$(cat '${left}'); if [ "$n" -gt 0 ]; then echo $((n-1)) > '${left}'; echo 'scan: possible key in unit.json' >&2; exit 1; fi;;\n` +
      "  esac\ndone\nexit 0\n");
    chmodSync(scan, 0o755);
  }
  const WAY_ON = "Get it merged your usual way.";

  test("a send again after their Not now holds no way-on to merge, so the look after the merge says only what is still true", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    finishBuild(builtHere(alice, "refunds", "refunds.ts"));
    scanRefusesRecord(alice, 1);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-scan" };
    const refused = run(UNIT, ["push"], alice, chat);
    expect(String(refused.json?.notice)).toContain(WAY_ON);
    expect(next(alice, chat).ask_type).toBe("unit-push");
    expect(run(UNIT, ["push", "--later"], alice, chat).status).toBe(0);
    next(alice, chat);
    // Their later word sends it; no step follows it until their next look, after the merge.
    const sent = run(UNIT, ["push"], alice, chat);
    expect(sent.status, sent.out).toBe(0);
    squashInto(home.remote, "main", "refunds");
    git(alice, ["fetch", "-q", "origin"]);
    const look = next(alice, chat);
    expect(look.change_notices, JSON.stringify(look)).toEqual(["Pushed branch refunds in the repo. AI-DLC's record of refunds went with it, in a commit of its own."]);
  });

  test("a send again that carries a new commit of the Unit's code says the way-on to merge, as a push of new code does", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    finishBuild(builtHere(alice, "refunds", "refunds.ts"));
    scanRefusesRecord(alice, 1);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-new-code" };
    expect(run(UNIT, ["push"], alice, chat).status).toBe(0);
    writeFileSync(join(alice, "src", "refunds.ts"), "export const built = \"refunds, fixed\";\n");
    const again = run(UNIT, ["push"], alice, chat);
    expect(again.status, again.out).toBe(0);
    expect(JSON.stringify(next(alice, chat).change_notices ?? [])).toContain(WAY_ON);
  });

  test("a build put off with Not now and pushed by hand first: its push says the way-on to merge, as a first push does", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    finishBuild(builtHere(alice, "refunds", "refunds.ts"));
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-by-hand" };
    expect(next(alice, chat).ask_type).toBe("unit-push");
    expect(run(UNIT, ["push", "--later"], alice, chat).status).toBe(0);
    git(alice, ["switch", "-q", "-c", "refunds"]);
    git(alice, ["add", "--", "src/refunds.ts"]);
    git(alice, ["commit", "-q", "-m", "refunds by hand"]);
    git(alice, ["push", "-q", "-u", "origin", "refunds"]);
    const pushed = run(UNIT, ["push"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(JSON.stringify(next(alice, chat).change_notices ?? [])).toContain(WAY_ON);
  });
  // Build and Test runs at the lead's project once every Unit is merged, and
  // on one repository the merges are on the remote's main, not in this checkout.
  const TWO = "# Unit dependencies\n\n```yaml\nunits:\n" +
    "  - name: refunds\n    kind: service\n    depends_on: []\n" +
    "  - name: checkout-ui\n    kind: ui\n    depends_on: []\n```\n";
  function everyUnitMerged(): ReturnType<typeof makeHome> {
    const home = oneRepoTeams(TWO);
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    squashInto(home.remote, "main", "refunds");
    builtHere(alice, "checkout-ui", "cart.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    squashInto(home.remote, "main", "checkout-ui");
    git(home.dir, ["fetch", "-q", "origin"]);
    return home;
  }
  // The lead's next steps until Build and Test, or a question before it.
  function toBuildAndTest(dir: string, chat: NodeJS.ProcessEnv = ENV): Record<string, unknown> {
    for (let look = 0; look < 6; look++) {
      const step = next(dir, chat);
      if (step.kind === "ask" || step.stage === "build-and-test") return step;
    }
    throw new Error("Build and Test never came");
  }
  const CATCH_UP_QUESTION = "Every Unit is merged, and your main does not have checkout-ui and refunds yet. Bring it up to date with " +
    "origin/main first, so Build and Test runs on the merged code?";
  const RUNS_AS_IT_IS = "Build and Test runs on this checkout as it is, without checkout-ui and refunds.";

  test("Build and Test with the merged Units not in this checkout: asked once, and on yes main is brought up to date and Build and Test runs", () => {
    const home = everyUnitMerged();
    const ask = toBuildAndTest(home.dir);
    expect(ask.question, JSON.stringify(ask).slice(0, 800)).toBe(CATCH_UP_QUESTION);
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Bring main up to date", "Run Build and Test on what is here"]);
    expect(choices[0].command).toEndWith("unit catch-up");
    const caught = run(UNIT, ["catch-up"], home.dir);
    expect(caught.status, caught.out).toBe(0);
    expect(caught.json?.notice).toBe("main is up to date with origin/main now, with every merged Unit.");
    expect(existsSync(join(home.dir, "src", "refunds.ts")) && existsSync(join(home.dir, "src", "cart.ts"))).toBe(true);
    const stage = next(home.dir);
    expect(stage).toMatchObject({ kind: "run-stage", stage: "build-and-test" });
    expect(JSON.stringify(stage)).not.toContain(RUNS_AS_IT_IS);
  });

  test("Run Build and Test on what is here: the stage starts with one line saying what it lacks, and the question is not put again", () => {
    const home = everyUnitMerged();
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "lead-build-and-test" };
    expect(toBuildAndTest(home.dir, chat).question).toBe(CATCH_UP_QUESTION);
    const stage = next(home.dir, chat);
    expect(stage, JSON.stringify(stage).slice(0, 600)).toMatchObject({ kind: "run-stage", stage: "build-and-test" });
    expect((stage.change_notices ?? []) as string[]).toContain(RUNS_AS_IT_IS);
    const again = next(home.dir, chat);
    expect(again).toMatchObject({ kind: "run-stage", stage: "build-and-test" });
    expect(JSON.stringify(again)).not.toContain(RUNS_AS_IT_IS);
  });

  test("a file of the lead's in the way: the catch-up changes nothing and says git's words", () => {
    const home = everyUnitMerged();
    expect(toBuildAndTest(home.dir).question).toBe(CATCH_UP_QUESTION);
    mkdirSync(join(home.dir, "src"), { recursive: true });
    writeFileSync(join(home.dir, "src", "refunds.ts"), "mine\n");
    const head = git(home.dir, ["rev-parse", "HEAD"]);
    const caught = run(UNIT, ["catch-up"], home.dir);
    expect(caught.status, caught.out).toBe(0);
    const said = String(caught.json?.notice);
    expect(said).toStartWith('main could not be brought up to date: git says "');
    expect(said).toEndWith('". Build and Test runs on what is here.');
    expect(said).not.toMatch(/git (reset|switch|pull|stash)/);
    expect(git(home.dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(home.dir, "src", "refunds.ts"), "utf-8")).toBe("mine\n");
  });

  test("a main with a commit of the lead's own: the catch-up changes nothing and says git's own words, no git advice", () => {
    const home = everyUnitMerged();
    expect(toBuildAndTest(home.dir).question).toBe(CATCH_UP_QUESTION);
    writeFileSync(join(home.dir, "LEAD.md"), "mine\n");
    git(home.dir, ["add", "LEAD.md"]);
    git(home.dir, ["commit", "-q", "-m", "a note of the lead's"]);
    const head = git(home.dir, ["rev-parse", "HEAD"]);
    const caught = run(UNIT, ["catch-up"], home.dir);
    expect(caught.status, caught.out).toBe(0);
    const said = String(caught.json?.notice);
    expect(said).toStartWith('main could not be brought up to date: git says "');
    expect(said).not.toMatch(/hint:|git (merge|rebase|config|reset|pull)/);
    expect(git(home.dir, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("a lead who already brought main up to date is not asked: Build and Test runs", () => {
    const home = everyUnitMerged();
    git(home.dir, ["merge", "-q", "--ff-only", "origin/main"]);
    const stage = toBuildAndTest(home.dir);
    expect(stage, JSON.stringify(stage).slice(0, 600)).toMatchObject({ kind: "run-stage", stage: "build-and-test" });
    expect(JSON.stringify(stage)).not.toContain(RUNS_AS_IT_IS);
  });

  test("a Unit started early on the workspace's own repository starts on its dependency's pushed branch there", () => {
    const FOLDERS = "# Unit dependencies\n\n```yaml\nunits:\n" +
      "  - name: refunds\n    kind: service\n    repos: [services/api]\n    depends_on: []\n" +
      "  - name: reporting\n    kind: service\n    repos: [services/report]\n    depends_on: [refunds]\n```\n";
    const home = oneRepoTeams(FOLDERS);
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const bob = cloneOf(home.remote, "bob");
    const took = takeIn("reports", ["reporting", ...fromHome(home), "--early"], bob);
    expect(took.status, took.out).toBe(0);
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "reporting") as {
      early_on?: Array<{ unit: string; repos: Array<{ repo: string; branch: string }> }>;
    };
    expect(claim.early_on?.map((dep) => [dep.unit, dep.repos.map((repo) => [repo.repo, repo.branch])])).toEqual([["refunds", [[".", "refunds"]]]]);
  });
});
