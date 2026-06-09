// slow-command fixture for t92 group F defensive sub-case.
//
// This file is the `--output-path` argument; the manifest's `command:`
// for this case points at the existing `aidlc-sensor-stub-slow.ts`
// stub copied next to the dispatcher (which sleeps 5s, exceeding the
// manifest's 1s timeout_seconds). The dispatcher SIGTERMs the stub at
// the timeout window and emits SENSOR_BUDGET_OVERRIDE.
//
// Used by: t92 Group F defensive sub-case asserting that
// `Observed value` >= `Cap value` on the SIGTERM-killed timeout
// (proving the BUDGET_OVERRIDE branch fires on a real slow command,
// not by coincidence). The required-sections sensor's manifest is the
// fork target for this case (no matches: filter, accepts .ts paths).
export const placeholder = "slow-command output path stub";
