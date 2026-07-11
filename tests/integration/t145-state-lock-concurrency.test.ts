// covers: subcommand:aidlc-state:set, subcommand:aidlc-state:reject, subcommand:aidlc-state:approve, subcommand:aidlc-state:skip, subcommand:aidlc-state:set-skeleton-stance, function:withAuditLock, function:holdsAuditLock
//
// t145 — C2b lost-update safety: the 11 state read-modify-write handlers in
// aidlc-state.ts now hold the audit lock across their whole read→decide→
// emit-audit→write critical section (withAuditLock), so concurrent writers
// can't clobber each other's updates. Mechanism: cli (process-boundary).
//
// WHY CLI (process-boundary, not in-process): the subject IS concurrency —
// independent OS processes racing for the same state file + mkdir audit lock.
// bun:test runs serially inside one process, and an in-process loop calling
// the handlers N times would be strictly serial and could NEVER exercise the
// inter-process race the fix addresses. So this twin SPAWNS the real tool
// concurrently (Bun.spawn + Promise.all), exactly how Claude Code's swarm
// referee, parallel Bolts, and hooks drive aidlc-state.ts from many processes.
// Same approach as t33-hook-concurrency (audit-logger lock contention).
//
// THE BUG (pre-C2b): each handler did an UNLOCKED read-modify-write —
//   let content = readStateFile(pd); ...mutate...; writeStateFile(pd, content);
// Two writers both read V1, both mutate their own copy, both write: the
// second write clobbers the first's field (lost update). C2a made the write
// atomic (no torn bytes) but did NOT serialise the read-decide-write, so the
// lost update survived. C2b wraps the critical section in withAuditLock so the
// read and the write see one snapshot under one lock.
//
// SOURCE UNDER TEST:
//   dist/claude/.claude/tools/aidlc-state.ts — handleSet / handleReject /
//     handleApprove / handleSkip / handleSetSkeletonStance (+ the rest of the
//     11) now open with `withAuditLock(pd, () => { ... })`.
//   dist/claude/.claude/tools/aidlc-lib.ts:withAuditLock — reentrant per-pd
//     audit lock (the OS mutex is mkdir-based, so cross-process contention
//     serialises through EEXIST + the retry budget).
//   dist/claude/.claude/tools/aidlc-lib.ts:holdsAuditLock — the in-lock signal
//     emitAudit() branches on to pick appendAuditEntryUnlocked (held lock) vs
//     appendAuditEntry (no lock), so an in-transaction emit can't self-deadlock.
//
// FIXTURE DISCIPLINE: each test gets a fresh createTestProject() (temp dir with
// aidlc-docs/) seeded by a REAL `aidlc-utility init --scope bugfix` run, so the
// state file is the genuine v7 template the handlers expect (Revision Count,
// checkbox slugs, Scope, the lot). cleanup rm -rf's the temp dir; the audit
// lock lives under tmpdir() and is asserted-then-removed (afterEach safety).
// Nothing is written under tests/fixtures/**.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";
import {
  auditLockDir,
  getField,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const STATE_TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-state.ts");
const UTIL_TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

let proj: string;

// P4: init now BIRTHS a per-intent record — state lands at
// aidlc/spaces/<space>/intents/<slug>-<id8>/aidlc-state.md and audit at
// <record>/audit/<host>-<clone>.md (per-clone shards), NOT the flat aidlc-docs/.
// Resolve the born record from the active-space + active-intent cursors (flat
// fallback for a not-yet-born project). The concurrency under test is unchanged
// — the per-intent lock serialises the concurrent writers exactly as before.
function recordDirOf(p: string): string {
  const spaceCursor = join(p, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(p, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(p, "aidlc-docs");
}
function statePath(p: string): string {
  return join(recordDirOf(p), "aidlc-state.md");
}
function readState(p: string): string {
  return readFileSync(statePath(p), "utf-8");
}
function field(p: string, name: string): string | null {
  return getField(readState(p), name);
}
/** Concatenated text of every per-clone audit shard (flat fallback). */
function readAudit(p: string): string {
  const auditDir = join(recordDirOf(p), "audit");
  if (existsSync(auditDir)) {
    const shards = readdirSync(auditDir).filter((f) => f.endsWith(".md"));
    if (shards.length > 0) {
      return shards.map((f) => readFileSync(join(auditDir, f), "utf-8")).join("\n");
    }
  }
  const flat = join(p, "aidlc-docs", "audit.md");
  return existsSync(flat) ? readFileSync(flat, "utf-8") : "";
}
/** Count occurrences of an "**Event**: <type>" line across the audit shards. */
function eventCount(p: string, type: string): number {
  return readAudit(p)
    .split("\n")
    .filter((l) => l.trim() === `**Event**: ${type}`).length;
}

/** Run the state tool synchronously (for sequential setup steps). */
function stateSync(args: string[], p: string): { status: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({
    cmd: [BUN, STATE_TOOL, ...args, "--project-dir", p],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/**
 * Fire a batch of state-tool invocations IN PARALLEL against the same project.
 * Each entry is an args array. Uses Bun.spawn (async) + Promise.all so every
 * process is launched before any is awaited — genuine inter-process contention
 * on the state file + audit lock, not serial. Returns per-process exit codes.
 */
async function fireParallel(p: string, argSets: string[][]): Promise<number[]> {
  const procs = argSets.map((args) =>
    Bun.spawn({
      cmd: [BUN, STATE_TOOL, ...args, "--project-dir", p],
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  await Promise.all(procs.map((c) => c.exited));
  return Promise.all(procs.map((c) => c.exited));
}

describe("t145 C2b state-lock lost-update safety (mechanism cli — parallel spawn)", () => {
  beforeEach(() => {
    proj = createTestProject();
    // Seed a genuine v7 state file via the real init path (Scope=bugfix gives a
    // running INCEPTION workflow at requirements-analysis with code-generation
    // next — the shape the gate handlers expect).
    const init = Bun.spawnSync({
      cmd: [BUN, UTIL_TOOL, "intent-birth", "--scope", "bugfix", "--project-dir", proj],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (init.exitCode !== 0) throw new Error("t145 fixture init failed");
  });

  afterEach(() => {
    // Defence-in-depth: drop a leaked lock dir so it can't bleed into the next
    // test. The happy path releases it via withAuditLock's finally.
    try {
      rmdirSync(auditLockDir(proj));
    } catch {
      /* already released — expected on the happy path */
    }
    cleanupTestProject(proj);
  });

  // ---------------------------------------------------------------------------
  // TEST 1 — the guard-the-guard. N concurrent `set "Revision Count=+1"`
  // increments. The +1 form is a read-modify-write of one counter: without the
  // lock, writers read the same value and clobber, so the final count is < N
  // (lost updates). With C2b's lock, all N increments serialise → exactly N.
  // This is the assertion that FAILS on the pre-C2b (unlocked) handler and
  // passes after — proving the lock has teeth.
  // ---------------------------------------------------------------------------
  test("N concurrent `set Revision Count=+1` all land — no lost increments [guard-the-guard]", async () => {
    const N = 20;
    expect(field(proj, "Revision Count")).toBe("0"); // fixture precondition
    const codes = await fireParallel(
      proj,
      Array.from({ length: N }, () => ["set", "Revision Count=+1"]),
    );
    // Every writer succeeded (lock serialises; none errors out).
    expect(codes.every((c) => c === 0)).toBe(true);
    // The counter reflects ALL N increments. Pre-fix this is < N (lost updates).
    expect(field(proj, "Revision Count")).toBe(String(N));
  }, 60000);

  // ---------------------------------------------------------------------------
  // TEST 2 — two concurrent `set` of DISTINCT fields. Both updates must survive
  // (neither writer's field is clobbered by the other's full-file rewrite).
  // ---------------------------------------------------------------------------
  test("two concurrent `set` of different fields both survive [lost-update on set]", async () => {
    const codes = await fireParallel(proj, [
      ["set", "Languages=concurrent-A"],
      ["set", "Frameworks=concurrent-B"],
    ]);
    expect(codes.every((c) => c === 0)).toBe(true);
    // Both fields reflect their concurrent write — a lost update would leave one
    // at its template default ("Unknown").
    expect(field(proj, "Languages")).toBe("concurrent-A");
    expect(field(proj, "Frameworks")).toBe("concurrent-B");
  }, 60000);

  // ---------------------------------------------------------------------------
  // TEST 3 — approve ∥ skip on two DIFFERENT stages, fired concurrently. Both
  // transitions must land in the final state AND both their audit rows must be
  // present (the lock serialises the two read-decide-emit-write transactions —
  // neither clobbers the other's checkbox flip, and the audit emits don't
  // interleave). requirements-analysis is the current gate-held stage; we open
  // its gate, then race approve(requirements-analysis) ∥ skip(code-generation).
  // ---------------------------------------------------------------------------
  test("concurrent approve ∥ skip — both transitions and both audit rows survive", async () => {
    // Open the gate on the current stage so approve has a valid [?] to act on.
    expect(stateSync(["gate-start", "requirements-analysis"], proj).status).toBe(0);

    const approvedBefore = eventCount(proj, "GATE_APPROVED");
    const skippedBefore = eventCount(proj, "STAGE_SKIPPED");

    const codes = await fireParallel(proj, [
      ["approve", "requirements-analysis"],
      ["skip", "code-generation", "--reason", "concurrent-skip"],
    ]);
    expect(codes.every((c) => c === 0)).toBe(true);

    const finalState = readState(proj);
    // approve flips requirements-analysis → [x] (completed) — the checkbox
    // survival assertion is the one with genuine lock teeth: a lost update would
    // leave requirements-analysis un-completed or code-generation un-skipped
    // because one transaction's full-file rewrite clobbered the other's flip.
    expect(/- \[x\] requirements-analysis /.test(finalState)).toBe(true);
    // skip flips code-generation → [S] (skipped).
    expect(/- \[S\] code-generation /.test(finalState)).toBe(true);

    // Both audit rows present — neither transaction's emit was lost. (These two
    // counts are produced by the independently-locked audit append regardless of
    // the STATE-lock interleaving, so they corroborate rather than prove the
    // lock — the checkbox survival above is the load-bearing teeth.)
    expect(eventCount(proj, "GATE_APPROVED")).toBe(approvedBefore + 1);
    expect(eventCount(proj, "STAGE_SKIPPED")).toBe(skippedBefore + 1);

    // Current Stage is left in ONE consistent, real value — not a torn write.
    // The two transactions serialise under the lock, so Current Stage reflects a
    // definite serial outcome: approve auto-advances past requirements-analysis,
    // and depending on whether the skip of code-generation landed before or after
    // that advance, the pointer is code-generation (skip ran after advance) or
    // the next in-scope stage beyond it (skip ran first, so advance stepped over
    // the now-[S] code-generation). Either way it must be a definite, non-empty
    // slug that is NOT the just-completed [x] requirements-analysis — a lost/torn
    // update is what would blank it or leave it on the completed stage.
    const cur = getField(finalState, "Current Stage");
    expect(cur).toBeTruthy();
    expect(cur).not.toBe("requirements-analysis");
    // And it names a real stage that exists as a checkbox in the state file
    // (not a corrupted/partial value).
    expect(new RegExp(`- \\[[ xSR?-]\\] ${cur} `).test(finalState)).toBe(true);
  }, 60000);

  // ---------------------------------------------------------------------------
  // TEST 4 — reentrancy under the wrap. `approve` holds the outer lock and then
  // calls handleAdvance (or handleCompleteWorkflow), each of which ALSO opens
  // withAuditLock for the same pd. The per-pd depth counter makes that nested
  // acquire a no-op (depth 1→2→1) instead of a self-deadlock against the lock
  // approve already holds. Without reentrancy this run would hang on the inner
  // acquire and burn the 5s retry budget; here it completes cleanly and the
  // auto-advance lands (requirements-analysis → [x], Current Stage → next).
  // ---------------------------------------------------------------------------
  test("approve nests advance/complete-workflow without deadlock (reentrant lock)", () => {
    expect(stateSync(["gate-start", "requirements-analysis"], proj).status).toBe(0);
    const r = stateSync(["approve", "requirements-analysis"], proj);
    expect(r.status).toBe(0);
    const finalState = readState(proj);
    // The gate stage completed AND the auto-advance moved Current Stage forward
    // (the nested handleAdvance ran under the reentrant lock).
    expect(/- \[x\] requirements-analysis /.test(finalState)).toBe(true);
    expect(getField(finalState, "Current Stage")).not.toBe("requirements-analysis");
    // The lock dir must be released after the (reentrant) transaction completes.
    expect(existsSync(auditLockDir(proj))).toBe(false);
  }, 60000);

  // ---------------------------------------------------------------------------
  // TEST 6 — concurrent `reject` on ONE gate-held [?] stage. reject is the
  // handler the source comment itself flags as the canonical lost-update case
  // (aidlc-state.ts handleReject: "two concurrent rejects must not both read N
  // and both write N+1"): it validates the stage is [?]/[-], increments Revision
  // Count (a read-modify-write of a counter), and flips the stage to [R], all
  // under one withAuditLock. With the lock these N transactions serialise on the
  // SAME gate, so the state machine admits exactly ONE rejection (the first sees
  // [?] and wins → Revision Count 1, one GATE_REJECTED; the rest re-read and see
  // [R], which is not an accepted input, so they error out). Without the lock,
  // multiple writers could pass the [?] validation against the same snapshot and
  // both emit GATE_REJECTED / both compute revCount from the same stale N — the
  // duplicate-rejection + lost-increment the wrap prevents.
  //
  // This is the direct reject-path analogue of test 1 (which drives Revision
  // Count only via handleSet's +1 branch, a DIFFERENT handler under a different
  // lock). t145's covers: header claims aidlc-state:reject — this is the test
  // body that earns that claim.
  // ---------------------------------------------------------------------------
  test("concurrent reject on one gate-held stage — exactly one rejection, no lost/duplicated increment", async () => {
    // Put requirements-analysis into the awaiting-approval [?] gate state.
    expect(stateSync(["gate-start", "requirements-analysis"], proj).status).toBe(0);
    expect(field(proj, "Revision Count")).toBe("0"); // precondition

    const N = 8;
    const codes = await fireParallel(
      proj,
      Array.from({ length: N }, (_unused, i) => [
        "reject",
        "requirements-analysis",
        "--feedback",
        `concurrent-reject-${i}`,
      ]),
    );

    // The gate transition is mutually exclusive under the lock: exactly one
    // reject is accepted; the rest error because the stage is already [R].
    const accepted = codes.filter((c) => c === 0).length;
    expect(accepted).toBe(1);

    // The accepted rejection incremented Revision Count exactly once (no two
    // writers both read 0 and both write 1, and no double-increment) — the
    // counter is exactly 1, and there is exactly ONE GATE_REJECTED audit row.
    expect(field(proj, "Revision Count")).toBe("1");
    expect(eventCount(proj, "GATE_REJECTED")).toBe(1);
    // The stage landed in the revising [R] state.
    expect(/- \[R\] requirements-analysis /.test(readState(proj))).toBe(true);
  }, 60000);

  // ---------------------------------------------------------------------------
  // TEST 7 — sequential reject→revise cycles drive Revision Count up the reject
  // path itself, and a concurrent burst at each [?] re-entry never double-counts.
  // This pins that the reject increment is exact across repeated gate cycles
  // (the counter monotonically reflects accepted rejections, one per cycle),
  // complementing test 6's single-cycle mutual exclusion.
  // ---------------------------------------------------------------------------
  test("repeated reject/revise cycles increment Revision Count exactly once per accepted rejection", async () => {
    expect(stateSync(["gate-start", "requirements-analysis"], proj).status).toBe(0);
    const CYCLES = 3;
    for (let c = 0; c < CYCLES; c++) {
      // Race a burst of rejects at the open [?] gate — exactly one is accepted.
      const codes = await fireParallel(
        proj,
        Array.from({ length: 4 }, () => ["reject", "requirements-analysis"]),
      );
      expect(codes.filter((x) => x === 0).length).toBe(1);
      // Re-enter the gate ([R] → [?]) so the next cycle has a valid target.
      expect(stateSync(["revise", "requirements-analysis"], proj).status).toBe(0);
    }
    // Exactly CYCLES accepted rejections → Revision Count === CYCLES, and exactly
    // that many GATE_REJECTED rows. No burst double-counted.
    expect(field(proj, "Revision Count")).toBe(String(CYCLES));
    expect(eventCount(proj, "GATE_REJECTED")).toBe(CYCLES);
  }, 90000);

  // ---------------------------------------------------------------------------
  // TEST 5 — after a burst of concurrent writes the mkdir audit lock is fully
  // released (every withAuditLock finally ran). A leaked lock dir would poison
  // the next operation for the ~5s retry budget.
  // ---------------------------------------------------------------------------
  test("the audit lock dir is released after concurrent writes complete", async () => {
    await fireParallel(proj, [
      ["set", "Languages=x"],
      ["set", "Frameworks=y"],
      ["set", "Revision Count=+1"],
      ["set-skeleton-stance", "on"],
    ]);
    expect(existsSync(auditLockDir(proj))).toBe(false);
  }, 60000);
});
