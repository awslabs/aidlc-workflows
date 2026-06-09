// @ts-nocheck
// Fixture per-sensor script for t92. Exits with status 127 to signal
// tool-unavailable. Dispatcher should classify this as branch b
// (PASSED Note=tool-unavailable). No stdout output needed.
process.stderr.write("stub-tool-unavailable\n");
process.exit(127);
