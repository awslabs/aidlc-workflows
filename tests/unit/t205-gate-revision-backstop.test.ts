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
// over one chronological interleave of six event types across every shard:
//   1. an anchor exists: the LAST ORGANIC (non-Recovered) STAGE_AWAITING_APPROVAL
//      for the slug, else the LAST STAGE_STARTED for it (report synthesizes a
//      Recovered=true gate row right before approve when the conductor skipped
//      gate-start; anchoring there would empty the window - scenario 9),
//   2. no GATE_REJECTED for the slug after that anchor (else the verb ran),
//   3. a HUMAN_TURN after the anchor (the human responded at the gate),
//   4. an ARTIFACT_CREATED/ARTIFACT_UPDATED to a declared produces file AFTER the
//      FIRST post-anchor HUMAN_TURN (the human-turn pivot excludes the reviewer's
//      pre-response `## Review` append - the critical false-positive guard).
// With the STAGE_STARTED fallback anchor, a produces write must ALSO precede the
// first post-anchor HUMAN_TURN (mid-stage coaching before any production is not
// a revision - scenario 10). Fail-open everywhere; codekb stages covered via
// producesArtifactFile's repo-scoped codekb arm (scenarios 12 and 13 - they
// were previously excluded outright, which left a revised reverse-engineering
// gate with Revision Count 0); off-switch AIDLC_SKIP_REVISION_BACKSTOP=1.
//
// This is a PROCESS-boundary test: it spawns the real dist tools (state, audit,
// orchestrate) and drives the real audit-logger hook over stdin, so the audit
// File shape, report dispatch, and event ordering match production. Env posture
// (mirrors t188): the artifact + human-presence guards stay bypassed (separate
// chokepoints these bare fixtures do not satisfy), and
// AIDLC_SKIP_REVISION_BACKSTOP is DELETED so the backstop itself is exercised
// (the suite sets it globally). Scenario 7 keeps it set to prove the off-switch.
//
// Source under test (dist/claude/.claude/):
//   tools/aidlc-state.ts handleApprove (backstop block), unrecordedRevisionSinceGateOpen,
//     producesArtifactFile;
//   tools/aidlc-orchestrate.ts handleReport (production approval dispatcher);
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
  DEFAULT_SPACE,
  resetAidlcEnv,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
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

