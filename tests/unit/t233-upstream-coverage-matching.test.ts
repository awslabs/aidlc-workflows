// covers: subcommand:aidlc-sensor-upstream-coverage
//
// t233 - upstream-coverage matching accuracy: the citation forms the
// framework's artifacts actually use, evaluated over the stage's
// deliverable union rather than the single fired file.
//
// The shipped check used to be a per-file `\b<slug>\b | [[<slug>]]` grep
// against the one fired file. Two structural mismatches with the
// framework's authoring conventions made its failures mostly false:
//   1. Artifacts cite upstream by producing-stage DIRECTORY path in their
//      provenance header (`construction/<unit>/nfr-requirements/`), never
//      re-naming each slug - so `\bperformance-requirements\b` missed a
//      legitimately-cited upstream.
//   2. A multi-artifact stage splits its citations across sibling
//      deliverables (business-rules.md cites the domain model;
//      tech-stack-decisions.md has no reason to) - so every file that
//      legitimately omits an upstream failed the full consumes set.
// And one latent false POSITIVE: `\b` treats `-` as a boundary, so the
// consume `requirements` matched INSIDE the token `nfr-requirements`.
//
// This file pins the corrected contract at the PROCESS boundary - it
// spawns the real per-sensor script (aidlc-sensor-upstream-coverage.ts)
// via spawnSync from the SHIPPED tree (AIDLC_SRC), the same boundary t155
// uses for required-sections - passing the dispatcher-threaded flags
// (--consumes with `artifact:producer` pairs, --deliverables with the
// stage's scaffolding-filtered produces union) directly. Asserted
// properties:
//
//   1. Producer-directory citation covers every artifact of that stage
//      (leading `producer/` and trailing `.../producer` segment forms).
//   2. Sibling-union evaluation: a citation in one deliverable covers the
//      consume for a fire on a different deliverable.
//   3. Scaffolding never counts: a slug appearing only in the fired
//      `*-questions.md` (or memory.md) does not satisfy coverage, and the
//      union excludes those files.
//   4. Hyphen-substring false positive killed: `requirements` inside
//      `nfr-requirements` (token or directory form) is NOT a reference.
//   5. Back-compat: bare-slug --consumes without --deliverables keeps the
//      old per-file semantics; bare slug, wikilink, and backticked
//      `<slug>.md` forms all still match; `--consumes ""` keeps the
//      "no upstream" early return.
//   6. Vacuous fire: --deliverables named but none on disk yet (the
//      questions-file-first write order) -> pass with reason, not a false
//      SENSOR_FAILED against an empty body.
//
// Mechanism: cli (spawnSync of the bun script). No LLM, no tokens -
// byte-reproducible.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor-upstream-coverage.ts");

const tempDirs: string[] = [];
afterAll(() => {
	for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

interface SensorResult {
	pass: boolean;
	consumes: string[];
	unreferenced: string[];
	scanned_files: string[];
	reason?: string;
	findings_count: number;
}

/** Fresh stage dir seeded with the given files (name -> body). */
function makeStageDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "aidlc-t233-"));
	tempDirs.push(dir);
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(dir, name), body, "utf-8");
	}
	return dir;
}

/** Spawn the real sensor script; parse its stdout JSON. */
function run(
	dir: string,
	outputName: string,
	consumes: string,
	deliverables?: string,
): SensorResult {
	const args = [
		SENSOR,
		"--stage",
		"t233-stage",
		"--output-path",
		join(dir, outputName),
		"--consumes",
		consumes,
	];
	if (deliverables !== undefined) args.push("--deliverables", deliverables);
	const res = spawnSync(BUN, args, { encoding: "utf-8" });
	expect(res.status).toBe(0);
	return JSON.parse(res.stdout) as SensorResult;
}

