// `log answer --on-instruction '<words>'` records a choice the person left to
// the agent, with the words that handed it over. The words have to be the
// person's: they are kept only when something the person said holds them (a
// message the human-turn hook kept, a question box's reply, the request that
// started the work), whatever the case, spacing or punctuation of the quote.
// In a live run on Claude Code the agent added three questions after a
// Request Changes pick, answered them itself and recorded its own summary as
// the person's instruction; the record said they left those answers to it.
// Where the record lacks some of the person's words (a host that passed none,
// a record gone with the day, no hook at all), no quote can be proved not
// theirs, and the choice is recorded as before.
// covers: cli:aidlc-log(answer), function:handleAnswer, function:holdsQuote, function:personsSaidWords
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { holdsQuote, MESSAGE_TEXT_MAX_CHARS, readMessage, saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { cleanupTestProject, createTestProject, seededRecordDir, seedStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const LOG = join(TOOLS, "aidlc-log.ts");
const STAGE = "feasibility";
const CHAT = "t-on-instruction-words";

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function project(): string {
  const p = createTestProject();
  projects.push(p);
  seedStateFile(p, "state-mid-ideation.md");
  return p;
}

function run(p: string, args: string[], input?: string): { status: number; out: string } {
  const r = spawnSync(BUN, args, {
    cwd: p,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...process.env, CLAUDE_PROJECT_DIR: p, AIDLC_PROJECT_DIR: p },
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const log = (p: string, args: string[]) => run(p, [LOG, ...args, "--project-dir", p]);
const hook = (p: string, payload: object) => {
  const r = run(p, [join(TOOLS, "aidlc.ts"), "engine", "hook", "record-human-turn"], JSON.stringify(payload));
  expect(r.status, r.out).toBe(0);
};

// The person types `prompt` in Claude Code: the shipped human-turn hook keeps it.
const typed = (p: string, prompt: string) => hook(p, { hook_event_name: "UserPromptSubmit", session_id: CHAT, prompt });

// The person answers a Claude Code question box the agent asked.
const picked = (p: string, question: string, answer: string) => hook(p, {
  hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: CHAT,
  tool_input: { questions: [{ question, options: [{ label: "Let you decide" }, { label: "I will answer them" }] }] },
  tool_response: { answers: { [question]: answer } },
});

const leftToAgent = (p: string, quote: string) =>
  log(p, ["answer", "--stage", STAGE, "--details", "Q5: A; Q6: A; Q7: A", "--on-instruction", quote]);

function askQuestions(p: string): void {
  expect(log(p, ["decision", "--stage", STAGE, "--decision", "Q5-Q7", "--options", "A,B,C"]).status).toBe(0);
}

function answers(p: string) {
  return readAuditShardEvents(p).filter((row) => row.event === "QUESTION_ANSWERED");
}

function fieldOf(row: { block: string }, name: string): string | null {
  return row.block.match(new RegExp(`^\\*\\*${name}\\*\\*: (.*)$`, "m"))?.[1] ?? null;
}

function refused(r: { status: number; out: string }): void {
  expect(r.status).not.toBe(0);
  // The refusal names the step: their own words, or the questions shown and a wait.
  expect(r.out).toContain("Quote their own words that left it to you");
  expect(r.out).toContain("show them the questions and end your turn");
}

describe("t-on-instruction-words: a choice left to the agent quotes words the person said", () => {
  test("the agent's own words are not recorded as the person's instruction", () => {
    const p = project();
    typed(p, "Build a local CLI that converts CSV to JSON, and approve each gate.");
    askQuestions(p);
    refused(leftToAgent(p, "Grounded from the user request (approve each gate); confirm at summary."));
    expect(answers(p)).toHaveLength(0);
  });

  test("their words copied exactly are recorded", () => {
    const p = project();
    typed(p, "Q1 is B. Choose the recommended answers for the rest.");
    askQuestions(p);
    const r = leftToAgent(p, "Choose the recommended answers for the rest.");
    expect(r.status, r.out).toBe(0);
    expect(fieldOf(answers(p)[0], "Answer Source")).toBe("chosen by the agent as the person asked");
    expect(fieldOf(answers(p)[0], "Instruction")).toBe("Choose the recommended answers for the rest.");
  });

  test("a quote that differs only in case, spacing or punctuation is their words", () => {
    const p = project();
    // A typographic apostrophe and dash, as a phone or a Mac keyboard types them.
    typed(p, "Honestly \u2014 it\u2019s up to you,\r\n   pick whatever\u2019s best!");
    askQuestions(p);
    for (const quote of ["it's up to you, pick whatever's best", "UP TO YOU pick whatevers best", "up to you."]) {
      const r = leftToAgent(p, quote);
      expect(r.status, `${quote}: ${r.out}`).toBe(0);
    }
    expect(answers(p)).toHaveLength(3);
    // Words cut from the middle are not a quote.
    refused(leftToAgent(p, "honestly pick whatever's best"));
  });

  test("a script written without spaces between words is matched as written", () => {
    const p = project();
    typed(p, "\u8cea\u554f\u306f\u304a\u4efb\u305b\u3057\u307e\u3059\u3002");
    askQuestions(p);
    const r = leftToAgent(p, "\u304a\u4efb\u305b\u3057\u307e\u3059");
    expect(r.status, r.out).toBe(0);
  });

  test("the same letters inside other words they said are not a quote", () => {
    const p = project();
    typed(p, "Scale it up to your expected load, and let me look at it first.");
    askQuestions(p);
    refused(leftToAgent(p, "up to you"));
    refused(leftToAgent(p, "ok"));
    expect(answers(p)).toHaveLength(0);
  });

  // A word's edge is a space or either end; in a script written without spaces,
  // a seam between two of its letters too, but never inside a number or a letter.
  test("a quote holds only as whole words", () => {
    expect(holdsQuote("Scale it up to your expected load", "up to you")).toBe(false);
    expect(holdsQuote("Fine, up to you", "up to you")).toBe(true);
    expect(holdsQuote("let me look at it first", "ok")).toBe(false);
    expect(holdsQuote("ok, go", "ok")).toBe(true);
    expect(holdsQuote("measure twice", "sure")).toBe(false);
    expect(holdsQuote("ship version 20", "version 2")).toBe(false);
    // An emoji typed after their words, with a space or without, is a word of its own.
    expect(holdsQuote("up to you \u{1F44D}", "up to you")).toBe(true);
    expect(holdsQuote("up to you\u{1F44D}", "up to you")).toBe(true);
    expect(holdsQuote("\u8cea\u554f\u306f\u304a\u4efb\u305b\u3057\u307e\u3059\u3002", "\u304a\u4efb\u305b\u3057\u307e\u3059")).toBe(true);
    // Thai: a quote after a tone mark holds; a letter cut from its vowel, or a digit from its number, does not.
    expect(holdsQuote("\u0e43\u0e2b\u0e49\u0e04\u0e38\u0e13\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e40\u0e25\u0e22", "\u0e04\u0e38\u0e13\u0e40\u0e25\u0e37\u0e2d\u0e01")).toBe(true);
    expect(holdsQuote("\u0e17\u0e35\u0e48", "\u0e17")).toBe(false);
    expect(holdsQuote("version \u0e52\u0e50", "version \u0e52")).toBe(false);
  });

  test("words in a file pass the same check", () => {
    const p = project();
    typed(p, "up to you & $HOME");
    askQuestions(p);
    const dir = join(seededRecordDir(p), ".aidlc-engine", "answer-text");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mine.txt"), "whatever you think\n");
    refused(log(p, ["answer", "--stage", STAGE, "--details", "A", "--on-instruction-file", ".aidlc-engine/answer-text/mine.txt"]));
    writeFileSync(join(dir, "theirs.txt"), "up to you & $HOME\n");
    const r = log(p, ["answer", "--stage", STAGE, "--details", "A", "--on-instruction-file", ".aidlc-engine/answer-text/theirs.txt"]);
    expect(r.status, r.out).toBe(0);
    expect(fieldOf(answers(p)[0], "Instruction")).toBe("up to you & $HOME");
  });

  test("the request that started the work is their words too", () => {
    const p = project();
    appendAuditEntry("WORKFLOW_STARTED", { Request: "/aidlc Build it with the simplest stack and guide me through it" }, p);
    typed(p, "Looks correct");
    askQuestions(p);
    const r = log(p, ["answer", "--stage", STAGE, "--details", "Guide me", "--on-instruction", "guide me through it"]);
    expect(r.status, r.out).toBe(0);
  });

  test("in a question box, what they picked or wrote is their words, and the agent's question is not", () => {
    const p = project();
    const question = "Shall I choose the answers for the three questions I added?";
    picked(p, question, "Let you decide");
    picked(p, "Anything else?", "No, you pick, I trust you");
    askQuestions(p);
    refused(leftToAgent(p, "choose the answers for the three questions I added"));
    for (const quote of ["Let you decide", "you pick, I trust you"]) {
      const r = leftToAgent(p, quote);
      expect(r.status, `${quote}: ${r.out}`).toBe(0);
    }
  });

  test("a chat's first line, kept before that chat joined the work, is their words too", () => {
    const p = project();
    typed(p, "Looks correct");
    // The hook keeps a chat's message before the chat is on the work, and names it in no row of the work.
    saveMessage(p, {
      session: "another-chat", at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), source: "prompt",
      text: "/aidlc carry on, and pick the defaults for me", picker: null, words: "carry on, and pick the defaults for me",
      settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
    });
    askQuestions(p);
    const r = leftToAgent(p, "pick the defaults for me");
    expect(r.status, r.out).toBe(0);
  });

  describe("where the record lacks some of their words, the choice is recorded as before", () => {
    test("a host that passed no words with their message", () => {
      const p = project();
      typed(p, "");
      const turn = readAuditShardEvents(p).filter((row) => row.event === "HUMAN_TURN").at(-1);
      expect(readMessage(p, auditBlockField(turn!.block, "Message Id") ?? "")?.text).toBe("");
      askQuestions(p);
      const r = leftToAgent(p, "you choose");
      expect(r.status, r.out).toBe(0);
    });

    test("a message of theirs whose record is gone", () => {
      const p = project();
      typed(p, "you choose");
      typed(p, "Looks correct");
      const first = readAuditShardEvents(p).find((row) => row.event === "HUMAN_TURN");
      const id = auditBlockField(first!.block, "Message Id");
      rmSync(join(p, "aidlc", ".aidlc-sessions", "messages", `${id}.json`));
      askQuestions(p);
      const r = leftToAgent(p, "whatever you think is best");
      expect(r.status, r.out).toBe(0);
    });

    test("a message of theirs too long to keep whole, whose end left the choice", () => {
      const p = project();
      const brief = `${"Here is the brief. ".repeat(Math.ceil(MESSAGE_TEXT_MAX_CHARS / 19))}Pick whatever defaults make sense.`;
      expect(brief.length).toBeGreaterThan(MESSAGE_TEXT_MAX_CHARS);
      typed(p, brief);
      const turn = readAuditShardEvents(p).filter((row) => row.event === "HUMAN_TURN").at(-1);
      expect(readMessage(p, auditBlockField(turn!.block, "Message Id") ?? "")?.cut).toBe(true);
      askQuestions(p);
      const r = leftToAgent(p, "pick whatever defaults make sense");
      expect(r.status, r.out).toBe(0);
    });

    test("no turn of theirs on record at all", () => {
      const p = project();
      appendAuditEntry("WORKFLOW_STARTED", { Request: "/aidlc build the lunch poll" }, p);
      askQuestions(p);
      const r = leftToAgent(p, "you choose");
      expect(r.status, r.out).toBe(0);
    });
  });
});
