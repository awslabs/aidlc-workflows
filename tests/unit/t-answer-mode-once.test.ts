// covers: function:resolveAnswerModeSetting, function:resolveStageAnswerMode,
// function:latestRecordedAnswerMode, function:answerModeFromReply,
// function:parseAnswerModeSetting, function:parseAnswerModeStateLine,
// function:formatStageAnswerMode, function:hasPendingDecision,
// subcommand:aidlc-utility:config-change, subcommand:aidlc-utility:config-get,
// subcommand:aidlc-utility:intent-create, subcommand:aidlc-state:advance,
// subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:decision,
// subcommand:aidlc-log:answer, audit:CEREMONY_SET, audit:STAGE_STARTED, tool:aidlc
//
// The interaction-mode question ("How would you like to answer them?") is asked
// once per piece of work, at the first stage with questions, and reused by the
// later stages (stage-protocol.md §3 Step 2). Each stage still says which mode
// it uses and how to change it; each STAGE_STARTED row records the mode in
// effect; and a reused mode opens no pending decision, so the Stop hook's
// pending-decision carve-out and the gate-answer pairing read exactly what they
// read before.
//
// Precedence: AIDLC_DISABLE_ANSWER_MODE_REUSE=1 (asks every stage) -> the
// intent's `Answer Mode` line (`/aidlc --answer-mode`) -> the scope's
// `answer_mode:` frontmatter -> `once`. Under `once`, the person's latest
// answer to the mode question in this intent's main workflow is reused.
//
// Mechanism: in-process for the pure resolution (scope fixtures through
// AIDLC_SCOPES_DIR, as t337 does), cli for the lifecycle: the REAL shipped
// tools under dist/claude create the intent, log the question and answer,
// advance the stage, change the setting, and emit the directive.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANSWER_MODE_ENV,
  answerModeFromReply,
  formatStageAnswerMode,
  parseAnswerModeSetting,
  parseAnswerModeStateLine,
  resolveAnswerModeSetting,
  resolveStageAnswerMode,
  loadScopeMetadataAll,
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
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const MODE_QUESTION = "How would you like to answer the questions?";
const MODE_OPTIONS = "Guide me,I'll edit the file,Chat";

const POLICY_ENV = {
  AIDLC_HARNESS_DIR: ".claude",
  AIDLC_SCOPE_MAPPING: undefined,
  AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
  AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
  AIDLC_SCOPES_DIR: join(import.meta.dir, "..", "..", "core", "scopes"),
  [ANSWER_MODE_ENV]: "0",
};

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [ANSWER_MODE_ENV]: "0",
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    ...extra,
  };
}

