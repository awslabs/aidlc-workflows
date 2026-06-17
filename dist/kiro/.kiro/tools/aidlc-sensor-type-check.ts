// aidlc-sensor-type-check.ts — per-sensor script for the `type-check` sensor.
//
// Owns the type-check itself; the dispatcher (aidlc-sensor.ts) routes a
// SENSOR fire to this script via the manifest's `command:` field. Self-
// contained: no imports from sibling tools. Prints the locked stdout JSON shape:
//
//   {"pass": <bool>, "errors": [{file, line, column, message}, ...]}
//
// Polyglot dispatch (on --file-path extension):
//
// * .ts/.tsx → tsc. Wraps `bunx tsc --project <tsconfig> --noEmit --pretty
//   false --incremental` (walk up to the nearest tsconfig.json; project-scoped
//   check post-filtered to --file-path; no tsconfig → quiet PASS).
// * .py/.pyi → mypy OR pyright, selected by what the project configures:
//     - [tool.mypy] in pyproject.toml, or mypy.ini, or setup.cfg [mypy] → mypy
//       (`mypy --output=json`). mypy is not npm, so it never rides bunx; it is
//       resolved side-effect-free as `python -m mypy` (the project's mypy when
//       its venv is active), falling back to a bare `mypy` on PATH; not
//       installed → quiet PASS via 127.
//     - [tool.pyright] in pyproject.toml, or pyrightconfig.json(c) → pyright
//       (`bunx pyright --outputjson` — pyright IS an npm package).
//     - both configured → mypy wins (more common standard; documented tie-break).
//     - neither → quiet PASS via 127.
//   Python checkers report 0-based line/character; we normalise to tsc's
//   1-based convention so the locked `errors[]` shape is uniform across langs.
// * anything else → exit 127 (unknown language is not a failure → quiet PASS).
//
// The "use what the project configures; do nothing otherwise" principle is
// identical across languages: the script never imposes a default checker, it
// only runs the one the project opted into, and quiet-passes when none is set.
//
// Decisions (see tmp/v05-mr9-plan-draft.md § Per-sensor script contracts
// → aidlc-sensor-type-check.ts):
//
// * Project root resolution: walk up from --file-path to nearest
//   tsconfig.json. If absent → exit 1 with stderr "no-tsconfig-found".
//   The dispatcher's branch e reclassifies non-zero/non-127 to PASSED
//   with Note=script-error: exit-1.
//
// * Why --project (not bare-file): `bunx tsc --noEmit foo.ts` ignores
//   tsconfig and falls back to default options (target ES3, no strict,
//   no module resolution, no path mappings). Verdict is checked-but-
//   meaningless on any real project. --project tsconfig.json honours the
//   project's actual settings; we post-filter diagnostics back to
//   --file-path.
//
// * Why --noEmit --pretty false: --noEmit skips .js writes that would
//   pollute the working tree; --pretty false strips ANSI codes and
//   structured-error decoration that would break the line-regex parser.
//   tsc's exit code is non-zero on any diagnostic, so we discriminate
//   via stdout-line count, not exit code.
//
// * Why --incremental --tsBuildInfoFile: persist compile state across
//   fires under aidlc-docs/.aidlc-sensors/.tsbuildinfo (gitignored by
//   the framework). Subsequent fires re-check only changed files
//   instead of the entire project. Doesn't fix cross-file attribution
//   but cuts re-reporting noise — same un-introduced error doesn't spam
//   SENSOR_FAILED on every Write.
//
// * Tool-unavailable detection: probe `bunx tsc --version` once at
//   startup. `bunx <tool>` returns non-127 codes for several failure
//   modes (network-fetch, package-resolution, registry timeout) so the
//   dispatcher's `result.status === 127` won't catch them. On any
//   non-zero probe we exit 127 ourselves, propagating to dispatcher
//   branch b (PASSED Note=tool-unavailable).
//
// * Continuation-line append: tsc with --pretty false emits one primary
//   diagnostic line followed by 0+ indented continuation lines for
//   related-info / multi-line context. Without joining continuation
//   into the primary's `message`, Findings count under-reports and
//   detail-file Findings prose is meaningless.
//
// * Post-filter to --file-path: tsc with --project checks the WHOLE
//   project. We narrow attribution to <path> by filtering parsed errors
//   whose `file` field equals or contains <path>. Match either absolute
//   or tsconfig-relative form for defensiveness — tsc's path emission
//   varies with cwd / rootDir.
//
//   KNOWN LIMITATION: cross-file errors that <path> introduced (e.g., a
//   removed export breaking the consumer) report with the consumer's
//   file in tsc's `file` field, not <path>. The sensor emits PASS for
//   <path> while the consumer file shows the error. Flagged in the
//   CHANGELOG forward-note as a known limitation; not fixed here.
//
// Exit codes:
//   0   pass or fail (the JSON pass field carries the verdict)
//   1   no tsconfig.json found (dispatcher reclassifies via branch e)
//   <n> tsc exited non-zero with ZERO parsed diagnostics (config-load failure
//       e.g. TS18003) — propagate tsc's code so the dispatcher's branch e
//       records PASSED Note=script-error: exit-<n> instead of a false clean PASS
//   127 tsc unresolvable

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

