// covers: subcommand:aidlc-worktree:create
//
// CLI-contract port of tests/e2e/t06-worktree-sibling-rejection.sh (TAP
// plan 3), mechanism = cli. The .sh drives `aidlc-worktree.ts create` from
// INSIDE a sibling worktree to prove the tool's pre-audit
// assertNotSiblingWorktree guard (aidlc-worktree.ts:101-121, called at
// :162 before any audit emit) rejects the call. The covers UNIT credited is
// subcommand:aidlc-worktree:create — the same subcommand t02 covers, here
// exercised on its sibling-rejection branch.
//
// MECHANISM: this is a .cli file, so every observable is taken at the PROCESS
// boundary — SPAWN the real binary via spawnSync (BUN + the tool .ts path) and
// assert on res.status / combined stdout+stderr (the .sh's 2>&1). The guard
// fires inside the real process from the real cwd, so an in-process twin would
// not reproduce the `git rev-parse --show-toplevel` resolution that drives the
// main-checkout-vs-sibling comparison.
//
// FIXTURE: aidlc-worktree.ts resolves the main checkout from process cwd, so
// the .sh builds a REAL sibling worktree under
// <fixture>/.claude/worktrees/dev-slug (via `git worktree add -b dev-branch`)
// and runs the tool with cwd = that sibling. setupWorktreeFixture
// (tests/harness/fixtures.ts) builds the parent git repo on `main` with one
// commit + aidlc-docs/; we add the sibling inline with spawnSync("git", ...)
// exactly as the .sh did. cleanupWorktreeFixture prunes child worktrees then
// rm -rf's the parent. Nothing is written under tests/fixtures/**.
//
// PARITY NOTES — every .sh assertion has an equal-or-stronger counterpart:
//   .sh T1  create from sibling worktree exits non-zero          -> expect status !== 0
//   .sh T2  error names "must run from the main repo checkout"    -> expect out contains it
//   .sh T3  error explains "siblings of the main checkout, not nested"
//                                                                 -> expect out contains it
//
// 3 .sh asserts -> 3 equal counterparts + STRONGER additions: the guard is
// pre-audit, so we also assert NO WORKTREE_CREATED row for the slug landed in
// the sibling's audit.md and NO bolt-demo worktree dir was created (the .sh's
// "pre-audit check" intent, which it only documented in its header comment).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  seededAuditDir,
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

/** Add a real sibling worktree at <fixture>/.claude/worktrees/dev-slug on a
 *  new dev-branch, mirroring the .sh's
 *  `git -C "$fixture" worktree add -q "$SIBLING" -b dev-branch`. */
function addSibling(fixture: string): string {
  const sibling = join(fixture, ".claude", "worktrees", "dev-slug");
  const r = spawnSync(
    "git",
    ["-C", fixture, "worktree", "add", "-q", sibling, "-b", "dev-branch"],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `git worktree add (sibling) failed: ${r.stderr?.trim() || r.stdout?.trim() || `exit ${r.status}`}`,
    );
  }
  return sibling;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn `bun aidlc-worktree.ts create ... --project-dir <p>` from cwd=<cwd>. */
function create(cwd: string, projectDir: string, args: string[]): CliResult {
  const res = spawnSync(
    BUN,
    [TOOL, "create", ...args, "--project-dir", projectDir],
    { cwd, encoding: "utf-8" },
  );
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/** Count `**Bolt slug**: <slug>` rows across the seeded record's audit shards
 *  (audit/*.md). The sibling worktree never carries the record (it's seeded after
 *  the fixture's seed commit, so it doesn't travel), so its shard dir is absent →
 *  [] — exactly the negative the guard-fires-pre-audit assertion wants. */
function boltSlugRows(dir: string): string[] {
  const auditDir = seededAuditDir(dir);
  let names: string[];
  try {
    names = readdirSync(auditDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    for (const line of readFileSync(join(auditDir, n), "utf-8").split("\n")) {
      const m = line.match(/^\*\*Bolt slug\*\*:\s*(\S+)/);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

const wtPath = (dir: string, slug: string): string =>
  join(dir, ".aidlc", "worktrees", `bolt-${slug}`);

describe("t06 aidlc-worktree sibling rejection (migrated from t06-worktree-sibling-rejection.sh, plan 3)", () => {
  test("1-3: create from inside a sibling worktree is rejected pre-audit with the main-checkout error", () => {
    const fixture = freshFixture();
    const sibling = addSibling(fixture);

    // Run aidlc-worktree create from INSIDE the sibling worktree.
    const r = create(sibling, sibling, ["--slug", "demo", "--base", "main"]);

    expect(r.status).not.toBe(0); // T1
    expect(r.out).toContain("must run from the main repo checkout"); // T2
    expect(r.out).toContain("siblings of the main checkout, not nested"); // T3

    // STRONGER: the guard fires BEFORE the audit emit, so nothing landed in
    // either checkout's audit, and no bolt-demo worktree dir was created.
    expect(boltSlugRows(sibling)).not.toContain("demo");
    expect(boltSlugRows(fixture)).not.toContain("demo");
    expect(existsSync(wtPath(sibling, "demo"))).toBe(false);
    expect(existsSync(wtPath(fixture, "demo"))).toBe(false);
  }, 30000);
});
