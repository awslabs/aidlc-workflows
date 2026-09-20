// covers: tool:aidlc-sensor
//
// t345 - a passing sensor fire does not leave an earlier failure's detail file
// behind.
//
// The dispatcher names each detail file `<id>-<fireId>.md` (aidlc-sensor.ts
// :534) and writes it only on a FAILED outcome (:597). The fire id is fresh per
// fire (randomBytes(4), :241), so a later fire never overwrites an earlier
// file, and before this guard the dispatcher had no removal path at all: once a
// sensor failed and then passed, the stage's sensors/ directory still showed a
// failure that no longer existed. The authoritative record is the audit ledger
// (SENSOR_PASSED / SENSOR_FAILED) plus the verdict's `detail_path`, which is
// already null on a pass, so removing a superseded file loses nothing.
//
// pruneSupersededDetailFiles carries two scoping rules, and both are contracts
// rather than incidental behaviour:
//   - it matches only `<sensorId>-<8 hex>.md`, so a sibling sensor sharing the
//     stage directory is untouched, and an id that merely prefixes another id
//     does not capture it;
//   - it removes only files last modified BEFORE the fire began, so a
//     concurrent per-Unit swarm fire's live report survives.
//
// Mechanism: cli - this file carries both halves of the contract. The helper
// cases exercise pruneSupersededDetailFiles in-process against a temp
// directory. The behavioural case spawns the real dispatcher twice through bun
// (fail, then pass) and asserts on the bytes left on disk, which is the only way
// to observe that a passing fire clears an earlier failure's report. The header
// declares the stronger of the two mechanisms, so the coverage registry is not
// under-claimed. The `tool:` covers id is a documentation annotation, matching
// t251's and t237's convention.
//
// The behavioural case drives the real `required-sections` sensor rather than a
// stub: it fails on fewer than two H2 headings, so rewriting one output file
// between fires produces a genuine FAILED -> PASSED pair. It reads the stage
// graph from AIDLC_SRC (the generated dist tree) through the AIDLC_STAGE_GRAPH
// seam, exactly as t94 does.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneSupersededDetailFiles } from "../../core/tools/aidlc-sensor.ts";
import {
	AIDLC_SRC,
	cleanupTestProject,
	createTestProject,
	REPO_ROOT,
	seedAuditFile,
	seededRecordDir,
	seededStateFile,
} from "../harness/fixtures.ts";

const tempRoots: string[] = [];

function makeStageDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "t345-sensors-"));
	tempRoots.push(dir);
	return dir;
}

// Write a detail file and stamp its mtime, so "before this fire" is explicit
// rather than dependent on how fast the test runs.
function writeDetail(dir: string, name: string, ageSeconds: number): string {
	const path = join(dir, name);
	writeFileSync(path, "# findings\n", "utf-8");
	const when = new Date(Date.now() - ageSeconds * 1000);
	utimesSync(path, when, when);
	return path;
}

let stageDir: string;

beforeEach(() => {
	stageDir = makeStageDir();
});

