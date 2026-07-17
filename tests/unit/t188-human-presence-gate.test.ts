// covers: cli:aidlc-state(approve,gate-start), cli:aidlc-log(answer), cli:aidlc-audit(append), function:handleApprove, function:handleGateStart, function:handleAnswer, function:humanActedSinceGate, function:humanActedSinceLastAnswer, function:hasOpenGate, function:isAutonomousMode, function:humanPresenceGuardDisabled, file:hooks/aidlc-mint-presence.ts
//
// t188 - human-presence approval gate (ledger-event design).
//
// Mechanism: cli. The subject is the deterministic human-presence guard the
// state tool runs on the approve path (and the log tool on the interview-answer
// path) AFTER the artifact guard and BEFORE any state mutation. It refuses to
// commit a gate unless a real human acted at THIS gate since the last gate
// resolution, where "a human acted" is proven by a HUMAN_TURN event in the audit
// shard (the state machine's own append-only ledger). The guard reads the
// per-clone audit shard the resolved pd points at, so this is a PROCESS boundary
// exercised by spawning the real dist tools (spawnSync(BUN, [STATE|LOG, ...])).
//
// The ledger contract (no marker file, no turn counter, no consumed flag):
//   - a real human prompt appends a HUMAN_TURN event (the per-harness mint hook).
//   - the gate allows iff a HUMAN_TURN appears AFTER the last gate resolution
//     (GATE_APPROVED / GATE_REJECTED / QUESTION_ANSWERED) IN LEDGER APPEND ORDER.
//   - cascade-safety + freshness both fall out of order: a second gate
//     auto-cascaded in the same human turn opens AFTER the GATE_APPROVED that just
//     committed (so no HUMAN_TURN follows it -> refused); a stale human turn
//     precedes the last resolution (-> refused).
//   - fail-open when the ledger has NO events at all (presence not tracked yet).
//
// CRITICAL test-harness note: run-tests.ts sets AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1
// for the whole suite (so the ~81 approve/advance tests keep passing). This test
// re-enables enforcement by DELETING that var from the spawned tool's env -
// otherwise it would be testing the bypass, not the guard. It KEEPS
// AIDLC_SKIP_ARTIFACT_GUARD=1 set, because the artifact guard is a separate
// chokepoint these bare fixtures do not satisfy; this test isolates the presence
// guard.
//
// Source under test (dist/claude/.claude/tools/):
//   aidlc-state.ts handleApprove (presence check, then GATE_APPROVED is the next
//     gate's freshness boundary - no separate consume step),
//   aidlc-log.ts handleAnswer (the interview-path twin),
//   aidlc-audit.ts append (records the HUMAN_TURN event the mint hook emits).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const AUDIT = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const MID_IDEATION = "state-mid-ideation.md"; // Current Stage: feasibility

