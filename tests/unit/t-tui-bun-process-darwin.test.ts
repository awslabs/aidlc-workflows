// Real Darwin supervisor/PTY controls, including detached double-fork orphans.
// Non-Darwin invocations remain explicitly skipped.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadDarwinProcessCalls,
  sameDarwinProcess, type SupervisorConfig, type SupervisorStatus,
} from "../harness/tui-bun-process.ts";
import { type DarwinProcessIdentity, readDarwinProcessIdentity } from "../harness/tui-process-identity.ts";
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_OUTPUT_DRAIN_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS,
  liveCaseTimeoutMs,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const supervisorPath = resolve(import.meta.dir, "../harness/tui-bun-process.ts");
const identityPath = resolve(import.meta.dir, "../harness/tui-process-identity.ts");
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const CASE_TIMEOUT_MS = liveCaseTimeoutMs(NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS + NATIVE_OUTPUT_DRAIN_TIMEOUT_MS, {
  fixtureMs: 0, startupMs: NATIVE_STARTUP_TIMEOUT_MS,
});

// Keep fixture code and evidence in this worktree's ignored private tmp/.
function scratchRoot(): string {
  return resolve(import.meta.dir, "../../tmp/tui-bun-process-darwin");
}

const library = process.platform === "darwin" ? await loadDarwinProcessCalls() : undefined;
afterAll(() => library?.close());

function recordedIdentity(path: string): DarwinProcessIdentity {
  const identity = JSON.parse(readFileSync(path, "utf8"));
  return { ...identity, startSec: BigInt(identity.startSec), startUsec: BigInt(identity.startUsec) };
}

function readStatus(path: string): SupervisorStatus | undefined {
  try {
    // Atomic replacement permits absent OR valid JSON; partial JSON is a test failure.
    return JSON.parse(readFileSync(path, "utf8")) as SupervisorStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function until<T>(read: () => T | undefined | false, timeout = NATIVE_STARTUP_TIMEOUT_MS): Promise<T> {
  const allowance = timeout === NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS
    ? remainingCleanupTimeoutMs(timeout)
    : remainingOperationTimeoutMs(timeout)!;
  const deadline = performance.now() + allowance;
  while (performance.now() < deadline) {
    const result = read();
    if (result !== undefined && result !== false) return result;
    await pause(20);
  }
  throw new Error(`fixture condition timed out after ${timeout}ms`);
}

async function exited(child: Bun.Subprocess, timeout = NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("supervisor did not exit within cleanup budget")), remainingCleanupTimeoutMs(timeout));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const fixtureSource = `
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDarwinProcessCalls } from ${JSON.stringify(supervisorPath)};
import { readDarwinProcessIdentity } from ${JSON.stringify(identityPath)};
const library = await loadDarwinProcessCalls();
const [role, dir, mode] = process.argv.slice(2);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
// Each payload has one writer; existence of the final path means it is complete.
function publish(name, content) {
  const path = join(dir, name);
  writeFileSync(path + ".tmp", content);
  renameSync(path + ".tmp", path);
}
const record = (name) => publish(name, JSON.stringify(
  readDarwinProcessIdentity(process.pid, library.symbols),
  (_key, value) => typeof value === "bigint" ? String(value) : value,
));
// Held until explicit finish/signal or owned retirement; expiry cannot prove cleanup.
process.on("SIGTERM", () => {});
if (role === "leaf") {
  record("leaf.stat");
  setInterval(() => {}, 1000);
} else if (role === "middle") {
  const leaf = Bun.spawn([process.execPath, import.meta.path, "leaf", dir, mode], {
    detached: true, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  leaf.unref();
  while (!existsSync(join(dir, "leaf.stat"))) await pause(10);
  process.exit(0);
} else {
  process.on("SIGINT", () => {
    writeFileSync(join(dir, "ctrl-c"), "received");
    process.exit(23);
  });
  record("target.stat");
  publish("environment.json", JSON.stringify({
    cwd: process.cwd(), term: process.env.TERM, inherited: process.env.AIDLC_SUPERVISOR_FIXTURE,
    containment: process.env.AIDLC_TUI_CONTAINMENT,
    tty: [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY],
  }));
  console.log("native fixture: café 日本語");
  const middle = Bun.spawn([process.execPath, import.meta.path, "middle", dir, mode], {
    detached: true, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  await middle.exited; // Leaf has now been orphaned from a detached session.
  writeFileSync(join(dir, "tree-ready"), "");
  while (!existsSync(join(dir, "finish"))) await pause(10);
  if (mode === "signal") process.kill(process.pid, "SIGKILL");
  else process.exit(7);
}
`;

function makeConfig(mode = "natural", override: Partial<SupervisorConfig> = {}) {
  const root = scratchRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = realpathSync(mkdtempSync(join(root, "fixture-")));
  const script = join(dir, "target.ts");
  writeFileSync(script, fixtureSource, { mode: 0o600 });
  const configPath = join(dir, "config.json");
  const config: SupervisorConfig = {
    token: randomUUID(), cwd: dir, command: [process.execPath, script, "target", dir, mode],
    statusPath: join(dir, "status.json"), releasePath: join(dir, "release"),
    stopPath: join(dir, "stop"), parentPid: process.pid, ...override,
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return { dir, config, configPath };
}

function launchConfig(fixture: ReturnType<typeof makeConfig>, program = supervisorPath) {
  let output = "";
  const ptyExits: number[] = [];
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, program, "--supervise", fixture.configPath], {
    env: { ...process.env, TERM: "dumb", AIDLC_SUPERVISOR_FIXTURE: "inherited-only" },
    terminal: {
      cols: 80, rows: 24,
      data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); },
      exit(_terminal, code) { ptyExits.push(code); },
    },
  });
  return { ...fixture, proc, ptyExits, output: () => output };
}

