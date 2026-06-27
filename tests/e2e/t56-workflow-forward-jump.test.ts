// covers: subcommand:aidlc-jump:resolve, subcommand:aidlc-jump:execute, audit:STAGE_JUMPED
//
// t56-workflow-forward-jump.test.ts — SDK-harness port of
// tests/e2e/t56-workflow-forward-jump.sh (plan 8). Drives the real
// `/aidlc --stage requirements-analysis` through the Claude Agent SDK from a
// brownfield bugfix workflow seeded at init-done and asserts ONLY on
// deterministic surfaces — the jump tool's verbatim stdout JSON, the on-disk
// state fields, and the parsed audit events — NEVER on assistantText.
//
// ⛔ TRAP 2 (no headless auto-approve). The .sh drove `--stage reverse-engineering
// --scope bugfix` to completion under a headless auto-approve mode the refactor
// kills. We assert the deterministic jump EMISSION
// (the tool's own stdout JSON + the audit bytes + the post-jump state the tool
// wrote), stopping the SDK the instant the jump JSON lands — so the
// continuation is never asserted (the t26/t25/t57 pattern) and no
// terminal-stop is needed.
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
// (aidlc-jump.ts:142-145). With state present the engine names the mutation:
// a print directive carrying `aidlc-jump.ts execute --target
// requirements-analysis --direction forward --scope bugfix`; the conductor
// runs it via Bash and the tool's stdout JSON lands in a tool_result.
// executeJump's forward branch marks the in-flight intermediate
// reverse-engineering `[S]` (jump.ts:242-264), pivots Current Stage to
// requirements-analysis (jump.ts:313), keeps Lifecycle Phase INCEPTION
// (jump.ts:312 — both stages are inception), and appends STAGE_JUMPED
// (jump.ts:374) with Direction FORWARD.
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
//       -> the jump tool's stdout JSON landed in a Bash tool_result (a hang
//          leaves no jumpCall and the driver aborts on timeoutMs).
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
//       -> the jump stdout JSON `stages_skipped` is exactly
//          ["reverse-engineering"] (jump.ts:411) AND the post-run state
//          contains the `- [S] reverse-engineering` row. The .sh grepped a bare
//          `\[S\]`; we pin the tool's own list AND the on-disk marker.
//   6 reverse-engineering referenced in state
//       -> the `- [S] reverse-engineering` row IS the reference (the stage the
//          jump skipped past), and Current Stage === "requirements-analysis"
//          pins where the jump landed (jump.ts:313). Stronger than the .sh's
//          bare substring grep.
//   7 audit has STAGE_JUMPED
//       -> assertAuditEvent(r,"STAGE_JUMPED") (parsed **Event**: line;
//          jump.ts:374) + the raw **Direction**: FORWARD / **Target**:
//          requirements-analysis field bytes (jump.ts:375,377).
//   8 lifecycle phase is INCEPTION
//       -> the stdout JSON `"target_phase":"INCEPTION"` (jump.ts:410, the
//          origin of the state rewrite) AND readStateField(state,"Lifecycle
//          Phase") === "INCEPTION".
//
// Known-answer literals (read from the SHIPPED tool / fixture, not guessed):
//   - no-state --stage is read-only:  aidlc-orchestrate.ts emitJumpDirective no-state branch
//   - with-state --stage names the jump: aidlc-orchestrate.ts:1366-1380 (print directive)
//   - forward skip markers:   aidlc-jump.ts:242-264 ([S] for in-flight intermediates)
//   - Current Stage write:    aidlc-jump.ts:313
//   - Lifecycle Phase write:  aidlc-jump.ts:312 (target phase uppercased)
//   - STAGE_JUMPED emit:      aidlc-jump.ts:374; Direction :375; Target :377
//   - jump stdout JSON:       aidlc-jump.ts:406-420
//   - fixture: state-brownfield-init-done.md (Scope=bugfix, Current Stage=
//     reverse-engineering, Completed=3, Lifecycle Phase=INCEPTION)
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock (the
// jump). Generous per-test timeout; the driver aborts a hair early so a stuck
// run surfaces a partial DriveResult, not a hang.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertAuditEvent } from "../harness/assert.ts";
import {
  cleanupTestProject,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  auditFilePathFor,
  driveAidlc,
  readStateField,
} from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget. A seeded forward jump on Opus/Bedrock lands in a few
// minutes (the t25/t26 siblings measure ~3-6min); honour the AIDLC_TEST_TIMEOUT
// convention. The driver aborts ~15s before bun's per-test cap so a stuck run
// surfaces a partial DriveResult to diagnose.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer literals from the SHIPPED jump tool run on this exact fixture
// (see header). The jump stdout JSON is the deterministic emission under test.
const TARGET_SLUG = "requirements-analysis"; // jump target (inception 2.3)
const SKIPPED_SLUG = "reverse-engineering"; // the in-flight stage the jump skips (2.1)
const TARGET_PHASE = "INCEPTION"; // jump.ts:312/410
const SCOPE = "bugfix"; // carried by the fixture
const JUMP_TARGET_JSON = `"target":"${TARGET_SLUG}"`; // jump.ts:409
const JUMP_DIRECTION_JSON = '"direction":"forward"'; // jump.ts:407
const JUMP_TARGET_PHASE_JSON = `"target_phase":"${TARGET_PHASE}"`; // jump.ts:410
const JUMP_SKIPPED_JSON = `"stages_skipped":["${SKIPPED_SLUG}"]`; // jump.ts:411 (known answer)
// #369: a forward jump NEVER auto-terminates the workflow (the Test-Run terminal
// branch was removed). The tool always reports workflow_stopped:false and emits
// STAGE_STARTED, never WORKFLOW_COMPLETED. This is the deterministic guard that
// the deleted t54-compaction-and-test-run test used to carry for the test-run case.
const JUMP_NOT_STOPPED_JSON = '"workflow_stopped":false'; // jump.ts:388
const STOP_AFTER_JUMP = { toolName: "Bash", resultIncludes: JUMP_TARGET_JSON } as const;
const AUDIT_DIRECTION_LINE = "**Direction**: FORWARD"; // jump.ts:375
const AUDIT_TARGET_LINE = `**Target**: ${TARGET_SLUG}`; // jump.ts:377

describe("t56 /aidlc --stage requirements-analysis forward jump (sdk)", () => {
  // -------------------------------------------------------------------------
  // Brownfield bugfix workflow seeded at init-done (Current Stage=
  // reverse-engineering). `--stage requirements-analysis` is a genuine forward
  // jump: the in-flight intermediate is marked [S], the pointer pivots, and
  // STAGE_JUMPED/FORWARD lands in the audit. All eight .sh assertions
  // re-expressed on the jump tool's stdout JSON + the post-run state + audit.
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
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_JUMP,
        });

        // .sh test 1: no silent timeout — the jump tool's stdout JSON landed
        // in a Bash tool_result (the jump RAN; a hang leaves no jumpCall).
        const jumpCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(JUMP_TARGET_JSON),
        );
        expect(jumpCall).toBeDefined();
        // The same JSON pins the forward branch + the known-answer skip list.
        expect(jumpCall?.resultText).toContain(JUMP_DIRECTION_JSON);
        // .sh test 5 (tool half): stages_skipped is exactly the in-flight
        // reverse-engineering (jump.ts:411 — the known answer on this fixture).
        expect(jumpCall?.resultText).toContain(JUMP_SKIPPED_JSON);
        // .sh test 8 (tool half): the target's phase, the origin of the state
        // rewrite (jump.ts:410).
        expect(jumpCall?.resultText).toContain(JUMP_TARGET_PHASE_JSON);
        // #369: the forward jump did NOT auto-terminate. workflow_stopped is
        // false (the Test-Run terminal branch is gone, so this is now the only
        // possible outcome of a forward jump).
        expect(jumpCall?.resultText).toContain(JUMP_NOT_STOPPED_JSON);

        // .sh test 3: state file present post-run (the jump tool rewrote it).
        expect(r.stateFile).toBeDefined();
        const state = r.stateFile as string;

        // .sh test 4: scope is bugfix. Exact field (stronger than `grep bugfix`).
        expect(readStateField(state, "Scope")).toBe(SCOPE);

        // .sh test 5 (state half): the skipped stage carries the [S] marker on
        // disk (jump.ts:242-264 wrote it).
        expect(state).toMatch(/^- \[S\] reverse-engineering/m);

        // .sh test 6: reverse-engineering is referenced as the jumped-past
        // stage, and the pointer pivoted to the target (jump.ts:313).
        expect(readStateField(state, "Current Stage")).toBe(TARGET_SLUG);

        // .sh test 7: audit recorded STAGE_JUMPED (parsed **Event**: line) and
        // the raw Direction/Target field bytes tie it to THIS forward jump.
        assertAuditEvent(r, "STAGE_JUMPED");
        const auditRaw = readFileSync(auditFilePathFor(proj), "utf8");
        expect(auditRaw).toContain(AUDIT_DIRECTION_LINE);
        expect(auditRaw).toContain(AUDIT_TARGET_LINE);
        // #369: the jump emitted STAGE_STARTED for the target and did NOT emit a
        // WORKFLOW_COMPLETED (the test-run terminal-stop is removed). Pins the
        // post-removal behavior the deleted t54-compaction test used to guard.
        expect(auditRaw).toContain("**Event**: STAGE_STARTED");
        expect(auditRaw).not.toContain("**Event**: WORKFLOW_COMPLETED");

        // .sh test 8 (state half): lifecycle phase is INCEPTION (jump.ts:312).
        expect(readStateField(state, "Lifecycle Phase")).toBe(TARGET_PHASE);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
