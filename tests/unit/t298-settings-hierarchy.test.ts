// covers: function:resolveAidlcSettings, function:normalizeAidlcSettings, function:settingsDoctorChecks

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsDoctorChecks } from "../../core/tools/aidlc-config-diagnostics.ts";
import { readConfigDiagnosticRecords } from "../../core/tools/aidlc-config-diagnostics.ts";
import {
  AIDLC_SETTINGS_SCHEMA,
  _resetSettingsCacheForTests,
  _settingsCacheStatsForTests,
  localSettingsPath,
  machineSettingsPath,
  modelPolicyForHarness,
  normalizeAidlcSettings,
  projectSettingsPath,
  resolveAidlcSettings,
} from "../../core/tools/aidlc-settings.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST_RELEASE = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];

beforeEach(() => {
  _resetSettingsCacheForTests();
});

afterEach(() => {
  _resetSettingsCacheForTests();
  delete process.env.AIDLC_INSTALL_ROOT;
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [INIT, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function install(): string {
  const project = temp("aidlc-t298-project-");
  mkdirSync(join(project, ".git"));
  const result = run([
    "config",
    "--project-dir",
    project,
    "--from",
    join(DIST_RELEASE, "claude"),
    "--harness",
    "claude",
    "--mcp",
    "none",
    "--yes",
  ], project);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return project;
}

describe("t298 aidlc.settings hierarchy", () => {
  test("the generated schema ships identically in every harness", () => {
    for (const [harness, harnessDir] of [
      ["claude", ".claude"],
      ["codex", ".codex"],
      ["copilot", ".aidlc"],
      ["cursor", ".cursor"],
      ["kiro", ".kiro"],
      ["kiro-ide", ".kiro"],
      ["opencode", ".aidlc"],
    ]) {
      expect(JSON.parse(readFileSync(
        join(
          REPO_ROOT,
          "dist",
          harness,
          harnessDir,
          "tools",
          "data",
          "aidlc-settings.schema.json",
        ),
        "utf-8",
      ))).toEqual(AIDLC_SETTINGS_SCHEMA);
    }
  });

  test("machine, project, and local merge leaf-by-leaf and cache one read per file", () => {
    const machine = temp("aidlc-t298-machine-");
    const project = temp("aidlc-t298-chain-");
    process.env.AIDLC_INSTALL_ROOT = machine;
    writeJson(machineSettingsPath(), {
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        preset: "thorough",
        agents: {
          architect: {
            model: { claude: "machine/model", codex: "machine/codex" },
          },
        },
      },
      flags: { schemaVersion: 1, swarm: false },
      offline: true,
    });
    writeJson(projectSettingsPath(project), {
      $schema: ".claude/tools/data/aidlc-settings.schema.json",
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        groups: { "writing-up": { effort: "low" } },
        agents: { architect: { effort: "high" } },
      },
      flags: { schemaVersion: 1, defaultScope: "feature" },
    });
    writeJson(localSettingsPath(project), {
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        agents: { architect: { model: { claude: "local/model" } } },
      },
      flags: { schemaVersion: 1, swarm: true },
    });

    const first = resolveAidlcSettings(project);
    const second = resolveAidlcSettings(project);
    expect(second).toEqual(first);
    expect(first.value.offline).toBe(true);
    expect(first.flags).toEqual({
      schemaVersion: 1,
      defaultScope: "feature",
      swarm: true,
    });
    expect(modelPolicyForHarness(first.models, "claude")).toEqual({
      schemaVersion: 1,
      preset: "thorough",
      groups: { "writing-up": { effort: "low" } },
      agents: {
        architect: { model: "local/model", effort: "high" },
      },
    });
    expect(modelPolicyForHarness(first.models, "codex")?.agents?.architect?.model)
      .toBe("machine/codex");
    expect(first.sources["models.preset"]).toBe("machine");
    expect(first.sources["models.groups.writing-up.effort"]).toBe("project");
    expect(first.sources["models.agents.architect.model.claude"]).toBe("local");
    expect(first.sources["flags.swarm"]).toBe("local");
    expect(_settingsCacheStatsForTests()).toEqual({
      entries: 3,
      stats: 3,
      reads: 3,
    });
  });

  test("$schema is tolerated while unknown and machine-only project keys fail closed", () => {
    expect(normalizeAidlcSettings({
      $schema: "aidlc-settings.schema.json",
      schemaVersion: 1,
      flags: { schemaVersion: 1, swarm: true },
    }, "project", "/repo/aidlc.settings.json").$schema).toBe(
      "aidlc-settings.schema.json",
    );
    expect(() => normalizeAidlcSettings({
      schemaVersion: 1,
      mystery: true,
    }, "project", "/repo/aidlc.settings.json")).toThrow("unknown key");
    expect(() => normalizeAidlcSettings({
      schemaVersion: 1,
      offline: true,
    }, "local", "/repo/aidlc.settings.local.json")).toThrow(
      machineSettingsPath(),
    );
    expect(() => normalizeAidlcSettings({
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        agents: { architect: { model: "not-keyed" } },
      },
    }, "project", "/repo/aidlc.settings.json")).toThrow(
      "must be an object keyed by harness",
    );
  });

  test("mutations require a target, local creation adds gitignore once, and policy leaves harness data", () => {
    const project = install();
    const env = { AIDLC_RUNTIME_ROOT: DIST_RELEASE };
    const missingTarget = run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--swarm",
      "on",
      "--yes",
    ], project, env);
    expect(missingTarget.status).toBe(2);
    expect(missingTarget.stdout).toContain("--local, --project, or --global");

    const local = run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--local",
      "--swarm",
      "on",
      "--yes",
    ], project, env);
    expect(local.status, local.stdout + local.stderr).toBe(0);
    expect(existsSync(localSettingsPath(project))).toBe(true);
    const gitignore = readFileSync(join(project, ".gitignore"), "utf-8");
    expect(gitignore.split(/\r?\n/).filter((line) =>
      line === "aidlc.settings.local.json"
    )).toHaveLength(1);
    const localAgain = run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--local",
      "--hook-debug",
      "on",
      "--yes",
    ], project, env);
    expect(localAgain.status, localAgain.stdout + localAgain.stderr).toBe(0);
    expect(readFileSync(join(project, ".gitignore"), "utf-8")).toBe(gitignore);

    const projectWrite = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--agent",
      "architect",
      "--effort",
      "high",
      "--model",
      "vendor/model",
      "--yes",
    ], project, env);
    expect(projectWrite.status, projectWrite.stdout + projectWrite.stderr).toBe(0);
    const projectFile = JSON.parse(
      readFileSync(projectSettingsPath(project), "utf-8"),
    );
    expect(projectFile.models.agents.architect.model).toEqual({
      claude: "vendor/model",
    });
    const harnessData = JSON.parse(
      readFileSync(
        join(project, ".claude", "tools", "data", "harness.json"),
        "utf-8",
      ),
    );
    expect(harnessData.models).toBeUndefined();
    expect(harnessData.flags).toBeUndefined();
    expect(() => readConfigDiagnosticRecords(join(project, ".claude"))).not
      .toThrow();
  }, 60_000);

  test("a first harness install applies already-committed project policy", () => {
    const project = temp("aidlc-t298-preconfigured-");
    mkdirSync(join(project, ".git"));
    writeJson(projectSettingsPath(project), {
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        groups: { reviewing: { effort: "xhigh" } },
      },
      flags: {
        schemaVersion: 1,
        defaultScope: "poc",
      },
    });
    const result = run([
      "config",
      "--project-dir",
      project,
      "--from",
      join(DIST_RELEASE, "claude"),
      "--harness",
      "claude",
      "--mcp",
      "none",
      "--yes",
    ], project);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(
      join(project, ".claude", "agents", "aidlc-product-lead-agent.md"),
      "utf-8",
    )).toContain("effort: xhigh");
    expect(JSON.parse(
      readFileSync(join(project, ".claude", "settings.json"), "utf-8"),
    ).env.AWS_AIDLC_DEFAULT_SCOPE).toBe("poc");
  }, 60_000);

  test("outside a project the global target is inferred", () => {
    const machine = temp("aidlc-t298-global-");
    const outside = temp("aidlc-t298-outside-");
    const result = run([
      "config",
      "flags",
      "--swarm",
      "on",
      "--yes",
    ], outside, {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(
      readFileSync(join(machine, "aidlc.settings.json"), "utf-8"),
    ).flags.swarm).toBe(true);
    const models = run([
      "config",
      "models",
      "--preset",
      "minimal",
      "--yes",
    ], outside, {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    });
    expect(models.status, models.stdout + models.stderr).toBe(0);
    const machineFile = JSON.parse(
      readFileSync(join(machine, "aidlc.settings.json"), "utf-8"),
    );
    expect(machineFile.flags.swarm).toBe(true);
    expect(machineFile.models.preset).toBe("minimal");
    expect(existsSync(projectSettingsPath(outside))).toBe(false);
  });

  test("settings-only inspection rejects mutations and harness reset preserves peers", () => {
    const machine = temp("aidlc-t298-multi-harness-");
    const outside = temp("aidlc-t298-multi-harness-outside-");
    const settingsPath = join(machine, "aidlc.settings.json");
    writeJson(settingsPath, {
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        agents: {
          architect: {
            effort: "high",
            model: {
              claude: "claude-special",
              codex: "codex-special",
            },
          },
        },
      },
    });
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    const before = readFileSync(settingsPath, "utf-8");
    const conflict = run([
      "config",
      "models",
      "--project-dir",
      outside,
      "--global",
      "--show",
      "--preset",
      "minimal",
      "--yes",
    ], outside, env);
    expect(conflict.status).toBe(2);
    expect(conflict.stdout).toContain("cannot be combined with models mutations");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);

    const reset = run([
      "config",
      "models",
      "--project-dir",
      outside,
      "--global",
      "--harness",
      "claude",
      "--reset",
      "--yes",
    ], outside, env);
    expect(reset.status, reset.stdout + reset.stderr).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).models).toEqual({
      schemaVersion: 1,
      agents: {
        architect: {
          model: { codex: "codex-special" },
        },
      },
    });
  });

  test("doctor reports a git-tracked local settings file", () => {
    const project = temp("aidlc-t298-tracked-");
    spawnSync("git", ["init", "-q"], { cwd: project });
    writeJson(localSettingsPath(project), {
      schemaVersion: 1,
      flags: { schemaVersion: 1, swarm: true },
    });
    spawnSync("git", ["add", "aidlc.settings.local.json"], { cwd: project });
    const checks = settingsDoctorChecks(project);
    expect(checks).toContainEqual(expect.objectContaining({
      pass: false,
      severity: "warn",
      label: expect.stringContaining("git-tracked"),
    }));
  });
});
