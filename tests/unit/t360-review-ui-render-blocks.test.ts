import { describe, expect, test } from "bun:test";
import { splitMarkdownBlocks } from "../../core/tools/aidlc-review-ui-render.ts";

describe("review UI Markdown blocks", () => {
  test("keeps fenced blank lines and resumes splitting after the closing fence", () => {
    const source = [
      "Before",
      "",
      "```ts",
      "const first = 1;",
      "",
      "const second = 2;",
      "```",
      "",
      "After",
    ].join("\n");

    expect(splitMarkdownBlocks(source)).toEqual([
      { line_start: 1, line_end: 1, text: "Before" },
      {
        line_start: 3,
        line_end: 7,
        text: "```ts\nconst first = 1;\n\nconst second = 2;\n```",
      },
      { line_start: 9, line_end: 9, text: "After" },
    ]);
  });

  test("keeps consecutive list, table, and blockquote lines in their blocks", () => {
    const source = [
      "- first",
      "  - nested",
      "- second",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| one | two |",
      "",
      "> quoted",
      "> still quoted",
    ].join("\n");

    expect(splitMarkdownBlocks(source)).toEqual([
      { line_start: 1, line_end: 3, text: "- first\n  - nested\n- second" },
      {
        line_start: 5,
        line_end: 7,
        text: "| Name | Value |\n| --- | --- |\n| one | two |",
      },
      { line_start: 9, line_end: 10, text: "> quoted\n> still quoted" },
    ]);
  });

  test("preserves heading blocks, ignores blank runs, and reports original lines", () => {
    const source = "\n\n# One\n\nParagraph\ncontinued\n\n\n## Two\n";

    expect(splitMarkdownBlocks(source)).toEqual([
      { line_start: 3, line_end: 3, text: "# One" },
      { line_start: 5, line_end: 6, text: "Paragraph\ncontinued" },
      { line_start: 9, line_end: 9, text: "## Two" },
    ]);
  });

  test("does not close a fence with the other marker or a shorter run", () => {
    const source = [
      "~~~~markdown",
      "inside",
      "```",
      "~~~",
      "",
      "~~~~",
      "",
      "outside",
    ].join("\n");

    expect(splitMarkdownBlocks(source)).toEqual([
      {
        line_start: 1,
        line_end: 6,
        text: "~~~~markdown\ninside\n```\n~~~\n\n~~~~",
      },
      { line_start: 8, line_end: 8, text: "outside" },
    ]);
  });
});
