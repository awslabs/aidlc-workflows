#!/usr/bin/env bun
// Native Bun/TypeScript test runner for the AI-DLC harness.
//
// tests/run-tests.sh remains as a POSIX compatibility wrapper. Keep behavior
// aligned with the old runner because smoke/t05 drives the public runner
// contract: flags, tier banners, START/DONE markers, summary fields, verbose
// log dirs, debug trace locations, and the "exit == failed files" convention.

import { spawn, spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { buildMeta, renderMeta, type MetaCounts } from "./lib/bun-junit-to-meta.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const BUN = process.execPath;

type Level = "smoke" | "unit" | "integration" | "e2e";
type Status = "PASS" | "FAIL" | "SKIP";

interface ParsedArgs {
  runSmoke: boolean;
  runUnit: boolean;
  runIntegration: boolean;
  runE2e: boolean;
  verbose: boolean;
  debug: boolean;
  filter: string;
  parallel: number;
  fullProfile: boolean;
}

interface ResultRow {
  name: string;
  status: Status;
  tests: number;
  failed: number;
  duration: string;
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
  --verbose       Write per-test logs to tests/logs/
  --debug         Implies --verbose; streams per-test output and writes SDK/TUI
                  driver traces to tests/logs/
  --filter PAT    Only run tests whose filename matches extended regex PAT
  --parallel N    Run up to N test files concurrently within a tier (alias: -P N).
                  Default: 1 (serial). Smoke and unit tiers always run serially.
                  Recommended range: 1-8. See docs/reference/09-testing.md.

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
`;
}

function failUsage(message: string, code = 1): never {
  process.stderr.write(`${message}\n\n${usage()}`);
  process.exit(code);
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    runSmoke: false,
    runUnit: false,
    runIntegration: false,
    runE2e: false,
    verbose: false,
    debug: false,
    filter: "",
    parallel: 1,
    fullProfile: false,
  };
  let levelSelected = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--smoke":
        out.runSmoke = true;
        levelSelected = true;
        break;
      case "--unit":
        out.runUnit = true;
        levelSelected = true;
        break;
      case "--integration":
        out.runIntegration = true;
        levelSelected = true;
        break;
      case "--e2e":
        out.runE2e = true;
        levelSelected = true;
        break;
      case "--ci":
        out.runSmoke = true;
        out.runUnit = true;
        out.runIntegration = true;
        levelSelected = true;
        break;
      case "--release":
      case "--all":
        out.runSmoke = true;
        out.runUnit = true;
        out.runIntegration = true;
        out.runE2e = true;
        out.fullProfile = true;
        levelSelected = true;
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "--debug":
        out.debug = true;
        out.verbose = true;
        break;
      case "--filter": {
        const value = argv[++i] ?? "";
        out.filter = value;
        break;
      }
      case "--parallel":
      case "-P": {
        const value = argv[++i] ?? "";
        if (!/^[1-9][0-9]*$/.test(value)) {
          process.stderr.write(
            `ERROR: --parallel requires a positive integer (got: '${value || "<missing>"}')\n`,
          );
          process.exit(2);
        }
        out.parallel = Number(value);
        break;
      }
      case "--help":
        process.stdout.write(usage());
        process.exit(0);
        break;
      case "-h":
        process.stdout.write(usage());
        process.exit(0);
        break;
      default:
        failUsage(`Unknown flag: ${arg}`);
    }
  }

  if (!levelSelected) {
    out.runSmoke = true;
    out.runUnit = true;
    out.runIntegration = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
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
  logDir = join(SCRIPT_DIR, "logs", utcStamp());
  mkdirSync(logDir, { recursive: true });
  process.env.AIDLC_TEST_VERBOSE = "true";
  process.env.AIDLC_TEST_LOG_DIR = logDir;
  process.stdout.write(`Verbose mode: logging to ${logDir}\n`);
} else {
  logDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-run-tests."));
  cleanupLogDir = true;
}

const resultsDir = join(logDir, "_results");
mkdirSync(resultsDir, { recursive: true });

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
if (needsLlm && !commandExists("claude")) {
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

function testsRel(file: string): string {
  return `tests/${relative(SCRIPT_DIR, file).replace(/\\/g, "/")}`;
}

function isClaudeRequiredFile(file: string): boolean {
  return claudeRequiredFiles.has(testsRel(file));
}

function shouldSkipForClaude(file: string): boolean {
  return !claudeGateOpen && isClaudeRequiredFile(file);
}

function writeMeta(name: string, meta: MetaCounts | ResultRow): void {
  const status = meta.status;
  const rc = status === "FAIL" ? 1 : 0;
  const content =
    status === "SKIP"
      ? [
          `NAME=${name}`,
          "STATUS=SKIP",
          "TESTS=0",
          "FAILED=0",
          "DURATION=0",
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
  writeFileSync(join(resultsDir, `${name}.meta`), content, "utf8");
}

function parseMeta(file: string): ResultRow {
  const row: ResultRow = {
    name: "",
    status: "PASS",
    tests: 0,
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
    else if (key === "FAILED") row.failed = Number(value) || 0;
    else if (key === "DURATION") row.duration = value || "0";
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

async function runSpawnCapture(
  cmd: string,
  cmdArgs: string[],
  env: NodeJS.ProcessEnv,
  debugPrefix: string | null,
): Promise<{ rc: number; output: string }> {
  const child = spawn(cmd, cmdArgs, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let lineBuf = "";

  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    if (debugPrefix === null) return;
    const text = chunk.toString();
    lineBuf += text;
    const lines = lineBuf.split(/\n/);
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`${debugPrefix}${line}\n`);
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const rc = await new Promise<number>((resolvePromise) => {
    child.on("error", (err) => {
      chunks.push(Buffer.from(String(err)));
      resolvePromise(127);
    });
    child.on("close", (code, signal) => {
      if (debugPrefix !== null && lineBuf.length > 0) {
        process.stdout.write(`${debugPrefix}${lineBuf}`);
        lineBuf = "";
      }
      resolvePromise(code ?? (signal ? 128 : 1));
    });
  });

  return { rc, output: Buffer.concat(chunks).toString("utf8") };
}

async function runBunTestFile(file: string, parallelMode = false): Promise<void> {
  const base = basename(file);
  // Result meta is keyed by `name`. For tests under tests/<level>/ the basename
  // is unique, but plugin content tests live at plugins/<plugin>/tests/ and every
  // plugin ships `plugin.test.ts` (the fixture header says "copy this shape"), so
  // a bare-basename key would collide — last writer wins and a FAILING suite gets
  // erased from the summary (the same result-masking class as the round-2 t188
  // gap). Key a plugin test by its plugin dir so two `plugin.test.ts` never clash.
  const pluginMatch = file.replace(/\\/g, "/").match(/\/plugins\/([^/]+)\/tests\//);
  const name = pluginMatch
    ? `plugin-${pluginMatch[1]}-${base.replace(/\.test\.ts$/, "")}`
    : base.replace(/\.test\.ts$/, "");

  // Match the filter against BOTH the basename and the qualified name shown in
  // output/summary — a user who copies the displayed `plugin-<plugin>-<stem>`
  // name into --filter would otherwise select nothing and see a green run (round-5).
  if (filterRegex && !filterRegex.test(base) && !filterRegex.test(name)) return;

  if (shouldSkipForClaude(file)) {
    process.stdout.write(`\n=== SKIP ${base} ===\n`);
    process.stdout.write(`--- SKIP: ${base} (Claude substrate unavailable; derived live mechanism) ---\n`);
    process.stdout.write(`=== DONE ${base} (SKIP) ===\n`);
    writeMeta(name, { name, status: "SKIP", tests: 0, failed: 0, duration: "0" });
    return;
  }

  // Disable the stage-completion artifact guard (issue #366) for the suite by
  // default: most state/orchestrate tests drive approve/advance against bare
  // fixtures that intentionally produce no artifacts, so the suite sets the env
  // bypass globally. The dedicated guard test (t185-stage-artifact-guard)
  // re-enables the guard by clearing this var in its own tool spawns, so
  // enforcement is still covered.
  //
  // Disable the human-presence gate for the suite by default for the same
  // reason: most approve/advance tests drive the gate without recording a
  // HUMAN_TURN event (the gate requires one since the last gate resolution),
  // so the suite sets the bypass globally. The dedicated guard test
  // (t188-human-presence-gate) clears this var in its own tool spawns to
  // exercise real enforcement.
  //
  // Disable the approve-time gate-revision backstop for the suite by default,
  // for the same reason: many approve tests drive a revision-shaped ledger
  // against bare fixtures and must not have their Revision Count / audit trail
  // reconciled out from under them. The dedicated test (t205-gate-revision-
  // backstop) clears this var in its own tool spawns to exercise the backfill.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_TEST_NAME: base,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_SKIP_REVISION_BACKSTOP: "1",
  };
  process.stdout.write(`\n=== START ${base} ===\n`);

  const junitXml = tmpFile("aidlc-run-tests-junit");
  const start = Date.now();
  const debugPrefix = args.debug && parallelMode ? `[${base}] ` : args.debug ? "" : null;

  if (args.debug) {
    process.stdout.write(`Debug artifacts for ${base}:\n`);
    // Log filename keys on the QUALIFIED name (not bare basename): two plugins
    // both shipping plugin.test.ts would otherwise write the same log file, and
    // the failing one's detail would be overwritten by a passing sibling (round-5).
    process.stdout.write(`  log: ${displayLogDirPath(join(logDir, `${name}.log`))}\n`);
    process.stdout.write(`  driver traces: ${displayLogDirPath(logDir)}/{sdk,tui,kiro-acp}-drive-*.ndjson\n`);
  }

  const run = await runSpawnCapture(
    BUN,
    ["test", file, "--reporter=junit", `--reporter-outfile=${junitXml}`],
    env,
    debugPrefix,
  );

  let xml = "";
  try {
    if (existsSync(junitXml) && statSync(junitXml).size > 0) {
      xml = readFileSync(junitXml, "utf8");
    }
  } catch {
    xml = "";
  }
  const meta = buildMeta(xml, name, run.rc);
  // Preserve a duration even if a future Bun omits root time.
  if (meta.duration === "0") meta.duration = String(Math.max(0, (Date.now() - start) / 1000));
  writeMeta(name, meta);

  const status = meta.status;
  const body = run.output;
  const doneBlock = (): void => {
    if (!args.debug) process.stdout.write(body);
    process.stdout.write(status === "FAIL" ? `--- FAIL: ${base} ---\n` : `--- PASS: ${base} ---\n`);
    process.stdout.write(`=== DONE ${base} (${status}) ===\n`);
  };
  if (parallelMode) {
    await withStdoutLock(doneBlock);
  } else {
    doneBlock();
  }

  rmSync(junitXml, { force: true });

  if (args.verbose) {
    const logFile = join(logDir, `${name}.log`);
    writeFileSync(
      logFile,
      [
        `Test: ${base}`,
        `File: ${file}`,
        `Status: ${status}`,
        `Exit code: ${run.rc}`,
        `Timestamp: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
        "",
        "--- Output ---",
        body,
      ].join("\n"),
      "utf8",
    );
  }
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

  const executing = new Set<Promise<void>>();
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
  process.stdout.write("\n");
  process.stdout.write(
    effectiveParallel > 1 ? `## ${label} (parallel=${effectiveParallel})\n` : `## ${label}\n`,
  );
  await runFilesPartitioned(level, effectiveParallel);
  await withStdoutLock(() => undefined);
  aggregateTierResults();
}

