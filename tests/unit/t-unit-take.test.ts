// covers: subcommand:aidlc-unit:take, audit:UNIT_TAKEN_IN, function:unitBuildOf, function:onlyTheBuildsUnit, function:isHomesCopiedWork, function:recordKeptEntries, function:findUnitBuild, function:leadsPlanNotHere, function:ignoreOwnWorkingFiles, function:dropOwnWorkingFilesIgnore
//
// Taking a Unit (#2410, item 4). A team member opening a workspace with no work
// of their own is offered the home's Units their team can take, from what the
// workspace already has. Taking one holds it at the home (the claim's
// compare-and-swap, by the home's address when the workspace is the team's own)
// and starts the Unit's build: a piece of work of its own in the team's space,
// one Unit, from a copy of what the home approved, with the home's Inception
// shown as done and the team approving its own stages. Its registry row stays
// in its own folder, so two builds share no file. A held or taken Unit is not
// taken again; a build here is carried on; the home's work that git copied
// into a team's workspace is never offered to carry on. Before the lead's plan
// reaches a clone, a bare /aidlc there says so, the teammate's words go on with
// the one risk said, and no chat writes AI-DLC's root files there: its working
// files there ignore themselves from inside aidlc/ until its root part is in.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { asLeadsOwnCheckout } from "../harness/team-unit-merge.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents, readIntentRegistry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { shellSingleQuote } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { leadsPlanNotHere } from "../../dist/claude/.claude/tools/aidlc-unit-holders.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { resolvedRuleBundle } from "../../dist/claude/.claude/tools/aidlc-steering.ts";
import { learningsCorrectionChoices, offersLearningsCorrectionChoices } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { AIDLC_SRC, fixtureIntentId8, REPO_ROOT, seedAidlcMemory } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  ENV,
  finishBuild,
  GIT_ENV,
  git,
  homeState,
  type Home,
  hook,
  makeHome,
  makePlanHome,
  makePlanHomeWithRemote,
  mergeOnHost,
  next,
  offerText,
  ORCH,
  personsChat,
  type PlanHome,
  planFrom,
  planRefOf,
  planWordAt,
  recordAt,
  recordHostOf,
  refundsTaken,
  refundsTakenInClone,
  sharePlan,
  DEPENDENCIES,
  run,
  STATE,
  tempDir,
  UNIT,
  UTILITY,
  takeIn,
  inSpace,
  teamWorkspace as ownWorkspace,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const HOME = "fixture-8000000000000001";
const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();

// The home after the lead chose teams, every Unit open, pushed for the teams,
// its plan shared in app. take() takes from that plan in the case that made it.
let sharedPlan: PlanHome | null = null;
afterEach(() => {
  sharedPlan = null;
});
function homeWithTeams(dependencies?: string) {
  const home = makePlanHomeWithRemote({ repos: { app: codeHost("app") }, ...(dependencies === undefined ? {} : { dependencies }) });
  sharedPlan = home;
  return home;
}
// refunds taken from the shared plan (refundsTaken); take() takes from the same plan.
function refundsTakenHere(...args: Parameters<typeof refundsTaken>): ReturnType<typeof refundsTaken> {
  const taken = refundsTaken(...args);
  sharedPlan = taken.home;
  return taken;
}
// The take command the Units offer prints for a Unit of a shared plan.
const takeCommand = (home: PlanHome, unit: string): string =>
  `take ${unit} --plan ${home.id8} --from ${shellSingleQuote(Object.values(home.hosts)[0])}`;
// The lead shares the plan of a home whose teams this case chose; take() takes from it.
function planShared(home: Home): PlanHome & Home {
  const plan = sharePlan(home);
  sharedPlan = plan;
  return plan;
}

// A team's own workspace repo made from the home's: the home's record comes
// with it, its origin is the team's host. With `hostTakesNoPush` the clone
// has nowhere else to send a claim the lead's project refuses.
function teamWorkspace(homeRemote: string, label: string, hostTakesNoPush = false): string {
  const seed = cloneOf(homeRemote, `${label}-seed`);
  const host = tempDir(`${label}-host`);
  git(host, ["init", "-q", "--bare", "-b", "main"]);
  git(seed, ["remote", "set-url", "origin", host]);
  git(seed, ["push", "-q", "origin", "main"]);
  const dir = cloneOf(host, label);
  if (hostTakesNoPush) refusePushes(host);
  return dir;
}

function take(dir: string, unit: string, extra: string[] = []) {
  const from = sharedPlan === null ? ["--home", HOME] : ["--plan", sharedPlan.id8, "--from", Object.values(sharedPlan.hosts)[0]];
  return run(UNIT, ["take", unit, ...from, ...extra], dir);
}

// The take question's own choice to carry the person's build on where it is.
function carryOnChoice(step: Record<string, unknown>, unit: string): { label: string; detail?: string } | undefined {
  return (step.choices as Array<{ label: string; detail?: string }> | undefined)?.find((choice) => choice.label === `Carry on ${unit}`);
}

// A take from the space the person works in, made and switched to first.
function takeFrom(space: string, dir: string, unit: string, extra: string[] = []) {
  inSpace(dir, space);
  return take(dir, unit, extra);
}

