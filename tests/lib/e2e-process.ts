// Own one isolated test process tree independently of the test leader's lifetime.
// No terminal/console APIs: native TUI cleanup remains the driver's responsibility.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishTuiRecord } from "../harness/tui-record-file.ts";
import {
  FILE_DEADLINE_ENV,
  remainingCleanupTimeoutMs,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

const HERE = fileURLToPath(import.meta.url);
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const text = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Config {
  token: string;
  cwd: string;
  command: string[];
  status: string;
  job?: string;
}
interface Status {
  token: string;
  phase: "ready" | "running" | "exited" | "error";
  code?: number;
  error?: string;
}

function publish(config: Config, status: Omit<Status, "token">): void {
  publishTuiRecord(config.status, { token: config.token, ...status });
}

async function windowsApi() {
  if (!["x64", "arm64"].includes(process.arch)) throw new Error("e2e Windows jobs require 64-bit Bun");
  const { dlopen } = await import("bun:ffi");
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    OpenJobObjectW: { args: ["u32", "i32", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
    IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    GetCurrentProcess: { args: [], returns: "ptr" },
    TerminateJobObject: { args: ["ptr", "u32"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
}

async function createJob() {
  const library = await windowsApi();
  const api = library.symbols;
  const name = `Local\\aidlc-e2e-${randomUUID()}`;
  const wideName = Buffer.from(`${name}\0`, "utf16le");
  const handle = api.CreateJobObjectW(null, wideName);
  const creationError = api.GetLastError();
  if (!handle || creationError === 183) {
    if (handle) api.CloseHandle(handle);
    library.close();
    throw new Error(`e2e CreateJobObjectW failed or name already existed: ${creationError}`);
  }
  const failure = (op: string) => new Error(`e2e ${op}: Windows error ${api.GetLastError()}`);
  try {
    // Win64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags at byte 16.
    // No breakaway flags; even detached descendants remain inside the job.
    const limits = new Uint8Array(144);
    new DataView(limits.buffer).setUint32(16, 0x2000, true);
    if (!api.SetInformationJobObject(handle, 9, limits, limits.length)) throw failure("SetInformationJobObject");
  } catch (error) {
    api.CloseHandle(handle);
    library.close();
    throw error;
  }
  return {
    name,
    terminate() {
      if (!api.TerminateJobObject(handle, 137)) throw failure("TerminateJobObject");
    },
    empty(): boolean {
      const info = new Uint8Array(48);
      if (!api.QueryInformationJobObject(handle, 1, info, info.length, null)) {
        throw failure("QueryInformationJobObject(Accounting)");
      }
      return new DataView(info.buffer).getUint32(40, true) === 0;
    },
    close() {
      const closed = api.CloseHandle(handle);
      const error = closed ? undefined : failure("CloseHandle(job)");
      library.close();
      if (error) throw error;
    },
  };
}

async function enterJob(name: string): Promise<void> {
  const library = await windowsApi();
  const api = library.symbols;
  const handle = api.OpenJobObjectW(0x0001 | 0x0004, 0, Buffer.from(`${name}\0`, "utf16le"));
  if (!handle) {
    const code = api.GetLastError();
    library.close();
    throw new Error(`e2e OpenJobObjectW: Windows error ${code}`);
  }
  const failures: unknown[] = [];
  try {
    const self = api.GetCurrentProcess();
    if (!api.AssignProcessToJobObject(handle, self)) {
      throw new Error(`e2e AssignProcessToJobObject: Windows error ${api.GetLastError()}`);
    }
    const member = new Int32Array(1);
    if (!api.IsProcessInJob(self, handle, member) || member[0] !== 1) {
      throw new Error("e2e supervisor did not enter its private job");
    }
  } catch (error) { failures.push(error); }
  if (!api.CloseHandle(handle)) failures.push(new Error(`e2e CloseHandle(child job): ${api.GetLastError()}`));
  library.close();
  if (failures.length) throw new AggregateError(failures, "e2e job admission failed");
}

/** Read-only group observation. Zombies cannot run or keep output pipes open. */
function groupRetired(group: number): boolean {
  try { process.kill(-group, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  if (process.platform !== "linux") return false;
  let members = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let raw: string;
    try { raw = readFileSync(`/proc/${entry}/stat`, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (Number(fields[2]) !== group) continue;
    members++;
    if (!["Z", "X", "x"].includes(fields[0])) return false;
  }
  // An observable group with no readable members is uncertainty, not retirement.
  return members > 0;
}

export interface IsolatedProcess {
  child: ChildProcessWithoutNullStreams;
  /** Resolves on the test leader's exit, independently of inherited output pipes. */
  exited: Promise<number>;
  readonly workTimedOut?: boolean;
  stop(): void;
  retire(): Promise<IsolatedProcessRetirement>;
}

/** Returned only after native tree retirement and handle closure succeed.
 * Never reconstruct this authority from files written by a test process. */
export interface IsolatedProcessRetirement {
  readonly platform: NodeJS.Platform;
  readonly job?: string;
  readonly configPath: string;
  readonly configText: string;
}

export async function startIsolatedProcess(options: {
  command: string[]; cwd: string; env: NodeJS.ProcessEnv; artifacts: string; signal: AbortSignal;
}): Promise<IsolatedProcess> {
  options.signal.throwIfAborted();
  const workAllowance = remainingOperationTimeoutMs(undefined, { env: options.env, phase: "isolated file work" });
  const workDeadline = workAllowance === undefined ? undefined : Date.now() + workAllowance;
  const job = process.platform === "win32" ? await createJob() : undefined;
  let child: ChildProcessWithoutNullStreams;
  const config: Config = {
    token: randomUUID(), command: options.command, cwd: options.cwd,
    status: join(options.artifacts, "process-status.json"), job: job?.name,
  };
  const configPath = join(options.artifacts, "process-config.json");
  const configText = JSON.stringify(config);
  try {
    options.signal.throwIfAborted();
    writeFileSync(configPath, configText, { mode: 0o600 });
    child = spawn(process.execPath, [HERE, "--supervise", configPath], {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    job?.close();
    throw error;
  }
  let supervisorError: Error | undefined;
  let supervisorExited = false;
  child.on("error", (error) => { supervisorError = error; supervisorExited = true; });
  child.once("exit", () => { supervisorExited = true; });
  child.stdin.on("error", (error) => { supervisorError ??= error; });
  const send = (command: string) => {
    if (!supervisorExited && !child.stdin.destroyed) child.stdin.write(`${command}\n`);
  };
  const stop = () => send("stop");
  let workTimedOut = false;
  const expireWork = () => { workTimedOut = true; stop(); };
  const workTimer = workDeadline === undefined ? undefined :
    setTimeout(expireWork, Math.max(0, workDeadline - Date.now()));
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const readStatus = (): Status | undefined => {
    let status: Status;
    try { status = JSON.parse(readFileSync(config.status, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (status.token !== config.token) throw new Error("e2e supervisor status ownership changed");
    return status;
  };
  const exited = (async () => {
    // Startup may consume the work tail before the timer gets a turn. Keep
    // this handle and cancel it, rather than abandoning an admitted supervisor.
    const readyDeadline = Math.min(Date.now() + NATIVE_STARTUP_TIMEOUT_MS, workDeadline ?? Infinity);
    let released = false;
    let stopDeadline: number | undefined;
    while (true) {
      // One clock reading per pass: when the ready deadline is the work cutoff,
      // reaching it must expire the work, never report a startup failure.
      const now = Date.now();
      if (workDeadline !== undefined && now >= workDeadline && !workTimedOut) expireWork();
      const status = readStatus();
      if (status?.phase === "error") throw new Error(status.error || "e2e supervisor failed");
      if (status?.phase === "exited") return status.code ?? 1;
      if (supervisorError || supervisorExited) throw supervisorError ?? new Error("e2e supervisor exited before its test status");
      if (options.signal.aborted || workTimedOut) {
        stop();
        stopDeadline ??= Date.now() + remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS, { env: options.env });
        if (Date.now() >= stopDeadline) throw new Error("e2e test leader did not stop");
      } else if (!released && status?.phase === "ready") {
        // No await between this final cancellation check and releasing the child.
        options.signal.throwIfAborted();
        send("start");
        released = true;
      }
      if (!released && !options.signal.aborted && !workTimedOut && now >= readyDeadline) {
        throw new Error("e2e supervisor did not become ready");
      }
      await pause(20);
    }
  })().finally(() => { if (workTimer) clearTimeout(workTimer); });
  let retirement: Promise<IsolatedProcessRetirement> | undefined;
  return {
    child, exited, stop,
    get workTimedOut() { return workTimedOut; },
    retire() {
      if (retirement) return retirement;
      retirement = (async () => {
        if (workTimer) clearTimeout(workTimer);
        const failures: unknown[] = [];
        try {
          if (job) {
            job.terminate();
            // Before admission a supervisor cannot spawn children; this is its
            // original ChildProcess handle, never a PID lookup.
            if (!supervisorExited) child.kill("SIGKILL");
          } else if (!supervisorExited) {
            send("retire"); // The live group anchor signals its own group atomically.
          }
          const deadline = Math.min(
            Date.now() + remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS, { env: options.env }),
            Number(options.env[FILE_DEADLINE_ENV] ?? Infinity),
          );
          while (!supervisorExited || (job ? !job.empty() : !groupRetired(child.pid!))) {
            if (Date.now() >= deadline) throw new Error("e2e process tree retirement unconfirmed");
            await pause(20);
          }
          if (supervisorError) throw supervisorError;
        } catch (error) {
          failures.push(error);
          if (!supervisorExited) child.kill("SIGKILL");
        }
        options.signal.removeEventListener("abort", stop);
        child.stdin.destroy();
        try { job?.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "e2e process cleanup failed");
        return Object.freeze({
          platform: process.platform, job: config.job, configPath, configText,
        });
      })();
      return retirement;
    },
  };
}

async function supervise(config: Config): Promise<void> {
  let released = false;
  let stopped = false;
  let ownsGroup = false;
  let target: ReturnType<typeof Bun.spawn> | undefined;
  const retire = () => {
    if (ownsGroup) process.kill(0, "SIGKILL");
    // Windows retirement is performed through the parent's stable job handle.
  };
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", (data: string) => {
    input += data;
    while (input.includes("\n")) {
      const end = input.indexOf("\n");
      const command = input.slice(0, end);
      input = input.slice(end + 1);
      if (command === "start") released = true;
      if (command === "stop") { stopped = true; if (target?.exitCode === null) target.kill("SIGKILL"); }
      if (command === "retire") retire();
    }
  });
  process.stdin.on("end", () => { stopped = true; retire(); });
  process.stdin.resume();
  if (process.platform === "win32") {
    if (!config.job) throw new Error("e2e Windows supervisor requires a private job");
    await enterJob(config.job); // No descendant can exist before this succeeds.
  } else {
    const { dlopen } = await import("bun:ffi");
    const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      getpgrp: { args: [], returns: "i32" },
    });
    ownsGroup = libc.symbols.getpgrp() === process.pid;
    libc.close();
    if (!ownsGroup) throw new Error("e2e supervisor is not its private process-group leader");
  }
  publish(config, { phase: "ready" });
  while (!released && !stopped) await pause(10);
  let code = 128;
  if (!stopped) {
    target = Bun.spawn(config.command, {
      cwd: config.cwd, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    publish(config, { phase: "running" });
    code = await target.exited;
  }
  publish(config, { phase: "exited", code });
  // Keep the group anchor alive until the parent finishes native transport
  // cleanup and explicitly retires the process tree.
  await new Promise(() => {});
}

if (import.meta.main) {
  if (process.argv[2] !== "--supervise" || !process.argv[3]) throw new Error("usage: e2e-process.ts --supervise <config>");
  const config: Config = JSON.parse(readFileSync(process.argv[3], "utf8"));
  supervise(config).catch((error) => {
    try { publish(config, { phase: "error", error: text(error) }); } catch {}
    console.error(`e2e supervisor: ${text(error)}`);
    // Retain a live group anchor until the parent handles cleanup.
    setInterval(() => {}, 1000);
  });
}
