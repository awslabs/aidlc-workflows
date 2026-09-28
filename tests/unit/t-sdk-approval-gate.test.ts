// covers: harness-instrument:sdk-approval-gate
//
// Deterministic calibration of the real SDK driver and fixture evidence reader.
// The suite runner starts each file in a separate Bun process; this transport
// mock belongs only to this file. No Claude process or model request is made.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, mock, test, setDefaultTimeout } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  CapturedAskUserQuestion,
  DriveOptions,
} from "../harness/sdk-drive.ts";
import {
  cleanupTestProject,
  createTestProject,
  seedStateFile,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { readAuditShardEvents, runtimeGraphPath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

type QueryInput = Parameters<typeof sdkQuery>[0];
let scenario: (input: QueryInput) => AsyncGenerator<SDKMessage> = (): AsyncGenerator<SDKMessage> => {
  throw new Error("Unexpected SDK query in deterministic calibration");
};
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (input: QueryInput) => scenario(input),
}));
const {
  driveAidlc,
  prepareSdkStageFixture,
  stageApprovalQuestionBoundary,
} = await import("../harness/sdk-drive.ts");

const STAGE = "reverse-engineering";
const TS = "2026-01-01T00:00:00Z";
const projects: string[] = [];
const menu = (header: string, labels: string[], question = header): CapturedAskUserQuestion => ({
  questions: [{ header, question, options: labels.map((label) => ({ label })) }],
  answers: {},
});
const approval = () => menu("Approval", ["Approve", "Request Changes"], "Review the reverse-engineering artifacts.");
const learnings = () => menu("Learnings", ["Add a note", "Nothing to add"], "Anything to add for next time?");
const blocked = () => menu("Blocked step", ["Investigate the record", "Skip learnings, hold gate"]);

function event(project: string, name: string, fields: Record<string, string> = {}, otherShard = false) {
  const path = otherShard
    ? join(seededRecordDir(project), "audit", "other.md")
    : seededAuditShard(project);
  mkdirSync(join(seededRecordDir(project), "audit"), { recursive: true });
  appendFileSync(path, `\n---\n\n## ${name}\n**Timestamp**: ${TS}\n**Event**: ${name}\n` +
    Object.entries(fields).map(([key, value]) => `**${key}**: ${value}\n`).join(""));
}

function positionedProject(): string {
  const project = createTestProject();
  projects.push(project);
  seedStateFile(project, "state-brownfield-init-done.md");
  event(project, "WORKFLOW_STARTED", { Scope: "bugfix" });
  event(project, "STAGE_STARTED", { Stage: STAGE });
  return project;
}

function holdGate(project: string, fields: Record<string, string> = {}, otherShard = false) {
  const state = seededStateFile(project);
  writeFileSync(state, readFileSync(state, "utf8").replace(`- [-] ${STAGE}`, `- [?] ${STAGE}`));
  event(project, "STAGE_AWAITING_APPROVAL", { Stage: STAGE, ...fields }, otherShard);
}

const message = (value: Record<string, unknown>) => value as unknown as SDKMessage;
const use = (id: string, captured: CapturedAskUserQuestion) => message({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: captured.questions } }] },
});
const result = (id: string, error = false) => message({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: `delivered:${id}`, is_error: error }] },
});
const success = () => message({ type: "result", subtype: "success", is_error: false, num_turns: 1 });

async function answer(input: QueryInput, id: string, captured: CapturedAskUserQuestion) {
  if (!input.options?.canUseTool || !input.options.abortController) {
    throw new Error("Driver did not provide its permission callback and abort controller");
  }
  return input.options.canUseTool("AskUserQuestion", { questions: captured.questions }, {
    toolUseID: id, signal: input.options.abortController.signal,
  });
}

