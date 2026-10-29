// covers: function:askedQuestionFields, function:noteQuestionRow, function:turnQuestionFields, function:boxQuestionId
// covers: function:questionEntryDigests, function:recordQuestionStep, function:planApprovalQuestionId
// covers: audit:QUESTION_ASKED, audit:QUESTION_SHOWN, audit:STAGE_AWAITING_APPROVAL, audit:DECISION_RECORDED, audit:HUMAN_TURN
// covers: hook:aidlc-record-human-turn, subcommand:aidlc-orchestrate:report, subcommand:aidlc-log:decision
// covers: subcommand:aidlc-bolt:checkpoint
//
// Every question AI-DLC asks is recorded with its own id, so a later record of
// the person's answer can name the question it answers (Move 1, S1; Arden's D1
// and D2). Nothing decides on any of it yet, and nothing new reaches the
// person's screen. Each kind of ask writes exactly one id, with its type, the
// chat it was asked in and what it shows, and the step that asks hands the
// agent that id: the gate, every question the agent logs, the verification
// command and a Unit checkpoint, an engine question (QUESTION_ASKED) and the
// code plan question. Shown again in a chat that had not seen it, the same
// question writes one QUESTION_SHOWN, and a clone finds it under the same id.
// Each turn of the person's carries the ids open in their chat (a turn in
// another chat does not, an answered gate leaves), and the digest of each
// entry of the stage's questions file, which an answer written in and Windows
// line endings leave unchanged. A question box's answer names the question it
// answered by its id.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { activeDirectiveStorageDir, sessionsDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, resetAidlcEnv, seededRecordDir } from "../harness/fixtures.ts";
import {
  A, B, BUN, C, D, built, codeGeneration, engine, field, inception, lastTurn, openIn, reviewedStage, rows, say, shellQuote,
  STAGE, staffing, step, tool,
} from "../harness/question-record.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const ID = /^[0-9a-f]{8}$/;
const SHOWS = /^sha256:[0-9a-f]{64}$/;

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

// --- The gate ---

describe("the gate", () => {
  test("its row carries its id, type, chat and what it shows, and the reply hands the agent the same id", () => {
    const proj = inception(projects);
    reviewedStage(proj);
    const reply = step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    const [gate] = rows(proj, "STAGE_AWAITING_APPROVAL");
    expect(field(gate, "Question Id")).toMatch(ID);
    expect(field(gate, "Question Type")).toBe("gate");
    expect(field(gate, "Question Chat")).toBe(A);
    expect(field(gate, "Question Shows")).toMatch(SHOWS);
    expect(reply.kind).toBe("print");
    expect(reply.question_id).toBe(field(gate, "Question Id"));
    expect(rows(proj, "QUESTION_SHOWN")).toEqual([]);
  });

  test("shown again in a chat that had not seen it, it writes one QUESTION_SHOWN, and none in a chat that had", () => {
    const proj = inception(projects);
    reviewedStage(proj);
    step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    const id = field(rows(proj, "STAGE_AWAITING_APPROVAL")[0], "Question Id");
    expect(step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]).question_id).toBe(id);
    expect(rows(proj, "QUESTION_SHOWN")).toEqual([]);
    expect(step(proj, B, ["report", "--stage", STAGE, "--result", "awaiting-approval"]).question_id).toBe(id);
    step(proj, B, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => [field(row, "Question Id"), field(row, "Question Chat")]))
      .toEqual([[id, B]]);
    // A new chat's `next` shows the open gate again under the same id.
    say(proj, C, "/aidlc");
    const again = step(proj, C, ["next"]);
    expect(again.gate_only, JSON.stringify(again)).toBe(true);
    expect(again.question_id).toBe(id);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => field(row, "Question Chat"))).toEqual([B, C]);
    expect(rows(proj, "STAGE_AWAITING_APPROVAL")).toHaveLength(1);
  });

  test("a turn in a chat it was shown in carries its id, a turn elsewhere does not, and once answered it leaves", () => {
    const proj = inception(projects);
    reviewedStage(proj);
    step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    const id = field(rows(proj, "STAGE_AWAITING_APPROVAL")[0], "Question Id")!;
    say(proj, A, "looks good");
    expect(openIn(proj)).toContain(id);
    say(proj, D, "what is this?");
    expect(openIn(proj)).not.toContain(id);
    appendAuditEntry("GATE_APPROVED", { Stage: STAGE, "User Input": "Approve" }, proj);
    say(proj, A, "thanks");
    expect(openIn(proj)).not.toContain(id);
  });
});

// --- The questions the agent logs ---

