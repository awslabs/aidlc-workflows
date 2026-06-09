// t71.none.test.ts — bun:test port of t71-markdown-section-helpers.sh
//
// Mechanism: none (no env seam / no subprocess). Every contract is a pure
// string->string (or throwing) function in aidlc-lib.ts, so each old `bun -e`
// spawn becomes a direct import-and-call. No file I/O, no CLI arg parsing, no
// process.exit shell to preserve — all 12 contracts map 1:1 to in-process
// assertions.
//
// covers: function:extractMarkdownSection, function:appendUnderHeading, function:replaceSection
//   (dist/claude/.claude/tools/aidlc-lib.ts)
//
// These helpers are load-bearing for the practices-discovery cross-row
// promotion (extract reads existing team.md sections, replaceSection
// overwrites them, appendUnderHeading adds rules to project-guardrails.md).
// The behavioural contract pinned here is identical to the retired .sh.

import { describe, expect, test } from "bun:test";
import {
  appendUnderHeading,
  extractMarkdownSection,
  replaceSection,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

describe("extractMarkdownSection", () => {
  // .sh #1: Returns prose between heading and next ## heading
  test("returns prose between heading and next ##", () => {
    const c = "# Title\n\n## Branching\n\nWe trunk-base.\n\n## Testing\n\nTDD.\n";
    expect(extractMarkdownSection(c, "## Branching")).toBe("\nWe trunk-base.\n\n");
  });

  // .sh #2: Returns empty string when heading absent
  test("returns empty string for missing heading", () => {
    const c = "# Title\n\n## Branching\n\nWe trunk-base.\n";
    expect(extractMarkdownSection(c, "## Missing")).toBe("");
  });

  // .sh #3: Returns prose to EOF when heading is the last section
  test("returns prose to EOF when heading is last section", () => {
    const c = "## Branching\n\nWe trunk-base.\n";
    expect(extractMarkdownSection(c, "## Branching")).toBe("\nWe trunk-base.\n");
  });

  // .sh #4: Sub-headings (### ) inside the section are preserved (not stopped on)
  test("treats ### as content, not section boundary", () => {
    const c = "## Branching\n\nMain text.\n\n### Sub\n\nMore.\n\n## Next\n";
    const out = extractMarkdownSection(c, "## Branching");
    expect(out).toContain("### Sub");
    expect(out).toContain("More.");
  });
});

describe("appendUnderHeading", () => {
  // .sh #5: Inserts new content before the next ## heading
  test("inserts content before the next ## heading", () => {
    const c = "## Mandated\n\n## Forbidden\n";
    expect(appendUnderHeading(c, "## Mandated", "ALWAYS test\n")).toBe(
      "## Mandated\n\nALWAYS test\n## Forbidden\n",
    );
  });

  // .sh #6: Inserts at EOF when heading is the last section
  test("inserts at EOF when heading is the last section", () => {
    const c = "## Mandated\n";
    expect(appendUnderHeading(c, "## Mandated", "ALWAYS test\n")).toBe(
      "## Mandated\nALWAYS test\n",
    );
  });

  // .sh #7: Throws when heading is missing (message contains "heading not found")
  test("throws on missing heading", () => {
    expect(() => appendUnderHeading("## Other\n", "## Missing", "x")).toThrow(
      /heading not found/,
    );
  });

  // .sh #8: Append is additive across calls (no de-duplication) — 2 "rule" lines
  test("is additive (does not deduplicate)", () => {
    let c = "## Mandated\n";
    c = appendUnderHeading(c, "## Mandated", "rule\n");
    c = appendUnderHeading(c, "## Mandated", "rule\n");
    const count = c.split("\n").filter((l) => l === "rule").length;
    expect(count).toBe(2);
  });
});

describe("replaceSection", () => {
  // .sh #9: Overwrites prose between heading and next ## heading
  test("overwrites section content", () => {
    const c = "## Branching\n\nOld text.\n\n## Testing\n\nTDD.\n";
    const out = replaceSection(c, "## Branching", "\nNew text.\n\n");
    expect(out).toContain("New text");
    expect(out).not.toContain("Old text");
  });

  // .sh #10: Preserves the heading line and downstream sections
  test("preserves heading line and downstream sections", () => {
    const c = "## Branching\n\nOld.\n\n## Testing\n\nTDD.\n";
    const out = replaceSection(c, "## Branching", "\nNew.\n\n");
    expect(out).toContain("## Branching");
    expect(out).toContain("## Testing");
    expect(out).toContain("TDD");
  });

  // .sh #11: Idempotent across reruns with the same content — 1 "Affirmed." line
  test("is idempotent on re-run with same content", () => {
    let c = "## Branching\n\nOriginal.\n\n## Testing\n\nTDD.\n";
    c = replaceSection(c, "## Branching", "\nAffirmed.\n\n");
    c = replaceSection(c, "## Branching", "\nAffirmed.\n\n");
    const count = c.split("\n").filter((l) => l === "Affirmed.").length;
    expect(count).toBe(1);
  });

  // .sh #12: Throws when heading is missing (message contains "heading not found")
  test("throws on missing heading", () => {
    expect(() => replaceSection("## Other\n", "## Missing", "x")).toThrow(
      /heading not found/,
    );
  });
});
