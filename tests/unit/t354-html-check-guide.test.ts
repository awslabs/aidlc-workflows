import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(ROOT, "core", "tools", "aidlc-html.ts");
const dirs: string[] = [];

const QUESTIONS = `# Questions

## Q1. Runtime

A. Bun
B. Node
X. Other (please specify)

[Answer]:

## Q2. Hosting

A. Cloud
B. On-prem

[Answer]:
`;

const GUIDE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="aidlc-artifact" content="feasibility-questions-guide">
<meta name="aidlc-stage" content="feasibility">
<title>Feasibility guide</title>
</head><body>
<section data-aidlc="summary"><p>This round decides runtime and hosting.</p></section>
<section data-aidlc-question="Q1" id="Q1"><h2>Q1. Runtime</h2><h3>Why now</h3><p>Design depends on it.</p><h3>Trade-offs</h3><table><tr><th>Option</th><th>You get</th><th>You give up</th><th>Cost / risk</th></tr><tr><td>A</td><td>Speed</td><td>Portability</td><td>Runtime maturity</td></tr></table><h3>Recommendation</h3><p data-aidlc-recommend="A">Bun fits the toolchain.</p><h3>Related decisions</h3><p>None found</p></section>
<section data-aidlc-question="Q2" id="Q2"><h2>Q2. Hosting</h2><h3>Why now</h3><p>Deployment depends on it.</p><h3>Trade-offs</h3><table><tr><th>Option</th><th>You get</th><th>You give up</th><th>Cost / risk</th></tr><tr><td>B</td><td>Control</td><td>Elasticity</td><td>Operations</td></tr></table><h3>Recommendation</h3><p data-aidlc-recommend="B">On-prem meets the constraint.</p><h3>Related decisions</h3><p>None found</p></section>
</body></html>`;

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function check(html: string): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t354-"));
  dirs.push(dir);
  const guide = join(dir, "feasibility-questions-guide.html");
  const questions = join(dir, "feasibility-questions.md");
  writeFileSync(guide, html);
  writeFileSync(questions, QUESTIONS);
  const result = Bun.spawnSync({
    cmd: [BUN, TOOL, "check", "--guide", guide, "--questions", questions],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  };
}

describe("aidlc-html check --guide", () => {
  test("accepts one valid guide section per questions-file id", () => {
    expect(check(GUIDE)).toEqual({ status: 0, output: "" });
  });

  test("reports a missing question section", () => {
    const result = check(GUIDE.replace(/<section data-aidlc-question="Q2"[\s\S]*?<\/section>/, ""));
    expect(result.status).toBe(1);
    expect(result.output).toContain('guide is missing question section "Q2"');
  });

  test("reports recommendation letters absent from that question", () => {
    const result = check(GUIDE.replace('data-aidlc-recommend="A"', 'data-aidlc-recommend="Z"'));
    expect(result.status).toBe(1);
    expect(result.output).toContain('recommendation "Z" is not an option for Q1');
  });
});