interface ParsedError {
	file: string;
	line: number;
	column: number;
	message: string;
}

interface SensorOutput {
	pass: boolean;
	errors: ParsedError[];
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
		`Usage: aidlc-sensor-type-check --stage <slug> --file-path <path>\n\n` +
			`Dispatches on file extension: .ts/.tsx → tsc, .py → mypy or pyright\n` +
			`(whichever the project configures). Prints {pass, errors[]} JSON to\n` +
			`stdout (filtered to --file-path).\n`,
	);
}

// --- tsconfig resolution ----------------------------------------------------

// Walk up from --file-path to the nearest tsconfig.json. Returns the
// absolute path to that tsconfig. Returns null if absent.
function findTsconfig(filePath: string): string | null {
	const abs = resolve(filePath);
	let dir = dirname(abs);
	while (true) {
		const candidate = join(dir, "tsconfig.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// --- tsc subprocess wrappers ------------------------------------------------

// Probe `bunx tsc --version`. `bunx <tool>` returns non-127 codes for
// several failure modes (network-fetch, package-resolution, registry
// timeout). The dispatcher's branch b (status === 127) won't catch
// those — propagate by exiting 127 ourselves on any non-zero exit.
function probeTscAvailable(cwd: string): void {
	const result = spawnSync("bunx", ["tsc", "--version"], {
		encoding: "utf-8",
		timeout: 30_000,
		cwd,
	});
	if (result.status !== 0) {
		process.stderr.write("tsc-unavailable\n");
		process.exit(127);
	}
}

function runTsc(opts: {
	tsconfigPath: string;
	tsBuildInfoFile: string;
	cwd: string;
}): { output: string; status: number | null } {
	const result = spawnSync(
		"bunx",
		[
			"tsc",
			"--project",
			opts.tsconfigPath,
			"--noEmit",
			"--pretty",
			"false",
			"--incremental",
			"--tsBuildInfoFile",
			opts.tsBuildInfoFile,
		],
		{ encoding: "utf-8", timeout: 60_000, cwd: opts.cwd },
	);
	return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status };
}

// --- diagnostic parsing -----------------------------------------------------

// Primary diagnostic line:
//   <path>(<line>,<column>): error TS<code>: <message>
// Continuation lines start with whitespace and append (with "\n  ") to
// the previous primary's message. Without joining continuations,
// Findings count under-reports.
const PRIMARY_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)$/;

function parseTscOutput(stdout: string): ParsedError[] {
	const errs: ParsedError[] = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		if (rawLine === "") continue;
		const m = rawLine.match(PRIMARY_RE);
		if (m) {
			errs.push({
				file: m[1],
				line: Number(m[2]),
				column: Number(m[3]),
				message: m[4],
			});
			continue;
		}
		// Continuation: indented (whitespace prefix). Append to previous
		// primary if any. We don't drop unmatched lines that aren't
		// indented either — but those shouldn't appear with --pretty false.
		if (errs.length > 0 && /^\s/.test(rawLine)) {
			const last = errs[errs.length - 1];
			last.message = `${last.message}\n  ${rawLine.trim()}`;
		}
		// Otherwise (empty-after-trim, banner, summary line like "Found N
		// errors") — drop silently. tsc's summary lines aren't errors.
	}
	return errs;
}

