// covers: file:tests/harness/post-artifact-wait.ts
//
// t183's live drive of Reverse Engineering stops at the stage's first question
// after its artifacts, and nothing may be approved by then. That question was
// the learnings question; since the learnings step asks only when the person
// corrected the agent, it is the gate itself, in a box or in prose. Both are
// the wait, the test person leaves every box but the resume menu open, and the
// check still fails when RE is approved with nobody asked, in either shape.
//
// Mechanism: function - the audit event types and menus recorded live
// (Windows claude-sdk in Full Suite run 40419252454, attempts 1 and 2; the
// learnings shape from the Linux leg of run 40133598713).

import { describe, expect, test } from "bun:test";
import { leavesOpen, postArtifactWaitProblems } from "../harness/post-artifact-wait.ts";
import type { CapturedAskUserQuestion } from "../harness/sdk-drive.ts";

const HELD = "- **Current Stage**: reverse-engineering\n";
const MOVED_ON = "- **Current Stage**: requirements-analysis\n";

// The seeded start, the developer's scan and the four artifact sensors.
const RE_WORK = [
  "SESSION_STARTED", "ARTIFACT_CREATED", "SUBAGENT_COMPLETED", "WORKFLOW_STARTED", "STAGE_STARTED",
  "SESSION_STARTED", "HUMAN_TURN", "SUBAGENT_DISPATCHED", ...Array<string>(10).fill("ARTIFACT_CREATED"),
  "SUBAGENT_COMPLETED", "PIPELINE_LINK_COMPLETED",
  ...Array.from({ length: 4 }, () => ["SENSOR_FIRED", "SENSOR_PASSED"]).flat(),
];

function menu(...questions: Array<[string, string[]]>): CapturedAskUserQuestion {
  return {
    questions: questions.map(([question, labels]) => ({ question, options: labels.map((label) => ({ label })) })),
    answers: {},
  };
}

const RESUME = menu(["Pick up where you left off?", ["Resume (Recommended)", "Redo this stage", "Jump to a stage", "Start fresh"]]);
const LEARNINGS = menu(
  ["Which notes from this step should I keep as practices for future work?", ["Keep none of these", "Developer runs pipeline alone when collaborators off"]],
  ["Anything to add for next time?", ["Nothing to add", "Add a note"]],
);
const GATE = menu(["Reverse Engineering complete. How would you like to proceed?", ["Approve", "Request Changes"]]);

describe("the test person answers only the resume menu", () => {
  test("the resume menu is answered", () => {
    expect(leavesOpen(RESUME)).toBe(false);
  });

  test("the learnings box and the gate box are left open, so no pick can approve RE", () => {
    expect(leavesOpen(LEARNINGS)).toBe(true);
    expect(leavesOpen(GATE)).toBe(true);
  });
});

describe("RE stops at its post-artifact wait with nothing approved", () => {
  test("a learnings box left open", () => {
    const events = [...RE_WORK, "DECISION_RECORDED"];
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: true, stateFile: HELD })).toEqual([]);
  });

  test("a learnings question logged, and the turn ends", () => {
    const events = [...RE_WORK, "DECISION_RECORDED", "SESSION_ENDED"];
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: false, resultSubtype: "success", stateFile: HELD }))
      .toEqual([]);
  });

  test("the gate box left open", () => {
    const events = [...RE_WORK, "STAGE_AWAITING_APPROVAL"];
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: true, stateFile: HELD })).toEqual([]);
  });

  test("the gate asked in prose, and the turn ends (attempt 2)", () => {
    const events = [...RE_WORK, "STAGE_AWAITING_APPROVAL", "SESSION_ENDED"];
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: false, resultSubtype: "success", stateFile: HELD }))
      .toEqual([]);
  });

  test("the gate opened after the learnings answer, and the turn ends", () => {
    const events = [...RE_WORK, "DECISION_RECORDED", "QUESTION_ANSWERED", "STAGE_AWAITING_APPROVAL", "SESSION_ENDED"];
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: false, resultSubtype: "success", stateFile: HELD }))
      .toEqual([]);
  });
});

describe("RE approved with nobody asked fails", () => {
  const approved = (problems: string[]): boolean =>
    problems.some((problem) => problem.startsWith("RE was approved with nobody asked"));

  test("the gate first: the gate box picked Approve (attempt 1)", () => {
    const events = [
      ...RE_WORK, "STAGE_AWAITING_APPROVAL", "HUMAN_TURN", "QUESTION_REPLIED", "GATE_APPROVED",
      "STAGE_COMPLETED", "STAGE_STARTED", "MEMORY_EMPTY",
    ];
    for (const stoppedAtOpenBox of [true, false]) {
      const problems = postArtifactWaitProblems({ events, stoppedAtOpenBox, resultSubtype: "success", stateFile: MOVED_ON });
      expect(approved(problems), JSON.stringify(problems)).toBe(true);
    }
  });

  test("a learnings question first, then the gate approved", () => {
    const events = [
      ...RE_WORK, "DECISION_RECORDED", "HUMAN_TURN", "QUESTION_REPLIED", "QUESTION_ANSWERED",
      "STAGE_AWAITING_APPROVAL", "HUMAN_TURN", "QUESTION_REPLIED", "GATE_APPROVED", "STAGE_COMPLETED", "STAGE_STARTED",
    ];
    for (const stoppedAtOpenBox of [true, false]) {
      const problems = postArtifactWaitProblems({ events, stoppedAtOpenBox, resultSubtype: "success", stateFile: MOVED_ON });
      expect(approved(problems), JSON.stringify(problems)).toBe(true);
    }
  });

  test("a gate reply the turn ends on is not a wait", () => {
    const events = [...RE_WORK, "STAGE_AWAITING_APPROVAL", "HUMAN_TURN", "QUESTION_REPLIED", "SESSION_ENDED"];
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: false, resultSubtype: "success", stateFile: HELD }))
      .toEqual([`RE never reached its post-artifact human wait: ${JSON.stringify(events.slice(-12))}`]);
  });

  test("the engine no longer holds RE", () => {
    const events = [...RE_WORK, "STAGE_AWAITING_APPROVAL"];
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: true, stateFile: MOVED_ON }))
      .toEqual(["the engine no longer holds Reverse Engineering: - **Current Stage**: requirements-analysis"]);
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: true }))
      .toEqual(["the engine no longer holds Reverse Engineering: the drive left no state file"]);
  });

  test("a state file with CRLF line ends reads the same", () => {
    const events = [...RE_WORK, "STAGE_AWAITING_APPROVAL"];
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: true, stateFile: HELD.replace("\n", "\r\n") }))
      .toEqual([]);
    expect(postArtifactWaitProblems({ events, stoppedAtOpenBox: true, stateFile: MOVED_ON.replace("\n", "\r\n") }))
      .toEqual(["the engine no longer holds Reverse Engineering: - **Current Stage**: requirements-analysis"]);
  });
});
