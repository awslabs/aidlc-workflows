// covers: subcommand:aidlc-orchestrate:team-board, function:unitBoardRows, function:teamHomeBoardText, function:unitProgressStanding, function:unitTakeLook, function:checkTeamResults, function:claimsOpenAtPlanChange
//
// The board at the lead's project says only what the record says (#2410, the
// board). A Unit the lead's project builds reads where it stands in the Unit
// Progress the step derived: done once it is through its gate, waiting for the
// lead's approval while its gate is open (a Unit built before teams were
// chosen too), and waiting only on a Unit that is not done; a Unit nobody took
// reads open. A teammate's take offer never names a Unit done on its claim as
// being built.
// A look at the board (`team-board`) records nothing: a merge it sees that the
// record does not have yet says so, and the next step records it. Going back
// to change the Unit plan names the Units still with teams as they stand.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, REPO_ROOT } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript, type StandInOptions } from "../harness/scope-run.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  ENV,
  git,
  GIT_ENV,
  HOME_RECORD,
  makeHome,
  mergeOnHost,
  next,
  ORCH,
  refundsTaken,
  run,
  STATE,
  UNIT,
  takeIn,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

function teamBoard(dir: string): string {
  const looked = run(ORCH, ["team-board"], dir);
  expect(looked.status, looked.out).toBe(0);
  return looked.out;
}

// The lead's project with its two code repos; with teams chosen, the lead
// builds refunds and reporting (which waits on refunds) here, and checkout-ui
// is open for any team to take.
function leadKeepsTwo(teamsFirst = true) {
  const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
  const home = makeHome({ repos: hosts });
  if (teamsFirst) teamsChosen(home.dir);
  return { hosts, home };
}

function teamsChosen(dir: string): void {
  const teams = run(STATE, ["set-unit-ownership", "team"], dir);
  expect(teams.status, teams.out).toBe(0);
  const here = run(UNIT, ["assign", "--here", "refunds,reporting"], dir);
  expect(here.status, here.out).toBe(0);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "teams chosen"]);
  git(dir, ["push", "-q", "origin", "main"]);
}

// The lead's chat at their project, driven by the agent stand-in until `until` picks a step.
function leadsChat(dir: string, options: StandInOptions): Directive {
  cpSync(join(REPO_ROOT, "dist", "claude"), dir, { recursive: true, force: false, errorOnExist: false });
  const host = hostFor("claude", dir, GIT_ENV);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: ["refunds", "checkout-ui", "reporting"],
    codeRepo: (unit) => [{ repo: unit === "refunds" ? "checkout-api" : "billing" }],
    ...options,
  });
  host.sessionStart("startup");
  person.say("/aidlc");
  return agent.drive(agent.next());
}

const isBoard = (d: Directive): boolean => d.kind === "print" && d.board_note !== undefined;

describe("a Unit the lead's project builds reads where its Unit Progress has it", () => {
  test("built through their gates, refunds and reporting read done, and reporting never waits on refunds", () => {
    const { home } = leadKeepsTwo();
    const end = leadsChat(home.dir, { until: isBoard });
    expect(isBoard(end), JSON.stringify(end)).toBe(true);
    expect(String(end.narration)).toBe([
      "Units of fixture:",
      "- refunds, here: done",
      "- checkout-ui, open: waiting for a team to take it",
      "- reporting, here: done",
    ].join("\n"));
    expect(teamBoard(home.dir)).toContain("- reporting, here: done");
  });

  test("while refunds's gate is open, the board says it waits for the lead's approval, and reporting waits on it", () => {
    const { home } = leadKeepsTwo();
    const gate = leadsChat(home.dir, { until: (d) => d.unit_gate !== undefined && d.unit === "refunds" });
    expect(gate.unit, JSON.stringify(gate)).toBe("refunds");
    const board = teamBoard(home.dir);
    // Approved stage by stage here, so its first stage waits for the lead.
    expect(board).toContain("- refunds, here: waiting for your approval at Functional Design");
    expect(board).toContain("- reporting, here: waits on refunds");
  });

  test("a Unit built before teams were chosen, its gate still open, never reads done", () => {
    const { home } = leadKeepsTwo(false);
    // The solo walk's first Unit, built through its last stage, its checkpoint not yet asked.
    const ask = leadsChat(home.dir, { until: (d) => d.construction_checkpoint !== undefined });
    const built = String((ask.construction_checkpoint as { unit?: string }).unit);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const board = teamBoard(home.dir);
    // Asked once for the whole Unit, as its checkpoint was, though teams approve stage by stage here.
    expect(board).toContain(`- ${built}, here: built, waiting for your approval`);
    expect(board).not.toContain(`- ${built}, here: done`);
  });
});

describe("a teammate's take offer", () => {
  test("a fresh clone never names a Unit done on its claim as being built, and what waited on it is ready", () => {
    // Nobody took reporting, so it is open for a team to take once refunds is done.
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    // The lead's state as last pushed, before this record of the merge.
    const bob = cloneOf(home.remote, "bob");
    const offer = next(bob);
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
    expect(String(offer.question)).not.toContain("Being built: refunds");
    expect(String(offer.question)).toContain("Ready to take: checkout-ui (open; likely checkout-web), reporting (open; likely billing).");
  });
});

