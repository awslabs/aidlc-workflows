// covers: file:memory/phases/ideation.md, file:memory/phases/inception.md, file:memory/phases/construction.md, file:memory/phases/operation.md, stage:ideation/feasibility, stage:inception/requirements-analysis, stage:construction/build-and-test, stage:operation/deployment-execution
//
// t16 — shipped phase-rules file STRUCTURE contract. Migrated from
// tests/unit/t16-phase-rules-structure.sh (TAP plan 12 — 3 distinct
// invariants across the 4 phase rule files). The .sh resolved
//   RULES_DIR  = $AIDLC_SRC/rules
//   STAGES_DIR = $AIDLC_SRC/aidlc-common/stages
// where $AIDLC_SRC = <repo>/dist/claude/.claude (fixtures.ts), and for
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
// (AIDLC_SRC = <repo>/dist/claude/.claude, fixtures.ts), enumerate the
// real stage `.md` files per phase from disk, and read the real rule-file
// bytes in-process.
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

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// The phase rule files live at the workspace-root
// aidlc/spaces/default/memory/phases/<phase>.md (neutral, nested). They sit
// beside .claude/, so resolve PHASES_DIR from AIDLC_SRC's parent (the
// dist/claude/ root). STAGES_DIR stays under .claude/.
const PHASES_DIR = join(AIDLC_SRC, "..", "aidlc", "spaces", "default", "memory", "phases");
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");

// The four non-initialization phases (initialization has no
// phases/initialization.md rule file).
const PHASES = ["ideation", "inception", "construction", "operation"] as const;

const phaseRuleFile = (phase: string): string =>
  join(PHASES_DIR, `${phase}.md`);

function stageSlugs(phase: string): string[] {
  const dir = join(STAGES_DIR, phase);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .sort(); // pin determinism.
}

/**
 * A rules body REFERENCES a stage slug if the exact slug is a substring, OR any
 * hyphen-separated word of length >= 4 from the slug appears case-insensitively.
 * Returns the first matching {slug, word} (word === null for an exact-slug hit),
 * or null if no stage for the phase is referenced.
 */
function firstReferencedStage(
  body: string,
  slugs: string[],
): { slug: string; word: string | null } | null {
  const lower = body.toLowerCase();
  for (const slug of slugs) {
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
  test("each phase rule file exists [.sh Part 1 ×4]", () => {
    for (const phase of PHASES) {
      const f = phaseRuleFile(phase);
      expect(existsSync(f), `missing memory/phases/${phase}.md`).toBe(true);
    }
  });

  test("each phase rule file is non-empty [.sh Part 2 ×4]", () => {
    for (const phase of PHASES) {
      const f = phaseRuleFile(phase);
      const bytes = statSync(f).size;
      expect(bytes, `memory/phases/${phase}.md is empty`).toBeGreaterThan(0);
      const body = readFileSync(f, "utf-8");
      expect(body.trim().length, `memory/phases/${phase}.md is whitespace-only`).toBeGreaterThan(0);
    }
  });

  test("each phase rule file references at least one of its stage slugs [.sh Part 3 ×4]", () => {
    // The specific slug+word each phase satisfies the predicate through. This pins
    // WHICH stage is referenced so a future edit that drops the cited mention
    // produces a precise failure rather than a silent pass-by-coincidence on a
    // different word.
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
      expect(slugs.length, `no stage files on disk for phase ${phase}`).toBeGreaterThan(0);

      const body = readFileSync(phaseRuleFile(phase), "utf-8");
      const hit = firstReferencedStage(body, slugs);
      expect(
        hit,
        `memory/phases/${phase}.md references no ${phase} stage slug (checked ${slugs.length} slugs)`,
      ).not.toBeNull();

      const exp = EXPECTED_HIT[phase];
      expect(slugs, `expected slug ${exp.slug} no longer on disk for ${phase}`).toContain(exp.slug);
      if (exp.word === null) {
        expect(
          body.includes(exp.slug),
          `memory/phases/${phase}.md no longer contains exact slug "${exp.slug}"`,
        ).toBe(true);
      } else {
        expect(
          body.toLowerCase().includes(exp.word.toLowerCase()),
          `memory/phases/${phase}.md no longer contains word "${exp.word}" (from slug ${exp.slug})`,
        ).toBe(true);
      }
    }
  });

  // Re-count to guard against a phase being silently dropped from the roster
  // (3 invariants x 4 phases = 12 rows).
  test("covers EXACTLY 4 phases × 3 invariants = 12 assertions (TAP plan parity)", () => {
    expect(PHASES.length).toBe(4);
    const INVARIANTS_PER_PHASE = 3;
    expect(PHASES.length * INVARIANTS_PER_PHASE).toBe(12);
    expect([...PHASES]).toEqual([
      "ideation",
      "inception",
      "construction",
      "operation",
    ]);
  });
});
