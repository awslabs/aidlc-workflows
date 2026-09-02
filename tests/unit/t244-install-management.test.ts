// covers: tool:aidlc-lifecycle, tool:aidlc-machine-config, tool:aidlc-update
// covers: tool:aidlc-completions, file:scripts/install.sh, file:scripts/install.ps1

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeExecutablePath,
  commandPath,
  projectPinTargetPath,
  readActiveExecutable,
  windowsUninstallFencePath,
} from "../../core/tools/aidlc-install-paths.ts";
import { doctorUpdateState } from "../../core/tools/aidlc-doctor.ts";
import { activate } from "../../core/tools/aidlc-lifecycle.ts";
import {
  readMachineConfig,
  resolvedReleaseSettings,
} from "../../core/tools/aidlc-machine-config.ts";
import {
  cachedUpdateNotice,
  readUpdateCache,
  refreshUpdateState,
} from "../../core/tools/aidlc-update.ts";
import { _resetSettingsCacheForTests } from "../../core/tools/aidlc-settings.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { scanWindowsUninstallJournals } from "../../core/tools/aidlc-windows-uninstall.ts";
import {
  type ReleaseFixtureOptions,
  type ReleaseServerFault,
  serveReleaseFixture,
  writeReleaseFixture,
} from "../harness/release-fixture.ts";

const REPO_ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const LIFECYCLE = join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts");
const INSTALL_SH = join(REPO_ROOT, "scripts", "install.sh");
const INSTALL_PS1 = join(REPO_ROOT, "scripts", "install.ps1");
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");
const RELEASE_PUBLISHER = join(REPO_ROOT, "scripts", "publish-release.ts");
const V1_RELEASE_DISPATCH_WORKFLOW = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "dispatch-v1-release.yml",
);
const RELEASE_VERIFIER = join(REPO_ROOT, "scripts", "verify-release.ts");
const UTILITY = join(REPO_ROOT, "core", "tools", "aidlc-utility.ts");
const RELEASE_HARNESSES = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "kiro",
  "kiro-ide",
  "opencode",
] as const;
const temporary: string[] = [];
const originalPath = process.env.PATH;

beforeAll(() => {
  process.env.PATH = `${join(REPO_ROOT, "tests", "fixtures", "bin")}${delimiter}${
    originalPath ?? ""
  }`;
});
function patchVersion(offset: number): string {
  const [major, minor, patch] = AIDLC_VERSION.split(".").map(Number);
  return `${major}.${minor}.${patch + offset}`;
}
const NEXT_VERSION = patchVersion(1);
const LIVE_PIN_VERSION = patchVersion(2);
const STALE_PIN_VERSION = patchVersion(3);
const REMOVABLE_VERSION = patchVersion(4);

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

// Production emits canonical project and machine paths, so fixtures live under
// the canonical temp root (macOS aliases /var to /private/var).
function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function writeVerifierCandidate(root: string): void {
  mkdirSync(root, { recursive: true });
  const specifications = [
    ["aidlc-darwin-arm64", "binary", "darwin-arm64"],
    ["aidlc-darwin-x64", "binary", "darwin-x64"],
    ["aidlc-linux-arm64", "binary", "linux-arm64"],
    ["aidlc-linux-arm64-musl", "binary", "linux-arm64-musl"],
    ["aidlc-linux-x64", "binary", "linux-x64"],
    ["aidlc-linux-x64-musl", "binary", "linux-x64-musl"],
    ["aidlc-runtime.tar.gz", "runtime", undefined],
    ["aidlc-windows-x64.exe", "binary", "windows-x64"],
    ["install.ps1", "installer", undefined],
    ["install.sh", "installer", undefined],
  ] as const;
  const assets = specifications.map(([name, kind, target]) => {
    const content = `${name}\n`;
    const path = join(root, name);
    writeFileSync(path, content);
    return {
      name,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
      kind,
      ...(target
        ? {
          target,
          verification: {
            status: "VERIFIED",
            mode: "full-runtime",
            hostTarget: target,
          },
        }
        : {}),
    };
  });
  const manifest = {
    schemaVersion: 1,
    version: AIDLC_VERSION,
    date: "2026-08-28",
    sourceRef: "refs/heads/main",
    sourceDigest: "1".repeat(40),
    distributions: RELEASE_HARNESSES.map((name) => ({
      name,
      productName: `AI-DLC ${name}`,
    })),
    assets,
  };
  writeFileSync(join(root, "version.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(root, "checksums.txt"),
    `${[
      `version.json`,
      ...assets.map((asset) => asset.name),
    ].map((name) => {
      const bytes = readFileSync(join(root, name));
      return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`;
    }).join("\n")}\n`,
  );
  writeFileSync(join(root, "aidlc-release.intoto.jsonl"), "attestation bundle\n");
}

function workflowJob(workflow: string, name: string): string {
  const match = new RegExp(
    `\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z][a-z0-9-]*:\\n|$)`,
  ).exec(workflow);
  if (!match) throw new Error(`release workflow has no ${name} job`);
  return match[0];
}

function run(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tool, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: process.platform === "win32" ? 300_000 : 60_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function runAsync(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, tool, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

async function waitForAbsent(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (paths.some(existsSync)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for cleanup: ${paths.filter(existsSync).join(", ")}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForPresent(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (paths.some((path) => !existsSync(path))) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for preserved files: ${
          paths.filter((path) => !existsSync(path)).join(", ")
        }`,
      );
    }
    await Bun.sleep(50);
  }
}

function fixture(
  version = AIDLC_VERSION,
  options: Pick<ReleaseFixtureOptions, "binary"> = {},
): string {
  const root = temp("aidlc-t241-release-");
  writeReleaseFixture({
    root,
    repoRoot: REPO_ROOT,
    version,
    ...options,
  });
  return root;
}

type ReleaseServerHandle = {
  baseUrl: string;
  readonly requests: string[];
  clearRequests(): void;
  stop(): void | Promise<void>;
};

async function serveReleaseFixtureForChildren(
  root: string,
  fault: ReleaseServerFault = { kind: "none" },
): Promise<ReleaseServerHandle> {
  if (process.platform !== "win32") {
    const server = serveReleaseFixture(root, fault);
    return {
      baseUrl: server.baseUrl,
      get requests() {
        return server.requests;
      },
      clearRequests() {
        server.requests.length = 0;
      },
      stop: () => server.stop(),
    };
  }

  const requestLog = join(temp("aidlc-t244-release-server-"), "requests.ndjson");
  writeFileSync(requestLog, "");
  const helper = [
    'import { appendFileSync } from "node:fs";',
    `import { serveReleaseFixture } from ${
      JSON.stringify(join(REPO_ROOT, "tests", "harness", "release-fixture.ts"))
    };`,
    "const fault = JSON.parse(process.env.AIDLC_RELEASE_FIXTURE_FAULT);",
    "const server = serveReleaseFixture(process.env.AIDLC_RELEASE_FIXTURE_ROOT, fault);",
    "const push = server.requests.push.bind(server.requests);",
    "server.requests.push = (...paths) => {",
    "  for (const path of paths) {",
    "    appendFileSync(",
    "      process.env.AIDLC_RELEASE_FIXTURE_REQUEST_LOG,",
    '      JSON.stringify(path) + "\\n",',
    "    );",
    "  }",
    "  return push(...paths);",
    "};",
    "process.stdout.write(JSON.stringify({ baseUrl: server.baseUrl }) + \"\\n\");",
    "await new Promise(() => {});",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", helper], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AIDLC_RELEASE_FIXTURE_ROOT: root,
      AIDLC_RELEASE_FIXTURE_REQUEST_LOG: requestLog,
      AIDLC_RELEASE_FIXTURE_FAULT: JSON.stringify(fault),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let startup = "";
  while (!startup.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      const exitCode = await child.exited;
      throw new Error(
        `release fixture server exited during startup (exit code ${exitCode}): ${await stderr}`,
      );
    }
    startup += decoder.decode(chunk.value, { stream: true });
  }
  const startupEvent = JSON.parse(startup.slice(0, startup.indexOf("\n"))) as {
    baseUrl: string;
  };
  const stdout = (async () => {
    while (!(await reader.read()).done) {
      // Drain the helper channel until the process exits.
    }
  })();
  const readRequests = (): string[] => {
    const content = readFileSync(requestLog, "utf-8").trim();
    return content
      ? content.split("\n").map((line) => JSON.parse(line) as string)
      : [];
  };

  let stopped = false;
  return {
    baseUrl: startupEvent.baseUrl,
    get requests() {
      return readRequests();
    },
    clearRequests() {
      writeFileSync(requestLog, "");
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      child.kill();
      await Promise.all([child.exited, stdout, stderr]);
    },
  };
}

function envFor(machine: string): NodeJS.ProcessEnv {
  return {
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: join(machine, "bin"),
  };
}

