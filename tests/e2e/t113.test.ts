// covers: audit:WORKFLOW_COMPLETED, audit:PHASE_VERIFIED, audit:PHASE_COMPLETED
//         (+ terminal-event ORDERING + re-run IDEMPOTENCY — see TECHNIQUE)
//
// t113 — complete-workflow TERMINAL-EVENT ORDERING + IDEMPOTENCY. The audit
// trail's load-bearing contract at the end of a workflow is that the final
// phase's closure events land IN THIS EXACT ORDER:
//
//     STAGE_COMPLETED -> PHASE_COMPLETED -> PHASE_VERIFIED -> WORKFLOW_COMPLETED
//
// and that WORKFLOW_COMPLETED is dead-last and fires EXACTLY ONCE. Every
// downstream consumer (the statusline, resume, CI gates, doctor) reads the
// audit tail to decide "is this workflow done?"; if a refactor reordered the
// emits in handleCompleteWorkflow (aidlc-state.ts:573-596) — e.g. moved the
// WORKFLOW_COMPLETED emit before PHASE_VERIFIED, or dropped the
// alreadyMarkedCompleted guard so the final STAGE_COMPLETED doubled — the
// counts could still look plausible while the SEQUENCE lied about what
// happened. No test today asserts this terminal ORDER, nor the re-run
// idempotency of the final approve. t51 asserts counts + "first/last event"
// + a single gate<stage ordering pair, but not the four-event terminal tail
// nor what a past-the-end approve does. This pins both.
//
// SOURCE (aidlc-state.ts):
//   - handleApprove (:675) validates the slug is `awaiting-approval` (:685),
//     flips it to [x], emits GATE_APPROVED + STAGE_COMPLETED (:703-708), then
//     auto-advances: nextInScopeStage -> handleAdvance, OR (final stage)
//     handleCompleteWorkflow (:729-739).
//   - handleCompleteWorkflow (:520) sets Status=Completed and emits, IN ORDER,
//     STAGE_COMPLETED (suppressed when alreadyMarkedCompleted, :574) ->
//     PHASE_COMPLETED (:580) -> PHASE_VERIFIED (:585) -> WORKFLOW_COMPLETED
//     (:593). For the final-stage approve path the STAGE_COMPLETED was already
//     emitted by approve (:705), so the guard suppresses the duplicate and the
//     observed terminal tail is exactly STAGE_COMPLETED -> PHASE_COMPLETED ->
//     PHASE_VERIFIED -> WORKFLOW_COMPLETED.
//
// IDEMPOTENCY — verified by probe, asserting the REAL behaviour of each seam:
//   - approve PAST THE END is idempotent: once the final slug is [x],
//     re-running `approve build-and-test` fails validateSlugInState (:685,
//     state 'completed' not 'awaiting-approval') WITHOUT reaching the terminal
//     sequence, so WORKFLOW_COMPLETED stays at exactly 1 (and no second
//     STAGE_COMPLETED lands). This is the realistic re-run scenario in the
//     deterministic walk (the orchestrator replays an approve), so it is the
//     behavioural contract pinned here. NOTE the failed approve is not a
//     silent no-op: error() routes through emitError (:1709 -> lib :1473) and
//     appends exactly ONE ERROR_LOGGED row, so the trail GROWS by one and its
//     new dead-last event is ERROR_LOGGED, not a duplicate WORKFLOW_COMPLETED.
//     The test asserts that real shape.
//   - SOURCE SURPRISE (not the asserted path, noted for the record): re-running
//     `complete-workflow build-and-test` DIRECTLY is NOT idempotent — it has no
//     already-Completed early return, and the alreadyMarkedCompleted guard
//     suppresses only the duplicate STAGE_COMPLETED, so PHASE_COMPLETED /
//     PHASE_VERIFIED / WORKFLOW_COMPLETED all re-emit, doubling the count to 2.
//     A future fix that guards handleCompleteWorkflow against an
//     already-Completed Status would make that path idempotent too; this test
//     would not break (it asserts only the approve seam).
//
// TECHNIQUE: invariant. Drive the SHORTEST scope (bugfix, 6 EXECUTE stages) from
// init to completion with NO claude — `aidlc-utility.ts init` to bootstrap, then
// gate-start -> approve per remaining stage (approve auto-advances; the final
// approve reaches handleCompleteWorkflow). Same seam t51 uses. Then parse the
// resulting audit.md and assert on the FILE bytes (never prose). bugfix has 3
// PHASE_VERIFIED (initialization, inception, construction); we assert the FINAL
// phase's terminal ordering and the singleton WORKFLOW_COMPLETED.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";
// P4: audit is sharded per clone under the born intent's record; read the
// merged shards via the shipped helper (default-resolves the active intent).
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");

