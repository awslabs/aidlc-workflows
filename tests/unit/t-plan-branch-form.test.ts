// covers: function:lookAt, function:homeCopyOnBranchOf, subcommand:aidlc-unit:take, subcommand:aidlc-orchestrate:next
//
// A Unit's record its repository holds as a branch, aidlc/claims/<work id>/<unit>, where a repository takes
// no ref of AI-DLC's but a branch: every look reads both forms, each into a copy of its own, and the copy
// every reader reads holds the one that counts. A record that is a branch only counts; a branch that moved
// on from the ref's commit counts; where two writers made one each at one moment, the ref counts. A take
// reads it as taken, so the first take still wins. A look that does not finish keeps the copies it had.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoCopyKey } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import {
  cleanupTeamBuild,
  codeGenerated,
  codeHost,
  ENV,
  git,
  HOME_RECORD,
  inSpace,
  makePlanHome,
  makePlanHomeWithRemote,
  next,
  planRefOf,
  recordHostOf,
  refundsTaken,
  run,
  teamWorkspace,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const SOMEONE = { ...ENV, GIT_AUTHOR_NAME: "dan", GIT_AUTHOR_EMAIL: "dan@example.test", GIT_COMMITTER_NAME: "dan", GIT_COMMITTER_EMAIL: "dan@example.test" };
const refOf = (id8: string, unit: string): string => `refs/aidlc/claims/${id8}/${unit}`;
const branchOf = (id8: string, unit: string): string => `refs/heads/aidlc/claims/${id8}/${unit}`;

// A host that refuses a push to any name under `prefixes`, as a rule of its own (git's "[remote rejected]").
function refuse(host: string, prefixes: string[]): void {
  const hook = join(host, "hooks", "pre-receive");
  const cases = prefixes.map((prefix) => `${prefix}*) echo 'this host takes no push of ${prefix}' >&2; exit 1;;`).join(" ");
  writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do case "$ref" in ${cases} esac; done\nexit 0\n`);
  chmodSync(hook, 0o755);
}

// refunds taken by alice, as refundsTaken takes it, with `before` run on the record's host first; the take's output.
function takenWhere(before: (host: string) => void) {
  const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
  const home = makePlanHomeWithRemote({ repos: hosts });
  const host = recordHostOf(home, "refunds");
  before(host);
  const alice = teamWorkspace(hosts, "alice");
  inSpace(alice, "payments");
  const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", hosts["checkout-api"]], alice);
  const intents = join(alice, "aidlc", "spaces", "payments", "intents");
  const record = existsSync(intents) ? join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds")) ?? "") : "";
  return { hosts, home, host, alice, record, took };
}

const has = (host: string, ref: string): boolean => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: host }).status === 0;

// The record at `host` moved from its ref to its branch, as a repository that takes only branches holds it.
function recordAsBranch(host: string, id8: string, unit: string): string {
  const tip = git(host, ["rev-parse", refOf(id8, unit)]);
  git(host, ["update-ref", branchOf(id8, unit), tip]);
  git(host, ["update-ref", "-d", refOf(id8, unit)]);
  return tip;
}

// A record commit made at `host` by hand: unit.json as given, on `parent` (none: a root).
function recordCommit(host: string, json: Record<string, unknown>, parent: string | null): string {
  const out = (args: string[], input?: string): string => spawnSync("git", args, { cwd: host, encoding: "utf-8", env: SOMEONE, input }).stdout.trim();
  const blob = out(["hash-object", "-w", "--stdin"], `${JSON.stringify(json, null, 2)}\n`);
  const tree = out(["mktree"], `100644 blob ${blob}\tunit.json\n`);
  return out(["commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", "aidlc unit refunds: by hand"]);
}

const board = (dir: string, chat: string): string => String(next(dir, { ...ENV, AIDLC_SESSION_OVERRIDE: chat }).narration ?? "");
const leadsCopy = (dir: string, host: string, id8: string, unit: string): string =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/aidlc/home/${id8}/${repoCopyKey(host)}/claims/${unit}`], { cwd: dir, encoding: "utf-8" }).stdout.trim();

