// aidlc-sensor.ts — sensor dispatcher CLI for the AIDLC framework.
//
// Subcommands:
//   list                          — enumerate framework sensors (alpha order).
//   describe <id>                 — print manifest fields for one sensor.
//   fire <id> --stage <slug>      — invoke a sensor against a stage output;
//        --output-path <path>       emits SENSOR_FIRED then a paired terminal
//                                   row (PASSED | FAILED | BUDGET_OVERRIDE).
//
// The dispatcher is a thin routing surface (Q4/Q5 of the locked plan):
//   1. Validate inputs + resolve graph + generate Fire id (no audit lock held).
//   2. Acquire lock → emit SENSOR_FIRED → release.
//   3. Spawn the per-sensor script (no lock held; long-running is fine).
//   4. Decide outcome via the truth table below (no lock held).
//   5. If FAILED: write detail file via `wx`-flag + rename (race-free).
//   6. Acquire lock → emit terminal row → release.
//   7. Exit 0. (Sensor failure ≠ CLI failure.)
//
// Truth-table branch ordering — locked, branch a precedes branch 0:
//   a) signal === "SIGTERM" AND elapsed ≥ timeout - GRACE  → BUDGET_OVERRIDE
//   0) error AND status===null AND signal===null           → PASSED script-error: spawn-failed
//   b) status === 127                                       → PASSED tool-unavailable
//   c) status === 0 AND JSON.pass === false                 → FAILED
//   d) status === 0 AND JSON.pass === true                  → PASSED
//   e) status non-0/non-127 (non-timeout)                   → PASSED script-error: exit-<n>
//   f) bad JSON / missing pass                              → PASSED script-error: bad-output
//   default                                                 → PASSED script-error: unknown
//
// CLI exits non-zero ONLY on dispatcher invocation errors (unknown id, missing
// flag, missing path, matches-rejection). Sensor outcomes are advisory and
// always emit a paired terminal row.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import { loadGraph, loadSensors, type SensorFile } from "./aidlc-graph.ts";
import { errorMessage, isoTimestamp, isPlainObject, resolveProjectDir, withAuditLock } from "./aidlc-lib.ts";

// --- Constants ---

const DEFAULT_TIMEOUT_SECONDS = 60;

// Locked at 100ms in the truth table to disambiguate timeout-induced SIGTERM
// from external-SIGTERM (parent kill, Ctrl-C). Anything within GRACE of the
// configured timeout is treated as a timeout.
const DEFAULT_TIMEOUT_GRACE_MS = 100;

// Resolve sibling per-sensor script paths relative to THIS file's location,
// not cwd. Mirrors aidlc-bolt.ts:84's spawnSibling pattern. The manifest
// `command:` is `bun <harness>/tools/aidlc-sensor-<id>.ts` — the dispatcher
// extracts the basename and resolves it next to itself, then spawns bun
// with cwd=projectDir so the script's own file I/O resolves under the
// user's project.
const __FILE_DIR = dirname(fileURLToPath(import.meta.url));

// --- Types ---

type FireOutcome =
	| { kind: "passed"; durationMs: number; note?: string }
	| {
			kind: "failed";
			durationMs: number;
			findingsCount: number;
			detailBody: string;
	  }
	| { kind: "budget-override"; capValue: number; observedSeconds: number };

interface FireContext {
	sensor: SensorFile;
	stageSlug: string;
	outputPath: string;
	fireId: string;
	detailPath: string;
	scriptArgs: string[]; // CLI args appended to the script invocation
	scriptAbsPath: string; // sibling-resolved absolute path
	timeoutMs: number;
}

// --- Argv helpers ---

function parseFlags(args: string[]): Record<string, string> {
	const flags: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("--")) continue;
		if (i + 1 >= args.length) {
			dispatchError(`${a} expects a value, got end of arguments.`);
		}
		const val = args[i + 1];
		if (val.startsWith("--")) {
			dispatchError(`${a} expects a value, got another flag: "${val}".`);
		}
		flags[a.slice(2)] = val;
		i++;
	}
	return flags;
}

