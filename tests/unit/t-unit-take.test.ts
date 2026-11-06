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
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents, readIntentRegistry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { leadsPlanNotHere } from "../../dist/claude/.claude/tools/aidlc-unit-holders.ts";
import { learningsCorrectionChoices, offersLearningsCorrectionChoices } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { fixtureIntentId8, REPO_ROOT } from "../harness/fixtures.ts";
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
  run,
  STATE,
  tempDir,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const HOME = "fixture-8000000000000001";
const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();

// The home after the lead chose teams and named them, pushed for the teams.
function homeWithTeams(assign: string[], dependencies?: string) {
  const home = makeHome(dependencies === undefined ? {} : { dependencies });
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  const assigned = run(UNIT, ["assign", ...assign], home.dir);
  expect(assigned.status, assigned.out).toBe(0);
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "teams"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  return home;
}

// A team's own workspace repo made from the home's: the home's record comes
// with it, its origin is the team's host.
function teamWorkspace(homeRemote: string, label: string): string {
  const seed = cloneOf(homeRemote, `${label}-seed`);
  const host = tempDir(`${label}-host`);
  git(host, ["init", "-q", "--bare", "-b", "main"]);
  git(seed, ["remote", "set-url", "origin", host]);
  git(seed, ["push", "-q", "origin", "main"]);
  return cloneOf(host, label);
}

