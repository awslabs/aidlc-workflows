// covers: subcommand:aidlc-orchestrate:next, function:unitTakeLook, function:planJsonOf, subcommand:aidlc-utility:intent,
// covers: function:planEndNow, function:archiveEndLines, subcommand:aidlc-unit:plan-change, subcommand:aidlc-unit:take
//
// The end of a shared plan, as a team's look meets it. A plan whose every Unit
// is done on it, or that says closed, offers none of its Units. A look nobody
// asked for, and one beside an offer, passes it by with nothing said; asked what
// they can take where the plans read offer nothing, the person hears one clause
// saying what each is, never that no plan was found. A Unit build of the
// person's own is still theirs to carry on. closed is read as the plan's own
// shape, so a value nobody's AI-DLC writes makes no plan.
//
// The lead's own steps write it: an archive or the finish closes the plan, an
// unarchive or a step back opens it again, said once; a write the plan's
// repository did not take, or one that waits on the lead's question about a
// change this computer did not write, goes at a later step in the workspace,
// whichever work its chat is on, and the answer is kept for the closed work. A
// close another computer wrote is never undone by a state this one has not caught
// up with. The archive of such work goes through with teams' Units under way and
// names them; main's own team flow keeps its refusal. A team building a Unit
// hears once who closed the plan and when, and a take of a closed plan's Unit
// goes ahead and says so first.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planJsonOf } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  ENV,
  git,
  HOME_RECORD,
  homeState,
  makeHome,
  makePlanHome,
  next,
  personsChat,
  personsNext,
  planRefOf,
  refundsTaken,
  run,
  teamWorkspace,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

type HandPlan = { units: Array<{ name: string; word: Record<string, unknown> }>; [key: string]: unknown };

// The plan at its host changed by hand, as one commit on its tip in the lead's name, as anyone who can push
// there can write it.
function planOnHost(host: string, id8: string, what: string, edit: (plan: HandPlan) => void): void {
  const tip = git(host, ["rev-parse", planRefOf(id8)]);
  const plan = JSON.parse(git(host, ["show", `${tip}:plan.json`])) as HandPlan;
  edit(plan);
  git(host, ["update-ref", planRefOf(id8), planCommitOnHost(host, tip, plan, ["-p", tip], `aidlc plan fixture 9: ${what}`)]);
}

// Another work's plan in the same repository: the plan at `fromId8` as that work, `label`, with its own id.
function anotherPlanOnHost(host: string, fromId8: string, id8: string, label: string, edit: (plan: HandPlan) => void): void {
  const tip = git(host, ["rev-parse", planRefOf(fromId8)]);
  const plan = JSON.parse(git(host, ["show", `${tip}:plan.json`])) as HandPlan & { work: { id: string; label: string } };
  plan.work = { ...plan.work, id: `00000000-0000-4000-8000-0000${id8}`, label };
  edit(plan);
  git(host, ["update-ref", planRefOf(id8), planCommitOnHost(host, tip, plan, [], `aidlc plan ${label} 1: shared`)]);
}

function planCommitOnHost(host: string, from: string, plan: HandPlan, parents: string[], message: string): string {
  const env = { ...ENV, GIT_AUTHOR_NAME: "lead", GIT_AUTHOR_EMAIL: "lead@example.test", GIT_COMMITTER_NAME: "lead", GIT_COMMITTER_EMAIL: "lead@example.test" };
  const out = (args: string[], input?: string): string => spawnSync("git", args, { cwd: host, encoding: "utf-8", env, input }).stdout.trim();
  const blob = out(["hash-object", "-w", "--stdin"], `${JSON.stringify(plan, null, 2)}\n`);
  const entries = out(["ls-tree", from]).split("\n").map((line) => (line.endsWith("\tplan.json") ? `100644 blob ${blob}\tplan.json` : line));
  return out(["commit-tree", out(["mktree"], `${entries.join("\n")}\n`), ...parents, "-m", message]);
}

const CLOSED = (plan: HandPlan): void => {
  plan.closed = { at: "2026-11-17T03:00:00.000Z" };
};
const FINISHED = (plan: HandPlan): void => {
  for (const unit of plan.units) unit.word = { ...unit.word, done: true };
};

const labels = (step: Record<string, unknown>): string[] => ((step.choices ?? []) as Array<{ label: string }>).map((choice) => choice.label);
const later = { ...ENV, AIDLC_SESSION_OVERRIDE: "sam-later" };

