// covers: invariant:state-fixture-matches-template
//
// t42 - state-jumped fixture structural meta-test.
//
// This test claims no enumerated tool unit (its covers id is an invariant);
// like its sibling t12 (tests/integration/t12-state-fixture-validation.test.ts)
// it is a pure STRUCTURAL meta-test that one shipped state fixture
// (tests/fixtures/state-jumped.md) carries the section headings, checkbox-state
// vocabulary, and Current-Status fields that the REAL state template defines.
// The honest covers id is therefore the same structural INVARIANT t12 declares
// — invariant:state-fixture-matches-template — an invariant id is a descriptive
// claim, not a join to an enumerated subcommand/function unit.
//
// Mechanism: none. The test reads the shipped bytes with readFileSync and
// asserts in-process.
//
// Subject under test (the shipped, real bytes — no temp project, no tool):
//   - tests/fixtures/state-jumped.md                 (FIXTURES_DIR-relative; a
//        feature-scope state where a --phase/--stage jump skipped most of
//        ideation/inception, parked in-progress at construction's
//        code-generation)
//   - dist/claude/.claude/knowledge/aidlc-shared/state-template.md  (AIDLC_SRC-
//        relative; the template the fixture is meant to mirror — used for the
//        cross-checks below, mirroring t12's template pinning)
//
// Every heading / marker / phase the fixture is checked for is ALSO asserted
// present in the shipped state-template.md (t12's approach), so the meta-test's
// stated subject — "this jumped fixture matches real template structure" — is
// enforced, not merely asserted against the fixture in isolation. Concrete stage
// slugs are checked against the compiled graph, because the template is the
// state contract rather than a stage enumeration.
//
// The test pins the EXACT [S] count (18), which guards against accidental
// over/under-skip when the fixture is regenerated.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";

const JUMPED_PATH = join(FIXTURES_DIR, "state-jumped.md");
const JUMPED = readFileSync(JUMPED_PATH, "utf-8");

// The real structure the fixture is meant to mirror; the cross-checks below
// pin the fixture's headings/markers to the template (catches silent template
// drift), as t12 does.
const TEMPLATE = readFileSync(
  join(AIDLC_SRC, "knowledge", "aidlc-shared", "state-template.md"),
  "utf-8",
);
const GRAPH = JSON.parse(
  readFileSync(join(AIDLC_SRC, "tools", "data", "stage-graph.json"), "utf-8"),
) as Array<{ slug: string; phase: string }>;

// Initialization stages come from the compiled graph, asserting each is [x]
// completed (a --phase/--stage jump must NOT skip a finished init).
const INIT_STAGES = GRAPH.filter((stage) => stage.phase === "initialization").map((stage) => stage.slug);

describe("t42 state-jumped fixture structural meta-test (migrated from t42-state-jumped-fixture.sh, plan 12)", () => {
  test("fixture file exists and is non-empty [.sh 1]", () => {
    expect(existsSync(JUMPED_PATH)).toBe(true);
    expect(JUMPED.length).toBeGreaterThan(0);
  });

  test("carries the ## Stage Progress section heading [.sh 2]", () => {
    expect(JUMPED.includes("## Stage Progress")).toBe(true);
    expect(TEMPLATE.includes("## Stage Progress")).toBe(true);
  });

  test("carries the ## Current Status section heading [.sh 3]", () => {
    expect(JUMPED.includes("## Current Status")).toBe(true);
    expect(TEMPLATE.includes("## Current Status")).toBe(true);
  });

  test("carries [S] skipped-stage markers [.sh 4]", () => {
    expect(JUMPED.includes("[S]")).toBe(true);
    // The [S] marker is documented in the template's checkbox-state legend, so it
    // is real template vocabulary.
    expect(TEMPLATE.includes("[S]")).toBe(true);
  });

  test("carries [x] completed-stage markers [.sh 5]", () => {
    expect(JUMPED.includes("[x]")).toBe(true);
    expect(TEMPLATE.includes("[x]")).toBe(true);
  });

  test("carries the [-] in-progress-stage marker [.sh 6]", () => {
    expect(JUMPED.includes("[-]")).toBe(true);
    // Legend-defined, and there is EXACTLY one in-progress stage in a jumped
    // fixture (the parked current stage).
    expect(TEMPLATE.includes("[-]")).toBe(true);
    const inProgress = JUMPED.split("\n").filter((l) =>
      /^- \[-\]/.test(l),
    );
    expect(inProgress.length).toBe(1);
    expect(inProgress[0]).toContain("code-generation");
  });

  test("current phase is CONSTRUCTION [.sh 7]", () => {
    expect(JUMPED.includes("CONSTRUCTION")).toBe(true);
    // It is the declared Lifecycle Phase under ## Current Status (not merely
    // present as a section header somewhere), and CONSTRUCTION is a
    // template-enumerated Lifecycle Phase value.
    expect(JUMPED.includes("**Lifecycle Phase**: CONSTRUCTION")).toBe(true);
    expect(TEMPLATE.includes("CONSTRUCTION")).toBe(true);
  });

  test("current stage is code-generation [.sh 8]", () => {
    expect(JUMPED.includes("code-generation")).toBe(true);
    expect(JUMPED.includes("**Current Stage**: code-generation")).toBe(true);
    expect(GRAPH.some((stage) => stage.slug === "code-generation")).toBe(true);
  });

  test("has > 0 [S] skipped stages (exact: 18) [.sh 9]", () => {
    const sCount = JUMPED.split("\n").filter((l) => /^- \[S\]/.test(l)).length;
    expect(sCount).toBeGreaterThan(0);
    // Pin the exact count so a fixture regeneration that changes the skip set is
    // caught (the jumped fixture skips most of ideation/inception plus the early
    // construction stages - 18 lines).
    expect(sCount).toBe(18);
  });

  // Every initialization stage must be [x] completed, NOT [S] skipped - a
  // --phase/--stage jump leaves a finished init phase intact.
  for (const stage of INIT_STAGES) {
    test(`init stage ${stage} is [x] completed, not [S] [.sh 10-12]`, () => {
      expect(JUMPED.includes(`[x] ${stage}`)).toBe(true);
      // The same stage must NOT also appear as skipped, and the compiled graph lists
      // it as an initialization stage.
      expect(JUMPED.includes(`[S] ${stage}`)).toBe(false);
      expect(GRAPH.some((entry) => entry.slug === stage && entry.phase === "initialization")).toBe(true);
    });
  }
});
