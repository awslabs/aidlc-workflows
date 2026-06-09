// covers: subcommand:aidlc-utility:status
//
// t20.sdk.test.ts — SDK-harness port of tests/integration/t20-integration-status.sh
// (plan 7). Drives the real /aidlc --status through the Claude Agent SDK and
// asserts ONLY on deterministic surfaces — never on assistantText.
//
// WHY THIS PORT EXISTS. The .sh asserted tests 1-3 by grepping the LLM's
// rendered OUTPUT for "IDEATION" / "[Ff]easibility" / "feature" and test 6 with
// a 5-way regex-OR for "no active workflow". Those greps are CLASS-1 prose-flaky:
// they fire against the assistant's reworded rendering, which varies run-to-run
// (hence the case-insensitive + regex-OR hedging). The SKILL.md dispatch
// (SKILL.md:67,71) routes `--status` to `bun .claude/tools/aidlc-utility.ts
// status` via Bash and prints its stdout VERBATIM. That stdout is the
// deterministic surface: handleStatus (aidlc-utility.ts:181) reads the fields
// straight off aidlc-state.md (Scope/Phase/Current Stage) and renders a fixed
// "AI-DLC Workflow Status" block — so "IDEATION", "Feasibility", and "feature"
// appear because the TOOL read them from the seeded state, not because the LLM
// echoed them. We assert those literals on the Bash tool_result bytes.
//
// ASSERTION MAP (.sh test -> SDK surface):
//   1 OUTPUT contains IDEATION        -> Bash tool_result contains "IDEATION"  (status block Phase line, read from state)
//   2 OUTPUT contains [Ff]easibility  -> Bash tool_result contains "Feasibility" (Current Stage name, stage 1.3)
//   3 OUTPUT contains feature         -> Bash tool_result contains "feature"   (Scope line, read from state)
//   4 state md5 unchanged             -> readStateFile before === after (the read-only contract, on disk)
//   5 no new .md files                -> no *.md under aidlc-docs/ beyond the seeded state/audit after the run
//   6 no-state "no active workflow"   -> Bash tool_result contains "No active AI-DLC workflow found." (handleStatus:185, verbatim CLI)
//   7 exit 0                          -> resultEvent.is_error === false (SDK terminal event, the run completed)
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - status block fields:  aidlc-utility.ts handleStatus() :297-311 (Scope/Phase/Current Stage lines)
//   - no-workflow literal:   "No active AI-DLC workflow found." :185
//   - --status dispatch:     SKILL.md:67,71 -> `bun .claude/tools/aidlc-utility.ts status` via Bash, stdout verbatim
//   - state-mid-ideation fixture carries Scope=feature, Lifecycle Phase=IDEATION,
//     Current Stage=feasibility (-> stage 1.3 "Feasibility & Constraints").
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateFile } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget — honour the suite's AIDLC_TEST_TIMEOUT convention (seconds;
// the .sh set AIDLC_TEST_TIMEOUT=180). The bun:test per-test cap is that value;
// the driver's own abort fires ~15s earlier so a stuck canUseTool surfaces as a
// clear harness failure (no result event) rather than an opaque test-timeout.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "180", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 180) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer literals from the SHIPPED handler / seeded fixture.
const STATUS_HEADER = "AI-DLC Workflow Status"; // aidlc-utility.ts:297
const NO_WORKFLOW = "No active AI-DLC workflow found."; // aidlc-utility.ts:185
const STOP_AFTER_STATUS = { toolName: "Bash", resultIncludes: STATUS_HEADER } as const;
const STOP_AFTER_NO_WORKFLOW = { toolName: "Bash", resultIncludes: NO_WORKFLOW } as const;
// The seeded state-mid-ideation fixture's Phase/Scope/Current-Stage values, as
// the status block renders them (Phase line uppercase, Scope verbatim, the
// stage-1.3 name title-cased — exactly what the .sh's case-insensitive
// [Ff]easibility grep was hedging against).
const STATE_PHASE = "IDEATION";
const STATE_SCOPE = "feature";
const STATE_STAGE = "Feasibility"; // "Feasibility & Constraints" (1.3)

/** Markdown files under <proj>/aidlc-docs/, excluding the seeded state/audit and
 *  the recovery scratch file — mirrors the .sh test-5 find filter. */
function docMdFiles(proj: string): string[] {
  const docs = join(proj, "aidlc-docs");
  if (!existsSync(docs)) return [];
  return readdirSync(docs).filter(
    (f) =>
      f.endsWith(".md") &&
      f !== "aidlc-state.md" &&
      f !== "audit.md" &&
      f !== ".aidlc-recovery.md",
  );
}

describe("t20 /aidlc --status (sdk)", () => {
  // -------------------------------------------------------------------------
  // With a mid-ideation state file (.sh tests 1-5).
  //
  // The --status dispatch runs the deterministic status CLI via Bash and prints
  // its stdout verbatim. We assert the Bash tool_result carries the state-
  // derived fields (the prose-grep re-expression), that the state file is
  // BYTE-unchanged across the run (the real --status contract: read-only), and
  // that no new artifact .md files were created.
  // -------------------------------------------------------------------------
  test(
    "with state: status reads the mid-ideation fields, leaves state + docs untouched",
    async () => {
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
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_STATUS,
        });

        // The --status path RAN: the status CLI fired via Bash and its verbatim
        // stdout carries the fixed status header. assertToolResultContains
        // fails loudly if Bash never fired (no vacuous pass).
        assertToolResultContains(r, "Bash", STATUS_HEADER);

        // .sh tests 1-3, re-expressed deterministically: the status block the
        // TOOL emitted (read from the seeded state) carries IDEATION / feature /
        // Feasibility. These are the tool's stdout bytes, NOT the LLM's prose.
        assertToolResultContains(r, "Bash", STATE_PHASE);
        assertToolResultContains(r, "Bash", STATE_SCOPE);
        assertToolResultContains(r, "Bash", STATE_STAGE);
        const statusCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(STATUS_HEADER),
        );
        expect(statusCall?.isError).toBe(false);

        // .sh test 4: state file BYTE-unchanged after --status (read-only
        // contract). Compared on disk, the md5 equivalent without the hash.
        const stateAfter = readStateFile(proj);
        expect(stateAfter).toBe(stateBefore as string);

        // .sh test 5: no new .md artifacts created in aidlc-docs/.
        const docsAfter = docMdFiles(proj);
        expect(docsAfter.sort()).toEqual(docsBefore.sort());

        // .sh test 7 (also exercised here): the status tool itself exited 0.
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
  // Without a state file (.sh tests 6-7).
  //
  // The .sh test 6 grepped a 5-way regex-OR over the LLM prose for "no active
  // workflow". The deterministic re-expression: the status CLI's stdout carries
  // the exact "No active AI-DLC workflow found." literal (handleStatus:185), so
  // we assert that on the Bash tool_result. Test 7's exit-0 becomes the SDK
  // terminal event's is_error === false.
  // -------------------------------------------------------------------------
  test(
    "no state: status reports no active workflow and the run completes cleanly",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        const r = await driveAidlc("/aidlc --status", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_NO_WORKFLOW,
        });

        // .sh test 6, re-expressed: the no-workflow branch's VERBATIM CLI
        // stdout reaches the Bash tool_result. Not the LLM's reworded prose.
        assertToolResultContains(r, "Bash", NO_WORKFLOW);

        // .sh test 7: exit 0 -> the status Bash tool_result is non-error.
        // handleStatus's no-state path is exit-0 by construction (early return
        // after the stdout write, aidlc-utility.ts:193).
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
