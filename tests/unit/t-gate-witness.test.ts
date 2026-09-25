// covers: file:tests/harness/gate-witness.ts
//
// The gate witness is how live journeys prove a person (the driver standing in
// for one) answered each gate. It must count only approval menus answered while
// that stage's gate was held, and match each main-workflow resolution to one.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { cleanupTestProject, createTestProject, seededStateFile } from "../harness/fixtures.ts";
import { gateWitness } from "../harness/gate-witness.ts";
import type { CapturedAskUserQuestion } from "../harness/sdk-drive.ts";

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

function project(): string {
  const proj = createTestProject();
  projects.push(proj);
  return proj;
}

function state(proj: string, stage: string, mark: "?" | "-"): void {
  writeFileSync(
    seededStateFile(proj),
    `- **Workflow**: poc\n- **Scope**: poc\n- **Status**: Running\n- **Current Stage**: ${stage}\n\n- [${mark}] ${stage}\n`,
    "utf-8",
  );
}

function approvalMenu(answer: string, header = "Approval"): CapturedAskUserQuestion {
  const question = "Requirements Analysis complete. How would you like to proceed?";
  return {
    questions: [{
      header,
      question,
      options: [
        { label: "Approve", description: "Continue to Code Generation" },
        { label: "Request Changes", description: "Provide revision feedback" },
      ],
    }],
    answers: { [question]: answer },
  };
}

describe("t-gate-witness", () => {
  test("an approval answered at the held gate accounts for its resolution", () => {
    const proj = project();
    const witness = gateWitness(proj);
    state(proj, "requirements-analysis", "?");
    witness.onAskUserQuestion(approvalMenu("Approve"));
    appendAuditEntry("GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" }, proj);

    expect(witness.answered()).toEqual([{ stage: "requirements-analysis", answer: "Approve" }]);
    expect(witness.unanswered()).toEqual([]);
  });

  test("a resolution with no answered gate menu is reported", () => {
    const proj = project();
    const witness = gateWitness(proj);
    state(proj, "requirements-analysis", "?");
    appendAuditEntry("GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" }, proj);

    const missing = witness.unanswered();
    expect(missing).toHaveLength(1);
    expect(missing[0]).toStartWith("GATE_APPROVED requirements-analysis (User Input: Approve)");
  });

  test("menus that are not the held gate's approval question do not count", () => {
    const proj = project();
    const witness = gateWitness(proj);
    // Asked before the gate opened: the stage is still in progress.
    state(proj, "requirements-analysis", "-");
    witness.onAskUserQuestion(approvalMenu("Approve"));
    // Held gate, but not the approval menu shape.
    state(proj, "requirements-analysis", "?");
    witness.onAskUserQuestion(approvalMenu("Approve", "Learnings"));
    appendAuditEntry("GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" }, proj);

    expect(witness.answered()).toEqual([]);
    expect(witness.unanswered()).toHaveLength(1);
  });

  test("one answer accounts for one resolution, and the choice must match", () => {
    const proj = project();
    const witness = gateWitness(proj);
    state(proj, "requirements-analysis", "?");
    witness.onAskUserQuestion(approvalMenu("Request Changes"));
    appendAuditEntry("GATE_REJECTED", { Stage: "requirements-analysis", "User Input": "Request Changes" }, proj);
    appendAuditEntry("GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" }, proj);

    expect(witness.unanswered()).toEqual([
      expect.stringMatching(/^GATE_APPROVED requirements-analysis \(User Input: Approve\)/),
    ]);
  });

  test("unit gates use their own checkpoint and are not the witness's to match", () => {
    const proj = project();
    const witness = gateWitness(proj);
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation", Unit: "todo-core", "User Input": "Approve" }, proj);
    expect(witness.unanswered()).toEqual([]);
  });
});
