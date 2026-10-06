// covers: file:core/tools/aidlc-lifecycle.ts file:core/tools/aidlc-install-paths.ts file:core/tools/aidlc-doctor.ts
//
// A native install runs every Claude Code hook. The installed project's hooks
// call a bare `aidlc`, and Claude Code on Windows runs hook commands through
// Git Bash, which ignores PATHEXT and never finds aidlc.cmd: without the
// extensionless launcher every hook printed "aidlc: command not found" and none
// ran. This installs this checkout's release the way a person's machine has it,
// configures a project through that launcher, runs each hook command from the
// project's settings.json through the shell Claude Code uses (Git Bash on
// Windows, sh elsewhere), and asks doctor, also as Kiro CLI's `/aidlc --doctor`.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import { writeReleaseFixture } from "../harness/release-fixture.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SKIP_REASON = gitBashSkipReason();

interface HookCommand {
  event: string;
  matcher: string;
  command: string;
}

let root = "";
let project = "";
let shell = "";
let env: NodeJS.ProcessEnv = {};
let hooks: HookCommand[] = [];
let statusLine = "";

function sh(command: string, input = "", extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(shell, ["-c", command], {
    cwd: project,
    encoding: "utf-8",
    env: { ...env, ...extra },
    input,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// What Claude Code sends each event, with a tool its matcher selects.
function payload(hook: HookCommand): object {
  const base = {
    session_id: "00000000-0000-4000-8000-00000000c1a0",
    transcript_path: join(root, "transcript.jsonl"),
    cwd: project,
    hook_event_name: hook.event,
  };
  const tool = hook.matcher.split("|")[0] || "Read";
  const inputs: Record<string, object> = {
    Read: { file_path: join(project, "README.md") },
    Edit: { file_path: join(project, "README.md"), old_string: "a", new_string: "b" },
    Write: { file_path: join(project, "README.md"), content: "hello\n" },
    Bash: { command: "echo hello" },
    Task: { description: "look around", prompt: "look around", subagent_type: "general-purpose" },
    TaskUpdate: { taskId: "1", status: "completed" },
    AskUserQuestion: { questions: [] },
  };
  switch (hook.event) {
    case "PreToolUse":
      return { ...base, tool_name: tool, tool_input: inputs[tool] ?? {} };
    case "PostToolUse":
      return { ...base, tool_name: tool, tool_input: inputs[tool] ?? {}, tool_response: {} };
    case "UserPromptSubmit":
      return { ...base, prompt: "hello" };
    case "SessionStart":
      return { ...base, source: "startup" };
    case "SessionEnd":
      return { ...base, reason: "other" };
    case "PreCompact":
      return { ...base, trigger: "manual", custom_instructions: "" };
    default:
      return { ...base, stop_hook_active: false };
  }
}

// The opt-in hook phase trace: the engine logs `dispatcher-start` with the
// hook's name, then `hook-run-end` with the code the hook returned.
function tracedRuns(directory: string): Array<{ hook: string; code: unknown }> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((file) => {
    const lines = readFileSync(join(directory, file), "utf-8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { phase?: string; hook?: string; code?: unknown });
    const start = lines.find((line) => line.phase === "dispatcher-start");
    const end = lines.find((line) => line.phase === "hook-run-end");
    return start?.hook && end ? [{ hook: start.hook, code: end.code }] : [];
  });
}

beforeAll(() => {
  if (SKIP_REASON !== null) return;
  shell = process.platform === "win32" ? gitBashPath() : "/bin/sh";
  root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-native-hooks-")));
  const release = join(root, "release");
  mkdirSync(release);
  const fixture = writeReleaseFixture({
    root: release,
    repoRoot: REPO_ROOT,
    version: AIDLC_VERSION,
    binary: "executable",
    distributions: ["claude", "kiro"],
  });
  const machine = join(root, "machine");
  const bin = join(machine, "bin");
  project = join(root, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  // The person's own environment: the install's bin first on PATH, the
  // production guards, and no project variables a test runner carries.
  env = testGuardEnvironment(process.env, "production");
  for (const key of Object.keys(env)) {
    if (/^(?:AIDLC|CLAUDE|KIRO|CURSOR)_PROJECT_DIR$|^AIDLC_TEST_CONFIG_TTY$/i.test(key)) delete env[key];
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env = {
    ...env,
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: bin,
    // A missing gh: the fixture release has no real attestation to verify.
    AIDLC_GH_BIN: join(root, "no-gh", process.platform === "win32" ? "gh.exe" : "gh"),
    NO_COLOR: "1",
    [pathKey]: [bin, env[pathKey] ?? ""].join(process.platform === "win32" ? ";" : ":"),
  };

  const installed = spawnSync(process.execPath, [
    join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts"), "update", "--version", AIDLC_VERSION, "--from", release,
  ], { cwd: project, encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(installed.status, installed.stdout + installed.stderr).toBe(0);

  // The fixture's binary only answers `version`; put this checkout's compiled
  // engine in its place so the installed launcher runs real hooks.
  const engine = join(root, fixture.binaryName);
  const built = spawnSync(process.execPath, [
    "build", join(REPO_ROOT, "dist-release", "claude", ".claude", "tools", "aidlc.ts"), "--compile", "--outfile", engine,
  ], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  const active = join(machine, "versions", AIDLC_VERSION, process.platform === "win32" ? "aidlc.exe" : "aidlc");
  expect(existsSync(active), `no installed binary at ${active}`).toBe(true);
  copyFileSync(engine, active);

  // The shell must find this install's launcher: another `aidlc` later on PATH,
  // such as the developer's own install, would hide a missing one.
  const found = sh(process.platform === "win32" ? 'cygpath -w "$(command -v aidlc)"' : "command -v aidlc");
  const launcher = join(bin, "aidlc");
  expect(found.status, `aidlc: command not found in ${shell}: ${found.stderr}`).toBe(0);
  const same = process.platform === "win32"
    ? found.stdout.trim().toLowerCase() === launcher.toLowerCase()
    : found.stdout.trim() === launcher;
  expect(same, `${shell} runs ${found.stdout.trim()} for aidlc, not ${launcher}`).toBe(true);

  // As a person does after installing: configure the project with `aidlc`.
  const configured = sh('aidlc config --project-dir "$NATIVE_HOOKS_PROJECT" --harness claude --mcp none --quiet', "", {
    NATIVE_HOOKS_PROJECT: project,
  });
  expect(configured.status, configured.stdout + configured.stderr).toBe(0);
  // A workflow gives the hooks real work to look at; start one the same way.
  const started = sh('aidlc engine intent create --scope bugfix --label "native hooks" --arguments "fix the flag parser"');
  expect(started.status, started.stdout + started.stderr).toBe(0);

  const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf-8")) as {
    hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
    statusLine?: { command?: string };
  };
  hooks = Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group) => (group.hooks ?? []).map((hook) => ({
      event,
      matcher: group.matcher ?? "",
      command: hook.command ?? "",
    }))));
  statusLine = settings.statusLine?.command ?? "";
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(SKIP_REASON !== null)("a native install runs every Claude Code hook through the shell Claude Code uses", () => {
  test("the project's hooks call the installed aidlc command", () => {
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) expect(hook.command).toMatch(/^aidlc engine hook [a-z-]+$/);
    expect(statusLine).toBe("aidlc engine statusline");
  });

  test("every hook command runs and records that it ran", () => {
    const failed: string[] = [];
    for (const [index, hook] of hooks.entries()) {
      const trace = join(root, "trace", String(index));
      const r = sh(hook.command, JSON.stringify(payload(hook)), { CLAUDE_PROJECT_DIR: project, AIDLC_HOOK_TRACE_DIR: trace });
      const name = hook.command.trim().split(/\s+/).at(-1) ?? "";
      const ran = r.status === 0 && !/command not found/.test(r.stderr) &&
        tracedRuns(trace).some((run) => run.hook === name && run.code === 0);
      if (!ran) failed.push(`${hook.event} ${hook.matcher || "*"}: ${hook.command} exited ${r.status}: ${r.stderr.trim()}`);
    }
    expect(failed).toEqual([]);
  });

  test("the status line runs", () => {
    const r = sh(statusLine, "{}", { CLAUDE_PROJECT_DIR: project });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("command not found");
  });

  test("doctor answers through the same shell and finds the hooks working", () => {
    const r = sh('aidlc doctor --project-dir "$NATIVE_HOOKS_PROJECT" --json', "", { NATIVE_HOOKS_PROJECT: project });
    expect(r.stderr).not.toContain("command not found");
    const report = JSON.parse(r.stdout) as {
      data?: { checks?: Array<{ pass: boolean; severity?: string; label: string; fix?: string }> };
    };
    const checks = report.data?.checks ?? [];
    expect(checks.length).toBeGreaterThan(0);
    if (process.platform === "win32") {
      expect(checks.find((check) => check.label.startsWith("Windows launcher (Git Bash)"))?.pass).toBe(true);
    }
    // Warnings are advice (such as starting the harness from a desktop icon); a
    // hook row that fails means the hooks do not work.
    expect(checks.filter((check) => !check.pass && check.severity !== "warn" && /hook/i.test(check.label))).toEqual([]);
  });

  test("Kiro CLI's /aidlc --doctor answers with the doctor report", () => {
    const configured = sh('aidlc config --project-dir "$NATIVE_HOOKS_PROJECT" --harness kiro --mcp none --quiet', "", {
      NATIVE_HOOKS_PROJECT: project,
    });
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    const agent = JSON.parse(readFileSync(join(project, ".kiro", "agents", "aidlc.json"), "utf-8")) as {
      hooks?: Record<string, Array<{ command?: string }>>;
    };
    const prompt = agent.hooks?.userPromptSubmit?.[0]?.command ?? "";
    expect(prompt).toBe("aidlc engine adapter kiro verb-intercept");
    const r = sh(prompt, JSON.stringify({ cwd: project, hook_event_name: "userPromptSubmit", prompt: "/aidlc --doctor" }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/command not found|unknown command/);
    expect(r.stdout).toContain("AI-DLC doctor");
  });
});