// Spawn a state/utility subcommand via the SAME bun that runs this test
// (process.execPath), cwd-independent. Mirrors t51's `bun "$STATE" ...` calls.
function run(
  tool: string,
  args: string[],
  proj: string,
  extraEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env, ...extraEnv };
  if (tool === STATE) {
    env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
  }
  const res = spawnSync(
    process.execPath,
    [tool, ...args, "--project-dir", proj],
    { encoding: "utf8", env },
  );
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// gate-start -> approve a single stage, exactly as t51's walk_stage does.
function walkStage(slug: string, proj: string): void {
  const gs = run(STATE, ["gate-start", slug], proj);
  expect(gs.status).toBe(0);
  const ap = run(STATE, ["approve", slug, "--user-input", "approve"], proj);
  expect(ap.status).toBe(0);
}

// Each audit block carries `**Timestamp**: <iso>` + `**Event**: <TYPE>`
// (aidlc-audit.ts). P4 shards audit per clone, so a multi-spawn drive lands its
// blocks across several shards; readAllAuditShards concatenates them (block
// boundaries preserved) but cross-shard order is by clone-id filename, NOT
// chronology. So parse (timestamp, event) per block and STABLE-sort by timestamp
// — buffer position is the documented tiebreak for same-second blocks (isoTimestamp
// is second-precision), which is exactly how the engine's block parsers order. The
// terminal four (emitted in one complete-workflow process, one shard) stay in
// their emit order under this sort.
function eventSequence(proj: string): string[] {
  const text = readAllAuditShards(proj);
  const blocks = text.split("\n---\n");
  const parsed: { ts: string; event: string; pos: number }[] = [];
  blocks.forEach((block, pos) => {
    const ev = block.match(/^\*\*Event\*\*: (.+)$/m);
    if (!ev) return;
    const tsm = block.match(/^\*\*Timestamp\*\*: (.+)$/m);
    parsed.push({ ts: tsm ? tsm[1].trim() : "", event: ev[1].trim(), pos });
  });
  parsed.sort((a, b) => (a.ts === b.ts ? a.pos - b.pos : a.ts < b.ts ? -1 : 1));
  return parsed.map((p) => p.event);
}

function countEvent(seq: string[], type: string): number {
  return seq.filter((e) => e === type).length;
}

// Drive a complete bugfix workflow once; return the project dir (audit is read
// from the born intent's shards via readAllAuditShards(proj)). Bootstrap via
// init (emits WORKFLOW_STARTED + init phase + 2x PHASE_SKIPPED and pre-completes
// the 3 init stages), then walk the remaining EXECUTE stages.
function driveBugfixToCompletion(): { proj: string } {
  const proj = createTestProject();
  const init = run(
    UTIL,
    ["intent-birth", "--scope", "bugfix"],
    proj,
    { AIDLC_WORKFLOW_INTENT: "t113 terminal-ordering test" },
  );
  expect(init.status).toBe(0);

  // bugfix post-init EXECUTE stages, in order (reverse-engineering is
  // SKIP-overridden on greenfield; init pre-completes the 3 init stages).
  walkStage("requirements-analysis", proj);
  walkStage("code-generation", proj);
  walkStage("build-and-test", proj); // final stage -> handleCompleteWorkflow

  return { proj };
}

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

// Each `bun <tool>.ts` cold-start costs ~hundreds of ms and a full bugfix drive
// is ~9 spawns; driving once per test blows bun:test's default 5s per-test
// timeout. So drive the workflow ONCE per describe in a beforeAll (the walk is
// deterministic) and share the resulting audit across the assertions. Generous
// explicit timeouts on the drives keep this honest on a cold/loaded machine.
const DRIVE_TIMEOUT_MS = 60_000;