describe("a question the agent logs", () => {
  test("each kind writes one id with its type and chat, and the command prints it", () => {
    const proj = inception(projects);
    const kinds: Array<[string[], string]> = [
      [[], "stage-question"],
      [["--question-kind", "answer-mode"], "answer-mode"],
      [["--question-kind", "learnings-note"], "learnings-note"],
    ];
    for (const [extra, type] of kinds) {
      const printed = tool(proj, A, "log", ["decision", "--stage", STAGE, "--decision", `Which ${type}?`,
        "--options", "One,Two", ...extra]);
      const row = rows(proj, "DECISION_RECORDED").at(-1);
      expect(field(row, "Question Id")).toMatch(ID);
      expect(printed.question_id).toBe(field(row, "Question Id"));
      expect(field(row, "Question Type")).toBe(type);
      expect(field(row, "Question Chat")).toBe(A);
      expect(field(row, "Question Shows")).toMatch(SHOWS);
    }
    const ids = rows(proj, "DECISION_RECORDED").map((row) => field(row, "Question Id"));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a question box's answer names the question it answered by its id", () => {
    const proj = inception(projects);
    tool(proj, A, "log", ["decision", "--stage", STAGE, "--decision", "Which database?", "--options", "Postgres,SQLite"]);
    const id = field(rows(proj, "DECISION_RECORDED").at(-1), "Question Id");
    expect(id).toMatch(ID);
    engine(proj, null, ["engine", "hook", "record-human-turn"], JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: A,
      tool_input: { questions: [
        { question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
        { question: "Anything else?", options: [{ label: "No" }, { label: "Yes" }] },
      ] },
      tool_response: { answers: { "Which database?": "Postgres", "Anything else?": "No" } },
    }));
    const replied = rows(proj, "QUESTION_REPLIED");
    expect(replied.map((row) => [field(row, "Question"), field(row, "Question Id")])).toEqual([
      ["Which database?", id], ["Anything else?", null],
    ]);
  });
});

// --- The verification command and a Unit checkpoint ---

describe("a checkpoint question", () => {
  test("the verification command and a Unit checkpoint each write one id in the chat that asked, and print it", () => {
    const p = built(projects);
    const script = join(seededRecordDir(p), "check.cjs");
    writeFileSync(script, "process.exit(0);");
    const command = `${shellQuote(BUN)} ${shellQuote(script)}`;
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", B];
    const asked = tool(p, null, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?",
      "--options", "Approve,Request Changes"]);
    const verification = rows(p, "DECISION_RECORDED").at(-1);
    expect(field(verification, "Question Type")).toBe("verification-command");
    expect(field(verification, "Question Chat")).toBe(B);
    expect(asked.question_id).toBe(field(verification, "Question Id"));
    say(p, B, "Approve");
    tool(p, null, "log", ["answer", ...identity, "--details", "Approve"]);
    tool(p, null, "state", ["set-construction-verification-command", command]);
    tool(p, null, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "verify"]);
    const checkpoint = tool(p, null, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "ask", "--session", A]);
    const row = rows(p, "DECISION_RECORDED").at(-1);
    expect(field(row, "Checkpoint")).toBe("Construction Unit Approval");
    expect(field(row, "Question Type")).toBe("unit-checkpoint");
    expect(field(row, "Question Chat")).toBe(A);
    expect(field(row, "Question Shows")).toMatch(SHOWS);
    expect(checkpoint.question_id).toBe(field(row, "Question Id"));
    say(p, A, "let me look");
    expect(openIn(p)).toContain(field(row, "Question Id") ?? "none");
  });
});

// --- An engine question ---

describe("an engine question", () => {
  test("is recorded once when it is handed out, shown again in a new chat, and found again in a clone", () => {
    const proj = staffing(projects);
    const ask = step(proj, A, ["next"]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("construction-staffing");
    const [asked] = rows(proj, "QUESTION_ASKED");
    expect(field(asked, "Question Id")).toMatch(ID);
    expect(ask.question_id).toBe(field(asked, "Question Id"));
    expect(field(asked, "Question Type")).toBe("construction-staffing");
    expect(field(asked, "Question Chat")).toBe(A);
    expect(field(asked, "Question Shows")).toMatch(SHOWS);
    expect(field(asked, "Stage")).toBe("functional-design");
    expect(step(proj, A, ["next"]).question_id).toBe(ask.question_id);
    expect(rows(proj, "QUESTION_ASKED")).toHaveLength(1);
    expect(rows(proj, "QUESTION_SHOWN")).toEqual([]);
    expect(step(proj, B, ["next"]).question_id).toBe(ask.question_id);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => field(row, "Question Chat"))).toEqual([B]);
    say(proj, B, "just me I think");
    expect(openIn(proj)).toEqual([ask.question_id as string]);
    // A teammate's clone keeps no runtime record of its own: the committed
    // record names the question, and it is shown there under the same id.
    for (const runtime of [join(sessionsDir(proj), "plan-approval"), activeDirectiveStorageDir(proj)]) {
      rmSync(runtime, { recursive: true, force: true });
    }
    expect(step(proj, C, ["next"]).question_id).toBe(ask.question_id);
    expect(rows(proj, "QUESTION_ASKED")).toHaveLength(1);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => field(row, "Question Chat"))).toEqual([B, C]);
  });
});

// --- The code plan question ---

