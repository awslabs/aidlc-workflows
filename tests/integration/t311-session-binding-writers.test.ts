// covers: hook:aidlc-session-start function:writeSessionPidAncestry subcommand:aidlc-utility:intent subcommand:aidlc-utility:space subcommand:aidlc-utility:intent-create subcommand:aidlc-utility:space-create
//
// Real subprocess coverage for every increment-1 binding writer. PID ancestry
// must beat the legacy fixed-name marker while shared cursors remain write-through.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeIntent,
  activeSpace,
  createIntent,
  readAllAuditShards,
  readSessionBinding,
  readSessionIntentHandoff,
  readSessionIntentUuid,
  resolveWorkflowSelection,
  sessionPidMapDir,
  setActiveIntentCursor,
  setActiveSpaceCursor,
  writeCurrentSessionId,
  writeSessionBinding,
  writeSessionIntentUuid,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { intentUsageKey } from "../../dist/claude/.claude/tools/aidlc-usage.ts";
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

  test("two cold sessions retain null bindings when one later creates the first intent", () => {
    removeWorkspaceRecord(proj);

    expect(fireSessionStart("cold-session-a")).toBe(0);
    expect(fireSessionStart("cold-session-b")).toBe(0);
    expect(readSessionBinding(proj, "cold-session-a")).toMatchObject({
      space: "default",
      intent: null,
    });
    expect(readSessionBinding(proj, "cold-session-b")).toMatchObject({
      space: "default",
      intent: null,
    });

    const result = util(["intent-create", "--scope", "poc"]);
    expect(result.status, result.stderr).toBe(0);
    const created = activeIntent(proj, "default");
    expect(created).not.toBeNull();
    expect(readSessionBinding(proj, "cold-session-b")?.intent).toBe(created);
    expect(resolveWorkflowSelection(proj, { sessionId: "cold-session-a" })).toMatchObject({
      space: "default",
      intent: null,
    });
  });

  test("two spaces select bound workflows while shared delivered rules follow the last start", () => {
    const first = createIntent(proj, "first", "default", "feature");
    const team = createIntent(proj, "team-work", "team-b", "feature");
    writeSessionBinding(proj, "space-session-a", "default", first.dirName);
    writeSessionBinding(proj, "space-session-b", "team-b", team.dirName);
    setActiveSpaceCursor(proj, "team-b");
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    const stub = join(proj, ".claude", "rules", "aidlc.md");

    expect(fireSessionStart("space-session-a")).toBe(0);
    expect(resolveWorkflowSelection(proj, { sessionId: "space-session-a" })).toMatchObject({
      space: "default",
      intent: first.dirName,
    });
    expect(readAllAuditShards(proj, first.dirName, "default")).toContain(
      "**Event**: SESSION_STARTED",
    );
    expect(readFileSync(stub, "utf-8")).toContain("aidlc/spaces/default/memory/");

    expect(fireSessionStart("space-session-b")).toBe(0);
    expect(resolveWorkflowSelection(proj, { sessionId: "space-session-b" })).toMatchObject({
      space: "team-b",
      intent: team.dirName,
    });
    expect(readAllAuditShards(proj, team.dirName, "team-b")).toContain(
      "**Event**: SESSION_STARTED",
    );
    expect(readFileSync(stub, "utf-8")).toContain("aidlc/spaces/team-b/memory/");
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

  test("PostToolUse moves binding, usage attribution, and handoff to the created intent", () => {
    const first = createIntent(proj, "first", "default", "feature");
    const created = createIntent(proj, "post-tool", "default", "feature");
    writeSessionBinding(proj, "exact-session", "default", first.dirName);
    writeSessionIntentUuid(proj, "exact-session", first.uuid);
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
    expect(readSessionIntentUuid(proj, "exact-session")).toBe(created.uuid);
    expect(intentUsageKey(proj, "exact-session")).toBe(`intent:${created.uuid}`);
    expect(readSessionIntentHandoff(proj, "exact-session")).toMatchObject({
      fromIntentUuid: first.uuid,
      toIntentUuid: created.uuid,
    });
  });

  test("space switch to an empty space clears prior intent attribution", () => {
    const first = createIntent(proj, "first", "default", "feature");
    writeSessionBinding(proj, "empty-space-session", "default", first.dirName);
    writeSessionIntentUuid(proj, "empty-space-session", first.uuid);
    writeSessionPidEntry(proj, process.pid, "empty-space-session");
    expect(util(["space", "create", "team-empty"]).status).toBe(0);

    const result = util(["space", "team-empty"]);
    expect(result.status, result.stderr).toBe(0);
    expect(readSessionBinding(proj, "empty-space-session")).toMatchObject({
      space: "team-empty",
      intent: null,
    });
    expect(readSessionIntentUuid(proj, "empty-space-session")).toBeNull();
    const other = createIntent(proj, "other-session", "default", "feature");
    setActiveIntentCursor(proj, other.dirName, "default");
    expect(intentUsageKey(proj, "empty-space-session")).toBe(
      "record:team-empty/legacy",
    );
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
