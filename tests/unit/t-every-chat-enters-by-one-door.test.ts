// covers: function:resolveChat, function:resolveWorkflowSelection, function:enterHookWorkflow,
// function:noteHelperSession, function:helperSessionRoot
//
// Every id a host hands the engine (a hook payload's session_id, the shell's
// own chat variable, a helper's thread) passes through one function before any
// chat or work record is read: the raw id maps to its root chat through the
// helper-of fact the adapter wrote, that chat's binding is read, and a chat
// with no binding is bound at first contact by the rule a new chat follows at
// SessionStart (the shared cursor, silently). Two things follow, and this file
// pins both:
//   - a chat AI-DLC never saw start stays on the work selected at its first
//     command; the shared cursor moving afterwards (another chat switched)
//     does not move it;
//   - a helper's own id resolves to the chat that spawned it on every harness,
//     through the hook door as well as the shell door.
// Before this change a known id with no binding fell to the cursor on every
// command, and the hook door pinned nothing for an unbound id.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as lib from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { DEFAULT_RECORD_DIR, DEFAULT_SPACE, REPO_ROOT, intentsDirOf, seedAidlcMemory, seededRecordDir } from "../harness/fixtures.ts";
import { NATIVE_RUNTIME_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_RUNTIME_CASE_TIMEOUT_MS);