function dispatchError(msg: string): never {
	process.stderr.write(`aidlc-sensor: ${msg}\n`);
	process.exit(1);
}

// --- Sibling-script resolver ---
//
// Manifest `command:` is `bun <harness>/tools/aidlc-sensor-<id>.ts`. The
// dispatcher extracts the .ts basename and resolves it next to itself.
// This decouples script discovery from cwd — works in tests where
// projectDir doesn't carry a .claude/tools/ tree, AND in production where
// it does. Sibling resolution mirrors aidlc-bolt.ts:84.
//
// AIDLC_SENSOR_SCRIPT_DIR overrides the resolution directory — the script
// seam mirroring AIDLC_SENSORS_DIR for manifests. Tests that exercise stub
// per-sensor scripts point it at an isolated temp dir so they NEVER copy
// stubs into the shipped dist/.../tools/ tree (which both pollutes the
// version-controlled artifact on a crashed run and makes concurrent test
// files race on a shared directory). Unset in production → sibling resolution
// against __FILE_DIR, exactly as before.
function resolveScriptPath(command: string): string {
	const tokens = command.trim().split(/\s+/);
	// Find the first .ts token (drops the "bun" prefix or any flags).
	const tsToken = tokens.find((t) => t.endsWith(".ts"));
	if (!tsToken) {
		dispatchError(`manifest command lacks a .ts script: "${command}"`);
	}
	// String.split always returns a non-empty array, so the last element
	// is always defined — indexed access keeps the basename typed as
	// string without a non-null assertion.
	const parts = tsToken.split("/");
	const basename = parts[parts.length - 1];
	const scriptDir = process.env.AIDLC_SENSOR_SCRIPT_DIR ?? __FILE_DIR;
	return join(scriptDir, basename);
}

// --- Fire id ---

function generateFireId(): string {
	return randomBytes(4).toString("hex");
}

// --- Subcommand: list ---

function handleList(): void {
	const sensors = [...loadSensors().values()].sort((a, b) =>
		a.id.localeCompare(b.id),
	);
	if (sensors.length === 0) {
		return;
	}
	// Tabular output: id  kind  description
	for (const s of sensors) {
		console.log(`${s.id}\t${s.manifest.kind}\t${s.manifest.description}`);
	}
}

// --- Subcommand: describe ---

function handleDescribe(args: string[]): void {
	const id = args[0];
	if (!id || id.startsWith("--")) {
		dispatchError("describe requires a sensor id");
	}
	const sensors = loadSensors();
	const sensor = sensors.get(id);
	if (!sensor) {
		const known = [...sensors.keys()].sort().join(", ") || "(none)";
		dispatchError(`unknown sensor id: "${id}". Known ids: ${known}`);
	}
	const m = sensor.manifest;
	console.log(`id: ${m.id}`);
	console.log(`kind: ${m.kind}`);
	console.log(`command: ${m.command}`);
	console.log(`default_severity: ${m.default_severity}`);
	console.log(`description: ${m.description}`);
	if (m.category !== undefined) console.log(`category: ${m.category}`);
	if (m.matches !== undefined) console.log(`matches: ${m.matches}`);
	if (m.timeout_seconds !== undefined) {
		console.log(`timeout_seconds: ${m.timeout_seconds}`);
	}
	console.log(`path: ${sensor.path}`);
}