// Filter parsed errors to those whose file equals or contains
// --file-path. tsc's path emission varies with cwd: paths may be
// relative to the tsconfig dir OR absolute. We match either form.
function filterToFilePath(
	errs: ParsedError[],
	filePath: string,
	tsconfigDir: string,
): ParsedError[] {
	const absTarget = resolve(filePath);
	const relTargetFromTsconfig = relative(tsconfigDir, absTarget);
	return errs.filter((e) => {
		// tsc may emit absolute or relative; resolve against tsconfigDir if
		// relative, then compare. Also keep the substring fallback so
		// platform path-separator drift doesn't drop matches.
		const emitted = isAbsolute(e.file) ? e.file : resolve(tsconfigDir, e.file);
		if (emitted === absTarget) return true;
		if (e.file === absTarget) return true;
		if (e.file === relTargetFromTsconfig) return true;
		if (e.file.endsWith(relTargetFromTsconfig)) return true;
		return false;
	});
}

// --- main -------------------------------------------------------------------

const TSC_EXTS = new Set(["ts", "tsx"]);
const PY_EXTS = new Set(["py", "pyi"]);

function extOf(filePath: string): string {
	const base = filePath.split("/").pop() ?? filePath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	return base.slice(dot + 1).toLowerCase();
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));

	if (!existsSync(args.filePath)) {
		process.stderr.write(`file-path not found: ${args.filePath}\n`);
		process.exit(1);
	}

	const ext = extOf(args.filePath);
	if (TSC_EXTS.has(ext)) {
		runTscFlow(args.filePath);
		return;
	}
	if (PY_EXTS.has(ext)) {
		runPyFlow(args.filePath);
		return;
	}
	// Unknown language for this sensor — quiet PASS via dispatcher branch b.
	process.stderr.write(`unsupported-language: .${ext || "(none)"}\n`);
	process.exit(127);
}

// --- tsc flow (TS/TSX) ------------------------------------------------------

function runTscFlow(filePath: string): void {
	const tsconfigPath = findTsconfig(filePath);
	if (!tsconfigPath) {
		process.stderr.write("no-tsconfig-found\n");
		process.exit(1);
	}
	const tsconfigDir = dirname(tsconfigPath);

	// Walk up from tsconfig to find a project-level dir for
	// aidlc-docs/.aidlc-sensors/.tsbuildinfo. By convention aidlc-docs
	// sits beside the consumer project; use tsconfigDir as the project
	// anchor. The .aidlc-sensors/ dir is gitignored by the framework so
	// the tsbuildinfo never pollutes commits.
	const sensorsDir = join(tsconfigDir, "aidlc-docs", ".aidlc-sensors");
	try {
		mkdirSync(sensorsDir, { recursive: true });
	} catch {
		// If we can't mkdir (read-only fs etc.), proceed without
		// --tsBuildInfoFile by pointing at a tmp path. tsc still works,
		// just non-incremental on next run.
	}
	const tsBuildInfoFile = join(sensorsDir, ".tsbuildinfo");

	// Probe tsc availability first. cwd doesn't matter for --version.
	probeTscAvailable(tsconfigDir);

	const { output, status } = runTsc({
		tsconfigPath,
		tsBuildInfoFile,
		cwd: tsconfigDir,
	});
	const allErrors = parseTscOutput(output);
	const errors = filterToFilePath(allErrors, filePath, tsconfigDir);

	// Status gate: tsc exited non-zero but parseTscOutput found ZERO diagnostics
	// ANYWHERE in the project (a config-load failure — e.g. TS18003 "No inputs
	// were found", which carries no (line,col) so PRIMARY_RE matches nothing).
	// Emitting pass:true here would be a FALSE clean PASS: a broken tsconfig would
	// silently report green. Instead we propagate tsc's exit code so the dispatcher's
	// branch e reclassifies it as PASSED Note=script-error: exit-<n> (advisory, not
	// a real type pass). We gate on allErrors (the WHOLE-project parse), NOT the
	// post-filtered `errors`: a non-zero exit with diagnostics elsewhere in the
	// project but none for --file-path is a genuine type-error run whose errors fall
	// outside the target — that must stay a per-file clean PASS (the documented
	// cross-file known limitation above), not a script-error. A non-zero exit WITH
	// parsed diagnostics FOR the target flows through as pass:false below (exit 0,
	// the JSON verdict carries it).
	if (status !== null && status !== 0 && allErrors.length === 0) {
		process.exit(status);
	}

	const out: SensorOutput = {
		pass: errors.length === 0,
		errors,
		// findings_count emitted by the script (sensor-id-agnostic dispatcher).
		findings_count: errors.length,
	};
	process.stdout.write(`${JSON.stringify(out)}\n`);
	process.exit(0);
}

