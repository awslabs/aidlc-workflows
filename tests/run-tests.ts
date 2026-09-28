#!/usr/bin/env bun
// Native Bun/TypeScript test runner for the AI-DLC harness.
//
// tests/run-tests.sh remains as a POSIX compatibility wrapper. Keep behavior
// aligned with the old runner because smoke/t05 drives the public runner
// contract: flags, tier banners, START/DONE markers, summary fields, verbose
// log dirs, debug trace locations, and failed-file exit counts (capped at 255).

import { type spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  guardProfileDescription,
  parseRunnerArgs,
  preflightVerdict,
  RunnerArgsError,
  runnerFileTimeoutSeconds,
  runnerFailureExitCode,
  testGuardEnvironment,
  type ParsedArgs,
} from "./harness/runner-profile.ts";
import {
  deterministicCaseTimeoutMs,
  FILE_CLEANUP_ENV,
  FILE_DEADLINE_ENV,
  fileCleanupReserveMs,
  NATIVE_COMPILE_TIMEOUT_MS,
  NATIVE_OUTPUT_DRAIN_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
  TestBudgetExhaustedError,
} from "./harness/test-budget.ts";
import { buildMeta, renderMeta } from "./lib/bun-junit-to-meta.ts";
import {
  selectShard,
  type ShardConfig,
} from "./lib/test-sharding.ts";
import type { E2eWorker } from "./lib/e2e-workers.ts";
import { createE2eNativeRoot, createE2eTemporaryRoot } from "./lib/e2e-workers.ts";
import type { E2eCaseCounts } from "./lib/e2e-plan.ts";
import type { IsolatedProcess, IsolatedProcessRetirement } from "./lib/e2e-process.ts";
import type { E2eLimits, E2eTask } from "./lib/e2e-scheduler.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const BUN = process.execPath;
const DEFAULT_CASE_TIMEOUT_MS = deterministicCaseTimeoutMs();
const PACKAGE_READY_ENV = "AIDLC_TEST_PACKAGE_READY";
const PACKAGE_LOCK = join(REPO_ROOT, ".aidlc", "test-package.lock");
const UNIT_SHARD_CONFIG = join(SCRIPT_DIR, "unit-shard-weights.json");
const REQUIRE_COMPILED_COVERAGE_ENV = "AIDLC_REQUIRE_COMPILED_COVERAGE";

// Platform null device, used for the system config after the protected
// safe.directory entries have been copied into the suite's isolated config.
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const LIVE_MODEL_GATES = [
  "AIDLC_CLAUDE_SDK_LIVE",
  "AIDLC_TUI_LIVE",
  "AIDLC_KIRO_ACP_LIVE",
  "AIDLC_KIRO_TUI_LIVE",
  "AIDLC_CODEX_EXEC_LIVE",
  "AIDLC_COPILOT_EXEC_LIVE",
  "AIDLC_CURSOR_RUN_LIVE",
  "AIDLC_KIRO_IDE_LIVE",
  "AIDLC_OPENCODE_RUN_LIVE",
] as const;

type Level = "smoke" | "unit" | "integration" | "e2e";
type Status = "PASS" | "FAIL" | "SKIP";


interface ResultRow {
  name: string;
  status: Status;
  tests: number;
  skipped: number;
  failed: number;
  duration: string;
  reason?: string;
}

interface IsolatedFileContext {
  worker: E2eWorker;
  env: NodeJS.ProcessEnv;
  artifacts: string;
  force?: boolean;
  budget?: FileBudget;
  retirement?: IsolatedProcessRetirement;
}

interface FileBudget {
  deadlineMs: number;
  cleanupMs: number;
}

interface FileExecution {
  status: Status;
  cases: E2eCaseCounts;
  wallTimeMs: number;
  timedOut: boolean;
  throttlingSignals: number;
  cleanupError?: string;
  evidenceComplete?: boolean;
  evidenceError?: string;
  junitPath?: string;
}

function usage(): string {
  return `Usage: bash tests/run-tests.sh [LEVEL...] [PROFILE...] [OPTIONS]
       bun tests/run-tests.ts [LEVEL...] [PROFILE...] [OPTIONS]

LEVEL FLAGS (combinable, each selects exactly its level):
  --smoke         Structural validation (files exist, permissions, settings)
  --unit          Single-component isolation (hooks, frontmatter, knowledge)
  --integration   Cross-component contracts and live stage/CLI utilities
  --e2e           Full lifecycle, worktree, and rendered terminal journeys

PROFILE FLAGS (shortcuts -- map to test pyramid layers):
  (default)       smoke + unit + integration
  --ci            smoke + unit + integration
  --release       smoke + unit + integration + e2e
  --all           Same as --release

OUTPUT MODIFIERS (combinable with any tier/profile):
  --production-guards
                  Run selected tests with guard bypasses and direct authority
                  off (default: fixture). Neutralizes inherited off-switches.
  --verbose       Write per-test logs to tests/logs/
  --no-llm        Force all live-model gates closed while deterministic
                  integration/e2e tests still run. Also via AIDLC_NO_LLM=1.
  --require-coverage  Fail if selected coverage is skipped, empty, or incomplete.
                  Writes coverage.json; use for required nightly test gates.
  --matrix-plan FILE  Bind this run to a source/cohort coverage plan.
  --matrix-job ID     Required job in that plan. Implies --require-coverage.
  --debug         Implies --verbose; streams per-test output and writes SDK/TUI
                  driver traces to tests/logs/
  --filter PAT    Only run tests whose filename matches extended regex PAT
                  Fails if a selected file executes no cases or no files match.
  --parallel N    Run up to N test files concurrently within a tier (alias: -P N).
                  Default: 1 (serial). Smoke and unit tiers always run serially.
                  Recommended range: 1-8. See docs/reference/09-testing.md.
  --shard N/M     Run one deterministic, duration-balanced unit-test shard.
                  Requires --unit with no other level or profile flags.
  --file-timeout N  Independent per-file work ceiling in seconds for every tier.
                  Default: 7200 outside isolated e2e; caps its existing deadline.
  --run-timeout N   Shared work ceiling in seconds, including setup and all files.
                  Remaining work is bounded before each dispatch; cleanup is reserved.
  --isolated-e2e  Dispatch e2e files across -P isolated checkout workers.
                  Known serial driver families may overlap; assertions are unchanged.
  --e2e-plan      Print the isolated e2e inventory/resource plan; run no tests or builds.
                  Requires --e2e; implies --isolated-e2e, not --e2e.
  --bedrock-parallel N  Maximum simultaneous Bedrock test files (default: 2).
  --kiro-parallel N     Maximum simultaneous Kiro test files (default: 2).
  --ide-parallel N      Maximum simultaneous Kiro IDE files (default: 1).
  --e2e-file-timeout N  Isolated worker file deadline, seconds (default: 10800).
  --e2e-timings FILE    Prior summary.txt used for longest-first scheduling.
  --e2e-cancel-file FILE  Create this file to request portable worker cancellation.
                  These options require --e2e --isolated-e2e or --e2e --e2e-plan.

  -h, --help      Show this help and exit

EXAMPLES:
  bash tests/run-tests.sh                        # Default levels
  bun tests/run-tests.ts                         # Native Bun entrypoint
  bash tests/run-tests.sh --ci                   # CI profile
  bash tests/run-tests.sh --release              # All levels (hours)
  bash tests/run-tests.sh --integration --debug  # Integration with traces
  bash tests/run-tests.sh --smoke --e2e          # Specific levels
  bash tests/run-tests.sh --all --debug          # Everything with traces
  bash tests/run-tests.sh --integration --filter "t25|t26" --debug
  bash tests/run-tests.sh --all --parallel 4     # 4-way parallel for larger levels
  bash tests/run-tests.sh --unit --shard 1/4    # CI-style isolated unit shard
  bash tests/run-tests.sh --debug -P 8 --unit --production-guards --filter "t-runner-production-guards"
`;
}

function parseArgs(argv: string[]): ParsedArgs {
  try {
    const out = parseRunnerArgs(argv);
    if (out.help) {
      process.stdout.write(usage());
      process.exit(0);
    }
    return out;
  } catch (error) {
    if (!(error instanceof RunnerArgsError)) throw error;
    process.stderr.write(`${error.message}\n${error.showUsage ? `\n${usage()}` : ""}`);
    process.exit(error.exitCode);
  }

}

const args = parseArgs(process.argv.slice(2));
const RUN_DEADLINE_MS = args.runTimeout === null
  ? undefined
  : Date.now() + args.runTimeout * 1000;
const RUN_WORK_DEADLINE_MS = RUN_DEADLINE_MS === undefined
  ? undefined
  : RUN_DEADLINE_MS - fileCleanupReserveMs(args.runTimeout! * 1000);

function matchesE2eFilter(file: string, filter: RegExp | null): boolean {
  const base = basename(file);
  return !filter || filter.test(base) || filter.test(legacyResultName(file)) || filter.test(qualifiedResultName(file));
}

