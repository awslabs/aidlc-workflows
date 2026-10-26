// covers: hook:aidlc-record-human-turn, subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:answer
// covers: function:openQuestionReplyDirective, function:messageBeforeJoining, function:personsGateReply
//
// t-clone-answer-in-the-file: a teammate answered a stage's questions in its file and committed, and the work is
// picked up in a clone of the repo with "i already answered the questions in the file, carry on". The clone has no
// selection (it is git-ignored), so the human-turn hook keeps that message and records no turn for it, and after the
// pick the engine reads the words against the open question. Measured live on Codex 0.164.0 (2 of 2 clones): the
// answer command that step handed over named no message, `log answer` found no reply on record, and the person read
// "Your answer didn't reach AI-DLC. Please give it once more."; 2.11.1 went on to its summary confirmation. Now the
// step names that message on its answer command (messageBeforeJoining), the message's own proof (proveMessage) takes
// it, and the answer is recorded the first time, with their words. No turn is made for the message, so what a later
// gate joins (personsGateReply) is only what they say after it. A chat whose message is on the record as a turn, and
// a bare re-entry, keep the step they had.
//
// Spawns each tree's own engine and each host's own human-turn hook, as t-pick-reads-the-words does.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, REPO_ROOT, cleanupTestProject, createOrchestrationTestProject, intentsDirOf, seededRecordDir } from "../harness/fixtures.ts";
import {
  buildState, type Directive, env, exec, type Harness, type RunOptions, SECOND_SESSION, SESSION, say,
} from "../harness/aidlc-input-corpus.ts";
import {
  auditBlockField, readAuditShardEvents, writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const PIECE = "fixture-8000000000000001";
const STAGE = "requirements-analysis";
// The live run's words.
const WORDS = "hi, picking up the work from my other laptop. i already answered the requirements questions in the file, carry on";
const OPEN = `Stage "${STAGE}" has a question you asked that the person has not answered yet`;
// The clone's chat: it never joined the work on the teammate's machine.
const CLONE: RunOptions = { session: SECOND_SESSION };
const HARNESSES: Array<"codex" | "claude"> = ["codex", "claude"];

// Each tree's own tools; Claude Code's are the shipped ones the corpus harness runs.
const tools = (proj: string, harness: "codex" | "claude") =>
  harness === "codex" ? join(proj, ".codex", "tools") : join(AIDLC_SRC, "tools");
const entry = (harness: "codex" | "claude") => (harness === "codex" ? "$aidlc" : "/aidlc");

/** `next` as the agent runs it in that tree, with the load-steering continuations consumed. */
async function next(proj: string, harness: "codex" | "claude", args: string[], opts: RunOptions = {}): Promise<Directive> {
  let command = ["next", "--project-dir", proj, ...args];
  for (let attempts = 0; attempts < 100; attempts++) {
    const res = await exec([process.execPath, join(tools(proj, harness), "aidlc-orchestrate.ts"), ...command], {
      cwd: proj, env: env(proj, opts),
    });
    const directive = JSON.parse(res.stdout.trim()) as Directive;
    if (directive.kind !== "load-steering" || typeof directive.receipt !== "string") return directive;
    command = ["continue", directive.receipt, "--project-dir", proj];
  }
  throw new Error("steering continuation limit exceeded");
}

/** The host's own hook the tree registers (Claude Code's settings, Codex's hooks.json), so its hooks are known here. */
function install(proj: string, harness: "codex" | "claude"): void {
  if (harness === "codex") {
    if (!existsSync(join(proj, ".codex"))) cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(proj, ".codex"), { recursive: true });
    return;
  }
  mkdirSync(join(proj, ".claude"), { recursive: true });
  copyFileSync(join(AIDLC_SRC, "settings.json"), join(proj, ".claude", "settings.json"));
}

