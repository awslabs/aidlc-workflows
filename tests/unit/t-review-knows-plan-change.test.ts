// covers: subcommand:aidlc-log:review, function:approvedPlanChangeReviewLine, function:approvedPlanChangeText,
// function:reviewRequestNote
//
// A Code Generation plan the person approved, changed after that approval and
// built without asking them again (the plan re-approval check stands aside, as
// under Guard Policy relaxed or off), is reviewed with that fact in the
// reviewer's brief. Without it, a reviewer handed the plan-approval record,
// which shows the plan as approved, beside a plan that says more, asked the
// person for a re-approval their setting does not ask for. These cases drive
// the real `next`, human-turn hook, plan-approval guard, `testing-posture
// brief` and `log review` over one Code Generation target and check:
//
//   - relaxed and off, one Unit or stage level: the review request's
//     `agent_note` carries one line for the reviewer's brief, naming what
//     changed in the change line's own words, that the person was not asked
//     again, and that the earlier approval stays the record, with the record
//     file named only while it is still that approval's;
//   - the line follows the plan re-approval check's own decision, not the
//     policy word: strict with the check switched off carries it, off with the
//     check switched back on carries none;
//   - strict after the person approved the changed plan, and any review with
//     no change since the approval, are byte for byte what main hands over
//     (pinned as literals of main's words, never through the function under
//     change), with the same JSON keys;
//   - beside another open work's line, both lines are carried.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { reviewRequestNote } from "../../dist/claude/.claude/tools/aidlc-directive.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const POSTURE = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c1df";
const UNIT = "unit-2";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const STEPS = [
  "Step 1: add the cart model in `src/cart.ts`",
  "Step 2: add the totals in `src/totals.ts`",
  "Step 3: add the checkout in `src/checkout.ts`",
  "Step 4: Update the brief doc comment",
];
const INSTRUCTIONS = "# Unit Test Instructions\n\nRun `bun test src/cart.test.ts`.\n";
// The review request's JSON keys on main, for a first request with nothing
// else to carry: nothing new is handed over beside the note.
const MAIN_KEYS = ["agent_note", "emitted", "recordVerdict", "requestId", "reviewFile", "reviewed_at", "stage"];

interface Request {
  agent_note: string;
  reviewFile: string;
  recordVerdict: string;
  keys: string[];
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function project(policy: "strict" | "relaxed" | "off", unit: string | null = UNIT, extraState = ""): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: an approved plan that changes before its review
- **Project Type**: Greenfield
- **Scope**: ${unit === null ? "poc" : "feature"}
- **State Version**: 8
- **Skeleton Stance**: off
- **Guard Policy**: ${policy} (set by you)${unit === null ? "\n- **Plan Approval**: on (set by you)" : ""}${extraState}

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
  if (unit !== null) seedBoltDag(proj, [unit]);
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

const recordDir = (proj: string, unit: string | null = UNIT) => codeGenerationRecordDir(proj, unit);
const planPath = (proj: string, unit: string | null = UNIT) => join(recordDir(proj, unit), "code-generation-plan.md");
const instructionsPath = (proj: string, unit: string | null = UNIT) =>
  join(recordDir(proj, unit), "unit-test-instructions.md");
const questionsPath = (proj: string, unit: string | null = UNIT) =>
  join(recordDir(proj, unit), "code-generation-questions.md");
const targetArgs = (unit: string | null): string[] => unit === null ? ["--stage-level"] : ["--unit", unit];

function planText(proj: string, steps: string[] = STEPS, ticked = false): string {
  return "# Code Generation Plan\n\n## Summary\n\n- Builds: a cart\n- Touches: src/\n- Tests: 3 unit tests\n\n" +
    `## Steps\n\n${steps.map((step) => `- [${ticked ? "x" : " "}] ${step}`).join("\n")}\n\n` +
    renderTestingContract(resolveTestingPosture(proj));
}

function env(proj: string): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" };
}

function next(proj: string): { ask_type?: string; plan_approval?: { status?: string } } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: env(proj) });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as { ask_type?: string; plan_approval?: { status?: string } };
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