function launch(mode = "natural", override: Partial<SupervisorConfig> = {}) {
  return launchConfig(makeConfig(mode, override));
}

type Fixture = ReturnType<typeof launch>;
const release = (fixture: ReturnType<typeof makeConfig>): void => writeFileSync(fixture.config.releasePath, "");
const stop = (fixture: ReturnType<typeof makeConfig>): void => writeFileSync(fixture.config.stopPath, "");

async function ready(fixture: Fixture): Promise<SupervisorStatus> {
  return until(() => {
    const status = readStatus(fixture.config.statusPath);
    if (status?.phase === "error") throw new Error(`containment setup failed: ${status.error}\n${fixture.output()}`);
    return status?.phase === "ready" && status;
  });
}

async function treeReady(fixture: ReturnType<typeof makeConfig>): Promise<DarwinProcessIdentity[]> {
  await until(() => existsSync(join(fixture.dir, "tree-ready")));
  return ["target.stat", "leaf.stat"].map((name) =>
    recordedIdentity(join(fixture.dir, name)),
  );
}

function stillExists(identity: DarwinProcessIdentity): boolean {
  const current = readDarwinProcessIdentity(identity.pid, library!.symbols);
  return current !== null && sameDarwinProcess(identity, current);
}

async function cleanup(fixture: Fixture): Promise<void> {
  const retryToken = readStatus(fixture.config.statusPath)?.cleanupRetryToken;
  if (retryToken) writeFileSync(fixture.config.stopPath, JSON.stringify({
    token: fixture.config.token, requestId: randomUUID(), retryToken,
  }));
  else stop(fixture);
  try {
    await exited(fixture.proc, NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS);
    const status = readStatus(fixture.config.statusPath);
    if (!status?.cleanupComplete) throw new Error(`cleanup uncertain; retained ${fixture.dir}`);
    fixture.proc.terminal?.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  } catch (error) {
    // Do not destroy an uncertain Darwin supervisor. Keep its evidence and ownership.
    fixture.proc.unref();
    fixture.proc.terminal?.unref();
    throw error;
  }
}