/** The host runs its tool hook before the agent's command, as every host does for each one. */
async function beforeCommand(proj: string, harness: "codex" | "claude", opts: RunOptions): Promise<void> {
  const session = opts.session ?? SESSION;
  const payload = { hook_event_name: "PreToolUse", session_id: session, cwd: proj, tool_name: "Bash", tool_input: { command: "next" } };
  if (harness === "codex") writeSessionPidEntry(proj, process.pid, session);
  const r = harness === "codex"
    ? await exec([process.execPath, join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "plan-approval-guard"], {
      cwd: proj,
      env: { ...env(proj, opts), CLAUDE_PROJECT_DIR: undefined, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined },
      input: JSON.stringify({ ...payload, turn_id: "t1" }),
    })
    : await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "plan-approval-guard"], {
      cwd: proj, env: env(proj, opts), input: JSON.stringify(payload),
    });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

// A message keeps whole seconds; the clone comes later, as a person's does.
const laterSecond = (): Promise<void> => Bun.sleep(1100);

/**
 * The teammate's work at Requirements Analysis: its question asked, answered in its file (`[Answer]: Yes`) and
 * committed. With `clone`, a clone of it: the record and the registry are there; the selection, that machine's
 * sessions and engine files and its clone id are not.
 */
async function work(harness: "codex" | "claude", clone: boolean): Promise<string> {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  install(proj, harness);
  await buildState(proj, "stage-question-asked");
  if (clone) {
    rmSync(join(intentsDirOf(proj, "default"), "active-intent"), { force: true });
    rmSync(join(proj, "aidlc", ".aidlc-sessions"), { recursive: true, force: true });
    rmSync(join(proj, "aidlc", ".aidlc-clone-id"), { force: true });
    rmSync(join(seededRecordDir(proj), ".aidlc-engine"), { recursive: true, force: true });
  }
  await laterSecond();
  return proj;
}

/** The id of the message the hook kept for `text`. */
function messageId(proj: string, text: string): string {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "messages");
  const ids = readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as { id: string; text: string })
    .filter((message) => message.text === text).map((message) => message.id);
  expect(ids.length).toBe(1);
  return ids[0];
}

/** The open question's answer command in a step, and the step itself. */
function answerCommand(d: Directive): string {
  const message = String(d.message ?? "");
  expect(message).toContain(OPEN);
  const command = /`([^`]* answer --stage [^`]*)`/.exec(message)?.[1];
  expect(command, message).toBeDefined();
  return command!;
}

