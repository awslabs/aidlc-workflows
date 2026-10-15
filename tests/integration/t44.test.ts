// covers: function:parseStageFrontmatter
//
// Mechanism = none. This is a stage-instruction completeness
// check: it reads the shipped stage `.md` files (under
// dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md) to verify each
// stage's prose actually mentions the outputs it declares, the state it
// updates, its skip condition (when CONDITIONAL), its output directory, and an
// approval mechanism. Two of its three derived predicates run THROUGH the pure
// `parseStageFrontmatter` function (aidlc-lib.ts) - `is_conditional` reads
// `obj.execution`, and `has_question_output` reads `obj.outputs` then extracts
// the *.md filenames — so the covers id is `function:parseStageFrontmatter`,
// the library function this test drives.
//
// MECHANISM DETAIL: every check is an in-process call: parseStageFrontmatter
// is a PURE function (aidlc-lib.ts "Pure - no I/O, no validation"), and
// the rest is regex scans over file bytes read with readFileSync. We IMPORT
// parseStageFrontmatter directly and run three helpers against its real return
// value (getOutputFilenames / isConditional / hasQuestionOutput). Zero
// subprocess, zero LLM, zero tokens.
//
// FIXTURE DISCIPLINE: the shipped stage files are read in place (no temp
// project). Nothing is written; no temp dirs; no fixtures touched.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const STAGES_DIR = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "aidlc-common",
  "stages",
);

function findStageFile(slug: string): string {
  for (const phase of readdirSync(STAGES_DIR)) {
    const dir = join(STAGES_DIR, phase);
    if (!statSync(dir).isDirectory()) continue;
    const f = join(dir, `${slug}.md`);
    if (existsSync(f)) return f;
  }
  throw new Error(`stage file not found for slug: ${slug}`);
}

const read = (f: string): string => readFileSync(f, "utf-8");

/**
 * A `grep -q`-style presence test over the file bytes. Filename patterns escape
 * their dots so the literal filename, not any character, is the contract.
 */
function fileMatches(f: string, re: RegExp): boolean {
  return re.test(read(f));
}

function getOutputFilenames(f: string): string[] {
  const obj = parseStageFrontmatter(read(f));
  const s = typeof obj.outputs === "string" ? obj.outputs : "";
  return s.match(/[a-z][a-z0-9-]*\.md/g) ?? [];
}

function isConditional(f: string): boolean {
  const obj = parseStageFrontmatter(read(f));
  return (typeof obj.execution === "string" ? obj.execution : "") === "CONDITIONAL";
}

function hasQuestionOutput(f: string): boolean {
  return getOutputFilenames(f).some((m) => m.includes("questions"));
}

