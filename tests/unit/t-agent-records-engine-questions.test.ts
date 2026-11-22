// covers: hook:aidlc-record-human-turn, subcommand:aidlc-log:answer, subcommand:aidlc-bolt:checkpoint
// covers: function:notePlanApprovalAskReply, function:recordProtectedHumanResponse, function:consumeSharedDirectiveAsk
// covers: subcommand:aidlc-orchestrate:next
//
// At the engine's own questions (the code plan, a Unit checkpoint, guard recovery, where new words belong) the agent
// reads the person's typed reply, in any words, against what it showed them, and records the choice through the
// question's own command: no hook or `next` takes a digit, a label or the word "done" as a pick, and a typed reply is
// kept as typed. A pick made in a question box is the host's own structure and is still recorded where it lands.
// Under every Guard Policy.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, seededStateFile } from "../harness/fixtures.ts";
import {
  listIntents,
  readActiveDirectiveMarker,
  readAuditShardEvents,
  readProtectedResponse,
  sessionsDir,
  setGuardPolicyLine,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { openPlanApprovalQuestion } from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";
import { latestQuestion } from "../../dist/claude/.claude/tools/aidlc-question-store.ts";
import { next } from "../harness/aidlc-input-corpus.ts";
import {
  ANSWERS, env, exec, messageRecord, pick, projectAt, say, SESSION, templateProjects,
  type AnswersItem, type Exec, type Question,
} from "../harness/aidlc-answers-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const POLICIES = ["off", "relaxed", "strict"] as const;
type Policy = (typeof POLICIES)[number];

const projects: string[] = [];
afterAll(() => {
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
});

// The fixture under each Guard Policy. The engine's open question is bound to the state it was asked in, so the
// marker, and a routing question's stored copy, are bound again to the state with the policy line set.
async function at(question: Question, policy: Policy): Promise<string> {
  const proj = await projectAt(question);
  projects.push(proj);
  const file = seededStateFile(proj);
  const before = readFileSync(file, "utf-8");
  const marker = readActiveDirectiveMarker(proj, before);
  const after = setGuardPolicyLine(before, `${policy} (set by you)`);
  writeFileSync(file, after);
  if (marker !== null) {
    writeActiveDirectiveMarker(proj, { ...marker, state_sha256: stateDigest(after) } as Parameters<typeof writeActiveDirectiveMarker>[1]);
  }
  const routing = latestQuestion(proj);
  if (routing?.origin === "routing" && routing.stateSha256 === stateDigest(before)) {
    const path = join(sessionsDir(proj), "questions", `${routing.id}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf-8")), stateSha256: stateDigest(after) }));
  }
  return proj;
}

const tool = (proj: string, path: string, args: string[]): Promise<Exec> =>
  exec([process.execPath, path, ...args, "--project-dir", proj], { cwd: proj, env: env(proj) });
const planAnswer = (proj: string, choice: string) =>
  tool(proj, LOG, ["answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", choice]);
const checkpoint = (proj: string, action: "approve" | "reject", userInput: string) =>
  tool(proj, BOLT, ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", action, "--session", SESSION, "--user-input", userInput]);
const recovery = (proj: string, op: string) =>
  tool(proj, LOG, ["answer", "--stage", "requirements-analysis", "--checkpoint", "guard-recovery", "--details", op]);

const count = (proj: string, event: string): number => readAuditShardEvents(proj).filter((row) => row.event === event).length;
const planAnswered = (proj: string): boolean => openPlanApprovalQuestion(proj)?.answered === true;
const recoveryResponse = (proj: string) =>
  readActiveDirectiveMarker(proj, readFileSync(seededStateFile(proj), "utf-8"))?.guard_recovery_response;
const item = (id: string): AnswersItem => {
  const found = ANSWERS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no corpus item ${id}`);
  return found;
};

describe("t-agent-records-engine-questions: the agent records what it read at the engine's own questions", () => {
  for (const policy of POLICIES) {
    test(`${policy}: a typed "1" at the code plan question records nothing at the hook; the agent's record approves it`, async () => {
      const proj = await at("code-plan", policy);
      expect((await say(proj, "1", "claude")).status).toBe(0);
      expect(planAnswered(proj)).toBe(false);
      expect(count(proj, "PLAN_APPROVAL_RECORDED")).toBe(0);
      const recorded = await planAnswer(proj, "Approve Plan");
      expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
      expect(count(proj, "PLAN_APPROVAL_RECORDED")).toBe(1);
      expect(planAnswered(proj)).toBe(true);
    });

    test(`${policy}: after a typed "1", the agent's reading "Request Changes" is recorded as it handed it`, async () => {
      const proj = await at("code-plan", policy);
      expect((await say(proj, "1", "claude")).status).toBe(0);
      const recorded = await planAnswer(proj, "Request Changes");
      expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
      expect(recorded.stdout + recorded.stderr).not.toContain("The person picked");
      expect(count(proj, "PLAN_APPROVAL_RECORDED")).toBe(0);
    });

    test(`${policy}: a pick in the code plan's question box is still recorded at the hook`, async () => {
      const proj = await at("code-plan", policy);
      expect((await pick(proj, item("pq-56-k"), "claude")).status).toBe(0);
      expect(planAnswered(proj)).toBe(true);
    });

    test(`${policy}: a typed "2" at a Unit checkpoint is no pick; the agent's Approve is recorded`, async () => {
      const proj = await at("unit-checkpoint", policy);
      expect((await say(proj, "2", "claude")).status).toBe(0);
      expect(readProtectedResponse(proj, SESSION)?.choice).toBeUndefined();
      expect(readProtectedResponse(proj, SESSION)?.words).toBe("2");
      const approved = await checkpoint(proj, "approve", "2");
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      expect(approved.stdout + approved.stderr).not.toContain("The person picked");
      expect(count(proj, "GATE_APPROVED")).toBe(1);
    });

    test(`${policy}: a pick in the checkpoint's question box is still the person's choice at the hook`, async () => {
      const proj = await at("unit-checkpoint", policy);
      expect((await pick(proj, item("uc-25-k"), "claude")).status).toBe(0);
      expect(readProtectedResponse(proj, SESSION)?.choice).toBe("Approve");
    });

    test(`${policy}: a typed reply that looks like a question box's payload is kept as they typed it`, async () => {
      const proj = await at("unit-checkpoint", policy);
      const typed = '{"answer": "Approve"}';
      expect((await say(proj, typed, "claude")).status).toBe(0);
      expect(readProtectedResponse(proj, SESSION)?.words).toBe(typed);
      expect(readProtectedResponse(proj, SESSION)?.choice).toBeUndefined();
      expect(messageRecord(proj, typed)?.text).toBe(typed);
    });

    test(`${policy}: a typed "1" at a guard-recovery question is no pick; the agent records the remedy it read`, async () => {
      const proj = await at("guard-recovery", policy);
      expect((await say(proj, "1", "claude")).status).toBe(0);
      expect(recoveryResponse(proj)?.selected_op ?? null).toBeNull();
      const recorded = await recovery(proj, "finish-revision");
      expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
      expect(recoveryResponse(proj)?.selected_op).toBe("finish-revision");
    });

    test(`${policy}: with Request Changes the only remedy, a reply about something else is not taken as what should change`, async () => {
      const proj = await at("guard-recovery", policy);
      const state = readFileSync(seededStateFile(proj), "utf-8");
      writeActiveDirectiveMarker(proj, {
        kind: "ask", stage: "requirements-analysis", ask_type: "guard-recovery", state_sha256: stateDigest(state),
        remedies: [{ op: "request-changes", label: "Request Changes", action: "Ask what should change.", interaction: "human-input" }],
      });
      expect((await say(proj, "what does this question mean?", "claude")).status).toBe(0);
      const response = recoveryResponse(proj);
      expect(response?.selected_op ?? null).toBeNull();
      expect(response?.feedback_sha256).toBeUndefined();
    });

    test(`${policy}: a "2" handed to next at the open routing question runs no answer; the command the step names moves on`, async () => {
      const proj = await at("routing", policy);
      const asked = latestQuestion(proj)?.id ?? "";
      const records = listIntents(proj).length;
      expect((await say(proj, "2", "claude")).status).toBe(0);
      const step = await next(proj, ["2"]);
      const message = (step.directive?.kind === "print" ? step.directive.message : "") ?? "";
      expect(message, step.out).toContain("has not answered the question about where their words belong");
      expect(latestQuestion(proj)?.id).toBe(asked);
      expect(listIntents(proj).length).toBe(records);
      const separate = /"Separate new piece of work": `[^`]* next ([^`]*)`/.exec(message)?.[1];
      expect(separate, message).toContain(`--request ${asked}`);
      expect(/"Part of the active work": `[^`]* next --continue --request /.test(message), message).toBe(true);
      const moved = await next(proj, (separate ?? "").split(" "));
      expect(moved.status, moved.out).toBe(0);
      expect(moved.directive?.kind === "ask" ? moved.directive.ask_type : "", moved.out).not.toBe("new-work-routing");
      expect(moved.out).not.toContain("where their words belong");
      // The separate-work answer goes on to start that work, on the question's own request.
      expect(moved.out).toContain(`intent create --scope bugfix --request ${asked}`);
    });
  }
});
