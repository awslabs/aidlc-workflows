// covers: invariant:state-fixture-matches-template
//
// t12 — state-fixture structural meta-test. Migrated from
// tests/integration/t12-state-fixture-validation.sh (TAP plan 20).
//
// The .sh carried NO `# covers:` header (it claims no enumerated tool unit);
// it is a pure structural meta-test that the shipped test FIXTURES
// (tests/fixtures/state-mid-ideation.md, tests/fixtures/state-initialization-done.md)
// carry the section headings, phase headings, and bold-field format expected by
// the REAL state template contract. The honest covers id is therefore the structural
// INVARIANT under test, declared free-form like t125's invariant: ids
// (tests/unit/t125.none.test.ts:1) — invariant ids are descriptive claims, not
// joined to an enumerated subcommand/function unit.
//
// Mechanism: none. The .sh did `grep -q <pattern> <file>` against on-disk
// fixture/template files — zero tool spawn, zero LLM, zero tokens. The twin
// reads the SAME shipped bytes with readFileSync and asserts in-process.
//
// Subject under test (the shipped, real bytes — no temp project, no tool):
//   - tests/fixtures/state-mid-ideation.md          (FIXTURES_DIR-relative)
//   - tests/fixtures/state-initialization-done.md    (FIXTURES_DIR-relative)
//   - dist/claude/.claude/knowledge/aidlc-shared/state-template.md  (the TEMPLATE
//     the .sh resolved via `cd .../aidlc-shared && pwd`/state-template.md, AIDLC_SRC-relative)
//
// The .sh resolved the template path but never asserted against it directly
// (it spot-checked the fixtures and noted in a comment that the headings ARE
// the template's structure). This twin is STRONGER: every heading/field the
// .sh greps in the fixture is ALSO asserted present in the shipped
// state-template.md, so the meta-test's STATED subject — "fixture state files
// match real template structure" — is actually enforced, not just commented.
// If the template drops or renames a heading the fixture would silently drift;
// the cross-check now catches it.
//
// Old TAP -> new test parity (1:1, every .sh `ok` -> a named test()):
//   .sh 1-8   (mid-ideation: 8 `## ` section headings)
//        -> "mid-ideation carries all 8 template section headings"
//           (a sub-expect per heading; each heading ALSO pinned in the template)
//   .sh 9-13  (mid-ideation: 5 `### <PHASE> PHASE` headings)
//        -> "mid-ideation carries all 5 template phase headings"
//           (a sub-expect per phase; the template contract carries the generic
//            phase-heading emission shape)
//   .sh 14    (**Lifecycle Phase**: present)        -> field block, sub-expect
//   .sh 15    (**Current Stage**: present)          -> field block, sub-expect
//   .sh 16    (**State Version**: 8)                -> field block, sub-expect (value-pinned)
//   .sh 17    (**Worktree Path**: present)          -> field block, sub-expect
//   .sh 18    (**Bolt Refs**: present)              -> field block, sub-expect
//   .sh 19    (**Practices Affirmed Timestamp**:)   -> field block, sub-expect
//        all six -> "mid-ideation carries the template bold-field format"
//           (**State Version**: 8 is value-exact; the other five field-name-present;
//            each field name ALSO pinned in the template)
//   .sh 20    (init-done: **Lifecycle Phase**: IDEATION)
//        -> "init-done declares Lifecycle Phase IDEATION (the differentiator)"

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";

const MID = readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8");
const INIT = readFileSync(
  join(FIXTURES_DIR, "state-initialization-done.md"),
  "utf-8",
);
// The .sh resolved TEMPLATE as
// dist/claude/.claude/knowledge/aidlc-shared/state-template.md — the real
// structure the fixtures are meant to mirror.
const TEMPLATE = readFileSync(
  join(AIDLC_SRC, "knowledge", "aidlc-shared", "state-template.md"),
  "utf-8",
);

