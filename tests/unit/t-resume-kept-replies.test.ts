// covers: function:keptRepliesSinceStageStart
//
// The person's words are kept when they reply (the human-turn hook keeps every
// typed reply). When a stage's questions were answered in a chat that ended
// before the agent wrote or logged the answer, the stage resumed later must
// hand those replies back, so the agent records them instead of asking the
// person again. Live: Kiro CLI, Guide me, the person picked 1 for the first
// question, the agent said "Recorded" and wrote nothing, and the chat ended.
// The engine reads no meaning into the replies: it hands back, in order,
// every reply no decision has used yet (an answer uses none), with the stage's
// questions and answers on record, unpaired, and the agent reads which reply
// answers which question.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  runOrchestrateNext,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const LATER = "01995000-7a11-7000-8000-00000000beef";
const STAGE = "feasibility";

function env(session: string): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: session,
  };
  delete e.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete e.AIDLC_SESSION_OVERRIDE_SOURCE;
  return e;
}

function log(proj: string, args: string[], session = SESSION): void {
  const r = spawnSync(BUN, [LOG, ...args, "--project-dir", proj], {
    env: env(session), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

// What the person types, through the real UserPromptSubmit route every harness uses.
function says(proj: string, prompt: string): void {
  const r = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...env(SESSION), CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, r.stderr).toBe(0);
}

// What the person picks in the harness's question box (Claude Code's
// AskUserQuestion; Codex's request_user_input arrives through the same hook
// shape): one question, or several, each answered with one of its labels.
function picks(proj: string, answers: Record<string, string>): void {
  const questions = Object.keys(answers).map((question) => ({
    question,
    options: [{ label: answers[question] }, { label: "Something else" }],
  }));
  const r = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: SESSION,
      tool_input: { questions }, tool_response: { questions, answers },
    }),
    env: { ...env(SESSION), CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, r.stderr).toBe(0);
}

const Q1 = "Who runs this command?";
const Q2 = "How should months be grouped?";
const SHOP = "A) A shop owner wants a monthly summary from the terminal";

function resumed(proj: string): { directive: Record<string, unknown>; parts: number } {
  const r = runOrchestrateNext(ORCHESTRATE, proj, [], { cwd: proj, env: env(LATER) });
  expect(r.directive?.kind, r.out).toBe("run-stage");
  expect(r.directive?.stage).toBe(STAGE);
  return { directive: r.directive as Record<string, unknown>, parts: r.steering.length };
}

// Rules too big to ride beside the run-stage, so it is delivered in parts and
// rebuilt by `continue`, as on most real projects.
function inflateRules(proj: string): void {
  let filler = "";
  for (let i = 0; i < 12; i++) {
    filler += `\n## Extra rule section ${i}\n\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(60)}\n`;
  }
  appendFileSync(join(proj, "aidlc", "spaces", "default", "memory", "org.md"), filler, "utf-8");
}

const QUESTIONS = `# Feasibility questions

## Question 1
Who runs this command?

A) A shop owner wants a monthly summary from the terminal
B) A developer wants a library function
X) Other

[Answer]:

## Question 2
How should months be grouped?

A) By year-month
B) By calendar month
X) Other

[Answer]:
`;