describe("a record its repository holds as a branch", () => {
  test("is read by the lead's look as the record: refunds is taken by alice", () => {
    const { home } = refundsTaken();
    recordAsBranch(recordHostOf(home, "refunds"), home.id8, "refunds");
    expect(board(home.dir, "lead-later"), "the lead's board").toContain("refunds, payments space: building, taken by alice");
  });

  test("is read by a take, so a second team is told it is taken and writes nothing", () => {
    const { home, hosts } = refundsTaken();
    const host = recordHostOf(home, "refunds");
    const tip = recordAsBranch(host, home.id8, "refunds");
    const sam = teamWorkspace(hosts, "sam");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", hosts["checkout-api"]], sam);
    expect(took.status, took.out).not.toBe(0);
    expect(took.out).toContain("refunds is already taken: alice builds it");
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", refOf(home.id8, "refunds")], { cwd: host }).status).not.toBe(0);
    expect(git(host, ["rev-parse", branchOf(home.id8, "refunds")])).toBe(tip);
  });

  test("a branch that moved on from the ref's commit counts; one a second writer made beside the ref does not", () => {
    const { home } = refundsTaken();
    const host = recordHostOf(home, "refunds");
    const ref = git(host, ["rev-parse", refOf(home.id8, "refunds")]);
    const taken = JSON.parse(git(host, ["show", `${ref}:unit.json`])) as Record<string, unknown>;
    // Another writer's take at the same moment, as a branch with a history of its own: the ref counts.
    git(host, ["update-ref", branchOf(home.id8, "refunds"), recordCommit(host, { ...taken, taken_by: "dan" }, null)]);
    expect(board(home.dir, "lead-1")).toContain("refunds, payments space: building, taken by alice");
    expect(leadsCopy(home.dir, host, home.id8, "refunds")).toBe(ref);
    // The record's next commit on the ref's, written as the branch: the branch counts.
    const onTop = recordCommit(host, { ...taken, note: "a later write" }, ref);
    git(host, ["update-ref", branchOf(home.id8, "refunds"), onTop]);
    board(home.dir, "lead-2");
    expect(leadsCopy(home.dir, host, home.id8, "refunds")).toBe(onTop);
  });

  test("a look that does not finish keeps the copy it had, never a record gone", () => {
    const { home } = refundsTaken();
    const host = recordHostOf(home, "refunds");
    const tip = recordAsBranch(host, home.id8, "refunds");
    expect(board(home.dir, "lead-1")).toContain("taken by alice");
    expect(leadsCopy(home.dir, host, home.id8, "refunds")).toBe(tip);
    // A later commit on the branch the host cannot send: its object is gone from the host.
    const later = recordCommit(host, { note: "cannot be sent" }, tip);
    git(host, ["update-ref", branchOf(home.id8, "refunds"), later]);
    const object = join(host, "objects", later.slice(0, 2), later.slice(2));
    expect(existsSync(object)).toBe(true);
    unlinkSync(object);
    board(home.dir, "lead-2");
    expect(leadsCopy(home.dir, host, home.id8, "refunds")).toBe(tip);
  });
});

