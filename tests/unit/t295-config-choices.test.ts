// covers: function:normalizeProjectFlagsRecord, function:projectFlags, function:resolveProjectFlag, function:availableScopeNames, function:flagFiles, function:flagIssues, function:discoverInstalledPluginNames, function:readPluginSelection, function:completionInstruction, function:projectChoiceFiles, function:projectChoiceIssues, function:normalizeProjectChoicesRecord, function:flagsDoctorCheck
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  applyConfigDiagnosticRecords,
  availableScopeNames,
  completionInstruction,
  flagsDoctorCheck,
  readConfigDiagnosticRecords,
} from "../../core/tools/aidlc-config-diagnostics.ts";
import {
  RECORDABLE_PROJECT_BYPASSES,
} from "../../core/tools/aidlc-lib.ts";
import {
  invalidateSettingsCache,
  resolveAidlcSettings,
} from "../../core/tools/aidlc-settings.ts";

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST = join(REPO_ROOT, "dist");
const DIST_RELEASE = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
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

function install(harness = "claude", mcp: "defaults" | "none" = "none"): string {
  const project = temp(`aidlc-t295-${harness}-`);
  mkdirSync(join(project, ".git"));
  const result = run([
    "config",
    "--project-dir",
    project,
    "--from",
    join(DIST_RELEASE, harness),
    "--harness",
    harness,
    "--mcp",
    mcp,
    "--yes",
  ], project);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return project;
}

function runtimeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AIDLC_RUNTIME_ROOT: DIST_RELEASE,
    ...extra,
  };
}

function runScopeConsumer(
  project: string,
  scopeOverride?: string,
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_HARNESS_DIR: ".claude",
    AIDLC_RUNTIME_HARNESS_ROOT: join(project, ".claude"),
    AIDLC_RUNTIME_PROJECT_DIR: project,
  };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  if (scopeOverride !== undefined) env.AWS_AIDLC_DEFAULT_SCOPE = scopeOverride;
  const result = spawnSync(
    BUN,
    [
      join(project, ".claude", "tools", "aidlc-utility.ts"),
      "resolve-env-scope",
      "--project-dir",
      project,
    ],
    {
      cwd: project,
      env,
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function harnessData(project: string, harnessDir = ".claude"): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(project, harnessDir, "tools", "data", "harness.json"), "utf-8"),
  ) as Record<string, unknown>;
}

function resolvedFlags(project: string) {
  invalidateSettingsCache();
  return resolveAidlcSettings(project).flags;
}

describe("t295 config choice dispatch", () => {
  test("flags and project are sections, unknown usage lists all six, and flags are strict", () => {
    for (const section of ["flags", "project"]) {
      const help = run(["config", section, "--help"], REPO_ROOT);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain(
        `bun .claude/tools/aidlc.ts config ${section}`,
      );
    }
    const project = temp("aidlc-t295-dispatch-");
    mkdirSync(join(project, ".git"));
    const unknown = run([
      "config",
      "harnesses",
      "--project-dir",
      project,
    ], project);
    expect(unknown.status).toBe(2);
    expect(unknown.stdout).toContain(
      "valid sections: models, runtime, providers, trust, flags, project",
    );

    const flagsPlugin = run([
      "config",
      "flags",
      "--plugins",
      "aidlc",
      "--project-dir",
      project,
    ], project);
    expect(flagsPlugin.status).toBe(2);
    expect(flagsPlugin.stdout).toContain(
      "--plugins is not valid for config flags",
    );

    const projectBypass = run([
      "config",
      "project",
      "--bypass",
      "AIDLC_SKIP_ARTIFACT_GUARD",
      "--project-dir",
      project,
    ], project);
    expect(projectBypass.status).toBe(2);
    expect(projectBypass.stdout).toContain(
      "--bypass is not valid for config project",
    );
  });
});

