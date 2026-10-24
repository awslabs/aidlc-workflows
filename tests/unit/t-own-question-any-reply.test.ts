// covers: subcommand:aidlc-log:answer, subcommand:aidlc-log:decision, audit:QUESTION_ANSWERED, audit:QUESTION_REPLIED
// covers: audit:VERIFICATION_COMMAND_RECORDED, audit:CONSTRUCTION_POLICY_RECORDED, function:personsGateReply
//
// A question the agent asks of its own accord takes any reply of the person's
// that no decision has used yet, in this chat: the agent read which question
// it answers, and the engine reads no order of the agent's bookkeeping against
// the person's turn. Live on Kiro CLI (Guide me) the person answered five
// questions one per turn, the agent logged them afterwards, and every stage's
// answer was refused once ("came before this question was logged") with an
// engine line read to the person; on opencode "Nothing to add, and approve"
// typed before the learnings question was logged was asked about again. The
// record keeps every unspent reply of theirs whole (the window, one owner:
// personsGateReply), never another chat's words, and the engine says nothing
// back for the agent to read out. A reply an earlier answer recorded is that
// answer's: on Claude Code the summary confirmation kept "Guide me", the
// questions' answers and "Looks correct" as one reply. It stays in only as
// their latest. The verification command and a Construction
// policy question the agent shows before it logs take the same reply. The one
// refusal left is presence: no reply since the last decision. Text typed into a
// question box is kept as their words, whatever it reads like. Every case runs
// under Guard Policy off, relaxed and strict.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const CHAT = "01995000-7a11-7000-8000-00000000a2a2";
const OTHER = "01995000-7a11-7000-8000-00000000b3b3";
const STAGE = "requirements-analysis";
const POLICIES = ["off", "relaxed", "strict"] as const;
type Policy = (typeof POLICIES)[number];

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});

function withPolicy(proj: string, policy: Policy): void {
  const state = seededStateFile(proj);
  writeFileSync(state, readFileSync(state, "utf-8").replace(/- \*\*Change Control\*\*: [^\n]*/,
    policy === "off" ? "- **Guard Policy**: off (from scope bugfix)" : `- **Guard Policy**: ${policy} (set by you)`));
}

function inception(policy: Policy): string {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  withPolicy(proj, policy);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  return proj;
}

function env(proj: string, chat: string | null): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
  };
  if (chat !== null) out.AIDLC_SESSION_OVERRIDE = chat;
  else delete out.AIDLC_SESSION_OVERRIDE;
  delete out.AIDLC_SESSION_OVERRIDE_SOURCE;
  delete out.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  return out;
}

function hook(proj: string, chat: string, payload: Record<string, unknown>): void {
  const result = Bun.spawnSync({
    cmd: [process.execPath, DISPATCHER, "engine", "hook", "record-human-turn"], cwd: proj, env: env(proj, chat),
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: chat, ...payload })),
    stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

// What the person types, through the prompt hook every harness uses.
const says = (proj: string, prompt: string, chat = CHAT) =>
  hook(proj, chat, { hook_event_name: "UserPromptSubmit", prompt });

// The agent's command, in the chat it serves (null: a chat the engine cannot name).
function log(proj: string, args: string[], chat: string | null = CHAT) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, LOG, ...args, "--project-dir", proj], env: env(proj, chat), stdout: "pipe", stderr: "pipe",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const field = (proj: string, event: string, name: string) => auditBlockField(rows(proj, event).at(-1)!.block, name);
const latestMessageId = (proj: string) => auditBlockField(rows(proj, "HUMAN_TURN").at(-1)!.block, "Message Id");

// What the engine hands back: nothing for the agent to read out, nothing to ask.
function saysNothingBack(out: string): void {
  const printed = JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>;
  expect(printed.say).toBeUndefined();
  expect(printed.agent_note).toBeUndefined();
}