function legacyResultName(file: string): string {
  const plugin = file.replaceAll("\\", "/").match(/\/plugins\/([^/]+)\/tests\//);
  const name = basename(file, ".test.ts");
  return plugin ? `plugin-${plugin[1]}-${name}` : name;
}

function qualifiedResultName(file: string): string {
  const tier = relative(SCRIPT_DIR, file).replaceAll("\\", "/").split("/")[0];
  return `${tier === ".." ? "plugins" : tier}-${legacyResultName(file)}`;
}

function requestedTestFiles(): string[] {
  const filter = args.filter ? new RegExp(args.filter) : null;
  const levels: Level[] = [
      ...(args.runSmoke ? ["smoke" as const] : []),
      ...(args.runUnit ? ["unit" as const] : []),
      ...(args.runIntegration ? ["integration" as const] : []),
      ...(args.runE2e ? ["e2e" as const] : []),
  ];
  return levels.flatMap((level) => levelFiles(level))
    .filter((path) => matchesE2eFilter(path, filter));
}

let requestedFilesAtStart: string[] | undefined;
let effectiveTestFiles: string[] | undefined;
const requiredPrerequisites = new Set<string>();
const requiredTuiFiles = new Set<string>();
let resultNames: Map<string, string> | undefined;
function resultName(file: string): string {
  if (!resultNames) {
    const files = new Set(effectiveTestFiles ?? requestedTestFiles());
    const counts = new Map<string, number>();
    for (const path of files) counts.set(legacyResultName(path), (counts.get(legacyResultName(path)) ?? 0) + 1);
    resultNames = new Map([...files].map((path) => [
      path, counts.get(legacyResultName(path))! > 1 ? qualifiedResultName(path) : legacyResultName(path),
    ]));
  }
  return resultNames.get(file) ?? legacyResultName(file);
}

/** Full-profile summaries qualify collisions; historical basename summaries remain valid. */
function e2eTimingAliases(weights: Record<string, number>): Record<string, number> {
  const result = { ...weights };
  for (const [name, seconds] of Object.entries(weights)) {
    if (name.startsWith("e2e-")) result[name.slice(4)] = seconds;
  }
  return result;
}

function e2eLimits(tasks: readonly E2eTask[]): E2eLimits {
  // Preflight uses worker 1 before the queue and cannot increase queue width.
  const queued = tasks.filter((task) => basename(task.file) !== "t-tui-preflight.serial.test.ts");
  const limits: E2eLimits = {
    workers: Math.max(1, Math.min(args.parallel, queued.length)),
    bedrock: args.bedrockParallel, kiro: args.kiroParallel, ide: args.ideParallel,
  };
  for (const resource of queued[0]?.resources ?? []) {
    if (queued.every((task) => task.resources.includes(resource))) {
      limits.workers = Math.min(limits.workers, limits[resource]);
    }
  }
  if (queued[0]?.serialGroup &&
    queued.every((task) => task.serialGroup === queued[0].serialGroup)) {
    limits.workers = 1;
  }
  return limits;
}

if (args.e2ePlan) {
  try {
    const { planE2eFile, readE2eTimings } = await import("./lib/e2e-plan.ts");
    const filter = args.filter ? new RegExp(args.filter) : null;
    const weights = args.e2eTimings ? e2eTimingAliases(readE2eTimings(readFileSync(args.e2eTimings, "utf8"))) : {};
    const files = levelFiles("e2e").filter((file) => matchesE2eFilter(file, filter));
    if (files.length === 0) throw new Error("e2e selection contains no test files");
    const tasks = files.map((file) => planE2eFile(file, weights));
    const limits = e2eLimits(tasks);
    process.stdout.write(`${JSON.stringify({
      workers: limits.workers,
      limits: { bedrock: limits.bedrock, kiro: limits.kiro, ide: limits.ide },
      files: tasks.map((task) => ({
        ...task, file: relative(REPO_ROOT, task.file).replaceAll("\\", "/"),
      })),
    }, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

function prepareGeneratedTrees(): void {
  if (process.env[PACKAGE_READY_ENV] === "1") return;
  mkdirSync(dirname(PACKAGE_LOCK), { recursive: true });
  const deadline = Date.now() + NATIVE_COMPILE_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      mkdirSync(PACKAGE_LOCK);
      acquired = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      if (Date.now() >= deadline) {
        process.stderr.write(
          `ERROR: timed out waiting for projection regeneration lock ${PACKAGE_LOCK}\n`,
        );
        process.exit(2);
      }
      Bun.sleepSync(100);
    }
  }
  let generationFailed = false;
  try {
    const generated = spawnSync(BUN, [join(REPO_ROOT, "scripts", "package.ts")], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
      timeout: NATIVE_COMPILE_TIMEOUT_MS,
    });
    if (generated.status !== 0) {
      process.stderr.write("ERROR: failed to regenerate generated projections\n");
      process.stderr.write(generated.stdout ?? "");
      process.stderr.write(generated.stderr ?? "");
      generationFailed = true;
    } else {
      process.env[PACKAGE_READY_ENV] = "1";
    }
  } finally {
    rmSync(PACKAGE_LOCK, { recursive: true, force: true });
  }
  // process.exit inside try would skip finally and strand the package lock.
  if (generationFailed) process.exit(2);
}

prepareGeneratedTrees();

let filterRegex: RegExp | null = null;
if (args.filter) {
  try {
    filterRegex = new RegExp(args.filter);
  } catch (err) {
    process.stderr.write(`ERROR: --filter must be a valid JavaScript regex: ${err}\n`);
    process.exit(2);
  }
}

function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

function commandExists(cmd: string): boolean {
  const r = spawnSync(cmd, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    env: process.env,
  });
  return r.status === 0;
}

function prependPath(dir: string): void {
  const current = process.env.PATH ?? "";
  process.env.PATH = current ? `${dir}${delimiter}${current}` : dir;
}

const homeBun = join(homedir(), ".bun", "bin");
if (existsSync(homeBun)) prependPath(homeBun);

const needsLlm = args.runIntegration || args.runE2e;

const projectSettings = join(SCRIPT_DIR, "..", ".claude", "settings.json");
if (existsSync(projectSettings)) {
  try {
    const parsed = JSON.parse(readFileSync(projectSettings, "utf8")) as {
      env?: Record<string, unknown>;
    };
    for (const [key, value] of Object.entries(parsed.env ?? {})) {
      if (typeof value === "string") process.env[key] = value;
    }
  } catch (err) {
    process.stderr.write(`WARNING: could not parse ${projectSettings}: ${err}\n`);
  }
}

let logDir = "";
let cleanupLogDir = false;
if (args.verbose) {
  // The stamp has 1-second resolution, so two concurrent runners (e.g. a
  // sliced gate next to a smoke run whose t05 spawns child runners) can land
  // on the same second. Sharing a dir is not benign: both write and MUTUALLY
  // DELETE _results/*.meta, and one runner's cleanup can rip the dir out from
  // under the other mid-run. The pid suffix makes the dir per-process; the
  // non-recursive mkdir below turns any residual collision into a loud error
  // instead of a silent share.
  logDir = join(SCRIPT_DIR, "logs", `${utcStamp()}-p${process.pid}`);
  mkdirSync(join(SCRIPT_DIR, "logs"), { recursive: true });
  mkdirSync(logDir);
  process.env.AIDLC_TEST_VERBOSE = "true";
  process.env.AIDLC_TEST_LOG_DIR = logDir;
  process.stdout.write(`Verbose mode: logging to ${logDir}\n`);
} else {
  logDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-run-tests."));
  cleanupLogDir = true;
}

const resultsDir = join(logDir, "_results");
mkdirSync(resultsDir, { recursive: true });

if (args.noLlm) {
  for (const gate of LIVE_MODEL_GATES) process.env[gate] = "0";
}

if (args.debug) {
  process.env.AIDLC_TEST_DEBUG = "true";
  process.stdout.write(`Debug driver traces: ${logDir}/{sdk,tui,kiro-acp}-drive-*.ndjson\n`);
}

if (args.fullProfile && args.debug) {
  if (process.env.AIDLC_TUI_LIVE === undefined) {
    process.env.AIDLC_TUI_LIVE = "1";
    process.stdout.write(
      "Live TUI coverage: AIDLC_TUI_LIVE=1 (defaulted by --all/--release --debug; set AIDLC_TUI_LIVE=0 to keep live TUI skips)\n",
    );
  } else {
    process.stdout.write(
      `Live TUI coverage: AIDLC_TUI_LIVE=${process.env.AIDLC_TUI_LIVE} (explicit; --all/--release --debug did not override it)\n`,
    );
  }
}

let claudeGateOpen = true;
if (needsLlm && args.noLlm) {
  // --no-llm (or AIDLC_NO_LLM=1) closes the derived Claude gate and every
  // independent live-model opt-in, even when CLIs and inherited live variables
  // are present. Deterministic tests in those tiers still run.
  process.stdout.write(
    "--no-llm: forcing all live-model gates closed; deterministic tests still run\n",
  );
  claudeGateOpen = false;
} else if (needsLlm && !commandExists("claude")) {
  process.stdout.write("WARNING: claude CLI not found -- live integration/e2e tests may fail or skip\n");
  claudeGateOpen = false;
}

let claudeRequiredFiles = new Set<string>();
if (needsLlm) {
  const gate = spawnSync(BUN, [join(SCRIPT_DIR, "harness", "claude-gate.ts")], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
  });
  if (gate.status !== 0) {
    process.stderr.write("ERROR: failed to derive Claude-dependent test files\n");
    process.stderr.write(gate.stderr ?? "");
    process.exit(2);
  }
  claudeRequiredFiles = new Set(
    (gate.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/\\/g, "/"))
      .filter(Boolean),
  );
}

if (needsLlm && !commandExists("timeout")) {
  process.stdout.write("WARNING: timeout (GNU coreutils) not found -- live compatibility tests may fail\n");
  process.stdout.write("  Linux:  sudo yum install coreutils   # or apt-get install coreutils\n");
  process.stdout.write("  macOS:  brew install coreutils && add gnubin to PATH (see docs/reference/11-contributing.md)\n");
}

let totalFiles = 0;
let failedFiles = 0;
let totalTests = 0;
let totalFailed = 0;
const resultRows: ResultRow[] = [];
const fileExecutions = new Map<string, FileExecution>();
let isolatedRunError = false;
let isolatedInterrupted = false;
const isolatedAbort = new AbortController();
let captureFailure: Error | undefined;
let runnerFailure: string | undefined;
type MatrixModule = typeof import("./lib/test-matrix.ts");
type MatrixContext = ReturnType<MatrixModule["loadTestMatrixJob"]>;
type MatrixRuntime = Parameters<MatrixModule["validateMatrixSelection"]>[2];
let matrixModule: MatrixModule | undefined;
let matrixContext: MatrixContext | undefined;
let matrixRuntime: MatrixRuntime | undefined;
let matrixReceiptWritten = false;

function coverageReport() {
  const requested = new Set(requestedFilesAtStart ?? requestedTestFiles());
  const selected = effectiveTestFiles ?? [...requested];
  const files = selected.map((file) => {
    const execution = fileExecutions.get(resultName(file));
    return {
      file: relative(REPO_ROOT, file).replaceAll("\\", "/"),
      requested: requested.has(file),
      prerequisite: requiredPrerequisites.has(file),
      state: execution?.status ?? "INCOMPLETE",
      cases: execution?.cases ?? null,
      evidenceError: execution?.evidenceError,
      complete: !!execution && execution.evidenceComplete === true &&
        execution.cases.total > 0 && execution.cases.skipped === 0 &&
        !execution.cleanupError && !execution.timedOut,
    };
  });
  return {
    required: args.requireCoverage,
    complete: files.length > 0 && !isolatedRunError && files.every((file) => file.complete),
    requestedFiles: requested.size,
    selectedFiles: files.length,
    recordedFiles: files.filter((file) => file.cases !== null).length,
    files,
  };
}

function runFailed(): boolean {
  return failedFiles > 0 || selectionErrors.length > 0 || isolatedRunError || (args.requireCoverage && !coverageReport().complete);
}
const selectionErrors: string[] = [];

function testsRel(file: string): string {
  return `tests/${relative(SCRIPT_DIR, file).replace(/\\/g, "/")}`;
}

function isClaudeRequiredFile(file: string): boolean {
  return claudeRequiredFiles.has(testsRel(file));
}

function shouldSkipForClaude(file: string): boolean {
  return !claudeGateOpen && isClaudeRequiredFile(file);
}

function writeMeta(name: string, meta: ResultRow): void {
  const status = meta.status;
  const rc = status === "FAIL" ? 1 : 0;
  const content =
    status === "SKIP"
      ? [
          `NAME=${name}`,
          "STATUS=SKIP",
          `TESTS=${meta.tests}`,
          "FAILED=0",
          `DURATION=${meta.duration}`,
          "RC=0",
          "",
        ].join("\n")
      : renderMeta({
          name,
          status,
          tests: meta.tests,
          failed: meta.failed,
          duration: meta.duration,
          rc,
        });
  writeFileSync(
    join(resultsDir, `${name}.meta`),
    `${content}SKIPPED=${meta.skipped}\nREASON=${meta.reason ?? ""}\n`,
    "utf8",
  );
}

function parseMeta(file: string): ResultRow {
  const row: ResultRow = {
    name: "",
    status: "PASS",
    tests: 0,
    skipped: 0,
    failed: 0,
    duration: "0",
  };
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "NAME") row.name = value;
    else if (key === "STATUS" && (value === "PASS" || value === "FAIL" || value === "SKIP")) {
      row.status = value;
    } else if (key === "TESTS") row.tests = Number(value) || 0;
    else if (key === "SKIPPED") row.skipped = Number(value) || 0;
    else if (key === "FAILED") row.failed = Number(value) || 0;
    else if (key === "DURATION") row.duration = value || "0";
    else if (key === "REASON" && value) row.reason = value;
  }
  return row;
}

function aggregateTierResults(): void {
  const metas = readdirSync(resultsDir)
    .filter((f) => f.endsWith(".meta"))
    .sort()
    .map((f) => join(resultsDir, f));
  for (const meta of metas) {
    const row = parseMeta(meta);
    totalFiles += 1;
    totalTests += row.tests;
    totalFailed += row.failed;
    if (row.status === "FAIL") failedFiles += 1;
    resultRows.push(row);
  }
  for (const meta of metas) rmSync(meta, { force: true });
}

let stdoutLock: Promise<void> = Promise.resolve();

async function withStdoutLock(fn: () => void): Promise<void> {
  const prev = stdoutLock;
  let release!: () => void;
  stdoutLock = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  await prev;
  try {
    fn();
  } finally {
    release();
  }
}

function tmpFile(prefix: string): string {
  return join(process.env.TMPDIR || tmpdir(), `${prefix}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
}

function displayLogDirPath(path: string): string {
  const rel = relative(SCRIPT_DIR, path);
  return rel.startsWith("..") ? path : rel.replace(/\\/g, "/");
}

function protectedGitConfigValues(scope: "--system" | "--global", key: string): string[] {
  const result = spawnSync("git", ["config", "--null", scope, "--get-all", key], {
    // Preserve gitdir-conditional protected includes for this checkout.
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    process.stderr.write(
      `WARNING: could not read git ${scope.slice(2)} ${key}: ${result.stderr ?? ""}`,
    );
    return [];
  }
  const values = (result.stdout ?? "").split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

function commandGitConfigValues(key: string): string[] {
  const result = spawnSync("git", ["config", "--null", "--show-scope", "--get-all", key], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: NULL_DEVICE,
      GIT_CONFIG_SYSTEM: NULL_DEVICE,
    },
    encoding: "utf8",
  });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    process.stderr.write(
      `WARNING: could not read git command ${key}: ${result.stderr ?? ""}`,
    );
    return [];
  }

  const fields = (result.stdout ?? "").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const values: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === "command") values.push(fields[i + 1]);
  }
  return values;
}

