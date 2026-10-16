// covers: subcommand:aidlc-utility:config-change, audit:TEST_STRATEGY_CHANGED
//
// t28-integration-test-strategy.test.ts - drives the real
// /aidlc --test-strategy / --depth through the Claude Agent SDK and asserts
// ONLY on deterministic surfaces — never on assistantText. Mechanism `sdk` is
// DERIVED from the driveAidlc() call below, so the filename carries no
// mechanism segment.
//
// The override assertions use on-disk state + parsed audit events. The
// invalid-strategy arm is not asserted on prose (as first ported, see the
// UNPORTABLE note below): SKILL.md has the LLM validate --test-strategy
// itself and emit the error IN PROSE before any tool runs. Its deterministic
// equivalent (config-change --test-strategy extreme -> stderr "Unknown test
// strategy", exit 1) is covered at the CLI tier by tests/unit/t27.test.ts (the
// config-change invalid-strategy case). We do NOT re-assert it here on the
// non-deterministic assistantText surface.
//
// ASSERTION MAP (.sh assertion -> deterministic SDK surface):
//   A1 STATE_A grep 'Test Strategy.*Minimal'  -> assertStateField "Test Strategy" === "Minimal"
//                                                 (config-change setField, utility.ts; VALID_TEST_STRATEGIES, utility.ts)
//   A2 AUDIT_A grep 'TEST_STRATEGY_CHANGED'    -> assertAuditEvent "TEST_STRATEGY_CHANGED"
//                                                 (appendAuditEvent, utility.ts; VALID_EVENT_TYPES, aidlc-audit.ts)
//   B1 CLAUDE_OUTPUT contains "Unknown test    -> UNPORTABLE to a deterministic SDK surface (LLM-prose
//      strategy"                                  validation by SKILL.md). Deterministic equivalent
//                                                  (CLI die() -> stderr, utility.ts) is covered by
//                                                  tests/unit/t27.test.ts; NOT asserted on prose.
//   C1 STATE_C grep 'Depth.*Standard'          -> assertStateField "Depth" === "Standard"
//                                                 (no-op: fixture Depth already Standard; config-change
//                                                  leaves it, utility.ts; prints "Depth is already Standard")
//   C2 STATE_C grep 'Test Strategy.*Minimal'   -> assertStateField "Test Strategy" === "Minimal"
//   C3 STRAT_COUNT == 1                         -> r.auditEvents.filter(=== "TEST_STRATEGY_CHANGED").length === 1
//                                                 (count on the parsed audit array, in file order)
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - config-change dispatch:  SKILL.md -> `bun .claude/tools/aidlc-utility.ts config-change`
//                              with EXACTLY the extracted --depth / --test-strategy flags
//                              (as first ported; today the engine names one `config set`
//                              command, aidlc-orchestrate.ts configSetCommand, which the
//                              dispatcher routes to handleConfigChange)
//   - "Test Strategy" / "Depth" state fields:  config-change setField (utility.ts),
//                              normalised via VALID_DEPTHS / VALID_TEST_STRATEGIES (utility.ts:
//                              "standard"->"Standard", "minimal"->"Minimal")
//   - TEST_STRATEGY_CHANGED audit event:  appendAuditEvent (utility.ts), written as
//                              `**Event**: TEST_STRATEGY_CHANGED` (aidlc-audit.ts), parsed by
//                              readAuditEvents (sdk-drive.ts)
//   - P4 layout note:          config-change does NOT migrate the flat seed (only intent-create
//                              migrates, aidlc-utility.ts). The withState seed stays at the
//                              active intent's record (seedStateFile), so assertStateField
//                              (r.stateFile) / assertAuditEvent (r.auditEvents) resolve it via
//                              sdk-drive's per-intent readers - no hardcoded flat path here.
//   - state-mid-ideation fixture seeds Depth=Standard, Test Strategy=Standard (state-mid-ideation.md)
//     and Scope=feature — so --test-strategy minimal CHANGES Standard->Minimal (event fires) while
//     --depth standard is a no-op (DEPTH_CHANGED does NOT fire).
//
// Test C also asserts DEPTH_CHANGED count === 0. Since the fixture Depth is
// already Standard, a spurious DEPTH_CHANGED would mean the combined invocation
// drifted. The audit-sample fixture seeds NO TEST_STRATEGY_CHANGED /
// DEPTH_CHANGED (audit-sample.md), so both counts measure only this run's
// contribution.
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { assertAuditEvent, assertStateField } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";

// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Known-answer literals from the SHIPPED handler / seeded fixture (see header).
const STRATEGY_EVENT = "TEST_STRATEGY_CHANGED"; // aidlc-guard-switch.ts applyIntentSettings; aidlc-audit.ts VALID_EVENT_TYPES
const DEPTH_EVENT = "DEPTH_CHANGED"; // aidlc-guard-switch.ts applyIntentSettings; aidlc-audit.ts VALID_EVENT_TYPES
// VALID_TEST_STRATEGIES["minimal"] -> "Minimal"; VALID_DEPTHS["standard"] ->
// "Standard" (aidlc-guard-switch.ts). The fixture seeds both as Standard.
const STRATEGY_MINIMAL = "Minimal";
const DEPTH_STANDARD = "Standard";
const STOP_AFTER_STRATEGY_CHANGE = {
  toolName: "Bash",
  resultIncludes: "Test strategy changed",
} as const;

function countAuditEvent(events: string[] | undefined, event: string): number {
  return (events ?? []).filter((e) => e === event).length;
}

describe("t28 /aidlc --test-strategy / --depth config-change (sdk)", () => {
  // -------------------------------------------------------------------------
  // Test A — --test-strategy minimal changes the strategy on existing state.
  //
  // The override routes through config-change (the engine's `config set` print,
  // dispatched to handleConfigChange), which sets "Test Strategy" to Minimal and
  // appends the TEST_STRATEGY_CHANGED audit event (applyIntentSettings) because
  // the fixture's seeded Standard differs from Minimal. We assert the on-disk
  // state field and the parsed audit event.
  // -------------------------------------------------------------------------
  test(
    "A: --test-strategy minimal sets Test Strategy=Minimal and logs TEST_STRATEGY_CHANGED",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const r = await driveAidlc("/aidlc --test-strategy minimal", {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_STRATEGY_CHANGE,
        });

        assertStateField(r, "Test Strategy", STRATEGY_MINIMAL);

        // The override logged TEST_STRATEGY_CHANGED. assertAuditEvent
        // reads the parsed `**Event**:` lines off the audit (per-clone shards
        // under the resolved record's audit/, via sdk-drive's readAuditEvents)
        // and fails loudly if the audit log was never written.
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
  // The engine routes BOTH flags through a single config-change call. The
  // audit-count assertion catches LLM drift into separate CLI invocations (the
  // step-8-STOPped-before-step-9 bug): count TEST_STRATEGY_CHANGED === 1 on the
  // parsed audit array. The fixture's Depth is already Standard, so
  // DEPTH_CHANGED must NOT fire (config-change no-op, applyIntentSettings).
  // -------------------------------------------------------------------------
  test(
    "C: combined --depth standard --test-strategy minimal: Depth=Standard, Strategy=Minimal, exactly one TEST_STRATEGY_CHANGED",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const r = await driveAidlc(
          "/aidlc --depth standard --test-strategy minimal",
          {
            projectDir: proj,
            timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
              deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
            }),
            stopAfterToolResult: STOP_AFTER_STRATEGY_CHANGE,
          },
        );

        // Depth is Standard (unchanged - fixture already Standard).
        assertStateField(r, "Depth", DEPTH_STANDARD);
        // Test Strategy is Minimal (changed Standard -> Minimal).
        assertStateField(r, "Test Strategy", STRATEGY_MINIMAL);

        // Exactly one TEST_STRATEGY_CHANGED event in the audit log.
        // assertAuditEvent first proves presence (no vacuous pass), then we
        // pin the count.
        assertAuditEvent(r, STRATEGY_EVENT);
        expect(countAuditEvent(r.auditEvents, STRATEGY_EVENT)).toBe(1);

        // The combined invocation did NOT spuriously change Depth (already Standard),
        // so no DEPTH_CHANGED fired. Proves the single atomic config-change applied
        // both flags without drift.
        expect(countAuditEvent(r.auditEvents, DEPTH_EVENT)).toBe(0);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test B - --test-strategy extreme (invalid) produces an error.
  //
  // Not asserted in this SDK file. Asserting on assistantText would be a prose
  // flake, so we do NOT. The deterministic equivalent - config-change
  // --test-strategy extreme -> stderr "Unknown test strategy", exit 1 - is
  // covered at the CLI tier by tests/unit/t27.test.ts, the config-change
  // invalid-strategy case.
  // -------------------------------------------------------------------------
});
