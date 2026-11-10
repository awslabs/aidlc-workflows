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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents, REQUEST_TEXT_DIR } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, seededRecordDir } from "../harness/fixtures.ts";
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
  next,
  ORCH,
  run,
  STATE,
  stateOf,
  takeIn,
  tellsWhatToType,
  UNIT,
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

  test("asked once: Share pushes main, and Not now is kept", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    const choices = ask.choices as Array<{ label: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Share them with the teams", "Not now"]);
    expect(String(choices[0].command)).toEndWith(" unit share --plan");
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
        "nothing else of yours) and push main to origin, so each team can take its Unit by opening its own clone and running /aidlc.",
    );
    expect((asked.choices as Offer["choices"])[0]).toMatchObject({
      label: "Share them with the teams",
      detail: "Pushes main to origin as a plain push; it never overwrites what a team pushed.",
    });
    const one = makeHome();
    chooseTeams(one.dir);
    expect(run(UNIT, ["assign", "--here", "refunds", "--person-words", "build refunds here"], one.dir).status).toBe(0);
    const withOne = next(one.dir);
    expect(withOne.question).toBe(
      "The Units are open for any team to take. Share the plan with them now? I'd commit the plan here (AI-DLC's record, " +
        "nothing else of yours) and push main to origin, with the note that refunds is built here, so each team can take " +
        "its Unit by opening its own clone and running /aidlc.",
    );
    expect((withOne.choices as Offer["choices"])[0].detail)
      .toBe("Pushes main, and the note that refunds is built here, to origin; it never overwrites what a team pushed.");
    const two = makeHome();
    chooseTeams(two.dir);
    expect(run(UNIT, ["assign", "--here", "refunds,checkout-ui", "--person-words", "build both here"], two.dir).status).toBe(0);
    const withTwo = next(two.dir);
    expect(String(withTwo.question)).toContain(", with the note that refunds and checkout-ui are built here, so each team");
    expect((withTwo.choices as Offer["choices"])[0].detail)
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

  test("on, it is built here first, no question names it, and every other Unit is open", () => {
    const home = makeHome({ state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    chooseTeams(home.dir);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    expect(String(ask.question)).not.toContain("first");
    expect(String(ask.question)).not.toContain("walking skeleton");
    share(home.dir);
    // The skeleton is the first Unit of the plan's first batch, checkout-ui.
    expect(next(home.dir)).toMatchObject({ kind: "run-stage", unit: "checkout-ui" });
    const board = run(ORCH, ["team-board"], home.dir);
    expect(board.status, board.out).toBe(0);
    expect(board.stdout).toContain("- refunds, open: waiting for a team to take it");
    expect(board.stdout).toContain("- reporting, open: waiting for a team to take it");
    expect(board.stdout).not.toContain("- checkout-ui, open");
    expect(stance(home.dir)).toBe("on");
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

  test("several teams on one repo (no code repos recorded) keep main's team flow: no home, no assignment question, no repos.json offer", () => {
    const home = makeHome({ repos: {} });
    chooseTeams(home.dir);
    expect(field(stateOf(home.dir), "Home Location")).toBeUndefined();
    const step = next(home.dir);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("unit-assignment");
    expect(step.ask_type, JSON.stringify(step)).not.toBe("repos-manifest");
    expect(existsSync(join(home.dir, "repos.json"))).toBe(false);
    // Main's own next hand-over: the share question, with the remote to share to.
    expect(step.ask_type, JSON.stringify(step)).toBe("team-handover");
    expect(step.handovers, JSON.stringify(step)).toEqual(["share"]);
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