function createIsolatedGitConfig(): string {
  if (!commandExists("git")) return NULL_DEVICE;

  const configPath = join(logDir, `.gitconfig-aidlc-tests-${process.pid}`);
  writeFileSync(configPath, "", { encoding: "utf8", mode: 0o600 });
  const entries: Array<[string, string]> = [
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ];
  // Isolated fixtures intentionally use deep worktree paths. Preserve Windows
  // Git's long-path support without reading or changing the user's global config.
  if (process.platform === "win32") entries.push(["core.longpaths", "true"]);
  for (const safeDirectory of [
    ...protectedGitConfigValues("--system", "safe.directory"),
    ...protectedGitConfigValues("--global", "safe.directory"),
    ...commandGitConfigValues("safe.directory"),
  ]) {
    entries.push(["safe.directory", safeDirectory]);
  }

  for (const [key, value] of entries) {
    // Git for Windows applies MSYS path conversion to argv values that look
    // POSIX-rooted. Disable it only while copying safe.directory verbatim.
    const env =
      key === "safe.directory"
        ? { ...process.env, MSYS2_ARG_CONV_EXCL: "*" }
        : process.env;
    const result = spawnSync("git", ["config", "--file", configPath, "--add", key, value], {
      cwd: tmpdir(),
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stderr.write(
        `ERROR: could not create isolated git config (${key}): ${result.stderr ?? ""}`,
      );
      process.exit(2);
    }
  }
  return configPath;
}

const isolatedGitConfig = createIsolatedGitConfig();

function allocateFileBudget(env: NodeJS.ProcessEnv, isolated: boolean): FileBudget {
  const startedMs = Date.now();
  const allowanceMs = remainingOperationTimeoutMs(
    runnerFileTimeoutSeconds(args, isolated) * 1000,
    { deadlineMs: RUN_DEADLINE_MS, env, nowMs: startedMs, phase: "test file" },
  )!;
  const deadlineMs = startedMs + allowanceMs;
  return {
    deadlineMs,
    // A later file cannot spend the run's reserved cleanup tail as new work.
    cleanupMs: Math.max(
      fileCleanupReserveMs(allowanceMs),
      RUN_WORK_DEADLINE_MS === undefined ? 0 : deadlineMs - RUN_WORK_DEADLINE_MS,
    ),
  };
}

function requireFileWorkBudget(budget: FileBudget): void {
  // The file's reserve was already assigned once. Do not interpret its own
  // environment as a new parent and subtract another reserve at spawn time.
  remainingOperationTimeoutMs(undefined, {
    deadlineMs: budget.deadlineMs, reserveMs: budget.cleanupMs,
    env: {}, phase: "test file launch",
  });
}

async function runSpawnCapture(
  cmd: string,
  cmdArgs: string[],
  env: NodeJS.ProcessEnv,
  debugPrefix: string | null,
  context?: IsolatedFileContext,
  streamPath?: string,
): Promise<{ rc: number; output: string; timedOut: boolean; cleanupError?: string }> {
  let budget: FileBudget;
  try {
    budget = context?.budget ?? allocateFileBudget(env, context !== undefined);
    requireFileWorkBudget(budget);
  } catch (error) {
    const output = `error: ${String(error)}\n`;
    if (streamPath) appendFileSync(streamPath, output);
    const timedOut = error instanceof TestBudgetExhaustedError;
    return { rc: timedOut ? 124 : 2, output, timedOut };
  }
  const { deadlineMs, cleanupMs } = budget;
  const allowanceMs = deadlineMs - Date.now();
  env = {
    ...env,
    [FILE_DEADLINE_ENV]: String(deadlineMs),
    [FILE_CLEANUP_ENV]: String(cleanupMs),
  };
  const budgetDiagnostic = `Test budget: ${JSON.stringify({
    caseDefaultMs: DEFAULT_CASE_TIMEOUT_MS,
    fileAllowanceMs: allowanceMs,
    fileDeadlineMs: deadlineMs,
    cleanupReserveMs: cleanupMs,
    runDeadlineMs: RUN_DEADLINE_MS ?? null,
  })}\n`;
  if (streamPath) appendFileSync(streamPath, budgetDiagnostic);
  if (debugPrefix !== null) process.stdout.write(`${debugPrefix}${budgetDiagnostic}`);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  isolatedAbort.signal.addEventListener("abort", cancel, { once: true });
  if (isolatedAbort.signal.aborted) cancel();
  let timedOut = false;
  const workDeadlineMs = deadlineMs - cleanupMs;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(0, workDeadlineMs - Date.now()));
  const chunks: Buffer[] = [Buffer.from(budgetDiagnostic)];
  const failures: string[] = [];
  let lineBuf = "";
  let supervised: IsolatedProcess | undefined;
  let spawnAttempted = false;
  let transport: { worker: E2eWorker; env: NodeJS.ProcessEnv } | undefined = context;
  let child: ReturnType<typeof spawn>;
  try {
    {
      const cwd = context?.worker.root ?? REPO_ROOT;
      const artifacts = context?.artifacts ?? join(logDir, "processes", resultName(cmdArgs[1]));
      mkdirSync(artifacts, { recursive: true });
      if (!context) {
        const temp = await createE2eTemporaryRoot();
        const socket = `aidlc-file-${process.pid}-${resultName(cmdArgs[1])}`;
        env = {
          ...env,
          AIDLC_TEST_WORKER_ROOT: artifacts,
          AIDLC_TUI_BUN_ROOT: createE2eNativeRoot(artifacts),
          AIDLC_TUI_TMUX_SOCKET: socket,
          TEMP: temp, TMP: temp, TMPDIR: temp,
        };
        transport = { worker: { id: 0, root: cwd, socket }, env };
      }
      const supervisorPath = join(cwd, "tests", "lib", "e2e-process.ts");
      // Both the coordinator-side helper and its child entry point must use
      // the snapshot, even if authored source changes while a file is queued.
      const { startIsolatedProcess }: typeof import("./lib/e2e-process.ts") =
        await import(pathToFileURL(supervisorPath).href);
      requireFileWorkBudget(budget);
      spawnAttempted = true;
      supervised = await startIsolatedProcess({
        command: [cmd, ...cmdArgs], cwd, env,
        artifacts, signal: controller.signal,
      });
      child = supervised.child;
    }
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    isolatedAbort.signal.removeEventListener("abort", cancel);
    timedOut ||= error instanceof TestBudgetExhaustedError;
    let output = String(error);
    let cleanupError: string | undefined = spawnAttempted
      ? "startup did not return a confirmed process handle; retain fixtures for inspection"
      : undefined;
    if (!context && transport && !spawnAttempted) {
      try {
        const { cleanupE2eTransports, finishE2eTemporaryFiles } = await import("./lib/e2e-workers.ts");
        await cleanupE2eTransports(transport.worker, transport.env);
        await finishE2eTemporaryFiles(transport.env, transport.env.AIDLC_TEST_WORKER_ROOT!, true);
      } catch (cleanup) {
        cleanupError = String(cleanup);
        output += `\nerror: setup retirement failed: ${cleanupError}\n`;
      }
    }
    if (streamPath) appendFileSync(streamPath, output);
    return { rc: timedOut ? 124 : 127, output, timedOut, cleanupError };
  }
  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    if (streamPath && !captureFailure) {
      try {
        appendFileSync(streamPath, chunk);
      } catch (error) {
        // Throwing from a data callback can strand the runner's pending close
        // promise (observed with ENOSPC on Windows). Retire every owned process
        // and stop dispatch instead of spinning or reporting uncaptured output.
        captureFailure = new Error(`test output capture failed at ${streamPath}: ${String(error)}`);
        failures.push(captureFailure.message);
        isolatedRunError = true;
        isolatedAbort.abort();
      }
    }
    if (debugPrefix === null) return;
    lineBuf += chunk.toString();
    const lines = lineBuf.split(/\n/);
    lineBuf = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${debugPrefix}${line}\n`);
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  let closed = false;
  const closing = new Promise<number>((done) => {
    child.on("error", (error) => { chunks.push(Buffer.from(String(error))); done(127); });
    child.on("close", (code, signal) => { closed = true; done(code ?? (signal ? 128 : 1)); });
  });
  let rc = 1;
  let retirement: IsolatedProcessRetirement | undefined;
  try {
    rc = await (supervised?.exited ?? closing);
  } catch (error) {
    failures.push(String(error));
  }
  timedOut ||= supervised?.workTimedOut === true;
  if (timeout) clearTimeout(timeout);
  if (supervised) {
    // Retire file-owned native namespaces even on ordinary Linux runs, where
    // terminal daemons intentionally live outside the test's process group.
    // On Windows, publish retirement before terminating the owning job.
    if (transport) {
      try {
        const { cleanupE2eTransports } = await import("./lib/e2e-workers.ts");
        await cleanupE2eTransports(transport.worker, transport.env);
      } catch (error) { failures.push(String(error)); }
    }
    try {
      retirement = await supervised.retire();
      if (context) context.retirement = retirement;
    } catch (error) { failures.push(String(error)); }
    if (!closed) {
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closing,
          new Promise<never>((_done, reject) => {
            drainTimer = setTimeout(() => reject(new Error("isolated worker output did not close after tree retirement")),
              remainingCleanupTimeoutMs(NATIVE_OUTPUT_DRAIN_TIMEOUT_MS, { deadlineMs, env }));
          }),
        ]);
      } catch (error) {
        failures.push(String(error));
        child.stdout!.destroy();
        child.stderr!.destroy();
      } finally { if (drainTimer) clearTimeout(drainTimer); }
    }
  }
  isolatedAbort.signal.removeEventListener("abort", cancel);
  if (!context && transport && failures.length === 0) {
    try {
      const { finishE2eTemporaryFiles } = await import("./lib/e2e-workers.ts");
      await finishE2eTemporaryFiles(
        transport.env, transport.env.AIDLC_TEST_WORKER_ROOT!,
        rc !== 0 || !!captureFailure || process.env.AIDLC_KEEP_TEMP === "1",
        retirement,
      );
    } catch (error) { failures.push(String(error)); }
  }
  if (debugPrefix !== null && lineBuf) process.stdout.write(`${debugPrefix}${lineBuf}`);
  const cleanupError = failures.length ? failures.join("\n") : undefined;
  if (cleanupError) {
    rc = 1;
    chunks.push(Buffer.from(`\nerror: ${cleanupError}\n`));
  }
  return { rc: timedOut ? 124 : rc, output: Buffer.concat(chunks).toString("utf8"), timedOut, cleanupError };
}

function writeTestLog(file: string, row: ResultRow, rc: number, body: string): void {
  if (!args.verbose || captureFailure) return;
  writeFileSync(
    join(logDir, `${row.name}.log`),
    [
      `Test: ${basename(file)}`,
      `File: ${file}`,
      `Status: ${row.status}`,
      guardProfileDescription(args.guardProfile),
      `Exit code: ${rc}`,
      `Executed test cases: ${row.tests - row.skipped}`,
      `Skipped test cases: ${row.skipped}`,
      `Timestamp: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
      "",
      "--- Output ---",
      body,
    ].join("\n"),
    "utf8",
  );
}

