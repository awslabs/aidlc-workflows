// covers: function:isNonAnswer, function:stripRecommendedDecorator, function:formatReceivedReply
// covers: function:interpretTwoChoiceReply, function:readTwoChoiceReply, function:readApprovalGateReply
// covers: function:readSummaryConfirmationReply, function:replyFollowUp, function:readOptionReply
// covers: function:replyHesitates, function:readStageGateReply, function:markProtectedQuestionReplied
// covers: function:stageGateReplyBound, function:openDecisionBlock
// covers: function:recordProtectedHumanResponse, function:consumeSharedDirectiveAsk
// covers: function:readStopForNow
//
// The person's reply is read in their own words at every question the engine
// asks (#1353), by the one shared reader. The rule the tests protect: a
// number, a letter, a typo, "approved", or a change request is an answer at
// the stage gate, the summary confirmation, a protected checkpoint question,
// and a guard-recovery ask; only a question or a genuinely unclear reply
// records nothing, and its refusal names the one follow-up to ask. Nobody is
// asked to retype an exact label.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  type ActiveDirectiveGuardRemedy,
  auditBlockField,
  consumeSharedDirectiveAsk,
  formatReceivedReply,
  GUARD_RECOVERY_ASK_TYPE,
  guardRecoveryFeedbackStatus,
  isNonAnswer,
  mintProtectedQuestion,
  readAuditShardEvents,
  readProtectedQuestion,
  readProtectedResponse,
  readStageGateReply,
  stateDigest,
  stripRecommendedDecorator,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  interpretTwoChoiceReply,
  readApprovalGateReply,
  readOptionReply,
  readStopForNow,
  readSummaryConfirmationReply,
  readTwoChoiceReply,
  replyFollowUp,
  replyHesitates,
} from "../../dist/claude/.claude/tools/aidlc-reply-reader.ts";
import { recordProtectedHumanResponse } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");

