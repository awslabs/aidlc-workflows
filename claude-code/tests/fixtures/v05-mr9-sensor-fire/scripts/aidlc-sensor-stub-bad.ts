// @ts-nocheck
// Fixture per-sensor script for t92. Writes garbage to stdout (NOT
// JSON), exits 0. Dispatcher should classify this as branch f
// (PASSED Note=script-error: bad-output).
process.stdout.write("this is not JSON, not even close\n");
process.exit(0);