async function runBunTestFile(
  file: string, parallelMode = false, context?: IsolatedFileContext, force = false,
): Promise<FileExecution | undefined> {
  if (captureFailure) throw captureFailure;
  const base = basename(file);
  // Preserve single-tier collector names; qualify only collisions among the
  // selected files (including an implicit integration preflight).
  const name = resultName(file);

  // Match the filter against BOTH the basename and the qualified name shown in
  // output/summary — a user who copies the displayed `plugin-<plugin>-<stem>`
  // name into --filter would otherwise select nothing and see a green run (round-5).
  if (!force && !context?.force && !matchesE2eFilter(file, filterRegex)) return;

  if (shouldSkipForClaude(file)) {
    // --no-llm deliberately excludes these files, even from a mixed filter.
    // Missing prerequisites alone cannot satisfy an explicitly requested gate.
    const required = filterRegex !== null && !args.noLlm;
    const row: ResultRow = {
      name, status: required ? "FAIL" : "SKIP",
      tests: 0, skipped: 0, failed: 0, duration: "0",
      reason: required
        ? "Explicitly selected live coverage did not run: Claude substrate unavailable. Install/authenticate Claude and rerun."
        : "Claude substrate unavailable; derived live mechanism",
    };
    const body = `${required ? "error: " : ""}${row.reason}\n`;
    process.stdout.write(`\n=== ${row.status} ${base} ===\n${body}`);
    process.stdout.write(`--- ${row.status}: ${base} ---\n`);
    process.stdout.write(`=== DONE ${base} (${row.status}) ===\n`);
    writeMeta(name, row);
    writeTestLog(file, row, required ? 1 : 0, body);
    const execution: FileExecution = {
      status: row.status, cases: { total: 0, passed: 0, failed: 0, skipped: 0 },
      wallTimeMs: 0, timedOut: false, throttlingSignals: 0,
    };
    fileExecutions.set(name, execution);
    return execution;
  }

  // Fixture defaults allow synthetic transitions and authority-bearing audit
  // appends. Production mode applies after shell/project-settings inheritance,
  // before the test child starts. Tests still own their environment afterwards.
  //
  // Isolate git for the whole suite. The generated global config carries forward
  // protected safe.directory entries needed by mounted/foreign-owned CI
  // workspaces, but excludes developer settings and explicitly disables commit
  // and tag signing. Fixtures pass their own identity per commit.
  //
  // Isolate Claude Code's enterprise managed settings too. Doctor subprocesses
  // inherit this absent, runner-owned path, so a policy on the developer or CI
  // host cannot change unrelated test results. Focused managed-policy tests
  // override the path with their own fixture.
  const env: NodeJS.ProcessEnv = {
    ...testGuardEnvironment({ ...process.env, ...context?.env }, args.guardProfile),
    AIDLC_TEST_NAME: base,
    // Survives each file's private TMPDIR, but never crosses runner invocations.
    AIDLC_TEST_COMPILED_DIR: join(logDir, "compiled"),
    AIDLC_MANAGED_SETTINGS_PATH: join(logDir, ".aidlc-managed-settings-absent.json"),
  };
  // Command-scope config outranks the isolated global file. Preserve its safety
  // entries above, then remove all command-scope injection before spawning tests.
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper === "GIT_CONFIG" ||
      upper === "GIT_CONFIG_COUNT" ||
      upper === "GIT_CONFIG_PARAMETERS" ||
      /^GIT_CONFIG_(KEY|VALUE)_[0-9]+$/.test(upper)
    ) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_GLOBAL = isolatedGitConfig;
  env.GIT_CONFIG_SYSTEM = NULL_DEVICE;
  process.stdout.write(`\n=== START ${base} ===\n`);

  const junitXml = context
    ? join(context.artifacts, "junit.xml")
    : args.verbose ? join(logDir, `${name}.junit.xml`) : tmpFile("aidlc-run-tests-junit");
  const start = Date.now();
  const debugPrefix = args.debug && parallelMode ? `[${base}] ` : args.debug ? "" : null;

  if (args.debug) {
    process.stdout.write(`Debug artifacts for ${base}:\n`);
    // Log filename keys on the QUALIFIED name (not bare basename): two plugins
    // both shipping plugin.test.ts would otherwise write the same log file, and
    // the failing one's detail would be overwritten by a passing sibling (round-5).
    process.stdout.write(`  log: ${displayLogDirPath(join(logDir, `${name}.log`))}\n`);
    process.stdout.write(context
      ? `  driver traces: ${displayLogDirPath(context.artifacts)}/*.ndjson\n`
      : `  driver traces: ${displayLogDirPath(logDir)}/{sdk,tui,kiro-acp}-drive-*.ndjson\n`);
  }

  const actualFile = context ? join(context.worker.root, relative(REPO_ROOT, file)) : file;
  if (args.verbose) {
    // Persist only coverage controls, never the full environment or credentials.
    const coverageKeys = [
      ...LIVE_MODEL_GATES, "AIDLC_RELEASE_CONTRACT_LIVE", "AIDLC_NO_LLM",
      "AIDLC_KIRO_IDE_CASE", "AIDLC_REQUIRE_COMPILED_COVERAGE",
      "AIDLC_TEST_PACKAGE_READY", "AIDLC_TUI_BACKEND",
    ];
    writeFileSync(join(logDir, `${name}.execution.json`), `${JSON.stringify({
      file: actualFile,
      platform: process.platform,
      noLlm: args.noLlm,
      requireCoverage: args.requireCoverage,
      worker: env.AIDLC_TEST_WORKER_ID ?? null,
      gates: Object.fromEntries(coverageKeys.map((key) => [key, env[key] ?? null])),
    }, null, 2)}\n`);
  }
  const streamPath = args.verbose ? join(logDir, `${name}.log`) : undefined;
  if (streamPath) writeFileSync(streamPath, `Test: ${base}\nFile: ${actualFile}\nStatus: RUNNING\n\n--- Output ---\n`);
  const run = await runSpawnCapture(
    BUN,
    ["test", actualFile, `--timeout=${DEFAULT_CASE_TIMEOUT_MS}`, "--reporter=junit", `--reporter-outfile=${junitXml}`],
    env,
    debugPrefix,
    context,
    streamPath,
  );
  if (run.timedOut) {
    run.output += `\nerror: test file exceeded its allocated file/run deadline (file ceiling ${runnerFileTimeoutSeconds(args, context !== undefined)}s)\n`;
  }

  let xml = "";
  try {
    if (existsSync(junitXml) && statSync(junitXml).size > 0) {
      xml = readFileSync(junitXml, "utf8");
    }
  } catch {
    xml = "";
  }
  const { e2eCaseCounts, validateJUnitEvidence } = await import("./lib/e2e-plan.ts");
  const evidence = validateJUnitEvidence(xml);
  const cases = evidence.complete ? evidence.cases : e2eCaseCounts(xml);
  const counts = buildMeta(xml, name, run.rc);
  const meta: ResultRow = { ...counts, skipped: Math.min(counts.tests, cases.skipped) };
  if ((!evidence.complete && cases.total > 0) || (evidence.complete && cases.failed > 0)) {
    meta.status = "FAIL";
    meta.failed = Math.max(1, meta.failed, cases.failed);
    if (!evidence.complete) run.output += `\nerror: ${evidence.error}\n`;
  }
  if (meta.status === "PASS" && meta.tests === meta.skipped) {
    meta.status = filterRegex ? "FAIL" : "SKIP";
    meta.reason = filterRegex
      ? "Explicitly selected file executed no test cases (all skipped or empty). For production guard journeys, rerun with --production-guards; for live gates, enable the documented live variable and install/authenticate its CLI."
      : "No test cases executed (all skipped or empty)";
  }
  // Preserve a duration even if a future Bun omits root time.
  if (meta.duration === "0") meta.duration = String(Math.max(0, (Date.now() - start) / 1000));
  writeMeta(name, meta);

  const status = meta.status;
  const diagnostic = meta.reason
    ? `${status === "FAIL" ? "error: " : ""}${meta.reason}\n`
    : "";
  const body = `${run.output}${diagnostic ? `\n${diagnostic}` : ""}`;
  const doneBlock = (): void => {
    if (!args.debug) process.stdout.write(body);
    else if (diagnostic) process.stdout.write(`[${base}] ${diagnostic}`);
    process.stdout.write(`--- ${status}: ${base} ---\n`);
    process.stdout.write(`=== DONE ${base} (${status}) ===\n`);
  };
  if (parallelMode) {
    await withStdoutLock(doneBlock);
  } else {
    doneBlock();
  }

  if (!context && !args.verbose) rmSync(junitXml, { force: true });
  writeTestLog(file, meta, run.rc, body);
  const execution: FileExecution = {
    status: cases.skipped === cases.total && status !== "FAIL" ? "SKIP" : status,
    cases,
    wallTimeMs: Date.now() - start,
    timedOut: run.timedOut,
    cleanupError: run.cleanupError,
    evidenceComplete: evidence.complete,
    evidenceError: evidence.complete ? undefined : evidence.error,
    junitPath: junitXml,
    // Diagnostic evidence, never grounds for changing an assertion or retrying.
    throttlingSignals: (run.output.match(
      /ThrottlingException|TooManyRequestsException|(?:HTTP|status(?:Code)?)\s*[:=]?\s*429\b|rate[_ ]limit[_ ]exceeded/gi,
    ) ?? []).length,
  };
  fileExecutions.set(name, execution);
  return execution;
}

