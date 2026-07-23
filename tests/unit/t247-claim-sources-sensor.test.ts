// covers: subcommand:aidlc-sensor-claim-sources, file:sensors/aidlc-claim-sources.md
//
// Deterministic process-boundary coverage for Intent Capture provenance.
// The sensor proves citation shape and source resolution. Semantic entailment
// remains the product-lead reviewer's job by design.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";

const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor-claim-sources.ts");
const FIXTURE = join(FIXTURES_DIR, "intent-grounding", "passing");
const tempDirs: string[] = [];

interface SensorResult {
  pass: boolean;
  findings: string[];
  scanned_files: string[];
  questions_file: string;
  findings_count: number;
  reason?: string;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeStageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t247-"));
  tempDirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  const memoryDir = join(dir, "aidlc", "spaces", "default", "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), "default\n", "utf-8");
  writeFileSync(
    join(dir, "aidlc-state.md"),
    `# AI-DLC State Tracking

## Project Information
- **Project**: Build a local CLI that echoes supplied text.
- **Scope**: poc

## Workspace State
- **Project Root**: ${dir}
`,
    "utf-8",
  );
  writeFileSync(
    join(memoryDir, "project.md"),
    `# Project-Level Rules

## Forbidden

- Do not add network access.
`,
    "utf-8",
  );
  return dir;
}

function run(dir: string, output = "intent-statement.md"): SensorResult {
  const result = spawnSync(
    process.execPath,
    [
      SENSOR,
      "--stage",
      "intent-capture",
      "--output-path",
      join(dir, output),
      "--deliverables",
      "intent-statement,stakeholder-map",
    ],
    { encoding: "utf-8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as SensorResult;
}

function replaceInFile(
  dir: string,
  file: string,
  search: string,
  replacement: string,
): void {
  const path = join(dir, file);
  const body = readFileSync(path, "utf-8");
  expect(body.includes(search), `${file} does not contain mutation target`).toBe(
    true,
  );
  writeFileSync(path, body.replace(search, replacement), "utf-8");
}

describe("t247 claim-sources sensor", () => {
  test("grounded intent and stakeholder artifacts pass; reviewer section is excluded", () => {
    const result = run(makeStageDir());
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.scanned_files).toHaveLength(2);
    expect(result.findings_count).toBe(0);
  });

  test("questions-file-first write passes until a deliverable exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-t247-scaffold-"));
    tempDirs.push(dir);
    cpSync(
      join(FIXTURE, "intent-capture-questions.md"),
      join(dir, "intent-capture-questions.md"),
    );
    const result = run(dir, "intent-capture-questions.md");
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("no deliverables on disk yet");
    expect(result.scanned_files).toEqual([]);
  });