function buildDir(dir: string, space: string, unit: string): string {
  const intents = join(dir, "aidlc", "spaces", space, "intents");
  const record = readdirSync(intents).find((name) => name.endsWith(`-${unit}`));
  expect(record, readdirSync(intents).join(", ")).toBeDefined();
  return join(intents, record!);
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

describe("a team member's clone of the home's workspace", () => {
  test("is offered the Units to take, what waits, and the home's own work to carry on as its home", () => {
    const home = homeWithTeams();
    const ask = next(cloneOf(home.remote, "alice"));
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(ask.response_route).toBe("command");
    expect(offerText(ask.question)).toBe(
      "fixture is shared in app. Ready to take: refunds (open; likely checkout-api, billing), " +
        "checkout-ui (open; likely checkout-web). Waiting: reporting (on refunds). Taking a Unit starts it as your " +
        "team's own piece of work here, from what the lead approved.",
    );
    const choices = ask.choices as Array<{ label: string; command: string; detail?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual([
      "Start refunds",
      "Start checkout-ui",
      "Carry on fixture here, as the lead",
    ]);
    expect(choices[0].detail).toBe("Open.");
    expect(choices[0].command).toEndWith(`aidlc-unit.ts ${takeCommand(home, "refunds")}`);
    expect(choices[2].command).toEndWith(`next --pick ${HOME}`);
  });

  // A live run: every teammate's first screen offered to carry the lead's whole work on.
  test("only the checkout that made the plan is offered to carry the work on as its home, never a clone under the lead's git name", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const labels = (dir: string) => ((next(dir).choices ?? []) as Array<{ label: string }>).map((choice) => choice.label);
    // A clone made under the lead's own git name is a clone all the same.
    expect(labels(cloneOf(home.remote, "lead"))).toEqual(["Start refunds", "Start checkout-ui"]);
    // A copy of the lead's checkout keeps its clone id, so the plan's rows are its own.
    const copy = cloneOf(home.remote, "lead-copy");
    cpSync(join(home.dir, "aidlc", ".aidlc-engine", "clone-id"), join(copy, "aidlc", ".aidlc-engine", "clone-id"));
    expect(labels(copy)).toContain("Carry on fixture here, as the lead");
  });

  // A live run on opencode: its skill enters a bare /aidlc with `next --resume`,
  // which picked up the home's work (the only open work) and showed the lead's
  // board; the take offer never came, and the agent released a team's Unit.
  test("a bare --resume is offered the same Units to take, never the home's work picked up", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const ask = next(alice, ENV, ["--resume"]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(JSON.stringify(ask)).not.toContain("Picked up");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toEqual([
      "Start refunds",
      "Start checkout-ui",
      "Carry on fixture here, as the lead",
    ]);
  });

  // Live runs on Codex, Kiro CLI and Copilot CLI: a teammate's first line with
  // words ("what is ours to build?") got the pick of the work itself, which
  // selected it in their clone and showed them the lead's board.
  // Live runs on Codex: payments' clone selected the lead's work (a pick, an
  // intent switch) and was asked one of the lead's own questions.
  test("in a clone that did not make the plan, the lead's work selected gets the board and the Units offer, never the lead's questions", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const alice = cloneOf(home.remote, "alice");
    expect(run(UTILITY, ["intent", "switch", HOME], alice).status).toBe(0);
    const step = next(alice, ENV);
    const said = JSON.stringify(step);
    expect(said, said.slice(0, 600)).toContain("Taking a Unit starts it as your team's own piece of work here");
    expect(said).not.toContain("Who builds which Unit");
    // Again in the same chat: still the Units offer, never the lead's walk.
    expect(JSON.stringify(next(alice, ENV))).not.toContain("Who builds which Unit");
    // Their words there are read against the Units offer, never sent on as the lead's work.
    const words = next(alice, ENV, ["we are the payments team and want to take refunds, our Unit"]);
    expect(String(words.message), JSON.stringify(words).slice(0, 500)).toContain(takeCommand(plan, "refunds"));
    expect(String(words.message)).not.toContain("--team");
    // A Unit not ready to take is said where it stands, never sent on as new work.
    expect(String(words.message)).toContain("tell them in one line where it stands");
    // Nor do the lead's own commands ride a step in this clone.
    expect(String(words.board_note ?? "")).not.toContain("assign <unit>=<team>");
  });

  // A typed --claim of a Unit of work teams take, in a teammate's clone with
  // the lead's work selected (a pick, an intent switch): the take the Units
  // offer runs, never the line that sends them to their own clone.
  test("a typed --claim of a Unit in a teammate's clone is the take of that Unit, its line at the next step", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const ria = cloneOf(home.remote, "ria");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "ria-claim-chat" };
    expect(run(UTILITY, ["intent", "switch", HOME], ria, chat).status).toBe(0);
    const step = next(ria, chat, ["--claim", "refunds", "--team", "Payments"]);
    const teamFile = /--claim refunds --request-file (\S+?)`/.exec(String(step.message))?.[1];
    expect(teamFile, JSON.stringify(step).slice(0, 600)).toBeDefined();
    const claimed = run(UTILITY, ["claim", "refunds", "--request-file", teamFile!], ria, chat);
    expect(claimed.status, claimed.out).toBe(0);
    expect(claimed.out).not.toContain("Nothing is claimed here");
    expect(claimed.json).toMatchObject({ taken: true, unit: "refunds", space: "default" });
    // A team named with it makes and picks no space; the build follows the lead's plan's rhythm.
    expect(existsSync(join(ria, "aidlc", "spaces", "Payments"))).toBe(false);
    expect(existsSync(join(ria, ...teamFile!.split("/")))).toBe(false);
    // The rhythm is the build's own (its state below); the record holds the builder's side only.
    expect(recordAt(plan, "refunds")?.json).toMatchObject({ owner: "default", taken_by: "ria" });
    const state = readFileSync(join(buildDir(ria, "default", "refunds"), "aidlc-state.md"), "utf-8");
    expect(field(state, "Construction Checkpoints")).toBe("disabled");
    // The take's own line rides the build's next step, as a take from the Units offer does.
    const after = next(ria, chat);
    expect(JSON.stringify(after.change_notices ?? []), JSON.stringify(after).slice(0, 600)).toContain("refunds is yours.");
  });

  // --rhythm picks how the build's gates go: the build the take starts keeps the pick.
  test("a typed --claim with --rhythm in a teammate's clone starts the build in that rhythm", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const ria = cloneOf(home.remote, "ria");
    expect(run(UTILITY, ["intent", "switch", HOME], ria).status).toBe(0);
    const claimed = run(UTILITY, ["claim", "refunds", "--rhythm", "unit-end"], ria);
    expect(claimed.status, claimed.out).toBe(0);
    expect(claimed.json).toMatchObject({ taken: true, unit: "refunds" });
    expect(recordAt(plan, "refunds")?.json).toMatchObject({ taken_by: "ria" });
    const state = readFileSync(join(buildDir(ria, "default", "refunds"), "aidlc-state.md"), "utf-8");
    expect(field(state, "Construction Iteration")).toBe("unit-major");
    expect(field(state, "Construction Checkpoints")).toBe("enabled");
  });

  test("a typed --claim at the lead's own checkout of work teams take still says the teams take it in their own clones", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const claimed = run(UTILITY, ["claim", "refunds"], home.dir);
    expect(claimed.status).not.toBe(0);
    expect(claimed.out).toContain("Nothing is claimed here: this work's teams each take their Unit in their own clone");
    expect(recordAt(plan, "refunds")).toBeNull();
  });

  test("the lead on a second machine: their own word that they lead this work, recorded, puts the lead's questions there again", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const laptop = cloneOf(home.remote, "lead");
    expect(run(UTILITY, ["intent", "switch", HOME], laptop).status).toBe(0);
    const step = next(laptop, ENV);
    expect(String(step.board_note), JSON.stringify(step).slice(0, 600)).toContain("lead-here");
    const lifted = run(UNIT, ["lead-here", "--person-words", "I lead this work, carry it on here on my laptop"], laptop);
    expect(lifted.status, lifted.out).toBe(0);
    const row = readAuditShardEvents(laptop).findLast((entry) => entry.event === "LEAD_HERE_SET");
    expect(row, "the lift is on the record").toBeDefined();
    const after = next(laptop, ENV);
    expect(JSON.stringify(after), JSON.stringify(after).slice(0, 600)).not.toContain("Taking a Unit starts it as your team's own piece of work here");
  });

  // The GitHub live test's rule for the lead's words: the one message the
  // request came in, never the chat before it.
  test("the lead's word that they lead this work here keeps only the message it came in", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const laptop = cloneOf(home.remote, "lead");
    expect(run(UTILITY, ["intent", "switch", HOME], laptop).status).toBe(0);
    const session = "t-unit-take-lead-here-one";
    const request = "I lead this work, carry it on here on my laptop";
    for (const prompt of ["where do things stand?", "Keep approvals after every stage", request]) {
      expect(hook(laptop, personsChat(session), { hook_event_name: "UserPromptSubmit", session_id: session, prompt }).status).toBe(0);
    }
    const lifted = run(UNIT, ["lead-here", "--person-words", request], laptop, personsChat(session));
    expect(lifted.status, lifted.out).toBe(0);
    const row = readAuditShardEvents(laptop).findLast((entry) => entry.event === "LEAD_HERE_SET");
    expect(auditBlockField(row?.block ?? "", "Person Words")).toBe(request);
    expect(auditBlockField(row?.block ?? "", "Message Ids")).toBeNull();
  });

  // A live run on Codex: after the Units offer, a teammate's words about their
  // own Unit got the pick of the lead's whole work, which selected it in their
  // clone and put the lead's own questions to them.
  test("a teammate's words after the Units offer are read against its choices, never the pick of the lead's work", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const alice = cloneOf(home.remote, "alice");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    expect(next(alice, chat, ["hi, what is ours to build?"]).ask_type).toBe("unit-take");
    const words = next(alice, chat, ["refunds is ours, we want to start it now"]);
    expect(words.kind, JSON.stringify(words).slice(0, 600)).toBe("print");
    expect(String(words.message)).not.toContain("--pick");
    expect(String(words.message)).toContain(takeCommand(plan, "refunds"));
    expect(String(words.message)).not.toContain("--team");
    // The lead's work is switched to only on their own word that they lead it, which a team's lead's is not.
    expect(String(words.message)).toContain("If they say they lead this work, whether or not they ask to carry it on here (leading a team or a " +
      "Unit of it is not that), run");
  });

  // A live run on Codex (the second teammate): "I'm carrying it on" after the
  // Units offer found nothing to run; the step said to run nothing for a Unit
  // being built.
  test("a teammate's words asking to carry on a build listed as being built get its command; done or waiting ones none", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    commitAll(alice, "payments: refunds taken");
    git(alice, ["pull", "-q", "--no-rebase", "--no-edit"]);
    git(alice, ["push", "-q", "origin", "HEAD:main"]);
    const bea = cloneOf(home.remote, "bea");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "bea-chat" };
    const offer = next(bea, chat, ["hi, what is there to build?"]);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 600)).toBe("unit-take");
    expect(String(offer.question)).toContain("refunds (being built by alice in payments, on another computer)");
    const command = `bun .claude/tools/aidlc-unit.ts ${takeCommand(plan, "refunds")}`;
    expect(String(offer.question_note)).toContain(
      `When their words ask to carry on a build the question lists as being built, run its command: refunds: \`${command}\`.`,
    );
    const words = next(bea, chat, ["alice started refunds, I'm carrying it on"]);
    expect(words.kind, JSON.stringify(words).slice(0, 600)).toBe("print");
    const message = String(words.message);
    expect(message).toContain(`run its command: refunds: \`${command}\``);
    expect(message).not.toContain("being built, waiting, or done");
    // Only the build listed as being built gets one: reporting waits on refunds.
    expect(message).not.toContain("reporting: `");
    // The command carries it on, said once whose it is, and the next step is its build, asked nothing again.
    const took = run(UNIT, ["take", "refunds", "--plan", plan.id8, "--from", Object.values(plan.hosts)[0]], bea, chat);
    expect(took.status, took.out).toBe(0);
    expect(took.json?.resumed, took.out).toBe(true);
    const after = next(bea, chat);
    expect(after.ask_type, JSON.stringify(after).slice(0, 600)).toBeUndefined();
    expect(JSON.stringify(after)).toContain("Carrying on refunds, alice's build in the payments space.");
  });

  test("a teammate's first words are answered with the Units to take, never the pick of the work itself", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    const ask = next(alice, chat, ["hi, I am on the payments team. what is ours to build?"]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toEqual([
      "Start refunds",
      "Start checkout-ui",
      "Carry on fixture here, as the lead",
    ]);
    // Asked once in the chat: words after it are read as words, never the same offer again.
    const again = next(alice, chat, ["something else entirely"]);
    expect(again.ask_type ?? null, JSON.stringify(again)).not.toBe("unit-take");
  });

  // Live runs on Claude Code and Codex: a teammate whose finished build was
  // still selected asked to start the next Unit the lead held for them, and
  // was offered a new piece of work that would run Inception again.
  test("words from a finished build's chat about another Unit get the Units to take, never new work", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    const record = buildDir(alice, "payments", "refunds");
    finishBuild(record);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    const ask = next(alice, chat, ["The lead also gave us checkout-ui. Can I start that one now?"]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 500)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start checkout-ui");
    const again = next(alice, chat, ["something else entirely"]);
    expect(again.ask_type ?? null, JSON.stringify(again).slice(0, 300)).not.toBe("unit-take");
    // A new chat's bare /aidlc there gets the build's own push first, never "everything is done".
    const bare = next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat-2" });
    expect(bare.ask_type, JSON.stringify(bare).slice(0, 300)).toBe("unit-push");
  });

  // Live run on Copilot CLI: the chat that took the first Unit was told its
  // work was finished once the merge opened the team's next one.
  test("in the chat that took and pushed a Unit, the team's next Unit its merge opened is offered, once", () => {
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const alice = cloneOf(home.remote, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    // The chat's first look offers refunds; the take, the build and the push all run in that chat.
    expect(next(alice, chat).ask_type).toBe("unit-take");
    expect(takeIn("payments", ["refunds", "--plan", plan.id8, "--from", Object.values(plan.hosts)[0]], alice, chat).status).toBe(0);
    const record = buildDir(alice, "payments", "refunds");
    codeGenerated(alice, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(planWordAt(plan, "refunds")).toMatchObject({ done: true });
    const offered = next(alice, chat);
    expect(offered.ask_type, JSON.stringify(offered).slice(0, 500)).toBe("unit-take");
    expect((offered.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start reporting");
    const again = next(alice, chat);
    expect(again.ask_type ?? null, JSON.stringify(again).slice(0, 300)).not.toBe("unit-take");
  });

  // The way to the next Unit that is not the lead's plan in her status: her
  // finished build's own next step, in any chat.
  test("a teammate's finished build, in a later chat, puts the Units to take at its next step", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const ana = cloneOf(home.remote, "ana");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, ana, name, "ana");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "ana-chat" };
    const took = run(UNIT, ["take", "refunds", "--plan", plan.id8, "--from", Object.values(plan.hosts)[0]], ana, chat);
    expect(took.status, took.out).toBe(0);
    const record = buildDir(ana, "default", "refunds");
    codeGenerated(ana, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], ana, chat);
    expect(pushed.status, pushed.out).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(planWordAt(plan, "refunds")).toMatchObject({ done: true });
    const later = next(ana, { ...ENV, AIDLC_SESSION_OVERRIDE: "ana-next-day" });
    expect(later.ask_type, JSON.stringify(later).slice(0, 600)).toBe("unit-take");
    expect((later.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start reporting");
  });

  test("while the home builds the walking skeleton, hears that every Unit waits on it, and nothing of the home's work runs", () => {
    const dependencies = "# Unit dependencies\n\n```yaml\nunits:\n  - name: orders\n    depends_on: []\n" +
      "  - name: refunds\n    depends_on: [orders]\n  - name: checkout-ui\n    depends_on: [orders]\n" +
      "  - name: reporting\n    depends_on: [refunds]\n```\n";
    const home = makeHome({ dependencies, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    const step = next(alice);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    // Nothing of the home's work runs here, and a teammate is offered nothing of it.
    expect(step.offers, JSON.stringify(step)).toBeUndefined();
    expect(step.message).toBe("Say the line above, then end the turn.");
    expect(offerText(step.narration)).toBe(
      "fixture is shared in app. The walking skeleton, orders, is built at the lead's project first. " +
        "Waiting: refunds (on orders), checkout-ui (on orders), reporting (on orders, refunds). " +
        "Nothing is ready to take yet.",
    );
    expect(git(alice, ["status", "--porcelain"])).toBe("");
    // Asked for one anyway: the skeleton by its Unit's name, never the engine's token for it.
    const typed = takeFrom("payments", alice, "refunds");
    expect(typed.status).not.toBe(0);
    expect(typed.out).toContain("refunds waits on orders, which is not done yet. It opens once it is done.");
    expect(typed.out).not.toContain("walking-skeleton");
  });

  test("a clone a day old hears the claims as the home has them now: a Unit whose dependency merged since opens, with no fetch by hand", () => {
    const { hosts, home, alice, record } = refundsTakenHere();
    // dana of data cloned before refunds was done, and looks while it waits.
    const dana = cloneOf(home.remote, "dana");
    inSpace(dana, "data");
    // web's clone took checkout-ui meanwhile.
    expect(takeFrom("web", cloneOf(home.remote, "wen"), "checkout-ui").status).toBe(0);
    const waiting = next(dana);
    expect(waiting.kind, JSON.stringify(waiting)).toBe("print");
    expect(offerText(waiting.narration)).toBe(
      "fixture is shared in checkout-api. Waiting: reporting (on refunds). Being built: refunds " +
        "(by alice in payments), checkout-ui (by wen in web). Nothing is ready to take yet.",
    );
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
    const ready = next(dana);
    expect(ready.ask_type, JSON.stringify(ready)).toBe("unit-take");
    expect((ready.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start reporting");
    expect(ready.change_notices ?? []).toEqual([]);
  });
});

describe("the lead who says so in a clone that did not make the plan", () => {
  // The lead's own checkout made the plan and shared it in app; `moved`: then
  // moved it to web, after this second clone of theirs was made.
  function leadsSecondClone(moved: boolean) {
    const home = makeHome({ repos: { app: codeHost("app"), web: codeHost("web") } });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const laptop = cloneOf(home.remote, "lead");
    if (moved) {
      const went = run(UNIT, ["share", "--plan", "--repo", "web"], home.dir);
      expect(went.status, went.out).toBe(0);
    }
    return { home, laptop, plan };
  }
  // The person's message through the human-turn hook, then `next` with it, as the agent runs it. The message
  // store keeps whole seconds, so each message goes in a second of its own, as a person's typing does.
  const says = (dir: string, chat: string, words: string) => {
    Bun.sleepSync(1000 - (Date.now() % 1000) + 20);
    expect(hook(dir, personsChat(chat), { hook_event_name: "UserPromptSubmit", session_id: chat, prompt: words }).status).toBe(0);
    const step = run(ORCH, ["next", ...words.split(" ")], dir, personsChat(chat));
    expect(step.status, step.out).toBe(0);
    return step;
  };
  const LEAD = "they lead this work, whether or not they ask to carry it on here (leading a team or a Unit of it is not that)";
  const I_LEAD = "Not me, I'm the lead, I won't take a Unit here.";
  // The commands the reply hands, run as given: the switch where it names one, then lead-here.
  const liftAsHanded = (dir: string, chat: string, text: string) => {
    const pick = /intent switch (\S+)`/.exec(text)?.[1];
    if (pick !== undefined) expect(run(UTILITY, ["intent", "switch", pick], dir, personsChat(chat)).status).toBe(0);
    const message = /lead-here --message (\S+)`/.exec(text)?.[1];
    expect(message, text).toBeDefined();
    const lifted = run(UNIT, ["lead-here", "--message", message!], dir, personsChat(chat));
    expect(lifted.status, lifted.out).toBe(0);
    expect(String(lifted.json?.step)).toEndWith(" next` and follow what it returns.");
    expect(auditBlockField(readAuditShardEvents(dir, HOME).findLast((row) => row.event === "LEAD_HERE_SET")?.block ?? "", "Person Words"))
      .toBe(I_LEAD);
    return lifted;
  };

  test("their words that they lead this work, without asking to carry it on here, hand the exact commands; the lift keeps their words and the lead's view follows", () => {
    const { laptop } = leadsSecondClone(false);
    const chat = "t-unit-take-i-lead";
    const first = says(laptop, chat, "where do things stand?");
    expect(first.json?.ask_type).toBe("unit-take");
    // First words that already say so are read for it before the offer is put.
    expect(String(first.json?.board_note)).toStartWith(`If the words they already gave say ${LEAD}, run \``);
    expect(String(first.json?.board_note)).toContain(` intent switch ${HOME}\`, then \``);
    expect(String(first.json?.board_note)).toEndWith("` in place of this question, and follow what it returns.");
    const text = String(says(laptop, chat, I_LEAD).json?.message);
    expect(text).toContain(`If they say ${LEAD}, run \``);
    expect(text).toContain(` intent switch ${HOME}\`, then \``);
    expect(text).not.toContain("--request-file");
    liftAsHanded(laptop, chat, text);
    expect(JSON.stringify(next(laptop, personsChat(chat)))).not.toContain("Taking a Unit starts it as your team's own piece of work here");
  });

  test("the plan moved after this clone was made: the second words in one chat are read against the Units offer where the plan is now", () => {
    const { laptop } = leadsSecondClone(true);
    const chat = "t-unit-take-i-lead-moved";
    says(laptop, chat, "where do things stand?");
    const text = String(says(laptop, chat, I_LEAD).json?.message);
    expect(text).toContain("The Units offer says: fixture is shared in web");
    expect(text).toContain(`If they say ${LEAD}, run \``);
    liftAsHanded(laptop, chat, text);
  });

  test("a teammate's clone made before the plan moved: their second words in one chat still get the Unit they ask for, from where the plan is now", () => {
    const { home, plan } = leadsSecondClone(true);
    const kai = cloneOf(home.remote, "kai");
    const chat = "t-unit-take-teammate-moved";
    expect(says(kai, chat, "what is ready for us?").json?.ask_type).toBe("unit-take");
    const text = String(says(kai, chat, "we will take refunds").json?.message);
    expect(text).toContain("The Units offer says: fixture is shared in web");
    expect(text).toContain(`take refunds --plan ${plan.id8} --from ${shellSingleQuote(plan.hosts.web)}`);
  });

  test("with nothing to offer (the plan gone from its repository), their words name the lead's work in its own clause, never an empty list", () => {
    const { laptop, plan } = leadsSecondClone(false);
    git(plan.hosts.app, ["update-ref", "-d", planRefOf(plan.id8)]);
    const text = String(says(laptop, "t-unit-take-i-lead-plan-gone", I_LEAD).json?.message);
    expect(text).toStartWith(`This clone has the lead's work (${HOME}), built by teams; the work itself is not picked here. If they say ${LEAD}, run \``);
    expect(text).not.toContain("()");
  });

  test("their word that they do not lead this work here takes it back: this clone's newest row decides, after the lead's walk went on there", () => {
    const { laptop, plan } = leadsSecondClone(false);
    const tip = () => git(plan.hosts.app, ["rev-parse", planRefOf(plan.id8)]);
    const chat = "t-unit-take-not-the-lead-after-all";
    says(laptop, chat, "where do things stand?");
    liftAsHanded(laptop, chat, String(says(laptop, chat, I_LEAD).json?.message));
    const before = tip();
    // The lead's walk carried on in this clone: a gate of the work's own in its own part of the record.
    asLeadsOwnCheckout(laptop);
    const notLead = "No, I'm not the lead after all, I lead the payments team.";
    const text = String(says(laptop, chat, notLead).json?.message);
    const message = /lead-here --off --message (\S+)`/.exec(text)?.[1];
    expect(message, text).toBeDefined();
    const off = run(UNIT, ["lead-here", "--off", "--message", message!], laptop, personsChat(chat));
    expect(off.status, off.out).toBe(0);
    expect(off.json?.notice).toBe("This checkout no longer carries the work on as the lead's; anything it wrote to the plan stays.");
    const row = readAuditShardEvents(laptop, HOME).findLast((entry) => entry.event === "LEAD_HERE_SET");
    expect(auditBlockField(row?.block ?? "", "Lead Here")).toBe("off");
    expect(auditBlockField(row?.block ?? "", "Person Words")).toBe(notLead);
    // A teammate's view again, and nothing written on the plan.
    expect(JSON.stringify(next(laptop, personsChat(chat)))).toContain("Taking a Unit starts it as your team's own piece of work here");
    expect(tip()).toBe(before);
  });

  test("a team's own workspace never hears the sentence", () => {
    const { alice } = refundsTakenHere();
    expect(says(alice, "t-unit-take-not-the-lead", "what is ready for us now?").out).not.toContain("lead-here");
  });

  test("the board asked for a space or a record it cannot find says so in plain words, with the work this project has", () => {
    const { laptop } = leadsSecondClone(false);
    const board = (...args: string[]) => {
      const shown = run(ORCH, ["team-board", ...args], laptop);
      expect(shown.status, "a lookup that found nothing still fails").not.toBe(0);
      return String(shown.json?.error ?? shown.out);
    };
    const work = `Work in this project: fixture (record ${HOME}): `;
    expect(board("--space", "web")).toStartWith(`This project has no space named "web". ${work}`);
    expect(board("--space", "web", "--intent", HOME)).toStartWith(`No work with the record ${HOME} is in a space named "web". ${work}`);
    expect(run(UTILITY, ["space", "create", "payments"], laptop).status).toBe(0);
    expect(board("--space", "payments")).toStartWith(`The space "payments" has no work in progress. ${work}`);
    // A project with no work at all: status's own line alone, never a label over an empty list.
    const bare = tempDir("no-work");
    git(bare, ["init", "-q"]);
    const none = run(ORCH, ["team-board", "--space", "web"], bare);
    expect(String(none.json?.error ?? none.out)).toBe("This project has no space named \"web\". No active AI-DLC workflow found.");
  });
});

describe("taking a Unit starts its build in the team's space", () => {
  // A live run: the build's Workflow Start said "/aidlc Build ... from what
  // the lead approved", words nobody typed.
  test("the build's start records the person's own words of the take, or that the take started it, never a /aidlc line nobody typed", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const request = (unit: string, space: string): string | null => {
      const rows = readAuditShardEvents(alice, basename(buildDir(alice, space, unit)), space);
      const started = rows.find((row) => row.event === "WORKFLOW_STARTED");
      return started === undefined ? null : (/^\*\*Request\*\*: (.*)$/m.exec(started.block)?.[1] ?? null);
    };
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    expect(request("refunds", "payments")).toBe("Taken from the lead's plan: refunds");
    const said = takeFrom("web", alice, "checkout-ui", ["--person-words", "we're the web team, we'll do the checkout page"]);
    expect(said.status, said.out).toBe(0);
    expect(request("checkout-ui", "web")).toBe("we're the web team, we'll do the checkout page");
  });

  // The words are read before the claim is written: a request file that cannot
  // be read stops the take with nothing taken at the lead's project.
  test("a take whose request file cannot be read takes nothing at the lead's project", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    inSpace(alice, "payments");
    const before = recordAt(home, "refunds")?.json;
    const took = take(alice, "refunds", ["--request-file", "aidlc/.aidlc-engine/request-text/missing.txt"]);
    expect(took.status).not.toBe(0);
    expect(recordAt(home, "refunds")?.json).toEqual(before);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    expect(existsSync(intents) && readdirSync(intents).some((name) => name.endsWith("-refunds"))).toBe(false);
  });

  // The build records its home, which an older AI-DLC cannot read, so it says
  // State Version 9 as the home's own record does: an older AI-DLC on that
  // team's checkout stops at it instead of building the Unit on its own flow.
  test("a Unit's own build says State Version 9 where it records its home", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const took = takeFrom("payments", alice, "refunds");
    expect(took.status, took.out).toBe(0);
    const state = readFileSync(join(buildDir(alice, "payments", "refunds"), "aidlc-state.md"), "utf-8");
    expect(field(state, "Home Location")).toBe(home.hosts.app);
    expect(field(state, "State Version")).toBe("9");
  });

  // Work a newer AI-DLC set up (a State Version this build cannot read) is
  // never offered here: a look in a teammate's clone of the shared workspace
  // gives the update offer, in the words next's other doors say, in place of
  // its Units. A take reads the plan's own format (t-plan-read).
  test("team work a newer AI-DLC set up: a look gives the update offer, never its Units", () => {
    const home = makeHome({ state: homeState().replace("- **State Version**: 8", "- **State Version**: 10") });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(field(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME, "aidlc-state.md"), "utf-8"), "State Version")).toBe("10");
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const NEWER = "This plan was set up with a newer AI-DLC";
    // A bare look, and a teammate's first words, in a clone with nothing selected.
    const bob = cloneOf(home.remote, "bob");
    for (const words of [[], ["we want to take refunds"]]) {
      const said = JSON.stringify(next(bob, ENV, words));
      expect(said, said.slice(0, 600)).toContain(NEWER);
      expect(said).not.toContain("Ready to take");
      expect(said).not.toContain("Taking a Unit starts it");
    }
  });

  test("one Unit, the home's inputs at their own paths, the home's Inception done, the claim taken", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const took = takeFrom("payments", alice, "refunds");
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ taken: true, unit: "refunds", team: "payments", space: "payments" });
    expect(String(took.json?.notice)).toStartWith(
      "refunds is yours. You build it in the payments space under your team's rules, from what the lead approved.",
    );
    expect(recordAt(home, "refunds")?.json).toMatchObject({
      status: "claimed",
      owner: "payments",
      taken_by: "alice",
    });
    const record = buildDir(alice, "payments", "refunds");
    const state = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    expect(field(state, "Unit Build")).toBe("refunds");
    expect(field(state, "Home Location")).toBe(home.hosts.app);
    expect(field(state, "Home Record")).toBeUndefined();
    expect(field(state, "Skeleton Stance")).toBe("off");
    // The home's Inception is done, not this build's plan; units-generation
    // stays [x], so the Unit's own paths are the per-Unit ones.
    expect(state).toMatch(/^- \[x\] units-generation /m);
    expect(state).toMatch(/^- \[x\] requirements-analysis /m);
    expect(state).toMatch(/^- \[-\] functional-design /m);
    for (const rel of ["inception/requirements-analysis/requirements.md", "inception/units-generation/unit-of-work-dependency.md"]) {
      expect(readFileSync(join(record, rel), "utf-8")).toBe(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME, rel), "utf-8"));
    }
    const approved = readFileSync(join(record, "approved-inputs.md"), "utf-8");
    expect(approved).toContain("| inception/units-generation/unit-of-work-dependency.md | sha256:");
    // The home's approvals stay the home's: the build's audit holds none of them.
    const rows = readAuditShardEvents(alice, basename(record), "payments");
    expect(rows.filter((row) => row.event === "UNIT_TAKEN_IN")).toHaveLength(1);
    expect(rows.some((row) => row.event === "GATE_APPROVED" || row.event === "HUMAN_TURN")).toBe(false);
    // Its registry row is in its own folder, and listed with the space's.
    expect(existsSync(join(alice, "aidlc", "spaces", "payments", "intents", "intents.json"))).toBe(false);
    expect(readIntentRegistry(alice, "payments").map((row) => row.slug)).toEqual(["refunds"]);
    const step = next(alice);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe("functional-design");
    expect(step.unit).toBe("refunds");
    expect((step.produces as string[])[0]).toContain("/construction/refunds/functional-design/");
  });

  // A live run: the lead approved a plan with Plan Approval on over a scope
  // whose default is off; the team's build read "Plan Approval: off (from
  // scope express)", and Code Generation built with no plan question.
  test("the build keeps the plan settings the home approved, not its scope's defaults", () => {
    const home = makeHome();
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME, "aidlc-state.md");
    const set = (content: string, name: string, value: string) => new RegExp(`^- \\*\\*${name}\\*\\*:.*$`, "m").test(content)
      ? content.replace(new RegExp(`^- \\*\\*${name}\\*\\*:.*$`, "m"), `- **${name}**: ${value}`)
      : content.replace(/^- \*\*Test Strategy\*\*:.*$/m, (line) => `${line}\n- **${name}**: ${value}`);
    let homeState = readFileSync(statePath, "utf-8").replace(/^- \*\*Scope\*\*: .*$/m, "- **Scope**: express");
    for (const [name, value] of [["Plan Approval", "on (set by you)"], ["Sensors", "on (set by you)"], ["Learnings", "on (set by you)"],
      ["Depth", "Comprehensive"], ["Review Override", "adversarial"], ["Guard Policy", "strict (set by you)"],
      ["Construction Autonomy Mode", "gated"]] as const) homeState = set(homeState, name, value);
    writeFileSync(statePath, homeState);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    const took = takeFrom("payments", alice, "refunds");
    expect(took.status, took.out).toBe(0);
    const state = readFileSync(join(buildDir(alice, "payments", "refunds"), "aidlc-state.md"), "utf-8");
    expect(field(state, "Plan Approval")).toBe("on (from the lead's plan)");
    expect(field(state, "Sensors")).toBe("on (from the lead's plan)");
    expect(field(state, "Learnings")).toBe("on (from the lead's plan)");
    expect(field(state, "Depth")).toBe("Comprehensive");
    expect(field(state, "Review Override")).toBe("adversarial");
    expect(field(state, "Guard Policy")).toBe("strict (from the lead's plan)");
    expect(field(state, "Construction Autonomy Mode")).toBe("gated");
  });

  // Arden's call on a live run: a team builds under its own rules; where the
  // lead's project has rules of its own, the take question that is already
  // asked offers to follow them too, named in short, and taking it that way
  // loads them, read where they are, with the team's own on top.
  test("the lead's project rules are offered at the take, named, and taken they reach the build before the team's own", () => {
    const home = makeHome();
    const projectRules = join(home.dir, "aidlc", "spaces", "default", "memory", "project.md");
    writeFileSync(projectRules, `${readFileSync(projectRules, "utf-8")}\n## Release Checks\n\nEvery handler ships with a contract test.\n`);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    inSpace(alice, "payments");
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const choices = ask.choices as Array<{ label: string; command: string }>;
    // Each Unit once: its start follows the lead's rules too, recommended, the
    // headings in its detail; one row under the team's own rules only.
    expect(choices.map((choice) => choice.label)).toEqual([
      "Start refunds",
      "Start checkout-ui",
      "Start one under your team's own rules only",
    ]);
    expect(choices[0].command).toEndWith(" --lead-rules");
    expect((choices[0] as { detail?: string }).detail).toContain("The lead's project rules (Release Checks) apply to its build too");
    expect(choices[2].command).not.toContain("--lead-rules");
    expect(String(ask.question)).toContain("follows the lead's project rules too");
    const took = takeFrom("payments", alice, "refunds", ["--lead-rules"]);
    expect(took.status, took.out).toBe(0);
    const record = buildDir(alice, "payments", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("rules/project.md");
    const step = next(alice);
    expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("run-stage");
    expect(step.rules_in_context as string[]).toContain("the lead's rules/project.md");
    // The lead's file is read, never written, from the build.
    expect(readFileSync(join(alice, "aidlc", "spaces", "default", "memory", "project.md"), "utf-8")).toContain("Every handler ships with a contract test.");
  });

  // A live run: the lead's team.md and project.md both had their own Code
  // Style, and the take named it twice.
  test("a rule name the lead's agreed practices and project rules share is named once at the take", () => {
    const home = makeHome();
    const memory = join(home.dir, "aidlc", "spaces", "default", "memory");
    for (const file of ["team.md", "project.md"]) {
      writeFileSync(join(memory, file), `# ${file}\n\n## Code Style\nNo default exports.\n`);
    }
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    inSpace(alice, "payments");
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const detail = String((ask.choices as Array<{ detail?: string }>)[0]?.detail);
    expect(detail).toContain("The lead's practices and project rules (Code Style) apply to its build too");
  });

  // A live run (S1): payments built the refund amount test-after against the
  // lead's agreed "test first", which the take never carried.
  test("the lead's practices are offered at the take too, named, and taken they reach the build before the team's own", () => {
    const home = makeHome();
    const practices = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    const seeded = readFileSync(practices, "utf-8");
    expect(seeded).toContain("## Testing Posture\n");
    writeFileSync(practices, seeded.replace("## Testing Posture\n", "## Testing Posture\nTest first for the refund amount.\n"));
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    inSpace(alice, "payments");
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual([
      "Start refunds",
      "Start checkout-ui",
      "Start one under your team's own rules only",
    ]);
    expect((choices[0] as { detail?: string }).detail).toContain("The lead's practices (Testing Posture) apply to its build too");
    expect(String(ask.question)).toContain("Each start follows the lead's practices too, with your team's own on top, as I'd recommend;");
    expect((choices[2] as { detail?: string }).detail).toStartWith("Without the lead's practices.");
    expect(JSON.stringify(ask)).not.toContain("agreed");
    const took = takeFrom("payments", alice, "refunds", ["--lead-rules"]);
    expect(took.status, took.out).toBe(0);
    // The take's own line names what the person chose to follow.
    expect(String(took.json?.notice)).toStartWith(
      "refunds is yours. You build it in the payments space under your team's rules and the lead's practices, from what the lead approved.",
    );
    const record = buildDir(alice, "payments", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("rules/team.md");
    const step = next(alice);
    expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("run-stage");
    expect(step.rules_in_context as string[]).toContain("the lead's rules/team.md");
    // The lead's file is read, never written, from the build.
    expect(readFileSync(practices, "utf-8")).toContain("Test first for the refund amount.");
  });

  // A live run on Claude Code: a teammate read eight options plus Other to
  // start one Unit, every Unit twice (with the lead's rules, or the team's own).
  test("with several Units to start, each appears once, and one row takes a Unit under the team's own rules only", () => {
    const home = makeHome();
    const practices = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(practices, readFileSync(practices, "utf-8").replace("## Testing Posture\n", "## Testing Posture\nTest first for the refund amount.\n"));
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    inSpace(alice, "payments");
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const choices = ask.choices as Array<{ label: string; command: string; detail?: string }>;
    const labels = choices.map((choice) => choice.label);
    expect(labels.filter((label) => label.startsWith("Start refunds"))).toEqual(["Start refunds"]);
    expect(labels.filter((label) => label.startsWith("Start checkout-ui"))).toEqual(["Start checkout-ui"]);
    const own = choices.find((choice) => choice.label === "Start one under your team's own rules only");
    expect(own, labels.join(" | ")).toBeDefined();
    expect(own!.command).toContain("'<the Unit>'");
    expect(own!.command).not.toContain("--lead-rules");
    expect(own!.detail).toContain("I'll ask which Unit");
    for (const choice of choices.filter((entry) => /^Start (refunds|checkout-ui)$/.test(entry.label))) expect(choice.command).toEndWith(" --lead-rules");
    expect(own!.command).not.toContain("--team");
    // The Unit filled in, the own-rules take runs without the lead's rules.
    // As a POSIX shell reads the printed words: each single-quoted one is one word.
    const took = run(UNIT, own!.command.replace(/^.*aidlc-unit\.ts /, "").replace("'<the Unit>'", "refunds")
      .split(" ").filter(Boolean).map((word) => word.replace(/^'(.*)'$/, "$1")), alice);
    expect(took.status, took.out).toBe(0);
    expect(field(readFileSync(join(buildDir(alice, "payments", "refunds"), "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBeUndefined();
  });

  // A live run on Codex: the take carried the lead's agreed "tests are written
  // first" into the build's rules, but its testing contract still read the
  // organisation's default, so the agent asked the team whether to copy it.
  test("taken with the lead's practices, the build's testing contract follows the lead's Testing Posture where the team's own says none", () => {
    const home = makeHome();
    const practices = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    const seeded = readFileSync(practices, "utf-8");
    writeFileSync(practices, seeded.replace("## Testing Posture\n", "## Testing Posture\nTDD: the refund amount's tests are written first and must fail.\n"));
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    const posture = (dir: string) => JSON.parse(run(join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), ["resolve"], dir).out) as { methodology: string; source: string };
    expect(takeFrom("payments", alice, "refunds", ["--lead-rules"]).status).toBe(0);
    expect(posture(alice)).toMatchObject({ methodology: "tdd", source: "team" });
  });

  // The lead's rules are read where they are: a file of the lead's that is gone
  // never stops the team's build.
  test("a lead's file the build follows that is gone: the step goes on under the team's own rules and says so once", () => {
    const home = makeHome();
    const practices = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(practices, `${readFileSync(practices, "utf-8")}\n## Refund Amount\n\nTest first for the refund amount.\n`);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds", ["--lead-rules"]).status).toBe(0);
    // The lead's practices go from the plan the lead shares next.
    git(home.dir, ["rm", "-q", "aidlc/spaces/default/memory/team.md"]);
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    const first = run(ORCH, ["next"], alice, chat);
    expect(first.status, first.out).toBe(0);
    const step = next(alice, chat);
    expect(step.kind, JSON.stringify(step).slice(0, 600)).toBe("run-stage");
    expect(step.rules_in_context as string[]).not.toContain("the lead's rules/team.md");
    expect(first.out).toContain("The lead's practices could not be read just now, so this step follows your team's own rules.");
    expect(run(ORCH, ["next"], alice, chat).out).not.toContain("could not be read just now");
  });

  test("at the lead's project the learnings choice says a project learning is offered to any team that takes a Unit", () => {
    const home = homeWithTeams();
    const lead = readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME, "aidlc-state.md"), "utf-8");
    expect(learningsCorrectionChoices(lead)).toEqual(["Yes, for this project, and offered to any team that takes a Unit", "Yes, for the team", "No"]);
    expect(learningsCorrectionChoices(homeState())).toEqual(["Yes, for this project", "Yes, for the team", "No"]);
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    expect(learningsCorrectionChoices(readFileSync(join(buildDir(alice, "payments", "refunds"), "aidlc-state.md"), "utf-8"))[0])
      .toBe("Yes, for this project");
    // Either wording is the same question when its answer is read back.
    for (const choices of [learningsCorrectionChoices(lead), learningsCorrectionChoices(homeState())]) {
      expect(offersLearningsCorrectionChoices((choice) => choices.includes(choice))).toBe(true);
    }
  });

  test("a lead's project with no rules of its own offers each Unit once, as before", () => {
    const home = homeWithTeams();
    const labels = ((next(cloneOf(home.remote, "alice")).choices ?? []) as Array<{ label: string }>).map((choice) => choice.label);
    expect(labels).toContain("Start refunds");
    expect(labels.some((label) => label.includes("project rules"))).toBe(false);
  });

  test("a build in the lead's own space follows the lead's rules as its own: the choice is not put, and a take with it reads none twice", () => {
    const home = makeHome();
    const practices = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(practices, readFileSync(practices, "utf-8").replace("## Testing Posture\n", "## Testing Posture\nTest first for the refund amount.\n"));
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const dee = cloneOf(home.remote, "dee");
    const ask = next(dee);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const said = JSON.stringify(ask);
    expect(said).not.toContain("--lead-rules");
    expect(said).not.toContain("under your team's own rules only");
    const took = take(dee, "refunds", ["--lead-rules"]);
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("default");
    expect(String(took.json?.notice)).toStartWith("refunds is yours. You build it under your team's rules, from what the lead approved.");
    expect(field(readFileSync(join(buildDir(dee, "default", "refunds"), "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBeUndefined();
  });

  // Live runs on Codex and Claude Code: a team's build runs its stages for its
  // one Unit, and a redo or a skip the person asked for, named for that Unit,
  // was refused as "only for every unit" and asked again.
  test("in a Unit's build, a redo or a skip named for its one Unit is the stage's own, never refused as one Unit's", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    const record = buildDir(alice, "payments", "refunds");
    const skip = run(ORCH, ["report", "--stage", "functional-design", "--unit", "refunds", "--result", "skipped"], alice);
    expect(skip.out).not.toContain("a one-unit skip works only when");
    expect(skip.status, skip.out).toBe(0);
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace(/^- \[S\] functional-design /m, "- [x] functional-design "));
    const redo = next(alice, undefined, ["--stage", "functional-design", "--unit", "refunds"]);
    expect(JSON.stringify(redo)).not.toContain("can be reopened for one unit only");
    expect(JSON.stringify(redo)).not.toContain("Do you want me to reopen it for every unit?");
    // The line names the build's one Unit, never every unit.
    expect(JSON.stringify(redo)).not.toContain("for every unit");
    expect(JSON.stringify(redo), JSON.stringify(redo).slice(0, 600)).toContain("Reopened Functional Design for refunds.");
  });

  // A live run on Kiro IDE: the lead picked "a confirm step" in Refined
  // Mockups; the team's Functional Design found no mockups in its record and
  // built the panel without it. The take carries the lead's approved design,
  // as the Unit's build would read it in the lead's own checkout.
  test("the take carries every Ideation and Inception output the lead approved, the mockups too", () => {
    const D = String.fromCharCode(0x2014);
    const home = makeHome({
      state: homeState().replace(`- [x] units-generation ${D} EXECUTE`, `- [x] refined-mockups ${D} EXECUTE\n- [x] units-generation ${D} EXECUTE`),
    });
    const design = join(home.dir, "aidlc", "spaces", "default", "intents", HOME, "inception", "refined-mockups");
    mkdirSync(design, { recursive: true });
    writeFileSync(join(design, "interaction-spec.md"), "# Interaction spec\n\nThe refund panel asks to confirm before it sends.\n");
    writeFileSync(join(design, "mockups.md"), "# Mockups\n\nRefund panel with a confirm step.\n");
    // The lead's planning of the work itself is theirs: a change to it is no news for a team.
    const planning = join(home.dir, "aidlc", "spaces", "default", "intents", HOME, "inception", "delivery-planning");
    mkdirSync(planning, { recursive: true });
    writeFileSync(join(planning, "bolt-plan.md"), "# Bolt plan\n\nrefunds first.\n");
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const wen = cloneOf(home.remote, "wen");
    const took = takeFrom("web", wen, "checkout-ui");
    expect(took.status, took.out).toBe(0);
    const record = buildDir(wen, "web", "checkout-ui");
    expect(readFileSync(join(record, "inception", "refined-mockups", "interaction-spec.md"), "utf-8")).toContain("confirm before it sends");
    expect(existsSync(join(record, "inception", "refined-mockups", "mockups.md"))).toBe(true);
    const approved = readFileSync(join(record, "approved-inputs.md"), "utf-8");
    expect(approved).toContain("inception/refined-mockups/interaction-spec.md");
    // The lead's own record of the code is the team's code itself: never copied.
    expect(approved).not.toContain("reverse-engineering");
    expect(approved).not.toContain("delivery-planning");
  });

  // A live run on Codex: the lead's work ran Construction autonomously, the
  // team's build of one Unit took that, and its Code Generation went out as a
  // parallel batch in worktrees: a commit landed on the person's own main and
  // the build's agent patched AI-DLC's own tool to get past it.
  test("a Unit's build holds one Unit, so its Code Generation is never a parallel batch, whatever autonomy the lead's work runs", () => {
    const home = makeHome({ state: homeState(["- **Construction Autonomy Mode**: autonomous"]) });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    const statePath = join(buildDir(alice, "payments", "refunds"), "aidlc-state.md");
    // The lead's "continue automatically" was theirs: the team approves its own Unit.
    expect(field(readFileSync(statePath, "utf-8"), "Construction Autonomy Mode")).toBe("gated");
    // The team's own choice to run on by itself, later, as its state then reads.
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \*\*Construction Autonomy Mode\*\*: .*$/m, "- **Construction Autonomy Mode**: autonomous")
      .replace(/^- \[[ -]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    const step = next(alice);
    expect(step.kind, JSON.stringify(step).slice(0, 500)).not.toBe("invoke-swarm");
    expect(step).toMatchObject({ kind: "run-stage", stage: "code-generation" });
  });

  // A live run on Codex: in the chat of the team's other build, "anything new
  // for payments?" missed the lead's send-back of refunds that came after the
  // chat's first look, and only a later ask heard it.
  test("the lead's turn-down of another of the team's builds reaches the chat at the person's next message, after its first look", () => {
    const { home, alice, record } = refundsTakenHere();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const other = take(alice, "checkout-ui");
    expect(other.status, other.out).toBe(0);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-reporting-chat" };
    // The chat's first look, before the lead's word.
    next(alice, chat);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry"], home.dir).status).toBe(0);
    appendAuditEntry("HUMAN_TURN", { Session: "alice-reporting-chat", "Person Reply": "anything new for payments?" }, alice);
    const step = next(alice, chat, ["--", "anything new for payments?"]);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 500)).toContain(
      'refunds was turned down in billing by the lead: "billing needs the ledger entry". Its build is waiting for you; say so to go back to it.',
    );
  });

  test("the team approves each of its stages: the build holds on a stage until it is approved", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    expect(field(readFileSync(join(buildDir(alice, "payments", "refunds"), "aidlc-state.md"), "utf-8"), "Construction Iteration"))
      .toBe("stage-major");
    const step = next(alice);
    for (const rel of step.produces as string[]) {
      mkdirSync(join(alice, rel, ".."), { recursive: true });
      writeFileSync(join(alice, rel), "# Refunds\n\nFR1 refunds.\n");
    }
    run(ORCH, ["report", "--stage", "functional-design", "--result", "awaiting-approval"], alice);
    expect(next(alice).stage).toBe("functional-design");
  });
});

describe("a Unit someone holds is not taken again", () => {
  test("taken by a teammate: the take says who has it and where, from any space", () => {
    const home = homeWithTeams();
    expect(takeFrom("payments", cloneOf(home.remote, "alice"), "refunds").status).toBe(0);
    const bob = cloneOf(home.remote, "bob");
    const again = take(bob, "refunds");
    expect(again.status).not.toBe(0);
    expect(again.out).toContain("refunds is already taken: alice builds it in the payments space.");
    // From the same space it is taken all the same.
    const same = takeFrom("payments", bob, "refunds");
    expect(same.status).not.toBe(0);
    expect(same.out).toContain("refunds is already taken: alice builds it in the payments space.");
    expect(`${again.out}${same.out}`).not.toContain("team");
  });

  test("a Unit taken while the home is changing the Unit plan is taken on the plan as the lead last shared it, with nothing said of the lead's open stage", () => {
    const home = homeWithTeams();
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME, "aidlc-state.md");
    const back = readFileSync(statePath, "utf-8")
      .replace(/^- \[x\] units-generation /m, "- [-] units-generation ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: units-generation");
    writeFileSync(statePath, back);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "units generation again"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const took = takeFrom("payments", cloneOf(home.remote, "alice"), "refunds");
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).not.toContain("The lead is changing the Unit plan");
    expect(recordAt(home, "refunds")?.json).toMatchObject({ base_oid: home.plan });
  });

  test("a waiting Unit is not taken yet, and the line says when it opens", () => {
    const home = homeWithTeams();
    const waiting = take(cloneOf(home.remote, "carol"), "reporting");
    expect(waiting.status).not.toBe(0);
    expect(waiting.out).toContain("reporting waits on refunds, which is not done yet. It opens once it is done.");
  });

  // The GitHub live test: a teammate checked her finished build in on a
  // branch of its own for a pull request, went back to main before it merged,
  // and read her own Unit as someone's being built.
  test("back on main with their build checked in on a branch of its own: the take question offers to carry it on there, never as taken, and the take switches to it", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const bea = cloneOf(home.remote, "bea");
    const took = take(bea, "refunds");
    expect(took.status, took.out).toBe(0);
    finishBuild(buildDir(bea, "default", "refunds"));
    git(bea, ["switch", "-q", "-c", "records/refunds"]);
    commitAll(bea, "refunds record");
    git(bea, ["push", "-q", "-u", "origin", "records/refunds"]);
    git(bea, ["switch", "-q", "main"]);
    const ask = next(bea);
    expect(carryOnChoice(ask, "refunds")?.detail, JSON.stringify(ask).slice(0, 800)).toBe("Your build of it, on branch records/refunds; I switch you there.");
    expect(JSON.stringify(ask)).not.toContain("refunds (by bea)");
    expect(JSON.stringify(ask)).not.toContain("git switch");
    // The take does the switch the person asked for, and carries the build on there.
    const again = take(bea, "refunds");
    expect(again.status, again.out).toBe(0);
    expect(again.json?.notice, again.out).toBe("You're on records/refunds now, where your build of refunds is. Carrying on refunds, your build here. Switch back to main any time.");
    expect(git(bea, ["branch", "--show-current"])).toBe("records/refunds");
    expect(JSON.stringify(next(bea))).not.toContain("Your build of refunds");
  });

  // The GitHub re-run's case 6b: back on main while the record's pull request
  // was open, the teammate heard nothing after the lead recorded the merge.
  test("back on main with their record on a branch of its own, the person hears their merge once on each computer, and a teammate never", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    sharedPlan = home;
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(alice, ["switch", "-q", "-c", "records/refunds"]);
    git(alice, ["add", "aidlc"]);
    git(alice, ["commit", "-q", "-m", "refunds record"]);
    git(alice, ["push", "-q", "-u", "origin", "records/refunds"]);
    git(alice, ["switch", "-q", "main"]);
    // A teammate holding alice's record branch, cloned before the merge, so her own look is the one that brings it.
    const bea = cloneOf(home.remote, "bea");
    git(bea, ["branch", "-q", "records/refunds", "origin/records/refunds"]);
    // Her other computer, with the record branch only as the clone fetched it.
    const desk = cloneOf(home.remote, "alice");
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir, chatOf("lead-after-merge"));
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
    const chat = chatOf("alice-on-main");
    expect(nextSaying(alice, chat).said).toContain("Your refunds is merged.");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "what next" }, alice);
    expect(nextSaying(alice, chat).said).not.toContain("is merged.");
    expect(nextSaying(alice, chatOf("alice-later")).said).not.toContain("is merged.");
    git(alice, ["switch", "-q", "records/refunds"]);
    expect(nextSaying(alice, chatOf("alice-on-record")).said).not.toContain("is merged.");
    expect(nextSaying(bea, chatOf("bea")).said).not.toContain("is merged.");
    expect(nextSaying(desk, chatOf("alice-desk")).said).toContain("Your refunds is merged.");
    expect(nextSaying(desk, chatOf("alice-desk-later")).said).not.toContain("is merged.");
  });

  test("a teammate's take whose build is on a local branch here is still said as theirs", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const ann = cloneOf(home.remote, "ann");
    expect(take(ann, "refunds").status).toBe(0);
    git(ann, ["switch", "-q", "-c", "records/refunds"]);
    commitAll(ann, "refunds record");
    git(ann, ["push", "-q", "-u", "origin", "records/refunds"]);
    const bea = cloneOf(home.remote, "bea");
    git(bea, ["branch", "-q", "records/refunds", "origin/records/refunds"]);
    const ask = next(bea);
    expect(String(ask.question ?? ask.narration), JSON.stringify(ask).slice(0, 800)).toContain("refunds (by ann)");
    expect(JSON.stringify(ask)).not.toContain("Your build of refunds");
    const taken = take(bea, "refunds");
    expect(taken.status).not.toBe(0);
    expect(taken.out).toContain("refunds is already taken: ann builds it.");
  });

  // A second computer: a fresh clone holds the person's record branch only as
  // the remote's, fetched with the clone, while its pull request is open.
  test("on another computer, their build checked in on a branch the clone has only from its remote is offered to carry on, never as taken, and the take switches to it", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const bea = cloneOf(home.remote, "bea");
    expect(take(bea, "refunds").status).toBe(0);
    git(bea, ["switch", "-q", "-c", "records/refunds"]);
    commitAll(bea, "refunds record");
    git(bea, ["push", "-q", "-u", "origin", "records/refunds"]);
    git(bea, ["switch", "-q", "main"]);
    const detail = "Your build of it, on branch records/refunds; I switch you there.";
    // Her other computer under her git name, and one under another name with her email.
    const desk = cloneOf(home.remote, "bea");
    const laptop = cloneOf(home.remote, "bea-laptop");
    git(laptop, ["config", "user.email", "bea@example.test"]);
    for (const clone of [desk, laptop]) {
      const ask = next(clone);
      expect(carryOnChoice(ask, "refunds")?.detail, JSON.stringify(ask).slice(0, 800)).toBe(detail);
      expect(JSON.stringify(ask)).not.toContain("refunds (by bea)");
      // git makes the branch from the fetched one, and the take carries the build on there.
      const again = take(clone, "refunds");
      expect(again.status, again.out).toBe(0);
      expect(again.json?.notice, again.out).toBe("You're on records/refunds now, where your build of refunds is. Carrying on refunds, your build here. Switch back to main any time.");
      expect(git(clone, ["branch", "--show-current"])).toBe("records/refunds");
    }
    expect(JSON.stringify(next(desk))).not.toContain("Your build of refunds");
    // Her first computer reads it as before; another person reads who has it.
    expect(carryOnChoice(next(bea), "refunds")?.detail).toBe(detail);
    const bob = cloneOf(home.remote, "bob");
    expect(String(next(bob).question)).toContain("refunds (by bea)");
    const taken = take(bob, "refunds");
    expect(taken.status).not.toBe(0);
    expect(taken.out).toContain("refunds is already taken: bea builds it.");
  });

  test("the person's own take with its build on no branch of the clone: nowhere on origin, the one step only they can take; pushed, the take fetches it and switches there; merged, the take brings main up to date; a branch with no build, or cut from main since, is never named", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const bea = cloneOf(home.remote, "bea");
    expect(take(bea, "refunds").status).toBe(0);
    const pushNotes = (dir: string, branch: string) => {
      git(dir, ["switch", "-q", "-c", branch, "origin/main"]);
      writeFileSync(join(dir, `${branch}.md`), "Notes.\n");
      git(dir, ["add", `${branch}.md`]);
      git(dir, ["commit", "-q", "-m", branch]);
      git(dir, ["push", "-q", "-u", "origin", branch]);
    };
    pushNotes(bea, "notes");
    git(bea, ["switch", "-q", "main"]);
    const desk = cloneOf(home.remote, "bea");
    // Her third computer, on main, which the merge reaches later.
    const third = cloneOf(home.remote, "bea");
    const bob = cloneOf(home.remote, "bob");
    const board = (dir: string) => {
      const ask = next(dir);
      expect(String(ask.question ?? ask.narration), JSON.stringify(ask).slice(0, 800)).toContain("refunds (by bea)");
      expect(JSON.stringify(ask)).not.toContain("Your build of refunds");
    };
    const refused = (dir: string) => {
      const taken = take(dir, "refunds");
      expect(taken.status).not.toBe(0);
      return taken.out;
    };
    const taken = "refunds is already taken: bea builds it.";
    const notOnOrigin = "You took refunds on another computer, and its build is not on origin yet: push it from that " +
      "computer, then ask me to carry it on here.";
    // Her own take, with its build nowhere this clone or origin has it: where it is, and the one step only she can take.
    board(desk);
    const notHere = refused(desk);
    expect(notHere).toContain(notOnOrigin);
    expect(notHere).not.toContain("git pull");
    expect(notHere).not.toContain("already taken");
    // Another person reads who has it.
    board(bob);
    expect(refused(bob)).toContain(taken);
    // Pushed from her first computer: the take fetches it here and switches there itself.
    git(bea, ["switch", "-q", "-c", "records/refunds"]);
    commitAll(bea, "refunds record");
    git(bea, ["push", "-q", "-u", "origin", "records/refunds"]);
    const switched = take(desk, "refunds");
    expect(switched.status, switched.out).toBe(0);
    expect(switched.json?.notice, switched.out).toBe("You're on records/refunds now, where your build of refunds is. Carrying on refunds, your build here. Switch back to main any time.");
    // Her record squash-merged on the host and its branch deleted; a
    // teammate's branch cut from main since holds her build too. Her third
    // computer, on main and behind: the take fetches both and brings main up
    // to date, where the merged record is; no branch is named as hers.
    mergeOnHost(home.remote, "records/refunds", "squash");
    git(bea, ["push", "-q", "origin", "--delete", "records/refunds"]);
    pushNotes(bob, "bob-notes");
    board(third);
    const merged = take(third, "refunds");
    expect(merged.status, merged.out).toBe(0);
    expect(merged.json?.notice, merged.out).toBe(
      "Your main is up to date with origin/main now, with your build of refunds in it. Carrying on refunds, your build here.");
    expect(merged.out).not.toContain("records/refunds");
    expect(merged.out).not.toContain("bob-notes");
    expect(git(third, ["branch", "--show-current"])).toBe("main");
    expect(git(third, ["rev-parse", "main"])).toBe(git(third, ["rev-parse", "origin/main"]));
  });

  test("the person's own take when this clone's fetch fails, or its build is checked out in another worktree: where it is, and the one step only they can take", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const bea = cloneOf(home.remote, "bea");
    expect(take(bea, "refunds").status).toBe(0);
    const desk = cloneOf(home.remote, "bea");
    git(bea, ["switch", "-q", "-c", "records/refunds"]);
    commitAll(bea, "refunds record");
    git(bea, ["push", "-q", "-u", "origin", "records/refunds"]);
    // A ref of this clone's own in the way of the fetched branch's name: git's fetch fails here.
    git(desk, ["update-ref", "refs/remotes/origin/records", "HEAD"]);
    const failed = take(desk, "refunds");
    expect(failed.status).not.toBe(0);
    expect(failed.out).toContain("You took refunds on another computer, and its build is not in this clone yet. origin could not " +
      "be reached just now to look for it, so push it from that computer if you have not, then ask me again.");
    expect(failed.out).not.toContain("git pull");
    // Her first computer, the branch checked out in a worktree of its own and her checkout back on main.
    git(bea, ["switch", "-q", "main"]);
    const folder = join(tempDir("worktree"), "records");
    git(bea, ["worktree", "add", "-q", folder, "records/refunds"]);
    const there = take(bea, "refunds");
    expect(there.status).not.toBe(0);
    expect(there.out).toContain("Your build of refunds is on branch records/refunds, which is checked out in ");
    expect(there.out).toContain(": carry it on there.");
    expect(git(bea, ["branch", "--show-current"])).toBe("main");
  });

  // A blobless partial clone keeps the record's file of a fetched branch on
  // the host, and AI-DLC fetches nothing to read it: git cannot say whether
  // that branch holds the build, so no pull is asked for.
  test("a clone whose git cannot read a fetched branch keeps today's line for the person's own take", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const bea = cloneOf(home.remote, "bea");
    expect(take(bea, "refunds").status).toBe(0);
    git(bea, ["switch", "-q", "-c", "records/refunds"]);
    commitAll(bea, "refunds record");
    git(bea, ["push", "-q", "-u", "origin", "records/refunds"]);
    git(home.remote, ["config", "uploadpack.allowFilter", "true"]);
    const desk = join(tempDir("blobless"), "workspace");
    git(join(desk, ".."), ["clone", "-q", "--filter=blob:none", pathToFileURL(home.remote).href, desk]);
    git(desk, ["config", "user.name", "bea"]);
    git(desk, ["config", "user.email", "bea@example.test"]);
    const taken = take(desk, "refunds");
    expect(taken.status).not.toBe(0);
    expect(taken.out).toContain("refunds is already taken: bea builds it.");
    expect(taken.out).not.toContain("git pull");
  });
});

