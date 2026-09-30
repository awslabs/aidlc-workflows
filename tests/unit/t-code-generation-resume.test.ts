// covers: subcommand:aidlc-orchestrate:next, function:planSteps, function:codeGenerationResume,
// function:codeGenerationResumeNarration, function:resetPlanTaskMarkers
//
// An interrupted Code Generation build picks up at the first unticked step
// (#1411). The worker ticks the plan file as it works, but the brief hands it
// the approved plan, where every step reads unticked. So a build cut off part
// way (a provider error, the editor closed) was run again from step 1 by the
// next worker, which redid or re-checked every step.
//
// These cases drive the real `next`, human-turn hook, plan-approval guard, and
// `testing-posture brief` over one Code Generation Unit (and the zero-Unit
// stage-level target) and check:
//
//   - a first run: no progress section in the brief, no pick-up line;
//   - a resumed run of the same approved plan in the same attempt: the brief
//     names the ticked steps and the step to continue at, redoes a ticked step
//     whose files are missing, and `next` carries one line for the person; the
//     approved plan in the brief and the approval fingerprint are unchanged by
//     the ticks;
//   - nothing ticked: the brief is byte-identical to the first run's and no
//     pick-up line;
//   - Redo, Request Changes at a gate, a re-approval, and an edited plan all
//     start the steps fresh, even with ticks left on disk: starting the fresh
//     build clears them (task markers only, fingerprint unchanged), so a resume
//     of that build counts only its own ticks; a resume never clears ticks;
//   - a swarm batch keeps its own continuation rule: no progress section.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  cleanupWorktreeFixture,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seedBoltDagBatches,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";
import {
  approvalFingerprint,
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  planSteps,
  projectPlanApprovalContent,
  renderTestingContract,
  resetPlanTaskMarkers,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { publishPlanApprovalAsk, routeCodeGenerationPlanApproval } from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";
import {
  stateDigest,
  workspaceSourceListing,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const POSTURE = join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const UNIT = "unit-2";
const STEPS = Array.from({ length: 9 }, (_, index) => `Step ${index + 1}: build part ${index + 1} in \`src/part${index + 1}.ts\``);
const PICK_UP = "Picking up";

interface Emitted {
  kind: string;
  unit?: string;
  ask_type?: string;
  narration?: string;
  plan_approval?: { status?: string; feedback?: string };
}

const created: string[] = [];
const worktreeFixtures: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  while (worktreeFixtures.length > 0) cleanupWorktreeFixture(worktreeFixtures.pop()!);
});

// A feature workflow at Code Generation with one Unit, stage-major, so `next`
// emits the ordinary per-Unit run-stage.
function project(policy: "strict" | "relaxed" = "strict"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: resume an interrupted build
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

// A poc workflow: zero Units, so Code Generation runs once at stage level.
function stageLevelProject(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)",
      "- **Guard Policy**: relaxed (from scope poc)\n- **Plan Approval**: on (set by you)")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

function planPath(proj: string, unit: string | null = UNIT): string {
  return join(codeGenerationRecordDir(proj, unit), "code-generation-plan.md");
}

function planText(proj: string, steps: string[] = STEPS): string {
  return "# Code Generation Plan\n\n## Summary\n\n- Builds: nine parts\n- Touches: src/\n- Tests: 9 unit tests\n\n" +
    `## Steps\n\n${steps.map((step) => `- [ ] ${step}`).join("\n")}\n\n` +
    renderTestingContract(resolveTestingPosture(proj));
}

