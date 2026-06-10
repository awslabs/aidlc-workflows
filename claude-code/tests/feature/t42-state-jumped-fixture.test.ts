// covers: invariant:state-fixture-matches-template
//
// t42 — state-jumped fixture structural meta-test. Migrated from
// tests/feature/t42-state-jumped-fixture.sh (TAP plan 12).
//
// The .sh carried NO `# covers:` header (it claims no enumerated tool unit);
// like its sibling t12 (tests/feature/t12-state-fixture-validation.test.ts:1)
// it is a pure STRUCTURAL meta-test that one shipped state fixture
// (tests/fixtures/state-jumped.md) carries the section headings, checkbox-state
// vocabulary, and Current-Status fields that the REAL state template defines.
// The honest covers id is therefore the same structural INVARIANT t12 declares
// — invariant:state-fixture-matches-template — an invariant id is a descriptive
// claim, not a join to an enumerated subcommand/function unit.
//
// Mechanism: none. The .sh did `assert_file_exists` + `grep -q <pattern>` +
// `grep -c '^- \[S\]'` against on-disk fixture bytes — zero tool spawn, zero
// LLM, zero tokens. The twin reads the SAME shipped bytes with readFileSync and
// asserts in-process.
//
// Subject under test (the shipped, real bytes — no temp project, no tool):
//   - tests/fixtures/state-jumped.md                 (FIXTURES_DIR-relative; the
//        .sh's $FIXTURES_DIR/state-jumped.md — a feature-scope state where a
//        --phase/--stage jump skipped most of ideation/inception, parked
//        in-progress at construction's code-generation)
//   - dist/claude/.claude/knowledge/aidlc-shared/state-template.md  (AIDLC_SRC-
//        relative; the template the fixture is meant to mirror — used for the
//        STRONGER cross-checks below, mirroring t12's template pinning)
//
// The .sh never opened the template; this twin is STRONGER in the same way t12
// is: every heading / marker / phase / stage the .sh greps in the fixture is
// ALSO asserted present in the shipped state-template.md, so the meta-test's
// stated subject — "this jumped fixture matches real template structure" — is
// enforced, not merely asserted against the fixture in isolation. If the
// template renamed a heading or dropped a checkbox marker the fixture would
// silently drift; the cross-check catches it.
//
// STRONGER counts: the .sh asserted `S_COUNT > 0` (assert_gt). The twin pins
// the EXACT count (17) — equal-or-stronger: it still proves "> 0" and also
// guards against accidental over/under-skip when the fixture is regenerated.
//
// Old TAP -> new test parity (1:1, every .sh `ok` -> a named test()):
//   .sh 1  assert_file_exists JUMPED                  -> "fixture file exists and is non-empty"
//   .sh 2  grep '## Stage Progress'                   -> "carries the ## Stage Progress section heading"
//   .sh 3  grep '## Current Status'                   -> "carries the ## Current Status section heading"
//   .sh 4  grep '\[S\]'                               -> "carries [S] skipped-stage markers"
//   .sh 5  grep '\[x\]'                               -> "carries [x] completed-stage markers"
//   .sh 6  grep '\[-\]'                               -> "carries the [-] in-progress-stage marker"
//   .sh 7  grep 'CONSTRUCTION'                         -> "current phase is CONSTRUCTION"
//   .sh 8  grep 'code-generation'                      -> "current stage is code-generation"
//   .sh 9  S_COUNT=grep -c '^- \[S\]'; assert_gt 0     -> "has > 0 [S] skipped stages (exact: 17)"
//   .sh 10 grep '\[x\] workspace-scaffold'             -> "init stage workspace-scaffold is [x] completed, not [S]"
//   .sh 11 grep '\[x\] workspace-detection'            -> "init stage workspace-detection is [x] completed, not [S]"
//   .sh 12 grep '\[x\] state-init'                     -> "init stage state-init is [x] completed, not [S]"

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";

// The .sh's JUMPED = "$FIXTURES_DIR/state-jumped.md".
const JUMPED_PATH = join(FIXTURES_DIR, "state-jumped.md");
const JUMPED = readFileSync(JUMPED_PATH, "utf-8");

// The real structure the fixture is meant to mirror — the .sh never opened it;
// the cross-checks below pin the fixture's headings/markers to the template
// (catches silent template drift), as t12 does.
const TEMPLATE = readFileSync(
  join(AIDLC_SRC, "knowledge", "aidlc-shared", "state-template.md"),
  "utf-8",
);

// The three initialization stages the .sh loops over (t42.sh:27), asserting
// each is [x] completed (a --phase/--stage jump must NOT skip a finished init).
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

