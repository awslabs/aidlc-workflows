// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-testing-posture:restore,
// function:approvedPlanChangeLine, function:approvedPlanChangeText, function:restoreApprovedPlan, function:personTurnStands,
// function:guardStoodAsideLine, function:fenceCheckName
//
// An approved code plan that changes before the build is named for the person
// in one line, and they can go back to the plan they approved. A resumed build
// once rewrote the approved plan and dropped an approved step, and nothing said
// so. These cases drive the real `next`, human-turn hook, plan-approval guard,
// and `testing-posture restore` over one Code Generation Unit and check:
//
//   - relaxed and off: the build continues on the edited plan, and `next`
//     carries one line naming the changed step and the test instructions, and
//     asking whether to go back to the plan they approved;
//   - strict: the edited plan is asked about again, and the question's note
//     names the same change and offers the way back beside the question;
//   - going back: restore writes the approved files back, the approval holds
//     again, and the line is gone. Only the person's word since their last
//     decision runs it: the agent going back on its own is refused;
//   - ticking a step is not a change, an added step is named as added, and
//     once the build has started the line says so and offers the rebuild;
//   - the plan-approval guard lets restore through while the plan waits;
//   - under relaxed, the line beside each build step on the edited plan says
//     plan re-approval is off, never plan approval, which stays on; a plan
//     built with plan approval off keeps the plan-approval name, since nobody
//     approved it;
//   - their words in a new chat, in any wording, are read for the way back,
//     and the print names the restore (a person once got a question about
//     where the words belong instead, and their "1" built, or under strict
//     approved, the edited plan). The words are the agent's to read: no
//     phrase is matched.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
  seedBoltDag,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  approvedPlanChangeText,
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const POSTURE = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c1de";
const UNIT = "unit-2";
const STEPS = [
  "Step 1: add the cart model in `src/cart.ts`",
  "Step 2: add the totals in `src/totals.ts`",
  "Step 3: add the checkout in `src/checkout.ts`",
  "Step 4: Update the brief doc comment",
];
const INSTRUCTIONS = "# Unit Test Instructions\n\nRun `bun test src/cart.test.ts`.\n";
// Built on, the line asks; asked about again, the plan question follows, so
// the way back is offered beside it.
const ASK = "Do you want me to go back to the plan you approved?";
const OFFER = "I can also go back to the plan you approved.";
// Once the build has started there is no "before the build" to go back to, so
// the line says what is happening and offers what is still true (#2084 F1).
const REBUILD_ASK = "I am building it as it is now. Do you want me to build the plan you approved instead?";

interface Emitted {
  kind: string;
  ask_type?: string;
  change_notices?: string[];
  plan_approval?: { status?: string; note?: string; skipped?: true };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function project(policy: "strict" | "relaxed" | "off", unit: string | null = UNIT): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: an approved plan that changes
- **Project Type**: Greenfield
- **Scope**: ${unit === null ? "poc" : "feature"}
- **State Version**: 8
- **Skeleton Stance**: off
- **Guard Policy**: ${policy} (set by you)${unit === null ? "\n- **Plan Approval**: on (set by you)" : ""}

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Minimal

## Stage Progress

### CONSTRUCTION PHASE
- [x] functional-design \u2014 EXECUTE
- [x] nfr-requirements \u2014 EXECUTE
- [x] nfr-design \u2014 EXECUTE
- [x] infrastructure-design \u2014 EXECUTE
- [-] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`, "utf-8");
  // A poc workflow has no Units, so Code Generation runs once at stage level.
  if (unit !== null) seedBoltDag(proj, [unit]);
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

const recordDir = (proj: string, unit: string | null = UNIT) => codeGenerationRecordDir(proj, unit);
const planPath = (proj: string, unit: string | null = UNIT) => join(recordDir(proj, unit), "code-generation-plan.md");
const instructionsPath = (proj: string, unit: string | null = UNIT) =>
  join(recordDir(proj, unit), "unit-test-instructions.md");
const targetArgs = (unit: string | null): string[] => unit === null ? ["--stage-level"] : ["--unit", unit];



function planText(proj: string, steps: string[] = STEPS): string {
  return "# Code Generation Plan\n\n## Summary\n\n- Builds: a cart\n- Touches: src/\n- Tests: 3 unit tests\n\n" +
    `## Steps\n\n${steps.map((step) => `- [ ] ${step}`).join("\n")}\n\n` +
    renderTestingContract(resolveTestingPosture(proj));
}

