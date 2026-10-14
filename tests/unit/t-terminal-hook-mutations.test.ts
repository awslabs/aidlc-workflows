// covers: function:workflowLifecycle, function:withHookWorkflowMutation, function:runInHookWorkflow
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry, appendCoordinationStoodAside } from "../../core/tools/aidlc-audit.ts";
import {
  auditFilePath, hooksHealthDir, removeHookStatusFile, resolveWorkflowSelection,
  runInHookWorkflow, stateFilePath, workflowLifecycle, withHookWorkflowMutation,
  withAuditLock, writeHookStatusFile, type HookWorkflow, type WorkflowSelection,
} from "../../core/tools/aidlc-lib.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(status: string | null = "Running", intent: string | null = "a"): {
  project: string; record: string; workflow: HookWorkflow; state: string;
} {
  const project = mkdtempSync(join(tmpdir(), "aidlc-terminal-mutation-"));
  roots.push(project);
  const base = join(project, "aidlc", "spaces", "default", "intents");
  const record = intent === null ? base : join(base, intent);
  mkdirSync(record, { recursive: true });
  if (intent !== null) writeFileSync(join(base, "active-intent"), intent);
  const state = join(record, "aidlc-state.md");
  if (status !== null) writeFileSync(state, `- **Status**: ${status}\n`);
  const selection: WorkflowSelection = { space: "default", intent, sessionId: null, binding: null };
  const workflow: HookWorkflow = {
    selection, participation: "participant",
    lifecycle: workflowLifecycle(project, selection), restore: () => {},
  };
  return { project, record, workflow, state };
}

describe("ambient writes share the terminal transition barrier", () => {
  test.each(["Completed", "Archived", "not-a-state"])("%s admits no mutation", (status) => {
    const f = fixture(status);
    let writes = 0;
    expect(withHookWorkflowMutation(f.project, f.workflow, () => ++writes)).toBeUndefined();
    expect(writes).toBe(0);
    expect(writeHookStatusFile(join(f.record, ".aidlc-engine", "hooks-health"), "hook.last", "later")).toBe(false);
  });

  test.each(["Completed", "Archived"])("rechecks %s after the event captured Running", (status) => {
    const f = fixture();
    writeFileSync(f.state, `- **Status**: ${status}\n`);
    let writes = 0;
    expect(withHookWorkflowMutation(f.project, f.workflow, () => ++writes)).toBeUndefined();
    expect(writes).toBe(0);
  });

  test.each([null, "a"])("running and absent records retain writes, including flat selection %s", (intent) => {
    const f = fixture(null, intent);
    expect(f.workflow.lifecycle).toBe("absent");
    expect(withHookWorkflowMutation(f.project, f.workflow, () => 42)).toBe(42);
    writeFileSync(f.state, "- **Status**: Running\n");
    expect(workflowLifecycle(f.project, f.workflow.selection!)).toBe("running");
    expect(withHookWorkflowMutation(f.project, f.workflow, () => 43)).toBe(43);
  });

  test("a record with no Status line is in-progress work", () => {
    const f = fixture();
    writeFileSync(f.state, "- **Current Stage**: requirements-analysis\n");
    const workflow = { ...f.workflow, lifecycle: workflowLifecycle(f.project, f.workflow.selection!) };
    expect(workflow.lifecycle).toBe("running");
    expect(withHookWorkflowMutation(f.project, workflow, () => 7)).toBe(7);
  });

  test("the current state wins over a complete registry entry after reopening", () => {
    const f = fixture();
    writeFileSync(join(f.record, "..", "intents.json"), JSON.stringify([{ slug: "a", status: "complete" }]));
    expect(workflowLifecycle(f.project, f.workflow.selection!)).toBe("running");
    expect(withHookWorkflowMutation(f.project, f.workflow, () => true)).toBe(true);
  });

  test("pins the original record when the shared cursor changes before and during a write", () => {
    const f = fixture();
    mkdirSync(join(f.record, "..", "b"));
    writeFileSync(join(f.record, "..", "b", "aidlc-state.md"), "- **Status**: Running\n");
    writeFileSync(join(f.record, "..", "active-intent"), "b");
    withHookWorkflowMutation(f.project, f.workflow, () => {
      expect(stateFilePath(f.project)).toBe(f.state);
      writeFileSync(join(f.record, "..", "active-intent"), "c");
      expect(stateFilePath(f.project)).toBe(f.state);
      // The public emitter must reuse the already-held workspace bucket.
      appendAuditEntry("STAGE_COMPLETED", { Stage: "workspace-scaffold" }, f.project);
      expect(readFileSync(auditFilePath(f.project), "utf8")).toContain("STAGE_COMPLETED");
    });
    expect(resolveWorkflowSelection(f.project).intent).not.toBe("a");
  });

  test("Copilot coordination audit reuses the admitted mutation's workspace lock", () => {
    const f = fixture();
    appendAuditEntry("STAGE_STARTED", { Stage: "workspace-scaffold" }, f.project);
    const recorded = withHookWorkflowMutation(f.project, f.workflow, () => appendCoordinationStoodAside(f.project, {
      session: "chat", command: "next", reason: "no coordination record",
    }));
    expect(recorded).toBe(true);
    expect(readFileSync(auditFilePath(f.project), "utf8").match(/\*\*Event\*\*: COORDINATION_STOOD_ASIDE/g)).toHaveLength(1);
  });

  test("async hook scope preserves its target and does not leak to later explicit commands", async () => {
    const f = fixture();
    mkdirSync(join(f.record, "..", "b"));
    writeFileSync(join(f.record, "..", "b", "aidlc-state.md"), "- **Status**: Running\n");
    await runInHookWorkflow(f.project, f.workflow, async () => {
      writeFileSync(join(f.record, "..", "active-intent"), "b");
      await Promise.resolve();
      expect(stateFilePath(f.project)).toBe(f.state);
    });
    expect(resolveWorkflowSelection(f.project).intent).toBe("b");
  });

  test("health sinks preserve existing terminal files, including removals and debug/drop writes", () => {
    const f = fixture();
    const health = hooksHealthDir(f.project);
    expect(writeHookStatusFile(health, "hook.last", "before")).toBe(true);
    writeFileSync(f.state, "- **Status**: Completed\n");
    expect(writeHookStatusFile(health, "hook.last", "after")).toBe(false);
    expect(removeHookStatusFile(health, "hook.last")).toBe(false);
    expect(readFileSync(join(health, "hook.last"), "utf8")).toBe("before");
  });

  test("best-effort health diagnostics never acquire workspace after an intent-only lock", () => {
    const f = fixture();
    withAuditLock(f.project, () => {
      expect(writeHookStatusFile(join(f.record, ".aidlc-engine", "hooks-health"), "guard.drops", "failed")).toBe(false);
    }, "a", "default");
  });

  test.each(["Completed", "Archived"])("a legacy log child cannot write %s after dispatch", (status) => {
    const f = fixture(status);
    const tool = join(import.meta.dir, "..", "..", "core", "tools", "aidlc-log.ts");
    const result = spawnSync(process.execPath, [
      tool, "decision", "--stage", "code-generation", "--checkpoint", "plan-approval",
      "--project-dir", f.project, "--hook-space", "default", "--hook-intent", "a",
    ], { cwd: f.project, encoding: "utf8", env: process.env, timeout: 10_000 });
    expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      code: 0, stdout: "", stderr: "",
    });
    expect(readdirSync(f.record)).toEqual(["aidlc-state.md"]);
  });
});
