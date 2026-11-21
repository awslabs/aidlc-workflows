// covers: file:skills/aidlc/SKILL.md
//
// t-acp-devin-calibration.serial.test.ts — KNOWN-ANSWER calibration of the
// Devin ACP harness driver (tests/harness/devin-acp-drive.ts). The trust
// anchor for every acp-mechanism Devin test: if a calibration cannot confirm
// the planted truth, the ACP tier is untrustworthy. Mirrors
// tests/harness/kiro-acp-drive.calibration.test.ts's utilityProbe idea
// against the shipped dist/devin tree.
//
//   1. tool_call_update output is byte-faithful to tool stdout once Devin's
//      120-column display wrap codes are stripped: a fixture tool writes the
//      real `aidlc-utility.ts doctor --verbose` stdout to a file and prints
//      it between BEGIN/END markers; the cleaned captured output between the
//      markers must equal the file bytes.
//   2. Negative guard: asking for the version probe only must not show the
//      doctor probe's command or output (no vacuous pass).
//   3. The elicitation channel: a no-workflow prompt asks the agent to call
//      ask_user_question once with two verbatim questions (one single-select,
//      one multi-select); the answerer replies with free text on q0 and two
//      labels on q1, and the ask call's final text carries them.
//
// SPENDS Devin credits — gated AIDLC_DEVIN_ACP_LIVE=1 (see devinAcpSkipReason).

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import {
  cleanDevinOutput,
  driveDevinAcp,
  devinAcpSkipReason,
  type DevinAcpDriveResult,
  type DevinToolCall,
} from "../harness/devin-acp-drive.ts";
import { setupDevinProject } from "../harness/exec-drive.ts";
import { rmSync } from "node:fs";
import {
  fileCleanupReserveMs,
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

const SKIP_REASON = devinAcpSkipReason();

// Live protocol calibration uses shared backstops, not short timeout faults.
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
    phase: "Devin ACP calibration",
  })!;
}

// Known-answer labels read from the shipped doctor handler (probe-verified
// on the real `aidlc-utility.ts doctor --verbose` output).
const DOCTOR_HEADER = "AI-DLC doctor";
const DOCTOR_RUNTIME_LABEL = "Runtime hook PATH: bun";
const DOCTOR_ADAPTER_LABEL = "aidlc-devin-adapter.ts present";
const DOCTOR_HOOKS_LABEL = "hooks.v1.json present";

// `/aidlc --status/--doctor/--version` ride the prompt on Devin, so the
// tool-output channel is calibrated through a fixture tool that invokes the
// real shipped utility. Its stdout is saved as bytes and framed in one
// write, so transport framing cannot hide a changed newline or substitute
// the assistant's prose for the utility's output.
function utilityProbe(project: string, verb: "doctor" | "version") {
  const file = `.devin/tools/aidlc-calibration-${verb}.ts`;
  const stdoutFile = `.aidlc-calibration-${verb}.stdout`;
  const exitCodeFile = `.aidlc-calibration-${verb}.exit-code.json`;
  const begin = `AIDLC_CALIBRATION_${verb}_STDOUT_BEGIN\n`;
  const end = `AIDLC_CALIBRATION_${verb}_STDOUT_END\n`;
  const args = [".devin/tools/aidlc-utility.ts", verb, ...(verb === "doctor" ? ["--verbose"] : [])];
  writeFileSync(join(project, file), [
    'import { writeFileSync } from "node:fs";',
    `const result = Bun.spawnSync([process.execPath, ...${JSON.stringify(args)}], {`,
    '  cwd: process.cwd(), env: { ...process.env, AIDLC_PROJECT_DIR: process.cwd() },',
    '  stdout: "pipe", stderr: "pipe",',
    "  timeout: 300000,",
    "});",
    `writeFileSync(${JSON.stringify(stdoutFile)}, result.stdout);`,
    `writeFileSync(${JSON.stringify(exitCodeFile)}, JSON.stringify({ exitCode: result.exitCode }));`,
    // Await the write before exiting: process.exit can drop buffered stdout.
    `process.stdout.write(Buffer.concat([Buffer.from(${JSON.stringify(begin)}), result.stdout, Buffer.from(${JSON.stringify(end)})]), () => process.exit(result.exitCode));`,
    "process.stderr.write(result.stderr);",
    "",
  ].join("\n"));
  const command = `bun ${file}`;
  return {
    command,
    stdoutPath: join(project, stdoutFile),
    exitCodePath: join(project, exitCodeFile),
    begin,
    end,
    prompt: `Run exactly this command once using your shell tool in the current project:\n\`${command}\`\n` +
      "This is an instrument calibration. Return after the command; do not advance the workflow.",
  };
}

function commandInput(call: DevinToolCall): string | undefined {
  if (!call.rawInput || typeof call.rawInput !== "object" || Array.isArray(call.rawInput)) return undefined;
  const command = (call.rawInput as { command?: unknown }).command;
  return typeof command === "string" ? command.trim() : undefined;
}

