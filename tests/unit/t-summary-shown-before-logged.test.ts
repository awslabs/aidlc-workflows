// covers: subcommand:aidlc-log:decision, subcommand:aidlc-log:answer, audit:SUMMARY_CONFIRMATION_RECORDED, function:answeredBeforeShownStep, function:stageStartFloorRefusal
//
// The agent showed a stage's summary confirmation ("Does this all look correct
// before I generate the artifact?") before recording the question, and the
// person answered "looks correct". The answer was refused and the person was
// told "Your answer was not recorded, so you don't need to answer again", then
// asked for one more message (a live Kiro IDE run). The summary counts a reply
// that came after its question was recorded, as a stage gate does; when the
// agent showed it first, it names the message that answered (--message), and
// the engine says nothing back for the agent to read out. The refusal names
// the person's message ids and times, never their words, so the agent retries
// without asking them again; a message from before the stage started cannot
// be named, nor one sent before the agent last wrote the questions file (a
// write the record holds): the summary was not there to see. No reply since
// the last decision still records nothing, with no line about a missed reply.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { readMessage, saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
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

function project(policy: "off" | "relaxed" | "strict"): { proj: string; questions: string } {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const state = seededStateFile(proj);
  writeFileSync(state, readFileSync(state, "utf-8").replace("- **Change Control**: strict (from scope bugfix)",
    policy === "off" ? "- **Guard Policy**: off (from scope bugfix)" : `- **Guard Policy**: ${policy} (set by you)`));
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

// The guards these cases are about stay on, as the agent meets them, in the
// chat the person typed in.
function log(proj: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SESSION_OVERRIDE: SESSION };
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
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
  message?: string,
) {
  writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]:[^\n]*\n$/, `[Answer]: ${choice}\n`));
  return log(proj, ["answer", "--checkpoint", "summary-confirmation", "--stage", STAGE, "--questions-file", questions,
    "--details", details, ...(message === undefined ? [] : ["--message", message])]);
}

// The message the person's latest turn kept: its id and when they sent it.
function latestMessage(proj: string): { id: string; at: string } {
  const id = auditBlockField(events(proj, "HUMAN_TURN").at(-1)!.block, "Message Id")!;
  return { id, at: readMessage(proj, id)!.at };
}

// The refusal as the agent reads it: the message of the error the tool printed.
function refusal(out: string): string {
  const line = out.split("\n").find((entry) => entry.trim().startsWith("{") && entry.includes('"error"'));
  return line ? String((JSON.parse(line) as { error?: unknown }).error) : out;
}

// What the hooks do when the agent ends its turn.
function stop(proj: string): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_SESSION_OVERRIDE: SESSION,
    CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "",
  };
  for (const name of ["AIDLC_UNATTENDED", "AIDLC_STOP_HOOK_PROBE", "AIDLC_SESSION_OVERRIDE_SOURCE"]) delete env[name];
  const result = Bun.spawnSync({
    cmd: [process.execPath, DISPATCHER, "engine", "hook", "continue-workflow"], cwd: proj, env,
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, session_id: SESSION })),
    stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

