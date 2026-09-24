import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync, closeSync, openSync, readFileSync, writeFileSync,
} from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCleanupDeadlineMs, publishSupervisorStop, type SupervisorConfig, type SupervisorStatus, type SupervisorStopRequest } from "./tui-bun-process.ts";
import { physicalTuiText, type TuiSnapshot, type TuiTextLayout, type TuiTextViews } from "./tui-screen.ts";
import { acquireNativeLock, getNativeProcessIdentity } from "./tui-process-identity.ts";
import { tuiOperationDeadline } from "./tui-time-budget.ts";
import {
  assertDirectoryIdentity, type DirectoryIdentity, ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord, readPrivateRecord,
} from "./tui-record-file.ts";
import {
  remainingCleanupTimeoutMs,
  NATIVE_OUTPUT_DRAIN_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_PROCESS_IDENTITY_TIMEOUT_MS,
  NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS,
  NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "./test-budget.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REQUEST_LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const RPC_TIMEOUT = NATIVE_STARTUP_TIMEOUT_MS;
const STARTUP_DEADLINE_ENV = "AIDLC_TUI_STARTUP_DEADLINE_MS";
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function drainBeforeDeadline<T>(
  work: Promise<T>, deadline: number, message = "native terminal output drain timed out",
): Promise<T> {
  if (Date.now() >= deadline) {
    void work.catch(() => {}); // The already-started operation still owns its timer/handles.
    throw new Error(message);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work,
      new Promise<never>((_accept, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { reject(new Error(message)); return; }
        timer = setTimeout(() => reject(new Error(message)), remaining);
      }),
    ]);
    if (Date.now() >= deadline) throw new Error(message);
    return result;
  } finally { if (timer) clearTimeout(timer); }
}

type Phase = "starting" | "running" | "exited" | "stopped" | "error";
interface SessionRecord {
  schema: 1;
  backend: "bun";
  session: string;
  token: string;
  generation: string;
  endpoint: string;
  rootIdentity: DirectoryIdentity;
  directoryIdentity: DirectoryIdentity;
  daemonPid?: number;
  daemonIdentity?: string;
  phase: Phase;
  cwd: string;
  command: string[];
  fixtureCwd: string | null;
  width: number;
  height: number;
  windowsVerbatimArguments?: boolean;
  supervisorPid?: number;
  targetPid?: number;
  targetExitCode?: number | null;
  targetSignal?: string | null;
  ptyExitCode?: number;
  cleanupComplete?: boolean;
  error?: string;
}

interface Request {
  id: string;
  token: string;
  method: "capture" | "send" | "paste" | "resize" | "kill" | "status";
  args?: Record<string, unknown>;
}
interface Reply { id: string; ok: boolean; result?: unknown; error?: string }

export interface BunBackendOptions {
  fixtureCwd(cwd: string, command: string[]): string | null;
  windowsCommand?(command: string[]): {
    file: string; args: string[]; windowsVerbatimArguments?: boolean;
  };
}

