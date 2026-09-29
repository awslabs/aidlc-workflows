import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireNativeLock,
  type DarwinIdentityApi,
  getNativeProcessIdentity,
  getNativeProcessIdentityWithBun,
  parseDarwinProcBsdInfo,
  parseLinuxNativeProcessIdentity,
  readDarwinProcessIdentity,
  readLinuxNativeProcessIdentity,
  readWindowsNativeProcessIdentity,
  type WindowsIdentityApi,
} from "../harness/tui-process-identity.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function procStat(pid: number, ticks: string, state = "S", comm = "process"): string {
  return `${pid} (${comm}) ${[state, "1", ...Array(17).fill("0"), ticks, "0"].join(" ")}\n`;
}

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`read failed: ${code}`), { code });
}

describe("Linux native process identity", () => {
  test("comm delimiters and 64-bit ticks cannot alias a different process", () => {
    const stat = procStat(42, "9007199254740993", "S", "a ) process\n(with spaces)");
    expect(parseLinuxNativeProcessIdentity(42, stat)).toBe("linux:42:9007199254740993");
    expect(parseLinuxNativeProcessIdentity(42, procStat(42, "9007199254740994"))).not.toBe(
      parseLinuxNativeProcessIdentity(42, stat),
    );
    expect(() => parseLinuxNativeProcessIdentity(41, stat)).toThrow("invalid /proc/41/stat");
  });

  test("zombies and dead states are gone; sleeping/stopped tasks remain live", () => {
    for (const state of ["Z", "X", "x"]) {
      expect(parseLinuxNativeProcessIdentity(42, procStat(42, "10", state))).toBeNull();
    }
    for (const state of ["R", "S", "D", "T", "t", "I"]) {
      expect(parseLinuxNativeProcessIdentity(42, procStat(42, "10", state))).toBe("linux:42:10");
    }
  });

  test("malformed procfs data throws, including malformed data claiming a zombie", () => {
    for (const stat of [
      "", "42 broken", "42 (comm) S 1", "42 (comm)S 1",
      procStat(42, "-1"), procStat(42, "1.5"), procStat(42, "NaN", "Z"),
      procStat(42, "10", "SS"),
    ]) {
      expect(() => parseLinuxNativeProcessIdentity(42, stat)).toThrow("invalid /proc/42/stat");
    }
  });

  test("missing target is gone only when live procfs can still be read", async () => {
    for (const code of ["ENOENT", "ESRCH"]) {
      const paths: string[] = [];
      expect(await readLinuxNativeProcessIdentity(42, async (path) => {
        paths.push(path);
        if (path === "/proc/self/stat") return procStat(process.pid, "20");
        throw fsError(code);
      })).toBeNull();
      expect(paths).toEqual(["/proc/42/stat", "/proc/self/stat"]);
    }
    await expect(readLinuxNativeProcessIdentity(42, async () => {
      throw fsError("ENOENT");
    })).rejects.toThrow("ENOENT");
  });

  test("permission and I/O failures are not absence", async () => {
    for (const code of ["EACCES", "EPERM", "EIO"]) {
      await expect(readLinuxNativeProcessIdentity(42, async () => {
        throw fsError(code);
      })).rejects.toThrow(code);
    }
  });
});

