// covers: hook:copilot-adapter, function:hookChildEnv, function:withInheritedHookWorkflow
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  createOrchestrationTestProject, FIXTURES_DIR, REPO_ROOT, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { auditFilePath, writeSessionBinding } from "../../dist/copilot/.aidlc/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const SESSION = "01995000-7a11-7000-8000-00000000d005";
const B = "another-workflow-12345678";

function snapshot(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return `${path.slice(root.length)}\n${readFileSync(path, "utf8")}`;
    }).sort();
}

function fixture(status: "Completed" | "Archived" | "Running") {
  const project = createOrchestrationTestProject();
  roots.push(project);
  cpSync(join(REPO_ROOT, "dist", "copilot", ".aidlc"), join(project, ".aidlc"), { recursive: true });
  const a = seededRecordDir(project);
  const intents = dirname(a);
  const b = join(intents, B);
  mkdirSync(b);
  const base = readFileSync(join(FIXTURES_DIR, "state-completed.md"), "utf8");
  writeFileSync(seededStateFile(project), base.replace("**Status**: Completed", `**Status**: ${status}`));
  writeFileSync(join(b, "aidlc-state.md"), base.replace("**Status**: Completed", "**Status**: Running"));
  for (const record of [a, b]) {
    mkdirSync(join(record, "inception"));
    writeFileSync(join(record, "inception", "requirements.md"), "# Requirements\n\n## Requirements\n");
    const audit = auditFilePath(project, basename(record), "default");
    mkdirSync(dirname(audit), { recursive: true });
    writeFileSync(audit, "# Audit Log\n");
  }
  writeFileSync(join(intents, "active-intent"), `${B}\n`);
  writeSessionBinding(project, SESSION, "default", basename(a), "create");
  const env = testGuardEnvironment(process.env, "fixture");
  for (const key of [
    "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "CODEX_THREAD_ID",
    "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "KIRO_SESSION_ID",
    "AIDLC_COMPILED_EXECUTABLE", "AIDLC_HOOK_WORKFLOW_CONTEXT",
  ]) delete env[key];
  Object.assign(env, { AIDLC_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project });
  const input = (record: string) => JSON.stringify({
    session_id: SESSION, cwd: project, tool_name: "Write",
    tool_input: { file_path: join(record, "inception", "requirements.md") },
  });
  return { project, a, b, intents, env, input, adapter: join(project, ".aidlc", "hooks", "aidlc-copilot-adapter.ts") };
}