// --- Subcommand: fire ---
//
// Step 1 — validate + resolve all inputs + generate Fire id (no lock).
// Step 4-8 — emit FIRED, spawn, decide outcome, write detail (if FAILED),
//            emit terminal row.
// Step 9 — exit 0.
function handleFire(args: string[]): void {
	const id = args[0];
	if (!id || id.startsWith("--")) {
		dispatchError("fire requires a sensor id as first positional arg");
	}
	const flags = parseFlags(args.slice(1));
	if (!flags.stage) dispatchError("fire requires --stage <slug>");
	if (!flags["output-path"])
		dispatchError("fire requires --output-path <path>");

	const stageSlug = flags.stage;
	// Resolve outputPath to absolute upfront so the per-sensor script and the
	// dispatcher both see the same path regardless of cwd. The dispatcher
	// itself runs from the user's cwd; the per-sensor script runs with
	// cwd: projectDir. A relative outputPath would resolve to two different
	// files. Absolute resolution against the dispatcher's invocation cwd
	// matches user intent ("the file as I named it from where I invoked
	// aidlc-sensor"). matches-glob comparison happens on the absolute path.
	const rawOutputPath = flags["output-path"];
	const outputPath = isAbsolute(rawOutputPath)
		? rawOutputPath
		: pathResolve(process.cwd(), rawOutputPath);

	// --- 1a. Resolve sensor manifest by id ---
	const sensors = loadSensors();
	const sensor = sensors.get(id);
	if (!sensor) {
		const known = [...sensors.keys()].sort().join(", ") || "(none)";
		dispatchError(`unknown sensor id: "${id}". Known ids: ${known}`);
	}

	// --- 1b. Resolve stage slug via loadGraph (pre-lock) ---
	// Q9 + the orphan-FIRED prevention rule: if a stage file is malformed,
	// loadGraph throws here and we exit 1 BEFORE any audit emit.
	const graph = loadGraph();
	const stageNode = graph.find((s) => s.slug === stageSlug);
	if (!stageNode) {
		const known = graph
			.map((s) => s.slug)
			.sort()
			.slice(0, 10)
			.join(", ");
		dispatchError(
			`unknown stage slug: "${stageSlug}". Known (first 10): ${known}`,
		);
	}

	// --- 1c. Validate output path exists on disk ---
	if (!existsSync(outputPath)) {
		dispatchError(`output path does not exist: ${outputPath}`);
	}

	// --- 1d. Apply manifest matches filter (capability-shape check) ---
	// The PostToolUse Write/Edit hook applies the same filter; the dispatcher
	// re-checks so a
	// human-callable invocation can't bypass the shape contract.
	const matches = sensor.manifest.matches;
	if (matches !== undefined && !matchesGlob(matches, outputPath)) {
		dispatchError(
			`output path "${outputPath}" does not match sensor "${id}" filter "${matches}"`,
		);
	}

	// --- 1e. Generate Fire id (8 hex chars) ---
	const fireId = generateFireId();

	// --- 2. Compute extra args for the per-sensor script ---
	// Markdown sensors take --output-path; code sensors take --file-path.
	// upstream-coverage additionally takes --consumes "art1,art2,..." sourced
	// from the GraphStage.consumes[].artifact field.
	const isCodeSensor = id === "linter" || id === "type-check";
	const scriptArgs: string[] = ["--stage", stageSlug];
	if (isCodeSensor) {
		scriptArgs.push("--file-path", outputPath);
	} else {
		scriptArgs.push("--output-path", outputPath);
	}
	if (id === "upstream-coverage") {
		const consumeSlugs = (stageNode.consumes ?? [])
			.map((c) => c.artifact)
			.filter((a) => typeof a === "string" && a.length > 0);
		scriptArgs.push("--consumes", consumeSlugs.join(","));
	}

	// --- 3. Pre-compute detail-file path (used only on FAILED) ---
	// aidlc-docs/.aidlc-sensors/<stage-slug>/<sensor-id>-<fire-id>.md
	const projectDir = resolveProjectDir();
	const detailDir = join(projectDir, "aidlc-docs", ".aidlc-sensors", stageSlug);
	const detailPath = join(detailDir, `${id}-${fireId}.md`);

	// --- 1f. Resolve sibling script path + timeout ---
	const scriptAbsPath = resolveScriptPath(sensor.manifest.command);
	if (!existsSync(scriptAbsPath)) {
		dispatchError(`per-sensor script missing on disk: ${scriptAbsPath}`);
	}
	const timeoutSeconds =
		sensor.manifest.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
	const timeoutMs = timeoutSeconds * 1000;

	const ctx: FireContext = {
		sensor,
		stageSlug,
		outputPath,
		fireId,
		detailPath,
		scriptArgs,
		scriptAbsPath,
		timeoutMs,
	};

	// --- 4. Lock window A — emit SENSOR_FIRED ---
	withAuditLock(projectDir, () => {
		appendAuditEntryUnlocked(
			"SENSOR_FIRED",
			{
				"Fire id": fireId,
				"Sensor ID": id,
				"Stage slug": stageSlug,
				"Output path": relativizePath(outputPath, projectDir),
			},
			projectDir,
		);
	});

	// --- 5. Spawn (no lock held). Wall-clock measured for branch a. ---
	const startedAt = Date.now();
	const result = spawnSync("bun", [ctx.scriptAbsPath, ...ctx.scriptArgs], {
		encoding: "utf-8",
		timeout: timeoutMs,
		cwd: projectDir,
	});
	const elapsedMs = Date.now() - startedAt;

	// --- 6. Decide outcome via the truth table ---
	const outcome = decideOutcome(ctx, result, elapsedMs, timeoutMs);

	// --- 7. If FAILED: write detail file via wx-flag + rename ---
	let finalOutcome = outcome;
	if (outcome.kind === "failed") {
		try {
			mkdirSync(detailDir, { recursive: true });
			const tmp = `${detailPath}.tmp`;
			writeFileSync(tmp, outcome.detailBody, { flag: "wx", encoding: "utf-8" });
			renameSync(tmp, detailPath);
		} catch (err) {
			// Drop to script-error: bad-output equivalent — Note=detail-write-failed.
			finalOutcome = {
				kind: "passed",
				durationMs: elapsedMs,
				note: `script-error: detail-write-failed: ${errorMessage(err)}`,
			};
		}
	}

	// --- 8. Lock window B — emit terminal row ---
	withAuditLock(projectDir, () => {
		emitTerminal(ctx, finalOutcome, projectDir);
	});

	// --- 9. Process exit 0 ---
	process.exit(0);
}

