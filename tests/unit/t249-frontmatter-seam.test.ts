// covers: file:scripts/manifest-types.ts
//
// t249 — the frontmatter transformation seam (`frontmatterAdditions` /
// `frontmatterRemovals`). Mechanism: none (pure string in / string out; zero
// spawn, zero LLM).
//
// WHY THIS EXISTS. Both functions rewrite YAML that then ships in every
// projected agent file, and both are generic: any harness manifest can declare
// any key. A silent mis-transformation produces frontmatter that a harness
// parses differently than intended — or refuses — and the drift guard cannot
// catch it, because the drift guard only proves dist matches what the packager
// produced, not that what it produced is valid. So the contract these tests pin
// is FAIL CLOSED: on anything ambiguous, throw rather than emit questionable
// YAML.
//
// The two defects these guard against, both reproducible before the fix:
//   1. A blank line or a full-line comment inside the block being REMOVED used
//      to terminate the removal, leaving the rest of that key's indented values
//      behind as orphans — a mapping value with no key, i.e. invalid YAML.
//   2. An ADDITION block could declare the same top-level key twice; only
//      collisions against the core file were checked, not within the block.

import { describe, expect, test } from "bun:test";
import {
  applyFrontmatterAdditions,
  applyFrontmatterRemovals,
} from "../../scripts/manifest-types.ts";

/** The frontmatter block of a projected file, without the fences. */
function fmOf(content: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) throw new Error("no frontmatter block");
  return m[1];
}

/** Top-level keys, in order, as a YAML reader would see them. */
function topLevelKeys(fm: string): string[] {
  return fm
    .split("\n")
    .filter((line) => /^[A-Za-z_][\w.-]*\s*:/.test(line))
    .map((line) => line.split(":")[0].trim());
}

/** No indented line may appear before its owning top-level key. */
function hasOrphanContinuation(fm: string): boolean {
  let sawKey = false;
  for (const line of fm.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      if (!sawKey) return true;
      continue;
    }
    sawKey = /^[A-Za-z_][\w.-]*\s*:/.test(line);
    if (!sawKey) return true; // a non-indented line that is not a key
  }
  return false;
}

const FILE = "agents/aidlc-developer-agent.md";

describe("t249 frontmatterRemovals", () => {
  test("1: drops a scalar key and leaves every other line byte-identical", () => {
    const src = ['---', 'name: dev', 'disallowedTools: Task', 'tools: ["read"]', '---', 'body', ''].join("\n");
    const out = applyFrontmatterRemovals(src, ["disallowedTools"], FILE);
    expect(topLevelKeys(fmOf(out))).toEqual(["name", "tools"]);
    expect(out).toContain('tools: ["read"]');
    expect(out.endsWith("body\n")).toBe(true);
  });

  test("2: drops a multi-line sequence block with all of its entries", () => {
    const src = [
      "---",
      "name: dev",
      "disallowedTools:",
      "  - Task",
      "  - Other",
      'tools: ["read"]',
      "---",
      "body",
      "",
    ].join("\n");
    const out = applyFrontmatterRemovals(src, ["disallowedTools"], FILE);
    expect(topLevelKeys(fmOf(out))).toEqual(["name", "tools"]);
    expect(out).not.toContain("Task");
    expect(out).not.toContain("Other");
    expect(hasOrphanContinuation(fmOf(out))).toBe(false);
  });

  // === the defect: interleaved blanks / comments used to end the removal =====
  test("3: a blank line inside the removed block does NOT end the removal", () => {
    const src = [
      "---",
      "name: dev",
      "disallowedTools:",
      "  - Task",
      "",
      "  - Other",
      'tools: ["read"]',
      "---",
      "body",
      "",
    ].join("\n");
    const out = applyFrontmatterRemovals(src, ["disallowedTools"], FILE);
    // Before the fix this emitted an orphaned `  - Other` under `name:`.
    expect(out).not.toContain("Other");
    expect(hasOrphanContinuation(fmOf(out))).toBe(false);
    expect(topLevelKeys(fmOf(out))).toEqual(["name", "tools"]);
  });

  test("4: a full-line comment inside the removed block goes with it", () => {
    const src = [
      "---",
      "name: dev",
      "disallowedTools:",
      "  # the CLI-only denylist",
      "  - Task",
      'tools: ["read"]',
      "---",
      "body",
      "",
    ].join("\n");
    const out = applyFrontmatterRemovals(src, ["disallowedTools"], FILE);
    expect(out).not.toContain("CLI-only denylist");
    expect(out).not.toContain("Task");
    expect(hasOrphanContinuation(fmOf(out))).toBe(false);
  });

  test("5: a comment BETWEEN two kept keys survives, attached to nothing removed", () => {
    const src = [
      "---",
      "name: dev",
      "# a note about tools",
      'tools: ["read"]',
      "disallowedTools: Task",
      "---",
      "body",
      "",
    ].join("\n");
    const out = applyFrontmatterRemovals(src, ["disallowedTools"], FILE);
    expect(out).toContain("# a note about tools");
    expect(topLevelKeys(fmOf(out))).toEqual(["name", "tools"]);
  });

  // === fail-closed guards ===================================================
  test("6: a declared key that the file does not carry is a hard error", () => {
    const src = ["---", "name: dev", "---", "body", ""].join("\n");
    expect(() => applyFrontmatterRemovals(src, ["disallowedTools"], FILE)).toThrow(
      /does not declare key\(s\) \[disallowedTools\]/,
    );
  });

  test("7: a file with no frontmatter block is a hard error", () => {
    expect(() => applyFrontmatterRemovals("# just prose\n", ["x"], FILE)).toThrow(
      /no leading frontmatter block/,
    );
  });

  test("8: a non-indented line that is not a mapping key fails closed", () => {
    // A column-0 sequence entry is ambiguous — it could belong to the block being
    // removed or to the preceding kept key. Guessing risks emitting invalid YAML.
    const src = [
      "---",
      "disallowedTools:",
      "- Task",
      "name: dev",
      "---",
      "body",
      "",
    ].join("\n");
    expect(() => applyFrontmatterRemovals(src, ["disallowedTools"], FILE)).toThrow(
      /neither a top-level key nor an indented continuation/,
    );
  });
});

