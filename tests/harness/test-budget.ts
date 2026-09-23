/** Test workload limits only. Production timing/ownership contracts stay separate. */
export const FILE_DEADLINE_ENV = "AIDLC_TEST_FILE_DEADLINE_MS";
export const FILE_CLEANUP_ENV = "AIDLC_TEST_FILE_CLEANUP_MS";
const DEFAULT_FIXTURE_MS = 60_000;
export const LIVE_STARTUP_TIMEOUT_MS = 120_000;
export const LIVE_SETUP_TIMEOUT_MS = DEFAULT_FIXTURE_MS + LIVE_STARTUP_TIMEOUT_MS;
export const LIVE_CLEANUP_TIMEOUT_MS = 60_000;
// Process/bootstrap and fixture costs are separate from live-model startup.
export const NATIVE_STARTUP_TIMEOUT_MS = 30_000;
export const NATIVE_COMPILE_TIMEOUT_MS = 30_000;
export const NATIVE_FIXTURE_SETUP_TIMEOUT_MS = 120_000;
// Whole multistep worktree fixture cases; the measured 143s CI peak gets >2x headroom.
export const NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS = 300_000;
// Infrastructure may launch several processes on a loaded runner. These are
// ceilings, not sleeps: successful discovery and retirement finish immediately.
export const NATIVE_PROCESS_IDENTITY_TIMEOUT_MS = 10_000;
export const NATIVE_PROCESS_QUERY_TIMEOUT_MS = 5_000;
export const NATIVE_PROCESS_TERMINATE_TIMEOUT_MS = 5_000;
export const NATIVE_PROCESS_CLEANUP_TIMEOUT_MS = 30_000;
export const NATIVE_OUTPUT_DRAIN_TIMEOUT_MS = 5_000;
export const NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS = NATIVE_PROCESS_CLEANUP_TIMEOUT_MS + 5_000;
export const NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS =
  NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS + NATIVE_OUTPUT_DRAIN_TIMEOUT_MS + 5_000;

const MAX_TIMER_MS = 2_147_483_647;

export class TestBudgetExhaustedError extends Error {
  readonly code = "TEST_BUDGET_EXHAUSTED";
  readonly layer: "case" | "file";
  readonly remainingMs: number;
  readonly reserveMs: number;

  constructor(
    phase: string,
    layer: "case" | "file",
    remainingMs: number,
    reserveMs: number,
  ) {
    super(`Test budget exhausted (${phase}): ${layer} remainingMs=${remainingMs}, reserveMs=${reserveMs}`);
    this.name = "TestBudgetExhaustedError";
    this.layer = layer;
    this.remainingMs = remainingMs;
    this.reserveMs = reserveMs;
  }
}

function duration(value: number, name: string, allowZero = true): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_TIMER_MS) {
    throw new Error(`Invalid test budget: ${name} must be ${allowZero ? "a nonnegative" : "a positive"} integer within the timer range`);
  }
  return value;
}

function instant(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid test budget: ${name} must be a finite nonnegative timestamp`);
  }
  return value;
}

export function deterministicCaseTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? 60_000 : 15_000;
}

export function fileCleanupReserveMs(totalMs: number): number {
  return Math.min(120_000, Math.floor(duration(totalMs, "file totalMs") / 4));
}

export function liveCaseTimeoutMs(
  workMs: number,
  { fixtureMs = DEFAULT_FIXTURE_MS, startupMs = LIVE_STARTUP_TIMEOUT_MS, cleanupMs = LIVE_CLEANUP_TIMEOUT_MS }: {
    fixtureMs?: number;
    startupMs?: number;
    cleanupMs?: number;
  } = {},
): number {
  return duration(
    duration(workMs, "workMs") +
      duration(fixtureMs, "fixtureMs") +
      duration(startupMs, "startupMs") +
      duration(cleanupMs, "cleanupMs"),
    "case totalMs",
    false,
  );
}

export interface OperationBudgetOptions {
  /** Absolute epoch milliseconds, on the same clock as Date.now()/nowMs. */
  deadlineMs?: number;
  reserveMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injected epoch clock for deterministic tests; never performance.now(). */
  nowMs?: number;
  /** A phase label only; do not pass prompts, commands, or environment contents. */
  phase?: string;
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  // Reject blanks, signs, units and scientific notation rather than accepting
  // partial parses. Diagnostics name the limit, never print environment values.
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid test budget: ${key} must contain milliseconds`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid test budget: ${key} must be finite`);
  return value;
}

/** Allocate from actual remaining parent time, without summing worst-case
 * operation ceilings. Zero retains the SDK's old "unbounded" meaning only
 * when neither parent supplies a deadline. Never return a zero timeout. */
export function remainingOperationTimeoutMs(
  requestedMs: number | undefined,
  options: OperationBudgetOptions = {},
): number | undefined {
  if (requestedMs !== undefined) duration(requestedMs, "requestedMs");
  const now = instant(options.nowMs ?? Date.now(), "nowMs");
  const reserve = duration(options.reserveMs ?? 0, "reserveMs");
  const env = options.env ?? process.env;
  const fileDeadline = envNumber(env, FILE_DEADLINE_ENV);
  const fileReserve = duration(envNumber(env, FILE_CLEANUP_ENV) ?? 0, FILE_CLEANUP_ENV);
  if (options.deadlineMs !== undefined) instant(options.deadlineMs, "deadlineMs");
  if (fileDeadline !== undefined) instant(fileDeadline, FILE_DEADLINE_ENV);

  let allowance = requestedMs === undefined || requestedMs === 0 ? undefined : requestedMs;
  for (const [layer, deadline, cleanup] of [
    ["case", options.deadlineMs, reserve],
    ["file", fileDeadline, fileReserve],
  ] as const) {
    if (deadline === undefined) continue;
    const remaining = Math.floor(deadline - now - cleanup);
    if (remaining < 1) {
      throw new TestBudgetExhaustedError(options.phase ?? "operation", layer, remaining, cleanup);
    }
    allowance = Math.min(allowance ?? MAX_TIMER_MS, remaining);
  }
  return allowance;
}
