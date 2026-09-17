// covers: function:lastWorkspaceSourceFailure, function:workspaceSourceFailureSuffix, subcommand:aidlc-utility:doctor
//
// The workspace source walk returns null from many sites. Before this change a
// user who hit "unbindable" at Plan Approval was told nothing about WHICH budget
// or path failed. Every failing site now records a reason first, the messages
// that say "cannot be bound" append it, and the doctor runs the same walk so
// the reason is visible before the checkpoint refuses.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  lastWorkspaceSourceFailure,
  workspaceSourceFailureSuffix,
  workspaceSourceState,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ENTRIES_BUDGET = "AIDLC_TEST_SOURCE_MAX_ENTRIES";

const created: string[] = [];
const savedBudget = process.env[ENTRIES_BUDGET];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
  if (savedBudget === undefined) delete process.env[ENTRIES_BUDGET];
  else process.env[ENTRIES_BUDGET] = savedBudget;
});

function sourceProject(): string {
  const project = createTestProject();
  created.push(project);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "main.ts"), "export const main = 1;\n");
  return project;
}

function registry(project: string, body: string): void {
  writeFileSync(join(project, ".aidlc-source-paths.json"), body, "utf-8");
}

describe("t337 the source boundary names why it cannot bind", () => {
  test("a bound workspace records no failure and the suffix is empty", () => {
    const project = sourceProject();
    expect(workspaceSourceState(project)).not.toBeNull();
    expect(lastWorkspaceSourceFailure()).toBeNull();
    expect(workspaceSourceFailureSuffix()).toBe("");
  });

  test("the entries budget names the directory it ran out in", () => {
    const project = sourceProject();
    process.env[ENTRIES_BUDGET] = "1";
    expect(workspaceSourceState(project)).toBeNull();
    const failure = lastWorkspaceSourceFailure();
    expect(failure).toMatchObject({ code: "budget-entries", path: "." });
    expect(failure?.detail).toContain("more than 1");
    expect(workspaceSourceFailureSuffix()).toBe(" (reason: budget-entries at .)");
    // The next successful walk clears it: a stale reason never decorates a
    // message about a workspace that binds.
    delete process.env[ENTRIES_BUDGET];
    expect(workspaceSourceState(project)).not.toBeNull();
    expect(lastWorkspaceSourceFailure()).toBeNull();
  });

  test("a registered source behind a dangling symlink is named", () => {
    const project = sourceProject();
    symlinkSync(join(project, "missing-target"), join(project, "linked"));
    registry(project, JSON.stringify({ version: 1, paths: ["linked/src"] }));
    expect(workspaceSourceState(project)).toBeNull();
    expect(lastWorkspaceSourceFailure()).toMatchObject({
      code: "dangling-symlink",
      path: "linked/src",
    });
    expect(workspaceSourceFailureSuffix()).toBe(" (reason: dangling-symlink at linked/src)");
  });

  test("a registered source under a hard-excluded directory is named", () => {
    const project = sourceProject();
    registry(project, JSON.stringify({ version: 1, paths: ["node_modules/pkg"] }));
    expect(workspaceSourceState(project)).toBeNull();
    expect(lastWorkspaceSourceFailure()).toMatchObject({
      code: "excluded-path",
      path: "node_modules/pkg",
    });
  });

  test("an unparseable source registry is named at the registry file", () => {
    const project = sourceProject();
    registry(project, "{not json");
    expect(workspaceSourceState(project)).toBeNull();
    expect(lastWorkspaceSourceFailure()).toMatchObject({
      code: "registered-sources-invalid",
      path: ".aidlc-source-paths.json",
    });
  });
});

describe("t337 doctor: Workspace source boundary binds", () => {
  function runDoctor(
    project: string,
    env: Record<string, string> = {},
  ): { status: number; out: string } {
    const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", project], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  }

  test("passes with the fingerprint prefix when the workspace binds", () => {
    const project = createOrchestrationTestProject();
    created.push(project);
    seedStateFile(project, "state-brownfield-feature.md");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "main.ts"), "export const main = 1;\n");
    const { out } = runDoctor(project);
    expect(out).toMatch(/\bok\s+Workspace source boundary binds: [0-9a-f]{12}\b/);
  });

  test("fails with the reason, the path, and the repair text when the walk cannot bind", () => {
    const project = createOrchestrationTestProject();
    created.push(project);
    seedStateFile(project, "state-brownfield-feature.md");
    // The budget is counted per directory listing; a root with more entries
    // than the budget of 1 is what makes the walk fail here.
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "main.ts"), "export const main = 1;\n");
    writeFileSync(join(project, "README.md"), "# fixture\n");
    const { status, out } = runDoctor(project, { [ENTRIES_BUDGET]: "1" });
    expect(out).toMatch(/\bfail\s+Workspace source boundary binds: no \(budget-entries at \./);
    expect(out).toContain(".aidlc-source-paths.json");
    expect(out).toContain("Override Plan Approval: <reason>");
    expect(status).not.toBe(0);
  });

  test("is skipped when no workflow state exists", () => {
    const project = createOrchestrationTestProject();
    created.push(project);
    expect(existsSync(seededStateFile(project))).toBe(false);
    const { out } = runDoctor(project, { [ENTRIES_BUDGET]: "1" });
    expect(out).not.toContain("Workspace source boundary binds");
  });
});
