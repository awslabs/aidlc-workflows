// covers: function:isNonAnswer, function:stripRecommendedDecorator, function:formatReceivedReply
// covers: function:exactOptionPick, function:stageGateApproval, function:personsGateWords
// covers: function:personsLatestGatePick, function:changeRequestWords, function:markProtectedQuestionReplied
// covers: function:recordProtectedHumanResponse, function:requireProtectedResponse
// covers: function:consumeSharedDirectiveAsk, function:recordGuardRecoveryChoice
// covers: function:openDecisionBlock, function:PROTECTED_RESPONSE_WORDS_MAX_CHARS
//
// The person drives (tools for determinism, the model for knowledge, the human
// for judgement). The agent reads the person's reply and records the choice
// they made; the engine keeps their exact words on the receipt and never reads
// meaning into them. What stays a tool's job is exact: that a person replied
// since the question was shown, their words verbatim, and a reply that is
// exactly one offered option, which is recorded as their pick and cannot be
// overruled by the agent. These cases protect that split at a stage gate, the
// summary confirmation, a protected checkpoint question, and a recovery ask.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import {
  type ActiveDirectiveGuardRemedy,
  auditBlockField,
  changeRequestWords,
  consumeSharedDirectiveAsk,
  formatReceivedReply,
  GUARD_RECOVERY_ASK_TYPE,
  guardRecoveryFeedbackStatus,
  isNonAnswer,
  mintProtectedQuestion,
  openDecisionBlock,
  PROTECTED_RESPONSE_WORDS_MAX_CHARS,
  protectedTargetDigest,
  readAuditShardEvents,
  readProtectedQuestion,
  readProtectedResponse,
  recordGuardRecoveryChoice,
  requireProtectedResponse,
  stageGateApproval,
  stateDigest,
  stripRecommendedDecorator,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { exactOptionPick } from "../../dist/claude/.claude/tools/aidlc-reply-reader.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { recordProtectedHumanResponse } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000f00d";

