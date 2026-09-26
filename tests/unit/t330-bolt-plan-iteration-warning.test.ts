// covers: subcommand:aidlc-state:finalize
//
// The reconciliation notice (issue #985) fires at Delivery Planning COMPLETION
// (aidlc-state.ts finalize delivery-planning), after the finalized bolt-plan and
// the iteration choice exist but before the approval transition into
// Construction. The Construction runtime walks by Unit/stage batch (from
// unit-of-work-dependency.md), never by the Bolt sequence in bolt-plan.md, so a
// walking-skeleton-first Bolt is not guaranteed to arrive as the first reviewable
// increment. This test pins the reconciliation contract:
//   - stage-major (the default, incl. when set-construction-iteration was never
//     called) with a walking-skeleton first Bolt -> WARN (the case the old
//     set-construction-iteration seam missed, since stage-major writes nothing).
//   - unit-major delivering a ONE-Unit first Bolt -> SILENT (aligned).
//   - unit-major with a MULTI-Unit first Bolt -> WARN (a vertical slice no single
//     Unit batch represents).
//   - negative marker, explanatory-only mention, malformed input, missing plan
//     -> SILENT (fail-open; the marker is read from the FIRST Bolt row only).
// The load-bearing finalize output (completed / next_stage / phase) is unchanged
// either way, and the advisory `warning` never blocks the transition.
// mechanism = cli: SPAWN `bun aidlc-state.ts finalize delivery-planning`.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const BUN = process.execPath;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

// Seed a project sitting at delivery-planning, optionally with a Construction
// Iteration runtime field. Absent field = stage-major default (the resolver
// treats only the literal "unit-major" as unit-major; everything else is
// stage-major).
function seedProject(iterationLine?: string): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(
    seededStateFile(proj),
    `# AI-DLC State Tracking

## Project Information
- **Project**: bolt reconciliation warning test
- **Project Type**: Greenfield
- **Scope**: workshop
- **State Version**: 8

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: delivery-planning
- **Status**: Running

## Runtime State
- **Skeleton Stance**: on${iterationLine ? `\n${iterationLine}` : ""}
`,
  );
  return proj;
}

function writeBoltPlan(proj: string, body: string): void {
  const dir = join(seededRecordDir(proj), "inception", "delivery-planning");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bolt-plan.md"), body);
}

// Drive the completing transition. The four skip envs bypass the finalize
// preconditions that are orthogonal to this feature (direct-transition gate,
// artifact guard, summary-confirmation, human-presence); none of them touches
// the reconciliation logic under test. delivery-planning declares no reviewer,
// so no review receipt is needed.
function finalizeDeliveryPlanning(proj: string): Record<string, unknown> {
  const r = spawnSync(
    BUN,
    [STATE, "finalize", "delivery-planning", "--project-dir", proj],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
        AIDLC_SKIP_ARTIFACT_GUARD: "1",
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      },
    },
  );
  if ((r.status ?? -1) !== 0) {
    throw new Error(`finalize delivery-planning failed: ${r.stdout}${r.stderr}`);
  }
  return JSON.parse(r.stdout.trim());
}

const UNIT_MAJOR = "- **Construction Iteration**: unit-major";

// A walking-skeleton FIRST Bolt spanning two Units (a vertical slice).
const SKELETON_MULTI_UNIT = `# Bolt Plan

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | U4 + thin U1 | **YES — walking skeleton** | thin end-to-end slice |
| B2 | U1 full | no | full CRUD |
`;

// A walking-skeleton FIRST Bolt that is exactly one Unit.
const SKELETON_ONE_UNIT = `# Bolt Plan

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | U1 | **YES — walking skeleton** | thin end-to-end slice |
| B2 | U2 full | no | full CRUD |
`;

// First Bolt explicitly NOT a skeleton.
const NEGATIVE_MARKER = `# Bolt Plan

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | U1 full | no | full CRUD |
`;

// "walking skeleton" appears only in explanatory prose; the first Bolt row is no.
const EXPLANATORY_ONLY = `# Bolt Plan

We considered a walking skeleton but chose a horizontal build for the first Bolt.

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | U1 full | no | full CRUD |
`;

// No table at all — cannot identify a first Bolt.
const MALFORMED = `# Bolt Plan

TBD — bolts not yet enumerated.
`;

// A walking-skeleton first Bolt whose Units cell repeats one Unit id (dedupe must
// count it as one Unit, so under unit-major it stays silent).
const SKELETON_DUP_UNIT = `# Bolt Plan

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | U1 + U1 (thin) | **YES — walking skeleton** | thin end-to-end slice |
| B2 | U2 full | no | full CRUD |
`;