function run(tool: string, args: string[], proj: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [process.execPath, tool, ...args, "--project-dir", proj],
    cwd: proj,
    env: cliEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function project(extra: string[] = []) {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  const created = run(UTILITY, [
    "intent-create", "--scope", "classic", "--arguments", "answer mode fixture", "--label", "answer-mode", ...extra,
  ], proj);
  expect(created.status, created.stderr).toBe(0);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  return { proj, state: join(intents, active, "aidlc-state.md") };
}

function currentStage(state: string): string {
  return getField(readFileSync(state, "utf-8"), "Current Stage")!.trim();
}

type AnswerMode = { setting: string; source: string; mode: string | null; ask: boolean; reused_from: string | null; notice: string };

function runStageAnswerMode(proj: string, env: Record<string, string> = {}): AnswerMode {
  const next = runOrchestrateNext(ORCHESTRATE, proj, [], { cwd: proj, env: cliEnv(env) });
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

describe("answer mode resolution", () => {
  test("values, state lines, and replies parse to the documented words", () => {
    expect(parseAnswerModeSetting("Guide")).toBe("guide");
    expect(parseAnswerModeSetting("`ask`")).toBe("ask");
    expect(parseAnswerModeSetting("sometimes")).toBeNull();
    expect(parseAnswerModeStateLine("chat (set by you)")).toEqual({ value: "chat", source: "you" });
    expect(parseAnswerModeStateLine("file (from scope classic)")).toEqual({ value: "file", source: "scope classic" });
    expect(parseAnswerModeStateLine("loud")).toBeNull();
    for (const [reply, mode] of [
      ["Guide me", "guide"], ["1. Guide me", "guide"], ["1", "guide"], ["guide me please", "guide"],
      ["I'll edit the file", "file"], ["2", "file"], ["2. I'll edit the file", "file"],
      ["Chat", "chat"], ["3", "chat"], ["\"Chat\"", "chat"],
      ["Other", null], ["4", null], ["Q1: A, Q2: C", null], ["", null],
    ] as const) {
      expect(answerModeFromReply(reply), reply).toBe(mode);
    }
  });

  test("kill switch beats the intent line, which beats the scope default, which beats once", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    const scopes = join(proj, "scopes");
    mkdirSync(scopes);
    writeFileSync(join(scopes, "aidlc-quiet.md"), ["---", "name: quiet", "depth: Standard", "answer_mode: guide", "---", ""].join("\n"));
    writeFileSync(join(scopes, "aidlc-plain.md"), ["---", "name: plain", "depth: Standard", "---", ""].join("\n"));
    withEnvAndFreshCaches({ ...POLICY_ENV, AIDLC_SCOPES_DIR: scopes }, () => {
      expect(loadScopeMetadataAll().quiet.answerMode).toBe("guide");
      expect(resolveAnswerModeSetting("plain", "")).toMatchObject({ setting: "once", source: "default", scopeDefault: "once" });
      expect(resolveAnswerModeSetting("quiet", "")).toMatchObject({ setting: "guide", source: "scope quiet" });
      const intent = "- **Answer Mode**: chat (set by you)\n";
      expect(resolveAnswerModeSetting("quiet", intent)).toMatchObject({
        setting: "chat", source: "you", scopeDefault: "guide",
      });
      process.env[ANSWER_MODE_ENV] = "1";
      expect(resolveAnswerModeSetting("quiet", intent)).toMatchObject({
        setting: "ask", source: `env ${ANSWER_MODE_ENV}`, intent: { value: "chat", source: "you" },
      });
      process.env[ANSWER_MODE_ENV] = "0";
      // The scope default applies to a stage directly: no question, one line.
      const fromScope = resolveStageAnswerMode(null, "quiet", "");
      expect(fromScope).toMatchObject({ setting: "guide", mode: "guide", ask: false, reused_from: null });
      expect(fromScope.notice).toContain('"Guide me" mode (from scope quiet)');
      expect(fromScope.notice).toContain("/aidlc --answer-mode");
      expect(formatStageAnswerMode(fromScope)).toBe("guide (from scope quiet)");
      expect(formatStageAnswerMode(resolveStageAnswerMode(null, "plain", ""))).toBe(
        "ask (first stage with questions; the choice is then reused)",
      );
    });
  });

  test("an invalid scope answer_mode names the file and the accepted words", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    const scopes = join(proj, "scopes");
    mkdirSync(scopes);
    writeFileSync(join(scopes, "aidlc-bad.md"), ["---", "name: bad", "depth: Standard", "answer_mode: loud", "---", ""].join("\n"));
    withEnvAndFreshCaches({ ...POLICY_ENV, AIDLC_SCOPES_DIR: scopes }, () => {
      expect(() => loadScopeMetadataAll()).toThrow(/invalid answer_mode value "loud".*once, ask, guide, file, chat/);
    });
  });
});

