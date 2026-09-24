import { describe, expect, test } from "bun:test";
import {
  deterministicCaseTimeoutMs,
  FILE_CLEANUP_ENV,
  FILE_DEADLINE_ENV,
  fileCleanupReserveMs,
  liveCaseTimeoutMs,
  LIVE_SETUP_TIMEOUT_MS,
  LIVE_STARTUP_TIMEOUT_MS,
  LIVE_CLEANUP_TIMEOUT_MS,
  LIVE_COMMAND_TIMEOUT_MS,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_RUNTIME_CASE_TIMEOUT_MS,
  NATIVE_COMPILE_TIMEOUT_MS,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_PROCESS_IDENTITY_TIMEOUT_MS,
  NATIVE_PROCESS_QUERY_TIMEOUT_MS,
  NATIVE_PROCESS_TERMINATE_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  NATIVE_OUTPUT_DRAIN_TIMEOUT_MS,
  NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS,
  NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
  TestBudgetExhaustedError,
} from "../harness/test-budget.ts";

const epoch = 1_800_000_000_000;
const fileEnv = (workAndCleanupMs: number, cleanupMs = 0): NodeJS.ProcessEnv => ({
  [FILE_DEADLINE_ENV]: String(epoch + workAndCleanupMs),
  [FILE_CLEANUP_ENV]: String(cleanupMs),
});

