// covers: file:scripts/build-binaries.ts, tool:aidlc, subcommand:aidlc-utility:version, hook:aidlc-review-freeze
// covers: subcommand:aidlc-utility:plugin-sync
// covers: subcommand:aidlc-utility:doctor
//
// Native-only unit coverage for the release binary builder. The cross-target
// matrix, including Bun's Windows .exe append behavior, is intentionally left
// to release CI because those artifacts are host/toolchain dependent and much
// more expensive than the local native gate.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { targetTriple } from "../../core/tools/aidlc-install-paths.ts";
import { isCompiledExecutable } from "../../core/tools/aidlc-runtime-paths.ts";
import { VERSION_ID_PATTERN } from "../../core/tools/aidlc-channel.ts";
import { AIDLC_VERSION } from "../../dist/claude/.claude/tools/aidlc-version.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "build-binaries.ts");
const PACKAGE_RELEASE_SCRIPT = join(REPO_ROOT, "scripts", "package-release.ts");
const RESULTS_JSON = join(REPO_ROOT, "build", "binaries", "build-results-native.json");
const RELEASE_DIR = join(REPO_ROOT, "build", "release");
const UTILITY_TS = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type GateResult = {
  name: string;
  ok: boolean;
  status?: number | null;
  stdout?: string;
  stderr?: string;
  actual?: string | number;
  expected?: string | number;
};

type TargetResult = {
  name: string;
  artifact: string;
  bytes: number;
  gates: GateResult[];
  verification: {
    status: "VERIFIED" | "UNVERIFIED";
    mode: "full-runtime" | "inspection-only";
    hostTarget: string;
  };
};

type BuildResults = {
  expectedVersion: string;
  results: TargetResult[];
};