// The stage's summary confirmation, asked after its questions: the question recorded, their reply, then the answer
// the agent read in it, with the summary's own check on as the agent meets it.
function summaryConfirmed(proj: string, reply: string) {
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, `${STAGE}-questions.md`);
  writeFileSync(questions, [
    "# Requirements Questions", "", "## Q1", "Where does the blank title come from?", "", "A) The form", "B) The API",
    "", "[Answer]: A", "", "## Consolidated Summary Confirmation", "", "Blank titles from the form are refused.", "",
    "- Looks correct", "- Request changes", "", "[Answer]:", "",
  ].join("\n"));
  const summary = (args: string[]) => {
    const environment = env(proj, CHAT);
    delete environment.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
    const result = Bun.spawnSync({
      cmd: [process.execPath, LOG, ...args, "--checkpoint", "summary-confirmation", "--stage", STAGE, "--questions-file",
        questions, "--project-dir", proj],
      env: environment, stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
  };
  const asked = summary(["decision", "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"]);
  expect(asked.status, asked.out).toBe(0);
  says(proj, reply);
  writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]:\n$/, "[Answer]: Looks correct\n"));
  return summary(["answer", "--details", "Looks correct"]);
}

for (const policy of POLICIES) {
  describe(`t-own-question-any-reply (Guard Policy ${policy})`, () => {
    test("five answers given one per turn, then the question logged: one answer records them, with every word", () => {
      const proj = inception(policy);
      const replies = ["A", "B, the API", "C", "keep the old flag", "A"];
      for (const reply of replies) says(proj, reply);
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Q1 to Q5: the requirements questions",
        "--options", "A,B,C"]).status).toBe(0);
      const answered = log(proj, ["answer", "--stage", STAGE, "--details", "Q1: A; Q2: B; Q3: C; Q4: A; Q5: A"]);
      expect(answered.status, answered.out).toBe(0);
      saysNothingBack(answered.out);
      // The record keeps their messages whole, one line each (the audit escapes the line break).
      expect(field(proj, "QUESTION_ANSWERED", "Person Reply")).toBe(replies.join("\\n"));
      expect(field(proj, "QUESTION_ANSWERED", "Message Id")).toBe(latestMessageId(proj));
    });

    test("the learnings question logged after the reply that answers it records on that reply, asking nothing", () => {
      const proj = inception(policy);
      says(proj, "Nothing to add. Approve, and move on");
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Anything to add for next time?",
        "--options", "Nothing to add,Add a note", "--question-kind", "learnings-note"]).status).toBe(0);
      const answered = log(proj, ["answer", "--stage", STAGE, "--details", "Nothing to add"]);
      expect(answered.status, answered.out).toBe(0);
      saysNothingBack(answered.out);
      expect(field(proj, "QUESTION_ANSWERED", "Person Reply")).toBe("Nothing to add. Approve, and move on");
    });

    // Live on Claude Code the answer-mode pick, the questions' answers and "Looks correct" each came as their own
    // message, and every row after the first kept the earlier ones as its reply too.
    test("two questions answered one per turn, then the summary confirmed: each row keeps the reply given for it", () => {
      const proj = inception(policy);
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "How would you like to answer the questions?",
        "--options", "Guide me,I'll edit the file,Chat"]).status).toBe(0);
      says(proj, "Guide me");
      expect(log(proj, ["answer", "--stage", STAGE, "--details", "Guide me"]).status).toBe(0);
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Where does the blank title come from?",
        "--options", "The form,The API"]).status).toBe(0);
      says(proj, "The form");
      const answered = log(proj, ["answer", "--stage", STAGE, "--details", "Q1: A"]);
      expect(answered.status, answered.out).toBe(0);
      expect(field(proj, "QUESTION_ANSWERED", "Person Reply")).toBe("The form");
      expect(field(proj, "QUESTION_ANSWERED", "Message Id")).toBe(latestMessageId(proj));
      expect(field(proj, "QUESTION_ANSWERED", "Message Ids")).toBeNull();
      const confirmed = summaryConfirmed(proj, "Looks correct");
      expect(confirmed.status, confirmed.out).toBe(0);
      expect(field(proj, "SUMMARY_CONFIRMATION_RECORDED", "Person Reply")).toBe("Looks correct");
      expect(field(proj, "SUMMARY_CONFIRMATION_RECORDED", "Message Id")).toBe(latestMessageId(proj));
      expect(field(proj, "SUMMARY_CONFIRMATION_RECORDED", "Message Ids")).toBeNull();
    });

    test("a remark no answer recorded stays beside the summary's reply, with both its messages", () => {
      const proj = inception(policy);
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "How would you like to answer the questions?",
        "--options", "Guide me,I'll edit the file,Chat"]).status).toBe(0);
      says(proj, "Guide me");
      expect(log(proj, ["answer", "--stage", STAGE, "--details", "Guide me"]).status).toBe(0);
      says(proj, "wait, keep the old flag");
      const remark = latestMessageId(proj);
      const confirmed = summaryConfirmed(proj, "Looks correct");
      expect(confirmed.status, confirmed.out).toBe(0);
      expect(field(proj, "SUMMARY_CONFIRMATION_RECORDED", "Person Reply")).toBe("wait, keep the old flag\\nLooks correct");
      expect(field(proj, "SUMMARY_CONFIRMATION_RECORDED", "Message Ids")).toBe(`${remark},${latestMessageId(proj)}`);
    });

    test("another chat's words never land on this chat's answer; with no chat named and two chats, none do", () => {
      const proj = inception(policy);
      says(proj, "PostgreSQL");
      says(proj, "what does the gate commit me to?", OTHER);
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Which database?", "--options", "PostgreSQL,SQLite"])
        .status).toBe(0);
      expect(log(proj, ["answer", "--stage", STAGE, "--details", "PostgreSQL"]).status).toBe(0);
      expect(field(proj, "QUESTION_ANSWERED", "Person Reply")).toBe("PostgreSQL");
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Which runtime?", "--options", "Bun,Node"], null)
        .status).toBe(0);
      const unnamed = log(proj, ["answer", "--stage", STAGE, "--details", "Bun"], null);
      expect(unnamed.status, unnamed.out).toBe(0);
      expect(field(proj, "QUESTION_ANSWERED", "Person Reply")).toBeNull();
      expect(field(proj, "QUESTION_ANSWERED", "Message Id")).toBeNull();
    });

    test("an answer the box did not carry is recorded with no note, and the box's choices stay on record", () => {
      const proj = inception(policy);
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "How would you like to answer the questions?",
        "--options", "Guide me,I'll edit the file,Chat"]).status).toBe(0);
      const questions = [{ question: "How should the release be described?",
        options: [{ label: "Lightweight release note" }, { label: "Full changelog" }] }];
      hook(proj, CHAT, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions },
        tool_response: { questions, answers: { "How should the release be described?": "Lightweight release note" } } });
      expect(log(proj, ["answer", "--stage", STAGE, "--details", "Guide me"]).status).toBe(0);
      expect(field(proj, "QUESTION_ANSWERED", "Picker Note")).toBeNull();
      expect(field(proj, "QUESTION_REPLIED", "Options")).toBe(JSON.stringify(["Lightweight release note", "Full changelog"]));
    });

    // The box gives no mark between a pick and text typed into it, so what it
    // carried back is kept as their words, one of the agent's labels included.
    test("text typed into a box is kept as their words, even when it reads as one of the box's labels", () => {
      const proj = inception(policy);
      const question = "Approve this stage?";
      for (const typed of ["Approve (Recommended)", "Approve it, ship"]) {
        hook(proj, CHAT, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion",
          tool_input: { questions: [{ question, options: [{ label: "Approve" }, { label: "Request Changes" }] }] },
          tool_response: { answers: { [question]: typed } } });
        expect(field(proj, "HUMAN_TURN", "Picked")).toBe(JSON.stringify([typed]));
      }
      const kept = readFileSync(join(seededRecordDir(proj), ".aidlc-engine", "gate-words", `${CHAT}.json`), "utf-8");
      expect(kept).toContain("Approve (Recommended)");
      expect(kept).toContain("Approve it, ship");
    });

    test("a question an older engine left open takes the reply sent after the update, with their words", () => {
      const proj = inception(policy);
      // As the 2.11.1 log tool wrote it: no Question Kind, no Message Id.
      appendAuditEntry("DECISION_RECORDED", { Stage: STAGE, Decision: "Which database?", Options: "PostgreSQL,SQLite" },
        proj);
      says(proj, "SQLite, it is a small app");
      const answered = log(proj, ["answer", "--stage", STAGE, "--details", "SQLite"]);
      expect(answered.status, answered.out).toBe(0);
      expect(field(proj, "QUESTION_ANSWERED", "Person Reply")).toBe("SQLite, it is a small app");
    });

    test("with no reply since the last decision, nothing is recorded", () => {
      const proj = inception(policy);
      says(proj, "approve");
      appendAuditEntry("GATE_APPROVED", { Stage: "reverse-engineering", "User Input": "Approve" }, proj);
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Which database?", "--options", "PostgreSQL,SQLite"])
        .status).toBe(0);
      const refused = log(proj, ["answer", "--stage", STAGE, "--details", "PostgreSQL"]);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("no new human reply has arrived for the question");
      expect(rows(proj, "QUESTION_ANSWERED")).toHaveLength(0);
    });
  });
}

