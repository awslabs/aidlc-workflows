// covers: function:publishPlanApprovalAsk, function:notePlanApprovalFileAnswer, function:requestPlanApprovalReviewNow, hook:aidlc-record-human-turn
//
// The Plan Approval questions file says "write your answer after `[Answer]:`
// and tell me here when you are done". These cases drive the real `next` and the real human-turn
// hook (Claude Code's payload, and Kiro CLI's userPromptSubmit payload through
// its adapter) over one poc workflow at Code Generation, under Guard Policy off
// and strict, and check that:
//
//   - an answer the person wrote in the file is still there when `next` shows
//     the question again (nothing they wrote is thrown away);
//   - when they say done, an exact choice in the file is recorded as their
//     pick, like "1" typed in chat, and the next `next` builds (or revises);
//   - words that are not one of the choices are not read by a tool: the hook
//     names the file for the agent, which reads them and records the choice;
//   - a turn that does not say done leaves the file unread and kept;
//   - an answer the engine wrote itself (a recorded approval the person then
//     asked to review) is never read back as theirs.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-000000000031";

interface Emitted {
  kind: string;
  ask_type?: string;
  message?: string;
  part?: number;
  receipt?: string;
  plan_approval?: { status?: string; feedback?: string; editing?: boolean };
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
    .replace(
      "- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy} (from scope poc)\n- **Plan Approval**: on (set by you)`,
    )
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

function stageDir(proj: string): string {
  return join(seededRecordDir(proj), "construction", "code-generation");
}

function writePlan(proj: string): void {
  mkdirSync(stageDir(proj), { recursive: true });
  writeFileSync(
    join(stageDir(proj), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(
    join(stageDir(proj), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n",
    "utf-8",
  );
}

function next(proj: string, args: string[] = []): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, AIDLC_UNATTENDED: "0" } });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

/** The person's message in Claude Code, read by the human-turn hook; returns the hook's context line. */
function reply(proj: string, prompt: string): string {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ?? "";
}

/** What the agent runs after reading the person's reply. */
function answer(proj: string, details: string, extra: string[] = []): { code: number; message: string } {
  const result = spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--details", details, ...extra, "--project-dir", proj,
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

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

function questionsPath(proj: string): string {
  return join(stageDir(proj), "code-generation-questions.md");
}

/** The person writes their answer in the questions file, in their own editor. */
function writeAnswer(proj: string, text: string): void {
  const path = questionsPath(proj);
  writeFileSync(path, readFileSync(path, "utf-8").replace(/^\[Answer\]:[ \t]*$/m, `[Answer]: ${text}`), "utf-8");
}

function answerLine(proj: string): string {
  return /^\[Answer\]:.*$/m.exec(readFileSync(questionsPath(proj), "utf-8"))?.[0] ?? "(none)";
}

function askFor(proj: string): Emitted {
  writePlan(proj);
  const directive = next(proj);
  expect(directive.kind, JSON.stringify(directive)).toBe("ask");
  expect(directive.ask_type).toBe("plan-approval");
  return directive;
}

// Arden, 2026-10-07: a person-facing line never asks the person to type exact
// words. The questions file's own invite said "write your answer after
// `[Answer]:` and say done", and two guide rows paraphrased it, so the file the
// person opens told them a word to send back.
describe("the questions file invites an answer without naming words to say", () => {
  const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf-8");
  test("the invite and the two guide rows ask them to tell the agent, in their words", () => {
    const invite = read("core/tools/aidlc-plan-approval-ask.ts");
    expect(invite).toContain("write your answer after `[Answer]:` and tell me here when you are done");
    expect(invite).not.toContain("write your answer after `[Answer]:` and say done");
    for (const rel of ["docs/guide/07-interaction-modes.md", "docs/guide/13-customization.md"]) {
      expect(read(rel), rel).not.toContain("then send **done**");
      expect(read(rel), rel).not.toContain("then say done");
    }
  });
});

describe("an answer written in the Plan Approval questions file", () => {
  test("stays in the file when next shows the question again", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    expect(next(proj).kind).toBe("ask");
    expect(answerLine(proj)).toBe("[Answer]: Approve Plan");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
  });

  for (const policy of ["off", "strict"] as const) {
    test(`Approve Plan in the file, then done in chat: recorded, and the next next builds (Guard Policy ${policy})`, () => {
      const proj = project(policy);
      askFor(proj);
      writeAnswer(proj, "Approve Plan");
      const context = reply(proj, "done");
      expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
      expect(auditText(proj)).toContain("**Person Reply**: done");
      expect(context).toContain("is recorded");
      expect(context).toContain("code-generation-questions.md");
      expect(answerLine(proj)).toBe("[Answer]: A. Approve Plan");
      // The agent's own record of the same choice is fine; a different one is refused.
      expect(answer(proj, "Approve Plan").message).toContain("already recorded");
      expect(answer(proj, "Request Changes").code).not.toBe(0);
      expect(next(proj).plan_approval).toEqual({ status: "approved" });
    });
  }

  test("the file's choice is read the way a chat pick is: its letter, its number, or its label", () => {
    for (const written of ["A. Approve Plan", "1", "approve plan", "A"]) {
      const proj = project();
      askFor(proj);
      writeAnswer(proj, written);
      reply(proj, "Done.");
      expect(auditText(proj), written).toContain("**Event**: PLAN_APPROVAL_RECORDED");
      expect(next(proj).plan_approval, written).toEqual({ status: "approved" });
    }
  });

  test("done with the choice recorded: next with the word says to run bare next", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    reply(proj, "done");
    const read = next(proj, ["done"]);
    expect(read.kind, JSON.stringify(read)).toBe("print");
    expect(read.message).toContain("it is recorded");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("Request Changes in the file, then done: the plan goes back for revision", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "B. Request Changes");
    reply(proj, "done");
    expect(auditText(proj)).toContain("**Details**: Request Changes");
    expect(answerLine(proj)).toBe("[Answer]: B. Request Changes");
    expect(next(proj).plan_approval).toEqual({ status: "revise" });
  });

  test("words in the file that are not a choice: nothing is recorded by a tool; the agent is told where they are", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "use a lookup table");
    const context = reply(proj, "done");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(auditText(proj)).not.toContain("**Details**: Request Changes");
    expect(context).toContain("code-generation-questions.md");
    expect(context).toContain("use a lookup table");
    // The agent reads the file and records the choice the person made.
    expect(answer(proj, "Request Changes", ["--reason", "use a lookup table"]).message).toContain('Recorded "Request Changes"');
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "use a lookup table" });
  });

  test("a turn that does not say done leaves the file's answer unread, and kept", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    reply(proj, "what does the Touches line mean?");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).kind).toBe("ask");
    expect(answerLine(proj)).toBe("[Answer]: Approve Plan");
    reply(proj, "done");
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("a choice typed in chat wins over the file: the file's older answer is not read", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    reply(proj, "2");
    expect(auditText(proj)).toContain("**Details**: Request Changes");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).plan_approval).toEqual({ status: "revise" });
  });

  test("an answer the engine wrote is never read back as the person's: after Review the plan the line is blank", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(answerLine(proj)).toBe("[Answer]: A. Approve Plan");
    expect(answer(proj, "Review the plan").code).toBe(0);
    expect(next(proj).kind).toBe("ask");
    expect(answerLine(proj)).toBe("[Answer]:");
    reply(proj, "done");
    expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)?.length ?? 0).toBe(1);
    expect(next(proj).kind).toBe("ask");
  });

  test("edit mode is unchanged: done leaves the record to the agent, which reads the files", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "3");
    expect(next(proj).plan_approval?.editing).toBe(true);
    writeAnswer(proj, "Approve Plan");
    reply(proj, "done");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(answer(proj, "Approve Plan").message).toContain('Recorded "Approve Plan"');
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });
});

