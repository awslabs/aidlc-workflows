#!/usr/bin/env bun
// scripts/build-binaries.ts - release artifact builder for the single AIDLC CLI.
//
// This stays separate from scripts/package.ts. package.ts is the deterministic
// source projection and drift guard for dist/<harness>/; this script is the
// release-oriented executable build that compiles the generated Claude
// dispatcher and then smoke-gates each artifact. The binary entry is
// dist/claude/.claude/tools/aidlc.ts on purpose: release artifacts must embed
// the shipped copy, not core/. Run `bun scripts/package.ts --check` first; this
// script enforces that guard before compiling.
//
// Never enable Bun bytecode. BYTECODE-1: Bun can exit 0, emit an artifact, and still
// produce a binary that crashes before the dispatcher runs on this codebase.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AIDLC_VERSION } from "../dist/claude/.claude/tools/aidlc-version.ts";

type TargetConfig = {
  name: string;
  bunTarget: string | null;
  artifact: string;
  fileNeedle?: string;
};

type CommandResult = {
  command: string[];
  cwd: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type GateResult = {
  name: string;
  ok: boolean;
  kind: "command" | "inspection";
  command?: string[];
  cwd?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  expected?: string | number;
  actual?: string | number;
  detail?: string;
};

type TargetResult = {
  name: string;
  bunTarget: string | null;
  artifact: string;
  requestedArtifact: string;
  artifactNote?: string;
  seconds: number;
  bytes: number;
  build: CommandResult;
  gates: GateResult[];
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ENTRY = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc.ts");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "build", "binaries");
const RUNTIME_ASSET_ROOT = join(REPO_ROOT, "dist", "claude", ".claude");
const RUNTIME_DISTRIBUTIONS = ["claude", "codex", "kiro", "kiro-ide"] as const;
const MIN_CROSS_BYTES = 10 * 1024 * 1024;
const DEV_SPAWN_MARKER = "/* dev-mode bun spawn */";

function repoResolve(value: string): string {
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}

// Test-only seams. AIDLC_BUILD_ENTRY lets the unit test compile a fake
// dispatcher to prove the smoke gate can fail. AIDLC_BUILD_OUT_DIR keeps that
// failure proof out of the real release staging directory.
const ENTRY = repoResolve(process.env.AIDLC_BUILD_ENTRY ?? DEFAULT_ENTRY);
const OUT_DIR = repoResolve(process.env.AIDLC_BUILD_OUT_DIR ?? DEFAULT_OUT_DIR);

function targetConfigs(outDir: string): TargetConfig[] {
  return [
    { name: "native", bunTarget: null, artifact: join(outDir, "native", "aidlc") },
    { name: "darwin-x64", bunTarget: "bun-darwin-x64", artifact: join(outDir, "darwin-x64", "aidlc"), fileNeedle: "Mach-O" },
    { name: "darwin-arm64", bunTarget: "bun-darwin-arm64", artifact: join(outDir, "darwin-arm64", "aidlc"), fileNeedle: "Mach-O" },
    { name: "linux-x64", bunTarget: "bun-linux-x64", artifact: join(outDir, "linux-x64", "aidlc"), fileNeedle: "ELF" },
    { name: "linux-arm64", bunTarget: "bun-linux-arm64", artifact: join(outDir, "linux-arm64", "aidlc"), fileNeedle: "ELF" },
    { name: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", artifact: join(outDir, "linux-x64-musl", "aidlc"), fileNeedle: "ELF" },
    { name: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", artifact: join(outDir, "linux-arm64-musl", "aidlc"), fileNeedle: "ELF" },
    { name: "linux-x64-baseline", bunTarget: "bun-linux-x64-baseline", artifact: join(outDir, "linux-x64-baseline", "aidlc"), fileNeedle: "ELF" },
    { name: "windows-x64", bunTarget: "bun-windows-x64", artifact: join(outDir, "windows-x64", "aidlc"), fileNeedle: "PE32+" },
  ];
}

function usage(): string {
  return [
    "Usage: bun scripts/build-binaries.ts [--all-targets | --target <bun-target>]",
    "",
    "Default builds the native artifact only.",
    "--all-targets builds native plus the release cross-target matrix.",
    "--target builds exactly one target, for example bun-linux-x64 or native.",
  ].join("\n");
}

function failUsage(message: string): never {
  console.error(`${message}\n\n${usage()}`);
  process.exit(2);
}

function selectedTargets(argv: string[]): TargetConfig[] {
  let allTargets = false;
  let singleTarget: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--all-targets") {
      allTargets = true;
      continue;
    }
    if (arg === "--target") {
      const value = argv[++i];
      if (!value) failUsage("--target requires a bun target value");
      singleTarget = value;
      continue;
    }
    failUsage(`unknown argument: ${arg}`);
  }
  if (allTargets && singleTarget) failUsage("use either --all-targets or --target, not both");

  const targets = targetConfigs(OUT_DIR);
  if (!allTargets && !singleTarget) return [targets[0]];
  if (allTargets) return targets;

  const found = targets.find((target) => target.name === singleTarget || target.bunTarget === singleTarget);
  if (!found) failUsage(`unknown target: ${singleTarget}`);
  return [found];
}

function asString(value: string | Buffer | undefined): string {
  if (typeof value === "string") return value;
  if (value) return value.toString("utf-8");
  return "";
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {},
): CommandResult {
  const cwd = options.cwd ?? REPO_ROOT;
  const proc = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: options.env ?? process.env,
    input: options.input,
    timeout: options.timeoutMs ?? 300_000,
  });
  return {
    command: [command, ...args],
    cwd,
    status: proc.status,
    signal: proc.signal,
    stdout: asString(proc.stdout),
    stderr: asString(proc.stderr),
    error: proc.error?.message,
  };
}

