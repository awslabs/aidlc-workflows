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
// `aidlc-jump.ts resolve` (SKILL.md:206) then `aidlc-jump.ts execute`
// (SKILL.md:223). It ADDS `audit:STAGE_JUMPED` — a currently-UNCOVERED unit
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
// (target index 10 < current index, aidlc-jump.ts:144), so executeJump's
// backward branch resets target + downstream EXECUTE stages [x]/[-]/[S] → [ ]
// (aidlc-jump.ts:268-285), pivots Current Stage to the target
// (aidlc-jump.ts:313), and rewrites Lifecycle Phase to the target's phase
// uppercased (aidlc-jump.ts:312 — reverse-engineering is an INCEPTION stage).
// A jump always lands Status="Running" (aidlc-jump.ts:309 → never terminates),
// so the
// orchestrator CONTINUES after the jump — which is exactly why this port
// asserts the jump tool's OWN stdout emission (stopAfterToolResult the instant
// it lands) rather than the final on-disk state the .sh raced against. The
// transient target-checkbox [-]→[x] churn (the .sh's own header note,
// t57.sh:6-9) is deliberately NOT asserted by either suite.
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
//          (jump.ts:409 — the deterministic origin of the Current Stage write,
//          jump.ts:313) PLUS the audit `**Target**: reverse-engineering` line.
//   2 X_COUNT < 15 (fixture had 20 [x]; .sh comment said "19")
//       -> stdout JSON `"completed_count":11` (jump.ts:415 — the value the tool
//          wrote into Completed, jump.ts:330-331). STRONGER than the .sh's <15:
//          pins the exact reset arithmetic on an emission immune to the
//          post-jump continuation.
//   3 audit has STAGE_JUMPED
//       -> assertAuditEvent(r, "STAGE_JUMPED")
//          [aidlc-jump.ts:374 emitAudit(pd,"STAGE_JUMPED",...); rendered as
//           `**Event**: STAGE_JUMPED` at aidlc-audit.ts:258, which
//           readAuditEvents parses off the `**Event**:` line]
//   4 audit records BACKWARD (direction tag)
//       -> raw audit.md (read off disk) contains the verbatim field line
//          `**Direction**: BACKWARD` AND `**Target**: reverse-engineering`
//          [aidlc-jump.ts:375 Direction: direction.toUpperCase(), :377 Target;
//           rendered as `**${key}**: ${value}` field lines at aidlc-audit.ts:265].
//          Stronger than the .sh's bare `grep BACKWARD`: pins the exact field
//          shape AND ties the direction to the reverse-engineering jump, so an
//          unrelated future use of "BACKWARD" can't satisfy it. PLUS the stdout
//          `"direction":"backward"` (jump.ts:407).
//   5 Lifecycle Phase = INCEPTION
//       -> stdout JSON `"target_phase":"INCEPTION"` (jump.ts:410 — the
//          deterministic origin of the Lifecycle Phase rewrite, jump.ts:312;
//          reverse-engineering's phase is "inception" -> "INCEPTION")
//
// Known-answer literals (read from the SHIPPED handler / fixture, not guessed):
//   - jump dispatch:        SKILL.md:204-223 -> the orchestrator shells
//                           `bun .claude/tools/aidlc-jump.ts resolve` then
//                           `... execute --target reverse-engineering
//                           --direction backward --scope feature` via Bash.
//   - backward reset branch: aidlc-jump.ts:268-285
//   - Current Stage write:   aidlc-jump.ts:313
//   - Lifecycle Phase write: aidlc-jump.ts:312
//   - STAGE_JUMPED emit:     aidlc-jump.ts:374; Direction field aidlc-jump.ts:375
//   - audit block shape:     aidlc-audit.ts:256-267
//   - jump stdout JSON:      aidlc-jump.ts:406-420 (direction/target/target_phase/
//                            completed_count/...); known-answer completed_count=11
//                            confirmed by running the shipped tool on the fixture.
//   - fixture state-construction.md: Scope=feature, Lifecycle Phase=CONSTRUCTION,
//     Current Stage=functional-design (idx > RE's 10 -> backward), 20 [x] stages.
//   - reverse-engineering EXECUTEs under feature scope: scope-mapping.json:21.
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Asserts ONLY on tool stdout JSON / auditEvents / raw audit.md — NEVER on assistantText.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { assertAuditEvent } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  auditFilePathFor,
  driveAidlc,
  readStateFile,
} from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget — a backward-jump turn re-runs the target stage on Opus, so
// honour the suite's AIDLC_TEST_TIMEOUT convention (the .sh mirror t26 set it
// to 600s; t57.sh used the suite default). The driver aborts a hair before bun
// kills the test so a stuck run surfaces a partial DriveResult, not a hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer literals from the SHIPPED handler / seeded fixture (see header).
const TARGET_SLUG = "reverse-engineering"; // jump target (inception stage 2.1)
const DIRECTION_FIELD = "**Direction**: BACKWARD"; // aidlc-jump.ts:375 + audit field shape (aidlc-audit.ts:265)
const TARGET_FIELD = `**Target**: ${TARGET_SLUG}`; // aidlc-jump.ts:377 — names WHICH jump
const JUMP_TARGET_JSON = `"target":"${TARGET_SLUG}"`; // aidlc-jump.ts:409 stdout JSON
const JUMP_DIRECTION_JSON = '"direction":"backward"'; // aidlc-jump.ts:407 stdout JSON
const JUMP_TARGET_PHASE_JSON = '"target_phase":"INCEPTION"'; // aidlc-jump.ts:410 — origin of the phase rewrite (.sh test 5)
const JUMP_COMPLETED_JSON = '"completed_count":11'; // aidlc-jump.ts:415 — known-answer (20 [x] - 9 resets; .sh test 2's <15, pinned exact)
const STOP_AFTER_JUMP = { toolName: "Bash", resultIncludes: JUMP_TARGET_JSON } as const;
const COMPLETED_CEILING = 15; // .sh test 2 threshold (fixture sanity floor below)

