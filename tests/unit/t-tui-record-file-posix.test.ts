// covers: file:tests/harness/tui-record-file.ts
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { publishTuiRecord } from "../harness/tui-record-file.ts";

const write = fs.writeFileSync;
const open = fs.openSync;
const close = fs.closeSync;
const oldRecord = { phase: "running", cleanupComplete: false, text: "old café 日本語" };
const nextRecord = {
  phase: "stopped", cleanupComplete: true, text: "new café 日本語\n".repeat(8192),
};
const oldBody = `${JSON.stringify(oldRecord)}\n`;
const nextBody = `${JSON.stringify(nextRecord)}\n`;
let directory: string;
let record: string;

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
  // Node linear retry delays sum to at most the shared cleanup backstop.
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: Math.floor((Math.sqrt(1 + 8 * remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS) / 100) - 1) / 2), retryDelay: 100 });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temporaries(): string[] {
  return fs.readdirSync(directory).filter((name) => name.startsWith(`${basename(record)}.`));
}

describe.skipIf(process.platform === "win32")("POSIX record filesystem behavior", () => {
  test("an open reader retains the old document while new readers see the replacement", () => {
    write(record, oldBody);
    const reader = open(record, "r");
    try {
      publishTuiRecord(record, nextRecord);
      expect(fs.readFileSync(reader, "utf8")).toBe(oldBody);
      expect(fs.readFileSync(record, "utf8")).toBe(nextBody);
      expect(temporaries()).toEqual([]);
    } finally { close(reader); }
  });

  test("a real failed rename preserves an occupied destination and removes the temporary", () => {
    fs.mkdirSync(record);
    const occupant = join(record, "old.json");
    write(occupant, oldBody);
    expect(() => publishTuiRecord(record, nextRecord)).toThrow();
    expect(fs.readFileSync(occupant, "utf8")).toBe(oldBody);
    expect(temporaries()).toEqual([]);
  });
});
