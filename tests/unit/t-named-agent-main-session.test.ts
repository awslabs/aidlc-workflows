// covers: hook:aidlc-state-transition-guard, function:delegatedAgentOf, function:authorityFor
//
// t-named-agent-main-session: on Claude Code a session started under a named
// agent (`--agent`, a background session, "Claude agents") is the main session,
// so its own /aidlc steps are never refused as a delegated agent's (#3209).
//
// Claude Code puts the session's agent in agent_type on every call of that
// session, marks a subagent's call (same session_id) with agent_id, and gives
// every hook process CLAUDE_CODE_SESSION_ID equal to the payload's session_id.
// The payloads and env below are the ones measured on Claude Code 2.1.312. An
// adapter names only a delegate in agent_type, under its own host's session id,
// so its delegate is still refused even where the harness name reads as claude.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authorityFor } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seedAidlcMemory } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SESSION = "c9911951-01b9-4524-b912-93aeefda2d8b";
const SUBAGENT_ID = "a8a30d0b327881676";
const FIRST_STEP = "bun .claude/tools/aidlc.ts engine orchestrate next a hello world command line tool in TypeScript";
const REFUSAL = "only the main workflow session can change stage status or routing";

const projects: string[] = [];
afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

/** A project with AI-DLC for Claude Code, and an opencode tree beside it. */
function claudeProject(): string {
  const project = createTestProject();
  projects.push(project);
  cpSync(AIDLC_SRC, join(project, ".claude"), { recursive: true });
  seedAidlcMemory(project);
  mkdirSync(join(project, ".aidlc", "tools", "data"), { recursive: true });
  writeFileSync(join(project, ".aidlc", "tools", "data", "harness.json"), JSON.stringify({ name: "opencode" }));
  return project;
}

/** Claude Code's shell call, through the group settings.json registers. */
function shellCall(
  project: string,
  payload: Record<string, unknown>,
  hostSession: string | null,
): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project };
  for (const name of ["CLAUDE_CODE_SESSION_ID", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR", "AIDLC_PROJECT_DIR", "AIDLC_UNATTENDED"]) {
    delete env[name];
  }
  if (hostSession !== null) env.CLAUDE_CODE_SESSION_ID = hostSession;
  const r = spawnSync(
    "bun",
    [join(project, ".claude", "tools", "aidlc.ts"), "engine", "hook", "guard-tool-call"],
    {
      cwd: project,
      env,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: project,
        tool_name: "Bash",
        tool_input: { command: FIRST_STEP, description: "Run AI-DLC orchestrator next step" },
        ...payload,
      }),
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("t-named-agent-main-session the first /aidlc step", () => {
  test("a session started under a named agent runs its first step", () => {
    const project = claudeProject();
    const r = shellCall(project, { session_id: SESSION, agent_type: "claude" }, SESSION);
    expect(`${r.stdout}${r.stderr}`).not.toContain("Delegated agent");
    expect(r.code).toBe(0);
  });

  test("a subagent of that session is still refused, with the same line", () => {
    const project = claudeProject();
    const r = shellCall(
      project,
      { session_id: SESSION, agent_type: "general-purpose", agent_id: SUBAGENT_ID },
      SESSION,
    );
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(`Delegated agent \\"general-purpose\\" cannot run aidlc.ts engine orchestrate next`);
    expect(r.stdout).toContain(REFUSAL);
  });

  test("an adapter's delegate is still refused when the harness name reads as claude", () => {
    const project = claudeProject();
    for (const [payload, hostSession] of [
      [{ session_id: "ses_opencode0001", agent_type: "aidlc-developer-agent" }, SESSION],
      [{ session_id: "ses_opencode0001", agent_type: "aidlc-developer-agent" }, null],
      [{ agent_type: "aidlc-developer-agent" }, null],
      [{ session_id: "", agent_type: "aidlc-developer-agent" }, ""],
    ] as const) {
      const r = shellCall(project, payload, hostSession);
      expect(r.code, JSON.stringify([payload, hostSession])).toBe(2);
      expect(r.stdout, JSON.stringify([payload, hostSession])).toContain(REFUSAL);
    }
  });
});

describe("t-named-agent-main-session the authority every guard records", () => {
  const actorFor = (project: string, hookInput: Record<string, unknown>, hostSession: string | null) => {
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    if (hostSession === null) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = hostSession;
    try {
      return authorityFor(project, { hookInput }).actor;
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = saved;
    }
  };

  test("the named-agent session acts as the main session; its subagent and its dispatches as before", () => {
    const project = claudeProject();
    const bash = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };
    expect(actorFor(project, { ...bash, session_id: SESSION, agent_type: "claude" }, SESSION)).toBe("main");
    expect(actorFor(project, { ...bash, session_id: SESSION }, SESSION)).toBe("main");
    expect(
      actorFor(project, { ...bash, session_id: SESSION, agent_type: "general-purpose", agent_id: SUBAGENT_ID }, SESSION),
    ).toBe("subagent");
    expect(actorFor(project, { ...bash, session_id: SESSION, agent_type: "claude" }, null)).toBe("subagent");
    const dispatch = {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt: "build it" },
      session_id: SESSION,
    };
    expect(actorFor(project, { ...dispatch, agent_type: "claude" }, SESSION)).toBe("subagent");
    expect(actorFor(project, dispatch, SESSION)).toBe("subagent");
  });
});
