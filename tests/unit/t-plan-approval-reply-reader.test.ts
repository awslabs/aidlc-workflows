// covers: function:interpretPlanApprovalReply, function:planApprovalReplyNotice
//
// How the human-turn hook reads a reply to a pending Plan Approval question.
// The rule the table protects: infer what the human meant from their own
// words, never read anything but a clear yes as approval, count a plain yes
// only when the reply is bound to the approval question itself, and leave the
// question open only when the meaning is unclear.

import { describe, expect, test } from "bun:test";
import {
  interpretPlanApprovalReply,
  planApprovalReplyNotice,
  type PlanApprovalReplyReading,
} from "../../core/tools/aidlc-testing-posture.ts";

const SINGLE: [string, string] = ["Approve Plan", "Request Changes"];
const GROUPED: [string, string] = ["Approve Plans", "Request Changes"];

// bound: the reply was picked or typed in the approval picker itself.
const read = (text: string, bound: boolean, options = SINGLE) =>
  interpretPlanApprovalReply(text, options, bound);

function expectAll(replies: string[], reading: PlanApprovalReplyReading, bound: boolean): void {
  for (const reply of replies) expect(`${reply} -> ${read(reply, bound)}`).toBe(`${reply} -> ${reading}`);
}

// Naming the option, by position or by its words, is always a choice.
const NAMED_APPROVAL = [
  "1", "1.", "1)", "(1)", "[1]", "#1", "option 1", "A", "a.", "a)", "(a)", "Option A",
  "Approve Plan", "approve plan", "APPROVE PLAN.", "\"Approve Plan\"", "`Approve Plan`",
  "\u201cApprove Plan\u201d", "Approve Plan (Recommended)", "approve", "Approved!",
  "approve it", "I approve", "approve the plan", "1 - looks good", "1, thanks for this",
  "the first one", "pick 1", "going with A", "Looks good. Approved.", "aprove", "aproved",
  "apporve", "ApprovePlan", "option one", "top one", "let's go with 1", "I'll take 1",
  "selecting Approve Plan", "yes 1", "yes, option 1", "\uFF11", "\u2460", "1\uFE0F\u20E3",
  "Approving now", "approve the Code Generation plan", "approve, and thanks", "no changes, approve",
  "> Approve this exact Code Generation plan?\n\napprove",
  "**Approve Plan**", "- Approve Plan", "# Approve Plan", "Approve-Plan", "I approve this plan",
  "yes approve", "approve plan please", "**1**", "1\u200B", "\u200F1", "the first option please",
  "i'll go with the first",
  "Approved, thanks for the thorough plan", "Approved. Nice work.", "Approved. Keep me posted.",
  "Approved\n\n---\nSent from my phone", "approve :)", "[x] Approve Plan", "~~2~~ 1",
  "~~Request Changes~~ Approve Plan", "Approval granted", "You have my approval", "ok so approve",
  "approve and then ship", "I can approve", "we can approve", "I will approve", "I'll approve",
];
const NAMED_CHANGES = [
  "2", "2.", "2)", "B", "b.", "b)", "Request Changes", "request changes", "Changes please",
  "2 - rename the handler", "Request Changes: add caching", "the second one", "Request Chanes",
  "Reqeust Chnages", "RequestChanges", "option two", "bottom one", "I'll take 2", "no, 2", "no b",
  "**2**", "- 2", "i'll go with the second one", "[ ] Approve Plan\n[x] Request Changes",
];
// Any change request, however phrased, is Request Changes and never approval.
const CHANGE_REQUESTS = [
  "no", "No.", "nope", "not yet", "wait", "stop", "do not approve", "don't approve", "don't go ahead",
  "rename the handler", "change step 3 to use Postgres", "can you split the tests?",
  "could you add a retry to step 2?", "looks good but rename the handler",
  "yes but use postgres", "lgtm except step 4", "there's a typo in step 2",
  "step 3 is wrong", "use postgres instead", "I'd rather use sqlite",
  "yes, delete the tmp folder", "ok but not yet", "\u{1F44E}", "not approved",
  "yeah right", "never mind", "nvm", "approve once the tests pass", "yes if you add tests",
  "yeah... no", "oh no", "hard pass", "don't generate code yet", "can't approve yet",
  "not like this", "fine as long as you keep the old API", "conditionally approve",
  "step 2 looks off", "\u{1F6D1}",
];
// Naming the approval and asking for a change in the same reply could mean
// either, so the person is asked once which they meant.
const MIXED = [
  "approve, but rename the handler", "approved, but add a test for the parser",
  "1, but rename the handler", "Approve Plan, but use postgres", "approve it and fix the typo in step 2",
];
// A plain yes names no option: it approves only when bound to the question.
const PLAIN_YES = [
  "yes", "Yes!", "y", "ok", "okay", "k", "lgtm", "LGTM!", "looks good",
  "looks good, go ahead", "sounds good", "go ahead", "ship it", "do it", "let's go",
  "sure", "yep, go for it", "yes please", "perfect, thanks", "all good",
  "no changes needed", "nothing to change", "\u{1F44D}", "lgtm \u{1F44D}", "yes, start coding",
  "great, proceed", "works for me", "sure, why not", "sounds like a plan", "thank you, looks great",
  "yesss", "yeah, no problem", "fine by me", "sure thing", "let's build it", "\u2611\uFE0F",
  "no questions", "I have no further changes", "let's move forward",
  "go", "just do it", "good to go", "Don't change anything; proceed", "leave it as is",
  "nothing needs changing",
];
// A question is not an answer; the conductor answers it.
const QUESTIONS = [
  "what does step 3 do?", "why is there a separate parser?", "how long will this take?",
  "does this cover the migration?", "should we split the tests?",
  "could you walk me through step 3?", "is it safe to run twice?",
  "approve?", "Approve Plan?", "1?", "A: what's the timeline?",
  "can you explain step 4", "explain step 4 please", "could you clarify the rollback",
];
// Meaning unclear: ask once, record nothing. The second half are replies an
// earlier reader wrongly took as approval.
const UNCLEAR = [
  "", "   ", "hmm", "hmmm", "maybe", "not sure", "up to you", "whatever you think",
  "you decide", "I'll look later", "3", "thanks", "cancel", "cancelled", "yes and no",
  "no no it's fine, go ahead", "yes to the README question", "1 or 2", "1 2",
  "approve?? not sure",
  "1 concern", "1 more thing", "correct", "right", "go away", "<approve/>", "yes to the linter",
  "yes 2", "no 1", "oh great", "no chances",
  // A named approval that something else qualifies or takes back.
  "approve, as soon as the tests pass", "approve, when CI is green", "approve, renaming the handler",
  "Approved. Just kidding.", "approve... jk", "Approved. Scratch that.", "approve, 2",
  "no\n1", "No\n\n1", "no. 1",
  // Sounds like yes, but is not approval of the plan.
  "good start", "go on", "I'm good, thanks", "ok so", "ok and then",
  // Leaving is not approving.
  "I have to go", "I need to go", "brb", "I have to do it", "I have to ship",
  // A hedge carries an unstated "if".
  "I would approve", "I could approve", "I might approve", "I'd approve", "I'll probably approve",
  // Struck through, or said with a sad face.
  "~~approve~~", "~~1~~", "Approved :(", "approved -_-",
];