describe("Darwin native process identity", () => {
  test("start-time identities retain both 64-bit fields and distinguish PID reuse", () => {
    const buffer = new Uint8Array(136);
    const view = new DataView(buffer.buffer);
    view.setUint32(4, 2, true);
    view.setUint32(12, 42, true);
    view.setUint32(16, 10, true);
    view.setUint32(20, 501, true);
    view.setBigUint64(120, 9007199254740993n, true);
    view.setBigUint64(128, 999999n, true);
    const before = parseDarwinProcBsdInfo(42, buffer);
    expect(before).toEqual({ pid: 42, ppid: 10, uid: 501, status: 2,
      startSec: 9007199254740993n, startUsec: 999999n });
    view.setBigUint64(128, 999998n, true);
    expect(parseDarwinProcBsdInfo(42, buffer)).not.toEqual(before);
    view.setUint32(4, 5, true);
    expect(parseDarwinProcBsdInfo(42, buffer).status).toBe(5);
  });

  test("incomplete and mismatched native identities fail instead of claiming process absence", () => {
    const buffer = new Uint8Array(136);
    new DataView(buffer.buffer).setUint32(12, 42, true);
    expect(() => parseDarwinProcBsdInfo(43, buffer)).toThrow("invalid proc_bsdinfo identity");
    for (const size of [0, 128, 135, 137]) {
      expect(() => parseDarwinProcBsdInfo(42, new Uint8Array(size))).toThrow("136-byte buffer");
    }
  });

  test("system enumeration excludes EPERM while required identities and other errors fail closed", () => {
    const api: DarwinIdentityApi = {
      tui_pidinfo(pid, buffer) {
        if (pid === 43) return -1; // Foreign/protected process: EPERM.
        if (pid === 44) return -3; // Exited during enumeration: ESRCH.
        if (pid === 45) return -5; // EIO must never count as absence.
        new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(12, pid, true);
        return 136;
      },
    };
    const snapshot = [42, 43, 44]
      .map((pid) => readDarwinProcessIdentity(pid, api, undefined, "enumeration"))
      .filter((identity) => identity !== null);
    expect(snapshot.map((identity) => identity.pid)).toEqual([42]);
    expect(() => readDarwinProcessIdentity(43, api)).toThrow("errno 1");
    expect(() => readDarwinProcessIdentity(45, api, undefined, "enumeration")).toThrow("errno 5");
  });
});

function windowsApi(options: {
  waits?: number[];
  creation?: bigint;
  open?: boolean;
  times?: boolean;
  close?: boolean;
  error?: number;
} = {}): { api: WindowsIdentityApi<object>; calls: string[] } {
  const handle = {};
  const calls: string[] = [];
  let waited = 0;
  const api: WindowsIdentityApi<object> = {
    OpenProcess(access, inherit, pid) {
      expect(access).toBe(0x101000);
      expect(inherit).toBe(0);
      expect(pid).toBe(42);
      calls.push("open");
      return options.open === false ? null : handle;
    },
    WaitForSingleObject(value, timeout) {
      expect(value).toBe(handle);
      expect(timeout).toBe(0);
      calls.push("wait");
      return options.waits?.[waited++] ?? 258;
    },
    GetProcessTimes(value, creation) {
      expect(value).toBe(handle);
      calls.push("times");
      const ticks = options.creation ?? 0x01dc1234abcdef01n;
      creation[0] = Number(ticks & 0xffffffffn);
      creation[1] = Number(ticks >> 32n);
      return options.times === false ? 0 : 1;
    },
    CloseHandle(value) {
      expect(value).toBe(handle);
      calls.push("close");
      return options.close === false ? 0 : 1;
    },
    GetLastError() { return options.error ?? 5; },
  };
  return { api, calls };
}

describe("Windows native process identity", () => {
  test("creation time retains all 64 bits and every query uses the same handle", () => {
    const { api, calls } = windowsApi({ creation: 9007199254740993n });
    expect(readWindowsNativeProcessIdentity(42, api)).toBe("win32:42:9007199254740993");
    expect(calls).toEqual(["open", "wait", "times", "wait", "close"]);
    expect(readWindowsNativeProcessIdentity(42, windowsApi({
      creation: 9007199254740994n,
    }).api)).not.toBe("win32:42:9007199254740993");
  });

  test("observed exit before or during the creation-time read returns null and closes", () => {
    const before = windowsApi({ waits: [0] });
    expect(readWindowsNativeProcessIdentity(42, before.api)).toBeNull();
    expect(before.calls).toEqual(["open", "wait", "close"]);
    const during = windowsApi({ waits: [258, 0] });
    expect(readWindowsNativeProcessIdentity(42, during.api)).toBeNull();
    expect(during.calls).toEqual(["open", "wait", "times", "wait", "close"]);
  });

  test("only nonexistent PID errors count as a missing process", () => {
    const absent = windowsApi({ open: false, error: 87 });
    expect(readWindowsNativeProcessIdentity(42, absent.api)).toBeNull();
    expect(absent.calls).toEqual(["open"]);
    for (const error of [5, 6, 8]) {
      const denied = windowsApi({ open: false, error });
      expect(() => readWindowsNativeProcessIdentity(42, denied.api)).toThrow(`Windows error ${error}`);
      expect(denied.calls).toEqual(["open"]);
    }
  });

  test("wait/time read failures always close the handle and throw", () => {
    for (const options of [{ waits: [0xffffffff] }, { waits: [128] }, { times: false }]) {
      const { api, calls } = windowsApi(options);
      expect(() => readWindowsNativeProcessIdentity(42, api)).toThrow();
      expect(calls.at(-1)).toBe("close");
      expect(calls.filter((call) => call === "close")).toHaveLength(1);
    }
  });

  test("a failed handle close is reported even after observing exit", () => {
    const { api } = windowsApi({ waits: [0], close: false, error: 6 });
    expect(() => readWindowsNativeProcessIdentity(42, api)).toThrow("CloseHandle(42) failed");
  });
});

