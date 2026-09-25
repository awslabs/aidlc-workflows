// covers: hook:aidlc-rebuild-stage-graph, function:literalOrchestrateVerb, function:engineErrorRelayMessage, function:ENGINE_ERROR_RELAY_HARNESSES, function:ENGINE_ERROR_RELAY_NOTE, function:engineErrorRelayLine, function:writeEngineErrorRelay
//
// t349 - the engine error relay. The conductor skill says to print an `error`
// directive's message verbatim, and live Full Suite traces showed the model
// rewording 11 of 14 of them. The rebuild-stage-graph PostToolUse hook now hands
// the exact bytes to the human through the harness's own hook-to-human channel.
//
// WHAT THIS PINS
//   1. The decision (in-process): fires only for ONE literal framework engine
//      orchestrate invocation whose stdout is exactly the canonical `error`
//      directive, across every shipped spelling; silent for success directives,
//      non-engine commands, echoed/cat'ed copies, chains, pipes, pretty-printed
//      or extended JSON, and output that merely mentions an error. Exact bytes
//      survive: multi-line text, embedded JSON, Windows paths, non-ASCII.
//   2. The shipped hook (subprocess): one line carrying `systemMessage` (for the
//      person) and a PostToolUse `additionalContext` note (for the model) on
//      Claude Code, Codex, and opencode; nothing on the harnesses with no
//      hook-to-human PostToolUse channel; genuine engine output round-trips.
//   3. The adapters (subprocess / in-process plugin): Codex forwards the line
//      once (a duplicate delivery does not repeat it), opencode turns it into a
//      TUI toast, and Kiro CLI, Kiro IDE, Copilot, and Cursor stay silent.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createAdapter, {
  type EngineErrorToast,
  type PluginInput,
} from "../../harness/opencode/plugin/aidlc-opencode-adapter.ts";
import {
  ENGINE_ERROR_RELAY_HARNESSES,
  ENGINE_ERROR_RELAY_NOTE,
  engineErrorRelayLine,
  engineErrorRelayMessage,
  literalOrchestrateVerb,
} from "../../core/tools/aidlc-lib.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const CLAUDE_HOOK = join(REPO_ROOT, "dist", "claude", ".claude", "hooks", "aidlc-rebuild-stage-graph.ts");
const HOOK_TEST_DRIVER = [BUN, join(REPO_ROOT, "tests", "harness", "aidlc-hook-driver.ts")] as const;

// Relay-owned identity must come from each fixture, never from the test runner.
const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_HARNESS_NAME: undefined,
  AIDLC_HARNESS_DIR: undefined,
  AIDLC_PROJECT_DIR: undefined,
  CLAUDE_PROJECT_DIR: undefined,
  AIDLC_UNATTENDED: undefined,
  AIDLC_SESSION_OVERRIDE: undefined,
  AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
};

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `t349-${prefix}-`)));
  scratch.push(dir);
  return dir;
}

/** A project carrying one generated harness tree, as an install would. */
function installed(harness: string, leaf: string): string {
  const dir = tempProject(harness);
  cpSync(join(REPO_ROOT, "dist", harness, leaf), join(dir, leaf), { recursive: true });
  return dir;
}

/** The engine's own serialization: emit() writes JSON.stringify(directive) + "\n". */
function errorOutput(message: string): string {
  return `${JSON.stringify({ kind: "error", message })}\n`;
}

/** The exact line the hook writes on a relay harness. */
function relayLine(message: string): string {
  return `${JSON.stringify({
    systemMessage: message,
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ENGINE_ERROR_RELAY_NOTE },
  })}\n`;
}

const MULTILINE = "Unknown scope \"frobnicate\".\nValid scopes: bugfix, classic.\n\tRetry with --scope classic.";
const WINDOWS = String.raw`Could not read C:\Users\dev\My Project\aidlc\spaces\default\intents.json (EBUSY).`;
const EMBEDDED_JSON = 'The directive {"kind":"error","message":"nested"} was refused; run `/aidlc --doctor`.';
const NON_ASCII = "Caf\u00e9 intent \u201cbeta\u201d is not a piece of work in space \u00e9quipe.";
const CLAUDE_BASH = (stdout: string) => ({ stdout, stderr: "", interrupted: false });

