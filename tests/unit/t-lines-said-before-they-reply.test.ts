// t-lines-said-before-they-reply: a line the person must hear rides the step the agent speaks from in
// `change_notices`, with the one order in the step: said once, as written, in the last message the agent writes
// before the person replies.
//
// Measured on main a6486a805 (say-once-lands' PLAN): the same lines rode `narration` on the first of many steps in
// the agent's turn, with no order in the step. Copilot CLI headless writes one message in most turns, so a line
// handed mid-turn never reached it (a key to change after a gate reply 0 of 3); `claude -p` prints only the turn's
// last message, so the line saying where the work picks up, and that a folder with no code drops Reverse
// Engineering, was never printed (0 of 5 each). A line true only before the work it describes (plan approval off,
// inputs missing) keeps its own order in the step.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, REPO_ROOT, runOrchestrateNext } from "../harness/fixtures.ts";
import { addPendingPersonLines, pendingPersonLines } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { inputsNote, planNote } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import { sessionRecordPath } from "../../dist/claude/.claude/tools/aidlc-record-core.ts";
import {
  finishedAtCodeGeneration, openCodeGenerationGate, openRecoveryQuestion, reply as replyAfterFinish, runNamed, STATES,
  type StateBuilder,
} from "../harness/code-generation-states.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const AIDLC = join(AIDLC_SRC, "tools", "aidlc.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const chat = { ...process.env, AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };
const WHEN = "in the last message you write before they reply (when you end your turn with a question, the text you " +
  "write just before it)";
const NO_CODE = "The folder has no code yet, so I'm starting this as a new project without Reverse Engineering. " +
  "If the work is on existing code, tell me.";
const TREES = [
  ["claude", ".claude"], ["codex", ".codex"], ["copilot", ".aidlc"], ["cursor", ".cursor"], ["kiro", ".kiro"],
  ["kiro-ide", ".kiro"], ["opencode", ".aidlc"],
] as const;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop());
});

function project(): string {
  const p = createOrchestrationTestProject();
  tempDirs.push(p);
  return p;
}

function nextIn(proj: string, args: string[] = []): Record<string, unknown> {
  const result = runOrchestrateNext(ORCH, proj, args, { env: chat });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive ?? {};
}

function notices(step: Record<string, unknown>): string[] {
  return Array.isArray(step.change_notices) ? step.change_notices.map(String) : [];
}

