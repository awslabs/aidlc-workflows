// covers: subcommand:aidlc-unit:push, audit:UNIT_PUSHED
//
// A Unit on the workspace's own repository, built by teams (#2410, item 5):
// its branch made at the push in that repository, its pull request read against
// the branch the work merges into, AI-DLC's record riding in it, main brought
// in, and a change to a file of AI-DLC's record put aside for that and put
// back. AI-DLC's own files (its record, its install) are never said to be the
// person's uncommitted changes, at the push or at an early start. A build's own
// lines in .gitignore or AGENTS.md go with its Unit while AI-DLC's part there,
// which config leaves uncommitted, stays out and is set aside around AI-DLC's
// own git steps. The push in code repositories is in t-unit-push, the home in
// t-unit-push-home.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { auditBlockField, noteEngineAskMark, personRepliedAfter, readAuditShardEvents, readUnitSourceSnapshot, sourcePathKey, engineAskMark } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { bringBranchLevel, unitBranchInTheWay, workToCommit } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { namesRepoOfItsOwn } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { AIDLC_SRC, fixtureIntentId8, REPO_ROOT, seededRecordDir, seededStateFile, writeLearningsSelections } from "../harness/fixtures.ts";
import { typedHarnessName } from "../../core/tools/aidlc-runtime-paths.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeHost,
  commitOnHost,
  ENV,
  finishBuild,
  git,
  hook,
  inSpace,
  makeHome,
  mergeOnHost,
  next,
  personsChat,
  recordAt,
  run,
  sharePlan,
  STATE,
  tempDir,
  UNIT,
  takeIn,
  commitMessage,
  squashOnHost,
  TICKET_RULE_WORDS,
  leadRecordOnItsOwnBranch,
  fetchRecords,
  personsNext,
  UTILITY,
  ORCH,
  bashLine,
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
  function builtHere(dir: string, unit: string, file: string, space = "payments"): string {
    const took = takeIn(space, [unit, "--plan", fixtureIntentId8(dir, undefined, "default"), "--from", git(dir, ["remote", "get-url", "origin"])], dir);
    expect(took.status, took.out).toBe(0);
    const intents = join(dir, "aidlc", "spaces", space, "intents");
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

  // The lead's record as main had it before the teams answer: Inception pushed, then teams chosen and the plan
  // shared with nothing committed (the share commits nothing), so a teammate's clone reads the lead's work as
  // work one person builds. The build taken there from the plan reads the plan all the same.
  function teamsChosenAfterThePush(): { home: ReturnType<typeof makeHome>; alice: string; chat: NodeJS.ProcessEnv } {
    const home = makeHome({ repos: {}, dependencies: UNITS });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const path = seededStateFile(home.dir);
    const state = readFileSync(path, "utf-8");
    if (!state.includes("- **Home Location**:")) {
      writeFileSync(path, state.replace("## Runtime State\n", `## Runtime State\n- **Home Location**: ${home.remote}\n`));
    }
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const alice = cloneOf(home.remote, "alice");
    expect(readFileSync(seededStateFile(alice), "utf-8")).not.toContain("Unit Ownership");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const chat = personsChat("t-unit-own-repo-before-teams");
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-own-repo-before-teams", prompt: "build refunds" }).status).toBe(0);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    // Once in the chat the Units still open are offered; then the build is finished, waiting for the lead.
    expect(personsNext(alice, chat, "t-unit-own-repo-before-teams").ask_type).toBe("unit-take");
    expect(personsNext(alice, chat, "t-unit-own-repo-before-teams").kind).toBe("done");
    return { home, alice, chat };
  }
  const planRepoName = (home: ReturnType<typeof makeHome>): string =>
    (JSON.parse(git(home.remote, ["show", `refs/aidlc/plans/${fixtureIntentId8(home.dir)}:plan.json`])) as { plan_repo: { name: string } }).plan_repo.name;

  test("a clone of the lead's record from before the teams answer hears the lead's turn-down of its Unit", () => {
    const { home, alice, chat } = teamsChosenAfterThePush();
    const session = "t-unit-own-repo-before-teams";
    const down = run(UNIT, ["turned-down", "refunds", "--repo", planRepoName(home), "--person-words", "the retry logic belongs in the client"], home.dir);
    expect(down.status, down.out).toBe(0);
    const step = personsNext(alice, chat, session);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 1500)).toContain(
      `refunds was turned down in ${planRepoName(home)} by the lead: "the retry logic belongs in the client".`,
    );
    expect(step.ask_type, JSON.stringify(step).slice(0, 1500)).toBe("unit-turned-down");
    expect(run(UTILITY, ["status"], alice).out).not.toContain("waiting for its merge");
  });

  test("a clone of the lead's record from before the teams answer hears its Unit merged and is offered the next", () => {
    const { home, alice, chat } = teamsChosenAfterThePush();
    mergeOnHost(home.remote, "refunds", "squash");
    fetchRecords(home.dir);
    expect(next(home.dir).kind).not.toBe("error");
    const step = personsNext(alice, chat, "t-unit-own-repo-before-teams");
    expect(JSON.stringify(step).slice(0, 2000)).toContain("Your refunds is merged.");
    expect(step.ask_type, JSON.stringify(step).slice(0, 1500)).toBe("unit-take");
  });

  test("a Unit's result on the workspace's own repository carries no address: the plan names that repository itself", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { result: { repos: Array<{ repo: string; address?: string }> } };
    expect(claim.result.repos.map((repo) => [repo.repo, repo.address ?? null])).toEqual([[".", null]]);
  });

  // One check says a Unit's record names a repository of its own, in work that keeps its code in the workspace
  // folder itself once Construction has started: a folder that is a git repository other than the workspace's own,
  // beside it or inside it. A name with nothing on disk, a plain folder, or the workspace's own folder is none.
  test("one check says when a record names a repository of its own in work that records no repos", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    const inside = join(alice, "web");
    mkdirSync(inside, { recursive: true });
    git(inside, ["init", "-q", "-b", "main"]);
    const beside = `${alice}-billing`;
    mkdirSync(beside, { recursive: true });
    git(beside, ["init", "-q", "-b", "main"]);
    mkdirSync(join(alice, "docs"), { recursive: true });
    writeFileSync(join(alice, "aidlc", "repos.json"), `${JSON.stringify({
      repos: [{ name: "billing", path: `../${basename(beside)}` }, { name: "shop", path: "." }],
    }, null, 2)}\n`);
    expect(namesRepoOfItsOwn(alice, "web")).toBe(true);
    expect(namesRepoOfItsOwn(alice, "billing")).toBe(true);
    expect(namesRepoOfItsOwn(alice, "docs")).toBe(false);
    expect(namesRepoOfItsOwn(alice, "wbe")).toBe(false);
    expect(namesRepoOfItsOwn(alice, "shop")).toBe(false);
    // The lead's own project, nothing built there: add-repo still records repos from here.
    expect(namesRepoOfItsOwn(home.dir, "web")).toBe(false);
  });

  // A teammate's Unit at its Code Generation review whose record names, by repo, a repository of its own, in work that
  // keeps its code in the workspace folder itself: the build's state at that review and the review request as the
  // agent makes it. `reach` asks again once when the stage's checks ran first.
  function atReview(alice: string, record: string, writes: Array<Record<string, string>>, session: string) {
    const manifest = join(record, "construction", "refunds", "code-generation", "source-manifest.json");
    const write = (list: Array<Record<string, string>>): void =>
      writeFileSync(manifest, `${JSON.stringify({ stage: "code-generation", unit: "refunds", version: 1, writes: list })}\n`);
    write(writes);
    for (const name of ["code-generation-plan.md", "unit-test-instructions.md", "traceability.json"]) {
      writeFileSync(join(record, "construction", "refunds", "code-generation", name), name.endsWith(".json") ? "{}\n" : `# ${name}\n`);
    }
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design) /gm, "- [x] $1 ")
      .replace(/^- \[[? ]\] code-generation /m, "- [-] code-generation ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    const chat = personsChat(session);
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "build refunds" }).status).toBe(0);
    const rows = (event: string): number => readAuditShardEvents(alice).filter((row) => row.event === event).length;
    const request = (): ReturnType<typeof run> => run(join(AIDLC_SRC, "tools", "aidlc-log.ts"),
      ["review", "--stage", "code-generation", "--reviewer", "aidlc-architecture-reviewer-agent", "--unit", "refunds", "--iteration", "1"], alice, chat);
    const reach = (): ReturnType<typeof run> => {
      const first = request();
      return first.status === 0 && rows("REVIEW_REQUESTED") === 0 ? request() : first;
    };
    // The step the refusal prints, run as the agent runs it.
    const runStep = (said: string): ReturnType<typeof spawnSync> => {
      const step = /`([^`]*intent add-checkout [^`]+)`/.exec(said)?.[1];
      expect(step, said).toBeDefined();
      cpSync(AIDLC_SRC, join(alice, ".claude"), { recursive: true });
      return spawnSync("bash", ["-c", bashLine(step!)], { cwd: alice, encoding: "utf-8", env: chat });
    };
    return { write, rows, reach, runStep };
  }
  const OWN_REPO_REVIEW = (repo: string): string => `refunds's Code Generation changed ${repo}, a repository of its own, and ` +
    "this piece of work records no repos from here. To have the review cover that code where it is, run `";
  const OWN_REPO_REVIEW_END = ", then name those files in the manifest by the name its line gives (`<name>@checkout/<path>`, " +
    "leaving \"repo\" out) and request the review again.";

  // Inside the project: a clone of its own with commits, which the review's walk already
  // reaches, so the step names the files by their path from the project, with no checkout to record.
  const OWN_REPO_REVIEW_REACHED = (repo: string, folder: string): string => `refunds's Code Generation changed ${repo}, a ` +
    "repository of its own, and this piece of work records no repos from here. The review already covers that code where " +
    `it is: name those files in the manifest by their path from the project (\`${folder}/<path>\`, leaving "repo" out) ` +
    "and request the review again.";
  test("a review request whose record names a repository of its own inside the project: it returns the path from the project and asks nothing; the review is requested, and the push says the file is yours", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    git(alice, ["clone", "-q", codeHost("web"), "web"]);
    writeFileSync(join(alice, "web", "app.js"), "export const page = 1;\n");
    const { write, rows, reach } = atReview(alice, record, [{ path: "src/refunds.ts" }, { repo: "web", path: "app.js" }], "t-unit-own-repo-review-web");
    const asked = rows("QUESTION_ASKED");
    const refused = reach();
    expect(refused.status, refused.out).not.toBe(0);
    const said = String(refused.json?.error);
    expect(said).toEndWith(OWN_REPO_REVIEW_REACHED("web", "web"));
    expect(said).not.toContain("add-checkout");
    expect(said).not.toContain("add-repo");
    expect(said).not.toContain("--choice redo");
    write([{ path: "src/refunds.ts" }, { path: "web/app.js" }]);
    const requested = reach();
    expect(requested.status, requested.out).toBe(0);
    expect(rows("REVIEW_REQUESTED")).toBe(1);
    expect(rows("QUESTION_ASKED")).toBe(asked);
    // Approved, the push goes for the rest and says the file in web.
    approvedHere(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      "web/app.js is not in refunds's commit: web is a repository of its own, so it is yours to commit and push there.",
    );
    expect(committed(home.remote, "refunds~1")).toEqual(["src/refunds.ts"]);
  });

  // Beside the project, placed by repos.json: the step as printed records the checkout, and the record by its name
  // reaches the review.
  test("a review request whose record names a repository of its own beside the project: its add-checkout step as printed records it, and the review is requested", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const beside = besideRepo(alice);
    writeFileSync(join(alice, "aidlc", "repos.json"), `${JSON.stringify({ repos: [{ name: "billing", path: `../${basename(beside)}` }] }, null, 2)}\n`);
    const { write, rows, reach, runStep } = atReview(alice, record, [{ path: "src/refunds.ts" }, { repo: "billing", path: "lib/refund.ts" }], "t-unit-own-repo-review-billing");
    const asked = rows("QUESTION_ASKED");
    const refused = reach();
    expect(refused.status, refused.out).not.toBe(0);
    const said = String(refused.json?.error);
    expect(said).toContain(OWN_REPO_REVIEW("billing"));
    expect(said).toEndWith(`intent add-checkout ../${basename(beside)}\`${OWN_REPO_REVIEW_END}`);
    const ran = runStep(said);
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    const label = /as (\S+)@checkout\./.exec(String(ran.stdout))?.[1];
    expect(label, String(ran.stdout)).toBeDefined();
    write([{ path: "src/refunds.ts" }, { path: `${label}@checkout/lib/refund.ts` }]);
    const requested = reach();
    expect(requested.status, requested.out).toBe(0);
    expect(rows("REVIEW_REQUESTED")).toBe(1);
    expect(rows("QUESTION_ASKED")).toBe(asked);
    // The Unit's listing the review reads holds the checkout's file.
    const requestRow = readAuditShardEvents(alice).find((row) => row.event === "REVIEW_REQUESTED")!;
    const listed = readUnitSourceSnapshot(alice, "code-generation", "refunds", auditBlockField(requestRow.block, "Unit Source Fingerprint") ?? "");
    expect([...(listed?.listing.keys() ?? [])]).toContain(sourcePathKey("", `${label}@checkout/lib/refund.ts`));
  });

  // The push question says, before the yes, what its commit carries: the
  // Unit's files, then AI-DLC's record of it in a commit of its own, with the
  // team's new space as it is when git has none of that space yet.
  const choiceDetail = (alice: string, label: string): string => {
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 800)).toBe("unit-push");
    const choice = (ask.choices as Array<{ label: string; detail?: string }>).find((entry) => entry.label === label);
    expect(choice, JSON.stringify(ask.choices)).toBeDefined();
    return String(choice?.detail);
  };
  const NEW_SPACE = "AI-DLC's record of refunds in a commit of its own, with your team's new space payments as it is now " +
    "(its codekb, knowledge and memory folders)";
  // A Unit built here and approved, waiting for its push: every stage of its
  // walk done, Code Generation the last.
  function approvedHere(record: string): void {
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
  }

  // The change a person asked for in the reply that approved the Unit is
  // recorded only on a message of theirs on this work (t-unit-push-way-back).
  test("log change in a Unit built and approved records nothing for a message that is not the person's", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    approvedHere(builtHere(alice, "refunds", "refunds.ts"));
    const madeUp = run(join(AIDLC_SRC, "tools", "aidlc-log.ts"), ["change", "--message", "0badf00d"], alice);
    expect(madeUp.status, madeUp.out).not.toBe(0);
    expect(madeUp.out).toContain("no message record 0badf00d exists in this project");
    expect(readAuditShardEvents(alice).filter((row) => row.event === "UNIT_CHANGE_REQUESTED")).toHaveLength(0);
  });

  // A team's new space as a team keeps it: a document of its own beside its memory.
  const teamsDocument = (alice: string): void => {
    mkdirSync(join(alice, "aidlc", "spaces", "payments", "knowledge"), { recursive: true });
    writeFileSync(join(alice, "aidlc", "spaces", "payments", "knowledge", "pricing.md"), "# Pricing\n\nOur rules.\n");
  };

  test("the push question in a space git already has: the Unit's files, then AI-DLC's record in a commit of its own", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts", "default");
    finishBuild(record);
    expect(choiceDetail(alice, "Push")).toBe(
      "Only the files its Code Generation wrote, then AI-DLC's record of refunds in a commit of its own; nothing else of yours is committed.",
    );
  });

  test("the push question in a team's new space: the record goes with the space as it is now, named by its folders", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    teamsDocument(alice);
    finishBuild(record);
    expect(choiceDetail(alice, "Push")).toBe(`Only the files its Code Generation wrote, then ${NEW_SPACE}; nothing else of yours is committed.`);
  });

  test("the push question with a merge to finish on the Unit's branch, in a team's new space: the merge, the files, and the record with the space", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    teamsDocument(alice);
    finishBuild(record);
    // A merge left resolved but not committed on the Unit's branch.
    git(alice, ["switch", "-q", "-c", "refunds"]);
    writeFileSync(join(alice, "NOTES.md"), "theirs\n");
    git(alice, ["add", "NOTES.md"]);
    git(alice, ["commit", "-q", "-m", "theirs"]);
    git(alice, ["switch", "-q", "-c", "side", "main"]);
    writeFileSync(join(alice, "SIDE.md"), "side\n");
    git(alice, ["add", "SIDE.md"]);
    git(alice, ["commit", "-q", "-m", "side"]);
    git(alice, ["switch", "-q", "refunds"]);
    git(alice, ["merge", "--no-commit", "--no-ff", "side"]);
    expect(choiceDetail(alice, "Finish the merge and push")).toBe(
      `The merge is finished first, with your git; then only the files its Code Generation wrote, and ${NEW_SPACE}; nothing else of yours.`,
    );
  });

  // A project that keeps aidlc/ out of git: AI-DLC's record of a Unit has no commit to go in, so the push question
  // promises none, and the push makes only the Unit's own commit.
  test("a project that keeps aidlc/ out of git: the push promises no record commit and makes none", () => {
    const home = makeHome({ repos: {}, dependencies: UNITS });
    writeFileSync(join(home.dir, ".gitignore"), `${readFileSync(join(home.dir, ".gitignore"), "utf-8")}aidlc/\n`);
    git(home.dir, ["rm", "-r", "-q", "--cached", "aidlc"]);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "aidlc/ kept out of git"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const path = seededStateFile(home.dir);
    const state = readFileSync(path, "utf-8");
    if (!state.includes("- **Home Location**:")) {
      writeFileSync(path, state.replace("## Runtime State\n", `## Runtime State\n- **Home Location**: ${home.remote}\n`));
    }
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const alice = cloneOf(home.remote, "alice");
    // The clone has none of the lead's record: the take reads the plan by its address.
    const took = takeIn("payments", ["refunds", ...fromHome(home)], alice);
    expect(took.status, took.out).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    mkdirSync(join(alice, "src"), { recursive: true });
    writeFileSync(join(alice, "src", "refunds.ts"), "export const built = \"refunds\";\n");
    const stage = join(record, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit: "refunds", version: 1, writes: [{ path: "src/refunds.ts" }] })}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nrefunds.\n");
    finishBuild(record);
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 800)).toBe("unit-push");
    const push = (ask.choices as Array<{ label: string; detail?: string }>).find((choice) => choice.label === "Push");
    expect(String(push?.detail)).not.toContain("AI-DLC's record");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["rev-list", "--count", "main..refunds"])).toBe("1");
    expect(String(pushed.json?.notice)).not.toContain("AI-DLC's record of refunds");
  });

  // A Unit taken in a clone of the lead's work and built with `files` written
  // there, by their path from the workspace, its record naming each of them.
  function builtWriting(alice: string, files: Record<string, string>, afterTake?: () => void): string {
    const took = takeIn("payments", ["refunds", "--plan", fixtureIntentId8(alice, undefined, "default"), "--from", git(alice, ["remote", "get-url", "origin"])], alice);
    expect(took.status, took.out).toBe(0);
    afterTake?.();
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(alice, path)), { recursive: true });
      writeFileSync(join(alice, path), text);
    }
    const stage = join(record, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: Object.keys(files).map((path) => ({ path })),
    })}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nrefunds.\n");
    return record;
  }
  // Part of the project became a repository of its own inside it, as a split of
  // a monorepo leaves it: `web`, with a commit of its own.
  function webOfItsOwn(alice: string): void {
    mkdirSync(join(alice, "web"), { recursive: true });
    git(alice, ["init", "-q", "-b", "main", "web"]);
    const web = join(alice, "web");
    git(web, ["config", "user.name", "alice"]);
    git(web, ["config", "user.email", "alice@example.test"]);
    writeFileSync(join(web, "README.md"), "# web\n");
    git(web, ["add", "README.md"]);
    git(web, ["commit", "-q", "-m", "web"]);
  }
  const REDO = "Ask the person whether to take refunds back to Code Generation to write its change where it can be committed; " +
    "on their yes, run `";
  const nothingPushed = (home: ReturnType<typeof makeHome>, alice: string): void => {
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: alice }).status).not.toBe(0);
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: home.remote }).status).not.toBe(0);
    expect((claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { result?: unknown } | null)?.result).toBeUndefined();
  };
  // Code of the Unit's that went into a repository of its own, with nothing
  // else of it left for the workspace's own: the push asks nothing, ends as Not
  // now ends it, and says once where the code stands and what the lead needs.
  const nothingLeft = (reasons: string, repo: string): string =>
    `Nothing of refunds's is left to push: ${reasons}. Nothing was switched or pushed. The plan still shows refunds as ` +
    `yours, and AI-DLC sends no notice of this: tell the lead its pull request in ${repo}, and they can name it as refunds's build.`;
  const endedAsNotNow = (home: ReturnType<typeof makeHome>, alice: string, record: string): void => {
    nothingPushed(home, alice);
    const state = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    expect(state).toMatch(/^- \*\*Unit Push\*\*: later$/m);
    expect(state).toMatch(/^- \*\*Status\*\*: Completed$/m);
  };

  // The way back a push still names, for a Unit pushed before whose redo left
  // all its code in a repository of its own beside the project, nothing here.
  const BUILDS_HERE_ONLY = (repo: string): string => `refunds's Code Generation changed ${repo}, a repository of its own, ` +
    "and this piece of work builds its Units in the workspace's own repository only, so nothing was pushed. Ask the person " +
    "whether to take refunds back to Code Generation so it changes only the workspace's own repository, with the change in " +
    `${repo} made as a piece of work of its own; on their yes, run \``;
  function besideRepo(alice: string): string {
    const beside = `${alice}-billing`;
    mkdirSync(join(beside, "lib"), { recursive: true });
    git(beside, ["init", "-q", "-b", "main"]);
    writeFileSync(join(beside, "lib", "refund.ts"), "export const refund = 1;\n");
    return beside;
  }
  // The push's step for a record that names a repository of its own by repo, in work that records no repos from here:
  // nothing asked; the folder recorded as a checkout and the files named by it, or, where the review already reaches
  // the folder, named by their path from the project. The step as printed is run as the agent runs it, and `next` is
  // read after each end.
  const OWN_REPO_PUSH = (repo: string): string => `refunds's Code Generation changed ${repo}, a repository of its own, and ` +
    "this piece of work records no repos from here, so nothing was pushed. For the push to leave that code where it is, run `";
  const OWN_REPO_PUSH_END = ", then name those files in the manifest by the name its line gives (`<name>@checkout/<path>`, " +
    "leaving \"repo\" out) and push refunds again.";
  const OWN_REPO_PUSH_REACHED = (repo: string, folder: string): string => `refunds's Code Generation changed ${repo}, a ` +
    "repository of its own, and this piece of work records no repos from here, so nothing was pushed. For the push to leave " +
    `that code where it is, name those files in the manifest by their path from the project (\`${folder}/<path>\`, leaving ` +
    "\"repo\" out) and push refunds again.";
  const printedStep = (alice: string, said: string): ReturnType<typeof spawnSync> => {
    const step = /`([^`]*intent add-checkout [^`]+)`/.exec(said)?.[1];
    expect(step, said).toBeDefined();
    cpSync(AIDLC_SRC, join(alice, ".claude"), { recursive: true });
    return spawnSync("bash", ["-c", bashLine(step!)], { cwd: alice, encoding: "utf-8", env: ENV });
  };
  const manifestOf = (record: string, writes: Array<Record<string, string>>): void =>
    writeFileSync(join(record, "construction", "refunds", "code-generation", "source-manifest.json"),
      `${JSON.stringify({ stage: "code-generation", unit: "refunds", version: 1, writes })}\n`);
  // `next` after an end: no line of the Guard Policy's.
  const nextAfter = (alice: string, end: string): void => {
    expect(JSON.stringify(next(alice)), end).not.toContain("Guard Policy");
  };
  const besideNamedByRepo = (alice: string, record: string, writes: Array<Record<string, string>>): string => {
    const beside = besideRepo(alice);
    writeFileSync(join(alice, "aidlc", "repos.json"), `${JSON.stringify({ repos: [{ name: "billing", path: `../${basename(beside)}` }] }, null, 2)}\n`);
    manifestOf(record, [...writes, { repo: "billing", path: "lib/refund.ts" }]);
    return beside;
  };
  test("a Unit that changed a repository of its own beside the project: the push returns the add-checkout step and asks nothing, and the step as printed lets the push go for the rest", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedHere(record);
    const beside = besideNamedByRepo(alice, record, [{ path: "src/refunds.ts" }]);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    const said = String(refused.json?.error ?? refused.out);
    expect(said).toStartWith(OWN_REPO_PUSH("billing"));
    expect(said).toEndWith(`intent add-checkout ../${basename(beside)}\`${OWN_REPO_PUSH_END}`);
    expect(said).not.toContain("add-repo");
    expect(said).not.toContain("--choice redo");
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: alice }).status).not.toBe(0);
    const ran = printedStep(alice, said);
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    const label = /as (\S+)@checkout\./.exec(String(ran.stdout))?.[1];
    expect(label, String(ran.stdout)).toBeDefined();
    manifestOf(record, [{ path: "src/refunds.ts" }, { path: `${label}@checkout/lib/refund.ts` }]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(besideLine("lib/refund.ts", label!));
    expect(committed(home.remote, "refunds~1")).toEqual(["src/refunds.ts"]);
    nextAfter(alice, "beside, some here");
  });

  // The folder beside already recorded as a checkout (the review's step taken earlier), the record naming it by repo
  // again: the review's walk reaches it, but its path is not the project's, so the step stays the checkout's, and
  // add-checkout's line then says its name.
  test("a record that names by repo a repository beside the project already recorded as a checkout: the push returns the add-checkout step, whose line gives the name", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedHere(record);
    const beside = besideNamedByRepo(alice, record, [{ path: "src/refunds.ts" }]);
    expect(run(UTILITY, ["intent", "add-checkout", `../${basename(beside)}`], alice).status).toBe(0);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    const said = String(refused.json?.error ?? refused.out);
    expect(said).toStartWith(OWN_REPO_PUSH("billing"));
    expect(said).toEndWith(`intent add-checkout ../${basename(beside)}\`${OWN_REPO_PUSH_END}`);
    expect(said).not.toContain(`../${basename(beside)}/<path>`);
    const ran = printedStep(alice, said);
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    const label = /\(as (\S+)@checkout\)/.exec(String(ran.stdout))?.[1];
    expect(label, String(ran.stdout)).toBeDefined();
    manifestOf(record, [{ path: "src/refunds.ts" }, { path: `${label}@checkout/lib/refund.ts` }]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(besideLine("lib/refund.ts", label!));
    nextAfter(alice, "beside, recorded before");
  });

  test("every write of the Unit's named in a repository of its own beside the project: after the step as printed, the push ends as Not now does, with the notice", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedHere(record);
    besideNamedByRepo(alice, record, []);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    const said = String(refused.json?.error ?? refused.out);
    expect(said).toStartWith(OWN_REPO_PUSH("billing"));
    const ran = printedStep(alice, said);
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    const label = /as (\S+)@checkout\./.exec(String(ran.stdout))?.[1];
    manifestOf(record, [{ path: `${label}@checkout/lib/refund.ts` }]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toBe(nothingLeft(
      `lib/refund.ts is in ${label}, a repository of its own, and yours to commit and push there`, label!,
    ));
    endedAsNotNow(home, alice, record);
    nextAfter(alice, "beside, all there");
  });

  test("a Unit whose record names a repository of its own inside the project: the push returns the path from the project and asks nothing, and the push then goes for the rest", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedHere(record);
    git(alice, ["clone", "-q", codeHost("web"), "web"]);
    writeFileSync(join(alice, "web", "app.js"), "export const page = 1;\n");
    manifestOf(record, [{ path: "src/refunds.ts" }, { repo: "web", path: "app.js" }]);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    const said = String(refused.json?.error ?? refused.out);
    expect(said).toBe(OWN_REPO_PUSH_REACHED("web", "web"));
    manifestOf(record, [{ path: "src/refunds.ts" }, { path: "web/app.js" }]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      "web/app.js is not in refunds's commit: web is a repository of its own, so it is yours to commit and push there.",
    );
    expect(committed(home.remote, "refunds~1")).toEqual(["src/refunds.ts"]);
    nextAfter(alice, "inside, some here");
  });

  // Some of the Unit's code here and some in the checkout beside: the push
  // goes for the rest, as it does for a repository of its own inside the
  // project, and says the file beside is the person's to commit and push there.
  const besideLine = (files: string, label: string): string =>
    `${files} is not in refunds's commit: ${label} is a repository of its own, so it is yours to commit and push there.`;
  test("the same Unit after the repository beside the project was recorded as a checkout: the push goes for the rest and says the file beside is yours to commit and push there", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const beside = besideRepo(alice);
    const added = run(UTILITY, ["intent", "add-checkout", `../${basename(beside)}`], alice);
    expect(added.status, added.out).toBe(0);
    const engine = join(record, ".aidlc-engine", "source-checkouts.json");
    const label = (JSON.parse(readFileSync(engine, "utf-8")) as { checkouts: Array<{ label: string }> }).checkouts[0].label;
    writeFileSync(join(record, "construction", "refunds", "code-generation", "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [{ path: "src/refunds.ts" }, { path: `${label}@checkout/lib/refund.ts` }],
    })}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice);
    expect(said).toStartWith("Pushed branch refunds in the repo.");
    expect(said).toContain(besideLine("lib/refund.ts", label));
    expect(said).not.toContain("add-repo");
    expect(committed(home.remote, "refunds~1")).toEqual(["src/refunds.ts"]);
    // The result on the Unit's record names the workspace's own repository only, nothing of the checkout.
    const result = (claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { result?: { repos: Array<{ repo: string }> } } | null)?.result;
    expect(result?.repos.map((repo) => repo.repo)).toEqual(["."]);
    expect(JSON.stringify(result)).not.toContain(label);
    expect(JSON.stringify(result)).not.toContain("lib/refund.ts");
    expect(git(beside, ["status", "--porcelain"])).toBe("?? lib/");
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/refunds"], { cwd: beside }).status).not.toBe(0);
  });

  // The repository beside the project recorded as a checkout, each named write
  // of the Unit's in it: said by its path there.
  function besideCheckout(alice: string, record: string, writes: Array<{ path: string }>): string {
    const beside = besideRepo(alice);
    const added = run(UTILITY, ["intent", "add-checkout", `../${basename(beside)}`], alice);
    expect(added.status, added.out).toBe(0);
    const engine = join(record, ".aidlc-engine", "source-checkouts.json");
    const label = (JSON.parse(readFileSync(engine, "utf-8")) as { checkouts: Array<{ label: string }> }).checkouts[0].label;
    writeFileSync(join(record, "construction", "refunds", "code-generation", "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [...writes, { path: `${label}@checkout/lib/refund.ts` }],
    })}\n`);
    return label;
  }

  test("every file of the Unit's in a repository of its own beside the project, recorded as a checkout: the push asks nothing and ends as Not now does", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const label = besideCheckout(alice, record, []);
    approvedHere(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toBe(nothingLeft(
      `lib/refund.ts is in ${label}, a repository of its own, and yours to commit and push there`, label,
    ));
    endedAsNotNow(home, alice, record);
  });

  test("its files beside the project and one project file unchanged: the push ends with both reasons", () => {
    const home = oneRepoTeams();
    writeFileSync(join(home.dir, "package.json"), "{\"name\": \"shop\"}\n");
    git(home.dir, ["add", "package.json"]);
    git(home.dir, ["commit", "-q", "-m", "package"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const label = besideCheckout(alice, record, [{ path: "package.json" }]);
    approvedHere(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toBe(nothingLeft(
      `lib/refund.ts is in ${label}, a repository of its own, and yours to commit and push there; package.json is ` +
        "unchanged in the repo", label,
    ));
    endedAsNotNow(home, alice, record);
  });

  test("code in two repositories of its own, one inside the project and one beside it: the lead is told of the first", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtWriting(alice, { "web/app.js": "app();\n" }, () => webOfItsOwn(alice));
    const label = besideCheckout(alice, record, [{ path: "web/app.js" }]);
    approvedHere(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toBe(nothingLeft(
      "web/app.js is inside web, a repository of its own, and yours to commit and push there; lib/refund.ts is in " +
        `${label}, a repository of its own, and yours to commit and push there`, "web",
    ));
    endedAsNotNow(home, alice, record);
  });

  // The build's end shows the message the push will carry, when one is held:
  // the chat that heard the notice is not told that form of the line either.
  test("with a commit message held for the push: the chat that heard the notice is not told the line in its message's form", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtWriting(alice, { "web/app.js": "app();\n" }, () => webOfItsOwn(alice));
    approvedHere(record);
    commitMessage(alice, record, "PAY-7 refund page\n");
    const session = "t-unit-own-repo-held-message";
    const chat = personsChat(session);
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "push refunds" }).status).toBe(0);
    const pushed = run(UNIT, ["push"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(personsNext(alice, chat, session).ask_type).toBe("unit-take");
    const end = personsNext(alice, chat, session);
    expect(end.kind, JSON.stringify(end).slice(0, 600)).toBe("done");
    expect(JSON.stringify(end)).not.toContain("not pushed yet");
    const other = "t-unit-own-repo-held-message-other";
    expect(personsNext(alice, personsChat(other), other).ask_type).toBe("unit-take");
    expect(JSON.stringify(personsNext(alice, personsChat(other), other)))
      .toContain("refunds is built and approved, and not pushed yet. Do you want me to push it now, with this commit message?");
  });

  // Some of the Unit's code here and some beside, with a merge of theirs under
  // way here: the merge is said first, before anything is committed; once it
  // is finished, the push goes for the rest.
  test("some of the Unit's code beside the project and a merge under way here: the merge is said first, and once it is finished the push goes for the rest", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const label = besideCheckout(alice, record, [{ path: "src/refunds.ts" }]);
    writeFileSync(join(alice, ".git", "MERGE_HEAD"), `${git(alice, ["rev-parse", "HEAD"])}\n`);
    const merging = run(UNIT, ["push"], alice);
    expect(merging.status, merging.out).not.toBe(0);
    expect(String(merging.json?.error ?? merging.out)).toStartWith("The repo is in the middle of a merge, so nothing was committed or pushed.");
    rmSync(join(alice, ".git", "MERGE_HEAD"));
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(besideLine("lib/refund.ts", label));
    expect(committed(home.remote, "refunds~1")).toEqual(["src/refunds.ts"]);
  });

  // A Unit pushed before and redone with some of its code beside the project:
  // its push again goes for the rest here and says the file beside.
  test("a Unit pushed before, its redo partly beside the project: the push again goes for the rest and says the file beside", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const first = run(UNIT, ["push"], alice);
    expect(first.status, first.out).toBe(0);
    writeFileSync(join(alice, "src", "refunds.ts"), "export const refunds = 2;\n");
    const label = besideCheckout(alice, record, [{ path: "src/refunds.ts" }]);
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toContain(besideLine("lib/refund.ts", label));
    expect(git(home.remote, ["show", "refunds:src/refunds.ts"])).toBe("export const refunds = 2;");
  });

  // A Unit pushed before and redone with all its code beside the project:
  // its push again asks for the way back, as before.
  test("a Unit pushed before, its redo all beside the project: the push again asks for the way back", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const first = run(UNIT, ["push"], alice);
    expect(first.status, first.out).toBe(0);
    const label = besideCheckout(alice, record, []);
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    expect(String(refused.json?.error ?? refused.out)).toStartWith(BUILDS_HERE_ONLY(label));
  });

  test("a file of the Unit's inside a repository of its own in the project: the push says so and pushes the rest", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtWriting(alice, { "src/refunds.ts": "export const refunds = 1;\n", "web/app.js": "app();\n" }, () => webOfItsOwn(alice));
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      "web/app.js is not in refunds's commit: web is a repository of its own, so it is yours to commit and push there.",
    );
    expect(committed(home.remote, "refunds~1")).toEqual(["src/refunds.ts"]);
    expect(git(join(alice, "web"), ["status", "--porcelain"])).toBe("?? app.js");
  });

  test("every file of the Unit's inside a repository of its own: the push asks nothing, ends as Not now does, and says where the code stands", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtWriting(alice, { "web/app.js": "app();\n", "web/index.html": "<main></main>\n" }, () => webOfItsOwn(alice));
    approvedHere(record);
    const session = "t-unit-own-repo-nothing-left";
    const chat = personsChat(session);
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "push refunds" }).status).toBe(0);
    const pushed = run(UNIT, ["push"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.pushed).toBe(false);
    expect(String(pushed.json?.notice)).toBe(nothingLeft(
      "web/app.js and 1 more are inside web, a repository of its own, and yours to commit and push there", "web",
    ));
    endedAsNotNow(home, alice, record);
    // In that chat the Units still open are offered once, then the build's end
    // says nothing of the push: the line it says after a Not now was heard here.
    const after = personsNext(alice, chat, session);
    expect(after.ask_type, JSON.stringify(after).slice(0, 600)).toBe("unit-take");
    const end = personsNext(alice, chat, session);
    expect(end.kind, JSON.stringify(end).slice(0, 600)).toBe("done");
    expect(JSON.stringify(end)).not.toContain("not pushed yet");
    // A new chat, as after a Not now: the board's offer, then the build's end
    // says once that it is not pushed yet; its yes comes back to the same notice.
    const other = "t-unit-own-repo-nothing-left-other";
    const there = personsNext(alice, personsChat(other), other);
    expect(there.ask_type, JSON.stringify(there).slice(0, 600)).toBe("unit-take");
    expect((there.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Carry on refunds");
    const thereEnd = personsNext(alice, personsChat(other), other);
    expect(JSON.stringify(thereEnd)).toContain("refunds is built and approved, and not pushed yet. Do you want me to push it now?");
    // A redo they ask for in words still runs.
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "take refunds back to Code Generation" }).status).toBe(0);
    const back = run(ORCH, ["report", "--result", "resumed", "--choice", "redo", "--target", "code-generation"], alice, chat);
    const jump = /`(bun \S+aidlc-jump\.ts execute [^`]+)`/.exec(String(back.json?.message))?.[1];
    expect(jump, back.out).toBeDefined();
    cpSync(AIDLC_SRC, join(alice, ".claude"), { recursive: true });
    const ran = spawnSync("bash", ["-c", bashLine(jump!)], { cwd: alice, encoding: "utf-8", env: chat });
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    expect(next(alice, chat).stage).toBe("code-generation");
  });

  // The lead's word that it merged, for a Unit of work built in the workspace's own repository whose code all went into
  // a repository of its own: the plan lists no repos for it and its record has no result, so the word names the
  // repository, the Unit is recorded as merged, and the Unit waiting on it opens.
  test("the lead's word that a Unit whose code all went into a repository of its own merged there: it is recorded as merged, and the Unit waiting on it opens", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtWriting(alice, { "web/app.js": "app();\n" }, () => webOfItsOwn(alice));
    approvedHere(record);
    expect(String(run(UNIT, ["push"], alice).json?.notice)).toStartWith("Nothing of refunds's is left to push");
    const dana = cloneOf(home.remote, "dana");
    expect(String(takeIn("data", ["reporting", ...fromHome(home)], dana).json?.error)).toContain("reporting waits on refunds");
    expect(String(run(UNIT, ["merged", "refunds", "--repo", "../web", "--person-words", "merged in web"], home.dir).out)).toContain("Invalid --repo");
    const said = run(UNIT, ["merged", "refunds", "--repo", "web", "--person-words", "merged in web"], home.dir);
    expect(said.status, said.out).toBe(0);
    expect(String(said.json?.notice)).toStartWith("refunds is recorded as merged here.");
    const plan = JSON.parse(git(home.remote, ["show", `refs/aidlc/plans/${fixtureIntentId8(home.dir)}:plan.json`])) as
      { units: Array<{ name: string; word: Record<string, unknown> }> };
    expect(plan.units.find((entry) => entry.name === "refunds")?.word)
      .toMatchObject({ done: true, said_merged: [{ repo: "web", words: "merged in web" }] });
    const merged = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged).toHaveLength(1);
    expect(merged[0].block).toContain("web (by your word)");
    const took = takeIn("data", ["reporting", ...fromHome(home)], dana);
    expect(took.status, took.out).toBe(0);
  });

  // With the lead's sign-off on, the word naming the workspace's own repository by its engine name: the Unit is
  // recorded as merged with no sign-off written, and its take-back says the repo, as the push names it, never a dot.
  test("the lead's word for such a Unit naming the workspace's own repository, with the sign-off on: it is recorded as merged, and its take-back says the repo", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtWriting(alice, { "web/app.js": "app();\n" }, () => webOfItsOwn(alice));
    approvedHere(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    const said = run(UNIT, ["merged", "refunds", "--repo", ".", "--person-words", "merged here"], home.dir);
    expect(said.status, said.out).toBe(0);
    expect(String(said.json?.notice)).toStartWith("refunds is recorded as merged here.");
    const plan = JSON.parse(git(home.remote, ["show", `refs/aidlc/plans/${fixtureIntentId8(home.dir)}:plan.json`])) as
      { units: Array<{ name: string; word: Record<string, unknown> }> };
    const word = plan.units.find((entry) => entry.name === "refunds")?.word;
    expect(word).toMatchObject({ done: true, said_merged: [{ repo: ".", words: "merged here" }] });
    expect(word?.signoff).toBeUndefined();
    const back = run(UNIT, ["release", "refunds"], home.dir);
    expect(back.status, back.out).toBe(0);
    expect(String(back.json?.notice)).toContain("refunds is no longer counted merged in the repo by your word.");
  });

  // When part of the project is split out: the moved files both ignored by the
  // project and inside the new repository, and the one project file the Unit
  // changed back as it was. Said by where the moved files can be committed.
  test("files left out and every kept file unchanged: the push ends with each reason, a file both ignored and inside a repository of its own said by the second", () => {
    const home = oneRepoTeams();
    writeFileSync(join(home.dir, "package.json"), "{\"name\": \"shop\"}\n");
    writeFileSync(join(home.dir, ".gitignore"), `${readFileSync(join(home.dir, ".gitignore"), "utf-8")}web/\n`);
    git(home.dir, ["add", "package.json", ".gitignore"]);
    git(home.dir, ["commit", "-q", "-m", "package and web out"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const files: Record<string, string> = { "package.json": "{\"name\": \"shop\"}\n" };
    for (const name of ["text.js", "app.js", "index.html"]) files[`web/${name}`] = `${name}\n`;
    const record = builtWriting(alice, files, () => webOfItsOwn(alice));
    approvedHere(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toBe(nothingLeft(
      "web/text.js and 2 more are inside web, a repository of its own, and yours to commit and push there; package.json " +
        "is unchanged in the repo", "web",
    ));
    endedAsNotNow(home, alice, record);
  });

  test("a file the project's .gitignore leaves out and every kept file unchanged: the push stops with both reasons", () => {
    const home = oneRepoTeams();
    writeFileSync(join(home.dir, "package.json"), "{\"name\": \"shop\"}\n");
    writeFileSync(join(home.dir, ".gitignore"), `${readFileSync(join(home.dir, ".gitignore"), "utf-8")}dist/\n`);
    // The bundle registered as source for the review, as the build's own step does.
    writeFileSync(join(home.dir, ".aidlc-source-paths.json"), `${JSON.stringify({ version: 1, paths: ["dist/app.js"] })}\n`);
    git(home.dir, ["add", "package.json", ".gitignore", ".aidlc-source-paths.json"]);
    git(home.dir, ["commit", "-q", "-m", "package and dist out"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    builtWriting(alice, { "dist/app.js": "bundle();\n", "package.json": "{\"name\": \"shop\"}\n" });
    const refused = run(UNIT, ["push"], alice);
    expect(refused.status, refused.out).not.toBe(0);
    expect(String(refused.json?.error ?? refused.out)).toStartWith(
      "Nothing of refunds's is left to push: the repo's .gitignore leaves out dist/app.js; package.json is unchanged in the " +
        `repo. Nothing was switched or pushed. ${REDO}`,
    );
    nothingPushed(home, alice);
  });

  // Nothing left out: a Unit whose kept files are all as main has them is
  // pushed as before, whatever they hold.
  test("nothing left out and its one file unchanged: the push is not stopped", () => {
    const home = oneRepoTeams();
    writeFileSync(join(home.dir, "package.json"), "{\"name\": \"shop\"}\n");
    git(home.dir, ["add", "package.json"]);
    git(home.dir, ["commit", "-q", "-m", "package"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    builtWriting(alice, { "package.json": "{\"name\": \"shop\"}\n" });
    const pushed = run(UNIT, ["push"], alice);
    expect(String(pushed.json?.error ?? pushed.json?.notice ?? pushed.out)).not.toContain("is left to push");
  });

  // A Unit sent before is not stopped: a push again after its merge (the push
  // keeps what was sent across pushes) has its kept files as the branch it
  // starts from has them, and its bundle still left out.
  test("a Unit pushed with a file the .gitignore leaves out, merged, then pushed again: the push is not stopped as if nothing of it was ever sent", () => {
    const home = oneRepoTeams();
    writeFileSync(join(home.dir, ".gitignore"), `${readFileSync(join(home.dir, ".gitignore"), "utf-8")}dist/\n`);
    writeFileSync(join(home.dir, ".aidlc-source-paths.json"), `${JSON.stringify({ version: 1, paths: ["dist/app.js"] })}\n`);
    git(home.dir, ["add", ".gitignore", ".aidlc-source-paths.json"]);
    git(home.dir, ["commit", "-q", "-m", "dist out"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    builtWriting(alice, { "src/refunds.ts": "export const refunds = 1;\n", "dist/app.js": "bundle();\n" });
    const first = run(UNIT, ["push"], alice);
    expect(first.status, first.out).toBe(0);
    mergeOnHost(home.remote, "refunds", "merge");
    const again = run(UNIT, ["push"], alice);
    expect(String(again.json?.error ?? again.json?.notice ?? again.out)).not.toContain("is left to push");
  });

  // A split that makes part of the project a git submodule while the Unit is
  // being built: the lead's commit, pulled into the clone. Git refuses a path
  // inside a submodule as it does one in any repository of its own.
  test("a file of the Unit's inside a submodule the project gained during its build: the push says so and pushes the rest", () => {
    const webHost = codeHost("web");
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtWriting(alice, { "src/refunds.ts": "export const refunds = 1;\n", "web/app.js": "app();\n" }, () => {
      git(home.dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", webHost, "web"]);
      git(home.dir, ["commit", "-q", "-m", "web as a submodule"]);
      git(home.dir, ["push", "-q", "origin", "main"]);
      git(alice, ["pull", "-q", "--ff-only"]);
      git(alice, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
    });
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(
      "web/app.js is not in refunds's commit: web is a repository of its own, so it is yours to commit and push there.",
    );
    expect(committed(home.remote, "refunds~1")).toEqual(["src/refunds.ts"]);
  });

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

  // The next Unit after the one before was merged by the host with a change of
  // its own (a review commit on its pull request the builder never pulled), the
  // builder still on the merged branch, as their push left them.
  const REVIEWED = { "src/refunds.ts": 'export const built = "refunds, reviewed";\n' };
  function nextAfterReviewedMerge(how: "squash" | "rebase", options: { dir?: (home: ReturnType<typeof makeHome>) => string;
    prune?: boolean; look?: boolean } = {}) {
    const home = oneRepoTeams();
    const alice = options.dir?.(home) ?? cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    commitOnHost(home.remote, "refunds", REVIEWED, "review: name the refund");
    // A step of the build after the review: its own look sends the reviewed tip home on its claim.
    if (options.look) next(alice);
    if (how === "squash") squashInto(home.remote, "main", "refunds");
    else rebaseInto(home.remote, "refunds");
    if (options.prune) git(alice, ["fetch", "-q", "--prune", "origin"]);
    expect(git(alice, ["branch", "--show-current"])).toBe("refunds");
    builtHere(alice, "checkout-ui", "cart.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    return { home, alice, pushed };
  }
  // A host's rebase merge after main moved: every commit of the branch replayed with a new id.
  function rebaseInto(host: string, branch: string): void {
    const dir = join(tempDir("rebaser"), "repo");
    git(tempDir("rebaser-parent"), ["clone", "-q", host, dir]);
    git(dir, ["config", "user.name", "reviewer"]);
    git(dir, ["config", "user.email", "reviewer@example.test"]);
    writeFileSync(join(dir, "OTHER.md"), "merged first\n");
    git(dir, ["add", "--", "OTHER.md"]);
    git(dir, ["commit", "-q", "-m", "another merge first"]);
    git(dir, ["fetch", "-q", "origin", branch]);
    git(dir, ["switch", "-q", "-c", `rebased-${branch}`, `origin/${branch}`]);
    git(dir, ["rebase", "-q", "main"]);
    git(dir, ["switch", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", `rebased-${branch}`]);
    git(dir, ["push", "-q", "origin", "main"]);
  }
  const onlyItsOwn = (home: ReturnType<typeof makeHome>, pushed: ReturnType<typeof run>): void => {
    expect(git(home.remote, ["log", "--format=%s", "main..checkout-ui"]).split("\n"), pushed.out)
      .toEqual(["checkout-ui: AI-DLC's record", "checkout-ui: fixture"]);
    expect(prFiles(home.remote, "main", "checkout-ui")).toEqual(["src/cart.ts"]);
    expect(spawnSync("git", ["merge-tree", "--write-tree", "main", "checkout-ui"], { cwd: home.remote }).status).toBe(0);
    expect(String(pushed.json?.notice)).not.toContain("come along");
  };
  // The lead changes a file on main again, committing only that file.
  function leadChanges(home: ReturnType<typeof makeHome>, file: string, text: string): void {
    writeFileSync(join(home.dir, file), text);
    git(home.dir, ["add", "--", file]);
    git(home.dir, ["commit", "-q", "-m", `lead: ${file} again`]);
    git(home.dir, ["push", "-q", "origin", "main"]);
  }

  test("the next Unit's branch starts from the lead's main after the one before was squashed with a review commit on its pull request", () => {
    const { home, alice, pushed } = nextAfterReviewedMerge("squash");
    onlyItsOwn(home, pushed);
    expect(String(pushed.json?.notice)).toContain("You're on checkout-ui now in the repo. Switch back to refunds any time.");
    // Their earlier branch is as their push left it.
    expect(git(alice, ["log", "--format=%s", "-1", "refunds"])).toBe("refunds: AI-DLC's record");
  });

  test("the next Unit's branch starts from the lead's main after the one before was rebased with a review commit", () => {
    const { home, pushed } = nextAfterReviewedMerge("rebase");
    onlyItsOwn(home, pushed);
  });

  test("the next Unit's branch starts from the lead's main after a reviewed squash with the merged branch pruned from the clone, and nothing is said to come along", () => {
    const { home, pushed } = nextAfterReviewedMerge("squash", { prune: true });
    onlyItsOwn(home, pushed);
  });

  test("the next Unit's branch starts from the lead's main after the builder's own look saw the review commit", () => {
    const { home, pushed } = nextAfterReviewedMerge("squash", { look: true });
    onlyItsOwn(home, pushed);
  });

  test("the planner's own next Unit in the home starts from main after a reviewed squash of the one before", () => {
    const { home, pushed } = nextAfterReviewedMerge("squash", { dir: (made) => made.dir });
    onlyItsOwn(home, pushed);
  });

  test("a next Unit while the one before is still open starts where they are, with it", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    commitOnHost(home.remote, "refunds", REVIEWED, "review: name the refund");
    builtHere(alice, "checkout-ui", "cart.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["log", "--format=%s", "main..checkout-ui"])).toContain("refunds: fixture");
  });

  test("a commit of their own in a file the lead's main changed too: the branch starts where they are, and the line names it", () => {
    const home = oneRepoTeams();
    leadCommits(home, "main", "NOTES.md");
    const alice = cloneOf(home.remote, "alice");
    writeFileSync(join(alice, "NOTES.md"), "NOTES.md\nmy notes\n");
    git(alice, ["add", "--", "NOTES.md"]);
    git(alice, ["commit", "-q", "-m", "my notes"]);
    leadChanges(home, "NOTES.md", "NOTES.md\nlead notes\n");
    builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain('so your commit not yet on origin/main comes along: "my notes".');
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"])).toContain("my notes");
  });

  test("their own pushed branch whose file main changed too: the branch starts there", () => {
    const home = oneRepoTeams();
    leadCommits(home, "main", "app.ts");
    const alice = cloneOf(home.remote, "alice");
    git(alice, ["switch", "-q", "-c", "helper"]);
    writeFileSync(join(alice, "app.ts"), "app.ts\nexport const helper = 1;\n");
    git(alice, ["add", "--", "app.ts"]);
    git(alice, ["commit", "-q", "-m", "my helper"]);
    git(alice, ["push", "-q", "-u", "origin", "helper"]);
    leadChanges(home, "app.ts", "app.ts\nlead change\n");
    builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain("Switch back to helper any time.");
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"])).toContain("my helper");
  });

  test("their own fix on the merged Unit's branch after its push: the next Unit's branch starts there, and the line names it", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    commitOnHost(home.remote, "refunds", REVIEWED, "review: name the refund");
    squashInto(home.remote, "main", "refunds");
    writeFileSync(join(alice, "src", "refunds.ts"), 'export const built = "refunds, my fix";\n');
    git(alice, ["add", "--", "src/refunds.ts"]);
    git(alice, ["commit", "-q", "-m", "my fix to refunds"]);
    builtHere(alice, "checkout-ui", "cart.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain('so your commit not yet on origin/main comes along: "my fix to refunds".');
    expect(git(home.remote, ["log", "--format=%s", "main..checkout-ui"])).toContain("my fix to refunds");
  });

  test("an ignored file of theirs where the lead's main now tracks one: git refuses the cut from main, the branch starts where they are, and the file is as it was", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    writeFileSync(join(alice, ".git", "info", "exclude"), "local.env\n");
    writeFileSync(join(alice, "local.env"), "MY_SECRET=1\n");
    const theirs = git(alice, ["rev-parse", "HEAD"]);
    leadCommits(home, "main", "local.env");
    builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(readFileSync(join(alice, "local.env"), "utf-8")).toBe("MY_SECRET=1\n");
    expect(git(home.remote, ["merge-base", "main", "refunds"])).toBe(theirs);
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
  // with its first line as it is and the record named in its body, so a rule
  // their code commit meets the record meets too.
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

  // A Unit taken and built in a clone of leadRecordOnItsOwnBranch, in the lead's
  // own space (the default one, the take's) unless `space` names another.
  function builtInClone(dir: string, home: ReturnType<typeof makeHome>, unit: string, file: string, space?: string): string {
    const took = space === undefined ? run(UNIT, ["take", unit, ...fromHome(home)], dir) : takeIn(space, [unit, ...fromHome(home)], dir);
    expect(took.status, took.out).toBe(0);
    const intents = join(dir, "aidlc", "spaces", space ?? "default", "intents");
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
  const SEEDED = ["org.md", "phases/construction.md", "phases/ideation.md", "phases/inception.md", "phases/operation.md",
    "project.md", "team.md", "templates/.gitkeep"];
  // The install's memory files in a clone, untracked and as the install laid them.
  const seedsAsLaid = (dir: string): void => {
    for (const rel of SEEDED) {
      const path = `aidlc/spaces/default/memory/${rel}`;
      expect(git(dir, ["status", "--porcelain", "--untracked-files=all", "--", path]), path).toBe(`?? ${path}`);
      expect(readFileSync(join(dir, ...path.split("/")))).toEqual(readFileSync(join(REPO_ROOT, "dist", "claude", ...path.split("/"))));
    }
  };
  const ownOnly = (record: string, dir: string, recorded: string[]): void => {
    const own = record.slice(dir.length + 1).replaceAll("\\", "/");
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.filter((path) => !path.startsWith(`${own}/`)), recorded.join(", ")).toEqual([]);
  };

  test("a teammate's first Unit in the lead's space, cloned before the lead's record reached main: the record commit carries the build's folder only, and the request merges once the lead's record is in", () => {
    const { home, clone, mergeLeadRecord } = leadRecordOnItsOwnBranch(UNITS);
    const record = builtInClone(clone, home, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], clone);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(recordWent("refunds"));
    ownOnly(record, clone, committed(home.remote, "refunds"));
    seedsAsLaid(clone);
    mergeLeadRecord();
    expect(spawnSync("git", ["merge-tree", "--write-tree", "main", "refunds"], { cwd: home.remote }).status).toBe(0);
  });

  test("a teammate's first Unit in the lead's space, cloned before, the lead's record merged before the push: the build's folder only, and the request merges", () => {
    const { home, clone, mergeLeadRecord } = leadRecordOnItsOwnBranch(UNITS);
    const record = builtInClone(clone, home, "refunds", "refunds.ts");
    mergeLeadRecord("squash");
    const pushed = run(UNIT, ["push"], clone);
    expect(pushed.status, pushed.out).toBe(0);
    ownOnly(record, clone, committed(home.remote, "refunds"));
    expect(spawnSync("git", ["merge-tree", "--write-tree", "main", "refunds"], { cwd: home.remote }).status).toBe(0);
  });

  test("the planner's own Unit with nothing of aidlc/ committed: the record commit carries the build's folder only", () => {
    const { home } = leadRecordOnItsOwnBranch(UNITS);
    git(home.dir, ["switch", "-q", "-c", "lead-local"]);
    git(home.dir, ["reset", "-q", "--mixed", "HEAD~1"]);
    expect(git(home.dir, ["ls-files", "--", "aidlc"])).toBe("");
    const record = builtInClone(home.dir, home, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], home.dir);
    expect(pushed.status, pushed.out).toBe(0);
    ownOnly(record, home.dir, committed(home.remote, "refunds"));
  });

  test("a teammate in a space of their own, cloned before the lead's record reached main: the new space's own files go with its first Unit", () => {
    const { home, clone } = leadRecordOnItsOwnBranch(UNITS);
    builtInClone(clone, home, "refunds", "refunds.ts", "payments");
    const pushed = run(UNIT, ["push"], clone);
    expect(pushed.status, pushed.out).toBe(0);
    const recorded = committed(home.remote, "refunds");
    expect(recorded).toContain("aidlc/spaces/payments/memory/project.md");
    expect(recorded.filter((path) => !path.startsWith("aidlc/spaces/payments/"))).toEqual([]);
  });

  test("a teammate cloned after the lead's record reached main: the record commit carries the build's folder only", () => {
    const { home, mergeLeadRecord } = leadRecordOnItsOwnBranch(UNITS);
    mergeLeadRecord();
    const lee = cloneOf(home.remote, "lee");
    const record = builtInClone(lee, home, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], lee);
    expect(pushed.status, pushed.out).toBe(0);
    ownOnly(record, lee, committed(home.remote, "refunds"));
  });

  // The install's memory files in a clone made before the lead's record reached
  // main are AI-DLC's own: an AI-DLC step that brings main in takes each one that
  // is as the install laid it out of git's way, and main's copy takes its place.
  const LEADS_RULE = "Gift card codes are compared case-insensitively.";
  const mainsCopyHere = (dir: string): void => {
    expect(git(dir, ["ls-files", "--", "aidlc/spaces/default/memory/project.md"])).toBe("aidlc/spaces/default/memory/project.md");
    expect(readFileSync(join(dir, "aidlc", "spaces", "default", "memory", "project.md"), "utf-8")).toContain(LEADS_RULE);
  };
  // A file the lead adds on main, so a merge of main into the Unit's branch clashes there.
  function leadAddsOnMain(home: ReturnType<typeof makeHome>, file: string, text: string): void {
    const dir = join(tempDir("lead-adds"), "repo");
    git(tempDir("lead-adds-parent"), ["clone", "-q", home.remote, dir]);
    git(dir, ["config", "user.name", "lead"]);
    git(dir, ["config", "user.email", "lead@example.test"]);
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    git(dir, ["add", "--", file]);
    git(dir, ["commit", "-q", "-m", `lead: ${file}`]);
    git(dir, ["push", "-q", "origin", "main"]);
  }
  // The person's own words in their chat, which a merge of main is run on (no offer is put for it here).
  function asks(dir: string, session: string, words: string): NodeJS.ProcessEnv {
    const chat = personsChat(session);
    expect(hook(dir, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: words }).status).toBe(0);
    return chat;
  }
  const bringMainIn = (dir: string, session: string) =>
    run(UNIT, ["push", "--merge-main"], dir, asks(dir, session, "please bring main into my refunds branch"));
  // refunds pushed from the clone, then the lead's record merged on main.
  function pushedBeforeLeadsRecord(space?: string) {
    const made = leadRecordOnItsOwnBranch(UNITS);
    builtInClone(made.clone, made.home, "refunds", "refunds.ts", space);
    const pushed = run(UNIT, ["push"], made.clone);
    expect(pushed.status, pushed.out).toBe(0);
    made.mergeLeadRecord();
    return made;
  }

  test("a teammate's first Unit, the lead's record merged before the push: the cut from main goes over the install's unchanged memory files, and main's copies take their place", () => {
    const { home, clone, mergeLeadRecord } = leadRecordOnItsOwnBranch(UNITS);
    builtInClone(clone, home, "refunds", "refunds.ts");
    mergeLeadRecord();
    const pushed = run(UNIT, ["push"], clone);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["merge-base", "main", "refunds"])).toBe(git(home.remote, ["rev-parse", "main"]));
    mainsCopyHere(clone);
  });

  test("the install's memory file saved with other line endings than the seed: the cut from main goes all the same", () => {
    const { home, clone, mergeLeadRecord } = leadRecordOnItsOwnBranch(UNITS);
    const org = join(clone, "aidlc", "spaces", "default", "memory", "org.md");
    writeFileSync(org, readFileSync(org, "utf-8").replace(/\r?\n/g, "\r\n"));
    builtInClone(clone, home, "refunds", "refunds.ts");
    mergeLeadRecord();
    expect(run(UNIT, ["push"], clone).status).toBe(0);
    expect(git(home.remote, ["merge-base", "main", "refunds"])).toBe(git(home.remote, ["rev-parse", "main"]));
    expect(git(clone, ["ls-files", "--", "aidlc/spaces/default/memory/org.md"])).toBe("aidlc/spaces/default/memory/org.md");
  });

  test("bring main in over the install's unchanged memory files: it goes, and no file of theirs is said to be in the way", () => {
    const { home, clone } = pushedBeforeLeadsRecord();
    const merged = bringMainIn(clone, `seeds-merge-${Math.random().toString(36).slice(2)}`);
    expect(merged.status, merged.out).toBe(0);
    expect(merged.out).not.toContain("where you have a file of your own");
    expect(spawnSync("git", ["merge-base", "--is-ancestor", "main", "refunds"], { cwd: home.remote }).status, merged.out).toBe(0);
    mainsCopyHere(clone);
  });

  test("a teammate in a space of their own brings main in over the install's memory files: all eight give way", () => {
    const { home, clone } = pushedBeforeLeadsRecord("payments");
    const merged = bringMainIn(clone, `seeds-merge-${Math.random().toString(36).slice(2)}`);
    expect(merged.status, merged.out).toBe(0);
    expect(spawnSync("git", ["merge-base", "--is-ancestor", "main", "refunds"], { cwd: home.remote }).status, merged.out).toBe(0);
    for (const rel of SEEDED) expect(git(clone, ["ls-files", "--", `aidlc/spaces/default/memory/${rel}`])).toBe(`aidlc/spaces/default/memory/${rel}`);
  });

  test("a teammate's clone the lead's plan had not reached: share --back brings main up over the install's unchanged memory files", () => {
    const { clone, mergeLeadRecord } = leadRecordOnItsOwnBranch(UNITS);
    mergeLeadRecord();
    // The look that offers it has fetched main.
    git(clone, ["fetch", "-q", "origin"]);
    const back = run(UNIT, ["share", "--back"], clone);
    expect(back.status, back.out).toBe(0);
    expect(git(clone, ["rev-parse", "HEAD"])).toBe(git(clone, ["rev-parse", "origin/main"]));
    mainsCopyHere(clone);
  });

  test("main brought level from the Unit's branch (fetched into, the checkout untouched): it goes over the install's memory files, and they are as they were", () => {
    const { clone } = pushedBeforeLeadsRecord();
    expect(git(clone, ["branch", "--show-current"])).toBe("refunds");
    // The look that brings main level has fetched it.
    git(clone, ["fetch", "-q", "origin"]);
    const level = bringBranchLevel(clone, "origin", "main");
    expect(level, JSON.stringify(level)).toMatchObject({ ok: true, ran: "fetch" });
    expect(git(clone, ["rev-parse", "main"])).toBe(git(clone, ["rev-parse", "origin/main"]));
    seedsAsLaid(clone);
  });

  test("bring main in, their hook refusing the merge: it is undone, and the install's memory files are laid again as the install lays them", () => {
    const { clone } = pushedBeforeLeadsRecord();
    const hooks = join(clone, ".git", "hooks");
    writeFileSync(join(hooks, "pre-merge-commit"), "#!/bin/sh\necho 'no merges on Fridays' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-merge-commit"), 0o755);
    const refused = bringMainIn(clone, "seeds-merge-hook");
    expect(String(refused.json?.error), refused.out).toStartWith("Your hook in the repo did not take the merge of origin/main into refunds");
    seedsAsLaid(clone);
  });

  test("bring main in, left waiting on a clash in another file, then the undo in a later step: the install's memory files are laid again", () => {
    const { home, clone } = pushedBeforeLeadsRecord();
    leadAddsOnMain(home, "src/refunds.ts", 'export const built = "the lead\'s refunds";\n');
    const waiting = bringMainIn(clone, "seeds-merge-clash");
    expect(String(waiting.json?.error), waiting.out).toStartWith("origin/main and refunds both change src/refunds.ts in the repo");
    const undone = run(UNIT, ["push", "--undo-merge"], clone, asks(clone, "seeds-merge-clash", "undo that merge, please"));
    expect(String(undone.json?.notice), undone.out).toStartWith("I undid the merge of origin/main into refunds in the repo");
    seedsAsLaid(clone);
  });

  test("a rule kept in the install's project.md: it stays, and bringing main in says it is a file of theirs", () => {
    const { clone } = pushedBeforeLeadsRecord();
    const project = join(clone, "aidlc", "spaces", "default", "memory", "project.md");
    const kept = `${readFileSync(project, "utf-8")}\n- A rule this build learned.\n`;
    writeFileSync(project, kept);
    const stopped = bringMainIn(clone, "seeds-merge-kept");
    expect(String(stopped.json?.error), stopped.out).toStartWith(
      "origin/main adds aidlc/spaces/default/memory/project.md in the repo, where you have a file of your own, so nothing was merged or pushed.",
    );
    expect(readFileSync(project, "utf-8")).toBe(kept);
  });

  // A file symlink needs privileges Windows runners do not grant.
  test.skipIf(process.platform === "win32")("a staged copy of the install's file, and one that is a link: neither is taken, each is as it was, and the others are back as they were", () => {
    const { home, clone, mergeLeadRecord } = leadRecordOnItsOwnBranch(UNITS);
    const memory = join(clone, "aidlc", "spaces", "default", "memory");
    git(clone, ["add", "--", "aidlc/spaces/default/memory/org.md"]);
    const team = join(memory, "team.md");
    const seedTeam = join(REPO_ROOT, "dist", "claude", "aidlc", "spaces", "default", "memory", "team.md");
    rmSync(team);
    symlinkSync(seedTeam, team);
    builtInClone(clone, home, "refunds", "refunds.ts");
    mergeLeadRecord();
    const pushed = run(UNIT, ["push"], clone);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(clone, ["diff", "--cached", "--name-only", "--", "aidlc/spaces/default/memory/org.md"])).toBe("aidlc/spaces/default/memory/org.md");
    expect(lstatSync(team).isSymbolicLink()).toBe(true);
    // git refused the cut over the link, so the six set aside are back, untracked and as the install laid them.
    for (const rel of SEEDED.filter((each) => each !== "org.md" && each !== "team.md")) {
      const path = `aidlc/spaces/default/memory/${rel}`;
      expect(git(clone, ["status", "--porcelain", "--untracked-files=all", "--", path]), path).toBe(`?? ${path}`);
      expect(readFileSync(join(clone, ...path.split("/")))).toEqual(readFileSync(join(REPO_ROOT, "dist", "claude", ...path.split("/"))));
    }
  });

  test("the install's unchanged memory files are still listed as work to commit: what a commit takes does not change", () => {
    const { clone } = leadRecordOnItsOwnBranch(UNITS);
    expect(workToCommit(clone).untracked).toContain("aidlc/spaces/default/memory/org.md");
  });

  // AI-DLC's log of a Unit's build: its tracked audit file, which the record
  // commit takes, and the build's own log in its engine folder, which git
  // ignores. After the record commit, what AI-DLC writes goes to the build's own
  // log only, so the file the commit took stays as it took it.
  const trackedLog = (record: string): string => {
    const audit = join(record, "audit");
    return join(audit, readdirSync(audit).find((name) => name.endsWith(".md"))!);
  };
  const ownLog = (record: string): string => join(record, ".aidlc-engine", "audit", basename(trackedLog(record)));
  const rowsOf = (path: string): string[] =>
    readFileSync(path, "utf-8").replace(/\r\n/g, "\n").split(/\n---\n/).filter((block) => block.includes("**Timestamp**")).map((block) => block.replace(/^# AI-DLC Audit Log\n/, ""));
  // A new chat in the person's project: the session-start hook, as the host calls it.
  function newChat(dir: string, session: string): void {
    const started = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "session-start"], {
      cwd: dir, encoding: "utf-8", env: { ...ENV, AIDLC_SESSION_OVERRIDE: session, CLAUDE_PROJECT_DIR: dir, AIDLC_PROJECT_DIR: dir },
      input: JSON.stringify({ cwd: dir, hook_event_name: "SessionStart", source: "startup", session_id: session }),
    });
    expect(started.status, `${started.stdout}${started.stderr}`).toBe(0);
  }
  // A file as a commit holds it, byte for byte.
  const shownAt = (repo: string, rev: string, rel: string): string =>
    spawnSync("git", ["show", `${rev}:${rel.replaceAll("\\", "/")}`], { cwd: repo, encoding: "utf-8", env: ENV }).stdout;
  const committedText = (dir: string, path: string): string => shownAt(dir, "HEAD", relative(dir, path));

  test("a Unit's build keeps its own log in its engine folder from its take, holding every row of its tracked audit file", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    expect(existsSync(ownLog(record))).toBe(true);
    const own = new Set(rowsOf(ownLog(record)));
    expect(rowsOf(trackedLog(record)).filter((row) => !own.has(row))).toEqual([]);
    expect(rowsOf(trackedLog(record)).some((row) => row.includes("**Event**: UNIT_TAKEN_IN"))).toBe(true);
    // Git ignores the build's own log.
    expect(git(alice, ["status", "--porcelain", "--ignored", "--", relative(alice, ownLog(record)).replaceAll("\\", "/")])).toMatch(/^!! /);
  });

  for (const merged of [false, true]) {
    test(`after a finished Unit's push${merged ? " and its merge on the host" : ""}, the next look and a new chat leave nothing of AI-DLC's changed and its audit file as the record commit took it, so the switch back the line names goes`, () => {
      const home = oneRepoTeams();
      const alice = cloneOf(home.remote, "alice");
      const record = builtHere(alice, "refunds", "refunds.ts");
      finishBuild(record);
      const pushed = run(UNIT, ["push"], alice);
      expect(pushed.status, pushed.out).toBe(0);
      expect(String(pushed.json?.notice)).toContain("You're on refunds now in the repo. Switch back to main any time.");
      if (merged) mergeOnHost(home.remote, "refunds", "merge");
      const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "chat-1" };
      expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "chat-1", prompt: "/aidlc" }).status).toBe(0);
      const look = next(alice, chat);
      expect(look.ask_type, JSON.stringify(look)).toBe("unit-take");
      newChat(alice, "chat-2");
      expect(git(alice, ["status", "--porcelain"])).toBe("");
      expect(readFileSync(trackedLog(record), "utf-8")).toBe(committedText(alice, trackedLog(record)));
      // What was written after the record commit is in the build's own log.
      expect(rowsOf(ownLog(record)).some((row) => row.includes("**Event**: QUESTION_ASKED") && row.includes("unit-take"))).toBe(true);
      expect(rowsOf(ownLog(record)).some((row) => row.includes("**Event**: SESSION_STARTED"))).toBe(true);
      expect(readAuditShardEvents(alice).filter((row) => row.event === "QUESTION_ASKED").length).toBeGreaterThan(0);
      const back = spawnSync("git", ["switch", "main"], { cwd: alice, encoding: "utf-8", env: ENV });
      expect(back.status, back.stderr).toBe(0);
    });
  }

  test("a second push of the Unit carries in its record commit the rows written since its first, each once", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "chat-1" };
    expect(next(alice, chat).ask_type).toBe("unit-take");
    // A review fix, pushed again.
    writeFileSync(join(alice, "src", "refunds.ts"), 'export const built = "refunds, fixed";\n');
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toContain(recordWent("refunds"));
    const sent = shownAt(home.remote, "refunds", relative(alice, trackedLog(record)));
    const rows = rowsOf(trackedLog(record));
    expect(sent.replace(/\r\n/g, "\n")).toBe(readFileSync(trackedLog(record), "utf-8").replace(/\r\n/g, "\n"));
    expect(rows.filter((row) => row.includes("**Event**: QUESTION_ASKED") && row.includes("unit-take"))).toHaveLength(1);
    expect(new Set(rows).size).toBe(rows.length);
    expect(git(alice, ["status", "--porcelain"])).toBe("");
  });

  test("a question asked before the record commit and answered after it reads as answered", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    noteEngineAskMark(alice, "probe-asked.json");
    const asked = engineAskMark(alice, "probe-asked.json");
    expect(asked).not.toBeNull();
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const said = hook(alice, personsChat("chat-1"), { hook_event_name: "UserPromptSubmit", session_id: "chat-1", prompt: "Yes, do that." });
    expect(said.status, said.out).toBe(0);
    expect(personRepliedAfter(alice, asked!)).toBe(true);
  });

  test("before and after a build's record commit went, the plan-approval guard writes its one row where it reads it, and a review receipt written after is read once, from the build's own log", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const off = { ...ENV, AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1", AIDLC_SESSION_OVERRIDE: "chat-1" };
    const guard = (): void => {
      const called = hook(alice, off, { hook_event_name: "PreToolUse", session_id: "chat-1", tool_name: "Bash", tool_input: { command: "ls" } });
      expect(called.status, called.out).toBe(0);
    };
    const rows = (event: string): number => readAuditShardEvents(alice).filter((row) => row.event === event).length;
    guard();
    guard();
    expect(rows("GUARD_DISABLED")).toBe(1);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    guard();
    guard();
    expect(rows("GUARD_DISABLED")).toBe(2);
    appendAuditEntry("REVIEW_COMPLETED", {
      Stage: "code-generation", Unit: "refunds", Reviewer: "aidlc-quality-agent", Iteration: "1",
      "Artifact Fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000", Verdict: "READY",
    }, alice);
    expect(rows("REVIEW_COMPLETED")).toBe(1);
    expect(rowsOf(ownLog(record)).some((row) => row.includes("**Event**: REVIEW_COMPLETED"))).toBe(true);
    expect(readFileSync(trackedLog(record), "utf-8")).toBe(committedText(alice, trackedLog(record)));
    expect(git(alice, ["status", "--porcelain"])).toBe("");
  });

  test("with AI-DLC's install, the build's own log is a file its .gitignore block keeps out", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const install = configured(alice, "claude");
    const record = builtHere(alice, "refunds", "refunds.ts");
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    newChat(alice, "chat-1");
    const rule = spawnSync("git", ["check-ignore", "-v", relative(alice, ownLog(record)).replaceAll("\\", "/")], { cwd: alice, encoding: "utf-8", env: ENV });
    // The rule git names is a line of the block the install writes.
    const [source, , pattern] = rule.stdout.split("\t")[0].split(":");
    expect(source, rule.stdout).toBe(".gitignore");
    expect(readFileSync(join(REPO_ROOT, "harness", "claude", "dot-gitignore"), "utf-8").split(/\r?\n/)).toContain(pattern);
    expect(git(alice, ["status", "--porcelain"])).toBe(install);
  });

  // Every stage approved and the build not finished yet, as the real flow leaves it for its push to finish.
  function approvedForItsPush(record: string): void {
    finishBuild(record);
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace(/^- \*\*Status\*\*: Completed$/m, "- **Status**: Running"));
  }

  // Their host refuses a push of the Unit's branch that changes aidlc/, so AI-DLC's record does not go.
  function hostRefusesTheRecord(host: string): void {
    const file = join(host, "hooks", "pre-receive");
    writeFileSync(file, "#!/bin/sh\nwhile read old new ref; do\n  [ \"$ref\" = refs/heads/refunds ] || continue\n" +
      "  if git diff --name-only \"$old\" \"$new\" 2>/dev/null | grep -q '^aidlc/'; then echo 'GitLab: File name aidlc/ is prohibited' >&2; exit 1; fi\n" +
      "done\nexit 0\n");
    chmodSync(file, 0o755);
  }

  test("their host refuses the record and they commit AI-DLC's record themselves: a new chat leaves their commit as it is, and the switch back goes", () => {
    const home = oneRepoTeams();
    hostRefusesTheRecord(home.remote);
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    finishBuild(record);
    const pushed = run(UNIT, ["push", "--commit-message-file", commitMessage(alice, record, "PAY-7 refund handler for the checkout totals\n")], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain("AI-DLC's record of refunds did not go with it");
    git(alice, ["add", "-A", "--", "aidlc"]);
    git(alice, ["commit", "-q", "-m", "PAY-7 the build's record"]);
    newChat(alice, "chat-1");
    expect(git(alice, ["status", "--porcelain"])).toBe("");
    const back = spawnSync("git", ["switch", "main"], { cwd: alice, encoding: "utf-8", env: ENV });
    expect(back.status, back.stderr).toBe(0);
  });

  test("Not now at the push question, then their own commit of everything: it holds the build's end, and a new chat leaves it as it is", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedForItsPush(record);
    expect(run(UNIT, ["push", "--later"], alice).status).toBe(0);
    git(alice, ["add", "-A"]);
    git(alice, ["commit", "-q", "-m", "everything"]);
    expect(committedText(alice, trackedLog(record))).toContain("**Event**: WORKFLOW_COMPLETED");
    newChat(alice, "chat-1");
    expect(git(alice, ["status", "--porcelain"])).toBe("");
    const away = spawnSync("git", ["switch", "-c", "elsewhere", "origin/main"], { cwd: alice, encoding: "utf-8", env: ENV });
    expect(away.status, away.stderr).toBe(0);
  });

  // Their host takes the Unit's branch and refuses AI-DLC's claim refs, so the lead's project does not take the result.
  function hostTakesOnlyTheBranch(host: string): string {
    const rule = join(host, "hooks", "pre-receive");
    writeFileSync(rule, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/heads/refunds) ;; *) echo 'only the Unit branch is taken here' >&2; exit 1;; esac; done\nexit 0\n");
    chmodSync(rule, 0o755);
    return rule;
  }

  test("a first push whose result the lead's project does not take: no record commit yet, and the next look and Not now change nothing git tracks, so the switch back goes", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedForItsPush(record);
    hostTakesOnlyTheBranch(home.remote);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice);
    expect(said).toContain("did not take the result of refunds");
    expect(said).toContain("Switch back to main any time.");
    expect(said).not.toContain("AI-DLC's record of refunds");
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"])).toBe("refunds: fixture");
    const tracked = (): string => git(alice, ["status", "--porcelain", "--untracked-files=no"]);
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "chat-1" };
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "chat-1", prompt: "/aidlc" }).status).toBe(0);
    expect(String(next(alice, chat).question)).toContain("Do you want me to send it again?");
    expect(tracked()).toBe("");
    const later = run(UNIT, ["push", "--later"], alice, chat);
    expect(later.status, later.out).toBe(0);
    expect(tracked()).toBe("");
    const back = spawnSync("git", ["switch", "main"], { cwd: alice, encoding: "utf-8", env: ENV });
    expect(back.status, back.stderr).toBe(0);
  });

  test("Send it again, taken, asked from main: the record goes on the Unit's branch, and main is as it was", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedForItsPush(record);
    const rule = hostTakesOnlyTheBranch(home.remote);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const back = spawnSync("git", ["switch", "main"], { cwd: alice, encoding: "utf-8", env: ENV });
    expect(back.status, back.stderr).toBe(0);
    const mainBefore = git(alice, ["rev-parse", "main"]);
    // Their host's owner lets AI-DLC's refs through.
    rmSync(rule);
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    const said = String(again.json?.notice);
    expect(said).toContain("You're on refunds now in the repo.");
    expect(said).toContain(recordWent("refunds"));
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"]).split("\n")).toEqual(["refunds: AI-DLC's record", "refunds: fixture"]);
    expect(git(alice, ["rev-parse", "main"])).toBe(mainBefore);
    expect(git(alice, ["branch", "--show-current"])).toBe("refunds");
  });

  // Send it again commits AI-DLC's record once the result is taken, so its
  // choice says so, never that nothing new is committed.
  const sendAgain = (alice: string, chat: NodeJS.ProcessEnv, session: string): { detail: string; repo: string } => {
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "/aidlc" }).status).toBe(0);
    const ask = next(alice, chat);
    const choices = (ask.choices ?? []) as Array<{ label: string; detail?: string }>;
    const again = choices.find((choice) => choice.label === "Send it again");
    expect(again, JSON.stringify(ask).slice(0, 1200)).toBeDefined();
    const repo = /^Its record in (.+) has no result until you send it\.$/.exec(String(choices.find((choice) => choice.label === "Not now")?.detail))?.[1];
    expect(repo, JSON.stringify(choices)).toBeDefined();
    return { detail: String(again?.detail), repo: repo! };
  };

  test("Send it again while the record waits for the result, in a team's new space: the record goes once it is taken, with the space", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    teamsDocument(alice);
    approvedForItsPush(record);
    hostTakesOnlyTheBranch(home.remote);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const { detail, repo } = sendAgain(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "chat-waits" }, "chat-waits");
    expect(detail).toBe(`The result is sent to ${repo} again; once ${repo} takes it, ${NEW_SPACE.replace("in a commit", "goes in a commit")}.`);
  });

  // Send it again after an earlier record commit: the first push made AI-DLC's
  // record commit and its result was not taken; a send that is taken makes a
  // record commit again, as the record changed since.
  test("Send it again after an earlier record commit: its choice says the record goes again, and it does", () => {
    const home = oneRepoTeams();
    const theirs = hostRefusesTheirAidlcRefs(home.remote);
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedForItsPush(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(recordWent("refunds"));
    rmSync(theirs);
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "chat-again" };
    const { detail, repo } = sendAgain(alice, chat, "chat-again");
    expect(detail).toBe(`The result is sent to ${repo} again; once ${repo} takes it, AI-DLC's record of refunds goes in a commit of its own.`);
    const sent = run(UNIT, ["push"], alice, chat);
    expect(sent.status, sent.out).toBe(0);
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"]).split("\n").filter((line) => line === "refunds: AI-DLC's record").length)
      .toBeGreaterThan(1);
  });

  // Their host refuses this teammate's pushes of AI-DLC's own refs while the rule's file is there; the hook runs in
  // the host's repository, so the file is named from there.
  function hostRefusesTheirAidlcRefs(host: string): string {
    const rule = join(host, "hooks", "pre-receive");
    writeFileSync(rule, "#!/bin/sh\n[ -e their-aidlc-refs-refused ] || exit 0\n" +
      "while read old new ref; do case \"$ref\" in refs/aidlc/*|refs/heads/aidlc/*) echo 'AI-DLC refs are refused here' >&2; exit 1;; esac; done\nexit 0\n");
    chmodSync(rule, 0o755);
    const theirs = join(host, "their-aidlc-refs-refused");
    writeFileSync(theirs, "");
    return theirs;
  }

  test("their host refuses their pushes of AI-DLC's own refs from the take on: the first push makes the record commit, and once the Unit's branch is merged a fresh clone's board says it is being built and offers no start of it", () => {
    const home = oneRepoTeams();
    hostRefusesTheirAidlcRefs(home.remote);
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedForItsPush(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(recordWent("refunds"));
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"]).split("\n")).toEqual(["refunds: AI-DLC's record", "refunds: fixture"]);
    mergeOnHost(home.remote, "refunds", "merge");
    const bob = cloneOf(home.remote, "bob");
    const board = next(bob, { ...ENV, AIDLC_SESSION_OVERRIDE: "bob-1" }, ["--units"]);
    expect(String(board.question)).toContain("Being built: refunds");
    expect(((board.choices ?? []) as Array<{ label: string }>).map((choice) => choice.label)).not.toContain("Start refunds");
  });

  test("a take set aside, another's written on the lead's record before theirs could be: the first push makes the record commit", () => {
    const home = oneRepoTeams();
    const theirs = hostRefusesTheirAidlcRefs(home.remote);
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    approvedForItsPush(record);
    rmSync(theirs);
    const bob = cloneOf(home.remote, "bob");
    const took = takeIn("payments", ["refunds", ...fromHome(home)], bob);
    expect(took.status, took.out).toBe(0);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice);
    expect(said).toContain("before your take could be");
    expect(said).toContain(recordWent("refunds"));
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"]).split("\n")).toEqual(["refunds: AI-DLC's record", "refunds: fixture"]);
  });

  test("a build taken before AI-DLC kept its log in its engine folder writes on in its tracked audit file, as one log", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    // As such a build stands: its rows in the tracked audit file only.
    rmSync(ownLog(record), { force: true });
    noteEngineAskMark(alice, "probe-asked.json");
    const asked = engineAskMark(alice, "probe-asked.json");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(rowsOf(trackedLog(record)).some((row) => row.includes("**Event**: UNIT_PUSHED"))).toBe(true);
    expect(committedText(alice, trackedLog(record))).toContain("**Event**: UNIT_PUSHED");
    const said = hook(alice, personsChat("chat-1"), { hook_event_name: "UserPromptSubmit", session_id: "chat-1", prompt: "Yes, do that." });
    expect(said.status, said.out).toBe(0);
    expect(personRepliedAfter(alice, asked!)).toBe(true);
    expect(existsSync(ownLog(record))).toBe(false);
  });

  // A practice the person kept during a build, as learnings persist writes it into the build's space's rules.
  function practiceKept(dir: string, record: string, scope: "team" | "project", text: string): void {
    const path = writeLearningsSelections(dir, {
      space: basename(dirname(dirname(record))), intent: basename(record), stage_slug: "code-generation",
      selections: [{ candidate_id: "c1", type: "learning", scope, heading: "Corrections", text, source: "user_addition" }],
    });
    const kept = run(join(AIDLC_SRC, "tools", "aidlc-learnings.ts"), ["persist", "--slug", "code-generation", "--selections-json", path], dir);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.json?.rule_learned, kept.out).toBe(1);
  }
  const practiceLeft = (file: string): string =>
    `The practice you kept in ${file} is not in it: commit it your usual way when your team should have it.`;

  test("a practice kept for the team during a build in the lead's space is named once, in the record's line at the push that leaves it out", () => {
    const home = oneRepoTeams();
    const wen = cloneOf(home.remote, "wen");
    const record = builtHere(wen, "refunds", "refunds.ts", "default");
    practiceKept(wen, record, "team", "Test pages without a real browser");
    const pushed = run(UNIT, ["push"], wen);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice);
    expect(said).toEndWith(`${recordWent("refunds")} ${practiceLeft("aidlc/spaces/default/memory/team.md")}`);
    expect(said.split("The practice you kept").length, said).toBe(2);
    expect(git(wen, ["status", "--porcelain"])).toBe("M aidlc/spaces/default/memory/team.md");
    // The next push of the same Unit, the file unchanged since: not said again.
    writeFileSync(join(wen, "src", "refunds.ts"), 'export const built = "refunds, fixed";\n');
    const again = run(UNIT, ["push"], wen);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toContain(recordWent("refunds"));
    expect(String(again.json?.notice)).not.toContain("The practice you kept");
  });

  test("the line names the project's rules file for a practice kept for the project, and nothing for a rules file only the person changed", () => {
    const home = oneRepoTeams();
    const wen = cloneOf(home.remote, "wen");
    const record = builtHere(wen, "refunds", "refunds.ts", "default");
    const team = join(wen, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(team, `${readFileSync(team, "utf-8")}\nmy note\n`);
    practiceKept(wen, record, "project", "Keep refund handlers thin");
    const pushed = run(UNIT, ["push"], wen);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice);
    expect(said).toEndWith(`${recordWent("refunds")} ${practiceLeft("aidlc/spaces/default/memory/project.md")}`);
    expect(said).not.toContain("memory/team.md");
  });

  test("a push whose record does not go says nothing of a practice kept", () => {
    const home = oneRepoTeams();
    hostRefusesTheRecord(home.remote);
    const wen = cloneOf(home.remote, "wen");
    const record = builtHere(wen, "refunds", "refunds.ts", "default");
    practiceKept(wen, record, "team", "Test pages without a real browser");
    const pushed = run(UNIT, ["push", "--commit-message-file", commitMessage(wen, record, "PAY-7 refund handler for the checkout totals\n")], wen);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain("AI-DLC's record of refunds did not go with it");
    expect(String(pushed.json?.notice)).not.toContain("The practice you kept");
  });

  test("a practice kept for the team during a build in the lead's space, in a clone made before the lead's record reached main: the record goes, the practice is not named, and its rules file stays there untracked with the practice in it", () => {
    const { home, clone } = leadRecordOnItsOwnBranch(UNITS);
    const record = builtInClone(clone, home, "refunds", "refunds.ts");
    practiceKept(clone, record, "team", "Test pages without a real browser");
    const pushed = run(UNIT, ["push"], clone);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice);
    expect(said).toContain(recordWent("refunds"));
    expect(said).not.toContain("The practice you kept");
    expect(git(clone, ["status", "--porcelain", "--", "aidlc/spaces/default/memory/team.md"])).toBe("?? aidlc/spaces/default/memory/team.md");
    expect(readFileSync(join(clone, "aidlc", "spaces", "default", "memory", "team.md"), "utf-8")).toContain("Test pages without a real browser");
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
    // Their next message in the chat goes into refunds' own log, the work still selected, and leaves the file its
    // record commit took as it took it.
    const said = hook(alice, personsChat("chat-1"), { hook_event_name: "UserPromptSubmit", session_id: "chat-1", prompt: "I will take checkout-ui." });
    expect(said.status, said.out).toBe(0);
    const earlier = git(alice, ["status", "--porcelain"]);
    expect(earlier).toBe("");
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

  // An early start where a file of theirs that git does not track is where the
  // pushed branch it starts on has one: git would replace an ignored one. The
  // take keeps them where they are and says so in the maintainer's words; the
  // early take again, once it is moved, makes the push's own switch.
  const SCRATCH = "// dana's own scratch\n";
  const keptLine = (here: string, files: string, them = false): string => `I've kept you on ${here} for now: switching to reporting ` +
    `would overwrite your own ${files}. Move or rename ${them ? "them" : "it"}, then tell me and I'll switch you.`;
  const SWITCHED = "Carrying on reporting, your build in the data space. You are on branch reporting in the repo now.";
  // refunds pushed by alice with two files of its own; dana's clone, before her take.
  function refundsPushedTwoFiles(): { home: ReturnType<typeof makeHome>; dana: string } {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    writeFileSync(join(alice, "src", "refunds-total.ts"), "export const total = 0;\n");
    writeFileSync(join(record, "construction", "refunds", "code-generation", "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [{ path: "src/refunds.ts" }, { path: "src/refunds-total.ts" }],
    })}\n`);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    return { home, dana: cloneOf(home.remote, "dana") };
  }
  // A file of dana's own at `path`, which her git ignores unless `ignored` is false.
  function ownFile(dana: string, path: string, ignored = true): void {
    if (ignored) {
      mkdirSync(join(dana, ".git", "info"), { recursive: true });
      writeFileSync(join(dana, ".git", "info", "exclude"), `${path}\n`, { flag: "a" });
    }
    mkdirSync(dirname(join(dana, ...path.split("/"))), { recursive: true });
    writeFileSync(join(dana, ...path.split("/")), SCRATCH);
  }
  const moveAside = (dana: string, path: string): void => {
    const from = join(dana, ...path.split("/"));
    writeFileSync(`${from}.mine`, readFileSync(from));
    rmSync(from);
  };
  const takeEarly = (dana: string, home: ReturnType<typeof makeHome>, early = true, env: NodeJS.ProcessEnv = ENV) =>
    takeIn("data", ["reporting", ...fromHome(home), ...(early ? ["--early"] : [])], dana, env);
  // Code Generation of reporting in dana's build: its manifest names `files`.
  function reportingWrote(dana: string, files: string[]): void {
    const intents = join(dana, "aidlc", "spaces", "data", "intents");
    const stage = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!, "construction", "reporting", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "reporting", version: 1, writes: files.map((path) => ({ path })),
    })}\n`);
  }
  // A teammate's commit of a new file on refunds' branch on the host (a team command, say).
  function addedOnHost(host: string, path: string, text: string): void {
    const dir = join(tempDir("teammate"), "repo");
    git(tempDir("teammate-parent"), ["clone", "-q", "--branch", "refunds", host, dir]);
    mkdirSync(dirname(join(dir, ...path.split("/"))), { recursive: true });
    writeFileSync(join(dir, ...path.split("/")), text);
    git(dir, ["add", "--", path]);
    git(dir, ["-c", "user.name=teammate", "-c", "user.email=teammate@example.test", "commit", "-q", "-m", `add ${path}`]);
    git(dir, ["push", "-q", "origin", "refunds"]);
  }

  test("an early start where a file of theirs that git ignores is where the pushed branch has one keeps them where they are, the file as it was, in the maintainer's words", () => {
    const { home, dana } = refundsPushedTwoFiles();
    ownFile(dana, "src/refunds.ts");
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("It starts early on the pushed branch of refunds in the repo. It may still change before it merges. " +
      keptLine("main", "file src/refunds.ts"));
    expect(String(took.json?.notice)).not.toContain("your uncommitted changes kept you");
    expect(took.json?.left_on_branch).toBeUndefined();
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
    expect(readFileSync(join(dana, "src", "refunds.ts"), "utf-8")).toBe(SCRATCH);
    expect(git(dana, ["rev-parse", "reporting"])).toBe(git(home.remote, ["rev-parse", "refunds"]));
  });

  test("an early start kept by two files of theirs, one ignored and one untracked, names both", () => {
    const { home, dana } = refundsPushedTwoFiles();
    ownFile(dana, "src/refunds.ts");
    ownFile(dana, "src/refunds-total.ts", false);
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(keptLine("main", "files src/refunds-total.ts and src/refunds.ts", true));
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
    for (const file of ["refunds.ts", "refunds-total.ts"]) expect(readFileSync(join(dana, "src", file), "utf-8")).toBe(SCRATCH);
  });

  test("kept by a file of theirs: the early take again with it still there says so again and moves nothing; once it is moved, it puts them on the Unit's branch", () => {
    const { home, dana } = refundsPushedTwoFiles();
    ownFile(dana, "src/refunds.ts");
    expect(takeEarly(dana, home).status).toBe(0);
    const again = takeEarly(dana, home);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toBe(`Carrying on reporting, your build in the data space. ${keptLine("main", "file src/refunds.ts")}`);
    expect(again.json?.left_on_branch).toBeUndefined();
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
    expect(readFileSync(join(dana, "src", "refunds.ts"), "utf-8")).toBe(SCRATCH);
    moveAside(dana, "src/refunds.ts");
    const moved = takeEarly(dana, home);
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toBe(SWITCHED);
    expect(moved.json?.left_on_branch).toBeUndefined();
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    expect(git(dana, ["rev-parse", "HEAD"])).toBe(git(home.remote, ["rev-parse", "refunds"]));
    expect(readFileSync(join(dana, "src", "refunds.ts.mine"), "utf-8")).toBe(SCRATCH);
  });

  test("kept by a file of theirs, a plain take again of the build here never switches, on their branch or one of their own", () => {
    const { home, dana } = refundsPushedTwoFiles();
    ownFile(dana, "src/refunds.ts");
    expect(takeEarly(dana, home).status).toBe(0);
    moveAside(dana, "src/refunds.ts");
    const plain = takeEarly(dana, home, false);
    expect(plain.status, plain.out).toBe(0);
    expect(String(plain.json?.notice)).toBe("Carrying on reporting, your build in the data space.");
    expect(plain.json?.left_on_branch).toBeUndefined();
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
    git(dana, ["switch", "-q", "-c", "dana-notes"]);
    const ownBranch = takeEarly(dana, home, false);
    expect(ownBranch.status, ownBranch.out).toBe(0);
    expect(String(ownBranch.json?.notice)).toBe("Carrying on reporting, your build in the data space.");
    expect(ownBranch.json?.left_on_branch).toBeUndefined();
    expect(git(dana, ["branch", "--show-current"])).toBe("dana-notes");
  });

  test("kept by a file of theirs while on a branch of their own: the line names that branch, and the early take again switches them from there", () => {
    const { home, dana } = refundsPushedTwoFiles();
    git(dana, ["switch", "-q", "-c", "dana-notes"]);
    ownFile(dana, "src/refunds.ts");
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(keptLine("dana-notes", "file src/refunds.ts"));
    expect(git(dana, ["branch", "--show-current"])).toBe("dana-notes");
    moveAside(dana, "src/refunds.ts");
    const moved = takeEarly(dana, home);
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toBe(SWITCHED);
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
  });

  test("kept by a change of theirs to a file the Unit's branch has another copy of: the early take again leaves branch, index and files as they were, and switches them once it is committed", () => {
    const { home, dana } = refundsPushedTwoFiles();
    writeFileSync(join(dana, "NOTES.md"), "my note\n");
    git(dana, ["add", "NOTES.md"]);
    git(dana, ["commit", "-q", "-m", "my notes"]);
    writeFileSync(join(dana, "NOTES.md"), "my note, longer\n");
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("Branch reporting in the repo starts there; your uncommitted changes kept you on your branch, so switch when you are ready.");
    const before = { head: git(dana, ["rev-parse", "HEAD"]), index: git(dana, ["ls-files", "--stage", "--", ":!aidlc"]), status: git(dana, ["status", "--porcelain", "--", ":!aidlc"]) };
    const again = takeEarly(dana, home);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toBe("Carrying on reporting, your build in the data space. Branch reporting in the repo starts there; " +
      "your uncommitted changes kept you on your branch, so switch when you are ready.");
    expect(again.json?.left_on_branch).toBeUndefined();
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
    expect({ head: git(dana, ["rev-parse", "HEAD"]), index: git(dana, ["ls-files", "--stage", "--", ":!aidlc"]), status: git(dana, ["status", "--porcelain", "--", ":!aidlc"]) })
      .toEqual(before);
    expect(readFileSync(join(dana, "NOTES.md"), "utf-8")).toBe("my note, longer\n");
    git(dana, ["add", "NOTES.md"]);
    git(dana, ["commit", "-q", "-m", "my note"]);
    const committed = takeEarly(dana, home);
    expect(committed.status, committed.out).toBe(0);
    expect(String(committed.json?.notice)).toBe(SWITCHED);
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
  });

  test("kept by a change of theirs to a file the Unit's branch has the same copy of: the early take again carries it onto the Unit's branch, and the push leaves it theirs", () => {
    const home = oneRepoTeams();
    leadCommits(home, "main", "README.md");
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const dana = cloneOf(home.remote, "dana");
    writeFileSync(join(dana, "README.md"), "README.md\nmy edit\n");
    // The first early start, which nobody asked to switch them, keeps them for it, as it always has.
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("Branch reporting in the repo starts there; your uncommitted changes kept you on your branch, so switch when you are ready.");
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
    const again = takeEarly(dana, home);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toBe(SWITCHED);
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    expect(readFileSync(join(dana, "README.md"), "utf-8")).toBe("README.md\nmy edit\n");
    expect(git(dana, ["status", "--porcelain", "--", "README.md"])).toBe("M README.md");
    const intents = join(dana, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    writeFileSync(join(dana, "src", "reporting.ts"), "export const report = 1;\n");
    const stage = join(record, "construction", "reporting", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "reporting", version: 1, writes: [{ path: "src/reporting.ts" }],
    })}\n`);
    const pushed = run(UNIT, ["push"], dana);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["show", "reporting:README.md"])).toBe("README.md");
    expect(git(home.remote, ["show", "reporting:src/reporting.ts"])).toBe("export const report = 1;");
    expect(readFileSync(join(dana, "README.md"), "utf-8")).toBe("README.md\nmy edit\n");
    expect(git(dana, ["status", "--porcelain", "--", "README.md"])).toBe("M README.md");
    // Already on the Unit's branch, the push moves nothing, so it names no change of theirs (whereNowLine).
    expect(String(pushed.json?.notice)).toBe("Pushed branch reporting in the repo. Get it merged your usual way. AI-DLC's record of reporting went with it, in a commit of its own.");
  });

  test("kept by a file of theirs with the Unit's files already written where they were kept: the early take again carries them onto the Unit's branch", () => {
    const { home, dana } = refundsPushedTwoFiles();
    ownFile(dana, "src/refunds-total.ts");
    expect(takeEarly(dana, home).status).toBe(0);
    const intents = join(dana, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    // Code Generation where they were kept: a file of its own, and its change to one the pushed branch has too.
    writeFileSync(join(dana, "src", "reporting.ts"), "export const report = 1;\n");
    writeFileSync(join(dana, "src", "refunds.ts"), "export const built = \"refunds\"; // reported\n");
    const stage = join(record, "construction", "reporting", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "reporting", version: 1, writes: [{ path: "src/reporting.ts" }, { path: "src/refunds.ts" }],
    })}\n`);
    moveAside(dana, "src/refunds-total.ts");
    const moved = takeEarly(dana, home);
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toBe(SWITCHED);
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    expect(readFileSync(join(dana, "src", "refunds.ts"), "utf-8")).toBe("export const built = \"refunds\"; // reported\n");
    expect(readFileSync(join(dana, "src", "reporting.ts"), "utf-8")).toBe("export const report = 1;\n");
    expect(git(dana, ["status", "--porcelain", "--", "src"])).toBe("M src/refunds.ts\n?? src/refunds-total.ts.mine\n?? src/reporting.ts");
  });

  test("kept by a file of theirs in a clone made before the lead's record reached main: the early take again switches them, AI-DLC's own memory files no stop", () => {
    const { home, clone: kai, mergeLeadRecord } = leadRecordOnItsOwnBranch(UNITS);
    mergeLeadRecord();
    const lee = cloneOf(home.remote, "lee");
    builtInClone(lee, home, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push"], lee);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["ls-tree", "-r", "--name-only", "refunds", "--", "aidlc/spaces/default/memory/org.md"])).toBe("aidlc/spaces/default/memory/org.md");
    seedsAsLaid(kai);
    ownFile(kai, "src/refunds.ts");
    const took = takeEarly(kai, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(keptLine("main", "file src/refunds.ts"));
    moveAside(kai, "src/refunds.ts");
    const moved = takeEarly(kai, home);
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toBe(SWITCHED);
    expect(git(kai, ["branch", "--show-current"])).toBe("reporting");
    expect(git(kai, ["status", "--porcelain", "--", "aidlc/spaces/default/memory"])).toBe("");
  });

  test("kept by a file of theirs while on a branch of their own that now holds the Unit's commit: the early take again leaves them there, the commit with them", () => {
    const { home, dana } = refundsPushedTwoFiles();
    git(dana, ["switch", "-q", "-c", "dana-work"]);
    ownFile(dana, "src/refunds.ts");
    expect(takeEarly(dana, home).status).toBe(0);
    writeFileSync(join(dana, "src", "reporting.ts"), "export const report = 1;\n");
    git(dana, ["add", "src/reporting.ts"]);
    git(dana, ["commit", "-q", "-m", "reporting"]);
    reportingWrote(dana, ["src/reporting.ts"]);
    moveAside(dana, "src/refunds.ts");
    const again = takeEarly(dana, home);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toBe("Carrying on reporting, your build in the data space.");
    // Only the agent reads why: the reply's own key, nothing for the person.
    expect(again.json?.left_on_branch).toBe("The person is still on dana-work in the repo: their own commits there change reporting's files, " +
      "so they were not switched. If they asked to be switched, tell them so in one line.");
    expect(git(dana, ["branch", "--show-current"])).toBe("dana-work");
    expect(git(dana, ["log", "-1", "--format=%s"])).toBe("reporting");
  });

  test("kept by a file of theirs on main, then main pulled with a change to one of the Unit's files: the early take again switches them, the lead's commit never read as theirs", () => {
    const home = oneRepoTeams();
    leadCommits(home, "main", "README.md");
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const dana = cloneOf(home.remote, "dana");
    ownFile(dana, "src/refunds.ts");
    expect(takeEarly(dana, home).status).toBe(0);
    writeFileSync(join(home.dir, "README.md"), "README.md\nfrom the lead\n");
    git(home.dir, ["commit", "-q", "-am", "lead: readme"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    git(dana, ["pull", "-q", "--ff-only", "origin", "main"]);
    reportingWrote(dana, ["README.md", "src/reporting.ts"]);
    writeFileSync(join(dana, "src", "reporting.ts"), "export const report = 1;\n");
    moveAside(dana, "src/refunds.ts");
    const moved = takeEarly(dana, home);
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toBe(SWITCHED);
    expect(moved.json?.left_on_branch).toBeUndefined();
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
  });

  test("kept by a file of theirs while on a branch of their own with a commit of theirs that is not the Unit's: the early take again switches them, the commit staying on their branch", () => {
    const { home, dana } = refundsPushedTwoFiles();
    git(dana, ["switch", "-q", "-c", "dana-notes"]);
    writeFileSync(join(dana, "NOTES.md"), "my note\n");
    git(dana, ["add", "NOTES.md"]);
    git(dana, ["commit", "-q", "-m", "my notes"]);
    ownFile(dana, "src/refunds.ts");
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(keptLine("dana-notes", "file src/refunds.ts"));
    reportingWrote(dana, ["src/reporting.ts"]);
    writeFileSync(join(dana, "src", "reporting.ts"), "export const report = 1;\n");
    moveAside(dana, "src/refunds.ts");
    const moved = takeEarly(dana, home);
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toBe(SWITCHED);
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    expect(git(dana, ["log", "-1", "--format=%s", "dana-notes"])).toBe("my notes");
    expect(readFileSync(join(dana, "src", "reporting.ts"), "utf-8")).toBe("export const report = 1;\n");
  });

  test("kept by a file of theirs in a clone whose install left AI-DLC's part of the tracked .gitignore uncommitted, where the Unit's branch has another copy: the early take again switches them", () => {
    const { home, dana } = refundsPushedTwoFiles();
    const ignore = git(home.remote, ["show", "refunds:.gitignore"]);
    commitOnHost(home.remote, "refunds", { ".gitignore": `${ignore}\ncoverage/\n` }, "ignore coverage");
    configured(dana, "claude");
    expect(git(dana, ["status", "--porcelain", "--", ".gitignore"])).toBe("M .gitignore");
    ownFile(dana, "src/refunds.ts");
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(keptLine("main", "file src/refunds.ts"));
    moveAside(dana, "src/refunds.ts");
    const moved = takeEarly(dana, home);
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toBe(SWITCHED);
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    expect(readFileSync(join(dana, ".gitignore"), "utf-8")).toContain("coverage/");
  });

  test("an ignored file of theirs in a harness folder, where the pushed branch has one, is named as theirs and never replaced", () => {
    const { home, dana } = refundsPushedTwoFiles();
    addedOnHost(home.remote, ".claude/commands/review.md", "the team's command\n");
    ownFile(dana, ".claude/commands/review.md");
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(keptLine("main", "file .claude/commands/review.md"));
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
    expect(readFileSync(join(dana, ".claude", "commands", "review.md"), "utf-8")).toBe(SCRATCH);
  });

  test("kept by a file of theirs with another untracked file of theirs beside it: the line names the file in the way, and the early take again switches them", () => {
    const { home, dana } = refundsPushedTwoFiles();
    ownFile(dana, "src/refunds.ts");
    writeFileSync(join(dana, "TODO.txt"), "my list\n");
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(keptLine("main", "file src/refunds.ts"));
    expect(String(took.json?.notice)).not.toContain("your uncommitted changes kept you");
    moveAside(dana, "src/refunds.ts");
    const moved = takeEarly(dana, home);
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toBe(SWITCHED);
    expect(readFileSync(join(dana, "TODO.txt"), "utf-8")).toBe("my list\n");
  });

  test("an early start in the space its dependency was pushed from never names AI-DLC's record there as files of theirs", () => {
    const { home, dana } = refundsPushedTwoFiles();
    const took = takeIn("payments", ["reporting", ...fromHome(home), "--early"], dana);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).not.toContain("your own file");
    expect(String(took.json?.notice)).not.toContain("aidlc/spaces/payments");
  });

  test("kept by a file of theirs and built where they were kept, the push stops with git's words and keeps their file", () => {
    const { home, dana } = refundsPushedTwoFiles();
    ownFile(dana, "src/refunds-total.ts");
    expect(takeEarly(dana, home).status).toBe(0);
    const intents = join(dana, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    writeFileSync(join(dana, "src", "reporting.ts"), "export const report = 1;\n");
    const stage = join(record, "construction", "reporting", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "reporting", version: 1, writes: [{ path: "src/reporting.ts" }],
    })}\n`);
    const pushed = run(UNIT, ["push"], dana);
    expect(pushed.status, pushed.out).not.toBe(0);
    expect(String(pushed.json?.error)).toBe("Branch reporting could not be checked out in the repo, so nothing was pushed. Git says: " +
      '"The following untracked working tree files would be overwritten by checkout: src/refunds-total.ts". Your own changes there stay ' +
      "as they are; once they are committed or put aside, I can push reporting.");
    expect(readFileSync(join(dana, "src", "refunds-total.ts"), "utf-8")).toBe(SCRATCH);
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
    expect(git(home.remote, ["branch", "--list", "reporting"])).toBe("");
  });

  test("an ignored file of theirs where the pushed branch has a folder is never replaced by the early start's switch", () => {
    const { home, dana } = refundsPushedTwoFiles();
    mkdirSync(join(dana, ".git", "info"), { recursive: true });
    writeFileSync(join(dana, ".git", "info", "exclude"), "/src\n", { flag: "a" });
    writeFileSync(join(dana, "src"), SCRATCH);
    const took = takeEarly(dana, home);
    expect(took.status, took.out).toBe(0);
    expect(git(dana, ["branch", "--show-current"])).toBe("main");
    expect(readFileSync(join(dana, "src"), "utf-8")).toBe(SCRATCH);
  });

  test("kept on main at an early start, the Unit's file committed there by hand, then pushed: the push carries it onto the Unit's branch, and their commit stays on main", () => {
    const { home, dana } = refundsPushedTwoFiles();
    ownFile(dana, "src/refunds.ts");
    expect(takeEarly(dana, home).status).toBe(0);
    moveAside(dana, "src/refunds.ts");
    writeFileSync(join(dana, "src", "reporting.ts"), "export const report = 1;\n");
    git(dana, ["add", "src/reporting.ts"]);
    git(dana, ["commit", "-q", "-m", "reporting, my own commit"]);
    const mine = git(dana, ["rev-parse", "HEAD"]);
    reportingWrote(dana, ["src/reporting.ts"]);
    const pushed = run(UNIT, ["push"], dana);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["show", "reporting:src/reporting.ts"])).toBe("export const report = 1;");
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    expect(git(dana, ["rev-parse", "main"])).toBe(mine);
    expect(String(pushed.json?.notice)).toContain("Pushed branch reporting in the repo. Get it merged your usual way.");
  });

  test("kept by a file of theirs in a chat: the agent's note hands over the early take again, and that command switches them once the file is moved", () => {
    const { home, dana } = refundsPushedTwoFiles();
    ownFile(dana, "src/refunds.ts");
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "chat-1" };
    const took = takeEarly(dana, home, true, chat);
    expect(took.status, took.out).toBe(0);
    const step = next(dana, chat);
    expect(((step.change_notices ?? []) as string[]).some((line) => line.endsWith(keptLine("main", "file src/refunds.ts"))), JSON.stringify(step).slice(0, 800)).toBe(true);
    const note = String(step.change_notices_note);
    const command = /When the person says the file is moved, run `([^`]+)` and then `([^`]+)`, and follow what it returns\./.exec(note);
    expect(command, note).not.toBeNull();
    // As a POSIX shell reads the printed words: each single-quoted one is one word.
    const words = command![1].replace(/^.*aidlc-unit\.ts /, "").split(" ").filter(Boolean).map((word) => word.replace(/^'(.*)'$/, "$1"));
    expect(words).toEqual(["take", "reporting", "--plan", fixtureIntentId8(home.dir), "--from", home.remote, "--early"]);
    expect(command![2]).toEndWith(" next");
    moveAside(dana, "src/refunds.ts");
    const ran = run(UNIT, words, dana, chat);
    expect(ran.status, ran.out).toBe(0);
    expect(git(dana, ["branch", "--show-current"])).toBe("reporting");
    const after = next(dana, chat);
    expect((after.change_notices ?? []) as string[], JSON.stringify(after).slice(0, 800)).toContain(SWITCHED);
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
      .toEqual(["PAY-7 refund handler", "PAY-7 refund handler"]);
    expect(git(home.remote, ["log", "-1", "--format=%b", "refunds"])).toBe("AI-DLC's record of refunds.");
  });

  test("their hook refuses a subject the last commit already has: the code goes, the record commit is not made, the line says so once in the hook's words, and nothing of the record is left staged or gone", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const hookFile = join(alice, ".git", "hooks", "commit-msg");
    writeFileSync(hookFile, "#!/bin/sh\n[ \"$(head -n 1 \"$1\")\" = \"$(git log -1 --format=%s 2>/dev/null)\" ] || exit 0\n" +
      "echo 'commit-msg: a subject the last commit already has' >&2\nexit 1\n");
    chmodSync(hookFile, 0o755);
    const record = builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push", "--commit-message-file", commitMessage(alice, record, "PAY-7 refund handler\n")], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"])).toBe("PAY-7 refund handler");
    expect(git(alice, ["rev-parse", "refunds"])).toBe(git(home.remote, ["rev-parse", "refunds"]));
    const said = String(pushed.json?.notice);
    expect(said.split("AI-DLC's record of refunds did not go with it").length, said).toBe(2);
    expect(said).toEndWith("AI-DLC's record of refunds did not go with it: commit-msg: a subject the last commit already has.");
    expect(git(alice, ["diff", "--cached", "--name-only"])).toBe("");
    // The record is still theirs to check in: every file of it there, untracked.
    const folder = relative(alice, record).split(/[\\/]/).join("/");
    const left = git(alice, ["status", "--porcelain", "--untracked-files=all", "--", folder]).split("\n");
    expect(left).toContain(`?? ${folder}/aidlc-state.md`);
    expect(left.every((line) => line.startsWith("?? ")), left.join("\n")).toBe(true);
  });

  test("their message with a body and a sign-off: the record's commit keeps their first line, names the record first in its body, and the sign-off stays last", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const record = builtHere(alice, "refunds", "refunds.ts");
    const message = "PAY-7 refund handler\n\nRefunds go through the ledger.\n\nSigned-off-by: alice <alice@example.test>\n";
    const pushed = run(UNIT, ["push", "--commit-message-file", commitMessage(alice, record, message)], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const recordMessage = spawnSync("git", ["log", "-1", "--format=%B", "refunds"], { cwd: home.remote, encoding: "utf-8", env: ENV }).stdout;
    expect(recordMessage.trimEnd()).toBe("PAY-7 refund handler\n\nAI-DLC's record of refunds.\n\nRefunds go through the ledger.\n\nSigned-off-by: alice <alice@example.test>");
    const trailers = spawnSync("git", ["interpret-trailers", "--parse"], { cwd: home.remote, encoding: "utf-8", env: ENV, input: recordMessage }).stdout;
    expect(trailers.trim()).toBe("Signed-off-by: alice <alice@example.test>");
  });

  // Their commit-msg hook keeps subjects to 50 characters: their own message
  // fits, and the record's commit keeps their first line.
  test("their hook keeps subjects to 50 characters: their own subject fits, the record's commit keeps it, and both go", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    const hook = join(alice, ".git", "hooks", "commit-msg");
    writeFileSync(hook, "#!/bin/sh\n[ $(head -n 1 \"$1\" | wc -c) -le 51 ] && exit 0\necho 'commit-msg: subject is longer than 50 characters' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const record = builtHere(alice, "refunds", "refunds.ts");
    const pushed = run(UNIT, ["push", "--commit-message-file", commitMessage(alice, record, "PAY-7 refund handler for the checkout totals\n")], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(git(home.remote, ["log", "--format=%s", "main..refunds"]).split("\n"))
      .toEqual(["PAY-7 refund handler for the checkout totals", "PAY-7 refund handler for the checkout totals"]);
    expect(git(home.remote, ["log", "-1", "--format=%b", "refunds"])).toBe("AI-DLC's record of refunds.");
    expect(git(alice, ["rev-parse", "refunds"])).toBe(git(home.remote, ["rev-parse", "refunds"]));
    expect(String(pushed.json?.notice)).toEndWith(recordWent("refunds"));
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
  // AI-DLC's part of .gitignore and AGENTS.md as each teammate's config leaves it: uncommitted.
  const OWN_PART = "# BEGIN AI-DLC:gitignore";
  const IGNORES = "data/\nnode_modules/\n";
  const appended = (lines: string) => (text: string): string => `${text}${lines}`;
  // A build that also changes root files of the workspace: each change gets the file's text and returns the new one.
  function builtWithRootFiles(dir: string, unit: string, file: string, change: Record<string, (text: string) => string>): string {
    const record = builtHere(dir, unit, file);
    for (const [path, edit] of Object.entries(change)) {
      const at = join(dir, path);
      writeFileSync(at, edit(existsSync(at) ? readFileSync(at, "utf-8") : ""));
    }
    const manifest = join(record, "construction", unit, "code-generation", "source-manifest.json");
    const written = JSON.parse(readFileSync(manifest, "utf-8")) as { writes: Array<{ path: string }> };
    writeFileSync(manifest, `${JSON.stringify({ ...written, writes: [...written.writes, ...Object.keys(change).map((path) => ({ path }))] })}\n`);
    return record;
  }
  // The lead's repository with no .gitignore, so each teammate's config writes it new; the lead's own lines in git's exclude.
  function withoutGitignore(home: ReturnType<typeof makeHome>): void {
    writeFileSync(join(home.dir, ".git", "info", "exclude"), readFileSync(join(home.dir, ".gitignore"), "utf-8"));
    git(home.dir, ["rm", "-q", "--cached", ".gitignore"]);
    rmSync(join(home.dir, ".gitignore"));
    git(home.dir, ["commit", "-q", "-m", "no .gitignore"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
  }
  // The lead's main moving .gitignore by a line of its own, at the end or at the top.
  function leadsIgnoreLine(home: ReturnType<typeof makeHome>, line: string, atTop = false): string {
    const file = join(home.dir, ".gitignore");
    const text = readFileSync(file, "utf-8");
    writeFileSync(file, atTop ? `${line}\n${text}` : `${text}${line}\n`);
    git(home.dir, ["commit", "-q", "-am", `lead: ignore ${line}`]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    return git(home.dir, ["rev-parse", "HEAD"]);
  }
  // A suggestion committed on the Unit's pull request: a line at the top of its .gitignore.
  const suggestedIgnore = (host: string, branch: string): string =>
    commitOnHost(host, branch, { ".gitignore": `dist/\n${git(host, ["show", `${branch}:.gitignore`])}\n` }, "Apply 1 suggestion(s) to 1 file(s)");
  const takeTreeKeys = (record: string): string[] => {
    const file = join(record, ".aidlc-engine", "take-tree.json");
    return existsSync(file) ? Object.keys((JSON.parse(readFileSync(file, "utf-8")) as Record<string, Record<string, string>>)["."] ?? {}) : [];
  };
  // Back on their own main from the Unit's branch, with config's part on main's copy of .gitignore.
  function backOnMainWithPart(alice: string): string {
    const text = readFileSync(join(alice, ".gitignore"), "utf-8");
    const part = text.slice(text.indexOf(OWN_PART), text.indexOf("# END AI-DLC:gitignore") + "# END AI-DLC:gitignore".length);
    git(alice, ["checkout", "--", ".gitignore"]);
    git(alice, ["switch", "-q", "main"]);
    const back = `${readFileSync(join(alice, ".gitignore"), "utf-8")}\n${part}\n`;
    writeFileSync(join(alice, ".gitignore"), back);
    return back;
  }
  // AI-DLC's part installed and committed in the clone before the take, as a team that keeps it does.
  function installCommitted(alice: string, harness: string): void {
    configured(alice, harness);
    git(alice, ["add", "-A"]);
    git(alice, ["commit", "-q", "-m", "AI-DLC install"]);
    git(alice, ["push", "-q", "origin", "main"]);
  }

  for (const harness of ["kiro", "codex"]) {
    for (const made of [false, true]) {
      test(`${harness}, ${made ? "a .gitignore config writes new" : "the repository's .gitignore"} with config's part uncommitted: the build's ignore lines go with the Unit, the part stays uncommitted`, () => {
        const home = oneRepoTeams();
        if (made) withoutGitignore(home);
        const alice = cloneOf(home.remote, "alice");
        configured(alice, harness);
        const head = made ? "" : `${git(alice, ["show", "HEAD:.gitignore"])}\n`;
        const record = builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES) });
        const here = readFileSync(join(alice, ".gitignore"), "utf-8");
        const pushed = run(UNIT, ["push"], alice);
        expect(pushed.status, pushed.out).toBe(0);
        const said = String(pushed.json?.notice);
        expect(said).not.toContain("is not in the commit");
        expect(`${git(home.remote, ["show", "refunds:.gitignore"])}\n`).toBe(`${head}${IGNORES}`);
        expect(prFiles(home.remote, "main", "refunds")).toEqual([".gitignore", "src/refunds.ts"]);
        expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toBe(here);
        expect(git(alice, ["status", "--porcelain", "--", ".gitignore"])).toBe("M .gitignore");
        expect(takeTreeKeys(record)).not.toContain(".gitignore");
        // Against the Unit's commit the file still holds AI-DLC's part alone beside it.
        expect(workToCommit(alice).paths).not.toContain(".gitignore");
        // git refuses their own switch back over that part, so the way back is not offered.
        expect(said).toContain("You're on refunds now in the repo. AI-DLC's record of refunds went with it");
        expect(spawnSync("git", ["switch", "-q", "main"], { cwd: alice, encoding: "utf-8" }).status).not.toBe(0);
      });
    }
  }

  test("a checkout with CRLF line endings: the Unit's ignore lines go as git stores them", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    git(alice, ["config", "core.autocrlf", "true"]);
    rmSync(join(alice, ".gitignore"));
    git(alice, ["checkout", "--", ".gitignore"]);
    configured(alice, "kiro");
    const head = `${git(alice, ["show", "HEAD:.gitignore"])}\n`;
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES.replace(/\n/g, "\r\n")) });
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(spawnSync("git", ["cat-file", "blob", "refunds:.gitignore"], { cwd: home.remote, encoding: "utf-8" }).stdout).toBe(`${head}${IGNORES}`);
  });

  test("a .gitignore saved with a byte-order mark: the Unit's lines go and the mark stays, AI-DLC's part does not go", () => {
    const home = oneRepoTeams();
    const file = join(home.dir, ".gitignore");
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(file)]));
    git(home.dir, ["commit", "-q", "-am", "lead: .gitignore with a byte-order mark"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "kiro");
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES) });
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const blob = (ref: string): Buffer => spawnSync("git", ["cat-file", "blob", ref], { cwd: home.remote }).stdout as Buffer;
    expect(blob("refunds:.gitignore").equals(Buffer.concat([blob("main:.gitignore"), Buffer.from(IGNORES)]))).toBe(true);
  });

  // AI-DLC's .gitattributes part, which config puts FIRST in the file (a line of the team's below it wins), as each
  // teammate's config leaves it: uncommitted. Kiro ships none; Codex does.
  const OWN_ATTRIBUTES = "# BEGIN AI-DLC:gitattributes";
  const ATTRIBUTES = "*.pdf binary\n";
  function leadsAttributes(home: ReturnType<typeof makeHome>, text: string): void {
    writeFileSync(join(home.dir, ".gitattributes"), text);
    git(home.dir, ["add", "--", ".gitattributes"]);
    git(home.dir, ["commit", "-q", "-m", "lead: .gitattributes"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
  }
  const blob = (host: string, ref: string): Buffer => spawnSync("git", ["cat-file", "blob", ref], { cwd: host }).stdout as Buffer;

  for (const made of [true, false]) {
    test(`${made ? "a .gitattributes config writes new" : "the repository's .gitattributes with AI-DLC's part put first"}, uncommitted: the take leaves it to the Unit, the build's line goes with it, the part stays`, () => {
      const home = oneRepoTeams();
      if (!made) leadsAttributes(home, "*.png binary\n");
      const alice = cloneOf(home.remote, "alice");
      configured(alice, "codex");
      expect(readFileSync(join(alice, ".gitattributes"), "utf-8")).toStartWith(OWN_ATTRIBUTES);
      const record = builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitattributes": appended(ATTRIBUTES) });
      const here = readFileSync(join(alice, ".gitattributes"), "utf-8");
      const pushed = run(UNIT, ["push"], alice);
      expect(pushed.status, pushed.out).toBe(0);
      expect(String(pushed.json?.notice)).not.toContain("is not in the commit");
      expect(blob(home.remote, "refunds:.gitattributes").toString("utf-8")).toBe(`${made ? "" : "*.png binary\n"}${ATTRIBUTES}`);
      expect(prFiles(home.remote, "main", "refunds")).toContain(".gitattributes");
      expect(readFileSync(join(alice, ".gitattributes"), "utf-8")).toBe(here);
      expect(takeTreeKeys(record)).not.toContain(".gitattributes");
      expect(workToCommit(alice).paths).not.toContain(".gitattributes");
    });
  }

  test("a .gitattributes saved with a byte order mark, AI-DLC's part after it: the Unit's line goes and the mark stays, the part does not go", () => {
    const home = oneRepoTeams();
    leadsAttributes(home, "\uFEFF*.png binary\n");
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "codex");
    expect(readFileSync(join(alice, ".gitattributes"), "utf-8")).toStartWith(`\uFEFF${OWN_ATTRIBUTES}`);
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitattributes": appended(ATTRIBUTES) });
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(blob(home.remote, "refunds:.gitattributes").equals(Buffer.concat([blob(home.remote, "main:.gitattributes"), Buffer.from(ATTRIBUTES)]))).toBe(true);
  });

  test("bringing main in where main's .gitattributes moved: the part is set aside for the merge and back after it, first in the file, never in the Unit's commit", () => {
    const home = oneRepoTeams();
    leadsAttributes(home, "*.png binary\n");
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "codex");
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitattributes": appended(ATTRIBUTES) });
    leadsAttributes(home, "*.svg text\n*.png binary\n");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(next(alice).ask_type).toBe("unit-main-moved");
    const merged = run(UNIT, ["push", "--merge-main"], alice);
    expect(merged.status, merged.out).toBe(0);
    expect(String(merged.json?.notice)).toContain("Merged origin/main into refunds in the repo and pushed refunds.");
    expect(blob(home.remote, "refunds:.gitattributes").toString("utf-8")).toBe(`*.svg text\n*.png binary\n${ATTRIBUTES}`);
    const now = readFileSync(join(alice, ".gitattributes"), "utf-8");
    expect(now).toStartWith(OWN_ATTRIBUTES);
    expect(now).toEndWith(`\n\n*.svg text\n*.png binary\n${ATTRIBUTES}`);
    expect(workToCommit(alice).paths).not.toContain(".gitattributes");
  });

  test("with the part on main, every path of the work's record in the Unit's request reads as generated, the rules and the code do not", () => {
    const home = oneRepoTeams();
    configured(home.dir, "codex");
    git(home.dir, ["add", "--", ".gitattributes"]);
    git(home.dir, ["commit", "-q", "-m", "AI-DLC's .gitattributes"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const changed = git(home.remote, ["diff", "--name-only", "main...refunds"]).split("\n").filter(Boolean);
    // The host's copy of refunds is a clone of it: check-attr --source on a bare repository needs git 2.40 or later.
    const copy = cloneOf(home.remote, "copy");
    git(copy, ["checkout", "-q", "--detach", "origin/refunds"]);
    const read = spawnSync("git", ["check-attr", "--stdin", "linguist-generated", "gitlab-generated"], {
      cwd: copy, encoding: "utf-8", input: `${changed.join("\n")}\n`,
    });
    expect(read.status, `git check-attr: ${read.stderr}`).toBe(0);
    const checked = read.stdout.split("\n").filter(Boolean);
    const work = changed.filter((path) => /^aidlc\/spaces\/[^/]+\/intents\//.test(path));
    expect(work.length).toBeGreaterThan(0);
    for (const path of changed) {
      const value = work.includes(path) ? "set" : "unspecified";
      expect(checked).toContain(`${path}: linguist-generated: ${value}`);
      expect(checked).toContain(`${path}: gitlab-generated: ${value}`);
    }
    expect(changed).toContain("src/refunds.ts");
  });

  for (const [harness, kept] of [["kiro", false], ["codex", true]] as const) {
    test(`${harness}, ${kept ? "the team's AGENTS.md" : "an AGENTS.md config writes new"}: the build's section goes with the Unit, AI-DLC's part stays uncommitted`, () => {
      const home = oneRepoTeams();
      if (kept) leadCommits(home, "main", "AGENTS.md");
      const alice = cloneOf(home.remote, "alice");
      configured(alice, harness);
      builtWithRootFiles(alice, "refunds", "refunds.ts", { "AGENTS.md": appended("\n## Refunds\n\nRun the refund tests before a push.\n") });
      const pushed = run(UNIT, ["push"], alice);
      expect(pushed.status, pushed.out).toBe(0);
      expect(String(pushed.json?.notice)).not.toContain("is not in the commit");
      expect(git(home.remote, ["show", "refunds:AGENTS.md"])).toBe(`${kept ? "AGENTS.md\n" : ""}## Refunds\n\nRun the refund tests before a push.`);
      expect(readFileSync(join(alice, "AGENTS.md"), "utf-8")).toContain("<!-- BEGIN AI-DLC:agents -->");
    });
  }

  test("a second Unit in the same clone adds its own ignore line: it goes with that Unit, the first Unit's lines are not taken for the person's", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "kiro");
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES) });
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const record = builtWithRootFiles(alice, "checkout-ui", "cart.ts", { ".gitignore": appended("coverage/\n") });
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).not.toContain("is not in the commit");
    expect(git(home.remote, ["show", "checkout-ui:.gitignore"])).toEndWith(`${IGNORES}coverage/`);
    expect(takeTreeKeys(record)).not.toContain(".gitignore");
  });

  test("main moves .gitignore after the take: the Unit's own ignore line still goes with it", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "kiro");
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended("coverage/\n") });
    leadsIgnoreLine(home, "dist/");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).not.toContain("is not in the commit");
    expect(git(home.remote, ["show", "refunds:.gitignore"])).toEndWith("coverage/");
  });

  test("the lead's checkout holds config's part uncommitted and a merged Unit changed .gitignore: the catch-up brings main up to date, the part still there", () => {
    const home = oneRepoTeams(TWO);
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "kiro");
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES) });
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    squashInto(home.remote, "main", "refunds");
    builtHere(alice, "checkout-ui", "cart.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    squashInto(home.remote, "main", "checkout-ui");
    suggestedIgnore(home.remote, "main");
    configured(home.dir, "kiro");
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(toBuildAndTest(home.dir).question).toBe(CATCH_UP_QUESTION);
    const caught = run(UNIT, ["catch-up"], home.dir);
    expect(caught.status, caught.out).toBe(0);
    expect(caught.json?.notice).toBe("main is up to date with origin/main now, with every merged Unit.");
    const now = readFileSync(join(home.dir, ".gitignore"), "utf-8");
    expect(now).toStartWith("dist/\n");
    expect(now).toContain(OWN_PART);
    expect(existsSync(join(home.dir, "src", "cart.ts"))).toBe(true);
  });

  test("the lead's main moved .gitignore after the take: the Unit's branch is cut from it over config's part, never from the clone's own main", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "kiro");
    builtHere(alice, "refunds", "refunds.ts");
    const leadsTip = leadsIgnoreLine(home, "dist/");
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(spawnSync("git", ["merge-base", "--is-ancestor", leadsTip, "refunds"], { cwd: home.remote }).status, pushed.out).toBe(0);
    const now = readFileSync(join(alice, ".gitignore"), "utf-8");
    expect(now).toContain("dist/\n");
    expect(now).toContain(OWN_PART);
  });

  test("an early start on a pushed branch that changes .gitignore, in a clone with config's part uncommitted: they are on the Unit's branch, the part still there", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    builtHere(alice, "refunds", "refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    suggestedIgnore(home.remote, "refunds");
    const dana = cloneOf(home.remote, "dana");
    configured(dana, "kiro");
    const took = takeIn("data", ["reporting", ...fromHome(home), "--early"], dana);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("You are on branch reporting in the repo now.");
    const now = readFileSync(join(dana, ".gitignore"), "utf-8");
    expect(now).toStartWith("dist/\n");
    expect(now).toContain(OWN_PART);
  });

  // Main moves .gitignore under a Unit that changes it, so the push starts where the clone is and the offer to
  // bring main in follows; `hooked`: their hook refuses merges.
  function mainMovesIgnore(atTop: boolean, alsoCode = false, hooked = false) {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "kiro");
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES) });
    leadsIgnoreLine(home, "dist/", atTop);
    if (alsoCode) {
      mkdirSync(join(home.dir, "src"), { recursive: true });
      leadCommits(home, "main", "src/refunds.ts");
    }
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(next(alice).ask_type).toBe("unit-main-moved");
    if (hooked) {
      writeFileSync(join(alice, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\necho 'no merges on Fridays' >&2\nexit 1\n");
      chmodSync(join(alice, ".git", "hooks", "pre-merge-commit"), 0o755);
    }
    return { home, alice, merged: run(UNIT, ["push", "--merge-main"], alice) };
  }

  test("bringing main in over config's part: the part is set aside for the merge and back after it, never in the Unit's commit", () => {
    const { home, alice, merged } = mainMovesIgnore(true);
    expect(merged.status, merged.out).toBe(0);
    expect(String(merged.json?.notice)).toContain("Merged origin/main into refunds in the repo and pushed refunds.");
    const sent = git(home.remote, ["show", "refunds:.gitignore"]);
    expect(sent).toStartWith("dist/");
    expect(sent).toEndWith("node_modules/");
    expect(sent).not.toContain(OWN_PART);
    expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toContain(OWN_PART);
  });

  test("a merge that waits on a clash in another file: the part is back at once, and the finish takes the merge without it", () => {
    const { home, alice, merged } = mainMovesIgnore(true, true);
    expect(String(merged.json?.error)).toStartWith("origin/main and refunds both change src/refunds.ts in the repo in ways git cannot put together");
    expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toContain(OWN_PART);
    writeFileSync(join(alice, "src", "refunds.ts"), "export const built = \"both\";\n");
    git(alice, ["add", "src/refunds.ts"]);
    const finished = run(UNIT, ["push", "--merge-main"], alice);
    expect(finished.status, finished.out).toBe(0);
    expect(git(home.remote, ["show", "refunds:.gitignore"])).not.toContain(OWN_PART);
    expect(git(home.remote, ["show", "refunds:.gitignore"])).toStartWith("dist/");
    expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toContain(OWN_PART);
  });

  test("a merge that waits on a clash in .gitignore itself: the part is back after git's marks, and the undo leaves it there", () => {
    const { alice, merged } = mainMovesIgnore(false);
    expect(String(merged.json?.error)).toStartWith("origin/main and refunds both change .gitignore in the repo in ways git cannot put together");
    const waiting = readFileSync(join(alice, ".gitignore"), "utf-8");
    expect(waiting.indexOf(OWN_PART)).toBeGreaterThan(waiting.lastIndexOf(">>>>>>>"));
    const undone = run(UNIT, ["push", "--undo-merge"], alice);
    expect(String(undone.json?.notice)).toBe("I undid the merge of origin/main into refunds in the repo; refunds is as it was there, and nothing was pushed.");
    const back = readFileSync(join(alice, ".gitignore"), "utf-8");
    expect(back).not.toContain("<<<<<<<");
    expect(back).toContain(OWN_PART);
    expect(workToCommit(alice).paths).not.toContain(".gitignore");
  });

  test("a merge of a main that adds .gitignore waits, and the undo takes it away again: the .gitignore config wrote is back as it was", () => {
    const home = oneRepoTeams();
    withoutGitignore(home);
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "kiro");
    const before = readFileSync(join(alice, ".gitignore"), "utf-8");
    builtHere(alice, "refunds", "refunds.ts");
    writeFileSync(join(home.dir, ".gitignore"), "dist/\n");
    git(home.dir, ["add", ".gitignore"]);
    git(home.dir, ["commit", "-q", "-m", "lead: a .gitignore"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    mkdirSync(join(home.dir, "src"), { recursive: true });
    leadCommits(home, "main", "src/refunds.ts");
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(next(alice).ask_type).toBe("unit-main-moved");
    const waits = run(UNIT, ["push", "--merge-main"], alice);
    expect(String(waits.json?.error)).toStartWith("origin/main and refunds both change src/refunds.ts in the repo in ways git cannot put together");
    expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toStartWith("dist/\n");
    expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toContain(OWN_PART);
    const undone = run(UNIT, ["push", "--undo-merge"], alice);
    expect(String(undone.json?.notice)).toBe("I undid the merge of origin/main into refunds in the repo; refunds is as it was there, and nothing was pushed.");
    expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toBe(before);
    expect(git(alice, ["status", "--porcelain", "--", ".gitignore"])).toBe("?? .gitignore");
  });

  test("a merge their hook refuses is undone over config's part, and the part is back", () => {
    const { alice, merged: refused } = mainMovesIgnore(true, false, true);
    expect(String(refused.json?.error)).toStartWith("Your hook in the repo did not take the merge of origin/main into refunds");
    expect(git(alice, ["status", "--porcelain", "--", ".gitignore"])).toBe("M .gitignore");
    expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toContain(OWN_PART);
    expect(existsSync(join(alice, ".git", "MERGE_HEAD"))).toBe(false);
  });

  for (const folder of [false, true]) {
    test(`bringing main in begun from their main${folder ? ", the Unit named like a folder at the root" : ""}: the Unit's branch is checked out over config's part, and no way back git would refuse is offered`, () => {
      const home = oneRepoTeams();
      if (folder) {
        mkdirSync(join(home.dir, "refunds"), { recursive: true });
        leadCommits(home, "main", "refunds/README.md");
      }
      // Their host refuses AI-DLC's record, so it stays here, uncommitted, the work still theirs on main.
      const hookFile = join(home.remote, "hooks", "pre-receive");
      writeFileSync(hookFile, "#!/bin/sh\nwhile read old new ref; do\n  [ \"$ref\" = refs/heads/refunds ] || continue\n" +
        "  if git diff --name-only \"$old\" \"$new\" 2>/dev/null | grep -q '^aidlc/'; then echo 'GitLab: File name aidlc/ is prohibited' >&2; exit 1; fi\n" +
        "done\nexit 0\n");
      chmodSync(hookFile, 0o755);
      const alice = cloneOf(home.remote, "alice");
      configured(alice, "kiro");
      builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES) });
      leadsIgnoreLine(home, "dist/", true);
      expect(run(UNIT, ["push"], alice).status).toBe(0);
      backOnMainWithPart(alice);
      expect(next(alice).ask_type).toBe("unit-main-moved");
      const merged = run(UNIT, ["push", "--merge-main"], alice);
      expect(merged.status, merged.out).toBe(0);
      const said = String(merged.json?.notice);
      expect(said).toContain("Merged origin/main into refunds in the repo and pushed refunds.");
      expect(said).toContain("You're on refunds now in the repo.");
      expect(said).not.toContain("Switch back to main any time.");
      expect(git(alice, ["branch", "--show-current"])).toBe("refunds");
      expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toContain(OWN_PART);
    });
  }

  test("the push question's look at the Unit's branch sets config's part aside too: nothing of theirs is said to be in the way, and the file is as it was", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "kiro");
    builtHere(alice, "refunds", "refunds.ts");
    leadsIgnoreLine(home, "dist/", true);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const back = backOnMainWithPart(alice);
    expect(unitBranchInTheWay(alice, "refunds", new Map([[".", ["src/refunds.ts"]]]))).toEqual([]);
    expect(readFileSync(join(alice, ".gitignore"), "utf-8")).toBe(back);
  });

  // Where AI-DLC's part is committed, or the file holds a line of their own, the push does as it did before.
  test("the install committed before the take: the build's ignore lines go with the Unit, and the way back is said", () => {
    const home = oneRepoTeams();
    const alice = cloneOf(home.remote, "alice");
    installCommitted(alice, "kiro");
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES) });
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain("You're on refunds now in the repo. Switch back to main any time.");
    expect(git(home.remote, ["show", "refunds:.gitignore"])).toEndWith(`# END AI-DLC:gitignore\n${IGNORES.trim()}`);
    expect(git(alice, ["status", "--porcelain"])).toBe("");
  });

  test("another tool's config over a committed install changes lines inside AI-DLC's part: the Unit's lines go, those stay uncommitted, and the way back git would refuse is not offered", () => {
    const home = oneRepoTeams();
    configured(home.dir, "claude");
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "AI-DLC install"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    configured(alice, "kiro");
    const head = `${git(alice, ["show", "HEAD:.gitignore"])}\n`;
    builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES) });
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(`${git(home.remote, ["show", "refunds:.gitignore"])}\n`).toBe(`${head}${IGNORES}`);
    expect(git(alice, ["status", "--porcelain", "--", ".gitignore"])).toBe("M .gitignore");
    expect(String(pushed.json?.notice)).not.toContain("Switch back to main any time.");
  });

  for (const top of [true, false]) {
    test(`the install committed and a line of their own uncommitted at the ${top ? "top" : "end"} of .gitignore: ${top ? "the Unit's lines go, theirs stays theirs" : "left out and said, both kept"}`, () => {
      const home = oneRepoTeams();
      const alice = cloneOf(home.remote, "alice");
      installCommitted(alice, "kiro");
      const file = join(alice, ".gitignore");
      writeFileSync(file, top ? `*.log\n${readFileSync(file, "utf-8")}` : `${readFileSync(file, "utf-8")}*.log\n`);
      builtWithRootFiles(alice, "refunds", "refunds.ts", { ".gitignore": appended(IGNORES) });
      const pushed = run(UNIT, ["push"], alice);
      expect(pushed.status, pushed.out).toBe(0);
      const said = String(pushed.json?.notice);
      expect(said).toContain("Switch back to main any time.");
      expect(git(home.remote, ["show", "refunds:.gitignore"])).not.toContain("*.log");
      if (top) {
        expect(git(home.remote, ["show", "refunds:.gitignore"])).toEndWith(IGNORES.trim());
        expect(said).not.toContain("is not in the commit");
      } else {
        expect(said).toContain(".gitignore in the repo is not in the commit: it already had a change of yours when refunds was taken");
      }
      expect(readFileSync(file, "utf-8")).toContain("*.log");
    });
  }

  for (const apart of [true, false]) {
    test(`config's part uncommitted and a file of their own changed ${apart ? "apart from" : "next to"} the Unit's change: ${apart ? "only the Unit's change goes" : "left out and said"}`, () => {
      const NOTES = "# Notes\n\nline 2\nline 3\nline 4\nline 5\nline 6\n";
      const home = oneRepoTeams();
      writeFileSync(join(home.dir, "NOTES.md"), NOTES);
      git(home.dir, ["add", "NOTES.md"]);
      git(home.dir, ["commit", "-q", "-m", "notes"]);
      git(home.dir, ["push", "-q", "origin", "main"]);
      const alice = cloneOf(home.remote, "alice");
      configured(alice, "kiro");
      writeFileSync(join(alice, "NOTES.md"), apart ? NOTES.replace("# Notes", "# Notes (mine)") : `${NOTES}my own last line\n`);
      builtWithRootFiles(alice, "refunds", "refunds.ts", { "NOTES.md": appended("refunds: a line of the Unit's\n") });
      const pushed = run(UNIT, ["push"], alice);
      expect(pushed.status, pushed.out).toBe(0);
      const said = String(pushed.json?.notice);
      expect(said).toContain("You're on refunds now in the repo; your other changes are still yours, uncommitted. Switch back to main any time.");
      const sent = git(home.remote, ["show", "refunds:NOTES.md"]);
      expect(sent).not.toContain("mine");
      if (apart) expect(sent).toEndWith("refunds: a line of the Unit's");
      else expect(said).toContain("NOTES.md in the repo is not in the commit: it already had a change of yours when refunds was taken");
    });
  }
});

