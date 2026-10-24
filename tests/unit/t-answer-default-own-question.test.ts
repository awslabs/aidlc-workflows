// covers: function:personsGateReply, subcommand:aidlc-log:answer, audit:QUESTION_ANSWERED
//
// An answer the agent records with no message named takes the person's words
// and message from their replies since the last decision. One reply answers
// every question logged before it, and a reply no answer names yet answers a
// question the agent logs after it ("use postgres" said first). But a reply
// another answer already names is not taken for a question the agent logged
// after that reply: a live opencode run recorded the person's "postgres" for
// the database as their answer to a question about blank titles that the agent
// logged and answered itself, never shown to them. Such an answer is recorded
// as before, with no words of theirs; a message the agent names (--message) is
// its reading and is recorded as named.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seedAidlcMemory, seededStateFile, seedStateFile } from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const CHAT = "01995000-7a11-7000-8000-00000000a5a5";
const STAGE = "requirements-analysis";
// A message and a row keep whole seconds: a question logged a second later comes after the reply.
const tick = () => Bun.sleepSync(1100);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});

// Production guards, as a person's run has them, in this chat.
function env(proj: string): NodeJS.ProcessEnv {
  return {
    ...testGuardEnvironment(process.env, "production"),
    CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
  };
}

function spawn(proj: string, cmd: string[], stdin?: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...cmd], cwd: proj, env: env(proj), stdout: "pipe", stderr: "pipe",
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);

// What the person types in this chat, through the prompt hook every harness uses; the message id its turn names.
function says(proj: string, prompt: string): string {
  const kept = spawn(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
    JSON.stringify({ session_id: CHAT, hook_event_name: "UserPromptSubmit", prompt }));
  expect(kept.status, kept.out).toBe(0);
  return auditBlockField(rows(proj, "HUMAN_TURN").at(-1)?.block ?? "", "Message Id") ?? "";
}

function asks(proj: string, decision: string, options: string): void {
  const logged = spawn(proj, [LOG, "decision", "--stage", STAGE, "--decision", decision, "--options", options, "--project-dir", proj]);
  expect(logged.status, logged.out).toBe(0);
}

function answers(proj: string, details: string, message?: string): void {
  const named = message === undefined ? [] : ["--message", message];
  const answered = spawn(proj, [LOG, "answer", "--stage", STAGE, "--details", details, ...named, "--project-dir", proj]);
  expect(answered.status, answered.out).toBe(0);
}

// Each answer on record: its choice, the person's words and the message the row names.
function recorded(proj: string): Array<{ details: string | null; words: string | null; message: string | null }> {
  return rows(proj, "QUESTION_ANSWERED").map((row) => ({
    details: auditBlockField(row.block, "Details"),
    words: auditBlockField(row.block, "Person Reply"),
    message: auditBlockField(row.block, "Message Id"),
  }));
}

// Requirements Analysis running on bugfix work, its questions the agent's own.
function requirements(): string {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const state = seededStateFile(proj);
  writeFileSync(state, readFileSync(state, "utf-8")
    .replace(/- \*\*Change Control\*\*: [^\n]*/, "- **Guard Policy**: strict (from scope bugfix)"));
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  return proj;
}

describe("an answer with no message named takes a reply only for a question it can answer", () => {
  test("a question the agent logs after the reply another answer used does not take that reply", () => {
    const proj = requirements();
    asks(proj, "Which database should the to-do app use?", "PostgreSQL,SQLite,Other");
    const postgres = says(proj, "/aidlc postgres");
    answers(proj, "PostgreSQL");
    tick();
    asks(proj, "Should a blank title be refused?", "Yes,No,Other");
    answers(proj, "Yes");
    expect(recorded(proj)).toEqual([
      { details: "PostgreSQL", words: "postgres", message: postgres },
      { details: "Yes", words: null, message: null },
    ]);
  });

  test("named by the agent, that reply is recorded for the later question, as before", () => {
    const proj = requirements();
    asks(proj, "Which database should the to-do app use?", "PostgreSQL,SQLite,Other");
    const both = says(proj, "postgres, and yes, refuse blank titles");
    answers(proj, "PostgreSQL");
    tick();
    asks(proj, "Should a blank title be refused?", "Yes,No,Other");
    answers(proj, "Yes", both);
    expect(recorded(proj).at(-1)).toEqual({ details: "Yes", words: "postgres, and yes, refuse blank titles", message: both });
  });

  test("one reply answers every question logged before it", () => {
    const proj = requirements();
    asks(proj, "Which database?", "PostgreSQL,SQLite");
    asks(proj, "Refuse blank titles?", "Yes,No");
    tick();
    const both = says(proj, "postgres, and yes refuse blank titles");
    answers(proj, "PostgreSQL");
    answers(proj, "Yes");
    expect(recorded(proj)).toEqual([
      { details: "PostgreSQL", words: "postgres, and yes refuse blank titles", message: both },
      { details: "Yes", words: "postgres, and yes refuse blank titles", message: both },
    ]);
  });

  test("a reply no answer names yet answers the question the agent logs after it", () => {
    const proj = requirements();
    const said = says(proj, "use postgres for the database");
    tick();
    asks(proj, "Which database?", "PostgreSQL,SQLite");
    answers(proj, "PostgreSQL");
    expect(recorded(proj)).toEqual([{ details: "PostgreSQL", words: "use postgres for the database", message: said }]);
  });
});
