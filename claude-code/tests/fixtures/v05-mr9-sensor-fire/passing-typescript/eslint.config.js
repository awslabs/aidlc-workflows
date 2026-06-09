// Flat ESLint config for the passing-typescript fixture. v10's flat
// config is the only supported form in this version. Empty rules
// object so the file lints clean (zero errors, zero warnings),
// satisfying the linter sensor's pass=true contract.
//
// `files` matches both .ts and .js so eslint's --print-config probe
// resolves a config when called against sample.ts.
export default [
	{
		files: ["**/*.ts", "**/*.js"],
		rules: {
			"no-unused-vars": "off",
		},
	},
];
