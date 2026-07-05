// covers: subcommand:aidlc-state:approve, function:unrecordedRevisionSinceGateOpen, function:producesArtifactFile
//
// t205 - approve-time gate-revision backstop (the reconciliation half of the
// forwarding-reliability gap). Mechanism: cli. The subject is the deterministic
// backstop the state tool runs on the approve path AFTER the artifact +
// human-presence guards and BEFORE any state mutation. When the conductor
// revises a stage's artifact at an OPEN gate but skips the `reject` verb, the
// on-disk state under-records the revision (Revision Count stays 0, no
// GATE_REJECTED/STAGE_REVISING pair). This backstop reconciles that at approve
// time: if the ledger proves an unrecorded revision, approve backfills the
// GATE_REJECTED + STAGE_REVISING pair (tagged Recovered=true) + a re-entry
// STAGE_AWAITING_APPROVAL, bumps Revision Count, then completes the approval
// normally - reconciliation, never refusal.
//
// The predicate (unrecordedRevisionSinceGateOpen), all four conjuncts required,
// over one chronological interleave of five event types across every shard:
//   1. a STAGE_AWAITING_APPROVAL for the slug is open (anchor = the LAST one),
//   2. no GATE_REJECTED for the slug after that anchor (else the verb ran),
//   3. a HUMAN_TURN after the anchor (the human responded at the gate),
//   4. an ARTIFACT_CREATED/ARTIFACT_UPDATED to a declared produces file AFTER the
//      FIRST post-anchor HUMAN_TURN (the human-turn pivot excludes the reviewer's
//      pre-response `## Review` append - the critical false-positive guard).
// Fail-open everywhere; codekb stages excluded; off-switch
// AIDLC_SKIP_REVISION_BACKSTOP=1.
//
// This is a PROCESS-boundary test: it spawns the real dist tools (state, audit)
// and drives the real audit-logger hook over stdin, so the audit File shape and
// event ordering match production. Env posture (mirrors t188): the artifact +
// human-presence guards stay bypassed (separate chokepoints these bare fixtures
// do not satisfy), and AIDLC_SKIP_REVISION_BACKSTOP is DELETED so the backstop
// itself is exercised (the suite sets it globally). Scenario 7 keeps it set to
// prove the off-switch.
//
// Source under test (dist/claude/.claude/):
//   tools/aidlc-state.ts handleApprove (backstop block), unrecordedRevisionSinceGateOpen,
//     producesArtifactFile;
//   hooks/aidlc-audit-logger.ts (emits ARTIFACT_UPDATED with the production File shape);
//   tools/aidlc-audit.ts append (records the HUMAN_TURN event).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const AUDIT = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-audit-logger.ts");
const MID_IDEATION = "state-mid-ideation.md"; // Current Stage: feasibility ([-])
// feasibility declares produces: feasibility-assessment, constraint-register, ...
const PRIMARY_ARTIFACT = "feasibility-assessment";

