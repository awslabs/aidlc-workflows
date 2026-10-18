// covers: subcommand:aidlc-unit:take, audit:UNIT_TAKEN_IN, function:unitBuildOf, function:onlyTheBuildsUnit, function:isHomesCopiedWork, function:recordKeptEntries, function:findUnitBuild
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
// into a team's workspace is never offered to carry on.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readAuditShardEvents, readIntentRegistry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneOf,
  GIT_ENV,
  git,
  makeHome,
  next,
  ORCH,
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
        "team's own piece of work here, from what the home approved.",
    );
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual([
      "Start refunds",
      "Start checkout-ui",
      "Carry on fixture here, as its home",
    ]);
    expect(choices[0].command).toEndWith(`aidlc-unit.ts take refunds --home ${HOME}`);
    expect(choices[2].command).toEndWith(`next --pick ${HOME}`);
  });
});

describe("taking a Unit starts its build in the team's space", () => {
  test("one Unit, the home's inputs at their own paths, the home's Inception done, the claim taken", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const alice = cloneOf(home.remote, "alice");
    const took = take(alice, "refunds");
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ taken: true, unit: "refunds", team: "payments", space: "payments" });
    expect(String(took.json?.notice)).toStartWith(
      "Refunds is yours, for the payments team. Its build is its own piece of work here, under your team's rules, " +
        "from what the home approved.",
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

  test("the team approves each of its stages: the build holds on a stage until it is approved", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds").status).toBe(0);
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
    expect(take(cloneOf(home.remote, "alice"), "refunds").status).toBe(0);
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

  test("a waiting Unit is not taken yet, and the line says when it opens", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const waiting = take(cloneOf(home.remote, "carol"), "reporting");
    expect(waiting.status).not.toBe(0);
    expect(waiting.out).toContain("reporting waits on refunds, which is not done at the home yet. It opens once it is done.");
  });
});

describe("builds in one workspace", () => {
  test("two builds started at once in one space share no file: the second pull has no conflict", () => {
    const home = homeWithTeams(["refunds=payments", "checkout-ui=payments"]);
    const alice = cloneOf(home.remote, "alice");
    const bob = cloneOf(home.remote, "bob");
    expect(take(alice, "refunds").status).toBe(0);
    expect(take(bob, "checkout-ui").status).toBe(0);
    commitAll(alice, "refunds build");
    commitAll(bob, "checkout-ui build");
    git(alice, ["push", "-q", "origin", "main"]);
    const pulled = spawnSync("git", ["pull", "--no-rebase", "--no-edit", "-q", "origin", "main"], { cwd: bob, encoding: "utf-8", env: GIT_ENV });
    expect(pulled.status, pulled.stderr).toBe(0);
    expect(readIntentRegistry(bob, "payments").map((row) => row.slug).sort()).toEqual(["checkout-ui", "refunds"]);
  });

  test("the next day, another clone of the workspace carries the build on", () => {
    const home = homeWithTeams(["refunds=payments"]);
    const alice = cloneOf(home.remote, "alice");
    expect(take(alice, "refunds").status).toBe(0);
    commitAll(alice, "refunds build");
    git(alice, ["push", "-q", "origin", "main"]);
    const laptop = cloneOf(home.remote, "alice-laptop");
    const ask = next(laptop);
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toContain("Carry on refunds");
    const resumed = take(laptop, "refunds");
    expect(resumed.status, resumed.out).toBe(0);
    expect(resumed.json).toMatchObject({ resumed: true, notice: "Carrying on refunds, the payments team's build here." });
    const step = next(laptop);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("refunds");
  });
});

describe("a team's own workspace, made from the home's", () => {
  test("the home's copied work is never offered to carry on; its Units are, reached by the home's address", () => {
    const home = homeWithTeams(["refunds=payments", "checkout-ui=web"]);
    const web = teamWorkspace(home.remote, "web");
    const ask = next(web);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(String(ask.question)).toStartWith(`fixture (its home is ${home.remote}) is built by teams, one Unit each.`);
    expect(String(ask.question)).toContain("checkout-ui (for web; likely checkout-web)");
    const labels = (ask.choices as Array<{ label: string }>).map((choice) => choice.label);
    expect(labels).toEqual(["Start refunds", "Start checkout-ui"]);
    const remotes = git(web, ["remote"]);
    const took = take(web, "checkout-ui");
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ team: "web", space: "web" });
    // No remote added: the home is reached by its address, into AI-DLC's own refs.
    expect(git(web, ["remote"])).toBe(remotes);
    expect(git(web, ["for-each-ref", "--format=%(refname)", "refs/aidlc/home/"])).toContain("integration");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ owner: "web", taken_by: "web" });
    expect(next(web).unit).toBe("checkout-ui");
  });

  test("a home that takes no push from here: a held Unit is taken and goes back by file; an open one names the lead's step", () => {
    const open = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n  - name: reporting\n    depends_on: []\n```\n";
    const home = homeWithTeams(["refunds=payments"], open);
    const hook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'this host takes no push from here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const pay = teamWorkspace(home.remote, "pay");
    const held = take(pay, "refunds");
    expect(held.status, held.out).toBe(0);
    expect(String(held.json?.notice)).toContain(
      "You can read the home but not write to it, so the result of refunds goes back as a file when it is built.",
    );
    expect(field(readFileSync(join(buildDir(pay, "payments", "refunds"), "aidlc-state.md"), "utf-8"), "Home Result")).toBe("by file");
    const openUnit = take(pay, "reporting", ["--team", "payments"]);
    expect(openUnit.status).not.toBe(0);
    expect(String(openUnit.json?.error)).toEndWith(
      "Ask the lead to hold it for your team: at the home they run /aidlc unit assign reporting=payments.",
    );
  });
});