describe("answer mode across a piece of work", () => {
  test("the first stage asks, the second stage reuses the answer without a pending decision", () => {
    const { proj, state } = project();
    const first = currentStage(state);
    expect(stageStartedAnswerMode(proj, first)).toBe("ask (first stage with questions; the choice is then reused)");
    const asking = runStageAnswerMode(proj);
    expect(asking).toMatchObject({ setting: "once", source: "default", mode: null, ask: true, reused_from: null });
    expect(asking.notice).toContain("reused for the later stages");

    askModeQuestion(proj, first, "I'll edit the file");
    expect(hasPendingDecision(proj, first, "STAGE_STARTED")).toBe(false);

    const second = advance(proj, state);
    expect(stageStartedAnswerMode(proj, second)).toBe(`file (reused from ${first})`);
    const reused = runStageAnswerMode(proj);
    expect(reused).toMatchObject({ setting: "once", mode: "file", ask: false, reused_from: first });
    expect(reused.notice).toBe(
      `Answering in "I'll edit the file" mode, your choice at ${first}. ` +
        "Change it with `/aidlc --answer-mode guide|file|chat`, or `/aidlc --answer-mode ask` to be asked at every stage.",
    );
    // Reuse records the mode on the stage row, never as a question: nothing is
    // open for the Stop hook's pending-decision carve-out to find.
    expect(modeQuestionCount(proj)).toBe(1);
    expect(hasPendingDecision(proj, second, "STAGE_STARTED")).toBe(false);
    const status = run(UTILITY, ["config-get", "answer-mode"], proj);
    expect(status.stdout).toBe(`once (from default), reusing file from ${first}\n`);

    // A later stage's own content question still opens and closes as before.
    const content = run(LOG, ["decision", "--stage", second, "--decision", "Q1-Q3", "--options", "A,B,C"], proj);
    expect(content.status, content.stderr).toBe(0);
    expect(hasPendingDecision(proj, second, "STAGE_STARTED")).toBe(true);
    expect(run(LOG, ["answer", "--stage", second, "--details", "A, C, B"], proj).status).toBe(0);
    expect(hasPendingDecision(proj, second, "STAGE_STARTED")).toBe(false);
    // ...and a content answer never re-reads as a mode choice.
    expect(runStageAnswerMode(proj)).toMatchObject({ mode: "file", reused_from: first });
  });

  test("an answer that names no mode is not reused; the next stage asks again", () => {
    const { proj, state } = project();
    const first = currentStage(state);
    askModeQuestion(proj, first, "Q1: A, Q2: B");
    advance(proj, state);
    expect(runStageAnswerMode(proj)).toMatchObject({ setting: "once", ask: true, mode: null });
  });

  test("an isolated --single answer never sets the main workflow's mode", () => {
    const { proj, state } = project();
    const first = currentStage(state);
    askModeQuestion(proj, first, "Chat", ["--single"]);
    expect(runStageAnswerMode(proj)).toMatchObject({ ask: true, mode: null });
  });

  test("--answer-mode changes it, records CEREMONY_SET, and ask restores the per-stage question", () => {
    const { proj, state } = project();
    const first = currentStage(state);
    askModeQuestion(proj, first, "Guide me");

    // The slash flag names one config command; it never mutates on its own.
    const routed = run(ORCHESTRATE, ["next", "--answer-mode", "chat"], proj);
    expect(routed.status, routed.stderr).toBe(0);
    const printed = JSON.parse(routed.stdout.trim().split("\n").pop()!);
    expect(printed.kind).toBe("print");
    expect(printed.message).toMatch(/`[^`]*\bengine config set answer-mode chat`/);
    expect(getField(readFileSync(state, "utf-8"), "Answer Mode")).toBeNull();
    expect(JSON.parse(run(ORCHESTRATE, ["next", "--answer-mode", "loud"], proj).stdout.trim()).kind).toBe("error");

    const changed = run(DISPATCHER, ["engine", "config", "set", "answer-mode", "chat"], proj);
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.stdout).toContain("Answer Mode changed: once (from default) to chat (set by a command)");
    expect(getField(readFileSync(state, "utf-8"), "Answer Mode")).toBe("chat (set by a command)");
    const set = readAuditShardEvents(proj).filter((row) => row.event === "CEREMONY_SET");
    expect(set).toHaveLength(1);
    expect(auditBlockField(set[0].block, "Key")).toBe("answer_mode");
    expect(auditBlockField(set[0].block, "Old")).toBe("once");
    expect(auditBlockField(set[0].block, "New")).toBe("chat");
    expect(runStageAnswerMode(proj)).toMatchObject({ setting: "chat", source: "command", mode: "chat", ask: false });
    const repeat = run(UTILITY, ["config-change", "--answer-mode", "chat"], proj);
    expect(repeat.stdout).toContain("Answer Mode is already chat (set by a command)");
    expect(readAuditShardEvents(proj).filter((row) => row.event === "CEREMONY_SET")).toHaveLength(1);

    expect(run(UTILITY, ["config-change", "--answer-mode", "ask"], proj).status).toBe(0);
    expect(runStageAnswerMode(proj)).toMatchObject({ setting: "ask", mode: null, ask: true });
    const second = advance(proj, state);
    expect(stageStartedAnswerMode(proj, second)).toBe("ask (set by a command)");
    expect(runStageAnswerMode(proj)).toMatchObject({ setting: "ask", ask: true });

    // `once` returns to reuse, and finds the latest recorded choice.
    expect(run(UTILITY, ["config-change", "--answer-mode", "once"], proj).status).toBe(0);
    expect(runStageAnswerMode(proj)).toMatchObject({ setting: "once", mode: "guide", reused_from: first });
    const refused = run(UTILITY, ["config-change", "--answer-mode", "loud"], proj);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("--answer-mode requires <once|ask|guide|file|chat>");
  });

  test("the kill switch asks at every stage even after an answer", () => {
    const { proj, state } = project();
    askModeQuestion(proj, currentStage(state), "Chat");
    expect(runStageAnswerMode(proj)).toMatchObject({ mode: "chat", ask: false });
    expect(runStageAnswerMode(proj, { [ANSWER_MODE_ENV]: "1" })).toMatchObject({
      setting: "ask", source: `env ${ANSWER_MODE_ENV}`, mode: null, ask: true,
    });
  });

  test("a creation flag sets the mode before the first stage, with no question", () => {
    const { proj, state } = project(["--answer-mode", "guide"]);
    expect(getField(readFileSync(state, "utf-8"), "Answer Mode")).toBe("guide (set by a command)");
    expect(stageStartedAnswerMode(proj, currentStage(state))).toBe("guide (set by a command)");
    expect(runStageAnswerMode(proj)).toMatchObject({ setting: "guide", mode: "guide", ask: false });
  });

  test("an intent created without the flag writes no Answer Mode line", () => {
    const { state } = project();
    expect(getField(readFileSync(state, "utf-8"), "Answer Mode")).toBeNull();
  });
});
