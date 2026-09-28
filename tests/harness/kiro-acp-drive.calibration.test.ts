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

import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { type AcpDriveResult, type AcpToolCall, driveKiroAcp } from "./kiro-acp-drive.ts";
import { cleanupTuiProject, KIRO_SRC, setupTuiProject } from "./tui-fixtures.ts";
import {
  fileCleanupReserveMs,
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "./test-budget.ts";

// Live protocol calibration uses shared backstops, not short timeout faults.
// Preserve explicit whole-case seconds and allocate from the remaining case
// and file work deadlines after setup, without a minimum that extends them.
const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "ACP protocol calibration",
  })!;
}

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  // A slow installed CLI is a failed probe, not evidence that live coverage
  // should be skipped as unavailable.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the ACP calibrations (uses Kiro credits)";
  }
  if (completedStartupProbe(spawnSync("kiro-cli", ["--version"], {
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "ACP calibration version probe" }),
  })).status !== 0) {
    return "kiro-cli not found";
  }
  if (completedStartupProbe(spawnSync("kiro-cli", ["whoami"], {
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "ACP calibration auth probe" }),
  })).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

// Known-answer strings read from the SHIPPED handlers (same provenance as the
// SDK calibration — real, not guessed):
//   aidlc-utility.ts handleDoctor() + aidlc-config-diagnostics.ts: the copy
//   projection uses bun; Kiro wiring includes its adapter and agent config.
const DOCTOR_HEADER = "AI-DLC doctor";
const DOCTOR_RUNTIME_LABEL = "Runtime hook PATH: bun";
const DOCTOR_ADAPTER_LABEL = "aidlc-kiro-adapter.ts present";
const DOCTOR_AGENT_LABEL = "agents/aidlc.{json,md} present (conductor wiring)";

// `/aidlc --status/--doctor/--version` now runs in userPromptSubmit, before
// ACP tool calls. Calibrate the tool-output channel by explicitly requesting a
// fixture tool that invokes the real shipped utility. Its stdout is saved as
// bytes and framed in one write, so transport framing cannot hide a changed
// newline or substitute the assistant's prose for the utility's output.
function utilityProbe(project: string, verb: "doctor" | "status" | "version") {
  const file = `.kiro/tools/aidlc-calibration-${verb}.ts`;
  const stdoutFile = `.aidlc-calibration-${verb}.stdout`;
  const exitCodeFile = `.aidlc-calibration-${verb}.exit-code.json`;
  const begin = `AIDLC_CALIBRATION_${verb}_STDOUT_BEGIN\n`;
  const end = `AIDLC_CALIBRATION_${verb}_STDOUT_END\n`;
  const args = [".kiro/tools/aidlc-utility.ts", verb, ...(verb === "doctor" ? ["--verbose"] : [])];
  writeFileSync(join(project, file), [
    'import { writeFileSync } from "node:fs";',
    `import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from ${JSON.stringify(new URL("./test-budget.ts", import.meta.url).href)};`,
    `const result = Bun.spawnSync([process.execPath, ...${JSON.stringify(args)}], {`,
    '  cwd: process.cwd(), env: { ...process.env, AIDLC_PROJECT_DIR: process.cwd() },',
    '  stdout: "pipe", stderr: "pipe",',
    `  timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { deadlineMs: ${caseDeadlineMs}, reserveMs: ${fileCleanupReserveMs(TEST_TIMEOUT_MS)}, phase: "ACP calibration utility" }),`,
    "});",
    `writeFileSync(${JSON.stringify(stdoutFile)}, result.stdout);`,
    `writeFileSync(${JSON.stringify(exitCodeFile)}, JSON.stringify({ exitCode: result.exitCode }));`,
    `process.stdout.write(Buffer.concat([Buffer.from(${JSON.stringify(begin)}), result.stdout, Buffer.from(${JSON.stringify(end)})]));`,
    "process.stderr.write(result.stderr);",
    "process.exit(result.exitCode);",
    "",
  ].join("\n"));
  const command = `bun ${file}`;
  return {
    command, stdoutPath: join(project, stdoutFile),
    exitCodePath: join(project, exitCodeFile), begin, end,
    title: new RegExp(`aidlc-calibration-${verb}\\.ts`),
    prompt: `Run exactly this command once using your shell tool in the current project:\n\`${command}\`\n` +
      "This is an instrument calibration. Return after the command; do not advance the workflow.",
  };
}

