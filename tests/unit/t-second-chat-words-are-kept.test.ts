// covers: function:resolveChat, function:classifyFirstContact, hook:record-human-turn,
// subcommand:aidlc-orchestrate:next, audit:HUMAN_TURN
//
// A chat the engine bound to no record because the only record here had not
// been chosen on this machine ("unjoined") is looked at again at the one door
// every chat enters by. When this machine has since chosen that work (the
// per-user cursor names it), the chat joins it silently, as a chat first met
// then would: its turn lands in the work, its words are kept, a typed switch
// reaches the work. When no choice was made (a fresh clone of a teammate's
// record), the chat stays out as today: nothing is written into the record,
// `next` asks once which work this is, and the person's words are still kept
// on this chat's own message record.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AIDLC_SRC,
  DEFAULT_RECORD_DIR,
  FIXTURES_DIR,
  cleanupTestProject,
  createOrchestrationTestProject,
  intentsDirOf,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  auditBlockField,
  getField,
  readAuditShardEvents,
  readSessionBinding,
  writeSessionBinding,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
/** The first chat: on the work. */
const FIRST = "01995000-7a11-7000-8000-000000000051";
/** The second chat: it met this workspace before anyone here chose the work. */
const SECOND = "01995000-7a11-7000-8000-000000000052";
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_UNATTENDED: "0",
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SECOND,
  AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
};

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

/** Open work mid-Inception, and a second chat bound to nothing by the lone-record rule. */
function openWork(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
  writeSessionBinding(proj, SECOND, "default", null, "unjoined");
  return proj;
}

/** The same record in a teammate's fresh clone: no cursor, nothing chosen here. */
function freshClone(): string {
  const proj = openWork();
  rmSync(join(intentsDirOf(proj, "default"), "active-intent"), { force: true });
  return proj;
}

function said(proj: string, prompt: string, session = SECOND, extra: Record<string, unknown> = {}): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: proj, prompt, ...extra }),
    env: { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: undefined, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

function next(proj: string, args: string[]): { directive: Record<string, unknown> | null; out: string } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, ...CLEAR } });
  return { directive: result.directive as Record<string, unknown> | null, out: result.out };
}

function humanTurns(proj: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN");
}

/** The texts of this chat's message records, in the order written. */
function messages(proj: string, session?: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "messages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as { at: string; text: string; session: string | null })
    .filter((record) => record.session === (session ?? SECOND))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((record) => record.text);
}