afterEach(() => {
  scenario = (): AsyncGenerator<SDKMessage> => { throw new Error("Unexpected SDK query"); };
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

describe("SDK stage fixture history", () => {
  test("seeds initialization and current attempt, compiles runtime, and is idempotent", async () => {
    const project = setupIntegrationProject({
      withState: "state-brownfield-init-done.md", withAudit: true, withBrownfieldStub: true,
    });
    projects.push(project);
    const stateBefore = readFileSync(seededStateFile(project), "utf8");
    await prepareSdkStageFixture(project, STAGE);
    const rows = readAuditShardEvents(project);
    expect(rows.filter((row) => row.event === "WORKFLOW_STARTED")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "STAGE_STARTED")).toHaveLength(4);
    expect(rows.filter((row) => row.event === "STAGE_COMPLETED")).toHaveLength(3);
    const graph = JSON.parse(readFileSync(runtimeGraphPath(project), "utf8"));
    expect(graph.scope).toBe("bugfix");
    expect(graph.workflow_id).not.toBe("");
    expect(graph.stages.find((row: { stage_slug: string }) => row.stage_slug === STAGE))
      .toMatchObject({ outcome: "pending", completed_at: null });
    expect(graph.stages.filter((row: { outcome: string }) => row.outcome === "approved")).toHaveLength(3);
    expect(readFileSync(seededStateFile(project), "utf8")).toBe(stateBefore);
    await prepareSdkStageFixture(project, STAGE);
    expect(readAuditShardEvents(project)).toEqual(rows);
    expect((await stageApprovalQuestionBoundary(project, STAGE)).identity.stage).toBe(STAGE);
  });

  test("cannot capture an approval boundary from a missing workflow header", async () => {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, "state-brownfield-init-done.md");
    event(project, "STAGE_STARTED", { Stage: STAGE });
    await expect(stageApprovalQuestionBoundary(project, STAGE)).rejects.toThrow("coherent workflow/stage attempt");
  });
});

describe("stage/attempt-bound approval identity", () => {
  test("accepts append-ordered approval at the current attempt, not a blocker or learnings menu", async () => {
    const project = positionedProject();
    const gate = await stageApprovalQuestionBoundary(project, STAGE);
    expect(gate.matches(approval())).toBe(false);
    holdGate(project);
    expect(gate.matches(blocked())).toBe(false);
    expect(gate.matches(learnings())).toBe(false);
    expect(gate.matches(approval())).toBe(true);
  });

  test.each([
    { Stage: "requirements-analysis" },
    { Workflow: `single-stage:${STAGE}` },
    { Unit: "unrelated-unit" },
    { Recovered: "true" },
  ] as Array<Record<string, string>>)("rejects an unrelated or recovered approval row: %j", async (fields) => {
    const project = positionedProject();
    const gate = await stageApprovalQuestionBoundary(project, STAGE);
    holdGate(project, fields);
    expect(gate.matches(approval())).toBe(false);
  });

  test("state marker alone and audit row alone cannot establish a held gate", async () => {
    const project = positionedProject();
    const gate = await stageApprovalQuestionBoundary(project, STAGE);
    const path = seededStateFile(project);
    const running = readFileSync(path, "utf8");
    writeFileSync(path, running.replace(`- [-] ${STAGE}`, `- [?] ${STAGE}`));
    expect(gate.matches(approval())).toBe(false);
    writeFileSync(path, running);
    event(project, "STAGE_AWAITING_APPROVAL", { Stage: STAGE });
    expect(gate.matches(approval())).toBe(false);
  });

  test.each(["STAGE_STARTED", "GATE_REJECTED", "STAGE_JUMPED", "WORKFLOW_STARTED"])(
    "a later %s invalidates the captured attempt even in the same timestamp second",
    async (boundary) => {
      const project = positionedProject();
      const gate = await stageApprovalQuestionBoundary(project, STAGE);
      holdGate(project);
      expect(gate.matches(approval())).toBe(true);
      event(project, boundary, { Stage: STAGE });
      expect(gate.matches(approval())).toBe(false);
    },
  );

  test("cannot order a same-second approval from another shard after the attempt", async () => {
    const project = positionedProject();
    const gate = await stageApprovalQuestionBoundary(project, STAGE);
    holdGate(project, {}, true);
    expect(gate.matches(approval())).toBe(false);
  });

  test("a resolved gate cannot satisfy a later menu while a stale checkbox remains", async () => {
    const project = positionedProject();
    const gate = await stageApprovalQuestionBoundary(project, STAGE);
    holdGate(project);
    event(project, "GATE_APPROVED", { Stage: STAGE });
    expect(gate.matches(approval())).toBe(false);
  });
});

