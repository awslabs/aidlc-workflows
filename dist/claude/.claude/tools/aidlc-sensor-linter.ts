// aidlc-sensor-linter.ts — per-sensor script for the `linter` sensor.
//
// Owns the linter check itself; the dispatcher (aidlc-sensor.ts) routes a
// SENSOR fire to this script via the manifest's `command:` field. Self-
// contained: no imports from sibling tools. Prints the locked stdout JSON shape:
//
//   {"pass": <bool>, "errorCount": <n>, "warningCount": <n>,
//    "violations": [{file, line, column, rule, severity, message}, ...]}
//
// Polyglot dispatch (on --file-path extension):
//
// * .ts/.tsx/.js/.jsx/.mjs/.cjs → eslint. Wraps `bunx eslint --format json
//   --max-warnings -1 <path>` (walk up to the nearest package.json; defer to
//   eslint's own config discovery; no eslint config → quiet PASS via 127).
// * .py/.pyi → ruff. Runs `ruff check --output-format=json <path>`. ruff is a
//   Python tool, not an npm package, so it never rides bunx; it is resolved
//   side-effect-free as `python -m ruff` (the project's ruff when its venv is
//   active), falling back to a bare `ruff` on PATH. Walks up to the nearest
//   pyproject.toml/ruff.toml/.ruff.toml; only runs when the project actually
//   configures ruff — no ruff config → quiet PASS via 127, mirroring eslint's
//   no-config behaviour. ruff diagnostics are findings; pass = (#diagnostics == 0).
// * anything else → exit 127 (unknown language is not a failure → quiet PASS).
//
// The "use what the project configures; do nothing otherwise" principle is
// identical across languages: the script never imposes a default ruleset, it
// only runs a tool the project opted into, and quiet-passes when none is set.
//
// Decisions (see tmp/v05-mr9-plan-draft.md § Per-sensor script contracts
// → aidlc-sensor-linter.ts):
//
// * Project root resolution: walk up from --file-path to the nearest
//   package.json. We DO NOT pre-locate the eslint config — eslint's own
//   discovery handles legacy cascading (.eslintrc.* inheritance unless
//   `root: true`) AND flat-config (eslint.config.js nearest-wins). Naive
//   walk-up resolvers silently drop outer-inherited rules in monorepos
//   with root flat config + nested legacy config.
//
// * "no eslint config" detection: probe `bunx eslint --print-config <path>`.
//   Exit non-zero with stderr matching "No ESLint configuration" /
//   "Could not find config" → exit 127 with stderr "no-eslint-config".
//   The dispatcher's branch b reclassifies status 127 to PASSED with
//   Note=tool-unavailable, giving a quiet PASS for projects without
//   eslint config rather than spamming script-error.
//
// * Tool-unavailable detection: `bunx eslint --version` once at startup.
//   `bunx <tool>` returns non-127 codes for several failure modes
//   (network-fetch failure, package-resolution failure, registry timeout)
//   so the dispatcher's `result.status === 127` check alone won't catch
//   them. If the probe fails for ANY non-zero reason we exit 127
//   ourselves, propagating to dispatcher branch b.
//
// * pass = errorCount === 0. Warnings tracked but DO NOT fail. Real
//   eslint configs ship `no-unused-vars: warn` and similar; warning-as-
//   failure would emit SENSOR_FAILED on every Write under the PostToolUse hook.
//   --max-warnings -1 disables eslint's own warning-exit override so
//   this script's errorCount test is the sole pass/fail decider.
//
// Exit codes:
//   0   pass or fail (the JSON pass field carries the verdict)
//   127 eslint unresolvable OR no eslint config found
//   1   stdout JSON parse failed (dispatcher reclassifies via branch f)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface ESLintMessage {
	ruleId: string | null;
	severity: number; // 1 = warning, 2 = error
	message: string;
	line?: number;
	column?: number;
}

interface ESLintResult {
	filePath: string;
	messages: ESLintMessage[];
	errorCount: number;
	warningCount: number;
}

interface Violation {
	file: string;
	line: number;
	column: number;
	rule: string;
	severity: "warning" | "error";
	message: string;
}

interface SensorOutput {
	pass: boolean;
	errorCount: number;
	warningCount: number;
	violations: Violation[];
	findings_count: number;
}

// --- argv parsing -----------------------------------------------------------

interface Args {
	stage: string;
	filePath: string;
}

