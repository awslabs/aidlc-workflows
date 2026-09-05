// t333-devin-profile: unit tests for the Devin persona frontmatter projection
// helper (core/tools/aidlc-devin-profile.ts).
//
// covers: file:core/tools/aidlc-devin-profile.ts
//
// WHAT. The helper strips frontmatter fields Devin's native agent loader ignores
// (display_name, examples, disallowedTools, maxTurns) from agent .md files during
// Devin packaging. These tests verify the helper's behavior directly:
//   - strips all four unsupported fields including their indented continuation lines
//   - preserves name, description (folded >), model, effort, and body
//   - idempotent (applying twice produces identical output)
//   - handles UTF-8 BOM
//   - rejects missing frontmatter with a useful error
//   - no-op when no unsupported fields are present
//   - handles fields at start, middle, and end of frontmatter
//
// WHY UNIT (not subprocess). The helper is a pure function with no I/O. Direct
// testing is faster and more precise than spawning a packaging run. The
// integration-level proof (dist/devin agents are actually stripped) is in t331
// tests 11–13.

import { describe, expect, test } from "bun:test";
import {
  isDevinUnsupportedField,
  stripDevinUnsupportedProfileFields,
} from "../../core/tools/aidlc-devin-profile.ts";

describe("t333 devin profile — stripDevinUnsupportedProfileFields", () => {
  test("1: strips display_name, examples (with list items), disallowedTools, maxTurns", () => {
    const input = `---
name: aidlc-test-agent
display_name: Test Agent
examples:
  - foo.md
  - bar.md
description: >
  A test agent.
disallowedTools: Task
maxTurns: 60
tier: judgment
---
# Body
Content here.`;
    const out = stripDevinUnsupportedProfileFields(input, "test.md");
    const fm = out.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).not.toMatch(/^display_name:/m);
    expect(fm).not.toMatch(/^examples:/m);
    expect(fm).not.toMatch(/^disallowedTools:/m);
    expect(fm).not.toMatch(/^maxTurns:/m);
    // List items from examples: must not survive as orphaned indented lines.
    expect(fm).not.toContain("foo.md");
    expect(fm).not.toContain("bar.md");
    // Preserved fields.
    expect(fm).toMatch(/^name: aidlc-test-agent/m);
    expect(fm).toMatch(/^description:/m);
    expect(fm).toMatch(/^tier: judgment/m);
    // Body preserved.
    expect(out).toContain("# Body");
    expect(out).toContain("Content here.");
  });

  test("2: idempotent — applying twice produces identical output", () => {
    const input = `---
name: aidlc-test-agent
display_name: Test Agent
examples:
  - foo.md
description: >
  A test agent.
disallowedTools: Task
tier: judgment
---
Body.`;
    const once = stripDevinUnsupportedProfileFields(input, "test.md");
    const twice = stripDevinUnsupportedProfileFields(once, "test.md");
    expect(twice).toBe(once);
  });

  test("3: no-op when no unsupported fields are present", () => {
    const input = `---
name: aidlc-test-agent
description: >
  A test agent.
tier: judgment
---
Body.`;
    const out = stripDevinUnsupportedProfileFields(input, "test.md");
    expect(out).toBe(input);
  });

  test("4: handles UTF-8 BOM", () => {
    const input = `\uFEFF---
name: aidlc-test-agent
display_name: Test Agent
description: A test agent.
tier: judgment
---
Body.`;
    const out = stripDevinUnsupportedProfileFields(input, "test.md");
    expect(out.charCodeAt(0)).toBe(0xfeff); // BOM preserved
    // Strip BOM before extracting frontmatter for assertion.
    const noBom = out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
    const fm = noBom.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).not.toMatch(/^display_name:/m);
    expect(fm).toMatch(/^name: aidlc-test-agent/m);
  });

  test("5: rejects missing frontmatter with a useful error", () => {
    const input = `# No frontmatter here\nJust body.`;
    expect(() => stripDevinUnsupportedProfileFields(input, "bad.md")).toThrow(
      /bad\.md.*no closed YAML frontmatter block/,
    );
  });

  test("6: rejects unclosed frontmatter (missing closing fence)", () => {
    const input = `---
name: aidlc-test-agent
display_name: Test Agent
description: A test agent.
`;
    expect(() => stripDevinUnsupportedProfileFields(input, "unclosed.md")).toThrow(
      /unclosed\.md.*no closed YAML frontmatter block/,
    );
  });

  test("7: handles field at start of frontmatter (display_name first)", () => {
    const input = `---
display_name: First Field
name: aidlc-test-agent
description: A test agent.
tier: judgment
---
Body.`;
    const out = stripDevinUnsupportedProfileFields(input, "test.md");
    const fm = out.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).not.toMatch(/^display_name:/m);
    expect(fm).toMatch(/^name: aidlc-test-agent/m);
    // The first line of the frontmatter should now be name:, not display_name:.
    expect(fm.split("\n")[0]).toMatch(/^name:/);
  });

  test("8: handles field at end of frontmatter (maxTurns last)", () => {
    const input = `---
name: aidlc-test-agent
description: A test agent.
tier: balanced
maxTurns: 60
---
Body.`;
    const out = stripDevinUnsupportedProfileFields(input, "test.md");
    const fm = out.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).not.toMatch(/^maxTurns:/m);
    expect(fm).toMatch(/^tier: balanced/m);
    // No trailing blank line before the closing fence.
    expect(fm.split("\n").pop()).toMatch(/^tier: balanced/);
  });

  test("9: preserves folded/multiline description block", () => {
    const input = `---
name: aidlc-test-agent
display_name: Test Agent
description: >
  Line one of the description.
  Line two of the description.
  Line three.
disallowedTools: Task
tier: judgment
---
Body.`;
    const out = stripDevinUnsupportedProfileFields(input, "test.md");
    const fm = out.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).toContain("Line one of the description.");
    expect(fm).toContain("Line two of the description.");
    expect(fm).toContain("Line three.");
    expect(fm).not.toMatch(/^display_name:/m);
    expect(fm).not.toMatch(/^disallowedTools:/m);
  });

  test("10: isDevinUnsupportedField exposes the field set", () => {
    expect(isDevinUnsupportedField("display_name")).toBe(true);
    expect(isDevinUnsupportedField("examples")).toBe(true);
    expect(isDevinUnsupportedField("disallowedTools")).toBe(true);
    expect(isDevinUnsupportedField("maxTurns")).toBe(true);
    expect(isDevinUnsupportedField("name")).toBe(false);
    expect(isDevinUnsupportedField("description")).toBe(false);
    expect(isDevinUnsupportedField("tier")).toBe(false);
    expect(isDevinUnsupportedField("model")).toBe(false);
  });

  test("11: preserves model and effort fields (tier projection output)", () => {
    // After tier projection, the frontmatter has model:/effort: instead of tier:.
    const input = `---
name: aidlc-test-agent
display_name: Test Agent
model: claude-opus-4-8
effort: high
description: A test agent.
disallowedTools: Task
---
Body.`;
    const out = stripDevinUnsupportedProfileFields(input, "test.md");
    const fm = out.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).toMatch(/^model: claude-opus-4-8/m);
    expect(fm).toMatch(/^effort: high/m);
    expect(fm).not.toMatch(/^display_name:/m);
    expect(fm).not.toMatch(/^disallowedTools:/m);
  });

  test("12: does not strip nested keys under a retained field", () => {
    // A hypothetical frontmatter with a nested structure under a retained key.
    // The strip only removes TOP-LEVEL unsupported keys, not nested ones.
    const input = `---
name: aidlc-test-agent
description: A test agent.
tools:
  - read
  - edit
tier: judgment
---
Body.`;
    const out = stripDevinUnsupportedProfileFields(input, "test.md");
    const fm = out.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).toMatch(/^tools:/m);
    expect(fm).toContain("- read");
    expect(fm).toContain("- edit");
  });
});
