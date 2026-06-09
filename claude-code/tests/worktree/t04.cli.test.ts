// covers: subcommand:aidlc-worktree:discard
//
// CLI-contract port of tests/worktree/t04-worktree-discard-list-verify.sh
// (TAP plan 12), mechanism = cli. The .sh exercises three read/destructive
// subcommands of aidlc-worktree.ts — discard, list, verify — but the single
// covers UNIT credited for this port is subcommand:aidlc-worktree:discard
// (the destructive one with the audit-first WORKTREE_DISCARDED emit + real
// git worktree-remove + branch -D side effects). list and verify are still
// asserted at full strength so parity is equal-or-stronger; they just aren't
// the credited id.
//
// MECHANISM: this is a .cli file, so every observable is taken at the PROCESS
// boundary — SPAWN the real binary via spawnSync (BUN + the tool .ts path) and
// assert on res.status / res.stdout / res.stderr and the on-disk worktree
// state the tool mutates. An in-process twin would lose the stdout-JSON
// contract ('"emitted":"WORKTREE_DISCARDED"', '"verified":true',
// '"reason":"absent"', '"reason":"stale ...') and the real
// git-worktree-remove + branch-delete effects the .sh relies on.
//
// FIXTURE: aidlc-worktree.ts asserts discard runs from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts:459->101) and runs real git, so
// each case needs an ACTUAL git repo on `main` with one commit plus an
// aidlc-docs/ dir. setupWorktreeFixture (tests/harness/fixtures.ts) builds
// exactly that; the tool is spawned with cwd = the fixture so its
// `git rev-parse --show-toplevel` resolves to the main checkout. The .sh's
// inline `git -C "$FIX2" worktree add -q ... -b unrelated` (the non-bolt
// worktree the list filter must exclude) is reproduced via spawnSync("git",
// ...) below. cleanupWorktreeFixture prunes child worktrees then rm -rf's the
// parent. Nothing is written under tests/fixtures/**.
//
// PARITY NOTES — every .sh assertion has an equal-or-stronger counterpart:
//   .sh T1  discard exits 0                                   -> Test "1-4" (same)
//   .sh T2  stdout '"emitted":"WORKTREE_DISCARDED"'            -> Test "1-4" (same)
//   .sh T3  discard removed the worktree dir (! -d bolt-demo)  -> Test "1-4" (same:
//           existsSync(.aidlc/worktrees/bolt-demo) === false)
//   .sh T4  second discard on gone slug exits 0 (idempotent)   -> Test "1-4" (same)
//   .sh T5  list exits 0                                       -> Test "5-7" (same)
//   .sh T6  list includes '"slug":"listed"'                    -> Test "5-7" (same)
//   .sh T7  list excludes "non-bolt-wt"                        -> Test "5-7" (same)
//   .sh T8  verify (present) exits 0                           -> Test "8-9" (same)
//   .sh T9  verify (present) '"verified":true'                 -> Test "8-9" (same)
//   .sh T10 verify (absent slug) exits non-zero                -> Test "10-11" (same)
//   .sh T11 verify (absent slug) '"reason":"absent"'           -> Test "10-11" (same)
//   .sh T12 verify --max-age-seconds 0 -> non-zero + reason="stale -> Test "12" (same)
//
// 12 .sh asserts -> 12+ expect()s across 4 test() cases (grouped where the .sh
// shared one fixture). STRONGER additions:
//   * T4 also asserts the idempotent second discard prints emitted:null with
//     reason "already-discarded" (the .sh only checked the exit code; the
//     handler's no-op contract — aidlc-worktree.ts:470-480 — is now pinned).
//   * T1-4 also asserts the bolt-demo branch is gone (git rev-parse on
//     refs/heads/bolt-demo fails), proving discard deletes the branch too, not
//     just the directory (aidlc-worktree.ts:502-510).
//   * T12 also asserts the verify (present, default window) case still passes
//     in the SAME fixture before the max-age=0 stale check, isolating that the
//     non-zero is the window, not an absent event.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) cleanupWorktreeFixture(f);
});

