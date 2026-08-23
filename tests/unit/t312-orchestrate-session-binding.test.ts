// covers: subcommand:aidlc-orchestrate:next function:resolveWorkflowSelection
//
// The real engine must resolve its state and emitted record paths from a
// session binding before consulting shared cursors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createIntent,
  sessionPidMapDir,
  setActiveIntentCursor,
  sessionsDir,
  writeSessionBinding,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
} from "../harness/fixtures.ts";

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

let proj = "";
let firstDir = "";
let secondDir = "";

beforeEach(() => {
  proj = createOrchestrationTestProject();
  const first = createIntent(proj, "session-a-work", "default", "feature");
  const second = createIntent(proj, "cursor-work", "default", "bugfix");
  firstDir = first.dirName;
  secondDir = second.dirName;
  copyFileSync(
    join(FIXTURES_DIR, "state-mid-ideation.md"),
    join(first.recordDir, "aidlc-state.md"),
  );
  copyFileSync(
    join(FIXTURES_DIR, "state-brownfield-init-done.md"),
    join(second.recordDir, "aidlc-state.md"),
  );
  setActiveIntentCursor(proj, second.dirName, "default");
});

afterEach(() => {
  cleanupTestProject(proj);
  proj = "";
  firstDir = "";
  secondDir = "";
});

function next(args: string[]): { status: number; out: string } {
  const result = runOrchestrateNext(ORCH, proj, args, {
    cwd: proj,
    env: { ...process.env },
  });
  return { status: result.status, out: result.out };
}

function nextWithSession(sessionId: string): { status: number; out: string; followups: string[] } {
  let command: string | null = null;
  const followups: string[] = [];
  for (let attempts = 0; attempts < 100; attempts++) {
    const result = command === null
      ? Bun.spawnSync({
        cmd: [process.execPath, ORCH, "next", "--session", sessionId, "--project-dir", proj],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
        cwd: proj,
      })
      : Bun.spawnSync({
        cmd: ["bash", "-lc", command],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
        cwd: proj,
      });
    const stdout = result.stdout.toString();
    let directive: Record<string, unknown> | null = null;
    try {
      directive = JSON.parse(stdout.trim()) as Record<string, unknown>;
    } catch {
      return {
        status: result.exitCode,
        out: `${stdout}${result.stderr.toString()}`,
        followups,
      };
    }
    if (directive.kind !== "load-steering") {
      return {
        status: result.exitCode,
        out: `${stdout}${result.stderr.toString()}`,
        followups,
      };
    }
    const followup = String(directive.continue_command ?? "");
    followups.push(followup);
    command = followup.replace(
      /^bun \S+\/tools\/aidlc-orchestrate\.ts/,
      `bun ${ORCH}`,
    );
  }
  return { status: -1, out: "steering continuation limit exceeded", followups };
}

describe("t312 orchestrate session binding", () => {
  test("explicit --session keeps session A on intent A after the cursor moves", () => {
    writeSessionBinding(proj, "session-a", "default", firstDir);

    const result = nextWithSession("session-a");
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('"stage":"feasibility"');
    expect(result.out).toContain(firstDir);
    expect(result.out).not.toContain(secondDir);
    expect(result.followups.length).toBeGreaterThan(0);
    expect(result.followups.every((command) => command.includes("--session session-a"))).toBe(true);
  });

  test("PID ancestry selects the same binding when --session is omitted", () => {
    writeSessionBinding(proj, "session-a", "default", firstDir);
    writeSessionPidEntry(proj, process.pid, "session-a");

    const result = next([]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('"stage":"feasibility"');
    expect(result.out).toContain(firstDir);
  });

  test("no binding and no PID map preserve the shared cursor fallback", () => {
    rmSync(sessionPidMapDir(proj), { recursive: true, force: true });
    rmSync(join(sessionsDir(proj), "session-a.binding.json"), {
      force: true,
    });

    const result = next([]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('"stage":"reverse-engineering"');
    expect(result.out).toContain(secondDir);
  });

  test("--session requires a nonblank value", () => {
    const result = next(["--session"]);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("--session requires a nonblank session id");
  });

  test("explicit session B reaches the state child despite ancestry session A", () => {
    writeSessionBinding(proj, "session-a", "default", firstDir);
    writeSessionBinding(proj, "session-b", "default", secondDir);
    writeSessionPidEntry(proj, process.pid, "session-a");
    const firstPath = join(proj, "aidlc", "spaces", "default", "intents", firstDir, "aidlc-state.md");
    const secondPath = join(proj, "aidlc", "spaces", "default", "intents", secondDir, "aidlc-state.md");
    const firstBefore = readFileSync(firstPath, "utf-8");

    const result = Bun.spawnSync({
      cmd: [process.execPath, ORCH, "park", "--session", "session-b", "--project-dir", proj],
      stdout: "pipe",
      stderr: "pipe",
      cwd: proj,
      env: { ...process.env },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(firstPath, "utf-8")).toBe(firstBefore);
    expect(readFileSync(secondPath, "utf-8")).toContain("- **Parked**:");
  });
});