function commandInput(call: AcpToolCall): string | undefined {
  if (!call.rawInput || typeof call.rawInput !== "object") return undefined;
  const command = (call.rawInput as { command?: unknown }).command;
  return typeof command === "string" ? command.trim() : undefined;
}

function recordCalibration(name: string, result: AcpDriveResult, probe: ReturnType<typeof utilityProbe>): void {
  const logs = process.env.AIDLC_TEST_LOG_DIR;
  if (logs) writeFileSync(join(logs, `kiro-calibration-${name}-${process.pid}.json`), JSON.stringify({
    stopReason: result.stopReason,
    utilityExitCode: existsSync(probe.exitCodePath)
      ? JSON.parse(readFileSync(probe.exitCodePath, "utf8")).exitCode
      : null,
    toolCalls: result.toolCalls,
    toolCallIssues: result.toolCallIssues,
  }, null, 2));
}

function probeOutput(result: AcpDriveResult, probe: ReturnType<typeof utilityProbe>): string {
  expect(result.toolCallIssues).toEqual([]);
  const calls = result.toolCalls.filter((call) => commandInput(call) === probe.command);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  // stopAfterToolTitle cancels when output arrives, before a separate
  // completed notification is guaranteed. The real utility has already exited:
  // the wrapper records its exit code synchronously before emitting the frame.
  expect(existsSync(probe.exitCodePath)).toBe(true);
  expect(JSON.parse(readFileSync(probe.exitCodePath, "utf8")).exitCode).toBe(0);
  const output = call.output.join("");
  const start = output.indexOf(probe.begin);
  const finish = output.indexOf(probe.end, start + probe.begin.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(finish).toBeGreaterThan(start);
  expect(existsSync(probe.stdoutPath)).toBe(true);
  const expected = readFileSync(probe.stdoutPath, "utf8");
  expect(expected.length).toBeGreaterThan(0);
  const actual = output.slice(start + probe.begin.length, finish);
  expect(actual).toBe(expected);
  return actual;
}

describe("kiro-acp-drive calibration (known-answer)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `1. doctor labels arrive byte-faithful in tool_call output${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
      try {
        const probe = utilityProbe(proj, "doctor");
        expect(existsSync(join(proj, ".kiro", "agents", "aidlc.json"))).toBe(true);
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: probe.prompt,
          timeoutMs: remainingWorkMs(),
        });
        recordCalibration("doctor", r, probe);
        const doctorCall = r.toolCalls.find((t) => commandInput(t) === probe.command);
        expect(doctorCall).toBeDefined();
        const out = probeOutput(r, probe);
        expect(out).toContain(DOCTOR_HEADER);
        expect(out).toContain(DOCTOR_RUNTIME_LABEL);
        expect(out).toContain(DOCTOR_ADAPTER_LABEL);
        expect(out).toContain(DOCTOR_AGENT_LABEL);
        expect(out).toContain("settings/cli.json present (workspace default-agent activation)");
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
        const probe = utilityProbe(proj, "status");
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: probe.prompt,
          timeoutMs: remainingWorkMs(),
          // The turn-boundary edge (findings §ACP): with an ACTIVE workflow
          // the conductor rolls from the status answer into live execution
          // inside the same turn — cancel as soon as the contract's tool
          // completes. (Proven the hard way: without this, calibration 2 ran
          // the workflow for 19 minutes and timed out.)
          stopAfterToolTitle: probe.title,
        });
        recordCalibration("status", r, probe);
        const statusCall = r.toolCalls.find((t) => commandInput(t) === probe.command);
        expect(statusCall).toBeDefined();
        const out = probeOutput(r, probe);
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
        const version = utilityProbe(proj, "version");
        const doctor = utilityProbe(proj, "doctor");
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: version.prompt,
          timeoutMs: remainingWorkMs(),
        });
        recordCalibration("version-negative", r, version);
        // version ran; doctor did NOT — find() must come back empty for it.
        expect(r.toolCalls.find((t) => commandInput(t) === version.command)).toBeDefined();
        expect(r.toolCalls.find((t) => commandInput(t) === doctor.command)).toBeUndefined();
        expect(r.toolCalls.map(commandInput).filter((command) => command !== undefined)).toEqual([version.command]);
        expect(existsSync(doctor.stdoutPath)).toBe(false);
        expect(probeOutput(r, version)).toBe(`aidlc ${AIDLC_VERSION}\n`);
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

});