describe("a record written where its repository takes no ref of AI-DLC's", () => {
  test("a take goes on its branch, said once with the host's words, and the first take still wins", () => {
    const { hosts, home, host, took } = takenWhere((at) => refuse(at, ["refs/aidlc/"]));
    expect(took.status, took.out).toBe(0);
    expect(took.out).toContain("did not take refunds's record out of its branch list (");
    expect(took.out).toContain(`so the record there is the branch aidlc/claims/${home.id8}/refunds. It is not for merging. ` +
      "A job that runs on every branch there (a check, a clean-up) can leave it alone by the pattern aidlc/**.");
    expect(took.out).not.toContain("takes no push from you");
    expect(has(host, branchOf(home.id8, "refunds"))).toBe(true);
    expect(has(host, refOf(home.id8, "refunds"))).toBe(false);
    const sam = teamWorkspace(hosts, "sam");
    const again = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", hosts["checkout-api"]], sam);
    expect(again.status, again.out).not.toBe(0);
    expect(again.out).toContain("refunds is already taken: alice builds it");
  });

  test("a branch in the way of the record's branch is said in git's words, never as a take that lost", () => {
    const { home, host, took } = takenWhere((at) => {
      refuse(at, ["refs/aidlc/"]);
      git(at, ["update-ref", "refs/heads/aidlc/claims", git(at, ["rev-parse", "refs/heads/main"])]);
    });
    expect(took.status, took.out).toBe(0);
    const said = String(took.json?.notice);
    expect(said).toContain("has a branch in the way of refunds's record (git says \"cannot lock ref");
    expect(said).toContain("exists; cannot create");
    expect(said).toContain("Your take of refunds is not written there, and someone else could still take it.");
    expect(took.out).not.toContain("changed while I was writing it");
    expect(has(host, branchOf(home.id8, "refunds"))).toBe(false);
  });

  test("a result pushed onto a record that is a branch goes on that branch", () => {
    const { home, alice, record } = refundsTaken();
    const host = recordHostOf(home, "refunds");
    const tip = recordAsBranch(host, home.id8, "refunds");
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.out).not.toContain("did not take refunds's result");
    const now = git(host, ["rev-parse", branchOf(home.id8, "refunds")]);
    expect(now).not.toBe(tip);
    expect(git(host, ["rev-parse", `${now}^`])).toBe(tip);
    expect(has(host, refOf(home.id8, "refunds"))).toBe(false);
  });

  test("a result whose ref and branch a rule both refuse names both for the repository's owner", () => {
    const { home, alice, record } = refundsTaken();
    const host = recordHostOf(home, "refunds");
    refuse(host, ["refs/aidlc/", "refs/heads/aidlc/"]);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.out).toContain("ask whoever owns checkout-api to let your pushes to refs/aidlc/claims/ or to branches under " +
      "aidlc/claims/ through, then ask me to send it again.");
    expect(has(host, branchOf(home.id8, "refunds"))).toBe(false);
  });

  test("a take not written yet is written again on a branch only at a step the person ran, never at a quiet look", () => {
    const { home, host, alice, record, took } = takenWhere((at) => refuse(at, ["refs/aidlc/", "refs/heads/aidlc/"]));
    expect(took.out, took.out).toContain("takes no push from you");
    refuse(host, ["refs/aidlc/"]);
    next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: "alice-later" });
    expect(has(host, branchOf(home.id8, "refunds"))).toBe(false);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(has(host, branchOf(home.id8, "refunds"))).toBe(true);
  });

  test("a change proposed where the record's repository no longer takes its ref puts the record on its branch, and says so", () => {
    const { home, alice, record } = refundsTaken();
    const host = recordHostOf(home, "refunds");
    refuse(host, ["refs/aidlc/"]);
    const requirements = "inception/requirements-analysis/requirements.md";
    writeFileSync(join(record, ...requirements.split("/")), "# Requirements\n\nFR1 refunds, partial amounts too.\n");
    const sent = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds need partial amounts"], alice);
    expect(sent.status, sent.out).toBe(0);
    expect(String(sent.json?.notice)).toContain(`checkout-api did not take refunds's record out of its branch list (`);
    expect(String(sent.json?.notice)).toContain(`so the record there is the branch aidlc/claims/${home.id8}/refunds. It is not for merging.`);
    expect(has(host, branchOf(home.id8, "refunds"))).toBe(true);
  });
});

// The plan at `host` moved from its ref to its branch, aidlc/plans/<id8>-<label>.
function planAsBranch(host: string, id8: string, label = "fixture"): string {
  const tip = git(host, ["rev-parse", planRefOf(id8)]);
  git(host, ["update-ref", `refs/heads/aidlc/plans/${id8}-${label}`, tip]);
  git(host, ["update-ref", "-d", planRefOf(id8)]);
  return tip;
}

// plan.json at `tip` as `edit` leaves it, one commit on `parent` (none: a root) at `host`.
function planCommit(host: string, tip: string, edit: (plan: { units: Array<{ name: string; word: Record<string, unknown> }> }) => void, parent: string | null): string {
  const out = (args: string[], input?: string): string => spawnSync("git", args, { cwd: host, encoding: "utf-8", env: SOMEONE, input }).stdout.trim();
  const plan = JSON.parse(git(host, ["show", `${tip}:plan.json`]));
  edit(plan);
  const blob = out(["hash-object", "-w", "--stdin"], `${JSON.stringify(plan, null, 2)}\n`);
  const entries = out(["ls-tree", tip]).split("\n").map((line) => (line.endsWith("\tplan.json") ? `100644 blob ${blob}\tplan.json` : line));
  return out(["commit-tree", out(["mktree"], `${entries.join("\n")}\n`), ...(parent === null ? [] : ["-p", parent]), "-m", "aidlc plan fixture 9: by hand"]);
}

