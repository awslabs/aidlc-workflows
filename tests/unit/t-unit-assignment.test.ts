// covers: subcommand:aidlc-unit:assign, subcommand:aidlc-state:set-unit-ownership, audit:UNITS_ASSIGNED, function:homeLocation, function:buildOutHomeLocation
//
// The lead's journey at the lead's project once teams are chosen (#2410).
// Choosing teams records where the home is (the workspace's own origin, read
// only). Nobody is asked who builds which Unit: every Unit is open for any
// team to take, so the first step is the share of the plan, and after it the
// board shows each Unit waiting for a team and offers the approval rhythm
// until the lead answers it. The lead's project builds only the walking
// skeleton, when it is on, a Unit it started itself, and a Unit the lead asks
// to build here (`assign --here`): a take like a teammate's, its claim written
// for the lead's project and the lead's words kept whole. A skip there names
// only a Unit built there. Work with one Unit, several teams on the
// workspace's own repo, and team work with no recorded home are never asked.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents, REQUEST_TEXT_DIR } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneOf,
  DEPENDENCIES,
  ENV,
  git,
  HOME_RECORD,
  homeState,
  makeHome,
  mergeOnHost,
  next,
  ORCH,
  run,
  STATE,
  stateOf,
  tempDir,
  takeIn,
  tellsWhatToType,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const UNITS = ["refunds", "checkout-ui", "reporting"];
const RHYTHM_OFFER = "Each team will approve its Unit after every stage. Do you want them to approve once at the end of " +
  "each Unit instead? I'd keep after every stage, so a wrong turn is caught at the stage where it happens.";

type Offer = { question: string; choices: Array<{ label: string; detail?: string; command?: string; recommended?: boolean }> };

const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();

const isShare = (step: Record<string, unknown>) =>
  step.kind === "ask" && step.ask_type === "team-handover" && ((step.handovers ?? []) as string[]).includes("share");

function chooseTeams(dir: string): void {
  const result = run(STATE, ["set-unit-ownership", "team"], dir);
  expect(result.status, result.out).toBe(0);
}

// Teams chosen as a release before Home Location chose them: the same choice,
// no Home Location recorded, so the work keeps main's own flow.
function teamsChosenBefore(dir: string): void {
  chooseTeams(dir);
  writeFileSync(seededStateFile(dir), stateOf(dir).replace(/^- \*\*Home Location\*\*: .*\r?\n/m, ""));
}

// The lead's yes to sharing the plan with the teams (main's `unit share`).
function share(dir: string): void {
  const shared = run(UNIT, ["share", "--plan"], dir);
  expect(shared.status, shared.out).toBe(0);
}

function pushAll(dir: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "the lead's word"]);
  git(dir, ["push", "-q", "origin", "main"]);
}

describe("choosing teams records where the home is", () => {
  test("the workspace's own origin, read and never changed", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(field(stateOf(home.dir), "Home Location")).toBe(home.remote);
    const set = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_OWNERSHIP_SET");
    expect(set.at(-1)?.block).toContain(`**Home Location**: ${home.remote}`);
  });
});

describe("after choosing teams the plan goes to them the way main's share question asks it", () => {
  test("nobody is asked who builds which Unit: the first step is the share, and it says every Unit is open", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    expect(ask.ask_type).not.toBe("unit-assignment");
    expect(ask.assign_command).toBeUndefined();
    expect(String(ask.question)).toStartWith("The Units are open for any team to take. Share the plan with them now?");
    expect(JSON.stringify(ask)).not.toContain("Who builds which Unit");
  });

  test("asked once: Share by pull request first, as AI-DLC's default says, Share pushes main, and Not now is kept", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    const choices = ask.choices as Array<{ label: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Share by pull request (Recommended)", "Share them with the teams", "Not now"]);
    expect(String(choices[0].command)).toEndWith(` unit share --branch --plan --commit-message-file ${REQUEST_TEXT_DIR}/unit-share-message-plan.txt`);
    expect(String(choices[1].command)).toEndWith(` unit share --plan --commit-message-file ${REQUEST_TEXT_DIR}/unit-share-message-plan.txt`);
    // Not now: the step goes on and the question is not put again.
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
    for (const step of [next(home.dir), next(home.dir)]) {
      expect(isShare(step), JSON.stringify(step)).toBe(false);
      expect(step.ask_type).not.toBe("unit-assignment");
    }
  });

  // The share also sends the claim of a Unit built here before it: its
  // question says so then, and only then.
  test("the share question names a Unit built here before it, which its push also sends; otherwise its words are as they were", () => {
    const plain = makeHome();
    chooseTeams(plain.dir);
    const asked = next(plain.dir);
    expect(asked.question).toBe(
      "The Units are open for any team to take. Share the plan with them now? I'd commit the plan here (AI-DLC's record, " +
        "nothing else of yours) with this commit message and push it on its own branch for a pull request, so each team can take " +
        "its Unit once it is in main, by opening its own clone and running /aidlc.\n\nShare the plan with the teams",
    );
    expect((asked.choices as Offer["choices"])[1]).toMatchObject({
      label: "Share them with the teams",
      detail: "Pushes main to origin as a plain push; it never overwrites what a team pushed.",
    });
    const one = makeHome();
    chooseTeams(one.dir);
    expect(run(UNIT, ["assign", "--here", "refunds", "--person-words", "build refunds here"], one.dir).status).toBe(0);
    const withOne = next(one.dir);
    expect(withOne.question).toBe(
      "The Units are open for any team to take. Share the plan with them now? I'd commit the plan here (AI-DLC's record, " +
        "nothing else of yours) with this commit message and push it on its own branch for a pull request, with the note that " +
        "refunds is built here, so each team can take its Unit once it is in main, by opening its own clone and running " +
        "/aidlc.\n\nShare the plan with the teams",
    );
    expect((withOne.choices as Offer["choices"])[1].detail)
      .toBe("Pushes main, and the note that refunds is built here, to origin; it never overwrites what a team pushed.");
    const two = makeHome();
    chooseTeams(two.dir);
    expect(run(UNIT, ["assign", "--here", "refunds,checkout-ui", "--person-words", "build both here"], two.dir).status).toBe(0);
    const withTwo = next(two.dir);
    expect(String(withTwo.question)).toContain(", with the note that refunds and checkout-ui are built here, so each team");
    expect((withTwo.choices as Offer["choices"])[1].detail)
      .toBe("Pushes main, and the note that refunds and checkout-ui are built here, to origin; it never overwrites what a team pushed.");
    const sharedTwo = run(UNIT, ["share", "--plan"], two.dir);
    expect(sharedTwo.status, sharedTwo.out).toBe(0);
    expect(sharedTwo.json?.notice).toBe("Pushed main, and the note that refunds and checkout-ui are built here, to origin.");
    // A share with no Unit built here says nothing of a note.
    const sharedPlain = run(UNIT, ["share", "--plan"], plain.dir);
    expect(sharedPlain.status, sharedPlain.out).toBe(0);
    expect(sharedPlain.json?.notice).toBeUndefined();
  });

  test("Share puts the plan on the home's remote, where a teammate's clone takes its Unit", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(git(home.remote, ["rev-parse", "main"])).toBe(git(home.dir, ["rev-parse", "HEAD"]));
    expect(isShare(next(home.dir))).toBe(false);
  });

  test("a Unit added after the plan was shared: the share is asked again, naming it, and Share takes the new plan", () => {
    // A live run: the lead shared the plan, then added a fourth Unit; the
    // share was never asked again, so the remote kept the first plan and no
    // team could take the new Unit.
    const home = makeHome();
    chooseTeams(home.dir);
    expect(isShare(next(home.dir))).toBe(true);
    share(home.dir);
    expect(isShare(next(home.dir))).toBe(false);
    const plan = join(seededRecordDir(home.dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(plan, DEPENDENCIES.replace("```\n", "  - name: reporting2-email\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    expect(String(ask.question)).toContain("reporting2-email");
    expect(String(ask.question)).toContain("since you shared it");
    share(home.dir);
    expect(git(home.remote, ["rev-parse", "main"])).toBe(git(home.dir, ["rev-parse", "HEAD"]));
    expect(git(home.remote, ["show", `main:${relative(home.dir, plan).replaceAll("\\", "/")}`])).toContain("reporting2-email");
    expect(isShare(next(home.dir))).toBe(false);
  });

  test("a plan already pushed is not asked about", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    pushAll(home.dir);
    expect(isShare(next(home.dir))).toBe(false);
  });

  test("a home that cannot be reached: Share says so, keeps the commit, and the question is not put again each turn", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(isShare(next(home.dir))).toBe(true);
    git(home.dir, ["remote", "set-url", "origin", join(home.remote, "gone")]);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status).not.toBe(0);
    expect(shared.out).toContain("origin could not be reached, so the plan was not shared");
    expect(shared.out).not.toContain("pull main");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "ok" }, home.dir);
    expect(isShare(next(home.dir))).toBe(false);
  });
});

