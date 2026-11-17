// t241b — OpenCode 2 entry point of the opencode adapter.
//
// The default export carries a V2 `setup(ctx)` beside the V1 `server()`. setup
// drives the same V1 hook map from V2 hooks and events; these tests feed a
// fake V2 context the event shapes recorded live on opencode 2.0.24 and check
// that each reaches the core hook it replaces.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import adapterPlugin, { type V2PluginContext } from "../../harness/opencode/plugin/aidlc-opencode-adapter.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TEST_AIDLC_COMMAND = [
  process.execPath,
  join(REPO_ROOT, "tests", "harness", "aidlc-hook-driver.ts"),
] as const;
const TEST_ENTRYPOINTS = new Set(["tools/aidlc-orchestrate.ts", "tools/aidlc-state.ts"]);
const scratch: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshProject(): string {
  const root = mkdtempSync(join(tmpdir(), "t241b-opencode-v2-"));
  scratch.push(root);
  mkdirSync(join(root, ".aidlc", "hooks"), { recursive: true });
  mkdirSync(join(root, ".aidlc", "tools"), { recursive: true });
  return root;
}

function writeHook(root: string, name: string, source: string): void {
  const path = join(root, ".aidlc", "hooks", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf-8");
}

/** A core hook that appends its stdin JSON to `capture` and prints `stdout`. */
function recordingHook(root: string, name: string, capture: string, stdout = ""): void {
  writeHook(
    root,
    name,
    `import { appendFileSync } from "node:fs";
const input = await Bun.stdin.text();
appendFileSync(${JSON.stringify(capture)}, input + "\\n");
${stdout ? `process.stdout.write(${JSON.stringify(stdout)} + "\\n");` : ""}
`,
  );
}

function captured(capture: string): Array<Record<string, unknown>> {
  if (!existsSync(capture)) return [];
  return readFileSync(capture, "utf-8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the adapter");
    await Bun.sleep(20);
  }
}

type Callback = (event: unknown) => Promise<void> | void;

/** A fake OpenCode 2 plugin context with the domains the adapter uses. */
function fakeContext(directory: string, parentBySession: Record<string, string> = {}) {
  const sessionHooks = new Map<string, Callback>();
  const toolHooks = new Map<string, Callback>();
  const shellHooks = new Map<string, Callback>();
  const synthetic: Array<{ sessionID: string; text: string }> = [];
  const queue: Array<{ type: string; data?: Record<string, unknown> }> = [];
  let wake: (() => void) | null = null;
  let processed = 0;
  const ctx: V2PluginContext = {
    location: { directory },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, ...(parentBySession[sessionID] ? { parentID: parentBySession[sessionID] } : {}) }),
      synthetic: async (input) => {
        synthetic.push(input);
        return {};
      },
      hook: async (name, callback) => {
        sessionHooks.set(name, callback as Callback);
        return {};
      },
    },
    tool: {
      hook: async (name, callback) => {
        toolHooks.set(name, callback as Callback);
        return {};
      },
    },
    shell: {
      hook: async (name, callback) => {
        shellHooks.set(name, callback as Callback);
        return {};
      },
    },
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            const next = queue.shift();
            if (next) {
              yield next;
              processed++;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      }),
    },
  };
  return {
    ctx,
    synthetic,
    prompt: (sessionID: string, text: string) =>
      sessionHooks.get("prompt")!({ sessionID, messageID: "msg_1", prompt: { text, files: [] }, delivery: "steer" }),
    before: (event: Record<string, unknown>) => toolHooks.get("execute.before")!(event),
    after: (event: Record<string, unknown>) => toolHooks.get("execute.after")!(event),
    compaction: (sessionID: string) => sessionHooks.get("compaction")!({ sessionID, messages: [] }),
    /** opencode 2 creating a shell; returns the env the command will run with. */
    shell: async (command: string, cwd = directory) => {
      const event = { command, cwd, timeout: 0, shell: "/bin/sh", env: { TERM: "xterm-256color" } as Record<string, string> };
      await shellHooks.get("create.before")!(event);
      return event.env;
    },
    /** Deliver one event and wait until the adapter has handled it. */
    emit: async (type: string, data: Record<string, unknown>) => {
      const target = processed + queue.length + 1;
      queue.push({ type, data });
      wake?.();
      await waitFor(() => processed >= target);
    },
  };
}

