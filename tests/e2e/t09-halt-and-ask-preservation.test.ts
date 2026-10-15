// covers: subcommand:aidlc-bolt:fail, subcommand:aidlc-worktree:create, subcommand:aidlc-worktree:info, audit:BOLT_FAILED
//
// The test pins the halt-and-ask
// PRESERVATION invariant: on a simulated Bolt failure, the
// aborted/skipped Bolt's worktree STAYS ON DISK for inspection unless the user
// explicitly discards. `aidlc-bolt fail` (orchestrator-emitted, code-gen
// returned an error) emits BOLT_FAILED and
// preserves the worktree; `aidlc-bolt abort
// --discard` tears it down (covered by the sibling t10).
//
// MECHANISM: this is a .test.ts on the cli arm — every observable is taken at
// the PROCESS boundary. We SPAWN the real binaries via spawnSync (BUN + the
// tool .ts path) and assert on res.status / res.stdout and the on-disk state
// the tools write (the real `git worktree add` directory + audit bytes). An
// in-process twin would lose the real git-worktree side effect, the audit
// emit, and the info-subcommand stdout-JSON contract.
//
// Source under test:
//   - dist/claude/.claude/tools/aidlc-worktree.ts handleCreate - runs a
//     REAL `git worktree add` after an audit-first WORKTREE_CREATED emit,
//     so the worktree dir lands at its intent-scoped worktreePath.
//   - dist/claude/.claude/tools/aidlc-bolt.ts handleFail - emits
//     BOLT_FAILED with `Failed Bolt`, `Error summary`, and (when --slug given)
//     a `Bolt slug` field. It does NOT spawn aidlc-worktree, NEVER
//     emits WORKTREE_DISCARDED, and touches no disk beyond the audit append —
//     THIS is the preservation guarantee (aidlc-bolt.ts comment block:
//     "halt-and-ask preserves the worktree by default").
//   - dist/claude/.claude/tools/aidlc-worktree.ts handleInfo - reads the
//     latest WORKTREE_CREATED block for the slug and prints {"path":...} JSON;
//     it resolves the live path EVEN AFTER the failure (the create block is
//     still the latest WORKTREE_CREATED, untouched by fail).
//
// FIXTURE: aidlc-worktree.ts runs real git and asserts it is invoked from the
// main checkout (assertNotSiblingWorktree, aidlc-worktree.ts). So the
// fixture is an ACTUAL git repo on `main` with one commit plus aidlc-docs/ —
// setupWorktreeFixture (tests/harness/fixtures.ts, ported from
// tests/lib/worktree-helpers.sh). The .sh additionally `mkdir -p aidlc-docs`;
// the fixture already creates it. cleanupWorktreeFixture prunes child worktrees
// then rm -rf's the parent. Nothing is written under tests/fixtures/**.
//
// Also asserted:
//   - A4: the exact `**Bolt slug**: x` audit field.
//   - A6: via real `git worktree list --porcelain`, that the path is still a
//     registered worktree, not merely a directory on disk.
//   - A7: an exact count of `**Event**: WORKTREE_DISCARDED` rows === 0 (the
//     discard event must NOT have fired - negative-invariant check, asserted on
//     the real post-fail audit, not a happy path).
//   - A8: info exits 0 and the resolved path equals the live Bolt worktree dir.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { worktreePath } from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  fixtureIntentId8,
  seededAuditDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const WT_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const BOLT_TOOL = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");

const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) cleanupWorktreeFixture(f);
});

/** Fresh git-repo fixture with the default intent in Construction, registered for cleanup. */
function freshFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  writeFileSync(seededStateFile(p), "- **Current Stage**: code-generation\n", "utf-8");
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

function run(p: string, tool: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", p], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
    cwd: p,
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

const wtDir = (p: string, slug: string): string =>
  worktreePath(p, fixtureIntentId8(p), slug);

function auditBody(p: string): string {
  const dir = seededAuditDir(p);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
}

function eventCount(p: string, event: string): number {
  return auditBody(p)
    .split("\n")
    .filter((l) => l === `**Event**: ${event}`).length;
}

function isWorktreeRegistered(repo: string, path: string): boolean {
  const r = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
    encoding: "utf-8",
  });
  if (r.status !== 0) return false;
  const expected = comparableWorktreePath(path);
  return (r.stdout ?? "")
    .split("\n")
    .some(
      (l) =>
        l.startsWith("worktree ") &&
        comparableWorktreePath(l.slice("worktree ".length)) === expected,
    );
}

function comparableWorktreePath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

describe("t09 halt-and-ask preserves the worktree on Bolt failure (migrated from t09-halt-and-ask-preservation.sh, plan 8)", () => {
  // ONE fixture is shared across the assertions: create a worktree for
  // slug x, then `aidlc-bolt fail --slug x`, then probe. A
  // module-scoped fixture is built once in setup, asserted across the cases below.
  let p: string;

  test("setup: create a worktree for slug x — dir on disk + WORKTREE_CREATED in audit [.sh A1, A2]", () => {
    p = freshFixture();
    const c = run(p, WT_TOOL, ["create", "--slug", "x", "--base", "main"]);
    expect(c.status).toBe(0);
    expect(existsSync(wtDir(p, "x"))).toBe(true);
    expect(eventCount(p, "WORKTREE_CREATED")).toBe(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    expect(eventCount(p, "BOLT_FAILED")).toBe(1);
    expect(body.includes("**Bolt slug**: x")).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("preservation: worktree still on disk + git-registered + ZERO WORKTREE_DISCARDED after BOLT_FAILED [.sh A5, A6, A7]", () => {
    // The directory survives the failure (no auto-discard).
    // fail() spawned nothing, so the worktree dir is untouched.
    expect(existsSync(wtDir(p, "x"))).toBe(true);
    expect(isWorktreeRegistered(p, wtDir(p, "x"))).toBe(true);
    // Negative invariant: the discard event must NOT have fired. Exactly
    // zero WORKTREE_DISCARDED rows — halt-and-ask did not auto-discard.
    expect(eventCount(p, "WORKTREE_DISCARDED")).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("info: aidlc-worktree info --slug x resolves the live path even after the failure [.sh A8]", () => {
    const i = run(p, WT_TOOL, ["info", "--slug", "x"]);
    // Assert exit 0 too, and that
    // the resolved path is the live Bolt worktree dir (the create block is
    // still the latest WORKTREE_CREATED — fail() left it intact).
    expect(i.status).toBe(0);
    expect(i.stdout).toContain('"path":');
    const parsed = JSON.parse(i.stdout.trim());
    expect(comparableWorktreePath(parsed.path)).toBe(comparableWorktreePath(wtDir(p, "x")));
    expect(parsed.slug).toBe("x");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
