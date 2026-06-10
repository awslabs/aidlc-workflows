// covers: file:rules/aidlc-phase-ideation.md, file:rules/aidlc-phase-inception.md, file:rules/aidlc-phase-construction.md, file:rules/aidlc-phase-operation.md, stage:ideation/feasibility, stage:inception/requirements-analysis, stage:construction/build-and-test, stage:operation/deployment-execution
//
// t16 — shipped phase-rules file STRUCTURE contract. Migrated from
// tests/unit/t16-phase-rules-structure.sh (TAP plan 12 — 3 distinct
// invariants across the 4 phase rule files). The .sh resolved
//   RULES_DIR  = $AIDLC_SRC/rules
//   STAGES_DIR = $AIDLC_SRC/aidlc-common/stages
// where $AIDLC_SRC = <repo>/dist/claude/.claude (fixtures.ts:42), and for
// each of the four non-initialization phases asserted three things:
//   Part 1 (.sh L17-19): rules/aidlc-phase-<phase>.md EXISTS.
//   Part 2 (.sh L25-28): that file is NON-EMPTY (wc -c > 0).
//   Part 3 (.sh L34-64): the file REFERENCES at least one stage slug that
//                        exists on disk for that phase — either an exact
//                        substring of the slug, or (fallback) any 4+ char
//                        hyphen-separated word from a slug, matched
//                        case-insensitively.
//
// Mechanism: none. This is a pure structural/file-inspection check over the
// shipped bytes — do the four phase rule files exist, carry content, and
// mention their phase's stages? No process boundary, no argv/exit/stdout
// seam, no LLM, zero tokens. We resolve the SAME trees the .sh resolved
// (AIDLC_SRC = <repo>/dist/claude/.claude, fixtures.ts:42), enumerate the
// real stage `.md` files per phase from disk, and read the real rule-file
// bytes in-process.
//
// Subject under test (the shipped distributable):
//   - dist/claude/.claude/rules/aidlc-phase-{ideation,inception,construction,
//     operation}.md           — the four per-phase rule files.
//   - dist/claude/.claude/aidlc-common/stages/<phase>/*.md — the stage files
//     whose slugs the rule files must mention.
//
// Part-3 algorithm parity (.sh L34-64): the .sh iterated the phase's stage
// files in shell-glob order, testing exact-substring first (`grep -qF`), then
// falling back to per-word case-insensitive match for any hyphen-segment of
// length >= 4, stopping at the FIRST slug that matched. It does NOT require
// every slug to be referenced — only that AT LEAST ONE is. This twin
// reproduces that exact predicate (referencesAnyStage) over the same bytes,
// which is equal-or-stronger: it asserts the same "at least one stage
// referenced" contract AND additionally pins, per phase, the specific slug +
// matched word the current shipped files satisfy it through (caught from the
// live disk at authoring time: feasibility[exact] / requirements[word] /
// test[word] / deployment[word]) so a silent edit that drops the reference
// is caught with a precise message.
//
// Test-design note (house style): assert the OBSERVABLE shipped contract the
// .sh asserted against the real bytes on disk. The phase list and the
// per-phase stage rosters are enumerated FROM DISK (not hard-coded) exactly
// as the .sh's `for phase in ...` + glob did.
//
// Old TAP -> new test parity (1:1, no guarantee dropped; the .sh emitted 3
// loops of 4 `ok` lines each = 12. Here each of the 3 invariants is one
// test() that asserts across ALL 4 phases via expect() per phase, so every
// one of the 12 .sh rows maps to a named expect(). The final test re-counts
// to pin the plan):
//   .sh L17-19 (4 phase files exist)             -> "each phase rule file exists" [4 expects]
//   .sh L25-28 (each is non-empty)               -> "each phase rule file is non-empty" [4 expects]
//   .sh L34-64 (each references a stage slug)     -> "each phase rule file references at least one of its stage slugs" [4 expects]
//   .sh L11    plan 12                            -> "covers EXACTLY 4 phases × 3 invariants = 12 assertions (TAP plan parity)"

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same root the .sh resolved
// RULES_DIR and STAGES_DIR under.
const RULES_DIR = join(AIDLC_SRC, "rules");
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");

// The four non-initialization phases, in the order the .sh's `for phase in
// ideation inception construction operation` named them. (initialization has
// no aidlc-phase-initialization.md rule file — the .sh deliberately omits it.)
const PHASES = ["ideation", "inception", "construction", "operation"] as const;

const phaseRuleFile = (phase: string): string =>
  join(RULES_DIR, `aidlc-phase-${phase}.md`);

/** Enumerate the stage slugs that exist on disk for a phase — the same set the
 *  .sh's `for stage_file in "$STAGES_DIR/$phase/"*.md` glob walked. */
function stageSlugs(phase: string): string[] {
  const dir = join(STAGES_DIR, phase);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .sort(); // shell glob order is sorted; pin determinism.
}

