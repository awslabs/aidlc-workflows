// covers: subcommand:aidlc-state:complete-workflow, subcommand:aidlc-state:finalize, subcommand:aidlc-runtime:compile
//
// The real completion command owns its final projection, without a following
// hook. Projection failure must leave completion settled and explicitly
// repairable without replaying approval. All records and injected failures are
// confined to fresh temporary projects.
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  findAllEvents,
  readAllAuditShards,
  resolveWorkflowSelection,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { compileRuntime } from "../../dist/claude/.claude/tools/aidlc-runtime.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_STARTUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

function run(project: string, tool: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return spawnSync(process.execPath, [
    join(AIDLC_SRC, "tools", `aidlc-${tool}.ts`),
    ...args, "--project-dir", project,
  ], {
    cwd: project,
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
}

function seeded(stage = "feasibility", phase = "ideation"): string {
  const project = createTestProject();
  projects.push(project);
  seedStateFile(project, "state-mid-ideation.md");
  const statePath = seededStateFile(project);
  if (stage !== "feasibility") {
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace("- [-] feasibility", "- [x] feasibility")
      .replace(`- [ ] ${stage}`, `- [-] ${stage}`)
      .replace("- **Current Stage**: feasibility", `- **Current Stage**: ${stage}`)
      .replace("- **In Progress**: feasibility", `- **In Progress**: ${stage}`)
      .replace("- **Lifecycle Phase**: IDEATION", `- **Lifecycle Phase**: ${phase.toUpperCase()}`));
  }
  const audit = seededAuditShard(project);
  mkdirSync(dirname(audit), { recursive: true });
  writeFileSync(audit, `# Audit

## Start
**Timestamp**: 2025-06-15T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage
**Timestamp**: 2025-06-15T11:00:00Z
**Event**: STAGE_STARTED
**Stage**: ${stage}
**Agent**: aidlc-architect-agent

---
`);
  const memory = join(seededRecordDir(project), phase, stage, "memory.md");
  mkdirSync(dirname(memory), { recursive: true });
  writeFileSync(memory, "# Memory\n");
  return project;
}

function graphPath(project: string): string {
  return join(seededRecordDir(project), "runtime-graph.json");
}

function graph(project: string): { stages: { stage_slug: string; outcome: string; memory_entries: number | null }[] } {
  return JSON.parse(readFileSync(graphPath(project), "utf-8"));
}

function count(project: string, event: string): number {
  return findAllEvents(readAllAuditShards(project), event).length;
}

describe("explicit terminal completion owns the final runtime graph", () => {
  test("completion projects the final approval and deduplicates empty memory on repair", () => {
    const project = seeded();
    const completed = run(project, "state", ["complete-workflow", "feasibility"]);
    expect(completed.status, `${completed.stdout}${completed.stderr}`).toBe(0);
    expect(readFileSync(seededStateFile(project), "utf-8")).toContain("- **Status**: Completed");
    expect(graph(project).stages).toContainEqual(expect.objectContaining({
      stage_slug: "feasibility", outcome: "approved", memory_entries: 0,
    }));
    expect(count(project, "MEMORY_EMPTY")).toBe(1);
    const before = readFileSync(graphPath(project), "utf-8");
    const repaired = run(project, "runtime", ["compile"]);
    expect(repaired.status, `${repaired.stdout}${repaired.stderr}`).toBe(0);
    expect(readFileSync(graphPath(project), "utf-8")).toBe(before);
    expect(count(project, "MEMORY_EMPTY")).toBe(1);
    expect(count(project, "STAGE_COMPLETED")).toBe(1);
    expect(count(project, "WORKFLOW_COMPLETED")).toBe(1);
  });

  test("graph write failure warns, settles completion once, and repairs without replay", () => {
    const project = seeded();
    // A directory at the graph destination deterministically rejects atomic
    // replacement, including when the test runs with elevated file privileges.
    mkdirSync(graphPath(project));
    const completed = run(project, "state", ["complete-workflow", "feasibility"]);
    expect(completed.status, `${completed.stdout}${completed.stderr}`).toBe(0);
    expect(completed.stderr).toContain("Runtime graph refresh failed");
    expect(completed.stderr).toContain("completion continues");
    expect(completed.stderr).toContain("compile");
    expect(readFileSync(seededStateFile(project), "utf-8")).toContain("- **Status**: Completed");
    expect(count(project, "WORKFLOW_COMPLETED")).toBe(1);
    expect(count(project, "STAGE_COMPLETED")).toBe(1);
    const auditBeforeRepair = readAllAuditShards(project);
    rmSync(graphPath(project), { recursive: true });
    const repaired = run(project, "runtime", ["compile"]);
    expect(repaired.status, `${repaired.stdout}${repaired.stderr}`).toBe(0);
    expect(graph(project).stages[0].outcome).toBe("approved");
    expect(readAllAuditShards(project)).toBe(auditBeforeRepair);
  });

  test("authoritative audit failure still fails completion before projection or state seal", () => {
    const project = seeded();
    const before = readFileSync(seededStateFile(project), "utf-8");
    rmSync(seededAuditShard(project));
    mkdirSync(seededAuditShard(project));
    const completed = run(project, "state", ["complete-workflow", "feasibility"]);
    expect(completed.status).not.toBe(0);
    expect(readFileSync(seededStateFile(project), "utf-8")).toBe(before);
    expect(existsSync(graphPath(project))).toBe(false);
    expect(completed.stderr).not.toContain("completion continues");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "authoritative state failure is not hidden by a successful projection",
    () => {
      const project = seeded();
      const statePath = seededStateFile(project);
      const before = readFileSync(statePath, "utf-8");
      chmodSync(statePath, 0o444);
      try {
        const completed = run(project, "state", ["complete-workflow", "feasibility"]);
        expect(completed.status).not.toBe(0);
        expect(readFileSync(statePath, "utf-8")).toBe(before);
        expect(graph(project).stages[0].outcome).toBe("approved");
        expect(completed.stderr).not.toContain("completion continues");
      } finally {
        chmodSync(statePath, 0o644);
      }
    },
  );

  test("finalize refreshes terminal work without fabricating an approval audit", () => {
    const project = seeded("feedback-optimization", "operation");
    const completed = run(project, "state", ["finalize", "feedback-optimization"]);
    expect(completed.status, `${completed.stdout}${completed.stderr}`).toBe(0);
    expect(readFileSync(seededStateFile(project), "utf-8")).toContain("- **Status**: Completed");
    expect(graph(project).stages[0]).toMatchObject({
      stage_slug: "feedback-optimization", outcome: "pending",
    });
    expect(count(project, "STAGE_COMPLETED")).toBe(0);
    expect(count(project, "WORKFLOW_COMPLETED")).toBe(0);
    expect(count(project, "MEMORY_EMPTY")).toBe(0);
  });

  test("a captured compiler target survives a later cursor switch", () => {
    const project = seeded();
    const selection = resolveWorkflowSelection(project);
    const other = join(dirname(seededRecordDir(project)), "other-12345678");
    cpSync(seededRecordDir(project), other, { recursive: true });
    writeFileSync(join(dirname(other), "active-intent"), "other-12345678\n");
    expect(resolveWorkflowSelection(project).intent).toBe("other-12345678");
    const result = compileRuntime(project, selection);
    expect(result.written).toBe(graphPath(project));
    expect(existsSync(graphPath(project))).toBe(true);
    expect(existsSync(join(other, "runtime-graph.json"))).toBe(false);
  });

  test("hook compilation refreshes Running work and stays quiet for terminal work", () => {
    const project = seeded();
    const selection = resolveWorkflowSelection(project);
    const args = ["compile", "--hook-space", selection.space, "--hook-intent", selection.intent ?? ""];
    const running = run(project, "runtime", args);
    expect(running.status, `${running.stdout}${running.stderr}`).toBe(0);
    expect(graph(project).stages[0].outcome).toBe("pending");
    for (const status of ["Completed", "Archived"]) {
      writeFileSync(seededStateFile(project), readFileSync(seededStateFile(project), "utf-8")
        .replace(/- \*\*Status\*\*: .+/, `- **Status**: ${status}`));
      // A stale graph proves a skipped invocation does not even rewrite bytes.
      writeFileSync(graphPath(project), "stale graph\n");
      const auditBefore = readAllAuditShards(project);
      const terminal = run(project, "runtime", args);
      expect(terminal.status, `${terminal.stdout}${terminal.stderr}`).toBe(0);
      expect(terminal.stdout).toBe("");
      expect(terminal.stderr).toBe("");
      expect(readFileSync(graphPath(project), "utf-8")).toBe("stale graph\n");
      expect(readAllAuditShards(project)).toBe(auditBefore);
    }
  });
});
