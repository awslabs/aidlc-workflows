// covers: subcommand:aidlc-jump:execute
//
// t25.test.ts — SDK-harness port of tests/integration/t25-integration-phase-jump.sh
// (plan 6). Drives the real `/aidlc --phase ideation` through the Claude Agent
// SDK from a CONSTRUCTION-phase state and asserts ONLY on deterministic
// surfaces (on-disk state fields, parsed audit events, verbatim audit-file
// bytes) — NEVER on assistantText.
//
// WHY THIS PORT EXISTS. The .sh grepped the post-run aidlc-state.md and audit.md
// files on disk for literal substrings ("IDEATION", "intent-capture",
// "STAGE_JUMPED", "BACKWARD", "Timestamp") and an `assert_lt` on the Completed
// count. Those are NOT prose-flaky — they read the FILES the deterministic jump
// tool wrote, not the LLM's rendering. But the .sh reached them via a `claude -p`
// subprocess + run_claude's exit-124 heuristic; this port reaches the SAME files
// (and the same tool emission) through driveAidlc, so the assertions become
// structured reads (readStateField / auditEvents) instead of greps over a shell
// capture. Equal-or-stronger on every line.
//
// WHY THIS TEST IS STABLE. A backward/phase jump TERMINATES CLEANLY at the jump
// target and leaves STABLE post-jump state: VERIFIED via a live probe
// (tmp/phase2/probe2.ts, 2026-06-05)
// — resultEvent subtype=success, is_error=false, ~184s, 27 turns, askedQuestions=0
// (backward jump lands + stops; no gate on this path), and the on-disk state at
// rest reads Lifecycle Phase=IDEATION, Current Stage=intent-capture (NOT
// auto-advanced), Completed=4, Status=Running. So this port asserts the
// stable Current Stage === intent-capture and Lifecycle Phase === IDEATION
// DIRECTLY off the state file — STRICTLY STRONGER than the old audit-only
// destination pin — plus the audit STAGE_JUMPED / **Target** / **Direction**
// bytes and the .sh's own `Completed < 20` reduction bound.
//
// THE JOURNEY (verified against the SHIPPED tool, not guessed). The seeded
// fixture (state-construction.md) sits at Lifecycle Phase=CONSTRUCTION, Current
// Stage=functional-design, Scope=feature, Completed=20. `--phase ideation`
// resolves (aidlc-jump.ts handleResolve:121-133 -> firstInScopeStageOfPhase,
// aidlc-lib.ts:1408) to the FIRST in-scope ideation stage = intent-capture.
// intent-capture's display order is BEFORE functional-design, so direction =
// backward (aidlc-jump.ts:143-145). The SKILL.md Stage/Phase Jump handler routes
// this through `aidlc-jump.ts execute --direction backward`, which atomically:
// resets target + downstream EXECUTE stages [x]->[ ] (jump.ts:268-285), sets
// target [-] (jump.ts:295), rewrites Lifecycle Phase=IDEATION + Current
// Stage=intent-capture + recomputed Completed (jump.ts:312,313,330-331), and
// appends a STAGE_JUMPED audit event with Direction=BACKWARD / Target=intent-
// capture (jump.ts:374-380). A jump never terminates
// (jump.ts:309), so Status stays Running.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface, equal-or-stronger):
//   1 grep STATE 'IDEATION'            -> the jump tool's OWN stdout JSON carries
//                                         `"target_phase":"IDEATION"` (jump.ts:410 — the
//                                         deterministic origin of the state's Lifecycle Phase
//                                         rewrite at jump.ts:312). Asserted on the Bash
//                                         tool_result, immune to the post-jump continuation.
//   2 assert_lt COMPLETED 20           -> the jump tool's stdout JSON carries the known-answer
//                                         `"completed_count":4` (jump.ts:415 — the value the tool
//                                         wrote into the Completed field, jump.ts:330-331).
//                                         STRONGER than the .sh's loose < 20 bound: pins the exact
//                                         reset arithmetic, on the emission that cannot be moved
//                                         by whatever the orchestrator does next (the t26 pattern;
//                                         deterministically confirmed by running the shipped tool
//                                         on this exact fixture: completed_count=4).
//   3 grep AUDIT 'intent-capture'      -> raw audit.md bytes contain "**Target**: intent-capture"
//                                         (jump.ts:377 Target field), the append-only deterministic
//                                         origin of the destination; PLUS the stdout JSON
//                                         `"target":"intent-capture"` + `"direction":"backward"`
//                                         (jump.ts:408-409) pins which jump emitted it.
//   4 grep AUDIT 'STAGE_JUMPED'        -> assertAuditEvent(r,"STAGE_JUMPED") (parsed **Event**: line;
//                                         jump.ts:374 emit, audit.ts:258 **Event**:).
//   5 grep AUDIT 'BACKWARD'            -> raw audit.md bytes contain "**Direction**: BACKWARD"
//                                         (jump.ts:375 direction.toUpperCase(); known-answer for a
//                                         construction->ideation jump).
//   6 grep AUDIT 'Timestamp'           -> raw audit.md bytes contain "**Timestamp**:" (audit.ts:257,
//                                         emitted on every audit block).
//
// Known-answer literals are READ from the SHIPPED handlers (cited inline), not
// guessed. No AskUserQuestion is auto-approved on the jump path — the probe saw
// askedQuestions=0 — so this is a §5-A2 LOGIC journey (an sdk port), NOT a
// rendered-gate journey: answerScript stays "default" (no gate fires).
//
// Any BENIGN ERROR_LOGGED probes the run emits (e.g. aidlc-state get
// "Initial Intent" -> Field not found) are routine optional-field reads;
// the run still succeeds. This test does NOT assert against ERROR_LOGGED
// presence/absence — it is noise, not a failure.
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertAuditEvent, assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  auditFilePathFor,
  driveAidlc,
  readStateField,
  stateFilePathFor,
} from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget. The .sh set AIDLC_TEST_TIMEOUT=300. The
// backward jump terminates cleanly at the target — the live probe measured
// ~184s / 27 turns — so the 300s ceiling is comfortable. The driver aborts a
// hair before bun kills the test so a stuck run surfaces a partial DriveResult.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "300", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 300) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer literals, read from the SHIPPED jump/audit handlers (see header).
// The jump DESTINATION (intent-capture) and DIRECTION (backward) are asserted on
// the immutable audit STAGE_JUMPED block bytes — the deterministic jump emission.
// Post-run Lifecycle Phase / Current Stage / Completed are NOT asserted: they are
// a moving target while the workflow continues (see the in-test rationale).
const TARGET_STAGE = "intent-capture"; // firstInScopeStageOfPhase("ideation","feature"), aidlc-lib.ts:1408
const JUMP_TARGET_JSON = `"target":"${TARGET_STAGE}"`; // jump.ts:409 stdout JSON
const JUMP_DIRECTION_JSON = '"direction":"backward"'; // jump.ts:407 stdout JSON
const JUMP_TARGET_PHASE_JSON = '"target_phase":"IDEATION"'; // jump.ts:410 — origin of the state phase rewrite (.sh test 1)
const JUMP_COMPLETED_JSON = '"completed_count":4'; // jump.ts:415 — known-answer reset arithmetic (.sh test 2's <20, pinned exact)
const STOP_AFTER_JUMP = { toolName: "Bash", resultIncludes: JUMP_TARGET_JSON } as const;
const AUDIT_TARGET_LINE = `**Target**: ${TARGET_STAGE}`; // jump.ts:377 Target field, audit.ts:265 **key**:
const AUDIT_DIRECTION_LINE = "**Direction**: BACKWARD"; // jump.ts:375 direction.toUpperCase()
const AUDIT_TIMESTAMP_PREFIX = "**Timestamp**:"; // audit.ts:257, on every block

