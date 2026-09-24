import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  FILE_CLEANUP_RESERVE_MS,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_RUNTIME_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import {
  remainingTuiDriverMs,
  runTuiDriverWithinBudget,
  TUI_CLEANUP_RESERVE_MS,
} from "../harness/tui-time-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

describe("TUI driver shares the test deadline", () => {
  const started = 100_000;
  const deadline = started + 2_400_000;

  test("startup longer than 37 seconds consumes the driver budget", () => {
    const now = started + 37_500;
    const driverMs = remainingTuiDriverMs(deadline, now);
    expect(TUI_CLEANUP_RESERVE_MS).toBe(FILE_CLEANUP_RESERVE_MS);
    expect(driverMs).toBe(2_062_500);
    expect(now + driverMs + TUI_CLEANUP_RESERVE_MS).toBe(deadline);
  });

  test("later calculations cannot restart the overall clock", () => {
    for (const elapsed of [0, 37_500, 120_000, deadline - started - TUI_CLEANUP_RESERVE_MS - 1]) {
      const now = started + elapsed;
      expect(now + remainingTuiDriverMs(deadline, now)).toBe(
        deadline - TUI_CLEANUP_RESERVE_MS,
      );
    }
  });

  test("a short remaining budget is not stretched to a 60-second minimum", () => {
    expect(remainingTuiDriverMs(deadline, deadline - TUI_CLEANUP_RESERVE_MS - 7)).toBe(7);
  });

  test("rounding preserves the cleanup reserve", () => {
    const now = started + 37_500.25;
    const driverMs = remainingTuiDriverMs(deadline, now);
    expect(Number.isInteger(driverMs)).toBe(true);
    expect(deadline - now - driverMs).toBeGreaterThanOrEqual(TUI_CLEANUP_RESERVE_MS);
  });

  test("exhausted or invalid deadlines fail before a driver can start", () => {
    expect(() => remainingTuiDriverMs(deadline, deadline - TUI_CLEANUP_RESERVE_MS)).toThrow(
      "cleanup reserve",
    );
    expect(() => remainingTuiDriverMs(deadline, deadline)).toThrow("cleanup reserve");
    expect(() => remainingTuiDriverMs(Number.POSITIVE_INFINITY, started)).toThrow("finite");
    expect(() => remainingTuiDriverMs(deadline, Number.NaN)).toThrow("finite");
    let launched = false;
    expect(() => runTuiDriverWithinBudget(performance.now(), () => {
      launched = true;
      return spawn(process.execPath, ["-e", "process.exit(0)"]);
    })).toThrow("cleanup reserve");
    expect(launched).toBe(false);
  });

  test("a completed driver keeps its actual exit code", async () => {
    const code = await runTuiDriverWithinBudget(
      performance.now() + TUI_CLEANUP_RESERVE_MS + NATIVE_STARTUP_TIMEOUT_MS,
      () => spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" }),
    );
    expect(code).toBe(7);
  }, NATIVE_STARTUP_TIMEOUT_MS + TUI_CLEANUP_RESERVE_MS);

  test("the watchdog reaps only its owned driver before the test cap", async () => {
    const idle = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
    const unrelated = spawn(process.execPath, ["-e", idle], { stdio: "ignore" });
    let owned: ReturnType<typeof spawn> | undefined;
    const hardDeadline = performance.now() + TUI_CLEANUP_RESERVE_MS + 500;
    try {
      await expect(runTuiDriverWithinBudget(hardDeadline, (timeoutMs) => {
        expect(timeoutMs).toBeGreaterThan(0);
        expect(timeoutMs).toBeLessThanOrEqual(500);
        owned = spawn(process.execPath, ["-e", idle], { stdio: "ignore" });
        return owned;
      })).rejects.toThrow("entering cleanup reserve");
      expect(owned?.killed).toBe(true);
      expect(owned?.exitCode !== null || owned?.signalCode !== null).toBe(true);
      expect(performance.now()).toBeLessThan(hardDeadline);
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
    } finally {
      if (owned && owned.exitCode === null && owned.signalCode === null) {
        const exited = once(owned, "exit");
        owned.kill("SIGKILL");
        await exited;
      }
      const exited = once(unrelated, "exit");
      unrelated.kill("SIGKILL");
      await exited;
    }
  }, NATIVE_RUNTIME_CASE_TIMEOUT_MS);
});
