// covers: subcommand:aidlc-bolt:fail, subcommand:aidlc-worktree:create, subcommand:aidlc-worktree:info
//
// CLI-contract port of tests/worktree/t09-halt-and-ask-preservation.sh (TAP
// plan 8), mechanism = cli. The .sh pins the v0.4.0 milestone 12 halt-and-ask
// PRESERVATION invariant: on a simulated Bolt failure, the
// aborted/skipped Bolt's worktree STAYS ON DISK for inspection unless the user
// explicitly discards. `aidlc-bolt fail` (orchestrator-emitted, code-gen
// returned an error) is the no-side-effect verb — it emits BOLT_FAILED and
// NOTHING else; the only verb that tears a worktree down is `aidlc-bolt abort
// --discard` (covered by the sibling t10).
//
// MECHANISM: this is a .test.ts on the cli arm — every observable is taken at
// the PROCESS boundary. We SPAWN the real binaries via spawnSync (BUN + the
// tool .ts path) and assert on res.status / res.stdout and the on-disk state
// the tools write (the real `git worktree add` directory + audit.md bytes). An
// in-process twin would lose the real git-worktree side effect, the audit.md
// emit, and the info-subcommand stdout-JSON contract the .sh's preservation
// proof rests on.
//
// Source under test:
//   - dist/claude/.claude/tools/aidlc-worktree.ts handleCreate (:156) — runs a
//     REAL `git worktree add` after an audit-first WORKTREE_CREATED emit
//     (:186), so the worktree dir lands at .aidlc/worktrees/bolt-<slug>.
//   - dist/claude/.claude/tools/aidlc-bolt.ts handleFail (:457) — emits
//     BOLT_FAILED with `Failed Bolt`, `Error summary`, and (when --slug given)
//     a `Bolt slug` field (:467-469). It does NOT spawn aidlc-worktree, NEVER
//     emits WORKTREE_DISCARDED, and touches no disk beyond the audit append —
//     THIS is the preservation guarantee (comment block aidlc-bolt.ts:22-24,
//     493-497: "halt-and-ask preserves the worktree by default").
//   - dist/claude/.claude/tools/aidlc-worktree.ts handleInfo (:672) — reads the
//     latest WORKTREE_CREATED block for the slug and prints {"path":...} JSON;
//     it resolves the live path EVEN AFTER the failure (the create block is
//     still the latest WORKTREE_CREATED, untouched by fail).
//
// FIXTURE: aidlc-worktree.ts runs real git and asserts it is invoked from the
// main checkout (assertNotSiblingWorktree, aidlc-worktree.ts:101). So the
// fixture is an ACTUAL git repo on `main` with one commit plus aidlc-docs/ —
// setupWorktreeFixture (tests/harness/fixtures.ts, ported from
// tests/lib/worktree-helpers.sh). The .sh additionally `mkdir -p aidlc-docs`;
// the fixture already creates it. cleanupWorktreeFixture prunes child worktrees
// then rm -rf's the parent. Nothing is written under tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, every .sh `ok` line maps to an expect()):
//   .sh A1 assert_dir_exists bolt-x "worktree created on disk"          -> Test "setup": dir exists after create
//   .sh A2 assert_grep audit "Event.*WORKTREE_CREATED"                  -> Test "setup": WORKTREE_CREATED in audit
//   .sh A3 assert_grep audit "Event.*BOLT_FAILED"                       -> Test "fail emits": BOLT_FAILED in audit
//   .sh A4 assert_grep audit "Bolt slug.*x$"                            -> Test "fail emits": **Bolt slug**: x row present
//   .sh A5 assert_dir_exists bolt-x "preserved after BOLT_FAILED"       -> Test "preservation": dir still on disk
//   .sh A6 assert_worktree_at (git worktree list includes the path)     -> Test "preservation": git still registers the worktree
//   .sh A7 assert_eq DISCARD_COUNT 0 "zero WORKTREE_DISCARDED events"   -> Test "preservation": exactly zero WORKTREE_DISCARDED rows
//   .sh A8 assert_contains INFO_OUT '"path":' "info resolves path"      -> Test "info": info exits 0 and prints "path":<bolt-x dir>
//
// 8 .sh asserts -> 8 expect()-bearing assertions across 4 test() cases (grouped
// where the .sh shared the single failure-flow fixture). STRONGER than the .sh:
//   - A4: the .sh grepped any `Bolt slug.*x$` line; here we assert the exact
//     `**Bolt slug**: x` audit field (block-scoped, not a loose substring).
//   - A6: asserts via real `git worktree list --porcelain` that the path is
//     still a registered worktree (the .sh's assert_worktree_at), not merely a
//     directory on disk.
//   - A7: the .sh's `grep -c | -z fallback` to 0; here an exact count of
//     `**Event**: WORKTREE_DISCARDED` rows === 0 (the failure event must
//     NOT have fired — §6-E negative-invariant check, asserted on the real
//     post-fail audit, not a happy path).
//   - A8: the .sh only checked the `"path":` substring; here we ALSO assert
//     info exits 0 and the resolved path equals the live bolt-x worktree dir.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const WT_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const BOLT_TOOL = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");

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

