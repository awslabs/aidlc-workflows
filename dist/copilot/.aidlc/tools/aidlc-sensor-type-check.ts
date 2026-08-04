// aidlc-sensor-type-check.ts — per-sensor script for the `type-check` sensor.
//
// Owns the type-check itself; the dispatcher (aidlc-sensor.ts) routes a
// SENSOR fire to this script via the manifest's `command:` field. Self-
// contained: no imports from sibling tools. Wraps `bunx tsc --project
// <tsconfig> --noEmit --pretty false --incremental --tsBuildInfoFile
// <path under the active record's .aidlc-sensors/>` and prints the locked stdout
// JSON shape:
//
//   {"pass": <bool>, "errors": [{file, line, column, message}, ...]}
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
//   fires under the active record's .aidlc-sensors/.tsbuildinfo (gitignored by
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
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sensorsDir } from "./aidlc-lib.ts";

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
			`Wraps \`bunx tsc --project <tsconfig> --noEmit --pretty false\` and\n` +
			`prints {pass, errors[]} JSON to stdout (filtered to --file-path).\n`,
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

export function main(argv: string[]): void {
	const args = parseArgs(argv);

	if (!existsSync(args.filePath)) {
		process.stderr.write(`file-path not found: ${args.filePath}\n`);
		process.exit(1);
	}

	const tsconfigPath = findTsconfig(args.filePath);
	if (!tsconfigPath) {
		process.stderr.write("no-tsconfig-found\n");
		process.exit(1);
	}
	const tsconfigDir = dirname(tsconfigPath);

		// Use the tsconfig directory as the project anchor for resolving the
		// active record's .aidlc-sensors/.tsbuildinfo. The .aidlc-sensors/
		// directory is gitignored, so the tsbuildinfo never pollutes commits.
	const sensorsBaseDir = sensorsDir(tsconfigDir);
	try {
		mkdirSync(sensorsBaseDir, { recursive: true });
	} catch {
		// If we can't mkdir (read-only fs etc.), proceed without
		// --tsBuildInfoFile by pointing at a tmp path. tsc still works,
		// just non-incremental on next run.
	}
	const tsBuildInfoFile = join(sensorsBaseDir, ".tsbuildinfo");

	// Probe tsc availability first. cwd doesn't matter for --version.
	probeTscAvailable(tsconfigDir);

	const { output, status } = runTsc({
		tsconfigPath,
		tsBuildInfoFile,
		cwd: tsconfigDir,
	});
	const allErrors = parseTscOutput(output);
	const errors = filterToFilePath(allErrors, args.filePath, tsconfigDir);

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

if (import.meta.main) main(process.argv.slice(2));
