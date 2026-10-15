// covers: subcommand:aidlc-jump:execute
//
// t25.test.ts - drives the real `/aidlc --phase ideation` through the Claude
// Agent SDK from a CONSTRUCTION-phase state and asserts ONLY on deterministic
// surfaces (the jump tool's stdout JSON, parsed audit events, verbatim
// audit-file bytes) - NEVER on assistantText.
//
// THE JOURNEY (verified against the SHIPPED tool, not guessed). The seeded
// fixture (state-construction.md) sits at Lifecycle Phase=CONSTRUCTION, Current
// Stage=functional-design, Scope=feature, Completed=20. `--phase ideation`
// resolves (aidlc-jump.ts handleResolve -> firstInScopeStageOfPhase,
// aidlc-lib.ts) to the FIRST in-scope ideation stage = intent-capture.
// intent-capture's display order is BEFORE functional-design, so direction =
// backward (aidlc-jump.ts). The SKILL.md Stage/Phase Jump handler routes
// this through `aidlc-jump.ts execute --direction backward` (as first ported;
// today the engine names that command in a print directive), which atomically:
// resets target + downstream EXECUTE stages [x]->[ ] (jump.ts), sets
// target [-] (jump.ts), rewrites Lifecycle Phase=IDEATION + Current
// Stage=intent-capture + recomputed Completed (jump.ts), and
// appends a STAGE_JUMPED audit event with Direction=BACKWARD / Target=intent-
// capture (jump.ts). A jump never terminates
// (jump.ts), so Status stays Running.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface, equal-or-stronger):
//   1 grep STATE 'IDEATION'            -> the jump tool's OWN stdout JSON carries
//                                         `"target_phase":"IDEATION"` (jump.ts - the
//                                         deterministic origin of the state's Lifecycle Phase
//                                         rewrite at jump.ts). Asserted on the Bash
//                                         tool_result, immune to the post-jump continuation.
//   2 assert_lt COMPLETED 20           -> the jump tool's stdout JSON carries the known-answer
//                                         `"completed_count":4` (jump.ts - the value the tool
//                                         wrote into the Completed field, jump.ts).
//                                         STRONGER than the .sh's loose < 20 bound: pins the exact
//                                         reset arithmetic, on the emission that cannot be moved
//                                         by whatever the orchestrator does next (the t26 pattern;
//                                         deterministically confirmed by running the shipped tool
//                                         on this exact fixture: completed_count=4).
//   3 grep AUDIT 'intent-capture'      -> raw audit.md bytes contain "**Target**: intent-capture"
//                                         (jump.ts Target field), the append-only deterministic
//                                         origin of the destination; PLUS the stdout JSON
//                                         `"target":"intent-capture"` + `"direction":"backward"`
//                                         (jump.ts) pins which jump emitted it.
//   4 grep AUDIT 'STAGE_JUMPED'        -> assertAuditEvent(r,"STAGE_JUMPED") (parsed **Event**: line;
//                                         jump.ts emit, audit.ts **Event**:).
//   5 grep AUDIT 'BACKWARD'            -> raw audit.md bytes contain "**Direction**: BACKWARD"
//                                         (jump.ts direction.toUpperCase(); known-answer for a
//                                         construction->ideation jump).
//   6 grep AUDIT 'Timestamp'           -> raw audit.md bytes contain "**Timestamp**:" (audit.ts,
//                                         emitted on every audit block).
//
// Known-answer literals are READ from the SHIPPED handlers (cited inline), not
// guessed. The driver stops on the jump tool's output.
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
// The jump DESTINATION (intent-capture) and DIRECTION (backward) are asserted on
// the immutable audit STAGE_JUMPED block bytes — the deterministic jump emission.
// Post-run Lifecycle Phase / Current Stage / Completed are NOT asserted: they are
// a moving target while the workflow continues (see the in-test rationale).
const TARGET_STAGE = "intent-capture"; // firstInScopeStageOfPhase("ideation","feature"), aidlc-lib.ts
const JUMP_TARGET_JSON = `"target":"${TARGET_STAGE}"`; // aidlc-jump.ts handleExecute stdout JSON
const JUMP_DIRECTION_JSON = '"direction":"backward"'; // aidlc-jump.ts handleExecute stdout JSON
const JUMP_TARGET_PHASE_JSON = '"target_phase":"IDEATION"'; // aidlc-jump.ts handleExecute - origin of the state phase rewrite
const JUMP_COMPLETED_JSON = '"completed_count":4'; // aidlc-jump.ts handleExecute - known-answer reset arithmetic
const STOP_AFTER_JUMP = { toolName: "Bash", resultIncludes: JUMP_TARGET_JSON } as const;
const AUDIT_TARGET_LINE = `**Target**: ${TARGET_STAGE}`; // handleExecute Target field; aidlc-audit.ts renderAuditBlock **key**: line
const AUDIT_DIRECTION_LINE = "**Direction**: BACKWARD"; // aidlc-jump.ts handleExecute direction.toUpperCase()
const AUDIT_TIMESTAMP_PREFIX = "**Timestamp**:"; // aidlc-audit.ts renderAuditBlock, on every block

