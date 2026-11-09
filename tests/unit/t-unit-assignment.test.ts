// covers: subcommand:aidlc-unit:assign, subcommand:aidlc-state:set-unit-ownership, audit:UNITS_ASSIGNED, function:homeLocation, function:buildOutHomeLocation, function:unitsAssignedSinceTeams
//
// Who builds which Unit (#2410, item 3). Choosing teams records where the home
// is (the workspace's own origin, read only); the home then asks once who
// builds which Unit, and the lead answers in their own words. Each Unit they
// name for a team becomes a claim held for that team, with no scope stamp, so
// the lead's checkout stays the home's; a Unit left out stays open; a Unit held
// by one team is never given to another. The home walks only the Units no team
// holds. One-Unit work is never asked. Several teams on work whose code is
// the workspace's own repo keep main's claim and land flow instead.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
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
  tellsWhatToType,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();

function chooseTeams(dir: string): void {
  const result = run(STATE, ["set-unit-ownership", "team"], dir);
  expect(result.status, result.out).toBe(0);
}

// The lead's yes to sharing the plan with the teams (main's `unit share`).
function share(dir: string): void {
  const shared = run(UNIT, ["share", "--plan"], dir);
  expect(shared.status, shared.out).toBe(0);
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

describe("who builds which Unit is asked once, at the home", () => {
  test("the first Construction step after choosing teams is the question", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const ask = next(home.dir);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("unit-assignment");
    expect(ask.response_route).toBe("command");
    expect(ask.question).toBe(
      "Who builds which Unit? refunds (likely checkout-api, billing), checkout-ui (likely checkout-web), " +
        "reporting (likely billing; waits on refunds). Name a team for each, or leave a Unit open for any team to " +
        "take later.",
    );
    const choices = ask.choices as Array<{ label: string; command?: string; detail?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Name the teams", "Leave them all open"]);
    // Open means open for any team: the lead hears that nothing starts here until they say.
    expect(choices[1].detail).toBe("Any team takes a Unit when it is ready; nothing is built here until you ask for it.");
    expect(choices[0].command).toBeUndefined();
    expect(String(choices[1].command)).toEndWith("aidlc-unit.ts assign --open");
    expect(String(ask.assign_command)).toContain("assign <unit>=<team>");
    expect(String(ask.question_note)).toContain("run assign_command with one <unit>=<team>");
    // The question is how Units go to teams here: main's line on taking one in
    // a clone of this workspace is not said beside it.
    expect(JSON.stringify(ask)).not.toContain("unit participate");
  });

  test("the lead's words become one claim per named Unit, held for that team, and the checkout stays the home's", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    next(home.dir);
    const words = "refunds goes to payments, checkout-ui to web, leave reporting open";
    const assigned = run(UNIT, ["assign", "refunds=payments", "checkout-ui=web", "--open", "reporting", "--person-words", words], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    expect(assigned.json?.notice).toBe(
      "Refunds: payments. Checkout-ui: web. Open for any team: reporting. Each team will approve its Unit after every " +
        "stage. Do you want them to approve once at the end of each Unit instead? I'd keep after every stage, so a wrong " +
        "turn is caught at the stage where it happens.",
    );
    expect(tellsWhatToType(assigned.json?.notice)).toBe(false);
    // The offer reaches the agent as choices, each with what it runs.
    const offer = assigned.json?.offer as { choices: Array<{ label: string; command?: string }> };
    expect(offer.choices.map((choice) => choice.label)).toEqual(["Keep approvals after every stage", "Approve once at the end of each Unit"]);
    expect(offer.choices[1].command).toEndWith("aidlc-state.ts set-unit-gate-rhythm unit-end");
    const id8 = fixtureIntentId8(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "claimed", owner: "payments" });
    expect(claimPayload(home.remote, id8, "checkout-ui")).toMatchObject({ status: "claimed", owner: "web" });
    expect(claimPayload(home.remote, id8, "reporting")).toBeNull();
    expect(existsSync(join(home.dir, "aidlc", ".aidlc-unit-scope.json"))).toBe(false);
    const rows = readAuditShardEvents(home.dir).filter((row) => row.event === "UNITS_ASSIGNED");
    expect(rows).toHaveLength(1);
    expect(rows[0].block).toContain("**Assigned**: refunds=payments, checkout-ui=web");
    expect(rows[0].block).toContain("**Open**: reporting");
    expect(rows[0].block).toContain("**Left Open**: reporting");
    expect(rows[0].block).toContain(`**Person Words**: ${words}`);
    // Asked once: the next step is not the question again.
    const after = next(home.dir);
    expect(after.ask_type, JSON.stringify(after)).not.toBe("unit-assignment");
  });

  test("the lead's words reach the record whole through the file the command names: apostrophes, $ and backticks", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const ask = next(home.dir);
    const file = /--request-file (\S+)/.exec(String(ask.assign_command))?.[1];
    expect(file).toBe("aidlc/.aidlc-request-text/unit-assign.txt");
    const words = "payments' team takes refunds, it's $HOME's `job`";
    mkdirSync(join(home.dir, file!, ".."), { recursive: true });
    writeFileSync(join(home.dir, file!), `${words}\n`);
    const assigned = run(UNIT, ["assign", "refunds=payments", "--request-file", file!], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    const row = readAuditShardEvents(home.dir).find((entry) => entry.event === "UNITS_ASSIGNED");
    expect(row?.block).toContain(`**Person Words**: ${words}`);
    // Spent once the command has done its work.
    expect(existsSync(join(home.dir, file!))).toBe(false);
  });

  test("a Unit held for one team is never given to another", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    const again = run(UNIT, ["assign", "refunds=web"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toContain("refunds is held by payments, so it stays with them.");
    // Held, so never listed as open, and the Units nobody holds still are.
    expect(again.json?.open).toEqual(["checkout-ui", "reporting"]);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "payments" });
  });

  test("one Unit named for two teams in the same words is said, not guessed", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const both = run(UNIT, ["assign", "refunds=payments", "refunds=web"], home.dir);
    expect(both.status).not.toBe(0);
    expect(both.out).toContain("refunds can go to one team; you named payments and web.");
  });

  test("leave them all open: no claim, and the answer is recorded", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const open = run(UNIT, ["assign", "--open"], home.dir);
    expect(open.status, open.out).toBe(0);
    expect(open.json?.open).toEqual(["refunds", "checkout-ui", "reporting"]);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toBeNull();
    // The plan goes to the teams once, as main's share question asks it; main's
    // "Build them here for now" is its claim flow's, never this home's.
    const step = next(home.dir);
    expect(step.ask_type).not.toBe("unit-assignment");
    expect(step.ask_type, JSON.stringify(step)).toBe("team-handover");
    expect(JSON.stringify(step)).not.toContain("Build them here for now");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
    // Every Unit waits for a team; the board offers to build one that could start here.
    const board = next(home.dir);
    expect(board.kind, JSON.stringify(board)).toBe("print");
    expect(JSON.stringify(board.offers)).toContain("Build refunds here");
    expect(JSON.stringify(board.offers)).not.toContain("Build reporting here");
    expect(run(UNIT, ["assign", "--here", "refunds"], home.dir).status).toBe(0);
    expect(next(home.dir)).toMatchObject({ kind: "run-stage", unit: "refunds" });
  });
});

