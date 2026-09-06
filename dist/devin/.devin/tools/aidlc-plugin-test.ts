#!/usr/bin/env bun
// Offline compose-tier test for an authored AIDLC plugin.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  bundledPluginHookTemplatesDir,
  bundledPluginTargetsPath,
} from "./aidlc-plugin-build.ts";
import {
  buildPluginProjection,
  type PluginTarget,
  type PluginTargetTable,
  readPluginTargets,
} from "./aidlc-plugin-emit.ts";
import {
  formatPluginValidation,
  type PluginValidationFinding,
  type PluginValidationResult,
  validatePluginRoot,
  walkPluginFiles,
} from "./aidlc-plugin-validate.ts";

const USAGE =
  "Usage: bun <tools-dir>/aidlc-plugin-test.ts <plugin-root> --install <project-root> [--harness <name>] [--json]";
const SUBPROCESS_TIMEOUT_MS = 60_000;

export interface PluginComposeRunOptions {
  harness: string;
  harnessLeaf: string;
  projectDir: string;
  pluginBuilt: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface PluginComposeRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface PluginDropEntry {
  file: string;
  severity: "degraded" | "advisory" | "unknown";
  message: string;
  raw: string;
}

export interface PluginGraphTestResult {
  compiled: boolean;
  expectedStages: string[];
  presentStages: string[];
  missingStages: string[];
  expectedScopes: string[];
  presentScopes: string[];
  missingScopes: string[];
}

export interface PluginTestResult extends PluginValidationResult {
  harness: string;
  composedFiles: string[];
  changedFiles: string[];
  drops: PluginDropEntry[];
  graph: PluginGraphTestResult;
  idempotent: boolean;
}

export interface TestPluginOptions {
  pluginRoot: string;
  installRoot: string;
  harness?: string;
  targetsPath?: string;
  templateHooksDir?: string;
}

type Snapshot = Map<string, string>;

class PluginTestUsageError extends Error {}

const CANDIDATE_PATH_ENV_KEYS = [
  "CLAUDE_PLUGIN_ROOT",
  "PLUGIN_ROOT",
  "AIDLC_PLUGIN_ROOT",
  "CLAUDE_PROJECT_DIR",
  "CURSOR_PROJECT_DIR",
  "AIDLC_PROJECT_DIR",
  "AIDLC_STAGE_GRAPH",
  "AIDLC_SCOPE_GRID",
  "AIDLC_STAGES_DIR",
  "AIDLC_SENSORS_DIR",
  "AIDLC_SCOPES_DIR",
  "AIDLC_AGENTS_DIR",
  "AIDLC_RULES_DIR",
  "AIDLC_SCOPE_MAPPING",
  "AIDLC_FRAMEWORK_TEMPLATES_DIR",
  "AIDLC_MEMORY_SEED_DIR",
  "AIDLC_ARS_PRIORS",
  "AIDLC_PLAN_PATH",
  "AIDLC_EXPORT_FIXTURE",
] as const;

function candidateProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CANDIDATE_PATH_ENV_KEYS) delete env[key];
  return env;
}

function posixRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join("/") || ".";
}

function hashFile(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return `link:${readlinkSync(path)}`;
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotPaths(root: string, paths: string[]): Snapshot {
  const snapshot: Snapshot = new Map();
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const entry of readdirSync(path).sort()) {
        walk(join(path, entry));
      }
      return;
    }
    snapshot.set(posixRelative(root, path), hashFile(path));
  };
  for (const rel of paths) {
    const path = join(root, rel);
    if (existsSync(path)) walk(path);
  }
  return snapshot;
}

function snapshotWholeTree(root: string): Snapshot {
  return snapshotPaths(
    root,
    existsSync(root) ? readdirSync(root).sort() : [],
  );
}

function snapshotDiff(
  before: Snapshot,
  after: Snapshot,
): {
  added: string[];
  changed: string[];
  removed: string[];
} {
  const names = new Set([...before.keys(), ...after.keys()]);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const name of [...names].sort()) {
    if (!before.has(name)) added.push(name);
    else if (!after.has(name)) removed.push(name);
    else if (before.get(name) !== after.get(name)) changed.push(name);
  }
  return { added, changed, removed };
}

function copyInstallRoots(
  installRoot: string,
  candidateRoot: string,
  target: PluginTarget,
): void {
  for (const rel of target.installRoots) {
    const source = join(installRoot, rel);
    if (!existsSync(source)) continue;
    const destination = join(candidateRoot, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, {
      recursive: true,
      // Materialize links so candidate paths cannot point back into the live install.
      dereference: true,
    });
  }
}

