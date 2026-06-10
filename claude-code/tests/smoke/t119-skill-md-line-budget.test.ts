// covers: file:skills/aidlc/SKILL.md
//
// t119 — the orchestrator's SKILL.md line budget. Migrated from
// tests/smoke/t119-skill-md-line-budget.sh (1 TAP assertion).
//
// Mechanism: none. The .sh shelled out to `wc -l` against a static shipped
// file; there is no tool / process seam under test — the subject IS the line
// count of dist/claude/.claude/skills/aidlc/SKILL.md. So the twin reads that
// file in-process (resolved from the harness's AIDLC_SRC, the same
// dist/claude/.claude root the .sh reached via $AIDLC_SRC) and counts lines.
// Zero LLM, zero tokens, zero subprocess.
//
// Subject under test (the shipped orchestrator skill):
//   dist/claude/.claude/skills/aidlc/SKILL.md — must stay under the Agent
//   Skills spec's 500-line ceiling. Before the forwarding-loop cutover it ran
//   895 lines (≈1.8× over); the rewrite deleted all between-stage dispatch
//   prose (now owned by aidlc-orchestrate.ts) leaving only the loop protocol +
//   the conductor's execution-quality prose.
//
// The pin is the 500 CEILING, deliberately — NOT the current landing (~173
// lines today). A later increment collapses the body further (persona prose
// extracts to a shared conductor file); pinning the actual count would make
// that future shrink falsely "regress" this guard. 500 is the hard contract;
// anything below it is healthy headroom.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1 (assert_lt LINES 501 — SKILL.md is <= 500 lines)
//     -> "SKILL.md stays at or under the 500-line Agent Skills ceiling"
//
// Equal-or-stronger: the .sh used `wc -l` (which counts trailing newlines, so
// a file with N "\n"-terminated lines reports N). The twin reproduces that
// exact `wc -l` semantic — counting newline characters, not split segments —
// so the measured number is byte-for-byte what the .sh measured, then asserts
// the same strict `<= 500` ceiling. It also binds an existence check so the
// body cannot vacuously pass on a missing/renamed SKILL.md (the .sh would have
// errored under `set -e` on a missing file; here a missing file fails the
// existence test outright).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC = <repo>/dist/claude/.claude — the same root the .sh reached via
// $AIDLC_SRC. The orchestrator skill sits at skills/aidlc/SKILL.md beneath it.
const SKILL_MD = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");

// The Agent Skills spec ceiling the .sh pinned via `assert_lt LINES 501`
// (strict-less-than 501 === `<= 500` for an integer line count).
const CEILING = 500;

/**
 * Reproduce `wc -l` exactly: it counts the number of newline ('\n')
 * characters in the file. A trailing-newline-terminated file with N visual
 * lines reports N; a file whose last line has no trailing newline reports
 * N-1. Counting "\n" (rather than String.split("\n").length) matches that
 * semantic byte-for-byte, so the measured count is identical to the .sh's.
 */
function wcDashL(path: string): number {
  const body = readFileSync(path, "utf-8");
  let count = 0;
  for (const ch of body) {
    if (ch === "\n") count++;
  }
  return count;
}

describe("orchestrator SKILL.md line budget (Agent Skills 500-line ceiling)", () => {
  test("the shipped orchestrator SKILL.md exists", () => {
    // Guards against a vacuous pass: the .sh would have errored under `set -e`
    // if SKILL.md were missing/renamed; here wcDashL would throw, but pin the
    // existence explicitly so the failure mode is legible.
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  test("SKILL.md stays at or under the 500-line Agent Skills ceiling [.sh test 1]", () => {
    // .sh: LINES=$(wc -l < "$SKILL"); assert_lt "$LINES" 501.
    const lines = wcDashL(SKILL_MD);
    // Strict ceiling check, mirroring `assert_lt LINES 501` === `LINES <= 500`.
    expect(lines).toBeLessThanOrEqual(CEILING);
    // Sanity floor: a non-empty orchestrator (catches a truncated/empty file
    // that would otherwise pass the ceiling vacuously). The forwarding-loop
    // protocol cannot fit in zero lines.
    expect(lines).toBeGreaterThan(0);
  });
});