function env(proj: string): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" };
}

function next(proj: string): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: env(proj) });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

function run(proj: string, args: string[], input?: string): ReturnType<typeof spawnSync> {
  return spawnSync(BUN, args, {
    cwd: proj,
    env: env(proj),
    encoding: "utf-8",
    ...(input !== undefined ? { input } : {}),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
}

function say(proj: string, prompt: string, session = SESSION): void {
  const turn = run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }));
  expect(turn.status, String(turn.stderr)).toBe(0);
}

/** Plan, then the person approves in their own words and the agent records that choice. */
function approvedPlan(proj: string, unit: string | null = UNIT): void {
  mkdirSync(recordDir(proj, unit), { recursive: true });
  writeFileSync(planPath(proj, unit), planText(proj), "utf-8");
  writeFileSync(instructionsPath(proj, unit), INSTRUCTIONS, "utf-8");
  expect(next(proj).ask_type).toBe("plan-approval");
  say(proj, "approve");
  const recorded = run(proj, [
    LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
    "--project-dir", proj,
  ]);
  expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
  const build = next(proj);
  expect(build.plan_approval).toEqual({ status: "approved" });
  expect(build.change_notices ?? []).toEqual([]);
}

/** The agent rewrites the approved plan and test instructions before building (the resume defect). */
function rewrite(proj: string, unit: string | null = UNIT): void {
  writeFileSync(planPath(proj, unit), planText(proj, [
    ...STEPS.slice(0, 3),
    "Step 4: Write code-summary.md and traceability.json",
  ]), "utf-8");
  writeFileSync(instructionsPath(proj, unit), `${INSTRUCTIONS}\nAlso run the linter.\n`, "utf-8");
}

const changed = (wayBack: string, when = "before the build") =>
  `Your approved plan changed ${when}: step 4 now says "Step 4: Write code-summary.md and traceability.json" ` +
  `instead of "Step 4: Update the brief doc comment", and the test instructions changed too. ${wayBack}`;

/** The worker brief at dispatch, which starts the build (the receipt moves to generation). */
function startBuild(proj: string, unit: string | null = UNIT): void {
  const brief = run(proj, [POSTURE, "brief", ...targetArgs(unit), "--project-dir", proj]);
  expect(brief.status, String(brief.stderr)).toBe(0);
  const dispatch = run(proj, [GUARD], JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: proj,
    tool_name: "Task",
    tool_input: { subagent_type: "aidlc-developer-agent", prompt: String(brief.stdout) },
  }));
  expect(dispatch.status, String(dispatch.stderr)).toBe(0);
}

/** What one build step on the edited plan says: the brief's note, then the guard's line at the dispatch and at a write. */
function buildStepLines(proj: string, unit: string | null = UNIT): string[] {
  const brief = run(proj, [POSTURE, "brief", ...targetArgs(unit), "--project-dir", proj]);
  expect(brief.status, String(brief.stderr)).toBe(0);
  const guard = (tool_name: string, tool_input: Record<string, string>): string => {
    const result = run(proj, [GUARD], JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name,
      tool_input,
    }));
    expect(result.status, String(result.stderr)).toBe(0);
    return String(result.stdout);
  };
  return [
    String(brief.stderr),
    guard("Task", { subagent_type: "aidlc-developer-agent", prompt: String(brief.stdout) }),
    guard("Write", { file_path: join(proj, "src", "cart.ts"), content: "export const cart = [];\n" }),
  ];
}

const planApprovalStoodAside = (proj: string): number => readAuditShardEvents(proj).filter((row) =>
  row.event === "GUARD_STOOD_ASIDE" && auditBlockField(row.block, "Guard") === "plan-approval").length;

// The id of the message the hook kept for the person's latest turn.
function latestMessageId(proj: string): string {
  const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1);
  const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
  expect(id).not.toBeNull();
  return id as string;
}

function restore(proj: string, unit: string | null = UNIT): string {
  const result = run(proj, [POSTURE, "restore", ...targetArgs(unit), "--project-dir", proj]);
  expect(result.status, String(result.stderr)).toBe(0);
  return String(result.stdout).trim();
}

