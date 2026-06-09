// covers: subcommand:aidlc-jump:resolve, subcommand:aidlc-jump:execute, audit:STAGE_JUMPED
//
// t57-workflow-backward-jump.test.ts — SDK-harness port of
// tests/workflow/t57-workflow-backward-jump.sh (plan 5). Drives the real
// `/aidlc --stage reverse-engineering --test-run` through the Claude Agent SDK
// and asserts ONLY on deterministic surfaces — never on assistantText.
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
// Under --test-run + --stage, the jump is NOT a forward terminal
// (willTerminate = testRunMode && direction === "forward", aidlc-jump.ts:310 →
// false for backward), so Status stays "Running" and SKILL.md step 13a stops
// at the target WITHOUT entering Stage Advancement (SKILL.md:246-247) — the
// orchestrator re-runs only the target stage, so downstream stays [ ] and the
// completed-count stays low. These are the same robust invariants the .sh
// asserted; the transient target-checkbox [-]→[x] churn (the .sh's own header
// note, t57.sh:6-9) is deliberately NOT asserted by either suite.
//
// ASSERTION MAP (.sh test -> SDK surface -> shipped-handler cite):
//   1 Current Stage = reverse-engineering
//       -> assertStateField(r, "Current Stage", "reverse-engineering")
//          [aidlc-jump.ts:313 setField(content,"Current Stage",targetSlug)]
//   2 X_COUNT < 15 (fixture had 20 [x]; .sh comment said "19")
//       -> count of `- [x]` lines in r.stateFile dropped below 15 AND strictly
//          below the fixture's pre-jump count (20). The backward branch resets
//          the target (RE, idx 10) + every downstream EXECUTE [x] to pending
//          [aidlc-jump.ts:268-285], so ~15 stages reset — stronger than the
//          .sh's "< 15" alone because we also pin "< pre-jump".
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
//          unrelated future use of "BACKWARD" can't satisfy it.
//   5 Lifecycle Phase = INCEPTION
//       -> assertStateField(r, "Lifecycle Phase", "INCEPTION")
//          [aidlc-jump.ts:312 setField(content,"Lifecycle Phase",
//           targetStage.phase.toUpperCase()); reverse-engineering's phase is
//           "inception" -> "INCEPTION"]
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
//   - fixture state-construction.md: Scope=feature, Lifecycle Phase=CONSTRUCTION,
//     Current Stage=functional-design (idx > RE's 10 -> backward), 20 [x] stages.
//   - reverse-engineering EXECUTEs under feature scope: scope-mapping.json:21.
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Asserts ONLY on stateFile / auditEvents / raw audit.md — NEVER on assistantText.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { assertAuditEvent, assertStateField } from "../harness/assert.ts";
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
const TARGET_PHASE = "INCEPTION"; // aidlc-jump.ts:312 targetStage.phase.toUpperCase()
const DIRECTION_FIELD = "**Direction**: BACKWARD"; // aidlc-jump.ts:375 + audit field shape (aidlc-audit.ts:265)
const TARGET_FIELD = `**Target**: ${TARGET_SLUG}`; // aidlc-jump.ts:377 — names WHICH jump
const JUMP_TARGET_JSON = `"target":"${TARGET_SLUG}"`; // aidlc-jump.ts:409 stdout JSON
const STOP_AFTER_JUMP = { toolName: "Bash", resultIncludes: JUMP_TARGET_JSON } as const;
const COMPLETED_CEILING = 15; // .sh test 2 threshold

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

        const r = await driveAidlc(
          `/aidlc --stage ${TARGET_SLUG} --test-run`,
          {
            projectDir: proj,
            // No gate is expected on the deterministic backward-jump path under
            // --test-run; "default" answers any AskUserQuestion as DATA (option
            // 1) so the harness never stalls if one fires.
            answerScript: "default",
            timeoutMs: DRIVE_TIMEOUT_MS,
            stopAfterToolResult: STOP_AFTER_JUMP,
          },
        );

        // .sh test 1: Current Stage pivoted to the jump target. The jump tool
        // writes this field (aidlc-jump.ts:313) and the --test-run+--stage
        // terminal stops at the target without advancing, so it survives the
        // run. assertStateField fails loudly if the field is absent — no
        // vacuous pass.
        assertStateField(r, "Current Stage", TARGET_SLUG);

        // .sh test 5: Lifecycle Phase rewritten to the target stage's phase
        // (aidlc-jump.ts:312). reverse-engineering is an inception stage, so
        // the field is "INCEPTION".
        assertStateField(r, "Lifecycle Phase", TARGET_PHASE);

        // .sh test 2: significant downstream reset. The backward branch reset
        // the target + downstream EXECUTE [x] stages to pending
        // (aidlc-jump.ts:268-285), so the completed-count must have dropped
        // below 15 AND strictly below the fixture's pre-jump count.
        expect(r.stateFile).toBeDefined();
        const completedAfter = completedCount(r.stateFile as string);
        expect(completedAfter).toBeLessThan(COMPLETED_CEILING);
        expect(completedAfter).toBeLessThan(completedBefore);

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
