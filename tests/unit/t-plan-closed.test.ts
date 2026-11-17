// covers: subcommand:aidlc-orchestrate:next, function:unitTakeLook, function:planJsonOf
//
// The end of a shared plan, as a team's look meets it. A plan whose every Unit
// is done on it, or that says closed, offers none of its Units. A look nobody
// asked for, and one beside an offer, passes it by with nothing said; asked what
// they can take where the plans read offer nothing, the person hears one clause
// saying what each is, never that no plan was found. A Unit build of the
// person's own is still theirs to carry on. closed is read as the plan's own
// shape, so a value nobody's AI-DLC writes makes no plan.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { planJsonOf } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import {
  cleanupTeamBuild,
  ENV,
  git,
  makePlanHome,
  next,
  planRefOf,
  run,
  teamWorkspace,
  UNIT,
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