// The agent's own write of the questions file, as the write hook records it.
function agentWrites(proj: string, questions: string): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_SESSION_OVERRIDE: SESSION,
  };
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const result = Bun.spawnSync({
    cmd: [process.execPath, DISPATCHER, "engine", "hook", "write-audit-log"], cwd: proj, env,
    stdin: new TextEncoder().encode(JSON.stringify({
      hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Edit", tool_input: { file_path: questions },
    })),
    stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

// The record's times are whole seconds: what comes next lands in a later one.
function nextSecond(): void {
  const now = new Date().toISOString().slice(0, 19);
  while (new Date().toISOString().slice(0, 19) === now) Bun.sleepSync(10);
}

const said = (out: string): unknown => {
  const line = out.split("\n").find((entry) => entry.includes('"emitted":"SUMMARY_CONFIRMATION_RECORDED"'));
  return line ? (JSON.parse(line) as { say?: string }).say : "no receipt output";
};

describe("t-summary-shown-before-logged: a summary answered before its question was recorded", () => {
  for (const policy of ["off", "relaxed", "strict"] as const) {
    test(`a reply given before the question was recorded is refused with the retry: its id and time, none of its words (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      // The summary is shown, not yet recorded, and the person replies to it.
      says(proj, "looks correct");
      const reply = latestMessage(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      const refused = answerSummary(proj, questions, "Looks correct");
      expect(refused.status).not.toBe(0);
      const first = refusal(refused.out).split(";")[0];
      expect(first).toStartWith("If their message ");
      expect(first).toContain(`${reply.id} (sent ${reply.at})`);
      expect(first).toContain("run the same log answer with --message <id>");
      expect(refusal(refused.out)).not.toContain("looks correct");
      expect(refusal(refused.out)).not.toContain("go with the recommended");
      expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(0);
    });

    test(`the agent names the reply it read the confirmation from, and it is recorded on that message, nothing said back (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      says(proj, "looks correct");
      const reply = latestMessage(proj);
      const turns = events(proj, "HUMAN_TURN").length;
      expect(askSummary(proj, questions).status).toBe(0);
      expect(answerSummary(proj, questions, "Looks correct").status).not.toBe(0);
      const recorded = answerSummary(proj, questions, "Looks correct", "Looks correct", reply.id);
      expect(recorded.status, recorded.out).toBe(0);
      const receipts = events(proj, "SUMMARY_CONFIRMATION_RECORDED");
      expect(receipts).toHaveLength(1);
      expect(auditBlockField(receipts[0].block, "Message Id")).toBe(reply.id);
      expect(auditBlockField(receipts[0].block, "Person Reply")).toBe("looks correct");
      expect(said(recorded.out)).toBeUndefined();
      expect(events(proj, "HUMAN_TURN")).toHaveLength(turns);
    });

    test(`a reply after the question's record confirms it with nothing said back (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      says(proj, "yes, looks correct");
      const recorded = answerSummary(proj, questions, "Looks correct");
      expect(recorded.status, recorded.out).toBe(0);
      // Every reply of theirs in this chat that no decision has used yet: the
      // answers' replies spend none (the audit escapes the line break).
      expect(auditBlockField(events(proj, "SUMMARY_CONFIRMATION_RECORDED")[0].block, "Person Reply"))
        .toBe("go with the recommended\\nyes, looks correct");
      expect(said(recorded.out)).toBeUndefined();
    });

    test(`after a change request, the reply to the summary shown again confirms it when the agent names it (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      says(proj, "request changes: say the API too");
      const changed = answerSummary(proj, questions, "Request changes", "Request changes: say the API too");
      expect(changed.status, changed.out).toBe(0);
      writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]: Request changes\n$/, "[Answer]:\n"));
      // The revised summary is shown again, not yet recorded, and the person replies to it.
      says(proj, "looks correct now");
      const reply = latestMessage(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      const recorded = answerSummary(proj, questions, "Looks correct", "Looks correct", reply.id);
      expect(recorded.status, recorded.out).toBe(0);
      expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(2);
      expect(said(recorded.out)).toBeUndefined();
    });

    // An answer spends no reply, but the summary asked after it is a question
    // they have not seen yet: the retry names the reply, for the agent to read.
    test(`the reply the stage's answers stood on does not confirm the summary asked after it (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      const reply = latestMessage(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      const refused = answerSummary(proj, questions, "Looks correct");
      expect(refused.status).not.toBe(0);
      expect(refusal(refused.out)).toStartWith(`If their message ${reply.id} (sent ${reply.at}) answered`);
      expect(refusal(refused.out)).not.toContain("go with the recommended");
      expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(0);
    });

    test(`the request that started the stage cannot be named to confirm its summary (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      says(proj, "the greeting shows a blank title, fix it");
      const request = latestMessage(proj);
      appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
      questionsLeftToTheAgent(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      const refused = answerSummary(proj, questions, "Looks correct", "Looks correct", request.id);
      expect(refused.status).not.toBe(0);
      expect(refusal(refused.out)).toContain(`on message ${request.id}: it came before this stage started`);
      expect(refusal(refused.out)).toContain("show the summary and end your turn");
      expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(0);
    });

    // A reply typed while another engine question was on screen (the routing
    // question) is still theirs when the agent names it: it came after the
    // stage started, so the floor lets it confirm the summary.
    test(`a confirmation sent while another question was open records once the agent names it (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      says(proj, "the greeting shows a blank title, fix it");
      appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
      questionsLeftToTheAgent(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      const held = saveMessage(proj, {
        session: SESSION, at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), source: "prompt", text: "looks correct",
        picker: null, words: "looks correct", settings: [],
        route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
      });
      appendAuditEntry("HUMAN_TURN", { Session: SESSION, "Message Id": held.id, "Open Question": "new-work-routing" }, proj);
      const recorded = answerSummary(proj, questions, "Looks correct", "Looks correct", held.id);
      expect(recorded.status, recorded.out).toBe(0);
      expect(recorded.out).not.toContain("came before this stage started");
      const receipts = events(proj, "SUMMARY_CONFIRMATION_RECORDED");
      expect(receipts).toHaveLength(1);
      expect(auditBlockField(receipts[0].block, "Message Id")).toBe(held.id);
      expect(auditBlockField(receipts[0].block, "Person Reply")).toBe("looks correct");
    });

    // The refusal's other way on is the person's next reply: the question stays
    // open, the turn ends there, and their reply confirms it.
    test(`after the refusal the turn ends at the summary and their next reply confirms it (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      expect(answerSummary(proj, questions, "Looks correct").status).not.toBe(0);
      expect(stop(proj)).toBe("");
      says(proj, "looks correct");
      const recorded = answerSummary(proj, questions, "Looks correct");
      expect(recorded.status, recorded.out).toBe(0);
      expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(1);
    });

    // A live run: "approve" typed at another question, then the agent wrote
    // the summary, recorded its question and named that message. The summary
    // they confirm was on record before they replied, or they never saw it.
    test(`a reply sent before the agent wrote the summary cannot be named to confirm it (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      says(proj, "approve");
      const reply = latestMessage(proj);
      agentWrites(proj, questions);
      expect(askSummary(proj, questions).status).toBe(0);
      const bare = answerSummary(proj, questions, "Looks correct");
      expect(bare.status).not.toBe(0);
      expect(refusal(bare.out)).not.toContain(reply.id);
      expect(refusal(bare.out)).toContain("Show the summary and end your turn");
      const named = answerSummary(proj, questions, "Looks correct", "Looks correct", reply.id);
      expect(named.status).not.toBe(0);
      expect(refusal(named.out)).toContain(`their message ${reply.id} came before the summary was last written`);
      expect(refusal(named.out)).toContain("Show the summary and end your turn");
      expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(0);
    });

    // Writing the confirmation's own `[Answer]:` comes after its question's
    // record, and is no change to what they confirmed.
    test(`the summary written before the reply is confirmed on the message the agent names (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      questionsLeftToTheAgent(proj);
      agentWrites(proj, questions);
      nextSecond();
      says(proj, "looks correct");
      const reply = latestMessage(proj);
      expect(askSummary(proj, questions).status).toBe(0);
      writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]:[^\n]*\n$/, "[Answer]: Looks correct\n"));
      agentWrites(proj, questions);
      const recorded = answerSummary(proj, questions, "Looks correct", "Looks correct", reply.id);
      expect(recorded.status, recorded.out).toBe(0);
      const receipts = events(proj, "SUMMARY_CONFIRMATION_RECORDED");
      expect(receipts).toHaveLength(1);
      expect(auditBlockField(receipts[0].block, "Message Id")).toBe(reply.id);
      expect(auditBlockField(receipts[0].block, "Person Reply")).toBe("looks correct");
    });

    test(`with no reply since the last decision, nothing is recorded and no reply is called missed (Guard Policy ${policy})`, () => {
      const { proj, questions } = project(policy);
      expect(askSummary(proj, questions).status).toBe(0);
      const recorded = answerSummary(proj, questions, "Looks correct");
      expect(recorded.status).not.toBe(0);
      expect(recorded.out).toContain("no human reply has arrived since the last decision");
      expect(recorded.out).not.toContain("was not recorded");
      expect(recorded.out).not.toContain("answer again");
      expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(0);
    });
  }
});