describe("native process identity input validation", () => {
  test("invalid PIDs are rejected before accessing the operating system", async () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x100000000]) {
      await expect(getNativeProcessIdentity(pid)).rejects.toThrow("positive DWORD PID");
      const { api, calls } = windowsApi();
      expect(() => readWindowsNativeProcessIdentity(pid, api)).toThrow("positive DWORD PID");
      expect(calls).toEqual([]);
    }
  });
});

const supported = process.platform === "linux" || process.platform === "win32" || process.platform === "darwin";

describe.skipIf(!supported)("native process identity OS reads", () => {
  test("self has a repeatable creation identity", async () => {
    const first = await getNativeProcessIdentity(process.pid);
    expect(first).toMatch(new RegExp(`^${process.platform}:${process.pid}:\\d+$`));
    expect(await getNativeProcessIdentity(process.pid)).toBe(first);
    if (process.platform === "linux") {
      expect(first).toBe(parseLinuxNativeProcessIdentity(
        process.pid, await readFile("/proc/self/stat", "utf8"),
      ));
    }
  });

  test("a child that has exited no longer has an identity", async () => {
    const child = spawn(process.execPath, ["-e", `
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
      setTimeout(() => process.exit(91), ${NATIVE_FIXTURE_SETUP_TIMEOUT_MS});
      process.stdout.write("ready\\n");
    `], { stdio: ["pipe", "pipe", "ignore"] });
    const closed = once(child, "close");
    try {
      await once(child.stdout, "data");
      expect(await getNativeProcessIdentity(child.pid!)).toMatch(
        new RegExp(`^${process.platform}:${child.pid}:\\d+$`),
      );
    } finally {
      child.stdin.end();
      await closed;
    }
    expect(await getNativeProcessIdentity(child.pid!)).toBeNull();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the bounded Bun entrypoint returns the same identity for a Node caller", async () => {
    expect(await getNativeProcessIdentityWithBun(process.pid, {
      ...process.env, AIDLC_BUN_BIN: process.execPath,
    })).toBe(await getNativeProcessIdentity(process.pid));
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("an absent Bun override is an error, never a gone process", async () => {
    await expect(getNativeProcessIdentityWithBun(process.pid, {
      ...process.env, AIDLC_BUN_BIN: "aidlc-no-such-identity-runtime",
    })).rejects.toThrow("requires a working Bun executable");
  });
});

if (!supported) {
  test("unsupported platforms report their limitation explicitly", async () => {
    await expect(getNativeProcessIdentity(process.pid)).rejects.toThrow(
      `unsupported on ${process.platform}`,
    );
  });
}

function lockScratchRoot(): string {
  const checkout = resolve(import.meta.dir, "../..");
  const git = join(checkout, ".git");
  if (!existsSync(git) || !statSync(git).isFile()) return join(checkout, "tmp", "tui-process-identity");
  const gitDir = resolve(checkout, readFileSync(git, "utf8").trim().replace(/^gitdir: /, ""));
  const common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  return join(dirname(common), "tmp", "tui-process-identity");
}

describe.skipIf(!supported)("OS-owned native locks", () => {
  test("native and core locks retain ownership beyond the Windows MAX_PATH boundary", async () => {
    const root = lockScratchRoot();
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "long-lock-"));
    const deep = join(dir, ...Array.from({ length: 8 }, (_, index) => `segment-${index}-${"x".repeat(28)}`));
    mkdirSync(deep, { recursive: true });
    const path = join(deep, "session.lock");
    expect(path.length).toBeGreaterThan(300);
    let release: (() => void) | undefined;
    try {
      release = await acquireNativeLock(path);
      await expect(acquireNativeLock(path)).rejects.toThrow("already in progress");
      release();
      release = await acquireNativeLock(path);
      release();
      const { runWithOwnerStampedLock } = await import("../../core/tools/aidlc-lib.ts");
      const lockDir = join(deep, "core.lock");
      const outer = runWithOwnerStampedLock(lockDir, 0, 0, () => {
        expect(runWithOwnerStampedLock(lockDir, 0, 0, () => "unexpected")).toEqual({ acquired: false });
        return "owned";
      });
      expect(outer).toEqual({ acquired: true, value: "owned" });
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      release?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("contention fails immediately; release preserves the same file and is idempotent", async () => {
    const root = lockScratchRoot();
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "lock-release-"));
    const path = join(dir, "session.lock");
    writeFileSync(path, "persistent lock file\n");
    const inode = statSync(path).ino;
    let release: (() => void) | undefined;
    try {
      release = await acquireNativeLock(path);
      await expect(acquireNativeLock(path)).rejects.toThrow("already in progress");
      release();
      release();
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("persistent lock file\n");
      expect(statSync(path).ino).toBe(inode);
      release = await acquireNativeLock(path);
      release();
      expect(statSync(path).ino).toBe(inode);
    } finally {
      release?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const interrupted of [false, true]) {
    test(`a child owner's ${interrupted ? "interruption" : "exit"} releases its lock automatically`, async () => {
      const root = lockScratchRoot();
      mkdirSync(root, { recursive: true });
      const dir = mkdtempSync(join(root, "lock-owner-"));
      const path = join(dir, "session.lock");
      const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../harness/tui-process-identity.ts")).href;
      const child = spawn(process.execPath, ["--eval", `
        import { acquireNativeLock } from ${JSON.stringify(moduleUrl)};
        const release = await acquireNativeLock(${JSON.stringify(path)});
        // Keep the release closure alive; exiting must release the OS resource
        // without calling it. The timer bounds fixture lifetime if the test fails.
        globalThis.ownedLockRelease = release;
        process.stdin.resume();
        process.stdin.on("end", () => process.exit(0));
        setTimeout(() => process.exit(91), ${NATIVE_FIXTURE_SETUP_TIMEOUT_MS});
        process.stdout.write("locked\\n");
      `], { stdio: ["pipe", "pipe", "pipe"] });
      const closed = once(child, "close");
      let reaped = false;
      let release: (() => void) | undefined;
      try {
        const ready = await Promise.race([
          once(child.stdout, "data").then(([bytes]) => String(bytes)),
          closed.then(([code]) => { throw new Error(`lock fixture exited before acquiring: ${code}`); }),
        ]);
        expect(ready).toContain("locked");
        await expect(acquireNativeLock(path)).rejects.toThrow("already in progress");
        if (interrupted) child.kill("SIGKILL"); // Only the ChildProcess handle we just created.
        else child.stdin.end();
        const [code, signal] = await closed;
        reaped = true;
        if (!interrupted) expect(code).toBe(0);
        else expect(signal !== null || code !== 0).toBe(true);
        expect(existsSync(path)).toBe(true);
        release = await acquireNativeLock(path);
        release();
      } finally {
        if (!reaped) {
          child.kill("SIGKILL"); // Owned fixture handle, never an arbitrary numeric PID.
          await closed;
        }
        release?.();
        rmSync(dir, { recursive: true, force: true });
      }
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("a spawned process cannot inherit and retain its parent's lock", async () => {
    const root = lockScratchRoot();
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "lock-no-inherit-"));
    const path = join(dir, "session.lock");
    let release = await acquireNativeLock(path);
    const child = spawn(process.execPath, ["-e", `
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
      setTimeout(() => process.exit(91), ${NATIVE_FIXTURE_SETUP_TIMEOUT_MS});
      process.stdout.write("ready\\n");
    `], { stdio: ["pipe", "pipe", "ignore"] });
    const closed = once(child, "close");
    try {
      await Promise.race([
        once(child.stdout, "data"),
        closed.then(([code]) => { throw new Error(`inheritance fixture exited early: ${code}`); }),
      ]);
      release();
      release = await acquireNativeLock(path);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      release();
      child.stdin.end();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("filesystem errors do not masquerade as contention", async () => {
    const root = lockScratchRoot();
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "lock-missing-parent-"));
    try {
      const error = await acquireNativeLock(join(dir, "missing", "session.lock")).then(
        (release) => { release(); throw new Error("unexpected lock acquisition"); },
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("already in progress");
      expect(existsSync(join(dir, "missing"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