// A live run on GitHub (#2783) and a read of the share: a ruleset on main
// refused the plan's share and the way on said "pull main, then share again",
// which cannot work; and the plan's share took a file the person had staged.
describe("the plan's share fits the team's own git: a protected main, a branch of the lead's, a file the person staged", () => {
  const WAY_ON = "The plan is committed here: push it on a branch and get it merged your usual way; the teams can take Units once it is in main.";
  const RULE = "origin takes no direct push to main (error: GH013: Repository rule violations found for refs/heads/main. " +
    `- Changes must be made through a pull request. (pre-receive hook declined)). ${WAY_ON}`;

  // A host whose main takes no direct push, as a ruleset refuses it; other branches go through.
  function mainTakesNoDirectPush(bare: string): void {
    const hook = join(bare, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do\n  if [ \"$ref\" = refs/heads/main ]; then\n" +
      "    echo 'error: GH013: Repository rule violations found for refs/heads/main.' >&2\n" +
      "    echo '- Changes must be made through a pull request.' >&2\n    exit 1\n  fi\ndone\nexit 0\n");
    chmodSync(hook, 0o755);
  }

  test("main takes no direct push: the share says so with the host's words, keeps the commit, and is not asked again", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(isShare(next(home.dir))).toBe(true);
    mainTakesNoDirectPush(home.remote);
    const before = git(home.remote, ["rev-parse", "main"]);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(shared.json).toMatchObject({ shared: false, notice: NOT_SHARED });
    expect(git(home.remote, ["rev-parse", "main"])).toBe(before);
    expect(git(home.dir, ["status", "--porcelain", "--", "aidlc"])).toBe("");
    expect(git(home.dir, ["log", "-1", "--format=%s"])).toBe("Share the plan with the teams");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "ok" }, home.dir);
    const look = next(home.dir);
    expect(String(look.question), JSON.stringify(look).slice(0, 600)).toBe(BRANCH_OFFER);
  });

  // A live run on GitHub (case 7): the plan reached main by its pull request,
  // squashed, and the lead's look still said it waited on that pull request;
  // nothing said the lead's main was left ahead and behind origin's. Here the
  // lead pushes main on a branch of their own after the refused share.
  // `shared`: a rhythm the lead chose before the share, so the share commits
  // it; `answer`: the look after the merge and the lead's answer to its rhythm
  // question.
  function planMergedBy(
    how: "squash" | "rebase" | "merge",
    options: { ownCommit?: boolean; shared?: Rhythm; answer?: Rhythm } = {},
  ): string {
    const home = makeHome();
    chooseTeams(home.dir);
    if (options.shared) setRhythm(home.dir, options.shared);
    // The share question put first, as the second run had it: after a refused
    // share its mark keeps it from being put again, so the board comes next.
    if (options.answer) expect(isShare(next(home.dir))).toBe(true);
    mainTakesNoDirectPush(home.remote);
    expect(run(UNIT, ["share", "--plan"], home.dir).json?.notice).toBe(NOT_SHARED);
    git(home.dir, ["push", "-q", "origin", "main:refs/heads/plan-checkout"]);
    // A commit of the lead's own after the push, which origin's main never gets.
    if (options.ownCommit) {
      writeFileSync(join(home.dir, "notes.md"), "The lead's own.\n");
      git(home.dir, ["add", "notes.md"]);
      git(home.dir, ["commit", "-q", "-m", "the lead's notes"]);
    }
    // The host's own merge of the pull request, which its rule lets through.
    unlinkSync(join(home.remote, "hooks", "pre-receive"));
    mergeOnHost(home.remote, "plan-checkout", how);
    git(home.dir, ["fetch", "-q", "origin"]);
    if (options.answer) afterTheShare(home.dir, options.answer);
    return home.dir;
  }
  type Rhythm = "per-stage" | "unit-end";
  function setRhythm(dir: string, rhythm: Rhythm): void {
    const set = run(STATE, ["set-unit-gate-rhythm", rhythm], dir);
    expect(set.status, set.out).toBe(0);
  }
  // The look after the share (the board, which writes its Unit Progress table
  // and the marks of the Units' own stages into the state file) and the lead's
  // answer to the rhythm question.
  function afterTheShare(dir: string, answer: Rhythm): void {
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "ok" }, dir);
    // A main the merge left ahead and behind is offered to be brought level first, once; Not now is the board.
    if (String(next(dir).question ?? "").includes("Want me to bring your main level")) next(dir);
    expect(stateOf(dir)).toContain("## Unit Progress");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": answer }, dir);
    setRhythm(dir, answer);
  }
  const IN_MAIN = "Checked in:     yes, aidlc/ is in main on origin\n";
  const statusOf = (dir: string) => run(UTILITY, ["status"], dir).out;
  // The work's state file holds writes its last commit does not.
  const stateChanged = (dir: string) => git(dir, ["diff", "--name-only"]).split("\n").some((path) => path.endsWith("/aidlc-state.md"));

  test("after the plan's pull request merges by a squash, a rebase or a merge commit, status says the plan is in main on origin", () => {
    for (const how of ["squash", "rebase", "merge"] as const) {
      expect(statusOf(planMergedBy(how)), how).toContain(IN_MAIN);
    }
  });

  // Status, a report at the person's own terminal, names the command itself.
  const levelLine = (split: string) => new RegExp("Your main:      origin/main already has your work, merged as commits of its own, " +
    `so yours is ${split}\\. \`[^\`\\n]* unit share --back\` brings it level; nothing of yours is lost\\.\\n`);
  const levelChat = (name: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: `t-unit-assignment-level-${name}` });
  const levelQuestion = (split: string) => `origin/main already has your work, merged as commits of its own, so your main is ${split} it. ` +
    "Want me to bring your main level with it? Nothing of yours is lost.";
  type LevelChoice = { label: string; detail?: string; command?: string };

  test("a main a squash or rebase merge left ahead and behind origin's: status says so once, with no git command, and that AI-DLC can bring it level", () => {
    for (const [how, split] of [["squash", "1 ahead and 1 behind"], ["rebase", "1 ahead and 2 behind"]] as const) {
      const dir = planMergedBy(how);
      const status = statusOf(dir);
      expect(status, how).toMatch(levelLine(split));
      expect(status, how).not.toContain("git reset");
      expect(status.split("Your main:").length - 1, how).toBe(1);
    }
    // Only behind (a merge commit), or ahead with a commit origin's main does not have: nothing is said.
    expect(statusOf(planMergedBy("merge"))).not.toContain("Your main:");
    const own = statusOf(planMergedBy("squash", { ownCommit: true }));
    expect(own).toContain(IN_MAIN);
    expect(own).not.toContain("Your main:");
    // An uncommitted change on a file origin's main changed, where git reset --keep would refuse: nothing is said.
    const rebased = planMergedBy("rebase");
    writeFileSync(join(rebased, "before-plan-checkout.md"), "The lead's own, not committed.\n");
    expect(statusOf(rebased)).not.toContain("Your main:");
    // A staged change, which git reset --keep would unstage: nothing is said.
    const staged = planMergedBy("squash");
    writeFileSync(join(staged, "notes.md"), "Staged, not committed.\n");
    git(staged, ["add", "notes.md"]);
    expect(statusOf(staged)).not.toContain("Your main:");
    // An ignored file of the lead's own where origin's main adds one, which git reset --keep would replace: nothing is said.
    const ignored = planMergedBy("rebase");
    writeFileSync(join(ignored, ".git", "info", "exclude"), "before-plan-checkout.md\n");
    writeFileSync(join(ignored, "before-plan-checkout.md"), "The lead's own, ignored.\n");
    expect(statusOf(ignored)).not.toContain("Your main:");
  });

  test("the next look offers once to bring that main level, in a new chat too; yes brings it level losing nothing and names the old commit, and Not now never asks again", () => {
    for (const [how, split] of [["squash", "1 ahead and 1 behind"], ["rebase", "1 ahead and 2 behind"]] as const) {
      const dir = planMergedBy(how);
      // An uncommitted change of the lead's, as in the run, stays through the yes.
      writeFileSync(join(dir, ".gitignore"), `${readFileSync(join(dir, ".gitignore"), "utf-8")}scratch/\n`);
      const before = git(dir, ["rev-parse", "HEAD"]);
      const short = git(dir, ["rev-parse", "--short", "HEAD"]);
      const offer = next(dir, levelChat(`yes-${how}`));
      expect(String(offer.question), JSON.stringify(offer).slice(0, 600)).toBe(levelQuestion(split));
      const choices = offer.choices as LevelChoice[];
      expect(choices.map((choice) => choice.label), how).toEqual(["Bring main level", "Not now"]);
      expect(choices[0].detail).toBe("Your main moves to origin/main; your uncommitted changes stay as they are.");
      expect(choices[1].detail).toBe("Your main stays as it is.");
      expect(String(choices[0].command)).toMatch(/ unit share --back$/);
      const yes = run(UNIT, ["share", "--back"], dir);
      expect(yes.status, yes.out).toBe(0);
      expect(yes.json?.notice, how).toBe(`Your main is level with origin/main now, with all your work in it. It was at ${short} before, if you ever want that back.`);
      // Every file the lead's main had is there as it was; only what origin's main added is new.
      expect(git(dir, ["rev-parse", "HEAD"])).toBe(git(dir, ["rev-parse", "origin/main"]));
      expect(git(dir, ["diff", "--name-only", "--diff-filter=DMT", before, "HEAD"]), how).toBe("");
      expect(readFileSync(join(dir, ".gitignore"), "utf-8"), how).toEndWith("scratch/\n");
      const level = statusOf(dir);
      expect(level, how).toContain(IN_MAIN);
      expect(level, how).not.toContain("Your main:");
      expect(JSON.stringify(next(dir, levelChat(`after-${how}`)))).not.toContain("bring your main level");
    }
    // Not now: never asked again, in that chat or a new one, and the look's note carries the command for their words later.
    const dir = planMergedBy("squash");
    const offer = next(dir, levelChat("not-now"));
    expect(String(offer.question)).toBe(levelQuestion("1 ahead and 1 behind"));
    for (const chat of ["not-now", "not-now-later"]) {
      const after = next(dir, levelChat(chat));
      expect(String(after.question ?? ""), chat).not.toBe(levelQuestion("1 ahead and 1 behind"));
      expect(String(after.board_note ?? ""), chat).toMatch(/When the person asks to bring their main level, run `[^`]* unit share --back` and tell them in plain words what it reports\./);
    }
    // Something of theirs staged since the offer: the yes says why main stays as it was, and changes nothing.
    writeFileSync(join(dir, "notes.md"), "Staged since.\n");
    git(dir, ["add", "notes.md"]);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const kept = run(UNIT, ["share", "--back"], dir);
    expect(kept.status).not.toBe(0);
    expect(kept.out).toContain("Your main stays as it was: you have staged changes, and bringing it level would unstage them.");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("notes.md");
  });

  // The second run on GitHub (case 7): after the share the board wrote its Unit
  // Progress table and the stage's mark into the state file, and the lead
  // answered its rhythm question, so the record read as never checked in and
  // status said nothing of the plan being in main.
  test("the share's own later writes (the board's Unit Progress, the stage's mark, a per-stage answer) still read as in main once the plan's pull request merges, and the Your main line holds", () => {
    for (const how of ["squash", "rebase", "merge"] as const) {
      const dir = planMergedBy(how, { answer: "per-stage" });
      expect(stateChanged(dir), how).toBe(true);
      expect(statusOf(dir), how).toContain(IN_MAIN);
    }
    for (const [how, split] of [["squash", "1 ahead and 1 behind"], ["rebase", "1 ahead and 2 behind"]] as const) {
      const dir = planMergedBy(how, { answer: "per-stage" });
      const status = statusOf(dir);
      expect(status, how).toMatch(levelLine(split));
      expect(status.split("Your main:").length - 1, how).toBe(1);
      // The yes, with those writes in the tree: they stay, and the line goes.
      const yes = run(UNIT, ["share", "--back"], dir);
      expect(yes.status, yes.out).toBe(0);
      expect(stateOf(dir), how).toContain("- **Unit Gate Rhythm**: per-stage");
      expect(stateOf(dir), how).toContain("## Unit Progress");
      const level = statusOf(dir);
      expect(level, how).toContain(IN_MAIN);
      expect(level, how).not.toContain("Your main:");
    }
  });

  test("a share that pushed directly reads as in main, right after it and after the look and the answer that follow it", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(isShare(next(home.dir))).toBe(true);
    share(home.dir);
    const shared = statusOf(home.dir);
    expect(shared).toContain(IN_MAIN);
    expect(shared).not.toContain("Your main:");
    afterTheShare(home.dir, "per-stage");
    expect(stateChanged(home.dir)).toBe(true);
    const looked = statusOf(home.dir);
    expect(looked).toContain(IN_MAIN);
    expect(looked).not.toContain("Your main:");
  });

  // What the engine rewrites at each look is set aside, nothing else: a change
  // of the person's, or an answer the teams do not have, reads as before.
  test("after the plan's pull request merges, a real change in aidlc/ still reads as not in main: a stage document, a new file, the state file by hand, staged", () => {
    const document = (dir: string, name: string) => join(seededRecordDir(dir), "inception", "requirements-analysis", name);
    const editState = (dir: string, from: string | RegExp, to: string) => {
      const was = stateOf(dir);
      expect(was.replace(from, to)).not.toBe(was);
      writeFileSync(seededStateFile(dir), was.replace(from, to));
    };
    const changes: Array<[string, (dir: string) => void]> = [
      ["a stage document", (dir) => writeFileSync(document(dir, "requirements.md"), "# Requirements\n\nFR1 refunds. FR2 receipts.\n")],
      ["a new file", (dir) => writeFileSync(document(dir, "notes.md"), "The lead's notes.\n")],
      ["a field by hand", (dir) => editState(dir, "- **Depth**: Standard", "- **Depth**: Comprehensive")],
      ["a line under the Unit Progress table", (dir) => editState(dir, /(^\| reporting \|.*$)/m, "$1\n\nThe lead's note on reporting.")],
      ["a skip of a Unit's stage", (dir) => editState(dir, /^- \[ \] nfr-design (\S+) EXECUTE$/m, "- [S] nfr-design $1 SKIP: not needed")],
      ["the state file staged", (dir) => git(dir, ["add", "--", seededStateFile(dir)])],
    ];
    for (const [what, change] of changes) {
      const dir = planMergedBy("squash", { answer: "per-stage" });
      expect(statusOf(dir), what).toContain(IN_MAIN);
      change(dir);
      expect(statusOf(dir), what).not.toContain("Checked in:");
    }
  });

  test("after the plan's pull request merges, a rhythm answer the teams do not have reads as not in main, and so does an origin that changed the state file", () => {
    // unit-end after the share, and per-stage over a unit-end the share committed: each take reads main's.
    for (const options of [{ answer: "unit-end" }, { shared: "unit-end", answer: "per-stage" }] as const) {
      const dir = planMergedBy("squash", options);
      expect(stateChanged(dir), JSON.stringify(options)).toBe(true);
      expect(statusOf(dir), JSON.stringify(options)).not.toContain("Checked in:");
    }
    // A change on origin's main to the state file after the merge, from a teammate's clone: neither line.
    const dir = planMergedBy("squash", { answer: "per-stage" });
    const remote = git(dir, ["remote", "get-url", "origin"]);
    const theirs = cloneOf(remote, "teammate");
    writeFileSync(seededStateFile(theirs), `${stateOf(theirs)}\n- **Note**: from a teammate\n`);
    git(theirs, ["commit", "-q", "-am", "a teammate's change"]);
    git(theirs, ["push", "-q", "origin", "main"]);
    git(dir, ["fetch", "-q", "origin"]);
    const status = statusOf(dir);
    expect(status).not.toContain("Checked in:");
    expect(status).not.toContain("Your main:");
  });

  // A project in a folder of its repository (teams chosen while it was a
  // repository of its own), its plan merged by a squash, with the person's own
  // git set to diff.relative, which narrows a plain git diff to the folder.
  // `outside`: a commit of the lead's outside the folder that origin's main lacks.
  function folderProjectMerged(outside: boolean): string {
    const project = makeHome();
    chooseTeams(project.dir);
    const repo = tempDir("monorepo");
    cpSync(project.dir, join(repo, "proj"), { recursive: true, filter: (from) => from !== join(project.dir, ".git") });
    writeFileSync(join(repo, "README.md"), "# The repository\n");
    const host = tempDir("monorepo-host");
    git(host, ["init", "-q", "--bare", "-b", "main"]);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.name", "lead"]);
    git(repo, ["config", "user.email", "lead@example.test"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "teams chosen"]);
    git(repo, ["remote", "add", "origin", host]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    const dir = join(repo, "proj");
    writeFileSync(join(seededRecordDir(dir), "inception", "units-generation", "unit-of-work.md"), "# Units of work\n\nrefunds, checkout-ui, reporting; notes added.\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "Share the plan with the teams"]);
    git(repo, ["push", "-q", "origin", "main:refs/heads/plan-checkout"]);
    if (outside) {
      writeFileSync(join(repo, "notes.md"), "The lead's own, outside the project's folder.\n");
      git(repo, ["add", "notes.md"]);
      git(repo, ["commit", "-q", "-m", "the lead's notes"]);
    }
    mergeOnHost(host, "plan-checkout", "squash");
    git(repo, ["fetch", "-q", "origin"]);
    git(repo, ["config", "diff.relative", "true"]);
    return dir;
  }

  test("a project in a folder of its repository, with diff.relative set: a commit of the lead's outside the folder that origin's main lacks keeps the line unsaid", () => {
    for (const outside of [false, true]) {
      const status = statusOf(folderProjectMerged(outside));
      expect(status, String(outside)).toContain(IN_MAIN);
      if (outside) expect(status).not.toContain("Your main:");
      else expect(status).toContain("Your main:      origin/main already has your work, merged as commits of its own, so yours is 1 ahead and 1 behind.");
    }
  });

  test("a project in a folder of its repository: a rhythm answer written after the share still reads as in main", () => {
    const dir = folderProjectMerged(false);
    setRhythm(dir, "per-stage");
    expect(stateChanged(dir)).toBe(true);
    expect(statusOf(dir)).toContain(IN_MAIN);
  });

  // A main that takes no direct push. The share says so in the host's words
  // and offers once to put the plan on a branch of its own; on yes AI-DLC makes
  // the branch at its own commit, pushes it with its upstream, passes on the
  // host's own link and only then moves the checkout onto it and puts main back.
  // Until the plan is in main every look and status say so in place of the
  // board; once it is, one offer to switch back, done with nothing lost. A host
  // that takes the push, a main the person had moved on and the share after a
  // land stay as they were.
  const HOST = "origin takes no direct push to main (error: GH013: Repository rule violations found for refs/heads/main. " +
    "- Changes must be made through a pull request. (pre-receive hook declined))";
  const PLAN_BRANCH = "aidlc-plan-fixture";
  const NOT_SHARED = `${HOST}, so the plan is not shared yet.`;
  const BRANCH_OFFER = "Want me to put the plan on its own branch and push that, so you can open a pull request from it?";
  const COMMITTED_HERE = "The plan is committed here and not shared yet: say when you want me to put it on its own branch and push that.";
  const onItsBranch = (branch: string) =>
    `The plan is on its own branch, ${branch}, pushed to origin, and your checkout is on it; main is as it was.`;
  const WAITING = `The plan is on its own branch, ${PLAN_BRANCH}, waiting for its pull request; teams can take Units once it is in main.`;
  const BACK_OFFER = "The plan is in main now, so teams can take Units. Want me to switch you back to main?";
  const ON_MAIN = "You are on main now, level with origin.";
  const STAYED = `You stay on ${PLAN_BRANCH} and nothing changed: git says`;
  const chatOf = (name: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: `t-unit-assignment-plan-branch-${name}` });
  const UNITS_FILE = join("aidlc", "spaces", "default", "intents", HOME_RECORD, "inception", "units-generation", "unit-of-work.md");
  type Step = Record<string, unknown>;
  const labelsOf = (step: Step) => ((step.choices ?? []) as Array<{ label: string }>).map((choice) => choice.label);
  const commandOf = (step: Step, label: string) =>
    String(((step.choices ?? []) as Array<{ label: string; command?: string }>).find((choice) => choice.label === label)?.command ?? "");
  const runPrinted = (command: string, dir: string) => run(UNIT, command.replace(/^.* unit /, "").split(" "), dir);
  const planBranches = (dir: string) => git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/aidlc-plan*"]);

  // The host also hands back its own link for a branch it took, as GitHub does
  // after a push (its post-receive words).
  function hostGivesLinks(bare: string): void {
    const hook = join(bare, "hooks", "post-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do\n  case \"$ref\" in refs/heads/main) ;; refs/heads/*)\n" +
      "    b=$(echo \"$ref\" | sed 's#^refs/heads/##')\n    echo '' >&2\n    echo \"Create a pull request for '$b' on GitHub by visiting:\" >&2\n" +
      "    echo \"     https://github.example/team/workspace/pull/new/$b\" >&2\n    echo '' >&2 ;; esac\ndone\nexit 0\n");
    chmodSync(hook, 0o755);
  }

  // The person's own work around the share: a file of theirs already on main
  // that they changed, a file they staged and a new file git does not track.
  function personsWork(dir: string): () => Record<string, string> {
    writeFileSync(join(dir, "shared.ts"), "export const a = 1;\n");
    git(dir, ["add", "shared.ts"]);
    git(dir, ["commit", "-q", "-m", "the person's files"]);
    git(dir, ["push", "-q", "origin", "main"]);
    writeFileSync(join(dir, "shared.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "staged-only.txt"), "staged\n");
    git(dir, ["add", "staged-only.txt"]);
    writeFileSync(join(dir, "z-deploy.env"), "KEY=1\n");
    return () => Object.fromEntries(["shared.ts", "staged-only.txt", "z-deploy.env"].map((name) => [name, readFileSync(join(dir, name), "utf-8")]));
  }

  // The share refused by the host's rule, then the offer the next step puts.
  function refusedThenOffered(dir: string, remote: string, args: string[], chat: NodeJS.ProcessEnv): Step {
    expect(isShare(next(dir, chat))).toBe(true);
    mainTakesNoDirectPush(remote);
    const shared = run(UNIT, args, dir, chat);
    expect(shared.out).toContain(NOT_SHARED);
    expect(shared.out).not.toContain("git push");
    const offer = next(dir, chat);
    expect(String(offer.question), JSON.stringify(offer).slice(0, 600)).toBe(BRANCH_OFFER);
    expect(labelsOf(offer)).toEqual(["Put it on its own branch", "Not now"]);
    return offer;
  }

  // The host merges the plan branch's pull request its own way (its rule lets
  // its own merge through); `edited`: someone changed the plan on the pull
  // request first, as a suggestion committed on the host does.
  function hostMergesPlan(remote: string, how: "squash" | "rebase" | "merge", edited = false): void {
    unlinkSync(join(remote, "hooks", "pre-receive"));
    if (edited) {
      const dir = join(tempDir("plan-edit"), "repo");
      git(tempDir("plan-edit-parent"), ["clone", "-q", "--branch", PLAN_BRANCH, remote, dir]);
      git(dir, ["config", "user.name", "editor"]);
      git(dir, ["config", "user.email", "editor@example.test"]);
      writeFileSync(join(dir, UNITS_FILE), `${readFileSync(join(dir, UNITS_FILE), "utf-8")}Edited on the pull request.\n`);
      git(dir, ["commit", "-q", "-am", "edit the plan"]);
      git(dir, ["push", "-q", "origin", PLAN_BRANCH]);
    }
    mergeOnHost(remote, PLAN_BRANCH, how);
  }

  test("main takes no direct push: the share says so in the host's words with no git command, and the next step offers once to put the plan on its own branch", () => {
    for (const args of [["share", "--plan"], ["share"]]) {
      // Main's own share: team work on one repo that chose teams before.
      const home = args.length === 2 ? makeHome() : makeHome({ repos: {} });
      (args.length === 2 ? chooseTeams : teamsChosenBefore)(home.dir);
      const chat = chatOf(`offer-${args.length}`);
      const offer = refusedThenOffered(home.dir, home.remote, args, chat);
      expect(commandOf(offer, "Put it on its own branch")).toMatch(args.length === 2 ? / unit share --branch --plan$/ : / unit share --branch$/);
      expect(git(home.dir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
      // Not now: no question again, never a build here; the line says it can be asked for.
      const after = next(home.dir, chat);
      expect(after.kind, JSON.stringify(after).slice(0, 600)).not.toBe("ask");
      expect(after.kind).not.toBe("run-stage");
      expect(JSON.stringify(after)).toContain(COMMITTED_HERE);
      expect(JSON.stringify(after)).not.toContain("waiting for a team to take it");
      expect(JSON.stringify(after)).not.toContain("Claimable");
      expect(String(next(home.dir, chat).question ?? "")).not.toBe(BRANCH_OFFER);
    }
  });

  test("on yes the plan's branch is made at AI-DLC's own commit and pushed with its upstream, the host's own link is passed on, and only then the checkout is on it and main is back where it was, with every file of the person's as it was", () => {
    const home = makeHome();
    const theirFiles = personsWork(home.dir);
    chooseTeams(home.dir);
    hostGivesLinks(home.remote);
    const m0 = git(home.dir, ["rev-parse", "HEAD"]);
    const offer = refusedThenOffered(home.dir, home.remote, ["share", "--plan"], chatOf("branch"));
    const before = theirFiles();
    const done = runPrinted(commandOf(offer, "Put it on its own branch"), home.dir);
    expect(done.status, done.out).toBe(0);
    expect(done.out).toContain(onItsBranch(PLAN_BRANCH));
    expect(done.out).toContain(`Its host says: Create a pull request for '${PLAN_BRANCH}' on GitHub by visiting:`);
    expect(done.out).toContain(`https://github.example/team/workspace/pull/new/${PLAN_BRANCH}`);
    expect(git(home.dir, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/${PLAN_BRANCH}`);
    expect(git(home.dir, ["rev-parse", "--abbrev-ref", `${PLAN_BRANCH}@{upstream}`])).toBe(`origin/${PLAN_BRANCH}`);
    expect(git(home.remote, ["rev-parse", PLAN_BRANCH])).toBe(git(home.dir, ["rev-parse", "HEAD"]));
    expect(git(home.dir, ["rev-parse", "main"])).toBe(m0);
    expect(git(home.remote, ["rev-parse", "main"])).toBe(m0);
    expect(git(home.dir, ["log", "--format=%s %P", `${m0}..HEAD`])).toBe(`Share the plan with the teams ${m0}`);
    expect(git(home.dir, ["diff", "--cached", "--name-only"])).toBe("staged-only.txt");
    expect(git(home.dir, ["diff", "--name-only", "--", "shared.ts"])).toBe("shared.ts");
    expect(git(home.dir, ["ls-files", "--others", "--", "z-deploy.env"])).toBe("z-deploy.env");
    expect(theirFiles()).toEqual(before);
  });

  test("a host that refuses the plan's branch too: nothing changed, the checkout stays on main with the plan committed there, and no branch is left", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const offer = refusedThenOffered(home.dir, home.remote, ["share", "--plan"], chatOf("branch-refused"));
    const head = git(home.dir, ["rev-parse", "HEAD"]);
    // Every branch now refused, as a branch-name ruleset refuses this one.
    writeFileSync(join(home.remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'error: GH013: Repository rule violations found.' >&2\nexit 1\n");
    const done = runPrinted(commandOf(offer, "Put it on its own branch"), home.dir);
    expect(done.out).toContain(`origin did not take the branch ${PLAN_BRANCH} (`);
    expect(done.out).toContain("so nothing changed: the plan is still committed here.");
    expect(git(home.dir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(git(home.dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(planBranches(home.dir)).toBe("");
  });

  test("a later share a host refuses, once the first plan is in main: the offer comes once for it, and then the board as usual", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(isShare(next(home.dir))).toBe(true);
    share(home.dir);
    const plan = join(seededRecordDir(home.dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(plan, DEPENDENCIES.replace("```\n", "  - name: reporting2-email\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
    const chat = chatOf("later-share");
    const offer = refusedThenOffered(home.dir, home.remote, ["share", "--plan"], chat);
    expect(commandOf(offer, "Put it on its own branch")).toMatch(/ unit share --branch --plan$/);
    const board = next(home.dir, chat);
    expect(board.kind, JSON.stringify(board).slice(0, 600)).not.toBe("ask");
    expect(JSON.stringify(board)).not.toContain(COMMITTED_HERE);
  });

  test("a share typed on the plan's branch once its pull request merged and the host deleted the branch: nothing is pushed, and the branch stays gone", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const offer = refusedThenOffered(home.dir, home.remote, ["share", "--plan"], chatOf("typed-after-merge"));
    expect(runPrinted(commandOf(offer, "Put it on its own branch"), home.dir).status).toBe(0);
    hostMergesPlan(home.remote, "squash");
    git(home.remote, ["branch", "-D", PLAN_BRANCH]);
    const typed = run(UNIT, ["share", "--plan"], home.dir);
    expect(typed.status, typed.out).toBe(0);
    expect(typed.out).toContain('"shared":false');
    expect(typed.out).toContain(`This checkout is on ${PLAN_BRANCH}, not main.`);
    expect(git(home.remote, ["branch", "--list", PLAN_BRANCH])).toBe("");
  });

  test("a lead whose share went straight to main: the look reads nothing of origin's main for the plan's wait", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(isShare(next(home.dir))).toBe(true);
    share(home.dir);
    const known = git(home.dir, ["rev-parse", "refs/remotes/origin/main"]);
    const theirs = cloneOf(home.remote, "teammate");
    writeFileSync(join(theirs, "notes.md"), "A teammate's note.\n");
    git(theirs, ["add", "notes.md"]);
    git(theirs, ["commit", "-q", "-m", "a teammate's note"]);
    git(theirs, ["push", "-q", "origin", "main"]);
    next(home.dir);
    expect(git(home.dir, ["rev-parse", "refs/remotes/origin/main"])).toBe(known);
  });

  test("Share by pull request when this clone knows of no main on origin: main is not pushed, and the line says so", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const before = git(home.remote, ["rev-parse", "main"]);
    git(home.dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    const done = run(UNIT, ["share", "--branch", "--plan"], home.dir);
    expect(done.status, done.out).not.toBe(0);
    expect(done.out).toContain("This clone knows of no main on origin for a pull request to go into, so the plan stays committed here");
    expect(git(home.remote, ["rev-parse", "main"])).toBe(before);
    expect(planBranches(home.dir)).toBe("");
  });

  test("a home whose team names its branch in words: after the read step and the refusal, the branch offer comes, never the share question again", () => {
    const home = makeHome();
    const team = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(team, readFileSync(team, "utf-8").replace("## Way of Working\n",
      "## Way of Working\n\nWe integrate on main, and main only takes changes through a pull request.\n"));
    chooseTeams(home.dir);
    const chat = chatOf("words");
    expect(isShare(next(home.dir, chat))).toBe(true);
    mainTakesNoDirectPush(home.remote);
    const read = run(UNIT, ["share", "--plan"], home.dir, chat);
    expect(String(read.json?.step), read.out).toContain("practices-branch --file team.md");
    expect(run(STATE, ["practices-branch", "--file", "team.md", "--branch", "main"], home.dir).status).toBe(0);
    expect(run(UNIT, ["share", "--plan"], home.dir, chat).out).toContain(NOT_SHARED);
    const offer = next(home.dir, chat);
    expect(String(offer.question), JSON.stringify(offer).slice(0, 600)).toBe(BRANCH_OFFER);
    expect(runPrinted(commandOf(offer, "Put it on its own branch"), home.dir).status).toBe(0);
    const look = next(home.dir, chatOf("words-new-chat"));
    expect(isShare(look), JSON.stringify(look).slice(0, 600)).toBe(false);
    expect(JSON.stringify(look)).toContain(WAITING);
    expect(JSON.stringify(look)).not.toContain(`This checkout is on ${PLAN_BRANCH}`);
  });

  test("a Unit the lead builds here gets its claim with the plan's branch, as with a push of main", () => {
    const home = makeHome();
    git(home.dir, ["config", "user.name", "lee"]);
    chooseTeams(home.dir);
    const id8 = fixtureIntentId8(home.dir);
    expect(run(UNIT, ["assign", "--here", "refunds", "--person-words", "build refunds here"], home.dir).status).toBe(0);
    const offer = refusedThenOffered(home.dir, home.remote, ["share", "--plan"], chatOf("built-here"));
    expect(claimPayload(home.remote, id8, "refunds")).toBeNull();
    const done = runPrinted(commandOf(offer, "Put it on its own branch"), home.dir);
    expect(done.status, done.out).toBe(0);
    expect(done.out).toContain(`The plan is on its own branch, ${PLAN_BRANCH}, pushed to origin, with the note that refunds is built here, and your checkout is on it; main is as it was.`);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "claimed", owner: "default", taken_by: "lee" });
  });

  test("Share by pull request from main's share question, every branch refused: the plan is committed and nothing pushed, and the next step asks again and builds nothing here", () => {
    const home = makeHome({ repos: {} });
    teamsChosenBefore(home.dir);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask).slice(0, 600)).toBe(true);
    writeFileSync(join(home.remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'error: GH013: Repository rule violations found.' >&2\nexit 1\n");
    chmodSync(join(home.remote, "hooks", "pre-receive"), 0o755);
    const done = runPrinted(commandOf(ask, "Share by pull request (Recommended)"), home.dir);
    expect(done.status, done.out).not.toBe(0);
    expect(done.out).toContain(`origin did not take the branch ${PLAN_BRANCH} (`);
    expect(done.out).toContain("so nothing is pushed: the plan is committed here.");
    expect(git(home.dir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(git(home.dir, ["log", "-1", "--format=%s"])).toBe("Share the plan with the teams");
    expect(planBranches(home.dir)).toBe("");
    const again = next(home.dir);
    expect(isShare(again), JSON.stringify(again).slice(0, 600)).toBe(true);
  });

  test("while the plan's branch waits for its pull request, every look and status say so in place of the board, and nothing is asked", () => {
    for (const args of [["share", "--plan", "--branch"], ["share", "--branch"]]) {
      const home = args.length === 3 ? makeHome() : makeHome({ repos: {} });
      (args.length === 3 ? chooseTeams : teamsChosenBefore)(home.dir);
      const offer = refusedThenOffered(home.dir, home.remote, args.slice(0, -1), chatOf(`wait-${args.length}`));
      expect(runPrinted(commandOf(offer, "Put it on its own branch"), home.dir).status).toBe(0);
      for (const chat of [chatOf(`wait-${args.length}-a`), chatOf(`wait-${args.length}-b`)]) {
        const look = next(home.dir, chat);
        expect(look.kind, JSON.stringify(look).slice(0, 600)).not.toBe("ask");
        expect(look.kind).not.toBe("run-stage");
        expect(JSON.stringify(look)).toContain(WAITING);
        expect(JSON.stringify(look)).not.toContain("waiting for a team to take it");
        expect(JSON.stringify(look)).not.toContain("Claimable");
      }
      const status = run(UTILITY, ["status"], home.dir);
      expect(status.out).toContain(WAITING);
      expect(status.out).not.toContain("Claimable");
    }
  });

  test("the plan's branch merged by its pull request (a squash, a rebase, a merge commit, or a file the share committed edited on it first, the branch kept or deleted): the next look sees it with no fetch of the person's, offers once to switch back, and the switch puts the lead on main, level, with what they answered meanwhile", () => {
    const variants = [["squash", false, false], ["rebase", false, false], ["merge", false, false], ["squash", true, false], ["squash", true, true]] as const;
    for (const [how, edited, deleted] of variants) {
      const home = makeHome();
      chooseTeams(home.dir);
      // A file the share commits, so the edit on the pull request is to a file of the plan's own commit.
      if (edited) writeFileSync(join(home.dir, UNITS_FILE), `${readFileSync(join(home.dir, UNITS_FILE), "utf-8")}The lead's last word.\n`);
      const offer = refusedThenOffered(home.dir, home.remote, ["share", "--plan"], chatOf(`merged-${how}-${edited}-${deleted}`));
      expect(runPrinted(commandOf(offer, "Put it on its own branch"), home.dir).status, how).toBe(0);
      setRhythm(home.dir, "unit-end");
      hostMergesPlan(home.remote, how, edited);
      if (deleted) git(home.remote, ["branch", "-D", PLAN_BRANCH]);
      const chat = chatOf(`back-${how}-${edited}-${deleted}`);
      const back = next(home.dir, chat);
      expect(String(back.question), `${how}: ${JSON.stringify(back).slice(0, 600)}`).toBe(BACK_OFFER);
      expect(labelsOf(back)).toEqual(["Switch back to main", "Not now"]);
      expect(commandOf(back, "Switch back to main")).toMatch(/ unit share --back$/);
      expect(String(next(home.dir, chat).question ?? ""), how).not.toBe(BACK_OFFER);
      const switched = runPrinted(commandOf(back, "Switch back to main"), home.dir);
      expect(switched.status, switched.out).toBe(0);
      expect(switched.out).toContain(ON_MAIN);
      expect(git(home.dir, ["symbolic-ref", "HEAD"]), how).toBe("refs/heads/main");
      expect(git(home.dir, ["rev-parse", "HEAD"]), how).toBe(git(home.remote, ["rev-parse", "main"]));
      expect(field(stateOf(home.dir), "Unit Gate Rhythm"), how).toBe("unit-end");
      if (edited) expect(readFileSync(join(home.dir, UNITS_FILE), "utf-8")).toContain("Edited on the pull request.");
    }
  });

  test("the switch back that git refuses changes nothing and says why: main checked out in another worktree, main holding a commit origin lacks, or the person's own change in the way", () => {
    for (const blocker of ["worktree", "ahead", "change"] as const) {
      const home = makeHome();
      chooseTeams(home.dir);
      const offer = refusedThenOffered(home.dir, home.remote, ["share", "--plan"], chatOf(`stay-${blocker}`));
      expect(runPrinted(commandOf(offer, "Put it on its own branch"), home.dir).status).toBe(0);
      hostMergesPlan(home.remote, "squash", blocker === "change");
      if (blocker === "worktree") git(home.dir, ["worktree", "add", "-q", join(tempDir("other-worktree"), "main"), "main"]);
      if (blocker === "ahead") {
        const tree = git(home.dir, ["rev-parse", "main^{tree}"]);
        const own = git(home.dir, ["commit-tree", tree, "-p", "main", "-m", "the person's own"]);
        git(home.dir, ["update-ref", "refs/heads/main", own]);
      }
      if (blocker === "change") writeFileSync(join(home.dir, UNITS_FILE), "the person's own edit\n");
      const back = next(home.dir, chatOf(`stay-${blocker}-look`));
      expect(String(back.question), blocker).toBe(BACK_OFFER);
      const main = git(home.dir, ["rev-parse", "main"]);
      const stayed = runPrinted(commandOf(back, "Switch back to main"), home.dir);
      expect(stayed.out, blocker).toContain(STAYED);
      expect(git(home.dir, ["symbolic-ref", "HEAD"]), blocker).toBe(`refs/heads/${PLAN_BRANCH}`);
      expect(git(home.dir, ["rev-parse", "main"]), blocker).toBe(main);
    }
  });

  test("a branch of that name already here: the plan goes on the next free name and the other branch is left as it is", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    git(home.dir, ["branch", PLAN_BRANCH]);
    const theirs = git(home.dir, ["rev-parse", PLAN_BRANCH]);
    const offer = refusedThenOffered(home.dir, home.remote, ["share", "--plan"], chatOf("taken"));
    const done = runPrinted(commandOf(offer, "Put it on its own branch"), home.dir);
    expect(done.out).toContain(onItsBranch(`${PLAN_BRANCH}-2`));
    expect(git(home.dir, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/${PLAN_BRANCH}-2`);
    expect(git(home.dir, ["rev-parse", PLAN_BRANCH])).toBe(theirs);
  });

  // As they are today, and stay so.
  test("a host that takes the push: the share pushes main as before, the checkout stays on main, no branch is made and nothing is offered", () => {
    for (const args of [["share", "--plan"], ["share"]]) {
      const home = args.length === 2 ? makeHome() : makeHome({ repos: {} });
      (args.length === 2 ? chooseTeams : teamsChosenBefore)(home.dir);
      expect(isShare(next(home.dir))).toBe(true);
      const shared = run(UNIT, args, home.dir);
      expect(shared.status, shared.out).toBe(0);
      expect(shared.json, args.join(" ")).toMatchObject({ shared: true, remote: "origin", branch: "main" });
      expect(git(home.dir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
      expect(git(home.remote, ["rev-parse", "main"])).toBe(git(home.dir, ["rev-parse", "HEAD"]));
      expect(git(home.dir, ["log", "-1", "--format=%s"])).toBe("Share the plan with the teams");
      expect(planBranches(home.dir)).toBe("");
      expect(git(home.dir, ["status", "--porcelain", "--", "aidlc"])).toBe("");
      expect(JSON.stringify(next(home.dir))).not.toContain("own branch");
    }
  });

  test("a main the person had moved on with a commit of their own: the refused share keeps today's line and its commit on main, and makes no branch", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(isShare(next(home.dir))).toBe(true);
    writeFileSync(join(home.dir, "notes.md"), "The lead's own.\n");
    git(home.dir, ["add", "notes.md"]);
    git(home.dir, ["commit", "-q", "-m", "the lead's notes"]);
    mainTakesNoDirectPush(home.remote);
    expect(run(UNIT, ["share", "--plan"], home.dir).json?.error).toBe(RULE);
    expect(git(home.dir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(git(home.dir, ["log", "-2", "--format=%s"])).toBe("Share the plan with the teams\nthe lead's notes");
    expect(planBranches(home.dir)).toBe("");
  });

  // Off the branch the share commits AI-DLC's record only, by pathspec, typed with --plan or not.
  test("a lead on a branch of their own: the share commits AI-DLC's record there and nothing else of theirs, pushes nothing, and says how it reaches main, as a success", () => {
    for (const args of [["share", "--plan"], ["share"]]) {
      const home = makeHome();
      git(home.dir, ["switch", "-q", "-c", "plan-review"]);
      chooseTeams(home.dir);
      writeFileSync(join(home.dir, "z-deploy.env"), "KEY=1\n");
      writeFileSync(join(home.dir, "staged-only.txt"), "staged\n");
      git(home.dir, ["add", "staged-only.txt"]);
      const before = git(home.remote, ["rev-parse", "main"]);
      const shared = run(UNIT, args, home.dir);
      expect(shared.status, shared.out).toBe(0);
      expect(shared.json?.shared, args.join(" ")).toBe(false);
      expect(shared.json?.notice, args.join(" ")).toBe(`This checkout is on plan-review, not main. ${WAY_ON}`);
      expect(git(home.remote, ["rev-parse", "main"])).toBe(before);
      expect(git(home.remote, ["branch", "--list", "plan-review"])).toBe("");
      expect(git(home.dir, ["log", "-1", "--format=%s"])).toBe("Share the plan with the teams");
      expect(git(home.dir, ["status", "--porcelain", "--", "aidlc"])).toBe("");
      const went = git(home.dir, ["diff-tree", "-r", "--no-commit-id", "--name-only", "HEAD"]).split("\n").filter(Boolean);
      expect(went.filter((path) => !path.startsWith("aidlc/")), went.join(", ")).toEqual([]);
      expect(git(home.dir, ["diff", "--cached", "--name-only"])).toBe("staged-only.txt");
      expect(git(home.dir, ["status", "--porcelain", "--", "z-deploy.env"])).toBe("?? z-deploy.env");
    }
  });

  // A live run (case 12): Inception ended with no share question at all.
  test("a lead on a branch of their own is asked once to have the plan committed there, the push staying theirs; yes commits it, and Not now never asks again", () => {
    const question = "This checkout is on plan-review, not main. Want me to commit the plan here with this commit message, so you " +
      "can push it on a branch and get it merged your usual way?\n\nShare the plan with the teams";
    const file = `${REQUEST_TEXT_DIR}/unit-share-message-plan-here-plan-review.txt`;
    for (const answer of ["yes", "not now"] as const) {
      const home = makeHome();
      git(home.dir, ["switch", "-q", "-c", "plan-review"]);
      chooseTeams(home.dir);
      const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: `lead-on-a-branch-${answer}` };
      const first = next(home.dir, chat);
      expect(String(first.question), JSON.stringify(first).slice(0, 600)).toBe(question);
      expect(JSON.stringify(first)).not.toContain("Commit the plan (aidlc/) here");
      const choices = first.choices as Array<{ label: string; detail?: string; command?: string }>;
      expect(choices.map((choice) => choice.label)).toEqual(["Commit the plan here", "Not now"]);
      expect(choices[0].detail).toBe("Commits the plan here (AI-DLC's record, nothing else of yours) on plan-review; nothing is pushed.");
      expect(choices[1].detail).toBe("The plan stays uncommitted here.");
      expect(String(choices[0].command)).toEndWith(` unit share --plan --commit-message-file ${file}`);
      expect(first.commit_message_file).toBe(file);
      expect(String(first.question_note)).toContain("The commit message the question shows is the one in the file commit_message_file names");
      const before = git(home.remote, ["rev-parse", "main"]);
      if (answer === "yes") {
        // Their own words replace the draft, whole.
        writeFileSync(join(home.dir, ...file.split("/")), "docs(plan): the lead's plan for refunds\n");
        const done = run(UNIT, ["share", "--plan", "--commit-message-file", file], home.dir, chat);
        expect(done.status, done.out).toBe(0);
        expect(done.json?.notice).toBe(`This checkout is on plan-review, not main. ${WAY_ON}`);
        expect(git(home.dir, ["log", "-1", "--format=%s"])).toBe("docs(plan): the lead's plan for refunds");
        expect(existsSync(join(home.dir, ...file.split("/")))).toBe(false);
      }
      expect(git(home.remote, ["rev-parse", "main"])).toBe(before);
      expect(git(home.remote, ["branch", "--list", "plan-review"])).toBe("");
      expect(String(next(home.dir, chat).question ?? "")).not.toBe(question);
    }
  });

  test("a repo list whose content changed is offered once to be committed with AI-DLC's record, in a new chat too; yes commits it", () => {
    const home = makeHome();
    const dir = home.dir;
    const list = join(dir, "repos.json");
    const parsed = JSON.parse(readFileSync(list, "utf-8")) as { repos: Array<{ name: string }> };
    const names = [...parsed.repos.map((repo) => repo.name), "notify"];
    writeFileSync(list, `${JSON.stringify({ repos: [...parsed.repos, { name: "notify", url: "https://git.example.invalid/notify.git" }] }, null, 2)}\n`);
    const listed = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    const question = `repos.json now lists ${listed}, and your team gets it once it is committed. Want me to commit AI-DLC's record in ` +
      "aidlc/, with the list, using this commit message?\n\nUpdate AI-DLC's record";
    const file = `${REQUEST_TEXT_DIR}/unit-record-message-${git(dir, ["hash-object", "repos.json"]).slice(0, 12)}.txt`;
    // At the stage boundary, after the questions about the work's own step, which the person answers first:
    // this folder's code stays a new project, and one person builds the Units.
    let offer = next(dir, chatOf("list-changed"));
    for (let asked = 0; asked < 3 && (offer.ask_type === "project-type" || offer.ask_type === "construction-staffing"); asked++) {
      const answered = offer.ask_type === "project-type"
        ? run(UTILITY, ["reclassify", "--project-type", "greenfield"], dir)
        : run(STATE, ["set-unit-ownership", "solo"], dir);
      expect(answered.status, answered.out).toBe(0);
      offer = next(dir, chatOf("list-changed"));
    }
    expect(String(offer.question), JSON.stringify(offer).slice(0, 600)).toBe(question);
    const choices = offer.choices as Array<{ label: string; detail?: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Commit it", "Not now"]);
    expect(choices[0].detail).toBe("Commits everything in aidlc/, the repo list with it; nothing else outside aidlc/ goes in, and nothing is pushed.");
    expect(choices[1].detail).toBe("The list stays uncommitted here.");
    expect(String(choices[0].command)).toEndWith(` unit commit-record --commit-message-file ${file}`);
    expect(offer.commit_message_file).toBe(file);
    // Asked once for this list: not again in that chat, nor in a new one.
    expect(String(next(dir, chatOf("list-changed")).question ?? "")).not.toBe(question);
    expect(String(next(dir, chatOf("list-changed-later")).question ?? "")).not.toBe(question);
    writeFileSync(join(dir, ...file.split("/")), "chore(repos): list notify\n");
    const yes = run(UNIT, ["commit-record", "--commit-message-file", file], dir);
    expect(yes.status, yes.out).toBe(0);
    expect(git(dir, ["status", "--porcelain", "--", "repos.json"])).toBe("");
    expect(git(dir, ["log", "-1", "--format=%s"])).toBe("chore(repos): list notify");
    expect(existsSync(join(dir, ...file.split("/")))).toBe(false);
  });

  test("unit commit-record commits only AI-DLC's record, takes no path, keeps a file staged outside aidlc/ staged and out of it, and refuses with nothing changed when it cannot", () => {
    const home = makeHome();
    const dir = home.dir;
    const units = UNITS_FILE.replaceAll("\\", "/");
    writeFileSync(join(dir, UNITS_FILE), `${readFileSync(join(dir, UNITS_FILE), "utf-8")}A note of the lead's.\n`);
    writeFileSync(join(dir, "outside.md"), "Staged, not AI-DLC's.\n");
    git(dir, ["add", "outside.md"]);
    const head = git(dir, ["rev-parse", "HEAD"]);
    expect(run(UNIT, ["commit-record", "outside.md"], dir).status).not.toBe(0);
    // A git operation of theirs under way: nothing is committed, and the way on is theirs.
    writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${head}\n`);
    const underWay = run(UNIT, ["commit-record"], dir);
    expect(underWay.status).not.toBe(0);
    expect(underWay.out).toContain("This checkout is in the middle of a merge, so nothing was committed. Finish it (git commit) or put it " +
      "aside (git merge --abort), then I can commit AI-DLC's record.");
    unlinkSync(join(dir, ".git", "MERGE_HEAD"));
    // On no branch: nothing is committed, and the way on is said.
    git(dir, ["checkout", "-q", "--detach"]);
    const detached = run(UNIT, ["commit-record"], dir);
    expect(detached.status).not.toBe(0);
    expect(detached.out).toContain("This checkout is not on a branch, so nothing was committed. Switch to a branch, then I can commit AI-DLC's record.");
    git(dir, ["switch", "-q", "main"]);
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
    // Committed: AI-DLC's record only; the file staged outside it stays staged and out of it.
    const done = run(UNIT, ["commit-record"], dir);
    expect(done.status, done.out).toBe(0);
    const short = git(dir, ["rev-parse", "--short", "HEAD"]);
    expect(String(done.json?.notice)).toMatch(new RegExp(`^AI-DLC's record in aidlc/ is committed on main as ${short} \\(\\d+ files?\\); nothing is pushed\\.$`));
    const went = git(dir, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    expect(went).toContain(units);
    expect(went.filter((path) => !path.startsWith("aidlc/")), went.join(", ")).toEqual([]);
    expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("outside.md");
    expect(git(home.remote, ["rev-parse", "main"])).toBe(head);
    // Nothing more to commit: said, and not a failure.
    const again = run(UNIT, ["commit-record"], dir);
    expect(again.status, again.out).toBe(0);
    expect(again.json?.notice).toBe("AI-DLC's record in aidlc/ has nothing new to commit.");
  });

  // The live run's shape: the lead keeps AI-DLC's records on a branch called
  // records, in the Way of Working words, with no Integration branch line.
  test("unit commit-record takes the commit message from its file, spends it once committed, and after a commit-msg hook refuses says the one way on", () => {
    const home = makeHome();
    const dir = home.dir;
    const file = `${REQUEST_TEXT_DIR}/unit-record-message-by-hand.txt`;
    const note = (words: string) => writeFileSync(join(dir, UNITS_FILE), `${readFileSync(join(dir, UNITS_FILE), "utf-8")}${words}\n`);
    note("A note of the lead's.");
    // A message file outside its folder is refused in the flag's own words, and nothing is committed.
    writeFileSync(join(dir, "message.txt"), "docs(record): by hand\n");
    const head = git(dir, ["rev-parse", "HEAD"]);
    const unread = run(UNIT, ["commit-record", "--commit-message-file", "message.txt"], dir);
    expect(unread.status).not.toBe(0);
    expect(unread.out).toContain(`commit-record --commit-message-file needs the commit message in a file directly inside ${REQUEST_TEXT_DIR}/ ` +
      "in this project, written with your file tool. Nothing was committed.");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
    // Their commit-msg hook turns the first commit away: git's words, one way on, nothing pushed, the file kept.
    writeFileSync(join(dir, ".git", "refuse-once"), "");
    writeFileSync(join(dir, ".git", "hooks", "commit-msg"),
      "#!/bin/sh\nif [ -f .git/refuse-once ]; then rm .git/refuse-once; echo 'commit messages need a ticket' >&2; exit 1; fi\nexit 0\n");
    chmodSync(join(dir, ".git", "hooks", "commit-msg"), 0o755);
    mkdirSync(join(dir, REQUEST_TEXT_DIR), { recursive: true });
    writeFileSync(join(dir, ...file.split("/")), "docs(record): the lead's note\n");
    const refused = run(UNIT, ["commit-record", "--commit-message-file", file], dir);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("commit messages need a ticket");
    expect(refused.out).toContain("If it is the commit message, tell me the one to use, and I will commit with it.");
    expect(refused.out).not.toContain("push again");
    expect(existsSync(join(dir, ...file.split("/")))).toBe(true);
    const done = run(UNIT, ["commit-record", "--commit-message-file", file], dir);
    expect(done.status, done.out).toBe(0);
    expect(git(dir, ["log", "-1", "--format=%s"])).toBe("docs(record): the lead's note");
    expect(existsSync(join(dir, ...file.split("/")))).toBe(false);
    // The message file sits in AI-DLC's own git-ignored folder: never in the commit, and never a reason to commit.
    expect(git(dir, ["diff-tree", "-r", "--no-commit-id", "--name-only", "HEAD"])).not.toContain("request-text");
    writeFileSync(join(dir, ...file.split("/")), "a draft nobody used\n");
    const nothing = run(UNIT, ["commit-record"], dir);
    expect(nothing.status, nothing.out).toBe(0);
    expect(nothing.json?.committed).toBe(false);
    // With no message file, the fallback.
    note("Another note.");
    expect(run(UNIT, ["commit-record"], dir).status).toBe(0);
    expect(git(dir, ["log", "-1", "--format=%s"])).toBe("Update AI-DLC's record");
  });

  test("a commit-msg hook that refuses the share's commit: git's words and one way on, push again only where the share pushes", () => {
    for (const ownBranch of [false, true]) {
      const home = makeHome();
      if (ownBranch) git(home.dir, ["switch", "-q", "-c", "plan-review"]);
      chooseTeams(home.dir);
      writeFileSync(join(home.dir, ".git", "hooks", "commit-msg"), "#!/bin/sh\necho 'commit messages need a ticket' >&2\nexit 1\n");
      chmodSync(join(home.dir, ".git", "hooks", "commit-msg"), 0o755);
      const refused = run(UNIT, ["share", "--plan"], home.dir);
      expect(refused.status, refused.out).not.toBe(0);
      expect(refused.out).toContain("commit messages need a ticket");
      expect(refused.out).toContain(ownBranch
        ? "If it is the commit message, tell me the one to use, and I will commit with it."
        : "If it is the commit message, tell me the one to use, and I will commit with it and push again.");
      if (ownBranch) expect(refused.out).not.toContain("push again");
      expect(refused.out).not.toContain("Then share again");
    }
  });

  test("the share question shows the commit message drafted for it; the person's words go in, and a push that does not go keeps the file for the same command", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask).slice(0, 600)).toBe(true);
    const file = `${REQUEST_TEXT_DIR}/unit-share-message-plan.txt`;
    expect(ask.commit_message_file).toBe(file);
    expect(String(ask.question)).toContain("I'd commit the plan here (AI-DLC's record, nothing else of yours) with this commit message and push");
    expect(String(ask.question)).toEndWith("\n\nShare the plan with the teams");
    const choices = ask.choices as Array<{ label: string; command?: string }>;
    for (const choice of choices.slice(0, -1)) expect(String(choice.command), choice.label).toEndWith(` --commit-message-file ${file}`);
    writeFileSync(join(home.dir, ...file.split("/")), "chore(plan): share the refunds plan\n");
    const url = git(home.dir, ["remote", "get-url", "origin"]);
    git(home.dir, ["remote", "set-url", "origin", join(home.remote, "gone")]);
    const away = run(UNIT, ["share", "--plan", "--commit-message-file", file], home.dir);
    expect(away.status).not.toBe(0);
    expect(existsSync(join(home.dir, ...file.split("/")))).toBe(true);
    git(home.dir, ["remote", "set-url", "origin", url]);
    const shared = run(UNIT, ["share", "--plan", "--commit-message-file", file], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(git(home.remote, ["log", "-1", "--format=%s", "main"])).toBe("chore(plan): share the refunds plan");
    expect(existsSync(join(home.dir, ...file.split("/")))).toBe(false);
  });

  test("a lead whose Way of Working keeps the records on a branch: the share reads it first and pushes that branch, never main", () => {
    const home = makeHome();
    const team = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(team, readFileSync(team, "utf-8").replace("## Way of Working\n",
      "## Way of Working\n\nWe keep AI-DLC's records on a branch called records, never on main; main only gets them through a pull request.\n"));
    git(home.dir, ["switch", "-q", "-c", "records"]);
    chooseTeams(home.dir);
    const before = git(home.remote, ["rev-parse", "main"]);
    const ask = next(home.dir);
    expect(isShare(ask)).toBe(true);
    const file = String(ask.commit_message_file);
    writeFileSync(join(home.dir, ...file.split("/")), "chore(plan): the records branch plan\n");
    const read = run(UNIT, ["share", "--plan", "--commit-message-file", file], home.dir);
    expect(read.status, read.out).toBe(0);
    expect(read.json?.shared).toBe(false);
    expect(String(read.json?.step)).toContain("practices-branch --file team.md");
    // Its run again carries the message it was given.
    expect(String(read.json?.step)).toContain(` unit share --plan --commit-message-file ${file}\` again`);
    const recorded = run(STATE, ["practices-branch", "--file", "team.md", "--branch", "records"], home.dir);
    expect(recorded.status, recorded.out).toBe(0);
    const shared = run(UNIT, ["share", "--plan", "--commit-message-file", file], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(git(home.dir, ["log", "-1", "--format=%s"])).toBe("chore(plan): the records branch plan");
    expect(shared.json).toMatchObject({ shared: true, branch: "records" });
    expect(git(home.remote, ["rev-parse", "records"])).toBe(git(home.dir, ["rev-parse", "HEAD"]));
    expect(git(home.remote, ["rev-parse", "main"])).toBe(before);
    expect(isShare(next(home.dir))).toBe(false);
  });

  // The GitHub re-run (case 12), once the lead's records branch was recorded:
  // the share question named it, and its Not now still said main.
  test("a lead whose records branch is recorded: every line of the share question names it, Not now too, and Share pushes it", () => {
    const home = makeHome();
    git(home.dir, ["switch", "-q", "-c", "team-records"]);
    git(home.dir, ["push", "-q", "-u", "origin", "team-records"]);
    const recorded = run(STATE, ["practices-branch", "--file", "team.md", "--branch", "team-records"], home.dir);
    expect(recorded.status, recorded.out).toBe(0);
    chooseTeams(home.dir);
    const before = git(home.remote, ["rev-parse", "main"]);
    const offer = next(home.dir) as Record<string, unknown> & Offer;
    expect(isShare(offer), JSON.stringify(offer).slice(0, 600)).toBe(true);
    for (const line of [offer.question, ...offer.choices.map((choice) => choice.detail ?? "")]) expect(line).not.toMatch(/\bmain\b/);
    expect(offer.choices.find((choice) => choice.label === "Not now")?.detail)
      .toBe("Nothing is pushed; a team's clone sees the plan once team-records is pushed.");
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.json, shared.out).toMatchObject({ shared: true, branch: "team-records" });
    expect(git(home.remote, ["rev-parse", "team-records"])).toBe(git(home.dir, ["rev-parse", "HEAD"]));
    expect(git(home.remote, ["rev-parse", "main"])).toBe(before);
  });

  test("a lead who named no branch: Not now still says the plan reaches the teams once main is pushed", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const offer = next(home.dir) as Record<string, unknown> & Offer;
    expect(isShare(offer), JSON.stringify(offer).slice(0, 600)).toBe(true);
    expect(offer.choices.find((choice) => choice.label === "Not now")?.detail)
      .toBe("Nothing is pushed; a team's clone sees the plan once main is pushed.");
  });

  test("a file the person staged stays theirs, staged, and the share counts what it committed", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    writeFileSync(join(home.dir, "split.md"), "one\n");
    writeFileSync(join(home.dir, "shared.ts"), "export const a = 1;\n");
    git(home.dir, ["add", "split.md", "shared.ts"]);
    git(home.dir, ["commit", "-q", "-m", "the person's files"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    writeFileSync(join(home.dir, "shared.ts"), "export const a = 2;\n");
    writeFileSync(join(home.dir, "z-deploy.env"), "KEY=1\n");
    writeFileSync(join(home.dir, "staged-only.txt"), "staged\n");
    writeFileSync(join(home.dir, "split.md"), "one\nstaged half\n");
    git(home.dir, ["add", "staged-only.txt", "split.md"]);
    writeFileSync(join(home.dir, "split.md"), "one\nstaged half\nunstaged half\n");
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const went = git(home.dir, ["diff-tree", "-r", "--no-commit-id", "--name-only", "HEAD"]).split("\n").filter(Boolean);
    expect(went.filter((path) => !path.startsWith("aidlc/")), went.join(", ")).toEqual([]);
    expect(shared.json?.committed_paths).toBe(went.length);
    expect(git(home.remote, ["rev-parse", "main"])).toBe(git(home.dir, ["rev-parse", "HEAD"]));
    expect(git(home.dir, ["diff", "--cached", "--name-only"]).split("\n").sort()).toEqual(["split.md", "staged-only.txt"]);
    expect(git(home.dir, ["show", ":split.md"])).toBe("one\nstaged half");
    expect(readFileSync(join(home.dir, "split.md"), "utf-8")).toBe("one\nstaged half\nunstaged half\n");
    expect(git(home.dir, ["status", "--porcelain", "--", "shared.ts", "z-deploy.env"])).toBe("M shared.ts\n?? z-deploy.env");
  });
});

describe("after the share nothing is built at the lead's project until the lead asks", () => {
  test("the step is the board, each Unit open and waiting for a team to take it", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    share(home.dir);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(String(step.narration)).toStartWith("Units of fixture:");
    for (const unit of UNITS) expect(String(step.narration)).toContain(`- ${unit}, open: waiting for a team to take it`);
    expect(tellsWhatToType(step.message, step.offers)).toBe(false);
    expect(next(home.dir).kind).toBe("print");
    expect(readAuditShardEvents(home.dir).some((row) => row.event === "UNIT_STARTED")).toBe(false);
  });

  // Live runs (x2783-s9, Claude Code at the lead's project): the rhythm was
  // asked again after the lead had answered it.
  test("the board offers the approval rhythm until the lead answers it, and never after", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    share(home.dir);
    const chat = (name: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: `t-unit-assignment-rhythm-${name}` });
    const rhythm = (step: Record<string, unknown>) =>
      ((step.offers ?? []) as Offer[]).find((offer) => offer.question === RHYTHM_OFFER);
    const board = next(home.dir, chat("first"));
    expect(board.kind, JSON.stringify(board)).toBe("print");
    const offer = rhythm(board);
    expect(offer, JSON.stringify(board.offers)).toBeDefined();
    expect(offer!.choices.map((choice) => choice.label)).toEqual(["Keep approvals after every stage", "Approve once at the end of each Unit"]);
    expect(offer!.choices[0]).toMatchObject({ label: "Keep approvals after every stage", recommended: true });
    expect(offer!.choices[0].command).toEndWith("aidlc-state.ts set-unit-gate-rhythm per-stage");
    expect(offer!.choices[1].command).toEndWith("aidlc-state.ts set-unit-gate-rhythm unit-end");
    // Not answered yet: a later chat is offered it again.
    expect(rhythm(next(home.dir, chat("later"))), "unanswered, offered again").toBeDefined();
    // The lead keeps it: never offered again.
    expect(run(STATE, ["set-unit-gate-rhythm", "per-stage"], home.dir).status).toBe(0);
    const after = next(home.dir, chat("after"));
    expect(after.kind, JSON.stringify(after)).toBe("print");
    expect(rhythm(after)).toBeUndefined();
    expect(JSON.stringify(after.offers ?? [])).not.toContain("Each team will approve its Unit");
  });

  test("the board's note names the lead's word to build a Unit here, and no way to name a team or leave one open", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    share(home.dir);
    const board = next(home.dir);
    expect(board.kind, JSON.stringify(board)).toBe("print");
    const note = String(board.board_note);
    expect(note).toContain(
      "when they ask to build a Unit left open here, run `bun .claude/tools/aidlc-unit.ts assign --here <unit> " +
        `--request-file ${REQUEST_TEXT_DIR}/unit-assign.txt\``,
    );
    expect(note).not.toContain("assign <unit>=<team>");
    expect(note).not.toContain("assign --open");
    expect(note).not.toContain("--started-here");
    expect(note).not.toContain("hand-off");
    // Nothing on the board puts a hold for a team in the agent's words.
    expect(JSON.stringify(board)).not.toMatch(/\bhold|\breserve/i);
  });
});