function writePlan(proj: string, unit: string | null = UNIT): void {
  mkdirSync(codeGenerationRecordDir(proj, unit), { recursive: true });
  writeFileSync(planPath(proj, unit), planText(proj), "utf-8");
  writeFileSync(
    join(codeGenerationRecordDir(proj, unit), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/parts.test.ts`.\n",
    "utf-8",
  );
}

/** Build the steps and tick them in the plan file, as the worker does. */
function tick(proj: string, unit: string | null, ...numbers: number[]): void {
  let plan = readFileSync(planPath(proj, unit), "utf-8");
  for (const number of numbers) {
    writeFileSync(join(proj, "src", `part${number}.ts`), `export const part${number} = ${number};\n`, "utf-8");
    plan = plan.replace(`- [ ] Step ${number}: `, `- [x] Step ${number}: `);
  }
  writeFileSync(planPath(proj, unit), plan, "utf-8");
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

function reply(proj: string, prompt: string): string {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: env(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ?? "";
}

function posture(proj: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(BUN, [POSTURE, ...args, "--project-dir", proj], {
    cwd: proj,
    env: env(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
}

function brief(proj: string, unit: string | null = UNIT): string {
  const result = posture(proj, ["brief", ...(unit === null ? ["--stage-level"] : ["--unit", unit])]);
  expect(result.status, String(result.stderr)).toBe(0);
  return String(result.stdout);
}

/** Hand the brief to the developer agent: the guard starts generation. */
function dispatch(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Task",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt },
    }),
    env: env(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

/** Plan, approve, and reach the build: returns the first run's directive and brief. */
function approvedBuild(proj: string, unit: string | null = UNIT): { build: Emitted; first: string } {
  writePlan(proj, unit);
  const ask = next(proj);
  expect(ask.kind, JSON.stringify(ask)).toBe("ask");
  expect(ask.ask_type).toBe("plan-approval");
  expect(reply(proj, "approve")).toContain("Approve Plan");
  const build = next(proj);
  expect(build.kind).toBe("run-stage");
  expect(build.unit).toBe(unit ?? undefined);
  expect(build.plan_approval).toEqual({ status: "approved" });
  return { build, first: brief(proj, unit) };
}

/** The approved build, started and then cut off after the given steps were built and ticked. */
function interrupted(proj: string, ...ticked: number[]): { first: string } {
  const { first } = approvedBuild(proj);
  dispatch(proj, first);
  tick(proj, UNIT, ...ticked);
  return { first };
}

describe("an interrupted build picks up at the first unticked step", () => {
  test("a first run carries no progress and no pick-up line", () => {
    const proj = project();
    const { build, first } = approvedBuild(proj);
    expect(build.narration ?? "").not.toContain(PICK_UP);
    expect(first).not.toContain("## Progress");
    expect(first.startsWith(`AIDLC-UNIT: ${UNIT}\nAIDLC-TESTING-CONTRACT: `)).toBe(true);
  });

  test("a resumed run names the ticked steps, the step to continue at, and the file check", () => {
    const proj = project();
    const { first } = interrupted(proj, 1, 2, 3, 4);
    const resumed = brief(proj);
    // The target markers stay the first two lines, exactly as before.
    expect(resumed.split("\n").slice(0, 2)).toEqual(first.split("\n").slice(0, 2));
    expect(resumed).toContain("## Progress before the interruption");
    for (const number of [1, 2, 3, 4]) expect(resumed).toContain(`\n${number}. ${STEPS[number - 1]}\n`);
    expect(resumed).not.toContain(`\n5. ${STEPS[4]}\n`);
    expect(resumed).not.toContain("Redo step");
    expect(resumed).toContain(`\nContinue at step 5 of 9: "${STEPS[4]}".`);
    expect(resumed).toContain("check that the files it names exist; redo any ticked step whose files are missing");
    // The approved plan the worker executes is the same as before, every
    // marker unticked, and the instructions still end the brief.
    const approvedPlan = first.slice(first.indexOf("\n## Approved plan\n"));
    expect(resumed.endsWith(approvedPlan)).toBe(true);
    expect(approvedPlan).not.toContain("- [x]");
    // Ticks are not part of the approval: the fingerprint is the same.
    const authority = resolveCodeGenerationAuthority(proj, { unit: UNIT });
    const contract = resolveTestingPosture(proj).contract_sha256;
    const instructions = readFileSync(join(codeGenerationRecordDir(proj, UNIT), "unit-test-instructions.md"), "utf-8");
    const ticked = readFileSync(planPath(proj), "utf-8");
    expect(ticked).toContain("- [x] Step 4:");
    expect(approvalFingerprint(ticked, instructions, contract, authority))
      .toBe(approvalFingerprint(planText(proj), instructions, contract, authority));
    expect(projectPlanApprovalContent(ticked)).toBe(projectPlanApprovalContent(planText(proj)));
    expect(evaluateCodeGenerationApproval(proj, { unit: UNIT }).ok).toBe(true);
    // The person hears one line saying where it picks up.
    const again = next(proj);
    expect(again.kind).toBe("run-stage");
    expect(again.plan_approval).toEqual({ status: "approved" });
    expect(again.narration).toBe(`Picking up ${UNIT}'s code at step 5 of 9 (1-4 done).`);
  });

  test("a ticked step whose files are missing is redone, and the person hears which", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    rmSync(join(proj, "src", "part3.ts"));
    const resumed = brief(proj);
    expect(resumed).toContain(`\n3. ${STEPS[2]}\n`);
    expect(resumed).toContain("\nRedo step 3: `src/part3.ts` is missing.\n");
    expect(resumed).toContain(`\nThen continue at step 5 of 9: "${STEPS[4]}".`);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 5 of 9 (1-4 done; redoing 3, its files were missing).`);
    rmSync(join(proj, "src", "part4.ts"));
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 5 of 9 (1-4 done; redoing 3-4, their files were missing).`);
  });

  test("ticks out of order: the first unticked step is where it continues", () => {
    const proj = project();
    interrupted(proj, 1, 2, 4);
    expect(brief(proj)).toContain(`\nContinue at step 3 of 9: "${STEPS[2]}".`);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 3 of 9 (1-2, 4 done).`);
  });

  test("every step ticked: only the files are checked", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4, 5, 6, 7, 8, 9);
    const resumed = brief(proj);
    expect(resumed).toContain("All 9 steps are ticked in the plan file");
    expect(resumed).toContain("Nothing else in the plan is left to build.");
    expect(resumed).not.toContain("ontinue at step");
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code: all 9 steps are done, checking their files.`);
    rmSync(join(proj, "src", "part9.ts"));
    expect(brief(proj)).toContain("\nRedo step 9: `src/part9.ts` is missing.\n");
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code: all 9 steps are done; redoing 9, its files were missing.`);
  });

  test("a resumed build keeps its ticks when it starts again", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    const plan = readFileSync(planPath(proj), "utf-8");
    dispatch(proj, brief(proj));
    expect(readFileSync(planPath(proj), "utf-8")).toBe(plan);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 5 of 9 (1-4 done).`);
  });

  test("nothing ticked: the brief is byte-identical to the first run and no pick-up line", () => {
    const proj = project();
    const { first } = interrupted(proj);
    expect(brief(proj)).toBe(first);
    expect(next(proj).narration ?? "").not.toContain(PICK_UP);
  });

  test("zero-Unit work picks up the same way", () => {
    const proj = stageLevelProject();
    const { build, first } = approvedBuild(proj, null);
    expect(build.narration ?? "").not.toContain(PICK_UP);
    expect(first.startsWith("AIDLC-STAGE: code-generation\n")).toBe(true);
    dispatch(proj, first);
    tick(proj, null, 1);
    const resumed = brief(proj, null);
    expect(resumed.startsWith("AIDLC-STAGE: code-generation\n")).toBe(true);
    expect(resumed).toContain(`\nContinue at step 2 of 9: "${STEPS[1]}".`);
    expect(next(proj).narration).toBe("Picking up the code at step 2 of 9 (1 done).");
  });
});

