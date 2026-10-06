// covers: function:hookLiveness, function:recordPreWorkflowHeartbeat, function:hookActivation, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:continue, subcommand:aidlc-utility:doctor
//
// VS Code skips a project's hooks without a word when the workspace is not
// trusted or Chat: Use Hooks is off, and the Copilot CLI does the same in a
// folder it does not trust. A workshop ran two days like that: the chat never
// said so, doctor had passed at setup, and approvals were silently never
// recorded. These cases drive the packaged Copilot tree the way a chat does
// (the adapter for each host event, the engine for each command the agent
// runs) and pin what the person is told:
//   - with no hook run, the first stage's directive carries one sentence
//     saying so, and every part of that delivery carries the same sentence;
//   - when the hooks run, the guards' heartbeat for the agent's own command
//     lands before the engine reads, so the sentence never appears;
//   - a conversation that has not joined the workflow, and a harness that does
//     not declare the sentence, never see it;
//   - doctor warns before the first chat and passes after it, and after a
//     stage with no hook it names Copilot's switches;
//   - a core hook that crashes still lets the action through and leaves its
//     error line for doctor.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, REPO_ROOT, toPortablePath } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const COPILOT_ROOT = join(REPO_ROOT, "dist", "copilot");
const CLAUDE_ROOT = join(REPO_ROOT, "dist", "claude");
const SESSION = "11111111-2222-4333-8444-555555555555";

const NOTICE = (
  JSON.parse(readFileSync(join(COPILOT_ROOT, ".aidlc", "tools", "data", "harness.json"), "utf-8")) as {
    hookActivation?: { notRunInWorkflow?: string; recovery?: string; notRunYet?: string; agentStep?: string };
  }
).hookActivation;

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// A fresh install of one packaged tree, nothing seeded: what `aidlc config`
// leaves in a new folder.
function installed(root: string): string {
  const base = process.env.TMPDIR || tmpdir();
  let proj = mkdtempSync(join(base, "aidlc-hook-health-"));
  try {
    proj = realpathSync(proj);
  } catch {
    // keep the raw path
  }
  proj = toPortablePath(proj);
  projects.push(proj);
  cpSync(root, proj, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  return proj;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "AIDLC_PROJECT_DIR",
    "CLAUDE_PROJECT_DIR",
    "AIDLC_HARNESS_NAME",
    "AIDLC_HARNESS_DIR",
    "AIDLC_SESSION_OVERRIDE",
    "AIDLC_COMPILED_EXECUTABLE",
    "AIDLC_RUNTIME_ROOT",
    "AIDLC_RUNTIME_HARNESS_ROOT",
    "AIDLC_COPILOT_SESSION_ID",
  ]) delete env[key];
  return env;
}

