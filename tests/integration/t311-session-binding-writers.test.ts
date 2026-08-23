// covers: hook:aidlc-session-start function:writeSessionPidAncestry subcommand:aidlc-utility:intent subcommand:aidlc-utility:space subcommand:aidlc-utility:intent-create subcommand:aidlc-utility:space-create
//
// Real subprocess coverage for every increment-1 binding writer. PID ancestry
// must beat the legacy fixed-name marker while shared cursors remain write-through.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeIntent,
  activeSpace,
  createIntent,
  readSessionBinding,
  readSessionIntentUuid,
  sessionPidMapDir,
  setActiveIntentCursor,
  setActiveSpaceCursor,
  writeCurrentSessionId,
  writeSessionBinding,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  removeWorkspaceRecord,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const REBUILD = join(AIDLC_SRC, "hooks", "aidlc-rebuild-stage-graph.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

let proj = "";

beforeEach(() => {
  proj = createTestProject();
});

afterEach(() => {
  cleanupTestProject(proj);
  proj = "";
});

function fireSessionStart(sessionId: string): number {
  const result = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(
      JSON.stringify({ source: "startup", session_id: sessionId }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return result.exitCode;
}

function fireSession(source: string, sessionId: string): { status: number; stdout: string } {
  const result = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(JSON.stringify({ source, session_id: sessionId })),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return { status: result.exitCode, stdout: result.stdout.toString() };
}

function util(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [BUN, UTIL, ...args, "--project-dir", proj],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("t311 session binding writers", () => {
  test("SessionStart writes the binding and maps its harness ancestor", () => {
    const intent = createIntent(proj, "auth", "default", "feature");
    setActiveIntentCursor(proj, intent.dirName, "default");

    expect(fireSessionStart("session-start-a")).toBe(0);
    expect(readSessionBinding(proj, "session-start-a")).toMatchObject({
      space: "default",
      intent: intent.dirName,
    });

    const pidEntry = join(sessionPidMapDir(proj), String(process.pid));
    expect(existsSync(pidEntry)).toBe(true);
    expect(
      JSON.parse(readFileSync(pidEntry, "utf-8")).sessionId,
    ).toBe("session-start-a");
  });

  test("intent switch rebinds the nearest ancestry session, not current-session", () => {
    const first = createIntent(proj, "first", "default", "feature");
    const second = createIntent(proj, "second", "default", "feature");
    setActiveIntentCursor(proj, first.dirName, "default");
    writeSessionBinding(proj, "session-a", "default", first.dirName);
    writeSessionBinding(proj, "session-b", "default", first.dirName);
    writeSessionPidEntry(proj, process.pid, "session-a");
    writeCurrentSessionId(proj, "session-b");

    const result = util(["intent", second.slug]);
    expect(result.status, result.stderr).toBe(0);
    expect(activeIntent(proj, "default")).toBe(second.dirName);
    expect(readSessionBinding(proj, "session-a")?.intent).toBe(second.dirName);
    expect(readSessionBinding(proj, "session-b")?.intent).toBe(first.dirName);
    expect(readSessionIntentUuid(proj, "session-a")).toBe(second.uuid);
  });

  test("space switch rebinds the nearest session and keeps cursor write-through", () => {
    const first = createIntent(proj, "first", "default", "feature");
    const team = createIntent(proj, "team-work", "team-b", "feature");
    setActiveSpaceCursor(proj, "default");
    setActiveIntentCursor(proj, first.dirName, "default");
    writeSessionBinding(proj, "session-a", "default", first.dirName);
    writeSessionBinding(proj, "session-b", "default", first.dirName);
    writeSessionPidEntry(proj, process.pid, "session-a");
    writeCurrentSessionId(proj, "session-b");

    const result = util(["space", "team-b"]);
    expect(result.status, result.stderr).toBe(0);
    expect(activeSpace(proj)).toBe("team-b");
    expect(readSessionBinding(proj, "session-a")).toMatchObject({
      space: "team-b",
      intent: team.dirName,
    });
    expect(readSessionBinding(proj, "session-b")).toMatchObject({
      space: "default",
      intent: first.dirName,
    });
  });

  test("intent-create binds the creating session discovered from ancestry", () => {
    removeWorkspaceRecord(proj);
    writeSessionBinding(proj, "session-a", "default", null);
    writeSessionPidEntry(proj, process.pid, "session-a");

    const result = util(["intent-create", "--scope", "poc"]);
    expect(result.status, result.stderr).toBe(0);
    const created = activeIntent(proj, "default");
    expect(created).not.toBeNull();
    expect(readSessionBinding(proj, "session-a")).toMatchObject({
      space: "default",
      intent: created,
    });
  });

  test("space create preserves the current session binding", () => {
    const first = createIntent(proj, "first", "default", "feature");
    writeSessionBinding(proj, "session-a", "default", first.dirName);
    writeSessionPidEntry(proj, process.pid, "session-a");

    const result = util(["space", "create", "team-new"]);
    expect(result.status, result.stderr).toBe(0);
    expect(readSessionBinding(proj, "session-a")).toMatchObject({
      space: "default",
      intent: first.dirName,
    });
  });

  test("PostToolUse binds the exact invoking session", () => {
    const created = createIntent(proj, "post-tool", "default", "feature");
    const result = Bun.spawnSync({
      cmd: [BUN, REBUILD],
      stdin: new TextEncoder().encode(JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "exact-session",
        tool_name: "Bash",
        tool_input: { command: "bun .claude/tools/aidlc-utility.ts intent-create --scope feature" },
        tool_response: `Intent created: ${created.dirName} (space: default)\n`,
      })),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    expect(result.exitCode).toBe(0);
    expect(readSessionBinding(proj, "exact-session")?.intent).toBe(created.dirName);
  });

  test("resume No stays bound and Yes moves cursor, binding, and stamp together", () => {
    const first = createIntent(proj, "resume-first", "default", "feature");
    const second = createIntent(proj, "resume-second", "default", "feature");
    setActiveIntentCursor(proj, first.dirName, "default");
    expect(fireSession("startup", "resume-session").status).toBe(0);
    setActiveIntentCursor(proj, second.dirName, "default");

    const resumed = fireSession("resume", "resume-session");
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain("on No, keep working resume-first");
    expect(readSessionBinding(proj, "resume-session")?.intent).toBe(first.dirName);
    expect(readSessionIntentUuid(proj, "resume-session")).toBe(first.uuid);

    writeSessionPidEntry(proj, process.pid, "resume-session");
    expect(util(["intent", first.slug]).status).toBe(0);
    expect(activeIntent(proj, "default")).toBe(first.dirName);
    expect(readSessionBinding(proj, "resume-session")?.intent).toBe(first.dirName);
    expect(readSessionIntentUuid(proj, "resume-session")).toBe(first.uuid);
  });
});
