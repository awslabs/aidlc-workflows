// covers: file:aidlc-common/stages/construction/build-and-test.md, file:aidlc-common/stages/construction/ci-pipeline.md, file:aidlc-common/stages/construction/code-generation.md, file:aidlc-common/stages/construction/functional-design.md, file:aidlc-common/stages/construction/infrastructure-design.md, file:aidlc-common/stages/construction/nfr-design.md, file:aidlc-common/stages/construction/nfr-requirements.md, file:aidlc-common/stages/ideation/approval-handoff.md, file:aidlc-common/stages/ideation/feasibility.md, file:aidlc-common/stages/ideation/intent-capture.md, file:aidlc-common/stages/ideation/market-research.md, file:aidlc-common/stages/ideation/rough-mockups.md, file:aidlc-common/stages/ideation/scope-definition.md, file:aidlc-common/stages/ideation/team-formation.md, file:aidlc-common/stages/inception/application-design.md, file:aidlc-common/stages/inception/delivery-planning.md, file:aidlc-common/stages/inception/practices-discovery.md, file:aidlc-common/stages/inception/refined-mockups.md, file:aidlc-common/stages/inception/requirements-analysis.md, file:aidlc-common/stages/inception/reverse-engineering.md, file:aidlc-common/stages/inception/units-generation.md, file:aidlc-common/stages/inception/user-stories.md, file:aidlc-common/stages/initialization/state-init.md, file:aidlc-common/stages/initialization/workspace-detection.md, file:aidlc-common/stages/initialization/workspace-scaffold.md, file:aidlc-common/stages/operation/deployment-execution.md, file:aidlc-common/stages/operation/deployment-pipeline.md, file:aidlc-common/stages/operation/environment-provisioning.md, file:aidlc-common/stages/operation/feedback-optimization.md, file:aidlc-common/stages/operation/incident-response.md, file:aidlc-common/stages/operation/observability-setup.md, file:aidlc-common/stages/operation/performance-validation.md
//
// t87 — shipped stage-file COMPARTMENT-HEADER contract. Migrated from
// tests/unit/t87-stage-compartment-headers.sh (TAP plan 64 — 2 distinct
// assertions per stage file across the 32 stages under aidlc-common/stages/).
// The .sh resolved STAGES_DIR = $AIDLC_SRC/aidlc-common/stages and, for every
// *.md in every phase subdir, asserted that BOTH a "## Sensors" and a
// "## Learn" H2 heading appear OUTSIDE fenced code blocks. (The .sh's header
// line called these "compartments"; a heading inside a triple-backtick fence
// is documentation, not a real compartment.)
//
// Mechanism: none. This is a pure structural check over the shipped bytes —
// does each stage file expose its two required compartment headings? No process
// boundary, no argv/exit/stdout seam, no LLM, zero tokens. We resolve the same
// tree the .sh resolved (AIDLC_SRC = <repo>/dist/claude/.claude, fixtures.ts:42)
// and read each .md in-process.
//
// The .sh has NO "# covers:" header (line 2 is a plain description). The covers
// ids above are therefore derived from the SUBJECT it inspects — the 32 shipped
// stage .md files — using the same "file:<path-under-dist/claude/.claude>"
// form the sibling structural twins use (t01-file-structure.test.ts,
// t04-agent-frontmatter.test.ts). The registry joins on these ids.
//
// Subject under test (dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md):
//   - Each stage file MUST contain a line that is EXACTLY "## Sensors", outside
//     any triple-backtick fenced code block (the Sensors compartment — where the
//     stage declares its "sensors:" bindings narrative).
//   - Each stage file MUST contain a line that is EXACTLY "## Learn", outside
//     any triple-backtick fenced code block (the Learn compartment — §13
//     learnings capture).
//
// Faithful port of the .sh's fence-aware awk walker (t87.sh:15-22):
//   the awk program flips a "fenced" flag on every line that starts with the
//   triple-backtick fence and skips it; otherwise, when NOT fenced and the whole
//   line equals the target heading, it records a hit and exits 0 (else exits 1).
// The walker toggles "fenced" at every fence-prefixed line and only matches the
// heading when NOT inside a fence. The match is the WHOLE-LINE equality (awk's
// $0 == h, anchored both ends), so "## Sensors and more" would not satisfy it.
// headingOutsideFence() below reimplements that exactly — STRONGER than a bare
// grep "^## Sensors" because (a) it honours the fence guard and (b) it requires
// the line to equal the heading, not merely start with it.
//
// Old TAP -> new test parity (the .sh emitted 2 "ok" lines PER stage in a single
// nested loop — 2 × 32 = 64. Here each of the 2 invariants is one test() that
// asserts across ALL 32 stages via a block-scoped expect() per stage, so every
// one of the 64 .sh rows maps to a named expect(). The final test re-counts to
// pin the plan):
//   .sh L29-34 (## Sensors compartment present, outside fence) -> "every stage has a ## Sensors compartment heading (outside fenced code)" [32 expects]
//   .sh L36-41 (## Learn compartment present, outside fence)   -> "every stage has a ## Learn compartment heading (outside fenced code)"   [32 expects]
//   .sh L10    plan 64                                          -> "covers EXACTLY 32 stages × 2 compartments = 64 assertions (TAP plan parity)"

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same tree the .sh resolved as
// STAGES_DIR's grandparent.
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");

