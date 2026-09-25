// covers: tool:aidlc-sensor
//
// t345 - a verified passing sensor fire clears the earlier failure reports for
// the same output, and nothing else.
//
// The dispatcher names each detail file `<id>-<fireId>.md` (`detailPath` in
// handleFire) and writes it only on a FAILED outcome. The fire id is fresh per
// fire (generateFireId), so a later fire never overwrites an earlier file, and
// before this guard the dispatcher had no removal path at all: once a sensor
// failed and then passed, the stage's sensors/ directory still showed a failure
// that no longer existed.
//
// pruneSupersededDetailFiles carries three scoping rules, and each is a
// contract rather than incidental behaviour:
//   - it matches only `<sensorId>-<8 hex>.md`, so a sibling sensor sharing the
//     stage directory is untouched, and an id that merely prefixes another id
//     does not capture it;
//   - it removes only a report whose recorded `**Output path**` is the passing
//     fire's output. The gate fires one sensor across every declared artifact of
//     a stage and quotes each failure's detail path in its refusal, so a pass on
//     one artifact must not delete another artifact's live report;
//   - it removes only files last modified BEFORE the fire began, so an
//     overlapping fire's report survives.
// The dispatcher calls it only on a verified pass. A noted pass (tool-unavailable,
// script-error) or a budget override evaluated nothing, so it supersedes nothing.
//
// Mechanism: cli - this file carries both halves of the contract. The helper
// cases exercise pruneSupersededDetailFiles in-process against a temp
// directory. The behavioural cases spawn the real dispatcher through bun and
// assert on the bytes left on disk, which is the only way to observe which
// fires clear which reports. The header declares the stronger of the two
// mechanisms, so the coverage registry is not under-claimed. The `tool:` covers
// id is a documentation annotation, matching t251's and t237's convention.
//
// The behavioural cases drive the real `required-sections` sensor rather than a
// stub: it fails on fewer than two H2 headings, so rewriting an output file
// between fires produces a genuine FAILED -> PASSED pair. The noted-pass case
// swaps in a stub script through the AIDLC_SENSOR_SCRIPT_DIR seam for its
// second fire only. The stage graph comes from AIDLC_SRC (the generated dist
// tree) through the AIDLC_STAGE_GRAPH seam, exactly as t94 does.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
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

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

// Write a detail file shaped like buildDetailBody's header and stamp its mtime,
// so "before this fire" is explicit rather than dependent on how fast the test
// runs. A null outputPath writes a report with no recorded output.
function writeDetail(
	dir: string,
	name: string,
	ageSeconds: number,
	outputPath: string | null,
): string {
	const path = join(dir, name);
	const header =
		outputPath === null
			? ""
			: `**Fire id**: 00000000\n**Output path**: ${outputPath}\n**Pass**: false\n\n`;
	writeFileSync(path, `# finding\n\n${header}## Findings\n`, "utf-8");
	const when = new Date(Date.now() - ageSeconds * 1000);
	utimesSync(path, when, when);
	return path;
}

let stageDir: string;
let outputA: string;
let outputB: string;

beforeEach(() => {
	stageDir = makeTempDir("t345-sensors-");
	const outputs = makeTempDir("t345-outputs-");
	outputA = join(outputs, "requirements.md");
	outputB = join(outputs, "stories.md");
	writeFileSync(outputA, "# A\n", "utf-8");
	writeFileSync(outputB, "# B\n", "utf-8");
});