describe("t249 frontmatterAdditions", () => {
  test("9: appends a multi-line block just before the closing fence", () => {
    const src = ["---", "name: dev", "---", "body", ""].join("\n");
    const out = applyFrontmatterAdditions(
      src,
      ['tools: ["read", "write"]', "permissions:", "  rules:", "    - capability: shell"],
      FILE,
    );
    expect(topLevelKeys(fmOf(out))).toEqual(["name", "tools", "permissions"]);
    expect(hasOrphanContinuation(fmOf(out))).toBe(false);
    // The body is untouched and the fence order is preserved.
    expect(out.endsWith("body\n")).toBe(true);
    expect(fmOf(out).split("\n").at(-1)).toBe("    - capability: shell");
  });

  test("10: a key already present in the file is a hard error", () => {
    const src = ["---", "name: dev", 'tools: ["read"]', "---", "body", ""].join("\n");
    expect(() => applyFrontmatterAdditions(src, ['tools: ["write"]'], FILE)).toThrow(
      /already declares "tools:" in core/,
    );
  });

  // === the defect: a duplicate WITHIN the addition block used to pass ========
  test("11: the same key twice in one addition block is a hard error", () => {
    const src = ["---", "name: dev", "---", "body", ""].join("\n");
    expect(() =>
      applyFrontmatterAdditions(src, ['tools: ["read"]', "permissions:", "  rules: []", 'tools: ["write"]'], FILE),
    ).toThrow(/declares "tools:" twice in the same addition block/);
  });

  test("12: a line that is not a YAML key is a hard error", () => {
    const src = ["---", "name: dev", "---", "body", ""].join("\n");
    expect(() => applyFrontmatterAdditions(src, ["not a key at all"], FILE)).toThrow(
      /does not start with a YAML key/,
    );
  });

  test("13: a file with no frontmatter block is a hard error", () => {
    expect(() => applyFrontmatterAdditions("# just prose\n", ["tools: []"], FILE)).toThrow(
      /no leading frontmatter block/,
    );
  });
});

describe("t249 the two seams compose (the shipped kiro-ide order)", () => {
  test("14: removals then additions yields one valid block with no duplicates", () => {
    // The packager applies removals BEFORE additions, which is what lets the IDE
    // manifest drop the CLI-only `disallowedTools` and add its own `tools:` +
    // `permissions:` without a collision.
    const src = [
      "---",
      "name: aidlc-developer-agent",
      "description: Implements units of work",
      "disallowedTools:",
      "  - Task",
      "",
      "  - Other",
      "tier: judgment",
      "---",
      "# Developer",
      "",
    ].join("\n");
    const trimmed = applyFrontmatterRemovals(src, ["disallowedTools"], FILE);
    const out = applyFrontmatterAdditions(
      trimmed,
      ['tools: ["read", "write", "shell"]', "permissions:", "  rules:", "    - capability: shell"],
      FILE,
    );
    const keys = topLevelKeys(fmOf(out));
    expect(keys).toEqual(["name", "description", "tier", "tools", "permissions"]);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate top-level key
    expect(hasOrphanContinuation(fmOf(out))).toBe(false);
    expect(out).not.toContain("disallowedTools");
    expect(out).not.toContain("Other");
    expect(out).toContain("# Developer");
  });
});
