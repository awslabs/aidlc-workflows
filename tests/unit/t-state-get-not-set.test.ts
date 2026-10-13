// covers: subcommand:aidlc-state:get, audit:ERROR_LOGGED
//
// A read of a line the work does not set (Plan on a preset, Initial Intent) is
// an answer, not a failed command (#2264). It writes no ERROR_LOGGED row into
// the work's audit record and tells the agent in one plain line. The exit stays
// non-zero, so a misspelt field name still fails visibly. Every other refusal
// of `get` logs as before.

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv, seedStateFile } from "../harness/fixtures.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");

function run(proj: string, argv: string[]): { rc: number; stdout: string; stderr: string } {
  const r = spawnSync(BUN, [...argv, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { rc: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const get = (proj: string, ...field: string[]) => run(proj, [STATE, "get", ...field]);
const errorRows = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "ERROR_LOGGED").length;

describe("aidlc-state get: a field the work does not set", () => {
  let proj: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
  });

  afterEach(() => {
    resetAidlcEnv();
    cleanupTestProject(proj);
  });

  test("an unset optional line is answered in one plain line and leaves no error in the audit record", () => {
    seedStateFile(proj, "state-initialization-done.md");
    for (const field of ["Plan", "Initial Intent"]) {
      const res = get(proj, field);
      expect(res.rc).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toBe(`"${field}" is not set in this work.\n`);
    }
    expect(errorRows(proj)).toBe(0);
  });

  test("a misspelt field still fails, naming exactly what was asked for", () => {
    seedStateFile(proj, "state-initialization-done.md");
    const res = get(proj, "Current", "stage");
    expect(res.rc).toBe(1);
    expect(res.stderr).toBe('"Current stage" is not set in this work.\n');
    expect(errorRows(proj)).toBe(0);
  });

  test("a set field reads as before", () => {
    seedStateFile(proj, "state-initialization-done.md");
    const res = get(proj, "Scope");
    expect(res.rc).toBe(0);
    expect(res.stdout).toBe("feature\n");
    expect(res.stderr).toBe("");
    expect(errorRows(proj)).toBe(0);
  });

  test("get with no field is still a logged error", () => {
    seedStateFile(proj, "state-initialization-done.md");
    const res = get(proj);
    expect(res.rc).toBe(1);
    expect(JSON.parse(res.stderr.trim())).toEqual({ error: "Usage: aidlc-state.ts get [--optional] <field>" });
    expect(errorRows(proj)).toBe(1);
  });

  test("a missing state file is still the tool's error", () => {
    const res = get(proj, "Plan");
    expect(res.rc).toBe(1);
    expect(JSON.parse(res.stderr.trim()).error).toStartWith("State file not found: ");
  });

  test("the dispatcher's engine state get answers the same way", () => {
    seedStateFile(proj, "state-initialization-done.md");
    const res = run(proj, [DISPATCHER, "engine", "state", "get", "Plan"]);
    expect(res.rc).toBe(1);
    expect(res.stderr).toBe('"Plan" is not set in this work.\n');
    expect(errorRows(proj)).toBe(0);
  });
});
