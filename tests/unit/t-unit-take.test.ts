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
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents, readIntentRegistry, shellArg } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { leadsPlanNotHere } from "../../dist/claude/.claude/tools/aidlc-unit-holders.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { resolvedRuleBundle } from "../../dist/claude/.claude/tools/aidlc-steering.ts";
import { learningsCorrectionChoices, offersLearningsCorrectionChoices } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { AIDLC_SRC, fixtureIntentId8, REPO_ROOT, seedAidlcMemory } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import {
  claimPayload,
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
  makeHome,
  mergeOnHost,
  next,
  ORCH,
  refundsTaken,
  DEPENDENCIES,
  run,
  STATE,
  tempDir,
  UNIT,
  UTILITY,
  takeIn,
  inSpace,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const HOME = "fixture-8000000000000001";
const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();

// The home after the lead chose teams, every Unit open, pushed for the teams.
function homeWithTeams(dependencies?: string) {
  const home = makeHome(dependencies === undefined ? {} : { dependencies });
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "teams"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  return home;
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
  return run(UNIT, ["take", unit, "--home", HOME, ...extra], dir);
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
    expect(ask.question).toBe(
      "fixture is built by teams. Ready to take: refunds (open; likely checkout-api, billing), " +
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
    expect(choices[0].command).toEndWith(`aidlc-unit.ts take refunds --home ${HOME}`);
    expect(choices[2].command).toEndWith(`next --pick ${HOME}`);
  });

  // A live run: every teammate's first screen offered to carry the lead's whole work on.
  test("only the checkout that made the plan is offered to carry the work on as its home, never a clone under the lead's git name", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
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
    expect(String(words.message), JSON.stringify(words).slice(0, 500)).toContain(`take refunds --home ${HOME}`);
    expect(String(words.message)).not.toContain("--team");
    // A Unit not ready to take is said where it stands, never sent on as new work.
    expect(String(words.message)).toContain("tell them in one line where it stands");
    // Nor do the lead's own commands ride a step in this clone.
    expect(String(words.board_note ?? "")).not.toContain("assign <unit>=<team>");
  });

  test("the lead on a second machine: their own word that they lead this work, recorded, puts the lead's questions there again", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
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

  // A live run on Codex: after the Units offer, a teammate's words about their
  // own Unit got the pick of the lead's whole work, which selected it in their
  // clone and put the lead's own questions to them.
  test("a teammate's words after the Units offer are read against its choices, never the pick of the lead's work", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    expect(next(alice, chat, ["hi, what is ours to build?"]).ask_type).toBe("unit-take");
    const words = next(alice, chat, ["refunds is ours, we want to start it now"]);
    expect(words.kind, JSON.stringify(words).slice(0, 600)).toBe("print");
    expect(String(words.message)).not.toContain("--pick");
    expect(String(words.message)).toContain(`take refunds --home ${HOME}`);
    expect(String(words.message)).not.toContain("--team");
    // The lead's work is switched to only on their own word that they lead it.
    expect(String(words.message)).toContain("If they say they lead this work and ask to carry it on here, run");
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
    const command = `bun .claude/tools/aidlc-unit.ts take refunds --home ${HOME}`;
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
    const took = run(UNIT, ["take", "refunds", "--home", HOME], bea, chat);
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
    const alice = cloneOf(home.remote, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    // The chat's first look offers refunds; the take, the build and the push all run in that chat.
    expect(next(alice, chat).ask_type).toBe("unit-take");
    expect(takeIn("payments", ["refunds", "--home", HOME], alice, chat).status).toBe(0);
    const record = buildDir(alice, "payments", "refunds");
    codeGenerated(alice, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], alice, chat);
    expect(pushed.status, pushed.out).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
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
    const ana = cloneOf(home.remote, "ana");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, ana, name, "ana");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "ana-chat" };
    const took = run(UNIT, ["take", "refunds", "--home", HOME], ana, chat);
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
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
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
    const alice = cloneOf(home.remote, "alice");
    const step = next(alice);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    // Nothing of the home's work runs here, and a teammate is offered nothing of it.
    expect(step.offers, JSON.stringify(step)).toBeUndefined();
    expect(step.message).toBe("Say the line above, then end the turn.");
    expect(step.narration).toBe(
      "fixture is built by teams. The walking skeleton, orders, is built at the lead's project first. " +
        "Waiting: refunds (on orders), checkout-ui (on orders), reporting (on orders, refunds). " +
        "Nothing is ready to take yet.",
    );
    expect(git(alice, ["status", "--porcelain"])).toBe("");
  });

  test("a clone a day old hears the claims as the home has them now: a Unit whose dependency merged since opens, with no fetch by hand", () => {
    const { hosts, home, alice, record } = refundsTaken();
    // dana of data cloned before refunds was done, and looks while it waits.
    const dana = cloneOf(home.remote, "dana");
    inSpace(dana, "data");
    // web's clone took checkout-ui meanwhile.
    expect(takeFrom("web", cloneOf(home.remote, "wen"), "checkout-ui").status).toBe(0);
    const waiting = next(dana);
    expect(waiting.kind, JSON.stringify(waiting)).toBe("print");
    expect(waiting.narration).toBe(
      "fixture is built by teams. Waiting: reporting (on refunds). Being built: refunds " +
        "(by alice in payments), checkout-ui (by wen in web). Nothing is ready to take yet.",
    );
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    const ready = next(dana);
    expect(ready.ask_type, JSON.stringify(ready)).toBe("unit-take");
    expect((ready.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start reporting");
    expect(ready.change_notices ?? []).toEqual([]);
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
    const before = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds");
    const took = take(alice, "refunds", ["--request-file", "aidlc/.aidlc-engine/request-text/missing.txt"]);
    expect(took.status).not.toBe(0);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toEqual(before);
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    expect(existsSync(intents) && readdirSync(intents).some((name) => name.endsWith("-refunds"))).toBe(false);
  });

  test("one Unit, the home's inputs at their own paths, the home's Inception done, the claim taken", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const took = takeFrom("payments", alice, "refunds");
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ taken: true, unit: "refunds", team: "payments", space: "payments" });
    expect(String(took.json?.notice)).toStartWith(
      "refunds is yours. Its build is its own piece of work here, in the payments space, under your team's rules, " +
        "from what the lead approved.",
    );
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({
      status: "claimed",
      owner: "payments",
      taken_by: "alice",
    });
    const record = buildDir(alice, "payments", "refunds");
    const state = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    expect(field(state, "Unit Build")).toBe("refunds");
    expect(field(state, "Home Location")).toBe(home.remote);
    expect(field(state, "Home Record")).toBe(`default/${HOME}`);
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
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("aidlc/spaces/default/memory/project.md");
    const step = next(alice);
    expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("run-stage");
    expect(step.rules_in_context as string[]).toContain("aidlc/spaces/default/memory/project.md");
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
    expect(String(took.json?.notice)).toContain("under your team's rules and the lead's practices, from what the lead approved.");
    const record = buildDir(alice, "payments", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("aidlc/spaces/default/memory/team.md");
    const step = next(alice);
    expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("run-stage");
    expect(step.rules_in_context as string[]).toContain("aidlc/spaces/default/memory/team.md");
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
    const took = run(UNIT, own!.command.replace(/^.*aidlc-unit\.ts /, "").replace("'<the Unit>'", "refunds")
      .split(" ").filter(Boolean), alice);
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
    const alice = cloneOf(home.remote, "alice");
    expect(takeFrom("payments", alice, "refunds", ["--lead-rules"]).status).toBe(0);
    git(alice, ["rm", "-q", "aidlc/spaces/default/memory/team.md"]);
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    const first = run(ORCH, ["next"], alice, chat);
    expect(first.status, first.out).toBe(0);
    const step = next(alice, chat);
    expect(step.kind, JSON.stringify(step).slice(0, 600)).toBe("run-stage");
    expect(step.rules_in_context as string[]).not.toContain("aidlc/spaces/default/memory/team.md");
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
    const dee = cloneOf(home.remote, "dee");
    const ask = next(dee);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const said = JSON.stringify(ask);
    expect(said).not.toContain("--lead-rules");
    expect(said).not.toContain("under your team's own rules only");
    const took = take(dee, "refunds", ["--lead-rules"]);
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("default");
    expect(String(took.json?.notice)).toStartWith("refunds is yours. Its build is its own piece of work here, under your team's rules, from what the lead approved.");
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
    const { home, alice, record } = refundsTaken();
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

  test("a Unit taken while the home is changing the Unit plan is taken on the plan as it stands, said once", () => {
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
    expect(String(took.json?.notice)).toEndWith(
      "The lead is changing the Unit plan (Units Generation is open again there), so refunds is taken on the plan as it stands there.",
    );
  });

  test("a waiting Unit is not taken yet, and the line says when it opens", () => {
    const home = homeWithTeams();
    const waiting = take(cloneOf(home.remote, "carol"), "reporting");
    expect(waiting.status).not.toBe(0);
    expect(waiting.out).toContain("reporting waits on refunds, which is not done at the lead's project yet. It opens once it is done.");
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
    expect(choices[1].command).toEndWith(`aidlc-unit.ts take checkout-ui --home ${HOME}`);
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
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds");
    const again = run(UNIT, ["assign", "--here", "refunds"], home.dir);
    expect(again.json?.notice).toBe("refunds is built here now, no longer open for the teams.");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toEqual(claim);
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
    expect(step.narration).toBe(
      "fixture is built by teams. Being built: refunds (by alice in payments), checkout-ui (by wen). Nothing is ready to take yet.",
    );
  });

  test("a Unit the home started with no claim of its own is not offered, and taking it says it is the home's, with the way on", () => {
    const home = homeWithTeams();
    // The lead asks to build checkout-ui here while their project takes no push: the teams cannot see it yet.
    refusePushes(home.remote);
    const here = run(UNIT, ["assign", "--here", "checkout-ui"], home.dir);
    expect(here.status, here.out).toBe(0);
    expect(String(here.json?.notice)).toStartWith("checkout-ui is built here now. The teams cannot see that yet (");
    expect(String(here.json?.notice)).toEndWith("), so a teammate could still take it meanwhile.");
    takePushes(home.remote);
    const step = next(home.dir);
    expect(step.unit, JSON.stringify(step)).toBe("checkout-ui");
    const started = run(STATE, ["unit", "start", "--stage", "functional-design", "--unit", "checkout-ui"], home.dir);
    expect(started.status, started.out).toBe(0);
    commitAll(home.dir, "checkout-ui started");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const carol = cloneOf(home.remote, "carol");
    const ask = next(carol);
    expect(String(ask.question)).toContain("Being built: checkout-ui (at the lead's project).");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label).filter((label) => label.includes("checkout-ui"))).toEqual([]);
    const refused = takeFrom("web", carol, "checkout-ui");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("checkout-ui is being built at the lead's project, so it is not open to take. Run `");
  });

  test("a take whose team.md names a branch the lead's project lacks says which file named it", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const teamMd = join(alice, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(teamMd, readFileSync(teamMd, "utf-8").replace("## Way of Working\n", "## Way of Working\n\nIntegration branch: `develop`.\n"));
    const refused = takeFrom("payments", alice, "refunds");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain(
      "The lead's project's branch develop, named in aidlc/spaces/default/memory/team.md under Way of Working, could not be fetched from origin",
    );
  });

  test("a teammate who takes before cloning the code repos: the build records the home's repos", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
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
    const resumed = run(UNIT, ["take", "refunds", "--home", HOME], laptop);
    expect(resumed.json?.notice, resumed.out).toBe("Carrying on refunds, your build in the data space.");
    // Another person is told whose build it is, never offered it.
    const bob = cloneOf(home.remote, "bob");
    const theirs = next(bob);
    expect((theirs.choices as Array<{ label: string }>).map((choice) => choice.label)).not.toContain("Carry on refunds");
    expect(String(theirs.question ?? theirs.narration)).toContain("Being built: refunds (being built by alice in data, on another computer).");
    // Asked for in their own words, it is carried on, said once whose it is.
    const asked = run(UNIT, ["take", "refunds", "--home", HOME], bob);
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
    // The lead's own checkout after a pull, which brings the claims too: the teammates' builds are theirs.
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
    const resumed = run(UNIT, ["take", "refunds", "--home", HOME], laptop, chat);
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
    const web = teamWorkspace(home.remote, "web");
    const ask = next(web);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(String(ask.question)).toStartWith(`fixture (the lead's project is at ${home.remote}) is built by teams.`);
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
    expect(git(web, ["for-each-ref", "--format=%(refname)", "refs/aidlc/home/"])).toContain("integration");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ owner: "web", taken_by: "web" });
    expect(next(web).unit).toBe("checkout-ui");
  });

  // A live run (M2b): the team's workspace was the lead's clone with its origin
  // switched; the claim refs the clone kept sent the take to the team's repo.
  test("a clone of the lead's workspace pointed at the team's own repo claims at the lead's project", () => {
    const home = homeWithTeams();
    const web = cloneOf(home.remote, "web");
    git(web, ["fetch", "-q", "origin", "+refs/heads/claim/*:refs/remotes/origin/claim/*"]);
    const host = tempDir("web-host");
    git(host, ["init", "-q", "--bare", "-b", "main"]);
    git(web, ["remote", "set-url", "origin", host]);
    git(web, ["push", "-q", "origin", "main"]);
    const took = takeFrom("web", web, "checkout-ui");
    expect(took.status, took.out).toBe(0);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ owner: "web", taken_by: "web" });
    expect(git(host, ["for-each-ref", "--format=%(refname)", "refs/heads/claim/"])).toBe("");
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
    const took = takeFrom("payments", web, "refunds");
    expect(took.status).not.toBe(0);
    expect(String(took.json?.error)).toContain('starts with "-"');
    expect(existsSync("/tmp/aidlc-no")).toBe(false);
  });

  // A live run: the line sat at the end of the take's own line, and the
  // agent's reply said the take in its own words without it. In a chat it is a
  // line of its own, kept for the reply the turn ends on.
  test("a home that takes no push from here, from a chat: its line is its own, kept for the reply, and the next step carries it", () => {
    const home = homeWithTeams();
    refusePushes(home.remote);
    const pay = teamWorkspace(home.remote, "pay", true);
    const session = "6c7a1d2f-2e3b-4d4c-8f5a-1b2c3d4e5f60";
    const chat: NodeJS.ProcessEnv = { ...ENV, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid) };
    inSpace(pay, "payments");
    const took = run(UNIT, ["take", "refunds", "--home", HOME], pay, chat);
    expect(took.status, took.out).toBe(0);
    expect(took.json?.notice).toBeUndefined();
    const line = "The lead's project takes no push from here (this host takes no push from here (pre-receive hook declined)), so the lead " +
      "and the other teams cannot see that you took refunds until it does; AI-DLC records it there when a push next goes through.";
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
    refusePushes(home.remote);
    const pay = teamWorkspace(home.remote, "pay", true);
    const held = takeFrom("payments", pay, "refunds");
    expect(held.status, held.out).toBe(0);
    expect(String(held.json?.notice)).toContain(
      "The lead's project takes no push from here (this host takes no push from here (pre-receive hook declined)), so the lead " +
        "and the other teams cannot see that you took refunds until it does; AI-DLC records it there when a push next goes through.",
    );
    expect(existsSync(join(buildDir(pay, "payments", "refunds"), "aidlc-state.md"))).toBe(true);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.taken_by).toBeUndefined();
    const openUnit = takeFrom("payments", pay, "reporting");
    expect(openUnit.status, openUnit.out).toBe(0);
    expect(String(openUnit.json?.notice)).toContain("so the lead and the other teams cannot see that you took reporting until it does");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "reporting")).toBeNull();
  });
});