afterAll(() => {
	// Best-effort cleanup; a leftover temp dir must not fail the suite.
	for (const dir of tempRoots) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("t345 superseded sensor detail files are pruned", () => {
	test("an earlier failure's report for the same output is removed", () => {
		writeDetail(stageDir, "linter-aaaaaaaa.md", 60, outputA);

		const removed = pruneSupersededDetailFiles(stageDir, "linter", outputA, Date.now());

		expect(removed).toBe(1);
		expect(readdirSync(stageDir)).toEqual([]);
	});

	test("another output's live report in the same stage is kept", () => {
		// The gate fires one sensor across every declared artifact of a stage.
		// A pass on B says nothing about A, whose report the refusal still names.
		writeDetail(stageDir, "linter-aaaaaaaa.md", 60, outputA);
		writeDetail(stageDir, "linter-bbbbbbbb.md", 60, outputB);

		const removed = pruneSupersededDetailFiles(stageDir, "linter", outputB, Date.now());

		expect(removed).toBe(1);
		expect(readdirSync(stageDir)).toEqual(["linter-aaaaaaaa.md"]);
	});

	test("a sibling sensor's report in the same stage directory is untouched", () => {
		writeDetail(stageDir, "linter-dddddddd.md", 60, outputA);
		writeDetail(stageDir, "traceability-eeeeeeee.md", 60, outputA);

		const removed = pruneSupersededDetailFiles(stageDir, "linter", outputA, Date.now());

		expect(removed).toBe(1);
		expect(readdirSync(stageDir)).toEqual(["traceability-eeeeeeee.md"]);
	});

	test("an id that only prefixes another sensor's id does not capture it", () => {
		// `linter` must not match `linter-extra`: the fire-id shape is exact, so
		// `linter-extra-<hex>.md` is not a `linter` detail file.
		writeDetail(stageDir, "linter-extra-11111111.md", 60, outputA);

		const removed = pruneSupersededDetailFiles(stageDir, "linter", outputA, Date.now());

		expect(removed).toBe(0);
		expect(readdirSync(stageDir)).toEqual(["linter-extra-11111111.md"]);
	});

	test("an overlapping fire's newer report survives the mtime cutoff", () => {
		// A file written after this fire began belongs to another fire.
		const cutoff = Date.now() - 30_000;
		writeDetail(stageDir, "linter-33333333.md", 0, outputA);

		const removed = pruneSupersededDetailFiles(stageDir, "linter", outputA, cutoff);

		expect(removed).toBe(0);
		expect(readdirSync(stageDir)).toEqual(["linter-33333333.md"]);
	});

	test("a non-detail file is never removed", () => {
		writeDetail(stageDir, "notes.md", 60, outputA);
		writeDetail(stageDir, "linter-55555555.md.tmp", 60, outputA);

		const removed = pruneSupersededDetailFiles(stageDir, "linter", outputA, Date.now());

		expect(removed).toBe(0);
		expect(readdirSync(stageDir).sort()).toEqual([
			"linter-55555555.md.tmp",
			"notes.md",
		]);
	});

	test("a report with no recorded output path is kept", () => {
		writeDetail(stageDir, "linter-66666666.md", 60, null);

		const removed = pruneSupersededDetailFiles(stageDir, "linter", outputA, Date.now());

		expect(removed).toBe(0);
		expect(readdirSync(stageDir)).toEqual(["linter-66666666.md"]);
	});

	test.skipIf(process.platform === "win32")(
		"a report recorded through a symlinked path matches the real output path",
		() => {
			// A write hook records the path as written; the gate passes real paths.
			const linked = join(makeTempDir("t345-link-"), "outputs");
			symlinkSync(join(outputA, ".."), linked);
			writeDetail(stageDir, "linter-77777777.md", 60, join(linked, "requirements.md"));

			const removed = pruneSupersededDetailFiles(stageDir, "linter", outputA, Date.now());

			expect(removed).toBe(1);
			expect(readdirSync(stageDir)).toEqual([]);
		},
	);

	test("a Windows spelling that differs only in separators and drive case matches", () => {
		// Kiro IDE hands the write hook a lowercase drive letter (#1201). Neither
		// path exists here, so both sides take the raw-spelling fallback.
		writeDetail(stageDir, "linter-88888888.md", 60, "c:\\proj\\record\\requirements.md");

		const removed = pruneSupersededDetailFiles(
			stageDir,
			"linter",
			"C:/proj/record/requirements.md",
			Date.now(),
		);

		expect(removed).toBe(1);
		expect(readdirSync(stageDir)).toEqual([]);
	});

	test("a missing stage directory is not an error", () => {
		const absent = join(stageDir, "does-not-exist");

		expect(pruneSupersededDetailFiles(absent, "linter", outputA, Date.now())).toBe(0);
	});
});

// The behavioural half: the same contract observed through the real dispatcher.
// The helper cases above pin the prune's rules; these prove the dispatcher
// applies them, which is the defect #1087 reports.
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc-sensor.ts");
const FRAMEWORK_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const STAGE = "requirements-analysis";

// required-sections fails below two H2 headings, so the same output file
// rewritten between fires yields a real FAILED then a real PASSED.
const ONE_H2 = "# Title\n\n## Only One\n\nbody\n";
const THREE_H2 = "# Title\n\n## One\n\na\n\n## Two\n\nb\n\n## Three\n\nc\n";

interface Fire {
	result: string;
	note?: string;
	detailFiles: string[];
}

const projects: string[] = [];

function setupProject(): {
	outputDir: string;
	fire: (outputPath: string, env?: Record<string, string>) => Fire;
} {
	const proj = createTestProject();
	projects.push(proj);
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
	const detailDir = join(record, ".aidlc-engine", "sensors", STAGE);

	const fire = (outputPath: string, env: Record<string, string> = {}): Fire => {
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
					...env,
				},
			},
		);
		// A sensor outcome is advisory: the dispatcher always exits 0 and
		// prints one JSON verdict line.
		expect(res.status).toBe(0);
		const verdict = JSON.parse((res.stdout || "").trim().split("\n").pop() ?? "{}");
		const detailFiles = existsSync(detailDir)
			? readdirSync(detailDir, { withFileTypes: true })
					.filter((e) => e.isFile())
					.map((e) => e.name)
					.sort()
			: [];
		return { result: verdict.result, note: verdict.note, detailFiles };
	};

	return { outputDir, fire };
}