function probeOutput(result: DevinAcpDriveResult, probe: ReturnType<typeof utilityProbe>): string {
  expect(result.toolCallIssues).toEqual([]);
  const calls = result.toolCalls.filter(
    (call) => (call.kind === "execute" || call.tool === "exec") && commandInput(call) === probe.command,
  );
  expect(calls, JSON.stringify(result.toolCalls.map((t) => ({ title: t.title, command: commandInput(t) })))).toHaveLength(1);
  const call = calls[0];
  expect(call.status).toBe("completed");
  expect(existsSync(probe.exitCodePath)).toBe(true);
  expect(JSON.parse(readFileSync(probe.exitCodePath, "utf8")).exitCode).toBe(0);
  const output = cleanDevinOutput(call.output);
  const start = output.indexOf(probe.begin);
  // The wire may drop the frame's final newline; the END marker's text is the
  // delimiter, its newline is not part of the payload.
  const endMarker = probe.end.trimEnd();
  const finish = output.indexOf(endMarker, start + probe.begin.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(finish).toBeGreaterThan(start);
  expect(existsSync(probe.stdoutPath)).toBe(true);
  const expected = readFileSync(probe.stdoutPath, "utf8");
  expect(expected.length).toBeGreaterThan(0);
  const actual = output.slice(start + probe.begin.length, finish);
  expect(actual).toBe(expected);
  return actual;
}

describe("t-acp-devin-calibration (known-answer ACP self-checks)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `1. doctor stdout arrives byte-faithful through tool_call_update after wrap-code cleaning${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const { proj, root } = setupDevinProject();
      try {
        const probe = utilityProbe(proj, "doctor");
        const r = await driveDevinAcp({
          projectDir: proj,
          prompt: probe.prompt,
          timeoutMs: remainingWorkMs(),
        });
        expect(r.availableCommands).toContain("aidlc");
        const out = probeOutput(r, probe);
        expect(out).toContain(DOCTOR_HEADER);
        expect(out).toContain(DOCTOR_RUNTIME_LABEL);
        expect(out).toContain(DOCTOR_ADAPTER_LABEL);
        expect(out).toContain(DOCTOR_HOOKS_LABEL);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(SKIP_REASON !== null)(
    `2. negative guard: a never-run probe is not found (no vacuous pass)${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const { proj, root } = setupDevinProject();
      try {
        const version = utilityProbe(proj, "version");
        const doctor = utilityProbe(proj, "doctor");
        const r = await driveDevinAcp({
          projectDir: proj,
          prompt: version.prompt,
          timeoutMs: remainingWorkMs(),
        });
        // version ran; doctor did NOT — find() must come back empty for it.
        expect(r.toolCalls.find((t) => commandInput(t) === doctor.command)).toBeUndefined();
        expect(existsSync(doctor.stdoutPath)).toBe(false);
        expect(probeOutput(r, version)).toBe(`aidlc ${AIDLC_VERSION}\n`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(SKIP_REASON !== null)(
    `3. ask_user_question reaches the client as elicitation/create and the reply round-trips${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const { proj, root } = setupDevinProject();
      try {
        const singleQ = "Which colour should the header use?";
        const multiQ = "Which sizes should the banner support?";
        const freeText = "Purple please, it matches the logo";
        const labels = ["Small", "Large"];
        const r = await driveDevinAcp({
          projectDir: proj,
          prompt:
            "Use the ask_user_question tool exactly once to ask me these two questions, " +
            "with exactly these options. Question 1 (header \"Colour\", single-select, " +
            `options "Red", "Blue"): ${singleQ} ` +
            "Question 2 (header \"Sizes\", multi-select, options \"Small\", \"Medium\", " +
            `"Large"): ${multiQ} Then report what I answered.`,
          timeoutMs: remainingWorkMs(),
          answer: () => ({
            action: "accept",
            answers: { q0: freeText, q1: labels },
          }),
        });
        expect(r.elicitations.length).toBeGreaterThanOrEqual(1);
        const record = r.elicitations[0];
        expect(record.outcome).toBe("answered");
        const e = record.elicitation;
        expect(e.allowOther).toBe(true);
        expect(e.questions).toHaveLength(2);
        expect(e.questions[0].question).toBe(singleQ);
        expect(e.questions[0].multiSelect).toBe(false);
        expect(e.questions[0].options.map((o) => o.label)).toEqual(["Red", "Blue"]);
        expect(e.questions[1].question).toBe(multiQ);
        expect(e.questions[1].multiSelect).toBe(true);
        expect(e.questions[1].options.map((o) => o.label)).toEqual(["Small", "Medium", "Large"]);
        // The ask tool call's final text carries the person's words and picks.
        const asks = r.toolCalls.filter((t) => t.tool === "ask_user_question" && t.status === "completed");
        expect(asks).toHaveLength(1);
        expect(asks[0].output).toContain(freeText);
        for (const label of labels) expect(asks[0].output).toContain(label);
        expect(r.toolCallIssues).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
