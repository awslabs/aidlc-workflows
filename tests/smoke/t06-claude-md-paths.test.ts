// covers: file:dist/claude/.claude/CLAUDE.md
//
// t06 - the distributable CLAUDE.md describes the shipped .claude/ layout.
//
// Mechanism: none. There is no tool / process seam under test - the subject IS
// the bytes of dist/claude/.claude/CLAUDE.md. The test reads that file
// in-process (resolved from the harness's AIDLC_SRC, the dist/claude/.claude
// root) and asserts on its contents. Zero LLM, zero tokens, zero subprocess.
//
// Subject under test (the shipped user-facing CLAUDE.md, NOT this repo's):
//   dist/claude/.claude/CLAUDE.md — its "## AI-DLC Structure" section
//   enumerates the user-visible .claude/ surfaces. This test pins that the
//   shipped doc reflects the current layout: no legacy nested/removed/renamed
//   paths, the sensors/ surface named, and the workspace memory path with
//   org.md named as a positive anchor.
//
// The negative cases assert an EXACT zero-occurrence count (a future doc that
// reintroduced a legacy path even once is caught), and the existence check is a
// real assertion so the body cannot vacuously pass on a missing file.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const CLAUDE_MD = join(AIDLC_SRC, "CLAUDE.md");

function readClaudeMd(): string {
  return readFileSync(CLAUDE_MD, "utf-8");
}

// Count non-overlapping occurrences of a literal substring (escaped to a
// RegExp so "." is literal, matching `grep -q "\.claude/..."`).
function countOccurrences(haystack: string, literal: string): number {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (haystack.match(new RegExp(escaped, "g")) || []).length;
}

describe("distributable CLAUDE.md describes the post-Wave-1 .claude/ layout", () => {
  test("the shipped CLAUDE.md exists [.sh test 1]", () => {
    // A missing file fails outright, and every other test reads the bytes, so
    // none can vacuously pass.
    expect(existsSync(CLAUDE_MD)).toBe(true);
  });

  test("describes a flat .claude/rules/ layout (no nested rules/aidlc/guardrails) [.sh test 2]", () => {
    expect(countOccurrences(readClaudeMd(), ".claude/rules/aidlc/guardrails")).toBe(0);
  });

  test("does not reference the removed .claude/practices/ path [.sh test 3]", () => {
    expect(countOccurrences(readClaudeMd(), ".claude/practices")).toBe(0);
  });

  test("does not reference the legacy aidlc-knowledge/ parent [.sh test 4]", () => {
    expect(countOccurrences(readClaudeMd(), ".claude/aidlc-knowledge")).toBe(0);
  });

  test("mentions the .claude/sensors/ surface [.sh test 5]", () => {
    const body = readClaudeMd();
    expect(countOccurrences(body, ".claude/sensors")).toBeGreaterThanOrEqual(1);
    expect(body.includes(".claude/sensors")).toBe(true);
  });

  test("mentions the relocated space-memory rule layer (positive layout anchor) [.sh test 6]", () => {
    // Positive anchor: the method/rules layer must appear, so a regression that
    // deleted the whole Rules bullet can't pass tests 2-5 silently. The rule files
    // live in the space memory layer `aidlc/spaces/<active-space>/memory/` (neutral
    // names org.md/team.md/project.md), read via the `.claude/rules/aidlc.md`
    // @-import stub, so the positive anchor is that path + the neutral `org.md`
    // filename.
    const body = readClaudeMd();
    expect(
      countOccurrences(body, "aidlc/spaces/<active-space>/memory/"),
    ).toBeGreaterThanOrEqual(1);
    expect(body.includes("org.md")).toBe(true);
  });
});
