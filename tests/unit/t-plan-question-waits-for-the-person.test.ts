// covers: subcommand:aidlc-orchestrate:next, function:scopeConfirmAskDirective, function:noReplySince
//
// The plan question is the person's: its answer starts work only once a message
// of theirs is on record after the question was asked. Seen in the nightly
// Copilot release journey (`copilot -p`, one shot per line): the agent read the
// host's "noninteractive" framing, ran the question's own confirm command in the
// same turn, and the engine started the bugfix plan with no reply from the
// person. A reply typed in the chat, a pick in a question box, or the agent's
// own proposal step are unchanged; the guard's switch and the person's own
// terminal lift the check, as at a stage gate.

import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
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

/** The `next` arguments of a command the engine handed out. */
function answerArgs(command: unknown): string[] {
  const text = String(command);
  return text.slice(text.indexOf(" next ") + 6).split(" ");
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

  test("with the presence check switched off, or no message on record at all, the answer runs as before", () => {
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
