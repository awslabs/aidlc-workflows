// @ts-nocheck
// Fixture per-sensor script for t92 budget-override test. Sleeps 5s,
// then exits 0. With manifest timeout_seconds=1, dispatcher should
// SIGTERM at ~1s and classify as branch a (BUDGET_OVERRIDE).
//
// Bun.sleepSync blocks the event loop, mimicking a CPU-bound stuck
// process — the dispatcher's child_process timeout fires regardless.
Bun.sleepSync(5000);
process.stdout.write(`${JSON.stringify({ pass: true })}\n`);
process.exit(0);
