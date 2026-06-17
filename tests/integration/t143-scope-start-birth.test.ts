// covers: scope:bugfix
//
// t143-scope-start-birth.test.ts — the restored explicit-scope workflow-birth
// journey (sdk). Drives a REAL `/aidlc --scope bugfix` on a fresh project
// (no aidlc-docs/aidlc-state.md) through the Claude Agent SDK and proves the
// birth seam end-to-end:
//
//   engine: `next --scope bugfix` over no state emits the run-then-continue
//           workflow-birth `print` naming `intent-birth --scope bugfix` (the
//           explicit-scope arm of the no-state split — the engine names the
//           mutating move, never performs it);
//   conductor: ACTS on the print — runs `aidlc-utility.ts intent-birth --scope bugfix`
//           and re-enters the loop;
//   disk:   the born intent's aidlc-state.md (under aidlc/spaces/<space>/intents/
//           <slug>-<id8>/, resolved by sdk-drive's per-intent readers) lands with
//           Scope: bugfix and a populated Current Stage — the workflow started.
//
// The deterministic halves of this seam are pinned by the t118 unit trio
// (birth print shape) and t117/t114 (branch routing); this journey proves the
// LIVE conductor closes the loop the engine names — the surface the earlier
// retreated journeys (t52/t54/t59/t138) deliberately stopped short of.
// Assertions stay at the JOURNEY level (state on disk + the birth tool-result),
// tolerant of conversational variance, mirroring t52/t141 — NEVER on assistantText.
//
// Known-answer literals (read from the SHIPPED tools, not guessed):
//   - birth print:  aidlc-orchestrate.ts:302/311 — names
//                   `intent-birth --scope <scope>` and ends "re-run `next` to continue"
//                   (P4: the retired `init` alias is gone)
//   - birth summary: `State initialized:` (aidlc-utility.ts handleIntentBirth stdout, :2395)
//   - state fields: State-Version-7 template (aidlc-utility.ts handleIntentBirth)
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock. The
// run stops the instant the birth tool-result lands (stopAfterToolResult), so
// no stage body is executed.

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

// Timeout budget — same convention as t52/t141: honour AIDLC_TEST_TIMEOUT and
// abort the drive a hair early so a stuck run surfaces a partial DriveResult.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

const INIT_STATE_SUMMARY = "State initialized:";
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;

describe("t143 explicit-scope workflow birth (/aidlc --scope bugfix, sdk live)", () => {
  test(
    "naming a scope on a fresh project births the workflow: engine print -> conductor intent-birth -> Scope=bugfix state on disk",
    async () => {
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
      });
      try {
        const r = await driveAidlc(`/aidlc --scope ${SCOPE}`, {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // (a) The session ran the engine and got the BIRTH PRINT: a Bash
        // tool-result carries the engine's JSON directive naming the birth move
        // for the explicitly named scope. (The directive JSON is the engine's
        // verbatim stdout — deterministic, never the LLM's rewording.) P4: the
        // engine NAMES `intent-birth --scope <scope>` (the deterministic birth
        // handler) — the retired `init` alias is gone (aidlc-orchestrate.ts:302).
        assertToolResultContains(r, "Bash", `intent-birth --scope ${SCOPE}`);

        // (a, cont.) ... and ACTED on it: the named intent-birth tool ran and its
        // summary landed as a tool-result.
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        // (b) The workflow actually started — state ON DISK with the
        // explicitly named scope (journey-level, read straight off disk).
        expect(r.stateFile).toBeDefined();
        assertStateField(r, "Scope", SCOPE);

        // ... positioned at a stage (Current Stage populated — birth routed the
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