// A probe of teams that push to a fork of the lead's project: the claims went
// where the lead never reads them, the take said the Unit was theirs, and the
// lead's board never showed it. The claims' home is the lead's address; a write
// read back there that is not there is said with today's no-push line.
describe("the claims' home is the lead's address", () => {
  const three = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
    "  - name: checkout-ui\n    depends_on: []\n  - name: reporting\n    depends_on: []\n```\n";
  // A fork on the host: a bare copy, main only (GitHub's default) or every branch.
  function forkOf(bare: string, label: string, allBranches: boolean): string {
    const parent = tempDir(`fork-${label}`);
    const dir = join(parent, `${label}.git`);
    git(parent, ["clone", "-q", "--bare", ...(allBranches ? [] : ["--single-branch", "-b", "main"]), bare, dir]);
    return dir;
  }
  // Option 1's line, the address as git's own To line names it.
  const onFork = (unit: string, fork: string): RegExp =>
    new RegExp(`The lead's project takes no push from you, so your take of ${unit} is on \\S*${basename(fork).replace(".", "\\.")}; ` +
      "the lead and the other teams see it once the lead adds that address to their workspace as a git remote\\.");

  test("a clone that pulls from the lead's project and pushes to a fork: the take says it is on the fork, and the clone keeps no claim the lead does not have", () => {
    const home = homeWithTeams(three);
    refusePushes(home.remote);
    const fork = forkOf(home.remote, "pay-hub-fork", false);
    const pay = cloneOf(home.remote, "pay");
    git(pay, ["remote", "set-url", "--push", "origin", fork]);
    const held = takeFrom("payments", pay, "refunds");
    expect(held.status, held.out).toBe(0);
    expect(String(held.json?.notice)).toMatch(onFork("refunds", fork));
    expect(String(held.json?.notice)).not.toContain("takes no push from here");
    const id8 = fixtureIntentId8(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toBeNull();
    expect(git(pay, ["for-each-ref", "--format=%(refname)", `refs/remotes/origin/claim/${id8}/refunds`]).trim()).toBe("");
  });

  test("a fork that copied the lead's claim branches is not the lead's project: the take says it is on the fork", () => {
    const home = homeWithTeams(three);
    const web = cloneOf(home.remote, "web");
    expect(takeFrom("web", web, "checkout-ui").status).toBe(0);
    refusePushes(home.remote);
    const fork = forkOf(home.remote, "pay-hub-full", true);
    const pay = cloneOf(fork, "pay");
    git(pay, ["remote", "add", "upstream", home.remote]);
    git(pay, ["fetch", "-q", "upstream"]);
    const held = takeFrom("payments", pay, "refunds");
    expect(held.status, held.out).toBe(0);
    expect(String(held.json?.notice)).toMatch(onFork("refunds", fork));
    const id8 = fixtureIntentId8(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toBeNull();
    expect(claimPayload(fork, id8, "refunds")).toMatchObject({ status: "claimed" });
  });

  test("a clone whose own remote does not answer, while the lead's project does: the take asks the lead's project, never a raw git error", () => {
    const home = homeWithTeams(three);
    const web = cloneOf(home.remote, "web");
    expect(takeFrom("web", web, "checkout-ui").status).toBe(0);
    const pay = cloneOf(home.remote, "pay");
    refusePushes(home.remote);
    git(pay, ["remote", "set-url", "origin", join(tempDir("gone"), "pay-fork.git")]);
    const held = takeFrom("payments", pay, "refunds");
    expect(held.out).not.toContain("Unit claim registry read failed");
    expect(held.status, held.out).toBe(0);
    expect(String(held.json?.notice)).toContain(
      "The lead's project takes no push from here (this host takes no push from here (pre-receive hook declined)), so the lead " +
        "and the other teams cannot see that you took refunds until it does",
    );
  });

  test("when neither the lead's project nor the clone's own remote answers: one line says so, and nothing is taken", () => {
    const home = homeWithTeams(three);
    const web = cloneOf(home.remote, "web");
    expect(takeFrom("web", web, "checkout-ui").status).toBe(0);
    const pay = cloneOf(home.remote, "pay");
    git(pay, ["fetch", "-q", "origin"]);
    git(pay, ["remote", "set-url", "origin", join(tempDir("gone"), "pay-fork.git")]);
    const away = `${home.remote}-away`;
    renameSync(home.remote, away);
    try {
      const held = takeFrom("payments", pay, "refunds");
      expect(held.status, held.out).not.toBe(0);
      expect(held.out).toMatch(/Neither the lead's project nor origin answered just now \([^)]+\), so nothing was taken or sent; it goes through when one answers\./);
      expect(held.out).not.toContain("Unit claim registry read failed");
    } finally {
      renameSync(away, home.remote);
    }
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toBeNull();
  });

  // The lead's work with its code repos, teams chosen, shared.
  function forkedLead() {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    return { home, hosts, id8: fixtureIntentId8(home.dir) };
  }
  // A team that forked the lead's project (main only) and clones the fork,
  // with the lead's as upstream, and the code repos beside it.
  function forkedTeam(home: { remote: string }, hosts: Record<string, string>, who: string): { dir: string; fork: string } {
    const fork = forkOf(home.remote, `${who}-hub`, false);
    const dir = cloneOf(fork, who);
    git(dir, ["remote", "add", "upstream", home.remote]);
    git(dir, ["fetch", "-q", "upstream"]);
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, dir, name, who);
    return { dir, fork };
  }
  const resultOnFork = (fork: string): RegExp =>
    new RegExp(`Its result is on \\S*${basename(fork).replace(".", "\\.")} too; the lead's project takes it in at the lead's next look\\.`);

  test("a team that pushes to its fork: the take and the result go there, each said once, and nothing asks to send again", () => {
    const { home, hosts, id8 } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    const took = takeFrom("payments", pay, "refunds");
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toMatch(onFork("refunds", fork));
    expect(claimPayload(fork, id8, "refunds")).toMatchObject({ status: "claimed", taken_by: "pay" });
    expect(claimPayload(home.remote, id8, "refunds")).toBeNull();
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], pay);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice ?? pushed.out);
    expect(said).toMatch(resultOnFork(fork));
    expect(said).not.toContain("send it again");
    expect(claimPayload(fork, id8, "refunds")?.result).toBeDefined();
    expect(claimPayload(home.remote, id8, "refunds")).toBeNull();
    expect(next(pay).ask_type ?? null).not.toBe("unit-push");
  });

  test("the lead adds the team's fork as a remote: the next look takes the take and the result in, and the merge is recorded done", () => {
    const { home, hosts, id8 } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], pay).status).toBe(0);
    takePushes(home.remote);
    git(home.dir, ["remote", "add", "team-a", fork]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "claimed", taken_by: "pay" });
    expect(claimPayload(home.remote, id8, "refunds")?.result).toBeDefined();
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ done: true });
  });

  test("two teams' forks hold a take of one Unit: the first taken in wins, and the other team hears today's line", () => {
    const { home, hosts, id8 } = forkedLead();
    refusePushes(home.remote);
    const ana = forkedTeam(home, hosts, "ana");
    const bea = forkedTeam(home, hosts, "bea");
    expect(takeFrom("payments", ana.dir, "refunds").status).toBe(0);
    expect(takeFrom("web", bea.dir, "refunds").status).toBe(0);
    takePushes(home.remote);
    git(home.dir, ["remote", "add", "team-a", ana.fork]);
    git(home.dir, ["remote", "add", "team-b", bea.fork]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ taken_by: "ana" });
    const look = nextSaying(bea.dir, chatOf("bea-2"));
    expect(look.said).toContain("refunds was taken at the lead's project by ana");
  });

  test("a remote of the lead's that cannot be read is said once in the chat while a Unit is open", () => {
    const { home } = forkedLead();
    git(home.dir, ["remote", "add", "team-a", join(tempDir("gone"), "team-a-hub.git")]);
    const chat = chatOf("lead-gone");
    const first = nextSaying(home.dir, chat);
    expect(first.said).toMatch(/team-a \([^)]*team-a-hub\.git\) could not be read just now \([^)]+\), so a take or result a team sent there is not taken in yet\./);
    expect(nextSaying(home.dir, chat).said).not.toContain("could not be read just now");
  });

  test("a give back and a proposal from a take the fork holds go to the fork, each said once", () => {
    const { home, hosts, id8 } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    const requirements = join(record, "inception", "requirements-analysis", "requirements.md");
    writeFileSync(requirements, `${readFileSync(requirements, "utf-8")}\nFR2 partial refunds.\n`);
    const proposed = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "partial refunds too"], pay);
    expect(proposed.status, proposed.out).toBe(0);
    expect(String(proposed.json?.notice)).toMatch(
      /^Sent your change to the requirements to \S*pay-hub\.git; the lead's project takes it in at the lead's next look\. I'm carrying on with your version here until the lead decides\.$/,
    );
    expect(((claimPayload(fork, id8, "refunds")?.proposals ?? []) as unknown[]).length).toBe(1);
    const back = run(UNIT, ["release", "refunds"], pay);
    expect(back.status, back.out).toBe(0);
    expect(String(back.json?.notice)).toMatch(/^Gave refunds back on \S*pay-hub\.git; the lead's project opens it again at the lead's next look\./);
    expect(claimPayload(fork, id8, "refunds")).toMatchObject({ status: "released" });
    expect(claimPayload(home.remote, id8, "refunds")).toBeNull();
  });

  test("a proposal and then the result, sent to the fork before the lead's next look, both stay there", () => {
    const { home, hosts, id8 } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.remote);
    git(home.dir, ["remote", "add", "team-a", fork]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ taken_by: "pay" });
    refusePushes(home.remote);
    const record = buildDir(pay, "payments", "refunds");
    const requirements = join(record, "inception", "requirements-analysis", "requirements.md");
    writeFileSync(requirements, `${readFileSync(requirements, "utf-8")}\nFR2 partial refunds.\n`);
    const proposed = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "partial refunds too"], pay);
    expect(proposed.status, proposed.out).toBe(0);
    expect(String(proposed.json?.notice)).toContain("Sent your change to the requirements to ");
    codeGenerated(pay, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], pay);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice ?? pushed.out)).toMatch(resultOnFork(fork));
    const there = claimPayload(fork, id8, "refunds");
    expect(there?.result).toBeDefined();
    expect(((there?.proposals ?? []) as unknown[]).length).toBe(1);
  });

  test("after the person's own fetch brings the fork's copy of the take, the push still sends the result to the fork", () => {
    const { home, hosts, id8 } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(pay, ["fetch", "-q", "origin"]);
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], pay);
    expect(pushed.status, pushed.out).toBe(0);
    const said = String(pushed.json?.notice ?? pushed.out);
    expect(said).toMatch(resultOnFork(fork));
    expect(said).not.toContain("send it again");
    expect(claimPayload(fork, id8, "refunds")?.result).toBeDefined();
  });

  test("once the lead's project records the Unit done, a team clone whose origin holds an older copy reads it done", () => {
    const { home, hosts, id8 } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], pay).status).toBe(0);
    takePushes(home.remote);
    git(home.dir, ["remote", "add", "team-a", fork]);
    next(home.dir);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ done: true });
    // The fork still holds the result without done; the team's clone has both copies.
    git(pay, ["fetch", "-q", "origin"]);
    writeFileSync(join(pay, "aidlc", "spaces", "payments", "intents", "active-intent"), "");
    const look = next(pay, chatOf("pay-after-merge"));
    expect(String(look.question ?? ""), JSON.stringify(look).slice(0, 900)).not.toContain("refunds (pushed by pay");
  });

  test("a lead's look that this .git cannot write in this session says so, never that the team's remote could not be read", () => {
    const { home, hosts } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.remote);
    git(home.dir, ["remote", "add", "team-a", fork]);
    const head = join(home.dir, ".git", "FETCH_HEAD");
    if (!existsSync(head)) writeFileSync(head, "");
    chmodSync(head, 0o444);
    try {
      const look = nextSaying(home.dir, chatOf("lead-readonly"));
      expect(look.said).not.toContain("could not be read just now");
      expect(look.said).toContain("this workspace's .git cannot be written in this session");
    } finally {
      chmodSync(head, 0o644);
    }
  });

  test("a lead whose one remote is not called origin adds the team's fork as the take line says: the next look takes it in", () => {
    const { home, hosts, id8 } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.remote);
    git(home.dir, ["remote", "rename", "origin", "github"]);
    git(home.dir, ["remote", "add", "team-a", fork]);
    const look = run(ORCH, ["next"], home.dir);
    expect(look.out).not.toContain("Multiple git remotes are configured");
    expect(look.status, look.out).toBe(0);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ taken_by: "pay" });
  });

  // A host that takes only commits its pusher committed (the lead's push of a
  // team's own commit is refused; a team's push is refused too).
  function committedByPusher(bare: string): void {
    const hook = join(bare, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do\n  for c in $(git rev-list \"$new\" --not --all); do\n" +
      "    if [ \"$(git log -1 --format=%ce \"$c\")\" != \"lead@example.test\" ]; then echo 'commits here must be committed by their pusher' >&2; exit 1; fi\n" +
      "  done\ndone\nexit 0\n");
    chmodSync(hook, 0o755);
  }
  const claimTip = (bare: string, id8: string, unit: string): string =>
    git(bare, ["rev-parse", `refs/heads/claim/${id8}/${unit}`]).trim();

  test("a host that takes only its pusher's commits: the take-in is the lead's own commit, with the team's claim, author and date", () => {
    const { home, hosts, id8 } = forkedLead();
    committedByPusher(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(home.dir, ["remote", "add", "team-a", fork]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "claimed", taken_by: "pay" });
    const tip = claimTip(home.remote, id8, "refunds");
    expect(git(home.remote, ["log", "-1", "--format=%ce %ae", tip]).trim()).toBe("lead@example.test pay@example.test");
    expect(git(home.remote, ["log", "-1", "--format=%aI", tip]).trim()).toBe(git(fork, ["log", "-1", "--format=%aI", claimTip(fork, id8, "refunds")]).trim());
  });

  test("after the lead took the take in, the team's result on its fork is taken in too, and the merge is recorded done", () => {
    const { home, hosts, id8 } = forkedLead();
    committedByPusher(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(home.dir, ["remote", "add", "team-a", fork]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ taken_by: "pay" });
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], pay);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice ?? pushed.out)).toMatch(resultOnFork(fork));
    next(home.dir, chatOf("lead-after-result"));
    expect(claimPayload(home.remote, id8, "refunds")?.result).toBeDefined();
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir, chatOf("lead-after-merge"));
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ done: true });
  });

  // A live run (the fork leg, runs A and B): the lead approved a team's change
  // its fork had sent; the same question came back at every later look, and
  // each Approve was refused as having nothing waiting.
  const REQUIREMENTS = "inception/requirements-analysis/requirements.md";
  function proposedOnFork() {
    const { home, hosts, id8 } = forkedLead();
    committedByPusher(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(home.dir, ["remote", "add", "team-a", fork]);
    next(home.dir, chatOf("lead-take"));
    const record = buildDir(pay, "payments", "refunds");
    const requirements = join(record, ...REQUIREMENTS.split("/"));
    writeFileSync(requirements, `${readFileSync(requirements, "utf-8")}\nFR2 partial refunds.\n`);
    const proposed = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "partial refunds too"], pay);
    expect(proposed.status, proposed.out).toBe(0);
    expect(String(proposed.json?.notice)).toContain("Sent your change to the requirements to ");
    const chat = chatOf("lead-decides");
    const ask = next(home.dir, chat);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-amend");
    return { home, pay, fork, id8, chat };
  }
  const answeredThere = (bare: string, id8: string): string[] =>
    ((claimPayload(bare, id8, "refunds")?.proposals ?? []) as Array<{ answer?: string }>).map((entry) => entry.answer ?? "open");

  for (const [label, answer, said] of [
    ["approves", "approve", "yes, partial refunds"],
    ["turns down", "reject", "no, full refunds only"],
  ] as const) {
    test(`the lead ${label} a change its team's fork sent: never asked again, with the fork up or down, and nothing to answer twice`, () => {
      const { home, fork, id8, chat } = proposedOnFork();
      appendAuditEntry("HUMAN_TURN", { "Person Reply": said }, home.dir);
      const answered = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", answer, "--person-words", said], home.dir);
      expect(answered.status, answered.out).toBe(0);
      expect(answeredThere(home.remote, id8)).toEqual([answer === "approve" ? "approved" : "turned down"]);
      // The next bare look, in the same chat after the person's next message, then in a new chat.
      appendAuditEntry("HUMAN_TURN", { "Person Reply": "where are we" }, home.dir);
      for (const env of [chat, chatOf("lead-later")]) {
        const look = next(home.dir, env);
        expect(look.ask_type ?? null, JSON.stringify(look).slice(0, 600)).not.toBe("unit-amend");
        expect(JSON.stringify(look)).not.toContain("proposes a change to the requirements");
      }
      expect(answeredThere(home.remote, id8)).toEqual([answer === "approve" ? "approved" : "turned down"]);
      // The fork's host down: still nothing asked.
      const away = `${fork}-away`;
      renameSync(fork, away);
      try {
        const look = next(home.dir, chatOf("lead-fork-down"));
        expect(look.ask_type ?? null, JSON.stringify(look).slice(0, 600)).not.toBe("unit-amend");
        expect(JSON.stringify(look)).not.toContain("proposes a change to the requirements");
      } finally {
        renameSync(away, fork);
      }
      // A later Approve has nothing to answer, and none is needed.
      const again = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes"], home.dir);
      expect(again.out).toContain("has no change to");
    });
  }

  test("the lead says Not now to a change its team's fork sent: it waits, asked once, on the board until answered", () => {
    const { home, id8, chat } = proposedOnFork();
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
    const look = next(home.dir, chat);
    expect(look.ask_type ?? null, JSON.stringify(look).slice(0, 600)).not.toBe("unit-amend");
    expect(answeredThere(home.remote, id8)).toEqual(["open"]);
    const answered = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "yes"], home.dir);
    expect(answered.status, answered.out).toBe(0);
    expect(answeredThere(home.remote, id8)).toEqual(["approved"]);
  });

  test("a give back after the take-in, then a new take on the same fork: each is taken in at the lead's next look", () => {
    const { home, hosts, id8 } = forkedLead();
    committedByPusher(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(home.dir, ["remote", "add", "team-a", fork]);
    next(home.dir);
    const back = run(UNIT, ["release", "refunds"], pay);
    expect(back.status, back.out).toBe(0);
    expect(String(back.json?.notice)).toMatch(/^Gave refunds back on /);
    next(home.dir, chatOf("lead-after-give-back"));
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "released" });
    const again = takeFrom("payments", pay, "refunds");
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toMatch(onFork("refunds", fork));
    next(home.dir, chatOf("lead-after-new-take"));
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "claimed", taken_by: "pay" });
  });

  test("a fork's stale copy of a claim the lead's project has moved past is never taken in", () => {
    const { home, id8 } = forkedLead();
    const web = cloneOf(home.remote, "web");
    expect(takeFrom("web", web, "refunds").status).toBe(0);
    const stale = forkOf(home.remote, "team-b-hub", true);
    expect(run(UNIT, ["release", "refunds"], web).status).toBe(0);
    const moved = claimTip(home.remote, id8, "refunds");
    git(home.dir, ["remote", "add", "team-b", stale]);
    next(home.dir);
    expect(claimTip(home.remote, id8, "refunds")).toBe(moved);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "released" });
  });

  test("a take-in the lead's project refuses is said once in the lead's chat, with git's reason", () => {
    const { home, hosts } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(home.dir, ["remote", "add", "team-a", fork]);
    const chat = chatOf("lead-refused");
    expect(nextSaying(home.dir, chat).said).toContain(
      "refunds's take or result on team-a could not be taken in here (this host takes no push from here (pre-receive hook declined)), " +
        "so the other teams do not see it yet.",
    );
    expect(nextSaying(home.dir, chat).said).not.toContain("could not be taken in here");
  });

  test("a take-in the lead's git cannot commit (signing that fails) is said once, with git's reason", () => {
    const { home, hosts } = forkedLead();
    committedByPusher(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(home.dir, ["remote", "add", "team-a", fork]);
    git(home.dir, ["config", "commit.gpgsign", "true"]);
    git(home.dir, ["config", "user.signingkey", "no-such-key-for-this-test"]);
    const said = nextSaying(home.dir, chatOf("lead-signing")).said;
    expect(said).toMatch(/refunds's take or result on team-a could not be taken in here \([^)]+\), so the other teams do not see it yet\./);
  });

  test("a take after a give back the lead has not looked at yet goes on top of it on the fork, and is taken in", () => {
    const { home, hosts, id8 } = forkedLead();
    refusePushes(home.remote);
    const { dir: pay, fork } = forkedTeam(home, hosts, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    const back = run(UNIT, ["release", "refunds"], pay);
    expect(back.status, back.out).toBe(0);
    expect(String(back.json?.notice)).toMatch(/^Gave refunds back on /);
    const again = takeFrom("payments", pay, "refunds");
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toMatch(onFork("refunds", fork));
    expect(claimPayload(fork, id8, "refunds")).toMatchObject({ status: "claimed", taken_by: "pay" });
    takePushes(home.remote);
    git(home.dir, ["remote", "add", "team-a", fork]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ status: "claimed", taken_by: "pay" });
  });

  test("a teammate on the same team repo is told who holds a take the lead's project has not recorded yet", () => {
    const { home, hosts } = forkedLead();
    refusePushes(home.remote);
    const ana = forkedTeam(home, hosts, "ana");
    expect(takeFrom("payments", ana.dir, "refunds").status).toBe(0);
    const abe = cloneOf(ana.fork, "abe");
    git(abe, ["remote", "add", "upstream", home.remote]);
    git(abe, ["fetch", "-q", "upstream"]);
    const took = takeFrom("payments", abe, "refunds");
    expect(took.status, took.out).not.toBe(0);
    expect(took.out).toContain("refunds is already taken: ana builds it");
  });

  test("at the lead's project, another remote's older copy of a claim never hides the lead's own: the merged Unit is recorded done", () => {
    const { hosts, home, alice, record } = refundsTaken();
    const id8 = fixtureIntentId8(home.dir);
    const stale = forkOf(home.remote, "team-a-hub", true);
    codeGenerated(alice, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["remote", "add", "team-a", stale]);
    git(home.dir, ["fetch", "-q", "team-a"]);
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(claimPayload(home.remote, id8, "refunds")).toMatchObject({ done: true });
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
    const alice = cloneOf(home.remote, "alice");
    cloneCode(hosts["checkout-api"], alice, "checkout-api", "alice");
    const took = takeIn("payments", ["refunds", "--home", HOME], alice);
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
    const alice = cloneOf(home.remote, "alice");
    const mine = tempDir("alice-code");
    cloneCode(hosts["checkout-api"], mine, "api", "alice");
    // Their own path for checkout-api, with a slip: a trailing comma.
    writeFileSync(join(alice, "aidlc", "repos.local.json"), `{ "repos": [ { "name": "checkout-api", "path": ${JSON.stringify(join(mine, "api"))} }, ] }\n`);
    const took = takeIn("payments", ["refunds", "--home", HOME], alice);
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
    const alice = cloneOf(home.remote, "alice");
    // Her own copies live beside the workspace, as her repos.local.json says.
    for (const name of ["checkout-api", "billing"]) cloneCode(hosts[name as "billing"], join(alice, ".."), `${name}-mine`, "alice");
    writeFileSync(join(alice, "aidlc", "repos.local.json"), `${JSON.stringify({ repos: [
      { name: "checkout-api", path: "../checkout-api-mine" },
      { name: "billing", path: "../billing-mine" },
    ] })}\n`);
    const onCodex = takeIn("payments", ["refunds", "--home", HOME], alice, { ...ENV, AIDLC_HARNESS_NAME: "codex" });
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
      const alice = cloneOf(home.remote, "alice");
      for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
      return { took: takeIn("payments", ["refunds", "--home", HOME], alice, { ...ENV, AIDLC_HARNESS_NAME: "codex" }) };
    })();
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).not.toContain("--add-dir");
  });

  test("the lead's project recorded under an https address while her clone's origin is the same repo over ssh: her first take, before any claim is there, is recorded through her origin, said once", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    // The lead's origin, as their own clone spells it (Bitbucket Server's https
    // form), where a teammate on ssh has no sign-in.
    const https = "https://git.example.invalid/scm/checkout/workspace.git";
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace(/^- \*\*Home Location\*\*: .*$/m, `- **Home Location**: ${https}`));
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    const took = takeIn("payments", ["refunds", "--home", HOME], alice);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toStartWith("refunds is yours.");
    expect(String(took.json?.notice)).toContain(`The lead's project could not be reached at ${https} (`);
    expect(String(took.json?.notice)).toContain(`), so refunds is recorded at ${home.remote}, where this clone's copy of the lead's plan comes from.`);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ taken_by: "alice" });
    // The claims are there now: her next take reaches them through her origin with nothing said.
    const next2 = takeIn("payments", ["checkout-ui", "--home", HOME], alice);
    expect(next2.status, next2.out).toBe(0);
    expect(next2.out).not.toContain("could not be reached");
    // Her clone's setup is as she made it: no address rewritten.
    expect(spawnSync("git", ["config", "--get-regexp", "^url\\."], { cwd: alice, encoding: "utf-8" }).stdout).toBe("");
  });
});