describe("t42 state-jumped fixture structural meta-test (migrated from t42-state-jumped-fixture.sh, plan 12)", () => {
  test("fixture file exists and is non-empty [.sh 1]", () => {
    // assert_file_exists: the .sh only proved existence; non-empty is the
    // honest equal-or-stronger form (an empty file would pass `-e` but fail
    // every subsequent grep).
    expect(existsSync(JUMPED_PATH)).toBe(true);
    expect(JUMPED.length).toBeGreaterThan(0);
  });

  test("carries the ## Stage Progress section heading [.sh 2]", () => {
    // grep '## Stage Progress'.
    expect(JUMPED.includes("## Stage Progress")).toBe(true);
    // STRONGER: the template defines this heading (state-template.md:42).
    expect(TEMPLATE.includes("## Stage Progress")).toBe(true);
  });

  test("carries the ## Current Status section heading [.sh 3]", () => {
    // grep '## Current Status'.
    expect(JUMPED.includes("## Current Status")).toBe(true);
    // STRONGER: template-defined (state-template.md:88).
    expect(TEMPLATE.includes("## Current Status")).toBe(true);
  });

  test("carries [S] skipped-stage markers [.sh 4]", () => {
    // grep '\[S\]'.
    expect(JUMPED.includes("[S]")).toBe(true);
    // STRONGER: the [S] marker is documented in the template's checkbox-state
    // legend (state-template.md:43), so it is real template vocabulary.
    expect(TEMPLATE.includes("[S]")).toBe(true);
  });

  test("carries [x] completed-stage markers [.sh 5]", () => {
    // grep '\[x\]'.
    expect(JUMPED.includes("[x]")).toBe(true);
    // STRONGER: legend-defined (state-template.md:43).
    expect(TEMPLATE.includes("[x]")).toBe(true);
  });

  test("carries the [-] in-progress-stage marker [.sh 6]", () => {
    // grep '\[-\]'.
    expect(JUMPED.includes("[-]")).toBe(true);
    // STRONGER: legend-defined (state-template.md:43), and there is EXACTLY one
    // in-progress stage in a jumped fixture (the parked current stage).
    expect(TEMPLATE.includes("[-]")).toBe(true);
    const inProgress = JUMPED.split("\n").filter((l) =>
      /^- \[-\]/.test(l),
    );
    expect(inProgress.length).toBe(1);
    expect(inProgress[0]).toContain("code-generation");
  });

  test("current phase is CONSTRUCTION [.sh 7]", () => {
    // grep 'CONSTRUCTION'.
    expect(JUMPED.includes("CONSTRUCTION")).toBe(true);
    // STRONGER: it is the declared Lifecycle Phase under ## Current Status (not
    // merely present as a section header somewhere), and CONSTRUCTION is a
    // template-enumerated Lifecycle Phase value (state-template.md:89).
    expect(JUMPED.includes("**Lifecycle Phase**: CONSTRUCTION")).toBe(true);
    expect(TEMPLATE.includes("CONSTRUCTION")).toBe(true);
  });

  test("current stage is code-generation [.sh 8]", () => {
    // grep 'code-generation'.
    expect(JUMPED.includes("code-generation")).toBe(true);
    // STRONGER: it is the declared Current Stage under ## Current Status, and a
    // template-listed stage (state-template.md:75).
    expect(JUMPED.includes("**Current Stage**: code-generation")).toBe(true);
    expect(TEMPLATE.includes("code-generation")).toBe(true);
  });

  test("has > 0 [S] skipped stages (exact: 17) [.sh 9]", () => {
    // The .sh: S_COUNT=$(grep -c '^- \[S\]' ...); assert_gt "$S_COUNT" 0.
    // Count lines beginning '- [S]' exactly as grep -c '^- \[S\]' did.
    const sCount = JUMPED.split("\n").filter((l) => /^- \[S\]/.test(l)).length;
    // Equal: proves the .sh's "> 0".
    expect(sCount).toBeGreaterThan(0);
    // STRONGER: pin the exact count so a fixture regeneration that changes the
    // skip set is caught (the jumped fixture skips most of ideation/inception
    // plus the early construction stages — 17 lines).
    expect(sCount).toBe(17);
  });

  // .sh 10-12: every initialization stage must be [x] completed, NOT [S]
  // skipped — a --phase/--stage jump leaves a finished init phase intact.
  for (const stage of INIT_STAGES) {
    test(`init stage ${stage} is [x] completed, not [S] [.sh 10-12]`, () => {
      // grep "\[x\] <stage>".
      expect(JUMPED.includes(`[x] ${stage}`)).toBe(true);
      // STRONGER: the same stage must NOT also appear as skipped, and the
      // template lists it as an initialization stage (state-template.md:46-48).
      expect(JUMPED.includes(`[S] ${stage}`)).toBe(false);
      expect(TEMPLATE.includes(stage)).toBe(true);
    });
  }
});