describe("who takes what", () => {
  test("a second Unit taken from a space already building one is built there too", () => {
    const home = homeWithTeams();
    expect(takeFrom("payments", cloneOf(home.remote, "alice"), "refunds").status).toBe(0);
    const bob = cloneOf(home.remote, "bob");
    inSpace(bob, "payments");
    const ask = next(bob);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start checkout-ui");
    const took = take(bob, "checkout-ui");
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("payments");
  });

  test("an open Unit in a fresh clone is offered once, with no team to name, and its build is where the person is", () => {
    const home = homeWithTeams();
    const carol = cloneOf(home.remote, "carol");
    const ask = next(carol);
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual([
      "Start refunds",
      "Start checkout-ui",
      "Carry on fixture here, as the lead",
    ]);
    expect(choices[1].command).toEndWith(`aidlc-unit.ts ${takeCommand(home, "checkout-ui")}`);
    const took = take(carol, "checkout-ui");
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("default");
  });

  test("a Unit the lead builds here on their word is not offered in a fresh clone: it says who builds it", () => {
    const home = homeWithTeams();
    git(home.dir, ["config", "user.name", "lee"]);
    const here = run(UNIT, ["assign", "--here", "refunds"], home.dir);
    expect(here.status, here.out).toBe(0);
    expect(here.json?.notice).toBe("refunds is built here now, no longer open for the teams.");
    commitAll(home.dir, "refunds here");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const ask = next(cloneOf(home.remote, "riley"));
    expect(String(ask.question)).toContain("Ready to take: checkout-ui (open; likely checkout-web).");
    expect(String(ask.question)).toContain("Being built: refunds (by lee).");
    expect(String(ask.question)).not.toContain("refunds (open");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label).filter((label) => label.includes("refunds"))).toEqual([]);
    // Asked again, it is the same word: one more Here row, the same line, the claim untouched.
    const claim = recordAt(home, "refunds")?.json;
    const again = run(UNIT, ["assign", "--here", "refunds"], home.dir);
    expect(again.json?.notice).toBe("refunds is built here now, no longer open for the teams.");
    expect(recordAt(home, "refunds")?.json).toEqual(claim);
  });

  test("every Unit taken: the clone hears who builds each and where, and none of the home's work is offered", () => {
    const dependencies = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
      "  - name: checkout-ui\n    depends_on: []\n```\n";
    const home = homeWithTeams(dependencies);
    expect(takeFrom("payments", cloneOf(home.remote, "alice"), "refunds").status).toBe(0);
    expect(take(cloneOf(home.remote, "wen"), "checkout-ui").status).toBe(0);
    const dana = cloneOf(home.remote, "dana");
    inSpace(dana, "data");
    const step = next(dana);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(offerText(step.narration)).toBe(
      "fixture is shared in app. Being built: refunds (by alice in payments), checkout-ui (by wen). Nothing is ready to take yet.",
    );
  });

  test("a Unit asked here while its record could not be written gets it at the walk's first start: a teammate's look and take hear who builds it", () => {
    const home = homeWithTeams();
    // The lead asks to build checkout-ui here while its record's repository takes no push: the teams cannot see it yet.
    refuseRecords(home.hosts.app);
    const here = run(UNIT, ["assign", "--here", "checkout-ui"], home.dir);
    expect(here.status, here.out).toBe(0);
    expect(String(here.json?.notice)).toStartWith("checkout-ui is built here now. Its record in app could not be written (");
    expect(String(here.json?.notice)).toEndWith("), so a teammate could still take it meanwhile.");
    takePushes(home.hosts.app);
    const step = next(home.dir);
    expect(step.unit, JSON.stringify(step)).toBe("checkout-ui");
    const started = run(STATE, ["unit", "start", "--stage", "functional-design", "--unit", "checkout-ui"], home.dir);
    expect(started.status, started.out).toBe(0);
    expect(recordJson(home, "checkout-ui")).toMatchObject({ status: "claimed", owner: "default", taken_by: "lead" });
    commitAll(home.dir, "checkout-ui started");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const carol = cloneOf(home.remote, "carol");
    const ask = next(carol);
    expect(String(ask.question)).toContain("Being built: checkout-ui (by lead).");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label).filter((label) => label.includes("checkout-ui"))).toEqual([]);
    const refused = takeFrom("web", carol, "checkout-ui");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("checkout-ui is already taken: lead builds it");
  });

  test("a take whose team.md names a branch the lead's project lacks takes from the plan, never that branch", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const teamMd = join(alice, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(teamMd, readFileSync(teamMd, "utf-8").replace("## Way of Working\n", "## Way of Working\n\nIntegration branch: `develop`.\n"));
    const took = takeFrom("payments", alice, "refunds");
    expect(took.status, took.out).toBe(0);
    expect(took.out).not.toContain("develop");
  });

  test("a teammate who takes before cloning the code repos: the build records the home's repos", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    const took = takeFrom("payments", alice, "refunds");
    expect(took.status, took.out).toBe(0);
    const row = readIntentRegistry(alice, "payments").find((entry) => entry.dirName === took.json?.record);
    expect(row?.repos).toEqual(["billing", "checkout-api"]);
  });
});

