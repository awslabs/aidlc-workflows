// covers: function:withWorkflowRecordLock, subcommand:aidlc-state:complete-workflow,
// subcommand:aidlc-state:merge, subcommand:aidlc-state:approve
//
// Real CLI writers contend in separate processes. A test-only fs interception
// pauses the first writer at its final state rename and observes the second
// writer attempting the intent mutex. No production synchronization seam or
// sleep-based guess determines which transaction wins.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  auditLockDir, findAllEvents, getField, readAllAuditShards,
  resolveBoltIdentity, resolveWorkflowSelection, writeSessionBinding,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC, REPO_ROOT, cleanupTestProject, createTestProject,
  removeWorkspaceRecord, seedStateFile, seededAuditShard, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const projects: string[] = [];
const SESSION = "14380000-0000-4000-8000-000000000008";
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

type Writer = {
  child: ChildProcess;
  ready: string;
  release: string;
  attempted: string;
  renamed: string;
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
  finished: () => boolean;
};

function fixture(stage = "feasibility", checkbox = "-"): {
  project: string; state: string; record: string; worktree: string;
  intent: string; intentLock: string; workspaceLock: string;
} {
  const project = createTestProject();
  projects.push(project);
  seedStateFile(project, "state-mid-ideation.md");
  const state = seededStateFile(project);
  let content = readFileSync(state, "utf8")
    .replace(/^- \*\*Bolt Refs\*\*:.*$/m, "- **Bolt Refs**: test-bolt");
  if (stage !== "feasibility") {
    content = content
      .replace("- [-] feasibility", "- [x] feasibility")
      .replace(`- [ ] ${stage}`, `- [${checkbox}] ${stage}`)
      .replace("- **Current Stage**: feasibility", `- **Current Stage**: ${stage}`)
      .replace("- **Lifecycle Phase**: IDEATION", "- **Lifecycle Phase**: OPERATION");
  }
  writeFileSync(state, content);
  const audit = seededAuditShard(project);
  mkdirSync(dirname(audit), { recursive: true });
  writeFileSync(audit, `# Audit\n\n## Start\n**Timestamp**: 2025-06-15T10:00:00Z
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
  const record = seededRecordDir(project);
  const memory = join(record, stage === "feasibility" ? "ideation" : "operation", stage, "memory.md");
  mkdirSync(dirname(memory), { recursive: true });
  writeFileSync(memory, "# Memory\n");
  const selection = resolveWorkflowSelection(project);
  const worktree = resolveBoltIdentity(project, "test-bolt", selection).dir;
  const mirror = join(worktree, relative(project, state));
  mkdirSync(dirname(mirror), { recursive: true });
  // The worker has settled this stage. Its merge must preserve the lifecycle
  // snapshot it reads under I, including a completion that acquired I first.
  writeFileSync(mirror, content.replace(`- [${checkbox}] ${stage}`, `- [x] ${stage}`));
  writeSessionBinding(project, SESSION, selection.space, selection.intent, "create");
  return {
    project, state, record, worktree, intent: selection.intent!,
    intentLock: auditLockDir(project, selection.intent!, selection.space),
    workspaceLock: auditLockDir(project),
  };
}

function writer(
  f: ReturnType<typeof fixture>, name: string, args: string[], pause: boolean,
  options: {
    tool?: string; observedLock?: string; commandProject?: string;
    watchNewState?: boolean; pauseAtWrite?: number;
  } = {},
): Writer {
  const commandProject = options.commandProject ?? f.project;
  const ready = join(f.project, `${name}.ready`);
  const release = join(f.project, `${name}.release`);
  const attempted = join(f.project, `${name}.attempted`);
  const renamed = join(f.project, `${name}.renamed`);
  const runner = join(f.project, `${name}.ts`);
  writeFileSync(runner, `
import { mock } from "bun:test";
import * as fs from "node:fs";
const rename = fs.renameSync;
const exists = fs.existsSync;
let paused = false;
let writes = 0;
mock.module("node:fs", () => ({
  ...fs,
  existsSync: (path) => {
    if (String(path) === ${JSON.stringify(options.observedLock ?? f.intentLock)}) fs.writeFileSync(${JSON.stringify(attempted)}, "attempt");
    return exists(path);
  },
  renameSync: (from, to) => {
    if (String(to) === ${JSON.stringify(f.state)} ||
      (${options.watchNewState === true} && String(to).endsWith("aidlc-state.md") && String(to) !== ${JSON.stringify(f.state)})) {
      writes++;
      fs.writeFileSync(${JSON.stringify(renamed)}, "rename");
      if (${pause} && !paused && writes === ${options.pauseAtWrite ?? 1}) {
        paused = true;
        fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ state: String(to) }));
        const deadline = Date.now() + ${NATIVE_STARTUP_TIMEOUT_MS};
        while (!fs.existsSync(${JSON.stringify(release)})) {
          if (Date.now() > deadline) throw new Error("state test barrier expired");
          Bun.sleepSync(10);
        }
      }
    }
    return rename(from, to);
  },
}));
const { main } = await import(${JSON.stringify(join(REPO_ROOT, "core/tools", `aidlc-${options.tool ?? "state"}.ts`))});
await main(${JSON.stringify([...args, "--project-dir", commandProject])});
`);
  const child = spawn(process.execPath, [runner], {
    cwd: commandProject,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: {
      ...process.env,
      AIDLC_PROJECT_DIR: commandProject,
      CLAUDE_PROJECT_DIR: commandProject,
      AIDLC_SESSION_OVERRIDE: SESSION,
      AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
      AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools/data/stage-graph.json"),
      AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools/data/scope-grid.json"),
      AIDLC_SCOPES_DIR: join(AIDLC_SRC, "scopes"),
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
    },
  });
  let stdout = "", stderr = "", finished = false;
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => { finished = true; resolve({ code, stdout, stderr }); });
  });
  return { child, ready, release, attempted, renamed, result, finished: () => finished };
}

async function waitFor(path: string, operation: Writer): Promise<void> {
  const deadline = Date.now() + (remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) ?? NATIVE_STARTUP_TIMEOUT_MS);
  while (!existsSync(path)) {
    if (operation.finished()) throw new Error(`writer exited before ${path}: ${JSON.stringify(await operation.result)}`);
    if (Date.now() >= deadline) throw new Error(`writer did not reach ${path}`);
    await Bun.sleep(10);
  }
}

describe("terminal settlement shares the intent writer boundary", () => {
  test.each(["merge", "completion"] as const)("%s first: both real writers settle without reopening or deadlock", async (firstKind) => {
    const f = fixture();
    const merge = ["merge", "--slug", "test-bolt", "--target-dir", f.worktree];
    const complete = ["complete-workflow", "feasibility"];
    const first = writer(f, "first", firstKind === "merge" ? merge : complete, true);
    let second: Writer | undefined;
    try {
      await waitFor(first.ready, first);
      expect(JSON.parse(readFileSync(join(f.intentLock, "owner.json"), "utf8")).pid).toBe(first.child.pid);
      second = writer(f, "second", firstKind === "merge" ? complete : merge, false);
      await waitFor(second.attempted, second);
      expect(JSON.parse(readFileSync(join(f.intentLock, "owner.json"), "utf8")).pid).toBe(first.child.pid);
      expect(existsSync(second.renamed)).toBe(false);
      writeFileSync(first.release, "release");
      for (const result of await Promise.all([first.result, second.result])) {
        expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.stderr).not.toContain("Runtime graph refresh failed");
      }
      const state = readFileSync(f.state, "utf8");
      expect(getField(state, "Status")).toBe("Completed");
      expect(getField(state, "Bolt Refs")?.trim()).toBe("[empty list]");
      const audit = readAllAuditShards(f.project);
      expect(findAllEvents(audit, "STATE_MERGED")).toHaveLength(1);
      expect(findAllEvents(audit, "WORKFLOW_COMPLETED")).toHaveLength(1);
      expect(findAllEvents(audit, "STAGE_COMPLETED")).toHaveLength(1);
      expect(findAllEvents(audit, "MEMORY_EMPTY")).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(f.record, "runtime-graph.json"), "utf8")).stages)
        .toContainEqual(expect.objectContaining({ stage_slug: "feasibility", outcome: "approved" }));
    } finally {
      writeFileSync(first.release, "release");
      first.child.kill();
      second?.child.kill();
      await Promise.allSettled([first.result, ...(second ? [second.result] : [])]);
    }
  });

  test("approve reuses both locks through completion and its nested runtime compiler", async () => {
    const f = fixture("feedback-optimization", "?");
    const approve = writer(f, "approve", ["approve", "feedback-optimization", "--user-input", "Approve"], false);
    const result = await approve.result;
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("Runtime graph refresh failed");
    expect(getField(readFileSync(f.state, "utf8"), "Status")).toBe("Completed");
    const audit = readAllAuditShards(f.project);
    expect(findAllEvents(audit, "GATE_APPROVED")).toHaveLength(1);
    expect(findAllEvents(audit, "STAGE_COMPLETED")).toHaveLength(1);
    expect(findAllEvents(audit, "WORKFLOW_COMPLETED")).toHaveLength(1);
    expect(findAllEvents(audit, "MEMORY_EMPTY")).toHaveLength(1);
  });

  test.each(["archive", "state"] as const)("%s first: archive admission is decided on the locked state", async (firstKind) => {
    const f = fixture();
    const stateArgs = ["set", "Next Action=Saved before archive"];
    const archiveArgs = ["intent", "archive", f.intent];
    const first = writer(
      f, "first", firstKind === "archive" ? archiveArgs : stateArgs, true,
      { tool: firstKind === "archive" ? "utility" : "state" },
    );
    let second: Writer | undefined;
    try {
      await waitFor(first.ready, first);
      second = writer(
        f, "second", firstKind === "archive" ? stateArgs : archiveArgs, false,
        { tool: firstKind === "archive" ? "state" : "utility", observedLock: f.workspaceLock },
      );
      await waitFor(second.attempted, second);
      expect(JSON.parse(readFileSync(join(f.workspaceLock, "owner.json"), "utf8")).pid).toBe(first.child.pid);
      expect(existsSync(second.renamed)).toBe(false);
      writeFileSync(first.release, "release");
      const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
      expect(firstResult.code, `${firstResult.stdout}${firstResult.stderr}`).toBe(0);
      expect(secondResult.code, `${secondResult.stdout}${secondResult.stderr}`)
        .toBe(firstKind === "archive" ? 1 : 0);
      const state = readFileSync(f.state, "utf8");
      expect(getField(state, "Status")).toBe("Archived");
      expect(getField(state, "Next Action") === "Saved before archive").toBe(firstKind === "state");
      if (firstKind === "archive") expect(secondResult.stderr).toContain("Archived");
      expect(findAllEvents(readAllAuditShards(f.project, f.intent, "default"), "WORKFLOW_ARCHIVED")).toHaveLength(1);
    } finally {
      writeFileSync(first.release, "release");
      first.child.kill();
      second?.child.kill();
      await Promise.allSettled([first.result, ...(second ? [second.result] : [])]);
    }
  });

  test.each(["hold", "completion"] as const)("%s first: parent hold-merge shares the worker's physical record lock", async (firstKind) => {
    const parent = fixture();
    const state = join(parent.worktree, relative(parent.project, parent.state));
    const f = {
      ...parent,
      project: parent.worktree, state, record: dirname(state),
      intentLock: auditLockDir(parent.worktree, parent.intent, "default"),
      workspaceLock: auditLockDir(parent.worktree),
    };
    writeSessionBinding(f.project, SESSION, "default", f.intent, "create");
    const holdArgs = ["hold-merge", "--slug", "test-bolt"];
    const completeArgs = ["complete-workflow", "feasibility"];
    const first = writer(f, "first", firstKind === "hold" ? holdArgs : completeArgs, true, {
      tool: firstKind === "hold" ? "bolt" : "state",
      commandProject: firstKind === "hold" ? parent.project : f.project,
    });
    let second: Writer | undefined;
    try {
      await waitFor(first.ready, first);
      second = writer(f, "second", firstKind === "hold" ? completeArgs : holdArgs, false, {
        tool: firstKind === "hold" ? "state" : "bolt",
        commandProject: firstKind === "hold" ? f.project : parent.project,
        observedLock: f.workspaceLock,
      });
      await waitFor(second.attempted, second);
      expect(JSON.parse(readFileSync(join(f.workspaceLock, "owner.json"), "utf8")).pid).toBe(first.child.pid);
      expect(existsSync(second.renamed)).toBe(false);
      writeFileSync(first.release, "release");
      for (const result of await Promise.all([first.result, second.result])) {
        expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
      }
      const settled = readFileSync(state, "utf8");
      expect(getField(settled, "Status")).toBe("Completed");
      expect(getField(settled, "Merge-Held")).toBe("true");
      expect(getField(readFileSync(parent.state, "utf8"), "Status")).toBe("Running");
    } finally {
      writeFileSync(first.release, "release");
      first.child.kill();
      second?.child.kill();
      await Promise.allSettled([first.result, ...(second ? [second.result] : [])]);
    }
  });

  test("creation owns the new intent lock until its post-publication settings settle", async () => {
    const f = fixture();
    const create = writer(f, "create", [
      "intent-create", "--scope", "feature", "--label", "creation-race",
      "--guard.review-freeze", "on",
    ], true, { tool: "utility", watchNewState: true, pauseAtWrite: 2 });
    let fork: Writer | undefined;
    try {
      await waitFor(create.ready, create);
      const { state } = JSON.parse(readFileSync(create.ready, "utf8")) as { state: string };
      const intent = dirname(state).split(/[\\/]/).at(-1)!;
      const created = { ...f, state, intent, intentLock: auditLockDir(f.project, intent, "default") };
      expect(JSON.parse(readFileSync(join(created.intentLock, "owner.json"), "utf8")).pid).toBe(create.child.pid);
      fork = writer(created, "fork", [
        "fork", "--slug", "test-bolt", "--target-dir", f.worktree,
        "--intent", intent, "--space", "default",
      ], false);
      await waitFor(fork.attempted, fork);
      expect(existsSync(fork.renamed)).toBe(false);
      writeFileSync(create.release, "release");
      for (const result of await Promise.all([create.result, fork.result])) {
        expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
      }
      const content = readFileSync(state, "utf8");
      expect(getField(content, "Bolt Refs")).toContain("test-bolt");
      expect(getField(content, "Guards On")).toContain("review-freeze");
      expect(findAllEvents(readAllAuditShards(f.project, intent, "default"), "STATE_FORKED")).toHaveLength(1);
    } finally {
      writeFileSync(create.release, "release");
      create.child.kill();
      fork?.child.kill();
      await Promise.allSettled([create.result, ...(fork ? [fork.result] : [])]);
    }
  });

  test("migration's review update preserves a concurrent fork of the published record", async () => {
    const f = fixture();
    cpSync(f.record, join(f.project, "aidlc-docs"), { recursive: true });
    removeWorkspaceRecord(f.project);
    mkdirSync(f.worktree, { recursive: true });
    const migrate = writer(f, "migrate", [
      "intent-create", "--scope", "feature", "--review", "advisory",
    ], true, { tool: "utility", watchNewState: true });
    let fork: Writer | undefined;
    try {
      await waitFor(migrate.ready, migrate);
      const { state } = JSON.parse(readFileSync(migrate.ready, "utf8")) as { state: string };
      const intent = dirname(state).split(/[\\/]/).at(-1)!;
      const migrated = { ...f, state, intent, intentLock: auditLockDir(f.project, intent, "default") };
      expect(JSON.parse(readFileSync(join(migrated.intentLock, "owner.json"), "utf8")).pid).toBe(migrate.child.pid);
      fork = writer(migrated, "fork", [
        "fork", "--slug", "migration-bolt", "--target-dir", f.worktree,
        "--intent", intent, "--space", "default",
      ], false);
      await waitFor(fork.attempted, fork);
      expect(existsSync(fork.renamed)).toBe(false);
      writeFileSync(migrate.release, "release");
      for (const result of await Promise.all([migrate.result, fork.result])) {
        expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
      }
      const content = readFileSync(state, "utf8");
      expect(getField(content, "Bolt Refs")).toContain("migration-bolt");
      expect(getField(content, "Review Override")).toBe("advisory");
      expect(findAllEvents(readAllAuditShards(f.project, intent, "default"), "STATE_FORKED")).toHaveLength(1);
    } finally {
      writeFileSync(migrate.release, "release");
      migrate.child.kill();
      fork?.child.kill();
      await Promise.allSettled([migrate.result, ...(fork ? [fork.result] : [])]);
    }
  });
});
