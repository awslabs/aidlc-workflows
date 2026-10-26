// covers: function:planApprovalOffStands, function:proveMessage, function:standingPersonTurn
// covers: function:guardSwitchRefusal, subcommand:aidlc-utility:config-change, audit:CEREMONY_SET
//
// While the code plan question waits for the person, turning plan approval off
// stands only on a message they sent since that question was shown (Arden's
// call): by its place on the record after the question's own boundary, the
// one its answer reads. A plan written whose question is not shown yet waits
// for it too, and no message stands until it is shown. In three live Copilot runs an agent turned plan
// approval off on a message that had approved something else before the plan
// was shown, and the plan was built without the person, recorded as theirs.
// The setter, the recorded plan-approval switch and the plan guard's admission
// of it all read the one check, and so do the refusals that name messages. A person who asked before the plan was shown is asked the plan
// question once, with one line saying why; their reply since then turns it off.
// Before the question, for every other setting and for new work, nothing
// changes; nor does it for a message sent with their edit of the shown plan.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, REPO_ROOT, runOrchestrateNext,
  seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { auditBlockField, getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const CHAT = "01995000-7a11-7000-8000-00000000e6e6";
// The line the person reads when they asked before the plan was shown.
const LINE = "Turning plan approval off needs your word after the plan is shown, so this plan is asked once; say so " +
  "now and it is built without asking.";
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

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function run(proj: string, tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, ...extra };
  // No mark of the shell that runs the suite: the agent's shell is no
  // terminal of the person's own tool, nor a Claude Code session.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|VSCODE_IPC_HOOK$|VSCODE_PID$|TERM_PROGRAM$)/.test(key)) delete env[key];
  }
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
function bugfixAtRequirements(policy: "off" | "strict" = "off", planApproval: "on" | "off" = "on"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  let state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: bugfix")
    .replace(
      "- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy === "off" ? "off (from scope bugfix)" : "strict (set by you)"}\n` +
        `- **Plan Approval**: ${planApproval} (from scope bugfix)\n- **Review Override**: none`,
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
  planWritten(proj);
  expect(next(proj)).toEqual({ kind: "ask", ask_type: "plan-approval" });
}

/** The code plan written, its question not yet asked. */
function planWritten(proj: string): void {
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

// The project switch the setup tool records, run as an installed project runs
// it, with the machine's settings in a home of the test's own.
function install(proj: string): void {
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(proj, ".claude"), { recursive: true });
}

function recordedSwitchOff(proj: string, message: string): { rc: number; out: string } {
  const home = mkdtempSync(join(tmpdir(), "plan-off-after-question-home-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    AIDLC_INSTALL_ROOT: join(home, "machine"), AIDLC_BIN_DIR: join(home, "machine", "bin"),
  };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|CURSOR_|KIRO_|TERM_PROGRAM$|AIDLC_PROJECT_DIR$)/.test(key)) delete env[key];
  }
  const result = spawnSync(BUN, [
    join(proj, ".claude", "tools", "aidlc.ts"), "config", "flags", "--bypass", "AIDLC_DISABLE_PLAN_APPROVAL_GUARD",
    "--local", "--yes", "--message", message,
  ], { cwd: proj, env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  return { rc: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// The plan guard over the agent's shell command while the plan waits: 0 lets it through.
function guardAdmits(proj: string, command: string): number {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: CHAT, cwd: proj, tool_name: "Bash", tool_input: { command },
    }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return result.status ?? -1;
}

const stateField = (proj: string, name: string) => getField(readFileSync(seededStateFile(proj), "utf-8"), name);
const ceremonySets = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "CEREMONY_SET");

describe("while the code plan question waits, plan approval goes off only on a message sent since it was shown", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: an approval given before the plan was shown does not turn it off, and the plan waits`, () => {
      const proj = bugfixAtRequirements(policy);
      const approve = said(proj, "Approve");
      approveRequirements(proj, approve);
      planQuestionShown(proj);
      const refused = planApprovalOff(proj, approve);
      expect(refused.rc, refused.out).not.toBe(0);
      expect(refused.out).toContain(`message ${approve}`);
      expect(refused.out).toContain("plan question");
      expect(refused.out).toContain(LINE);
      expect(stateField(proj, "Plan Approval")).toBe("on (from scope bugfix)");
      expect(ceremonySets(proj)).toHaveLength(0);
      expect(next(proj)).toEqual({ kind: "ask", ask_type: "plan-approval" });
    });
  }

  // The live Copilot run on Windows: the plan written, its question never
  // shown, code writes refused, then plan approval off on the earlier Approve.
  test("the plan written and its question not yet shown: the earlier Approve does not turn it off", () => {
    const proj = bugfixAtRequirements();
    const approve = said(proj, "Approve");
    approveRequirements(proj, approve);
    // The plan step, as `next` gives it; the agent writes the plan and goes on without running next.
    expect(["run-stage", "load-steering"]).toContain(next(proj).kind ?? "");
    planWritten(proj);
    expect(guardAdmits(proj, "echo built > src/app.js")).not.toBe(0);
    const bare = planApprovalOff(proj);
    expect(bare.rc).not.toBe(0);
    expect(bare.out).not.toContain(approve);
    const refused = planApprovalOff(proj, approve);
    expect(refused.rc, refused.out).not.toBe(0);
    expect(refused.out).toContain("plan question");
    expect(refused.out).toContain(LINE);
    expect(stateField(proj, "Plan Approval")).toBe("on (from scope bugfix)");
    expect(ceremonySets(proj)).toHaveLength(0);
    expect(next(proj)).toEqual({ kind: "ask", ask_type: "plan-approval" });
    const reply = said(proj, "skip plan approval for this work");
    const off = planApprovalOff(proj, reply);
    expect(off.rc, off.out).toBe(0);
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
  });

  test("asked before the plan was shown, the person is asked once; their reply since then turns it off", () => {
    const proj = bugfixAtRequirements();
    const both = said(proj, "approve, and turn plan approval off");
    approveRequirements(proj);
    planQuestionShown(proj);
    const refused = planApprovalOff(proj, both);
    expect(refused.rc, refused.out).not.toBe(0);
    expect(refused.out).toContain(LINE);
    // With no message named, the refusal offers no message from before the question.
    const bare = planApprovalOff(proj);
    expect(bare.rc).not.toBe(0);
    expect(bare.out).not.toContain(both);
    const again = said(proj, "yes, turn plan approval off");
    const offered = planApprovalOff(proj);
    expect(offered.out).toContain(`If their message ${again} (sent `);
    const off = planApprovalOff(proj, again);
    expect(off.rc, off.out).toBe(0);
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
    expect(auditBlockField(ceremonySets(proj).at(-1)!.block, "Message Id")).toBe(again);
  });

  test("the recorded plan-approval switch takes the same rule, at the setter and at the plan guard", () => {
    const proj = bugfixAtRequirements();
    install(proj);
    const approve = said(proj, "Approve");
    approveRequirements(proj, approve);
    planQuestionShown(proj);
    const command = `bun .claude/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_PLAN_APPROVAL_GUARD --local --yes --message ${approve}`;
    expect(guardAdmits(proj, command)).not.toBe(0);
    const refused = recordedSwitchOff(proj, approve);
    expect(refused.rc, refused.out).not.toBe(0);
    expect(refused.out).toContain(LINE);
    const reply = said(proj, "turn the plan approval check off for this project");
    expect(guardAdmits(proj, command.replace(approve, reply))).toBe(0);
  });
});

describe("before the plan question, and for every other setting, as before", () => {
  // The setting goes first (a message that already gave an approval does not
  // also stand for a setting, t-setting-spent-message), then the approval.
  test("approve, and turn plan approval off, carried out before the plan is shown: off, set by them", () => {
    const proj = bugfixAtRequirements();
    const both = said(proj, "approve, and turn plan approval off");
    const off = planApprovalOff(proj, both);
    expect(off.rc, off.out).toBe(0);
    approveRequirements(proj);
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
  });

  test("said with their own edit of the shown plan: recording the edit first, it goes off on that message", () => {
    const proj = bugfixAtRequirements();
    approveRequirements(proj, said(proj, "Approve"));
    planQuestionShown(proj);
    const both = said(proj, "I'll edit the files, and turn plan approval off");
    const edit = run(proj, LOG, ["answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "I'll edit the files"]);
    expect(edit.out).toContain("Recorded");
    const off = planApprovalOff(proj, both);
    expect(off.rc, off.out).toBe(0);
    expect(off.out).not.toContain(LINE);
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
  });

  test("new work created with plan approval off is not this rule's, while another work's plan question waits", () => {
    const proj = bugfixAtRequirements();
    const earlier = said(proj, "Approve, and start the export work with plan approval off");
    approveRequirements(proj);
    planQuestionShown(proj);
    const made = run(proj, UTILITY, [
      "intent-create", "--scope", "bugfix", "--arguments", "build the export", "--label", "export",
      "--plan-approval", "off", "--message", earlier,
    ]);
    expect(made.rc, made.out).toBe(0);
    expect(made.out).not.toContain(LINE);
  });

  // As on poc and express, which ship plan approval off: the written plan is built, not asked about.
  test("plan approval already off from the scope: the written plan is not waiting, and saying so goes through", () => {
    const proj = bugfixAtRequirements("off", "off");
    approveRequirements(proj, said(proj, "Approve"));
    expect(["run-stage", "load-steering"]).toContain(next(proj).kind ?? "");
    planWritten(proj);
    // A message after the written plan: nothing waits, so it stands (one that
    // gave the approval would not, for any setting).
    const asked = said(proj, "and keep plan approval off for good");
    const off = planApprovalOff(proj, asked);
    expect(off.rc, off.out).toBe(0);
    expect(off.out).not.toContain(LINE);
  });

  // Every other setting takes the rule for every setting (t-setting-spent-message):
  // the message gave an approval, so it does not also stand for one, and the
  // step is the setter with no message, which carries it out as a command's.
  test("another setting on the earlier message is the rule for every setting's, not this one's", () => {
    const proj = bugfixAtRequirements();
    const both = said(proj, "approve, and turn sensors off");
    approveRequirements(proj);
    planQuestionShown(proj);
    const set = run(proj, DISPATCHER, ["engine", "config", "set", "sensors", "off", "--message", both]);
    expect(set.rc).not.toBe(0);
    expect(set.out).toContain("run the same command with no --message");
    expect(set.out).not.toContain(LINE);
    const plain = run(proj, DISPATCHER, ["engine", "config", "set", "sensors", "off"]);
    expect(plain.rc, plain.out).toBe(0);
  });

  test("turning plan approval back on needs nobody's word, as before", () => {
    const proj = bugfixAtRequirements();
    approveRequirements(proj, said(proj, "Approve"));
    planQuestionShown(proj);
    const on = run(proj, DISPATCHER, ["engine", "config", "set", "guard.plan-approval", "on"]);
    expect(on.rc, on.out).toBe(0);
  });
});
