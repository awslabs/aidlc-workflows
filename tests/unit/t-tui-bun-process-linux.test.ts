// Real Linux supervisor/PTY/pidfd controls. Verification uses the shared
// envelopes; separate elapsed-time assertions retain the 8s calibration.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type LinuxProcessIdentity, loadLinuxProcessCalls, parseLinuxProcStat,
  sameLinuxProcess, type SupervisorConfig, type SupervisorStatus,
} from "../harness/tui-bun-process.ts";
import {
  liveCaseTimeoutMs, NATIVE_OUTPUT_DRAIN_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS, NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS,
} from "../harness/test-budget.ts";

const supervisorPath = resolve(import.meta.dir, "../harness/tui-bun-process.ts");
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const CASE_TIMEOUT_MS = liveCaseTimeoutMs(NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS + NATIVE_OUTPUT_DRAIN_TIMEOUT_MS, {
  fixtureMs: 0, startupMs: NATIVE_STARTUP_TIMEOUT_MS,
});

// Test artifacts belong to the main checkout's private tmp/, even in a worktree.
function scratchRoot(): string {
  const checkout = resolve(import.meta.dir, "../..");
  const git = join(checkout, ".git");
  if (!statSync(git).isFile()) return join(checkout, "tmp", "tui-bun-process");
  const gitDir = resolve(checkout, readFileSync(git, "utf8").trim().replace(/^gitdir: /, ""));
  const common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  return join(dirname(common), "tmp", "tui-bun-process");
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
  const deadline = performance.now() + timeout;
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
        timer = setTimeout(() => reject(new Error("supervisor did not exit within cleanup budget")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const fixtureSource = `
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [role, dir, mode] = process.argv.slice(2);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
// Each payload has one writer; existence of the final path means it is complete.
function publish(name, content) {
  const path = join(dir, name);
  writeFileSync(path + ".tmp", content);
  renameSync(path + ".tmp", path);
}
const record = (name) => publish(name, readFileSync("/proc/self/stat"));
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
  const dir = mkdtempSync(join(root, "fixture-"));
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

async function treeReady(fixture: ReturnType<typeof makeConfig>): Promise<LinuxProcessIdentity[]> {
  await until(() => existsSync(join(fixture.dir, "tree-ready")));
  return ["target.stat", "leaf.stat"].map((name) =>
    parseLinuxProcStat(readFileSync(join(fixture.dir, name), "utf8")),
  );
}

function stillExists(identity: LinuxProcessIdentity): boolean {
  try {
    return sameLinuxProcess(identity, parseLinuxProcStat(readFileSync(`/proc/${identity.pid}/stat`, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
    // Do not destroy an uncertain Linux subreaper. Keep its evidence and ownership.
    fixture.proc.unref();
    fixture.proc.terminal?.unref();
    throw error;
  }
}

// Real processes, no live-agent credentials. Unsupported Linux containment is a
// failure, not a green skip. Portable checks remain in t-tui-bun-process.test.ts.
describe.skipIf(process.platform !== "linux")("Linux native supervision fixtures", () => {
  test("pidfd waits preserve exit status, tolerate another reaper, and leave Bun's child status intact", async () => {
    const { dlopen, ptr, read } = await import("bun:ffi");
    const library = await loadLinuxProcessCalls();
    const api = library.symbols;
    // Spawn a real child without registering it with Bun's reaper. posix_spawn
    // returns its error directly and does not run JS in a post-fork child.
    const spawner = dlopen("libc.so.6", {
      posix_spawn: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
      pipe2: { args: ["ptr", "i32"], returns: "i32" },
      read: { args: ["i32", "ptr", "u64"], returns: "i64" },
      __errno_location: { args: [], returns: "ptr" },
    });
    const args = ["/bin/sh", "-c", "exit 37"].map((text) => Buffer.from(`${text}\0`));
    const argv = new BigUint64Array([...args.map((arg) => BigInt(ptr(arg))), 0n]);
    const pid = new Int32Array(1);
    const info = new Int32Array(32);
    const pipe = new Int32Array([-1, -1]);
    let fd: number | undefined;
    let bunChild: Bun.Subprocess | undefined;
    try {
      expect(spawner.symbols.posix_spawn(pid, args[0], null, null, argv, new BigUint64Array(1))).toBe(0);
      fd = api.tui_pidfd_open(pid[0]);
      expect(fd).toBeGreaterThanOrEqual(0);
      bunChild = Bun.spawn(["/bin/sh", "-c", "sleep 0.1; exit 23"], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      await until(() => {
        expect(api.tui_waitid(3, fd!, info, 0x01000005)).toBe(0); // WNOWAIT: retain the child's status.
        return info[4] === pid[0];
      });
      expect(info[6]).toBe(37);
      expect(api.tui_waitid(3, fd, info, 5)).toBe(0); // Consume this child.
      expect(info[4]).toBe(pid[0]);
      expect(info[6]).toBe(37);
      const alreadyReaped = api.tui_waitid(3, fd, info, 5);
      // Unrelated native operations change errno after a wait. Its returned
      // observation must remain ECHILD, bound to the same now-reaped process.
      expect(api.tui_pidfd_signal(-1, 0)).toBe(-9); // EBADF
      expect(alreadyReaped).toBe(-10); // ECHILD
      expect(api.tui_waitid(255, 0, info, 5)).toBe(-22); // EINVAL is not an empty tree.
      expect(await exited(bunChild)).toBe(23);
      const empty = api.tui_waitid(0, 0, info, 0x41000005);
      expect(spawner.symbols.pipe2(pipe, 0x80800)).toBe(0); // O_NONBLOCK | O_CLOEXEC
      expect(spawner.symbols.read(pipe[0], new Uint8Array(1), 1)).toBe(-1n);
      // Real EAGAIN from unrelated I/O cannot replace the kernel's ECHILD.
      expect(read.i32(spawner.symbols.__errno_location()!)).toBe(11);
      expect(empty).toBe(-10);
    } finally {
      try {
        if (fd !== undefined && fd >= 0) {
          const signaled = api.tui_pidfd_signal(fd, 9);
          expect([0, -3]).toContain(signaled);
          await until(() => api.tui_waitid(3, fd!, info, 5) === -10);
          expect(api.tui_close(fd)).toBe(0);
        }
        if (bunChild) {
          if (bunChild.exitCode === null && bunChild.signalCode === null) bunChild.kill("SIGKILL");
          await exited(bunChild);
        }
      } finally {
        for (const descriptor of pipe) if (descriptor >= 0) expect(api.tui_close(descriptor)).toBe(0);
        spawner.close();
        library.close();
      }
    }
  }, CASE_TIMEOUT_MS);

  test("eight simultaneous native trees reap detached orphans during mixed natural exit and stop", async () => {
    const fixtures = Array.from({ length: 8 }, () => launch());
    const errors: unknown[] = [];
    try {
      await Promise.all(fixtures.map(ready));
      for (const fixture of fixtures) release(fixture);
      const identities = await Promise.all(fixtures.map(treeReady));
      for (let i = 0; i < fixtures.length; i++) {
        const orphan = parseLinuxProcStat(readFileSync(`/proc/${identities[i][1].pid}/stat`, "utf8"));
        expect(orphan.ppid).toBe(fixtures[i].proc.pid);
      }
      const started = performance.now();
      for (let i = 0; i < fixtures.length; i++) {
        if (i % 2 === 0) writeFileSync(join(fixtures[i].dir, "finish"), "");
        else stop(fixtures[i]);
      }
      expect(await Promise.all(fixtures.map((fixture) => exited(fixture.proc)))).toEqual(Array(8).fill(0));
      expect(performance.now() - started).toBeLessThan(8_000);
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
      const leaf = parseLinuxProcStat(readFileSync(`/proc/${owned[1].pid}/stat`, "utf8"));
      expect(leaf.ppid).toBe(fixture.proc.pid); // Detached orphan adopted by subreaper.
      expect(JSON.parse(readFileSync(join(fixture.dir, "environment.json"), "utf8"))).toEqual({
        cwd: fixture.dir, term: "xterm-256color", inherited: "inherited-only", tty: [true, true, true],
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
      // Linux PTY reads normally end with EIO (Bun reports 1), while a clean
      // EOF reports 0. Explicit terminal.close() can subsequently emit another
      // 0; inspect this first callback before cleanup closes the terminal.
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
      const started = performance.now();
      stop(fixture);
      expect(await exited(fixture.proc)).toBe(0);
      expect(performance.now() - started).toBeLessThan(8_000);
      expect(readStatus(fixture.config.statusPath)).toMatchObject({
        phase: "stopped", cleanupComplete: true, signal: "SIGKILL",
      });
      for (const process of owned) expect(stillExists(process)).toBe(false);
    } finally { await cleanup(fixture); }
  }, CASE_TIMEOUT_MS);

  test("uncertain cleanup retains the same subreaper until a later authenticated retry gets a fresh budget", async () => {
    const prepared = makeConfig();
    const obstruction = join(prepared.dir, "cleanup-unavailable");
    const program = join(prepared.dir, "recoverable-supervisor.ts");
    writeFileSync(program, `
import { existsSync } from "node:fs";
import { createNativeContainment, runSupervisor } from ${JSON.stringify(supervisorPath)};
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
      // Let the original seven-second budget expire while the condition is now
      // clear. Neither the old marker nor unauthenticated requests may resume it.
      await pause(7_100);
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
      const retryStarted = performance.now();
      writeFileSync(fixture.config.stopPath, JSON.stringify({
        token: fixture.config.token, requestId: randomUUID(), retryToken: suspended.cleanupRetryToken,
      }));
      expect(await exited(fixture.proc)).toBe(1); // Keep the prior failure in the terminal outcome.
      expect(performance.now() - retryStarted).toBeLessThan(8_000);
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
      const started = performance.now();
      daemon.kill("SIGKILL");
      await daemon.exited;
      const final = await until(() => {
        const status = readStatus(fixture.config.statusPath);
        if (status?.phase === "error") throw new Error(status.error);
        return status?.cleanupComplete && status;
      }, NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS);
      expect(performance.now() - started).toBeLessThan(8_000);
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
