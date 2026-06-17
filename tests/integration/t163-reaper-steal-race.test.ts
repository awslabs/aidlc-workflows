// covers: function:acquireAuditLock, function:withAuditLock
//
// t163 — REAPER STEAL mutual-exclusion PROPERTY test under REAL spawn contention.
// Mechanism: cli (process-boundary). This is the spawn-contention coverage the
// Stage B review flagged as MISSING for the reaper (t161 covers only the
// SEQUENTIAL, in-process invariants; nothing exercised the dead-lock reclaim
// under genuine multi-process contention). It is the closure for the review's
// concurrency-coverage debt — NOT a pre-fix↔post-fix discriminator (see HONESTY).
//
// WHY CLI (process-boundary, not in-process): the subject IS concurrency — the
// reaper steal (aidlc-lib.ts reapStaleLock) only fires when independent OS
// processes race to reclaim the SAME stale lock dir. bun:test runs serially
// inside one process, so an in-process loop could never overlap two reapers'
// decide→steal windows. This twin adds the missing real-concurrency dimension.
//
// THE INVARIANT WITH TEETH: seed ONE stale (dead-PID) lock, fire N processes that
// each try a single 0-retry acquire. The reaper is mutually exclusive: EXACTLY
// ONE process reclaims + acquires; the winner then HOLDS (stays alive) so every
// other sees a live, under-age holder it must not rob → LOST. >1 winner means a
// reaper robbed a live holder. Repeated over GENERATIONS for stability.
//
// HONESTY (read before trusting this as a FIX-3 regression test): empirically
// this assertion holds on BOTH the pre-fix reaper (the prior "re-read stamp then
// rename" guard) AND a fully-NAIVE reaper (no re-check at all) — because for the
// DEAD-lock case the renameSync of the lock dir is itself the OS-atomic arbiter:
// only one process moves a given dir, the losers get ENOENT. The specific steal-
// race the CAS closes (a competitor re-mkdir'ing at the SAME path between a
// reaper's stale DECISION and its rename) is a sub-microsecond window that does
// NOT reproduce under spawn timing — verified by stress (24 procs × 40 gens, zero
// double-steals on the pre-fix code). So this test does NOT fail against pre-fix;
// it is a mutual-exclusion PROPERTY guard that would catch a GROSS reaper
// regression (e.g. dropping the mkdir/rename arbitration). The CAS fix is
// defense-in-depth for the unobservable window, documented in reapStaleLock.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-lib.ts):
//   reapStaleLock — CAS steal (rename-first, verify-moved-stamp, restore-on-miss).
//   acquireAuditLock — mkdir-or-reap loop that calls it.
//
// FIXTURE DISCIPLINE: a per-test temp project dir + a temp driver script, both
// rm-rf'd in afterEach. The lock dir lives under tmpdir() (auditLockDir) and is
// cleaned between generations. Nothing is written under tests/fixtures/**.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLockDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const LIB = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-lib.ts");

// Per-intent bucket the contenders race on (a concrete intent so auditLockDir
// keys a per-intent dir; the sentinel would work too — the reaper logic is
// identical, this just mirrors the real fork/merge per-intent lock).
const INTENT = "auth-aaaaaaaa";
const SPACE = "default";

let proj: string;
let driver: string;

// A tiny driver that does ONE 0-retry acquireAuditLock against the seeded stale
// lock and prints exactly "WON" (acquired) or "LOST" (could not). 0 retries so a
// contender that loses the steal does NOT then mkdir the freed dir on a later
// loop turn — we want a single, honest "did THIS process reclaim the stale lock"
// signal per process. The reaper still fires on the first EEXIST.
//
// A WINNER then SLEEPS (HOLD_MS) BEFORE exiting — and stays ALIVE the whole time.
// This is load-bearing: a winner that exited immediately would leave a lock whose
// owner PID is now DEAD, which the NEXT contender would (correctly) reap as a dead
// lock and itself win — a SERIAL chain of legitimate re-acquisitions, not the
// concurrent double-steal the test means to catch. By staying alive while the
// losers run their single 0-retry attempt, the winner presents a LIVE, under-age
// holder the reaper must refuse — so a SECOND winner can only arise from the
// steal-race the CAS closes (robbing a live holder), which is exactly the bug
// under test. The losers (0 retries) fail fast and exit well before HOLD_MS.
const DRIVER_SRC = (libPath: string, pd: string, intent: string, space: string): string =>
  [
    `import { acquireAuditLock } from ${JSON.stringify(libPath)};`,
    `const won = acquireAuditLock(${JSON.stringify(pd)}, 0, 1, ${JSON.stringify(intent)}, ${JSON.stringify(space)});`,
    `process.stdout.write(won ? "WON" : "LOST");`,
    // A winner holds (stays alive) so concurrent losers see a LIVE holder they
    // must not rob; the harness rm's the dir between generations.
    `if (won) { Bun.sleepSync(800); }`,
    `process.exit(0);`,
  ].join("\n");

