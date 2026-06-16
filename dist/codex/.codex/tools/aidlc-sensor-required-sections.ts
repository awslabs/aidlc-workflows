import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { errorMessage, parseBoltDag } from "./aidlc-lib.ts";

interface Result {
	pass: boolean;
	h2_count: number;
	headings: string[];
	findings_count: number;
	// Populated only when the output is unit-of-work-dependency.md: the
	// machine-readable edge block units-generation (2.7) must carry beside its
	// prose. "ok" once a valid acyclic block parses; the failure reasons mirror
	// parseBoltDag so a malformed or cyclic DAG fails loud at the 2.7 gate,
	// upstream of the runtime compiler that reads the same block.
	edge_block?: "ok" | "absent" | "malformed" | "cyclic";
	// Populated only when a team/framework template resolves for this output
	// (TPL — template-override layer). "applied" once the template's `##`
	// heading set becomes the expected set this output is verified against;
	// "ineligible" when a template file resolves but the artifact is NOT in the
	// dispatcher-threaded eligible set (a questions/timestamp marker), so the
	// template is ignored and a config warning is emitted instead. Absent when
	// no template resolves — the output keeps the generic ≥2-H2 floor.
	template?: "applied" | "ineligible";
	// The template's expected `##` heading set (only when template === "applied").
	template_expected?: string[];
	// Sections the template requires that the output is missing (the precise
	// findings — only when template === "applied").
	template_missing?: string[];
	// Advisory config warning when a template file resolves for an artifact the
	// stage does not declare template-eligible (the stem==artifact key is
	// unsound for questions/timestamp markers). Surfaced, not fatal.
	config_warning?: string;
}

interface Flags {
	stage?: string;
	outputPath?: string;
	// Absolute path to the templates source-of-truth dir
	// (aidlc/memory/templates/). Threaded by the dispatcher / fire hook, which
	// hold projectDir; the script never resolves projectDir itself. Absent →
	// no template lookup (graceful third branch: P5/SEED has not shipped the
	// dir, or the caller is a bare invocation).
	templatesDir?: string;
	// Comma-joined set of artifact NAMES (output-filename stems) this stage
	// declares template-eligible — the `produces` entries that are NOT
	// questions/timestamp markers. Threaded from the dispatcher, which holds the
	// stageNode (the per-sensor script has no graph access). A resolved template
	// applies ONLY when basename(outputPath) stem ∈ this set; otherwise it is
	// ignored + a config warning emitted. Absent/empty → no artifact is eligible.
	templateEligible?: string[];
}

function parseFlags(argv: string[]): Flags {
	const out: Flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--stage") {
			out.stage = argv[++i];
		} else if (arg === "--output-path") {
			out.outputPath = argv[++i];
		} else if (arg === "--templates-dir") {
			out.templatesDir = argv[++i];
		} else if (arg === "--template-eligible") {
			out.templateEligible = (argv[++i] ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
		}
	}
	return out;
}

// Parse the distinct, ordered `^## ` headings of a markdown body (trimmed,
// deduped by exact text). Shared by the output scan and the template scan so
// the produced shape and the checked shape are compared on identical terms.
function parseH2Headings(body: string): string[] {
	const seen = new Set<string>();
	const headings: string[] = [];
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith("## ")) continue;
		if (seen.has(line)) continue;
		seen.add(line);
		headings.push(line);
	}
	return headings;
}

function fail(msg: string): never {
	process.stderr.write(`aidlc-sensor-required-sections: ${msg}\n`);
	process.exit(1);
}