// "/aidlc --scope <scope> <words>": the print that creates the work, then the creation itself, in this chat.
function created(proj: string, scope: string, words: string): void {
  const creation = nextIn(proj, ["--scope", scope, words]);
  expect(creation.kind).toBe("print");
  const request = /--request ([0-9a-f]{8})/.exec(String(creation.message))?.[1];
  expect(request, String(creation.message)).toBeDefined();
  const made = spawnSync(BUN, [
    AIDLC, "engine", "intent", "create", "--scope", scope, "--request", request ?? "", "--label", "the-work",
    "--project-dir", proj,
  ], { encoding: "utf-8", env: chat, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
}

describe("t-lines-said-before-they-reply: the lines the person must hear ride change_notices, said before they reply", () => {
  test("creation's lines ride the first step the agent speaks from, with the order, and not its narration", () => {
    const proj = project();
    created(proj, "poc", "build a lunch poll");
    const first = nextIn(proj);
    expect(first.kind).toBe("run-stage");
    const said = notices(first);
    expect(said.join(" ")).toStartWith("Setting up the poc workflow for this");
    expect(said.join(" ")).toContain(NO_CODE);
    expect(String(first.change_notices_note)).toContain(WHEN);
    // The stage's own line stays the step's narration, and nothing is carried twice.
    expect(String(first.narration ?? "")).not.toContain("Setting up the poc workflow");
    expect(String(first.narration ?? "")).not.toContain("no code yet");
    // Said once: the same step asked for again does not carry it.
    expect(notices(nextIn(proj)).join(" ")).not.toContain("Setting up the poc workflow");
  });

  test("picking the work back up: where it picks up rides change_notices, the stage's own line stays narration", () => {
    const proj = project();
    expect(spawnSync(BUN, [UTIL, "intent-create", "--scope", "classic", "--arguments", "show the asset description on hover",
      "--project-dir", proj], { encoding: "utf-8", env: chat, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) }).status)
      .toBe(0);
    const first = nextIn(proj, ["--resume"]);
    const pickUp = notices(first).find((line) => line.startsWith("Picking up where we left off, at "));
    expect(pickUp, JSON.stringify(first)).toMatch(
      /^Picking up where we left off, at [A-Z][^.]*\. If you'd rather redo it, go back to another stage, or start fresh, just say so\.$/,
    );
    expect(String(first.change_notices_note)).toContain(WHEN);
    expect(String(first.narration ?? "")).not.toContain("Picking up where we left off");
    const again = nextIn(proj, ["--resume"]);
    expect([...notices(again), String(again.narration ?? "")].join(" ")).not.toContain("Picking up where we left off");
  });

  test("a line kept for the next step (a key typed in a gate reply, a jump's kept line) rides that step's change_notices", () => {
    const proj = project();
    created(proj, "poc", "build a lunch poll");
    const line = "Your message looked like it held a key or password. AI-DLC keeps it out of its committed record.";
    expect(addPendingPersonLines(proj, SESSION, [line])).toBe(true);
    const step = nextIn(proj);
    expect(notices(step)).toContain(line);
    expect(String(step.narration ?? "")).not.toContain(line);
    expect(String(step.change_notices_note)).toContain(WHEN);
  });

  // The person writes: the prompt hook marks their turn and carries what they have not heard into it.
  function personWrites(proj: string, prompt = "ok, carry on"): void {
    const hook = spawnSync(BUN, [AIDLC, "engine", "hook", "record-human-turn"], {
      encoding: "utf-8", cwd: proj, env: { ...chat, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(hook.status, `${hook.stdout}${hook.stderr}`).toBe(0);
  }

  // The person answers a question box the agent showed (Claude Code's AskUserQuestion).
  function personAnswersBox(proj: string, question: string, answer: string): void {
    const questions = [{ question, options: [{ label: "Accept failure" }, { label: "Abort" }] }];
    const hook = spawnSync(BUN, [AIDLC, "engine", "hook", "record-human-turn"], {
      encoding: "utf-8", cwd: proj, env: { ...chat, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
        tool_input: { questions }, tool_response: { questions, answers: { [question]: answer } } }),
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(hook.status, `${hook.stdout}${hook.stderr}`).toBe(0);
  }

  test("a line kept for the reply rides every step the agent speaks from, past the age limit, until the person writes", () => {
    const proj = project();
    created(proj, "poc", "build a lunch poll");
    const reply = "Landed Unit beta with src/shared.ts settled by hand against what was already on main.";
    const ordinary = "An ordinary line that waited too long.";
    // Kept 20 minutes ago, as a long turn under Continue automatically does.
    const realNow = Date.now;
    Date.now = () => realNow() - 20 * 60 * 1000;
    try {
      expect(addPendingPersonLines(proj, SESSION, [reply], { forReply: true })).toBe(true);
      expect(addPendingPersonLines(proj, SESSION, [ordinary])).toBe(true);
    } finally {
      Date.now = realNow;
    }
    // Each step the agent speaks from carries it once, with the order: the one it stops on says it.
    const step = nextIn(proj);
    expect(notices(step).filter((line) => line === reply)).toHaveLength(1);
    expect(String(step.change_notices_note)).toContain(WHEN);
    // The line that waited too long as an ordinary one stays unsaid, as before.
    expect(notices(step)).not.toContain(ordinary);
    expect(notices(nextIn(proj)).filter((line) => line === reply)).toHaveLength(1);
    // The person wrote after a step carried it: it was said, so it goes.
    personWrites(proj);
    expect(pendingPersonLines(proj, SESSION).lines).not.toContain(reply);
  });

  test("a line kept for the reply that no step carried follows the person into their next turn", () => {
    const proj = project();
    created(proj, "poc", "build a lunch poll");
    const reply = "Landed Unit beta with src/shared.ts settled by hand against what was already on main.";
    expect(addPendingPersonLines(proj, SESSION, [reply], { forReply: true })).toBe(true);
    personWrites(proj);
    expect(pendingPersonLines(proj, SESSION).lines).toContain(reply);
    expect(notices(nextIn(proj))).toContain(reply);
  });

  // A question the agent asks in its own words (a failed check's halt, a stage's questions) is logged first: the
  // reply the person reads, so a line kept for the reply rides the log's output with the order. An ordinary line
  // stays for the next step, as before.
  test("a question the agent logs before asking it carries the line kept for the reply, once, and only that line", () => {
    const proj = project();
    created(proj, "poc", "build a lunch poll");
    const reply = "Landed Unit beta with src/shared.ts settled by hand against what was already on main.";
    const ordinary = "A line for the next step the agent speaks from.";
    expect(addPendingPersonLines(proj, SESSION, [reply], { forReply: true })).toBe(true);
    expect(addPendingPersonLines(proj, SESSION, [ordinary])).toBe(true);
    const logged = spawnSync(BUN, [LOG, "decision", "--stage", "requirements-analysis", "--decision",
      "Build and Test failed: how would you like to proceed?", "--options", "Accept failure,Abort", "--project-dir", proj,
    ], { encoding: "utf-8", env: chat, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(logged.status, `${logged.stdout}${logged.stderr}`).toBe(0);
    const out = JSON.parse(logged.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    expect(notices(out)).toEqual([reply]);
    expect(String(out.change_notices_note)).toContain(WHEN);
    // Both still wait: the ordinary line for the next step, the reply line until the person writes.
    expect(pendingPersonLines(proj, SESSION).lines).toEqual(expect.arrayContaining([ordinary, reply]));
  });

  // Seen on Claude Code: the agent asked Build and Test's failure question in its box without logging it, after
  // a summary that dropped the landing's commit and undo, and the person's answer cleared the line. A box the
  // engine never saw had no step of its own just before it, so the answer leaves the line for the steps after
  // it and the reply that ends the turn; a box logged first took the line with its log, so the answer clears it.
  test("a line kept for the reply rides on past a box the agent asked without logging it, and goes after a logged one", () => {
    const proj = project();
    created(proj, "poc", "build a lunch poll");
    const reply = "Landed Unit beta with src/shared.ts settled by hand against what was already on main.";
    const question = "Build and Test failed: how would you like to proceed?";
    expect(addPendingPersonLines(proj, SESSION, [reply], { forReply: true })).toBe(true);
    expect(notices(nextIn(proj))).toContain(reply);
    personAnswersBox(proj, question, "Accept failure");
    expect(pendingPersonLines(proj, SESSION).lines).toContain(reply);
    expect(notices(nextIn(proj)).filter((line) => line === reply)).toHaveLength(1);
    const logged = spawnSync(BUN, [LOG, "decision", "--stage", "requirements-analysis", "--decision", question,
      "--options", "Accept failure,Abort", "--project-dir", proj,
    ], { encoding: "utf-8", env: chat, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(logged.status, `${logged.stdout}${logged.stderr}`).toBe(0);
    personAnswersBox(proj, question, "Accept failure");
    expect(pendingPersonLines(proj, SESSION).lines).not.toContain(reply);
  });

  // Seen on Claude Code: the landing's line rode the steps to the end of the work and was said in the reply that
  // ended it; the person's next message, on work now finished, left it waiting with no age limit, for any later step
  // in the chat (new work, a redo) to say again. Their message after the work finished counts as on open work.
  test("a line kept for the reply that the last steps carried goes when the person writes after the work finished", () => {
    const proj = finishedAtCodeGeneration("relaxed", "on");
    tempDirs.push(proj);
    const reply = "Landed Unit beta with src/shared.ts settled by hand against what was already on main.";
    expect(addPendingPersonLines(proj, SESSION, [reply], { forReply: true })).toBe(true);
    const handed = pendingPersonLines(proj, SESSION);
    expect(handed.lines).toContain(reply);
    handed.said();
    const said = replyAfterFinish(proj, "Not now, leave the release for later.");
    expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
    expect(pendingPersonLines(proj, SESSION).lines).not.toContain(reply);
  });

  test("the one order is the same in every harness's tree: once, as written, before they reply", async () => {
    for (const [harness, dir] of TREES) {
      const tree = await import(join(REPO_ROOT, "dist", harness, dir, "tools", "aidlc-directive.ts"));
      expect(tree.CHANGE_NOTICES_NOTE, harness).toBe(
        `Say each notice listed beside this note to the person ${tree.SAY_ONCE_BEFORE_THEY_REPLY}, and add nothing about why.`,
      );
      expect(tree.SAY_ONCE_BEFORE_THEY_REPLY, harness).toBe(
        "once, as written (only a verb's tense may change to fit when you say it), as your own sentence with " +
          `nothing in front of it, ${WHEN}`,
      );
    }
  });

  // These two lines say what is about to happen, so they are said before the work, as their step's own order says.
  test("a line true only before the work keeps its own order: plan approval off, inputs missing", () => {
    expect(planNote({ status: "approved", skipped: true, notice: "Plan approval is off." }, "bun x"))
      .toStartWith("Say to the person first: Plan approval is off.");
    expect(inputsNote(["a.md"])).toStartWith('Say to the person once: "Some inputs this stage usually reads are not here');
  });
});

// The line the prompt hook queues for a message that holds a key, when that same message asks about the work: the
// reading the agent answers it from, or the print it stops on, says it, in the reply that answers. Measured on main
// ac4b02b63: the finished-work reading, a gate's reading and a typed --status ended the turn with the line still
// waiting, said late with a later step or dropped 15 minutes after it was queued, and a second key on finished work
// queued no line.
describe("t-lines-said-before-they-reply: a line waiting at the person's message is said with the reading that answers it", () => {
  const KEY_LINE = "Your message looked like it held a key or password. AI-DLC keeps it out of its committed record, " +
    "but this chat still received it, so if it is real, change it where it was issued.";
  const OTHER = "01995000-7a11-7000-8000-00000000f00d";
  // Fake keys, put together at run time: no line of this file is shaped like one.
  const run = (n: number): string => "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2eF4hJ6kL8nP0rS2uV4xY6zA8cD0fG2iL4oR6tU8wX0".repeat(4).slice(0, n);
  const TOKEN = `ghp_${run(36)}`;
  const SECOND = `ghp_${run(36).split("").reverse().join("")}`;

  function chatOn(proj: string, session = SESSION): Record<string, string | undefined> {
    return {
      ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
      AIDLC_SESSION_OVERRIDE: session, AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
    };
  }
  function step(proj: string, args: string[] = [], session = SESSION): Record<string, unknown> {
    const result = runOrchestrateNext(ORCH, proj, args, { env: chatOn(proj, session) });
    expect(result.directive, result.out).not.toBeNull();
    return result.directive ?? {};
  }
  function carriesKeyLine(said: Record<string, unknown>): void {
    expect(notices(said).filter((line) => line === KEY_LINE), JSON.stringify(said)).toHaveLength(1);
    expect(String(said.change_notices_note)).toContain(WHEN);
  }
  // The status command a reading names, run as the agent runs it.
  function statusFrom(proj: string, reading: Record<string, unknown>): string {
    const command = /`(bun [^`]* status[^`]*)`/.exec(String(reading.message ?? ""))?.[1];
    expect(command, String(reading.message)).toBeDefined();
    const out = runNamed(proj, command ?? "", { AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" });
    expect(out.status, `${out.stdout}${out.stderr}`).toBe(0);
    return `${out.stdout}${out.stderr}`;
  }
  // The person waited `minutes` before their next message.
  function aged(proj: string, minutes: number): void {
    const path = `${sessionRecordPath(proj, SESSION)}.person-lines`;
    if (!existsSync(path)) return;
    const saved = JSON.parse(readFileSync(path, "utf-8")) as { lines: Array<{ at: number }> };
    for (const line of saved.lines) line.at -= minutes * 60 * 1000;
    writeFileSync(path, `${JSON.stringify(saved)}\n`, "utf-8");
  }
  function finished(): string {
    const proj = finishedAtCodeGeneration("relaxed", "on");
    tempDirs.push(proj);
    return proj;
  }
  function built(id: string): string {
    const proj = (STATES.find((state) => state.id === id) as StateBuilder).build().proj;
    tempDirs.push(proj);
    return proj;
  }
  // The gate open and shown in this chat, as the person sees it before they write.
  function atGate(): string {
    const proj = openCodeGenerationGate("relaxed", "on");
    tempDirs.push(proj);
    const shown = step(proj);
    expect(shown.gate_only, JSON.stringify(shown)).toBe(true);
    return proj;
  }

  test("a question about finished work with a key in it: the finished-work reading says the line, once", () => {
    const proj = finished();
    const words = `what did this build? the deploy log printed ${TOKEN}`;
    expect(replyAfterFinish(proj, `/aidlc ${words}`).status).toBe(0);
    expect(pendingPersonLines(proj, SESSION).lines).toContain(KEY_LINE);
    const reading = step(proj, [words]);
    expect(reading.kind).toBe("print");
    expect(String(reading.message)).toContain("end your turn: run no other command");
    carriesKeyLine(reading);
    // Status stays a reader: it says nothing of its own about the line.
    expect(statusFrom(proj, reading)).not.toContain(KEY_LINE);
    expect(pendingPersonLines(proj, SESSION).lines).not.toContain(KEY_LINE);
    // Said once: a second question, and a bare look ten minutes on, do not say it again.
    const again = "and is anything left to do?";
    replyAfterFinish(proj, `/aidlc ${again}`);
    expect(JSON.stringify(step(proj, [again]))).not.toContain(KEY_LINE);
    aged(proj, 10);
    replyAfterFinish(proj, "/aidlc");
    const done = step(proj);
    expect(done.kind).toBe("done");
    expect(JSON.stringify(done)).not.toContain(KEY_LINE);
  });

  test("a typed /aidlc --status on finished work: the print the agent stops on says a waiting line", () => {
    const proj = finished();
    replyAfterFinish(proj, `/aidlc the log printed ${TOKEN}`);
    replyAfterFinish(proj, "/aidlc --status");
    const shown = step(proj, ["--status"]);
    expect(shown.kind).toBe("print");
    expect(String(shown.message)).toContain("then stop");
    carriesKeyLine(shown);
    expect(pendingPersonLines(proj, SESSION).lines).not.toContain(KEY_LINE);
  });

  test("a second key in a later message on the same finished work gets its own line", () => {
    const proj = finished();
    replyAfterFinish(proj, `/aidlc the log printed ${TOKEN}`);
    carriesKeyLine(step(proj));
    replyAfterFinish(proj, `/aidlc and the other log printed ${SECOND}`);
    expect(pendingPersonLines(proj, SESSION).lines).toContain(KEY_LINE);
    carriesKeyLine(step(proj));
    // A message with no key queues nothing.
    replyAfterFinish(proj, "/aidlc thanks");
    expect(pendingPersonLines(proj, SESSION).lines).not.toContain(KEY_LINE);
  });

  test("a question at the Code Generation gate with a key in it: the gate's reading says the line, and the gate shown again does not", () => {
    const proj = atGate();
    const words = `how much is left after this? the build printed ${TOKEN}`;
    expect(replyAfterFinish(proj, `/aidlc ${words}`).status).toBe(0);
    const reading = step(proj, [words]);
    expect(reading.kind).toBe("print");
    expect(String(reading.message)).toContain("run no other command");
    carriesKeyLine(reading);
    expect(statusFrom(proj, reading)).not.toContain(KEY_LINE);
    aged(proj, 10);
    replyAfterFinish(proj, "/aidlc --resume");
    expect(JSON.stringify(step(proj, ["--resume"]))).not.toContain(KEY_LINE);
    expect(pendingPersonLines(proj, SESSION).lines).not.toContain(KEY_LINE);
  });

  // The cost: when the words approve, the line is handed with the reading, before the stage that comes next, with the
  // order to say it in the last message before the person replies; the steps after it do not hand it again.
  test("an approval at the gate with a key in it: the reading hands the line once, and the next stage's step does not", () => {
    const proj = atGate();
    const words = `approve, and the build printed ${TOKEN}`;
    replyAfterFinish(proj, `/aidlc ${words}`);
    const reading = step(proj, [words]);
    carriesKeyLine(reading);
    // The approval the reading names, run as the agent runs it.
    const approval = /`(bun [^`]* report --stage [^`]* --result approved [^`]*)`/.exec(String(reading.message))?.[1];
    expect(approval, String(reading.message)).toBeDefined();
    const report = runNamed(proj, approval ?? "", { AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" });
    expect(report.status, `${report.stdout}${report.stderr}`).toBe(0);
    expect(report.stdout).not.toContain(KEY_LINE);
    const following = step(proj);
    expect(following.kind).not.toBe("done");
    expect(JSON.stringify(following)).not.toContain(KEY_LINE);
    expect(pendingPersonLines(proj, SESSION).lines).not.toContain(KEY_LINE);
  });

  // Each reading the agent may answer from: the open decisions and work in progress.
  const READINGS: Array<[string, () => string, string]> = [
    ["work in progress", () => built("S1"), "Work is in progress"],
    ["the code plan question", () => built("S3"), "The code plan question is open"],
    ["the recovery question", () => {
      const proj = openRecoveryQuestion();
      tempDirs.push(proj);
      return proj;
    }, "The recovery question for"],
  ];
  for (const [at, make, opens] of READINGS) {
    test(`a question about the work with a key in it, at ${at}: its reading says the line`, () => {
      const proj = make();
      const words = `how far along are we? the log printed ${TOKEN}`;
      expect(replyAfterFinish(proj, `/aidlc ${words}`).status).toBe(0);
      const reading = step(proj, [words]);
      expect(String(reading.message)).toContain(opens);
      carriesKeyLine(reading);
      expect(pendingPersonLines(proj, SESSION).lines).not.toContain(KEY_LINE);
    });
  }

  // The same cost for "carry on": the reading hands the line, and the stage's step after it does not.
  test("carry on with a key in it, while the work is in progress: the reading hands the line once, the stage's step does not", () => {
    const proj = built("S1");
    const words = `carry on, the log printed ${TOKEN}`;
    replyAfterFinish(proj, `/aidlc ${words}`);
    const reading = step(proj, [words]);
    expect(String(reading.message)).toContain("Work is in progress");
    carriesKeyLine(reading);
    const following = step(proj);
    expect(following.kind).toBe("run-stage");
    expect(JSON.stringify(following)).not.toContain(KEY_LINE);
    expect(pendingPersonLines(proj, SESSION).lines).not.toContain(KEY_LINE);
  });

  test("a line kept for the reply rides the finished-work reading, and the key line with it", () => {
    const proj = finished();
    const replyLine = "Landed Unit beta with src/shared.ts settled by hand against what was already on main.";
    const words = `what did this build? the deploy log printed ${TOKEN}`;
    replyAfterFinish(proj, `/aidlc ${words}`);
    expect(addPendingPersonLines(proj, SESSION, [replyLine], { forReply: true })).toBe(true);
    const reading = step(proj, [words]);
    expect(notices(reading)).toEqual(expect.arrayContaining([KEY_LINE, replyLine]));
    carriesKeyLine(reading);
  });

  test("a bare look at finished work says a waiting line, as before", () => {
    const proj = finished();
    replyAfterFinish(proj, `/aidlc the log printed ${TOKEN}`);
    const done = step(proj);
    expect(done.kind).toBe("done");
    carriesKeyLine(done);
  });

  test("a new chat on the same finished work never hears the first chat's line", () => {
    const proj = finished();
    replyAfterFinish(proj, `/aidlc the log printed ${TOKEN}`);
    replyAfterFinish(proj, "/aidlc", OTHER);
    expect(JSON.stringify(step(proj, [], OTHER))).not.toContain(KEY_LINE);
    expect(pendingPersonLines(proj, OTHER).lines).not.toContain(KEY_LINE);
    expect(pendingPersonLines(proj, SESSION).lines).toContain(KEY_LINE);
  });
});

// A hook that relays a command's output reads the waiting lines before the
// command runs and counts them said after it, so said() keeps what was written
// to the record in between: a line the command queued, a carry, a heard mark.
describe("t-lines-said-before-they-reply: said() keeps what was written after the read", () => {
  const record = (proj: string): string => `${sessionRecordPath(proj, SESSION)}.person-lines`;
  const raw = (proj: string): { work: string; lines: Array<Record<string, unknown>>; said: string[] } =>
    JSON.parse(readFileSync(record(proj), "utf-8"));
  const edit = (proj: string, change: (saved: ReturnType<typeof raw>) => void): void => {
    const saved = raw(proj);
    change(saved);
    writeFileSync(record(proj), `${JSON.stringify(saved)}\n`, "utf-8");
  };

  test("with nothing written since the read, the handed lines go and nothing else changes", () => {
    const proj = project();
    expect(addPendingPersonLines(proj, SESSION, ["First line."])).toBe(true);
    expect(addPendingPersonLines(proj, SESSION, ["Reply line."], { forReply: true })).toBe(true);
    const read = pendingPersonLines(proj, SESSION);
    expect(read.lines).toEqual(["First line.", "Reply line."]);
    read.said();
    expect(raw(proj).lines.map((entry) => [entry.line, entry.handed])).toEqual([["Reply line.", true]]);
  });

  test("a line queued after the read, even in the same words as one it handed, stays with its time and flags", () => {
    const proj = project();
    expect(addPendingPersonLines(proj, SESSION, ["Same words."])).toBe(true);
    const read = pendingPersonLines(proj, SESSION);
    edit(proj, (saved) => {
      saved.lines.push({ ...saved.lines[0], at: Number(saved.lines[0].at) + 1 });
      saved.lines.push({ line: "Kept for the reply.", at: 1234, turn: saved.lines[0].turn, reply: true });
    });
    read.said();
    const after = raw(proj).lines;
    expect(after.map((entry) => entry.line)).toEqual(["Same words.", "Kept for the reply."]);
    expect(after[1]).toEqual({ line: "Kept for the reply.", at: 1234, turn: after[1].turn, reply: true });
  });

  test("a carry and a heard mark written after the read stay as written", () => {
    const proj = project();
    expect(addPendingPersonLines(proj, SESSION, ["Handed line.", "Carried line."])).toBe(true);
    const read = pendingPersonLines(proj, SESSION);
    edit(proj, (saved) => {
      saved.lines[1] = { ...saved.lines[1], turn: "another-turn" };
      saved.said = ["Heard elsewhere."];
    });
    read.said();
    const after = raw(proj);
    expect(after.lines).toEqual([{ line: "Carried line.", at: after.lines[0].at, turn: "another-turn" }]);
    expect(after.said).toEqual(["Heard elsewhere."]);
  });
});
