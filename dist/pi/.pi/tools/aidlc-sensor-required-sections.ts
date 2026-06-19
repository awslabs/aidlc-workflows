import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
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
}

interface Flags {
	stage?: string;
	outputPath?: string;
}

function parseFlags(argv: string[]): Flags {
	const out: Flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--stage") {
			out.stage = argv[++i];
		} else if (arg === "--output-path") {
			out.outputPath = argv[++i];
		}
	}
	return out;
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
	const seen = new Set<string>();
	const headings: string[] = [];
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith("## ")) continue;
		if (seen.has(line)) continue;
		seen.add(line);
		headings.push(line);
	}

	const h2_count = headings.length;
	let pass = h2_count >= 2;
	// findings_count derivation per locked plan: max(0, 2 - h2_count).
	// Emitted by the script (not the dispatcher) per the v3 control-
	// plane / data-plane separation: per-sensor scripts own their own
	// findings derivation; the dispatcher reads out.findings_count
	// generically and is sensor-id-agnostic.
	let findings_count = Math.max(0, 2 - h2_count);
	const result: Result = { pass, h2_count, headings, findings_count };

	// Filename-gated extension (units-generation 2.7): unit-of-work-dependency.md
	// must carry the required fenced ```yaml units: edge block beside its prose.
	// A malformed or cyclic block fails loud here, at the gate, rather than the
	// runtime compiler silently mis-reading or omitting it downstream. Every
	// other markdown artefact keeps the generic ≥2-H2 check untouched.
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