function commandGate(
  name: string,
  result: CommandResult,
  ok: boolean,
  fields: Partial<GateResult> = {},
): GateResult {
  return {
    name,
    ok,
    kind: "command",
    command: result.command,
    cwd: result.cwd,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    ...fields,
  };
}

function actualArtifactFor(requested: string): { artifact: string; note?: string } | null {
  if (existsSync(requested)) return { artifact: requested };
  const windowsExe = `${requested}.exe`;
  if (existsSync(windowsExe)) {
    return {
      artifact: windowsExe,
      note: "Bun appended .exe to the requested Windows outfile.",
    };
  }
  return null;
}

function removeStaleArtifacts(target: TargetConfig): void {
  rmSync(dirname(target.artifact), { recursive: true, force: true });
  mkdirSync(dirname(target.artifact), { recursive: true });
}

function formatSeconds(ms: number): number {
  return Math.round((ms / 1000) * 1000) / 1000;
}

function stampedVersion(stdout: string): string {
  const trimmed = stdout.trim();
  const prefixed = /^aidlc\s+([0-9]+\.[0-9]+\.[0-9]+)$/.exec(trimmed);
  return prefixed?.[1] ?? trimmed;
}

function versionGate(artifact: string): GateResult {
  const result = run(artifact, ["version"], { cwd: tmpdir(), timeoutMs: 30_000 });
  const actual = stampedVersion(result.stdout);
  return commandGate(
    "version",
    result,
    result.status === 0 && !result.error && actual === AIDLC_VERSION,
    {
      expected: AIDLC_VERSION,
      actual,
      detail: "runs from os.tmpdir() and checks the stamped AIDLC version",
    },
  );
}

function helpGate(artifact: string): GateResult {
  const result = run(artifact, ["help"], { cwd: tmpdir(), timeoutMs: 30_000 });
  const firstLine = result.stdout.split(/\r?\n/)[0] ?? "";
  return commandGate(
    "help",
    result,
    result.status === 0 && !result.error && firstLine.toLowerCase().includes("aidlc"),
    {
      expected: "first stdout line contains aidlc",
      actual: firstLine,
      detail: "runs from os.tmpdir() and checks that help reached the dispatcher",
    },
  );
}

function pathlessEnv(projectDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: "",
    AIDLC_HARNESS_DIR: ".claude",
  };
  delete env.AIDLC_PROJECT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    env.AIDLC_PROJECT_DIR = projectDir;
    env.CLAUDE_PROJECT_DIR = projectDir;
  }
  return env;
}

function installedProject(prefix: string): string {
  const project = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(REPO_ROOT, "dist", "claude"), project, { recursive: true });
  return project;
}

function runtimeCrash(output: string): boolean {
  return /unknown command|Cannot find module|\/\$bunfs\/|Executable not found/.test(output);
}

function sensorListGate(artifact: string): GateResult {
  const result = run(artifact, ["sensor", "list"], {
    cwd: tmpdir(),
    env: pathlessEnv(),
    timeoutMs: 30_000,
  });
  const ids = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("\t")[0])
    .filter(Boolean);
  const expected = ["linter", "required-sections", "type-check", "upstream-coverage"];
  return commandGate(
    "sensor-list",
    result,
    result.status === 0 &&
      expected.every((id) => ids.includes(id)) &&
      !runtimeCrash(`${result.stdout}\n${result.stderr}`),
    { expected: expected.join(","), actual: ids.join(",") },
  );
}