describe("t349 relay decision: which commands and outputs qualify", () => {
  test("every shipped orchestrate spelling is recognized, with its verb", () => {
    const spellings: Array<[string, string]> = [
      ["aidlc engine orchestrate next --scope bogus", "next"],
      ["aidlc next --scope bogus", "next"],
      ["aidlc engine orchestrate continue abcd1234", "continue"],
      ["aidlc engine orchestrate report --stage requirements-analysis --result approved --user-input \"Approve\"", "report"],
      ["aidlc engine orchestrate park", "park"],
      ["bun .aidlc/tools/aidlc.ts engine orchestrate next", "next"],
      ["bun .kiro/tools/aidlc.ts engine orchestrate next", "next"],
      ["bun .cursor/tools/aidlc-orchestrate.ts report --stage x --result approved", "report"],
      ["cd /abs/project && aidlc engine orchestrate next 2>&1", "next"],
      ["env AIDLC_UNATTENDED=1 aidlc engine orchestrate next", "next"],
      ["aidlc engine orchestrate next --project-dir /abs/project", "next"],
    ];
    for (const harness of HARNESS_MATRIX) {
      spellings.push([`bun ${harness.manifest.harnessDir}/tools/aidlc.ts engine orchestrate next`, "next"]);
      spellings.push([`bun ${harness.manifest.harnessDir}/tools/aidlc-orchestrate.ts next`, "next"]);
    }
    for (const [command, verb] of spellings) {
      expect(literalOrchestrateVerb(command), command).toBe(verb);
    }
  });

  test("non-orchestrate engine tools, chains, pipes, and non-engine commands are not relay sources", () => {
    for (const command of [
      "",
      "aidlc engine state approve",
      "aidlc engine utility doctor",
      "aidlc engine orchestrate team-board",
      "bun .claude/tools/aidlc-state.ts approve",
      "aidlc engine orchestrate next && echo done",
      "aidlc engine orchestrate next; echo done",
      "aidlc engine orchestrate next | tee out.json",
      "aidlc engine orchestrate next > out.json",
      "aidlc engine orchestrate next $ARGUMENTS",
      "out=$(aidlc engine orchestrate next)",
      "cd relative/dir && aidlc engine orchestrate next",
      "echo '{\"kind\":\"error\",\"message\":\"x\"}'",
      "cat error.json",
      "printf %s error",
      "bun /tmp/fake/aidlc.ts engine orchestrate next",
      "node .claude/tools/aidlc.ts engine orchestrate next",
      "sh -c 'aidlc engine orchestrate next'",
    ]) {
      expect(literalOrchestrateVerb(command), command).toBeNull();
    }
  });

  test("an engine error directive yields its exact message bytes", () => {
    const command = "bun .claude/tools/aidlc.ts engine orchestrate next --scope frobnicate";
    for (const message of [MULTILINE, WINDOWS, EMBEDDED_JSON, NON_ASCII, "x"]) {
      // Claude Code's Bash result object, and the plain string Codex and the
      // opencode plugin deliver.
      expect(engineErrorRelayMessage(command, CLAUDE_BASH(errorOutput(message)))).toBe(message);
      expect(engineErrorRelayMessage(command, errorOutput(message))).toBe(message);
    }
  });

  test("stderr noise, CRLF, and the Git Bash /tmp diagnostic do not hide the directive", () => {
    const command = "aidlc engine orchestrate next";
    expect(
      engineErrorRelayMessage(command, { stdout: errorOutput(WINDOWS), stderr: "warning: slow disk\n", interrupted: false }),
    ).toBe(WINDOWS);
    expect(engineErrorRelayMessage(command, `${JSON.stringify({ kind: "error", message: WINDOWS })}\r\n`)).toBe(WINDOWS);
    expect(
      engineErrorRelayMessage(
        command,
        `bash.exe: warning: could not find /tmp, please create!\n${errorOutput(MULTILINE)}`,
      ),
    ).toBe(MULTILINE);
  });

  test("success directives and output that merely mentions an error stay silent", () => {
    const command = "aidlc engine orchestrate next";
    for (const stdout of [
      `${JSON.stringify({ kind: "print", message: "An error occurred earlier; run --doctor." })}\n`,
      `${JSON.stringify({ kind: "done", message: "complete" })}\n`,
      `${JSON.stringify({ kind: "notice", message: "error" })}\n`,
      "error: something failed\n",
      "Error directive printed below\n",
      "",
    ]) {
      expect(engineErrorRelayMessage(command, CLAUDE_BASH(stdout)), stdout).toBeNull();
    }
  });

  test("anything but the canonical, valid, single directive stays silent", () => {
    const command = "aidlc engine orchestrate next";
    const canonical = errorOutput("Unknown scope.").trim();
    for (const stdout of [
      JSON.stringify({ kind: "error", message: "Unknown scope." }, null, 2),
      `${canonical}\n${canonical}\n`,
      `prefix ${canonical}\n`,
      `${canonical} trailing\n`,
      `${JSON.stringify({ kind: "error", message: "x", extra: true })}\n`,
      `${JSON.stringify({ kind: "error", message: 7 })}\n`,
      `${JSON.stringify({ kind: "error" })}\n`,
      `${JSON.stringify([{ kind: "error", message: "x" }])}\n`,
      `{"kind":"error","message":"x"`,
    ]) {
      expect(engineErrorRelayMessage(command, CLAUDE_BASH(stdout)), stdout).toBeNull();
    }
  });

  test("the directive must come from an engine command, not an echo of one", () => {
    const stdout = errorOutput("Unknown scope.");
    for (const command of [
      `echo '${stdout.trim()}'`,
      "cat .aidlc-engine/last-directive.json",
      "aidlc engine orchestrate next && cat last.json",
      "aidlc engine state approve",
    ]) {
      expect(engineErrorRelayMessage(command, stdout), command).toBeNull();
    }
  });

  test("result shapes of harnesses without a channel are not read", () => {
    const command = "aidlc engine orchestrate next";
    const stdout = errorOutput("Unknown scope.");
    // Kiro CLI {items:[{Text}]} and Copilot {text_result_for_llm} shapes.
    expect(engineErrorRelayMessage(command, { items: [{ Text: stdout }] })).toBeNull();
    expect(
      engineErrorRelayMessage(command, { result_type: "success", text_result_for_llm: stdout }),
    ).toBeNull();
    expect(engineErrorRelayMessage(command, undefined)).toBeNull();
    expect(engineErrorRelayMessage(command, null)).toBeNull();
  });
});

