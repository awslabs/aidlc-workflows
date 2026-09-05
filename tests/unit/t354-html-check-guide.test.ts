import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({ cmd: [BUN, TOOL, ...args], stdout: "pipe", stderr: "pipe" });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function fixture(questions = QUESTIONS, html = GUIDE): { dir: string; guide: string; questions: string } {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t354-"));
  dirs.push(dir);
  const guide = join(dir, "feasibility-questions-guide.html");
  const questionsPath = join(dir, "feasibility-questions.md");
  writeFileSync(guide, html);
  writeFileSync(questionsPath, questions);
  return { dir, guide, questions: questionsPath };
}

function check(html: string, questions = QUESTIONS): { status: number; output: string } {
  const f = fixture(questions, html);
  const result = run(["check", "--guide", f.guide, "--questions", f.questions]);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
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

  test("reports recommendation letters absent from that question, naming the offered ones", () => {
    const result = check(GUIDE.replace('data-aidlc-recommend="A"', 'data-aidlc-recommend="Z"'));
    expect(result.status).toBe(1);
    expect(result.output).toContain('recommendation "Z" is not an option for Q1 (offered: A, B, X)');
  });

  test("an empty recommendation is named as such", () => {
    const result = check(GUIDE.replace('data-aidlc-recommend="A"', 'data-aidlc-recommend=""'));
    expect(result.status).toBe(1);
    expect(result.output).toContain("Q1 recommendation is empty: set data-aidlc-recommend to one of A, B, X");
  });

  test("a questions file with bulleted options is diagnosed once per question, not per recommendation", () => {
    // The mistake the model actually makes: Markdown bullets in front of the
    // letters. Every parser treats those as prose, so the old output was four
    // misleading "not an option" lines that sent the model into the source code.
    const bulleted = QUESTIONS.replace(/^([A-Z])\. /gm, "- $1. ");
    const result = check(GUIDE, bulleted);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Q1 has no parsable options in the questions file (saw "- A. Bun"): options must be bare lines "A. text" starting at column 0');
    expect(result.output).toContain('Q2 has no parsable options');
    expect(result.output).not.toContain("is not an option");
  });

  test("unfilled prose fails: empty paragraphs, empty summary, empty table cells", () => {
    // The review UI publishes a browser round only when this check passes, so
    // an untouched scaffold paragraph must be a finding, not a silent pass.
    const hollow = GUIDE
      .replace("<p>This round decides runtime and hosting.</p>", "<p></p>")
      .replace("<h3>Why now</h3><p>Design depends on it.</p>", "<h3>Why now</h3><p></p>")
      .replace("<td>Speed</td><td>Portability</td>", "<td></td><td></td>");
    const result = check(hollow);
    expect(result.status).toBe(1);
    expect(result.output).toContain("summary section is empty: say what this round decides");
    expect(result.output).toContain('Q1 has an empty paragraph under "Why now"');
    expect(result.output).toContain("Q1 trade-off table has 2 empty cells");
    expect(result.output).not.toContain("Q2 has an empty paragraph");
  });

  test("the summary finding points at the scaffold", () => {
    const result = check(GUIDE.replace('<section data-aidlc="summary"><p>This round decides runtime and hosting.</p></section>', ""));
    expect(result.status).toBe(1);
    expect(result.output).toContain('body must begin with <section data-aidlc="summary"> holding one paragraph');
    expect(result.output).toContain("aidlc-html.ts scaffold --guide");
  });
});

describe("aidlc-html scaffold --guide", () => {
  test("emits a skeleton that passes the check once recommendations are filled", () => {
    const f = fixture();
    // The check derives identity from the guide filename, so it must be the
    // stage's own `<slug>-questions-guide.html`.
    const out = join(f.dir, "out", "feasibility-questions-guide.html");
    mkdirSync(join(f.dir, "out"));
    const scaffold = run(["scaffold", "--guide", f.questions, "--out", out]);
    expect(scaffold.status, scaffold.stderr).toBe(0);
    const text = readFileSync(out, "utf-8");
    // Identity from the questions filename; real letters and texts in the rows.
    expect(text).toContain('<meta name="aidlc-artifact" content="feasibility-questions-guide">');
    expect(text).toContain('<meta name="aidlc-stage" content="feasibility">');
    expect(text).toContain('<section data-aidlc-question="Q1" id="Q1">');
    expect(text).toContain("<h2>Runtime</h2>");
    expect(text).toContain('<th scope="row">A. Bun</th>');
    expect(text).toContain('<th scope="row">X. Other (please specify)</th>');
    expect(text).toContain('<th scope="row">B. On-prem</th>');
    expect(text).not.toContain("Consolidated Summary");
    // Unfilled: only the two empty recommendations stand between it and green.
    // Unfilled: every gap is named — the empty summary, each empty paragraph and
    // table cell, and the two recommendations — so nothing half-done can pass.
    const unfilled = run(["check", "--guide", out, "--questions", f.questions]);
    expect(unfilled.status).toBe(1);
    expect(unfilled.stdout).toContain("summary section is empty");
    expect(unfilled.stdout).toContain('Q1 has an empty paragraph under "Why now"');
    expect(unfilled.stdout).toContain("Q1 trade-off table has 9 empty cells");
    expect(unfilled.stdout).toContain("Q1 recommendation is empty: set data-aidlc-recommend to one of A, B, X");
    expect(unfilled.stdout).toContain("Q2 recommendation is empty: set data-aidlc-recommend to one of A, B");
    // Filled in the way the protocol asks (one write of all prose + letters): green.
    const filled = text
      .replace('<section data-aidlc="summary">\n  <p></p>', '<section data-aidlc="summary">\n  <p>Runtime and hosting.</p>')
      .replaceAll("<p></p>", "<p>Because.</p>")
      .replaceAll("<td></td>", "<td>x</td>")
      .replace('<p data-aidlc-recommend=""></p>', '<p data-aidlc-recommend="A">Bun.</p>')
      .replace('<p data-aidlc-recommend=""></p>', '<p data-aidlc-recommend="B">On-prem.</p>');
    writeFileSync(out, filled);
    const green = run(["check", "--guide", out, "--questions", f.questions]);
    expect(green.status, green.stdout).toBe(0);
  });

  test("--depth minimal drops the trade-off table and related decisions", () => {
    const f = fixture();
    const minimal = run(["scaffold", "--guide", f.questions, "--depth", "minimal"]);
    expect(minimal.status).toBe(0);
    expect(minimal.stdout).toContain("<h3>Why now</h3>");
    expect(minimal.stdout).toContain("<h3>Recommendation</h3>");
    expect(minimal.stdout).not.toContain("Trade-offs");
    expect(minimal.stdout).not.toContain("Related decisions");
    expect(run(["scaffold", "--guide", f.questions, "--depth", "huge"]).status).toBe(2);
  });

  test("a malformed questions file yields empty sections the check then explains", () => {
    const f = fixture(QUESTIONS.replace(/^([A-Z])\. /gm, "- $1. "));
    const out = join(f.dir, "g.html");
    expect(run(["scaffold", "--guide", f.questions, "--out", out]).status).toBe(0);
    const result = run(["check", "--guide", out, "--questions", f.questions]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Q1 has no parsable options in the questions file");
  });
});