describe("t244 machine configuration and update discovery", () => {
  test("global config works outside projects and precedence is flag, env, config, default", () => {
    const machine = temp("aidlc-t241-config-");
    const cwd = temp("aidlc-t241-config-cwd-");
    const env = envFor(machine);
    expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "offline", "on",
    ], cwd, env).status).toBe(0);
    expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "release-base-url", "https://mirror.example/releases",
    ], cwd, env).status).toBe(0);

    const prior = {
      install: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
      offline: process.env.AIDLC_OFFLINE,
      base: process.env.AIDLC_RELEASE_BASE_URL,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      expect(readMachineConfig()).toEqual({
        schemaVersion: 1,
        offline: true,
        "release-base-url": "https://mirror.example/releases",
      });
      expect(resolvedReleaseSettings()).toEqual({
        offline: true,
        baseUrl: "https://mirror.example/releases",
        caBundle: undefined,
      });
      process.env.AIDLC_OFFLINE = "0";
      process.env.AIDLC_RELEASE_BASE_URL = "https://env.example/releases";
      expect(resolvedReleaseSettings()).toEqual({
        offline: false,
        baseUrl: "https://env.example/releases",
        caBundle: undefined,
      });
      expect(resolvedReleaseSettings({
        offline: true,
        baseUrl: "https://flag.example/releases",
      })).toEqual({
        offline: true,
        baseUrl: "https://flag.example/releases",
        caBundle: undefined,
      });
    } finally {
      for (const [key, value] of Object.entries({
        AIDLC_INSTALL_ROOT: prior.install,
        AIDLC_BIN_DIR: prior.bin,
        AIDLC_OFFLINE: prior.offline,
        AIDLC_RELEASE_BASE_URL: prior.base,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("machine config rejects release URLs with secrets in query or fragment", () => {
    const machine = temp("aidlc-t240-config-url-");
    const cwd = temp("aidlc-t240-config-url-cwd-");
    const env = envFor(machine);
    const rejected = run(DISPATCHER, [
      "system",
      "config",
      "global",
      "set",
      "release-base-url",
      "https://mirror.example/releases?token=secret#private",
    ], cwd, env);
    expect(rejected.status).toBe(2);
    expect(rejected.stdout + rejected.stderr).not.toContain("token=secret");
    expect(rejected.stdout + rejected.stderr).not.toContain("private");
    expect(existsSync(join(machine, "aidlc.settings.json"))).toBe(false);
  });

  test("doctor explicit refresh honors its mirror and quiet modes stay network-free", async () => {
    const release = fixture(NEXT_VERSION, { binary: "bytes" });
    const server = await serveReleaseFixtureForChildren(release);
    const machine = temp("aidlc-t240-doctor-update-");
    const keys = [
      "AIDLC_INSTALL_ROOT",
      "AIDLC_BIN_DIR",
      "AIDLC_RELEASE_BASE_URL",
      "AIDLC_OFFLINE",
      "NO_PROXY",
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      ...envFor(machine),
      AIDLC_RELEASE_BASE_URL: "https://ignored.example/releases",
      AIDLC_OFFLINE: "0",
      NO_PROXY: "127.0.0.1",
    });
    try {
      const state = await doctorUpdateState({
        "check-updates": "true",
        "release-base-url": server.baseUrl,
      }, false);
      expect(state.state).toBe("behind");
      expect(server.requests.filter((path) => path.endsWith("/version.json")))
        .toHaveLength(1);
      expect(server.requests.filter((path) => path.endsWith("/checksums.txt")))
        .toHaveLength(1);

      server.clearRequests();
      const routed = await runAsync(DISPATCHER, [
        "doctor",
        "--check-updates",
        "--release-base-url",
        server.baseUrl,
        "--json",
        "--project-dir",
        REPO_ROOT,
      ], REPO_ROOT, {
        ...envFor(machine),
        AIDLC_OFFLINE: "0",
        NO_PROXY: "127.0.0.1",
      });
      expect([0, 1]).toContain(routed.status);
      expect(JSON.parse(routed.stdout).data.checks).toContainEqual(
        expect.objectContaining({
          label: expect.stringContaining(`latest ${NEXT_VERSION}`),
        }),
      );
      expect(server.requests.filter((path) => path.endsWith("/version.json")))
        .toHaveLength(1);
      expect(server.requests.filter((path) => path.endsWith("/checksums.txt")))
        .toHaveLength(1);

      rmSync(join(machine, "update-check.json"), { force: true });
      server.clearRequests();
      await doctorUpdateState({ "release-base-url": server.baseUrl }, false);
      await doctorUpdateState({
        json: "true",
        "release-base-url": server.baseUrl,
      }, true);
      await doctorUpdateState({
        quiet: "true",
        "release-base-url": server.baseUrl,
      }, true);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.stop();
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, process.platform === "win32" ? 120_000 : 10_000);

  test("interactive doctor bounds a missing-cache refresh to 750 milliseconds", async () => {
    const release = fixture(NEXT_VERSION, { binary: "bytes" });
    const server = await serveReleaseFixtureForChildren(release, {
      kind: "delay",
      asset: "version.json",
      milliseconds: 2_000,
    });
    const machine = temp("aidlc-t240-doctor-timeout-");
    const keys = [
      "AIDLC_INSTALL_ROOT",
      "AIDLC_BIN_DIR",
      "AIDLC_RELEASE_BASE_URL",
      "AIDLC_OFFLINE",
      "NO_PROXY",
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      ...envFor(machine),
      AIDLC_OFFLINE: "0",
      NO_PROXY: "127.0.0.1",
    });
    try {
      const started = performance.now();
      const state = await doctorUpdateState({
        "release-base-url": server.baseUrl,
      }, true);
      const elapsed = performance.now() - started;
      expect(state.state).toBe("unavailable");
      expect(elapsed).toBeGreaterThanOrEqual(500);
      expect(elapsed).toBeLessThan(1_500);
    } finally {
      await server.stop();
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, process.platform === "win32" ? 120_000 : 5_000);

  test("authenticated refresh replaces the cache and every failed refresh preserves it", async () => {
    const release = fixture(NEXT_VERSION, { binary: "bytes" });
    const server = await serveReleaseFixtureForChildren(release);
    const machine = temp("aidlc-t241-update-");
    const saved = Object.fromEntries(
      ["AIDLC_INSTALL_ROOT", "AIDLC_BIN_DIR", "AIDLC_RELEASE_BASE_URL", "NO_PROXY"]
        .map((key) => [key, process.env[key]]),
    );
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    process.env.AIDLC_RELEASE_BASE_URL = server.baseUrl;
    process.env.NO_PROXY = "127.0.0.1";
    try {
      const state = await refreshUpdateState(15_000);
      expect(state.state).toBe("behind");
      expect(readUpdateCache()?.latestVersion).toBe(NEXT_VERSION);
      expect(cachedUpdateNotice()).toContain(`aidlc ${NEXT_VERSION}`);
      expect(cachedUpdateNotice()).toContain(
        "Update with: bun .claude/tools/aidlc.ts update",
      );
      expect(server.requests.filter((path) => path.endsWith("version.json"))).toHaveLength(1);
      expect(server.requests.filter((path) => path.endsWith("checksums.txt"))).toHaveLength(1);

      const before = readFileSync(join(machine, "update-check.json"), "utf-8");
      await server.stop();
      const captive = await serveReleaseFixtureForChildren(release, {
        kind: "captive-portal",
        asset: "version.json",
      });
      process.env.AIDLC_RELEASE_BASE_URL = captive.baseUrl;
      const unavailable = await refreshUpdateState(15_000);
      expect(unavailable.state).toBe("unavailable");
      expect(unavailable.message).toBe(
        `update refresh unavailable; cached version ${NEXT_VERSION} is stale or unverifiable`,
      );
      expect(readFileSync(join(machine, "update-check.json"), "utf-8")).toBe(before);
      await captive.stop();
    } finally {
      await server.stop();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, process.platform === "win32" ? 120_000 : 45_000);

  test("older authenticated metadata cannot replace a newer valid update cache", async () => {
    const newerRelease = fixture(NEXT_VERSION, { binary: "bytes" });
    const olderRelease = fixture("0.0.1", { binary: "bytes" });
    const newerServer = await serveReleaseFixtureForChildren(newerRelease);
    const olderServer = await serveReleaseFixtureForChildren(olderRelease);
    const machine = temp("aidlc-t241-update-downgrade-");
    const saved = Object.fromEntries(
      ["AIDLC_INSTALL_ROOT", "AIDLC_BIN_DIR", "AIDLC_RELEASE_BASE_URL", "NO_PROXY"]
        .map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, {
      ...envFor(machine),
      AIDLC_RELEASE_BASE_URL: newerServer.baseUrl,
      NO_PROXY: "127.0.0.1",
    });
    try {
      expect((await refreshUpdateState(15_000)).state).toBe("behind");
      const before = readFileSync(join(machine, "update-check.json"), "utf-8");
      process.env.AIDLC_RELEASE_BASE_URL = olderServer.baseUrl;

      const state = await refreshUpdateState(15_000);
      expect(state.state).toBe("unavailable");
      expect(state.latestVersion).toBe(NEXT_VERSION);
      expect(readFileSync(join(machine, "update-check.json"), "utf-8")).toBe(before);
      expect(readUpdateCache()?.latestVersion).toBe(NEXT_VERSION);
    } finally {
      await newerServer.stop();
      await olderServer.stop();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, process.platform === "win32" ? 120_000 : 45_000);

  test("disabled and offline update checks open no socket", async () => {
    const release = fixture(NEXT_VERSION, { binary: "bytes" });
    const server = serveReleaseFixture(release);
    const machine = temp("aidlc-t241-no-socket-");
    const env = {
      ...envFor(machine),
      AIDLC_RELEASE_BASE_URL: server.baseUrl,
      NO_PROXY: "127.0.0.1",
    };
    const saved = Object.fromEntries(
      ["AIDLC_INSTALL_ROOT", "AIDLC_BIN_DIR", "AIDLC_RELEASE_BASE_URL", "NO_PROXY"]
        .map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    try {
      expect((await refreshUpdateState(50, {
        offline: true,
        baseUrl: server.baseUrl,
      })).state).toBe("offline");
      expect(server.requests).toHaveLength(0);
      expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "update-check", "off",
      ], REPO_ROOT, env).status).toBe(0);
      _resetSettingsCacheForTests();
      expect((await refreshUpdateState(50)).state).toBe("disabled");
      const disabledCheck = await runAsync(
        DISPATCHER,
        ["update", "--check"],
        REPO_ROOT,
        env,
      );
      expect(disabledCheck.status).toBe(1);
      expect(server.requests).toHaveLength(0);
      expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "update-check", "on",
      ], REPO_ROOT, env).status).toBe(0);
      expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "offline", "on",
      ], REPO_ROOT, env).status).toBe(0);
      _resetSettingsCacheForTests();
      expect((await refreshUpdateState(50)).state).toBe("offline");
      const offlineCheck = await runAsync(
        DISPATCHER,
        ["update", "--check"],
        REPO_ROOT,
        env,
      );
      expect(offlineCheck.status).toBe(3);
      expect(server.requests).toHaveLength(0);
    } finally {
      server.stop();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, process.platform === "win32" ? 120_000 : 5_000);
});

describe("t244 management lifecycle", () => {
  test("malformed pin entries warn without hiding valid registrations", () => {
    const machine = temp("aidlc-t241-malformed-pins-");
    const project = temp("aidlc-t241-malformed-pins-project-");
    const pinnedProject = temp("aidlc-t241-valid-pin-project-");
    const version = "9.8.7";
    const executable = join(
      machine,
      "versions",
      version,
      process.platform === "win32" ? "aidlc.exe" : "aidlc",
    );
    const target = projectPinTargetPath(pinnedProject);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(pinnedProject, ".aidlc-version"), `${version}\n`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${executable}\n`);
    writeFileSync(
      join(machine, "pins.json"),
      `${JSON.stringify({
        [pinnedProject]: version,
        relative: "not-semver",
      }, null, 2)}\n`,
    );
    const env = envFor(machine);

    const list = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(list.status, list.stdout + list.stderr).toBe(0);
    const data = JSON.parse(list.stdout).data as {
      versions: Array<{ version: string; pinPaths: string[] }>;
      pinWarnings: string[];
    };
    expect(data.versions).toContainEqual(expect.objectContaining({
      version,
      pinPaths: [pinnedProject],
    }));
    expect(data.pinWarnings).toEqual([
      expect.stringContaining("invalid pin entry for relative"),
    ]);

    const rollback = run(LIFECYCLE, ["rollback", "--list"], project, env);
    expect(rollback.status).toBe(0);
    expect(rollback.stdout).toContain("warning:");
    const prune = run(LIFECYCLE, ["versions", "prune", "--yes"], project, env);
    expect(prune.status).toBe(4);
    expect(prune.stdout).toContain("cannot prune while pin registry is invalid");
    expect(existsSync(join(machine, "versions", version))).toBe(true);
  });

  test("doctor reports quarantined transaction recovery with manual cleanup", () => {
    const release = fixture(AIDLC_VERSION, { binary: "executable" });
    const sandbox = temp("aidlc-t244-doctor-recovery-");
    const machine = join(sandbox, "home", ".local", "share", "aidlc");
    const project = temp("aidlc-t244-doctor-recovery-project-");
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(sandbox, "home", ".local", "bin"),
    };
    mkdirSync(join(project, ".git"));
    const installed = run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);

    const quarantine = join(
      machine,
      `.aidlc-recovery-${Date.now()}-${randomUUID()}`,
    );
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, "candidate.txt"), "recovery evidence\n");

    const doctor = run(
      DISPATCHER,
      ["doctor", "--json", "--project-dir", project],
      project,
      env,
    );
    expect(doctor.status).toBe(1);
    const checks = (JSON.parse(doctor.stdout) as {
      data: { checks: Array<{ pass: boolean; label: string; fix?: string }> };
    }).data.checks;
    expect(checks).toContainEqual(expect.objectContaining({
      pass: true,
      label: "Transaction staging: no abandoned directories",
    }));
    expect(checks).toContainEqual(expect.objectContaining({
      pass: false,
      label: expect.stringContaining(
        `Transaction recovery: 1 quarantined path(s): ${quarantine}`,
      ),
      fix: expect.stringContaining(
        "recover any needed files, then remove the directory manually",
      ),
    }));

    rmSync(quarantine, { recursive: true });
    const clean = run(
      DISPATCHER,
      ["doctor", "--json", "--project-dir", project],
      project,
      env,
    );
    const cleanChecks = (JSON.parse(clean.stdout) as {
      data: { checks: Array<{ pass: boolean; label: string }> };
    }).data.checks;
    expect(cleanChecks).toContainEqual(expect.objectContaining({
      pass: true,
      label: "Transaction recovery: no quarantined directories",
    }));

    // Project-domain transactions (init, plugin sync) quarantine into the
    // project root; doctor must see those on every channel, machine install
    // or not.
    const projectQuarantine = join(
      project,
      `.aidlc-recovery-${Date.now()}-${randomUUID()}`,
    );
    mkdirSync(projectQuarantine);
    writeFileSync(join(projectQuarantine, "candidate.txt"), "recovery evidence\n");
    const projectDoctor = run(
      DISPATCHER,
      ["doctor", "--json", "--project-dir", project],
      project,
      env,
    );
    const projectChecks = (JSON.parse(projectDoctor.stdout) as {
      data: { checks: Array<{ pass: boolean; label: string }> };
    }).data.checks;
    expect(projectChecks).toContainEqual(expect.objectContaining({
      pass: false,
      label: expect.stringContaining(
        `Transaction recovery: 1 quarantined path(s): ${projectQuarantine}`,
      ),
    }));

    const sourceChannelDoctor = run(
      DISPATCHER,
      ["doctor", "--json", "--project-dir", project],
      project,
      {
        AIDLC_INSTALL_ROOT: join(sandbox, "absent", "share", "aidlc"),
        AIDLC_BIN_DIR: join(sandbox, "absent", "bin"),
      },
    );
    const sourceChecks = (JSON.parse(sourceChannelDoctor.stdout) as {
      data: { checks: Array<{ pass: boolean; label: string }> };
    }).data.checks;
    expect(sourceChecks).toContainEqual(expect.objectContaining({
      pass: false,
      label: expect.stringContaining(
        `Transaction recovery: 1 quarantined path(s): ${projectQuarantine}`,
      ),
    }));
  }, 60_000);

  test("all harness runtimes install together and config selects one project harness", () => {
    const release = fixture(AIDLC_VERSION, { binary: "executable" });
    const machine = temp("aidlc-t241-all-harness-");
    const project = temp("aidlc-t241-all-harness-project-");
    mkdirSync(join(project, ".git"));
    const env = envFor(machine);
    const installed = run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    for (const harness of RELEASE_HARNESSES) {
      expect(existsSync(join(machine, "versions", AIDLC_VERSION, "runtime", harness))).toBe(true);
    }
    for (const file of ["aidlc.bash", "_aidlc", "aidlc.fish", "aidlc.ps1"]) {
      expect(existsSync(join(machine, "completions", file)), file).toBe(true);
    }
    expect(
      existsSync(join(machine, "versions", AIDLC_VERSION, "plugins", "test-pro", "claude")),
    ).toBe(true);
    const missingChoice = run(DISPATCHER, [
      "config", "--project-dir", project, "--mcp", "none",
    ], project, env);
    expect(missingChoice.status).toBe(2);
    expect(missingChoice.stdout + missingChoice.stderr).toContain("--harness");
    const configured = run(DISPATCHER, [
      "config", "--project-dir", project, "--harness", "kiro", "--mcp", "none",
    ], project, env);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    expect(existsSync(join(project, ".kiro"))).toBe(true);
    const multi = run(DISPATCHER, [
      "config", "--project-dir", temp("aidlc-t241-multi-project-"),
      "--harness", "claude", "--harness", "kiro", "--mcp", "none",
    ], project, env);
    expect(multi.status).toBe(2);
    expect(multi.stdout + multi.stderr).toContain("multi-harness config is not supported yet");
  }, 60_000);

  test("a missing declared runtime makes the retained version incomplete", () => {
    const release = fixture(AIDLC_VERSION, { binary: "executable" });
    const machine = temp("aidlc-t244-missing-runtime-");
    const project = temp("aidlc-t244-missing-runtime-project-");
    mkdirSync(join(project, ".git"));
    const env = envFor(machine);
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    rmSync(join(machine, "versions", AIDLC_VERSION, "runtime", "codex"), {
      recursive: true,
    });
    const listed = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(listed.stdout).toContain('"complete":false');
    expect(run(LIFECYCLE, ["use", AIDLC_VERSION], project, env).status).toBe(4);
  }, 60_000);

  test("update retains the prior active and pinned versions while pruning older versions", () => {
    const release = fixture(AIDLC_VERSION, { binary: "executable" });
    const nextRelease = fixture(NEXT_VERSION, { binary: "executable" });
    const livePinRelease = fixture(LIVE_PIN_VERSION, { binary: "bytes" });
    const stalePinRelease = fixture(STALE_PIN_VERSION, { binary: "bytes" });
    const removableRelease = fixture(REMOVABLE_VERSION, { binary: "bytes" });
    const machine = temp("aidlc-t241-prune-");
    const project = temp("aidlc-t241-prune-project-");
    const pinnedProject = temp("aidlc-t241-live-pin-");
    mkdirSync(join(project, ".git"));
    mkdirSync(join(pinnedProject, ".git"));
    const env = envFor(machine);
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "versions", "install", LIVE_PIN_VERSION, "--from", livePinRelease,
    ], project, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "versions", "install", STALE_PIN_VERSION, "--from", stalePinRelease,
    ], project, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "versions", "install", REMOVABLE_VERSION, "--from", removableRelease,
    ], project, env).status).toBe(0);
    const pinned = run(INIT, [
      "config",
      "--pin",
      LIVE_PIN_VERSION,
      "--project-dir",
      pinnedProject,
    ], pinnedProject, env);
    expect(pinned.status, pinned.stdout + pinned.stderr).toBe(0);
    const pins = JSON.parse(
      readFileSync(join(machine, "pins.json"), "utf-8"),
    ) as Record<string, string>;
    pins["/missing/stale-project"] = STALE_PIN_VERSION;
    writeFileSync(join(machine, "pins.json"), `${JSON.stringify(pins, null, 2)}\n`);
    const updated = run(LIFECYCLE, [
      "update", "--version", NEXT_VERSION, "--from", nextRelease,
    ], project, env);
    expect(updated.status, updated.stdout + updated.stderr).toBe(0);
    expect(updated.stdout).toContain(
      `Checking for releases ... ${AIDLC_VERSION} -> ${NEXT_VERSION}`,
    );
    expect(updated.stdout).toContain(
      `Downloading aidlc ${NEXT_VERSION} ... done (verified)`,
    );
    expect(updated.stdout).toContain(
      `Staging and switching ... done (${AIDLC_VERSION} retained)`,
    );
    expect(updated.stdout).toContain(
      `Updated aidlc from ${AIDLC_VERSION} to ${NEXT_VERSION}.`,
    );
    expect(updated.stdout).toContain(`Pruned unprotected releases: ${REMOVABLE_VERSION}.`);
    const noop = run(LIFECYCLE, [
      "update", "--version", NEXT_VERSION, "--from", nextRelease,
    ], project, env);
    expect(noop.status, noop.stdout + noop.stderr).toBe(0);
    expect(noop.stdout).toContain(
      `You're on the latest version of aidlc (${NEXT_VERSION}).`,
    );
    const dryRun = run(LIFECYCLE, [
      "update", "--version", STALE_PIN_VERSION, "--from", stalePinRelease,
      "--dry-run",
    ], project, env);
    expect(dryRun.status, dryRun.stdout + dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain(
      `Would update aidlc from ${NEXT_VERSION} to ${STALE_PIN_VERSION}.`,
    );
    const dryRunJson = run(LIFECYCLE, [
      "update", "--version", STALE_PIN_VERSION, "--from", stalePinRelease,
      "--dry-run", "--json",
    ], project, env);
    expect(JSON.parse(dryRunJson.stdout).message).toContain(
      `update plan: ${NEXT_VERSION} -> ${STALE_PIN_VERSION}`,
    );
    const usePrior = run(LIFECYCLE, ["use", AIDLC_VERSION], project, env);
    expect(usePrior.status, usePrior.stdout + usePrior.stderr).toBe(0);
    expect(usePrior.stdout).toContain(
      `Now using aidlc ${AIDLC_VERSION} (was ${NEXT_VERSION}; retained locally, no project changes).`,
    );
    const useNext = run(LIFECYCLE, ["use", NEXT_VERSION], project, env);
    expect(useNext.status, useNext.stdout + useNext.stderr).toBe(0);
    expect(useNext.stdout).toContain(
      `Now using aidlc ${NEXT_VERSION} (was ${AIDLC_VERSION}; retained locally, no project changes).`,
    );
    const useNoop = run(LIFECYCLE, ["use", NEXT_VERSION], project, env);
    expect(useNoop.status, useNoop.stdout + useNoop.stderr).toBe(0);
    expect(useNoop.stdout).toContain(`Already using aidlc ${NEXT_VERSION}.`);
    for (const version of [AIDLC_VERSION, NEXT_VERSION, LIVE_PIN_VERSION, STALE_PIN_VERSION]) {
      expect(existsSync(join(machine, "versions", version))).toBe(true);
    }
    expect(existsSync(join(machine, "versions", REMOVABLE_VERSION))).toBe(false);
  }, process.platform === "win32" ? 600_000 : 240_000);

  test("uninstall removes command and versions while preserving machine state and projects", async () => {
    const release = fixture(AIDLC_VERSION, { binary: "executable" });
    const machine = temp("aidlc-t241-uninstall-");
    const project = temp("aidlc-t241-uninstall-project-");
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, "keep.txt"), "project-owned\n");
    const env = envFor(machine);
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    const command = join(
      machine,
      "bin",
      process.platform === "win32" ? "aidlc.cmd" : "aidlc",
    );
    const executable = join(
      machine,
      "versions",
      AIDLC_VERSION,
      process.platform === "win32" ? "aidlc.exe" : "aidlc",
    );
    const originalCommand = readFileSync(command);
    rmSync(command);
    writeFileSync(command, "user-owned command\n");
    const mixedOwnership = run(
      LIFECYCLE,
      ["uninstall", "--yes"],
      project,
      env,
    );
    expect(mixedOwnership.status).toBe(4);
    expect(readFileSync(command, "utf-8")).toBe("user-owned command\n");
    rmSync(command);
    if (process.platform === "win32") {
      writeFileSync(command, originalCommand);
    } else {
      symlinkSync(executable, command);
    }
    expect(run(DISPATCHER, [
      "system",
      "config", "global", "set", "offline", "on",
    ], project, env).status).toBe(0);
    writeFileSync(join(machine, "update-check.json"), "{}\n");
    writeFileSync(join(machine, "pins.json"), "{}\n");

    expect(run(LIFECYCLE, ["uninstall"], project, env).status).toBe(2);
    const uninstall = run(LIFECYCLE, ["uninstall", "--yes"], project, env);
    expect(uninstall.status).toBe(0);
    if (process.platform !== "win32") {
      expect(uninstall.stdout).toContain(
        "Removed aidlc and all retained releases. Machine settings, update cache, pins, harness default, and project files were kept.",
      );
    }
    await waitForAbsent([join(machine, "versions"), command]);
    await waitForPresent([
      join(machine, "aidlc.settings.json"),
      join(machine, "update-check.json"),
      join(machine, "pins.json"),
    ]);
    expect(existsSync(join(machine, "versions"))).toBe(false);
    expect(existsSync(command)).toBe(false);
    expect(existsSync(join(machine, "aidlc.settings.json"))).toBe(true);
    expect(existsSync(join(machine, "update-check.json"))).toBe(true);
    expect(existsSync(join(machine, "pins.json"))).toBe(true);
    expect(readFileSync(join(project, "keep.txt"), "utf-8")).toBe("project-owned\n");

    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    writeFileSync(join(machine, "default-harness"), "claude\n");
    const purge = run(LIFECYCLE, ["uninstall", "--purge", "--yes"], project, env);
    expect(purge.status).toBe(0);
    if (process.platform !== "win32") {
      expect(purge.stdout).toContain(
        "Removed aidlc, all retained releases, machine settings, update cache, pins, and harness default. Project files were kept.",
      );
    }
    await waitForAbsent([
      join(machine, "versions"),
      command,
      join(machine, "aidlc.settings.json"),
      join(machine, "update-check.json"),
      join(machine, "pins.json"),
      join(machine, "default-harness"),
    ]);
    for (
      const path of [
        "aidlc.settings.json",
        "update-check.json",
        "pins.json",
        "default-harness",
      ]
    ) {
      expect(existsSync(join(machine, path))).toBe(false);
    }
    expect(readFileSync(join(project, "keep.txt"), "utf-8")).toBe("project-owned\n");
  }, process.platform === "win32" ? 180_000 : 60_000);
});

