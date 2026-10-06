// covers: function:resolveStageAnswerMode, function:latestRecordedAnswerMode,
// function:answerModeFromReply, function:answerModeStageStartedFields,
// function:hasPendingDecision, subcommand:aidlc-utility:intent-create,
// subcommand:aidlc-state:advance, subcommand:aidlc-orchestrate:next,
// subcommand:aidlc-log:decision, subcommand:aidlc-log:answer, audit:STAGE_STARTED
//
// The interaction-mode question ("How would you like to answer them?") is asked
// once per piece of work, at the first stage with questions, and reused by the
// later stages (stage-protocol.md section 3, Step 2). Each reusing stage says in
// one line which way it is answering; its STAGE_STARTED row records the reused
// mode; and a reused mode opens no pending decision, so the Stop hook's
// pending-decision carve-out and the gate-answer pairing read exactly what they
// read before.
//
// The agent reads what the person meant and records the option label; the
// engine reads only that label or its number, never the person's own words. The
// person changes the mode by saying so, and the new choice is recorded the same
// way. There is no flag, setting or switch for it.
//
// Mechanism: in-process for the pure reading, cli for the lifecycle: the REAL
// shipped tools under dist/claude create the intent, log the question and
// answer, advance the stage, and emit the directive.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerModeFromReply,
  answerModeStageStartedFields,
  resolveStageAnswerMode,
} from "../../core/tools/aidlc-lib.ts";
import {
  auditBlockField,
  getField,
  hasPendingDecision,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  runOrchestrateNext,
  seedAidlcMemory,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const MODE_QUESTION = "How would you like to answer the questions?";
const MODE_OPTIONS = "Guide me,I'll edit the file,Chat";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
}

