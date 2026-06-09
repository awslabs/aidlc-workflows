// covers: subcommand:aidlc-utility:doctor
//
// t22.sdk.test.ts — SDK port of t22-integration-doctor.sh (drives /aidlc --doctor).
//
// WHY THIS PORT EXISTS. The .sh asserted on `$CLAUDE_OUTPUT` — the assistant's
// reworded prose rendering of the doctor report. Tests 1-7 and 9 grepped that
// prose case-insensitively for per-check keywords ("audit-logger",
// "session-start", "settings", "bun", "health") and leaned on a 6-way
// SUMMARY_PASS regex-OR fallback ("checks.*pass|all.*check|[0-9]+ passed|all
// hooks|setup is healthy|health check") precisely because the LLM's wording
// drifts run-to-run. That is the CLASS-1 prose flake: the contract is real,
// but the surface (LLM prose) is non-deterministic.
//
// THE DETERMINISTIC SURFACE. /aidlc --doctor runs a deterministic bun tool
// (handleDoctor in aidlc-utility.ts) whose stdout is fixed bytes. The SDK
// surfaces those bytes VERBATIM in the Bash tool_result, before the LLM
// rewords them — the calibration (sdk-drive.calibration.test.ts CALIBRATION 2)
// proved the doctor block is byte-stable across runs and carries the exact
// labels. So every prose grep here is re-expressed against the Bash
// tool_result via assertToolResultContains: same contract, stable surface.
//
// The known-answer label strings are READ from the shipped doctor handler
// (dist/claude/.claude/tools/aidlc-utility.ts handleDoctor), NOT guessed:
//   - header literal:     "AI-DLC Health Check"               (utility.ts:1355)
//   - bun check label:    "bun installed (required ...)"      (utility.ts:336)
//   - hook check label:   "<hook>.ts present"                 (utility.ts:356)
//   - settings label:     "settings.json present"            (utility.ts:365)
//   - aidlc-docs label:   "aidlc-docs/ directory exists"      (utility.ts:396)
//   - footer shape:       "N passed, M failed"               (utility.ts:1371)
//   - audit event:        "HEALTH_CHECKED"                    (utility.ts:1376)
//
// MECHANISM. New file = .sdk.test.ts (mechanism `sdk`, rank 2). The covered
// unit `aidlc-utility doctor` is minMechanism `cli` (rank 1); sdk satisfies
// cli (2 >= 1), so the covers claim is honoured by the guarantee-principle
// gate. The .sh is retired (this .sdk.test.ts replaces it at equal-or-stronger
// fidelity — every deterministic .sh assertion is re-expressed on a stable
// surface, and both per-hook presence labels are asserted independently).
//
// ASSERTS ONLY ON: toolResults (the Bash doctor stdout bytes), auditEvents
// (HEALTH_CHECKED + growth), and resultEvent. NEVER on assistantText.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readAuditEvents } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget. A multi-tool /aidlc --doctor turn on Opus/Bedrock takes
// minutes. Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the .sh
// set it to 600). Drive aborts a hair before bun kills the test so a stuck
// run surfaces a partial DriveResult to diagnose rather than an opaque hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer doctor strings, read from the shipped handler (see header).
const DOCTOR_HEADER = "AI-DLC Health Check";
const DOCTOR_BUN_LABEL = "bun installed (required for CLI tools and hooks)";
const DOCTOR_HOOK_LABEL = "aidlc-audit-logger.ts present";
// handleDoctor emits a separate `${h}.ts present` line per hook (utility.ts:356);
// the .sh checked BOTH audit-logger (tests 1,4) AND session-start (tests 2,5),
// so we assert each hook label independently — proving the substring presence of
// one does not prove the other.
const DOCTOR_HOOK_LABEL_2 = "aidlc-session-start.ts present";
const DOCTOR_SETTINGS_LABEL = "settings.json present";
const DOCTOR_DOCS_LABEL = "aidlc-docs/ directory exists";
const STOP_AFTER_DOCTOR = { toolName: "Bash", resultIncludes: DOCTOR_HEADER } as const;

