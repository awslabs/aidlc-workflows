// covers: function:stripRuleComments, function:readRuleBundle

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuleBundle, stripRuleComments } from "../../dist/claude/.claude/tools/aidlc-steering.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const shipped = (name: string): string => readFileSync(join(REPO_ROOT, "core", "memory", name), "utf-8");

describe("stripRuleComments", () => {
  test("drops the shipped team template's comments and nothing else", () => {
    const text = shipped("team.md").replace(
      "## Testing Posture\n",
      "## Testing Posture\n\nWe use BDD; each Unit ships with feature files.\n",
    );
    const stripped = stripRuleComments(text);
    expect(stripped).not.toContain("<!--");
    expect(stripped).toContain("We use BDD; each Unit ships with feature files.");
    expect(stripped).toContain("## Testing Posture");
    expect(stripped).not.toContain("Affirmed during practices-discovery");
    expect(stripped).toContain("## Guard Policy");
  });

  test("removes a comment that spans lines without leaving a blank line", () => {
    const text = "## Sub\n<!-- one\ntwo\n-->\nKeep me.\n";
    expect(stripRuleComments(text)).toBe("## Sub\nKeep me.\n");
  });

  test("keeps a comment-looking line the team wrote inside a code fence", () => {
    const text = "## Sample\n\n```md\n<!-- this is code -->\n```\n\nRule: keep.\n";
    const stripped = stripRuleComments(text);
    expect(stripped).toContain("<!-- this is code -->");
    expect(stripped).toContain("Rule: keep.");
  });

  test("keeps text that shares a line with a comment", () => {
    expect(stripRuleComments("Rule <!-- aside --> stays.\n")).toBe("Rule  stays.\n");
  });
});

describe("readRuleBundle", () => {
  test("delivers a team file without its template comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "rule-comments-"));
    try {
      const file = join(dir, "team.md");
      writeFileSync(file, shipped("team.md").replace("## Way of Working\n", "## Way of Working\n\nTrunk-based.\n"));
      const { content, error } = readRuleBundle([{ rel: "aidlc/spaces/default/memory/team.md", abs: file }]);
      expect(error).toBeNull();
      expect(content).toHaveLength(1);
      expect(content[0].text).toContain("Trunk-based.");
      expect(content[0].text).not.toContain("<!--");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stock template with no rule is still left out", () => {
    const dir = mkdtempSync(join(tmpdir(), "rule-comments-"));
    try {
      const file = join(dir, "team.md");
      writeFileSync(file, shipped("team.md"));
      expect(readRuleBundle([{ rel: "memory/team.md", abs: file }]).content).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