function say(proj: string, prompt: string): void {
  const turn = run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }));
  expect(turn.status, String(turn.stderr)).toBe(0);
}

/** The plan question is asked; the person approves in their own words and the agent records it. */
function approve(proj: string): void {
  expect(next(proj).ask_type).toBe("plan-approval");
  say(proj, "approve");
  const recorded = run(proj, [
    LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
    "--project-dir", proj,
  ]);
  expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
}

function approvedPlan(proj: string, unit: string | null = UNIT): void {
  mkdirSync(recordDir(proj, unit), { recursive: true });
  writeFileSync(planPath(proj, unit), planText(proj), "utf-8");
  writeFileSync(instructionsPath(proj, unit), INSTRUCTIONS, "utf-8");
  approve(proj);
  expect(next(proj).plan_approval?.status).toBe("approved");
}

/** The person asks for more mid-build; the agent adds it to the plan and the test instructions. */
function addToPlan(proj: string, unit: string | null = UNIT): void {
  writeFileSync(planPath(proj, unit), planText(proj, [
    ...STEPS.slice(0, 3),
    "Step 4: Welcome each subscriber only once",
    "Step 5: Update the brief doc comment",
  ]), "utf-8");
  writeFileSync(instructionsPath(proj, unit), `${INSTRUCTIONS}\nAlso run \`bun test src/welcome.test.ts\`.\n`, "utf-8");
}

/** The worker brief at dispatch, which starts the build; then the code and the Step 5 files. */
function build(proj: string, unit: string | null = UNIT): void {
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
  writeFileSync(join(proj, "src", "cart.ts"), "export const cart = [];\n", "utf-8");
  const dir = recordDir(proj, unit);
  writeFileSync(join(dir, "code-summary.md"), "# Code Summary\n\n- `src/cart.ts`: the cart.\n", "utf-8");
  writeFileSync(join(dir, "traceability.json"), "{}\n", "utf-8");
  if (unit !== null) {
    writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit, version: 1, writes: [{ path: "src/cart.ts" }],
    }, null, 2)}\n`, "utf-8");
  }
}

// The stage's checks run first and name what they found in the fixture's
// bare traceability file; the request run again after them is recorded.
function requestReview(proj: string, unit: string | null = UNIT): Request {
  const args = [
    LOG, "review", "--stage", "code-generation", "--reviewer", REVIEWER, "--iteration", "1",
    ...(unit === null ? [] : ["--unit", unit]), "--project-dir", proj,
  ];
  let result = run(proj, args);
  if (String(result.stdout).includes('"kind":"print"')) result = run(proj, args);
  const out = `${result.stdout}${result.stderr}`;
  expect(result.status, out).toBe(0);
  const line = String(result.stdout).split("\n").find((row) => row.includes('"emitted":"REVIEW_REQUESTED"'));
  expect(line, out).toBeDefined();
  const json = JSON.parse(line as string) as Record<string, unknown>;
  return {
    agent_note: String(json.agent_note),
    reviewFile: String(json.reviewFile),
    recordVerdict: String(json.recordVerdict),
    keys: Object.keys(json).sort(),
  };
}

// main's note for a review request with nothing to carry, word for word.
const mainNote = (request: Request): string =>
  `Dispatch ${REVIEWER} as a subagent and have it write ${request.reviewFile}: that file is the reviewer's, so never ` +
  `write it yourself and never stand in for it. When its verdict is back, record it with \`${request.recordVerdict}\`.`;

const changeLine = (proj: string, unit: string | null = UNIT, record = true): string =>
  "The person approved this code plan, and what they approved changed after that: step 4 now says " +
  "\"Step 4: Welcome each subscriber only once\" instead of \"Step 4: Update the brief doc comment\", and 1 more " +
  "step changed, and the test instructions changed too. The plan re-approval check is off for this piece of work, " +
  "so they were not asked again, and their earlier approval stays the record" +
  (record ? `: \`${relative(proj, questionsPath(proj, unit)).split("\\").join("/")}\` is the record of that ` +
    "approval, with the summary of the plan as they approved it." : ".");