function run(proj: string, argv: string[], input = "") {
  const r = spawnSync(process.execPath, argv, {
    cwd: proj,
    input,
    encoding: "utf-8",
    env: cleanEnv(),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// One host event through the shipped adapter.
function hostEvent(proj: string, target: string, payload: Record<string, unknown>) {
  const r = run(
    proj,
    [join(proj, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target],
    JSON.stringify({ session_id: SESSION, cwd: proj, ...payload }),
  );
  expect(r.code, `${target}: ${r.stderr}`).toBe(0);
  return r;
}

function startChat(proj: string): void {
  hostEvent(proj, "session-start", { hook_event_name: "SessionStart", source: "new" });
}

// The PreToolUse the host fires before the agent's terminal command runs.
function beforeCommand(proj: string, command: string): void {
  hostEvent(proj, "guard-tool-call", {
    hook_event_name: "PreToolUse",
    tool_name: "run_in_terminal",
    tool_input: { command },
  });
}

// The PostToolUse the host fires once that command has returned its output.
function afterCommand(proj: string, command: string, output: string): void {
  hostEvent(proj, "post-tool", {
    hook_event_name: "PostToolUse",
    tool_name: "run_in_terminal",
    tool_input: { command },
    tool_response: output,
  });
}

function intentCreate(proj: string, harnessDir: string): string {
  const r = run(proj, [
    join(proj, harnessDir, "tools", "aidlc-utility.ts"),
    "intent-create",
    "--scope",
    "bugfix",
    "--label",
    "hook health",
    "--arguments",
    "fix the flag parser",
  ]);
  expect(r.code, r.stderr).toBe(0);
  return r.stdout;
}

type Printed = { kind: string; receipt?: string; part?: number; parts?: number; change_notices?: string[] };

function engine(proj: string, harnessDir: string, args: string[]): Printed {
  const r = run(proj, [join(proj, harnessDir, "tools", "aidlc-orchestrate.ts"), ...args]);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Printed;
}

function hookNotices(directive: Printed): string[] {
  return (directive.change_notices ?? []).filter((notice) => notice === NOTICE?.notRunInWorkflow);
}

function doctor(proj: string): string {
  const r = run(proj, [join(proj, ".aidlc", "tools", "aidlc-utility.ts"), "doctor", "--verbose"]);
  return `${r.stdout}${r.stderr}`;
}

function filesNamed(dir: string, suffix: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(suffix)) found.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

describe("Copilot: hooks that never ran are visible", () => {
  test("the packaged Copilot tree declares every hook-activation sentence", () => {
    expect(typeof NOTICE?.notRunInWorkflow).toBe("string");
    expect(typeof NOTICE?.notRunYet).toBe("string");
    expect(NOTICE?.recovery).toContain("Chat: Use Hooks");
    // The agent fixes the folder setting itself, then shows one line that
    // asks for nothing again.
    expect(NOTICE?.agentStep).toContain('"Fixed. Send your next message here to carry on."');
    expect(NOTICE?.agentStep).not.toMatch(/reply again|answer again/);
  });

  test("with no hook run, the first stage tells the person once per directive, on every part", () => {
    const proj = installed(COPILOT_ROOT);
    intentCreate(proj, ".aidlc");
    const first = engine(proj, ".aidlc", ["next"]);
    expect(hookNotices(first)).toEqual([NOTICE?.notRunInWorkflow ?? ""]);
    // The delivery stays in step: each part of it carries the same sentence,
    // so `continue` follows on instead of starting the stage over.
    let directive = first;
    for (let hop = 0; directive.kind === "load-steering" && hop < 10; hop++) {
      const next = engine(proj, ".aidlc", ["continue", directive.receipt ?? ""]);
      if (next.kind === "load-steering") expect(next.part).toBe((directive.part ?? 0) + 1);
      expect(hookNotices(next)).toEqual([NOTICE?.notRunInWorkflow ?? ""]);
      directive = next;
    }
    expect(directive.kind).toBe("run-stage");
    // Once any hook has run here, the sentence is gone.
    beforeCommand(proj, "bun .aidlc/tools/aidlc-orchestrate.ts next");
    expect(hookNotices(engine(proj, ".aidlc", ["next"]))).toEqual([]);
  });

  test("when the hooks run, the guard's heartbeat for the command lands first and nothing is said", () => {
    const proj = installed(COPILOT_ROOT);
    startChat(proj);
    beforeCommand(proj, "bun .aidlc/tools/aidlc-utility.ts intent-create");
    // The chat joins the new work from the host's event after the command, as
    // in a real chat, so a loaded machine where the command could not find its
    // chat in time still records the next heartbeat in that work.
    afterCommand(proj, "bun .aidlc/tools/aidlc-utility.ts intent-create", intentCreate(proj, ".aidlc"));
    beforeCommand(proj, "bun .aidlc/tools/aidlc-orchestrate.ts next");
    expect(hookNotices(engine(proj, ".aidlc", ["next"]))).toEqual([]);
  });

  test("a conversation that has not joined the workflow is not told", () => {
    const proj = installed(COPILOT_ROOT);
    intentCreate(proj, ".aidlc");
    // A teammate's clone: the record is there, this machine never selected it.
    rmSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), { force: true });
    expect(hookNotices(engine(proj, ".aidlc", ["next"]))).toEqual([]);
  });

  test("a harness that does not declare the sentence never prints it", () => {
    const proj = installed(CLAUDE_ROOT);
    intentCreate(proj, ".claude");
    expect(hookNotices(engine(proj, ".claude", ["next"]))).toEqual([]);
  });

  test("doctor warns before the first chat, passes after it, and names Copilot's switches after a stage", () => {
    const fresh = installed(COPILOT_ROOT);
    const before = doctor(fresh);
    expect(before).toContain("warn  AIDLC hooks have not run in this project yet");
    expect(before).toContain(NOTICE?.notRunYet ?? "");
    startChat(fresh);
    const after = doctor(fresh);
    expect(after).not.toContain("AIDLC hooks have not run in this project yet");
    expect(after).toMatch(/ok {4}Hooks last fired: session-start /);

    const silent = installed(COPILOT_ROOT);
    intentCreate(silent, ".aidlc");
    const staged = doctor(silent);
    expect(staged).toMatch(/fail {2}Hooks have never executed although this workflow has progressed/);
    expect(staged).toContain(NOTICE?.recovery ?? "");
  });

  test("a core hook that crashes lets the action through and leaves its error line", () => {
    const proj = installed(COPILOT_ROOT);
    startChat(proj);
    intentCreate(proj, ".aidlc");
    writeFileSync(
      join(proj, ".aidlc", "hooks", "aidlc-write-audit-log.ts"),
      'throw new Error("audit write probe failed");\n',
    );
    writeFileSync(
      join(proj, ".aidlc", "hooks", "aidlc-reviewer-scope.ts"),
      'throw new Error("reviewer scope probe failed");\n',
    );
    hostEvent(proj, "post-tool", {
      hook_event_name: "PostToolUse",
      tool_name: "create_file",
      tool_input: { filePath: join(proj, "notes.md"), content: "x" },
    });
    const guard = hostEvent(proj, "guard-tool-call", {
      hook_event_name: "PreToolUse",
      tool_name: "read_file",
      tool_input: { filePath: join(proj, "notes.md") },
    });
    // Fail open, as before: no deny for a crashed guard.
    expect(guard.stdout).not.toContain("permissionDecision");
    const drops = filesNamed(join(proj, "aidlc"), ".drops")
      .map((file) => readFileSync(file, "utf-8"))
      .join("");
    expect(drops).toContain("write-audit-log exited 1 under the Copilot adapter: error: audit write probe failed");
    expect(drops).toContain("reviewer-scope exited 1 under the Copilot adapter: error: reviewer scope probe failed");
  });

  test("a crash is recorded in the workflow of the chat it hit, not the one the shared cursor names", () => {
    const proj = installed(COPILOT_ROOT);
    intentCreate(proj, ".aidlc");
    intentCreate(proj, ".aidlc");
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const cursor = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const other = readdirSync(intents).find((name) => !name.startsWith(".") && name !== "active-intent" && name !== "intents.json" && name !== cursor);
    expect(other).toBeDefined();
    // This chat joined the other workflow, as a second VS Code chat would.
    mkdirSync(join(proj, "aidlc", ".aidlc-sessions"), { recursive: true });
    writeFileSync(
      join(proj, "aidlc", ".aidlc-sessions", `${SESSION}.binding.json`),
      JSON.stringify({ space: "default", intent: other, boundAt: "2026-10-03T00:00:00Z", source: "switch" }),
    );
    writeFileSync(
      join(proj, ".aidlc", "hooks", "aidlc-write-audit-log.ts"),
      'throw new Error("audit write probe failed");\n',
    );
    hostEvent(proj, "post-tool", {
      hook_event_name: "PostToolUse",
      tool_name: "create_file",
      tool_input: { filePath: join(proj, "notes.md"), content: "x" },
    });
    expect(filesNamed(join(intents, other ?? ""), ".drops").length).toBe(1);
    expect(filesNamed(join(intents, cursor), ".drops")).toEqual([]);
  });

  test("a session-end that crashes while a new chat starts is recorded in the earlier chat's workflow", () => {
    const proj = installed(COPILOT_ROOT);
    intentCreate(proj, ".aidlc");
    intentCreate(proj, ".aidlc");
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const cursor = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const other = readdirSync(intents).find((name) => !name.startsWith(".") && name !== "active-intent" && name !== "intents.json" && name !== cursor);
    expect(other).toBeDefined();
    // The earlier chat worked on the other workflow; its session-end is
    // reconciled when this chat starts.
    const earlier = "99999999-8888-4777-8666-555555555555";
    const sessions = join(proj, "aidlc", ".aidlc-sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, `${earlier}.binding.json`),
      JSON.stringify({ space: "default", intent: other, boundAt: "2026-10-03T00:00:00Z", source: "switch" }),
    );
    writeFileSync(
      join(sessions, "copilot-heartbeat.json"),
      JSON.stringify({ session_id: earlier, ts: "2026-10-03T00:00:00Z" }),
    );
    writeFileSync(
      join(proj, ".aidlc", "hooks", "aidlc-session-end.ts"),
      'throw new Error("session end probe failed");\n',
    );
    startChat(proj);
    const drops = filesNamed(join(intents, other ?? ""), ".drops").map((file) => readFileSync(file, "utf-8")).join("");
    expect(drops).toContain("session-end exited 1 under the Copilot adapter: error: session end probe failed");
    expect(filesNamed(join(intents, cursor), ".drops")).toEqual([]);
  });

  test("a crash line that carries a severity tag cannot make doctor fail", () => {
    const proj = installed(COPILOT_ROOT);
    startChat(proj);
    intentCreate(proj, ".aidlc");
    writeFileSync(
      join(proj, ".aidlc", "hooks", "aidlc-write-audit-log.ts"),
      'throw new Error("[degraded] probe text");\n',
    );
    hostEvent(proj, "post-tool", {
      hook_event_name: "PostToolUse",
      tool_name: "create_file",
      tool_input: { filePath: join(proj, "notes.md"), content: "x" },
    });
    const drops = filesNamed(join(proj, "aidlc"), ".drops").map((file) => readFileSync(file, "utf-8")).join("");
    expect(drops).toContain("error: (degraded) probe text");
    expect(drops).not.toContain("[degraded]");
    expect(doctor(proj)).not.toMatch(/fail {2}Hook drops \(write-audit-log\)/);
  });
});
