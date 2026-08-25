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
// ONE process reclaims + acquires, reporting the seeded owner's PID; the winner
// then HOLDS (stays alive). Spawn-to-acquire latency is unbounded, so a contender
// may legitimately arrive after that winner exits and report a dead real-PID
// predecessor. Those serial-chain wins are allowed. A winner that reports its
// predecessor was STILL ALIVE after the steal robbed a live holder and fails the
// invariant. Repeated over GENERATIONS for stability.
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
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLockDir } from "../../core/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const LIB = join(REPO_ROOT, "core", "tools", "aidlc-lib.ts");

// Per-intent bucket the contenders race on (a concrete intent so auditLockDir
// keys a per-intent dir; the sentinel would work too — the reaper logic is
// identical, this just mirrors the real fork/merge per-intent lock).
const INTENT = "auth-aaaaaaaa";
const SPACE = "default";
const STALE_OWNER_PID = 2_000_000_000;
const HOLD_MS = 5000;

let proj: string;
let driver: string;

// A tiny driver that does ONE 0-retry acquireAuditLock against the seeded stale
// lock and prints exactly "WON <reaped-pid> <aliveAfterSteal>" (acquired) or
// "LOST" (could not). 0 retries means a contender that loses the steal does NOT
// then mkdir the freed dir on a later loop turn. The reaper still fires on the
// first EEXIST.
//
// Each contender reads owner.json immediately before acquiring. That read has a
// benign race: a process can observe the seeded PID, lose, then resume after a
// winner exits and legitimately reap that winner's real-PID lock. A winner-only
// predecessor ledger resolves that stale observation: the first winner reports
// the seeded sentinel and records its PID; each later winner reports the prior
// winner's real PID. After acquire, the winner resolves that predecessor before
// probing it with process.kill(pid, 0); probing the raw observation would revive
// the benign read/acquire race. Dead predecessors prove legitimate serial
// re-acquisition; an alive predecessor proves the winner robbed a live holder.
//
// A WINNER then SLEEPS (HOLD_MS) BEFORE exiting. The hold widens the observation
// window so an overlapping winner probes a predecessor that is still alive. It
// does NOT assume every spawned contender reaches acquire within HOLD_MS: a late
// contender may correctly reap a dead winner and report aliveAfterSteal=false.
const DRIVER_SRC = (
  libPath: string,
  pd: string,
  intent: string,
  space: string,
  evidenceState: string,
  evidenceLock: string,
): string =>
  [
    `import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `import { acquireAuditLock, auditLockDir } from ${JSON.stringify(libPath)};`,
    `const lockDir = auditLockDir(${JSON.stringify(pd)}, ${JSON.stringify(intent)}, ${JSON.stringify(space)});`,
    `let observedPid: number | null = null;`,
    `try { observedPid = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8")).pid; } catch {}`,
    `const won = acquireAuditLock(${JSON.stringify(pd)}, 0, 1, ${JSON.stringify(intent)}, ${JSON.stringify(space)});`,
    `if (!won) { process.stdout.write("LOST"); process.exit(0); }`,
    `for (;;) {`,
    `  try { mkdirSync(${JSON.stringify(evidenceLock)}); break; }`,
    `  catch { Bun.sleepSync(1); }`,
    `}`,
    `let reapedPid: number;`,
    `try {`,
    `  const predecessorPid = JSON.parse(readFileSync(${JSON.stringify(evidenceState)}, "utf-8")).pid;`,
    `  const observationMatches = observedPid === predecessorPid;`,
    `  reapedPid = observationMatches && observedPid !== null ? observedPid : predecessorPid;`,
    `  writeFileSync(${JSON.stringify(evidenceState)}, JSON.stringify({ pid: process.pid }), "utf-8");`,
    `} finally {`,
    `  rmSync(${JSON.stringify(evidenceLock)}, { recursive: true, force: true });`,
    `}`,
    `let aliveAfterSteal = false;`,
    `try { process.kill(reapedPid, 0); aliveAfterSteal = true; } catch {}`,
    `process.stdout.write(\`WON \${reapedPid} \${aliveAfterSteal}\`);`,
    // A winner holds (stays alive) so concurrent losers see a LIVE holder they
    // must not rob; the harness rm's the dir between generations.
    `Bun.sleepSync(${HOLD_MS});`,
    `process.exit(0);`,
  ].join("\n");

function evidenceStatePath(): string {
  return join(proj, "reap-evidence.json");
}

function evidenceLockPath(): string {
  return join(proj, "reap-evidence.lock");
}

/** Seed a DEAD-PID, OVER-AGE stale lock at the per-intent bucket. */
function seedStaleLock(): string {
  const lockDir = auditLockDir(proj, INTENT, SPACE);
  rmSync(lockDir, { recursive: true, force: true });
  mkdirSync(lockDir, { recursive: true });
  rmSync(evidenceLockPath(), { recursive: true, force: true });
  writeFileSync(evidenceStatePath(), JSON.stringify({ pid: STALE_OWNER_PID }), "utf-8");
  // pid is an unlikely-live high value (ESRCH → dead owner), startedAtMs far in
  // the past (over the tightened stale threshold the test sets via env).
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: STALE_OWNER_PID, startedAtMs: 0 }),
    "utf-8",
  );
  return lockDir;
}