const STATE = readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8");
const CURSOR_RECORD = DEFAULT_RECORD_DIR;
const OTHER_RECORD = "second-chat-00000002";
const ROOT = "sess-root-0001";
const CHILD = "sess-child-0002";
const UNSEEN = "sess-unseen-0003";
const projects: string[] = [];
afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Two records in one space: the shared cursor names one; the other is a second chat's.
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t-one-door-")));
  projects.push(dir);
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(dir, ".claude"), { recursive: true });
  seedAidlcMemory(dir);
  const intents = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  for (const record of [CURSOR_RECORD, OTHER_RECORD]) {
    mkdirSync(join(intents, record), { recursive: true });
    writeFileSync(join(intents, record, "aidlc-state.md"), STATE);
  }
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify([
    { uuid: "00000000-0000-7000-8000-000000000001", slug: "fixture", dirName: CURSOR_RECORD, status: "in-flight" },
    { uuid: "00000000-0000-7000-8000-000000000002", slug: "second-chat", dirName: OTHER_RECORD, status: "in-flight" },
  ], null, 2)}\n`);
  expect(existsSync(seededRecordDir(dir))).toBe(true);
  lib.setActiveIntentCursor(dir, CURSOR_RECORD);
  return dir;
}

// A command of the chat itself: the chat's identity comes from this process's own
// environment, with nothing handed to it by a hook (no payload marker), on the
// named harness. `chat` undefined leaves the process with no identity at all,
// which is what the person's own terminal is.
function withShell<T>(dir: string, harnessDir: string, run: () => T, chat?: string): T {
  const previous = { ...process.env };
  process.env.AIDLC_HARNESS_DIR = harnessDir;
  process.env.AIDLC_PROJECT_DIR = dir;
  delete process.env.AIDLC_SESSION_OVERRIDE;
  delete process.env.AIDLC_SESSION_OVERRIDE_SOURCE;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CLAUDE_PROJECT_DIR;
  if (chat !== undefined) process.env.AIDLC_SESSION_OVERRIDE = chat;
  try {
    return run();
  } finally {
    process.env = previous;
  }
}

describe("every chat enters by one door", () => {
  test("a chat AI-DLC never saw start is bound at its first command and stays there when the cursor moves", () => {
    const dir = project();
    withShell(dir, ".claude", () => {
      expect(lib.readSessionBinding(dir, UNSEEN)).toBeNull();
      expect(lib.resolveWorkflowSelection(dir).intent).toBe(CURSOR_RECORD);
      // First contact settled it, silently, the way SessionStart settles a new chat.
      const bound = lib.readSessionBinding(dir, UNSEEN);
      expect(bound?.intent).toBe(CURSOR_RECORD);
      expect(bound?.source).toBe("cursor");
      // Another chat switches the shared cursor; this chat stays on its work.
      lib.setActiveIntentCursor(dir, OTHER_RECORD);
      expect(lib.resolveWorkflowSelection(dir).intent).toBe(CURSOR_RECORD);
    }, UNSEEN);
    // A process with no chat at all (the person's own terminal) follows the cursor.
    withShell(dir, ".claude", () => {
      expect(lib.resolveWorkflowSelection(dir).intent).toBe(OTHER_RECORD);
    });
    // A caller that NAMES this chat is asking about it, not acting as it: the
    // answer is the same and nothing new is settled.
    withShell(dir, ".claude", () => {
      expect(lib.resolveWorkflowSelection(dir, { sessionId: UNSEEN }).intent).toBe(CURSOR_RECORD);
      expect(lib.readSessionBinding(dir, "sess-named-only-0004")).toBeNull();
      expect(lib.resolveWorkflowSelection(dir, { sessionId: "sess-named-only-0004" }).intent).toBe(OTHER_RECORD);
      expect(lib.readSessionBinding(dir, "sess-named-only-0004")).toBeNull();
    });
  });

  test("a helper's own id resolves to the chat that spawned it on a non-Codex harness, through the hook door too", () => {
    const dir = project();
    lib.writeSessionBinding(dir, ROOT, DEFAULT_SPACE, OTHER_RECORD, "switch");
    lib.noteHelperSession(dir, ROOT, CHILD);
    withShell(dir, ".kiro", () => {
      // The shell door: the helper's id selects the root chat's work.
      const shell = lib.resolveWorkflowSelection(dir);
      expect(shell.intent).toBe(OTHER_RECORD);
      expect(shell.sessionId).toBe(ROOT);
      // The hook door: a payload carrying the helper's id is pinned to the root chat.
      const hook = lib.enterHookWorkflow(dir, CHILD);
      try {
        expect(hook.selection?.intent).toBe(OTHER_RECORD);
        expect(hook.participation).toBe("participant");
      } finally {
        hook.restore();
      }
      // No binding was written for the helper's own id: the root chat's is the one.
      expect(lib.readSessionBinding(dir, CHILD)).toBeNull();
    }, CHILD);
  });
});

// The pin: a raw id is read through resolveChat and nowhere else. Outside the
// library, a binding is read only by the named pure readers, each with a chat
// the engine has already resolved (SessionStart's pre-existing binding for the
// rebind offer, the session end, the observed creation, the Kiro IDE adapter's
// startup-or-resume check, and the statusline's display-only lite copy); the
// helper-of record is read by nobody else; and no hook or adapter hands an id to
// the cursor readers, which take a project and a space only.
describe("the pin: nothing else reads a binding or the cursor with a raw id", () => {
  const SRC = join(REPO_ROOT, "core");
  const HARNESS = join(REPO_ROOT, "harness");
  const PURE_BINDING_READERS = new Set([
    "core/hooks/aidlc-session-start.ts",
    "core/hooks/aidlc-session-end.ts",
    "core/hooks/aidlc-rebuild-stage-graph.ts",
    "core/hooks/aidlc-statusline.ts",
    "harness/kiro-ide/hooks/aidlc-kiro-adapter.ts",
  ]);
  function sources(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) out.push(path);
      }
    };
    walk(root);
    return out;
  }
  // The repository-relative name, with this platform's separator folded, so the
  // library's own exclusion and the reader list below compare the same shape on
  // Windows as on POSIX.
  const rel = (path: string): string => path.slice(REPO_ROOT.length + 1).split(sep).join("/");
  const files = [...sources(SRC), ...sources(HARNESS)].filter((path) => rel(path) !== "core/tools/aidlc-lib.ts");

  test("outside the library only the named pure readers read a binding, and nobody reads helper-of", () => {
    const bindingReaders = files.filter((path) => /\breadSessionBinding\(/.test(readFileSync(path, "utf-8"))).map(rel).sort();
    expect(bindingReaders).toEqual([...PURE_BINDING_READERS].sort());
    const helperReaders = files.filter((path) => /\bhelperSessionRoot\(/.test(readFileSync(path, "utf-8"))).map(rel);
    expect(helperReaders).toEqual([]);
  });

  test("no hook or adapter hands a session id to a cursor reader", () => {
    const offenders: string[] = [];
    for (const path of files) {
      for (const [index, line] of readFileSync(path, "utf-8").split("\n").entries()) {
        if (/\b(readActiveIntentCursor|activeIntent|activeSpace)\([^)]*[sS]ession/.test(line)) offenders.push(`${rel(path)}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the library reads a binding only in resolveChat and its own named pure readers", () => {
    const lib = readFileSync(join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"), "utf-8").split("\n");
    const callers: string[] = [];
    let current = "";
    for (const line of lib) {
      const fn = /^(?:export )?function (\w+)/.exec(line);
      if (fn) current = fn[1];
      if (/\breadSessionBinding\(/.test(line) && current !== "readSessionBinding") callers.push(current);
    }
    expect([...new Set(callers)].sort()).toEqual([
      "resolveChat",
      "takeSessionSelectionNotice",
      "unknownRuntimeSessionWarning",
      "writeSessionSelectionNotice",
    ]);
  });
});
