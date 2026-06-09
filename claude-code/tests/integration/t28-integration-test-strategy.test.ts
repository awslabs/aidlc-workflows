// covers: subcommand:aidlc-utility:config-change, audit:TEST_STRATEGY_CHANGED
//
// t28-integration-test-strategy.test.ts — SDK-harness port of
// tests/integration/t28-integration-test-strategy.sh (plan 6). Drives the real
// /aidlc --test-strategy / --depth through the Claude Agent SDK and asserts
// ONLY on deterministic surfaces — never on assistantText. Mechanism `sdk` is
// DERIVED from the driveAidlc() call below (Phase 0 derive-by-driver), so the
// filename carries no mechanism segment.
//
// WHY THIS PORT EXISTS. The .sh proved the test-strategy override path two
// ways: deterministically (state field + audit event, on disk) and — for the
// invalid arm — by grepping the LLM's rendered OUTPUT ($CLAUDE_OUTPUT) for
// "Unknown test strategy". The deterministic arms re-express cleanly onto
// on-disk state + parsed audit events. The prose grep does NOT (see the
// UNPORTABLE note below): SKILL.md:114 has the LLM validate --test-strategy
// itself and emit the error IN PROSE before any tool runs — there is no tool
// die() in the orchestrator path, so no Bash isError / ERROR_LOGGED surface is
// guaranteed. That arm's deterministic equivalent (config-change --test-strategy
// extreme -> stderr "Unknown test strategy", exit 1) is ALREADY covered at the
// CLI tier by tests/unit/t27.cli.test.ts (the config-change invalid-strategy
// case). Per the iron rule we do NOT re-assert it here on the non-deterministic
// assistantText surface — we surface it as a finding instead of weakening.
//
// ASSERTION MAP (.sh assertion -> deterministic SDK surface):
//   A1 STATE_A grep 'Test Strategy.*Minimal'  -> assertStateField "Test Strategy" === "Minimal"
//                                                 (config-change setField, utility.ts:2389; VALID_TEST_STRATEGIES, utility.ts:68-72)
//   A2 AUDIT_A grep 'TEST_STRATEGY_CHANGED'    -> assertAuditEvent "TEST_STRATEGY_CHANGED"
//                                                 (appendAuditEvent, utility.ts:2406; VALID_EVENT_TYPES, aidlc-audit.ts:60)
//   B1 CLAUDE_OUTPUT contains "Unknown test    -> UNPORTABLE to a deterministic SDK surface (LLM-prose
//      strategy"                                  validation by SKILL.md:114). Deterministic equivalent
//                                                  (CLI die() -> stderr, utility.ts:2373) is covered by
//                                                  t27.cli.test.ts. Surfaced as a finding; NOT asserted on prose.
//   C1 STATE_C grep 'Depth.*Standard'          -> assertStateField "Depth" === "Standard"
//                                                 (no-op: fixture Depth already Standard; config-change
//                                                  leaves it, utility.ts:2385/2399; prints "Depth is already Standard")
//   C2 STATE_C grep 'Test Strategy.*Minimal'   -> assertStateField "Test Strategy" === "Minimal"
//   C3 STRAT_COUNT == 1                         -> r.auditEvents.filter(=== "TEST_STRATEGY_CHANGED").length === 1
//                                                 (count on the parsed audit array, in file order — the
//                                                  same single-event guarantee the .sh's grep -c gave)
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - config-change dispatch:  SKILL.md:124-127 -> `bun .claude/tools/aidlc-utility.ts config-change`
//                              with EXACTLY the extracted --depth / --test-strategy flags
//   - "Test Strategy" / "Depth" state fields:  config-change setField (utility.ts:2386,2389),
//                              normalised via VALID_DEPTHS / VALID_TEST_STRATEGIES (utility.ts:62-72:
//                              "standard"->"Standard", "minimal"->"Minimal")
//   - TEST_STRATEGY_CHANGED audit event:  appendAuditEvent (utility.ts:2406), written as
//                              `**Event**: TEST_STRATEGY_CHANGED` (aidlc-audit.ts:258), parsed by
//                              readAuditEvents (sdk-drive.ts:478)
//   - state-mid-ideation fixture seeds Depth=Standard, Test Strategy=Standard (state-mid-ideation.md:17-18)
//     and Scope=feature — so --test-strategy minimal CHANGES Standard->Minimal (event fires) while
//     --depth standard is a no-op (DEPTH_CHANGED does NOT fire).
//
// STRONGER-THAN-.sh: Test C also asserts DEPTH_CHANGED count === 0 — the .sh
// only counted TEST_STRATEGY_CHANGED. Since the fixture Depth is already
// Standard, a spurious DEPTH_CHANGED would mean the combined invocation drifted
// (the original step-8-before-step-9 bug the .sh's combined test guards). The
// audit-sample fixture seeds NO TEST_STRATEGY_CHANGED / DEPTH_CHANGED
// (audit-sample.md), so both counts measure only this run's contribution.
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.

