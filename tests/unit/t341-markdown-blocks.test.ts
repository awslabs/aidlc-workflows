// covers: file:core/tools/aidlc-lib.ts
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { markdownBlocks } from "../../core/tools/aidlc-lib.ts";

const ROOT = resolve(import.meta.dir, "../..");
const kinds = (text: string) => markdownBlocks(text).lines.map((line) => line.kind);

describe("t341 Markdown block adapter", () => {
  test("an ordered item starting at two cannot interrupt a paragraph", () => {
    const blocks = markdownBlocks("- prose\n  2. [Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "paragraph"]);
    expect(blocks.lines[0].containers).toEqual([
      { kind: "listItem", ordered: false, start: null, marker: "-", id: 0, contentIndent: 2 },
    ]);
    expect(blocks.lines[1].containers).toEqual(blocks.lines[0].containers);
    expect(blocks.lines.map((line) => line.contentStart)).toEqual([2, 2]);
    expect(blocks.definitions).toEqual([]);
  });

  test("an ordered item starting at one can contain a definition", () => {
    const blocks = markdownBlocks("- prose\n  1. [Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "definition"]);
    expect(blocks.lines[1].containers).toEqual([
      { kind: "listItem", ordered: false, start: null, marker: "-", id: 0, contentIndent: 2 },
      { kind: "listItem", ordered: true, start: 1, marker: ".", id: 10, contentIndent: 5 },
    ]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 1, endLine: 1 }]);
  });

  test("fences inside processing instructions cannot erase a following definition", () => {
    const blocks = markdownBlocks("<?php\n```\n?>\n[Q1]: /url\n```");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["htmlFlow", "htmlFlow", "htmlFlow", "definition", "codeFenced"]);
    expect(blocks.lines.map((line) => line.htmlKind)).toEqual([3, 3, 3, null, null]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 3, endLine: 3 }]);
  });

  test("a same-line declaration ends before a definition", () => {
    const blocks = markdownBlocks("<!DOCTYPE html>\n[Q1]: /url");
    expect(blocks.lines.map((line) => [line.kind, line.htmlKind])).toEqual([["htmlFlow", 4], ["definition", null]]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 1, endLine: 1 }]);
  });

  test("block HTML contains definition-looking text", () => {
    const blocks = markdownBlocks("<div>\n[Q1]: /url\n</div>");
    expect(blocks.lines.map((line) => [line.kind, line.htmlKind])).toEqual([
      ["htmlFlow", 6], ["htmlFlow", 6], ["htmlFlow", 6],
    ]);
    expect(blocks.definitions).toEqual([]);
  });

  test("quote exit terminates an HTML block", () => {
    const blocks = markdownBlocks("> <div>\n[Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["htmlFlow", "definition"]);
    expect(blocks.lines[0].containers).toEqual([{ kind: "blockQuote" }]);
    expect(blocks.lines[0].contentStart).toBe(2);
    expect(blocks.lines[1].containers).toEqual([]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 1, endLine: 1 }]);
  });

  test("nested item exit terminates HTML without exiting its parent item", () => {
    const blocks = markdownBlocks("- - item\n    <?php\n  [Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "htmlFlow", "definition"]);
    expect(blocks.lines[0].containers).toEqual([
      { kind: "listItem", ordered: false, start: null, marker: "-", id: 0, contentIndent: 2 },
      { kind: "listItem", ordered: false, start: null, marker: "-", id: 2, contentIndent: 4 },
    ]);
    expect(blocks.lines[1].containers).toEqual(blocks.lines[0].containers);
    expect(blocks.lines[2].containers).toEqual([blocks.lines[0].containers[0]]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 2, endLine: 2 }]);
  });

  test("spaced thematic breaks are not nested list items", () => {
    const blocks = markdownBlocks("- - -\n[Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["thematicBreak", "definition"]);
    expect(blocks.lines[0].containers).toEqual([]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 1, endLine: 1 }]);
  });

  test("marker-only lines retain the item that later receives content", () => {
    const blocks = markdownBlocks("-\n  foo");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["listItemPrefix", "paragraph"]);
    expect(blocks.lines[1].containers).toEqual(blocks.lines[0].containers);
    expect(blocks.lines[0].containers).toEqual([
      { kind: "listItem", ordered: false, start: null, marker: "-", id: 0, contentIndent: 2 },
    ]);
    expect(blocks.lines.map((line) => line.contentStart)).toEqual([1, 2]);
  });

  test("setext underline belongs to the heading rather than an empty item", () => {
    expect(kinds("Some prose\n-")).toEqual(["heading", "heading"]);
  });

  test("multiline code spans retain raw-line positions and do not swallow definitions", () => {
    const blocks = markdownBlocks("a `code\nspan` b\n\n[Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "paragraph", "blank", "definition"]);
    expect(blocks.lines.map((line) => line.invisible)).toEqual([
      [{ start: 2, end: 7, kind: "codeText" }],
      [{ start: 0, end: 5, kind: "codeText" }],
      [], [],
    ]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 3, endLine: 3 }]);
  });

  test("GFM table delimiters and rows form one table", () => {
    expect(kinds("| a |\n|---|\n| b |")).toEqual(["table", "table", "table"]);
  });

  test.each([
    ["  <script>\n```\n</script>\n[Q1]: /url", 1, 3],
    ["<!--\n```\n-->\n[Q1]: /url", 2, 3],
    ["<![CDATA[\n```\n]]>\n[Q1]: /url", 5, 3],
    ["  <div>\n```\n</div>\n\n[Q1]: /url", 6, 3],
    ["<custom-element flag='yes'>\n```\n\n[Q1]: /url", 7, 2],
  ] as const)("classifies HTML block kind from its opener: %s", (text, htmlKind, length) => {
    const blocks = markdownBlocks(text);
    expect(blocks.lines.slice(0, length).map((line) => [line.kind, line.htmlKind])).toEqual(
      Array.from({ length }, () => ["htmlFlow", htmlKind]),
    );
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: blocks.lines.length - 1, endLine: blocks.lines.length - 1 }]);
    if (text.startsWith("  ")) expect(blocks.lines[0].contentStart).toBe(2);
  });

  test("inline markup distinguishes comments from tags and leaves their visible text", () => {
    const blocks = markdownBlocks("a <!-- hidden\nx --> <b>shown</b>");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "paragraph"]);
    expect(blocks.lines.map((line) => line.invisible)).toEqual([
      [{ start: 2, end: 13, kind: "htmlComment" }],
      [{ start: 0, end: 5, kind: "htmlComment" }, { start: 6, end: 9, kind: "htmlText" }, { start: 14, end: 18, kind: "htmlText" }],
    ]);
  });

  test("multiline invisible spans exclude quote markers on continuation lines", () => {
    const blocks = markdownBlocks("> a `x\n> y` z");
    expect(blocks.lines.map((line) => line.contentStart)).toEqual([2, 2]);
    expect(blocks.lines.map((line) => line.invisible)).toEqual([
      [{ start: 4, end: 6, kind: "codeText" }], [{ start: 2, end: 4, kind: "codeText" }],
    ]);
  });

  test("tabs count as raw columns and sibling items receive distinct identities", () => {
    const blocks = markdownBlocks("-\t`a`\n- b\n\n  c");
    expect(blocks.lines[0].contentStart).toBe(2);
    expect(blocks.lines[0].invisible).toEqual([{ start: 2, end: 5, kind: "codeText" }]);
    expect(blocks.lines[1].containers).toEqual([
      { kind: "listItem", ordered: false, start: null, marker: "-", id: 6, contentIndent: 2 },
    ]);
    expect(blocks.lines[3].containers).toEqual(blocks.lines[1].containers);
    expect(blocks.lines[2].kind).toBe("blank");
  });

  test("lazy quote continuations retain the quote without inventing a prefix", () => {
    const blocks = markdownBlocks("> first\ncontinued\n> again");
    expect(blocks.lines.map((line) => line.contentStart)).toEqual([2, 0, 2]);
    expect(blocks.lines.map((line) => line.containers)).toEqual([
      [{ kind: "blockQuote" }], [{ kind: "blockQuote" }], [{ kind: "blockQuote" }],
    ]);
  });

  test("normalizes line endings and multiline definition labels before exposing positions", () => {
    const blocks = markdownBlocks("\uFEFF[ Mixed\r\n  Case ]:\r /url\r\n");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["definition", "definition", "definition", "blank"]);
    expect(blocks.definitions).toEqual([{ label: "MIXED CASE", startLine: 0, endLine: 2 }]);
    expect(kinds("")).toEqual(["blank"]);
    expect(kinds("\n")).toEqual(["blank", "blank"]);
  });

  test("classifies indented code without interpreting its inline-looking content", () => {
    const blocks = markdownBlocks("    `code`\n\n# heading");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["codeIndented", "blank", "heading"]);
    expect(blocks.lines[0].contentStart).toBe(4);
    expect(blocks.lines[0].invisible).toEqual([]);
  });

  test.each(["source", "copy"])("loads the parser lazily and synchronously in %s mode", (mode) => {
    const scratch = mkdtempSync(join(tmpdir(), "aidlc-parser-lazy-"));
    try {
      let tools = join(ROOT, "core/tools");
      if (mode === "copy") {
        const copied = join(scratch, "dist/claude/.claude/tools");
        cpSync(tools, copied, { recursive: true });
        tools = copied;
      }
      const code = `
        import { markdownBlocks } from ${JSON.stringify(join(tools, "aidlc-lib.ts"))};
        const loaded = () => Object.keys(require.cache).some((key) => key.endsWith("/vendor/markdown-parser.js"));
        console.log(loaded());
        console.log(markdownBlocks("# x").lines[0].kind);
        console.log(loaded());
      `;
      const result = Bun.spawnSync([process.execPath, "-e", code], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe("false\nheading\ntrue");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
