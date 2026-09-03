import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOLS = join(import.meta.dir, "..", "..", "core", "tools");
const REQUIRED = join(TOOLS, "aidlc-sensor-required-sections.ts");
const HTML_SHAPE = join(TOOLS, "aidlc-sensor-html-shape.ts");
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface SensorResult {
	pass: boolean;
	findings?: string[];
	headings?: string[];
	h2_count?: number;
	findings_count: number;
	scanned_files?: string[];
	reason?: string;
}

function stageDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "aidlc-t345-"));
	tempDirs.push(dir);
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf-8");
	return dir;
}

function run(tool: string, dir: string, output: string): SensorResult {
	const result = spawnSync(process.execPath, [
		tool,
		"--stage",
		"requirements-analysis",
		"--output-path",
		join(dir, output),
	], { encoding: "utf-8" });
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout) as SensorResult;
}

function html(body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Requirements</title>
<meta name="aidlc-artifact" content="requirements"><meta name="aidlc-stage" content="requirements-analysis"></head>
<body><section data-aidlc="summary"><h2>Summary</h2><p>Summary.</p></section>${body}</body></html>`;
}

describe("t345 Markdown-shape sensors on HTML", () => {
	test("required-sections sees projected H2 headings and reports a missing heading", () => {
		const dir = stageDir({
			"requirements.html": html("<h2>Requirements</h2><p>Body.</p><h2>Constraints</h2><p>Body.</p>"),
		});
		const passing = run(REQUIRED, dir, "requirements.html");
		expect(passing.pass).toBe(true);
		expect(passing.headings).toEqual(["## Summary", "## Requirements", "## Constraints"]);
		writeFileSync(join(dir, "requirements.html"), html("<h3>Requirements</h3>"), "utf-8");
		const failing = run(REQUIRED, dir, "requirements.html");
		expect(failing.pass).toBe(false);
		expect(failing.h2_count).toBe(1);
		expect(failing.findings_count).toBe(1);
	});
});

describe("t345 html-shape sensor", () => {
	test("lists findings for every violating HTML artifact", () => {
		const dir = stageDir({
			"requirements.html": "<html><body><iframe src=\"https://example.com\"></iframe></body></html>",
		});
		const result = run(HTML_SHAPE, dir, "requirements.html");
		expect(result.pass).toBe(false);
		expect(result.scanned_files).toHaveLength(1);
		expect(result.findings_count).toBeGreaterThan(1);
		expect(result.findings?.some((finding) => finding.includes("requirements.html: missing <!doctype html>"))).toBe(true);
		expect(result.findings?.some((finding) => finding.includes("<iframe> is not allowed"))).toBe(true);
	});

	test("passes a Markdown-only stage without findings", () => {
		const dir = stageDir({ "requirements.md": "# Requirements\n\n## Summary\n\nText.\n" });
		const result = run(HTML_SHAPE, dir, "requirements.md");
		expect(result).toMatchObject({
			pass: true,
			findings: [],
			scanned_files: [],
			findings_count: 0,
			reason: "no HTML outputs",
		});
	});
});
