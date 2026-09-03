import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkHtmlArtifact,
	exportSelfContained,
	htmlToMarkdown,
} from "../../core/tools/aidlc-html.ts";

const TOOL = join(import.meta.dir, "..", "..", "core", "tools", "aidlc-html.ts");
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempFile(name: string, body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "aidlc-t344-"));
	tempDirs.push(dir);
	const path = join(dir, name);
	writeFileSync(path, body, "utf-8");
	return path;
}

const valid = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Requirements</title>
<meta name="aidlc-artifact" content="requirements"><meta name="aidlc-stage" content="requirements-analysis"></head>
<body><section data-aidlc="summary"><h2>Summary</h2><p>Short.</p></section><h2>Details</h2></body></html>`;

describe("t344 deterministic HTML extraction", () => {
	test("projects headings, paragraphs, nested lists, tables, code, images, and SVG", () => {
		const markdown = htmlToMarkdown(`<!doctype html><html><head><script>ignored()</script><style>.x{}</style></head><body>
<section><h1>Artifact &amp; Plan</h1><p>First <strong>paragraph</strong>.</p>
<ul><li>Alpha<ol><li>Nested one</li><li>Nested two</li></ol></li><li>Beta</li></ul>
<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td>one</td><td>x | y</td><td>three</td></tr><tr><td>four</td><td>five</td><td>six</td></tr></tbody></table>
<pre><code class="language-ts">const answer = 42;</code></pre>
<img src="diagram.png" alt="System diagram"><svg><title>Request flow</title><path d="M0 0"/></svg></section>
<script>network()</script><noscript>hidden</noscript><template>hidden</template></body></html>`);
		expect(markdown).toContain("# Artifact & Plan");
		expect(markdown).toContain("First **paragraph**.");
		expect(markdown).toContain("- Alpha\n  1. Nested one\n  1. Nested two\n- Beta");
		expect(markdown).toContain("| A | B | C |\n| --- | --- | --- |\n| one | x \\| y | three |\n| four | five | six |");
		expect(markdown).toContain("```ts\nconst answer = 42;\n```");
		expect(markdown).toContain("![System diagram](diagram.png)");
		expect(markdown).toContain("[diagram: Request flow]");
		expect(markdown).not.toContain("ignored");
		expect(markdown).not.toContain("network");
	});

	test("moves the summary section before other body content", () => {
		const markdown = htmlToMarkdown(`<html><body><h2>Details</h2><p>Later.</p><section data-aidlc="summary"><h2>Summary</h2><p>First.</p></section></body></html>`);
		expect(markdown.indexOf("## Summary")).toBeLessThan(markdown.indexOf("## Details"));
	});
});

describe("t344 HTML authoring checks", () => {
	test("accepts a conforming artifact", () => {
		expect(checkHtmlArtifact(valid, { name: "requirements", stage: "requirements-analysis" })).toEqual({ ok: true, findings: [] });
	});

	test("reports each independent authoring violation", () => {
		const result = checkHtmlArtifact(`<html><head><title>Bad</title></head><body><p>Before summary</p>
<section data-aidlc="summary">Summary</section><form action="/submit"></form><iframe src="https://example.com"></iframe>
<section data-aidlc="review"><h2>Review</h2></section><p>After review</p></body></html>`, {
			name: "requirements",
			stage: "requirements-analysis",
		});
		expect(result.ok).toBe(false);
		for (const fragment of [
			"missing <!doctype html>",
			"missing <html lang>",
			"missing <meta charset>",
			'missing <meta name="aidlc-artifact">',
			'missing <meta name="aidlc-stage">',
			"body must begin",
			"<form action>",
			"<iframe> is not allowed",
			"external URL",
			"must be the last body element",
		]) expect(result.findings.some((finding) => finding.includes(fragment))).toBe(true);
	});
});

describe("t344 offline export and CLI", () => {
	test("exports Markdown with inline Mermaid and no network URL", () => {
		const path = tempFile("diagram.md", "# Diagram\n\n```mermaid\ngraph TD\n A-->B\n```\n");
		const html = exportSelfContained(path);
		expect(html).toContain('<pre class="mermaid">');
		expect(html).toContain("mermaid.initialize");
		expect(html).not.toMatch(/https?:\/\//);
	});

	test("CLI text/check/export commands and usage use stable exit codes", () => {
		const htmlPath = tempFile("requirements.html", valid);
		const text = spawnSync(process.execPath, [TOOL, "text", htmlPath], { encoding: "utf-8" });
		expect(text.status).toBe(0);
		expect(text.stdout).toContain("## Summary");
		const checked = spawnSync(process.execPath, [TOOL, "check", htmlPath, "--name", "requirements", "--stage", "requirements-analysis"], { encoding: "utf-8" });
		expect(checked.status).toBe(0);
		const badPath = tempFile("bad.html", "<html><body>bad</body></html>");
		const bad = spawnSync(process.execPath, [TOOL, "check", badPath], { encoding: "utf-8" });
		expect(bad.status).toBe(1);
		expect(bad.stdout).toContain("missing <!doctype html>");
		const exported = spawnSync(process.execPath, [TOOL, "export", htmlPath], { encoding: "utf-8" });
		expect(exported.status).toBe(0);
		expect(exported.stdout).toContain("<!doctype html>");
		const usage = spawnSync(process.execPath, [TOOL, "unknown"], { encoding: "utf-8" });
		expect(usage.status).toBe(2);
		expect(usage.stderr).toContain("Usage:");
	});
});
