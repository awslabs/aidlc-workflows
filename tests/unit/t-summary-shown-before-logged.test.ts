// covers: subcommand:aidlc-log:decision, subcommand:aidlc-log:answer, audit:SUMMARY_CONFIRMATION_RECORDED
//
// The agent showed a stage's summary confirmation ("Does this all look correct
// before I generate the artifact?") before recording the question, and the
// person answered "looks correct". The answer was refused because no reply had
// arrived after the question's record, and the person was told "Your answer was
// not recorded, so you don't need to answer again", then asked for one more
// message (a live Kiro IDE run). The tool proves only that the person replied
// since their last answer and keeps their words; the agent says which question
// the reply answers. A reply that came before the question's record is the
// agent's reading, so the engine says it back once. No reply since the last
// answer still records nothing, with no line about a missed reply.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, seedAidlcMemory, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c2c2";
const STAGE = "requirements-analysis";
const SUMMARY = "Does this all look correct before I generate the artifact?";
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});

function project(policy: "off" | "strict"): { proj: string; questions: string } {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const state = seededStateFile(proj);
  writeFileSync(state, readFileSync(state, "utf-8").replace("- **Change Control**: strict (from scope bugfix)",
    policy === "off" ? "- **Guard Policy**: off (from scope bugfix)" : "- **Guard Policy**: strict (set by you)"));
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, `${STAGE}-questions.md`);
  writeFileSync(questions, [
    "# Requirements Questions", "", "## Q1", "Where does the blank title come from?", "", "A) The form", "B) The API",
    "X) Other (please specify)", "", "[Answer]: A", "", "## Consolidated Summary Confirmation", "",
    "Blank titles from the form are refused.", "", "- Looks correct", "- Request changes", "", "[Answer]:", "",
  ].join("\n"));
  return { proj, questions };
}

// What the person types, through the prompt hook, which keeps their words.
function says(proj: string, prompt: string): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const result = Bun.spawnSync({
    cmd: [process.execPath, DISPATCHER, "engine", "hook", "record-human-turn"], cwd: proj, env,
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt })),
    stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

// The guards these cases are about stay on, as the agent meets them.
function log(proj: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const result = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [process.execPath, LOG, ...args, "--project-dir", proj], env, stdout: "pipe", stderr: "pipe",
  });
  return { status: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

const events = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);

// The person leaves the stage's questions to the agent, which answers them.
function questionsLeftToTheAgent(proj: string): void {
  expect(log(proj, ["decision", "--stage", STAGE, "--decision", "How would you like to answer the questions?",
    "--options", "Guide me,I'll edit the file,Chat"]).status).toBe(0);
  says(proj, "go with the recommended");
  for (const details of ["Chat", "Q1: A. The form"]) {
    const answered = log(proj, ["answer", "--stage", STAGE, "--details", details,
      "--on-instruction", "go with the recommended"]);
    expect(answered.status, answered.out).toBe(0);
  }
}

const askSummary = (proj: string, questions: string) =>
  log(proj, ["decision", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", questions,
    "--decision", SUMMARY, "--options", "Looks correct,Request changes"]);

function answerSummary(
  proj: string, questions: string, choice: "Looks correct" | "Request changes", details: string = choice,
) {
  writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]:[^\n]*\n$/, `[Answer]: ${choice}\n`));
  return log(proj, ["answer", "--checkpoint", "summary-confirmation", "--stage", STAGE, "--questions-file", questions,
    "--details", details]);
}

const said = (out: string): unknown => {
  const line = out.split("\n").find((entry) => entry.includes('"emitted":"SUMMARY_CONFIRMATION_RECORDED"'));
  return line ? (JSON.parse(line) as { say?: string }).say : "no receipt output";
};

describe("t-summary-shown-before-logged: a summary answered before its question was recorded", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`the reply already given confirms it, with their words, said back once (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      // The summary is shown, not yet recorded, and the person replies to it.
      says(proj, "looks correct");
      const turns = events(proj, "HUMAN_TURN").length;
      expect(askSummary(proj, questions).status).toBe(0);
      const recorded = answerSummary(proj, questions, "Looks correct");
      expect(recorded.status, recorded.out).toBe(0);
      const receipts = events(proj, "SUMMARY_CONFIRMATION_RECORDED");
      expect(receipts).toHaveLength(1);
      expect(auditBlockField(receipts[0].block, "Person Reply")).toBe("looks correct");
      expect(said(recorded.out)).toBe(`Recorded your "looks correct" for "${SUMMARY}".`);
      // No second message was needed.
      expect(events(proj, "HUMAN_TURN")).toHaveLength(turns);
    });

    test(`a reply after the question's record confirms it with nothing said back (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      says(proj, "yes, looks correct");
      const recorded = answerSummary(proj, questions, "Looks correct");
      expect(recorded.status, recorded.out).toBe(0);
      expect(auditBlockField(events(proj, "SUMMARY_CONFIRMATION_RECORDED")[0].block, "Person Reply"))
        .toBe("yes, looks correct");
      expect(said(recorded.out)).toBeUndefined();
    });

    test(`after a change request, the reply to the summary shown again confirms it (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      says(proj, "request changes: say the API too");
      const changed = answerSummary(proj, questions, "Request changes", "Request changes: say the API too");
      expect(changed.status, changed.out).toBe(0);
      writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]: Request changes\n$/, "[Answer]:\n"));
      // The revised summary is shown again, not yet recorded, and the person replies to it.
      says(proj, "looks correct now");
      expect(askSummary(proj, questions).status).toBe(0);
      const recorded = answerSummary(proj, questions, "Looks correct");
      expect(recorded.status, recorded.out).toBe(0);
      expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(2);
      expect(said(recorded.out)).toBe(`Recorded your "looks correct now" for "${SUMMARY}".`);
    });

    test(`with no reply since the last answer, nothing is recorded and no reply is called missed (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      const recorded = answerSummary(proj, questions, "Looks correct");
      expect(recorded.status).not.toBe(0);
      expect(recorded.out).toContain("no human reply has arrived since their last answer");
      expect(recorded.out).not.toContain("was not recorded");
      expect(recorded.out).not.toContain("answer again");
      expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(0);
    });
  }
});
