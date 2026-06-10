// covers: invariant:state-fixture-matches-template
//
// t12 — state-fixture structural meta-test. Migrated from
// tests/feature/t12-state-fixture-validation.sh (TAP plan 20).
//
// The .sh carried NO `# covers:` header (it claims no enumerated tool unit);
// it is a pure structural meta-test that the shipped test FIXTURES
// (tests/fixtures/state-mid-ideation.md, tests/fixtures/state-initialization-done.md)
// carry the section headings, phase headings, and bold-field format that the
// REAL state template defines. The honest covers id is therefore the structural
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
//           (a sub-expect per phase; each ALSO pinned in the template)
//   .sh 14    (**Lifecycle Phase**: present)        -> field block, sub-expect
//   .sh 15    (**Current Stage**: present)          -> field block, sub-expect
//   .sh 16    (**State Version**: 7)                -> field block, sub-expect (value-pinned)
//   .sh 17    (**Worktree Path**: present)          -> field block, sub-expect
//   .sh 18    (**Bolt Refs**: present)              -> field block, sub-expect
//   .sh 19    (**Practices Affirmed Timestamp**:)   -> field block, sub-expect
//        all six -> "mid-ideation carries the template bold-field format"
//           (**State Version**: 7 is value-exact; the other five field-name-present;
//            each field name ALSO pinned in the template)
//   .sh 20    (init-done: **Lifecycle Phase**: IDEATION)
//        -> "init-done declares Lifecycle Phase IDEATION (the differentiator)"

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
      expect(TEMPLATE.includes(h)).toBe(true);
    }
  });

  test("mid-ideation carries the template bold-field format [.sh 14-19]", () => {
    // .sh 14: **Lifecycle Phase**: present (the regex was '\*\*Lifecycle Phase\*\*:').
    expect(MID.includes("**Lifecycle Phase**:")).toBe(true);
    expect(TEMPLATE.includes("**Lifecycle Phase**:")).toBe(true);

    // .sh 15: **Current Stage**: present.
    expect(MID.includes("**Current Stage**:")).toBe(true);
    expect(TEMPLATE.includes("**Current Stage**:")).toBe(true);

    // .sh 16: **State Version**: 7 — value-pinned (the .sh grepped the literal
    // '\*\*State Version\*\*: 7').
    expect(MID.includes("**State Version**: 7")).toBe(true);
    expect(TEMPLATE.includes("**State Version**: 7")).toBe(true);

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