function parseArgs(argv: string[]): Args {
	let stage = "";
	let filePath = "";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--stage") {
			stage = argv[++i] ?? "";
		} else if (a === "--file-path") {
			filePath = argv[++i] ?? "";
		} else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		} else {
			process.stderr.write(`unknown flag: ${a}\n`);
			process.exit(1);
		}
	}
	if (!stage) {
		process.stderr.write("missing required flag: --stage\n");
		process.exit(1);
	}
	if (!filePath) {
		process.stderr.write("missing required flag: --file-path\n");
		process.exit(1);
	}
	return { stage, filePath };
}

function printHelp(): void {
	process.stdout.write(
		`Usage: aidlc-sensor-linter --stage <slug> --file-path <path>\n\n` +
			`Dispatches on file extension: .ts/.js → eslint, .py → ruff.\n` +
			`Runs the project's configured linter and prints\n` +
			`{pass, errorCount, warningCount, violations[]} JSON to stdout.\n`,
	);
}

// --- project root resolution ------------------------------------------------

// Walk up from --file-path to the nearest package.json. eslint's own
// config discovery handles config resolution from there.
function findProjectRoot(filePath: string): string | null {
	const abs = resolve(filePath);
	let dir = dirname(abs);
	// dirname() on "/" returns "/"; loop terminates when we stop ascending.
	while (true) {
		if (existsSync(`${dir}/package.json`)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// --- eslint subprocess wrappers ---------------------------------------------

// Probe `bunx eslint --version` at startup. `bunx <tool>` returns non-127
// codes for several failure modes (network-fetch failure, package-
// resolution failure, registry timeout). The dispatcher's branch b
// (status === 127) won't catch those — so we propagate by exiting 127
// ourselves on any non-zero exit from this probe.
function probeEslintAvailable(cwd: string): void {
	const result = spawnSync("bunx", ["eslint", "--version"], {
		encoding: "utf-8",
		timeout: 30_000,
		cwd,
	});
	if (result.status !== 0) {
		process.stderr.write("eslint-unavailable\n");
		process.exit(127);
	}
}

// Probe `bunx eslint --print-config <path>` to detect "no eslint config".
// eslint exits non-zero with a stderr message containing "No ESLint
// configuration found" or "Could not find config file" when no config is
// resolvable from <path>. Map that to exit 127 so the dispatcher's branch
// b PASSes with Note=tool-unavailable rather than emitting script-error.
//
// Parse errors in an existing config (syntax error, malformed export,
// unknown rule values, unresolvable plugin) are a DIFFERENT failure mode
// — the project HAS a config, the config is just broken. Quietly PASSing
// those as tool-unavailable masks real bugs that the user should see, so
// we surface parse-error stderr patterns BEFORE the conservative
// tool-unavailable fallback and exit 2 (script-error). The dispatcher's
// branch e then emits SENSOR_PASSED with Note=script-error: exit-2,
// keeping the audit pair closed while flagging the breakage in stderr.
function probeEslintConfig(filePath: string, cwd: string): void {
	const result = spawnSync("bunx", ["eslint", "--print-config", filePath], {
		encoding: "utf-8",
		timeout: 30_000,
		cwd,
	});
	if (result.status === 0) return; // config resolved
	const stderr = result.stderr ?? "";
	// Cover both legacy (.eslintrc.*) and flat-config (eslint.config.js)
	// diagnostics. eslint v8 says "No ESLint configuration found";
	// eslint v9+ flat-config says "ESLint couldn't find an
	// eslint.config.(js|mjs|cjs) file." or "Could not find config file".
	// The unicode-apostrophe (U+2019) variant is what v10 ships verbatim;
	// straight-quote ASCII fallback covers older builds.
	if (
		/no eslint configuration found/i.test(stderr) ||
		/could not find config file/i.test(stderr) ||
		/eslint couldn[\u2019']t find an? eslint\.config/i.test(stderr) ||
		/eslint couldn[\u2019']t find a configuration/i.test(stderr)
	) {
		process.stderr.write("no-eslint-config\n");
		process.exit(127);
	}
	// Parse-error patterns. These fire when a config file IS present but
	// fails to load — distinct from the no-config-found case above. Order
	// matters: "unable to load" is gated by config-file presence so it
	// can't double-fire as a no-config case (network plugin fetch, etc.).
	const hasConfigFile = configFilePresent(cwd);
	if (
		/parse error/i.test(stderr) ||
		/syntaxerror/i.test(stderr) ||
		/unexpected token/i.test(stderr) ||
		/configuration .* is invalid/i.test(stderr) ||
		(hasConfigFile && /unable to load/i.test(stderr)) ||
		(hasConfigFile && /failed to load config/i.test(stderr))
	) {
		const reason = firstNonEmptyLine(stderr) || "unknown";
		process.stderr.write(`config-parse-error: ${reason}\n`);
		process.exit(2);
	}
	// Any other non-zero from --print-config (permission denied, bunx
	// itself glitching, etc.) — conservative tool-unavailable PASS.
	process.stderr.write("eslint-unavailable\n");
	process.exit(127);
}

// Detect whether any eslint config file lives in cwd (the project root
// resolved upstream). Not a walk — we only need to disambiguate "unable
// to load" between a present-but-broken config and a transient/unrelated
// failure with no config at all. cwd is already the nearest package.json
// ancestor by construction (see findProjectRoot).
function configFilePresent(cwd: string): boolean {
	const candidates = [
		"eslint.config.js",
		"eslint.config.mjs",
		"eslint.config.cjs",
		"eslint.config.ts",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.json",
		".eslintrc.yaml",
		".eslintrc.yml",
		".eslintrc",
	];
	return candidates.some((name) => existsSync(`${cwd}/${name}`));
}

// Pick the most diagnostic stderr line for the parse-error reason.
// eslint v10's stderr opens with a banner ("Oops Something went wrong!")
// and ends in a stack trace; the SyntaxError/Error line in the middle is
// what's actionable. Prefer lines containing "Error" (case-insensitive),
// skip stack frames ("    at …"), fall back to the first non-empty line.
function firstNonEmptyLine(s: string): string {
	const lines = s.split(/\r?\n/).map((l) => l.trim());
	for (const t of lines) {
		if (!t) continue;
		if (t.startsWith("at ")) continue; // stack frame after trim
		if (/error/i.test(t)) return t;
	}
	for (const t of lines) {
		if (t && !t.startsWith("at ")) return t;
	}
	return "";
}

function runEslint(
	filePath: string,
	cwd: string,
): {
	stdout: string;
	status: number | null;
} {
	// `--max-warnings=-1` (= form, not space-separated). eslint v10's CLI
	// parser rejects bare `-1` as a positional value because it starts
	// with `-` ("No -NUM option defined."). The plan-mandated
	// "--max-warnings -1" requires the equals form to actually reach
	// eslint as a numeric value.
	const result = spawnSync(
		"bunx",
		["eslint", "--format", "json", "--max-warnings=-1", filePath],
		{ encoding: "utf-8", timeout: 30_000, cwd },
	);
	return { stdout: result.stdout ?? "", status: result.status };
}

// --- result parsing ---------------------------------------------------------

function buildViolations(results: ESLintResult[]): Violation[] {
	const out: Violation[] = [];
	for (const r of results) {
		for (const m of r.messages) {
			out.push({
				file: r.filePath,
				line: m.line ?? 0,
				column: m.column ?? 0,
				rule: m.ruleId ?? "",
				severity: m.severity === 2 ? "error" : "warning",
				message: m.message,
			});
		}
	}
	return out;
}

// --- main -------------------------------------------------------------------

// Language families keyed by file extension (lowercased, leading dot stripped).
const ESLINT_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const RUFF_EXTS = new Set(["py", "pyi"]);

function extOf(filePath: string): string {
	const base = filePath.split("/").pop() ?? filePath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return ""; // no extension, or dotfile with no ext
	return base.slice(dot + 1).toLowerCase();
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));

	if (!existsSync(args.filePath)) {
		process.stderr.write(`file-path not found: ${args.filePath}\n`);
		process.exit(1);
	}

	const ext = extOf(args.filePath);
	if (ESLINT_EXTS.has(ext)) {
		runEslintFlow(args.filePath);
		return;
	}
	if (RUFF_EXTS.has(ext)) {
		runRuffFlow(args.filePath);
		return;
	}
	// Unknown language for this sensor — not a failure. Exit 127 so the
	// dispatcher's branch b records a quiet PASSED Note=tool-unavailable.
	process.stderr.write(`unsupported-language: .${ext || "(none)"}\n`);
	process.exit(127);
}

// --- eslint flow (TS/JS) ----------------------------------------------------

function runEslintFlow(filePath: string): void {
	const projectRoot = findProjectRoot(filePath) ?? dirname(resolve(filePath));

	// Probe order: tool first (cheap, ~1s for cached bunx), then config
	// (~1s for --print-config). Both gates feed dispatcher branch b
	// (PASSED Note=tool-unavailable) on non-zero.
	probeEslintAvailable(projectRoot);
	probeEslintConfig(filePath, projectRoot);

	const { stdout } = runEslint(filePath, projectRoot);

	// eslint exits 1 when violations exist and 0 when clean. With
	// --max-warnings -1 the warning-exit override is disabled so we never
	// see warning-only failure exits. We don't gate parse on result.status
	// — eslint always writes JSON to stdout on either path.
	let parsed: ESLintResult[];
	try {
		parsed = JSON.parse(stdout);
	} catch {
		process.stderr.write("eslint-bad-output\n");
		process.exit(1);
	}
	if (!Array.isArray(parsed)) {
		process.stderr.write("eslint-bad-output\n");
		process.exit(1);
	}

	let errorCount = 0;
	let warningCount = 0;
	for (const r of parsed) {
		errorCount += r.errorCount ?? 0;
		warningCount += r.warningCount ?? 0;
	}

	const out: SensorOutput = {
		// Per locked decision: warnings tracked but do NOT fail. Real
		// configs ship no-unused-vars: warn; warning-as-failure spams
		// SENSOR_FAILED on every Write under the PostToolUse hook.
		pass: errorCount === 0,
		errorCount,
		warningCount,
		violations: buildViolations(parsed),
		// findings_count emitted by the script (sensor-id-agnostic dispatcher).
		findings_count: errorCount,
	};
	process.stdout.write(`${JSON.stringify(out)}\n`);
	process.exit(0);
}

// --- ruff flow (Python) -----------------------------------------------------
//
// Mirrors the eslint flow structure: walk up to the project manifest, gate on
// "is ruff actually configured?" (quiet-pass 127 when not), probe availability,
// run, normalize to the locked SensorOutput shape.
//
// ruff JSON (`--output-format=json`) is an array of diagnostics:
//   {code, message, filename, location:{row,column}, end_location, fix, url, …}
// `code` may be null (e.g. syntax errors). Every reported diagnostic counts as
// a finding — ruff has no warning/error split in this shape, so the eslint
// "warnings don't fail" carve-out does not apply; pass = (#diagnostics == 0).

interface RuffLocation {
	row?: number;
	column?: number;
}

interface RuffDiagnostic {
	code: string | null;
	message: string;
	filename: string;
	location?: RuffLocation;
}

// ruff config files that stand alone (no [tool.ruff] table needed). pyproject
// .toml is handled separately because its presence alone does NOT mean ruff is
// configured — only a [tool.ruff] table (or one of these files) does.
const RUFF_CONFIG_FILES = ["ruff.toml", ".ruff.toml"];

// Walk up from --file-path to the nearest dir that anchors a Python project:
// a pyproject.toml, ruff.toml, or .ruff.toml. Returns that dir, or null.
function findRuffProject(filePath: string): string | null {
	const abs = resolve(filePath);
	let dir = dirname(abs);
	while (true) {
		if (existsSync(`${dir}/pyproject.toml`)) return dir;
		if (RUFF_CONFIG_FILES.some((f) => existsSync(`${dir}/${f}`))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// ruff invocation. ruff is a Python tool — NOT an npm package — so it cannot
// ride bunx. resolveRuffCmd resolves a ruff WITHOUT any side effects (a sensor
// fires on every file write, so it must never install packages or create a
// venv — which rules out `uv run`/`poetry run`, both of which can provision an
// environment on first use). Side-effect-free candidates, in decreasing order
// of project fidelity:
//   1. `python -m ruff` / `python3 -m ruff` — the ruff importable in whatever
//      the interpreter resolves to (the project's ruff when its venv is active).
//      Both `python` and `python3` are tried because many systems (CI images,
//      Homebrew-only setups, pyenv loaded only in interactive shells) expose
//      just `python3`; probing `python` alone would silently miss ruff there.
//      Preferred over the bare binary so a project/venv ruff wins.
//   2. `ruff` — a bare console script on PATH, last resort.
// Each candidate is gated on `--version` exit 0, so unavailable forms fall
// through. null when none answers — null → the flow quiet-passes (127), the
// same model mypy uses.
//
// Returns the argv PREFIX (command + leading args) the other ruff calls append
// to, or null when ruff is not runnable in this environment.
function resolveRuffCmd(cwd: string): string[] | null {
	const candidates: string[][] = [
		["python", "-m", "ruff"],
		["python3", "-m", "ruff"],
		["ruff"],
	];
	for (const cand of candidates) {
		const [cmd, ...prefix] = cand;
		const probe = spawnSync(cmd, [...prefix, "--version"], {
			encoding: "utf-8",
			timeout: 30_000,
			cwd,
		});
		if (probe.status === 0) return cand;
	}
	return null;
}

function spawnRuff(
	ruffCmd: string[],
	subArgs: string[],
	cwd: string,
): { stdout: string; status: number | null } {
	const [cmd, ...prefix] = ruffCmd;
	const result = spawnSync(cmd, [...prefix, ...subArgs], {
		encoding: "utf-8",
		timeout: 30_000,
		cwd,
	});
	// encoding: "utf-8" makes stdout a string, but spawnSync's overload union
	// isn't narrowed by the option alone — coerce with a typeof guard.
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	return { stdout, status: result.status };
}

// "Is ruff actually configured for this file?" — the use-what's-configured
// gate, mirroring eslint's --print-config probe. Defer to ruff's OWN discovery
// rather than hand-parsing TOML: `ruff check --show-settings <path>` exits 0
// and prints the resolved settings when ruff has a config it will apply, and
// exits non-zero when there is no configuration to resolve. Non-zero → exit 127
// (quiet PASS), so a bare pyproject.toml with no [tool.ruff] table behaves like
// a JS project with no eslint config: the sensor stays silent.
function probeRuffConfigured(
	ruffCmd: string[],
	filePath: string,
	cwd: string,
): void {
	const result = spawnRuff(ruffCmd, ["check", "--show-settings", filePath], cwd);
	if (result.status === 0) return; // ruff resolved settings → configured
	process.stderr.write("no-ruff-config\n");
	process.exit(127);
}

function runRuff(
	ruffCmd: string[],
	filePath: string,
	cwd: string,
): { stdout: string; status: number | null } {
	// --force-exclude makes ruff honour the project's exclude config even when
	// the file is passed explicitly (otherwise an explicitly-named excluded
	// file is still checked). --no-cache avoids cache writes into the project.
	const result = spawnRuff(
		ruffCmd,
		[
			"check",
			"--output-format=json",
			"--force-exclude",
			"--no-cache",
			filePath,
		],
		cwd,
	);
	return { stdout: result.stdout ?? "", status: result.status };
}

function buildRuffViolations(diags: RuffDiagnostic[]): Violation[] {
	return diags.map((d) => ({
		file: d.filename ?? "",
		line: d.location?.row ?? 0,
		column: d.location?.column ?? 0,
		rule: d.code ?? "",
		// ruff's JSON shape carries no severity; every diagnostic is a finding
		// that fails the check, so report it as an error for the locked shape.
		severity: "error",
		message: d.message ?? "",
	}));
}

function runRuffFlow(filePath: string): void {
	const projectRoot = findRuffProject(filePath);
	if (!projectRoot) {
		// No pyproject.toml / ruff.toml anywhere above the file → not a ruff
		// project. Quiet PASS, mirroring "no package.json" for eslint.
		process.stderr.write("no-python-project\n");
		process.exit(127);
	}

	const ruffCmd = resolveRuffCmd(projectRoot);
	if (!ruffCmd) {
		// ruff not runnable (not installed as a binary, not importable as a
		// module, or no python). Quiet PASS, the tool-unavailable contract.
		process.stderr.write("ruff-unavailable\n");
		process.exit(127);
	}
	probeRuffConfigured(ruffCmd, filePath, projectRoot);

	const { stdout } = runRuff(ruffCmd, filePath, projectRoot);

	// ruff writes the JSON array to stdout on both clean (exit 0) and
	// violations-present (exit 1) runs, so we parse stdout rather than gate on
	// the exit code.
	let parsed: RuffDiagnostic[];
	try {
		parsed = JSON.parse(stdout);
	} catch {
		process.stderr.write("ruff-bad-output\n");
		process.exit(1);
	}
	if (!Array.isArray(parsed)) {
		process.stderr.write("ruff-bad-output\n");
		process.exit(1);
	}

	const errorCount = parsed.length;
	const out: SensorOutput = {
		pass: errorCount === 0,
		errorCount,
		warningCount: 0,
		violations: buildRuffViolations(parsed),
		findings_count: errorCount,
	};
	process.stdout.write(`${JSON.stringify(out)}\n`);
	process.exit(0);
}

if (import.meta.main) main();
