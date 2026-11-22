// covers: subcommand:aidlc-jump:execute
//
// t26.test.ts - drives the real `/aidlc --stage intent-capture` through the
// Claude Agent SDK from a CONSTRUCTION-phase state and asserts ONLY on
// deterministic surfaces (the engine calls the agent made, the state file as
// the jump left it, parsed audit events, and raw audit-file bytes) - NEVER on
// assistantText.
//
// SIBLING NOTE. t25.test.ts is the SAME backward-to-intent-capture journey via
// `--phase ideation`; this is the `--stage intent-capture` twin. Both run
// `aidlc-jump.ts execute --direction backward` inside the person's `next`. The phase-vs-stage
// dispatch differs in resolution only (--stage resolves the literal slug
// directly; --phase routes through firstInScopeStageOfPhase, jump.ts);
// the EXECUTE emission and every deterministic surface below are identical.
//
// THE JOURNEY (verified against the SHIPPED tool). The seeded fixture
// (state-construction.md) sits at Lifecycle Phase=CONSTRUCTION, Current
// Stage=functional-design, Scope=feature, Completed=20. `--stage intent-capture`
// resolves directly to intent-capture, whose display order is BEFORE
// functional-design, so direction = backward
// (aidlc-jump.ts). The person's `next --stage intent-capture` runs
// `aidlc-jump.ts execute --direction backward` itself and returns Intent
// Capture's step in the same call, so the agent never runs the jump. It atomically:
//   - resets target + downstream EXECUTE stages [x]/[-]/[S] -> [ ] (jump.ts),
//   - sets target intent-capture -> [-] in-progress (jump.ts),
//   - rewrites Lifecycle Phase=IDEATION, Current Stage=intent-capture,
//     In Progress=intent-capture, Status=Running, recomputed Completed
//     (jump.ts; a jump never terminates, so
//     Status stays Running and the workflow does NOT terminate —
//     workflow_stopped:false),
//   - crosses the construction->ideation phase boundary backward, so emits
//     PHASE_STARTED only: Construction was left, not completed (jump.ts),
//   - appends STAGE_JUMPED with Direction=BACKWARD / Source=functional-design /
//     Target=intent-capture / Scope=feature (jump.ts),
//   - appends STAGE_STARTED for the target (Stage=intent-capture,
//     Agent=aidlc-product-agent; jump.ts).
// An optional-field read (e.g. get "Initial Intent") writes no ERROR_LOGGED row
// (#2264); we do NOT assert on ERROR_LOGGED.
//
// THE KNOWN-ANSWER COUNT. countCheckboxes("completed") after a backward reset to
// intent-capture leaves exactly 4 [x] (jump.ts). Verified by both the
// shipped tool's Completed field and the reset arithmetic: the 3
// init stages (workspace-scaffold/workspace-detection/state-init, UPSTREAM of
// intent-capture) survive, AND the fixture's per-unit-duplicate `widget-cart`
// nfr-requirements [x] survives - the reset is slug-indexed, so the duplicate
// per-unit checkbox at a different state-file position is not reached. So
// Completed = 4. We pin the exact value 4 on the state the jump left.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface):
//   1 assert_lt COMPLETED 20 (grep 'Completed'|head -1)
//       -> the state's Completed field reads the exact known-answer 4
//          (satisfies <20), read when the drive stops on the step the jump
//          lands on, before any stage work.
//   2 assert_grep AUDIT 'intent-capture'
//       -> raw audit.md bytes contain "**Target**: intent-capture" (jump.ts)
//          beside the tool's own Current Stage rewrite (jump.ts).
//          (audit-sample.md baseline does NOT contain intent-capture, no
//          vacuous pass.)
//   3 assert_lt X_COUNT 15 / 4 assert_eq X_COUNT COMPLETED
//       -> the `- [x]` count in that state equals its Completed field (4):
//          the jump tool keeps these in lockstep (jump.ts).
//   5 assert_grep AUDIT 'STAGE_JUMPED'
//       -> assertAuditEvent(r,"STAGE_JUMPED") (parsed **Event**: line; jump.ts).
//   6 assert_grep AUDIT 'BACKWARD'
//       -> raw audit.md bytes contain "**Direction**: BACKWARD" (jump.ts).
//   7 assert_grep AUDIT 'Timestamp'
//       -> raw audit.md bytes contain "**Timestamp**:" (audit.ts, every block).
//   8 Status=Running AND Current Stage == In Progress
//       -> the jump tool writes Status, Current Stage and In Progress together
//          (jump.ts) - the EXACT three-way consistency the .sh read, on the
//          state as the jump left it; ALSO the STAGE_STARTED audit event for
//          the target.
//   + one engine call
//       -> assertJumpInOneCall: the person's `next` returned the intent-capture
//          step and no shell call ran the jump.
//
// Known-answer literals are READ from the SHIPPED handlers (cited inline).
// The driver stops on the step the jump lands on.
//
// It SPENDS TOKENS - driveAidlc drives the real /aidlc on Opus/Bedrock.
// Re-run alone if the suite is under load.

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
// The deterministic jump is what this sdk test asserts: the one engine call, the
// state as the jump left it (the drive stops on the step it returned, before any
// stage work) and the immutable audit STAGE_JUMPED block.
const TARGET_STAGE = "intent-capture"; // resolve --stage intent-capture (stage 1.1)
const AUDIT_TARGET_LINE = `**Target**: ${TARGET_STAGE}`; // handleExecute Target field; aidlc-audit.ts renderAuditBlock **key**: line
const AUDIT_DIRECTION_LINE = "**Direction**: BACKWARD"; // aidlc-jump.ts handleExecute direction.toUpperCase()
const AUDIT_TIMESTAMP_PREFIX = "**Timestamp**:"; // aidlc-audit.ts renderAuditBlock, on every block

