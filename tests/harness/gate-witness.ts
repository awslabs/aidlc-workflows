// gate-witness.ts - prove each gate resolution came from an answered gate.
//
// The engine requires a human turn before it resolves a gate, but a live test
// that only counts GATE_APPROVED rows cannot tell a gate the driver answered
// from one the conductor resolved on a standing instruction ("approve each
// gate"). The witness records every approval menu the driver answered while
// the main workflow held that stage's gate, then matches each main-workflow
// GATE_APPROVED / GATE_REJECTED row to one of those answers.

import {
  auditBlockField,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  type CapturedAskUserQuestion,
  readStateField,
  readStateFile,
} from "./sdk-drive.ts";

export interface WitnessedGateAnswer {
  stage: string;
  answer: string;
}

export interface GateWitness {
  /** Pass as (or call from) driveAidlc's onAskUserQuestion. */
  onAskUserQuestion(menu: CapturedAskUserQuestion): void;
  /** Approval menus answered while their stage's gate was held. */
  answered(): WitnessedGateAnswer[];
  /** Main-workflow gate resolutions no answered gate menu accounts for. */
  unanswered(): string[];
}

// The stage-protocol approval menu: header Approval, Approve first, Request
// Changes second. A third option (a skipped stage, or Accept as-is after three
// revision cycles) may follow.
function approvalQuestion(menu: CapturedAskUserQuestion) {
  const [question] = menu.questions;
  if (menu.questions.length !== 1 || !question || question.multiSelect) return undefined;
  const labels = question.options.map((option) => option.label.trim().toLowerCase());
  if (
    question.header?.trim().toLowerCase() !== "approval" ||
    labels[0] !== "approve" ||
    labels[1] !== "request changes"
  ) return undefined;
  return question;
}

function heldGateStage(projectDir: string): string | undefined {
  const state = readStateFile(projectDir);
  if (!state) return undefined;
  const current = readStateField(state, "Current Stage");
  if (!current) return undefined;
  const held = state.split(/\r?\n/).some((line) =>
    /^- \[\?\] ([a-z0-9-]+)(?:\s|$)/.exec(line)?.[1] === current);
  return held ? current : undefined;
}

export function gateWitness(projectDir: string): GateWitness {
  const answers: WitnessedGateAnswer[] = [];
  return {
    onAskUserQuestion(menu) {
      const question = approvalQuestion(menu);
      if (!question) return;
      const stage = heldGateStage(projectDir);
      const answer = menu.answers[question.question];
      if (!stage || typeof answer !== "string") return;
      answers.push({ stage, answer });
    },
    answered: () => [...answers],
    unanswered() {
      const unused = [...answers];
      const missing: string[] = [];
      for (const row of readAuditShardEvents(projectDir)) {
        if (row.event !== "GATE_APPROVED" && row.event !== "GATE_REJECTED") continue;
        // Unit and delegated-workflow gates use their own checkpoint menus.
        if (auditBlockField(row.block, "Unit") || auditBlockField(row.block, "Workflow")) continue;
        const stage = auditBlockField(row.block, "Stage") ?? "";
        const input = auditBlockField(row.block, "User Input");
        const index = unused.findIndex((witnessed) =>
          witnessed.stage === stage && (input === null || witnessed.answer === input));
        if (index >= 0) unused.splice(index, 1);
        else missing.push(`${row.event} ${stage}${input === null ? "" : ` (User Input: ${input})`} at ${row.timestamp}`);
      }
      return missing;
    },
  };
}
