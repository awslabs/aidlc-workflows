// covers: subcommand:aidlc-utility:project-description, function:keepSingleRunRequest, function:singleRunRequest, function:emitSingleRunStage
//
// A stage run on its own in a project with no work (`/aidlc --stage
// requirements-analysis --single add due dates to each todo`) has no work's
// description to read: Requirements Analysis and Intent Capture read the
// person's request with `project-description`, which then failed with ENOENT
// on the missing aidlc-state.md, and Codex stopped the stage there and told the
// person to run --doctor. The run's start now keeps the words typed after the
// flags, whole, and `project-description` returns them while that run is open,
// or no description (exit 0) when none were typed, so the agent asks once.

import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  createTestProject,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seedAidlcMemory,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { join } from "node:path";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STAGE = "requirements-analysis";

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  return env;
}

function noWorkProject(): string {
  const proj = createTestProject();
  seedAidlcMemory(proj);
  removeWorkspaceRecord(proj);
  return proj;
}

function startIsolated(proj: string, words: string[] = []): void {
  const run = runOrchestrateNext(ORCH, proj, ["--scope", "feature", "--stage", STAGE, "--single", ...words], { env: childEnv() });
  expect(run.directive?.kind, JSON.stringify(run.directive)).toBe("run-stage");
}

function projectDescription(proj: string): { status: number; json: Record<string, unknown> | null; out: string } {
  const result = spawnSync(process.execPath, [UTILITY, "project-description", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: childEnv(),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: result.status ?? -1, json, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function finish(proj: string): void {
  const result = spawnSync(process.execPath, [ORCH, "report", "--single", "--stage", STAGE, "--result", "completed", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: childEnv(),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

describe("the request of a stage run on its own with no work", () => {
  test("the words typed after the flags are the run's description", () => {
    const proj = noWorkProject();
    startIsolated(proj, ["add due dates to each todo"]);
    const read = projectDescription(proj);
    expect(read.status, read.out).toBe(0);
    expect(read.json).toEqual({ description: "add due dates to each todo", source: `single-stage:${STAGE}` });
  });

  test("words typed as several arguments, and over several lines, are kept whole", () => {
    const proj = noWorkProject();
    startIsolated(proj, ["add", "due dates", "to each todo:\nsort by date,\n  soonest first"]);
    expect(projectDescription(proj).json?.description).toBe("add due dates to each todo:\nsort by date,\n  soonest first");
  });

  test("a pasted document is split from the person's words, as for a piece of work", () => {
    const proj = noWorkProject();
    startIsolated(proj, ["Write requirements from this.\n<document>\nThe spec.\n</document>\nKeep it short."]);
    const read = projectDescription(proj).json;
    expect(read?.directions).toBe("Write requirements from this.\n\nKeep it short.");
    expect(read?.document).toBe("<document>\nThe spec.\n</document>");
  });

  test("with no words typed there is no description, and the command still succeeds", () => {
    const proj = noWorkProject();
    startIsolated(proj);
    const read = projectDescription(proj);
    expect(read.status, read.out).toBe(0);
    expect(read.json).toEqual({ description: null, source: null });
  });

  test("a later start with no words does not bring back an earlier run's words", () => {
    const proj = noWorkProject();
    startIsolated(proj, ["add due dates to each todo"]);
    finish(proj);
    startIsolated(proj);
    expect(projectDescription(proj).json).toEqual({ description: null, source: null });
  });

  test("inside work the work's own description is read, as before", () => {
    const proj = setupIntegrationProject({ withState: "state-mid-inception.md" });
    const before = projectDescription(proj);
    startIsolated(proj, ["something else entirely"]);
    expect(projectDescription(proj)).toEqual(before);
  });
});