// A walking-skeleton first Bolt whose Units cell uses the "Unit N" free-text form
// rather than "U<n>". A single Unit under unit-major must stay silent (the H2 fix:
// a non-U-token Units cell must not be mis-counted as zero and spuriously warn).
const SKELETON_UNITWORD_ONE = `# Bolt Plan

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | Unit 1 | **YES — walking skeleton** | thin end-to-end slice |
| B2 | Unit 2 | no | full CRUD |
`;

// First Bolt whose Skeleton? cell spells out a NEGATIVE using the phrase "walking
// skeleton" (e.g. "No — not a walking skeleton"). The negative must win: no warning.
const NEGATIVE_PHRASE_MARKER = `# Bolt Plan

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | U1 full | No — not a walking skeleton | full CRUD |
`;

// A walking-skeleton first Bolt whose Units cell mixes "U<n>" and "Unit <n>"
// notation ("U1 + Unit 2"): two distinct Units, so under unit-major it warns.
const SKELETON_MIXED_NOTATION = `# Bolt Plan

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | U1 + Unit 2 | **YES — walking skeleton** | thin end-to-end slice |
| B2 | U3 full | no | full CRUD |
`;

// A first Bolt whose Skeleton? cell is a HEDGED affirmative ("yes, but not fully
// thin"): the "yes" token wins over the "not", so it still warns under stage-major.
const SKELETON_HEDGED = `# Bolt Plan

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | U4 + U1 | yes, but not fully thin | slice |
| B2 | U2 full | no | full CRUD |
`;

// A walking-skeleton first Bolt whose Units cell is descriptive free text with a
// comma ("auth, thin API") but no explicit Unit reference. Under unit-major this
// must NOT be mis-counted as multiple Units and must stay silent.
const SKELETON_FREETEXT_UNITS = `# Bolt Plan

| Bolt | Units | Skeleton? | Definition of Done |
|------|-------|-----------|--------------------|
| B1 | auth, thin API | **YES — walking skeleton** | thin end-to-end slice |
| B2 | U2 full | no | full CRUD |
`;

// Every finalize must keep the load-bearing output intact regardless of warning.
function expectLoadBearing(out: Record<string, unknown>): void {
  expect(out.completed).toBe("delivery-planning");
  expect(out.next_stage).not.toBe("none");
  expect(out.phase).toBe("CONSTRUCTION");
}

