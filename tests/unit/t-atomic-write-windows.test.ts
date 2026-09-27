// covers: function:writeFileAtomic, function:writeBufferAtomic
//
// Windows refuses a rename over a file another process has open, and Bun's own
// reads hold it open that way. A second process that keeps reading the state
// file while a writer replaces it is the everyday shape of concurrent hooks and
// engine calls; the atomic writers must land every replacement anyway.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBufferAtomic, writeFileAtomic } from "../../core/tools/aidlc-lib.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const READER = `
const { existsSync, readFileSync } = require("node:fs");
const [target, stop, ready] = process.argv.slice(2);
require("node:fs").writeFileSync(ready, "");
while (!existsSync(stop)) { try { readFileSync(target); } catch {} }
`;

async function withBusyReader(run: (target: string) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-atomic-win-"));
  scratch.push(dir);
  const target = join(dir, "aidlc-state.md");
  const stop = join(dir, "stop");
  const ready = join(dir, "ready");
  writeFileSync(target, "seed\n");
  const reader = Bun.spawn([process.execPath, "-e", READER, target, stop, ready], { stdout: "ignore", stderr: "ignore" });
  try {
    const deadline = Date.now() + NATIVE_STARTUP_TIMEOUT_MS;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error("reader did not start");
      await Bun.sleep(10);
    }
    run(target);
  } finally {
    writeFileSync(stop, "");
    await reader.exited;
  }
}

describe.skipIf(process.platform !== "win32")("atomic writers under a concurrent reader on Windows", () => {
  test("writeFileAtomic lands every replacement while another process reads the file", async () => {
    await withBusyReader((target) => {
      for (let index = 0; index < 300; index++) writeFileAtomic(target, `revision ${index}\n`);
      expect(readFileSync(target, "utf-8")).toBe("revision 299\n");
    });
  });

  test("writeBufferAtomic lands every replacement while another process reads the file", async () => {
    await withBusyReader((target) => {
      for (let index = 0; index < 300; index++) writeBufferAtomic(target, Buffer.from([index % 256, 1, 2, 3]));
      expect([...readFileSync(target)]).toEqual([299 % 256, 1, 2, 3]);
    });
  });
});