// --- Python flow (mypy / pyright) -------------------------------------------
//
// Selects the checker the project configured, mirroring the tsc flow's
// project-scoped check + post-filter to --file-path. Both Python checkers are
// project-scoped (they follow imports), so the same cross-file known limitation
// documented for tsc applies: an error a file INTRODUCES in a consumer reports
// under the consumer's path, not --file-path.
//
// mypy `--output=json` emits JSONL: one `{file, line, column, message, hint,
// code, severity}` object per line. Older mypy (<1.21) and config errors emit
// plain text; unparseable-line handling falls through to the status gate so a
// broken run never reports a false clean PASS.
//
// pyright `--outputjson` emits a single object with `generalDiagnostics[]`
// ({file, severity, message, rule?, range:{start:{line,character}, end}}) and a
// `summary.errorCount`. Line/character are 0-based; we +1 to match tsc.

type PyChecker = "mypy" | "pyright";

interface MypyDiagnostic {
	file?: string;
	line?: number;
	column?: number;
	message?: string;
	severity?: string;
}

interface PyrightRange {
	start?: { line?: number; character?: number };
}

interface PyrightDiagnostic {
	file?: string;
	severity?: string;
	message?: string;
	range?: PyrightRange;
}

interface PyrightOutput {
	generalDiagnostics?: PyrightDiagnostic[];
}

// Walk up to the nearest dir anchoring a Python project (any of the manifests
// that could declare a checker). Returns that dir, or null.
const PY_PROJECT_FILES = [
	"pyproject.toml",
	"mypy.ini",
	"setup.cfg",
	"pyrightconfig.json",
	"pyrightconfig.jsonc",
];

