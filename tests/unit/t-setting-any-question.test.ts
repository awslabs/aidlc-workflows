// covers: function:proveMessage, function:requestMessages, subcommand:aidlc-utility:config-change, audit:CEREMONY_SET
// covers: audit:CONSTRUCTION_POLICY_RECORDED, audit:SUMMARY_CONFIRMATION_RECORDED, audit:PLAN_APPROVAL_RECORDED, audit:GATE_REJECTED
//
// "approve, and turn plan approval off for the rest of this work" answering any
// question, recorded as the answer first and then the setter on that same
// message, is recorded: the agent is still carrying out the reply that gave the
// answer. Live Claude Code, Copilot CLI, Kiro CLI and opencode runs answered the
// Construction policy question or the summary question first and met "Cannot
// record this setting on that message", and the person was told to send it
// again; at the code plan question Kiro CLI ran the plan answer and the setter
// at once, and the setter read the record while the answer was still being
// written. An earlier reply still stands for no setting once the person has
// said more, a guard has refused the agent or the next question is up
// (t-setting-spent-message, t-setting-rides-approval). Each case runs under
// Guard Policy off and strict, on the answers corpus's own fixtures.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AnswersItem, env, exec, next, projectAt, recordByAgent, SESSION, say, templateProjects,
} from "../harness/aidlc-answers-corpus.ts";
import { AIDLC_SRC, cleanupTestProject, recordArtifactWriteViaHook, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  auditBlockField, formatGuardPolicy, getField, readAuditShardEvents, setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const ASKED = "approve, and turn plan approval off for the rest of this work";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});
afterAll(() => {
  for (const template of templateProjects()) cleanupTestProject(template);
});

type Question = "construction-policy" | "summary-confirmation" | "code-plan" | "stage-gate" | "batch-checkpoint";

async function at(question: Question, policy: "off" | "strict"): Promise<string> {
  const proj = await projectAt(question);
  created.push(proj);
  const statePath = seededStateFile(proj);
  writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), formatGuardPolicy(policy, "you")));
  // The plan question shown in this chat, as `next` shows it when the person comes back to it.
  if (question === "code-plan") expect((await next(proj, [])).directive?.ask_type).toBe("plan-approval");
  return proj;
}

// The person types `words` in the fixture's chat; the shipped human-turn hook keeps it.
async function said(proj: string, words: string): Promise<string> {
  const before = new Set(listMessages(proj).map((message) => message.id));
  const turn = await say(proj, words, "claude");
  expect(turn.status, turn.stderr).toBe(0);
  const kept = listMessages(proj).filter((message) => !before.has(message.id));
  expect(kept).toHaveLength(1);
  // The engine's times are to the second: the answer after it lands in a later one.
  Bun.sleepSync(1100);
  return kept[0].id;
}

// The agent records the choice it read, as the question's own step names it.
async function answered(proj: string, question: Question, input: string, choice: string, event: string): Promise<void> {
  const item = { question, input, expected: { end: {} } } as unknown as AnswersItem;
  const recorded = await recordByAgent(proj, item, choice);
  expect(recorded?.exec.status, `${recorded?.exec.stdout}${recorded?.exec.stderr}`).toBe(0);
  expect(recorded?.event).toBe(event);
}

const setter = (proj: string, args: string[]) =>
  exec([process.execPath, DISPATCHER, "engine", "config", "set", ...args, "--project-dir", proj], { cwd: proj, env: env(proj) });
const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const stateField = (proj: string, name: string) => getField(readFileSync(seededStateFile(proj), "utf-8"), name);

function theirs(proj: string, asked: string, words: string, key = "Plan Approval"): void {
  expect(stateField(proj, key)).toBe("off (set by you)");
  const set = rows(proj, "CEREMONY_SET").at(-1);
  expect(set === undefined ? null : auditBlockField(set.block, "Message Id")).toBe(asked);
  expect(set === undefined ? null : auditBlockField(set.block, "Person Reply")).toBe(words);
}

