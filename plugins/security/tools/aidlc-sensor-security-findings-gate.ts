// security-findings-gate sensor: holds the Code Generation gate while a unit's
// AWS Security Agent diff scan record has an open finding at or above the
// threshold. It reads only that record and the project's override mode, never
// the network. The dispatcher treats any non-zero exit as "could not run", so
// every verdict, pass or fail, is one JSON line on stdout with exit 0.
//
// Self-contained: a plugin tool must not import the framework's aidlc-lib.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const RECORD_FILE = "security-scan-result.md";

// UNKNOWN ranks above CRITICAL so it blocks at every threshold: a finding the
// service could not rate is no evidence that it is minor.
const RISK_RANK = { INFORMATIONAL: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4, UNKNOWN: 5 } as const;
type RiskLevel = keyof typeof RISK_RANK;
type Threshold = Exclude<RiskLevel, "UNKNOWN">;
const RISK_LEVELS = Object.keys(RISK_RANK) as RiskLevel[];
const THRESHOLDS = RISK_LEVELS.filter((level): level is Threshold => level !== "UNKNOWN");

// The manifest's command cannot carry a threshold: the dispatcher runs this file
// with --stage and --output-path only. A different gate level is a change here.
const DEFAULT_THRESHOLD: Threshold = "HIGH";

// The dispatcher runs this file with the project root as its working directory,
// so a committed file there reaches every real fire and shows in review. An
// environment variable would not: the agent sets the environment of the
// commands it runs. Strict is the default because the gate cannot tell whether
// a person or the agent wrote an override into the record.
const CONFIG_FILE = ".aidlc-security.json";
const OVERRIDE_MODES = ["strict", "lenient"] as const;
type OverrideMode = (typeof OVERRIDE_MODES)[number];
const DEFAULT_OVERRIDE_MODE: OverrideMode = "strict";
const CONFIG_SHAPE = OVERRIDE_MODES.map((mode) => `{"override_mode": "${mode}"}`).join(" or ");
const ACCEPT_AT_GATE =
	"Fix it and scan again, or the person can accept the risk by choosing Override blocking sensors at the gate.";

const FINDING_STATUSES = ["ACTIVE", "RESOLVED", "ACCEPTED", "FALSE_POSITIVE"] as const;
const SCAN_STATUSES = ["IN_PROGRESS", "STOPPING", "STOPPED", "FAILED", "COMPLETED"] as const;
type ScanStatus = (typeof SCAN_STATUSES)[number];

interface CodeLocation {
	file_path: string;
	line_start?: number;
	line_end?: number;
}

interface Override {
	by: string;
	reason: string;
	at: string;
}

interface Finding {
	finding_id: string;
	name: string;
	risk_level: RiskLevel;
	status: (typeof FINDING_STATUSES)[number];
	code_locations: CodeLocation[];
	override?: Override;
}

interface Scan {
	scan_id: string;
	base_ref: string;
	status: ScanStatus;
	region: string;
	mcp_server: string;
	completed_at?: string;
}

type ScanRecord =
	| { kind: "scanned"; scan: Scan; findings: Finding[] }
	| { kind: "not-run"; reason: string; at: string };

type ModeSetting = { mode: OverrideMode } | { problem: string };