describe("t349 relay line per harness", () => {
  test("the model-facing note tells the conductor not to repeat or retry, in plain keyboard text", () => {
    expect(ENGINE_ERROR_RELAY_NOTE).toMatch(/^[\x20-\x7e]+$/);
    expect(ENGINE_ERROR_RELAY_NOTE).toContain("already been shown this engine error exactly as written");
    expect(ENGINE_ERROR_RELAY_NOTE).toContain("Do not repeat or reword it");
    expect(ENGINE_ERROR_RELAY_NOTE).toContain("do not retry or work around it");
  });

  test("only harnesses with a PostToolUse hook-to-human channel get a line", () => {
    expect([...ENGINE_ERROR_RELAY_HARNESSES].sort()).toEqual(["claude", "codex", "opencode"]);
    const names: string[] = HARNESS_MATRIX.map((harness) => harness.name);
    for (const name of ENGINE_ERROR_RELAY_HARNESSES) expect(names).toContain(name);
    for (const name of names) {
      const line = engineErrorRelayLine(MULTILINE, name);
      if (ENGINE_ERROR_RELAY_HARNESSES.has(name)) {
        expect(line, name).toBe(relayLine(MULTILINE));
        expect(JSON.parse(line ?? "").systemMessage).toBe(MULTILINE);
        expect(JSON.parse(line ?? "").hookSpecificOutput.additionalContext).toBe(ENGINE_ERROR_RELAY_NOTE);
      } else {
        expect(line, name).toBeNull();
      }
    }
  });
});

function runClaudeHook(
  projectDir: string,
  payload: unknown,
  harness?: string,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(BUN, [CLAUDE_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: projectDir, AIDLC_HARNESS_NAME: harness },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

function claudePostToolUse(command: string, stdout: string): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    session_id: "t349-session",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: CLAUDE_BASH(stdout),
  };
}