describe("the review of an approved plan that changed and built without asking again", () => {
  for (const policy of ["off", "relaxed"] as const) {
    test(`${policy}, one Unit: the reviewer's brief carries what changed and that the approval stays the record`, () => {
      const proj = project(policy);
      approvedPlan(proj);
      addToPlan(proj);
      build(proj);
      const request = requestReview(proj);
      expect(request.agent_note).toBe(
        `${mainNote(request)} Its brief carries this line word for word: ${changeLine(proj)}`,
      );
      expect(request.keys).toEqual(MAIN_KEYS);
    });
  }

  test("off, stage level (no Units): the same line, naming the stage's own record", () => {
    const proj = project("off", null);
    approvedPlan(proj, null);
    addToPlan(proj, null);
    build(proj, null);
    const request = requestReview(proj, null);
    expect(request.agent_note).toBe(
      `${mainNote(request)} Its brief carries this line word for word: ${changeLine(proj, null)}`,
    );
  });

  test("off, the record file no longer that approval's: the line names no record file", () => {
    const proj = project("off");
    approvedPlan(proj);
    addToPlan(proj);
    build(proj);
    writeFileSync(questionsPath(proj), `${readFileSync(questionsPath(proj), "utf-8")}\nA note added later.\n`, "utf-8");
    const request = requestReview(proj);
    expect(request.agent_note).toBe(
      `${mainNote(request)} Its brief carries this line word for word: ${changeLine(proj, UNIT, false)}`,
    );
  });

  test("strict with the plan re-approval check switched off for this work: the engine did not ask, so the line is carried", () => {
    const proj = project("strict", UNIT, "\n- **Guards Off**: plan-approval (set by you)");
    approvedPlan(proj);
    addToPlan(proj);
    expect(next(proj).plan_approval?.status).toBe("approved");
    build(proj);
    const request = requestReview(proj);
    expect(request.agent_note).toBe(
      `${mainNote(request)} Its brief carries this line word for word: ${changeLine(proj)}`,
    );
  });
});

describe("every other review request is as main hands it over", () => {
  test("strict, the person approved the changed plan when asked again: nothing is added", () => {
    const proj = project("strict");
    approvedPlan(proj);
    addToPlan(proj);
    approve(proj);
    expect(next(proj).plan_approval?.status).toBe("approved");
    build(proj);
    const request = requestReview(proj);
    expect(request.agent_note).toBe(mainNote(request));
    expect(request.keys).toEqual(MAIN_KEYS);
  });

  test("off, nothing changed since the approval but the ticked boxes: nothing is added", () => {
    const proj = project("off");
    approvedPlan(proj);
    build(proj);
    writeFileSync(planPath(proj), planText(proj, STEPS, true), "utf-8");
    const request = requestReview(proj);
    expect(request.agent_note).toBe(mainNote(request));
    expect(request.keys).toEqual(MAIN_KEYS);
  });

  test("off, built on the changed plan, then the check switched back on before the review: nothing is added", () => {
    const proj = project("off");
    approvedPlan(proj);
    addToPlan(proj);
    build(proj);
    const state = readFileSync(seededStateFile(proj), "utf-8");
    writeFileSync(seededStateFile(proj), state.replace(
      "- **Guard Policy**: off (set by you)",
      "- **Guard Policy**: off (set by you)\n- **Guards On**: plan-approval (set by you)",
    ), "utf-8");
    const request = requestReview(proj);
    expect(request.agent_note).toBe(mainNote(request));
  });
});

describe("the lines a reviewer's brief carries", () => {
  const base = "Dispatch r as a subagent and have it write f: that file is the reviewer's, so never write it yourself " +
    "and never stand in for it. When its verdict is back, record it with `v`.";

  test("none, one and two lines", () => {
    expect(reviewRequestNote("r", "f", "v")).toBe(base);
    expect(reviewRequestNote("r", "f", "v", null, ["A."])).toBe(`${base} Its brief carries this line word for word: A.`);
    expect(reviewRequestNote("r", "f", "v", null, ["A.", "B."])).toBe(
      `${base} Its brief carries these lines word for word: A. B.`,
    );
  });
});