  test("an invented stakeholder row without a source tag fails", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "stakeholder-map.md",
      "| Requester | Receives exact local echo output. | [Q5] |",
      "| Product owner | Manages a future roadmap. | |",
    );
    const result = run(dir, "stakeholder-map.md");
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain("claim block has no source tag");
  });

  test("an unresolved question citation fails", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "Output exactly matches the supplied text. [Q3]",
      "Output exactly matches the supplied text. [Q99]",
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain("[Q99] has no filled answer");
  });

  test("a registered memory source resolves and an unknown memory source fails", () => {
    const passing = run(makeStageDir());
    expect(passing.pass).toBe(true);

    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "[memory:M1]",
      "[memory:missing]",
    );
    const failing = run(dir);
    expect(failing.pass).toBe(false);
    expect(failing.findings.join("\n")).toContain(
      "[memory:missing] is not registered",
    );
  });

  test("a memory source outside the stage's active memory files fails", () => {
    const dir = makeStageDir();
    writeFileSync(
      join(dir, "aidlc", "spaces", "default", "memory", "fabricated.md"),
      "# Fabricated Rules\n\n## Forbidden\n\n- Do not add network access.\n",
      "utf-8",
    );
    replaceInFile(
      dir,
      "intent-capture-questions.md",
      "memory/project.md#Forbidden",
      "memory/fabricated.md#Forbidden",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "[memory:M1] must name an active memory file",
    );
  });

  test("every deliverable requires Assumptions & Open Questions", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "stakeholder-map.md",
      "## Assumptions & Open Questions\n\nNone.\n",
      "",
    );
    const result = run(dir, "stakeholder-map.md");
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "missing ## Assumptions & Open Questions",
    );
  });

  test("retained assumptions fail until the human accepts them", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "stakeholder-map.md",
      "None.",
      "- A procurement reviewer may be needed. [assumption]",
    );
    const unconfirmed = run(dir, "stakeholder-map.md");
    expect(unconfirmed.pass).toBe(false);
    expect(unconfirmed.findings.join("\n")).toContain(
      "retained assumptions require",
    );

    const questionsPath = join(dir, "intent-capture-questions.md");
    writeFileSync(
      questionsPath,
      `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\n- A procurement reviewer may be needed. [assumption]\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: A. Accept assumptions\n`,
      "utf-8",
    );
    const accepted = run(dir, "intent-capture-questions.md");
    expect(accepted.pass).toBe(true);
    expect(accepted.findings).toEqual([]);
  });

  test("a stale confirmation cannot accept a different assumption set", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "stakeholder-map.md",
      "None.",
      "- A procurement reviewer may be needed. [assumption]",
    );
    const questionsPath = join(dir, "intent-capture-questions.md");
    writeFileSync(
      questionsPath,
      `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\n- A legal reviewer may be needed. [assumption]\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: A. Accept assumptions\n`,
      "utf-8",
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "retained assumption is not listed in ## Assumption Confirmation",
    );
  });

  test("a broader retained assumption cannot reuse a narrower confirmation", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "stakeholder-map.md",
      "None.",
      "- A procurement reviewer may be needed. [assumption]",
    );
    const questionsPath = join(dir, "intent-capture-questions.md");
    writeFileSync(
      questionsPath,
      `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\n- A procurement reviewer may be needed for international purchases. [assumption]\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: A. Accept assumptions\n`,
      "utf-8",
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "retained assumption is not listed in ## Assumption Confirmation",
    );
  });

  for (const answer of [
    "A. Accept assumptions? No",
    "A. Accept assumptions with caveats",
  ]) {
    test(`assumption confirmation rejects non-exact answer: ${answer}`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "stakeholder-map.md",
        "None.",
        "- A procurement reviewer may be needed. [assumption]",
      );
      const questionsPath = join(dir, "intent-capture-questions.md");
      writeFileSync(
        questionsPath,
        `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\n- A procurement reviewer may be needed. [assumption]\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: ${answer}\n`,
        "utf-8",
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "retained assumptions require",
      );
    });
  }

  test("assumption tags outside the assumptions section fail", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The requester is the sole identified customer. [Q2]",
      "A manager may also benefit. [assumption]",
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "[assumption] is outside ## Assumptions & Open Questions",
    );
  });

  test("workflow scope is labeled and confined to Initial Scope Signal", () => {
    const missingLabelDir = makeStageDir();
    replaceInFile(
      missingLabelDir,
      "intent-statement.md",
      "Workflow-selected scope: `poc`. [scope]",
      "Scope: `poc`. [scope]",
    );
    expect(run(missingLabelDir).findings.join("\n")).toContain(
      "not labeled workflow-selected",
    );

    const wrongSectionDir = makeStageDir();
    replaceInFile(
      wrongSectionDir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "The workflow-selected scope is a PoC. [scope]",
    );
    expect(run(wrongSectionDir).findings.join("\n")).toContain(
      "[scope] is valid only in ## Initial Scope Signal",
    );
  });

  test("the source register must include description and workflow scope", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-capture-questions.md",
      "- [desc] Initial description: \"Build a local CLI that echoes supplied text.\"\n",
      "",
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain("## Sources is missing [desc]");
  });

  test("source entries inside comments and code fences are ignored", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-capture-questions.md",
      '- [desc] Initial description: "Build a local CLI that echoes supplied text."\n- [scope] Workflow-selected scope: `poc`.\n',
      '<!-- - [desc] Initial description: "Build a local CLI that echoes supplied text." -->\n```markdown\n- [scope] Workflow-selected scope: `poc`.\n```\n',
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain("## Sources is missing [desc]");
    expect(result.findings.join("\n")).toContain("## Sources is missing [scope]");
  });

  test("question headings and answers inside comments and fences are ignored", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "Output exactly matches the supplied text. [Q3]",
      "Output exactly matches the supplied text. [Q99]",
    );
    const questionsPath = join(dir, "intent-capture-questions.md");
    writeFileSync(
      questionsPath,
      `${readFileSync(questionsPath, "utf-8")}\n\n<!--\n## Q99. Fabricated comment question\n[Answer]: Fabricated answer\n-->\n\n\`\`\`markdown\n## Q99. Fabricated fenced question\n[Answer]: Fabricated answer\n\`\`\`\n`,
      "utf-8",
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain("[Q99] has no filled answer");
  });

  test("description, scope, and memory entries must match authoritative inputs", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-capture-questions.md",
      '"Build a local CLI that echoes supplied text."',
      '"Build a hosted API."',
    );
    replaceInFile(
      dir,
      "intent-capture-questions.md",
      "Workflow-selected scope: `poc`.",
      "Workflow-selected scope: `enterprise`.",
    );
    replaceInFile(
      dir,
      "intent-capture-questions.md",
      '"Do not add network access."',
      '"Network access is allowed."',
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    const findings = result.findings.join("\n");
    expect(findings).toContain(
      "[desc] does not exactly match Project in aidlc-state.md",
    );
    expect(findings).toContain(
      "[scope] does not exactly match Scope in aidlc-state.md",
    );
    expect(findings).toContain(
      "[memory:M1] quoted rule does not exactly match an entry under ## Forbidden",
    );
  });

  test("source tags hidden in comments or inline code do not ground a claim", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "The initiative provides a local command that echoes supplied text. <!-- [desc] --> `[Q1]`",
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain("claim block has no source tag");
  });

  for (const [label, replacement] of [
    [
      "Markdown link destination",
      "The initiative provides a local command that echoes supplied text. [documentation](https://example.invalid?source=[desc]-[Q1])",
    ],
    [
      "Markdown image metadata",
      "The initiative provides a local command that echoes supplied text. ![hidden [desc] [Q1]](https://example.invalid/pixel.png)",
    ],
    [
      "Markdown reference metadata",
      'The initiative provides a local command that echoes supplied text. [documentation][evidence]\n[evidence]: https://example.invalid\n"hidden [desc] [Q1]"',
    ],
    [
      "HTML attributes",
      'The initiative provides a local command that echoes supplied text. <span title="[desc] [Q1]">documentation</span>',
    ],
    [
      "hidden HTML content",
      'The initiative provides a local command that echoes supplied text. <span hidden>[desc] [Q1]</span>',
    ],
    [
      "HTML code content",
      "The initiative provides a local command that echoes supplied text. <code>[desc] [Q1]</code>",
    ],
  ] as const) {
    test(`source tags hidden in ${label} do not ground a claim`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        replacement,
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "claim block has no source tag",
      );
    });
  }

  test("source tags in a visible Markdown link label ground a claim", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "The initiative provides a local command that echoes supplied text. [Grounded by [desc] and [Q1]](https://example.invalid)",
    );

    const result = run(dir);
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
  });
});
