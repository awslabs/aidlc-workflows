// covers: file:agents/aidlc-developer-agent.md,
// file:agents/aidlc-quality-agent.md,
// file:agents/aidlc-devsecops-agent.md,
// file:agents/aidlc-design-agent.md
//
// Pins the verification discipline in four producing personas. Each already
// states responsibilities and principles; none said what the persona must
// have checked before it hands its artifact to the next stage - that a
// specification's references were resolved against the tree, that "passing"
// is a run the agent observed, that a threat names the boundary and asset it
// reaches, that a screen state not drawn does not exist. Without that text the
// hand-off carries claims the receiving stage cannot tell from evidence.
//
// Mechanism = none: pure text invariants over authored files plus the shipped
// dist/claude projection (the other trees come from the same generated source,
// so one projection pin suffices). A rewording should update these pins
// deliberately, not drop the discipline.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

// One domain-specific line per persona: the rule that only that domain owns.
const PRODUCERS: ReadonlyArray<readonly [file: string, ownRule: string]> = [
  [
    "aidlc-developer-agent.md",
    "A specification is a claim about the codebase until you have opened what it names",
  ],
  [
    "aidlc-quality-agent.md",
    "A test proves a behaviour only if it fails when that behaviour breaks",
  ],
  [
    "aidlc-devsecops-agent.md",
    "A threat is anchored to something that exists",
  ],
  [
    "aidlc-design-agent.md",
    "A state you did not specify does not exist",
  ],
];

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

describe("t339 producer verification discipline pins", () => {
  for (const [file, ownRule] of PRODUCERS) {
    describe(file, () => {
      const src = readFileSync(corePath(file), "utf-8");

      test("carries the section between Memory Focus and Key Principles", () => {
        const memory = src.indexOf("## Memory Focus");
        const discipline = src.indexOf(SECTION);
        const principles = src.indexOf("## Key Principles");
        expect(memory).toBeGreaterThan(-1);
        expect(discipline).toBeGreaterThan(memory);
        expect(principles).toBeGreaterThan(discipline);
        // Exactly one such section - a duplicate would split the checklist.
        expect(src.indexOf(SECTION, discipline + 1)).toBe(-1);
      });

      test("states the rule its own domain owns", () => {
        expect(section(src)).toContain(ownRule);
      });

      test("hand-off checklist is a checkbox list of at least six lines", () => {
        const body = section(src);
        expect(body).toMatch(/^Before you .*, confirm every line:$/m);
        const boxes = body.match(/^- \[ \] /gm) ?? [];
        expect(boxes.length).toBeGreaterThanOrEqual(6);
      });

      test("the existing collaboration boundary and principles survive", () => {
        expect(src).toContain("This agent does not invoke other agents directly.");
        expect(src).toContain("## Key Principles");
      });

      test("shipped dist/claude projection carries the same section", () => {
        const dist = readFileSync(distPath(file), "utf-8");
        expect(section(dist)).toBe(section(src));
      });
    });
  }

  test("developer: a status the agent did not observe is not reported", () => {
    const body = section(readFileSync(corePath("aidlc-developer-agent.md"), "utf-8"));
    expect(body).toContain("Working code is code you ran");
    expect(body).toContain("Make it pass, never make it quiet");
    expect(body).toContain(
      "- [ ] No file outside the unit's ownership changed",
    );
  });

  test("quality: green is observed, failures are fixed at the cause, AC ids map to tests", () => {
    const body = section(readFileSync(corePath("aidlc-quality-agent.md"), "utf-8"));
    expect(body).toContain("Green is something you observed");
    expect(body).toContain("never loosen an assertion, skip the test, or widen a tolerance");
    expect(body).toContain("- [ ] Every AC id maps to a named test, or is listed as untested.");
  });

  test("devsecops: controls are seen, severity follows the asset, secrets never land in artifacts", () => {
    const body = section(readFileSync(corePath("aidlc-devsecops-agent.md"), "utf-8"));
    expect(body).toContain("A control is present only when you have seen it");
    expect(body).toContain("Rate by what the system actually stores, protects, or exposes");
    expect(body).toContain("- [ ] No secret encountered during review is copied into any artifact");
  });

  test("design: screens trace to stories, accessibility is per element, values are tokens", () => {
    const body = section(readFileSync(corePath("aidlc-design-agent.md"), "utf-8"));
    expect(body).toContain("Every screen traces to a story");
    expect(body).toContain("Accessibility is checked per element, not asserted per page");
    expect(body).toContain("- [ ] Every visual value resolves to a named token");
  });
});