function run(tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", ...extra };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const r = spawnSync(BUN, [tool, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const state = (proj: string, args: string[]) =>
  run(STATE, [...args, "--project-dir", proj], { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" });
const report = (proj: string, args: string[]) => run(ORCHESTRATE, ["report", ...args, "--project-dir", proj]);
const log = (proj: string, args: string[]) => run(LOG, [...args, "--project-dir", proj]);
const humanTurn = (proj: string) => appendAuditEntry("HUMAN_TURN", {}, proj);
const events = (proj: string, name: string) => readAuditShardEvents(proj).filter((row) => row.event === name);

describe("the shared reader", () => {
  const gate = (reply: string, bound = true) => {
    const read = readApprovalGateReply(reply, { bound });
    return read.choice ?? read.reading;
  };

  test("a stage gate reply names its choice by number, letter, label, typo, or plain approval", () => {
    for (const reply of [
      "Approve", "approve", "Approved!", "1", "a", "**Approve**", "Approve (Recommended)", "aprove",
      "the first one", "go with approve", "Looks good. Approved.", "yes", "looks good", "lgtm",
    ]) expect(`${reply} -> ${gate(reply)}`).toBe(`${reply} -> Approve`);
    for (const reply of ["2", "b", "no", "Request Changes", "request chnages", "not yet", "rename the handler"]) {
      expect(`${reply} -> ${gate(reply)}`).toBe(`${reply} -> Request Changes`);
    }
  });

  test("approval that names the next action approves; a trailing question stays a question", () => {
    for (const reply of [
      "Looks good, merge it", "ship this", "merge it", "use that", "Looks good, please merge", "merge the PR", "please merge.",
      "merge it please", "ship it, thanks",
    ]) expect(`${reply} -> ${gate(reply)}`).toBe(`${reply} -> Approve`);
    for (const reply of ["can't merge the PR yet", "won't use it"]) {
      expect(`${reply} -> ${gate(reply)}`).toBe(`${reply} -> Request Changes`);
    }
    for (const reply of ["use this instead", "don't merge it", "looks good but split the tests, ok?", "merge steps 2 and 3"]) {
      expect(`${reply} -> ${gate(reply)}`).toBe(`${reply} -> Request Changes`);
    }
    // Said with a no, the action is the person's feedback.
    expect(readApprovalGateReply("don't use it", { bound: true }).feedback).toBe("don't use it");
    for (const reply of ["yes, what happens after this?", "looks good, what runs next?"]) {
      expect(`${reply} -> ${gate(reply)}`).toBe(`${reply} -> question`);
    }
    // At the summary, "use the defaults" asks to change the answers to the
    // defaults, so it is a change request whose words are the feedback.
    expect(readSummaryConfirmationReply("Use the defaults")).toMatchObject({
      choice: "Request changes", feedback: "Use the defaults",
    });
  });

  test("a plain yes answers the gate only when it is bound; naming the option always does", () => {
    for (const reply of ["yes", "ok", "looks good", "lgtm"]) expect(gate(reply, false)).toBe("confirm");
    for (const reply of ["1", "approve", "Approved."]) expect(gate(reply, false)).toBe("Approve");
  });

  test("a question or an unclear reply names no choice", () => {
    for (const reply of ["what does this do?", "can you explain step 2", "approve?"]) expect(gate(reply)).toBe("question");
    for (const reply of ["", "hmm", "maybe", "Cancelled", "3", "(Recommended)", "Approve (Recommended) extra"]) {
      expect(gate(reply)).toBe("unclear");
    }
  });

  test("Accept as-is is a choice only once the gate offers it", () => {
    for (const reply of ["Accept as-is", "accept as is", "Accept as-is (Recommended)", "3", "the third one"]) {
      expect(readApprovalGateReply(reply, { bound: true }).choice).toBeNull();
      expect(readApprovalGateReply(reply, { bound: true, acceptAsIs: true }).choice).toBe("Accept as-is");
    }
    expect(readApprovalGateReply("1", { bound: true, acceptAsIs: true }).choice).toBe("Approve");
  });

  test("a change request carries the person's words as feedback; a bare pick does not", () => {
    expect(readTwoChoiceReply("rename the handler", ["Approve", "Request Changes"], true).feedback).toBe("rename the handler");
    expect(readTwoChoiceReply("looks good but split the tests", ["Approve", "Request Changes"], true).feedback)
      .toBe("looks good but split the tests");
    for (const bare of ["2", "no", "Request Changes", "changes please", "I'd like some changes", "not yet", "b."]) {
      const read = readTwoChoiceReply(bare, ["Approve", "Request Changes"], true);
      expect(`${bare} -> ${read.reading}`).toBe(`${bare} -> request-changes`);
      expect(`${bare} -> ${read.feedback}`).toBe(`${bare} -> null`);
    }
  });

  test("the summary confirmation also takes 'correct' and 'that's right' as agreement", () => {
    const summary = (reply: string) => readSummaryConfirmationReply(reply).choice ?? readSummaryConfirmationReply(reply).reading;
    for (const reply of ["Looks correct", "looks correct", "correct", "yes", "yep that's right", "all correct", "accurate", "1"]) {
      expect(`${reply} -> ${summary(reply)}`).toBe(`${reply} -> Looks correct`);
    }
    for (const reply of ["2", "Request changes", "no", "not quite right", "that's not right"]) {
      expect(`${reply} -> ${summary(reply)}`).toBe(`${reply} -> Request changes`);
    }
    expect(readSummaryConfirmationReply("the date is wrong, it should be Q3").feedback).toBe("the date is wrong, it should be Q3");
    expect(summary("what is the scope?")).toBe("question");
    // Asked to approve a plan, "correct" is still not approval.
    expect(interpretTwoChoiceReply("correct", ["Approve Plan", "Request Changes"], true)).toBe("unclear");
  });

  test("a question with any number of options reads numbers, letters, ordinals, labels, and picks", () => {
    const labels = ["Restart the stage", "Request Changes", "Record the Unit completion (Recommended)"];
    const pick = (reply: string) => readOptionReply(reply, labels).index;
    expect(["1", "a", "the first one", "restart the stage", "Restart teh stage", "go with 1"].map(pick)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(["2", "b.", "option 2", "the second one", "request changes", "yes 2"].map(pick)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(["3", "C", "last", "record the unit completion", "take 3"].map(pick)).toEqual([2, 2, 2, 2, 2]);
    expect(["4", "2?", "rename x", "", "cancelled"].map(pick)).toEqual([null, null, null, null, null]);
    // A reply that names two options names none.
    expect(readOptionReply("Choose this", ["Choose this", "Choose this"])).toEqual({ index: null, matches: [0, 1] });
  });

  test("every follow-up is plain ASCII and never asks for an exact label", () => {
    for (const reading of ["confirm", "question", "unclear"] as const) {
      const text = replyFollowUp(reading, ["Approve", "Request Changes"]);
      expect(text).not.toMatch(/[^\x20-\x7E]/);
      expect(text).not.toContain("exact");
    }
    expect(replyFollowUp("confirm", ["Approve", "Request Changes"])).toContain('"1" for Approve, "2" for Request Changes');
    expect(replyFollowUp("unclear", ["Approve", "Request Changes"])).toContain("Ask one short follow-up");
  });

  test("the primitives it owns keep their contracts", () => {
    expect(isNonAnswer("Cancelled")).toBe(true);
    expect(isNonAnswer("cancel the standing order")).toBe(false);
    expect(stripRecommendedDecorator("Approve (Recommended)")).toBe("Approve");
    expect(formatReceivedReply("  a   b ")).toBe('"a b"');
    expect(replyHesitates("hmm, let me read it later")).toBe(true);
    expect(replyHesitates("thanks!")).toBe(false);
  });

  test("a stage gate follow-up names the exact rejected command with the person's words", () => {
    const change = readStageGateReply("user-stories", "rename the handler", { acceptAsIs: false, bound: true });
    expect(change.approval).toBeNull();
    expect(change.followUp).toContain("--result rejected");
    expect(change.followUp).toContain("--reason 'rename the handler'");
    const bare = readStageGateReply("user-stories", "no", { acceptAsIs: false, bound: true, unit: "alpha" });
    expect(bare.followUp).toContain('"What should change?"');
    expect(bare.followUp).toContain("--unit alpha");
    expect(readStageGateReply("user-stories", "yes", { acceptAsIs: false, bound: true }).approval).toBe("Approve");
  });

  // An approval and a request to stop the workflow for now is exactly that:
  // the gate is approved and the workflow stops there (#1411).
  const STOP_FOR_NOW = [
    "Approve, but let's stop there for today", "Approved. Stop here for today.", "lgtm, done for today",
    "Approve. Let's pick this up tomorrow.", "approved, that's it for today", "1, and let's call it a day",
  ];
  test("an approval that asks to stop the workflow for now approves and says to stop", () => {
    for (const reply of STOP_FOR_NOW) {
      const read = readStageGateReply("user-stories", reply, { acceptAsIs: false, bound: true });
      expect(`${reply} -> ${read.approval} ${read.stopForNow}`).toBe(`${reply} -> Approve true`);
    }
    // The stop is lifted off what else the reply says.
    expect(readStopForNow("Approve, but let's stop there for today")).toEqual({ stops: true, rest: "approve" });
    expect(readStopForNow("approve, but pause on the DB choice").stops).toBe(false);
    // Nothing else changes: a plain approval goes on, a change request is one,
    // and a pause inside the work is not a stop.
    expect(readStageGateReply("user-stories", "approve", { acceptAsIs: false, bound: true }))
      .toMatchObject({ approval: "Approve", stopForNow: false });
    expect(readStageGateReply("user-stories", "Request Changes", { acceptAsIs: false, bound: true }))
      .toMatchObject({ approval: null, reading: "request-changes", stopForNow: false });
    expect(readStageGateReply("user-stories", "rename the handler, and let's stop for today", { acceptAsIs: false, bound: true }))
      .toMatchObject({ approval: null, reading: "request-changes", stopForNow: false });
    expect(readStageGateReply("user-stories", "approve, but pause on the DB choice", { acceptAsIs: false, bound: true }).stopForNow)
      .toBe(false);
  });

  test("an approval mixed with a change asks once which they meant", () => {
    for (const reply of ["approve, but rename the handler", "Approved, and add a retry to step 2", "1, but split the tests"]) {
      expect(`${reply} -> ${readApprovalGateReply(reply, { bound: true }).reading}`).toBe(`${reply} -> mixed`);
      const read = readStageGateReply("user-stories", reply, { acceptAsIs: false, bound: true });
      expect(read.approval).toBeNull();
      expect(read.followUp).toContain("approve it as it is or make the change first");
      expect(read.followUp).not.toContain("--result rejected");
    }
    // A stop said with them changes nothing: it is still one question, not a
    // change request and not a park.
    expect(readStageGateReply("user-stories", "approve, but rename the handler, and let's stop for today", { acceptAsIs: false, bound: true }))
      .toMatchObject({ approval: null, reading: "mixed", stopForNow: false });
    // A change said with no named approval is still a change request.
    expect(readApprovalGateReply("looks good but split the tests", { bound: true }).reading).toBe("request-changes");
  });
});

describe("the stage gate reads the person's words", () => {
  let proj: string;
  let slug: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    slug = state(proj, ["get", "Current Stage"]).out.trim();
    state(proj, ["checkbox", `${slug}=in-progress`]);
    state(proj, ["gate-start", slug]);
  });
  afterEach(() => cleanupTestProject(proj));

  test.each(["looks good", "aprove", "1", "Approved, thanks"])("%s approves and records Approve", (reply) => {
    humanTurn(proj);
    const r = report(proj, ["--stage", slug, "--result", "approved", "--user-input", reply]);
    expect(r.out).toContain('"kind":"done"');
    const approved = events(proj, "GATE_APPROVED");
    expect(approved).toHaveLength(1);
    expect(auditBlockField(approved[0].block, "User Input")).toBe("Approve");
  });

  test("a change request reported as approval names the rejected report, which takes the words as feedback", () => {
    humanTurn(proj);
    const refused = JSON.parse(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "rename the handler"]).out);
    expect(refused.kind).toBe("error");
    expect(refused.message).toContain("asks for changes");
    expect(refused.message).toContain("--result rejected");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);

    const rejected = report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "rename the handler"]);
    expect(rejected.out, rejected.out).not.toContain('"kind":"error"');
    const row = events(proj, "GATE_REJECTED");
    expect(row).toHaveLength(1);
    expect(auditBlockField(row[0].block, "Feedback")).toBe("rename the handler");
  });

  test("a bare no asks what should change; an approval reported as a rejection is refused", () => {
    humanTurn(proj);
    const bare = JSON.parse(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "no"]).out);
    expect(bare.message).toContain('"What should change?"');
    const approving = JSON.parse(report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "approved"]).out);
    expect(approving.kind).toBe("error");
    expect(approving.message).toContain("approves the stage");
    expect(events(proj, "GATE_REJECTED")).toHaveLength(0);
  });

  test("a question records nothing and says to answer it and ask again", () => {
    humanTurn(proj);
    const asked = JSON.parse(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "what does this cover?"]).out);
    expect(asked.message).toContain("asked a question");
    expect(asked.message).not.toContain("did not match an offered choice");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
  });

  test("a recovered gate still sees a question waiting from before the gate opened", () => {
    const fresh = createTestProject();
    try {
      seedStateFile(fresh, "state-mid-ideation.md");
      const stage = state(fresh, ["get", "Current Stage"]).out.trim();
      state(fresh, ["checkbox", `${stage}=in-progress`]);
      expect(log(fresh, ["decision", "--stage", stage, "--decision", "Add the README section too?", "--options", "Yes,No"]).rc).toBe(0);
      humanTurn(fresh);
      const yes = JSON.parse(report(fresh, ["--stage", stage, "--result", "approved", "--user-input", "yes"]).out);
      expect(yes.message).toContain("confirm in one reply");
      expect(events(fresh, "GATE_APPROVED")).toHaveLength(0);
    } finally {
      cleanupTestProject(fresh);
    }
  });

  test.each([
    "Approve, but let's stop there for today", "Approved. Stop here for today.", "lgtm, done for today",
  ])("%s approves the gate and parks the workflow, with no extra question", (reply) => {
    humanTurn(proj);
    const r = JSON.parse(report(proj, ["--stage", slug, "--result", "approved", "--user-input", reply]).out);
    expect(r.kind, JSON.stringify(r)).toBe("parked");
    expect(r.reason).toContain(`Approved "${slug}"`);
    expect(r.reason).toContain("Resume with /aidlc --resume");
    const approved = events(proj, "GATE_APPROVED");
    expect(approved).toHaveLength(1);
    expect(auditBlockField(approved[0].block, "User Input")).toBe("Approve");
    expect(events(proj, "WORKFLOW_PARKED")).toHaveLength(1);
    const state = readFileSync(seededStateFile(proj), "utf-8");
    expect(state).toMatch(/^- \*\*Parked At Stage\*\*: scope-definition$/m);
  });

  // The person answered this gate, so their stop parks an autonomous run too
  // (#1411); a gate the autonomy grant answers never parks (t339).
  test("an approval that asks to stop parks under autonomous Construction too", () => {
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace(
      "## Current Status", "## Current Status\n- **Construction Autonomy Mode**: autonomous",
    ), "utf-8");
    humanTurn(proj);
    const r = JSON.parse(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve, but let's stop there for today"]).out);
    expect(r.kind, JSON.stringify(r)).toBe("parked");
    expect(events(proj, "WORKFLOW_PARKED")).toHaveLength(1);
    expect(readFileSync(file, "utf-8")).toMatch(/^- \*\*Parked By\*\*: person$/m);
  });

  test("an approval mixed with a change records nothing and asks once", () => {
    humanTurn(proj);
    const approving = JSON.parse(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "approve, but rename the handler"]).out);
    expect(approving.kind).toBe("error");
    expect(approving.message).toContain("approve it as it is or make the change first");
    const rejecting = JSON.parse(report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "approve, but rename the handler"]).out);
    expect(rejecting.kind).toBe("error");
    expect(rejecting.message).toContain("approve it as it is or make the change first");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
    expect(events(proj, "GATE_REJECTED")).toHaveLength(0);
  });

  test("a plain yes while another recorded question waits asks for one confirmation", () => {
    expect(log(proj, ["decision", "--stage", slug, "--decision", "Add the README section too?", "--options", "Yes,No"]).rc).toBe(0);
    humanTurn(proj);
    const yes = JSON.parse(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "yes"]).out);
    expect(yes.message).toContain("confirm in one reply");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
  });
});

