// covers: function:parseMemoryHeadings, function:parseMemoryEntries
//
// t88 - section 13 memory.md heading-counter parseMemoryHeadings() in
// aidlc-lib.ts, plus the parseMemoryEntries() count invariant.
// Mechanism: none (pure functions, zero I/O, zero LLM, zero tokens).
// Technique: example-based.
//
// Source (dist/claude/.claude/tools/aidlc-lib.ts):
//   parseMemoryHeadings(raw): { interpretations, deviations,
//       tradeoffs, open_questions, total }
//       - throws on non-string raw
//       - BOM strip + CRLF->LF normalise before split
//       - four exact-match canonical H2 anchors gate counting
//       - non-canonical H2 (`## X`) terminates the prior section
//       - skips: blank/ws-only, blockquote (`>`), HTML-comment-only,
//         code-fence delimiters (```), lines inside a fence, heading
//         lines themselves
//       - missing heading => 0 for that key, never throws
//   parseMemoryEntries(raw): Array<{heading, ts, unit?, summary, context,
//       raw}> - reuses parseMemoryHeadings' EXACT skip logic; the
//       documented invariant is
//       parseMemoryEntries(raw).length === parseMemoryHeadings(raw).total
//
// Test-design note:
// assert the OBSERVABLE CONTRACT, not parser-internal parity. Each expected
// count is hard-coded INDEPENDENTLY of the source so a regression in the
// counting/skip logic surfaces as a numeric mismatch, not silent agreement.
// Re-running parseMemoryHeadings to "check" itself would only catch deletion.
//
// parseMemoryEntries is exercised as one describe that pins the documented
// count invariant across the same fixtures - a guarantee the source comment
// for parseMemoryEntries explicitly promises.

import { describe, expect, test } from "bun:test";
import {
  parseMemoryEntries,
  parseMemoryHeadings,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// ------------------------------------------------------------
// Fixtures
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

const CRLF = "## Interpretations\r\n- a\r\n- b\r\n";
const BOM = "﻿## Interpretations\n- a\n";

const LOWERCASE_HEADING = ["## interpretations", "- a"].join("\n");
const SINGULAR_HEADING = ["## Interpretation", "- a"].join("\n");

// ============================================================
// Empty / minimal input (3 assertions)
// ============================================================

describe("parseMemoryHeadings — empty / minimal input", () => {
  test("empty string -> total 0", () => {
    expect(parseMemoryHeadings("").total).toBe(0);
  });

  test("all four headings, no entries -> total 0", () => {
    expect(parseMemoryHeadings(ALL_HEADINGS_EMPTY).total).toBe(0);
  });

  test("one bullet under each of four headings -> total 4", () => {
    expect(parseMemoryHeadings(ONE_BULLET_EACH).total).toBe(4);
  });
});

// ============================================================
// Per-heading attribution (4 assertions)
// ============================================================

describe("parseMemoryHeadings — per-heading attribution", () => {
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
// Mixed entry shapes (1 assertion)
// ============================================================

describe("parseMemoryHeadings — mixed entry shapes", () => {
  test("bullets + prose + ISO line each count one", () => {
    // `-`, `*`, `1.`, and a bare prose paragraph each count exactly one
    // non-excluded line.
    expect(parseMemoryHeadings(MIXED).interpretations).toBe(4);
  });
});

// ============================================================
// Excluded line shapes (3 assertions)
// ============================================================

describe("parseMemoryHeadings — excluded line shapes", () => {
  test("blockquote-only line excluded", () => {
    expect(parseMemoryHeadings(BLOCKQUOTE).deviations).toBe(1);
  });

  test("HTML-comment-only line excluded", () => {
    expect(parseMemoryHeadings(HTML_COMMENT).tradeoffs).toBe(1);
  });

  test("lines inside fenced code block excluded", () => {
    // The two bullets inside the ``` fence are skipped; only the bullet after
    // the closing fence counts.
    expect(parseMemoryHeadings(FENCED).interpretations).toBe(1);
  });
});

// ============================================================
// Section termination + missing headings (3 assertions)
// ============================================================

describe("parseMemoryHeadings — section termination + missing headings", () => {
  test("non-canonical heading terminates prior section", () => {
    // `## Notes` stops counting; its two bullets are ignored entirely.
    expect(parseMemoryHeadings(NON_CANONICAL).total).toBe(1);
  });

  test("missing canonical heading -> 0 (no throw)", () => {
    expect(parseMemoryHeadings(MISSING_HEADING).tradeoffs).toBe(0);
  });

  test("missing Open questions -> 0", () => {
    expect(parseMemoryHeadings(MISSING_HEADING).open_questions).toBe(0);
  });
});

// ============================================================
// Tolerance - CRLF, BOM (2 assertions)
// ============================================================

describe("parseMemoryHeadings — CRLF / BOM tolerance", () => {
  test("CRLF input -> counts identical to LF", () => {
    expect(parseMemoryHeadings(CRLF).interpretations).toBe(2);
  });

  test("leading BOM tolerated", () => {
    expect(parseMemoryHeadings(BOM).interpretations).toBe(1);
  });
});

// ============================================================
// Exact-match heading strictness (2 assertions)
// ============================================================

describe("parseMemoryHeadings — exact-match heading strictness", () => {
  test("lowercase '## interpretations' does NOT anchor", () => {
    expect(parseMemoryHeadings(LOWERCASE_HEADING).total).toBe(0);
  });

  test("singular '## Interpretation' does NOT anchor", () => {
    expect(parseMemoryHeadings(SINGULAR_HEADING).total).toBe(0);
  });
});

// ============================================================
// parseMemoryEntries count invariant
// ------------------------------------------------------------
// The parseMemoryEntries source comment promises:
//   parseMemoryEntries(raw).length === parseMemoryHeadings(raw).total
// for ANY input - one entry per counted line, no multi-line merging. Pinning
// it across the SAME fixtures catches a future divergence in the two
// functions' shared skip logic (e.g. one updated to skip a new line shape,
// the other not).
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
// Type guard - both functions throw on non-string
// ------------------------------------------------------------
// The source guards typeof raw !== "string" with a throw. Pinned here so
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

// ============================================================
// The Unit a diary line was written for
// ------------------------------------------------------------
// A Unit's iteration of a stage tags its line `[unit <name>]` right after the
// timestamp, so a Unit's checkpoint offers that Unit's notes only. An untagged
// line names no Unit.

describe("parseMemoryEntries: the Unit tag", () => {
  const dash = "\u2014"; // the diary line's separator, an em dash
  const raw = [
    "## Tradeoffs",
    `- 2026-10-05T10:00:00Z [unit alpha] ${dash} kept one store; two would drift`,
    `- 2026-10-05T10:05:00Z ${dash} logs stay in UTC; the team asked for it`,
    "",
  ].join("\n");

  test("a tagged line names its Unit and keeps ts, summary and context", () => {
    const [tagged, plain] = parseMemoryEntries(raw);
    expect(tagged).toMatchObject({
      heading: "Tradeoffs", ts: "2026-10-05T10:00:00Z", unit: "alpha",
      summary: "kept one store", context: "two would drift",
    });
    expect(plain).toMatchObject({ ts: "2026-10-05T10:05:00Z", summary: "logs stay in UTC" });
    expect(plain.unit).toBeUndefined();
  });

  test("length === total with a tagged line", () => {
    expect(parseMemoryEntries(raw).length).toBe(parseMemoryHeadings(raw).total);
  });
});