// The 8 `## ` section headings the .sh greps in the fixture (t12.sh:15-22).
const SECTION_HEADINGS = [
  "## Project Information",
  "## Scope Configuration",
  "## Workspace State",
  "## Execution Plan Summary",
  "## Runtime State",
  "## Stage Progress",
  "## Current Status",
  "## Session Resume Point",
];

// The 5 `### <PHASE> PHASE` headings the .sh greps (t12.sh:25-29).
const PHASE_HEADINGS = [
  "### INITIALIZATION PHASE",
  "### IDEATION PHASE",
  "### INCEPTION PHASE",
  "### CONSTRUCTION PHASE",
  "### OPERATION PHASE",
];

describe("t12 state-fixture structural meta-test (migrated from t12-state-fixture-validation.sh, plan 20)", () => {
  test("mid-ideation carries all 8 template section headings [.sh 1-8]", () => {
    for (const h of SECTION_HEADINGS) {
      // Same as grep -q "<h>" on the fixture.
      expect(MID.includes(h)).toBe(true);
      // STRONGER than the .sh: the heading must also exist in the REAL
      // template the fixture is supposed to mirror (catches template drift).
      expect(TEMPLATE.includes(h)).toBe(true);
    }
  });

  test("mid-ideation carries all 5 template phase headings [.sh 9-13]", () => {
    for (const h of PHASE_HEADINGS) {
      expect(MID.includes(h)).toBe(true);
    }
    expect(TEMPLATE.includes("### [PHASE] PHASE")).toBe(true);
  });

  test("mid-ideation carries the template bold-field format [.sh 14-19]", () => {
    // .sh 14: **Lifecycle Phase**: present (the regex was '\*\*Lifecycle Phase\*\*:').
    expect(MID.includes("**Lifecycle Phase**:")).toBe(true);
    expect(TEMPLATE.includes("**Lifecycle Phase**:")).toBe(true);

    // .sh 15: **Current Stage**: present.
    expect(MID.includes("**Current Stage**:")).toBe(true);
    expect(TEMPLATE.includes("**Current Stage**:")).toBe(true);

    // .sh 16: **State Version**: 8 — value-pinned (the .sh grepped the literal
    // '\*\*State Version\*\*: 7').
    expect(MID.includes("**State Version**: 8")).toBe(true);
    expect(TEMPLATE.includes("**State Version**: 8")).toBe(true);

    // .sh 17: **Worktree Path**: present.
    expect(MID.includes("**Worktree Path**:")).toBe(true);
    expect(TEMPLATE.includes("**Worktree Path**:")).toBe(true);

    // .sh 18: **Bolt Refs**: present.
    expect(MID.includes("**Bolt Refs**:")).toBe(true);
    expect(TEMPLATE.includes("**Bolt Refs**:")).toBe(true);

    // .sh 19: **Practices Affirmed Timestamp**: present.
    expect(MID.includes("**Practices Affirmed Timestamp**:")).toBe(true);
    expect(TEMPLATE.includes("**Practices Affirmed Timestamp**:")).toBe(true);
  });

  test("init-done declares Lifecycle Phase IDEATION (the key differentiator) [.sh 20]", () => {
    // .sh 20: the init-done fixture's differentiator — its Lifecycle Phase has
    // already advanced to IDEATION (init phase verified). grep '\*\*Lifecycle
    // Phase\*\*: IDEATION'.
    expect(INIT.includes("**Lifecycle Phase**: IDEATION")).toBe(true);
    // STRONGER: the template enumerates IDEATION as a valid Lifecycle Phase
    // value, so the fixture's value is a real template option, not a typo.
    expect(TEMPLATE.includes("IDEATION")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Graph-parity meta-test. The original t12 only pinned headings/version, so a
// fixture's Stage Progress grid could silently drift from the compiled stage
// graph (the exact defect that let the 32-stage grids survive the 33-stage
// contract-design insertion). This block reads the COMPILED inception slugs
// from the shipped stage-graph.json and asserts every full-grid fixture's
// inception rows track it — specifically that contract-design was inserted
// between units-generation and delivery-planning and the old application-design
// slug is gone. Deriving the expected slugs from the graph (not a hardcoded
// list) means this check follows future graph changes instead of pinning a
// snapshot.

interface StageGraphNode {
  slug: string;
  number: string;
  phase: string;
}

// The compiled graph the shipped dist carries — the same tree the engine loads.
const STAGE_GRAPH = JSON.parse(
  readFileSync(join(AIDLC_SRC, "tools", "data", "stage-graph.json"), "utf-8"),
) as StageGraphNode[];

// Inception slugs in compiled order (filter phase, sort by dotted stage number).
const COMPILED_INCEPTION_SLUGS = STAGE_GRAPH.filter(
  (node) => node.phase === "inception",
)
  .sort((a, b) => {
    const [amaj, amin] = a.number.split(".").map(Number);
    const [bmaj, bmin] = b.number.split(".").map(Number);
    return amaj - bmaj || amin - bmin;
  })
  .map((node) => node.slug);

// Every shipped state-* fixture — the row-parity check applies to the ones that
// actually enumerate the inception phase (see the units-generation guard below).
const STATE_FIXTURES = readdirSync(FIXTURES_DIR).filter((f) =>
  /^state-.*\.md$/.test(f),
);

/**
 * Extract the ordered stage slugs listed under a fixture's `### INCEPTION PHASE`
 * heading (the `- [x]/[ ]/[-]/[S] <slug> — ...` rows), stopping at the next
 * `### ` phase heading. Returns [] when the fixture carries no inception grid.
 */
function inceptionSlugs(md: string): string[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === "### INCEPTION PHASE");
  if (start === -1) return [];
  const slugs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("### ")) break;
    const m = line.match(/^- \[.\]\s+(\S+)\s+—/);
    if (m) slugs.push(m[1]);
  }
  return slugs;
}

describe("t12 stage-graph parity — fixture inception grids track the compiled graph", () => {
  test("compiled graph inserts contract-design between units-generation and delivery-planning and drops application-design", () => {
    expect(COMPILED_INCEPTION_SLUGS).toContain("contract-design");
    expect(COMPILED_INCEPTION_SLUGS).not.toContain("application-design");
    const ug = COMPILED_INCEPTION_SLUGS.indexOf("units-generation");
    const cd = COMPILED_INCEPTION_SLUGS.indexOf("contract-design");
    const dp = COMPILED_INCEPTION_SLUGS.indexOf("delivery-planning");
    expect(ug).toBeGreaterThanOrEqual(0);
    expect(cd).toBeGreaterThan(ug);
    expect(dp).toBeGreaterThan(cd);
  });

  for (const fixture of STATE_FIXTURES) {
    const slugs = inceptionSlugs(
      readFileSync(join(FIXTURES_DIR, fixture), "utf-8"),
    );
    // Only fixtures that actually enumerate inception carry a full grid; skip
    // phase-partial fixtures (no units-generation row) so we don't assert
    // row-parity on grids that never listed the inception stages.
    if (!slugs.includes("units-generation")) continue;

    test(`${fixture} inception rows match the compiled inception slugs`, () => {
      // Row-for-row parity with the compiled graph — tracks any future change.
      expect(slugs).toEqual(COMPILED_INCEPTION_SLUGS);
      // And the specific graph-move under test, stated explicitly:
      const ug = slugs.indexOf("units-generation");
      const cd = slugs.indexOf("contract-design");
      const dp = slugs.indexOf("delivery-planning");
      expect(cd).toBeGreaterThan(ug); // contract-design present, after units-generation
      expect(dp).toBeGreaterThan(cd); // ...and before delivery-planning
      expect(slugs).not.toContain("application-design"); // old slug renamed away
    });
  }
});