describe.each(["off", "strict"] as const)("Guard Policy %s: a setting asked beside any answer, run after it on that message", (policy) => {
  test("the Construction policy question: the yes recorded first, then plan approval off on it, theirs", async () => {
    const proj = await at("construction-policy", policy);
    const asked = await said(proj, ASKED);
    await answered(proj, "construction-policy", ASKED, "Approve", "CONSTRUCTION_POLICY_RECORDED");
    const off = await setter(proj, ["plan-approval", "off", "--message", asked]);
    expect(off.status, `${off.stdout}${off.stderr}`).toBe(0);
    theirs(proj, asked, ASKED);
    // The yes's own setters still carry it out on that message.
    for (const args of [["set-construction-iteration", "stage-major"], ["set-construction-execution", "swarm"]]) {
      const ran = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-state.ts"), ...args, "--message", asked,
        "--project-dir", proj], { cwd: proj, env: env(proj) });
      expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    }
    expect(stateField(proj, "Construction Execution")).toBe("swarm");
  });

  test("the summary question: looks correct recorded first, then plan approval off on it, theirs", async () => {
    const proj = await at("summary-confirmation", policy);
    const asked = await said(proj, ASKED);
    await answered(proj, "summary-confirmation", ASKED, "Looks correct", "SUMMARY_CONFIRMATION_RECORDED");
    const off = await setter(proj, ["plan-approval", "off", "--message", asked]);
    expect(off.status, `${off.stdout}${off.stderr}`).toBe(0);
    theirs(proj, asked, ASKED);
  });

  test("the summary question: a made-up id first, and the refusal names the message that asked", async () => {
    const proj = await at("summary-confirmation", policy);
    const asked = await said(proj, ASKED);
    await answered(proj, "summary-confirmation", ASKED, "Looks correct", "SUMMARY_CONFIRMATION_RECORDED");
    const wrong = await setter(proj, ["plan-approval", "off", "--message", "msg-user-approve"]);
    expect(wrong.status).not.toBe(0);
    expect(`${wrong.stdout}${wrong.stderr}`).toContain(`If their message ${asked} (sent `);
    const off = await setter(proj, ["plan-approval", "off", "--message", asked]);
    expect(off.status, `${off.stdout}${off.stderr}`).toBe(0);
    theirs(proj, asked, ASKED);
  });

  test("the code plan question: the plan answer first, then plan approval off on it, theirs", async () => {
    const proj = await at("code-plan", policy);
    const asked = await said(proj, ASKED);
    await answered(proj, "code-plan", ASKED, "Approve Plan", "PLAN_APPROVAL_RECORDED");
    const off = await setter(proj, ["plan-approval", "off", "--message", asked]);
    expect(off.status, `${off.stdout}${off.stderr}`).toBe(0);
    theirs(proj, asked, ASKED);
  });

  // Kiro CLI on Linux and Windows Server ran the plan answer and the setter at
  // once: the setter read the record with the answer's row written and the
  // question's own record not yet, so the question still read as waiting.
  test("the code plan question: the setter run beside the plan answer, reading it half written, theirs", async () => {
    const proj = await at("code-plan", policy);
    const asked = await said(proj, ASKED);
    const ask = join(proj, "aidlc", ".aidlc-sessions", "plan-approval");
    const files = (): string[] => [...new Bun.Glob("ask-*.json").scanSync(ask)];
    expect(files()).toHaveLength(1);
    const waiting = readFileSync(join(ask, files()[0]), "utf-8");
    await answered(proj, "code-plan", ASKED, "Approve Plan", "PLAN_APPROVAL_RECORDED");
    const done = readFileSync(join(ask, files()[0]), "utf-8");
    writeFileSync(join(ask, files()[0]), waiting, "utf-8");
    const off = await setter(proj, ["plan-approval", "off", "--message", asked]);
    writeFileSync(join(ask, files()[0]), done, "utf-8");
    expect(off.status, `${off.stdout}${off.stderr}`).toBe(0);
    theirs(proj, asked, ASKED);
    expect((await next(proj, [])).directive?.ask_type).not.toBe("plan-approval");
  });

  // Request changes with nothing said about what: the answer asks "What
  // should change?" itself, and that question is part of the same answer.
  test("the summary question: a bare Request changes recorded first, then plan approval off on it, theirs", async () => {
    const proj = await at("summary-confirmation", policy);
    const words = "request changes, and turn plan approval off for the rest of this work";
    const asked = await said(proj, words);
    const file = join(seededRecordDir(proj), "inception", "requirements-analysis", "requirements-analysis-questions.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace(/\[Answer\]: \n$/, "[Answer]: Request changes\n"), "utf-8");
    recordArtifactWriteViaHook(proj, file, "Edit");
    const recorded = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--checkpoint",
      "summary-confirmation", "--stage", "requirements-analysis", "--questions-file", file, "--details", "Request changes",
      "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
    expect(rows(proj, "DECISION_RECORDED").at(-1)?.block).toContain("What should change?");
    const off = await setter(proj, ["plan-approval", "off", "--message", asked]);
    expect(off.status, `${off.stdout}${off.stderr}`).toBe(0);
    theirs(proj, asked, words);
  });

  // One Request Changes for a batch of Units writes one row per Unit.
  test("a batch checkpoint's Request Changes recorded first, then plan approval off on it, theirs", async () => {
    const proj = await at("batch-checkpoint", policy);
    const words = "request changes: log each failed save, and turn plan approval off for the rest of this work";
    const asked = await said(proj, words);
    await answered(proj, "batch-checkpoint", words, "Request Changes", "GATE_REJECTED");
    expect(rows(proj, "GATE_REJECTED").length).toBeGreaterThan(1);
    const off = await setter(proj, ["plan-approval", "off", "--message", asked]);
    expect(off.status, `${off.stdout}${off.stderr}`).toBe(0);
    theirs(proj, asked, words);
  });

  test("a stage gate's Request Changes recorded first, then learnings off on it, theirs", async () => {
    const proj = await at("stage-gate", policy);
    const words = "request changes: add the export story, and turn learnings off";
    const asked = await said(proj, words);
    await answered(proj, "stage-gate", words, "Request Changes", "GATE_REJECTED");
    const off = await setter(proj, ["learnings", "off", "--message", asked]);
    expect(off.status, `${off.stdout}${off.stderr}`).toBe(0);
    theirs(proj, asked, words, "Learnings");
  });

  test("once the next question is asked, the yes to the one before stands for no setting", async () => {
    const proj = await at("construction-policy", policy);
    const asked = await said(proj, "that's right");
    await answered(proj, "construction-policy", "that's right", "Approve", "CONSTRUCTION_POLICY_RECORDED");
    const log = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-log.ts"), "decision", "--stage", "functional-design",
      "--decision", "How would you like to answer the questions?", "--options", "Guide me,I'll edit the file,Chat",
      "--session", SESSION, "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(log.status, `${log.stdout}${log.stderr}`).toBe(0);
    const off = await setter(proj, ["summary-confirmation", "off", "--message", asked]);
    expect(off.status).not.toBe(0);
    expect(`${off.stdout}${off.stderr}`).not.toContain(asked);
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
  });
});
