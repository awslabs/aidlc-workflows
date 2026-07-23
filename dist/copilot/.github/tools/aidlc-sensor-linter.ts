// aidlc-sensor-linter.ts — per-sensor script for the `linter` sensor.
//
// Owns the linter check itself; the dispatcher (aidlc-sensor.ts) routes a
// SENSOR fire to this script via the manifest's `command:` field. Self-
// contained: no imports from sibling tools. Wraps `bunx eslint --format
// json --max-warnings -1 <path>` and prints the locked stdout JSON shape:
//
//   {"pass": <bool>, "errorCount": <n>, "warningCount": <n>,
//    "violations": [{file, line, column, rule, severity, message}, ...]}
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
			`Wraps \`bunx eslint --format json --max-warnings -1 <path>\` and\n` +
			`prints {pass, errorCount, warningCount, violations[]} JSON to stdout.\n`,
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

// Pinned eslint spec for every bunx invocation. A BARE `bunx eslint`
// prefers a project-local node_modules eslint, then ANY `eslint` on PATH
// before fetching from the registry - and distro packages ship ancient
// versions (Ubuntu 24.04's apt eslint is 6.4.0, a transitive dependency
// of `apt install npm`). Pre-flat-config eslint cannot see
// eslint.config.js, reports "couldn't find a configuration file", and
// the sensor quietly degrades every fire to a tool-unavailable PASS -
// masking real lint findings. Pinning the major makes resolution
// deterministic: bunx fetches/caches this spec and ignores PATH
// shadowing. Intentionally NOT applied to a project-local eslint - bunx
// with a version spec bypasses node_modules too, which is the price of
// determinism; projects needing their exact local eslint can override
// the sensor manifest's command.
const ESLINT_SPEC = "eslint@10";

// Probe `bunx eslint --version` at startup. `bunx <tool>` returns non-127
// codes for several failure modes (network-fetch failure, package-
// resolution failure, registry timeout). The dispatcher's branch b
// (status === 127) won't catch those — so we propagate by exiting 127
// ourselves on any non-zero exit from this probe.
function probeEslintAvailable(cwd: string): void {
	const result = spawnSync("bunx", [ESLINT_SPEC, "--version"], {
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
	const result = spawnSync("bunx", [ESLINT_SPEC, "--print-config", filePath], {
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
		[ESLINT_SPEC, "--format", "json", "--max-warnings=-1", filePath],
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

export function main(argv: string[]): void {
	const args = parseArgs(argv);

	if (!existsSync(args.filePath)) {
		process.stderr.write(`file-path not found: ${args.filePath}\n`);
		process.exit(1);
	}

	const projectRoot =
		findProjectRoot(args.filePath) ?? dirname(resolve(args.filePath));

	// Probe order: tool first (cheap, ~1s for cached bunx), then config
	// (~1s for --print-config). Both gates feed dispatcher branch b
	// (PASSED Note=tool-unavailable) on non-zero.
	probeEslintAvailable(projectRoot);
	probeEslintConfig(args.filePath, projectRoot);

	const { stdout } = runEslint(args.filePath, projectRoot);

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

if (import.meta.main) main(process.argv.slice(2));
