// covers: function:requestMessages, function:requestMessageStep, function:planQuestionShownAt
// covers: subcommand:aidlc-utility:config-change, audit:CEREMONY_SET
//
// A refused setting leads with the person's messages it can stand on, so an
// agent that never sees a message id (Copilot CLI, Cursor, opencode, Kiro IDE)
// can name the one that asked. While the code plan question waits for the
// person, a message of theirs from before it that a decision has followed is
// not offered: a live Copilot run took their "Approve" for Requirements
// Analysis from that offer and turned plan approval off, set by them, with the
// plan question unanswered. A message that already gave an approval is offered
// for a setting only while that approval's reply is in hand
// (t-setting-rides-approval; later, for none, t-setting-spent-message), so
// "approve, and turn plan approval off" is offered before the plan question,
// the setting run first or after the approval; so is a reply sent since the
// question was shown, or a message no decision has followed. The refusal, its next step and the plan
// question are as they were; the tool reads no words.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, runOrchestrateNext, seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { auditBlockField, getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const POSTURE = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
const CHAT = "01995000-7a11-7000-8000-00000000d5d5";
// The runner's fixture profile carries a presence bypass that would let a
// command lower a switch; clear it so only the person's message can.
const CLEAR = {
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: CHAT,
  AIDLC_UNATTENDED: "0",
};
// Only the gate's own setup: the stage's files and review are not what is tested.
const GATE_SETUP = { AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
// A message keeps whole seconds: a decision in its own second does not follow it.
const tick = () => Bun.sleepSync(1100);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function run(proj: string, tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, ...extra };
  // The agent's shell is no terminal of the person's own tool.
  delete env.VSCODE_IPC_HOOK;
  delete env.VSCODE_PID;
  delete env.TERM_PROGRAM;
  const result = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    cwd: proj,
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { rc: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// The person types `prompt` in this chat; the shipped human-turn hook keeps it.
function said(proj: string, prompt: string): string {
  const before = new Set(listMessages(proj).map((message) => message.id));
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CHAT, prompt }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  const kept = listMessages(proj).filter((message) => !before.has(message.id));
  expect(kept).toHaveLength(1);
  return kept[0].id;
}

/** Bugfix work at the Requirements Analysis gate: Guard Policy off and plan approval on, from the scope. */
function bugfixAtRequirements(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  let state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: bugfix")
    .replace(
      "- **Change Control**: strict (from scope feature)",
      "- **Guard Policy**: off (from scope bugfix)\n- **Plan Approval**: on (from scope bugfix)\n- **Review Override**: none",
    );
  // Requirements Analysis goes straight to Code Generation, as on bugfix.
  for (const slug of [
    "user-stories", "refined-mockups", "domain-design", "units-generation", "contract-design", "delivery-planning",
    "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
  ]) {
    state = state.replace(new RegExp(`(- \\[ \\] ${slug} \\S+) EXECUTE`), "$1 SKIP");
  }
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "app.js"), "console.log('hello');\n", "utf-8");
  expect(run(proj, STATE, ["gate-start", "requirements-analysis"], GATE_SETUP).rc).toBe(0);
  return proj;
}

function approveRequirements(proj: string, message?: string): void {
  const named = message === undefined ? [] : ["--message", message];
  const approved = run(proj, STATE, ["approve", "requirements-analysis", "--user-input", "Approve", ...named], GATE_SETUP);
  expect(approved.rc, approved.out).toBe(0);
  expect(stateField(proj, "Current Stage")).toBe("code-generation");
}

/** The code plan written and the plan question put to the person. */
function planQuestionShown(proj: string): void {
  const dir = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: greet the person by name\n- Touches: src/app.js\n" +
      "- Tests: 1 unit test\n\n## Steps\n\n- [ ] Step 1: greet by name\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `npm test`.\n", "utf-8");
  expect(next(proj)).toEqual({ kind: "ask", ask_type: "plan-approval" });
}

function next(proj: string): { kind?: string; ask_type?: string } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: { ...process.env, ...CLEAR } });
  expect(result.status, result.out).toBe(0);
  const directive = result.directive as { kind?: string; ask_type?: string } | null;
  return { kind: directive?.kind, ask_type: directive?.ask_type };
}

function planApprovalOff(proj: string, message?: string): { rc: number; out: string } {
  const named = message === undefined ? [] : ["--message", message];
  return run(proj, DISPATCHER, ["engine", "config", "set", "guard.plan-approval", "off", ...named]);
}

const stateField = (proj: string, name: string) => getField(readFileSync(seededStateFile(proj), "utf-8"), name);

function lastCeremonySet(proj: string): string {
  const row = readAuditShardEvents(proj).filter((entry) => entry.event === "CEREMONY_SET").at(-1);
  expect(row).toBeDefined();
  return row!.block;
}

