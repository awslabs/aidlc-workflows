// covers: subcommand:aidlc-jump:execute
//
// t25.test.ts - drives the real `/aidlc --phase ideation` through the Claude
// Agent SDK from a CONSTRUCTION-phase state and asserts ONLY on deterministic
// surfaces (the engine calls the agent made, the state file and parsed audit
// events as the jump left them, verbatim audit-file bytes) - NEVER on
// assistantText.
//
// THE JOURNEY (verified against the SHIPPED tool, not guessed). The seeded
// fixture (state-construction.md) sits at Lifecycle Phase=CONSTRUCTION, Current
// Stage=functional-design, Scope=feature, Completed=20. `--phase ideation`
// resolves (aidlc-jump.ts handleResolve -> firstInScopeStageOfPhase,
// aidlc-lib.ts) to the FIRST in-scope ideation stage = intent-capture.
// intent-capture's display order is BEFORE functional-design, so direction =
// backward (aidlc-jump.ts). The person's `next --phase ideation` runs
// `aidlc-jump.ts execute --direction backward` itself and returns Intent
// Capture's step in the same call, so the agent never runs the jump. It atomically:
// resets target + downstream EXECUTE stages [x]->[ ] (jump.ts), sets
// target [-] (jump.ts), rewrites Lifecycle Phase=IDEATION + Current
// Stage=intent-capture + recomputed Completed (jump.ts), and
// appends a STAGE_JUMPED audit event with Direction=BACKWARD / Target=intent-
// capture (jump.ts). A jump never terminates
// (jump.ts), so Status stays Running.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface, equal-or-stronger):
//   1 grep STATE 'IDEATION'            -> the state file reads Lifecycle Phase IDEATION and
//                                         Current Stage intent-capture when the drive stops on
//                                         the step that one `next` returned, before the agent
//                                         does any of the stage's work.
//   2 assert_lt COMPLETED 20           -> the same state reads the known-answer Completed 4
//                                         (jump.ts - the value the tool wrote). STRONGER than
//                                         the .sh's loose < 20 bound: pins the exact reset
//                                         arithmetic (confirmed by running the shipped tool on
//                                         this exact fixture).
//   3 grep AUDIT 'intent-capture'      -> raw audit.md bytes contain "**Target**: intent-capture"
//                                         (jump.ts Target field), the append-only deterministic
//                                         origin of the destination.
//   + one engine call                  -> assertJumpInOneCall: the person's `next` returned the
//                                         intent-capture step and no shell call ran the jump.
//   4 grep AUDIT 'STAGE_JUMPED'        -> assertAuditEvent(r,"STAGE_JUMPED") (parsed **Event**: line;
//                                         jump.ts emit, audit.ts **Event**:).
//   5 grep AUDIT 'BACKWARD'            -> raw audit.md bytes contain "**Direction**: BACKWARD"
//                                         (jump.ts direction.toUpperCase(); known-answer for a
//                                         construction->ideation jump).
//   6 grep AUDIT 'Timestamp'           -> raw audit.md bytes contain "**Timestamp**:" (audit.ts,
//                                         emitted on every audit block).
//
// Known-answer literals are READ from the SHIPPED handlers (cited inline), not
// guessed. The driver stops on the step the jump lands on.
//
// An optional-field read the run makes (e.g. aidlc-state get "Initial
// Intent" on a work that does not set it) exits 1 with one plain line and
// writes no ERROR_LOGGED row (#2264); the run still succeeds. This test does
// NOT assert against ERROR_LOGGED presence/absence.
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertAuditEvent, assertJumpInOneCall, stopAtStep } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  readAuditText,
  driveAidlc,
  readStateField,
  stateFilePathFor,
} from "../harness/sdk-drive.ts";

// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Known-answer literals, read from the SHIPPED jump/audit handlers (see header).
// The jump DESTINATION (intent-capture) and DIRECTION (backward) are asserted on
// the immutable audit STAGE_JUMPED block bytes, and the state on the file as the
// jump left it: the drive stops on the step it returned, before any stage work.
const TARGET_STAGE = "intent-capture"; // firstInScopeStageOfPhase("ideation","feature"), aidlc-lib.ts
const AUDIT_TARGET_LINE = `**Target**: ${TARGET_STAGE}`; // handleExecute Target field; aidlc-audit.ts renderAuditBlock **key**: line
const AUDIT_DIRECTION_LINE = "**Direction**: BACKWARD"; // aidlc-jump.ts handleExecute direction.toUpperCase()
const AUDIT_TIMESTAMP_PREFIX = "**Timestamp**:"; // aidlc-audit.ts renderAuditBlock, on every block

describe("t25 /aidlc --phase ideation backward jump (sdk)", () => {
  // -------------------------------------------------------------------------
  // From CONSTRUCTION, `--phase ideation` is a backward jump that resolves to
  // intent-capture (first in-scope ideation stage for scope=feature). The driver
  // stops on the step the person's `next` returned, so we assert the state and
  // audit surfaces the jump tool wrote, and that it took that one call.
  // -------------------------------------------------------------------------
  test(
    "backward jump to intent-capture rewrites state phase + Completed and emits STAGE_JUMPED/BACKWARD",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        withState: "state-construction.md",
        withAudit: true,
      });
      try {
        // Precondition: the seed truly starts at CONSTRUCTION / Completed=20 /
        // Current Stage=functional-design, so the jump genuinely crosses backward
        // (no vacuous pass on a pre-seeded ideation state). Read straight off the
        // seeded file. seedStateFile writes under the active intent's record, so
        // stateFilePathFor resolves that record.
        const seedState = readFileSync(stateFilePathFor(proj), "utf8");
        expect(readStateField(seedState, "Lifecycle Phase")).toBe("CONSTRUCTION");
        expect(readStateField(seedState, "Completed")).toBe("20");
        expect(readStateField(seedState, "Current Stage")).toBe(
          "functional-design",
        );

        // The driver stops on the step the jump lands on, before unrelated
        // workflow continuation.
        const r = await driveAidlc("/aidlc --phase ideation", {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: stopAtStep(TARGET_STAGE),
        });

        expect(r.stateFile).toBeDefined();

        // One engine call: the person's `next` made the jump and returned Intent
        // Capture's step; the agent never ran the jump tool.
        assertJumpInOneCall(r, TARGET_STAGE);
        // The state as that call left it (the drive stopped on its result, so the
        // workflow has not moved on): the phase, the stage and the exact reset
        // count the tool wrote.
        const jumpedState = readFileSync(stateFilePathFor(proj), "utf8");
        expect(readStateField(jumpedState, "Lifecycle Phase")).toBe("IDEATION");
        expect(readStateField(jumpedState, "Current Stage")).toBe(TARGET_STAGE);
        expect(readStateField(jumpedState, "Completed")).toBe("4");

        // Audit recorded a STAGE_JUMPED event. Asserted on the parsed auditEvents (the
        // **Event**: lines), so an unrelated mention in prose can't satisfy it - this
        // is the tool's emitted event-type.
        assertAuditEvent(r, "STAGE_JUMPED");
        // The person left Construction unfinished, so the record never says it
        // was completed or verified (the seeded audit holds neither row).
        expect(r.auditEvents).not.toContain("PHASE_COMPLETED");
        expect(r.auditEvents).not.toContain("PHASE_VERIFIED");

        // The STAGE_JUMPED block's field bytes.
        // auditEvents only carries event-type names, so for the field-level
        // literals (intent-capture target, BACKWARD direction, the Timestamp
        // line) we read the raw audit text the tool appended and assert each
        // verbatim field line. These are the exact bytes aidlc-jump.ts +
        // aidlc-audit.ts wrote.
        const auditRaw = readAuditText(proj);
        expect(auditRaw).toContain(AUDIT_TARGET_LINE);
        expect(auditRaw).toContain(AUDIT_DIRECTION_LINE);
        expect(auditRaw).toContain(AUDIT_TIMESTAMP_PREFIX);

        // The driver intentionally aborts on the step the jump lands on. The test
        // contract is the one call, the state and the audit bytes above;
        // continuing would spend turns in the unrelated post-jump workflow.
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