function runBuild(extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AIDLC_BUILD_ENTRY;
  delete env.AIDLC_BUILD_OUT_DIR;
  Object.assign(env, extraEnv);
  const result = spawnSync(BUN, [BUILD_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env,
    timeout: 300_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function readResults(path = RESULTS_JSON): BuildResults {
  return JSON.parse(readFileSync(path, "utf-8")) as BuildResults;
}

function nativeResult(doc: BuildResults): TargetResult {
  const native = doc.results.find((result) => result.name === "native");
  expect(native).toBeDefined();
  return native as TargetResult;
}

function gate(result: TargetResult, name: string): GateResult {
  const found = result.gates.find((item) => item.name === name);
  expect(found).toBeDefined();
  return found as GateResult;
}

// The binary reports whatever id the build stamped: the source version or, in a
// release run that sets AIDLC_BUILD_VERSION, a preview id.
const VERSION_LINE = new RegExp(
  `^aidlc\\s+(${VERSION_ID_PATTERN})(?:\\s+\\(runtime\\s+${VERSION_ID_PATTERN}\\))?$`,
);

function stampedVersion(stdout: string): string {
  const trimmed = stdout.trim();
  return VERSION_LINE.exec(trimmed)?.[1] ?? trimmed;
}

describe("t238 build-binaries release builder", () => {
  test("compiled detection covers Windows executables without changing Bun source mode", () => {
    expect(isCompiledExecutable(
      "file:///C:/workspace/core/tools/aidlc-runtime-paths.ts",
      "C:\\Users\\Administrator\\.bun\\bin\\bun.exe",
    )).toBe(false);
    expect(isCompiledExecutable(
      "file:///C:/workspace/dist/claude/.claude/tools/aidlc.ts",
      "C:\\workspace\\build\\binaries\\native\\aidlc.exe",
    )).toBe(true);
    expect(isCompiledExecutable(
      "file:///$bunfs\\root\\aidlc.ts",
      "C:\\Users\\Administrator\\.bun\\bin\\bun.exe",
    )).toBe(true);
  });

  test("native build compiles, gates, and runs version plus a delegate from an isolated project", () => {
    const result = runBuild();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const doc = readResults();
    expect(doc.expectedVersion).toBe(AIDLC_VERSION);
    const native = nativeResult(doc);
    expect(existsSync(native.artifact)).toBe(true);
    expect(relative(REPO_ROOT, native.artifact).replace(/\\/g, "/").startsWith("build/binaries/")).toBe(true);
    expect(native.bytes).toBeGreaterThan(10 * 1024 * 1024);
    for (const harness of [
      "claude",
      "codex",
      "cursor",
      "kiro",
      "kiro-ide",
      "copilot",
      "opencode",
    ]) {
      expect(existsSync(join(dirname(native.artifact), "runtime", harness))).toBe(true);
    }
    const stagedRunner = readFileSync(
      join(
        dirname(native.artifact),
        "runtime",
        "claude",
        ".claude",
        "skills",
        "aidlc-code-generation",
        "SKILL.md",
      ),
      "utf-8",
    );
    expect(stagedRunner).toContain(
      "aidlc engine orchestrate next --stage code-generation --single",
    );
    expect(stagedRunner).not.toContain("bun .claude/tools/aidlc-orchestrate.ts");

    const version = gate(native, "version");
    expect(version.ok).toBe(true);
    expect(version.actual).toBe(AIDLC_VERSION);

    const delegatePluginSync = gate(native, "delegate-plugin-sync");
    expect(delegatePluginSync.ok).toBe(true);
    expect(delegatePluginSync.actual).toBe("plugin sync complete: 0 plugin(s)");
    expect(delegatePluginSync.stderr).not.toContain("Cannot find module");
    expect(delegatePluginSync.stderr).not.toContain("/$bunfs/");

    for (const name of [
      "runtime-assets",
      "sensor-list",
      "run-sensors",
      "graph-compile-check",
      "packaged-runtime-immutable",
      "validate-outputs",
      "runner-check",
      "stage-table-check",
      "scope-table-check",
      "runtime-codex",
      "runtime-cursor",
      "runtime-kiro",
      "runtime-kiro-ide",
      "runtime-copilot",
      "runtime-opencode",
      "harness-probe-kiro",
      "harness-probe-copilot",
      "harness-probe-opencode",
      "compiled-kiro-new-work-routing",
      "plugin-select",
      "real-plugin-sync",
      "conductor-persona",
      "workspace-global-flags",
      "bolt-reentry",
      "swarm-reentry",
      "pathless-next-env-scope",
      "native-directive-invocation",
      "pathless-park",
      "pathless-single-audit",
      "hook-validate-state",
      "hook-review-freeze",
      "statusline",
      "adapter-codex-validate-state",
      "adapter-cursor-validate-state",
      "routed-project-dir",
      "bun-compiled-parity",
      "final-layout-config-dry-run",
      "final-layout-doctor-json",
      "final-layout-versions-list",
      "final-layout-plugin-list",
      "final-layout-unix-completions",
    ]) {
      expect(gate(native, name).ok, name).toBe(true);
    }

    expect(gate(native, "harness-probe-copilot").stdout).toContain(
      ".github/hooks/aidlc.json present (hook wiring)",
    );
    expect(gate(native, "harness-probe-opencode").stdout).toContain(
      "opencode.json or opencode.jsonc present",
    );

    const delegateDoctorData = gate(native, "delegate-doctor-data");
    expect(delegateDoctorData.ok).toBe(true);
    expect(delegateDoctorData.stdout).toContain("AI-DLC doctor");
    expect(delegateDoctorData.stdout).toMatch(/Schema validation: \d+\/\d+ stages validated/);
    expect(delegateDoctorData.stdout).not.toContain("Schema validation: 0/0");
    expect(`${delegateDoctorData.stdout ?? ""}${delegateDoctorData.stderr ?? ""}`).not.toMatch(
      /Cannot find module|\/\$bunfs\/|uv_spawn ['"]bun['"]/,
    );

    // A fresh empty directory, not the shared host tmp root: the binary scans
    // its cwd for workspace detection, so tmpdir()'s accumulated litter made
    // this spawn's duration hostage to host state (observed 0.09s clean vs
    // 4.8s+ with ~50k entries, breaching the cap under parallel load).
    const rerun = spawnSync(native.artifact, ["version"], {
      cwd: mkdtempSync(join(tmpdir(), "aidlc-rerun-")),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(rerun.status).toBe(0);
    expect(stampedVersion(rerun.stdout ?? "")).toBe(AIDLC_VERSION);

    const pluginFixture = mkdtempSync(join(tmpdir(), "aidlc-t238-plugin-empty-"));
    try {
      const registry = join(pluginFixture, "installed_plugins.json");
      const settings = join(pluginFixture, "settings.json");
      writeFileSync(join(pluginFixture, "package.json"), "{}\n");
      writeFileSync(registry, '{"version":2,"plugins":{}}\n');
      writeFileSync(settings, '{"enabledPlugins":{}}\n');
      const pluginSync = spawnSync(native.artifact, ["engine", "plugin", "sync"], {
        cwd: pluginFixture,
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_HARNESS_DIR: ".claude",
          AIDLC_CLAUDE_PLUGIN_REGISTRY: registry,
          AIDLC_CLAUDE_SETTINGS: settings,
        },
        timeout: 30_000,
      });
      expect(pluginSync.status).toBe(0);
      expect(pluginSync.stdout ?? "").toBe("plugin sync complete: 0 plugin(s)\n");
      expect(`${pluginSync.stdout ?? ""}${pluginSync.stderr ?? ""}`).not.toContain("Cannot find module");
      expect(`${pluginSync.stdout ?? ""}${pluginSync.stderr ?? ""}`).not.toContain("/$bunfs/");
    } finally {
      rmSync(pluginFixture, { recursive: true, force: true });
    }

    const doctor = spawnSync(native.artifact, ["doctor"], {
      cwd: mkdtempSync(join(tmpdir(), "aidlc-rerun-")),
      encoding: "utf-8",
      env: { ...process.env, PATH: "" },
      timeout: 30_000,
    });
    expect(doctor.status === 0 || doctor.status === 1).toBe(true);
    expect(doctor.stdout ?? "").toContain("AI-DLC doctor");
    expect(`${doctor.stdout ?? ""}${doctor.stderr ?? ""}`).not.toMatch(
      /Cannot find module|\/\$bunfs\/|uv_spawn ['"]bun['"]/,
    );

    const utility = spawnSync(BUN, [UTILITY_TS, "version"], {
      cwd: mkdtempSync(join(tmpdir(), "aidlc-rerun-")),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(utility.status).toBe(0);
    expect(stampedVersion(utility.stdout ?? "")).toBe(AIDLC_VERSION);

    const packaged = spawnSync(BUN, [PACKAGE_RELEASE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 180_000,
      env: { ...process.env, SOURCE_DATE_EPOCH: "1784246400" },
    });
    expect(packaged.status, `${packaged.stdout ?? ""}${packaged.stderr ?? ""}`).toBe(0);
    const releaseManifest = JSON.parse(
      readFileSync(join(RELEASE_DIR, "version.json"), "utf-8"),
    ) as {
      assets: Array<{
        kind: string;
        verification?: { status: string; mode: string };
      }>;
    };
    expect(
      releaseManifest.assets.find((asset) => asset.kind === "binary")?.verification,
    ).toEqual(expect.objectContaining({
      status: "VERIFIED",
      mode: "full-runtime",
    }));
    expect(releaseManifest.assets.filter((asset) => asset.kind === "runtime")).toEqual([
      expect.objectContaining({ name: "aidlc-runtime.tar.gz" }),
    ]);
    expect(releaseManifest.assets.some((asset) => asset.kind === "data")).toBe(false);
    writeFileSync(
      join(RELEASE_DIR, "aidlc-release.intoto.jsonl"),
      "aidlc-test-release-provenance\n",
    );

    const installFixture = mkdtempSync(join(tmpdir(), "aidlc-t238-install-"));
    try {
      const home = join(installFixture, "home");
      const installRoot = join(home, ".local", "share", "aidlc");
      const binDir = join(home, ".local", "bin");
      const profile = join(home, ".profile");
      const project = join(installFixture, "project");
      mkdirSync(home, { recursive: true });
      mkdirSync(join(project, ".git"), { recursive: true });
      writeFileSync(profile, "# user profile\n");
      const env = {
        ...process.env,
        HOME: home,
        AIDLC_INSTALL_ROOT: installRoot,
        AIDLC_BIN_DIR: binDir,
        AIDLC_GH_BIN: join(REPO_ROOT, "tests", "fixtures", "bin", "gh"),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };
      const outsideProfileDir = join(installFixture, "outside-profile");
      const linkedProfileDir = join(home, "linked-profile");
      mkdirSync(outsideProfileDir, { recursive: true });
      symlinkSync(relative(home, outsideProfileDir), linkedProfileDir);
      const escapedProfile = spawnSync(native.artifact, [
        "system",
        "lifecycle",
        "install-profile",
        "--profile",
        join(linkedProfileDir, ".profile"),
        "--bin-dir",
        binDir,
        "--quiet",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(escapedProfile.status).toBe(4);
      expect(escapedProfile.stdout ?? "").toContain(
        "profile path must be inside the target user's home directory",
      );
      expect(existsSync(join(outsideProfileDir, ".profile"))).toBe(false);

      const invalidRoot = join(installFixture, "invalid-destination-install");
      const invalidDestination = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--quiet",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env: {
          ...env,
          AIDLC_INSTALL_ROOT: invalidRoot,
          AIDLC_BIN_DIR: "relative-bin",
        },
      });
      expect(invalidDestination.status).toBe(4);
      expect(invalidDestination.stdout ?? "").toContain("AIDLC_BIN_DIR must be an absolute path");
      expect(existsSync(invalidRoot)).toBe(false);

      const obsoleteHarness = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--harness",
        "claude",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(obsoleteHarness.status).toBe(2);

      // The remaining checks exercise install.sh, Homebrew, and POSIX profiles.
      if (process.platform === "win32") return;

      const managerRoot = join(installFixture, "manager");
      const managerBin = join(managerRoot, "Cellar", "aidlc", "1.0.0", "bin");
      const managerCommandDir = join(managerRoot, "prefix", "bin");
      const managerInstallRoot = join(installFixture, "manager-refusal-install");
      mkdirSync(managerBin, { recursive: true });
      mkdirSync(managerCommandDir, { recursive: true });
      writeFileSync(join(managerBin, "aidlc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      symlinkSync(
        relative(managerCommandDir, join(managerBin, "aidlc")),
        join(managerCommandDir, "aidlc"),
      );
      const managerEnv: NodeJS.ProcessEnv = {
        ...env,
        AIDLC_INSTALL_ROOT: managerInstallRoot,
        PATH: `${managerCommandDir}:${process.env.PATH ?? ""}`,
      };
      delete managerEnv.AIDLC_BIN_DIR;
      const managerOwned = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--quiet",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env: managerEnv,
      });
      expect(managerOwned.status).toBe(4);
      expect(managerOwned.stdout ?? "").toContain("brew upgrade aidlc");
      expect(existsSync(managerInstallRoot)).toBe(false);

      const install = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--profile",
        profile,
        "--json",
        "--no-color",
        "--yes",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(install.status, `${install.stdout ?? ""}${install.stderr ?? ""}`).toBe(0);
      expect(JSON.parse(install.stdout ?? "")).toEqual(expect.objectContaining({
        schemaVersion: 1,
        ok: true,
        code: 0,
        data: expect.objectContaining({
          version: AIDLC_VERSION,
          runtime: "all-harnesses",
          profile,
        }),
      }));
      const quietInstall = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--quiet",
        "--no-color",
        "--yes",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(
        quietInstall.status,
        `${quietInstall.stdout ?? ""}${quietInstall.stderr ?? ""}`,
      ).toBe(0);
      expect((quietInstall.stdout ?? "").trim().split("\n")).toHaveLength(1);
      expect(quietInstall.stdout ?? "").toContain(`installed AI-DLC ${AIDLC_VERSION}`);
      expect(`${quietInstall.stdout ?? ""}${quietInstall.stderr ?? ""}`).not.toContain("\u001b[");

      const humanInstall = spawnSync("sh", [
        join(RELEASE_DIR, "install.sh"),
        "--from",
        RELEASE_DIR,
        "--offline",
        "--no-color",
        "--yes",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(
        humanInstall.status,
        `${humanInstall.stdout ?? ""}${humanInstall.stderr ?? ""}`,
      ).toBe(0);
      expect(humanInstall.stdout ?? "")
        .toContain(`PASS installed AI-DLC ${AIDLC_VERSION} with all harness runtimes`);
      expect(`${humanInstall.stdout ?? ""}${humanInstall.stderr ?? ""}`).not.toContain("\u001b[");

      const profileText = readFileSync(profile, "utf-8");
      expect(profileText).toContain("# user profile");
      expect(profileText).toContain("# BEGIN AI-DLC:PATH");
      expect(profileText).toContain(`export PATH="${binDir}:$PATH"`);
      const installedBinary = join(binDir, "aidlc");
      expect(existsSync(installedBinary)).toBe(true);

      const config = spawnSync(installedBinary, [
        "config",
        "--project-dir",
        project,
        "--harness",
        "claude",
        "--mcp",
        "none",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(config.status, `${config.stdout ?? ""}${config.stderr ?? ""}`).toBe(0);
      expect(existsSync(join(project, ".claude", "tools", "data", "aidlc-manifest.json"))).toBe(true);

      const installedDoctor = spawnSync(installedBinary, [
        "doctor",
        "--verbose",
        "--project-dir",
        project,
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(
        installedDoctor.status,
        `${installedDoctor.stdout ?? ""}${installedDoctor.stderr ?? ""}`,
      ).toBe(0);
      expect(installedDoctor.stdout ?? "").toContain("Installed runtime");
      expect(installedDoctor.stdout ?? "").toContain("Transaction staging: no abandoned directories");
      expect(installedDoctor.stdout ?? "").toContain("Project pin registry: no stale registrations");
      expect(installedDoctor.stdout ?? "").toContain(
        "Native command trust: host hooks and permission entries select the installed `aidlc` command",
      );
      expect(installedDoctor.stdout ?? "").not.toContain("wires no aidlc-*.ts hooks");

      const quietDoctor = spawnSync(installedBinary, [
        "doctor",
        "--project-dir",
        project,
        "--quiet",
      ], {
        cwd: project,
        encoding: "utf-8",
        timeout: 60_000,
        env,
      });
      expect(quietDoctor.status, `${quietDoctor.stdout ?? ""}${quietDoctor.stderr ?? ""}`).toBe(0);
      expect((quietDoctor.stdout ?? "").trim().split("\n")).toHaveLength(1);
      expect(quietDoctor.stdout ?? "").toMatch(/^\d+ passed, \d+ warnings, 0 failed\n$/);
    } finally {
      rmSync(installFixture, { recursive: true, force: true });
    }
  }, 300_000);

  test("package-release emits one asset when native and the explicit host target match", () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-t238-release-dedupe-"));
    try {
      const binaries = join(root, "binaries");
      const output = join(root, "release");
      const hostTarget = targetTriple();
      const binaryName = process.platform === "win32" ? "aidlc.exe" : "aidlc";
      const bytes = Buffer.from("identical host binary\n", "utf-8");
      for (const directoryName of ["native", hostTarget]) {
        const directory = join(binaries, directoryName);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, binaryName), bytes);
      }

      const packaged = spawnSync(
        BUN,
        [
          PACKAGE_RELEASE_SCRIPT,
          "--binaries",
          binaries,
          "--output",
          output,
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          timeout: 180_000,
          env: { ...process.env, SOURCE_DATE_EPOCH: "1784246400" },
        },
      );
      expect(
        packaged.status,
        `${packaged.stdout ?? ""}${packaged.stderr ?? ""}`,
      ).toBe(0);

      const manifest = JSON.parse(
        readFileSync(join(output, "version.json"), "utf-8"),
      ) as {
        assets: Array<{ name: string; kind: string; target?: string }>;
      };
      const binaryAssets = manifest.assets.filter((asset) => asset.kind === "binary");
      const expectedName =
        `aidlc-${hostTarget}${process.platform === "win32" ? ".exe" : ""}`;
      expect(binaryAssets).toEqual([
        expect.objectContaining({
          name: expectedName,
          target: hostTarget,
        }),
      ]);
      expect(new Set(manifest.assets.map((asset) => asset.name)).size).toBe(
        manifest.assets.length,
      );
      expect(readdirSync(output).filter((name) => name === expectedName)).toEqual([
        expectedName,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("fake entry with wrong version proves the mandatory version gate can fail", () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-t238-"));
    try {
      const entry = join(root, "fake-aidlc.ts");
      const outDir = join(root, "out");
      writeFileSync(
        entry,
        [
          "#!/usr/bin/env bun",
          "const verb = process.argv[2];",
          "if (verb === \"version\") {",
          "  process.stdout.write(\"aidlc 0.0.0 (runtime 0.0.0)\\n\");",
          "  process.exit(0);",
          "}",
          "if (verb === \"help\" || verb === undefined) {",
          "  process.stdout.write(\"aidlc fake help\\n\");",
          "  process.exit(0);",
          "}",
          "if (verb === \"doctor\") {",
          "  process.stdout.write(\"AI-DLC doctor\\nSchema validation: 33/33 stages validated\\n\");",
          "  process.stderr.write(\"FAIL Cannot find module \\\"/$bunfs/root/data/stage-graph.json\\\": ENOENT: no such file or directory, uv_spawn 'git'\\n\");",
          "  process.stderr.write(\"WARN ENOENT: no such file or directory, uv_spawn 'git'\\n\");",
          "  process.exit(1);",
          "}",
          "process.stderr.write(\"unknown fake command\\n\");",
          "process.exit(2);",
          "",
        ].join("\n"),
        "utf-8",
      );

      const result = runBuild({
        AIDLC_BUILD_ENTRY: entry,
        AIDLC_BUILD_OUT_DIR: outDir,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("version gate failed");

      const doc = readResults(join(outDir, "build-results-native.json"));
      const native = nativeResult(doc);
      const version = gate(native, "version");
      expect(version.ok).toBe(false);
      expect(version.actual).toBe("0.0.0");
      expect(version.expected).toBe(AIDLC_VERSION);

      const delegatePluginSync = gate(native, "delegate-plugin-sync");
      expect(delegatePluginSync.ok).toBe(false);
      expect(result.stderr).toContain("delegate-plugin-sync gate failed");

      const delegateDoctorData = gate(native, "delegate-doctor-data");
      expect(delegateDoctorData.ok).toBe(false);
      expect(delegateDoctorData.actual).toBe("Cannot find module");
      expect(delegateDoctorData.stderr).toContain(
        "WARN ENOENT: no such file or directory, uv_spawn 'git'",
      );
      expect(result.stderr).toContain("delegate-doctor-data gate failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
