// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-testing-posture:restore,
// function:approvedPlanChangeLine, function:approvedPlanChangeText, function:restoreApprovedPlan
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
//     once the build has started nothing is said before the build any more;
//   - the plan-approval guard lets restore through while the plan waits;
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const POSTURE = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
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

interface Emitted {
  kind: string;
  ask_type?: string;
  change_notices?: string[];
  plan_approval?: { status?: string; note?: string };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function project(policy: "strict" | "relaxed" | "off"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: an approved plan that changes
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: off
- **Guard Policy**: ${policy} (set by you)

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
  seedBoltDag(proj, [UNIT]);
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

const recordDir = (proj: string) => codeGenerationRecordDir(proj, UNIT);
const planPath = (proj: string) => join(recordDir(proj), "code-generation-plan.md");
const instructionsPath = (proj: string) => join(recordDir(proj), "unit-test-instructions.md");

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

/** The person says something in chat, through the real human-turn hook. */
function say(proj: string, prompt: string, session = SESSION): void {
  const turn = run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }));
  expect(turn.status, String(turn.stderr)).toBe(0);
}

/** Plan, then the person approves in their own words and the agent records that choice. */
function approvedPlan(proj: string): void {
  mkdirSync(recordDir(proj), { recursive: true });
  writeFileSync(planPath(proj), planText(proj), "utf-8");
  writeFileSync(instructionsPath(proj), INSTRUCTIONS, "utf-8");
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
function rewrite(proj: string): void {
  writeFileSync(planPath(proj), planText(proj, [
    ...STEPS.slice(0, 3),
    "Step 4: Write code-summary.md and traceability.json",
  ]), "utf-8");
  writeFileSync(instructionsPath(proj), `${INSTRUCTIONS}\nAlso run the linter.\n`, "utf-8");
}

const changed = (wayBack: string) =>
  'Your approved plan changed before the build: step 4 now says "Step 4: Write code-summary.md and traceability.json" ' +
  `instead of "Step 4: Update the brief doc comment", and the test instructions changed too. ${wayBack}`;

function restore(proj: string): string {
  const result = run(proj, [POSTURE, "restore", "--unit", UNIT, "--project-dir", proj]);
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
    // The question is open now; going back still works on their word, and the
    // person's approval of the plan they saw is what holds.
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
      // Nothing was put back.
      expect(readFileSync(planPath(proj), "utf-8")).toBe(edited);
      expect(readFileSync(instructionsPath(proj), "utf-8")).not.toBe(INSTRUCTIONS);
      // Their word since then runs it.
      say(proj, "yes, go back");
      expect(restore(proj)).toBe("Back to the plan you approved.");
    });
  }

  test("ticking a step is not a change; once the build has started, nothing is said about before the build", () => {
    const proj = project("relaxed");
    approvedPlan(proj);
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8").replace("- [ ] Step 1:", "- [x] Step 1:"), "utf-8");
    expect(next(proj).change_notices ?? []).toEqual([]);
    // The worker brief starts the build at dispatch; a later edit is not "before the build".
    const brief = run(proj, [POSTURE, "brief", "--unit", UNIT, "--project-dir", proj]);
    expect(brief.status, String(brief.stderr)).toBe(0);
    const dispatch = run(proj, [GUARD], JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Task",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt: String(brief.stdout) },
    }));
    expect(dispatch.status, String(dispatch.stderr)).toBe(0);
    rewrite(proj);
    expect((next(proj).change_notices ?? []).filter((line) => line.startsWith("Your approved"))).toEqual([]);
  });

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
    const command = /`(bun \.claude\/tools\/[^`]* restore --unit [^`]+)`/.exec(message ?? "")?.[1];
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