describe("t244 installer has no machine-level harness selection", () => {
  test("Unix and PowerShell installers reject the retired harness flag and never render a picker", () => {
    const unix = readFileSync(INSTALL_SH, "utf-8");
    const powershell = readFileSync(INSTALL_PS1, "utf-8");
    expect(unix).not.toContain("Select the harness distribution to install:");
    expect(unix).not.toContain("--harness <name>");
    expect(powershell).not.toContain("Select the harness distribution to install:");
    expect(powershell).not.toContain("[Alias('-harness')]");
    const result = spawnSync("sh", [INSTALL_SH, "--harness", "claude"], {
      cwd: REPO_ROOT, encoding: "utf-8", timeout: 10_000,
    });
    expect(result.status).toBe(2);
  });
});

describe("t244 Windows and completion release surfaces", () => {
  test("Windows uninstall cleanup supports adding completion metadata in PowerShell 5.1", () => {
    const source = readFileSync(
      join(REPO_ROOT, "core", "tools", "aidlc-windows-uninstall.ts"),
      "utf-8",
    );
    expect(source).toContain(
      "$journal | Add-Member -NotePropertyName completedAt",
    );
    expect(source).not.toContain("$journal.completedAt =");
    expect(source).toContain("Start-Process -FilePath 'powershell.exe'");
    expect(source).toContain("const launched = Bun.spawnSync");
  });

  test("install-profile usage names the invoking user's shell profile", () => {
    const result = run(
      DISPATCHER,
      ["system", "lifecycle", "install-profile"],
      REPO_ROOT,
    );
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain(
      "install-profile writes the invoking user's shell profile",
    );
    expect(result.stdout + result.stderr).not.toContain("system PATH");
  });

  test("strict active pointer accepts one versioned executable and rejects extra lines", () => {
    const machine = temp("aidlc-t241-pointer-");
    const saved = process.env.AIDLC_INSTALL_ROOT;
    process.env.AIDLC_INSTALL_ROOT = machine;
    try {
      const executable = join(
        machine,
        "versions",
        "2.5.0",
        process.platform === "win32" ? "aidlc.exe" : "aidlc",
      );
      mkdirSync(join(machine, "versions", "2.5.0"), { recursive: true });
      writeFileSync(activeExecutablePath(), `${executable}\r\n`);
      expect(readActiveExecutable()).toBe(executable);
      writeFileSync(activeExecutablePath(), `${executable}\r\n${executable}\r\n`);
      expect(() => readActiveExecutable()).toThrow("exactly one executable path");
      writeFileSync(activeExecutablePath(), `${executable} \r\n`);
      expect(() => readActiveExecutable()).toThrow();
      writeFileSync(
        activeExecutablePath(),
        `${join(machine, "outside", process.platform === "win32" ? "aidlc.exe" : "aidlc")}\r\n`,
      );
      expect(() => readActiveExecutable()).toThrow();
    } finally {
      if (saved === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved;
    }
  });

  test.skipIf(process.platform !== "win32")(
    "native Windows rollback flips the stable shim pointer and doctor accepts it",
    () => {
      const machine = temp("aidlc-t241-windows-rollback-");
      const source = join(machine, "version-fixture.ts");
      const output = join(machine, "version-fixture.exe");
      writeFileSync(
        source,
        [
          'import { basename, dirname } from "node:path";',
          'if (process.argv[2] === "version") {',
          "  const version = basename(dirname(process.execPath));",
          '  process.stdout.write("aidlc " + version + " (runtime " + version + ")\\n");',
          '  process.exit(0);',
          "}",
          'if (process.argv[2] === "probe") {',
          '  process.stdout.write(JSON.stringify(process.argv.slice(3)) + "\\n");',
          "  process.exit(23);",
          "}",
          "",
        ].join("\n"),
      );
      const build = spawnSync(
        process.execPath,
        ["build", "--compile", source, "--outfile", output],
        { encoding: "utf-8", timeout: 180_000 },
      );
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      const executableFixture = existsSync(output) ? output : `${output}.exe`;
      expect(existsSync(executableFixture)).toBe(true);

      for (const version of ["1.0.0", "1.1.0"]) {
        const root = join(machine, "versions", version);
        const runtime = join(root, "runtime", "claude");
        mkdirSync(root, { recursive: true });
        cpSync(executableFixture, join(root, "aidlc.exe"));
        cpSync(join(REPO_ROOT, "dist-release", "claude"), runtime, {
          recursive: true,
        });
        const stampPath = join(
          runtime,
          ".claude",
          "tools",
          "data",
          "aidlc-stamp.json",
        );
        const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as {
          frameworkVersion: string;
        };
        writeFileSync(
          stampPath,
          `${JSON.stringify({ ...stamp, frameworkVersion: version }, null, 2)}\n`,
        );
        const executable = join(root, "aidlc.exe");
        writeFileSync(
          join(root, "version.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            version,
            date: "2026-07-18",
            distributions: [{ name: "claude", productName: "Claude Code" }],
            assets: [{
              name: "aidlc-windows-x64.exe",
              sha256: createHash("sha256")
                .update(readFileSync(executable))
                .digest("hex"),
              bytes: statSync(executable).size,
              kind: "binary",
              target: "windows-x64",
            }],
          }, null, 2)}\n`,
        );
      }

      const saved = {
        root: process.env.AIDLC_INSTALL_ROOT,
        bin: process.env.AIDLC_BIN_DIR,
      };
      process.env.AIDLC_INSTALL_ROOT = machine;
      process.env.AIDLC_BIN_DIR = join(machine, "bin");
      try {
        activate("1.0.0");
        const forwarded = Bun.spawnSync(
          [commandPath(), "probe", "value with spaces", "plain"],
          { stdout: "pipe", stderr: "pipe" },
        );
        const forwardedError = Buffer.from(forwarded.stderr).toString("utf-8");
        const forwardedOutput = Buffer.from(forwarded.stdout).toString("utf-8").trim();
        expect(forwarded.exitCode, forwardedError).toBe(23);
        expect(JSON.parse(forwardedOutput)).toEqual([
          "value with spaces",
          "plain",
        ]);
        writeFileSync(activeExecutablePath(), "C:\\outside\\aidlc.exe\r\n");
        activate("1.1.0");
        const rollback = run(
          LIFECYCLE,
          ["rollback"],
          REPO_ROOT,
          envFor(machine),
        );
        expect(rollback.status, rollback.stdout + rollback.stderr).toBe(0);
        expect(readActiveExecutable()).toBe(
          join(machine, "versions", "1.0.0", "aidlc.exe"),
        );
        const doctor = run(
          DISPATCHER,
          ["doctor", "--json", "--project-dir", REPO_ROOT],
          REPO_ROOT,
          envFor(machine),
        );
        const report = JSON.parse(doctor.stdout) as {
          data: { checks: Array<{ pass: boolean; label: string }> };
        };
        expect(report.data.checks).toContainEqual(
          expect.objectContaining({
            pass: true,
            label: expect.stringContaining("Command pointer:"),
          }),
        );
      } finally {
        if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
        else process.env.AIDLC_INSTALL_ROOT = saved.root;
        if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
        else process.env.AIDLC_BIN_DIR = saved.bin;
      }
    },
    240_000,
  );

  test("malformed Windows uninstall journals are reported", () => {
    const malformed = join(tmpdir(), `aidlc-uninstall-${randomUUID()}.json`);
    const missingRoot = join(tmpdir(), `aidlc-uninstall-${randomUUID()}.json`);
    try {
      writeFileSync(malformed, "{not-json\n");
      writeFileSync(missingRoot, `${JSON.stringify({
        schemaVersion: 1,
        operation: "windows-uninstall-continuation",
      })}\n`);
      const scan = scanWindowsUninstallJournals();
      expect(scan.invalid).toContain(malformed);
      expect(scan.invalid).toContain(missingRoot);
    } finally {
      rmSync(malformed, { force: true });
      rmSync(missingRoot, { force: true });
    }
  });

  test("orphan Windows uninstall fences are reported as invalid recovery state", () => {
    const machine = temp("aidlc-t240-uninstall-orphan-fence-");
    const saved = {
      root: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      const fence = windowsUninstallFencePath();
      writeFileSync(fence, "{}\n");
      expect(scanWindowsUninstallJournals().invalid).toContain(fence);
    } finally {
      if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved.root;
      if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = saved.bin;
    }
  });

  test("installer completion generation remains under system while the public verb is absent", () => {
    for (const shell of ["bash", "zsh", "fish", "powershell"]) {
      const first = run(DISPATCHER, ["system", "completions", shell], REPO_ROOT);
      const second = run(DISPATCHER, ["system", "completions", shell], REPO_ROOT);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(first.stdout).toBe(second.stdout);
      for (const command of ["config", "doctor", "update", "use", "version", "uninstall"]) {
        expect(first.stdout).toContain(command);
      }
      for (const retired of ["rollback", "versions", "harness", "package", "plugin", "completions"]) {
        expect(first.stdout).not.toContain(` ${retired}`);
      }
      expect(first.stdout).toContain(
        shell === "fish" ? "check-updates" : "--check-updates",
      );
    }
    const powershell = run(
      DISPATCHER,
      ["system", "completions", "powershell"],
      REPO_ROOT,
    );
    expect(powershell.stdout).not.toContain("-AsHashtable");
    const bash = run(DISPATCHER, ["system", "completions", "bash"], REPO_ROOT);
    const syntax = spawnSync("bash", ["-n"], {
      input: bash.stdout,
      encoding: "utf-8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    if (process.platform !== "win32") {
      const zsh = run(DISPATCHER, ["system", "completions", "zsh"], REPO_ROOT);
      // Syntax-check with a real zsh only where one exists: GitHub's
      // ubuntu-latest image dropped zsh (observed 2026-08-28 on the fork
      // release shakedown), so this validation is best-effort while the
      // generation contract above stays asserted everywhere.
      const zshBin = Bun.which("zsh");
      if (zshBin) {
        const zshSyntax = spawnSync(zshBin, ["-n"], {
          input: zsh.stdout,
          encoding: "utf-8",
        });
        expect(zshSyntax.status, zshSyntax.stderr).toBe(0);
      }
    }
    expect(run(DISPATCHER, ["completions", "bash"], REPO_ROOT).status).toBe(2);
  });

  test("PowerShell installer is authenticated release content and delegates placement", () => {
    const script = readFileSync(INSTALL_PS1, "utf-8");
    expect(script).toContain("aidlc-windows-x64.exe");
    expect(script).toContain("'install-apply'");
    expect(script).toContain("Get-FileHash -Algorithm SHA256");
    expect(script).toContain("Unblock-File");
    expect(script).toContain("$env:AIDLC_OFFLINE");
    expect(script).toContain("$verifiedInstaller");
    expect(script).toContain("$releaseUri.Query");
    expect(script).toContain("$releaseUri.Fragment");
    expect(script).toContain("installer validation failed:");
    expect(script).toContain("attestation verify");
    expect(script).toContain("aidlc-release.intoto.jsonl");
    expect(script).toContain("--signer-workflow");
    expect(script).toContain("$env:AIDLC_RELEASE_REPOSITORY");
    expect(script).toContain("$env:AIDLC_RELEASE_WORKFLOW");
    expect(script).toContain("$env:AIDLC_GH_BIN");
    expect(script).toContain("$env:Path = \"$binDir;$env:Path\"");
    expect(script).toContain("exceeds the 1 MiB metadata limit");
    const release = fixture(AIDLC_VERSION, { binary: "bytes" });
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      assets: Array<{ name: string; kind: string }>;
    };
    expect(manifest.assets).toContainEqual(
      expect.objectContaining({ name: "install.ps1", kind: "installer" }),
    );
  }, process.platform === "win32" ? 120_000 : 5_000);

  test("PowerShell installer keeps analyzer suppressions narrow and helper calls named", () => {
    const script = readFileSync(INSTALL_PS1, "utf-8");
    expect(script).toContain("[switch]$Yes");
    expect(script).toContain("[switch]$NoColor");
    expect(script).toContain(
      "'PSReviewUnusedParameter',\n  'Yes',\n" +
        "  Justification = 'Public parity flag; the installer is non-interactive and never prompts.'",
    );
    expect(script).toContain(
      "'PSReviewUnusedParameter',\n  'NoColor',\n" +
        "  Justification = 'Public parity flag; this installer emits no ANSI color.'",
    );
    expect(script).toContain(
      "'PSAvoidUsingWriteHost',\n  '',\n" +
        "  Justification = 'The PATH instruction is part of the pinned human-mode stdout contract under PowerShell 5.1.'",
    );
    expect(script).toContain(
      "'PSAvoidUsingWriteHost',\n    '',\n" +
        "    Justification = 'PASS output is part of the pinned human-mode stdout contract under PowerShell 5.1.'",
    );
    expect(script.match(/'PSAvoidUsingWriteHost'/g)).toHaveLength(2);
    expect(script).toContain(
      "'PSUseShouldProcessForStateChangingFunctions',\n    '',\n" +
        "    Justification = 'This helper only emits the terminal result and exits; it performs no state mutation.'",
    );
    expect(script.match(/^\s*Write-Host\b/gm)).toHaveLength(2);
    for (const helper of [
      "Stop-Install",
      "Write-Result",
      "Get-ReleaseFile",
      "Get-ExpectedHash",
    ]) {
      expect(script).not.toMatch(
        new RegExp(`^\\s*${helper}\\s+(?!-|\`\\s*$)`, "m"),
      );
    }
  });

  test("doctor command-pointer text is grammatical without an active version", () => {
    const source = readFileSync(UTILITY, "utf-8");
    expect(source).toContain(
      `\`Command pointer is missing or does not select active version \${installedVersion}\``,
    );
    expect(source).toContain(
      '"Command pointer is missing or does not select an active version"',
    );
    expect(source).not.toContain(
      `active version \${installedVersion ?? "unknown"}`,
    );
  });

  test("Unix installer supports explicit provenance trust roots under a stripped PATH", () => {
    const script = readFileSync(INSTALL_SH, "utf-8");
    expect(script).toContain("AIDLC_RELEASE_REPOSITORY");
    expect(script).toContain("AIDLC_RELEASE_WORKFLOW");
    expect(script).toContain("AIDLC_GH_BIN");
    expect(script).toContain('"$GH_BIN" attestation verify');
    expect(script).toContain("is_musl_linux()");
    expect(script).toContain("/lib/ld-musl-*.so.1");
    expect(script).toContain("command -v apk >/dev/null 2>&1");
    expect(script).toContain("apk add libgcc libstdc++");
    expect(script).toContain('2>"$TMP/apply.err"');
    expect(script).not.toMatch(/^\s*apk add\b/m);
  });

  test("Unix installer turns Alpine musl loader failures into the canonical remediation", () => {
    if (process.platform !== "linux" || process.getuid?.() === 0) return;
    const root = temp("aidlc-t244-musl-installer-");
    const release = join(root, "release");
    const fakeBin = join(root, "fake-bin");
    const home = join(root, "home");
    mkdirSync(release, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(home, { recursive: true });

    writeFileSync(
      join(fakeBin, "ldd"),
      "#!/bin/sh\nprintf 'musl libc\\n'\n",
      { mode: 0o755 },
    );
    const apkMarker = join(root, "apk-executed");
    writeFileSync(
      join(fakeBin, "apk"),
      "#!/bin/sh\nprintf 'executed\\n' > \"$AIDLC_APK_MARKER\"\nexit 99\n",
      { mode: 0o755 },
    );
    const target = process.arch === "arm64" ? "linux-arm64-musl" : "linux-x64-musl";
    const binaryName = `aidlc-${target}`;
    writeFileSync(
      join(release, binaryName),
      "#!/bin/sh\nprintf 'Error loading shared library libstdc++.so.6: No such file or directory\\n' >&2\nexit 127\n",
      { mode: 0o755 },
    );
    writeFileSync(
      join(release, "version.json"),
      `${JSON.stringify({
        version: AIDLC_VERSION,
        sourceRef: "refs/heads/main",
        sourceDigest: "1".repeat(40),
      })}\n`,
    );
    writeFileSync(join(release, "aidlc-runtime.tar.gz"), "runtime\n");
    writeFileSync(
      join(release, "aidlc-release.intoto.jsonl"),
      "aidlc-test-release-provenance\n",
    );
    cpSync(INSTALL_SH, join(release, "install.sh"));
    const assets = [
      "version.json",
      binaryName,
      "aidlc-runtime.tar.gz",
      "install.sh",
    ];
    writeFileSync(
      join(release, "checksums.txt"),
      `${assets.map((name) => {
        const digest = createHash("sha256")
          .update(readFileSync(join(release, name)))
          .digest("hex");
        return `${digest}  ${name}`;
      }).join("\n")}\n`,
    );

    const result = spawnSync("sh", [
      INSTALL_SH,
      "--from",
      release,
      "--offline",
      "--quiet",
    ], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        AIDLC_APK_MARKER: apkMarker,
        AIDLC_INSTALL_ROOT: join(root, "install"),
        AIDLC_BIN_DIR: join(root, "bin"),
      },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stdout).toBe("apk add libgcc libstdc++\n");
    expect(result.stderr).toBe("");
    expect(existsSync(apkMarker)).toBe(false);
  });

  test("release control verification accepts only split exact tag policies", () => {
    const creation = {
      id: 1,
      name: "release-tag-creation",
      enforcement: "active",
      target: "tag",
      conditions: {
        ref_name: {
          include: ["refs/tags/v*"],
          exclude: [] as string[],
        },
      },
      rules: [{ type: "creation" }],
      bypass_actors: [{
        actor_id: 4242,
        actor_type: "Integration",
        bypass_mode: "always",
      }],
    };
    const immutability = {
      id: 2,
      name: "release-tag-immutability",
      enforcement: "active",
      target: "tag",
      conditions: {
        ref_name: {
          include: ["refs/tags/v*"],
          exclude: [],
        },
      },
      rules: [{ type: "update" }, { type: "deletion" }],
      bypass_actors: [],
    };
    const verify = (rulesets: unknown[]) => {
      const directory = temp("aidlc-t244-release-rulesets-");
      rulesets.forEach((ruleset, index) => {
        writeFileSync(
          join(directory, `${index}.json`),
          `${JSON.stringify(ruleset, null, 2)}\n`,
        );
      });
      return run(RELEASE_VERIFIER, [
        "controls",
        "--rulesets",
        directory,
        "--creation-actor-id",
        "4242",
        "--creation-actor-type",
        "Integration",
      ], REPO_ROOT);
    };

    expect(verify([creation, immutability]).status).toBe(0);

    const exclusion = structuredClone(creation);
    exclusion.conditions.ref_name.exclude = ["refs/tags/v*"];
    const extraActor = structuredClone(creation);
    extraActor.bypass_actors.push({
      actor_id: 99,
      actor_type: "Team",
      bypass_mode: "always",
    });
    const wrongMode = structuredClone(creation);
    wrongMode.bypass_actors[0].bypass_mode = "pull_request";
    const combined = structuredClone(creation);
    combined.rules.push({ type: "update" }, { type: "deletion" });
    const broad = structuredClone(immutability);
    broad.id = 3;
    broad.name = "broad-tag-immutability";
    broad.conditions.ref_name.include = ["~ALL"];
    const hiddenActors = structuredClone(creation) as Record<string, unknown>;
    delete hiddenActors.bypass_actors;
    const unrelatedHiddenActors = {
      id: 3,
      name: "unrelated-branch-policy",
      enforcement: "active",
      target: "branch",
      conditions: {
        ref_name: {
          include: ["refs/heads/main"],
          exclude: [],
        },
      },
      rules: [{ type: "pull_request" }],
    };

    expect(verify([creation, immutability, unrelatedHiddenActors]).status).toBe(0);
    for (const rulesets of [
      [exclusion, immutability],
      [extraActor, immutability],
      [wrongMode, immutability],
      [combined],
      [creation, immutability, combined],
      [creation, immutability, broad],
      [creation],
    ]) {
      expect(verify(rulesets).status).toBe(1);
    }
    const identityFailure = verify([hiddenActors, immutability]);
    expect(identityFailure.status).toBe(1);
    expect(identityFailure.stderr).toContain("authorization identity failure");
  });

  test("release candidate verification rejects mutable metadata and inventory", () => {
    const valid = temp("aidlc-t244-release-candidate-");
    writeVerifierCandidate(valid);
    const verified = run(RELEASE_VERIFIER, [
      "candidate",
      "--directory",
      valid,
      "--tag",
      `v${AIDLC_VERSION}`,
      "--list-assets",
    ], REPO_ROOT);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout.trim().split(/\r?\n/)).toHaveLength(10);
    expect(verified.stdout).toContain("install.sh");
    expect(verified.stdout).toContain("install.ps1");

    const replacedInstaller = temp("aidlc-t244-release-installer-");
    writeVerifierCandidate(replacedInstaller);
    const replacement = "replacement installer\n";
    writeFileSync(join(replacedInstaller, "install.sh"), replacement);
    const replacementHash = createHash("sha256").update(replacement).digest("hex");
    const checksumPath = join(replacedInstaller, "checksums.txt");
    writeFileSync(
      checksumPath,
      readFileSync(checksumPath, "utf-8").replace(
        /^[a-f0-9]{64} {2}install\.sh$/m,
        `${replacementHash}  install.sh`,
      ),
    );
    const replaced = run(RELEASE_VERIFIER, [
      "candidate",
      "--directory",
      replacedInstaller,
      "--tag",
      `v${AIDLC_VERSION}`,
    ], REPO_ROOT);
    expect(replaced.status).toBe(1);
    expect(replaced.stderr).toContain("install.sh: checksum mismatch");

    const duplicate = temp("aidlc-t244-release-duplicate-");
    writeVerifierCandidate(duplicate);
    const duplicateManifestPath = join(duplicate, "version.json");
    const duplicateManifest = JSON.parse(
      readFileSync(duplicateManifestPath, "utf-8"),
    ) as { assets: unknown[] };
    duplicateManifest.assets.push(duplicateManifest.assets[0]);
    writeFileSync(
      duplicateManifestPath,
      `${JSON.stringify(duplicateManifest, null, 2)}\n`,
    );
    const duplicateChecksumsPath = join(duplicate, "checksums.txt");
    const manifestHash = createHash("sha256")
      .update(readFileSync(duplicateManifestPath))
      .digest("hex");
    writeFileSync(
      duplicateChecksumsPath,
      readFileSync(duplicateChecksumsPath, "utf-8").replace(
        /^[a-f0-9]{64} {2}version\.json$/m,
        `${manifestHash}  version.json`,
      ),
    );
    const duplicateResult = run(RELEASE_VERIFIER, [
      "candidate",
      "--directory",
      duplicate,
      "--tag",
      `v${AIDLC_VERSION}`,
    ], REPO_ROOT);
    expect(duplicateResult.status).toBe(1);
    expect(duplicateResult.stderr).toContain("duplicate release asset");

    const extraField = temp("aidlc-t244-release-extra-field-");
    writeVerifierCandidate(extraField);
    const extraFieldManifestPath = join(extraField, "version.json");
    const extraFieldManifest = JSON.parse(
      readFileSync(extraFieldManifestPath, "utf-8"),
    ) as { assets: Array<Record<string, unknown>> };
    extraFieldManifest.assets[0].unexpected = true;
    writeFileSync(
      extraFieldManifestPath,
      `${JSON.stringify(extraFieldManifest, null, 2)}\n`,
    );
    const extraFieldChecksumsPath = join(extraField, "checksums.txt");
    const extraFieldManifestHash = createHash("sha256")
      .update(readFileSync(extraFieldManifestPath))
      .digest("hex");
    writeFileSync(
      extraFieldChecksumsPath,
      readFileSync(extraFieldChecksumsPath, "utf-8").replace(
        /^[a-f0-9]{64} {2}version\.json$/m,
        `${extraFieldManifestHash}  version.json`,
      ),
    );
    const extraFieldResult = run(RELEASE_VERIFIER, [
      "candidate",
      "--directory",
      extraField,
      "--tag",
      `v${AIDLC_VERSION}`,
    ], REPO_ROOT);
    expect(extraFieldResult.status).toBe(1);
    expect(extraFieldResult.stderr).toContain("has unexpected fields");

    const extra = temp("aidlc-t244-release-extra-");
    writeVerifierCandidate(extra);
    writeFileSync(join(extra, "unlisted.txt"), "unexpected\n");
    const extraResult = run(RELEASE_VERIFIER, [
      "candidate",
      "--directory",
      extra,
      "--tag",
      `v${AIDLC_VERSION}`,
    ], REPO_ROOT);
    expect(extraResult.status).toBe(1);
    expect(extraResult.stderr).toContain("unexpected entry unlisted.txt");
  });

  test("release workflow keeps actions pinned, lints installers, and regenerates before consumers", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const parsed = Bun.YAML.parse(workflow) as {
      permissions?: Record<string, string>;
      jobs: Record<string, {
        strategy?: { "fail-fast"?: boolean };
      }>;
    };
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(parsed.jobs["native-smoke"].strategy?.["fail-fast"]).toBe(false);
    expect(parsed.jobs["musl-smoke"].strategy?.["fail-fast"]).toBe(false);
    expect(workflow).toContain("name: Authorize release source and unused tag");
    expect(workflow).toContain("name: Verify release repository controls");
    expect(workflow).toContain("name: Require protected release authorization identity");
    expect(workflow).toContain(
      "actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349",
    );
    expect(workflow).toContain("permission-administration: write");
    expect(workflow).toContain("permission-contents: write");
    expect(workflow).toContain("AIDLC_RELEASE_AUTH_APP_ID");
    expect(workflow).toContain("AIDLC_RELEASE_AUTH_APP_PRIVATE_KEY");
    expect(workflow).toContain("authorization identity failure");
    expect(workflow).toContain(".can_admins_bypass == false");
    expect(workflow).toContain(".prevent_self_review == true");
    expect(workflow).toContain('.reviewer.slug == "aidlc-admins"');
    expect(workflow).toContain("(.reviewers | length) == 1");
    expect(workflow).toContain('gh api "repos/$GITHUB_REPOSITORY/immutable-releases"');
    expect(workflow).toContain(".enabled == true and .enforced_by_owner == true");
    expect(workflow).toContain('[.[].branch_policies[]][0].name == "main"');
    expect(workflow).toContain("bun scripts/verify-release.ts controls");
    expect(workflow).toContain('--creation-actor-type Integration');
    expect(workflow).toContain(`ref: \${{ needs.authorize.outputs.sha }}`);
    expect(workflow).toContain("git fetch --no-tags origin main");
    expect(workflow).toContain('test -z "$tag_refs"');
    expect(workflow).not.toContain("tag_sha=");
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(workflow).not.toContain("\n  push:");
    expect(workflow).not.toContain("origin/v2");
    expect(workflow.indexOf("name: Authorize release source and unused tag"))
      .toBeLessThan(workflow.indexOf("name: Mint release authorization token"));
    expect(workflow.indexOf("name: Authorize release source and unused tag"))
      .toBeLessThan(workflow.indexOf("bun scripts/verify-release.ts controls"));
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$AUTHORIZED_SHA"');
    expect(workflow).toContain("AIDLC_RELEASE_SOURCE_DIGEST:");
    const actionRefs = [...workflow.matchAll(
      /^\s*(?:-\s+)?uses:\s+([^\s#]+)(?:\s+#.*)?$/gm,
    )].map((match) => match[1]);
    expect(actionRefs.length).toBeGreaterThan(0);
    for (const ref of actionRefs) {
      expect(ref).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
    }
    expect(workflow).not.toMatch(/^\s*(?:-\s+)?uses:\s+[^@\s]+@v\d/m);
    expect(workflow).toContain("shellcheck scripts/install.sh");
    expect(workflow).toContain("Invoke-ScriptAnalyzer -Path scripts/install.ps1");
    expect(workflow).toContain("unix-lifecycle:");
    expect(workflow).not.toContain("interactive harness picker");
    expect(workflow).not.toMatch(/install\.(?:sh|ps1)[^\n]*--harness/);
    expect(workflow).not.toMatch(/install\.ps1[^\n]*-Harness/);
    expect(workflow).toContain("name: release-candidate");
    expect(workflow).toContain(`build-results-\${{ matrix.directory }}.json`);
    expect(workflow).not.toContain("python3 -m http.server");
    expect(workflow).toContain('env PATH="/usr/bin:/bin"');

    // Release artifacts must build from projections regenerated ON the runner,
    // never from checkout residue: every dist-consuming job regenerates
    // before its consuming step, and the build job keeps --check after the
    // regen as a generator-determinism guard.
    const regen = "run: bun scripts/package.ts\n";
    const verifyJob = workflow.slice(
      workflow.indexOf("  verify:"),
      workflow.indexOf("  native-smoke:"),
    );
    expect(verifyJob).toContain(regen);
    expect(verifyJob.indexOf(regen)).toBeLessThan(verifyJob.indexOf("- run: bun run check"));
    const nativeSmokeJob = workflow.slice(
      workflow.indexOf("  native-smoke:"),
      workflow.indexOf("  build:"),
    );
    expect(nativeSmokeJob).toContain(regen);
    expect(nativeSmokeJob).toContain("needs: [authorize, verify]");
    expect(nativeSmokeJob).toContain(`ref: \${{ needs.authorize.outputs.sha }}`);
    expect(nativeSmokeJob.indexOf(regen))
      .toBeLessThan(nativeSmokeJob.indexOf("t238-build-binaries.test.ts"));
    const buildJob = workflow.slice(
      workflow.indexOf("  build:"),
      workflow.indexOf("  musl-smoke:"),
    );
    expect(buildJob).toContain(regen);
    expect(buildJob).toContain("needs: [authorize, native-smoke]");
    expect(buildJob).toContain(`ref: \${{ needs.authorize.outputs.sha }}`);
    expect(buildJob.indexOf(regen))
      .toBeLessThan(buildJob.indexOf("bun scripts/package.ts --check"));
    expect(buildJob.indexOf("bun scripts/package.ts --check"))
      .toBeLessThan(buildJob.indexOf("bun scripts/build-binaries.ts"));
    const stageRelease = workflowJob(workflow, "stage-release");
    expect(stageRelease).toContain("needs: [authorize, build]");
    expect(stageRelease).toContain(`ref: \${{ needs.authorize.outputs.sha }}`);
    expect(stageRelease).toContain(regen);
    expect(stageRelease.indexOf(regen))
      .toBeLessThan(stageRelease.indexOf("bun scripts/package-release.ts"));
    const muslSmoke = workflowJob(workflow, "musl-smoke");
    expect(muslSmoke).toContain("bun-linux-x64-musl");
    expect(muslSmoke).toContain("bun-linux-arm64-musl");
    expect(muslSmoke).toContain('-v "$PWD:/work:ro"');
    expect(muslSmoke).toContain(
      `alpine:3.20 sh -c "apk add libgcc libstdc++ >/dev/null && ` +
        `/work/build/binaries/\${TARGET_DIR}/aidlc version"`,
    );
  });

  test("release MUST 1: only publish can sign and stage-release has no provenance bundle", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: Record<string, { permissions?: Record<string, string> }>;
    };
    const signingJobs = Object.entries(parsed.jobs)
      .filter(([, job]) =>
        job.permissions?.["id-token"] === "write" ||
        job.permissions?.attestations === "write"
      )
      .map(([name]) => name);
    expect(signingJobs).toEqual(["publish"]);
    expect(parsed.jobs["stage-release"].permissions).toEqual({ contents: "read" });
    expect(parsed.jobs.publish.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
    const stageRelease = workflowJob(workflow, "stage-release");
    expect(stageRelease).toContain("name: release-candidate");
    expect(stageRelease).not.toContain("Attest staged release assets");
    expect(stageRelease).not.toContain("aidlc-release.intoto.jsonl");
    expect(stageRelease).not.toContain("attest-build-provenance");
  });

  test("release MUST 2: lifecycle jobs stay offline and exercise mandatory local provenance", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const windows = workflowJob(workflow, "windows-lifecycle");
    const unix = workflowJob(workflow, "unix-lifecycle");
    expect(windows).toContain("checksums.txt");
    expect(windows).toContain("Get-FileHash -Algorithm SHA256");
    expect(windows).toContain("install.ps1 -From $releaseRoot -Offline");
    expect(windows).toContain("aidlc-lifecycle-provenance-fixture");
    expect(windows).toContain("aidlc-gh.ps1");
    expect(windows).toContain("$env:AIDLC_GH_BIN = $ghFixture");
    expect(windows).toContain("$Remaining.Count -ne 11");
    expect(windows).toContain("$Remaining.Count -ne 13");
    expect(windows).toContain("$Remaining[0] -ne 'attestation'");
    expect(windows).toContain("$Remaining[1] -ne 'verify'");
    expect(windows).toContain(
      "[IO.Path]::GetFileName($subject) -ne 'checksums.txt'",
    );
    expect(windows).toContain("$Remaining[3] -ne '--bundle'");
    expect(windows).toContain("$bundle -ne $expectedBundle");
    expect(windows).toContain(
      "-not (Test-Path -LiteralPath $bundle -PathType Leaf)",
    );
    expect(windows).toContain(
      "$Remaining[6] -ne $env:AIDLC_TEST_GH_REPOSITORY",
    );
    expect(windows).toContain(
      "$Remaining[8] -ne $env:AIDLC_TEST_GH_WORKFLOW",
    );
    expect(windows).toContain(
      "$Remaining[10] -ne $env:AIDLC_TEST_GH_SOURCE_REF",
    );
    expect(windows).toContain(
      "$Remaining[12] -ne $env:AIDLC_TEST_GH_SOURCE_DIGEST",
    );
    expect(windows).toContain(
      "$env:AIDLC_TEST_GH_CHECKSUM_SHA",
    );
    expect(windows).toContain("offline installer did not verify release provenance");
    expect(windows).toContain("offline installer did not bind the trusted source digest");
    expect(windows).toContain(
      "$harnesses = @('claude', 'codex', 'copilot', 'cursor', 'kiro', 'kiro-ide', 'opencode')",
    );
    expect(windows).toContain(
      "$env:COPILOT_HOME = Join-Path $env:RUNNER_TEMP 'aidlc-copilot-home'",
    );
    expect(windows).toContain("@{ trustedFolders = @($project) }");
    expect(windows).toContain(
      "& $command config --project-dir $project --harness $harness --mcp none --quiet",
    );
    expect(windows).toContain("& $command doctor --project-dir $project --quiet");
    expect(windows).toContain("$deadline = [DateTime]::UtcNow.AddSeconds(60)");
    expect(windows).toContain("$commandExists = Test-Path -LiteralPath $command");
    expect(windows).toContain(
      "$rootExists = Test-Path -LiteralPath $env:AIDLC_INSTALL_ROOT",
    );
    expect(windows).toContain(
      "if (-not $commandExists -and -not $rootExists) { break }",
    );
    expect(windows).toContain(
      "if (Test-Path -LiteralPath $command) { throw 'aidlc.cmd survived uninstall' }",
    );
    expect(windows).toContain(
      "if (Test-Path -LiteralPath $env:AIDLC_INSTALL_ROOT) { " +
        "throw 'install root survived purge uninstall' }",
    );
    expect(unix).toContain("sha256sum -c checksums.txt");
    expect(unix).toContain("shasum -a 256 -c checksums.txt");
    expect(unix).toContain('install.sh" --from "$release" --offline');
    expect(unix).toContain("aidlc-lifecycle-provenance-fixture");
    expect(unix).toContain('AIDLC_GH_BIN="$gh_bin"');
    expect(unix).toContain('[ "$#" -eq 11 ] || [ "$#" -eq 13 ]');
    expect(unix).toContain('[ "$4" = --bundle ] || exit 2');
    expect(unix).toMatch(
      /\[ "\$5" = "\$\{3%\/checksums\.txt\}\/aidlc-release\.intoto\.jsonl" \] \|\| exit 2/,
    );
    expect(unix).toMatch(/\[ "\$\{10\}" = --source-ref \] \|\| exit 2/);
    expect(unix).toMatch(
      /\[ "\$\{11\}" = "\$AIDLC_TEST_GH_SOURCE_REF" \] \|\| exit 2/,
    );
    expect(unix).toMatch(/\[ "\$\{12\}" = --source-digest \] \|\| exit 2/);
    expect(unix).toMatch(
      /\[ "\$\{13\}" = "\$AIDLC_TEST_GH_SOURCE_DIGEST" \] \|\| exit 2/,
    );
    expect(unix).toContain(
      '[ "$actual" = "$AIDLC_TEST_GH_CHECKSUM_SHA" ] || exit 2',
    );
    expect(unix).toContain('test -s "$gh_marker"');
    expect(unix).toContain(
      "for harness in claude codex copilot cursor kiro kiro-ide opencode; do",
    );
    expect(unix).toContain(
      'export COPILOT_HOME="$RUNNER_TEMP/aidlc-copilot-home"',
    );
    expect(unix).toContain(
      `printf '{"trustedFolders":["%s"]}\\n' "$project" > "$COPILOT_HOME/config.json"`,
    );
    expect(unix).toContain(
      '--project-dir "$project" --harness "$harness" --mcp none --quiet',
    );
    expect(unix).toContain(
      'env PATH="/usr/bin:/bin" "$command" doctor',
    );
    for (const lifecycle of [windows, unix]) {
      expect(lifecycle).not.toContain("attestation verify");
      expect(lifecycle).not.toContain("AIDLC_RELEASE_REPOSITORY");
      expect(lifecycle).not.toContain("AIDLC_RELEASE_WORKFLOW");
    }
    const unixInstaller = readFileSync(INSTALL_SH, "utf-8");
    const windowsInstaller = readFileSync(INSTALL_PS1, "utf-8");
    for (const variable of [
      "AIDLC_RELEASE_REPOSITORY",
      "AIDLC_RELEASE_WORKFLOW",
    ]) {
      expect(unixInstaller).toContain(variable);
      expect(windowsInstaller).toContain(variable);
    }
    expect(unixInstaller).toContain("AIDLC_GH_BIN");
  });

  test("release lifecycle verifier fixtures reject every missing binding", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const root = temp("aidlc-t244-verifier-fixture-");
    const subjectDirectory = join(root, "subject");
    mkdirSync(subjectDirectory, { recursive: true });
    const checksums = join(subjectDirectory, "checksums.txt");
    const bundle = join(subjectDirectory, "aidlc-release.intoto.jsonl");
    const marker = join(root, "verified");
    writeFileSync(checksums, "checksums fixture\n");
    writeFileSync(bundle, "bundle fixture\n");
    const repository = "awslabs/aidlc-workflows";
    const signerWorkflow = `${repository}/.github/workflows/release.yml`;
    const sourceRef = "refs/heads/main";
    const sourceDigest = "1".repeat(40);
    const checksumSha = createHash("sha256")
      .update(readFileSync(checksums))
      .digest("hex");
    const args = [
      "attestation",
      "verify",
      checksums,
      "--bundle",
      bundle,
      "--repo",
      repository,
      "--signer-workflow",
      signerWorkflow,
      "--source-ref",
      sourceRef,
      "--source-digest",
      sourceDigest,
    ];
    const env = {
      ...process.env,
      AIDLC_TEST_GH_MARKER: marker,
      AIDLC_TEST_GH_REPOSITORY: repository,
      AIDLC_TEST_GH_WORKFLOW: signerWorkflow,
      AIDLC_TEST_GH_SOURCE_REF: sourceRef,
      AIDLC_TEST_GH_SOURCE_DIGEST: sourceDigest,
      AIDLC_TEST_GH_CHECKSUM_SHA: checksumSha,
    };

    let invoke: (fixtureArgs: string[]) => ReturnType<typeof spawnSync>;
    if (process.platform === "win32") {
      const windows = workflowJob(workflow, "windows-lifecycle");
      const source = /@'\n([\s\S]*?)\n\s*'@ \| Set-Content -LiteralPath \$ghFixture/
        .exec(windows)?.[1];
      expect(source).toBeDefined();
      const fixture = join(root, "aidlc-gh.ps1");
      writeFileSync(fixture, `${source}\n`);
      const powershell = Bun.which("pwsh") ?? Bun.which("powershell");
      expect(powershell).not.toBeNull();
      invoke = (fixtureArgs) =>
        spawnSync(
          powershell as string,
          ["-NoProfile", "-NonInteractive", "-File", fixture, ...fixtureArgs],
          { env, encoding: "utf-8" },
        );
    } else {
      const unix = workflowJob(workflow, "unix-lifecycle");
      const source =
        /cat >"\$gh_bin" <<'AIDLC_GH_FIXTURE'\n([\s\S]*?)\n\s*AIDLC_GH_FIXTURE/
          .exec(unix)?.[1];
      expect(source).toBeDefined();
      const fixture = join(root, "aidlc-gh");
      writeFileSync(fixture, `${source}\n`, { mode: 0o755 });
      invoke = (fixtureArgs) =>
        spawnSync("sh", [fixture, ...fixtureArgs], { env, encoding: "utf-8" });
    }

    const valid = invoke(args);
    expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);
    expect(existsSync(marker)).toBe(true);

    for (let index = 0; index < args.length; index += 1) {
      rmSync(marker, { force: true });
      const missing = invoke(args.filter((_, candidate) => candidate !== index));
      expect(missing.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    }

    rmSync(marker, { force: true });
    const duplicate = invoke([...args, "--repo", "conflicting/repository"]);
    expect(duplicate.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("release MUST 3: protected signing emits one immutable attested artifact", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: Record<string, {
        permissions?: Record<string, string>;
        environment?: string;
      }>;
    };
    expect(parsed.jobs.publish.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
    expect(parsed.jobs.authorize.environment).toBe("release");
    expect(parsed.jobs.publish.environment).toBe("release");
    const publish = workflowJob(workflow, "publish");
    expect(publish).toContain(`ref: \${{ needs.authorize.outputs.sha }}`);
    expect(publish).toContain("git fetch --no-tags origin main");
    expect(publish).toContain('test -z "$tag_refs"');
    expect(publish).toContain('test "$(git rev-parse HEAD)" = "$AUTHORIZED_SHA"');
    expect(publish).toContain("sha256sum -c checksums.txt");
    expect(publish).toContain("name: Attest staged release assets");
    expect(publish).toContain("name: Stage offline provenance bundle");
    expect(publish).toContain("steps.provenance.outputs.bundle-path");
    expect(publish).toContain("name: Validate complete attested release candidate");
    expect(publish).toContain("bun scripts/verify-release.ts candidate");
    expect(publish).toContain('--source-digest "$AUTHORIZED_SHA"');
    expect(publish).toContain("name: attested-release");
    expect(publish).toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(publish).not.toContain("gh release create");
    expect(publish).not.toContain("--draft");
    expect(publish.indexOf("sha256sum -c checksums.txt"))
      .toBeLessThan(publish.indexOf("name: Attest staged release assets"));
    expect(publish.indexOf("name: Attest staged release assets"))
      .toBeLessThan(publish.indexOf("name: Stage offline provenance bundle"));
    expect(publish.indexOf("name: Stage offline provenance bundle"))
      .toBeLessThan(publish.indexOf("bun scripts/verify-release.ts candidate"));
    expect(publish.indexOf("bun scripts/verify-release.ts candidate"))
      .toBeLessThan(publish.indexOf("name: attested-release"));
  });

  test("release MUST 4: promote authenticates metadata before verifying every asset", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: Record<string, {
        needs?: string | string[];
        permissions?: Record<string, string>;
        environment?: string;
        if?: string;
      }>;
    };
    expect(parsed.jobs["verify-release"]).toBeUndefined();
    expect(workflow).not.toContain("\n  verify-release:\n");
    expect(parsed.jobs.promote.needs).toEqual(["authorize", "publish"]);
    expect(parsed.jobs.promote.permissions).toEqual({ contents: "read" });
    expect(parsed.jobs.promote.environment).toBe("release");
    expect(parsed.jobs.promote.if).toBeUndefined();
    const writeCapableJobs = Object.entries(parsed.jobs)
      .filter(([, job]) => job.permissions?.contents === "write");
    expect(writeCapableJobs).toEqual([]);
    const promote = workflowJob(workflow, "promote");
    expect(promote).toContain("name: Mint release publication token");
    expect(promote).toContain("name: Re-verify release repository controls");
    expect(promote).toContain("permission-contents: write");
    expect(promote).toContain("permission-administration: write");
    expect(promote).toContain(
      `GH_TOKEN: \${{ steps.release-publication-token.outputs.token }}`,
    );
    expect(promote.match(/bun scripts\/verify-release\.ts controls/g)).toHaveLength(1);
    expect(promote).toContain(
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    );
    expect(promote).toContain("name: attested-release");
    expect(promote.match(/gh attestation verify "\$checksums"/g)).toHaveLength(2);
    expect(promote.match(/gh attestation verify "\$asset"/g)).toHaveLength(2);
    expect(promote).toContain('--repo "$GH_REPO"');
    expect(promote).toContain('--bundle "$bundle"');
    expect(promote).toContain('--source-ref "$source_ref"');
    expect(promote).toContain('--source-digest "$AUTHORIZED_SHA"');
    expect(promote).toContain("--list-assets");
    expect(promote).toMatch(/test "\$\{#attested_assets\[@\]\}" -eq 10/);
    expect(promote).not.toContain(
      'select(.kind == "binary" or .kind == "runtime")',
    );
    const firstChecksumsAttestation = promote.indexOf(
      'gh attestation verify "$checksums"',
    );
    const secondChecksumsAttestation = promote.indexOf(
      'gh attestation verify "$checksums"',
      firstChecksumsAttestation + 1,
    );
    expect(firstChecksumsAttestation).toBeGreaterThan(-1);
    expect(secondChecksumsAttestation).toBeGreaterThan(firstChecksumsAttestation);
    expect(secondChecksumsAttestation)
      .toBeLessThan(promote.indexOf("bun scripts/verify-release.ts candidate"));
    expect(promote.indexOf("bun scripts/verify-release.ts candidate"))
      .toBeLessThan(promote.indexOf('sh "$journey_release/install.sh"'));
    expect(promote).toContain(
      'verified_digests="$RUNNER_TEMP/aidlc-verified-release.sha256"',
    );
    expect(promote).toContain(
      `find . -mindepth 1 -maxdepth 1 -type f -printf '%P\\0'`,
    );
    expect(promote).toContain('test "$(wc -l <"$verified_digests")" -eq 13');
    expect(promote).toContain('journey_release="$server_root/latest/download"');
    expect(promote).toContain('sh "$journey_release/install.sh"');
    expect(promote).toContain(
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    );
    expect(promote).toContain("bun-version: 1.3.14");
    expect(promote).toContain('server_root="$RUNNER_TEMP/aidlc-release-server"');
    expect(promote).toContain('mkdir -p "$journey_release"');
    expect(promote).toContain("Bun.serve({");
    expect(promote).toContain("Bun.file(join(root, ...parts))");
    expect(promote).toContain("return await file.exists()");
    expect(promote).not.toContain("{ dir:");
    expect(promote).toContain('env PATH="/usr/bin:/bin"');
    expect(promote).toContain('AIDLC_GH_BIN="$gh_bin"');
    expect(promote).toContain(
      '--release-base-url "http://127.0.0.1:$port"',
    );
    expect(promote).toContain('"$command" version');
    expect(promote).toContain(
      '--project-dir "$project" --harness claude --mcp none --quiet',
    );
    expect(promote).toContain('"$command" doctor');
    expect(promote).toContain(
      "Coverage boundary: pre-gate lifecycle jobs scaffold and doctor all",
    );
    expect(
      [...promote.matchAll(/--harness ([a-z-]+)/g)].map((match) => match[1]),
    ).toEqual(["claude"]);
    // Repo-relative trust roots: identical to the installer defaults on the
    // canonical repository, and the only shape that lets a fork shakedown
    // verify its own attestations (round-6 evidence). A literal repository
    // name must never appear.
    expect(promote).toContain('AIDLC_RELEASE_REPOSITORY="$GH_REPO"');
    expect(promote).toContain(
      'AIDLC_RELEASE_WORKFLOW="$GH_REPO/.github/workflows/release.yml"',
    );
    expect(promote).not.toContain('AIDLC_RELEASE_REPOSITORY="awslabs');
  });

  test("release MUST 5: publication re-verifies the exact verified draft", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const publisher = readFileSync(RELEASE_PUBLISHER, "utf-8");
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: Record<string, {
        needs?: string | string[];
        permissions?: Record<string, string>;
        environment?: string;
        if?: string;
        steps?: Array<{ name?: string; if?: string; run?: string }>;
      }>;
    };
    expect(parsed.jobs.promote.needs).toEqual(["authorize", "publish"]);
    expect(parsed.jobs.promote.permissions).toEqual({ contents: "read" });
    expect(parsed.jobs.promote.environment).toBe("release");
    expect(parsed.jobs.promote.if).toBeUndefined();
    const verificationStep = parsed.jobs.promote.steps?.find(
      (step) => step.name === "Authenticate and verify immutable release bytes",
    );
    const promotionStep = parsed.jobs.promote.steps?.find(
      (step) => step.name === "Publish and re-verify exact verified release bytes",
    );
    expect(verificationStep).toBeDefined();
    expect(verificationStep?.if).toBeUndefined();
    expect(promotionStep).toBeDefined();
    expect(promotionStep?.if).toBeUndefined();
    const promote = workflowJob(workflow, "promote");
    expect(promote).toContain("bun scripts/publish-release.ts");
    expect(promote).toContain('--repository "$GH_REPO"');
    expect(promote).toContain('--staging-tag "$STAGING_TAG"');
    expect(promote).toContain('--target "$AUTHORIZED_SHA"');
    expect(promote).toContain("--expected-assets 13");
    expect(promote).not.toContain("gh release create");
    expect(promote).not.toContain("gh release edit");
    expect(promote).not.toContain("gh release view");
    expect(promote).not.toContain("gh release download");
    expect(promote.indexOf("name: Mint release publication token"))
      .toBeLessThan(promote.indexOf("name: Re-verify release repository controls"));
    expect(promote.indexOf("name: Re-verify release repository controls"))
      .toBeLessThan(promote.indexOf("name: Publish and re-verify exact verified release bytes"));
    expect(promote).toContain(
      'sha256sum -c "$RUNNER_TEMP/aidlc-verified-release.sha256"',
    );
    expect(publisher).toContain("draft: true");
    expect(publisher).toContain("releasesUrl}/generate-notes");
    expect(publisher.match(/name: notes\.name/g)).toHaveLength(2);
    expect(publisher.match(/body: notes\.body/g)).toHaveLength(2);
    expect(publisher).toContain("release.name !== notes.name");
    expect(publisher).toContain("release.body !== notes.body");
    expect(publisher).toContain("tag_name: options.stagingTag");
    expect(publisher).toContain("target_commitish: options.targetCommitish");
    // GitHub rejects conditional headers on release updates with 400, so the
    // publisher must never send one; safety comes from re-verification.
    expect(publisher).not.toContain('"If-Match"');
    expect(publisher).not.toContain("412");
    expect(publisher).toContain("tag_name: options.tag");
    expect(publisher).toContain("draft: false");
    expect(publisher).toContain("await requireTagAbsent(");
    expect(publisher).toContain("await requireTagTarget(");
    expect(publisher).toContain("aidlc-staging-");
    expect(publisher).toContain("must be removed first");
    expect(publisher).toContain("gh release delete");
    expect(publisher).toContain("class PublicationEvidenceError");
    expect(publisher.match(/await verifyRemoteBytes\(/g)).toHaveLength(2);
    expect(publisher).toContain(
      "draft release changed while remote bytes were verified",
    );
    expect(publisher).toContain(
      "treat it as compromised and supersede it with a corrective release",
    );
    expect(promote.indexOf("name: Authenticate and verify immutable release bytes"))
      .toBeLessThan(
        promote.indexOf("name: Publish and re-verify exact verified release bytes"),
      );
    expect(promote.lastIndexOf("bun scripts/verify-release.ts candidate"))
      .toBeLessThan(promote.indexOf("bun scripts/publish-release.ts"));
    expect(promote).toContain(
      'sha256sum -c "$RUNNER_TEMP/aidlc-verified-release.sha256"',
    );
    expect(
      promote.indexOf(
        'sha256sum -c "$RUNNER_TEMP/aidlc-verified-release.sha256"',
      ),
    ).toBeLessThan(promote.indexOf("bun scripts/publish-release.ts"));
    expect(workflow).not.toContain("inputs.draft");
    expect(workflow).not.toContain(
      "description: Leave the verified release as a draft for manual promotion",
    );
  });

  test("release MUST 6: failed staging drafts are retained without publishing v tags", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const publisher = readFileSync(RELEASE_PUBLISHER, "utf-8");
    const publish = workflowJob(workflow, "publish");
    const promote = workflowJob(workflow, "promote");
    expect(publish).toContain("name: attested-release");
    expect(publish).not.toContain("gh release create");
    expect(promote.indexOf("name: Authenticate and verify immutable release bytes"))
      .toBeLessThan(promote.indexOf("bun scripts/publish-release.ts"));
    expect(promote).not.toContain("gh release delete");
    expect(promote).not.toContain("gh release edit");
    expect(promote).not.toContain("always()");
    expect(promote).not.toContain("continue-on-error");
    expect(workflow).not.toContain("gh release delete");
    expect(workflow).not.toContain("gh release create");
    expect(publisher).toContain("was retained for inspection");
    expect(publisher).not.toContain("cleanupAllowed");
    expect(publisher).not.toContain("draft cleanup failed");
  });

  test("the default branch preserves a manual v1 release forwarder", () => {
    const workflow = readFileSync(V1_RELEASE_DISPATCH_WORKFLOW, "utf-8");
    expect(workflow).toContain("name: Dispatch v1 Release");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain(
      'if [[ ! "$INPUT_TAG" =~ ^v1\\.[0-9]+\\.[0-9]+$ ]]; then',
    );
    expect(workflow).toContain("gh workflow run release.yml");
    expect(workflow).toContain('--ref "$INPUT_TAG"');
    expect(workflow).not.toContain("\n  push:");
  });

  test("CI test job builds the projections before running the tiers", () => {
    // The same generator-driven rule for the per-push gate: the tiers exercise
    // CI-built bytes from a fresh checkout.
    const ci = readFileSync(
      join(REPO_ROOT, ".github", "workflows", "ci.yml"),
      "utf-8",
    );
    expect(ci).toContain("branches:\n      - main");
    expect(ci).not.toContain("branches:\n      - v2");
    const testJob = ci.slice(ci.indexOf("\n  test:"), ci.indexOf("\n  changelog-guard:"));
    const regen = "run: bun scripts/package.ts";
    expect(testJob).toContain(regen);
    expect(testJob.indexOf(regen)).toBeLessThan(testJob.indexOf("tests/run-tests.ts"));
    const deepJob = ci.slice(ci.indexOf("\n  test-deep:"), ci.indexOf("\n  changelog-guard:"));
    expect(deepJob).toContain(regen);
    expect(deepJob.indexOf(regen)).toBeLessThan(deepJob.indexOf("tests/run-tests.ts"));
  });
});