// Plugin content tests live beside each plugin (plugins/<name>/tests/*.test.ts),
// NOT under tests/<level>/, so the level-dir scan alone never discovered them —
// the AGENTS.md "guarded by plugins/<name>/tests/" claim was hollow. They run the
// framework's real validators against plugin content, which is integration-grade,
// so they join the integration tier. Discovered (any plugins/*/tests/), so a new
// plugin's suite is picked up with zero runner edits.
function pluginTestFiles(): string[] {
  const pluginsRoot = join(SCRIPT_DIR, "..", "plugins");
  if (!existsSync(pluginsRoot)) return [];
  const out: string[] = [];
  for (const name of readdirSync(pluginsRoot).sort()) {
    const testsDir = join(pluginsRoot, name, "tests");
    if (!existsSync(testsDir)) continue;
    for (const f of readdirSync(testsDir).filter((f) => f.endsWith(".test.ts")).sort()) {
      out.push(join(testsDir, f));
    }
  }
  return out;
}

function levelFiles(level: Level, excludes: string[] = []): string[] {
  const dir = join(SCRIPT_DIR, level);
  const excludeSet = new Set(excludes);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".test.ts"))
        .filter((f) => !excludeSet.has(f))
        .sort()
        .map((f) => join(dir, f))
    : [];
  // Fold plugin content tests into the integration tier. Exclusion is keyed by
  // the plugin-dir-qualified name (`plugin-<plugin>-<stem>`), NOT the bare
  // basename — every plugin ships `plugin.test.ts`, so a basename exclude would
  // drop all plugins' suites at once.
  if (level === "integration") {
    files.push(...pluginTestFiles().filter((f) => {
      const m = f.replace(/\\/g, "/").match(/\/plugins\/([^/]+)\/tests\//);
      const qualified = m ? `plugin-${m[1]}-${basename(f).replace(/\.test\.ts$/, "")}` : basename(f);
      return !excludeSet.has(qualified);
    }));
  }
  if (level === "unit" && args.shard) {
    const config = JSON.parse(readFileSync(UNIT_SHARD_CONFIG, "utf8")) as ShardConfig;
    const names = files.map((file) => basename(file));
    try {
      const selected = new Set(selectShard(names, args.shard, config));
      return files.filter((file) => selected.has(basename(file)));
    } catch (error) {
      process.stderr.write(
        `ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(2);
    }
  }
  return files;
}

async function runFileBand(
  effectiveParallel: number,
  serialFiles: string[],
  parallelFiles: string[],
): Promise<void> {
  for (const file of serialFiles) await runBunTestFile(file, false);
  if (effectiveParallel <= 1) {
    for (const file of parallelFiles) await runBunTestFile(file, false);
    return;
  }

  const executing = new Set<Promise<FileExecution | undefined>>();
  try {
    for (const file of parallelFiles) {
      const p = runBunTestFile(file, true).finally(() => {
        executing.delete(p);
      });
      executing.add(p);
      if (executing.size >= effectiveParallel) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
  } catch (error) {
    isolatedRunError = true;
    runnerFailure = String(error);
    isolatedAbort.abort();
    throw error;
  } finally {
    // An infrastructure error must drain admitted files before main can exit.
    await Promise.allSettled(executing);
  }
}

async function runFilesPartitioned(
  level: Level,
  effectiveParallel: number,
  excludes: string[] = [],
): Promise<void> {
  const pinnedSerial = level === "smoke" || level === "unit";
  const serialFiles: string[] = [];
  const parallelFiles: string[] = [];
  const liveSerialFiles: string[] = [];
  const liveParallelFiles: string[] = [];

  for (const file of levelFiles(level, excludes)) {
    const serial = pinnedSerial || basename(file).includes(".serial.");
    if (serial) {
      (isClaudeRequiredFile(file) ? liveSerialFiles : serialFiles).push(file);
    } else {
      (isClaudeRequiredFile(file) ? liveParallelFiles : parallelFiles).push(file);
    }
  }

  await runFileBand(effectiveParallel, serialFiles, parallelFiles);
  await runFileBand(effectiveParallel, liveSerialFiles, liveParallelFiles);
}

async function runTier(level: Level, label: string): Promise<void> {
  const effectiveParallel = level === "smoke" || level === "unit" ? 1 : args.parallel;
  const modifiers: string[] = [];
  if (effectiveParallel > 1) modifiers.push(`parallel=${effectiveParallel}`);
  if (level === "unit" && args.shard) {
    modifiers.push(`shard=${args.shard.index}/${args.shard.total}`);
    process.env[REQUIRE_COMPILED_COVERAGE_ENV] = "1";
  }
  process.stdout.write("\n");
  process.stdout.write(
    modifiers.length > 0 ? `## ${label} (${modifiers.join(", ")})\n` : `## ${label}\n`,
  );
  await runFilesPartitioned(level, effectiveParallel);
  await withStdoutLock(() => undefined);
  aggregateTierResults();
}

async function runIsolatedE2e(): Promise<void> {
  const { planE2eFile, readE2eTimings } = await import("./lib/e2e-plan.ts");
  const { runE2eQueue } = await import("./lib/e2e-scheduler.ts");
  const {
    prepareE2eWorkers, e2eWorkerEnvironment, cleanupE2eTransports, finishE2eTemporaryFiles,
    assertE2eDiskSpace,
  } = await import("./lib/e2e-workers.ts");
  const selected = levelFiles("e2e").filter((file) => matchesE2eFilter(file, filterRegex));
  if (selected.length === 0) throw new Error("isolated e2e selection contains no test files");
  const weights = args.e2eTimings ? e2eTimingAliases(readE2eTimings(readFileSync(args.e2eTimings, "utf8"))) : {};
  const tasks = selected.map((file) => planE2eFile(file, weights));
  const preflight = join(SCRIPT_DIR, "e2e", "t-tui-preflight.serial.test.ts");
  const needsTui = tasks.some((task) => task.tui);
  if (needsTui && !existsSync(preflight)) {
    throw new Error("isolated TUI selection requires t-tui-preflight.serial.test.ts");
  }
  const limits = e2eLimits(tasks);
  const records = new Map<string, Record<string, unknown>>(tasks.map((task) => [
    task.file, {
      file: relative(REPO_ROOT, task.file).replaceAll("\\", "/"),
      selected: true, state: "PENDING", resources: task.resources,
      estimatedSeconds: task.estimatedSeconds, exclusive: task.exclusive,
    },
  ]));
  if (needsTui && !records.has(preflight)) {
    records.set(preflight, {
      file: relative(REPO_ROOT, preflight).replaceAll("\\", "/"),
      selected: false, prerequisite: true, state: "PENDING", resources: [],
    });
  }
  const reportPath = join(logDir, "e2e-results.json");
  const eventsPath = join(logDir, "e2e-events.ndjson");
  let state = "PREPARING";
  let finalizationError: string | undefined;
  let setup: { sourceRevision?: string; sourceDirty?: boolean } = {};
  const report = (): void => writeFileSync(reportPath, `${JSON.stringify({
    state, limits, ...setup, finalizationError,
    selectedFiles: records.size,
    requestedFiles: tasks.length,
    coverageComplete: [...records.values()].every((record) => {
      const cases = record.cases as E2eCaseCounts | undefined;
      return record.state === "PASS" && record.evidenceComplete === true &&
        !!cases && cases.total > 0 && cases.skipped === 0;
    }),
    files: [...records.values()],
  }, null, 2)}\n`);
  writeFileSync(join(logDir, "e2e-plan.json"), `${JSON.stringify({
    limits,
    files: tasks.map((task) => ({
      ...task, file: relative(REPO_ROOT, task.file).replaceAll("\\", "/"),
    })),
  }, null, 2)}\n`);
  report();
  let pool: Awaited<ReturnType<typeof prepareE2eWorkers>>;
  let poolCleanupSafe = true;
  try {
    remainingOperationTimeoutMs(undefined, {
      deadlineMs: RUN_WORK_DEADLINE_MS, phase: "E2E checkout preparation",
    });
    pool = await prepareE2eWorkers(REPO_ROOT, logDir, limits.workers);
  } catch (error) {
    isolatedRunError = true;
    state = "ERROR";
    for (const record of records.values()) record.state = "INCOMPLETE";
    report();
    throw error;
  }
  setup = { sourceRevision: pool.sourceRevision, sourceDirty: pool.sourceDirty };
  const interrupt = (): void => {
    isolatedInterrupted = true;
    state = "INTERRUPTED";
    isolatedAbort.abort();
    try { report(); } catch (error) {
      isolatedRunError = true;
      runnerFailure = `interruption report failed: ${String(error)}`;
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const cancellationTimer = args.e2eCancelFile ? setInterval(() => {
    if (!isolatedInterrupted && existsSync(args.e2eCancelFile)) interrupt();
  }, 100) : undefined;
  if (args.e2eCancelFile && existsSync(args.e2eCancelFile)) interrupt();
  process.stdout.write(
    `\n## Isolated E2E (${limits.workers} workers; Bedrock=${limits.bedrock}; Kiro=${limits.kiro}; IDE=${limits.ide})\n` +
    `E2E plan: ${join(logDir, "e2e-plan.json")}\nE2E results: ${reportPath}\n` +
    `Driver traces: ${join(logDir, "e2e-artifacts", "*", "*.ndjson")}\n`,
  );
  const execute = async (file: string, workerId: number): Promise<FileExecution> => {
    if (isolatedInterrupted) throw new Error("isolated e2e interrupted");
    const worker = pool.workers[workerId - 1];
    let budget: FileBudget;
    try {
      budget = allocateFileBudget(process.env, true);
      requireFileWorkBudget(budget);
    } catch (error) {
      const name = resultName(file);
      const timedOut = error instanceof TestBudgetExhaustedError;
      const outcome: FileExecution = {
        status: "FAIL", cases: { total: 0, passed: 0, failed: 0, skipped: 0 },
        wallTimeMs: 0, timedOut, throttlingSignals: 0, evidenceComplete: false,
      };
      const row: ResultRow = { name, status: "FAIL", tests: 0, skipped: 0, failed: 1, duration: "0" };
      writeMeta(name, row);
      writeTestLog(file, row, timedOut ? 124 : 2, `error: ${String(error)}\n`);
      fileExecutions.set(name, outcome);
      Object.assign(records.get(file)!, outcome, { state: timedOut ? "TIMED_OUT" : "FAIL", reason: String(error) });
      process.stdout.write(`=== DONE ${basename(file)} (FAIL: ${String(error)}) ===\n`);
      report();
      return outcome;
    }
    assertE2eDiskSpace(worker.root);
    assertE2eDiskSpace(logDir);
    const artifacts = join(logDir, "e2e-artifacts", resultName(file));
    const env = await e2eWorkerEnvironment(worker, file, artifacts, {
      ...process.env,
      [FILE_DEADLINE_ENV]: String(budget.deadlineMs),
      [FILE_CLEANUP_ENV]: String(budget.cleanupMs),
    });
    const record = records.get(file)!;
    Object.assign(record, {
      state: "RUNNING", worker: workerId, checkout: worker.root, socket: worker.socket,
      artifacts, temporaryDirectory: env.TEMP,
    });
    let outcome: FileExecution | undefined;
    const context: IsolatedFileContext = { worker, env, artifacts, force: true, budget };
    let cleanupFailure: Error | undefined;
    const checkWorkerSource = async (checkpoint: "before" | "after"): Promise<void> => {
      if (!matrixContext) return;
      const { captureTestSource } = await import("./lib/test-source.ts");
      const captured = captureTestSource(worker.root);
      record.matrixSource ??= {
        expected: matrixContext.source.sourceDigest,
      };
      const proof = record.matrixSource as Record<string, unknown>;
      proof[checkpoint] = captured.sourceDigest;
      writeFileSync(join(artifacts, "matrix-worker-source.json"), `${JSON.stringify(proof, null, 2)}\n`);
      if (captured.sourceDigest !== matrixContext.source.sourceDigest) {
        throw new Error(`matrix worker ${workerId} authored source mismatch at ${checkpoint} execution`);
      }
    };
    try {
      report();
      // Cancellation may have arrived during any awaited environment allocation.
      // Stay inside finally so even a never-launched file releases its fixtures.
      isolatedAbort.signal.throwIfAborted();
      await checkWorkerSource("before");
      outcome = await runBunTestFile(file, true, context);
      if (outcome?.cleanupError) {
        poolCleanupSafe = false;
        cleanupFailure = new Error(outcome.cleanupError);
      }
    } finally {
      try {
        await cleanupE2eTransports(worker, env);
        await checkWorkerSource("after");
        // Leave fixtures in place on process-cleanup uncertainty. The failure
        // is reported and thrown after finally, without replacing a pending error.
        if (!cleanupFailure) {
          record.retainedFixtures = await finishE2eTemporaryFiles(
            env, artifacts,
            isolatedInterrupted || outcome?.status === "FAIL" || process.env.AIDLC_KEEP_TEMP === "1",
            context.retirement,
          );
        }
      } catch (error) {
        poolCleanupSafe = false;
        const message = error instanceof Error ? error.message : String(error);
        cleanupFailure = new Error(`isolated worker ${workerId} cleanup failed: ${message}`);
        record.cleanupError = message;
        const name = resultName(file);
        appendFileSync(join(logDir, `${name}.log`), `\nerror: ${message}\n`);
        outcome = {
          status: "FAIL",
          cases: outcome?.cases ?? { total: 0, passed: 0, skipped: 0, failed: 0 },
          wallTimeMs: outcome?.wallTimeMs ?? 0,
          timedOut: outcome?.timedOut ?? false,
          throttlingSignals: outcome?.throttlingSignals ?? 0,
        };
        writeMeta(name, {
          name, status: "FAIL", tests: outcome.cases.total,
          skipped: outcome.cases.skipped,
          failed: Math.max(1, outcome.cases.failed), duration: String(outcome.wallTimeMs / 1000),
        });
      }
    }
    if (!outcome) throw new Error(`isolated e2e produced no result for ${file}`);
    Object.assign(record, outcome, {
      state: isolatedInterrupted ? "INCOMPLETE" : outcome.timedOut ? "TIMED_OUT" : outcome.status,
    });
    fileExecutions.set(resultName(file), {
      ...outcome,
      cleanupError: cleanupFailure?.message ?? outcome.cleanupError,
    });
    report();
    if (cleanupFailure) throw cleanupFailure;
    if (isolatedInterrupted) throw new Error("isolated e2e interrupted");
    return outcome;
  };
  let runFailure: unknown;
  let hasRunFailure = false;
  const rememberFailure = (error: unknown): void => {
    if (!hasRunFailure) { runFailure = error; hasRunFailure = true; }
  };
  try {
    state = "RUNNING";
    report();
    let tuiReady = true;
    if (needsTui) {
      const gate = await execute(preflight, 1);
      tuiReady = prerequisitePassed(gate);
      if (!tuiReady) {
        isolatedRunError = true;
        runnerFailure = "TUI capability prerequisite did not pass with complete, non-skipped evidence";
      }
    }
    const runnable = tasks.filter((task) => {
      if (needsTui && task.file === preflight) return false;
      if (task.tui && !tuiReady) {
        const name = resultName(task.file);
        writeMeta(name, { name, status: "SKIP", tests: 0, skipped: 0, failed: 0, duration: "0" });
        Object.assign(records.get(task.file)!, { state: "SKIP", reason: "TUI capability gate failed" });
        process.stdout.write(`=== DONE ${basename(task.file)} (SKIP: TUI capability gate failed) ===\n`);
        return false;
      }
      return true;
    });
    await runE2eQueue(runnable, limits, async (task, worker) => {
      try {
        await execute(task.file, worker);
      } catch (error) {
        isolatedAbort.abort();
        throw error;
      }
    }, (event) => {
      try {
        appendFileSync(eventsPath, `${JSON.stringify({
          timestamp: new Date().toISOString(), ...event,
          file: relative(REPO_ROOT, event.file).replaceAll("\\", "/"),
        })}\n`);
      } catch (error) {
        isolatedAbort.abort();
        throw error;
      }
      const record = records.get(event.file)!;
      record.queuedMs = event.queuedMs;
      if (event.kind === "finish") record.workerElapsedMs = event.elapsedMs;
    });
    state = [...records.values()].some((record) =>
      record.state === "FAIL" || record.state === "TIMED_OUT") ? "FAIL" : "COMPLETE";
  } catch (error) {
    isolatedRunError = true;
    state = isolatedInterrupted ? "INTERRUPTED" : "ERROR";
    for (const record of records.values()) {
      if (record.state === "RUNNING" || record.state === "PENDING") record.state = "INCOMPLETE";
    }
    rememberFailure(error);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (cancellationTimer) clearInterval(cancellationTimer);
    // Assertion failures already retain their fixtures beside the durable logs.
    // Keeping every generated checkout on each red slice exhausted Windows disks.
    // Unconfirmed process retirement still retains the pool for investigation.
    try {
      await pool.dispose(!poolCleanupSafe || process.env.AIDLC_KEEP_TEMP === "1");
    } catch (error) {
      rememberFailure(error);
      finalizationError = `worker pool disposal failed: ${String(error)}`;
      isolatedRunError = true;
      state = "ERROR";
    }
    try {
      report();
      aggregateTierResults();
      writeVerboseSummary();
    } catch (error) {
      finalizationError ??= `result publication failed: ${String(error)}`;
      isolatedRunError = true;
      state = "ERROR";
      try { report(); } catch {}
      rememberFailure(error);
    }
  }
  if (hasRunFailure) throw runFailure;
}

function printSummary(): void {
  process.stdout.write("\n==============================\n");
  process.stdout.write("SUMMARY\n");
  process.stdout.write("==============================\n");
  process.stdout.write(`${guardProfileDescription(args.guardProfile)}\n`);
  process.stdout.write(`Test files: ${totalFiles}\n`);
  process.stdout.write(`Failed files: ${failedFiles}\n`);
  process.stdout.write(`Total assertions: ${totalTests}\n`);
  process.stdout.write(`Failed assertions: ${totalFailed}\n`);
  process.stdout.write(`Coverage: ${coverageReport().complete ? "COMPLETE" : "INCOMPLETE"}\n`);
  process.stdout.write(`Executed test cases: ${resultRows.reduce((n, row) => n + row.tests - row.skipped, 0)}\n`);
  process.stdout.write(`Skipped test cases: ${resultRows.reduce((n, row) => n + row.skipped, 0)}\n`);
  process.stdout.write(`Skipped files: ${resultRows.filter((row) => row.status === "SKIP").length}\n`);
  for (const error of selectionErrors) process.stdout.write(`error: ${error}\n`);
  if (args.verbose && logDir) {
    process.stdout.write(`Log directory: ${displayLogDirPath(logDir)}\n`);
  }
  process.stdout.write("==============================\n");
  process.stdout.write(runFailed() ? "RESULT: FAIL\n" : "RESULT: PASS\n");
}

function writeVerboseSummary(): void {
  if (!args.verbose || !logDir) return;
  const coverage = coverageReport();
  writeFileSync(join(logDir, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`);
  const tiersRun = [
    args.runSmoke ? "smoke" : "",
    args.runUnit ? "unit" : "",
    args.runIntegration ? "integration" : "",
    args.runE2e ? "e2e" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const lines = [
    "AI-DLC Test Run Summary",
    "======================",
    `Timestamp: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    `Tiers: ${tiersRun}`,
    guardProfileDescription(args.guardProfile),
  ];
  if (args.debug) lines.push("Mode: debug (streaming + driver traces)");
  lines.push("", "Per-file results:");
  lines.push(`  ${"File".padEnd(40)} ${"Status".padEnd(6)} ${"Assertions".padStart(10)} ${"Failed".padStart(10)} ${"Duration".padStart(10)}`);
  lines.push(`  ${"----".padEnd(40)} ${"------".padEnd(6)} ${"----------".padStart(10)} ${"------".padStart(10)} ${"--------".padStart(10)}`);
  for (const row of resultRows) {
    lines.push(
      `  ${row.name.padEnd(40)} ${row.status.padEnd(6)} ${String(row.tests).padStart(10)} ${String(row.failed).padStart(10)} ${`${row.duration}s`.padStart(10)}`,
    );
    if (row.reason) lines.push(`    ${row.reason}`);
  }
  lines.push(
    "",
    "Totals:",
    `  Test files: ${totalFiles}`,
    `  Failed files: ${failedFiles}`,
    `  Total assertions: ${totalTests}`,
    `  Failed assertions: ${totalFailed}`,
    `  Coverage: ${coverage.complete ? "COMPLETE" : "INCOMPLETE"}`,
    `  Executed test cases: ${resultRows.reduce((n, row) => n + row.tests - row.skipped, 0)}`,
    `  Skipped test cases: ${resultRows.reduce((n, row) => n + row.skipped, 0)}`,
    `  Skipped files: ${resultRows.filter((row) => row.status === "SKIP").length}`,
    ...selectionErrors.map((error) => `  error: ${error}`),
    `  Result: ${runFailed() ? "FAIL" : "PASS"}`,
  );
  writeFileSync(join(logDir, "summary.txt"), `${lines.join("\n")}\n`, "utf8");

  const failures: string[] = selectionErrors.map((error) => `error: ${error}`);
  if (args.requireCoverage && !coverage.complete) {
    failures.push("INCOMPLETE: required selected coverage was not fully exercised");
    if (coverage.selectedFiles === 0) failures.push("  No test files selected");
    for (const file of coverage.files.filter((file) => !file.complete)) {
      failures.push(`  ${file.file}: ${file.state}; cases=${file.cases?.total ?? "unknown"}; skipped=${file.cases?.skipped ?? "unknown"}${file.evidenceError ? `; ${file.evidenceError}` : ""}`);
    }
    failures.push("");
  }
  if (isolatedRunError) failures.push(
    captureFailure || runnerFailure
      ? `ERROR: ${captureFailure?.message ?? runnerFailure}`
      : "ERROR: isolated e2e did not complete; see e2e-results.json", "",
  );
  if (failedFiles > 0) {
    for (const row of resultRows) {
      if (row.status !== "FAIL") continue;
      failures.push(`FAIL: ${row.name} (${row.reason ?? `${row.failed} failed assertions`})`);
      const logFile = join(logDir, `${row.name}.log`);
      if (existsSync(logFile) && statSync(logFile).isFile()) {
        // bun:test marks a failing case with a line that STARTS WITH `(fail)`
        // (e.g. `(fail) my test name [0.4ms]`) and prints the assertion detail
        // on a preceding `error:` line — NOT the TAP `not ok` the legacy .sh
        // runner emitted. Capture both so failures.txt names the failing
        // assertion, not just the file. (Pre-cutover this grepped `not ok` and
        // silently captured nothing once the suite went all-TS.)
        for (const line of readFileSync(logFile, "utf8").split(/\r?\n/)) {
          const t = line.trim();
          if (t.startsWith("(fail)") || t.startsWith("error:")) {
            failures.push(`  ${t}`);
          }
        }
      }
      failures.push("");
    }
  }
  writeFileSync(join(logDir, "failures.txt"), `${failures.join("\n")}\n`, "utf8");
}

function prerequisitePassed(result: FileExecution | undefined): boolean {
  return preflightVerdict(result, { liveRequested: false, requireCoverage: true }) === "pass";
}

function sealMatrixReceipt(): void {
  if (!matrixContext || !matrixModule || !matrixRuntime || matrixReceiptWritten) return;
  const e2e = new Set(levelFiles("e2e"));
  const files = (effectiveTestFiles ?? requestedTestFiles()).map((file) => {
    const execution = fileExecutions.get(resultName(file));
    const junit = execution?.junitPath ?? (args.isolatedE2e && e2e.has(file)
      ? join(logDir, "e2e-artifacts", resultName(file), "junit.xml")
      : join(logDir, `${resultName(file)}.junit.xml`));
    return {
      file: relative(REPO_ROOT, file).replaceAll("\\", "/"),
      junitPath: relative(logDir, junit).replaceAll("\\", "/"),
      state: execution?.timedOut ? "TIMED_OUT" as const : execution?.status ?? "INCOMPLETE" as const,
      evidenceComplete: execution?.evidenceComplete === true && !execution.cleanupError,
    };
  });
  const result = matrixModule.writeTestMatrixReceipt(matrixContext, {
    stampDir: logDir,
    files,
    runStatus: isolatedInterrupted ? "INTERRUPTED" : isolatedRunError ? "ERROR" : runFailed() ? "FAIL" : "PASS",
    errors: [runnerFailure, captureFailure?.message].filter((error): error is string => !!error),
    runtimeIdentity: matrixRuntime,
    gates: Object.fromEntries([...LIVE_MODEL_GATES, "AIDLC_RELEASE_CONTRACT_LIVE"]
      .map((key) => [key, process.env[key] ?? null])),
  });
  matrixReceiptWritten = true;
  if (result.receipt.status !== "PASS") {
    isolatedRunError = true;
    runnerFailure ??= "test matrix job did not fulfill its planned coverage; see test-matrix-receipt.json";
    writeVerboseSummary();
    printSummary();
  }
}

async function main(): Promise<number> {
  // Freeze requested files and mandatory prerequisites before naming or running
  // anything. A filter must not hide an automatically executed capability gate.
  const requested = requestedTestFiles();
  requestedFilesAtStart = requested;
  if (needsLlm && !args.filter && !args.noLlm) {
    const preflight = join(SCRIPT_DIR, "integration", "t19.test.ts");
    if (existsSync(preflight)) requiredPrerequisites.add(preflight);
  }
  if (args.runE2e) {
    const { planE2eFile } = await import("./lib/e2e-plan.ts");
    const e2e = new Set(levelFiles("e2e"));
    for (const file of requested) {
      if (e2e.has(file) && planE2eFile(file).tui) requiredTuiFiles.add(file);
    }
    if (requiredTuiFiles.size > 0) {
      requiredPrerequisites.add(join(SCRIPT_DIR, "e2e", "t-tui-preflight.serial.test.ts"));
    }
  }
  effectiveTestFiles = [...new Set([...requested, ...requiredPrerequisites])];
  resultNames = undefined;
  if (args.matrixPlan) {
    matrixModule = await import("./lib/test-matrix.ts");
    const { planE2eFile } = await import("./lib/e2e-plan.ts");
    const { selectedTuiBackend } = await import("./harness/tui-runtime.ts");
    matrixRuntime = {
      platform: process.platform,
      architecture: process.arch,
      backend: effectiveTestFiles.some((file) => existsSync(file) && planE2eFile(file).tui)
        ? selectedTuiBackend() : "none",
      bunVersion: process.versions.bun ?? "unknown",
    };
    matrixContext = matrixModule.loadTestMatrixJob(args.matrixPlan, args.matrixJob, REPO_ROOT);
    matrixModule.validateMatrixSelection(
      matrixContext,
      effectiveTestFiles.map((file) => relative(REPO_ROOT, file).replaceAll("\\", "/")),
      matrixRuntime,
    );
  }
  process.stdout.write("AI-DLC Testing Harness\n");
  process.stdout.write("======================\n");
  process.stdout.write(`${guardProfileDescription(args.guardProfile)}\n`);

  if (args.runSmoke) await runTier("smoke", "Smoke Tests (structural)");
  if (args.runSmoke && failedFiles > 0) {
    process.stdout.write("\nSMOKE FAILURES DETECTED -- aborting before unit/integration levels\n");
    return failedFiles;
  }

  if (args.runUnit) await runTier("unit", "Unit Tests (single-component isolation)");

  let preflightRan = false;
  if (needsLlm && !args.filter && args.noLlm) {
    process.stdout.write("\n--no-llm: omitting Claude health preflight because its live gate is closed\n");
  } else if (needsLlm && !args.filter) {
    const preflight = join(SCRIPT_DIR, "integration", "t19.test.ts");
    if (existsSync(preflight)) {
      process.stdout.write("\n## Preflight Health Check (Claude CLI validation)\n");
      const preflightResult = await runBunTestFile(preflight, false);
      preflightRan = true;
      aggregateTierResults();

      const verdict = preflightVerdict(preflightResult, {
        liveRequested: process.env.AIDLC_CLAUDE_SDK_LIVE === "1" || process.env.AIDLC_TUI_LIVE === "1",
        requireCoverage: args.requireCoverage,
      });
      if (verdict === "fail") {
        isolatedRunError = true;
        runnerFailure = "Claude capability prerequisite did not pass with complete, non-skipped evidence";
        process.stdout.write("\nPREFLIGHT FAILURE -- skipping remaining Claude-dependent tests\n");
        process.stdout.write("  Fix: ensure claude CLI is authenticated and API is responsive\n");
        claudeGateOpen = false;
      } else if (verdict === "skip") {
        process.stdout.write("\nPREFLIGHT SKIP -- skipping remaining Claude-dependent tests\n");
        claudeGateOpen = false;
      }
    }
  }

  if (args.runIntegration) {
    process.stdout.write("\n");
    process.stdout.write(
      args.parallel > 1
        ? `## Integration Tests (Claude CLI end-to-end) (parallel=${args.parallel})\n`
        : "## Integration Tests (Claude CLI end-to-end)\n",
    );
    await runFilesPartitioned(
      "integration",
      args.parallel,
      preflightRan ? ["t19.test.ts"] : [],
    );
    await withStdoutLock(() => undefined);
    aggregateTierResults();
  }

  if (args.runE2e && args.isolatedE2e) {
    try {
      await runIsolatedE2e();
    } catch (error) {
      isolatedRunError = true;
      throw error;
    }
  } else if (args.runE2e) {
    process.stdout.write("\n");
    process.stdout.write(
      args.parallel > 1
        ? `## E2E Tests (full lifecycle) (parallel=${args.parallel})\n`
        : "## E2E Tests (full lifecycle)\n",
    );
    const e2eFiles = levelFiles("e2e");
    const tuiExcludes = e2eFiles
      .filter((file) => requiredTuiFiles.has(file))
      .map((file) => basename(file));
    const nonTuiExcludes = e2eFiles
      .filter((file) => !requiredTuiFiles.has(file))
      .map((file) => basename(file));

    await runFilesPartitioned("e2e", args.parallel, tuiExcludes);
    await withStdoutLock(() => undefined);
    aggregateTierResults();

    const tuiPreflight = join(SCRIPT_DIR, "e2e", "t-tui-preflight.serial.test.ts");
    if (requiredPrerequisites.has(tuiPreflight)) {
      if (!existsSync(tuiPreflight)) {
        throw new Error("TUI selection requires t-tui-preflight.serial.test.ts");
      }
      process.stdout.write("\n## E2E TUI Capability Gate\n");
      const tuiPreflightResult = await runBunTestFile(tuiPreflight, false, undefined, true);
      aggregateTierResults();

      const tuiPreflightFailed = !prerequisitePassed(tuiPreflightResult);
      if (tuiPreflightFailed) {
        isolatedRunError = true;
        runnerFailure = "TUI capability prerequisite did not pass with complete, non-skipped evidence";
        process.stdout.write("\nTUI PREFLIGHT FAILURE -- skipping remaining folded TUI tests\n");
        process.stdout.write("  The selected terminal backend failed the token-free capability check.\n");
        process.stdout.write("  Inspect the preflight log and AIDLC_TUI_BACKEND selection.\n");
      } else {
        await runFilesPartitioned("e2e", args.parallel, [
          ...nonTuiExcludes,
          "t-tui-preflight.serial.test.ts",
        ]);
        await withStdoutLock(() => undefined);
        aggregateTierResults();
      }
    }
  }

  if (filterRegex && failedFiles === 0 && !resultRows.some((row) => row.tests > row.skipped)) {
    selectionErrors.push(totalFiles === 0
      ? `--filter ${JSON.stringify(args.filter)} matched no test files in the selected tiers/shard. Check the filename, tier and shard.`
      : `--filter ${JSON.stringify(args.filter)} executed no test cases. --no-llm excludes Claude-dependent files; select deterministic tests or enable the requested live coverage.`);
  }
  return runFailed() ? runnerFailureExitCode(failedFiles) : 0;
}

try {
  const rc = await main();
  if (isolatedGitConfig !== NULL_DEVICE) rmSync(isolatedGitConfig, { force: true });
  writeVerboseSummary();
  if (cleanupLogDir) rmSync(logDir, { recursive: true, force: true });
  printSummary();
  // Seal last, after cleanup and report publication. A PASS receipt has no
  // remaining filesystem work that could subsequently invalidate the run.
  sealMatrixReceipt();
  process.exit(runFailed() ? runnerFailureExitCode(failedFiles) : rc);
} catch (err) {
  isolatedRunError = true;
  runnerFailure ??= String(err);
  isolatedAbort.abort();
  try {
    aggregateTierResults();
    if (isolatedGitConfig !== NULL_DEVICE) rmSync(isolatedGitConfig, { force: true });
    writeVerboseSummary();
    if (cleanupLogDir) rmSync(logDir, { recursive: true, force: true });
    printSummary();
    sealMatrixReceipt();
  } catch {
    // A full/unwritable result volume cannot publish a complete rollup. The
    // nonzero exit and original stderr remain authoritative; never emit PASS.
  }
  const details = err instanceof Error ? err.stack ?? err.message : String(err);
  // Some runtimes omit the message from Error.stack; retain the actionable cause.
  const diagnostic = err instanceof Error && !details.includes(err.message)
    ? `${err.message}\n${details}`
    : details;
  appendFileSync(2, `${diagnostic}\n`);
  process.exit(1);
}