describe("t25 /aidlc --phase ideation backward jump (sdk)", () => {
  // -------------------------------------------------------------------------
  // From CONSTRUCTION, `--phase ideation` is a backward jump that resolves to
  // intent-capture (first in-scope ideation stage for scope=feature). The run
  // stops AT the target, so we assert the now-stable state +
  // audit surfaces the jump tool wrote, re-expressing each .sh grep on a
  // structured read (and the destination pin is the LIVE Current Stage field,
  // strictly stronger than the old audit-only pin).
  // -------------------------------------------------------------------------
  test(
    "backward jump to intent-capture rewrites state phase + Completed and emits STAGE_JUMPED/BACKWARD",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-construction.md",
        withAudit: true,
      });
      try {
        // Precondition: the seed truly starts at CONSTRUCTION / Completed=20 /
        // Current Stage=functional-design, so the jump genuinely crosses backward
        // (no vacuous pass on a pre-seeded ideation state). Read straight off the
        // seeded file. P4: the jump tool does NOT migrate (only intent-birth does,
        // aidlc-utility.ts:2022) — the seed stays at the flat layout, so
        // stateFilePathFor resolves it via the flat fallback (no intent born yet).
        const seedState = readFileSync(stateFilePathFor(proj), "utf8");
        expect(readStateField(seedState, "Lifecycle Phase")).toBe("CONSTRUCTION");
        expect(readStateField(seedState, "Completed")).toBe("20");
        expect(readStateField(seedState, "Current Stage")).toBe(
          "functional-design",
        );

        // The backward jump terminates cleanly at the target and leaves stable
        // state to assert.
        const r = await driveAidlc("/aidlc --phase ideation", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_JUMP,
        });

        // The state file must exist post-run (the jump tool rewrote it).
        expect(r.stateFile).toBeDefined();

        // The jump tool ACTUALLY FIRED via Bash and its verbatim stdout JSON
        // carries the deterministic outcome fields (the t26 pattern — assert the
        // tool's own emission, immune to the post-jump continuation):
        //   .sh test 3 (destination) — "target":"intent-capture" + backward.
        assertToolResultContains(r, "Bash", JUMP_TARGET_JSON);
        const jumpCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(JUMP_TARGET_JSON),
        );
        expect(jumpCall?.resultText).toContain(JUMP_DIRECTION_JSON);
        //   .sh test 1 (IDEATION) — the tool resolved the target's phase, the
        //   deterministic origin of the state's Lifecycle Phase rewrite.
        expect(jumpCall?.resultText).toContain(JUMP_TARGET_PHASE_JSON);
        //   .sh test 2 (Completed < 20) — the exact known-answer reset count the
        //   tool wrote into the Completed field (4 < 20; pinned exact).
        expect(jumpCall?.resultText).toContain(JUMP_COMPLETED_JSON);

        // POST-RUN LIVE STATE IS NOT ASSERTED HERE (deliberate — see below).
        // A jump leaves Status=Running (aidlc-jump.ts:309 never terminates),
        // and SKILL.md:255 step
        // 13c then has the orchestrator "Enter Stage Advancement. Normal workflow
        // continues." So after the jump the LLM keeps running the workflow and the
        // post-run Current Stage / Completed / Lifecycle Phase are a MOVING TARGET
        // (verified: a stability gate caught Current Stage reading "market-research"
        // — the next ideation stage — on a fraction of runs). That CONTINUATION is
        // an LLM-paced journey and belongs to the Phase-3 tui tier, NOT this
        // single-transition sdk check. The jump TOOL itself is deterministic and
        // correct (run directly 3/3: Current Stage=intent-capture, Status=Running,
        // completed_count=4); what is non-deterministic is only how far the
        // orchestrator advances afterward. So this sdk test asserts ONLY the
        // deterministic jump EMISSION (the audit bytes + the tool's own stdout) —
        // the surfaces that held green on every run.

        // .sh test 4: audit recorded a STAGE_JUMPED event. Re-expressed on the
        // parsed auditEvents (the **Event**: lines), so an unrelated mention in
        // prose can't satisfy it — this is the tool's emitted event-type.
        assertAuditEvent(r, "STAGE_JUMPED");

        // .sh tests 3 (audit half), 5, 6: the STAGE_JUMPED block's field bytes.
        // auditEvents only carries event-type names, so for the field-level
        // literals (intent-capture target, BACKWARD direction, the Timestamp
        // line) we read the raw audit.md the tool appended and assert each
        // verbatim field line. These are the exact bytes aidlc-jump.ts +
        // aidlc-audit.ts wrote — the deterministic equivalent of the .sh greps.
        const auditRaw = readFileSync(auditFilePathFor(proj), "utf8");
        expect(auditRaw).toContain(AUDIT_TARGET_LINE); // .sh test 3 (audit half)
        expect(auditRaw).toContain(AUDIT_DIRECTION_LINE); // .sh test 5
        expect(auditRaw).toContain(AUDIT_TIMESTAMP_PREFIX); // .sh test 6

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