describe("the summary confirmation reads the person's words", () => {
  let proj: string;
  let slug: string;
  let questions: string;

  function summary(answer: string): void {
    writeFileSync(questions, [
      "# Feasibility Questions", "", "## Consolidated Summary Confirmation", "",
      "- Looks correct", "- Request changes", "", `[Answer]: ${answer}`, "",
    ].join("\n"));
  }

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    slug = state(proj, ["get", "Current Stage"]).out.trim();
    questions = join(seededRecordDir(proj), "ideation", slug, `${slug}-questions.md`);
    mkdirSync(join(questions, ".."), { recursive: true });
    summary("");
    expect(log(proj, [
      "decision", "--stage", slug, "--checkpoint", "summary-confirmation", "--questions-file", questions,
      "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes",
    ]).rc).toBe(0);
    humanTurn(proj);
  });
  afterEach(() => cleanupTestProject(proj));

  const answer = (details: string) => log(proj, [
    "answer", "--stage", slug, "--checkpoint", "summary-confirmation", "--questions-file", questions, "--details", details,
  ]);

  test("'yep, that's right' records Looks correct", () => {
    summary("Looks correct");
    const r = answer("yep, that's right");
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain('"choice":"Looks correct"');
    expect(auditBlockField(events(proj, "SUMMARY_CONFIRMATION_RECORDED")[0].block, "Details")).toBe("Looks correct");
  });

  test("a change request records Request changes and hands back the feedback", () => {
    summary("Request changes");
    const r = answer("the date is wrong, it should be Q3");
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain('"choice":"Request changes"');
    expect(r.out).toContain('"feedback":"the date is wrong, it should be Q3"');
  });

  test("a plain yes after another question was asked asks for one confirmation", () => {
    summary("Looks correct");
    expect(log(proj, ["decision", "--stage", slug, "--decision", "Add a glossary?", "--options", "Yes,No"]).rc).toBe(0);
    humanTurn(proj);
    const yes = answer("yes");
    expect(yes.rc).not.toBe(0);
    expect(yes.out).toContain("confirm in one reply");
    expect(answer("looks correct").rc).toBe(0);
  });

  test("an unclear reply is refused with one short follow-up, and a file that disagrees is refused", () => {
    summary("Looks correct");
    const unclear = answer("hmm");
    expect(unclear.rc).not.toBe(0);
    expect(unclear.out).toContain("Ask one short follow-up");
    const disagrees = answer("no, the scope is wrong");
    expect(disagrees.rc).not.toBe(0);
    expect(disagrees.out).toContain("Request changes");
    expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(0);
  });
});

