// covers: hook:codex-adapter, hook:cursor-adapter, hook:kiro-adapter, hook:session-start
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createOrchestrationTestProject, FIXTURES_DIR, REPO_ROOT, seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const SESSION = "01995000-7a11-7000-8000-00000000d009";
const STEERING = ".kiro/steering/aidlc-active-memory.md";
type Harness = "codex" | "cursor" | "kiro" | "kiro-ide";

function fixture(harness: Harness) {
  const project = createOrchestrationTestProject();
  roots.push(project);
  const dir = harness === "kiro-ide" ? ".kiro" : `.${harness}`;
  cpSync(join(REPO_ROOT, "dist", harness, dir), join(project, dir), { recursive: true });
  writeFileSync(seededStateFile(project), readFileSync(join(FIXTURES_DIR, "state-completed.md"), "utf8")
    .replace("**Status**: Completed", "**Status**: Running"));
  // Deliberately no session binding: first-contact adapters may capture a
  // physical record with sessionId:null, while SessionStart supplies the ID.
  const env = testGuardEnvironment(process.env, "fixture");
  for (const key of [
    "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "AIDLC_HOOK_WORKFLOW_CONTEXT",
    "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "KIRO_SESSION_ID",
    "AIDLC_COMPILED_EXECUTABLE", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR",
    "AIDLC_RUNTIME_HARNESS_ROOT", "USER_PROMPT", "VSCODE_CODE_CACHE_PATH",
  ]) delete env[key];
  // Machine installation storage must be outside the project: the real
  // dispatcher correctly stands aside when those roots overlap.
  const user = `${project}-user-config`;
  mkdirSync(user);
  roots.push(user);
  Object.assign(env, {
    AIDLC_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project,
    CODEX_HOME: user, AIDLC_INSTALL_ROOT: join(user, "aidlc-install"),
  });
  let notice: string | null = null;
  let marker: string | null = null;
  if (harness === "codex") {
    const metadata = JSON.parse(readFileSync(join(project, dir, "tools", "data", "harness.json"), "utf8"));
    writeFileSync(join(project, dir, "config.toml"), `[tui]\nstatus_line = ${JSON.stringify(metadata.statusLine.items)}\n`);
    writeFileSync(join(user, "config.toml"), '[tui]\nstatus_line = ["model", "current-dir"]\n');
    notice = "AI-DLC's status line replaces yours in this project";
    marker = join(project, "aidlc.settings.local.json");
  } else if (harness === "cursor" || harness === "kiro-ide") {
    // A real shared-project setup notice. Cursor can coexist with the Kiro IDE
    // tree; the shared core tells either chat that its steering file is tracked.
    if (harness === "cursor") {
      mkdirSync(join(project, ".kiro", "tools", "data"), { recursive: true });
      writeFileSync(join(project, ".kiro", "tools", "data", "harness.json"), '{"name":"kiro-ide"}\n');
    }
    mkdirSync(join(project, ".kiro", "steering"), { recursive: true });
    writeFileSync(join(project, STEERING), "# Earlier tracked steering\n");
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: project, env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "-q");
    git("add", "--force", "--", STEERING);
    notice = `Your repo tracks ${STEERING}`;
    marker = join(project, "aidlc", ".aidlc-sessions", "kiro-ide-steering-tracked-asked");
  }
  const adapterName = harness === "kiro-ide" ? "kiro" : harness;
  return {
    project, dir, env, notice, marker,
    adapter: join(project, dir, "hooks", `aidlc-${adapterName}-adapter.ts`),
    payload: (event: string) => JSON.stringify({
      hook_event_name: "SessionStart", source: "startup", session_id: SESSION,
      conversation_id: SESSION, cwd: project, turn_id: event,
    }),
  };
}

function context(harness: Harness, output: string): string {
  if (harness === "kiro" || harness === "kiro-ide") return output;
  const value = JSON.parse(output);
  return harness === "cursor" ? value.additional_context
    : value.hookSpecificOutput?.additionalContext ?? value.additionalContext;
}

describe("actual child bootstrap survives completion before the adapter publishes", () => {
  for (const harness of ["codex", "cursor", "kiro", "kiro-ide"] as const) {
    test(`${harness}: late closure preserves identity and any one-time setup notice`, () => {
      const f = fixture(harness);
      const publisher = join(f.project, f.dir, "tools", "aidlc-hook-output.ts");
      const state = join(f.project, f.dir, "tools", "aidlc-state.ts");
      const runner = join(f.project, "close-before-adapter-output.ts");
      writeFileSync(runner, `
import { mock } from "bun:test";
import { spawnSync } from "node:child_process";
const { publishHookOutput, noteHookRefusal } = await import(${JSON.stringify(publisher)});
mock.module(${JSON.stringify(publisher)}, () => ({
  noteHookRefusal,
  publishHookOutput: (project, workflow, evaluate, independent) =>
    publishHookOutput(project, workflow, async () => {
      const code = await evaluate();
      const completed = spawnSync(process.execPath,
        [${JSON.stringify(state)}, "complete-workflow", "feedback-optimization", "--project-dir", project],
        { cwd: project, env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" }, encoding: "utf8" });
      if (completed.status !== 0) throw new Error(completed.stdout + completed.stderr);
      return code;
    }, independent),
}));
const { run } = await import(${JSON.stringify(f.adapter)});
process.exitCode = await run("session-start", ${JSON.stringify(f.payload("first"))});
`);
      const first = spawnSync(process.execPath, [runner], {
        cwd: f.project, env: f.env, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
      });
      expect(first.status, first.stderr).toBe(0);
      const firstContext = context(harness, first.stdout);
      expect(firstContext).toContain(`AIDLC Runtime Session: ${SESSION}`);
      expect(firstContext).not.toContain("ONLY authority on the next move");
      expect(readFileSync(seededStateFile(f.project), "utf8")).toContain("**Status**: Completed");
      if (f.notice) expect(firstContext.split(f.notice)).toHaveLength(2);
      const marker = f.marker ? readFileSync(f.marker, "utf8") : null;
      if (f.marker) expect(existsSync(f.marker)).toBe(true);
      const again = spawnSync(process.execPath, [f.adapter, "session-start"], {
        cwd: f.project, env: f.env, input: f.payload("second"), encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
      });
      expect(again.status, again.stderr).toBe(0);
      const secondContext = context(harness, again.stdout);
      expect(secondContext).toContain(`AIDLC Runtime Session: ${SESSION}`);
      if (f.notice !== null) expect(secondContext).not.toContain(f.notice);
      if (f.marker && marker !== null) expect(readFileSync(f.marker, "utf8")).toBe(marker);
      expect(readdirSync(join(f.project, "aidlc", ".aidlc-sessions"))
        .some((name) => name.startsWith(".hook-bootstrap-"))).toBe(false);
    });
  }
});
