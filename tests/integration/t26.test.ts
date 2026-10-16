// covers: subcommand:aidlc-jump:execute
//
// t26.test.ts - drives the real `/aidlc --stage intent-capture` through the
// Claude Agent SDK from a CONSTRUCTION-phase state and asserts ONLY on
// deterministic surfaces (the jump tool's verbatim stdout JSON in the Bash
// tool_result, parsed audit events, and raw audit-file bytes) - NEVER on
// assistantText.
//
// SIBLING NOTE. t25.test.ts is the SAME backward-to-intent-capture journey via
// `--phase ideation`; this is the `--stage intent-capture` twin. Both route
// through `aidlc-jump.ts execute --direction backward`. The phase-vs-stage
// dispatch differs in resolution only (--stage resolves the literal slug
// directly; --phase routes through firstInScopeStageOfPhase, jump.ts);
// the EXECUTE emission and every deterministic surface below are identical.
//
// THE JOURNEY (verified against the SHIPPED tool). The seeded fixture
// (state-construction.md) sits at Lifecycle Phase=CONSTRUCTION, Current
// Stage=functional-design, Scope=feature, Completed=20. `--stage intent-capture`
// resolves directly to intent-capture, whose display order is BEFORE
// functional-design, so direction = backward
// (aidlc-jump.ts). The SKILL.md Stage/Phase Jump handler routes this
// through `aidlc-jump.ts execute --direction backward` (as first ported; today
// the engine names that command in a print directive), which atomically:
//   - resets target + downstream EXECUTE stages [x]/[-]/[S] -> [ ] (jump.ts),
//   - sets target intent-capture -> [-] in-progress (jump.ts),
//   - rewrites Lifecycle Phase=IDEATION, Current Stage=intent-capture,
//     In Progress=intent-capture, Status=Running, recomputed Completed
//     (jump.ts; a jump never terminates, so
//     Status stays Running and the workflow does NOT terminate —
//     workflow_stopped:false),
//   - crosses the construction->ideation phase boundary, so emits
//     PHASE_COMPLETED / PHASE_VERIFIED / PHASE_STARTED (jump.ts),
//   - appends STAGE_JUMPED with Direction=BACKWARD / Source=functional-design /
//     Target=intent-capture / Scope=feature (jump.ts),
//   - appends STAGE_STARTED for the target (Stage=intent-capture,
//     Agent=aidlc-product-agent; jump.ts).
// An optional-field read (e.g. get "Initial Intent") writes no ERROR_LOGGED row
// (#2264); we do NOT assert on ERROR_LOGGED.
//
// THE KNOWN-ANSWER COUNT. countCheckboxes("completed") after a backward reset to
// intent-capture leaves exactly 4 [x] (jump.ts). Verified by both the
// shipped tool's stdout (completed_count:4) and the reset arithmetic: the 3
// init stages (workspace-scaffold/workspace-detection/state-init, UPSTREAM of
// intent-capture) survive, AND the fixture's per-unit-duplicate `widget-cart`
// nfr-requirements [x] survives - the reset is slug-indexed, so the duplicate
// per-unit checkbox at a different state-file position is not reached. So
// completed_count = 4. We pin the exact value 4 on the jump-tool stdout.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface):
//   1 assert_lt COMPLETED 20 (grep 'Completed'|head -1)
//       -> Bash tool_result contains `"completed_count":4` (jump.ts stdout
//          JSON): the exact known-answer 4 (satisfies <20).
//   2 assert_grep AUDIT 'intent-capture'
//       -> raw audit.md bytes contain "**Target**: intent-capture" (jump.ts)
//          beside the tool's own Current Stage rewrite
//          (jump.ts). The audit Target line is the immutable origin; the
//          post-run state file is not re-read (the driver stops on the jump
//          output). (audit-sample.md baseline does NOT contain intent-capture,
//          no vacuous pass.)
//   3 assert_lt X_COUNT 15 / 4 assert_eq X_COUNT COMPLETED
//       -> the `- [x]` count and the Completed field after the reset: the
//          jump tool keeps these in lockstep (jump.ts); asserts internal
//          consistency through the stdout `"completed_count":4` (the on-disk
//          count is not re-read).
//   5 assert_grep AUDIT 'STAGE_JUMPED'
//       -> assertAuditEvent(r,"STAGE_JUMPED") (parsed **Event**: line; jump.ts).
//   6 assert_grep AUDIT 'BACKWARD'
//       -> raw audit.md bytes contain "**Direction**: BACKWARD" (jump.ts).
//   7 assert_grep AUDIT 'Timestamp'
//       -> raw audit.md bytes contain "**Timestamp**:" (audit.ts, every block).
//   8 Status=Running AND Current Stage == In Progress (read from FINAL state)
//       -> the jump tool writes Status, Current Stage and In Progress together
//          (jump.ts) - the EXACT three-way consistency the .sh read.
//          ALSO the jump-tool stdout `"workflow_stopped":false` (jump.ts, the
//          deterministic origin) AND the STAGE_STARTED audit event for the target
//          are asserted; the final state file is not re-read.
//
// Known-answer literals are READ from the SHIPPED handlers (cited inline).
// The driver stops on the jump tool's output; post-run live state is not
// asserted.
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
import { assertAuditEvent, assertToolResultContains } from "../harness/assert.ts";
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
// The deterministic jump EMISSION is what this sdk test asserts: the tool's own
// stdout JSON + the immutable audit STAGE_JUMPED block. Post-run live state is a
// moving target (the workflow continues after the jump) and is NOT asserted here.
const TARGET_STAGE = "intent-capture"; // resolve --stage intent-capture (stage 1.1)
const JUMP_COMPLETED_COUNT = '"completed_count":4'; // aidlc-jump.ts handleExecute stdout JSON
const JUMP_WORKFLOW_STOPPED = '"workflow_stopped":false'; // aidlc-jump.ts handleExecute (BACKWARD never terminates the workflow)
const JUMP_DIRECTION = '"direction":"backward"'; // aidlc-jump.ts handleExecute stdout JSON
const STOP_AFTER_JUMP = { toolName: "Bash", resultIncludes: JUMP_COMPLETED_COUNT } as const;
const AUDIT_TARGET_LINE = `**Target**: ${TARGET_STAGE}`; // handleExecute Target field; aidlc-audit.ts renderAuditBlock **key**: line
const AUDIT_DIRECTION_LINE = "**Direction**: BACKWARD"; // aidlc-jump.ts handleExecute direction.toUpperCase()
const AUDIT_TIMESTAMP_PREFIX = "**Timestamp**:"; // aidlc-audit.ts renderAuditBlock, on every block

