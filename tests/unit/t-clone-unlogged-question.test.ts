// covers: hook:aidlc-record-human-turn, subcommand:aidlc-log:answer, subcommand:aidlc-log:decision
// covers: function:handleAnswer, function:messageBeforeJoining, function:personsGateReply
//
// t-clone-unlogged-question: a teammate answered the Requirements questions in their file and committed, and the
// agent on that machine had written the file without logging its question. The work is picked up in a clone with
// "i already answered the requirements questions in the file, carry on". The clone has no selection (it is
// git-ignored), so the human-turn hook keeps that message and records no turn for it; with no question on record the
// step after the pick runs the stage, and the clone's agent logs the question and its answer itself, naming no
// message. Measured live on Codex (2 of 4 clones on 2.11.2 preview .2): the answer was refused with no reply on
// record, and the person read "Your answer didn't reach AI-DLC. Please give it once more."; 2.11.1 went on in 5 of 5,
// its refusal naming their message. Now the refusal names that message again (messageBeforeJoining), the agent's
// retry with --message records the answer with their words, and no turn is made for it, so what a later gate joins
// (personsGateReply) is only what they say after it. A message that came before the work was on record (the one a
// piece of work starts with) is named by no refusal.
//
// Spawns each tree's own engine and each host's own human-turn hook, as t-clone-answer-in-the-file does.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, REPO_ROOT, cleanupTestProject, createOrchestrationTestProject, intentsDirOf, seededRecordDir } from "../harness/fixtures.ts";
import {
  buildState, type Directive, env, exec, type Harness, type RunOptions, SECOND_SESSION, say, UTILITY,
} from "../harness/aidlc-input-corpus.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
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
// The clone's chat: it never joined the work on the teammate's machine.
const CLONE: RunOptions = { session: SECOND_SESSION };
const HARNESSES: Array<"codex" | "claude"> = ["codex", "claude"];

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
  const session = opts.session ?? SECOND_SESSION;
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
 * The teammate's work at Requirements Analysis: the stage started and its questions file written and answered in
 * the file, with no question on record. Cloned: the record and the registry are there; the selection, that
 * machine's sessions and engine files and its clone id are not.
 */
