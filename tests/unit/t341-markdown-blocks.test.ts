// covers: file:core/tools/aidlc-lib.ts
// covers: function:markdownBlocks, function:normalizeMarkdownLabel, function:summaryConfirmationContentHash,
// function:summaryConfirmationAnswer
import { describe, expect, test } from "bun:test";
import {
  markdownBlocks,
  normalizeMarkdownLabel,
  summaryConfirmationAnswer,
  summaryConfirmationContentHash,
  visibleMarkdownLines,
} from "../../core/tools/aidlc-lib.ts";

const kinds = (text: string) => markdownBlocks(text).lines.map((line) => line.kind);
const item = { kind: "listItem" as const, ordered: false, start: null, id: expect.any(Number) as number };

describe("t341 Markdown block adapter", () => {
  test("an ordered item starting at two cannot interrupt a paragraph", () => {
    const blocks = markdownBlocks("- prose\n  2. [Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "paragraph"]);
    expect(blocks.lines[0].containers).toEqual([item]);
    expect(blocks.lines[1].containers).toBe(blocks.lines[0].containers);
    expect(blocks.lines.map((line) => line.contentStart)).toEqual([2, 2]);
    expect(blocks.definitions).toEqual([]);
    expect(blocks.labels).toEqual([]);
  });

  test("an ordered item starting at one can contain a definition", () => {
    const blocks = markdownBlocks("- prose\n  1. [Q1]: /url\n\n[Q1]");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "definition", "blank", "paragraph"]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 1, endLine: 1 }]);
    expect(blocks.labels).toEqual(["Q1"]);
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
    expect(blocks.labels).toEqual([]);
  });

  test("quote exit terminates an HTML block", () => {
    const blocks = markdownBlocks("> <div>\n[Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["htmlFlow", "definition"]);
    expect(blocks.lines[0].containers).toEqual([{ kind: "blockQuote" }]);
    expect(blocks.lines[0].contentStart).toBe(2);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 1, endLine: 1 }]);
  });

  test("nested item exit terminates HTML without exiting its parent item", () => {
    const blocks = markdownBlocks("- - item\n    <?php\n  [Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "htmlFlow", "definition"]);
    const [outer, inner] = blocks.lines[0].containers;
    expect(blocks.lines[0].containers).toEqual([item, item]);
    expect(outer).not.toBe(inner);
    expect(blocks.lines[1].containers).toEqual([outer, inner]);
    expect(blocks.lines[1].containers[0]).toBe(outer);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 2, endLine: 2 }]);
  });

  test("spaced thematic breaks are not nested list items", () => {
    const blocks = markdownBlocks("- - -\n[Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["thematicBreak", "definition"]);
    expect(blocks.lines[0].containers).toEqual([]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 1, endLine: 1 }]);
  });

  test("content after a marker-only line belongs to that item", () => {
    const blocks = markdownBlocks("-\n  foo");
    expect(blocks.lines[1].kind).toBe("paragraph");
    expect(blocks.lines[1].containers).toEqual([item]);
    expect(blocks.lines[1].contentStart).toBe(2);
    // A bare marker carries no text; it is never paragraph content.
    expect(blocks.lines[0].kind).not.toBe("paragraph");
  });

  test("setext underline belongs to the heading rather than an empty item", () => {
    expect(kinds("Some prose\n-")).toEqual(["heading", "heading"]);
  });

  test("multiline code spans retain raw-line positions and do not swallow definitions", () => {
    const blocks = markdownBlocks("a `code\nspan` b\n\n[Q1]: /url");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "paragraph", "blank", "definition"]);
    expect(blocks.lines.map((line) => line.invisible)).toEqual([
      [{ start: 2, end: 7, kind: "codeText", tokenStartLine: 0, tokenEndLine: 1 }],
      [{ start: 0, end: 5, kind: "codeText", tokenStartLine: 0, tokenEndLine: 1 }],
      [], [],
    ]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 3, endLine: 3 }]);
  });

  test("GFM table delimiters and rows form one table", () => {
    const blocks = markdownBlocks("| a |\n|---|\n| b |");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["table", "table", "table"]);
    expect(new Set(blocks.lines.map((line) => line.block)).size).toBe(1);
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

  test("inline comments span their exact columns and leave the surrounding text", () => {
    const text = "a <!-- hidden\nx --> <b>shown</b>";
    const blocks = markdownBlocks(text);
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "paragraph"]);
    expect(blocks.lines.map((line) => line.invisible)).toEqual([
      [{ start: 2, end: 13, kind: "htmlComment", tokenStartLine: 0, tokenEndLine: 1 }],
      [{ start: 0, end: 5, kind: "htmlComment", tokenStartLine: 0, tokenEndLine: 1 }],
    ]);
    expect(visibleMarkdownLines(text, { preserveCommentBoundaries: true })).toEqual([
      "a \u0000", "\u0001\u0000 <b>shown</b>",
    ]);
  });

  test("multiline invisible spans exclude quote markers on continuation lines", () => {
    const blocks = markdownBlocks("> a `x\n> y` z");
    expect(blocks.lines.map((line) => line.contentStart)).toEqual([2, 2]);
    expect(blocks.lines.map((line) => line.invisible)).toEqual([
      [{ start: 4, end: 6, kind: "codeText", tokenStartLine: 0, tokenEndLine: 1 }], [{ start: 2, end: 4, kind: "codeText", tokenStartLine: 0, tokenEndLine: 1 }],
    ]);
  });

  test("a multiline HTML tag spans both of its lines", () => {
    const blocks = markdownBlocks('a <span title="one\ntwo">b</span>\n<i>x</i>');
    expect(blocks.lines[0].invisible).toEqual([
      { start: 2, end: 18, kind: "htmlText", tokenStartLine: 0, tokenEndLine: 1 },
    ]);
    expect(blocks.lines[1].invisible[0]).toEqual({
      start: 0, end: 5, kind: "htmlText", tokenStartLine: 0, tokenEndLine: 1,
    });
    expect(blocks.lines[2].invisible[0]).toEqual({
      start: 0, end: 3, kind: "htmlText", tokenStartLine: 2, tokenEndLine: 2,
    });
  });

  test("tabs count as raw columns and sibling items receive distinct identities", () => {
    const blocks = markdownBlocks("-\t`a`\n- b\n\n  c");
    expect(blocks.lines[0].contentStart).toBe(2);
    expect(blocks.lines[0].invisible).toEqual([{ start: 2, end: 5, kind: "codeText", tokenStartLine: 0, tokenEndLine: 0 }]);
    expect(blocks.lines[1].containers).toEqual([item]);
    expect(blocks.lines[1].containers[0]).not.toBe(blocks.lines[0].containers[0]);
    expect(blocks.lines[3].containers[0]).toBe(blocks.lines[1].containers[0]);
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
    expect(blocks.labels).toEqual(["MIXED CASE"]);
    expect(kinds("")).toEqual(["blank"]);
    expect(kinds("\n")).toEqual(["blank", "blank"]);
  });

  test("classifies indented code without interpreting its inline-looking content", () => {
    const blocks = markdownBlocks("    `code`\n\n# heading");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["codeIndented", "blank", "heading"]);
    expect(blocks.lines[0].invisible).toEqual([]);
  });

  test("a definition referenced elsewhere stays a definition, not part of the referencing paragraph", () => {
    const blocks = markdownBlocks("Claim. [Q1]\n\n[Q1]: /url 'title'\n");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "blank", "definition", "blank"]);
    expect(blocks.labels).toEqual(["Q1"]);
  });

  test("an empty task item cannot swallow the heading after it", () => {
    // Bun.markdown's task-list extension would render `## Q3` inside the item.
    for (const marker of ["- [x]", "- [ ]", "1. [X]", "> - [x]"]) {
      const blocks = markdownBlocks(`${marker}\n\n## Q3. Fabricated question\n`);
      expect(blocks.lines[2].kind).toBe("heading");
      expect(blocks.lines[2].containers).toEqual([]);
    }
  });

  test("a line whose probe would change the rendering is still classified by the others", () => {
    // `<!-->` is a complete comment; a probe after `<!--` would reopen it.
    const blocks = markdownBlocks("<!-->\n\n## Heading\n\nText [Q1]\n");
    expect(blocks.lines[2].kind).toBe("heading");
    expect(blocks.lines[4].kind).toBe("paragraph");
  });

  test("labels normalize like CommonMark: collapsed whitespace and a Unicode case fold", () => {
    expect(normalizeMarkdownLabel(" Mixed \n\t Case ")).toBe("MIXED CASE");
    expect(normalizeMarkdownLabel("stra\u00dfe")).toBe(normalizeMarkdownLabel("STRASSE"));
    expect(markdownBlocks("[strasse]\n\n[STRA\u00dfE]: /url\n").labels).toEqual(["STRASSE"]);
  });

  test("labels resolve one at a time, so inline syntax cannot span two of them", () => {
    // Two labels carrying one backtick each would form a code span if they
    // shared a paragraph; then neither definition would be found and the
    // lines between the references could be read as one paragraph.
    for (const [first, second] of [["a`b", "c`d"], ["<!-- a", "b -->"]]) {
      const questions = (payload: string) => [
        "## Q1", "[Answer]: blue", "",
        "## Consolidated Summary Confirmation", "Summary.", "[Answer]: A", "",
        "## Assumption Confirmation", `We assume [${first}].`, "", `Also [${second}].`, "[Answer]: A. Accept assumptions", "",
        "## Q9", payload, "[Answer]: yes", "",
        `[${first}]: /x`, "", `[${second}]: /y`, "",
      ].join("\n");
      const blocks = markdownBlocks(questions("one"));
      // `[Answer]: blue` is itself a definition.
      expect(blocks.labels).toEqual(["ANSWER", normalizeMarkdownLabel(first), normalizeMarkdownLabel(second)].sort());
      expect(blocks.lines[13].kind).toBe("heading");
      expect(summaryConfirmationContentHash(questions("one"))).not.toBe(summaryConfirmationContentHash(questions("two")));
    }
  });

  test("a heading inside a tight list item keeps its kind", () => {
    const blocks = markdownBlocks("- item\n  ## Q9\n  more\n");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "heading", "paragraph", "blank"]);
    expect(blocks.lines[1].containers).toEqual([item]);
  });

  test("a list item that opens with a bare fence is fenced code", () => {
    expect(kinds("- ```\n  code\n  ```\n")).toEqual(["codeFenced", "codeFenced", "codeFenced", "blank"]);
  });

  test("adjacent definitions stay separate", () => {
    const blocks = markdownBlocks("[a]: /ok\n[b]: /other 'title'\n\n[a] [b]\n");
    expect(blocks.definitions).toEqual([
      { label: "A", startLine: 0, endLine: 0 },
      { label: "B", startLine: 1, endLine: 1 },
    ]);
  });

  test("probes that would change the rendering cost a bounded number of renders", () => {
    // `[foo]:` with its destination on the next line can only be probed inside
    // the label, which breaks the reference; the rest must still classify
    // without one render per probe.
    const body = Array.from({ length: 6000 }, (_, index) => index % 7 === 0 ? "" : `Line ${index} with [Q${index % 9}] and \`code\`.`);
    const text = [...body.slice(0, 3000), "", "See [foo] and [bar].", "", "[foo]:", "/url", "", "[bar]:", "/other", "", ...body.slice(3000)].join("\n");
    const started = performance.now();
    const blocks = markdownBlocks(text);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(blocks.lines.slice(3003, 3009).map((line) => line.kind)).toEqual(["definition", "definition", "blank", "definition", "definition", "blank"]);
    expect(blocks.labels).toEqual(["BAR", "FOO"]);
  });

  // Bun.markdown would keep these lines as table rows; GFM ends the table.
  test.each([
    ["## Q9", "heading"],
    ["```", "codeFenced"],
    ["<div>", "htmlFlow"],
    ["<!-- note -->", "htmlFlow"],
    ["<?php", "htmlFlow"],
    ["<custom-tag>", "htmlFlow"],
  ] as const)("a table ends where %s starts another block", (line, kind) => {
    const blocks = markdownBlocks(`| a | b |\n| - | - |\n| c | d |\n${line}\n`);
    expect(blocks.lines).toHaveLength(5);
    expect(blocks.lines.slice(0, 3).map((entry) => entry.kind)).toEqual(["table", "table", "table"]);
    expect(blocks.lines[3].kind).toBe(kind);
  });

  test("a table inside a container ends at a heading without leaving the container", () => {
    const quoted = markdownBlocks("> | a | b |\n> | - | - |\n> ## Q9\n> after\n");
    expect(quoted.lines.map((line) => line.kind)).toEqual(["table", "table", "heading", "paragraph", "blank"]);
    expect(quoted.lines[2].containers).toEqual([{ kind: "blockQuote" }]);
    const listed = markdownBlocks("- | a | b |\n  | - | - |\n  ```\n  [Answer]: A\n  ```\n");
    expect(listed.lines.map((line) => line.kind)).toEqual(["table", "table", "codeFenced", "codeFenced", "codeFenced", "blank"]);
  });

  test("a heading or fence after a table keeps its source positions for consumers", () => {
    const questions = (payload: string) => [
      "## Consolidated Summary Confirmation", "Summary.", "[Answer]: Looks correct", "",
      "## Assumption Confirmation", "| a | b |", "| - | - |", "## Q9", payload, "[Answer]: yes", "",
    ].join("\n");
    expect(summaryConfirmationContentHash(questions("one"))).not.toBe(summaryConfirmationContentHash(questions("two")));
    const fenced = "## Consolidated Summary Confirmation\n| a | b |\n| - | - |\n```\n[Answer]: Looks correct\n```\n";
    expect(summaryConfirmationAnswer(fenced)).toBeNull();
    const blocks = markdownBlocks("| a |\n| - |\n## Q9 `x\ny`\n\n[Q1]: /u\n");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["table", "table", "heading", "paragraph", "blank", "definition", "blank"]);
    expect(blocks.definitions).toEqual([{ label: "Q1", startLine: 5, endLine: 5 }]);
  });

  // Bun.markdown would close these fences at a line outside their container;
  // CommonMark ends the container there and opens a new fence.
  test.each([
    ["> ~~~\n~~~\n## H\n"],
    ["> > ```\n> ```\n> ## H\n"],
    ["- ```\n```\n## H\n"],
    ["1. ~~~\n~~~\n## H\n"],
    ["- a\n  ```\n```\n## H\n"],
    ["> ~~~\n~~~\n    indented\n> ## H\n"],
  ] as const)("a fence outside its container opens a new fence: %j", (text) => {
    const blocks = markdownBlocks(text);
    expect(blocks.lines.map((line) => line.kind)).not.toContain("heading");
    expect(blocks.lines.at(-2)?.kind).toBe("codeFenced");
  });

  test("an answer after a fence that leaves its container is code, not an answer", () => {
    expect(summaryConfirmationAnswer("## Consolidated Summary Confirmation\n> ```\n```\n[Answer]: Looks correct\n")).toBeNull();
    expect(summaryConfirmationAnswer("## Consolidated Summary Confirmation\n> ```\n> ```\n[Answer]: Looks correct\n"))
      .toBe("Looks correct");
  });

  test("indented code keeps its kind next to a fence-shaped line, and fenced content keeps its indentation", () => {
    expect(kinds("```\n    x\n```\n## H\n")).toEqual(["codeFenced", "codeFenced", "codeFenced", "heading", "blank"]);
    expect(kinds(">     x\n\n## H\n")).toEqual(["codeIndented", "blank", "heading", "blank"]);
  });

  test("a setext heading whose text has no letter or digit is still a heading", () => {
    expect(kinds("-->\n---\n")).toEqual(["heading", "heading", "blank"]);
    expect(kinds("?>\n- \n")).toEqual(["heading", "heading", "blank"]);
  });

  test("control characters in the source cannot forge rendered structure", () => {
    const blocks = markdownBlocks("\u0001H\u00022\u0003## fake\u0004\n\n## Real\n");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["paragraph", "blank", "heading", "blank"]);
  });

  // Bun.markdown would open an HTML block here; CommonMark allows at most
  // three columns before one, so the line continues the paragraph.
  test.each([
    ["plain note\n    </details>\n## Q3\n", 0],
    ["plain note\n    <div>\n## Q3\n", 0],
    ["plain note\n    <!--\n## Q3\n-->\n", 0],
    ["plain note\n\t<pre>\n## Q3\n", 0],
    ["> quoted note\n    </details>\n## Q3\n", 0],
    ["> quoted note\n>     <div>\n> ## Q3\n", 1],
    ["- item\n      <div>\n  ## Q3\n", 1],
  ] as const)("a tag indented four columns under a paragraph continues it: %j", (text, containers) => {
    const blocks = markdownBlocks(text);
    expect(blocks.lines.slice(0, 3).map((line) => line.kind)).toEqual(["paragraph", "paragraph", "heading"]);
    expect(blocks.lines[2].containers).toHaveLength(containers);
    expect(text.split("\n")[1][blocks.lines[1].contentStart]).toBe("<");
  });

  test("an indented tag after a blank line is still indented code", () => {
    expect(kinds("plain note\n\n    <div>\n## Q3\n")).toEqual(["paragraph", "blank", "codeIndented", "heading", "blank"]);
  });

  test("an indented tag under a paragraph cannot hide a question from the digest", () => {
    const questions = (answer: string) => [
      "## Consolidated Summary Confirmation", "Summary.", "[Answer]: Looks correct", "",
      "## Assumption Confirmation", "", "[Answer]: A. Accept assumptions", "",
      "> quoted note", "    </details>", "## Q3. Fabricated question", "", `[Answer]: ${answer}`, "",
    ].join("\n");
    expect(summaryConfirmationContentHash(questions("A"))).not.toBe(summaryConfirmationContentHash(questions("B")));
  });

  test("a less indented fence line leaves the list item even when the fence opens on a continuation line", () => {
    for (const text of [
      "## Consolidated Summary Confirmation\n\n- foo\n\n  ```\n  code\n ```\n[Answer]: Looks correct\n",
      "## Consolidated Summary Confirmation\n\n1. foo\n\n   ```\n   code\n  ```\n[Answer]: Looks correct\n",
    ]) {
      expect(summaryConfirmationAnswer(text)).toBeNull();
    }
    // Still inside the item: the closer is indented to the item's content.
    expect(summaryConfirmationAnswer("## Consolidated Summary Confirmation\n\n- foo\n\n    ```\n    code\n  ```\n[Answer]: Looks correct\n"))
      .toBe("Looks correct");
  });

  test("an entity cannot spell the probe or label marker", () => {
    expect(kinds("Text aidlcprob&#101;99999z here\n\n## Q1\n")).toEqual(["paragraph", "blank", "heading", "blank"]);
    expect(kinds("Text aidlcprob&#x65;0z here\n\n## Q1\n\nMore prose.\n")).toEqual(["paragraph", "blank", "heading", "blank", "paragraph", "blank"]);
    expect(markdownBlocks("[Q2]aidlclab&#101;l0z\n\n[Q1]\n\n[Q2]: /u\n").labels).toEqual(["Q2"]);
  });

  test("lines without a letter or digit outside markup are still placed", () => {
    for (const line of ["!!!", "\u{1F680}\u{1F680}", "&#85;&#110;", "&amp; &amp;", "- &#85;&#110;", "> ?!", "-->"]) {
      expect(kinds(`${line}\n`)[0]).toBe("paragraph");
    }
    expect(kinds("claim [Q1]\n&#85;&#110;\n")).toEqual(["paragraph", "paragraph", "blank"]);
  });

  test("a table owns its header and delimiter rows even when the header has no letter or digit", () => {
    const blocks = markdownBlocks("| - | - |\n|---|---|\n| row | x |\n| two | y |\n\nafter\n");
    expect(blocks.lines.map((line) => line.kind)).toEqual(["table", "table", "table", "table", "blank", "paragraph", "blank"]);
    expect(new Set(blocks.lines.slice(0, 4).map((line) => line.block)).size).toBe(1);
  });

  test("every code span gets exact columns, however its backtick runs nest", () => {
    const blocks = markdownBlocks("Claim `x````` [Q1] y``z` and `` ` `` end\n");
    expect(blocks.lines[0].invisible).toEqual([
      { start: 6, end: 24, kind: "codeText", tokenStartLine: 0, tokenEndLine: 0 },
      { start: 29, end: 36, kind: "codeText", tokenStartLine: 0, tokenEndLine: 0 },
    ]);
  });

  test("tables broken by headings repair in one pass", () => {
    const text = Array.from({ length: 1000 }, (_, index) => `| a | b |\n| - | - |\n## Q${index}\n`).join("");
    const started = performance.now();
    const blocks = markdownBlocks(text);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(blocks.lines.filter((line) => line.kind === "heading")).toHaveLength(1000);
  });

  test("probes that each change the rendering stay within a render budget", () => {
    const text = `${Array.from({ length: 3000 }, () => "[Q1].").join("\n")}\n\n[Q1]: /u\n`;
    const started = performance.now();
    markdownBlocks(text);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("a heading tag inside a comment in an HTML block is not a heading", () => {
    const summary = "## Consolidated Summary Confirmation\n\nSummary.\n\n[Answer]: Looks correct\n\n";
    for (const html of ["<div>\n<!-- <h2>x</h2> -->\n</div>\n", "<div>\n<!--\n<h2>x</h2>\n-->\n</div>\n", "<div><!----><!-->\n</div>\n"]) {
      expect(() => summaryConfirmationContentHash(summary + html)).not.toThrow();
    }
    expect(() => summaryConfirmationContentHash(`${summary}<div>\n<!-- x -->\n<h2>y</h2>\n</div>\n`)).toThrow("unsupported HTML H2");
  });

  test("a line spelled as a question heading ends the assumption exclusion wherever it sits", () => {
    const questions = (answer: string) => [
      "## Consolidated Summary Confirmation", "Summary.", "[Answer]: Looks correct", "",
      "## Assumption Confirmation", "", "[Answer]: A. Accept assumptions", "",
      "```", "## Q3. Inside code", "```", `[Answer]: ${answer}`, "",
    ].join("\n");
    expect(summaryConfirmationContentHash(questions("A"))).not.toBe(summaryConfirmationContentHash(questions("B")));
  });
});
