// covers: hook:aidlc-record-human-turn, hook:aidlc-session-start, hook:aidlc-session-end,
// hook:aidlc-continue-workflow, hook:aidlc-write-audit-log, hook:aidlc-run-sensors,
// hook:aidlc-sync-workflow-state, hook:aidlc-validate-state, hook:aidlc-plan-approval-guard,
// hook:aidlc-state-transition-guard, hook:aidlc-review-freeze, hook:aidlc-reviewer-scope
//
// Completed and archived work stays selected for history. Real hook entrypoints
// must leave every record file alone while still retaining the next human
// request outside that record and enforcing the independent runtime boundary.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  REPO_ROOT,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  cleanupTestProject,
  createOrchestrationTestProject,
  seedAuditFile,
  seedStateFile,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { writeSessionBinding } from "../../core/tools/aidlc-lib.ts";
import { listMessages } from "../../core/tools/aidlc-message-store.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const SESSION = "019b0000-1438-7000-8000-000000000001";
const created: string[] = [];
afterEach(() => {
  for (const project of created.splice(0)) cleanupTestProject(project);
});

function fixture(status: "Running" | "Completed" | "Archived", harness = "claude"): string {
  const project = createOrchestrationTestProject();
  created.push(project);
  seedStateFile(project, "state-brownfield-feature.md");
  seedAuditFile(project);
  const state = readFileSync(seededStateFile(project), "utf8")
    .replace(/(- \*\*Status\*\*:\s*)[^\n]+/, `$1${status}`)
    .replace(/(- \*\*Current Stage\*\*:\s*)[^\n]+/, "$1code-generation");
  writeFileSync(seededStateFile(project), state);
  writeSessionBinding(project, SESSION, DEFAULT_SPACE, DEFAULT_RECORD_DIR, "switch");
  const harnessDir = harness === "copilot" ? ".aidlc" : harness === "kiro-ide" ? ".kiro" : `.${harness}`;
  cpSync(join(REPO_ROOT, "dist", harness, harnessDir), join(project, harnessDir), { recursive: true });
  const engine = join(seededRecordDir(project), ".aidlc-engine");
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "closed-history.txt"), "history\n");
  return project;
}

/** Files, directories, contents and mtimes: a hidden heartbeat counts too. */
function snapshot(project: string): Record<string, string> {
  const root = seededRecordDir(project);
  const result: Record<string, string> = {};
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path, { bigint: true });
      if (stat.isDirectory()) {
        result[`${rel}/`] = "directory";
        visit(path, rel);
      } else {
        result[rel] = `${stat.mtimeNs}:${readFileSync(path).toString("base64")}`;
      }
    }
  };
  visit(root, "");
  return result;
}

