// aidlc-sensor-record.ts — the rows of one sensor fire, shared by the sensor
// dispatcher (aidlc-sensor.ts) and the gate (aidlc-state.ts fireGateSensors).
// It reads no sensor manifest, so the state tool can load it in an install
// that carries only its tools.

import { randomBytes } from "node:crypto";
import { appendAuditEntries } from "./aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "./aidlc-lib.ts";

// --- Fire id ---

export function generateFireId(): string {
	return randomBytes(4).toString("hex");
}

export const FIRE_ID = /^[0-9a-f]{8}$/;

// The fields every row of one fire carries, SENSOR_FIRED and its result alike.
export function fireRowFields(
	fireId: string,
	sensorId: string,
	stageSlug: string,
	unit: string | null,
	outputPath: string,
	projectDir: string,
): Record<string, string> {
	return {
		"Fire id": fireId,
		"Sensor ID": sensorId,
		"Stage slug": stageSlug,
		...(unit ? { Unit: unit } : {}),
		"Output path": relativizePath(outputPath, projectDir),
	};
}

// --- Audit paths ---

// Slim absolute paths into project-relative form for audit emission.
// audit.md must be machine-portable across worktrees; the PostToolUse
// hook hands us absolute paths from Claude tool calls, so without this
// helper every row would carry $HOME prefixes. Paths that don't live
// under projectDir are emitted verbatim (e.g., system-wide fixtures) —
// slimming is opportunistic, not enforced.
export function relativizePath(absPath: string, projectDir: string): string {
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

export function normalizePathForComparison(path: string): string {
	return path.replace(/\\/g, "/");
}

function trimTrailingSlashes(path: string): string {
	return path.replace(/\/+$/, "");
}

export function comparisonKey(path: string): string {
	return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

// --- A fire that gave its caller no verdict ---

// unfinishedFire: what a fire that gave its caller no verdict comes to, from
// the dispatcher's spawn result and the verdict the caller read off its stdout.
// `reason` is what a blocking gate's refusal shows; `note` is the cause the
// record keeps, in the words decideOutcome notes a script that could not run,
// without the dispatcher's stderr, which can name paths on this machine. Null
// when the dispatcher answered: it exited 0 and printed a verdict.
export function unfinishedFire<V>(
	result: { error?: Error; status: number | null; signal: NodeJS.Signals | null; stderr: string },
	verdict: V | null,
): { verdict: V; unfinished: null } | { verdict: V | null; unfinished: { reason: string; note: string } } {
	const unfinished = (reason: string, note: string) => ({ verdict, unfinished: { reason, note: `dispatch-error: ${note}` } });
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code ?? "unknown";
		return code === "ETIMEDOUT"
			? unfinished("dispatcher timeout", "timeout")
			: unfinished(`dispatcher spawn failed (${code})`, `spawn-failed: ${code}`);
	}
	if (result.status === null) {
		return unfinished(`dispatcher terminated by ${result.signal ?? "unknown signal"}`, `signal-${result.signal ?? "unknown"}`);
	}
	if (result.status !== 0) {
		const stderr = (result.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
		return unfinished(`dispatcher exited ${result.status}${stderr ? `: ${stderr}` : ""}`, `exit-${result.status}`);
	}
	return verdict === null
		? unfinished("dispatcher returned no valid verdict", "bad-output")
		: { verdict, unfinished: null };
}

// recordUnfinishedFire: the gate's account of one fire it started with its own
// Fire id and got no verdict back from (the dispatcher could not start, timed
// out, exited non-zero before its rows, or printed nothing it could read). That
// fire checked nothing the gate can show, so it is recorded as could not run,
// never left as a check that did not run or as an earlier pass. The dispatcher
// has exited, so every row it wrote is on disk: a result row of this fire is
// kept, a SENSOR_FIRED it left without one is closed, and a fire with neither
// gets both rows, in one append. A row is this fire's by its Fire id, fresh for
// each gate fire, with its check and stage; the output is not compared, as the
// record may spell it another way (`<project-dir>/...` under a symlinked
// project folder).
export function recordUnfinishedFire(
	projectDir: string,
	fire: {
		fireId: string;
		sensorId: string;
		stageSlug: string;
		unit: string | null;
		outputPath: string;
		durationMs: number;
		note: string;
	},
): void {
	const fields = fireRowFields(fire.fireId, fire.sensorId, fire.stageSlug, fire.unit, fire.outputPath, projectDir);
	const rows = readAuditShardEvents(projectDir).filter((row) =>
		row.event.startsWith("SENSOR_") &&
		["Fire id", "Sensor ID", "Stage slug"].every((name) => auditBlockField(row.block, name) === fields[name])
	);
	if (rows.some((row) => row.event !== "SENSOR_FIRED")) return;
	appendAuditEntries([
		...(rows.length === 0 ? [{ eventType: "SENSOR_FIRED", fields }] : []),
		{
			eventType: "SENSOR_COULD_NOT_RUN",
			fields: { ...fields, "Duration ms": String(fire.durationMs), Note: fire.note },
		},
	], projectDir);
}
