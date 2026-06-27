// covers: subcommand:aidlc-utility:init, scope:bugfix
//
// t59-workflow-depth-override.test.ts — SDK-harness port of
// tests/e2e/t59-workflow-depth-override.sh (plan 6). Drives the real
// `/aidlc --init --scope bugfix --depth comprehensive` through the Claude Agent SDK on
// a fresh brownfield project and asserts ONLY on deterministic surfaces — the
// init tool's verbatim stdout, the on-disk state fields, and the parsed audit
// events — NEVER on assistantText.
//
// ⛔ TRAP 2 (no headless auto-approve). The .sh drove `/aidlc bugfix --depth
// comprehensive` to completion and asserted on the FINAL state under a headless
// auto-approve mode the refactor kills. That mode is NOT load-bearing for THIS
// test's subject - the depth override lands at explicit init (the init tool writes
// `- **Depth**: <effectiveDepth>` from the --depth flag, utility.ts:1941-1943,
// :2064, BEFORE any gate). So we drive explicit init with the depth flag, stop the
// SDK the instant the init stdout lands (the depth is already on disk), and
// assert the deterministic init emission. We do NOT chase Construction-stage
// progress (the .sh's tests 4-5 of "init stages completed" / "Construction
// progressed") - those depend on the LLM running the workflow to completion,
// a moving target; the depth-OVERRIDE invariant this test owns lands
// at init and is fully deterministic there.
//
// THIS TEST OWNS THE DEPTH-AT-INIT SURFACE (the t27 gap). The tui t27
// depth-override twin deliberately covers only the config-change one-shot
// (`--depth <x>` on an EXISTING workflow) and omits the .sh's Case B
// (`bugfix --depth comprehensive` — depth override AT workflow birth). That
// surface is THIS file's: `--depth comprehensive` overriding the bugfix scope's
// Minimal default at init, asserted on the Depth state field the init tool writes.
//
// THE JOURNEY (verified against the SHIPPED tool). `/aidlc --init --scope bugfix
// --depth comprehensive` on a fresh `--no-aidlc-docs` brownfield project routes
// through `aidlc-utility.ts init --scope bugfix --depth comprehensive` (SKILL.md).
// handleInit
// validates the depth (utility.ts:1731-1733, die on unknown), computes
// effectiveDepth = VALID_DEPTHS["comprehensive"] = "Comprehensive" (utility.ts:1941),
// and writes `- **Depth**: Comprehensive` into the State-Version-7 template
// (utility.ts:2064) — OVERRIDING the bugfix scope default of Minimal. It also
// records Scope=bugfix (utility.ts:2049) and emits WORKFLOW_STARTED (utility.ts:1784).
//
// ASSERTION MAP (.sh test -> deterministic SDK surface, equal-or-stronger):
//   1 state file created
//       -> r.stateFile !== undefined (sdk-drive reads aidlc-state.md off disk).
//   2 depth comprehensive overrides bugfix default (Minimal)
//       -> readStateField(state,"Depth") === "Comprehensive" (utility.ts:2064).
//          Stronger than the .sh's `grep "Depth.*Comprehensive"` — exact field
//          equality. ALSO assert it is NOT the bugfix default "Minimal".
//   3 bugfix scope recorded
//       -> readStateField(state,"Scope") === "bugfix" (utility.ts:2049). Exact,
//          stronger than the .sh's `[Bb]ugfix` regex.
//   (4-5 init/Construction progress: NOT asserted - those depended on running
//        the workflow to completion; the depth-OVERRIDE invariant this
//        test owns is deterministic at init and asserted above. Init COMPLETION
//        of the 3 init stages IS still asserted via test 1+ the [x] markers below,
//        the deterministic part.)
//   6 audit has WORKFLOW_STARTED
//       -> assertAuditEvent(r,"WORKFLOW_STARTED") (parsed **Event**: line;
//          utility.ts:1784 — known scope invocations log WORKFLOW_STARTED, the
//          .sh's exact event).
//   + the 3 init stages are [x] (the deterministic init completion the .sh's
//     test 4 bounded with "at least 3 init stages completed"):
//       -> the state contains [x] for workspace-scaffold/workspace-detection/state-init.
//
// Known-answer literals (read from the SHIPPED tool, not guessed):
//   - init dispatch with depth:  SKILL.md -> `aidlc-utility.ts init --scope bugfix --depth comprehensive`
//   - depth validation:          aidlc-utility.ts:1731-1733
//   - effectiveDepth mapping:    aidlc-utility.ts:1941-1943 (VALID_DEPTHS comprehensive -> "Comprehensive")
//   - Depth state field:         aidlc-utility.ts:2064
//   - Scope state field:         aidlc-utility.ts:2049
//   - State initialized summary: aidlc-utility.ts:2154 ("State initialized: ... <depth> depth")
//   - WORKFLOW_STARTED emit:     aidlc-utility.ts:1784
//   - init-stage [x] markers:    aidlc-utility.ts:1995-1998
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout; the driver aborts a hair early so a stuck run
// surfaces a partial DriveResult, not a hang.

