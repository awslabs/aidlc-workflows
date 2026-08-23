// covers: subcommand:aidlc-orchestrate:next function:resolveWorkflowSelection
//
// The real engine must resolve its state and emitted record paths from a
// session binding before consulting shared cursors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createIntent,
  readAllAuditShards,
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

function cleanEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.AIDLC_SESSION_OVERRIDE;
  return env;
}

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

function next(
  env: Record<string, string | undefined> = cleanEnv(),
): { status: number; out: string } {
  const result = runOrchestrateNext(ORCH, proj, [], {
    cwd: proj,
    env,
  });
  return { status: result.status, out: result.out };
}

function statePath(intent: string): string {
  return join(
    proj,
    "aidlc",
    "spaces",
    "default",
    "intents",
    intent,
    "aidlc-state.md",
  );
}

describe("t312 orchestrate session binding", () => {
  test("PID ancestry selects its binding before the shared cursor", () => {
    writeSessionBinding(proj, "session-a", "default", firstDir);
    writeSessionPidEntry(proj, process.pid, "session-a");

    const result = next();
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('"stage":"feasibility"');
    expect(result.out).toContain(firstDir);
  });

  test("no binding and no PID map preserve the shared cursor fallback", () => {
    rmSync(sessionPidMapDir(proj), { recursive: true, force: true });
    rmSync(join(sessionsDir(proj), "session-a.binding.json"), {
      force: true,
    });

    const result = next();
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('"stage":"reverse-engineering"');
    expect(result.out).toContain(secondDir);
  });

  test("headless environment pin reaches the state child end to end", () => {
    writeSessionBinding(proj, "session-b", "default", secondDir);
    rmSync(sessionPidMapDir(proj), { recursive: true, force: true });
    const firstBefore = readFileSync(statePath(firstDir), "utf-8");

    const result = Bun.spawnSync({
      cmd: [process.execPath, ORCH, "park", "--project-dir", proj],
      stdout: "pipe",
      stderr: "pipe",
      cwd: proj,
      env: {
        ...cleanEnv(),
        AIDLC_SESSION_OVERRIDE: "session-b",
      },
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(statePath(firstDir), "utf-8")).toBe(firstBefore);
    expect(readFileSync(statePath(secondDir), "utf-8")).toContain("- **Parked**:");
  });

  test("divergent environment and ancestry refuse before any workflow write", () => {
    writeSessionBinding(proj, "session-a", "default", firstDir);
    writeSessionBinding(proj, "session-b", "default", secondDir);
    writeSessionPidEntry(proj, process.pid, "session-a");
    const firstBefore = readFileSync(statePath(firstDir), "utf-8");
    const secondBefore = readFileSync(statePath(secondDir), "utf-8");
    const firstAuditBefore = readAllAuditShards(proj, firstDir, "default");
    const secondAuditBefore = readAllAuditShards(proj, secondDir, "default");

    const result = Bun.spawnSync({
      cmd: [process.execPath, ORCH, "park", "--project-dir", proj],
      stdout: "pipe",
      stderr: "pipe",
      cwd: proj,
      env: {
        ...cleanEnv(),
        AIDLC_SESSION_OVERRIDE: "session-b",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'Session override "session-b" conflicts with the owning conversation "session-a"',
    );
    expect(readFileSync(statePath(firstDir), "utf-8")).toBe(firstBefore);
    expect(readFileSync(statePath(secondDir), "utf-8")).toBe(secondBefore);
    expect(readAllAuditShards(proj, firstDir, "default")).toBe(firstAuditBefore);
    expect(readAllAuditShards(proj, secondDir, "default")).toBe(secondAuditBefore);
    expect(firstAuditBefore).not.toContain("ERROR_LOGGED");
    expect(secondAuditBefore).not.toContain("ERROR_LOGGED");
  });

  for (const invalid of [" session-a", "session-a ", "session/a"]) {
    test(`invalid environment value ${JSON.stringify(invalid)} is ignored`, () => {
      writeSessionBinding(proj, "session-a", "default", firstDir);
      rmSync(sessionPidMapDir(proj), { recursive: true, force: true });

      const result = next({
        ...cleanEnv(),
        AIDLC_SESSION_OVERRIDE: invalid,
      });

      expect(result.status, result.out).toBe(0);
      expect(result.out).toContain('"stage":"reverse-engineering"');
      expect(result.out).toContain(secondDir);
      expect(result.out).not.toContain(firstDir);
    });
  }
});