async function clonedWork(harness: "codex" | "claude"): Promise<string> {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  install(proj, harness);
  await buildState(proj, "work-open");
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${STAGE}-questions.md`),
    "# Questions\n\n## Q1\n\nShould a blank title be refused?\n\nA) Refuse it\nB) Save it as Untitled\n\n[Answer]: A\n", "utf-8");
  rmSync(join(intentsDirOf(proj, "default"), "active-intent"), { force: true });
  rmSync(join(proj, "aidlc", ".aidlc-sessions"), { recursive: true, force: true });
  rmSync(join(proj, "aidlc", ".aidlc-clone-id"), { force: true });
  rmSync(join(seededRecordDir(proj), ".aidlc-engine"), { recursive: true, force: true });
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

/** The person's words in the clone, then the agent's pick and switch: the step after it runs the stage. */
async function pickedUpInClone(proj: string, harness: "codex" | "claude"): Promise<string> {
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
  const step = await next(proj, harness, ["--request-file", file!], CLONE);
  // No question is on record, so the step names no answer for it (#3183's path does not run here).
  expect(String(step.message ?? "")).not.toContain(`--message ${id}`);
  return id;
}

/** `log` in that tree, as the clone's agent runs it. */
function log(proj: string, harness: "codex" | "claude", args: string[]) {
  return exec([process.execPath, join(tools(proj, harness), "aidlc-log.ts"), ...args, "--project-dir", proj], {
    cwd: proj, env: env(proj, CLONE),
  });
}

/** The clone's agent logs the question the teammate's agent never did, then its reading of the file as the answer. */
async function questionThenAnswer(proj: string, harness: "codex" | "claude", extra: string[] = []) {
  await beforeCommand(proj, harness, CLONE);
  const asked = await log(proj, harness, ["decision", "--stage", STAGE, "--decision", "Q1: should a blank title be refused?", "--options", "A: Refuse it,B: Save it as Untitled"]);
  expect(asked.status, `${asked.stdout}${asked.stderr}`).toBe(0);
  await beforeCommand(proj, harness, CLONE);
  return log(proj, harness, ["answer", "--stage", STAGE, ...extra, "--details", "Q1: A"]);
}

const answers = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "QUESTION_ANSWERED");

/**
 * What a gate at the stage would join for that chat (personsGateReply, and the Message Ids its row gets), read in a
 * process of its own as the engine reads it.
 */
async function gateJoin(proj: string, opts: RunOptions) {
  const script = "const { personsGateReply, windowMessageIds } = await import(process.env.CUQ_LIB); " +
    "const reply = personsGateReply(process.env.CUQ_PROJ, process.env.CUQ_CHAT, process.env.CUQ_STAGE); " +
    "console.log(JSON.stringify({ ...reply, ids: windowMessageIds(reply) }));";
  const r = await exec([process.execPath, "-e", script], {
    cwd: proj,
    env: {
      ...env(proj, opts), CUQ_LIB: join(AIDLC_SRC, "tools", "aidlc-lib.ts"), CUQ_PROJ: proj,
      CUQ_CHAT: opts.session ?? SECOND_SESSION, CUQ_STAGE: STAGE,
    },
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim()) as {
    words: string | null; messageId: string | null; replies: Array<{ id: string }>; ids: Record<string, string>;
  };
}

describe("an answer given in the file counts in a clone whose agent logs the question itself", () => {
  for (const harness of HARNESSES) {
    test(`${harness}: the refusal names their message, and the answer on it is recorded with their words`, async () => {
      const proj = await clonedWork(harness);
      const id = await pickedUpInClone(proj, harness);
      const refused = await questionThenAnswer(proj, harness);
      const said = `${refused.stdout}${refused.stderr}`;
      expect(refused.status, said).not.toBe(0);
      expect(said).toContain(`run the same command with --message ${id}; do not ask them again.`);
      expect(answers(proj)).toHaveLength(0);
      await beforeCommand(proj, harness, CLONE);
      const answered = await log(proj, harness, ["answer", "--stage", STAGE, "--message", id, "--details", "Q1: A"]);
      expect(answered.status, `${answered.stdout}${answered.stderr}`).toBe(0);
      const rows = answers(proj);
      expect(rows).toHaveLength(1);
      expect(auditBlockField(rows[0].block, "Message Id")).toBe(id);
      expect(auditBlockField(rows[0].block, "Person Reply")).toBe(WORDS);
    });

    test(`${harness}: what a later gate joins is only what they say after it`, async () => {
      const proj = await clonedWork(harness);
      const id = await pickedUpInClone(proj, harness);
      await questionThenAnswer(proj, harness);
      await beforeCommand(proj, harness, CLONE);
      const answered = await log(proj, harness, ["answer", "--stage", STAGE, "--message", id, "--details", "Q1: A"]);
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

  test("a message that came before the work was on record is named by no refusal", async () => {
    // The chat's message is kept while it is on no work; the work's record begins after it, as for the message a
    // piece of work starts with.
    const proj = createOrchestrationTestProject();
    created.push(proj);
    install(proj, "codex");
    await buildState(proj, "work-open");
    rmSync(join(intentsDirOf(proj, "default"), "active-intent"), { force: true });
    rmSync(join(proj, "aidlc", ".aidlc-sessions"), { recursive: true, force: true });
    const audit = join(seededRecordDir(proj), "audit");
    for (const shard of existsSync(audit) ? readdirSync(audit) : []) rmSync(join(audit, shard), { force: true });
    const typed = `$aidlc ${WORDS}`;
    expect((await say(proj, typed, "codex", CLONE)).status).toBe(0);
    const id = messageId(proj, typed);
    await laterSecond();
    const switched = await exec([process.execPath, join(tools(proj, "codex"), "aidlc.ts"), "engine", "intent", "switch", PIECE, "--project-dir", proj], {
      cwd: proj, env: env(proj, CLONE),
    });
    expect(switched.status, `${switched.stdout}${switched.stderr}`).toBe(0);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
    const refused = await questionThenAnswer(proj, "codex");
    const said = `${refused.stdout}${refused.stderr}`;
    expect(refused.status, said).not.toBe(0);
    expect(said).toContain("no new human reply has arrived for the question");
    expect(said).not.toContain(id);
  });

  test("a reply the same chat gave on other work is never offered for this one", async () => {
    // The chat answers other work in the project, then asks to pick up the teammate's work, whose question was
    // never logged: the refusal names the message that picked it up, never the reply given for the other work.
    const proj = createOrchestrationTestProject();
    created.push(proj);
    install(proj, "codex");
    await buildState(proj, "work-open");
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
    const made = await exec([process.execPath, UTILITY, "intent-create", "--scope", "bugfix", "--arguments", "fix the login session timeout", "--label", "auth", "--project-dir", proj], {
      cwd: proj, env: { ...process.env },
    });
    expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
    const other = readdirSync(intentsDirOf(proj, "default")).find((name) => name !== PIECE && /auth/.test(name));
    expect(other).toBeDefined();
    const engine = (args: string[]) => exec([process.execPath, join(tools(proj, "codex"), "aidlc.ts"), "engine", ...args, "--project-dir", proj], {
      cwd: proj, env: env(proj, CLONE),
    });
    const onOther = await engine(["intent", "switch", other!]);
    expect(onOther.status, `${onOther.stdout}${onOther.stderr}`).toBe(0);
    await laterSecond();
    expect((await say(proj, "Q1: A", "codex", CLONE)).status).toBe(0);
    const otherReply = messageId(proj, "Q1: A");
    await laterSecond();
    const pickup = `$aidlc switch to ${PIECE}, ${WORDS}`;
    expect((await say(proj, pickup, "codex", CLONE)).status).toBe(0);
    const pickupId = messageId(proj, pickup);
    const onThis = await engine(["intent", "switch", PIECE]);
    expect(onThis.status, `${onThis.stdout}${onThis.stderr}`).toBe(0);
    const refused = await questionThenAnswer(proj, "codex");
    const said = `${refused.stdout}${refused.stderr}`;
    expect(refused.status, said).not.toBe(0);
    expect(said).toContain(`run the same command with --message ${pickupId}; do not ask them again.`);
    expect(said).not.toContain(otherReply);
  });
});