function run(tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
    ...extra,
  };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const r = spawnSync(BUN, [tool, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const state = (proj: string, args: string[]) =>
  run(STATE, [...args, "--project-dir", proj], { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" });
const log = (proj: string, args: string[]) => run(LOG, [...args, "--project-dir", proj]);
const events = (proj: string, name: string) => readAuditShardEvents(proj).filter((row) => row.event === name);

// `report` as the agent runs it in this chat.
function report(proj: string, args: string[]): { kind: string; message?: string } {
  const r = run(ORCHESTRATE, ["report", ...args, "--project-dir", proj]);
  const line = r.out.split("\n").find((entry) => entry.startsWith("{"));
  expect(line, r.out).toBeDefined();
  return JSON.parse(line as string) as { kind: string; message?: string };
}

// What the person types, through the real UserPromptSubmit route every harness uses.
function says(proj: string, prompt: string): void {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

// What the person picks in the harness's picker, as a PostToolUse answer.
function picks(proj: string, label: string, options = ["Approve", "Request Changes"], question = "Approve this stage?"): void {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: SESSION,
      tool_input: { questions: [{ question, options: options.map((option) => ({ label: option })) }] },
      tool_response: { answers: { [question]: label } },
    }),
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

describe("an exact pick is syntax, and only syntax", () => {
  const PLAN = ["Approve Plan", "Request Changes", "I'll edit the files"];
  test.each([
    ["1", 0], ["2", 1], ["3", 2], ["(2)", 1], ["option 2", 1], ["b", 1], ["B.", 1],
    ["approve plan", 0], ["Approve Plan (Recommended)", 0], ["**Request Changes**", 1],
    ["\"I'll edit the files\"", 2], ["1. Approve Plan", 0], ["Approve Plan.", 0],
    // A lettered pick, where the question offers lettered options.
    ["A", 0], ["A)", 0], ["a)", 0], ["(b)", 1], ["A) Approve Plan", 0], ["b) Request Changes", 1],
    ["C. I'll edit the files", 2],
  ] as const)("%s picks option %i", (reply, index) => {
    expect(exactOptionPick(reply, PLAN)).toBe(index);
  });

  test.each([
    "4", "2. Approve Plan", "a) Request Changes", "d", "approve", "aprove plan", "looks good", "the first one", "go with 2",
    "approve plan, but rename the handler", "", "   ",
  ])("%s is not an exact pick: the agent reads it", (reply) => {
    expect(exactOptionPick(reply, PLAN)).toBeNull();
  });

  test("the primitives it owns keep their contracts", () => {
    expect(isNonAnswer("Cancelled")).toBe(true);
    expect(isNonAnswer("cancel the standing order")).toBe(false);
    expect(stripRecommendedDecorator("Approve (Recommended)")).toBe("Approve");
    expect(formatReceivedReply("  a\n b ")).toBe('"a b"');
    expect(stageGateApproval("Accept as-is", true)).toBe("Accept as-is");
    expect(stageGateApproval("c) Accept as-is", true)).toBe("Accept as-is");
    expect(stageGateApproval("Accept as-is", false)).toBe("Approve");
    expect(stageGateApproval("looks fine but rename the handler", true)).toBe("Approve");
    expect(changeRequestWords("2\nrename the handler\nRequest Changes")).toBe("rename the handler");
  });
});

describe("the stage gate records the choice the agent read, with the person's words", () => {
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

  test("an approval with an instruction is recorded once, with their words, and no second question", () => {
    says(proj, "looks fine but rename the handler");
    const done = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    const approved = events(proj, "GATE_APPROVED");
    expect(approved).toHaveLength(1);
    expect(auditBlockField(approved[0].block, "User Input")).toBe("Approve");
    expect(auditBlockField(approved[0].block, "Person Reply")).toBe("looks fine but rename the handler");
  });

  test("the receipt carries the person's words, never the agent's text", () => {
    says(proj, "lgtm");
    report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve, the person said so"]);
    const approved = events(proj, "GATE_APPROVED");
    expect(approved).toHaveLength(1);
    expect(auditBlockField(approved[0].block, "Person Reply")).toBe("lgtm");
  });

  test("approve, a change, and stop for today: recorded, and the workflow parks", () => {
    says(proj, "approve, rename the handler, and let's stop for today");
    const parked = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve", "--park"]);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(1);
    expect(events(proj, "WORKFLOW_PARKED")).toHaveLength(1);
  });

  test.each(["2", "B", "b) Request Changes"])("an exact Request Changes (%s) is the person's pick: an approval is refused", (pick) => {
    says(proj, pick);
    const refused = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]);
    expect(refused.kind).toBe("error");
    expect(refused.message).toContain("picked Request Changes");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
  });

  test("a Request Changes picked in the picker is the person's pick: an approval is refused", () => {
    picks(proj, "Request Changes");
    const refused = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]);
    expect(refused.kind).toBe("error");
    expect(refused.message).toContain("picked Request Changes");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
  });

  test("an Approve picked in some other picker is not the gate's pick", () => {
    picks(proj, "Approve", ["Approve", "Skip"], "Use the cache for this run?");
    says(proj, "rename the handler");
    const revised = report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes"]);
    expect(revised.kind, JSON.stringify(revised)).toBe("print");
    expect(events(proj, "GATE_REJECTED")).toHaveLength(1);
  });

  test("once Accept as-is is on offer, a typed 3 is that pick, whatever approval the agent reports", () => {
    expect(state(proj, ["set", "Revision Count=3"]).rc).toBe(0);
    says(proj, "3");
    expect(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]).kind).toBe("done");
    expect(auditBlockField(events(proj, "GATE_APPROVED")[0].block, "User Input")).toBe("Accept as-is");
  });

  test("an exact Approve is the person's pick: a rejection is refused", () => {
    says(proj, "Approve");
    const refused = report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes", "--reason", "x"]);
    expect(refused.kind).toBe("error");
    expect(refused.message).toContain("picked Approve");
    expect(events(proj, "GATE_REJECTED")).toHaveLength(0);
  });

  test("their latest message decides: a pick they then talked past is not held against them", () => {
    says(proj, "2");
    says(proj, "actually it is fine, go ahead");
    expect(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]).kind).toBe("done");
  });

  test("a change request takes their words as the feedback, leaving out a bare pick", () => {
    says(proj, "Request Changes");
    says(proj, "rename the handler");
    const revised = report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes"]);
    expect(revised.kind, JSON.stringify(revised)).toBe("print");
    expect(auditBlockField(events(proj, "GATE_REJECTED")[0].block, "Feedback")).toBe("rename the handler");
  });

  test("nothing is decided without a reply from the person since the gate was shown", () => {
    const refused = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]);
    expect(refused.kind).toBe("error");
    expect(refused.message).toContain("no new human reply");
    expect(events(proj, "GATE_APPROVED")).toHaveLength(0);
  });

  test("a misread Request Changes is undone in one step: revised shows the gate, and the approval records", () => {
    says(proj, "looks good, just double-check the naming later");
    report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes"]);
    says(proj, "no, I approved it");
    const again = report(proj, ["--stage", slug, "--result", "revised"]);
    expect(again.kind, JSON.stringify(again)).not.toBe("error");
    expect(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]).kind).toBe("done");
  });
});

