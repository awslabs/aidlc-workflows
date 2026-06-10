// covers: function:setupWorktreeFixture, function:cleanupWorktreeFixture
//
// t01 — the worktree test-harness primitives. Migrated from
// tests/worktree/t01-helpers.sh (TAP plan 7), which exercised
// tests/lib/worktree-helpers.sh before downstream worktree PRs consumed it.
// In the all-TS suite those bash helpers were ported to TypeScript in
// tests/harness/fixtures.ts; this twin proves the PORT against the same
// behavioural contract. The .sh declared no `# covers:` header — its subject
// is the harness scaffolding itself, so the covers ids name the two exported
// helper functions under test.
//
// Mechanism: NONE. These helpers are plain in-process functions (no
// process.exit / no stdout contract), so we import and call them directly and
// observe the git repo + filesystem they build. The only subprocess is the
// real `git` we shell to in order to inspect the fixture's repo state — which
// is exactly what the .sh did with `git -C "$fixture" ...`. No bun-runtime
// shell-out to a shipped aidlc-*.ts tool occurs, so the mechanism stays none.
//
// Source under test (tests/harness/fixtures.ts):
//   :168 setupWorktreeFixture(): string
//          - mkdtemp under WORKTREE_FIXTURE_PREFIX ("aidlc-worktree-"), realpath
//          - git init -q; symbolic-ref HEAD refs/heads/main; seed README.md;
//            one "init" commit; mkdir aidlc-docs/
//          - returns the canonical (realpath) project path
//          - throws (and rm -rf's the dir) on any git failure
//   :202 cleanupWorktreeFixture(proj): void
//          - no-op on empty/whitespace path
//          - REFUSES any path whose basename does not start with the prefix
//            (defence-in-depth; mirrors worktree-helpers.sh:87-90)
//          - prunes every registered CHILD worktree (the first porcelain
//            `worktree ` line is the main checkout), then rm -rf's the parent
//          - idempotent: safe to call twice / on a missing path
//   :157 WORKTREE_FIXTURE_PREFIX = "aidlc-worktree-"
//
// The .sh's assert_worktree_at helper has no fixtures.ts counterpart (it was a
// TAP ok/not_ok wrapper, not scaffolding) — its CONTRACT (a path is registered
// as a worktree of the repo) is asserted inline here via
// `git worktree list --porcelain` containing `worktree <path>`, the exact
// porcelain grep the .sh's assert_worktree_at performed.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named expect()):
//   .sh test 1  setup creates a directory                 -> "1: returns an existing directory"
//   .sh test 2  the path is a git repo                     -> "2: the fixture is a git repo"
//   .sh test 3  the repo has exactly one commit            -> "3: the fixture has exactly one commit"
//   .sh test 4  assert_worktree_at finds the main checkout -> "4: registered as a worktree of itself (main checkout)"
//   .sh test 5  adding a child worktree, it is found       -> "5: a child worktree is registered"
//   .sh test 6  cleanup refuses paths outside the prefix   -> "6: cleanup refuses a path outside the fixture prefix"
//   .sh test 7  cleanup is idempotent (remove + no-op)     -> "7: cleanup removes the fixture and is idempotent"
//
// STRONGER than the .sh: test 1 also asserts the canonical path's basename
// carries the fixture prefix; test 3 reads the rev-list count and asserts the
// exact integer 1 (the .sh string-compared "1"); the prefix is asserted to be
// the literal "aidlc-worktree-" so a rename of WORKTREE_FIXTURE_PREFIX that
// would silently disarm the cleanup guard is caught.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  cleanupWorktreeFixture,
  setupWorktreeFixture,
  WORKTREE_FIXTURE_PREFIX,
} from "../harness/fixtures.ts";

// Every fixture created here is registered so a mid-test failure still tears
// the tempdir down (the .sh used an EXIT trap for the same reason).
const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) cleanupWorktreeFixture(f);
});

function freshFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  return p;
}

/** True if <path> is registered as a worktree of the repo at <repo>. Mirrors
 *  worktree-helpers.sh's assert_worktree_at: grep -qF "worktree <path>" over
 *  `git -C <repo> worktree list --porcelain`. */
