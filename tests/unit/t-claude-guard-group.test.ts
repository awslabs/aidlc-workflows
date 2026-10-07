// t-claude-guard-group: on Claude Code the checks before a tool call run in ONE
// process, not four.
//
// covers: file:harness/claude/settings.json, file:tools/aidlc.ts, function:hookGroupMembers, hook:aidlc-state-transition-guard, hook:aidlc-reviewer-scope, hook:aidlc-review-freeze, hook:aidlc-plan-approval-guard
//
// WHAT. Claude Code starts the hooks of every matching PreToolUse group at
// once, each one its own engine load, so one Bash call started four guard
// processes plus fold-usage (the Claude half of #2066). One row now calls
// `engine hook guard-tool-call`, and the dispatcher runs the members in its own
// process, each member keeping the matcher its own row had, so a tool reaches
// exactly the checks it reached before.
//
// WHY SUBPROCESS. The group is a dispatcher route: the stdin, stdout, exit code
// and process identity ARE the contract, so every behavioural case drives the
// shipped `bun .claude/tools/aidlc.ts engine hook guard-tool-call` in a scratch
// project, as Claude Code runs it.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookGroupMembers, PRE_TOOL_USE_GROUP_TARGET } from "../../core/tools/aidlc-command.ts";
import { hooksTracedToCompletion } from "../../scripts/ci-update-from-previous.ts";
import { stateDigest, writeActiveDirectiveMarker } from "../../core/tools/aidlc-lib.ts";
import { AIDLC_SRC, createTestProject, REPO_ROOT, seedAidlcMemory, seededStateFile } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const GROUP_COMMAND =
  `bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook ${PRE_TOOL_USE_GROUP_TARGET}`;

interface Settings {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;
}

function shippedSettings(channel: "dist" | "dist-release" = "dist"): Settings {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, channel, "claude", ".claude", "settings.json"), "utf-8"),
  ) as Settings;
}

/** A scratch project holding the shipped .claude tree and an open workflow. */
function scratchProject(): string {
  const project = createTestProject();
  cpSync(AIDLC_SRC, join(project, ".claude"), { recursive: true });
  seedAidlcMemory(project);
  const state = `# AI-DLC State Tracking

## Project Information
- **Project**: guard group
- **Scope**: poc

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
`;
  writeFileSync(seededStateFile(project), state);
  writeActiveDirectiveMarker(project, {
    kind: "run-stage",
    stage: "code-generation",
    state_sha256: stateDigest(state),
  });
  return project;
}

/** Run the shipped group command, as Claude Code's settings.json runs it. */
function runGroup(
  project: string,
  payload: Record<string, unknown>,
  traceDir?: string,
): { stdout: string; stderr: string; code: number; pid: number } {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project };
  if (traceDir) env.AIDLC_HOOK_TRACE_DIR = traceDir;
  delete env.AIDLC_PROJECT_DIR;
  delete env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD;
  delete env.AIDLC_UNATTENDED;
  const r = spawnSync(
    "bun",
    [join(project, ".claude", "tools", "aidlc.ts"), "engine", "hook", PRE_TOOL_USE_GROUP_TARGET],
    {
      cwd: project,
      env,
      input: JSON.stringify({ cwd: project, ...payload }),
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1, pid: r.pid ?? -1 };
}

/** A member hook replaced by a recorder, so the process it runs in is visible. */
function standIn(
  project: string,
  hook: string,
  capture: string,
  answer: { code: number; stderr?: string; throws?: boolean },
): void {
  const body = [
    'import { appendFileSync } from "node:fs";',
    "export async function run(_input: string): Promise<number> {",
    `  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid, hook: ${JSON.stringify(hook)} }) + "\\n");`,
    answer.throws ? '  throw new Error("STANDIN-THREW");' : "",
    answer.stderr ? `  process.stderr.write(${JSON.stringify(answer.stderr)});` : "",
    `  return ${answer.code};`,
    "}",
    "if (import.meta.main) process.exit(await run(await Bun.stdin.text()));",
  ].join("\n");
  writeFileSync(join(project, ".claude", "hooks", `aidlc-${hook}.ts`), body, "utf-8");
}