// --- Truth table ---
//
// Branch ordering is LOAD-BEARING: branch a (timeout) precedes branch 0
// (true spawn failure) because Node 16+ sets result.error alongside
// signal === "SIGTERM" on timeout. Reversed order swallows timeouts as
// script-error and branch a becomes dead code.
function decideOutcome(
	ctx: FireContext,
	result: ReturnType<typeof spawnSync>,
	elapsedMs: number,
	timeoutMs: number,
): FireOutcome {
	const { sensor, stageSlug, outputPath, fireId, detailPath } = ctx;

	// Branch a — timeout-SIGTERM (must precede branch 0)
	if (
		result.signal === "SIGTERM" &&
		elapsedMs >= timeoutMs - DEFAULT_TIMEOUT_GRACE_MS
	) {
		const capValue = sensor.manifest.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
		return {
			kind: "budget-override",
			capValue,
			observedSeconds: Math.ceil(elapsedMs / 1000),
		};
	}

	// Branch 0 — true spawn failure: error set AND status null AND signal null
	// (e.g., bun off PATH → ENOENT). Narrowed so timeouts can't sneak in.
	if (result.error && result.status === null && result.signal === null) {
		return {
			kind: "passed",
			durationMs: elapsedMs,
			note: `script-error: spawn-failed: ${(result.error as NodeJS.ErrnoException).code ?? "unknown"}`,
		};
	}

	// Branch b — exit 127 (per-sensor script signalled tool-unavailable)
	if (result.status === 127) {
		return {
			kind: "passed",
			durationMs: elapsedMs,
			note: "tool-unavailable",
		};
	}

	// Branches c/d/f — exit 0 path; parse stdout JSON
	if (result.status === 0) {
		let parsed: unknown;
		try {
			// encoding: "utf-8" guarantees stdout is a string but the union from
			// spawnSync's overload set isn't narrowed by encoding alone; check
			// with typeof to keep TS narrowing.
			const stdout = typeof result.stdout === "string" ? result.stdout : "";
			parsed = JSON.parse(stdout);
		} catch {
			return {
				kind: "passed",
				durationMs: elapsedMs,
				note: "script-error: bad-output",
			};
		}
		if (!isPlainObject(parsed) || typeof parsed.pass !== "boolean") {
			return {
				kind: "passed",
				durationMs: elapsedMs,
				note: "script-error: bad-output",
			};
		}
		const out = parsed;
		if (out.pass === false) {
			// Branch c — FAILED
			const findingsCount = readFindingsCount(out);
			const detailBody = buildDetailBody({
				sensorId: sensor.id,
				stageSlug,
				outputPath,
				fireId,
				timestamp: isoTimestamp(),
				sensorJson: out,
			});
			void detailPath; // already in ctx
			return {
				kind: "failed",
				durationMs: elapsedMs,
				findingsCount,
				detailBody,
			};
		}
		// Branch d — PASSED
		return { kind: "passed", durationMs: elapsedMs };
	}

	// Branch e — non-zero, non-127, non-timeout exit (incl. external SIGTERM
	// before the timeout window). Advisory script-error.
	if (
		result.signal === "SIGTERM" &&
		elapsedMs < timeoutMs - DEFAULT_TIMEOUT_GRACE_MS
	) {
		return {
			kind: "passed",
			durationMs: elapsedMs,
			note: "script-error: external-sigterm",
		};
	}
	if (result.status !== null) {
		return {
			kind: "passed",
			durationMs: elapsedMs,
			note: `script-error: exit-${result.status}`,
		};
	}
	// Non-SIGTERM signals (SIGKILL, SIGINT, SIGSEGV, …) — status is null,
	// signal is set. Surface the signal name so audits stay diagnosable
	// rather than collapsing to the unknown default below.
	if (result.signal !== null) {
		return {
			kind: "passed",
			durationMs: elapsedMs,
			note: `script-error: signal-${result.signal}`,
		};
	}

	// Default — should be unreachable; advisory always closes the pair.
	return {
		kind: "passed",
		durationMs: elapsedMs,
		note: "script-error: unknown",
	};
}

