// covers: file:aidlc-common/protocols/stage-protocol.md §12a,
// file:agents/aidlc-architecture-reviewer-agent.md,
// file:knowledge/aidlc-architecture-reviewer-agent/reviewing.md,
// file:skills/aidlc/SKILL.md reviewer bullet
//
// t217 - reviewer read-scope bound. On per-unit stages the architecture
// reviewer's cost was growing O(N) with unit count because §12a passed
// only the produces paths and the persona pushed a "cross-reference
// everything" sweep. This test pins the four surfaces that carry the
// bound - protocol, persona, knowledge, orchestrator - so a well-meaning
// prose sweep cannot silently drop it.
// The persona file is the load-bearing surface on Claude Code and Codex (Kiro additionally auto-loads the knowledge file via its agent JSON resources); keep the bound in the persona, not knowledge-only.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const PROTOCOL = "aidlc-common/protocols/stage-protocol.md";
const PERSONA = "agents/aidlc-architecture-reviewer-agent.md";
const KNOWLEDGE = "knowledge/aidlc-architecture-reviewer-agent/reviewing.md";
const SKILL = "skills/aidlc/SKILL.md";

describe("t217 reviewer read-scope bound is stated on every surface", () => {
  test("stage-protocol §12a step 1 names directive.consumes as a per-unit pass-list entry", () => {
    const body = readFileSync(join(AIDLC_SRC, PROTOCOL), "utf-8");
    // §12a section exists.
    expect(body).toContain("## 12a. Reviewer Invocation");
    // Per-unit pass-list carries the consumes paths.
    expect(body).toMatch(/directive\.unit.*directive\.consumes/s);
    // Explicit prohibition on reading sibling units.
    expect(body).toMatch(/must not read other units'? .*construction/i);
    // The bound is tool-agnostic: grep/glob/shell patterns spanning siblings count as reads.
    expect(body).toMatch(/grep, glob, or shell patterns/);
    // The spot-check carve-out is present.
    expect(body.toLowerCase()).toContain("spot-check");
  });

  test("architecture-reviewer persona carries a Review Scope section and the reworded cross-reference line", () => {
    const body = readFileSync(join(AIDLC_SRC, PERSONA), "utf-8");
    expect(body).toContain("## Review Scope");
    // The old unbounded line is gone.
    expect(body).not.toMatch(/^- Cross-reference everything\. If it's referenced, it must exist\. If it exists, it should be referenced\.$/m);
    // The reworded line is bounded to what was passed.
    expect(body).toMatch(/Cross-reference everything within.*contracts you were passed/);
    expect(body.toLowerCase()).toContain("spot-check");
  });

  test("architecture-reviewer knowledge Stance carries the scope bullet and the checklist names the shared contracts", () => {
    const body = readFileSync(join(AIDLC_SRC, KNOWLEDGE), "utf-8");
    // Stance section carries the scope statement.
    expect(body).toMatch(/Your scope is.*artifacts.*shared contracts/i);
    // Checklist item is rewritten to name the shared contracts, not a sibling-directory sweep.
    expect(body).toContain("components.md");
    expect(body).toContain("component-methods.md");
    expect(body).toContain("services.md");
    expect(body).toContain("unit-of-work.md");
    // Old bare checklist line is gone.
    expect(body).not.toMatch(/^- Cross-unit contract boundaries respected\?$/m);
  });

  test("orchestrator SKILL.md reviewer bullet names directive.consumes and the read-scope bound", () => {
    for (const harness of HARNESS_MATRIX) {
      const path = join(harness.authoredRoot, SKILL);
      const body = readFileSync(path, "utf-8");
      const labelledBody = `harness ${harness.name}: ${path}\n${body}`;
      // Reviewer step bullet exists and now carries both parts of the bound.
      expect(labelledBody).toMatch(/Reviewer step \(§12a\)/);
      expect(labelledBody).toMatch(/directive\.consumes/);
      expect(labelledBody).toMatch(/must not read other units'? .*construction/i);
      // The bound is tool-agnostic on every harness surface.
      expect(labelledBody).toMatch(/grep, glob, and shell patterns/);
    }
  });
});
