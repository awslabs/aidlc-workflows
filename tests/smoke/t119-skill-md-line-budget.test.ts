// covers: file:skills/aidlc/SKILL.md
//
// t119 - the orchestrator's SKILL.md line budget.
//
// Mechanism: none. There is no tool / process seam under test - the subject IS
// the line count of dist/claude/.claude/skills/aidlc/SKILL.md. The test reads
// that file in-process (resolved from the harness's AIDLC_SRC) and counts
// lines. Zero LLM, zero tokens, zero subprocess.
//
// Subject under test (the shipped orchestrator skill):
//   dist/claude/.claude/skills/aidlc/SKILL.md - must stay at or under the Agent
//   Skills spec's 500-line ceiling.
//
// The pin is the 500 CEILING, deliberately - NOT the current line count.
// Pinning the actual count would make a future shrink falsely "regress" this
// guard. 500 is the hard contract; anything below it is healthy headroom.
//
// The count reproduces `wc -l` (newline characters, not split segments) and
// the assertion is the strict `<= 500` ceiling. An existence check is bound in
// so the body cannot vacuously pass on a missing/renamed SKILL.md.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const SKILL_MD = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");

// The Agent Skills spec ceiling (`<= 500` lines).
const CEILING = 500;

/**
 * Reproduce `wc -l` exactly: it counts the number of newline ('\n')
 * characters in the file. A trailing-newline-terminated file with N visual
 * lines reports N; a file whose last line has no trailing newline reports
 * N-1. Counting "\n" (rather than String.split("\n").length) matches that
 * semantic byte-for-byte.
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
    // Guards against a vacuous pass: wcDashL would throw if SKILL.md were
    // missing/renamed, but pin the existence explicitly so the failure mode is
    // legible.
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  test("SKILL.md stays at or under the 500-line Agent Skills ceiling [.sh test 1]", () => {
    const lines = wcDashL(SKILL_MD);
    expect(lines).toBeLessThanOrEqual(CEILING);
    // Sanity floor: a non-empty orchestrator (catches a truncated/empty file
    // that would otherwise pass the ceiling vacuously). The forwarding-loop
    // protocol cannot fit in zero lines.
    expect(lines).toBeGreaterThan(0);
  });
});
