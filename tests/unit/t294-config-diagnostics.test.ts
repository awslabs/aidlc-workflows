import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix } from "node:path";
import { parse as parseToml } from "smol-toml";
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
  resolveExecutableOnPath,
  runtimeDoctorChecks,
  runtimeIssues,
  trustStatus,
  workspaceSiblingDoctorCheck,
  workspaceSiblingIssues,
  type ConfigDiagnosticRecords,
  type ProvidersRecord,
} from "../../core/tools/aidlc-config-diagnostics.ts";
import { collectDoctorReport } from "../../core/tools/aidlc-utility.ts";
import * as runtimePaths from "../../core/tools/aidlc-runtime-paths.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST = join(REPO_ROOT, "dist");
const DIST_RELEASE = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];

// Each case owns its installations. Release them before the next case rather
// than retaining every copied runtime until the entire file finishes.
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

// The legacy Bedrock block sat among the shipped config's top-level keys with
// its aws table last before the first table header. Insert a synthesized block
// there, after developer_instructions and every other top-level key the current
// shipped config carries (tool_output_token_limit), so no shipped key lands
// inside the legacy table in TOML terms and the file models a real upgrade.
function withLegacyCodexProviderBlock(config: string, block: string): string {
  const developerInstructions =
    /^[\t ]*developer_instructions[\t ]*=[\t ]*'''[\s\S]*?'''[\t ]*(?:\r?\n|$)/m
      .exec(config);
  // sandbox_mode is a root key, not part of a model_providers table:
  // https://developers.openai.com/codex/config-reference/#sandbox_mode
  // Insert after all root assignments, skipping headers inside onboarding text.
  const afterInstructions = developerInstructions
    ? developerInstructions.index + developerInstructions[0].length
    : 0;
  const table = /^[\t ]*\[/m.exec(config.slice(afterInstructions));
  const insertion = table ? afterInstructions + table.index : config.length;
  return config.slice(0, insertion) + block + config.slice(insertion);
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
  // The injected platform selects Linux configuration sources; the returned
  // PATH and filesystem resolver still use this process's native path format.
  const linuxBaseline = ["/bin", "/usr/bin"].join(delimiter);

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
    // Linux PATH records cannot contain a Windows drive colon. Keep logical
    // Linux paths separate from the native directories holding the fixtures.
    const home = "/home/aidlc-fixture";
    const configHome = temp("aidlc-t294-system-home-");
    mkdirSync(join(root, "etc", "environment.d"), { recursive: true });
    mkdirSync(join(configHome, "environment.d"), { recursive: true });
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
      join(configHome, "environment.d", "10-user.conf"),
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
      env: { XDG_CONFIG_HOME: configHome },
      run: () => ({ status: 0, stdout: `${linuxBaseline}\n` }),
    });
    const entries = baseline.split(delimiter);
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
      posix.join(home, ".local", "bin"),
      posix.join(home, "bin"),
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
      home: "/home/empty-fixture",
      env: { XDG_CONFIG_HOME: temp("aidlc-t294-system-home-empty-") },
      run: () => ({ status: 0, stdout: `${linuxBaseline}\n` }),
    });
    expect(bare).toBe(linuxBaseline);
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
    const linuxHome = "/home/aidlc-fixture";
    const linuxSite = "/opt/aidlc-site/bin";
    const linuxInteractive = "/opt/aidlc-interactive/bin";
    const directories = new Map([
      [linuxSite, siteBin],
      [linuxInteractive, interactiveBin],
      [posix.join(linuxHome, ".local", "bin"), join(home, ".local", "bin")],
    ]);
    mkdirSync(join(systemRoot, "etc"), { recursive: true });
    writeFileSync(join(systemRoot, "etc", "environment"), `PATH="${linuxSite}" # site\n`);
    const options = {
      platform: "linux" as const,
      systemRoot,
      home: linuxHome,
      env: { PATH: linuxInteractive, XDG_CONFIG_HOME: join(home, ".config") },
      includeHarnessCli: false,
      which(command: string, pathValue: string): string | null {
        for (const entry of pathValue.split(delimiter)) {
          const directory = directories.get(entry);
          if (!directory) continue;
          const executable = resolveExecutableOnPath(command, directory);
          if (executable) return executable;
        }
        return null;
      },
      run: () => ({ status: 0, stdout: `${linuxBaseline}\n` }),
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
      env: { ...options.env, PATH: posix.join(linuxHome, ".local", "bin") },
    });
    expect(bare.baselinePath).toBe(linuxBaseline);
    expect(bare.binaries.find((item) => item.name === "aidlc")?.status).toBe(
      "interactive-only",
    );

    // Blanking an unresolved variable must not expose an unrelated executable.
    const unresolvedHome = temp("aidlc-t294-system-home-unresolved-");
    const toolchainRoot = temp("aidlc-t294-toolchain-");
    const linuxToolchain = "/opt/toolchain";
    directories.set(posix.join(linuxToolchain, "bin"), join(toolchainRoot, "bin"));
    mkdirSync(join(toolchainRoot, "bin"));
    writeExecutable(join(toolchainRoot, "bin", "aidlc"));
    mkdirSync(join(unresolvedHome, ".config", "environment.d"), { recursive: true });
    writeFileSync(
      join(unresolvedHome, ".config", "environment.d", "10-user.conf"),
      `TOOLCHAIN=gcc\nPATH=${linuxToolchain}/$TOOLCHAIN/bin:$PATH\n`,
    );
    const unresolved = probeRuntime(project, ".claude", "claude", {
      ...options,
      systemRoot: temp("aidlc-t294-system-root-unresolved-"),
      home: "/home/unresolved-fixture",
      env: { ...options.env, XDG_CONFIG_HOME: join(unresolvedHome, ".config") },
    });
    expect({
      status: unresolved.binaries.find((item) => item.name === "aidlc")?.status,
      toolchainEntries: unresolved.baselinePath.split(delimiter).filter((entry) =>
        entry.startsWith(linuxToolchain)
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

  describe("shared provider writers apply only the selected harness surfaces", () => {
    const record = () => reconcileProviderActions({
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "eu-west-1",
      profile: "dev",
      opencodeDefault: true,
      pendingActions: [
        { id: "bedrock-model-access", status: "done" },
      ],
    }, "claude", true);

    // Each surface is independent. Keep its real distribution and assertions,
    // but do not charge eleven tree copies to one default test deadline.
    test("Claude writes provider settings and MCP region", () => {
      const claude = temp("aidlc-t294-provider-claude-");
      cpSync(join(DIST, "claude"), claude, { recursive: true });
      applyConfigDiagnosticRecords(
        claude,
        ".claude",
        "claude",
        emptyRecords(record()),
      );
      const settings = JSON.parse(
        readFileSync(join(claude, ".claude", "settings.json"), "utf-8"),
      ) as { env: Record<string, string> };
      expect(settings.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      expect(settings.env.AWS_REGION).toBe("eu-west-1");
      expect(settings.env.AWS_PROFILE).toBe("dev");
      const claudeMcp = readFileSync(join(claude, ".mcp.json"), "utf-8");
      expect(claudeMcp).toContain("https://aws-mcp.eu-west-1.api.aws/mcp");
      expect(claudeMcp).toContain("AWS_REGION=eu-west-1");
    });

    test("Codex leaves its project configuration unchanged", () => {
      const codex = temp("aidlc-t294-provider-codex-");
      cpSync(join(DIST, "codex"), codex, { recursive: true });
      const codexBefore = readFileSync(join(codex, ".codex", "config.toml"), "utf-8");
      applyConfigDiagnosticRecords(
        codex,
        ".codex",
        "codex",
        emptyRecords(record()),
      );
      const codexAfter = readFileSync(join(codex, ".codex", "config.toml"), "utf-8");
      expect(codexAfter).toBe(codexBefore);
      expect(codexAfter).not.toContain("[model_providers.amazon-bedrock");
    });

    test("OpenCode applies an accepted default provider", () => {
      const opencode = temp("aidlc-t294-provider-opencode-");
      cpSync(join(DIST, "opencode"), opencode, { recursive: true });
      applyConfigDiagnosticRecords(
        opencode,
        ".aidlc",
        "opencode",
        emptyRecords(record()),
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
    });

    test("OpenCode leaves a declined default provider unchanged", () => {
      const decline = temp("aidlc-t294-provider-opencode-decline-");
      cpSync(join(DIST, "opencode"), decline, { recursive: true });
      const before = readFileSync(join(decline, "opencode.json"), "utf-8");
      applyConfigDiagnosticRecords(
        decline,
        ".aidlc",
        "opencode",
        emptyRecords({ ...record(), opencodeDefault: false }),
      );
      expect(readFileSync(join(decline, "opencode.json"), "utf-8")).toBe(before);
    });

    // Owned harnesses: no record writes anything, Kiro CLI included. The aws-mcp
    // region there is carried from the project's own file during staging, and a
    // record's region never reaches it, even when the file says something else.
    test.each([
      ["kiro", ".kiro", "settings/mcp.json"],
      ["kiro-ide", ".kiro", "tools/data/harness.json"],
      ["copilot", ".aidlc", "tools/data/harness.json"],
      ["cursor", ".cursor", "cli.json"],
    ] as const)("%s leaves its owned surface unchanged", (harness, dir, file) => {
      const root = temp(`aidlc-t294-provider-${harness}-`);
      cpSync(join(DIST, harness), root, { recursive: true });
      const path = join(root, dir, file);
      const original = readFileSync(path);
      applyConfigDiagnosticRecords(
        root,
        dir,
        harness,
        emptyRecords(record()),
      );
      expect(readFileSync(path), harness).toEqual(original);
    });

    // Staging preservation: the project's aws-mcp endpoint and metadata replace
    // the release values in the staged copy, argument by argument, and a project
    // without that entry leaves the staged bytes alone.
    test("Kiro staging preserves the project's MCP region and metadata", () => {
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
    });
    test("Kiro staging leaves an absent project MCP entry alone", () => {
      const emptyProject = temp("aidlc-t294-kiro-mcp-empty-");
      mkdirSync(join(emptyProject, ".kiro", "settings"), { recursive: true });
      writeFileSync(join(emptyProject, ".kiro", "settings", "mcp.json"), "{}\n");
      const untouched = temp("aidlc-t294-kiro-mcp-untouched-");
      cpSync(join(DIST, "kiro"), untouched, { recursive: true });
      const before2 = readFileSync(join(untouched, ".kiro", "settings", "mcp.json"), "utf-8");
      preserveKiroMcpRegion(emptyProject, untouched, ".kiro");
      expect(readFileSync(join(untouched, ".kiro", "settings", "mcp.json"), "utf-8")).toBe(before2);
    });
  });

  test("current detects and removes stale project Bedrock overrides", () => {
    const record: ProvidersRecord = {
      schemaVersion: 1,
      provider: "current",
    };

    const claude = temp("aidlc-t294-other-claude-");
    cpSync(join(DIST, "claude"), claude, { recursive: true });
    const claudePath = join(claude, ".claude", "settings.json");
    const claudeSettings = JSON.parse(readFileSync(claudePath, "utf-8"));
    claudeSettings.env.CLAUDE_CODE_USE_BEDROCK = "1";
    claudeSettings.env.AWS_REGION = "us-east-1";
    claudeSettings.env.ANTHROPIC_DEFAULT_FABLE_MODEL =
      "global.anthropic.claude-fable-5[1m]";
    claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL =
      "global.anthropic.claude-opus-4-8[1m]";
    claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL =
      "global.anthropic.claude-sonnet-4-6[1m]";
    claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL =
      "global.anthropic.claude-haiku-4-5-20251001-v1:0";
    writeFileSync(claudePath, `${JSON.stringify(claudeSettings, null, 2)}\n`);
    expect(providerIssues(claude, ".claude", "claude", record)
      .map((issue) => issue.id)).toContain("provider-claude-project-override");
    applyConfigDiagnosticRecords(
      claude,
      ".claude",
      "claude",
      emptyRecords(record),
    );
    expect(providerIssues(claude, ".claude", "claude", record)).toEqual([]);

    const userClaude = temp("aidlc-t294-user-claude-");
    cpSync(join(DIST, "claude"), userClaude, { recursive: true });
    const userClaudePath = join(userClaude, ".claude", "settings.json");
    const userClaudeSettings = JSON.parse(readFileSync(userClaudePath, "utf-8"));
    userClaudeSettings.env.CLAUDE_CODE_USE_BEDROCK = "1";
    userClaudeSettings.env.AWS_REGION = "eu-west-1";
    userClaudeSettings.env.AWS_PROFILE = "team";
    userClaudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "team.opus";
    writeFileSync(userClaudePath, `${JSON.stringify(userClaudeSettings, null, 2)}\n`);
    applyConfigDiagnosticRecords(
      userClaude,
      ".claude",
      "claude",
      emptyRecords(record),
    );
    expect(JSON.parse(readFileSync(userClaudePath, "utf-8")).env)
      .toEqual(expect.objectContaining({
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "eu-west-1",
        AWS_PROFILE: "team",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "team.opus",
      }));

    const codex = temp("aidlc-t294-other-codex-");
    cpSync(join(DIST, "codex"), codex, { recursive: true });
    const codexPath = join(codex, ".codex", "config.toml");
    const legacyFrameworkConfig = readFileSync(codexPath, "utf-8").replace(
      /^[\t ]*developer_instructions[\t ]*=[\t ]*'''[\s\S]*?'''[\t ]*(?:\r?\n|$)/m,
      "",
    );
    writeFileSync(
      codexPath,
      withLegacyCodexProviderBlock(legacyFrameworkConfig, `# D-9: Amazon Bedrock is the shipped default provider (web_search is\n` +
        `# unavailable there; the market-research stage degrades gracefully). For\n` +
        `# OpenAI-auth setups, comment out model_provider and the [model_providers]\n` +
        `# block.\n` +
        `model = "openai.gpt-5.5"\nmodel_provider = "amazon-bedrock"\n` +
        `model_context_window = 1000000\nmodel_reasoning_effort = "high"\n\n` +
        `[model_providers.amazon-bedrock.aws]\nprofile = "default"\nregion = "us-east-1"\n\n`),
    );
    expect(providerIssues(codex, ".codex", "codex", record)
      .map((issue) => issue.id)).toContain("provider-codex-project-override");
    applyConfigDiagnosticRecords(
      codex,
      ".codex",
      "codex",
      emptyRecords(record),
    );
    expect(providerIssues(codex, ".codex", "codex", record)).toEqual([]);
    expect(parseToml(readFileSync(codexPath, "utf-8")).sandbox_mode).toBe("workspace-write");

    const customCodex = temp("aidlc-t294-custom-codex-");
    cpSync(join(DIST, "codex"), customCodex, { recursive: true });
    const customCodexPath = join(customCodex, ".codex", "config.toml");
    const customConfig = withLegacyCodexProviderBlock(
      readFileSync(customCodexPath, "utf-8"),
      `model = "gpt-5.5"\nmodel_provider = "amazon-bedrock"\n` +
      `model_context_window = 262144\nmodel_reasoning_effort = "low"\n\n` +
        `[model_providers.amazon-bedrock.aws]\nprofile = "dev"\nregion = "eu-west-1"\n\n`,
    );
    writeFileSync(customCodexPath, customConfig);
    expect(providerIssues(customCodex, ".codex", "codex", record)).toEqual([
      expect.objectContaining({
        id: "provider-codex-project-override",
        severity: "warn",
      }),
    ]);
    applyConfigDiagnosticRecords(
      customCodex,
      ".codex",
      "codex",
      emptyRecords(record),
    );
    expect(readFileSync(customCodexPath, "utf-8")).toBe(customConfig);

    const opencode = temp("aidlc-t294-other-opencode-");
    cpSync(join(DIST, "opencode"), opencode, { recursive: true });
    const opencodePath = join(opencode, "opencode.json");
    const opencodeSettings = JSON.parse(readFileSync(opencodePath, "utf-8"));
    opencodeSettings.provider = {
      "amazon-bedrock": {
        options: { region: "us-east-1" },
      },
    };
    writeFileSync(
      opencodePath,
      `${JSON.stringify(opencodeSettings, null, 2)}\n`,
    );
    applyConfigDiagnosticRecords(
      opencode,
      ".aidlc",
      "opencode",
      emptyRecords(record),
      {
        schemaVersion: 1,
        provider: "amazon-bedrock",
        region: "us-east-1",
        opencodeDefault: true,
      },
    );
    expect(providerIssues(opencode, ".aidlc", "opencode", record)).toEqual([]);
  });

  test("pending actions drive check and doctor until marked done", () => {
    const project = temp("aidlc-t294-pending-");
    cpSync(join(DIST, "claude"), project, { recursive: true });
    let record = reconcileProviderActions({
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "us-east-1",
    }, "claude", true);
    const dataPath = join(project, ".claude", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(dataPath, "utf-8"));
    data.providers = record;
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    applyConfigDiagnosticRecords(
      project,
      ".claude",
      "claude",
      emptyRecords(record),
    );
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
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
    if (accessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = accessKey;
    if (secretKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = secretKey;
  });
});

describe("t294 trust diagnostics", () => {
  test("Codex doctor hashes configured seconds exactly and retains the omitted-timeout legacy identity", async () => {
    const project = temp("aidlc-t294-trust-timeouts-");
    cpSync(join(DIST_RELEASE, "codex"), project, { recursive: true });
    const harnessRoot = join(project, ".codex");
    const hooksPath = join(harnessRoot, "hooks.json");
    const seedPath = join(harnessRoot, "trust-seed.toml");
    const machine = temp("aidlc-t294-trust-timeouts-machine-");
    const overrides = {
      AIDLC_HARNESS_DIR: ".codex",
      AIDLC_HARNESS_NAME: "codex",
      AIDLC_RUNTIME_HARNESS_ROOT: harnessRoot,
      AIDLC_RUNTIME_ROOT: DIST_RELEASE,
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
      AIDLC_OFFLINE: "1",
      CODEX_HOME: machine,
      ...hookPathEnv(),
    };
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    // Select the compiled-install doctor row without compiling a fixture
    // binary. The real doctor still reads the hook file and computes its hash.
    const compiled = spyOn(runtimePaths, "isCompiledExecutable").mockReturnValue(true);
    const writeHook = (timeout: unknown): void => {
      writeFileSync(hooksPath, JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{
          type: "command",
          command: "aidlc engine adapter codex session-start",
          ...(timeout === undefined ? {} : { timeout }),
        }] }] },
      }));
    };
    const nativeTrust = async () => {
      const report = await collectDoctorReport(project);
      const rows = report.checks.filter((check) => check.label.startsWith("Native command trust"));
      expect(rows).toHaveLength(1);
      return rows[0];
    };
    // Fixed canonical JSON hashes are independent of the emitter and doctor
    // implementations. Each differs only at the timeout field in seconds.
    const identities = [
      { timeout: undefined, hash: "4e23fffc05a5ef77e420b7d09b59be712919558a2a532c689d78f639731788db" },
      { timeout: 1800, hash: "0ba8b12bad0f77c2bf9a996ec8e533c53a6e451fe37c31de2626e27514e35e63" },
      { timeout: 3600, hash: "460202569a039241af1d9ca9fa8f0763ee457222429d505a9c0bfff770245168" },
      { timeout: 37, hash: "1e1b151916107c841414863a260ca84732b1fbe38828d37644e4d04649be904e" },
      { timeout: 0, hash: "d4e9789fbe4ab8b2124b1c5d2534a8d551edd9745a1e74c8823f2e2cee17463d" },
    ];
    try {
      Object.assign(process.env, overrides);
      for (const { timeout, hash } of identities) {
        writeHook(timeout);
        const seed = `[hooks.state."fixture:session_start:0:0"]\ntrusted_hash = "sha256:${hash}"\n`;
        writeFileSync(seedPath, seed);
        const trusted = await nativeTrust();
        expect(trusted.pass, `timeout=${timeout}: ${trusted.label}`).toBe(true);
        // A timeout-only edit invalidates trust. Reusing the legacy default,
        // silently normalizing a user value, or hashing milliseconds fails here.
        writeHook((timeout ?? 600) + 1);
        const changed = await nativeTrust();
        expect(changed.pass, `timeout=${timeout}: ${changed.label}`).toBe(false);
        expect(changed.label).toContain("native permission/trust missing");
        expect(readFileSync(seedPath, "utf-8")).toBe(seed);
      }
      // Invalid shapes must not acquire trust by falling back to 600 or by
      // coercing the supplied value to a number.
      const seed = identities.map(({ hash }, index) =>
        `[hooks.state."fixture:${index}"]\ntrusted_hash = "sha256:${hash}"\n`
      ).join("\n");
      writeFileSync(seedPath, seed);
      for (const timeout of [null, "1800", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        writeHook(timeout);
        const invalid = await nativeTrust();
        expect(invalid.pass, `timeout=${JSON.stringify(timeout)}: ${invalid.label}`).toBe(false);
        expect(invalid.label).toContain("native permission/trust missing");
      }
      expect(readFileSync(seedPath, "utf-8")).toBe(seed);
    } finally {
      compiled.mockRestore();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

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

  test("doctor flags unwired shipped Claude hooks through refresh until the hooks key is restored", () => {
    const env = runtimeEnv();
    const driftLabel = "hooks in .claude/settings.json differ from the shipped wiring (you changed them)";
    for (const [source, hook] of [[DIST, "session-end"], [DIST_RELEASE, "session-start"]]) {
      const project = temp("aidlc-t294-doctor-unwired-");
      mkdirSync(join(project, ".git"));
      cpSync(join(source, "claude"), project, { recursive: true });
      const args = [
        "config",
        "--project-dir",
        project,
        "--from",
        join(source, "claude"),
        "--harness",
        "claude",
        "--yes",
      ];
      const installed = run(args, project, env);
      expect(installed.status, installed.stdout + installed.stderr).toBe(0);
      const settingsPath = join(project, ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const shippedHooks = structuredClone(settings.hooks);
      const doctor = (): {
        status: number | null;
        checks: Array<{ pass: boolean; label: string; fix?: string; severity?: string }>;
        failed: number;
      } => {
        const result = spawnSync(BUN, [
          join(project, ".claude", "tools", "aidlc.ts"),
          "--doctor",
          "--json",
          "--offline",
        ], {
          cwd: project,
          env: { ...process.env, ...env, AIDLC_HARNESS_DIR: ".claude" },
          encoding: "utf-8",
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        });
        if (result.error) throw result.error;
        return { ...JSON.parse(result.stdout).data, status: result.status };
      };
      const pristine = doctor();
      expect(pristine.checks.some((check) => check.label.includes("shipped but not wired")))
        .toBe(false);
      expect(pristine.checks.some((check) => check.label === driftLabel)).toBe(false);

      const strayHook = "aidlc-evil-instructions.ts";
      writeFileSync(join(project, ".claude", "hooks", strayHook), "// project-owned hook\n");
      const withStray = doctor();
      expect(withStray.checks.some((check) => check.label.includes(strayHook))).toBe(false);
      expect(withStray.failed).toBe(pristine.failed);
      expect(withStray.status).toBe(pristine.status);

      const guardIndex = settings.hooks.PreToolUse.findIndex(
        (registration: { hooks: Array<{ command: string }> }) =>
          registration.hooks.some((entry) => entry.command.includes("plan-approval-guard")),
      );
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      const [guard] = settings.hooks.PreToolUse.splice(guardIndex, 1);
      settings.hooks.PostToolUse.push(guard);
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      const moved = doctor();
      expect(moved.checks).toContainEqual(expect.objectContaining({
        pass: false,
        label: driftLabel,
      }));
      expect(moved.checks.some((check) => check.label.includes("shipped but not wired")))
        .toBe(false);
      expect(moved.failed).toBeGreaterThan(pristine.failed);
      expect(moved.status).toBe(1);

      for (const variant of ["matcher", "command"]) {
        settings.hooks = structuredClone(shippedHooks);
        const registration = settings.hooks.PreToolUse.find(
          (candidate: { hooks: Array<{ command: string }> }) =>
            candidate.hooks.some((entry) => entry.command.includes("plan-approval-guard")),
        );
        expect(registration).toBeDefined();
        if (variant === "matcher") {
          registration.matcher = "Write";
        } else {
          registration.hooks[0].command += " --changed";
        }
        writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
        const altered = doctor();
        expect(altered.checks).toContainEqual(expect.objectContaining({
          pass: false,
          label: driftLabel,
        }));
        expect(altered.status).toBe(1);
      }

      settings.hooks = structuredClone(shippedHooks);

      if (hook === "session-end") {
        settings.hooks.SessionEnd[0].hooks = settings.hooks.SessionEnd[0].hooks.filter(
          (entry: { command: string }) => !entry.command.includes("session-end"),
        );
      } else {
        delete settings.hooks.SessionStart;
      }
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      const label = `aidlc-${hook}.ts shipped but not wired in .claude/settings.json - AI-DLC enforcement for it is off`;
      const unwired = doctor();
      expect(unwired.checks).toContainEqual(expect.objectContaining({ pass: false, label }));
      expect(unwired.checks.find((check) => check.label === label)?.fix)
        .toContain("config --force");
      expect(unwired.failed).toBeGreaterThan(pristine.failed);
      expect(unwired.status).toBe(1);

      const refreshed = run(args, project, env);
      expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(4);
      expect(refreshed.stdout + refreshed.stderr).toContain(
        ".claude/settings.json (locally modified or unowned)",
      );
      const stillUnwired = doctor();
      expect(stillUnwired.checks).toContainEqual(expect.objectContaining({ pass: false, label }));
      expect(stillUnwired.failed).toBeGreaterThan(0);
      expect(stillUnwired.status).toBe(1);

      const restored = run([...args, "--force"], project, env);
      expect(restored.status, restored.stdout + restored.stderr).toBe(0);
      expect(JSON.parse(readFileSync(settingsPath, "utf-8")).hooks).toEqual(shippedHooks);
      const repaired = doctor();
      expect(repaired.checks.some((check) => check.label.includes("shipped but not wired")))
        .toBe(false);
      expect(repaired.checks.some((check) => check.label === driftLabel)).toBe(false);
    }
    if (process.platform !== "win32") {
      const project = install("claude");
      writeFileSync(join(project, ".claude", "hooks", "aidlc-x\u001b[31mfake.ts"), "// local hook\n");
      const human = spawnSync(BUN, [
        join(project, ".claude", "tools", "aidlc.ts"),
        "--doctor",
        "--offline",
      ], {
        cwd: project,
        env: { ...process.env, ...env, AIDLC_HARNESS_DIR: ".claude", NO_COLOR: "1" },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      if (human.error) throw human.error;
      expect(human.stdout).not.toContain("\u001b");
      expect(human.stdout).not.toContain("aidlc-x");
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t294 instruction-file doctor row", () => {
  test("copied Codex instructions require both root guidance and onboarding without config", () => {
    const project = temp("aidlc-t294-copy-instructions-");
    cpSync(join(DIST, "codex", "AGENTS.md"), join(project, "AGENTS.md"));
    cpSync(join(DIST, "codex", ".codex"), join(project, ".codex"), { recursive: true });
    cpSync(join(DIST, "codex", "aidlc"), join(project, "aidlc"), { recursive: true });
    expect(existsSync(join(project, ".codex", "tools", "data", "aidlc-manifest.json")))
      .toBe(false);

    const intact = instructionFileDoctorCheck(project, ".codex");
    expect(intact.pass).toBe(true);
    expect(intact.label).toContain("framework-owned file intact");

    const agentsPath = join(project, "AGENTS.md");
    rmSync(agentsPath);
    const missingRoot = instructionFileDoctorCheck(project, ".codex");
    expect(missingRoot.pass).toBe(false);
    expect(missingRoot.label).toContain("missing (AGENTS.md)");

    mkdirSync(agentsPath);
    const directoryRoot = instructionFileDoctorCheck(project, ".codex");
    expect(directoryRoot.pass).toBe(false);
    expect(directoryRoot.label).toContain("missing (AGENTS.md)");

    rmSync(agentsPath, { recursive: true });
    cpSync(join(DIST, "codex", "AGENTS.md"), agentsPath);
    rmSync(join(project, ".codex", "onboarding.md"));
    const missingOnboarding = instructionFileDoctorCheck(project, ".codex");
    expect(missingOnboarding.pass).toBe(false);
    expect(missingOnboarding.label).toContain("missing (.codex/onboarding.md)");
  });

  test("an unsafe onboarding path is ignored like an absent descriptor field", () => {
    const project = install("codex");
    const descriptorPath = join(project, ".codex", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    delete descriptor.onboarding;
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const absent = instructionFileDoctorCheck(project, ".codex");
    expect(absent.pass).toBe(true);

    descriptor.onboarding = "../../x\n";
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    expect(instructionFileDoctorCheck(project, ".codex")).toEqual(absent);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("onboarding behind a symlinked parent is a conflict even when its hash matches", () => {
    const project = install("codex");
    const outside = temp("aidlc-t294-onboarding-outside-");
    cpSync(join(project, ".codex", "onboarding.md"), join(outside, "onboarding.md"));
    symlinkSync(outside, join(project, ".codex", "etc"), process.platform === "win32" ? "junction" : "dir");
    const onboarding = ".codex/etc/onboarding.md";
    const descriptorPath = join(project, ".codex", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    descriptor.onboarding = onboarding;
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const baselinePath = join(project, ".codex", "tools", "data", "aidlc-manifest.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
    baseline.files[onboarding] = baseline.files[".codex/onboarding.md"];
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

    const conflict = instructionFileDoctorCheck(project, ".codex");
    expect(conflict.pass).toBe(false);
    expect(conflict.label).toContain(`conflict (${onboarding})`);

    delete baseline.files[onboarding];
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    expect(instructionFileDoctorCheck(project, ".codex")).toEqual(conflict);
    rmSync(baselinePath);
    expect(instructionFileDoctorCheck(project, ".codex")).toEqual(conflict);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("declared onboarding absent from the baseline remains a missing instruction", () => {
    const project = install("codex");
    const baselinePath = join(project, ".codex", "tools", "data", "aidlc-manifest.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
    delete baseline.files[".codex/onboarding.md"];
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

    const missingBaseline = instructionFileDoctorCheck(project, ".codex");
    expect(missingBaseline.pass).toBe(false);
    expect(missingBaseline.label).toContain("missing (.codex/onboarding.md)");

    rmSync(join(project, "AGENTS.md"));
    const missingBoth = instructionFileDoctorCheck(project, ".codex");
    expect(missingBoth.pass).toBe(false);
    expect(missingBoth.label).toContain("AGENTS.md");
    expect(missingBoth.label).toContain(".codex/onboarding.md");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("instruction row selects the invoking harness in a dual-harness project", () => {
    const project = install("claude");
    const kiro = install("kiro");
    cpSync(join(kiro, ".kiro"), join(project, ".kiro"), { recursive: true });
    cpSync(join(kiro, "AGENTS.md"), join(project, "AGENTS.md"));
    const onboardingPath = join(project, ".kiro", "steering", "aidlc-onboarding.md");
    const onboarding = readFileSync(onboardingPath, "utf-8");
    const claudePath = join(project, ".claude", "CLAUDE.md");
    expect(instructionFileDoctorCheck(project, ".claude").pass).toBe(true);
    const intact = instructionFileDoctorCheck(project, ".kiro");
    expect(intact.pass).toBe(true);
    expect(intact.label).toContain("framework-owned file intact");

    writeFileSync(onboardingPath, `${onboarding}\nLocal onboarding change\n`);
    const modified = instructionFileDoctorCheck(project, ".kiro");
    expect(modified.pass).toBe(false);
    expect(modified.label).toContain("hand-modified - conflict (.kiro/steering/aidlc-onboarding.md)");
    expect(instructionFileDoctorCheck(project, ".claude").pass).toBe(true);

    writeFileSync(onboardingPath, onboarding);
    rmSync(join(project, "AGENTS.md"));
    expect(instructionFileDoctorCheck(project, ".claude").pass).toBe(true);
    expect(instructionFileDoctorCheck(project, ".kiro").label)
      .toContain("block or file missing (AGENTS.md)");

    writeFileSync(claudePath, `${readFileSync(claudePath, "utf-8")}\nLocal Claude change\n`);
    const claudeModified = instructionFileDoctorCheck(project, ".claude");
    expect(claudeModified.pass).toBe(false);
    expect(claudeModified.label).toContain("hand-modified - conflict (.claude/CLAUDE.md)");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
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
      .not.toContain('"AWS_REGION"');
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf-8"))
      .not.toContain('"CLAUDE_CODE_USE_BEDROCK"');
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
    expect(run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env).status).toBe(0);
    const switched = run([
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
    expect(switched.status, switched.stdout + switched.stderr).toBe(0);
    const switchedRecord = readConfigDiagnosticRecords(
      join(project, ".claude"),
    ).providers;
    expect(switchedRecord?.provider).toBe("amazon-bedrock");
    expect(switchedRecord?.acknowledged).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("legacy Codex Bedrock records acquire new required actions on load and refresh", () => {
    const project = install("codex");
    const dataPath = join(project, ".codex", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(dataPath, "utf-8"));
    const legacyRecord: ProvidersRecord = {
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "us-east-1",
      acknowledged: true,
      pendingActions: [
        { id: "bedrock-model-access", status: "done" },
      ],
    };
    expect(reconcileProviderActions(legacyRecord, "codex", false).pendingActions)
      .toContainEqual({
        id: "codex-provider-configuration",
        status: "pending",
      });
    expect(reconcileProviderActions(legacyRecord, "codex", true).pendingActions)
      .toContainEqual({
        id: "codex-provider-configuration",
        status: "done",
      });
    data.providers = legacyRecord;
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);

    expect(
      readConfigDiagnosticRecords(join(project, ".codex")).providers
        ?.pendingActions,
    ).toContainEqual({
      id: "codex-provider-configuration",
      status: "pending",
    });
    const check = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, runtimeEnv());
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("codex-provider-configuration");

    const refreshed = run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, runtimeEnv());
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    const persisted = JSON.parse(readFileSync(dataPath, "utf-8"));
    expect(persisted.providers.pendingActions).toContainEqual({
      id: "codex-provider-configuration",
      status: "pending",
    });
    const refreshedCheck = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, runtimeEnv());
    expect(refreshedCheck.status).toBe(1);
    expect(refreshedCheck.stdout).toContain("codex-provider-configuration");

    const reapplied = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--yes",
    ], project, runtimeEnv());
    expect(reapplied.status, reapplied.stdout + reapplied.stderr).toBe(0);
    expect(JSON.parse(readFileSync(dataPath, "utf-8")).providers.pendingActions)
      .toContainEqual({
        id: "codex-provider-configuration",
        status: "pending",
      });
    const reappliedCheck = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, runtimeEnv());
    expect(reappliedCheck.status).toBe(1);
    expect(reappliedCheck.stdout).toContain("codex-provider-configuration");

    const acknowledged = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--acknowledge",
      "--yes",
    ], project, runtimeEnv());
    expect(acknowledged.status, acknowledged.stdout + acknowledged.stderr).toBe(0);
    const acknowledgedCheck = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, runtimeEnv());
    expect(acknowledgedCheck.status, acknowledgedCheck.stdout + acknowledgedCheck.stderr)
      .toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("completed Codex Bedrock setup stays visibly self-attested", () => {
    const project = install("codex");
    const dataPath = join(project, ".codex", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(dataPath, "utf-8"));
    data.providers = {
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "us-east-1",
      pendingActions: [
        { id: "bedrock-model-access", status: "done" },
        { id: "codex-provider-configuration", status: "done" },
      ],
    };
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);

    const issues = providerIssues(
      project,
      ".codex",
      "codex",
      readConfigDiagnosticRecords(join(project, ".codex")).providers,
      {
        hasCredentials: true,
        sources: [],
        profiles: [],
        regions: [],
        files: [],
      },
    );
    expect(issues).toContainEqual(expect.objectContaining({
      id: "provider-codex-self-attested",
      severity: "warn",
    }));
    const check = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
      "--json",
    ], project, runtimeEnv());
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toContain("provider-codex-self-attested");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Claude local provider overrides are reported as warnings", () => {
    const project = temp("aidlc-t294-claude-local-provider-");
    cpSync(join(DIST, "claude"), project, { recursive: true });
    writeFileSync(
      join(project, ".claude", "settings.local.json"),
      `${JSON.stringify({
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: "eu-west-1",
        },
      }, null, 2)}\n`,
    );
    const issues = providerIssues(project, ".claude", "claude", {
      schemaVersion: 1,
      provider: "current",
    });
    expect(issues).toContainEqual(expect.objectContaining({
      id: "provider-claude-local-override",
      severity: "warn",
    }));
  });

  test("Claude local overrides that contradict Bedrock block check and doctor", () => {
    const project = install("claude");
    const env = runtimeEnv({
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
    });
    const configured = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-east-1",
      "--mark-done",
      "bedrock-model-access",
      "--yes",
    ], project, env);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    writeFileSync(
      join(project, ".claude", "settings.local.json"),
      `${JSON.stringify({
        env: {
          CLAUDE_CODE_USE_BEDROCK: "0",
          AWS_REGION: "eu-west-1",
        },
      }, null, 2)}\n`,
    );
    const check = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env);
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("provider-claude-local-override");
    const previousAccess = process.env.AWS_ACCESS_KEY_ID;
    const previousSecret = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    expect(providerDoctorCheck(project)).toEqual(expect.objectContaining({
      pass: false,
      label: "Providers: 1 unmet item(s)",
    }));
    if (previousAccess === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = previousAccess;
    if (previousSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previousSecret;
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("ordinary refresh preserves user-owned Codex provider fields", () => {
    const project = install("codex");
    const env = runtimeEnv();
    const recorded = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const configPath = join(project, ".codex", "config.toml");
    const current = readFileSync(configPath, "utf-8");
    writeFileSync(
      configPath,
      withLegacyCodexProviderBlock(current,
        `model = "team-model"\n` +
          `model_provider = "team-provider"\n` +
          `model_context_window = 262144\n` +
          `model_reasoning_effort = "low"\n\n` +
          `[model_providers.team-provider]\n` +
          `name = "Team Provider"\n\n`),
    );
    const refreshed = run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, env);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain('model = "team-model"');
    expect(after).toContain('model_provider = "team-provider"');
    expect(after).toContain('model_reasoning_effort = "low"');
    expect(after).toContain("[model_providers.team-provider]");
    expect(() => parseToml(after)).not.toThrow();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("pristine Codex refresh remains valid and byte-idempotent", () => {
    const project = install("codex");
    const env = runtimeEnv();
    const configPath = join(project, ".codex", "config.toml");
    const refresh = () => run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, env);
    const first = refresh();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const firstText = readFileSync(configPath, "utf-8");
    expect(() => parseToml(firstText)).not.toThrow();
    const second = refresh();
    expect(second.status, second.stdout + second.stderr).toBe(0);
    const secondText = readFileSync(configPath, "utf-8");
    expect(() => parseToml(secondText)).not.toThrow();
    expect(secondText).toBe(firstText);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("provider mutation preserves project fields but rejects Codex framework drift", () => {
    const env = runtimeEnv();
    const claude = install("claude");
    const claudePath = join(claude, ".claude", "settings.json");
    const claudeSettings = JSON.parse(readFileSync(claudePath, "utf-8"));
    claudeSettings.model = "team-claude-model";
    claudeSettings.env.MY_TEAM_SETTING = "preserved";
    writeFileSync(claudePath, `${JSON.stringify(claudeSettings, null, 2)}\n`);
    const claudeRecorded = run([
      "config",
      "providers",
      "--project-dir",
      claude,
      "--provider",
      "current",
      "--yes",
    ], claude, env);
    expect(
      claudeRecorded.status,
      claudeRecorded.stdout + claudeRecorded.stderr,
    ).toBe(0);
    expect(JSON.parse(readFileSync(claudePath, "utf-8")))
      .toEqual(expect.objectContaining({
        model: "team-claude-model",
        env: expect.objectContaining({ MY_TEAM_SETTING: "preserved" }),
      }));
    const claudeRefreshed = run([
      "config",
      "--project-dir",
      claude,
      "--yes",
    ], claude, env);
    expect(
      claudeRefreshed.status,
      claudeRefreshed.stdout + claudeRefreshed.stderr,
    ).toBe(0);
    expect(JSON.parse(readFileSync(claudePath, "utf-8")))
      .toEqual(expect.objectContaining({
        model: "team-claude-model",
        env: expect.objectContaining({ MY_TEAM_SETTING: "preserved" }),
      }));

    const codex = install("codex");
    const codexPath = join(codex, ".codex", "config.toml");
    writeFileSync(
      codexPath,
      withLegacyCodexProviderBlock(
        readFileSync(codexPath, "utf-8"),
        `model = "team-model"\nmodel_provider = "team-provider"\n\n` +
          `[model_providers.team-provider]\nname = "Team Provider"\n\n`,
      )
        .replace("# AI-DLC on Codex CLI", "# Team-owned Codex instructions")
        .replace(
          'set = { AIDLC_RULES_DIR = "aidlc/spaces/default/memory" }',
          'set = { AIDLC_RULES_DIR = "team/rules" }',
        )
        .replace(
          'sandbox_mode = "workspace-write"',
          'sandbox_mode = "read-only"',
        ),
    );
    const codexRecorded = run([
      "config",
      "providers",
      "--project-dir",
      codex,
      "--provider",
      "current",
      "--yes",
    ], codex, env);
    expect(
      codexRecorded.status,
      codexRecorded.stdout + codexRecorded.stderr,
    ).toBe(0);
    expect(parseToml(readFileSync(codexPath, "utf-8")).sandbox_mode).toBe("read-only");
    expect(readFileSync(codexPath, "utf-8"))
      .toContain("# Team-owned Codex instructions");
    expect(readFileSync(codexPath, "utf-8"))
      .toContain('AIDLC_RULES_DIR = "team/rules"');
    const codexRefreshed = run([
      "config",
      "--project-dir",
      codex,
      "--yes",
    ], codex, env);
    expect(
      codexRefreshed.status,
      codexRefreshed.stdout + codexRefreshed.stderr,
    ).toBe(4);
    expect(parseToml(readFileSync(codexPath, "utf-8")).sandbox_mode).toBe("read-only");
    const codexRepaired = run([
      "config",
      "--project-dir",
      codex,
      "--force",
      "--yes",
    ], codex, env);
    expect(codexRepaired.status, codexRepaired.stdout + codexRepaired.stderr)
      .toBe(0);
    expect(parseToml(readFileSync(codexPath, "utf-8")).sandbox_mode).toBe("workspace-write");
    expect(readFileSync(codexPath, "utf-8"))
      .toContain("# AI-DLC on Codex CLI");
    expect(readFileSync(codexPath, "utf-8"))
      .not.toContain("# Team-owned Codex instructions");
    expect(readFileSync(codexPath, "utf-8"))
      .toContain('AIDLC_RULES_DIR = "aidlc/spaces/default/memory"');
    expect(readFileSync(codexPath, "utf-8"))
      .toContain('model = "team-model"');
    expect(readFileSync(codexPath, "utf-8"))
      .toContain("[model_providers.team-provider]");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Codex refresh repairs only the owned root sandbox mode, not prose or custom-table keys", () => {
    const project = install("codex");
    const env = runtimeEnv();
    const configPath = join(project, ".codex", "config.toml");
    const shipped = readFileSync(configPath, "utf-8");
    const prose = 'sandbox_mode = "danger-full-access"';
    const custom = '\n[model_providers.team-provider]\nname = "Team Provider"\nsandbox_mode = "team-value"\n';
    const edited = shipped
      .replace('sandbox_mode = "workspace-write"', '"sandbox_mode" = \'read-only\'')
      .replace("# AI-DLC on Codex CLI", `# AI-DLC on Codex CLI\n${prose}`) + custom;
    writeFileSync(configPath, edited);
    const args = ["config", "--project-dir", project, "--yes"];
    const refused = run(args, project, env);
    expect(refused.status, refused.stdout + refused.stderr).toBe(4);
    expect(readFileSync(configPath, "utf-8")).toBe(edited);
    const forced = run([...args, "--force"], project, env);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    const repaired = parseToml(readFileSync(configPath, "utf-8"));
    expect(repaired.sandbox_mode).toBe("workspace-write");
    expect(repaired.model_providers).toEqual({
      "team-provider": { name: "Team Provider", sandbox_mode: "team-value" },
    });
    expect(repaired.developer_instructions).not.toContain(prose);

    // Removing the owned root key must not promote a same-named custom-table key.
    const missing = (shipped + custom).replace(/^sandbox_mode = "workspace-write"\n/m, "");
    writeFileSync(configPath, missing);
    const missingRefused = run(args, project, env);
    expect(missingRefused.status, missingRefused.stdout + missingRefused.stderr).toBe(4);
    expect(readFileSync(configPath, "utf-8")).toBe(missing);
    const restored = run([...args, "--force"], project, env);
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    const restoredConfig = parseToml(readFileSync(configPath, "utf-8"));
    expect(restoredConfig.sandbox_mode).toBe("workspace-write");
    expect(restoredConfig.model_providers).toEqual(repaired.model_providers);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("release refresh adds framework developer instructions to a legacy Codex config", () => {
    const project = install("codex");
    const env = runtimeEnv();
    const configPath = join(project, ".codex", "config.toml");
    const legacyFrameworkConfig = readFileSync(configPath, "utf-8").replace(
      /^[\t ]*developer_instructions[\t ]*=[\t ]*'''[\s\S]*?'''[\t ]*(?:\r?\n|$)/m,
      "",
    );
    const manifestPath = join(
      project,
      ".codex",
      "tools",
      "data",
      "aidlc-manifest.json",
    );
    const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    delete legacyManifest.entries[".codex/config.toml"].developer_instructions;
    writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    const legacyProviderBlock =
      `# D-9: Amazon Bedrock is the shipped default provider (web_search is\n` +
      `# unavailable there; the market-research stage degrades gracefully). For\n` +
      `# OpenAI-auth setups, comment out model_provider and the [model_providers]\n` +
      `# block.\n` +
      `model = "openai.gpt-5.5"\nmodel_provider = "amazon-bedrock"\n` +
      `model_context_window = 1000000\nmodel_reasoning_effort = "high"\n\n` +
      `[model_providers.amazon-bedrock.aws]\n` +
      `# Set to your AWS profile/region with Bedrock model access.\n` +
      `profile = "default"\nregion = "us-east-1"\n\n`;
    writeFileSync(configPath, withLegacyCodexProviderBlock(legacyFrameworkConfig, legacyProviderBlock));

    const cleaned = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(cleaned.status, cleaned.stdout + cleaned.stderr).toBe(0);
    const refreshed = run([
      "config",
      "--project-dir",
      project,
      "--from",
      join(DIST_RELEASE, "codex"),
      "--harness",
      "codex",
      "--yes",
    ], project, env);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    const after = readFileSync(configPath, "utf-8");
    expect(() => parseToml(after)).not.toThrow();
    expect(after).toContain("developer_instructions = '''");
    expect(after).toContain("# AI-DLC on Codex CLI");
    expect(after).not.toContain("[model_providers.amazon-bedrock.aws]");
    expect(after).not.toContain('model_provider = "amazon-bedrock"');
    expect(typeof parseToml(after).developer_instructions).toBe("string");
    expect(parseToml(after).sandbox_mode).toBe("workspace-write");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("refresh treats deleted Codex developer instructions as framework drift", () => {
    const project = install("codex");
    const env = runtimeEnv();
    const configPath = join(project, ".codex", "config.toml");
    const withoutInstructions = readFileSync(configPath, "utf-8").replace(
      /^[\t ]*developer_instructions[\t ]*=[\t ]*'''[\s\S]*?'''[\t ]*(?:\r?\n|$)/m,
      "",
    );
    writeFileSync(configPath, withoutInstructions);

    const refreshed = run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, env);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(4);
    expect(readFileSync(configPath, "utf-8")).toBe(withoutInstructions);

    const forced = run([
      "config",
      "--project-dir",
      project,
      "--force",
      "--yes",
    ], project, env);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(readFileSync(configPath, "utf-8"))
      .toContain("developer_instructions = '''");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("refresh conflicts on Claude permissions drift and force restores the baseline", () => {
    const project = install("claude");
    const env = runtimeEnv();
    expect(run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env).status).toBe(0);
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.env.MY_TEAM_SETTING = "preserved";
    settings.permissions = {
      ...(settings.permissions ?? {}),
      deny: ["Bash(team-command:*)"],
    };
    const edited = `${JSON.stringify(settings, null, 2)}\n`;
    writeFileSync(settingsPath, edited);
    const refreshed = run([
      "config",
      "--project-dir",
      project,
      "--from",
      join(DIST_RELEASE, "claude"),
      "--harness",
      "claude",
      "--yes",
    ], project, env);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(4);
    expect(readFileSync(settingsPath, "utf-8")).toBe(edited);
    const forced = run([
      "config",
      "--project-dir",
      project,
      "--from",
      join(DIST_RELEASE, "claude"),
      "--harness",
      "claude",
      "--force",
      "--yes",
    ], project, env);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.permissions).not.toEqual(settings.permissions);
    expect(after.permissions.deny).toBeUndefined();
    expect(after.env.MY_TEAM_SETTING).toBe("preserved");
    expect(after.hooks).toEqual(settings.hooks);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Bedrock refresh preserves project fields but rejects Claude framework drift", () => {
    const env = runtimeEnv();
    for (const change of ["permissions", "env", "pristine"]) {
      const project = install("claude");
      const configured = run([
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
      expect(configured.status, configured.stdout + configured.stderr).toBe(0);
      const settingsPath = join(project, ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const shippedPermissions = structuredClone(settings.permissions);
      if (change !== "pristine") settings.env.MY_TEAM_SETTING = "preserved";
      if (change === "permissions") {
        settings.permissions = {
          ...(settings.permissions ?? {}),
          deny: ["Bash(team-command:*)"],
        };
      }
      const edited = `${JSON.stringify(settings, null, 2)}\n`;
      if (change !== "pristine") writeFileSync(settingsPath, edited);
      let refreshed = run([
        "config",
        "--project-dir",
        project,
        "--from",
        join(DIST_RELEASE, "claude"),
        "--harness",
        "claude",
        "--yes",
      ], project, env);
      expect(refreshed.status, refreshed.stdout + refreshed.stderr)
        .toBe(change === "permissions" ? 4 : 0);
      if (change === "permissions") {
        refreshed = run([
          "config",
          "--project-dir",
          project,
          "--from",
          join(DIST_RELEASE, "claude"),
          "--harness",
          "claude",
          "--force",
          "--yes",
        ], project, env);
        expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
      }
      const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(after.permissions).toEqual(
        change === "permissions" ? shippedPermissions : settings.permissions,
      );
      expect(after.hooks).toEqual(settings.hooks);
      expect(after.env).toEqual(expect.objectContaining({
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
      }));
      if (change !== "pristine") expect(after.env.MY_TEAM_SETTING).toBe("preserved");
      if (change === "permissions") {
        const current = run([
          "config",
          "providers",
          "--project-dir",
          project,
          "--provider",
          "current",
          "--yes",
        ], project, env);
        expect(current.status, current.stdout + current.stderr).toBe(0);
        const optedOut = JSON.parse(readFileSync(settingsPath, "utf-8"));
        expect(optedOut.permissions).toEqual(shippedPermissions);
        expect(optedOut.env.MY_TEAM_SETTING).toBe("preserved");
        expect(optedOut.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
        expect(optedOut.hooks).toEqual(settings.hooks);
      }
    }

    for (const provider of ["current", "amazon-bedrock"]) {
      const project = install("claude");
      const configured = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--provider",
        provider,
        ...(provider === "amazon-bedrock" ? ["--region", "us-east-1"] : []),
        "--yes",
      ], project, env);
      expect(configured.status, configured.stdout + configured.stderr).toBe(0);
      const settingsPath = join(project, ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      settings.disableAllHooks = true;
      const edited = `${JSON.stringify(settings, null, 2)}\n`;
      writeFileSync(settingsPath, edited);
      const refreshed = run([
        "config",
        "--project-dir",
        project,
        "--from",
        join(DIST_RELEASE, "claude"),
        "--harness",
        "claude",
        "--yes",
      ], project, env);
      expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
      const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(after.disableAllHooks).toBe(true);
      expect(after.hooks).toEqual(settings.hooks);
      expect(after.env).toEqual(settings.env);
      expect(refreshed.stdout).not.toContain("Note: kept your");
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("refresh rejects changed shipped Claude entries and force restores them", () => {
    const env = runtimeEnv();
    const source = temp("aidlc-t294-claude-entries-source-");
    cpSync(join(DIST_RELEASE, "claude"), source, { recursive: true });
    const sourceSettingsPath = join(source, ".claude", "settings.json");
    const release = JSON.parse(readFileSync(sourceSettingsPath, "utf-8"));
    release.permissions.allow.push("Bash(team-tool:*)");
    const extraStopHook = {
      matcher: "",
      hooks: [{ type: "command", command: "aidlc engine hook validate-state" }],
    };
    release.hooks.Stop.push(extraStopHook);
    writeFileSync(sourceSettingsPath, `${JSON.stringify(release, null, 2)}\n`);

    const pristine = install("claude");
    const pristineRefresh = run([
      "config",
      "--project-dir",
      pristine,
      "--from",
      source,
      "--harness",
      "claude",
      "--yes",
    ], pristine, env);
    expect(pristineRefresh.status, pristineRefresh.stdout + pristineRefresh.stderr).toBe(0);
    const pristineSettings = JSON.parse(
      readFileSync(join(pristine, ".claude", "settings.json"), "utf-8"),
    );
    expect(pristineSettings.permissions).toEqual(release.permissions);
    expect(pristineSettings.hooks.Stop).toEqual(release.hooks.Stop);

    const project = install("claude");
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.permissions.deny = ["Bash(team-command:*)"];
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const args = [
      "config",
      "--project-dir",
      project,
      "--from",
      source,
      "--harness",
      "claude",
      "--yes",
    ];
    const dryRun = run([...args, "--dry-run"], project, env);
    expect(dryRun.status, dryRun.stdout + dryRun.stderr).toBe(4);
    expect(dryRun.stdout + dryRun.stderr).toContain(
      ".claude/settings.json (locally modified or unowned)",
    );
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(settings);
    const dryJson = run([...args, "--dry-run", "--json"], project, env);
    expect(dryJson.status, dryJson.stdout + dryJson.stderr).toBe(4);

    const refreshed = run(args, project, env);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(4);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(settings);
    const forced = run([...args, "--force"], project, env);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.permissions).toEqual(release.permissions);
    expect(after.permissions.allow).toContain("Bash(team-tool:*)");
    expect(after.hooks.Stop).toEqual(release.hooks.Stop);
    const baseline = JSON.parse(readFileSync(
      join(project, ".claude", "tools", "data", "aidlc-manifest.json"),
      "utf-8",
    ));
    expect(baseline.entries[".claude/settings.json"]).toEqual({
      companyAnnouncements: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      permissions: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      statusLine: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      hooks: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("refresh rejects a user-edited Codex framework table and force restores it", () => {
    const env = runtimeEnv();
    const project = install("codex");
    const configPath = join(project, ".codex", "config.toml");
    const userStatus = ["git-branch", "context-used"];
    const edited = readFileSync(configPath, "utf-8").replace(
      /^status_line\s*=.*$/m,
      `status_line = ${JSON.stringify(userStatus)}`,
    );
    writeFileSync(configPath, edited);
    const ordinary = run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, env);
    expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(4);
    expect(parseToml(readFileSync(configPath, "utf-8")).tui)
      .toEqual({ status_line: userStatus });

    const source = temp("aidlc-t294-codex-entries-source-");
    cpSync(join(DIST_RELEASE, "codex"), source, { recursive: true });
    const sourceConfigPath = join(source, ".codex", "config.toml");
    const releaseStatus = ["model-with-reasoning", "context-used"];
    writeFileSync(sourceConfigPath, readFileSync(sourceConfigPath, "utf-8").replace(
      /^status_line\s*=.*$/m,
      `status_line = ${JSON.stringify(releaseStatus)}`,
    ));
    const refreshed = run([
      "config",
      "--project-dir",
      project,
      "--from",
      source,
      "--harness",
      "codex",
      "--yes",
    ], project, env);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(4);
    expect(parseToml(readFileSync(configPath, "utf-8")).tui)
      .toEqual({ status_line: userStatus });
    const forced = run([
      "config",
      "--project-dir",
      project,
      "--from",
      source,
      "--harness",
      "codex",
      "--force",
      "--yes",
    ], project, env);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(parseToml(readFileSync(configPath, "utf-8")).tui)
      .toEqual({ status_line: releaseStatus });

    const pristine = install("codex");
    const pristineRefresh = run([
      "config",
      "--project-dir",
      pristine,
      "--from",
      source,
      "--harness",
      "codex",
      "--yes",
    ], pristine, env);
    expect(pristineRefresh.status, pristineRefresh.stdout + pristineRefresh.stderr).toBe(0);
    expect(parseToml(readFileSync(join(pristine, ".codex", "config.toml"), "utf-8")).tui)
      .toEqual({ status_line: releaseStatus });
    const baseline = JSON.parse(readFileSync(
      join(project, ".codex", "tools", "data", "aidlc-manifest.json"),
      "utf-8",
    ));
    expect(baseline.entries[".codex/config.toml"]).toEqual({
      agents: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      developer_instructions: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      features: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sandbox_mode: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sandbox_workspace_write: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      shell_environment_policy: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      tools: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      tui: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("record-only answers never adopt local drift into the ownership baseline", () => {
    const env = runtimeEnv();
    for (const [harness, harnessDir] of [["claude", ".claude"], ["opencode", ".aidlc"]]) {
      for (const modified of [true, false]) {
        const project = install(harness);
        const manifestPath = join(project, harnessDir, "tools", "data", "aidlc-manifest.json");
        const before = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const rel = harness === "claude" ? ".claude/hooks/aidlc-session-end.ts" : "opencode.json";
        const path = join(project, rel);
        const userHook = ".claude/hooks/aidlc-team.ts";
        if (modified) {
          if (harness === "claude") {
            writeFileSync(path, `${readFileSync(path, "utf-8")}\n// local hook edit\n`);
            writeFileSync(join(project, userHook), "// user-owned hook\n");
          } else {
            const settings = JSON.parse(readFileSync(path, "utf-8"));
            settings.mcp = {
              ...settings.mcp,
              "team-service": { type: "local", command: ["team-tool"] },
            };
            writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
          }
        }
        const current = readFileSync(path, "utf-8");
        const answer = run([
          "config",
          "providers",
          "--provider",
          harness === "claude" ? "current" : "amazon-bedrock",
          ...(harness === "opencode" ? ["--region", "eu-west-1", "--opencode-default", "yes"] : []),
          "--yes",
        ], project, env);
        expect(answer.status, answer.stdout + answer.stderr).toBe(0);
        const after = JSON.parse(readFileSync(manifestPath, "utf-8"));
        expect(after.entries).toEqual(before.entries);
        if (harness === "claude") {
          expect(readFileSync(path, "utf-8")).toBe(current);
          expect(after.files[rel]).toBe(before.files[rel]);
          expect(after.files[userHook]).toBeUndefined();
          expect(after.rootContributions).toEqual(before.rootContributions);
        } else {
          const settings = JSON.parse(readFileSync(path, "utf-8"));
          expect(settings.mcp).toEqual(JSON.parse(current).mcp);
          expect(settings.provider["amazon-bedrock"].options.region).toBe("eu-west-1");
          if (modified) {
            expect(after.rootContributions[rel]).toEqual(before.rootContributions[rel]);
          } else {
            expect(after.rootContributions[rel]).not.toEqual(before.rootContributions[rel]);
          }
        }
        const refresh = run([
          "config",
          "--from",
          join(DIST_RELEASE, harness),
          "--harness",
          harness,
          "--yes",
        ], project, env);
        expect(refresh.status, refresh.stdout + refresh.stderr).toBe(modified ? 4 : 0);
        if (modified) {
          expect(refresh.stdout).toContain(rel);
          expect(refresh.stdout).toContain(
            harness === "claude" ? "locally modified or unowned" : "unowned whole file",
          );
        }
      }
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("record-only answers establish ownership for manifest-less copy-channel projections", () => {
    for (const [harness, harnessDir] of [["claude", ".claude"], ["opencode", ".aidlc"]]) {
      for (const env of [runtimeEnv(), runtimeEnv({ AIDLC_RUNTIME_ROOT: "" })]) {
        const project = temp(`aidlc-t294-copy-baseline-${harness}-`);
        mkdirSync(join(project, ".git"), { recursive: true });
        cpSync(join(DIST, harness), project, { recursive: true });
        const manifestPath = join(project, harnessDir, "tools", "data", "aidlc-manifest.json");
        expect(existsSync(manifestPath)).toBe(false);

        const recorded = run([
          "config",
          "providers",
          "--project-dir",
          project,
          "--provider",
          "current",
          "--yes",
        ], project, env);
        expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);

        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        expect(Object.keys(manifest.files).length).toBeGreaterThan(0);
        if (harness === "opencode") {
          expect(manifest.rootContributions["opencode.json"]).toBeDefined();
        }

        const refreshed = run([
          "config",
          "--project-dir",
          project,
          "--from",
          join(DIST_RELEASE, harness),
          "--harness",
          harness,
          "--yes",
        ], project, env);
        expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
        expect(refreshed.stdout).not.toContain("locally modified or unowned");
        expect(refreshed.stdout).not.toContain("unowned whole file");
        rmSync(project, { recursive: true, force: true });
      }
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("provider answers preserve project fields and reject framework drift", () => {
    const env = runtimeEnv();
    const opencode = install("opencode");
    const opencodePath = join(opencode, "opencode.json");
    const opencodeSettings = JSON.parse(readFileSync(opencodePath, "utf-8"));
    opencodeSettings.mcp = {
      ...opencodeSettings.mcp,
      "team-service": { type: "local", command: ["team-tool"] },
    };
    writeFileSync(opencodePath, `${JSON.stringify(opencodeSettings, null, 2)}\n`);
    const opencodeAnswer = run([
      "config",
      "providers",
      "--project-dir",
      opencode,
      "--provider",
      "amazon-bedrock",
      "--region",
      "eu-west-1",
      "--opencode-default",
      "yes",
      "--yes",
    ], opencode, env);
    expect(opencodeAnswer.status, opencodeAnswer.stdout + opencodeAnswer.stderr).toBe(0);
    const opencodeAfter = JSON.parse(readFileSync(opencodePath, "utf-8"));
    expect(opencodeAfter.mcp).toEqual(opencodeSettings.mcp);
    expect(opencodeAfter.provider["amazon-bedrock"].options.region).toBe("eu-west-1");

    const codex = install("codex");
    const codexPath = join(codex, ".codex", "config.toml");
    const userStatus = ["git-branch"];
    const edited = readFileSync(codexPath, "utf-8").replace(
      /^status_line\s*=.*$/m,
      `status_line = ${JSON.stringify(userStatus)}`,
    );
    const legacyBlock =
      `# D-9: Amazon Bedrock is the shipped default provider (web_search is\n` +
      `# unavailable there; the market-research stage degrades gracefully). For\n` +
      `# OpenAI-auth setups, comment out model_provider and the [model_providers]\n` +
      `# block.\n` +
      `model = "openai.gpt-5.5"\nmodel_provider = "amazon-bedrock"\n` +
      `model_context_window = 1000000\nmodel_reasoning_effort = "high"\n\n` +
      `[model_providers.amazon-bedrock.aws]\n` +
      `# Set to your AWS profile/region with Bedrock model access.\n` +
      `profile = "default"\nregion = "us-east-1"\n\n`;
    const legacyEdited = withLegacyCodexProviderBlock(edited, legacyBlock);
    writeFileSync(codexPath, legacyEdited);
    const codexAnswer = run([
      "config",
      "providers",
      "--project-dir",
      codex,
      "--provider",
      "current",
      "--yes",
    ], codex, env);
    expect(codexAnswer.status, codexAnswer.stdout + codexAnswer.stderr).toBe(4);
    const codexAfter = readFileSync(codexPath, "utf-8");
    expect(codexAfter).toBe(legacyEdited);
    expect(parseToml(codexAfter).tui).toEqual({ status_line: userStatus });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("opting out of a recorded Bedrock answer removes shipped Claude aliases and keeps customized ones", () => {
    const env = runtimeEnv();
    for (const opusModel of [
      "my-custom-opus",
      "global.anthropic.claude-opus-4-8[1m]",
    ]) {
      const project = install("claude");
      const configured = run([
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
      expect(configured.status, configured.stdout + configured.stderr).toBe(0);
      const settingsPath = join(project, ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const scope = settings.env.AWS_AIDLC_DEFAULT_SCOPE;
      Object.assign(settings.env, {
        ANTHROPIC_DEFAULT_FABLE_MODEL:
          "global.anthropic.claude-fable-5[1m]",
        ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL:
          "global.anthropic.claude-sonnet-4-6[1m]",
        ANTHROPIC_DEFAULT_HAIKU_MODEL:
          "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      });
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      const changed = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--provider",
        "current",
        "--yes",
      ], project, env);
      expect(changed.status, changed.stdout + changed.stderr).toBe(0);
      const after = JSON.parse(readFileSync(settingsPath, "utf-8")).env;
      for (const key of [
        "CLAUDE_CODE_USE_BEDROCK",
        "AWS_REGION",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      ]) {
        expect(after[key], key).toBeUndefined();
      }
      expect(after.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
        opusModel === "my-custom-opus" ? opusModel : undefined,
      );
      expect(after.AWS_AIDLC_DEFAULT_SCOPE).toBe(scope);
      const check = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--check",
      ], project, env);
      expect(check.status, check.stdout + check.stderr).toBe(0);
      expect(check.stdout).toContain("clean for claude");
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("provider changes and ordinary refresh preserve a directly customized Claude default scope", () => {
    const project = install("claude");
    const env = runtimeEnv();
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.env.AWS_AIDLC_DEFAULT_SCOPE = "feature";
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    const provider = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(provider.status, provider.stdout + provider.stderr).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).env.AWS_AIDLC_DEFAULT_SCOPE)
      .toBe("feature");

    const refreshed = run([
      "config",
      "--project-dir",
      project,
      "--from",
      join(DIST_RELEASE, "claude"),
      "--harness",
      "claude",
      "--yes",
    ], project, env);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).env.AWS_AIDLC_DEFAULT_SCOPE)
      .toBe("feature");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("reset removes the OpenCode provider block AI-DLC wrote and keeps a user-authored one", () => {
    const env = runtimeEnv();
    for (const customized of [false, true]) {
      const project = install("opencode");
      const configured = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--provider",
        "amazon-bedrock",
        "--region",
        "us-east-1",
        "--opencode-default",
        "yes",
        "--yes",
      ], project, env);
      expect(configured.status, configured.stdout + configured.stderr).toBe(0);
      const path = join(project, "opencode.json");
      const config = JSON.parse(readFileSync(path, "utf-8"));
      expect(config.provider["amazon-bedrock"].options.region).toBe("us-east-1");
      if (customized) {
        config.provider["amazon-bedrock"].options.region = "eu-west-1";
        writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
      }
      const reset = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--reset",
        "--yes",
      ], project, env);
      expect(reset.status, reset.stdout + reset.stderr).toBe(0);
      const after = JSON.parse(readFileSync(path, "utf-8"));
      if (customized) {
        expect(after.provider).toEqual(config.provider);
      } else {
        expect(after.provider).toBeUndefined();
      }
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("reset and keep-current remove only the OpenCode provider options AI-DLC wrote", () => {
    const env = runtimeEnv();
    const models = { "anthropic.claude-sonnet-4-6": { name: "Sonnet" } };
    for (const flags of [["--reset"], ["--provider", "current"]]) {
      const project = install("opencode");
      const configured = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--provider",
        "amazon-bedrock",
        "--region",
        "us-east-1",
        "--opencode-default",
        "yes",
        "--yes",
      ], project, env);
      expect(configured.status, configured.stdout + configured.stderr).toBe(0);
      const path = join(project, "opencode.json");
      const config = JSON.parse(readFileSync(path, "utf-8"));
      config.provider["amazon-bedrock"].options.maxRetries = 3;
      config.provider["amazon-bedrock"].models = models;
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      const refreshed = run([
        "config",
        "--project-dir",
        project,
        "--yes",
      ], project, env);
      expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf-8")).provider["amazon-bedrock"])
        .toEqual({ models, options: { region: "us-east-1", maxRetries: 3 } });

      const cleared = run([
        "config",
        "providers",
        "--project-dir",
        project,
        ...flags,
        "--yes",
      ], project, env);
      expect(cleared.status, cleared.stdout + cleared.stderr).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf-8")).provider["amazon-bedrock"])
        .toEqual({ models, options: { maxRetries: 3 } });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("OpenCode other treats retained user Bedrock providers as intentional warnings", () => {
    const env = runtimeEnv();

    const userProject = install("opencode");
    const userPath = join(userProject, "opencode.json");
    const userConfig = JSON.parse(readFileSync(userPath, "utf-8"));
    userConfig.provider = {
      "team-provider": { npm: "@example/provider" },
      "amazon-bedrock": {
        models: { "team-model": { name: "Team model" } },
        options: { region: "eu-west-1", maxRetries: 3 },
      },
    };
    writeFileSync(userPath, `${JSON.stringify(userConfig, null, 2)}\n`);
    const recordedOther = run([
      "config",
      "providers",
      "--project-dir",
      userProject,
      "--provider",
      "other",
      "--acknowledge",
      "--yes",
    ], userProject, env);
    expect(recordedOther.status, recordedOther.stdout + recordedOther.stderr).toBe(0);
    const userCheck = run([
      "config",
      "providers",
      "--project-dir",
      userProject,
      "--check",
    ], userProject, env);
    expect(userCheck.status, userCheck.stdout + userCheck.stderr).toBe(0);
    expect(userCheck.stdout).toContain("provider-opencode-project-override");
    expect(userCheck.stdout).toContain("warning(s)");

    const transitioned = install("opencode");
    const configured = run([
      "config",
      "providers",
      "--project-dir",
      transitioned,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-east-1",
      "--opencode-default",
      "yes",
      "--yes",
    ], transitioned, env);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    const transitionedPath = join(transitioned, "opencode.json");
    const transitionedConfig = JSON.parse(readFileSync(transitionedPath, "utf-8"));
    transitionedConfig.provider["amazon-bedrock"].models = {
      "team-model": { name: "Team model" },
    };
    transitionedConfig.provider["amazon-bedrock"].options.maxRetries = 3;
    writeFileSync(
      transitionedPath,
      `${JSON.stringify(transitionedConfig, null, 2)}\n`,
    );
    const changed = run([
      "config",
      "providers",
      "--project-dir",
      transitioned,
      "--provider",
      "other",
      "--acknowledge",
      "--yes",
    ], transitioned, env);
    expect(changed.status, changed.stdout + changed.stderr).toBe(0);
    const transitionedCheck = run([
      "config",
      "providers",
      "--project-dir",
      transitioned,
      "--check",
    ], transitioned, env);
    expect(transitionedCheck.status, transitionedCheck.stdout + transitionedCheck.stderr)
      .toBe(0);
    expect(transitionedCheck.stdout).toContain("provider-opencode-project-override");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("keep-current preserves a customized legacy Codex Bedrock table and removes a record-written one", () => {
    const legacyBlock =
      `# D-9: Amazon Bedrock is the shipped default provider (web_search is\n` +
      `# unavailable there; the market-research stage degrades gracefully). For\n` +
      `# OpenAI-auth setups, comment out model_provider and the [model_providers]\n` +
      `# block.\n` +
      `model = "openai.gpt-5.5"\nmodel_provider = "amazon-bedrock"\n` +
      `model_context_window = 1000000\nmodel_reasoning_effort = "high"\n\n` +
      `[model_providers.amazon-bedrock.aws]\n` +
      `# Set to your AWS profile/region with Bedrock model access.\n` +
      `profile = "team"\nregion = "eu-west-1"\n\n`;
    for (const env of [runtimeEnv(), runtimeEnv({ AIDLC_RUNTIME_ROOT: "" })]) {
      const project = install("codex");
      const configPath = join(project, ".codex", "config.toml");
      const customized = withLegacyCodexProviderBlock(
        readFileSync(configPath, "utf-8"),
        legacyBlock,
      );
      writeFileSync(configPath, customized);
      const changed = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--provider",
        "current",
        "--yes",
      ], project, env);
      expect(changed.status, changed.stdout + changed.stderr).toBe(0);
      expect(changed.stdout).not.toContain("project overrides removed");
      expect(readFileSync(configPath, "utf-8")).toBe(customized);
      const check = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--check",
      ], project, env);
      expect(check.status, check.stdout + check.stderr).toBe(0);
      expect(check.stdout).toContain("1 warning(s)");
      expect(check.stdout).toContain("provider-codex-project-override");
    }

    const project = install("codex");
    const env = runtimeEnv();
    const configPath = join(project, ".codex", "config.toml");
    const shipped = readFileSync(configPath, "utf-8");
    writeFileSync(
      configPath,
      withLegacyCodexProviderBlock(shipped, legacyBlock),
    );
    const configured = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--region",
      "eu-west-1",
      "--profile",
      "team",
      "--yes",
    ], project, env);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    const changed = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(changed.status, changed.stdout + changed.stderr).toBe(0);
    expect(readFileSync(configPath, "utf-8")).toBe(shipped);
    const check = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toContain("clean for codex");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("keep-current removes the documented commented-out legacy Codex block", () => {
    const env = runtimeEnv();
    for (const effort of ["high", "medium"]) {
      const project = install("codex");
      const configPath = join(project, ".codex", "config.toml");
      const shipped = readFileSync(configPath, "utf-8");
      const legacyBlock =
        `# Model: these session defaults are what judgment-tier agent roles inherit\n` +
        `# (their TOMLs omit model/model_reasoning_effort by design - see the tier\n` +
        `# projection); balanced roles pin gpt-5.6-terra/medium, while templated roles inherit.\n` +
        `# D-9: Amazon Bedrock is the shipped default provider (web_search is\n` +
        `# unavailable there; the market-research stage degrades gracefully). For\n` +
        `# OpenAI-auth setups, comment out model_provider and the [model_providers]\n` +
        `# block.\n` +
        `model = "openai.gpt-5.5"\n# model_provider = "amazon-bedrock"\n` +
        `model_context_window = 1000000\nmodel_reasoning_effort = "${effort}"\n\n` +
        `# [model_providers.amazon-bedrock.aws]\n` +
        `# # Set to your AWS profile/region with Bedrock model access.\n` +
        `# profile = "default"\n# region = "us-east-1"\n\n`;
      const legacy = withLegacyCodexProviderBlock(shipped, legacyBlock);
      writeFileSync(configPath, legacy);
      const changed = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--provider",
        "current",
        "--yes",
      ], project, env);
      expect(changed.status, changed.stdout + changed.stderr).toBe(0);
      expect(readFileSync(configPath, "utf-8")).toBe(effort === "high" ? shipped : legacy);
      const check = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--check",
      ], project, env);
      expect(check.status, check.stdout + check.stderr).toBe(0);
      if (effort === "high") {
        expect(check.stdout).toContain("clean for codex");
        expect(check.stdout).not.toContain("provider-codex-project-override");
      } else {
        expect(check.stdout).toContain("warning");
        expect(check.stdout).toContain("provider-codex-project-override");
      }
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("keep-current preserves a legacy Codex table that carries a user key after a blank line", () => {
    const legacyBlock =
      `# D-9: Amazon Bedrock is the shipped default provider (web_search is\n` +
      `# unavailable there; the market-research stage degrades gracefully). For\n` +
      `# OpenAI-auth setups, comment out model_provider and the [model_providers]\n` +
      `# block.\n` +
      `model = "openai.gpt-5.5"\nmodel_provider = "amazon-bedrock"\n` +
      `model_context_window = 1000000\nmodel_reasoning_effort = "high"\n\n` +
      `[model_providers.amazon-bedrock.aws]\n` +
      `profile = "default"\nregion = "us-east-1"\n\ncustom = "keep"\n\n`;
    for (const env of [runtimeEnv(), runtimeEnv({ AIDLC_RUNTIME_ROOT: "" })]) {
      const project = install("codex");
      const configPath = join(project, ".codex", "config.toml");
      const customized = withLegacyCodexProviderBlock(
        readFileSync(configPath, "utf-8"),
        legacyBlock,
      );
      writeFileSync(configPath, customized);
      const changed = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--provider",
        "current",
        "--yes",
      ], project, env);
      expect(changed.status, changed.stdout + changed.stderr).toBe(0);
      const after = readFileSync(configPath, "utf-8");
      expect(after).toContain('custom = "keep"');
      expect(after).toContain("[model_providers.amazon-bedrock.aws]");
      expect(after).toContain('model_provider = "amazon-bedrock"');
      expect(after).toBe(customized);
      const check = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--check",
      ], project, env);
      expect(check.status, check.stdout + check.stderr).toBe(0);
      expect(check.stdout).toContain("provider-codex-project-override");
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("reset removes the exact legacy Codex Bedrock block", () => {
    const project = install("codex");
    const env = runtimeEnv();
    const configPath = join(project, ".codex", "config.toml");
    const shipped = readFileSync(configPath, "utf-8");
    const legacyBlock =
      `# Model: these session defaults are what judgment-tier agent roles inherit\n` +
        `# (their TOMLs omit model/model_reasoning_effort by design - see the tier\n` +
        `# projection); balanced roles pin gpt-5.6-terra/medium, while templated roles inherit.\n` +
      `# D-9: Amazon Bedrock is the shipped default provider (web_search is\n` +
        `# unavailable there; the market-research stage degrades gracefully). For\n` +
        `# OpenAI-auth setups, comment out model_provider and the [model_providers]\n` +
        `# block.\n` +
        `model = "openai.gpt-5.5"\nmodel_provider = "amazon-bedrock"\n` +
        `model_context_window = 1000000\nmodel_reasoning_effort = "high"\n\n` +
        `[model_providers.amazon-bedrock.aws]\nprofile = "default"\nregion = "us-east-1"\n\n`;
    writeFileSync(
      configPath,
      withLegacyCodexProviderBlock(shipped, legacyBlock),
    );
    const configured = run([
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
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    const reset = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--reset",
      "--yes",
    ], project, env);
    expect(reset.status, reset.stdout + reset.stderr).toBe(0);
    const after = readFileSync(configPath, "utf-8");
    expect(after).not.toContain('model_provider = "amazon-bedrock"');
    expect(after).not.toContain('model = "openai.gpt-5.5"');
    expect(after).not.toContain("[model_providers.amazon-bedrock.aws]");
    expect(after).toBe(shipped);
    const check = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toContain("no recorded answer");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("check warns and show stops calling a partially edited legacy Codex block provider-neutral", () => {
    const project = install("codex");
    const env = runtimeEnv();
    const path = join(project, ".codex", "config.toml");
    const legacyBlock =
      `# D-9: Amazon Bedrock is the shipped default provider (web_search is\n` +
        `# unavailable there; the market-research stage degrades gracefully). For\n` +
        `# OpenAI-auth setups, comment out model_provider and the [model_providers]\n` +
        `# block.\n` +
        `model = "openai.gpt-5.5"\nmodel_provider = "amazon-bedrock"\n` +
        `model_context_window = 1000000\nmodel_reasoning_effort = "medium"\n\n` +
        `[model_providers.amazon-bedrock.aws]\nprofile = "default"\nregion = "us-east-1"\n\n`;
    writeFileSync(
      path,
      withLegacyCodexProviderBlock(readFileSync(path, "utf-8"), legacyBlock),
    );
    const configured = run([
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
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    const changed = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(changed.status, changed.stdout + changed.stderr).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain('model_provider = "amazon-bedrock"');
    expect(readFileSync(path, "utf-8")).toContain('model_reasoning_effort = "medium"');
    const check = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toContain("1 warning(s)");
    expect(check.stdout).toContain("provider-codex-project-override");
    const show = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--show",
    ], project, env);
    expect(show.status, show.stdout + show.stderr).toBe(0);
    expect(show.stdout).toContain("Codex project configuration");
    expect(show.stdout).not.toContain("provider-neutral");
    const record = normalizeProvidersRecord({
      schemaVersion: 1,
      provider: "current",
    });
    expect(providerIssues(project, ".codex", "codex", record)
      .map(({ id, severity }) => ({ id, severity }))).toEqual([
      { id: "provider-codex-project-override", severity: "warn" },
    ]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("copy-channel provider transitions remove the recorded Claude Bedrock values", () => {
    for (const transition of [
      ["--provider", "current"],
      ["--provider", "other", "--acknowledge"],
      ["--reset"],
    ]) {
      const project = install("claude");
      const configured = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--provider",
        "amazon-bedrock",
        "--region",
        "eu-west-1",
        "--profile",
        "team",
        "--yes",
      ], project, runtimeEnv());
      expect(configured.status, configured.stdout + configured.stderr).toBe(0);
      const copyEnv = {
        AIDLC_RUNTIME_ROOT: "",
        AWS_ACCESS_KEY_ID: "test-access",
        AWS_SECRET_ACCESS_KEY: "test-secret",
      };
      const changed = run([
        "config",
        "providers",
        "--project-dir",
        project,
        ...transition,
        "--yes",
      ], project, copyEnv);
      expect(changed.status, changed.stdout + changed.stderr).toBe(0);
      const settings = JSON.parse(readFileSync(
        join(project, ".claude", "settings.json"),
        "utf-8",
      ));
      expect(settings.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(settings.env.AWS_REGION).toBeUndefined();
      expect(settings.env.AWS_PROFILE).toBeUndefined();
      const check = run([
        "config",
        "providers",
        "--project-dir",
        project,
        "--check",
      ], project, copyEnv);
      expect(check.status, check.stdout + check.stderr).toBe(0);
      expect(check.stdout).not.toContain("provider-claude-project-override");
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("refresh reports removal of unrecorded legacy Bedrock defaults", () => {
    const env = runtimeEnv();
    for (const [harness, harnessDir, configName] of [
      ["claude", ".claude", "settings.json"],
      ["codex", ".codex", "config.toml"],
    ]) {
      const project = install(harness);
      const dataPath = join(project, harnessDir, "tools", "data", "harness.json");
      const data = JSON.parse(readFileSync(dataPath, "utf-8"));
      delete data.providers;
      writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
      const configPath = join(project, harnessDir, configName);
      if (harness === "claude") {
        const settings = JSON.parse(readFileSync(configPath, "utf-8"));
        Object.assign(settings.env, {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: "us-east-1",
          ANTHROPIC_DEFAULT_FABLE_MODEL:
            "global.anthropic.claude-fable-5[1m]",
          ANTHROPIC_DEFAULT_OPUS_MODEL:
            "global.anthropic.claude-opus-4-8[1m]",
          ANTHROPIC_DEFAULT_SONNET_MODEL:
            "global.anthropic.claude-sonnet-4-6[1m]",
          ANTHROPIC_DEFAULT_HAIKU_MODEL:
            "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        });
        writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`);
      } else {
        const legacyBlock =
          `# Model: these session defaults are what judgment-tier agent roles inherit\n` +
          `# (their TOMLs omit model/model_reasoning_effort by design - see the tier\n` +
          `# projection); balanced roles pin gpt-5.6-terra/medium, while templated roles inherit.\n` +
          `# D-9: Amazon Bedrock is the shipped default provider (web_search is\n` +
          `# unavailable there; the market-research stage degrades gracefully). For\n` +
          `# OpenAI-auth setups, comment out model_provider and the [model_providers]\n` +
          `# block.\n` +
          `model = "openai.gpt-5.5"\nmodel_provider = "amazon-bedrock"\n` +
          `model_context_window = 1000000\nmodel_reasoning_effort = "high"\n\n` +
          `[model_providers.amazon-bedrock.aws]\n` +
          `profile = "default"\nregion = "us-east-1"\n\n`;
        writeFileSync(
          configPath,
          withLegacyCodexProviderBlock(
            readFileSync(configPath, "utf-8"),
            legacyBlock,
          ),
        );
      }

      const args = [
        "config",
        "--project-dir",
        project,
        "--from",
        join(DIST_RELEASE, harness),
        "--harness",
        harness,
        "--yes",
      ];
      const preview = run([...args, "--dry-run", "--json"], project, env);
      expect(preview.status, preview.stdout + preview.stderr).toBe(0);
      const note = JSON.parse(preview.stdout).data.notes.join("\n");
      expect(note).toContain(`${harnessDir}/${configName}`);
      expect(note).toContain(
        "config providers --provider amazon-bedrock --region us-east-1 --yes",
      );

      const refreshed = run(args, project, env);
      expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
      expect(refreshed.stdout).toContain(`Note: Removed legacy AI-DLC Bedrock defaults from ${harnessDir}/${configName}`);
      expect(refreshed.stdout).toContain(
        "config providers --provider amazon-bedrock --region us-east-1 --yes",
      );
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("legacy Claude cleanup preserves a user-authored AWS profile", () => {
    const project = install("claude");
    const env = runtimeEnv();
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    Object.assign(settings.env, {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_PROFILE: "team-profile",
      ANTHROPIC_DEFAULT_FABLE_MODEL:
        "global.anthropic.claude-fable-5[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL:
        "global.anthropic.claude-opus-4-8[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL:
        "global.anthropic.claude-sonnet-4-6[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL:
        "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const result = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8")).env;
    expect(after.AWS_PROFILE).toBe("team-profile");
    expect(after.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(after.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("current preserves a manually configured OpenCode Bedrock provider", () => {
    const project = install("opencode");
    const env = runtimeEnv();
    const path = join(project, "opencode.json");
    const config = JSON.parse(readFileSync(path, "utf-8"));
    config.provider = {
      "amazon-bedrock": {
        options: {
          region: "eu-west-1",
          profile: "team-profile",
        },
      },
    };
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    const result = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf-8")).provider)
      .toEqual(config.provider);
    expect(run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env).status).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("changing a Bedrock region or profile resets provider attestations", () => {
    const project = install("codex");
    const env = runtimeEnv();
    const configure = (...args: string[]) => run([
      "config",
      "providers",
      "--project-dir",
      project,
      ...args,
      "--yes",
    ], project, env);
    const complete = configure(
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-east-1",
      "--profile",
      "dev",
      "--acknowledge",
      "--mark-done",
      "bedrock-model-access",
    );
    expect(complete.status, complete.stdout + complete.stderr).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".codex")).providers)
      .toEqual(expect.objectContaining({
        acknowledged: true,
        pendingActions: [
          { id: "bedrock-model-access", status: "done" },
          { id: "codex-provider-configuration", status: "done" },
        ],
      }));

    const changedRegion = configure("--region", "eu-west-1");
    expect(
      changedRegion.status,
      changedRegion.stdout + changedRegion.stderr,
    ).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".codex")).providers)
      .toEqual(expect.objectContaining({
        region: "eu-west-1",
        pendingActions: [
          { id: "bedrock-model-access", status: "pending" },
          { id: "codex-provider-configuration", status: "pending" },
        ],
      }));
    expect(readConfigDiagnosticRecords(join(project, ".codex")).providers
      ?.acknowledged).toBeUndefined();

    expect(configure(
      "--acknowledge",
      "--mark-done",
      "bedrock-model-access",
    ).status).toBe(0);
    const changedProfile = configure("--profile", "team-profile");
    expect(
      changedProfile.status,
      changedProfile.stdout + changedProfile.stderr,
    ).toBe(0);
    expect(readConfigDiagnosticRecords(join(project, ".codex")).providers)
      .toEqual(expect.objectContaining({
        profile: "team-profile",
        pendingActions: [
          { id: "bedrock-model-access", status: "pending" },
          { id: "codex-provider-configuration", status: "pending" },
        ],
      }));
    expect(readConfigDiagnosticRecords(join(project, ".codex")).providers
      ?.acknowledged).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("reapplying an unchanged provider answer repairs stale project overrides", () => {
    const project = install("claude");
    const env = runtimeEnv();
    const recorded = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);

    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.env.CLAUDE_CODE_USE_BEDROCK = "1";
    settings.env.AWS_REGION = "us-east-1";
    settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL =
      "global.anthropic.claude-fable-5[1m]";
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL =
      "global.anthropic.claude-opus-4-8[1m]";
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL =
      "global.anthropic.claude-sonnet-4-6[1m]";
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL =
      "global.anthropic.claude-haiku-4-5-20251001-v1:0";
    settings.env.MY_TEAM_SETTING = "preserved";
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    expect(run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env).status).toBe(1);

    const repaired = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
    expect(repaired.stdout).not.toContain("configuration unchanged");
    const repairedSettings = readFileSync(settingsPath, "utf-8");
    expect(repairedSettings).not.toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(repairedSettings).not.toContain("ANTHROPIC_DEFAULT_OPUS_MODEL");
    expect(repairedSettings).toContain('"MY_TEAM_SETTING": "preserved"');
    expect(run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, env).status).toBe(0);
    expect(readFileSync(settingsPath, "utf-8"))
      .toContain('"MY_TEAM_SETTING": "preserved"');
    expect(run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env).status).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("check warns when a non-Bedrock record has a project Bedrock flag", () => {
    const project = install("claude");
    const env = runtimeEnv();
    const recorded = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "other",
      "--acknowledge",
      "--yes",
    ], project, env);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    Object.assign(settings.env, {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "eu-west-1",
    });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const check = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--check",
    ], project, env);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toContain("provider-claude-project-override");
    expect(check.stdout).toContain("warning");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("providers show renders blocking issues and their remediation", () => {
    const project = install("claude");
    const env = runtimeEnv();
    const recorded = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--yes",
    ], project, env);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    Object.assign(settings.env, {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "global.anthropic.claude-fable-5[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-4-8[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL:
        "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const show = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--show",
    ], project, env);
    expect(show.status, show.stdout + show.stderr).toBe(0);
    expect(show.stdout).toContain(
      "Unmet: provider-claude-project-override - Claude settings still carry the legacy AI-DLC Bedrock defaults",
    );
    expect(show.stdout).toContain(
      "fix: Run aidlc config providers again to reapply the recorded answer",
    );
    expect(show.stdout).toContain("Region: not managed by AI-DLC");
    expect(show.stdout).toContain("Profile: not managed by AI-DLC");
    expect(show.stdout).not.toContain("shipped fallback");
    expect(show.stdout).not.toContain("default credential chain");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("provider flags refuse builtin and harness-owned access without writing", () => {
    const env = runtimeEnv();
    for (const [harness, flags, message] of [
      [
        "claude",
        ["--provider", "builtin"],
        "--provider builtin is legacy-only; choose current, amazon-bedrock, or other",
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    const jsonData = JSON.parse(json.stdout).data;
    expect(jsonData).toEqual(expect.objectContaining({
      harnessManaged: true,
      pendingActions: [],
      issues: [],
    }));
    expect(jsonData.files).toEqual([
      expect.objectContaining({
        setting: "provider answers and pending actions",
      }),
    ]);
    expect(jsonData.files[0].file.endsWith(
      join(".kiro", "tools", "data", "harness.json"),
    )).toBe(true);
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    expect(JSON.parse(readFileSync(join(project, "opencode.json"), "utf-8")).provider)
      .toBeUndefined();
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

    const revoked = run([
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
      "no",
      "--yes",
    ], project, env);
    expect(revoked.status, revoked.stdout + revoked.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(project, "opencode.json"), "utf-8")).provider)
      .toBeUndefined();
    expect(readConfigDiagnosticRecords(join(project, ".aidlc")).providers)
      .toEqual(expect.objectContaining({ opencodeDefault: false }));
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("OpenCode yes-to-no removes recorded options but preserves user-authored provider fields", () => {
    const env = runtimeEnv();
    const models = { "anthropic.claude-sonnet-4-6": { name: "Sonnet" } };
    for (const customRegion of [false, true]) {
      const project = install("opencode");
      const args = [
        "config",
        "providers",
        "--project-dir",
        project,
        "--provider",
        "amazon-bedrock",
        "--region",
        "us-east-1",
      ];
      const configured = run([...args, "--opencode-default", "yes", "--yes"], project, env);
      expect(configured.status, configured.stdout + configured.stderr).toBe(0);
      const path = join(project, "opencode.json");
      const config = JSON.parse(readFileSync(path, "utf-8"));
      config.provider["amazon-bedrock"].models = models;
      config.provider["amazon-bedrock"].options.maxRetries = 3;
      if (customRegion) config.provider["amazon-bedrock"].options.region = "eu-west-1";
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      const declined = run([...args, "--opencode-default", "no", "--yes"], project, env);
      expect(declined.status, declined.stdout + declined.stderr).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf-8")).provider["amazon-bedrock"]).toEqual(
        customRegion ? config.provider["amazon-bedrock"] : { models, options: { maxRetries: 3 } },
      );
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Bedrock-only provider flags are rejected for current and other", () => {
    const project = install("claude");
    const env = runtimeEnv();
    const current = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "current",
      "--region",
      "us-east-1",
      "--yes",
    ], project, env);
    expect(current.status, current.stdout + current.stderr).toBe(2);
    expect(current.stdout).toContain("require --provider amazon-bedrock");
    expect(readConfigDiagnosticRecords(join(project, ".claude")).providers).toBeNull();
    const other = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "other",
      "--profile",
      "team",
      "--acknowledge",
      "--yes",
    ], project, env);
    expect(other.status, other.stdout + other.stderr).toBe(2);
    expect(other.stdout).toContain("require --provider amazon-bedrock");
    expect(readConfigDiagnosticRecords(join(project, ".claude")).providers).toBeNull();
    const configured = run([
      "config",
      "providers",
      "--project-dir",
      project,
      "--provider",
      "amazon-bedrock",
      "--region",
      "us-east-1",
      "--profile",
      "team",
      "--yes",
    ], project, env);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    const pendingOther = run([
      "config",
      "providers",
      "--project-dir",
      cursor,
      "--provider",
      "other",
      "--yes",
    ], cursor, env);
    expect(pendingOther.status, pendingOther.stdout + pendingOther.stderr).toBe(0);
    expect(readConfigDiagnosticRecords(join(cursor, ".cursor")).providers)
      .toEqual(expect.objectContaining({
        provider: "other",
        pendingActions: expect.arrayContaining([
          {
            id: "non-bedrock-provider-configuration",
            status: "pending",
          },
        ]),
      }));
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
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