describe("the summary confirmation records the choice the agent read", () => {
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
    says(proj, "yep, that's right");
  });
  afterEach(() => cleanupTestProject(proj));

  const answer = (details: string) => log(proj, [
    "answer", "--stage", slug, "--checkpoint", "summary-confirmation", "--questions-file", questions, "--details", details,
  ]);

  test("Looks correct records with the person's reply behind it", () => {
    summary("Looks correct");
    const r = answer("Looks correct");
    expect(r.rc, r.out).toBe(0);
    expect(events(proj, "SUMMARY_CONFIRMATION_RECORDED")).toHaveLength(1);
  });

  test("Request changes carries what they asked to change", () => {
    summary("Request changes");
    const r = answer("Request changes: rename the handler");
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain("rename the handler");
  });

  // The protocol's quoting rule, through a real shell: single quotes keep a
  // backtick, a $(...), and a single quote (written '\'') exactly as typed.
  test.skipIf(process.platform === "win32")("single-quoted words reach the engine as typed, and nothing in them runs", () => {
    summary("Request changes");
    const words = "rename `foo` to $(touch pwned), and don't keep $HOME";
    const quoted = `'${`Request changes: ${words}`.replace(/'/g, "'\\''")}'`;
    const command = [
      `"${BUN}"`, `"${LOG}"`, "answer", "--stage", slug, "--checkpoint", "summary-confirmation",
      "--questions-file", `"${questions}"`, "--details", quoted, "--project-dir", `"${proj}"`,
    ].join(" ");
    const env: Record<string, string | undefined> = {
      ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: SESSION,
    };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
    const r = spawnSync("/bin/sh", ["-c", command], {
      cwd: proj, env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(existsSync(join(proj, "pwned"))).toBe(false);
    const recorded = events(proj, "SUMMARY_CONFIRMATION_RECORDED");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].block).toContain(words);
  });

  test("--details that names no choice is refused without reading meaning into it", () => {
    summary("Looks correct");
    const r = answer("yep, that's right");
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("does not name a choice");
  });
});

describe("a protected checkpoint question keeps the person's reply", () => {
  const session = "own-words";
  const target = { commandSha256: "a".repeat(64) };
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-construction.md");
    mintProtectedQuestion(proj, { kind: "verification-command", session, target });
  });
  afterEach(() => cleanupTestProject(proj));

  const require = (choice: "Approve" | "Request Changes") => requireProtectedResponse(proj, session, {
    kind: "verification-command", targetDigest: protectedTargetDigest(target), choice,
  });

  test("any reply is kept verbatim, with no choice read into it", () => {
    expect(recordProtectedHumanResponse(proj, session, "looks fine but use the full suite", null).recorded).toBe(true);
    const response = readProtectedResponse(proj, session);
    expect(response?.choice).toBeUndefined();
    expect(response?.words).toBe("looks fine but use the full suite");
    expect(readProtectedQuestion(proj, session)?.replied).toBe(true);
    expect(() => require("Approve")).not.toThrow();
  });

  test("a question then an answer: both kept, in order, and the latest decides", () => {
    recordProtectedHumanResponse(proj, session, "what does this command run?", null);
    recordProtectedHumanResponse(proj, session, "ok, approve it", null);
    expect(readProtectedResponse(proj, session)?.words).toBe("what does this command run?\nok, approve it");
    expect(() => require("Approve")).not.toThrow();
  });

  test.each(["2", "Request Changes", "request changes."])("an exact pick (%s) is theirs: the other choice is refused", (reply) => {
    recordProtectedHumanResponse(proj, session, reply, null);
    expect(readProtectedResponse(proj, session)?.choice).toBe("Request Changes");
    expect(() => require("Approve")).toThrow(/picked "Request Changes"/);
    expect(() => require("Request Changes")).not.toThrow();
  });

  test("nothing is recorded without a reply", () => {
    expect(() => require("Approve")).toThrow(/requires the person's reply/);
    expect(recordProtectedHumanResponse(proj, session, "Cancelled", null).recorded).toBe(false);
  });

  test("a long run of replies keeps the latest words, bounded", () => {
    const long = "x".repeat(PROTECTED_RESPONSE_WORDS_MAX_CHARS);
    recordProtectedHumanResponse(proj, session, "first", null);
    recordProtectedHumanResponse(proj, session, long, null);
    const words = readProtectedResponse(proj, session)?.words ?? "";
    expect(words.length).toBe(PROTECTED_RESPONSE_WORDS_MAX_CHARS);
    expect(words.endsWith("x")).toBe(true);
  });
});