function directComposeEnv(
  options: PluginComposeRunOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...candidateProcessEnv(),
    AIDLC_HARNESS_DIR: options.harnessLeaf,
    AIDLC_HARNESS_NAME: options.harness,
  };
  if (
    options.harness === "claude" ||
    options.harness === "codex" ||
    options.harness === "kiro" ||
    options.harness === "kiro-ide"
  ) {
    env.CLAUDE_PLUGIN_ROOT = options.pluginBuilt;
    env.CLAUDE_PROJECT_DIR = options.projectDir;
  } else {
    env.PLUGIN_ROOT = options.pluginBuilt;
    env.AIDLC_PROJECT_DIR = options.projectDir;
  }
  Object.assign(env, options.env);
  return env;
}

export function runPluginCompose(
  options: PluginComposeRunOptions,
): PluginComposeRunResult {
  if (options.harness === "cursor") {
    const env: NodeJS.ProcessEnv = {
      ...candidateProcessEnv(),
      AIDLC_HARNESS_DIR: options.harnessLeaf,
      AIDLC_HARNESS_NAME: options.harness,
      PATH: "",
    };
    Object.assign(env, options.env);
    const result = spawnSync(
      process.execPath,
      [
        join(
          options.pluginBuilt,
          "hooks",
          "aidlc-plugin-compose.ts",
        ),
        options.harnessLeaf,
      ],
      {
        cwd: options.pluginBuilt,
        input: JSON.stringify({
          hook_event_name: "sessionStart",
          workspace_roots: [options.projectDir],
        }),
        encoding: "utf-8",
        env,
        timeout: options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS,
      },
    );
    return {
      status: result.status ?? -1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  }

  const result = spawnSync(
    process.execPath,
    [join(options.pluginBuilt, "hooks", "compose.ts")],
    {
      cwd: options.projectDir,
      encoding: "utf-8",
      env: directComposeEnv(options),
      timeout: options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS,
    },
  );
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

export function readPluginDropEntries(
  projectDir: string,
  pluginName?: string,
): PluginDropEntry[] {
  const entries: PluginDropEntry[] = [];
  const expectedFile = pluginName
    ? `plugin-compose-${pluginName.replace(/[^\w.-]/g, "_")}.drops`
    : null;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (
        !entry.name.startsWith("plugin-compose") ||
        !entry.name.endsWith(".drops") ||
        (expectedFile !== null && entry.name !== expectedFile)
      ) {
        continue;
      }
      for (const raw of readFileSync(path, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)) {
        const match = raw.match(
          /^[^\t]*\t\[(degraded|advisory)\]\s*(.*)$/,
        );
        entries.push({
          file: posixRelative(projectDir, path),
          severity:
            match?.[1] === "degraded" || match?.[1] === "advisory"
              ? match[1]
              : "unknown",
          message: match?.[2] ?? raw,
          raw,
        });
      }
    }
  };
  walk(projectDir);
  return entries;
}

export function readPluginDropText(
  projectDir: string,
  pluginName?: string,
): string {
  return readPluginDropEntries(projectDir, pluginName)
    .map((entry) => `${entry.raw}\n`)
    .join("");
}

function detectHarness(
  installRoot: string,
  targets: PluginTargetTable,
  requested?: string,
): { name: string; target: PluginTarget } {
  if (requested) {
    const target = targets[requested];
    if (!target) {
      throw new PluginTestUsageError(
        `unknown harness "${requested}" (available: ${Object.keys(targets).sort().join(", ")})`,
      );
    }
    if (!existsSync(join(installRoot, target.harnessLeaf))) {
      throw new PluginTestUsageError(
        `--harness ${requested} expects ${target.harnessLeaf}/ under ${installRoot}`,
      );
    }
    return { name: requested, target };
  }
  const candidates = Object.entries(targets).filter(([, target]) =>
    existsSync(join(installRoot, target.harnessLeaf)),
  );
  if (candidates.length === 0) {
    throw new PluginTestUsageError(
      `no known AIDLC harness tree found under ${installRoot}`,
    );
  }
  if (candidates.length > 1) {
    throw new PluginTestUsageError(
      `install is ambiguous (${candidates.map(([name, target]) => `${name}:${target.harnessLeaf}`).join(", ")}); pass --harness <name>`,
    );
  }
  return { name: candidates[0][0], target: candidates[0][1] };
}

function addTestError(
  result: PluginValidationResult,
  file: string,
  rule:
    | "test-install"
    | "test-compose"
    | "test-compose-drop"
    | "test-graph"
    | "test-idempotency"
    | "test-live-mutation",
  message: string,
  fix: string,
): void {
  const finding: PluginValidationFinding = {
    file,
    rule,
    message,
    fix,
  };
  result.valid = false;
  result.errors.push(finding);
}

