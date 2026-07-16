// @ts-nocheck
// Fixture per-sensor script for t92. Always emits {"pass": true} JSON
// and exits 0. Tests dispatcher's PASSED-on-pass-true branch (d).
// Copied to dist/claude/.claude/tools/ at test runtime; cleaned
// up via bash trap. ts-nocheck keeps this runtime fixture independent
// of the contributor type environment; bun runs it directly.
process.stdout.write(`${JSON.stringify({ pass: true, h2_count: 5 })}\n`);
process.exit(0);