/** Count of `- [x]` (completed) checkbox lines in a state-file string —
 *  the deterministic equivalent of the .sh's `grep -c '^\- \[x\]'`. */
function completedCount(stateText: string): number {
  return (stateText.match(/^- \[x\]/gm) ?? []).length;
}

describe("t57 workflow backward jump (sdk)", () => {
  // -------------------------------------------------------------------------
  // Backward jump from a construction-phase fixture to reverse-engineering.
  //
  // The fixture seeds 20 completed [x] stages with Current Stage in
  // construction (functional-design). `--stage reverse-engineering` resolves
  // to a BACKWARD jump (target idx 10 < current idx). All five .sh assertions
  // re-expressed on the post-run state + audit files, read off disk.
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
        // so test 2 can pin "strictly fewer than before" (stronger than the
        // .sh's static "< 15"). The construction fixture carries 20 [x].
        const stateBefore = readStateFile(proj);
        expect(stateBefore).toBeDefined();
        const completedBefore = completedCount(stateBefore as string);
        // Guard the fixture itself didn't drift — the jump arithmetic depends
        // on a high pre-jump count (the .sh comment said 19; disk says 20).
        expect(completedBefore).toBeGreaterThanOrEqual(COMPLETED_CEILING);

        // Stop the SDK the
        // instant the jump tool's stdout JSON lands so the LLM-paced
        // continuation never moves the surfaces under assertion.
        const r = await driveAidlc(`/aidlc --stage ${TARGET_SLUG}`, {
          projectDir: proj,
          // "default" answers any AskUserQuestion as DATA (option 1) so the
          // harness never stalls if a gate fires before the stop condition.
          answerScript: "default",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_JUMP,
        });

        // The jump tool ACTUALLY FIRED via Bash and its verbatim stdout JSON
        // carries the deterministic outcome fields (the t26 pattern):
        const jumpCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(JUMP_TARGET_JSON),
        );
        expect(jumpCall).toBeDefined();

        // .sh test 1: the jump pivoted to reverse-engineering — the tool's own
        // `"target"` emission, the deterministic origin of the Current Stage
        // write (jump.ts:313,409). Direction pins the backward branch.
        expect(jumpCall?.resultText).toContain(JUMP_DIRECTION_JSON);

        // .sh test 5: Lifecycle Phase rewritten to INCEPTION — the tool's
        // `"target_phase"` emission (jump.ts:312,410).
        expect(jumpCall?.resultText).toContain(JUMP_TARGET_PHASE_JSON);

        // .sh test 2: significant downstream reset. The exact known-answer the
        // tool computed (jump.ts:330-331,415): 11 = 20 [x] - 9 in-scope EXECUTE
        // resets. Pins the .sh's <15 bound exactly.
        expect(jumpCall?.resultText).toContain(JUMP_COMPLETED_JSON);

        // .sh test 3: audit recorded the backward jump as STAGE_JUMPED
        // (aidlc-jump.ts:374). assertAuditEvent parses the `**Event**:` line
        // (aidlc-audit.ts:258) off the post-run audit.md — naming WHY the log
        // grew, stronger than a bare substring grep.
        assertAuditEvent(r, "STAGE_JUMPED");

        // .sh test 4: audit tags the direction BACKWARD. Read the raw audit.md
        // off disk and assert the verbatim field line the jump tool wrote
        // (aidlc-jump.ts:375 -> `**Direction**: BACKWARD`, the
        // `**${key}**: ${value}` field shape at aidlc-audit.ts:265). The
        // `**Direction**:` prefix is NOT an `**Event**:` line, so it never
        // appears in readAuditEvents — we read the file directly. Pinning the
        // full field line is stronger than the .sh's loose `grep BACKWARD`.
        const auditPath = auditFilePathFor(proj);
        expect(existsSync(auditPath)).toBe(true);
        const auditRaw = readFileSync(auditPath, "utf8");
        expect(auditRaw).toContain(DIRECTION_FIELD);
        // And the SAME audit event names the target (aidlc-jump.ts:377) — so the
        // BACKWARD direction line provably belongs to the reverse-engineering
        // jump, not an unrelated event (mirrors t56's Target/Scope pinning).
        expect(auditRaw).toContain(TARGET_FIELD);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