describe("a look at the board records nothing, and says so", () => {
  test("a merge team-board sees is not recorded yet, the next step records it, and the board then reads done", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    expect(teamBoard(home.dir)).toContain(
      "- refunds, payments: checkout-api merged, billing merged (2 of 2 merged), not recorded yet: " +
        "the next step here records it and opens reporting",
    );
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toEqual([]);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).not.toMatchObject({ done: true });
    next(home.dir);
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    const after = teamBoard(home.dir);
    expect(after).toContain("- refunds, payments: done");
    expect(after).not.toContain("not recorded yet");
  });

  test("with no look at the board, a team's merge is recorded at the lead's next message while the lead's project builds its own Unit", () => {
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "lead-chat" };
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "--here", "checkout-ui"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams chosen"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    // The lead's chat looks at the claims while it builds checkout-ui; alice then takes refunds.
    const building = next(home.dir, chat);
    expect(building.unit, JSON.stringify(building).slice(0, 400)).toBe("checkout-ui");
    const alice = cloneOf(home.remote, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    expect(takeIn("payments", ["refunds", "--home", HOME_RECORD], alice).status).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "carry on" }, home.dir);
    next(home.dir, chat);
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });
});

describe("going back to change the Unit plan while teams build Units", () => {
  test("names each Unit taken as it stands with whoever took it, never an open one, main's claim, land and publish words", () => {
    const { home } = refundsTaken();
    git(home.dir, ["fetch", "-q", "origin"]);
    const step = next(home.dir, undefined, ["--stage", "units-generation"]);
    const notices = (step.change_notices ?? []) as string[];
    expect(notices, JSON.stringify(step)).toContain(
      "Still with teams: refunds (being built by alice in payments). A Unit a team has started keeps the plan it took.",
    );
    // checkout-ui and reporting, which nobody took, are not with a team.
    expect(notices.find((notice) => notice.startsWith("Still with teams:"))).not.toMatch(/checkout-ui|reporting/);
    expect(JSON.stringify(step)).not.toContain("Still claimed");
    expect(JSON.stringify(step)).not.toContain("publishes again");
  });

  test("a Unit taken after the lead's chat last looked reads as taken: the line looks at the claims as they are when it is said", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams chosen"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    // The lead's chat looks at the teams' claims once; alice takes refunds after that.
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "lead-chat" };
    next(home.dir, chat);
    const alice = cloneOf(home.remote, "alice");
    const took = takeIn("payments", ["refunds", "--home", HOME_RECORD], alice);
    expect(took.status, took.out).toBe(0);
    const step = next(home.dir, chat, ["--stage", "units-generation"]);
    const line = ((step.change_notices ?? []) as string[]).find((notice) => notice.startsWith("Still with teams:"));
    expect(line, JSON.stringify(step)).toContain("refunds (being built by alice in payments)");
  });

  test("a Unit whose team pushed it reads pushed and not merged yet, never as being built", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const step = next(home.dir, undefined, ["--stage", "units-generation"]);
    const line = ((step.change_notices ?? []) as string[]).find((notice) => notice.startsWith("Still with teams:"));
    expect(line, JSON.stringify(step)).toContain("refunds (pushed by alice in payments, not merged yet)");
    expect(line).not.toContain("being built");
  });
});

// A live run (the lead of work teams build, every Unit left open): recording
// a team's merge was tied to carrying on, which would have carried on the
// Units the lead left open. Nothing is built at the lead's project until the
// lead says so.
describe("the lead's project builds nothing it was not asked to", () => {
  function refundsMerged() {
    const taken = refundsTaken();
    codeGenerated(taken.alice, taken.record);
    expect(run(UNIT, ["push"], taken.alice).status).toBe(0);
    mergeOnHost(taken.hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(taken.hosts.billing, "refunds", "squash");
    git(taken.home.dir, ["fetch", "-q", "origin"]);
    return taken;
  }
  const merged = (dir: string) => readAuditShardEvents(dir).filter((row) => row.event === "UNIT_MERGED").length;

  test("with every other Unit open, the lead's next records a team's merge and is the board, with nothing started", () => {
    const { home } = refundsMerged();
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("print");
    expect(String(step.narration)).toContain("- refunds, payments: done");
    expect(merged(home.dir)).toBe(1);
    expect(readAuditShardEvents(home.dir).some((row) => row.event === "UNIT_STARTED")).toBe(false);
  });

  // A live run: every look said the lead's project was on Functional Design
  // for the first Unit, while it built nothing.
  test("a look at where things stand names no stage as now while the lead's project waits on the Units", () => {
    const { home } = refundsTaken();
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(next(home.dir).kind).toBe("print");
    const status = run(UTILITY, ["status"], home.dir).out;
    expect(status).toContain("Current Stage:  none here: the Units left are taken or open to take (below)\n");
    expect(status).toContain("Status:         Waiting on the Units below\n");
    expect(status).not.toContain("Active Agent:");
    expect(status).not.toContain("Current Step:");
    expect(status).not.toContain("Next Stage:");
    expect(status).not.toMatch(/CONSTRUCTION .*Unit \d+ of \d+/);
    expect(status).toContain("- refunds, payments: building, taken by alice");
    // Once the lead asks for a Unit here, its stage is said again.
    expect(run(UNIT, ["assign", "--here", "checkout-ui"], home.dir).status).toBe(0);
    expect(next(home.dir).unit).toBe("checkout-ui");
    expect(run(UTILITY, ["status"], home.dir).out).toContain("Current Stage:  Functional Design");
  });

  test("the lead's plain words to record a team's merge reach the step that records it, and nothing is started", () => {
    const { home } = refundsMerged();
    const words = next(home.dir, ENV, ["The refunds Unit is merged. I want that recorded now, nothing else."]);
    expect(String(words.message), JSON.stringify(words).slice(0, 400)).toMatch(/run `[^`]*orchestrate\.ts next` with nothing after it/);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("print");
    expect(merged(home.dir)).toBe(1);
    expect(readAuditShardEvents(home.dir).some((row) => row.event === "UNIT_STARTED")).toBe(false);
  });
});
