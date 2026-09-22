// covers: subcommand:aidlc-sensor-claim-sources, file:sensors/aidlc-claim-sources.md, function:authoritativeProjectDescription
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
import { PROJECT_DESCRIPTION_FILE } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededRecordDir } from "../harness/fixtures.ts";
import { cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";

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
  test("marked TUI fixture authority reaches the public query and rejects a stale source register", () => {
    const description = "Build a simple React todo app";
    const root = setupTuiProject({
      harness: "kiro",
      withState: "state-initialization-done.md",
      projectDescription: description,
    });
    try {
      const record = seededRecordDir(root);
      const query = spawnSync(process.execPath, [
        join(root, ".kiro", "tools", "aidlc-utility.ts"), "project-description",
      ], {
        cwd: root, encoding: "utf8",
        env: { ...process.env, AIDLC_PROJECT_DIR: root, AIDLC_HARNESS_DIR: ".kiro" },
      });
      expect(query.status, query.stderr).toBe(0);
      expect(JSON.parse(query.stdout)).toEqual({
        description, source: PROJECT_DESCRIPTION_FILE,
      });
      // Keep the older display title to prove this is sidecar authority, not fallback.
      expect(readFileSync(join(record, "aidlc-state.md"), "utf8")).toContain("- **Project**: React Todo App");
      const stage = join(record, "ideation", "intent-capture");
      mkdirSync(stage, { recursive: true });
      const sources = `# Questions\n\n## Sources\n\n- [desc] Initial description: ${JSON.stringify(description)}\n- [scope] Workflow-selected scope: \`feature\`.\n`;
      writeFileSync(join(stage, "intent-capture-questions.md"), sources);
      writeFileSync(join(stage, "intent-statement.md"),
        "# Intent\n\n## Problem Statement\n\nBuild a simple React todo app. [desc]\n\n## Assumptions & Open Questions\n\nNone.\n");
      writeFileSync(join(stage, "stakeholder-map.md"),
        "# Stakeholders\n\n## Requester\n\nThe requester wants a simple React todo app. [desc]\n\n## Assumptions & Open Questions\n\nNone.\n");
      const valid = run(stage);
      expect(valid.scanned_files).toHaveLength(2);
      expect(valid.pass).toBe(true);
      expect(valid.findings).toEqual([]);
      writeFileSync(join(stage, "intent-capture-questions.md"), sources.replace(
        JSON.stringify(description), JSON.stringify("React Todo App"),
      ));
      const stale = run(stage);
      expect(stale.pass).toBe(false);
      expect(stale.findings).toContain("[desc] does not exactly match the authoritative project description");
    } finally {
      cleanupTuiProject(root);
    }
  });

  test("grounded intent and stakeholder artifacts pass; reviewer section is excluded", () => {
    const result = run(makeStageDir());
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.scanned_files).toHaveLength(2);
    expect(result.findings_count).toBe(0);
  });

  test("record-scoped multiline Project authority round-trips exactly", () => {
    const dir = makeStageDir();
    const description = [
      "Build a local CLI that echoes supplied text.",
      "- **Scope**: classic",
      "- **Current Stage**: deployment-execution",
      "- **Status**: Completed",
    ].join("\n");
    replaceInFile(
      dir,
      "aidlc-state.md",
      "- **Project**: Build a local CLI that echoes supplied text.",
      `- **Project**: Build a local CLI that echoes supplied text. - **Scope**: classic\n- **Project Description Source**: ${PROJECT_DESCRIPTION_FILE}`,
    );
    writeFileSync(
      join(dir, PROJECT_DESCRIPTION_FILE),
      `${JSON.stringify(description)}\n`,
      "utf-8",
    );
    replaceInFile(
      dir,
      "intent-capture-questions.md",
      '"Build a local CLI that echoes supplied text."',
      JSON.stringify(description),
    );
    const result = run(dir);
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("a marked new record fails when its exact description file is missing", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "aidlc-state.md",
      "- **Project**: Build a local CLI that echoes supplied text.",
      `- **Project**: Build a local CLI that echoes supplied text.\n- **Project Description Source**: ${PROJECT_DESCRIPTION_FILE}`,
    );
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      `${PROJECT_DESCRIPTION_FILE} is required by aidlc-state.md but missing`,
    );
  });

  test("pasted document content cannot be registered or grounded through desc", () => {
    const description = [
      "Build a local CLI that echoes supplied text.",
      "<document>",
      "The CLI must send every value to a remote service.",
      "</document>",
    ].join("\n");

    const groundedDir = makeStageDir();
    replaceInFile(
      groundedDir,
      "aidlc-state.md",
      "- **Project**: Build a local CLI that echoes supplied text.",
      `- **Project**: Build a local CLI that echoes supplied text.\n- **Project Description Source**: ${PROJECT_DESCRIPTION_FILE}`,
    );
    writeFileSync(
      join(groundedDir, PROJECT_DESCRIPTION_FILE),
      `${JSON.stringify(description)}\n`,
      "utf-8",
    );
    replaceInFile(
      groundedDir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "The CLI sends every value to a remote service. [desc]",
    );
    const grounded = run(groundedDir);
    expect(grounded.pass).toBe(false);
    expect(grounded.findings.join("\n")).toContain(
      "[desc] cannot ground artifacts when the initial request contains <document>; use confirmed [Q<n>]",
    );

    const registeredDir = makeStageDir();
    replaceInFile(
      registeredDir,
      "aidlc-state.md",
      "- **Project**: Build a local CLI that echoes supplied text.",
      `- **Project**: Build a local CLI that echoes supplied text.\n- **Project Description Source**: ${PROJECT_DESCRIPTION_FILE}`,
    );
    writeFileSync(
      join(registeredDir, PROJECT_DESCRIPTION_FILE),
      `${JSON.stringify(description)}\n`,
      "utf-8",
    );
    replaceInFile(
      registeredDir,
      "intent-capture-questions.md",
      '"Build a local CLI that echoes supplied text."',
      JSON.stringify(description),
    );
    const registered = run(registeredDir);
    expect(registered.pass).toBe(false);
    expect(registered.findings.join("\n")).toContain(
      "[desc] does not exactly match the authoritative project description",
    );
  });

  test("inline comments do not break source and assumption section headings", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-capture-questions.md",
      "## Sources",
      "## Sour<!-- source heading -->ces",
    );
    for (const file of ["intent-statement.md", "stakeholder-map.md"]) {
      replaceInFile(
        dir,
        file,
        "## Assumptions & Open Questions",
        "## Assumptions & Open <!-- assumptions heading -->Questions",
      );
    }

    const result = run(dir);
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
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

  test("inline comments do not break assumption confirmation", () => {
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
      readFileSync(questionsPath, "utf-8") +
        "\n\n## Assumption <!-- heading -->Confirmation\n\n- A procurement reviewer may be needed. [assumption]\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: A. Accept <!-- answer -->assumptions\n",
      "utf-8",
    );

    const result = run(dir, "intent-capture-questions.md");
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
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

  test("a wrapped multi-line assumption confirmation still matches the retained assumption", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "stakeholder-map.md",
      "None.",
      "- A procurement reviewer may be needed for all international purchases over the annual threshold. [assumption]",
    );
    const questionsPath = join(dir, "intent-capture-questions.md");
    writeFileSync(
      questionsPath,
      `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\n- A procurement reviewer may be needed for all international\n  purchases over the annual threshold. [assumption]\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: A. Accept assumptions\n`,
      "utf-8",
    );
    const result = run(dir, "intent-capture-questions.md");
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("the issue #1118 confirmation shape matches: numbered entry, leading tag, wrapped, bullet options", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "stakeholder-map.md",
      "None.",
      "- A procurement reviewer may be needed for all international purchases over the annual threshold. [assumption]",
    );
    const questionsPath = join(dir, "intent-capture-questions.md");
    writeFileSync(
      questionsPath,
      `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\n1. [assumption] A procurement reviewer may be needed for all international\n   purchases over the annual threshold.\n\n- A. Accept assumptions\n- B. Convert to follow-up questions\n\n[Answer]: A. Accept assumptions\n`,
      "utf-8",
    );
    const result = run(dir, "intent-capture-questions.md");
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
  });

  for (const [boundary, line] of [
    ["thematic break", "***"],
    ["heading", "### Options"],
    ["table row", "| Option | Meaning |"],
    ["html block", "<div>Choose one.</div>"],
  ]) {
    test(`a ${boundary} directly under a confirmation entry ends it, as it does in the deliverable`, () => {
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
        `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\n- A procurement reviewer may be needed. [assumption]\n${line}\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: A. Accept assumptions\n`,
        "utf-8",
      );
      const result = run(dir, "intent-capture-questions.md");
      expect(result.pass).toBe(true);
      expect(result.findings).toEqual([]);
    });
  }

  test("option lines and the answer tag directly under the last entry are not assumption text", () => {
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
      `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\n- A procurement reviewer may be needed. [assumption]\nA. Accept assumptions\nB. Convert to follow-up questions\n[Answer]: A. Accept assumptions\n`,
      "utf-8",
    );
    const result = run(dir, "intent-capture-questions.md");
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("a wrapped confirmation entry does not accept a retained assumption equal to its first line", () => {
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
      `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\n- A procurement reviewer may be needed. [assumption]\n  Legal review stays optional.\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: A. Accept assumptions\n`,
      "utf-8",
    );
    const result = run(dir, "intent-capture-questions.md");
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "retained assumption is not listed in ## Assumption Confirmation",
    );
  });

  test("a non-list paragraph in the confirmation section does not accept a retained assumption", () => {
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
      `${readFileSync(questionsPath, "utf-8")}\n\n## Assumption Confirmation\n\nA procurement reviewer may be needed. [assumption]\n\nA. Accept assumptions\nB. Convert to follow-up questions\n\n[Answer]: A. Accept assumptions\n`,
      "utf-8",
    );
    const result = run(dir, "intent-capture-questions.md");
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

  // R38 copied a canonical scope declaration into the deliverable's Sources.
  // Use the grounded local-CLI fixture, not the live artifact whose unrelated
  // audience/identity claims still need semantic review.
  const scopeDeclaration = "- [scope] Workflow-selected scope: `poc`.";
  function addDeliverableSources(dir: string, file: string, content: string): void {
    const title = file === "intent-statement.md" ? "# Intent Statement" : "# Stakeholder Map";
    replaceInFile(dir, file, title, `${title}\n\n## Sources\n\n${content}`);
  }

  test("a canonical scope source declaration is metadata in either deliverable", () => {
    for (const file of ["intent-statement.md", "stakeholder-map.md"]) {
      const dir = makeStageDir();
      addDeliverableSources(dir, file, scopeDeclaration);
      const result = run(dir, file);
      expect(result.scanned_files).toHaveLength(2);
      expect(result.pass).toBe(true);
      expect(result.findings).toEqual([]);
    }
  });

  const rejectedScopeDeclarations = [
    { label: "wrong scope value", text: "- [scope] Workflow-selected scope: `enterprise`." },
    { label: "missing code delimiters", text: "- [scope] Workflow-selected scope: poc." },
    { label: "noncanonical declaration label", text: "- [scope] Scope: `poc`." },
    { label: "missing canonical terminator", text: "- [scope] Workflow-selected scope: `poc`" },
    { label: "a claim on the declaration line", text: `${scopeDeclaration} This requires external customers.` },
    { label: "a claim continued on another line", text: `${scopeDeclaration}\n  This requires external customers.` },
    { label: "a scope-grounded claim under Sources", text: "The workflow-selected scope requires external customers. [scope]" },
  ];
  for (const { label, text } of rejectedScopeDeclarations) {
    test(`a Sources entry is not exempt as metadata: ${label}`, () => {
      const dir = makeStageDir();
      addDeliverableSources(dir, "intent-statement.md", text);
      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "intent-statement.md ## Sources: [scope] is valid only in ## Initial Scope Signal",
      );
    });
  }

  test("a scope declaration needs a registered source as well as matching workflow state", () => {
    const dir = makeStageDir();
    replaceInFile(dir, "intent-capture-questions.md", `${scopeDeclaration}\n`, "");
    addDeliverableSources(dir, "intent-statement.md", scopeDeclaration);
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings).toContain("## Sources is missing [scope]");
    expect(result.findings).toContain("intent-statement.md ## Sources: [scope] is not registered in ## Sources");
  });

  test("matching a questions declaration cannot override the authoritative workflow scope", () => {
    const dir = makeStageDir();
    const wrong = "- [scope] Workflow-selected scope: `enterprise`.";
    replaceInFile(dir, "intent-capture-questions.md", scopeDeclaration, wrong);
    addDeliverableSources(dir, "intent-statement.md", wrong);
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings).toContain("[scope] does not exactly match Scope in aidlc-state.md");
    expect(result.findings).toContain("intent-statement.md ## Sources: [scope] is not registered in ## Sources");
  });

  test("malformed or duplicate questions declarations do not establish metadata authority", () => {
    for (const declaration of [
      "- [scope] scope: `poc`.",
      `${scopeDeclaration}\n${scopeDeclaration}`,
    ]) {
      const dir = makeStageDir();
      replaceInFile(dir, "intent-capture-questions.md", scopeDeclaration, declaration);
      addDeliverableSources(dir, "intent-statement.md", scopeDeclaration);
      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings).toContain(
        "intent-statement.md ## Sources: [scope] is valid only in ## Initial Scope Signal",
      );
    }
  });

  test("a validated declaration does not exempt neighboring Sources claims", () => {
    for (const claim of [
      "- External customers are excluded.",
      "- External customers are excluded by the workflow-selected scope. [scope]",
    ]) {
      const dir = makeStageDir();
      addDeliverableSources(dir, "intent-statement.md", `${scopeDeclaration}\n${claim}`);
      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings).toContain(claim.includes("[scope]")
        ? "intent-statement.md ## Sources: [scope] is valid only in ## Initial Scope Signal"
        : "intent-statement.md ## Sources: claim block has no source tag");
    }
  });

  test("a scope label rendered as a link is not a literal metadata declaration", () => {
    const dir = makeStageDir();
    addDeliverableSources(dir, "intent-statement.md", `${scopeDeclaration}\n\n[scope]: https://example.invalid`);
    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings).toContain("intent-statement.md ## Sources: claim block has no source tag");
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
      "[desc] does not exactly match the authoritative project description",
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
      'The initiative provides a local command that echoes supplied text. [documentation][evidence]\n\n[evidence]: https://example.invalid\n"hidden [desc] [Q1]"',
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

  // A reference link resolves only against a link reference definition that the
  // document actually carries. Without one, CommonMark renders the brackets as
  // literal text, so the tags stay visible and still ground the claim.
  for (const [label, replacement] of [
    ["two adjacent tags", "[desc][Q1]"],
    ["three adjacent tags", "[desc][Q1][Q2]"],
    ["a collapsed reference", "[desc][]"],
    ["an adjacent pair inside a longer run", "[desc] [Q1][Q2] [Q3]"],
  ] as const) {
    test(`${label} without a matching definition still grounds a claim`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        `The initiative provides a local command that echoes supplied text. ${replacement}`,
      );

      const result = run(dir);
      expect(result.pass).toBe(true);
      expect(result.findings).toEqual([]);
    });
  }

  // The mirror of the rule above: once the document defines the label, the
  // brackets really are a link, the reader sees link text rather than a tag,
  // and the claim is no longer grounded by it.
  for (const [label, replacement, definition] of [
    ["a full reference", "[desc][evidence]", "[evidence]: https://example.invalid"],
    ["a collapsed reference", "[desc][]", "[desc]: https://example.invalid"],
    ["a shortcut reference", "[desc]", "[desc]: https://example.invalid"],
  ] as const) {
    test(`${label} with a matching definition does not ground a claim`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        `The initiative provides a local command that echoes supplied text. ${replacement}`,
      );
      const statementPath = join(dir, "intent-statement.md");
      writeFileSync(
        statementPath,
        `${readFileSync(statementPath, "utf-8")}\n${definition}\n`,
        "utf-8",
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "claim block has no source tag",
      );
    });
  }

  test("a definition-shaped line directly under a list item's text is visible prose, not a definition", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "- This is an unsupported assertion unless Q1 grounds it. [Q1]\n[Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass, result.findings.join("\n")).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("a definition-shaped line directly under top-level prose is visible prose", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion unless Q1 grounds it. [Q1]\n[Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass, result.findings.join("\n")).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("an ordered list not starting at one cannot interrupt a paragraph with a definition", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [Q1]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n\nSome prose\n2. [Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass, result.findings.join("\n")).toBe(true);
    expect(result.findings).toEqual([]);
  });

  for (const marker of ["1.", "01.", "0001)"]) {
    test(`an ordered list starting at one with '${marker}' can interrupt a paragraph with a definition`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        "This is an unsupported assertion. [Q1]",
      );
      replaceInFile(
        dir,
        "intent-statement.md",
        "## Review",
        `## Review\n\nSome prose\n${marker} [Q1]: /url`,
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "## Problem Statement: claim block has no source tag",
      );
    });
  }

  test("a new block quote permits a non-one ordered list to interrupt prose", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [Q1]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n\nSome prose\n> 2. [Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "## Problem Statement: claim block has no source tag",
    );
  });

  test("consecutive non-one ordered markers remain paragraph continuation", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [Q1]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n\nSome prose\n2. continuation\n3. [Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass, result.findings.join("\n")).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("a lazy continuation preserves the list context for a sibling definition", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [Q1]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n1. paragraph\nlazy continuation\n2. [Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "## Problem Statement: claim block has no source tag",
    );
  });

  test("a paragraph after a blank line does not inherit the prior list context", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [Q1]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n- item\n\nSome prose\n2. [Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass, result.findings.join("\n")).toBe(true);
    expect(result.findings).toEqual([]);
  });

  for (const [label, content] of [
    ["a same-line HTML declaration", "<!DOCTYPE html>\n[Q1]: /url"],
    ["an HTML declaration interrupting prose", "Some prose\n<!DOCTYPE html>\n[Q1]: /url"],
    ["a multiline processing instruction", "<?php\n?>\n[Q1]: /url"],
    ["an indented-code list item", "-     code\n[Q1]: /url"],
    ["an exited block quote", "> prose\n2. [Q1]: /url"],
    ["an exited quoted processing instruction", "> <?php\n[Q1]: /url"],
    ["an exited quoted div block", "> <div>\n[Q1]: /url"],
    ["an exited list-item processing instruction", "- <?php\n[Q1]: /url"],
    ["a root processing instruction containing marker-like text", "<?php\n- raw content\n?>\n[Q1]: /url"],
    ["a quoted processing instruction containing marker-like text", "> <?php\n> - raw content\n> ?>\n[Q1]: /url"],
    ["a list-item processing instruction containing marker-like text", "- <?php\n  - raw content\n  ?>\n[Q1]: /url"],
    ["an unindented quoted list-item processing instruction", "> - <?php\n> [Q1]: /url"],
    ["an exited inner quote in a list-item processing instruction", "- > <?php\n  [Q1]: /url"],
    ["an exited inline nested list-item HTML block", "- - item\n    <?php\n  [Q1]: /url"],
    ["an exited multiline nested list-item HTML block", "- item\n  - nested\n    <?php\n  [Q1]: /url"],
    ["an outer-item div following a nested item", "- outer\n  - nested\n  <div>\n[Q1]: /url"],
    ["an inner-item div following an indented nested marker", "- outer\n  - nested\n    <div>\n  [Q1]: /url"],
    ["nested bullet sibling prose", "- outer\n  - child prose\n  - [Q1]: /url"],
    ["nested ordered sibling prose", "1. outer\n   1. child prose\n   2. [Q1]: /url"],
    ["a start-one nested item interrupting prose", "- prose\n  1. [Q1]: /url"],
    ["a start-one nested item after rejected continuation", "- prose\n  2. more\n  1. [Q1]: /url"],
    ["a marker-only bullet sibling", "- prose\n*\n  [Q1]: /url"],
    ["a marker-only setext underline", "Some prose\n-\n  [Q1]: /url"],
  ] as const) {
    test(`a reference definition after ${label} resolves document-wide`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        "This is an unsupported assertion. [Q1]",
      );
      replaceInFile(
        dir,
        "intent-statement.md",
        "## Review",
        `## Review\n\n${content}`,
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "## Problem Statement: claim block has no source tag",
      );
    });
  }

  for (const [label, content] of [
    ["a blank-terminated HTML block", "<div>\n[Q1]: /url\n</div>"],
    ["a same-depth block quote", "> prose\n> 2. [Q1]: /url"],
    ["an uninterrupted quoted div block", "> <div>\n> [Q1]: /url"],
    ["an uninterrupted inner quote in a list-item processing instruction", "- > <?php\n  > [Q1]: /url"],
    ["an uninterrupted inline nested list-item HTML block", "- - item\n    <?php\n    [Q1]: /url"],
    ["a non-one nested item under prose", "- prose\n  2. [Q1]: /url"],
    ["consecutive rejected nested items", "- prose\n  2. more\n  3. [Q1]: /url"],
    ["a marker-only bullet under prose", "Some prose\n*\n  [Q1]: /url"],
  ] as const) {
    test(`a definition-shaped line in ${label} stays literal`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        "This is an unsupported assertion. [Q1]",
      );
      replaceInFile(
        dir,
        "intent-statement.md",
        "## Review",
        `## Review\n\n${content}`,
      );

      const result = run(dir);
      expect(result.pass, result.findings.join("\n")).toBe(true);
      expect(result.findings).toEqual([]);
    });
  }

  // GFM §6.9: a table continues until a blank line or another block structure.
  test("a definition-shaped line directly under a table row is a table row, not a definition", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [Q1]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n\n| Claim |\n|---|\n| Some prose |\n[Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass, result.findings.join("\n")).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("consecutive definitions after a heading are all definitions", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "## Heading\n[desc]: /a\n[Q1]: /b\n\nThis is an unsupported assertion. [desc]\n\nThis is another unsupported assertion. [Q1]",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(
      result.findings.filter((finding) => finding.includes("claim block has no source tag")),
    ).toHaveLength(2);
  });

  for (const rule of ["- - -", "* * *"]) {
    test(`a spaced thematic break '${rule}' before a definition does not hide the definition`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        "This is an unsupported assertion. [Q1]",
      );
      replaceInFile(
        dir,
        "intent-statement.md",
        "## Review",
        `## Review\n\n${rule}\n[Q1]: /url`,
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "## Problem Statement: claim block has no source tag",
      );
    });
  }

  for (const marker of ["+", "*", "1."]) {
    test(`a marker-only list item line '${marker}' before an indented definition does not hide the definition`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        "This is an unsupported assertion. [Q1]",
      );
      replaceInFile(
        dir,
        "intent-statement.md",
        "## Review",
        `## Review\n\n${marker}\n  [Q1]: /url`,
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "## Problem Statement: claim block has no source tag",
      );
    });
  }

  test("a marker-only line under open prose is paragraph text, not a list item", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [Q1]\n+\n  [Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass, result.findings.join("\n")).toBe(true);
    expect(result.findings).toEqual([]);
  });

  // Definition detection has to agree with CommonMark's definition grammar in
  // both directions. A line that only looks like a definition is prose the
  // reader sees, and a real definition stays real inside a container. Getting
  // either wrong lets unsourced or invisible-tag content through silently.
  for (const [label, line] of [
    ["an empty label", "[]: /url"],
    ["a whitespace-only label", "[   ]: /url"],
    ["an unescaped bracket in the label", "[a[b]]: /url"],
    ["trailing prose", "[evidence]: this is an unsupported assertion"],
    ["an unclosed angle-bracket destination", "[evidence]: <broken"],
    ["an unbalanced bare destination", "[evidence]: /foo(bar"],
    ["a bare destination closing a group it never opened", "[evidence]: /foo)bar"],
    ["an unescaped angle bracket in the destination", "[evidence]: <a<b>"],
    ["an inline title without separating whitespace", '[evidence]: <url>"title"'],
    ["a DEL control character in the destination", "[evidence]: foo\u007fbar"],
    ["an unescaped parenthesis in the title", "[evidence]: /url (ti(tle)"],
    [
      "an indented code block after a list marker",
      "-     [evidence]: https://example.invalid",
    ],
  ] as const) {
    test(`a definition-shaped line with ${label} is inspected as prose`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "## Assumptions & Open Questions",
        `${line}\n\n## Assumptions & Open Questions`,
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "claim block has no source tag",
      );
    });
  }

  test("a four-space-indented top-level definition is inspected as code", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "    [evidence]: /url",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("a tab-indented top-level definition is inspected as code", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "\t[evidence]: /url",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("an inline title leaves the following quoted assertion visible", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Assumptions & Open Questions",
      '[evidence]: /url "title"\n"This is an unsupported assertion."\n\n## Assumptions & Open Questions',
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("a multiline definition resolves shortcut references document-wide", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "The initiative provides a local command that echoes supplied text. [desc]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n[desc]:\n/url",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("a multiline destination inherits its parent list-item context", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [desc][Q1]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n- [Q1]:\n  /url",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("a reference title may span physical lines", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [desc][Q1]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      '## Review\n[Q1]: /url "title\ncontinued"',
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("reference-label length counts Unicode code points", () => {
    const dir = makeStageDir();
    const astralLabel = String.fromCodePoint(0x1f600).repeat(500);
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      `This is an unsupported assertion. [Q1][${astralLabel}]`,
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      `## Review\n[${astralLabel}]: /url`,
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("a bare destination nested 33 levels is inspected as prose", () => {
    const dir = makeStageDir();
    const destination = `a${"(".repeat(33)}b${")".repeat(33)}`;
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      `[evidence]: ${destination}`,
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("ordered-list items ending in a parenthesis are separate claims", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      '1) [evidence]: /url\n2) "This is an unsupported assertion."',
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("an indented definition inherits its parent list-item context", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "- [desc]\n\n    [Q1]: /url\n\nThis is an unsupported assertion. [desc][Q1]",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("a multiline reference label resolves after whitespace normalization", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [desc][foo bar]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n[foo\nbar]: /url",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("reference labels use Unicode full case folding", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "[ss]: /url\n\nThis is an unsupported assertion. [desc][\u1e9e]",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  for (const [label, definition] of [
    ["a list nested in a block quote", "> - [Q1]:\n>   /url"],
    ["a block quote nested in a list", "- > [Q1]:\n  > /url"],
    ["a tab-indented list continuation", "- [Q1]:\n\t/url"],
  ] as const) {
    test(`a multiline destination preserves ${label}`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        "This is an unsupported assertion. [desc][Q1]",
      );
      replaceInFile(
        dir,
        "intent-statement.md",
        "## Review",
        `## Review\n${definition}`,
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "claim block has no source tag",
      );
    });
  }

  test("a multiline label cannot cross an ATX heading", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "[Q1\n## Unsupported assertion]: /url",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("a multiline title cannot cross a thematic break", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      '[Q1]: /url "title\n---\nThis is an unsupported assertion."',
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("an HTML block interrupts a malformed multiline title", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      '[Q1]: /url "title\n<div>\nThis is an unsupported assertion."',
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  test("an asterisk thematic break interrupts a malformed multiline title", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      '[Q1]: /url "title\n***\nThis is an unsupported assertion."',
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  for (const [label, definition, reference] of [
    ["destination", "[Q1]:\n    /url", "[desc][Q1]"],
    ["label", "[foo\n    bar]: /url", "[desc][foo bar]"],
  ] as const) {
    test(`a multiline reference ${label} permits lazy indentation`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        `This is an unsupported assertion. ${reference}`,
      );
      replaceInFile(
        dir,
        "intent-statement.md",
        "## Review",
        `## Review\n${definition}`,
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "claim block has no source tag",
      );
    });
  }

  test("an outer block-quote blank preserves the active list item", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
      "This is an unsupported assertion. [desc][Q1]",
    );
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Review",
      "## Review\n> - [desc]\n>\n>     [Q1]: /url",
    );

    const result = run(dir);
    expect(result.pass).toBe(false);
    expect(result.findings.join("\n")).toContain(
      "claim block has no source tag",
    );
  });

  for (const [label, definition] of [
    ["a nested list", "- - [Q1]:\n    /url"],
    ["a nested list inside a block quote", "> - - [Q1]:\n>     /url"],
    ["a nested list around a block quote", "- > - [Q1]:\n  >   /url"],
    ["an elided list marker", "- [Q1]:\n/url"],
    ["an elided block-quote marker", "> [Q1]:\n/url"],
    ["elided quote and list markers", "> - [Q1]:\n    /url"],
  ] as const) {
    test(`a multiline destination preserves ${label}`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        "This is an unsupported assertion. [desc][Q1]",
      );
      replaceInFile(
        dir,
        "intent-statement.md",
        "## Review",
        `## Review\n${definition}`,
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "claim block has no source tag",
      );
    });
  }

  test("a bare destination nested 32 levels remains a definition", () => {
    const dir = makeStageDir();
    const destination = `a${"(".repeat(32)}b${")".repeat(32)}`;
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Assumptions & Open Questions",
      `[evidence]: ${destination}\n\n## Assumptions & Open Questions`,
    );

    const result = run(dir);
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
  });

  for (const [label, definition] of [
    ["a block quote", "> [Q1]: https://example.invalid"],
    ["a list item", "- [Q1]: https://example.invalid"],
    ["a block quote inside a list item", "- > [Q1]: https://example.invalid"],
    ["a list item inside a block quote", "> - [Q1]: https://example.invalid"],
  ] as const) {
    test(`a definition inside ${label} still turns its reference into a link`, () => {
      const dir = makeStageDir();
      replaceInFile(
        dir,
        "intent-statement.md",
        "The initiative provides a local command that echoes supplied text. [desc] [Q1]",
        "The initiative provides a local command that echoes supplied text. [desc][Q1]",
      );
      const statementPath = join(dir, "intent-statement.md");
      writeFileSync(
        statementPath,
        `${readFileSync(statementPath, "utf-8")}\n${definition}\n`,
        "utf-8",
      );

      const result = run(dir);
      expect(result.pass).toBe(false);
      expect(result.findings.join("\n")).toContain(
        "claim block has no source tag",
      );
    });
  }

  test("a link reference definition is not itself a claim block", () => {
    const dir = makeStageDir();
    replaceInFile(
      dir,
      "intent-statement.md",
      "## Assumptions & Open Questions",
      "[evidence]: https://example.invalid\n\n## Assumptions & Open Questions",
    );

    const result = run(dir);
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
  });
});
