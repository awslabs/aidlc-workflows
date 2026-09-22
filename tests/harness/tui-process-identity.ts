// Read-only identities for native session lock owners and daemon retirement.
// Do not import the supervisor: callers may run under Node and never own a PTY.
import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    throw new Error(`native process identity requires a positive DWORD PID; got ${pid}`);
  }
}

/** /proc stat field 22 is starttime; comm can contain spaces, ')' and newlines. */
export function parseLinuxNativeProcessIdentity(pid: number, stat: string): string | null {
  validatePid(pid);
  const prefix = /^([1-9]\d*) \(/.exec(stat);
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  if (
    !prefix || Number(prefix[1]) !== pid || close < prefix[0].length ||
    !/^\s/.test(stat.slice(close + 1)) ||
    !/^[A-Za-z]$/.test(fields[0] ?? "") || !/^\d+$/.test(fields[19] ?? "")
  ) {
    throw new Error(`invalid /proc/${pid}/stat identity`);
  }
  const startTicks = BigInt(fields[19]);
  if (["Z", "X", "x"].includes(fields[0])) return null;
  return `linux:${pid}:${startTicks}`;
}

type ReadStat = (path: string) => Promise<string>;

/** Injectable reads let unit tests distinguish absence from unreadable procfs. */
export async function readLinuxNativeProcessIdentity(
  pid: number,
  readStat: ReadStat = (path) => readFile(path, "utf8"),
): Promise<string | null> {
  validatePid(pid);
  let stat: string;
  try {
    stat = await readStat(`/proc/${pid}/stat`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
    // Missing/unmounted procfs is not proof that a lock owner has exited.
    if (parseLinuxNativeProcessIdentity(process.pid, await readStat("/proc/self/stat")) === null) {
      throw new Error("native process identity cannot verify live procfs");
    }
    return null;
  }
  return parseLinuxNativeProcessIdentity(pid, stat);
}

export const DARWIN_BSDINFO_SIZE = 136;

export interface DarwinProcessIdentity {
  pid: number;
  ppid: number;
  uid: number;
  status: number;
  startSec: bigint;
  startUsec: bigint;
  env?: readonly string[];
}

export interface DarwinIdentityApi {
  tui_pidinfo(pid: number, buffer: Uint8Array): number;
}

/** The caller returns -errno, captured immediately in the native call or its adapter. */
export function readDarwinProcessIdentity(
  pid: number,
  api: DarwinIdentityApi,
  buffer = new Uint8Array(DARWIN_BSDINFO_SIZE),
  mode: "required" | "enumeration" = "required",
): DarwinProcessIdentity | null {
  validatePid(pid);
  if (buffer.byteLength !== DARWIN_BSDINFO_SIZE) throw new Error("Darwin process identity requires a 136-byte buffer");
  const count = api.tui_pidinfo(pid, buffer);
  if (count === -3) return null; // ESRCH
  // System-wide scans encounter other users' and protected processes. Only the
  // enumeration caller may exclude these; required ownership reads fail closed.
  if (count === -1 && mode === "enumeration") return null; // EPERM
  if (count < 0) throw new Error(`proc_pidinfo(${pid}) failed: errno ${-count}`);
  if (count !== DARWIN_BSDINFO_SIZE) throw new Error(`proc_pidinfo(${pid}) returned ${count} bytes, expected 136`);
  return parseDarwinProcBsdInfo(pid, buffer);
}

/** proc_bsdinfo's fixed ABI is shared by Darwin arm64 and x64; offsets live only here. */
export function parseDarwinProcBsdInfo(pid: number, buffer: Uint8Array): DarwinProcessIdentity {
  validatePid(pid);
  if (buffer.byteLength !== DARWIN_BSDINFO_SIZE) throw new Error("Darwin process identity requires a 136-byte buffer");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(12, true) !== pid) {
    throw new Error(`proc_pidinfo(${pid}) returned an invalid proc_bsdinfo identity`);
  }
  return {
    pid, ppid: view.getUint32(16, true), uid: view.getUint32(20, true),
    status: view.getUint32(4, true),
    startSec: view.getBigUint64(120, true), startUsec: view.getBigUint64(128, true),
  };
}

async function readDarwinWithFfi(pid: number): Promise<string | null> {
  if (!process.versions.bun || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("Darwin native process identity requires Bun with bun:ffi on x64 or arm64");
  }
  // Node can import this module, but only Bun can enter the Darwin FFI path.
  const { dlopen, read } = await import("bun:ffi");
  const library = dlopen("libSystem.B.dylib", {
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
  });
  try {
    const identity = readDarwinProcessIdentity(pid, {
      tui_pidinfo(pid, buffer) {
        const count = library.symbols.proc_pidinfo(pid, 3, 0, buffer, DARWIN_BSDINFO_SIZE);
        // Read errno immediately: libproc returns zero on failure. Unlike the
        // supervisor's cc wrapper, this crosses JS and errno can become stale.
        const code = count <= 0 ? read.i32(library.symbols.__error()!) : 0;
        return count > 0 ? count : -(code || 5);
      },
    });
    if (!identity || identity.status === 5) return null; // SZOMB is observed exit.
    return `darwin:${pid}:${identity.startSec * 1_000_000n + identity.startUsec}`;
  } finally { library.close(); }
}

export interface WindowsIdentityApi<Handle> {
  OpenProcess(access: number, inherit: number, pid: number): Handle | null;
  GetProcessTimes(
    handle: Handle, creation: Uint32Array, exit: Uint32Array,
    kernel: Uint32Array, user: Uint32Array,
  ): number;
  WaitForSingleObject(handle: Handle, milliseconds: number): number;
  CloseHandle(handle: Handle): number;
  GetLastError(): number;
}

/** Every query and close addresses one stable handle, never a second PID lookup. */
export function readWindowsNativeProcessIdentity<Handle>(
  pid: number,
  api: WindowsIdentityApi<Handle>,
): string | null {
  validatePid(pid);
  const failure = (call: string, code = api.GetLastError()) =>
    new Error(`${call}(${pid}) failed: Windows error ${code}`);
  // PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE; no termination rights.
  const handle = api.OpenProcess(0x101000, 0, pid);
  if (handle === null) {
    const code = api.GetLastError();
    // With a validated nonzero PID and fixed flags, INVALID_PARAMETER means
    // there is no process for that PID. ACCESS_DENIED (5) remains an error.
    if (code === 87) return null;
    throw failure("OpenProcess", code);
  }
  const running = (): boolean => {
    const result = api.WaitForSingleObject(handle, 0);
    if (result === 0) return false; // WAIT_OBJECT_0: this process has exited.
    if (result === 258) return true; // WAIT_TIMEOUT: this process is still live.
    if (result === 0xffffffff) throw failure("WaitForSingleObject");
    throw new Error(`WaitForSingleObject(${pid}) returned unexpected status ${result}`);
  };
  try {
    if (!running()) return null;
    const times = Array.from({ length: 4 }, () => new Uint32Array(2));
    if (!api.GetProcessTimes(handle, times[0], times[1], times[2], times[3])) {
      throw failure("GetProcessTimes");
    }
    const creation = (BigInt(times[0][1]) << 32n) | BigInt(times[0][0]);
    if (!running()) return null;
    return `win32:${pid}:${creation}`;
  } finally {
    if (!api.CloseHandle(handle)) {
      // biome-ignore lint/correctness/noUnsafeFinally: Failed handle cleanup must invalidate the identity observation, including a pending null return.
      throw failure("CloseHandle");
    }
  }
}

async function readWindowsWithFfi(pid: number): Promise<string | null> {
  if (!["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Windows native process identity requires 64-bit Bun; got ${process.arch}`);
  }
  const { dlopen } = await import("bun:ffi").catch((error: unknown) => {
    throw new Error(`Windows native process identity requires Bun with bun:ffi: ${String(error)}`);
  });
  const library = dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
  try {
    return readWindowsNativeProcessIdentity(pid, library.symbols);
  } finally {
    library.close();
  }
}

/** Node's Windows client can delegate this read to Bun without importing FFI. */
export async function getNativeProcessIdentityWithBun(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  validatePid(pid);
  const bin = env.AIDLC_BUN_BIN ?? (process.versions.bun ? process.execPath : "bun");
  if (!bin.trim() || bin.includes("\0")) throw new Error("invalid AIDLC_BUN_BIN for native process identity");
  return new Promise((accept, reject) => {
    execFile(bin, [fileURLToPath(import.meta.url), "--native-process-identity", String(pid)], {
      env, encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`native process identity requires a working Bun executable (${bin}): ${stderr.trim() || error.message}`));
        return;
      }
      try {
        const reply = JSON.parse(stdout);
        if (
          reply?.pid !== pid ||
          !(reply.identity === null ||
            (typeof reply.identity === "string" &&
              new RegExp(`^${process.platform}:${pid}:\\d+$`).test(reply.identity)))
        ) throw new Error("invalid native process identity response");
        accept(reply.identity);
      } catch (error) { reject(error); }
    });
  });
}

