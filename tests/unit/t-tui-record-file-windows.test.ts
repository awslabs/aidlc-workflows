// covers: file:tests/harness/tui-record-file.ts
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { publishTuiRecord } from "../harness/tui-record-file.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const rename = fs.renameSync;
const write = fs.writeFileSync;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const transientCodes = ["EPERM", "EACCES", "EBUSY"];
const oldRecord = { phase: "running", cleanupComplete: false, text: "old café 日本語" };
const nextRecord = {
  phase: "stopped", cleanupComplete: true, text: "new café 日本語\n".repeat(8192),
};
const oldBody = `${JSON.stringify(oldRecord)}\n`;
const nextBody = `${JSON.stringify(nextRecord)}\n`;
let directory: string;
let record: string;
const restorers: Array<() => void> = [];
const children: Bun.Subprocess[] = [];

function track<T extends { mockRestore(): void }>(spy: T): T {
  restorers.push(() => spy.mockRestore());
  return spy;
}

function scratchRoot(): string {
  let checkout = resolve(import.meta.dir, "../..");
  const marker = join(checkout, ".git");
  if (fs.existsSync(marker) && fs.statSync(marker).isFile()) {
    const gitDir = resolve(checkout, fs.readFileSync(marker, "utf8").trim().replace(/^gitdir: /, ""));
    checkout = dirname(resolve(gitDir, fs.readFileSync(join(gitDir, "commondir"), "utf8").trim()));
  }
  return join(checkout, "tmp", "combined-test-suite", "tui-record-file");
}

beforeEach(() => {
  const root = scratchRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  directory = fs.mkdtempSync(join(root, "record-"));
  record = join(directory, "session.json");
});

async function exited(child: Bun.Subprocess, timeout = NATIVE_PROCESS_CLEANUP_TIMEOUT_MS): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`record handle holder did not exit; retained ${directory}`)), remainingCleanupTimeoutMs(timeout));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  for (const restore of restorers.splice(0).reverse()) restore();
  // Only terminate children owned by this test. Do not erase their evidence if
  // exit cannot be confirmed; a held handle must never count as cleaned up.
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await exited(child);
  }
  // Node linear retry delays sum to at most the shared cleanup backstop.
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: Math.floor((Math.sqrt(1 + 8 * remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS) / 100) - 1) / 2), retryDelay: 100 });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function failureOf(action: () => void): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("expected record publication to fail");
}

function temporaries(): string[] {
  return fs.readdirSync(directory).filter((name) => name.startsWith(`${basename(record)}.`));
}

function unchanged(): void {
  expect(fs.readFileSync(record, "utf8")).toBe(oldBody);
  expect(temporaries()).toEqual([]);
}

// A separate owned process holds a real Win32 read handle with READ|WRITE
// sharing, deliberately WITHOUT FILE_SHARE_DELETE (0x4). No simulated errno
// substitutes for these runtime cases. Missing/broken FFI on Windows is a failure.
const holderSource = `
import { dlopen } from "bun:ffi";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [destination, ready, release, closed, mode] = process.argv.slice(2);
const library = dlopen("kernel32.dll", {
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
});
const handle = library.symbols.CreateFileW(
  Buffer.from(destination + "\\0", "utf16le"),
  0x80000000, 0x3, null, 3, 0x80, null,
);
if (handle === 0xffffffffffffffffn || handle === 0n) {
  throw new Error("CreateFileW read holder: " + library.symbols.GetLastError());
}
const before = readFileSync(destination, "utf8");
writeFileSync(ready, "holding");
// Failsafe is in the child, independent of a blocked or failed test parent.
const failsafe = setTimeout(() => process.exit(91), ${NATIVE_FIXTURE_SETUP_TIMEOUT_MS});
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
if (mode === "release") {
  while (!existsSync(release)) await pause(5);
  // The writer signals only AFTER an actual sharing-denied rename. Release
  // while it is synchronously retrying, with no dependency on its event loop.
  await pause(50);
  if (!library.symbols.CloseHandle(handle)) {
    throw new Error("CloseHandle read holder: " + library.symbols.GetLastError());
  }
  library.close();
  writeFileSync(closed, JSON.stringify({ before, released: true }));
  clearTimeout(failsafe);
} else {
  // Parent must observe bounded failure while this handle is still held.
  await new Promise(() => {});
}
`;

async function holdDestination(mode: "release" | "hold") {
  const ready = join(directory, "holder-ready");
  const release = join(directory, "holder-release");
  const closed = join(directory, "holder-closed.json");
  const program = join(directory, "read-holder.ts");
  write(program, holderSource, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, program, record, ready, release, closed, mode], {
    stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  children.push(child);
  const stderr = new Response(child.stderr).text();
  const deadline = performance.now() + remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!;
  while (!fs.existsSync(ready)) {
    if (child.exitCode !== null) throw new Error(`Windows read holder exited: ${await stderr}`);
    if (performance.now() >= deadline) throw new Error(`Windows read holder never became ready; inspect ${directory}`);
    await pause(10);
  }
  return { child, release, closed, stderr };
}

describe.skipIf(process.platform !== "win32")("Windows record sharing runtime", () => {
  for (const filename of ["session.json", "supervisor.json"]) {
    test(`${filename}: retries a real sharing-denied rename until an owned reader releases`, async () => {
      record = join(directory, filename);
      write(record, oldBody);
      const holder = await holdDestination("release");
      const denied: string[] = [];
      let attempts = 0;
      track(spyOn(fs, "renameSync").mockImplementation((from, to) => {
        attempts++;
        try { rename(from, to); } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? "";
          if (transientCodes.includes(code)) {
            denied.push(code);
            if (denied.length === 1) write(holder.release, "release after 50ms");
          }
          throw error; // Observe real failures; never manufacture or suppress one.
        }
      }));
      publishTuiRecord(record, nextRecord);
      expect(denied.length).toBeGreaterThan(0);
      expect(attempts).toBe(denied.length + 1);
      expect(fs.readFileSync(record, "utf8")).toBe(nextBody);
      expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual(nextRecord);
      expect(temporaries()).toEqual([]);
      expect(await exited(holder.child), await holder.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(holder.closed, "utf8"))).toEqual({ before: oldBody, released: true });
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`${filename}: a permanent read hold fails within budget and preserves unconfirmed cleanup`, async () => {
      record = join(directory, filename);
      write(record, oldBody);
      const holder = await holdDestination("hold");
      let attempts = 0;
      track(spyOn(fs, "renameSync").mockImplementation((from, to) => {
        attempts++;
        rename(from, to);
      }));
      // Real sharing errors exercise the Windows path; an injected clock
      // exhausts the retry budget without waiting for a native backstop.
      let now = 0;
      track(spyOn(performance, "now").mockImplementation(() => now));
      track(spyOn(Atomics, "wait").mockImplementation(() => {
        now += NATIVE_PROCESS_CLEANUP_TIMEOUT_MS / 2;
        return "timed-out";
      }));
      const error = failureOf(() => publishTuiRecord(record, nextRecord));
      expect(transientCodes).toContain((error as NodeJS.ErrnoException).code ?? "");
      expect(attempts).toBeGreaterThan(1);
      expect(now).toBe(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS);
      expect(holder.child.exitCode).toBeNull(); // Still holding after the writer gave up.
      unchanged();
      expect(JSON.parse(fs.readFileSync(record, "utf8")).cleanupComplete).toBe(false);
      expect(fs.existsSync(holder.closed)).toBe(false);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
