// covers: function:applyIntentSettings, function:askedSwitchLine, subcommand:aidlc-utility:config-change, function:lowerFenceRemedy, function:lowerFenceSentence, function:isEngineToolCall
//
// A check switched off in the person's name from a chat is said to them once,
// in the setter's own line. The setter's output reaches only the agent, and
// Copilot (like Cursor and Kiro) has no hook line the person sees, so the
// setter's own result says that its line is the person's: one order line for
// the agent first, then its lines as they are. A live Copilot run (ans-up-01)
// switched the summary confirmation off on "1" and the person never heard it;
// in the same turn an order inside a tool's result ("Say to the person once")
// did reach the screen.
//
// The engine's own steps that already have the agent print the setter's output
// as it is name --verbatim, so the person never reads the order line; at the
// person's own terminal there is no agent and no order line. The agent is no
// longer asked to word the news itself, so it is said once. On Claude Code,
// Codex and opencode the order rides the shell call's PostToolUse note instead
// (t-say-once-note), so there the output is the setter's line alone.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, REPO_ROOT, runOrchestrateNext, seedAidlcMemory,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { isEngineToolCall, lowerFenceRemedy, lowerFenceSentence } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const SESSION = "01995000-7a11-7000-8000-0000000051a1";
const ORDER = "Say this to the person once, word for word:";
const SUMMARY_OFF = "The summary confirmation (it reads your words back to you before the work goes on) is off for this piece of work";
// The runner's fixture profile carries a presence bypass; only the person's own act may lower a check here.
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_UNATTENDED: "0",
  AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
  AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "0",
  AIDLC_DISABLE_SENSORS: "0",
};
const TOOLS = {
  claude: join(AIDLC_SRC, "tools"),
  copilot: join(REPO_ROOT, "dist", "copilot", ".aidlc", "tools"),
} as const;
type Tree = keyof typeof TOOLS;

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function chatEnv(proj: string): NodeJS.ProcessEnv {
  return { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: SESSION, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
}

function project(tree: Tree = "claude") {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  const tool = (name: string) => join(TOOLS[tree], name);
  const spawn = (file: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => {
    const result = spawnSync(BUN, [file, ...args], {
      cwd: proj,
      env,
      encoding: "utf-8",
      ...(input === undefined ? {} : { input }),
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
  };
  const made = spawn(tool("aidlc-utility.ts"), [
    "intent-create", "--scope", "enterprise", "--arguments", "setter line fixture", "--label", "setter-line",
    "--project-dir", proj,
  ], chatEnv(proj));
  expect(made.status, made.out + made.err).toBe(0);
  return {
    proj,
    tool,
    // The person types `prompt` in this chat; the shipped human-turn hook keeps it.
    said: (prompt: string): string => {
      const before = new Set(listMessages(proj).map((message) => message.id));
      const hook = spawn(tool("aidlc.ts"), ["engine", "hook", "record-human-turn"], chatEnv(proj),
        JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }));
      expect(hook.status, hook.err).toBe(0);
      const kept = listMessages(proj).filter((message) => !before.has(message.id));
      expect(kept).toHaveLength(1);
      return kept[0].id;
    },
    // The setter as an agent runs it from the chat: pipes on both ends.
    set: (args: string[]): string[] => {
      const run = spawn(tool("aidlc.ts"), ["engine", "config", "set", ...args, "--project-dir", proj], chatEnv(proj));
      expect(run.status, run.out + run.err).toBe(0);
      return run.out.split(/\r?\n/).filter((line) => line.trim() !== "");
    },
    // The same setter typed at the person's own terminal: no chat, no agent.
    atTheirTerminal: (args: string[]): string => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_TEST_CONFIG_TTY: "1" };
      delete env.AIDLC_SESSION_OVERRIDE;
      delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
      delete env.TERM_PROGRAM;
      for (const key of Object.keys(env)) {
        if (/^(?:CLAUDECODE|CLAUDE_CODE_|CODEX_|CURSOR_|KIRO_|OPENCODE|COPILOT_|VSCODE_)/i.test(key)) delete env[key];
      }
      const run = spawn(tool("aidlc.ts"), ["engine", "config", "set", ...args, "--project-dir", proj], env);
      expect(run.status, run.out + run.err).toBe(0);
      return run.out;
    },
    next: (args: string[]): { kind?: string; message?: string } => {
      const result = runOrchestrateNext(tool("aidlc-orchestrate.ts"), proj, args, { env: chatEnv(proj) });
      expect(result.status, result.out).toBe(0);
      return (result.directive ?? {}) as { kind?: string; message?: string };
    },
  };
}