describe("an approved plan that changed before the build is named, and can be undone", () => {
  for (const policy of ["relaxed", "off"] as const) {
    test(`${policy}: the build continues, and next names the change and asks about going back`, () => {
      const proj = project(policy);
      approvedPlan(proj);
      rewrite(proj);
      const build = next(proj);
      expect(build.kind).toBe("run-stage");
      expect(build.plan_approval?.status).toBe("approved");
      expect(build.change_notices).toContain(changed(ASK));
    });

    test(`${policy}: going back on the person's yes restores the plan, the approval holds, and the line is gone`, () => {
      const proj = project(policy);
      approvedPlan(proj);
      const approved = readFileSync(planPath(proj), "utf-8");
      rewrite(proj);
      expect(next(proj).change_notices).toContain(changed(ASK));
      say(proj, "yes");
      expect(restore(proj)).toBe("Back to the plan you approved.");
      expect(readFileSync(planPath(proj), "utf-8")).toBe(approved);
      expect(readFileSync(instructionsPath(proj), "utf-8")).toBe(INSTRUCTIONS);
      expect(evaluateCodeGenerationApproval(proj, { unit: UNIT }).ok).toBe(true);
      const build = next(proj);
      expect(build.plan_approval).toEqual({ status: "approved" });
      expect(build.change_notices ?? []).toEqual([]);
    });
  }

  test("strict: the edited plan is asked about again, the note offers the way back, and restore ends the question", () => {
    const proj = project("strict");
    approvedPlan(proj);
    rewrite(proj);
    const ask = next(proj);
    expect(ask.kind).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    // One question only: the plan question follows the note, so the note asks nothing.
    expect(ask.plan_approval?.note).toBe(changed(OFFER));
    say(proj, "go back to what I approved");
    expect(restore(proj)).toBe("Back to the plan you approved.");
    expect(evaluateCodeGenerationApproval(proj, { unit: UNIT }).ok).toBe(true);
    const build = next(proj);
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  for (const policy of ["off", "strict"] as const) {
    test(`${policy}: the agent going back on its own, with no word from the person since their approval, is refused`, () => {
      const proj = project(policy);
      approvedPlan(proj);
      rewrite(proj);
      const edited = readFileSync(planPath(proj), "utf-8");
      next(proj);
      const refused = run(proj, [POSTURE, "restore", "--unit", UNIT, "--project-dir", proj]);
      expect(refused.status, String(refused.stdout)).not.toBe(0);
      expect(String(refused.stderr)).toContain("Do you want me to go back to the plan you approved?");
      expect(readFileSync(planPath(proj), "utf-8")).toBe(edited);
      expect(readFileSync(instructionsPath(proj), "utf-8")).not.toBe(INSTRUCTIONS);
      say(proj, "yes, go back");
      expect(restore(proj)).toBe("Back to the plan you approved.");
    });

    // An answer never uses their message up: the yes that also answered the
    // agent's own question still stands behind going back.
    test(`${policy}: a yes that also answered the agent's question restores the plan`, () => {
      const proj = project(policy);
      approvedPlan(proj);
      const approved = readFileSync(planPath(proj), "utf-8");
      rewrite(proj);
      next(proj);
      say(proj, "yes, go back, and keep the cart model as it is");
      appendAuditEntry("QUESTION_ANSWERED", {
        Stage: "code-generation", Details: "Q1: keep the cart model", "Message Id": latestMessageId(proj),
      }, proj);
      expect(restore(proj)).toBe("Back to the plan you approved.");
      expect(readFileSync(planPath(proj), "utf-8")).toBe(approved);
    });

    // The approval their message gave uses it up for going back on its own:
    // the refusal leads with naming that message, and named, it restores.
    test(`${policy}: going back on the message that approved takes that message named`, () => {
      const proj = project(policy);
      approvedPlan(proj);
      const approved = readFileSync(planPath(proj), "utf-8");
      const id = latestMessageId(proj);
      rewrite(proj);
      next(proj);
      const refused = run(proj, [POSTURE, "restore", "--unit", UNIT, "--project-dir", proj]);
      expect(refused.status, String(refused.stdout)).not.toBe(0);
      expect(String(refused.stderr)).toContain(`If their message ${id} (sent `);
      expect(String(refused.stderr)).toContain("run the same command with --message <id>");
      expect(String(refused.stderr)).not.toContain("approve\"");
      const named = run(proj, [POSTURE, "restore", "--unit", UNIT, "--message", id, "--project-dir", proj]);
      expect(named.status, String(named.stderr)).toBe(0);
      expect(String(named.stdout).trim()).toBe("Back to the plan you approved.");
      expect(readFileSync(planPath(proj), "utf-8")).toBe(approved);
    });
  }

  test("ticking a step is not a change; once the build has started, the line says so and offers the rebuild", () => {
    const proj = project("relaxed");
    approvedPlan(proj);
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8").replace("- [ ] Step 1:", "- [x] Step 1:"), "utf-8");
    expect(next(proj).change_notices ?? []).toEqual([]);
    // The worker brief starts the build at dispatch. The edit after that is not
    // "before the build", and the offer that was true then is not true now:
    // the line says the build is going ahead and offers the approved plan
    // instead, which the person's yes can still reach (#2084 F1).
    startBuild(proj);
    rewrite(proj);
    expect(next(proj).change_notices).toContain(changed(REBUILD_ASK, "after the build started"));
  });

  // Their yes is answered by the restore and the build that follows it. A
  // reopen named beside the restore undid their approval (its `Reopen: jump`
  // row drops the standing approval, so `next` asked them to approve again
  // under a line promising the build), and no stage-level form of that command
  // exists: the restore alone leaves the approval standing, and `next` builds
  // the approved plan (#2084 F1 follow-up).
  for (const [label, unit] of [["a Unit's", UNIT], ["stage-level", null]] as const) {
    test(`${label} yes after the build started restores the approved plan, and next builds it with no question`, () => {
      const proj = project("relaxed", unit);
      approvedPlan(proj, unit);
      const approved = readFileSync(planPath(proj, unit), "utf-8");
      startBuild(proj, unit);
      rewrite(proj, unit);
      expect(next(proj).change_notices).toContain(changed(REBUILD_ASK, "after the build started"));
      say(proj, "yes, build what I approved");
      expect(restore(proj, unit)).toBe("Back to the plan you approved. I am building it again from that plan.");
      expect(readFileSync(planPath(proj, unit), "utf-8")).toBe(approved);
      expect(readFileSync(instructionsPath(proj, unit), "utf-8")).toBe(INSTRUCTIONS);
      expect(evaluateCodeGenerationApproval(proj, { unit }).ok).toBe(true);
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
      expect(build.change_notices ?? []).toEqual([]);
    });
  }

  test("the plan-approval guard lets restore through while the edited plan waits for the person", () => {
    const proj = project("strict");
    approvedPlan(proj);
    rewrite(proj);
    expect(next(proj).kind).toBe("ask");
    // The guard trusts only the project's own installed entry point, as a real file.
    const entry = ".claude/tools/aidlc.ts";
    mkdirSync(join(proj, ".claude", "tools"), { recursive: true });
    writeFileSync(join(proj, entry), "// The installed entry point the guard trusts.\n", "utf-8");
    const command = `bun ${entry} engine testing-posture restore --unit ${UNIT}`;
    const hook = run(proj, [GUARD], JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Bash",
      tool_input: { command },
    }));
    expect(hook.status, `${command}\n${hook.stderr}`).toBe(0);
  });

  // Relaxed lowers only the re-approval of an edited plan: plan approval, the
  // plan question, stays on, and a line calling it off is false.
  test("relaxed: once the approved plan changed, the build's line names plan re-approval, never plan approval off", () => {
    const proj = project("relaxed");
    approvedPlan(proj);
    startBuild(proj);
    rewrite(proj);
    expect(next(proj).change_notices).toContain(changed(REBUILD_ASK, "after the build started"));
    const before = planApprovalStoodAside(proj);
    for (const said of buildStepLines(proj)) {
      expect(said).toContain(
        "Continuing past the plan re-approval check because it is off for this piece of work (guard policy relaxed (set by you))",
      );
      expect(said).not.toContain("plan-approval check because it is off");
    }
    expect(planApprovalStoodAside(proj)).toBe(before + 3);
    const setting = run(proj, [UTILITY, "config-get", "guard.plan-approval", "--project-dir", proj]);
    expect(setting.status, String(setting.stderr)).toBe(0);
    expect(String(setting.stdout).trim()).toBe("on (from scope feature)");
  });

  // poc builds a plan without asking (a skipped receipt), so there is no
  // approval to re-approve: the line keeps the plan-approval name.
  test("relaxed, plan approval off: once the plan built without asking changed, the line keeps plan-approval, never re-approval", () => {
    const proj = project("relaxed", null);
    const statePath = seededStateFile(proj);
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace("\n- **Plan Approval**: on (set by you)", ""), "utf-8");
    mkdirSync(recordDir(proj, null), { recursive: true });
    writeFileSync(planPath(proj, null), planText(proj), "utf-8");
    writeFileSync(instructionsPath(proj, null), INSTRUCTIONS, "utf-8");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toMatchObject({ status: "approved", skipped: true });
    startBuild(proj, null);
    rewrite(proj, null);
    expect(next(proj).kind).toBe("run-stage");
    const before = planApprovalStoodAside(proj);
    for (const said of buildStepLines(proj, null)) {
      expect(said).toContain(
        "Continuing past the plan-approval check because it is off for this piece of work (guard policy relaxed (set by you))",
      );
      expect(said).not.toContain("re-approval");
    }
    expect(planApprovalStoodAside(proj)).toBe(before + 3);
  });
});

