import { existsSync, readFileSync } from "node:fs";
import { errorMessage } from "./aidlc-lib.ts";

interface Result {
	pass: boolean;
	consumes: string[];
	unreferenced: string[];
	reason?: string;
	findings_count: number;
}

interface Flags {
	stage?: string;
	outputPath?: string;
	consumes?: string;
	consumesPresent: boolean;
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

	// Split, trim, drop empties. Both `--consumes ""` and an absent flag
	// collapse to consumes = [], which triggers the "no upstream" early
	// return below.
	const rawConsumes = flags.consumes ?? "";
	const consumes = rawConsumes
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	if (consumes.length === 0) {
		const result: Result = {
			pass: true,
			consumes: [],
			unreferenced: [],
			reason: "no upstream",
			findings_count: 0,
		};
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exit(0);
	}

	// Per the locked plan: case-insensitive grep with word-boundary
	// anchors on the slug and either form: \b<slug>\b (literal) OR
	// \[\[<slug>\]\] (wikilink). Slugs are kebab-case so word boundaries
	// resolve cleanly without escaping anything beyond standard regex
	// metacharacters.
	const unreferenced: string[] = [];
	for (const slug of consumes) {
		const escaped = escapeRegex(slug);
		const pattern = new RegExp(`\\b${escaped}\\b|\\[\\[${escaped}\\]\\]`, "i");
		if (!pattern.test(body)) {
			unreferenced.push(slug);
		}
	}

	const result: Result = {
		pass: unreferenced.length === 0,
		consumes,
		unreferenced,
		// findings_count emitted by the script (sensor-id-agnostic dispatcher).
		findings_count: unreferenced.length,
	};
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(0);
}

main();