describe("the lead's answer is never asked for twice", () => {
  test("not yet: the question is not put again, the step offers it, and nothing is built at the home meanwhile", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(next(home.dir).ask_type).toBe("unit-assignment");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not yet, I need to talk to the teams" }, home.dir);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    const offer = (step.offers as Array<{ question: string; choices: Array<{ label: string; command?: string }> }>)[0];
    expect(offer.question).toBe(
      "Who builds which Unit is still yours to say, so nothing is built yet: name a team for each Unit, or leave them " +
        "all open for any team.",
    );
    expect(offer.choices.map((choice) => choice.label)).toEqual(["Name the teams", "Leave them all open"]);
    expect(String(offer.choices[0].command)).toContain("assign <unit>=<team>");
    expect(next(home.dir).kind).toBe("print");
    expect(readAuditShardEvents(home.dir).some((row) => row.event === "UNIT_STARTED")).toBe(false);
    expect(tellsWhatToType(step.message, step.offers)).toBe(false);
  });

  test("a home that cannot be reached keeps the answer: the step offers to try again, and trying holds the Units", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(next(home.dir).ask_type).toBe("unit-assignment");
    git(home.dir, ["remote", "set-url", "origin", join(home.remote, "gone")]);
    const kept = run(UNIT, ["assign", "refunds=payments", "checkout-ui=web", "--person-words", "payments takes refunds, web the UI"], home.dir);
    expect(kept.status, kept.out).toBe(0);
    expect(String(kept.json?.notice)).toBe(
      "Nothing is held for the teams yet: the lead's project could not be reached. I've kept who builds which Unit. Do you want me to try again?",
    );
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    const offer = (step.offers as Array<{ question: string; choices: Array<{ label: string; command?: string }> }>)[0];
    expect(offer.question).toBe(
      "Who builds which Unit is kept, but nothing is held for the teams yet: the lead's project could not be reached. Do you want me to try again?",
    );
    const retry = String(offer.choices[0].command);
    expect(retry).toEndWith("aidlc-unit.ts assign refunds=payments checkout-ui=web --request-file aidlc/.aidlc-request-text/unit-assign.txt");
    git(home.dir, ["remote", "set-url", "origin", home.remote]);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web", "--person-words", "yes, try again"], home.dir).status).toBe(0);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.owner).toBe("payments");
    // Held now: what is asked next is sharing the plan, never the assignment again.
    const after = next(home.dir);
    expect(after.ask_type, JSON.stringify(after)).not.toBe("unit-assignment");
    expect(JSON.stringify(after)).not.toContain("try again");
  });

  // A probe: the home's remote did not answer, and the lead said Not now. The
  // question was put at every /aidlc after, and the home built nothing.
  test("a home that cannot be reached: try again is asked once; after Not now the home builds its open Units, never a team's", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(next(home.dir).ask_type).toBe("unit-assignment");
    git(home.dir, ["remote", "set-url", "origin", join(home.remote, "gone")]);
    const kept = run(UNIT, ["assign", "refunds=payments", "--person-words", "payments takes refunds"], home.dir);
    expect(kept.status, kept.out).toBe(0);
    expect(String(kept.json?.notice)).not.toContain("fatal");
    expect(next(home.dir).kind).toBe("print");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
    const step = next(home.dir);
    expect(JSON.stringify(step)).not.toContain("Do you want me to try again?");
    expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", unit: "checkout-ui" });
    expect((step.change_notices ?? []) as string[], JSON.stringify(step)).toContain(
      "refunds is kept for payments: it waits for its team until the lead's project can be reached and you ask me to try again.",
    );
    expect(JSON.stringify(next(home.dir))).not.toContain("Do you want me to try again?");
  });

  // A live run: team.md's Way of Working named a branch origin did not have,
  // and every try said the lead's project could not be reached, though origin
  // answered.
  test("a branch team.md names that the remote lacks is said as that, with its file; once it is there, trying again holds the Unit", () => {
    const home = makeHome();
    const teamMd = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(teamMd, readFileSync(teamMd, "utf-8").replace("## Way of Working\n", "## Way of Working\n\nIntegration branch: `develop`.\n"));
    chooseTeams(home.dir);
    expect(next(home.dir).ask_type).toBe("unit-assignment");
    const kept = run(UNIT, ["assign", "refunds=payments", "--person-words", "payments takes refunds"], home.dir);
    expect(kept.status, kept.out).toBe(0);
    const why = "origin has no branch develop, the branch named in aidlc/spaces/default/memory/team.md under Way of Working";
    expect(String(kept.json?.notice)).toBe(`Nothing is held for the teams yet: ${why}. I've kept who builds which Unit. Do you want me to try again?`);
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNITS_ASSIGNED").at(-1)?.block).toContain("**Held**: not yet");
    const step = next(home.dir);
    const offer = (step.offers as Array<{ question: string }>)[0];
    expect(offer.question).toBe(`Who builds which Unit is kept, but nothing is held for the teams yet: ${why}. Do you want me to try again?`);
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
    const after = next(home.dir);
    expect((after.change_notices ?? []) as string[], JSON.stringify(after)).toContain(
      "refunds is kept for payments: it waits for its team until that is put right and you ask me to try again.",
    );
    expect(JSON.stringify([kept.json, step, after])).not.toContain("could not be reached");
    git(home.dir, ["push", "-q", "origin", "main:develop"]);
    expect(run(UNIT, ["assign", "refunds=payments", "--person-words", "try again"], home.dir).status).toBe(0);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.owner).toBe("payments");
  });

  test("leave them all open needs no home: nothing to hold, so nothing waits on the remote", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(next(home.dir).ask_type).toBe("unit-assignment");
    git(home.dir, ["remote", "set-url", "origin", join(home.remote, "gone")]);
    const open = run(UNIT, ["assign", "--open"], home.dir);
    expect(open.status, open.out).toBe(0);
    expect(open.json?.open).toEqual(["refunds", "checkout-ui", "reporting"]);
    expect(String(open.json?.notice)).not.toContain("could not be reached");
    let step = next(home.dir);
    expect(JSON.stringify(step)).not.toContain("Do you want me to try again?");
    if (step.ask_type === "team-handover") {
      appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
      step = next(home.dir);
    }
    // The Units wait for a team, and the board offers to build one here; the lead's word builds it.
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(JSON.stringify(step.offers)).toContain("Build refunds here");
    expect(run(UNIT, ["assign", "--here", "refunds"], home.dir).status).toBe(0);
    expect(next(home.dir)).toMatchObject({ kind: "run-stage", unit: "refunds" });
  });

  test("words with no turn of the lead's behind them are not recorded as the lead's", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const guarded: NodeJS.ProcessEnv = { ...ENV, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "" };
    expect(run(UNIT, ["assign", "refunds=payments", "--person-words", "the agent's guess"], home.dir, guarded).status).toBe(0);
    const row = readAuditShardEvents(home.dir).filter((entry) => entry.event === "UNITS_ASSIGNED").at(-1);
    expect(row?.block).not.toContain("Person Words");
  });
});