function take(dir: string, unit: string, extra: string[] = []) {
  return run(UNIT, ["take", unit, "--home", HOME, ...extra], dir);
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
    const home = homeWithTeams(["refunds=payments", "checkout-ui=web"]);
    const ask = next(cloneOf(home.remote, "alice"));
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(ask.response_route).toBe("command");
    expect(ask.question).toBe(
      "fixture is built by teams, one Unit each. Ready to take: refunds (for payments; likely checkout-api, billing), " +
        "checkout-ui (for web; likely checkout-web). Waiting: reporting (on refunds). Taking a Unit starts it as your " +
        "team's own piece of work here, from what the lead approved.",
    );
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual([
      "Start refunds for payments",
      "Start checkout-ui for web",
      "Carry on fixture here, as the lead",
    ]);
    expect(choices[0].command).toEndWith(`aidlc-unit.ts take refunds --home ${HOME} --team payments`);
    expect(choices[2].command).toEndWith(`next --pick ${HOME}`);
  });

  // A live run: every teammate's first screen offered to carry the lead's whole work on.
  test("only the checkout that made the plan is offered to carry the work on as its home, never a clone under the lead's git name", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const labels = (dir: string) => ((next(dir).choices ?? []) as Array<{ label: string }>).map((choice) => choice.label);
    // A clone made under the lead's own git name is a clone all the same.
    expect(labels(cloneOf(home.remote, "lead"))).toEqual(["Start refunds for payments", "Start checkout-ui for web"]);
    // A copy of the lead's checkout keeps its clone id, so the plan's rows are its own.
    const copy = cloneOf(home.remote, "lead-copy");
    cpSync(join(home.dir, "aidlc", ".aidlc-clone-id"), join(copy, "aidlc", ".aidlc-clone-id"));
    expect(labels(copy)).toContain("Carry on fixture here, as the lead");
  });

  // A live run on opencode: its skill enters a bare /aidlc with `next --resume`,
  // which picked up the home's work (the only open work) and showed the lead's
  // board; the take offer never came, and the agent released a team's Unit.
  test("a bare --resume is offered the same Units to take, never the home's work picked up", () => {
    const home = homeWithTeams(["refunds=payments", "checkout-ui=web"]);
    const alice = cloneOf(home.remote, "alice");
    const ask = next(alice, ENV, ["--resume"]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(JSON.stringify(ask)).not.toContain("Picked up");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toEqual([
      "Start refunds for payments",
      "Start checkout-ui for web",
      "Carry on fixture here, as the lead",
    ]);
  });

  // Live runs on Codex, Kiro CLI and Copilot CLI: a teammate's first line with
  // words ("what is ours to build?") got the pick of the work itself, which
  // selected it in their clone and showed them the lead's board.
  // Live runs on Codex: payments' clone selected the lead's work (a pick, an
  // intent switch) and was asked the lead's own hand-off question.
  test("in a clone that did not make the plan, the lead's work selected gets the board and the Units offer, never the lead's questions", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    expect(run(UTILITY, ["intent", "switch", HOME], alice).status).toBe(0);
    const step = next(alice, ENV);
    const said = JSON.stringify(step);
    expect(said, said.slice(0, 600)).not.toContain("as a file");
    expect(said).toContain("Taking a Unit starts it as your team's own piece of work here");
    expect(said).not.toContain("Who builds which Unit");
    // Again in the same chat: still the Units offer, never the lead's walk.
    expect(JSON.stringify(next(alice, ENV))).not.toContain("as a file");
    // Their words there are read against the Units offer, never sent on as the lead's work.
    const words = next(alice, ENV, ["we are the payments team and want to take refunds, our Unit"]);
    expect(String(words.message), JSON.stringify(words).slice(0, 500)).toContain(`take refunds --home ${HOME} --team payments`);
    // A Unit not ready to take is said where it stands, never sent on as new work.
    expect(String(words.message)).toContain("tell them in one line where it stands");
    // Nor do the lead's own commands ride a step in this clone.
    expect(String(words.board_note ?? "")).not.toContain("hand-off <unit>");
  });

  test("the lead on a second machine: their own word that they lead this work, recorded, puts the lead's questions there again", () => {
    const home = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
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
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    asLeadsOwnCheckout(home.dir);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    expect(next(alice, chat, ["hi, what is ours to build?"]).ask_type).toBe("unit-take");
    const words = next(alice, chat, ["refunds is ours, we want to start it now"]);
    expect(words.kind, JSON.stringify(words).slice(0, 600)).toBe("print");
    expect(String(words.message)).not.toContain("--pick");
    expect(String(words.message)).toContain(`take refunds --home ${HOME} --team payments`);
    // The lead's work is switched to only on their own word that they lead it.
    expect(String(words.message)).toContain("If they say they lead this work and ask to carry it on here, run");
  });

  test("a teammate's first words are answered with the Units to take, never the pick of the work itself", () => {
    const home = homeWithTeams(["refunds=payments", "checkout-ui=web"]);
    const alice = cloneOf(home.remote, "alice");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    const ask = next(alice, chat, ["hi, I am on the payments team. what is ours to build?"]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toEqual([
      "Start refunds for payments",
      "Start checkout-ui for web",
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
    const home = homeWithTeams(["refunds=payments", "checkout-ui=payments"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds", ["--team", "payments"]).status).toBe(0);
    const record = buildDir(alice, "payments", "refunds");
    finishBuild(record);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    const ask = next(alice, chat, ["The lead also gave us checkout-ui. Can I start that one now?"]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 500)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start checkout-ui");
    const again = next(alice, chat, ["something else entirely"]);
    expect(again.ask_type ?? null, JSON.stringify(again).slice(0, 300)).not.toBe("unit-take");
    // A new chat's bare /aidlc there gets the same offer first, never "everything is done".
    const bare = next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat-2" });
    expect(bare.ask_type, JSON.stringify(bare).slice(0, 300)).toBe("unit-take");
  });

  // Live run on Copilot CLI: the chat that took the first Unit was told its
  // work was finished once the merge opened the team's next one.
  test("in the chat that took and pushed a Unit, the team's next Unit its merge opened is offered, once", () => {
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-chat" };
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web", "reporting=payments"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    // The chat's first look offers refunds; the take, the build and the push all run in that chat.
    expect(next(alice, chat).ask_type).toBe("unit-take");
    expect(run(UNIT, ["take", "refunds", "--home", HOME, "--team", "payments"], alice, chat).status).toBe(0);
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

  test("while the home builds the walking skeleton, hears that every Unit waits on it, and nothing of the home's work runs", () => {
    const dependencies = "# Unit dependencies\n\n```yaml\nunits:\n  - name: orders\n    depends_on: []\n" +
      "  - name: refunds\n    depends_on: [orders]\n  - name: checkout-ui\n    depends_on: [orders]\n" +
      "  - name: reporting\n    depends_on: [refunds]\n```\n";
    const home = makeHome({ dependencies, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
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
      "fixture is built by teams, one Unit each. The walking skeleton, orders, is built at the lead's project first. " +
        "Waiting: refunds (for payments; on orders), checkout-ui (for web; on orders), reporting (on orders, refunds). " +
        "Nothing is ready to take yet.",
    );
    expect(git(alice, ["status", "--porcelain"])).toBe("");
  });

  test("a clone a day old hears the claims as the home has them now: a Unit whose dependency merged since opens, with no fetch by hand", () => {
    const { hosts, home, alice, record } = refundsTaken(["refunds=payments", "checkout-ui=web", "reporting=data"]);
    // dana of data cloned before refunds was done, and looks while it waits.
    const dana = cloneOf(home.remote, "dana");
    expect(run(UTILITY, ["space-create", "data"], dana).status).toBe(0);
    expect(run(UTILITY, ["space", "data"], dana).status).toBe(0);
    const waiting = next(dana);
    expect(waiting.kind, JSON.stringify(waiting)).toBe("print");
    expect(waiting.narration).toBe(
      "fixture is built by teams, one Unit each. Waiting: reporting (for data; on refunds). Being built: refunds " +
        "(by alice for payments). Held for other teams: checkout-ui (for web). Nothing is ready to take yet.",
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
  test("one Unit, the home's inputs at their own paths, the home's Inception done, the claim taken", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const alice = cloneOf(home.remote, "alice");
    const took = take(alice, "refunds", ["--team", "payments"]);
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ taken: true, unit: "refunds", team: "payments", space: "payments" });
    expect(String(took.json?.notice)).toStartWith(
      "Refunds is yours, for the payments team. Its build is its own piece of work here, under your team's rules, " +
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
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const took = take(alice, "refunds", ["--team", "payments"]);
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
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label).slice(0, 2)).toEqual([
      "Start refunds for payments and follow the lead's project rules too (Release Checks)",
      "Start refunds for payments under your team's own rules only",
    ]);
    expect(choices[0].command).toEndWith(" --lead-rules");
    const took = take(alice, "refunds", ["--team", "payments", "--lead-rules"]);
    expect(took.status, took.out).toBe(0);
    const record = buildDir(alice, "payments", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("aidlc/spaces/default/memory/project.md");
    const step = next(alice);
    expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("run-stage");
    expect(step.rules_in_context as string[]).toContain("aidlc/spaces/default/memory/project.md");
    // The lead's file is read, never written, from the build.
    expect(readFileSync(join(alice, "aidlc", "spaces", "default", "memory", "project.md"), "utf-8")).toContain("Every handler ships with a contract test.");
  });

  // A live run (S1): payments built the refund amount test-after against the
  // lead's agreed "test first", which the take never carried.
  test("the lead's agreed practices are offered at the take too, named, and taken they reach the build before the team's own", () => {
    const home = makeHome();
    const practices = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    const seeded = readFileSync(practices, "utf-8");
    expect(seeded).toContain("## Testing Posture\n");
    writeFileSync(practices, seeded.replace("## Testing Posture\n", "## Testing Posture\nTest first for the refund amount.\n"));
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label).slice(0, 2)).toEqual([
      "Start refunds for payments and follow the lead's agreed practices too (Testing Posture)",
      "Start refunds for payments under your team's own rules only",
    ]);
    const took = take(alice, "refunds", ["--team", "payments", "--lead-rules"]);
    expect(took.status, took.out).toBe(0);
    const record = buildDir(alice, "payments", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("aidlc/spaces/default/memory/team.md");
    const step = next(alice);
    expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("run-stage");
    expect(step.rules_in_context as string[]).toContain("aidlc/spaces/default/memory/team.md");
    // The lead's file is read, never written, from the build.
    expect(readFileSync(practices, "utf-8")).toContain("Test first for the refund amount.");
  });

  test("at the lead's project the learnings choice says a project learning is offered to any team that takes a Unit", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const lead = readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME, "aidlc-state.md"), "utf-8");
    expect(learningsCorrectionChoices(lead)).toEqual(["Yes, for this project, and offered to any team that takes a Unit", "Yes, for the team", "No"]);
    expect(learningsCorrectionChoices(homeState())).toEqual(["Yes, for this project", "Yes, for the team", "No"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds", ["--team", "payments"]).status).toBe(0);
    expect(learningsCorrectionChoices(readFileSync(join(buildDir(alice, "payments", "refunds"), "aidlc-state.md"), "utf-8"))[0])
      .toBe("Yes, for this project");
    // Either wording is the same question when its answer is read back.
    for (const choices of [learningsCorrectionChoices(lead), learningsCorrectionChoices(homeState())]) {
      expect(offersLearningsCorrectionChoices((choice) => choices.includes(choice))).toBe(true);
    }
  });

  test("a lead's project with no rules of its own offers each Unit once, as before", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const labels = ((next(cloneOf(home.remote, "alice")).choices ?? []) as Array<{ label: string }>).map((choice) => choice.label);
    expect(labels).toContain("Start refunds for payments");
    expect(labels.some((label) => label.includes("project rules"))).toBe(false);
  });

  // Live runs on Codex and Claude Code: a team's build runs its stages for its
  // one Unit, and a redo or a skip the person asked for, named for that Unit,
  // was refused as "only for every unit" and asked again.
  test("in a Unit's build, a redo or a skip named for its one Unit is the stage's own, never refused as one Unit's", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds", ["--team", "payments"]).status).toBe(0);
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
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "checkout-ui=web"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const wen = cloneOf(home.remote, "wen");
    const took = take(wen, "checkout-ui", ["--team", "web"]);
    expect(took.status, took.out).toBe(0);
    const record = buildDir(wen, "web", "checkout-ui");
    expect(readFileSync(join(record, "inception", "refined-mockups", "interaction-spec.md"), "utf-8")).toContain("confirm before it sends");
    expect(existsSync(join(record, "inception", "refined-mockups", "mockups.md"))).toBe(true);
    const approved = readFileSync(join(record, "approved-inputs.md"), "utf-8");
    expect(approved).toContain("inception/refined-mockups/interaction-spec.md");
    // The lead's own record of the code is the team's code itself: never copied.
    expect(approved).not.toContain("reverse-engineering");
  });

  // A live run on Codex: the lead's work ran Construction autonomously, the
  // team's build of one Unit took that, and its Code Generation went out as a
  // parallel batch in worktrees: a commit landed on the person's own main and
  // the build's agent patched AI-DLC's own tool to get past it.
  test("a Unit's build holds one Unit, so its Code Generation is never a parallel batch, whatever autonomy the lead's work runs", () => {
    const home = makeHome({ state: homeState(["- **Construction Autonomy Mode**: autonomous"]) });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds", ["--team", "payments"]).status).toBe(0);
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
    const { home, alice, record } = refundsTaken(["refunds=payments", "checkout-ui=payments"]);
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
    const home = homeWithTeams(["refunds=payments"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds", ["--team", "payments"]).status).toBe(0);
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
  test("taken by a teammate, or held for another team", () => {
    const home = homeWithTeams(["refunds=payments", "checkout-ui=web"]);
    expect(take(cloneOf(home.remote, "alice"), "refunds", ["--team", "payments"]).status).toBe(0);
    const bob = cloneOf(home.remote, "bob");
    const again = take(bob, "refunds");
    expect(again.status).not.toBe(0);
    expect(again.out).toContain("refunds is held by the payments team (alice took it).");
    // From the payments space, the web team's Unit is not theirs.
    expect(run(UTILITY, ["space-create", "payments"], bob).status).toBe(0);
    expect(run(UTILITY, ["space", "payments"], bob).status).toBe(0);
    const theirs = take(bob, "checkout-ui");
    expect(theirs.status).not.toBe(0);
    expect(theirs.out).toContain("checkout-ui is held by the web team.");
  });

  test("a Unit taken while the home is changing the Unit plan is taken on the plan as it stands, said once", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME, "aidlc-state.md");
    const back = readFileSync(statePath, "utf-8")
      .replace(/^- \[x\] units-generation /m, "- [-] units-generation ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: units-generation");
    writeFileSync(statePath, back);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "units generation again"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const took = take(cloneOf(home.remote, "alice"), "refunds", ["--team", "payments"]);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toEndWith(
      "The lead is changing the Unit plan (Units Generation is open again there), so refunds is taken on the plan as it stands there.",
    );
  });

  test("a waiting Unit is not taken yet, and the line says when it opens", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const waiting = take(cloneOf(home.remote, "carol"), "reporting");
    expect(waiting.status).not.toBe(0);
    expect(waiting.out).toContain("reporting waits on refunds, which is not done at the lead's project yet. It opens once it is done.");
  });
});

describe("who takes what", () => {
  test("a team the lead named with a capital letter is one team: its second Unit is offered to it and taken", () => {
    const home = homeWithTeams(["refunds=Payments", "checkout-ui=Payments"]);
    expect(take(cloneOf(home.remote, "alice"), "refunds", ["--team", "Payments"]).status).toBe(0);
    const bob = cloneOf(home.remote, "bob");
    expect(run(UTILITY, ["space-create", "payments"], bob).status).toBe(0);
    expect(run(UTILITY, ["space", "payments"], bob).status).toBe(0);
    const ask = next(bob);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start checkout-ui");
    const took = take(bob, "checkout-ui");
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("payments");
  });

  test("an open Unit in a fresh clone is offered for each team the lead named, and its build is that team's", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const carol = cloneOf(home.remote, "carol");
    const ask = next(carol);
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual([
      "Start refunds for payments",
      "Start checkout-ui for payments",
      "Start checkout-ui for another team",
      "Carry on fixture here, as the lead",
    ]);
    expect(choices[1].command).toEndWith(`aidlc-unit.ts take checkout-ui --home ${HOME} --team payments`);
    expect(choices[2].command).toEndWith(`aidlc-unit.ts take checkout-ui --home ${HOME} --team '<their team>'`);
    const unnamed = take(carol, "checkout-ui");
    expect(unnamed.status).not.toBe(0);
    expect(unnamed.out).toContain("Which team builds checkout-ui? Ask the person, then run this again with --team '<their team>'.");
    const took = take(carol, "checkout-ui", ["--team", "payments"]);
    expect(took.status, took.out).toBe(0);
    expect(took.json?.space).toBe("payments");
  });

  test("every Unit taken or held for other teams: the clone hears where each is, and none of the home's work is offered", () => {
    const dependencies = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
      "  - name: checkout-ui\n    depends_on: []\n```\n";
    const home = homeWithTeams(["refunds=payments", "checkout-ui=web"], dependencies);
    expect(take(cloneOf(home.remote, "alice"), "refunds", ["--team", "payments"]).status).toBe(0);
    const dana = cloneOf(home.remote, "dana");
    expect(run(UTILITY, ["space-create", "data"], dana).status).toBe(0);
    expect(run(UTILITY, ["space", "data"], dana).status).toBe(0);
    const step = next(dana);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.narration).toBe(
      "fixture is built by teams, one Unit each. Being built: refunds (by alice for payments). " +
        "Held for other teams: checkout-ui (for web). Nothing is ready to take yet.",
    );
  });

  test("a Unit the home started is not offered, and taking it says it is the home's, with the way on", () => {
    const home = homeWithTeams(["refunds=payments"]);
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
    const refused = take(carol, "checkout-ui", ["--team", "web"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("checkout-ui is being built at the lead's project, so it is not open to take. Run `");
  });

  test("a take whose team.md names a branch the lead's project lacks says which file named it", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const alice = cloneOf(home.remote, "alice");
    const teamMd = join(alice, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(teamMd, readFileSync(teamMd, "utf-8").replace("## Way of Working\n", "## Way of Working\n\nIntegration branch: `develop`.\n"));
    const refused = take(alice, "refunds", ["--team", "payments"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain(
      "The lead's project's branch develop, named in aidlc/spaces/default/memory/team.md under Way of Working, could not be fetched from origin",
    );
  });

  test("a teammate who takes before cloning the code repos: the build records the home's repos", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const took = take(alice, "refunds", ["--team", "payments"]);
    expect(took.status, took.out).toBe(0);
    const row = readIntentRegistry(alice, "payments").find((entry) => entry.dirName === took.json?.record);
    expect(row?.repos).toEqual(["billing", "checkout-api"]);
  });
});

describe("builds in one workspace", () => {
  test("a team the lead calls the data team is named once when its build is carried on", () => {
    const home = homeWithTeams(["refunds=data team"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds", ["--team", "data team"]).status).toBe(0);
    commitAll(alice, "refunds build");
    git(alice, ["push", "-q", "origin", "main"]);
    const laptop = cloneOf(home.remote, "alice-laptop");
    const offer = next(laptop);
    const carry = (offer.choices as Array<{ label: string; detail?: string }>).find((choice) => choice.label === "Carry on refunds");
    expect(carry?.detail, JSON.stringify(offer)).toBe("The data-team's build of it, here.");
    const resumed = run(UNIT, ["take", "refunds", "--home", HOME], laptop);
    expect(resumed.json?.notice, resumed.out).toBe("Carrying on refunds, the data-team's build here.");
    expect(`${JSON.stringify(offer)}${resumed.out}`).not.toContain("team team");
  });

  test("the build's Code Generation is told its code goes in the Unit's repos, beside the files of theirs it leaves alone", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    expect(take(alice, "refunds", ["--team", "payments"]).status).toBe(0);
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
    const home = homeWithTeams(["refunds=payments"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds", ["--team", "payments"]).status).toBe(0);
    const step = next(alice, ENV, ["compose", "--unit-plan"]);
    expect(step.ask_type, JSON.stringify(step)).not.toBe("unit-plan-change");
    expect(String(step.message)).toContain("Dispatch the composer agent");
  });

  test("two builds started at once in one space share no file: the second pull has no conflict", () => {
    const home = homeWithTeams(["refunds=payments", "checkout-ui=payments"]);
    const alice = cloneOf(home.remote, "alice");
    const bob = cloneOf(home.remote, "bob");
    expect(take(alice, "refunds", ["--team", "payments"]).status).toBe(0);
    expect(take(bob, "checkout-ui", ["--team", "payments"]).status).toBe(0);
    commitAll(alice, "refunds build");
    commitAll(bob, "checkout-ui build");
    git(alice, ["push", "-q", "origin", "main"]);
    const pulled = spawnSync("git", ["pull", "--no-rebase", "--no-edit", "-q", "origin", "main"], { cwd: bob, encoding: "utf-8", env: GIT_ENV });
    expect(pulled.status, pulled.stderr).toBe(0);
    expect(readIntentRegistry(bob, "payments").map((row) => row.slug).sort()).toEqual(["checkout-ui", "refunds"]);
  });

  test("the next day, another clone of the workspace carries the build on, in the chat open on it", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds", ["--team", "payments"]).status).toBe(0);
    commitAll(alice, "refunds build");
    git(alice, ["push", "-q", "origin", "main"]);
    const laptop = cloneOf(home.remote, "alice-laptop");
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
    expect((step.change_notices ?? []) as string[], JSON.stringify(step)).toContain("Carrying on refunds, the payments team's build here.");
  });
});

describe("a team's own workspace, made from the home's", () => {
  test("the home's copied work is never offered to carry on; its Units are, reached by the home's address", () => {
    const home = homeWithTeams(["refunds=payments", "checkout-ui=web"]);
    const web = teamWorkspace(home.remote, "web");
    const ask = next(web);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(String(ask.question)).toStartWith(`fixture (the lead's project is at ${home.remote}) is built by teams, one Unit each.`);
    expect(String(ask.question)).toContain("checkout-ui (for web; likely checkout-web)");
    const labels = (ask.choices as Array<{ label: string }>).map((choice) => choice.label);
    expect(labels).toEqual(["Start refunds for payments", "Start checkout-ui for web"]);
    const remotes = git(web, ["remote"]);
    const took = take(web, "checkout-ui", ["--team", "web"]);
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ team: "web", space: "web" });
    // No remote added: the home is reached by its address, into AI-DLC's own refs.
    expect(git(web, ["remote"])).toBe(remotes);
    expect(git(web, ["for-each-ref", "--format=%(refname)", "refs/aidlc/home/"])).toContain("integration");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ owner: "web", taken_by: "web" });
    expect(next(web).unit).toBe("checkout-ui");
  });

  test("a team that could only read the home when it took its Unit sends the result by git once the home takes its pushes", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    commitAll(home.dir, "teams");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const hook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'this host takes no push from here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const pay = teamWorkspace(home.remote, "pay");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, pay, name, "pay");
    expect(take(pay, "refunds", ["--team", "payments"]).status).toBe(0);
    const record = buildDir(pay, "payments", "refunds");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Home Result")).toBe("by file");
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    codeGenerated(pay, record);
    const pushed = run(UNIT, ["push"], pay);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain("The lead's project takes pushes from here now, so refunds's result goes back by git.");
    expect(field(readFileSync(join(record, "aidlc-state.md"), "utf-8"), "Home Result")).toBeUndefined();
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ taken_by: "pay" });
    expect((claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as { result?: unknown }).result).toBeDefined();
  });

  test("a home that takes no push from here: a held Unit is taken and goes back by file; an open one names the lead's step", () => {
    const open = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n  - name: reporting\n    depends_on: []\n```\n";
    const home = homeWithTeams(["refunds=payments"], open);
    const hook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'this host takes no push from here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const pay = teamWorkspace(home.remote, "pay");
    const held = take(pay, "refunds", ["--team", "payments"]);
    expect(held.status, held.out).toBe(0);
    expect(String(held.json?.notice)).toContain(
      "You can read the lead's project but not write to it, so the result of refunds goes back as a file when it is built.",
    );
    expect(field(readFileSync(join(buildDir(pay, "payments", "refunds"), "aidlc-state.md"), "utf-8"), "Home Result")).toBe("by file");
    const openUnit = take(pay, "reporting", ["--team", "payments"]);
    expect(openUnit.status).not.toBe(0);
    expect(String(openUnit.json?.error)).toEndWith(
      "Ask the lead to hold it for your team.",
    );
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
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    cloneCode(hosts["checkout-api"], alice, "checkout-api", "alice");
    const took = run(UNIT, ["take", "refunds", "--home", HOME, "--team", "payments"], alice);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).not.toContain("Do you want me to clone");
    expect(took.json?.offer).toBeUndefined();
    const offer = next(alice);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 500)).toBe("unit-clone");
    expect(String(offer.question)).toBe("billing is not at billing in this workspace yet. Do you want me to clone it there?");
    expect(String(offer.question)).not.toContain("give its path in repos.local.json");
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
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    const mine = tempDir("alice-code");
    cloneCode(hosts["checkout-api"], mine, "api", "alice");
    // Their own path for checkout-api, with a slip: a trailing comma.
    writeFileSync(join(alice, "repos.local.json"), `{ "repos": [ { "name": "checkout-api", "path": ${JSON.stringify(join(mine, "api"))} }, ] }\n`);
    const took = run(UNIT, ["take", "refunds", "--home", HOME, "--team", "payments"], alice);
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
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    // Her own copies live beside the workspace, as her repos.local.json says.
    for (const name of ["checkout-api", "billing"]) cloneCode(hosts[name as "billing"], join(alice, ".."), `${name}-mine`, "alice");
    writeFileSync(join(alice, "repos.local.json"), `${JSON.stringify({ repos: [
      { name: "checkout-api", path: "../checkout-api-mine" },
      { name: "billing", path: "../billing-mine" },
    ] })}\n`);
    const onCodex = run(UNIT, ["take", "refunds", "--home", HOME, "--team", "payments"], alice, { ...ENV, AIDLC_HARNESS_NAME: "codex" });
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
      expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
      git(home.dir, ["add", "-A"]);
      git(home.dir, ["commit", "-q", "-m", "teams"]);
      git(home.dir, ["push", "-q", "origin", "main"]);
      const alice = cloneOf(home.remote, "alice");
      for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
      return { took: run(UNIT, ["take", "refunds", "--home", HOME, "--team", "payments"], alice, { ...ENV, AIDLC_HARNESS_NAME: "codex" }) };
    })();
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).not.toContain("--add-dir");
  });

  test("the lead's project recorded under an https address while her clone's origin is the same repo over ssh: the take reaches the claims through her origin", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
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
    const took = run(UNIT, ["take", "refunds", "--home", HOME, "--team", "payments"], alice);
    expect(took.status, took.out).toBe(0);
    expect(took.out).not.toContain("could not be reached");
    expect(String(took.json?.notice)).toStartWith("Refunds is yours, for the payments team.");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ taken_by: "alice" });
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
    const assigned = run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
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
    const took = take(bob, "refunds", ["--team", "payments"]);
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
describe("a Unit held for another team, and the way back from a take", () => {
  const id8 = (home: { dir: string }) => fixtureIntentId8(home.dir);

  test("from a fresh clone, naming another team or none, a Unit held for a team is never taken; the line says whose it is", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const sam = cloneOf(home.remote, "sam");
    const other = take(sam, "refunds", ["--team", "storefront"]);
    expect(other.status).not.toBe(0);
    expect(String(other.json?.error)).toBe("refunds is held by the payments team.");
    const bare = take(sam, "refunds");
    expect(bare.status).not.toBe(0);
    expect(String(bare.json?.error)).toBe(
      "refunds is held for the payments team. Run this again with --team and the person's team: --team payments if they " +
        "are on it. If their words do not say which team they are on, ask them.",
    );
    expect(claimPayload(home.remote, id8(home), "refunds")?.taken_by).toBeUndefined();
    expect(existsSync(join(sam, "aidlc", "spaces", "payments"))).toBe(false);
    // Their own team, however it is written, takes it.
    const theirs = take(sam, "refunds", ["--team", "Payments"]);
    expect(theirs.status, theirs.out).toBe(0);
    expect(theirs.json).toMatchObject({ team: "payments", space: "payments" });
  });

  test("in a team's own space, naming another team never takes a Unit held for a third", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const sam = cloneOf(home.remote, "sam");
    expect(run(UTILITY, ["space-create", "storefront"], sam).status).toBe(0);
    expect(run(UTILITY, ["space", "storefront"], sam).status).toBe(0);
    for (const extra of [["--team", "storefront"], ["--team", "web"], []]) {
      const took = take(sam, "refunds", extra);
      expect(took.status, took.out).not.toBe(0);
      expect(String(took.json?.error)).toBe("refunds is held by the payments team.");
    }
    expect(claimPayload(home.remote, id8(home), "refunds")?.taken_by).toBeUndefined();
  });

  test("the take offer in a fresh clone says the team a held Unit is for, and its command takes it for that team", () => {
    const home = homeWithTeams(["refunds=payments", "checkout-ui=web"]);
    const ask = next(cloneOf(home.remote, "sam"));
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual([
      "Start refunds for payments",
      "Start checkout-ui for web",
      "Carry on fixture here, as the lead",
    ]);
    expect(choices[0].command).toEndWith(`aidlc-unit.ts take refunds --home ${HOME} --team payments`);
    expect(choices[1].command).toEndWith(`aidlc-unit.ts take checkout-ui --home ${HOME} --team web`);
  });

  test("release in the build gives the Unit back to the team the lead held it for, keeps the build's record, and the clone is offered the Units again", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const held = claimPayload(home.remote, id8(home), "refunds")!;
    const sam = cloneOf(home.remote, "sam");
    const took = take(sam, "refunds", ["--team", "payments"]);
    expect(took.status, took.out).toBe(0);
    // Said once, where the take is.
    expect(String(took.json?.notice)).toContain(" If it is not your team's to build, say so and I give it back.");
    const record = buildDir(sam, "payments", "refunds");
    const back = run(UNIT, ["release", "refunds"], sam);
    expect(back.status, back.out).toBe(0);
    expect(back.json?.notice).toBe(
      "Refunds is given back: the lead's project holds it for the payments team again, as before. Its build here is " +
        "set aside, with everything in it kept.",
    );
    const after = claimPayload(home.remote, id8(home), "refunds")!;
    expect(after).toMatchObject({ status: "claimed", owner: "payments", base_oid: held.base_oid, gate_rhythm: held.gate_rhythm });
    expect(after.taken_by).toBeUndefined();
    expect(after.nonce).toBe(held.nonce);
    // Nothing of the build is deleted: its record is set aside.
    const state = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    expect(field(state, "Status")).toBe("Archived");
    expect(field(state, "Unit Build")).toBe("refunds");
    const ask = next(sam);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    const labels = (ask.choices as Array<{ label: string }>).map((choice) => choice.label);
    expect(labels).toContain("Start refunds for payments");
    expect(labels).not.toContain("Carry on refunds");
    // The team it is held for takes it, as the lead held it.
    const dora = cloneOf(home.remote, "dora");
    const theirs = take(dora, "refunds", ["--team", "payments"]);
    expect(theirs.status, theirs.out).toBe(0);
    expect(claimPayload(home.remote, id8(home), "refunds")).toMatchObject({ status: "claimed", owner: "payments", taken_by: "dora" });
  });

  test("an open Unit given back is open again at the lead's project", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const sam = cloneOf(home.remote, "sam");
    const took = take(sam, "checkout-ui", ["--team", "storefront"]);
    expect(took.status, took.out).toBe(0);
    const back = run(UNIT, ["release", "checkout-ui"], sam);
    expect(back.status, back.out).toBe(0);
    expect(back.json?.notice).toBe(
      "Checkout-ui is given back: it is open again at the lead's project. Its build here is set aside, with everything in it kept.",
    );
    expect(claimPayload(home.remote, id8(home), "checkout-ui")).toMatchObject({ status: "released" });
  });
});
