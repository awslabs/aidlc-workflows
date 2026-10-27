// covers: function:proveMessage, function:requestMessages, function:settingsBesideDecision, cli:aidlc-orchestrate(report)
// covers: subcommand:aidlc-utility:config-change, audit:CEREMONY_SET, audit:GATE_APPROVED
//
// A message of the person's that already backed an approval or another decision
// does not also stand for a setting (Arden's rule for every setting change). Live
// Copilot CLI runs turned learnings off on the person's "Approve" for the stage
// before, and the summary confirmation off on the "that's right" that answered
// another question, recorded as theirs. Such a message is refused with nothing
// named and no refusal offers it; the step is the same command with no message
// (a setting that turns nothing off is then the command's), or, for a check, that
// it stays on. Their own request still goes through at once: a message that
// backed nothing, a later message, the setting run before the approval, or the
// setting riding the approval itself ("approve, and turn learnings off" as one
// report, written before the approval in the same command). Answers, a routing
// answer and a question box closed with nothing picked are no decision it backed.
// The reply's own decision is the exception: a setter run on it right after the
// answer, before the person says anything else, a guard turns the agent back or
// the next question is asked, is that reply's setting (t-setting-rides-approval,
// t-setting-any-question). The cases here that reuse the message do it after a
// guard refused the agent or the next question was asked, as in the live runs.
// Each case runs under Guard Policy off and strict: the rule is the proof's, not a
// guard the policy lowers.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField, formatGuardPolicy, getField, readAuditShardEvents, setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seededStateFile, seedStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const CHAT = "01995000-7a11-7000-8000-000000000081";
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0", AIDLC_DISABLE_COLLABORATORS: "0",
  AIDLC_DISABLE_SENSORS: "0", AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "0", AIDLC_DISABLE_STATE_TRANSITION_GUARD: "0",
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0", AIDLC_DISABLE_LEARNINGS: "0", AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
};
// A stage gate's own checks this file does not test (its documents, its summary) stand aside.
const GATE_ENV = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};
const POLICIES: Array<"off" | "strict"> = ["off", "strict"];

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

// The engine's times are to the second, and a row in the same second as a
// message is no decision after it: the next row waits for the next second.
const tick = () => Bun.sleepSync(1100);

function run(proj: string, args: string[], extra: Record<string, string> = {}, input?: string) {
  const r = spawnSync(BUN, args, {
    cwd: proj,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...process.env, ...CLEAR, ...extra, AIDLC_SESSION_OVERRIDE: CHAT, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The person types `prompt` in this chat; the shipped human-turn hook keeps it.
function said(proj: string, prompt: string): string {
  const r = run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"], {},
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CHAT, prompt }));
  expect(r.status, r.out).toBe(0);
  const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1);
  const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
  expect(id).not.toBeNull();
  return id as string;
}

// The agent went on with the work and a guard refused it, as before the live
// Copilot CLI run turned learnings off on the Approve: that reply is over.
const turnedBack = (proj: string) =>
  appendAuditEntry("PLAN_APPROVAL_BLOCKED", { Guard: "plan-approval", Reason: "no approved plan", Tool: "Edit" }, proj);

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const field = (row: { block: string } | undefined, name: string): string | null =>
  row === undefined ? null : auditBlockField(row.block, name);