function main(): void {
	const flags = parseFlags(process.argv.slice(2));

	if (!flags.outputPath) {
		fail("--output-path is required");
	}
	if (!existsSync(flags.outputPath)) {
		fail(`--output-path not found: ${flags.outputPath}`);
	}

	let body: string;
	try {
		body = readFileSync(flags.outputPath, "utf-8");
	} catch (err) {
		fail(
			`failed to read --output-path ${flags.outputPath}: ${errorMessage(err)}`,
		);
	}

	// Count distinct ^## headings. Strip leading/trailing whitespace per
	// line, dedupe by exact (trimmed) text. `^## ` requires literal "## "
	// (two hashes + space); `### Foo`.startsWith("## ") is false because
	// char[2] is '#', not ' ', so deeper headings are excluded.
	const headings = parseH2Headings(body);

	const h2_count = headings.length;
	let pass = h2_count >= 2;
	// findings_count derivation per locked plan: max(0, 2 - h2_count).
	// Emitted by the script (not the dispatcher) per the v3 control-
	// plane / data-plane separation: per-sensor scripts own their own
	// findings derivation; the dispatcher reads out.findings_count
	// generically and is sensor-id-agnostic.
	let findings_count = Math.max(0, 2 - h2_count);
	const result: Result = { pass, h2_count, headings, findings_count };

	// Template-override branch (TPL — template-override layer). When a
	// team/framework template resolves for this output, its `##` heading set
	// REPLACES the generic ≥2-H2 floor: pass iff every template heading is
	// present in the output (expected ⊆ output); the missing ones are precise
	// findings. Whole-doc, no merge. No LLM — byte-reproducible.
	//
	// Resolution = strip(".md", basename(outputPath)) → <templates-dir>/<stem>.md.
	// The artifact name IS the output filename stem (the X→X.md convention;
	// resolveArtifactPath builds `<...>/${name}.md`, aidlc-orchestrate.ts:649).
	//
	// ELIGIBILITY GATE (required, not optional): the stem==artifact key is
	// unsound for questions/timestamp markers (a `*-questions.md` Q&A file is
	// intentionally not ≥2-H2). The per-sensor script cannot know the stage's
	// artifact set, so the dispatcher threads --template-eligible. A resolved
	// template applies ONLY when the stem ∈ that set; otherwise it is ignored
	// and an advisory config warning is emitted (the output keeps its floor).
	const stem = basename(flags.outputPath).replace(/\.md$/, "");
	if (flags.templatesDir) {
		const templatePath = join(flags.templatesDir, `${stem}.md`);
		if (existsSync(templatePath)) {
			const eligible = (flags.templateEligible ?? []).includes(stem);
			if (!eligible) {
				// Template resolves but the artifact is not declared eligible —
				// ignore it (keep the floor) + surface a config warning.
				result.template = "ineligible";
				result.config_warning =
					`template ${stem}.md resolved but artifact "${stem}" is not ` +
					`template-eligible for stage "${flags.stage ?? "?"}" ` +
					`(questions/timestamp markers are excluded); template ignored, ` +
					`keeping the generic >=2-H2 floor.`;
			} else {
				let templateBody: string;
				try {
					templateBody = readFileSync(templatePath, "utf-8");
				} catch (err) {
					fail(
						`failed to read template ${templatePath}: ${errorMessage(err)}`,
					);
				}
				const expected = parseH2Headings(templateBody);
				const present = new Set(headings);
				const missing = expected.filter((h) => !present.has(h));
				pass = missing.length === 0;
				findings_count = missing.length;
				result.template = "applied";
				result.template_expected = expected;
				result.template_missing = missing;
			}
		}
	}

	// Filename-gated extension (units-generation 2.7): unit-of-work-dependency.md
	// must carry the required fenced ```yaml units: edge block beside its prose.
	// A malformed or cyclic block fails loud here, at the gate, rather than the
	// runtime compiler silently mis-reading or omitting it downstream. Every
	// other markdown artefact keeps the generic ≥2-H2 check untouched. (Orthogonal
	// to the template branch above — the edge-block check still applies even if a
	// template for unit-of-work-dependency resolves.)
	if (basename(flags.outputPath) === "unit-of-work-dependency.md") {
		const parsed = parseBoltDag(body);
		const edge_block = parsed.ok ? "ok" : parsed.reason;
		result.edge_block = edge_block;
		if (edge_block !== "ok") {
			pass = false;
			findings_count += 1;
		}
	}

	result.pass = pass;
	result.findings_count = findings_count;
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(0);
}

main();