/** Fresh git-repo fixture on `main` + aidlc-docs/, registered for cleanup. */
function freshFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-worktree.ts <sub> ... --project-dir <p>` from cwd=<p>. */
function wt(p: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", p], {
    cwd: p,
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

const wtPath = (p: string, slug: string): string =>
  join(p, ".aidlc", "worktrees", `bolt-${slug}`);

/** True iff a local branch ref exists in the fixture repo. */
function branchExists(p: string, branch: string): boolean {
  const r = spawnSync(
    "git",
    ["-C", p, "rev-parse", "--verify", `refs/heads/${branch}`],
    { encoding: "utf-8" },
  );
  return r.status === 0;
}

describe("t04 aidlc-worktree discard/list/verify (migrated from t04-worktree-discard-list-verify.sh, plan 12)", () => {
  test("1-4: discard removes worktree + branch, emits WORKTREE_DISCARDED, idempotent on re-run", () => {
    const p = freshFixture();
    // Seed a worktree to discard.
    const created = wt(p, ["create", "--slug", "demo", "--base", "main"]);
    expect(created.status).toBe(0);
    expect(existsSync(wtPath(p, "demo"))).toBe(true);

    const r = wt(p, ["discard", "--slug", "demo"]);
    expect(r.status).toBe(0); // T1
    expect(r.out).toContain('"emitted":"WORKTREE_DISCARDED"'); // T2
    expect(existsSync(wtPath(p, "demo"))).toBe(false); // T3
    // STRONGER: the bolt-demo branch is deleted too (aidlc-worktree.ts:502-510).
    expect(branchExists(p, "bolt-demo")).toBe(false);

    // T4: second discard on the now-gone slug exits 0 (idempotent).
    const r2 = wt(p, ["discard", "--slug", "demo"]);
    expect(r2.status).toBe(0);
    // STRONGER: the no-op path emits null + reason already-discarded
    // (aidlc-worktree.ts:470-480).
    expect(r2.out).toContain('"emitted":null');
    expect(r2.out).toContain('"reason":"already-discarded"');
  }, 30000);

  test("5-7: list returns only bolt-* worktrees under the framework dir", () => {
    const p = freshFixture();
    // Add a NON-bolt worktree to confirm the filter excludes it (mirrors the
    // .sh's `git -C "$FIX2" worktree add -q "$FIX2/non-bolt-wt" -b unrelated`).
    const add = spawnSync(
      "git",
      ["-C", p, "worktree", "add", "-q", join(p, "non-bolt-wt"), "-b", "unrelated"],
      { encoding: "utf-8" },
    );
    expect(add.status).toBe(0);

    const created = wt(p, ["create", "--slug", "listed", "--base", "main"]);
    expect(created.status).toBe(0);

    const r = wt(p, ["list"]);
    expect(r.status).toBe(0); // T5
    expect(r.out).toContain('"slug":"listed"'); // T6
    expect(r.out).not.toContain("non-bolt-wt"); // T7
  }, 30000);

  test("8-9: verify finds the most recent matching event within the window", () => {
    const p = freshFixture();
    const created = wt(p, ["create", "--slug", "ver", "--base", "main"]);
    expect(created.status).toBe(0);

    const r = wt(p, ["verify", "--event", "WORKTREE_CREATED", "--slug", "ver"]);
    expect(r.status).toBe(0); // T8
    expect(r.out).toContain('"verified":true'); // T9
  }, 30000);

  test("10-12: verify reports absent for a missing slug and stale for an out-of-window event", () => {
    const p = freshFixture();
    const created = wt(p, ["create", "--slug", "ver", "--base", "main"]);
    expect(created.status).toBe(0);

    // T10-11: verify on a slug that never emitted WORKTREE_CREATED.
    const absent = wt(p, ["verify", "--event", "WORKTREE_CREATED", "--slug", "other"]);
    expect(absent.status).not.toBe(0); // T10
    expect(absent.out).toContain('"reason":"absent"'); // T11

    // STRONGER: the present event still verifies within the default window —
    // isolates that the stale failure below is the window, not an absent event.
    const present = wt(p, ["verify", "--event", "WORKTREE_CREATED", "--slug", "ver"]);
    expect(present.status).toBe(0);
    expect(present.out).toContain('"verified":true');

    // T12: --max-age-seconds 0 makes even the fresh entry stale.
    const stale = wt(p, [
      "verify",
      "--event",
      "WORKTREE_CREATED",
      "--slug",
      "ver",
      "--max-age-seconds",
      "0",
    ]);
    expect(stale.status).not.toBe(0);
    expect(stale.out).toContain('"reason":"stale');
  }, 30000);
});
