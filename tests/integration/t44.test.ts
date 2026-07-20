// covers: function:parseStageFrontmatter
//
// In-process port of tests/integration/t44-stage-instruction-completeness.sh
// (TAP plan 41), mechanism = none. The .sh is a stage-instruction completeness
// check: it greps the shipped stage `.md` files (under
// dist/claude/.claude/skills/aidlc/stages/<phase>/<slug>.md) to verify each
// stage's prose actually mentions the outputs it declares, the state it
// updates, its skip condition (when CONDITIONAL), its output directory, and an
// approval mechanism. Two of its three derived predicates run THROUGH the pure
// `parseStageFrontmatter` function (aidlc-lib.ts:893) — `is_conditional` reads
// `obj.execution`, and `has_question_output` reads `obj.outputs` then extracts
// the *.md filenames — so the covers id is `function:parseStageFrontmatter`,
// the sole library function the .sh drives.
//
// MECHANISM = none. The .sh's three helpers each spawned `bun -e` to import
// parseStageFrontmatter from aidlc-lib.ts and project a scalar. parseStageFrontmatter
// is a PURE function (aidlc-lib.ts:884-886 "Pure — no I/O, no validation"), and
// the rest of the .sh is plain `grep`/`grep -i` over file content. So every one
// of the 41 contracts migrates to in-process: we IMPORT parseStageFrontmatter
// directly and re-implement the .sh's three helpers against its real return
// value (get_output_filenames / is_conditional / has_question_output), and we
// re-implement assert_grep / the `grep -i` checks as regex scans over the file
// bytes read with readFileSync. Zero subprocess, zero LLM, zero tokens. An
// in-process twin loses nothing: the .sh's `bun -e` shell existed only because
// bash cannot import TypeScript — it was never a process-boundary contract.
//
// GREP FIDELITY. The .sh used `grep -q "$pattern"` (BRE) and `grep -qi`
// (case-insensitive BRE). We mirror each exactly:
//   - assert_grep "$f" "intent-statement.md"  -> fileMatches(f, /intent-statement.md/)
//       NB: the unescaped `.` in the .sh pattern is a BRE any-char; the literal
//       dot in the filename satisfies it, so a JS regex with an unescaped `.`
//       reproduces the SAME match set. Test 3 used "requirements\.md" (escaped);
//       we escape there too. Same observable either way (the filename is present).
//   - grep -qi "aidlc-state\|Update State"     -> /aidlc-state|update state/i
//   - grep -qi "[Ss]kip"                        -> /skip/i (the [Ss] is redundant
//       under -i; /skip/i is the identical match set).
//   - grep -qi '\[Answer\]\|question.*format\|stage-protocol.*question'
//       -> /\[Answer\]|question.*format|stage-protocol.*question/i
//   - grep -qi "AskUserQuestion\|[Aa]pproval\|[Aa]pprove" -> matching /i alternation.
//
// PARITY NOTES — every .sh `ok` line (plan 41) maps to one expect()-bearing
// test() below; several are STRONGER than the original bare presence grep:
//   - .sh Tests 1-10  (key output filenames in steps)        -> "key output
//       filenames" describe block, 10 cases — same grep observable.
//   - .sh Tests 11-17 (QUESTION_STAGES question-format loop)  -> "question
//       format" block, 7 cases. STRONGER: each case ALSO asserts the stage HAS
//       a question output (has_question_output === true) before checking the
//       format reference, pinning the branch the .sh's `if` only implicitly took
//       (all 7 have a *-questions.md output, verified on disk).
//   - .sh Tests 18-23 (STATE_UPDATE_STAGES)                   -> "state update"
//       block, 6 cases.
//   - .sh Tests 24-30 (CONDITIONAL_STAGES skip)               -> "conditional
//       skip" block, 7 cases. STRONGER: each ALSO asserts is_conditional === true
//       (execution === "CONDITIONAL") before the skip grep — the .sh's `if`
//       branch is pinned, not assumed. All 7 are CONDITIONAL on disk.
//   - .sh Tests 31-34 (construction output dir)               -> 4 cases.
//   - .sh Tests 35-37 (operation output dir)                  -> 3 cases.
//   - .sh Test 38 assert_gt APPROVAL_COUNT 4                   -> "approval
//       mechanism" case: count stages mentioning approval, expect > 4. STRONGER:
//       we ALSO assert the count is exactly 6 (all six approval-gate stages
//       mention a mechanism on disk) — the .sh only checked > 4.
//   - .sh Test 39 build-and-test mentions "test"              -> 1 case.
//   - .sh Test 40 reverse-engineering mentions architecture.md -> 1 case.
//   - .sh Test 41 code-generation mentions code-summary.md     -> 1 case.
//
// 41 .sh asserts -> 41 expect()-bearing test() cases (10+7+6+7+4+3+1+1+1+1).
//
// FIXTURE DISCIPLINE: the .sh read the SHIPPED stage files in place (no temp
// project, no create_test_project) — STAGES_DIR = $AIDLC_SRC/skills/aidlc/stages.
// We read the same shipped files under dist/claude/.claude/skills/aidlc/stages.
// Nothing is written; no temp dirs; no fixtures touched.

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