describe("their words in a new chat are read for the way back to the approved plan", () => {
  const OTHER_SESSION = "01995000-7a11-7000-8000-00000000c1df";

  function nextWith(proj: string, args: string[]): Emitted & { message?: string } {
    const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: env(proj) });
    expect(result.status, result.out).toBe(0);
    expect(result.directive, result.out).not.toBeNull();
    return result.directive as unknown as Emitted & { message?: string };
  }

  // The restore the print names, through the plan-approval guard, then run as
  // given in the project's own installed tools.
  function runNamedRestore(proj: string, message: string | undefined): string {
    const command = /`(bun \.claude\/tools\/[^`]* restore (?:--unit [^`]+|--stage-level))`/.exec(message ?? "")?.[1];
    expect(command, message).toBeDefined();
    if (!command) return "";
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    const hook = run(proj, [GUARD], JSON.stringify({
      hook_event_name: "PreToolUse", session_id: OTHER_SESSION, cwd: proj, tool_name: "Bash", tool_input: { command },
    }));
    expect(hook.status, `${command}\n${hook.stderr}`).toBe(0);
    const ran = run(proj, command.split(" ").slice(1));
    expect(ran.status, String(ran.stderr)).toBe(0);
    return String(ran.stdout).trim();
  }

  const planAnswers = (proj: string) =>
    readFileSync(join(recordDir(proj), "code-generation-questions.md"), "utf-8").match(/^\[Answer\]:.*$/gm) ?? [];

  // No phrase is matched: the words the person picks are read for what they mean.
  for (const words of ["put back the plan I approved", "undo that change to my plan, please"]) {
    for (const policy of ["relaxed", "off"] as const) {
      test(`${policy}: /aidlc ${words} in a new chat names the restore, and the approved plan is built`, () => {
        const proj = project(policy);
        approvedPlan(proj);
        const approved = readFileSync(planPath(proj), "utf-8");
        rewrite(proj);
        expect(next(proj).change_notices).toContain(changed(ASK));
        say(proj, `/aidlc ${words}`, OTHER_SESSION);
        const print = nextWith(proj, [words]);
        expect(print.kind, JSON.stringify(print)).toBe("print");
        expect(print.message).toContain("go back to the plan they approved");
        expect(runNamedRestore(proj, print.message)).toBe("Back to the plan you approved.");
        expect(readFileSync(planPath(proj), "utf-8")).toBe(approved);
        const build = next(proj);
        expect(build.plan_approval).toEqual({ status: "approved" });
        expect(build.change_notices ?? []).toEqual([]);
      });
    }
  }

  // The restore is the only step the reading names. A reopen beside it undid
  // the approval the person had already given (its `Reopen: jump` row drops the
  // standing approval, so `next` asked them to approve again under a line
  // promising the build), and the stage-level form of that command does not
  // exist, so the handed command failed (#2084 F1 follow-up).
  for (const [label, unit] of [["a Unit's", UNIT], ["stage-level", null]] as const) {
    test(`relaxed: ${label} yes in a new chat after the build started names the restore, and only the restore`, () => {
      const proj = project("relaxed", unit);
      approvedPlan(proj, unit);
      const approved = readFileSync(planPath(proj, unit), "utf-8");
      startBuild(proj, unit);
      rewrite(proj, unit);
      expect(next(proj).change_notices).toContain(changed(REBUILD_ASK, "after the build started"));
      say(proj, "/aidlc yes, build the plan I approved", OTHER_SESSION);
      const print = nextWith(proj, ["yes, build the plan I approved"]);
      expect(print.kind, JSON.stringify(print)).toBe("print");
      expect(print.message).toContain("go back to the plan they approved");
      expect(print.message, print.message).not.toContain("reopen");
      expect(runNamedRestore(proj, print.message)).toBe(
        "Back to the plan you approved. I am building it again from that plan.",
      );
      expect(readFileSync(planPath(proj, unit), "utf-8")).toBe(approved);
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
    });
  }

  test("strict: their words in a new chat while the edited plan is asked about name the restore, and approve nothing", () => {
    const proj = project("strict");
    approvedPlan(proj);
    rewrite(proj);
    expect(next(proj).plan_approval?.note).toBe(changed(OFFER));
    const answersBefore = planAnswers(proj);
    say(proj, "/aidlc put back the plan I approved", OTHER_SESSION);
    const print = nextWith(proj, ["put back the plan I approved"]);
    expect(print.kind, JSON.stringify(print)).toBe("print");
    expect(print.message).toContain("go back to the plan they approved");
    expect(planAnswers(proj)).toEqual(answersBefore);
    expect(runNamedRestore(proj, print.message)).toBe("Back to the plan you approved.");
    expect(evaluateCodeGenerationApproval(proj, { unit: UNIT }).ok).toBe(true);
    const build = next(proj);
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  test("with nothing changed since the approval, the words are read like any others", () => {
    const proj = project("relaxed");
    approvedPlan(proj);
    const print = nextWith(proj, ["put back the plan I approved"]);
    expect(print.kind).toBe("print");
    expect(print.message).not.toContain(" restore ");
  });
});

describe("the change line names what changed in the plan's own steps", () => {
  const copy = (plan: string, instructions = INSTRUCTIONS) =>
    ({ version: 1 as const, fingerprint: "sha256:v3:0", plan, instructions, questions: "" });
  const steps = (list: string[]) => `## Steps\n\n${list.map((step) => `- [ ] ${step}`).join("\n")}\n`;

  test("an added step is named as added, a removed one as removed", () => {
    const before = steps(STEPS);
    const added = steps([...STEPS.slice(0, 2), "Step 5: add a fast path", ...STEPS.slice(2)]);
    expect(approvedPlanChangeText(copy(before), added, INSTRUCTIONS)).toBe(
      `Your approved plan changed before the build: step 3 "Step 5: add a fast path" was added. ${ASK}`,
    );
    expect(approvedPlanChangeText(copy(before), steps(STEPS.slice(0, 3)), INSTRUCTIONS)).toBe(
      `Your approved plan changed before the build: step 4 "Step 4: Update the brief doc comment" was removed. ${ASK}`,
    );
  });

  test("only the test instructions changed; nothing changed; several steps changed", () => {
    const before = steps(STEPS);
    expect(approvedPlanChangeText(copy(before), before, `${INSTRUCTIONS}more\n`)).toBe(
      `Your approved test instructions changed before the build. ${ASK}`,
    );
    expect(approvedPlanChangeText(copy(before), before.replace("- [ ] Step 2", "- [x] Step 2"), INSTRUCTIONS)).toBeNull();
    const several = steps(["Step 1: something else", "Step 2: another", ...STEPS.slice(2)]);
    expect(approvedPlanChangeText(copy(before), several, INSTRUCTIONS)).toBe(
      'Your approved plan changed before the build: step 1 now says "Step 1: something else" instead of ' +
        `"Step 1: add the cart model in \`src/cart.ts\`", and 1 more step changed. ${ASK}`,
    );
  });

  test("the way back is never words to type", () => {
    const before = steps(STEPS);
    const line = approvedPlanChangeText(copy(before), steps(STEPS.slice(0, 3)), INSTRUCTIONS) ?? "";
    expect(line).not.toMatch(/\bSay ["']/);
  });
});
