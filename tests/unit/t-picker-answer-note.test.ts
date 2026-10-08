// covers: file:hooks/aidlc-record-human-turn.ts, file:tools/aidlc-log.ts, audit:QUESTION_ANSWERED, audit:HUMAN_TURN
//
// Where the person answered in a picker, the record notes an answer no picker
// they answered carried: the agent logged a choice the person never saw, or
// one they did not pick. It is a note on the answer's row, never a block. A
// typed reply has no picks to compare, so it is never noted.

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv, seedStateFile } from "../harness/fixtures.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000f1c4";

function env(proj: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
    ...extra,
  };
  delete out.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete out.AIDLC_SESSION_OVERRIDE_SOURCE;
  return out;
}

function run(proj: string, tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: env(proj, extra),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function hook(proj: string, payload: Record<string, unknown>): void {
  const r = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ session_id: SESSION, ...payload }),
    env: env(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, r.stderr).toBe(0);
}

// The person picks in the harness's picker: one question, or several.
function picks(proj: string, answers: Record<string, string>): void {
  const questions = Object.keys(answers).map((question) => ({
    question,
    options: [{ label: answers[question] }, { label: "Something else" }],
  }));
  hook(proj, {
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions },
    tool_response: { questions, answers },
  });
}

const says = (proj: string, prompt: string) => hook(proj, { hook_event_name: "UserPromptSubmit", prompt });
const answered = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "QUESTION_ANSWERED");

describe("an answer no picker carried is noted, never refused", () => {
  let proj: string;
  let slug: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    slug = run(proj, STATE, ["get", "Current Stage"], { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" }).out.trim();
  });
  afterEach(() => cleanupTestProject(proj));

  const ask = (decision: string, options: string) =>
    expect(run(proj, LOG, ["decision", "--stage", slug, "--decision", decision, "--options", options]).rc).toBe(0);

  // From a live run: the answering-mode question was logged, the picker showed
  // another question, and the record said the person chose "Guide me".
  test("an answer the picker did not carry is recorded with a note naming what they picked", () => {
    ask("How would you like to answer the questions?", "Guide me,I'll edit the file,Chat");
    picks(proj, { "How should the release be described?": "Lightweight release note" });
    const r = run(proj, LOG, ["answer", "--stage", slug, "--details", "Guide me"]);
    expect(r.rc, r.out).toBe(0);
    const rows = answered(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Details")).toBe("Guide me");
    expect(auditBlockField(rows[0].block, "Picker Note")).toBe(
      'Not what the person picked in the picker ("Lightweight release note").',
    );
  });

  test("an answer the person picked carries no note, also when one picker asked several questions", () => {
    ask("Which database?", "Postgres,SQLite");
    ask("Which runtime?", "Bun,Node");
    picks(proj, { "Which database?": "Postgres", "Which runtime?": "Bun" });
    expect(run(proj, LOG, ["answer", "--stage", slug, "--details", "Postgres"]).rc).toBe(0);
    expect(run(proj, LOG, ["answer", "--stage", slug, "--details", "Bun (Recommended)"]).rc).toBe(0);
    const rows = answered(proj);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(auditBlockField(row.block, "Picker Note")).toBeNull();
  });

  test("a typed reply has no picks to compare, so its answer is never noted", () => {
    ask("Which database?", "Postgres,SQLite");
    says(proj, "the second one please");
    expect(run(proj, LOG, ["answer", "--stage", slug, "--details", "SQLite"]).rc).toBe(0);
    expect(auditBlockField(answered(proj)[0].block, "Picker Note")).toBeNull();
  });
});