describe("t295 flags section", () => {
  test("records flags, validates scope data, rewrites Claude, and env beats record", () => {
    const project = install();
    const scopes = availableScopeNames(join(project, ".claude"));
    expect(scopes.length).toBeGreaterThan(1);
    const recordedScope = scopes[0];
    const envScope = scopes[1];

    const invalid = run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--project",
      "--default-scope",
      "not-an-installed-scope",
      "--yes",
    ], project, runtimeEnv());
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toContain("installed scopes");

    const applied = run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--project",
      "--default-scope",
      recordedScope,
      "--swarm",
      "on",
      "--hook-debug",
      "on",
      "--sensor-timeout-ms",
      "12345",
      "--bypass",
      "AIDLC_SKIP_ARTIFACT_GUARD",
      "--yes",
    ], project, runtimeEnv());
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    const flags = resolvedFlags(project);
    expect(flags).toEqual({
      schemaVersion: 1,
      defaultScope: recordedScope,
      swarm: true,
      hookDebug: true,
      sensorTimeoutMs: 12345,
      bypasses: ["AIDLC_SKIP_ARTIFACT_GUARD"],
    });
    expect(harnessData(project).flags).toBeUndefined();
    const settings = JSON.parse(
      readFileSync(join(project, ".claude", "settings.json"), "utf-8"),
    ) as { env: Record<string, string> };
    expect(settings.env.AWS_AIDLC_DEFAULT_SCOPE).toBe(recordedScope);

    const recorded = runScopeConsumer(project);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    expect(recorded.stdout).toBe(`scope=${recordedScope}\n`);
    const overridden = runScopeConsumer(project, envScope);
    expect(overridden.status, overridden.stdout + overridden.stderr).toBe(0);
    expect(overridden.stdout).toBe(`scope=${envScope}\n`);

    const show = run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--show",
      "--json",
    ], project, runtimeEnv());
    const payload = JSON.parse(show.stdout) as {
      data: {
        files: Array<{ file: string }>;
        record: { bypasses: string[] };
        sources: Record<string, string>;
      };
    };
    expect(payload.data.files.map((entry) => entry.file)).toContain(
      join(project, ".claude", "settings.json"),
    );
    expect(payload.data.files.map((entry) => entry.file)).toContain(
      "aidlc.settings.json",
    );
    expect(payload.data.record.bypasses).toEqual([
      "AIDLC_SKIP_ARTIFACT_GUARD",
    ]);
    expect(payload.data.sources.AIDLC_USE_SWARM).toBe("project");

    const targetEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_RUNTIME_ROOT: DIST_RELEASE,
    };
    delete targetEnv.AIDLC_USE_SWARM;
    const fromOtherCwd = spawnSync(
      BUN,
      [
        INIT,
        "config",
        "flags",
        "--project-dir",
        project,
        "--show",
        "--json",
      ],
      {
        cwd: REPO_ROOT,
        env: targetEnv,
        encoding: "utf-8",
      },
    );
    expect(fromOtherCwd.status).toBe(0);
    expect(
      JSON.parse(fromOtherCwd.stdout).data.effective.AIDLC_USE_SWARM,
    ).toBe("1");

    targetEnv.AIDLC_USE_SWARM = "0";
    const envFromOtherCwd = spawnSync(
      BUN,
      [
        INIT,
        "config",
        "flags",
        "--project-dir",
        project,
        "--show",
        "--json",
      ],
      {
        cwd: REPO_ROOT,
        env: targetEnv,
        encoding: "utf-8",
      },
    );
    expect(envFromOtherCwd.status).toBe(0);
    expect(
      JSON.parse(envFromOtherCwd.stdout).data.effective.AIDLC_USE_SWARM,
    ).toBe("0");
    const envHuman = run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--show",
    ], project, runtimeEnv({
      AIDLC_USE_SWARM: "0",
    }));
    expect(envHuman.status).toBe(0);
    expect(envHuman.stdout).toContain("Swarm: off [env]");
    expect(envHuman.stdout).toContain(
      "overrides the recorded answer on",
    );

    const checkOverride = run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--check",
    ], project, runtimeEnv({
      AWS_AIDLC_DEFAULT_SCOPE: envScope,
    }));
    expect(checkOverride.status).toBe(1);
    expect(checkOverride.stdout).toContain("overrides the recorded answer");

    const previous = process.env.AWS_AIDLC_DEFAULT_SCOPE;
    process.env.AWS_AIDLC_DEFAULT_SCOPE = envScope;
    try {
      const doctor = flagsDoctorCheck(project, ".claude");
      expect(doctor.pass).toBe(false);
      expect(doctor.severity).toBe("warn");
    } finally {
      if (previous === undefined) delete process.env.AWS_AIDLC_DEFAULT_SCOPE;
      else process.env.AWS_AIDLC_DEFAULT_SCOPE = previous;
    }

    expect(run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    expect(resolvedFlags(project))
      .toEqual(flags);
  }, 60_000);

  test("bypasses require explicit opt-in and reset restores shipped bytes", () => {
    const project = install();
    const bypass = RECORDABLE_PROJECT_BYPASSES[0];
    const help = run(["config", "flags", "--help"], project);
    expect(help.stdout).toContain("weaken deterministic guards");
    expect(help.stdout).toContain("--bypass");

    expect(run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--project",
      "--bypass",
      bypass,
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    expect(resolvedFlags(project)?.bypasses)
      .toEqual([bypass]);

    expect(run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--project",
      "--clear-bypass",
      bypass,
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    expect(resolvedFlags(project)?.bypasses)
      .toBeUndefined();

    expect(run([
      "config",
      "flags",
      "--project-dir",
      project,
      "--project",
      "--reset",
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    expect(resolvedFlags(project))
      .toBeNull();
    const shipped = JSON.parse(
      readFileSync(join(DIST_RELEASE, "claude", ".claude", "settings.json"), "utf-8"),
    ) as { env: Record<string, string> };
    const current = JSON.parse(
      readFileSync(join(project, ".claude", "settings.json"), "utf-8"),
    ) as { env: Record<string, string> };
    expect(current.env.AWS_AIDLC_DEFAULT_SCOPE).toBe(
      shipped.env.AWS_AIDLC_DEFAULT_SCOPE,
    );
  }, 60_000);
});

describe("t295 project section", () => {
  test("records plugins, safe MCP default, completions, and survives refresh", () => {
    const project = install("claude", "none");
    writeFileSync(
      join(project, ".claude", "tools", "data", "plugin-contrib-test-pro.json"),
      "{}\n",
    );
    const applied = run([
      "config",
      "project",
      "--project-dir",
      project,
      "--plugins",
      "aidlc,test-pro",
      "--completions",
      "bash",
      "--yes",
    ], project, runtimeEnv());
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toContain(
      'Install completions with: eval "$(aidlc system completions bash)"',
    );
    const data = harnessData(project);
    expect(data.plugins).toEqual(["aidlc", "test-pro"]);
    expect(data.project).toEqual({
      schemaVersion: 1,
      mcp: "none",
      completions: "bash",
    });
    expect(existsSync(join(project, ".mcp.json"))).toBe(false);

    const shown = run([
      "config",
      "project",
      "--project-dir",
      project,
      "--show",
      "--json",
    ], project, runtimeEnv());
    const payload = JSON.parse(shown.stdout) as {
      data: {
        completionInstruction: string;
        plugins: string[];
      };
    };
    expect(payload.data.plugins).toEqual(["aidlc", "test-pro"]);
    expect(payload.data.completionInstruction).toBe(
      'eval "$(aidlc system completions bash)"',
    );
    expect(run([
      "config",
      "project",
      "--project-dir",
      project,
      "--check",
    ], project, runtimeEnv()).status).toBe(0);

    expect(run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    expect(harnessData(project).project).toEqual(data.project);
    expect(harnessData(project).plugins).toEqual(["aidlc", "test-pro"]);

    const copy = temp("aidlc-t295-copy-completions-");
    cpSync(join(DIST, "claude"), copy, { recursive: true });
    expect(completionInstruction(copy, ".claude", "bash")).toBe(
      'eval "$(bun .claude/tools/aidlc.ts system completions bash)"',
    );
  }, 60_000);

  test("MCP consent is rerunnable and --yes never adds defaults", () => {
    const project = install("claude", "none");
    const noConsent = run([
      "config",
      "project",
      "--project-dir",
      project,
      "--completions",
      "none",
      "--yes",
    ], project, runtimeEnv());
    expect(noConsent.status).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".claude")).project?.mcp)
      .toBe("none");
    expect(existsSync(join(project, ".mcp.json"))).toBe(false);

    expect(run([
      "config",
      "project",
      "--project-dir",
      project,
      "--mcp",
      "defaults",
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    const defaults = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf-8"));
    expect(Object.keys(defaults.mcpServers).sort()).toEqual([
      "aws-iac",
      "aws-mcp",
      "aws-pricing",
      "aws-serverless",
      "context7",
    ]);

    expect(run([
      "config",
      "project",
      "--project-dir",
      project,
      "--mcp",
      "none",
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    expect(
      existsSync(join(project, ".mcp.json"))
        ? JSON.parse(readFileSync(join(project, ".mcp.json"), "utf-8")).mcpServers
        : undefined,
    ).toBeUndefined();

    expect(run([
      "config",
      "project",
      "--project-dir",
      project,
      "--reset",
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".claude")).project)
      .toBeNull();
    expect(harnessData(project).plugins).toBeUndefined();
  }, 60_000);

  test("MCP checks use the selected harness surface", () => {
    const kiro = install("kiro", "defaults");
    const env = runtimeEnv();
    expect(run([
      "config",
      "project",
      "--project-dir",
      kiro,
      "--mcp",
      "defaults",
      "--yes",
    ], kiro, env).status).toBe(0);
    expect(run([
      "config",
      "project",
      "--project-dir",
      kiro,
      "--check",
    ], kiro, env).status).toBe(0);
    const kiroShow = JSON.parse(run([
      "config",
      "project",
      "--project-dir",
      kiro,
      "--show",
      "--json",
    ], kiro, env).stdout) as {
      data: {
        files: Array<{ file: string }>;
        mcpNote: string | null;
      };
    };
    expect(kiroShow.data.files.map((entry) => entry.file)).toContain(
      join(kiro, ".kiro", "settings", "mcp.json"),
    );
    expect(kiroShow.data.mcpNote).toBeNull();

    expect(run([
      "config",
      "project",
      "--project-dir",
      kiro,
      "--mcp",
      "none",
      "--yes",
    ], kiro, env).status).toBe(0);
    expect(run([
      "config",
      "project",
      "--project-dir",
      kiro,
      "--check",
    ], kiro, env).status).toBe(0);
    const kiroNone = JSON.parse(run([
      "config",
      "project",
      "--project-dir",
      kiro,
      "--show",
      "--json",
    ], kiro, env).stdout) as { data: { mcpNote: string } };
    expect(kiroNone.data.mcpNote).toContain("instruct-only preference");

    const codex = install("codex", "none");
    expect(run([
      "config",
      "project",
      "--project-dir",
      codex,
      "--mcp",
      "defaults",
      "--yes",
    ], codex, env).status).toBe(0);
    expect(run([
      "config",
      "project",
      "--project-dir",
      codex,
      "--check",
    ], codex, env).status).toBe(0);
    const codexShow = JSON.parse(run([
      "config",
      "project",
      "--project-dir",
      codex,
      "--show",
      "--json",
    ], codex, env).stdout) as { data: { mcpNote: string } };
    expect(codexShow.data.mcpNote).toContain("no shipped MCP surface");
  }, 60_000);

  test("plugin changes inherit the active workflow refresh refusal", () => {
    const project = install();
    const dirName = "active-plugin-selection";
    const intents = join(project, "aidlc", "spaces", "default", "intents");
    mkdirSync(join(intents, dirName), { recursive: true });
    writeFileSync(
      join(intents, "intents.json"),
      `${JSON.stringify([{
        uuid: "deadbeef-0000-4000-8000-000000000295",
        slug: "active-plugin-selection",
        dirName,
        scope: "feature",
        status: "in-flight",
      }], null, 2)}\n`,
    );
    writeFileSync(
      join(intents, dirName, "aidlc-state.md"),
      "# AI-DLC State Tracking\n\n## Current Status\n- **Status**: Running\n",
    );
    const result = run([
      "config",
      "project",
      "--project-dir",
      project,
      "--plugins",
      "aidlc",
      "--yes",
    ], project, runtimeEnv());
    expect(result.status).toBe(4);
    expect(result.stdout).toContain(
      "refusing to refresh while 1 workflow(s) are active",
    );
  }, 60_000);
});

describe("t295 invariants", () => {
  test("empty records preserve bytes and the config path imports no network API", () => {
    const project = temp("aidlc-t295-empty-");
    cpSync(join(DIST, "claude"), project, { recursive: true });
    const settings = readFileSync(join(project, ".claude", "settings.json"));
    applyConfigDiagnosticRecords(project, ".claude", "claude", {
      runtime: null,
      providers: null,
      trust: null,
      project: null,
    });
    expect(readFileSync(join(project, ".claude", "settings.json"))).toEqual(
      settings,
    );
    for (const file of [
      "core/tools/aidlc-init.ts",
      "core/tools/aidlc-config-diagnostics.ts",
    ]) {
      const source = readFileSync(join(REPO_ROOT, file), "utf-8");
      expect(source).not.toMatch(/from\s+["']node:(?:net|http|https|tls|dns)["']/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/\bsocket\s*\(/);
    }
  });
});
