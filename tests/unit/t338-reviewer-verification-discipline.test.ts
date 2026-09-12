// covers: file:agents/aidlc-architecture-reviewer-agent.md,
// file:agents/aidlc-product-lead-agent.md
//
// Pins the reviewer verification discipline in the two review-only personas.
// The adversarial contract (t234) fixes the posture - refute, ground findings
// in evidence - and the turn budget (t279) fixes the cutoff plan. Neither says
// what the reviewer owes BETWEEN those two: that an unread section cannot count
// toward READY, that a suspected gap is looked up under its alternative names
// before it is charged to the author, that findings are ranked by what breaks,
// and that a pre-verdict checklist is confirmed line by line. Without that
// text the observed degradation is silent: turns run out, nothing was flagged,
// and READY is written over material nobody read.
//
// Mechanism = none: pure text invariants over authored files plus the shipped
// dist/claude projection (the other trees come from the same generated source,
// so one projection pin suffices). A rewording should update these pins
// deliberately, not drop the discipline.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const REVIEWERS = [
  "aidlc-architecture-reviewer-agent.md",
  "aidlc-product-lead-agent.md",
] as const;

const corePath = (file: string) => join(REPO_ROOT, "core", "agents", file);
const distPath = (file: string) =>
  join(REPO_ROOT, "dist", "claude", ".claude", "agents", file);

const SECTION = "## Verification Discipline";

// The section body: from its heading to the next H2.
function section(src: string): string {
  const start = src.indexOf(SECTION);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + SECTION.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("t338 reviewer verification discipline pins", () => {
  for (const file of REVIEWERS) {
    describe(file, () => {
      const src = readFileSync(corePath(file), "utf-8");

      test("carries the section between Advisory Dispatch and Key Principles", () => {
        const advisory = src.indexOf("## Advisory Dispatch");
        const discipline = src.indexOf(SECTION);
        const principles = src.indexOf("## Key Principles");
        expect(advisory).toBeGreaterThan(-1);
        expect(discipline).toBeGreaterThan(advisory);
        expect(principles).toBeGreaterThan(discipline);
        // Exactly one such section - a duplicate would split the checklist.
        expect(src.indexOf(SECTION, discipline + 1)).toBe(-1);
      });

      test("verify-before-pass: unread material never counts toward READY", () => {
        const body = section(src);
        expect(body).toContain("Verify before you flag AND before you pass");
        expect(body).toContain('Never let the turn budget turn "unread" into "fine"');
      });

      test("presentation earns no credit: the lead is itself a sub-agent", () => {
        const body = section(src);
        expect(body).toContain("Presentation earns no credit");
        expect(body).toContain("is itself a sub-agent");
      });

      test("a suspected gap is looked up before it is charged to the author", () => {
        const body = section(src);
        expect(body).toContain("hold at least two readings");
        expect(body).toContain("Rule the alternatives out with a lookup");
      });

      test("findings are ranked before they are written", () => {
        const body = section(src);
        expect(body).toMatch(/Rank findings by .* before writing/);
        expect(body).toContain("Lead with the first class");
      });

      test("pre-verdict checklist is a checkbox list of at least six lines", () => {
        const body = section(src);
        expect(body).toContain("Before you write the verdict, confirm every line:");
        const boxes = body.match(/^- \[ \] /gm) ?? [];
        expect(boxes.length).toBeGreaterThanOrEqual(6);
        // Every NOT-READY finding needs an anchor - the t234 evidence rule,
        // restated as a checkbox the reviewer ticks.
        expect(body).toContain(
          "- [ ] Every NOT-READY finding names a checkable anchor",
        );
        // Unverified concerns route to questions, the same channel the Turn
        // Budget names when turns run short - the two sections must agree.
        expect(body).toContain(
          "appear as questions in the findings list, not as verdict-bearing findings",
        );
      });

      test("the pinned adversarial, output-contract, and turn-budget text survives", () => {
        expect(src).toContain("## Adversarial Posture");
        expect(src).toContain("## Output Contract");
        expect(src).toContain("## Turn Budget");
        expect(src).toContain(`**Reviewer:** ${file.replace(/\.md$/, "")}`);
      });

      test("shipped dist/claude projection carries the same section", () => {
        const dist = readFileSync(distPath(file), "utf-8");
        expect(section(dist)).toBe(section(src));
      });
    });
  }
});