describe("the same answer through Kiro CLI's userPromptSubmit hook", () => {
  function tool(proj: string, tools: string, [name, ...args]: string[], input?: string): string {
    const result = spawnSync(BUN, [join(tools, name), ...args], {
      cwd: proj,
      ...(input !== undefined ? { input } : {}),
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return result.stdout ?? "";
  }

  function engine(proj: string, tools: string, args: string[]): Emitted {
    return JSON.parse(tool(proj, tools, ["aidlc-orchestrate.ts", ...args, "--project-dir", proj]).trim()) as Emitted;
  }

  for (const policy of ["off", "strict"] as const) {
    test(`Approve Plan in the file, then done in Kiro CLI chat: recorded, and the build arrives (Guard Policy ${policy})`, () => {
      const proj = createTestProject();
      created.push(proj);
      cpSync(join(REPO_ROOT, "dist", "kiro", "aidlc"), join(proj, "aidlc"), { recursive: true });
      cpSync(join(REPO_ROOT, "dist", "kiro", ".kiro"), join(proj, ".kiro"), { recursive: true });
      writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Add a --shout option to greet.py
- **Project Type**: Brownfield
- **Scope**: poc
- **State Version**: 8

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Minimal
- **Test Strategy**: Minimal
- **Guard Policy**: ${policy} (from scope poc)
- **Plan Approval**: on (set by you)

## Stage Progress

### INITIALIZATION PHASE
- [x] workspace-scaffold \u2014 EXECUTE
- [x] workspace-detection \u2014 EXECUTE
- [x] state-init \u2014 EXECUTE

### CONSTRUCTION PHASE
- [-] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`, "utf-8");
      mkdirSync(join(proj, "src"), { recursive: true });
      writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
      const kiro = join(proj, ".kiro", "tools");
      writePlan(proj);
      const ask = engine(proj, kiro, ["next"]);
      expect(ask.kind, JSON.stringify(ask)).toBe("ask");
      expect(ask.ask_type).toBe("plan-approval");
      writeAnswer(proj, "Approve Plan");
      // Without a word from the person, next shows the question again and keeps their answer.
      expect(engine(proj, kiro, ["next"]).kind).toBe("ask");
      expect(answerLine(proj)).toBe("[Answer]: Approve Plan");
      // The person types "done" in Kiro CLI chat; its userPromptSubmit hook reads it.
      const context = tool(proj, kiro, ["aidlc.ts", "engine", "adapter", "kiro", "verb-intercept"], JSON.stringify({
        hook_event_name: "userPromptSubmit", cwd: proj, session_id: SESSION, prompt: "done",
      }));
      expect(context).toContain("is recorded");
      expect(answerLine(proj)).toBe("[Answer]: A. Approve Plan");
      expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
      let directive = engine(proj, kiro, ["next"]);
      for (let i = 0; directive.kind === "load-steering" && i < 20; i++) {
        directive = engine(proj, kiro, ["continue", String(directive.receipt)]);
      }
      expect(directive.kind, JSON.stringify(directive)).toBe("run-stage");
      expect(directive.plan_approval).toEqual({ status: "approved" });
    });
  }
});