describe("t22 /aidlc --doctor (SDK port)", () => {
  // -------------------------------------------------------------------------
  // With state + audit. Re-expresses .sh tests 1-9 deterministically.
  //
  // .sh tests 1-7,9 (PROSE-FLAKY) grepped the assistant prose for the bun,
  // audit-logger (hook), session-start, settings, and "health" keywords with a
  // SUMMARY_PASS regex-OR fallback. Here we assert those exact labels against
  // the Bash tool_result — the deterministic doctor stdout the tool emitted.
  //   - .sh test 7 ("bun")          -> DOCTOR_BUN_LABEL
  //   - .sh tests 1,4 ("audit-logger") -> DOCTOR_HOOK_LABEL
  //   - .sh tests 2,5 ("session-start") -> DOCTOR_HOOK_LABEL_2 (a SEPARATE
  //                                        `${h}.ts present` line per hook)
  //   - .sh tests 3,6 ("settings")  -> DOCTOR_SETTINGS_LABEL
  //   - .sh test 9 ("health" header) -> DOCTOR_HEADER + the "N passed, M
  //                                      failed" footer shape
  //
  // .sh test 8 (DETERMINISTIC: audit grew) -> auditEvents contains the exact
  // event the doctor appends (HEALTH_CHECKED, utility.ts:1376) AND the audit
  // log strictly grew vs before the run. The HEALTH_CHECKED event-type is a
  // stronger re-expression than byte-count growth alone: it names WHY it grew.
  // -------------------------------------------------------------------------
  test(
    "doctor tool_result carries every checked label; audit grows with HEALTH_CHECKED",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const auditBefore = readAuditEvents(proj) ?? [];

        const r = await driveAidlc("/aidlc --doctor", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_DOCTOR,
        });

        // The doctor tool actually fired (a Bash call) AND its verbatim result
        // carries each per-check label. assertToolResultContains refuses to
        // pass vacuously if Bash never fired (see calibration 4) — so this is
        // also proof the --doctor path RAN, not just that prose mentioned it.
        // Header + footer (was .sh test 9's "health" grep):
        assertToolResultContains(r, "Bash", DOCTOR_HEADER);
        // bun runtime check (was .sh test 7):
        assertToolResultContains(r, "Bash", DOCTOR_BUN_LABEL);
        // hook-presence checks — the .sh asserted BOTH hooks separately:
        // audit-logger (tests 1,4) AND session-start (tests 2,5). Each is its
        // own `${h}.ts present` line in the doctor stdout, so assert both.
        assertToolResultContains(r, "Bash", DOCTOR_HOOK_LABEL);
        assertToolResultContains(r, "Bash", DOCTOR_HOOK_LABEL_2);
        // settings check (was .sh tests 3,6):
        assertToolResultContains(r, "Bash", DOCTOR_SETTINGS_LABEL);

        // The footer shape "N passed, M failed" is verbatim tool stdout
        // (utility.ts:1371) — a structure the LLM prose does not reliably
        // reproduce. Locate it in the SAME Bash tool_result that carried the
        // header (so an unrelated Bash call can't satisfy it).
        const doctorCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(DOCTOR_HEADER),
        );
        expect(doctorCall).toBeDefined();
        expect(doctorCall?.isError).toBe(false);
        expect(doctorCall!.resultText).toMatch(/\d+ passed, \d+ failed/);

        // .sh test 8: audit file grew. Re-expressed on auditEvents: the doctor
        // appends exactly HEALTH_CHECKED, so the post-run log must contain it
        // and be strictly longer than before.
        const auditAfter = r.auditEvents ?? [];
        expect(auditAfter).toContain("HEALTH_CHECKED");
        expect(auditAfter.length).toBeGreaterThan(auditBefore.length);

        // The driver intentionally aborts as soon as the deterministic doctor
        // stdout lands, so a terminal SDK result is not required; this prevents
        // the model continuing into unrelated workflow execution after the
        // utility contract has already been proven.
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Without aidlc-docs/. Re-expresses .sh test 10 (already deterministic).
  //
  // When aidlc-docs/ is missing, check #5 fails (utility.ts:392-398) and the
  // doctor exits non-zero; the orchestrator's tool-failure handler prints the
  // doctor stdout verbatim. The .sh grepped that prose for the SPECIFIC
  // failing-check label "aidlc-docs/ directory exists" (deliberately specific
  // so a loose echo of the command wouldn't match). Here we assert that exact
  // label against the Bash tool_result — the failing-check label is verbatim
  // tool stdout, so this is the deterministic equivalent of the .sh grep.
  // -------------------------------------------------------------------------
  test(
    "doctor without aidlc-docs/ surfaces the failing-check label in the tool_result",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        const before = readdirSync(proj);
        // Precondition: aidlc-docs/ truly absent so the check genuinely fails.
        expect(before).not.toContain("aidlc-docs");

        const r = await driveAidlc("/aidlc --doctor", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_DOCTOR,
        });

        // The doctor tool fired AND its verbatim result names the specific
        // failing check. assertToolResultContains proves Bash fired (no
        // vacuous pass) — the same guarantee the .sh's specific-label grep gave.
        assertToolResultContains(r, "Bash", DOCTOR_DOCS_LABEL);

        // And the report header is present in that same stdout — proving the
        // failing label came from the doctor block, not stray prose.
        assertToolResultContains(r, "Bash", DOCTOR_HEADER);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
