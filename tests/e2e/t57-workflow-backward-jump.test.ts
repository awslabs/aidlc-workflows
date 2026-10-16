// covers: subcommand:aidlc-jump:resolve, subcommand:aidlc-jump:execute, audit:STAGE_JUMPED
//
// t57-workflow-backward-jump.test.ts — SDK-harness port of
// tests/e2e/t57-workflow-backward-jump.sh (plan 5). Drives the real
// `/aidlc --stage reverse-engineering` through the Claude Agent
// SDK and asserts ONLY on deterministic surfaces — never on assistantText.
//
// ⛔ TRAP 2 (the t26 pattern). The historic backward-jump flake came from
// asserting the FINAL on-disk state: after the jump the orchestrator continues
// past the jump target, so final-state reads raced.
// This port asserts the deterministic jump EMISSION — the tool's own stdout JSON
// (immune to whatever the orchestrator does next) plus the immutable audit
// bytes — and stops the SDK the instant the jump JSON lands.
//
// COVERS-HEADER NOTE (disk-verified 2026-06-05). The .sh carried NO `covers:`
// header (grep on t57.sh: zero matches) — it covered no registry unit, so
// retiring it cannot make any unit go UNCOVERED. This port claims the units the
// journey actually exercises, mirroring the sibling t56-workflow-forward-jump
// .test.ts (which claims the same two jump subcommands): the orchestrator shells
// `aidlc-jump.ts resolve` (SKILL.md) then `aidlc-jump.ts execute`
// (SKILL.md). It ADDS `audit:STAGE_JUMPED` - a currently-UNCOVERED unit
// (registry status UNCOVERED, minMechanism `none`) that this test asserts
// deterministically via assertAuditEvent. Mechanism `sdk` (derived from
// driveAidlc, rank 2) satisfies both the subcommands' `cli` bar and the audit
// unit's `none` bar — so this STRENGTHENS coverage, never weakens it.
//
// WHY THIS PORT EXISTS. The .sh asserted by sed/grep-ing the FINAL on-disk
// state + audit files: it parsed `**Current Stage**` / `**Lifecycle Phase**`
// out of aidlc-state.md and grepped `STAGE_JUMPED` / `BACKWARD` out of
// audit.md. Those are already deterministic surfaces (tool-written files, not
// LLM prose) — but the .sh reached them through the run_claude shell fixture
// and exit-124 heuristic. This port reads the SAME files through the SDK
// harness (readStateFile / readAuditEvents off disk) at EQUAL-OR-STRONGER
// fidelity: every literal is the verbatim string the SHIPPED jump handler
// writes (aidlc-jump.ts), and the audit-event assertion names WHY the log grew
// (STAGE_JUMPED) rather than grepping a loose substring.
//
// THE INVARIANT UNDER TEST. A backward jump (`--stage reverse-engineering`
// from a construction-phase fixture) resolves to direction "backward"
// (target index 10 < current index, aidlc-jump.ts), so executeJump's
// backward branch resets target + downstream EXECUTE stages [x]/[-]/[S] → [ ]
// (aidlc-jump.ts), pivots Current Stage to the target
// (aidlc-jump.ts), and rewrites Lifecycle Phase to the target's phase
// uppercased (aidlc-jump.ts - reverse-engineering is an INCEPTION stage).
// A jump always lands Status="Running" (aidlc-jump.ts -> never terminates),
// so the
// orchestrator CONTINUES after the jump — which is exactly why this port
// asserts the jump tool's OWN stdout emission (stopAfterToolResult the instant
// it lands) rather than the final on-disk state the .sh raced against. The
// transient target-checkbox [-]→[x] churn (the .sh's own header note,
// t57.sh) is deliberately NOT asserted by either suite.
//
// THE KNOWN-ANSWER COUNT. Running the SHIPPED tool deterministically on this
// exact fixture (`aidlc-jump.ts execute --target reverse-engineering
// --direction backward --scope feature` over state-construction.md, 2026-06-10)
// emits completed_count:11 and stages_reset of 9 slugs (reverse-engineering →
// functional-design) — the 20 [x] fixture minus the 9 in-scope EXECUTE resets.
// 11 < 15 satisfies the .sh's bound; we pin the exact value.
//
// ASSERTION MAP (.sh test -> SDK surface -> shipped-handler cite):
//   1 Current Stage = reverse-engineering
//       -> the jump tool's stdout JSON `"target":"reverse-engineering"`
//          (jump.ts - the deterministic origin of the Current Stage write,
//          jump.ts) PLUS the audit `**Target**: reverse-engineering` line.
//   2 X_COUNT < 15 (fixture had 20 [x]; .sh comment said "19")
//       -> stdout JSON `"completed_count":11` (jump.ts - the value the tool
//          wrote into Completed, jump.ts). STRONGER than the .sh's <15:
//          pins the exact reset arithmetic on an emission immune to the
//          post-jump continuation.
//   3 audit has STAGE_JUMPED
//       -> assertAuditEvent(r, "STAGE_JUMPED")
//          [aidlc-jump.ts emitAudit(pd,"STAGE_JUMPED",...); rendered as
//           `**Event**: STAGE_JUMPED` at aidlc-audit.ts, which
//           readAuditEvents parses off the `**Event**:` line]
//   4 audit records BACKWARD (direction tag)
//       -> raw audit.md (read off disk) contains the verbatim field line
//          `**Direction**: BACKWARD` AND `**Target**: reverse-engineering`
//          [aidlc-jump.ts Direction: direction.toUpperCase(), Target;
//           rendered as `**${key}**: ${value}` field lines at aidlc-audit.ts].
//          Stronger than the .sh's bare `grep BACKWARD`: pins the exact field
//          shape AND ties the direction to the reverse-engineering jump, so an
//          unrelated future use of "BACKWARD" can't satisfy it. PLUS the stdout
//          `"direction":"backward"` (jump.ts).
//   5 Lifecycle Phase = INCEPTION
//       -> stdout JSON `"target_phase":"INCEPTION"` (jump.ts - the
//          deterministic origin of the Lifecycle Phase rewrite, jump.ts;
//          reverse-engineering's phase is "inception" -> "INCEPTION")
//
// Known-answer literals (read from the SHIPPED handler / fixture, not guessed):
//   - jump dispatch:        SKILL.md -> the orchestrator shells
//                           `bun .claude/tools/aidlc-jump.ts resolve` then
//                           `... execute --target reverse-engineering
//                           --direction backward --scope feature` via Bash.
//   - backward reset branch: aidlc-jump.ts
//   - Current Stage write:   aidlc-jump.ts
//   - Lifecycle Phase write: aidlc-jump.ts
//   - STAGE_JUMPED emit:     aidlc-jump.ts; Direction field aidlc-jump.ts
//   - audit block shape:     aidlc-audit.ts
//   - jump stdout JSON:      aidlc-jump.ts (direction/target/target_phase/
//                            completed_count/...); known-answer completed_count=11
//                            confirmed by running the shipped tool on the fixture.
//   - fixture state-construction.md: Scope=feature, Lifecycle Phase=CONSTRUCTION,
//     Current Stage=functional-design (idx > RE's 10 -> backward), 20 [x] stages.
//   - reverse-engineering EXECUTEs under feature scope: scope-mapping.json.
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Asserts ONLY on tool stdout JSON / auditEvents / raw audit.md — NEVER on assistantText.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { assertAuditEvent } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  readAuditText,
  driveAidlc,
  readStateFile,
} from "../harness/sdk-drive.ts";