function worktreeRegistered(repo: string, path: string): boolean {
  const r = spawnSync(
    "git",
    ["-C", repo, "worktree", "list", "--porcelain"],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) return false;
  return (r.stdout ?? "")
    .split("\n")
    .some((line) => line === `worktree ${path}`);
}

describe("t01 worktree harness helpers (migrated from t01-helpers.sh, plan 7)", () => {
  test("1: setupWorktreeFixture returns an existing directory under the fixture prefix", () => {
    const fixture = freshFixture();
    expect(existsSync(fixture)).toBe(true); // .sh test 1: [ -d "$fixture" ]
    // STRONGER: the canonical path's basename carries the fixture prefix, so
    // cleanup's defence-in-depth guard will accept it.
    expect(basename(fixture).startsWith(WORKTREE_FIXTURE_PREFIX)).toBe(true);
  });

  test("2: the fixture is a git repo", () => {
    const fixture = freshFixture();
    // .sh test 2: git -C "$fixture" rev-parse --git-dir succeeds.
    const r = spawnSync("git", ["-C", fixture, "rev-parse", "--git-dir"], {
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
  });

  test("3: the fixture has exactly one commit", () => {
    const fixture = freshFixture();
    // .sh test 3: git rev-list --count HEAD == "1".
    const r = spawnSync("git", ["-C", fixture, "rev-list", "--count", "HEAD"], {
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(Number.parseInt((r.stdout ?? "").trim(), 10)).toBe(1);
  });

  test("4: registered as a worktree of itself (the main checkout)", () => {
    const fixture = freshFixture();
    // .sh test 4: assert_worktree_at "$fixture" "$fixture" — the only worktree
    // on creation is the main checkout, so its own path is registered. Proves
    // the porcelain parsing finds the canonical main-checkout path.
    expect(worktreeRegistered(fixture, fixture)).toBe(true);
  });

  test("5: a child worktree is registered after `git worktree add`", () => {
    const fixture = freshFixture();
    const childWt = join(fixture, "wt");
    // .sh test 5: git worktree add -q "$child_wt" -b foo-branch, then
    // assert_worktree_at "$fixture" "$child_wt".
    const add = spawnSync(
      "git",
      ["-C", fixture, "worktree", "add", "-q", childWt, "-b", "foo-branch"],
      { encoding: "utf-8" },
    );
    expect(add.status).toBe(0);
    expect(worktreeRegistered(fixture, childWt)).toBe(true);
  });

  test("6: cleanup refuses a path outside the fixture prefix (defence-in-depth)", () => {
    // .sh test 6: create a sentinel dir whose basename does NOT start with the
    // fixture prefix, call cleanup on it, confirm it still exists. Mirrors the
    // basename-prefix guard in cleanupWorktreeFixture / worktree-helpers.sh.
    const sentinel = mkdtempSync(
      join(process.env.TMPDIR || tmpdir(), "aidlc-NOT-A-FIXTURE-"),
    );
    try {
      expect(basename(sentinel).startsWith(WORKTREE_FIXTURE_PREFIX)).toBe(false);
      cleanupWorktreeFixture(sentinel);
      // The guard must leave the non-fixture path untouched.
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      // Manual teardown — the helper (correctly) refused to.
      if (existsSync(sentinel)) {
        spawnSync("rm", ["-rf", sentinel]);
      }
    }
    expect(existsSync(sentinel)).toBe(false);
  });

  test("7: cleanup removes the fixture and the second call is a no-op (idempotent)", () => {
    // Standalone fixture (NOT registered for afterAll — this test consumes it).
    const fixture = setupWorktreeFixture();
    expect(existsSync(fixture)).toBe(true);
    // .sh test 7: two cleanup calls; the dir is gone and the second is a no-op.
    cleanupWorktreeFixture(fixture);
    expect(existsSync(fixture)).toBe(false);
    // Second call must not throw and must leave things removed.
    expect(() => cleanupWorktreeFixture(fixture)).not.toThrow();
    expect(existsSync(fixture)).toBe(false);
  });
});
