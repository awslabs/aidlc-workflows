// The post-artifact human wait t183's live drive of Reverse Engineering stops
// at: the stage's artifacts are on disk, the engine still holds the stage, and
// nobody has answered what it asked. Read from the engine's record, never from
// how the model rendered the question. tests/unit/t-post-artifact-wait.test.ts
// pins it on the shapes recorded live.

import type { CapturedAskUserQuestion } from "./sdk-drive.ts";

/** The resume menu a bare `/aidlc` may show on work in progress (Resume, Redo,
 *  Jump, Start fresh). */
function isResumeMenu(menu: CapturedAskUserQuestion): boolean {
  return menu.questions.some((question) => {
    const labels = question.options.map((option) => option.label);
    return labels.some((label) => /^resume\b/i.test(label)) && labels.some((label) => /\bfresh\b/i.test(label));
  });
}

/**
 * The test person answers the resume menu with Resume and leaves every other
 * box open ("Chat about this"). The first question after the artifacts can be
 * the gate itself, and a pick there would approve RE; on Windows the CLI runs
 * on for seconds after the drive's stop, long enough to record it.
 */
export function leavesOpen(menu: CapturedAskUserQuestion): boolean {
  return !isResumeMenu(menu);
}

// What answers a question the engine logged: the person's pick or reply, the
// agent's record of it, or the gate's decision.
const ANSWERS = new Set(["QUESTION_REPLIED", "QUESTION_ANSWERED", "GATE_APPROVED", "GATE_REJECTED"]);

export interface PostArtifactRun {
  /** Audit event types, in file order. */
  events: string[];
  /** The drive stopped at a box the test person left open. */
  stoppedAtOpenBox: boolean;
  /** The SDK result's subtype; absent when the drive stopped mid-turn. */
  resultSubtype?: string;
  /** The state file the drive left. */
  stateFile?: string;
}

/** What says RE did not stop at its post-artifact wait; empty when it did. */
export function postArtifactWaitProblems(run: PostArtifactRun): string[] {
  const { events } = run;
  const tail = JSON.stringify(events.slice(-12));
  const problems: string[] = [];
  // The turn ended on a question the engine logged after the stage's final
  // pipeline link (the learnings question, or the gate itself) and nobody
  // answered it.
  const lastLink = events.lastIndexOf("PIPELINE_LINK_COMPLETED");
  const lastAsk = Math.max(events.lastIndexOf("DECISION_RECORDED"), events.lastIndexOf("STAGE_AWAITING_APPROVAL"));
  const waitingOnLoggedQuestion = run.resultSubtype === "success" && lastLink !== -1 && lastAsk > lastLink &&
    !events.slice(lastAsk).some((event) => ANSWERS.has(event));
  if (!run.stoppedAtOpenBox && !waitingOnLoggedQuestion) {
    problems.push(`RE never reached its post-artifact human wait: ${tail}`);
  }
  // Under the test profile, a conductor that reports RE complete without
  // asking gets it approved with nobody asked, and the next stage's first
  // question would pass for RE's wait.
  if (events.includes("GATE_APPROVED")) problems.push(`RE was approved with nobody asked: ${tail}`);
  if (!(run.stateFile ?? "").includes("- **Current Stage**: reverse-engineering")) {
    const stage = run.stateFile?.split(/\r?\n/).find((line) => line.startsWith("- **Current Stage**:"));
    problems.push(`the engine no longer holds Reverse Engineering: ${stage ?? "the drive left no state file"}`);
  }
  return problems;
}