/**
 * A fresh build of a new approval: its brief has no progress, starting it clears
 * the ticks left from before without changing the approval, and a resume after
 * it is cut off counts only the ticks this build made.
 */
function freshRunThenResume(proj: string): void {
  const fresh = brief(proj);
  expect(fresh).not.toContain("## Progress");
  const stale = readFileSync(planPath(proj), "utf-8");
  expect(stale).toContain("- [x] Step 4:");
  const authority = resolveCodeGenerationAuthority(proj, { unit: UNIT });
  const contract = resolveTestingPosture(proj).contract_sha256;
  const instructions = readFileSync(join(codeGenerationRecordDir(proj, UNIT), "unit-test-instructions.md"), "utf-8");
  dispatch(proj, fresh);
  const cleared = readFileSync(planPath(proj), "utf-8");
  expect(cleared).not.toContain("- [x]");
  // Only the task markers changed; the fingerprint and the approval stand.
  expect(cleared).toBe(stale.replaceAll("- [x] ", "- [ ] "));
  expect(approvalFingerprint(cleared, instructions, contract, authority))
    .toBe(approvalFingerprint(stale, instructions, contract, authority));
  expect(evaluateCodeGenerationApproval(proj, { unit: UNIT }).ok).toBe(true);
  // The fresh run finishes step 1 and is cut off.
  tick(proj, UNIT, 1);
  const resumed = brief(proj);
  expect(resumed).toContain(`\n1. ${STEPS[0]}\n`);
  expect(resumed).not.toContain(`\n2. ${STEPS[1]}\n`);
  expect(resumed).toContain(`\nContinue at step 2 of `);
  expect(next(proj).narration).toMatch(new RegExp(`^Picking up ${UNIT}'s code at step 2 of \\d+ \\(1 done\\)\\.$`));
}