describe("t345 the dispatcher clears a superseded detail file on a passing fire", () => {
	afterAll(() => {
		for (const proj of projects) cleanupTestProject(proj);
	});

	test("a FAILED fire writes a detail file and the next PASSED fire removes it", () => {
		const { outputDir, fire } = setupProject();
		const outputPath = join(outputDir, "requirements.md");

		writeFileSync(outputPath, ONE_H2, "utf-8");
		const failed = fire(outputPath);
		expect(failed.result).toBe("failed");
		expect(failed.detailFiles).toHaveLength(1);
		expect(failed.detailFiles[0]).toMatch(/^required-sections-[0-9a-f]{8}\.md$/);

		writeFileSync(outputPath, THREE_H2, "utf-8");
		const passed = fire(outputPath);
		expect(passed.result).toBe("passed");
		expect(passed.note).toBeUndefined();
		// Before this guard the failure's report was still here.
		expect(passed.detailFiles).toEqual([]);
	});

	test("a PASSED fire on another output of the stage keeps the failing output's report", () => {
		const { outputDir, fire } = setupProject();
		const failing = join(outputDir, "requirements.md");
		const passing = join(outputDir, "requirement-verification-questions.md");
		writeFileSync(failing, ONE_H2, "utf-8");
		writeFileSync(passing, THREE_H2, "utf-8");

		const failed = fire(failing);
		expect(failed.result).toBe("failed");
		expect(failed.detailFiles).toHaveLength(1);

		const passed = fire(passing);
		expect(passed.result).toBe("passed");
		// The failing output was not re-evaluated, so its report is still live.
		expect(passed.detailFiles).toEqual(failed.detailFiles);
	});

	test("a noted pass that evaluated nothing keeps the earlier report", () => {
		const { outputDir, fire } = setupProject();
		const outputPath = join(outputDir, "requirements.md");
		writeFileSync(outputPath, ONE_H2, "utf-8");

		const failed = fire(outputPath);
		expect(failed.result).toBe("failed");
		expect(failed.detailFiles).toHaveLength(1);

		// A crashing script degrades to `passed` with a script-error note.
		const scripts = makeTempDir("t345-scripts-");
		writeFileSync(
			join(scripts, "aidlc-sensor-required-sections.ts"),
			"process.exit(3);\n",
			"utf-8",
		);
		writeFileSync(outputPath, THREE_H2, "utf-8");
		const noted = fire(outputPath, { AIDLC_SENSOR_SCRIPT_DIR: scripts });
		expect(noted.result).toBe("passed");
		expect(noted.note).toBe("script-error: exit-3");
		expect(noted.detailFiles).toEqual(failed.detailFiles);
	});
});