interface WinnerEvidence {
  reapedPid: number;
  aliveAfterSteal: boolean;
}

function winnerEvidence(outputs: string[]): WinnerEvidence[] {
  const winners: WinnerEvidence[] = [];
  for (const output of outputs) {
    const match = /^WON (\d+) (true|false)$/.exec(output.trim());
    if (match) {
      winners.push({
        reapedPid: Number(match[1]),
        aliveAfterSteal: match[2] === "true",
      });
    }
  }
  return winners;
}

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), "aidlc-t163-"));
  driver = join(proj, "reap-driver.ts");
  writeFileSync(
    driver,
    DRIVER_SRC(LIB, proj, INTENT, SPACE, evidenceStatePath(), evidenceLockPath()),
    "utf-8",
  );
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
    // Five 5-second holds keep the load-bearing winner lifetime comfortably
    // inside the 120-second timeout while retaining repeated contention coverage.
    const GENERATIONS = 5;
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
          stderr: "pipe",
          env,
        }),
      );
      const statuses = await Promise.all(procs.map((p) => p.exited));
      const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
      const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
      for (let i = 0; i < procs.length; i++) {
        expect(
          statuses[i],
          `contender ${i} exited nonzero\nstdout: ${outs[i]}\nstderr: ${errs[i]}`,
        ).toBe(0);
        expect(
          outs[i].trim(),
          `contender ${i} returned malformed evidence\nstderr: ${errs[i]}`,
        ).toMatch(/^(?:LOST|WON \d+ (?:true|false))$/);
      }
      const winners = winnerEvidence(outs);
      const seededWinners = winners.filter(({ reapedPid }) => reapedPid === STALE_OWNER_PID);
      const liveHolderRobberies = winners.filter(({ aliveAfterSteal }) => aliveAfterSteal);
      // Exactly one winner belongs to the seeded lock. Additional dead real-PID
      // predecessors are legitimate serial chains; a live predecessor is theft.
      expect(seededWinners).toHaveLength(1);
      expect(liveHolderRobberies).toHaveLength(0);
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
    // A broken reaper that steals this live holder must still be able to report
    // its predecessor. Without this seed the child throws before printing WON,
    // and a zero-winner assertion can pass on the crash.
    rmSync(evidenceLockPath(), { recursive: true, force: true });
    writeFileSync(evidenceStatePath(), JSON.stringify({ pid: process.pid }), "utf-8");
    const env = { ...process.env, AIDLC_LOCK_STALE_MS: "600000" }; // 10 min
    const N = 12;
    const procs = Array.from({ length: N }, () =>
      Bun.spawn({ cmd: [BUN, driver], stdout: "pipe", stderr: "pipe", env }),
    );
    const statuses = await Promise.all(procs.map((p) => p.exited));
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    for (let i = 0; i < procs.length; i++) {
      expect(
        statuses[i],
        `contender ${i} exited nonzero\nstdout: ${outs[i]}\nstderr: ${errs[i]}`,
      ).toBe(0);
      expect(
        outs[i].trim(),
        `contender ${i} returned malformed evidence\nstderr: ${errs[i]}`,
      ).toMatch(/^(?:LOST|WON \d+ (?:true|false))$/);
    }
    const wins = winnerEvidence(outs).length;
    // The live, under-age holder is never robbed → no contender acquires.
    expect(wins).toBe(0);
    // The original live lock, not merely a replacement directory, is intact.
    expect(existsSync(lockDir)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8")).pid,
    ).toBe(process.pid);
  }, 60000);

  test("real active-directive contenders serialize every successful Stop-count commit", async () => {
    const recordName = "auth-deadbeef";
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const recordDir = join(intents, recordName);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(proj, "aidlc", "active-space"), "default\n");
    writeFileSync(join(intents, "active-intent"), `${recordName}\n`);
    writeFileSync(join(intents, "intents.json"), `${JSON.stringify([{
      uuid: "deadbeef-0000-7000-8000-000000000001",
      slug: "auth",
      dirName: recordName,
      status: "in-flight",
    }])}\n`);
    const state = "- **Current Stage**: requirements-analysis\n";
    const stateSha256 = createHash("sha256").update(state).digest("hex");
    writeFileSync(join(recordDir, "aidlc-state.md"), state);
    writeFileSync(join(recordDir, ".aidlc-active-directive.json"), `${JSON.stringify({
      version: 2,
      revision: 1,
      project_sha256: createHash("sha256").update(realpathSync(proj)).digest("hex"),
      intent_uuid: "deadbeef-0000-7000-8000-000000000001",
      state_present: true,
      state_sha256: stateSha256,
      owner_session: "stop-owner",
      owner_epoch: 1,
      context_epoch: 0,
      kind: "run-stage",
      stage: "requirements-analysis",
      delivery: "delivered",
      needs_rehydrate: false,
      active_attempt: {
        id: "seed",
        command_kind: "next",
        command_sha256: stateSha256,
        issued_state_sha256: stateSha256,
        session_id: "stop-owner",
        owner_epoch: 1,
        context_epoch: 0,
        status: "settled",
      },
      event_sequence: 1,
      human_sequence: 0,
      engine_sequence: 1,
      conversation_sequence: 0,
      stop_count: 0,
    }, null, 2)}\n`);
    const countDriver = join(proj, "count-driver.ts");
    writeFileSync(countDriver, [
      `import { updateCopilotStopCount } from ${JSON.stringify(LIB)};`,
      `const result = updateCopilotStopCount(${JSON.stringify(proj)}, ${JSON.stringify(state)}, "stop-owner", "same", false, 100);`,
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n"));
    const N = 8;
    const procs = Array.from({ length: N }, () => Bun.spawn([BUN, countDriver], {
      cwd: proj,
      stdout: "pipe",
      stderr: "pipe",
    }));
    const [codes, outputs, errors] = await Promise.all([
      Promise.all(procs.map((proc) => proc.exited)),
      Promise.all(procs.map((proc) => new Response(proc.stdout).text())),
      Promise.all(procs.map((proc) => new Response(proc.stderr).text())),
    ]);
    expect(codes, errors.join("\n")).toEqual(Array.from({ length: N }, () => 0));
    expect(outputs.every((output) => JSON.parse(output).shouldBlock === true)).toBe(true);
    const final = JSON.parse(readFileSync(join(recordDir, ".aidlc-active-directive.json"), "utf-8"));
    expect(final.stop_count).toBe(N);
    expect(final.revision).toBe(1 + N);
  }, 30000);
});
