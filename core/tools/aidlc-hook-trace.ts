// Opt-in phase trace for hook processes. Diagnostics only: it never changes
// what a hook decides or prints, and it is off unless AIDLC_HOOK_TRACE_DIR
// names an absolute directory.
//
// Each traced process appends one JSON line per phase to
// <dir>/hook-<pid>.ndjson. appendFileSync opens and closes the file on every
// call, so the trace keeps no handle open between phases, takes no lock, and
// reads no file contents: Windows refuses a rename over a file another process
// holds open, so a probe that held or read files could create the stall it
// records. The directory and file are created owner-only, and a trace path
// that already exists as anything but a regular file (a link, a FIFO) is
// skipped, never followed or blocked on. A failed write is dropped silently.
//
// Callers load this module only when the variable is set (a tolerant require),
// so a runtime tree or test fixture without this file behaves exactly as before.
import { appendFileSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const HOOK_TRACE_DIR_ENV = "AIDLC_HOOK_TRACE_DIR";

let preparedDirectory: string | null = null;

function traceDirectory(): string | null {
  const value = process.env[HOOK_TRACE_DIR_ENV]?.trim();
  return value && isAbsolute(value) ? value : null;
}

export function hookTraceEnabled(): boolean {
  return traceDirectory() !== null;
}

export function hookTracePath(directory: string, pid = process.pid): string {
  return join(directory, `hook-${pid}.ndjson`);
}

/** Append one phase line for this process. Never throws. */
export function hookTrace(phase: string, detail: Record<string, unknown> = {}): void {
  const directory = traceDirectory();
  if (directory === null) return;
  try {
    if (preparedDirectory !== directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      preparedDirectory = directory;
    }
    const path = hookTracePath(directory);
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(path);
    } catch {
      // Absent: appendFileSync creates it owner-only below.
    }
    if (existing !== undefined && !existing.isFile()) return;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      sinceStartMs: Math.round(performance.now()),
      pid: process.pid,
      ppid: process.ppid,
      phase,
      ...detail,
    });
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  } catch {
    // Tracing is diagnostics only; a full disk or a removed directory must
    // never change the hook's outcome.
  }
}
