// covers: subcommand:aidlc-unit:take
//
// The person's own take, from a clone whose git cannot read the file of a
// fetched branch that may hold their build: a blobless partial clone keeps
// that file on the host, and AI-DLC fetches nothing to read it. git cannot
// say whether that branch holds the build, so the take says today's line
// ("refunds is already taken: bea builds it.") and sends nobody to push or
// pull. gits answer that read in two ways: one stops at 128; a newer one, as
// on macOS, says the file it cannot read on stderr and goes on, answering 1
// (no match) or 0 (a match on another branch). The first case has whichever
// answer the git running it gives; the other two have the newer answer on any
// git, so a Linux run reads both.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupTeamBuild, cloneOf, GIT_ENV, git, makeHome, type PlanHome, run, STATE, sharePlan, tempDir, UNIT } from "../harness/team-build.ts";
import { asLeadsOwnCheckout } from "../harness/team-unit-merge.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

function take(dir: string, plan: PlanHome) {
  return run(UNIT, ["take", "refunds", "--plan", plan.id8, "--from", Object.values(plan.hosts)[0]], dir);
}

// bea's build of refunds on a branch of its own on origin, and her blobless
// partial clone of origin, which has never read that branch's files.
function beaBuildInBloblessClone(): { plan: PlanHome; bea: string; desk: string } {
  const home = makeHome();
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  asLeadsOwnCheckout(home.dir);
  commitAll(home.dir, "teams");
  git(home.dir, ["push", "-q", "origin", "main"]);
  const plan = sharePlan(home);
  const bea = cloneOf(home.remote, "bea");
  expect(take(bea, plan).status).toBe(0);
  git(bea, ["switch", "-q", "-c", "records/refunds"]);
  commitAll(bea, "refunds record");
  git(bea, ["push", "-q", "-u", "origin", "records/refunds"]);
  git(home.remote, ["config", "uploadpack.allowFilter", "true"]);
  const desk = join(tempDir("blobless"), "workspace");
  git(join(desk, ".."), ["clone", "-q", "--filter=blob:none", pathToFileURL(home.remote).href, desk]);
  git(desk, ["config", "user.name", "bea"]);
  git(desk, ["config", "user.email", "bea@example.test"]);
  return { plan, bea, desk };
}

// Every git answers as the newer one does in a clone that no longer names
// origin as its promisor: the file stays unread, and git says so and goes on.
function withoutPromisor(desk: string): void {
  for (const key of ["remote.origin.promisor", "remote.origin.partialclonefilter", "extensions.partialClone"]) {
    spawnSync("git", ["config", "--unset", key], { cwd: desk, env: GIT_ENV });
  }
  const pack = join(desk, ".git", "objects", "pack");
  for (const name of readdirSync(pack).filter((file) => file.endsWith(".promisor"))) unlinkSync(join(pack, name));
}

// git's own answer there to the take's read of fetched branches for a build of refunds.
function buildRead(desk: string, refs: string[]) {
  return spawnSync("git", ["grep", "--no-color", "-z", "-l", "-E", "-e", "^- \\*\\*Unit Build\\*\\*:[[:blank:]]*refunds[[:space:]]*$", ...refs,
    "--", "aidlc/spaces/*/intents/*/aidlc-state.md"], { cwd: desk, encoding: "utf-8", env: { ...GIT_ENV, GIT_LITERAL_PATHSPECS: "0" } });
}

describe("the person's own take, from a clone whose git cannot read a fetched branch", () => {
  test("a clone whose git cannot read a fetched branch keeps today's line for the person's own take", () => {
    const { plan, desk } = beaBuildInBloblessClone();
    const taken = take(desk, plan);
    expect(taken.status).not.toBe(0);
    expect(taken.out).toContain("refunds is already taken: bea builds it.");
    expect(taken.out).not.toContain("git pull");
  });

  test("a clone whose git says it cannot read a fetched branch and answers no match keeps today's line for the person's own take", () => {
    const { plan, desk } = beaBuildInBloblessClone();
    withoutPromisor(desk);
    const read = buildRead(desk, ["refs/remotes/origin/records/refunds"]);
    expect(read.status, read.stderr).toBe(1);
    expect(read.stderr.trim()).not.toBe("");
    const taken = take(desk, plan);
    expect(taken.status).not.toBe(0);
    expect(taken.out).toContain("refunds is already taken: bea builds it.");
    expect(taken.out).not.toContain("git pull");
  });

  test("a clone whose git says it cannot read a fetched branch and finds another work's build of the Unit beside it keeps today's line for the person's own take", () => {
    const { plan, bea, desk } = beaBuildInBloblessClone();
    // A build of a Unit named refunds for another piece of work, on a branch of its own.
    git(bea, ["switch", "-q", "-c", "records/other", "main"]);
    const other = join(bea, "aidlc", "spaces", "default", "intents", "other-refunds");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "aidlc-state.md"), "- **Unit Build**: refunds\n- **Home Work**: 00000000-0000-4000-8000-000000000000\n");
    commitAll(bea, "another build");
    git(bea, ["push", "-q", "-u", "origin", "records/other"]);
    git(desk, ["fetch", "-q", "origin"]);
    // Its file read once, so this clone has that one.
    const file = "aidlc/spaces/default/intents/other-refunds/aidlc-state.md";
    git(desk, ["show", `refs/remotes/origin/records/other:${file}`]);
    withoutPromisor(desk);
    const read = buildRead(desk, ["refs/remotes/origin/records/refunds", "refs/remotes/origin/records/other"]);
    expect(read.status, read.stderr).toBe(0);
    expect(read.stderr.trim()).not.toBe("");
    expect(read.stdout.split("\0").filter(Boolean)).toEqual([`refs/remotes/origin/records/other:${file}`]);
    const taken = take(desk, plan);
    expect(taken.status).not.toBe(0);
    expect(taken.out).toContain("refunds is already taken: bea builds it.");
    expect(taken.out).not.toContain("git pull");
  });
});
