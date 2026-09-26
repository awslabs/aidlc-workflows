// covers: file:tests/harness/tui-record-file.ts
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { publishTuiRecord } from "../harness/tui-record-file.ts";

const rename = fs.renameSync;
const write = fs.writeFileSync;
const open = fs.openSync;
const close = fs.closeSync;
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

afterEach(async () => {
  for (const restore of restorers.splice(0).reverse()) restore();
  // Node linear retry delays sum to at most the shared cleanup backstop.
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: Math.floor((Math.sqrt(1 + 8 * remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS) / 100) - 1) / 2), retryDelay: 100 });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function failureOf(action: () => void): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("expected record publication to fail");
}

function errorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`fixture ${code}`), { code });
}

function temporaries(): string[] {
  return fs.readdirSync(directory).filter((name) => name.startsWith(`${basename(record)}.`));
}

function unchanged(): void {
  expect(fs.readFileSync(record, "utf8")).toBe(oldBody);
  expect(temporaries()).toEqual([]);
}

describe("atomic native terminal records", () => {
  test("creates and replaces complete JSON through distinct private files", () => {
    const seen: string[] = [];
    track(spyOn(fs, "renameSync").mockImplementation((from, to) => {
      seen.push(String(from));
      expect(dirname(String(from))).toBe(directory);
      // The full document is already readable before either publication.
      expect(fs.readFileSync(from, "utf8")).toBe(seen.length === 1 ? oldBody : nextBody);
      if (process.platform !== "win32") expect(fs.statSync(from).mode & 0o077).toBe(0);
      rename(from, to);
    }));
    publishTuiRecord(record, oldRecord);
    expect(fs.readFileSync(record, "utf8")).toBe(oldBody);
    publishTuiRecord(record, nextRecord);
    expect(fs.readFileSync(record, "utf8")).toBe(nextBody);
    expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual(nextRecord);
    expect(new Set(seen).size).toBe(2);
    expect(temporaries()).toEqual([]);
  });

  test("serialization failure leaves the old record intact without a temporary", () => {
    write(record, oldBody);
    expect(() => publishTuiRecord(record, { invalid: 1n })).toThrow();
    unchanged();
  });

  test.each(["ENOSPC", "EACCES"])("a partial %s write failure closes and removes only the unpublished file", (code) => {
    write(record, oldBody);
    const failure = errorWithCode(code);
    let descriptor: number | undefined;
    const writes = track(spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
      if (typeof path !== "number") return write(path, data, options);
      descriptor = path;
      write(path, '{"partial":');
      throw failure;
    }));
    expect(failureOf(() => publishTuiRecord(record, nextRecord))).toBe(failure);
    expect(writes).toHaveBeenCalledTimes(1); // Even Windows EACCES is retried only for rename.
    expect(descriptor).toBeNumber();
    expect(() => fs.fstatSync(descriptor!)).toThrow();
    unchanged();
  });

  test("an exclusive-create failure never removes a file it does not own", () => {
    write(record, oldBody);
    const failure = errorWithCode("EEXIST");
    let otherFile: string | undefined;
    track(spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (flags !== "wx") return open(path, flags, mode);
      otherFile = String(path);
      const fd = open(path, "wx", mode);
      try { write(fd, "owned by another writer"); } finally { close(fd); }
      throw failure;
    }));
    expect(failureOf(() => publishTuiRecord(record, nextRecord))).toBe(failure);
    expect(fs.readFileSync(record, "utf8")).toBe(oldBody);
    expect(fs.readFileSync(otherFile!, "utf8")).toBe("owned by another writer");
  });

  test("permanent rename errors propagate immediately, preserving the old record", () => {
    write(record, oldBody);
    const failure = errorWithCode("EIO");
    const attempts = track(spyOn(fs, "renameSync").mockImplementation(() => { throw failure; }));
    expect(failureOf(() => publishTuiRecord(record, nextRecord))).toBe(failure);
    expect(attempts).toHaveBeenCalledTimes(1);
    unchanged();
  });

  test.each(transientCodes)("%s retries only on native Windows", (code) => {
    write(record, oldBody);
    const failure = errorWithCode(code);
    let attempts = 0;
    track(spyOn(fs, "renameSync").mockImplementation((from, to) => {
      attempts++;
      if (attempts < 3) throw failure;
      rename(from, to);
    }));
    if (process.platform === "win32") {
      publishTuiRecord(record, nextRecord);
      expect(attempts).toBe(3);
      expect(fs.readFileSync(record, "utf8")).toBe(nextBody);
      expect(temporaries()).toEqual([]);
    } else {
      expect(failureOf(() => publishTuiRecord(record, nextRecord))).toBe(failure);
      expect(attempts).toBe(1);
      unchanged();
    }
  });

  test("temporary cleanup failure reports both errors and leaves the old record intact", () => {
    write(record, oldBody);
    const failure = errorWithCode("EIO");
    const cleanupFailure = errorWithCode("EACCES");
    track(spyOn(fs, "renameSync").mockImplementation(() => { throw failure; }));
    track(spyOn(fs, "unlinkSync").mockImplementation(() => { throw cleanupFailure; }));
    const error = failureOf(() => publishTuiRecord(record, nextRecord));
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure, cleanupFailure]);
    expect((error as AggregateError).cause).toBe(failure);
    expect(String(error)).toContain("temporary cleanup failed");
    expect(fs.readFileSync(record, "utf8")).toBe(oldBody);
    expect(temporaries()).toHaveLength(1);
    expect(fs.readFileSync(join(directory, temporaries()[0]), "utf8")).toBe(nextBody);
  });
});