describe("t26 /aidlc --stage intent-capture backward jump (sdk)", () => {
  // -------------------------------------------------------------------------
  // From CONSTRUCTION, `--stage intent-capture` is a backward jump. This sdk
  // test asserts ONLY the deterministic jump: the one engine call, the state the
  // jump wrote (read when the drive stops on the step it returned, before the
  // agent does any stage work) and the appended audit events + field bytes. The
  // post-jump workflow CONTINUATION is an LLM-paced journey covered by the
  // Phase-3 tui tier, not asserted here.
  // -------------------------------------------------------------------------
  test(
    "backward jump to intent-capture resets the workflow, stops stable, and emits STAGE_JUMPED/BACKWARD",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        withState: "state-construction.md",
        withAudit: true,
      });
      try {
        // Precondition: the seed truly starts at CONSTRUCTION / Completed=20, so
        // the jump genuinely crosses backward (no vacuous pass on a pre-seeded
        // ideation state). Read straight off the seeded file. seedStateFile writes
        // under the active intent's record, so stateFilePathFor resolves that record.
        const seedState = readFileSync(stateFilePathFor(proj), "utf8");
        expect(readStateField(seedState, "Lifecycle Phase")).toBe("CONSTRUCTION");
        expect(readStateField(seedState, "Completed")).toBe("20");
        expect(readStateField(seedState, "Current Stage")).toBe(
          "functional-design",
        );

        // The driver stops on the step the jump lands on. answerScript "default"
        // answers any preceding question with option 1; the test does not wait for
        // post-jump workflow continuation.
        const r = await driveAidlc("/aidlc --stage intent-capture", {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: stopAtStep(TARGET_STAGE),
        });

        // One engine call: the person's `next` made the jump and returned Intent
        // Capture's step; the agent never ran the jump tool.
        assertJumpInOneCall(r, TARGET_STAGE);
        expect(r.stateFile).toBeDefined();

        // The state as that call left it: the known-answer reset count 4, equal to
        // the `- [x]` rows, and Status, Current Stage and In Progress written
        // together (a backward jump never stops the workflow).
        const jumpedState = readFileSync(stateFilePathFor(proj), "utf8");
        expect(readStateField(jumpedState, "Completed")).toBe("4");
        expect(jumpedState.split("\n").filter((line) => line.startsWith("- [x] "))).toHaveLength(4);
        expect(readStateField(jumpedState, "Status")).toBe("Running");
        expect(readStateField(jumpedState, "Current Stage")).toBe(TARGET_STAGE);
        expect(readStateField(jumpedState, "In Progress")).toBe(TARGET_STAGE);

        // The STAGE_JUMPED block names intent-capture as the jump Target. Read the raw
        // audit text the tool appended and assert the verbatim field line.
        // audit-sample.md baseline does NOT contain intent-capture, so this can't pass
        // on the seed.
        const auditRaw = readAuditText(proj);
        expect(auditRaw).toContain(AUDIT_TARGET_LINE);

        // Audit recorded STAGE_JUMPED. Asserted on parsed auditEvents (the **Event**:
        // lines), so a prose mention can't satisfy it - this is the tool's emitted
        // event-type.
        assertAuditEvent(r, "STAGE_JUMPED");
        // The target entered the active state - STAGE_STARTED for intent-capture is
        // the audit-side proof the jump drove the workflow INTO the target
        // (aidlc-jump.ts handleExecute), the symmetric partner of Status=Running / In
        // Progress.
        assertAuditEvent(r, "STAGE_STARTED");

        expect(auditRaw).toContain(AUDIT_DIRECTION_LINE);

        // Every audit block carries a Timestamp line (aidlc-audit.ts renderAuditBlock).
        // Assert the verbatim prefix in the raw audit.
        expect(auditRaw).toContain(AUDIT_TIMESTAMP_PREFIX);

        // The driver intentionally aborts on the step the jump lands on. The
        // proof lives in the one call, the state and the audit bytes above;
        // waiting for terminal SDK prose would only let the model continue past
        // the single-transition contract.
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