describe("from a chat, the setter's own result says its line is the person's", () => {
  test("copilot: the summary confirmation off on their \"1\": the order line, then the setter's line", () => {
    const { said, set } = project("copilot");
    const id = said("1");
    const lines = set(["summary-confirmation", "off", "--message", id]);
    expect(lines[0]).toBe(ORDER);
    expect(lines[1]).toStartWith(`${SUMMARY_OFF}, because you said: "1". You can turn it back on any time.`);
  });

  test("claude: the same setter prints its line alone, the order riding the hook's note", () => {
    const { said, set } = project("claude");
    const lines = set(["summary-confirmation", "off", "--message", said("1")]);
    expect(lines).not.toContain(ORDER);
    expect(lines[0]).toStartWith(`${SUMMARY_OFF}, because you said: "1". You can turn it back on any time.`);
  });

  test("a check and the Guard Policy turned off from their words: the same order line first", () => {
    const { said, set } = project("copilot");
    const freeze = set(["guard.review-freeze", "off", "--message", said("turn the review freeze check off")]);
    expect(freeze[0]).toBe(ORDER);
    expect(freeze[1]).toContain("is off for this piece of work, because you said: \"turn the review freeze check off\".");
    const policy = set(["guard-policy", "off", "--message", said("turn the guards off")]);
    expect(policy[0]).toBe(ORDER);
    expect(policy[1]).toContain("is off for this piece of work, because you said: \"turn the guards off\".");
  });

  test("named by a step that prints it as it is (--verbatim): the setter's line alone", () => {
    const { said, set } = project();
    const lines = set(["summary-confirmation", "off", "--message", said("1"), "--verbatim"]);
    expect(lines).not.toContain(ORDER);
    expect(lines[0]).toStartWith(`${SUMMARY_OFF}, because you said: "1".`);
  });

  test("a setting that turns no check off carries no order line", () => {
    const { said, set } = project();
    const lines = set(["sensors", "off", "--message", said("turn the sensors off")]);
    expect(lines).not.toContain(ORDER);
  });

  test("at the person's own terminal: their line, set by them, and no order line", () => {
    const { atTheirTerminal } = project();
    const out = atTheirTerminal(["summary-confirmation", "off"]);
    expect(out).toContain(`${SUMMARY_OFF}, set by you.`);
    expect(out).not.toContain(ORDER);
  });
});

describe("the engine's steps that already print the setter's output keep it plain", () => {
  test("typed /aidlc --summary-confirmation off: the step names --verbatim, and its run prints the line alone", () => {
    const { said, set, next } = project();
    said("/aidlc --summary-confirmation off");
    const step = next(["--summary-confirmation", "off"]);
    expect(step.kind).toBe("print");
    const named = /Run `[^`]*? engine config set ([^`]+)` to update the configuration/.exec(step.message ?? "")?.[1];
    expect(named, step.message).toBe("summary-confirmation off --verbatim");
    const lines = set(named!.split(" "));
    expect(lines).not.toContain(ORDER);
    expect(lines.join("\n")).toContain(`${SUMMARY_OFF}, as you asked in the chat.`);
    // The Stop hook still reads the turn-ending form of this step as the finished
    // setting, not as workflow work left unreported.
    const command = "bun .claude/tools/aidlc.ts engine orchestrate next --summary-confirmation off";
    const ending = JSON.stringify({
      kind: "print",
      message: `Run \`bun .claude/tools/aidlc.ts engine config set ${named}\` to update the configuration, then print its output verbatim and stop.`,
    });
    expect(isEngineToolCall("Bash", { command }, ending)).toBe(false);
  });

  test("typed /aidlc config set summary-confirmation off: the engine runs it and prints the line with no order line", () => {
    const { said, next } = project();
    said("/aidlc config set summary-confirmation off");
    const step = next(["config", "set", "summary-confirmation", "off"]);
    expect(step.kind).toBe("print");
    expect(step.message).toContain(SUMMARY_OFF);
    expect(step.message).not.toContain(ORDER);
  });
});

describe("said once: the agent is not asked to word it itself", () => {
  test("the guard's turn-it-off choice and its prose sentence leave the words to the setter", () => {
    for (const text of [lowerFenceRemedy("review-freeze").action, lowerFenceSentence("review-freeze")]) {
      expect(text).not.toContain("in one line that it is off");
    }
  });

  test("no harness skill and no stage rule asks for the agent's own account of a check turned off", () => {
    for (const harness of ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"]) {
      const skill = readFileSync(join(REPO_ROOT, "harness", harness, "skills", "aidlc", "SKILL.md"), "utf-8");
      expect(skill, harness).toContain("When they ask to turn a check off for this piece of work");
      expect(skill, harness).not.toContain("say in one line that it is off for this piece of work");
    }
    const protocol = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "protocols", "stage-protocol.md"), "utf-8");
    expect(protocol).toContain("config set summary-confirmation off --learnings off --message <id>");
    expect(protocol).not.toContain("say in one line that both are off");
    expect(protocol.replace(/\s+/g, " ")).not.toContain("say in one line that it is off for this piece of work");
  });
});