describe("while the code plan question waits, the message an earlier approval was given in is not offered", () => {
  test("the agent that turns plan approval off on its own is not handed their 'Approve', and the question stays", () => {
    const proj = bugfixAtRequirements();
    const approve = said(proj, "Approve");
    tick();
    approveRequirements(proj, approve);
    planQuestionShown(proj);
    // The agent answers the plan question itself: refused, as before.
    const answered = run(proj, LOG, [
      "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--stage-level", "--details", "Approve Plan",
    ]);
    expect(answered.rc).not.toBe(0);
    for (const named of [undefined, "noninteractive-resume"]) {
      const refused = planApprovalOff(proj, named);
      expect(refused.rc, refused.out).not.toBe(0);
      expect(refused.out).not.toContain(approve);
      expect(refused.out).not.toContain("If their message");
    }
    expect(planApprovalOff(proj).out).toContain("so it is their call");
    expect(stateField(proj, "Plan Approval")).toBe("on (from scope bugfix)");
    expect(readAuditShardEvents(proj).some((entry) => entry.event === "CEREMONY_SET")).toBe(false);
    expect(next(proj)).toEqual({ kind: "ask", ask_type: "plan-approval" });
  });

  test("a reply sent since the question was shown is offered, and turns it off as theirs", () => {
    const proj = bugfixAtRequirements();
    const approve = said(proj, "Approve");
    tick();
    approveRequirements(proj, approve);
    planQuestionShown(proj);
    const skip = said(proj, "skip plan approval for this work");
    const refused = planApprovalOff(proj);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain(`If their message ${skip} (sent `);
    expect(refused.out).not.toContain(approve);
    const off = planApprovalOff(proj, skip);
    expect(off.rc, off.out).toBe(0);
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
    const row = lastCeremonySet(proj);
    expect(auditBlockField(row, "Message Id")).toBe(skip);
    expect(auditBlockField(row, "Person Reply")).toBe("skip plan approval for this work");
  });

  // Plan approval off stands only on a message since the waiting question
  // (Arden's call, planApprovalOffStands), so one from before it is not
  // offered either, decision or none.
  test("a message from before the question that no decision has followed is not offered for plan approval off", () => {
    const proj = bugfixAtRequirements();
    const approve = said(proj, "Approve");
    tick();
    approveRequirements(proj, approve);
    const asked = said(proj, "and build the plan without asking me");
    tick();
    planQuestionShown(proj);
    const refused = planApprovalOff(proj);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).not.toContain(asked);
    expect(refused.out).not.toContain(approve);
    expect(planApprovalOff(proj, asked).rc).not.toBe(0);
    expect(stateField(proj, "Plan Approval")).toBe("on (from scope bugfix)");
  });
});

describe("a request that is not a setting is offered as before while the plan question waits", () => {
  test("going back to the approved plan still names the message an approval was given in", () => {
    const proj = bugfixAtRequirements();
    const approve = said(proj, "Approve");
    tick();
    approveRequirements(proj, approve);
    tick();
    planQuestionShown(proj);
    const refused = run(proj, POSTURE, ["restore", "--stage-level"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain(`If their message ${approve} (sent `);
  });
});

describe("before the plan question, the message an approval is given in is offered for the setting it asks for first", () => {
  test("approve, and turn plan approval off: the setting first, the refusal names their message, then the approval", () => {
    const proj = bugfixAtRequirements();
    const both = said(proj, "approve, and turn plan approval off");
    tick();
    // The agent never saw the id: the refusal names it, and the approval binds their reply by itself.
    const refused = planApprovalOff(proj);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain(`If their message ${both} (sent `);
    const off = planApprovalOff(proj, both);
    expect(off.rc, off.out).toBe(0);
    approveRequirements(proj);
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
    expect(auditBlockField(lastCeremonySet(proj), "Person Reply")).toBe("approve, and turn plan approval off");
  });

  // The setting rides the plan answer itself: written first, on their reply since
  // the plan question was shown, then the plan is approved on that same reply.
  test("approve the plan, and turn plan approval off from here, as one plan answer: off as theirs, and the plan approved", () => {
    const proj = bugfixAtRequirements();
    const approve = said(proj, "Approve");
    tick();
    approveRequirements(proj, approve);
    planQuestionShown(proj);
    const both = said(proj, "approve the plan, and turn plan approval off from here");
    tick();
    const answered = run(proj, LOG, [
      "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
      "--plan-approval", "off",
    ]);
    expect(answered.rc, answered.out).toBe(0);
    expect(answered.out).toContain("Plan Approval changed");
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
    expect(auditBlockField(lastCeremonySet(proj), "Message Id")).toBe(both);
    const plan = readAuditShardEvents(proj).filter((row) => row.event === "PLAN_APPROVAL_RECORDED").at(-1);
    expect(plan, answered.out).toBeDefined();
  });

  // Two replies since the plan question and no message named: the setting would
  // carry the words of whichever came last, so the agent names the one that asked.
  test("two replies since the plan question and no message named: the answer names both and records nothing", () => {
    const proj = bugfixAtRequirements();
    approveRequirements(proj, said(proj, "Approve"));
    planQuestionShown(proj);
    const both = said(proj, "approve the plan, and turn plan approval off from here");
    const other = said(proj, "oh and keep the blue theme");
    tick();
    const unnamed = run(proj, LOG, [
      "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
      "--plan-approval", "off",
    ]);
    expect(unnamed.rc).not.toBe(0);
    expect(unnamed.out).toContain(both);
    expect(unnamed.out).toContain(other);
    expect(stateField(proj, "Plan Approval")).not.toBe("off (set by you)");
    expect(readAuditShardEvents(proj).filter((row) => row.event === "PLAN_APPROVAL_RECORDED")).toHaveLength(0);
    const named = run(proj, LOG, [
      "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
      "--plan-approval", "off", "--message", both,
    ]);
    expect(named.rc, named.out).toBe(0);
    expect(auditBlockField(lastCeremonySet(proj), "Person Reply")).toBe("approve the plan, and turn plan approval off from here");
  });

  // The approval's own reply is still in hand (t-setting-rides-approval).
  test("the approval recorded first: the refusal names their message, and the setting on it is theirs", () => {
    const proj = bugfixAtRequirements();
    const both = said(proj, "approve, and turn plan approval off");
    tick();
    approveRequirements(proj);
    const refused = planApprovalOff(proj);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain(`If their message ${both} (sent `);
    const off = planApprovalOff(proj, both);
    expect(off.rc, off.out).toBe(0);
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
  });
});
