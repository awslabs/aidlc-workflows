// covers: function:parseMemoryHeadings, function:parseMemoryEntries
//
// t88 — §13 memory.md heading-counter parseMemoryHeadings() in
// aidlc-lib.ts, plus the parseMemoryEntries() count invariant.
// Mechanism: none (pure functions, zero I/O, zero LLM, zero tokens).
// Technique: example-based.
//
// Migrated 1:1 from tests/unit/t88-parse-memory-headings.sh (plan 18).
// The .sh spawned `bun -e` snippets that imported parseMemoryHeadings and
// printed one count field per fixture; this file imports the function and
// calls it directly, asserting the SAME observable return values. Every
// TAP `assert_eq` in the source maps to exactly one `expect` below.
//
// Source (dist/claude/.claude/tools/aidlc-lib.ts):
//   :971  parseMemoryHeadings(raw): { interpretations, deviations,
//           tradeoffs, open_questions, total }
//           - throws on non-string raw
//           - BOM strip (^﻿) + CRLF->LF normalise before split
//           - four exact-match canonical H2 anchors gate counting
//           - non-canonical H2 (`## X`) terminates the prior section
//           - skips: blank/ws-only, blockquote (`>`), HTML-comment-only,
//             code-fence delimiters (```), lines inside a fence, heading
//             lines themselves
//           - missing heading => 0 for that key, never throws
//   :1049 parseMemoryEntries(raw): Array<{heading, ts, summary, context,
//           raw}> — reuses parseMemoryHeadings' EXACT skip logic; the
//           documented invariant is
//           parseMemoryEntries(raw).length === parseMemoryHeadings(raw).total
//
// Test-design note (house style, per t106.none.test.ts / t69-worktree-path.sh):
// assert the OBSERVABLE CONTRACT, not parser-internal parity. Each expected
// count is hard-coded INDEPENDENTLY of the source so a regression in the
// counting/skip logic surfaces as a numeric mismatch, not silent agreement.
// Re-running parseMemoryHeadings to "check" itself would only catch deletion.
//
// The .sh tested ONLY parseMemoryHeadings (18 assertions). parseMemoryEntries
// is exercised here as one extra `describe` that pins the documented count
// invariant across the same fixtures — a guarantee the .sh never had but the
// source comment (:1043) explicitly promises. It is additive; no .sh contract
// is dropped.

