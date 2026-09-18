import { randomUUID } from "node:crypto";
import fs from "node:fs";

const RENAME_RETRY_MS = 250;
const RETRY_DELAY_MS = 5;
const waitWord = new Int32Array(new SharedArrayBuffer(4));

/**
 * Publish a complete private JSON record with same-directory atomic replacement.
 * Windows readers/scanners can briefly deny DELETE sharing. Retry only that
 * rename, for at most 250ms total; never unlink/truncate the visible record.
 * Keep this module usable by both Node clients and Bun daemon/supervisor children.
 */
export function publishTuiRecord(path: string, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // Establish ownership before entering cleanup: an unsuccessful exclusive open
  // must not remove a file created by somebody else.
  let fd: number | undefined = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, body);
    const written = fd;
    fd = undefined;
    fs.closeSync(written); // Close the complete file before making it visible.
    const deadline = performance.now() + RENAME_RETRY_MS;
    while (true) {
      try {
        fs.renameSync(temporary, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const remaining = deadline - performance.now();
        if (
          process.platform !== "win32" ||
          !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
          remaining <= 0
        ) throw error;
        // A timer in this thread cannot fire during synchronous publication.
        Atomics.wait(waitWord, 0, 0, Math.min(RETRY_DELAY_MS, remaining));
        if (performance.now() >= deadline) throw error;
      }
    }
  } catch (error) {
    const failures: unknown[] = [error];
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (closeError) { failures.push(closeError); }
    }
    try { fs.unlinkSync(temporary); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException)?.code !== "ENOENT") failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures,
        `record publication failed; temporary cleanup failed (${temporary}): ${failures.map(String).join("; ")}`,
        { cause: error });
    }
    throw error;
  }
}
