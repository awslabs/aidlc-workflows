// Flat ESLint config for the failing-linter fixture. v10 flat-config
// only. The `no-unused-vars` rule is set to ERROR (severity 2) so the
// per-sensor script's errorCount aggregation > 0 and the dispatcher
// classifies the result as branch c (FAILED).
//
// `files` matches both .ts and .js so eslint's --print-config probe
// resolves a config when called against sample.ts.
export default [
	{
		files: ["**/*.ts", "**/*.js"],
		rules: {
			"no-unused-vars": "error",
		},
	},
];