describe("a fresh start for the steps", () => {
  test("Request Changes at the completion gate: the revised, re-approved plan starts fresh", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    appendAuditEntry("GATE_REJECTED", {
      Stage: "code-generation", Unit: UNIT, "User Input": "Request Changes", Feedback: "log every part",
    }, proj);
    const revise = next(proj);
    expect(revise.plan_approval).toEqual({ status: "revise", feedback: "log every part" });
    // The revision keeps the ticks the earlier build left.
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8")
      .replace("- [ ] Step 9:", "- [ ] Step 10: log every part\n- [ ] Step 9:"), "utf-8");
    expect(next(proj).ask_type).toBe("plan-approval");
    reply(proj, "approve");
    const build = next(proj);
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(build.narration ?? "").not.toContain(PICK_UP);
    freshRunThenResume(proj);
    expect(readFileSync(planPath(proj), "utf-8")).toContain("- [ ] Step 10: log every part\n");
  });

  test("Redo: a new attempt asks again, and its build starts fresh", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    appendAuditEntry("STAGE_JUMPED", { Stage: "code-generation", Direction: "redo" }, proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    reply(proj, "approve");
    const build = next(proj);
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(build.narration ?? "").not.toContain(PICK_UP);
    freshRunThenResume(proj);
  });

  test("the person re-approves the plan: its build starts fresh", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    expect(reply(proj, "review the plan first")).toContain("asked to review the plan");
    expect(next(proj).ask_type).toBe("plan-approval");
    reply(proj, "approve");
    const build = next(proj);
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(build.narration ?? "").not.toContain(PICK_UP);
    freshRunThenResume(proj);
  });

  test("a plan edited after approval: the build continues on the edited plan, steps fresh", () => {
    const proj = project("relaxed");
    interrupted(proj, 1, 2, 3, 4);
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8")
      .replace("- [ ] Step 9:", "- [ ] Step 10: add a fast path\n- [ ] Step 9:"), "utf-8");
    const build = next(proj);
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval?.status).toBe("approved");
    expect(build.narration ?? "").not.toContain(PICK_UP);
    expect(brief(proj)).not.toContain("## Progress");
  });
});