/** The person's words in the clone, then the agent's pick, switch and the step the pick names after it. */
async function pickedUpInClone(proj: string, harness: "codex" | "claude"): Promise<{ step: Directive; id: string }> {
  const typed = `${entry(harness)} ${WORDS}`;
  const said = await say(proj, typed, harness as Harness, CLONE);
  expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
  const id = messageId(proj, typed);
  expect(String((await next(proj, harness, [WORDS], CLONE)).message)).toContain("none is selected in this chat");
  const picked = String((await next(proj, harness, ["--pick", PIECE], CLONE)).message);
  const file = /next --request-file ([^`\s]+)` and follow what it returns/.exec(picked)?.[1];
  expect(file, picked).toBeDefined();
  const switched = await exec([process.execPath, join(tools(proj, harness), "aidlc.ts"), "engine", "intent", "switch", PIECE, "--project-dir", proj], {
    cwd: proj, env: env(proj, CLONE),
  });
  expect(switched.status, `${switched.stdout}${switched.stderr}`).toBe(0);
  await beforeCommand(proj, harness, CLONE);
  return { step: await next(proj, harness, ["--request-file", file!], CLONE), id };
}

/** `log answer` in that tree, as the step names it, with the agent's reading of the file in place of the placeholder. */
async function logAnswer(proj: string, harness: "codex" | "claude", command: string, opts: RunOptions) {
  const flags = command.replace(/^.* answer /, "").replace(/ --details '<[^>]+>'$/, "");
  expect(flags, command).not.toContain("'");
  return exec([process.execPath, join(tools(proj, harness), "aidlc-log.ts"), "answer", ...flags.split(" "), "--details", "Refuse it", "--project-dir", proj], {
    cwd: proj, env: env(proj, opts),
  });
}

const answers = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "QUESTION_ANSWERED");

/**
 * What a gate at the stage would join for that chat (personsGateReply, and the Message Ids its row gets), read in a
 * process of its own as the engine reads it: this one wrote the teammate's rows and keeps their shard as its own.
 */
async function gateJoin(proj: string, opts: RunOptions) {
  const script = "const { personsGateReply, windowMessageIds } = await import(process.env.CAC_LIB); " +
    "const reply = personsGateReply(process.env.CAC_PROJ, process.env.CAC_CHAT, process.env.CAC_STAGE); " +
    "console.log(JSON.stringify({ ...reply, ids: windowMessageIds(reply) }));";
  const r = await exec([process.execPath, "-e", script], {
    cwd: proj,
    env: {
      ...env(proj, opts), CAC_LIB: join(AIDLC_SRC, "tools", "aidlc-lib.ts"), CAC_PROJ: proj, CAC_CHAT: opts.session ?? SESSION,
      CAC_STAGE: STAGE,
    },
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim()) as {
    words: string | null; messageId: string | null; replies: Array<{ id: string }>; ids: Record<string, string>;
  };
}

describe("an answer given in the file before the work is picked up in a clone counts the first time", () => {
  for (const harness of HARNESSES) {
    test(`${harness}: the step after the pick names their message, and its answer is recorded with their words`, async () => {
      const proj = await work(harness, true);
      const { step, id } = await pickedUpInClone(proj, harness);
      const command = answerCommand(step);
      expect(command).toContain(` --message ${id} `);
      const answered = await logAnswer(proj, harness, command, CLONE);
      expect(answered.status, `${answered.stdout}${answered.stderr}`).toBe(0);
      const rows = answers(proj);
      expect(rows.length).toBe(1);
      expect(auditBlockField(rows[0].block, "Message Id")).toBe(id);
      expect(auditBlockField(rows[0].block, "Person Reply")).toBe(WORDS);
      expect(readAuditShardEvents(proj).some((row) => row.event === "ERROR_LOGGED")).toBe(false);
    });

    test(`${harness}: the clone's step is a joined chat's step for the same words, with their message named`, async () => {
      const clone = await work(harness, true);
      const { step, id } = await pickedUpInClone(clone, harness);
      const joined = await work(harness, false);
      const said = await say(joined, `${entry(harness)} ${WORDS}`, harness as Harness);
      expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
      const there = await next(joined, harness, [WORDS]);
      expect(answerCommand(there)).not.toContain("--message");
      // The kept words' ids differ, and the joined chat's step lists its replies by id and time.
      const same = (text: string) => text.replace(/--request [0-9a-f]{8}/g, "--request <id>").replace(/ Their replies since the last decision.*$/, "");
      expect(same(String(step.message)).replace(` --message ${id}`, "")).toBe(same(String(there.message)));
    });

    test(`${harness}: what a later gate joins is only what they say after it`, async () => {
      const proj = await work(harness, true);
      const { step, id } = await pickedUpInClone(proj, harness);
      const answered = await logAnswer(proj, harness, answerCommand(step), CLONE);
      expect(answered.status, `${answered.stdout}${answered.stderr}`).toBe(0);
      // No turn was made for the message that picked the work up.
      expect(readAuditShardEvents(proj).some((row) => row.event === "HUMAN_TURN" && auditBlockField(row.block, "Message Id") === id)).toBe(false);
      await laterSecond();
      const reply = await say(proj, "1", harness as Harness, CLONE);
      expect(reply.status, `${reply.stdout}${reply.stderr}`).toBe(0);
      const gate = await gateJoin(proj, CLONE);
      expect(gate.words).toBe("1");
      expect(gate.replies.map((entry) => entry.id)).toEqual([messageId(proj, "1")]);
      expect(gate.messageId).toBe(messageId(proj, "1"));
      expect(gate.ids).toEqual({});
    });
  }

  test("a bare re-entry in the clone after the pick shows the question again and names no message", async () => {
    const proj = await work("codex", true);
    await pickedUpInClone(proj, "codex");
    const again = await next(proj, "codex", ["--resume"], CLONE);
    expect(String(again.message)).toContain(OPEN);
    expect(answerCommand(again)).not.toContain("--message");
  });
});
