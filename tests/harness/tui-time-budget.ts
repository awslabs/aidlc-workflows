import type { ChildProcess } from "node:child_process";

// Part of the test cap, not extra runtime: leave the caller's finally block
// time to stop its TUI session and remove the fixture.
export const TUI_CLEANUP_RESERVE_MS = 30_000;

export function remainingTuiDriverMs(
  testDeadlineMs: number,
  nowMs = performance.now(),
): number {
  if (!Number.isFinite(testDeadlineMs) || !Number.isFinite(nowMs)) {
    throw new Error("TUI test deadline and clock must be finite");
  }
  const remaining = Math.floor(testDeadlineMs - nowMs - TUI_CLEANUP_RESERVE_MS);
  if (remaining <= 0) {
    throw new Error("TUI driver budget exhausted; cleanup reserve must remain available");
  }
  return remaining;
}

/** Bound the owned driver independently of its own clock/startup delay.
 * Rejecting here runs the caller's finally before Bun's hard test timeout. */
export function runTuiDriverWithinBudget(
  testDeadlineMs: number,
  launch: (timeoutMs: number) => ChildProcess,
): Promise<number> {
  const child = launch(remainingTuiDriverMs(testDeadlineMs));
  return new Promise<number>((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error: Error | null, code = -1): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (error) reject(error);
      else resolve(code);
    };
    const onExit = (code: number | null): void => {
      finish(
        timedOut
          ? new Error("TUI driver exceeded its remaining test budget; entering cleanup reserve")
          : null,
        code ?? -1,
      );
    };
    const onError = (error: Error): void => finish(error);
    child.once("exit", onExit);
    child.once("error", onError);

    // Recompute after launch so process startup cannot reset the deadline.
    const remaining = Math.max(
      0,
      Math.floor(testDeadlineMs - performance.now() - TUI_CLEANUP_RESERVE_MS),
    );
    timer = setTimeout(() => {
      timedOut = true;
      // This is the ChildProcess we just spawned, never a PID from an old trace.
      // Await its exit before the caller cleans up the separately owned TUI.
      child.kill("SIGKILL");
    }, remaining);
    if (typeof child.exitCode === "number" || typeof child.signalCode === "string") {
      onExit(child.exitCode);
    }
  });
}
