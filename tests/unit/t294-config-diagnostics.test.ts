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
  deriveNonInteractivePath,
  detectAwsCredentials,
  harnessOwnsModelAccess,
  instructionFileDoctorCheck,
  normalizeProvidersRecord,
  postApplyOutstandingActions,
  preserveKiroMcpRegion,
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
  // Keep the host's active runtime out of fixture source selection.
  const machine = temp("aidlc-t294-machine-");
  const result = spawnSync(BUN, [INIT, ...args], {
    cwd,
    env: {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
      ...env,
    },
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
    // Host active-version runtimes must not join this fixture's source discovery.
    AIDLC_INSTALL_ROOT: temp("aidlc-t294-runtime-machine-"),
    AWS_ACCESS_KEY_ID: "test-access",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    ...extra,
  };
}

// Rewrites both aws-mcp region arguments of a Kiro CLI mcp.json text. Built from
// regex literals and templates rather than quoted endpoint strings, which the
// repository's secret scanner otherwise reads as an API key assignment.
function withMcpRegion(text: string, region: string): string {
  return text
    .replaceAll(/aws-mcp\.[a-z0-9-]+\.api\.aws/g, `aws-mcp.${region}.api.aws`)
    .replaceAll(/AWS_REGION=[a-z0-9-]+/g, `AWS_REGION=${region}`);
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

  // getconf PATH is glibc's compile-time _CS_PATH (/bin:/usr/bin on the Debian
  // family), so a Linux baseline built from it alone can never contain the
  // directories the remediation tells the user to add. The login-independent
  // sources are pam_env's /etc/environment, login.defs ENV_PATH, and
  // environment.d; the probe reads them under the injected systemRoot.
  test("Linux baseline PATH includes /etc/environment, login.defs, and environment.d entries", () => {
    const root = temp("aidlc-t294-system-root-");
    const home = temp("aidlc-t294-system-home-");
    mkdirSync(join(root, "etc", "environment.d"), { recursive: true });
    mkdirSync(join(home, ".config", "environment.d"), { recursive: true });
    writeFileSync(
      join(root, "etc", "environment"),
      'PATH="/usr/local/bin:/opt/from-environment/bin" # site\nLANG=C.UTF-8\n',
    );
    writeFileSync(
      join(root, "etc", "login.defs"),
      "# comment\nENV_SUPATH\tPATH=/usr/local/sbin:/sbin\nENV_PATH\tPATH=/usr/bin:/opt/from-login-defs/bin\nENV_PATH /opt/bare/bin:/usr/bin\n",
    );
    writeFileSync(
      join(root, "etc", "environment.d", "50-site.conf"),
      [
        "PATH=$PATH:/opt/from-environment-d/bin\nPATH=/opt/foo/bin$",
        "{PATH:+:$PATH}\nTOOLCHAIN=gcc\nPATH=/opt/$TOOLCHAIN/bin:$PATH\nPATH=/opt/x$",
        "{PATH}\nPATH=$",
        "{PATH:+$PATH:}/opt/lead/bin\n",
      ].join(""),
    );
    writeFileSync(
      join(home, ".config", "environment.d", "10-user.conf"),
      [
        "PATH=$",
        "{PATH}:/opt/from-user-environment-d/bin\nPATH=$HOME/.local/bin:$PATH\nPATH=$",
        "{HOME}/bin\nEDITOR=vi\n",
      ].join(""),
    );
    const baseline = deriveNonInteractivePath({
      platform: "linux",
      systemRoot: root,
      home,
      env: {},
      run: () => ({ status: 0, stdout: "/bin:/usr/bin\n" }),
    });
    const entries = baseline.split(":");
    expect(entries.slice(0, 2)).toEqual(["/bin", "/usr/bin"]);
    expect(entries).toEqual(expect.arrayContaining([
      "/usr/local/bin",
      "/opt/from-environment/bin",
      "/opt/from-login-defs/bin",
      "/opt/bare/bin",
      "/opt/from-environment-d/bin",
      "/opt/from-user-environment-d/bin",
      "/opt/foo/bin",
      "/opt/lead/bin",
      join(home, ".local", "bin"),
      join(home, "bin"),
    ]));
    // ENV_SUPATH is root's path, not a login-independent user PATH; $PATH
    // references, expression fragments, quotes, and comments never survive as entries.
    expect(entries).not.toContain("/sbin");
    expect(entries.filter((entry) =>
      /["#${}]/.test(entry)
      || entry === "+"
      || entry === "/opt//bin"
      || entry === "/opt/bin"
      || entry === "/opt/x"
    )).toEqual([]);
    expect(new Set(entries).size).toBe(entries.length);

    // Without those sources the same layout is invisible to the baseline.
    const bare = deriveNonInteractivePath({
      platform: "linux",
      systemRoot: temp("aidlc-t294-system-root-empty-"),
      home: temp("aidlc-t294-system-home-empty-"),
      env: {},
      run: () => ({ status: 0, stdout: "/bin:/usr/bin\n" }),
    });
    expect(bare).toBe("/bin:/usr/bin");
  });

  test("Linux runtime probe resolves aidlc from /etc/environment and user environment.d", () => {
    const project = temp("aidlc-t294-system-root-project-");
    mkdirSync(join(project, ".claude"));
    writeFileSync(
      join(project, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "aidlc engine hook continue-workflow" }] }],
        },
      }),
    );
    const interactiveBin = join(project, "interactive-bin");
    mkdirSync(interactiveBin);
    writeExecutable(join(interactiveBin, "aidlc"));
    const siteBin = join(project, "site-bin");
    mkdirSync(siteBin);
    writeExecutable(join(siteBin, "aidlc"));
    const systemRoot = temp("aidlc-t294-system-root-site-");
    const home = temp("aidlc-t294-system-home-probe-");
    mkdirSync(join(systemRoot, "etc"), { recursive: true });
    writeFileSync(join(systemRoot, "etc", "environment"), `PATH="${siteBin}" # site\n`);
    const options = {
      platform: "linux" as const,
      systemRoot,
      home,
      env: { PATH: interactiveBin },
      includeHarnessCli: false,
      run: () => ({ status: 0, stdout: "/bin:/usr/bin\n" }),
    };
    const site = probeRuntime(project, ".claude", "claude", options);

    const emptyRoot = temp("aidlc-t294-system-root-bare-");
    mkdirSync(join(home, ".config", "environment.d"), { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(
      join(home, ".config", "environment.d", "10-user.conf"),
      "PATH=$HOME/.local/bin:$PATH\n",
    );
    writeExecutable(join(home, ".local", "bin", "aidlc"));
    const user = probeRuntime(project, ".claude", "claude", {
      ...options,
      systemRoot: emptyRoot,
    });
    expect({
      site: site.binaries.find((item) => item.name === "aidlc"),
      user: user.binaries.find((item) => item.name === "aidlc"),
      siteIssues: runtimeIssues(site),
      userIssues: runtimeIssues(user),
    }).toEqual({
      site: expect.objectContaining({
        status: "found",
        baselinePath: join(siteBin, "aidlc"),
      }),
      user: expect.objectContaining({
        status: "found",
        baselinePath: join(home, ".local", "bin", "aidlc"),
      }),
      siteIssues: [],
      userIssues: [],
    });

    // The executable alone does not make a directory login-independent.
    rmSync(join(home, ".config"), { recursive: true });
    const bare = probeRuntime(project, ".claude", "claude", {
      ...options,
      systemRoot: emptyRoot,
      env: { PATH: join(home, ".local", "bin") },
    });
    expect(bare.baselinePath).toBe("/bin:/usr/bin");
    expect(bare.binaries.find((item) => item.name === "aidlc")?.status).toBe(
      "interactive-only",
    );

    // Blanking an unresolved variable must not expose an unrelated executable.
    const unresolvedHome = temp("aidlc-t294-system-home-unresolved-");
    const toolchainRoot = temp("aidlc-t294-toolchain-");
    mkdirSync(join(toolchainRoot, "bin"));
    writeExecutable(join(toolchainRoot, "bin", "aidlc"));
    mkdirSync(join(unresolvedHome, ".config", "environment.d"), { recursive: true });
    writeFileSync(
      join(unresolvedHome, ".config", "environment.d", "10-user.conf"),
      `TOOLCHAIN=gcc\nPATH=${toolchainRoot}/$TOOLCHAIN/bin:$PATH\n`,
    );
    const unresolved = probeRuntime(project, ".claude", "claude", {
      ...options,
      systemRoot: temp("aidlc-t294-system-root-unresolved-"),
      home: unresolvedHome,
    });
    expect({
      status: unresolved.binaries.find((item) => item.name === "aidlc")?.status,
      toolchainEntries: unresolved.baselinePath.split(":").filter((entry) =>
        entry.startsWith(toolchainRoot)
      ),
    }).toEqual({
      status: "interactive-only",
      toolchainEntries: [],
    });
  });

  test("runtime remediation names only the PATH surfaces the platform probe reads", () => {
    const project = temp("aidlc-t294-runtime-remediation-");
    mkdirSync(join(project, ".claude"));
    const settings = join(project, ".claude", "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "aidlc engine hook continue-workflow" }] }],
        },
      }),
    );
    const baselineBin = join(project, "baseline-bin");
    const interactiveBin = join(project, "interactive-bin");
    mkdirSync(baselineBin);
    mkdirSync(interactiveBin);
    writeExecutable(join(interactiveBin, "aidlc"));
    const options = {
      baselinePath: baselineBin,
      interactivePath: interactiveBin,
      includeHarnessCli: false,
      run: () => ({ status: 0, stdout: "/bin:/usr/bin\n" }),
    };
    const darwin = probeRuntime(project, ".claude", "claude", {
      ...options,
      platform: "darwin",
    });
    const linux = probeRuntime(project, ".claude", "claude", {
      ...options,
      platform: "linux",
    });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{
            hooks: [{ command: "bun .claude/tools/aidlc.ts engine hook continue-workflow" }],
          }],
        },
      }),
    );
    writeExecutable(join(interactiveBin, "bun"));
    const bun = probeRuntime(project, ".claude", "claude", {
      ...options,
      platform: "linux",
    });
    expect({
      darwin: runtimeIssues(darwin)[0].remediation,
      linux: runtimeIssues(linux)[0].remediation,
      bun: runtimeIssues(bun)[0].remediation,
    }).toEqual({
      darwin: expect.stringMatching(/^(?!.*\/etc\/environment).*\/etc\/paths\.d/),
      linux: expect.stringMatching(/\/etc\/environment.*\/etc\/login\.defs.*environment\.d/),
      bun: expect.stringMatching(
        /^This project is a copy-channel projection, so its hooks run through Bun; a native install runs them through the aidlc command instead\. .*\/etc\/environment/,
      ),
    });
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

    // Owned harnesses: no record writes anything, Kiro CLI included. The aws-mcp
    // region there is carried from the project's own file during staging, and a
    // record's region never reaches it, even when the file says something else.
    for (const [harness, dir, file] of [
      ["kiro", ".kiro", "settings/mcp.json"],
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

    // Staging preservation: the project's aws-mcp endpoint and metadata replace
    // the release values in the staged copy, argument by argument, and a project
    // without that entry leaves the staged bytes alone.
    const kiroProject = temp("aidlc-t294-kiro-mcp-project-");
    cpSync(join(DIST, "kiro"), kiroProject, { recursive: true });
    const projectMcpPath = join(kiroProject, ".kiro", "settings", "mcp.json");
    writeFileSync(projectMcpPath, withMcpRegion(readFileSync(projectMcpPath, "utf-8"), "ap-southeast-2"));
    const kiroStaged = temp("aidlc-t294-kiro-mcp-staged-");
    cpSync(join(DIST, "kiro"), kiroStaged, { recursive: true });
    preserveKiroMcpRegion(kiroProject, kiroStaged, ".kiro");
    const stagedMcp = readFileSync(join(kiroStaged, ".kiro", "settings", "mcp.json"), "utf-8");
    expect(stagedMcp).toContain("https://aws-mcp.ap-southeast-2.api.aws/mcp");
    expect(stagedMcp).toContain("AWS_REGION=ap-southeast-2");
    expect(stagedMcp).not.toContain("us-east-1");
    expect(stagedMcp).toBe(readFileSync(projectMcpPath, "utf-8"));
    const emptyProject = temp("aidlc-t294-kiro-mcp-empty-");
    mkdirSync(join(emptyProject, ".kiro", "settings"), { recursive: true });
    writeFileSync(join(emptyProject, ".kiro", "settings", "mcp.json"), "{}\n");
    const untouched = temp("aidlc-t294-kiro-mcp-untouched-");
    cpSync(join(DIST, "kiro"), untouched, { recursive: true });
    const before2 = readFileSync(join(untouched, ".kiro", "settings", "mcp.json"), "utf-8");
    preserveKiroMcpRegion(emptyProject, untouched, ".kiro");
    expect(readFileSync(join(untouched, ".kiro", "settings", "mcp.json"), "utf-8")).toBe(before2);
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

  test("provider flags refuse builtin and harness-owned access without writing", () => {
    const env = runtimeEnv();
    for (const [harness, flags, message] of [
      [
        "claude",
        ["--provider", "builtin"],
        "--provider builtin is no longer recorded; a harness that provides its own model access needs no answer",
      ],
      [
        "kiro",
        ["--provider", "amazon-bedrock", "--region", "us-west-2"],
        "kiro provides its own model access; there is no provider answer to record. Use --reset to clear a legacy record.",
      ],
    ] as const) {
      const project = install(harness);
      const snapshot = () => Object.fromEntries(Array.from(
        new Bun.Glob("**/*").scanSync({ cwd: project, dot: true, onlyFiles: true }),
        (file) => [file, readFileSync(join(project, file))],
      ));
      const before = snapshot();
      const result = run([
        "config", "providers", "--project-dir", project, ...flags, "--yes",
      ], project, env);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(message);
      expect(snapshot()).toEqual(before);
    }
  }, 90_000);

  test("a legacy Kiro record with pending actions reads as harness-managed everywhere", () => {
    const project = install("kiro-ide");
    const env = runtimeEnv();
    const record: ProvidersRecord = {
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "us-west-2",
      pendingActions: [
        { id: "bedrock-model-access", status: "pending" },
        { id: "kiro-ide-chat-model", status: "pending" },
      ],
    };
    const dataPath = join(project, ".kiro", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(dataPath, "utf-8"));
    data.providers = record;
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    expect(readConfigDiagnosticRecords(join(project, ".kiro")).providers).toEqual(record);

    const args = ["config", "providers", "--project-dir", project];
    const show = run([...args, "--show"], project, env);
    expect(show.status, show.stdout + show.stderr).toBe(0);
    expect(show.stdout).toContain(
      "Model access: comes with Kiro IDE; AI-DLC configures no model provider",
    );
    expect(show.stdout).toContain("Legacy provider answer present and ignored;");
    expect(show.stdout).toContain("config providers --reset");
    expect(show.stdout).not.toContain("Offline credentials:");
    expect(show.stdout).not.toContain("Pending:");

    const json = run([...args, "--show", "--json"], project, env);
    expect(json.status, json.stdout + json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).data).toEqual(expect.objectContaining({
      harnessManaged: true,
      pendingActions: [],
      issues: [],
      files: [{
        setting: "provider answers and pending actions",
        file: join(".kiro", "tools", "data", "harness.json"),
      }],
    }));
    const check = run([...args, "--check"], project, env);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toContain(
      "providers needs no answer for kiro-ide; its model access is harness-managed",
    );
    expect(postApplyOutstandingActions(project, ".kiro", "kiro-ide", {
      skipSections: ["runtime", "trust"],
    }).filter((action) => action.section === "providers")).toEqual([]);
    expect(providerDoctorCheck(project, ".kiro")).toEqual(expect.objectContaining({
      pass: true,
      label: "Providers: harness-managed model access; no answer needed",
    }));

    const reset = run([...args, "--reset", "--yes"], project, env);
    expect(reset.status, reset.stdout + reset.stderr).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".kiro")).providers).toBeNull();

    // Kiro CLI, with every AWS credential source detectAwsCredentials reads
    // cleared (run() spreads process.env first, so each source is emptied
    // explicitly rather than deleted) and HOME pointed at an empty directory:
    // the legacy record raises no provider issue because ownership decides, not
    // a credential check; an unrelated refresh keeps the aws-mcp region the
    // project file carries even when the record says something else; and
    // --reset clears the record without touching the MCP bytes.
    const kiro = install("kiro");
    const kiroPath = join(kiro, ".kiro", "tools", "data", "harness.json");
    const kiroData = JSON.parse(readFileSync(kiroPath, "utf-8"));
    kiroData.providers = {
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "eu-west-1",
      pendingActions: [{ id: "bedrock-model-access", status: "pending" }],
    };
    writeFileSync(kiroPath, `${JSON.stringify(kiroData, null, 2)}\n`);
    const mcpPath = join(kiro, ".kiro", "settings", "mcp.json");
    const projectMcp = withMcpRegion(readFileSync(mcpPath, "utf-8"), "ap-southeast-2");
    writeFileSync(mcpPath, projectMcp);
    const noCredentials = runtimeEnv({
      HOME: temp("aidlc-t294-no-aws-home-"),
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_BEARER_TOKEN_BEDROCK: "",
      AWS_PROFILE: "",
      AWS_DEFAULT_PROFILE: "",
      AWS_WEB_IDENTITY_TOKEN_FILE: "",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "",
      AWS_ROLE_ARN: "",
      AWS_ROLE_SESSION_NAME: "",
    });
    const kiroShow = run(
      ["config", "providers", "--project-dir", kiro, "--show", "--json"],
      kiro,
      noCredentials,
    );
    expect(kiroShow.status, kiroShow.stdout + kiroShow.stderr).toBe(0);
    expect(JSON.parse(kiroShow.stdout).data.credentials.hasCredentials).toBe(false);
    const kiroCheck = run(
      ["config", "providers", "--project-dir", kiro, "--check"],
      kiro,
      noCredentials,
    );
    expect(kiroCheck.status, kiroCheck.stdout + kiroCheck.stderr).toBe(0);
    expect(kiroCheck.stdout).not.toContain("provider-credentials-missing");
    const refresh = run([
      "config",
      "--project-dir",
      kiro,
      "--from",
      join(DIST_RELEASE, "kiro"),
      "--harness",
      "kiro",
      "--yes",
    ], kiro, noCredentials);
    expect(refresh.status, refresh.stdout + refresh.stderr).toBe(0);
    expect(readFileSync(mcpPath, "utf-8")).toBe(projectMcp);
    const kiroReset = run(
      ["config", "providers", "--project-dir", kiro, "--reset", "--yes"],
      kiro,
      noCredentials,
    );
    expect(kiroReset.status, kiroReset.stdout + kiroReset.stderr).toBe(0);
    expect(readConfigDiagnosticRecords(join(kiro, ".kiro")).providers).toBeNull();
    expect(readFileSync(mcpPath, "utf-8")).toBe(projectMcp);

    // The preservation must not turn mcp.json into a runtime-generated file: with
    // the nondefault region still in place, enabling aws-mcp by hand and adding a
    // server is a local modification the refresh has to refuse, not overwrite.
    const parsedMcp = JSON.parse(projectMcp) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    parsedMcp.mcpServers["aws-mcp"].disabled = false;
    parsedMcp.mcpServers["team-docs"] = { type: "http", url: "https://docs.example.test/mcp" };
    const editedMcp = `${JSON.stringify(parsedMcp, null, 2)}\n`;
    writeFileSync(mcpPath, editedMcp);
    const refused = run([
      "config",
      "--project-dir",
      kiro,
      "--from",
      join(DIST_RELEASE, "kiro"),
      "--harness",
      "kiro",
      "--yes",
    ], kiro, noCredentials);
    expect(refused.status, refused.stdout + refused.stderr).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("locally modified");
    expect(readFileSync(mcpPath, "utf-8")).toBe(editedMcp);

    const claude = install("claude");
    const claudePath = join(claude, ".claude", "tools", "data", "harness.json");
    const claudeData = JSON.parse(readFileSync(claudePath, "utf-8"));
    claudeData.providers = record;
    writeFileSync(claudePath, `${JSON.stringify(claudeData, null, 2)}\n`);
    const claudeCheck = run([
      "config", "providers", "--project-dir", claude, "--check",
    ], claude, env);
    expect(claudeCheck.status).toBe(1);
    expect(claudeCheck.stdout + claudeCheck.stderr).toContain("bedrock-model-access");
  }, 90_000);

  test("check names an unrecorded providers section instead of calling it clean", () => {
    const env = runtimeEnv();
    // Where AI-DLC configures the provider, an unrecorded section is a real gap.
    const claude = install("claude");
    const claudeCheck = run([
      "config",
      "providers",
      "--project-dir",
      claude,
      "--check",
    ], claude, env);
    expect(claudeCheck.status, claudeCheck.stdout + claudeCheck.stderr).toBe(0);
    expect(claudeCheck.stdout).toContain("no recorded answer for claude");
    expect(claudeCheck.stdout).toContain("the shipped fallback is in use");
    expect(claudeCheck.stdout).not.toContain("configuration is clean");

    // Where it does not, the same state needs no answer at all.
    const kiro = install("kiro");
    const kiroCheck = run([
      "config",
      "providers",
      "--project-dir",
      kiro,
      "--check",
    ], kiro, env);
    expect(kiroCheck.status, kiroCheck.stdout + kiroCheck.stderr).toBe(0);
    expect(kiroCheck.stdout).toContain("needs no answer for kiro");
    expect(kiroCheck.stdout).toContain("harness-managed");
    expect(providerDoctorCheck(kiro, ".kiro")).toEqual(expect.objectContaining({
      pass: true,
      label: "Providers: harness-managed model access; no answer needed",
    }));
    expect(providerDoctorCheck(claude, ".claude")).toEqual(expect.objectContaining({
      pass: true,
      label: "Providers: using shipped fallback; no recorded answers",
    }));
  }, 90_000);

  test("only Kiro owns its own model access; every other harness is Bedrock-oriented", () => {
    for (const harness of ["kiro", "kiro-ide"] as const) {
      expect(harnessOwnsModelAccess(harness)).toBe(true);
    }
    // Copilot and Cursor reach Bedrock through their own BYOK/provider settings,
    // so they must still be asked rather than assumed to be self-served.
    for (const harness of ["claude", "codex", "opencode", "copilot", "cursor"] as const) {
      expect(harnessOwnsModelAccess(harness)).toBe(false);
    }
  });

  test("a bun-requiring projection names the copy channel in its runtime remediation", () => {
    const project = temp("aidlc-t294-copy-runtime-");
    mkdirSync(join(project, ".git"));
    cpSync(join(DIST, "claude"), project, { recursive: true });
    const bin = temp("aidlc-t294-copy-path-");
    if (process.platform !== "win32") {
      writeFileSync(
        join(bin, "getconf"),
        `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(bin)}\n`,
        { mode: 0o755 },
      );
    }
    const issues = runtimeIssues(probeRuntime(project, ".claude", "claude", {
      env: { PATH: bin },
      baselinePath: bin,
      interactivePath: bin,
      includeHarnessCli: false,
    }));
    const bunIssue = issues.find((issue) => issue.id.includes("bun"));
    expect(bunIssue, issues.map((issue) => issue.id).join(",")).toBeDefined();
    expect(bunIssue?.remediation).toContain("copy-channel projection");
    expect(bunIssue?.remediation).toContain("native install runs them through the aidlc command");
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
