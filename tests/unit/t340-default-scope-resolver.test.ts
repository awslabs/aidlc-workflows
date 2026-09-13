// covers: function:defaultScopeResolution, function:defaultScope, subcommand:aidlc-utility:intent-create, subcommand:aidlc-utility:doctor, subcommand:aidlc-orchestrate:next

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  cleanupTestProject,
  createOrchestrationTestProject,
  removeWorkspaceRecord,
  runOrchestrateNext,
} from "../harness/fixtures.ts";

const HARNESS_ROOT = join(REPO_ROOT, "dist", "claude", ".claude");
const UTILITY = join(HARNESS_ROOT, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(HARNESS_ROOT, "tools", "aidlc-orchestrate.ts");
const projects: string[] = [];

 afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

function emptyProject(recordedScope?: string): string {
  const project = createOrchestrationTestProject();
  projects.push(project);
  // The shared fixture seeds an intent registry even without a state file.
  // Remove it so these calls exercise an empty workspace, not intent selection.
  removeWorkspaceRecord(project);
  if (recordedScope !== undefined) {
    writeFileSync(
      join(project, "aidlc.settings.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        flags: { schemaVersion: 1, defaultScope: recordedScope },
      })}\n`,
      "utf-8",
    );
  }
  return project;
}

function childEnv(project: string, scope?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:AIDLC_|AWS_AIDLC_|CLAUDE_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    AIDLC_PROJECT_DIR: project,
    AIDLC_RUNTIME_PROJECT_DIR: project,
    AIDLC_RUNTIME_HARNESS_ROOT: HARNESS_ROOT,
    AIDLC_HARNESS_DIR: ".claude",
    // Do not inherit a machine-level defaultScope or ceremony policy.
    AIDLC_INSTALL_ROOT: join(project, ".machine"),
  });
  if (scope !== undefined) env.AWS_AIDLC_DEFAULT_SCOPE = scope;
  return env;
}

function intentsDir(project: string): string {
  return join(project, "aidlc", "spaces", "default", "intents");
}

function createIntent(project: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(
    process.execPath,
    [
      UTILITY,
      "intent-create",
      "--arguments",
      "Build a shared task list",
      "--project-dir",
      project,
    ],
    { cwd: project, env, encoding: "utf-8", timeout: 30_000 },
  );
  if (result.error) throw result.error;
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const dir = intentsDir(project);
  const active = readFileSync(join(dir, "active-intent"), "utf-8").trim();
  return readFileSync(join(dir, active, "aidlc-state.md"), "utf-8");
}

function intentCapture(project: string, env: NodeJS.ProcessEnv) {
  const result = runOrchestrateNext(
    ORCHESTRATE,
    project,
    ["--stage", "intent-capture"],
    { cwd: project, env },
  );
  expect(result.status, result.out).toBe(0);
  // Routing a stage with no state must not masquerade as intent creation.
  expect(existsSync(join(intentsDir(project), "intents.json"))).toBe(false);
  return result.directive;
}

describe("t340 shared implicit scope resolution", () => {
  test("recorded feature scope drives empty-project next and intent-create without --scope", () => {
    const project = emptyProject("feature");
    const env = childEnv(project);
    // Ideation runs in feature but is skipped by classic, making the route
    // sensitive to the recorded default rather than merely accepting any scope.
    expect(intentCapture(project, env)).toMatchObject({
      kind: "run-stage",
      stage: "intent-capture",
    });
    expect(createIntent(project, env).split("\n")).toContain("- **Scope**: feature");
  });

  test("an explicit classic environment overrides recorded feature for both consumers", () => {
    const project = emptyProject("feature");
    const env = childEnv(project, "classic");
    const directive = intentCapture(project, env);
    expect(directive?.kind).toBe("error");
    expect(directive?.message).toContain('is skipped for scope "classic"');
    expect(createIntent(project, env).split("\n")).toContain("- **Scope**: classic");
  });

  test("neither environment nor recorded default falls back to classic", () => {
    const project = emptyProject();
    const env = childEnv(project);
    const directive = intentCapture(project, env);
    expect(directive?.kind).toBe("error");
    expect(directive?.message).toContain('is skipped for scope "classic"');
    expect(createIntent(project, env).split("\n")).toContain("- **Scope**: classic");
  });

  test("unknown environment scope reaches next's canonical error instead of recorded fallback", () => {
    const project = emptyProject("feature");
    const result = runOrchestrateNext(ORCHESTRATE, project, [], {
      cwd: project,
      env: childEnv(project, "frobnicate"),
    });
    expect(result.status, result.out).toBe(0);
    expect(result.directive?.kind).toBe("error");
    expect(result.directive?.message).toContain('Invalid AWS_AIDLC_DEFAULT_SCOPE "frobnicate"');
    expect(existsSync(join(intentsDir(project), "intents.json"))).toBe(false);
  });

  test("missing scope data preserves the default and doctor JSON diagnostics", () => {
    const project = emptyProject();
    const env = {
      ...childEnv(project),
      AIDLC_SCOPE_GRID: join(project, "missing-scope-grid.json"),
    };
    const resolved = spawnSync(process.execPath, [
      "--eval",
      `import { defaultScopeResolution } from ${JSON.stringify(join(HARNESS_ROOT, "tools", "aidlc-lib.ts"))}; console.log(JSON.stringify(defaultScopeResolution()));`,
    ], { cwd: project, env, encoding: "utf-8" });
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout)).toEqual({ scope: "classic", source: "default" });

    const doctor = spawnSync(process.execPath, [UTILITY, "doctor", "--json", "--project-dir", project], {
      cwd: project,
      env,
      encoding: "utf-8",
    });
    expect([0, 1]).toContain<number | null>(doctor.status);
    const diagnostics = JSON.parse(doctor.stdout) as { data: { checks: Array<{ pass: boolean; label: string }> } };
    expect(diagnostics.data.checks).toEqual(expect.any(Array));
  });
});
