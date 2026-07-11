// covers: audit:WORKFLOW_STARTED, audit:PHASE_STARTED, audit:STAGE_STARTED, audit:GATE_APPROVED, audit:STAGE_COMPLETED
//
// COVERAGE NOTE: this test UNCONDITIONALLY proves all five events above are
// present in a real run. WORKFLOW_STARTED and GATE_APPROVED are asserted present
// outright (the vacuous-pass guards, assertAuditEvent below); the co-fire loop
// then asserts WORKFLOW_STARTED's partners (PHASE_STARTED + STAGE_STARTED) and
// GATE_APPROVED's partner (STAGE_COMPLETED) — so each is proven present, not
// merely conditionally. WORKFLOW_COMPLETED / PHASE_COMPLETED are NOT claimed:
// their pair antecedent (PHASE_COMPLETED) is checked only IF present, so the
// claim would be conditional on an unguaranteed event — the co-fire INVARIANT
// still holds for them, but the coverage CLAIM stays honest to what is proven.
//
// t126-emitter-pairing-cofire.test.ts — METAMORPHIC INVARIANT (§5-D, Phase 4):
// emitter-pairing co-fire. Drive a REAL `/aidlc <scope>` workflow
// through the Claude Agent SDK (driveAidlc) and assert, as data over the audit
// log, that every audit event whose taxonomy declares a co-emission PARTNER has
// that partner present in the SAME run. {sdk} mechanism (no rendering — the
// property is cross-cutting audit data, not a rendered choice; per the
// driver-split invariant a whole-run property check is sdk).
//
// THE SPEC (read from source, NOT guessed):
//   The pairing taxonomy is the set of handler bodies that MUST co-emit, pinned
//   by tests/integration/t48-audit-event-emitters.sh:304-312 (the `check_pairing`
//   calls) — that is a STATIC source check (the literal appears in the handler
//   body). THIS test is its RUNTIME complement: the partners actually LAND in
//   audit.md across a real workflow. The handler→pair map verified at
//   t48:304-312 and aidlc-state.ts / aidlc-utility.ts:
//     handleApprove          (aidlc-state.ts:675)  -> GATE_APPROVED + STAGE_COMPLETED
//     handleCompleteWorkflow (aidlc-state.ts)       -> PHASE_COMPLETED + WORKFLOW_COMPLETED
//     handleInit             (aidlc-utility.ts)      -> WORKFLOW_STARTED + PHASE_STARTED + STAGE_STARTED
//   (handleReject -> GATE_REJECTED + STAGE_REVISING is exercised by t128, not
//   here: the driver approves every gate, so this golden-path run never rejects.)
//
//   We assert the RUNTIME pairing as a metamorphic invariant: for each pair, IF
//   the lead event fired THEN its partner(s) fired too, in the SAME run. This is
//   strictly stronger than "both events are in the taxonomy" — it proves the
//   atomic co-emission the audit trail's integrity depends on actually held over
//   a live run, not just that the literals coexist in a handler.
//
// WHY THE GOLDEN PATH HERE (and not in t128): this invariant is about the
// APPROVE/INIT/COMPLETE pairs, all of which fire on the golden path. The SDK
// driver answers every approval gate with "Approve" (its default answerScript),
// so a single drive reaches WORKFLOW_COMPLETED, exercising handleInit +
// handleApprove (per stage) + handleCompleteWorkflow — all three pair-emitting
// handlers — deterministically.
//
// THE SCOPE: `poc` — a Minimal greenfield scope (scope-mapping.json "poc") whose
// EXECUTE set is small (init×3 + reverse-engineering[->SKIP on greenfield] +
// requirements-analysis + code-generation + build-and-test) so the run reaches
// terminal WORKFLOW_COMPLETED within a generous budget while still crossing >=1
// phase boundary (Ideation present for poc, unlike bugfix) — exercising
// handleCompleteWorkflow's PHASE_COMPLETED + WORKFLOW_COMPLETED pair.
//
// IRON RULE: a missing partner is a real audit-integrity DEFECT (the trail would
// lie about an atomic transition), never softened. If the lead event never fired
// at all the test fails LOUD (vacuous-pass guard below) rather than passing on an
// empty antecedent.
//
// It SPENDS TOKENS: driveAidlc runs the real workflow on Opus/Bedrock.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertAuditEvent, assertResultOk } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { auditFilePathFor, driveAidlc } from "../harness/sdk-drive.ts";

// Timeout budget. A full `/aidlc poc` is a multi-turn workflow on
// Opus/Bedrock. Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds). The
// timer is a WEDGE-BACKSTOP, not a budget — the pass condition is the on-disk
// WORKFLOW_COMPLETED pair, never the clock. The drive aborts a hair before bun
// kills the test so a stuck run surfaces a partial DriveResult to diagnose.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

/** Seed the workflow through the same project-local utility the slash command
 * delegates to. This keeps the live SDK run focused on the co-fire golden path
 * instead of spending turns recovering from an intentionally absent state file. */