function printSummary(): void {
  process.stdout.write("\n==============================\n");
  process.stdout.write("SUMMARY\n");
  process.stdout.write("==============================\n");
  process.stdout.write(`Test files: ${totalFiles}\n`);
  process.stdout.write(`Failed files: ${failedFiles}\n`);
  process.stdout.write(`Total assertions: ${totalTests}\n`);
  process.stdout.write(`Failed assertions: ${totalFailed}\n`);
  if (args.verbose && logDir) {
    process.stdout.write(`Log directory: ${displayLogDirPath(logDir)}\n`);
  }
  process.stdout.write("==============================\n");
  process.stdout.write(failedFiles > 0 ? "RESULT: FAIL\n" : "RESULT: PASS\n");
}

function writeVerboseSummary(): void {
  if (!args.verbose || !logDir) return;
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
  ];
  if (args.debug) lines.push("Mode: debug (streaming + driver traces)");
  lines.push("", "Per-file results:");
  lines.push(`  ${"File".padEnd(40)} ${"Status".padEnd(6)} ${"Assertions".padStart(10)} ${"Failed".padStart(10)} ${"Duration".padStart(10)}`);
  lines.push(`  ${"----".padEnd(40)} ${"------".padEnd(6)} ${"----------".padStart(10)} ${"------".padStart(10)} ${"--------".padStart(10)}`);
  for (const row of resultRows) {
    lines.push(
      `  ${row.name.padEnd(40)} ${row.status.padEnd(6)} ${String(row.tests).padStart(10)} ${String(row.failed).padStart(10)} ${`${row.duration}s`.padStart(10)}`,
    );
  }
  lines.push(
    "",
    "Totals:",
    `  Test files: ${totalFiles}`,
    `  Failed files: ${failedFiles}`,
    `  Total assertions: ${totalTests}`,
    `  Failed assertions: ${totalFailed}`,
    `  Result: ${failedFiles > 0 ? "FAIL" : "PASS"}`,
  );
  writeFileSync(join(logDir, "summary.txt"), `${lines.join("\n")}\n`, "utf8");

  const failures: string[] = [];
  if (failedFiles > 0) {
    for (const row of resultRows) {
      if (row.status !== "FAIL") continue;
      failures.push(`FAIL: ${row.name} (${row.failed} failed assertions)`);
      const logFile = join(logDir, `${row.name}.log`);
      if (existsSync(logFile)) {
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

async function main(): Promise<number> {
  process.stdout.write("AI-DLC Testing Harness\n");
  process.stdout.write("======================\n");

  if (args.runSmoke) await runTier("smoke", "Smoke Tests (structural)");
  if (args.runSmoke && failedFiles > 0) {
    process.stdout.write("\nSMOKE FAILURES DETECTED -- aborting before unit/integration levels\n");
    writeVerboseSummary();
    printSummary();
    return failedFiles;
  }

  if (args.runUnit) await runTier("unit", "Unit Tests (single-component isolation)");

  let preflightRan = false;
  if (needsLlm && !args.filter) {
    const preflight = join(SCRIPT_DIR, "integration", "t19.test.ts");
    if (existsSync(preflight)) {
      process.stdout.write("\n## Preflight Health Check (Claude CLI validation)\n");
      await runBunTestFile(preflight, false);
      preflightRan = true;
      aggregateTierResults();

      const preflightFailed = resultRows.some((r) => r.name === "t19" && r.status === "FAIL");
      if (preflightFailed) {
        process.stdout.write("\nPREFLIGHT FAILURE -- skipping remaining Claude-dependent tests\n");
        process.stdout.write("  Fix: ensure claude CLI is authenticated and API is responsive\n");
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

  if (args.runE2e) {
    process.stdout.write("\n");
    process.stdout.write(
      args.parallel > 1
        ? `## E2E Tests (full lifecycle) (parallel=${args.parallel})\n`
        : "## E2E Tests (full lifecycle)\n",
    );
    const e2eFiles = levelFiles("e2e");
    const tuiExcludes = e2eFiles
      .map((f) => basename(f))
      .filter((b) => b.startsWith("t-tui"));
    const nonTuiExcludes = e2eFiles
      .map((f) => basename(f))
      .filter((b) => !b.startsWith("t-tui"));

    await runFilesPartitioned("e2e", args.parallel, tuiExcludes);
    await withStdoutLock(() => undefined);
    aggregateTierResults();

    const tuiPreflight = join(SCRIPT_DIR, "e2e", "t-tui-preflight.serial.test.ts");
    if (existsSync(tuiPreflight)) {
      process.stdout.write("\n## E2E TUI Capability Gate\n");
      await runBunTestFile(tuiPreflight, false);
      aggregateTierResults();

      const tuiPreflightFailed = resultRows.some(
        (r) => r.name.includes("preflight") && r.status === "FAIL",
      );
      if (tuiPreflightFailed) {
        process.stdout.write("\nTUI PREFLIGHT FAILURE -- skipping remaining folded TUI tests\n");
        process.stdout.write("  The terminal substrate is present but broken (e.g. node-pty under\n");
        process.stdout.write("  bun on Windows, microsoft/node-pty #748; or tmux capture empty).\n");
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

  writeVerboseSummary();
  printSummary();
  return failedFiles;
}

try {
  const rc = await main();
  if (cleanupLogDir) rmSync(logDir, { recursive: true, force: true });
  process.exit(rc);
} catch (err) {
  appendFileSync(2, `${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  if (cleanupLogDir) rmSync(logDir, { recursive: true, force: true });
  process.exit(1);
}