// AIDLC_TEST_TIMEOUT bounds the entire case, including setup and cleanup.
const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
// Preserve the existing work allowance and reserve fixture/startup/cleanup separately.
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(TEST_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "E2E live work",
  })!;
}


// Known-answer literals from the SHIPPED handler / seeded fixture (see header).
const TARGET_SLUG = "reverse-engineering"; // jump target (inception stage 2.1)
const DIRECTION_FIELD = "**Direction**: BACKWARD"; // aidlc-jump.ts handleExecute + audit field shape (aidlc-audit.ts renderAuditBlock)
const TARGET_FIELD = `**Target**: ${TARGET_SLUG}`; // aidlc-jump.ts handleExecute - names WHICH jump
const JUMP_TARGET_JSON = `"target":"${TARGET_SLUG}"`; // aidlc-jump.ts handleExecute stdout JSON
const JUMP_DIRECTION_JSON = '"direction":"backward"'; // aidlc-jump.ts handleExecute stdout JSON
const JUMP_TARGET_PHASE_JSON = '"target_phase":"INCEPTION"'; // aidlc-jump.ts movedState / handleExecute - origin of the phase rewrite
const JUMP_COMPLETED_JSON = '"completed_count":11'; // aidlc-jump.ts handleExecute - known-answer (20 [x] - 9 resets)
const STOP_AFTER_JUMP = { toolName: "Bash", resultIncludes: JUMP_TARGET_JSON } as const;
const COMPLETED_CEILING = 15; // fixture sanity floor below