describe("asked what they can take, where the plans read offer nothing", () => {
  test("a finished plan, every Unit done on it: the answer says so, never that no plan was found", () => {
    const home = makePlanHome();
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    planOnHost(home.hosts["checkout-api"], home.id8, "every Unit done", FINISHED);
    const step = next(sam, ENV, ["--units"]);
    expect(step.narration, JSON.stringify(step).slice(0, 800)).toBe("Nothing to take: every Unit of fixture is done.");
    expect(JSON.stringify(step)).not.toContain("Start ");
  });

  test("a closed plan: none of its Units is offered, and the answer is that it is closed", () => {
    const home = makePlanHome();
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    expect(labels(next(sam, ENV, ["--units"]))).toContain("Start checkout-ui");
    planOnHost(home.hosts["checkout-api"], home.id8, "closed", CLOSED);
    const step = next(sam, later, ["--units"]);
    expect(step.narration, JSON.stringify(step).slice(0, 800)).toBe("Nothing to take: the plan of fixture in checkout-api is closed.");
    expect(JSON.stringify(step)).not.toContain("Start ");
    expect(JSON.stringify(step)).not.toContain("is shared in checkout-api");
  });

  test("a closed plan at the address the person said: the same answer, never that nothing is shared there", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    planOnHost(plan, home.id8, "closed", CLOSED);
    const step = next(pay, ENV, ["--lead-address", plan]);
    expect(step.narration, JSON.stringify(step).slice(0, 800)).toBe("Nothing to take: the plan of fixture in checkout-api is closed.");
    expect(JSON.stringify(step)).not.toContain("Start ");
  });

  test("two plans and three plans read, none offering anything: one answer, each plan in the order read", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    anotherPlanOnHost(host, home.id8, "000000b2", "orders", FINISHED);
    planOnHost(host, home.id8, "closed", CLOSED);
    expect(next(sam, ENV, ["--units"]).narration).toBe(
      "Nothing to take: the plan of fixture in checkout-api is closed; every Unit of orders is done.",
    );
    anotherPlanOnHost(host, home.id8, "000000c3", "returns", CLOSED);
    expect(next(sam, later, ["--units"]).narration).toBe(
      "Nothing to take: the plan of fixture in checkout-api is closed; every Unit of orders is done; the plan of returns in checkout-api is closed.",
    );
  });

  test("beside a plan that offers a Unit, a closed or finished one is passed by with nothing said", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    anotherPlanOnHost(host, home.id8, "000000b2", "orders", CLOSED);
    anotherPlanOnHost(host, home.id8, "000000c3", "returns", FINISHED);
    const step = next(sam, ENV, ["--units"]);
    const said = JSON.stringify(step);
    expect(labels(step), said.slice(0, 800)).toContain("Start checkout-ui");
    expect(said).not.toContain("Nothing to take");
    expect(String(step.question)).not.toContain("orders");
    expect(String(step.question)).not.toContain("returns");
  });

  test("a look nobody asked for says nothing of a closed or finished plan, and never asks for an address", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", host], sam);
    expect(took.status, took.out).toBe(0);
    planOnHost(host, home.id8, "closed", CLOSED);
    const step = next(sam, later);
    const said = JSON.stringify(step);
    expect(said, said.slice(0, 800)).not.toContain("Nothing to take");
    expect(said).not.toContain("is closed");
    expect(said).not.toContain("What is the address of the repository");
  });

  test("a build of the person's own of a closed plan's Unit is still offered to carry on, and nothing else of it", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", plan], sam);
    expect(took.status, took.out).toBe(0);
    planOnHost(plan, home.id8, "closed", CLOSED);
    const step = next(sam, later, ["--units"]);
    const said = JSON.stringify(step);
    expect(labels(step), said.slice(0, 800)).toContain("Carry on checkout-ui");
    expect(said).not.toContain("Start refunds");
    expect(said).not.toContain("Start reporting");
    expect(said).not.toContain("is shared in checkout-api");
    expect(said).not.toContain("Nothing to take");
  });
});