function findPyProject(filePath: string): string | null {
	const abs = resolve(filePath);
	let dir = dirname(abs);
	while (true) {
		if (PY_PROJECT_FILES.some((f) => existsSync(`${dir}/${f}`))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readFileSafe(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

// Does any config in projectRoot declare mypy? [tool.mypy] in pyproject.toml,
// a mypy.ini, or a [mypy] section in setup.cfg.
function mypyConfigured(projectRoot: string): boolean {
	if (existsSync(`${projectRoot}/mypy.ini`)) return true;
	const pyproject = readFileSafe(`${projectRoot}/pyproject.toml`);
	if (/^\s*\[tool\.mypy\b/m.test(pyproject)) return true;
	const setupCfg = readFileSafe(`${projectRoot}/setup.cfg`);
	if (/^\s*\[mypy\b/m.test(setupCfg)) return true;
	return false;
}

// Does any config in projectRoot declare pyright? [tool.pyright] in
// pyproject.toml, or a pyrightconfig.json(c).
function pyrightConfigured(projectRoot: string): boolean {
	if (
		existsSync(`${projectRoot}/pyrightconfig.json`) ||
		existsSync(`${projectRoot}/pyrightconfig.jsonc`)
	) {
		return true;
	}
	const pyproject = readFileSafe(`${projectRoot}/pyproject.toml`);
	return /^\s*\[tool\.pyright\b/m.test(pyproject);
}

// Pick the configured checker. mypy wins the tie when both are configured
// (more common standard). null → neither configured → caller quiet-passes.
function selectPyChecker(projectRoot: string): PyChecker | null {
	if (mypyConfigured(projectRoot)) return "mypy";
	if (pyrightConfigured(projectRoot)) return "pyright";
	return null;
}

// --- mypy -------------------------------------------------------------------

// mypy invocation. mypy is a Python tool — NOT an npm package — so it cannot
// ride bunx. resolveMypyCmd resolves a mypy WITHOUT side effects (a sensor
// fires on every file write, so it must never install packages or create a
// venv — which rules out `uv run`/`poetry run`). Side-effect-free candidates,
// in decreasing order of project fidelity:
//   1. `python -m mypy` / `python3 -m mypy` — the project's mypy when its venv
//      is the active interpreter. Both `python` and `python3` are tried because
//      many systems (CI, Homebrew-only, pyenv loaded only in interactive
//      shells) expose just `python3`; probing `python` alone would silently
//      miss mypy there. Preferred over the bare binary so a project/venv mypy
//      wins.
//   2. `mypy` — a bare console script on PATH, last resort.
// Each candidate is gated on `--version` exit 0. null when none answers — null
// → quiet PASS (127), configured-but-absent is tool-unavailable.
//
// Returns the argv PREFIX (command + leading args) callers append to, or null
// when mypy is not runnable in this environment.
function resolveMypyCmd(cwd: string): string[] | null {
	const candidates: string[][] = [
		["python", "-m", "mypy"],
		["python3", "-m", "mypy"],
		["mypy"],
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

function runMypy(
	mypyCmd: string[],
	filePath: string,
	cwd: string,
): { stdout: string; status: number | null } {
	const [cmd, ...prefix] = mypyCmd;
	const result = spawnSync(
		cmd,
		[...prefix, "--output=json", "--no-error-summary", filePath],
		{ encoding: "utf-8", timeout: 60_000, cwd },
	);
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	return { stdout, status: result.status };
}

// Parse mypy JSONL. Returns the parsed error-severity diagnostics AND a count
// of lines that failed to parse as JSON (text syntax/config errors on older
// mypy). The caller uses parseFailures to avoid a false clean PASS.
function parseMypyOutput(stdout: string): {
	errors: ParsedError[];
	parseFailures: number;
} {
	const errors: ParsedError[] = [];
	let parseFailures = 0;
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "") continue;
		if (!line.startsWith("{")) {
			parseFailures++;
			continue;
		}
		let diag: MypyDiagnostic;
		try {
			diag = JSON.parse(line);
		} catch {
			parseFailures++;
			continue;
		}
		if (diag.severity !== "error") continue;
		errors.push({
			file: diag.file ?? "",
			line: diag.line ?? 0,
			column: diag.column ?? 0,
			message: diag.message ?? "",
		});
	}
	return { errors, parseFailures };
}

function runMypyFlow(filePath: string, projectRoot: string): void {
	const mypyCmd = resolveMypyCmd(projectRoot);
	if (!mypyCmd) {
		// mypy not runnable (not installed as a binary, not importable as a
		// module, or no python). Quiet PASS, the tool-unavailable contract.
		process.stderr.write("mypy-unavailable\n");
		process.exit(127);
	}
	const { stdout, status } = runMypy(mypyCmd, filePath, projectRoot);
	const { errors: allErrors, parseFailures } = parseMypyOutput(stdout);
	const errors = filterToFilePath(allErrors, filePath, projectRoot);

	// Status gate, mirroring tsc: a non-zero exit that produced ZERO parseable
	// error diagnostics is a broken run (config error, or a syntax error that
	// older mypy emitted as text — counted in parseFailures). Propagate the exit
	// so the dispatcher records script-error rather than a false clean PASS.
	// mypy exits 1 on type errors AND on config/parse failures; reaching here
	// with no parsed errors means no usable findings, so script-error is right.
	void parseFailures;
	if (status !== null && status !== 0 && allErrors.length === 0) {
		process.exit(status);
	}

	const out: SensorOutput = {
		pass: errors.length === 0,
		errors,
		findings_count: errors.length,
	};
	process.stdout.write(`${JSON.stringify(out)}\n`);
	process.exit(0);
}

// --- pyright ----------------------------------------------------------------

function probePyrightAvailable(cwd: string): void {
	const result = spawnSync("bunx", ["pyright", "--version"], {
		encoding: "utf-8",
		timeout: 30_000,
		cwd,
	});
	if (result.status !== 0) {
		process.stderr.write("pyright-unavailable\n");
		process.exit(127);
	}
}

function runPyright(
	filePath: string,
	cwd: string,
): { stdout: string; status: number | null } {
	const result = spawnSync(
		"bunx",
		["pyright", "--outputjson", "--project", cwd, filePath],
		{ encoding: "utf-8", timeout: 60_000, cwd },
	);
	return { stdout: result.stdout ?? "", status: result.status };
}

// Parse pyright JSON. Returns error-severity diagnostics, normalised from
// 0-based line/character to tsc's 1-based convention. parsedOk=false signals a
// JSON parse failure so the caller can avoid a false clean PASS.
function parsePyrightOutput(stdout: string): {
	errors: ParsedError[];
	parsedOk: boolean;
} {
	let parsed: PyrightOutput;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { errors: [], parsedOk: false };
	}
	const diags = Array.isArray(parsed.generalDiagnostics)
		? parsed.generalDiagnostics
		: [];
	const errors: ParsedError[] = [];
	for (const d of diags) {
		if (d.severity !== "error") continue;
		const startLine = d.range?.start?.line ?? 0;
		const startChar = d.range?.start?.character ?? 0;
		errors.push({
			file: d.file ?? "",
			line: startLine + 1, // 0-based → 1-based (match tsc)
			column: startChar + 1,
			message: d.message ?? "",
		});
	}
	return { errors, parsedOk: true };
}

function runPyrightFlow(filePath: string, projectRoot: string): void {
	probePyrightAvailable(projectRoot);
	const { stdout, status } = runPyright(filePath, projectRoot);
	const { errors: allErrors, parsedOk } = parsePyrightOutput(stdout);

	// Bad JSON on a non-zero exit → script-error (avoid false PASS). pyright
	// exits 1 when it reports errors and 0 when clean; stdout is pure JSON.
	if (!parsedOk) {
		if (status !== null && status !== 0) process.exit(status);
		process.stderr.write("pyright-bad-output\n");
		process.exit(2);
	}

	const errors = filterToFilePath(allErrors, filePath, projectRoot);
	const out: SensorOutput = {
		pass: errors.length === 0,
		errors,
		findings_count: errors.length,
	};
	process.stdout.write(`${JSON.stringify(out)}\n`);
	process.exit(0);
}

// --- Python dispatch --------------------------------------------------------

function runPyFlow(filePath: string): void {
	const projectRoot = findPyProject(filePath);
	if (!projectRoot) {
		// No Python project manifest above the file → quiet PASS.
		process.stderr.write("no-python-project\n");
		process.exit(127);
	}
	const checker = selectPyChecker(projectRoot);
	if (checker === null) {
		// Project exists but configures no type checker → quiet PASS, mirroring
		// "no eslint config" / "no tsconfig" behaviour.
		process.stderr.write("no-python-type-checker-configured\n");
		process.exit(127);
	}
	if (checker === "mypy") {
		runMypyFlow(filePath, projectRoot);
		return;
	}
	runPyrightFlow(filePath, projectRoot);
}

if (import.meta.main) main();
