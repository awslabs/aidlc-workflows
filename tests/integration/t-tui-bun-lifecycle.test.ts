// Windows runtime coverage; Linux equivalents live in unit/t-tui-bun-process.
// No CLI/model calls or generated distributions.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SupervisorConfig, SupervisorStatus } from "../harness/tui-bun-process.ts";
import {
  liveCaseTimeoutMs, NATIVE_OUTPUT_DRAIN_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS, NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS,
} from "../harness/test-budget.ts";

const supervisor = resolve(import.meta.dir, "../harness/tui-bun-process.ts");
const FINAL_TEXT = "FINAL UTF-8: café 日本語 🧪";
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const CASE_TIMEOUT_MS = liveCaseTimeoutMs(NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS + NATIVE_OUTPUT_DRAIN_TIMEOUT_MS, {
  fixtureMs: 0, startupMs: NATIVE_STARTUP_TIMEOUT_MS,
});

function scratchRoot(): string {
  if (process.env.AIDLC_SUPERVISOR_FIXTURE_ROOT) return process.env.AIDLC_SUPERVISOR_FIXTURE_ROOT;
  const checkout = resolve(import.meta.dir, "../..");
  const git = join(checkout, ".git");
  if (!existsSync(git) || !statSync(git).isFile()) return join(checkout, "tmp", "bun-terminal-driver");
  const gitDir = resolve(checkout, readFileSync(git, "utf8").trim().replace(/^gitdir: /, ""));
  const common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  return join(dirname(common), "tmp", "bun-terminal-driver");
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error; // A partial status write must fail, not masquerade as absent.
  }
}

async function until<T>(read: () => T | undefined | false, label: string, timeout = NATIVE_STARTUP_TIMEOUT_MS): Promise<T> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await pause(20);
  }
  throw new Error(`timed out: ${label}`);
}

interface ProcessWatch {
  present(): boolean;
  close(): void;
}

/** Read-only identity-bound observations; the test never kills a numeric PID. */
async function watchProcess(pid: number): Promise<ProcessWatch> {
  const { dlopen } = await import("bun:ffi");
  const lib = dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
  const handle = lib.symbols.OpenProcess(0x101000, 0, pid);
  if (!handle) throw new Error(`observer OpenProcess(${pid}): ${lib.symbols.GetLastError()}`);
  return {
    present() {
      const state = lib.symbols.WaitForSingleObject(handle, 0);
      if (state === 0) return false;
      if (state === 258) return true;
      throw new Error(`observer WaitForSingleObject: ${lib.symbols.GetLastError()}`);
    },
    close() {
      const result = lib.symbols.CloseHandle(handle);
      const code = result ? 0 : lib.symbols.GetLastError();
      lib.close();
      if (!result) throw new Error(`observer CloseHandle: ${code}`);
    },
  };
}

