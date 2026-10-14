// covers: file:aidlc-common/protocols/stage-protocol-reviewer.md §12a,
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

const PROTOCOL = "aidlc-common/protocols/stage-protocol-reviewer.md";
const UNIT_PROTOCOL = "aidlc-common/protocols/stage-protocol-reviewer-unit.md";
const PERSONA = "agents/aidlc-architecture-reviewer-agent.md";
const KNOWLEDGE = "knowledge/aidlc-architecture-reviewer-agent/reviewing.md";
const SKILL = "skills/aidlc/SKILL.md";

describe("t217 reviewer read-scope bound is stated on every surface", () => {
  test("§12a step 1's per-Unit module names directive.consumes as a per-unit pass-list entry", () => {
    expect(readFileSync(join(AIDLC_SRC, PROTOCOL), "utf-8")).toContain("## 12a. Reviewer Invocation");
    const body = readFileSync(join(AIDLC_SRC, UNIT_PROTOCOL), "utf-8");
    expect(body).toMatch(/directive\.unit.*directive\.consumes/s);
    expect(body).toMatch(/must not read other units'? .*construction/i);
    // The bound is tool-agnostic: grep/glob/shell patterns spanning siblings count as reads.
    expect(body).toMatch(/grep, glob, or shell patterns/);
    expect(body.toLowerCase()).toContain("spot-check");
  });

  test("architecture-reviewer persona carries a Review Scope section and the reworded cross-reference line", () => {
    const body = readFileSync(join(AIDLC_SRC, PERSONA), "utf-8");
    expect(body).toContain("## Review Scope");
    expect(body).not.toMatch(/^- Cross-reference everything\. If it's referenced, it must exist\. If it exists, it should be referenced\.$/m);
    expect(body).toMatch(/Cross-reference everything within.*contracts you were passed/);
    expect(body.toLowerCase()).toContain("spot-check");
  });

  test("architecture-reviewer knowledge Stance carries the scope bullet and the checklist names the shared contracts", () => {
    const body = readFileSync(join(AIDLC_SRC, KNOWLEDGE), "utf-8");
    expect(body).toMatch(/Your scope is.*artifacts.*shared contracts/i);
    expect(body).toContain("components.md");
    expect(body).toContain("contract-summary.md");
    expect(body).toContain("unit-of-work.md");
    expect(body).not.toMatch(/^- Cross-unit contract boundaries respected\?$/m);
  });

  test("orchestrator SKILL.md points reviewer work at the conditional module", () => {
    for (const harness of HARNESS_MATRIX) {
      const path = join(harness.authoredRoot, SKILL);
      const body = readFileSync(path, "utf-8");
      const labelledBody = `harness ${harness.name}: ${path}\n${body}`;
      expect(labelledBody).toContain("stage-protocol-reviewer.md");
      expect(labelledBody).toContain("directive.protocol_modules");
    }
  });

  // A workflow-level reviewer stage such as contract-design (no directive.unit)
  // must ALSO receive directive.consumes, so its reviewer gets the unit DAG /
  // components / requirements evidence - not only per-unit stages. The protocol
  // and every harness skill must say so.
  test("workflow-level reviewer stages also receive directive.consumes (protocol + every harness)", () => {
    const protocol = readFileSync(join(AIDLC_SRC, PROTOCOL), "utf-8");
    expect(protocol.toLowerCase()).toContain("workflow-level");
    expect(protocol).toMatch(/workflow-level[\s\S]*contract-design/i);
    for (const harness of HARNESS_MATRIX) {
      const body = readFileSync(join(harness.authoredRoot, SKILL), "utf-8");
      const labelled = `harness ${harness.name}`;
      expect(body, labelled).toContain("stage-protocol-reviewer.md");
    }
  });
});
