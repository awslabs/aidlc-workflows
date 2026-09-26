// covers: scope:bugfix
//
// t143-scope-start-creation.test.ts — the restored explicit-scope workflow creation
// journey (sdk). Drives a REAL `/aidlc --scope bugfix` on a fresh project
// (no aidlc-docs/aidlc-state.md) through the Claude Agent SDK and proves the
// creation seam end-to-end:
//
//   engine: `next --scope bugfix` over no state emits the run-then-continue
//           workflow creation `print` naming `intent create --scope bugfix` (the
//           explicit-scope arm of the no-state split — the engine names the
//           mutating move, never performs it);
//   conductor: ACTS on the print — runs `aidlc.ts engine intent create --scope bugfix`
//           and re-enters the loop;
//   disk:   the created intent's aidlc-state.md (under aidlc/spaces/<space>/intents/
//           <slug>-<id8>/, resolved by sdk-drive's per-intent readers) lands with
//           Scope: bugfix and a populated Current Stage — the workflow started.
//
// The deterministic halves of this seam are pinned by the t118 unit trio
// (creation print shape) and t117/t114 (branch routing); this journey proves the
// LIVE conductor closes the loop the engine names — the surface the earlier
// retreated journeys (t52/t54/t59/t138) deliberately stopped short of.
// Assertions stay at the JOURNEY level (state on disk + the creation tool-result),
// tolerant of conversational variance, mirroring t52/t141 — NEVER on assistantText.
//
// Known-answer literals (read from the SHIPPED tools, not guessed):
//   - creation print:  aidlc-orchestrate.ts:302/311 — names
//                   `intent create --scope <scope>` and ends "re-run `next` to continue"
//                   (P4: the retired `init` alias is gone)
//   - creation summary: `State initialized:` (aidlc-utility.ts handleIntentCreate stdout, :2395)
//   - state fields: State-Version-7 template (aidlc-utility.ts handleIntentCreate)
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock. The
// run stops the instant the creation tool-result lands (stopAfterToolResult), so
// no stage body is executed.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import {
  assertStateField,
  assertToolResultContains,
} from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateField } from "../harness/sdk-drive.ts";

const SCOPE = "bugfix";

// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

const INIT_STATE_SUMMARY = "State initialized:";
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;

describe("t143 explicit-scope workflow creation (/aidlc --scope bugfix, sdk live)", () => {
  test(
    "naming a scope on a fresh project creates the workflow: engine print -> conductor intent-create -> Scope=bugfix state on disk",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
      });
      try {
        const r = await driveAidlc(`/aidlc --scope ${SCOPE}`, {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // (a) The session ran the engine and got the CREATION PRINT: a Bash
        // tool-result carries the engine's JSON directive naming the creation move
        // for the explicitly named scope. (The directive JSON is the engine's
        // verbatim stdout — deterministic, never the LLM's rewording.) P4: the
        // engine NAMES `intent create --scope <scope>` (the deterministic creation
        // handler) — the retired `init` alias is gone (aidlc-orchestrate.ts:302).
        assertToolResultContains(r, "Bash", `intent create --scope ${SCOPE}`);

        // (a, cont.) ... and ACTED on it: the named intent-create tool ran and its
        // summary landed as a tool-result.
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        // (b) The workflow actually started — state ON DISK with the
        // explicitly named scope (journey-level, read straight off disk).
        expect(r.stateFile).toBeDefined();
        assertStateField(r, "Scope", SCOPE);

        // ... positioned at a stage (Current Stage populated — creation routed the
        // workflow to its first post-init stage; the exact slug is the scope
        // grid's concern, pinned deterministically elsewhere).
        const currentStage = readStateField(r.stateFile as string, "Current Stage");
        expect(currentStage).toBeDefined();
        expect((currentStage as string).length).toBeGreaterThan(0);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
