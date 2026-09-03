import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkHtmlArtifact } from "./aidlc-html.ts";
import { errorMessage } from "./aidlc-lib.ts";

interface Result {
	pass: boolean;
	findings: string[];
	scanned_files: string[];
	findings_count: number;
	reason?: string;
}

interface Flags {
	stage?: string;
	outputPath?: string;
}

function fail(message: string): never {
	process.stderr.write(`aidlc-sensor-html-shape: ${message}\n`);
	process.exit(1);
}

export function main(argv: string[]): void {
	const flags: Flags = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--stage") flags.stage = argv[++index];
		else if (arg === "--output-path") flags.outputPath = argv[++index];
	}
	if (!flags.outputPath) fail("--output-path is required");
	if (!existsSync(flags.outputPath)) fail(`--output-path not found: ${flags.outputPath}`);

	const firedPath = resolve(flags.outputPath);
	const stageDir = statSync(firedPath).isDirectory() ? firedPath : dirname(firedPath);
	let htmlPaths: string[];
	try {
		htmlPaths = readdirSync(stageDir)
			.filter((name) => name.toLowerCase().endsWith(".html"))
			.map((name) => join(stageDir, name))
			.sort();
	} catch (error) {
		fail(`failed to inspect stage output directory ${stageDir}: ${errorMessage(error)}`);
	}
	if (htmlPaths.length === 0) {
		const result: Result = {
			pass: true,
			findings: [],
			scanned_files: [],
			findings_count: 0,
			reason: "no HTML outputs",
		};
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}

	const findings: string[] = [];
	for (const path of htmlPaths) {
		try {
			const name = basename(path).replace(/\.html$/i, "");
			const check = checkHtmlArtifact(readFileSync(path, "utf-8"), {
				name,
				stage: flags.stage ?? basename(stageDir),
			});
			findings.push(...check.findings.map((finding) => `${basename(path)}: ${finding}`));
		} catch (error) {
			findings.push(`${basename(path)}: failed to read: ${errorMessage(error)}`);
		}
	}
	const result: Result = {
		pass: findings.length === 0,
		findings,
		scanned_files: htmlPaths,
		findings_count: findings.length,
	};
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