// Drive the production report dispatcher with the same guard posture as
// guarded(). report resolves the current gated stage and shells out to approve.
function guardedReport(proj: string, args: string[]): { rc: number; out: string } {
  const env = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "1";
  delete env.AIDLC_SKIP_REVISION_BACKSTOP;
  const r = spawnSync(BUN, [ORCHESTRATE, "report", ...args, "--project-dir", proj], {
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

// Record a STAGE_STARTED for the slug via the real audit-append CLI - the same
// row the advance path emits when the stage run begins (the fallback anchor).
function recordStageStarted(proj: string, slug: string): void {
  const r = spawnSync(
    BUN,
    [AUDIT, "append", "STAGE_STARTED", "--field", `Stage=${slug}`, "--project-dir", proj],
    { encoding: "utf-8", env: process.env },
  );
  if ((r.status ?? -1) !== 0) {
    throw new Error(`recordStageStarted failed: ${r.stdout ?? ""}${r.stderr ?? ""}`);
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

// The unit fixture already seeds the production registry and active-intent
// cursor around the requested brownfield state. Rewriting its lone repos field,
// as t182 does, keeps this process-boundary test focused on report and approve;
// intent-birth would replace the fixture state and test an unrelated transaction.
function rewriteIntentRepos(proj: string, repos: string[]): void {
  const regPath = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents", "intents.json");
  const rows = JSON.parse(readFileSync(regPath, "utf-8")) as Array<Record<string, unknown>>;
  rows[0].repos = repos;
  writeFileSync(regPath, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
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

  // --- Scenario 8: NO anchor at all (the gate was opened via a bare checkbox
  // flip, and the fixture never emitted STAGE_STARTED either) -> the predicate
  // has no anchor -> false. Documents the accepted false negative: the backstop
  // only reconciles a revision it can anchor to a recorded gate-open OR a
  // recorded stage start.
  test("8: no recorded anchor at all - the accepted false negative, no backfill", () => {
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

  // --- Scenario 9: the COMMON shape of the bug (PR review finding). The
  // conductor skips gate-start AND reject: STAGE_STARTED; initial production
  // (ARTIFACT_CREATED); human requests changes (HUMAN_TURN); revision
  // (ARTIFACT_UPDATED); human approves (HUMAN_TURN); report auto-injects
  // `gate-start --recovered` right before approve. The synthesized Recovered
  // gate row postdates everything, so anchoring on it would empty the window;
  // the predicate must skip it and anchor on STAGE_STARTED -> backfill fires.
  test("9: no organic gate-start - the Recovered row is not the anchor, backfill fires", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    recordStageStarted(proj, slug); // the stage run's boundary (fallback anchor)
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT)); // initial production
    recordHumanTurn(proj); // human requests changes at the presented gate
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT)); // unrecorded revision
    recordHumanTurn(proj); // human approves
    // report's approve path on a [-] stage: gate-start --recovered, then approve.
    const gs = guarded(proj, ["gate-start", slug, "--recovered"]);
    expect(gs.rc).toBe(0);
    const r = guarded(proj, ["approve", slug, "--user-input", "looks good now"]);
    expect(r.rc).toBe(0);

    expect(field(proj, "Revision Count")).toBe("1");
    const blocks = auditBlocks(proj);
    const rejected = blocks.filter((b) => b.event === "GATE_REJECTED" && b.stage === slug);
    expect(rejected.length).toBe(1);
    expect(rejected[0].recovered).toBe(true);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(stateContent(proj)).toContain(`- [x] ${slug}`);
  });

  // --- Scenario 10: the guard the STAGE_STARTED fallback needs. Mid-stage
  // coaching: the human speaks BEFORE any production, the conductor then
  // produces the artifact once, and the human's input was direction - not a
  // revision request against produced work. No produces write precedes the
  // first post-anchor human turn -> no backfill.
  test("10: stage-start anchor without pre-human production is coaching, no backfill", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    recordStageStarted(proj, slug);
    recordHumanTurn(proj); // human coaches before anything was produced
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT)); // sole production
    const gs = guarded(proj, ["gate-start", slug, "--recovered"]);
    expect(gs.rc).toBe(0);
    const r = guarded(proj, ["approve", slug, "--user-input", "approved"]);
    expect(r.rc).toBe(0);
    expect(field(proj, "Revision Count")).toBe("0");
    expect(eventCount(proj, "GATE_REJECTED")).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
  });

  // --- Scenario 11: two audit shards - the chronological sort is load-bearing.
  // The scenario-9 ledger split across a MAIN shard and a lexically-EARLIER
  // clone shard holding the chronologically-LATER events: readAllAuditShards
  // concatenates in filename order, so a raw-position scan would misplace the
  // anchor; the (Timestamp, position) sort must reassemble the true order and
  // still fire the backfill.
  test("11: events split across two shards still anchor and backfill correctly", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    recordStageStarted(proj, slug);
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT));
    recordHumanTurn(proj);
    fireArtifact(proj, feasibilityArtifact(proj, PRIMARY_ARTIFACT));
    recordHumanTurn(proj);
    // Split the single seeded shard: move the tail (revision + approval turn)
    // into a clone shard whose filename sorts BEFORE the main shard ("0-" prefix
    // beats any hostname slug), so concatenation order inverts chronology and
    // only the (Timestamp, position) sort can fix it.
    const mainShard = seededAuditShard(proj);
    const cloneShard = join(seededAuditDir(proj), "0-aaa.md");
    const body = readFileSync(mainShard, "utf-8");
    const blocks = body.split("\n---\n");
    // Keep header + first events in main; last two event blocks go to the clone.
    const cut = blocks.length - 2;
    writeFileSync(mainShard, blocks.slice(0, cut).join("\n---\n"), "utf-8");
    writeFileSync(
      cloneShard,
      `# AI-DLC Audit Log\n\n---\n${blocks.slice(cut).join("\n---\n")}`,
      "utf-8",
    );

    const gs = guarded(proj, ["gate-start", slug, "--recovered"]);
    expect(gs.rc).toBe(0);
    const r = guarded(proj, ["approve", slug, "--user-input", "looks good now"]);
    expect(r.rc).toBe(0);
    expect(field(proj, "Revision Count")).toBe("1");
    expect(
      auditBlocks(proj).filter((b) => b.event === "GATE_REJECTED" && b.stage === slug).length,
    ).toBe(1);
  });

  // --- Scenario 12: the codekb stage (reverse-engineering). RE's produces live
  // under the SPACE codekb root
  // (aidlc/spaces/<space>/codekb/<repo>/<name>.md, no <slug> segment), which
  // previously (a) the audit-logger hook did not log at all and (b) the
  // backstop excluded outright - so a revised-then-approved RE gate left
  // Revision Count 0 with no GATE_REJECTED row. Bug flow on the RE gate:
  // gate-start; HUMAN_TURN (request changes); codekb ARTIFACT_UPDATED (the
  // conversational revision); HUMAN_TURN (approve); report -> approve ->
  // backfill. The repo-b write proves that any member of a multi-repo intent's
  // recorded set can supply the revision evidence.
  test("12: codekb revision in a multi-repo intent backfills through report", () => {
    // Re-seed with the brownfield fixture whose Current Stage is
    // reverse-engineering (the default seed's mid-ideation fixture has RE
    // outside its plan).
    cleanupTestProject(proj);
    proj = createTestProject();
    seedStateFile(proj, "state-brownfield-init-done.md");
    rewriteIntentRepos(proj, ["repo-a", "repo-b"]);
    const slug = field(proj, "Current Stage");
    expect(slug).toBe("reverse-engineering");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]); // anchor
    recordHumanTurn(proj); // human requests changes at the RE gate (the pivot)
    // The conductor revises a codekb artifact in place - the production path
    // shape: <proj>/aidlc/spaces/default/codekb/<repo>/architecture.md.
    fireArtifact(
      proj,
      join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", "repo-b", "architecture.md"),
    );
    recordHumanTurn(proj); // human approves
    const r = guardedReport(proj, [
      "--result",
      "approved",
      "--user-input",
      "looks good now",
    ]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain('"kind":"done"');

    expect(field(proj, "Revision Count")).toBe("1");
    const rejected = auditBlocks(proj).filter(
      (b) => b.event === "GATE_REJECTED" && b.stage === slug,
    );
    expect(rejected.length).toBe(1);
    expect(rejected[0].recovered).toBe(true);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    // The hook actually logged the codekb write (the other half of the fix).
    expect(eventCount(proj, "ARTIFACT_UPDATED")).toBeGreaterThanOrEqual(1);
  });

  // --- Scenario 13: codekb remains space-level and fully audited, but revision
  // recovery belongs only to the active intent's recorded repos. A repo-b write
  // cannot revise an intent scoped only to repo-a. Approval still proceeds
  // because the backstop adds only evidence it can prove.
  test("13: codekb revision outside the intent repo set is logged but not backfilled", () => {
    cleanupTestProject(proj);
    proj = createTestProject();
    seedStateFile(proj, "state-brownfield-init-done.md");
    rewriteIntentRepos(proj, ["repo-a"]);
    const slug = field(proj, "Current Stage");
    expect(slug).toBe("reverse-engineering");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    recordHumanTurn(proj);
    const revisionCountBefore = field(proj, "Revision Count");
    fireArtifact(
      proj,
      join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", "repo-b", "architecture.md"),
    );
    recordHumanTurn(proj);
    const r = guardedReport(proj, [
      "--result",
      "approved",
      "--user-input",
      "looks good now",
    ]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain('"kind":"done"');

    expect(field(proj, "Revision Count")).toBe(revisionCountBefore);
    expect(eventCount(proj, "GATE_REJECTED")).toBe(0);
    expect(eventCount(proj, "STAGE_REVISING")).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(eventCount(proj, "ARTIFACT_UPDATED")).toBeGreaterThanOrEqual(1);
  });
});