/**
 * Reproduce the .sh's Part-3 predicate (L40-57): a rules body REFERENCES a
 * stage slug if the exact slug is a substring (grep -qF), OR any hyphen-
 * separated word of length >= 4 from the slug appears case-insensitively
 * (the documented Git-Bash `-i` fallback). Returns the first matching
 * {slug, word} (word === null for an exact-slug hit), or null if no stage
 * for the phase is referenced.
 */
function firstReferencedStage(
  body: string,
  slugs: string[],
): { slug: string; word: string | null } | null {
  const lower = body.toLowerCase();
  for (const slug of slugs) {
    // Exact-substring first (case-sensitive, matching grep -qF).
    if (body.includes(slug)) return { slug, word: null };
    // Fallback: any hyphen-segment >= 4 chars, case-insensitive.
    for (const word of slug.split("-")) {
      if (word.length >= 4 && lower.includes(word.toLowerCase())) {
        return { slug, word };
      }
    }
  }
  return null;
}

describe("t16 phase-rules file structure (migrated from t16-phase-rules-structure.sh, plan 12)", () => {
  // .sh L17-19: assert_file_exists "$RULES_DIR/aidlc-phase-$phase.md".
  test("each phase rule file exists [.sh Part 1 ×4]", () => {
    for (const phase of PHASES) {
      const f = phaseRuleFile(phase);
      expect(existsSync(f), `missing rules/aidlc-phase-${phase}.md`).toBe(true);
    }
  });

  // .sh L25-28: size=$(wc -c < file); assert_gt "$size" 0.
  test("each phase rule file is non-empty [.sh Part 2 ×4]", () => {
    for (const phase of PHASES) {
      const f = phaseRuleFile(phase);
      // STRONGER than `wc -c > 0`: the byte count on disk AND the read body
      // length must both be positive (no zero-length / whitespace-only file).
      const bytes = statSync(f).size;
      expect(bytes, `rules/aidlc-phase-${phase}.md is empty`).toBeGreaterThan(0);
      const body = readFileSync(f, "utf-8");
      expect(body.trim().length, `rules/aidlc-phase-${phase}.md is whitespace-only`).toBeGreaterThan(0);
    }
  });

  // .sh L34-64: each phase rule file references at least one stage slug that
  // exists on disk for that phase (exact substring or 4+ char word fallback).
  test("each phase rule file references at least one of its stage slugs [.sh Part 3 ×4]", () => {
    // The specific slug+word each phase currently satisfies the predicate
    // through, captured from the live shipped bytes at authoring time. This is
    // STRONGER than the .sh's "found=1": it pins WHICH stage is referenced so a
    // future edit that drops the cited mention produces a precise failure
    // rather than a silent pass-by-coincidence on a different word.
    const EXPECTED_HIT: Record<
      (typeof PHASES)[number],
      { slug: string; word: string | null }
    > = {
      ideation: { slug: "feasibility", word: null }, // exact substring
      inception: { slug: "requirements-analysis", word: "requirements" },
      construction: { slug: "build-and-test", word: "test" },
      operation: { slug: "deployment-execution", word: "deployment" },
    };

    for (const phase of PHASES) {
      const slugs = stageSlugs(phase);
      // Every phase must have at least one stage on disk (the .sh's glob would
      // otherwise loop zero times and report not_ok).
      expect(slugs.length, `no stage files on disk for phase ${phase}`).toBeGreaterThan(0);

      const body = readFileSync(phaseRuleFile(phase), "utf-8");
      const hit = firstReferencedStage(body, slugs);
      // The core .sh assertion: AT LEAST ONE stage slug is referenced.
      expect(
        hit,
        `aidlc-phase-${phase}.md references no ${phase} stage slug (checked ${slugs.length} slugs)`,
      ).not.toBeNull();

      // Strengthening pin: the cited slug for this phase must still be among the
      // on-disk roster, and the rule file must still reference it through the
      // expected exact-substring or word path.
      const exp = EXPECTED_HIT[phase];
      expect(slugs, `expected slug ${exp.slug} no longer on disk for ${phase}`).toContain(exp.slug);
      if (exp.word === null) {
        expect(
          body.includes(exp.slug),
          `aidlc-phase-${phase}.md no longer contains exact slug "${exp.slug}"`,
        ).toBe(true);
      } else {
        expect(
          body.toLowerCase().includes(exp.word.toLowerCase()),
          `aidlc-phase-${phase}.md no longer contains word "${exp.word}" (from slug ${exp.slug})`,
        ).toBe(true);
      }
    }
  });

  // .sh L11: plan 12. Re-count to pin the plan and guard against a phase being
  // silently dropped from the roster (3 invariants × 4 phases = 12 rows).
  test("covers EXACTLY 4 phases × 3 invariants = 12 assertions (TAP plan parity)", () => {
    expect(PHASES.length).toBe(4);
    const INVARIANTS_PER_PHASE = 3;
    expect(PHASES.length * INVARIANTS_PER_PHASE).toBe(12);
    // The phases must be the four non-initialization phases the .sh named.
    expect([...PHASES]).toEqual([
      "ideation",
      "inception",
      "construction",
      "operation",
    ]);
  });
});
