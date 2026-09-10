// covers: tool:aidlc-init, function:readTerminalLine

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { readTerminalLine } from "../../core/tools/aidlc-command.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { TransactionFilesystemError } from "../../core/tools/aidlc-transaction.ts";
import {
  firstRunFailureLines,
  firstRunPathRemediation,
  launchedFromEditorTerminal,
} from "../../core/tools/aidlc-init.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const RUNTIME = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];
// Complete overrides keep PTY tests independent of shell startup PATH additions.
const HARNESS_NAMES = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "kiro",
  "kiro-ide",
  "opencode",
] as const;

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function executable(path: string, output = ""): void {
  writeFileSync(
    path,
    `#!/bin/sh\n${output ? `printf '%s\\n' ${JSON.stringify(output)}` : "exit 0"}\n`,
    { mode: 0o755 },
  );
}

function treeSnapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const snapshot: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(path).isDirectory()) {
        snapshot[`${rel}/`] = "";
        visit(path, rel);
      } else {
        snapshot[rel] = readFileSync(path).toString("base64");
      }
    }
  };
  visit(root, "");
  return snapshot;
}

function detection(
  bin: string,
  harnesses: Record<string, { found: boolean; version?: string }> = {
    claude: { found: true, version: "claude 2.1.220" },
  },
  runtimeIssue = false,
): string {
  return JSON.stringify({
    harnesses: Object.fromEntries(
      HARNESS_NAMES.map((name) => {
        const value = harnesses[name] ?? {
          found: false,
          probed: name !== "kiro-ide",
        };
        return [
          name,
          {
            ...value,
            ...(value.found ? { path: join(bin, name === "kiro" ? "kiro-cli" : name) } : {}),
          },
        ];
      }),
    ),
    aws: {
      hasCredentials: true,
      sources: ["instance role"],
      profiles: [],
      regions: ["us-east-2"],
      files: [],
    },
    runtimeIssues: runtimeIssue
      ? [{
          id: "runtime-aidlc-missing",
          message: "aidlc is absent from the non-interactive hook PATH",
          remediation: "Add ~/.local/bin to PATH.",
        }]
      : [],
    bedrockReachable: true,
  });
}

// The editor-terminal markers launchedFromEditorTerminal reads. The runner's
// own terminal must not decide which harness a case selects.
const EDITOR_TERMINAL_ENV = [
  "TERM_PROGRAM",
  "VSCODE_GIT_ASKPASS_NODE",
] as const;

function hostEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of EDITOR_TERMINAL_ENV) delete env[name];
  return env;
}

