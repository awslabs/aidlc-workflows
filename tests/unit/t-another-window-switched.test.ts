// covers: function:handleIntent, function:resolveChat, function:takeSessionSelectionNotice
//
// A switch typed in a separate terminal has no chat of its own, so the engine
// fell back to whichever chat was active last and moved THAT chat's work:
// the person's open chat silently changed what it was on, which is the shape
// behind the Cursor report (#1683) and the known limitation in the guide. The
// shared selection is the terminal's own place and still moves; the chat does
// not, and its next step asks the person once whether to follow.

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
const HERE = DEFAULT_RECORD_DIR;
const THERE = "other-window-00000002";
const CHAT = "sess-open-chat-0001";
const projects: string[] = [];
afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// One open chat on record HERE, the shared selection on HERE too, and a second
// record the other window will switch to.
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t-other-window-")));
  projects.push(dir);
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(dir, ".claude"), { recursive: true });
  seedAidlcMemory(dir);
  const intents = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  for (const record of [HERE, THERE]) {
    mkdirSync(join(intents, record), { recursive: true });
    writeFileSync(join(intents, record, "aidlc-state.md"), STATE);
  }
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify([
    { uuid: "00000000-0000-7000-8000-000000000001", slug: "fixture", dirName: HERE, status: "in-flight" },
    { uuid: "00000000-0000-7000-8000-000000000002", slug: "other-window", dirName: THERE, status: "in-flight" },
  ], null, 2)}\n`);
  expect(existsSync(seededRecordDir(dir))).toBe(true);
  lib.setActiveIntentCursor(dir, HERE);
  lib.writeSessionBinding(dir, CHAT, DEFAULT_SPACE, HERE, "switch");
  // The chat fired a hook, so it is the last one the project saw.
  lib.writeCurrentSessionId(dir, CHAT);
  return dir;
}

const CLEAN: NodeJS.ProcessEnv = {
  AIDLC_SESSION_OVERRIDE: undefined,
  AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
  CLAUDE_CODE_SESSION_ID: undefined,
  CLAUDE_PID: undefined,
  CLAUDECODE: undefined,
  CODEX_THREAD_ID: undefined,
  KIRO_SESSION_ID: undefined,
  CLAUDE_PROJECT_DIR: undefined,
};

function run(dir: string, tool: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): { rc: number; out: string } {
  const r = spawnSync(process.execPath, [join(dir, ".claude", "tools", tool), ...args, "--project-dir", dir], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, ...CLEAN, AIDLC_PROJECT_DIR: dir, ...env } as NodeJS.ProcessEnv,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const selection = (dir: string): string => readFileSync(join(intentsDirOf(dir, DEFAULT_SPACE), "active-intent"), "utf-8").trim();
const chatIsOn = (dir: string): string | null => lib.readSessionBinding(dir, CHAT)?.intent ?? null;

describe("a switch typed in another window moves the selection, not this chat", () => {
  test("the terminal switch leaves the open chat where it is, and still moves the selection", () => {
    const dir = project();
    const switched = run(dir, "aidlc-utility.ts", ["intent", THERE]);
    expect(switched.rc, switched.out).toBe(0);
    expect(selection(dir)).toBe(THERE);
    expect(chatIsOn(dir)).toBe(HERE);
  });

  test("the open chat's next step asks once whether to follow, and never again for the same switch", () => {
    const dir = project();
    expect(run(dir, "aidlc-utility.ts", ["intent", THERE]).rc).toBe(0);
    const asChat = { AIDLC_SESSION_OVERRIDE: CHAT };
    const first = run(dir, "aidlc-orchestrate.ts", ["next"], asChat);
    expect(first.rc, first.out).toBe(0);
    // Plain words, both records named by the labels the person knows, and the
    // person is asked rather than told. The command the agent runs on a yes
    // names the record, not the label.
    expect(first.out).toContain("Another window switched to `other-window`.");
    expect(first.out).toContain("This chat is still on `fixture`.");
    expect(first.out).toContain("Do you want this chat on `other-window` too?");
    // The yes action is the engine command the agent runs, not the person's
    // slash form, so one step works on every harness.
    expect(first.out).toContain(`aidlc-utility.ts intent ${THERE}`);
    expect(first.out).not.toContain(`/aidlc intent ${THERE}`);
    // The step still works this chat's own record, not the one the other window chose.
    expect(first.out).toContain(`intents/${HERE}/`);
    expect(first.out).not.toContain(`intents/${THERE}/`);
    const second = run(dir, "aidlc-orchestrate.ts", ["next"], asChat);
    expect(second.rc, second.out).toBe(0);
    expect(second.out).not.toContain("Another window switched");
  });

  test("a switch typed in the chat itself still moves that chat", () => {
    const dir = project();
    const switched = run(dir, "aidlc-utility.ts", ["intent", THERE], { AIDLC_SESSION_OVERRIDE: CHAT });
    expect(switched.rc, switched.out).toBe(0);
    expect(selection(dir)).toBe(THERE);
    expect(chatIsOn(dir)).toBe(THERE);
  });
});
