// covers: hook:aidlc-record-human-turn, hook:aidlc-codex-adapter
//
// A setting the person asks for in their answer to a question box is recorded
// on that answer, and the line said to them quotes it. Live on Claude Code
// (2026-10-26): the person typed "sorry, hit escape by accident. carry on where
// you were" while the agent worked, then answered the Requirements gate in the
// box with "set the guard policy to off, its only docs. and approve". The hook
// had named the typed message's id to the agent and never the box answer's, so
// the agent ran the setter on the typed one: GUARD_POLICY_SET kept "sorry, hit
// escape ..." as the words that asked, and the setter's line for the person
// said "because you said: "sorry, hit escape ..."". Now the box answer's id
// reaches the agent the way a typed message's does, in the host's own event
// for the box (PostToolUse), and every setter that takes --message stands on
// it. A setting asked in a typed message is recorded as before.
//
// Mechanism: function - the shipped hook (Claude Code's own command, Codex
// through its adapter) and the shipped setters; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField, personsWordsText, readAuditShardEvents, writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { readMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import {
  type AnswersItem, PICKER_HARNESSES, buildQuestion, env, exec, pick, recordByAgent, say,
} from "../harness/aidlc-answers-corpus.ts";
import { DISPATCHER, SESSION } from "../harness/aidlc-input-corpus.ts";
import { REPO_ROOT, cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

const QUEUED = "sorry, hit escape by accident. carry on where you were";
const BOX_ANSWER = "set the guard policy to off, its only docs. and approve";
const GATE = "Requirements Analysis complete. How would you like to proceed?";

async function gateOpen(): Promise<string> {
  const proj = setupIntegrationProject();
  projects.push(proj);
  await buildQuestion(proj, "stage-gate");
  return proj;
}

const turns = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN");
const latestId = (proj: string) => auditBlockField(turns(proj).at(-1)!.block, "Message Id")!;
const lastRow = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event).at(-1);
const namedId = (stdout: string) => /on record as ([^:\s]+):/.exec(stdout)?.[1];
const run = (proj: string, args: string[]) => exec([process.execPath, DISPATCHER, ...args], { cwd: proj, env: env(proj) });

/** The person answers the gate's box in their own words (the box's "Other" field). */
function boxAnswer(answer: string): AnswersItem {
  return {
    question: "stage-gate",
    picker: { question: GATE, options: ["Request Changes", "Approve"], answer },
  } as unknown as AnswersItem;
}

