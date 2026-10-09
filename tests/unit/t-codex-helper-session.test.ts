// covers: function:resolveInvokingSessionId, function:resolveWorkflowSelection, function:noteHelperSession,
// function:helperSessionRoot, hook:aidlc-codex-adapter
//
// On Codex a spawned helper agent's shell carries its own CODEX_THREAD_ID, not the
// root chat's. Every hook payload of that helper arrives under the root
// session_id with agent_id = the helper's thread id, so the engine learns the
// mapping from the helper's first event. The adapter records it (one file beside
// the session bindings) and the resolver maps the helper's thread id to the root
// session, so an engine command the helper runs acts on the chat that spawned
// it, not on whatever the shared cursor names when a second chat is open.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "../../dist/codex/.codex/tools/aidlc-lib.ts";
import { DEFAULT_RECORD_DIR, DEFAULT_SPACE, REPO_ROOT, intentsDirOf, seedAidlcMemory, seededRecordDir } from "../harness/fixtures.ts";
import { NATIVE_RUNTIME_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_RUNTIME_CASE_TIMEOUT_MS);

const CODEX_TREE = join(REPO_ROOT, "dist", "codex", ".codex");
const STATE = readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8");
const ROOT = "01a12051-e539-79b1-b035-e277202dc7e9";
const HELPER = "01a12051-f83f-7e91-8a6c-9025a2eb68e2";
const CURSOR_RECORD = DEFAULT_RECORD_DIR;
const BOUND_RECORD = "second-chat-00000002";
const projects: string[] = [];
afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Two records in one space: the shared cursor names one, the root chat is bound
// to the other. A command that resolves through the cursor lands on the wrong one.
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t-codex-helper-")));
  projects.push(dir);
  cpSync(CODEX_TREE, join(dir, ".codex"), { recursive: true });
  seedAidlcMemory(dir);
  const intents = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  for (const record of [CURSOR_RECORD, BOUND_RECORD]) {
    mkdirSync(join(intents, record), { recursive: true });
    writeFileSync(join(intents, record, "aidlc-state.md"), STATE);
  }
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify([
    { uuid: "00000000-0000-7000-8000-000000000001", slug: "fixture", dirName: CURSOR_RECORD, status: "in-flight" },
    { uuid: "00000000-0000-7000-8000-000000000002", slug: "second-chat", dirName: BOUND_RECORD, status: "in-flight" },
  ], null, 2)}\n`);
  expect(existsSync(seededRecordDir(dir))).toBe(true);
  lib.setActiveIntentCursor(dir, CURSOR_RECORD);
  lib.writeSessionBinding(dir, ROOT, DEFAULT_SPACE, BOUND_RECORD, "switch");
  return dir;
}

// The resolver as a tool the helper's shell runs sees it: the Codex runtime, the
// helper's thread id, no hook-injected session.
function resolveAs(dir: string, thread: string): string | null {
  const previous = { ...process.env };
  process.env.AIDLC_HARNESS_DIR = ".codex";
  process.env.AIDLC_PROJECT_DIR = dir;
  process.env.CODEX_THREAD_ID = thread;
  delete process.env.AIDLC_SESSION_OVERRIDE;
  delete process.env.AIDLC_SESSION_OVERRIDE_SOURCE;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    return lib.resolveWorkflowSelection(dir).intent;
  } finally {
    process.env = previous;
  }
}

function adapter(dir: string, target: string, payload: Record<string, unknown>) {
  const r = spawnSync("bun", [join(dir, ".codex", "hooks", "aidlc-codex-adapter.ts"), target], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir, ...payload }),
    encoding: "utf-8",
    env: { ...process.env, AIDLC_PROJECT_DIR: dir, CLAUDE_PROJECT_DIR: undefined, CODEX_THREAD_ID: undefined, AIDLC_SESSION_OVERRIDE: undefined, AIDLC_SESSION_OVERRIDE_SOURCE: undefined } as NodeJS.ProcessEnv,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// What a helper's shell command sees: the engine's own intent listing, run with
// the helper's thread id and nothing else.
function activeIntentSeenBy(dir: string, thread: string): string | null {
  const r = spawnSync("bun", [join(dir, ".codex", "tools", "aidlc-utility.ts"), "intent", "list", "--json"], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_PROJECT_DIR: dir, CLAUDE_PROJECT_DIR: undefined, CODEX_THREAD_ID: thread, AIDLC_SESSION_OVERRIDE: undefined, AIDLC_SESSION_OVERRIDE_SOURCE: undefined } as NodeJS.ProcessEnv,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  return (JSON.parse(r.stdout) as { active: string | null }).active;
}

function helperRecords(dir: string): string[] {
  const sessions = join(dir, "aidlc", ".aidlc-sessions");
  return existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith(".helper-of")).sort() : [];
}

describe("a Codex helper's engine command stays on the chat that spawned it", () => {
  test("the resolver maps a recorded helper thread id to the root session; unknown ids and bad records fall through", () => {
    const dir = project();
    expect(resolveAs(dir, ROOT)).toBe(BOUND_RECORD);
    // No record yet: the helper's thread is unbound and the cursor decides (main's behaviour).
    expect(resolveAs(dir, HELPER)).toBe(CURSOR_RECORD);
    const note = (lib as unknown as { noteHelperSession?: (dir: string, root: string, agent: string) => void }).noteHelperSession;
    expect(typeof note).toBe("function");
    note!(dir, ROOT, HELPER);
    expect(resolveAs(dir, HELPER)).toBe(BOUND_RECORD);
    // A helper id equal to the root, an unsafe id, and an unsafe root write nothing.
    note!(dir, ROOT, ROOT);
    note!(dir, ROOT, "../escape");
    note!(dir, "../escape", "01a12051-0000-7000-8000-000000000003");
    expect(helperRecords(dir)).toEqual([`${HELPER}.helper-of`]);
    // A record naming an id with no binding of its own resolves like an unbound thread.
    note!(dir, "01a12051-0000-7000-8000-000000000009", "01a12051-0000-7000-8000-000000000004");
    expect(resolveAs(dir, "01a12051-0000-7000-8000-000000000004")).toBe(CURSOR_RECORD);
  });

  test("the adapter records the helper from its first event, and a tool the helper runs sees the root chat's work", () => {
    const dir = project();
    expect(activeIntentSeenBy(dir, HELPER)).toBe(CURSOR_RECORD);
    // The helper's brief arrives as a prompt under the root session with agent_id = its thread.
    const brief = adapter(dir, "record-human-turn", {
      hook_event_name: "UserPromptSubmit", session_id: ROOT, agent_id: HELPER, agent_type: "aidlc-pipeline-deploy-agent",
      turn_id: "01a12051-0000-7000-8000-000000000010", prompt: "Deploy the approved build.",
    });
    expect(brief.code, brief.err).toBe(0);
    expect(helperRecords(dir)).toEqual([`${HELPER}.helper-of`]);
    expect(readFileSync(join(dir, "aidlc", ".aidlc-sessions", `${HELPER}.helper-of`), "utf-8").trim()).toBe(ROOT);
    expect(activeIntentSeenBy(dir, HELPER)).toBe(BOUND_RECORD);
    expect(activeIntentSeenBy(dir, ROOT)).toBe(BOUND_RECORD);
  });

  test("a helper's tool call records it too; the root thread's own events never do", () => {
    const dir = project();
    const own = adapter(dir, "guard-tool-call", {
      hook_event_name: "PreToolUse", session_id: ROOT, tool_name: "Bash", tool_input: { command: "ls" },
      turn_id: "01a12051-0000-7000-8000-000000000011", tool_use_id: "call_root",
    });
    expect(own.code, own.err).toBe(0);
    expect(helperRecords(dir)).toEqual([]);
    const call = adapter(dir, "guard-tool-call", {
      hook_event_name: "PreToolUse", session_id: ROOT, agent_id: HELPER, agent_type: "aidlc-pipeline-deploy-agent",
      tool_name: "Bash", tool_input: { command: "ls" }, turn_id: "01a12051-0000-7000-8000-000000000012", tool_use_id: "call_helper",
    });
    expect(call.code, call.err).toBe(0);
    expect(helperRecords(dir)).toEqual([`${HELPER}.helper-of`]);
    expect(activeIntentSeenBy(dir, HELPER)).toBe(BOUND_RECORD);
  });
});
