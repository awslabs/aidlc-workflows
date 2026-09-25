// covers: function:repointHarnessIncludes, file:skills/aidlc/SKILL.md
//
// Known-answer native Kiro resource calibration. Fresh negative and positive
// projects use distinct random markers. Only the registered worker may preload
// them; neither agent can read files and the controller has resources: [].
// Assert the native crew's completed tool output, never controller final prose.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTuiProject, KIRO_SRC, setupTuiProject } from "../harness/tui-fixtures.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const WORKER = "aidlc-preload-worker";
const CONTROLLER = "aidlc-preload-controller";
const SPACE = "preload-probe";
const FIELDS = ["PRELOAD_START", "PRELOAD_MIDDLE", "PRELOAD_END"] as const;
const WORKER_PROMPT =
  "This is a native memory preload calibration. Use only context already supplied to you. " +
  "Return exactly three lines: PRELOAD_START=<value>, PRELOAD_MIDDLE=<value>, PRELOAD_END=<value>. " +
  "Copy each value from the matching line of your preloaded rule content. " +
  "If a value is absent from your context, return MISSING for that field. " +
  "Do not guess, delegate, read files, or call tools.";
const BRIEF = "Report the three calibration fields from your existing preloaded context, or MISSING when absent.";
const CONTROLLER_PROMPT =
  `Use the native subagent crew tool once in blocking mode with exactly one stage. ` +
  `Set role to "${WORKER}" and prompt_template to exactly: ${BRIEF} ` +
  "Wait for completion and then stop. Do not add context to the brief. No other tools are available.";
const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(TEST_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "E2E live work",
  })!;
}


function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") return "set AIDLC_KIRO_ACP_LIVE=1 (uses Kiro credits)";
  if (completedStartupProbe(spawnSync("kiro-cli", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) })).status !== 0) return "kiro-cli not found";
  if (completedStartupProbe(spawnSync("kiro-cli", ["whoami"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) })).status !== 0) return "kiro-cli is not authenticated";
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

function memoryFile(values: string[]): string {
  const padding = "- Background: ordinary calibration context containing no calibration field values.\n".repeat(110);
  return `${FIELDS[0]}=${values[0]}\n${padding}${FIELDS[1]}=${values[1]}\n${padding}${FIELDS[2]}=${values[2]}\n`;
}

