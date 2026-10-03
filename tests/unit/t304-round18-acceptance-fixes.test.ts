// covers: tool:aidlc-init, function:probeHarnessCli, function:providerDoctorCheck, function:acquireRelease

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  probeHarnessCli,
  providerDoctorCheck,
} from "../../core/tools/aidlc-config-diagnostics.ts";
import { firstRunPathRemediation } from "../../core/tools/aidlc-init.ts";
import { acquireRelease, digest } from "../../core/tools/aidlc-release.ts";
import { quoteCommandArgument as quoteForShell } from "../../core/tools/aidlc-runtime-paths.ts";
import { serveReleaseFixture, writeReleaseFixture } from "../harness/release-fixture.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import {
  canonicalPolicyPath,
  machineTransactionRoot,
} from "../../core/tools/aidlc-install-paths.ts";
import {
  executePlan,
  transactionState,
  writeOperation,
} from "../../core/tools/aidlc-transaction.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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

// Children never see the host's real machine install: a developer with
// `aidlc` installed would otherwise get every harness listed twice (the
// explicit AIDLC_RUNTIME_ROOT plus the active machine runtime).
const ISOLATED_MACHINE = temp("aidlc-t304-machine-");

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("AIDLC_") || name.startsWith("CLAUDE_") || name.startsWith("KIRO_")) {
      delete env[name];
    }
  }
  return {
    ...env,
    AIDLC_INSTALL_ROOT: join(ISOLATED_MACHINE, "share", "aidlc"),
    AIDLC_BIN_DIR: join(ISOLATED_MACHINE, "bin"),
    ...extra,
  };
}

function readmeCopyProject(): string {
  const project = temp("aidlc-t304-copy-");
  mkdirSync(join(project, ".git"));
  cpSync(join(DIST, "claude", ".claude"), join(project, ".claude"), {
    recursive: true,
  });
  cpSync(join(DIST, "claude", "aidlc"), join(project, "aidlc"), {
    recursive: true,
  });
  return project;
}

// Copy-channel bytes stamped as another release: the only field the pin
// comparison and the recovery read.
const OTHER_VERSION = "9.9.9";
function claudeSourceAt(version: string, tree = DIST): string {
  const root = temp("aidlc-t304-source-");
  cpSync(join(tree, "claude"), root, { recursive: true });
  const stampPath = join(root, ".claude", "tools", "data", "aidlc-stamp.json");
  const stamp = JSON.parse(readFileSync(stampPath, "utf-8"));
  writeFileSync(stampPath, `${JSON.stringify({ ...stamp, frameworkVersion: version }, null, 2)}\n`);
  return root;
}

function frameworkVersionOf(project: string): string {
  return JSON.parse(
    readFileSync(join(project, ".claude", "tools", "data", "aidlc-stamp.json"), "utf-8"),
  ).frameworkVersion;
}

