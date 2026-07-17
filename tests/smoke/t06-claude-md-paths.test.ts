// covers: file:dist/claude/.claude/CLAUDE.md
//
// t06 — the distributable CLAUDE.md describes the post-Wave-1 .claude/ layout.
// Migrated from tests/smoke/t06-claude-md-paths.sh (6 TAP assertions).
//
// Mechanism: none. The .sh shelled out to `grep` against a static shipped
// file; there is no tool / process seam under test — the subject IS the bytes
// of dist/claude/.claude/CLAUDE.md. So the twin reads that file in-process
// (resolved from the harness's AIDLC_SRC, the same dist/claude/.claude root)
// and asserts on its contents. Zero LLM, zero tokens, zero subprocess.
//
// Subject under test (the shipped user-facing CLAUDE.md, NOT this repo's):
//   dist/claude/.claude/CLAUDE.md — its "## AI-DLC Structure" section
//   enumerates the user-visible .claude/ surfaces. Wave-1 (milestone 2) flattened
//   practices/ + rules/ into a single flat rules/ dir, renamed
//   aidlc-knowledge/ -> knowledge/, and v0.5.0 added the sensors/ surface.
//   This test pins that the shipped doc reflects that layout: no legacy
//   nested/removed/renamed paths, the new sensors/ surface named, and a new
//   flat-rules filename (aidlc-org) named as a positive anchor.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1 (distributable CLAUDE.md exists)                   -> "the shipped CLAUDE.md exists"
//   .sh test 2 (flat rules/ — no rules/aidlc/guardrails nested)   -> "describes a flat .claude/rules/ layout (no nested rules/aidlc/guardrails)"
//   .sh test 3 (no removed .claude/practices/ path)               -> "does not reference the removed .claude/practices/ path"
//   .sh test 4 (no legacy .claude/aidlc-knowledge/ parent)        -> "does not reference the legacy aidlc-knowledge/ parent"
//   .sh test 5 (mentions .claude/sensors/ surface)                -> "mentions the .claude/sensors/ surface"
//   .sh test 6 (mentions a new flat-rules filename: aidlc-org)    -> "mentions the aidlc-org rule file (positive layout anchor)"
//
// Equal-or-stronger: the .sh used `grep -q` (presence/absence, boolean). The
// twin asserts the same boolean facts AND tightens the negative cases to an
// EXACT zero-occurrence count (a future doc that reintroduced a legacy path
// even once is caught), and binds the existence check to a real assertion so
// the body cannot vacuously pass on a missing file (the .sh guarded this with
// explicit SKIP markers; here a missing file fails the first test outright).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC = <repo>/dist/claude/.claude — the same root the .sh reached via
// $SCRIPT_DIR/../../dist/claude/.claude. The shipped CLAUDE.md sits at its top.
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
    // The .sh SKIP-guarded 2-6 if this file was missing so the negative
    // greps wouldn't vacuously pass. Here a missing file fails outright, and
    // every other test reads the bytes, so none can vacuously pass.
    expect(existsSync(CLAUDE_MD)).toBe(true);
  });

  test("describes a flat .claude/rules/ layout (no nested rules/aidlc/guardrails) [.sh test 2]", () => {
    // milestone 2 flattened the rules tree; the legacy nested guardrails path must be
    // gone. .sh: grep -q "\.claude/rules/aidlc/guardrails" => must NOT match.
    expect(countOccurrences(readClaudeMd(), ".claude/rules/aidlc/guardrails")).toBe(0);
  });

  test("does not reference the removed .claude/practices/ path [.sh test 3]", () => {
    // practices/ merged into rules/ in milestone 2. .sh: grep -q "\.claude/practices".
    expect(countOccurrences(readClaudeMd(), ".claude/practices")).toBe(0);
  });

  test("does not reference the legacy aidlc-knowledge/ parent [.sh test 4]", () => {
    // aidlc-knowledge/ renamed to knowledge/ in milestone 2.
    // .sh: grep -q "\.claude/aidlc-knowledge".
    expect(countOccurrences(readClaudeMd(), ".claude/aidlc-knowledge")).toBe(0);
  });

  test("mentions the .claude/sensors/ surface [.sh test 5]", () => {
    // sensors/ is a user-visible surface new in v0.5.0.
    // .sh: grep -q "\.claude/sensors" => MUST match.
    const body = readClaudeMd();
    expect(countOccurrences(body, ".claude/sensors")).toBeGreaterThanOrEqual(1);
    expect(body.includes(".claude/sensors")).toBe(true);
  });

  test("mentions the relocated space-memory rule layer (positive layout anchor) [.sh test 6]", () => {
    // Positive anchor: the method/rules layer must appear, so a regression that
    // deleted the whole Rules bullet can't pass tests 2-5 silently. The workspace
    // refactor relocated the rule files off `.claude/rules/` to the space memory
    // layer `aidlc/spaces/<active-space>/memory/` (neutral names
    // org.md/team.md/project.md),
    // read via the `.claude/rules/aidlc.md` @-import stub — so the positive anchor
    // is the relocated path + the neutral `org.md` filename, not the old `aidlc-org`.
    const body = readClaudeMd();
    expect(
      countOccurrences(body, "aidlc/spaces/<active-space>/memory/"),
    ).toBeGreaterThanOrEqual(1);
    expect(body.includes("org.md")).toBe(true);
  });
});