describe("t233 producer-directory citation (fix A)", () => {
	test("1: provenance header citing `nfr-requirements/` covers all artifacts that stage produces", () => {
		// The representative shape from a real nfr-design output: a basis/
		// trace header naming the producing-stage directory once, no bare
		// slug anywhere.
		const dir = makeStageDir({
			"performance-design.md": [
				"# Performance Design",
				"",
				"basis/trace: `construction/api-service/nfr-requirements/`,",
				"`decisions.md`",
				"",
				"## Design",
				"Content.",
				"",
			].join("\n"),
		});
		const r = run(
			dir,
			"performance-design.md",
			"performance-requirements:nfr-requirements,security-requirements:nfr-requirements,scalability-requirements:nfr-requirements,reliability-requirements:nfr-requirements",
			"performance-design",
		);
		expect(r.pass).toBe(true);
		expect(r.unreferenced).toEqual([]);
		expect(r.findings_count).toBe(0);
	});

	test("2: trailing path-segment form (`see ../nfr-requirements`) also counts", () => {
		const dir = makeStageDir({
			"doc.md": "# Doc\n\nSee ../nfr-requirements for the baseline.\n",
		});
		const r = run(
			dir,
			"doc.md",
			"performance-requirements:nfr-requirements",
			"doc",
		);
		expect(r.pass).toBe(true);
	});

	test("3: a LONGER slug containing the producer as a suffix does not count", () => {
		const dir = makeStageDir({
			"doc.md": "# Doc\n\nSee some-nfr-requirements/ for something else.\n",
		});
		const r = run(
			dir,
			"doc.md",
			"performance-requirements:nfr-requirements",
			"doc",
		);
		expect(r.pass).toBe(false);
		expect(r.unreferenced).toEqual(["performance-requirements"]);
	});

	test("4: producer named as a bare token (no path segment) does not count", () => {
		// The producer alternative is a DIRECTORY-citation match, not a
		// second slug match: prose merely mentioning the stage name without
		// a path form stays uncovered.
		const dir = makeStageDir({
			"doc.md": "# Doc\n\nWe did this after nfr-requirements finished.\n",
		});
		const r = run(
			dir,
			"doc.md",
			"performance-requirements:nfr-requirements",
			"doc",
		);
		expect(r.pass).toBe(false);
	});
});

describe("t233 sibling-union evaluation (fix B)", () => {
	test("5: citation in a sibling deliverable covers a fire on a file that omits it", () => {
		// nfr-requirements shape: business-rules.md cites the domain model,
		// tech-stack-decisions.md legitimately does not.
		const dir = makeStageDir({
			"business-rules.md":
				"# Business Rules\n\nDerived from `business-logic-model.md`.\n\n## Rules\nContent.\n",
			"tech-stack-decisions.md":
				"# Tech Stack\n\n## Decisions\nStack content, no domain-model mention.\n",
		});
		const r = run(
			dir,
			"tech-stack-decisions.md",
			"business-logic-model:functional-design",
			"business-rules,tech-stack-decisions",
		);
		expect(r.pass).toBe(true);
		// Both deliverables were scanned.
		expect(r.scanned_files.length).toBe(2);
	});

	test("6: consume referenced in NO deliverable still fails (signal survives)", () => {
		const dir = makeStageDir({
			"business-rules.md": "# Business Rules\n\n## Rules\nContent.\n",
			"tech-stack-decisions.md": "# Tech Stack\n\n## Decisions\nContent.\n",
		});
		const r = run(
			dir,
			"tech-stack-decisions.md",
			"business-logic-model:functional-design",
			"business-rules,tech-stack-decisions",
		);
		expect(r.pass).toBe(false);
		expect(r.unreferenced).toEqual(["business-logic-model"]);
		expect(r.findings_count).toBe(1);
	});

	test("7: every fire in the stage converges on the same stage-level verdict", () => {
		const dir = makeStageDir({
			"business-rules.md":
				"# Business Rules\n\nDerived from `business-logic-model.md`.\n",
			"tech-stack-decisions.md": "# Tech Stack\n\nContent.\n",
		});
		const consumes = "business-logic-model:functional-design";
		const deliverables = "business-rules,tech-stack-decisions";
		const a = run(dir, "business-rules.md", consumes, deliverables);
		const b = run(dir, "tech-stack-decisions.md", consumes, deliverables);
		expect(a.pass).toBe(true);
		expect(b.pass).toBe(true);
		expect(a.scanned_files).toEqual(b.scanned_files);
	});
});

