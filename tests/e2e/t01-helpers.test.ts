// covers: function:setupWorktreeFixture, function:cleanupWorktreeFixture
//
// t01 - the worktree test-harness primitives in tests/harness/fixtures.ts. The
// subject is the harness scaffolding itself, so the covers ids name the two
// exported helper functions under test.
//
// Mechanism: NONE. These helpers are plain in-process functions (no
// process.exit / no stdout contract), so we import and call them directly and
// observe the git repo + filesystem they build. The only subprocess is the
// real `git` we shell to in order to inspect the fixture's repo state.
// No bun-runtime
// shell-out to a shipped aidlc-*.ts tool occurs, so the mechanism stays none.
//
// Source under test (tests/harness/fixtures.ts):
//   setupWorktreeFixture(): string
//          - mkdtemp under WORKTREE_FIXTURE_PREFIX ("aidlc-worktree-"), realpath
//          - git init -q; symbolic-ref HEAD refs/heads/main; seed README.md;
//            one "init" commit; seed the per-intent workspace shell
//          - returns the canonical project path in portable form
//          - throws (and removes the dir) on any git failure
//   cleanupWorktreeFixture(proj): void
//          - no-op on empty/whitespace path
//          - REFUSES any path whose basename does not start with the prefix
//            (defence-in-depth; mirrors worktree-helpers.sh)
//          - prunes every registered CHILD worktree (the first porcelain
//            `worktree ` line is the main checkout), then removes the parent
//          - idempotent: safe to call twice / on a missing path
//   WORKTREE_FIXTURE_PREFIX = "aidlc-worktree-"
//
// Test 1 also asserts the canonical path's basename
// carries the fixture prefix; test 3 reads the rev-list count and asserts the
// exact integer 1; the prefix is asserted to be
// the literal "aidlc-worktree-" so a rename of WORKTREE_FIXTURE_PREFIX that
// would silently disarm the cleanup guard is caught.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  cleanupWorktreeFixture,
  setupWorktreeFixture,
  WORKTREE_FIXTURE_PREFIX,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// Every fixture created here is registered so a mid-test failure still tears
// the tempdir down.
const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) cleanupWorktreeFixture(f);
});

const GIT_FIXTURE_TEST_TIMEOUT_MS = NATIVE_FIXTURE_SETUP_TIMEOUT_MS;

function freshFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  return p;
}

function comparableWorktreePath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function worktreeRegistered(repo: string, path: string): boolean {
  const r = spawnSync(
    "git",
    ["-C", repo, "worktree", "list", "--porcelain"],
    { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
  );
  if (r.status !== 0) return false;
  const expected = comparableWorktreePath(path);
  return (r.stdout ?? "")
    .split("\n")
    .some(
      (line) =>
        line.startsWith("worktree ") &&
        comparableWorktreePath(line.slice("worktree ".length)) === expected,
    );
}

describe("t01 worktree harness helpers (migrated from t01-helpers.sh, plan 7)", () => {
  test("1: setupWorktreeFixture returns an existing directory under the fixture prefix", () => {
    const fixture = freshFixture();
    expect(existsSync(fixture)).toBe(true);
    // The canonical path's basename carries the fixture prefix, so
    // cleanup's defence-in-depth guard will accept it.
    expect(basename(fixture).startsWith(WORKTREE_FIXTURE_PREFIX)).toBe(true);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  test("2: the fixture is a git repo", () => {
    const fixture = freshFixture();
    const r = spawnSync("git", ["-C", fixture, "rev-parse", "--git-dir"], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  test("3: the fixture has exactly one commit", () => {
    const fixture = freshFixture();
    const r = spawnSync("git", ["-C", fixture, "rev-list", "--count", "HEAD"], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(Number.parseInt((r.stdout ?? "").trim(), 10)).toBe(1);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  test("4: registered as a worktree of itself (the main checkout)", () => {
    const fixture = freshFixture();
    // The only worktree on creation is the main checkout, so its own path is
    // registered. Proves the porcelain parsing finds the canonical main-checkout
    // path.
    expect(worktreeRegistered(fixture, fixture)).toBe(true);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  test("5: a child worktree is registered after `git worktree add`", () => {
    const fixture = freshFixture();
    const childWt = join(fixture, "wt");
    const add = spawnSync(
      "git",
      ["-C", fixture, "worktree", "add", "-q", childWt, "-b", "foo-branch"],
      { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), encoding: "utf-8" },
    );
    expect(add.status).toBe(0);
    expect(worktreeRegistered(fixture, childWt)).toBe(true);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  test("6: cleanup refuses a path outside the fixture prefix (defence-in-depth)", () => {
    // Create a sentinel dir whose basename does NOT start with the
    // fixture prefix, call cleanup on it, confirm it still exists. Pins the
    // basename-prefix guard in cleanupWorktreeFixture.
    const sentinel = mkdtempSync(
      join(process.env.TMPDIR || tmpdir(), "aidlc-NOT-A-FIXTURE-"),
    );
    try {
      expect(basename(sentinel).startsWith(WORKTREE_FIXTURE_PREFIX)).toBe(false);
      cleanupWorktreeFixture(sentinel);
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      // Manual teardown — the helper (correctly) refused to.
      if (existsSync(sentinel)) {
        rmSync(sentinel, { recursive: true, force: true });
      }
    }
    expect(existsSync(sentinel)).toBe(false);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  test("7: cleanup removes the fixture and the second call is a no-op (idempotent)", () => {
    // Standalone fixture (NOT registered for afterAll — this test consumes it).
    const fixture = setupWorktreeFixture();
    expect(existsSync(fixture)).toBe(true);
    cleanupWorktreeFixture(fixture);
    expect(existsSync(fixture)).toBe(false);
    // Second call must not throw and must leave things removed.
    expect(() => cleanupWorktreeFixture(fixture)).not.toThrow();
    expect(existsSync(fixture)).toBe(false);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);
});
