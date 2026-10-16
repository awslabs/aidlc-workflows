// covers: subcommand:aidlc-utility:doctor
//
// t22.test.ts - drives /aidlc --doctor.
//
// THE DETERMINISTIC SURFACE. /aidlc --doctor runs a deterministic bun tool
// (collectDoctorReport in aidlc-utility.ts, rendered by aidlc-doctor.ts
// humanReport) whose stdout is fixed bytes. The SDK surfaces those bytes
// VERBATIM in the Bash tool_result, before the LLM rewords them - the
// calibration (sdk-drive.calibration.test.ts CALIBRATION 2) proved the doctor
// block is byte-stable across runs and carries the exact labels. We assert
// against the Bash tool_result via assertToolResultContains: same contract,
// stable surface.
//
// The known-answer label strings are READ from the shipped doctor handler
// (dist/claude/.claude/tools/aidlc-utility.ts collectDoctorReport), NOT guessed:
//   - header literal:     "AI-DLC doctor"                     (aidlc-doctor.ts humanReport)
//   - runtime label:      "Runtime hook PATH: bun"                  (shared diagnostics)
//   - hook check label:   "<hook>.ts present"                 (utility.ts)
//   - settings label:     "settings.json present"            (utility.ts)
//   - shell-ready label:  "workspace shell ready"            (utility.ts; P4: the
//                         old "aidlc-docs/ directory exists" row was retired - auto-create
//                         needs no scaffolded aidlc-docs/, so doctor checks the SHIPPED SHELL
//                         (.claude/ + aidlc/spaces/default/memory/) instead)
//   - footer shape:       "N passed, M failed"               (utility.ts)
//                         as first ported; today the human report's footer reads
//                         "N problems, M warnings." (aidlc-doctor.ts humanReport)
//   - audit event:        "HEALTH_CHECKED"                    (utility.ts)
//
// MECHANISM. Mechanism `sdk` is derived from the driveAidlc call. The covered
// unit `aidlc-utility doctor` is minMechanism `cli` (rank 1); sdk satisfies
// cli (2 >= 1), so the covers claim is honoured by the guarantee-principle
// gate. Both per-hook presence labels are asserted independently.
//
// ASSERTS ONLY ON: toolResults (the Bash doctor stdout bytes), auditEvents
// (HEALTH_CHECKED + growth). NEVER on assistantText.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readAuditEvents } from "../harness/sdk-drive.ts";

// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Known-answer doctor strings, read from the shipped handler (see header).
const DOCTOR_HEADER = "AI-DLC doctor";
const DOCTOR_RUNTIME_LABEL = "Runtime hook PATH: bun";
const DOCTOR_HOOK_LABEL = "aidlc-write-audit-log.ts present";
// collectDoctorReport emits a separate `${h}.ts present` line per hook
// (aidlc-utility.ts); we assert each hook label independently - proving the
// substring presence of one does not prove the other.
const DOCTOR_HOOK_LABEL_2 = "aidlc-session-start.ts present";
const DOCTOR_SETTINGS_LABEL = "settings.json present";
// Doctor checks the SHIPPED workspace shell (.claude/ +
// aidlc/spaces/default/memory/) - the row label substring is "workspace shell
// ready". Its remediation names the refresh that rebuilds the shell: a bare
// `aidlc config` was circular, because on a project that already has a
// harness directory it takes the interactive existing-projection walk, which
// never recreates a missing shell. The command prefix varies by channel
// (native `aidlc` vs a copy install's bun dispatcher), and `config --harness`
// alone also appears in the installed-runtime row's fix, so match the flag
// together with the suffix only this row prints.
const DOCTOR_SHELL_LABEL = "workspace shell ready";
const DOCTOR_SHELL_FIX = "config --harness claude";
const DOCTOR_SHELL_FIX_SUFFIX =
  "in the project root to recreate the harness tree and workspace shell";
const STOP_AFTER_DOCTOR = { toolName: "Bash", resultIncludes: DOCTOR_HEADER } as const;

