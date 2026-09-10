// covers: tool:aidlc-init, function:readTerminalLine

import { afterAll, describe, expect, test } from "bun:test";
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
import { binRoot } from "../../core/tools/aidlc-install-paths.ts";
import { readTerminalLine } from "../../core/tools/aidlc-command.ts";
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
function filesystemPreload(failure?: FilesystemFailure): { preload: string; trace: string } {
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
    timeout: 60_000,
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
    preload?: string;
    configArgs?: string[];
  } = {},
): CliContext & CliResult {
  const project = realpathSync(temp("aidlc-t299-project-"));
  const bin = temp("aidlc-t299-bin-");
  mkdirSync(join(project, ".git"));
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
      ...process.env,
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
  return { ...context, ...runCli(context, INIT, ["config", ...(options.configArgs ?? [])], input) };
}

function expectConfiguredProject(project: string, mcp: "defaults" | "none"): void {
  const settings = JSON.parse(readFileSync(join(project, "aidlc.settings.json"), "utf-8"));
  expect(settings).toEqual(expect.objectContaining({
    schemaVersion: 1,
    models: expect.objectContaining({ schemaVersion: 1, preset: "balanced" }),
  }));
  const data = join(project, ".claude", "tools", "data");
  const harness = JSON.parse(readFileSync(join(data, "harness.json"), "utf-8"));
  expect(harness.providers).toEqual(expect.objectContaining({
    schemaVersion: 1,
    provider: "amazon-bedrock",
    region: "us-east-2",
    pendingActions: expect.arrayContaining([
      expect.objectContaining({ id: "bedrock-model-access", status: "done" }),
    ]),
  }));
  const nativeSettings = JSON.parse(
    readFileSync(join(project, ".claude", "settings.json"), "utf-8"),
  );
  expect(nativeSettings.env).toEqual(expect.objectContaining({
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "us-east-2",
  }));
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

describe("t299 first-run setup wizard", () => {
  test("recommended defaults render detection, trichotomy, receipts, blocker, and next commands", () => {
    const result = runWizard("\n", { aidlc: false, runtimeIssue: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("AI-DLC setup - first run in this project.");
    expect(result.stdout).toContain("Claude Code detected  (2.1.220 on your PATH)");
    expect(result.stdout).toContain(
      "credentials found  (instance role, detected region us-east-2)",
    );
    expect(result.stdout).toContain("1. Yes, use recommended defaults");
    expect(result.stdout).toContain("MCP servers on, all plugins, Bedrock via your AWS credentials");
    expect(result.stdout).toContain("Writing project files ... done");
    expect(result.stdout).toContain(
      "Recording your choices ... done  (aidlc.settings.json in this project)",
    );
    if (process.platform === "win32") {
      expect(result.stdout).toContain(
        `Add ${binRoot()} to your User PATH in Windows Settings, then open a new terminal.`,
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
  }, 60_000);

  test("customize re-asks invalid preset and writes nothing when review declines", () => {
    const result = runWizard(
      "2\n\n\n\n\nthorogh\n2\n\n\n\nn\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Customize setup - 6 steps");
    expect(result.stdout).toContain("Kiro IDE        (not probed)");
    for (let step = 1; step <= 6; step++) {
      expect(result.stdout).toContain(`Step ${step} of 6`);
    }
    expect(result.stdout).toContain(
      "That's not one of the choices - enter 1, 2, or 3.",
    );
    expect(result.stdout).toContain("Using the thorough preset.");
    expect(result.stdout).toContain("Your choices - Enter to apply");
    expect(result.stdout).toContain("Nothing written.");
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

  test("OpenCode recommended Bedrock setup records an explicit default choice", () => {
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
      provider: "amazon-bedrock",
      opencodeDefault: true,
    }));
  }, 60_000);

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
  }, 60_000);

  test("recommended first-run and installed workflow writes succeed with project hardlinks refused in every config child", () => {
    const { preload, trace } = filesystemPreload();
    const result = runWizard("\n", { preload });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(0);
    expect(output).toContain("Writing project files ... done");
    expect(output).toContain("Recording your choices ... done");
    expect(output).toContain("Setup complete. Start your first workflow:");
    expect(output).not.toContain("Setup stopped:");
    expectConfiguredProject(result.project, "defaults");

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
      }, 60_000);
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
      }, 60_000);
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
      }, 60_000);
    }
  }

  test("late first-run failure restores every wizard-owned path", () => {
    const result = runWizard("\n", {
      env: { AIDLC_TEST_FIRST_RUN_FAIL_AFTER_CHILD: "3" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("No setup changes were kept.");
    expect(existsSync(join(result.project, ".claude"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc"))).toBe(false);
    expect(existsSync(join(result.project, "aidlc.settings.json"))).toBe(false);
    expect(existsSync(join(result.project, ".git"))).toBe(true);
  }, 60_000);

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
  }, 60_000);

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
    const output = `${result.stdout}${result.stderr}`;
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
  }, 60_000);

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
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("rollback was incomplete");
    const recovery = /recovery snapshot preserved at ([^\r\n]+)/.exec(output)?.[1];
    expect(recovery).toBeDefined();
    expect(existsSync(recovery as string)).toBe(true);
    temporary.push(recovery as string);
  }, 60_000);

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
          ...process.env,
          ...isolatedMachineEnv(),
          PATH: bin,
          NO_COLOR: "1",
          AIDLC_RUNTIME_ROOT: RUNTIME,
          AIDLC_TEST_CONFIG_DETECTION_JSON: detection(bin),
        },
        input: "\n",
        encoding: "utf-8",
        timeout: 60_000,
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain("Choice [1]:");
    expect(output).not.toContain("Nothing written.");
    expect(output).toContain("Writing project files ... done");
    expect(existsSync(join(project, ".claude", "settings.json"))).toBe(true);
  }, 90_000);
});