/**
 * Discover every stage .md under aidlc-common/stages/<phase>/, the SAME walk
 * the .sh did (its nested globs: for phase_dir in STAGES_DIR/*; for stage_file
 * in phase_dir/*.md). Discovery, not a hard-coded list, so a newly-added stage
 * is automatically held to the contract (and counted by the plan-parity test).
 * Returns { phase, slug, path } sorted by phase then slug for stable reporting.
 */
function discoverStageFiles(): { phase: string; slug: string; path: string }[] {
  const out: { phase: string; slug: string; path: string }[] = [];
  for (const phase of readdirSync(STAGES_DIR).sort()) {
    const phaseDir = join(STAGES_DIR, phase);
    if (!statSync(phaseDir).isDirectory()) continue;
    for (const entry of readdirSync(phaseDir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const path = join(phaseDir, entry);
      if (!statSync(path).isFile()) continue;
      out.push({ phase, slug: entry.slice(0, -".md".length), path });
    }
  }
  return out;
}

const FENCE = "```"; // triple backtick — the code-fence delimiter the awk walker toggled on.

/**
 * Faithful TS port of t87.sh's heading_outside_fence() awk walker. Returns true
 * iff a line EXACTLY equal to the heading appears outside any triple-backtick
 * fenced code block. Toggling "fenced" on every line that starts with the fence
 * delimiter mirrors the awk rule that flips its flag on a fence line and skips
 * it; the whole-line equality mirrors awk's $0 == h.
 */
function headingOutsideFence(heading: string, fileBody: string): boolean {
  let fenced = false;
  for (const rawLine of fileBody.split("\n")) {
    // awk reads lines without the trailing \n; a CRLF file would leave a \r.
    // Strip it so the whole-line equality matches the heading the same way
    // awk's record (sans record separator) would.
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith(FENCE)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && line === heading) return true;
  }
  return false;
}

const STAGE_FILES = discoverStageFiles();

describe("t87 stage-file compartment headers (migrated from t87-stage-compartment-headers.sh, plan 64)", () => {
  // .sh L29-34: heading_outside_fence "## Sensors" on each stage file.
  test("every stage has a ## Sensors compartment heading (outside fenced code) [.sh test 1 ×32]", () => {
    for (const { phase, slug, path } of STAGE_FILES) {
      // Sanity: the file the .sh walked must exist.
      expect(existsSync(path), `${phase}/${slug}.md missing`).toBe(true);
      const body = readFileSync(path, "utf-8");
      expect(
        headingOutsideFence("## Sensors", body),
        `${phase}/${slug}.md: no '## Sensors' compartment heading found outside fenced code blocks`,
      ).toBe(true);
    }
  });

  // .sh L36-41: heading_outside_fence "## Learn" on each stage file.
  test("every stage has a ## Learn compartment heading (outside fenced code) [.sh test 2 ×32]", () => {
    for (const { phase, slug, path } of STAGE_FILES) {
      const body = readFileSync(path, "utf-8");
      expect(
        headingOutsideFence("## Learn", body),
        `${phase}/${slug}.md: no '## Learn' compartment heading found outside fenced code blocks`,
      ).toBe(true);
    }
  });

  // The fence guard is a behavioural guarantee the .sh's awk carried, even
  // though no shipped stage currently hides a heading inside a fence. Pin it
  // directly so a future regression that buries "## Sensors" in a code fence
  // (and removes the real one) is caught: a heading that exists ONLY inside a
  // fence must NOT satisfy the check.
  test("fence guard: a heading appearing ONLY inside a code fence does NOT count (matches the .sh awk walker)", () => {
    const insideFenceOnly = [`${FENCE}md`, "## Sensors", "## Learn", FENCE, "body"].join("\n");
    expect(headingOutsideFence("## Sensors", insideFenceOnly)).toBe(false);
    expect(headingOutsideFence("## Learn", insideFenceOnly)).toBe(false);
    // And a real heading OUTSIDE the fence is still found even when an identical
    // line is also fenced earlier.
    const realOutside = [`${FENCE}md`, "## Sensors", FENCE, "## Sensors", "real"].join("\n");
    expect(headingOutsideFence("## Sensors", realOutside)).toBe(true);
    // Whole-line equality: a heading with trailing text must NOT match.
    expect(headingOutsideFence("## Sensors", "## Sensors and friends\n")).toBe(false);
  });

  // .sh L10: plan 64. Re-count to pin the plan and guard against a stage being
  // silently dropped from (or added to) the shipped tree without the suite
  // noticing (2 compartments × 32 stages = 64 rows).
  test("covers EXACTLY 32 stages × 2 compartments = 64 assertions (TAP plan parity)", () => {
    const COMPARTMENTS_PER_STAGE = 2;
    expect(STAGE_FILES.length).toBe(32);
    expect(STAGE_FILES.length * COMPARTMENTS_PER_STAGE).toBe(64);
    // Five phases, each with at least one stage (no empty phase dir slipped in).
    const phases = new Set(STAGE_FILES.map((s) => s.phase));
    expect(phases).toEqual(
      new Set(["construction", "ideation", "inception", "initialization", "operation"]),
    );
  });
});