describe("t22 /aidlc --doctor (SDK port)", () => {
  // -------------------------------------------------------------------------
  // With state + audit.
  //
  // We assert the exact labels against the Bash tool_result - the deterministic
  // doctor stdout the tool emitted.
  //   - bun runtime                 -> DOCTOR_RUNTIME_LABEL
  //   - audit-logger                -> DOCTOR_HOOK_LABEL
  //   - session-start               -> DOCTOR_HOOK_LABEL_2 (a SEPARATE
  //                                        `${h}.ts present` line per hook)
  //   - settings                    -> DOCTOR_SETTINGS_LABEL
  //   - health report               -> DOCTOR_HEADER + the "N problems, M
  //                                    warnings." footer shape
  //
  // Audit growth -> auditEvents contains the exact event the doctor appends
  // (HEALTH_CHECKED, collectDoctorReport) AND the audit log strictly grew vs
  // before the run. The HEALTH_CHECKED event-type names WHY it grew.
  // -------------------------------------------------------------------------
  test(
    "doctor tool_result carries every checked label; audit grows with HEALTH_CHECKED",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const auditBefore = readAuditEvents(proj) ?? [];

        const r = await driveAidlc("/aidlc --doctor --verbose", {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_DOCTOR,
        });

        // The doctor tool actually fired (a Bash call) AND its verbatim result
        // carries each per-check label. assertToolResultContains refuses to
        // pass vacuously if Bash never fired (see calibration 4) — so this is
        // also proof the --doctor path RAN, not just that prose mentioned it.
        // Header + footer:
        assertToolResultContains(r, "Bash", DOCTOR_HEADER);
        assertToolResultContains(r, "Bash", DOCTOR_RUNTIME_LABEL);
        // Hook-presence checks: audit-logger AND session-start. Each is its
        // own `${h}.ts present` line in the doctor stdout, so assert both.
        assertToolResultContains(r, "Bash", DOCTOR_HOOK_LABEL);
        assertToolResultContains(r, "Bash", DOCTOR_HOOK_LABEL_2);
        assertToolResultContains(r, "Bash", DOCTOR_SETTINGS_LABEL);

        // The footer shape "N problems, M warnings." is verbatim tool stdout
        // (aidlc-doctor.ts humanReport) - a structure the LLM prose does not reliably
        // reproduce. Locate it in the SAME Bash tool_result that carried the
        // header (so an unrelated Bash call can't satisfy it).
        const doctorCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(DOCTOR_HEADER),
        );
        expect(doctorCall).toBeDefined();
        expect(doctorCall?.isError).toBe(false);
        expect(doctorCall!.resultText).toMatch(/\d+ problems?, \d+ warnings?\./);

        // Audit file grew. The doctor appends exactly HEALTH_CHECKED, so the post-run
        // log must contain it and be strictly longer than before.
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
  // Without the shipped shell.
  //
  // With auto-create there is no scaffolded aidlc-docs/ to verify. Readiness is
  // the SHIPPED SHELL - the harness engine dir (.claude/) AND the default space's
  // memory dir (aidlc/spaces/default/memory/) BOTH present (collectDoctorReport).
  // The row PASSes only when both exist; remove the default memory dir so the
  // shell-ready row FAILS, the doctor exits non-zero, and the orchestrator's
  // tool-failure handler prints the doctor stdout verbatim. We assert the
  // "workspace shell ready" label AND its `aidlc config` remediation against
  // the Bash tool_result - the failing-check label is verbatim tool stdout.
  // -------------------------------------------------------------------------
  test(
    "doctor without the shipped shell surfaces the failing shell-ready label + remediation in the tool_result",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        // Break the shipped shell so the readiness row FAILS: setupIntegrationProject
        // always copies .claude/ + aidlc/spaces/default/memory/ (both present →
        // the row would PASS). Removing the default memory dir leaves the row
        // failing on a genuinely-incomplete shell (the dist/ copy was partial).
        const memoryDir = join(proj, "aidlc", "spaces", "default", "memory");
        rmSync(memoryDir, { recursive: true, force: true });
        expect(existsSync(memoryDir)).toBe(false);
        // And aidlc-docs/ is absent too (noAidlcDocs), so nothing masks the failure.
        expect(readdirSync(proj)).not.toContain("aidlc-docs");

        const r = await driveAidlc("/aidlc --doctor", {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_DOCTOR,
        });

        // The doctor tool fired AND its verbatim result names the failing
        // shell-ready check + its remediation. assertToolResultContains proves
        // Bash fired (no vacuous pass).
        assertToolResultContains(r, "Bash", DOCTOR_SHELL_LABEL);
        assertToolResultContains(r, "Bash", DOCTOR_SHELL_FIX);
        assertToolResultContains(r, "Bash", DOCTOR_SHELL_FIX_SUFFIX);

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