afterAll(() => {
	// Best-effort cleanup; a leftover temp dir must not fail the suite.
	for (const dir of tempRoots) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("t345 superseded sensor detail files are pruned", () => {
	test("an earlier failure's detail file is removed when the sensor later passes", () => {
		writeDetail(stageDir, "linter-aaaaaaaa.md", 60);

		// A pass writes no file, so keepPath names a path that does not exist.
		const removed = pruneSupersededDetailFiles(
			stageDir,
			"linter",
			join(stageDir, "linter-bbbbbbbb.md"),
			Date.now(),
		);

		expect(removed).toBe(1);
		expect(readdirSync(stageDir)).toEqual([]);
	});

	test("the current fire's own detail file is kept", () => {
		const keep = writeDetail(stageDir, "linter-cccccccc.md", 60);

		const removed = pruneSupersededDetailFiles(
			stageDir,
			"linter",
			keep,
			Date.now(),
		);

		expect(removed).toBe(0);
		expect(readdirSync(stageDir)).toEqual(["linter-cccccccc.md"]);
	});

	test("a sibling sensor's detail file in the same stage directory is untouched", () => {
		writeDetail(stageDir, "linter-dddddddd.md", 60);
		writeDetail(stageDir, "traceability-eeeeeeee.md", 60);

		const removed = pruneSupersededDetailFiles(
			stageDir,
			"linter",
			join(stageDir, "linter-ffffffff.md"),
			Date.now(),
		);

		expect(removed).toBe(1);
		expect(readdirSync(stageDir)).toEqual(["traceability-eeeeeeee.md"]);
	});

	test("an id that only prefixes another sensor's id does not capture it", () => {
		// `linter` must not match `linter-extra`: the fire-id shape is exact, so
		// `linter-extra-<hex>.md` is not a `linter` detail file.
		writeDetail(stageDir, "linter-extra-11111111.md", 60);

		const removed = pruneSupersededDetailFiles(
			stageDir,
			"linter",
			join(stageDir, "linter-22222222.md"),
			Date.now(),
		);

		expect(removed).toBe(0);
		expect(readdirSync(stageDir)).toEqual(["linter-extra-11111111.md"]);
	});

	test("a concurrent fire's newer detail file survives the mtime cutoff", () => {
		// Swarm mode fires the same sensor per Unit against one stage directory.
		// A file written after this fire began belongs to another fire.
		const cutoff = Date.now() - 30_000;
		writeDetail(stageDir, "linter-33333333.md", 0);

		const removed = pruneSupersededDetailFiles(
			stageDir,
			"linter",
			join(stageDir, "linter-44444444.md"),
			cutoff,
		);

		expect(removed).toBe(0);
		expect(readdirSync(stageDir)).toEqual(["linter-33333333.md"]);
	});

	test("a non-detail file is never removed", () => {
		writeDetail(stageDir, "notes.md", 60);
		writeDetail(stageDir, "linter-55555555.md.tmp", 60);

		const removed = pruneSupersededDetailFiles(
			stageDir,
			"linter",
			join(stageDir, "linter-66666666.md"),
			Date.now(),
		);

		expect(removed).toBe(0);
		expect(readdirSync(stageDir).sort()).toEqual([
			"linter-55555555.md.tmp",
			"notes.md",
		]);
	});

	test("a missing stage directory is not an error", () => {
		const absent = join(stageDir, "does-not-exist");

		expect(
			pruneSupersededDetailFiles(
				absent,
				"linter",
				join(absent, "linter-77777777.md"),
				Date.now(),
			),
		).toBe(0);
	});
});

// The behavioural half: the same contract observed through the real dispatcher.
// The helper cases above pin the prune's rules; this one proves the dispatcher
// actually applies them, which is the defect #1087 reports.
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc-sensor.ts");
const FRAMEWORK_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const STAGE = "requirements-analysis";

// required-sections fails below two H2 headings, so the same output file
// rewritten between fires yields a real FAILED then a real PASSED.
const ONE_H2 = "# Title\n\n## Only One\n\nbody\n";
const THREE_H2 = "# Title\n\n## One\n\na\n\n## Two\n\nb\n\n## Three\n\nc\n";

describe("t345 the dispatcher clears a superseded detail file on a passing fire", () => {
	let proj: string | undefined;

	afterAll(() => {
		cleanupTestProject(proj);
	});

	test("a FAILED fire writes a detail file and the next PASSED fire removes it", () => {
		proj = createTestProject();
		seedAuditFile(proj);

		const record = seededRecordDir(proj);
		mkdirSync(record, { recursive: true });
		writeFileSync(
			seededStateFile(proj),
			[
				"# AI-DLC State (t345 fixture)",
				"",
				"- **Workflow**: bugfix",
				"- **Scope**: bugfix",
				"- **Phase**: inception",
				`- **Current Stage**: ${STAGE}`,
				"",
			].join("\n"),
			"utf-8",
		);

		const outputDir = join(record, "inception", STAGE);
		mkdirSync(outputDir, { recursive: true });
		const outputPath = join(outputDir, "requirements.md");
		const detailDir = join(record, ".aidlc-engine", "sensors", STAGE);

		const fire = (): { result: string; detailFiles: string[] } => {
			const res = spawnSync(
				"bun",
				[
					DISPATCHER,
					"fire",
					"required-sections",
					"--stage",
					STAGE,
					"--output-path",
					outputPath,
				],
				{
					encoding: "utf-8",
					cwd: proj,
					env: {
						...process.env,
						CLAUDE_PROJECT_DIR: proj,
						AIDLC_STAGE_GRAPH: FRAMEWORK_GRAPH,
					},
				},
			);
			// A sensor outcome is advisory: the dispatcher always exits 0 and
			// prints one JSON verdict line.
			expect(res.status).toBe(0);
			const verdict = JSON.parse((res.stdout || "").trim().split("\n").pop() ?? "{}");
			const detailFiles = readdirSync(detailDir, { withFileTypes: true })
				.filter((e) => e.isFile())
				.map((e) => e.name)
				.sort();
			return { result: verdict.result, detailFiles };
		};

		writeFileSync(outputPath, ONE_H2, "utf-8");
		const failed = fire();
		expect(failed.result).toBe("failed");
		expect(failed.detailFiles).toHaveLength(1);
		expect(failed.detailFiles[0]).toMatch(/^required-sections-[0-9a-f]{8}\.md$/);

		writeFileSync(outputPath, THREE_H2, "utf-8");
		const passed = fire();
		expect(passed.result).toBe("passed");
		// Before this guard the failure's report was still here.
		expect(passed.detailFiles).toEqual([]);
	});
});
