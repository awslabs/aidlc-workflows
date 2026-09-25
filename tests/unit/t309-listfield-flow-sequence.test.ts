// covers: function:listField

import { describe, expect, test } from "bun:test";
import { listField } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

describe("listField YAML sequence styles", () => {
  test("parses unquoted flow-sequence items", () => {
    expect(listField("keywords: [design review, architecture, ddd]\n", "keywords"))
      .toEqual(["design review", "architecture", "ddd"]);
  });

  test("parses and strips quotes from flow-sequence items", () => {
    expect(listField(`keywords: ["design review", 'architecture']\n`, "keywords"))
      .toEqual(["design review", "architecture"]);
  });

  test("does not split commas inside quoted items", () => {
    expect(listField(`keywords: ["design, review", 'build, test']\n`, "keywords"))
      .toEqual(["design, review", "build, test"]);
  });

  test("accepts a YAML comment after the flow sequence", () => {
    expect(listField("keywords: [design, architecture] # routing hints\n", "keywords"))
      .toEqual(["design", "architecture"]);
  });

  test("distinguishes quoted brackets from the closing bracket", () => {
    expect(listField(`keywords: ["design] review", architecture] # ] hint\n`, "keywords"))
      .toEqual(["design] review", "architecture"]);
  });

  test("rejects an unterminated quoted item", () => {
    expect(listField(`keywords: ["design, review]\n`, "keywords")).toEqual([]);
  });

  test("parses an empty flow sequence as an empty list", () => {
    expect(listField("keywords: []\n", "keywords")).toEqual([]);
  });

  test("continues to parse block-sequence items", () => {
    expect(listField("keywords:\n  - design review\n  - architecture\n", "keywords"))
      .toEqual(["design review", "architecture"]);
  });

  test("rejects a block item without a space after the dash", () => {
    expect(listField("keywords:\n  -foo\n", "keywords")).toEqual([]);
  });

  test("returns an empty list when the key is absent", () => {
    expect(listField("description: no keywords here\n", "keywords")).toEqual([]);
  });

  test("prefers block style when the key appears in both styles", () => {
    const frontmatter = [
      "keywords:",
      "  - block-item",
      "keywords: [flow-item]",
      "",
    ].join("\n");
    expect(listField(frontmatter, "keywords")).toEqual(["block-item"]);
  });
});