import { describe, expect, test } from "bun:test";
import { assertAuditEvent } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateField } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget. Explicit init on Opus/Bedrock is a few minutes; honour the
// AIDLC_TEST_TIMEOUT convention. The driver aborts ~15s before bun's per-test
// cap so a stuck run surfaces a partial DriveResult to diagnose.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer literals from the SHIPPED init handler (see header for file:line).
const SCOPE = "bugfix";
const DEPTH_OVERRIDE = "Comprehensive"; // VALID_DEPTHS["comprehensive"] (utility.ts:1941)
const BUGFIX_DEFAULT_DEPTH = "Minimal"; // the bugfix scope default the override beats
const INIT_STATE_SUMMARY = "State initialized:"; // utility.ts:2154
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

describe("t59 /aidlc --init --scope bugfix --depth comprehensive depth override (sdk)", () => {
  // -------------------------------------------------------------------------
  // Fresh brownfield project: the depth override lands at explicit init. We assert
  // the Depth state field is Comprehensive (overriding bugfix's Minimal default),
  // Scope=bugfix, WORKFLOW_STARTED, and the 3 init stages complete — all
  // deterministic at init.
  // -------------------------------------------------------------------------
  test(
    "depth comprehensive overrides the bugfix Minimal default at init, records bugfix scope + WORKFLOW_STARTED",
    async () => {
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        withBrownfieldStub: true,
      });
      try {
        const r = await driveAidlc(
          `/aidlc --init --scope ${SCOPE} --depth comprehensive`,
          {
            projectDir: proj,
            answerScript: "default",
            timeoutMs: DRIVE_TIMEOUT_MS,
            stopAfterToolResult: STOP_AFTER_INIT,
          },
        );

        // The init tool RAN: its verbatim stdout summary reached a Bash
        // tool_result (no vacuous pass) and carries the comprehensive depth.
        const initCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(INIT_STATE_SUMMARY),
        );
        expect(initCall).toBeDefined();
        // The init summary line ends "... <depth> depth" (utility.ts:2154).
        expect(initCall?.resultText.toLowerCase()).toContain("comprehensive depth");

        // .sh test 1: state file created. sdk-drive reads it off disk post-run.
        expect(r.stateFile).toBeDefined();
        const state = r.stateFile as string;

        // .sh test 2: depth comprehensive OVERRIDES the bugfix Minimal default.
        // Exact field equality (stronger than `grep "Depth.*Comprehensive"`), AND
        // prove it is NOT the scope default Minimal — the override is the subject.
        expect(readStateField(state, "Depth")).toBe(DEPTH_OVERRIDE);
        expect(readStateField(state, "Depth")).not.toBe(BUGFIX_DEFAULT_DEPTH);

        // .sh test 3: bugfix scope recorded. Exact field (stronger than [Bb]ugfix).
        expect(readStateField(state, "Scope")).toBe(SCOPE);

        // The deterministic init completion (the .sh's test 4 floor "at least 3
        // init stages completed"): the 3 init stages are marked [x].
        for (const stage of INIT_STAGES) {
          expect(state).toContain(`[x] ${stage}`);
        }

        // .sh test 6: audit recorded WORKFLOW_STARTED (the .sh's exact event for
        // a known-scope invocation; parsed **Event**: line, utility.ts:1784).
        assertAuditEvent(r, "WORKFLOW_STARTED");
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