describe("a stage resumed with blank answers hands back what the person already replied", () => {
  let proj: string;
  let questionsFile: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createOrchestrationTestProject();
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, Agent: "aidlc-architect-agent" }, proj);
    const dir = join(seededRecordDir(proj), "ideation", STAGE);
    mkdirSync(dir, { recursive: true });
    questionsFile = join(dir, `${STAGE}-questions.md`);
    writeFileSync(questionsFile, QUESTIONS);
    log(proj, ["decision", "--stage", STAGE, "--decision", "How would you like to answer the questions?",
      "--options", "Guide me,I'll edit the file,Chat"]);
    says(proj, "1");
    log(proj, ["answer", "--stage", STAGE, "--details", "Guide me"]);
  });
  afterEach(() => cleanupTestProject(proj));

  test("the first question's reply, never written or logged, comes back on resume", () => {
    says(proj, "1");
    const kept = resumed(proj).directive.kept_replies as
      | { questions: string[]; answers: string[]; replies: string[]; note: string }
      | undefined;
    // The "1" that chose the way to answer comes back too: which reply answers
    // which question is the later chat's to read, beside what is on record.
    expect(kept?.replies).toEqual(["1", "1"]);
    expect(kept?.questions).toEqual(["How would you like to answer the questions?"]);
    expect(kept?.answers).toEqual(["Guide me"]);
    expect(kept?.note).toContain("record");
    expect(kept?.note).toContain("ask them again what they already answered");
  });

  test("a run-stage delivered in parts carries them too", () => {
    says(proj, "1");
    inflateRules(proj);
    const { directive, parts } = resumed(proj);
    expect(parts).toBeGreaterThan(0);
    expect((directive.kept_replies as { replies: string[] }).replies).toEqual(["1", "1"]);
  });

  test("several replies come back in the order the person gave them", () => {
    says(proj, "1");
    says(proj, "B, every year counts on its own though");
    expect((resumed(proj).directive.kept_replies as { replies: string[] }).replies)
      .toEqual(["1", "1", "B, every year counts on its own though"]);
  });

  // Live (Kiro CLI, Guide me): eight guided answers in a row, none of them logged.
  test("a whole run of guided answers comes back, every one in order", () => {
    const answers = ["1", "A", "B", "2", "A, and keep it small", "X: round to one decimal", "A", "1"];
    for (const answer of answers) says(proj, answer);
    expect((resumed(proj).directive.kept_replies as { replies: string[] }).replies).toEqual(["1", ...answers]);
  });

  // An answer uses no reply, so a recorded one comes back beside its answer;
  // the step asks the agent to record only what the answers do not hold, so
  // nothing is recorded or asked twice.
  test("a reply whose answer was logged comes back beside that answer, and nothing asks to record it again", () => {
    says(proj, "1");
    log(proj, ["answer", "--stage", STAGE, "--details", "Q1: A"]);
    const kept = resumed(proj).directive.kept_replies as { answers: string[]; replies: string[]; note: string };
    expect(kept.replies).toEqual(["1", "1"]);
    expect(kept.answers).toEqual(["Guide me", "Q1: A"]);
    expect(kept.note).toContain("record with `log answer` only what `answers` does not hold yet");
  });

  // In the later chat the window is that chat's: an answer recorded there for
  // a reply kept in the earlier chat keeps none of its words and names no
  // message, and is not refused.
  test("an answer recorded in the later chat for a reply kept in the earlier one keeps no words of it", () => {
    says(proj, "1");
    log(proj, ["answer", "--stage", STAGE, "--details", "Q1: A"], LATER);
    const answer = readAuditShardEvents(proj).filter((row) => row.event === "QUESTION_ANSWERED").at(-1)!;
    expect(auditBlockField(answer.block, "Details")).toBe("Q1: A");
    expect(auditBlockField(answer.block, "Person Reply")).toBeNull();
    expect(auditBlockField(answer.block, "Message Id")).toBeNull();
  });

  test("with every answer written, nothing is handed back", () => {
    says(proj, "1");
    writeFileSync(questionsFile, QUESTIONS.replaceAll("[Answer]:", "[Answer]: A"));
    expect(resumed(proj).directive.kept_replies).toBeUndefined();
  });

  // Live (Claude Code, Guide me): the person picked the first question's answer
  // in the question box, the chat ended before the agent wrote it, and the next
  // chat asked the same question again.
  test("a pick in the question box, never written or logged, comes back on resume as the label picked", () => {
    picks(proj, { [Q1]: SHOP });
    const kept = resumed(proj).directive.kept_replies as { replies: string[]; answers: string[] } | undefined;
    expect(kept?.replies).toEqual(["1", SHOP]);
    expect(kept?.answers).toEqual(["Guide me"]);
  });

  test("a pick and a typed reply come back in the order they were given", () => {
    picks(proj, { [Q1]: SHOP });
    says(proj, "B, every year counts on its own though");
    expect((resumed(proj).directive.kept_replies as { replies: string[] }).replies)
      .toEqual(["1", SHOP, "B, every year counts on its own though"]);
  });

  test("a box that asked two questions hands back both picks, in order", () => {
    picks(proj, { [Q1]: SHOP, [Q2]: "A) By year-month" });
    expect((resumed(proj).directive.kept_replies as { replies: string[] }).replies)
      .toEqual(["1", SHOP, "A) By year-month"]);
  });

  test("a pick whose answer was logged comes back beside that answer", () => {
    picks(proj, { [Q1]: SHOP });
    log(proj, ["answer", "--stage", STAGE, "--details", "Q1: A"]);
    const kept = resumed(proj).directive.kept_replies as { answers: string[]; replies: string[] };
    expect(kept.replies).toEqual(["1", SHOP]);
    expect(kept.answers).toEqual(["Guide me", "Q1: A"]);
  });

  // A decision that used their replies (the stage's gate shown and answered in
  // an earlier attempt, a routing answer) ends what comes back.
  test("replies a routing answer took are not handed back", () => {
    says(proj, "1");
    appendAuditEntry("REQUEST_ROUTED", { Request: "0000beef" }, proj);
    says(proj, "B, every year counts on its own though");
    expect((resumed(proj).directive.kept_replies as { replies: string[] }).replies)
      .toEqual(["B, every year counts on its own though"]);
  });

  // A record from before the hook named each message (2.11.0 and older), updated
  // mid-stage: that turn's words are not on the message record, and the replies
  // after it still come back.
  test("a turn an older release kept with no message record leaves the later replies standing", () => {
    appendAuditEntry("HUMAN_TURN", { Session: SESSION, Origin: "person", Source: "typed" }, proj);
    says(proj, "B, every year counts on its own though");
    expect((resumed(proj).directive.kept_replies as { replies: string[] }).replies)
      .toEqual(["1", "B, every year counts on its own though"]);
  });
});

describe("a chat that only picked in the question box, with nothing typed, hands its picks back", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createOrchestrationTestProject();
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, Agent: "aidlc-architect-agent" }, proj);
    const dir = join(seededRecordDir(proj), "ideation", STAGE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${STAGE}-questions.md`), QUESTIONS);
    log(proj, ["decision", "--stage", STAGE, "--decision", "How would you like to answer the questions?",
      "--options", "Guide me,I'll edit the file,Chat"]);
    picks(proj, { "How would you like to answer the questions?": "Guide me" });
    log(proj, ["answer", "--stage", STAGE, "--details", "Guide me"]);
  });
  afterEach(() => cleanupTestProject(proj));

  test("the picks come back, and the way to answer is on record beside them", () => {
    picks(proj, { [Q1]: SHOP });
    const kept = resumed(proj).directive.kept_replies as { replies: string[]; answers: string[] } | undefined;
    expect(kept?.replies).toEqual(["Guide me", SHOP]);
    expect(kept?.answers).toEqual(["Guide me"]);
  });
});
