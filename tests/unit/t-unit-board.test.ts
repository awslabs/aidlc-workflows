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
import { cpSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { clearEngineAskMark, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { teamHandoverMarkName } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { fixtureIntentId8, REPO_ROOT } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript, type StandInOptions } from "../harness/scope-run.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  ENV,
  git,
  GIT_ENV,
  homeState,
  makeHome,
  mergeOnHost,
  next,
  ORCH,
  planWordAt,
  recordHostOf,
  refundsTakenInClone,
  run,
  STATE,
  UNIT,
  takeIn,
  UTILITY,
  sharePlan,
  planFrom,
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
  // The plan goes to the teams by its own share; the push below is the lead's record.
  const shared = run(UNIT, ["share", "--plan"], dir);
  expect(shared.status, shared.out).toBe(0);
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

// A live run (Claude Code, Linux): the share question said every Unit was open
// while the thin slice was the lead's to build and the others waited on it.
describe("with a thin slice first, the plan is shared once the slice is approved", () => {
  const isShare = (d: Directive): boolean =>
    d.kind === "ask" && d.ask_type === "team-handover" && ((d.handovers ?? []) as string[]).includes("share");
  test("the lead builds the slice through its gates, then the share question comes, by pull request as AI-DLC's default says", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    // Teams chosen and nothing shared yet.
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    const end = leadsChat(home.dir, { until: isShare });
    expect(isShare(end), JSON.stringify(end).slice(0, 600)).toBe(true);
    expect(String(end.question)).toStartWith(
      "Do you want me to share the plan with the teams? I'd put it in checkout-api: the Units (refunds in checkout-api and billing, " +
        "checkout-ui in checkout-web, reporting in billing) and what each is built from",
    );
    expect(teamBoard(home.dir)).toContain("- checkout-ui, here: done");
  });
});

