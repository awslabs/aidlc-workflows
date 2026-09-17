// @ts-nocheck — fixture intentionally JS-syntax-only so the default
// ESLint parser (no typescript-eslint plugin available in fixture) can
// parse it. The ts-nocheck silences strict tsc's noImplicitAny on the
// parameter so the file still PASSES the type-check sensor's PASS
// round-trip. The fixture lives under tests/fixtures/ and isn't part
// of the tools tsconfig include path; the test copies it into a temp
// project where its own minimal tsconfig.json governs.
//
// Exercised by:
//   - linter sensor: bunx eslint --format json --max-warnings=-1 sample.ts
//     emits errorCount=0, pass=true.
//   - type-check sensor: bunx --package typescript@6 tsc --project tsconfig.json --noEmit
//     --pretty false emits zero diagnostics, pass=true.
export const greet = (name) => `hello ${name}`;