describe("closed as plan.json holds it", () => {
  const plan = {
    format: 1, version: 2, work: { id: "4f2a91c0-0000-4000-8000-000000000000", label: "checkout-revamp", space: "default" },
    plan_repo: { name: "checkout-api", address: "https://git.example.test/checkout-api.git" },
    repos: [], units: [], skeleton: null, settings: {}, stages: {}, unit_stages: [], inputs: [],
  };
  const read = (extra: Record<string, unknown>) => planJsonOf(JSON.stringify({ ...plan, ...extra })).plan;

  test("its time, as an object, reads with the plan", () => {
    expect(read({ closed: { at: "2026-11-17T03:00:00.000Z" } })?.closed).toEqual({ at: "2026-11-17T03:00:00.000Z" });
    expect(read({})?.closed).toBeUndefined();
  });

  test("any other value makes no plan", () => {
    for (const closed of [true, "2026-11-17", { at: 7 }, { at: "two\nlines" }, {}, null]) {
      expect(read({ closed }), JSON.stringify(closed)).toBeNull();
    }
  });
});

// The lead's own steps write the end on the plan: an archive or the finish closes it, an unarchive or a step back
// opens it again, at that step or, where the plan's repository did not take it, at the next step in the workspace,
// whichever work its chat is on.
const ARCHIVE = (dir: string, env: NodeJS.ProcessEnv = ENV) => run(UTILITY, ["intent", "archive", HOME_RECORD], dir, env);
const UNARCHIVE = (dir: string, env: NodeJS.ProcessEnv = ENV) => run(UTILITY, ["intent", "unarchive", HOME_RECORD], dir, env);
const CLOSED_LINE = "Written on the plan: fixture is closed.";
const OPEN_AGAIN_LINE = "Written on the plan: fixture is open again.";
const planAt = (host: string, id8: string): Record<string, unknown> => JSON.parse(git(host, ["show", `${planRefOf(id8)}:plan.json`]));
const subject = (host: string, id8: string): string => git(host, ["log", "-1", "--format=%s", planRefOf(id8)]);
const said = (step: Record<string, unknown>): string[] => (step.change_notices ?? []) as string[];
const lines = (out: string): string[] => out.trim().split(/\r?\n/);