describe("a protected checkpoint question reads the person's words", () => {
  const session = "own-words";
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-construction.md");
  });
  afterEach(() => cleanupTestProject(proj));

  const ask = () => mintProtectedQuestion(proj, { kind: "verification-command", session, target: { commandSha256: "a".repeat(64) } });

  test("the first reply may be a plain yes; a typo or 'approved' always counts", () => {
    for (const reply of ["yes", "approved", "aprove", "1"]) {
      ask();
      expect(recordProtectedHumanResponse(proj, session, reply, null).recorded, reply).toBe(true);
      expect(readProtectedResponse(proj, session)?.choice, reply).toBe("Approve");
    }
    ask();
    expect(recordProtectedHumanResponse(proj, session, "no, use the full test suite", null).recorded).toBe(true);
    expect(readProtectedResponse(proj, session)?.choice).toBe("Request Changes");
  });

  test("after a question, a plain yes asks to confirm and a number records", () => {
    ask();
    const asked = recordProtectedHumanResponse(proj, session, "what does this command run?", null);
    expect(asked.recorded).toBe(false);
    expect(asked.notice).toContain("asked a question");
    expect(readProtectedQuestion(proj, session)?.replied).toBe(true);
    const yes = recordProtectedHumanResponse(proj, session, "yes", null);
    expect(yes.recorded).toBe(false);
    expect(yes.notice).toContain("confirm in one reply");
    expect(recordProtectedHumanResponse(proj, session, "1", null).recorded).toBe(true);
    expect(readProtectedResponse(proj, session)?.choice).toBe("Approve");
  });
});

