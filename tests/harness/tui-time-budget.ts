import type { ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  FILE_CLEANUP_RESERVE_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
} from "./test-budget.ts";

// Part of the test cap, not extra runtime: leave the caller's finally block
// time to stop its TUI session and remove the fixture.
export const TUI_CLEANUP_RESERVE_MS = FILE_CLEANUP_RESERVE_MS;

/** Share one CLI work deadline with nested capture/IPC operations. Cleanup RPCs
 * deliberately ignore it and use the remaining hard file deadline instead. */
export const tuiOperationDeadline = new AsyncLocalStorage<number>();


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
  return remainingOperationTimeoutMs(remaining, { phase: "TUI driver" })!;
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
    let retirementTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error: Error | null, code = -1): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (retirementTimer) clearTimeout(retirementTimer);
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
    let remaining = 0;
    try { remaining = remainingTuiDriverMs(testDeadlineMs); }
    catch { /* Startup spent the work allowance; signal this owned child now. */ }
    timer = setTimeout(() => {
      timedOut = true;
      // This is the ChildProcess we just spawned, never a PID from an old trace.
      // Await its exit before the caller cleans up the separately owned TUI.
      try { child.kill("SIGKILL"); }
      catch (error) { finish(new Error("TUI driver termination failed; exit unconfirmed", { cause: error })); return; }
      if (settled) return;
      retirementTimer = setTimeout(() => {
        finish(new Error("TUI driver exit remains unconfirmed after forced termination"));
      }, remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS, {
        deadlineMs: Date.now() + testDeadlineMs - performance.now(),
      }));
    }, remaining);
    if (typeof child.exitCode === "number" || typeof child.signalCode === "string") {
      onExit(child.exitCode);
    }
  });
}