describe("the code plan question", () => {
  test("goes on the record with its id beside the ask's own, and is shown again in a new chat under it", () => {
    const proj = codeGeneration(projects);
    const ask = step(proj, A, ["next"]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("plan-approval");
    const [asked] = rows(proj, "QUESTION_ASKED");
    expect(field(asked, "Question Type")).toBe("plan-approval");
    expect(field(asked, "Question Id")).toMatch(ID);
    expect(ask.question_id).toBe(field(asked, "Question Id"));
    expect(field(asked, "Ask Id")).toMatch(/^[0-9a-f]{32}$/);
    expect(field(asked, "Question Chat")).toBe(A);
    expect(step(proj, A, ["next"]).question_id).toBe(ask.question_id);
    expect(step(proj, B, ["next"]).question_id).toBe(ask.question_id);
    expect(rows(proj, "QUESTION_ASKED")).toHaveLength(1);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => field(row, "Question Chat"))).toEqual([B]);
  });
});

// --- The questions file, as each turn sees it ---

const QUESTIONS = [
  "# Requirements Analysis Questions", "",
  "## Q1. [Product] Who uses it?", "", "A. Staff", "B. Customers", "X. Other (please specify)", "", "[Answer]:", "",
  "## Q2. [Product] How often?", "", "A. Daily", "B. Weekly", "X. Other (please specify)", "", "[Answer]:", "",
].join("\n");

describe("the questions file", () => {
  // Read where it is used, so a build without it fails here alone.
  const digests = async (): Promise<(content: string) => Record<string, string>> =>
    (await import("../../dist/claude/.claude/tools/aidlc-questions.ts")).questionEntryDigests;

  test("each entry's digest ignores an answer written in and Windows line endings; an edit changes only its own", async () => {
    const questionEntryDigests = await digests();
    const before = questionEntryDigests(QUESTIONS);
    expect(Object.keys(before)).toEqual(["Q1", "Q2"]);
    expect(questionEntryDigests(QUESTIONS.replace("[Answer]:\n\n## Q2", "[Answer]: A\n\n## Q2"))).toEqual(before);
    expect(questionEntryDigests(QUESTIONS.replaceAll("\n", "\r\n"))).toEqual(before);
    const edited = questionEntryDigests(QUESTIONS.replace("How often?", "How often, and when?"));
    expect(edited.Q1).toBe(before.Q1);
    expect(edited.Q2).not.toBe(before.Q2);
  });

  test("a summary shown again in a new chat names its file, so the reply there carries the digest", async () => {
    const questionEntryDigests = await digests();
    const proj = inception(projects);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
    const file = join(seededRecordDir(proj), "inception", STAGE, `${STAGE}-questions.md`);
    mkdirSync(join(file, ".."), { recursive: true });
    const summary = `${QUESTIONS.replaceAll("[Answer]:", "[Answer]: A")}\n## Consolidated Summary Confirmation\n\n` +
      "- Staff use it daily.\n\nLooks correct\nRequest changes\n\n[Answer]:\n";
    writeFileSync(file, summary);
    const relative = file.slice(proj.length + 1).replaceAll("\\", "/");
    tool(proj, A, "log", ["decision", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", relative,
      "--decision", "Does this summary look correct?", "--options", "Looks correct,Request changes"]);
    const id = field(rows(proj, "DECISION_RECORDED").at(-1), "Question Id");
    expect(field(rows(proj, "DECISION_RECORDED").at(-1), "Question Type")).toBe("summary-confirmation");
    say(proj, B, "/aidlc --resume");
    const again = step(proj, B, ["next", "--resume"]);
    expect(again.question_id, String(again.message ?? again.kind)).toBe(id);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => [field(row, "Question Chat"), field(row, "Questions File")]))
      .toEqual([[B, relative]]);
    say(proj, B, "looks right");
    const stamped = JSON.parse(field(lastTurn(proj), "Questions Digest") ?? "{}") as { file?: string; entries?: Record<string, string> };
    expect(stamped.file).toBe(relative);
    expect(stamped.entries).toEqual(questionEntryDigests(summary));
    expect(openIn(proj)).toContain(id ?? "none");
  });

  test("a turn carries the digest of each question in the stage's file the engine handed out", async () => {
    const questionEntryDigests = await digests();
    const proj = inception(projects);
    const run = step(proj, A, ["next"]);
    expect(run.kind, JSON.stringify(run)).toBe("run-stage");
    const file = join(seededRecordDir(proj), "inception", STAGE, `${STAGE}-questions.md`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, QUESTIONS);
    say(proj, A, "staff, daily");
    const stamped = JSON.parse(field(lastTurn(proj), "Questions Digest") ?? "{}") as {
      file?: string; entries?: Record<string, string>;
    };
    expect(stamped.file).toBe(`${seededRecordDir(proj).slice(proj.length + 1).replaceAll("\\", "/")}/inception/${STAGE}/${STAGE}-questions.md`);
    expect(stamped.entries).toEqual(questionEntryDigests(QUESTIONS));
    writeFileSync(file, QUESTIONS.replace("[Answer]:\n\n## Q2", "[Answer]: A\n\n## Q2").replaceAll("\n", "\r\n"));
    say(proj, A, "and weekly");
    expect(JSON.parse(field(lastTurn(proj), "Questions Digest") ?? "{}").entries).toEqual(stamped.entries);
  });
});