describe("complete-workflow terminal-event ordering (bugfix, no claude)", () => {
  let seq: string[];

  beforeAll(() => {
    const { proj } = driveBugfixToCompletion();
    projects.push(proj);
    seq = eventSequence(proj);
  }, DRIVE_TIMEOUT_MS);

  test("the FINAL four events are STAGE_COMPLETED -> PHASE_COMPLETED -> PHASE_VERIFIED -> WORKFLOW_COMPLETED, in that order", () => {
    // Sanity: a non-trivial trail was produced.
    expect(seq.length).toBeGreaterThan(10);

    // The terminal tail — the canonical workflow-closure sequence. The last
    // FOUR events as an ordered slice catch any REORDER of the emits in
    // handleCompleteWorkflow or a dropped phase-closure event.
    expect(seq.slice(-4)).toEqual([
      "STAGE_COMPLETED",
      "PHASE_COMPLETED",
      "PHASE_VERIFIED",
      "WORKFLOW_COMPLETED",
    ]);

    // NO ADJACENT-DUPLICATE STAGE_COMPLETED in the terminal closure. The
    // slice(-4) check above does NOT catch a doubled final STAGE_COMPLETED:
    // the duplicate lands at index -5 (...STAGE_COMPLETED, STAGE_COMPLETED,
    // PHASE_COMPLETED, PHASE_VERIFIED, WORKFLOW_COMPLETED), leaving the last
    // four bytes unchanged. Dropping the alreadyMarkedCompleted guard
    // (aidlc-state.ts:574) produces exactly that doubling. Assert that no two
    // STAGE_COMPLETED events are adjacent ANYWHERE in the trail — the final
    // approve's STAGE_COMPLETED must not be re-emitted by handleCompleteWorkflow.
    const adjacentDup = seq.some(
      (e, i) => e === "STAGE_COMPLETED" && seq[i + 1] === "STAGE_COMPLETED",
    );
    expect(adjacentDup).toBe(false);
  });

  test("WORKFLOW_COMPLETED is dead-last and fires exactly once", () => {
    expect(seq[seq.length - 1]).toBe("WORKFLOW_COMPLETED");
    expect(countEvent(seq, "WORKFLOW_COMPLETED")).toBe(1);
  });

  test("the FINAL phase's closure ordering holds: the last PHASE_VERIFIED is immediately followed by WORKFLOW_COMPLETED, with PHASE_COMPLETED before it", () => {
    // bugfix crosses 3 phase boundaries -> 3 PHASE_VERIFIED / 3 PHASE_COMPLETED.
    // We pin the FINAL phase's ordering specifically (the others are mid-stream
    // boundaries emitted by handleAdvance; this one is the terminal handler).
    expect(countEvent(seq, "PHASE_VERIFIED")).toBe(3);
    expect(countEvent(seq, "PHASE_COMPLETED")).toBe(3);

    const lastVerified = seq.lastIndexOf("PHASE_VERIFIED");
    const lastCompletedPhase = seq.lastIndexOf("PHASE_COMPLETED");
    const workflowDone = seq.lastIndexOf("WORKFLOW_COMPLETED");

    // PHASE_COMPLETED precedes PHASE_VERIFIED precedes WORKFLOW_COMPLETED, and
    // the final PHASE_VERIFIED sits exactly one slot before WORKFLOW_COMPLETED.
    expect(lastCompletedPhase).toBeLessThan(lastVerified);
    expect(lastVerified).toBeLessThan(workflowDone);
    expect(workflowDone - lastVerified).toBe(1);
  });
});

describe("complete-workflow idempotency: re-running the final approve emits no second WORKFLOW_COMPLETED", () => {
  let proj: string;

  beforeAll(() => {
    const driven = driveBugfixToCompletion();
    proj = driven.proj;
    projects.push(proj);
  }, DRIVE_TIMEOUT_MS);

  test("approve PAST THE END fails (slug already [x]) and emits NO second WORKFLOW_COMPLETED / STAGE_COMPLETED — only an ERROR_LOGGED row", () => {
    // Precondition: the clean walk landed exactly one WORKFLOW_COMPLETED, with
    // it dead-last in the trail.
    const before = eventSequence(proj);
    expect(countEvent(before, "WORKFLOW_COMPLETED")).toBe(1);
    expect(before[before.length - 1]).toBe("WORKFLOW_COMPLETED");
    const stageCompletedBefore = countEvent(before, "STAGE_COMPLETED");

    // Re-run approve on the (now [x]) final stage. handleApprove's
    // validateSlugInState (aidlc-state.ts:685) requires 'awaiting-approval';
    // the slug is 'completed', so this MUST fail WITHOUT reaching the terminal
    // sequence — the realistic orchestrator-replay idempotency contract.
    const replay = run(
      STATE,
      ["approve", "build-and-test", "--user-input", "approve"],
      proj,
    );
    expect(replay.status).not.toBe(0);
    // The error names the state-machine guard it tripped (asserts the cause,
    // not just "it failed somehow").
    expect(replay.stdout + replay.stderr).toContain("awaiting-approval");

    // The IDEMPOTENCY contract on the audit FILE: still exactly one
    // WORKFLOW_COMPLETED (no duplicate terminal event) and no extra
    // STAGE_COMPLETED for the final stage.
    const after = eventSequence(proj);
    expect(countEvent(after, "WORKFLOW_COMPLETED")).toBe(1);
    expect(countEvent(after, "STAGE_COMPLETED")).toBe(stageCompletedBefore);

    // REAL behaviour of the failed replay (asserted, not assumed): the error
    // path routes through error() -> emitError (aidlc-state.ts:1709 ->
    // aidlc-lib.ts:1473), which appends exactly ONE ERROR_LOGGED row. So the
    // trail GREW by one event and the new dead-last event is ERROR_LOGGED, NOT
    // a second WORKFLOW_COMPLETED. Pinning this guards a future regression
    // where a failed past-the-end approve falls through to the terminal emits.
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1]).toBe("ERROR_LOGGED");
    // And WORKFLOW_COMPLETED remains the last NON-error terminal event.
    expect(after.lastIndexOf("WORKFLOW_COMPLETED")).toBe(
      after.length - 2,
    );
  });
});
