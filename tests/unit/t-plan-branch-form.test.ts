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
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { repoCopyKey } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import {
  cleanupTeamBuild,
  ENV,
  git,
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
