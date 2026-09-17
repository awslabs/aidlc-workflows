// kiro-acp-drive.calibration.test.ts — KNOWN-ANSWER calibration of the Kiro
// ACP harness driver. The trust anchor for every acp-mechanism Kiro test:
// if a calibration cannot confirm the planted truth, the ACP tier is
// untrustworthy. Mirrors sdk-drive.calibration.test.ts's role for the SDK
// driver (its calibrations 2 and 4; calibration 1's canUseTool has no Kiro
// analogue — gates are prose, not protocol objects — and the scripted-answer
// calibration is covered by the multi-turn gate-loop's own journey tests).
//
// SPENDS Kiro credits — gated AIDLC_KIRO_ACP_LIVE=1 like the acp tests.
//
// The calibrations:
//   1. tool_call_update output is BYTE-FAITHFUL to tool stdout: the doctor
//      header/labels read from the SHIPPED handler appear verbatim in the
//      captured tool output (the analogue of SDK calibration 2).
//   2. A planted state file's EXACT field values surface in the status tool's
//      verbatim output (known-answer through the whole engine→tool→ACP path).
//   3. Negative guard: asserting a tool that never ran fails loudly (no
//      vacuous pass — the analogue of SDK calibration 4).
//   (There is NO gate-loop calibration: a 4th calibration attempt proved the
//   conductor does not reliably end its ACP turn at gates — it worked 20
//   minutes inside one turn. Multi-turn journeys are TUI-driver territory;
//   the ACP lane is single-turn contracts bounded by stopAfterToolTitle.)

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { driveKiroAcp } from "./kiro-acp-drive.ts";
import { cleanupTuiProject, KIRO_SRC, setupTuiProject } from "./tui-fixtures.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "1200", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 1200) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(60_000, TEST_TIMEOUT_MS - 15_000);

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the ACP calibrations (uses Kiro credits)";
  }
  if (spawnSync("kiro-cli", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not found";
  }
  if (spawnSync("kiro-cli", ["whoami"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

// Known-answer strings read from the SHIPPED handlers (same provenance as the
// SDK calibration — real, not guessed):
//   aidlc-utility.ts handleDoctor(): header + bun label; the Kiro tree adds
//   the adapter + agent-config labels (harness-aware doctor, parity closeout).
const DOCTOR_HEADER = "AI-DLC doctor";
const DOCTOR_RUNTIME_LABEL = "Self-contained binary runtime (bun is not required)";
const DOCTOR_ADAPTER_LABEL = "aidlc-kiro-adapter.ts present";
const DOCTOR_AGENT_LABEL = "agents/aidlc.json present";

describe("kiro-acp-drive calibration (known-answer)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `1. doctor labels arrive byte-faithful in tool_call output${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
      try {
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --doctor --verbose",
          timeoutMs: DRIVE_TIMEOUT_MS,
        });
        const doctorCall = r.toolCalls.find((t) => t.title.includes("aidlc-utility.ts doctor"));
        expect(doctorCall).toBeDefined();
        const out = doctorCall!.output.join("");
        expect(out).toContain(DOCTOR_HEADER);
        expect(out).toContain(DOCTOR_RUNTIME_LABEL);
        expect(out).toContain(DOCTOR_ADAPTER_LABEL);
        expect(out).toContain(DOCTOR_AGENT_LABEL);
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(SKIP_REASON !== null)(
    `2. planted state fields surface verbatim in the status tool output${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      // state-brownfield-feature.md plants: Scope=feature, Current Stage=
      // requirements-analysis, Completed=12 (verified by grep at authoring).
      const proj = setupTuiProject({
        harness: "kiro",
        withState: "state-brownfield-feature.md",
        withAudit: true,
      });
      try {
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --status",
          timeoutMs: DRIVE_TIMEOUT_MS,
          // The turn-boundary edge (findings §ACP): with an ACTIVE workflow
          // the conductor rolls from the status answer into live execution
          // inside the same turn — cancel as soon as the contract's tool
          // completes. (Proven the hard way: without this, calibration 2 ran
          // the workflow for 19 minutes and timed out.)
          stopAfterToolTitle: /aidlc-utility\.ts status/,
        });
        const statusCall = r.toolCalls.find((t) => t.title.includes("aidlc-utility.ts status"));
        expect(statusCall).toBeDefined();
        const out = statusCall!.output.join("");
        // The status tool renders DISPLAY names (probe-verified): the planted
        // slug requirements-analysis renders "Requirements Analysis (2.3)".
        expect(out).toContain("Requirements Analysis (2.3)");
        expect(out).toContain("Scope:          feature");
        // Known-answer through the full path: the planted Completed count.
        expect(out).toContain("12/");
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(SKIP_REASON !== null)(
    `3. negative guard: a never-run tool is not found (no vacuous pass)${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
      try {
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --version",
          timeoutMs: DRIVE_TIMEOUT_MS,
        });
        // version ran; doctor did NOT — find() must come back empty for it.
        expect(r.toolCalls.find((t) => t.title.includes("aidlc-utility.ts version"))).toBeDefined();
        expect(r.toolCalls.find((t) => t.title.includes("aidlc-utility.ts doctor"))).toBeUndefined();
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

});
