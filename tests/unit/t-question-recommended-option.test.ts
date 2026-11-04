// covers: subcommand:aidlc-log:decision, subcommand:aidlc-log:answers, audit:DECISION_RECORDED, audit:QUESTION_REPLIED
// covers: function:recommendedChoices, hook:aidlc-record-human-turn
//
// A question records which of its choices the agent recommended, beside its
// choices and the answer, so a report can say whether the person followed it.
// The recommendation is the one "(Recommended)" mark at the end of a label, the
// mark the gates already strip: `log decision` keeps it as `Recommended` when
// the labels it was given carry it, and the human-turn hook keeps it on a
// question box's `QUESTION_REPLIED` from the labels the box showed (Claude
// Code's AskUserQuestion, Codex's request_user_input). The agent writes nothing
// twice. A question with no mark is recorded exactly as before, and `log
// answers` reads an old record exactly as it did: only a row that carries the
// field lists `recommended`.
//
// Mechanism: function - `log decision`, `log answers` and the human-turn hook
// (Claude Code's envelope, and Codex's through its adapter) on a seeded
// project; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  optionsList,
  readAuditShardEvents,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { env, exec, LOG, SESSION } from "../harness/aidlc-input-corpus.ts";
import {
  AIDLC_SRC, cleanupTestProject, FIXTURES_DIR, REPO_ROOT, seededRecordDir, seededStateFile, setupIntegrationProject,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "requirements-analysis";
const QUESTION = "How should letters outside A-Z be lowercased?";
const LABELS = ["toLowerCase() (Recommended)", "toLocaleLowerCase() default", "toLocaleLowerCase(lang)"];

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

// Requirements Analysis running, as a person meets it after the answer mode.
function requirements(): string {
  const proj = setupIntegrationProject();
  projects.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  return proj;
}

async function log(proj: string, args: string[]): Promise<string> {
  const run = await exec([process.execPath, LOG, ...args, "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

const decision = (proj: string, choices: string[]) =>
  log(proj, ["decision", "--stage", STAGE, "--decision", QUESTION, ...choices]);

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const latest = (proj: string, event: string) => rows(proj, event).at(-1)!;
const field = (proj: string, event: string, name: string) => auditBlockField(latest(proj, event).block, name);

// The person types a reply, through the prompt hook.
async function says(proj: string, prompt: string): Promise<void> {
  const run = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj, env: env(proj),
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }),
  });
  expect(run.status, run.stderr).toBe(0);
}

// The person picks in Claude Code's question box.
async function claudeBox(proj: string, labels: string[], answer: string, multiSelect = false): Promise<void> {
  const questions = [{ question: QUESTION, header: "Lowercase", multiSelect, options: labels.map((label) => ({ label, description: "" })) }];
  const run = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj, env: env(proj),
    input: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: SESSION, cwd: proj,
      tool_input: { questions }, tool_response: { questions, answers: { [QUESTION]: answer } },
    }),
  });
  expect(run.status, run.stderr).toBe(0);
}

// The person picks in Codex's question box, through the Codex adapter.
async function codexBox(proj: string, labels: string[], answer: string): Promise<void> {
  const codexTree = join(proj, ".codex");
  if (!existsSync(codexTree)) cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), codexTree, { recursive: true });
  writeSessionPidEntry(proj, process.pid, SESSION);
  const input = {
    hook_event_name: "PostToolUse", tool_name: "request_user_input", session_id: SESSION, turn_id: "t1", cwd: proj,
    tool_input: { questions: [{ id: "q1", header: "Lowercase", question: QUESTION, options: labels.map((label) => ({ label, description: "" })) }] },
    tool_response: JSON.stringify({ answers: { q1: { answers: [answer] } } }),
  };
  const unset = { ...env(proj), CLAUDE_PROJECT_DIR: undefined, USER_PROMPT: undefined, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined };
  const run = await exec([process.execPath, join(codexTree, "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], {
    cwd: proj, env: unset, input: JSON.stringify(input),
  });
  expect(run.status, run.stderr).toBe(0);
}

// A row as the record keeps it, its timestamp and new id masked.
const masked = (block: string) =>
  block.replace(/^\*\*Timestamp\*\*: .*$/m, "**Timestamp**: <T>").replace(/^\*\*Question Id\*\*: .*$/m, "**Question Id**: <ID>");

describe("t-question-recommended-option: log decision keeps the choice the agent marked", () => {
  test("a question with one marked choice records it beside its choices, which stay as given", async () => {
    const proj = requirements();
    await decision(proj, ["--options", LABELS.join(",")]);
    expect(field(proj, "DECISION_RECORDED", "Options")).toBe(LABELS.join(","));
    expect(field(proj, "DECISION_RECORDED", "Recommended")).toBe("toLowerCase()");
  });

  test("a batch's marks are kept question by question, whole, in the list's own form", async () => {
    const proj = requirements();
    await decision(proj, [
      "--option", "Q1: Trim the name (Recommended)", "--option", "Q1: Keep it as given",
      "--option", "Q2: Refuse it, with a message (recommended)", "--option", "Q2: Save it as Untitled",
    ]);
    const recommended = field(proj, "DECISION_RECORDED", "Recommended");
    expect(recommended).toBe("|Q1: Trim the name|Q2: Refuse it, with a message");
    expect(optionsList(recommended)).toEqual(["Q1: Trim the name", "Q2: Refuse it, with a message"]);
  });

  test("choices passed in a file, Windows line endings and all, keep their mark the same way", async () => {
    const proj = requirements();
    const dir = join(seededRecordDir(proj), ".aidlc-engine", "answer-text");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "options.txt"), `${LABELS.join("\r\n")}\r\n`, "utf-8");
    await decision(proj, ["--options-file", ".aidlc-engine/answer-text/options.txt"]);
    expect(field(proj, "DECISION_RECORDED", "Recommended")).toBe("toLowerCase()");
  });

  test("a mark that is not at the end of its label, or a label that is only the mark, names no choice", async () => {
    const proj = requirements();
    await decision(proj, ["--options", "(Recommended) toLowerCase(),toLocaleLowerCase() default"]);
    expect(field(proj, "DECISION_RECORDED", "Recommended")).toBeNull();
    await decision(proj, ["--options", "(Recommended),toLocaleLowerCase() default"]);
    expect(field(proj, "DECISION_RECORDED", "Recommended")).toBeNull();
    expect(field(proj, "DECISION_RECORDED", "Options")).toBe("(Recommended),toLocaleLowerCase() default");
  });

  test("a question with no mark is recorded exactly as before", async () => {
    const proj = requirements();
    await decision(proj, ["--options", "toLowerCase(),toLocaleLowerCase() default"]);
    expect(masked(latest(proj, "DECISION_RECORDED").block)).toBe(masked(TODAYS_UNMARKED_ROW));
  });
});

