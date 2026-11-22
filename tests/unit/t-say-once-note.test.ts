// covers: hook:aidlc-rebuild-stage-graph, subcommand:aidlc-utility:config-change, function:engineErrorRelayLine, function:SAY_ONCE_NOTE_HARNESSES, function:leaveSayOnceNote, function:sayOnceNoteLine
//
// A check of the person's switched off in their name from a chat is said to
// them once, in the setter's own line, and the order that tells the agent so
// ("Say this to the person once, word for word:") is the agent's alone. On
// Codex and opencode the tool panel draws the first lines of the setter's
// output, so an order printed there was on the person's screen in the host's
// frame (live at main on Codex 0.164.0 and opencode 1.19.4). Claude Code,
// Codex and opencode hand the model a PostToolUse note the person does not
// see, so there the setter prints its lines alone and the Bash PostToolUse
// hook gives the agent the order with them, once, and never after the person
// has written again. Kiro CLI keeps the order in the output by decision, as
// Copilot, Cursor and Kiro IDE do.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import createAdapter, { type PluginInput } from "../../harness/opencode/plugin/aidlc-opencode-adapter.ts";
import { ENGINE_ERROR_RELAY_LABEL, engineErrorRelayLine } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT, seedAidlcMemory } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const SESSION = "01995000-7a11-7000-8000-0000000051b2";
const ORDER = "Say this to the person once, word for word:";
const SUMMARY_OFF = "The summary confirmation (it reads your words back to you before the work goes on) is off for this piece of work";
const HOOK_TEST_DRIVER = [BUN, join(REPO_ROOT, "tests", "harness", "aidlc-hook-driver.ts")] as const;
// The runner's fixture profile carries a presence bypass; only the person's own act may lower a check here.
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_UNATTENDED: "0",
  AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
  AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "0",
  AIDLC_DISABLE_SENSORS: "0",
  AIDLC_HARNESS_NAME: undefined,
  AIDLC_HARNESS_DIR: undefined,
  CODEX_THREAD_ID: undefined,
  CLAUDE_CODE_SESSION_ID: undefined,
  CLAUDE_PID: undefined,
};
const TREES = {
  claude: ".claude",
  codex: ".codex",
  opencode: ".aidlc",
  kiro: ".kiro",
  copilot: ".aidlc",
} as const;
type Tree = keyof typeof TREES;

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function chatEnv(proj: string): NodeJS.ProcessEnv {
  return { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: SESSION, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
}

// The person's project with one harness installed from dist, a piece of work
// open in this chat, and the shipped tools and hooks run as the host runs them.
function project(tree: Tree) {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  const dir = TREES[tree];
  cpSync(join(REPO_ROOT, "dist", tree, dir), join(proj, dir), { recursive: true });
  const spawn = (args: string[], env: NodeJS.ProcessEnv, input?: string) => {
    const result = spawnSync(BUN, args, {
      cwd: proj,
      env,
      encoding: "utf-8",
      ...(input === undefined ? {} : { input }),
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
  };
  const tool = (name: string) => join(proj, dir, "tools", name);
  const made = spawn([tool("aidlc-utility.ts"), "intent-create", "--scope", "enterprise", "--arguments",
    "say once fixture", "--label", "say-once", "--project-dir", proj], chatEnv(proj));
  expect(made.status, made.out + made.err).toBe(0);
  const setter = (id: string) =>
    `bun ${dir}/tools/aidlc.ts engine config set summary-confirmation off --message ${id}`;
  return {
    proj,
    setter,
    // The person types `prompt` in this chat; the shipped human-turn hook keeps it.
    said: (prompt: string): string => {
      const before = new Set(listMessages(proj).map((message) => message.id));
      const hook = spawn([tool("aidlc.ts"), "engine", "hook", "record-human-turn"], chatEnv(proj),
        JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }));
      expect(hook.status, hook.err).toBe(0);
      const kept = listMessages(proj).filter((message) => !before.has(message.id));
      expect(kept).toHaveLength(1);
      return kept[0].id;
    },
    // The setter as the agent runs it from the chat.
    set: (id: string): string => {
      const run = spawn([tool("aidlc.ts"), "engine", "config", "set", "summary-confirmation", "off", "--message", id,
        "--project-dir", proj], chatEnv(proj));
      expect(run.status, run.out + run.err).toBe(0);
      return run.out;
    },
    // The Bash PostToolUse hook as the host delivers it after that call.
    postToolUse: (command: string, stdout: string, callId = "call-setter"): string => {
      if (tree === "claude") {
        const run = spawn([tool("aidlc.ts"), "engine", "hook", "rebuild-stage-graph"], chatEnv(proj),
          JSON.stringify({
            hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Bash", tool_input: { command },
            tool_response: { stdout, stderr: "", interrupted: false },
          }));
        expect(run.status, run.err).toBe(0);
        return run.out;
      }
      if (tree === "codex") {
        const run = spawn([join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "rebuild-stage-graph"],
          { ...chatEnv(proj), AIDLC_SESSION_OVERRIDE: undefined },
          JSON.stringify({
            session_id: SESSION, turn_id: "019eb8c0-1f54-7691-920f-c83b886b1162", cwd: proj,
            hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: stdout,
            tool_use_id: callId,
          }));
        expect(run.status, run.err).toBe(0);
        return run.out;
      }
      throw new Error(`no subprocess PostToolUse for ${tree}`);
    },
  };
}

function noteOf(hookOut: string): string | undefined {
  const lines = hookOut.split(/\r?\n/).filter((line) => line.trim() !== "");
  expect(lines.length).toBeLessThanOrEqual(1);
  if (lines.length === 0) return undefined;
  const parsed = JSON.parse(lines[0]) as { systemMessage?: unknown; hookSpecificOutput?: Record<string, unknown> };
  expect(parsed.systemMessage).toBeUndefined();
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
  return parsed.hookSpecificOutput?.additionalContext as string;
}

function opencodeClient(): PluginInput["client"] {
  return {
    session: { get: async () => ({ data: {} }), prompt: async () => undefined },
    tui: { showToast: async () => undefined },
  };
}

describe("where the host hands the model a note the person does not see, the order rides it", () => {
  test.each(["claude", "codex"] as const)("%s: the setter prints its lines alone, and the hook gives the agent the order with them, once", (tree) => {
    const { said, set, setter, postToolUse } = project(tree);
    const id = said("turn the summary confirmation off");
    const out = set(id);
    expect(out).not.toContain(ORDER);
    expect(out).toStartWith(`${SUMMARY_OFF}, because you said: "turn the summary confirmation off".`);
    expect(noteOf(postToolUse(setter(id), out))).toBe(`${ORDER}\n${out.trimEnd()}`);
    // Said once: the next call, or Codex's second delivery of the same one, carries no note.
    expect(postToolUse(setter(id), out, "call-setter-again")).toBe("");
  });

  test("codex: the duplicate delivery of the setter's call repeats nothing", () => {
    const { said, set, setter, postToolUse } = project("codex");
    const id = said("turn the summary confirmation off");
    const out = set(id);
    expect(noteOf(postToolUse(setter(id), out))).toBe(`${ORDER}\n${out.trimEnd()}`);
    expect(postToolUse(setter(id), out)).toBe("");
  });

  test("claude: a call in another chat takes nothing", () => {
    const { proj, said, set, setter, postToolUse } = project("claude");
    const id = said("turn the summary confirmation off");
    const out = set(id);
    const other = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "rebuild-stage-graph"], {
      cwd: proj, env: chatEnv(proj), encoding: "utf-8",
      input: JSON.stringify({
        hook_event_name: "PostToolUse", session_id: "01995000-7a11-7000-8000-0000000051c3", tool_name: "Bash",
        tool_input: { command: setter(id) }, tool_response: { stdout: out, stderr: "", interrupted: false },
      }),
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(other.stdout ?? "").toBe("");
    expect(noteOf(postToolUse("git status --short", ""))).toBe(`${ORDER}\n${out.trimEnd()}`);
  });

  test("claude: a setter naming their earlier message, after a later one, still hands the order on its own call", () => {
    const { said, set, setter, postToolUse } = project("claude");
    const asked = said("turn the summary confirmation off");
    said("for this piece of work");
    const out = set(asked);
    expect(out).not.toContain(ORDER);
    expect(noteOf(postToolUse(setter(asked), out))).toBe(`${ORDER}\n${out.trimEnd()}`);
  });

  test("claude: once the person has written again, the note is dropped, never said late", () => {
    const { said, set, setter, postToolUse } = project("claude");
    const id = said("turn the summary confirmation off");
    const out = set(id);
    said("thanks, go on");
    expect(postToolUse(setter(id), out)).toBe("");
    expect(postToolUse("git status --short", "")).toBe("");
  });

  test("opencode: the panel keeps the setter's own lines, and the order with them follows the result the model reads", async () => {
    const { proj, said, set, setter } = project("opencode");
    const id = said("turn the summary confirmation off");
    const out = set(id);
    expect(out).not.toContain(ORDER);
    const adapter = await createAdapter({ client: opencodeClient(), directory: proj, aidlcCommand: HOOK_TEST_DRIVER });
    // opencode's TUI draws a bash call from its metadata.output; the model reads output.
    const result = { title: setter(id), output: out, metadata: { output: out, exit: 0 } };
    await adapter["tool.execute.after"](
      { tool: "bash", sessionID: SESSION, callID: "call-setter", args: { command: setter(id) } },
      result,
    );
    expect(result.metadata.output).toBe(out);
    expect(result.output).toBe(`${out.trimEnd()}\n\n${ORDER}\n${out.trimEnd()}`);
  });
});

describe("where no such note exists, the order stays in the setter's own output", () => {
  test.each(["kiro", "copilot"] as const)("%s: the order line first, then the setter's line, and the hook adds nothing", (tree) => {
    const { said, set } = project(tree);
    const out = set(said("turn the summary confirmation off")).split(/\r?\n/);
    expect(out[0]).toBe(ORDER);
    expect(out[1]).toStartWith(`${SUMMARY_OFF}, because you said: "turn the summary confirmation off".`);
  });
});

describe("the engine error relay on opencode", () => {
  test("its line carries the toast for the person and no note for the model, which keeps printing the error", () => {
    const line = JSON.parse(engineErrorRelayLine("Unknown scope \"x\".", "opencode") ?? "{}") as Record<string, unknown>;
    expect(line.systemMessage).toBe(`${ENGINE_ERROR_RELAY_LABEL}\n> Unknown scope "x".`);
    expect(line.hookSpecificOutput).toBeUndefined();
  });
});
