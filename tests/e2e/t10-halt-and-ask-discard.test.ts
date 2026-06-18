// covers: subcommand:aidlc-worktree:discard, subcommand:aidlc-worktree:info
//
// CLI-contract port of tests/e2e/t10-halt-and-ask-discard.sh (TAP plan 8),
// mechanism = cli. The .sh drives `aidlc-worktree.ts discard` to prove the
// user-cleanup half of the symmetric preservation invariant (t09 proves the
// preserve half): an explicit `discard --slug <s>` removes the worktree
// directory, deregisters the worktree from git, and emits a WORKTREE_DISCARDED
// audit-of-intent row carrying Reason: agent-discard and the Bolt slug; a
// second discard is idempotent (exits 0 silently per the PR-7 contract,
// aidlc-worktree.ts:470-480); and `info` still resolves the worktree path from
// the audit (audit-of-intent semantics — info reads the most-recent
// WORKTREE_CREATED audit block, not the live filesystem, aidlc-worktree.ts
// :685-722).
//
// MECHANISM: this is a .cli file, so every observable is taken at the PROCESS
// boundary — SPAWN the real binary via spawnSync (BUN + the tool .ts path) and
// assert on res.status, the audit.md the tool writes, the on-disk worktree
// directory, and `git worktree list --porcelain`. The directory removal, the
// git deregistration, the WORKTREE_DISCARDED audit row, the idempotent exit 0,
// and the info-from-audit read are real side-effects of running the actual
// binary against real git; an in-process twin would lose them. spawnCount = all
// worktree-mutating cases (create/discard/info), plus a `git worktree list`
// read for the deregistration assertion.
//
// FIXTURE: aidlc-worktree.ts asserts it runs from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts:101) and runs real git, so the
// case needs an ACTUAL git repo on `main` with one commit plus an aidlc-docs/
// dir. setupWorktreeFixture (tests/harness/fixtures.ts) builds exactly that;
// the tool is spawned with cwd = the fixture so `git rev-parse --show-toplevel`
// resolves to the main checkout. The .sh's `bolt fail` setup step is fixture
// noise (it adds a BOLT_FAILED row to simulate the t09 end-state) that has no
// bearing on what `discard` asserts — the real precondition `discard` needs is
// a worktree on disk, which `create` establishes. We build that end-state with
// the real `create` spawn, exactly the live precondition the discard contract
// is written against. cleanupWorktreeFixture prunes child worktrees then
// rm -rf's the parent. Nothing is written under tests/fixtures/**.
//
// PARITY NOTES — every .sh assertion has an equal-or-stronger counterpart:
//   .sh a1 (l33)  assert_dir_exists  worktree on disk before discard
//                   -> Test "1" precondition: existsSync(wtPath) === true
//   .sh a2 (l37)  assert_file_not_exists  worktree dir removed after discard
//                   -> Test "1": existsSync(wtPath) === false
//   .sh a3 (l38)  assert_worktree_absent  git no longer lists the worktree
//                   -> Test "1" (STRONGER: parse `git worktree list --porcelain`
//                      and assert the canonical path is absent, the same surface
//                      the .sh helper grepped)
//   .sh a4 (l39)  assert_grep  Event.*WORKTREE_DISCARDED
//                   -> Test "2": audit contains the **Event**: WORKTREE_DISCARDED
//                      line (STRONGER: pins the **Event**: prefix, not a bare
//                      substring)
//   .sh a5 (l40)  assert_grep  Reason.*agent-discard
//                   -> Test "2": audit contains **Reason**: agent-discard
//   .sh a6 (l41)  assert_grep  Bolt slug.*y$
//                   -> Test "2": audit contains **Bolt slug**: y (STRONGER:
//                      asserts all three discard fields co-located in the SAME
//                      WORKTREE_DISCARDED block, not merely present somewhere)
//   .sh a7 (l48)  assert_eq RC 0  second discard idempotent
//                   -> Test "3": status === 0 (STRONGER: also asserts the JSON
//                      reports emitted:null / reason "already-discarded", the
//                      no-re-emit contract at aidlc-worktree.ts:470-480, and that
//                      no SECOND WORKTREE_DISCARDED row was written)
//   .sh a8 (l55)  assert_contains INFO_OUT '"path":'  info resolves from audit
//                   -> Test "4": info stdout contains '"path":' (STRONGER:
//                      parses the JSON and asserts path === the original worktree
//                      path, proving the audit-of-intent read returns the real
//                      recorded path after the directory is gone)
//
// 8 .sh asserts -> 11 expect()s across 4 test() cases sharing one fixture (the
// .sh ran as one linear script over a single fixture; we keep that shared
// end-state and split the assertions into named cases). Several STRONGER via
// block-scoped field co-location + JSON-shape pinning.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  seededAuditDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const WT_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) cleanupWorktreeFixture(f);
});

