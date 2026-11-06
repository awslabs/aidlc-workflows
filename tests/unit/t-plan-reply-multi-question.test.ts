// covers: function:notePlanApprovalAskReply, function:pickerReplyToThisQuestion, function:questionsAlone
//
// The code plan question asked in one question box beside other questions
// (#3621). The agent may put the plan question in a box with another question
// (the verification command, say); the person answers both and submits. The
// plan question's own answer is their reply to it, read as if the box had asked
// it alone; another question's answer never is. These cases drive the real
// human-turn hook (and Codex's adapter), `next`, `log answer` and the
// plan-approval guard over one poc workflow at Code Generation:
//
//   - under strict, relaxed and off, with the plan question first or later in
//     the box: Approve Plan is recorded once, with the plan's own answer as the
//     person's reply; the agent's record says it is already recorded; the build
//     is handed to the developer through the guard; the plan is not asked again;
//   - the plan question's answer is another of its choices (Request Changes,
//     I'll edit the files) or their own words: that is what counts, never the
//     other question's Approve;
//   - nothing is guessed: the plan question left blank, asked twice, asked as a
//     multi-select, or not asked at all keeps nothing for the plan, and the
//     refusal's way on (their next reply) records;
//   - Claude Code's box limits: four questions with the plan last; the plan
//     with only its two required choices; a fourth choice of the agent's own
//     makes it some other question, as in a box of one;
//   - Codex's box (answers keyed by question id): the plan pick approves, with
//     the person's note beside it too; a blank plan answer keeps nothing;
//   - a box answered before the plan question was shown keeps nothing for it;
//   - a box that asks only the plan question is read as before.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { planApprovalRuntimeFile, writeSessionPidEntry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const SESSION = "01995000-7a11-7000-8000-000000000001";

const PLAN_QUESTION = "Approve the code plan? Only Step 1 changed: it builds slugify with the built-in tools.";
const VERIFY_QUESTION = "Use this command to verify each completed Unit? `bun test`";
const PLAN_CHOICES = ["Approve Plan", "Request Changes", "I'll edit the files"];
const VERIFY_CHOICES = ["Approve", "Request Changes"];
const NOT_REPLIED = "has not replied to the plan question";

interface Directive {
  kind: string;
  ask_type?: string;
  plan_approval?: { status?: string; editing?: boolean; feedback?: string };
}