// Real processes, no live-agent credentials. Unsupported Darwin containment is a
// failure, not a green skip. Portable checks remain in t-tui-bun-process.test.ts.
describe.skipIf(process.platform !== "darwin")("Darwin native supervision fixtures", () => {
  test("native process identity rejects PID reuse while preserving identity across reparenting", () => {
    const identity = readDarwinProcessIdentity(process.pid, library!.symbols)!;
    expect(identity.pid).toBe(process.pid);
    expect(identity.ppid).toBe(process.ppid);
    expect(identity.uid).toBe(process.getuid!());
    expect(sameDarwinProcess(identity, { ...identity, ppid: 1 })).toBe(true);
    expect(sameDarwinProcess(identity, { ...identity, startUsec: identity.startUsec + 1n })).toBe(false);
    expect(sameDarwinProcess(identity, { ...identity, startSec: identity.startSec + 1n })).toBe(false);
  });

  test("eight simultaneous native trees reap detached orphans during mixed natural exit and stop", async () => {
    const fixtures = Array.from({ length: 8 }, () => launch());
    const errors: unknown[] = [];
    try {
      await Promise.all(fixtures.map(ready));
      for (const fixture of fixtures) release(fixture);
      const identities = await Promise.all(fixtures.map(treeReady));
      for (let i = 0; i < fixtures.length; i++) {
        const orphan = readDarwinProcessIdentity(identities[i][1].pid, library!.symbols)!;
        expect(orphan.ppid).toBe(1);
        expect(orphan.status).not.toBe(5);
      }
      for (let i = 0; i < fixtures.length; i++) {
        if (i % 2 === 0) writeFileSync(join(fixtures[i].dir, "finish"), "");
        else stop(fixtures[i]);
      }
      expect(await Promise.all(fixtures.map((fixture) => exited(fixture.proc)))).toEqual(Array(8).fill(0));
      for (let i = 0; i < fixtures.length; i++) {
        expect(readStatus(fixtures[i].config.statusPath)).toMatchObject({
          phase: i % 2 === 0 ? "exited" : "stopped", cleanupComplete: true,
          ...(i % 2 === 0 ? { exitCode: 7, signal: null } : { signal: "SIGKILL" }),
        });
        for (const identity of identities[i]) expect(stillExists(identity)).toBe(false);
      }
    } catch (error) {
      errors.push(error);
    } finally {
      const results = await Promise.allSettled(fixtures.map(cleanup));
      errors.push(...results.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
    }
    if (errors.length) throw new AggregateError(errors, "concurrent supervision or cleanup failed");
  }, CASE_TIMEOUT_MS);

  test("ready gates launch; release inherits PTY/cwd/env; natural exit reaps detached orphans", async () => {
    const fixture = launch();
    const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    try {
      const status = await ready(fixture);
      expect(status).toMatchObject({ token: fixture.config.token, supervisorPid: fixture.proc.pid, cleanupComplete: false });
      expect(status.targetPid).toBeUndefined();
      expect(existsSync(join(fixture.dir, "target.stat"))).toBe(false);
      fixture.proc.kill("SIGINT"); // Wrapper survives before any real target exists.
      await pause(100);
      expect(fixture.proc.exitCode).toBeNull();
      expect(existsSync(join(fixture.dir, "target.stat"))).toBe(false);
      release(fixture);
      const owned = await treeReady(fixture);
      const leaf = readDarwinProcessIdentity(owned[1].pid, library!.symbols)!;
      expect(leaf.ppid).toBe(1); // Detached orphan reparents to launchd, not the supervisor.
      expect(leaf.status).not.toBe(5);
      expect(JSON.parse(readFileSync(join(fixture.dir, "environment.json"), "utf8"))).toEqual({
        cwd: fixture.dir, term: "xterm-256color", inherited: "inherited-only",
        containment: expect.stringMatching(/^[a-f0-9-]{36}$/), tty: [true, true, true],
      });
      await until(() => fixture.output().includes("café 日本語"));
      writeFileSync(join(fixture.dir, "finish"), "");
      expect(await exited(fixture.proc)).toBe(0);
      expect(readStatus(fixture.config.statusPath)).toMatchObject({
        phase: "exited", targetPid: owned[0].pid, exitCode: 7, signal: null, cleanupComplete: true,
      });
      for (const process of owned) expect(stillExists(process)).toBe(false);
      expect(unrelated.exitCode).toBeNull();
      // PTY EOF is a separate lifecycle value, never the target's exit code (7).
      await until(() => fixture.ptyExits.length > 0);
      // PTY hangup/EOF is independent of the target exit. Inspect its first
      // callback before cleanup explicitly closes the terminal.
      expect(fixture.ptyExits).toHaveLength(1);
      expect([0, 1]).toContain(fixture.ptyExits[0]);
    } finally {
      unrelated.kill("SIGKILL");
      await unrelated.exited;
      await cleanup(fixture);
    }
  }, CASE_TIMEOUT_MS);

  test("stop before release never launches the command", async () => {
    const fixture = launch();
    try {
      await ready(fixture);
      stop(fixture);
      release(fixture); // Stop wins if both markers exist.
      expect(await exited(fixture.proc)).toBe(0);
      const status = readStatus(fixture.config.statusPath)!;
      expect(status.phase).toBe("stopped");
      expect(status.cleanupComplete).toBe(true);
      expect(status.targetPid).toBeUndefined();
      expect(status.exitCode).toBeUndefined();
      expect(existsSync(join(fixture.dir, "target.stat"))).toBe(false);
    } finally { await cleanup(fixture); }
  }, CASE_TIMEOUT_MS);

  test("stop bounds cleanup of TERM-resistant detached descendants to eight seconds", async () => {
    const fixture = launch();
    try {
      await ready(fixture);
      release(fixture);
      const owned = await treeReady(fixture);
      stop(fixture);
      expect(await exited(fixture.proc)).toBe(0);
      expect(readStatus(fixture.config.statusPath)).toMatchObject({
        phase: "stopped", cleanupComplete: true, signal: "SIGKILL",
      });
      for (const process of owned) expect(stillExists(process)).toBe(false);
    } finally { await cleanup(fixture); }
  }, CASE_TIMEOUT_MS);

  test("uncertain cleanup retains the same supervisor until a later authenticated retry gets a fresh budget", async () => {
    const prepared = makeConfig();
    const obstruction = join(prepared.dir, "cleanup-unavailable");
    const advanceClock = join(prepared.dir, "advance-cleanup-clock");
    const program = join(prepared.dir, "recoverable-supervisor.ts");
    writeFileSync(program, `
import { existsSync } from "node:fs";
import { createNativeContainment, runSupervisor } from ${JSON.stringify(supervisorPath)};
const realNow = performance.now.bind(performance);
Object.defineProperty(performance, "now", { configurable: true, value: () =>
  realNow() + (existsSync(${JSON.stringify(advanceClock)}) ? ${NATIVE_PROCESS_CLEANUP_TIMEOUT_MS} + 1 : 0),
});
await runSupervisor(process.argv[3], async (parentPid) => {
  const owned = await createNativeContainment(parentPid);
  return { ...owned, sweep(force, targetPid, deadline) {
    if (existsSync(${JSON.stringify(obstruction)})) throw new Error("temporary cleanup observation unavailable");
    return owned.sweep(force, targetPid, deadline);
  }};
});
`, { mode: 0o600 });
    const fixture = launchConfig(prepared, program);
    try {
      const initial = await ready(fixture);
      release(fixture);
      const owned = await treeReady(fixture);
      writeFileSync(obstruction, "");
      stop(fixture);
      const suspended = await until(() => {
        const status = readStatus(fixture.config.statusPath);
        return status?.cleanupRetryToken ? status : undefined;
      });
      expect(suspended).toMatchObject({ supervisorPid: initial.supervisorPid, phase: "error", cleanupComplete: false });
      expect(suspended.error).toContain("temporary cleanup observation unavailable");
      rmSync(obstruction);
      // Advance the child's clock beyond the original cleanup budget while
      // keeping its processes alive. Unauthenticated requests cannot restart it.
      writeFileSync(advanceClock, "expire the original budget");
      for (const request of [
        "",
        JSON.stringify({ token: randomUUID(), requestId: randomUUID(), retryToken: suspended.cleanupRetryToken }),
        JSON.stringify({ token: fixture.config.token, requestId: randomUUID(), retryToken: randomUUID() }),
      ]) {
        writeFileSync(fixture.config.stopPath, request);
        await pause(100);
        expect(fixture.proc.exitCode).toBeNull();
        expect(readStatus(fixture.config.statusPath)).toMatchObject({
          cleanupComplete: false, cleanupRetryToken: suspended.cleanupRetryToken,
        });
        for (const process of owned) expect(stillExists(process)).toBe(true);
      }
      writeFileSync(fixture.config.stopPath, JSON.stringify({
        token: fixture.config.token, requestId: randomUUID(), retryToken: suspended.cleanupRetryToken,
      }));
      expect(await exited(fixture.proc)).toBe(1); // Keep the prior failure in the terminal outcome.
      expect(readStatus(fixture.config.statusPath)).toMatchObject({
        supervisorPid: initial.supervisorPid, cleanupComplete: true, phase: "error",
      });
      expect(readStatus(fixture.config.statusPath)?.cleanupRetryToken).toBeUndefined();
      for (const process of owned) expect(stillExists(process)).toBe(false);
    } finally {
      rmSync(obstruction, { force: true });
      await cleanup(fixture);
    }
  }, CASE_TIMEOUT_MS);

  test("cooked Ctrl-C reaches the real target while wrapper survives descendant cleanup", async () => {
    const fixture = launch();
    try {
      await ready(fixture);
      release(fixture);
      const owned = await treeReady(fixture);
      fixture.proc.terminal!.write("\x03");
      await until(() => existsSync(join(fixture.dir, "ctrl-c")));
      expect(await exited(fixture.proc)).toBe(0);
      expect(readStatus(fixture.config.statusPath)).toMatchObject({
        phase: "exited", exitCode: 23, signal: null, cleanupComplete: true,
      });
      for (const process of owned) expect(stillExists(process)).toBe(false);
    } finally { await cleanup(fixture); }
  }, CASE_TIMEOUT_MS);

  test("signal termination is recorded independently of wrapper exit and PTY EOF", async () => {
    const fixture = launch("signal");
    try {
      await ready(fixture);
      release(fixture);
      const owned = await treeReady(fixture);
      writeFileSync(join(fixture.dir, "finish"), "");
      expect(await exited(fixture.proc)).toBe(0);
      expect(readStatus(fixture.config.statusPath)).toMatchObject({
        phase: "exited", signal: "SIGKILL", cleanupComplete: true,
      });
      for (const process of owned) expect(stillExists(process)).toBe(false);
    } finally { await cleanup(fixture); }
  }, CASE_TIMEOUT_MS);

  test("wrong parent identity fails closed before ready or target spawn", async () => {
    const fixture = launch("natural", { parentPid: process.pid + 1 });
    try {
      release(fixture);
      expect(await exited(fixture.proc)).toBe(1);
      const status = readStatus(fixture.config.statusPath)!;
      expect(status.phase).toBe("error");
      expect(status.error).toContain("parent identity");
      expect(status.targetPid).toBeUndefined();
      expect(existsSync(join(fixture.dir, "target.stat"))).toBe(false);
    } finally { await cleanup(fixture); }
  }, CASE_TIMEOUT_MS);

  test("daemon SIGKILL triggers cleanup even without a PTY hangup", async () => {
    const fixture = makeConfig();
    const daemonPath = join(fixture.dir, "daemon.ts");
    writeFileSync(daemonPath, `
      import { readFileSync, writeFileSync } from "node:fs";
      const [supervisor, path] = process.argv.slice(2);
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.parentPid = process.pid;
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
      Bun.spawn([process.execPath, supervisor, "--supervise", path], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      setInterval(() => {}, 1000);
    `, { mode: 0o600 });
    const daemon = Bun.spawn([process.execPath, daemonPath, supervisorPath, fixture.configPath], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    try {
      await until(() => {
        const status = readStatus(fixture.config.statusPath);
        if (status?.phase === "error") throw new Error(status.error);
        return status?.phase === "ready";
      });
      release(fixture);
      const owned = await treeReady(fixture);
      daemon.kill("SIGKILL");
      await daemon.exited;
      const final = await until(() => {
        const status = readStatus(fixture.config.statusPath);
        if (status?.phase === "error") throw new Error(status.error);
        return status?.cleanupComplete && status;
      }, NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS);
      expect(final.phase).toBe("stopped");
      for (const process of owned) expect(stillExists(process)).toBe(false);
    } finally {
      stop(fixture);
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill("SIGKILL");
        await daemon.exited;
      }
      const status = await until(() => {
        const current = readStatus(fixture.config.statusPath);
        return (current?.cleanupComplete || current?.phase === "error") && current;
      }, NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS);
      expect(status, `cleanup uncertain; retained ${fixture.dir}: ${status.error}`).toMatchObject({ cleanupComplete: true });
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);
});
