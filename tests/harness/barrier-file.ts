// barrier-file.ts: read a rendezvous file another process writes.
//
// On Windows a file can exist before its content does, so a test that waits
// for the path and then reads it can see an empty file. The writer ends its
// one line with a newline, and the reader waits for that line instead.

import { existsSync, readFileSync } from "node:fs";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

export interface BarrierWait {
  /** The writing process: stop waiting once it exits without the line. */
  writer?: { readonly exitCode: number | null };
  /** Wait at most this long (still capped by the file budget). */
  timeoutMs?: number;
}

/**
 * Wait for a barrier file's whole line and return it. The child writes one
 * newline-terminated line, and on Windows the file can exist before its
 * content does, so the path alone is not enough.
 */
export async function waitForBarrierLine(path: string, wait: BarrierWait = {}): Promise<string> {
  const deadline = Date.now() + remainingOperationTimeoutMs(wait.timeoutMs ?? NATIVE_STARTUP_TIMEOUT_MS)!;
  for (;;) {
    // Sample the exit before reading: everything a finished writer wrote is
    // visible to the read that follows.
    const exitCode = wait.writer?.exitCode ?? null;
    const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
    if (content.endsWith("\n")) return content;
    if (exitCode !== null) throw new Error(`${path} never got its line: the writer exited with ${exitCode}`);
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}
