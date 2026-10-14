// covers: function:hookStandsOutside, function:hookOutsideGate, function:enterHookWorkflow, function:selectedRecordIsFinished, hook:aidlc-record-human-turn, hook:aidlc-plan-approval-guard, hook:aidlc-session-end
//
// A conversation that finished its work stays on that record, and a later
// prompt is not part of it: the hooks that ask whether the conversation has
// joined the work leave the finished record alone. Asking after it (status),
// retiring it (archive), and bringing it back (unarchive) still do what the
// person asked.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createIntent,
  enterHookWorkflow,
  getField,
  hookOutsideGate,
  hookStandsOutside,
  readAllAuditShards,
  setActiveIntentCursor,
  updateIntentStatus,
  writeSessionBinding,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
} from "../harness/fixtures.ts";

const SESSION = "01995100-0000-7000-8000-000000001438";
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const HUMAN_TURN = join(REPO_ROOT, "core", "hooks", "aidlc-record-human-turn.ts");

let proj = "";

afterEach(() => {
  cleanupTestProject(proj);
  proj = "";
});

function seed(status: "Running" | "Completed" | "Archived"): { record: string; statePath: string } {
  proj = createTestProject();
  const created = createIntent(proj, "widget checkout", "default", "feature");
  const record = created.dirName;
  const statePath = join(proj, "aidlc", "spaces", "default", "intents", record, "aidlc-state.md");
  const body = readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8")
    .replace("- **Status**: Running", `- **Status**: ${status}`);
  writeFileSync(statePath, body, "utf-8");
  writeSessionBinding(proj, SESSION, "default", record, "switch");
  setActiveIntentCursor(proj, record, "default");
  if (status === "Completed") updateIntentStatus(proj, record, "complete");
  if (status === "Archived") updateIntentStatus(proj, record, "archived");
  return { record, statePath };
}

function joined(): ReturnType<typeof enterHookWorkflow> {
  return enterHookWorkflow(proj, SESSION);
}