// Children never see the host's real machine install: a developer with
// `aidlc` installed would otherwise get every harness listed twice (the
// explicit AIDLC_RUNTIME_ROOT plus the active machine runtime).
function isolatedMachineEnv(): NodeJS.ProcessEnv {
  const machine = temp("aidlc-t299-machine-");
  const isolatedHome = join(machine, "home");
  const scratch = join(machine, "tmp");
  mkdirSync(isolatedHome);
  mkdirSync(scratch);
  return {
    AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
    AIDLC_BIN_DIR: join(machine, "bin"),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    XDG_CACHE_HOME: join(isolatedHome, ".cache"),
    CLAUDE_CONFIG_DIR: join(isolatedHome, ".claude"),
    CODEX_HOME: undefined,
    AWS_CONFIG_FILE: join(isolatedHome, ".aws", "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(isolatedHome, ".aws", "credentials"),
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_SESSION_TOKEN: undefined,
    AWS_PROFILE: undefined,
    AWS_DEFAULT_PROFILE: undefined,
    AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
    AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_AIDLC_DEFAULT_SCOPE: undefined,
    AIDLC_SESSION_OVERRIDE: undefined,
    AIDLC_SKIP_SOURCE_FRESHNESS: undefined,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  };
}

const REQUIRED_FILESYSTEM_FAILURES = [
  { operation: "file-rename", code: "ENOTSUP", diagnostic: "file replacement by rename" },
  { operation: "directory-rename", code: "EOPNOTSUPP", diagnostic: "directory rename" },
  { operation: "append", code: "ENOSYS", diagnostic: "mutable file append" },
] as const;
type FilesystemFailure = (typeof REQUIRED_FILESYSTEM_FAILURES)[number];
type FilesystemTrace = {
  event: string;
  pid: number;
  args?: string[];
  childPid?: number;
  status?: number;
  path?: string;
  source?: string;
  destination?: string;
  code?: string;
  flags?: string | number;
  owner?: { schemaVersion: number; pid: number; host: string; token: string };
};

// These faults model only API availability on the project filesystem. Local
// temp storage, release sources, credentials, and the test runner are untouched.
// Passing them says nothing about a real S3 driver's atomicity or durability.
function filesystemPreload(
  failure?: FilesystemFailure,
  removeProbeFails = false,
): { preload: string; trace: string } {
  const directory = temp("aidlc-t299-filesystem-mock-");
  const preload = join(directory, "project-filesystem.ts");
  const trace = join(directory, "filesystem.ndjson");
  writeFileSync(preload, `
    import { mock } from "bun:test";
    import { basename, resolve, sep } from "node:path";
    import { fileURLToPath } from "node:url";
    const actual = { ...await import("node:fs") };
    const children = { ...await import("node:child_process") };
    const root = actual.realpathSync(process.env.AIDLC_T299_PROJECT_DIR);
    const fault = ${JSON.stringify(failure ?? null)};
    const record = (event, fields = {}) => actual.appendFileSync(
      ${JSON.stringify(trace)}, JSON.stringify({ event, pid: process.pid, ...fields }) + "\\n",
    );
    const pathOf = (path) => resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    const inProject = (path) => {
      if (typeof path === "number") return false;
      const absolute = pathOf(path);
      return absolute === root || absolute.startsWith(root + sep);
    };
    const reject = (operation, fields, code) => {
      record("refused", { operation, ...fields, code });
      throw Object.assign(new Error("simulated project filesystem " + operation + " failure"), { code });
    };
    const observeMutation = (method, pathIndex = 0) => (...args) => {
      const path = args[pathIndex];
      if (inProject(path)) record(method, { path: pathOf(path) });
      return actual[method](...args);
    };
    record("preload", { args: process.argv.slice(1) });
    mock.module("node:fs", () => ({
      ...actual,
      chmodSync: observeMutation("chmodSync"),
      copyFileSync: observeMutation("copyFileSync", 1),
      cpSync: observeMutation("cpSync", 1),
      symlinkSync: observeMutation("symlinkSync", 1),
      unlinkSync: observeMutation("unlinkSync"),
      rmdirSync: observeMutation("rmdirSync"),
      linkSync(source, destination) {
        if (inProject(source) || inProject(destination)) {
          record("link", { source: pathOf(source), destination: pathOf(destination), code: "EMLINK" });
          throw Object.assign(new Error("simulated project hard-link failure"), { code: "EMLINK" });
        }
        return actual.linkSync(source, destination);
      },
      openSync(path, flags, ...rest) {
        if (inProject(path)) {
          const append = typeof flags === "string"
            ? flags.includes("a")
            : Boolean(flags & actual.constants.O_APPEND);
          const write = typeof flags === "string"
            ? /[wa+]/.test(flags)
            : Boolean(flags & (actual.constants.O_WRONLY | actual.constants.O_RDWR | actual.constants.O_CREAT));
          if (write) record("open", { path: pathOf(path), flags });
          if (fault?.operation === "append" && append && actual.existsSync(path)) {
            reject("append", { path: pathOf(path), flags }, fault.code);
          }
        }
        return actual.openSync(path, flags, ...rest);
      },
      renameSync(source, destination) {
        if (inProject(source) || inProject(destination)) {
          const fields = { source: pathOf(source), destination: pathOf(destination) };
          record("rename", fields);
          const directory = actual.lstatSync(source).isDirectory();
          if ((fault?.operation === "file-rename" && !directory) ||
              (fault?.operation === "directory-rename" && directory)) {
            reject(fault.operation, fields, fault.code);
          }
        }
        return actual.renameSync(source, destination);
      },
      mkdirSync(path, ...rest) {
        if (inProject(path)) record("mkdir", { path: pathOf(path) });
        return actual.mkdirSync(path, ...rest);
      },
      mkdtempSync(path, ...rest) {
        if (inProject(path)) record("mkdtemp", { path: pathOf(path) });
        return actual.mkdtempSync(path, ...rest);
      },
      writeFileSync(path, ...rest) {
        if (inProject(path)) record("write", { path: pathOf(path) });
        return actual.writeFileSync(path, ...rest);
      },
      appendFileSync(path, ...rest) {
        if (inProject(path)) {
          record("append", { path: pathOf(path) });
          if (fault?.operation === "append" && actual.existsSync(path)) {
            reject("append", { path: pathOf(path) }, fault.code);
          }
        }
        return actual.appendFileSync(path, ...rest);
      },
      rmSync(path, ...rest) {
        if (${JSON.stringify(removeProbeFails)} && String(path).includes(".aidlc-lock-probe-")) {
          throw Object.assign(new Error("simulated probe removal failure"), { code: "EACCES" });
        }
        if (inProject(path)) {
          record("remove", { path: pathOf(path) });
          if (basename(pathOf(path)) === ".aidlc-transaction.lock" &&
              actual.existsSync(path) && actual.lstatSync(path).isDirectory() &&
              actual.existsSync(resolve(String(path), "owner.json"))) {
            record("directory-lock", {
              path: pathOf(path),
              owner: JSON.parse(actual.readFileSync(resolve(String(path), "owner.json"), "utf-8")),
            });
          }
        }
        return actual.rmSync(path, ...rest);
      },
    }));
    // runConfigChild launches process.execPath without the parent's CLI flags.
    // Propagate the preload explicitly and prove each child loaded it below.
    mock.module("node:child_process", () => ({
      ...children,
      spawnSync(command, args, options) {
        if (command !== process.execPath || !Array.isArray(args)) {
          return children.spawnSync(command, args, options);
        }
        const forwarded = args.includes(${JSON.stringify(preload)})
          ? args : ["--preload", ${JSON.stringify(preload)}, ...args];
        const result = children.spawnSync(command, forwarded, options);
        record("spawn", { args, childPid: result.pid, status: result.status });
        return result;
      },
    }));
  `);
  return { preload, trace };
}

function filesystemTrace(trace: string): FilesystemTrace[] {
  return readFileSync(trace, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

type CliResult = { status: number; stdout: string; stderr: string; pid: number };
type CliContext = { project: string; env: NodeJS.ProcessEnv; preload?: string };

function runCli(context: CliContext, tool: string, args: string[], input = ""): CliResult {
  const result = spawnSync(BUN, [
    ...(context.preload ? ["--preload", context.preload] : []),
    tool,
    ...args,
    "--project-dir",
    context.project,
  ], {
    cwd: context.project,
    env: context.env,
    input,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    pid: result.pid,
  };
}

function runConfig(context: CliContext, args: string[]): CliResult {
  return runCli({
    ...context,
    env: { ...context.env, AIDLC_TEST_CONFIG_TTY: undefined },
  }, INIT, ["config", ...args]);
}

function runWizard(
  input: string,
  options: {
    harnesses?: Record<string, { found: boolean; version?: string }>;
    aidlc?: boolean;
    runtimeIssue?: boolean;
    env?: NodeJS.ProcessEnv;
    prepare?: (project: string) => void;
    // Rerun `config` in a project an earlier run already set up.
    project?: string;
    color?: boolean;
    preload?: string;
    // More `config` arguments, such as a `--harness ... --yes` setup.
    configArgs?: string[];
  } = {},
): CliContext & CliResult {
  const project = realpathSync(options.project ?? temp("aidlc-t299-project-"));
  const bin = temp("aidlc-t299-bin-");
  if (!options.project) mkdirSync(join(project, ".git"));
  executable(join(bin, "claude"), "claude 2.1.220");
  for (const [name, value] of Object.entries(options.harnesses ?? {})) {
    if (!value.found || name === "claude" || name === "kiro-ide") continue;
    executable(
      join(bin, name === "kiro" ? "kiro-cli" : name),
      value.version ?? `${name} 1.0.0`,
    );
  }
  executable(join(bin, "getconf"), bin);
  if (options.aidlc !== false) executable(join(bin, "aidlc"));
  options.prepare?.(project);
  const context: CliContext = {
    project,
    preload: options.preload,
    env: {
      ...hostEnv(),
      ...isolatedMachineEnv(),
      PATH: bin,
      NO_COLOR: "1",
      AIDLC_RUNTIME_ROOT: RUNTIME,
      AIDLC_TEST_CONFIG_TTY: "1",
      AIDLC_TEST_CONFIG_DETECTION_JSON: detection(
        bin,
        options.harnesses,
        options.runtimeIssue,
      ),
      ...options.env,
      AIDLC_T299_PROJECT_DIR: project,
    },
  };
  if (options.color) {
    delete context.env.NO_COLOR;
    context.env.FORCE_COLOR = "1";
  }
  return { ...context, ...runCli(context, INIT, ["config", ...(options.configArgs ?? [])], input) };
}

// Recommended first-run defaults keep the harness's current provider; the
// noninteractive path records Amazon Bedrock explicitly.
function expectConfiguredProject(
  project: string,
  mcp: "defaults" | "none",
  provider: "amazon-bedrock" | "current" = "amazon-bedrock",
): void {
  const settings = JSON.parse(readFileSync(join(project, "aidlc.settings.json"), "utf-8"));
  expect(settings).toEqual(expect.objectContaining({
    schemaVersion: 1,
    models: expect.objectContaining({ schemaVersion: 1, preset: "balanced" }),
  }));
  const data = join(project, ".claude", "tools", "data");
  const harness = JSON.parse(readFileSync(join(data, "harness.json"), "utf-8"));
  const nativeSettings = JSON.parse(
    readFileSync(join(project, ".claude", "settings.json"), "utf-8"),
  );
  if (provider === "current") {
    expect(harness.providers).toEqual(expect.objectContaining({ schemaVersion: 1, provider: "current" }));
    expect(nativeSettings.env?.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  } else {
    expect(harness.providers).toEqual(expect.objectContaining({
      schemaVersion: 1,
      provider: "amazon-bedrock",
      region: "us-east-2",
      pendingActions: expect.arrayContaining([
        expect.objectContaining({ id: "bedrock-model-access", status: "done" }),
      ]),
    }));
    expect(nativeSettings.env).toEqual(expect.objectContaining({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-2",
    }));
  }
  expect(readFileSync(join(project, ".claude", "agents", "aidlc-product-lead-agent.md"), "utf-8"))
    .toContain("effort: medium");
  const baseline = JSON.parse(readFileSync(join(data, "aidlc-manifest.json"), "utf-8"));
  expect(baseline).toEqual(expect.objectContaining({
    schemaVersion: 1,
    distribution: "claude",
    harnessDir: ".claude",
    mcpMode: mcp,
  }));
  // planManagedFiles excludes mutable harness data from baseline ownership;
  // its provider content is checked above. Other regenerated surfaces stay hashed.
  expect(Object.hasOwn(baseline.files, ".claude/tools/data/harness.json")).toBe(false);
  for (const path of [
    ".claude/settings.json",
    ".claude/tools/data/agent-tiers.json",
    ".claude/agents/aidlc-product-lead-agent.md",
  ]) {
    const hash = createHash("sha256").update(readFileSync(join(project, path))).digest("hex");
    expect(baseline.files[path], path).toBe(`sha256:${hash}`);
  }
  expect(readdirSync(project).filter((name) =>
    /^\.aidlc-(?:transaction\.lock|lock-|txn-|recovery-)/.test(name)
  )).toEqual([]);
}

function expectDirectoryTransaction(
  events: FilesystemTrace[],
  project: string,
  pid: number,
): void {
  const lock = join(project, ".aidlc-transaction.lock");
  expect(events).toContainEqual(expect.objectContaining({
    event: "link", pid, destination: lock, code: "EMLINK",
  }));
  expect(events).toContainEqual(expect.objectContaining({
    event: "directory-lock",
    pid,
    path: lock,
    owner: expect.objectContaining({
      schemaVersion: 1,
      pid,
      host: expect.any(String),
      token: expect.any(String),
    }),
  }));
}

function expectFilesystemRemediation(message: string, remediation: string, fault: FilesystemFailure): void {
  expect(message).toContain("Cannot use the filesystem at");
  expect(message).toContain(fault.diagnostic);
  expect(message).toContain(`(${fault.code})`);
  expect(remediation).toMatch(/mutable files/i);
  expect(remediation).toMatch(/rename/i);
  expect(remediation).toMatch(/local storage|ext4|XFS/i);
  expect(remediation).toMatch(/one host/i);
  expect(message + remediation).not.toContain("<valid-release-data>");
  expect(message + remediation).not.toContain("hard-link creation");
}

function expectInstalledWorkflowWrites(context: CliContext, trace: string): void {
  const run = (tool: string, args: string[]): CliResult => {
    const result = runCli({
      ...context,
      env: {
        ...context.env,
        AIDLC_TEST_CONFIG_TTY: undefined,
        AIDLC_HARNESS_DIR: ".claude",
        AIDLC_PROJECT_DIR: context.project,
      },
    }, join(context.project, ".claude", "tools", tool), args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(filesystemTrace(trace)).toContainEqual(expect.objectContaining({
      event: "preload", pid: result.pid,
    }));
    return result;
  };
  // These installed utilities execute locally; no agent or provider is called.
  const next = run("aidlc-orchestrate.ts", ["next", "--scope", "bugfix"]);
  const directive = JSON.parse(next.stdout);
  expect(directive.kind).toBe("print");
  expect(directive.message).toContain("intent create --scope bugfix");
  run("aidlc-utility.ts", [
    "intent-create", "--scope", "bugfix", "--depth", "minimal",
    "--label", "Filesystem regression", "--arguments", "Exercise mutable project storage",
  ]);
  const workspace = join(context.project, "aidlc");
  const space = readFileSync(join(workspace, "active-space"), "utf-8").trim();
  const intents = join(workspace, "spaces", space, "intents");
  const record = join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
  const statePath = join(record, "aidlc-state.md");
  expect(readFileSync(statePath, "utf-8")).toContain("- **Scope**: bugfix");
  expect(existsSync(join(workspace, "spaces", space, "knowledge"))).toBe(true);
  expect(run("aidlc-state.ts", ["get", "Depth"]).stdout.trim()).toBe("Minimal");

  const auditDir = join(record, "audit");
  const readAudit = (): string => readdirSync(auditDir).filter((name) => name.endsWith(".md"))
    .sort().map((name) => readFileSync(join(auditDir, name), "utf-8")).join("\n");
  const before = readAudit();
  expect(before).toContain("**Event**: WORKFLOW_STARTED");
  const changed = run("aidlc-utility.ts", ["config-change", "--depth", "comprehensive"]);
  expect(run("aidlc-state.ts", ["get", "Depth"]).stdout.trim()).toBe("Comprehensive");
  expect(readFileSync(statePath, "utf-8")).toContain("- **Depth**: Comprehensive");
  const after = readAudit();
  expect(after.length).toBeGreaterThan(before.length);
  expect(after).toContain("**Event**: DEPTH_CHANGED");
  expect(after).toContain("**New Depth**: Comprehensive");
  const events = filesystemTrace(trace).filter((event) => event.pid === changed.pid);
  expect(events.some((event) =>
    event.event === "rename" && event.destination === statePath
  )).toBe(true);
  expect(events.some((event) =>
    event.event === "open" && event.path && dirname(event.path) === auditDir
  )).toBe(true);
}

function wizardStderrMessage(stderr: string): string {
  try {
    const parsed = JSON.parse(stderr) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : stderr;
  } catch {
    return stderr;
  }
}

describe("t299 first-run setup wizard", () => {
  test("recommended defaults render detection, trichotomy, receipts, blocker, and next commands", () => {
    const machineEnv = isolatedMachineEnv();
    const result = runWizard("\n", {
      aidlc: false,
      runtimeIssue: true,
      env: machineEnv,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("AI-DLC setup - first run in this project.");
    expect(result.stdout).toContain("Claude Code detected  (2.1.220 on your PATH)");
    expect(result.stdout).toContain(
      "credentials found  (instance role, detected region us-east-2)",
    );
    expect(result.stdout).toContain("1. Yes, use recommended defaults");
    expect(result.stdout).toContain(
      "MCP servers on, all plugins, current model provider preserved",
    );
    expect(result.stdout).toContain("medium project agent effort for deciding");
    expect(result.stdout).not.toContain("effort dials do not apply");
    expect(result.stdout).toContain("Writing project files ... done");
    expect(result.stdout).toContain(
      "Recording model preset ... done  (aidlc.settings.json in this project)",
    );
    if (process.platform === "win32") {
      expect(result.stdout).toContain(
        `Add ${machineEnv.AIDLC_BIN_DIR} to your User PATH in Windows Settings, then open a new terminal.`,
      );
      expect(result.stdout).not.toContain('export PATH="$HOME/.local/bin:$PATH"');
    } else {
      expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');
      expect(result.stdout).not.toContain("to your User PATH in Windows Settings");
    }
    expect(result.stdout).toContain(
      "Full diagnostics: bun .claude/tools/aidlc.ts config runtime --show",
    );
    expect(result.stdout).toContain('/aidlc "what you want built"');
    expect(existsSync(join(result.project, ".claude"))).toBe(true);
    expect(JSON.parse(
      readFileSync(join(result.project, "aidlc.settings.json"), "utf-8"),
    ).models.preset).toBe("balanced");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("recommended defaults explain unsupported group effort on Kiro CLI", () => {
    const result = runWizard("\n", {
      harnesses: { kiro: { found: true, version: "kiro-cli 1.0.0" } },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("In Kiro CLI, effort dials do not apply");
    expect(result.stdout).not.toContain("medium project agent effort for deciding");
    expect(JSON.parse(
      readFileSync(join(result.project, "aidlc.settings.json"), "utf-8"),
    ).models.preset).toBe("balanced");
    expect(existsSync(join(result.project, ".kiro"))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("customize re-asks invalid preset and writes nothing when review declines", () => {
    const result = runWizard(
      "2\n\n\nthorogh\n2\n\n\n\nn\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Customize setup - 6 steps");
    expect(result.stdout).toContain("Kiro IDE        (not probed)");
    for (let step = 1; step <= 6; step++) {
      expect(result.stdout).toContain(`Step ${step} of 6`);
    }
    expect(result.stdout).toContain(
      "That's not one of the choices - enter 1, 2, ... or 4.",
    );
    expect(result.stdout).toContain("Using the thorough preset.");
    expect(result.stdout).toContain("Your choices - Enter to apply");
    expect(result.stdout).toContain("Nothing written.");
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("unchanged completes setup without recording model policy in any settings layer", () => {
    const env = isolatedMachineEnv();
    const result = runWizard("2\n\n\n4\n\n\n\n\n", { env });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Keeping existing settings unchanged; no preset recorded.");
    expect(result.stdout).toContain("3. Preset       none (unchanged)");
    expect(result.stdout).toContain("6. Preset in    n/a (no preset recorded)");
    expect(result.stdout).not.toContain("Preset in [");
    expect(result.stdout).not.toContain("Using the unchanged preset.");
    expect(result.stdout).not.toContain("Recording model preset");
    expect(result.stdout).toContain("Model preset ... left unchanged");
    expect(result.stdout).toContain("Setup complete.");
    expect(existsSync(join(result.project, ".claude", "settings.json"))).toBe(true);
    for (const path of [
      join(result.project, "aidlc.settings.json"),
      join(result.project, "aidlc.settings.local.json"),
      join(env.AIDLC_INSTALL_ROOT as string, "aidlc.settings.json"),
    ]) {
      const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
      expect(settings).not.toHaveProperty("models");
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("unchanged preserves pre-seeded project policy byte-for-byte", () => {
    const prior = `${JSON.stringify({
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        preset: "thorough",
        groups: { reviewing: { effort: "xhigh" } },
        agents: { architect: { model: { claude: "vendor/custom-model" }, effort: "high" } },
      },
    }, null, 4)}\n`;
    const env = isolatedMachineEnv();
    const result = runWizard("2\n\n\n4\n\n\n\n\n", {
      env,
      prepare: (project) => {
        writeFileSync(join(project, "aidlc.settings.json"), prior);
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Setup complete.");
    expect(readFileSync(join(result.project, "aidlc.settings.json"), "utf-8")).toBe(prior);
    for (const path of [
      join(result.project, "aidlc.settings.local.json"),
      join(env.AIDLC_INSTALL_ROOT as string, "aidlc.settings.json"),
    ]) {
      const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
      expect(settings).not.toHaveProperty("models");
    }
    expect(readFileSync(
      join(result.project, ".claude", "agents", "aidlc-product-lead-agent.md"),
      "utf-8",
    )).toContain("effort: xhigh");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("changing an unchanged preset re-opens the preset target step", () => {
    const result = runWizard(
      `${["2", "", "", "4", "", "", "3", "1", "2", ""].join("\n")}\n`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.match(/Step 6 of 6 - Where to record the model preset/g))
      .toHaveLength(2);
    expect(result.stdout.match(/Preset in \[1\]:/g)).toHaveLength(1);
    expect(result.stdout).toContain("6. Preset in    this project, just for you");
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
    expect(JSON.parse(
      readFileSync(join(result.project, "aidlc.settings.local.json"), "utf-8"),
    ).models.preset).toBe("balanced");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("review accepts a step number, re-enters it, then applies", () => {
    const result = runWizard(
      `${[
        "2",
        "",
        "",
        "",
        "",
        "",
        "",
        "3",
        "3",
        "",
      ].join("\n")}\n`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.match(/Step 3 of 6 - Model effort preset/g)).toHaveLength(2);
    expect(result.stdout).toContain("Using the minimal preset.");
    expect(JSON.parse(
      readFileSync(join(result.project, "aidlc.settings.json"), "utf-8"),
    ).models.preset).toBe("minimal");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Ctrl-C sentinel exits before apply with Nothing written", () => {
    const result = runWizard("\u0003\n");
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stdout).toContain("Nothing written.");
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
  });

  test("multiple detected CLIs use the seam-driven numbered harness picker first", () => {
    const result = runWizard("2\n\n", {
      harnesses: {
        claude: { found: true, version: "claude 2.1.220" },
        codex: { found: true, version: "codex-cli 0.145.0" },
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.indexOf("Choose the harness for this project first."))
      .toBeLessThan(result.stdout.indexOf("AI-DLC setup - first run"));
    expect(result.stdout).toContain("Using Codex CLI.");
    expect(existsSync(join(result.project, ".codex"))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Kiro IDE's terminal selects Kiro IDE and ends with trust, reload, and agent steps", () => {
    const result = runWizard("\n", {
      harnesses: { claude: { found: false } },
      env: { TERM_PROGRAM: "kiro" },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Choose the harness for this project first.");
    expect(result.stdout).toContain("Kiro IDE detected  (running in Kiro IDE's terminal)");
    expect(result.stdout).toContain([
      "  Setup complete. Start your first workflow:",
      "",
      "    1. Open this folder in Kiro IDE. If the Restricted Mode banner shows at the",
      "       top of the window and you know what is in this folder, select Manage on",
      "       it, then Trust.",
      '    2. Run "Developer: Reload Window" from the Command Palette',
      "       (Ctrl+Shift+P, or Cmd+Shift+P on macOS) so Kiro loads the AIDLC hooks",
      "       and the aidlc agent.",
      "    3. Choose the aidlc agent in the chat panel's agent picker.",
      '    4. /aidlc "what you want built"  describe your first intent',
      "",
      "    Using Kiro CLI instead? Start `kiro-cli` in this folder, then step 4.",
      "",
    ].join("\n"));
    expect(existsSync(join(result.project, ".kiro"))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Kiro IDE's terminal makes Kiro IDE the picker default when another CLI is found", () => {
    const result = runWizard("\n\n", {
      env: { TERM_PROGRAM: "kiro" },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Choose the harness for this project first.");
    expect(result.stdout).toContain("Using Kiro IDE.");
    expect(existsSync(join(result.project, ".kiro"))).toBe(true);
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Kiro IDE's terminal panel is often about 70 columns. On a terminal that
  // reports its width, a first-run row wraps between words and continues under
  // its own column; with no known width every row stays on one line.
  const kiroIdeTerminal = (env: NodeJS.ProcessEnv = {}) => ({
    harnesses: { claude: { found: false } },
    env: { TERM_PROGRAM: "kiro", ...env },
  });
  const underRecommended = (text: string) => `${" ".repeat(39)}${text}`;

  test("first-run menu keeps each row on one line when the terminal width is unknown", () => {
    const result = runWizard("3\n", kiroIdeTerminal());
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain([
      "    AWS        credentials found  (instance role, detected region us-east-2)",
      "    Runtime    ready",
      "",
      "  Set up AI-DLC for Kiro IDE with recommended defaults?",
      "",
      "    1. Yes, use recommended defaults   all plugins, no provider settings; model access comes with Kiro IDE",
      underRecommended("Records balanced (default)."),
      underRecommended("In Kiro IDE, effort dials do not apply, so agents keep your session's effort."),
      "    2. No, customize step by step      harness, provider, preset, plugins, MCP, record layer",
      "    3. Exit, nothing written",
      "",
    ].join("\n"));
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("first-run menu wraps under its own column in a 70-column terminal", () => {
    const result = runWizard("3\n", kiroIdeTerminal({ AIDLC_TEST_CONFIG_COLUMNS: "70" }));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain([
      "    AWS        credentials found  (instance role, detected region",
      "               us-east-2)",
      "    Runtime    ready",
      "",
      "  Set up AI-DLC for Kiro IDE with recommended defaults?",
      "",
      "    1. Yes, use recommended defaults   all plugins, no provider",
      underRecommended("settings; model access comes"),
      underRecommended("with Kiro IDE"),
      underRecommended("Records balanced (default)."),
      underRecommended("In Kiro IDE, effort dials do"),
      underRecommended("not apply, so agents keep your"),
      underRecommended("session's effort."),
      "    2. No, customize step by step      harness, provider, preset,",
      underRecommended("plugins, MCP, record layer"),
      "    3. Exit, nothing written",
      "",
    ].join("\n"));
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Every step of the customize walk, declined at the review so nothing is
  // written: at 70 columns no line reaches the last column, and the wrapped
  // output says exactly what the one-line output says.
  for (
    const [name, input, options] of [
      ["Kiro IDE", ["2", "", "", "", "", "", "n"], kiroIdeTerminal()],
      ["Claude Code with Bedrock", ["2", "", "2", "", "my-team-profile", "", "", "", "", "n"], {}],
      ["Codex CLI keeping its provider", ["2", "", "", "", "", "", "", "n"], {
        harnesses: { codex: { found: true, version: "codex-cli 0.145.0" } },
      }],
      ["opencode with Bedrock", ["2", "", "2", "", "", "y", "", "", "", "", "n"], {
        harnesses: { opencode: { found: true, version: "opencode 1.17.0" } },
      }],
    ] as const
  ) {
    test(`${name} setup steps fit a 70-column terminal`, () => {
      const answers = `${input.join("\n")}\n`;
      const wide = runWizard(answers, options);
      const narrow = runWizard(answers, {
        ...options,
        env: { ...("env" in options ? options.env : {}), AIDLC_TEST_CONFIG_COLUMNS: "70" },
      });
      expect(narrow.status, narrow.stdout + narrow.stderr).toBe(0);
      expect(narrow.stdout).toContain("Nothing written.");
      // The scripted answers are not echoed, so a prompt and the next output
      // share a line here; on a real terminal the Enter ends the prompt line.
      const lines = narrow.stdout.split(/\n|(?<=\]:) /);
      expect(lines.filter((line) => line.length > 69)).toEqual([]);
      expect(wide.stdout.split("\n").some((line) => line.length > 69)).toBe(true);
      expect(narrow.stdout.split(/\s+/)).toEqual(wide.stdout.split(/\s+/));
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // The setup-complete screen, the setup-check list a rerun shows in a set up
  // project, and the `config --harness kiro-ide --yes` path (its completion
  // line and the section wizards the walk launches) wrap the same way. Kiro
  // IDE's terminal is 79 columns by default and 62 with its tab list open.
  // Expectations come from what was rendered with no known width and from the
  // shipped harness data, so a wording change fails only the pins that name it.
  const setupMachineRoot = temp("aidlc-t299-setup-machine-");
  const setupMachine = {
    AIDLC_INSTALL_ROOT: join(setupMachineRoot, "share", "aidlc"),
    AIDLC_BIN_DIR: join(setupMachineRoot, "bin"),
  };
  const kiroIdeProjection = (): {
    productName: string;
    configNextStep: string;
    firstRunSteps: string[];
  } => JSON.parse(readFileSync(
    join(RUNTIME, "kiro-ide", ".kiro", "tools", "data", "aidlc-projection.json"),
    "utf-8",
  ));
  const kiroIdeSteps = () => kiroIdeProjection().firstRunSteps;
  let installed: { unchanged: string; shell: string } | undefined;
  const installedProjects = () => {
    if (!installed) {
      // No preset recorded, so the rerun's Models row needs you and the walk asks.
      const unchanged = runWizard("2\n\n4\n\n\n\n", kiroIdeTerminal(setupMachine));
      const shell = runWizard("\n", kiroIdeTerminal(setupMachine));
      expect(unchanged.status, unchanged.stdout + unchanged.stderr).toBe(0);
      expect(shell.status, shell.stdout + shell.stderr).toBe(0);
      // A missing workspace shell adds its notice and the rebuild command.
      rmSync(join(shell.project, "aidlc", "spaces", "default", "memory"), {
        recursive: true,
        force: true,
      });
      installed = { unchanged: unchanged.project, shell: shell.project };
    }
    return installed;
  };
  // `config --harness kiro-ide --yes`, then the walk: Fix the sections? yes,
  // record in the project, and the models wizard's preset, group, or
  // per-agent branch. Answers come through the scripted seam, not stdin.
  const harnessWalks = {
    preset: ["", "", "1", "balanced"],
    groups: ["", "", "2", "", "", ""],
    agents: ["", "", "3", ...Array(14).fill("")],
  } as const;
  const harnessPath = (answers: readonly string[], env: NodeJS.ProcessEnv, project?: string) =>
    runWizard("", {
      ...kiroIdeTerminal({ ...setupMachine, ...env, AIDLC_TEST_CONFIG_INPUT: `${answers.join("\n")}\n` }),
      aidlc: false,
      configArgs: ["--from", join(RUNTIME, "kiro-ide"), "--harness", "kiro-ide", "--mcp", "none", "--yes"],
      ...(project ? { project } : {}),
    });
  const setupScreens = (env: NodeJS.ProcessEnv = {}) => {
    const projects = installedProjects();
    // aidlc stays off the hook PATH, so the PATH fix shows and the Runtime row
    // names no per-run directory.
    const options = { ...kiroIdeTerminal({ ...setupMachine, ...env }), aidlc: false };
    return {
      complete: runWizard("\n", options),
      check: runWizard("n\n", { ...options, project: projects.unchanged }),
      shell: runWizard("\n", { ...options, project: projects.shell }),
      ...Object.fromEntries(Object.entries(harnessWalks).map(([name, answers]) => [
        `harness-${name}`,
        harnessPath(answers, env),
      ])) as Record<`harness-${keyof typeof harnessWalks}`, ReturnType<typeof runWizard>>,
    };
  };
  let unknownWidth: ReturnType<typeof setupScreens> | undefined;
  const wideScreens = () => {
    unknownWidth ??= setupScreens();
    return unknownWidth;
  };
  // Scripted answers are not echoed, so a prompt shares a line with the output
  // after it here; on a real terminal the Enter ends that line.
  const screenLines = (stdout: string) => stdout.split(/\n|(?<=\]:) /);
  // What the person is told to run or paste, as rendered with no known width:
  // the ledger's commands, labelled commands, the export line, and quoted spans
  // that hold a space.
  const commandsIn = (stdout: string): string[] => {
    const commands = new Set<string>();
    let ledger = false;
    for (const line of screenLines(stdout)) {
      if (/still needs? you$/.test(line)) {
        ledger = true;
        continue;
      }
      const row = ledger ? /^ {4}\S+ +(\S.*)$/.exec(line) : null;
      if (row) commands.add(row[1]);
      else ledger = false;
      const labelled = /(?:Full diagnostics|Full per-agent list): (\S.*)$/.exec(line) ??
        /fix: ((?:aidlc|bun) \S.*)$/.exec(line);
      if (labelled) commands.add(labelled[1]);
      if (/^\s+export PATH=/.test(line)) commands.add(line.trim());
      for (const [span] of line.matchAll(/`[^`]*`|(?<!\S)'[^'\s][^']*'|(?<!\S)"[^"\s][^"]*"/g)) {
        if (span.includes(" ")) commands.add(span);
      }
    }
    return [...commands];
  };
  // Two runs of one screen differ only in their temporary directories' random
  // suffixes, which keep their length here so columns do not move.
  const sameRun = (run: { stdout: string }) =>
    run.stdout.replace(/(aidlc-t299-(?:[a-z]+-)+)[A-Za-z0-9]{6}/g, "$1XXXXXX");
  // Past the last free column only a whole command or a single word too long
  // for any line (a long path), which cannot wrap without breaking it.
  const tooWide = (lines: readonly string[], width: number, commands: readonly string[] = []) =>
    lines.filter((line) =>
      Bun.stringWidth(line) > width - 1 &&
      !/^\s*\S+$/.test(line) &&
      !commands.includes(line.trim())
    );
  // Each word's line and start column.
  const wordPositions = (lines: readonly string[]) =>
    lines.flatMap((line, index) =>
      [...line.matchAll(/\S+/g)].map((match, order) => ({
        line: index,
        column: Bun.stringWidth(line.slice(0, match.index)),
        first: order === 0,
      }))
    );
  // A narrow rendering against the same screen with no known width: the same
  // words; a row's first line starts where it did; and a line that continues a
  // row starts under one of that row's words (not at its left edge), or two
  // columns in when the row itself starts at the left edge.
  const misplacedContinuations = (narrow: string, wide: string, commands: readonly string[]) => {
    const narrowLines = screenLines(narrow);
    const wideLines = screenLines(wide);
    const narrowWords = wordPositions(narrowLines);
    const wideWords = wordPositions(wideLines);
    expect(narrowWords.length).toBe(wideWords.length);
    const misplaced: string[] = [];
    narrowWords.forEach((word, index) => {
      if (!word.first) return;
      const source = wideWords[index];
      const text = narrowLines[word.line];
      if (source.first) {
        if (word.column !== source.column) misplaced.push(text);
        return;
      }
      const starts = wideWords.filter((other) => other.line === source.line)
        .map((other) => other.column);
      const allowed = starts[0] === 0 ? [2] : starts;
      if (!allowed.includes(word.column) && !commands.includes(text.trim())) {
        misplaced.push(text);
      }
    });
    return misplaced;
  };
  // What every narrow screen meets against its render with no known width:
  // nothing too wide, the same words, continuations under their row's text,
  // every command whole on one line for copy and paste, and something that
  // did need wrapping.
  const expectWrappedLike = (
    narrow: { stdout: string },
    wide: { stdout: string },
    width: number,
    label: string,
  ) => {
    const commands = commandsIn(sameRun(wide));
    const lines = screenLines(narrow.stdout);
    expect(tooWide(lines, width, commands), label).toEqual([]);
    expect(sameRun(narrow).split(/\s+/), label).toEqual(sameRun(wide).split(/\s+/));
    expect(misplacedContinuations(sameRun(narrow), sameRun(wide), commands), label).toEqual([]);
    for (const command of commands) {
      expect(lines.some((line) => line.includes(command)), `${label}: ${command}`).toBe(true);
    }
    expect(tooWide(screenLines(wide.stdout), width).length, label).toBeGreaterThan(0);
  };

  test("setup-complete screen, setup-check list, and --harness walk keep each row on one line when the terminal width is unknown", () => {
    const { complete, check, shell, ...walks } = wideScreens();
    for (const run of [complete, check, shell, ...Object.values(walks)]) {
      expect(run.status, run.stdout + run.stderr).toBe(0);
    }
    expect(complete.stdout).toMatch(
      /\n {2}Writing project files \.\.\. done {2}\(\.kiro\/ and aidlc\/, \d+ files\)\n {2}Recording model preset \.\.\. done {2}\(aidlc\.settings\.json in this project\)\n/,
    );
    expect(complete.stdout).toContain([
      "    Hooks run outside your interactive shell PATH, and aidlc is not available there.",
      ...firstRunPathRemediation(process.platform, setupMachine.AIDLC_BIN_DIR)
        .map((line) => `    ${line}`),
      "",
      "    Full diagnostics: bun .kiro/tools/aidlc.ts config runtime --show",
      "",
      "  Setup complete. Start your first workflow:",
      "",
      ...kiroIdeSteps().map((line) => line ? `    ${line}` : ""),
      "",
    ].join("\n"));
    expect(check.stdout).toContain(
      "\n  Found kiro-ide in .kiro/; using the existing copied projection.\n",
    );
    expect(check.stdout).toContain([
      "    [ok]     Harnesses   kiro-ide recorded",
      "    [needs]  Models      no recorded policy; agents inherit your session model and effort",
    ].join("\n"));
    expect(check.stdout).toContain([
      "    [ok]     Flags       defaults",
      "    [ok]     Project     plugins: all installed, MCP: none, completions: none",
      "    [ok]     Providers   model access comes with Kiro IDE; nothing for AI-DLC to configure",
      "    [ok]     Trust       no unmet host trust",
      "    [ok]     Workspace   workspace shell present",
      "",
    ].join("\n"));
    expect(check.stdout).toContain("    models       bun .kiro/tools/aidlc.ts config models\n");
    expect(shell.stdout).toContain(
      "\n  The workspace shell is incomplete, so no section is walked until it is rebuilt; run the workspace command first.\n",
    );
    expect(shell.stdout).toContain(
      "    workspace    bun .kiro/tools/aidlc.ts config --harness kiro-ide --download\n",
    );
    const walk = walks["harness-preset"].stdout;
    // The completion line stays one line, as scripts and tests read it.
    const { productName, configNextStep } = kiroIdeProjection();
    expect(walk.split("\n")[0]).toBe(
      `configured ${walks["harness-preset"].project} for ${productName} ${AIDLC_VERSION}; next: ${configNextStep}`,
    );
    expect(walk).toContain([
      "Recorded in: nothing yet - run 'bun .kiro/tools/aidlc.ts config models --preset balanced --project --yes'",
      "Full per-agent list: bun .kiro/tools/aidlc.ts config models --show --json",
      "Pins bind in both directions, and shipped tiers never raise an agent above the session.",
      "Models [Enter keep everything, 1 preset, 2 group efforts, 3 set each one myself]: Presets:",
    ].join("\n"));
    expect(walk).toContain("\n  Full diagnostics: bun .kiro/tools/aidlc.ts config runtime --show\n");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const width of [62, 79]) {
    test(`setup-complete screen, setup-check list, and --harness walk fit a ${width}-column terminal`, () => {
      const wide = wideScreens();
      const narrow = setupScreens({ AIDLC_TEST_CONFIG_COLUMNS: String(width) });
      for (const screen of Object.keys(wide) as (keyof typeof wide)[]) {
        const { stdout, status, stderr } = narrow[screen];
        expect(status, `${screen}: ${stdout}${stderr}`).toBe(0);
        expectWrappedLike(narrow[screen], wide[screen], width, screen);
        // Setup-check rows continue under their detail, receipts under their
        // opening parenthesis, and numbered steps under the step text.
        const lines = screenLines(stdout);
        const wideLines = screenLines(wide[screen].stdout);
        for (const [index, line] of lines.entries()) {
          const head = /^ {4}\[(?:ok|needs)\] +\S+ +|^ {2}(?:Writing project files|Recording model preset) \.\.\. done {2}|^ {4}\d+\. (?:\S(?:.*\S)? {2,}(?=\S))?/.exec(line);
          const next = lines[index + 1] ?? "";
          if (!head || !wideLines.every((wideLine) => wideLine !== line)) continue;
          if (!/^ +\S/.test(next) || /^ {4}(?:\[|\d+\. )/.test(next)) continue;
          expect(/^ */.exec(next)?.[0].length, `${screen}: ${line} / ${next}`).toBe(head[0].length);
        }
      }
      // The numbered steps as shipped, each continuing under its own text.
      const steps = kiroIdeSteps().filter((line) => /^\d+\. /.test(line));
      for (const step of steps) {
        expect(narrow.complete.stdout).toContain(`\n    ${step.slice(0, 3)}`);
      }
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("a colored setup-check row wraps by the columns the terminal shows", () => {
    const { unchanged } = installedProjects();
    const options = {
      ...kiroIdeTerminal({ ...setupMachine, AIDLC_TEST_CONFIG_COLUMNS: "62" }),
      aidlc: false,
    };
    const plain = runWizard("n\n", { ...options, project: unchanged });
    const colored = runWizard("n\n", { ...options, project: unchanged, color: true });
    expect(colored.status, colored.stdout + colored.stderr).toBe(0);
    expect(colored.stdout).toContain("\u001b[33m[needs]\u001b[0m  Models      no recorded policy; agents inherit\n");
    expect(colored.stdout.replaceAll("\u001b[33m", "").replaceAll("\u001b[0m", ""))
      .toBe(plain.stdout);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a wide-character project path wraps by the columns the terminal shows", () => {
    // Twelve East Asian wide characters, two columns each. At this width the
    // completion line's first line fits only if they are counted as one each.
    const project = join(temp("aidlc-t299-cjk-"), "\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u8a2d\u5b9a\u30d5\u30a9\u30eb\u30c0");
    mkdirSync(join(project, ".git"), { recursive: true });
    const width = project.length + 17;
    const result = harnessPath(["n"], { AIDLC_TEST_CONFIG_COLUMNS: String(width) }, project);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(project);
    expect(tooWide(screenLines(result.stdout), width, commandsIn(result.stdout))).toEqual([]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // First-run setup stops in plain words: before any question when the
  // project's storage lacks an operation transactions need (a hard-link
  // rejection alone now falls back to a directory lock), and after apply when a
  // step fails, here on a settings file the user owns. The stop and its fix
  // wrap the same way; a fix that is a command stays whole.
  const firstRunStops = (env: NodeJS.ProcessEnv = {}) => ({
    lock: runWizard("", { preload: filesystemPreload(REQUIRED_FILESYSTEM_FAILURES[0]).preload, env }),
    conflict: runWizard("\n", {
      env,
      prepare: (project) => {
        mkdirSync(join(project, ".claude"));
        writeFileSync(join(project, ".claude", "settings.json"), '{"userOwned":true}\n');
      },
    }),
  });
  let unknownWidthStops: ReturnType<typeof firstRunStops> | undefined;
  const wideStops = () => {
    unknownWidthStops ??= firstRunStops();
    return unknownWidthStops;
  };

  test("a first-run stop keeps its stop and fix on one line each when the terminal width is unknown", () => {
    const { lock, conflict } = wideStops();
    expect(lock.status, lock.stdout + lock.stderr).toBe(1);
    expect(conflict.status, conflict.stdout + conflict.stderr).toBe(1);
    expect(lock.stdout).toMatch(
      /\n {2}Setup stopped: Cannot use the filesystem at \S.*: file replacement by rename failed \(ENOTSUP\)\.\n/,
    );
    expect(lock.stdout).toContain(
      `\n  fix: ${new TransactionFilesystemError("", "", "", null).remediation}\n  Nothing written.\n`,
    );
    expect(conflict.stdout).toMatch(/\n {2}fix: (?:aidlc|bun) \S.* --dry-run --verbose\n {2}No setup changes were kept\.\n/);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const width of [62, 79]) {
    test(`a first-run stop wraps under its own text in a ${width}-column terminal`, () => {
      const wide = wideStops();
      const narrow = firstRunStops({ AIDLC_TEST_CONFIG_COLUMNS: String(width) });
      for (const stop of ["lock", "conflict"] as const) {
        expect(narrow[stop].status, `${stop}: ${narrow[stop].stdout}${narrow[stop].stderr}`).toBe(1);
        expectWrappedLike(narrow[stop], wide[stop], width, stop);
      }
      // The conflict's fix is the dry-run command, checked whole above.
      expect(commandsIn(sameRun(wide.conflict)).some((command) =>
        command.endsWith("--dry-run --verbose")
      )).toBe(true);
      // The storage fix continues under its own text, after "fix: ".
      const fixLines = screenLines(narrow.lock.stdout);
      const fix = fixLines.findIndex((line) => line.startsWith("  fix: "));
      expect(fix).toBeGreaterThan(0);
      expect(fixLines[fix + 1]).toMatch(/^ {7}\S/);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // Harness detection must not change the default outside Kiro IDE: a plain
  // terminal, VS Code, Cursor, and iTerm keep the first detected CLI.
  for (
    const [terminal, env] of [
      ["a plain terminal", {}],
      [
        "VS Code's terminal",
        {
          TERM_PROGRAM: "vscode",
          VSCODE_GIT_ASKPASS_NODE: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
        },
      ],
      [
        "Cursor's terminal",
        {
          TERM_PROGRAM: "vscode",
          VSCODE_GIT_ASKPASS_NODE: "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe",
        },
      ],
      ["iTerm", { TERM_PROGRAM: "iTerm.app", __CFBundleIdentifier: "com.googlecode.iterm2" }],
    ] as const
  ) {
    test(`${terminal} keeps the first detected CLI as the picker default`, () => {
      const result = runWizard("\n\n", {
        harnesses: {
          claude: { found: true, version: "claude 2.1.220" },
          codex: { found: true, version: "codex-cli 0.145.0" },
        },
        env,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Using Claude Code.");
      expect(result.stdout).not.toContain("Kiro IDE detected");
      expect(existsSync(join(result.project, ".claude"))).toBe(true);
      expect(existsSync(join(result.project, ".kiro"))).toBe(false);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // Kiro IDE's first-run steps live in its own manifest; every other harness
  // keeps the open-then-/aidlc pair.
  for (
    const [harness, open] of [
      ["claude", "claude                         open Claude Code in this repo"],
      ["codex", "codex                         open Codex CLI in this repo"],
      ["copilot", "copilot                        open Copilot CLI in this repo"],
      ["cursor", "cursor                         open Cursor in this repo"],
      ["kiro", "kiro-cli chat                  open Kiro CLI in this repo"],
      ["opencode", "opencode                       open opencode in this repo"],
    ] as const
  ) {
    test(`${harness} setup ends with its own next steps and no Kiro IDE advice`, () => {
      const result = runWizard("\n", {
        harnesses: {
          claude: { found: harness === "claude" },
          [harness]: { found: true },
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const invoke = harness === "codex" ? "$aidlc" : "/aidlc";
      expect(result.stdout).toContain(
        "  Setup complete. Start your first workflow:\n\n" +
          `    ${open}\n` +
          `    ${invoke} "what you want built"  describe your first intent\n`,
      );
      for (const kiroIdeWord of ["Reload Window", "Restricted Mode", "agent picker", "Kiro IDE"]) {
        expect(result.stdout).not.toContain(kiroIdeWord);
      }
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("OpenCode recommended setup preserves the current provider", () => {
    const result = runWizard("\n", {
      harnesses: {
        claude: { found: false },
        opencode: { found: true, version: "opencode 1.17.0" },
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const harness = JSON.parse(
      readFileSync(
        join(result.project, ".aidlc", "tools", "data", "harness.json"),
        "utf-8",
      ),
    );
    expect(harness.providers).toEqual(expect.objectContaining({
      provider: "current",
    }));
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a preexisting settings conflict renders the child's message and fix without its JSON plan", () => {
    let before: Record<string, string> = {};
    const result = runWizard("\n", {
      prepare: (project) => {
        mkdirSync(join(project, ".claude"));
        writeFileSync(join(project, ".claude", "settings.json"), '{"userOwned":true}\n');
        writeFileSync(join(project, ".gitignore"), "# keep my ignores\nnode_modules/\n");
        before = treeSnapshot(project);
      },
    });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(1);
    expect(output).toContain("Setup stopped:");
    expect(output).toContain("config conflict(s)");
    expect(output).toContain(".claude/settings.json");
    expect(output).toContain("locally modified or unowned");
    expect(output).toMatch(/fix:/i);
    expect(output).toContain("--dry-run --verbose");
    expect(output).not.toContain('"schemaVersion"');
    expect(output).not.toContain('"actions"');
    expect(treeSnapshot(result.project)).toEqual(before);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("recommended first-run and installed workflow writes succeed with project hardlinks refused in every config child", () => {
    const { preload, trace } = filesystemPreload();
    const result = runWizard("\n", { preload });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(0);
    expect(output).toContain("Writing project files ... done");
    expect(output).toContain("Recording model preset ... done");
    expect(output).toContain("Setup complete. Start your first workflow:");
    expect(output).not.toContain("Setup stopped:");
    expectConfiguredProject(result.project, "defaults", "current");

    const events = filesystemTrace(trace);
    const probeLinks = events.filter((event) => event.event === "link" && event.pid === result.pid);
    expect(probeLinks.length).toBeGreaterThan(0);
    for (const link of probeLinks) {
      expect(basename(dirname(link.destination!))).toMatch(/^\.aidlc-lock-probe-/);
    }
    const children = events.filter((event) =>
      event.event === "spawn" && event.pid === result.pid && event.args?.includes("config")
    );
    // Scaffold, models, project choices, and provider setup all mutate through
    // separate Bun processes. A parent-only preload cannot satisfy this check.
    expect(children.map((child) => {
      const args = child.args!;
      const section = args[args.indexOf("config") + 1];
      return section.startsWith("--") ? "config" : section;
    })).toEqual(["config", "models", "project", "providers"]);
    for (const child of children) {
      expect(child.status).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({
        event: "preload", pid: child.childPid,
      }));
      expectDirectoryTransaction(events, result.project, child.childPid!);
    }
    expectInstalledWorkflowWrites(result, trace);
  }, 120_000);

  test("noninteractive JSON apply and refresh keep settings, models, providers, and baseline valid without hardlinks", () => {
    const { preload, trace } = filesystemPreload();
    const result = runWizard("", {
      preload,
      configArgs: [
        "--from", join(RUNTIME, "claude"),
        "--harness", "claude",
        "--mcp", "none",
        "--yes", "--json",
      ],
      env: {
        AIDLC_TEST_CONFIG_TTY: undefined,
        // The providers --check command performs offline credential detection.
        // Synthetic values satisfy that check without reading host credentials.
        AWS_ACCESS_KEY_ID: "aidlc-t299-offline-access",
        AWS_SECRET_ACCESS_KEY: "aidlc-t299-offline-secret",
      },
    });
    const expectApplied = (applied: CliResult): void => {
      expect(applied.status, applied.stdout + applied.stderr).toBe(0);
      const payload = JSON.parse(applied.stdout);
      expect(payload.ok).toBe(true);
      expect(payload.code).toBe(0);
      expect(payload.data.distribution).toBe("claude");
      expect(payload.data.counts.conflict).toBe(0);
      expectDirectoryTransaction(filesystemTrace(trace), result.project, applied.pid);
    };
    expectApplied(result);
    expectApplied(runConfig(result, [
      "models", "--project", "--preset", "balanced", "--yes", "--json",
    ]));
    expectApplied(runConfig(result, [
      "providers", "--provider", "amazon-bedrock", "--region", "us-east-2",
      "--mark-done", "bedrock-model-access", "--yes", "--json",
    ]));
    expectConfiguredProject(result.project, "none");
    const settingsBefore = readFileSync(join(result.project, "aidlc.settings.json"), "utf-8");
    const userFile = join(result.project, ".claude", "user-notes.txt");
    writeFileSync(userFile, "keep this unowned file\n");

    expectApplied(runConfig(result, ["--yes", "--json"]));
    expectConfiguredProject(result.project, "none");
    expect(readFileSync(join(result.project, "aidlc.settings.json"), "utf-8")).toBe(settingsBefore);
    expect(readFileSync(userFile, "utf-8")).toBe("keep this unowned file\n");
    for (const section of ["models", "providers"]) {
      const checked = runConfig(result, [section, "--check", "--json"]);
      expect(checked.status, checked.stdout + checked.stderr).toBe(0);
      expect(JSON.parse(checked.stdout).ok).toBe(true);
    }
  }, 120_000);

  test("a probe the check cannot remove keeps the storage fix and is not called nothing written", () => {
    const [fault] = REQUIRED_FILESYSTEM_FAILURES;
    const { preload } = filesystemPreload(fault, true);
    const result = runWizard("", { preload });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(1);
    expect(output).toContain("Setup stopped:");
    expect(output).toContain(`${fault.diagnostic} failed (${fault.code})`);
    expect(output).toContain("Could not remove temporary transaction lock probe");
    expect(output).toMatch(/fix:/i);
    expect(output).toContain("Nothing else was written.");
    expect(output).not.toContain("  Nothing written.");
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const fault of REQUIRED_FILESYSTEM_FAILURES) {
    for (const [label, harnesses] of [
      ["one detected CLI", { claude: { found: true } }],
      ["multiple detected CLIs", { claude: { found: true }, codex: { found: true } }],
      ["no detected CLI", { claude: { found: false } }],
    ] as const) {
      test(`${fault.operation} rejection stops the wizard before selection with ${label}`, () => {
        const { preload, trace } = filesystemPreload(fault);
        let before: Record<string, string> = {};
        // Empty stdin cannot answer either the harness picker or the setup gate.
        const result = runWizard("", {
          preload,
          harnesses,
          prepare: (project) => {
            writeFileSync(join(project, "README.md"), "existing project\n");
            writeFileSync(join(project, ".gitignore"), "# user-owned\n");
            before = treeSnapshot(project);
          },
        });
        const output = result.stdout + result.stderr;
        expect(result.status, output).toBe(1);
        expect(output).toContain("Setup stopped:");
        expectFilesystemRemediation(output, output, fault);
        expect(output).toMatch(/fix:/i);
        expect(output).toContain("Nothing written.");
        expect(output).not.toContain("Choose the harness for this project first.");
        expect(output).not.toContain("Choose one to configure:");
        expect(output).not.toContain("Set up AI-DLC for");
        expect(output).not.toContain("Customize setup");
        expect(output).not.toContain('"schemaVersion"');
        expect(output).not.toContain('"actions"');
        expect(output.trim().split("\n").length).toBeLessThanOrEqual(4);
        const events = filesystemTrace(trace);
        expect(events).toContainEqual(expect.objectContaining({
          event: "refused", code: fault.code,
        }));
        const links = events.filter((event) => event.event === "link");
        expect(links).toHaveLength(1);
        expect(basename(dirname(links[0].source!))).toMatch(/^\.aidlc-lock-probe-/);
        expect(dirname(links[0].source!)).toBe(dirname(links[0].destination!));
        expect(links[0].destination).not.toBe(join(result.project, ".aidlc-transaction.lock"));
        expect(events.some((event) => event.event === "spawn")).toBe(false);
        expect(treeSnapshot(result.project)).toEqual(before);
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }

    for (const mode of ["json", "quiet", "human"] as const) {
      test(`noninteractive ${mode} config preserves ${fault.operation} remediation without persistent writes`, () => {
        const { preload, trace } = filesystemPreload(fault);
        let before: Record<string, string> = {};
        const result = runWizard("", {
          preload,
          configArgs: [
            "--from", join(RUNTIME, "claude"),
            "--harness", "claude",
            "--mcp", "none",
            "--yes",
            ...(mode === "human" ? [] : [`--${mode}`]),
          ],
          env: { AIDLC_TEST_CONFIG_TTY: undefined },
          prepare: (project) => {
            writeFileSync(join(project, "README.md"), "existing project\n");
            writeFileSync(join(project, ".gitignore"), "# user-owned\n");
            before = treeSnapshot(project);
          },
        });
        const output = result.stdout + result.stderr;
        expect(result.status, output).toBeGreaterThan(0);
        expect(output).not.toContain("<valid-release-data>");
        if (mode === "json") {
          const error = JSON.parse(result.stdout);
          expect(error.ok).toBe(false);
          expect(error.code).toBe(result.status);
          expectFilesystemRemediation(error.message, error.remediation, fault);
          expect(error).not.toHaveProperty("data");
          expect(result.stderr).toBe("");
        } else {
          expect(output).toMatch(/mutable files/i);
          expect(output).toMatch(/local storage|ext4|XFS/i);
          expect(output).not.toContain('"schemaVersion"');
          expect(output).not.toContain('"actions"');
          expect(output.trim().split("\n").length).toBeLessThanOrEqual(3);
          if (mode === "human") {
            expectFilesystemRemediation(output, output, fault);
            expect(output).toMatch(/fix:/i);
          }
        }
        const events = filesystemTrace(trace);
        expect(events).toContainEqual(expect.objectContaining({
          event: "refused", code: fault.code,
        }));
        expectDirectoryTransaction(events, result.project, result.pid);
        expect(treeSnapshot(result.project)).toEqual(before);
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }
  }

  for (const fault of [undefined, ...REQUIRED_FILESYSTEM_FAILURES]) {
    for (const mode of ["human", "json"] as const) {
      test(`${mode} dry-run does not probe or write with ${fault?.operation ?? "hardlinks"} refused`, () => {
        const { preload, trace } = filesystemPreload(fault);
        let before: Record<string, string> = {};
        const result = runWizard("", {
          preload,
          configArgs: [
            "--from", join(RUNTIME, "claude"), "--harness", "claude",
            "--mcp", "none", "--dry-run", ...(mode === "json" ? ["--json"] : []),
          ],
          prepare: (project) => {
            writeFileSync(join(project, "README.md"), "existing project\n");
            writeFileSync(join(project, ".gitignore"), "# user-owned\n");
            before = treeSnapshot(project);
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("config plan for");
        expect(result.stdout).not.toContain("Set up AI-DLC for");
        if (mode === "json") {
          const payload = JSON.parse(result.stdout);
          expect(payload.ok).toBe(true);
          expect(payload.data.counts.create).toBeGreaterThan(0);
          expect(payload.data.planToken).toMatch(/^sha256:[0-9a-f]{64}$/);
        }
        // A trace containing only startup proves the mock was loaded without
        // ever calling a project mutation, including a disposable probe.
        expect(filesystemTrace(trace)).toEqual([
          expect.objectContaining({ event: "preload", pid: result.pid }),
        ]);
        expect(treeSnapshot(result.project)).toEqual(before);
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }
  }

  test("late first-run failure restores every wizard-owned path", () => {
    const result = runWizard("\n", {
      env: { AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "  Setup stopped: injected first-run failure after child 3.\n  No setup changes were kept.",
    );
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
    expect(existsSync(join(result.project, ".git"))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("late first-run failure restores a pre-existing non-empty harness directory", () => {
    let before: Record<string, string> = {};
    const result = runWizard("\n", {
      env: { AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3" },
      prepare: (project) => {
        const harness = join(project, ".claude");
        mkdirSync(join(harness, "user", "nested"), { recursive: true });
        writeFileSync(join(harness, "user", "nested", "keep.txt"), "keep\n");
        writeFileSync(join(harness, "user-settings.json"), "{\"keep\":true}\n");
        before = treeSnapshot(harness);
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("No setup changes were kept.");
    expect(treeSnapshot(join(result.project, ".claude"))).toEqual(before);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("late first-run rollback preserves a newer concurrent settings write", () => {
    const newer = `${JSON.stringify({
      schemaVersion: 1,
      flags: { schemaVersion: 1, swarm: true },
    }, null, 2)}\n`;
    const priorGitignore = "# user-owned before setup\n";
    const result = runWizard("\n", {
      env: {
        AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3",
        AIDLC_TEST_FIRST_RUN_ROLLBACK_INTERFERENCE: newer,
      },
      prepare: (project) => {
        writeFileSync(join(project, ".gitignore"), priorGitignore);
      },
    });
    expect(result.status).toBe(1);
    expect(readFileSync(join(result.project, "aidlc.settings.json"), "utf-8")).toBe(newer);
    const output = `${result.stdout}${wizardStderrMessage(result.stderr)}`;
    expect(output).toContain("rollback was incomplete");
    const recovery = /recovery snapshot preserved at ([^\r\n]+)/.exec(output)?.[1];
    expect(recovery).toBeDefined();
    expect(existsSync(recovery as string)).toBe(true);
    expect(
      readdirSync(recovery as string).some((entry) => {
        const path = join(recovery as string, entry);
        return statSync(path).isFile() &&
          readFileSync(path, "utf-8") === priorGitignore;
      }),
    ).toBe(true);
    temporary.push(recovery as string);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("global first-run rollback uses the machine transaction boundary", () => {
    const machine = temp("aidlc-t299-global-machine-");
    const settings = join(machine, "aidlc.settings.json");
    mkdirSync(machine, { recursive: true });
    writeFileSync(settings, `${JSON.stringify({
      schemaVersion: 1,
      flags: { schemaVersion: 1, swarm: false },
    }, null, 2)}\n`);
    const newer = `${JSON.stringify({
      schemaVersion: 1,
      flags: { schemaVersion: 1, swarm: true },
    }, null, 2)}\n`;
    const input = `${[
      "2",
      "",
      "",
      "",
      "",
      "",
      "3",
      "",
    ].join("\n")}\n`;
    const result = runWizard(input, {
      env: {
        AIDLC_INSTALL_ROOT: machine,
        AIDLC_BIN_DIR: join(machine, "bin"),
        AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3",
        AIDLC_TEST_FIRST_RUN_ROLLBACK_INTERFERENCE: newer,
        AIDLC_TEST_FIRST_RUN_ROLLBACK_INTERFERENCE_PATH: settings,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(readFileSync(settings, "utf-8")).toBe(newer);
    const output = `${result.stdout}${wizardStderrMessage(result.stderr)}`;
    expect(output).toContain("rollback was incomplete");
    const recovery = /recovery snapshot preserved at ([^\r\n]+)/.exec(output)?.[1];
    expect(recovery).toBeDefined();
    expect(existsSync(recovery as string)).toBe(true);
    temporary.push(recovery as string);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Bun's global prompt() returns null for an empty line, which the wizard read
  // as "cancelled". Every bracketed default in the wizard depends on Enter
  // yielding "" and only a closed stdin yielding null.
  test("terminal reader distinguishes Enter (default) from a closed stdin (cancel)", () => {
    const dir = temp("aidlc-t299-reader-");
    const read = (content: string): string | null => {
      const path = join(dir, `${Math.random().toString(36).slice(2)}.txt`);
      writeFileSync(path, content);
      const fd = openSync(path, "r");
      try {
        return readTerminalLine("Q:", fd);
      } finally {
        closeSync(fd);
      }
    };
    expect(read("\n")).toBe("");
    expect(read("\r\n")).toBe("");
    expect(read("2\n")).toBe("2");
    expect(read("partial")).toBe("partial");
    expect(read("")).toBeNull();
    // Consecutive answers on one descriptor: nothing past the newline is consumed.
    const path = join(dir, "queued.txt");
    writeFileSync(path, "us-east-1\r\n\nminimal\n");
    const fd = openSync(path, "r");
    try {
      expect(readTerminalLine("Q:", fd)).toBe("us-east-1");
      expect(readTerminalLine("Q:", fd)).toBe("");
      expect(readTerminalLine("Q:", fd)).toBe("minimal");
      expect(readTerminalLine("Q:", fd)).toBeNull();
    } finally {
      closeSync(fd);
    }
  });

  // The scripted-answer seam above never reaches the real terminal path, so this
  // drives the wizard through a real pty (util-linux `script`) with a bare Enter
  // at the recommended-defaults gate and expects files to be written.
  const script = process.platform === "linux" ? Bun.which("script") : null;
  test.skipIf(!script)("bare Enter on a real terminal accepts the recommended defaults", () => {
    const project = temp("aidlc-t299-pty-project-");
    const bin = temp("aidlc-t299-pty-bin-");
    mkdirSync(join(project, ".git"));
    executable(join(bin, "claude"), "claude 2.1.220");
    executable(join(bin, "getconf"), bin);
    const result = spawnSync(
      script as string,
      ["-qfec", `${BUN} ${INIT} config --project-dir ${project}`, "/dev/null"],
      {
        cwd: project,
        env: {
          ...hostEnv(),
          ...isolatedMachineEnv(),
          PATH: bin,
          NO_COLOR: "1",
          AIDLC_RUNTIME_ROOT: RUNTIME,
          AIDLC_TEST_CONFIG_DETECTION_JSON: detection(bin),
        },
        input: "\n",
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      },
    );
    const output = `${result.stdout}${wizardStderrMessage(result.stderr)}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain("Choice [1]:");
    expect(output).not.toContain("Nothing written.");
    expect(output).toContain("Writing project files ... done");
    expect(existsSync(join(project, ".claude", "settings.json"))).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t299 first-run guidance helpers", () => {
  test("only Kiro IDE ships first-run steps, an editor name, and hook-activation advice", () => {
    for (const harness of HARNESS_NAMES) {
      const root = join(RUNTIME, harness);
      const harnessDir = readdirSync(root).find((entry) =>
        existsSync(join(root, entry, "tools", "data", "aidlc-projection.json"))
      );
      expect(harnessDir, harness).toBeDefined();
      const data = join(root, harnessDir ?? "", "tools", "data");
      const projection = JSON.parse(readFileSync(join(data, "aidlc-projection.json"), "utf-8"));
      const shipped = JSON.parse(readFileSync(join(data, "harness.json"), "utf-8"));
      const kiroIde = harness === "kiro-ide";
      expect(Object.hasOwn(projection, "firstRunSteps"), harness).toBe(kiroIde);
      expect(Object.hasOwn(projection, "editorTerminalApp"), harness).toBe(kiroIde);
      expect(Object.hasOwn(shipped, "hookActivation"), harness).toBe(kiroIde);
    }
  });

  test("an editor's terminal is recognized from its editor markers, not KIRO_* variables", () => {
    // Kiro IDE's terminal sets TERM_PROGRAM=kiro; its askpass helper is Kiro.exe.
    for (const env of [
      { TERM_PROGRAM: "kiro" },
      { TERM_PROGRAM: "Kiro" },
      { VSCODE_GIT_ASKPASS_NODE: "D:\\Apps\\Kiro\\Kiro.exe" },
    ]) {
      expect(launchedFromEditorTerminal("kiro", env), JSON.stringify(env)).toBe(true);
    }
    for (const env of [
      {},
      {
        TERM_PROGRAM: "vscode",
        VSCODE_GIT_ASKPASS_NODE: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
      },
      {
        TERM_PROGRAM: "vscode",
        VSCODE_GIT_ASKPASS_NODE: "D:\\Apps\\cursor\\Cursor.exe",
      },
      { TERM_PROGRAM: "iTerm.app" },
      { TERM_PROGRAM: "kirobuild" },
      { KIRO_API_KEY: "set" },
      { VSCODE_GIT_ASKPASS_NODE: "D:\\Apps\\Kiro\\Code.exe" },
      { VSCODE_GIT_ASKPASS_MAIN: "D:\\Apps\\Kiro\\resources\\app\\extensions\\git\\dist\\askpass-main.js" },
    ]) {
      expect(launchedFromEditorTerminal("kiro", env), JSON.stringify(env)).toBe(false);
    }
    // The name is the harness's own: another editor matches only itself.
    expect(launchedFromEditorTerminal("cursor", { TERM_PROGRAM: "kiro" })).toBe(false);
  });

  test("a failed setup step reads as a sentence with the fix as a command", () => {
    const rerun = "aidlc config";
    expect(firstRunFailureLines(JSON.stringify({
      schemaVersion: 1,
      ok: false,
      code: "transaction-failed",
      status: 1,
      message: "aidlc.settings.json: transaction source changed while staging",
      remediation: "aidlc config --from <valid-release-data>",
    }), rerun)).toEqual([
      "Setup stopped: another AIDLC process was writing at the same time.",
      "fix: run `aidlc config` again",
    ]);
    expect(firstRunFailureLines(JSON.stringify({
      message: "the release data could not be read",
      remediation: "aidlc config --from <valid-release-data>",
    }), rerun)).toEqual([
      "Setup stopped: the release data could not be read.",
      "fix: run `aidlc config` again",
    ]);
    expect(firstRunFailureLines(JSON.stringify({
      message: "the project is not writable.",
      remediation: "make the project folder writable",
    }), rerun)).toEqual([
      "Setup stopped: the project is not writable.",
      "fix: make the project folder writable",
    ]);
    expect(firstRunFailureLines('{"error":"no release data for kiro-ide"}\n', rerun)).toEqual([
      "Setup stopped: no release data for kiro-ide.",
    ]);
    expect(firstRunFailureLines("plain failure", rerun)).toEqual([
      "Setup stopped: plain failure.",
    ]);
  });
});