// The lead's work's Status set as the stage that finished it, or a step back, leaves it.
function statusOf(dir: string, status: "Completed" | "Running"): void {
  const path = join(dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md");
  writeFileSync(path, readFileSync(path, "utf-8").replace(/^- \*\*Status\*\*: .*$/m, `- **Status**: ${status}`));
}

// A host that takes no push of the plan, by a hook, until `takes` is run.
function refusePlans(host: string): { takes: () => void } {
  const hook = join(host, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/aidlc/plans/*) echo 'plans are closed today' >&2; exit 1;; esac; done\nexit 0\n");
  chmodSync(hook, 0o755);
  return { takes: () => unlinkSync(hook) };
}

// A second piece of work of the lead's in the same workspace, selected, and a chat on it.
function anotherWork(dir: string, session: string): NodeJS.ProcessEnv {
  const made = run(UTILITY, ["intent-create", "--scope", "feature", "--arguments", "a second piece of work", "--label", "another"], dir);
  expect(made.status, made.out).toBe(0);
  return personsChat(session);
}

// The chat's own records: its binding, the cursors, its person lines.
function chatRecords(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const sessions = join(dir, "aidlc", ".aidlc-engine", "sessions");
  for (const name of existsSync(sessions) ? readdirSync(sessions, { recursive: true }) as string[] : []) {
    if (statSync(join(sessions, name)).isFile()) files[`sessions/${name}`] = readFileSync(join(sessions, name), "utf-8");
  }
  files["active-space"] = readFileSync(join(dir, "aidlc", "active-space"), "utf-8");
  const cursor = join(dir, "aidlc", "spaces", "default", "intents", "active-intent");
  files["active-intent"] = existsSync(cursor) ? readFileSync(cursor, "utf-8") : "";
  return files;
}

describe("the plan's end, written at the lead's own steps", () => {
  test("an archive closes the plan, said after its own line; an unarchive opens it again; a later step says neither again", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const archived = ARCHIVE(home.dir);
    expect(archived.status, archived.out).toBe(0);
    expect(lines(archived.out)[0]).toStartWith("Archived intent");
    expect(lines(archived.out).at(-1)).toBe(CLOSED_LINE);
    expect(planAt(host, home.id8).closed).toMatchObject({ at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(subject(host, home.id8)).toMatch(/^aidlc plan fixture \d+: closed$/);
    const back = UNARCHIVE(home.dir);
    expect(back.status, back.out).toBe(0);
    expect(lines(back.out)[0]).toStartWith("Unarchived intent");
    expect(lines(back.out).at(-1)).toBe(OPEN_AGAIN_LINE);
    expect(planAt(host, home.id8).closed).toBeUndefined();
    expect(subject(host, home.id8)).toMatch(/^aidlc plan fixture \d+: open again$/);
    expect(JSON.stringify(next(home.dir, later))).not.toContain("Written on the plan: fixture is");
  });

  test("the finish closes the plan at the next step, said once; a step back opens it again at the step after", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    statusOf(home.dir, "Completed");
    const step = next(home.dir, later);
    expect(said(step), JSON.stringify(step).slice(0, 800)).toContain(CLOSED_LINE);
    expect(planAt(host, home.id8).closed).toBeDefined();
    expect(JSON.stringify(next(home.dir, later))).not.toContain(CLOSED_LINE);
    statusOf(home.dir, "Running");
    expect(said(next(home.dir, later))).toContain(OPEN_AGAIN_LINE);
    expect(planAt(host, home.id8).closed).toBeUndefined();
  });

  test("a close the plan's repository did not take: the archive says only its own line, and the next step on another work writes it, once", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const refused = refusePlans(host);
    const archived = ARCHIVE(home.dir);
    expect(archived.status, archived.out).toBe(0);
    expect(archived.out).not.toContain("Written on the plan");
    expect(planAt(host, home.id8).closed).toBeUndefined();
    refused.takes();
    const chat = anotherWork(home.dir, "lead-on-another");
    const step = personsNext(home.dir, chat, "lead-on-another");
    expect(said(step), JSON.stringify(step).slice(0, 800)).toContain(CLOSED_LINE);
    expect(planAt(host, home.id8).closed).toBeDefined();
    expect(JSON.stringify(personsNext(home.dir, chat, "lead-on-another"))).not.toContain(CLOSED_LINE);
  });

  test("a change this computer did not write: the close waits, the question is put once at a step on another work, and its answer is kept for the closed work", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    planOnHost(host, home.id8, "refunds signed off", (plan) => {
      plan.settings = { ...(plan.settings as Record<string, unknown>), note: "theirs" };
    });
    const archived = ARCHIVE(home.dir);
    expect(archived.status, archived.out).toBe(0);
    expect(archived.out).not.toContain("Written on the plan");
    const chat = anotherWork(home.dir, "lead-on-another");
    const ask = personsNext(home.dir, chat, "lead-on-another");
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 800)).toBe("lead-plan-change");
    expect(String(ask.question)).toStartWith("The plan of fixture in checkout-api has a change this computer did not write, by lead, ");
    expect(String(ask.question)).toEndWith(`Its commit says "refunds signed off". Keep it on the plan?`);
    const keep = ((ask.choices ?? []) as Array<{ label: string; command: string }>).find((choice) => choice.label === "Keep it")!;
    const tip = /--tip ([0-9a-f]+)/.exec(keep.command)![1];
    expect(run(UNIT, ["plan-change", "keep", "--tip", tip], home.dir, chat).status).toBe(0);
    const marks = (record: string): string[] => {
      const engine = join(home.dir, "aidlc", "spaces", "default", "intents", record, ".aidlc-engine");
      return existsSync(engine) ? readdirSync(engine) : [];
    };
    expect(marks(HOME_RECORD)).toContain(`plan-here-${tip}.json`);
    const other = readdirSync(join(home.dir, "aidlc", "spaces", "default", "intents")).find((name) => name.startsWith("another-") || name.includes("-another"))!;
    expect(marks(other)).not.toContain(`plan-here-${tip}.json`);
    const after = personsNext(home.dir, chat, "lead-on-another");
    expect(said(after), JSON.stringify(after).slice(0, 800)).toContain(CLOSED_LINE);
    expect(planAt(host, home.id8)).toMatchObject({ settings: { note: "theirs" }, closed: expect.any(Object) });
  });

  test("a close another computer of the lead's wrote is never taken off by one whose work still runs, asked about or kept", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const other = `${home.dir}-other`;
    cpSync(home.dir, other, { recursive: true });
    expect(ARCHIVE(home.dir).status).toBe(0);
    expect(planAt(host, home.id8).closed).toBeDefined();
    const ask = next(other, { ...ENV, AIDLC_SESSION_OVERRIDE: "other-1" });
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("lead-plan-change");
    next(other, { ...ENV, AIDLC_SESSION_OVERRIDE: "other-2" });
    expect(planAt(host, home.id8).closed).toBeDefined();
    const keep = ((ask.choices ?? []) as Array<{ label: string; command: string }>).find((choice) => choice.label === "Keep it")!;
    expect(run(UNIT, ["plan-change", "keep", "--tip", /--tip ([0-9a-f]+)/.exec(keep.command)![1]], other).status).toBe(0);
    const after = next(other, { ...ENV, AIDLC_SESSION_OVERRIDE: "other-3" });
    expect(JSON.stringify(after)).not.toContain(OPEN_AGAIN_LINE);
    expect(planAt(host, home.id8).closed).toBeDefined();
  });

  test("a computer with no record of the plan carries on from a close another wrote, and never takes it off", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const other = `${home.dir}-other`;
    cpSync(home.dir, other, { recursive: true });
    const engine = join(other, "aidlc", "spaces", "default", "intents", HOME_RECORD, ".aidlc-engine");
    for (const name of readdirSync(engine).filter((entry) => entry.startsWith("plan-"))) unlinkSync(join(engine, name));
    expect(ARCHIVE(home.dir).status).toBe(0);
    next(other, { ...ENV, AIDLC_SESSION_OVERRIDE: "other-1" });
    const after = next(other, { ...ENV, AIDLC_SESSION_OVERRIDE: "other-2" });
    expect(JSON.stringify(after)).not.toContain(OPEN_AGAIN_LINE);
    expect(planAt(host, home.id8).closed).toBeDefined();
  });

  test("an open-again another computer wrote is never closed again by a state that still says archived", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    expect(ARCHIVE(home.dir).status).toBe(0);
    const other = `${home.dir}-other`;
    cpSync(home.dir, other, { recursive: true });
    expect(UNARCHIVE(home.dir).status).toBe(0);
    expect(planAt(host, home.id8).closed).toBeUndefined();
    next(other, { ...ENV, AIDLC_SESSION_OVERRIDE: "other-1" });
    const after = next(other, { ...ENV, AIDLC_SESSION_OVERRIDE: "other-2" });
    expect(JSON.stringify(after)).not.toContain(CLOSED_LINE);
    expect(planAt(host, home.id8).closed).toBeUndefined();
  });

  test("nothing of the chat changes under the end write, nor where the write throws inside it", () => {
    const home = makePlanHome();
    const chat = anotherWork(home.dir, "lead-on-another");
    personsNext(home.dir, chat, "lead-on-another");
    const before = chatRecords(home.dir);
    expect(ARCHIVE(home.dir, chat).status).toBe(0);
    expect(chatRecords(home.dir)).toEqual(before);
    // The write throws inside its scope (the Unit plan does not read): the chat is still as it was.
    const back = UNARCHIVE(home.dir, chat);
    expect(back.status, back.out).toBe(0);
    const dependencies = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(dependencies, "not a plan\n");
    const settled = chatRecords(home.dir);
    const again = ARCHIVE(home.dir, chat);
    expect(again.status, again.out).toBe(0);
    expect(chatRecords(home.dir)).toEqual(settled);
  });
});

describe("the archive while teams have Units under way", () => {
  const NO_NOTICE = "AI-DLC sends no notice of the close.";
  test("it goes through, the plan says closed, and one line names each Unit and who has it", () => {
    const { home } = refundsTaken();
    next(home.dir, later);
    const archived = ARCHIVE(home.dir);
    expect(archived.status, archived.out).toBe(0);
    expect(lines(archived.out).slice(-2)).toEqual([CLOSED_LINE,
      `As this computer last read them, these Units were under way: refunds, taken by alice in the payments space. ${NO_NOTICE}`]);
    expect(planAt(home.hosts["checkout-api"], home.id8).closed).toBeDefined();
  });

  test("the lead's own build is named as theirs; where it is the only one, nothing is said of it", () => {
    const { home, hosts } = refundsTaken();
    expect(run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", hosts["checkout-api"]], home.dir).status).toBe(0);
    next(home.dir, later);
    const archived = ARCHIVE(home.dir);
    expect(archived.status, archived.out).toBe(0);
    expect(lines(archived.out).at(-1)).toBe("As this computer last read them, these Units were under way: refunds, taken by alice in the payments space; " +
      `checkout-ui, your own build here. ${NO_NOTICE}`);
    const alone = makePlanHome();
    expect(run(UNIT, ["take", "checkout-ui", "--plan", alone.id8, "--from", alone.hosts["checkout-api"]], alone.dir).status).toBe(0);
    const quiet = ARCHIVE(alone.dir);
    expect(quiet.status, quiet.out).toBe(0);
    expect(lines(quiet.out).at(-1)).toBe(CLOSED_LINE);
  });

  test("where the close did not go, the line says the plan does not say closed yet, in git's words or for the question", () => {
    const { home } = refundsTaken();
    next(home.dir, later);
    refusePlans(home.hosts["checkout-api"]);
    const archived = ARCHIVE(home.dir);
    expect(archived.status, archived.out).toBe(0);
    expect(lines(archived.out).at(-1)).toMatch(new RegExp("^As this computer last read them, these Units were under way: refunds, taken by alice in the payments " +
      "space\\. The plan does not say closed yet \\(.*plans are closed today.*\\): the next step in this workspace tries again\\.$"));
    const asked = refundsTaken();
    next(asked.home.dir, later);
    planOnHost(asked.hosts["checkout-api"], asked.home.id8, "a note", (plan) => {
      plan.settings = { ...(plan.settings as Record<string, unknown>), note: "theirs" };
    });
    const waits = ARCHIVE(asked.home.dir);
    expect(lines(waits.out).at(-1)).toEndWith("The plan does not say closed yet (it has a change this computer did not write, which the next step " +
      "asks you about): the next step in this workspace tries again.");
  });

  test("records that could not be read: from this computer's earlier read where it has one, else said in git's words", () => {
    const { home } = refundsTaken();
    next(home.dir, later);
    const dependencies = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(dependencies, "not a plan\n");
    const read = ARCHIVE(home.dir);
    expect(read.status, read.out).toBe(0);
    expect(lines(read.out).at(-1)).toStartWith("As this computer last read them, these Units were under way: refunds, taken by alice in the payments space. " +
      "The plan does not say closed yet (");
    const never = makePlanHome();
    writeFileSync(join(never.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "inception", "units-generation", "unit-of-work-dependency.md"), "not a plan\n");
    const unread = ARCHIVE(never.dir);
    expect(unread.status, unread.out).toBe(0);
    expect(lines(unread.out).at(-1)).toMatch(/^Who has this work's Units could not be read here \(.+\), so one may be under way\. The plan does not say closed yet \(.+\): the next step in this workspace tries again\.$/);
  });

  test("main's own team flow keeps its refusal word for word", () => {
    const home = makeHome({ repos: {}, state: homeState(["- **Unit Ownership**: team"]) });
    const bob = cloneOf(home.remote, "bob");
    const claimed = run(UNIT, ["claim", "refunds", "--team", "payments"], bob);
    expect(claimed.status, claimed.out).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const archived = ARCHIVE(home.dir);
    expect(archived.status).not.toBe(0);
    expect(String(archived.json?.error ?? archived.out)).toBe(
      `Intent "${HOME_RECORD}" still has claimed team Unit(s) (refunds). Release or land them before archiving.`);
  });
});

describe("a team whose Unit is under way when the plan closes", () => {
  test("its next step hears once who closed it and when, and its build is still there", () => {
    const { home, alice, record } = refundsTaken();
    expect(ARCHIVE(home.dir).status).toBe(0);
    const step = next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-later" });
    const line = said(step).find((entry) => entry.startsWith("The plan of fixture in checkout-api was closed by lead, "));
    expect(line, JSON.stringify(step).slice(0, 900)).toMatch(/^The plan of fixture in checkout-api was closed by lead, \d{1,2} [A-Z][a-z]{2}\. Your build of refunds is still here: carry it on, or tell me and I will hand it back\.$/);
    expect(existsSync(join(record, "aidlc-state.md"))).toBe(true);
    expect(JSON.stringify(next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-next-chat" }))).not.toContain("was closed by");
  });

  test("a take of a closed plan's Unit goes ahead, says the close first, and the build does not hear it again", () => {
    const home = makePlanHome();
    expect(ARCHIVE(home.dir).status).toBe(0);
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", home.hosts["checkout-api"]], sam);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice ?? took.out)).toMatch(/^The plan of fixture in checkout-api was closed by lead, \d{1,2} [A-Z][a-z]{2}, so its Units are no longer offered\. checkout-ui is yours\./);
    expect(JSON.stringify(next(sam, later))).not.toContain("was closed by");
  });
});
