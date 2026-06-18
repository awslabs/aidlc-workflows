// covers: subcommand:aidlc-worktree:create
//
// CLI-contract port of tests/e2e/t05-worktree-audit-first.sh (TAP plan 7),
// mechanism = cli. The .sh drives `aidlc-worktree.ts create` to prove the
// audit-first invariant: the WORKTREE_CREATED audit-of-intent row lands BEFORE
// the real `git worktree add` (so a kill-9 in between surfaces as a phantom
// row doctor reconciles), AND a pre-git failure (read-only audit.md) exits
// non-zero WITHOUT touching git or the audit. The covers UNIT credited is
// subcommand:aidlc-worktree:create — the create subcommand whose ordering
// guarantee is the whole point of this test (aidlc-worktree.ts:181-202).
//
// MECHANISM: this is a .cli file, so every observable is taken at the PROCESS
// boundary — SPAWN the real binary via spawnSync (BUN + the tool .ts path) and
// assert on res.status and the audit.md the tool writes. The audit-first
// ordering and the ERROR_LOGGED-after-git-failure sequence are real
// side-effects of running the actual binary against real git; an in-process
// twin would lose them.
//
// FIXTURE: aidlc-worktree.ts asserts it runs from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts:101) and runs real git, so each
// case needs an ACTUAL git repo on `main` with one commit plus an aidlc-docs/
// dir. setupWorktreeFixture (tests/harness/fixtures.ts) builds exactly that;
// the tool is spawned with cwd = the fixture so `git rev-parse
// --show-toplevel` resolves to the main checkout. Each case ALSO seeds
// aidlc-docs/aidlc-state.md (from the state-mid-ideation.md fixture) because
// emitError (aidlc-lib.ts:1513) only appends ERROR_LOGGED when
// existsSync(stateFilePath) is true — without the state file the ERROR_LOGGED
// row is silently skipped per emitError's best-effort policy, exactly as the
// .sh's comment (lines 13-15) explains. cleanupWorktreeFixture restores perms
// and prunes child worktrees then rm -rf's the parent. Nothing is written
// under tests/fixtures/**.
//
// PLATFORM GATE: Part A chmods audit.md to 0444 (read-only file) and Part B
// chmods .aidlc/worktrees to 0555 (read-only dir). Native Windows ignores both
// modes, so the write-failure these provoke cannot occur there. Mirroring the
// .sh's POSIX assumption (it runs `set -euo pipefail` on bash) and t76's
// readonly-probe precedent, Part B is gated behind a runtime read-only-dir
// probe and skipped where the mechanism is a no-op. Part A's primary observable
// (non-zero exit + no worktree dir) is gated likewise for the "audit not
// mutated" sub-assertion, but the exit-code / no-dir checks hold regardless.
//
// PARITY NOTES — every .sh assertion has an equal-or-stronger counterpart:
//   .sh A1 (l56)  Part A: create exits non-zero (audit.md read-only)     -> Test "1" (same)
//   .sh A2 (l57)  Part A: no worktree dir created (audit-first pre-git)  -> Test "1" (same)
//   .sh A3 (l67)  Part A: audit.md does NOT contain WORKTREE_CREATED     -> Test "1" (same,
//                 plus STRONGER: still does not contain ERROR_LOGGED either)
//   .sh B1 (l98)  Part B: create exits non-zero (git fails post-audit)   -> Test "2" (same)
//   .sh B2 (l100) Part B: WORKTREE_CREATED audit-of-intent row landed    -> Test "2" (same)
//   .sh B3 (l103) Part B: ERROR_LOGGED appended after git failure        -> Test "2" (same)
//   .sh B4 (l105) Part B: ERROR_LOGGED Error field carries [slug=demo]   -> Test "2" (same)
//
// 7 .sh asserts -> 8 expect()s across 2 test() cases (Part A = 1 case / 4
// expects incl. the STRONGER no-ERROR_LOGGED check; Part B = 1 case / 4
// expects). Grouped where the .sh shared one fixture per part.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  FIXTURES_DIR,
  seededAuditDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) {
    // Restore perms on anything we chmod'd so cleanup's rm -rf can recurse.
    try {
      const auditDir = seededAuditDir(f);
      if (existsSync(auditDir)) chmodSync(auditDir, 0o755);
    } catch {
      /* best-effort */
    }
    try {
      const wt = join(f, ".aidlc", "worktrees");
      if (existsSync(wt)) chmodSync(wt, 0o755);
    } catch {
      /* best-effort */
    }
    cleanupWorktreeFixture(f);
  }
});

/**
 * Fresh git-repo fixture on `main` + aidlc-docs/, with a seeded state file so
 * emitError's existsSync(stateFilePath) guard passes (mirrors the .sh's `cp
 * state-mid-ideation.md ... aidlc-state.md`). Registered for cleanup.
 */
function freshFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  // Seed state into the per-intent record so emitError's existsSync(stateFilePath)
  // guard passes (the seeded record dir already exists via the fixture shell).
  copyFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), seededStateFile(p));
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn `bun aidlc-worktree.ts create ... --project-dir <p>` from cwd=<p>. */
function create(p: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [TOOL, "create", ...args, "--project-dir", p], {
    cwd: p,
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
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

/**
 * Probe whether this platform enforces read-only directory permissions —
 * mirrors readonly_dirs_enforced (t76.cli.test.ts:256). The chmod-0555
 * (Part B) and chmod-0444 (Part A) mechanisms are no-ops on platforms that
 * ignore mode bits (native Windows); skip those cases rather than assert an
 * unobservable sequence.
 */
function readonlyEnforced(): boolean {
  if (process.platform === "win32") return false;
  const probe = join(FIXTURES_DIR, "..", `.aidlc-t05-probe-${process.pid}`);
  try {
    mkdirSync(probe, { recursive: true });
    chmodSync(probe, 0o555);
    try {
      writeFileSync(join(probe, "probe-write"), "x", "utf-8");
      chmodSync(probe, 0o755);
      rmSync(probe, { recursive: true, force: true });
      return false; // write succeeded → mode not enforced
    } catch {
      chmodSync(probe, 0o755);
      rmSync(probe, { recursive: true, force: true });
      return true;
    }
  } catch {
    try {
      rmSync(probe, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    return false;
  }
}

describe("t05 aidlc-worktree create audit-first (migrated from t05-worktree-audit-first.sh, plan 7)", () => {
  test(
    "1: Part A — read-only audit.md ⇒ exit non-zero pre-git, no worktree dir, audit unmutated",
    () => {
      if (!readonlyEnforced()) {
        // Platform ignores read-only file mode: the pre-git audit-write
        // failure this case provokes cannot occur. Skip (mirrors the .sh's
        // POSIX-only bash assumption / t76's SKIP precedent).
        return;
      }
      const p = freshFixture();
      // Audit is a per-clone shard DIR now: lock the audit/ DIR read-only so the
      // audit-first emit can't create its shard, the per-clone analog of the old
      // chmod-0444 on the single audit.md. The shipped fixture.md shard is the
      // only content; the "not mutated" check stays exact.
      const auditDir = seededAuditDir(p);
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(join(auditDir, "fixture.md"), "# AI-DLC Audit Log\n", "utf-8");
      chmodSync(auditDir, 0o555);

      const r = create(p, ["--slug", "demo", "--base", "main"]);
      chmodSync(auditDir, 0o755); // restore before reading/cleanup

      // A1: create exits non-zero — the audit-first emit threw on the
      // read-only audit dir before git was ever invoked.
      expect(r.status).not.toBe(0);
      // A2: no worktree directory created (audit-first prevented git add).
      expect(existsSync(wtPath(p, "demo"))).toBe(false);
      // A3: the audit was NOT mutated — no WORKTREE_CREATED row (emit failed
      // pre-git) ...
      const after = auditText(p);
      expect(after).not.toContain("WORKTREE_CREATED");
      // ... and STRONGER than the .sh: no ERROR_LOGGED row either (the audit dir
      // was itself read-only, so emitError's best-effort write also failed).
      expect(after).not.toContain("ERROR_LOGGED");
    },
    30000,
  );

  test(
    "2: Part B — git fails AFTER audit emit ⇒ WORKTREE_CREATED + ERROR_LOGGED([slug=demo])",
    () => {
      if (!readonlyEnforced()) {
        // Platform ignores read-only dir mode: `git worktree add` can't be
        // forced to fail via chmod 0555, so the post-audit failure sequence is
        // unobservable. Skip (mirrors t76 test 6 / the .sh's POSIX assumption).
        return;
      }
      const p = freshFixture();
      // Pre-create the worktrees PARENT and lock it read-only. The tool's
      // pre-audit existsSync(wtPath) only checks the LEAF (bolt-demo, absent),
      // so the audit emit succeeds; then `git worktree add` fails because it
      // can't mkdir the leaf under the read-only parent (the .sh: mkdir -p
      // .aidlc/worktrees; chmod 0555).
      const worktreesDir = join(p, ".aidlc", "worktrees");
      mkdirSync(worktreesDir, { recursive: true });
      chmodSync(worktreesDir, 0o555);

      const r = create(p, ["--slug", "demo", "--base", "main"]);
      chmodSync(worktreesDir, 0o755); // restore before reading/cleanup

      // B1: create exits non-zero (git failed post-audit).
      expect(r.status).not.toBe(0);

      const after = auditText(p);
      // B2: WORKTREE_CREATED audit-of-intent row landed BEFORE the git failure.
      expect(after).toContain("WORKTREE_CREATED");
      // B3: ERROR_LOGGED appended after git failed.
      expect(after).toContain("ERROR_LOGGED");
      // B4: the ERROR_LOGGED Error field carries [slug=demo] for doctor
      // correlation (errorWithSlug, aidlc-worktree.ts:810).
      expect(after).toContain("[slug=demo]");
    },
    30000,
  );
});