interface CliResult {
  status: number;
  stdout: string;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn `bun aidlc-worktree.ts <sub> ... --project-dir <p>` from cwd=<p>. */
function wt(p: string, sub: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [WT_TOOL, sub, ...args, "--project-dir", p], {
    cwd: p,
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

const wtPath = (p: string, slug: string): string =>
  join(p, ".aidlc", "worktrees", `bolt-${slug}`);
/** Concatenate every audit shard (audit/*.md) for the seeded record. */
const auditText = (p: string): string => {
  const dir = seededAuditDir(p);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
};

/** Audit blocks are separated by lines of only `---`. The WORKTREE_DISCARDED
 *  block for slug `s` (the .sh's `Event.*WORKTREE_DISCARDED` + `Bolt slug.*s`
 *  on the same block). */
function discardBlock(p: string, slug: string): string | undefined {
  return auditText(p)
    .split(/\n---\n/)
    .find(
      (b) =>
        /^\*\*Event\*\*:\s*WORKTREE_DISCARDED/m.test(b) &&
        new RegExp(`^\\*\\*Bolt slug\\*\\*:\\s*${slug}\\s*$`, "m").test(b),
    );
}

/** Count WORKTREE_DISCARDED rows for slug `s` (idempotency: must stay 1). */
function discardCount(p: string, slug: string): number {
  return auditText(p)
    .split(/\n---\n/)
    .filter(
      (b) =>
        /^\*\*Event\*\*:\s*WORKTREE_DISCARDED/m.test(b) &&
        new RegExp(`^\\*\\*Bolt slug\\*\\*:\\s*${slug}\\s*$`, "m").test(b),
    ).length;
}

/** Parse `git worktree list --porcelain` for the registered worktree paths
 *  (the surface assert_worktree_absent grepped in worktree-helpers.sh:67-75). */
function listedWorktrees(p: string): string[] {
  const r = spawnSync("git", ["-C", p, "worktree", "list", "--porcelain"], {
    encoding: "utf-8",
  });
  return (r.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

describe("t10 aidlc-worktree discard halt-and-ask cleanup (migrated from t10-halt-and-ask-discard.sh, plan 8)", () => {
  // Single shared fixture, set up once (the .sh ran as one linear script over
  // one fixture). create establishes the precondition: a worktree on disk.
  const p = setupWorktreeFixture();
  fixtures.push(p);
  // Seed a state file into the default record so the active-intent cursor
  // resolves and the WORKTREE_CREATED/DISCARDED audit lands in the per-intent
  // record (the fixture's record is stateless; without aidlc-state.md the cursor
  // is rejected and the audit lands at the bare space root).
  writeFileSync(seededStateFile(p), "- **Current Stage**: code-generation\n", "utf-8");
  const created = wt(p, "create", ["--slug", "y", "--base", "main"]);

  test(
    "1: discard removes the worktree dir AND deregisters it from git [.sh a1+a2+a3]",
    () => {
      // a1: precondition — create succeeded and the worktree is on disk.
      expect(created.status).toBe(0);
      expect(existsSync(wtPath(p, "y"))).toBe(true);

      const d = wt(p, "discard", ["--slug", "y"]);
      expect(d.status).toBe(0);

      // a2: the worktree directory is gone.
      expect(existsSync(wtPath(p, "y"))).toBe(false);
      // a3: git no longer registers the worktree (the assert_worktree_absent
      // surface: `git worktree list --porcelain` excludes the path). Compare
      // against the canonical leaf basename so symlink-canonicalisation
      // (macOS /var -> /private/var) does not produce a false miss.
      const stillListed = listedWorktrees(p).some((wpath) =>
        wpath.endsWith(`${join("worktrees", "bolt-y")}`),
      );
      expect(stillListed).toBe(false);
    },
    30000,
  );

  test(
    "2: discard emits WORKTREE_DISCARDED with Reason agent-discard + Bolt slug (co-located) [.sh a4+a5+a6]",
    () => {
      // After test 1 ran, the WORKTREE_DISCARDED row is on disk. Assert all
      // three fields land in the SAME audit block (stronger than the .sh's
      // three independent greps).
      const block = discardBlock(p, "y");
      expect(block).toBeDefined();
      // a4: Event line.
      expect(block).toMatch(/^\*\*Event\*\*:\s*WORKTREE_DISCARDED/m);
      // a5: Reason field.
      expect(block).toMatch(/^\*\*Reason\*\*:\s*agent-discard\s*$/m);
      // a6: Bolt slug field (exactly `y`).
      expect(block).toMatch(/^\*\*Bolt slug\*\*:\s*y\s*$/m);
    },
    30000,
  );

  test(
    "3: second discard is idempotent — exits 0, re-emits nothing [.sh a7]",
    () => {
      const before = discardCount(p, "y");
      expect(before).toBe(1); // exactly one WORKTREE_DISCARDED from test 1

      const second = wt(p, "discard", ["--slug", "y"]);
      // a7: exit 0 (idempotent per the PR-7 contract).
      expect(second.status).toBe(0);
      // STRONGER than the .sh: the no-re-emit JSON contract (emitted:null,
      // reason "already-discarded", aidlc-worktree.ts:470-480) ...
      const json = JSON.parse(second.stdout.trim());
      expect(json.emitted).toBeNull();
      expect(json.reason).toBe("already-discarded");
      // ... and no SECOND audit row was written.
      expect(discardCount(p, "y")).toBe(1);
    },
    30000,
  );

  test(
    "4: info still resolves the worktree path from audit after discard [.sh a8]",
    () => {
      const info = wt(p, "info", ["--slug", "y"]);
      expect(info.status).toBe(0);
      // a8: stdout carries the `"path":` field (the .sh's assert_contains).
      expect(info.out).toContain('"path":');
      // STRONGER: the resolved path is the original worktree path — info reads
      // the most-recent WORKTREE_CREATED audit block (audit-of-intent), not the
      // now-deleted directory.
      const json = JSON.parse(info.stdout.trim());
      expect(json.path).toBe(wtPath(p, "y"));
    },
    30000,
  );
});
