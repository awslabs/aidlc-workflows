// @ts-nocheck — fixture intentionally JS-syntax-only so the default
// ESLint parser (no typescript-eslint plugin available in fixture) can
// parse it. The ts-nocheck silences strict tsc's noImplicitAny on
// `name`. The unused-const below is what we WANT eslint to complain
// about.
//
// failing-linter fixture for t92 — linter sensor FAILED round-trip.
//
// The local eslint.config.js sets `no-unused-vars: error`. This file
// declares an unused const, triggering a real lint error (severity 2,
// errorCount: 1) so the per-sensor script's errorCount === 0 check
// returns pass=false.
//
// Findings count derivation: dispatcher's computeFindingsCount() for
// linter returns errorCount, so the audit row's `Findings count`
// field MUST equal 1.
const unused = 42;
export const greet = (name) => `hello ${name}`;
