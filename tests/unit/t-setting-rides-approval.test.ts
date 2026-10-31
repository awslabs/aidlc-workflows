// covers: function:proveMessage, function:requestMessages, subcommand:aidlc-utility:config-change
// covers: cli:aidlc-orchestrate(report), audit:CEREMONY_SET, audit:GATE_APPROVED
//
// "approve, and turn plan approval off" at a stage gate, recorded as the
// approval first and then the setter on that same message, is recorded: the
// agent is still carrying out the reply that gave the approval. Live Copilot
// CLI and Kiro CLI runs approved first and then met "Cannot record this setting
// on that message" on every form of the setter, and the person was asked the
// code plan question they had turned off; opencode named a wrong id first and
// was never offered the right one. An earlier Approve still stands for no
// setting (t-setting-spent-message): once the person has sent another message,
// a guard has refused the agent, or the next question is up, the reply is over.
// Each case runs under Guard Policy off and strict.
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
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const CHAT = "01995000-7a11-7000-8000-00000000e7e7";
const ASKED = "approve, and turn plan approval off for the rest of this work";
// The fixture profile's presence bypass would let a command lower a check: only the person's message can here.
const CLEAR = {
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_SESSION_OVERRIDE: CHAT,
  AIDLC_UNATTENDED: "0", AIDLC_DISABLE_LEARNINGS: "0",
};
// Only the gate's own setup: the stage's files, review and summary are not what is tested.
const GATE_SETUP = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function run(proj: string, tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, ...extra };
  // No mark of the shell that runs the suite: the agent's shell is no terminal of the person's own tool.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|VSCODE_IPC_HOOK$|VSCODE_PID$|TERM_PROGRAM$)/.test(key)) delete env[key];
  }
  const result = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    cwd: proj, env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
  // The engine's times are to the second: the approval after it lands in a later one.
  Bun.sleepSync(1100);
  return kept[0].id;
}

/** Bugfix work at the Requirements Analysis gate, plan approval on from the scope. */
function bugfixAtRequirements(policy: "off" | "strict"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  let state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: bugfix")
    .replace(
      "- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy === "off" ? "off (from scope bugfix)" : "strict (set by you)"}\n` +
        "- **Plan Approval**: on (from scope bugfix)\n- **Review Override**: none",
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

// The approval as the live agents recorded it: the gate's report, the choice alone.
function approve(proj: string, message: string): void {
  const done = run(proj, ORCHESTRATE, [
    "report", "--stage", "requirements-analysis", "--result", "approved", "--user-input", "Approve",
  ], GATE_SETUP);
  expect(done.rc, done.out).toBe(0);
  const row = rows(proj, "GATE_APPROVED").at(-1);
  expect(row === undefined ? null : auditBlockField(row.block, "Message Id")).toBe(message);
}

function next(proj: string): { kind?: string; ask_type?: string } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: { ...process.env, ...CLEAR } });
  expect(result.status, result.out).toBe(0);
  const directive = result.directive as { kind?: string; ask_type?: string } | null;
  return { kind: directive?.kind, ask_type: directive?.ask_type };
}

/** The agent writes the code plan the plan step asks for. */
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

// The plan guard over the agent's shell command: 0 lets it through.
function guardAdmits(proj: string, command: string): number {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: CHAT, cwd: proj, tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return result.status ?? -1;
}

const setter = (proj: string, args: string[]) => run(proj, DISPATCHER, ["engine", "config", "set", ...args]);
const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const stateField = (proj: string, name: string) => getField(readFileSync(seededStateFile(proj), "utf-8"), name);