/** find_stage_file (t44:14-24): locate <phase>/<slug>.md under STAGES_DIR. */
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
 * assert_grep semantics: `grep -q "$pattern" "$file"`. The .sh used BRE; for the
 * filename patterns an unescaped `.` is BRE any-char that the literal dot
 * satisfies, so a JS regex with the same source reproduces the match set.
 */
function fileMatches(f: string, re: RegExp): boolean {
  return re.test(read(f));
}

/**
 * get_output_filenames (t44:28-37): parseStageFrontmatter the file, take the
 * `outputs` scalar (string), extract every /[a-z][a-z0-9-]*\.md/ token. Drives
 * the covers target parseStageFrontmatter.
 */
function getOutputFilenames(f: string): string[] {
  const obj = parseStageFrontmatter(read(f));
  const s = typeof obj.outputs === "string" ? obj.outputs : "";
  return s.match(/[a-z][a-z0-9-]*\.md/g) ?? [];
}

/** is_conditional (t44:40-49): parseStageFrontmatter -> obj.execution === "CONDITIONAL". */
function isConditional(f: string): boolean {
  const obj = parseStageFrontmatter(read(f));
  return (typeof obj.execution === "string" ? obj.execution : "") === "CONDITIONAL";
}

/** has_question_output (t44:52-54): any extracted output filename contains "questions". */
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

  test("5: application-design steps mention components.md", () => {
    expect(fileMatches(findStageFile("application-design"), /components\.md/)).toBe(true);
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
      // STRONGER: pin the branch the .sh's `if has_question_output` only
      // implicitly took. All 7 declare a *-questions.md output on disk.
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
    /aidlc-orchestrate\.ts\s+report\s+--stage|engine-owned.*report/i;

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
  const SKIP_RE = /skip/i; // mirrors grep -qi "[Ss]kip"

  for (const slug of CONDITIONAL_STAGES) {
    test(`conditional skip: ${slug} (CONDITIONAL) documents skip condition`, () => {
      const f = findStageFile(slug);
      // STRONGER: pin the CONDITIONAL branch (execution === "CONDITIONAL") the
      // .sh's `if is_conditional` only implicitly took. All 7 are CONDITIONAL.
      expect(isConditional(f)).toBe(true);
      expect(fileMatches(f, SKIP_RE)).toBe(true);
    });
  }

  // ============================================================
  // Tests 31-34: construction stages mention <record>/construction/
  // ============================================================

  // Rerooted: flat aidlc-docs/construction/ -> per-intent <record>/construction/.
  // The per-unit construction stages now write under
  // `<record>/construction/{unit-name}/<stage>/` (e.g. functional-design.md:103,
  // nfr-requirements.md, nfr-design.md, code-generation.md), so the body cites
  // `<record>/construction` rather than the old flat root.
  for (const slug of ["functional-design", "nfr-requirements", "nfr-design", "code-generation"]) {
    test(`construction dir: ${slug} mentions <record>/construction/`, () => {
      expect(fileMatches(findStageFile(slug), /<record>\/construction/i)).toBe(true);
    });
  }

  // ============================================================
  // Tests 35-37: operation stages mention <record>/operation/
  // ============================================================

  // Rerooted: flat aidlc-docs/operation/ -> per-intent <record>/operation/. The
  // operation stages now cite `<record>/operation` in their body prose
  // (deployment-pipeline.md, observability-setup.md, incident-response.md).
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
      "application-design",
      "delivery-planning",
      "approval-handoff",
    ];
    const APPROVAL_RE = /AskUserQuestion|approval|approve/i;
    let count = 0;
    for (const slug of APPROVAL_STAGES) {
      if (fileMatches(findStageFile(slug), APPROVAL_RE)) count++;
    }
    expect(count).toBeGreaterThan(4); // .sh observable: assert_gt 4
    // STRONGER: all six on disk mention a mechanism; the .sh only checked > 4.
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