async function probe(preload: boolean): Promise<string[]> {
  // This synthetic calibration enables the existing diagnostic capture before
  // importing the driver so native child-session identity is retained.
  const { AcpSession, driveKiroAcp } = await import("../harness/kiro-acp-drive.ts");
  const project = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
  const values = FIELDS.map(() => randomBytes(16).toString("hex"));
  const decoys = FIELDS.map(() => randomBytes(16).toString("hex"));
  const mode = preload ? "positive" : "negative";
  try {
    const controller = {
      name: CONTROLLER,
      prompt: CONTROLLER_PROMPT,
      tools: ["subagent"], allowedTools: ["subagent"],
      toolsSettings: { subagent: { trustedAgents: [WORKER] } },
      resources: [],
    };
    // Use the same memory glob as the shipped registered worker; the public
    // space command must repoint it before Kiro starts the fresh session.
    const shipped = JSON.parse(readFileSync(join(KIRO_SRC, "agents", "aidlc-developer-agent.json"), "utf8")) as {
      resources: string[];
    };
    const memoryResources = shipped.resources.filter((entry) =>
      /^file:\/\/aidlc\/spaces\/default\/memory\/\*\*\/\*\.md$/.test(entry));
    expect(memoryResources).toHaveLength(1);
    const worker = {
      name: WORKER, prompt: WORKER_PROMPT,
      tools: [], allowedTools: [],
      resources: preload ? memoryResources : [],
    };
    const agentDir = join(project, ".kiro", "agents");
    writeFileSync(join(agentDir, `${CONTROLLER}.json`), JSON.stringify(controller));
    writeFileSync(join(agentDir, `${WORKER}.json`), JSON.stringify(worker));
    const rules = memoryFile(values);
    const rulePath = join(project, "aidlc", "spaces", SPACE, "memory", "org.md");
    mkdirSync(join(project, "aidlc", "spaces", SPACE, "memory"), { recursive: true });
    writeFileSync(rulePath, rules);
    writeFileSync(join(project, "aidlc", "spaces", "default", "memory", "org.md"), memoryFile(decoys));
    expect(Buffer.byteLength(rules)).toBeGreaterThan(10 * 1024);
    expect(Buffer.byteLength(rules.slice(0, rules.indexOf(`${FIELDS[2]}=`)))).toBeGreaterThan(10 * 1024);
    const switchSpace = spawnSync(process.execPath, [
      join(project, ".kiro", "tools", "aidlc-utility.ts"), "space", SPACE,
    ], { timeout: remainingWorkMs(),
      cwd: project, encoding: "utf8",
      env: { ...process.env, AIDLC_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".kiro" },
    });
    expect(switchSpace.status, switchSpace.stderr).toBe(0);
    const effectiveWorker = JSON.parse(readFileSync(join(agentDir, `${WORKER}.json`), "utf8"));
    const effectiveController = JSON.parse(readFileSync(join(agentDir, `${CONTROLLER}.json`), "utf8"));
    expect(effectiveWorker.resources).toEqual(preload ? [`file://aidlc/spaces/${SPACE}/memory/**/*.md`] : []);
    expect(effectiveController.resources).toEqual([]);
    expect(effectiveController.tools).toEqual(["subagent"]);
    expect(effectiveWorker.tools).toEqual([]);
    const unseededInputs = JSON.stringify({ effectiveWorker, effectiveController, project, rulePath, brief: BRIEF });
    for (const value of [...values, ...decoys]) expect(unseededInputs).not.toContain(value);
    const proof = {
      mode, project, rulePath, ruleBytes: Buffer.byteLength(rules),
      markerOffsets: values.map(value => Buffer.byteLength(rules.slice(0, rules.indexOf(value)))),
      expectedMarkers: values, wrongSpaceMarkers: decoys,
      controller: effectiveController, worker: effectiveWorker, brief: BRIEF,
    };
    const logDir = process.env.AIDLC_TEST_LOG_DIR;
    if (logDir) writeFileSync(join(logDir, `kiro-preload-${mode}-setup.json`), JSON.stringify(proof, null, 2));
    const session = new AcpSession(project, CONTROLLER, true);
    const result = await driveKiroAcp({
      projectDir: project, agent: CONTROLLER, session, prompt: "Run the calibration.",
      timeoutMs: remainingWorkMs(),
    });
    if (logDir) writeFileSync(join(logDir, `kiro-preload-${mode}-result.json`), JSON.stringify({
      stopReason: result.stopReason, toolCalls: result.toolCalls,
      toolCallIssues: result.toolCallIssues, permissionRequests: result.permissionRequests,
    }, null, 2));
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCallIssues).toEqual([]);
    // Native crew completion uses the worker's mandatory summary tool, exposed
    // on a distinct child wire session. The outer crew output itself contains
    // only "Running crew pipeline". Neither is the controller's final prose.
    expect(result.toolCalls).toHaveLength(2);
    const crews = result.toolCalls.filter(call =>
      call.rawInput !== null && typeof call.rawInput === "object" && "stages" in call.rawInput);
    expect(crews).toHaveLength(1);
    const call = crews[0];
    expect(call.status).toBe("completed");
    const input = call.rawInput as { stages?: Array<{ role?: string; prompt_template?: string }>; mode?: string };
    expect(input.mode).toBe("blocking");
    expect(input.stages).toHaveLength(1);
    expect(input.stages?.[0].role).toBe(WORKER);
    expect(input.stages?.[0].prompt_template).toBe(BRIEF);
    for (const value of [...values, ...decoys]) expect(JSON.stringify(call.rawInput)).not.toContain(value);
    const summaries = result.toolCalls.filter(candidate =>
      candidate.title === "Summarizing" &&
      candidate.rawInput !== null && typeof candidate.rawInput === "object" &&
      "taskResult" in candidate.rawInput);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary.status).toBe("completed");
    expect(summary.title).toBe("Summarizing");
    expect(session.tracePath).toBeDefined();
    const protocolPath = `${session.tracePath}.protocol.ndjson`;
    const protocol = readFileSync(protocolPath, "utf8").trim().split("\n").map(line =>
      JSON.parse(line) as {
        sequence: number; event: string; wireSessionId?: string;
        update?: { toolCallId?: string; status?: string; sessionUpdate?: string };
      });
    const completions = protocol.filter(row =>
      row.event === "wire_tool_update" && row.update?.sessionUpdate === "tool_call_update" &&
      row.update.status === "completed");
    const crewCompleted = completions.filter(row => row.update?.toolCallId === call.toolCallId);
    const workerCompleted = completions.filter(row => row.update?.toolCallId === summary.toolCallId);
    expect(crewCompleted).toHaveLength(1);
    expect(workerCompleted).toHaveLength(1);
    expect(crewCompleted[0].wireSessionId).toBe(result.sessionId);
    expect(typeof workerCompleted[0].wireSessionId).toBe("string");
    expect(workerCompleted[0].wireSessionId?.length).toBeGreaterThan(0);
    expect(workerCompleted[0].wireSessionId).not.toBe(result.sessionId);
    expect(workerCompleted[0].sequence).toBeLessThan(crewCompleted[0].sequence);
    const output = (summary.rawInput as { taskResult: string }).taskResult;
    expect(typeof output).toBe("string");
    if (logDir) writeFileSync(join(logDir, `kiro-preload-${mode}-completion.json`), JSON.stringify({
      controllerSessionId: result.sessionId, workerSessionId: workerCompleted[0].wireSessionId,
      crewToolCallId: call.toolCallId, workerSummaryToolCallId: summary.toolCallId,
      workerCompletionSequence: workerCompleted[0].sequence, crewCompletionSequence: crewCompleted[0].sequence,
      protocolPath, output,
    }, null, 2));
    expect(output.length).toBeGreaterThan(0);
    for (let i = 0; i < FIELDS.length; i++) {
      expect(output).toContain(`${FIELDS[i]}=${preload ? values[i] : "MISSING"}`);
      expect(output).not.toContain(decoys[i]);
      if (!preload) expect(output).not.toContain(values[i]);
    }
    return values;
  } finally {
    cleanupTuiProject(project);
  }
}

describe("native Kiro registered-worker rule preloading", () => {
  test.skipIf(SKIP_REASON !== null)(
    `crew completion returns unknown start/middle/end markers only with native resources${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const savedDiagnostic = process.env.AIDLC_ACP_DIAGNOSTIC_TRACE;
      process.env.AIDLC_ACP_DIAGNOSTIC_TRACE = "1";
      try {
        const negative = await probe(false);
        const positive = await probe(true);
        expect(positive.every(value => !negative.includes(value))).toBe(true);
      } finally {
        if (savedDiagnostic === undefined) delete process.env.AIDLC_ACP_DIAGNOSTIC_TRACE;
        else process.env.AIDLC_ACP_DIAGNOSTIC_TRACE = savedDiagnostic;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
