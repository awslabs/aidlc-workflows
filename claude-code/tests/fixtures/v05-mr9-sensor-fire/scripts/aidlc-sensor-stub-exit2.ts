// @ts-nocheck
// Fixture per-sensor script for t92. Exits with status 2 — non-zero,
// non-127, non-timeout. Dispatcher should classify this as branch e
// (PASSED Note=script-error: exit-2).
process.stderr.write("stub-exit2\n");
process.exit(2);