/** Every file under the record, hashed: the fresh-clone pin of chat-identity (t351). */
function snapshot(proj: string): Record<string, string> {
  const root = seededRecordDir(proj);
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

describe("a second chat bound to nothing while this machine chose the work", () => {
  test("its turn lands in the work: the row, the kept words, the message record", () => {
    const proj = openWork();
    said(proj, "approve");
    const turns = humanTurns(proj);
    expect(turns).toHaveLength(1);
    expect(auditBlockField(turns[0].block, "Session")).toBe(SECOND);
    expect(auditBlockField(turns[0].block, "Reply")).toBeNull();
    expect(messages(proj)).toEqual(["approve"]);
  });

  test("its next step is on the work, not a plan offer for the word, and the chat now reads as joined", () => {
    const proj = openWork();
    said(proj, "approve");
    const step = next(proj, ["approve"]);
    expect(step.directive, step.out).not.toBeNull();
    expect(step.directive?.ask_type, step.out).not.toBe("compose-offer");
    expect(step.out).not.toContain("obvious fit");
    const record = readFileSync(join(intentsDirOf(proj, "default"), "active-intent"), "utf-8").trim();
    expect(readSessionBinding(proj, SECOND)).toMatchObject({ space: "default", intent: record, source: "cursor" });
  });

  test("a switch typed there reaches the open work, set by them", () => {
    const proj = openWork();
    said(proj, "/aidlc --plan-approval off");
    expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Plan Approval")).toBe("off (set by you)");
  });
});

describe("a fresh clone with no choice made on this machine stays as today", () => {
  test("the chat stays out, the record is untouched, next asks once which work, and the words are kept on the chat", () => {
    const proj = freshClone();
    const before = snapshot(proj);
    said(proj, "approve");
    expect(snapshot(proj)).toEqual(before);
    expect(humanTurns(proj)).toHaveLength(0);
    expect(readSessionBinding(proj, SECOND)).toMatchObject({ intent: null, source: "unjoined" });
    expect(messages(proj)).toEqual(["approve"]);
    const step = next(proj, []);
    expect(step.directive?.kind, step.out).toBe("ask");
    expect(step.directive?.ask_type, step.out).toBe("intent-pick");
    expect(readSessionBinding(proj, SECOND)).toMatchObject({ intent: null, source: "unjoined" });
    expect(snapshot(proj)).toEqual(before);
  });

  test("a turn the host made in that chat (a notice, a brief) is kept as nobody's words", () => {
    const proj = freshClone();
    const before = snapshot(proj);
    said(proj, "A background task you started has finished.", SECOND, {
      origin: { kind: "host", reason: "task-notification", source: "record" },
    });
    expect(messages(proj)).toEqual([]);
    expect(humanTurns(proj)).toHaveLength(0);
    expect(snapshot(proj)).toEqual(before);
  });

  test("its kept words do not make the work's own chat ambiguous when the engine cannot name the chat", () => {
    const proj = freshClone();
    // Chat B, on nothing, says something; chat A is on the work and answers the stage's question.
    said(proj, "hello there");
    writeSessionBinding(proj, FIRST, "default", DEFAULT_RECORD_DIR, "switch");
    said(proj, "approve", FIRST);
    const approve = messages(proj, FIRST);
    expect(approve).toEqual(["approve"]);
    const id = readdirSync(join(proj, "aidlc", ".aidlc-sessions", "messages")).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(proj, "aidlc", ".aidlc-sessions", "messages", name), "utf-8")) as { id: string; session: string | null })
      .find((message) => message.session === FIRST)!.id;
    // The agent's shell carries no chat identity (opencode, Copilot): the engine proves the message by the one chat
    // that has spoken on this work since the last decision. Chat B is bound to no record, so it is not that chat.
    const logged = spawnSync(BUN, [LOG, "decision", "--stage", "requirements-analysis", "--decision", "Approve the draft", "--message", id, "--project-dir", proj], {
      cwd: proj,
      env: { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: undefined, AIDLC_SESSION_OVERRIDE_SOURCE: undefined, CODEX_THREAD_ID: undefined, CLAUDE_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(logged.status, `${logged.stdout}${logged.stderr}`).toBe(0);
    expect(logged.stderr).not.toContain("more than one chat has sent messages");
  });

  test("two chats that joined through their turns alone still make the work's chat ambiguous", () => {
    // Both met the workspace before the choice; the choice is made here; both speak. Each hook turn joins its chat
    // read-only (the binding file still says no record until the chat's own next command writes it), so the one-chat
    // rule must read the chats the way the door does, not the file on disk.
    const proj = openWork();
    writeSessionBinding(proj, FIRST, "default", null, "unjoined");
    said(proj, "approve", FIRST);
    said(proj, "no, hold on");
    expect(humanTurns(proj)).toHaveLength(2);
    expect(readSessionBinding(proj, FIRST)).toMatchObject({ intent: null, source: "unjoined" });
    const id = readdirSync(join(proj, "aidlc", ".aidlc-sessions", "messages")).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(proj, "aidlc", ".aidlc-sessions", "messages", name), "utf-8")) as { id: string; session: string | null })
      .find((message) => message.session === FIRST)!.id;
    const logged = spawnSync(BUN, [LOG, "decision", "--stage", "requirements-analysis", "--decision", "Approve the draft", "--message", id, "--project-dir", proj], {
      cwd: proj,
      env: { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: undefined, AIDLC_SESSION_OVERRIDE_SOURCE: undefined, CODEX_THREAD_ID: undefined, CLAUDE_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(logged.status, `${logged.stdout}${logged.stderr}`).not.toBe(0);
    expect(`${logged.stdout}${logged.stderr}`).toContain("more than one chat has sent messages");
  });

  test("words typed in a chat before the work was chosen here do not make the work's chat ambiguous afterwards", () => {
    // Chat B spoke while it was on nothing (no cursor yet). Then the record is chosen here, and chat A, on the work,
    // approves. B's old words were never a turn on this work, so they do not count against A's approval now.
    const proj = freshClone();
    said(proj, "hello there");
    expect(humanTurns(proj)).toHaveLength(0);
    writeFileSync(join(intentsDirOf(proj, "default"), "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
    writeSessionBinding(proj, FIRST, "default", DEFAULT_RECORD_DIR, "switch");
    said(proj, "approve", FIRST);
    expect(humanTurns(proj)).toHaveLength(1);
    const id = readdirSync(join(proj, "aidlc", ".aidlc-sessions", "messages")).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(proj, "aidlc", ".aidlc-sessions", "messages", name), "utf-8")) as { id: string; session: string | null })
      .find((message) => message.session === FIRST)!.id;
    const logged = spawnSync(BUN, [LOG, "decision", "--stage", "requirements-analysis", "--decision", "Approve the draft", "--message", id, "--project-dir", proj], {
      cwd: proj,
      env: { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: undefined, AIDLC_SESSION_OVERRIDE_SOURCE: undefined, CODEX_THREAD_ID: undefined, CLAUDE_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(logged.status, `${logged.stdout}${logged.stderr}`).toBe(0);
    expect(`${logged.stdout}${logged.stderr}`).not.toContain("more than one chat has sent messages");
  });
});
