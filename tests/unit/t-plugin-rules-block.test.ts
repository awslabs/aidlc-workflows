// covers: file:core/tools/aidlc-plugin.ts, function:renderRulesBlock, function:placeRulesBlock, function:stripRulesBlock, function:nestRulesHeadings, function:rulesBlockCurrent
//
// A plugin's rules land as one section of their own at the end of a rule file:
// placed, replaced and removed byte for byte, in the file's own line endings,
// and never disturbed by the team's own writers (practices-promote's
// replaceSection, learnings' ensureHeading and appendUnderHeading).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fragmentProseHash,
  nestRulesHeadings,
  placeRulesBlock,
  renderRulesBlock,
  rulesBlockCurrent,
  stripRulesBlock,
} from "../../dist/claude/.claude/tools/aidlc-plugin.ts";
import { appendUnderHeading, replaceSection } from "../../dist/claude/.claude/tools/aidlc-markdown.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEAM_SEED = readFileSync(join(REPO_ROOT, "core", "memory", "team.md"), "utf-8");
const PROJECT_SEED = readFileSync(join(REPO_ROOT, "core", "memory", "project.md"), "utf-8");
const RULES = "- Every Unit ships tests that fail before the code exists.\n- Name each test after the behaviour it proves.\n";

function blockOf(content: string, key: string): string {
  const start = content.indexOf(`## Rules from the ${key} plugin`);
  const close = content.indexOf(`<!-- /plugin:${key}:rules:`);
  if (start === -1 || close === -1) return "";
  return content.slice(start, content.indexOf("-->", close) + 3);
}