describe("t44 stage-instruction completeness — parseStageFrontmatter (migrated from t44-stage-instruction-completeness.sh, plan 41)", () => {
  // ============================================================
  // Tests 1-10: key output filenames appear in stage steps
  // ============================================================

  test("1: intent-capture steps mention intent-statement.md", () => {
    expect(fileMatches(findStageFile("intent-capture"), /intent-statement\.md/)).toBe(true);
  });

  test("2: intent-capture steps mention stakeholder-map.md", () => {
    expect(fileMatches(findStageFile("intent-capture"), /stakeholder-map\.md/)).toBe(true);
  });

  test("3: requirements-analysis steps mention requirements.md", () => {
    expect(fileMatches(findStageFile("requirements-analysis"), /requirements\.md/)).toBe(true);
  });

  test("4: scope-definition steps mention scope-document.md", () => {
    expect(fileMatches(findStageFile("scope-definition"), /scope-document\.md/)).toBe(true);
  });

  test("5: domain-design steps mention components.md", () => {
    expect(fileMatches(findStageFile("domain-design"), /components\.md/)).toBe(true);
  });

  test("6: units-generation steps mention unit-of-work.md", () => {
    expect(fileMatches(findStageFile("units-generation"), /unit-of-work\.md/)).toBe(true);
  });

  test("7: delivery-planning steps mention bolt-plan.md", () => {
    expect(fileMatches(findStageFile("delivery-planning"), /bolt-plan\.md/)).toBe(true);
  });

  test("7a: delivery-planning steps mention risk-and-sequencing-rationale.md", () => {
    expect(
      fileMatches(findStageFile("delivery-planning"), /risk-and-sequencing-rationale\.md/),
    ).toBe(true);
  });

  test("7b: delivery-planning steps mention external-dependency-map.md", () => {
    expect(
      fileMatches(findStageFile("delivery-planning"), /external-dependency-map\.md/),
    ).toBe(true);
  });

  test("8: feasibility steps mention feasibility-assessment.md", () => {
    expect(fileMatches(findStageFile("feasibility"), /feasibility-assessment\.md/)).toBe(true);
  });

  // ============================================================
  // Tests 11-17: QUESTION_STAGES mention [Answer]: format or via stage-protocol
  // (drives parseStageFrontmatter via has_question_output -> get_output_filenames)
  // ============================================================

  const QUESTION_STAGES = [
    "intent-capture",
    "market-research",
    "feasibility",
    "scope-definition",
    "requirements-analysis",
    "approval-handoff",
    "delivery-planning",
  ] as const;
  const QUESTION_FORMAT = /\[Answer\]|question.*format|stage-protocol.*question/i;

  for (const slug of QUESTION_STAGES) {
    test(`question format: ${slug} mentions [Answer]: or via stage-protocol`, () => {
      const f = findStageFile(slug);
      // Pin the question-output precondition: all 7 stages declare a *-questions.md
      // output on disk.
      expect(hasQuestionOutput(f)).toBe(true);
      expect(fileMatches(f, QUESTION_FORMAT)).toBe(true);
    });
  }

  // ============================================================
  // Tests 18-23: initialization owns its state writes; all later stages report
  // outcomes through the orchestration engine.
  // ============================================================

  const STATE_UPDATE_STAGES = [
    "workspace-scaffold",
    "workspace-detection",
    "state-init",
  ] as const;
  const ENGINE_REPORT_STAGES = [
    "intent-capture",
    "requirements-analysis",
    "reverse-engineering",
  ] as const;
  const STATE_RE = /aidlc-state|update state/i;

  for (const slug of STATE_UPDATE_STAGES) {
    test(`state update: ${slug} steps mention state update`, () => {
      expect(fileMatches(findStageFile(slug), STATE_RE)).toBe(true);
    });
  }
  const ENGINE_REPORT_RE =
    /(?:aidlc-orchestrate\.ts|engine orchestrate)\s+report\s+--stage|engine-owned.*report/i;

  for (const slug of ENGINE_REPORT_STAGES) {
    test(`engine-owned transition: ${slug} steps report the stage outcome`, () => {
      expect(fileMatches(findStageFile(slug), ENGINE_REPORT_RE)).toBe(true);
    });
  }

  // ============================================================
  // Tests 24-30: CONDITIONAL_STAGES document skip condition
  // (drives parseStageFrontmatter via is_conditional)
  // ============================================================

  const CONDITIONAL_STAGES = [
    "reverse-engineering",
    "practices-discovery",
    "feasibility",
    "market-research",
    "team-formation",
    "rough-mockups",
    "ci-pipeline",
  ] as const;
  const SKIP_RE = /skip/i;

  for (const slug of CONDITIONAL_STAGES) {
    test(`conditional skip: ${slug} (CONDITIONAL) documents skip condition`, () => {
      const f = findStageFile(slug);
      // Pin the CONDITIONAL branch (execution === "CONDITIONAL"); all 7 are
      // CONDITIONAL.
      expect(isConditional(f)).toBe(true);
      expect(fileMatches(f, SKIP_RE)).toBe(true);
    });
  }

  // ============================================================
  // Tests 31-34: construction stages mention <record>/construction/
  // ============================================================

  // Each per-unit construction stage writes under the per-unit record dir
  // `<record>/construction/{unit-name}/<stage>/`, so its body cites
  // `<record>/construction`.
  for (const slug of ["functional-design", "nfr-requirements", "nfr-design", "code-generation"]) {
    test(`construction dir: ${slug} mentions <record>/construction/`, () => {
      expect(fileMatches(findStageFile(slug), /<record>\/construction/i)).toBe(true);
    });
  }

  // ============================================================
  // Tests 35-37: operation stages mention <record>/operation/
  // ============================================================

  for (const slug of ["deployment-pipeline", "observability-setup", "incident-response"]) {
    test(`operation dir: ${slug} mentions <record>/operation/`, () => {
      expect(fileMatches(findStageFile(slug), /<record>\/operation/i)).toBe(true);
    });
  }

  // ============================================================
  // Test 38: most approval-gate stages mention approval mechanism (assert_gt 4)
  // ============================================================

  test("38: most approval-gate stages mention approval mechanism (> 4)", () => {
    const APPROVAL_STAGES = [
      "intent-capture",
      "requirements-analysis",
      "reverse-engineering",
      "domain-design",
      "delivery-planning",
      "approval-handoff",
    ];
    const APPROVAL_RE = /AskUserQuestion|approval|approve/i;
    let count = 0;
    for (const slug of APPROVAL_STAGES) {
      if (fileMatches(findStageFile(slug), APPROVAL_RE)) count++;
    }
    expect(count).toBeGreaterThan(4);
    expect(count).toBe(6);
  });

  // ============================================================
  // Test 39: build-and-test mentions testing in steps
  // ============================================================

  test("39: build-and-test stage mentions testing in steps", () => {
    expect(fileMatches(findStageFile("build-and-test"), /test/i)).toBe(true);
  });

  // ============================================================
  // Test 40: reverse-engineering steps mention architecture.md
  // ============================================================

  test("40: reverse-engineering steps mention architecture.md", () => {
    expect(fileMatches(findStageFile("reverse-engineering"), /architecture\.md/)).toBe(true);
  });

  // ============================================================
  // Test 41: code-generation steps mention code-summary.md
  // ============================================================

  test("41: code-generation steps mention code-summary.md", () => {
    expect(fileMatches(findStageFile("code-generation"), /code-summary\.md/)).toBe(true);
  });
});