// Drive a state subcommand with the artifact + presence guards bypassed (bare
// fixtures don't satisfy them) but the REVISION BACKSTOP enabled (delete the
// suite's global skip). Returns exit code + merged output.
function guarded(proj: string, args: string[]): { rc: number; out: string } {
  const env = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "1";
  delete env.AIDLC_SKIP_REVISION_BACKSTOP;
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Same posture but with the backstop OFF-SWITCH set (scenario 7).
function guardedNoBackstop(proj: string, args: string[]): { rc: number; out: string } {
  const env = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "1";
  env.AIDLC_SKIP_REVISION_BACKSTOP = "1";
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Record a HUMAN_TURN via the real audit-append CLI (what the per-harness mint
// hook does on a real prompt) - appends to the active-intent shard in ledger order.
function recordHumanTurn(proj: string): void {
  const r = spawnSync(BUN, [AUDIT, "append", "HUMAN_TURN", "--project-dir", proj], {
    encoding: "utf-8",
    env: process.env,
  });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`recordHumanTurn failed: ${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
}

// Fire the real audit-logger hook with an Edit PostToolUse over stdin (Edit
// always emits ARTIFACT_UPDATED - aidlc-audit-logger.ts). The File is an
// absolute path under the active-intent record, matching production. The shard
// must already exist (the hook never auto-creates the trail), so a prior audit
// event (gate-start or a HUMAN_TURN append) must have run first.
function fireArtifact(proj: string, absFile: string): void {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj };
  const json = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: absFile } });
  spawnSync(BUN, [HOOK], { input: json, encoding: "utf-8", env });
}

// Absolute path of a stage artifact under the seeded record:
// <record>/ideation/feasibility/<name>.md.
function feasibilityArtifact(proj: string, name: string): string {
  return join(seededRecordDir(proj), "ideation", "feasibility", `${name}.md`);
}

function field(proj: string, name: string): string {
  return guarded(proj, ["get", name]).out.trim();
}

// Count audit blocks with `**Event**: <ev>` in the merged shard buffer.
function eventCount(proj: string, ev: string): number {
  return readAllAuditShards(proj)
    .split("\n")
    .filter((l) => l === `**Event**: ${ev}`).length;
}

// Ordered list of audit blocks (chronological append order in the single seeded
// shard), each with its event name, Stage, and whether Recovered=true.
interface AuditBlock {
  event: string;
  stage: string | null;
  recovered: boolean;
}
function auditBlocks(proj: string): AuditBlock[] {
  const body = readAllAuditShards(proj).replace(/\r\n/g, "\n");
  const out: AuditBlock[] = [];
  for (const block of body.split(/\n---\n/)) {
    const evMatch = block.match(/^\*\*Event\*\*: (.+)$/m);
    if (!evMatch) continue;
    out.push({
      event: evMatch[1].trim(),
      stage: block.match(/^\*\*Stage\*\*: (.+)$/m)?.[1].trim() ?? null,
      recovered: /^\*\*Recovered\*\*: true$/m.test(block),
    });
  }
  return out;
}

// Read the seeded state file content (checkbox assertions).
function stateContent(proj: string): string {
  return readFileSync(seededStateFile(proj), "utf-8");
}

// Append `Construction Autonomy Mode: autonomous` to the seeded state (setField
// is a no-op for an absent field, so write the line directly - mirrors t188).
function setAutonomous(proj: string): void {
  const sf = seededStateFile(proj);
  writeFileSync(sf, `${readFileSync(sf, "utf-8")}\n- **Construction Autonomy Mode**: autonomous\n`, "utf-8");
}

let proj: string;

describe("t205: approve-time gate-revision backstop", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION); // Current Stage: feasibility, [-]
  });

  afterEach(() => cleanupTestProject(proj));

  // --- Scenario 1: the bug flow - revision at an open gate, no reject recorded.
  // gate-start; HUMAN_TURN; ARTIFACT_UPDATED on a produces file; HUMAN_TURN;
  // approve -> the backstop backfills GATE_REJECTED + STAGE_REVISING (Recovered
  // true, Revision Count 1), then GATE_APPROVED + STAGE_COMPLETED. The event
  // order proves the backfill sits between the original gate-open and the approve.
  test("1: backfills the missing reject pair at approve when a revision went unrecorded", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]); // anchor: STAGE_AWAITING_APPROVAL
    recordHumanTurn(proj); // human responds at the gate (the pivot)
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT)); // revised in place
    recordHumanTurn(proj); // human approves this turn

    const r = guarded(proj, ["approve", slug, "--user-input", "looks good now"]);
    expect(r.rc).toBe(0);

    // Revision Count reflects the revision even though the conductor skipped reject.
    expect(field(proj, "Revision Count")).toBe("1");

    const blocks = auditBlocks(proj);
    const rejected = blocks.filter((b) => b.event === "GATE_REJECTED" && b.stage === slug);
    const revising = blocks.filter((b) => b.event === "STAGE_REVISING" && b.stage === slug);
    expect(rejected.length).toBe(1);
    expect(rejected[0].recovered).toBe(true);
    expect(revising.length).toBe(1);
    expect(revising[0].recovered).toBe(true);
    // The approval still commits.
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(eventCount(proj, "STAGE_COMPLETED")).toBeGreaterThanOrEqual(1);
    // Stage marked complete.
    expect(stateContent(proj)).toContain(`- [x] ${slug}`);

    // Event order: original gate-open < backfilled reject < backfilled re-entry
    // < approval.
    const anchorIdx = blocks.findIndex(
      (b) => b.event === "STAGE_AWAITING_APPROVAL" && b.stage === slug && !b.recovered,
    );
    const rejIdx = blocks.findIndex(
      (b) => b.event === "GATE_REJECTED" && b.stage === slug && b.recovered,
    );
    const reentryIdx = blocks.findIndex(
      (b) => b.event === "STAGE_AWAITING_APPROVAL" && b.stage === slug && b.recovered,
    );
    const approvedIdx = blocks.findIndex((b) => b.event === "GATE_APPROVED" && b.stage === slug);
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(anchorIdx).toBeLessThan(rejIdx);
    expect(rejIdx).toBeLessThan(reentryIdx);
    expect(reentryIdx).toBeLessThan(approvedIdx);
  });

  // --- Scenario 2: a clean single-pass approval - no artifact revised at the
  // gate -> conjunct 4 fails -> no backfill, Revision Count stays 0.
  test("2: clean single-pass approval does not backfill", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    recordHumanTurn(proj);
    const r = guarded(proj, ["approve", slug, "--user-input", "approved"]);
    expect(r.rc).toBe(0);
    expect(field(proj, "Revision Count")).toBe("0");
    expect(eventCount(proj, "GATE_REJECTED")).toBe(0);
    expect(eventCount(proj, "STAGE_REVISING")).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
  });

  // --- Scenario 3: THE critical false-positive guard. The reviewer appends its
  // `## Review` to the PRIMARY artifact BEFORE the human responds at the gate,
  // firing an ARTIFACT_UPDATED. Because that write precedes the first post-anchor
  // HUMAN_TURN, conjunct 4 (artifact AFTER the first human turn) fails -> NO
  // backfill. Without the human-turn pivot this would be a spurious reject.
  test("3: reviewer append before the human turn is NOT mistaken for a revision", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]); // anchor
    // Reviewer edits the primary artifact BEFORE any human turn.
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT));
    recordHumanTurn(proj); // human responds AFTER the reviewer append
    const r = guarded(proj, ["approve", slug, "--user-input", "approved"]);
    expect(r.rc).toBe(0);
    expect(field(proj, "Revision Count")).toBe("0");
    expect(eventCount(proj, "GATE_REJECTED")).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
  });

  // --- Scenario 4: a properly recorded reject cycle - the backstop must not pile
  // a spurious second (Recovered) reject on top. gate-start; HUMAN_TURN; revise
  // artifact; reject (count -> 1); revise (re-enter gate); HUMAN_TURN; approve.
  // At approve the anchor is the revise re-entry, no artifact was written after
  // it -> no backfill, count stays 1 from the real reject.
  test("4: a recorded reject flow is not double-counted by the backstop", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    recordHumanTurn(proj);
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT));
    // The human requests changes AND the conductor runs the verb this time.
    const rej = guarded(proj, ["reject", slug, "--feedback", "tighten the risk register"]);
    expect(rej.rc).toBe(0);
    expect(field(proj, "Revision Count")).toBe("1");
    guarded(proj, ["revise", slug]); // re-enter the gate (new anchor)
    recordHumanTurn(proj);
    const r = guarded(proj, ["approve", slug, "--user-input", "approved"]);
    expect(r.rc).toBe(0);
    // Count unchanged (no backfill), and no Recovered reject was added.
    expect(field(proj, "Revision Count")).toBe("1");
    const recoveredRejects = auditBlocks(proj).filter(
      (b) => b.event === "GATE_REJECTED" && b.recovered,
    );
    expect(recoveredRejects.length).toBe(0);
    expect(eventCount(proj, "GATE_REJECTED")).toBe(1); // the one real reject only
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
  });

  // --- Scenario 5: a write to a NON-produces file (memory.md) in the window does
  // not count - producesArtifactFile is false -> no backfill.
  test("5: a non-produces file write in the window does not backfill", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    recordHumanTurn(proj);
    // A memory.md write under the record - logged as ARTIFACT_UPDATED, but not a
    // declared produces artifact.
    fireArtifact(proj, join(seededRecordDir(proj), "memory.md"));
    const r = guarded(proj, ["approve", slug, "--user-input", "approved"]);
    expect(r.rc).toBe(0);
    expect(field(proj, "Revision Count")).toBe("0");
    expect(eventCount(proj, "GATE_REJECTED")).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
  });

  // --- Scenario 6: autonomous Construction (no human at the gate) - the backstop
  // is skipped even when the ledger shape would otherwise match.
  test("6: autonomous mode skips the backstop", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    setAutonomous(proj);
    guarded(proj, ["gate-start", slug]);
    recordHumanTurn(proj);
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT));
    const r = guarded(proj, ["approve", slug, "--user-input", "approved"]);
    expect(r.rc).toBe(0);
    expect(field(proj, "Revision Count")).toBe("0");
    expect(eventCount(proj, "GATE_REJECTED")).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
  });

  // --- Scenario 7: the off-switch - AIDLC_SKIP_REVISION_BACKSTOP=1 disables the
  // backfill even on the bug-flow ledger.
  test("7: AIDLC_SKIP_REVISION_BACKSTOP=1 disables the backstop", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    recordHumanTurn(proj);
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT));
    recordHumanTurn(proj);
    const r = guardedNoBackstop(proj, ["approve", slug, "--user-input", "approved"]);
    expect(r.rc).toBe(0);
    expect(field(proj, "Revision Count")).toBe("0");
    expect(eventCount(proj, "GATE_REJECTED")).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
  });

  // --- Scenario 8: no gate-open anchor recorded (the gate was opened via a bare
  // checkbox flip, so no STAGE_AWAITING_APPROVAL event exists) -> the predicate
  // has no anchor -> false. Documents the accepted false negative: the backstop
  // only reconciles a revision it can anchor to a recorded open gate.
  test("8: no recorded gate-open anchor - the accepted false negative, no backfill", () => {
    const slug = field(proj, "Current Stage");
    // Open the gate by flipping the checkbox directly (checkbox emits NO audit
    // event, so there is no STAGE_AWAITING_APPROVAL anchor in the ledger).
    guarded(proj, ["checkbox", `${slug}=awaiting-approval`]);
    recordHumanTurn(proj); // creates the shard + the post-... turn
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT));
    const r = guarded(proj, ["approve", slug, "--user-input", "approved"]);
    expect(r.rc).toBe(0);
    expect(field(proj, "Revision Count")).toBe("0");
    expect(eventCount(proj, "GATE_REJECTED")).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
  });
});
