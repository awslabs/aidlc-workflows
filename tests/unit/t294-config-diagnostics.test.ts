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
  codexTrustIssues,
  detectAwsCredentials,
  instructionFileDoctorCheck,
  normalizeProvidersRecord,
  postApplyOutstandingActions,
  probeHarnessCli,
  probeRuntime,
  providerDoctorCheck,
  providerFiles,
  providerIssues,
  readConfigDiagnosticRecords,
  reconcileProviderActions,
  runtimeDoctorChecks,
  runtimeIssues,
  trustStatus,
  workspaceSiblingDoctorCheck,
  workspaceSiblingIssues,
  type ConfigDiagnosticRecords,
  type ProvidersRecord,
} from "../../core/tools/aidlc-config-diagnostics.ts";
import { collectDoctorReport } from "../../core/tools/aidlc-utility.ts";

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

function install(harness: string): string {
  const project = temp(`aidlc-t294-${harness}-`);
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
    "defaults",
    "--yes",
  ], project);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return project;
}

function runtimeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AIDLC_RUNTIME_ROOT: DIST_RELEASE,
    AWS_ACCESS_KEY_ID: "test-access",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    ...extra,
  };
}

function writeExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function hookPathEnv(command?: "aidlc" | "bun"): NodeJS.ProcessEnv {
  const bin = temp("aidlc-t294-hook-path-");
  if (process.platform === "win32") {
    writeFileSync(
      join(bin, "powershell.cmd"),
      `@echo off\r\necho ${bin}\r\n`,
      "utf-8",
    );
  } else {
    writeFileSync(
      join(bin, "getconf"),
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(bin)}\n`,
      { mode: 0o755 },
    );
  }
  if (command) {
    if (process.platform === "win32") {
      writeFileSync(join(bin, `${command}.cmd`), "@exit /b 0\r\n", "utf-8");
    } else {
      for (const name of [command, `${command}.exe`, `${command}.cmd`]) {
        writeExecutable(join(bin, name));
      }
    }
  }
  return {
    PATH: bin,
    ...(process.platform === "win32" ? {} : { SystemRoot: "" }),
  };
}

function emptyRecords(providers: ProvidersRecord | null): ConfigDiagnosticRecords {
  return {
    runtime: null,
    providers,
    trust: null,
    project: null,
  };
}

describe("t294 config section dispatch", () => {
  test("all four config sections are addressable and unknown sections list all four", () => {
    for (const section of ["models", "runtime", "providers", "trust"]) {
      const result = run(["config", section, "--help"], REPO_ROOT);
      expect(result.status, section).toBe(0);
      expect(result.stdout, section).toContain(
        `bun .claude/tools/aidlc.ts config ${section}`,
      );
    }
    const project = temp("aidlc-t294-unknown-");
    mkdirSync(join(project, ".git"));
    const unknown = run([
      "config",
      "diagnostics",
      "--project-dir",
      project,
    ], project);
    expect(unknown.status).toBe(2);
    expect(unknown.stdout).toContain(
      "valid sections: models, runtime, providers, trust, flags, project",
    );
    expect(existsSync(join(project, ".claude"))).toBe(false);

    const trustRuntimeFlag = run([
      "config",
      "trust",
      "--record-paths",
      "--project-dir",
      project,
    ], project);
    expect(trustRuntimeFlag.status).toBe(2);
    expect(trustRuntimeFlag.stdout).toContain(
      "unknown trust option --record-paths",
    );

    const runtimeTrustFlag = run([
      "config",
      "runtime",
      "--acknowledge",
      "--project-dir",
      project,
    ], project);
    expect(runtimeTrustFlag.status).toBe(2);
    expect(runtimeTrustFlag.stdout).toContain(
      "unknown runtime option --acknowledge",
    );
  });
});

describe("t294 runtime diagnostics", () => {
  test("baseline, interactive-only, and absent PATH cases are hermetic", () => {
    const project = temp("aidlc-t294-runtime-probe-");
    const hooks = join(project, ".claude", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(project, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{
            hooks: [{
              command: "bun .claude/tools/aidlc.ts engine hook continue-workflow",
            }],
          }],
        },
      }),
    );
    const baselineBin = join(project, "baseline-bin");
    const interactiveBin = join(project, "interactive-bin");
    mkdirSync(baselineBin);
    mkdirSync(interactiveBin);
    writeExecutable(join(baselineBin, "bun"));
    writeExecutable(join(interactiveBin, "bun"));

    const found = probeRuntime(project, ".claude", "claude", {
      baselinePath: baselineBin,
      interactivePath: interactiveBin,
      which(command, pathValue) {
        const path = join(pathValue, command);
        return existsSync(path) ? path : null;
      },
      run: () => ({ status: 0, stdout: "2.0.0\n" }),
    });
    expect(found.binaries.find((item) => item.name === "bun"))
      .toEqual(expect.objectContaining({
        status: "found",
        baselinePath: join(baselineBin, "bun"),
      }));

    const interactiveOnly = probeRuntime(project, ".claude", "claude", {
      baselinePath: join(project, "empty"),
      interactivePath: interactiveBin,
      which(command, pathValue) {
        const path = join(pathValue, command);
        return existsSync(path) ? path : null;
      },
      run: () => ({ status: 0, stdout: "2.0.0\n" }),
    });
    expect(interactiveOnly.binaries.find((item) => item.name === "bun"))
      .toEqual(expect.objectContaining({
        status: "interactive-only",
        interactivePath: join(interactiveBin, "bun"),
      }));
    expect(runtimeIssues(interactiveOnly)[0].message).toContain(
      "resolves only through the interactive PATH",
    );

    const absent = probeRuntime(project, ".claude", "claude", {
      baselinePath: join(project, "empty"),
      interactivePath: join(project, "also-empty"),
      which: () => null,
      run: () => ({ status: 0, stdout: "2.0.0\n" }),
    });
    expect(absent.binaries.find((item) => item.name === "bun")?.status).toBe(
      "missing",
    );
  });

  test("harness CLI probes guard missing commands and enforce version floors", () => {
    const missingClaude = probeHarnessCli("claude", { which: () => null });
    expect(missingClaude).toEqual(expect.objectContaining({
      command: "claude",
      required: true,
      status: "missing",
    }));

    const oldCodex = probeHarnessCli("codex", {
      interactivePath: "/bin",
      which: () => "/bin/codex",
      run: () => ({ status: 0, stdout: "codex-cli 0.144.0\n" }),
    });
    expect(oldCodex).toEqual(expect.objectContaining({
      status: "too-old",
      minimumVersion: "0.145.0",
    }));

    const optionalCopilot = probeHarnessCli("copilot", { which: () => null });
    expect(optionalCopilot).toEqual(expect.objectContaining({
      required: false,
      status: "missing",
    }));

    expect(probeHarnessCli("kiro-ide")).toEqual(expect.objectContaining({
      required: false,
      status: "not-applicable",
    }));
  });
});

describe("t294 provider diagnostics", () => {
  test("offline AWS detection reads env, profiles, regions, and SSO cache only", () => {
    const home = temp("aidlc-t294-aws-home-");
    mkdirSync(join(home, ".aws", "sso", "cache"), { recursive: true });
    writeFileSync(
      join(home, ".aws", "config"),
      "[default]\nregion = us-east-1\n[profile dev]\nregion = eu-west-1\nsso_session = company\n",
    );
    writeFileSync(
      join(home, ".aws", "credentials"),
      "[default]\naws_access_key_id = file-key\naws_secret_access_key = file-secret\n",
    );
    writeFileSync(join(home, ".aws", "sso", "cache", "token.json"), "{}\n");
    const result = detectAwsCredentials({
      home,
      env: {
        AWS_PROFILE: "dev",
        AWS_REGION: "ap-southeast-2",
      },
    });
    expect(result.hasCredentials).toBe(true);
    expect(result.sources).toContain("environment profile dev");
    expect(result.sources).toContain("AWS SSO cache");
    expect(result.profiles).toEqual(["default", "dev"]);
    expect(result.regions).toEqual(["ap-southeast-2", "eu-west-1", "us-east-1"]);
  });

  test("shared provider writers apply only the selected harness surfaces", () => {
    const record = reconcileProviderActions({
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "eu-west-1",
      profile: "dev",
      opencodeDefault: true,
      pendingActions: [
        { id: "bedrock-model-access", status: "done" },
      ],
    }, "claude");

    const claude = temp("aidlc-t294-provider-claude-");
    cpSync(join(DIST, "claude"), claude, { recursive: true });
    applyConfigDiagnosticRecords(
      claude,
      ".claude",
      "claude",
      emptyRecords(record),
    );
    const settings = JSON.parse(
      readFileSync(join(claude, ".claude", "settings.json"), "utf-8"),
    ) as { env: Record<string, string> };
    expect(settings.env.AWS_REGION).toBe("eu-west-1");
    expect(settings.env.AWS_PROFILE).toBe("dev");
    const claudeMcp = readFileSync(join(claude, ".mcp.json"), "utf-8");
    expect(claudeMcp).toContain("https://aws-mcp.eu-west-1.api.aws/mcp");
    expect(claudeMcp).toContain("AWS_REGION=eu-west-1");

    const codex = temp("aidlc-t294-provider-codex-");
    cpSync(join(DIST, "codex"), codex, { recursive: true });
    const codexBefore = readFileSync(join(codex, ".codex", "config.toml"), "utf-8");
    applyConfigDiagnosticRecords(
      codex,
      ".codex",
      "codex",
      emptyRecords(record),
    );
    const codexAfter = readFileSync(join(codex, ".codex", "config.toml"), "utf-8");
    expect(codexAfter).toContain('profile = "dev"');
    expect(codexAfter).toContain('region = "eu-west-1"');
    expect(codexAfter.match(/^model\s*=.*$/m)?.[0]).toBe(
      codexBefore.match(/^model\s*=.*$/m)?.[0],
    );
    expect(codexAfter.match(/^model_reasoning_effort\s*=.*$/m)?.[0]).toBe(
      codexBefore.match(/^model_reasoning_effort\s*=.*$/m)?.[0],
    );

    const kiro = temp("aidlc-t294-provider-kiro-");
    cpSync(join(DIST, "kiro"), kiro, { recursive: true });
    applyConfigDiagnosticRecords(kiro, ".kiro", "kiro", emptyRecords(record));
    const kiroMcp = readFileSync(join(kiro, ".kiro", "settings", "mcp.json"), "utf-8");
    expect(kiroMcp).toContain("https://aws-mcp.eu-west-1.api.aws/mcp");
    expect(kiroMcp).toContain("AWS_REGION=eu-west-1");

    const opencode = temp("aidlc-t294-provider-opencode-");
    cpSync(join(DIST, "opencode"), opencode, { recursive: true });
    applyConfigDiagnosticRecords(
      opencode,
      ".aidlc",
      "opencode",
      emptyRecords(record),
    );
    const opencodeJson = JSON.parse(
      readFileSync(join(opencode, "opencode.json"), "utf-8"),
    ) as {
      provider: {
        "amazon-bedrock": { options: { region: string; profile: string } };
      };
    };
    expect(opencodeJson.provider["amazon-bedrock"].options).toEqual({
      region: "eu-west-1",
      profile: "dev",
    });

    const decline = temp("aidlc-t294-provider-opencode-decline-");
    cpSync(join(DIST, "opencode"), decline, { recursive: true });
    const before = readFileSync(join(decline, "opencode.json"), "utf-8");
    applyConfigDiagnosticRecords(
      decline,
      ".aidlc",
      "opencode",
      emptyRecords({ ...record, opencodeDefault: false }),
    );
    expect(readFileSync(join(decline, "opencode.json"), "utf-8")).toBe(before);

    for (const [harness, dir, file] of [
      ["kiro-ide", ".kiro", "tools/data/harness.json"],
      ["copilot", ".aidlc", "tools/data/harness.json"],
      ["cursor", ".cursor", "cli.json"],
    ] as const) {
      const root = temp(`aidlc-t294-provider-${harness}-`);
      cpSync(join(DIST, harness), root, { recursive: true });
      const path = join(root, dir, file);
      const original = readFileSync(path);
      applyConfigDiagnosticRecords(
        root,
        dir,
        harness,
        emptyRecords(record),
      );
      expect(readFileSync(path), harness).toEqual(original);
    }
  });

  test("pending actions drive check and doctor until marked done", () => {
    const project = temp("aidlc-t294-pending-");
    cpSync(join(DIST, "claude"), project, { recursive: true });
    let record = reconcileProviderActions({
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "us-east-1",
    }, "claude");
    const dataPath = join(project, ".claude", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(dataPath, "utf-8"));
    data.providers = record;
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    expect(providerDoctorCheck(project).pass).toBe(false);
    expect(
      providerIssues(
        project,
        ".claude",
        "claude",
        record,
        {
          hasCredentials: true,
          sources: ["fixture"],
          profiles: [],
          regions: [],
          files: [],
        },
      ).map((issue) => issue.id),
    ).toContain("bedrock-model-access");

    record = normalizeProvidersRecord({
      ...record,
      pendingActions: record.pendingActions?.map((action) => ({
        ...action,
        status: "done",
      })),
    }) as ProvidersRecord;
    data.providers = record;
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    expect(providerDoctorCheck(project).pass).toBe(true);
  });
});

describe("t294 trust diagnostics", () => {
  test("Codex detects complete and missing user trust without changing the seed", () => {
    const project = temp("aidlc-t294-trust-codex-");
    cpSync(join(DIST, "codex"), project, { recursive: true });
    const home = temp("aidlc-t294-codex-home-");
    const seed = readFileSync(
      join(project, ".codex", "trust-seed.toml"),
      "utf-8",
    );
    expect(codexTrustIssues(project, ".codex", {
      HOME: home,
      CODEX_HOME: home,
    })[0].id).toBe("codex-hook-trust-missing");

    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.toml"),
      seed.replaceAll("<PROJECT_DIR>", project.replaceAll("\\", "/")),
    );
    expect(codexTrustIssues(project, ".codex", {
      HOME: home,
      CODEX_HOME: home,
    })).toEqual([]);
    expect(readFileSync(join(project, ".codex", "trust-seed.toml"), "utf-8"))
      .toBe(seed);
  });

  test("Kiro IDE trustedCommands and required sibling directories are verified", () => {
    const project = temp("aidlc-t294-trust-kiro-ide-");
    cpSync(join(DIST, "kiro-ide"), project, { recursive: true });
    mkdirSync(join(project, ".vscode"), { recursive: true });
    writeFileSync(
      join(project, ".vscode", "settings.json"),
      `${JSON.stringify({
        "kiroAgent.trustedCommands": ["aidlc engine *"],
      }, null, 2)}\n`,
    );
    expect(trustStatus(project, ".kiro", "kiro-ide").issues).toEqual([]);
    writeFileSync(join(project, ".vscode", "settings.json"), "{}\n");
    expect(trustStatus(project, ".kiro", "kiro-ide").issues.map((item) => item.id))
      .toContain("kiro-ide-trusted-command-missing");

    const codex = temp("aidlc-t294-siblings-codex-");
    cpSync(join(DIST, "codex"), codex, { recursive: true });
    rmSync(join(codex, "aidlc"), { recursive: true, force: true });
    rmSync(join(codex, ".agents"), { recursive: true, force: true });
    expect(workspaceSiblingIssues(codex, "codex").map((item) => item.id))
      .toEqual([
        "workspace-root-missing",
        "codex-agents-sibling-missing",
      ]);
    expect(workspaceSiblingDoctorCheck(codex).pass).toBe(false);
  });

  test("doctor builders select the invoking harness in a dual-harness project", () => {
    const project = temp("aidlc-t294-doctor-dual-");
    mkdirSync(project, { recursive: true });
    cpSync(join(DIST, "claude"), project, { recursive: true });
    cpSync(join(DIST, "codex"), project, { recursive: true });

    const codexDataPath = join(
      project,
      ".codex",
      "tools",
      "data",
      "harness.json",
    );
    const codexData = JSON.parse(readFileSync(codexDataPath, "utf-8"));
    codexData.providers = {
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "us-east-1",
      pendingActions: [{
        id: "bedrock-model-access",
        status: "pending",
      }],
    };
    writeFileSync(codexDataPath, `${JSON.stringify(codexData, null, 2)}\n`);

    expect(providerDoctorCheck(project).pass).toBe(true);
    expect(providerDoctorCheck(project, ".codex").pass).toBe(false);

    rmSync(join(project, ".agents"), { recursive: true, force: true });
    expect(workspaceSiblingDoctorCheck(project).pass).toBe(true);
    expect(workspaceSiblingDoctorCheck(project, ".codex").pass).toBe(false);

    const defaultRuntime = runtimeDoctorChecks(project);
    expect(defaultRuntime.some((check) =>
      check.label.includes("Harness CLI: claude")
    )).toBe(true);
    const codexRuntime = runtimeDoctorChecks(project, ".codex");
    expect(codexRuntime.some((check) =>
      check.label.includes("Harness CLI: codex")
    )).toBe(true);
  });
});

describe("t294 post-apply outstanding actions", () => {
  test("plain config names missing hook runtime in human and JSON output", () => {
    const project = temp("aidlc-t294-post-runtime-");
    mkdirSync(join(project, ".git"));
    const env = hookPathEnv();
    const applied = run([
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
    ], project, env);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toContain("Outstanding actions:");
    expect(applied.stdout).toContain("aidlc is absent from the non-interactive hook PATH");
    expect(applied.stdout).toContain(
      "bun .claude/tools/aidlc.ts config runtime",
    );

    const json = run([
      "config",
      "--project-dir",
      project,
      "--from",
      join(DIST_RELEASE, "claude"),
      "--json",
      "--yes",
    ], project, env);
    expect(json.status, json.stdout + json.stderr).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      data: {
        outstandingActions: Array<{
          section: string;
          id: string;
          command: string;
        }>;
      };
    };
    expect(payload.data.outstandingActions).toContainEqual(expect.objectContaining({
      section: "runtime",
      id: "runtime-aidlc-missing",
      command: "bun .claude/tools/aidlc.ts config runtime",
    }));
  }, 60_000);

  test("Codex config names missing user trust without duplicating trust section output", () => {
    const project = temp("aidlc-t294-post-trust-");
    const home = temp("aidlc-t294-post-trust-home-");
    mkdirSync(join(project, ".git"));
    const env = {
      ...hookPathEnv("aidlc"),
      HOME: home,
      CODEX_HOME: home,
    };
    const applied = run([
      "config",
      "--project-dir",
      project,
      "--from",
      join(DIST_RELEASE, "codex"),
      "--harness",
      "codex",
      "--yes",
    ], project, env);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toContain("codex-hook-trust-missing");
    expect(applied.stdout).toContain(
      "bun .codex/tools/aidlc.ts config trust",
    );

    const trustSection = run([
      "config",
      "trust",
      "--project-dir",
      project,
      "--reset",
      "--yes",
    ], project, env);
    expect(trustSection.status, trustSection.stdout + trustSection.stderr).toBe(0);
    expect(trustSection.stdout).not.toContain("aidlc config trust");
  }, 60_000);

  test("provider pending actions appear after plain refresh and healthy quiet stays one line", () => {
    const project = temp("aidlc-t294-post-provider-");
    mkdirSync(join(project, ".git"));
    const env = {
      ...runtimeEnv(),
      ...hookPathEnv("aidlc"),
    };
    expect(run([
      "config",
      "--project-dir",
      project,
      "--from",
      join(DIST_RELEASE, "claude"),
      "--harness",
      "claude",
      "--mcp",
      "none",
      "--quiet",
      "--yes",
    ], project, env).stdout.trim().split("\n")).toHaveLength(1);

    const providerSection = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-east-1",
      "--yes",
    ], project, env);
    expect(providerSection.status, providerSection.stdout + providerSection.stderr).toBe(0);
    expect(providerSection.stdout).not.toContain("aidlc config providers --check");

    const refreshed = run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, env);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    expect(refreshed.stdout).toContain("bedrock-model-access");
    expect(refreshed.stdout).toContain(
      "bun .claude/tools/aidlc.ts config providers --check",
    );

    const actions = postApplyOutstandingActions(
      project,
      ".claude",
      "claude",
      {
        skipSections: ["runtime", "trust"],
        runtime: {
          baselinePath: "/unused",
          interactivePath: "/unused",
          which: () => null,
        },
      },
    );
    expect(actions.map((action) => action.section)).toEqual(["providers"]);
  }, 60_000);
});

describe("t294 instruction-file doctor row", () => {
  test("marker-managed instruction block reports intact, missing, and modified", async () => {
    const project = install("kiro");
    const path = join(project, "AGENTS.md");
    const original = readFileSync(path, "utf-8");
    const intact = instructionFileDoctorCheck(project, ".kiro");
    expect(intact.pass).toBe(true);
    expect(intact.label).toContain("block present, user content preserved");
    const report = await collectDoctorReport(project);
    expect(report.checks.some((check) =>
      check.label.includes("block present, user content preserved")
    )).toBe(true);

    rmSync(path);
    const missing = instructionFileDoctorCheck(project, ".kiro");
    expect(missing.pass).toBe(false);
    expect(missing.severity).toBe("warn");
    expect(missing.label).toContain("block or file missing (AGENTS.md)");
    expect(missing.fix).toContain("bun .kiro/tools/aidlc.ts config");

    writeFileSync(
      path,
      original.replace(
        "<!-- END AI-DLC:agents -->",
        "local managed edit\n<!-- END AI-DLC:agents -->",
      ),
    );
    const modified = instructionFileDoctorCheck(project, ".kiro");
    expect(modified.pass).toBe(false);
    expect(modified.severity).toBe("warn");
    expect(modified.label).toContain("hand-modified - conflict");
  }, 60_000);

  test("whole-file instruction surface reports intact, missing, and modified", () => {
    const project = install("opencode");
    const path = join(project, "opencode.json");
    const original = readFileSync(path, "utf-8");
    const intact = instructionFileDoctorCheck(project, ".aidlc");
    expect(intact.pass).toBe(true);
    expect(intact.label).toContain("framework-owned file intact");

    rmSync(path);
    const missing = instructionFileDoctorCheck(project, ".aidlc");
    expect(missing.label).toContain("block or file missing (opencode.json)");
    expect(missing.fix).toContain("bun .aidlc/tools/aidlc.ts config");

    writeFileSync(path, original.replace('"permission"', '"localSetting": true,\n  "permission"'));
    expect(instructionFileDoctorCheck(project, ".aidlc").label)
      .toContain("hand-modified - conflict");
  }, 60_000);

  test("instruction row selects the invoking harness in a dual-harness project", () => {
    const project = install("claude");
    const codex = install("codex");
    cpSync(join(codex, ".codex"), join(project, ".codex"), { recursive: true });
    cpSync(join(codex, ".agents"), join(project, ".agents"), { recursive: true });
    cpSync(join(codex, "AGENTS.md"), join(project, "AGENTS.md"));
    expect(instructionFileDoctorCheck(project, ".claude").pass).toBe(true);
    expect(instructionFileDoctorCheck(project, ".codex").pass).toBe(true);
    rmSync(join(project, "AGENTS.md"));
    expect(instructionFileDoctorCheck(project, ".claude").pass).toBe(true);
    expect(instructionFileDoctorCheck(project, ".codex").pass).toBe(false);
  }, 60_000);
});

describe("t294 config diagnostics CLI", () => {
  test("providers show, JSON, pending lifecycle, refresh survival, opt-out, and reset", () => {
    const project = install("claude");
    const env = runtimeEnv();
    const unanswered = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--yes",
    ], project, env);
    expect(unanswered.status).toBe(2);
    expect(unanswered.stdout).toContain("requires --region");

    const applied = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--region",
      "eu-west-1",
      "--profile",
      "dev",
      "--yes",
    ], project, env);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf-8"))
      .toContain('"AWS_REGION": "eu-west-1"');
    expect(readFileSync(join(project, ".mcp.json"), "utf-8"))
      .toContain("https://aws-mcp.eu-west-1.api.aws/mcp");

    const pending = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env);
    expect(pending.status).toBe(1);
    expect(pending.stdout).toContain("bedrock-model-access");

    const shown = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--show",
      "--json",
    ], project, env);
    const payload = JSON.parse(shown.stdout) as {
      data: {
        files: Array<{ setting: string; file: string }>;
        pendingActions: Array<{ id: string }>;
      };
    };
    expect(payload.data.files.map((entry) => entry.file)).toContain(
      join(project, ".claude", "settings.json"),
    );
    expect(payload.data.files.map((entry) => entry.file)).toContain(
      join(project, ".mcp.json"),
    );
    expect(payload.data.pendingActions.map((entry) => entry.id))
      .toContain("bedrock-model-access");

    const completed = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--mark-done",
      "bedrock-model-access",
      "--yes",
    ], project, env);
    expect(completed.status, completed.stdout + completed.stderr).toBe(0);
    expect(run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env).status).toBe(0);

    expect(run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, env).status).toBe(0);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf-8"))
      .toContain('"AWS_REGION": "eu-west-1"');

    const reset = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--reset",
      "--yes",
    ], project, env);
    expect(reset.status, reset.stdout + reset.stderr).toBe(0);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf-8"))
      .toContain('"AWS_REGION": "us-east-1"');
    expect(readConfigDiagnosticRecords(join(project, ".claude")).providers)
      .toBeNull();

    const optOut = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "other",
      "--acknowledge",
      "--yes",
    ], project, env);
    expect(optOut.status, optOut.stdout + optOut.stderr).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".claude")).providers)
      .toEqual(expect.objectContaining({
        provider: "other",
        acknowledged: true,
      }));
  }, 60_000);

  test("OpenCode offer decline and acceptance are recorded and applied", () => {
    const project = install("opencode");
    const env = runtimeEnv();
    const declined = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-west-2",
      "--opencode-default",
      "no",
      "--yes",
    ], project, env);
    expect(declined.status, declined.stdout + declined.stderr).toBe(0);
    expect(readFileSync(join(project, "opencode.json"), "utf-8")).not.toContain(
      '"provider"',
    );
    expect(readConfigDiagnosticRecords(join(project, ".aidlc")).providers)
      .toEqual(expect.objectContaining({ opencodeDefault: false }));

    expect(run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-west-2",
      "--profile",
      "dev",
      "--opencode-default",
      "yes",
      "--yes",
    ], project, env).status).toBe(0);
    const config = JSON.parse(readFileSync(join(project, "opencode.json"), "utf-8"));
    expect(config.provider["amazon-bedrock"].options).toEqual({
      region: "us-west-2",
      profile: "dev",
    });
  }, 60_000);

  test("OpenCode-only provider flags are rejected for other harnesses", () => {
    const project = install("claude");
    const result = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-west-2",
      "--opencode-default",
      "yes",
      "--yes",
    ], project, runtimeEnv());
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      "--opencode-default is only valid for the opencode harness",
    );
    expect(readConfigDiagnosticRecords(join(project, ".claude")).providers).toBeNull();
  }, 60_000);

  test("runtime and trust enforce non-TTY judgment, --yes semantics, show, and reset", () => {
    const project = install("claude");
    const env = runtimeEnv();
    const runtimeNoChoice = run([
      "config",
      "runtime",
      "--project-dir",
      project,
      "--yes",
    ], project, env);
    expect(runtimeNoChoice.status).toBe(2);
    expect(runtimeNoChoice.stdout).toContain("--yes confirms but never chooses");

    const runtimeShow = run([
      "config",
      "runtime",
      "--project-dir",
      project,
      "--show",
      "--json",
    ], project, env);
    expect(runtimeShow.status).toBe(0);
    const runtimePayload = JSON.parse(runtimeShow.stdout) as {
      data: {
        diagnostics: { baselinePath: string; commandFiles: string[] };
        files: string[];
      };
    };
    expect(runtimePayload.data.diagnostics.baselinePath).toBeString();
    expect(runtimePayload.data.files.length).toBeGreaterThan(0);
    const runtimeFiles = runtimePayload.data.diagnostics.commandFiles;
    expect(runtimeFiles.length).toBeGreaterThan(8);
    const runtimeHuman = run([
      "config",
      "runtime",
      "--project-dir",
      project,
      "--show",
    ], project, env);
    expect(runtimeHuman.status).toBe(0);
    for (const file of runtimeFiles.slice(0, 5)) {
      expect(runtimeHuman.stdout).toContain(file);
    }
    expect(runtimeHuman.stdout).not.toContain(runtimeFiles[5]);
    expect(runtimeHuman.stdout).toContain(
      `... and ${runtimeFiles.length - 5} more ` +
        "(aidlc config runtime --show --json lists all)",
    );

    const dataPath = join(project, ".claude", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(dataPath, "utf-8"));
    data.runtime = {
      schemaVersion: 1,
      baselinePath: "/usr/bin:/bin",
      bunPath: "/usr/bin/bun",
    };
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    expect(run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, env).status).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".claude")).runtime)
      .toEqual(expect.objectContaining({
        baselinePath: "/usr/bin:/bin",
        bunPath: "/usr/bin/bun",
      }));
    expect(run([
      "config",
      "runtime",
      "--project-dir",
      project,
      "--reset",
      "--yes",
    ], project, env).status).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".claude")).runtime)
      .toBeNull();

    const trustNoConfirm = run([
      "config",
      "trust",
      "--project-dir",
      project,
      "--acknowledge",
    ], project, env);
    expect(trustNoConfirm.status).toBe(2);
    expect(trustNoConfirm.stdout).toContain("requires --yes");

    expect(run([
      "config",
      "trust",
      "--project-dir",
      project,
      "--acknowledge",
      "--yes",
    ], project, env).status).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".claude")).trust)
      .toEqual({ schemaVersion: 1, reviewed: true });
    expect(run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, env).status).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".claude")).trust)
      .toEqual({ schemaVersion: 1, reviewed: true });
    const trustShow = run([
      "config",
      "trust",
      "--project-dir",
      project,
      "--show",
    ], project, env);
    expect(trustShow.status).toBe(0);
    expect(trustShow.stdout).toContain("Trust and allowlist files");
    expect(trustShow.stdout.replaceAll("\\", "/")).toContain(".claude/settings.json");
    expect(run([
      "config",
      "trust",
      "--project-dir",
      project,
      "--check",
    ], project, env).status).toBe(0);

    expect(run([
      "config",
      "trust",
      "--project-dir",
      project,
      "--reset",
      "--yes",
    ], project, env).status).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".claude")).trust)
      .toBeNull();
  }, 60_000);

  test("trust human show compacts its unbounded file list while JSON stays complete", () => {
    const project = install("kiro");
    const json = run([
      "config",
      "trust",
      "--project-dir",
      project,
      "--show",
      "--json",
    ], project, runtimeEnv());
    expect(json.status, json.stdout + json.stderr).toBe(0);
    const files = (JSON.parse(json.stdout) as { data: { files: string[] } })
      .data.files;
    expect(files.length).toBeGreaterThan(8);

    const human = run([
      "config",
      "trust",
      "--project-dir",
      project,
      "--show",
    ], project, runtimeEnv());
    expect(human.status, human.stdout + human.stderr).toBe(0);
    for (const file of files.slice(0, 5)) expect(human.stdout).toContain(file);
    expect(human.stdout).not.toContain(files[5]);
    expect(human.stdout).toContain(
      `... and ${files.length - 5} more ` +
        "(aidlc config trust --show --json lists all)",
    );
  }, 60_000);

  test("instruct-only harnesses record acknowledgements and named pending actions", () => {
    const pendingCopilot = install("copilot");
    const env = runtimeEnv();
    const pendingApplied = run([
      "config",
      "providers",
      "--project-dir",
      pendingCopilot,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-east-1",
      "--mark-done",
      "bedrock-model-access",
      "--yes",
    ], pendingCopilot, env);
    expect(
      pendingApplied.status,
      pendingApplied.stdout + pendingApplied.stderr,
    ).toBe(0);
    let pendingRecord = readConfigDiagnosticRecords(
      join(pendingCopilot, ".aidlc"),
    ).providers as ProvidersRecord;
    expect(pendingRecord.acknowledged).not.toBe(true);
    expect(pendingRecord.pendingActions).toContainEqual({
      id: "copilot-byok-configuration",
      status: "pending",
    });
    const pendingCheck = run([
      "config",
      "providers",
      "--project-dir",
      pendingCopilot,
      "--check",
    ], pendingCopilot, env);
    expect(pendingCheck.status).toBe(1);
    expect(pendingCheck.stdout).toContain("copilot-byok-configuration");
    const pendingShow = run([
      "config",
      "providers",
      "--project-dir",
      pendingCopilot,
      "--show",
    ], pendingCopilot, env);
    expect(pendingShow.stdout).toContain("copilot-byok-configuration");

    expect(run([
      "config",
      "providers",
      "--project-dir",
      pendingCopilot,
      "--acknowledge",
      "--yes",
    ], pendingCopilot, env).status).toBe(0);
    pendingRecord = readConfigDiagnosticRecords(
      join(pendingCopilot, ".aidlc"),
    ).providers as ProvidersRecord;
    expect(pendingRecord.pendingActions).toContainEqual({
      id: "copilot-byok-configuration",
      status: "done",
    });
    expect(run([
      "config",
      "providers",
      "--project-dir",
      pendingCopilot,
      "--check",
    ], pendingCopilot, env).status).toBe(0);

    const copilot = install("copilot");
    const applied = run([
      "config",
      "providers",
      "--project-dir",
      copilot,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-east-1",
      "--acknowledge",
      "--yes",
    ], copilot, env);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    const copilotRecord = readConfigDiagnosticRecords(
      join(copilot, ".aidlc"),
    ).providers as ProvidersRecord;
    expect(copilotRecord.acknowledged).toBe(true);
    expect(copilotRecord.pendingActions).toContainEqual({
      id: "copilot-byok-configuration",
      status: "done",
    });
    expect(copilotRecord.pendingActions).toContainEqual({
      id: "bedrock-model-access",
      status: "pending",
    });

    const ide = install("kiro-ide");
    expect(run([
      "config",
      "providers",
      "--project-dir",
      ide,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-east-1",
      "--yes",
    ], ide, env).status).toBe(0);
    const ideRecord = readConfigDiagnosticRecords(
      join(ide, ".kiro"),
    ).providers as ProvidersRecord;
    expect(ideRecord.pendingActions).toContainEqual({
      id: "kiro-ide-chat-model",
      status: "pending",
    });

    const cursor = install("cursor");
    const missingOtherAck = run([
      "config",
      "providers",
      "--project-dir",
      cursor,
      "--provider",
      "other",
      "--yes",
    ], cursor, env);
    expect(missingOtherAck.status).toBe(2);
    expect(missingOtherAck.stdout).toContain("pass --acknowledge");
    const cursorApplied = run([
      "config",
      "providers",
      "--project-dir",
      cursor,
      "--provider",
      "other",
      "--acknowledge",
      "--yes",
    ], cursor, env);
    expect(cursorApplied.status, cursorApplied.stdout + cursorApplied.stderr).toBe(0);
    expect(readConfigDiagnosticRecords(join(cursor, ".cursor")).providers)
      .toEqual(expect.objectContaining({
        provider: "other",
        acknowledged: true,
      }));
  }, 60_000);
});

describe("t294 invariants", () => {
  test("empty diagnostic records are byte-identical and the module imports no network API", () => {
    const project = temp("aidlc-t294-empty-");
    cpSync(join(DIST, "claude"), project, { recursive: true });
    const beforeSettings = readFileSync(join(project, ".claude", "settings.json"));
    const beforeMcp = readFileSync(join(project, ".mcp.json"));
    applyConfigDiagnosticRecords(project, ".claude", "claude", {
      runtime: null,
      providers: null,
      trust: null,
      project: null,
    });
    expect(readFileSync(join(project, ".claude", "settings.json"))).toEqual(
      beforeSettings,
    );
    expect(readFileSync(join(project, ".mcp.json"))).toEqual(beforeMcp);

    const source = readFileSync(
      join(REPO_ROOT, "core", "tools", "aidlc-config-diagnostics.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/from\s+["']node:(?:net|http|https|tls|dns)["']/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bsocket\s*\(/);
  });

  test("provider traceability lists every file carrying the Claude region", () => {
    const project = temp("aidlc-t294-files-");
    cpSync(join(DIST, "claude"), project, { recursive: true });
    const files = providerFiles(project, ".claude", "claude", {
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "us-east-1",
    });
    expect(files).toEqual(expect.arrayContaining([
      {
        setting: "AWS region and profile",
        file: join(project, ".claude", "settings.json"),
      },
      {
        setting: "AWS MCP region endpoint and metadata",
        file: join(project, ".mcp.json"),
      },
    ]));
  });
});
