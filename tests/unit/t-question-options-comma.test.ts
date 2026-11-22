// covers: function:optionsList, function:openQuestionAgainDirective, function:openQuestionReplyDirective
// covers: subcommand:aidlc-log:decision, subcommand:aidlc-log:answers, function:isLearningsNoteDecision
//
// A choice may hold a comma ("Refuse it, with a message"). A question logged
// with its choices in the pipe form (the list starts with `|` and separates
// them with it) comes back whole when a new chat shows it
// again, and `log answers` lists it whole, so a pick by number lands on the
// choice the person saw. A list written with commas, as every list was before,
// reads as it always did, and a `|` inside one of its choices ("Use string |
// null") is part of that choice. The one splitter (optionsList) is the grammar every
// reader of the Options field and of `--options` shares.
//
// Mechanism: function - `log decision`, the session-start hook, the human-turn
// hook and `next` on a seeded project; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  isAnswerModeDecision,
  isLearningsNoteDecision,
  optionsList,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { env, exec, LOG, next, say } from "../harness/aidlc-input-corpus.ts";
import { cleanupTestProject, FIXTURES_DIR, seededRecordDir, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "requirements-analysis";
const OTHER_CHAT = "01995000-7a11-7000-8000-00000000e069";
const QUESTION = "What should a blank title do?";

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

// Requirements Analysis running, its questions file answered, and the agent's
// own question logged with `options` as it passed them.
async function asked(options: string): Promise<string> {
  const proj = setupIntegrationProject();
  projects.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${STAGE}-questions.md`), "# Questions\n\n## Q1\n\nShould a blank title be refused?\n\n[Answer]: Yes\n", "utf-8");
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  const logged = await exec([process.execPath, LOG, "decision", "--stage", STAGE, "--decision", QUESTION,
    "--options", options, "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(logged.status, logged.stderr).toBe(0);
  return proj;
}

// A new chat on the project, as Claude Code opens one.
async function newChat(proj: string): Promise<void> {
  const opened = await exec([process.execPath, join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "session-start"], {
    cwd: proj, env: { ...env(proj, { session: OTHER_CHAT }), CLAUDE_PROJECT_DIR: proj },
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: OTHER_CHAT, source: "startup", cwd: proj }),
  });
  expect(opened.status, opened.stderr).toBe(0);
}

describe("t-question-options-comma: a choice that holds a comma comes back whole", () => {
  test("a bare /aidlc in a new chat shows the question again with its two choices whole", async () => {
    const proj = await asked("|Refuse it, with a message|Save it as Untitled");
    await newChat(proj);
    await say(proj, "/aidlc", "claude", { session: OTHER_CHAT });
    const again = String((await next(proj, [], { session: OTHER_CHAT })).directive?.message ?? "");
    expect(again).toContain(`${JSON.stringify(QUESTION)}, with the choices "Refuse it, with a message", "Save it as Untitled".`);
    expect(again).not.toContain('"with a message"');
  });

  test("/aidlc 2 in that chat is read against the same two choices", async () => {
    const proj = await asked("|Refuse it, with a message|Save it as Untitled");
    await newChat(proj);
    await say(proj, "/aidlc 2", "claude", { session: OTHER_CHAT });
    const reply = String((await next(proj, ["2"], { session: OTHER_CHAT })).directive?.message ?? "");
    expect(reply).toContain('with the choices "Refuse it, with a message", "Save it as Untitled"');
  });

  test("log answers lists the two choices whole", async () => {
    const proj = await asked("|Refuse it, with a message|Save it as Untitled");
    const listed = await exec([process.execPath, LOG, "answers", "--stage", STAGE, "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(JSON.stringify(["Refuse it, with a message", "Save it as Untitled"]));
  });

  test("a choice that holds a pipe, in a list written with commas, comes back whole", async () => {
    const proj = await asked("Use string | null,Use an optional field");
    await newChat(proj);
    await say(proj, "/aidlc", "claude", { session: OTHER_CHAT });
    const again = String((await next(proj, [], { session: OTHER_CHAT })).directive?.message ?? "");
    expect(again).toContain('with the choices "Use string | null", "Use an optional field".');
  });

  test("a list written with commas reads as before", async () => {
    const proj = await asked("Guide me,I'll edit the file,Chat");
    await newChat(proj);
    await say(proj, "/aidlc", "claude", { session: OTHER_CHAT });
    const again = String((await next(proj, [], { session: OTHER_CHAT })).directive?.message ?? "");
    expect(again).toContain('with the choices "Guide me", "I\'ll edit the file", "Chat".');
  });
});

describe("t-question-options-comma: one splitter for every reader", () => {
  test("optionsList splits a list that starts with | on |, any other on commas, and keeps empty pieces", () => {
    expect(optionsList("|Refuse it, with a message|Save it as Untitled")).toEqual(["Refuse it, with a message", "Save it as Untitled"]);
    expect(optionsList(" | Approve | Request Changes ")).toEqual(["Approve", "Request Changes"]);
    expect(optionsList("Approve,Request Changes")).toEqual(["Approve", "Request Changes"]);
    expect(optionsList("Use string | null,Use an optional field")).toEqual(["Use string | null", "Use an optional field"]);
    expect(optionsList("A,,B")).toEqual(["A", "", "B"]);
    expect(optionsList(null)).toEqual([""]);
  });

  test("the learnings and answer-mode questions are known by their choices in either form", () => {
    const row = (options: string) => `## Decision\n**Event**: DECISION_RECORDED\n**Stage**: ${STAGE}\n**Options**: ${options}\n`;
    expect(isLearningsNoteDecision(row("|Nothing to add|Add a note"))).toBe(true);
    expect(isLearningsNoteDecision(row("Nothing to add,Add a note"))).toBe(true);
    expect(isAnswerModeDecision(row("|Guide me|I'll edit the file|Chat"))).toBe(true);
    expect(isAnswerModeDecision(row("Guide me,I'll edit the file,Chat"))).toBe(true);
  });
});