function targetProgram(dir: string, detached: boolean): string {
  const leaf = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    fs.writeFileSync(${JSON.stringify(join(dir, "leaf.json"))}, JSON.stringify({pid:process.pid}));
    setInterval(() => {}, 1000);
    // Held until owned retirement; natural expiry must not satisfy cleanup.
  `;
  return `
    import { spawn } from "node:child_process";
    import { existsSync, writeFileSync, writeSync } from "node:fs";
    const dir = ${JSON.stringify(dir)};
    const path = (name) => dir + "/" + name;
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    process.stdin.setRawMode(false);
    process.stdin.resume();
    const info = { pid: process.pid, parentPid: process.ppid, cwd: process.cwd(),
      term: process.env.TERM, inherited: process.env.AIDLC_SUPERVISOR_FIXTURE,
      tty: [!!process.stdin.isTTY, !!process.stdout.isTTY, !!process.stderr.isTTY] };
    if (process.platform === "win32") {
      const { dlopen } = await import("bun:ffi");
      const lib = dlopen("kernel32.dll", {
        OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
        IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
        GetConsoleCP: { args: [], returns: "u32" },
        GetConsoleOutputCP: { args: [], returns: "u32" },
        GetStdHandle: { args: ["u32"], returns: "ptr" },
        GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
        CloseHandle: { args: ["ptr"], returns: "i32" },
        GetLastError: { args: [], returns: "u32" },
      });
      const handle = lib.symbols.OpenProcess(0x1000, 0, process.pid);
      const member = new Int32Array(1);
      if (!handle || !lib.symbols.IsProcessInJob(handle, null, member))
        throw new Error("target job query: " + lib.symbols.GetLastError());
      info.jobBound = member[0] === 1;
      info.inputCP = lib.symbols.GetConsoleCP();
      info.outputCP = lib.symbols.GetConsoleOutputCP();
      const inputMode = new Uint32Array(1);
      if (!lib.symbols.GetConsoleMode(lib.symbols.GetStdHandle(0xfffffff6), inputMode))
        throw new Error("target console mode: " + lib.symbols.GetLastError());
      info.inputMode = inputMode[0];
      lib.symbols.CloseHandle(handle);
      lib.close();
    }
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {
      writeFileSync(path("ctrl-c"), "actual target received SIGINT");
      writeSync(1, ${JSON.stringify(`${FINAL_TEXT}\n`)});
      process.exit(23);
    });
    // Only the explicit finish/SIGINT path or owned retirement ends this target.
    if (${detached}) {
      const leaf = spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], {
        detached: true, stdio: "ignore",
      });
      leaf.on("error", (error) => { throw error; });
      leaf.unref();
      while (!existsSync(path("leaf.json"))) await pause(10);
    }
    writeFileSync(path("target.json"), JSON.stringify(info));
    while (!existsSync(path("finish"))) await pause(10);
    const code = Number((await import("node:fs")).readFileSync(path("finish"), "utf8"));
    writeSync(1, ${JSON.stringify(`${FINAL_TEXT}\n`)});
    process.exit(code);
  `;
}

interface TargetInfo {
  pid: number;
  parentPid: number;
  cwd: string;
  term: string;
  inherited: string;
  tty: boolean[];
  jobBound?: boolean;
  inputCP?: number;
  outputCP?: number;
  inputMode?: number;
}

async function session(name: string, detached = false, daemonParent = false) {
  const root = scratchRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, `lifecycle-${name}-`));
  const logRoot = process.env.AIDLC_TEST_LOG_DIR ?? dir;
  const tracePath = join(logRoot, `tui-bun-lifecycle-${name}-${randomUUID()}.ndjson`);
  const trace = (event: string, data: unknown = {}) =>
    appendFileSync(tracePath, `${JSON.stringify({ ts: Date.now(), event, data })}\n`);
  const config: SupervisorConfig = {
    token: randomUUID(), cwd: dir, command: [process.execPath, "-e", targetProgram(dir, detached)],
    statusPath: join(dir, "status.json"), releasePath: join(dir, "release"),
    stopPath: join(dir, "stop"), parentPid: process.pid,
  };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  // For parent death, the test retains the PTY while a short-lived daemon owns
  // the actual supervisor. This exercises the stable parent watch independently
  // of destroying the PTY and its console.
  const daemon = `
    import { readFileSync, writeFileSync } from "node:fs";
    const path = ${JSON.stringify(configPath)};
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.parentPid = process.pid;
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    Bun.spawn([process.execPath, ${JSON.stringify(supervisor)}, "--supervise", path], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    setInterval(() => {}, 1000);
  `;
  const argv = daemonParent
    ? [process.execPath, "-e", daemon]
    : [process.execPath, supervisor, "--supervise", configPath];
  let output = "";
  let rootExit: number | undefined;
  let eof: number | undefined;
  let lastStatus = "";
  const decoder = new TextDecoder();
  trace("pre_spawn", { dir, daemonParent, platform: process.platform, bun: Bun.version });
  const proc = Bun.spawn(argv, {
    env: { ...process.env, TERM: "dumb", AIDLC_SUPERVISOR_FIXTURE: config.token },
    terminal: {
      cols: 90, rows: 24, name: "xterm-256color",
      data(_terminal, data) {
        const text = decoder.decode(data, { stream: true });
        output += text;
        trace("pty_data", { bytes: data.byteLength, text });
      },
      exit(_terminal, code, signal) {
        eof = code;
        output += decoder.decode();
        trace("pty_eof", { code, signal });
      },
    },
  });
  void proc.exited.then((code) => { rootExit = code; trace("root_exit", { code }); });
  trace("spawn", { dir, supervisor, rootPid: proc.pid, daemonParent, platform: process.platform, bun: Bun.version });
  const observers: ProcessWatch[] = [];
  const status = (): SupervisorStatus | undefined => {
    const value = readJson<SupervisorStatus>(config.statusPath);
    if (value) {
      expect(value.token).toBe(config.token);
      if (JSON.stringify(value) !== lastStatus) {
        lastStatus = JSON.stringify(value);
        trace("status", value);
      }
    }
    return value;
  };
  const healthy = (): SupervisorStatus | undefined => {
    const value = status();
    if (value?.phase === "error") throw new Error(`supervisor error: ${value.error}\n${output}`);
    return value;
  };
  const observe = async (pid: number) => {
    const observer = await watchProcess(pid);
    observers.push(observer);
    return observer;
  };
  return {
    config, dir, proc, trace, status, healthy, observe,
    output: () => output,
    release() { writeFileSync(config.releasePath, config.token); },
    stop() { writeFileSync(config.stopPath, randomUUID()); },
    finish(code: number) { writeFileSync(join(dir, "finish"), String(code)); },
    async ready() {
      const value = await until(() => {
        const value = healthy();
        if (rootExit !== undefined) throw new Error(`root exited before ready: ${rootExit}\n${output}`);
        return value?.phase === "ready" && value;
      }, "containment ready");
      if (!daemonParent) expect(value.supervisorPid).toBe(proc.pid);
      expect(value.targetPid).toBeUndefined();
      expect(value.cleanupComplete).toBe(false);
      return value;
    },
    async target() {
      const info = await until(() => {
        healthy();
        return readJson<TargetInfo>(join(dir, "target.json"));
      }, "target setup");
      expect(info.parentPid).toBe(healthy()!.supervisorPid);
      expect(realpathSync(info.cwd)).toBe(realpathSync(dir));
      expect(info.term).toBe("xterm-256color");
      expect(info.inherited).toBe(config.token);
      expect(info.tty).toEqual([true, true, true]);
      if (process.platform === "win32") {
        expect(info.jobBound).toBe(true);
        expect(info.inputCP).toBe(65001);
        expect(info.outputCP).toBe(65001);
        expect(info.inputMode! & 1).toBe(1); // ENABLE_PROCESSED_INPUT: cooked Ctrl-C.
      }
      trace("target_verified", info);
      return info;
    },
    async leaf() {
      const info = await until(() => readJson<{ pid: number }>(join(dir, "leaf.json")), "detached leaf");
      trace("leaf", info);
      return observe(info.pid);
    },
    async completed(phase: "exited" | "stopped", exitCode?: number) {
      await until(() => { healthy(); return rootExit !== undefined; }, "wrapper exit", NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS);
      expect(rootExit).toBe(0);
      const value = healthy()!;
      expect(value.phase).toBe(phase);
      expect(value.cleanupComplete).toBe(true);
      if (exitCode !== undefined) expect(value.exitCode).toBe(exitCode);
      await until(() => eof !== undefined, "PTY EOF and final drain", NATIVE_OUTPUT_DRAIN_TIMEOUT_MS);
      expect(eof).toBe(0);
      trace("complete", { rootExit, eof, status: value });
      return value;
    },
    async dispose() {
      writeFileSync(config.stopPath, randomUUID());
      try {
        await until(() => rootExit !== undefined, "fixture root cleanup", NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS);
        const final = status();
        // On Windows, termination of the console root can terminate the wrapper
        // before final status. Its Job Object must still kill every observed member.
        const kernelCleaned = daemonParent && observers.length >= 3 &&
          observers.every((observer) => !observer.present());
        if (!final?.cleanupComplete && !kernelCleaned) throw new Error(`retaining uncertain fixture: ${dir}`);
        proc.terminal?.close();
        rmSync(dir, { recursive: true, force: true });
      } finally {
        for (const observer of observers) observer.close();
        proc.unref();
        proc.terminal?.unref();
      }
    },
  };
}

type Session = Awaited<ReturnType<typeof session>>;
async function withSession(
  name: string, detached: boolean, daemonParent: boolean, run: (s: Session) => Promise<void>,
) {
  const s = await session(name, detached, daemonParent);
  try { await run(s); } catch (error) {
    s.trace("invariant_failure", { error: errorText(error), status: s.status(), output: s.output() });
    throw error;
  } finally { await s.dispose(); }
}

describe.skipIf(process.platform !== "win32")("Windows native supervisor lifecycle", () => {
  test("readiness gates release; stop wins before launch", async () => {
    await withSession("ready", false, false, async (s) => {
      await s.ready();
      await pause(150);
      expect(existsSync(join(s.dir, "target.json"))).toBe(false);
      expect(s.status()?.phase).toBe("ready");
      s.stop();
      s.release();
      const final = await s.completed("stopped");
      expect(final.targetPid).toBeUndefined();
      expect(existsSync(join(s.dir, "target.json"))).toBe(false);
    });
  }, CASE_TIMEOUT_MS);

  for (const code of [0, 7]) {
    test(`target exit ${code} preserves final UTF-8 through root exit and PTY drain`, async () => {
      await withSession(`exit-${code}`, false, false, async (s) => {
        await s.ready();
        s.release();
        await s.target();
        s.finish(code);
        const final = await s.completed("exited", code);
        expect(final.signal).toBeNull();
        expect(s.output()).toContain(FINAL_TEXT);
      });
    }, CASE_TIMEOUT_MS);
  }

  test("cooked Ctrl-C reaches the actual target and leaves supervision intact", async () => {
    await withSession("ctrl-c", false, false, async (s) => {
      await s.ready();
      s.release();
      await s.target();
      s.proc.terminal!.write("\x03");
      await until(() => existsSync(join(s.dir, "ctrl-c")), "actual target SIGINT");
      await s.completed("exited", 23);
      expect(s.output()).toContain(FINAL_TEXT);
    });
  }, CASE_TIMEOUT_MS);

  for (const requested of [true, false]) {
    test(`${requested ? "explicit stop" : "target exit"} cleans detached descendants without affecting another process`, async () => {
      const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      try {
        await withSession(requested ? "stop-tree" : "exit-tree", true, false, async (s) => {
          await s.ready();
          s.release();
          const target = await s.target();
          const targetWatch = await s.observe(target.pid);
          const leaf = await s.leaf();
          expect(leaf.present()).toBe(true);
          const started = performance.now();
          if (requested) s.stop();
          else s.finish(7);
          await s.completed(requested ? "stopped" : "exited", requested ? undefined : 7);
          expect(performance.now() - started).toBeLessThan(8_000);
          expect(leaf.present()).toBe(false);
          expect(targetWatch.present()).toBe(false);
          expect(unrelated.exitCode).toBeNull();
          expect(unrelated.signalCode).toBeNull();
          s.trace("descendants_gone", { unrelatedPid: unrelated.pid, unrelatedAlive: true });
        });
      } finally {
        unrelated.kill("SIGKILL");
        await unrelated.exited;
      }
    }, CASE_TIMEOUT_MS);
  }

  test("daemon-parent death cleans a detached descendant while the test retains the PTY", async () => {
    await withSession("parent-death", true, true, async (s) => {
      const ready = await s.ready();
      const wrapper = await s.observe(ready.supervisorPid);
      s.release();
      const target = await s.target();
      const targetWatch = await s.observe(target.pid);
      const leaf = await s.leaf();
      const started = performance.now();
      s.proc.kill("SIGKILL"); // Stable Bun subprocess handle of our daemon, not PID lookup.
      await until(() => !leaf.present() && !targetWatch.present() && !wrapper.present(),
        "parent-death wrapper and descendant cleanup", NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS);
      expect(performance.now() - started).toBeLessThan(8_000);
      if (s.status()?.cleanupComplete) expect(s.status()?.phase).toBe("stopped");
      s.trace("parent_death_clean", {
        elapsedMs: performance.now() - started, finalStatus: s.status(),
        kernelCleanup: !s.status()?.cleanupComplete,
      });
    });
  }, CASE_TIMEOUT_MS);

  test("competing target exit and stop still require verified descendant retirement", async () => {
    const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    try {
      for (let iteration = 0; iteration < 6; iteration++) {
        await withSession(`competing-exit-${iteration}`, true, false, async (s) => {
          await s.ready();
          s.release();
          const target = await s.target();
          const targetWatch = await s.observe(target.pid);
          const leaf = await s.leaf();
          const began = performance.now();
          // Both are owned paths: the target can enter ExitProcess while the
          // supervisor is taking its job snapshot and requesting termination.
          s.finish(7);
          s.stop();
          const final = await until(() => {
            const value = s.healthy();
            return value?.cleanupComplete ? value : undefined;
          }, "competing exit cleanup", NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS);
          expect(["exited", "stopped"]).toContain(final.phase);
          await s.completed(final.phase as "exited" | "stopped");
          expect(final.exitCode).toBeNumber();
          expect([1, 7]).toContain(final.exitCode!);
          expect(performance.now() - began).toBeLessThan(8_000);
          expect(targetWatch.present()).toBe(false);
          expect(leaf.present()).toBe(false);
          expect(unrelated.exitCode).toBeNull();
          s.trace("competing_exit_verified", { iteration, supervisorPid: final.supervisorPid, targetPid: target.pid });
        });
      }
    } finally {
      unrelated.kill("SIGKILL"); // Only the subprocess handle created by this test.
      await unrelated.exited;
    }
  }, CASE_TIMEOUT_MS);
});
