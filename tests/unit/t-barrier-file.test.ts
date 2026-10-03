// The rendezvous wait returns a barrier file's whole line, and stops early
// when the writer ends without writing it, by exit code or by signal.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForBarrierLine } from "../harness/barrier-file.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function barrier(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-barrier-"));
  scratch.push(dir);
  return join(dir, "ready");
}

describe("waitForBarrierLine", () => {
  test("waits past an empty file for the whole line", async () => {
    const path = barrier();
    writeFileSync(path, "");
    setTimeout(() => writeFileSync(path, "partial"), 30);
    setTimeout(() => writeFileSync(path, "partial line\n"), 80);
    expect(await waitForBarrierLine(path, { timeoutMs: 5_000 })).toBe("partial line\n");
  });

  test("returns a line a writer left before it exited", async () => {
    const path = barrier();
    writeFileSync(path, "done\n");
    expect(await waitForBarrierLine(path, { writer: { exitCode: 0 }, timeoutMs: 5_000 })).toBe("done\n");
  });

  test("stops at once when the writer exits without the line", async () => {
    const path = barrier();
    writeFileSync(path, "");
    const started = Date.now();
    await expect(waitForBarrierLine(path, { writer: { exitCode: 3 }, timeoutMs: 5_000 }))
      .rejects.toThrow("the writer ended with 3");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("stops at once when a signal ends the writer, which leaves exitCode null", async () => {
    const path = barrier();
    const started = Date.now();
    await expect(waitForBarrierLine(path, {
      writer: { exitCode: null, signalCode: "SIGKILL" },
      timeoutMs: 5_000,
    })).rejects.toThrow("the writer ended with SIGKILL");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("times out when a live writer never writes the line", async () => {
    const path = barrier();
    writeFileSync(path, "no newline yet");
    await expect(waitForBarrierLine(path, { writer: { exitCode: null, signalCode: null }, timeoutMs: 100 }))
      .rejects.toThrow("timed out waiting for");
  });
});