describe("Copilot child hooks keep the physical workflow captured by the parent event", () => {
  test.each(["Completed", "Archived"] as const)("%s chat A cannot emit audit or health into cursor-selected B", (status) => {
    const f = fixture(status);
    const a = snapshot(f.a), b = snapshot(f.b);
    const result = spawnSync(process.execPath, [f.adapter, "post-tool"], {
      cwd: f.project, env: f.env, input: f.input(f.b), encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(snapshot(f.a)).toEqual(a);
    expect(snapshot(f.b)).toEqual(b);
  });

  test.each([false, true])("a binding/cursor switch between parent admission and child entry preserves A (completion=%s)", (complete) => {
    const f = fixture("Running");
    writeFileSync(join(f.intents, "active-intent"), `${basename(f.a)}\n`);
    const b = snapshot(f.b);
    const runner = join(f.project, "switch-before-hook-child.ts");
    const switcher = join(f.project, "switch-chat.ts");
    const lib = join(f.project, ".aidlc", "tools", "aidlc-lib.ts");
    writeFileSync(switcher, `
import { writeFileSync } from "node:fs";
import { writeSessionBinding } from ${JSON.stringify(lib)};
writeSessionBinding(${JSON.stringify(f.project)}, ${JSON.stringify(SESSION)}, "default", ${JSON.stringify(B)}, "switch");
writeFileSync(${JSON.stringify(join(f.intents, "active-intent"))}, ${JSON.stringify(`${B}\n`)});
`);
    // The parent has already built the immutable child context when spawnSync
    // is called. Another actual process switches the binding before that child
    // starts; optionally complete A through the real lifecycle command too.
    writeFileSync(runner, `
import { spawnSync } from "node:child_process";
const original = Bun.spawnSync;
let switched = false;
Bun.spawnSync = ((...args) => {
  if (!switched) {
    switched = true;
    ${complete ? `const completed = spawnSync(process.execPath, [${JSON.stringify(join(f.project, ".aidlc", "tools", "aidlc-state.ts"))},
      "complete-workflow", "feedback-optimization", "--project-dir", ${JSON.stringify(f.project)}],
      { env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" }, encoding: "utf8" });
    if (completed.status !== 0) throw new Error(completed.stdout + completed.stderr);` : ""}
    const switchedChat = spawnSync(process.execPath, [${JSON.stringify(switcher)}], { env: process.env, encoding: "utf8" });
    if (switchedChat.status !== 0) throw new Error(switchedChat.stderr);
  }
  return original(...args);
});
const { run } = await import(${JSON.stringify(f.adapter)});
process.exitCode = await run("post-tool", ${JSON.stringify(f.input(f.a))});
`);
    const result = spawnSync(process.execPath, [runner], {
      cwd: f.project, env: f.env, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(snapshot(f.b)).toEqual(b);
    const health = join(f.a, ".aidlc-engine", "hooks-health", "write-audit-log.last");
    expect(existsSync(health)).toBe(!complete);
    const audit = readFileSync(auditFilePath(f.project, basename(f.a), "default"), "utf8");
    expect(audit.includes("**Event**: ARTIFACT_CREATED")).toBe(!complete);
    const binding = JSON.parse(readFileSync(join(f.project, "aidlc", ".aidlc-sessions", `${SESSION}.binding.json`), "utf8"));
    expect(binding.intent).toBe(B);
  });

  test("a proven explicit creation receipt can still move a completed chat to its new intent", () => {
    const f = fixture("Completed");
    const a = snapshot(f.a), b = snapshot(f.b);
    const tool = join(f.project, ".aidlc", "tools", "aidlc-utility.ts");
    const created = spawnSync(process.execPath, [
      tool, "intent-create", "--scope", "bugfix", "--label", "new work",
      "--arguments", "fix the new parser", "--project-dir", f.project,
    ], { cwd: f.project, env: f.env, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
    expect(created.status, created.stdout + created.stderr).toBe(0);
    const selected = readFileSync(join(f.intents, "active-intent"), "utf8").trim();
    expect(selected).not.toBe(basename(f.a));
    expect(selected).not.toBe(B);
    const result = spawnSync(process.execPath, [f.adapter, "post-tool"], {
      cwd: f.project, env: f.env, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
      input: JSON.stringify({
        session_id: SESSION, cwd: f.project, tool_name: "Bash",
        tool_input: { command: "bun .aidlc/tools/aidlc-utility.ts intent-create --scope bugfix" },
        tool_response: created.stdout,
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    const binding = JSON.parse(readFileSync(join(f.project, "aidlc", ".aidlc-sessions", `${SESSION}.binding.json`), "utf8"));
    expect(binding.intent).toBe(selected);
    expect(binding.source).toBe("create");
    expect(snapshot(f.a)).toEqual(a);
    expect(snapshot(f.b)).toEqual(b);
  });

  test("outer SessionStart publication keeps the child's bootstrap after late completion", () => {
    const f = fixture("Running");
    const b = snapshot(f.b);
    const publisher = join(f.project, ".aidlc", "tools", "aidlc-hook-output.ts");
    const runner = join(f.project, "complete-before-adapter-publication.ts");
    writeFileSync(runner, `
import { mock } from "bun:test";
import { spawnSync } from "node:child_process";
const { publishHookOutput, noteHookRefusal } = await import(${JSON.stringify(publisher)});
mock.module(${JSON.stringify(publisher)}, () => ({
  noteHookRefusal,
  publishHookOutput: (project, workflow, evaluate, independent) =>
    publishHookOutput(project, workflow, async () => {
      const code = await evaluate();
      const completed = spawnSync(process.execPath, [${JSON.stringify(join(f.project, ".aidlc", "tools", "aidlc-state.ts"))},
        "complete-workflow", "feedback-optimization", "--project-dir", project],
        { cwd: project, env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" }, encoding: "utf8" });
      if (completed.status !== 0) throw new Error(completed.stdout + completed.stderr);
      return code;
    }, independent),
}));
const { run } = await import(${JSON.stringify(f.adapter)});
process.exitCode = await run("session-start", ${JSON.stringify(JSON.stringify({
  session_id: SESSION, cwd: f.project, hook_event_name: "SessionStart", source: "new",
}))});
`);
    const result = spawnSync(process.execPath, [runner], {
      cwd: f.project, env: f.env, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    expect(result.status, result.stderr).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.additionalContext).toContain(`AIDLC Runtime Session: ${SESSION}`);
    expect(response.additionalContext).not.toContain("ONLY authority on the next move");
    expect(response.hookSpecificOutput.additionalContext).toBe(response.additionalContext);
    expect(readFileSync(seededStateFile(f.project), "utf8")).toContain("**Status**: Completed");
    expect(snapshot(f.b)).toEqual(b);
    expect(readdirSync(join(f.project, "aidlc", ".aidlc-sessions"))
      .some((name) => name.startsWith(".hook-bootstrap-"))).toBe(false);
  });
});