function invoke(
  project: string,
  executable: string,
  args: string[],
  payload: Record<string, unknown>,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: project,
    input: JSON.stringify({ cwd: project, session_id: SESSION, ...payload }),
    encoding: "utf8",
    env: {
      ...process.env,
      AIDLC_PROJECT_DIR: project,
      CLAUDE_PROJECT_DIR: project,
      AIDLC_SESSION_OVERRIDE: SESSION,
      AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
      AIDLC_UNATTENDED: "0",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
      AIDLC_HOOK_DEBUG: "1",
    },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hook(project: string, name: string, payload: Record<string, unknown>) {
  return invoke(project, join(AIDLC_SRC, "tools", "aidlc.ts"), ["engine", "hook", name], payload);
}

function adapter(project: string, harness: "codex" | "copilot" | "kiro-ide" | "kiro" | "cursor", target: string, payload: Record<string, unknown>) {
  const dir = harness === "copilot" ? ".aidlc" : harness === "kiro-ide" ? ".kiro" : `.${harness}`;
  const file = harness === "kiro-ide" ? "aidlc-kiro-adapter.ts" : `aidlc-${harness}-adapter.ts`;
  return invoke(project, join(project, dir, "hooks", file), [target], payload);
}

describe("issue1438: terminal records are historical selections", () => {
  for (const status of ["Completed", "Archived"] as const) {
    test(`${status}: ambient core events preserve all record files`, () => {
      const project = fixture(status);
      const before = snapshot(project);
      const file = join(seededRecordDir(project), "memory.md");
      const events: Array<[string, Record<string, unknown>]> = [
        ["session-start", { hook_event_name: "SessionStart", source: "startup" }],
        ["session-end", { hook_event_name: "SessionEnd", reason: "finished" }],
        ["continue-workflow", { hook_event_name: "Stop", stop_hook_active: false }],
        ["validate-state", { hook_event_name: "PreCompact" }],
        ["write-audit-log", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } }],
        ["run-sensors", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } }],
        ["sync-workflow-state", { hook_event_name: "PostToolUse", tool_name: "TaskUpdate", tool_input: { status: "in_progress", activeForm: "Working [application-design]" } }],
        ["rebuild-stage-graph", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "aidlc engine state complete --stage memory" } }],
        ["plan-approval-guard", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(project, "src", "unrelated.ts") } }],
        ["review-freeze", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(project, "src", "unrelated.ts") } }],
        ["reviewer-scope", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(project, "src", "unrelated.ts") } }],
        ["state-transition-guard", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "aidlc engine state start --stage application-design" } }],
        ["deliver-stage-rules", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "aidlc-developer", prompt: "An unrelated coding request" } }],
        ["log-subagent", { hook_event_name: "SubagentStop", agent_type: "aidlc-developer", agent_id: "issue1438-worker" }],
      ];
      for (const [name, payload] of events) {
        const result = hook(project, name, payload);
        expect(result.code, `${name}: ${result.stderr}`).toBe(0);
        expect(result.stdout, name).not.toContain("AIDLC WORKFLOW ACTIVE");
        expect(result.stdout, name).not.toContain('"decision":"block"');
        expect(snapshot(project), name).toEqual(before);
      }
      const prompt = "Explain how a Python list comprehension works.";
      const result = hook(project, "record-human-turn", { hook_event_name: "UserPromptSubmit", prompt });
      expect(result.code, result.stderr).toBe(0);
      expect(snapshot(project)).toEqual(before);
      expect(listMessages(project).at(-1)).toMatchObject({
        text: prompt,
        workflow: { space: DEFAULT_SPACE, intent: DEFAULT_RECORD_DIR, status },
      });
    });

    test(`${status}: independent runtime protection still refuses a tool write`, () => {
      const project = fixture(status);
      const before = snapshot(project);
      const result = hook(project, "state-transition-guard", {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(project, ".claude", "tools", "aidlc-lib.ts"), content: "replace runtime" },
      });
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain("runtime");
      expect(snapshot(project)).toEqual(before);
    });
  }

  test("Codex duplicate SessionStart cannot replay a live mission after closure", () => {
    const project = fixture("Running", "codex");
    const payload = { hook_event_name: "SessionStart", source: "startup" };
    const first = adapter(project, "codex", "session-start", payload);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("AIDLC WORKFLOW ACTIVE");
    writeFileSync(seededStateFile(project), readFileSync(seededStateFile(project), "utf8").replace("- **Status**: Running", "- **Status**: Completed"));
    const before = snapshot(project);
    const duplicate = adapter(project, "codex", "session-start", payload);
    expect(duplicate.code, duplicate.stderr).toBe(0);
    expect(duplicate.stdout).not.toContain("AIDLC WORKFLOW ACTIVE");
    expect(snapshot(project)).toEqual(before);
  });

  for (const harness of ["codex", "copilot", "cursor", "kiro"] as const) {
    test(`${harness}: completion during child response suppresses stale outer context`, () => {
      const project = fixture("Running", harness);
      const dir = harness === "copilot" ? ".aidlc" : `.${harness}`;
      // Deterministically model the child finishing its read just as another
      // owner closes the record, before the adapter forwards the response.
      writeFileSync(join(project, dir, "hooks", "aidlc-session-start.ts"), [
        'import { readFileSync, writeFileSync } from "node:fs";',
        `const statePath = ${JSON.stringify(seededStateFile(project))};`,
        'export async function run(): Promise<number> {',
        '  writeFileSync(statePath, readFileSync(statePath, "utf8").replace("- **Status**: Running", "- **Status**: Completed"));',
        '  process.stdout.write(JSON.stringify({ additionalContext: "AIDLC WORKFLOW ACTIVE stale mission" }));',
        '  return 0;',
        '}',
        'if (import.meta.main) process.exit(await run());',
      ].join("\n"));
      const result = adapter(project, harness, "session-start", { hook_event_name: "SessionStart", source: "startup" });
      expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(seededStateFile(project), "utf8")).toContain("- **Status**: Completed");
      expect(result.stdout).not.toContain("AIDLC WORKFLOW ACTIVE");
      expect(result.stdout).not.toContain("stale mission");
    });

    test(`${harness}: completion before outer guard publication recomputes independent refusal`, () => {
      const project = fixture("Running", harness);
      const dir = harness === "copilot" ? ".aidlc" : `.${harness}`;
      writeFileSync(join(project, dir, "hooks", "aidlc-state-transition-guard.ts"), [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import { currentHookWorkflow } from "../tools/aidlc-lib.ts";',
        `const statePath = ${JSON.stringify(seededStateFile(project))};`,
        'export async function run(): Promise<number> {',
        '  const state = readFileSync(statePath, "utf8");',
        `  if (state.includes("- **Status**: Running") && currentHookWorkflow(${JSON.stringify(project)})?.mode === "independent") return 0;`,
        '  if (state.includes("- **Status**: Running")) {',
        '    writeFileSync(statePath, state.replace("- **Status**: Running", "- **Status**: Completed"));',
        '    process.stderr.write("stale workflow refusal");',
        '  } else process.stderr.write("independent integrity refusal");',
        '  return 2;',
        '}',
        'if (import.meta.main) process.exit(await run());',
      ].join("\n"));
      const target = harness === "cursor" ? "guards" : harness === "copilot" ? "guard-tool-call" : "state-transition-guard";
      const result = adapter(project, harness, target, {
        hook_event_name: "PreToolUse",
        tool_name: harness === "kiro" ? "execute_bash" : "Bash",
        tool_input: { command: "pwd" },
      });
      expect(result.code, result.stderr).toBe(harness === "codex" || harness === "kiro" ? 2 : 0);
      expect(`${result.stdout}${result.stderr}`).not.toContain("stale workflow refusal");
      expect(`${result.stdout}${result.stderr}`).toContain("independent integrity refusal");
    });
  }

  test("Codex duplicate terminal prompt stays spent and independent refusals survive cache refresh", () => {
    const project = fixture("Completed", "codex");
    const before = snapshot(project);
    const payload = { hook_event_name: "UserPromptSubmit", prompt: "Start another parser fix.", turn_id: "issue1438-prompt" };
    expect(adapter(project, "codex", "record-human-turn", payload).code).toBe(0);
    const once = listMessages(project);
    expect(once).toHaveLength(1);
    expect(adapter(project, "codex", "record-human-turn", payload).code).toBe(0);
    expect(listMessages(project)).toEqual(once);
    const write = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "printf 'replace runtime' > .codex/tools/aidlc-lib.ts" },
      tool_use_id: "issue1438-protected-write",
    };
    for (let delivery = 0; delivery < 2; delivery++) {
      const refusal = adapter(project, "codex", "guard-tool-call", write);
      expect(refusal.code, refusal.stderr).toBe(2);
      expect(refusal.stderr).toContain("runtime");
    }
    expect(snapshot(project)).toEqual(before);
  });

  for (const harness of ["copilot", "kiro-ide"] as const) {
    test(`${harness}: direct adapter prompt and guard bookkeeping skip terminal records`, () => {
      const project = fixture("Completed", harness);
      const before = snapshot(project);
      const prompt = adapter(project, harness, "record-human-turn", {
        hook_event_name: "UserPromptSubmit", prompt: "Explain a parser.", userPrompt: "Explain a parser.", sessionId: SESSION,
      });
      expect(prompt.code, prompt.stderr).toBe(0);
      const guard = adapter(project, harness, "guard-tool-call", {
        hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pwd" },
        toolName: "executeBash", toolArgs: { command: "pwd" }, sessionId: SESSION,
      });
      expect(guard.code, guard.stderr).toBe(0);
      expect(snapshot(project)).toEqual(before);
    });
  }
});