function seedPocState(proj: string): void {
  const utility = join(proj, ".claude", "tools", "aidlc-utility.ts");
  const res = spawnSync(
    process.execPath,
    [utility, "intent-birth", "--scope", "poc", "--project-dir", proj],
    { cwd: proj, encoding: "utf8" },
  );
  expect(res.status).toBe(0);
  expect(`${res.stdout}\n${res.stderr}`).toContain("State initialized");
}

/**
 * The co-emission pairs, derived from the t48 check_pairing source spec
 * (t48:304-312). Each entry: a `lead` event and the `partners` that the SAME
 * handler emits in the same body — so over a real run, if `lead` is present in
 * audit.md, every `partner` MUST be too. Only the pairs reachable on a
 * golden path are asserted here (reject/revise -> t128).
 */
const COFIRE_PAIRS: Array<{ lead: string; partners: string[]; handler: string }> = [
  // handleApprove (aidlc-state.ts:675): a gate approval and the stage completion
  // it triggers are emitted atomically. (t48:304)
  { lead: "GATE_APPROVED", partners: ["STAGE_COMPLETED"], handler: "handleApprove" },
  // handleInit (aidlc-utility.ts): workflow start brings phase start + the first
  // stage start. (t48:312)
  {
    lead: "WORKFLOW_STARTED",
    partners: ["PHASE_STARTED", "STAGE_STARTED"],
    handler: "handleInit",
  },
  // handleCompleteWorkflow (aidlc-state.ts:520,580-585): the final phase
  // completion co-fires with the phase-verification AND the workflow completion.
  // Pinned by t48:309 (`check_pairing handleCompleteWorkflow ... PHASE_COMPLETED
  // PHASE_VERIFIED WORKFLOW_COMPLETED`). PHASE_VERIFIED is UNCONDITIONAL on this
  // path: aidlc-state.ts:585 emits it with no branch immediately after
  // PHASE_COMPLETED (:580) — so it is a hard co-emission partner, not advisory.
  // (The audit-format.md ✓-vs-blank flag marks doc-level "mandatory to assert in
  // t48", a DIFFERENT axis from whether the handler always emits it; the handler
  // always does, so the runtime co-fire MUST hold.)
  {
    lead: "PHASE_COMPLETED",
    partners: ["PHASE_VERIFIED", "WORKFLOW_COMPLETED"],
    handler: "handleCompleteWorkflow",
  },
];

/** Read the ordered audit event-type list straight off audit.md (the same parse
 *  driveAidlc does into r.auditEvents, re-read here for an independent count). */
function auditEventsOnDisk(proj: string): string[] {
  const p = auditFilePathFor(proj);
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf8");
  const events: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\*\*Event\*\*:\s*(\S+)/);
    if (m) events.push(m[1]);
  }
  return events;
}

describe("t126 emitter-pairing co-fire (metamorphic invariant, sdk)", () => {
  test(
    "every paired audit event whose lead fired has its partner(s) in the same run",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        seedPocState(proj);

        const r = await driveAidlc("/aidlc poc", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
        });

        // The run must have terminated cleanly (structured SDK result, not an
        // exit-code guess). A timeout/crash would make the pairing check vacuous.
        assertResultOk(r);

        const events = auditEventsOnDisk(proj);
        const present = new Set(events);

        // VACUOUS-PASS GUARD: every pair LEAD this test claims to exercise MUST
        // have fired, or that pair's co-fire check is a silent no-op (the
        // empty-antecedent trap). A completed `/aidlc poc` guarantees
        // all three: init emits WORKFLOW_STARTED; each auto-approved gate emits
        // GATE_APPROVED; and poc spans Ideation→Inception→Construction so the
        // terminal handleCompleteWorkflow emits PHASE_COMPLETED (aidlc-state.ts:580
        // — also fired at every phase boundary, :418). Guarding PHASE_COMPLETED
        // here is what makes the handleCompleteWorkflow pair (PHASE_VERIFIED +
        // WORKFLOW_COMPLETED) a REAL assertion rather than a conditional skip.
        assertAuditEvent(r, "WORKFLOW_STARTED");
        assertAuditEvent(r, "GATE_APPROVED");
        assertAuditEvent(r, "PHASE_COMPLETED");
        expect(events.length).toBeGreaterThan(5);

        // THE METAMORPHIC INVARIANT: lead present => all partners present.
        const violations: string[] = [];
        for (const { lead, partners, handler } of COFIRE_PAIRS) {
          if (!present.has(lead)) continue; // antecedent absent — nothing to check
          for (const partner of partners) {
            if (!present.has(partner)) {
              violations.push(
                `${handler}: ${lead} fired but partner ${partner} did NOT (co-emission broken)`,
              );
            }
          }
        }
        expect(violations).toEqual([]);

        // EVERY pair's antecedent must have been present, so NO pair's co-fire
        // check was a silent no-op. All three leads (WORKFLOW_STARTED,
        // GATE_APPROVED, PHASE_COMPLETED) are guarded above for the poc golden
        // path, so this holds — pinned explicitly so a future taxonomy edit that
        // adds an unreachable lead can't silently make a pair vacuous.
        const unfiredLeads = COFIRE_PAIRS.filter((p) => !present.has(p.lead)).map(
          (p) => p.lead,
        );
        expect(unfiredLeads).toEqual([]);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