describe("builds in one workspace", () => {
  test("Carry on is offered for the person's own take on another computer; another person hears whose it is, and carries it on when they ask", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("data", alice, "refunds").status).toBe(0);
    commitAll(alice, "refunds build");
    git(alice, ["push", "-q", "origin", "main"]);
    // The same person on a second computer, by their git name.
    const laptop = cloneOf(home.remote, "alice-laptop");
    git(laptop, ["config", "user.name", "alice"]);
    const offer = next(laptop);
    const carry = (offer.choices as Array<{ label: string; detail?: string }>).find((choice) => choice.label === "Carry on refunds");
    expect(carry?.detail, JSON.stringify(offer)).toBe("Your build of it in the data space, from another computer.");
    const resumed = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts.app], laptop);
    expect(resumed.json?.notice, resumed.out).toBe("Carrying on refunds, your build in the data space.");
    // Another person is told whose build it is, never offered it.
    const bob = cloneOf(home.remote, "bob");
    const theirs = next(bob);
    expect((theirs.choices as Array<{ label: string }>).map((choice) => choice.label)).not.toContain("Carry on refunds");
    expect(String(theirs.question ?? theirs.narration)).toContain("Being built: refunds (being built by alice in data, on another computer).");
    // Asked for in their own words, it is carried on, said once whose it is.
    const asked = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts.app], bob);
    expect(asked.json?.notice, asked.out).toBe("Carrying on refunds, alice's build in the data space.");
    expect(`${JSON.stringify(offer)}${resumed.out}${JSON.stringify(theirs)}${asked.out}`).not.toMatch(/the \w+ team|for the data|team's build/);
  });

  // A live run on Codex (a teammate's status): 'Also open' named the lead's
  // plan and a teammate's build a pull brought, each offered to switch to.
  test("a teammate's status lists her own builds, never another person's a pull brought or the lead's plan; the lead's lists no teammate's build", () => {
    const home = makeHome({ dependencies: DEPENDENCIES.replace("depends_on: [refunds]", "depends_on: []") });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alsoOpen = (dir: string): string | null => {
      const status = run(UTILITY, ["status"], dir);
      expect(status.status, status.out).toBe(0);
      return /^Also open: +(.*)$/m.exec(status.out)?.[1] ?? null;
    };
    // Her own build of reporting, made on her other computer under her git name.
    const laptop = cloneOf(home.remote, "ana-laptop");
    git(laptop, ["config", "user.name", "ana"]);
    expect(take(laptop, "reporting").status).toBe(0);
    commitAll(laptop, "reporting build");
    git(laptop, ["push", "-q", "origin", "main"]);
    const bea = cloneOf(home.remote, "bea");
    expect(take(bea, "checkout-ui").status).toBe(0);
    commitAll(bea, "checkout-ui build");
    git(bea, ["push", "-q", "origin", "main"]);
    const ana = cloneOf(home.remote, "ana");
    expect(take(ana, "refunds").status).toBe(0);
    expect(alsoOpen(ana)).toBe(`${basename(buildDir(ana, "default", "reporting"))} (ask to switch to it)`);
    // The lead's own checkout after a pull: its status reads the claims at the lead's project first, so the teammates' builds are theirs.
    git(home.dir, ["fetch", "-q", "origin"]);
    git(home.dir, ["merge", "-q", "--no-edit", "origin/main"]);
    expect(alsoOpen(home.dir)).toBeNull();
  });

  test("the build's Code Generation is told its code goes in the Unit's repos, beside the files of theirs it leaves alone", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    const state = join(buildDir(alice, "payments", "refunds"), "aidlc-state.md");
    writeFileSync(state, readFileSync(state, "utf-8")
      .replace(/^- \[[ -]\] functional-design /m, "- [x] functional-design ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    const step = next(alice);
    expect(step.stage, JSON.stringify(step)).toBe("code-generation");
    expect(String(step.brought_files_note)).toContain(
      "This Unit's code goes in billing and checkout-api: write each of its files inside the folder of the repo it belongs to, and name its repo in the source manifest.",
    );
  });

  // The lead's approved documents carry the lead's own layout (`../api` beside
  // the lead's folder), while a team's clone of a repository may sit inside its
  // workspace, or not be there at all: each step that hands work to an agent
  // says where each of the build's repositories is here, so a reviewer reads
  // there instead of searching outside the workspace.
  function buildAtItsWave(
    local?: (alice: string, hosts: Record<string, string>) => void,
    afterTake?: (alice: string) => void,
  ): { alice: string; wave: Record<string, unknown> } {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    planShared(home);
    const alice = cloneOf(home.remote, "alice");
    if (local === undefined) cloneCode(hosts["checkout-api"], alice, "checkout-api", "alice");
    else local(alice, hosts);
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    afterTake?.(alice);
    let asked = next(alice);
    // A repository the build records and this workspace has no clone of is
    // offered once; the person's Not now runs nothing, and the step goes on.
    if (asked.ask_type === "unit-clone") asked = next(alice);
    expect(asked.questions_only, JSON.stringify(asked)).toBe(true);
    const questions = join(buildDir(alice, "payments", "refunds"), "construction", "refunds", "functional-design", "functional-design-questions.md");
    mkdirSync(dirname(questions), { recursive: true });
    writeFileSync(questions, "# Functional Design Questions\n\nNo questions: the requirements settle this Unit.\n");
    const wave = next(alice);
    expect(wave.wave, JSON.stringify(wave)).toBeDefined();
    return { alice, wave };
  }
  const REPOS_LAYOUT = "A path for a repository in this work's documents may be from another layout: use the ones above.";

  test("the build's wave says where each of its repositories is here: one cloned inside it, one not here", () => {
    const { wave } = buildAtItsWave();
    expect(String(wave.brief_note)).toMatch(
      new RegExp(`Protocol modules: [^.]*\\. Here, the repository checkout-api is the folder checkout-api in this workspace; billing is not cloned here\\. ${REPOS_LAYOUT.replace(/[.:]/g, "\\$&")}`),
    );
  });

  test("both repositories cloned inside the workspace: each by its folder there", () => {
    const { wave } = buildAtItsWave((alice, hosts) => {
      for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    });
    expect(String(wave.brief_note)).toContain(
      `Here, the repository billing is the folder billing in this workspace and checkout-api is the folder checkout-api in it. ${REPOS_LAYOUT}`,
    );
  });

  // The build's own record of its repositories, with the workspace's own
  // repository (named by a dot) beside them.
  function recordsWorkspaceToo(alice: string, only = false): void {
    const entry = join(buildDir(alice, "payments", "refunds"), "aidlc-intent.json");
    const row = JSON.parse(readFileSync(entry, "utf-8")) as { repos?: string[] };
    expect(row.repos, JSON.stringify(row)).toBeDefined();
    row.repos = only ? ["."] : [".", ...row.repos!];
    writeFileSync(entry, `${JSON.stringify(row, null, 2)}\n`);
  }

  test("the workspace's own repository, named by a dot, is left out: the agent is in that folder already", () => {
    const { wave } = buildAtItsWave(undefined, (alice) => recordsWorkspaceToo(alice));
    expect(String(wave.brief_note)).toContain(
      `Here, the repository checkout-api is the folder checkout-api in this workspace; billing is not cloned here. ${REPOS_LAYOUT}`,
    );
    const only = buildAtItsWave(undefined, (alice) => recordsWorkspaceToo(alice, true));
    expect(String(only.wave.brief_note)).not.toContain("Here, ");
  });

  test("no repository of the build cloned here: the sentence ends at the other layout, with nothing above to use", () => {
    const { wave } = buildAtItsWave(() => {});
    expect(String(wave.brief_note)).toContain(
      "Here, the repositories billing and checkout-api are not cloned here. A path for a repository in this work's documents may be from another layout.",
    );
    expect(String(wave.brief_note)).not.toContain("use the ones above");
  });

  test("a repository repos.local.json puts outside the workspace is named by its full path", () => {
    let outside = "";
    const { wave } = buildAtItsWave((alice, hosts) => {
      outside = cloneCode(hosts.billing, join(alice, ".."), "billing-mine", "alice");
      cloneCode(hosts["checkout-api"], alice, "checkout-api", "alice");
      writeFileSync(join(alice, "aidlc", "repos.local.json"), `${JSON.stringify({ repos: [{ name: "billing", path: "../billing-mine" }] })}\n`);
    });
    expect(String(wave.brief_note)).toContain(
      `Here, the repository billing is the folder ${outside.replaceAll("\\", "/")}, outside this workspace and checkout-api is the folder ` +
        `checkout-api in this workspace. ${REPOS_LAYOUT}`,
    );
  });

  test("a change to the Units asked in a Unit's build keeps the composer: the Unit plan is the home's", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    const step = next(alice, ENV, ["compose", "--unit-plan"]);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("unit-plan-change");
    expect(String(step.message)).toContain("Dispatch the composer agent");
  });

  test("two builds started at once in one space share no file: the second pull has no conflict", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const bob = cloneOf(home.remote, "bob");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    expect(takeFrom("payments", bob, "checkout-ui").status).toBe(0);
    commitAll(alice, "refunds build");
    commitAll(bob, "checkout-ui build");
    git(alice, ["push", "-q", "origin", "main"]);
    const pulled = spawnSync("git", ["pull", "--no-rebase", "--no-edit", "-q", "origin", "main"], { cwd: bob, encoding: "utf-8", env: GIT_ENV });
    expect(pulled.status, pulled.stderr).toBe(0);
    expect(readIntentRegistry(bob, "payments").map((row) => row.slug).sort()).toEqual(["checkout-ui", "refunds"]);
  });

  test("the next day, another clone of the workspace carries the build on, in the chat open on it", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds").status).toBe(0);
    commitAll(alice, "refunds build");
    git(alice, ["push", "-q", "origin", "main"]);
    const laptop = cloneOf(home.remote, "alice-laptop");
    git(laptop, ["config", "user.name", "alice"]);
    // The chat Claude Code names in the agent's shell; no session start ran in this clone.
    const chat: NodeJS.ProcessEnv = { ...ENV, CLAUDE_CODE_SESSION_ID: "5b6f0c1e-1d2a-4c3b-9e4f-0a1b2c3d4e5f", CLAUDE_PID: String(process.pid) };
    const ask = next(laptop, chat);
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toContain("Carry on refunds");
    const resumed = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts.app], laptop, chat);
    expect(resumed.status, resumed.out).toBe(0);
    expect(resumed.json).toMatchObject({ resumed: true });
    // The line is the person's: it comes with the build's next step in this chat.
    expect(resumed.json?.notice).toBeUndefined();
    const step = next(laptop, chat);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("refunds");
    expect((step.change_notices ?? []) as string[], JSON.stringify(step)).toContain("Carrying on refunds, your build in the payments space.");
  });
});