// --- Findings count read ---
//
// Per-sensor scripts emit their own findings_count in their stdout JSON.
// The dispatcher is sensor-id-agnostic: it reads out.findings_count
// generically. Fork sensors that omit the field fall back to 0; doctor's
// sibling-coverage check will surface that as a fork-sensor contract gap.
//
// Rationale: v3 control-plane / data-plane separation puts per-sensor
// findings derivation in the script (the script knows its own pass
// threshold; e.g., required-sections script knows 2 H2 sections is the
// minimum). The dispatcher stays generic and adds new framework sensors
// without an arm in this function.
function readFindingsCount(out: Record<string, unknown>): number {
	const v = out.findings_count;
	if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
		return Math.floor(v);
	}
	return 0;
}

// --- Detail-file body ---

function buildDetailBody(args: {
	sensorId: string;
	stageSlug: string;
	outputPath: string;
	fireId: string;
	timestamp: string;
	sensorJson: Record<string, unknown>;
}): string {
	const { sensorId, stageSlug, outputPath, fireId, timestamp, sensorJson } =
		args;
	const lines: string[] = [];
	lines.push(`# ${sensorId} finding — ${stageSlug}`);
	lines.push("");
	lines.push(`**Timestamp**: ${timestamp}`);
	lines.push(`**Fire id**: ${fireId}`);
	lines.push(`**Output path**: ${outputPath}`);
	lines.push(`**Pass**: false`);
	lines.push("");
	lines.push("## Findings");
	lines.push("");
	lines.push("```json");
	lines.push(JSON.stringify(sensorJson, null, 2));
	lines.push("```");
	lines.push("");
	return lines.join("\n");
}

// --- Terminal-row emit ---

// Slim absolute paths into project-relative form for audit emission.
// audit.md must be machine-portable across worktrees; the PostToolUse
// hook hands us absolute paths from Claude tool calls, so without this
// helper every row would carry $HOME prefixes. Paths that don't live
// under projectDir are emitted verbatim (e.g., system-wide fixtures) —
// slimming is opportunistic, not enforced.
function relativizePath(absPath: string, projectDir: string): string {
	const normalizedPath = normalizePathForComparison(absPath);
	const normalizedProject = trimTrailingSlashes(
		normalizePathForComparison(projectDir),
	);
	const comparePath = comparisonKey(normalizedPath);
	const compareProject = comparisonKey(normalizedProject);
	if (comparePath === compareProject) {
		return ".";
	}
	if (comparePath.startsWith(`${compareProject}/`)) {
		return normalizedPath.slice(normalizedProject.length + 1);
	}
	return normalizedPath;
}

