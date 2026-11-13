// covers: file:hooks/aidlc-session-start.ts, file:hooks/aidlc-validate-state.ts, hook:aidlc-session-start, hook:aidlc-validate-state

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COPILOT_TREE = join(REPO_ROOT, "dist", "copilot", ".aidlc");
const SESSION = "copilot-compact-2454";
const scratchProjects = new Set<string>();

afterAll(() => {
  for (const projectDir of scratchProjects) rmSync(projectDir, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function scratchProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t-copilot-compact-")));
  scratchProjects.add(dir);
  cpSync(COPILOT_TREE, join(dir, ".aidlc"), { recursive: true });
  for (const [source, target] of [
    [join(REPO_ROOT, "harness", "copilot", "hooks", "aidlc-copilot-adapter.ts"), join(dir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts")],
    [join(REPO_ROOT, "core", "hooks", "aidlc-session-start.ts"), join(dir, ".aidlc", "hooks", "aidlc-session-start.ts")],
    [join(REPO_ROOT, "core", "hooks", "aidlc-validate-state.ts"), join(dir, ".aidlc", "hooks", "aidlc-validate-state.ts")],
  ] as const) cpSync(source, target);
  const intentsDir = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(dir), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify([
      {
        uuid: "00000000-0000-7000-8000-000000000001",
        slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""),
        status: "in-flight",
      },
    ], null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(seededStateFile(dir), readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"));
  return dir;
}

type AdapterRun = { stdout: string; stderr: string; code: number };

function runAdapter(projectDir: string, target: string, payload: unknown): AdapterRun {
  const r = spawnSync("bun", [join(projectDir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target], {
    cwd: projectDir,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, AIDLC_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined, AIDLC_UNATTENDED: undefined },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

function contextOf(run: AdapterRun): string {
  if (run.stdout.trim().length === 0) return "";
  const parsed = JSON.parse(run.stdout) as { additionalContext?: unknown };
  return typeof parsed.additionalContext === "string" ? parsed.additionalContext : "";
}

function sessionStart(projectDir: string, source: string): AdapterRun {
  return runAdapter(projectDir, "session-start", {
    hook_event_name: "SessionStart",
    session_id: SESSION,
    cwd: projectDir,
    source,
  });
}

function preCompact(projectDir: string): AdapterRun {
  return runAdapter(projectDir, "validate-state", {
    hook_event_name: "PreCompact",
    session_id: SESSION,
    cwd: projectDir,
    transcript_path: "",
    trigger: "auto",
  });
}

function toolRun(projectDir: string, tool: string, toolInput: unknown): AdapterRun {
  return runAdapter(projectDir, "post-tool", {
    hook_event_name: "PostToolUse",
    session_id: SESSION,
    cwd: projectDir,
    tool_name: tool,
    tool_input: toolInput,
    tool_result: { result_type: "success", text_result_for_llm: "ok" },
  });
}

const READ = { path: "docs/notes.md" };

describe("a compacted Copilot chat is handed the workflow contract back", () => {
  test("the chat's next tool result carries the same state block the session start did", () => {
    const dir = scratchProject();
    const started = contextOf(sessionStart(dir, "new"));
    expect(started).toContain("AIDLC WORKFLOW ACTIVE");
    const stateLines = ["Runtime Session:", "Lifecycle Phase:", "Current Stage:", "Status:", "Active Agent:", "Last Completed:", "Next Action:"]
      .map((field) => started.split("\n").find((line) => line.startsWith(field)) ?? "");
    expect(stateLines.filter(Boolean).length).toBe(7);

    expect(preCompact(dir).code).toBe(0);

    const afterTool = toolRun(dir, "Read", READ);
    expect(afterTool.code, afterTool.stderr).toBe(0);
    const rendered = contextOf(afterTool);
    expect(rendered).toContain("AIDLC WORKFLOW ACTIVE");
    for (const line of stateLines) expect(rendered).toContain(line);
    expect(rendered).toContain("The engine route (`aidlc engine orchestrate`) is the ONLY authority on the next move.");
    expect(rendered).toContain("First: take everything the user typed after `/aidlc`");

    const audit = readdirSync(join(seededRecordDir(dir), "audit"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => readFileSync(join(seededRecordDir(dir), "audit", name), "utf-8"))
      .join("\n");
    expect(audit).toContain("**Event**: SESSION_COMPACTED");
  });

  test("the contract is handed back once per compaction, and not without one", () => {
    const dir = scratchProject();
    sessionStart(dir, "new");
    expect(contextOf(toolRun(dir, "Read", READ))).toBe("");
    preCompact(dir);
    expect(contextOf(toolRun(dir, "Bash", { command: "aidlc engine orchestrate next" }))).toContain("AIDLC WORKFLOW ACTIVE");
    expect(contextOf(toolRun(dir, "Read", READ))).toBe("");
    preCompact(dir);
    expect(contextOf(toolRun(dir, "Read", READ))).toContain("AIDLC WORKFLOW ACTIVE");
  });

  test("a session that starts again after a compaction renders it itself, with nothing handed back twice", () => {
    const dir = scratchProject();
    sessionStart(dir, "new");
    preCompact(dir);
    expect(contextOf(sessionStart(dir, "resume"))).toContain("AIDLC WORKFLOW ACTIVE");
    expect(contextOf(toolRun(dir, "Read", READ))).toBe("");
  });
});