describe("a guard-recovery ask reads the person's words", () => {
  let proj: string;
  let content: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
    content = readFileSync(seededStateFile(proj), "utf-8");
  });
  afterEach(() => cleanupTestProject(proj));

  const remedies: ActiveDirectiveGuardRemedy[] = [
    { op: "reconfirm-summary", action: "Present the current summary again" },
    { op: "request-changes", action: "Ask what should change" },
  ];
  const ask = () => writeActiveDirectiveMarker(proj, {
    kind: "ask", ask_type: GUARD_RECOVERY_ASK_TYPE, stage: "functional-design", state_sha256: stateDigest(content), remedies,
  });
  const selected = () => (JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine/active-directive.json"), "utf-8")) as {
    guard_recovery_response?: { selected_op?: string | null; status?: string };
  }).guard_recovery_response;

  test.each([
    ["the first one", "reconfirm-summary"],
    ["a", "reconfirm-summary"],
    ["Presnt the current summary again", "reconfirm-summary"],
    ["b.", "request-changes"],
    ["go with 2", "request-changes"],
    ["no", null],
  ])("%s picks %s", (reply, op) => {
    ask();
    expect(consumeSharedDirectiveAsk(proj, reply)).toBe(true);
    expect(selected()?.selected_op ?? null).toBe(op);
  });

  test("a reply that says what should change picks Request Changes and is its feedback", () => {
    ask();
    expect(consumeSharedDirectiveAsk(proj, "split the save-search flow into two steps")).toBe(true);
    expect(selected()).toMatchObject({ selected_op: "request-changes", status: "ready" });
    expect(guardRecoveryFeedbackStatus(proj, content, "functional-design", undefined, "split the save-search flow into two steps"))
      .toBe("match");
  });
});
