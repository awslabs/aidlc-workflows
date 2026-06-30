// covers: cli:aidlc-state(approve,gate-start), cli:aidlc-log(answer), function:handleApprove, function:handleGateStart, function:handleAnswer, function:humanPresent, function:consumeHumanMarker, function:readHumanMarker, function:readTurnCounter, function:isAutonomousMode, function:humanPresenceGuardDisabled, file:hooks/aidlc-mint-presence.ts
//
// t188 - human-presence approval gate (issue #451).
//
// Mechanism: cli. The subject is the deterministic human-presence guard the
// state tool runs on the approve path (and the log tool on the interview-answer
// path) AFTER the #366 artifact guard and BEFORE any state mutation. It refuses
// to commit a gate unless a real human acted at THIS gate since it opened, where
// "a human acted" is proven by an unconsumed presence marker minted on a typed
// turn. The guard reads the per-clone audit shard + the workspace-root marker
// files the resolved pd points at, so this is a PROCESS boundary exercised by
// spawning the real dist tools (spawnSync(BUN, [STATE|LOG, ...])).
//
// The marker contract (issue #451 section 1.2), all at WORKSPACE ROOT
// (aidlc/), NOT per-intent:
//   aidlc/.aidlc-turn-counter = a plain integer (the per-turn clock).
//   aidlc/.aidlc-human-marker = JSON { turn:int, ts:string, consumed:bool }.
// humanPresent(pd, openTurn) is true iff the turn-counter file exists AND there
// is an unconsumed marker whose turn >= openTurn. If the turn-counter file has
// NEVER existed, humanPresent fails OPEN (presence tracking not active on this
// harness) - so a fixture with NO counter file passes without a marker.
//
// CRITICAL test-harness note: run-tests.ts sets AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1
// for the whole suite (so the ~81 approve/advance tests keep passing). This test
// re-enables enforcement by DELETING that var from the spawned tool's env -
// otherwise it would be testing the bypass, not the guard. It KEEPS
// AIDLC_SKIP_ARTIFACT_GUARD=1 set, because the #366 artifact guard is a separate
// chokepoint these bare fixtures do not satisfy; this test isolates the #451
// presence guard.
//
// Source under test (dist/claude/.claude/tools/):
//   aidlc-state.ts handleApprove (presence check + consume-before-advance),
//   aidlc-state.ts handleGateStart (stamps the "Open Turn" field),
//   aidlc-log.ts handleAnswer (the interview-path twin, openTurn pinned to 0).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const MID_IDEATION = "state-mid-ideation.md"; // Current Stage: feasibility

// The workspace-root marker files (issue #451 section 1.1).
const TURN_COUNTER = (proj: string): string =>
  join(proj, "aidlc", ".aidlc-turn-counter");
const HUMAN_MARKER = (proj: string): string =>
  join(proj, "aidlc", ".aidlc-human-marker");

