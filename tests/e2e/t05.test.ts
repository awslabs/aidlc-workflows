// covers: subcommand:aidlc-worktree:create
//
// The test drives `aidlc-worktree.ts create` to prove the
// audit-first invariant: the WORKTREE_CREATED audit-of-intent row lands BEFORE
// the real `git worktree add` (so a kill-9 in between surfaces as a phantom
// row doctor reconciles), AND a pre-git failure (read-only audit directory) exits
// non-zero WITHOUT touching git or the audit. The covers UNIT credited is
// subcommand:aidlc-worktree:create — the create subcommand whose ordering
// guarantee is the whole point of this test (aidlc-worktree.ts).
//
// MECHANISM: every observable is taken at the PROCESS
// boundary — SPAWN the real binary via spawnSync (BUN + the tool .ts path) and
// assert on res.status and the audit the tool writes. The audit-first
// ordering and the ERROR_LOGGED-after-git-failure sequence are real
// side-effects of running the actual binary against real git; an in-process
// twin would lose them.
//
// FIXTURE: aidlc-worktree.ts asserts it runs from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts) and runs real git, so each
// case needs an ACTUAL git repo on `main` with one commit plus an aidlc-docs/
// dir. setupWorktreeFixture (tests/harness/fixtures.ts) builds exactly that;
// the tool is spawned with cwd = the fixture so `git rev-parse
// --show-toplevel` resolves to the main checkout. Each case ALSO seeds
// aidlc-docs/aidlc-state.md (from the state-mid-ideation.md fixture) because
// emitError (aidlc-lib.ts) only appends ERROR_LOGGED when
// existsSync(stateFilePath) is true — without the state file the ERROR_LOGGED
// row is silently skipped per emitError's best-effort policy, exactly as the
// .sh's comment (lines 13-15) explains. cleanupWorktreeFixture restores perms
// and prunes child worktrees then rm -rf's the parent. Nothing is written
// under tests/fixtures/**.
//
// PLATFORM GATE: Part A chmods the audit shard directory to 0555 and Part B
// chmods the worktrees parent to 0555. Native Windows ignores these
// mode bits, so the write failures cannot be provoked there. Both parts are
// gated behind a runtime read-only-directory probe and skipped where the
// mechanism is a no-op.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
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
import { worktreePath } from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  FIXTURES_DIR,
  fixtureIntentId8,
  seededAuditDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
 * Fresh git-repo fixture on `main` + a per-intent workspace shell, with a
 * seeded state file so emitError's state-file guard passes. Registered for
 * cleanup.
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

function create(p: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [TOOL, "create", ...args, "--project-dir", p], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
    cwd: p,
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

const wtPath = (p: string, slug: string): string =>
  worktreePath(p, fixtureIntentId8(p), slug);

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
 * mirrors readonlyDirsEnforced (tests/unit/t76.test.ts). The chmod-0555
 * mechanisms in both parts are no-ops on platforms that
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
        // Platform ignores read-only directory mode: the pre-git audit-write
        // failure this case provokes cannot occur. Skip.
        return;
      }
      const p = freshFixture();
      // Audit is a per-clone shard DIR: lock the audit/ DIR read-only so the
      // audit-first emit can't create its shard. The shipped fixture.md shard is the
      // only content; the "not mutated" check stays exact.
      const auditDir = seededAuditDir(p);
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(join(auditDir, "fixture.md"), "# AI-DLC Audit Log\n", "utf-8");
      chmodSync(auditDir, 0o555);

      const r = create(p, ["--slug", "demo", "--base", "main"]);
      chmodSync(auditDir, 0o755); // restore before reading/cleanup

      // Create exits non-zero - the audit-first emit threw on the
      // read-only audit dir before git was ever invoked.
      expect(r.status).not.toBe(0);
      // No worktree directory created (audit-first prevented git add).
      expect(existsSync(wtPath(p, "demo"))).toBe(false);
      // The audit was NOT mutated - no WORKTREE_CREATED row (emit failed
      // pre-git).
      const after = auditText(p);
      expect(after).not.toContain("WORKTREE_CREATED");
      // No ERROR_LOGGED row either (the audit dir
      // was itself read-only, so emitError's best-effort write also failed).
      expect(after).not.toContain("ERROR_LOGGED");
    },
    NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  );

  test(
    "2: Part B — git fails AFTER audit emit ⇒ WORKTREE_CREATED + ERROR_LOGGED([slug=demo])",
    () => {
      if (!readonlyEnforced()) {
        // Platform ignores read-only dir mode: `git worktree add` can't be
        // forced to fail via chmod 0555, so the post-audit failure sequence is
        // unobservable. Skip.
        return;
      }
      const p = freshFixture();
      // Pre-create the worktrees PARENT and lock it read-only. The tool's
      // pre-audit existsSync(wtPath) only checks the absent Bolt leaf,
      // so the audit emit succeeds; then `git worktree add` fails because it
      // can't mkdir the leaf under the read-only parent.
      const worktreesDir = join(p, ".aidlc", "worktrees");
      mkdirSync(worktreesDir, { recursive: true });
      chmodSync(worktreesDir, 0o555);

      const r = create(p, ["--slug", "demo", "--base", "main"]);
      chmodSync(worktreesDir, 0o755); // restore before reading/cleanup

      // Create exits non-zero (git failed post-audit).
      expect(r.status).not.toBe(0);

      const after = auditText(p);
      // WORKTREE_CREATED audit-of-intent row landed BEFORE the git failure.
      expect(after).toContain("WORKTREE_CREATED");
      // ERROR_LOGGED appended after git failed.
      expect(after).toContain("ERROR_LOGGED");
      // The ERROR_LOGGED Error field carries [slug=demo] for doctor
      // correlation (errorWithSlug, aidlc-worktree.ts).
      expect(after).toContain("[slug=demo]");
    },
    NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  );
});