describe("t-setter-box-answer-words: a setting asked in a box answer is recorded on that answer", () => {
  for (const harness of PICKER_HARNESSES) {
    test(`${harness}: after a message typed while the agent worked, the box answer's id reaches the agent, and the record and the line carry its words`, async () => {
      const proj = await gateOpen();
      const typed = await say(proj, QUEUED, harness);
      expect(typed.status, typed.stderr).toBe(0);
      const queuedId = namedId(typed.stdout);
      expect(queuedId, typed.stdout).toBe(latestId(proj));

      const box = await pick(proj, boxAnswer(BOX_ANSWER), harness);
      expect(box.status, box.stderr).toBe(0);
      const boxId = namedId(box.stdout);
      expect(boxId, box.stdout).toBe(latestId(proj));
      expect(boxId).not.toBe(queuedId);
      // The host's own event for a box answer, so the host hands it to the agent; never the person's words.
      expect(JSON.parse(box.stdout.trim()).hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(box.stdout).not.toContain(BOX_ANSWER);

      const set = await run(proj, ["engine", "config", "set", "guard-policy", "off", "--message", boxId as string]);
      expect(set.status, set.stdout + set.stderr).toBe(0);
      expect(set.stdout).toContain(`because you said: "${BOX_ANSWER}"`);
      expect(set.stdout).not.toContain(QUEUED);
      const row = lastRow(proj, "GUARD_POLICY_SET")!;
      expect(auditBlockField(row.block, "Person Reply")).toBe(BOX_ANSWER);
      expect(auditBlockField(row.block, "Message Id")).toBe(boxId as string);
    });
  }

  // Codex hands a note the person adds beside their pick back as a second answer to the same question.
  test("codex: a setting asked in the note beside a pick is recorded with the note, not the pick alone", async () => {
    const proj = await gateOpen();
    await say(proj, QUEUED, "codex");
    const codexTree = join(proj, ".codex");
    if (!existsSync(codexTree)) cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), codexTree, { recursive: true });
    writeSessionPidEntry(proj, process.pid, SESSION);
    const box = await exec([process.execPath, join(codexTree, "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], {
      cwd: proj,
      env: { ...env(proj), CLAUDE_PROJECT_DIR: undefined, USER_PROMPT: undefined, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined },
      input: JSON.stringify({
        hook_event_name: "PostToolUse", tool_name: "request_user_input", session_id: SESSION, turn_id: "t1", cwd: proj,
        tool_input: { questions: [{ id: "q1", header: "Approval", question: GATE, options: [{ label: "Approve", description: "" }, { label: "Request Changes", description: "" }] }] },
        tool_response: JSON.stringify({ answers: { q1: { answers: ["Approve", "user_note: turn the guard policy off, its only docs"] } } }),
      }),
    });
    expect(box.status, box.stderr).toBe(0);
    const boxId = namedId(box.stdout) as string;
    expect(boxId, box.stdout).toBe(latestId(proj));
    const set = await run(proj, ["engine", "config", "set", "guard-policy", "off", "--message", boxId]);
    expect(set.status, set.stdout + set.stderr).toBe(0);
    expect(set.stdout).toContain("turn the guard policy off, its only docs");
    const row = lastRow(proj, "GUARD_POLICY_SET")!;
    expect(auditBlockField(row.block, "Person Reply")).toContain("turn the guard policy off, its only docs");
    expect(auditBlockField(row.block, "Message Id")).toBe(boxId);
  });

  test("claude: a long answer typed in the box keeps its words whole, as a typed message does", async () => {
    const proj = await gateOpen();
    const long = `turn the guard policy off, ${"its only docs. ".repeat(220)}`.trim();
    expect(long.length).toBeGreaterThan(3000);
    const box = await pick(proj, boxAnswer(long), "claude");
    const boxId = namedId(box.stdout) as string;
    expect(boxId, box.stdout).toBe(latestId(proj));
    const words = readMessage(proj, boxId)?.words;
    expect(words === null || words === undefined ? null : personsWordsText(words)).toBe(long);
  });

  test("claude: every setter that takes --message stands on the box answer's id", async () => {
    const proj = await gateOpen();
    await say(proj, QUEUED, "claude");
    const box = await pick(proj, boxAnswer("turn the review freeze check off and bring the specialists in"), "claude");
    const boxId = namedId(box.stdout) as string;
    expect(boxId, box.stdout).toBe(latestId(proj));
    const freeze = await run(proj, ["engine", "config", "set", "guard.review-freeze", "off", "--collaborators", "on",
      "--message", boxId]);
    expect(freeze.status, freeze.stdout + freeze.stderr).toBe(0);
    expect(freeze.stdout).toContain('because you said: "turn the review freeze check off and bring the specialists in"');
    expect(freeze.stdout).not.toContain(QUEUED);
  });

  // Right after the approval the pick is still the reply in hand
  // (t-setting-rides-approval); once the person has said more it is not.
  test("claude: a box pick the approval was recorded on stands for no setting once they have said more", async () => {
    const proj = await gateOpen();
    const box = await pick(proj, boxAnswer("Approve"), "claude");
    const boxId = namedId(box.stdout) as string;
    expect(boxId, box.stdout).toBe(latestId(proj));
    const approved = await recordByAgent(proj, { question: "stage-gate", input: "Approve", expected: { end: { parked: false } } } as unknown as AnswersItem, "Approve");
    expect(approved?.exec.status, `${approved?.exec.stdout}${approved?.exec.stderr}`).toBe(0);
    await say(proj, QUEUED, "claude");
    const set = await run(proj, ["engine", "config", "set", "guard-policy", "off", "--message", boxId]);
    expect(set.status, set.stdout + set.stderr).not.toBe(0);
    expect(lastRow(proj, "GUARD_POLICY_SET")).toBeUndefined();
  });

  test("claude: a setting asked in a typed message is recorded on that message, as before", async () => {
    const proj = await gateOpen();
    const asked = "set the guard policy to off, its only docs";
    const typed = await say(proj, asked, "claude");
    const id = namedId(typed.stdout) as string;
    expect(id, typed.stdout).toBe(latestId(proj));
    expect(JSON.parse(typed.stdout.trim()).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const set = await run(proj, ["engine", "config", "set", "guard-policy", "off", "--message", id]);
    expect(set.status, set.stdout + set.stderr).toBe(0);
    expect(set.stdout).toContain(`because you said: "${asked}"`);
    const row = lastRow(proj, "GUARD_POLICY_SET")!;
    expect(auditBlockField(row.block, "Person Reply")).toBe(asked);
    expect(auditBlockField(row.block, "Message Id")).toBe(id);
  });
});