function graphCompileGate(artifact: string): GateResult {
  const project = installedProject("aidlc-binary-graph-");
  try {
    const result = run(
      artifact,
      ["graph", "compile", "--check", "--project-dir", project],
      { cwd: project, env: pathlessEnv(project), timeoutMs: 60_000 },
    );
    return commandGate(
      "graph-compile-check",
      result,
      result.status === 0 && !runtimeCrash(`${result.stdout}\n${result.stderr}`),
      { expected: "compiled graph and scope grid in sync", actual: result.stderr.trim() || "in sync" },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function packagedRuntimeImmutableGate(artifact: string): GateResult {
  const project = mkdtempSync(join(tmpdir(), "aidlc-binary-no-harness-"));
  const dataDir = join(
    dirname(artifact),
    "runtime",
    "claude",
    ".claude",
    "tools",
    "data",
  );
  const paths = [
    join(dataDir, "harness.json"),
    join(dataDir, "stage-graph.json"),
    join(dataDir, "scope-grid.json"),
  ];
  const before = paths.map((path) => readFileSync(path, "utf-8"));
  try {
    const plugin = run(
      artifact,
      ["plugin", "select", "aidlc", "--project-dir", project],
      { cwd: project, env: pathlessEnv(), timeoutMs: 30_000 },
    );
    const graph = run(
      artifact,
      ["graph", "compile", "--project-dir", project],
      { cwd: project, env: pathlessEnv(), timeoutMs: 60_000 },
    );
    const unchanged = paths.every(
      (path, index) => readFileSync(path, "utf-8") === before[index],
    );
    const projectHarnessAbsent = !existsSync(join(project, ".claude"));
    const output = `${plugin.stdout}\n${plugin.stderr}\n${graph.stdout}\n${graph.stderr}`;
    return commandGate(
      "packaged-runtime-immutable",
      plugin,
      plugin.status !== 0 &&
        graph.status !== 0 &&
        unchanged &&
        projectHarnessAbsent &&
        output.includes("requires an installed project harness"),
      {
        expected: "mutable commands reject an uninstalled project without changing packaged assets",
        actual:
          `pluginStatus=${plugin.status}; graphStatus=${graph.status}; ` +
          `unchanged=${unchanged}; projectHarnessAbsent=${projectHarnessAbsent}`,
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function validateOutputsGate(artifact: string): GateResult {
  const result = run(artifact, ["validate", "outputs", "inception"], {
    cwd: tmpdir(),
    env: pathlessEnv(),
    timeoutMs: 30_000,
  });
  let pass = false;
  let stageCount = 0;
  try {
    const parsed = JSON.parse(result.stdout) as { pass?: boolean; stages?: unknown[] };
    pass = parsed.pass === true;
    stageCount = parsed.stages?.length ?? 0;
  } catch {
    pass = false;
  }
  return commandGate(
    "validate-outputs",
    result,
    result.status === 0 && pass && stageCount > 0,
    { expected: "inception stage files validate", actual: `${stageCount} stages; pass=${pass}` },
  );
}

function generatedSurfaceGate(
  artifact: string,
  name: string,
  args: string[],
  expectedText?: string,
): GateResult {
  const result = run(artifact, args, {
    cwd: tmpdir(),
    env: pathlessEnv(),
    timeoutMs: 30_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return commandGate(
    name,
    result,
    result.status === 0 &&
      (!expectedText || output.includes(expectedText)) &&
      !runtimeCrash(output),
    { expected: expectedText ?? "exit 0", actual: output.trim() || "exit 0" },
  );
}

function harnessRuntimeGate(
  artifact: string,
  distribution: string,
  harnessDir: string,
): GateResult {
  const env = {
    ...pathlessEnv(),
    AIDLC_HARNESS_DIR: harnessDir,
    AIDLC_HARNESS_NAME: distribution,
  };
  const sensors = run(artifact, ["sensor", "list"], {
    cwd: tmpdir(),
    env,
    timeoutMs: 30_000,
  });
  const runners = run(artifact, ["gen", "runners", "--check"], {
    cwd: tmpdir(),
    env,
    timeoutMs: 30_000,
  });
  const output = `${sensors.stdout}\n${sensors.stderr}\n${runners.stdout}\n${runners.stderr}`;
  return commandGate(
    `runtime-${distribution}`,
    sensors,
    sensors.status === 0 &&
      sensors.stdout.includes("required-sections") &&
      runners.status === 0 &&
      runners.stdout.includes("29 runners") &&
      !runtimeCrash(output),
    {
      expected: `${distribution} packaged sensors and generated runners resolve`,
      actual: output.trim(),
      detail: `runnerStatus=${runners.status}`,
    },
  );
}

function harnessProbeGate(artifact: string): GateResult {
  const project = mkdtempSync(join(tmpdir(), "aidlc-binary-probe-"));
  try {
    cpSync(join(REPO_ROOT, "dist", "kiro"), project, { recursive: true });
    const env = pathlessEnv(project);
    delete env.AIDLC_HARNESS_DIR;
    const result = run(
      artifact,
      ["sensor", "describe", "linter", "--project-dir", project],
      { cwd: project, env, timeoutMs: 30_000 },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    return commandGate(
      "harness-probe-kiro",
      result,
      result.status === 0 &&
        result.stdout.includes(".kiro/tools/aidlc-sensor-linter.ts") &&
        !runtimeCrash(output),
      {
        expected: "unset AIDLC_HARNESS_DIR probes the install and reads .kiro data",
        actual: output.trim(),
        detail: "kiro-only install; env harness pin removed so only the probe can resolve it",
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function pluginSelectGate(artifact: string): GateResult {
  const project = installedProject("aidlc-binary-select-");
  try {
    const result = run(
      artifact,
      ["plugin", "select", "aidlc", "--project-dir", project],
      { cwd: project, env: pathlessEnv(project), timeoutMs: 60_000 },
    );
    let selected = "";
    try {
      const harness = JSON.parse(
        readFileSync(join(project, ".claude", "tools", "data", "harness.json"), "utf-8"),
      ) as { plugins?: string[] };
      selected = harness.plugins?.join(",") ?? "";
    } catch {
      selected = "";
    }
    const output = `${result.stdout}\n${result.stderr}`;
    return commandGate(
      "plugin-select",
      result,
      result.status === 0 &&
        selected === "aidlc" &&
        result.stdout.includes("Enabled plugins: aidlc") &&
        !runtimeCrash(output),
      { expected: "selection regeneration succeeds with aidlc enabled", actual: selected || output.trim() },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function conductorPersonaGate(artifact: string): GateResult {
  const result = run(
    artifact,
    ["next", "--single", "--stage", "requirements-analysis"],
    { cwd: tmpdir(), env: pathlessEnv(), timeoutMs: 30_000 },
  );
  let kind = "";
  let personaBytes = 0;
  try {
    const parsed = JSON.parse(result.stdout) as {
      kind?: string;
      conductor_persona?: string;
    };
    kind = parsed.kind ?? "";
    personaBytes = parsed.conductor_persona?.length ?? 0;
  } catch {
    kind = "";
  }
  return commandGate(
    "conductor-persona",
    result,
    result.status === 0 && kind === "run-stage" && personaBytes > 100,
    { expected: "run-stage with conductor_persona", actual: `${kind}; personaBytes=${personaBytes}` },
  );
}

function workspaceFlagsGate(artifact: string): GateResult {
  const project = mkdtempSync(join(tmpdir(), "aidlc-binary-workspace-"));
  try {
    const interleaved = run(
      artifact,
      ["space", "--project-dir", project, "create", "teamB"],
      { cwd: project, env: pathlessEnv(), timeoutMs: 30_000 },
    );
    const legacy = run(
      artifact,
      ["--project-dir", project, "space-create", "teamC"],
      { cwd: project, env: pathlessEnv(), timeoutMs: 30_000 },
    );
    const output = `${interleaved.stdout}\n${interleaved.stderr}\n${legacy.stdout}\n${legacy.stderr}`;
    return commandGate(
      "workspace-global-flags",
      interleaved,
      interleaved.status === 0 &&
        legacy.status === 0 &&
        existsSync(join(project, "aidlc", "spaces", "teamb")) &&
        existsSync(join(project, "aidlc", "spaces", "teamc")) &&
        !runtimeCrash(output),
      {
        expected: "interleaved --project-dir and legacy space-create both create spaces",
        actual: output.trim(),
        detail: `legacyStatus=${legacy.status}`,
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function textFilesUnder(root: string): string {
  if (!existsSync(root)) return "";
  let out = "";
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out += textFilesUnder(path);
    else {
      try {
        out += readFileSync(path, "utf-8");
      } catch {
        // Ignore binary/non-readable project files.
      }
    }
  }
  return out;
}

function sensorFireGate(artifact: string): GateResult {
  const project = installedProject("aidlc-binary-sensor-");
  try {
    const birth = run(
      artifact,
      ["intent", "birth", "--scope", "poc", "--label", "sensor-gate", "--project-dir", project],
      { cwd: project, env: pathlessEnv(project), timeoutMs: 30_000 },
    );
    const outputPath = join(
      project,
      "aidlc",
      "spaces",
      "default",
      "intents",
      "sensor-output.md",
    );
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "# Output\n\n## First\nBody\n\n## Second\nBody\n", "utf-8");
    const result = run(
      artifact,
      [
        "sensor",
        "fire",
        "required-sections",
        "--stage",
        "requirements-analysis",
        "--output-path",
        outputPath,
        "--project-dir",
        project,
      ],
      { cwd: project, env: pathlessEnv(project), timeoutMs: 30_000 },
    );
    const audit = textFilesUnder(join(project, "aidlc", "spaces"));
    const output = `${result.stdout}\n${result.stderr}`;
    return commandGate(
      "sensor-fire",
      result,
      birth.status === 0 &&
        result.status === 0 &&
        /SENSOR_(PASSED|FAILED)/.test(audit) &&
        !audit.includes("script-error") &&
        !runtimeCrash(output),
      {
        expected: "bundled required-sections script emits a real terminal sensor event",
        actual: /SENSOR_(PASSED|FAILED)/.test(audit) ? "terminal event emitted" : output.trim(),
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function initializeGitProject(project: string): { git: string; branch: string } {
  const git = Bun.which("git");
  if (!git) throw new Error("git executable not found");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "binary-gate@example.com"],
    ["config", "user.name", "Binary Gate"],
    ["add", "."],
    ["commit", "-qm", "initial"],
  ]) {
    const result = run(git, args, { cwd: project, timeoutMs: 30_000 });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  }
  return { git, branch: "main" };
}

function boltReentryGate(artifact: string): GateResult {
  const project = installedProject("aidlc-binary-bolt-");
  try {
    const { git, branch } = initializeGitProject(project);
    const invocationCwd = dirname(project);
    const projectArg = relative(invocationCwd, project);
    const env = { ...pathlessEnv(), PATH: dirname(git) };
    const birth = run(
      artifact,
      ["intent", "birth", "--scope", "poc", "--label", "bolt-gate", "--project-dir", projectArg],
      { cwd: invocationCwd, env, timeoutMs: 30_000 },
    );
    const worktree = run(
      artifact,
      ["worktree", "create", "--slug", "binary-bolt", "--base", branch, "--project-dir", projectArg],
      { cwd: invocationCwd, env, timeoutMs: 30_000 },
    );
    const result = run(
      artifact,
      [
        "bolt",
        "start",
        "--name",
        "binary-bolt",
        "--batch",
        "1",
        "--worktree",
        "--slug",
        "binary-bolt",
        "--project-dir",
        projectArg,
      ],
      { cwd: invocationCwd, env: pathlessEnv(), timeoutMs: 60_000 },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    return commandGate(
      "bolt-reentry",
      result,
      birth.status === 0 &&
        worktree.status === 0 &&
        result.status === 0 &&
        result.stdout.includes("RUNTIME_GRAPH_FORKED") &&
        !runtimeCrash(output),
      { expected: "Bolt forks state, audit, and runtime graph without PATH bun", actual: output.trim() },
    );
  } catch (error) {
    return {
      name: "bolt-reentry",
      ok: false,
      kind: "inspection",
      expected: "successful Bolt compiled self-reentry",
      actual: String(error),
    };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function swarmReentryGate(artifact: string): GateResult {
  const project = installedProject("aidlc-binary-swarm-");
  try {
    const { git, branch } = initializeGitProject(project);
    const invocationCwd = dirname(project);
    const projectArg = relative(invocationCwd, project);
    const env = { ...pathlessEnv(), PATH: dirname(git) };
    const birth = run(
      artifact,
      ["intent", "birth", "--scope", "poc", "--label", "swarm-gate", "--project-dir", projectArg],
      { cwd: invocationCwd, env, timeoutMs: 30_000 },
    );
    const result = run(
      artifact,
      [
        "swarm",
        "prepare",
        "--batch",
        "1",
        "--units",
        "swarm-unit",
        "--base",
        branch,
        "--project-dir",
        projectArg,
      ],
      { cwd: invocationCwd, env, timeoutMs: 90_000 },
    );
    let prepared = false;
    try {
      const parsed = JSON.parse(result.stdout) as { units?: Array<{ ok?: boolean }> };
      prepared = parsed.units?.[0]?.ok === true;
    } catch {
      prepared = false;
    }
    const output = `${result.stdout}\n${result.stderr}`;
    return commandGate(
      "swarm-reentry",
      result,
      birth.status === 0 && result.status === 0 && prepared && !runtimeCrash(output),
      { expected: "Swarm prepare composes worktree and Bolt through the binary", actual: output.trim() },
    );
  } catch (error) {
    return {
      name: "swarm-reentry",
      ok: false,
      kind: "inspection",
      expected: "successful Swarm compiled self-reentry",
      actual: String(error),
    };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function delegatePluginSyncGate(artifact: string): GateResult {
  const result = run(artifact, ["plugin", "sync"], { cwd: tmpdir(), timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const moduleError = /Cannot find module|\/\$bunfs\//.test(output);
  const actual = result.stdout.trim();
  return commandGate(
    "delegate-plugin-sync",
    result,
    !result.error &&
      result.status === 0 &&
      actual === "no installed plugins; nothing to sync" &&
      !moduleError,
    {
      expected: "no installed plugins; nothing to sync",
      actual: actual || result.stderr.trim(),
      detail: "runs a real utility delegate from the compiled artifact",
    },
  );
}

function realPluginSyncGate(artifact: string): GateResult {
  const project = mkdtempSync(join(tmpdir(), "aidlc-binary-plugin-"));
  const pluginRoot = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude");
  try {
    cpSync(RUNTIME_ASSET_ROOT, join(project, ".claude"), { recursive: true });
    cpSync(join(REPO_ROOT, "dist", "claude", "aidlc"), join(project, "aidlc"), {
      recursive: true,
    });
    const result = run(artifact, ["plugin", "sync", "--project-dir", project], {
      cwd: project,
      env: {
        ...process.env,
        PATH: "",
        AIDLC_HARNESS_DIR: ".claude",
        AIDLC_PLUGIN_ROOT: pluginRoot,
        CLAUDE_PROJECT_DIR: project,
      },
      timeoutMs: 60_000,
    });
    const composedStage = join(
      project,
      ".claude",
      "aidlc-common",
      "stages",
      "construction",
      "test-pro-integration.md",
    );
    const graphPath = join(project, ".claude", "tools", "data", "stage-graph.json");
    let graphContainsPlugin = false;
    try {
      const graph = JSON.parse(readFileSync(graphPath, "utf-8")) as Array<{ slug?: string }>;
      graphContainsPlugin = graph.some((stage) => stage.slug === "test-pro-integration");
    } catch {
      graphContainsPlugin = false;
    }
    const output = `${result.stdout}\n${result.stderr}`;
    return commandGate(
      "real-plugin-sync",
      result,
      result.status === 0 &&
        result.stdout.trim() === "plugin sync complete: 1 plugin(s)" &&
        existsSync(composedStage) &&
        graphContainsPlugin &&
        !/unknown command|Cannot find module|\/\$bunfs\//.test(output),
      {
        expected: "real plugin compose and graph compile succeed without PATH bun",
        actual: existsSync(composedStage) && graphContainsPlugin
          ? result.stdout.trim()
          : result.stderr.trim() || "composed graph entry missing",
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function pathlessOrchestrateGate(
  artifact: string,
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  expectedKind: string,
  expectedText: string,
): GateResult {
  const project = mkdtempSync(join(tmpdir(), `aidlc-binary-${name}-`));
  try {
    const result = run(artifact, [...args, "--project-dir", project], {
      cwd: project,
      env: {
        ...process.env,
        ...env,
        PATH: "",
        CLAUDE_PROJECT_DIR: project,
      },
      timeoutMs: 30_000,
    });
    let kind = "";
    let directiveText = "";
    try {
      const directive = JSON.parse(result.stdout) as {
        kind?: string;
        message?: string;
        reason?: string;
      };
      kind = directive.kind ?? "";
      directiveText = directive.message ?? directive.reason ?? "";
    } catch {
      kind = "";
    }
    const output = `${result.stdout}\n${result.stderr}`;
    return commandGate(
      name,
      result,
      result.status === 0 &&
        kind === expectedKind &&
        directiveText.includes(expectedText) &&
        !/Executable not found|unknown command|Cannot find module|\/\$bunfs\//.test(output),
      {
        expected: `${expectedKind} directive containing ${expectedText}`,
        actual: kind ? `${kind}: ${directiveText}` : result.stderr.trim() || result.stdout.trim(),
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function hookGate(artifact: string): GateResult {
  const project = mkdtempSync(join(tmpdir(), "aidlc-binary-hook-"));
  try {
    const result = run(artifact, ["hook", "validate-state"], {
      cwd: project,
      env: { ...process.env, PATH: "", CLAUDE_PROJECT_DIR: project },
      input: "{}",
      timeoutMs: 30_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const heartbeat = join(
      project,
      "aidlc",
      "spaces",
      "default",
      "intents",
      ".aidlc-hooks-health",
      "validate-state.last",
    );
    return commandGate(
      "hook-validate-state",
      result,
      result.status === 0 &&
        existsSync(heartbeat) &&
        !/not available|Cannot find module|\/\$bunfs\/|unknown command/.test(output),
      {
        expected: "compiled hook route writes validate-state heartbeat",
        actual: existsSync(heartbeat) ? "heartbeat written" : result.stderr.trim(),
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function statuslineGate(artifact: string): GateResult {
  const project = mkdtempSync(join(tmpdir(), "aidlc-binary-statusline-"));
  try {
    const input = JSON.stringify({
      workspace: { project_dir: project },
      model: { id: "claude-test" },
      context_window: { used_percentage: 5 },
    });
    const result = run(artifact, ["statusline"], {
      cwd: project,
      env: { ...process.env, PATH: "" },
      input,
      timeoutMs: 30_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    return commandGate(
      "statusline",
      result,
      result.status === 0 &&
        result.stdout.trim().length > 0 &&
        !/not available|Cannot find module|\/\$bunfs\//.test(output),
      {
        expected: "non-empty compiled statusline output",
        actual: result.stdout.trim() || result.stderr.trim(),
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function codexAdapterGate(artifact: string): GateResult {
  const project = mkdtempSync(join(tmpdir(), "aidlc-binary-codex-"));
  try {
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(project, ".codex"), {
      recursive: true,
    });
    const input = JSON.stringify({
      hook_event_name: "PreCompact",
      cwd: project,
      session_id: `binary-gate-${Date.now()}`,
    });
    const result = run(artifact, ["adapter", "codex", "validate-state"], {
      cwd: project,
      env: { ...process.env, PATH: "" },
      input,
      timeoutMs: 30_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const heartbeat = join(
      project,
      "aidlc",
      "spaces",
      "default",
      "intents",
      ".aidlc-hooks-health",
      "validate-state.last",
    );
    return commandGate(
      "adapter-codex-validate-state",
      result,
      result.status === 0 &&
        existsSync(heartbeat) &&
        !/not available|Cannot find module|\/\$bunfs\/|unknown command/.test(output),
      {
        expected: "Codex adapter invokes validate-state",
        actual: existsSync(heartbeat) ? "heartbeat written" : result.stderr.trim(),
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function routedProjectDirGate(artifact: string): GateResult {
  const cwdProject = mkdtempSync(join(tmpdir(), "aidlc-binary-route-cwd-"));
  const targetProject = installedProject("aidlc-binary-route-target-");
  try {
    cpSync(
      join(REPO_ROOT, "dist", "codex", ".codex"),
      join(targetProject, ".codex"),
      { recursive: true },
    );
    const env = { ...pathlessEnv(), CLAUDE_PROJECT_DIR: cwdProject };
    const hook = run(
      artifact,
      ["hook", "validate-state", "--project-dir", targetProject],
      { cwd: cwdProject, env, input: "{}", timeoutMs: 30_000 },
    );
    const targetGenericHeartbeat = join(
      targetProject,
      "aidlc",
      "spaces",
      "default",
      "intents",
      ".aidlc-hooks-health",
      "validate-state.last",
    );
    const cwdGenericHeartbeat = join(
      cwdProject,
      "aidlc",
      "spaces",
      "default",
      "intents",
      ".aidlc-hooks-health",
      "validate-state.last",
    );

    const birth = run(
      artifact,
      [
        "intent",
        "birth",
        "--scope",
        "poc",
        "--label",
        "route-target",
        "--project-dir",
        targetProject,
      ],
      { cwd: cwdProject, env, timeoutMs: 30_000 },
    );
    const statusline = run(
      artifact,
      ["statusline", "--project-dir", targetProject],
      {
        cwd: cwdProject,
        env,
        input: JSON.stringify({
          workspace: { project_dir: cwdProject },
          model: { id: "claude-test" },
          context_window: { used_percentage: 5 },
        }),
        timeoutMs: 30_000,
      },
    );

    const activeIntent = readFileSync(
      join(
        targetProject,
        "aidlc",
        "spaces",
        "default",
        "intents",
        "active-intent",
      ),
      "utf-8",
    ).trim();
    const adapterHeartbeat = join(
      targetProject,
      "aidlc",
      "spaces",
      "default",
      "intents",
      activeIntent,
      ".aidlc-hooks-health",
      "validate-state.last",
    );
    const adapter = run(
      artifact,
      ["adapter", "codex", "validate-state", "--project-dir", targetProject],
      {
        cwd: cwdProject,
        env,
        input: JSON.stringify({
          hook_event_name: "PreCompact",
          cwd: cwdProject,
          session_id: `binary-route-${Date.now()}`,
        }),
        timeoutMs: 30_000,
      },
    );
    const output = [
      hook.stdout,
      hook.stderr,
      birth.stdout,
      birth.stderr,
      statusline.stdout,
      statusline.stderr,
      adapter.stdout,
      adapter.stderr,
    ].join("\n");
    return commandGate(
      "routed-project-dir",
      hook,
      hook.status === 0 &&
        existsSync(targetGenericHeartbeat) &&
        !existsSync(cwdGenericHeartbeat) &&
        birth.status === 0 &&
        statusline.status === 0 &&
        statusline.stdout.includes("Intent Capture") &&
        adapter.status === 0 &&
        existsSync(adapterHeartbeat) &&
        !runtimeCrash(output),
      {
        expected: "hook, statusline, and adapter honor explicit --project-dir",
        actual:
          `hook=${hook.status}; birth=${birth.status}; statusline=${statusline.status}; ` +
          `adapter=${adapter.status}; targetHeartbeat=${existsSync(adapterHeartbeat)}`,
      },
    );
  } catch (error) {
    return {
      name: "routed-project-dir",
      ok: false,
      kind: "inspection",
      expected: "routing-only commands honor explicit --project-dir",
      actual: String(error),
    };
  } finally {
    rmSync(cwdProject, { recursive: true, force: true });
    rmSync(targetProject, { recursive: true, force: true });
  }
}

function delegateDoctorDataGate(artifact: string): GateResult {
  const result = run(artifact, ["doctor"], { cwd: tmpdir(), timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const crashSignature = output.match(/Cannot find module|\/\$bunfs\/|ENOENT/)?.[0] ?? "";
  const reportEmitted = result.stdout.includes("AI-DLC Health Check");
  const schemaCount = /Schema validation: (\d+)\/(\d+) stages validated/.exec(result.stdout);
  const meaningfulSchemaCount =
    schemaCount !== null &&
    Number(schemaCount[1]) > 0 &&
    schemaCount[1] === schemaCount[2];
  return commandGate(
    "delegate-doctor-data",
    result,
    !result.error && reportEmitted && crashSignature === "" && meaningfulSchemaCount,
    {
      expected: "doctor report with a non-zero complete schema count and no compiled-data crash signatures",
      actual: crashSignature || schemaCount?.[0] || "schema count missing",
      detail: "runs doctor from os.tmpdir() against executable-relative runtime data",
    },
  );
}

function pathlessVersionGate(artifact: string): GateResult {
  const result = run(artifact, ["version"], {
    cwd: tmpdir(),
    env: { ...process.env, PATH: "" },
    timeoutMs: 30_000,
  });
  const actual = stampedVersion(result.stdout);
  return commandGate(
    "pathless-version",
    result,
    result.status === 0 && !result.error && actual === AIDLC_VERSION,
    {
      expected: AIDLC_VERSION,
      actual,
      detail: "runs version with PATH empty to prove the native version path does not need a PATH bun",
    },
  );
}

function markerFreeBunSpawnLine(line: string): boolean {
  if (!line.includes("\"bun\"") && !line.includes("'bun'")) return false;
  if (line.includes(DEV_SPAWN_MARKER)) return false;
  return /\b(?:Bun\.)?spawn(?:Sync)?\b|\bspawnSync\b|\bspawn\b|\bcmd:\s*\[|\[\s*["']bun["']/.test(line);
}

function devSpawnGrepGate(entry: string): GateResult {
  let source: string;
  try {
    source = readFileSync(entry, "utf-8");
  } catch (error) {
    return {
      name: "dev-spawn-grep",
      ok: false,
      kind: "inspection",
      expected: "readable dispatcher source",
      actual: String(error),
    };
  }
  const badLines = source
    .split(/\r?\n/)
    .filter(markerFreeBunSpawnLine)
    .slice(0, 10);
  const markerPresent = source.includes(DEV_SPAWN_MARKER);
  return {
    name: "dev-spawn-grep",
    ok: markerPresent && badLines.length === 0,
    kind: "inspection",
    expected: "no marker-free literal bun spawn in the dispatcher source",
    actual: badLines.length,
    detail:
      `sourceBytes=${source.length}; markerPresentInSource=${markerPresent}; ` +
      `badLines=${JSON.stringify(badLines)}; pathless-version is the runtime gate ` +
      "for the native version path",
  };
}

function runtimeAssetsGate(artifact: string): GateResult {
  const artifactDir = dirname(artifact);
  const runtimeDir = join(artifactDir, "runtime");
  const assets = RUNTIME_DISTRIBUTIONS.map((distribution) => ({
    source: join(REPO_ROOT, "dist", distribution),
    destination: join(runtimeDir, distribution),
  }));

  try {
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const asset of assets) {
      cpSync(asset.source, asset.destination, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      name: "runtime-assets",
      ok: false,
      kind: "inspection",
      expected: "runtime asset trees copied beside the executable",
      actual: String(error),
    };
  }

  const missing = assets
    .filter((asset) => !existsSync(asset.destination))
    .map((asset) => asset.destination);
  return {
    name: "runtime-assets",
    ok: missing.length === 0,
    kind: "inspection",
    expected: assets.length,
    actual: assets.length - missing.length,
    detail: missing.length === 0
      ? "complete claude, codex, kiro, and kiro-ide distributions staged"
      : `missing destinations: ${missing.join(", ")}`,
  };
}

function sizeGate(bytes: number): GateResult {
  return {
    name: "size",
    ok: bytes > MIN_CROSS_BYTES,
    kind: "inspection",
    expected: MIN_CROSS_BYTES + 1,
    actual: bytes,
    detail: "cross artifacts must be larger than 10 MiB",
  };
}

function fileGate(artifact: string, needle: string): GateResult {
  const result = run("file", [artifact], { cwd: REPO_ROOT, timeoutMs: 30_000 });
  return commandGate(
    "file",
    result,
    result.status === 0 && !result.error && result.stdout.includes(needle),
    {
      expected: needle,
      actual: result.stdout.trim(),
      detail: "file(1) target-format smoke for cross artifacts",
    },
  );
}

function buildTarget(target: TargetConfig): TargetResult {
  removeStaleArtifacts(target);

  const args = ["build", ENTRY, "--compile", "--outfile", target.artifact];
  if (target.bunTarget) args.push(`--target=${target.bunTarget}`);

  const start = performance.now();
  const build = run(process.execPath, args, { cwd: REPO_ROOT, timeoutMs: 300_000 });
  const seconds = formatSeconds(performance.now() - start);
  const result: TargetResult = {
    name: target.name,
    bunTarget: target.bunTarget,
    artifact: target.artifact,
    requestedArtifact: target.artifact,
    seconds,
    bytes: 0,
    build,
    gates: [],
  };

  if (build.status !== 0 || build.error) {
    result.gates.push(commandGate("build", build, false, { detail: "bun build --compile failed" }));
    return result;
  }

  const actual = actualArtifactFor(target.artifact);
  if (!actual) {
    result.gates.push({
      name: "artifact-exists",
      ok: false,
      kind: "inspection",
      expected: target.artifact,
      actual: "missing",
      detail: "bun build exited 0 but did not create the requested artifact",
    });
    return result;
  }

  result.artifact = actual.artifact;
  result.artifactNote = actual.note;
  result.bytes = statSync(actual.artifact).size;
  result.gates.push(runtimeAssetsGate(actual.artifact));

  if (target.name === "native") {
    result.gates.push(versionGate(actual.artifact));
    result.gates.push(helpGate(actual.artifact));
    result.gates.push(sensorListGate(actual.artifact));
    result.gates.push(sensorFireGate(actual.artifact));
    result.gates.push(graphCompileGate(actual.artifact));
    result.gates.push(packagedRuntimeImmutableGate(actual.artifact));
    result.gates.push(validateOutputsGate(actual.artifact));
    result.gates.push(generatedSurfaceGate(
      actual.artifact,
      "runner-check",
      ["gen", "runners", "--check"],
      "stage-runner set is in sync",
    ));
    result.gates.push(generatedSurfaceGate(
      actual.artifact,
      "stage-table-check",
      ["gen", "stage-table", "--check"],
    ));
    result.gates.push(generatedSurfaceGate(
      actual.artifact,
      "scope-table-check",
      ["gen", "scope-table", "--check"],
    ));
    result.gates.push(harnessRuntimeGate(actual.artifact, "codex", ".codex"));
    result.gates.push(harnessRuntimeGate(actual.artifact, "kiro", ".kiro"));
    result.gates.push(harnessRuntimeGate(actual.artifact, "kiro-ide", ".kiro"));
    result.gates.push(harnessProbeGate(actual.artifact));
    result.gates.push(pluginSelectGate(actual.artifact));
    result.gates.push(delegatePluginSyncGate(actual.artifact));
    result.gates.push(realPluginSyncGate(actual.artifact));
    result.gates.push(conductorPersonaGate(actual.artifact));
    result.gates.push(workspaceFlagsGate(actual.artifact));
    result.gates.push(boltReentryGate(actual.artifact));
    result.gates.push(swarmReentryGate(actual.artifact));
    result.gates.push(delegateDoctorDataGate(actual.artifact));
    result.gates.push(devSpawnGrepGate(ENTRY));
    result.gates.push(pathlessVersionGate(actual.artifact));
    result.gates.push(pathlessOrchestrateGate(
      actual.artifact,
      "pathless-next-env-scope",
      ["next"],
      { AWS_AIDLC_DEFAULT_SCOPE: "feature" },
      "error",
      "No workflow state found",
    ));
    result.gates.push(pathlessOrchestrateGate(
      actual.artifact,
      "pathless-park",
      ["park"],
      {},
      "error",
      "State file not found",
    ));
    result.gates.push(pathlessOrchestrateGate(
      actual.artifact,
      "pathless-single-audit",
      ["report", "--single", "--stage", "requirements-analysis", "--result", "completed"],
      {},
      "done",
      "committed under synthetic workflow",
    ));
    result.gates.push(hookGate(actual.artifact));
    result.gates.push(statuslineGate(actual.artifact));
    result.gates.push(codexAdapterGate(actual.artifact));
    result.gates.push(routedProjectDirGate(actual.artifact));
  } else {
    result.gates.push(sizeGate(result.bytes));
    result.gates.push(fileGate(actual.artifact, target.fileNeedle ?? ""));
  }

  return result;
}

function resultFailures(result: TargetResult): string[] {
  const failures: string[] = [];
  if (result.build.status !== 0 || result.build.error) {
    failures.push(`${result.name}: build failed`);
  }
  for (const gate of result.gates) {
    if (!gate.ok) failures.push(`${result.name}: ${gate.name} gate failed`);
  }
  return failures;
}

function writeResults(
  bunVersion: string,
  packageCheck: CommandResult,
  results: TargetResult[],
): void {
  const totalSeconds = formatSeconds(results.reduce((sum, result) => sum + result.seconds * 1000, 0));
  const output = {
    generator: "scripts/build-binaries.ts",
    entry: ENTRY,
    outDir: OUT_DIR,
    bunVersion,
    expectedVersion: AIDLC_VERSION,
    packageCheck,
    nativeOnlySeconds: results.find((result) => result.name === "native")?.seconds ?? 0,
    totalSeconds,
    failures: results.flatMap(resultFailures),
    results,
  };
  writeFileSync(join(OUT_DIR, "build-results.json"), `${JSON.stringify(output, null, 2)}\n`, "utf-8");
}

function tail(text: string, lines = 20): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

function main(): void {
  const targets = selectedTargets(process.argv.slice(2));

  const packageCheck = run(process.execPath, ["scripts/package.ts", "--check"], {
    cwd: REPO_ROOT,
    timeoutMs: 300_000,
  });
  if (packageCheck.status !== 0 || packageCheck.error) {
    console.error("package drift guard failed; run bun scripts/package.ts before building binaries");
    const output = tail(`${packageCheck.stdout}${packageCheck.stderr}`);
    if (output) console.error(output);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const bunVersion = run(process.execPath, ["--version"], { cwd: REPO_ROOT, timeoutMs: 30_000 }).stdout.trim();
  const results: TargetResult[] = [];

  for (const target of targets) {
    const result = buildTarget(target);
    results.push(result);
    const ok = resultFailures(result).length === 0 ? "ok" : "FAIL";
    console.log(`${result.name}\t${ok}\t${result.seconds}s\t${result.bytes} bytes\t${result.artifact}`);
  }

  writeResults(bunVersion, packageCheck, results);

  const failures = results.flatMap(resultFailures);
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(`wrote ${join(OUT_DIR, "build-results.json")}`);
    process.exit(1);
  }

  console.log(`wrote ${join(OUT_DIR, "build-results.json")}`);
}

main();
