import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { errorMessage } from "./aidlc-lib.ts";

interface Result {
	pass: boolean;
	consumes: string[];
	unreferenced: string[];
	scanned_files: string[];
	reason?: string;
	findings_count: number;
}

interface Consume {
	slug: string;
	producer?: string;
}

interface Flags {
	stage?: string;
	outputPath?: string;
	consumes?: string;
	consumesPresent: boolean;
	deliverables?: string;
}

function parseFlags(argv: string[]): Flags {
	const out: Flags = { consumesPresent: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--stage") {
			out.stage = argv[++i];
		} else if (arg === "--output-path") {
			out.outputPath = argv[++i];
		} else if (arg === "--consumes") {
			out.consumesPresent = true;
			// Handle `--consumes` as last flag (no value) and `--consumes ""`
			// identically: treat both as empty list.
			out.consumes = argv[++i] ?? "";
		} else if (arg === "--deliverables") {
			out.deliverables = argv[++i] ?? "";
		}
	}
	return out;
}

function fail(msg: string): never {
	process.stderr.write(`aidlc-sensor-upstream-coverage: ${msg}\n`);
	process.exit(1);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A slug reference counts only when the slug is not embedded in a longer
// kebab token: `requirements` must NOT match inside `nfr-requirements`.
// \b treats `-` as a boundary, so the anchors here are lookarounds that
// exclude word chars AND hyphens. Backticked filenames (`<slug>.md`) and
// wikilinks ([[<slug>]]) still match: backtick, `[`, `.`, `]` are all
// outside [\w-]. The explicit wikilink alternative is kept for contract
// clarity even though the anchored form subsumes it.
function slugPattern(slug: string): RegExp {
	const e = escapeRegex(slug);
	return new RegExp(`(?<![\\w-])${e}(?![\\w-])|\\[\\[${e}\\]\\]`, "i");
}

// A producing-stage directory citation counts as coverage for every
// artifact that stage produces: artifacts cite upstream by provenance
// path (`construction/<unit>/nfr-requirements/`), not by re-naming each
// slug. The producer slug must appear as a whole path segment - leading
// (`nfr-requirements/`) or trailing (`.../nfr-requirements`) - so a
// longer sibling slug (`some-nfr-requirements/`) never satisfies it.
function producerDirPattern(producer: string): RegExp {
	const e = escapeRegex(producer);
	return new RegExp(`(?<![\\w-])${e}(?=/)|(?<=/)${e}(?![\\w-])`, "i");
}

// Consume entries arrive as `artifact` or `artifact:producer-stage`. The
// bare form stays valid (direct invocations, older dispatchers): it just
// gets no producer-directory alternative.
function parseConsume(entry: string): Consume {
	const idx = entry.indexOf(":");
	if (idx === -1) return { slug: entry };
	const slug = entry.slice(0, idx).trim();
	const producer = entry.slice(idx + 1).trim();
	return producer.length > 0 ? { slug, producer } : { slug };
}

function main(): void {
	const flags = parseFlags(process.argv.slice(2));

	if (!flags.outputPath) {
		fail("--output-path is required");
	}
	if (!existsSync(flags.outputPath)) {
		fail(`--output-path not found: ${flags.outputPath}`);
	}

	// Split, trim, drop empties. Both `--consumes ""` and an absent flag
	// collapse to consumes = [], which triggers the "no upstream" early
	// return below.
	const rawConsumes = flags.consumes ?? "";
	const consumes = rawConsumes
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map(parseConsume)
		.filter((c) => c.slug.length > 0);

	if (consumes.length === 0) {
		const result: Result = {
			pass: true,
			consumes: [],
			unreferenced: [],
			scanned_files: [],
			reason: "no upstream",
			findings_count: 0,
		};
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exit(0);
	}

	// Coverage is a property of the STAGE's output, not of each file: a
	// multi-artifact stage legitimately splits its upstream citations
	// across sibling deliverables (business-rules.md cites the domain
	// model; tech-stack-decisions.md has no reason to). So when the
	// dispatcher threads --deliverables (the stage's produces union,
	// already filtered of `*-questions`/`*-timestamp` scaffolding), the
	// body under test is the union of those files in the fired file's
	// directory, plus the fired file itself UNLESS it is scaffolding:
	// the fire hook also fires on memory.md / `*-questions.md` writes,
	// and a slug that appears only in the Q&A or the builder's diary is
	// not upstream coverage. Every fire within a stage thus converges on
	// the same stage-level verdict. Without --deliverables (direct
	// invocation, older dispatcher) only the fired file is read, as
	// before.
	const firedPath = resolve(flags.outputPath);
	const dir = dirname(firedPath);
	const deliverables = (flags.deliverables ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const firedBase = basename(firedPath);
	const firedIsScaffolding =
		firedBase === "memory.md" ||
		firedBase.endsWith("-questions.md") ||
		firedBase.endsWith("-timestamp.md");

	const scanPaths: string[] = [];
	if (deliverables.length === 0) {
		scanPaths.push(firedPath);
	} else {
		for (const stem of deliverables) {
			const p = resolve(join(dir, `${stem}.md`));
			if (existsSync(p)) scanPaths.push(p);
		}
		if (!firedIsScaffolding && !scanPaths.includes(firedPath)) {
			scanPaths.push(firedPath);
		}
	}

	let body = "";
	const scannedFiles: string[] = [];
	for (const p of scanPaths) {
		try {
			body += `\n${readFileSync(p, "utf-8")}`;
			scannedFiles.push(p);
		} catch (err) {
			if (p === firedPath) {
				fail(`failed to read --output-path ${p}: ${errorMessage(err)}`);
			}
			// Unreadable sibling: skip - coverage falls back to what is
			// readable rather than erroring the whole fire.
		}
	}

	// A scaffolding write can fire before any deliverable exists (stages
	// write their questions file first). With nothing to evaluate, the
	// check is vacuous - pass with a reason, mirroring "no upstream" -
	// rather than reporting every consume unreferenced against an empty
	// set. The stage's later deliverable writes re-fire and evaluate for
	// real.
	if (scannedFiles.length === 0) {
		const result: Result = {
			pass: true,
			consumes: consumes.map((c) => c.slug),
			unreferenced: [],
			scanned_files: [],
			reason: "no deliverables on disk yet",
			findings_count: 0,
		};
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exit(0);
	}

	// A consume is covered when the union body references it in any form
	// the framework's artifacts actually use: the bare slug (anchored so
	// longer kebab tokens don't false-positive), a wikilink, or the
	// producing stage's directory as a path segment.
	const unreferenced: string[] = [];
	for (const c of consumes) {
		const covered =
			slugPattern(c.slug).test(body) ||
			(c.producer !== undefined && producerDirPattern(c.producer).test(body));
		if (!covered) {
			unreferenced.push(c.slug);
		}
	}

	const result: Result = {
		pass: unreferenced.length === 0,
		consumes: consumes.map((c) => c.slug),
		unreferenced,
		scanned_files: scannedFiles,
		// findings_count emitted by the script (sensor-id-agnostic dispatcher).
		findings_count: unreferenced.length,
	};
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(0);
}

main();