export function bunSessionPaths(session: string, env: NodeJS.ProcessEnv = process.env) {
  if (!session || session.length > 1000) throw new Error("terminal session name must contain 1..1000 characters");
  const root = resolve(env.AIDLC_TUI_BUN_ROOT || join(tmpdir(), "aidlc-bun-tui"));
  const hash = createHash("sha256").update(`${homedir()}\0${root}\0${session}`).digest("hex").slice(0, 32);
  const directory = join(root, hash);
  // Fixed short socket paths also work with macOS's smaller Unix socket limit.
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\aidlc-bun-${hash}`
    : join("/tmp", `aidlc-bun-${process.getuid?.() ?? "user"}-${hash}.sock`);
  return {
    root, directory, endpoint,
    record: join(directory, "session.json"),
    snapshot: join(directory, "screen.json"),
    status: join(directory, "supervisor.json"),
    release: join(directory, "release"),
    stop: join(directory, "stop"),
  };
}

function atomicJson(path: string, value: unknown): void {
  publishTuiRecord(path, value);
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function stopRequest(record: SessionRecord, statusPath: string, cleanupDeadlineMs?: number): SupervisorStopRequest {
  const status = readJson<SupervisorStatus>(statusPath);
  return {
    token: record.token, requestId: randomUUID(),
    retryToken: status?.token === record.token ? status.cleanupRetryToken : undefined,
    cleanupDeadlineMs,
  };
}

function recordFor(session: string, env: NodeJS.ProcessEnv = process.env): SessionRecord | null {
  const paths = bunSessionPaths(session, env);
  // Even absent-session queries must refuse an occupied unsafe namespace.
  try { privateDirectoryIdentity(paths.root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let record: SessionRecord;
  try { record = readPrivateRecord<SessionRecord>(paths.directory, paths.record); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (
    record?.schema !== 1 || record.backend !== "bun" ||
    record.session !== session || record.endpoint !== paths.endpoint ||
    typeof record.token !== "string" || record.token.length < 20
  ) throw new Error(`invalid native terminal record: ${paths.record}`);
  return record;
}

function finished(record: SessionRecord): boolean {
  return record.cleanupComplete === true;
}

/** Publish through the same private-directory and generation checks as the
 * client, even when there is no time left to start a cleanup subprocess. */
export function requestBunSessionStop(
  session: string, env: NodeJS.ProcessEnv = process.env, deadlineMs?: number,
): string | null {
  const record = recordFor(session, env);
  if (!record) return null;
  if (!finished(record)) {
    const paths = bunSessionPaths(session, env);
    publishSupervisorStop(paths.stop, stopRequest(record, paths.status,
      nativeCleanupDeadlineMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, deadlineMs, env)));
  }
  return record.token;
}

async function daemonAlive(record: SessionRecord, timeoutMs = NATIVE_PROCESS_IDENTITY_TIMEOUT_MS): Promise<boolean> {
  if (record.daemonPid === undefined) {
    if (finished(record)) return false; // Launch failed before a daemon existed.
    throw new Error("native terminal has no daemon identity yet");
  }
  if (!record.daemonIdentity) throw new Error("native terminal daemon identity is unavailable");
  return await getNativeProcessIdentity(record.daemonPid, timeoutMs) === record.daemonIdentity;
}

// A stop published before the kill RPC can retire the daemon and close its
// endpoint before the RPC connects or replies. Only such transport closures
// qualify, and callers still require observed retirement of that generation.
function endpointClosed(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return ["ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE"].includes(code ?? "") ||
    (error instanceof Error && error.message === "native terminal kill connection closed without a response");
}

async function waitDaemonRetired(record: SessionRecord, deadline: number): Promise<void> {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("native terminal daemon did not retire");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive: boolean;
    try {
      // The identity API retains/closes its own handles; its Node bridge also
      // receives this caller's actual remaining cleanup allowance.
      alive = await Promise.race([
        daemonAlive(record, remaining),
        new Promise<never>((_accept, reject) => {
          timer = setTimeout(() => reject(new Error("native terminal daemon did not retire")), remaining);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    // Synchronous native work (or a delayed callback) can pass the deadline
    // before timers run. A late null is not timely retirement evidence.
    if (Date.now() >= deadline) throw new Error("native terminal daemon did not retire");
    if (!alive) return;
    await pause(Math.max(0, Math.min(20, deadline - Date.now())));
  }
}

async function waitEndpointVacant(endpoint: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const active = await new Promise<boolean>((accept, reject) => {
      const socket = connect(endpoint);
      socket.setTimeout(Math.max(1, deadline - Date.now()),
        () => { socket.destroy(); reject(new Error("terminal endpoint probe timed out")); });
      socket.once("connect", () => { socket.destroy(); accept(true); });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") accept(false);
        else reject(error);
      });
    });
    // Late evidence is not timely, but it is not evidence of activity either.
    if (Date.now() >= deadline) {
      throw new Error(active
        ? "previous native terminal endpoint is still active"
        : "previous native terminal endpoint vacancy was not confirmed before the deadline");
    }
    if (!active) {
      if (process.platform !== "win32") await rm(endpoint, { force: true });
      return;
    }
    await pause(Math.max(0, Math.min(20, deadline - Date.now())));
  }
  throw new Error("previous native terminal endpoint is still active");
}

async function rpc(
  record: SessionRecord, method: Request["method"], args = {},
  deadline = Date.now() + (method === "kill" || method === "status" ||
    (method === "capture" && tuiOperationDeadline.getStore() === undefined)
    ? remainingCleanupTimeoutMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS)
    : remainingOperationTimeoutMs(RPC_TIMEOUT, { phase: `native terminal ${method}`, deadlineMs: tuiOperationDeadline.getStore() })!),
): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error(`native terminal ${method} timed out`);
  return new Promise((accept, reject) => {
    const socket = connect(record.endpoint);
    const id = randomUUID();
    let body = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (!error && Date.now() >= deadline) error = new Error(`native terminal ${method} timed out`);
      if (error) reject(error); else accept(value);
    };
    const timer = setTimeout(() => finish(new Error(`native terminal ${method} timed out`)), remaining);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, token: record.token, method, args })}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > RESPONSE_LIMIT) return finish(new Error("native terminal response exceeds limit"));
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = JSON.parse(body.slice(0, newline)) as Reply;
        if (reply.id !== id || typeof reply.ok !== "boolean") throw new Error("invalid native terminal response");
        finish(reply.ok ? undefined : new Error(reply.error || "native terminal operation failed"), reply.result);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => { if (!settled) finish(new Error(`native terminal ${method} connection closed without a response`)); });
  });
}

function nativeBun(): string {
  return process.env.AIDLC_BUN_BIN || (process.versions.bun ? process.execPath : "bun");
}

function validateSize(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 2 || height < 1 || width > 500 || height > 200 || width * height > 40_000
  ) throw new Error("terminal dimensions must be integers: columns 2..500, rows 1..200, at most 40000 cells");
}

export function createBunBackend(options: BunBackendOptions, request: typeof rpc = rpc) {
  return {
    async start(session: string, cwd: string, width: number, height: number, command: string[]) {
      validateSize(width, height);
      if (!command.length) throw new Error("native terminal requires a command");
      const paths = bunSessionPaths(session);
      ensurePrivateRoot(paths.root, process.env.AIDLC_TUI_BUN_ROOT ? "explicit" : "temporary");
      const rootIdentity = privateDirectoryIdentity(paths.root);
      // An OS-owned lock is released even when the start client is interrupted.
      const unlock = await acquireNativeLock(`${paths.directory}.lock`);
      try {
        privateDirectoryIdentity(paths.root, rootIdentity);
        const old = recordFor(session);
        const cleanupDeadline = nativeCleanupDeadlineMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS);
        if (old && !finished(old)) {
          const stop = stopRequest(old, paths.status, cleanupDeadline);
          publishSupervisorStop(paths.stop, stop);
          try { await request(old, "kill", { stop }, cleanupDeadline); }
          catch (error) { if (!endpointClosed(error)) throw error; }
          while (Date.now() < cleanupDeadline && !finished(recordFor(session)!)) {
            await pause(Math.max(0, Math.min(20, cleanupDeadline - Date.now())));
          }
          if (!finished(recordFor(session)!)) throw new Error("previous native terminal did not stop");
        }
        if (old) await waitDaemonRetired(recordFor(session)!, cleanupDeadline);
        await waitEndpointVacant(paths.endpoint, cleanupDeadline);
        privateDirectoryIdentity(paths.root, rootIdentity);
        const startupDeadlineMs = Date.now() + remainingOperationTimeoutMs(
          NATIVE_STARTUP_TIMEOUT_MS, { phase: "native TUI startup" },
        )!;
        await rm(paths.directory, { recursive: true, force: true });
        ensurePrivateRoot(paths.directory);
        const directoryIdentity = privateDirectoryIdentity(paths.directory);
        const prepared = process.platform === "win32" && options.windowsCommand
          ? options.windowsCommand(command) : { file: command[0], args: command.slice(1) };
        const record: SessionRecord = {
          schema: 1, backend: "bun", session, token: randomUUID(), generation: randomUUID(), endpoint: paths.endpoint,
          rootIdentity, directoryIdentity,
          phase: "starting", cwd: resolve(cwd), command: [prepared.file, ...prepared.args],
          fixtureCwd: options.fixtureCwd(cwd, command), width, height,
          windowsVerbatimArguments: prepared.windowsVerbatimArguments,
        };
        privateDirectoryIdentity(paths.root, rootIdentity);
        publishTuiRecord(paths.record, record, directoryIdentity);
        const stderr = openSync(join(paths.directory, "daemon.log"), "a", 0o600);
        let spawnError: Error | undefined;
        try {
          const child = spawn(nativeBun(), [fileURLToPath(import.meta.url), "--daemon", paths.directory, record.generation], {
            cwd: record.cwd, env: {
              ...process.env, TERM: "xterm-256color",
              [STARTUP_DEADLINE_ENV]: String(startupDeadlineMs),
            },
            stdio: ["ignore", "ignore", stderr], detached: true,
          });
          child.once("error", (error) => { spawnError = error; });
          child.unref();
        } finally { closeSync(stderr); }
        const deadline = startupDeadlineMs;
        while (Date.now() < deadline) {
          if (spawnError) {
            publishTuiRecord(paths.record, { ...record, phase: "error", error: spawnError.message, cleanupComplete: true }, directoryIdentity);
            throw spawnError;
          }
          const current = recordFor(session)!;
          if (current.token !== record.token) throw new Error("native terminal ownership changed during start");
          if (current.phase === "error") throw new Error(current.error || "native terminal startup failed");
          if (current.phase === "running" || finished(current)) {
            process.stdout.write(`started native Bun session '${session}' (${width}x${height})\n`);
            return;
          }
          await pause(20);
        }
        // Stop the supervisor even if the daemon could not become reachable.
        publishSupervisorStop(paths.stop, stopRequest(record, paths.status));
        throw new Error(`native terminal startup timed out; inspect ${paths.directory}`);
      } finally { unlock(); }
    },
    async send(session: string, keys: string, literal: boolean, noEnter: boolean) {
      const record = recordFor(session);
      if (!record || finished(record)) throw new Error(`native terminal is not running: ${session}`);
      await request(record, "send", { keys, literal, noEnter });
    },
    async paste(session: string, text: string) {
      const record = recordFor(session);
      if (!record || finished(record)) throw new Error(`native terminal is not running: ${session}`);
      await request(record, "paste", { text });
    },
    async resize(session: string, width: number, height: number) {
      validateSize(width, height);
      const record = recordFor(session);
      if (!record || finished(record)) throw new Error(`native terminal is not running: ${session}`);
      await request(record, "resize", { width, height });
    },
    async snapshot(session: string): Promise<TuiSnapshot> {
      const record = recordFor(session);
      if (!record) throw new Error(`native terminal does not exist: ${session}`);
      if (record.phase === "error") throw new Error(record.error || "native terminal failed");
      if (finished(record)) {
        const frame = readJson<TuiSnapshot>(bunSessionPaths(session).snapshot);
        if (!frame) throw new Error(`native terminal final snapshot is missing: ${session}`);
        return frame;
      }
      try { return await request(record, "capture") as TuiSnapshot; }
      catch (error) {
        // Natural exit can finish between reading the record and connecting.
        const current = recordFor(session);
        if (current?.token === record.token && finished(current) && current.phase !== "error") {
          const frame = readJson<TuiSnapshot>(bunSessionPaths(session).snapshot);
          if (frame) return frame;
        }
        throw error;
      }
    },
    async capture(session: string, ansi: boolean, layout: TuiTextLayout = "logical"): Promise<string> {
      const frame = await this.snapshot(session);
      return ansi ? frame.ansi : layout === "physical" ? physicalTuiText(frame) : frame.text;
    },
    async captureViews(session: string): Promise<TuiTextViews> {
      // One ordered RPC/snapshot, even if the terminal repaints immediately.
      const frame = await this.snapshot(session);
      return { physical: physicalTuiText(frame), logical: frame.text };
    },
    async kill(session: string, deadlineMs?: number) {
      const deadline = nativeCleanupDeadlineMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, deadlineMs);
      const paths = bunSessionPaths(session);
      const record = recordFor(session);
      if (!record) return;
      if (finished(record)) { await waitDaemonRetired(record, deadline); return; }
      const stop = stopRequest(record, paths.status, deadline);
      // Signaling must not depend on an RPC being able to start before expiry.
      publishSupervisorStop(paths.stop, stop);
      if (Date.now() >= deadline) throw new Error("native terminal cleanup deadline exhausted; stop requested, retirement unconfirmed");
      try { await request(record, "kill", { stop }, deadline); }
      catch (error) {
        // The caller may already own start's lock (worker cleanup does).
        // Reuse this invocation's generation and retry token; even if start
        // replaced the directory, its supervisor cannot accept this old file.
        publishSupervisorStop(paths.stop, stop);
        if (!endpointClosed(error) || recordFor(session)?.token !== record.token) throw error;
        try { await waitDaemonRetired(record, deadline); }
        catch { throw error; }
        return;
      }
      await waitDaemonRetired(record, deadline);
    },
    async liveProcesses(session: string, deadlineMs?: number): Promise<string[]> {
      const deadline = nativeCleanupDeadlineMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, deadlineMs);
      const record = recordFor(session);
      if (!record) return [];
      // A launch which never created a daemon needs no asynchronous observation.
      if (finished(record) && record.daemonPid === undefined) return [];
      // Zero is one immediate record observation, never a renewed RPC budget.
      // A completed record with a daemon PID still needs an OS identity probe
      // (which may require an async bridge). With no time for that probe it is
      // unconfirmed, even if the daemon has in fact exited. Only an absent
      // session or a completed launch with no daemon can prove absence here.
      if (Date.now() >= deadline) return [`unconfirmed-native-session:${session}`];
      try {
        const status = finished(record) ? record : await drainBeforeDeadline(
          request(record, "status", {}, deadline) as Promise<SessionRecord>,
          deadline, "native terminal status observation timed out",
        );
        if (finished(status)) {
          const remaining = Math.floor(deadline - Date.now());
          if (remaining <= 0) return [`unconfirmed-native-session:${session}`];
          const alive = await drainBeforeDeadline(
            daemonAlive(status, remaining), deadline, "native terminal identity observation timed out",
          );
          return alive ? [`bun-daemon:${status.daemonPid}`] : [];
        }
        return [
          `bun-daemon:${status.daemonPid ?? "starting"}`,
          ...(status.supervisorPid ? [`supervisor:${status.supervisorPid}`] : []),
          ...(status.error ? [`cleanup-error:${status.error}`] : []),
        ];
      } catch { return [`unreachable-native-session:${session}`]; }
    },
    fixtureCwd(session: string): string | null {
      return recordFor(session)?.fixtureCwd ?? null;
    },
  };
}

function readLaunchRecord(directory: string, expectedGeneration: string) {
  const record = readPrivateRecord<SessionRecord>(directory, join(directory, "session.json"));
  if (record?.backend !== "bun" || record.schema !== 1) throw new Error("invalid native terminal launch record");
  const paths = bunSessionPaths(record.session);
  if (paths.directory !== directory || paths.endpoint !== record.endpoint) throw new Error("native terminal launch path mismatch");
  if (typeof record.token !== "string" || record.token.length < 20) throw new Error("invalid native terminal launch token");
  if (record.phase !== "starting") throw new Error(`native terminal launch phase must be starting, received ${record.phase}`);
  if (!expectedGeneration || record.generation !== expectedGeneration) throw new Error("native terminal launch generation mismatch");
  assertDirectoryIdentity(dirname(directory), privateDirectoryIdentity(dirname(directory)), record.rootIdentity);
  return { record, paths };
}

/** Daemon entrypoint. Only this process loads the emulator or creates a PTY. */
export async function runBunDaemon(directory: string, expectedGeneration: string): Promise<void> {
  directory = resolve(directory);
  const file = join(directory, "session.json");
  // Establish directory trust separately: a rejected record can leave a safe
  // diagnostic, but an untrusted root/directory must never receive a write.
  const rootIdentity = privateDirectoryIdentity(dirname(directory));
  const directoryIdentity = privateDirectoryIdentity(directory);
  const { record, paths } = (() => {
    try { return readLaunchRecord(directory, expectedGeneration); }
    catch (error) {
      privateDirectoryIdentity(dirname(directory), rootIdentity);
      publishTuiRecord(file, {
        schema: 1, backend: "bun", directoryIdentity, phase: "error", error: String(error), cleanupComplete: true,
      }, directoryIdentity);
      throw error;
    }
  })();
  const publishRecord = () => {
    privateDirectoryIdentity(paths.root, rootIdentity);
    publishTuiRecord(file, record, directoryIdentity);
  };
  let startupDeadlineMs: number;
  try {
    const raw = process.env[STARTUP_DEADLINE_ENV];
    if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error("invalid native TUI startup deadline");
    startupDeadlineMs = Date.now() + remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, {
      deadlineMs: raw === undefined ? undefined : Number(raw),
      phase: "native TUI supervisor startup",
    })!;
  } catch (error) {
    record.phase = "error";
    record.error = error instanceof Error ? error.message : String(error);
    record.cleanupComplete = true;
    publishRecord();
    throw error;
  }
  const { createTuiScreen } = await import("./tui-screen.ts");
  const { runSupervisor } = await import("./tui-bun-process.ts");
  void runSupervisor; // Ensure supervisor module resolves before allocating resources.
  record.daemonPid = process.pid;
  record.daemonIdentity = await getNativeProcessIdentity(process.pid, Math.max(1, startupDeadlineMs - Date.now())) ?? undefined;
  if (!record.daemonIdentity) throw new Error("cannot establish native terminal daemon identity");
  publishRecord();
  const tracePath = process.env.AIDLC_TEST_LOG_DIR && process.env.AIDLC_TEST_DEBUG === "true"
    ? join(process.env.AIDLC_TEST_LOG_DIR, `tui-bun-${createHash("sha256").update(record.session).digest("hex").slice(0, 12)}-${process.pid}.ndjson`)
    : join(directory, "trace.ndjson");
  const trace = (event: string, data: Record<string, unknown> = {}) =>
    appendFileSync(tracePath, `${JSON.stringify({ ts: new Date().toISOString(), session: record.session, event, ...data })}\n`);
  const child = { value: null as ReturnType<typeof Bun.spawn> | null };
  const pendingInput: Array<string | Uint8Array> = [];
  const screen = await createTuiScreen(record.width, record.height, (data) => {
    if (!child.value?.terminal) pendingInput.push(data);
    else if (!child.value.terminal.closed) child.value.terminal.write(data);
  });
  let eof = false;
  let eofAt: number | undefined;
  let closing: Promise<void> | undefined;
  let parsedError: Error | undefined;
  let polling = false;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const sockets = new Set<Socket>();
  const config: SupervisorConfig = {
    token: record.token, cwd: record.cwd, command: record.command,
    statusPath: paths.status, releasePath: paths.release, stopPath: paths.stop,
    parentPid: process.pid, windowsVerbatimArguments: record.windowsVerbatimArguments,
  };
  const configPath = join(directory, "supervisor-config.json");
  publishTuiRecord(configPath, config, directoryIdentity);
  const supervisor = Bun.spawn([nativeBun(), join(HERE, "tui-bun-process.ts"), "--supervise", configPath], {
    cwd: record.cwd,
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: {
      cols: record.width, rows: record.height, name: "xterm-256color",
      data(_terminal, bytes) {
        try { screen.write(bytes); }
        catch (error) {
          parsedError = error instanceof Error ? error : new Error(String(error));
          publishSupervisorStop(paths.stop, stopRequest(record, paths.status));
        }
      },
      exit(_terminal, code, signal) {
        if (!eof) { record.ptyExitCode = code; eofAt = Date.now(); }
        eof = true;
        trace("pty-exit", { code, signal });
      },
    },
  });
  child.value = supervisor;
  record.supervisorPid = supervisor.pid;
  publishRecord();
  for (const data of pendingInput) supervisor.terminal!.write(data);
  let rootExit: number | undefined;
  void supervisor.exited.then((code) => { rootExit = code; trace("supervisor-exit", { code }); });

  const publish = async () => {
    atomicJson(paths.snapshot, await screen.snapshot());
    publishRecord();
  };
  const status = () => {
    const value = readJson<SupervisorStatus>(paths.status);
    if (!value || value.token !== record.token) return null;
    record.targetPid = value.targetPid;
    record.targetExitCode = value.exitCode;
    record.targetSignal = value.signal;
    return value;
  };
  const finish = async (requested: boolean, stop?: SupervisorStopRequest): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      const cleanupDeadline = nativeCleanupDeadlineMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, stop?.cleanupDeadlineMs);
      if (requested) publishSupervisorStop(paths.stop, stop ?? stopRequest(record, paths.status, cleanupDeadline));
      const deadline = Math.min(cleanupDeadline, Date.now() + NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS);
      while (rootExit === undefined && Date.now() < deadline) {
        await pause(20);
      }
      const value = status();
      if (rootExit === undefined || !value?.cleanupComplete) throw new Error(value?.error || "native terminal cleanup not confirmed");
      const drainDeadline = Math.min(cleanupDeadline, Date.now() + NATIVE_OUTPUT_DRAIN_TIMEOUT_MS);
      while (!eof && Date.now() < drainDeadline) await pause(10);
      // Rendering failure must be reported, but it must not leave a cleaned-up
      // session daemon alive forever. Only process uncertainty retains ownership.
      try {
        await drainBeforeDeadline(screen.flush(), drainDeadline);
        if (parsedError) throw parsedError;
        if (!eof) throw new Error("PTY output did not reach EOF before the drain deadline");
        // Bun maps ordinary Linux slave-close EIO to status 1. The API exposes
        // no errno to distinguish it from other read errors; accept it only
        // after the supervisor confirms exit and cleanup. Windows/macOS close at 0.
        if (record.ptyExitCode !== 0 && !(process.platform === "linux" && record.ptyExitCode === 1)) {
          throw new Error(`PTY output ended with error status ${record.ptyExitCode}`);
        }
        if (value.phase === "error") throw new Error(value.error || "native supervisor failed");
        await drainBeforeDeadline(publish(), drainDeadline);
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
      }
      record.phase = record.error ? "error" : requested ? "stopped" : "exited";
      record.cleanupComplete = true;
      publishRecord();
      supervisor.terminal?.close();
      if (monitor) clearInterval(monitor);
      screen.dispose();
      trace("closed", { phase: record.phase, targetExitCode: record.targetExitCode });
    })();
    try { await closing; }
    catch (error) {
      closing = undefined;
      record.phase = "error";
      record.error = error instanceof Error ? error.message : String(error);
      publishRecord();
      trace("cleanup-error", { error: record.error });
      throw error;
    }
  };

  let queue: Promise<void> = Promise.resolve();
  const handle = async (request: Request): Promise<unknown> => {
    if (request.token !== record.token || typeof request.id !== "string") throw new Error("native terminal ownership token mismatch");
    const args = request.args ?? {};
    if (request.method === "status") { status(); return record; }
    if (request.method === "capture") {
      if (record.error) throw new Error(record.error);
      if (finished(record)) return readJson<TuiSnapshot>(paths.snapshot);
      return await screen.snapshot();
    }
    if (request.method === "kill") {
      const stop = args.stop as SupervisorStopRequest | undefined;
      if (stop !== undefined && (
        !stop || stop.token !== record.token ||
        typeof stop.requestId !== "string" || !stop.requestId || stop.requestId.length > 1000 ||
        (stop.retryToken !== undefined && typeof stop.retryToken !== "string") ||
        (stop.cleanupDeadlineMs !== undefined && (!Number.isSafeInteger(stop.cleanupDeadlineMs) || stop.cleanupDeadlineMs < 0))
      )) throw new Error("invalid native terminal stop request");
      await finish(true, stop);
      return { stopped: true };
    }
    if (finished(record) || parsedError) throw new Error("native terminal is not accepting input");
    if (request.method === "send") {
      if (typeof args.keys !== "string") throw new Error("send requires keys");
      screen.keys(args.keys, args.literal === true, args.noEnter === true);
      trace("input", { keys: args.keys, literal: args.literal, noEnter: args.noEnter });
      return { queued: true };
    }
    if (request.method === "paste") {
      if (typeof args.text !== "string") throw new Error("paste requires text");
      screen.paste(args.text);
      trace("paste", { length: args.text.length });
      return { queued: true };
    }
    if (request.method === "resize") {
      const width = Number(args.width);
      const height = Number(args.height);
      validateSize(width, height);
      supervisor.terminal!.resize(width, height);
      await screen.resize(width, height);
      record.width = width;
      record.height = height;
      await publish();
      return { width, height };
    }
    throw new Error("unknown native terminal method");
  };
  const server = createServer((socket) => {
    if (sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.setTimeout(RPC_TIMEOUT, () => socket.destroy());
    let body = "";
    let used = false;
    socket.on("data", (data: string) => {
      if (used) return;
      body += data;
      if (Buffer.byteLength(body) > REQUEST_LIMIT) { used = true; socket.destroy(); return; }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      used = true;
      let request: Request | undefined;
      let parseError: unknown;
      try { request = JSON.parse(body.slice(0, newline)) as Request; }
      catch (error) { parseError = error; }
      if (request?.token === record.token && request.method === "kill") {
        // Begin the absolute allowance on receipt, including queue time.
        // Further bytes cannot renew an authenticated shutdown request.
        socket.setTimeout(0);
        const timer = setTimeout(() => socket.destroy(), remainingCleanupTimeoutMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS));
        socket.once("close", () => clearTimeout(timer));
      }
      queue = queue.then(async () => {
        let reply: Reply;
        try {
          if (parseError) throw parseError;
          if (!request) throw new Error("invalid native terminal request");
          reply = { id: request.id, ok: true, result: await handle(request) };
        } catch (error) {
          reply = { id: request?.id ?? "", ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        const encoded = `${JSON.stringify(reply)}\n`;
        if (Buffer.byteLength(encoded) > RESPONSE_LIMIT) socket.end(`${JSON.stringify({ id: reply.id, ok: false, error: "snapshot exceeds response limit" })}\n`);
        else socket.end(encoded);
        if (finished(record)) retire(socket);
      });
    });
  });
  const serverClosed = new Promise<void>((accept) => server.once("close", accept));
  const retire = (replySocket?: Socket) => {
    server.close();
    for (const socket of sockets) if (socket !== replySocket) socket.destroy();
    // Allow the kill reply to flush, with an absolute deadline independent of
    // incoming bytes. A half-open client must not keep an exited daemon alive.
    if (replySocket) {
      const deadline = setTimeout(() => replySocket.destroy(), remainingCleanupTimeoutMs(NATIVE_OUTPUT_DRAIN_TIMEOUT_MS));
      replySocket.once("close", () => clearTimeout(deadline));
    }
  };
  const stop = () => { void finish(true).then(() => retire()).catch(() => {}); };
  let ownsEndpoint = false;
  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(record.endpoint, accept);
    });
    ownsEndpoint = true;
    if (process.platform !== "win32") await chmod(record.endpoint, 0o600);
    const deadline = startupDeadlineMs;
    while (Date.now() < deadline) {
      const value = status();
      if (value?.phase === "error" || rootExit !== undefined) throw new Error(value?.error || "supervisor exited before readiness");
      if (value?.phase === "ready") break;
      await pause(20);
    }
    // A failure published in the last poll interval outranks the deadline.
    const settled = status();
    if (settled?.phase === "error" || rootExit !== undefined) throw new Error(settled?.error || "supervisor exited before readiness");
    if (settled?.phase !== "ready") throw new Error(`supervisor startup timed out (shared deadline ${startupDeadlineMs})`);
    await publish();
    // Pin both directories to the starter's record, after the handshake and all
    // asynchronous setup, immediately before allowing the command to execute.
    assertDirectoryIdentity(paths.root, privateDirectoryIdentity(paths.root), record.rootIdentity);
    assertDirectoryIdentity(directory, privateDirectoryIdentity(directory), record.directoryIdentity);
    writeFileSync(paths.release, record.token, { mode: 0o600 });
    while (Date.now() < deadline) {
      const value = status();
      if (value?.phase === "error") throw new Error(value.error || "native target launch failed");
      if (value && value.phase !== "ready") break;
      await pause(10);
    }
    const launched = status();
    if (launched?.phase === "error") throw new Error(launched.error || "native target launch failed");
    if (launched?.phase === "ready") throw new Error("native target launch timed out");
    record.phase = "running";
    publishRecord();
    trace("ready", { supervisorPid: supervisor.pid, endpoint: record.endpoint });
    monitor = setInterval(() => {
      if (polling || closing) return;
      polling = true;
      void (async () => {
        const value = status();
        if (eofAt !== undefined && rootExit === undefined && Date.now() - eofAt > 250) {
          parsedError ??= new Error("PTY output ended while its supervisor was still running");
          publishSupervisorStop(paths.stop, stopRequest(record, paths.status));
        }
        if (value?.phase === "error" && !value.cleanupComplete) {
          record.phase = "error";
          record.error = value.error;
          publishRecord();
        } else if (rootExit !== undefined) {
          try { await finish(false); retire(); }
          catch { /* record retained; a kill request can retry */ }
        }
      })().catch((error) => {
        record.phase = "error";
        record.error = String(error);
        publishRecord();
        stop();
      }).finally(() => { polling = false; });
    }, 50);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await serverClosed;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    try { await finish(true); } catch { /* Retain cleanup uncertainty in the record. */ }
    retire();
    throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (monitor) clearInterval(monitor);
    for (const socket of sockets) socket.destroy();
    if (ownsEndpoint && process.platform !== "win32") await rm(record.endpoint, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--daemon" || !process.argv[3] || !process.argv[4]) throw new Error("usage: tui-bun-backend.ts --daemon <session-directory> <generation>");
  runBunDaemon(process.argv[3], process.argv[4]).catch((error) => {
    try {
      const directory = process.argv[3];
      const file = join(directory, "session.json");
      const record = readPrivateRecord<SessionRecord>(directory, file);
      // A pre-allocation rejection already published a diagnostic without
      // importing executable fields from the rejected launch record.
      if (typeof record.token === "string") {
        publishTuiRecord(file, {
          ...record, phase: "error", error: String(error),
          cleanupComplete: record.cleanupComplete || record.supervisorPid === undefined,
        }, record.directoryIdentity);
        publishSupervisorStop(join(directory, "stop"), stopRequest(record, join(directory, "supervisor.json")));
      }
    } catch { /* No reads/writes through an untrusted or replaced namespace. */ }
    console.error(error);
    process.exit(1);
  });
}