// The workspace is the code repository: the slice's code goes with the plan,
// so no team starts from a main without it.
describe("with a thin slice first on the workspace's own repository, the share carries the slice's code", () => {
  const isShare = (d: Directive): boolean =>
    d.kind === "ask" && d.ask_type === "team-handover" && ((d.handovers ?? []) as string[]).includes("share");
  const UNITS = "# Unit dependencies\n\n```yaml\nunits:\n" +
    "  - name: refunds\n    kind: service\n    depends_on: []\n" +
    "  - name: checkout-ui\n    kind: ui\n    depends_on: []\n" +
    "  - name: reporting\n    kind: service\n    depends_on: [refunds]\n```\n";
  test("the share question names the slice's code, the share commits it with the plan, and a team's take reads a main that has it", () => {
    const home = makeHome({ repos: {}, dependencies: UNITS, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    const end = leadsChat(home.dir, { until: isShare, codeRepo: () => undefined });
    expect(isShare(end), JSON.stringify(end).slice(0, 600)).toBe(true);
    expect(String(end.question)).toMatch(new RegExp(
      `^Do you want me to share the plan with the teams\\? I'd put it in ${basename(home.remote)}: the Units and what each is built from` +
        `(, with your [a-z' ]+)?; everyone who can read ${basename(home.remote)} can read it\\. I'd also commit checkout-ui's code, ` +
        "the \\d+ changed files here \\(new: src/checkout-ui\\.ts, test/checkout-ui\\.test\\.ts\\), and AI-DLC's record, using this " +
        "commit message, and push that on its own branch for a pull request\\. The other Units wait on checkout-ui until it is in main\\.\n\n",
    ));
    const choices = (end.choices ?? []) as Array<{ label: string; detail?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual([
      "Share the plan, checkout-ui by pull request (Recommended)", "Share the plan and push main", "Not now",
    ]);
    expect(choices[2].detail).toBe("Nothing is pushed; say when you want it shared.");
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const onMain = git(home.remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
    expect(onMain).toContain("src/checkout-ui.ts");
    expect(onMain).toContain("test/checkout-ui.test.ts");
    // The plan went first, as a ref of its own in that same repository, its skeleton not yet done.
    const plan = JSON.parse(git(home.remote, ["show", `refs/aidlc/plans/${fixtureIntentId8(home.dir)}:plan.json`]));
    expect(shared.json?.plan).toMatchObject({ commit: git(home.remote, ["rev-parse", `refs/aidlc/plans/${fixtureIntentId8(home.dir)}`]) });
    expect(typeof plan.skeleton).toBe("string");
    expect(plan.units.find((unit: { name: string }) => unit.name === plan.skeleton)?.word).toEqual({});
  });

  test("with the slice's code already committed, the share question names only AI-DLC's record to commit", () => {
    const home = makeHome({ repos: {}, dependencies: UNITS, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    const end = leadsChat(home.dir, { until: isShare, codeRepo: () => undefined });
    expect(isShare(end), JSON.stringify(end).slice(0, 600)).toBe(true);
    git(home.dir, ["add", "src", "test"]);
    git(home.dir, ["commit", "-q", "-m", "checkout-ui"]);
    clearEngineAskMark(home.dir, teamHandoverMarkName("share", "plan"));
    const again = next(home.dir);
    expect(String(again.question), JSON.stringify(again).slice(0, 600)).toContain("can read it. I'd also commit AI-DLC's record, using this " +
      "commit message, and push that on its own branch for a pull request. The other Units wait on checkout-ui until it is in main.\n\n");
    expect(String(again.question)).not.toContain("null");
  });
});

// On a branch of the lead's own, the plan still goes to its repository; the
// slice's code and the record are committed on that branch, which AI-DLC does
// not push.
describe("with a thin slice first, on a branch of the lead's own, the share says both things it does", () => {
  const isShare = (d: Directive): boolean =>
    d.kind === "ask" && d.ask_type === "team-handover" && ((d.handovers ?? []) as string[]).includes("share");
  const UNITS = "# Unit dependencies\n\n```yaml\nunits:\n" +
    "  - name: refunds\n    kind: service\n    depends_on: []\n" +
    "  - name: checkout-ui\n    kind: ui\n    depends_on: []\n" +
    "  - name: reporting\n    kind: service\n    depends_on: [refunds]\n```\n";
  test("the question and its choice name the plan's push and the commit here, and the result keeps the share's own line with the address", () => {
    const home = makeHome({ repos: {}, dependencies: UNITS, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams chosen"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    git(home.dir, ["checkout", "-q", "-b", "my-work"]);
    const main = git(home.remote, ["rev-parse", "main"]);
    const end = leadsChat(home.dir, { until: isShare, codeRepo: () => undefined });
    expect(isShare(end), JSON.stringify(end).slice(0, 600)).toBe(true);
    const repo = basename(home.remote);
    expect(String(end.question)).toStartWith(`This checkout is on my-work, not main. Do you want me to share the plan with the teams? I'd put it in ${repo}: `);
    expect(String(end.question)).toContain("and AI-DLC's record here on my-work, using this commit message; I would not push my-work. " +
      "The other Units wait on checkout-ui until it is in main.\n\n");
    const choices = (end.choices ?? []) as Array<{ label: string; detail?: string; command?: string }>;
    expect(choices[0].label).toBe("Share the plan, commit checkout-ui here");
    expect(choices[0].detail).toBe(`One push to ${repo} with your own git; checkout-ui's code and AI-DLC's record are committed on my-work, which is not pushed.`);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const said = String(shared.json?.notice);
    expect(said).toStartWith(`The plan is shared in ${repo}. AI-DLC sends no notice of it: the teams hear it from you. A team whose workspace has no ${repo} needs this address: `);
    expect(said).toEndWith("checkout-ui's code and AI-DLC's record are committed on my-work and not pushed: push my-work and get it merged your " +
      "usual way. The other Units wait on checkout-ui until it is in main.");
    expect(git(home.remote, ["rev-parse", "main"])).toBe(main);
    expect(git(home.remote, ["for-each-ref", "refs/heads/my-work"])).toBe("");
    expect(git(home.remote, ["for-each-ref", "--format=%(refname)", "refs/aidlc/plans"])).toBe(`refs/aidlc/plans/${fixtureIntentId8(home.dir)}`);
  });

  // The slice's code committed on the lead's branch already: the commit is AI-DLC's record alone, and the
  // other Units still wait on the slice while main does not have its code.
  function committedOnMyWork(): { home: ReturnType<typeof makeHome>; repo: string } {
    const home = makeHome({ repos: {}, dependencies: UNITS, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams chosen"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    git(home.dir, ["checkout", "-q", "-b", "my-work"]);
    const end = leadsChat(home.dir, { until: isShare, codeRepo: () => undefined });
    expect(isShare(end), JSON.stringify(end).slice(0, 600)).toBe(true);
    git(home.dir, ["add", "src", "test"]);
    git(home.dir, ["commit", "-q", "-m", "checkout-ui"]);
    clearEngineAskMark(home.dir, teamHandoverMarkName("plan-here", "my-work"));
    return { home, repo: basename(home.remote) };
  }
  const RECORD_ONLY = "I'd also commit AI-DLC's record here on my-work, using this commit message; I would not push my-work.";
  const COMMITTED = " AI-DLC's record is committed on my-work and not pushed: push my-work and get it merged your usual way.";
  const WAITS = " The other Units wait on checkout-ui until it is in main.";

  test("with the slice's code already committed on that branch, the question and the result name only AI-DLC's record, and the Units still wait", () => {
    const { home, repo } = committedOnMyWork();
    const again = next(home.dir);
    expect(String(again.question), JSON.stringify(again).slice(0, 600)).toContain(`everyone who can read ${repo} can read it. ${RECORD_ONLY}${WAITS}\n\n`);
    expect(String(again.question)).not.toContain("null");
    const choices = (again.choices ?? []) as Array<{ label: string; detail?: string }>;
    expect(choices[0].label).toBe("Share the plan, commit AI-DLC's record here");
    expect(choices[0].detail).toBe(`One push to ${repo} with your own git; AI-DLC's record is committed on my-work, which is not pushed.`);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(String(shared.json?.notice)).toEndWith(`${COMMITTED}${WAITS}`);
    expect(String(shared.json?.notice)).not.toContain("checkout-ui's code");
  });

  test("with the slice's code already in main, the question and the result name only AI-DLC's record, and nothing waits", () => {
    const { home, repo } = committedOnMyWork();
    git(home.dir, ["push", "-q", "origin", "HEAD:main"]);
    const again = next(home.dir);
    expect(String(again.question), JSON.stringify(again).slice(0, 600)).toContain(`everyone who can read ${repo} can read it. ${RECORD_ONLY}\n\n`);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(String(shared.json?.notice)).toEndWith(COMMITTED);
    expect(String(shared.json?.notice)).not.toContain("wait on");
  });
});

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
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
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
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    expect(teamBoard(home.dir)).toContain(
      "- refunds, payments space: built by alice, checkout-api merged, billing merged (2 of 2 merged), not recorded yet: " +
        "the next step here records it and opens reporting",
    );
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toEqual([]);
    expect(planWordAt(home, "refunds")).not.toMatchObject({ done: true });
    next(home.dir);
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    const after = teamBoard(home.dir);
    expect(after).toContain("- refunds, payments space: built by alice, done");
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
    const plan = sharePlan(home);
    // The lead's chat looks at the claims while it builds checkout-ui; alice then takes refunds.
    const building = next(home.dir, chat);
    expect(building.unit, JSON.stringify(building).slice(0, 400)).toBe("checkout-ui");
    const alice = cloneOf(home.remote, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    expect(takeIn("payments", ["refunds", ...planFrom(plan)], alice).status).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "carry on" }, home.dir);
    next(home.dir, chat);
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED")).toHaveLength(1);
    expect(planWordAt(plan, "refunds")).toMatchObject({ done: true });
  });
});

describe("going back to change the Unit plan while teams build Units", () => {
  test("names each Unit taken as it stands with whoever took it, never an open one, main's claim, land and publish words", () => {
    const { home } = refundsTakenInClone();
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
    const plan = sharePlan(home);
    // The lead's chat looks at the teams' claims once; alice takes refunds after that.
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "lead-chat" };
    next(home.dir, chat);
    const alice = cloneOf(home.remote, "alice");
    const took = takeIn("payments", ["refunds", ...planFrom(plan)], alice);
    expect(took.status, took.out).toBe(0);
    const step = next(home.dir, chat, ["--stage", "units-generation"]);
    const line = ((step.change_notices ?? []) as string[]).find((notice) => notice.startsWith("Still with teams:"));
    expect(line, JSON.stringify(step)).toContain("refunds (being built by alice in payments)");
  });

  test("a Unit whose team pushed it reads pushed and not merged yet, never as being built", () => {
    const { home, alice, record } = refundsTakenInClone();
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
    const taken = refundsTakenInClone();
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
    expect(String(step.narration)).toContain("- refunds, payments space: built by alice, done");
    expect(merged(home.dir)).toBe(1);
    expect(readAuditShardEvents(home.dir).some((row) => row.event === "UNIT_STARTED")).toBe(false);
  });

  // A live run: every look said the lead's project was on Functional Design
  // for the first Unit, while it built nothing.
  test("a look at where things stand names no stage as now while the lead's project waits on the Units", () => {
    const { home, alice } = refundsTakenInClone();
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(next(home.dir).kind).toBe("print");
    const status = run(UTILITY, ["status"], home.dir).out;
    expect(status).toContain("Current Stage:  none here: the Units left are taken or open to take (below)\n");
    expect(status).toContain("Status:         Waiting on the Units below\n");
    expect(status).not.toContain("Active Agent:");
    expect(status).not.toContain("Current Step:");
    expect(status).not.toContain("Next Stage:");
    expect(status).not.toMatch(/CONSTRUCTION .*Unit \d+ of \d+/);
    expect(status).toMatch(/- refunds, payments space: building since \d{1,2} [A-Z][a-z]{2}, taken by alice/);
    // The Units' own stages run in each taker's build, never in this record: out of the count here.
    expect(status).toMatch(/^Completion: {5}\d+\/\d+ stages here \(\d+%\); each Unit's own stages are on the board below$/m);
    // A taker's own build counts its stages as always.
    expect(run(UTILITY, ["status"], alice).out).toMatch(/^Completion: {5}\d+\/\d+ stages \(\d+%\)$/m);
    // Once the lead asks for a Unit here, its stage is said again.
    expect(run(UNIT, ["assign", "--here", "checkout-ui"], home.dir).status).toBe(0);
    expect(next(home.dir).unit).toBe("checkout-ui");
    expect(run(UTILITY, ["status"], home.dir).out).toContain("Current Stage:  Functional Design");
  });

  // A live run (the lead in a workspace of their own): status, the only step
  // of the look, named Functional Design with the Architect on it and a next
  // stage, because no board had run on the state since it last changed.
  test("before any board on this state, a look at where things stand still says the lead's project waits on the Units", () => {
    const { home } = refundsTakenInClone();
    git(home.dir, ["fetch", "-q", "origin"]);
    const waits = (): void => {
      const status = run(UTILITY, ["status"], home.dir).out;
      expect(status).toContain("Current Stage:  none here: the Units left are taken or open to take (below)\n");
      expect(status).toContain("Status:         Waiting on the Units below\n");
      expect(status).not.toContain("Active Agent:");
      expect(status).not.toContain("Next Stage:");
    };
    waits();
    // A board, then the state changes under it: the look still says it waits.
    expect(next(home.dir).kind).toBe("print");
    expect(run(STATE, ["set-unit-gate-rhythm", "unit-end"], home.dir).status).toBe(0);
    waits();
  });

  // A live run: the board's bare space names read as teams the lead never named.
  test("a take's row names its space as a space, and a take in a default space has no column", () => {
    const { home } = refundsTakenInClone();
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", ...planFrom(home)], bea).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const board = String(next(home.dir).narration);
    expect(board).toMatch(/- refunds, payments space: building since \d{1,2} [A-Z][a-z]{2}, taken by alice/);
    expect(board).toMatch(/- checkout-ui: building since \d{1,2} [A-Z][a-z]{2}, taken by bea/);
  });

  // A take gone quiet is plain to see: a take's row says the day it was taken,
  // the author date of the take's own commit on its record.
  test("a take not pushed yet: its row says the day it was taken, and a proposal after it does not move the day", () => {
    const { home, alice, record } = refundsTakenInClone();
    writeFileSync(join(record, "inception", "requirements-analysis", "requirements.md"), "# Requirements\n\nFR1 refunds, partial amounts too.\n");
    const later = "2030-01-05T10:00:00+00:00";
    const sent = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds need partial amounts"], alice,
      { ...ENV, GIT_AUTHOR_DATE: later, GIT_COMMITTER_DATE: later });
    expect(sent.status, sent.out).toBe(0);
    const [taken, proposed] = git(recordHostOf(home, "refunds"), ["log", "--reverse", "--format=%aI", `refs/aidlc/claims/${home.id8}/refunds`]).split("\n");
    // git writes UTC as "+00:00" or "Z" by platform: the time is what is compared.
    expect(Date.parse(proposed)).toBe(Date.parse(later));
    const at = /^\d{4}-(\d{2})-(\d{2})T/.exec(taken)!;
    const day = `${Number(at[2])} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(at[1]) - 1]}`;
    git(home.dir, ["fetch", "-q", "origin"]);
    // The lead's board (the step itself asks about the proposal first).
    const board = teamBoard(home.dir);
    expect(board, board).toContain(`- refunds, payments space: building since ${day}, taken by alice`);
    expect(board).not.toContain("5 Jan");
  });

  // Main's own team flow (one repository, claim branches) keeps its own board as it was.
  test("main's own team flow: its board for a claimed Unit is as it was, with no day", () => {
    const home = makeHome({ repos: {}, state: homeState(["- **Unit Ownership**: team"]) });
    const bob = cloneOf(home.remote, "bob");
    const claimed = run(UNIT, ["claim", "refunds", "--team", "payments"], bob);
    expect(claimed.status, claimed.out).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const board = teamBoard(home.dir);
    expect(board).toContain("**Claimed:** refunds (payments). **Claimable:** checkout-ui. **Waiting:** reporting waits on refunds.");
    expect(board).not.toContain(" since ");
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