describe("the rules block", () => {
  test("one ## section the plugin owns: heading, paired markers, the owner line, the rules", () => {
    const block = renderRulesBlock("test-pro", RULES);
    const body = nestRulesHeadings(RULES).replace(/\n+$/, "");
    const hash = fragmentProseHash(body);
    expect(block).toBe(
      "## Rules from the test-pro plugin\n" +
        `<!-- plugin:test-pro:rules:0:${hash} -->\n` +
        "<!-- The test-pro plugin owns this section and plugin sync rewrites it; put the team's own rules in team.md, outside this section. -->\n" +
        `${body}\n` +
        `<!-- /plugin:test-pro:rules:0:${hash} -->\n`,
    );
    expect(block.split("\n").filter((line) => /^## /.test(line))).toEqual(["## Rules from the test-pro plugin"]);
  });

  test("a rules file's own headings are written one level down, never as a ## section", () => {
    const text = "# Testing\n\n## Unit tests\n\n### Naming\n\nSetext title\n============\n\nSetext two\n----------\n\n```md\n## inside a fence\n```\n";
    expect(nestRulesHeadings(text)).toBe(
      "### Testing\n\n### Unit tests\n\n#### Naming\n\n### Setext title\n\n### Setext two\n\n```md\n## inside a fence\n```\n",
    );
  });

  test("placed at the end with one blank line, the same bytes again on a second place, and stripped back to the file", () => {
    const block = renderRulesBlock("test-pro", RULES);
    const placed = placeRulesBlock(TEAM_SEED, "test-pro", block);
    expect(placed).toBe(`${TEAM_SEED}\n${block}`);
    expect(placeRulesBlock(placed, "test-pro", block)).toBe(placed);
    expect(rulesBlockCurrent(placed, "test-pro", block)).toBe(true);
    expect(stripRulesBlock(placed, "test-pro")).toBe(TEAM_SEED);
    expect(stripRulesBlock(TEAM_SEED, "test-pro")).toBe(TEAM_SEED);
  });

  test("a new version, or a hand edit inside the section, is replaced in place", () => {
    const old = renderRulesBlock("test-pro", RULES);
    const placed = `${placeRulesBlock(TEAM_SEED, "test-pro", old)}\n## Forbidden after\n\n- NEVER x\n`;
    const edited = placed.replace("Name each test", "Name every test");
    expect(rulesBlockCurrent(edited, "test-pro", old)).toBe(false);
    expect(placeRulesBlock(edited, "test-pro", old)).toBe(placed);
    const next = renderRulesBlock("test-pro", `${RULES}- Keep a regression test per fixed bug.\n`);
    const updated = placeRulesBlock(placed, "test-pro", next);
    expect(updated).toBe(placed.replace(old, next));
  });

  test("two plugins sit in key order at the end, and one off then on comes back byte for byte", () => {
    const alpha = renderRulesBlock("alpha", "- Alpha rule.\n");
    const zeta = renderRulesBlock("zeta", "- Zeta rule.\n");
    const both = placeRulesBlock(placeRulesBlock(TEAM_SEED, "zeta", zeta), "alpha", alpha);
    expect(both.indexOf("## Rules from the alpha plugin")).toBeLessThan(both.indexOf("## Rules from the zeta plugin"));
    expect(both).toBe(placeRulesBlock(placeRulesBlock(TEAM_SEED, "alpha", alpha), "zeta", zeta));
    for (const key of ["alpha", "zeta"]) {
      const off = stripRulesBlock(both, key);
      expect(off.includes(`## Rules from the ${key} plugin`)).toBe(false);
      expect(placeRulesBlock(off, key, key === "alpha" ? alpha : zeta)).toBe(both);
    }
  });

  test("a CRLF file keeps CRLF when the block is placed, replaced and stripped", () => {
    const crlf = TEAM_SEED.replace(/\n/g, "\r\n");
    const block = renderRulesBlock("test-pro", RULES);
    const placed = placeRulesBlock(crlf, "test-pro", block);
    expect(placed).toBe(`${crlf}\r\n${block.replace(/\n/g, "\r\n")}`);
    expect(/(^|[^\r])\n/.test(placed)).toBe(false);
    expect(rulesBlockCurrent(placed, "test-pro", block)).toBe(true);
    expect(placeRulesBlock(placed, "test-pro", block)).toBe(placed);
    expect(stripRulesBlock(placed, "test-pro")).toBe(crlf);
  });

  test("a marker left without its pair is the same error removeFragments gives", () => {
    const placed = placeRulesBlock(TEAM_SEED, "test-pro", renderRulesBlock("test-pro", RULES));
    const broken = placed.replace(/<!-- \/plugin:test-pro:rules:[^\n]*-->\n/, "");
    expect(() => stripRulesBlock(broken, "test-pro")).toThrow("unpaired plugin fragment for test-pro");
  });
});

describe("the team's own writers never reach inside the block", () => {
  const block = renderRulesBlock("test-pro", RULES);

  test("practices-promote's five team.md sections, rewritten whole", () => {
    let content = placeRulesBlock(TEAM_SEED, "test-pro", block);
    for (const heading of ["## Way of Working", "## Walking Skeleton", "## Testing Posture", "## Deployment", "## Code Style"]) {
      content = replaceSection(content, heading, "\nWe agreed this.\n\n");
    }
    expect(blockOf(content, "test-pro")).toBe(block.trimEnd());
    expect(content.endsWith(block)).toBe(true);
  });

  test("a learning under Corrections, the section right above the block, and under Mandated and Forbidden", () => {
    let content = placeRulesBlock(PROJECT_SEED, "test-pro", block);
    for (const heading of ["## Corrections", "## Mandated", "## Forbidden"]) {
      content = appendUnderHeading(content, heading, `- ALWAYS ${heading.slice(3)} line\n`);
    }
    expect(content.endsWith(block)).toBe(true);
    const corrections = content.slice(content.indexOf("## Corrections"), content.indexOf("## Rules from the test-pro plugin"));
    expect(corrections).toContain("- ALWAYS Corrections line");
  });

  test("a learning whose heading is missing (a new space's stub) lands after the block, outside it", () => {
    const stub = placeRulesBlock("# Team practices\n", "test-pro", block);
    // learnings' ensureHeading: a missing heading goes at the end of the file
    const ensured = `${stub}\n## Forbidden\n`;
    const content = appendUnderHeading(ensured, "## Forbidden", "- NEVER skip the failing test\n");
    expect(blockOf(content, "test-pro")).toBe(block.trimEnd());
    expect(content.indexOf("- NEVER skip")).toBeGreaterThan(content.indexOf("<!-- /plugin:test-pro:rules:"));
    expect(stripRulesBlock(content, "test-pro")).toBe("# Team practices\n\n## Forbidden\n- NEVER skip the failing test\n");
  });
});
