// covers: function:parseStageFrontmatter
//
// t05 — every shipped stage .md parses to a slug + phase that match its
// filename stem and parent directory.
// Mechanism: none (pure parse of on-disk files; zero LLM, zero tokens,
// zero process spawns).
// Technique: example-based, table-driven over the 32 committed stages.
//
// In-process migration of tests/unit/t05-stage-files.sh (TAP plan 64).
// The .sh spawned `bun -e` TWICE per stage (one for obj.slug, one for
// obj.phase) — 32 stages x 2 = 64 `bun -e` process launches. Each launch
// re-imported aidlc-lib.ts and re-parsed one stage file, then printed a
// single scalar that the shell string-compared against the expected slug
// or phase. This port reads the SAME files with readFileSync and calls
// parseStageFrontmatter() directly in-process, asserting the SAME two
// observable facts per stage. The value of this migration is SPEED: 64
// cold `bun -e` spawns collapse to one process.
//
// MECHANISM SPLIT: all 64 behaviours port in-process. There is no CLI
// shell, argv parsing, or process.exit anywhere in the .sh — it only
// inspects the return value of parseStageFrontmatter — so NO Bun.spawnSync
// env-seam case is retained.
//
// Sources read for this port:
//   dist/claude/.claude/tools/aidlc-lib.ts:893
//     export function parseStageFrontmatter(raw: string):
//       Record<string, unknown>  — returns the parsed YAML frontmatter
//       object; obj.slug and obj.phase are the two fields asserted here.
//
// Fixture note: this test reads the REAL committed stage tree (read-only),
// exactly as the .sh did via STAGES_DIR. No tempdir fixtures are built —
// the contract under test IS that the shipped files parse correctly, so
// rebuilding them in a tempdir would test a copy, not the artifact.
//
// Parity mapping: the .sh's STAGE_TABLE (phase, slug) pairs are reproduced
// verbatim below; each pair yields the same two assertions the .sh's
// stage_check() emitted ("<phase>/<slug> slug matches filename" and
// "<phase>/<slug> phase matches directory"). 64 old TAP assertions -> 64
// expect() calls.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const STAGES_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "aidlc-common",
  "stages",
);

// The .sh's stage_check() table, in source order. [phase, slug]. Driving
// from this explicit table (rather than globbing) preserves the exact
// semantic the .sh asserted: that slug equals the FILENAME STEM and phase
// equals the PARENT DIRECTORY for each known stage — a glob would only
// confirm self-consistency, not the filename/directory contract.
const STAGE_TABLE: ReadonlyArray<readonly [phase: string, slug: string]> = [
  // Initialization (3)
  ["initialization", "workspace-scaffold"],
  ["initialization", "workspace-detection"],
  ["initialization", "state-init"],
  // Ideation (7)
  ["ideation", "intent-capture"],
  ["ideation", "market-research"],
  ["ideation", "feasibility"],
  ["ideation", "scope-definition"],
  ["ideation", "team-formation"],
  ["ideation", "rough-mockups"],
  ["ideation", "approval-handoff"],
  // Inception (8)
  ["inception", "reverse-engineering"],
  ["inception", "practices-discovery"],
  ["inception", "requirements-analysis"],
  ["inception", "user-stories"],
  ["inception", "refined-mockups"],
  ["inception", "application-design"],
  ["inception", "units-generation"],
  ["inception", "delivery-planning"],
  // Construction (7)
  ["construction", "functional-design"],
  ["construction", "nfr-requirements"],
  ["construction", "nfr-design"],
  ["construction", "infrastructure-design"],
  ["construction", "code-generation"],
  ["construction", "build-and-test"],
  ["construction", "ci-pipeline"],
  // Operation (7)
  ["operation", "deployment-pipeline"],
  ["operation", "environment-provisioning"],
  ["operation", "deployment-execution"],
  ["operation", "observability-setup"],
  ["operation", "incident-response"],
  ["operation", "performance-validation"],
  ["operation", "feedback-optimization"],
];

// parseStage(): mirror of the .sh's per-stage `bun -e` body — read the
// file at $STAGES_DIR/$phase/$slug.md and parse its frontmatter. In-process.
function parseStage(phase: string, slug: string): Record<string, unknown> {
  const file = join(STAGES_DIR, phase, `${slug}.md`);
  return parseStageFrontmatter(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
}

// Guard: the .sh hard-coded a plan of 64 (32 stages x 2). Pin the table
// length so a stage added/removed without updating this port is caught,
// matching the .sh's implicit count contract.
describe("t05 stage table integrity", () => {
  test("table holds exactly 32 stages (plan 64 = 32 x 2)", () => {
    expect(STAGE_TABLE.length).toBe(32);
  });
});

// =========================================================================
// Per-stage parse (.sh stage_check, 2 assertions per stage = 64 total).
// =========================================================================
describe("each stage .md parses to a slug + phase matching its location", () => {
  for (const [phase, slug] of STAGE_TABLE) {
    // .sh: ok "$phase/$slug slug matches filename"
    test(`${phase}/${slug} slug matches filename`, () => {
      const obj = parseStage(phase, slug);
      expect(obj.slug).toBe(slug);
    });

    // .sh: ok "$phase/$slug phase matches directory"
    test(`${phase}/${slug} phase matches directory`, () => {
      const obj = parseStage(phase, slug);
      expect(obj.phase).toBe(phase);
    });
  }
});