interface Verdict {
	pass: boolean;
	findings: string[];
	findings_count: number;
	threshold: string;
	override_mode: OverrideMode | null;
	overrides: string[];
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isTimestamp(value: string): boolean {
	return ISO_8601.test(value) && Number.isFinite(Date.parse(value));
}

function isThreshold(value: string): value is Threshold {
	return (THRESHOLDS as string[]).includes(value);
}

function isOverrideMode(value: unknown): value is OverrideMode {
	return typeof value === "string" && (OVERRIDE_MODES as readonly string[]).includes(value);
}

// Only a missing file or key falls back to strict. Anything else that is not
// one of the two modes fails the gate, so a typo never decides the mode.
function readOverrideMode(projectDir: string): ModeSetting {
	const path = join(projectDir, CONFIG_FILE);
	const problem = (what: string): ModeSetting => ({ problem: `${path} ${what}. It must hold ${CONFIG_SHAPE}.` });
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: DEFAULT_OVERRIDE_MODE };
		return problem(`cannot be read (${error instanceof Error ? error.message : String(error)})`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return problem(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return problem("is not a JSON object");
	const unread = Object.keys(raw).filter((key) => key !== "override_mode");
	if (unread.length > 0) {
		return problem(`has keys the gate does not read (${unread.map((key) => JSON.stringify(key)).join(", ")})`);
	}
	const mode = (raw as Record<string, unknown>).override_mode;
	if (mode === undefined) return { mode: DEFAULT_OVERRIDE_MODE };
	return isOverrideMode(mode) ? { mode } : problem(`sets override_mode to ${JSON.stringify(mode)}`);
}

function recordJson(markdown: string): { json: string } | { problem: string } {
	const lines = markdown.split(/\r?\n/);
	const blocks: string[] = [];
	for (let open = 0; open < lines.length; open++) {
		if (!/^```json\s*$/.test(lines[open])) continue;
		const close = lines.findIndex((line, index) => index > open && /^```\s*$/.test(line));
		if (close === -1) return { problem: "its ```json block is never closed" };
		blocks.push(lines.slice(open + 1, close).join("\n"));
		open = close;
	}
	if (blocks.length !== 1) {
		return { problem: `it holds ${blocks.length} \`\`\`json blocks, and the record is exactly one` };
	}
	return { json: blocks[0] };
}

function parseRecord(value: unknown): { record: ScanRecord } | { problems: string[] } {
	const problems: string[] = [];
	const object = (input: unknown, at: string): Record<string, unknown> => {
		if (typeof input === "object" && input !== null && !Array.isArray(input)) {
			return input as Record<string, unknown>;
		}
		problems.push(`${at} must be an object`);
		return {};
	};
	const list = (input: unknown, at: string): unknown[] => {
		if (Array.isArray(input)) return input;
		problems.push(`${at} must be a list`);
		return [];
	};
	const text = (input: unknown, at: string, nonEmpty = true): string => {
		if (typeof input === "string" && (!nonEmpty || input.trim() !== "")) return input;
		problems.push(`${at} must be a${nonEmpty ? " non-empty" : ""} string`);
		return "";
	};
	const oneOf = <T extends string>(input: unknown, at: string, allowed: readonly T[]): T => {
		if (typeof input === "string" && (allowed as readonly string[]).includes(input)) return input as T;
		problems.push(`${at} is ${JSON.stringify(input)}; it must be one of ${allowed.join(", ")}`);
		return allowed[0];
	};
	const timestamp = (input: unknown, at: string): string => {
		const time = text(input, at);
		if (time !== "" && !isTimestamp(time)) problems.push(`${at} is "${time}", not an ISO-8601 time`);
		return time;
	};
	const optionalLine = (input: unknown, at: string): number | undefined => {
		if (input === undefined) return undefined;
		if (Number.isInteger(input)) return input as number;
		problems.push(`${at} must be a whole number`);
		return undefined;
	};

	const root = object(value, "the record");
	if (root.schema_version !== 1) {
		problems.push(`schema_version is ${JSON.stringify(root.schema_version)}; this gate reads version 1`);
	}
	if ((root.scan === undefined) === (root.not_run === undefined)) {
		problems.push("the record must hold either scan or not_run, and not both");
		return { problems };
	}

	if (root.not_run !== undefined) {
		const notRun = object(root.not_run, "not_run");
		const record: ScanRecord = {
			kind: "not-run",
			reason: text(notRun.reason, "not_run.reason"),
			at: timestamp(notRun.at, "not_run.at"),
		};
		return problems.length > 0 ? { problems } : { record };
	}

	const rawScan = object(root.scan, "scan");
	if (rawScan.scan_type !== "DIFF") {
		problems.push(`scan.scan_type is ${JSON.stringify(rawScan.scan_type)}; this gate reads a DIFF scan`);
	}
	const scan: Scan = {
		scan_id: text(rawScan.scan_id, "scan.scan_id"),
		base_ref: text(rawScan.base_ref, "scan.base_ref"),
		status: oneOf(rawScan.status, "scan.status", SCAN_STATUSES),
		region: text(rawScan.region, "scan.region"),
		mcp_server: text(rawScan.mcp_server, "scan.mcp_server"),
	};
	if (rawScan.completed_at !== undefined || scan.status === "COMPLETED") {
		scan.completed_at = timestamp(rawScan.completed_at, "scan.completed_at");
	}

	const findings = list(root.findings, "findings").map((input, index): Finding => {
		const at = `findings[${index}]`;
		const raw = object(input, at);
		const finding: Finding = {
			finding_id: text(raw.finding_id, `${at}.finding_id`),
			name: text(raw.name, `${at}.name`),
			risk_level: oneOf(raw.risk_level, `${at}.risk_level`, RISK_LEVELS),
			status: oneOf(raw.status, `${at}.status`, FINDING_STATUSES),
			code_locations: (raw.code_locations === undefined ? [] : list(raw.code_locations, `${at}.code_locations`)).map(
				(location, place): CodeLocation => {
					const where = `${at}.code_locations[${place}]`;
					const rawLocation = object(location, where);
					return {
						file_path: text(rawLocation.file_path, `${where}.file_path`),
						line_start: optionalLine(rawLocation.line_start, `${where}.line_start`),
						line_end: optionalLine(rawLocation.line_end, `${where}.line_end`),
					};
				},
			),
		};
		if (raw.override !== undefined) {
			const override = object(raw.override, `${at}.override`);
			finding.override = {
				by: text(override.by, `${at}.override.by`, false),
				reason: text(override.reason, `${at}.override.reason`, false),
				at: text(override.at, `${at}.override.at`, false),
			};
		}
		return finding;
	});

	return problems.length > 0 ? { problems } : { record: { kind: "scanned", scan, findings } };
}

function overrideProblem(override: Override): string | null {
	if (override.by.trim() === "") return "names no one in `by`";
	if (override.reason.trim() === "") return "gives no `reason`";
	if (!isTimestamp(override.at)) return `has an \`at\` ("${override.at}") that is not an ISO-8601 time`;
	return null;
}

function describe(finding: Finding): string {
	const location = finding.code_locations[0];
	const lines =
		location?.line_start === undefined
			? ""
			: location.line_end === undefined || location.line_end === location.line_start
				? `:${location.line_start}`
				: `:${location.line_start}-${location.line_end}`;
	const where = location === undefined ? "" : ` at ${location.file_path}${lines}`;
	return `${finding.finding_id} (${finding.risk_level}) ${finding.name}${where}`;
}

function decide(
	record: ScanRecord,
	threshold: Threshold,
	mode: OverrideMode,
): { blocking: string[]; overrides: string[] } {
	if (record.kind === "not-run") {
		return {
			blocking: [
				`No diff scan ran for this unit: ${record.reason} (recorded ${record.at}). The gate needs a COMPLETED scan: scan the unit, or the person can override the gate.`,
			],
			overrides: [],
		};
	}
	const blocking: string[] = [];
	const overrides: string[] = [];
	if (record.scan.status !== "COMPLETED") {
		blocking.push(
			`Diff scan ${record.scan.scan_id} is ${record.scan.status}, not COMPLETED. An unfinished scan is no evidence: wait for it to complete, or scan again, then write the record again.`,
		);
	}
	for (const finding of record.findings) {
		if (RISK_RANK[finding.risk_level] < RISK_RANK[threshold] || finding.status === "RESOLVED") continue;
		const label = describe(finding);
		if (mode === "strict") {
			blocking.push(
				finding.override === undefined
					? `${label} is ${finding.status}. ${ACCEPT_AT_GATE}`
					: `${label} is ${finding.status}. The gate ignores its override in the record, because the override mode is strict unless the project's ${CONFIG_FILE} sets it to lenient. ${ACCEPT_AT_GATE}`,
			);
			continue;
		}
		if (finding.override === undefined) {
			blocking.push(
				`${label} is ${finding.status}. Fix it and scan again, or record the person's decision to accept the risk.`,
			);
			continue;
		}
		const problem = overrideProblem(finding.override);
		if (problem !== null) {
			blocking.push(`${label} still blocks: its override ${problem}.`);
			continue;
		}
		const { by, at, reason } = finding.override;
		overrides.push(`${label}: accepted by ${by} at ${at}. Reason: ${reason}`);
	}
	return { blocking, overrides };
}

// The gate fires this sensor on the record and on the unit's plan. The plan's
// fire proves a record exists beside it, so a unit that skipped the scan still
// stops the gate; the record's own fire judges what it says.
function evaluate(outputPath: string, threshold: string, setting: ModeSetting): Verdict {
	const verdict = (blocking: string[], overrides: string[] = []): Verdict => ({
		pass: blocking.length === 0,
		findings: blocking,
		findings_count: blocking.length,
		threshold,
		override_mode: "mode" in setting ? setting.mode : null,
		overrides,
	});
	if (!isThreshold(threshold)) {
		return verdict([`The gate's threshold "${threshold}" is not a risk level. Use one of ${THRESHOLDS.join(", ")}.`]);
	}
	if ("problem" in setting) return verdict([setting.problem]);
	const firedOnRecord = basename(outputPath) === RECORD_FILE;
	const recordPath = firedOnRecord ? outputPath : join(dirname(outputPath), RECORD_FILE);
	let markdown: string;
	try {
		markdown = readFileSync(recordPath, "utf-8");
	} catch {
		return verdict([
			`No security scan record at ${recordPath}. Code Generation's security step writes it after the code is generated.`,
		]);
	}
	if (!firedOnRecord) return verdict([]);

	const block = recordJson(markdown);
	if ("problem" in block) return verdict([`${RECORD_FILE}: ${block.problem}.`]);
	let raw: unknown;
	try {
		raw = JSON.parse(block.json);
	} catch (error) {
		return verdict([
			`${RECORD_FILE}: its json block is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
		]);
	}
	const parsed = parseRecord(raw);
	if ("problems" in parsed) return verdict(parsed.problems.map((problem) => `${RECORD_FILE}: ${problem}.`));
	const { blocking, overrides } = decide(parsed.record, threshold, setting.mode);
	return verdict(blocking, overrides);
}

function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : (argv[index + 1] ?? "");
}

export function main(argv: string[]): void {
	const outputPath = flagValue(argv, "--output-path");
	if (outputPath === undefined || outputPath === "") {
		process.stderr.write(
			"Usage: aidlc-sensor-security-findings-gate.ts --output-path <path> [--stage <slug>] [--threshold <level>]\n",
		);
		process.exitCode = 2;
		return;
	}
	const result = evaluate(
		outputPath,
		flagValue(argv, "--threshold") ?? DEFAULT_THRESHOLD,
		readOverrideMode(process.cwd()),
	);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