/** Spawn `bun <tool> <subcommand> ... --project-dir <p>` from cwd=<p>. */
function run(p: string, tool: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", p], {
    cwd: p,
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");
const wtDir = (p: string, slug: string): string =>
  join(p, ".aidlc", "worktrees", `bolt-${slug}`);

function auditBody(p: string): string {
  const f = auditPath(p);
  return existsSync(f) ? readFileSync(f, "utf-8") : "";
}

/** Count `**Event**: <type>` rows of a given event type in audit.md. */
function eventCount(p: string, event: string): number {
  return auditBody(p)
    .split("\n")
    .filter((l) => l === `**Event**: ${event}`).length;
}

/** Is `path` a registered worktree of the git repo at `repo`? (assert_worktree_at). */
function isWorktreeRegistered(repo: string, path: string): boolean {
  const r = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) return false;
  return (r.stdout ?? "")
    .split("\n")
    .some((l) => l === `worktree ${path}`);
}

describe("t09 halt-and-ask preserves the worktree on Bolt failure (migrated from t09-halt-and-ask-preservation.sh, plan 8)", () => {
  // The .sh shares ONE fixture across all 8 assertions: create a worktree for
  // slug x, then `aidlc-bolt fail --slug x`, then probe. We mirror that with a
  // module-scoped fixture built once in setup, asserted across the cases below.
  let p: string;

  test("setup: create a worktree for slug x — dir on disk + WORKTREE_CREATED in audit [.sh A1, A2]", () => {
    p = freshFixture();
    const c = run(p, WT_TOOL, ["create", "--slug", "x", "--base", "main"]);
    expect(c.status).toBe(0);
    // A1: worktree directory landed on disk via the real `git worktree add`.
    expect(existsSync(wtDir(p, "x"))).toBe(true);
    // A2: the audit-first WORKTREE_CREATED row is present.
    expect(eventCount(p, "WORKTREE_CREATED")).toBe(1);
  }, 30000);

  test("fail: aidlc-bolt fail --slug x emits BOLT_FAILED with the Bolt slug field [.sh A3, A4]", () => {
    const f = run(p, BOLT_TOOL, [
      "fail",
      "--name",
      "Test Bolt",
      "--slug",
      "x",
      "--error",
      "fixture failure",
    ]);
    expect(f.status).toBe(0);
    expect(f.stdout).toContain('"emitted":"BOLT_FAILED"');
    const body = auditBody(p);
    // A3: BOLT_FAILED in the audit.
    expect(eventCount(p, "BOLT_FAILED")).toBe(1);
    // A4 (STRONGER): the exact `**Bolt slug**: x` audit field, not a loose grep.
    expect(body.includes("**Bolt slug**: x")).toBe(true);
  }, 30000);

  test("preservation: worktree still on disk + git-registered + ZERO WORKTREE_DISCARDED after BOLT_FAILED [.sh A5, A6, A7]", () => {
    // A5: the directory survives the failure (no auto-discard) — the v0.4.0 milestone 12
    // invariant. fail() spawned nothing, so the worktree dir is untouched.
    expect(existsSync(wtDir(p, "x"))).toBe(true);
    // A6 (STRONGER than dir-exists): git STILL registers it as a live worktree.
    expect(isWorktreeRegistered(p, wtDir(p, "x"))).toBe(true);
    // A7 (negative invariant): the discard event must NOT have fired. Exactly
    // zero WORKTREE_DISCARDED rows — halt-and-ask did not auto-discard.
    expect(eventCount(p, "WORKTREE_DISCARDED")).toBe(0);
  }, 30000);

  test("info: aidlc-worktree info --slug x resolves the live path even after the failure [.sh A8]", () => {
    const i = run(p, WT_TOOL, ["info", "--slug", "x"]);
    // The .sh only checked the `"path":` substring; assert exit 0 too, and that
    // the resolved path is the live bolt-x worktree dir (the create block is
    // still the latest WORKTREE_CREATED — fail() left it intact).
    expect(i.status).toBe(0);
    expect(i.stdout).toContain('"path":');
    const parsed = JSON.parse(i.stdout.trim());
    expect(parsed.path).toBe(wtDir(p, "x"));
    expect(parsed.slug).toBe("x");
  }, 30000);
});