describe("a team's own workspace, made from the home's", () => {
  test("the home's copied work is never offered to carry on; its Units are, reached by the home's address", () => {
    const home = homeWithTeams();
    // The lead's checkout made the plan, as its record says.
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "the lead's checkout");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const web = teamWorkspace(home.remote, "web");
    const ask = next(web);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(offerText(ask.question)).toStartWith("fixture is shared in app.");
    expect(String(ask.question)).toContain("checkout-ui (open; likely checkout-web)");
    const labels = (ask.choices as Array<{ label: string }>).map((choice) => choice.label);
    expect(labels).toEqual(["Start refunds", "Start checkout-ui"]);
    const remotes = git(web, ["remote"]);
    const took = takeFrom("web", web, "checkout-ui");
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ team: "web", space: "web" });
    // The lead's project is reached, so the take is recorded there, before any claim is, with nothing said.
    expect(took.out).not.toContain("could not be reached");
    // No remote added: the home is reached by its address, into AI-DLC's own refs.
    expect(git(web, ["remote"])).toBe(remotes);
    expect(git(web, ["for-each-ref", "--format=%(refname)", "refs/aidlc/home/"])).toContain(`/${home.id8}/`);
    expect(recordAt(home, "checkout-ui")?.json).toMatchObject({ owner: "web", taken_by: "web" });
    expect(next(web).unit).toBe("checkout-ui");
  });

  // A live run (M2b): the team's workspace was the lead's clone with its origin
  // switched; the claim refs the clone kept sent the take to the team's repo.
  test("a clone of the lead's workspace pointed at the team's own repo claims at the lead's project", () => {
    const home = homeWithTeams();
    const web = cloneOf(home.remote, "web");
    git(web, ["fetch", "-q", "origin", "+refs/aidlc/claims/*:refs/aidlc/remotes/origin/claims/*"]);
    const host = tempDir("web-host");
    git(host, ["init", "-q", "--bare", "-b", "main"]);
    git(web, ["remote", "set-url", "origin", host]);
    git(web, ["push", "-q", "origin", "main"]);
    const took = takeFrom("web", web, "checkout-ui");
    expect(took.status, took.out).toBe(0);
    expect(recordAt(home, "checkout-ui")?.json).toMatchObject({ owner: "web", taken_by: "web" });
    expect(git(host, ["for-each-ref", "--format=%(refname)", "refs/aidlc/claims/", "refs/heads/claim/"])).toBe("");
  });

  // A recorded address git would read as an option is never passed to git.
  test("a recorded lead's address that starts with '-' is refused before any git call reads it", () => {
    const home = homeWithTeams();
    const web = cloneOf(home.remote, "web");
    const other = tempDir("web-other");
    git(other, ["init", "-q", "--bare", "-b", "main"]);
    git(web, ["remote", "set-url", "origin", other]);
    git(web, ["push", "-q", "origin", "main"]);
    const statePath = join(web, "aidlc", "spaces", "default", "intents", HOME, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \*\*Home Location\*\*: .*$/m, "- **Home Location**: --upload-pack=touch /tmp/aidlc-no"));
    const looked = run(ORCH, ["next"], web);
    expect(String(looked.json?.error), looked.out).toContain('starts with "-"');
    // The same address typed for a take.
    inSpace(web, "payments");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from=--upload-pack=touch /tmp/aidlc-no"], web);
    expect(took.status).not.toBe(0);
    expect(String(took.json?.error)).toContain('starts with "-"');
    expect(existsSync("/tmp/aidlc-no")).toBe(false);
  });

  // A live run: the line sat at the end of the take's own line, and the
  // agent's reply said the take in its own words without it. In a chat it is a
  // line of its own, kept for the reply the turn ends on.
  test("a home that takes no push from here, from a chat: its line is its own, kept for the reply, and the next step carries it", () => {
    const home = homeWithTeams();
    refuseRecords(home.hosts.app);
    const pay = teamWorkspace(home.remote, "pay", true);
    const session = "6c7a1d2f-2e3b-4d4c-8f5a-1b2c3d4e5f60";
    const chat: NodeJS.ProcessEnv = { ...ENV, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid) };
    inSpace(pay, "payments");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts.app], pay, chat);
    expect(took.status, took.out).toBe(0);
    expect(took.json?.notice).toBeUndefined();
    const line = "app takes no push from you (this host takes no push from here (pre-receive hook declined)), so your take of refunds " +
      "is not written there, and someone else could still take it.";
    const kept = JSON.parse(readFileSync(join(pay, "aidlc", ".aidlc-engine", "sessions", `${session}.person-lines`), "utf-8")) as {
      lines: Array<{ line: string; reply?: boolean }>;
    };
    expect(kept.lines.find((entry) => entry.line === line)?.reply, JSON.stringify(kept)).toBe(true);
    expect(kept.lines.some((entry) => entry.line !== line && entry.line.includes("takes no push from here"))).toBe(false);
    const step = next(pay, chat);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step)).toContain(line);
  });

  test("a home that takes no push from here: the take goes on, with one line naming git's reason", () => {
    const open = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n  - name: reporting\n    depends_on: []\n```\n";
    const home = homeWithTeams(open);
    refuseRecords(home.hosts.app);
    const pay = teamWorkspace(home.remote, "pay", true);
    const held = takeFrom("payments", pay, "refunds");
    expect(held.status, held.out).toBe(0);
    expect(String(held.json?.notice)).toContain(
      "app takes no push from you (this host takes no push from here (pre-receive hook declined)), so your take of refunds " +
        "is not written there, and someone else could still take it.",
    );
    expect(existsSync(join(buildDir(pay, "payments", "refunds"), "aidlc-state.md"))).toBe(true);
    expect(recordAt(home, "refunds")?.json?.taken_by).toBeUndefined();
    const openUnit = takeFrom("payments", pay, "reporting");
    expect(openUnit.status, openUnit.out).toBe(0);
    expect(String(openUnit.json?.notice)).toContain("so your take of reporting is not written there, and someone else could still take it.");
    expect(recordAt(home, "reporting")).toBeNull();
  });
});

// A probe of teams that push to a fork of the lead's project: the claims went
// where the lead never reads them, the take said the Unit was theirs, and the
// lead's board never showed it. The claims' home is the lead's address; a write
// read back there that is not there is said with today's no-push line.
describe("the claims' home is the lead's address", () => {
  const three = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
    "  - name: checkout-ui\n    depends_on: []\n  - name: reporting\n    depends_on: []\n```\n";
  test("a clone whose own remote does not answer, while the lead's project does: the take asks the lead's project, never a raw git error", () => {
    const home = homeWithTeams(three);
    const web = cloneOf(home.remote, "web");
    expect(takeFrom("web", web, "checkout-ui").status).toBe(0);
    const pay = cloneOf(home.remote, "pay");
    refuseRecords(home.hosts.app);
    git(pay, ["remote", "set-url", "origin", join(tempDir("gone"), "pay-fork.git")]);
    const held = takeFrom("payments", pay, "refunds");
    expect(held.out).not.toContain("Unit claim registry read failed");
    expect(held.status, held.out).toBe(0);
    expect(String(held.json?.notice)).toContain(
      "app takes no push from you (this host takes no push from here (pre-receive hook declined)), so your take of refunds " +
        "is not written there",
    );
  });

  // The lead's words for a lost race at the lead's project: what changed is not
  // named, nor whose the Unit is; the send again goes through.
  test("a result whose claim at the lead's project changed while it was sent: said so, and sent again", () => {
    const { home, hosts, alice, record } = refundsTaken();
    const id8 = fixtureIntentId8(home.dir);
    // Another write on the Unit's record while the code goes out, once.
    const hook = join(hosts["checkout-api"], "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\ncat >/dev/null\nunset GIT_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH\n" +
      `home='${hosts["checkout-api"]}'; ref=refs/aidlc/claims/${id8}/refunds\n` +
      "[ -e \"$home/moved-once\" ] && exit 0\ntouch \"$home/moved-once\"\n" +
      "tip=$(git --git-dir=\"$home\" rev-parse \"$ref\") || exit 0\ntree=$(git --git-dir=\"$home\" rev-parse \"$tip^{tree}\")\n" +
      "new=$(git --git-dir=\"$home\" -c user.name=lead -c user.email=lead@example.test commit-tree \"$tree\" -p \"$tip\" -m moved)\n" +
      "git --git-dir=\"$home\" update-ref \"$ref\" \"$new\" \"$tip\"\nexit 0\n");
    chmodSync(hook, 0o755);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice ?? pushed.out);
    expect(said).toContain(
      "checkout-api did not take refunds's result: its record there changed while it was being sent. Do you want me to send it again?",
    );
    expect(said).not.toContain("moved meanwhile");
    expect(recordJson(home, "refunds")?.result).toBeUndefined();
    // A send again can go through: the next step offers it, as ever.
    finishBuild(record);
    const offer = next(alice, chatOf("alice-race"));
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-push");
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(recordJson(home, "refunds")?.result).toBeDefined();
  });

});

// A take whose likely repo is not checked out yet, where repos.json has its
// address (x2783-s9): the take offers to clone it where repos.json puts it, and
// the offer's own command clones it, the Unit's repos as they were.
describe("a likely repo this workspace has no copy of", () => {
  // A live run on opencode: the take's output carried the offer to clone a
  // repo not checked out here, the agent went straight on to the build's first
  // stage, and the person never heard it; Code Generation cloned it itself.
  test("the build's next step offers to clone it from repos.json, once, and the offer's command clones it there", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const alice = cloneOf(home.remote, "alice");
    cloneCode(hosts["checkout-api"], alice, "checkout-api", "alice");
    const took = takeIn("payments", ["refunds", "--plan", plan.id8, "--from", Object.values(plan.hosts)[0]], alice);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).not.toContain("Do you want me to clone");
    expect(took.json?.offer).toBeUndefined();
    const offer = next(alice);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 500)).toBe("unit-clone");
    expect(String(offer.question)).toBe("billing is not at billing in this workspace yet. Do you want me to clone it there?");
    expect(String(offer.question)).not.toContain("give its path in aidlc/repos.local.json");
    const choices = offer.choices as Array<{ label: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Clone billing", "Not now"]);
    expect(choices[0].command).toEndWith("aidlc-utility.ts intent add-repo billing");
    // Asked once: the next step goes on to the build.
    expect(next(alice).ask_type ?? null).not.toBe("unit-clone");
    const cloned = run(UTILITY, ["intent", "add-repo", "billing"], alice);
    expect(cloned.status, cloned.out).toBe(0);
    expect(cloned.out).toContain(`Cloned billing from ${hosts.billing} to billing; it was already one of this piece of work's repos.`);
    expect(existsSync(join(alice, "billing", "README.md"))).toBe(true);
    const row = readIntentRegistry(alice, "payments").find((entry) => entry.dirName === took.json?.record);
    expect(row?.repos).toEqual(["billing", "checkout-api"]);
  });

  test("with their repos.local.json unreadable, the take says so and offers no clone: their own copy may be elsewhere", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const alice = cloneOf(home.remote, "alice");
    const mine = tempDir("alice-code");
    cloneCode(hosts["checkout-api"], mine, "api", "alice");
    // Their own path for checkout-api, with a slip: a trailing comma.
    writeFileSync(join(alice, "aidlc", "repos.local.json"), `{ "repos": [ { "name": "checkout-api", "path": ${JSON.stringify(join(mine, "api"))} }, ] }\n`);
    const took = takeIn("payments", ["refunds", "--plan", plan.id8, "--from", Object.values(plan.hosts)[0]], alice);
    expect(took.status, took.out).toBe(0);
    const notice = String(took.json?.notice);
    expect(notice).toContain("repos.local.json is not valid JSON");
    expect(notice).toContain(
      "Your own paths in it are not used until it reads, so checkout-api and billing are looked for where repos.json puts them for now.",
    );
    expect(notice).not.toContain("Do you want me to clone");
    expect(took.json?.offer).toBeUndefined();
  });

  test("on Codex, a take whose repos sit beside the workspace names Codex's own step to let it write there, and changes no setting", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const alice = cloneOf(home.remote, "alice");
    // Her own copies live beside the workspace, as her repos.local.json says.
    for (const name of ["checkout-api", "billing"]) cloneCode(hosts[name as "billing"], join(alice, ".."), `${name}-mine`, "alice");
    writeFileSync(join(alice, "aidlc", "repos.local.json"), `${JSON.stringify({ repos: [
      { name: "checkout-api", path: "../checkout-api-mine" },
      { name: "billing", path: "../billing-mine" },
    ] })}\n`);
    const onCodex = takeIn("payments", ["refunds", "--plan", plan.id8, "--from", Object.values(plan.hosts)[0]], alice, { ...ENV, AIDLC_HARNESS_NAME: "codex" });
    expect(onCodex.status, onCodex.out).toBe(0);
    expect(String(onCodex.json?.notice)).toContain(
      "Codex writes only inside this folder unless you start it with the others: to let it write in ../checkout-api-mine " +
        "and ../billing-mine, start Codex here with `codex --add-dir ../checkout-api-mine --add-dir ../billing-mine`.",
    );
    expect(existsSync(join(alice, ".codex", "config.toml"))).toBe(false);
  });

  test("on another host, or with every repo inside the workspace, nothing is said about Codex", () => {
    const { took } = (() => {
      const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
      const home = makeHome({ repos: hosts });
      expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
      git(home.dir, ["add", "-A"]);
      git(home.dir, ["commit", "-q", "-m", "teams"]);
      git(home.dir, ["push", "-q", "origin", "main"]);
      const plan = planShared(home);
      const alice = cloneOf(home.remote, "alice");
      for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
      return { took: takeIn("payments", ["refunds", "--plan", plan.id8, "--from", Object.values(plan.hosts)[0]], alice, { ...ENV, AIDLC_HARNESS_NAME: "codex" }) };
    })();
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).not.toContain("--add-dir");
  });
});