function recorded(capture: string): Array<{ pid: number; hook: string }> {
  if (!existsSync(capture)) return [];
  return readFileSync(capture, "utf-8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; hook: string });
}

const MEMBERS = hookGroupMembers(PRE_TOOL_USE_GROUP_TARGET) ?? [];

describe("t-claude-guard-group settings.json wiring", () => {
  test("one PreToolUse row carries the checks, and no row names a member on its own", () => {
    for (const channel of ["dist", "dist-release"] as const) {
      const pre = shippedSettings(channel).hooks.PreToolUse ?? [];
      const rows = pre.filter((group) =>
        group.hooks.some((hook) => hook.command.endsWith(` engine hook ${PRE_TOOL_USE_GROUP_TARGET}`))
      );
      expect(rows, channel).toHaveLength(1);
      expect(rows[0]?.hooks, channel).toHaveLength(1);
      for (const member of MEMBERS) {
        expect(
          pre.some((group) =>
            group.hooks.some((hook) => hook.command.endsWith(` engine hook ${member.hook}`))
          ),
          `${channel} ${member.hook}`,
        ).toBe(false);
      }
    }
  });

  test("the row matches exactly the tools its members match, and nothing else", () => {
    const pre = shippedSettings().hooks.PreToolUse ?? [];
    const row = pre.find((group) => group.hooks.some((hook) => hook.command === GROUP_COMMAND));
    expect(row).toBeDefined();
    const rowMatcher = new RegExp(`^(?:${row?.matcher})$`);
    const everyTool = [
      "Read", "NotebookRead", "Edit", "MultiEdit", "Write", "NotebookEdit", "LS", "Glob", "Grep",
      "Bash", "Task", "Agent", "WebFetch", "TodoWrite",
    ];
    for (const tool of everyTool) {
      const anyMember = MEMBERS.some((member) => new RegExp(member.matcher).test(tool));
      expect(rowMatcher.test(tool), tool).toBe(anyMember);
    }
  });

  test("the usage fold and the subagent rule delivery keep their own rows", () => {
    const pre = shippedSettings().hooks.PreToolUse ?? [];
    const foldRow = pre.find((group) =>
      group.hooks.some((hook) => hook.command.endsWith(" engine hook fold-usage"))
    );
    expect(foldRow?.matcher).toBe("");
    const rulesRow = pre.find((group) =>
      group.hooks.some((hook) => hook.command.endsWith(" engine hook deliver-stage-rules"))
    );
    expect(rulesRow?.matcher).toBe("Task|Agent");
  });
});

describe("t-claude-guard-group one process", () => {
  test("a shell call runs every member in the group's own process, in order", () => {
    const project = scratchProject();
    try {
      const capture = join(project, "members.ndjson");
      for (const member of MEMBERS) standIn(project, member.hook, capture, { code: 0 });
      const r = runGroup(project, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
      expect(r.code, r.stderr).toBe(0);
      const runs = recorded(capture);
      expect(runs.map((run) => run.hook)).toEqual(MEMBERS.map((member) => member.hook));
      expect(r.pid).toBeGreaterThan(0);
      expect(runs.map((run) => run.pid)).toEqual(MEMBERS.map(() => r.pid));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a read reaches the same checks it reached before, and not the plan-approval guard", () => {
    const project = scratchProject();
    try {
      const capture = join(project, "members.ndjson");
      for (const member of MEMBERS) standIn(project, member.hook, capture, { code: 0 });
      const r = runGroup(project, {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: join(project, "README.md") },
      });
      expect(r.code, r.stderr).toBe(0);
      const ran = recorded(capture).map((run) => run.hook);
      expect(ran).toEqual(
        MEMBERS.filter((member) => new RegExp(member.matcher).test("Read")).map((member) => member.hook),
      );
      expect(ran).not.toContain("plan-approval-guard");
      expect(ran.length).toBeGreaterThan(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a dispatch reaches only the checks its own row matched", () => {
    const project = scratchProject();
    try {
      const capture = join(project, "members.ndjson");
      for (const member of MEMBERS) standIn(project, member.hook, capture, { code: 0 });
      const r = runGroup(project, {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "aidlc-quality-agent", prompt: "review" },
      });
      expect(r.code, r.stderr).toBe(0);
      expect(recorded(capture).map((run) => run.hook)).toEqual(
        MEMBERS.filter((member) => new RegExp(member.matcher).test("Task")).map((member) => member.hook),
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a check that throws fails alone; the others run and a refusal still reaches the agent", () => {
    const project = scratchProject();
    try {
      const capture = join(project, "members.ndjson");
      for (const member of MEMBERS) {
        if (member.hook === "reviewer-scope") standIn(project, member.hook, capture, { code: 0, throws: true });
        else if (member.hook === "review-freeze") {
          standIn(project, member.hook, capture, { code: 2, stderr: "STANDIN-FREEZE: that file is frozen.\n" });
        } else standIn(project, member.hook, capture, { code: 0 });
      }
      const r = runGroup(project, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("STANDIN-FREEZE");
      expect(r.stderr).not.toContain("STANDIN-THREW");
      expect(recorded(capture).map((run) => run.hook)).toEqual(MEMBERS.map((member) => member.hook));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a member's refusal is relayed as Claude's own deny decision, with its words", () => {
    const project = scratchProject();
    try {
      const capture = join(project, "members.ndjson");
      for (const member of MEMBERS) {
        standIn(
          project,
          member.hook,
          capture,
          member.hook === "state-transition-guard"
            ? { code: 2, stderr: "STANDIN-STATE: use report instead.\n" }
            : { code: 0 },
        );
      }
      const r = runGroup(project, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
      expect(r.code).toBe(2);
      const decision = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(decision.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
      expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain("STANDIN-STATE");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("t-claude-guard-group the real checks still refuse", () => {
  test("a direct state transition is refused through the group, with the guard's own words", () => {
    const project = scratchProject();
    try {
      const r = runGroup(project, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "bun .claude/tools/aidlc-state.ts reject feasibility" },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Stage status cannot be changed with aidlc-state.ts reject");
      expect(r.stderr).toContain("aidlc-orchestrate.ts report");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("an ordinary shell command passes with nothing said", () => {
    const project = scratchProject();
    try {
      const r = runGroup(project, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("t-claude-guard-group the release check reads the group as a hook that ran", () => {
  // The Preview and stable Release workflows run scripts/ci-update-from-previous.ts,
  // which runs every hook command the refreshed project wires and requires its
  // phase trace to show the hook loaded and ended with code 0
  // (hooksTracedToCompletion). A registration that runs its members in this
  // process has to leave that same shape, or a release would fail its update
  // check on every OS while the person sees nothing wrong. The check's own
  // predicate is imported here so it cannot drift from what the group traces.
  test("the check's own predicate sees the group load and finish, as it does a single hook", () => {
    const project = scratchProject();
    try {
      const trace = join(project, "trace-allow");
      // The check pipes `{}`: no tool name, so every member runs and judges it.
      const r = runGroup(project, {}, trace);
      expect(r.code, r.stderr).toBe(0);
      expect([...hooksTracedToCompletion(trace)]).toEqual([PRE_TOOL_USE_GROUP_TARGET]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a refused call does not read as a clean run, as a single hook's refusal does not", () => {
    const project = scratchProject();
    try {
      const capture = join(project, "members.ndjson");
      for (const member of MEMBERS) {
        standIn(
          project,
          member.hook,
          capture,
          member.hook === "review-freeze"
            ? { code: 2, stderr: "STANDIN-FREEZE: that file is frozen.\n" }
            : { code: 0 },
        );
      }
      const trace = join(project, "trace-refuse");
      const r = runGroup(project, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, trace);
      expect(r.code).toBe(2);
      expect([...hooksTracedToCompletion(trace)]).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