describe("Plan Approval reply reader", () => {
  test("naming the approval option is approval, bound or typed", () => {
    expectAll(NAMED_APPROVAL, "approve", true);
    expectAll(NAMED_APPROVAL, "approve", false);
  });

  test("naming Request Changes is Request Changes, bound or typed", () => {
    expectAll(NAMED_CHANGES, "request-changes", true);
    expectAll(NAMED_CHANGES, "request-changes", false);
  });

  test("any change request is Request Changes and never approval", () => {
    expectAll(CHANGE_REQUESTS, "request-changes", true);
    expectAll(CHANGE_REQUESTS, "request-changes", false);
  });

  test("an approval mixed with a change asks once which they meant", () => {
    expectAll(MIXED, "mixed", true);
    expectAll(MIXED, "mixed", false);
  });

  test("a plain yes approves in the approval picker and asks to confirm when typed", () => {
    expectAll(PLAIN_YES, "approve", true);
    expectAll(PLAIN_YES, "confirm", false);
  });

  test("a question records nothing", () => {
    expectAll(QUESTIONS, "question", true);
    expectAll(QUESTIONS, "question", false);
  });

  test("an unclear reply records nothing", () => {
    expectAll(UNCLEAR, "unclear", true);
    expectAll(UNCLEAR, "unclear", false);
  });

  test("grouped approval reads the same way with its own label", () => {
    expect(read("Approve Plans", false, GROUPED)).toBe("approve");
    expect(read("approve plans", false, GROUPED)).toBe("approve");
    expect(read("1", false, GROUPED)).toBe("approve");
    expect(read("yes", true, GROUPED)).toBe("approve");
    expect(read("yes", false, GROUPED)).toBe("confirm");
    expect(read("2", false, GROUPED)).toBe("request-changes");
  });

  test("every reading tells the conductor its next step", () => {
    expect(planApprovalReplyNotice("approve")).toContain('--details "Approve Plan"');
    expect(planApprovalReplyNotice("request-changes")).toContain('--details "Request Changes"');
    expect(planApprovalReplyNotice("request-changes")).toContain("revise the plan");
    expect(planApprovalReplyNotice("confirm")).toContain('"1" to approve the plan');
    expect(planApprovalReplyNotice("question")).toContain("Answer it");
    expect(planApprovalReplyNotice("unclear")).toContain("Ask one short follow-up");
    expect(planApprovalReplyNotice("mixed")).toContain("make the change first");
    expect(planApprovalReplyNotice("unbound")).toContain("Ask Plan Approval on its own as a single-choice question");
    // Both name the one question under which a plain yes counts.
    expect(planApprovalReplyNotice("confirm")).toContain('"Approve this exact Code Generation plan?"');
    expect(planApprovalReplyNotice("unbound")).toContain('"Approve this exact Code Generation plan?"');
    for (const reading of ["approve", "request-changes", "confirm", "question", "unclear", "mixed", "unbound"] as const) {
      expect(planApprovalReplyNotice(reading)).not.toMatch(/[^\x20-\x7E]/);
    }
  });
});