describe("t-question-recommended-option: a question box keeps the choice it showed as recommended", () => {
  test("Claude Code: the reply row names the marked choice beside the box's choices and the pick", async () => {
    const proj = requirements();
    await claudeBox(proj, LABELS, LABELS[1]);
    expect(field(proj, "QUESTION_REPLIED", "Options")).toBe(JSON.stringify(LABELS));
    expect(field(proj, "QUESTION_REPLIED", "Reply")).toBe(LABELS[1]);
    expect(field(proj, "QUESTION_REPLIED", "Recommended")).toBe(JSON.stringify(["toLowerCase()"]));
  });

  test("Claude Code: a box that lets the person pick several keeps every marked choice", async () => {
    const proj = requirements();
    const labels = ["Unit tests (Recommended)", "Integration tests (Recommended)", "Load tests"];
    await claudeBox(proj, labels, "Unit tests (Recommended), Load tests", true);
    expect(field(proj, "QUESTION_REPLIED", "Recommended")).toBe(JSON.stringify(["Unit tests", "Integration tests"]));
  });

  test("Codex: the reply row names the marked choice", async () => {
    const proj = requirements();
    await codexBox(proj, LABELS, LABELS[0]);
    expect(field(proj, "QUESTION_REPLIED", "Reply")).toBe(LABELS[0]);
    expect(field(proj, "QUESTION_REPLIED", "Recommended")).toBe(JSON.stringify(["toLowerCase()"]));
  });

  test("a box with no marked choice is recorded as before, with no recommendation", async () => {
    const proj = requirements();
    await claudeBox(proj, ["toLowerCase()", "toLocaleLowerCase() default"], "toLowerCase()");
    const block = latest(proj, "QUESTION_REPLIED").block;
    expect(block).not.toContain("**Recommended**");
    expect(auditBlockField(block, "Options")).toBe(JSON.stringify(["toLowerCase()", "toLocaleLowerCase() default"]));
  });
});

describe("t-question-recommended-option: log answers lists the recommendation, and reads an old record as before", () => {
  const answers = async (proj: string) =>
    JSON.parse((await log(proj, ["answers", "--stage", STAGE])).trim()) as { answered: Array<Record<string, unknown>> };

  test("an answered question with a marked choice lists it beside its choices and the answer", async () => {
    const proj = requirements();
    await decision(proj, ["--options", LABELS.join(",")]);
    await says(proj, "the second one");
    await log(proj, ["answer", "--stage", STAGE, "--details", "toLocaleLowerCase() default"]);
    const [entry] = (await answers(proj)).answered;
    expect(entry.options).toEqual(LABELS);
    expect(entry.recommended).toEqual(["toLowerCase()"]);
    expect(entry.answer).toBe("toLocaleLowerCase() default");
  });

  // An earlier release wrote the row, a mark in its choices and no field: it
  // reads exactly as it did, nothing worked out from the labels.
  test("an old record lists exactly what it listed before", async () => {
    const proj = requirements();
    appendAuditEntry("DECISION_RECORDED", { Stage: STAGE, Decision: QUESTION, Options: LABELS.join(",") }, proj);
    appendAuditEntry("QUESTION_ANSWERED", { Stage: STAGE, Details: "toLowerCase()" }, proj);
    const asked = latest(proj, "DECISION_RECORDED").timestamp;
    const answered = latest(proj, "QUESTION_ANSWERED").timestamp;
    expect((await answers(proj)).answered).toEqual([
      { question: QUESTION, options: LABELS, askedAt: asked, answer: "toLowerCase()", answeredAt: answered },
    ]);
  });
});

// The row `log decision` wrote for an unmarked question before this change,
// read from origin/main 17c123ca7663 (timestamp and question id masked).
const TODAYS_UNMARKED_ROW = [
  "",
  "## Decision Recorded",
  "**Timestamp**: <T>",
  "**Event**: DECISION_RECORDED",
  `**Stage**: ${STAGE}`,
  `**Decision**: ${QUESTION}`,
  "**Options**: toLowerCase(),toLocaleLowerCase() default",
  "**Question Id**: <ID>",
  "**Question Type**: stage-question",
  `**Question Chat**: ${SESSION}`,
  "**Question Shows**: sha256:c50a539b072f0e845ef1313ea41f46c67c2267fc9e0aa25de2bdc7d231992b31",
  "",
].join("\n");
