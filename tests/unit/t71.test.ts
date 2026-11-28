// covers: function:extractMarkdownSection, function:appendUnderHeading, function:replaceSection
//   (dist/claude/.claude/tools/aidlc-lib.ts)
//
// These helpers are load-bearing for the practices-discovery cross-row
// promotion (extract reads the draft's sections, replaceSection writes them
// into team.md, appendUnderHeading adds rules to project.md).

import { describe, expect, test } from "bun:test";
import {
  appendUnderHeading,
  extractMarkdownSection,
  replaceSection,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

describe("extractMarkdownSection", () => {
  test("returns prose between heading and next ##", () => {
    const c = "# Title\n\n## Branching\n\nWe trunk-base.\n\n## Testing\n\nTDD.\n";
    expect(extractMarkdownSection(c, "## Branching")).toBe("\nWe trunk-base.\n\n");
  });

  test("returns empty string for missing heading", () => {
    const c = "# Title\n\n## Branching\n\nWe trunk-base.\n";
    expect(extractMarkdownSection(c, "## Missing")).toBe("");
  });

  test("returns prose to EOF when heading is last section", () => {
    const c = "## Branching\n\nWe trunk-base.\n";
    expect(extractMarkdownSection(c, "## Branching")).toBe("\nWe trunk-base.\n");
  });

  test("treats ### as content, not section boundary", () => {
    const c = "## Branching\n\nMain text.\n\n### Sub\n\nMore.\n\n## Next\n";
    const out = extractMarkdownSection(c, "## Branching");
    expect(out).toContain("### Sub");
    expect(out).toContain("More.");
  });
});

describe("appendUnderHeading", () => {
  test("inserts content before the next ## heading", () => {
    const c = "## Mandated\n\n## Forbidden\n";
    // A blank line separates the inserted content from the following heading:
    // single-`\n`-terminated content must not abut the next `## ` heading.
    expect(appendUnderHeading(c, "## Mandated", "ALWAYS test\n")).toBe(
      "## Mandated\n\nALWAYS test\n\n## Forbidden\n",
    );
  });

  test("inserts at EOF when heading is the last section", () => {
    const c = "## Mandated\n";
    expect(appendUnderHeading(c, "## Mandated", "ALWAYS test\n")).toBe(
      "## Mandated\nALWAYS test\n",
    );
  });

  test("throws on missing heading", () => {
    expect(() => appendUnderHeading("## Other\n", "## Missing", "x")).toThrow(
      /heading not found/,
    );
  });

  test("is additive (does not deduplicate)", () => {
    let c = "## Mandated\n";
    c = appendUnderHeading(c, "## Mandated", "rule\n");
    c = appendUnderHeading(c, "## Mandated", "rule\n");
    const count = c.split("\n").filter((l) => l === "rule").length;
    expect(count).toBe(2);
  });

  // Regression (#1075): a bullet written under `## Decided` in the shipped
  // project.md shape must be separated from the following `## Scope Overrides`
  // heading by a blank line — the section writer must not abut the heading.
  test("separates an inserted bullet from the following heading with a blank line", () => {
    const projectMd =
      "## Decided\n\n<!-- decisions -->\n\n## Scope Overrides\n\n<!-- overrides -->\n";
    const out = appendUnderHeading(
      projectMd,
      "## Decided",
      "- DECIDED: use Result<T,E> (learned 2026-09-09) <!-- cid:x -->\n",
    );
    expect(out).toContain(
      "- DECIDED: use Result<T,E> (learned 2026-09-09) <!-- cid:x -->\n\n## Scope Overrides",
    );
    expect(out).not.toContain("<!-- cid:x -->\n\n\n## Scope Overrides");
  });
});

describe("replaceSection", () => {
  test("overwrites section content", () => {
    const c = "## Branching\n\nOld text.\n\n## Testing\n\nTDD.\n";
    const out = replaceSection(c, "## Branching", "\nNew text.\n\n");
    expect(out).toContain("New text");
    expect(out).not.toContain("Old text");
  });

  test("preserves heading line and downstream sections", () => {
    const c = "## Branching\n\nOld.\n\n## Testing\n\nTDD.\n";
    const out = replaceSection(c, "## Branching", "\nNew.\n\n");
    expect(out).toContain("## Branching");
    expect(out).toContain("## Testing");
    expect(out).toContain("TDD");
  });

  test("is idempotent on re-run with same content", () => {
    let c = "## Branching\n\nOriginal.\n\n## Testing\n\nTDD.\n";
    c = replaceSection(c, "## Branching", "\nAffirmed.\n\n");
    c = replaceSection(c, "## Branching", "\nAffirmed.\n\n");
    const count = c.split("\n").filter((l) => l === "Affirmed.").length;
    expect(count).toBe(1);
  });

  test("throws on missing heading", () => {
    expect(() => replaceSection("## Other\n", "## Missing", "x")).toThrow(
      /heading not found/,
    );
  });
});

describe("a heading on a Windows (CRLF) line", () => {
  test("extract starts the section after the whole line break", () => {
    const c = "# Title\r\n\r\n## Branching\r\nWe trunk-base.\r\n\r\n## Testing\r\nTDD.\r\n";
    expect(extractMarkdownSection(c, "## Branching")).toBe("We trunk-base.\r\n\r\n");
    expect(extractMarkdownSection(c, "## Testing")).toBe("TDD.\r\n");
  });

  test("replace keeps the heading on its own line", () => {
    const c = "## Branching\r\nOld.\r\n\r\n## Testing\r\nTDD.\r\n";
    expect(replaceSection(c, "## Branching", "New.\r\n\r\n")).toBe("## Branching\r\nNew.\r\n\r\n## Testing\r\nTDD.\r\n");
  });

  test("a heading that ends the text with no line break gets the content right after it", () => {
    expect(extractMarkdownSection("## Testing", "## Testing")).toBe("");
    expect(replaceSection("## Testing", "## Testing", "\nTDD.\n")).toBe("## Testing\nTDD.\n");
    expect(appendUnderHeading("## Mandated\r", "## Mandated", "\n- a")).toBe("## Mandated\r\n- a");
  });
});
