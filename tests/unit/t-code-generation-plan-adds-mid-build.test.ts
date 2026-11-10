// covers: stage:code-generation, function:planSummaryLines, function:planSteps, function:codeGenerationStartNarration,
// function:approvedPlanChangeText, subcommand:aidlc-orchestrate:next
//
// The plan shape Code Generation asks for when it adds a data-model element no
// requirement asks for (#3455), read by the engine as it is: a fourth Summary
// line, `Adds:`, counting first, and a plain line per element under
// `## Assumptions`. These cases drive the real `next`, human-turn hook,
// plan-approval guard and `log answer` over one Code Generation Unit and check:
//
//   - the Adds line reaches the plan question as the fourth line, and a long
//     one keeps its count in front of the 200-character cut;
//   - a plan that adds nothing shows the three lines it always did;
//   - an Assumptions line is not a plan step, so the start line counts only
//     the steps;
//   - an element found mid-build, put into the approved plan as a step of its
//     own with its Assumptions line and the Adds line: under strict the plan
//     question is asked once, naming the added step, and once approved the
//     build goes on without asking again; under off the build goes on with a
//     change notice naming the added step, and nothing asks, and the code
//     write after it is not refused. Each case runs `next` more than once
//     after the change, so a loop shows, and writes code through the guard.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
  codeGenerationRecordDir,
  codeGenerationStartNarration,
  planSteps,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { planSummaryLines } from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const POSTURE = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c3a5";
const UNIT = "unit-1";
const INSTRUCTIONS = "# Unit Test Instructions\n\nRun `python3 -m unittest test_subscribers`.\n";
const STEPS = [
  "Step 1: add the `subscribers` table (email) in `subscribers.py` (FR-1)",
  "Step 2: add the add, list and send-welcome commands in `subscribers.py` (FR-1, FR-2)",
  "Step 3: write `test_subscribers.py` (FR-1, FR-2)",
];
const ADDED = "Step 4: add the `subscribers.welcomed_at` column in `subscribers.py`, so send-welcome reaches each subscriber once";
const ADDS = "Adds: 1 data-model element no requirement asks for (subscribers.welcomed_at); see Assumptions";
const ASSUMPTION = "`subscribers.welcomed_at`, added in Step 4: send-welcome must reach each subscriber once, and no requirement names where that is kept";

interface Emitted {
  kind: string;
  ask_type?: string;
  change_notices?: string[];
  plan_approval?: { status?: string; note?: string; targets?: Array<{ summary?: string[] }> };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function project(policy: "strict" | "off"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: a plan that adds a data-model element
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
  writeFileSync(join(proj, "subscribers.py"), "SUBSCRIBERS = []\n", "utf-8");
  return proj;
}

const recordDir = (proj: string) => codeGenerationRecordDir(proj, UNIT);
const planPath = (proj: string) => join(recordDir(proj), "code-generation-plan.md");

function planText(proj: string | null, steps: string[], adds: string | null, assumptions: string[]): string {
  return "# Code Generation Plan\n\n## Summary\n\n- Builds: the subscriber list and send-welcome\n" +
    "- Touches: subscribers.py, test_subscribers.py\n- Tests: 6 unit tests\n" + (adds === null ? "" : `- ${adds}\n`) +
    `\n## Steps\n\n${steps.map((step) => `- [ ] ${step}`).join("\n")}\n` +
    (assumptions.length === 0 ? "" : `\n## Assumptions\n\n${assumptions.map((line) => `- ${line}`).join("\n")}\n`) +
    (proj === null ? "" : `\n${renderTestingContract(resolveTestingPosture(proj))}`);
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

/** The person approves in their own words and the agent records that choice. */
function approve(proj: string): void {
  const turn = run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: "approve" }));
  expect(turn.status, String(turn.stderr)).toBe(0);
  const recorded = run(proj, [
    LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
    "--project-dir", proj,
  ]);
  expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
}

/** The worker brief at dispatch, which starts the build. */
function startBuild(proj: string): void {
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
}

/** The developer writing code: the plan-approval guard's exit (2 refuses). */
function writeCode(proj: string): number | null {
  return run(proj, [GUARD], JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: proj,
    tool_name: "Write",
    tool_input: { file_path: join(proj, "subscribers.py"), content: "SUBSCRIBERS = []\nWELCOMED = set()\n" },
  })).status;
}

