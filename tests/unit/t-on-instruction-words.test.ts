// `log answer --on-instruction` records a choice the person left to the
// agent. The agent names the message that left it (`--message <id>`, or the
// message the question was logged naming); the engine proves the message is
// theirs, unspent and this chat's, and the record names it with their whole
// words. With none named, the answer stands on a reply of theirs since its
// question was logged, or is refused with the step to ask them: a reply from
// before the question gave the agent nothing to choose unless it names it. No
// quote is compared: words the agent passes with the flag (the form
// from before --message) are its own text, kept as such and claiming nothing,
// so a misread shows in the record instead of being hunted by a matcher. In a
// live run on Claude Code the agent once recorded its own summary as the
// person's instruction; now the record can only say the agent chose, reading a
// message of theirs it names.
// covers: cli:aidlc-log(answer), function:handleAnswer, function:proveMessage
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { listMessages, saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
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

function run(
  p: string, args: string[], input?: string, chat = CHAT, extra: Record<string, string> = {},
): { status: number; out: string } {
  const r = spawnSync(BUN, args, {
    cwd: p,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: {
      ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: chat,
      CLAUDE_PROJECT_DIR: p, AIDLC_PROJECT_DIR: p, ...extra,
    },
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const log = (p: string, args: string[], chat = CHAT) => run(p, [LOG, ...args, "--project-dir", p], undefined, chat);
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

const leftToAgent = (p: string, pointer: string[], chat = CHAT) =>
  log(p, ["answer", "--stage", STAGE, "--details", "Q5: A; Q6: A; Q7: A", "--on-instruction", ...pointer], chat);

// The id of the message the latest turn kept.
const latestId = (p: string): string =>
  auditBlockField(readAuditShardEvents(p).filter((row) => row.event === "HUMAN_TURN").at(-1)!.block, "Message Id")!;

function askQuestions(p: string): void {
  expect(log(p, ["decision", "--stage", STAGE, "--decision", "Q5-Q7", "--options", "A,B,C"]).status).toBe(0);
}

function answers(p: string) {
  return readAuditShardEvents(p).filter((row) => row.event === "QUESTION_ANSWERED");
}

function fieldOf(row: { block: string }, name: string): string | null {
  return row.block.match(new RegExp(`^\\*\\*${name}\\*\\*: (.*)$`, "m"))?.[1] ?? null;
}

const claimed = (row: { block: string }) =>
  fieldOf(row, "Answer Source") === "chosen by the agent, reading their message";

describe("t-on-instruction-words: a choice left to the agent names the message that left it", () => {
  test("the agent's own words never stand for theirs: kept as its text, the claim only on their reply", () => {
    const p = project();
    askQuestions(p);
    typed(p, "Build a local CLI that converts CSV to JSON, and approve each gate.");
    const id = latestId(p);
    for (const quote of ["Grounded from the user request (approve each gate); confirm at summary.", "up to you", "ok"]) {
      const r = leftToAgent(p, [quote]);
      expect(r.status, r.out).toBe(0);
    }
    for (const row of answers(p)) {
      expect(claimed(row)).toBe(true);
      expect(fieldOf(row, "Message Id")).toBe(id);
      expect(fieldOf(row, "Instruction")).toBeNull();
    }
    expect(fieldOf(answers(p)[0], "Conductor Summary")).toBe("Grounded from the user request (approve each gate); confirm at summary.");
  });

  test("their message named: the claim, the message and its whole words, whatever words came with the flag", () => {
    const p = project();
    typed(p, "Q1 is B. Choose the recommended answers for the rest.");
    const id = latestId(p);
    askQuestions(p);
    const r = leftToAgent(p, ["--message", id]);
    expect(r.status, r.out).toBe(0);
    const row = answers(p)[0];
    expect(claimed(row)).toBe(true);
    expect(fieldOf(row, "Message Id")).toBe(id);
    expect(fieldOf(row, "Person Reply")).toBe("Q1 is B. Choose the recommended answers for the rest.");
  });

  // The tool proves the message, never what it says: a message that left the
  // agent nothing to choose is still the agent's reading, and the record says
  // only that.
  test("the record says what the tool knows: the agent chose, reading the message it names", () => {
    const p = project();
    typed(p, "also add an export to CSV");
    const id = latestId(p);
    askQuestions(p);
    const r = leftToAgent(p, ["--message", id]);
    expect(r.status, r.out).toBe(0);
    const row = answers(p)[0];
    expect(fieldOf(row, "Answer Source")).toBe("chosen by the agent, reading their message");
    expect(fieldOf(row, "Message Id")).toBe(id);
    expect(fieldOf(row, "Person Reply")).toBe("also add an export to CSV");
  });

  test("words in a file are the agent's own too", () => {
    const p = project();
    askQuestions(p);
    typed(p, "up to you & $HOME");
    const dir = join(seededRecordDir(p), ".aidlc-engine", "answer-text");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mine.txt"), "whatever you think\n");
    const r = log(p, ["answer", "--stage", STAGE, "--details", "A", "--on-instruction-file", ".aidlc-engine/answer-text/mine.txt"]);
    expect(r.status, r.out).toBe(0);
    expect(fieldOf(answers(p)[0], "Person Reply")).toBe("up to you & $HOME");
    expect(fieldOf(answers(p)[0], "Conductor Summary")).toBe("whatever you think");
  });

  test("the request that started the work can be the message that left it", () => {
    const p = project();
    appendAuditEntry("WORKFLOW_STARTED", { Request: "/aidlc Build it with the simplest stack and pick the defaults" }, p);
    typed(p, "Build it with the simplest stack and pick the defaults");
    const id = latestId(p);
    askQuestions(p);
    const r = leftToAgent(p, ["--message", id]);
    expect(r.status, r.out).toBe(0);
    expect(claimed(answers(p)[0])).toBe(true);
  });

  test("in a question box, the message its reply came in is the one named", () => {
    const p = project();
    picked(p, "Shall I choose the answers for the three questions I added?", "Let you decide");
    const id = latestId(p);
    askQuestions(p);
    const r = leftToAgent(p, ["--message", id]);
    expect(r.status, r.out).toBe(0);
    expect(fieldOf(answers(p)[0], "Message Id")).toBe(id);
  });

  test("a chat's first line, kept before that chat joined the work, is named from that chat", () => {
    const p = project();
    typed(p, "Looks correct");
    const other = "t-on-instruction-other-chat";
    saveMessage(p, {
      session: other, at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), source: "prompt",
      text: "/aidlc carry on, and pick the defaults for me", picker: null, words: "carry on, and pick the defaults for me",
      settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
    });
    const id = listMessages(p).find((message) => message.session === other)!.id;
    askQuestions(p);
    const r = leftToAgent(p, ["--message", id], other);
    expect(r.status, r.out).toBe(0);
    expect(claimed(answers(p)[0])).toBe(true);
  });

  // A live opencode run: the person approved the previous stage, and the same
  // turn ran on into this one, where the agent answered its questions for them
  // with no message of theirs since. The step names only this chat's messages
  // on this work, by id and time, never their words.
  test("no reply of theirs since the question, none named: refused with the step to ask them, nothing recorded", () => {
    const p = project();
    typed(p, "Approve, the ninth gate");
    const approve = latestId(p);
    appendAuditEntry("GATE_APPROVED", { Stage: "intent-capture", "Message Id": approve }, p);
    const other = saveMessage(p, {
      session: "t-on-instruction-other-chat", at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), source: "prompt",
      text: "you pick the answers", picker: null, words: "you pick the answers",
      settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
    });
    askQuestions(p);
    const r = leftToAgent(p, []);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain(
      "no reply of the person's is on record since this question was asked. Ask them, end the turn, and record the " +
        "choice they make.",
    );
    expect(r.out).toContain(`${approve} (sent `);
    expect(r.out).not.toContain(other.id);
    expect(r.out).not.toContain("you pick the answers");
    expect(r.out).not.toContain("the ninth gate");
    expect(answers(p)).toHaveLength(0);
  });

  test("left before the question existed, in the message an approval spent: recorded by naming it", () => {
    const p = project();
    typed(p, "Approve, and choose the recommended answers for the next stage");
    const id = latestId(p);
    appendAuditEntry("GATE_APPROVED", { Stage: "intent-capture", "Message Id": id }, p);
    askQuestions(p);
    const r = leftToAgent(p, ["--message", id]);
    expect(r.status, r.out).toBe(0);
    expect(claimed(answers(p)[0])).toBe(true);
    expect(fieldOf(answers(p)[0], "Message Id")).toBe(id);
  });

  // The floor is the question's own row. A reply after the last decision and
  // before the question was logged left the agent no choice to make unless it
  // names that reply; a plain answer keeps its own floor and records on it.
  test("a reply from before the question was logged, none named: refused, that reply offered; named, recorded", () => {
    const p = project();
    typed(p, "Approve");
    appendAuditEntry("GATE_APPROVED", { Stage: "intent-capture", "Message Id": latestId(p) }, p);
    typed(p, "use the recommended answers for what you ask next");
    const id = latestId(p);
    askQuestions(p);
    const bare = leftToAgent(p, []);
    expect(bare.status, bare.out).not.toBe(0);
    expect(bare.out).toContain(`${id} (sent `);
    expect(bare.out).toContain("run the same command with --message <id>");
    expect(answers(p)).toHaveLength(0);
    const named = leftToAgent(p, ["--message", id]);
    expect(named.status, named.out).toBe(0);
    expect(claimed(answers(p)[0])).toBe(true);
    expect(fieldOf(answers(p)[0], "Message Id")).toBe(id);
  });

  // The person's own switch for a session nobody can reply in: nothing is
  // refused, and the row claims no choice on a reply from before the question.
  test("with the human presence off switch, nothing is refused, and a reply from before the question carries no claim", () => {
    const p = project();
    typed(p, "A for all three");
    const id = latestId(p);
    askQuestions(p);
    const r = run(p, [LOG, "answer", "--stage", STAGE, "--details", "Q5: A", "--on-instruction", "--project-dir", p],
      undefined, CHAT, { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
    expect(r.status, r.out).toBe(0);
    expect(fieldOf(answers(p)[0], "Message Id")).toBe(id);
    expect(claimed(answers(p)[0])).toBe(false);
  });

  test("the plain answer keeps its floor: a reply from before the question was logged records it", () => {
    const p = project();
    typed(p, "Approve");
    appendAuditEntry("GATE_APPROVED", { Stage: "intent-capture", "Message Id": latestId(p) }, p);
    typed(p, "A for all three");
    const id = latestId(p);
    askQuestions(p);
    const r = log(p, ["answer", "--stage", STAGE, "--details", "Q5: A; Q6: A; Q7: A"]);
    expect(r.status, r.out).toBe(0);
    expect(fieldOf(answers(p)[0], "Message Id")).toBe(id);
    expect(claimed(answers(p)[0])).toBe(false);
  });

  test("a reply after the question was logged, none named: recorded on that reply, the claim beside it", () => {
    const p = project();
    typed(p, "Approve");
    appendAuditEntry("GATE_APPROVED", { Stage: "intent-capture", "Message Id": latestId(p) }, p);
    askQuestions(p);
    typed(p, "up to you");
    const id = latestId(p);
    const r = leftToAgent(p, []);
    expect(r.status, r.out).toBe(0);
    const row = answers(p)[0];
    expect(claimed(row)).toBe(true);
    expect(fieldOf(row, "Message Id")).toBe(id);
    expect(fieldOf(row, "Person Reply")).toBe("up to you");
  });

  // The line that started the work is kept before any row of the work names
  // it, so no turn of it is on the record: the step names it, and the agent
  // records the choice on it instead of asking again.
  test("a choice left in the line that started the work, none named: the step names that message, and naming it records", () => {
    const p = project();
    const opening = saveMessage(p, {
      session: CHAT, at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), source: "prompt",
      text: "/aidlc build it and pick the defaults", picker: null, words: "build it and pick the defaults",
      settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
    });
    appendAuditEntry("WORKFLOW_STARTED", { Request: "/aidlc build it and pick the defaults" }, p);
    askQuestions(p);
    const bare = leftToAgent(p, []);
    expect(bare.status, bare.out).not.toBe(0);
    expect(bare.out).toContain(`${opening.id} (sent `);
    expect(answers(p)).toHaveLength(0);
    const named = leftToAgent(p, ["--message", opening.id]);
    expect(named.status, named.out).toBe(0);
    expect(claimed(answers(p)[0])).toBe(true);
  });

  // Presence is a fact about the turn: a reply whose words the host left
  // empty is still theirs, and the row names its turn with no words claimed.
  test("a reply with no words kept, after the question: recorded on its turn, no words on the row", () => {
    const p = project();
    askQuestions(p);
    typed(p, "");
    const r = leftToAgent(p, []);
    expect(r.status, r.out).toBe(0);
    expect(fieldOf(answers(p)[0], "Person Reply")).toBeNull();
  });
});