describe("a swarm batch keeps its own continuation rule", () => {
  test("a started swarm Unit with ticks gets no progress section", () => {
    const pd = setupWorktreeFixture();
    worktreeFixtures.push(pd);
    seedAidlcMemory(pd);
    writeFileSync(seededStateFile(pd), `# State
## Project Information
- **Project**: Swarm continuation
- **Scope**: feature
- **Project Type**: Greenfield
- **State Version**: 8
## Runtime State
- **Construction Checkpoints**: enabled
- **Construction Iteration**: stage-major
- **Construction Execution**: swarm
- **Construction Autonomy Mode**: gated
- **Skeleton Stance**: off
- **Unit Ownership**: solo
- **Guard Policy**: strict (set by you)
## Stage Progress
### CONSTRUCTION PHASE
- [x] functional-design \u2014 EXECUTE
- [x] nfr-requirements \u2014 EXECUTE
- [x] nfr-design \u2014 EXECUTE
- [x] infrastructure-design \u2014 EXECUTE
- [-] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Current Stage**: code-generation
- **Lifecycle Phase**: CONSTRUCTION
- **Status**: Running
`, "utf-8");
    const group = ["alpha", "beta"];
    seedBoltDagBatches(pd, [group]);
    mkdirSync(join(pd, "src"), { recursive: true });
    const baseline = writeBaselineSourceSnapshot(pd, "code-generation", workspaceSourceListing(pd)!);
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, pd);
    for (const unit of group) writePlan(pd, unit);
    const swarm = { kind: "invoke-swarm" as const, stage: "code-generation", units: group };
    const state = () => stateDigest(readFileSync(seededStateFile(pd), "utf-8"));
    writeActiveDirectiveMarker(pd, { ...swarm, state_sha256: state() });
    const ask = routeCodeGenerationPlanApproval(pd, { ...swarm });
    expect(ask.kind).toBe("ask");
    writeActiveDirectiveMarker(pd, { kind: "ask", stage: "code-generation", ask_type: "plan-approval", units: group, state_sha256: state() });
    publishPlanApprovalAsk(pd, ask as Parameters<typeof publishPlanApprovalAsk>[1]);
    expect(reply(pd, "approve all")).toContain("Approve Plan");
    writeActiveDirectiveMarker(pd, { ...swarm, state_sha256: state() });
    const first = brief(pd, "alpha");
    tick(pd, "alpha", 1);
    const begin = posture(pd, ["begin", "--unit", "alpha"]);
    expect(begin.status, String(begin.stderr)).toBe(0);
    // Starting a swarm Unit leaves its plan file alone.
    expect(readFileSync(planPath(pd, "alpha"), "utf-8")).toContain("- [x] Step 1:");
    tick(pd, "alpha", 2);
    expect(brief(pd, "alpha")).toBe(first);
  });
});

describe("clearing a plan's ticks", () => {
  test("only task markers on steps change; every other byte, and the projection, stay", () => {
    const plan = "\uFEFF# Plan\r\n\r\n- [x] Step 1: keep `src/a.ts`   \r\n  - [X] sub-step\r\n1. [-] Step 2: in progress\r\n" +
      "Prose about - [x] mid-line stays.\r\n\r\n```md\r\n- [x] inside a fence\r\n```\r\n<!--\r\n- [x] inside a comment\r\n-->\r\n" +
      "\r\n## Review\r\n\r\n- [x] Step 9: from an old review\r\n";
    const reset = resetPlanTaskMarkers(plan);
    expect(reset).toBe(
      "\uFEFF# Plan\r\n\r\n- [ ] Step 1: keep `src/a.ts`   \r\n  - [ ] sub-step\r\n1. [ ] Step 2: in progress\r\n" +
        "Prose about - [x] mid-line stays.\r\n\r\n```md\r\n- [x] inside a fence\r\n```\r\n<!--\r\n- [x] inside a comment\r\n-->\r\n" +
        "\r\n## Review\r\n\r\n- [x] Step 9: from an old review\r\n",
    );
    expect(projectPlanApprovalContent(reset)).toBe(projectPlanApprovalContent(plan));
    expect(resetPlanTaskMarkers(reset)).toBe(reset);
  });
});

describe("the plan's steps", () => {
  test("a step owns the lines indented under it; fences, comments, and a review appendix are not steps", () => {
    const steps = planSteps([
      "# Plan",
      "",
      "- [x] Step 1: runner (`vitest.config.ts`)",
      "  - [x] Red: `tests/todo.test.ts`",
      "  - [ ] Green: `src/todo.ts`",
      "- Layers",
      "  - [ ] Step 2: repository in `src/repo/`",
      "1. [X] Step 3: routes `GET /todos` returning `application/json` via `todo.title`",
      "",
      "```md",
      "- [x] not a step",
      "```",
      "<!-- - [x] not a step either -->",
      "",
      "## Review",
      "",
      "- [ ] Step 9: from an old review",
    ].join("\n"));
    expect(steps).toEqual([
      { text: "Step 1: runner (`vitest.config.ts`)", ticked: true, paths: ["vitest.config.ts", "tests/todo.test.ts", "src/todo.ts"] },
      { text: "Step 2: repository in `src/repo/`", ticked: false, paths: ["src/repo/"] },
      {
        text: "Step 3: routes `GET /todos` returning `application/json` via `todo.title`",
        ticked: true,
        paths: [],
      },
    ]);
  });
});