describe("test workload budgets", () => {
  test("cleanup can spend the reserved tail after work expires without reserving it twice", () => {
    const env = fileEnv(1_000, 500);
    expect(() => remainingOperationTimeoutMs(500, {
      env, nowMs: epoch + 600,
    })).toThrow(TestBudgetExhaustedError);
    expect(remainingCleanupTimeoutMs(500, {
      env, nowMs: epoch + 600,
    })).toBe(400);
  });

  test("cleanup reuses the earliest original deadline and never renews an expired allowance", () => {
    const options = { env: fileEnv(2_000, 500), deadlineMs: epoch + 1_000 };
    expect(remainingCleanupTimeoutMs(5_000, { ...options, nowMs: epoch + 200 })).toBe(800);
    expect(remainingCleanupTimeoutMs(5_000, { ...options, nowMs: epoch + 900 })).toBe(100);
    expect(remainingCleanupTimeoutMs(5_000, { ...options, nowMs: epoch + 1_001 })).toBe(1);
    expect(remainingCleanupTimeoutMs(5_000, {
      env: fileEnv(1_000), nowMs: epoch + 2_000,
    })).toBe(1);
  });

  test("cleanup keeps explicit immediate calls and rejects invalid deadlines", () => {
    expect(remainingCleanupTimeoutMs(0, { env: {}, nowMs: epoch })).toBe(1);
    expect(remainingCleanupTimeoutMs(500, { env: {}, nowMs: epoch })).toBe(500);
    expect(() => remainingCleanupTimeoutMs(-1, { env: {} })).toThrow("Invalid test budget");
    expect(() => remainingCleanupTimeoutMs(500, {
      env: { [FILE_DEADLINE_ENV]: "not-a-deadline" },
    })).toThrow("Invalid test budget");
  });

  test("infrastructure deadlines leave room for child work, output drain and confirmation", () => {
    expect(NATIVE_PROCESS_IDENTITY_TIMEOUT_MS).toBe(600_000);
    expect(NATIVE_PROCESS_QUERY_TIMEOUT_MS).toBe(300_000);
    expect(NATIVE_PROCESS_TERMINATE_TIMEOUT_MS).toBe(300_000);
    expect(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS).toBe(900_000);
    expect(NATIVE_OUTPUT_DRAIN_TIMEOUT_MS).toBe(120_000);
    expect(NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS).toBe(1_020_000);
    expect(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS).toBe(1_170_000);
    expect(NATIVE_PROCESS_IDENTITY_TIMEOUT_MS).toBeGreaterThan(NATIVE_PROCESS_QUERY_TIMEOUT_MS);
    expect(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS).toBeGreaterThan(
      NATIVE_PROCESS_QUERY_TIMEOUT_MS + NATIVE_PROCESS_TERMINATE_TIMEOUT_MS,
    );
    expect(NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS).toBeGreaterThan(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS);
    expect(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS).toBeGreaterThan(
      NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS + NATIVE_OUTPUT_DRAIN_TIMEOUT_MS,
    );
    expect(LIVE_CLEANUP_TIMEOUT_MS).toBeGreaterThan(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS);
    // Infrastructure allowances still yield to an actual remaining parent budget.
    expect(remainingOperationTimeoutMs(NATIVE_PROCESS_QUERY_TIMEOUT_MS, {
      env: fileEnv(4_000, 1_000), nowMs: epoch,
    })).toBe(3_000);
  });

  test("deterministic backstops are generous across platforms and cleanup reserve stays bounded", () => {
    expect(NATIVE_STARTUP_TIMEOUT_MS).toBe(300_000);
    expect(NATIVE_RUNTIME_CASE_TIMEOUT_MS).toBe(1_200_000);
    expect(NATIVE_COMPILE_TIMEOUT_MS).toBe(900_000);
    expect(NATIVE_FIXTURE_SETUP_TIMEOUT_MS).toBe(1_800_000);
    expect(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS).toBe(3_600_000);
    expect(deterministicCaseTimeoutMs("win32")).toBe(600_000);
    expect(deterministicCaseTimeoutMs("linux")).toBe(600_000);
    expect(deterministicCaseTimeoutMs("darwin")).toBe(600_000);
    expect(fileCleanupReserveMs(19)).toBe(4);
    expect(fileCleanupReserveMs(40 * 60_000)).toBe(300_000);
    expect(fileCleanupReserveMs(0)).toBe(0);
  });

  test("live cases add independently configurable reservations without multiplying work", () => {
    expect(LIVE_STARTUP_TIMEOUT_MS).toBe(600_000);
    expect(LIVE_SETUP_TIMEOUT_MS).toBe(1_200_000);
    expect(LIVE_CLEANUP_TIMEOUT_MS).toBe(1_200_000);
    expect(LIVE_COMMAND_TIMEOUT_MS).toBe(1_800_000);
    expect(LIVE_LONG_OPERATION_TIMEOUT_MS).toBe(1_800_000);
    expect(liveCaseTimeoutMs(LIVE_COMMAND_TIMEOUT_MS)).toBe(4_200_000);
    expect(liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS)).toBe(4_200_000);
    expect(liveCaseTimeoutMs(0)).toBe(2_400_000);
    expect(liveCaseTimeoutMs(200, { fixtureMs: 11, startupMs: 13, cleanupMs: 17 })).toBe(241);
    expect(liveCaseTimeoutMs(1, { fixtureMs: 0, startupMs: 0, cleanupMs: 0 })).toBe(1);
  });

  test("the tightest of operation, case and file wins without double-counting reserves", () => {
    const options = {
      nowMs: epoch, deadlineMs: epoch + 9_000, reserveMs: 1_000,
      env: fileEnv(10_000, 3_000),
    };
    expect(remainingOperationTimeoutMs(20_000, options)).toBe(7_000);
    expect(remainingOperationTimeoutMs(5_000, options)).toBe(5_000);
    expect(remainingOperationTimeoutMs(20_000, { ...options, reserveMs: 4_000 })).toBe(5_000);
  });

  test("sequential operations share elapsed file time rather than reserving every worst case", () => {
    const env = fileEnv(10_000, 1_000);
    expect(remainingOperationTimeoutMs(8_000, { env, nowMs: epoch })).toBe(8_000);
    // The first operation actually consumed 2s, so the second can still run.
    expect(remainingOperationTimeoutMs(8_000, { env, nowMs: epoch + 2_000 })).toBe(7_000);
    expect(remainingOperationTimeoutMs(8_000, { env, nowMs: epoch + 8_999 })).toBe(1);
    expect(() => remainingOperationTimeoutMs(8_000, { env, nowMs: epoch + 9_000 }))
      .toThrow("budget exhausted");
  });

  test("SDK unbounded requests become bounded whenever either parent exists", () => {
    for (const requested of [undefined, 0]) {
      expect(remainingOperationTimeoutMs(requested, { env: {}, nowMs: epoch })).toBeUndefined();
      expect(remainingOperationTimeoutMs(requested, { env: fileEnv(200, 20), nowMs: epoch })).toBe(180);
      expect(remainingOperationTimeoutMs(requested, {
        env: {}, nowMs: epoch, deadlineMs: epoch + 100, reserveMs: 10,
      })).toBe(90);
    }
  });

  test("exact small requested deadlines are never inflated", () => {
    for (const requested of [1, 10, 50]) {
      expect(remainingOperationTimeoutMs(requested, {
        env: fileEnv(600_000, 120_000), nowMs: epoch,
      })).toBe(requested);
    }
    expect(remainingOperationTimeoutMs(10, {
      env: {}, nowMs: epoch + 0.25, deadlineMs: epoch + 5,
    })).toBe(4);
    expect(() => remainingOperationTimeoutMs(1, {
      env: {}, nowMs: epoch + 0.25, deadlineMs: epoch + 1,
    })).toThrow("budget exhausted");
  });

  test("expired parents refuse even an otherwise valid tiny request", () => {
    expect(() => remainingOperationTimeoutMs(1, {
      env: fileEnv(100), nowMs: epoch + 100, phase: "SDK query",
    })).toThrow("Test budget exhausted (SDK query): file");
    expect(() => remainingOperationTimeoutMs(1, {
      env: fileEnv(10_000), nowMs: epoch, deadlineMs: epoch - 1,
    })).toThrow("case");
    expect(() => remainingOperationTimeoutMs(undefined, {
      env: fileEnv(10, 11), nowMs: epoch,
    })).toThrow("budget exhausted");
    expect(() => remainingOperationTimeoutMs(1, {
      env: fileEnv(10), nowMs: epoch + 10,
    })).toThrow(TestBudgetExhaustedError);
  });

  test("invalid numeric budgets and timer overflow are rejected", () => {
    for (const value of [-1, NaN, Infinity, 0.5, 2_147_483_648]) {
      expect(() => remainingOperationTimeoutMs(value, { env: {}, nowMs: epoch })).toThrow("Invalid test budget");
      expect(() => fileCleanupReserveMs(value)).toThrow("Invalid test budget");
      expect(() => liveCaseTimeoutMs(value)).toThrow("Invalid test budget");
      expect(() => liveCaseTimeoutMs(1, { fixtureMs: value })).toThrow("Invalid test budget");
      expect(() => remainingOperationTimeoutMs(1, { env: {}, reserveMs: value })).toThrow("Invalid test budget");
    }
    expect(() => liveCaseTimeoutMs(0, { fixtureMs: 0, startupMs: 0, cleanupMs: 0 })).toThrow("Invalid test budget");
    let configurationError: unknown;
    try { remainingOperationTimeoutMs(-1, { env: {} }); } catch (error) { configurationError = error; }
    expect(configurationError).toBeInstanceOf(Error);
    expect(configurationError).not.toBeInstanceOf(TestBudgetExhaustedError);
    expect(() => liveCaseTimeoutMs(2_147_483_647)).toThrow("case totalMs");
    for (const value of [-1, NaN, Infinity]) {
      expect(() => remainingOperationTimeoutMs(1, { env: {}, nowMs: value })).toThrow("nowMs");
      expect(() => remainingOperationTimeoutMs(1, { env: {}, deadlineMs: value })).toThrow("deadlineMs");
    }
  });

  test("malformed environment limits fail without including their contents", () => {
    for (const key of [FILE_DEADLINE_ENV, FILE_CLEANUP_ENV]) {
      for (const raw of ["", " ", "100ms", "1e6", "-1", "NaN", "Infinity", "private-token-fixture", "9007199254740992"]) {
        const call = () => remainingOperationTimeoutMs(10, {
          env: { ...fileEnv(10_000), [key]: raw }, nowMs: epoch,
        });
        expect(call).toThrow("Invalid test budget");
        expect(call).toThrow(key);
      }
    }
    let malformedError: unknown;
    try {
      remainingOperationTimeoutMs(10, { env: { [FILE_DEADLINE_ENV]: "private-token-fixture" } });
    } catch (error) { malformedError = error; }
    expect(malformedError).toBeInstanceOf(Error);
    expect(String(malformedError)).not.toContain("private-token-fixture");
  });

  test("allocation does not mutate parent limits or consume them by declaration", () => {
    const env = Object.freeze(fileEnv(1_000, 100));
    const options = Object.freeze({ env, nowMs: epoch });
    expect(remainingOperationTimeoutMs(60_000, options)).toBe(900);
    expect(remainingOperationTimeoutMs(60_000, options)).toBe(900);
    expect(env[FILE_DEADLINE_ENV]).toBe(String(epoch + 1_000));
    expect(env[FILE_CLEANUP_ENV]).toBe("100");
  });
});