describe("the lead's word builds a Unit here: assign --here", () => {
  test("a take for the lead's project: its claim, one record with the lead's words, its line, and the next step builds it", () => {
    const home = makeHome();
    git(home.dir, ["config", "user.name", "lee"]);
    chooseTeams(home.dir);
    share(home.dir);
    const words = "let's build refunds here ourselves";
    const here = run(UNIT, ["assign", "--here", "refunds", "--person-words", words], home.dir);
    expect(here.status, here.out).toBe(0);
    expect(here.json?.notice).toBe("refunds is built here now, no longer open for the teams.");
    expect(tellsWhatToType(here.json?.notice)).toBe(false);
    const id8 = fixtureIntentId8(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "claimed", owner: "default", taken_by: "lee" });
    expect(claimPayload(home.remote, id8, "checkout-ui")).toBeNull();
    expect(claimPayload(home.remote, id8, "reporting")).toBeNull();
    // The lead's checkout stays the home's: it is never scoped to the Unit.
    expect(existsSync(join(home.dir, "aidlc", ".aidlc-engine", "units", "claimed.json"))).toBe(false);
    const rows = readAuditShardEvents(home.dir).filter((row) => row.event === "UNITS_ASSIGNED");
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Here")).toBe("refunds");
    expect(auditBlockField(rows[0].block, "Person Words")).toBe(words);
    for (const gone of ["Assigned", "Open", "Left Open", "Held"]) expect(auditBlockField(rows[0].block, gone)).toBeNull();
    expect(next(home.dir)).toMatchObject({ kind: "run-stage", unit: "refunds" });
  });

  // A live run (Claude Code): the line stayed folded in the tool's frame and
  // the agent said in its own words that it had 'claimed' the Unit.
  test("from a chat, the line that a Unit is built here rides the step that follows, said once", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    share(home.dir);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "lead-chat" };
    const here = run(UNIT, ["assign", "--here", "refunds", "--person-words", "build refunds here"], home.dir, chat);
    expect(here.status, here.out).toBe(0);
    expect(here.json?.notice, here.out).toBeUndefined();
    const step = next(home.dir, chat);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 600))
      .toContain("refunds is built here now, no longer open for the teams.");
    expect(JSON.stringify(next(home.dir, chat))).not.toContain("refunds is built here now");
  });

  // A live run (Claude Code): after Not now on the share, the lead's 'build
  // the API here' pushed the Unit's claim branch to their remote unasked.
  test("before the plan is shared, the lead's word builds it here and pushes nothing; the share then sends its claim with the plan", () => {
    const home = makeHome();
    git(home.dir, ["config", "user.name", "lee"]);
    chooseTeams(home.dir);
    const id8 = fixtureIntentId8(home.dir);
    const refs = (): string => git(home.remote, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const before = refs();
    const here = run(UNIT, ["assign", "--here", "refunds", "--person-words", "build refunds here"], home.dir);
    expect(here.status, here.out).toBe(0);
    expect(here.json?.notice).toBe("refunds is built here now, no longer open for the teams.");
    expect(refs()).toBe(before);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(shared.json?.notice).toBe("Pushed main, and the note that refunds is built here, to origin.");
    expect(git(home.remote, ["rev-parse", "main"])).toBe(git(home.dir, ["rev-parse", "HEAD"]));
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "claimed", owner: "default", taken_by: "lee" });
    expect(claimPayload(home.remote, id8, "checkout-ui")).toBeNull();
    // A teammate's clone: it is not offered, and a take by name says who builds it.
    const ana = cloneOf(home.remote, "ana");
    const offer = next(ana);
    expect(((offer.choices ?? []) as Array<{ label: string }>).map((choice) => choice.label), JSON.stringify(offer).slice(0, 600))
      .not.toContain("Start refunds");
    const took = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], ana);
    expect(took.status, took.out).not.toBe(0);
    expect(took.out).toContain("lee");
  });

  test("the lead's words reach the record whole through the file the board's note names: apostrophes, $ and backticks", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    share(home.dir);
    const board = next(home.dir);
    const file = /assign --here <unit> --request-file (\S+?)`/.exec(String(board.board_note))?.[1];
    expect(file).toBe(`${REQUEST_TEXT_DIR}/unit-assign.txt`);
    const words = "we build refunds here, it's $HOME's `job`";
    mkdirSync(join(home.dir, file!, ".."), { recursive: true });
    writeFileSync(join(home.dir, file!), `${words}\n`);
    const here = run(UNIT, ["assign", "--here", "refunds", "--request-file", file!], home.dir);
    expect(here.status, here.out).toBe(0);
    const row = readAuditShardEvents(home.dir).find((entry) => entry.event === "UNITS_ASSIGNED");
    expect(row?.block).toContain(`**Person Words**: ${words}`);
    // Spent once the command has done its work.
    expect(existsSync(join(home.dir, file!))).toBe(false);
  });

  test("words with no turn of the lead's behind them are not recorded as the lead's", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const guarded: NodeJS.ProcessEnv = { ...ENV, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "" };
    const here = run(UNIT, ["assign", "--here", "refunds", "--person-words", "the agent's guess"], home.dir, guarded);
    expect(here.status, here.out).toBe(0);
    const row = readAuditShardEvents(home.dir).filter((entry) => entry.event === "UNITS_ASSIGNED").at(-1);
    expect(auditBlockField(row?.block ?? "", "Here")).toBe("refunds");
    expect(row?.block).not.toContain("Person Words");
  });

  test("a team named for a Unit is refused: assign takes only --here", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const named = run(UNIT, ["assign", "refunds=payments"], home.dir);
    expect(named.status, named.out).toBe(2);
    expect(named.out).toContain("unit assign does not take");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toBeNull();
    expect(readAuditShardEvents(home.dir).some((row) => row.event === "UNITS_ASSIGNED")).toBe(false);
  });
});

// Live runs: the lead had answered that no slice is built together first
// (their team's practices), and the question of who builds which part still
// named one, leaving that part off the teams' list.
describe("the walking skeleton is built at the lead's project first, and every other Unit is open", () => {
  const stance = (dir: string) => field(readFileSync(join(dir, "aidlc", "spaces", "default", "intents", "fixture-8000000000000001", "aidlc-state.md"), "utf-8"), "Skeleton Stance");

  test("the lead's own answer on it is read first: settled off, no question names a part as built first and every Unit is open", () => {
    const home = makeHome({ state: homeState().replace("- **Skeleton Stance**: off\n", "") });
    // Their team's practices answer it (Practices Discovery writes this section).
    const memory = join(home.dir, "aidlc", "spaces", "default", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "team.md"), "# Team rules\n\n## Walking Skeleton\n\nNo thin slice first: each Unit is built on its own.\n");
    chooseTeams(home.dir);
    const settle = next(home.dir);
    expect(isShare(settle), JSON.stringify(settle)).toBe(false);
    expect(settle.gate, JSON.stringify(settle)).toBe("unresolved");
    expect(run(ORCH, ["report", "--skeleton-stance", "off"], home.dir).status).toBe(0);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    expect(String(ask.question)).not.toContain("first");
    share(home.dir);
    const board = next(home.dir);
    expect(board.kind, JSON.stringify(board)).toBe("print");
    for (const unit of UNITS) expect(String(board.narration)).toContain(`- ${unit}, open: waiting for a team to take it`);
  });

  // A live run (Claude Code, Linux): the share question said every Unit was
  // open while the slice was the lead's to build and the others waited on it.
  // As main does: its handout line, once, and the share once the slice is approved.
  const HANDOUT = "No team has taken a Unit yet, so this session builds them here, starting with the checkout ui Unit, " +
    "the walking skeleton the others build on. Once it is built and approved, I'll offer to share the work so each team can take one of the others.";
  const SHARE = "The Units are open for any team to take. Share the plan with them now? I'd commit the plan here (AI-DLC's record, " +
    "nothing else of yours) with this commit message and push it on its own branch for a pull request, so each team can take its " +
    "Unit once it is in main, by opening its own clone and running /aidlc.\n\nShare the plan with the teams";
  const sliceOn = () => makeHome({ state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
  // Once the slice is approved the share question comes as today (t-unit-board).
  test("on and not approved: the lead's look says main's handout line once, builds the slice, and puts no share question", () => {
    const home = sliceOn();
    chooseTeams(home.dir);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "lead-slice" };
    const first = next(home.dir, chat);
    expect(isShare(first), JSON.stringify(first).slice(0, 600)).toBe(false);
    expect(first).toMatchObject({ kind: "run-stage", unit: "checkout-ui" });
    expect((first.change_notices ?? []) as string[], JSON.stringify(first).slice(0, 900)).toContain(HANDOUT);
    const again = next(home.dir, chat);
    expect(isShare(again), JSON.stringify(again).slice(0, 600)).toBe(false);
    expect(JSON.stringify(again)).not.toContain(HANDOUT);
    expect(stance(home.dir)).toBe("on");
  });

  test("on, then the lead leaves it to the teams (the slice turned off): the share question comes at once, as today", () => {
    const home = sliceOn();
    chooseTeams(home.dir);
    expect(isShare(next(home.dir))).toBe(false);
    const off = run(ORCH, ["report", "--skeleton-stance", "off"], home.dir);
    expect(off.status, off.out).toBe(0);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask).slice(0, 600)).toBe(true);
    expect(ask.question).toBe(SHARE);
  });

  // The skeleton's approvals at the lead's project come before the board, and
  // once one is asked after every stage the rhythm no longer changes.
  test("on, the approval rhythm is offered with the skeleton's first step, before its first approval", () => {
    const home = makeHome({ state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    chooseTeams(home.dir);
    share(home.dir);
    const step = next(home.dir);
    expect(step, JSON.stringify(step).slice(0, 400)).toMatchObject({ kind: "run-stage", unit: "checkout-ui" });
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 600)).toContain(RHYTHM_OFFER);
  });
});

describe("the approval rhythm is offered only while it can still change", () => {
  test("once a Unit's approval was asked after every stage, the board does not offer it", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    share(home.dir);
    appendAuditEntry("STAGE_AWAITING_APPROVAL", { Stage: "functional-design", Unit: "refunds", "Gate Scope": "per-stage" }, home.dir);
    const board = next(home.dir);
    expect(board.kind, JSON.stringify(board)).toBe("print");
    expect(JSON.stringify(board.offers ?? [])).not.toContain("Each team will approve its Unit");
    expect(run(STATE, ["set-unit-gate-rhythm", "unit-end"], home.dir).status).not.toBe(0);
  });
});

describe("a skip at the lead's project is of a Unit built there", () => {
  test("at a home with nothing of its own to build now, a skip is never put as a skip of a team's Unit", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    share(home.dir);
    expect(next(home.dir).kind).toBe("print");
    // The person's skip of a step: not offered for an open Unit.
    const asked = run(ORCH, ["next", "--skip", "functional-design"], home.dir);
    expect(asked.status, asked.out).toBe(0);
    expect(String(asked.json?.message), asked.out).not.toContain("checkout-ui");
    expect(String(asked.json?.message), asked.out).not.toContain("--unit refunds");
    // The agent's own skip report names no open Unit as the step in progress.
    const reported = run(ORCH, [
      "report", "--stage", "functional-design", "--unit", "reporting", "--result", "skipped", "--reason", "no domain logic",
    ], home.dir);
    expect(reported.out).not.toContain("checkout-ui");
  });

  test("a skip of the step the home hands out is that Unit's: the walk the skip reads holds the same Units", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    share(home.dir);
    expect(run(UNIT, ["assign", "--here", "checkout-ui"], home.dir).status).toBe(0);
    const step = next(home.dir);
    expect(step.unit, JSON.stringify(step)).toBe("checkout-ui");
    const stage = String(step.stage);
    const skipped = run(ORCH, [
      "report", "--stage", stage, "--unit", "checkout-ui", "--result", "skipped", "--reason", "checkout-ui has no domain logic",
    ], home.dir);
    expect(skipped.status, skipped.out).toBe(0);
    expect(JSON.parse(skipped.stdout).reason, skipped.out).toBe(`Skipped "${stage}" for unit "checkout-ui". Run next to continue.`);
  });
});

describe("work that is never asked", () => {
  test("one-Unit work", () => {
    const home = makeHome({
      dependencies: "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n```\n",
    });
    chooseTeams(home.dir);
    const step = next(home.dir);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("unit-assignment");
    expect(JSON.stringify(step)).not.toContain("Who builds which Unit");
  });

  test("several teams on one repo with a remote (no code repos recorded): the home is recorded, no assignment question, no repos.json offer", () => {
    const home = makeHome({ repos: {} });
    chooseTeams(home.dir);
    expect(field(stateOf(home.dir), "Home Location")).toBe(home.remote);
    const step = next(home.dir);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("unit-assignment");
    expect(step.ask_type, JSON.stringify(step)).not.toBe("repos-manifest");
    expect(existsSync(join(home.dir, "repos.json"))).toBe(false);
    // The plan's share, as for teams across repos: each team takes its Unit from its own clone.
    expect(isShare(step), JSON.stringify(step)).toBe(true);
    expect(String(step.question)).toStartWith("The Units are open for any team to take.");
  });

  // Main's own flow stays where nothing reaches the work but this machine, and
  // for work that chose teams on it before.
  test("several teams on one repo with no remote keep main's team flow: no home is recorded", () => {
    const home = makeHome({ repos: {} });
    git(home.dir, ["remote", "remove", "origin"]);
    chooseTeams(home.dir);
    expect(field(stateOf(home.dir), "Home Location")).toBeUndefined();
    expect(String(next(home.dir).question ?? "")).not.toStartWith("The Units are open for any team to take.");
  });

  test("team work on one repo that chose teams before keeps main's flow: no home, and main's share", () => {
    const home = makeHome({ repos: {}, state: homeState(["- **Unit Ownership**: team"]) });
    chooseTeams(home.dir);
    expect(field(stateOf(home.dir), "Home Location")).toBeUndefined();
    const step = next(home.dir);
    expect(isShare(step), JSON.stringify(step)).toBe(true);
    expect(String(step.question)).toStartWith("The plan's 3 Units are ready for the teams. Share them now?");
  });

  test("team work on one repo with main's claims out, switched to one Unit at a time and back to teams, keeps main's flow", () => {
    const home = makeHome({ repos: {}, state: homeState(["- **Unit Ownership**: team"]) });
    const bob = cloneOf(home.remote, "bob");
    const claimed = run(UNIT, ["claim", "refunds", "--team", "payments"], bob);
    expect(claimed.status, claimed.out).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const solo = run(STATE, ["set-unit-ownership", "solo"], home.dir);
    expect(solo.status, solo.out).toBe(0);
    chooseTeams(home.dir);
    expect(field(stateOf(home.dir), "Home Location")).toBeUndefined();
  });

  // Main's flow is kept for its own claims only: a team's record AI-DLC keeps here under its own ref (a take of
  // this work given back, which switched nothing) is the build-out's, so it never keeps the work on main's flow.
  test("team work on one repo whose only claim here is a team record under refs/aidlc takes the build-out", () => {
    const home = makeHome({ repos: {} });
    git(home.dir, ["update-ref", `refs/aidlc/remotes/origin/claims/${fixtureIntentId8(home.dir)}/refunds`, "HEAD"]);
    chooseTeams(home.dir);
    expect(field(stateOf(home.dir), "Home Location")).toBe(home.remote);
  });

  test("team work without a recorded home keeps the flow it started on", () => {
    const home = makeHome({ state: homeState(["- **Unit Ownership**: team"]) });
    const step = next(home.dir);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("unit-assignment");
    expect(JSON.stringify(step)).not.toContain("Who builds which Unit");
  });
});

// A live run: with the orders API built alone at the lead's project and its
// approval open, the lead's word about the other Units held the API for a
// team, and the lead's approval of it was refused.
describe("a Unit the lead's project started stays there", () => {
  test("with no claim it stays the lead's: the walk builds it, and a teammate's take of it is refused", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "refunds", "Run floor": "0" }, home.dir);
    pushAll(home.dir);
    expect(next(home.dir)).toMatchObject({ kind: "run-stage", unit: "refunds" });
    const sam = cloneOf(home.remote, "sam");
    const took = takeIn("web", ["refunds", "--home", HOME_RECORD], sam);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("refunds is being built at the lead's project, so it is not open to take.");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toBeNull();
  });
});