/** Null means observed absence/exit; inability to establish identity always throws. */
export async function getNativeProcessIdentity(pid: number): Promise<string | null> {
  validatePid(pid);
  if (process.platform === "linux") return readLinuxNativeProcessIdentity(pid);
  if (process.platform === "win32") {
    return process.versions.bun ? readWindowsWithFfi(pid) : getNativeProcessIdentityWithBun(pid);
  }
  if (process.platform === "darwin") return readDarwinWithFfi(pid);
  throw new Error(`native process identity is unsupported on ${process.platform}; requires Linux, Windows or macOS`);
}

/**
 * Hold a persistent lock file through an OS-owned descriptor/handle.
 * Never unlink it: another owner may already be waiting on the same inode.
 * FFI loads only when called; Node may safely import the identity functions.
 */
export async function acquireNativeLock(path: string): Promise<() => void> {
  if (!path || path.includes("\0")) throw new Error("native lock requires a nonempty file path");
  if (process.platform !== "linux" && process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error(`native lock is unsupported on ${process.platform}; requires Linux, Windows or macOS`);
  }
  if (!process.versions.bun) throw new Error("acquireNativeLock requires Bun with bun:ffi");
  const { dlopen, read } = await import("bun:ffi");
  const busy = () => new Error(`native lock already in progress: ${path}`);

  if (process.platform === "linux" || process.platform === "darwin") {
    const definitions = {
      flock: { args: ["i32", "i32"], returns: "i32" },
      fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
    } as const;
    const load = () => {
      if (process.platform === "darwin") {
        const library = dlopen("libSystem.B.dylib", {
          ...definitions, __error: { args: [], returns: "ptr" },
        });
        return { library, errno: () => read.i32(library.symbols.__error()!) };
      }
      const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
      let lastError: unknown;
      for (const candidate of ["libc.so.6", `/lib/ld-musl-${arch}.so.1`, `libc.musl-${arch}.so.1`]) {
        try {
          const library = dlopen(candidate, {
            ...definitions, __errno_location: { args: [], returns: "ptr" },
          });
          return { library, errno: () => read.i32(library.symbols.__errno_location()!) };
        }
        catch (error) { lastError = error; }
      }
      throw new Error(`native lock cannot load Linux flock: ${String(lastError)}`);
    };
    const { library, errno } = load();
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      if (!fstatSync(fd).isFile()) throw new Error(`native lock must be a regular file: ${path}`);
      // F_GETFD=1, F_SETFD=2, FD_CLOEXEC=1. Explicitly prevent an exec'd daemon
      // from inheriting the starter's lock and retaining it after starter death.
      const flags = library.symbols.fcntl(fd, 1, 0);
      if (flags < 0 || library.symbols.fcntl(fd, 2, flags | 1) !== 0) {
        throw new Error(`native lock could not set FD_CLOEXEC: errno ${errno()}`);
      }
      if (library.symbols.flock(fd, 2 | 4) !== 0) { // LOCK_EX | LOCK_NB
        const code = errno();
        if (code === (process.platform === "darwin" ? 35 : 11)) throw busy(); // EWOULDBLOCK / EAGAIN
        throw new Error(`native flock failed: errno ${code} (${path})`);
      }
    } catch (error) {
      try { if (fd !== undefined) closeSync(fd); }
      finally { library.close(); }
      throw error;
    }
    const ownedFd = fd;
    let released = false;
    return () => {
      if (released) return;
      // Never retry a failed close against a potentially reused descriptor.
      released = true;
      try { closeSync(ownedFd); }
      finally { library.close(); }
    };
  }

  if (!["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Windows native lock requires 64-bit Bun; got ${process.arch}`);
  }
  // A Win64 HANDLE is pointer-sized. Use u64 for its ABI value so the -1
  // INVALID_HANDLE_VALUE sentinel is preserved exactly rather than as a JS number.
  const library = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
  const handle = library.symbols.CreateFileW(
    Buffer.from(`${win32.toNamespacedPath(resolve(path))}\0`, "utf16le"),
    0xc0000000, // GENERIC_READ | GENERIC_WRITE
    0, // No sharing: ownership belongs exclusively to this open handle.
    null, // NULL SECURITY_ATTRIBUTES makes the handle non-inheritable.
    4, // OPEN_ALWAYS: preserve an existing lock file.
    0x80, // FILE_ATTRIBUTE_NORMAL; never FILE_FLAG_DELETE_ON_CLOSE.
    null,
  );
  if (handle === 0xffffffffffffffffn || handle === 0n) {
    const code = library.symbols.GetLastError();
    library.close();
    if (code === 32) throw busy(); // ERROR_SHARING_VIOLATION
    throw new Error(`native CreateFileW lock failed: Windows error ${code} (${path})`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (!library.symbols.CloseHandle(handle)) {
        throw new Error(`native CloseHandle lock failed: Windows error ${library.symbols.GetLastError()} (${path})`);
      }
    } finally { library.close(); }
  };
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  const normalize = (path: string) => {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  try {
    // A wrong runtime override must fail here instead of recursively spawning.
    if (!process.versions.bun) throw new Error("identity subprocess requires Bun; set AIDLC_BUN_BIN");
    if (process.argv.length !== 4 || process.argv[2] !== "--native-process-identity" ||
      !/^[1-9]\d*$/.test(process.argv[3])) {
      throw new Error("usage: bun tui-process-identity.ts --native-process-identity <pid>");
    }
    const pid = Number(process.argv[3]);
    console.log(JSON.stringify({ pid, identity: await getNativeProcessIdentity(pid) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