function emitTerminal(
	ctx: FireContext,
	outcome: FireOutcome,
	projectDir: string,
): void {
	const { sensor, stageSlug, outputPath, fireId, detailPath } = ctx;
	const id = sensor.id;
	const baseFields: Record<string, string> = {
		"Fire id": fireId,
		"Sensor ID": id,
		"Stage slug": stageSlug,
		"Output path": relativizePath(outputPath, projectDir),
	};

	if (outcome.kind === "passed") {
		const fields: Record<string, string> = {
			...baseFields,
			"Duration ms": String(outcome.durationMs),
		};
		if (outcome.note) {
			fields.Note = outcome.note;
		}
		appendAuditEntryUnlocked("SENSOR_PASSED", fields, projectDir);
		return;
	}
	if (outcome.kind === "failed") {
		// detailPath is absolute; emit it as the project-relative path for
		// human readability. The audit-format spec calls for a relative
		// path under aidlc-docs/.aidlc-sensors/.
		const fields: Record<string, string> = {
			...baseFields,
			"Detail path": relativizePath(detailPath, projectDir),
			"Findings count": String(outcome.findingsCount),
		};
		appendAuditEntryUnlocked("SENSOR_FAILED", fields, projectDir);
		return;
	}
	// budget-override
	const fields: Record<string, string> = {
		...baseFields,
		"Cap layer": "registry",
		"Cap value": String(outcome.capValue),
		"Observed value": String(outcome.observedSeconds),
	};
	appendAuditEntryUnlocked("SENSOR_BUDGET_OVERRIDE", fields, projectDir);
}

// --- Glob matcher (capability filter) ---
//
// Manifests carry a single `matches:` glob (e.g., `**/*.{ts,js}`). The
// the PostToolUse Write/Edit hook applies the same filter at fire time. This is a tiny
// bespoke matcher — not a full minimatch — because the patterns we ship
// are constrained to suffix + brace-expansion shapes.
function matchesGlob(pattern: string, path: string): boolean {
	const normalizedPath = normalizePathForComparison(path);
	// Split brace expansions: **/*.{ts,js} → [**/*.ts, **/*.js]
	const variants: string[] = [];
	const braceMatch = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
	if (braceMatch) {
		const [, prefix, options, suffix] = braceMatch;
		for (const opt of options.split(",")) {
			variants.push(`${prefix}${opt.trim()}${suffix}`);
		}
	} else {
		variants.push(pattern);
	}
	return variants.some((v) => globToRegex(v).test(normalizedPath));
}

function normalizePathForComparison(path: string): string {
	return path.replace(/\\/g, "/");
}

function trimTrailingSlashes(path: string): string {
	return path.replace(/\/+$/, "");
}

function comparisonKey(path: string): string {
	return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

function globToRegex(glob: string): RegExp {
	// Translate **, *, and literal segments. Sufficient for the manifest patterns shipped today.
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (".+()|[]{}^$\\".includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

// --- Help ---

function printHelp(): void {
	console.log(`Usage: aidlc-sensor <subcommand>

Subcommands:
  list                              List framework sensors
  describe <id>                     Print manifest fields
  fire <id> --stage <slug>          Fire a sensor against an output;
       --output-path <path>           emits SENSOR_FIRED + paired terminal row

  --help, -h                        Show this message`);
}

// --- main ---

function main(): void {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === "--help" || cmd === "-h") {
		printHelp();
		return;
	}
	if (cmd === undefined) {
		process.stderr.write(
			"Usage: aidlc-sensor <subcommand>. Valid: describe, fire, list. Run with --help for detail.\n",
		);
		process.exit(1);
	}
	switch (cmd) {
		case "list":
			handleList();
			return;
		case "describe":
			handleDescribe(args);
			return;
		case "fire":
			handleFire(args);
			return;
		default:
			process.stderr.write(
				`aidlc-sensor: unknown subcommand: ${cmd}. Valid: describe, fire, list.\n`,
			);
			process.exit(1);
	}
}

main();