/** Seed a DEAD-PID, OVER-AGE stale lock at the per-intent bucket. */
function seedStaleLock(): string {
  const lockDir = auditLockDir(proj, INTENT, SPACE);
  rmSync(lockDir, { recursive: true, force: true });
  mkdirSync(lockDir, { recursive: true });
  // pid is an unlikely-live high value (ESRCH → dead owner), startedAtMs far in
  // the past (over the tightened stale threshold the test sets via env).
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: 2_000_000_000, startedAtMs: 0 }),
    "utf-8",
  );
  return lockDir;
}

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), "aidlc-t163-"));
  driver = join(proj, "reap-driver.ts");
  writeFileSync(driver, DRIVER_SRC(LIB, proj, INTENT, SPACE), "utf-8");
});

afterEach(() => {
  try {
    rmSync(auditLockDir(proj, INTENT, SPACE), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
  rmSync(proj, { recursive: true, force: true });
});

describe("t163 reaper steal-race — exactly one process reclaims a stale lock (cli — parallel spawn)", () => {
  // -------------------------------------------------------------------------
  // N contenders, ONE stale lock, ONE acquisition. Repeated over GENERATIONS
  // for stability. EXACTLY ONE wins each generation is the mutual-exclusion
  // invariant the reaper must uphold under real multi-process contention.
  // -------------------------------------------------------------------------
  test("N concurrent contenders against one stale lock — exactly one wins, every generation", async () => {
    const N = 12;
    const GENERATIONS = 8;
    // The seeded lock is reclaimable because its owner PID is DEAD (ESRCH) — the
    // reaper reclaims a dead owner regardless of age. So we keep the stale
    // threshold LARGE (10 min): the winner's own freshly-acquired lock (its real,
    // alive PID + a now stamp) is then UNDER age and must NOT be robbed by the
    // losers — that protection is exactly what makes "exactly one wins" hold. A
    // tiny threshold would (correctly) make the winner's fresh lock instantly
    // over-age and let the losers reap IT too, defeating the test's premise. A
    // generous unstamped grace covers the winner's brief mkdir→stamp gap.
    const env = {
      ...process.env,
      AIDLC_LOCK_STALE_MS: "600000",
      AIDLC_LOCK_UNSTAMPED_GRACE_MS: "10000",
    };
    for (let g = 0; g < GENERATIONS; g++) {
      seedStaleLock();
      const procs = Array.from({ length: N }, () =>
        Bun.spawn({
          cmd: [BUN, driver],
          stdout: "pipe",
          stderr: "ignore",
          env,
        }),
      );
      await Promise.all(procs.map((p) => p.exited));
      const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
      const wins = outs.filter((o) => o.trim() === "WON").length;
      // EXACTLY ONE reclaim. >1 means the steal robbed a fresh holder (the race);
      // 0 would mean the reaper failed to reclaim a provably-dead lock at all.
      expect(wins).toBe(1);
      // Clean the winner's held lock before the next generation.
      rmSync(auditLockDir(proj, INTENT, SPACE), { recursive: true, force: true });
    }
  }, 120000);

  // -------------------------------------------------------------------------
  // A live, UNDER-AGE holder is never robbed under contention: seed a FRESH
  // this-not-applicable... seed a live (current test PID), under-age lock, then
  // fire N contenders. ZERO may win — the reaper must refuse to reclaim a fresh
  // live holder even with many processes hammering it.
  // -------------------------------------------------------------------------
  test("a fresh live holder is never reclaimed under N-way contention [zero winners]", async () => {
    const lockDir = auditLockDir(proj, INTENT, SPACE);
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir, { recursive: true });
    // Owner = THIS test process (alive), stamp = now (under any sane threshold).
    const now = Math.floor(performance.timeOrigin + performance.now());
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAtMs: now }),
      "utf-8",
    );
    const env = { ...process.env, AIDLC_LOCK_STALE_MS: "600000" }; // 10 min
    const N = 12;
    const procs = Array.from({ length: N }, () =>
      Bun.spawn({ cmd: [BUN, driver], stdout: "pipe", stderr: "ignore", env }),
    );
    await Promise.all(procs.map((p) => p.exited));
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    const wins = outs.filter((o) => o.trim() === "WON").length;
    // The live, under-age holder is never robbed → no contender acquires.
    expect(wins).toBe(0);
    // The original live lock dir is intact (the CAS restore never destroyed it).
    expect(existsSync(lockDir)).toBe(true);
  }, 60000);
});