describe("which question is open is syntax too", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
  });
  afterEach(() => cleanupTestProject(proj));

  test("a recorded question is open until it is answered", () => {
    const stage = "feasibility";
    expect(openDecisionBlock(proj, stage)).toBeNull();
    appendAuditEntry("DECISION_RECORDED", { Stage: stage, Decision: "Which login provider?", Options: "Cognito,Auth0" }, proj);
    expect(openDecisionBlock(proj, stage)).toContain("Which login provider?");
    appendAuditEntry("QUESTION_ANSWERED", { Stage: stage, Details: "Cognito" }, proj);
    expect(openDecisionBlock(proj, stage)).toBeNull();
  });
});

describe("a recovery question: exact picks are recorded, everything else is the agent's to read", () => {
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
  const response = () => (JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine/active-directive.json"), "utf-8")) as {
    guard_recovery_response?: { selected_op?: string | null; status?: string; picked_by?: string };
  }).guard_recovery_response;

  test.each([
    ["1", "reconfirm-summary"],
    ["a", "reconfirm-summary"],
    ["Present the current summary again", "reconfirm-summary"],
    ["b.", "request-changes"],
    ["2", "request-changes"],
  ])("%s is the person's exact pick of %s", (reply, op) => {
    ask();
    expect(consumeSharedDirectiveAsk(proj, reply)).toBe(true);
    expect(response()).toMatchObject({ selected_op: op, picked_by: "person" });
  });

  test.each(["the first one", "Presnt the current summary again", "go with 2", "split the flow into two steps"])(
    "%s waits for the agent's reading",
    (reply) => {
      ask();
      expect(consumeSharedDirectiveAsk(proj, reply)).toBe(true);
      expect(response()?.selected_op ?? null).toBeNull();
    },
  );

  test("Request Changes with what to change, read by the agent, is ready and bound to their words", () => {
    ask();
    consumeSharedDirectiveAsk(proj, "split the save-search flow into two steps");
    const picked = recordGuardRecoveryChoice(proj, "Request Changes: split the save-search flow into two steps", true);
    expect(picked).toMatchObject({ op: "request-changes", awaitingWords: false });
    expect(response()).toMatchObject({ selected_op: "request-changes", status: "ready", picked_by: "conductor" });
    expect(guardRecoveryFeedbackStatus(proj, readFileSync(seededStateFile(proj), "utf-8"), "functional-design", undefined,
      "split the save-search flow into two steps")).toBe("match");
  });

  test("the agent cannot overrule an exact pick", () => {
    ask();
    consumeSharedDirectiveAsk(proj, "2");
    expect(() => recordGuardRecoveryChoice(proj, "Present the current summary again", false))
      .toThrow(/picked "Ask what should change"/);
  });

  test("the agent can correct its own misread in one step", () => {
    ask();
    consumeSharedDirectiveAsk(proj, "show me that again");
    recordGuardRecoveryChoice(proj, "request changes", false);
    consumeSharedDirectiveAsk(proj, "no, I meant show me the summary again");
    expect(recordGuardRecoveryChoice(proj, "Present the current summary again", false).op).toBe("reconfirm-summary");
    expect(response()).toMatchObject({ selected_op: "reconfirm-summary", picked_by: "conductor" });
  });

  test("nothing is picked before the person replies", () => {
    ask();
    expect(() => recordGuardRecoveryChoice(proj, "Present the current summary again", false))
      .toThrow(/has not replied/);
  });
});
