// @ts-nocheck
// Fixture per-sensor script for t92. Always emits {"pass": false} JSON
// with multiple-key shape covering all 4 real sensor findings count
// derivations (required-sections, upstream-coverage, linter, type-check).
// Exits 0 (sensor failure ≠ CLI failure). Dispatcher should classify
// this as branch c (FAILED) and write a detail file.
const out = {
	pass: false,
	// findings_count: emitted by per-sensor scripts under the post-fixup
	// contract (dispatcher reads out.findings_count generically). Fixed
	// at 3 — t92 group J3 only asserts that this field is an integer.
	findings_count: 3,
	// required-sections shape (h2_count → findings = max(0, 2 - h2_count))
	h2_count: 0,
	headings: [],
	// upstream-coverage shape (unreferenced.length → findings)
	unreferenced: ["alpha", "beta", "gamma"],
	consumes: ["alpha", "beta", "gamma"],
	// linter shape (errorCount → findings)
	errorCount: 3,
	warningCount: 0,
	violations: [
		{
			file: "x.ts",
			line: 1,
			column: 1,
			rule: "no-foo",
			severity: "error",
			message: "no foo",
		},
		{
			file: "x.ts",
			line: 2,
			column: 1,
			rule: "no-bar",
			severity: "error",
			message: "no bar",
		},
		{
			file: "x.ts",
			line: 3,
			column: 1,
			rule: "no-baz",
			severity: "error",
			message: "no baz",
		},
	],
	// type-check shape (errors.length → findings)
	errors: [
		{
			file: "x.ts",
			line: 1,
			column: 1,
			message: "TS2304: Cannot find name 'foo'.",
		},
		{
			file: "x.ts",
			line: 2,
			column: 1,
			message: "TS2304: Cannot find name 'bar'.",
		},
	],
};
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