// A live run: the lead named the teams, the claims went to the home's remote,
// and the lead's plan (its record) stayed unpushed; a teammate's clone had no
// plan and its /aidlc said "Tell me what to build".
// Live runs: the lead had answered that no slice is built together first
// (their team's practices), and the who-builds-which question still named one,
// leaving that part off the teams' list.
describe("the slice built together first, at the question of who builds which part", () => {
  const stance = (dir: string) => field(readFileSync(join(dir, "aidlc", "spaces", "default", "intents", "fixture-8000000000000001", "aidlc-state.md"), "utf-8"), "Skeleton Stance");

  test("the lead's own answer on it is read first: settled off, the question names no part as built first", () => {
    const home = makeHome({ state: homeState().replace("- **Skeleton Stance**: off\n", "") });
    // Their team's practices answer it (Practices Discovery writes this section).
    const memory = join(home.dir, "aidlc", "spaces", "default", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "team.md"), "# Team rules\n\n## Walking Skeleton\n\nNo thin slice first: each Unit is built on its own.\n");
    chooseTeams(home.dir);
    const settle = next(home.dir);
    expect(settle.ask_type ?? null, JSON.stringify(settle)).not.toBe("unit-assignment");
    expect(settle.gate, JSON.stringify(settle)).toBe("unresolved");
    expect(run(ORCH, ["report", "--skeleton-stance", "off"], home.dir).status).toBe(0);
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-assignment");
    expect(String(ask.question)).not.toContain("first");
    expect(String(ask.question)).toContain("refunds");
  });

  test("said in plain words; the lead's words naming a team for it win, said once, nothing asked again", () => {
    const home = makeHome({ state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    chooseTeams(home.dir);
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-assignment");
    const first = /^(\S+) is built here first, by everyone together, so every team builds on one working slice; to have one team build it instead, name a team for it\. /.exec(String(ask.question))?.[1];
    expect(first, String(ask.question)).toBeString();
    expect(String(ask.question)).not.toContain("walking skeleton");
    const assigned = run(UNIT, ["assign", `${first}=payments`], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    expect(String(assigned.json?.notice)).toContain(`${first} goes to payments, as you said, so nothing is built together first for this work.`);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), first!)?.owner).toBe("payments");
    expect(stance(home.dir)).toBe("off");
    const after = next(home.dir);
    expect(after.ask_type ?? null, JSON.stringify(after)).not.toBe("unit-assignment");
  });
});