describe("SDK question transport boundary", () => {
  test.each(["permission-first", "message-first"] as const)(
    "%s: answers learnings and waits for the selected question's own result",
    async (ordering) => {
      const project = positionedProject();
      const gate = await stageApprovalQuestionBoundary(project, STAGE);
      let selectedAnswer: unknown;
      let learnedAnswer: unknown;
      let observedAbort = false;
      scenario = async function* (input) {
        yield use("learnings", learnings());
        learnedAnswer = await answer(input, "learnings", learnings());
        yield result("learnings");
        expect(input.options!.abortController!.signal.aborted).toBe(false);
        holdGate(project);
        if (ordering === "message-first") yield use("approval", approval());
        selectedAnswer = await answer(input, "approval", approval());
        expect(input.options!.abortController!.signal.aborted).toBe(false);
        if (ordering === "permission-first") yield use("approval", approval());
        // A different menu/result cannot trigger the selected boundary.
        yield use("other", blocked());
        await answer(input, "other", blocked());
        yield result("other");
        expect(input.options!.abortController!.signal.aborted).toBe(false);
        yield result("approval");
        observedAbort = input.options!.abortController!.signal.aborted;
        throw new Error("SDK abort after answer delivery");
      };
      const driven = await driveAidlc("deterministic fixture", {
        projectDir: project,
        answerScript: {
          kind: "byHeader",
          map: { "Anything to add for next time?": { label: "Nothing to add" }, Approval: { label: "Approve" } },
        },
        stopAfterAskUserQuestionWhen: gate.matches,
      });
      expect(learnedAnswer).toMatchObject({
        behavior: "allow", updatedInput: { answers: { "Anything to add for next time?": "Nothing to add" } },
      });
      expect(selectedAnswer).toMatchObject({
        behavior: "allow", updatedInput: { answers: { "Review the reverse-engineering artifacts.": "Approve" } },
      });
      expect(observedAbort).toBe(true);
      expect(driven.timedOut).toBe(false);
      expect(driven.stoppedAfterAskUserQuestion).toBe(true);
      expect(driven.toolResults.at(-1)).toMatchObject({
        toolUseId: "approval", resultText: "delivered:approval", isError: false,
      });
    },
  );

  test("the historical blockage question cannot false-pass the live test's stop check", async () => {
    const project = positionedProject();
    const gate = await stageApprovalQuestionBoundary(project, STAGE);
    scenario = async function* (input) {
      yield use("blocked", blocked());
      await answer(input, "blocked", blocked());
      yield result("blocked");
      yield success();
    };
    const driven = await driveAidlc("fixture", { projectDir: project, stopAfterAskUserQuestionWhen: gate.matches });
    expect(driven.askedQuestions).toHaveLength(1);
    expect(driven.stoppedAfterAskUserQuestion).toBe(false);
  });

  test("a failed selected tool result is not a successful approval boundary", async () => {
    const project = positionedProject();
    const gate = await stageApprovalQuestionBoundary(project, STAGE);
    holdGate(project);
    scenario = async function* (input) {
      yield use("approval", approval());
      await answer(input, "approval", approval());
      yield result("approval", true);
      expect(input.options!.abortController!.signal.aborted).toBe(false);
      yield success();
    };
    const driven = await driveAidlc("fixture", { projectDir: project, stopAfterAskUserQuestionWhen: gate.matches });
    expect(driven.stoppedAfterAskUserQuestion).toBe(false);
    expect(driven.toolResults[0].isError).toBe(true);
  });

  test.each([
    { options: { stopAfterAskUserQuestion: true }, last: "first" },
    { options: { stopAfterAskUserQuestionAt: 2 }, last: "second" },
  ])("preserves the existing first/Nth-question boundary: %j", async ({ options, last }) => {
    const project = positionedProject();
    scenario = async function* (input) {
      for (const [id, captured] of [["first", learnings()], ["second", approval()]] as const) {
        yield use(id, captured);
        await answer(input, id, captured);
        expect(input.options!.abortController!.signal.aborted).toBe(false);
        yield result(id);
        if (input.options!.abortController!.signal.aborted) {
          throw new Error("SDK intentional boundary");
        }
      }
      yield success();
    };
    const driven = await driveAidlc("fixture", { projectDir: project, ...options });
    expect(driven.stoppedAfterAskUserQuestion).toBe(true);
    expect(driven.toolResults.at(-1)?.toolUseId).toBe(last);
  });

  test.each([
    { stopAfterAskUserQuestion: true },
    { stopAfterAskUserQuestionAt: 2 },
  ] satisfies DriveOptions[])("rejects mixed predicate/ordinal stop configuration: %j", async (legacy) => {
    await expect(driveAidlc("fixture", {
      ...legacy, stopAfterAskUserQuestionWhen: () => true,
    })).rejects.toThrow("either a question predicate");
  });
});