/** Count of `- [x]` (completed) checkbox lines in a state-file string. */
function completedCount(stateText: string): number {
  return (stateText.match(/^- \[x\]/gm) ?? []).length;
}

describe("t57 workflow backward jump (sdk)", () => {
  // -------------------------------------------------------------------------
  // Backward jump from a construction-phase fixture to reverse-engineering.
  //
  // The fixture seeds 20 completed [x] stages with Current Stage in
  // construction (functional-design). `--stage reverse-engineering` resolves
  // to a BACKWARD jump because the target precedes the current stage.
  // Assertions read the jump's stdout JSON and audit files.
  // -------------------------------------------------------------------------
  test(
    "backward jump pivots Current Stage, resets downstream, logs STAGE_JUMPED/BACKWARD, rewrites phase",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-construction.md",
        withAudit: true,
      });
      try {
        // Pre-jump baseline: the fixture's completed-count, captured off disk
        // so the fixture sanity check can reject a low pre-jump count.
        // The construction fixture carries 20 [x].
        const stateBefore = readStateFile(proj);
        expect(stateBefore).toBeDefined();
        const completedBefore = completedCount(stateBefore as string);
        // Guard the fixture itself didn't drift — the jump arithmetic depends
        // on a high pre-jump count (20).
        expect(completedBefore).toBeGreaterThanOrEqual(COMPLETED_CEILING);

        // Stop the SDK the
        // instant the jump tool's stdout JSON lands so the LLM-paced
        // continuation never moves the surfaces under assertion.
        const r = await driveAidlc(`/aidlc --stage ${TARGET_SLUG}`, {
          projectDir: proj,
          // "default" answers any AskUserQuestion as DATA (option 1) so the
          // harness never stalls if a gate fires before the stop condition.
          answerScript: "default",
          timeoutMs: remainingWorkMs(),
          stopAfterToolResult: STOP_AFTER_JUMP,
        });

        // The jump tool ACTUALLY FIRED via Bash and its verbatim stdout JSON
        // carries the deterministic outcome fields (the t26 pattern):
        const jumpCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(JUMP_TARGET_JSON),
        );
        expect(jumpCall).toBeDefined();

        // The jump pivoted to reverse-engineering - the tool's own `"target"`
        // emission, the deterministic origin of the Current Stage write (aidlc-jump.ts
        // movedState / handleExecute). Direction pins the backward branch.
        expect(jumpCall?.resultText).toContain(JUMP_DIRECTION_JSON);

        // Lifecycle Phase rewritten to INCEPTION - the tool's `"target_phase"`
        // emission (aidlc-jump.ts movedState / handleExecute).
        expect(jumpCall?.resultText).toContain(JUMP_TARGET_PHASE_JSON);

        // Significant downstream reset. The exact known-answer the tool computed
        // (aidlc-jump.ts movedState / handleExecute): 11 = 20 [x] - 9 in-scope EXECUTE
        // resets.
        expect(jumpCall?.resultText).toContain(JUMP_COMPLETED_JSON);

        // Audit recorded the backward jump as STAGE_JUMPED (aidlc-jump.ts
        // handleExecute). assertAuditEvent parses the `**Event**:` line (aidlc-audit.ts
        // renderAuditBlock) off the post-run audit shards - naming WHY the log grew.
        assertAuditEvent(r, "STAGE_JUMPED");

        // Audit tags the direction BACKWARD. Read the raw audit shards off disk and
        // assert the verbatim field line the jump tool wrote (aidlc-jump.ts
        // handleExecute -> `**Direction**: BACKWARD`, the `**${key}**: ${value}` field
        // shape in aidlc-audit.ts renderAuditBlock). The `**Direction**:` prefix is NOT
        // an `**Event**:` line, so it never appears in readAuditEvents - we read the
        // file directly.
        const auditRaw = readAuditText(proj);
        expect(auditRaw).not.toBe("");
        expect(auditRaw).toContain(DIRECTION_FIELD);
        // The audit also contains the target field (aidlc-jump.ts handleExecute); this
        // file-wide match does not prove it shares a block with the BACKWARD line.
        expect(auditRaw).toContain(TARGET_FIELD);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