describe("the lead's plan goes to the teams the way main's share question asks it", () => {
  const isShare = (step: Record<string, unknown>) =>
    step.kind === "ask" && step.ask_type === "team-handover" && ((step.handovers ?? []) as string[]).includes("share");

  test("once the teams are named and their Units held: asked once, Share pushes main, Not now is kept", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(next(home.dir).ask_type).toBe("unit-assignment");
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    expect(String(ask.question)).toStartWith("The teams have their Units. Share the plan with them now?");
    const choices = ask.choices as Array<{ label: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Share them with the teams", "Not now"]);
    expect(String(choices[0].command)).toEndWith(" unit share --plan");
    // Not now: the step goes on and the question is not put again.
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
    expect(isShare(next(home.dir))).toBe(false);
    expect(isShare(next(home.dir))).toBe(false);
  });

  test("Share puts the plan on the home's remote, where a teammate's clone takes its Unit", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    next(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(git(home.remote, ["rev-parse", "main"])).toBe(git(home.dir, ["rev-parse", "HEAD"]));
    expect(isShare(next(home.dir))).toBe(false);
  });

  test("a Unit added after the plan was shared: the share is asked again, naming it, and Share takes the new plan", () => {
    // A live run: the lead shared the plan, then added a fourth Unit and gave
    // it to a team; the share was never asked again, so the remote kept the
    // first plan and the team could not take the Unit held for it.
    const home = makeHome();
    chooseTeams(home.dir);
    next(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web", "reporting=data"], home.dir).status).toBe(0);
    expect(isShare(next(home.dir))).toBe(true);
    share(home.dir);
    expect(isShare(next(home.dir))).toBe(false);
    const plan = join(seededRecordDir(home.dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(plan, DEPENDENCIES.replace("```\n", "  - name: reporting2-email\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
    expect(run(UNIT, ["assign", "reporting2-email=data"], home.dir).status).toBe(0);
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
    next(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams named"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    expect(isShare(next(home.dir))).toBe(false);
  });

  test("leave them all open: the question says the Units are open for any team, not that the teams have them", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    next(home.dir);
    expect(run(UNIT, ["assign", "--open"], home.dir).status).toBe(0);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    expect(String(ask.question)).toStartWith("The Units are open for any team to take. Share the plan with them now?");
  });

  test("an open Unit the home built itself is not open to the teams: with every open Unit started here, nothing is asked", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    next(home.dir);
    expect(run(UNIT, ["assign", "--open"], home.dir).status).toBe(0);
    for (const unit of ["refunds", "checkout-ui", "reporting"]) {
      appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: unit, "Run floor": "0" }, home.dir);
    }
    expect(isShare(next(home.dir))).toBe(false);
  });

  test("a home that cannot be reached: Share says so, keeps the commit, and the question is not put again each turn", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    next(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
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

describe("the Unit plan open again at the home", () => {
  test("the lead's assign says once that the Units go to their teams on the plan as it stands", () => {
    const home = makeHome({ state: homeState().replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: units-generation") });
    chooseTeams(home.dir);
    const assigned = run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    const notice = String(assigned.json?.notice);
    expect(notice).toContain("The Unit plan is open again here (");
    expect(notice).toContain("), so refunds and checkout-ui go to their teams on the plan as it stands, which may still change.");
  });
});

describe("the home walks only the Units no team holds", () => {
  test("with refunds and checkout-ui held, reporting waits on refunds, so the home shows the board", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    share(home.dir);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(String(step.narration)).toStartWith("Units of fixture:");
  });

  test("an open Unit with nothing to wait on is the home's to build", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments", "reporting=data"], home.dir).status).toBe(0);
    share(home.dir);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("checkout-ui");
  });

  test("at a home with nothing of its own to build now, a skip is never put as a skip of a team's Unit", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    share(home.dir);
    expect(next(home.dir).kind).toBe("print");
    // The person's skip of a step: not offered for the web team's checkout-ui.
    const asked = run(ORCH, ["next", "--skip", "functional-design"], home.dir);
    expect(asked.status, asked.out).toBe(0);
    expect(String(asked.json?.message), asked.out).not.toContain("checkout-ui");
    expect(String(asked.json?.message), asked.out).not.toContain("--unit refunds");
    // The agent's own skip report names no team's Unit as the step in progress.
    const reported = run(ORCH, [
      "report", "--stage", "functional-design", "--unit", "reporting", "--result", "skipped", "--reason", "no domain logic",
    ], home.dir);
    expect(reported.out).not.toContain("checkout-ui");
  });

  test("a skip of the step the home hands out is that Unit's: the walk the skip reads holds the same Units", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments", "reporting=data"], home.dir).status).toBe(0);
    share(home.dir);
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
  });
});

describe("a Unit the lead leaves open waits for a team", () => {
  // A live run: "U1 and U2 go to the billing team, U3 to the checkout team, and
  // leave U4 open for whoever has time". The home started U4 the moment the
  // assignment was done, asked her again, and could not put it back as open.
  test("it is never started here until the lead says so, offered once on the board; a Unit left unnamed is built here", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "lead-chat" };
    next(home.dir, chat);
    const words = "refunds goes to payments, leave checkout-ui open for whoever has time";
    const assigned = run(UNIT, ["assign", "refunds=payments", "--open", "checkout-ui", "--person-words", words], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    expect(String(assigned.json?.notice)).toStartWith("Refunds: payments. Open for any team: checkout-ui. Built here: reporting.");
    const row = readAuditShardEvents(home.dir).filter((entry) => entry.event === "UNITS_ASSIGNED").at(-1)!;
    expect(row.block).toContain("**Left Open**: checkout-ui");
    let step = next(home.dir, chat);
    if (step.ask_type === "team-handover") {
      appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
      step = next(home.dir, chat);
    }
    // Nothing is built here: checkout-ui waits for a team, reporting waits on refunds.
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(String(step.narration)).toContain("- checkout-ui, open: waiting for a team to take it");
    expect(readAuditShardEvents(home.dir).some((entry) => entry.event === "UNIT_STARTED")).toBe(false);
    const offers = (step.offers ?? []) as Array<{ question: string; choices: Array<{ label: string; command?: string; recommended?: boolean }> }>;
    const offer = offers.find((entry) => entry.question.includes("checkout-ui"));
    expect(offer?.question, JSON.stringify(step.offers)).toBe("checkout-ui is open for any team to take. Do you want me to build it here instead?");
    expect(offer!.choices.map((choice) => choice.label)).toEqual(["Leave checkout-ui open", "Build checkout-ui here"]);
    expect(offer!.choices[0].recommended).toBe(true);
    expect(String(offer!.choices[1].command)).toContain("aidlc-unit.ts assign --here checkout-ui");
    // Offered once in the chat; the board still shows it waiting.
    const again = next(home.dir, chat);
    expect(again.kind).toBe("print");
    expect(JSON.stringify(again.offers ?? [])).not.toContain("Build checkout-ui here");
    // The lead's word builds it here.
    const here = run(UNIT, ["assign", "--here", "checkout-ui", "--person-words", "build it here after all"], home.dir);
    expect(here.status, here.out).toBe(0);
    expect(String(here.json?.notice)).toBe("Checkout-ui is built here now, no longer open for the teams.");
    expect(next(home.dir, chat)).toMatchObject({ kind: "run-stage", unit: "checkout-ui" });
  });
});

describe("a Unit the lead's project started stays there", () => {
  // A live run: with the orders API built alone at the lead's project and its
  // approval open, the lead said "give the report Unit to the data team and
  // keep the API with us"; the agent ran assign u1-orders-api=us, the API was
  // held for a team called "us", and the lead's approval of it was refused.
  test("naming a team for it holds nothing for that team and says it stays; the other Units go to their teams", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "refunds", "Run floor": "0" }, home.dir);
    const assigned = run(UNIT, ["assign", "refunds=us", "checkout-ui=web", "--person-words", "checkout-ui to web, keep refunds with us"], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    expect(String(assigned.json?.notice)).toContain(
      "refunds was started here, at the lead's project, so it stays here with you. If the person asked for it to go to us " +
        "all the same, run this again with --started-here refunds and their words.",
    );
    const id8 = fixtureIntentId8(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toBeNull();
    expect(claimPayload(home.remote, id8, "checkout-ui")).toMatchObject({ status: "claimed", owner: "web" });
    expect(String(assigned.json?.notice)).not.toContain("Refunds: us.");
  });
});

// Live runs (x2783-s9, Claude Code at the lead's project): the board's note
// named no way to hold a Unit for a team again, nor to leave one the lead's
// project had started for them; and each assign asked the approval rhythm
// again after the lead had answered it.
describe("the lead's re-hold stays a hold", () => {
  const pushAll = (dir: string) => {
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "the lead's word"]);
    git(dir, ["push", "-q", "origin", "main"]);
  };

  test("the board's note names how to hold a Unit for a team and leave one open", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    const board = next(home.dir);
    expect(board.board_note, JSON.stringify(board)).toBeDefined();
    const note = String(board.board_note);
    expect(note).toContain(
      "When they ask to hold a Unit for a team, run `bun .claude/tools/aidlc-unit.ts assign <unit>=<team> " +
        "--request-file aidlc/.aidlc-request-text/unit-assign.txt`",
    );
    expect(note).toContain(
      "when they ask to leave a Unit open for any team, run `bun .claude/tools/aidlc-unit.ts assign --open <unit> " +
        "--request-file aidlc/.aidlc-request-text/unit-assign.txt`",
    );
    expect(note).toContain("--started-here <unit>");
    expect(note).not.toContain("hand-off");
  });

  // Live (this fold's run, Claude Code): a later assign said "Built here: reporting" for the Unit the lead had
  // left open, so the agent ran the whole assign again with words of its own added to the lead's.
  test("a Unit an earlier answer left open stays open in a later assign's line and record, never built here", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments", "--open", "reporting"], home.dir).status).toBe(0);
    const later = run(UNIT, ["assign", "checkout-ui=web"], home.dir);
    expect(later.status, later.out).toBe(0);
    expect(String(later.json?.notice)).toContain("Open for any team: reporting.");
    expect(String(later.json?.notice)).not.toContain("Built here");
    const row = readAuditShardEvents(home.dir).filter((entry) => entry.event === "UNITS_ASSIGNED").at(-1)!;
    expect(auditBlockField(row.block, "Left Open")).toBe("reporting");
  });

  test("the approval rhythm is asked until the lead answers it, either way, and never again after", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    const first = run(UNIT, ["assign", "refunds=payments"], home.dir);
    expect(String(first.json?.notice)).toContain("Each team will approve its Unit after every stage.");
    const offer = first.json?.offer as { choices: Array<{ label: string; command?: string; recommended?: boolean }> };
    expect(offer.choices[0]).toMatchObject({ label: "Keep approvals after every stage", recommended: true });
    expect(offer.choices[0].command).toEndWith("aidlc-state.ts set-unit-gate-rhythm per-stage");
    // Not answered yet: the next assign asks it again.
    const unanswered = run(UNIT, ["assign", "checkout-ui=web"], home.dir);
    expect(String(unanswered.json?.notice)).toContain("Each team will approve its Unit after every stage.");
    // The lead keeps it: never asked again.
    expect(run(STATE, ["set-unit-gate-rhythm", "per-stage"], home.dir).status).toBe(0);
    const later = run(UNIT, ["assign", "reporting=data"], home.dir);
    expect(later.status, later.out).toBe(0);
    expect(String(later.json?.notice)).not.toContain("approve");
    expect(later.json?.offer).toBeUndefined();
  });

  test("a Unit started at the lead's project is left open when the person asked for it all the same, with their words, and a team takes it", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "checkout-ui", "Run floor": "0" }, home.dir);
    const stays = run(UNIT, ["assign", "--open", "checkout-ui"], home.dir);
    expect(stays.status, stays.out).toBe(0);
    expect(String(stays.json?.notice)).toContain(
      "checkout-ui was started here, at the lead's project, so it stays here with you. If the person asked for it to be " +
        "left open all the same, run this again with --started-here checkout-ui and their words.",
    );
    const words = "Hold on, I didn't mean we build it here. I left it open for a team to grab. Leave it for them.";
    const open = run(UNIT, ["assign", "--open", "checkout-ui", "--started-here", "checkout-ui", "--person-words", words], home.dir);
    expect(open.status, open.out).toBe(0);
    expect(String(open.json?.notice)).toContain("Open for any team: checkout-ui.");
    expect(String(open.json?.notice)).toContain("What was built on checkout-ui here stays in this work's record.");
    const row = readAuditShardEvents(home.dir).filter((entry) => entry.event === "UNITS_ASSIGNED").at(-1)!;
    expect(auditBlockField(row.block, "Started Here")).toBe("checkout-ui");
    expect(auditBlockField(row.block, "Person Words")).toBe(words);
    pushAll(home.dir);
    // The lead's next step moves past it, and asks nothing about it.
    const step = next(home.dir);
    expect(step.unit, JSON.stringify(step)).not.toBe("checkout-ui");
    expect(String(step.narration)).toContain("- checkout-ui, open: waiting for a team to take it");
    // A teammate is offered it and takes it.
    const sam = cloneOf(home.remote, "sam");
    const ask = next(sam);
    expect(String(ask.question)).not.toContain("checkout-ui (at the home)");
    const took = run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD, "--team", "storefront"], sam);
    expect(took.status, took.out).toBe(0);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ owner: "storefront", taken_by: "sam" });
  });

  test("a Unit started at the lead's project goes to the team the person named all the same, and the walk there moves past it", () => {
    const home = makeHome();
    chooseTeams(home.dir);
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "checkout-ui", "Run floor": "0" }, home.dir);
    const held = run(UNIT, ["assign", "refunds=payments", "checkout-ui=web", "--started-here", "checkout-ui", "--person-words", "checkout-ui goes to web after all"], home.dir);
    expect(held.status, held.out).toBe(0);
    expect(String(held.json?.notice)).toContain("Checkout-ui: web.");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ status: "claimed", owner: "web" });
    const step = next(home.dir);
    expect(step.unit, JSON.stringify(step)).not.toBe("checkout-ui");
    expect(step.ask_type, JSON.stringify(step)).not.toBe("approval-gate");
  });
});