// A live run on Codex: a teammate cloned the lead's workspace while its remote
// held only the setup commit and the Units held for teams. Their first $aidlc
// was told "Tell me what to build" and wrote AI-DLC's parts of .gitignore and
// AGENTS.md there, which the lead's share then met: their git pull aborted.
describe("a teammate's clone before the lead's project shared its plan", () => {
  const LINE = "The lead's plan has not reached this clone yet, so there is no Unit here to take. Once the lead has " +
    "shared it, run git pull here and I'll offer you the Units.";
  const RISK = "The lead's plan has not reached this clone yet, so there is no Unit here to take, and work you start " +
    "here can stop git pull from bringing the plan in later.";

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
    git(home.remote, ["fetch", "-q", donor.remote, "+refs/heads/claim/*:refs/heads/claim/*"]);
    expect(git(home.remote, ["for-each-ref", "--format=%(refname)", "refs/heads/claim/"])).not.toBe("");
    const bob = cloneOf(home.remote, "bob");
    const host = hostFor("codex", bob, GIT_ENV);
    host.sessionStart("startup");
    return { home, bob, host, orch: join(bob, ".codex", "tools", "aidlc-orchestrate.ts") };
  }

  test("the first chat writes no root file, a bare /aidlc says the plan is not here yet, and the lead's share pulls in", () => {
    const { home, bob, orch } = leadNotSharedYet({ "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") });
    expect(git(bob, ["status", "--porcelain", "--", ".gitignore", "AGENTS.md"])).toBe("");
    const first = next(bob, ENV, [], orch);
    expect(first.narration, JSON.stringify(first)).toBe(LINE);
    // The lead's own checkout, with its record, is never read as such a clone.
    expect(leadsPlanNotHere(bob)).toBe(true);
    expect(leadsPlanNotHere(home.dir)).toBe(false);
    // AI-DLC's own working files ignore themselves from inside aidlc/: git shows them nothing, and a commit of
    // everything sweeps none of them in.
    expect(existsSync(join(bob, "aidlc", ".gitignore"))).toBe(true);
    expect(git(bob, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(git(bob, ["add", "-A", "--dry-run"])).toBe("");
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const pulled = spawnSync("git", ["pull", "-q"], { cwd: bob, encoding: "utf-8", env: GIT_ENV });
    expect(pulled.status, pulled.stderr).toBe(0);
    // With the plan in, the teammate's own build record shows and commits as anywhere.
    const took = takeFrom("payments", bob, "refunds");
    expect(took.status, took.out).toBe(0);
    const state = join(buildDir(bob, "payments", "refunds"), "aidlc-state.md");
    expect(spawnSync("git", ["check-ignore", "-q", state], { cwd: bob }).status).toBe(1);
    expect(git(bob, ["status", "--porcelain"])).toContain("aidlc/spaces/payments/");
  });

  function planPulled(home: { dir: string }, bob: string): void {
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
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

  test("a teammate's words there go on as their request with the risk said once, and a bare --resume hears the line", () => {
    const { bob, orch } = leadNotSharedYet({ "checkout-api": codeHost("checkout-api") });
    const words = next(bob, ENV, ["build a refunds report for finance"], orch);
    expect(words.narration, JSON.stringify(words)).not.toBe(LINE);
    expect(words.change_notices, JSON.stringify(words)).toContain(RISK);
    expect(String(words.message)).toContain("build a refunds report for finance");
    expect(next(bob, ENV, ["--resume"], orch).narration).toBe(LINE);
  });
});

// A live run (x2783-s9, Copilot CLI): "We're the storefront team. Can we take
// the refund API instead?" took the payments crew's Unit, held for them by the
// lead, as theirs; "give it back" was refused in the build, and the agent freed
// the Unit at the lead's project, so the lead's hold was gone.
describe("the way back from a take, and the lead's release", () => {
  const id8 = (home: { dir: string }) => fixtureIntentId8(home.dir);

  test("give back in the build: the Unit is open again, the build's record is kept, and the person stays in their space with the Units offered again", () => {
    const home = homeWithTeams();
    const sam = cloneOf(home.remote, "sam");
    const took = takeFrom("payments", sam, "refunds");
    expect(took.status, took.out).toBe(0);
    // Said once, where the take is.
    expect(String(took.json?.notice)).toContain(" If it is not your team's to build, say so and I give it back.");
    const record = buildDir(sam, "payments", "refunds");
    const back = run(UNIT, ["release", "refunds"], sam);
    expect(back.status, back.out).toBe(0);
    expect(back.json?.notice).toBe(
      "refunds is given back: it is open again at the lead's project. Its build here is set aside, with everything in it kept.",
    );
    expect(claimPayload(home.remote, id8(home), "refunds")).toMatchObject({ status: "released" });
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
    expect(claimPayload(home.remote, id8(home), "refunds")).toMatchObject({ status: "claimed", owner: "web", taken_by: "dora" });
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
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ owner: "default", taken_by: "bea" });
  });

  test("a take that asks for a space by name builds there, the space made as space create makes it", () => {
    const home = homeWithTeams();
    const pat = cloneOf(home.remote, "pat");
    const took = take(pat, "refunds", ["--space", "web"]);
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("web");
    expect(String(took.json?.notice ?? "")).toContain("Its build is its own piece of work here, in the web space,");
    expect(existsSync(join(pat, "aidlc", "spaces", "web", "memory", "org.md"))).toBe(true);
    expect(readFileSync(join(pat, "aidlc", "active-space"), "utf-8").trim()).toBe("web");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "web", taken_by: "pat" });
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
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toBeNull();
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

// The lead's work built by teams, with the lead's own rules, pushed for the teams.
function leadWithRules(rules: (dir: string) => void, hosts?: Record<string, string>) {
  const home = makeHome(hosts === undefined ? {} : { repos: hosts });
  rules(home.dir);
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  commitAll(home.dir, "teams");
  git(home.dir, ["push", "-q", "origin", "main"]);
  return home;
}

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

describe("a team's own workspace that holds no copy of the lead's", () => {
  test("the lead's address, said once: the Units and the lead's rules are offered, the take builds in default, the claim and the push reach the lead", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = leadWithRules((dir) =>
      addRule(dir, "project.md", "Release Checks", "Every handler ships with a contract test."), hosts);
    const pay = freshTeamWorkspace("pay");
    cloneCode(hosts["checkout-api"], pay.dir, "checkout-api", "pay");
    const ask = next(pay.dir, ENV, ["--lead-address", home.remote]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-take");
    expect(String(ask.question)).toStartWith(`fixture (the lead's project is at ${home.remote}) is built by teams.`);
    const choices = ask.choices as Array<{ label: string; command?: string; detail?: string }>;
    const start = choices.find((choice) => choice.label === "Start refunds");
    expect(start, choices.map((choice) => choice.label).join(" | ")).toBeDefined();
    // A Windows path is quoted for the shell.
    expect(start!.command?.replaceAll("'", "")).toContain(`--from ${home.remote}`);
    expect(start!.command).toEndWith("--lead-rules");
    // The lead's rules, named from the lead's project, never this workspace's own files.
    expect(start!.detail).toContain("The lead's project rules (Release Checks) apply to its build too");
    const took = run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME, "--lead-rules"], pay.dir);
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ team: "default", space: "default" });
    expect(String(took.json?.notice ?? "")).not.toContain("default");
    // No remote and no folder of the lead's: AI-DLC's own refs only.
    expect(git(pay.dir, ["remote"])).toBe("origin");
    expect(existsSync(join(pay.dir, "aidlc", "spaces", "default", "intents", HOME))).toBe(false);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "default", taken_by: "pay" });
    expect(git(pay.host, ["for-each-ref", "--format=%(refname)", "refs/heads/claim/"])).toBe("");
    const record = buildDir(pay.dir, "default", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("aidlc/spaces/default/memory/project.md");
    // billing is not here and this workspace lists no repos: the lead's list gives its address.
    const offer = next(pay.dir);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 600)).toBe("unit-clone");
    expect(String(offer.question)).toBe(`billing is not here yet; the lead's list has it at ${hosts.billing}. Do you want me to clone it here?`);
    const clone = (offer.choices as Array<{ label: string; command?: string }>)[0];
    expect(clone.label).toBe("Clone billing");
    expect(clone.command?.replaceAll("'", "")).toEndWith(`intent add-repo billing --url ${hosts.billing}`);
    const cloned = run(UTILITY, ["intent", "add-repo", "billing", "--url", hosts.billing], pay.dir);
    expect(cloned.status, cloned.out).toBe(0);
    git(join(pay.dir, "billing"), ["config", "user.name", "pay"]);
    git(join(pay.dir, "billing"), ["config", "user.email", "pay@example.test"]);
    let looked = nextSaying(pay.dir);
    // This workspace lists no repos yet: writing its own list is offered once.
    if (looked.step.ask_type === "repos-manifest") looked = nextSaying(pay.dir);
    expect(looked.step.kind, JSON.stringify(looked.step).slice(0, 400)).toBe("run-stage");
    expect(looked.step.rules_in_context as string[]).toContain("the lead's aidlc/spaces/default/memory/project.md");
    expect(looked.said).toContain("Every handler ships with a contract test.");
    // Later turns read the lead from the build: the push reaches the lead's claim.
    codeGenerated(pay.dir, record);
    const pushed = run(UNIT, ["push"], pay.dir);
    expect(pushed.status, pushed.out).toBe(0);
    expect((claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { result?: unknown }).result).toBeDefined();
  });

  test("the lead's rules are the lead's, read where they are: never the team's own default files, and a change the lead pushes reaches the next chat's step", () => {
    const home = leadWithRules((dir) =>
      addRule(dir, "team.md", "Refund Amount", "Test first for the refund amount."));
    const pay = freshTeamWorkspace("pay");
    addRule(pay.dir, "project.md", "Payments Checks", "Our own payments rule.");
    commitAll(pay.dir, "our rules");
    const took = run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME, "--lead-rules"], pay.dir);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("under your team's rules and the lead's practices, from what the lead approved.");
    const record = buildDir(pay.dir, "default", "refunds");
    // The lead holds practices and no project rules; the team's own project.md is never named as the lead's.
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("aidlc/spaces/default/memory/team.md");
    const first = nextSaying(pay.dir, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-chat-1" });
    expect(first.step.kind, JSON.stringify(first.step).slice(0, 400)).toBe("run-stage");
    const rules = first.step.rules_in_context as string[];
    expect(rules).toContain("the lead's aidlc/spaces/default/memory/team.md");
    expect(rules).toContain("aidlc/spaces/default/memory/project.md");
    expect(first.said).toContain("Test first for the refund amount.");
    expect(first.said).toContain("Our own payments rule.");
    expect(first.said).not.toContain(UNREAD);
    // The lead changes the rule: the team's next chat follows it, with no word about it.
    const leadTeam = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(leadTeam, readFileSync(leadTeam, "utf-8").replace("Test first for the refund amount.", "Test first for every amount."));
    commitAll(home.dir, "practices");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const later = nextSaying(pay.dir, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-chat-2" });
    expect(later.said).toContain("Test first for every amount.");
    expect(later.said).not.toContain("Test first for the refund amount.");
  });

  test("taken with the lead's practices from the lead's address, the testing contract follows the lead's Testing Posture", () => {
    const home = leadWithRules((dir) => {
      const practices = join(dir, "aidlc", "spaces", "default", "memory", "team.md");
      writeFileSync(practices, readFileSync(practices, "utf-8").replace("## Testing Posture\n", "## Testing Posture\nTDD: the refund amount's tests are written first and must fail.\n"));
    });
    const pay = freshTeamWorkspace("pay");
    expect(run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME, "--lead-rules"], pay.dir).status).toBe(0);
    const posture = JSON.parse(run(join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), ["resolve"], pay.dir).out) as { methodology: string; source: string };
    expect(posture).toMatchObject({ methodology: "tdd", source: "team" });
  });

  test("the lead's rules cannot be read: the step goes on under the team's own rules and says so once", () => {
    const home = leadWithRules((dir) =>
      addRule(dir, "team.md", "Refund Amount", "Test first for the refund amount."));
    const pay = freshTeamWorkspace("pay");
    expect(run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME, "--lead-rules"], pay.dir).status).toBe(0);
    // The lead's project is gone from where it was, and its copy here with it.
    renameSync(home.remote, `${home.remote}-moved`);
    git(pay.dir, ["update-ref", "-d", `refs/aidlc/home/${fixtureIntentId8(home.dir)}/integration`]);
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-chat" };
    const first = nextSaying(pay.dir, chat);
    expect(first.step.kind, JSON.stringify(first.step).slice(0, 600)).toBe("run-stage");
    expect(first.step.rules_in_context as string[]).not.toContain("the lead's aidlc/spaces/default/memory/team.md");
    expect(first.said).toContain(`The lead's practices ${UNREAD}`);
    const again = nextSaying(pay.dir, chat);
    expect(again.said).not.toContain(UNREAD);
  });

  test("a second teammate's clone carries the build on when they ask: its first step reads the lead's rules, and the lead is read from the build", () => {
    const home = leadWithRules((dir) =>
      addRule(dir, "team.md", "Refund Amount", "Test first for the refund amount."));
    const pay = freshTeamWorkspace("pay");
    expect(run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME, "--lead-rules"], pay.dir).status).toBe(0);
    commitAll(pay.dir, "refunds taken");
    git(pay.dir, ["push", "-q", "origin", "main"]);
    const pay2 = cloneOf(pay.host, "pay2");
    // A fresh clone: nothing of AI-DLC's own refs came with it.
    expect(git(pay2, ["for-each-ref", "--format=%(refname)", "refs/aidlc/"])).toBe("");
    // Its first look: the build is said with who took it, the lead read from the build, the address never asked for.
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "pay2-chat" };
    const offer = next(pay2, chat);
    expect(String(offer.question ?? offer.narration), JSON.stringify(offer).slice(0, 400)).toContain("refunds (being built by pay, on another computer)");
    expect((offer.choices as Array<{ label: string }> | undefined ?? []).map((choice) => choice.label)).not.toContain("Carry on refunds");
    // A live run on Codex (the second teammate): the person asked to carry it
    // on and no step named a way to; the step now names the command, never as a choice.
    const carryOn = /When their words ask to carry on a build the question lists as being built, run its command: refunds: `([^`]+)`/
      .exec(String(offer.question_note ?? offer.board_note ?? ""))?.[1];
    // Quoted as every take command in the question is (a Windows path is).
    expect(carryOn, JSON.stringify(offer).slice(0, 1600)).toBe(`bun .claude/tools/aidlc-unit.ts take refunds --from ${shellArg(home.remote)} --home ${HOME}`);
    // Asked for in their words, it is carried on, said once whose it is.
    const took = run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME], pay2, chat);
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ resumed: true, space: "default" });
    expect(String(took.json?.notice ?? "")).not.toContain("default");
    const first = nextSaying(pay2, chat);
    expect(first.step.kind, JSON.stringify(first.step).slice(0, 600)).toBe("run-stage");
    expect(first.step.stage).toBe("functional-design");
    // Nothing is asked twice: the take question is not put again.
    expect(first.step.ask_type).toBeUndefined();
    expect(first.step.rules_in_context as string[]).toContain("the lead's aidlc/spaces/default/memory/team.md");
    expect(first.said).toContain("Test first for the refund amount.");
    expect(first.said).not.toContain(UNREAD);
  });

  test("after its first Unit is pushed, the build's next step offers the lead's next Unit with no address said again; a fresh clone of the team's workspace is offered it too", () => {
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-chat" };
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = leadWithRules(() => {}, hosts);
    const pay = freshTeamWorkspace("pay");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay.dir, name, "pay");
    expect(run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME], pay.dir, chat).status).toBe(0);
    const record = buildDir(pay.dir, "default", "refunds");
    codeGenerated(pay.dir, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], pay.dir, chat);
    expect(pushed.status, pushed.out).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    const offered = next(pay.dir, chat);
    expect(offered.ask_type, JSON.stringify(offered).slice(0, 600)).toBe("unit-take");
    const start = (offered.choices as Array<{ label: string; command?: string }>).find((choice) => choice.label.startsWith("Start reporting"));
    expect(start, JSON.stringify(offered.choices)).toBeDefined();
    expect(start!.command?.replaceAll("'", "")).toContain(`--from ${home.remote}`);
    commitAll(pay.dir, "refunds pushed");
    git(pay.dir, ["push", "-q", "origin", "main"]);
    const pay2 = cloneOf(pay.host, "pay2");
    const fresh = next(pay2, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay2-chat" });
    expect(fresh.ask_type, JSON.stringify(fresh).slice(0, 600)).toBe("unit-take");
    expect((fresh.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start reporting");
  });

  // The hook that briefs a stage's subagent resolves the same bundle the step carries.
  test("a subagent's brief in the team's build carries the lead's rules, read from the lead's project", () => {
    const home = leadWithRules((dir) =>
      addRule(dir, "team.md", "Refund Amount", "Test first for the refund amount."));
    const pay = freshTeamWorkspace("pay");
    expect(run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME, "--lead-rules"], pay.dir).status).toBe(0);
    const node = loadGraph().find((stage) => stage.slug === "functional-design")!;
    const bundle = resolvedRuleBundle(node, pay.dir);
    expect(bundle.error).toBeNull();
    const lead = bundle.content.find((entry) => entry.path === "the lead's aidlc/spaces/default/memory/team.md");
    expect(lead?.text, bundle.content.map((entry) => entry.path).join(", ")).toContain("Test first for the refund amount.");
  });

  test("the lead's address with nothing shared yet says so, and takes nothing", () => {
    const home = makeHome();
    const pay = freshTeamWorkspace("pay");
    const ask = next(pay.dir, ENV, ["--lead-address", home.remote]);
    expect(JSON.stringify(ask)).toContain("has no work built by teams on its branch yet");
    const intents = join(pay.dir, "aidlc", "spaces", "default", "intents");
    expect(existsSync(intents) ? readdirSync(intents).filter((name) => name !== "intents.json") : []).toEqual([]);
  });

  test("in a clone whose origin is the lead's, the lead's address said anyway takes the local route, with no fetch by the address", () => {
    const home = homeWithTeams();
    const alice = cloneOf(home.remote, "alice");
    const trace = join(tempDir("trace"), "git.trace");
    const env = { ...ENV, GIT_TRACE: trace };
    const ask = next(alice, env, ["--lead-address", home.remote]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 400)).toBe("unit-take");
    expect((ask.choices as Array<{ command?: string }>).every((choice) => !(choice.command ?? "").includes("--from"))).toBe(true);
    const took = takeIn("payments", ["refunds", "--from", home.remote, "--home", HOME], alice, env);
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ space: "payments" });
    const byAddress = traced(trace).filter((line) => /git (fetch|ls-remote)\b/.test(line) && line.includes(home.remote));
    expect(byAddress, byAddress.join("\n")).toEqual([]);
  });

  test("a take by the lead's address fetches the lead's branch once", () => {
    const home = homeWithTeams();
    const pay = freshTeamWorkspace("pay");
    const trace = join(tempDir("trace"), "git.trace");
    const took = run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME], pay.dir, { ...ENV, GIT_TRACE: trace });
    expect(took.status, took.out).toBe(0);
    const branchFetches = traced(trace).filter((line) => / git fetch /.test(line) && line.includes(home.remote) && !line.includes("claim/"));
    expect(branchFetches, branchFetches.join("\n")).toHaveLength(1);
  });

  // The address the person said can carry a sign-in: the build's record, which
  // the team commits, keeps the address without it, as the lead's own record does.
  test("an address that carries a sign-in is recorded without it", () => {
    const home = homeWithTeams();
    const pay = freshTeamWorkspace("pay");
    const said = "https://pay:s3cret-token@lead.example/shop-ws.git";
    git(pay.dir, ["config", `url.${home.remote}.insteadOf`, said]);
    git(pay.dir, ["config", "--add", `url.${home.remote}.insteadOf`, "https://lead.example/shop-ws.git"]);
    const took = run(UNIT, ["take", "refunds", "--from", said, "--home", HOME], pay.dir);
    expect(took.status, took.out).toBe(0);
    const record = buildDir(pay.dir, "default", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Home Location")).toBe("https://lead.example/shop-ws.git");
    const written = spawnSync("git", ["grep", "--no-index", "-l", "s3cret-token", "--", "aidlc"], { cwd: pay.dir, encoding: "utf-8" });
    expect(written.stdout.trim()).toBe("");
  });

  test("a build carried on with the lead's address said again needs nothing of the lead's project", () => {
    const home = homeWithTeams();
    const pay = freshTeamWorkspace("pay");
    expect(run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME], pay.dir).status).toBe(0);
    renameSync(home.remote, `${home.remote}-moved`);
    const again = run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME], pay.dir);
    expect(again.status, again.out).toBe(0);
    expect(again.json).toMatchObject({ resumed: true, space: "default" });
  });

  test("in a clone of the lead's workspace that is behind, the lead's address said is never answered that nothing is shared", () => {
    const home = makeHome();
    const alice = cloneOf(home.remote, "alice");
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const ask = run(ORCH, ["next", "--lead-address", home.remote], alice);
    expect(ask.status, ask.out).toBe(0);
    expect(ask.out).not.toContain("has no work built by teams");
  });

  // Codex keeps a repository's .git read-only unless its session grants write access.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a .git this session cannot write: the lead's address said gets the way on, never a dead end", () => {
    const home = homeWithTeams();
    const pay = freshTeamWorkspace("pay");
    const dotGit = join(pay.dir, ".git");
    chmodSync(dotGit, 0o555);
    try {
      const ask = run(ORCH, ["next", "--lead-address", home.remote], pay.dir);
      expect(ask.out).toContain("Run the same command again with write access");
    } finally {
      chmodSync(dotGit, 0o755);
    }
  });

  test("an address starting with '-' is refused before any git call, at the take and at the offer", () => {
    homeWithTeams();
    const pay = freshTeamWorkspace("pay");
    const marker = join(tempDir("dash"), "ran");
    const trace = join(tempDir("trace"), "git.trace");
    const env = { ...ENV, GIT_TRACE: trace };
    const took = takeIn("payments", ["refunds", `--from=--upload-pack=touch ${marker}`, "--home", HOME], pay.dir, env);
    expect(took.status).not.toBe(0);
    expect(String(took.json?.error)).toContain('starts with "-"');
    const asked = run(ORCH, ["next", "--lead-address", `-utouch ${marker}`], pay.dir, env);
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

function takePushes(remote: string): void {
  writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
}

const chatOf = (session: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: session });

describe("a take the lead's project could not record then", () => {
  test("recorded at a later look once the lead's project takes pushes, with nothing said about it", () => {
    const home = homeWithTeams();
    refusePushes(home.remote);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    // Still refused: the look says nothing, and nothing is written.
    const still = nextSaying(pay, chatOf("pay-1"));
    expect(still.said).not.toContain("cannot see that you took");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.taken_by).toBeUndefined();
    takePushes(home.remote);
    const later = nextSaying(pay, chatOf("pay-2"));
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "payments", taken_by: "pay", generation: 1 });
    expect(later.said).not.toContain("cannot see that you took");
    expect(later.said).not.toContain("before your take could be recorded");
  });

  // The take went to the team's own workspace repo too (Arden's option 1); the
  // person's own fetch of it then brought that copy under their remote.
  test("after the person's own fetch of their team's repo, a later look still records the take once the lead's project takes pushes", () => {
    const home = homeWithTeams();
    refusePushes(home.remote);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(pay, ["fetch", "-q", "origin"]);
    takePushes(home.remote);
    nextSaying(pay, chatOf("pay-2"));
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "payments", taken_by: "pay", generation: 1 });
  });

  test("open: the claim is made at a later look once the lead's project takes pushes", () => {
    const open = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n  - name: reporting\n    depends_on: []\n```\n";
    const home = homeWithTeams(open);
    refusePushes(home.remote);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "reporting").status).toBe(0);
    takePushes(home.remote);
    next(pay, chatOf("pay-2"));
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "reporting")).toMatchObject({ status: "claimed", owner: "payments", taken_by: "pay" });
  });

  test("released by the lead before it was recorded: recorded at the claim's new attempt, the build's following it", () => {
    const home = homeWithTeams();
    refusePushes(home.remote);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.remote);
    // The lead builds it here meanwhile, then releases it.
    expect(run(UNIT, ["assign", "--here", "refunds"], home.dir).status).toBe(0);
    expect(run(UNIT, ["release", "refunds"], home.dir).status).toBe(0);
    const later = nextSaying(pay, chatOf("pay-2"));
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ status: "claimed", owner: "payments", taken_by: "pay", generation: 2 });
    expect(field(readFileSync(join(buildDir(pay, "payments", "refunds"), "aidlc-state.md"), "utf-8"), "Home Attempt")).toBe("2");
    expect(later.said).not.toContain("before your take could be recorded");
  });

  test("released by the lead before it was recorded, in a clone of the lead's own repo: recorded with nothing said, never as taken by yourself", () => {
    const home = homeWithTeams();
    refusePushes(home.remote);
    const pay = cloneOf(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.remote);
    // The lead builds it here meanwhile, then releases it.
    expect(run(UNIT, ["assign", "--here", "refunds"], home.dir).status).toBe(0);
    expect(run(UNIT, ["release", "refunds"], home.dir).status).toBe(0);
    const chat = chatOf("pay-2");
    const later = nextSaying(pay, chat);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "payments", taken_by: "pay", generation: 2 });
    expect(later.said).not.toContain("was taken at the lead's project by");
    expect(nextSaying(pay, chat).said).not.toContain("was taken at the lead's project by");
  });

  test("a push after the lead released it before it was recorded: the take is recorded, then the result goes on it", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    refusePushes(home.remote);
    const pay = cloneOf(home.remote, "pay");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.remote);
    // The lead builds it here meanwhile, then releases it.
    expect(run(UNIT, ["assign", "--here", "refunds"], home.dir).status).toBe(0);
    expect(run(UNIT, ["release", "refunds"], home.dir).status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    const pushed = run(UNIT, ["push"], pay);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.out).not.toContain("was taken at the lead's project by");
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { taken_by?: string; generation?: number; result?: unknown };
    expect(claim).toMatchObject({ taken_by: "pay", generation: 2 });
    expect(claim.result).toBeDefined();
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Unit Push")).toBe("pushed");
  });

  test("taken by a teammate meanwhile: said once with who and when, their claim never written over, a give back sets the build aside here only", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    refusePushes(home.remote);
    const pay = teamWorkspace(home.remote, "pay");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.remote);
    const pal = teamWorkspace(home.remote, "pal");
    expect(takeFrom("payments", pal, "refunds").status).toBe(0);
    const theirs = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds");
    expect(theirs).toMatchObject({ taken_by: "pal" });
    const today = git(home.remote, ["log", "-1", "--format=%cs", "refs/heads/claim/00000001/refunds"]);
    const chat = chatOf("pay-2");
    const look = nextSaying(pay, chat);
    expect(look.said).toContain(
      `refunds was taken at the lead's project by pal on ${today}, before your take could be recorded there, ` +
        "so the lead and the other teams see theirs, not yours. Your build is still here: agree with pal who carries it on, or give yours back.",
    );
    expect(nextSaying(pay, chat).said).not.toContain("before your take could be recorded");
    const record = buildDir(pay, "payments", "refunds");
    // A change to an approved input is never sent on pal's claim.
    const requirements = join(record, "inception", "requirements-analysis", "requirements.md");
    writeFileSync(requirements, `${readFileSync(requirements, "utf-8")}\nFR2 partial refunds.\n`);
    const proposed = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "partial refunds too"], pay, chat);
    expect(proposed.status, proposed.out).toBe(0);
    expect(String(proposed.json?.notice)).toContain("before your take could be recorded there");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toEqual(theirs);
    // The push sends the code to the team's own repos and no result onto pal's claim, and offers no send again.
    codeGenerated(pay, record);
    const pushed = run(UNIT, ["push"], pay, chat);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice ?? pushed.out)).toContain("before your take could be recorded there");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toEqual(theirs);
    expect(next(pay, chat).ask_type ?? null).not.toBe("unit-push");
    const back = run(UNIT, ["release", "refunds"], pay);
    expect(back.status, back.out).toBe(0);
    expect(back.json?.notice).toBe(
      "Nothing changed for refunds at the lead's project, which still has it as it was. Its build here is " +
        "set aside, with everything in it kept.",
    );
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toEqual(theirs);
  });

  test("a person who changes their git name after their take was recorded is still the one who took it", () => {
    const home = homeWithTeams();
    const pay = cloneOf(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    git(pay, ["config", "user.name", "Pay Person"]);
    const look = nextSaying(pay, chatOf("pay-2"));
    expect(look.said).not.toContain("before your take could be recorded");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ taken_by: "pay" });
  });

  test("its push while the lead's project still takes none: the code goes, the result waits on the way it always has", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    refusePushes(home.remote);
    const pay = teamWorkspace(home.remote, "pay", true);
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    codeGenerated(pay, record);
    const pushed = run(UNIT, ["push"], pay);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice ?? pushed.out)).toContain(
      "The lead's project did not take refunds's result: this host takes no push from here (pre-receive hook declined). Do you want me to send it again?",
    );
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Unit Push")).toBe("unsent");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.taken_by).toBeUndefined();
    // Once the lead's project takes pushes, sending it again records the take, then the result on it.
    takePushes(home.remote);
    expect(run(UNIT, ["push"], pay).status).toBe(0);
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { taken_by?: string; result?: unknown };
    expect(claim.taken_by).toBe("pay");
    expect(claim.result).toBeDefined();
  });

  test("a teammate's clone of the team's workspace says and writes nothing for a take another checkout made", () => {
    const home = homeWithTeams();
    refusePushes(home.remote);
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
    takePushes(home.remote);
    // Pat carries the build on in that clone: its step is the build's own.
    const carried = take(pat, "refunds");
    expect(carried.json, carried.out).toMatchObject({ resumed: true });
    const look = nextSaying(pat, chatOf("pat-1"));
    expect(look.said).not.toContain("before your take could be recorded");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.taken_by).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("with commits signed, a look never signs one to record the take: the push does", () => {
    const home = homeWithTeams();
    refusePushes(home.remote);
    const pay = teamWorkspace(home.remote, "pay");
    expect(takeFrom("payments", pay, "refunds").status).toBe(0);
    takePushes(home.remote);
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
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.taken_by).toBeUndefined();
  });

  test("by the lead's address from a team's own workspace: the take goes on, and is recorded once the lead's project takes pushes", () => {
    const home = homeWithTeams();
    refusePushes(home.remote);
    const pay = freshTeamWorkspace("pay");
    // Nowhere else to send the take: its own host takes no push either.
    refusePushes(pay.host);
    const took = run(UNIT, ["take", "refunds", "--from", home.remote, "--home", HOME], pay.dir);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("so the lead and the other teams cannot see that you took refunds until it does");
    takePushes(home.remote);
    next(pay.dir, chatOf("pay-2"));
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "default", taken_by: "pay" });
  });
});

describe("every Unit is open: whoever takes it builds it where they are, and no team is named", () => {
  // The lead's project once teams are chosen, shared, with no team named.
  function homeOpen() {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    return home;
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
    const pat = cloneOf(home.remote, "pat");
    workIn(pat, "pay");
    const took = take(pat, "refunds");
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("pay");
    expect(String(took.json?.notice ?? "")).toContain("Its build is its own piece of work here, in the pay space,");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "pay", taken_by: "pat" });
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
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ owner: "web", taken_by: "wen" });
    const dee = cloneOf(home.remote, "dee");
    const refunds = take(dee, "refunds");
    expect(refunds.status, refunds.out).toBe(0);
    expect(refunds.json?.space).toBe("default");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ owner: "default", taken_by: "dee" });
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
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ taken_by: "lee" });
    const tom = take(cloneOf(home.remote, "tom"), "refunds");
    expect(tom.status).not.toBe(0);
    expect(tom.out).toContain("refunds is already taken: lee builds it.");
  });
});