describe("t233 scaffolding exclusion", () => {
	test("8: slug appearing ONLY in the fired *-questions.md does not count", () => {
		// The caveat from the union design: without this exclusion a slug in
		// the Q&A file would trade the false negative for a false positive.
		const dir = makeStageDir({
			"t233-stage-questions.md":
				"# Questions\n\nQ: does business-logic-model matter? A: yes.\n",
			"tech-stack-decisions.md": "# Tech Stack\n\nContent.\n",
		});
		const r = run(
			dir,
			"t233-stage-questions.md",
			"business-logic-model:functional-design",
			"tech-stack-decisions",
		);
		expect(r.pass).toBe(false);
		expect(r.unreferenced).toEqual(["business-logic-model"]);
		// The fired scaffolding file itself was not part of the union.
		expect(r.scanned_files.length).toBe(1);
		expect(r.scanned_files[0].endsWith("tech-stack-decisions.md")).toBe(true);
	});

	test("9: fired memory.md is excluded the same way", () => {
		const dir = makeStageDir({
			"memory.md": "# Memory\n\nUsed business-logic-model heavily today.\n",
			"tech-stack-decisions.md": "# Tech Stack\n\nContent.\n",
		});
		const r = run(
			dir,
			"memory.md",
			"business-logic-model:functional-design",
			"tech-stack-decisions",
		);
		expect(r.pass).toBe(false);
		expect(r.scanned_files.length).toBe(1);
	});

	test("10: scaffolding fired before any deliverable exists -> vacuous pass with reason", () => {
		const dir = makeStageDir({
			"t233-stage-questions.md": "# Questions\n\nQ: anything? A: yes.\n",
		});
		const r = run(
			dir,
			"t233-stage-questions.md",
			"business-logic-model:functional-design",
			"tech-stack-decisions",
		);
		expect(r.pass).toBe(true);
		expect(r.reason).toBe("no deliverables on disk yet");
		expect(r.scanned_files).toEqual([]);
		expect(r.findings_count).toBe(0);
	});
});

describe("t233 hyphen-substring false positive killed", () => {
	test("11: `requirements` inside the token `nfr-requirements` is NOT a reference", () => {
		// \b treats `-` as a word boundary, so the shipped regex matched the
		// consume `requirements` inside `nfr-requirements` - a file naming
		// its own stage directory falsely covered the consume.
		const dir = makeStageDir({
			"doc.md": "# Doc\n\nMentions nfr-requirements/ and nothing else.\n",
		});
		const r = run(dir, "doc.md", "requirements:requirements-analysis", "doc");
		expect(r.pass).toBe(false);
		expect(r.unreferenced).toEqual(["requirements"]);
	});

	test("12: the standalone token still matches", () => {
		const dir = makeStageDir({
			"doc.md": "# Doc\n\nPer the requirements baseline.\n",
		});
		const r = run(dir, "doc.md", "requirements:requirements-analysis", "doc");
		expect(r.pass).toBe(true);
	});
});

describe("t233 back-compat forms", () => {
	test("13: bare-slug --consumes without --deliverables keeps per-file semantics", () => {
		const dir = makeStageDir({
			"a.md": "# A\n\nCites intent-statement directly.\n",
			"b.md": "# B\n\nNo citation.\n",
		});
		// a.md passes on its own body; b.md fails on its own body - the
		// sibling is NOT consulted without --deliverables.
		expect(run(dir, "a.md", "intent-statement").pass).toBe(true);
		const rb = run(dir, "b.md", "intent-statement");
		expect(rb.pass).toBe(false);
		expect(rb.scanned_files.length).toBe(1);
	});

	test("14: wikilink and backticked-filename forms still match", () => {
		const dir = makeStageDir({
			"wiki.md": "# W\n\nBased on [[intent-statement]].\n",
			"tick.md": "# T\n\nBased on `intent-statement.md`.\n",
		});
		expect(run(dir, "wiki.md", "intent-statement").pass).toBe(true);
		expect(run(dir, "tick.md", "intent-statement").pass).toBe(true);
	});

	test("15: --consumes \"\" keeps the no-upstream early return", () => {
		const dir = makeStageDir({ "a.md": "# A\n\nBody.\n" });
		const r = run(dir, "a.md", "");
		expect(r.pass).toBe(true);
		expect(r.reason).toBe("no upstream");
		expect(r.consumes).toEqual([]);
	});

	test("16: matching is case-insensitive as before", () => {
		const dir = makeStageDir({
			"a.md": "# A\n\nSee Intent-Statement for context.\n",
		});
		expect(run(dir, "a.md", "intent-statement").pass).toBe(true);
	});
});
