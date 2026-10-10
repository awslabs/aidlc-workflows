// covers: function:resolveInvokingSessionId, function:resolveChat
//
// Claude Code and Kiro CLI name the chat in the agent's own shell
// (CLAUDE_CODE_SESSION_ID, KIRO_SESSION_ID; both measured live on this box),
// but the engine read only Codex's CODEX_THREAD_ID, so on those hosts every
// command of the agent spent the process-ancestry walk and fell to the shared
// selection when the walk found nothing: with a second chat open, that is the
// other chat's work.
//
// A shell variable is only as good as the chat it names. A shell started from
// inside a chat keeps the variable after that chat is gone, so Claude Code's id
// is trusted only while the host process it names (CLAUDE_PID) is alive. Kiro
// CLI gives the agent's shell no pid of its own (measured: KIRO_SESSION_ID is
// the only Kiro variable there), so its id has no liveness anchor to check.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { DEFAULT_RECORD_DIR, DEFAULT_SPACE, REPO_ROOT, intentsDirOf, seedAidlcMemory, seededRecordDir } from "../harness/fixtures.ts";
import { NATIVE_RUNTIME_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_RUNTIME_CASE_TIMEOUT_MS);

const STATE = readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8");
const CURSOR_RECORD = DEFAULT_RECORD_DIR;
const CHAT_RECORD = "this-chat-00000002";
const CHAT = "sess-host-named-0001";
const projects: string[] = [];
afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Two records in one space: the shared selection names one, this chat is on the
// other. A command that ignores the chat lands on the wrong record.
function project(harnessDir: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t-host-var-")));
  projects.push(dir);
  cpSync(join(REPO_ROOT, "dist", harnessDir.slice(1), harnessDir), join(dir, harnessDir), { recursive: true });
  seedAidlcMemory(dir);
  const intents = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  for (const record of [CURSOR_RECORD, CHAT_RECORD]) {
    mkdirSync(join(intents, record), { recursive: true });
    writeFileSync(join(intents, record, "aidlc-state.md"), STATE);
  }
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify([
    { uuid: "00000000-0000-7000-8000-000000000001", slug: "fixture", dirName: CURSOR_RECORD, status: "in-flight" },
    { uuid: "00000000-0000-7000-8000-000000000002", slug: "this-chat", dirName: CHAT_RECORD, status: "in-flight" },
  ], null, 2)}\n`);
  expect(existsSync(seededRecordDir(dir))).toBe(true);
  lib.setActiveIntentCursor(dir, CURSOR_RECORD);
  lib.writeSessionBinding(dir, CHAT, DEFAULT_SPACE, CHAT_RECORD, "switch");
  return dir;
}

// A pid that has certainly exited: the id of a process this test already reaped.
function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", "0"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(done.pid).toBeGreaterThan(1);
  return done.pid as number;
}

// What the agent's own command reports as the active record, run the way the
// host runs it: the host's variables in the shell, no hook-injected identity.
function activeRecordSeenBy(dir: string, harnessDir: string, env: NodeJS.ProcessEnv): string | null {
  const tool = join(dir, harnessDir, "tools", "aidlc-utility.ts");
  const r = spawnSync(process.execPath, [tool, "intent", "list", "--json", "--project-dir", dir], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_HARNESS_DIR: harnessDir,
      AIDLC_PROJECT_DIR: dir,
      AIDLC_SESSION_OVERRIDE: undefined,
      AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
      CODEX_THREAD_ID: undefined,
      CLAUDE_PROJECT_DIR: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      CLAUDECODE: undefined,
      CLAUDE_PID: undefined,
      KIRO_SESSION_ID: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  return (JSON.parse(r.stdout ?? "{}") as { active: string | null }).active;
}

describe("the host names this chat in the agent's own shell", () => {
  test("Claude Code: the chat's id is followed while its host process is alive", () => {
    const dir = project(".claude");
    expect(activeRecordSeenBy(dir, ".claude", {
      CLAUDE_CODE_SESSION_ID: CHAT,
      CLAUDE_PID: String(process.pid),
      CLAUDECODE: "1",
    })).toBe(CHAT_RECORD);
  });

  test("Claude Code: an id left behind by a chat that is gone is ignored", () => {
    const dir = project(".claude");
    const dead = deadPid();
    // A shell started inside a chat keeps the variable after the chat ends.
    expect(activeRecordSeenBy(dir, ".claude", {
      CLAUDE_CODE_SESSION_ID: CHAT,
      CLAUDE_PID: String(dead),
      CLAUDECODE: "1",
    })).toBe(CURSOR_RECORD);
    // No pid to check at all is the same: the variable alone decides nothing.
    expect(activeRecordSeenBy(dir, ".claude", {
      CLAUDE_CODE_SESSION_ID: CHAT,
      CLAUDECODE: "1",
    })).toBe(CURSOR_RECORD);
  });

  test("Kiro CLI: the chat's id is followed; another harness's variable is not read", () => {
    const dir = project(".kiro");
    expect(activeRecordSeenBy(dir, ".kiro", { KIRO_SESSION_ID: CHAT })).toBe(CHAT_RECORD);
    // The id of a chat in another tool names nothing here.
    expect(activeRecordSeenBy(dir, ".kiro", {
      CLAUDE_CODE_SESSION_ID: CHAT,
      CLAUDE_PID: String(process.pid),
    })).toBe(CURSOR_RECORD);
  });
});