const starts = (step: Record<string, unknown>): string[] =>
  ((step.choices ?? []) as Array<{ label: string }>).map((choice) => choice.label).filter((label) => label.startsWith("Start "));

describe("a plan its repository holds as a branch", () => {
  test("is found by a teammate's look and its Units are offered, and a take reads it there", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    planAsBranch(host, home.id8);
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    const step = next(sam, ENV, ["--units"]);
    expect(starts(step), JSON.stringify(step).slice(0, 600)).toContain("Start checkout-ui");
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", host], sam);
    expect(took.status, took.out).toBe(0);
    expect(took.out).toContain("checkout-ui is yours.");
  });

  test("a branch that moved on from the ref's commit counts; one with a history of its own beside the ref does not", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const ref = git(host, ["rev-parse", planRefOf(home.id8)]);
    const done = (plan: { units: Array<{ name: string; word: Record<string, unknown> }> }): void => {
      for (const unit of plan.units) if (unit.name === "checkout-ui") unit.word = { done: true };
    };
    const branch = `refs/heads/aidlc/plans/${home.id8}-fixture`;
    git(host, ["update-ref", branch, planCommit(host, ref, done, null)]);
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    expect(starts(next(sam, ENV, ["--units"]))).toContain("Start checkout-ui");
    git(host, ["update-ref", branch, planCommit(host, ref, done, ref)]);
    expect(starts(next(sam, { ...ENV, AIDLC_SESSION_OVERRIDE: "sam-later" }, ["--units"]))).not.toContain("Start checkout-ui");
  });

  test("gone from its repository in both forms: a build says so and keeps the copies it read", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    planAsBranch(host, home.id8);
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", host], pay).status).toBe(0);
    const copy = `refs/aidlc/home/${home.id8}-fixture/${repoCopyKey(host)}/on-branch/plan`;
    expect(git(pay, ["rev-parse", copy])).toBe(home.plan!);
    git(host, ["update-ref", "-d", `refs/heads/aidlc/plans/${home.id8}-fixture`]);
    const step = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" }, ["--units"]);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 800)).toContain(
      "The plan of fixture is no longer in checkout-api. This build carries on from the copy here; no other Unit of it can be taken while it is gone.",
    );
    expect(git(pay, ["rev-parse", copy])).toBe(home.plan!);
    expect(git(pay, ["rev-parse", `refs/aidlc/home/${home.id8}/${repoCopyKey(host)}/plan`])).toBe(home.plan!);
  });

  test("two branches of one plan, under two labels, and no ref: neither is read as the plan", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const tip = planAsBranch(host, home.id8);
    git(host, ["update-ref", `refs/heads/aidlc/plans/${home.id8}-another`, tip]);
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    expect(starts(next(sam, ENV, ["--units"]))).toEqual([]);
  });

  test("the copy of a plan read from a branch is never kept under the work's own folder", () => {
    const home = makePlanHome();
    planAsBranch(home.hosts["checkout-api"], home.id8);
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    next(sam, ENV, ["--units"]);
    expect(git(sam, ["for-each-ref", "--format=%(refname)", `refs/aidlc/home/${home.id8}/`]).split("\n").filter((ref) => ref.includes("/on-branch/plan"))).toEqual([]);
  });
});

// A Unit added to the lead's Unit plan after the share.
function addUnit(dir: string): void {
  const path = join(dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "inception", "units-generation", "unit-of-work-dependency.md");
  writeFileSync(path, readFileSync(path, "utf-8").replace("```\n", "  - name: ledger-sync\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
}

describe("a plan on its branch, written by the lead", () => {
  test("a later share goes on the plan's branch, on its tip, and no ref is made beside it", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const tip = planAsBranch(host, home.id8);
    addUnit(home.dir);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(String(shared.json?.notice)).toContain("The plan in checkout-api has ledger-sync now.");
    expect(git(host, ["rev-parse", `refs/heads/aidlc/plans/${home.id8}-fixture^`])).toBe(tip);
    expect(has(host, planRefOf(home.id8))).toBe(false);
  });
});