import { describe, expect, test } from "bun:test";
import { assertAuditEvent, assertStateField } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget — honour the suite's AIDLC_TEST_TIMEOUT convention (seconds;
// the .sh set AIDLC_TEST_TIMEOUT=600). The bun:test per-test cap is that value;
// the driver's own abort fires ~15s earlier so a stuck canUseTool surfaces as a
// clear harness failure (no result event) rather than an opaque test-timeout.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer literals from the SHIPPED handler / seeded fixture (see header).
const STRATEGY_EVENT = "TEST_STRATEGY_CHANGED"; // utility.ts:2406, aidlc-audit.ts:60
const DEPTH_EVENT = "DEPTH_CHANGED"; // utility.ts:2400, aidlc-audit.ts:59
// VALID_TEST_STRATEGIES["minimal"] -> "Minimal"; VALID_DEPTHS["standard"] ->
// "Standard" (utility.ts:62-72). The fixture seeds both as Standard.
const STRATEGY_MINIMAL = "Minimal";
const DEPTH_STANDARD = "Standard";
const STOP_AFTER_STRATEGY_CHANGE = {
  toolName: "Bash",
  resultIncludes: "Test strategy changed",
} as const;

/** Count occurrences of an audit event in the parsed, in-file-order array. */
function countAuditEvent(events: string[] | undefined, event: string): number {
  return (events ?? []).filter((e) => e === event).length;
}

describe("t28 /aidlc --test-strategy / --depth config-change (sdk)", () => {
  // -------------------------------------------------------------------------
  // Test A — --test-strategy minimal changes the strategy on existing state.
  //
  // The override routes through config-change (SKILL.md:124-127), which
  // setField's "Test Strategy" to Minimal (utility.ts:2389) and appends the
  // TEST_STRATEGY_CHANGED audit event (utility.ts:2406) because the fixture's
  // seeded Standard differs from Minimal. We assert the on-disk state field and
  // the parsed audit event — the deterministic re-expression of the .sh greps.
  // -------------------------------------------------------------------------
  test(
    "A: --test-strategy minimal sets Test Strategy=Minimal and logs TEST_STRATEGY_CHANGED",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const r = await driveAidlc("/aidlc --test-strategy minimal", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_STRATEGY_CHANGE,
        });

        // .sh A1: state file carries Test Strategy = Minimal (on disk).
        assertStateField(r, "Test Strategy", STRATEGY_MINIMAL);

        // .sh A2: the override logged TEST_STRATEGY_CHANGED. assertAuditEvent
        // reads the parsed `**Event**:` lines off aidlc-docs/audit.md and fails
        // loudly if the audit log was never written.
        assertAuditEvent(r, STRATEGY_EVENT);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test C — --depth and --test-strategy apply together in ONE invocation.
  //
  // SKILL.md:124-127 routes BOTH flags through a single config-change call.
  // The .sh's audit-count assertion catches LLM drift into separate CLI
  // invocations (the original step-8-STOPped-before-step-9 bug). Re-expressed:
  // count TEST_STRATEGY_CHANGED === 1 on the parsed audit array. The fixture's
  // Depth is already Standard, so DEPTH_CHANGED must NOT fire (config-change
  // no-op, utility.ts:2385/2399) — a STRONGER guard than the .sh, which only
  // counted the strategy event.
  // -------------------------------------------------------------------------
  test(
    "C: combined --depth standard --test-strategy minimal: Depth=Standard, Strategy=Minimal, exactly one TEST_STRATEGY_CHANGED",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const r = await driveAidlc(
          "/aidlc --depth standard --test-strategy minimal",
          {
            projectDir: proj,
            timeoutMs: DRIVE_TIMEOUT_MS,
            stopAfterToolResult: STOP_AFTER_STRATEGY_CHANGE,
          },
        );

        // .sh C1: Depth is Standard (unchanged — fixture already Standard).
        assertStateField(r, "Depth", DEPTH_STANDARD);
        // .sh C2: Test Strategy is Minimal (changed Standard -> Minimal).
        assertStateField(r, "Test Strategy", STRATEGY_MINIMAL);

        // .sh C3: exactly one TEST_STRATEGY_CHANGED event in the audit log.
        // Counted on the parsed array (in file order) — the deterministic
        // equivalent of the .sh's `grep -c '^\*\*Event\*\*: TEST_STRATEGY_CHANGED'`.
        // assertAuditEvent first proves presence (no vacuous pass), then we
        // pin the count.
        assertAuditEvent(r, STRATEGY_EVENT);
        expect(countAuditEvent(r.auditEvents, STRATEGY_EVENT)).toBe(1);

        // STRONGER than the .sh: the combined invocation did NOT spuriously
        // change Depth (already Standard), so no DEPTH_CHANGED fired. Proves the
        // single atomic config-change applied both flags without drift.
        expect(countAuditEvent(r.auditEvents, DEPTH_EVENT)).toBe(0);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test B (.sh) — --test-strategy extreme (invalid) produces an error.
  //
  // NOT PORTED to an SDK assertion. The .sh asserted on $CLAUDE_OUTPUT (the
  // LLM's reworded prose). In the orchestrator path, SKILL.md:114 has the LLM
  // validate --test-strategy ITSELF and emit "Unknown test strategy" in prose
  // BEFORE any tool runs — contrast SKILL.md:108 (resolve-env-scope) where
  // validation is delegated to a TS tool precisely so the error is
  // deterministic. There is no guaranteed deterministic SDK surface here:
  //   - no Bash isError / config-change die() is reached (the LLM short-circuits)
  //   - no ERROR_LOGGED audit event is guaranteed (no tool failed)
  // Per the iron rule, asserting on assistantText would be a prose flake, so we
  // do NOT. The deterministic equivalent — config-change --test-strategy extreme
  // -> stderr "Unknown test strategy", exit 1 (utility.ts:2373 die() ->
  // emitError -> aidlc-lib.ts:1545) — is ALREADY covered at the CLI tier by
  // tests/unit/t27.cli.test.ts. This arm is recorded in the port's `unportable`
  // findings rather than weakened to a prose check.
  // -------------------------------------------------------------------------
});