// A live run on Codex: a teammate cloned the lead's workspace while its remote
// held only the setup commit and the Units held for teams. Their first $aidlc
// was told "Tell me what to build" and wrote AI-DLC's parts of .gitignore and
// AGENTS.md there, which the lead's share then met: their git pull aborted.
describe("a teammate's clone before the lead's project shared its plan", () => {
  const RISK = "The lead's plan has not reached this clone yet";

  function leadNotSharedYet(repos: Record<string, string>) {
    const home = makeHome({ repos });
    // The remote holds the install alone; the lead's record and root files are only in the lead's workspace.
    const install = [".codex", ".agents"];
    for (const name of install) cpSync(join(REPO_ROOT, "dist", "codex", name), join(home.dir, name), { recursive: true });
    git(home.dir, ["rm", "-r", "-q", "--cached", "aidlc", ".gitignore"]);
    git(home.dir, ["add", ...install]);
    git(home.dir, ["commit", "-q", "-m", "setup"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    hostFor("codex", home.dir, GIT_ENV).sessionStart("startup");
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    // A claim at the lead's remote before the plan is shared, as an earlier
    // release pushed when the lead built a Unit here (building one here before
    // the share pushes nothing now): made on a shared copy of the same work.
    const donor = makeHome({ repos });
    expect(run(STATE, ["set-unit-ownership", "team"], donor.dir).status).toBe(0);
    expect(run(UNIT, ["share", "--plan"], donor.dir).status).toBe(0);
    const here = run(UNIT, ["assign", "--here", "checkout-ui"], donor.dir);
    expect(here.status, here.out).toBe(0);
    // The donor's record is in the repository the plan names for checkout-ui, here the plan's own.
    git(home.remote, ["fetch", "-q", Object.values(repos)[0], "+refs/aidlc/claims/*:refs/heads/claim/*"]);
    expect(git(home.remote, ["for-each-ref", "--format=%(refname)", "refs/heads/claim/"])).not.toBe("");
    const bob = cloneOf(home.remote, "bob");
    const host = hostFor("codex", bob, GIT_ENV);
    host.sessionStart("startup");
    return { home, bob, host, orch: join(bob, ".codex", "tools", "aidlc-orchestrate.ts") };
  }

  test("the first chat writes no root file, and once the lead shares the plan its Units are reached by the plan's repository's address", () => {
    const repos = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const { home, bob, orch } = leadNotSharedYet(repos);
    expect(git(bob, ["status", "--porcelain", "--", ".gitignore", "AGENTS.md"])).toBe("");
    const first = next(bob, ENV, [], orch);
    expect(JSON.stringify(first)).not.toContain("git pull");
    // The lead's own checkout, with its record, is never read as such a clone.
    expect(leadsPlanNotHere(bob)).toBe(true);
    expect(leadsPlanNotHere(home.dir)).toBe(false);
    // AI-DLC's own working files ignore themselves from inside aidlc/: git shows them nothing, and a commit of
    // everything sweeps none of them in.
    expect(existsSync(join(bob, "aidlc", ".gitignore"))).toBe(true);
    expect(git(bob, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(git(bob, ["add", "-A", "--dry-run"])).toBe("");
    const plan = planShared(home);
    // The plan's repository's address said: its Units are offered, and the take reads the plan there.
    const offer = next(bob, ENV, ["--lead-address", repos["checkout-api"]], orch);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 600)).toBe("unit-take");
    const took = takeIn("payments", ["refunds", "--plan", plan.id8, "--from", repos["checkout-api"]], bob);
    expect(took.status, took.out).toBe(0);
    // The teammate's own build record shows and commits as anywhere.
    const state = join(buildDir(bob, "payments", "refunds"), "aidlc-state.md");
    expect(spawnSync("git", ["check-ignore", "-q", state], { cwd: bob }).status).toBe(1);
    expect(git(bob, ["status", "--porcelain", "--untracked-files=all"])).toContain("aidlc/spaces/payments/");
  });

  // The lead's record reaches the shared workspace's main: the lead commits and pushes it there.
  function planPulled(home: { dir: string }, bob: string): void {
    git(home.dir, ["add", "aidlc"]);
    git(home.dir, ["commit", "-q", "-m", "the lead's record"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const pulled = spawnSync("git", ["pull", "-q"], { cwd: bob, encoding: "utf-8", env: GIT_ENV });
    expect(pulled.status, pulled.stderr).toBe(0);
  }

  test("AI-DLC's own aidlc/.gitignore goes once the next chat writes AI-DLC's root part; one someone changed stays", () => {
    const { home, bob, host } = leadNotSharedYet({ "checkout-api": codeHost("checkout-api") });
    const own = join(bob, "aidlc", ".gitignore");
    planPulled(home, bob);
    expect(existsSync(own)).toBe(true);
    host.newSession();
    host.sessionStart("startup");
    expect(existsSync(own)).toBe(false);
    expect(git(bob, ["status", "--porcelain", "--untracked-files=all"])).not.toContain("aidlc/");
    const theirs = leadNotSharedYet({ "checkout-api": codeHost("checkout-api") });
    const changed = join(theirs.bob, "aidlc", ".gitignore");
    writeFileSync(changed, `${readFileSync(changed, "utf-8")}/my-notes/\n`);
    planPulled(theirs.home, theirs.bob);
    theirs.host.newSession();
    theirs.host.sessionStart("startup");
    expect(readFileSync(changed, "utf-8")).toEndWith("/my-notes/\n");
  });

  test("in the same chat, a pull that brings AI-DLC's root part ends AI-DLC's own aidlc/.gitignore at the next step", () => {
    const { home, bob, orch } = leadNotSharedYet({ "checkout-api": codeHost("checkout-api") });
    planPulled(home, bob);
    // The lead keeps its root .gitignore, AI-DLC's part in it, in git; the teammate pulls it without a new chat.
    git(home.dir, ["add", ".gitignore"]);
    git(home.dir, ["commit", "-q", "-m", "keep the root .gitignore"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const pulled = spawnSync("git", ["pull", "-q"], { cwd: bob, encoding: "utf-8", env: GIT_ENV });
    expect(pulled.status, pulled.stderr).toBe(0);
    next(bob, ENV, [], orch);
    expect(existsSync(join(bob, "aidlc", ".gitignore"))).toBe(false);
    expect(git(bob, ["status", "--porcelain", "--untracked-files=all"])).not.toContain("aidlc/");
  });

  // The lead shares the plan by pull request: it waits on its own branch, with no Unit built here, so no claim is
  // anywhere for a clone to tell by; or the lead pushed it to main and this clone fetched it without pulling.
  function planWaitsElsewhere(repos: Record<string, string>, where: "its own branch" | "main, fetched") {
    const home = makeHome({ repos });
    const install = [".codex", ".agents"];
    for (const name of install) cpSync(join(REPO_ROOT, "dist", "codex", name), join(home.dir, name), { recursive: true });
    git(home.dir, ["rm", "-r", "-q", "--cached", "aidlc", ".gitignore"]);
    git(home.dir, ["add", ...install]);
    git(home.dir, ["commit", "-q", "-m", "setup"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    hostFor("codex", home.dir, GIT_ENV).sessionStart("startup");
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const early = where === "main, fetched" ? cloneOf(home.remote, "bob") : null;
    // The lead's record committed and pushed: on the plan's own branch for its pull request, or on main.
    if (where === "its own branch") git(home.dir, ["switch", "-q", "-c", "aidlc-plan"]);
    git(home.dir, ["add", "aidlc"]);
    git(home.dir, ["commit", "-q", "-m", "the lead's record"]);
    git(home.dir, ["push", "-q", "origin", "HEAD"]);
    expect(git(home.remote, ["for-each-ref", "--format=%(refname)", "refs/heads/claim/", "refs/aidlc/claims/"])).toBe("");
    if (early !== null) git(early, ["fetch", "-q", "origin"]);
    const bob = early ?? cloneOf(home.remote, "bob");
    const host = hostFor("codex", bob, GIT_ENV);
    if (early === null) host.sessionStart("startup");
    return { home, bob, orch: join(bob, ".codex", "tools", "aidlc-orchestrate.ts") };
  }

  test("the plan on its own branch, its pull request open and no claim anywhere: the first chat writes no root file", () => {
    const { bob, orch } = planWaitsElsewhere({ "checkout-api": codeHost("checkout-api") }, "its own branch");
    expect(git(bob, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"])).toMatch(/refs\/remotes\/origin\/aidlc-plan/);
    expect(leadsPlanNotHere(bob)).toBe(true);
    expect(git(bob, ["status", "--porcelain", "--", ".gitignore", "AGENTS.md"])).toBe("");
    next(bob, ENV, [], orch);
    expect(git(bob, ["status", "--porcelain", "--", ".gitignore", "AGENTS.md"])).toBe("");
  });

  test("the plan in the lead's main, fetched here and not pulled: still not here", () => {
    const { bob } = planWaitsElsewhere({ "checkout-api": codeHost("checkout-api") }, "main, fetched");
    expect(leadsPlanNotHere(bob)).toBe(true);
  });

  // Only the lead's plan is waited for: a person's own solo record on the remote's main, with this clone on a branch
  // from before it, is their own work, not a lead's.
  test("a clone on a branch older than its own solo record on main is not told the lead's plan has not reached it", () => {
    const home = makeHome({ repos: {} });
    const bob = cloneOf(home.remote, "bob");
    git(bob, ["switch", "-q", "-c", "older", git(bob, ["commit-tree", git(bob, ["mktree"]), "-m", "before the work"])]);
    expect(existsSync(join(bob, "aidlc", "spaces"))).toBe(false);
    expect(leadsPlanNotHere(bob)).toBe(false);
  });

  test("a teammate's words there go on as their request, with no line about a plan this clone has not pulled", () => {
    const { bob, orch } = leadNotSharedYet({ "checkout-api": codeHost("checkout-api") });
    const words = next(bob, ENV, ["build a refunds report for finance"], orch);
    expect(JSON.stringify(words)).not.toContain(RISK);
    expect(String(words.message), JSON.stringify(words).slice(0, 600)).toContain("build a refunds report for finance");
  });
});

// A live run (x2783-s9, Copilot CLI): "We're the storefront team. Can we take
// the refund API instead?" took the payments crew's Unit, held for them by the
// lead, as theirs; "give it back" was refused in the build, and the agent freed
// the Unit at the lead's project, so the lead's hold was gone.
describe("the way back from a take, and the lead's release", () => {

  test("give back in the build: the Unit is open again, the build's record is kept, and the person stays in their space with the Units offered again", () => {
    const home = homeWithTeams();
    const sam = cloneOf(home.remote, "sam");
    const took = takeFrom("payments", sam, "refunds");
    expect(took.status, took.out).toBe(0);
    // Said once, where the take is.
    expect(String(took.json?.notice)).toContain(" If it is not your team's to build, tell me and I will hand it back.");
    const record = buildDir(sam, "payments", "refunds");
    const back = run(UNIT, ["release", "refunds"], sam);
    expect(back.status, back.out).toBe(0);
    expect(back.json?.notice).toBe(
      "refunds is given back. Written on its record in app. Its build here is set aside, with everything in it kept.",
    );
    expect(recordAt(home, "refunds")?.json).toMatchObject({ status: "released" });
    // Nothing of the build is deleted: its record is set aside.
    const state = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    expect(field(state, "Status")).toBe("Archived");
    expect(field(state, "Unit Build")).toBe("refunds");
    // The person stays in the space they took it from, and their words there are read against the Units again.
    expect(readFileSync(join(sam, "aidlc", "active-space"), "utf-8").trim()).toBe("payments");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "sam-chat" };
    const words = next(sam, chat, ["what else is there to take?"]);
    expect(String(words.message), JSON.stringify(words).slice(0, 400)).toContain("Start refunds: `");
    const offer = next(sam, chat);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 400)).toBe("unit-take");
    const labels = (offer.choices as Array<{ label: string }>).map((choice) => choice.label);
    expect(labels).toContain("Start refunds");
    expect(labels).not.toContain("Carry on refunds");
    // Anyone takes it now, from where they are.
    const theirs = takeFrom("web", cloneOf(home.remote, "dora"), "refunds");
    expect(theirs.status, theirs.out).toBe(0);
    expect(recordAt(home, "refunds")?.json).toMatchObject({ status: "claimed", owner: "web", taken_by: "dora" });
  });

  // Their words may be new work of their own: read against the Units offer
  // and kept, so nobody says them twice.
  test("a teammate's first words in their own space, before any take there, are read against the Units offer and kept", () => {
    const home = homeWithTeams();
    const pat = cloneOf(home.remote, "pat");
    inSpace(pat, "pay");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "pat-chat" };
    const words = next(pat, chat, ["add a dark mode to the admin site"]);
    expect(words.kind, JSON.stringify(words).slice(0, 400)).toBe("print");
    const message = String(words.message);
    expect(message).toContain("Start refunds: `");
    const id = /next --request (\S+)`/.exec(message)?.[1];
    expect(id, message).toBeString();
    expect(JSON.stringify(next(pat, chat, ["--request", id!]))).toContain("add a dark mode to the admin site");
    const offer = next(pat, chat);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 400)).toBe("unit-take");
    expect((offer.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start refunds");
  });

  // The lead frees a Unit while its taker builds it: the build is still the
  // taker's own here, never "being built" by someone else.
  test("a build whose claim the lead freed is the taker's own to carry on, named by its own last hand", () => {
    const home = homeWithTeams();
    const bea = cloneOf(home.remote, "bea");
    expect(takeFrom("pay", bea, "refunds").status).toBe(0);
    const record = buildDir(bea, "pay", "refunds");
    appendAuditEntry("GATE_APPROVED", { Stage: "functional-design", "Git Name": "bea" }, bea, basename(record), "pay");
    expect(run(UNIT, ["release", "refunds"], home.dir).status).toBe(0);
    git(bea, ["fetch", "-q", "origin"]);
    // Her list of the Units, from the lead's work in the clone's default space.
    expect(run(UTILITY, ["space", "default"], bea).status).toBe(0);
    const offer = next(bea, { ...ENV, AIDLC_SESSION_OVERRIDE: "bea-chat" });
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 500)).toBe("unit-take");
    expect((offer.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Carry on refunds");
    expect(JSON.stringify(offer)).not.toContain("being built by");
    const carried = take(bea, "refunds");
    expect(carried.status, carried.out).toBe(0);
    expect(String(carried.json?.notice ?? "")).not.toContain("released");
  });

  test("the lead's release reopens a teammate's Unit, and the lead's own build here, started or not", () => {
    const home = homeWithTeams();
    git(home.dir, ["config", "user.name", "lee"]);
    expect(takeFrom("payments", cloneOf(home.remote, "sam"), "refunds").status).toBe(0);
    const released = run(UNIT, ["release", "refunds"], home.dir);
    expect(released.status, released.out).toBe(0);
    expect(takeFrom("web", cloneOf(home.remote, "dora"), "refunds").status).toBe(0);
    // The lead's own build here, started at the lead's project, then released.
    expect(run(UNIT, ["assign", "--here", "checkout-ui"], home.dir).status).toBe(0);
    const step = next(home.dir);
    expect(step.unit, JSON.stringify(step).slice(0, 400)).toBe("checkout-ui");
    const started = run(STATE, ["unit", "start", "--stage", "functional-design", "--unit", "checkout-ui"], home.dir);
    expect(started.status, started.out).toBe(0);
    commitAll(home.dir, "checkout-ui started");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const blocked = takeFrom("web", cloneOf(home.remote, "wen"), "checkout-ui");
    expect(blocked.out).toContain("checkout-ui is already taken: lee builds it.");
    expect(run(UNIT, ["release", "checkout-ui"], home.dir).status).toBe(0);
    // The lead's walk leaves it now, and a teammate takes it.
    const board = next(home.dir);
    expect(String(board.narration ?? ""), JSON.stringify(board).slice(0, 500)).toContain("- checkout-ui, open: waiting for a team to take it");
    const took = takeFrom("web", cloneOf(home.remote, "wes"), "checkout-ui");
    expect(took.status, took.out).toBe(0);
  });
});

// A take builds in the space the person works in, never one named after a
// team or a repo: team names change and people move between teams. A space
// the person asks for by name is theirs.
describe("a take builds where the person works, or in the space they ask for", () => {
  // A live run: a teammate introduced herself with her team's name, and her
  // build landed in a space named after the Unit's repo.
  test("a teammate who names herself and her team builds in the space she is in, and no space is made", () => {
    const home = homeWithTeams();
    const bea = cloneOf(home.remote, "bea");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "bea-chat" };
    const offer = next(bea, chat, ["Hi, I'm Bea from the web team. The checkout field is ours, let's take it."]);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 400)).toBe("unit-take");
    const start = (offer.choices as Array<{ label: string; command?: string }>).find((choice) => choice.label === "Start checkout-ui");
    expect(start?.command, JSON.stringify(offer.choices)).not.toContain("--space");
    expect(start?.command).not.toContain("--team");
    expect(String(offer.question_note)).toContain("naming themselves or their team is not that");
    const took = take(bea, "checkout-ui");
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("default");
    expect(readdirSync(join(bea, "aidlc", "spaces")).filter((name) => !name.startsWith("."))).toEqual(["default"]);
    expect(recordAt(home, "checkout-ui")?.json).toMatchObject({ owner: "default", taken_by: "bea" });
  });

  test("a take that asks for a space by name builds there, the space made as space create makes it", () => {
    const home = homeWithTeams();
    const pat = cloneOf(home.remote, "pat");
    const took = take(pat, "refunds", ["--space", "web"]);
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("web");
    expect(String(took.json?.notice ?? "")).toContain("You build it in the web space under your team's rules,");
    expect(existsSync(join(pat, "aidlc", "spaces", "web", "memory", "org.md"))).toBe(true);
    expect(readFileSync(join(pat, "aidlc", "active-space"), "utf-8").trim()).toBe("web");
    expect(recordAt(home, "refunds")?.json).toMatchObject({ owner: "web", taken_by: "pat" });
    // A space already here is used as it is.
    const second = take(pat, "checkout-ui", ["--space", "web"]);
    expect(second.status, second.out).toBe(0);
    expect(second.json?.space).toBe("web");
  });

  test("a space name space create refuses is refused in its words, and nothing is taken", () => {
    const home = homeWithTeams();
    const pat = cloneOf(home.remote, "pat");
    const took = take(pat, "refunds", ["--space", "switch"]);
    expect(took.status).not.toBe(0);
    expect(String(took.json?.error ?? took.out)).toContain('"switch" is a reserved name and cannot be a space name.');
    expect(recordAt(home, "refunds")).toBeNull();
    expect(existsSync(join(pat, "aidlc", "spaces", "switch"))).toBe(false);
  });
});

// A team's own workspace that holds nothing of the lead's (model 2): its own
// repo, AI-DLC's default space, the lead's project reached by the address the
// person said once.
function freshTeamWorkspace(label: string): { dir: string; host: string } {
  const dir = join(tempDir(`${label}-ws`), "workspace");
  mkdirSync(dir, { recursive: true });
  seedAidlcMemory(dir);
  writeFileSync(join(dir, ".gitignore"), "aidlc/.aidlc-engine/clone-id\naidlc/.aidlc-engine/sessions/\naidlc/active-space\naidlc/spaces/*/intents/active-intent\n" +
    "**/aidlc/spaces/*/intents/**/.aidlc-engine/\n/checkout-api/\n/billing/\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", label]);
  git(dir, ["config", "user.email", `${label}@example.test`]);
  commitAll(dir, "workspace");
  const host = tempDir(`${label}-host`);
  git(host, ["init", "-q", "--bare", "-b", "main"]);
  git(dir, ["remote", "add", "origin", host]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  return { dir, host };
}

// A rule of its own appended to one of a workspace's memory files.
function addRule(dir: string, file: "team.md" | "project.md", heading: string, text: string): void {
  const path = join(dir, "aidlc", "spaces", "default", "memory", file);
  writeFileSync(path, `${readFileSync(path, "utf-8")}\n## ${heading}\n\n${text}\n`);
}

// The lead's work built by teams, with the lead's own rules, its plan shared in
// its first code repository.
function planWithRules(rules: (dir: string) => void, hosts?: Record<string, string>): PlanHome {
  const home = makePlanHome({ share: false, ...(hosts === undefined ? {} : { repos: hosts }) });
  rules(home.dir);
  const shared = run(UNIT, ["share", "--plan"], home.dir);
  expect(shared.status, shared.out).toBe(0);
  return { ...home, plan: git(Object.values(home.hosts)[0], ["rev-parse", planRefOf(home.id8)]) };
}

// The plan's repository: the first of the work's.
const planHost = (home: PlanHome): string => Object.values(home.hosts)[0];

// `next`, with every rules part it sends on the way: the step, and all it said.
function nextSaying(cwd: string, env: NodeJS.ProcessEnv = ENV, args: string[] = []): { step: Record<string, unknown>; said: string } {
  let result = run(ORCH, ["next", ...args], cwd, env);
  let said = "";
  for (let parts = 0; parts < 50; parts++) {
    expect(result.status, result.out).toBe(0);
    said += result.stdout;
    const directive = JSON.parse(result.stdout) as Record<string, unknown>;
    if (directive.kind !== "load-steering" || typeof directive.receipt !== "string") return { step: directive, said };
    result = run(ORCH, ["continue", directive.receipt], cwd, env);
  }
  throw new Error("rules never finished arriving");
}

// Every git command a step ran, as GIT_TRACE wrote them.
function traced(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf-8").split(/\r?\n/).filter((line) => line.includes("trace: built-in: git ")) : [];
}

const UNREAD = "could not be read just now, so this step follows your team's own rules.";

describe("a team's own workspace that reads the lead's plan where it is shared", () => {
  test("the plan's repository's address, said once: the Units and the lead's rules are offered, the take builds in default, its record and the push reach the plan's repository", () => {
    const home = planWithRules((dir) => addRule(dir, "project.md", "Release Checks", "Every handler ships with a contract test."));
    const plan = planHost(home);
    const pay = ownWorkspace(home.hosts, "pay", ["checkout-api"]);
    const ask = next(pay, ENV, ["--lead-address", plan]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-take");
    expect(offerText(ask.question)).toStartWith("fixture is shared in checkout-api.");
    const choices = ask.choices as Array<{ label: string; command?: string; detail?: string }>;
    const start = choices.find((choice) => choice.label === "Start refunds");
    expect(start, choices.map((choice) => choice.label).join(" | ")).toBeDefined();
    // A Windows path is quoted for the shell.
    expect(start!.command?.replaceAll("'", "")).toContain(`take refunds --plan ${home.id8} --from ${plan}`);
    expect(start!.command).toEndWith("--lead-rules");
    // The lead's rules, named from the plan, never this workspace's own files.
    expect(start!.detail).toContain("The lead's project rules (Release Checks) apply to its build too");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan, "--lead-rules"], pay);
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ team: "default", space: "default" });
    // No remote and no folder of the lead's: AI-DLC's own refs only.
    expect(git(pay, ["remote"])).toBe("");
    expect(recordAt(home, "refunds")?.json).toMatchObject({ owner: "default", taken_by: "pay" });
    const record = buildDir(pay, "default", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("rules/project.md");
    // billing is not here and this workspace lists no repos: the plan's list gives its address.
    const offer = next(pay);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 600)).toBe("unit-clone");
    expect(String(offer.question)).toBe(`billing is not here yet; the lead's list has it at ${home.hosts.billing}. Do you want me to clone it here?`);
  });

  test("the lead's rules are the lead's, read from the plan: never the team's own default files, and the lead's next share reaches the next chat's step", () => {
    const home = planWithRules((dir) => addRule(dir, "team.md", "Refund Amount", "Test first for the refund amount."), { app: codeHost("app") });
    const plan = planHost(home);
    const pay = ownWorkspace(home.hosts, "pay", []);
    addRule(pay, "project.md", "Payments Checks", "Our own payments rule.");
    commitAll(pay, "our rules");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan, "--lead-rules"], pay);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("under your team's rules and the lead's practices, from what the lead approved.");
    const record = buildDir(pay, "default", "refunds");
    // The lead holds practices and no project rules; the team's own project.md is never named as the lead's.
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("rules/team.md");
    const first = nextSaying(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-chat-1" });
    expect(first.step.kind, JSON.stringify(first.step).slice(0, 400)).toBe("run-stage");
    const rules = first.step.rules_in_context as string[];
    expect(rules).toContain("the lead's rules/team.md");
    expect(rules).toContain("aidlc/spaces/default/memory/project.md");
    expect(first.said).toContain("Test first for the refund amount.");
    expect(first.said).toContain("Our own payments rule.");
    expect(first.said).not.toContain(UNREAD);
    // The lead changes the rule and shares again: the team's next chat follows it, with no word about it.
    const leadTeam = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(leadTeam, readFileSync(leadTeam, "utf-8").replace("Test first for the refund amount.", "Test first for every amount."));
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const later = nextSaying(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-chat-2" });
    expect(later.said).toContain("Test first for every amount.");
    expect(later.said).not.toContain("Test first for the refund amount.");
  });

  test("the lead's rules cannot be read: the step goes on under the team's own rules and says so once", () => {
    const home = planWithRules((dir) => addRule(dir, "team.md", "Refund Amount", "Test first for the refund amount."), { app: codeHost("app") });
    const plan = planHost(home);
    const pay = ownWorkspace(home.hosts, "pay", []);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan, "--lead-rules"], pay).status).toBe(0);
    // The plan's repository is gone from where it was, and its copy here with it.
    renameSync(plan, `${plan}-moved`);
    for (const ref of git(pay, ["for-each-ref", "--format=%(refname)", `refs/aidlc/home/${home.id8}/`]).split("\n").filter((name) => name.endsWith("/plan"))) {
      git(pay, ["update-ref", "-d", ref]);
    }
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-chat" };
    const first = nextSaying(pay, chat);
    expect(first.step.kind, JSON.stringify(first.step).slice(0, 600)).toBe("run-stage");
    expect(first.step.rules_in_context as string[]).not.toContain("the lead's rules/team.md");
    expect(first.said).toContain(`The lead's practices ${UNREAD}`);
    const again = nextSaying(pay, chat);
    expect(again.said).not.toContain(UNREAD);
  });

  test("after its first Unit is pushed, the build's next step offers the lead's next Unit with no address said again; a fresh clone of the team's workspace is offered it too", () => {
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-chat" };
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = planWithRules(() => {}, hosts);
    const pay = freshTeamWorkspace("pay");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay.dir, name, "pay");
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", planHost(home)], pay.dir, chat).status).toBe(0);
    const record = buildDir(pay.dir, "default", "refunds");
    codeGenerated(pay.dir, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], pay.dir, chat);
    expect(pushed.status, pushed.out).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
    const offered = next(pay.dir, chat);
    expect(offered.ask_type, JSON.stringify(offered).slice(0, 600)).toBe("unit-take");
    const start = (offered.choices as Array<{ label: string; command?: string }>).find((choice) => choice.label.startsWith("Start reporting"));
    expect(start, JSON.stringify(offered.choices)).toBeDefined();
    expect(start!.command?.replaceAll("'", "")).toContain(`--from ${planHost(home)}`);
    commitAll(pay.dir, "refunds pushed");
    git(pay.dir, ["push", "-q", "origin", "main"]);
    const pay2 = cloneOf(pay.host, "pay2");
    const fresh = next(pay2, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay2-chat" });
    expect(fresh.ask_type, JSON.stringify(fresh).slice(0, 600)).toBe("unit-take");
    expect((fresh.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start reporting");
  });

  test("a second teammate's clone carries the build on when they ask: its first step reads the lead's rules, and the plan is read from the build", () => {
    const home = planWithRules((dir) => addRule(dir, "team.md", "Refund Amount", "Test first for the refund amount."), { app: codeHost("app") });
    const plan = planHost(home);
    const pay = freshTeamWorkspace("pay");
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan, "--lead-rules"], pay.dir).status).toBe(0);
    commitAll(pay.dir, "refunds taken");
    git(pay.dir, ["push", "-q", "origin", "main"]);
    const pay2 = cloneOf(pay.host, "pay2");
    // A fresh clone: nothing of AI-DLC's own refs came with it.
    expect(git(pay2, ["for-each-ref", "--format=%(refname)", "refs/aidlc/"])).toBe("");
    // Its first look: the build is said with who took it, the plan read from the build, the address never asked for.
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "pay2-chat" };
    const offer = next(pay2, chat);
    expect(String(offer.question ?? offer.narration), JSON.stringify(offer).slice(0, 400)).toContain("refunds (being built by pay, on another computer)");
    expect((offer.choices as Array<{ label: string }> | undefined ?? []).map((choice) => choice.label)).not.toContain("Carry on refunds");
    const carryOn = /When their words ask to carry on a build the question lists as being built, run its command: refunds: `([^`]+)`/
      .exec(String(offer.question_note ?? offer.board_note ?? ""))?.[1];
    expect(carryOn, JSON.stringify(offer).slice(0, 1600)).toBe(`bun .claude/tools/aidlc-unit.ts take refunds --plan ${home.id8} --from ${shellSingleQuote(plan)}`);
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay2, chat);
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ resumed: true, space: "default" });
    const first = nextSaying(pay2, chat);
    expect(first.step.kind, JSON.stringify(first.step).slice(0, 600)).toBe("run-stage");
    expect(first.step.stage).toBe("functional-design");
    expect(first.step.ask_type).toBeUndefined();
    expect(first.step.rules_in_context as string[]).toContain("the lead's rules/team.md");
    expect(first.said).toContain("Test first for the refund amount.");
    expect(first.said).not.toContain(UNREAD);
  });

  // The hook that briefs a stage's subagent resolves the same bundle the step carries.
  test("a subagent's brief in the team's build carries the lead's rules, read from the plan", () => {
    const home = planWithRules((dir) => addRule(dir, "team.md", "Refund Amount", "Test first for the refund amount."));
    const pay = ownWorkspace(home.hosts, "pay", ["checkout-api", "billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", planHost(home), "--lead-rules"], pay).status).toBe(0);
    const node = loadGraph().find((stage) => stage.slug === "functional-design")!;
    const bundle = resolvedRuleBundle(node, pay);
    expect(bundle.error).toBeNull();
    const lead = bundle.content.find((entry) => entry.path === "the lead's rules/team.md");
    expect(lead?.text, bundle.content.map((entry) => entry.path).join(", ")).toContain("Test first for the refund amount.");
  });

  test("the plan's repository with nothing shared yet says so, and takes nothing", () => {
    const home = makePlanHome({ share: false });
    const pay = ownWorkspace(home.hosts, "pay", ["billing"]);
    const ask = next(pay, ENV, ["--lead-address", planHost(home)]);
    expect(String(ask.narration), JSON.stringify(ask)).toBe(`${planHost(home)} has no plan shared in it yet.`);
    const intents = join(pay, "aidlc", "spaces", "default", "intents");
    expect(existsSync(intents) ? readdirSync(intents).filter((name) => name !== "intents.json") : []).toEqual([]);
  });

  // The address the person said can carry a sign-in: the build's record, which
  // the team commits, keeps the address without it.
  test("an address that carries a sign-in is recorded without it", () => {
    const home = makePlanHome();
    const pay = ownWorkspace(home.hosts, "pay", ["billing"]);
    const said = "https://pay:s3cret-token@lead.example/checkout-api.git";
    git(pay, ["config", `url.${planHost(home)}.insteadOf`, said]);
    git(pay, ["config", "--add", `url.${planHost(home)}.insteadOf`, "https://lead.example/checkout-api.git"]);
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", said], pay);
    expect(took.status, took.out).toBe(0);
    const record = buildDir(pay, "default", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Home Location")).toBe("https://lead.example/checkout-api.git");
    const written = spawnSync("git", ["grep", "--no-index", "-l", "s3cret-token", "--", "aidlc"], { cwd: pay, encoding: "utf-8" });
    expect(written.stdout.trim()).toBe("");
  });

  test("a build carried on with the plan's address said again needs nothing of the plan's repository", () => {
    const home = makePlanHome();
    const plan = planHost(home);
    const pay = ownWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay).status).toBe(0);
    renameSync(plan, `${plan}-moved`);
    const again = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay);
    expect(again.status, again.out).toBe(0);
    expect(again.json).toMatchObject({ resumed: true, space: "default" });
  });

  // Codex keeps a repository's .git read-only unless its session grants write access.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a .git this session cannot write: the plan's address said gets the way on, never a dead end", () => {
    const home = makePlanHome();
    const pay = ownWorkspace(home.hosts, "pay", ["billing"]);
    // The whole .git, as the sandbox keeps it.
    const dotGit = join(pay, ".git");
    spawnSync("chmod", ["-R", "a-w", dotGit]);
    try {
      const ask = run(ORCH, ["next", "--lead-address", planHost(home)], pay);
      expect(ask.out).toContain("Run the same command again with write access");
    } finally {
      spawnSync("chmod", ["-R", "u+w", dotGit]);
    }
  });

  test("an address starting with '-' is refused before any git call, at the take and at the offer", () => {
    const home = makePlanHome();
    const pay = ownWorkspace(home.hosts, "pay", ["billing"]);
    const marker = join(tempDir("dash"), "ran");
    const trace = join(tempDir("trace"), "git.trace");
    const env = { ...ENV, GIT_TRACE: trace };
    const took = takeIn("payments", ["refunds", "--plan", home.id8, `--from=--upload-pack=touch ${marker}`], pay, env);
    expect(took.status).not.toBe(0);
    expect(String(took.json?.error)).toContain('starts with "-"');
    const asked = run(ORCH, ["next", "--lead-address", `-utouch ${marker}`], pay, env);
    expect(String(asked.json?.message)).toContain('starts with "-"');
    expect(existsSync(marker)).toBe(false);
    expect(traced(trace).filter((line) => line.includes(marker))).toEqual([]);
  });
});

// The lead's project takes no push from here: its pre-receive hook refuses every one.
function refusePushes(remote: string): void {
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'this host takes no push from here' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
}

// A record repository that takes no push of AI-DLC's records; its code pushes go through.
// The lead's word on a Unit, done for its record's `generation`, written on the
// plan's tip as one commit by hand.
function doneOnPlanByHand(host: string, unit: string, generation: number): void {
  const ref = planRefOf("00000001");
  const tip = git(host, ["rev-parse", ref]);
  const plan = JSON.parse(git(host, ["show", `${tip}:plan.json`])) as { units: Array<{ name: string; word: Record<string, unknown> }> };
  for (const entry of plan.units) if (entry.name === unit) entry.word = { ...entry.word, generation, done: true };
  // The lead's own name on the commit, so a box with no git identity of its own makes it too.
  const env = { ...ENV, GIT_AUTHOR_NAME: "lead", GIT_AUTHOR_EMAIL: "lead@example.test", GIT_COMMITTER_NAME: "lead", GIT_COMMITTER_EMAIL: "lead@example.test" };
  const out = (args: string[], input?: string): string => spawnSync("git", args, { cwd: host, encoding: "utf-8", env, input }).stdout.trim();
  const blob = out(["hash-object", "-w", "--stdin"], `${JSON.stringify(plan, null, 2)}\n`);
  const entries = out(["ls-tree", tip]).split("\n").map((line) => (line.endsWith("\tplan.json") ? `100644 blob ${blob}\tplan.json` : line));
  const commit = out(["commit-tree", out(["mktree"], `${entries.join("\n")}\n`), "-p", tip, "-m", `aidlc plan fixture 9: ${unit} done`]);
  git(host, ["update-ref", ref, commit]);
}

function refuseRecords(host: string): void {
  const hook = join(host, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/aidlc/*|refs/heads/aidlc/*) " +
    "echo 'this host takes no push from here' >&2; exit 1;; esac; done\nexit 0\n");
  chmodSync(hook, 0o755);
}

// The plan of work across checkout-api and billing, shared in checkout-api,
// the lead's workspace on a host of its own: refunds's record is in checkout-api.
function recordsHome() {
  const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
  const home = makePlanHomeWithRemote({ repos: hosts });
  sharedPlan = home;
  return { hosts, home };
}

// A Unit's record as its repository holds it, or null.
const recordJson = (home: PlanHome, unit: string): Record<string, unknown> | null => recordAt(home, unit)?.json ?? null;

function takePushes(remote: string): void {
  writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
}

// The push's line for a build whose take its record's repository never took.
const NOT_WRITTEN = "checkout-api still takes no push of refunds's record from you (this host takes no push from here (pre-receive hook declined)), " +
  "so neither your take nor this result is written there.";
// The build's end while its result waits on its record's repository.
const WAITS = "checkout-api has not taken the result of refunds yet; ask me to send it again once its owner lets your pushes through.";

const chatOf = (session: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: session });

describe("a take the lead's project could not record then", () => {
  test("recorded at a later look once the lead's project takes pushes, with nothing said about it", () => {
    const home = homeWithTeams();
    refuseRecords(home.hosts.app);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    // Still refused: the look says nothing, and nothing is written.
    const still = nextSaying(pay, chatOf("pay-1"));
    expect(still.said).not.toContain("is not written there");
    expect(recordJson(home, "refunds")?.taken_by).toBeUndefined();
    takePushes(home.hosts.app);
    const later = nextSaying(pay, chatOf("pay-2"));
    expect(recordJson(home, "refunds")).toMatchObject({ owner: "payments", taken_by: "pay", generation: 1 });
    expect(later.said).not.toContain("is not written there");
    expect(later.said).not.toContain("before your take could be");
  });

  // The take went to the team's own workspace repo too (Arden's option 1); the
  // person's own fetch of it then brought that copy under their remote.
  test("after the person's own fetch of their team's repo, a later look still records the take once the lead's project takes pushes", () => {
    const home = homeWithTeams();
    refuseRecords(home.hosts.app);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(pay, ["fetch", "-q", "origin"]);
    takePushes(home.hosts.app);
    nextSaying(pay, chatOf("pay-2"));
    expect(recordJson(home, "refunds")).toMatchObject({ owner: "payments", taken_by: "pay", generation: 1 });
  });

  test("open: the claim is made at a later look once the lead's project takes pushes", () => {
    const open = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n  - name: reporting\n    depends_on: []\n```\n";
    const home = homeWithTeams(open);
    refuseRecords(home.hosts.app);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "reporting").status).toBe(0);
    takePushes(home.hosts.app);
    next(pay, chatOf("pay-2"));
    expect(recordJson(home, "reporting")).toMatchObject({ status: "claimed", owner: "payments", taken_by: "pay" });
  });

  test("released by the lead before it was recorded: recorded at the claim's new attempt, the build's following it", () => {
    const home = homeWithTeams();
    refuseRecords(home.hosts.app);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.hosts.app);
    // The lead builds it here meanwhile, then releases it.
    expect(run(UNIT, ["assign", "--here", "refunds"], home.dir).status).toBe(0);
    expect(run(UNIT, ["release", "refunds"], home.dir).status).toBe(0);
    const later = nextSaying(pay, chatOf("pay-2"));
    expect(recordJson(home, "refunds")).toMatchObject({ status: "claimed", owner: "payments", taken_by: "pay", generation: 2 });
    expect(field(readFileSync(join(buildDir(pay, "payments", "refunds"), "aidlc-state.md"), "utf-8"), "Home Attempt")).toBe("2");
    expect(later.said).not.toContain("before your take could be");
  });

  test("released by the lead before it was recorded, in a clone of the lead's own repo: recorded with nothing said, never as taken by yourself", () => {
    const home = homeWithTeams();
    refuseRecords(home.hosts.app);
    const pay = cloneOf(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.hosts.app);
    // The lead builds it here meanwhile, then releases it.
    expect(run(UNIT, ["assign", "--here", "refunds"], home.dir).status).toBe(0);
    expect(run(UNIT, ["release", "refunds"], home.dir).status).toBe(0);
    const chat = chatOf("pay-2");
    const later = nextSaying(pay, chat);
    expect(recordJson(home, "refunds")).toMatchObject({ owner: "payments", taken_by: "pay", generation: 2 });
    expect(later.said).not.toContain("so the record has theirs");
    expect(nextSaying(pay, chat).said).not.toContain("so the record has theirs");
  });

  test("a push after the lead released it before it was recorded: the take is recorded, then the result goes on it", () => {
    const { hosts, home } = recordsHome();
    refuseRecords(hosts["checkout-api"]);
    const pay = cloneOf(home.remote, "pay");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(hosts["checkout-api"]);
    // The lead builds it here meanwhile, then releases it.
    expect(run(UNIT, ["assign", "--here", "refunds"], home.dir).status).toBe(0);
    expect(run(UNIT, ["release", "refunds"], home.dir).status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    const pushed = run(UNIT, ["push"], pay);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.out).not.toContain("so the record has theirs");
    const claim = recordJson(home, "refunds") as { taken_by?: string; generation?: number; result?: unknown };
    expect(claim).toMatchObject({ taken_by: "pay", generation: 2 });
    expect(claim.result).toBeDefined();
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Unit Push")).toBe("pushed");
  });

  test("done on the plan meanwhile: said once, that the take was never written on its record, with the way on", () => {
    const { hosts, home } = recordsHome();
    // A teammate took it and gave it back, so its record stands given back.
    const pal = teamWorkspace(home.remote, "pal");
    expect(takeFrom("payments", pal, "refunds").status).toBe(0);
    expect(run(UNIT, ["release", "refunds"], pal).status).toBe(0);
    refuseRecords(hosts["checkout-api"]);
    const pay = teamWorkspace(home.remote, "pay");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(hosts["checkout-api"]);
    // The lead's word meanwhile: done, for the record as it stands, written on the plan by hand (no lead command
    // writes done for a record given back).
    const generation = (recordJson(home, "refunds") as { generation: number }).generation;
    doneOnPlanByHand(hosts["checkout-api"], "refunds", generation);
    const chat = chatOf("pay-done");
    const look = nextSaying(pay, chat);
    expect(look.said).toContain(
      "refunds is done on the plan in checkout-api now, and your take of it was never written on its record in checkout-api. " +
        "Your build is still here: agree with the lead who carries it on, or give yours back.",
    );
    expect(nextSaying(pay, chat).said).not.toContain("your take of it was never written");
  });

  test("taken by a teammate meanwhile: said once with who and when, their claim never written over, a give back sets the build aside here only", () => {
    const { hosts, home } = recordsHome();
    refuseRecords(hosts["checkout-api"]);
    const pay = teamWorkspace(home.remote, "pay");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(hosts["checkout-api"]);
    const pal = teamWorkspace(home.remote, "pal");
    expect(takeFrom("payments", pal, "refunds").status).toBe(0);
    const theirs = recordJson(home, "refunds");
    expect(theirs).toMatchObject({ taken_by: "pal" });
    const today = git(hosts["checkout-api"], ["log", "-1", "--format=%cs", "refs/aidlc/claims/00000001/refunds"]);
    const chat = chatOf("pay-2");
    const look = nextSaying(pay, chat);
    expect(look.said).toContain(
      `refunds was taken by pal on ${today}, written on its record in checkout-api before your take could be, ` +
        "so the record has theirs, not yours. Your build is still here: agree with pal who carries it on, or give yours back.",
    );
    expect(nextSaying(pay, chat).said).not.toContain("before your take could be");
    const record = buildDir(pay, "payments", "refunds");
    // A change to an approved input is never sent on pal's claim.
    const requirements = join(record, "inception", "requirements-analysis", "requirements.md");
    writeFileSync(requirements, `${readFileSync(requirements, "utf-8")}\nFR2 partial refunds.\n`);
    const proposed = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "partial refunds too"], pay, chat);
    expect(proposed.status, proposed.out).toBe(0);
    expect(String(proposed.json?.notice)).toContain("before your take could be");
    expect(recordJson(home, "refunds")).toEqual(theirs);
    // The push sends the code to the team's own repos and no result onto pal's claim, and offers no send again.
    codeGenerated(pay, record);
    const pushed = run(UNIT, ["push"], pay, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice ?? pushed.out)).toContain("before your take could be");
    expect(recordJson(home, "refunds")).toEqual(theirs);
    expect(next(pay, chat).ask_type ?? null).not.toBe("unit-push");
    const back = run(UNIT, ["release", "refunds"], pay);
    expect(back.status, back.out).toBe(0);
    expect(back.json?.notice).toBe(
      "Nothing changed for refunds: its record in checkout-api is as it was. Its build here is " +
        "set aside, with everything in it kept.",
    );
    expect(recordJson(home, "refunds")).toEqual(theirs);
  });

  test("a person who changes their git name after their take was recorded is still the one who took it", () => {
    const home = homeWithTeams();
    const pay = cloneOf(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(pay, ["config", "user.name", "Pay Person"]);
    const look = nextSaying(pay, chatOf("pay-2"));
    expect(look.said).not.toContain("before your take could be");
    expect(recordJson(home, "refunds")).toMatchObject({ taken_by: "pay" });
  });

  test("its push while the record's repository still takes none: the code goes, and it is said once that neither the take nor the result is written there", () => {
    const { hosts, home } = recordsHome();
    refuseRecords(hosts["checkout-api"]);
    const pay = teamWorkspace(home.remote, "pay", true);
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    const pushed = run(UNIT, ["push"], pay);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice ?? pushed.out)).toContain(NOT_WRITTEN);
    expect(String(pushed.json?.notice ?? pushed.out)).not.toContain("Do you want me to send it again?");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Unit Push")).toBe("unsent");
    expect(recordJson(home, "refunds")?.taken_by).toBeUndefined();
    // Once the lead's project takes pushes, sending it again records the take, then the result on it.
    takePushes(hosts["checkout-api"]);
    expect(run(UNIT, ["push"], pay).status).toBe(0);
    const claim = recordJson(home, "refunds") as { taken_by?: string; result?: unknown };
    expect(claim.taken_by).toBe("pay");
    expect(claim.result).toBeDefined();
  });

  // A path no repository is at: the clone's pushes to refunds's record go there, as with no write access.
  const NOWHERE = join(tmpdir(), "aidlc-no-such-repository", "none");
  // A clone of the lead's own workspace repo that cannot write its records in
  // refunds's repository: it refuses them by a rule, or the clone has no write
  // access. The take goes on; the build is done and approved.
  function builtUnderRule(shape: "rule" | "no write access") {
    const { hosts, home } = recordsHome();
    const pay = cloneOf(home.remote, "pay");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    // No write access: reads answer, and the push cannot start there (no per-ref status, as with a 403 or a refused ssh key).
    if (shape === "rule") refuseRecords(hosts["checkout-api"]);
    else git(pay, ["config", `url.${NOWHERE}.pushInsteadOf`, hosts["checkout-api"]]);
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    finishBuild(record);
    return { hosts, home, pay, record };
  }

  test("a rule of the record's host refuses the take and its result: said once in its words, never offered again until a push there goes through", () => {
    const { hosts, home, pay, record } = builtUnderRule("rule");
    const chat = chatOf("pay-push");
    const pushed = run(UNIT, ["push"], pay, chat);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice ?? pushed.out);
    expect(said).toContain(NOT_WRITTEN);
    expect(said).not.toContain("Do you want me to send it again?");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Unit Push")).toBe("unsent");
    // The chat that heard it is not asked, and not told again.
    for (const step of [nextSaying(pay, chat), nextSaying(pay, chat)]) {
      expect(step.step.ask_type ?? null, JSON.stringify(step.step)).not.toBe("unit-push");
      expect(step.said).not.toContain(WAITS);
    }
    // A new chat is told once, and not asked.
    const other = chatOf("pay-other");
    const first = nextSaying(pay, other);
    expect(first.step.ask_type ?? null, JSON.stringify(first.step)).not.toBe("unit-push");
    expect(first.said).toContain(WAITS);
    const second = nextSaying(pay, other);
    expect(second.step.ask_type ?? null).not.toBe("unit-push");
    expect(second.said).not.toContain(WAITS);
    expect(recordJson(home, "refunds")).toBeNull();
    // Its owner lets the pushes through: a new chat's look records the take, and the send is offered.
    takePushes(hosts["checkout-api"]);
    const later = chatOf("pay-later");
    const offered = nextSaying(pay, later);
    expect(recordJson(home, "refunds")).toMatchObject({ taken_by: "pay" });
    expect(offered.step.ask_type, JSON.stringify(offered.step)).toBe("unit-push");
    expect(offered.step.question).toBe("refunds is pushed, but checkout-api did not take its result just now. Do you want me to send it again?");
    expect(offered.said).not.toContain(WAITS);
    expect(run(UNIT, ["push"], pay, later).status).toBe(0);
    expect((recordJson(home, "refunds") as { result?: unknown }).result).toBeDefined();
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Unit Push")).toBe("pushed");
    expect(nextSaying(pay, chatOf("pay-after")).said).not.toContain(WAITS);
  });

  test("a team workspace that reaches the lead only by address: once its owner lets pushes through, the look's own record brings the offer back", () => {
    const { hosts, home } = recordsHome();
    refuseRecords(hosts["checkout-api"]);
    const pay = teamWorkspace(home.remote, "pay");
    // No remote of its own to send a claim to: the lead's project is the only place.
    git(pay, ["remote", "remove", "origin"]);
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    finishBuild(record);
    const chat = chatOf("pay-push");
    const pushed = run(UNIT, ["push"], pay, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice ?? pushed.out)).toContain(NOT_WRITTEN);
    expect(nextSaying(pay, chatOf("pay-other")).step.ask_type ?? null).not.toBe("unit-push");
    takePushes(hosts["checkout-api"]);
    const later = nextSaying(pay, chatOf("pay-later"));
    expect(recordJson(home, "refunds")).toMatchObject({ taken_by: "pay" });
    expect(later.step.ask_type, JSON.stringify(later.step)).toBe("unit-push");
  });

  test("no write access to the record's repository: the push says so once and asks nothing, and the next steps wait for the take to be written", () => {
    const { home, pay } = builtUnderRule("no write access");
    const chat = chatOf("pay-push");
    const pushed = run(UNIT, ["push"], pay, chat);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice ?? pushed.out);
    expect(said).toContain("checkout-api still takes no push of refunds's record from you (");
    expect(said).toContain("so neither your take nor this result is written there.");
    expect(said).not.toContain("Do you want me to send it again?");
    const after = nextSaying(pay, chat);
    expect(after.step.ask_type ?? null, JSON.stringify(after.step)).not.toBe("unit-push");
    expect(after.said).not.toContain(WAITS);
    expect(nextSaying(pay, chatOf("pay-other")).step.ask_type ?? null).not.toBe("unit-push");
    git(pay, ["config", "--unset-all", `url.${NOWHERE}.pushInsteadOf`]);
    const later = nextSaying(pay, chatOf("pay-later"));
    expect(recordJson(home, "refunds")).toMatchObject({ taken_by: "pay" });
    expect(later.step.ask_type, JSON.stringify(later.step)).toBe("unit-push");
  });

  test("a teammate's clone of the team's workspace says and writes nothing for a take another checkout made", () => {
    const home = homeWithTeams();
    refuseRecords(home.hosts.app);
    const host = tempDir("pay-host-shared");
    git(host, ["init", "-q", "--bare", "-b", "main"]);
    const seed = cloneOf(home.remote, "pay-seed");
    git(seed, ["remote", "set-url", "origin", host]);
    git(seed, ["push", "-q", "origin", "main"]);
    const pay = cloneOf(host, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    commitAll(pay, "refunds taken");
    git(pay, ["push", "-q", "origin", "main"]);
    const pat = cloneOf(host, "pat");
    takePushes(home.hosts.app);
    // Pat carries the build on in that clone: its step is the build's own.
    const carried = take(pat, "refunds");
    expect(carried.json, carried.out).toMatchObject({ resumed: true });
    const look = nextSaying(pat, chatOf("pat-1"));
    expect(look.said).not.toContain("before your take could be");
    expect(recordJson(home, "refunds")?.taken_by).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("with commits signed, a look never signs one to record the take: the push does", () => {
    const home = homeWithTeams();
    refuseRecords(home.hosts.app);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.hosts.app);
    // A signer that leaves a mark when it is asked to sign.
    const marks = tempDir("signer");
    const signer = join(marks, "sign.sh");
    writeFileSync(signer, `#!/bin/sh\ntouch '${join(marks, "asked")}'\nexit 1\n`);
    chmodSync(signer, 0o755);
    git(pay, ["config", "commit.gpgsign", "true"]);
    git(pay, ["config", "gpg.program", signer]);
    const look = run(ORCH, ["next"], pay, chatOf("pay-2"));
    expect(look.status, look.out).toBe(0);
    expect(existsSync(join(marks, "asked")), "a look asked to sign").toBe(false);
    expect(recordJson(home, "refunds")?.taken_by).toBeUndefined();
  });

  test("by the lead's address from a team's own workspace: the take goes on, and is recorded once the lead's project takes pushes", () => {
    const home = homeWithTeams();
    refuseRecords(home.hosts.app);
    const pay = freshTeamWorkspace("pay");
    // Nowhere else to send the take: its own host takes no push either.
    refusePushes(pay.host);
    const took = run(UNIT, ["take", "refunds", ...planFrom(home)], pay.dir);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("so your take of refunds is not written there, and someone else could still take it.");
    takePushes(home.hosts.app);
    next(pay.dir, chatOf("pay-2"));
    expect(recordJson(home, "refunds")).toMatchObject({ owner: "default", taken_by: "pay" });
  });
});