// Drive a state subcommand with the PRESENCE guard ENABLED (clear the suite's
// presence-bypass var) but the ARTIFACT guard still bypassed (a separate #366
// chokepoint these bare fixtures don't satisfy). Returns exit code + output.
function guarded(proj: string, args: string[]): { rc: number; out: string } {
  const env = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Drive an aidlc-log subcommand with the same guard posture.
function guardedLog(proj: string, args: string[]): { rc: number; out: string } {
  const env = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const r = spawnSync(BUN, [LOG, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function field(proj: string, name: string): string {
  return guarded(proj, ["get", name]).out.trim();
}

// Count audit blocks with `**Event**: <ev>` in the merged shard buffer.
function gateApprovedCount(proj: string): number {
  const body = readAllAuditShards(proj);
  return body
    .split("\n")
    .filter((l) => /^\*\*Event\*\*: GATE_APPROVED$/.test(l)).length;
}

function questionAnsweredCount(proj: string): number {
  const body = readAllAuditShards(proj);
  return body
    .split("\n")
    .filter((l) => /^\*\*Event\*\*: QUESTION_ANSWERED$/.test(l)).length;
}

// Write the turn counter (a plain int) at the workspace root.
function writeTurnCounter(proj: string, turn: number): void {
  mkdirSync(join(proj, "aidlc"), { recursive: true });
  writeFileSync(TURN_COUNTER(proj), `${turn}\n`, "utf-8");
}

// Write the REAL human marker shape: JSON { turn, ts, consumed }.
function writeMarker(proj: string, turn: number, consumed: boolean): void {
  mkdirSync(join(proj, "aidlc"), { recursive: true });
  const marker = { turn, ts: "2026-06-30T00:00:00Z", consumed };
  writeFileSync(HUMAN_MARKER(proj), `${JSON.stringify(marker)}\n`, "utf-8");
}

// Read back the marker's consumed flag (the consume-once assertion target).
function markerConsumed(proj: string): boolean {
  const parsed = JSON.parse(readFileSync(HUMAN_MARKER(proj), "utf-8")) as {
    consumed: boolean;
  };
  return parsed.consumed;
}

// Append the autonomy field to the seeded state file (the mid-ideation fixture
// carries no Construction Autonomy Mode field, and setField is a no-op for an
// absent field, so write the field line directly - isAutonomousMode reads
// getField(content, "Construction Autonomy Mode")?.trim() === "autonomous").
function setAutonomous(proj: string): void {
  const sf = seededStateFile(proj);
  const content = readFileSync(sf, "utf-8");
  writeFileSync(sf, `${content}\n- **Construction Autonomy Mode**: autonomous\n`, "utf-8");
}

let proj: string;

describe("t188: human-presence approval gate (#451)", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION); // Current Stage: feasibility
  });

  afterEach(() => cleanupTestProject(proj));

  // --- Scenario A: FABRICATION (no presence) ---------------------------------
  //
  // Gate open (slug awaiting-approval, STAGE_AWAITING_APPROVAL Open Turn=1), the
  // turn counter exists (presence tracking IS active), but there is NO marker -
  // a model under autopilot fabricating an approval. The gate must REFUSE and
  // emit no GATE_APPROVED.
  test("A: approve REFUSES when the turn counter is active but no marker exists", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    writeTurnCounter(proj, 1); // presence tracking active
    guarded(proj, ["gate-start", slug]); // stamps Open Turn=1
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to approve");
    expect(gateApprovedCount(proj)).toBe(0);
    // State untouched: the stage is NOT marked completed.
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  test("A2: approve REFUSES when the only marker is already consumed", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    writeTurnCounter(proj, 1);
    writeMarker(proj, 1, /* consumed */ true);
    guarded(proj, ["gate-start", slug]);
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).not.toBe(0);
    expect(gateApprovedCount(proj)).toBe(0);
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  // --- Scenario B: LEGIT (fresh unconsumed marker) ---------------------------
  //
  // turn-counter=1 + marker {turn:1, consumed:false} -> approve COMMITS, exactly
  // one GATE_APPROVED, and the marker is flipped consumed:true afterward.
  test("B: approve COMMITS with a fresh unconsumed marker, then consumes it", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    writeTurnCounter(proj, 1);
    writeMarker(proj, 1, /* consumed */ false);
    guarded(proj, ["gate-start", slug]); // Open Turn=1
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).toBe(0);
    expect(gateApprovedCount(proj)).toBe(1);
    // Auto-advanced off feasibility.
    expect(field(proj, "Current Stage")).not.toBe(slug);
    // CONSUME: the marker is now spent.
    expect(markerConsumed(proj)).toBe(true);
  });

  // --- Scenario C: CONSUME-ONCE (load-bearing) -------------------------------
  //
  // One marker, two sequential gates in the SAME human turn. The first approve
  // commits AND consumes the marker (consume-before-advance ordering). When the
  // operator then opens a SECOND gate at the same turn and tries to approve it
  // with the now-consumed marker, the gate REFUSES. This proves the consume runs
  // BEFORE the reentrant advance opens the next gate - the riskiest correctness
  // point (a wrong ordering lets one human turn clear every cascaded gate).
  test("C: a single marker approves ONE gate; a second gate this turn REFUSES", () => {
    const slug1 = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug1}=in-progress`]);
    writeTurnCounter(proj, 1);
    writeMarker(proj, 1, /* consumed */ false);
    guarded(proj, ["gate-start", slug1]); // Open Turn=1

    // First gate this turn: commits + consumes.
    const r1 = guarded(proj, ["approve", slug1, "--user-input", "ok"]);
    expect(r1.rc).toBe(0);
    expect(gateApprovedCount(proj)).toBe(1);
    expect(markerConsumed(proj)).toBe(true);

    // Second gate, SAME turn (no new mint): the auto-advanced stage is now
    // Current Stage. Open its gate and try to approve with the spent marker.
    const slug2 = field(proj, "Current Stage");
    expect(slug2).not.toBe(slug1);
    guarded(proj, ["checkbox", `${slug2}=in-progress`]);
    guarded(proj, ["gate-start", slug2]); // Open Turn still 1 (counter unchanged)
    const r2 = guarded(proj, ["approve", slug2, "--user-input", "ok"]);
    expect(r2.rc).not.toBe(0);
    expect(r2.out).toContain("Refusing to approve");
    // Still exactly ONE commit across the whole turn.
    expect(gateApprovedCount(proj)).toBe(1);
    expect(field(proj, "Current Stage")).toBe(slug2);
  });

  // --- Scenario D: AUTONOMY carve-out ----------------------------------------
  //
  // state has `Construction Autonomy Mode: autonomous` -> approve COMMITS with NO
  // marker (swarm/Bolt has no human at the gate). The turn counter exists, so the
  // pass is the autonomy carve-out, not the fail-open-no-counter path.
  test("D: autonomous Construction approves with NO marker (carve-out)", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    setAutonomous(proj);
    writeTurnCounter(proj, 1); // presence tracking active, but no marker
    guarded(proj, ["gate-start", slug]);
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).toBe(0);
    expect(gateApprovedCount(proj)).toBe(1);
    expect(field(proj, "Current Stage")).not.toBe(slug);
  });

  // --- Scenario E: STALE marker ----------------------------------------------
  //
  // marker.turn (1) < gate Open Turn (2) -> the marker predates this gate -> the
  // gate REFUSES even though the marker is unconsumed. The gate-open turn is read
  // back from the "Open Turn" field handleGateStart stamps, so a higher turn
  // counter at gate-open time means an older marker is stale.
  test("E: a marker whose turn predates the gate's Open Turn is STALE -> REFUSE", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    writeTurnCounter(proj, 2); // gate opens at turn 2
    writeMarker(proj, 1, /* consumed */ false); // minted at the earlier turn 1
    guarded(proj, ["gate-start", slug]); // Open Turn=2
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to approve");
    expect(gateApprovedCount(proj)).toBe(0);
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  // --- Scenario F: fail-open when presence tracking is not active ------------
  //
  // No turn-counter file ever existed (a harness with no mint seam wired) -> the
  // gate must NOT brick: humanPresent fails OPEN and the approve COMMITS without
  // a marker. This is the rule that keeps Claude/Codex from bricking before their
  // mint seam runs.
  test("F: approve COMMITS when no turn counter file has ever existed (fail-open)", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    // No writeTurnCounter / no marker.
    guarded(proj, ["gate-start", slug]);
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).toBe(0);
    expect(gateApprovedCount(proj)).toBe(1);
    expect(field(proj, "Current Stage")).not.toBe(slug);
  });

  // --- handleAnswer twin (interview path, openTurn pinned to 0) --------------
  describe("handleAnswer twin (aidlc-log answer)", () => {
    test("REFUSES to record an answer when presence is active but no marker exists", () => {
      const slug = field(proj, "Current Stage");
      writeTurnCounter(proj, 1); // presence active, no marker
      const r = guardedLog(proj, ["answer", "--stage", slug, "--details", "my answer"]);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("Refusing to record this answer");
      expect(questionAnsweredCount(proj)).toBe(0);
    });

    test("COMMITS + CONSUMES with one unconsumed marker", () => {
      const slug = field(proj, "Current Stage");
      writeTurnCounter(proj, 1);
      writeMarker(proj, 1, /* consumed */ false);
      const r = guardedLog(proj, ["answer", "--stage", slug, "--details", "my answer"]);
      expect(r.rc).toBe(0);
      expect(questionAnsweredCount(proj)).toBe(1);
      // CONSUME: a second answer this turn now refuses (marker spent).
      expect(markerConsumed(proj)).toBe(true);
      const r2 = guardedLog(proj, ["answer", "--stage", slug, "--details", "second answer"]);
      expect(r2.rc).not.toBe(0);
      expect(questionAnsweredCount(proj)).toBe(1);
    });
  });
});