describe.each(["off", "strict"] as const)("Guard Policy %s: a setting asked beside an approval, run after it on that message", (policy) => {
  test("approve, then plan approval off on that message: theirs, and the code plan is built without asking", () => {
    const proj = bugfixAtRequirements(policy);
    const asked = said(proj, ASKED);
    approve(proj, asked);
    const off = setter(proj, ["plan-approval", "off", "--message", asked]);
    expect(off.rc, off.out).toBe(0);
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
    const set = rows(proj, "CEREMONY_SET").at(-1);
    expect(set === undefined ? null : auditBlockField(set.block, "Message Id")).toBe(asked);
    expect(set === undefined ? null : auditBlockField(set.block, "Person Reply")).toBe(ASKED);
    expect(["run-stage", "load-steering"]).toContain(next(proj).kind ?? "");
    planWritten(proj);
    expect(next(proj).ask_type).not.toBe("plan-approval");
  });

  test("a wrong id first, or none: the step names the message that asked, and it is recorded on it", () => {
    const proj = bugfixAtRequirements(policy);
    const asked = said(proj, ASKED);
    approve(proj, asked);
    const wrong = setter(proj, ["plan-approval", "off", "--message", "0badc0de"]);
    expect(wrong.rc).not.toBe(0);
    expect(wrong.out).toContain(`If their message ${asked} (sent `);
    const bare = setter(proj, ["plan-approval", "off"]);
    expect(bare.rc).not.toBe(0);
    expect(bare.out).toContain(`If their message ${asked} (sent `);
    const off = setter(proj, ["plan-approval", "off", "--message", asked]);
    expect(off.rc, off.out).toBe(0);
    expect(stateField(proj, "Plan Approval")).toBe("off (set by you)");
  });

  test("another setting asked beside the approval goes the same way", () => {
    const proj = bugfixAtRequirements(policy);
    const asked = said(proj, "approve, and turn learnings off");
    approve(proj, asked);
    const off = setter(proj, ["learnings", "off", "--message", asked]);
    expect(off.rc, off.out).toBe(0);
    expect(stateField(proj, "Learnings")).toBe("off (set by you)");
  });

  test("approve the plan, and turn learnings off: the plan answer first, then the setter on that message", () => {
    const proj = bugfixAtRequirements(policy);
    approve(proj, said(proj, "Approve"));
    expect(["run-stage", "load-steering"]).toContain(next(proj).kind ?? "");
    planWritten(proj);
    expect(next(proj)).toEqual({ kind: "ask", ask_type: "plan-approval" });
    const asked = said(proj, "approve the plan, and turn learnings off");
    const answer = run(proj, LOG, ["answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan"]);
    expect(answer.rc, answer.out).toBe(0);
    const recorded = rows(proj, "PLAN_APPROVAL_RECORDED").at(-1);
    expect(recorded === undefined ? null : auditBlockField(recorded.block, "Message Id")).toBe(asked);
    const off = setter(proj, ["learnings", "off", "--message", asked]);
    expect(off.rc, off.out).toBe(0);
    expect(stateField(proj, "Learnings")).toBe("off (set by you)");
  });

  test("once the next gate is open, the Approve that passed the one before stands for no setting", () => {
    const proj = bugfixAtRequirements(policy);
    const approval = said(proj, "Approve");
    approve(proj, approval);
    const opened = run(proj, STATE, ["gate-start", "code-generation"], GATE_SETUP);
    expect(opened.rc, opened.out).toBe(0);
    expect(rows(proj, "STAGE_AWAITING_APPROVAL").length).toBeGreaterThan(1);
    const off = setter(proj, ["learnings", "off", "--message", approval]);
    expect(off.rc).not.toBe(0);
    expect(off.out).not.toContain(approval);
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
  });

  // The live shape the rule for every setting was made for: the agent went on
  // with the work, a guard refused it, and it turned a setting off on the Approve.
  test("after a guard refused the agent, the Approve stands for no setting, and the step is one it can take", () => {
    const proj = bugfixAtRequirements(policy);
    const approval = said(proj, "Approve");
    approve(proj, approval);
    expect(guardAdmits(proj, "echo built > src/app.js")).not.toBe(0);
    expect(rows(proj, "PLAN_APPROVAL_BLOCKED").length).toBeGreaterThan(0);
    const off = setter(proj, ["plan-approval", "off", "--message", approval]);
    expect(off.rc).not.toBe(0);
    expect(off.out).not.toContain(approval);
    expect(off.out).toContain("It stays on; go on with the open step.");
    expect(stateField(proj, "Plan Approval")).toBe("on (from scope bugfix)");
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
  });

  test("once the person has sent another message, the Approve stands for no setting, and the later one does", () => {
    const proj = bugfixAtRequirements(policy);
    const approval = said(proj, "Approve");
    approve(proj, approval);
    const later = said(proj, "thanks, and turn learnings off");
    const off = setter(proj, ["learnings", "off", "--message", approval]);
    expect(off.rc).not.toBe(0);
    expect(off.out).toContain(`If their message ${later} (sent `);
    expect(off.out).not.toContain(approval);
    expect(setter(proj, ["learnings", "off", "--message", later]).rc).toBe(0);
  });
});