function expectedPluginContent(pluginRoot: string): {
  stages: string[];
  scopes: string[];
} {
  return {
    stages: walkPluginFiles(join(pluginRoot, "stages"))
      .filter((path) => path.endsWith(".md"))
      .map((path) => basename(path, ".md"))
      .sort(),
    scopes: walkPluginFiles(join(pluginRoot, "scopes"))
      .filter((path) => path.endsWith(".md"))
      .map((path) => basename(path, ".md"))
      .sort(),
  };
}

function pluginName(pluginRoot: string): string {
  try {
    const manifest = JSON.parse(
      readFileSync(
        join(pluginRoot, ".aidlc-plugin", "plugin.json"),
        "utf-8",
      ),
    ) as { name?: unknown };
    if (typeof manifest.name === "string" && manifest.name.trim()) {
      return manifest.name.trim();
    }
  } catch {
    // Validation already reports malformed manifests.
  }
  return basename(pluginRoot);
}

function runGraphCompile(
  candidateRoot: string,
  target: PluginTarget,
): PluginComposeRunResult {
  const harnessRoot = join(candidateRoot, target.harnessLeaf);
  const dataRoot = join(harnessRoot, "tools", "data");
  const graph = join(
    harnessRoot,
    "tools",
    "aidlc-graph.ts",
  );
  const result = spawnSync(process.execPath, [graph, "compile"], {
    cwd: candidateRoot,
    encoding: "utf-8",
    env: {
      ...candidateProcessEnv(),
      AIDLC_PROJECT_DIR: candidateRoot,
      AIDLC_HARNESS_DIR: target.harnessLeaf,
      AIDLC_HARNESS_NAME: target.harnessName,
      AIDLC_STAGE_GRAPH: join(dataRoot, "stage-graph.json"),
      AIDLC_SCOPE_GRID: join(dataRoot, "scope-grid.json"),
      AIDLC_STAGES_DIR: join(harnessRoot, "aidlc-common", "stages"),
      AIDLC_SENSORS_DIR: join(harnessRoot, "sensors"),
      AIDLC_SCOPES_DIR: join(harnessRoot, "scopes"),
      AIDLC_AGENTS_DIR: join(harnessRoot, "agents"),
      AIDLC_RULES_DIR: join(
        candidateRoot,
        "aidlc",
        "spaces",
        "default",
        "memory",
      ),
    },
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function readGraphResult(
  candidateRoot: string,
  target: PluginTarget,
  expected: { stages: string[]; scopes: string[] },
  plugin: string,
): PluginGraphTestResult {
  const graphPath = join(
    candidateRoot,
    target.harnessLeaf,
    "tools",
    "data",
    "stage-graph.json",
  );
  const gridPath = join(
    candidateRoot,
    target.harnessLeaf,
    "tools",
    "data",
    "scope-grid.json",
  );
  const graph = JSON.parse(readFileSync(graphPath, "utf-8")) as Array<{
    slug?: unknown;
    plugin?: unknown;
  }>;
  const scopes = JSON.parse(
    readFileSync(gridPath, "utf-8"),
  ) as Record<string, unknown>;
  const stageSet = new Set(
    graph
      .filter((stage) => stage.plugin === plugin)
      .map((stage) => stage.slug)
      .filter((slug): slug is string => typeof slug === "string"),
  );
  const scopeSet = new Set(Object.keys(scopes));
  const presentStages = expected.stages.filter((slug) =>
    stageSet.has(slug),
  );
  const presentScopes = expected.scopes.filter((scope) =>
    scopeSet.has(scope),
  );
  return {
    compiled: true,
    expectedStages: expected.stages,
    presentStages,
    missingStages: expected.stages.filter(
      (slug) => !stageSet.has(slug),
    ),
    expectedScopes: expected.scopes,
    presentScopes,
    missingScopes: expected.scopes.filter(
      (scope) => !scopeSet.has(scope),
    ),
  };
}

export function testPluginComposition(
  options: TestPluginOptions,
): PluginTestResult {
  const pluginRoot = resolve(options.pluginRoot);
  const installRoot = resolve(options.installRoot);
  const validation = validatePluginRoot(pluginRoot);
  const logicalPluginName = pluginName(pluginRoot);
  const emptyGraph: PluginGraphTestResult = {
    compiled: false,
    expectedStages: [],
    presentStages: [],
    missingStages: [],
    expectedScopes: [],
    presentScopes: [],
    missingScopes: [],
  };
  if (!validation.valid) {
    return {
      ...validation,
      harness: options.harness ?? "",
      composedFiles: [],
      changedFiles: [],
      drops: [],
      graph: emptyGraph,
      idempotent: false,
    };
  }

  const targets = readPluginTargets(
    options.targetsPath ?? bundledPluginTargetsPath(),
  );
  const { name: harness, target } = detectHarness(
    installRoot,
    targets,
    options.harness,
  );
  const workRoot = mkdtempSync(
    join(tmpdir(), "aidlc-plugin-test-"),
  );
  const candidateRoot = join(workRoot, "candidate");
  const projectionRoot = join(workRoot, "projection");
  const liveBefore = snapshotPaths(installRoot, target.installRoots);
  let composedFiles: string[] = [];
  let changedFiles: string[] = [];
  let drops: PluginDropEntry[] = [];
  let graphResult = emptyGraph;
  let idempotent = false;

  try {
    mkdirSync(candidateRoot, { recursive: true });
    copyInstallRoots(installRoot, candidateRoot, target);
    if (!existsSync(join(candidateRoot, target.harnessLeaf))) {
      addTestError(
        validation,
        target.harnessLeaf,
        "test-install",
        `candidate is missing ${target.harnessLeaf}/`,
        "Pass an install root containing the selected harness tree.",
      );
    } else {
      buildPluginProjection({
        pluginRoot,
        target,
        outDir: projectionRoot,
        templateHooksDir:
          options.templateHooksDir ??
          bundledPluginHookTemplatesDir(),
      });
      const beforeCompose = snapshotWholeTree(candidateRoot);
      const first = runPluginCompose({
        harness,
        harnessLeaf: target.harnessLeaf,
        projectDir: candidateRoot,
        pluginBuilt: projectionRoot,
      });
      if (first.status !== 0) {
        addTestError(
          validation,
          "hooks/compose.ts",
          "test-compose",
          `compose exited ${first.status}: ${first.stderr || first.stdout}`,
          "Fix the compose failure and rerun the plugin test.",
        );
      }
      drops = readPluginDropEntries(
        candidateRoot,
        logicalPluginName,
      );
      for (const drop of drops) {
        addTestError(
          validation,
          drop.file,
          "test-compose-drop",
          `[${drop.severity}] ${drop.message}`,
          "Apply the remediation named by the compose drop and rerun.",
        );
      }

      const graphRun = runGraphCompile(candidateRoot, target);
      if (graphRun.status !== 0) {
        addTestError(
          validation,
          `${target.harnessLeaf}/tools/data/stage-graph.json`,
          "test-graph",
          `post-compose graph compile exited ${graphRun.status}: ${graphRun.stderr || graphRun.stdout}`,
          "Fix the plugin graph inputs and rerun.",
        );
      } else {
        graphResult = readGraphResult(
          candidateRoot,
          target,
          expectedPluginContent(pluginRoot),
          logicalPluginName,
        );
        if (
          graphResult.missingStages.length > 0 ||
          graphResult.missingScopes.length > 0
        ) {
          addTestError(
            validation,
            `${target.harnessLeaf}/tools/data`,
            "test-graph",
            `post-compose graph is missing stages [${graphResult.missingStages.join(", ")}] or scopes [${graphResult.missingScopes.join(", ")}]`,
            "Resolve compose drops and ensure every plugin stage/scope is installed.",
          );
        }
      }

      const afterFirst = snapshotWholeTree(candidateRoot);
      const firstDiff = snapshotDiff(beforeCompose, afterFirst);
      composedFiles = firstDiff.added;
      changedFiles = [
        ...firstDiff.changed,
        ...firstDiff.removed.map((file) => `removed:${file}`),
      ];

      const beforeSecond = snapshotWholeTree(candidateRoot);
      const second = runPluginCompose({
        harness,
        harnessLeaf: target.harnessLeaf,
        projectDir: candidateRoot,
        pluginBuilt: projectionRoot,
      });
      const secondDrops = readPluginDropEntries(
        candidateRoot,
        logicalPluginName,
      );
      const afterSecond = snapshotWholeTree(candidateRoot);
      const secondDiff = snapshotDiff(beforeSecond, afterSecond);
      idempotent =
        second.status === 0 &&
        secondDrops.length === 0 &&
        secondDiff.added.length === 0 &&
        secondDiff.changed.length === 0 &&
        secondDiff.removed.length === 0;
      if (!idempotent) {
        addTestError(
          validation,
          ".",
          "test-idempotency",
          `second compose changed files [${[
            ...secondDiff.added,
            ...secondDiff.changed,
            ...secondDiff.removed,
          ].join(", ")}], emitted ${secondDrops.length} drop(s), status ${second.status}`,
          "Make compose compare-before-write and self-clear resolved drops.",
        );
      }
    }
  } catch (error) {
    addTestError(
      validation,
      ".",
      "test-compose",
      error instanceof Error ? error.message : String(error),
      "Fix the plugin or install candidate inputs and rerun.",
    );
  } finally {
    const liveAfter = snapshotPaths(
      installRoot,
      target.installRoots,
    );
    const liveDiff = snapshotDiff(liveBefore, liveAfter);
    if (
      liveDiff.added.length > 0 ||
      liveDiff.changed.length > 0 ||
      liveDiff.removed.length > 0
    ) {
      addTestError(
        validation,
        ".",
        "test-live-mutation",
        `live install changed during test: ${[
          ...liveDiff.added,
          ...liveDiff.changed,
          ...liveDiff.removed,
        ].join(", ")}`,
        "Run composition only against the disposable candidate.",
      );
    }
    rmSync(workRoot, { recursive: true, force: true });
  }

  return {
    ...validation,
    harness,
    composedFiles,
    changedFiles,
    drops,
    graph: graphResult,
    idempotent,
  };
}

export function pluginTestJson(result: PluginTestResult): object {
  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    harness: result.harness,
    composedFiles: result.composedFiles,
    changedFiles: result.changedFiles,
    drops: result.drops,
    graph: result.graph,
    idempotent: result.idempotent,
  };
}

function formatPluginTest(
  pluginRoot: string,
  installRoot: string,
  result: PluginTestResult,
): string {
  if (!result.valid) {
    return (
      formatPluginValidation(pluginRoot, result).replace(
        "Plugin validation: INVALID",
        "Plugin test: FAILED",
      ) +
      `Install: ${installRoot}\nHarness: ${result.harness}\n`
    );
  }
  return [
    "Plugin test: CLEAN",
    `Plugin root: ${pluginRoot}`,
    `Install: ${installRoot}`,
    `Harness: ${result.harness}`,
    `Composed files (${result.composedFiles.length}): ${result.composedFiles.join(", ") || "none"}`,
    `Changed files (${result.changedFiles.length}): ${result.changedFiles.join(", ") || "none"}`,
    `Drops: ${result.drops.length}`,
    `Graph compiled: ${result.graph.compiled}`,
    `Plugin stages present: ${result.graph.presentStages.join(", ") || "none"}`,
    `Plugin scopes present: ${result.graph.presentScopes.join(", ") || "none"}`,
    `Idempotent second compose: ${result.idempotent}`,
    "",
  ].join("\n");
}

type ParsedArgs = {
  pluginRoot: string;
  installRoot: string;
  harness?: string;
  json: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.some((arg) => arg === "--dist" || arg.startsWith("--dist="))) {
    throw new PluginTestUsageError(
      "--dist is reserved until RFC #722 milestone 2 provides a released runtime-bundle channel",
    );
  }
  let pluginRoot = "";
  let installRoot = "";
  let harness: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") {
      if (json) throw new PluginTestUsageError("--json may be specified once");
      json = true;
      continue;
    }
    if (arg === "--install" || arg === "--harness") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new PluginTestUsageError(`${arg} requires a value`);
      }
      if (arg === "--install") installRoot = value;
      else harness = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new PluginTestUsageError(`unknown option "${arg}"`);
    }
    if (pluginRoot) {
      throw new PluginTestUsageError(
        `unexpected positional argument "${arg}"`,
      );
    }
    pluginRoot = arg;
  }
  if (!pluginRoot || !installRoot) {
    throw new PluginTestUsageError(
      "<plugin-root> and --install <project-root> are required",
    );
  }
  return {
    pluginRoot: resolve(pluginRoot),
    installRoot: resolve(installRoot),
    harness,
    json,
  };
}

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `${USAGE}\n\n--dist <version> is reserved until RFC #722 milestone 2.\n`,
    );
    return 0;
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `${USAGE}\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  try {
    const result = testPluginComposition({
      pluginRoot: args.pluginRoot,
      installRoot: args.installRoot,
      harness: args.harness,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(pluginTestJson(result))}\n`);
    } else {
      const output = formatPluginTest(
        args.pluginRoot,
        args.installRoot,
        result,
      );
      (result.valid ? process.stdout : process.stderr).write(output);
    }
    return result.valid ? 0 : 1;
  } catch (error) {
    if (error instanceof PluginTestUsageError) {
      process.stderr.write(`${USAGE}\n${error.message}\n`);
      return 2;
    }
    process.stderr.write(
      `Plugin test: FAILED\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