describe("every Unit is open: whoever takes it builds it where they are, and no team is named", () => {
  // The lead's project once teams are chosen, shared, with no team named.
  function homeOpen() {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    return planShared(home);
  }
  function workIn(dir: string, space: string): void {
    expect(run(UTILITY, ["space-create", space], dir).status).toBe(0);
    expect(run(UTILITY, ["space", space], dir).status).toBe(0);
  }

  test("the lead says Payments and the team works in its pay space: their take goes, and its build is in pay", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    // The lead's own words name a team; nothing holds a Unit for a name now.
    run(UNIT, ["assign", "refunds=Payments"], home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const plan = planShared(home);
    const pat = cloneOf(home.remote, "pat");
    workIn(pat, "pay");
    const took = take(pat, "refunds");
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("pay");
    expect(String(took.json?.notice ?? "")).toContain("You build it in the pay space under your team's rules,");
    expect(recordAt(plan, "refunds")?.json).toMatchObject({ owner: "pay", taken_by: "pat" });
  });

  test("two fresh clones take one Unit: the first builds it where it is, the other is told who has it", () => {
    const home = homeOpen();
    const ann = cloneOf(home.remote, "ann");
    const ben = cloneOf(home.remote, "ben");
    const first = take(ann, "refunds");
    expect(first.status, first.out).toBe(0);
    expect(first.json?.space).toBe("default");
    const second = take(ben, "refunds");
    expect(second.status).not.toBe(0);
    expect(second.out).toContain("refunds is already taken: ann builds it.");
    expect(second.out).not.toContain("team");
  });

  test("a taker in a named space builds there, one in default builds in default", () => {
    const home = homeOpen();
    const web = cloneOf(home.remote, "wen");
    workIn(web, "web");
    const ui = take(web, "checkout-ui");
    expect(ui.status, ui.out).toBe(0);
    expect(ui.json?.space).toBe("web");
    expect(recordAt(home, "checkout-ui")?.json).toMatchObject({ owner: "web", taken_by: "wen" });
    const dee = cloneOf(home.remote, "dee");
    const refunds = take(dee, "refunds");
    expect(refunds.status, refunds.out).toBe(0);
    expect(refunds.json?.space).toBe("default");
    expect(recordAt(home, "refunds")?.json).toMatchObject({ owner: "default", taken_by: "dee" });
  });

  test("a fresh clone is offered each open Unit once, with no team to name", () => {
    const home = homeOpen();
    const ask = next(cloneOf(home.remote, "fay"));
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.filter((choice) => choice.label.startsWith("Start refunds")).length, JSON.stringify(choices)).toBe(1);
    for (const choice of choices) expect(choice.command).not.toContain("--team");
    expect(JSON.stringify(ask)).not.toMatch(/Which team|for another team|the lead's project builds/i);
  });

  test("the lead's own build here holds the Unit: a teammate's take after it is told who has it", () => {
    const home = homeOpen();
    git(home.dir, ["config", "user.name", "lee"]);
    const here = run(UNIT, ["assign", "--here", "refunds"], home.dir);
    expect(here.status, here.out).toBe(0);
    expect(recordJson(home, "refunds")).toMatchObject({ taken_by: "lee" });
    const tom = take(cloneOf(home.remote, "tom"), "refunds");
    expect(tom.status).not.toBe(0);
    expect(tom.out).toContain("refunds is already taken: lee builds it.");
  });
});

