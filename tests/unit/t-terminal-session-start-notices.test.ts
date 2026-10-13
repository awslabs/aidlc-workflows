// covers: hook:session-start
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AIDLC_SRC, createOrchestrationTestProject, FIXTURES_DIR, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { writeSessionBinding } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const SESSION = "01995000-7a11-7000-8000-00000000d004";
const NOTICE = "AI-DLC's status line replaces yours here; /aidlc --statusline off gives yours back.";

function fixture(status: "Completed" | "Archived" | "Running") {
  const project = createOrchestrationTestProject();
  roots.push(project);
  cpSync(AIDLC_SRC, join(project, ".claude"), { recursive: true });
  const state = seededStateFile(project);
  writeFileSync(state, readFileSync(join(FIXTURES_DIR, "state-completed.md"), "utf8")
    .replace("**Status**: Completed", `**Status**: ${status}`));
  writeSessionBinding(project, SESSION, "default", basename(seededRecordDir(project)), "create");
  const manifest = join(project, ".claude", "tools", "data", "aidlc-manifest.json");
  const baseline = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
  writeFileSync(manifest, JSON.stringify({ ...baseline, statusLineKept: true }));
  const personal = join(project, "isolated-claude-user");
  mkdirSync(personal);
  writeFileSync(join(personal, "settings.json"), JSON.stringify({
    statusLine: { type: "command", command: "echo mine" },
  }));
  const env = testGuardEnvironment(process.env, "fixture");
  for (const key of [
    "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "CODEX_THREAD_ID",
    "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "KIRO_SESSION_ID",
    "AIDLC_COMPILED_EXECUTABLE", "AIDLC_HARNESS_NAME", "AIDLC_RUNTIME_HARNESS_ROOT",
  ]) delete env[key];
  Object.assign(env, {
    AIDLC_PROJECT_DIR: project,
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_CONFIG_DIR: personal,
    AIDLC_MANAGED_SETTINGS_PATH: join(personal, "absent-managed.json"),
  });
  const input = JSON.stringify({ session_id: SESSION, source: "startup", hook_event_name: "SessionStart" });
  return { project, state, env, input, hook: join(project, ".claude", "hooks", "aidlc-session-start.ts") };
}

function assertSetupWasExplained(f: ReturnType<typeof fixture>, output: string): void {
  const response = JSON.parse(output.trim());
  expect(response.additionalContext).toContain(NOTICE);
  expect(response.additionalContext).not.toContain("ONLY authority on the next move");
  expect(JSON.parse(readFileSync(join(f.project, ".claude", "settings.local.json"), "utf8"))
    .statusLine.command).toContain("aidlc.ts");
  expect(JSON.parse(readFileSync(join(f.project, "aidlc.settings.local.json"), "utf8"))
    .flags.statusline).toBe("kept");
}

describe("independent SessionStart notices survive terminal workflow suppression", () => {
  test.each(["Completed", "Archived"] as const)("%s delivers an inherited setup notice exactly once", (status) => {
    const f = fixture(status);
    const before = readFileSync(f.state, "utf8");
    const started = spawnSync(process.execPath, [f.hook], {
      cwd: f.project, env: f.env, input: f.input, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    expect(started.status, started.stderr).toBe(0);
    assertSetupWasExplained(f, started.stdout);
    expect(readFileSync(f.state, "utf8")).toBe(before);
    expect(existsSync(join(seededRecordDir(f.project), "audit"))).toBe(false);
    const again = spawnSync(process.execPath, [f.hook], {
      cwd: f.project, env: f.env, input: f.input, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toContain("status line replaces yours");
  });

  test("completion after context evaluation preserves the notice in the fallback response", () => {
    const f = fixture("Running");
    const publisher = join(f.project, ".claude", "tools", "aidlc-hook-output.ts");
    const stateTool = join(f.project, ".claude", "tools", "aidlc-state.ts");
    const runner = join(f.project, "complete-before-session-publication.ts");
    // Pause at the actual publisher seam. Complete through the real state CLI
    // after the hook has produced its live context, before that context commits.
    writeFileSync(runner, `
import { mock } from "bun:test";
import { spawnSync } from "node:child_process";
const { publishHookOutput } = await import(${JSON.stringify(publisher)});
mock.module(${JSON.stringify(publisher)}, () => ({
  publishHookOutput: (project, workflow, evaluate, terminal) =>
    publishHookOutput(project, workflow, async () => {
      const code = await evaluate();
      const completed = spawnSync(process.execPath, [${JSON.stringify(stateTool)}, "complete-workflow", "feedback-optimization", "--project-dir", project], {
        cwd: project, env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" }, encoding: "utf8",
      });
      if (completed.status !== 0) throw new Error(completed.stdout + completed.stderr);
      return code;
    }, terminal),
}));
const { run } = await import(${JSON.stringify(f.hook)});
process.exitCode = await run(${JSON.stringify(f.input)});
`);
    const result = spawnSync(process.execPath, [runner], {
      cwd: f.project, env: f.env, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.state, "utf8")).toContain("**Status**: Completed");
    assertSetupWasExplained(f, result.stdout);
  });
});