async function setup(root: string, parents: Record<string, string> = {}) {
  const fake = fakeContext(root, parents);
  const stop = await adapterPlugin.setup(fake.ctx, {
    aidlcEntrypoints: TEST_ENTRYPOINTS,
    aidlcCommand: TEST_AIDLC_COMMAND,
  });
  if (stop) cleanups.push(stop);
  return fake;
}

describe("t241b OpenCode 2 entry point", () => {
  test("the module exports one plugin object carrying both hosts' entry points", () => {
    expect(adapterPlugin.id).toBe("aidlc");
    expect(typeof adapterPlugin.setup).toBe("function");
    expect(typeof adapterPlugin.server).toBe("function");
  });

  test("OpenCode 1's partial setup context registers nothing", async () => {
    // OpenCode 1.18 also calls setup() with a context that has no tool or
    // session domain; running there would double every V1 hook.
    const partial = { options: {}, agent: {}, command: {} } as unknown as V2PluginContext;
    expect(await adapterPlugin.setup(partial)).toBeUndefined();
  });

  test("a person's prompt in the main session is recorded as their turn", async () => {
    const root = freshProject();
    const capture = join(root, "human-turn.jsonl");
    writeHook(root, "aidlc-session-start.ts", "await Bun.stdin.text();\n");
    recordingHook(root, "aidlc-record-human-turn.ts", capture);
    const v2 = await setup(root);
    await v2.prompt("ses_main", "approve");
    const turns = captured(capture);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ hook_event_name: "UserPromptSubmit", session_id: "ses_main", prompt: "approve" });
  });

  // OpenCode 2 has no command.execute.before: the prompt hook gets the /aidlc
  // template expanded, with what the person typed after /aidlc in place of
  // $ARGUMENTS and the skill text in place of the shell line (seen live on
  // 2.2.1). The turn is recorded as the line they typed, as on opencode 1, so a
  // typed switch is kept and a bare /aidlc is a command, never a reply.
  test("an /aidlc line is recorded as the person typed it, not as its template", async () => {
    const root = freshProject();
    const capture = join(root, "human-turn.jsonl");
    writeHook(root, "aidlc-session-start.ts", "await Bun.stdin.text();\n");
    recordingHook(root, "aidlc-record-human-turn.ts", capture);
    const template = readFileSync(join(REPO_ROOT, "harness", "opencode", "command", "aidlc.md"), "utf-8")
      .replaceAll("{{INVOKE}}", "bun .aidlc/tools/aidlc.ts");
    mkdirSync(join(root, ".opencode", "command"), { recursive: true });
    writeFileSync(join(root, ".opencode", "command", "aidlc.md"), template, "utf-8");
    const body = template.slice(template.indexOf("\n---\n", 4) + "\n---\n".length);
    const expanded = (args: string) =>
      body.replace("$ARGUMENTS", args).replace(/!`[^`\n]*`/, "---\nname: aidlc\ndescription: AI-DLC\n---\n\n# AI-DLC");
    const v2 = await setup(root);
    await v2.prompt("ses_main", expanded("--review none"));
    await v2.prompt("ses_main", expanded(""));
    await v2.prompt("ses_main", "Follow the steps in the README");
    expect(captured(capture).map((turn) => turn.prompt)).toEqual([
      "/aidlc --review none",
      "/aidlc",
      "Follow the steps in the README",
    ]);
  });

  test("a subagent's prompt is never recorded as a human turn", async () => {
    const root = freshProject();
    const capture = join(root, "human-turn.jsonl");
    writeHook(root, "aidlc-session-start.ts", "await Bun.stdin.text();\n");
    recordingHook(root, "aidlc-record-human-turn.ts", capture);
    // Learned from the session lookup...
    const v2 = await setup(root, { ses_child: "ses_main" });
    await v2.prompt("ses_child", "You are a subagent spawned by another session.\nRead notes.txt");
    // ...and from session.created, before any lookup answers.
    await v2.emit("session.created", { sessionID: "ses_child2", parentID: "ses_main" });
    await v2.prompt("ses_child2", "You are a subagent spawned by another session.\nRead notes.txt");
    expect(captured(capture)).toHaveLength(0);
  });

  test("a shell tool call's command runs as its own chat, a helper's as its owner", async () => {
    // V2's shell event names no session; the shell tool call ahead of it does.
    const root = freshProject();
    const v2 = await setup(root, { ses_a_helper: "ses_a" });
    const owned = { AIDLC_SESSION_OVERRIDE: "ses_a", AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };
    await v2.before({ tool: "shell", sessionID: "ses_b", agent: "build", id: "call_b", input: { command: "ls" } });
    await v2.before({ tool: "shell", sessionID: "ses_a_helper", agent: "explore", id: "call_h", input: { command: "ls" } });
    // Same command from two chats: each shell takes the oldest waiting call.
    expect(await v2.shell("ls")).toMatchObject({ AIDLC_SESSION_OVERRIDE: "ses_b", AIDLC_SESSION_OVERRIDE_SOURCE: "payload" });
    expect(await v2.shell("ls")).toMatchObject(owned);
    expect((await v2.shell("ls")).AIDLC_SESSION_OVERRIDE).toBeUndefined();
  });

  test("a command typed in opencode's terminal, or a refused call, names no chat", async () => {
    const root = freshProject();
    const v2 = await setup(root);
    expect(await v2.shell("git status")).toEqual({ TERM: "xterm-256color" });
    // A call that ended without a shell must not name a later terminal command.
    await v2.before({ tool: "shell", sessionID: "ses_a", agent: "build", id: "call_x", input: { command: "make" } });
    await v2.after({ tool: "shell", sessionID: "ses_a", id: "call_x", input: { command: "make" }, status: "error" });
    expect((await v2.shell("make")).AIDLC_SESSION_OVERRIDE).toBeUndefined();
  });

  test("V2 tool names reach the V1 checks: a compound shell command is refused", async () => {
    const root = freshProject();
    const v2 = await setup(root);
    await expect(
      v2.before({
        tool: "shell",
        sessionID: "ses_main",
        agent: "build",
        id: "call_1",
        input: { command: "bun .aidlc/tools/aidlc-state.ts approve && echo done" },
      }),
    ).rejects.toThrow(/AIDLC bash permission allows one direct invocation/);
    // Unrelated shell commands still run.
    await v2.before({ tool: "shell", sessionID: "ses_main", agent: "build", id: "call_2", input: { command: "echo hi" } });
  });

  test("a subagent dispatch gets the stage-rules rewrite in its input", async () => {
    const root = freshProject();
    const capture = join(root, "dispatch.jsonl");
    const rewritten = { agent: "aidlc-developer-agent", description: "d", prompt: "RULES + original" };
    recordingHook(
      root,
      "aidlc-deliver-stage-rules.ts",
      capture,
      JSON.stringify({ hookSpecificOutput: { updatedInput: rewritten } }),
    );
    for (const hook of ["aidlc-plan-approval-guard.ts", "aidlc-reviewer-scope.ts"]) {
      writeHook(root, hook, "await Bun.stdin.text();\n");
    }
    const v2 = await setup(root);
    const event = {
      tool: "subagent",
      sessionID: "ses_main",
      agent: "build",
      id: "call_task",
      input: { agent: "aidlc-developer-agent", description: "d", prompt: "original" },
    };
    await v2.before(event);
    expect(captured(capture)[0]).toMatchObject({ tool_name: "task", tool_input: { agent: "aidlc-developer-agent" } });
    expect(event.input).toEqual(rewritten);
  });

  test("the calling agent named by the V2 tool event scopes a reviewer's reads", async () => {
    const root = freshProject();
    const capture = join(root, "scope.jsonl");
    recordingHook(root, "aidlc-reviewer-scope.ts", capture);
    const v2 = await setup(root, { ses_review: "ses_main" });
    await v2.before({
      tool: "read",
      sessionID: "ses_review",
      agent: "aidlc-architecture-reviewer-agent",
      id: "call_read",
      input: { path: "src/a.ts" },
    });
    expect(captured(capture)[0]).toMatchObject({
      session_id: "ses_main",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      agent_type: "aidlc-architecture-reviewer-agent",
    });
  });

  test("a completed write is audited with its absolute path; a failed one is not", async () => {
    const root = freshProject();
    const audit = join(root, "audit.jsonl");
    recordingHook(root, "aidlc-write-audit-log.ts", audit);
    writeHook(root, "aidlc-run-sensors.ts", "await Bun.stdin.text();\n");
    const v2 = await setup(root);
    await v2.after({ tool: "write", sessionID: "ses_main", id: "w1", input: { path: "notes.txt", content: "x" }, status: "completed", result: {} });
    await v2.after({ tool: "edit", sessionID: "ses_main", id: "w2", input: { path: "other.txt" }, status: "error" });
    const calls = captured(audit);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool_name: "Write", tool_input: { file_path: join(root, "notes.txt") } });
  });

  test("a finished shell call forwards its output to the stage-graph hook", async () => {
    const root = freshProject();
    const capture = join(root, "graph.jsonl");
    recordingHook(root, "aidlc-rebuild-stage-graph.ts", capture);
    const v2 = await setup(root);
    await v2.after({
      tool: "shell",
      sessionID: "ses_main",
      id: "s1",
      input: { command: "echo probe-ok" },
      status: "completed",
      result: { output: { exit: 0, output: "probe-ok\n" }, content: [{ type: "text", text: "probe-ok\n" }] },
    });
    expect(captured(capture)[0]).toMatchObject({
      tool_name: "Bash",
      tool_input: { command: "echo probe-ok" },
      session_id: "ses_main",
      tool_response: "probe-ok\n",
    });
  });

  test("compaction runs the state check for the compacting session", async () => {
    const root = freshProject();
    const capture = join(root, "compact.jsonl");
    recordingHook(root, "aidlc-validate-state.ts", capture);
    const v2 = await setup(root);
    await v2.compaction("ses_main");
    expect(captured(capture)[0]).toMatchObject({ hook_event_name: "PreCompact", session_id: "ses_main" });
  });

  function nudgingProject(): { root: string; stops: string } {
    const root = freshProject();
    const stops = join(root, "stop.jsonl");
    writeHook(root, "aidlc-session-start.ts", "await Bun.stdin.text();\n");
    writeHook(root, "aidlc-record-human-turn.ts", "await Bun.stdin.text();\n");
    recordingHook(root, "aidlc-continue-workflow.ts", stops, JSON.stringify({ decision: "block", reason: "continue the stage" }));
    return { root, stops };
  }

  test("the end of a turn runs the Stop hook and nudges through a synthetic message", async () => {
    const { root, stops } = nudgingProject();
    const v2 = await setup(root);
    await v2.prompt("ses_main", "start");
    await v2.emit("session.execution.succeeded", { sessionID: "ses_main" });
    expect(captured(stops)[0]).toMatchObject({ hook_event_name: "Stop", session_id: "ses_main" });
    expect(v2.synthetic).toHaveLength(1);
    expect(v2.synthetic[0].sessionID).toBe("ses_main");
    expect(v2.synthetic[0].text).toContain("continue the stage");
  });

  test("after the person stops a turn, no nudge follows until they write again", async () => {
    const { root, stops } = nudgingProject();
    const v2 = await setup(root);
    await v2.prompt("ses_main", "start");
    await v2.emit("session.execution.interrupted", { sessionID: "ses_main" });
    await v2.emit("session.execution.succeeded", { sessionID: "ses_main" });
    expect(captured(stops)).toHaveLength(0);
    expect(v2.synthetic).toHaveLength(0);
    await v2.prompt("ses_main", "go on");
    await v2.emit("session.execution.succeeded", { sessionID: "ses_main" });
    expect(v2.synthetic).toHaveLength(1);
  });

  test("after the person rejects a permission, no nudge follows until they write again", async () => {
    const { root } = nudgingProject();
    const v2 = await setup(root);
    await v2.prompt("ses_main", "start");
    await v2.emit("permission.replied", { sessionID: "ses_main", requestID: "per_1", reply: "reject" });
    await v2.emit("session.execution.succeeded", { sessionID: "ses_main" });
    expect(v2.synthetic).toHaveLength(0);
  });

  test("a subagent's finished execution sends no nudge", async () => {
    const { root, stops } = nudgingProject();
    const v2 = await setup(root, { ses_child: "ses_main" });
    await v2.prompt("ses_main", "start");
    await v2.emit("session.execution.succeeded", { sessionID: "ses_child" });
    expect(captured(stops)).toHaveLength(0);
    expect(v2.synthetic).toHaveLength(0);
  });
});

