// covers: function:keptRepliesSinceStageStart
//
// The person's words are kept when they reply (the human-turn hook keeps every
// typed reply). When a stage's questions were answered in a chat that ended
// before the agent wrote or logged the answer, the stage resumed later must
// hand those replies back, so the agent records them instead of asking the
// person again. Live: Kiro CLI, Guide me, the person picked 1 for the first
// question, the agent said "Recorded" and wrote nothing, and the chat ended.
// The engine reads no meaning into the replies: it hands them back in order,
// and the agent reads them against the questions.

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

function log(proj: string, args: string[]): void {
  const r = spawnSync(BUN, [LOG, ...args, "--project-dir", proj], {
    env: env(SESSION), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

// The stage resumed from a later chat.
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
    // The mode question, its reply and its answer: all on record.
    log(proj, ["decision", "--stage", STAGE, "--decision", "How would you like to answer the questions?",
      "--options", "Guide me,I'll edit the file,Chat"]);
    says(proj, "1");
    log(proj, ["answer", "--stage", STAGE, "--details", "Guide me"]);
  });
  afterEach(() => cleanupTestProject(proj));

  test("the first question's reply, never written or logged, comes back on resume", () => {
    says(proj, "1");
    const kept = resumed(proj).directive.kept_replies as
      | { answered: Array<{ question: string; answer: string }>; replies: string[]; note: string }
      | undefined;
    expect(kept?.replies).toEqual(["1"]);
    // What came before it is on record, so the later chat reads "1" as the
    // first question's answer, not as the way to answer.
    expect(kept?.answered).toEqual([{ question: "How would you like to answer the questions?", answer: "Guide me" }]);
    expect(kept?.note).toContain("record");
    expect(kept?.note).toContain("ask them again what they already answered");
  });

  test("a run-stage delivered in parts carries them too", () => {
    says(proj, "1");
    inflateRules(proj);
    const { directive, parts } = resumed(proj);
    expect(parts).toBeGreaterThan(0);
    expect((directive.kept_replies as { replies: string[] }).replies).toEqual(["1"]);
  });

  test("several replies come back in the order the person gave them", () => {
    says(proj, "1");
    says(proj, "B, every year counts on its own though");
    expect((resumed(proj).directive.kept_replies as { replies: string[] }).replies)
      .toEqual(["1", "B, every year counts on its own though"]);
  });

  // Live (Kiro CLI, Guide me): eight guided answers in a row, none of them logged.
  test("a whole run of guided answers comes back, every one in order", () => {
    const answers = ["1", "A", "B", "2", "A, and keep it small", "X: round to one decimal", "A", "1"];
    for (const answer of answers) says(proj, answer);
    expect((resumed(proj).directive.kept_replies as { replies: string[] }).replies).toEqual(answers);
  });

  test("a reply whose answer was logged is not handed back", () => {
    says(proj, "1");
    log(proj, ["answer", "--stage", STAGE, "--details", "Q1: A"]);
    expect(resumed(proj).directive.kept_replies).toBeUndefined();
  });

  test("with every answer written, nothing is handed back", () => {
    says(proj, "1");
    writeFileSync(questionsFile, QUESTIONS.replaceAll("[Answer]:", "[Answer]: A"));
    expect(resumed(proj).directive.kept_replies).toBeUndefined();
  });
});
