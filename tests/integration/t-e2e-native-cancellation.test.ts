// covers: file:tests/lib/e2e-workers.ts
// Real native daemons and ordinary/isolated runners; no models, Node or tmux required.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { bunSessionPaths } from "../harness/tui-bun-backend.ts";
import { getNativeProcessIdentity } from "../harness/tui-process-identity.ts";
import { resolveTuiRuntime } from "../harness/tui-runtime.ts";
import {
  cleanupE2eTransports, type E2eWorker, e2eWorkerEnvironment, finishE2eTemporaryFiles,
} from "../lib/e2e-workers.ts";
import { assertRunnerFixtureImports } from "../lib/runner-fixture-imports.ts";
import { ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord } from "../harness/tui-record-file.ts";
import {
  FILE_CLEANUP_ENV,
  FILE_DEADLINE_ENV,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_RUNTIME_CASE_TIMEOUT_MS,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";

const SOURCE = resolve(import.meta.dir, "../..");
const supported = process.platform === "linux" || process.platform === "win32";
const driver = join(SOURCE, "tests", "harness", "tui-drive.ts");
const backend = join(SOURCE, "tests", "harness", "tui-bun-backend.ts");
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const contexts: Array<{ worker: E2eWorker; env: NodeJS.ProcessEnv; artifacts: string }> = [];
let root: string | undefined;
let preserveRoot = false;

function scratch(): string {
  if (root) return root;
  // Durable evidence belongs to the main checkout, including from a worktree.
  let checkout = SOURCE;
  const marker = join(SOURCE, ".git");
  if (existsSync(marker) && statSync(marker).isFile()) {
    const gitDir = resolve(SOURCE, readFileSync(marker, "utf8").trim().replace(/^gitdir: /, ""));
    checkout = dirname(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
  }
  const parent = join(checkout, "tmp", "combined-test-suite");
  mkdirSync(parent, { recursive: true });
  root = mkdtempSync(join(parent, "native-cancellation-"));
  return root;
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface Owner {
  session: string;
  token: string;
  endpoint: string;
  daemonPid?: number;
  daemonIdentity?: string;
  cleanupComplete?: boolean;
}

function owner(env: NodeJS.ProcessEnv, session: string): Owner {
  return json<Owner>(bunSessionPaths(session, env).record);
}

async function until(check: () => boolean, label: string, timeout = NATIVE_STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}; inspect ${scratch()}`);
    await pause(20);
  }
}

async function runnerWitness(child: Bun.Subprocess, witness: string): Promise<void> {
  const deadline = Date.now() + NATIVE_STARTUP_TIMEOUT_MS;
  while (!existsSync(witness)) {
    if (child.exitCode !== null) {
      throw new Error(`inner native runner exited (${child.exitCode}) before native test witness`);
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for native test witness with inner runner still active");
    // Exit wakes this immediately, even if the next poll has not fired.
    await Promise.race([child.exited, pause(20)]);
  }
}

function runnerEvidence(mode: string) {
  // Capture the OUTER directory before the nested runner sets its own. The
  // fallback is a sibling of scratch(), so afterEach cannot remove it either.
  const outer = resolve(process.env.AIDLC_TEST_LOG_DIR ?? join(dirname(scratch()), "native-cancellation-logs"));
  mkdirSync(outer, { recursive: true });
  const directory = mkdtempSync(join(outer, `native-runner-${mode}-`));
  const stdout = join(directory, "stdout.log");
  const stderr = join(directory, "stderr.log");
  writeFileSync(stdout, "", { mode: 0o600 });
  writeFileSync(stderr, "", { mode: 0o600 });
  return {
    directory, stdout, stderr,
    output: () => `--- stdout ---\n${readFileSync(stdout, "utf8")}\n--- stderr ---\n${readFileSync(stderr, "utf8")}`,
  };
}

function retainRunnerReports(fixture: string, evidence: string): string[] {
  const retained: string[] = [];
  const source = join(fixture, "tests", "logs");
  if (!existsSync(source)) return retained; // A module-load failure may precede log setup.
  const copy = (from: string, relative: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) {
        // Keep reports and driver traces, not whole checkouts/retained fixtures
        // or dependency junctions (which may point outside the fixture).
        if (["e2e-workers", "retained-fixtures", "node_modules", ".git"].includes(entry.name)) continue;
        copy(join(from, entry.name), name);
      } else if (entry.isFile() && /\.(log(?:\.before)?|xml|json|ndjson|txt|meta)$/.test(entry.name)) {
        const destination = join(evidence, "inner-logs", name);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(from, entry.name), destination);
        retained.push(join("inner-logs", name));
      }
    }
  };
  copy(source, "");
  return retained;
}

async function drive(env: NodeJS.ProcessEnv, args: string[]) {
  const runtime = resolveTuiRuntime(driver, { env });
  const child = Bun.spawn([runtime.bin, ...runtime.prefix, ...args], {
    env, stdout: "pipe", stderr: "pipe", timeout: NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  appendFileSync(join(process.env.AIDLC_TEST_LOG_DIR ?? scratch(), "native-cancellation.ndjson"),
    `${JSON.stringify({ command: args[0], session: args[2], code, stdout, stderr })}\n`);
  expect(code, `${args[0]}: ${stderr}\n${stdout}`).toBe(0);
  return stdout;
}

function target(): string {
  const path = join(scratch(), "native target.ts");
  if (!existsSync(path)) writeFileSync(path, `
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(42);
process.stdin.setRawMode(true);
process.stdin.resume();
process.on("SIGTERM", () => {}); // Require owned force escalation on POSIX.
process.stdout.write("NATIVE READY\\r\\n");
setInterval(() => {}, 1000);
`);
  return path;
}

async function context(name: string, inherited: NodeJS.ProcessEnv = {}) {
  const artifacts = join(scratch(), name);
  const worker: E2eWorker = { id: 1, root: SOURCE, socket: `native-test-${randomUUID()}` };
  const base: NodeJS.ProcessEnv = {
    ...process.env, ...inherited, AIDLC_TUI_BACKEND: "bun", AIDLC_BUN_BIN: process.execPath,
    AIDLC_NODE_BIN: join(scratch(), "Node-must-not-be-used"),
  };
  delete base.BUN_OPTIONS;
  const env = await e2eWorkerEnvironment(worker, `${name}.test.ts`, artifacts, base);
  const value = { worker, env, artifacts };
  contexts.push(value);
  return value;
}

async function start(env: NodeJS.ProcessEnv, session: string): Promise<Owner> {
  await drive(env, ["start", "--session", session, "--cwd", env.TEMP!,
    "--", process.execPath, target()]);
  await drive(env, ["wait", "--session", session, "--pattern", "NATIVE READY",
    "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
  const record = owner(env, session);
  expect(record.daemonPid).toBeNumber();
  expect(record.daemonIdentity).toBeString();
  expect(await getNativeProcessIdentity(record.daemonPid!)).toBe(record.daemonIdentity!);
  return record;
}

async function retired(env: NodeJS.ProcessEnv, previous: Owner): Promise<void> {
  const record = owner(env, previous.session);
  expect(record.token).toBe(previous.token);
  expect(record.cleanupComplete).toBe(true);
  await drive(env, ["wait-dead", "--session", previous.session, "--timeout-ms", String(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS)]);
  if (previous.daemonPid !== undefined) {
    expect(await getNativeProcessIdentity(previous.daemonPid)).not.toBe(previous.daemonIdentity);
  }
}

async function archived(env: NodeJS.ProcessEnv, artifacts: string, previous: Owner): Promise<void> {
  const session = basename(bunSessionPaths(previous.session, env).directory);
  const directory = join(artifacts, "tui-bun", session);
  expect(json<Owner>(join(directory, "session.json"))).toMatchObject({
    token: previous.token, cleanupComplete: true,
  });
  expect(json<{ text: string }>(join(directory, "screen.json")).text).toContain("NATIVE READY");
  expect(existsSync(dirname(env.AIDLC_TUI_BUN_ROOT!))).toBe(false);
  if (previous.daemonPid !== undefined) {
    expect(await getNativeProcessIdentity(previous.daemonPid)).not.toBe(previous.daemonIdentity);
  }
}

afterEach(async () => {
  const failures: string[] = [];
  for (const { worker, env, artifacts } of contexts.splice(0)) {
    if (!existsSync(env.TEMP!)) continue; // Explicitly finalized within the test.
    try {
      await cleanupE2eTransports(worker, env);
      if (existsSync(env.TEMP!)) await finishE2eTemporaryFiles(env, artifacts, false);
    } catch (error) { failures.push(String(error)); }
  }
  const retained = root;
  const preserve = preserveRoot;
  root = undefined;
  preserveRoot = false;
  if (failures.length) throw new Error(`native test cleanup unconfirmed; retained ${retained}\n${failures.join("\n")}`);
  if (retained && !preserve) rmSync(retained, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
  });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
}

function runnerFixture(mode: "success" | "timeout" | "cancel" | "capture", witness: string): string {
  const fixture = join(scratch(), "runner");
  for (const path of [
    "tests/run-tests.ts", "tests/gen-coverage-registry.ts", "tests/harness/claude-gate.ts",
    "tests/harness/runner-profile.ts",
    "tests/harness/test-budget.ts",
    "tests/lib/bun-junit-to-meta.ts", "tests/lib/test-sharding.ts",
    "tests/lib/e2e-plan.ts", "tests/lib/e2e-scheduler.ts", "tests/lib/e2e-workers.ts", "tests/lib/e2e-process.ts",
    "tests/lib/e2e-deferred-cleanup.ts",
    "tests/harness/tui-runtime.ts", "tests/harness/tui-drive.ts", "tests/harness/sdk-drive.ts",
    "tests/harness/tui-time-budget.ts",
    "tests/harness/tui-bun-backend.ts", "tests/harness/tui-bun-process.ts",
    "tests/harness/tui-process-identity.ts", "tests/harness/tui-screen.ts",
    "tests/harness/tui-record-file.ts",
    "tests/harness/tui-windows-private-file.ts",
  ]) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    copyFileSync(join(SOURCE, path), join(fixture, path));
  }
  assertRunnerFixtureImports(fixture);
  let dependencies = SOURCE;
  while (!existsSync(join(dependencies, "node_modules"))) {
    if (dirname(dependencies) === dependencies) throw new Error("native cancellation test needs installed dependencies");
    dependencies = dirname(dependencies);
  }
  symlinkSync(realpathSync(join(dependencies, "node_modules")), join(fixture, "node_modules"), "junction");
  mkdirSync(join(fixture, "tests", "e2e"), { recursive: true });
  // An unknown serial family is exclusive, keeping the later file queued even
  // with the normal -P 8 runner invocation.
  writeFileSync(join(fixture, "tests", "e2e", "t01-native.serial.test.ts"), `
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
test("native daemon outlives its test client", async () => {
  const session = "same-session";
  const child = Bun.spawn([process.execPath, process.env.AIDLC_NATIVE_TEST_DRIVER!,
    "start", "--session", session, "--cwd", process.env.TEMP!,
    "--", process.execPath, process.env.AIDLC_NATIVE_TEST_TARGET!], {
    env: process.env, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, stderr + stdout).toBe(0);
  // The witness means the target is on screen: a cancel sent before the
  // target draws would archive an empty screen.
  const ready = Bun.spawn([process.execPath, process.env.AIDLC_NATIVE_TEST_DRIVER!,
    "wait", "--session", session, "--pattern", "NATIVE READY",
    "--stable-ms", "0", "--timeout-ms", "${NATIVE_STARTUP_TIMEOUT_MS}"], {
    env: process.env, stdout: "pipe", stderr: "pipe",
  });
  const [readyCode, readyOut, readyErr] = await Promise.all([
    ready.exited, new Response(ready.stdout).text(), new Response(ready.stderr).text(),
  ]);
  expect(readyCode, readyErr + readyOut).toBe(0);
  const { bunSessionPaths } = await import("../harness/tui-bun-backend.ts");
  const record = JSON.parse(readFileSync(bunSessionPaths(session).record, "utf8"));
  expect(record.cleanupComplete).not.toBe(true);
  ${mode === "capture" ? `
  const { getNativeProcessIdentity } = await import("../harness/tui-process-identity.ts");
  const processes = await Promise.all(Object.entries({
    daemon: record.daemonPid, supervisor: record.supervisorPid, target: record.targetPid,
    fileSupervisor: process.ppid, test: process.pid,
  }).map(async ([role, pid]) => {
    expect(pid).toBeNumber();
    const identity = await getNativeProcessIdentity(pid as number);
    expect(identity).toBeString();
    return { role, pid, identity };
  }));
  ` : ""}
  // Publish whole: the parent reads the witness as soon as its name exists.
  writeFileSync(${JSON.stringify(`${witness}.tmp`)}, JSON.stringify({
    artifacts: process.env.AIDLC_TEST_WORKER_ROOT, temporary: process.env.TEMP,
    root: process.env.AIDLC_TUI_BUN_ROOT, checkout: process.cwd(), record,
    fileDeadlineMs: Number(process.env.AIDLC_TEST_FILE_DEADLINE_MS),
    cleanupReserveMs: Number(process.env.AIDLC_TEST_FILE_CLEANUP_MS),
    ${mode === "capture" ? "processes," : ""}
  }));
  renameSync(${JSON.stringify(`${witness}.tmp`)}, ${JSON.stringify(witness)});
  ${mode === "capture" ? `
  const log = join(process.env.AIDLC_TEST_LOG_DIR!, "t01-native.serial.log");
  // Break capture only once everything already written has been captured, so
  // the marker is the first chunk the runner cannot write (Bun flushes its
  // file header lazily, and a separate header chunk would fail capture first).
  console.log("CAPTURED_BEFORE_NATIVE_CAPTURE_FAILURE");
  while (!readFileSync(log, "utf8").includes("CAPTURED_BEFORE_NATIVE_CAPTURE_FAILURE")) {
    await new Promise((done) => setTimeout(done, 20));
  }
  renameSync(log, log + ".before");
  mkdirSync(log);
  console.log("OUTPUT_AFTER_NATIVE_CAPTURE_FAILURE");
  ` : ""}
  ${mode === "success" ? "" : "await new Promise(() => {});"}
}, ${NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS});
`);
  if (mode !== "success") {
    writeFileSync(join(fixture, "tests", "e2e", "t02-later.test.ts"),
      'import { test, expect } from "bun:test"; test("later", () => expect(true).toBe(true));');
  }
  writeFileSync(join(fixture, ".gitignore"), "node_modules/\ntests/logs/\n");
  git(fixture, ["init", "-q"]);
  git(fixture, ["add", "-A"]);
  git(fixture, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "native fixture"]);
  return fixture;
}

describe.skipIf(!supported)("isolated worker native cancellation", () => {
  test("file roots override inherited namespaces and need no Node or tmux to clean up", async () => {
    const outside = await context("unrelated");
    const first = await context("first", { AIDLC_TUI_BUN_ROOT: outside.env.AIDLC_TUI_BUN_ROOT });
    const second = await context("second");
    expect(new Set([outside, first, second].map(({ env }) => env.AIDLC_TUI_BUN_ROOT)).size).toBe(3);
    expect(first.env.AIDLC_TUI_BUN_ROOT!.startsWith(first.env.TEMP!)).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(first.env.AIDLC_TUI_BUN_ROOT!).mode & 0o077).toBe(0);
    }
    // All invoked native executables have absolute paths. An empty PATH makes
    // an accidental Node/tmux fallback fail even on a fully equipped developer host.
    first.env.PATH = "";
    const session = "same-session";
    const unrelated = await start(outside.env, session);
    const owned = await start(first.env, session);
    await expect(cleanupE2eTransports(first.worker, {
      ...first.env, AIDLC_TUI_BUN_ROOT: outside.env.AIDLC_TUI_BUN_ROOT,
    })).rejects.toThrow("artifact scope");
    await expect(finishE2eTemporaryFiles(first.env, first.artifacts, false)).rejects.toThrow("unconfirmed");
    await cleanupE2eTransports(first.worker, first.env);
    await retired(first.env, owned);
    await finishE2eTemporaryFiles(first.env, first.artifacts, false);
    expect(existsSync(first.env.TEMP!)).toBe(false);
    await archived(first.env, first.artifacts, owned);
    expect(await drive(outside.env, ["capture", "--session", session])).toContain("NATIVE READY");
    expect(await getNativeProcessIdentity(unrelated.daemonPid!)).toBe(unrelated.daemonIdentity!);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test.each(["success", "timeout", "cancel", "capture"] as const)(
    "real runner cleans native sessions after %s and preserves unrelated sessions",
    async (mode) => {
      const outside = await context("unrelated");
      const unrelated = await start(outside.env, "same-session");
      const witness = join(scratch(), "started.json");
      const cancel = join(scratch(), "cancel");
      const fixture = runnerFixture(mode, witness);
      const runnerEnv: NodeJS.ProcessEnv = {
        ...process.env, AIDLC_TEST_PACKAGE_READY: "1", AIDLC_TUI_BACKEND: "bun",
        AIDLC_BUN_BIN: process.execPath, AIDLC_NODE_BIN: outside.env.AIDLC_NODE_BIN,
        AIDLC_TUI_BUN_ROOT: outside.env.AIDLC_TUI_BUN_ROOT,
        AIDLC_NATIVE_TEST_DRIVER: driver, AIDLC_NATIVE_TEST_TARGET: target(), AIDLC_KEEP_TEMP: "0",
      };
      delete runnerEnv.BUN_OPTIONS;
      const evidence = runnerEvidence(mode);
      const child = Bun.spawn([process.execPath, join(fixture, "tests", "run-tests.ts"),
        "--debug", "-P", "8", "--e2e", "--no-llm",
        ...(mode === "capture" ? [] : [
          "--isolated-e2e",
          "--e2e-file-timeout", mode === "timeout" ? "15" : String(NATIVE_FIXTURE_SETUP_TIMEOUT_MS / 1000),
          "--e2e-cancel-file", cancel,
        ]),
      ], {
        cwd: fixture, env: runnerEnv,
        // Direct files retain partial output even if the parent test is stopped,
        // and observing child exit never waits for an inherited pipe to close.
        stdout: Bun.file(evidence.stdout), stderr: Bun.file(evidence.stderr),
        timeout: NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
      });
      const adopt = () => {
        const observed = json<{
          artifacts: string; temporary: string; root: string; checkout: string; record: Owner;
          fileDeadlineMs: number; cleanupReserveMs: number;
          processes?: Array<{ role: string; pid: number; identity: string }>;
        }>(witness);
        const env = {
          ...runnerEnv, AIDLC_TEST_WORKER_ROOT: observed.artifacts, AIDLC_TUI_BUN_ROOT: observed.root,
          TEMP: observed.temporary, TMP: observed.temporary, TMPDIR: observed.temporary,
        };
        return { observed, env };
      };
      const failures: unknown[] = [];
      try {
        await runnerWitness(child, witness);
        const { observed, env } = adopt();
        expect(observed.root).not.toBe(outside.env.AIDLC_TUI_BUN_ROOT!);
        if (mode === "cancel") writeFileSync(cancel, "cancel");
        if (mode === "capture") {
          expect(observed.checkout).toBe(fixture);
          expect(observed.temporary).not.toBe(outside.env.TEMP!);
          await until(() => child.exitCode !== null, "ordinary runner exit after capture failure", NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
        }
        const code = await child.exited;
        const output = evidence.output();
        writeFileSync(join(scratch(), "runner.log"), output);
        expect(code, output).toBe(mode === "success" ? 0 : 1);
        const log = /Verbose mode: logging to (.+)/.exec(output)?.[1].trim();
        expect(log, output).toBeString();
        if (mode === "capture") {
          expect(output).toContain("OUTPUT_AFTER_NATIVE_CAPTURE_FAILURE");
          expect(output).toContain("test output capture failed");
          expect(output).not.toContain("=== START t02-later.test.ts");
          expect(statSync(join(log!, "t01-native.serial.log")).isDirectory()).toBe(true);
          expect(readFileSync(join(log!, "t01-native.serial.log.before"), "utf8"))
            .toContain("Status: RUNNING");
          expect(readFileSync(join(log!, "summary.txt"), "utf8")).toContain("Result: FAIL");
          expect(readFileSync(join(log!, "summary.txt"), "utf8")).not.toContain("Test files: 0");
          expect(readFileSync(join(log!, "failures.txt"), "utf8")).toContain("test output capture failed");
        } else {
          const report = json<{
            state: string; coverageComplete: boolean;
            files: Array<{ state: string; cases: { passed: number }; retainedFixtures?: string; cleanupError?: string }>;
          }>(join(log!, "e2e-results.json"));
          expect(report.state).toBe({ success: "COMPLETE", timeout: "FAIL", cancel: "INTERRUPTED" }[mode]);
          expect(report.files[0].state).toBe({ success: "PASS", timeout: "TIMED_OUT", cancel: "INCOMPLETE" }[mode]);
          expect(report.files[0].cleanupError).toBeUndefined();
          expect(readFileSync(join(log!, "summary.txt"), "utf8")).not.toContain("Test files: 0");
          if (mode === "success") {
            expect(report.files[0].cases.passed).toBe(1);
            expect(report.coverageComplete).toBe(true);
          } else {
            expect(report.coverageComplete).toBe(false);
            expect(existsSync(report.files[0].retainedFixtures!)).toBe(true);
            expect(readFileSync(join(log!, "failures.txt"), "utf8").trim()).not.toBe("");
            if (mode === "cancel") expect(report.files[1].state).toBe("INCOMPLETE");
          }
        }
        if (mode === "capture") await retired(env, observed.record);
        else await archived(env, observed.artifacts, observed.record);
        if (mode === "timeout") {
          // Timeout must consume the work portion, leaving the original tail
          // for observed native retirement. A fresh post-timeout budget fails
          // this assertion even when it eventually manages to kill the daemon.
          expect(observed.cleanupReserveMs).toBeGreaterThan(0);
          const archivedSession = join(observed.artifacts, "tui-bun",
            basename(bunSessionPaths(observed.record.session, env).directory));
          const tracePaths = readdirSync(observed.artifacts)
            .filter((file) => file.startsWith("tui-bun-") && file.endsWith(".ndjson"))
            .map((file) => join(observed.artifacts, file));
          if (existsSync(join(archivedSession, "trace.ndjson"))) tracePaths.push(join(archivedSession, "trace.ndjson"));
          const trace = tracePaths.flatMap((path) => readFileSync(path, "utf8")
            .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
          const closed = trace.find((event) => event.event === "closed" && event.session === observed.record.session);
          expect(closed).toBeDefined();
          expect(Date.parse(closed.ts)).toBeLessThan(observed.fileDeadlineMs);
        }
        if (mode === "capture") {
          expect(observed.processes?.map(({ role }) => role)).toEqual([
            "daemon", "supervisor", "target", "fileSupervisor", "test",
          ]);
          const retirement = await Promise.all(observed.processes!.map(async (entry) => ({
            ...entry, after: await getNativeProcessIdentity(entry.pid),
          })));
          writeFileSync(join(evidence.directory, "retirement.json"), `${JSON.stringify(retirement, null, 2)}\n`);
          for (const entry of retirement) expect(entry.after, entry.role).not.toBe(entry.identity);
        } else {
          expect(existsSync(observed.temporary)).toBe(false);
        }
        expect(await drive(outside.env, ["capture", "--session", "same-session"])).toContain("NATIVE READY");
        expect(await getNativeProcessIdentity(unrelated.daemonPid!)).toBe(unrelated.daemonIdentity!);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          if (child.exitCode === null) {
            if (mode === "capture") child.kill("SIGTERM");
            else writeFileSync(cancel, "cancel");
            await child.exited; // The spawn's timeout still bounds this wait.
          }
        } catch (error) { failures.push(error); }
        try {
          // Archive before afterEach can clean fixture directories.
          // Keep successful runs too: timeout/cancel are expected inner failures.
          const files = retainRunnerReports(fixture, evidence.directory);
          writeFileSync(join(evidence.directory, "capture.json"), `${JSON.stringify({
            fixture, pid: child.pid, exitCode: child.exitCode, witness: existsSync(witness), files,
            observed: existsSync(witness) ? json(witness) : undefined,
            junit: files.filter((file) => file.endsWith(".xml")),
            e2eResults: files.filter((file) => file.endsWith("e2e-results.json")),
          }, null, 2)}\n`);
        } catch (error) {
          preserveRoot = true;
          failures.push(new Error(`inner runner evidence copy failed; source retained at ${fixture}`, { cause: error }));
        }
        try {
          // The inner coordinator owns its root registration. If it could not
          // finalize, retire the witnessed session via the authenticated driver,
          // not by granting this process cleanup authority over an arbitrary root.
          if (existsSync(witness)) {
            const { observed, env } = adopt();
            if (existsSync(observed.root)) {
              await drive(env, ["kill", "--session", observed.record.session]);
              await retired(env, observed.record);
              cpSync(observed.root, join(evidence.directory, "native-root"), { recursive: true });
              rmSync(dirname(observed.root), { recursive: true, force: true });
              rmSync(observed.temporary, { recursive: true, force: true });
            }
          }
        } catch (error) { preserveRoot = true; failures.push(error); }
      }
      if (failures.length) {
        throw new AggregateError(failures,
          `${failures.map(String).join("\n")}\nInner runner evidence: ${evidence.directory}\n${evidence.output()}`,
          { cause: failures[0] });
      }
    }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  );

  test("interrupted start before record publication releases its native lock", async () => {
    const value = await context("before-record");
    const session = "before-record";
    const ready = join(scratch(), "locked");
    const program = join(scratch(), "interrupted-start.ts");
    writeFileSync(program, `
import { writeFileSync } from "node:fs";
import { createBunBackend } from ${JSON.stringify(backend)};
await createBunBackend({ fixtureCwd() {
  writeFileSync(${JSON.stringify(ready)}, "lock held, record not published");
  Bun.sleepSync(${NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS});
  return null;
} }).start(${JSON.stringify(session)}, process.env.TEMP!, 80, 24, [process.execPath, "-e", "setInterval(()=>{},1000)"]);
`);
    const child = Bun.spawn([process.execPath, program], {
      env: value.env, stdout: "ignore", stderr: "pipe", timeout: NATIVE_RUNTIME_CASE_TIMEOUT_MS,
    });
    const stderr = new Response(child.stderr).text();
    let cleanup: Promise<void> | undefined;
    try {
      await until(() => existsSync(ready), "start's prepublication lock");
      expect(existsSync(bunSessionPaths(session, value.env).record)).toBe(false);
      let settled = false;
      cleanup = cleanupE2eTransports(value.worker, value.env);
      void cleanup.then(() => { settled = true; }, () => { settled = true; });
      await pause(150);
      expect(settled).toBe(false);
      expect(existsSync(value.env.TEMP!)).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL"); // Owned child handle only.
      await child.exited;
      await stderr;
      if (cleanup) await cleanup;
    }
    await finishE2eTemporaryFiles(value.env, value.artifacts, false);
    expect(existsSync(value.env.TEMP!)).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("published start without daemon readiness retries authenticated cleanup until retirement", async () => {
    const value = await context("delayed-daemon");
    const session = "delayed-daemon";
    const paths = bunSessionPaths(session, value.env);
    ensurePrivateRoot(paths.directory);
    const directoryIdentity = privateDirectoryIdentity(paths.directory);
    const generation = randomUUID();
    // Reproduce the durable state left when a starter exits immediately after
    // spawning. Delay only daemon entry; all IPC, supervision and retirement use
    // the current native implementation and the published ownership token.
    publishTuiRecord(paths.record, {
      schema: 1, backend: "bun", session, token: randomUUID(), endpoint: paths.endpoint,
      directoryIdentity, generation, rootIdentity: privateDirectoryIdentity(paths.root),
      phase: "starting", cwd: value.env.TEMP, command: [process.execPath, target()],
      fixtureCwd: null, width: 80, height: 24,
    }, directoryIdentity);
    const ready = join(scratch(), "daemon-waiting");
    const release = join(scratch(), "release-daemon");
    const program = join(scratch(), "delayed-daemon.ts");
    writeFileSync(program, `
import { existsSync, writeFileSync } from "node:fs";
import { runBunDaemon } from ${JSON.stringify(backend)};
writeFileSync(${JSON.stringify(ready)}, "daemon spawned");
const deadline = Date.now() + ${NATIVE_STARTUP_TIMEOUT_MS};
while (!existsSync(${JSON.stringify(release)})) {
  if (Date.now() > deadline) throw new Error("test did not release daemon");
  await Bun.sleep(20);
}
await runBunDaemon(${JSON.stringify(paths.directory)}, ${JSON.stringify(generation)});
`);
    const daemon = Bun.spawn([process.execPath, program], {
      env: value.env, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(daemon.stderr).text();
    let cleanup: Promise<void> | undefined;
    try {
      await until(() => existsSync(ready), "delayed daemon entry");
      const previous = owner(value.env, session);
      expect(previous.daemonPid).toBeUndefined();
      let settled = false;
      cleanup = cleanupE2eTransports(value.worker, value.env);
      void cleanup.then(() => { settled = true; }, () => { settled = true; });
      await until(() => existsSync(paths.stop), "driver's durable stop request");
      expect(settled).toBe(false);
      expect(existsSync(value.env.TEMP!)).toBe(true);
      writeFileSync(release, "ready");
      await cleanup;
      await daemon.exited;
      await retired(value.env, { ...previous, daemonPid: daemon.pid,
        daemonIdentity: owner(value.env, session).daemonIdentity });
      expect(existsSync(value.env.TEMP!)).toBe(true);
      await finishE2eTemporaryFiles(value.env, value.artifacts, false);
    } finally {
      writeFileSync(release, "ready");
      if (cleanup) await cleanup;
      else await cleanupE2eTransports(value.worker, value.env);
      await daemon.exited;
      await stderr;
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("unconfirmed published startup is bounded and prevents fixture deletion or reuse", async () => {
    const value = await context("unconfirmed");
    const paths = bunSessionPaths("unconfirmed", value.env);
    ensurePrivateRoot(paths.directory);
    const directoryIdentity = privateDirectoryIdentity(paths.directory);
    const record = {
      schema: 1, backend: "bun", session: "unconfirmed", token: randomUUID(),
      directoryIdentity,
      endpoint: paths.endpoint, phase: "starting", cleanupComplete: false,
    };
    publishTuiRecord(paths.record, record, directoryIdentity);
    try {
      // No daemon exists: deliberately exhaust a short injected hard deadline,
      // independently of the generous allowance for real native retirement.
      const calibrationDeadline = Math.min(
        Date.now() + 1000, Number(value.env[FILE_DEADLINE_ENV] ?? Infinity),
      );
      const calibrationEnv = {
        ...value.env,
        [FILE_DEADLINE_ENV]: String(calibrationDeadline),
        [FILE_CLEANUP_ENV]: "0",
      };
      await expect(cleanupE2eTransports(value.worker, calibrationEnv)).rejects.toThrow("unconfirmed");
      expect(Date.now()).toBeGreaterThanOrEqual(calibrationDeadline);
      expect(existsSync(paths.stop)).toBe(true);
      expect(owner(value.env, "unconfirmed").cleanupComplete).toBe(false);
      await expect(finishE2eTemporaryFiles(value.env, value.artifacts, false)).rejects.toThrow("unconfirmed");
      expect(existsSync(value.env.TEMP!)).toBe(true);
      // Invalid evidence rejects promptly on a later file run; it must not be
      // removed as a stale PID or silently replaced by the new environment.
      writeFileSync(paths.record, "{incomplete");
      await expect(e2eWorkerEnvironment(
        value.worker, "unconfirmed.test.ts", value.artifacts, value.env,
      )).rejects.toThrow();
      expect(readFileSync(paths.record, "utf8")).toBe("{incomplete");
      rmSync(paths.record);
      writeFileSync(paths.status, "{}");
      await expect(cleanupE2eTransports(value.worker, value.env)).rejects.toThrow("record missing");
      expect(existsSync(value.env.TEMP!)).toBe(true);
    } finally {
      // This record is synthetic; no daemon was ever spawned for it.
      rmSync(paths.directory, { recursive: true, force: true });
    }
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

  test("expired coordinator cleanup publishes a verified stop instead of skipping all signaling", async () => {
    const value = await context("expired-stop");
    const paths = bunSessionPaths("expired-stop", value.env);
    ensurePrivateRoot(paths.directory);
    const directoryIdentity = privateDirectoryIdentity(paths.directory);
    const token = randomUUID();
    const retryToken = randomUUID();
    publishTuiRecord(paths.record, {
      schema: 1, backend: "bun", session: "expired-stop", token,
      directoryIdentity, rootIdentity: privateDirectoryIdentity(paths.root),
      endpoint: paths.endpoint, phase: "starting", cleanupComplete: false,
    }, directoryIdentity);
    writeFileSync(paths.status, JSON.stringify({ token, cleanupRetryToken: retryToken }));
    const expired = { ...value.env, [FILE_DEADLINE_ENV]: String(Date.now() - 1000) };
    try {
      await expect(cleanupE2eTransports(value.worker, expired)).rejects.toThrow("unconfirmed");
      const requests = readdirSync(paths.stop).map((file) => json<Record<string, unknown>>(join(paths.stop, file)));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        token, retryToken, cleanupDeadlineMs: Number(expired[FILE_DEADLINE_ENV]),
      });
      expect(owner(value.env, "expired-stop").cleanupComplete).toBe(false);
      await expect(finishE2eTemporaryFiles(expired, value.artifacts, false)).rejects.toThrow("unconfirmed");
      expect(existsSync(value.env.TEMP!)).toBe(true);
    } finally {
      // Synthetic unpublished daemon: never claim or signal a numeric PID.
      rmSync(paths.directory, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("reuse retires prior sessions and changed cleanup evidence cannot delete fixtures", async () => {
    const previous = await context("reuse");
    const session = "reuse";
    const running = await start(previous.env, session);
    const nextEnv = await e2eWorkerEnvironment(previous.worker, "reuse.test.ts", previous.artifacts, previous.env);
    await retired(previous.env, running);
    expect(existsSync(previous.env.TEMP!)).toBe(true);
    rmSync(previous.env.TEMP!, { recursive: true, force: true });
    previous.env = nextEnv; // Finalize the shared native namespace only once.
    await cleanupE2eTransports(previous.worker, nextEnv);
    const paths = bunSessionPaths(session, nextEnv);
    const original = readFileSync(paths.record, "utf8");
    try {
      writeFileSync(paths.record, JSON.stringify({ ...JSON.parse(original), token: randomUUID() }));
      await expect(finishE2eTemporaryFiles(nextEnv, previous.artifacts, true)).rejects.toThrow("changed");
      expect(existsSync(nextEnv.TEMP!)).toBe(true);
      // A metadata directory may not redirect cleanup to a different hash/root.
      const wrong = join(nextEnv.AIDLC_TUI_BUN_ROOT!, "a".repeat(32));
      expect(basename(paths.directory)).not.toBe(basename(wrong));
      mkdirSync(wrong);
      writeFileSync(join(wrong, "session.json"), original);
      try {
        await expect(cleanupE2eTransports(previous.worker, nextEnv)).rejects.toThrow("ownership changed");
      } finally { rmSync(wrong, { recursive: true, force: true }); }
    } finally { writeFileSync(paths.record, original); }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
