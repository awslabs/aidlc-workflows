/**
 * Operational backstops for tools, hooks, and build-time consumers.
 *
 * These are failure ceilings, not expected durations. Startup, filesystem,
 * package resolution, and runner contention can vary widely. Explicit caller,
 * user, or manifest budgets still take precedence, including smaller budgets.
 * Keep this module free of imports, environment reads, and startup side effects
 * so both source tools and compiled entry points can safely share the policy.
 *
 * Lock acquisition waits can share these backstops. Lock leases, polling
 * intervals, ownership checks, and protocol calibration windows have separate
 * contracts and must not use these execution backstops.
 */
/** One subprocess, executable probe, or ordinary network operation. */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 300_000;
/** Compound work such as graph compilation, extraction, or type checking. */
export const LONG_SUBPROCESS_TIMEOUT_MS = 900_000;
/** Enclosing dispatchers, source snapshots, and project build/test commands. */
export const EXTENDED_SUBPROCESS_TIMEOUT_MS = 1_800_000;