describe("t25 /aidlc --phase ideation backward jump (sdk)", () => {
  // -------------------------------------------------------------------------
  // From CONSTRUCTION, `--phase ideation` is a backward jump that resolves to
  // intent-capture (first in-scope ideation stage for scope=feature). The driver
  // stops on the jump tool's output, so we assert the stdout JSON + audit
  // surfaces the jump tool wrote.
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

        // The driver stops after the deterministic jump output, before unrelated
        // workflow continuation.
        const r = await driveAidlc("/aidlc --phase ideation", {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_JUMP,
        });

        expect(r.stateFile).toBeDefined();

        // The jump tool ACTUALLY FIRED via Bash and its verbatim stdout JSON
        // carries the deterministic outcome fields (the t26 pattern — assert the
        // tool's own emission, immune to the post-jump continuation):
        //   destination: "target":"intent-capture" + backward.
        assertToolResultContains(r, "Bash", JUMP_TARGET_JSON);
        const jumpCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(JUMP_TARGET_JSON),
        );
        expect(jumpCall?.resultText).toContain(JUMP_DIRECTION_JSON);
        //   IDEATION: the tool resolved the target's phase, the deterministic origin
        //   of the state's Lifecycle Phase rewrite.
        expect(jumpCall?.resultText).toContain(JUMP_TARGET_PHASE_JSON);
        //   Completed: the exact known-answer reset count the tool wrote into the
        //   Completed field (4).
        expect(jumpCall?.resultText).toContain(JUMP_COMPLETED_JSON);

        // POST-RUN LIVE STATE IS NOT ASSERTED HERE (deliberate — see below).
        // A backward jump leaves Status=Running (aidlc-jump.ts movedState), and the
        // Forwarding Loop (SKILL.md) carries on while the directive permits
        // continuation. So after the jump the LLM keeps running the workflow and the
        // post-run Current Stage / Completed / Lifecycle Phase are a MOVING TARGET
        // (a stability gate caught Current Stage reading "market-research" - the next
        // ideation stage - on a fraction of runs). That CONTINUATION is an LLM-paced
        // journey and belongs to the Phase-3 tui tier, NOT this single-transition sdk
        // check. The jump TOOL itself is deterministic; what is non-deterministic is
        // only how far the orchestrator advances afterward. So this sdk test asserts
        // ONLY the deterministic jump EMISSION (the audit bytes + the tool's own
        // stdout).

        // Audit recorded a STAGE_JUMPED event. Asserted on the parsed auditEvents (the
        // **Event**: lines), so an unrelated mention in prose can't satisfy it - this
        // is the tool's emitted event-type.
        assertAuditEvent(r, "STAGE_JUMPED");

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

        // The driver intentionally aborts after the deterministic jump stdout
        // lands. The test contract is the jump emission + audit bytes above;
        // continuing would spend turns in the unrelated post-jump workflow.
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
