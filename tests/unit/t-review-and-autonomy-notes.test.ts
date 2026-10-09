// covers: function:withAgentNotes function:autonomyChoiceNote function:reviewRequestNote
//
// Rows 198 and 199 of the live-run audit, both from one Kiro IDE run with no
// skill loaded (kiro-ide-rules kir-j3):
//   - the agent wrote the reviewer's file itself and recorded READY, so the
//     person got a review their reviewer never wrote;
//   - the Construction autonomy choice was never put to them, so they were
//     never asked "Continue automatically / Review each checkpoint".
// Both steps are the engine's to name, the way #2094 gave other fields their
// own agent step: the review request now says who writes the file, and a step
// that offers the autonomy choice says to put that one question to the person
// and how to record their answer.

import { describe, expect, test } from "bun:test";
import {
  autonomyChoiceNote,
  reviewRequestNote,
  validateDirective,
  withAgentNotes,
} from "../../core/tools/aidlc-directive.ts";

const INVOCATION = "bun .claude/tools/aidlc-orchestrate.ts";

/** A run-stage as the engine builds one for a Unit's Construction step. */
function runStage(policy: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "run-stage",
    stage: "functional-design",
    phase: "construction",
    stage_file: ".claude/aidlc-common/stages/construction/functional-design.md",
    lead_agent: "aidlc-architect-agent",
    gate: false,
    unit: "u1-note-store",
    construction_policy: policy,
  };
}

const GATED = {
  iteration: "unit-major",
  execution: "serial",
  autonomy: "unset",
  offer_autonomy: false,
  human_completion_required: false,
  completion_only: false,
};

describe("the autonomy choice is a step the engine names", () => {
  test("a step that offers it carries the question, the two choices and the setter", () => {
    const directive = withAgentNotes(runStage({ ...GATED, offer_autonomy: true }), INVOCATION) as Record<
      string,
      unknown
    >;
    const note = String(directive.construction_policy_note ?? "");
    expect(note).toContain("How should I continue building the remaining work?");
    expect(note).toContain("Continue automatically");
    expect(note).toContain("Review each checkpoint");
    expect(note).toContain("bun .claude/tools/aidlc-bolt.ts set-autonomy --mode <autonomous|gated>");
    expect(note).toContain("never answer it yourself");
  });

  test("a step that does not offer it carries no note", () => {
    const directive = withAgentNotes(runStage(GATED), INVOCATION) as Record<string, unknown>;
    expect(directive.construction_policy_note).toBeUndefined();
  });

  test("the note is a legal run-stage field, and only as a string", () => {
    // The fixture leaves out other required fields on purpose: what matters
    // here is that this key is known and typed, not the rest of the shape.
    const asString = JSON.stringify(validateDirective({ ...runStage(GATED), construction_policy_note: "step" }));
    expect(asString).not.toContain("construction_policy_note");
    const asNumber = JSON.stringify(validateDirective({ ...runStage(GATED), construction_policy_note: 7 }));
    expect(asNumber).toContain("run-stage: construction_policy_note must be a non-empty string");
  });

  test("the native install names its own command", () => {
    const directive = withAgentNotes(
      runStage({ ...GATED, offer_autonomy: true }),
      "aidlc engine orchestrate",
    ) as Record<string, unknown>;
    expect(String(directive.construction_policy_note ?? "")).toContain(
      "aidlc engine bolt set-autonomy --mode <autonomous|gated>",
    );
  });
});

describe("the review request says who writes the review", () => {
  test("it names the reviewer, the file and the command that closes it", () => {
    const note = reviewRequestNote(
      "aidlc-architecture-reviewer-agent",
      "aidlc/spaces/default/intents/261005-notes-cli/.aidlc-engine/reviews/functional-design/1.review.md",
      "bun .claude/tools/aidlc-log.ts review --stage functional-design --verdict <READY|CHANGES> --iteration 1",
    );
    expect(note).toContain("aidlc-architecture-reviewer-agent");
    expect(note).toContain("1.review.md");
    expect(note).toContain("never write it yourself");
    expect(note).toContain("--verdict <READY|CHANGES>");
  });

  test("the autonomy note and the review note are each one step, not a paragraph", () => {
    for (const note of [
      autonomyChoiceNote(INVOCATION),
      reviewRequestNote("aidlc-quality-agent", "reviews/2.review.md", "run this"),
    ]) {
      expect(note.length).toBeLessThan(700);
      expect(note).not.toContain("\n");
    }
  });
});
