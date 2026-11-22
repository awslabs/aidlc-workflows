// t-copilot-reads-claude-settings: Copilot CLI loads AI-DLC's Claude settings
// without a warning, and runs none of AI-DLC's Claude hooks (#2921).
//
// covers: file:harness/claude/settings.json, file:tools/aidlc.ts, function:copilotRunsClaudeRegistration, hook:aidlc-record-human-turn
//
// WHAT. Copilot CLI reads .claude/settings.json as its own repository settings
// and runs the hooks registered there. It refuses the whole file when a
// PreToolUse, PostToolUse or PreCompact group has an empty matcher, and says so
// at every start; with the file loaded, it would run AI-DLC's Claude hooks
// beside the Copilot install's own wiring and record each typed line twice.
// So the shipped groups carry "*" (Claude Code matches "", a missing matcher
// and "*" alike), and `engine hook <name>` does nothing when Copilot CLI
// started it for a Claude registration. Every behavioural case drives the
// shipped `bun .claude/tools/aidlc.ts engine hook record-human-turn` in a
// scratch project, with the environment the host gives that hook process.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { copilotRunsClaudeRegistration } from "../../core/tools/aidlc.ts";
import { AIDLC_SRC, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// The events whose matcher Copilot CLI checks (1.0.103 names exactly these).
const COPILOT_MATCHED_EVENTS = ["PreToolUse", "PostToolUse", "PreCompact"];
const HOST_MARKER = /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_PROJECT_DIR|CODEX_|CURSOR_|KIRO_|OPENCODE|COPILOT_|VSCODE_|AIDLC_)/i;

interface Settings {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
}

function scratchProject(): string {
  const project = createTestProject();
  cpSync(AIDLC_SRC, join(project, ".claude"), { recursive: true });
  return project;
}

function messageRecords(project: string): string[] {
  const dir = join(project, "aidlc", ".aidlc-sessions", "messages");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

/** The shipped Claude registration for a typed line, run with `host` as the hook's environment. */
function typedLine(project: string, host: Record<string, string>): { stdout: string; stderr: string; code: number } {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!HOST_MARKER.test(key)) env[key] = value;
  }
  Object.assign(env, host);
  const r = spawnSync(
    "bun",
    [join(project, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
    {
      cwd: project,
      env,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "6d1f0c52-3b8e-4c1a-9f57-2a4e8b9c0d13",
        cwd: project,
        prompt: "fix the login page",
      }),
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

describe("Copilot CLI reads AI-DLC's Claude settings", () => {
  test("T1: no shipped group Copilot checks has an empty matcher", () => {
    for (const channel of ["dist", "dist-release"]) {
      const settings = JSON.parse(
        readFileSync(join(REPO_ROOT, channel, "claude", ".claude", "settings.json"), "utf-8"),
      ) as Settings;
      for (const event of COPILOT_MATCHED_EVENTS) {
        const groups = settings.hooks[event] ?? [];
        expect(groups.length, `${channel} ${event}`).toBeGreaterThan(0);
        for (const [index, group] of groups.entries()) {
          expect(group.matcher, `${channel} hooks.${event}[${index}]`).not.toBe("");
        }
      }
    }
  });

  test("T2: a Claude registration Copilot CLI runs records nothing and says nothing", () => {
    const project = scratchProject();
    const r = typedLine(project, { COPILOT_CLI: "1", CLAUDE_PROJECT_DIR: project });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(messageRecords(project)).toEqual([]);
  });

  test("T2b: the same hook run from Copilot's shell tool (no CLAUDE_PROJECT_DIR) still records the line", () => {
    const project = scratchProject();
    const r = typedLine(project, { COPILOT_CLI: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(messageRecords(project)).toHaveLength(1);
  });

  test("T3: Claude Code started from Copilot's shell still records the line", () => {
    const project = scratchProject();
    const r = typedLine(project, { COPILOT_CLI: "1", CLAUDECODE: "1", CLAUDE_PROJECT_DIR: project });
    expect(r.code, r.stderr).toBe(0);
    expect(messageRecords(project)).toHaveLength(1);
  });

  test("T4: the Copilot adapter's own core hook (harness pinned) still records the line", () => {
    const project = scratchProject();
    const r = typedLine(project, {
      COPILOT_CLI: "1",
      CLAUDE_PROJECT_DIR: project,
      AIDLC_PROJECT_DIR: project,
      AIDLC_HARNESS_NAME: "copilot",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(messageRecords(project)).toHaveLength(1);
  });

  test("T5: only Claude's own `engine hook` registrations stand aside under Copilot", () => {
    const copilot = { COPILOT_CLI: "1", CLAUDE_PROJECT_DIR: "/work" };
    expect(copilotRunsClaudeRegistration(["engine", "hook", "record-human-turn"], copilot)).toBe(true);
    expect(copilotRunsClaudeRegistration(["engine", "hook", "guard-tool-call"], copilot)).toBe(true);
    expect(copilotRunsClaudeRegistration(["engine", "hook", "fold-usage"], { ...copilot, AIDLC_HARNESS_NAME: "claude" }))
      .toBe(true);
    // Copilot's own wiring, the 2.8.0 spelling included, keeps running.
    expect(copilotRunsClaudeRegistration(["engine", "adapter", "copilot", "record-human-turn"], copilot)).toBe(false);
    expect(copilotRunsClaudeRegistration(["engine", "hook", "copilot-adapter", "record-human-turn"], copilot)).toBe(false);
    expect(copilotRunsClaudeRegistration(["engine", "hook", "record-human-turn"], { ...copilot, AIDLC_HARNESS_NAME: "copilot" }))
      .toBe(false);
    expect(copilotRunsClaudeRegistration(["engine", "hook", "record-human-turn"], { ...copilot, CLAUDECODE: "1" })).toBe(false);
    expect(copilotRunsClaudeRegistration(["engine", "hook", "record-human-turn"], { COPILOT_CLI: "1" })).toBe(false);
    expect(copilotRunsClaudeRegistration(["engine", "hook", "record-human-turn"], { CLAUDE_PROJECT_DIR: "/work" })).toBe(false);
  });
});
