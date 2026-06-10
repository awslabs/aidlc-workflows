// covers: file:aidlc-common/stages/inception/delivery-planning.md, file:agents/aidlc-delivery-agent.md, file:knowledge/aidlc-delivery-agent/workflow-planning-guide.md
//
// t26 — Content guardrail: the shipped delivery-planning SURFACE must not use
// human-timeline framing. Migrated from
// tests/unit/t26-delivery-agent-timeline-guardrail.sh (TAP plan 3 — one `ok`
// per file across the three delivery-surface artefacts). The .sh resolved
// AIDLC_SRC = dist/claude/.claude (tests/lib/fixtures.sh:7) and, for each of the
// three files, grepped (case-insensitive) for a FORBIDDEN alternation; a file
// passed iff NONE of the patterns matched.
//
// Issue #18: estimates are meaningless in the AI build world — velocity,
// burndown, sprint goals, story points, daily mob schedules, and "weeks of
// effort" are human-timeline framing that must not leak into the delivery
// agent's surface.
//
// Mechanism: none. This is a pure content/structural check over the shipped
// bytes — does each delivery-surface artefact stay free of human-timeline
// framing? No process boundary, no argv/exit/stdout seam, no LLM, zero tokens.
// We resolve the same tree the .sh resolved (AIDLC_SRC = <repo>/dist/claude/.claude,
// fixtures.ts:42) and read each .md in-process.
//
// Subject under test (dist/claude/.claude/...):
//   - aidlc-common/stages/inception/delivery-planning.md  (the stage spec)
//   - agents/aidlc-delivery-agent.md                       (the persona)
//   - knowledge/aidlc-delivery-agent/workflow-planning-guide.md (the guide)
//
// FORBIDDEN alternation (verbatim from the .sh, L11), matched
// case-insensitively, same as the .sh's `grep -Ei`:
//   velocity | burndown | daily mob schedule | sprint goal | story point | weeks of effort
//
// Test-design note (house style): assert the OBSERVABLE shipped contract the
// .sh asserted — absence of every forbidden human-timeline term — against the
// real bytes on disk. STRONGER than the .sh: the .sh ran ONE OR-grep per file
// and emitted ONE `ok`; here each forbidden term is asserted INDEPENDENTLY per
// file, so a regression that adds (say) "story points" is localised to its own
// failing expect() rather than collapsing into a single opaque not_ok. On a
// real hit the failure message reports the matching line numbers, mirroring the
// .sh's `grep -Ein ... | head -3` diagnostic.
//
// Old TAP -> new test parity (the .sh emitted 3 `ok` lines — one per file in a
// single loop. Here each file is one test() that asserts the surface is free of
// EACH of the 6 forbidden terms via a per-term expect(), so every one of the 3
// .sh rows maps to a named test() and is strengthened to 6 term-checks. A final
// test re-counts to pin the plan):
//   .sh L21-29 (delivery-planning.md no human-timeline framing) -> "delivery-planning.md has no human-timeline framing"
//   .sh L21-29 (aidlc-delivery-agent.md no human-timeline framing) -> "aidlc-delivery-agent.md has no human-timeline framing"
//   .sh L21-29 (workflow-planning-guide.md no human-timeline framing) -> "workflow-planning-guide.md has no human-timeline framing"
//   .sh L19    plan 3                                            -> "covers EXACTLY 3 delivery-surface files (TAP plan parity)"

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same tree the .sh resolved.
// Each entry: [human-readable basename for the test name, path relative to AIDLC_SRC].
const FILES: ReadonlyArray<readonly [string, string]> = [
  ["delivery-planning.md", "aidlc-common/stages/inception/delivery-planning.md"],
  ["aidlc-delivery-agent.md", "agents/aidlc-delivery-agent.md"],
  [
    "workflow-planning-guide.md",
    "knowledge/aidlc-delivery-agent/workflow-planning-guide.md",
  ],
] as const;

// The FORBIDDEN alternation, split into the six distinct terms the .sh's regex
// (L11) encoded. Asserting each independently is STRONGER than one OR-grep.
const FORBIDDEN_TERMS = [
  "velocity",
  "burndown",
  "daily mob schedule",
  "sprint goal",
  "story point",
  "weeks of effort",
] as const;

const srcPath = (rel: string): string => join(AIDLC_SRC, rel);

/**
 * Return the 1-based line numbers (and text) where a case-insensitive `term`
 * appears in `body`. Mirrors the .sh's `grep -Ein` diagnostic so a regression
 * reports WHERE the forbidden framing crept in.
 */
function hits(body: string, term: string): string[] {
  const needle = term.toLowerCase();
  return body
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.toLowerCase().includes(needle))
    .map(({ line, n }) => `${n}:${line.trim()}`)
    .slice(0, 3); // head -3, same as the .sh
}

describe("t26 delivery-surface human-timeline guardrail (migrated from t26-delivery-agent-timeline-guardrail.sh, plan 3)", () => {
  for (const [name, rel] of FILES) {
    // .sh L21-29: one OR-grep per file => one `ok`. Strengthened to one
    // independent assertion per forbidden term against the real bytes.
    test(`${name} has no human-timeline framing [.sh row for ${name}]`, () => {
      const file = srcPath(rel);
      // Sanity: the file the .sh grepped must exist (the .sh's grep would have
      // emitted not_ok with "matches:" empty on a missing file under -q 2>/dev/null;
      // we make the precondition explicit).
      expect(existsSync(file), `${rel}: shipped file missing`).toBe(true);
      const body = readFileSync(file, "utf-8");
      for (const term of FORBIDDEN_TERMS) {
        const matches = hits(body, term);
        expect(
          matches.length,
          `${name} contains forbidden human-timeline term "${term}" — matches: ${matches.join(" | ")}`,
        ).toBe(0);
      }
    });
  }

  // .sh L19: plan ${#FILES[@]} == 3. Re-count to pin the plan and guard against
  // a delivery-surface file being silently dropped from the guardrail roster.
  test("covers EXACTLY 3 delivery-surface files (TAP plan parity)", () => {
    expect(FILES.length).toBe(3);
    // Every term in the .sh's FORBIDDEN alternation is represented (no term
    // silently dropped from the guardrail).
    expect(FORBIDDEN_TERMS.length).toBe(6);
    expect(FORBIDDEN_TERMS).toEqual([
      "velocity",
      "burndown",
      "daily mob schedule",
      "sprint goal",
      "story point",
      "weeks of effort",
    ]);
  });
});