/** A plan that adds nothing, approved, and its build started. */
function building(proj: string): void {
  mkdirSync(recordDir(proj), { recursive: true });
  writeFileSync(planPath(proj), planText(proj, STEPS, null, []), "utf-8");
  writeFileSync(join(recordDir(proj), "unit-test-instructions.md"), INSTRUCTIONS, "utf-8");
  const ask = next(proj);
  expect(ask.ask_type).toBe("plan-approval");
  expect(ask.plan_approval?.targets?.[0]?.summary).toEqual([
    "Builds: the subscriber list and send-welcome", "Touches: subscribers.py, test_subscribers.py", "Tests: 6 unit tests",
  ]);
  approve(proj);
  expect(next(proj).plan_approval).toEqual({ status: "approved" });
  startBuild(proj);
}

/** The element the build turns out to need, put into the plan first as Step 4 of the stage says. */
function addElementMidBuild(proj: string): void {
  writeFileSync(planPath(proj), planText(proj, [...STEPS, ADDED], ADDS, [ASSUMPTION]), "utf-8");
}

// The change notice quotes a step the way the person reads it, cut at 80 characters.
const addedStep = `step 4 "${ADDED.slice(0, 77).trimEnd()}..." was added`;

describe("the plan names the data-model elements it adds, as the engine reads it (#3455)", () => {
  test("the Adds line is the question's fourth line, and a long one keeps its count in front of the cut", () => {
    expect(planSummaryLines(planText(null, STEPS, ADDS, [ASSUMPTION]), INSTRUCTIONS)).toEqual([
      "Builds: the subscriber list and send-welcome", "Touches: subscribers.py, test_subscribers.py", "Tests: 6 unit tests", ADDS,
    ]);
    const names = Array.from({ length: 12 }, (_, index) => `Contact.Score_Part_${index}__c`).join(", ");
    const long = `Adds: 12 data-model elements no requirement asks for (${names}); see Assumptions`;
    const shown = planSummaryLines(planText(null, STEPS, long, [ASSUMPTION]), INSTRUCTIONS)[3];
    expect(shown.length).toBe(200);
    expect(shown.startsWith("Adds: 12 data-model elements no requirement asks for")).toBe(true);
  });

  test("a plan that adds nothing shows the three lines it always did", () => {
    expect(planSummaryLines(planText(null, STEPS, null, []), INSTRUCTIONS)).toEqual([
      "Builds: the subscriber list and send-welcome", "Touches: subscribers.py, test_subscribers.py", "Tests: 6 unit tests",
    ]);
  });

  test("an Assumptions line is not a plan step", () => {
    expect(planSteps(planText(null, [...STEPS, ADDED], ADDS, [ASSUMPTION])).map((step) => step.text)).toEqual([...STEPS, ADDED]);
    const proj = project("off");
    mkdirSync(recordDir(proj), { recursive: true });
    writeFileSync(planPath(proj), planText(proj, [...STEPS, ADDED], ADDS, [ASSUMPTION]), "utf-8");
    expect(codeGenerationStartNarration(proj, UNIT)).toStartWith("Generating unit-1's code for 4 plan steps.");
  });

  test("strict: an element found mid-build asks the plan question once, and the approved build goes on", () => {
    const proj = project("strict");
    building(proj);
    addElementMidBuild(proj);
    const ask = next(proj);
    expect(ask.kind).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    expect(ask.plan_approval?.note).toContain(`Your approved plan changed after the build started: ${addedStep}.`);
    expect(ask.plan_approval?.targets?.[0]?.summary).toContain(ADDS);
    // While the question waits, the build's next write waits for the person.
    expect(writeCode(proj)).toBe(2);
    approve(proj);
    for (let again = 0; again < 2; again++) {
      const build = next(proj);
      expect(build.kind).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
      expect(build.change_notices ?? []).toEqual([]);
    }
    expect(writeCode(proj)).toBe(0);
  });

  test("off: an element found mid-build is one change notice, and nothing asks or refuses", () => {
    const proj = project("off");
    building(proj);
    addElementMidBuild(proj);
    for (let again = 0; again < 2; again++) {
      const build = next(proj);
      expect(build.kind).toBe("run-stage");
      expect(build.plan_approval?.status).toBe("approved");
      expect(build.change_notices?.filter((line) => line.startsWith("Your approved plan changed"))).toEqual([
        expect.stringContaining(`Your approved plan changed after the build started: ${addedStep}.`),
      ]);
      expect(writeCode(proj)).toBe(0);
    }
  });
});