// Drive a state subcommand with the PRESENCE guard ENABLED (clear the suite's
// presence-bypass var) but the ARTIFACT guard still bypassed (a separate
// chokepoint these bare fixtures don't satisfy). Returns exit code + output.
function guarded(proj: string, args: string[]): { rc: number; out: string } {
  const env = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
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

// Record a HUMAN_TURN event via the real audit-append CLI (exactly what the
// per-harness mint hook does on a real human prompt). This appends to the
// active-intent shard the gate later reads, in real ledger order.
function recordHumanTurn(proj: string): void {
  const r = spawnSync(BUN, [AUDIT, "append", "HUMAN_TURN", "--project-dir", proj], {
    encoding: "utf-8",
    env: process.env,
  });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`recordHumanTurn failed: ${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
}

function field(proj: string, name: string): string {
  return guarded(proj, ["get", name]).out.trim();
}

// Count audit blocks with `**Event**: <ev>` in the merged shard buffer.
function eventCount(proj: string, ev: string): number {
  const body = readAllAuditShards(proj);
  return body
    .split("\n")
    .filter((l) => l === `**Event**: ${ev}`).length;
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

describe("t188: human-presence approval gate (ledger-event design)", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION); // Current Stage: feasibility
  });

  afterEach(() => cleanupTestProject(proj));

  // --- Scenario A: FABRICATION (no human turn) -------------------------------
  //
  // Gate open (slug awaiting-approval, STAGE_AWAITING_APPROVAL recorded), the
  // ledger HAS events (presence tracking active) but NO HUMAN_TURN at all - a
  // model under autopilot fabricating an approval. The gate must REFUSE and emit
  // no GATE_APPROVED.
  test("A: approve REFUSES when the ledger has events but no HUMAN_TURN", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]); // STAGE_AWAITING_APPROVAL recorded (ledger non-empty)
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to approve");
    expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
    // State untouched: the stage is NOT marked completed.
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  // --- Scenario B: LEGIT (human turn after gate-open) ------------------------
  //
  // The realistic flow: the human types (HUMAN_TURN), then the agent opens the
  // gate and approves it. A HUMAN_TURN exists after the last resolution (none
  // yet) -> approve COMMITS, exactly one GATE_APPROVED.
  test("B: approve COMMITS when a HUMAN_TURN was recorded this turn", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    recordHumanTurn(proj); // the human typed a prompt
    guarded(proj, ["gate-start", slug]); // agent opens the gate (same turn)
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    // Auto-advanced off feasibility.
    expect(field(proj, "Current Stage")).not.toBe(slug);
  });

  // --- Scenario C: CASCADE (load-bearing) ------------------------------------
  //
  // One HUMAN_TURN, two sequential gates in the SAME human turn. The first
  // approve commits (and emits GATE_APPROVED, the freshness boundary). When the
  // reentrant advance opens a SECOND gate this turn and the model tries to
  // approve it with NO new HUMAN_TURN, the gate REFUSES - because the last
  // HUMAN_TURN now precedes the first gate's GATE_APPROVED. Proves cascade-safety
  // falls out of ledger order with no consumed flag.
  test("C: a single HUMAN_TURN approves ONE gate; a second gate this turn REFUSES", () => {
    const slug1 = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug1}=in-progress`]);
    recordHumanTurn(proj);
    guarded(proj, ["gate-start", slug1]);

    // First gate this turn: commits.
    const r1 = guarded(proj, ["approve", slug1, "--user-input", "ok"]);
    expect(r1.rc).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);

    // Second gate, SAME turn (no new HUMAN_TURN): the auto-advanced stage is now
    // Current Stage. Open its gate and try to approve - the last HUMAN_TURN is
    // now before the first GATE_APPROVED, so this refuses.
    const slug2 = field(proj, "Current Stage");
    expect(slug2).not.toBe(slug1);
    guarded(proj, ["checkbox", `${slug2}=in-progress`]);
    guarded(proj, ["gate-start", slug2]);
    const r2 = guarded(proj, ["approve", slug2, "--user-input", "ok"]);
    expect(r2.rc).not.toBe(0);
    expect(r2.out).toContain("Refusing to approve");
    // Still exactly ONE commit across the whole turn.
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(field(proj, "Current Stage")).toBe(slug2);
  });

  // --- Scenario C2: a NEW human turn authorizes the second gate --------------
  test("C2: a fresh HUMAN_TURN after the first commit approves the second gate", () => {
    const slug1 = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug1}=in-progress`]);
    recordHumanTurn(proj);
    guarded(proj, ["gate-start", slug1]);
    expect(guarded(proj, ["approve", slug1, "--user-input", "ok"]).rc).toBe(0);

    const slug2 = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug2}=in-progress`]);
    guarded(proj, ["gate-start", slug2]);
    recordHumanTurn(proj); // the human acts again
    const r2 = guarded(proj, ["approve", slug2, "--user-input", "ok"]);
    expect(r2.rc).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(2);
  });

  // --- Scenario D: AUTONOMY carve-out ----------------------------------------
  //
  // state has `Construction Autonomy Mode: autonomous` -> approve COMMITS with NO
  // HUMAN_TURN (swarm/Bolt has no human at the gate). The ledger is non-empty, so
  // the pass is the autonomy carve-out, not the fail-open-empty-ledger path.
  test("D: autonomous Construction approves with NO HUMAN_TURN (carve-out)", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    setAutonomous(proj);
    guarded(proj, ["gate-start", slug]); // ledger non-empty, but no HUMAN_TURN
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(field(proj, "Current Stage")).not.toBe(slug);
  });

  // --- Scenario E: STALE human turn ------------------------------------------
  //
  // A HUMAN_TURN exists but was already spent on a prior gate (its GATE_APPROVED
  // is AFTER the human turn), then a new gate opens with no fresh turn -> REFUSE.
  test("E: a HUMAN_TURN already spent on a prior gate is STALE -> REFUSE", () => {
    const slug1 = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug1}=in-progress`]);
    recordHumanTurn(proj);
    guarded(proj, ["gate-start", slug1]);
    expect(guarded(proj, ["approve", slug1, "--user-input", "ok"]).rc).toBe(0); // spends the turn

    // New gate, NO fresh HUMAN_TURN - the prior GATE_APPROVED is after the only turn.
    const slug2 = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug2}=in-progress`]);
    guarded(proj, ["gate-start", slug2]);
    const r = guarded(proj, ["approve", slug2, "--user-input", "ok"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to approve");
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(field(proj, "Current Stage")).toBe(slug2);
  });

  // --- Scenario F: fail-open when the ledger has no events -------------------
  //
  // humanActedSinceGate fails OPEN on an empty ledger (a harness/clone whose shard
  // has no events yet) so the gate never bricks before any event is recorded.
  // Asserted directly on the helper: the approve PATH can't reach this state (it
  // requires a gate-start, which itself writes STAGE_AWAITING_APPROVAL), so the
  // empty-ledger fallback is a guarantee of the predicate, exercised here in-process.
  test("F: humanActedSinceGate fails OPEN on an empty ledger", async () => {
    const { humanActedSinceGate } = await import(
      "../../dist/claude/.claude/tools/aidlc-lib.ts"
    );
    // proj here has a seeded state file but no audit shard (no event emitted yet).
    expect(humanActedSinceGate(proj)).toBe(true);
  });

  // --- Scenario G: multi-shard chronological ordering -------------------------
  //
  // readAllAuditShards concatenates per-clone shards in FILENAME order, which is
  // NOT time order (a second shard appears after a re-clone or on another
  // machine). The predicate must order by Timestamp, not buffer position: an OLD
  // resolution living in a lexically-LATER shard must not outrank a fresh
  // HUMAN_TURN in the current shard.
  test("G: an old resolution in a lexically-later shard does not mask a fresh HUMAN_TURN", async () => {
    const { humanActedSinceGate, auditShardDir } = await import(
      "../../dist/claude/.claude/tools/aidlc-lib.ts"
    );
    // Fresh HUMAN_TURN lands in this clone's shard via the real appender.
    recordHumanTurn(proj);
    // Simulate a prior clone's committed shard whose filename sorts AFTER the
    // current shard (zzz- prefix) but whose events are OLDER.
    const dir = auditShardDir(proj);
    if (dir === null) throw new Error("no audit shard dir resolved");
    writeFileSync(
      join(dir, "zzz-oldclone.md"),
      "# AI-DLC Audit Log\n\n## Gate Approved\n**Timestamp**: 2020-01-01T00:00:00Z\n**Event**: GATE_APPROVED\n**Stage**: feasibility\n\n---\n",
      "utf-8",
    );
    expect(humanActedSinceGate(proj)).toBe(true);
  });

  // --- hasOpenGate (the preToolUse floors' gate-open predicate) ---------------
  //
  // The per-harness preToolUse floors must refuse ONLY while a stage actually
  // sits at [?]: after a legitimate approval the last resolution follows the
  // turn's HUMAN_TURN, and without this predicate the floor would block the
  // mandated same-turn continuation into the next stage.
  describe("hasOpenGate (state-file [?] predicate for the preToolUse floors)", () => {
    test("false with no state / no [?]; true once a stage awaits approval", async () => {
      const { hasOpenGate } = await import(
        "../../dist/claude/.claude/tools/aidlc-lib.ts"
      );
      expect(hasOpenGate(null)).toBe(false);
      const before = readFileSync(seededStateFile(proj), "utf-8");
      expect(hasOpenGate(before)).toBe(false); // fixture has no [?] stage
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);
      const open = readFileSync(seededStateFile(proj), "utf-8");
      expect(hasOpenGate(open)).toBe(true);
      // Approving closes it again: the floor stops firing post-approval.
      recordHumanTurn(proj);
      expect(guarded(proj, ["approve", slug, "--user-input", "ok"]).rc).toBe(0);
      const after = readFileSync(seededStateFile(proj), "utf-8");
      expect(hasOpenGate(after)).toBe(false);
    });
  });

  // --- handleAnswer twin (interview path) ------------------------------------
  describe("handleAnswer twin (aidlc-log answer)", () => {
    test("REFUSES to record an answer when the ledger has events but no HUMAN_TURN", () => {
      const slug = field(proj, "Current Stage");
      guarded(proj, ["gate-start", slug]); // ledger non-empty, no HUMAN_TURN
      const r = guardedLog(proj, ["answer", "--stage", slug, "--details", "my answer"]);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("Refusing to record this answer");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);
    });

    test("COMMITS with a HUMAN_TURN, then a second answer this turn REFUSES", () => {
      const slug = field(proj, "Current Stage");
      recordHumanTurn(proj);
      const r = guardedLog(proj, ["answer", "--stage", slug, "--details", "my answer"]);
      expect(r.rc).toBe(0);
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(1);
      // The QUESTION_ANSWERED is the new boundary: a second answer with no fresh
      // HUMAN_TURN refuses (one answer per human turn).
      const r2 = guardedLog(proj, ["answer", "--stage", slug, "--details", "second answer"]);
      expect(r2.rc).not.toBe(0);
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(1);
    });
  });
});
