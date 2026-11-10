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
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, REPO_ROOT, runOrchestrateNext } from "../harness/fixtures.ts";
import { addPendingPersonLines, pendingPersonLines } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { inputsNote, planNote } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import { finishedAtCodeGeneration, reply as replyAfterFinish } from "../harness/code-generation-states.ts";

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
        `Say each change_notices line to the person ${tree.SAY_ONCE_BEFORE_THEY_REPLY}, and add nothing about why.`,
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