function runCopied(
  project: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; harnessDir?: string; cwd?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    BUN,
    [join(project, options.harnessDir ?? ".claude", "tools", "aidlc.ts"), ...args],
    {
      cwd: options.cwd ?? project,
      env: cleanEnv(options.env),
      input: options.input,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function expectCopyChannelPurity(output: string): void {
  expect(output).not.toContain("Run: ");
  expect(output).not.toMatch(
    /(?:^|[\s`'"])aidlc (?:config|doctor|update|use|uninstall|version)(?:\s|[`'"]|$)/m,
  );
}

// A copy made the documented way: the whole runtime/<harness>/ root, so the
// project also has the shipped root files (.mcp.json, .gitignore).
function fullCopyProject(tree = DIST): string {
  const project = temp("aidlc-t304-full-copy-");
  mkdirSync(join(project, ".git"));
  cpSync(join(tree, "claude"), project, { recursive: true });
  return project;
}

function configuredFullCopy(): string {
  const project = fullCopyProject();
  const configured = runCopied(project, [
    "config", "project", "--mcp", "none", "--yes", "--from", join(DIST, "claude"),
  ]);
  if (configured.status !== 0) throw new Error(configured.stdout + configured.stderr);
  return project;
}

// A native projection configured once from the native tree, so it has a
// baseline; the explicit runtime root stands in for the installed release. Its
// machine is its own, since these tests install and register releases.
function configuredNativeProject(): { project: string; machine: NodeJS.ProcessEnv } {
  const root = temp("aidlc-t304-native-machine-");
  const machine = {
    AIDLC_INSTALL_ROOT: join(root, "share", "aidlc"),
    AIDLC_BIN_DIR: join(root, "bin"),
  };
  const project = fullCopyProject(DIST_RELEASE);
  const configured = runCopied(project, ["config", "project", "--mcp", "none", "--yes"], {
    env: { ...machine, AIDLC_RUNTIME_ROOT: DIST_RELEASE },
  });
  if (configured.status !== 0) throw new Error(configured.stdout + configured.stderr);
  return { project, machine };
}

function harnessJson(project: string): { project: { mcp: string } } {
  return JSON.parse(readFileSync(join(project, ".claude", "tools", "data", "harness.json"), "utf-8"));
}

function fixLine(output: string): string {
  const line = output.split("\n").find((item) => item.startsWith("fix: "));
  if (!line) throw new Error(`no fix line in:\n${output}`);
  return line.slice("fix: ".length);
}

// The fake verifier accepts the fixture's attestation bundle and nothing else.
const FAKE_GH = join(REPO_ROOT, "tests", "fixtures", "bin", process.platform === "win32" ? "gh.cmd" : "gh");

// A served release for the download tests. A server in this process cannot
// answer a child that blocks it, so these runs spawn asynchronously.
function releaseServer(version: string): { root: string; baseUrl: string; requests: string[]; stop(): void } {
  const root = temp("aidlc-t304-release-");
  writeReleaseFixture({ root, version, distributions: ["claude", "codex"] });
  const server = serveReleaseFixture(root);
  return { root, baseUrl: server.baseUrl, requests: server.requests, stop: () => server.stop() };
}

async function runAsync(
  command: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: cleanEnv(options.env),
    stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
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

function runCopiedAsync(
  project: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return runAsync([BUN, join(project, ".claude", "tools", "aidlc.ts"), ...args], {
    cwd: options.cwd ?? project,
    env: options.env,
    input: options.input,
  });
}

// Runs a printed fix exactly as shown, through the shell a user would paste it into.
function followFix(
  fix: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return runAsync(
    process.platform === "win32" ? ["powershell", "-NoProfile", "-Command", fix] : ["sh", "-c", fix],
    { cwd, env },
  );
}

function runWizard(
  input: string,
  options: { hasCredentials?: boolean } = {},
): {
  project: string;
  status: number;
  stdout: string;
  stderr: string;
} {
  const project = temp("aidlc-t304-wizard-");
  mkdirSync(join(project, ".git"));
  const hasCredentials = options.hasCredentials ?? true;
  const detection = JSON.stringify({
    harnesses: {
      claude: { found: false, probed: true },
      codex: { found: false, probed: true },
      copilot: { found: false, probed: true },
      cursor: { found: false, probed: true },
      kiro: { found: false, probed: true },
      "kiro-ide": { found: false, probed: false },
      opencode: { found: false, probed: true },
    },
    aws: {
      hasCredentials,
      sources: hasCredentials ? ["fixture"] : [],
      profiles: [],
      regions: hasCredentials ? ["us-east-2"] : [],
      files: [],
    },
    runtimeIssues: [],
  });
  const result = spawnSync(BUN, [INIT, "config", "--project-dir", project], {
    cwd: project,
    env: cleanEnv({
      AIDLC_RUNTIME_ROOT: DIST_RELEASE,
      AIDLC_TEST_CONFIG_TTY: "1",
      AIDLC_TEST_CONFIG_DETECTION_JSON: detection,
    }),
    input,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    project,
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("t304 copied projection configuration", () => {
  test("copied projection descriptors reject traversal before reading outside bytes", () => {
    const project = readmeCopyProject();
    const outside = temp("aidlc-t304-outside-");
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "keep\n");
    const descriptorPath = join(
      project,
      ".claude",
      "tools",
      "data",
      "aidlc-projection.json",
    );
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    descriptor.managedDirectories.push("../outside");
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    const result = runCopied(project, [
      "config",
      "models",
      "--preset",
      "balanced",
      "--project",
      "--yes",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "managed directory is not a safe top-level name",
    );
    expect(readFileSync(sentinel, "utf-8")).toBe("keep\n");
  });

  test.skipIf(process.platform === "win32")(
    "copied projection metadata and nested content must be regular files",
    () => {
      const metadataProject = readmeCopyProject();
      const descriptorPath = join(
        metadataProject,
        ".claude",
        "tools",
        "data",
        "aidlc-projection.json",
      );
      const outsideDescriptor = join(temp("aidlc-t304-metadata-"), "descriptor.json");
      writeFileSync(outsideDescriptor, readFileSync(descriptorPath));
      rmSync(descriptorPath);
      symlinkSync(outsideDescriptor, descriptorPath);
      const metadata = runCopied(metadataProject, [
        "config",
        "models",
        "--preset",
        "balanced",
        "--project",
        "--yes",
      ]);
      expect(metadata.status).not.toBe(0);
      expect(metadata.stdout + metadata.stderr).toContain(
        "projected path traverses a symlink: .claude/tools/data/aidlc-projection.json",
      );

      const nestedProject = readmeCopyProject();
      const outside = join(temp("aidlc-t304-link-"), "outside.txt");
      writeFileSync(outside, "outside\n");
      symlinkSync(outside, join(nestedProject, ".claude", "linked-outside"));
      const nested = runCopied(nestedProject, [
        "config",
        "models",
        "--preset",
        "balanced",
        "--project",
        "--yes",
      ]);
      expect(nested.status).not.toBe(0);
      expect(nested.stdout + nested.stderr).toContain(
        "links and special files are not valid projection content",
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "root integrations reject a symlinked parent before reading outside bytes",
    () => {
      const project = readmeCopyProject();
      const outside = temp("aidlc-t304-parent-link-");
      writeFileSync(join(outside, "secret.txt"), "outside-secret\n");
      symlinkSync(outside, join(project, "escape"));
      const descriptorPath = join(
        project,
        ".claude",
        "tools",
        "data",
        "aidlc-projection.json",
      );
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
      descriptor.rootIntegrations.push({
        path: "escape/secret.txt",
        policy: "whole-file",
      });
      writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

      const result = runCopied(project, [
        "config",
        "models",
        "--preset",
        "balanced",
        "--project",
        "--yes",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "projected path traverses a symlink: escape/secret.txt",
      );
      expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe(
        "outside-secret\n",
      );
    },
  );

  test("the exact README Claude copy records settings and diagnostic answers without a runtime", () => {
    const project = readmeCopyProject();
    const models = runCopied(project, [
      "config",
      "models",
      "--preset",
      "balanced",
      "--project",
      "--yes",
    ]);
    expect(models.status, models.stdout + models.stderr).toBe(0);
    expect(models.stdout).not.toContain("harness claude is not installed");

    const providers = runCopied(project, [
      "config",
      "providers",
      "--provider",
      "other",
      "--acknowledge",
      "--yes",
    ]);
    expect(providers.status, providers.stdout + providers.stderr).toBe(0);

    const trust = runCopied(project, [
      "config",
      "trust",
      "--acknowledge",
      "--yes",
    ]);
    expect(trust.status, trust.stdout + trust.stderr).toBe(0);

    expect(JSON.parse(readFileSync(join(project, "aidlc.settings.json"), "utf-8")))
      .toEqual(expect.objectContaining({
        models: expect.objectContaining({ preset: "balanced" }),
      }));
    const harness = JSON.parse(
      readFileSync(join(project, ".claude", "tools", "data", "harness.json"), "utf-8"),
    );
    expect(harness.providers.provider).toBe("other");
    expect(harness.trust.reviewed).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("bare config announces and uses the recognized copied-projection walk", () => {
    const project = readmeCopyProject();
    const result = runCopied(project, ["config"], {
      input: "n\n",
      env: { AIDLC_TEST_CONFIG_TTY: "1" },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "using the existing copied projection",
    );
    expect(result.stdout).toContain("Setup check -");
    expect(result.stdout).not.toContain("harness claude is not installed");
  });

  test("a copied project changes its project choices from its own files, with no download", () => {
    // The #1197 case, on a copy made the documented way (root files included),
    // with one server the user added before configuring anything.
    const project = fullCopyProject();
    const mcpPath = join(project, ".mcp.json");
    const mcp = () => JSON.parse(readFileSync(mcpPath, "utf-8")) as { mcpServers?: Record<string, unknown> };
    const servers = () => Object.keys(mcp().mcpServers ?? {}).sort();
    expect(servers().length).toBeGreaterThan(0);
    const withMine = mcp();
    withMine.mcpServers = { ...withMine.mcpServers, mine: { command: "my-server" } };
    writeFileSync(mcpPath, `${JSON.stringify(withMine, null, 2)}\n`);
    // A fresh copy's first run works from its own files: no download.
    const first = runCopied(project, ["config", "project", "--plugins", "all", "--mcp", "none", "--yes"]);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(harnessJson(project).project.mcp).toBe("none");
    // Only the shipped servers go, known by their signatures.
    expect(servers()).toEqual(["mine"]);

    const later = runCopied(project, ["config", "project", "--completions", "zsh", "--yes"]);
    expect(later.status, later.stdout + later.stderr).toBe(0);

    // The shipped list is gone now, so turning MCP back on needs the release.
    const back = runCopied(project, ["config", "project", "--mcp", "defaults", "--yes"]);
    expect(back.status).toBe(4);
    expect(back.stdout).toContain(
      `error: .claude no longer has the MCP server list for ${AIDLC_VERSION}\n`,
    );
    expect(back.stdout).toContain(
      `offline: get https://github.com/awslabs/aidlc-workflows/releases/download/v${AIDLC_VERSION}/aidlc-copy-runtime-${AIDLC_VERSION}.tar.gz and its .sha256 into one folder, then add --from <that file>`,
    );
    expect(fixLine(back.stdout)).toBe(
      "bun .claude/tools/aidlc.ts config project --mcp defaults --yes --download",
    );
    expectCopyChannelPurity(back.stdout);
  }, 120_000);

  test("own files never adopt a user's edit to a shipped server", () => {
    const project = fullCopyProject();
    const on = runCopied(project, ["config", "project", "--mcp", "defaults", "--yes", "--from", join(DIST, "claude")]);
    expect(on.status, on.stdout + on.stderr).toBe(0);
    const mcpPath = join(project, ".mcp.json");
    const edited = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const [name] = Object.keys(edited.mcpServers);
    edited.mcpServers[name] = { ...edited.mcpServers[name], env: { MINE: "1" } };
    writeFileSync(mcpPath, `${JSON.stringify(edited, null, 2)}\n`);
    const again = runCopied(project, ["config", "project", "--completions", "zsh", "--yes"]);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(project, ".claude", "tools", "data", "aidlc-manifest.json"), "utf-8"),
    );
    expect(Object.keys(manifest.rootContributions[".mcp.json"].entries)).not.toContain(name);
    // A later refresh from release bytes leaves the edit alone.
    const refresh = runCopied(project, ["config", "--harness", "claude", "--yes", "--from", join(DIST, "claude")]);
    expect(refresh.status, refresh.stdout + refresh.stderr).toBe(0);
    expect(JSON.parse(readFileSync(mcpPath, "utf-8")).mcpServers[name].env).toEqual({ MINE: "1" });
  }, 120_000);

  test("a release URL's credentials, query, fragment, and path secrets never reach any output", () => {
    const project = configuredFullCopy();
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    const asset = `aidlc-copy-runtime-${OTHER_VERSION}.tar.gz`;
    const args = ["config", "project", "--mcp", "defaults", "--yes"];
    const cases = [
      {
        base: "https://someone:hunter2@mirror.example/releases?token=abc#frag",
        secrets: ["hunter2", "someone", "token=abc", "frag"],
        shown: `offline: get ${asset} from https://mirror.example and its .sha256`,
      },
      {
        // A mirror's path can itself be the credential.
        base: "https://mirror.example/sk-live-TOKEN123/releases",
        secrets: ["TOKEN123"],
        shown: `offline: get ${asset} from https://mirror.example and its .sha256`,
      },
      {
        // Plain HTTP off loopback is never offered as a way to fetch a release.
        base: "http://mirror.example/releases",
        secrets: ["http://mirror.example"],
        shown: `offline: get ${asset} from the configured release mirror and its .sha256`,
      },
    ];
    for (const item of cases) {
      const env = { AIDLC_RELEASE_BASE_URL: item.base };
      for (const mode of [[], ["--quiet"], ["--json"]]) {
        const result = runCopied(project, [...args, ...mode], { env });
        expect(result.status).toBe(4);
        for (const secret of item.secrets) {
          expect(result.stdout + result.stderr, `${item.base} ${mode.join(" ")} ${secret}`).not.toContain(secret);
        }
      }
      expect(runCopied(project, args, { env }).stdout).toContain(item.shown);
    }
  }, 90_000);

  test("a failed download never repeats a mirror's path", async () => {
    const project = configuredFullCopy();
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    // Nothing listens on port 9, so the download fails in transport. A path
    // may hold quotes or an apostrophe before its secret.
    const args = ["config", "project", "--mcp", "defaults", "--yes", "--download"];
    for (const base of [
      "http://127.0.0.1:9/sk-live-TOKEN123/releases",
      "http://127.0.0.1:9/o'TOKEN123/releases",
      "http://127.0.0.1:9/a\"TOKEN123/releases",
    ]) {
      for (const mode of [[], ["--quiet"], ["--json"]]) {
        const result = await runCopiedAsync(project, [...args, ...mode], { env: { AIDLC_RELEASE_BASE_URL: base } });
        expect(result.status, `${base} ${mode.join(" ")}`).toBe(3);
        expect(result.stdout + result.stderr, `${base} ${mode.join(" ")}`).not.toContain("TOKEN123");
      }
    }
  }, 90_000);

  test.skipIf(process.platform === "win32")("a printed command never carries a control character", () => {
    // A project directory can name anything the filesystem allows, including a
    // terminal escape; what config prints must stay one line of plain text.
    const parent = temp("aidlc-t304-control-");
    const project = join(parent, "app\u001b[31mred");
    mkdirSync(project);
    cpSync(configuredFullCopy(), project, { recursive: true });
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    const elsewhere = temp("aidlc-t304-control-cwd-");
    for (const section of [["project", "--mcp", "defaults"], ["models", "--preset", "balanced", "--project"]]) {
      const result = runCopied(project, ["config", ...section, "--yes", "--project-dir", project], { cwd: elsewhere });
      expect(result.status).toBe(4);
      expect(result.stdout + result.stderr).not.toContain("\u001b");
      expect(result.stdout).not.toContain("fix:");
    }
  }, 90_000);

  test("--from takes the copy runtime archive or its runtime/ folder, and checks a .sha256 beside it", () => {
    const releaseRoot = temp("aidlc-t304-local-release-");
    writeReleaseFixture({ root: releaseRoot, version: AIDLC_VERSION, distributions: ["claude", "codex"] });
    const asset = `aidlc-copy-runtime-${AIDLC_VERSION}.tar.gz`;
    const archive = join(releaseRoot, asset);

    const project = fullCopyProject();
    const verified = runCopied(project, ["config", "project", "--mcp", "none", "--yes", "--from", archive]);
    expect(verified.status, verified.stdout + verified.stderr).toBe(0);
    expect(verified.stdout).not.toContain("without a .sha256");

    const alone = temp("aidlc-t304-archive-alone-");
    cpSync(archive, join(alone, asset));
    const unverified = runCopied(project, ["config", "project", "--mcp", "defaults", "--yes", "--from", join(alone, asset)]);
    expect(unverified.status, unverified.stdout + unverified.stderr).toBe(0);
    expect(unverified.stdout).toContain(`Used ${asset} without a .sha256 beside it, so its checksum was not checked.`);

    writeFileSync(join(alone, `${asset}.sha256`), `${"0".repeat(64)}  ${asset}\n`);
    const mismatch = runCopied(project, ["config", "project", "--mcp", "none", "--yes", "--from", join(alone, asset)]);
    expect(mismatch.status).toBe(4);
    expect(mismatch.stdout).toContain(`${asset} does not match ${asset}.sha256; nothing was changed`);

    // The extracted folder holds every harness: a fresh project names one.
    const extracted = temp("aidlc-t304-runtime-folder-");
    mkdirSync(join(extracted, "runtime"));
    cpSync(join(DIST, "claude"), join(extracted, "runtime", "claude"), { recursive: true });
    cpSync(join(DIST, "codex"), join(extracted, "runtime", "codex"), { recursive: true });
    const fresh = temp("aidlc-t304-fresh-");
    mkdirSync(join(fresh, ".git"));
    // A fresh project has no tools of its own, so a checkout's dist tool runs it.
    const ambiguous = spawnSync(BUN, [
      join(DIST, "claude", ".claude", "tools", "aidlc.ts"),
      "config", "--yes", "--project-dir", fresh, "--from", join(extracted, "runtime"),
    ], { cwd: fresh, env: cleanEnv(), encoding: "utf-8" });
    expect(ambiguous.stdout).toContain("holds the claude, codex harnesses; pass --harness <name>");
  }, 120_000);

  test("a copied project fetches the release its pin needs, verified, and the printed fix runs as shown", async () => {
    const project = configuredFullCopy();
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    const release = releaseServer(OTHER_VERSION);
    const env = { AIDLC_RELEASE_BASE_URL: release.baseUrl, AIDLC_GH_BIN: FAKE_GH };
    const asset = `aidlc-copy-runtime-${OTHER_VERSION}.tar.gz`;
    try {
      const args = ["config", "models", "--preset", "balanced", "--project", "--yes"];
      const result = await runCopiedAsync(project, args, { env });
      expect(result.status).toBe(4);
      expect(result.stdout).toContain(
        `error: this project is pinned to ${OTHER_VERSION}, but .claude has ${AIDLC_VERSION} files\n`,
      );
      // models takes no source flag, so offline it refreshes from the file first.
      expect(result.stdout).toContain(
        `offline: get ${release.baseUrl}/download/v${OTHER_VERSION}/${asset} and its .sha256 into one folder, run bun .claude/tools/aidlc.ts config --harness claude --from <that file>, then rerun this command`,
      );
      const fix = fixLine(result.stdout);
      expect(fix).toBe("bun .claude/tools/aidlc.ts config models --preset balanced --project --yes --download");
      expectCopyChannelPurity(result.stdout);
      expect(release.requests.some((path) => path.endsWith(asset))).toBe(false);

      // Scripts get the one runnable command, in both machine-readable modes.
      expect((await runCopiedAsync(project, [...args, "--quiet"], { env })).stdout)
        .toBe("bun .claude/tools/aidlc.ts config models --preset balanced --project --yes --quiet --download\n");
      const json = JSON.parse((await runCopiedAsync(project, [...args, "--json"], { env })).stdout);
      expect(json.remediation)
        .toBe("bun .claude/tools/aidlc.ts config models --preset balanced --project --yes --json --download");

      const followed = await followFix(fix, project, env);
      expect(followed.status, followed.stdout + followed.stderr).toBe(0);
      expect(followed.stdout).toContain(
        `Downloaded ${asset} and verified its checksum and release attestation.`,
      );
      expect(frameworkVersionOf(project)).toBe(OTHER_VERSION);
      expect(JSON.parse(readFileSync(join(project, "aidlc.settings.json"), "utf-8")).models.preset)
        .toBe("balanced");
    } finally {
      release.stop();
    }
  }, 180_000);

  test("at a terminal, one question names the download and finishes the command", async () => {
    const project = configuredFullCopy();
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    const release = releaseServer(OTHER_VERSION);
    const host = new URL(release.baseUrl).host;
    const asset = `aidlc-copy-runtime-${OTHER_VERSION}.tar.gz`;
    const env = { AIDLC_RELEASE_BASE_URL: release.baseUrl, AIDLC_GH_BIN: FAKE_GH, AIDLC_TEST_CONFIG_TTY: "1" };
    const question = `Apply project configuration changes? This first downloads ${OTHER_VERSION} from ${host} and updates .claude. [y/N]:`;
    try {
      const args = ["config", "project", "--mcp", "defaults"];
      const no = await runCopiedAsync(project, args, { env, input: "n\n" });
      expect(no.stdout).toContain(
        `This project is pinned to ${OTHER_VERSION}, but .claude has ${AIDLC_VERSION} files.\n`,
      );
      expect(no.stdout).toContain(question);
      expect(no.status).toBe(4);
      expect(release.requests.some((path) => path.endsWith(asset))).toBe(false);
      expect(frameworkVersionOf(project)).toBe(AIDLC_VERSION);

      const dry = await runCopiedAsync(project, [...args, "--dry-run"], { env, input: "y\n" });
      expect(dry.stdout).not.toContain("[y/N]");
      expect(fixLine(dry.stdout)).toContain("--dry-run --download");
      expect(release.requests.some((path) => path.endsWith(asset))).toBe(false);

      const yes = await runCopiedAsync(project, args, { env, input: "y\n" });
      expect(yes.status, yes.stdout + yes.stderr).toBe(0);
      expect(yes.stdout.split("[y/N]:").length - 1).toBe(1);
      expect(frameworkVersionOf(project)).toBe(OTHER_VERSION);
      expect(harnessJson(project).project.mcp).toBe("defaults");
    } finally {
      release.stop();
    }
  }, 180_000);

  test("a failed checksum or attestation stops with nothing changed and no way around it", async () => {
    const project = configuredFullCopy();
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    const release = releaseServer(OTHER_VERSION);
    const env = { AIDLC_RELEASE_BASE_URL: release.baseUrl, AIDLC_GH_BIN: FAKE_GH };
    const asset = `aidlc-copy-runtime-${OTHER_VERSION}.tar.gz`;
    const args = ["config", "models", "--preset", "balanced", "--project", "--yes", "--download"];
    try {
      writeFileSync(join(release.root, `${asset}.sha256`), `${"0".repeat(64)}  ${asset}\n`);
      const bad = await runCopiedAsync(project, args, { env });
      expect(bad.status).toBe(4);
      expect(bad.stdout).toContain(`error: ${asset} failed its checksum; nothing was changed\n`);
      expect(bad.stdout).not.toContain("fix:");
      expect(frameworkVersionOf(project)).toBe(AIDLC_VERSION);

      writeFileSync(
        join(release.root, `${asset}.sha256`),
        `${digest(join(release.root, asset))}  ${asset}\n`,
      );
      writeFileSync(join(release.root, "aidlc-release.intoto.jsonl"), "tampered\n");
      const unattested = await runCopiedAsync(project, args, { env });
      expect(unattested.status).toBe(4);
      expect(unattested.stdout).toContain(
        `the ${OTHER_VERSION} release metadata failed verification; nothing was changed`,
      );
      expect(unattested.stdout).not.toContain("fix:");
      expect(frameworkVersionOf(project)).toBe(AIDLC_VERSION);
    } finally {
      release.stop();
    }
  }, 180_000);

  test("an unreachable or offline release host falls back to the offline route", async () => {
    const project = configuredFullCopy();
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    const args = ["config", "project", "--mcp", "defaults", "--yes", "--download"];
    for (const env of [{ AIDLC_RELEASE_BASE_URL: "http://127.0.0.1:9" }, { AIDLC_OFFLINE: "1" }]) {
      const result = await runCopiedAsync(project, args, { env });
      expect(result.status, JSON.stringify(env)).toBe(3);
      expect(result.stdout).toContain(
        `error: this project is pinned to ${OTHER_VERSION}, but .claude has ${AIDLC_VERSION} files; the download failed:`,
      );
      expect(result.stdout).toContain(
        `/download/v${OTHER_VERSION}/aidlc-copy-runtime-${OTHER_VERSION}.tar.gz and its .sha256 into one folder, then add --from <that file>`,
      );
      // The message carries the reason and the offline route; rerunning the
      // same command is not offered as a fix.
      expect(result.stdout).not.toContain("fix:");
      expect(frameworkVersionOf(project)).toBe(AIDLC_VERSION);
    }
  }, 120_000);

  test("adding a harness to a copied project fetches that harness", async () => {
    const project = fullCopyProject();
    const release = releaseServer(AIDLC_VERSION);
    // No gh here: the checksum still binds the archive, and the note says so.
    const env = { AIDLC_RELEASE_BASE_URL: release.baseUrl, AIDLC_GH_BIN: join(temp("aidlc-t304-no-gh-"), "gh") };
    // A gh too old for attestations is not "not installed".
    const oldGhDir = temp("aidlc-t304-old-gh-");
    const oldGh = join(oldGhDir, process.platform === "win32" ? "gh.cmd" : "gh");
    writeFileSync(oldGh, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      const result = await runCopiedAsync(project, ["config", "--harness", "codex", "--yes"], { env });
      expect(result.status).toBe(4);
      expect(result.stdout).toContain(`error: adding codex needs the ${AIDLC_VERSION} release files\n`);
      const fix = fixLine(result.stdout);
      expect(fix).toBe("bun .claude/tools/aidlc.ts config --harness codex --yes --download");
      const followed = await followFix(fix, project, env);
      expect(followed.status, followed.stdout + followed.stderr).toBe(0);
      expect(existsSync(join(project, ".codex", "tools", "data", "harness.json"))).toBe(true);
      expect(followed.stdout).toContain("gh is not installed, so its release attestation was not checked.");
      const withOldGh = fullCopyProject();
      const old = await runCopiedAsync(withOldGh, ["config", "--harness", "codex", "--yes", "--download"], {
        env: { ...env, AIDLC_GH_BIN: oldGh },
      });
      expect(old.status, old.stdout + old.stderr).toBe(0);
      expect(old.stdout).toContain("this gh cannot verify release attestations");
    } finally {
      release.stop();
    }
  }, 180_000);

  test("natively, a missing pinned release is installed and registered, then the command finishes", async () => {
    const { project, machine } = configuredNativeProject();
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    const release = releaseServer(OTHER_VERSION);
    const env = { ...machine, AIDLC_RELEASE_BASE_URL: release.baseUrl, AIDLC_GH_BIN: FAKE_GH };
    try {
      const args = ["config", "models", "--preset", "balanced", "--project", "--yes"];
      const result = await runCopiedAsync(project, args, { env });
      expect(result.status).toBe(4);
      expect(result.stdout).toContain(`error: this project is pinned to ${OTHER_VERSION}, which is not installed\n`);
      expect(result.stdout).toContain(
        `offline: aidlc config --pin ${OTHER_VERSION} --offline --from <release directory>, then rerun this command`,
      );
      const fix = fixLine(result.stdout);
      expect(fix).toBe("aidlc config models --preset balanced --project --yes --download");
      // `aidlc` is the native command; the projected dispatcher is the same code.
      const followed = await runCopiedAsync(project, [...fix.split(" ").slice(1)], { env });
      expect(followed.status, followed.stdout + followed.stderr).toBe(0);
      expect(followed.stdout).toContain(`Installed ${OTHER_VERSION}.`);
      expect(followed.stdout).toContain(`Registered this project's ${OTHER_VERSION} pin on this machine.`);
      expect(frameworkVersionOf(project)).toBe(OTHER_VERSION);
    } finally {
      release.stop();
    }
  }, 240_000);

  test("natively, a refused refresh never registers the pin, and a tampered release is a hard stop", async () => {
    const { project, machine } = configuredNativeProject();
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    // A local edit to a managed file makes the refresh to the pin conflict.
    const tool = join(project, ".claude", "tools", "aidlc-command.ts");
    writeFileSync(tool, `${readFileSync(tool, "utf-8")}\n// local edit\n`);
    const release = releaseServer(OTHER_VERSION);
    const env = { ...machine, AIDLC_RELEASE_BASE_URL: release.baseUrl, AIDLC_GH_BIN: FAKE_GH };
    const pins = join(machine.AIDLC_INSTALL_ROOT as string, "pins.json");
    const registered = () =>
      existsSync(pins) && readFileSync(pins, "utf-8").includes(JSON.stringify(realpathSync(project)).slice(1, -1));
    try {
      const args = ["config", "models", "--preset", "balanced", "--project", "--yes", "--download"];
      const refused = await runCopiedAsync(project, args, { env });
      expect(refused.status).toBe(4);
      expect(refused.stdout).toContain("config conflict");
      expect(registered()).toBe(false);
      expect(frameworkVersionOf(project)).toBe(AIDLC_VERSION);
    } finally {
      release.stop();
    }

    // A release whose runtime bytes do not match its checksums stops cold.
    const other = configuredNativeProject();
    writeFileSync(join(other.project, ".aidlc-version"), "9.9.11\n");
    const tampered = releaseServer("9.9.11");
    const runtime = join(tampered.root, "aidlc-runtime-9.9.11.tar.gz");
    writeFileSync(runtime, Buffer.concat([readFileSync(runtime), Buffer.from("tampered")]));
    try {
      const result = await runCopiedAsync(other.project, [
        "config", "models", "--preset", "balanced", "--project", "--yes", "--download",
      ], { env: { ...other.machine, AIDLC_RELEASE_BASE_URL: tampered.baseUrl, AIDLC_GH_BIN: FAKE_GH } });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("fix:");
      expect(frameworkVersionOf(other.project)).toBe(AIDLC_VERSION);
    } finally {
      tampered.stop();
    }
  }, 240_000);

  test("natively, an installed pinned release updates stale files first, and a dry run never installs", () => {
    const { project, machine } = configuredNativeProject();
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    const models = ["config", "models", "--preset", "balanced", "--project", "--yes"];
    const installed = { ...machine, AIDLC_RUNTIME_ROOT: claudeSourceAt(OTHER_VERSION, DIST_RELEASE) };
    const updated = runCopied(project, models, { env: installed });
    expect(updated.status, updated.stdout + updated.stderr).toBe(0);
    expect(updated.stdout).toContain(
      `Updating .claude from ${AIDLC_VERSION} to ${OTHER_VERSION}, the pinned release (already installed).`,
    );
    expect(frameworkVersionOf(project)).toBe(OTHER_VERSION);

    writeFileSync(join(project, ".aidlc-version"), "9.9.10\n");
    // A change, so the run reaches the source instead of "model policy unchanged".
    const dry = runCopied(project, [
      "config", "models", "--preset", "thorough", "--project", "--yes", "--dry-run", "--download",
    ], { env: machine });
    expect(dry.status).toBe(2);
    expect(dry.stdout).toContain(
      "--dry-run does not install releases; install 9.9.10 first with aidlc config --pin 9.9.10",
    );
  }, 120_000);

  test("from another directory, the printed fix runs as shown, even with shell characters in the path", async () => {
    const parent = temp("aidlc-t304-elsewhere-");
    const project = join(parent, "my app $HOME");
    mkdirSync(project);
    const copied = fullCopyProject();
    cpSync(copied, project, { recursive: true });
    const configured = runCopied(project, [
      "config", "project", "--mcp", "none", "--yes", "--from", join(DIST, "claude"),
    ]);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    writeFileSync(join(project, ".aidlc-version"), `${OTHER_VERSION}\n`);
    const elsewhere = temp("aidlc-t304-cwd-");
    const release = releaseServer(OTHER_VERSION);
    const env = { AIDLC_RELEASE_BASE_URL: release.baseUrl, AIDLC_GH_BIN: FAKE_GH };
    try {
      const result = await runCopiedAsync(
        project,
        ["config", "project", "--mcp", "defaults", "--yes", "--project-dir", project],
        { env, cwd: elsewhere },
      );
      expect(result.status, result.stdout + result.stderr).toBe(4);
      const fix = fixLine(result.stdout);
      expect(fix).toContain(quoteForShell(join(project, ".claude", "tools", "aidlc.ts")));
      expect(fix).toContain(`--project-dir ${quoteForShell(project)}`);
      expect(fix.endsWith(" --download")).toBe(true);
      const followed = await followFix(fix, elsewhere, env);
      expect(followed.status, followed.stdout + followed.stderr).toBe(0);
      expect(frameworkVersionOf(project)).toBe(OTHER_VERSION);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      release.stop();
    }
  }, 180_000);

  test.each([
    ["copy", "root"],
    ["copy", "project"],
    ["native", "root"],
    ["native", "project"],
  ] as const)(
    "active-workflow preview keeps the %s command context (%s)",
    (channel, section) => {
      const tree = channel === "copy" ? DIST : DIST_RELEASE;
      const project = temp("aidlc-t304-active-preview-");
      const elsewhere = temp("aidlc-t304-preview-caller-");
      mkdirSync(join(project, ".git"));
      for (const harness of ["claude", "codex"]) {
        cpSync(join(tree, harness, `.${harness}`), join(project, `.${harness}`), {
          recursive: true,
        });
      }
      cpSync(join(tree, "claude", "aidlc"), join(project, "aidlc"), { recursive: true });
      cpSync(join(tree, "codex", "AGENTS.md"), join(project, "AGENTS.md"));
      const configured = runCopied(project, [
        "config", "--harness", "codex", "--from", join(tree, "codex"), "--yes", "--json",
      ], { harnessDir: ".codex" });
      expect(configured.status, configured.stdout + configured.stderr).toBe(0);
      writeFileSync(join(project, ".aidlc-version"), `${AIDLC_VERSION}\n`);

      const intents = join(project, "aidlc", "spaces", "default", "intents");
      const dirName = "260927-active-preview";
      mkdirSync(join(intents, dirName), { recursive: true });
      writeFileSync(join(intents, "intents.json"), JSON.stringify([{
        uuid: "deadbeef-0000-4000-8000-000000000003",
        slug: "active-preview",
        dirName,
        scope: "feature",
        status: "in-flight",
      }]));
      writeFileSync(join(intents, dirName, "aidlc-state.md"),
        "# AI-DLC State Tracking\n\n## Current Status\n- **Status**: Running\n");

      const source = temp("aidlc-t304-preview-source-");
      cpSync(join(tree, "codex"), source, { recursive: true });
      const tool = join(".codex", "tools", "aidlc-command.ts");
      writeFileSync(join(source, tool), `${readFileSync(join(source, tool), "utf-8")}\n// candidate refresh\n`);
      const args = [
        "config",
        ...(section === "project" ? ["project", "--mcp", "none"] : []),
        "--project-dir", project, "--harness", "codex", "--from", source, "--yes", "--json",
      ];
      const options = { harnessDir: ".codex", cwd: elsewhere };
      // Include nested files, directory names and modes, the caller, the source,
      // and machine settings: neither refusal nor preview may change them.
      const protectedRoots = [project, elsewhere, source, ISOLATED_MACHINE];
      const before = protectedRoots.map(transactionState);
      const refused = runCopied(project, args, options);
      expect(refused.status, refused.stdout + refused.stderr).toBe(4);
      const failure = JSON.parse(refused.stdout);
      expect(failure.message).toContain("refusing to refresh while 1 workflow(s) are active");
      expect(protectedRoots.map(transactionState)).toEqual(before);

      // Follow the advertised instruction by retaining the complete invocation.
      const preview = runCopied(project, [...args, "--dry-run"], options);
      expect(preview.status, preview.stdout + preview.stderr).toBe(0);
      const plan = JSON.parse(preview.stdout).data;
      expect(plan.projectDir).toBe(realpathSync(project));
      expect(plan.distribution).toBe("codex");
      expect(plan.actions).toContainEqual(expect.objectContaining({
        path: tool.replaceAll("\\", "/"),
        action: "update",
      }));
      if (section === "project") expect(plan.choices.next.mcp).toBe("none");
      expect(protectedRoots.map(transactionState)).toEqual(before);
      expect(failure.remediation).toContain("Rerun this command with --dry-run");
      expect(failure.remediation).toContain("without writing");
      expectCopyChannelPurity(failure.remediation);
    },
  );


  test("a pin that is not a release id never reaches a printed message or command", () => {
    // A committed .aidlc-version is repository-controlled text; --quiet prints
    // the remediation alone, so it must not carry shell syntax from the pin.
    for (const pin of ["1.0.0; touch pwned", "$(touch pwned)", "1.0.0\ntouch pwned"]) {
      const project = readmeCopyProject();
      writeFileSync(join(project, ".aidlc-version"), `${pin}\n`);
      for (const extra of [[], ["--from", join(DIST, "claude")]]) {
        const args = ["config", "project", "--mcp", "none", "--yes", ...extra];
        const human = runCopied(project, args);
        expect(human.status).toBe(2);
        expect(human.stdout).toContain(".aidlc-version must contain one release version id");
        expect(human.stdout).toContain("usage: bun .claude/tools/aidlc.ts config --unpin\n");
        expect(human.stdout).not.toContain("pwned");
        expect(runCopied(project, [...args, "--quiet"]).stdout)
          .toBe("bun .claude/tools/aidlc.ts config --unpin\n");
        const json = JSON.parse(runCopied(project, [...args, "--json"]).stdout);
        expect(json.remediation).toBe("bun .claude/tools/aidlc.ts config --unpin");
        expect(JSON.stringify(json)).not.toContain("pwned");
      }
    }
  }, 120_000);

  test("human config usage errors use the shared lowercase voice", () => {
    const project = readmeCopyProject();
    const result = runCopied(project, [
      "config",
      "models",
      "--preset",
      "balanced",
      "--project",
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toStartWith("error:");
    expect(result.stdout).toContain(
      "\nusage: bun .claude/tools/aidlc.ts config models --preset balanced --project --yes",
    );
    expect(result.stdout).not.toContain("ERROR ");
    expect(result.stdout).not.toContain("Run: ");
  });

  test("copy-channel doctor, config, and error output never leaks native invocations", () => {
    const project = readmeCopyProject();
    const machineRoot = temp("aidlc-t304-machine-");
    const env = { AIDLC_INSTALL_ROOT: machineRoot };
    const git = spawnSync("git", ["init", "-q"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      encoding: "utf-8",
    });
    expect(git.status, git.stderr ?? "").toBe(0);
    const doctor = runCopied(project, ["doctor"], { env });
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain(
      "fix: run `bun .claude/tools/aidlc.ts update --check`",
    );
    // The generic fix never quotes the doctor command itself (#1411).
    expect(doctor.stdout).toContain(
      "fix: add --verbose to see the details, correct the named condition, then run doctor again",
    );

    const topTypo = runCopied(project, ["confg"], { env });
    expect(topTypo.status).toBe(2);
    expect(topTypo.stderr).toContain(
      "usage: bun .claude/tools/aidlc.ts <command> [flags]",
    );

    const sectionTypo = runCopied(project, ["config", "modles"], {
      env: { ...env, AIDLC_TEST_CONFIG_TTY: "1" },
      input: "",
    });
    expect(sectionTypo.status).toBe(2);
    expect(sectionTypo.stderr).toContain(
      "usage: bun .claude/tools/aidlc.ts config <section> [flags]",
    );

    const noYes = runCopied(project, [
      "config",
      "models",
      "--preset",
      "balanced",
      "--project",
    ], { env });
    expect(noYes.status).toBe(2);

    for (const result of [doctor, topTypo, sectionTypo, noYes]) {
      expectCopyChannelPurity(`${result.stdout}${result.stderr}`);
    }
  });

  test("legacy harness policy breakage collapses to one doctor row", () => {
    const project = readmeCopyProject();
    const path = join(project, ".claude", "tools", "data", "harness.json");
    const harness = JSON.parse(readFileSync(path, "utf-8"));
    harness.models = { schemaVersion: 1 };
    writeFileSync(path, `${JSON.stringify(harness, null, 2)}\n`);
    const doctor = runCopied(project, ["doctor", "--json"]);
    expect(doctor.status).toBe(1);
    const checks = (JSON.parse(doctor.stdout) as {
      data: { checks: Array<{ label: string; fix?: string }> };
    }).data.checks;
    const legacy = checks.filter((check) =>
      `${check.label} ${check.fix ?? ""}`.includes(
        "legacy policy key(s)",
      )
    );
    expect(legacy).toHaveLength(1);
    expect(legacy[0].label).toContain("Harness data:");
    expect(legacy[0].fix).toContain(
      "Remove models",
    );
  });
});

describe("t304 first-run prompt and detection safety", () => {
  test("EOF at a no-default harness prompt cancels with bounded output", () => {
    const result = runWizard("");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Nothing written.");
    expect(result.stdout.length).toBeLessThan(20_000);
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
  });

  test("EOF mid-customize cancels with bounded output", () => {
    const result = runWizard("1\n2");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Nothing written.");
    expect(result.stdout.length).toBeLessThan(20_000);
  });

  test("a same-named executable is not detected when its version probe fails", () => {
    expect(probeHarnessCli("claude", {
      interactivePath: "/fixture",
      which: () => "/fixture/claude",
      run: () => ({ status: 1, stdout: "not claude\n" }),
    })).toEqual(expect.objectContaining({
      status: "missing",
      path: "/fixture/claude",
    }));
    expect(probeHarnessCli("cursor", {
      interactivePath: "/fixture",
      which: (command) => command === "cursor" ? "/fixture/cursor" : null,
      run: () => ({ status: 0, stdout: "Cursor 1.0.0\n" }),
    })).toEqual(expect.objectContaining({
      command: "cursor",
      status: "found",
    }));
  });

  test("Windows PATH remediation names the actual User PATH directory", () => {
    expect(firstRunPathRemediation(
      "win32",
      "C:\\Users\\Example\\AppData\\Local\\aidlc\\bin",
    )).toEqual([
      "Add C:\\Users\\Example\\AppData\\Local\\aidlc\\bin to your User PATH in Windows Settings, then open a new terminal.",
    ]);
    expect(firstRunPathRemediation("linux", "/home/example/.local/bin").join("\n"))
      .toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  test("recommended defaults preserve the current provider without credentials", () => {
    const result = runWizard("1\n\n", { hasCredentials: false });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("current model provider preserved");
    expect(result.stdout).not.toContain("Choose and configure a model provider");
    expect(result.stdout).not.toContain("Run: ");
    expectCopyChannelPurity(result.stdout);
    const harness = JSON.parse(
      readFileSync(join(result.project, ".claude", "tools", "data", "harness.json"), "utf-8"),
    );
    expect(harness.providers).toEqual(expect.objectContaining({
      provider: "current",
    }));
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Kiro recommended defaults record no provider answer", () => {
    const result = runWizard("5\n\n");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "no provider settings; model access comes with Kiro CLI",
    );
    const harness = JSON.parse(
      readFileSync(join(result.project, ".kiro", "tools", "data", "harness.json"), "utf-8"),
    );
    expect(harness.providers).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The provider answer is harness-dependent, so a harness change at the
  // check-your-answers table must re-derive it. Before the fix the previous
  // harness's answer was applied: Kiro recorded a provider and chased model
  // access it never needed.
  test("changing the harness at the summary re-derives the provider answer", () => {
    // Claude Code first (1), customize (2), accept every step, then edit step 1
    // to Kiro CLI (5) and apply.
    const toKiro = runWizard("1\n2\n\n\n\n\n\n\n1\n5\n\n");
    expect(toKiro.status, toKiro.stdout + toKiro.stderr).toBe(0);
    expect(toKiro.stdout).toContain("2. Provider     keep current");
    expect(toKiro.stdout).toContain(
      "2. Provider     comes with Kiro CLI",
    );
    expect(toKiro.stdout).not.toContain("Verify Amazon Bedrock model access");
    const kiro = JSON.parse(
      readFileSync(join(toKiro.project, ".kiro", "tools", "data", "harness.json"), "utf-8"),
    );
    expect(kiro.providers).toBeUndefined();

    // Kiro CLI first (5), customize (2), accept every step (step 2 asks nothing
    // on Kiro), then edit step 1 to Claude Code (1) and apply.
    const toClaude = runWizard("5\n2\n\n\n\n\n\n1\n1\n\n");
    expect(toClaude.status, toClaude.stdout + toClaude.stderr).toBe(0);
    expect(toClaude.stdout).not.toContain("Claude Code provides its own model access");
    expect(toClaude.stdout).toContain("2. Provider     keep current");
    const claude = JSON.parse(
      readFileSync(join(toClaude.project, ".claude", "tools", "data", "harness.json"), "utf-8"),
    );
    expect(claude.providers.provider).toBe("current");
    expect(claude.providers.pendingActions).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t304 diagnostics and release truthfulness", () => {
  test("corrupt harness JSON is a failing provider doctor row with recovery", () => {
    const project = readmeCopyProject();
    const path = join(project, ".claude", "tools", "data", "harness.json");
    writeFileSync(path, "{\n");
    const check = providerDoctorCheck(project);
    expect(check).toEqual(expect.objectContaining({
      pass: false,
      label: "Providers: could not read recorded answers",
    }));
    expect(check.severity).toBeUndefined();
    expect(check.fix).toContain("restore");
  });

  test("HTTP 404 explains that no native release is published yet", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("missing", { status: 404 }),
    });
    try {
      await expect(acquireRelease({
        version: "9.9.9",
        names: ["aidlc-linux-x64"],
        baseUrl: `http://127.0.0.1:${server.port}`,
      })).rejects.toThrow("No published native release is available yet");
    } finally {
      server.stop(true);
    }
  });
});

describe("t304 transaction boundaries", () => {
  test("candidate validation cannot race a stale destination into commit", () => {
    const root = temp("aidlc-t304-transaction-race-");
    const target = join(root, "value.txt");
    writeFileSync(target, "planned\n");
    const planned = transactionState(target);

    expect(() =>
      executePlan({
        schemaVersion: 1,
        root,
        operations: [writeOperation("value.txt", "replacement\n", planned)],
      }, {
        validateCandidates: () => {
          writeFileSync(target, "concurrent\n");
        },
      })
    ).toThrow("value.txt: source changed after planning");
    expect(readFileSync(target, "utf-8")).toBe("concurrent\n");
  });

  test("machine scope excludes unrelated descendants of the shared lock root", () => {
    const home = temp("aidlc-t304-route-scope-");
    const install = join(home, ".local", "share", "aidlc");
    const bin = join(home, ".local", "bin");
    mkdirSync(join(home, ".local"), { recursive: true });
    const prior = {
      install: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
      route: process.env.AIDLC_ROUTE_ID,
      scope: process.env.AIDLC_ROUTE_MUTATION_SCOPE,
      project: process.env.AIDLC_ROUTE_PROJECT_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = install;
    process.env.AIDLC_BIN_DIR = bin;
    process.env.AIDLC_ROUTE_ID = "test-machine";
    process.env.AIDLC_ROUTE_MUTATION_SCOPE = "machine";
    process.env.AIDLC_ROUTE_PROJECT_DIR = home;
    try {
      const root = machineTransactionRoot();
      const unrelated = join(home, ".local", "unrelated-app", "owned.txt");
      expect(() =>
        executePlan({
          schemaVersion: 1,
          root,
          operations: [
            writeOperation(
              relative(root, canonicalPolicyPath(unrelated)),
              "no\n",
              "absent",
            ),
          ],
        })
      ).toThrow("machine mutation scope cannot mutate project path");
      expect(existsSync(unrelated)).toBe(false);

      const owned = join(install, "owned.txt");
      executePlan({
        schemaVersion: 1,
        root,
        operations: [
          writeOperation(
            relative(root, canonicalPolicyPath(owned)),
            "yes\n",
            "absent",
          ),
        ],
      });
      expect(readFileSync(owned, "utf-8")).toBe("yes\n");
    } finally {
      const restore = (name: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore("AIDLC_INSTALL_ROOT", prior.install);
      restore("AIDLC_BIN_DIR", prior.bin);
      restore("AIDLC_ROUTE_ID", prior.route);
      restore("AIDLC_ROUTE_MUTATION_SCOPE", prior.scope);
      restore("AIDLC_ROUTE_PROJECT_DIR", prior.project);
    }
  });
});
