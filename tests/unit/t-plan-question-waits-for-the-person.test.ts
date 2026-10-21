// covers: subcommand:aidlc-orchestrate:next, function:scopeConfirmAskDirective, function:noReplySince
//
// The plan question is the person's: its answer starts work only once a message
// of theirs is on record after the question was asked. Seen in the nightly
// Copilot release journey (`copilot -p`, one shot per line): the agent read the
// host's "noninteractive" framing, ran the question's own confirm command in the
// same turn, and the engine started the bugfix plan with no reply from the
// person. A reply typed in the chat, a pick in a question box, or the agent's
// own proposal step are unchanged; the guard's switch and the person's own
// terminal lift the check, as at a stage gate. A message the host's prompt hook
// never saw (Copilot CLI's PowerShell check timed out on a Windows runner) leaves
// nothing on record while AI-DLC's other hooks run: the plan still waits then.

import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { recordPreWorkflowHeartbeat } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { noReplySince, saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  removeWorkspaceRecord,
  resetAidlcEnv,
  runOrchestrateNext,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(AIDLC_SRC, "tools");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const SESSION = "plan-question-chat-1";
const OTHER = "plan-question-chat-2";
const REQUEST = /--request ([0-9a-f]{8})/;
const LINE = "/aidlc fix the greeter: it says hello instead of greeting the person by name";

type Directive = Record<string, unknown> & { kind?: string; message?: string; confirm_command?: string; compose_command?: string };

/** The person's guard profile in the chat `session`: the presence check on. */
function chatEnv(proj: string, session: string): NodeJS.ProcessEnv {
  return {
    ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: session,
    CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj,
  };
}

function next(proj: string, args: string[], env: NodeJS.ProcessEnv): Directive {
  const r = runOrchestrateNext(join(TOOLS, "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env });
  expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
  return r.directive as Directive;
}

/** What the person's host hands the prompt hook: a typed line, or a question box's pick. */
function hook(proj: string, session: string, payload: Record<string, unknown>): void {
  const r = spawnSync(process.execPath, [join(TOOLS, "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj, input: JSON.stringify({ session_id: session, ...payload }), env: chatEnv(proj, session), encoding: "utf-8",
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}
// A message keeps whole seconds, so one in the question's own second counts as a
// reply. The agent's steps between the person's line and the question it builds
// take seconds; here each step waits for the next second the way they would.
const later = (): void => Bun.sleepSync(1005 - (Date.now() % 1000));
const typed = (proj: string, session: string, prompt: string): void =>
  hook(proj, session, { hook_event_name: "UserPromptSubmit", prompt });
const picked = (proj: string, session: string, label: string): void => hook(proj, session, {
    hook_event_name: "PostToolUse", tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which plan?", options: [{ label }, { label: "Use a different plan" }] }] },
    tool_response: { answers: { "Which plan?": label } },
  });

/** AI-DLC's PreToolUse guard, as the host runs it before the agent's engine command. */
function guardRuns(proj: string, session: string, args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync(process.execPath, [GUARD], {
    cwd: proj, env, encoding: "utf-8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: session, cwd: proj, tool_name: "Bash",
      tool_input: { command: `bun .claude/tools/aidlc-orchestrate.ts next ${args.join(" ")}` },
    }),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

/** The agent's engine command, with the host's hooks running for it. */
function agent(proj: string, session: string, args: string[], env = chatEnv(proj, session)): Directive {
  guardRuns(proj, session, args, env);
  return next(proj, args, env);
}

/** Every heartbeat file under the project's AI-DLC folder. */
function heartbeats(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) heartbeats(path, found);
    else if (name.endsWith(".last")) found.push(path);
  }
  return found;
}

/** A day later: the message store has pruned, and every heartbeat is that old. */
function aDayLater(proj: string): void {
  rmSync(join(proj, "aidlc", ".aidlc-sessions", "messages"), { recursive: true, force: true });
  const old = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const path of heartbeats(join(proj, "aidlc"))) writeFileSync(path, old);
}

/** The `next` arguments of a command the engine handed out. */
function answerArgs(command: unknown): string[] {
  const text = String(command);
  return text.slice(text.indexOf(" next ") + 6).split(" ");
}

/** The person's line reached no prompt hook; the agent's proposal step and the plan question, hooks running for each. */
function planQuestionUnseen(proj: string, session: string, args: string[] = ["--", LINE.replace(/^\/aidlc /, "")]): Directive {
  const proposal = agent(proj, session, args);
  const id = REQUEST.exec(String(proposal.message))?.[1];
  expect(id, String(proposal.message).slice(0, 300)).toBeDefined();
  const ask = agent(proj, session, ["--propose", "bugfix", "--request", id!]);
  expect(ask.kind, JSON.stringify(ask).slice(0, 300)).toBe("ask");
  return ask;
}

/** The person's first line, the agent's proposal step, and the plan question it returns. */
function planQuestion(proj: string, env: NodeJS.ProcessEnv): Directive {
  typed(proj, SESSION, LINE);
  later();
  const proposal = next(proj, ["--", LINE.replace(/^\/aidlc /, "")], env);
  const id = REQUEST.exec(String(proposal.message))?.[1];
  expect(id, String(proposal.message).slice(0, 300)).toBeDefined();
  const ask = next(proj, ["--propose", "bugfix", "--request", id!], env);
  expect(ask.kind, JSON.stringify(ask).slice(0, 300)).toBe("ask");
  return ask;
}

const startsWork = (d: Directive): boolean => d.kind === "print" && String(d.message).includes("intent create");
const waits = (d: Directive): boolean =>
  d.kind === "print" && !String(d.message).includes("intent create") && String(d.message).includes("has not answered the plan question");

let proj = "";
beforeAll(() => resetAidlcEnv());
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

function fresh(): string {
  const p = createTestProject();
  removeWorkspaceRecord(p);
  return p;
}

describe("t-plan-question-waits-for-the-person", () => {
  test("the agent running the plan question's confirm command before the person replies starts nothing", () => {
    proj = fresh();
    const env = chatEnv(proj, SESSION);
    const ask = planQuestion(proj, env);
    const d = next(proj, answerArgs(ask.confirm_command), env);
    expect(waits(d), JSON.stringify(d).slice(0, 500)).toBe(true);
    // Nor any other plan, the tailored one, or the question's id alone.
    expect(waits(next(proj, ["--scope", "feature", "--request", REQUEST.exec(String(ask.confirm_command))![1]], env))).toBe(true);
    expect(waits(next(proj, answerArgs(ask.compose_command), env))).toBe(true);
    expect(waits(next(proj, ["--request", REQUEST.exec(String(ask.confirm_command))![1]], env))).toBe(true);
  });

  test("the agent skipping the plan question with its proposal step's id starts nothing", () => {
    proj = fresh();
    const env = chatEnv(proj, SESSION);
    typed(proj, SESSION, LINE);
    later();
    const proposal = next(proj, ["--", LINE.replace(/^\/aidlc /, "")], env);
    const id = REQUEST.exec(String(proposal.message))![1];
    expect(waits(next(proj, ["--scope", "bugfix", "--request", id], env))).toBe(true);
  });

  test("the person's typed reply after the question starts the plan they picked", () => {
    proj = fresh();
    const env = chatEnv(proj, SESSION);
    const ask = planQuestion(proj, env);
    typed(proj, SESSION, "1");
    expect(startsWork(next(proj, answerArgs(ask.confirm_command), env))).toBe(true);
  });

  test("the person's pick in a question box starts the plan they picked", () => {
    proj = fresh();
    const env = chatEnv(proj, SESSION);
    const ask = planQuestion(proj, env);
    picked(proj, SESSION, 'Go ahead with the "bugfix" plan');
    expect(startsWork(next(proj, answerArgs(ask.confirm_command), env))).toBe(true);
  });

  test("a command line typed after the question is no reply to it; a typed plan pick still is", () => {
    proj = fresh();
    const env = chatEnv(proj, SESSION);
    const ask = planQuestion(proj, env);
    // A settings-only line asks for a setting, not for a plan.
    typed(proj, SESSION, "/aidlc --plan-approval off");
    expect(waits(next(proj, answerArgs(ask.confirm_command), env))).toBe(true);
    typed(proj, SESSION, "/aidlc --scope bugfix");
    expect(startsWork(next(proj, answerArgs(ask.confirm_command), env))).toBe(true);
  });

  test("the tailored plan typed as a bare /aidlc compose answers the question", () => {
    proj = fresh();
    const env = chatEnv(proj, SESSION);
    const ask = planQuestion(proj, env);
    typed(proj, SESSION, "/aidlc compose");
    const d = next(proj, answerArgs(ask.compose_command), env);
    expect(waits(d), JSON.stringify(d).slice(0, 400)).toBe(false);
    expect(String(d.message)).toContain("composer");
  });

  test("another chat's message is no reply in this one", () => {
    proj = fresh();
    const env = chatEnv(proj, SESSION);
    const ask = planQuestion(proj, env);
    typed(proj, OTHER, "1");
    expect(waits(next(proj, answerArgs(ask.confirm_command), env))).toBe(true);
  });

  test("a reply the hook kept under another id for this chat still answers it", () => {
    proj = fresh();
    const env = chatEnv(proj, SESSION);
    const ask = planQuestion(proj, env);
    typed(proj, OTHER, "1");
    // The engine names a chat no message was kept for: every chat's messages are read.
    expect(startsWork(next(proj, answerArgs(ask.confirm_command), chatEnv(proj, "named-by-the-engine")))).toBe(true);
  });

  test("a message keeps whole seconds: one in the question's own second is after it, one a second before is not", () => {
    proj = fresh();
    const kept = (
      at: string, session: string, text = "1", words: string | null = text,
      settings: Array<{ key: string; value: string }> = [],
    ): void => {
      saveMessage(proj, {
        session, at, source: "prompt", text, picker: null, words, settings,
        route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
      });
    };
    // Whole seconds a minute ago, as the hook writes them; the store keeps a day.
    const second = Math.floor(Date.now() / 1000) * 1000 - 60_000;
    const at = (offset: number): string => new Date(second + offset).toISOString().replace(/\.\d{3}Z$/, "Z");
    const asked = (offset: number): string => new Date(second + offset).toISOString();
    expect(noReplySince(proj, SESSION, asked(5_900))).toBe(false);
    kept(at(4_000), SESSION);
    expect(noReplySince(proj, SESSION, asked(5_900))).toBe(true);
    kept(at(5_000), SESSION);
    expect(noReplySince(proj, SESSION, asked(5_900))).toBe(false);
    // Another chat's later message is no reply here; a chat with nothing kept reads every chat's.
    kept(at(9_000), OTHER);
    expect(noReplySince(proj, SESSION, asked(6_100))).toBe(true);
    expect(noReplySince(proj, "named-by-the-engine", asked(6_100))).toBe(false);
    // A line that only sets something is no reply; a prompt whose words the host did
    // not pass on (text "") may be one.
    kept(at(10_000), SESSION, "/aidlc --plan-approval off", null, [{ key: "plan-approval", value: "off" }]);
    expect(noReplySince(proj, SESSION, asked(9_500))).toBe(true);
    kept(at(11_000), SESSION, "", null);
    expect(noReplySince(proj, SESSION, asked(10_500))).toBe(false);
  });

  test("a line the host's prompt hook never saw, while AI-DLC's other hooks run: the plan still waits for the person", () => {
    proj = fresh();
    const ask = planQuestionUnseen(proj, SESSION);
    const d = agent(proj, SESSION, answerArgs(ask.confirm_command));
    expect(waits(d), JSON.stringify(d).slice(0, 500)).toBe(true);
    // Their reply, which the prompt hook does see, starts the plan they picked.
    typed(proj, SESSION, "1");
    expect(startsWork(agent(proj, SESSION, answerArgs(ask.confirm_command)))).toBe(true);
  });

  test("the same, answered in a new chat: the reply there starts the plan", () => {
    proj = fresh();
    const ask = planQuestionUnseen(proj, SESSION);
    typed(proj, OTHER, "1");
    expect(startsWork(agent(proj, OTHER, answerArgs(ask.confirm_command)))).toBe(true);
  });

  test("a first line that names the plan starts it with no plan question, even with nothing on record", () => {
    proj = fresh();
    expect(startsWork(agent(proj, SESSION, ["--scope", "bugfix", "--", LINE.replace(/^\/aidlc /, "")]))).toBe(true);
  });

  test("nothing on record while the hooks are not running now, or for an unattended driver: the answer runs as before", () => {
    proj = fresh();
    // Hooks that last ran a day ago: the hooks-off and doctor steps own that.
    recordPreWorkflowHeartbeat(proj, "plan-approval-guard");
    aDayLater(proj);
    const env = chatEnv(proj, SESSION);
    const proposal = next(proj, ["--", LINE.replace(/^\/aidlc /, "")], env);
    const ask = next(proj, ["--propose", "bugfix", "--request", REQUEST.exec(String(proposal.message))![1]], env);
    expect(startsWork(next(proj, answerArgs(ask.confirm_command), env))).toBe(true);
    // An unattended driver's prompts are never kept, and its hooks do run.
    const unattended = fresh();
    try {
      const driver = { ...chatEnv(unattended, SESSION), AIDLC_UNATTENDED: "1" };
      const proposed = agent(unattended, SESSION, ["--", LINE.replace(/^\/aidlc /, "")], driver);
      const offer = agent(unattended, SESSION, ["--propose", "bugfix", "--request", REQUEST.exec(String(proposed.message))![1]], driver);
      expect(startsWork(agent(unattended, SESSION, answerArgs(offer.confirm_command), driver))).toBe(true);
    } finally {
      cleanupTestProject(unattended);
    }
  });

  test("earlier work parked in the project, a day later, a new chat's line the prompt hook never saw: the plan waits", () => {
    proj = fresh();
    const ask = planQuestion(proj, chatEnv(proj, SESSION));
    typed(proj, SESSION, "1");
    const go = agent(proj, SESSION, answerArgs(ask.confirm_command));
    const create = /intent create (.*?)`/.exec(String(go.message))?.[1];
    expect(create, String(go.message).slice(0, 300)).toBeDefined();
    const made = spawnSync(process.execPath, [
      join(TOOLS, "aidlc.ts"), "engine", "intent", "create", ...create!.replace('"<2-3 word kebab essence>"', "first-fix").split(" "),
    ], { cwd: proj, env: chatEnv(proj, SESSION), encoding: "utf-8" });
    expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
    const parked = spawnSync(process.execPath, [join(TOOLS, "aidlc-orchestrate.ts"), "park", "--project-dir", proj], {
      cwd: proj, env: chatEnv(proj, SESSION), encoding: "utf-8",
    });
    expect(parked.status, `${parked.stdout}${parked.stderr}`).toBe(0);
    aDayLater(proj);
    // The guard beats in the parked work's record now, where the engine reads.
    const second = planQuestionUnseen(proj, OTHER, ["--new-intent", "--", "fix the farewell: it says bye"]);
    const d = agent(proj, OTHER, answerArgs(second.confirm_command));
    expect(waits(d), JSON.stringify(d).slice(0, 500)).toBe(true);
    typed(proj, OTHER, "1");
    expect(startsWork(agent(proj, OTHER, answerArgs(second.confirm_command)))).toBe(true);
  });

  test("with the presence check switched off, or a prompt hook that ran but kept no message, the answer runs as before", () => {
    proj = fresh();
    const env = chatEnv(proj, SESSION);
    const ask = planQuestion(proj, env);
    expect(startsWork(next(proj, answerArgs(ask.confirm_command), { ...env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" }))).toBe(true);
    // Hooks that beat but keep no message (a store that failed, say): nothing to
    // tell by, nothing refused. Hooks that never ran are the hooks-off step's.
    const bare = fresh();
    try {
      recordPreWorkflowHeartbeat(bare, "record-human-turn");
      const proposal = next(bare, ["--", LINE.replace(/^\/aidlc /, "")], chatEnv(bare, SESSION));
      const id = REQUEST.exec(String(proposal.message))![1];
      const offer = next(bare, ["--propose", "bugfix", "--request", id], { ...chatEnv(bare, SESSION), AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
      const d = next(bare, answerArgs(offer.confirm_command), chatEnv(bare, SESSION));
      expect(startsWork(d), JSON.stringify(d).slice(0, 400)).toBe(true);
    } finally {
      cleanupTestProject(bare);
    }
  });
});
