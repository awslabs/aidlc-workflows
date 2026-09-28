/**
 * Private inline-PTY child of tui-bun-daemon: bun <this file> --supervise <config>.
 * The daemon owns the PTY and private control directory. Marker existence releases
 * or initially stops this wrapper; retrying uncertain cleanup requires its current
 * retry token as well as the session token. Use a fresh directory/token per session.
 * Wrapper exit (0 = successful supervision, 1 = error) is NOT the target exit code.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DARWIN_BSDINFO_SIZE, type DarwinProcessIdentity, readDarwinProcessIdentity } from "./tui-process-identity.ts";
import { publishTuiRecord } from "./tui-record-file.ts";
import {
  FILE_DEADLINE_ENV, remainingCleanupTimeoutMs, remainingOperationTimeoutMs,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS, TestBudgetExhaustedError,
} from "./test-budget.ts";

/** Preserve an expired hard deadline too: a minimum subprocess timeout must
 * never turn into a new allowance for subsequent cleanup phases. */
export function nativeCleanupDeadlineMs(
  maximumMs: number,
  deadlineMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const now = Date.now();
  const remaining = remainingCleanupTimeoutMs(maximumMs, { deadlineMs, env, nowMs: now });
  return Math.min(now + Math.min(maximumMs, remaining), deadlineMs ?? Infinity,
    env[FILE_DEADLINE_ENV] === undefined ? Infinity : Number(env[FILE_DEADLINE_ENV]));
}

export interface SupervisorConfig {
  token: string;
  cwd: string;
  command: string[];
  statusPath: string;
  releasePath: string;
  stopPath: string;
  parentPid: number;
  windowsVerbatimArguments?: boolean;
}

export interface SupervisorStatus {
  token: string;
  phase: "ready" | "running" | "exited" | "stopped" | "error";
  supervisorPid: number;
  targetPid?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  cleanupComplete?: boolean;
  /** Issued only after a failed POSIX cleanup attempt; consumed by one later stop. */
  cleanupRetryToken?: string;
}

export interface SupervisorStopRequest {
  token: string;
  requestId: string;
  retryToken?: string;
  /** Epoch hard deadline from this generation's cleanup caller; can only tighten. */
  cleanupDeadlineMs?: number;
}

function validStopDeadline(request: SupervisorStopRequest): boolean {
  return request.cleanupDeadlineMs === undefined ||
    (Number.isSafeInteger(request.cleanupDeadlineMs) && request.cleanupDeadlineMs >= 0);
}

function stopRequestPath(directory: string, token: string): string {
  return join(directory, `${createHash("sha256").update(token).digest("hex")}.json`);
}

/** Generation-specific files prevent stale clients overwriting a new stop. */
export function publishSupervisorStop(directory: string, request: SupervisorStopRequest): void {
  if (!validStopDeadline(request)) throw new Error("invalid supervisor cleanup deadline");
  // Never recreate a removed session directory while start is replacing it.
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !statSync(directory).isDirectory()) throw error;
  }
  publishTuiRecord(stopRequestPath(directory, request.token), request);
}

export interface LinuxProcessIdentity {
  pid: number;
  ppid: number;
  startTicks: bigint;
  state: string;
}

/** /proc/<pid>/stat's comm may itself contain spaces, parentheses and newlines. */
export function parseLinuxProcStat(text: string): LinuxProcessIdentity {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  const pid = Number(text.slice(0, open).trim());
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (
    open < 1 || close <= open || !Number.isSafeInteger(pid) || pid <= 0 ||
    !/^[A-Za-z]$/.test(fields[0] ?? "") ||
    !/^\d+$/.test(fields[1] ?? "") || !/^\d+$/.test(fields[19] ?? "")
  ) throw new Error("invalid /proc stat identity");
  const ppid = Number(fields[1]);
  if (!Number.isSafeInteger(ppid)) throw new Error("invalid /proc parent PID");
  return { pid, ppid, state: fields[0], startTicks: BigInt(fields[19]) };
}

export function sameLinuxProcess(a: LinuxProcessIdentity, b: LinuxProcessIdentity): boolean {
  return a.pid === b.pid && a.startTicks === b.startTicks;
}

/** Reject reused ancestors, cycles and incomplete ancestry; never use process names. */
export function isLinuxDescendant(
  candidate: LinuxProcessIdentity,
  owner: LinuxProcessIdentity,
  snapshot: ReadonlyMap<number, LinuxProcessIdentity>,
): boolean {
  if (candidate.pid === owner.pid) return false;
  const seen = new Set<number>();
  let current = candidate;
  while (!seen.has(current.pid)) {
    seen.add(current.pid);
    const parent = snapshot.get(current.ppid);
    if (!parent || parent.startTicks > current.startTicks) return false;
    if (parent.pid === owner.pid) return sameLinuxProcess(parent, owner);
    current = parent;
  }
  return false;
}


export function sameDarwinProcess(a: DarwinProcessIdentity, b: DarwinProcessIdentity): boolean {
  return a.pid === b.pid && a.startSec === b.startSec && a.startUsec === b.startUsec;
}

function darwinStartedAfter(a: DarwinProcessIdentity, b: DarwinProcessIdentity): boolean {
  return a.startSec > b.startSec || (a.startSec === b.startSec && a.startUsec > b.startUsec);
}

/** KERN_PROCARGS2: argc, executable path, alignment NULs, argv, then environ. */
export function parseDarwinProcArgs(buffer: Uint8Array): { env: string[] } {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const invalid = () => new Error("invalid or truncated Darwin process arguments");
  if (bytes.length < 5) throw invalid();
  const argc = bytes.readUInt32LE(0);
  if (argc > bytes.length - 5) throw invalid();
  let offset = 4;
  const next = (): string => {
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw invalid();
    const value = bytes.toString("utf8", offset, end);
    offset = end + 1;
    return value;
  };
  if (!next()) throw invalid();
  while (offset < bytes.length && bytes[offset] === 0) offset++;
  for (let i = 0; i < argc; i++) next();
  const env: string[] = [];
  while (offset < bytes.length) {
    const value = next();
    if (!value) break; // End of environ; trailing Apple strings are not environment.
    env.push(value);
  }
  return { env };
}

