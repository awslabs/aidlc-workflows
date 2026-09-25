// sdk-drive.calibration.test.ts — KNOWN-ANSWER calibration of the SDK harness.
//
// This file calibrates the just-built measuring instrument (tests/harness/
// sdk-drive.ts + assert.ts + fixtures.ts) against planted truths the driver
// MUST report exactly. It is the trust anchor for every sdk-mechanism test
// above it: if a calibration here cannot confirm the planted truth, the whole
// SDK E2E tier is untrustworthy.
//
// It SPENDS TOKENS — it drives the real /aidlc through the Claude Agent SDK
// (SDK 0.3.158, Opus on Bedrock; env inherited from the sandbox). Each test
// carries a generous per-test timeout so a hung canUseTool fails LOUD (the
// bun:test timeout fires) rather than hanging the runner forever.
//
// The four calibrations (assignment IDs in comments):
//   1. canUseTool fires for AskUserQuestion          (sdk-drive-canusetool)
//   2. tool_result is BYTE-IDENTICAL to tool stdout   (sdk-drive-toolresult-byte-identity)
//   3. a SCRIPTED non-default answer reaches the model(sdk-drive-scripted-answer)
//   4. assertToolResultContains FAILS when the tool was absent (guard, no vacuous pass)
//
// Calibrations 1-3 assert ONLY on deterministic surfaces: the structured
// AskUserQuestion the driver captured (askedQuestions), the verbatim Bash
// tool_result bytes (toolResults), and the on-disk state file the chosen
// branch wrote (stateFile). Never on assistantText.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseLiteralShellInvocation } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  assertToolResultContains,
} from "./assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "./fixtures.ts";
import {
  type CapturedToolResult,
  type DriveResult,
  driveAidlc,
} from "./sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget. A multi-tool /aidlc turn on Opus/Bedrock can take minutes.
// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; see the t2x
// integration tests, which set it to 600 for doctor/jump). The bun:test
// per-test cap is that value; the driver's own abort fires a hair earlier so a
// stuck canUseTool surfaces as a clear harness failure (no result event) and
// not as a 0-byte hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
// Drive aborts ~15s before bun kills the test, so we still capture a partial
// DriveResult to assert against / diagnose, rather than an opaque test-timeout.
const DRIVE_TIMEOUT_MS = Math.max(60_000, TEST_TIMEOUT_MS - 15_000);

// ---------------------------------------------------------------------------
// CALIBRATION 2 known-answer strings — read from the SHIPPED doctor handler so
// they are REAL, not guessed. Source: dist/claude/.claude/tools/
// aidlc-utility.ts handleDoctor():
//   - header literal:           "AI-DLC doctor\n"                  (doctor renderer)
//   - separator rule:           "─".repeat(37)                (utility.ts:1356)
//   - runtime label prefix:     "Runtime hook PATH: bun"            (shared diagnostics)
//   - hook label shape:         "<hook>.ts present"                (utility.ts:356, hooks :343-351)
//   - settings label:           "settings.json present"           (utility.ts:365)
//   - workspace label:          "workspace shell ready"            (shared doctor)
// The spike's aidlc-sdk-toolout-probe.ts proved these exact strings appear in
// the tool_result (and unreliably in prose) — we re-prove it through the driver.
// ---------------------------------------------------------------------------
const DOCTOR_HEADER = "AI-DLC doctor";
const DOCTOR_RUNTIME_LABEL = "Runtime hook PATH: bun";
const DOCTOR_HOOK_LABEL = "aidlc-write-audit-log.ts present";
const DOCTOR_SETTINGS_LABEL = "settings.json present";
const DOCTOR_DOCS_LABEL = "workspace shell ready";
const COMPOSE_TASK = "build a distributed cache layer with consistency guarantees";