// The lead's work kept its code in the workspace folder itself, then took
// billing as its first repo: repos.json lists the workspace at "." under the
// name its code knowledge has (its folder's) beside billing, and the work
// records both, as that add leaves it. A teammate clones the workspace, clones
// billing beside it, takes refunds from the plan and builds in both.
describe("a teammate's build of work that lists the workspace beside its first repo", () => {
  const UNITS = "# Unit dependencies\n\n```yaml\nunits:\n" +
    "  - name: refunds\n    kind: service\n    repos: [billing, WORKSPACE]\n    depends_on: []\n" +
    "  - name: reporting\n    kind: service\n    repos: [billing]\n    depends_on: [refunds]\n```\n";

  // `pushFrom`: the folder the push is run from, as the person's shell names it.
  function teammateBuilds(writes: (own: string) => Array<Record<string, string>>, pushFrom = (dir: string): string => dir) {
    const billing = codeHost("billing");
    const home = makeHome({ repos: { billing } });
    const own = basename(home.dir);
    writeFileSync(join(seededRecordDir(home.dir), "inception", "units-generation", "unit-of-work-dependency.md"), UNITS.replace("WORKSPACE", own));
    const shop = join(tempDir("shop-host"), "shop.git");
    git(dirname(shop), ["init", "-q", "--bare", "-b", "main", shop]);
    git(home.dir, ["remote", "set-url", "origin", shop]);
    const registryPath = join(home.dir, "aidlc", "spaces", "default", "intents", "intents.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
    registry[0].repos = ["billing", own].sort();
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify({ repos: [{ name: "billing", url: billing }, { name: own, path: ".", url: shop }] }, null, 2)}\n`);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams, billing beside the workspace"]);
    git(home.dir, ["push", "-q", "-u", "origin", "main"]);
    const planned = sharePlan({ dir: home.dir, remote: shop });
    const alice = cloneOf(shop, "alice");
    cloneCode(billing, alice, "billing", "alice");
    inSpace(alice, "payments");
    const took = run(UNIT, ["take", "refunds", "--plan", planned.id8, "--from", Object.values(planned.hosts)[0]], alice);
    expect(took.status, took.out).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    // The build's registry row, kept in its own record folder.
    const built = (JSON.parse(readFileSync(join(record, "aidlc-intent.json"), "utf-8")) as { repos?: string[] }).repos;
    mkdirSync(join(alice, "billing", "lib"), { recursive: true });
    writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 1;\n");
    mkdirSync(join(alice, "src"), { recursive: true });
    writeFileSync(join(alice, "src", "refunds.ts"), "export const refunds = 1;\n");
    const stage = join(record, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit: "refunds", version: 1, writes: writes(own) }, null, 2)}\n`);
    writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nRefunds.\n");
    finishBuild(record);
    return { own, built, pushed: run(UNIT, ["push"], pushFrom(alice)), planned, shop };
  }

  test("a Unit writing in billing and in the workspace by its name: the build records both, and the push says only what it did", () => {
    const { own, built, pushed, planned, shop } = teammateBuilds((own) => [{ repo: "billing", path: "lib/refund.ts" }, { repo: own, path: "src/refunds.ts" }]);
    expect(built).toEqual(["billing", own].sort());
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(`Pushed branch refunds in billing and ${own}.`);
    expect(String(pushed.json?.notice)).not.toContain("was not in the lead's plan");
    expect(String(pushed.json?.notice)).not.toContain("your other changes are still yours");
    expect(git(shop, ["log", "--format=%s", "--name-only", "main..refunds"])).toContain("src/refunds.ts");
    const result = recordAt(planned, "refunds")?.json.result as { repos: Array<{ repo: string; address?: string }> };
    expect(result.repos.map((repo) => repo.repo).sort()).toEqual(["billing", own].sort());
    expect(result.repos.find((repo) => repo.repo === own)).not.toHaveProperty("address");
  });

  // On Windows a folder is the same folder in any letter case: the push run
  // from the workspace typed with its drive letter in lower case.
  test.if(process.platform === "win32")("on Windows, the workspace typed with its drive letter in lower case is still its own folder at the push", () => {
    const { own, pushed } = teammateBuilds((own) => [{ repo: "billing", path: "lib/refund.ts" }, { repo: own, path: "src/refunds.ts" }],
      (dir) => `${dir[0].toLowerCase()}${dir.slice(1)}`);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain(`Pushed branch refunds in billing and ${own}.`);
    expect(String(pushed.json?.notice)).not.toContain("your other changes are still yours");
  });

  test("a Unit writing in the workspace with no repo named: refused as any Unit across two repos is, with the way back", () => {
    const { pushed } = teammateBuilds((): Array<Record<string, string>> => [{ repo: "billing", path: "lib/refund.ts" }, { path: "src/refunds.ts" }]);
    expect(pushed.status).not.toBe(0);
    expect(pushed.out).toContain("refunds's Code Generation record names what it wrote in a way its repos do not have, so nothing was pushed.");
  });
});