// Construction, the Units built one at a time, at Functional Design.
const SEPARATOR = "\u2014";
const BUILD = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
function construction(policy: Policy): string {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking
## Project Information
- **Project**: The agent's own questions
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: solo
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Change Control**: strict
## Stage Progress
### CONSTRUCTION PHASE
${BUILD.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} ${SEPARATOR} EXECUTE`).join("\n")}
- [ ] build-and-test ${SEPARATOR} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  withPolicy(proj, policy);
  seedBoltDag(proj, ["alpha", "beta"]);
  mkdirSync(join(proj, "src"), { recursive: true });
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, proj);
  appendAuditEntry("STAGE_STARTED", { Stage: "functional-design" }, proj);
  return proj;
}

// The two questions whose answer needs the person's reply, shown before the agent logs them.
const SHOWN_FIRST = {
  "verification command": {
    identity: ["--checkpoint", "verification-command", "--command", "npm test"],
    decision: "Use this command to verify each completed Unit?",
    receipt: "VERIFICATION_COMMAND_RECORDED",
  },
  "Construction policy": {
    identity: ["--checkpoint", "construction-policy", "--field", "Construction Execution", "--value", "swarm"],
    decision: "Build the Units in parallel?",
    receipt: "CONSTRUCTION_POLICY_RECORDED",
  },
} as const;

for (const policy of POLICIES) {
  for (const [which, question] of Object.entries(SHOWN_FIRST)) {
    describe(`t-own-question-any-reply: the ${which} question shown before it is logged (Guard Policy ${policy})`, () => {
      const ask = (proj: string) => log(proj, ["decision", "--stage", "functional-design", ...question.identity,
        "--decision", question.decision, "--options", "Approve,Request Changes"]);
      const answer = (proj: string) =>
        log(proj, ["answer", "--stage", "functional-design", ...question.identity, "--details", "Approve"]);

      test("the reply already given records it, with their words", () => {
        const proj = construction(policy);
        says(proj, "yes, approve that");
        expect(ask(proj).status).toBe(0);
        const recorded = answer(proj);
        expect(recorded.status, recorded.out).toBe(0);
        expect(field(proj, question.receipt, "Person Reply")).toBe("yes, approve that");
      });

      test("a reply sent while the engine's routing question was open is not taken", () => {
        const proj = construction(policy);
        // As the hook keeps a message that came while another engine question was on screen.
        const words = "build me a second app";
        const kept = saveMessage(proj, {
          session: CHAT, at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), source: "prompt", text: words,
          picker: null, words, settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
        });
        appendAuditEntry("HUMAN_TURN", { Session: CHAT, Origin: "person", Source: "typed", "Open Question": "routing",
          "Message Id": kept.id }, proj);
        expect(ask(proj).status).toBe(0);
        const refused = answer(proj);
        expect(refused.status).not.toBe(0);
        expect(refused.out).toContain(kept.id);
        expect(rows(proj, question.receipt)).toHaveLength(0);
      });

      test("with no reply at all, nothing is recorded", () => {
        const proj = construction(policy);
        expect(ask(proj).status).toBe(0);
        const refused = answer(proj);
        expect(refused.status).not.toBe(0);
        expect(refused.out).toContain("none is on record yet");
        expect(rows(proj, question.receipt)).toHaveLength(0);
      });
    });
  }
}