function expectedComposeDecision(project: string): Record<string, unknown> {
  const run = spawnSync(process.execPath, [
    ".claude/tools/aidlc.ts", "engine", "orchestrate", "next", COMPOSE_TASK,
  ], {
    cwd: project, env: { ...process.env, AIDLC_PROJECT_DIR: project },
    encoding: "utf8", timeout: 30_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  const decision = JSON.parse(run.stdout) as Record<string, unknown>;
  expect(decision.kind).toBe("ask");
  expect(typeof decision.question).toBe("string");
  return decision;
}

function isOrchestrateNext(command: unknown, project: string): command is string {
  if (typeof command !== "string") return false;
  const parsed = parseLiteralShellInvocation(command);
  if (!parsed) return false;
  if (parsed.directory !== null) {
    if (relative(project, parsed.directory) !== "") return false;
    try {
      const expected = statSync(project, { bigint: true });
      const actual = statSync(parsed.directory, { bigint: true });
      if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) return false;
    } catch {
      return false;
    }
  }
  const argv = [...parsed.argv];
  if (/^bun(?:\.exe)?$/.test(argv[0] ?? "")) {
    const tool = argv[1]?.replaceAll("\\", "/").replace(/^\.\//, "");
    if (tool === ".claude/tools/aidlc.ts") argv.splice(0, 2, "aidlc");
    else if (tool === ".claude/tools/aidlc-orchestrate.ts") argv.splice(0, 2, "aidlc", "engine", "orchestrate");
  }
  if (argv[0] === "aidlc.exe") argv[0] = "aidlc";
  return JSON.stringify(argv) === JSON.stringify(["aidlc", "engine", "orchestrate", "next", COMPOSE_TASK]);
}

function assertComposeOffer(result: DriveResult, expectedDecision: Record<string, unknown>, project = process.cwd()) {
  // The engine's typed reply identifies Branch 8 independently of how the
  // model phrases the question sentence. Accept only its real next command
  // for this task, then require the compose choice in the captured menu.
  const next = result.toolResults.find((tool) =>
    tool.toolName === "Bash" && isOrchestrateNext(tool.input.command, project)
  );
  expect(next).toBeDefined();
  expect(next!.isError).toBe(false);
  expect(JSON.parse(next!.resultText)).toEqual(expectedDecision);
  expect(result.timedOut).toBe(false);
  expect(result.stoppedAfterAskUserQuestion).toBe(true);
  const menu = result.askedQuestions[0];
  expect(menu).toBeDefined();
  expect(menu.questions).toHaveLength(1);
  const question = menu.questions[0];
  expect(question.options.length).toBeGreaterThan(1);
  expect(question.options.filter((option) => /^compose\b/i.test(option.label))).toHaveLength(1);
  expect(question.multiSelect ?? false).toBe(false);
  expect(typeof menu.answers[question.question]).toBe("string");
  expect(question.options.map((option) => option.label)).toContain(menu.answers[question.question] as string);
  return menu;
}

function expectedDoctorRuntimeLine(project: string): string {
  // The same machine can legitimately report ok, warn or fail for Bun.
  // Obtain its exact row independently of the model and SDK transport.
  const run = spawnSync(process.execPath, [
    ".claude/tools/aidlc.ts", "doctor", "--verbose",
  ], {
    cwd: project, env: { ...process.env, AIDLC_PROJECT_DIR: project },
    encoding: "utf8", timeout: 30_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const rows = run.stdout.split(/\r?\n/).filter((line) =>
    /^\s+(?:ok|warn|fail)\s+Runtime hook PATH: bun(?:\s|$)/.test(line)
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

function recordCalibration(name: string, result: DriveResult, expectedDecision: Record<string, unknown>): void {
  const logs = process.env.AIDLC_TEST_LOG_DIR;
  if (logs) writeFileSync(join(logs, `sdk-calibration-${name}-${process.pid}.json`), JSON.stringify({
    expectedDecision, askedQuestions: result.askedQuestions,
    toolResults: result.toolResults, timedOut: result.timedOut,
    stoppedAfterAskUserQuestion: result.stoppedAfterAskUserQuestion,
  }, null, 2));
}

// ---------------------------------------------------------------------------

describe("sdk-drive calibration (known-answer)", () => {
  // -------------------------------------------------------------------------
  // CALIBRATION 1 — canUseTool fires for AskUserQuestion.
  //   harness-instrument:sdk-drive-canusetool
  //
  // Planted truth: rich freeform prose in a fresh workspace MUST reach Branch
  // 8's compose offer (an AskUserQuestion), and the driver's canUseTool MUST
  // answer it (capturing it in askedQuestions) — NOT let it be auto-denied the
  // way headless `claude -p` does. This is a boundary smoke, not a workflow
  // drive: stopAfterAskUserQuestion returns immediately after the first gate is
  // captured/answered so a fixture mismatch cannot turn the calibration into a
  // long live composer run.
  // -------------------------------------------------------------------------
  test(
    "1. canUseTool answers the AskUserQuestion gate (not auto-denied)",
    async () => {
      const proj = setupIntegrationProject();
      try {
        const expectedDecision = expectedComposeDecision(proj);
        const r = await driveAidlc(
          `/aidlc "${COMPOSE_TASK}"`,
          {
            projectDir: proj,
            timeoutMs: DRIVE_TIMEOUT_MS,
            stopAfterAskUserQuestion: true,
          },
        );
        recordCalibration("default-answer", r, expectedDecision);

        // The compose offer must have been captured. If canUseTool never fired
        // (or the gate was denied), askedQuestions would be empty here.
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);

        // Prove WHICH decision and menu fired, without requiring a particular
        // word in the model's question sentence or accepting an unrelated ask.
        const composeMenu = assertComposeOffer(r, expectedDecision, proj);

        // The driver records the answer it handed back to the SDK. For a
        // captured-and-answered gate this is a real option label, not empty —
        // that is the positive proof the question was ANSWERED, not denied.
        const handedBack = Object.values(composeMenu.answers);
        expect(handedBack.length).toBeGreaterThanOrEqual(1);
        for (const a of handedBack) {
          const asStr = Array.isArray(a) ? a.join("") : a;
          expect(asStr.length).toBeGreaterThan(0);
        }
        const askToolResult = r.toolResults.find(
          (t) => t.toolName === "AskUserQuestion",
        );
        expect(askToolResult).toBeDefined();
        // This is the headless `-p` auto-deny contrast: an answered gate
        // returns a non-error tool_result from AskUserQuestion.
        expect(askToolResult?.isError).toBe(false);
        expect(askToolResult!.input.questions).toEqual(composeMenu.questions);

        // The default option must be one the menu actually offered
        // (structure-resolved, never invented). Calibration 1 only proves the
        // canUseTool boundary; selection is checked against the labels actually
        // offered rather than a hard-coded full label.
        const offered = composeMenu.questions[0].options.map((o) => o.label);
        const chosen = Object.values(composeMenu.answers)[0] as string;
        expect(offered).toContain(chosen);
        expect(askToolResult!.resultText).toContain(chosen);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // CALIBRATION 2 — tool_result is BYTE-IDENTICAL to the tool's stdout.
  //   harness-instrument:sdk-drive-toolresult-byte-identity
  //
  // Planted truth: /aidlc --doctor runs a deterministic bun tool whose stdout
  // is fixed bytes (the spike saw md5 553308ac... x3). The driver MUST surface
  // those exact bytes in toolResults — the tool's stdout, NOT the assistant's
  // prose rendering. We assert the literal strings (read from the shipped
  // doctor handler) AND verify the doctor block repeats byte-for-byte across
  // two runs (stability), the property that makes this assertable at all.
  // -------------------------------------------------------------------------
  test(
    "2. doctor tool_result carries the verbatim deterministic stdout (byte-identical, stable x2)",
    async () => {
      // Doctor is a read-only utility calibration. Keep the project minimal:
      // seeding an in-progress workflow invites the model to report completion
      // after printing doctor output, which correctly rejects because no gate is
      // awaiting approval. The planted truth here is the tool_result bytes.
      const projA = setupIntegrationProject();
      const projB = setupIntegrationProject();
      try {
        const runtimeLine = expectedDoctorRuntimeLine(projA);
        const rA = await driveAidlc("/aidlc --doctor --verbose", {
          projectDir: projA,
          timeoutMs: DRIVE_TIMEOUT_MS,
        });

        // The Bash tool must have actually been called AND its result must
        // contain the exact doctor strings. assertToolResultContains fails
        // loudly if Bash never fired (no vacuous pass) — see calibration 4.
        assertToolResultContains(rA, "Bash", DOCTOR_HEADER);
        assertToolResultContains(rA, "Bash", DOCTOR_RUNTIME_LABEL);
        assertToolResultContains(rA, "Bash", DOCTOR_HOOK_LABEL);
        assertToolResultContains(rA, "Bash", DOCTOR_SETTINGS_LABEL);
        assertToolResultContains(rA, "Bash", DOCTOR_DOCS_LABEL);

        // Prove the content is the TOOL's bytes, not the assistant's prose
        // rendering: isolate the verbatim doctor block out of the Bash
        // tool_result and re-assert the structural shape on THOSE bytes.
        const blockA = extractDoctorBlock(rA);
        expect(blockA).not.toBeNull();
        // The block carries the grouped sections and closing problem/warning
        // footer verbatim, a shape the LLM prose does not reliably reproduce.
        expect(blockA!).toContain("Machine");
        expect(blockA!).toContain("Project");
        expect(blockA!).toContain("Framework integrity");
        expect(blockA!).toMatch(/\d+ problems?, \d+ warnings?\./);
        expect(blockA!.split(/\r?\n/)).toContain(runtimeLine);

        // Stability: a second independent run must yield a byte-identical
        // doctor block (deterministic stdout). We compare from the header to
        // the footer so an LLM preamble/postamble around the tool_result does
        // not perturb the comparison; the tool bytes themselves must match.
        //
        // ONE line in the doctor stdout is intrinsically non-deterministic:
        // "Hooks last fired: session-start <ISO timestamp>" (utility.ts:430) —
        // the SessionStart hook re-stamps wall-clock time on every run, so the
        // timestamp legitimately differs run-to-run. That is a property of the
        // TOOL, not a defect of the instrument. We normalise that single line
        // out before comparing; every other byte (header, rule, all fixed
        // labels, counts, footer) must be identical. The structural asserts
        // above already prove the instrument carries the tool's verbatim bytes;
        // this proves it does so STABLY for the deterministic portion.
        const rB = await driveAidlc("/aidlc --doctor --verbose", {
          projectDir: projB,
          timeoutMs: DRIVE_TIMEOUT_MS,
        });
        const blockB = extractDoctorBlock(rB);
        expect(blockB).not.toBeNull();
        expect(normalizeHeartbeat(blockB!)).toBe(normalizeHeartbeat(blockA!));
      } finally {
        cleanupTestProject(projA);
        cleanupTestProject(projB);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // CALIBRATION 3 — a SCRIPTED non-default answer reaches the model.
  //   harness-instrument:sdk-drive-scripted-answer
  //
  // Planted truth: rich freeform prose in a fresh workspace poses Branch 8's
  // compose offer. We script option index 1 (the second option) and stop
  // immediately after the AskUserQuestion tool_result arrives. That
  // tool_result is the synthetic user message handed back to the model, so its
  // bytes prove the scripted answer crossed the SDK boundary without letting
  // the calibration continue into a live composer run.
  //
  // The option labels are model-rendered. Index selection deliberately tests
  // the driver's structural non-default path without fixing the second label's
  // wording. The engine decision and compose choice identify the offer separately.
  // -------------------------------------------------------------------------
  test(
    "3. scripted non-default answer reaches the model via AskUserQuestion tool_result bytes",
    async () => {
      const proj = setupIntegrationProject();
      try {
        const expectedDecision = expectedComposeDecision(proj);
        const r = await driveAidlc(
          `/aidlc "${COMPOSE_TASK}"`,
          {
            projectDir: proj,
            timeoutMs: DRIVE_TIMEOUT_MS,
            stopAfterAskUserQuestion: true,
            answerScript: {
              kind: "sequence",
              specs: [{ optionIndex: 1 }],
            },
          },
        );
        recordCalibration("scripted-answer", r, expectedDecision);

        // The compose offer must have fired and been answered (canUseTool path).
        expect(r.askedQuestions.length).toBe(1);

        // The second offered option must be what was handed to the model,
        // proving the scripted answer reached it rather than silently falling
        // back to the default first option.
        const composeMenu = assertComposeOffer(r, expectedDecision, proj);
        const composeOffered = composeMenu.questions[0].options.map(
          (o) => o.label,
        );
        expect(composeOffered.length).toBeGreaterThan(1);
        const secondOption = composeOffered[1];
        const composeHanded = Object.values(composeMenu.answers)[0] as string;
        expect(composeHanded).toBe(secondOption);
        // It is NOT the default first option — the non-default truly drove.
        expect(composeHanded).not.toBe(composeOffered[0]);
        assertToolResultContains(r, "AskUserQuestion", secondOption);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Product regression for #794. Unlike the three instrument calibrations
  // above, this pins the live harness behavior that motivated the change:
  // explicit --resume must reach continuation routing without opening the
  // session re-entry menu.
  test(
    "explicit --resume reaches load-steering without AskUserQuestion",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const r = await driveAidlc("/aidlc --resume", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: {
            toolName: "Bash",
            resultIncludes: '"kind":"load-steering"',
          },
        });
        expect(r.stoppedAfterToolResult).toBe(true);
        expect(r.askedQuestions).toHaveLength(0);
        assertToolResultContains(r, "Bash", '"kind":"load-steering"');
        assertToolResultContains(r, "Bash", '"stage":"feasibility"');
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // CALIBRATION 4 — the guard: assertToolResultContains must FAIL when the
  // expected tool was never called. Proves the helper does not pass vacuously
  // against an empty/absent tool call — the failure mode that would let a
  // deleted behaviour slip through every test above it.
  //
  // This calibration spends NO tokens: it constructs a DriveResult with no
  // Bash call and asserts the helper throws. The expensive calibrations (1-3)
  // already proved the real-drive path; this isolates the guard logic.
  // -------------------------------------------------------------------------
  test("4. assertToolResultContains FAILS loudly when the tool was absent (no vacuous pass)", () => {
    // A run that called Skill but never Bash.
    const noBash: DriveResult = {
      toolResults: [
        {
          toolName: "Skill",
          input: {},
          toolUseId: "tu_1",
          resultText: "Launching skill: aidlc",
          isError: false,
        } satisfies CapturedToolResult,
      ],
      assistantText: "",
      resultEvent: undefined,
      askedQuestions: [],
      timedOut: false,
      stoppedAfterAskUserQuestion: false,
      stoppedAfterToolResult: false,
    };

    // Asserting on a tool that never fired MUST throw — not silently pass.
    expect(() =>
      assertToolResultContains(noBash, "Bash", DOCTOR_HEADER),
    ).toThrow(/expected tool "Bash" to be called/);

    // The fully-empty case must also throw (zero tool calls at all).
    const empty: DriveResult = {
      toolResults: [],
      assistantText: "",
      resultEvent: undefined,
      askedQuestions: [],
      timedOut: false,
      stoppedAfterAskUserQuestion: false,
      stoppedAfterToolResult: false,
    };
    expect(() =>
      assertToolResultContains(empty, "Bash", DOCTOR_HEADER),
    ).toThrow(/Refusing to pass vacuously/);

    // Positive control: when the tool DID fire with matching content, the
    // helper must NOT throw — proving the failure above is about absence, not a
    // helper that always throws.
    const withBash: DriveResult = {
      toolResults: [
        {
          toolName: "Bash",
          input: { command: "doctor" },
          toolUseId: "tu_2",
          resultText: `${DOCTOR_HEADER}\n\n0 problems, 0 warnings.\n`,
          isError: false,
        } satisfies CapturedToolResult,
      ],
      assistantText: "",
      resultEvent: undefined,
      askedQuestions: [],
      timedOut: false,
      stoppedAfterAskUserQuestion: false,
      stoppedAfterToolResult: false,
    };
    expect(() =>
      assertToolResultContains(withBash, "Bash", DOCTOR_HEADER),
    ).not.toThrow();

    // The compose calibration must not accept a lookalike JSON reply from an
    // unrelated command, or a generic question merely mentioning "compose".
    const question = {
      question: "How should this work be sized?",
      options: [{ label: "Compose a plan" }, { label: "Feature" }],
      multiSelect: false,
    };
    const decision = { kind: "ask", question: `Choose a plan for ${COMPOSE_TASK}` };
    const answeredCompose: DriveResult = {
      ...empty,
      stoppedAfterAskUserQuestion: true,
      askedQuestions: [{
        questions: [question],
        answers: { [question.question]: "Compose a plan" },
      }],
      toolResults: [{
        toolName: "Bash",
        input: { command: `bun .claude/tools/aidlc.ts engine orchestrate next "${COMPOSE_TASK}"` },
        toolUseId: "next", resultText: JSON.stringify(decision), isError: false,
      }, {
        toolName: "AskUserQuestion", input: { questions: [question] },
        toolUseId: "ask", resultText: "Compose a plan", isError: false,
      }],
    };
    expect(() => assertComposeOffer(answeredCompose, decision)).not.toThrow();
    const selectedDirectory = structuredClone(answeredCompose);
    selectedDirectory.toolResults[0].input.command =
      `cd ${JSON.stringify(process.cwd())} && ${answeredCompose.toolResults[0].input.command}`;
    expect(() => assertComposeOffer(selectedDirectory, decision)).not.toThrow();
    const otherDirectory = structuredClone(answeredCompose);
    otherDirectory.toolResults[0].input.command =
      `cd ${JSON.stringify(dirname(process.cwd()))} && ${answeredCompose.toolResults[0].input.command}`;
    expect(() => assertComposeOffer(otherDirectory, decision)).toThrow();
    const continuedWorkflow = structuredClone(answeredCompose);
    continuedWorkflow.toolResults[0].input.command += " && aidlc engine state advance";
    expect(() => assertComposeOffer(continuedWorkflow, decision)).toThrow();
    const wrongCommand = structuredClone(answeredCompose);
    wrongCommand.toolResults[0].input.command = "printf supplied-ask-json";
    expect(() => assertComposeOffer(wrongCommand, decision)).toThrow();
    const unrelatedQuestion = structuredClone(answeredCompose);
    unrelatedQuestion.askedQuestions[0].questions[0] = {
      question: "Does this unrelated question mention compose?",
      options: [{ label: "Yes" }, { label: "No" }],
      multiSelect: false,
    };
    unrelatedQuestion.askedQuestions[0].answers = {
      "Does this unrelated question mention compose?": "Yes",
    };
    expect(() => assertComposeOffer(unrelatedQuestion, decision)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helper: isolate the verbatim doctor stdout block out of the Bash
// tool_result(s). Slices from the "AI-DLC doctor" header through the
// "N problems, M warnings." footer so an LLM preamble/postamble around the
// tool_result cannot perturb the byte-stability comparison. Returns null if no
// Bash tool_result carries the header.
// ---------------------------------------------------------------------------
function extractDoctorBlock(result: DriveResult): string | null {
  for (const t of result.toolResults) {
    if (t.toolName !== "Bash") continue;
    const start = t.resultText.indexOf(DOCTOR_HEADER);
    if (start === -1) continue;
    const footer = t.resultText.match(/\d+ problems?, \d+ warnings?\./);
    if (!footer || footer.index === undefined) continue;
    const end = footer.index + footer[0].length;
    return t.resultText.slice(start, end);
  }
  return null;
}

// Replace scratch-root and heartbeat timestamp variance so byte-stability can
// be asserted on the deterministic report content.
function normalizeHeartbeat(block: string): string {
  return block
    .replaceAll(/\/tmp\/aidlc-test-[^/]+/g, "<PROJECT>")
    .replace(
      /(Hooks last fired:.*)$/m,
      (line) => line.replaceAll(/\d{4}-\d{2}-\d{2}T[\d:]+Z/g, "<TS>"),
    );
}
