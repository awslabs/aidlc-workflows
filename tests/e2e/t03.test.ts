// covers: subcommand:aidlc-worktree:merge
//
// The test drives `aidlc-worktree.ts merge` - the subcommand
// that runs a REAL `git merge --squash` (and rebase) after an audit-first
// WORKTREE_MERGED emit, then either cleans up the worktree (success) or
// preserves it (conflict). The covers UNIT credited is
// subcommand:aidlc-worktree:merge.
//
// MECHANISM: every observable is taken at the PROCESS
// boundary — SPAWN the real binary via spawnSync (BUN + the tool .ts path) and
// assert on res.status / res.stdout / res.stderr plus the real git side effects
// (worktree directory removed-or-preserved). An in-process twin would lose the
// stdout-JSON contract ('"emitted":"WORKTREE_MERGED"', the conflict envelope)
// and the real git-merge / git-worktree-remove side effects.
//
// FIXTURE: aidlc-worktree.ts asserts it runs from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts) and runs real git, so each
// case needs an ACTUAL git repo on `main` with one commit plus an aidlc-docs/
// dir. setupWorktreeFixture (tests/harness/fixtures.ts) builds exactly that;
// the tool is spawned with cwd = the fixture so its HEAD / rev-parse resolves
// to the main checkout (the merge subcommand's defensive HEAD check requires
// the cwd to have <target> checked out). cleanupWorktreeFixture prunes child
// worktrees then removes the parent. Nothing is written under tests/fixtures/**.
//
// The `EDITOR=false` guard (so a stray `git commit` without --no-edit
// fails loudly instead of hanging) is set via env on every spawn.
//
// The success case also asserts the audit
// recorded a WORKTREE_MERGED row for the slug (the audit-first emit the JSON
// merely claims); the rebase-rejection case also asserts NO WORKTREE_MERGED
// audit row landed.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

// Force a non-interactive editor so any unexpected `git commit` without
// `--no-edit` fails loudly instead of hanging.
const ENV = {
  ...process.env,
  EDITOR: "false",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@x",
};

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

function tool(p: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", p], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
    cwd: p,
    encoding: "utf-8",
    env: ENV,
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS), cwd, encoding: "utf-8", env: ENV });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${r.stderr?.trim() || r.stdout?.trim() || `exit ${r.status}`}`,
    );
  }
}

const wtPath = (p: string, slug: string): string =>
  worktreePath(p, fixtureIntentId8(p), slug);

function readAudit(p: string): string {
  const dir = seededAuditDir(p);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
}

function hasMergedAudit(p: string, slug: string): boolean {
  const blocks = readAudit(p).split(/\n---\n/);
  return blocks.some(
    (b) =>
      /^\*\*Event\*\*:\s*WORKTREE_MERGED\b/m.test(b) &&
      new RegExp(`^\\*\\*Bolt slug\\*\\*:\\s*${slug}\\b`, "m").test(b),
  );
}

describe("t03 aidlc-worktree merge (migrated from t03-worktree-merge.sh, plan 13)", () => {
  test("1-3: squash merge happy path — exit 0, emits WORKTREE_MERGED, worktree removed", () => {
    const p = freshFixture();
    expect(tool(p, ["create", "--slug", "demo", "--base", "main"]).status).toBe(0);

    // Make a commit in the worktree so the squash has something to merge.
    const wt = wtPath(p, "demo");
    writeFileSync(join(wt, "feature.txt"), "feature\n");
    git(wt, ["add", "feature.txt"]);
    git(wt, ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "add feature"]);

    const r = tool(p, [
      "merge",
      "--slug", "demo",
      "--target", "main",
      "--strategy", "squash",
      "--message", "Bolt demo",
    ]);

    expect(r.status).toBe(0);
    expect(r.out).toContain('"emitted":"WORKTREE_MERGED"');
    expect(existsSync(wt)).toBe(false);
    // The audit-first WORKTREE_MERGED emit actually landed on disk.
    expect(hasMergedAudit(p, "demo")).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("4-5: defensive HEAD check fails when cwd is on a different branch", () => {
    const p = freshFixture();
    expect(tool(p, ["create", "--slug", "demo", "--base", "main"]).status).toBe(0);
    git(p, ["-c", "user.email=t@x", "-c", "user.name=t", "checkout", "-qb", "other-branch"]);

    const r = tool(p, ["merge", "--slug", "demo", "--target", "main", "--strategy", "squash"]);

    expect(r.status).not.toBe(0);
    expect(r.out).toContain("expected branch main, found other-branch");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("6-9: conflict envelope shape — non-zero, status/detail/conflict_files, worktree preserved", () => {
    const p = freshFixture();

    // Seed main with content the bolt will conflict against.
    writeFileSync(join(p, "conflict.txt"), "main version\n");
    git(p, ["add", "conflict.txt"]);
    git(p, ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "main writes conflict.txt"]);

    expect(tool(p, ["create", "--slug", "demo", "--base", "main"]).status).toBe(0);

    const wt = wtPath(p, "demo");
    writeFileSync(join(wt, "conflict.txt"), "bolt version\n");
    git(wt, ["add", "conflict.txt"]);
    git(wt, ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "bolt writes conflict.txt"]);

    // Now mutate main again so squash produces a conflict.
    writeFileSync(join(p, "conflict.txt"), "main version 2\n");
    git(p, ["add", "conflict.txt"]);
    git(p, ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "main writes conflict.txt v2"]);

    const r = tool(p, ["merge", "--slug", "demo", "--target", "main", "--strategy", "squash"]);

    expect(r.status).not.toBe(0);
    expect(r.out).toContain('"status":"conflict"');
    // The landing is staged in the main checkout, and the line says so and names the way on.
    const clash = JSON.parse(r.out) as { detail: string; next: string };
    expect(clash.detail).toContain(`Unit demo's landing clashes with what is already on main: it is staged in ${p}`);
    expect(clash.next).toContain("run this same merge again");
    // conflict_files lists exactly the conflicting path (pins both
    // non-empty AND the right path — listConflictFiles uses
    // `git diff --name-only --diff-filter=U`, deterministic).
    expect(r.out).toContain('"conflict_files":["conflict.txt"]');
    expect(existsSync(wt)).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("10-12: rebase strategy rejected pre-audit when no remote — non-zero, names remote, worktree preserved", () => {
    const p = freshFixture();
    expect(tool(p, ["create", "--slug", "demo", "--base", "main"]).status).toBe(0);

    const r = tool(p, ["merge", "--slug", "demo", "--target", "main", "--strategy", "rebase"]);

    expect(r.status).not.toBe(0);
    expect(r.out).toContain("rebase strategy requires a remote");
    // Worktree preserved - rebase failed pre-audit, never started.
    expect(existsSync(wtPath(p, "demo"))).toBe(true);
    // Pre-audit rejection means NO WORKTREE_MERGED row landed.
    expect(hasMergedAudit(p, "demo")).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