describe("t349 shipped rebuild-stage-graph hook", () => {
  test("relays an error directive as one systemMessage line with no workflow state", () => {
    const proj = tempProject("claude-hook");
    const r = runClaudeHook(
      proj,
      claudePostToolUse("bun .claude/tools/aidlc.ts engine orchestrate next --scope frobnicate", errorOutput(MULTILINE)),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(relayLine(MULTILINE));
  });

  test("relays the genuine bytes the engine printed for a bad scope", () => {
    // The conductor's own command, run in an installed project as the harness would.
    const proj = installed("claude", ".claude");
    const engine = spawnSync(
      BUN,
      [".claude/tools/aidlc.ts", "engine", "orchestrate", "next", "--scope", "frobnicate"],
      {
        cwd: proj,
        encoding: "utf-8",
        env: CLEAN_ENV,
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      },
    );
    expect(engine.status, engine.stderr).toBe(0);
    const directive = JSON.parse(engine.stdout) as { kind: string; message: string };
    expect(directive.kind).toBe("error");
    expect(directive.message).toContain('Unknown scope "frobnicate"');

    const r = runClaudeHook(
      proj,
      claudePostToolUse("bun .claude/tools/aidlc.ts engine orchestrate next --scope frobnicate", engine.stdout),
      "claude",
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(relayLine(directive.message));
  });

  test("writes nothing for harnesses without a channel, success directives, or other commands", () => {
    const proj = tempProject("claude-silent");
    const command = "aidlc engine orchestrate next";
    for (const harness of ["kiro", "kiro-ide", "copilot", "cursor"]) {
      const r = runClaudeHook(proj, claudePostToolUse(command, errorOutput(WINDOWS)), harness);
      expect(r.code, harness).toBe(0);
      expect(r.stdout, harness).toBe("");
    }
    const success = runClaudeHook(
      proj,
      claudePostToolUse(command, `${JSON.stringify({ kind: "print", message: "error-free status" })}\n`),
      "claude",
    );
    expect(success.stdout).toBe("");
    const echoed = runClaudeHook(proj, claudePostToolUse("cat directive.json", errorOutput(WINDOWS)), "claude");
    expect(echoed.stdout).toBe("");
  });
});

describe("t349 harness adapters", () => {
  function runAdapter(
    projectDir: string,
    adapter: string,
    target: string,
    payload: unknown,
    env: NodeJS.ProcessEnv = {},
  ): { stdout: string; stderr: string; code: number } {
    const r = spawnSync(BUN, [join(projectDir, adapter), target], {
      cwd: projectDir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: { ...CLEAN_ENV, ...env },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
  }

  test("Codex forwards the systemMessage line once and not on the duplicate delivery", () => {
    const proj = installed("codex", ".codex");
    const payload = {
      session_id: "019eb8be-e4fe-7a42-ba1b-e5f963dbddc9",
      turn_id: "019eb8c0-1f54-7691-920f-c83b886b1161",
      cwd: proj,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun .codex/tools/aidlc.ts engine orchestrate next --scope frobnicate" },
      tool_response: errorOutput(EMBEDDED_JSON),
      tool_use_id: "call_t349",
    };
    const first = runAdapter(proj, ".codex/hooks/aidlc-codex-adapter.ts", "rebuild-stage-graph", payload);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(relayLine(EMBEDDED_JSON));
    const duplicate = runAdapter(proj, ".codex/hooks/aidlc-codex-adapter.ts", "rebuild-stage-graph", payload);
    expect(duplicate.code).toBe(0);
    expect(duplicate.stdout).toBe("");

    const success = runAdapter(proj, ".codex/hooks/aidlc-codex-adapter.ts", "rebuild-stage-graph", {
      ...payload,
      tool_use_id: "call_t349_success",
      tool_response: `${JSON.stringify({ kind: "done", message: "complete" })}\n`,
    });
    expect(success.stdout).toBe("");
  });

  test("Kiro CLI adds nothing to the agent context for an engine error", () => {
    const proj = installed("kiro", ".kiro");
    const stdout = errorOutput(WINDOWS);
    const payload = (toolResponse: unknown) => ({
      hook_event_name: "postToolUse",
      cwd: proj,
      session_id: "cb3a220a-609f-4265-8ff9-2cafd3658000",
      tool_name: "shell",
      tool_input: { command: "bun .kiro/tools/aidlc.ts engine orchestrate next --scope frobnicate" },
      tool_response: toolResponse,
    });
    for (const toolResponse of [{ items: [{ Text: stdout }] }, stdout]) {
      const r = runAdapter(proj, ".kiro/hooks/aidlc-kiro-adapter.ts", "rebuild-stage-graph", payload(toolResponse), {
        AIDLC_PROJECT_DIR: proj,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
    // Control: the adapter does reach the core hook and passes its stdout on,
    // so the silence above comes from the harness gate, not a dead path.
    const control = runAdapter(proj, ".kiro/hooks/aidlc-kiro-adapter.ts", "rebuild-stage-graph", payload(stdout), {
      AIDLC_PROJECT_DIR: proj,
      AIDLC_HARNESS_NAME: "claude",
    });
    expect(control.stdout).toBe(relayLine(WINDOWS));
  });

  test("Kiro IDE, Copilot, and Cursor stay silent for an engine error", () => {
    const stdout = errorOutput(WINDOWS);
    const ide = installed("kiro-ide", ".kiro");
    const ideRun = runAdapter(ide, ".kiro/hooks/aidlc-kiro-adapter.ts", "rebuild-stage-graph", {
      session_id: "t349-ide",
      hook_event_name: "PostToolUse",
      cwd: ide,
      tool_name: "execute_bash",
      tool_input: {},
      tool_response: `Output:\n${stdout}\nExit Code: 0`,
    }, { AIDLC_PROJECT_DIR: ide, USER_PROMPT: "" });
    expect(ideRun.code).toBe(0);
    expect(ideRun.stdout).toBe("");

    const copilot = installed("copilot", ".aidlc");
    const copilotRun = runAdapter(copilot, ".aidlc/hooks/aidlc-copilot-adapter.ts", "post-tool", {
      hook_event_name: "PostToolUse",
      session_id: "d0e7296c-f58a-4b06-9a63-d344d439f9c1",
      cwd: copilot,
      tool_name: "Bash",
      tool_input: { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next --scope frobnicate" },
      tool_result: {
        result_type: "success",
        text_result_for_llm: `${stdout}<shellId: 0 completed with exit code 0>`,
      },
    });
    expect(copilotRun.code).toBe(0);
    expect(copilotRun.stdout).toBe("");

    const cursor = installed("cursor", ".cursor");
    const cursorRun = runAdapter(cursor, ".cursor/hooks/aidlc-cursor-adapter.ts", "runtime-compile", {
      hook_event_name: "postToolUse",
      conversation_id: "t349-cursor",
      cwd: cursor,
      workspace_roots: [cursor],
      tool_name: "Shell",
      tool_input: { command: "bun .cursor/tools/aidlc.ts engine orchestrate next --scope frobnicate" },
      tool_output: JSON.stringify({ output: stdout, exitCode: 0 }),
    }, { AIDLC_PROJECT_DIR: cursor });
    expect(cursorRun.code).toBe(0);
    expect(cursorRun.stdout).toBe("");
  });

  function opencodeClient(options: { tui?: boolean; failToast?: boolean } = {}) {
    const toasts: EngineErrorToast[] = [];
    const client: PluginInput["client"] = {
      session: {
        get: async () => ({ data: {} }),
        prompt: async () => undefined,
      },
      ...(options.tui === false
        ? {}
        : {
            tui: {
              showToast: async ({ body }) => {
                if (options.failToast) throw new Error("no TUI attached");
                toasts.push(body);
              },
            },
          }),
    };
    return { client, toasts };
  }

  async function opencodeBash(client: PluginInput["client"], directory: string, stdout: string) {
    const adapter = await createAdapter({ client, directory, aidlcCommand: HOOK_TEST_DRIVER });
    await adapter["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "main",
        callID: "call-bash",
        args: { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next --scope frobnicate" },
      },
      { output: stdout },
    );
  }

  test("opencode shows the exact message as an error toast", async () => {
    const proj = installed("opencode", ".aidlc");
    const { client, toasts } = opencodeClient();
    await opencodeBash(client, proj, errorOutput(MULTILINE));
    expect(toasts).toEqual([{ title: "AI-DLC", message: MULTILINE, variant: "error" }]);
  });

  test("opencode shows no toast for success output and survives a missing or failing TUI", async () => {
    const proj = installed("opencode", ".aidlc");
    const quiet = opencodeClient();
    await opencodeBash(quiet.client, proj, `${JSON.stringify({ kind: "print", message: "error count: 0" })}\n`);
    expect(quiet.toasts).toEqual([]);

    const headless = opencodeClient({ tui: false });
    await opencodeBash(headless.client, proj, errorOutput(MULTILINE));
    expect(headless.toasts).toEqual([]);

    const failing = opencodeClient({ failToast: true });
    await opencodeBash(failing.client, proj, errorOutput(MULTILINE));
    expect(failing.toasts).toEqual([]);
  });
});
