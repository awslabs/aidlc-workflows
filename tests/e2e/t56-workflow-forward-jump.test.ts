// covers: subcommand:aidlc-jump:resolve, subcommand:aidlc-jump:execute, audit:STAGE_JUMPED
//
// t56-workflow-forward-jump.test.ts — SDK-harness port of
// tests/e2e/t56-workflow-forward-jump.sh (plan 8). Drives the real
// `/aidlc --stage requirements-analysis` through the Claude Agent SDK from a
// brownfield bugfix workflow seeded at init-done and asserts ONLY on
// deterministic surfaces: the engine calls the agent made and the step the
// person's `next` returned, the on-disk state fields, and the parsed audit
// events, NEVER assistantText.
//
// ⛔ TRAP 2 (no headless auto-approve). The .sh drove `--stage reverse-engineering
// --scope bugfix` to completion under a headless auto-approve mode the refactor
// kills. We assert the deterministic jump (the one engine call + the audit
// bytes + the post-jump state the tool wrote), stopping the SDK the instant the
// step the jump lands on arrives, so the continuation is never asserted (the
// t26/t25/t57 pattern) and no terminal-stop is needed.
//
// ⚠️ JOURNEY RE-BASED ON v0.6.x (FINDING, surfaced not softened). The .sh ran
// `--stage reverse-engineering --scope bugfix` against a STATELESS project and
// expected auto-init + jump. That journey NO LONGER EXISTS on the v0.6.x
// engine: with no state, `next --stage <slug>` emits a run-stage directive
// DIRECTLY off the graph — read-only, no init, no aidlc-jump execute, no
// aidlc-docs/ created (aidlc-orchestrate.ts emitJumpDirective's no-state
// branch: "No state file — resolve cannot compute a direction. Name the
// requested target directly off the graph"; verified live by probing the
// engine on a stateless project — directive emitted, zero files written). The
// forward-JUMP semantics the .sh actually asserted ([S] skip markers,
// STAGE_JUMPED, phase rewrite, scope) require existing state, so this port
// seeds the brownfield init-done fixture (Current Stage=reverse-engineering,
// Scope=bugfix, Completed=3) and jumps FORWARD to requirements-analysis. The
// .sh's auto-init slice (aidlc-docs created, state written, scope recorded at
// init) is owned by the fresh-init twins t52/t54/t59 — no coverage is lost.
//
// THE JOURNEY (verified against the SHIPPED tools, deterministically, 2026-06-10).
// From state-brownfield-init-done.md (Current Stage=reverse-engineering, idx
// 2.1), `--stage requirements-analysis` (idx 2.3) resolves direction=forward
// (aidlc-jump.ts). With state present the person's `next` runs
// `aidlc-jump.ts execute --target requirements-analysis --direction forward
// --scope bugfix` itself and returns Requirements Analysis's step, carrying the
// jump's own line, in that one Bash tool_result.
// executeJump's forward branch marks the in-flight intermediate
// reverse-engineering `[S]` (jump.ts), pivots Current Stage to
// requirements-analysis (jump.ts), keeps Lifecycle Phase INCEPTION
// (jump.ts - both stages are inception), and appends STAGE_JUMPED
// (jump.ts) with Direction FORWARD.
//
// KNOWN ANSWERS (from running the SHIPPED resolve+execute on this exact
// fixture): direction=forward · target=requirements-analysis ·
// target_phase=INCEPTION · stages_skipped=["reverse-engineering"] ·
// completed_count=3 · workflow_stopped=false · state gains
// `- [S] reverse-engineering — EXECUTE` · Current Stage=requirements-analysis ·
// audit gains **Event**: STAGE_JUMPED + **Direction**: FORWARD +
// **Target**: requirements-analysis.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface, equal-or-stronger):
//   1 not exit 124 (no silent timeout)
//       -> the step the jump lands on came back from the person's `next` in
//          one call (assertJumpInOneCall; a hang leaves no step and the driver
//          aborts on timeoutMs), with the line saying what it skipped.
//   2 aidlc-docs/ created
//       -> RELOCATED to the fresh-init twins (t52/t54/t59) — see the journey
//          re-base note. Here aidlc-docs/ is the seeded precondition.
//   3 state file created
//       -> r.stateFile !== undefined (sdk-drive reads aidlc-state.md off disk).
//   4 scope is bugfix
//       -> readStateField(state,"Scope") === "bugfix" (exact field, stronger
//          than the .sh's loose `grep bugfix`; carried by the fixture and
//          untouched by the jump).
//   5 skipped stages marked [S]
//       -> the post-jump state contains the `- [S] reverse-engineering` row
//          (jump.ts) and the step's line names it as skipped. The .sh grepped a
//          bare `\[S\]`; we pin the on-disk marker.
//   6 reverse-engineering referenced in state
//       -> the `- [S] reverse-engineering` row IS the reference (the stage the
//          jump skipped past), and Current Stage === "requirements-analysis"
//          pins where the jump landed (jump.ts). Stronger than the .sh's
//          bare substring grep.
//   7 audit has STAGE_JUMPED
//       -> assertAuditEvent(r,"STAGE_JUMPED") (parsed **Event**: line;
//          jump.ts) + the raw **Direction**: FORWARD / **Target**:
//          requirements-analysis field bytes (jump.ts).
//   8 lifecycle phase is INCEPTION
//       -> readStateField(state,"Lifecycle Phase") === "INCEPTION" (jump.ts,
//          the target phase uppercased).
//
// Known-answer literals (read from the SHIPPED tool / fixture, not guessed):
//   - no-state --stage is read-only:  aidlc-orchestrate.ts emitJumpDirective no-state branch
//   - with-state --stage makes the jump: aidlc-orchestrate.ts emitJumpDirective
//   - forward skip markers:   aidlc-jump.ts ([S] for in-flight intermediates)
//   - Current Stage write:    aidlc-jump.ts
//   - Lifecycle Phase write:  aidlc-jump.ts (target phase uppercased)
//   - STAGE_JUMPED emit:      aidlc-jump.ts, with its Direction and Target fields
//   - the step's jump line:   aidlc-jump.ts forwardJumpNotice
//   - fixture: state-brownfield-init-done.md (Scope=bugfix, Current Stage=
//     reverse-engineering, Completed=3, Lifecycle Phase=INCEPTION)
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock (the
// jump). Generous per-test timeout; the driver aborts a hair early so a stuck
// run surfaces a partial DriveResult, not a hang.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertAuditEvent, assertJumpInOneCall, stopAtStep } from "../harness/assert.ts";
import {
  cleanupTestProject,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  readAuditText,
  driveAidlc,
  readStateField,
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


// Known-answer literals from the SHIPPED jump tool run on this exact fixture
// (see header). The one call, the step's line and the state the jump wrote are
// the deterministic surfaces under test.
const TARGET_SLUG = "requirements-analysis"; // jump target (inception 2.3)
const SKIPPED_SLUG = "reverse-engineering"; // the in-flight stage the jump skips (2.1)
const TARGET_PHASE = "INCEPTION"; // aidlc-jump.ts movedState / handleExecute
const SCOPE = "bugfix"; // carried by the fixture
// aidlc-jump.ts forwardJumpNotice: what the jump passed over, said with the step.
const JUMP_LINE = "Moved to Requirements Analysis; skipped Reverse Engineering.";
const AUDIT_DIRECTION_LINE = "**Direction**: FORWARD"; // aidlc-jump.ts handleExecute
const AUDIT_TARGET_LINE = `**Target**: ${TARGET_SLUG}`; // aidlc-jump.ts handleExecute

describe("t56 /aidlc --stage requirements-analysis forward jump (sdk)", () => {
  // -------------------------------------------------------------------------
  // Brownfield bugfix workflow seeded at init-done (Current Stage=
  // reverse-engineering). `--stage requirements-analysis` is a genuine forward
  // jump: the in-flight intermediate is marked [S], the pointer pivots, and
  // STAGE_JUMPED/FORWARD lands in the audit.
  // -------------------------------------------------------------------------
  test(
    "forward jump marks reverse-engineering [S], pivots to requirements-analysis, logs STAGE_JUMPED/FORWARD, phase stays INCEPTION",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-brownfield-init-done.md",
        withBrownfieldStub: true,
        withAudit: true,
      });
      try {
        // Precondition: the seed truly starts AT reverse-engineering with
        // Scope=bugfix (no vacuous pass on a pre-jumped state).
        const seed = readFileSync(seededStateFile(proj), "utf8");
        expect(readStateField(seed, "Current Stage")).toBe(SKIPPED_SLUG);
        expect(readStateField(seed, "Scope")).toBe(SCOPE);

        const r = await driveAidlc(`/aidlc --stage ${TARGET_SLUG}`, {
          projectDir: proj,
          // No gate is expected on the jump path; "default" answers any
          // AskUserQuestion as option 1 so the harness never stalls.
          answerScript: "default",
          timeoutMs: remainingWorkMs(),
          stopAfterToolResult: stopAtStep(TARGET_SLUG),
        });

        // No silent timeout, and one engine call: the person's `next` made the
        // jump and returned Requirements Analysis's step; the agent never ran the
        // jump tool. That step carries the line saying what the jump skipped.
        assertJumpInOneCall(r, TARGET_SLUG);
        const step = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(stopAtStep(TARGET_SLUG).resultIncludes),
        );
        expect(step?.resultText).toContain(JUMP_LINE);
        // #369: the forward jump did NOT auto-terminate the workflow.
        expect(readStateField(r.stateFile ?? "", "Status")).toBe("Running");

        expect(r.stateFile).toBeDefined();
        const state = r.stateFile as string;

        expect(readStateField(state, "Scope")).toBe(SCOPE);

        // The skipped stage carries the [S] marker on disk (aidlc-jump.ts movedState
        // wrote it).
        expect(state).toMatch(/^- \[S\] reverse-engineering/m);

        // reverse-engineering is referenced as the jumped-past stage, and the pointer
        // pivoted to the target (aidlc-jump.ts movedState).
        expect(readStateField(state, "Current Stage")).toBe(TARGET_SLUG);

        // Audit recorded STAGE_JUMPED (parsed **Event**: line) and contains the raw
        // Direction/Target field bytes (file-wide checks).
        assertAuditEvent(r, "STAGE_JUMPED");
        const auditRaw = readAuditText(proj);
        expect(auditRaw).toContain(AUDIT_DIRECTION_LINE);
        expect(auditRaw).toContain(AUDIT_TARGET_LINE);
        // #369: the jump emitted STAGE_STARTED for the target and did NOT emit a
        // WORKFLOW_COMPLETED.
        expect(auditRaw).toContain("**Event**: STAGE_STARTED");
        expect(auditRaw).not.toContain("**Event**: WORKFLOW_COMPLETED");

        // Lifecycle phase is INCEPTION (aidlc-jump.ts movedState).
        expect(readStateField(state, "Lifecycle Phase")).toBe(TARGET_PHASE);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