function run(tool: string, args: string[], proj: string) {
  const result = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [process.execPath, tool, ...args, "--project-dir", proj],
    cwd: proj,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function project() {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  const created = run(UTILITY, [
    "intent-create", "--scope", "classic", "--arguments", "answer mode fixture", "--label", "answer-mode",
  ], proj);
  expect(created.status, created.stderr).toBe(0);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  return { proj, state: join(intents, active, "aidlc-state.md") };
}

function currentStage(state: string): string {
  return getField(readFileSync(state, "utf-8"), "Current Stage")!.trim();
}

type AnswerMode = { mode: string | null; ask: boolean; reused_from: string | null; notice: string };

function runStageAnswerMode(proj: string): AnswerMode {
  const next = runOrchestrateNext(ORCHESTRATE, proj, [], { cwd: proj, env: cliEnv() });
  expect(next.status, next.out).toBe(0);
  expect(next.directive?.kind, next.out).toBe("run-stage");
  return next.directive!.answer_mode as AnswerMode;
}

function askModeQuestion(proj: string, stage: string, reply: string, extra: string[] = []): void {
  const asked = run(LOG, ["decision", "--stage", stage, "--decision", MODE_QUESTION, "--options", MODE_OPTIONS, ...extra], proj);
  expect(asked.status, asked.stderr).toBe(0);
  const answered = run(LOG, ["answer", "--stage", stage, "--details", reply, ...extra], proj);
  expect(answered.status, answered.stderr).toBe(0);
}

function advance(proj: string, state: string): string {
  const from = currentStage(state);
  const moved = run(STATE, ["advance", from], proj);
  expect(moved.status, moved.stdout + moved.stderr).toBe(0);
  const to = currentStage(state);
  expect(to).not.toBe(from);
  return to;
}

function stageStartedAnswerMode(proj: string, stage: string): string | null {
  const rows = readAuditShardEvents(proj).filter((row) =>
    row.event === "STAGE_STARTED" && auditBlockField(row.block, "Stage") === stage);
  return rows.length === 0 ? null : auditBlockField(rows[rows.length - 1].block, "Answer Mode");
}

function modeQuestionCount(proj: string): number {
  return readAuditShardEvents(proj).filter((row) =>
    row.event === "DECISION_RECORDED" &&
    (auditBlockField(row.block, "Decision") ?? "").startsWith("How would you like to answer")).length;
}

describe("answer mode reading", () => {
  test("only the recorded option label or its number names a mode", () => {
    for (const [reply, mode] of [
      ["Guide me", "guide"], ["guide me", "guide"], ["1. Guide me", "guide"], ["1", "guide"],
      ["I'll edit the file", "file"], ["I\u2019ll edit the file", "file"], ["2", "file"], ["2. I'll edit the file", "file"],
      ["Chat", "chat"], ["3", "chat"], ["\"Chat\"", "chat"], ["3) Chat", "chat"],
      // The person's own words are the agent's to read; the engine never guesses from them.
      ["guide me please", null], ["walk me through them", null], ["let me edit it", null],
      ["1. Chat", null], ["Other", null], ["4", null], ["Q1: A, Q2: C", null], ["", null],
    ] as const) {
      expect(answerModeFromReply(reply), reply).toBe(mode);
    }
  });

  test("with no recorded choice the stage asks, and says the choice carries forward", () => {
    const fresh = resolveStageAnswerMode(null);
    expect(fresh).toEqual({
      mode: null,
      ask: true,
      reused_from: null,
      notice: "Later stages will use this way too. Say any time if you'd rather switch.",
    });
    expect(answerModeStageStartedFields(null)).toEqual({});
  });
});

describe("answer mode across a piece of work", () => {
  test("the first stage asks, the second stage reuses the answer without a pending decision", () => {
    const { proj, state } = project();
    const first = currentStage(state);
    expect(stageStartedAnswerMode(proj, first)).toBeNull();
    expect(runStageAnswerMode(proj)).toMatchObject({ mode: null, ask: true, reused_from: null });

    askModeQuestion(proj, first, "I'll edit the file");
    expect(hasPendingDecision(proj, first, "STAGE_STARTED")).toBe(false);

    const second = advance(proj, state);
    expect(stageStartedAnswerMode(proj, second)).toBe(`file (reused from ${first})`);
    const reused = runStageAnswerMode(proj);
    expect(reused).toEqual({
      mode: "file",
      ask: false,
      reused_from: first,
      notice: "Answering the way you chose earlier: I'll edit the file. Say if you'd rather be guided through them here or chat.",
    });
    // The person sees no stage name, flag or command in the line.
    expect(reused.notice).not.toContain(first);
    expect(reused.notice).not.toContain("/aidlc");
    // Reuse records the mode on the stage row, never as a question: nothing is
    // open for the Stop hook's pending-decision carve-out to find.
    expect(modeQuestionCount(proj)).toBe(1);
    expect(hasPendingDecision(proj, second, "STAGE_STARTED")).toBe(false);

    // A later stage's own content question still opens and closes as before.
    const content = run(LOG, ["decision", "--stage", second, "--decision", "Q1-Q3", "--options", "A,B,C"], proj);
    expect(content.status, content.stderr).toBe(0);
    expect(hasPendingDecision(proj, second, "STAGE_STARTED")).toBe(true);
    expect(run(LOG, ["answer", "--stage", second, "--details", "A, C, B"], proj).status).toBe(0);
    expect(hasPendingDecision(proj, second, "STAGE_STARTED")).toBe(false);
    // ...and a content answer never re-reads as a mode choice.
    expect(runStageAnswerMode(proj)).toMatchObject({ mode: "file", reused_from: first });
  });

  test("a new choice the person makes later is the one the following stages use", () => {
    const { proj, state } = project();
    const first = currentStage(state);
    askModeQuestion(proj, first, "Guide me");
    const second = advance(proj, state);
    expect(runStageAnswerMode(proj)).toMatchObject({ mode: "guide", reused_from: first });
    // "let me just chat about these": the agent records the label it understood.
    askModeQuestion(proj, second, "Chat");
    const reused = runStageAnswerMode(proj);
    expect(reused).toMatchObject({ mode: "chat", ask: false, reused_from: second });
    expect(reused.notice).toBe(
      "Answering the way you chose earlier: Chat. Say if you'd rather be guided through them here or edit the file.",
    );
  });

  test("an answer that names no mode is not reused; the next stage asks again", () => {
    const { proj, state } = project();
    const first = currentStage(state);
    askModeQuestion(proj, first, "Q1: A, Q2: B");
    advance(proj, state);
    expect(runStageAnswerMode(proj)).toMatchObject({ ask: true, mode: null });
  });

  test("an isolated --single answer never sets the main workflow's mode", () => {
    const { proj, state } = project();
    const first = currentStage(state);
    askModeQuestion(proj, first, "Chat", ["--single"]);
    expect(runStageAnswerMode(proj)).toMatchObject({ ask: true, mode: null });
  });
});