/** Token ownership survives setsid/double-fork; ancestry checks reject reused PIDs. */
export function isDarwinDescendant(
  candidate: DarwinProcessIdentity,
  owner: DarwinProcessIdentity,
  snapshot: ReadonlyMap<number, DarwinProcessIdentity>,
  token: string,
): boolean {
  if (candidate.pid === owner.pid || candidate.uid !== owner.uid) return false;
  const observed = snapshot.get(candidate.pid);
  if (!observed || !sameDarwinProcess(candidate, observed)) return false;
  if (candidate.env?.includes(`AIDLC_TUI_CONTAINMENT=${token}`)) return true;
  const seen = new Set<number>();
  let current = candidate;
  while (!seen.has(current.pid)) {
    seen.add(current.pid);
    const parent = snapshot.get(current.ppid);
    if (!parent || parent.uid !== owner.uid || darwinStartedAfter(parent, current)) return false;
    if (parent.pid === owner.pid) return sameDarwinProcess(parent, owner);
    current = parent;
  }
  return false;
}

const POLL_MS = 25;
const CLEANUP_MS = NATIVE_PROCESS_CLEANUP_TIMEOUT_MS;
const GRACE_MS = 300;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const gone = (error: unknown): boolean =>
  ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException)?.code ?? "");

function markerExists(path: string): boolean {
  try {
    if (!statSync(path).isFile()) throw new Error(`control marker is not a file: ${path}`);
    return true;
  } catch (error) {
    if (gone(error)) return false;
    throw error;
  }
}

function readConfig(path: string): SupervisorConfig {
  const fd = openSync(path, fsConstants.O_RDONLY |
    (process.platform !== "win32" ? fsConstants.O_NOFOLLOW : 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error("supervisor config must be a private regular file (mode 0600)");
    }
    const value = JSON.parse(readFileSync(fd, "utf8"));
    const keys = new Set([
      "token", "cwd", "command", "statusPath", "releasePath", "stopPath",
      "parentPid", "windowsVerbatimArguments",
    ]);
    if (!value || typeof value !== "object" || Object.keys(value).some((key) => !keys.has(key))) {
      throw new Error("invalid supervisor config keys; environment belongs to the daemon");
    }
    if (
      typeof value.token !== "string" || !value.token ||
      !["cwd", "statusPath", "releasePath", "stopPath"].every(
        (key) => typeof value[key] === "string" && isAbsolute(value[key]),
      ) ||
      !Array.isArray(value.command) || value.command.length === 0 ||
      !value.command.every((arg: unknown) => typeof arg === "string" && !arg.includes("\0")) ||
      !value.command[0] || !Number.isSafeInteger(value.parentPid) || value.parentPid <= 0 ||
      (value.windowsVerbatimArguments !== undefined && typeof value.windowsVerbatimArguments !== "boolean")
    ) throw new Error("invalid supervisor config");
    if (new Set([path, value.statusPath, value.releasePath, value.stopPath].map((p) => resolve(p))).size !== 4) {
      throw new Error("supervisor config and control paths must be distinct");
    }
    return value as SupervisorConfig;
  } finally {
    closeSync(fd);
  }
}

function publish(path: string, status: SupervisorStatus): void {
  publishTuiRecord(path, status);
}

export interface Containment {
  /** Retain the native library allocation, not just its generated function pointers. */
  library: unknown;
  /** Private ownership marker inherited by the target and its descendants. */
  env?: Record<string, string>;
  parentAlive(): boolean;
  /** True only when there are no remaining descendants (including unreaped children). */
  sweep(force: boolean, targetPid: number | undefined, deadline: number, signalOnly?: boolean): boolean;
}

function cleanupRetryRequested(config: SupervisorConfig, retryToken: string): SupervisorStopRequest | null {
  try {
    const path = statSync(config.stopPath).isDirectory()
      ? stopRequestPath(config.stopPath, config.token) : config.stopPath;
    const file = statSync(path);
    if (!file.isFile() || file.size > 4096) return null;
    const request = JSON.parse(readFileSync(path, "utf8")) as SupervisorStopRequest;
    return request?.token === config.token && request.retryToken === retryToken &&
      typeof request.requestId === "string" && request.requestId.length > 0 && request.requestId.length <= 1000 &&
      validStopDeadline(request) ? request : null;
  } catch {
    // Missing, partial, legacy and unreadable markers cannot authorize a retry.
    // Keep ownership and the unconfirmed receipt until a valid request arrives.
    return null;
  }
}

function initialStopRequested(config: SupervisorConfig, accept: (request: SupervisorStopRequest) => void): boolean {
  try {
    const control = statSync(config.stopPath);
    // Standalone supervisor fixtures also use the original one-shot file.
    // Production clients use the directory and must supply the current token.
    if (control.isFile()) return true;
    if (!control.isDirectory()) throw new Error("invalid supervisor stop control");
    const path = stopRequestPath(config.stopPath, config.token);
    const file = statSync(path);
    if (!file.isFile() || file.size > 4096) throw new Error("invalid supervisor stop request");
    const request = JSON.parse(readFileSync(path, "utf8")) as SupervisorStopRequest;
    const valid = request?.token === config.token &&
      typeof request.requestId === "string" && request.requestId.length > 0 && request.requestId.length <= 1000 &&
      validStopDeadline(request);
    if (valid) accept(request);
    return valid;
  } catch (error) {
    if (gone(error)) return false;
    throw error;
  }
}

