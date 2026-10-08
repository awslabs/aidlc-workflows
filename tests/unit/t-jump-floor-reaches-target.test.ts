// covers: function:stageJumpReaches, function:latestMainWorkflowStageRunFloor, audit:STAGE_JUMPED
//
// A jump starts a new attempt for its Target and every stage after it, the
// stages `jump execute` resets, and never for a stage before the Target. So a
// jump back to Code Generation keeps each Unit's Functional Design, which the
// person did not ask to redo, while a jump to an earlier stage still starts
// everything after it again. The scope-run journey is
// tests/integration/t-scope-run-moves-jump-back.test.ts.

import { describe, expect, test } from "bun:test";
import { latestMainWorkflowStageRunFloor, stageJumpReaches } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const block = (event: string, ts: string, fields = "") =>
  `\n## ${event}\n**Timestamp**: ${ts}\n**Event**: ${event}\n${fields}\n---\n`;
const audit = (...blocks: string[]) => `# AI-DLC Audit Log\n${blocks.join("")}`;
const STARTED_AT = "2026-10-07T00:00:00Z";
const started = block("WORKFLOW_STARTED", STARTED_AT);
const jump = (target: string, ts: string) =>
  block("STAGE_JUMPED", ts, `**Direction**: BACKWARD\n**Source**: build-and-test\n**Target**: ${target}\n`);

describe("a jump floors its target and the stages after it", () => {
  test("a jump to Code Generation floors Code Generation and Build and Test, not Functional Design", () => {
    const rows = audit(started, jump("code-generation", "2026-10-07T01:00:00Z"));
    for (const unitMajor of [true, false]) {
      for (const unit of [undefined, "core"]) {
        expect(latestMainWorkflowStageRunFloor(rows, "functional-design", unitMajor, unit))
          .toBe(`WORKFLOW_STARTED:${STARTED_AT}#1`);
        expect(latestMainWorkflowStageRunFloor(rows, "code-generation", unitMajor, unit))
          .toBe("STAGE_JUMPED:2026-10-07T01:00:00Z#1");
      }
    }
    expect(latestMainWorkflowStageRunFloor(rows, "build-and-test")).toBe("STAGE_JUMPED:2026-10-07T01:00:00Z#1");
  });

  test("a jump to Requirements Analysis floors every stage after it", () => {
    const rows = audit(started, jump("requirements-analysis", "2026-10-07T01:00:00Z"));
    for (const slug of ["requirements-analysis", "functional-design", "code-generation", "build-and-test"]) {
      expect(latestMainWorkflowStageRunFloor(rows, slug, true)).toBe("STAGE_JUMPED:2026-10-07T01:00:00Z#1");
    }
  });

  test("a jump keeps its place among every jump, so its token is the same for each stage it reaches", () => {
    const rows = audit(
      started,
      jump("code-generation", "2026-10-07T01:00:00Z"),
      jump("requirements-analysis", "2026-10-07T02:00:00Z"),
    );
    expect(latestMainWorkflowStageRunFloor(rows, "functional-design", true)).toBe("STAGE_JUMPED:2026-10-07T02:00:00Z#2");
    expect(latestMainWorkflowStageRunFloor(rows, "code-generation", true)).toBe("STAGE_JUMPED:2026-10-07T02:00:00Z#2");
  });

  test("a jump whose target, or a stage, the graph does not know reaches every stage", () => {
    expect(stageJumpReaches("**Event**: STAGE_JUMPED\n", "functional-design")).toBe(true);
    expect(stageJumpReaches("**Target**: no-such-stage\n", "functional-design")).toBe(true);
    expect(stageJumpReaches("**Target**: code-generation\n", "no-such-stage")).toBe(true);
    expect(stageJumpReaches("**Target**: code-generation\n", "functional-design")).toBe(false);
    expect(stageJumpReaches("**Target**: code-generation\n", "code-generation")).toBe(true);
  });
});
