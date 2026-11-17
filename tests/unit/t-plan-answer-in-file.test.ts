// covers: function:publishPlanApprovalAsk, function:requestPlanApprovalReviewNow, hook:aidlc-record-human-turn
//
// The Plan Approval questions file says "write your answer after `[Answer]:`
// and tell me in chat when you are done". These cases drive the real `next` and the real human-turn
// hook (Claude Code's payload, and Kiro CLI's userPromptSubmit payload through
// its adapter) over one poc workflow at Code Generation, under Guard Policy off
// and strict, and check that:
//
//   - an answer the person wrote in the file is still there when `next` shows
//     the question again, also when another line of the file changed (nothing
//     they wrote is thrown away), and never carried onto another question;
//   - when they say they are done, in whatever words, no tool reads the file:
//     the agent reads the line and records the choice it says, and the next
//     `next` builds (or revises), the person's words beside the record;
//   - a choice typed in chat and one written in the file are both the agent's
//     to read;
//   - an answer the engine wrote itself (a recorded approval the person then
//     asked to review) is never read back as theirs, and the line approves
//     nothing on its own.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { planApprovalRuntimeFile } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
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

/** The audit rows of one event, newest last. */
function rows(proj: string, event: string): string[] {
  return auditText(proj).split(/\n---\n/).filter((block) => block.includes(`**Event**: ${event}\n`));
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

/** The next `next` leaves the questions file alone: the same bytes, not written again. */
function nextLeavesFileAlone(proj: string): void {
  const path = questionsPath(proj);
  const bytes = readFileSync(path, "utf-8");
  const earlier = new Date("2001-01-01T00:00:00Z");
  utimesSync(path, earlier, earlier);
  expect(next(proj).kind).toBe("ask");
  expect(readFileSync(path, "utf-8")).toBe(bytes);
  expect(statSync(path).mtimeMs).toBe(earlier.getTime());
}

function askFor(proj: string): Emitted {
  writePlan(proj);
  const directive = next(proj);
  expect(directive.kind, JSON.stringify(directive)).toBe("ask");
  expect(directive.ask_type).toBe("plan-approval");
  return directive;
}

// A person-facing line never asks the person to type exact words. The
// questions file's own invite said "write your answer after `[Answer]:` and say
// done", and two guide rows paraphrased it, so the file the person opens told
// them a word to send back.
describe("the questions file invites an answer without naming words to say", () => {
  const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf-8");
  test("the invite and the two guide rows ask them to tell the agent, in their words", () => {
    const invite = read("core/tools/aidlc-plan-approval-ask.ts");
    expect(invite).toContain("write your answer after `[Answer]:` and tell me in chat when you are done");
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

  // A source file saved while the question waits moves the file's Planned
  // Source line, so the file is written again; the same question stands, so
  // their answer comes with it, and it is read as theirs.
  test("stays when another line of the file changes while the same question stands", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan, the slug rules look right");
    const before = readFileSync(questionsPath(proj), "utf-8");
    writeFileSync(join(proj, "src", "base.ts"), "export const base = false;\n", "utf-8");
    expect(next(proj).kind).toBe("ask");
    expect(readFileSync(questionsPath(proj), "utf-8")).not.toBe(before);
    expect(answerLine(proj)).toBe("[Answer]: Approve Plan, the slug rules look right");
    nextLeavesFileAlone(proj);
    reply(proj, "done");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(rows(proj, "PLAN_APPROVAL_RECORDED").at(-1))
      .toContain("**Answer Line In File**: Approve Plan, the slug rules look right");
  });

  test("stays in a file saved with Windows line endings", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    const path = questionsPath(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\n/g, "\r\n"), "utf-8");
    expect(next(proj).kind).toBe("ask");
    expect(answerLine(proj)).toBe("[Answer]: Approve Plan");
  });

  // The file ends with the `[Answer]:` line, so what they wrote under it is
  // theirs too, and comes whole: never an approval cut from its condition.
  test("keeps what they wrote under the line", () => {
    for (const written of ["[Answer]: Approve Plan\nbut drop step 3\n", "[Answer]:\nApprove Plan, it looks right\n"]) {
      const proj = project();
      askFor(proj);
      const path = questionsPath(proj);
      writeFileSync(path, readFileSync(path, "utf-8").replace(/^\[Answer\]:\n$/m, written), "utf-8");
      const before = readFileSync(path, "utf-8");
      expect(before.endsWith(written)).toBe(true);
      writeFileSync(join(proj, "src", "base.ts"), "export const base = false;\n", "utf-8");
      expect(next(proj).kind).toBe("ask");
      const after = readFileSync(path, "utf-8");
      expect(after).not.toBe(before);
      expect(after.endsWith(`\n\n${written}`), after).toBe(true);
      nextLeavesFileAlone(proj);
    }
  });

  // Any words they write are theirs, the words the engine uses for a plan built
  // without asking included; only that record itself holds no answer of theirs.
  test("keeps their own words Plan approval off, and never carries the record of a plan built without asking", () => {
    const quoted = "Approve Plan, not AI-DLC built this plan without asking because plan approval is off for this";
    for (const words of ["Plan approval off", quoted]) {
      const theirs = project();
      askFor(theirs);
      writeAnswer(theirs, words);
      const before = readFileSync(questionsPath(theirs), "utf-8");
      writeFileSync(join(theirs, "src", "base.ts"), "export const base = false;\n", "utf-8");
      expect(next(theirs).kind).toBe("ask");
      expect(readFileSync(questionsPath(theirs), "utf-8")).not.toBe(before);
      expect(answerLine(theirs)).toBe(`[Answer]: ${words}`);
    }
    const record = project();
    askFor(record);
    const path = questionsPath(record);
    const asked = readFileSync(path, "utf-8");
    writeFileSync(path, asked
      .replace(/^AI-DLC writes this file when it asks you[^\n]*\n[^\n]*\n/m,
        "AI-DLC built this plan without asking because plan approval is off for this\n" +
          "piece of work. This file is the record and asks nothing; to look at a plan\nbefore it is built, ask in chat.\n")
      .replace(/^\[Answer\]:$/m, "[Answer]: Plan approval off"), "utf-8");
    expect(readFileSync(path, "utf-8")).toContain("AI-DLC built this plan without asking");
    expect(answerLine(record)).toBe("[Answer]: Plan approval off");
    writeFileSync(join(record, "src", "base.ts"), "export const base = false;\n", "utf-8");
    expect(next(record).kind).toBe("ask");
    expect(readFileSync(path, "utf-8")).toContain("AI-DLC writes this file when it asks you");
    expect(answerLine(record)).toBe("[Answer]:");
  });

  // An answer is for the plan its file shows: a changed plan is a new question.
  test("is not carried onto a question about a changed plan", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    const fingerprint = () => /^\[Approval Fingerprint\]: (\S+)$/m.exec(readFileSync(questionsPath(proj), "utf-8"))?.[1];
    const asked = fingerprint();
    const plan = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(plan, readFileSync(plan, "utf-8").replace("slugify for titles", "slugify for titles and tags"), "utf-8");
    expect(next(proj).ask_type).toBe("plan-approval");
    expect(fingerprint()).not.toBe(asked);
    expect(answerLine(proj)).toBe("[Answer]:");
  });

  test("is not carried when the question's words changed", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    const dir = dirname(planApprovalRuntimeFile(proj, "probe"));
    for (const name of readdirSync(dir).filter((entry) => entry.startsWith("ask-"))) {
      const record = JSON.parse(readFileSync(join(dir, name), "utf-8"));
      writeFileSync(join(dir, name), JSON.stringify({ ...record, question: "Approve the earlier plan?" }), "utf-8");
    }
    writeFileSync(join(proj, "src", "base.ts"), "export const base = false;\n", "utf-8");
    expect(next(proj).ask_type).toBe("plan-approval");
    expect(answerLine(proj)).toBe("[Answer]:");
  });

  test("is not carried from a file that names another plan", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    const path = questionsPath(proj);
    writeFileSync(path, readFileSync(path, "utf-8")
      .replace(/^\[Approval Fingerprint\]: \S+$/m, `[Approval Fingerprint]: sha256:v3:${"0".repeat(64)}`), "utf-8");
    expect(next(proj).ask_type).toBe("plan-approval");
    expect(answerLine(proj)).toBe("[Answer]:");
  });

  // A clone keeps no record of the question, so nothing says it was asked
  // there: the file is written fresh, as it always was.
  test("is not carried in a clone with no record of the question", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    const dir = dirname(planApprovalRuntimeFile(proj, "probe"));
    for (const name of readdirSync(dir).filter((entry) => entry.startsWith("ask-"))) rmSync(join(dir, name));
    writeFileSync(join(proj, "src", "base.ts"), "export const base = false;\n", "utf-8");
    expect(next(proj).ask_type).toBe("plan-approval");
    expect(answerLine(proj)).toBe("[Answer]:");
  });

  for (const policy of ["off", "strict"] as const) {
    test(`Approve Plan in the file, then done in chat: the agent records it, and the next next builds (Guard Policy ${policy})`, () => {
      const proj = project(policy);
      askFor(proj);
      writeAnswer(proj, "Approve Plan");
      const context = reply(proj, "done");
      expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
      expect(context).not.toContain("is recorded");
      const recorded = answer(proj, "Approve Plan");
      expect(recorded.code, recorded.message).toBe(0);
      expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
      expect(auditText(proj)).toContain("**Person Reply**: done");
      expect(answer(proj, "Approve Plan").message).toContain("already recorded");
      expect(next(proj).plan_approval).toEqual({ status: "approved" });
    });
  }

  test("done in other words: no tool reads the file, and the agent's record of the line is recorded", () => {
    for (const said of ["Done.", "finished", "ok I'm done, it's in the file", "fertig"]) {
      const proj = project();
      askFor(proj);
      writeAnswer(proj, "A. Approve Plan");
      reply(proj, said);
      expect(auditText(proj), said).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
      const recorded = answer(proj, "Approve Plan");
      expect(recorded.code, `${said}: ${recorded.message}`).toBe(0);
      expect(next(proj).plan_approval, said).toEqual({ status: "approved" });
    }
  });

  test("done while the question waits: next with the word names the record step", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    reply(proj, "done");
    const read = next(proj, ["done"]);
    expect(read.kind, JSON.stringify(read)).toBe("print");
    expect(read.message).toContain("[Answer]:");
    expect(read.message).toContain("--checkpoint plan-approval");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("Request Changes in the file, then done: the agent records it, and the plan goes back for revision", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "B. Request Changes");
    reply(proj, "done");
    expect(auditText(proj)).not.toContain("**Details**: Request Changes");
    expect(answer(proj, "Request Changes").code).toBe(0);
    expect(next(proj).plan_approval?.status).toBe("revise");
  });

  test("words in the file that are not a choice: the agent reads them and records the change", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "use a lookup table");
    reply(proj, "done");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(auditText(proj)).not.toContain("**Details**: Request Changes");
    expect(answer(proj, "Request Changes", ["--reason", "use a lookup table"]).message).toContain('Recorded "Request Changes"');
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "use a lookup table" });
  });

  test("a turn about something else leaves the file's answer unread, and kept", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    reply(proj, "what does the Touches line mean?");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).kind).toBe("ask");
    expect(answerLine(proj)).toBe("[Answer]: Approve Plan");
    reply(proj, "done");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("a choice typed in chat and the file's older answer are both the agent's to read", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "Approve Plan");
    reply(proj, "2");
    expect(auditText(proj)).not.toContain("**Details**: Request Changes");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(answer(proj, "Request Changes").code).toBe(0);
    // The record keeps the file's line as it was found, beside the choice read from chat.
    expect(rows(proj, "QUESTION_ANSWERED").at(-1)).toContain("**Answer Line In File**: Approve Plan");
    expect(next(proj).plan_approval?.status).toBe("revise");
  });

  test("an answer the engine wrote is never read back as the person's: after Review the plan the line is blank", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(answerLine(proj)).toBe("[Answer]: A. Approve Plan");
    expect(answer(proj, "Review the plan").code).toBe(0);
    expect(next(proj).kind).toBe("ask");
    expect(answerLine(proj)).toBe("[Answer]:");
    reply(proj, "done");
    expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)?.length ?? 0).toBe(1);
    expect(next(proj).kind).toBe("ask");
  });

  // The file invites an answer after `[Answer]:`; the engine then writes its own
  // mark over that line, so the record is where what they wrote is kept.
  test("the line they wrote is kept on the approval's record when the engine writes its own mark over it", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "yes, build it");
    reply(proj, "done, I answered in the file");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(answerLine(proj)).toBe("[Answer]: A. Approve Plan");
    const row = rows(proj, "PLAN_APPROVAL_RECORDED").at(-1)!;
    expect(row).toContain("**Answer Line In File**: yes, build it");
    expect(row).toContain("**Person Reply**: done, I answered in the file");
  });

  test("the line they wrote is kept on a Request Changes record", () => {
    const proj = project();
    askFor(proj);
    writeAnswer(proj, "use a lookup table");
    reply(proj, "done");
    expect(answer(proj, "Request Changes", ["--reason", "use a lookup table"]).code).toBe(0);
    expect(answerLine(proj)).toBe("[Answer]: B. Request Changes");
    expect(rows(proj, "QUESTION_ANSWERED").at(-1)).toContain("**Answer Line In File**: use a lookup table");
  });

  // The file lists its choices as "A. Approve Plan" and so on, and a person may copy one onto the line: it is
  // their answer as much as their own words are, whatever they then say in chat.
  test("a displayed choice copied onto the line is kept as theirs, beside the choice recorded", () => {
    const changed = project();
    askFor(changed);
    writeAnswer(changed, "A. Approve Plan");
    reply(changed, "2");
    expect(answer(changed, "Request Changes").code).toBe(0);
    expect(rows(changed, "QUESTION_ANSWERED").at(-1)).toContain("**Answer Line In File**: A. Approve Plan");
    const same = project();
    askFor(same);
    writeAnswer(same, "A. Approve Plan");
    reply(same, "done");
    expect(answer(same, "Approve Plan").code).toBe(0);
    expect(rows(same, "PLAN_APPROVAL_RECORDED").at(-1)).toContain("**Answer Line In File**: A. Approve Plan");
  });

  // A choice already recorded for this plan left the engine's own mark on the line; the next answer to the same
  // question (an approval after a Request Changes that was misread) never keeps it as theirs.
  test("the engine's mark from an answer already recorded is never kept as theirs", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    expect(answer(proj, "Request Changes").code).toBe(0);
    expect(answerLine(proj)).toBe("[Answer]: B. Request Changes");
    reply(proj, "no, sorry, I meant approve it");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    const approval = rows(proj, "PLAN_APPROVAL_RECORDED").at(-1);
    expect(approval).toBeDefined();
    expect(approval).not.toContain("Answer Line In File");
  });

  // Their own words over the engine's mark, at the approval that corrects a misread Request Changes, are theirs.
  test("their words written over the engine's mark of a misread answer are kept on the correction", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    expect(answer(proj, "Request Changes").code).toBe(0);
    const path = questionsPath(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: approve it, that was a slip"), "utf-8");
    reply(proj, "I answered in the file");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(rows(proj, "PLAN_APPROVAL_RECORDED").at(-1)).toContain("**Answer Line In File**: approve it, that was a slip");
  });

  // Choosing to edit the files withdraws the recorded answer and leaves the engine's mark on the line; the approval
  // after the edit never keeps that mark as theirs.
  test("the engine's mark left on the line when the person chose to edit is never kept as theirs", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    expect(answer(proj, "Request Changes").code).toBe(0);
    reply(proj, "actually I'll edit the files myself");
    expect(answer(proj, "I'll edit the files").code).toBe(0);
    expect(answerLine(proj)).toBe("[Answer]: B. Request Changes");
    reply(proj, "done");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    const approval = rows(proj, "PLAN_APPROVAL_RECORDED").at(-1);
    expect(approval).toBeDefined();
    expect(approval).not.toContain("Answer Line In File");
  });

  test("an answer given in chat, or the engine's own mark on the line, keeps no line as theirs", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(answer(proj, "Review the plan").code).toBe(0);
    expect(next(proj).kind).toBe("ask");
    reply(proj, "approve it");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    const approvals = rows(proj, "PLAN_APPROVAL_RECORDED");
    expect(approvals).toHaveLength(2);
    for (const row of approvals) expect(row).not.toContain("Answer Line In File");
  });

  test("edit mode is unchanged: done leaves the record to the agent, which reads the files", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "3");
    expect(answer(proj, "I'll edit the files").code).toBe(0);
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
    test(`Approve Plan in the file, then done in Kiro CLI chat: the agent records it, and the build arrives (Guard Policy ${policy})`, () => {
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
      // The person types "done" in Kiro CLI chat; its userPromptSubmit hook keeps it, and the agent reads the file.
      const context = tool(proj, kiro, ["aidlc.ts", "engine", "adapter", "kiro", "verb-intercept"], JSON.stringify({
        hook_event_name: "userPromptSubmit", cwd: proj, session_id: SESSION, prompt: "done",
      }));
      expect(context).not.toContain("is recorded");
      expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
      tool(proj, kiro, ["aidlc-log.ts", "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
        "--details", "Approve Plan", "--project-dir", proj]);
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