describe("t26 /aidlc --stage intent-capture backward jump (sdk)", () => {
  // -------------------------------------------------------------------------
  // From CONSTRUCTION, `--stage intent-capture` is a backward jump. This sdk
  // test asserts ONLY the deterministic jump EMISSION — the tool's own stdout
  // JSON (completed_count / workflow_stopped / direction, immune to what the
  // orchestrator does next) and the appended audit events + field bytes. The
  // post-jump workflow CONTINUATION (where Current Stage advances to) is an
  // LLM-paced journey covered by the Phase-3 tui tier, not asserted here.
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

        // The driver stops after the jump tool's output. answerScript "default"
        // answers any preceding question with option 1; the test does not wait for
        // post-jump workflow continuation.
        const r = await driveAidlc("/aidlc --stage intent-capture", {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_JUMP,
        });

        // The jump tool ACTUALLY FIRED via Bash and its verbatim stdout JSON
        // carries the deterministic outcome fields. assertToolResultContains
        // refuses to pass vacuously if Bash never fired — so this is also proof
        // the backward-jump path RAN, not that prose mentioned a jump.
        //
        // The count the TOOL computed is the known-answer 4; pins the exact reset.
        assertToolResultContains(r, "Bash", JUMP_COMPLETED_COUNT);
        // The tool's workflow_stopped flag is the deterministic origin of
        // Status=Running - false for a BACKWARD jump (aidlc-jump.ts handleExecute).
        assertToolResultContains(r, "Bash", JUMP_WORKFLOW_STOPPED);
        assertToolResultContains(r, "Bash", JUMP_DIRECTION);

        expect(r.stateFile).toBeDefined();

        // The STAGE_JUMPED block names intent-capture as the jump Target. Read the raw
        // audit text the tool appended and assert the verbatim field line.
        // audit-sample.md baseline does NOT contain intent-capture, so this can't pass
        // on the seed.
        const auditRaw = readAuditText(proj);
        expect(auditRaw).toContain(AUDIT_TARGET_LINE);

        // POST-RUN LIVE STATE IS NOT ASSERTED (deliberate). Final-state Current Stage
        // / In Progress / Status / Completed and the x-checkbox count are a MOVING
        // TARGET: a backward jump leaves Status=Running (aidlc-jump.ts movedState),
        // and the Forwarding Loop (SKILL.md) carries on while the directive permits
        // continuation. So the LLM keeps running the workflow after the jump and may
        // advance Current Stage off intent-capture (a stability gate caught it reading
        // "market-research" on a fraction of runs). The jump TOOL is deterministic
        // only the orchestrator's CONTINUATION is LLM-paced. That continuation is a
        // Phase-3 tui journey, not this single-transition sdk check. So the
        // deterministic outcome fields (completed_count=4, workflow_stopped=false,
        // direction=backward) are asserted ABOVE on the jump tool's OWN stdout (immune
        // to the continuation) instead of re-read off the moving post-run state.

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

        // The driver intentionally aborts once the deterministic jump stdout
        // lands. The proof lives in the tool JSON + audit bytes above; waiting
        // for terminal SDK prose would only let the model continue past the
        // single-transition contract.
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
