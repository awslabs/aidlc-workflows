// covers: function:notePlanApprovalAskReply, function:publishPlanApprovalAsk,
// hook:aidlc-record-human-turn, function:recordProtectedHumanResponse
//
// While the code plan question is open, the person asks for a verification
// command first and the agent asks about it. A typed reply is the agent's to
// read against the question it showed: "1" there records nothing at the hook,
// the agent records the command, and the plan question still waits for its own
// answer, which the agent records when the person gives it. A pick in a
// question box names its own question and is recorded where it lands, in this
// chat or while another chat shows the plan question.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, runOrchestrateNext,
  seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const SESSION = "01995000-7a11-7000-8000-000000000031";
const OTHER_CHAT = "01995000-7a11-7000-8000-000000000032";
const COMMAND = "git diff --check";
const QUESTION = `Use this command to verify each completed Unit? \`${COMMAND}\``;
const PLAN_QUESTION = "Approve the code plan?";
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function run(proj: string, args: string[], input?: unknown): { code: number; out: string } {
  const result = spawnSync(BUN, args, {
    cwd: proj,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function hook(proj: string, payload: Record<string, unknown>): void {
  const result = run(proj, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
    { session_id: SESSION, ...payload });
  expect(result.code, result.out).toBe(0);
}

const say = (proj: string, prompt: string) => hook(proj, { hook_event_name: "UserPromptSubmit", prompt });

// A pick in Claude Code's question box.
function pick(proj: string, question: string, options: string[], chosen: string): void {
  const asked = [{
    question, header: "Choice", multiSelect: false, options: options.map((label) => ({ label, description: "" })),
  }];
  hook(proj, {
    hook_event_name: "PostToolUse", tool_name: "AskUserQuestion",
    tool_input: { questions: asked }, tool_response: { questions: asked, answers: { [question]: chosen } },
  });
}

function log(proj: string, args: string[]): { code: number; out: string } {
  return run(proj, [join(AIDLC_SRC, "tools", "aidlc-log.ts"), ...args, "--session", SESSION, "--project-dir", proj]);
}

const command = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", COMMAND];

// `chat` runs it in that chat, as the agent's shell there does.
function next(proj: string, chat?: string): Record<string, unknown> {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), proj, [], {
    env: { ...process.env, AIDLC_UNATTENDED: "0", ...(chat ? { AIDLC_SESSION_OVERRIDE: chat } : {}) },
  });
  expect(result.status, result.out).toBe(0);
  return result.directive as Record<string, unknown>;
}

function planApprovals(proj: string): number {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8").split("**Event**: PLAN_APPROVAL_RECORDED").length - 1)
    .reduce((sum, count) => sum + count, 0);
}

// The record keeps whole seconds, and a person answers seconds after a
// question shows: each step that follows a question starts in a later second.
const laterSecond = () => Bun.sleepSync(1001 - (Date.now() % 1000));

// The plan question is open, and the person asks for the command first; the
// agent registers its own question about it, as the Construction rules say.
function commandAskedOverThePlan(chat?: string): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)",
      "- **Guard Policy**: relaxed (from scope poc)\n- **Plan Approval**: on (set by you)")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation"), "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  // A fixture that wrote its state by hand gets the start row it would have had.
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "poc" }, proj);
  const dir = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n${renderTestingContract(resolveTestingPosture(proj))}`,
    "utf-8");
  writeFileSync(join(dir, "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
  expect(next(proj, chat)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  laterSecond();
  say(proj, `before you build anything, use ${COMMAND} as the verification command`);
  const asked = log(proj, ["decision", ...command, "--decision", "Use this command to verify each completed Unit?",
    "--options", "Approve,Request Changes"]);
  expect(asked.code, asked.out).toBe(0);
  laterSecond();
  return proj;
}

// The agent's record of the plan answer it read from the person's reply.
function agentApprovesPlan(proj: string): void {
  expect(planApprovals(proj)).toBe(0);
  const approved = log(proj, ["answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan"]);
  expect(approved.code, approved.out).toBe(0);
  expect(planApprovals(proj)).toBe(1);
}

// The agent records the command it read; the plans keep waiting, and the plan
// question, shown again, has the person's next reply for the agent to record.
function pickAnsweredTheCommand(proj: string): void {
  expect(planApprovals(proj)).toBe(0);
  const recorded = log(proj, ["answer", ...command, "--details", "Approve"]);
  expect(recorded.code, recorded.out).toBe(0);
  expect(recorded.out).toContain("VERIFICATION_COMMAND_RECORDED");
  const set = run(proj, [join(AIDLC_SRC, "tools", "aidlc-state.ts"), "set-construction-verification-command", COMMAND,
    "--project-dir", proj]);
  expect(set.code, set.out).toBe(0);
  expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  laterSecond();
  say(proj, "1");
  agentApprovesPlan(proj);
  expect(next(proj)).toMatchObject({ plan_approval: { status: "approved" } });
}

test("a number typed at the command question is the agent's to read; the code plan question beneath it records nothing", () => {
  const proj = commandAskedOverThePlan();
  say(proj, "1");
  pickAnsweredTheCommand(proj);
});

test("a picker pick at the command question answers it, not the code plan question beneath it", () => {
  const proj = commandAskedOverThePlan();
  pick(proj, QUESTION, ["Approve", "Request Changes"], "Approve");
  pickAnsweredTheCommand(proj);
});

test("a picker pick at the code plan question approves the plan while the command question waits", () => {
  const proj = commandAskedOverThePlan();
  pick(proj, PLAN_QUESTION, ["Approve Plan", "Request Changes", "I'll edit the files"], "Approve Plan");
  expect(planApprovals(proj)).toBe(1);
  expect(log(proj, ["answer", ...command, "--details", "Approve"]).out).toContain("none is on record yet");
});

test("the code plan question shown again after the command question: the agent records the next reply as its answer", () => {
  const proj = commandAskedOverThePlan();
  expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  laterSecond();
  say(proj, "1");
  agentApprovesPlan(proj);
  expect(next(proj)).toMatchObject({ plan_approval: { status: "approved" } });
});

test("a number typed at the command question while another chat shows the code plan question is the agent's to read", () => {
  const proj = commandAskedOverThePlan(SESSION);
  expect(next(proj, OTHER_CHAT)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  laterSecond();
  say(proj, "1");
  pickAnsweredTheCommand(proj);
});

test("the code plan question shown again in the same chat: the agent records the next reply as its answer", () => {
  const proj = commandAskedOverThePlan(SESSION);
  expect(next(proj, SESSION)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  laterSecond();
  say(proj, "1");
  agentApprovesPlan(proj);
});