// AI-DLC's team records are a ref of its own in each Unit's repository, beside the branches, so the host lists no
// branch for them, offers no pull request, runs no workflow and no branch rule on them, and a team's clone lists none.
describe("where the team's records live", () => {
  test("a take and its result are kept under refs/aidlc/claims and the lead's word on the plan, no claim branch anywhere, and the lead's copy of the plan follows each write", () => {
    const { home, alice, record } = refundsTakenHere();
    codeGenerated(alice, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    const said = run(UNIT, ["merged", "refunds", "--repo", "checkout-api", "--person-words", "merged by hand"], home.dir, chatOf("lead-records"));
    expect(said.status, said.out).toBe(0);
    const ref = `refs/aidlc/claims/${home.id8}/refunds`;
    expect(git(recordHostOf(home, "refunds"), ["for-each-ref", "--format=%(refname)", "refs/aidlc/claims/", "refs/heads/claim/"])).toBe(ref);
    expect(recordAt(home, "refunds")?.json).toMatchObject({ taken_by: "alice" });
    expect(planWordAt(home, "refunds")?.said_merged).toBeDefined();
    // The lead's own copy of the plan is the plan as the lead's word left it, with no look between.
    const copies = git(home.dir, ["for-each-ref", "--format=%(refname) %(objectname)", `refs/aidlc/home/${home.id8}/`])
      .split("\n").filter((line) => line.split(" ")[0].endsWith("/plan"));
    expect(copies.map((line) => line.split(" ")[1])).toEqual([git(planHost(home), ["rev-parse", planRefOf(home.id8)])]);
    // A teammate's clone, and a plain clone of the record's repository, list no branch of AI-DLC's.
    for (const dir of [alice, cloneOf(recordHostOf(home, "refunds"), "carol")]) expect(git(dir, ["branch", "-a"])).not.toContain("claim");
  });

  test("a teammate's own git fetch --prune keeps AI-DLC's copy of the records", () => {
    const { home, alice } = refundsTakenInClone();
    const copies = (): string[] => git(alice, ["for-each-ref", "--format=%(refname) %(objectname)", `refs/aidlc/home/${home.id8}/`])
      .split("\n").filter((line) => line.includes("/claims/refunds "));
    const before = copies();
    expect(before).toHaveLength(1);
    git(alice, ["fetch", "-q", "--prune", "origin"]);
    expect(copies()).toEqual(before);
  });
});