interface Asked {
  question: string;
  options: string[];
  multiSelect?: boolean;
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function project(policy: "strict" | "relaxed" | "off" = "relaxed"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy} (from scope poc)\n- **Plan Approval**: on (set by you)`)
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

function writePlan(proj: string): void {
  const dir = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8");
  writeFileSync(join(dir, "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
}

function next(proj: string): Directive {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: { ...process.env, AIDLC_UNATTENDED: "0" } });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Directive;
}

function askFor(proj: string): void {
  writePlan(proj);
  const ask = next(proj);
  expect(ask.kind, JSON.stringify(ask)).toBe("ask");
  expect(ask.ask_type).toBe("plan-approval");
}

function hook(proj: string, payload: Record<string, unknown>): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ session_id: SESSION, ...payload }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

// Claude Code's AskUserQuestion: answers keyed by each question's text; a
// question the person left blank has no answer.
function box(proj: string, asked: Asked[], answers: Record<string, string>): void {
  const questions = asked.map(({ question, options, multiSelect }) => ({
    question, header: question.slice(0, 12), multiSelect: multiSelect === true,
    options: options.map((label) => ({ label, description: "" })),
  }));
  hook(proj, {
    hook_event_name: "PostToolUse", tool_name: "AskUserQuestion",
    tool_input: { questions }, tool_response: { questions, answers },
  });
}

function typed(proj: string, prompt: string): void {
  hook(proj, { hook_event_name: "UserPromptSubmit", prompt });
}

// Codex's request_user_input through its adapter: answers keyed by question id.
function codexBox(proj: string, answers: Record<string, string[]>): void {
  cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(proj, ".codex"), { recursive: true });
  const session = "codex-plan-several-questions";
  writeSessionPidEntry(proj, process.pid, session);
  const result = spawnSync(BUN, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: session,
      turn_id: "codex-turn-several",
      cwd: proj,
      tool_name: "request_user_input",
      tool_input: {
        questions: [
          { id: "command", question: VERIFY_QUESTION, options: VERIFY_CHOICES },
          { id: "plan", question: PLAN_QUESTION, options: ["Approve Plan (Recommended)", "Request Changes", "I'll edit the files"] },
        ],
      },
      tool_response: JSON.stringify({
        answers: Object.fromEntries(Object.entries(answers).map(([id, picks]) => [id, { answers: picks }])),
      }),
      tool_use_id: "request-codex-turn-several",
    }),
    env: { ...process.env, AIDLC_UNATTENDED: undefined, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

function answer(proj: string, details: string): { code: number; message: string } {
  const result = spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--details", details, "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const line = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").find((entry) => entry.startsWith("{"));
  const parsed = line ? JSON.parse(line) as { message?: string; error?: string } : {};
  return { code: result.status ?? -1, message: parsed.message ?? parsed.error ?? `${result.stdout}${result.stderr}` };
}

function brief(proj: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), "brief", "--stage-level", "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
}

function guardDispatch(proj: string, prompt: string): { code: number; stderr: string } {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: "Agent",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

function generationStarted(proj: string): boolean {
  const dir = dirname(planApprovalRuntimeFile(proj, "probe"));
  if (!existsSync(dir)) return false;
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .some((name) => /"status":\s*"generation"/.test(readFileSync(join(dir, name), "utf-8")));
}

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

function approvals(proj: string): number {
  return auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)?.length ?? 0;
}

const plan: Asked = { question: PLAN_QUESTION, options: PLAN_CHOICES };
const verify: Asked = { question: VERIFY_QUESTION, options: VERIFY_CHOICES };

// The plan question's choices were never answered: the agent's approval is
// refused, as for a box that asked some other question, and the person's next
// reply records it (the refusal's way on).
function stillOpenThenTheirReplyRecords(proj: string): void {
  expect(approvals(proj)).toBe(0);
  expect(answer(proj, "Approve Plan").message).toContain(NOT_REPLIED);
  typed(proj, "yes, build that plan");
  const recorded = answer(proj, "Approve Plan");
  expect(recorded.code, recorded.message).toBe(0);
  expect(recorded.message).toContain('Recorded "Approve Plan"');
  expect(auditText(proj)).toContain("**Person Reply**: yes, build that plan\n");
}

describe("the plan question in a box of several questions", () => {
  for (const policy of ["strict", "relaxed", "off"] as const) {
    for (const order of ["first", "second"] as const) {
      test(`${policy}, plan question ${order}: Approve Plan is recorded once and the build is handed over`, () => {
        const proj = project(policy);
        askFor(proj);
        box(proj, order === "first" ? [plan, verify] : [verify, plan],
          { [PLAN_QUESTION]: "Approve Plan", [VERIFY_QUESTION]: "Approve" });
        // The box's own pick of a choice is recorded by the hook, with the
        // plan question's answer as their reply, never the other question's.
        expect(approvals(proj)).toBe(1);
        const audit = auditText(proj);
        expect(audit).toContain("**Person Reply**: Approve Plan\n");
        expect(audit).not.toContain("**Person Reply**: Approve\n");
        // Each question's own reply is still on the record, as before.
        expect(audit).toContain("**Reply**: Approve Plan\n");
        expect(audit).toContain("**Reply**: Approve\n");
        // The agent's record of the same choice is not refused and adds nothing.
        const again = answer(proj, "Approve Plan");
        expect(again.code, again.message).toBe(0);
        expect(again.message).toContain("is already recorded");
        expect(approvals(proj)).toBe(1);
        const build = next(proj);
        expect(build.kind, JSON.stringify(build)).toBe("run-stage");
        expect(build.plan_approval).toEqual({ status: "approved" });
        const ready = brief(proj);
        expect(ready.status, ready.stderr).toBe(0);
        const handed = guardDispatch(proj, ready.stdout);
        expect(handed.code, handed.stderr).toBe(0);
        expect(generationStarted(proj)).toBe(true);
        const after = next(proj);
        expect(after.ask_type, JSON.stringify(after)).not.toBe("plan-approval");
        expect(approvals(proj)).toBe(1);
      });
    }
  }

  test("Request Changes in the plan question is their answer, beside Approve for the other question", () => {
    const proj = project();
    askFor(proj);
    box(proj, [verify, plan], { [VERIFY_QUESTION]: "Approve", [PLAN_QUESTION]: "Request Changes" });
    expect(approvals(proj)).toBe(0);
    expect(auditText(proj)).toContain("**Details**: Request Changes\n");
    expect(next(proj).plan_approval?.status).toBe("revise");
  });

  test("I'll edit the files in the plan question opens edit mode", () => {
    const proj = project();
    askFor(proj);
    box(proj, [plan, verify], { [PLAN_QUESTION]: "I'll edit the files", [VERIFY_QUESTION]: "Approve" });
    expect(approvals(proj)).toBe(0);
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.plan_approval?.editing).toBe(true);
  });

  test("their own words in the plan question are kept for the agent to read; the hook records nothing", () => {
    const proj = project();
    askFor(proj);
    const words = "Approve it, but call the function toSlug";
    box(proj, [verify, plan], { [VERIFY_QUESTION]: "Approve", [PLAN_QUESTION]: words });
    expect(approvals(proj)).toBe(0);
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.message).toContain('Recorded "Approve Plan"');
    expect(auditText(proj)).toContain(`**Person Reply**: ${words}\n`);
  });

  test("the plan question left blank keeps nothing, even with Approve picked for the other question", () => {
    const proj = project();
    askFor(proj);
    box(proj, [plan, verify], { [VERIFY_QUESTION]: "Approve" });
    stillOpenThenTheirReplyRecords(proj);
  });

  test("a box asking the plan question twice keeps nothing: no guess between them", () => {
    const proj = project();
    askFor(proj);
    const other = "Approve the code plan for the helpers too?";
    box(proj, [plan, { question: other, options: PLAN_CHOICES }],
      { [PLAN_QUESTION]: "Approve Plan", [other]: "Approve Plan" });
    stillOpenThenTheirReplyRecords(proj);
  });

  test("the plan question as a multi-select in a box of several keeps nothing", () => {
    const proj = project();
    askFor(proj);
    box(proj, [{ ...plan, multiSelect: true }, verify],
      { [PLAN_QUESTION]: "Approve Plan, Request Changes", [VERIFY_QUESTION]: "Approve" });
    stillOpenThenTheirReplyRecords(proj);
  });

  test("a box whose questions offer none of the plan's choices keeps nothing for it", () => {
    const proj = project();
    askFor(proj);
    const name = "Name the module slugify or slug?";
    box(proj, [verify, { question: name, options: ["slugify", "slug"] }],
      { [VERIFY_QUESTION]: "Approve", [name]: "slugify" });
    stillOpenThenTheirReplyRecords(proj);
  });

  test("a box that asks only the plan question is read as before: its pick, or their words for the agent", () => {
    const picked = project();
    askFor(picked);
    box(picked, [plan], { [PLAN_QUESTION]: "Approve Plan" });
    expect(approvals(picked)).toBe(1);
    expect(auditText(picked)).toContain("**Person Reply**: Approve Plan\n");
    expect(next(picked).plan_approval).toEqual({ status: "approved" });
    const worded = project();
    askFor(worded);
    box(worded, [plan], { [PLAN_QUESTION]: "go ahead with it" });
    expect(approvals(worded)).toBe(0);
    const recorded = answer(worded, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(auditText(worded)).toContain("**Person Reply**: go ahead with it\n");
  });

  test("a box answered before the plan question was shown keeps nothing for it", () => {
    const proj = project();
    writePlan(proj);
    box(proj, [plan, verify], { [PLAN_QUESTION]: "Approve Plan", [VERIFY_QUESTION]: "Approve" });
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    stillOpenThenTheirReplyRecords(proj);
  });
});

describe("Claude Code's box limits: four questions, two to four choices each", () => {
  test("four questions with the plan question last: its Approve Plan is recorded", () => {
    const proj = project();
    askFor(proj);
    const name = "Name the module slugify or slug?";
    const docs = "Add a README section?";
    box(proj, [verify, { question: name, options: ["slugify", "slug"] }, { question: docs, options: ["Yes", "No"] }, plan],
      { [VERIFY_QUESTION]: "Approve", [name]: "slug", [docs]: "No", [PLAN_QUESTION]: "Approve Plan" });
    expect(approvals(proj)).toBe(1);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("the plan question with only its two required choices still answers it", () => {
    const proj = project();
    askFor(proj);
    box(proj, [verify, { question: PLAN_QUESTION, options: ["Approve Plan", "Request Changes"] }],
      { [VERIFY_QUESTION]: "Approve", [PLAN_QUESTION]: "Approve Plan" });
    expect(approvals(proj)).toBe(1);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("a fourth choice of the agent's own makes it some other question, as in a box of one", () => {
    const proj = project();
    askFor(proj);
    box(proj, [verify, { question: PLAN_QUESTION, options: [...PLAN_CHOICES, "Build the earlier plan"] }],
      { [VERIFY_QUESTION]: "Approve", [PLAN_QUESTION]: "Approve Plan" });
    stillOpenThenTheirReplyRecords(proj);
  });
});

describe("Codex's box of several questions, answers keyed by question id", () => {
  test("the plan pick approves; the other question's Approve is not taken", () => {
    const proj = project();
    askFor(proj);
    codexBox(proj, { command: ["Approve"], plan: ["Approve Plan (Recommended)"] });
    expect(approvals(proj)).toBe(1);
    expect(auditText(proj)).not.toContain("**Person Reply**: Approve\n");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("the plan pick with the person's note beside it approves, as in a box of one", () => {
    const proj = project();
    askFor(proj);
    codexBox(proj, { command: ["Approve"], plan: ["Approve Plan (Recommended)", "user_note: keep the old helper"] });
    expect(approvals(proj)).toBe(1);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("the plan question left blank keeps nothing for it", () => {
    const proj = project();
    askFor(proj);
    codexBox(proj, { command: ["Approve"], plan: [] });
    stillOpenThenTheirReplyRecords(proj);
  });
});