describe("t330 delivery-planning bolt-plan reconciliation warning (issue #985)", () => {
  // 1: stage-major is the DEFAULT and writes nothing via set-construction-iteration.
  // A walking-skeleton first Bolt on the default horizontal walk must still warn —
  // this is the gap the old set-construction-iteration seam missed entirely.
  test("1: stage-major default + walking-skeleton first Bolt warns", () => {
    const proj = seedProject(); // no Construction Iteration field -> stage-major
    writeBoltPlan(proj, SKELETON_MULTI_UNIT);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(typeof out.warning).toBe("string");
    expect(out.warning as string).toContain("walking-skeleton");
    expect(out.warning as string).toContain("stage-major");
  }, 15000);

  // 2: unit-major delivering a ONE-Unit first Bolt is aligned — stay silent. The
  // mitigating choice (unit-major, chosen precisely to get early working code)
  // must NOT be flagged when it can carry the first Bolt as one Unit.
  test("2: unit-major + one-Unit first Bolt is silent", () => {
    const proj = seedProject(UNIT_MAJOR);
    writeBoltPlan(proj, SKELETON_ONE_UNIT);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 3: unit-major with a MULTI-Unit first Bolt cannot deliver that vertical slice
  // as one increment — warn, and name the Unit-span mismatch (incl. the count).
  test("3: unit-major + multi-Unit first Bolt warns", () => {
    const proj = seedProject(UNIT_MAJOR);
    writeBoltPlan(proj, SKELETON_MULTI_UNIT);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(typeof out.warning).toBe("string");
    expect(out.warning as string).toContain("unit-major");
    expect(out.warning as string).toContain("2 Units");
  }, 15000);

  // 4: a first Bolt explicitly marked "no" produces no warning.
  test("4: negative first-Bolt marker is silent", () => {
    const proj = seedProject();
    writeBoltPlan(proj, NEGATIVE_MARKER);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 5: an explanatory-only "walking skeleton" mention in prose, with the first
  // Bolt row marked no, must NOT fire — the marker is read from the first Bolt
  // row only, not matched anywhere in the file (the old whole-file-regex bug).
  test("5: explanatory-only mention is silent", () => {
    const proj = seedProject();
    writeBoltPlan(proj, EXPLANATORY_ONLY);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 6: malformed plan (no table) is fail-open — no warning, transition proceeds.
  test("6: malformed plan (no table) is silent", () => {
    const proj = seedProject();
    writeBoltPlan(proj, MALFORMED);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 7: no bolt-plan.md at all is fail-open — no warning, transition still succeeds.
  test("7: missing bolt-plan.md is silent (fail-open)", () => {
    const proj = seedProject();
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 8: a first Bolt whose Units cell repeats one id is one Unit after dedupe, so
  // unit-major stays silent (guards the distinct-count dedupe).
  test("8: unit-major + duplicated-Unit first Bolt is silent", () => {
    const proj = seedProject(UNIT_MAJOR);
    writeBoltPlan(proj, SKELETON_DUP_UNIT);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 9: a one-Unit first Bolt written in the "Unit N" free-text form (no "U<n>"
  // token) must count as one Unit under unit-major and stay silent — the aligned,
  // mitigating choice must not draw a false warning just because of cell wording.
  test("9: unit-major + Unit-N-form one-Unit first Bolt is silent", () => {
    const proj = seedProject(UNIT_MAJOR);
    writeBoltPlan(proj, SKELETON_UNITWORD_ONE);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 10: the reconciliation is scoped to delivery-planning completion. Finalizing a
  // DIFFERENT stage, even with a walking-skeleton bolt-plan present, emits no
  // warning (guards the completedSlug gate). practices-discovery is an inception
  // stage that declares no reviewer, so it finalizes cleanly under the skip envs.
  test("10: a non-delivery-planning finalize emits no warning", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    writeFileSync(
      seededStateFile(proj),
      `# AI-DLC State Tracking

## Project Information
- **Project**: bolt reconciliation warning test
- **Project Type**: Greenfield
- **Scope**: workshop
- **State Version**: 8

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: practices-discovery
- **Status**: Running

## Runtime State
- **Skeleton Stance**: on
`,
    );
    writeBoltPlan(proj, SKELETON_MULTI_UNIT);
    const r = spawnSync(
      BUN,
      [STATE, "finalize", "practices-discovery", "--project-dir", proj],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
          AIDLC_SKIP_ARTIFACT_GUARD: "1",
          AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
          AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
        },
      },
    );
    if ((r.status ?? -1) !== 0) {
      throw new Error(`finalize practices-discovery failed: ${r.stdout}${r.stderr}`);
    }
    const out = JSON.parse(r.stdout.trim());
    expect(out.completed).toBe("practices-discovery");
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 11: a first Bolt whose Skeleton? cell spells out a NEGATIVE containing the
  // phrase "walking skeleton" ("No — not a walking skeleton") must stay silent —
  // the explicit negative is rejected before the affirmative phrase match.
  test("11: negative-phrase marker is silent", () => {
    const proj = seedProject();
    writeBoltPlan(proj, NEGATIVE_PHRASE_MARKER);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 12: a skeleton first Bolt whose Units cell is descriptive free text with a
  // comma but no explicit Unit reference must not be mis-counted as multi-Unit;
  // under unit-major it stays silent (the aligned, mitigating choice).
  test("12: unit-major + comma free-text Units is silent", () => {
    const proj = seedProject(UNIT_MAJOR);
    writeBoltPlan(proj, SKELETON_FREETEXT_UNITS);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(out.warning).toBeUndefined();
  }, 15000);

  // 13: a first Bolt spanning two Units written in MIXED notation ("U1 + Unit 2")
  // counts as 2 distinct Units, so unit-major warns (guards the union count — the
  // two notations must not be counted in mutually-exclusive branches).
  test("13: unit-major + mixed-notation multi-Unit first Bolt warns", () => {
    const proj = seedProject(UNIT_MAJOR);
    writeBoltPlan(proj, SKELETON_MIXED_NOTATION);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(typeof out.warning).toBe("string");
    expect(out.warning as string).toContain("2 Units");
  }, 15000);

  // 14: a HEDGED affirmative first-Bolt marker ("yes, but not fully thin") still
  // warns under stage-major — the affirmative "yes" wins over the negative word,
  // so a partially-hedged skeleton is not silently vetoed.
  test("14: hedged affirmative marker warns", () => {
    const proj = seedProject(); // stage-major default
    writeBoltPlan(proj, SKELETON_HEDGED);
    const out = finalizeDeliveryPlanning(proj);
    expectLoadBearing(out);
    expect(typeof out.warning).toBe("string");
    expect(out.warning as string).toContain("stage-major");
  }, 15000);
});
