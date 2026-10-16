// covers: subcommand:aidlc-utility:status
//
// t20.test.ts - drives the real /aidlc --status through the Claude Agent SDK
// and asserts ONLY on deterministic surfaces - never on assistantText.
//
// Greps against the assistant's reworded rendering are CLASS-1 prose-flaky:
// the rendering varies run-to-run. In the first port, the SKILL.md dispatch
// (SKILL.md) routes `--status` to `bun .claude/tools/aidlc-utility.ts
// status` via Bash and prints its stdout VERBATIM; today the engine names the
// status utility in a print directive the conductor runs. That stdout is the
// deterministic surface: handleStatus (aidlc-utility.ts) reads the fields
// straight off aidlc-state.md (Scope/Phase/Current Stage) and renders a fixed
// "AI-DLC Workflow Status" block - so "IDEATION", "Feasibility", and "feature"
// appear because the TOOL read them from the seeded state, not because the LLM
// echoed them. We assert those literals on the Bash tool_result bytes.
//
// ASSERTION MAP:
//   1 Phase                           -> Bash tool_result contains "IDEATION" (status block Phase line, read from state)
//   2 Current Stage                   -> Bash tool_result contains "Feasibility" (Current Stage name)
//   3 Scope                           -> Bash tool_result contains "feature" (Scope line, read from state)
//   4 state unchanged                 -> readStateFile before === after (the read-only contract, on disk)
//   5 no new .md files                -> no *.md under aidlc-docs/ beyond the seeded state/audit after the run
//   6 no-state "no active workflow"   -> Bash tool_result contains "No active AI-DLC workflow found." (handleStatus, verbatim CLI)
//   7 exit 0                          -> the status Bash tool_result is non-error
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - status block fields:  aidlc-utility.ts handleStatus() (Scope/Phase/Current Stage lines)
//   - no-workflow literal:   "No active AI-DLC workflow found." (handleStatus)
//   - --status dispatch:     SKILL.md -> `bun .claude/tools/aidlc-utility.ts status` via Bash, stdout verbatim
//   - state-mid-ideation fixture carries Scope=feature, Lifecycle Phase=IDEATION,
//     Current Stage=feasibility ("Feasibility & Constraints").
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
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateFile } from "../harness/sdk-drive.ts";

// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Known-answer literals from the SHIPPED handler / seeded fixture.
const STATUS_HEADER = "AI-DLC Workflow Status"; // aidlc-utility.ts handleStatus
const NO_WORKFLOW = "No active AI-DLC workflow found."; // aidlc-utility.ts handleStatus
const STOP_AFTER_STATUS = { toolName: "Bash", resultIncludes: STATUS_HEADER } as const;
const STOP_AFTER_NO_WORKFLOW = { toolName: "Bash", resultIncludes: NO_WORKFLOW } as const;
// The seeded state-mid-ideation fixture's Phase/Scope/Current-Stage values, as
// the status block renders them (Phase line uppercase, Scope verbatim, the
// stage-1.3 name title-cased).
const STATE_PHASE = "IDEATION";
const STATE_SCOPE = "feature";
const STATE_STAGE = "Feasibility"; // "Feasibility & Constraints" (1.3)

function docMdFiles(proj: string): string[] {
  const docs = join(proj, "aidlc-docs");
  if (!existsSync(docs)) return [];
  return readdirSync(docs).filter(
    (f) =>
      f.endsWith(".md") &&
      f !== "aidlc-state.md" &&
      f !== "audit.md" &&
      f !== ".aidlc-engine/recovery.md",
  );
}

describe("t20 /aidlc --status (sdk)", () => {
  // -------------------------------------------------------------------------
  // With a mid-ideation state file.
  //
  // The --status dispatch runs the deterministic status CLI via Bash and prints
  // its stdout verbatim. We assert the Bash tool_result carries the state-
  // derived fields, that the state file is BYTE-unchanged across the run (the
  // real --status contract: read-only), and that no new artifact .md files were
  // created.
  // -------------------------------------------------------------------------
  test(
    "with state: status reads the mid-ideation fields, leaves state + docs untouched",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        // Capture the state file BEFORE the run — --status must not mutate it.
        const stateBefore = readStateFile(proj);
        expect(stateBefore).toBeDefined();
        const docsBefore = docMdFiles(proj);

        const r = await driveAidlc("/aidlc --status", {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_STATUS,
        });

        // The --status path RAN: the status CLI fired via Bash and its verbatim
        // stdout carries the fixed status header. assertToolResultContains
        // fails loudly if Bash never fired (no vacuous pass).
        assertToolResultContains(r, "Bash", STATUS_HEADER);

        // The status block the TOOL emitted (read from the seeded state) carries
        // IDEATION / feature / Feasibility. These are the tool's stdout bytes, NOT the
        // LLM's prose.
        assertToolResultContains(r, "Bash", STATE_PHASE);
        assertToolResultContains(r, "Bash", STATE_SCOPE);
        assertToolResultContains(r, "Bash", STATE_STAGE);
        const statusCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(STATUS_HEADER),
        );
        expect(statusCall?.isError).toBe(false);

        const stateAfter = readStateFile(proj);
        expect(stateAfter).toBe(stateBefore as string);

        const docsAfter = docMdFiles(proj);
        expect(docsAfter.sort()).toEqual(docsBefore.sort());

        // The status tool itself exited 0.
        // The driver intentionally aborts as soon as the deterministic
        // tool_result lands so the model cannot continue into unrelated
        // workflow execution after proving the status contract.
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Without a state file.
  //
  // The status CLI's stdout carries the exact "No active AI-DLC workflow found."
  // literal (handleStatus), so we assert that on the Bash tool_result. The
  // status Bash tool_result is non-error.
  // -------------------------------------------------------------------------
  test(
    "no state: status reports no active workflow and the run completes cleanly",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        const r = await driveAidlc("/aidlc --status", {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_NO_WORKFLOW,
        });

        // The no-workflow branch's VERBATIM CLI stdout reaches the Bash tool_result.
        // Not the LLM's reworded prose.
        assertToolResultContains(r, "Bash", NO_WORKFLOW);

        // Exit 0 -> the status Bash tool_result is non-error.
        // handleStatus's no-state path is exit-0 by construction (early return
        // after the stdout write, aidlc-utility.ts handleStatus).
        const statusCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(NO_WORKFLOW),
        );
        expect(statusCall?.isError).toBe(false);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