function withinDeadline(deadline: number): void {
  if (performance.now() >= deadline) throw new Error(`descendant cleanup exceeded its ${CLEANUP_MS}ms budget`);
}

function readProc(pid: number): LinuxProcessIdentity | null {
  try {
    const identity = parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (identity.pid !== pid) throw new Error(`/proc/${pid}/stat PID mismatch`);
    return identity;
  } catch (error) {
    if (gone(error)) return null;
    throw error;
  }
}

function linuxSnapshot(deadline = Number.POSITIVE_INFINITY): Map<number, LinuxProcessIdentity> {
  const snapshot = new Map<number, LinuxProcessIdentity>();
  for (const name of readdirSync("/proc")) {
    withinDeadline(deadline);
    if (!/^\d+$/.test(name)) continue;
    const identity = readProc(Number(name));
    if (identity) snapshot.set(identity.pid, identity);
  }
  return snapshot;
}

async function containLinux(parentPid: number): Promise<Containment> {
  if (!["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Linux pidfd syscall ABI is unsupported on ${process.arch}`);
  }
  const { ptr } = await import("bun:ffi");
  const library = await loadLinuxProcessCalls();
  const api = library.symbols;
  const failure = (call: string, result: number): Error => new Error(`${call} failed: errno ${-result}`);
  const check = (call: string, result: number): void => {
    if (result < 0) throw failure(call, result);
  };
  const owner = readProc(process.pid);
  const parent = readProc(parentPid);
  if (!owner || !parent || owner.ppid !== parentPid) throw new Error("supervisor parent identity lost before containment");
  check("prctl(PR_SET_CHILD_SUBREAPER)", api.tui_prctl(36, 1));
  // SIGTERM is handled by the wrapper, so it can clean adopted children before exiting.
  check("prctl(PR_SET_PDEATHSIG)", api.tui_prctl(1, 15));
  const setting = new Uint32Array(1);
  check("prctl(PR_GET_CHILD_SUBREAPER)", api.tui_prctl(37, ptr(setting)));
  if (setting[0] !== 1) throw new Error("PR_CHILD_SUBREAPER verification failed");
  const deathSignal = new Uint32Array(1);
  check("prctl(PR_GET_PDEATHSIG)", api.tui_prctl(2, ptr(deathSignal)));
  if (deathSignal[0] !== 15) throw new Error("PR_PDEATHSIG verification failed");
  const parentAlive = (): boolean => {
    const current = readProc(parentPid);
    return process.ppid === parentPid && current !== null &&
      sameLinuxProcess(current, parent) && !["Z", "X"].includes(current.state);
  };
  if (!parentAlive()) throw new Error("supervisor parent exited during containment setup");
  const waitInfo = new BigUint64Array(16); // siginfo_t = 128 bytes on both supported ABIs.
  const probe = api.tui_pidfd_open(process.pid);
  check("pidfd_open (Linux >=5.4 required)", probe);
  try {
    check("pidfd_send_signal probe", api.tui_pidfd_signal(probe, 0));
    // Self is never our child. Reject kernels lacking P_PIDFD before launch.
    const result = api.tui_waitid(3, probe, waitInfo, 0x41000005);
    if (result !== -10) throw failure("waitid(P_PIDFD) probe (Linux >=5.4 required)", result);
  } finally {
    check("close probe pidfd", api.tui_close(probe));
  }
  linuxSnapshot(); // Fail before ready if procfs cannot establish ownership.
  const noChildren = (): boolean => {
    // WEXITED | WNOHANG | WNOWAIT | __WALL. Observe ALL thread-group children,
    // including clone children, without consuming Bun's target wait status.
    const result = api.tui_waitid(0, 0, waitInfo, 0x41000005);
    if (result === 0) return false;
    if (result === -10) return true; // ECHILD is the kernel's atomic empty-tree check.
    if (result === -4) return false; // EINTR: next sweep, within the original deadline.
    throw failure("waitid(P_ALL, WNOWAIT)", result);
  };

  return {
    library,
    parentAlive,
    sweep(force, targetPid, deadline, signalOnly = false) {
      // One finite ownership-checked snapshot/signaling pass may run at expiry.
      // All waitid calls below are WNOHANG; this grants no waiting allowance.
      const observationDeadline = signalOnly ? Infinity : deadline;
      const snapshot = linuxSnapshot(observationDeadline);
      const descendants = [...snapshot.values()].filter((p) => isLinuxDescendant(p, owner, snapshot));
      for (const previous of descendants) {
        withinDeadline(observationDeadline);
        // The pidfd pins the signal recipient. Re-read start ticks AND its live
        // ancestry after opening it; kill(pid) after a stat check has a reuse race.
        const fd = api.tui_pidfd_open(previous.pid);
        if (fd < 0) {
          if (fd === -3) continue; // ESRCH
          throw failure("pidfd_open", fd);
        }
        try {
          const current = readProc(previous.pid);
          if (!current || !sameLinuxProcess(current, previous)) continue;
          const ancestry = new Map<number, LinuxProcessIdentity>([[current.pid, current]]);
          let ancestor = current;
          while (ancestor.pid !== owner.pid && ancestor.ppid && !ancestry.has(ancestor.ppid)) {
            withinDeadline(observationDeadline);
            const next = readProc(ancestor.ppid);
            if (!next) break;
            ancestry.set(next.pid, next);
            ancestor = next;
          }
          if (!isLinuxDescendant(current, owner, ancestry)) continue;
          const signalResult = api.tui_pidfd_signal(fd, force ? 9 : 15);
          if (signalResult < 0 && signalResult !== -3) {
            throw failure("pidfd_send_signal", signalResult);
          }
          if (current.state === "Z" && current.ppid === owner.pid && current.pid !== targetPid) {
            // P_PIDFD consumes only this pinned child's status, even if another
            // reaper consumed it since the stat read. Never steal Bun's target.
            const result = api.tui_waitid(3, fd, waitInfo, 0x40000005); // WEXITED | WNOHANG | __WALL
            if (result < 0 && result !== -10 && result !== -4) {
              throw failure("waitid(P_PIDFD) adopted child", result); // ECHILD/EINTR need a fresh sweep.
            }
          }
        } finally {
          // close may release the descriptor even on failure; never retry it.
          check("close descendant pidfd", api.tui_close(fd));
        }
      }
      // A directory snapshot alone can miss a just-forked/adopted child if its
      // ancestor exited during enumeration. ECHILD closes that race: with a live
      // subreaper every descendant must still have an ancestor directly under us.
      return descendants.length === 0 && noChildren();
    },
  };
}

/**
 * Return -errno in the SAME native call. A later __errno_location FFI call
 * observes mutable thread-local state after Bun/JS has resumed, not a durable
 * result of waitid. In particular, EAGAIN must never stand in for ECHILD.
 * Bun's bundled compiler needs no system headers or external compiler here.
 */
export async function loadLinuxProcessCalls() {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("native Linux process calls require Linux x64 or arm64");
  }
  const { cc, dlopen } = await import("bun:ffi");
  // Linux >=5.4 required by P_PIDFD also supports memfd_create (3.17).
  // Keep the tiny source anonymous and CLOEXEC; leave no shared generated file.
  const loader = dlopen("libc.so.6", {
    memfd_create: { args: ["cstring", "u32"], returns: "i32" },
  });
  try {
    const fd = loader.symbols.memfd_create(Buffer.from("tui-process-calls.c\0"), 1);
    if (fd < 0) throw new Error("cannot allocate native Linux process calls source");
    try {
      writeFileSync(fd, `
extern int *__errno_location(void);
extern int prctl(int, ...);
extern long syscall(long, ...);
extern int waitid(int, unsigned int, void *, int);
extern int close(int);
static int checked(long result) { return result < 0 ? -*__errno_location() : (int)result; }
int tui_prctl(int option, unsigned long value) {
  return checked(prctl(option, value, 0UL, 0UL, 0UL));
}
int tui_pidfd_open(int pid) { return checked(syscall(434L, (long)pid, 0L)); }
int tui_pidfd_signal(int fd, int signal) {
  return checked(syscall(424L, (long)fd, (long)signal, 0L, 0L));
}
int tui_waitid(int type, unsigned int id, void *info, int options) {
  return checked(waitid(type, id, info, options));
}
int tui_close(int fd) { return checked(close(fd)); }
`);
      return cc({
        source: `/proc/self/fd/${fd}`, flags: ["-xc"],
        symbols: {
          tui_prctl: { args: ["i32", "u64"], returns: "i32" },
          tui_pidfd_open: { args: ["i32"], returns: "i32" },
          tui_pidfd_signal: { args: ["i32", "i32"], returns: "i32" },
          tui_waitid: { args: ["i32", "u32", "ptr", "i32"], returns: "i32" },
          tui_close: { args: ["i32"], returns: "i32" },
        },
      });
    } finally { closeSync(fd); }
  } finally { loader.close(); }
}