describe.each(POLICIES)("Guard Policy %s: a message that gave an approval or a decision does not also stand for a setting", (policy) => {
  function project(): string {
    const proj = createTestProject();
    created.push(proj);
    seedStateFile(proj, "state-mid-ideation.md");
    const statePath = seededStateFile(proj);
    writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), formatGuardPolicy(policy, "you")));
    return proj;
  }
  const stateOf = (proj: string) => readFileSync(seededStateFile(proj), "utf-8");
  const setter = (proj: string, args: string[]) => run(proj, [UTILITY, "config-change", ...args, "--project-dir", proj]);
  const openGate = (proj: string): string => {
    const slug = getField(stateOf(proj), "Current Stage") as string;
    for (const args of [["checkbox", `${slug}=in-progress`], ["gate-start", slug]]) {
      const r = run(proj, [STATE, ...args, "--project-dir", proj], GATE_ENV);
      expect(r.status, r.out).toBe(0);
    }
    return slug;
  };
  const approve = (proj: string, slug: string) => {
    const r = run(proj, [STATE, "approve", slug, "--user-input", "Approve", "--project-dir", proj], GATE_ENV);
    expect(r.status, r.out).toBe(0);
  };
  const report = (proj: string, args: string[]) =>
    run(proj, [ORCHESTRATE, "report", ...args, "--project-dir", proj], { AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" });

  test("learnings off on the Approve that approved the stage: refused, naming no message; run with none, it is the command's", () => {
    const proj = project();
    const slug = openGate(proj);
    const id = said(proj, "Approve");
    tick();
    approve(proj, slug);
    turnedBack(proj);
    const before = getField(stateOf(proj), "Learnings");
    const off = setter(proj, ["--learnings", "off", "--message", id]);
    expect(off.status).not.toBe(0);
    expect(off.out).not.toContain(id);
    expect(off.out).toContain("already gave an approval or another decision");
    expect(off.out).toContain("run the same command with no --message");
    expect(getField(stateOf(proj), "Learnings")).toBe(before);
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
    const plain = setter(proj, ["--learnings", "off"]);
    expect(plain.status, plain.out).toBe(0);
    expect(getField(stateOf(proj), "Learnings")).toBe("off (set by a command)");
    const row = rows(proj, "CEREMONY_SET").at(-1);
    expect(field(row, "Person Reply")).toBeNull();
    expect(field(row, "Message Id")).toBeNull();
  });

  test("summary confirmation off after that approval: no refusal offers the Approve, and naming it leaves the check on", () => {
    const proj = project();
    const slug = openGate(proj);
    const id = said(proj, "Approve");
    tick();
    approve(proj, slug);
    turnedBack(proj);
    const before = getField(stateOf(proj), "Summary Confirmation");
    const unnamed = setter(proj, ["--summary-confirmation", "off"]);
    expect(unnamed.status).not.toBe(0);
    expect(unnamed.out).not.toContain(id);
    const named = setter(proj, ["--summary-confirmation", "off", "--message", id]);
    expect(named.status).not.toBe(0);
    expect(named.out).not.toContain(id);
    expect(named.out).toContain("It stays on; go on with the open step.");
    expect(named.out).not.toContain("because you said");
    expect(getField(stateOf(proj), "Summary Confirmation")).toBe(before);
  });

  // The live Copilot CLI run: the yes recorded, then the next questions asked
  // (each Unit's summary), then the summary confirmation off on the yes.
  test("summary confirmation off on the yes that answered a Construction policy question, once the next question is asked: refused", () => {
    const proj = project();
    const id = said(proj, "that's right");
    tick();
    appendAuditEntry("CONSTRUCTION_POLICY_RECORDED", {
      Stage: "code-generation", Checkpoint: "Construction Policy", Field: "Construction Execution", Value: "swarm",
      "User Input": "Approve", Session: CHAT, "Message Id": id,
    }, proj);
    tick();
    for (const unit of ["alpha", "beta"]) {
      appendAuditEntry("DECISION_RECORDED", { Stage: "code-generation", Unit: unit, Decision: "Does this all look correct?" }, proj);
    }
    const before = getField(stateOf(proj), "Summary Confirmation");
    const off = setter(proj, ["--summary-confirmation", "off", "--message", id]);
    expect(off.status).not.toBe(0);
    expect(off.out).not.toContain(id);
    expect(getField(stateOf(proj), "Summary Confirmation")).toBe(before);
  });

  test("approve, and turn learnings off, as one report: the setting is theirs, written before the approval, which still stands", () => {
    const proj = project();
    const slug = openGate(proj);
    const id = said(proj, "approve, and turn learnings off");
    tick();
    const done = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve", "--learnings", "off"]);
    expect(done.status, done.out).toBe(0);
    expect(rows(proj, "GATE_APPROVED"), done.out).toHaveLength(1);
    expect(field(rows(proj, "GATE_APPROVED")[0], "Message Id")).toBe(id);
    expect(getField(stateOf(proj), "Learnings")).toBe("off (set by you)");
    const set = rows(proj, "CEREMONY_SET").at(-1);
    expect(field(set, "Message Id")).toBe(id);
    expect(field(set, "Person Reply")).toBe("approve, and turn learnings off");
    const order = readAuditShardEvents(proj).map((row) => row.event);
    expect(order.lastIndexOf("CEREMONY_SET")).toBeLessThan(order.lastIndexOf("GATE_APPROVED"));
    expect(done.out).toContain("Learnings changed");
  });

  test("approve, and turn summary confirmation off, as one report naming the message: the check goes off as theirs", () => {
    const proj = project();
    const slug = openGate(proj);
    const id = said(proj, "approve, and stop reading my words back to me");
    tick();
    const done = report(proj, [
      "--stage", slug, "--result", "approved", "--user-input", "Approve", "--summary-confirmation", "off", "--message", id,
    ]);
    expect(done.status, done.out).toBe(0);
    expect(rows(proj, "GATE_APPROVED")).toHaveLength(1);
    expect(field(rows(proj, "CEREMONY_SET").at(-1), "Message Id")).toBe(id);
    expect(getField(stateOf(proj), "Summary Confirmation")).toContain("off");
  });

  // Several replies since the last decision and no message named: the setting
  // would carry the words of whichever came last, so the agent names the one that asked.
  // The agent reads it as it shows the gate, before the person replies.
  test("the step that opens the gate says a setting asked beside the approval rides the approval report", () => {
    const proj = project();
    const slug = getField(stateOf(proj), "Current Stage") as string;
    const started = run(proj, [STATE, "checkbox", `${slug}=in-progress`, "--project-dir", proj], GATE_ENV);
    expect(started.status, started.out).toBe(0);
    const opened = report(proj, ["--stage", slug, "--result", "awaiting-approval"]);
    expect(opened.status, opened.out).toBe(0);
    expect(opened.out).toContain("add that setting's `config set` flag to the approval report");
    expect(opened.out).toContain("--plan-approval off");
  });

  test("two replies and no message named: the report names both and records nothing; naming the one that asked, both stand", () => {
    const proj = project();
    const slug = openGate(proj);
    const asked = said(proj, "approve, and turn learnings off");
    const other = said(proj, "also use the blue theme");
    tick();
    const unnamed = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve", "--learnings", "off"]);
    expect(unnamed.out).toContain(asked);
    expect(unnamed.out).toContain(other);
    expect(rows(proj, "GATE_APPROVED")).toHaveLength(0);
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
    const named = report(proj, [
      "--stage", slug, "--result", "approved", "--user-input", "Approve", "--learnings", "off", "--message", asked,
    ]);
    expect(named.status, named.out).toBe(0);
    expect(field(rows(proj, "CEREMONY_SET").at(-1), "Person Reply")).toBe("approve, and turn learnings off");
    expect(rows(proj, "GATE_APPROVED")).toHaveLength(1);
  });

  test("a setting flag on a report that approves nothing is refused before anything is recorded", () => {
    const proj = project();
    const slug = openGate(proj);
    said(proj, "request changes: add the export story, and turn learnings off");
    tick();
    const done = report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes", "--learnings", "off"]);
    expect(done.out).toContain("--learnings");
    expect(rows(proj, "GATE_REJECTED")).toHaveLength(0);
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
  });

  test("the setting first, then the approval on the same message: both stand", () => {
    const proj = project();
    const slug = openGate(proj);
    const id = said(proj, "approve, and turn learnings off");
    const off = setter(proj, ["--learnings", "off", "--message", id]);
    expect(off.status, off.out).toBe(0);
    tick();
    approve(proj, slug);
    expect(getField(stateOf(proj), "Learnings")).toBe("off (set by you)");
    expect(field(rows(proj, "GATE_APPROVED").at(-1), "Message Id")).toBe(id);
  });

  test("a message sent after the approval stands, and the refusal for no message offers it and not the Approve", () => {
    const proj = project();
    const slug = openGate(proj);
    const approval = said(proj, "Approve");
    tick();
    approve(proj, slug);
    const asked = said(proj, "please stop reading my words back to me");
    const unnamed = setter(proj, ["--summary-confirmation", "off"]);
    expect(unnamed.status).not.toBe(0);
    expect(unnamed.out).toContain(asked);
    expect(unnamed.out).not.toContain(approval);
    const named = setter(proj, ["--summary-confirmation", "off", "--message", asked]);
    expect(named.status, named.out).toBe(0);
  });

  test("a request that backed nothing still stands after a later message's approval, and after a question box closed with nothing picked", () => {
    const proj = project();
    const slug = openGate(proj);
    const asked = said(proj, "turn learnings off");
    tick();
    appendAuditEntry("QUESTION_UNANSWERED", { Session: CHAT }, proj);
    said(proj, "Approve");
    tick();
    approve(proj, slug);
    const off = setter(proj, ["--learnings", "off", "--message", asked]);
    expect(off.status, off.out).toBe(0);
    expect(getField(stateOf(proj), "Learnings")).toBe("off (set by you)");
  });

  test("the answers a message gave leave it standing for the setting it asked for", () => {
    const proj = project();
    const id = said(proj, "use the recommended answer for every question, finish the stage, do not ask me anything");
    tick();
    appendAuditEntry("QUESTION_ANSWERED", { Stage: "feasibility", Details: "Q1: A", "Message Id": id, Session: CHAT }, proj);
    const off = setter(proj, ["--summary-confirmation", "off", "--learnings", "off", "--message", id]);
    expect(off.status, off.out).toBe(0);
  });
});