function laterPrompt(): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: proj, CLAUDE_PROJECT_DIR: proj };
  delete env.AIDLC_SESSION_OVERRIDE;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  delete env.AIDLC_UNATTENDED;
  env.AIDLC_INTERNAL_HUMAN_TURN_TOKEN = "finished-work-not-joined";
  const result = spawnSync(process.execPath, [HUMAN_TURN, "--internal-aidlc-record-human-turn"], {
    encoding: "utf-8",
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      prompt: "look at the next bug",
    }),
    env,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function passiveHook(
  name: string,
  payload: Record<string, unknown>,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    AIDLC_PROJECT_DIR: proj,
    CLAUDE_PROJECT_DIR: proj,
  };
  delete env.AIDLC_SESSION_OVERRIDE;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "core", "hooks", `aidlc-${name}.ts`)], {
    encoding: "utf-8",
    input: JSON.stringify({ ...payload, session_id: SESSION }),
    env,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const passiveEvents = [
  {
    name: "plan-approval-guard",
    event: "GUARD_DISABLED",
    payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pwd" } },
    env: { AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" },
  },
  {
    name: "session-end",
    event: "SESSION_ENDED",
    payload: { hook_event_name: "SessionEnd", reason: "logout" },
    env: {},
  },
] as const;

function util(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [UTIL, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_PROJECT_DIR: proj,
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SESSION_OVERRIDE: SESSION,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("finished work is not joined for a later prompt", () => {
  test("a cold workspace is not outside", () => {
    proj = createTestProject();
    const workflow = joined();
    try {
      expect(workflow.selection?.intent ?? null).toBeNull();
      expect(hookStandsOutside(workflow)).toBe(false);
    } finally {
      workflow.restore();
    }
  });

  test("a prompt on work in progress still records the turn", () => {
    const { record, statePath } = seed("Running");
    const workflow = joined();
    try {
      expect(workflow.participation).toBe("participant");
      expect(hookStandsOutside(workflow)).toBe(false);
      expect(hookOutsideGate(workflow)).toBe(false);
    } finally {
      workflow.restore();
    }
    const before = readAllAuditShards(proj, record, "default");
    const turn = laterPrompt();
    expect(turn.status, turn.stderr).toBe(0);
    expect(readAllAuditShards(proj, record, "default")).not.toBe(before);
    expect(readAllAuditShards(proj, record, "default")).toContain("**Event**: HUMAN_TURN");
    expect(getField(readFileSync(statePath, "utf-8"), "Status")).toBe("Running");
  });

  test.each(["Completed", "Archived"] as const)(
    "a later prompt does not append to %s work",
    (status) => {
      const { record, statePath } = seed(status);
      const workflow = joined();
      try {
        expect(workflow.participation).toBe("participant");
        expect(hookStandsOutside(workflow)).toBe(true);
        expect(hookOutsideGate(workflow)).toBe(false);
      } finally {
        workflow.restore();
      }
      const auditBefore = readAllAuditShards(proj, record, "default");
      const stateBefore = readFileSync(statePath, "utf-8");
      const turn = laterPrompt();
      expect(turn.status, turn.stderr).toBe(0);
      expect(readAllAuditShards(proj, record, "default")).toBe(auditBefore);
      expect(readAllAuditShards(proj, record, "default")).not.toContain("HUMAN_TURN");
      expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
    },
  );

  for (const hook of passiveEvents) {
    test.each(["Running", "Completed", "Archived"] as const)(
      `${hook.event} is recorded only while the selected work is running (%s)`,
      (status) => {
        const { record, statePath } = seed(status);
        const before = readAllAuditShards(proj, record, "default");
        const stateBefore = readFileSync(statePath, "utf-8");
        const result = passiveHook(hook.name, hook.payload, hook.env);
        expect(result.status, result.stderr).toBe(0);
        const after = readAllAuditShards(proj, record, "default");
        if (status === "Running") {
          expect(after).not.toBe(before);
          expect(after).toContain(`**Event**: ${hook.event}`);
        } else {
          expect(after).toBe(before);
        }
        expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
      },
    );

    test.each(["Running", "Completed"] as const)(
      `${hook.event} follows the session's %s work when the shared cursor names another record`,
      (status) => {
        const { record, statePath } = seed(status);
        const other = createIntent(proj, "another piece of work", "default", "feature");
        const otherState = join(proj, "aidlc", "spaces", "default", "intents", other.dirName, "aidlc-state.md");
        writeFileSync(
          otherState,
          readFileSync(statePath, "utf-8").replace(
            `- **Status**: ${status}`,
            `- **Status**: ${status === "Running" ? "Completed" : "Running"}`,
          ),
        );
        setActiveIntentCursor(proj, other.dirName, "default");
        const before = readAllAuditShards(proj, record, "default");
        const otherBefore = readAllAuditShards(proj, other.dirName, "default");
        const result = passiveHook(hook.name, hook.payload, hook.env);
        expect(result.status, result.stderr).toBe(0);
        const after = readAllAuditShards(proj, record, "default");
        if (status === "Running") {
          expect(after).not.toBe(before);
          expect(after).toContain(`**Event**: ${hook.event}`);
        } else {
          expect(after).toBe(before);
        }
        expect(readAllAuditShards(proj, other.dirName, "default")).toBe(otherBefore);
      },
    );
  }

  test("status, archive, and unarchive still reach a completed record", () => {
    const { record, statePath } = seed("Completed");
    const status = util(["status"]);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toMatch(/Status:\s+Completed/);

    const archived = util(["intent", "archive", record, "--reason", "shipped"]);
    expect(archived.status, archived.stderr).toBe(0);
    expect(getField(readFileSync(statePath, "utf-8"), "Status")).toBe("Archived");
    const archivedAudit = readAllAuditShards(proj, record, "default");
    expect(archivedAudit).toContain("WORKFLOW_ARCHIVED");
    const turn = laterPrompt();
    expect(turn.status, turn.stderr).toBe(0);
    expect(readAllAuditShards(proj, record, "default")).toBe(archivedAudit);

    const back = util(["intent", "unarchive", record]);
    expect(back.status, back.stderr).toBe(0);
    expect(getField(readFileSync(statePath, "utf-8"), "Status")).toBe("Completed");
    expect(readAllAuditShards(proj, record, "default")).toContain("WORKFLOW_UNARCHIVED");

    const again = util(["status", "--intent", record]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/Status:\s+Completed/);
  });
});