import { describe, expect, test } from "bun:test";
import {
  parseMemoryEntries,
  parseMemoryHeadings,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// ------------------------------------------------------------
// Fixtures — transcribed verbatim from the .sh heredocs. The bash
// heredocs emit LF newlines with NO trailing newline after the final
// content line UNLESS the heredoc body itself ended with a blank line.
// ALL_HEADINGS_EMPTY ends with a trailing blank line in the source.
// ------------------------------------------------------------

const ALL_HEADINGS_EMPTY = [
  "## Interpretations",
  "",
  "## Deviations",
  "",
  "## Tradeoffs",
  "",
  "## Open questions",
  "",
].join("\n");

const ONE_BULLET_EACH = [
  "## Interpretations",
  "- a",
  "## Deviations",
  "- b",
  "## Tradeoffs",
  "- c",
  "## Open questions",
  "- d",
].join("\n");

const MIXED = [
  "## Interpretations",
  "- 2026-05-20T10:14:32Z — bullet with ISO prefix",
  "* alternate bullet glyph",
  "1. numbered bullet",
  "prose paragraph counts as one",
].join("\n");

const BLOCKQUOTE = [
  "## Deviations",
  "> blockquote line should not count",
  "- counted bullet",
].join("\n");

const HTML_COMMENT = [
  "## Tradeoffs",
  "<!-- pure comment -->",
  "- counted bullet",
].join("\n");

const FENCED = [
  "## Interpretations",
  "```",
  "- not counted (inside fence)",
  "- also not counted",
  "```",
  "- counted bullet",
].join("\n");

const NON_CANONICAL = [
  "## Tradeoffs",
  "- counted",
  "## Notes",
  "- not counted",
  "- still not counted",
].join("\n");

const MISSING_HEADING = [
  "## Interpretations",
  "- a",
  "## Deviations",
  "- b",
].join("\n");

// CRLF and BOM fixtures — the .sh built these inline in dedicated `bun -e`
// snippets because heredocs can't carry \r or a BOM. Same literals here.
const CRLF = "## Interpretations\r\n- a\r\n- b\r\n";
const BOM = "﻿## Interpretations\n- a\n";

const LOWERCASE_HEADING = ["## interpretations", "- a"].join("\n");
const SINGULAR_HEADING = ["## Interpretation", "- a"].join("\n");

// ============================================================
// Empty / minimal input (3 assertions — .sh lines 50, 63, 76)
// ============================================================

describe("parseMemoryHeadings — empty / minimal input", () => {
  test("empty string -> total 0", () => {
    // .sh: assert_eq parse_count("" , r.total) "0"
    expect(parseMemoryHeadings("").total).toBe(0);
  });

  test("all four headings, no entries -> total 0", () => {
    // .sh: ALL_HEADINGS_EMPTY r.total "0"
    expect(parseMemoryHeadings(ALL_HEADINGS_EMPTY).total).toBe(0);
  });

  test("one bullet under each of four headings -> total 4", () => {
    // .sh: ONE_BULLET_EACH r.total "4"
    expect(parseMemoryHeadings(ONE_BULLET_EACH).total).toBe(4);
  });
});

// ============================================================
// Per-heading attribution (4 assertions — .sh lines 82-85)
// ============================================================

describe("parseMemoryHeadings — per-heading attribution", () => {
  // One call, four field assertions: the .sh ran four separate `bun -e`
  // spawns over the same fixture, one per field. In-process we call once
  // and assert each field — same observable contract, four guarantees.
  const r = parseMemoryHeadings(ONE_BULLET_EACH);

  test("one bullet under Interpretations -> 1", () => {
    expect(r.interpretations).toBe(1);
  });
  test("one bullet under Deviations -> 1", () => {
    expect(r.deviations).toBe(1);
  });
  test("one bullet under Tradeoffs -> 1", () => {
    expect(r.tradeoffs).toBe(1);
  });
  test("one bullet under Open questions -> 1", () => {
    expect(r.open_questions).toBe(1);
  });
});

// ============================================================
// Mixed entry shapes (1 assertion — .sh line 99)
// ============================================================

describe("parseMemoryHeadings — mixed entry shapes", () => {
  test("bullets + prose + ISO line each count one", () => {
    // .sh: MIXED r.interpretations "4" — `-`, `*`, `1.`, and a bare prose
    // paragraph each count exactly one non-excluded line.
    expect(parseMemoryHeadings(MIXED).interpretations).toBe(4);
  });
});

// ============================================================
// Excluded line shapes (3 assertions — .sh lines 111, 119, 130)
// ============================================================

describe("parseMemoryHeadings — excluded line shapes", () => {
  test("blockquote-only line excluded", () => {
    // .sh: BLOCKQUOTE r.deviations "1" — the `>` line drops; only the
    // bullet counts.
    expect(parseMemoryHeadings(BLOCKQUOTE).deviations).toBe(1);
  });

  test("HTML-comment-only line excluded", () => {
    // .sh: HTML_COMMENT r.tradeoffs "1"
    expect(parseMemoryHeadings(HTML_COMMENT).tradeoffs).toBe(1);
  });

  test("lines inside fenced code block excluded", () => {
    // .sh: FENCED r.interpretations "1" — the two bullets inside the ```
    // fence are skipped; only the bullet after the closing fence counts.
    expect(parseMemoryHeadings(FENCED).interpretations).toBe(1);
  });
});

// ============================================================
// Section termination + missing headings (3 assertions — .sh 144, 153, 154)
// ============================================================

describe("parseMemoryHeadings — section termination + missing headings", () => {
  test("non-canonical heading terminates prior section", () => {
    // .sh: NON_CANONICAL r.total "1" — `## Notes` stops counting; its two
    // bullets are ignored entirely.
    expect(parseMemoryHeadings(NON_CANONICAL).total).toBe(1);
  });

  test("missing canonical heading -> 0 (no throw)", () => {
    // .sh: MISSING_HEADING r.tradeoffs "0"
    expect(parseMemoryHeadings(MISSING_HEADING).tradeoffs).toBe(0);
  });

  test("missing Open questions -> 0", () => {
    // .sh: MISSING_HEADING r.open_questions "0"
    expect(parseMemoryHeadings(MISSING_HEADING).open_questions).toBe(0);
  });
});

// ============================================================
// Tolerance — CRLF, BOM (2 assertions — .sh lines 169, 177)
// ============================================================

describe("parseMemoryHeadings — CRLF / BOM tolerance", () => {
  test("CRLF input -> counts identical to LF", () => {
    // .sh: inline `bun -e` over '## Interpretations\r\n- a\r\n- b\r\n' => 2
    expect(parseMemoryHeadings(CRLF).interpretations).toBe(2);
  });

  test("leading BOM tolerated", () => {
    // .sh: inline `bun -e` over '﻿## Interpretations\n- a\n' => 1
    expect(parseMemoryHeadings(BOM).interpretations).toBe(1);
  });
});

// ============================================================
// Exact-match heading strictness (2 assertions — .sh lines 188, 195)
// ============================================================

describe("parseMemoryHeadings — exact-match heading strictness", () => {
  test("lowercase '## interpretations' does NOT anchor", () => {
    // .sh: LOWERCASE_HEADING r.total "0"
    expect(parseMemoryHeadings(LOWERCASE_HEADING).total).toBe(0);
  });

  test("singular '## Interpretation' does NOT anchor", () => {
    // .sh: SINGULAR_HEADING r.total "0"
    expect(parseMemoryHeadings(SINGULAR_HEADING).total).toBe(0);
  });
});

// ============================================================
// parseMemoryEntries count invariant (ADDITIVE — not in the .sh)
// ------------------------------------------------------------
// Source comment :1043 promises:
//   parseMemoryEntries(raw).length === parseMemoryHeadings(raw).total
// for ANY input — one entry per counted line, no multi-line merging. The
// .sh never guarded this companion. Pinning it across the SAME fixtures
// catches a future divergence in the two functions' shared skip logic
// (e.g. one updated to skip a new line shape, the other not).
// ============================================================

describe("parseMemoryEntries — count invariant vs parseMemoryHeadings", () => {
  const cases: Array<[string, string]> = [
    ["empty", ""],
    ["all headings empty", ALL_HEADINGS_EMPTY],
    ["one bullet each", ONE_BULLET_EACH],
    ["mixed shapes", MIXED],
    ["blockquote excluded", BLOCKQUOTE],
    ["html comment excluded", HTML_COMMENT],
    ["fenced excluded", FENCED],
    ["non-canonical terminates", NON_CANONICAL],
    ["missing heading", MISSING_HEADING],
    ["crlf", CRLF],
    ["bom", BOM],
    ["lowercase heading", LOWERCASE_HEADING],
    ["singular heading", SINGULAR_HEADING],
  ];

  for (const [name, raw] of cases) {
    test(`length === total for: ${name}`, () => {
      expect(parseMemoryEntries(raw).length).toBe(
        parseMemoryHeadings(raw).total
      );
    });
  }
});

// ============================================================
// Type guard — both functions throw on non-string (ADDITIVE)
// ------------------------------------------------------------
// The source guards typeof raw !== "string" with a throw (:978, :1056). The
// .sh never reached this branch (every fixture was a string). Pinned here so
// a future edit that loosens the guard (returns NaN / silently coerces) is
// caught — a non-string memory.md path slipping through would corrupt counts
// downstream. This is the throw-contract half of "assert thrown errors".
// ============================================================

describe("type guard — non-string raw throws", () => {
  test("parseMemoryHeadings(number) throws", () => {
    // @ts-expect-error — deliberately passing a non-string to hit the guard.
    expect(() => parseMemoryHeadings(42)).toThrow(
      /parseMemoryHeadings expected string/
    );
  });

  test("parseMemoryEntries(null) throws", () => {
    // @ts-expect-error — deliberately passing a non-string to hit the guard.
    expect(() => parseMemoryEntries(null)).toThrow(
      /parseMemoryEntries expected string/
    );
  });
});
