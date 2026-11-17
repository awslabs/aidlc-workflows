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
import { chmodSync, existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoCopyKey } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import {
  cleanupTeamBuild,
  codeGenerated,
  codeHost,
  ENV,
  git,
  inSpace,
  makePlanHomeWithRemote,
  next,
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
});