/** Header-free wrappers bind each failure to errno before returning to Bun/JS. */
export async function loadDarwinProcessCalls() {
  if (process.platform !== "darwin" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("native Darwin process calls require macOS x64 or arm64");
  }
  // This module also loads under Node for driver handoff; bun:ffi cannot load there.
  const { cc } = await import("bun:ffi");
  // Darwin has no memfd. Keep the compiler input private and remove it even on
  // compilation failure; the returned library owns the compiled allocation.
  const directory = mkdtempSync(join(tmpdir(), "aidlc-darwin-process-"));
  const source = join(directory, "calls.c");
  try {
    writeFileSync(source, `
extern int *__error(void);
extern int proc_listpids(unsigned int, unsigned int, void *, int);
extern int proc_pidinfo(int, int, unsigned long long, void *, int);
extern int sysctl(int *, unsigned int, void *, unsigned long *, void *, unsigned long);
extern int kill(int, int);
extern int waitid(int, unsigned int, void *, int);
static int checked(int result) { return result < 0 ? -*__error() : result; }
int tui_listpids(void *buffer, int size) {
  *__error() = 0;
  int result = proc_listpids(1, 0, buffer, size);
  return result > 0 ? result : -(*__error() ? *__error() : 5);
}
int tui_pidinfo(int pid, void *buffer) {
  *__error() = 0;
  int result = proc_pidinfo(pid, 3, 0ULL, buffer, ${DARWIN_BSDINFO_SIZE});
  return result > 0 ? result : -(*__error() ? *__error() : 5);
}
int tui_argmax(void) {
  int mib[2] = {1, 8}, value = 0;
  unsigned long size = sizeof(value);
  int result = checked(sysctl(mib, 2, &value, &size, 0, 0));
  return result < 0 ? result : (size == sizeof(value) ? value : -5);
}
int tui_procargs(int pid, void *buffer, unsigned long size) {
  int mib[3] = {1, 49, pid};
  int result = checked(sysctl(mib, 3, buffer, &size, 0, 0));
  return result < 0 ? result : (int)size;
}
int tui_kill(int pid, int signal) { return checked(kill(pid, signal)); }
int tui_waitid(int type, unsigned int id, void *info, int options) {
  return checked(waitid(type, id, info, options));
}
`, { mode: 0o600 });
    return cc({
      source,
      symbols: {
        tui_listpids: { args: ["ptr", "i32"], returns: "i32" },
        tui_pidinfo: { args: ["i32", "ptr"], returns: "i32" },
        tui_argmax: { args: [], returns: "i32" },
        tui_procargs: { args: ["i32", "ptr", "u64"], returns: "i32" },
        tui_kill: { args: ["i32", "i32"], returns: "i32" },
        tui_waitid: { args: ["i32", "u32", "ptr", "i32"], returns: "i32" },
      },
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}


async function containDarwin(parentPid: number): Promise<Containment> {
  const library = await loadDarwinProcessCalls();
  const api = library.symbols;
  const failure = (call: string, result: number): Error => new Error(`${call} failed: errno ${-result}`);
  const identityBuffer = new Uint8Array(DARWIN_BSDINFO_SIZE);
  const readIdentity = (pid: number) => readDarwinProcessIdentity(pid, api, identityBuffer);
  const owner = readIdentity(process.pid);
  const parent = readIdentity(parentPid);
  if (!owner || !parent || owner.ppid !== parentPid || darwinStartedAfter(parent, owner)) {
    throw new Error("supervisor parent identity lost before containment");
  }
  const parentAlive = (): boolean => {
    const current = readIdentity(parentPid);
    return process.ppid === parentPid && current !== null &&
      sameDarwinProcess(current, parent) && current.status !== 5; // SZOMB
  };
  if (!parentAlive()) throw new Error("supervisor parent exited during containment setup");
  const argmax = api.tui_argmax();
  if (argmax < 0) throw failure("sysctl(KERN_ARGMAX)", argmax);
  if (argmax < 5) throw new Error("invalid Darwin KERN_ARGMAX");
  // KERN_PROCARGS2 adds argc to the argument area bounded by KERN_ARGMAX.
  const argumentsBuffer = new Uint8Array(argmax + 4);
  const waitInfo = new BigUint64Array(16); // At least Darwin's 104-byte siginfo_t, 8-byte aligned.
  let pids = new Int32Array(256);
  const token = randomUUID();
  const retained = new Map<number, DarwinProcessIdentity>();
  const snapshot = (deadline: number): Map<number, DarwinProcessIdentity> => {
    let bytes: number;
    while (true) {
      withinDeadline(deadline);
      bytes = api.tui_listpids(pids, pids.byteLength);
      if (bytes < 0) throw failure("proc_listpids", bytes);
      if (bytes % 4 !== 0 || bytes > pids.byteLength) throw new Error("invalid Darwin process list");
      if (bytes < pids.byteLength) break;
      if (pids.length >= 1_048_576) throw new Error("Darwin process inventory exceeds the supported capacity");
      pids = new Int32Array(pids.length * 2);
    }
    const result = new Map<number, DarwinProcessIdentity>();
    for (let i = 0; i < bytes / 4; i++) {
      withinDeadline(deadline);
      if (pids[i] <= 0) continue;
      const identity = readDarwinProcessIdentity(pids[i], api, identityBuffer, "enumeration");
      if (identity) result.set(identity.pid, identity);
    }
    for (const identity of result.values()) {
      withinDeadline(deadline);
      if (identity.pid === owner.pid || identity.uid !== owner.uid || identity.status === 5) continue;
      const size = api.tui_procargs(identity.pid, argumentsBuffer, argumentsBuffer.byteLength);
      // The kernel cannot expose arguments for exited, exec-transitioning or
      // protected processes. Such a process can still be owned through ancestry
      // or an identity retained by a prior sweep, never by its executable name.
      if ([-3, -22, -1, -13, -5].includes(size)) continue;
      if (size < 0) throw failure(`sysctl(KERN_PROCARGS2, ${identity.pid})`, size);
      if (size > argumentsBuffer.byteLength) throw new Error("oversized Darwin process arguments");
      const current = readIdentity(identity.pid);
      if (current && sameDarwinProcess(identity, current)) {
        identity.env = parseDarwinProcArgs(argumentsBuffer.subarray(0, size)).env;
      }
    }
    return result;
  };
  // There is no subreaper/pidfd on Darwin, and NOTE_TRACK is unsupported. The
  // inherited exec-time token finds double-fork orphans under launchd, including
  // those in other sessions. A process that BOTH escapes ancestry and execs with
  // a scrubbed environment is undetectable (unlike Linux/Windows containment).
  // Identity checks narrow but cannot eliminate Darwin's check-to-kill PID race.
  return {
    library, parentAlive, env: { AIDLC_TUI_CONTAINMENT: token },
    sweep(force, targetPid, deadline, signalOnly = false) {
      const observationDeadline = signalOnly ? Infinity : deadline;
      const processes = snapshot(observationDeadline);
      const owned: DarwinProcessIdentity[] = [];
      for (const identity of processes.values()) {
        const previous = retained.get(identity.pid);
        if (identity.uid === owner.uid && ((previous && sameDarwinProcess(previous, identity)) ||
          isDarwinDescendant(identity, owner, processes, token))) {
          owned.push(identity);
        }
      }
      // Retain observed ownership through zombie state, when procargs disappears.
      retained.clear();
      for (const previous of owned) {
        withinDeadline(observationDeadline);
        retained.set(previous.pid, previous);
        const current = readIdentity(previous.pid);
        if (!current || !sameDarwinProcess(current, previous) || current.uid !== owner.uid) continue;
        const signaled = api.tui_kill(current.pid, force ? 9 : 15);
        if (signaled < 0 && signaled !== -3) throw failure("kill(Darwin descendant)", signaled);
        if (current.status === 5 && current.ppid === owner.pid && current.pid !== targetPid) {
          const result = api.tui_waitid(1, current.pid, waitInfo, 5); // P_PID, WEXITED | WNOHANG
          if (result < 0 && result !== -10 && result !== -4) {
            throw failure("waitid(P_PID) Darwin child", result); // ECHILD/EINTR need a fresh sweep.
          }
        }
      }
      withinDeadline(observationDeadline);
      if (owned.length !== 0) return false;
      // Observe without stealing Bun's target status. Unlike Linux's subreaper,
      // ECHILD alone is insufficient; the token-owned set must also be empty.
      const result = api.tui_waitid(0, 0, waitInfo, 0x25); // P_ALL, WEXITED | WNOHANG | WNOWAIT
      if (result === -10) return true;
      if (result === 0 || result === -4) return false;
      throw failure("waitid(P_ALL, WNOWAIT)", result);
    },
  };
}

/** Win64 ABI: BASIC_LIMIT=64, IO_COUNTERS=48, four SIZE_Ts=32; flags at byte 16. */
export function windowsJobLimits(): Uint8Array {
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, 0x2000, true); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  return limits; // Neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK is set.
}

export interface WindowsJobTerminationApi<Handle> {
  IsProcessInJob(handle: Handle, job: Handle, member: Int32Array): number;
  TerminateProcess(handle: Handle, exitCode: number): number;
  WaitForSingleObject(handle: Handle, milliseconds: number): number;
  GetLastError(): number;
}

export interface WindowsJobTerminationObservation {
  pid: number;
  terminateError: number;
  initialWait: number;
  waitBudgetMs: number;
  finalWait: number;
  waitError?: number;
}

/**
 * The caller owns a handle opened with TERMINATE | SYNCHRONIZE | QUERY_LIMITED
 * and closes it after this returns. Never re-open a numeric PID during the wait.
 */
export function terminateWindowsJobMember<Handle>(
  api: WindowsJobTerminationApi<Handle>,
  handle: Handle,
  job: Handle,
  pid: number,
  deadline: number,
  now: () => number = () => performance.now(),
  observe: (event: WindowsJobTerminationObservation) => void = () => {},
  signalOnly = false,
): void {
  const fail = (call: string, code: number, detail = "") =>
    new Error(`${call}(job member ${pid}) failed: Windows error ${code}${detail}`);
  if (!signalOnly && now() >= deadline) throw new Error(`job member ${pid} cleanup exceeded its deadline`);
  const member = new Int32Array(1);
  if (!api.IsProcessInJob(handle, job, member)) throw fail("IsProcessInJob", api.GetLastError());
  if (member[0] !== 1) throw new Error(`Job Object PID ${pid} ownership changed; refusing termination`);
  const before = api.WaitForSingleObject(handle, 0);
  if (before === 0) return;
  if (before !== 258) throw fail("WaitForSingleObject", api.GetLastError(), `; wait=${before}`);
  if (api.TerminateProcess(handle, 1)) return;
  const code = api.GetLastError();
  const initialWait = api.WaitForSingleObject(handle, 0);
  let finalWait = initialWait;
  let waitBudgetMs = 0;
  // Another teardown (including a parent's job closing) can have initiated
  // termination without the process object being signaled yet. ERROR_ACCESS_DENIED
  // is not evidence of exit: observe this exact handle within the existing budget.
  if (!signalOnly && code === 5 && initialWait === 258) {
    waitBudgetMs = Math.max(0, Math.min(CLEANUP_MS, Math.floor(deadline - now())));
    if (waitBudgetMs > 0) finalWait = api.WaitForSingleObject(handle, waitBudgetMs);
  }
  const waitError = finalWait === 0xffffffff ? api.GetLastError() : undefined;
  observe({ pid, terminateError: code, initialWait, waitBudgetMs, finalWait, waitError });
  if (code === 5 && finalWait === 0) return;
  throw fail("TerminateProcess", code,
    `; initial wait=${initialWait}; final wait=${finalWait}; waited at most ${waitBudgetMs}ms` +
    (waitError === undefined ? "" : `; wait error=${waitError}`));
}

async function containWindows(parentPid: number): Promise<Containment> {
  if (!["x64", "arm64"].includes(process.arch)) throw new Error("Windows supervision requires a 64-bit Bun ABI");
  const { dlopen } = await import("bun:ffi");
  // Win64 uses the unified C calling convention. BOOL/DWORD are 32-bit, HANDLE
  // is pointer-sized; do NOT use FFI bool for a Windows BOOL. No inherited handles.
  const library = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
    IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    TerminateProcess: { args: ["ptr", "u32"], returns: "i32" },
    SetHandleInformation: { args: ["ptr", "u32", "u32"], returns: "i32" },
    GetHandleInformation: { args: ["ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    SetConsoleOutputCP: { args: ["u32"], returns: "i32" },
    SetConsoleCP: { args: ["u32"], returns: "i32" },
    SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" },
  });
  const api = library.symbols;
  const failure = (call: string, code = api.GetLastError()): Error =>
    new Error(`${call} failed: Windows error ${code}`);
  const check = (result: number, call: string): void => { if (!result) throw failure(call); };
  const open = (pid: number, rights: number) => {
    const handle = api.OpenProcess(rights, 0, pid);
    if (!handle) throw failure(`OpenProcess(${pid})`);
    return handle;
  };
  // A real self handle avoids passing the (-1) pseudo-handle through JS pointers.
  const self = open(process.pid, 0x1101); // QUERY_LIMITED_INFORMATION | SET_QUOTA | TERMINATE
  const parent = open(parentPid, 0x101000); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
  const creationTime = (handle: typeof self): bigint => {
    const times = Array.from({ length: 4 }, () => new Uint32Array(2));
    check(api.GetProcessTimes(handle, times[0], times[1], times[2], times[3]), "GetProcessTimes");
    return (BigInt(times[0][1]) << 32n) | BigInt(times[0][0]);
  };
  const parentAlive = (): boolean => {
    const state = api.WaitForSingleObject(parent, 0);
    if (state === 0) return false;
    if (state === 258) return true; // WAIT_TIMEOUT: same process object still running.
    throw failure("WaitForSingleObject(parent)", state === 0xffffffff ? api.GetLastError() : state);
  };
  // If a stale numeric parent PID was recycled, its new creation time is after ours.
  const selfCreation = creationTime(self);
  if (process.ppid !== parentPid || creationTime(parent) >= selfCreation || !parentAlive()) {
    throw new Error("supervisor parent identity lost before Job Object setup");
  }
  const job = api.CreateJobObjectW(null, null); // Unnamed + NULL SECURITY_ATTRIBUTES => non-inheritable.
  if (!job) throw failure("CreateJobObjectW");
  check(api.SetHandleInformation(job, 1, 0), "SetHandleInformation(job, no inherit)");
  const handleFlags = new Uint32Array(1);
  check(api.GetHandleInformation(job, handleFlags), "GetHandleInformation(job)");
  if (handleFlags[0] & 1) throw new Error("Job Object handle is inheritable");
  const limits = windowsJobLimits();
  check(api.SetInformationJobObject(job, 9, limits, limits.byteLength), "SetInformationJobObject(ExtendedLimit)");
  check(api.AssignProcessToJobObject(job, self), "AssignProcessToJobObject(supervisor)");
  const member = new Int32Array(1);
  check(api.IsProcessInJob(self, job, member), "IsProcessInJob(supervisor)");
  if (member[0] !== 1) throw new Error("supervisor is not in its Job Object");
  const observed = new Uint8Array(144);
  check(api.QueryInformationJobObject(job, 9, observed, observed.byteLength, null), "QueryInformationJobObject(ExtendedLimit)");
  if (new DataView(observed.buffer).getUint32(16, true) !== 0x2000) {
    throw new Error("Job Object containment flags verification failed");
  }
  // The inline PTY gives this wrapper its own console; affect no shared console.
  check(api.SetConsoleOutputCP(65001), "SetConsoleOutputCP(65001)");
  check(api.SetConsoleCP(65001), "SetConsoleCP(65001)");
  // Ignore Ctrl-C through our installed JS handler, not the inheritable Windows
  // ignore attribute. The real CLI must still be able to receive CTRL_C_EVENT.
  check(api.SetConsoleCtrlHandler(null, 0), "SetConsoleCtrlHandler(enable Ctrl-C)");
  if (!parentAlive()) throw new Error("supervisor parent exited during Job Object setup");
  check(api.CloseHandle(self), "CloseHandle(self)");
  const terminationTrace = process.env.AIDLC_TEST_DEBUG === "true" && process.env.AIDLC_TEST_LOG_DIR
    ? join(process.env.AIDLC_TEST_LOG_DIR, `tui-bun-supervisor-${process.pid}-${randomUUID()}.ndjson`) : undefined;
  const observeTermination = (event: WindowsJobTerminationObservation, handle: typeof self): void => {
    let memberIdentity: string | undefined;
    let identityError: string | undefined;
    if (terminationTrace) {
      try { memberIdentity = `win32:${event.pid}:${creationTime(handle)}`; }
      catch (error) { identityError = message(error); }
    }
    if (terminationTrace) appendFileSync(terminationTrace,
      `${JSON.stringify({
        ts: new Date().toISOString(), event: "termination-observation",
        supervisorIdentity: `win32:${process.pid}:${selfCreation}`, memberIdentity, identityError, ...event,
      })}\n`);
  };
  // Keep library, parent handle and especially job handle alive until process exit.
  // Closing the job here would also kill this wrapper, before its final status write.
  return {
    library,
    parentAlive,
    sweep(_force, _targetPid, deadline, signalOnly = false) {
      const observationDeadline = signalOnly ? Infinity : deadline;
      let capacity = 64;
      let list: Uint8Array;
      while (true) {
        withinDeadline(observationDeadline);
        list = new Uint8Array(8 + capacity * 8); // DWORD counts + ULONG_PTR[capacity]
        if (api.QueryInformationJobObject(job, 3, list, list.byteLength, null)) break;
        const code = api.GetLastError();
        if (code !== 234 || capacity >= 65_536) throw failure("QueryInformationJobObject(ProcessIdList)", code);
        capacity *= 2; // ERROR_MORE_DATA, not an empty job.
      }
      const view = new DataView(list.buffer);
      const assigned = view.getUint32(0, true);
      const count = view.getUint32(4, true);
      if (count > capacity || assigned !== count) throw new Error("incomplete Job Object process list");
      let descendants = 0;
      let foundSelf = false;
      for (let i = 0; i < count; i++) {
        withinDeadline(observationDeadline);
        const pid = Number(view.getBigUint64(8 + i * 8, true));
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error("invalid Job Object PID");
        if (pid === process.pid) { foundSelf = true; continue; }
        descendants++;
        const handle = api.OpenProcess(0x101001, 0, pid); // QUERY_LIMITED | SYNCHRONIZE | TERMINATE
        if (!handle) {
          const code = api.GetLastError();
          if (code === 87) continue; // Process disappeared; require a fresh empty scan.
          throw failure("OpenProcess(job member)", code);
        }
        try {
          terminateWindowsJobMember(api, handle, job, pid, deadline, undefined,
            (event) => observeTermination(event, handle), signalOnly);
        } finally {
          check(api.CloseHandle(handle), "CloseHandle(job member)");
        }
      }
      if (!foundSelf) throw new Error("supervisor disappeared from its Job Object");
      return descendants === 0;
    },
  };
}

export async function createNativeContainment(parentPid: number): Promise<Containment> {
  if (process.platform === "linux") return containLinux(parentPid);
  if (process.platform === "win32") return containWindows(parentPid);
  if (process.platform === "darwin") return containDarwin(parentPid);
  throw new Error(`native session containment is unsupported on ${process.platform}`);
}

/** Process entry point: call only inside the dedicated supervisor, never in the daemon. */
export async function runSupervisor(
  configPath: string,
  contain: (parentPid: number) => Promise<Containment> = createNativeContainment,
): Promise<void> {
  let requestedAt: number | undefined;
  let requestedDeadlineMs: number | undefined;
  const requestStop = (): void => { requestedAt ??= performance.now(); };
  const acceptStop = (request: SupervisorStopRequest): void => {
    if (request.cleanupDeadlineMs !== undefined) {
      requestedDeadlineMs = Math.min(requestedDeadlineMs ?? Infinity, request.cleanupDeadlineMs);
    }
  };
  // Cooked Ctrl-C is delivered to the foreground group, including the target.
  // Keep the stable wrapper alive; Bun resets caught signal handlers in the child.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", requestStop);
  process.on("SIGHUP", requestStop);
  const config = readConfig(configPath);
  const status: SupervisorStatus = {
    token: config.token, supervisorPid: process.pid, phase: "error", cleanupComplete: false,
  };
  let containment: Containment | undefined;
  let targetExited = false;
  let failed = false;
  const recordError = (error: unknown): void => {
    failed = true;
    status.error = status.error ? `${status.error}; ${message(error)}` : message(error);
    status.phase = "error";
  };
  const stopRequested = (): boolean => {
    try { remainingOperationTimeoutMs(undefined, { phase: "native supervisor work" }); }
    catch (error) {
      if (!(error instanceof TestBudgetExhaustedError)) throw error;
      requestStop();
    }
    if (initialStopRequested(config, acceptStop) || !containment!.parentAlive()) requestStop();
    return requestedAt !== undefined;
  };
  try {
    containment = await contain(config.parentPid);
    // Probe cleanup enumeration before ready. No target exists yet.
    if (!containment.sweep(false, undefined, performance.now() + CLEANUP_MS)) {
      throw new Error("unexpected descendants before release");
    }
    if (!stopRequested()) {
      status.phase = "ready";
      publish(config.statusPath, status);
      while (!stopRequested() && !markerExists(config.releasePath)) await delay(POLL_MS);
    }
    if (!stopRequested()) {
      const child = Bun.spawn(config.command, {
        cwd: config.cwd,
        env: { ...process.env, ...containment!.env, TERM: "xterm-256color" },
        stdin: "inherit", stdout: "inherit", stderr: "inherit",
        windowsVerbatimArguments: config.windowsVerbatimArguments,
        onExit(child, exitCode, signalCode, error) {
          targetExited = true;
          status.exitCode = exitCode;
          status.signal = child.signalCode ??
            (signalCode ? Object.entries(osConstants.signals).find(([, n]) => n === signalCode)?.[0] ?? String(signalCode) : null);
          if (error) recordError(error);
        },
      });
      status.targetPid = child.pid;
      status.phase = "running";
      publish(config.statusPath, status);
      while (!targetExited && !stopRequested()) await delay(POLL_MS);
    }
  } catch (error) {
    recordError(error);
  }
  // Publish target exit fields before cleanup too. cleanupComplete is the commit
  // point; neither this phase nor PTY EOF alone proves descendant cleanup.
  status.phase = failed ? "error" : requestedAt !== undefined ? "stopped" : "exited";
  try { publish(config.statusPath, status); } catch (error) { recordError(error); }
  while (true) {
    const cleanupStarted = performance.now();
    const hardDeadlineMs = nativeCleanupDeadlineMs(CLEANUP_MS, requestedDeadlineMs);
    const deadline = Math.min(cleanupStarted + hardDeadlineMs - Date.now(), (requestedAt ?? cleanupStarted) + CLEANUP_MS);
    try {
      if (containment) {
        while (true) {
          withinDeadline(deadline);
          const empty = containment.sweep(
            performance.now() - cleanupStarted >= GRACE_MS || deadline - performance.now() <= GRACE_MS,
            targetExited ? undefined : status.targetPid,
            deadline,
          );
          if (empty && (!status.targetPid || targetExited)) break;
          await delay(Math.min(POLL_MS, Math.max(1, deadline - performance.now())));
        }
      } else if (status.targetPid) {
        throw new Error("target launched without containment");
      }
      status.cleanupComplete = true;
    } catch (error) {
      recordError(error);
      // No new clock or grace period: signal one freshly verified owned set,
      // without waiting. Only an actually empty tree AND the observed target
      // exit can close ownership; issuing a signal alone is never sufficient.
      if (containment) {
        try {
          const empty = containment.sweep(true, targetExited ? undefined : status.targetPid, deadline, true);
          if (empty && (!status.targetPid || targetExited)) status.cleanupComplete = true;
        }
        catch (stopError) { recordError(stopError); }
      }
    }
    status.phase = failed ? "error" : requestedAt !== undefined ? "stopped" : "exited";
    status.cleanupRetryToken = !status.cleanupComplete && process.platform !== "win32" ? randomUUID() : undefined;
    try { publish(config.statusPath, status); } catch (error) {
      recordError(error);
      console.error(`native supervisor status write failed: ${message(error)}`);
    }
    if (!status.cleanupRetryToken) break;
    // Preserve the same supervisor and containment object. Existence of the old
    // stop marker, old requests and signals cannot silently restart this budget.
    let retry = cleanupRetryRequested(config, status.cleanupRetryToken);
    while (!retry) {
      await delay(POLL_MS);
      retry = cleanupRetryRequested(config, status.cleanupRetryToken);
    }
    acceptStop(retry);
    requestedAt = performance.now();
    status.cleanupRetryToken = undefined;
  }
  process.exit(failed ? 1 : 0); // On Windows the OS now closes the last job handle.
}

if (import.meta.main) {
  if (process.argv[2] !== "--supervise" || !process.argv[3] || process.argv.length !== 4) {
    console.error("usage: bun tui-bun-process.ts --supervise <private-config.json>");
    process.exit(1);
  }
  runSupervisor(process.argv[3]).catch((error: unknown) => {
    console.error(`native supervisor failed before launch: ${message(error)}`);
    process.exit(1);
  });
}
