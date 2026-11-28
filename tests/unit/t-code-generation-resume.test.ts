// covers: subcommand:aidlc-orchestrate:next, function:planSteps, function:codeGenerationResume,
// function:codeGenerationResumeNarration, function:resetPlanTaskMarkers, function:briefPointer, function:handedBrief,
// function:handedBriefTarget, function:briefHandedAtStart, hook:aidlc-deliver-stage-rules
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
//   - Redo, Request Changes at a gate, a re-approval, and a plan edited after
//     the build started all start the steps fresh, even with ticks left on
//     disk: starting the fresh build clears them (task markers only,
//     fingerprint unchanged), so a resume of that build counts only its own
//     ticks; a resume never clears ticks;
//   - an approved plan edited before the build (the fence lowered): the build
//     that started on the edited plan picks up where it got to;
//   - a swarm batch keeps its own continuation rule: no progress section;
//   - a revision picked up later, in any chat, is handed the person's answer to
//     "What should change?" beside the bare Request Changes the rejection
//     recorded;
//   - the developer is handed its plan as it starts, so the conductor need not
//     paste it: on Claude Code the start context opens with the rules lead,
//     then the two record files (and a line when the plan ends in an earlier
//     review section) inside the part Claude Code shows inline, then the files
//     rule, then an interrupted build's progress; on Copilot and opencode the whole brief heads
//     the start message (on opencode with no copy of the rules where its memory
//     include loads them); on Codex and Kiro nothing is added; a start the plan
//     cannot be handed for is told to write nothing;
//   - the plan-approval guard lets a developer start that names no target and
//     carries no brief through only where the start hands the plan over (Claude
//     Code with its SubagentStart entry registered), and refuses it
//     everywhere else; the step's note says which (with the plan-approval check
//     switched off, Copilot and opencode get the brief command).
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
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
  briefHandedAtStart,
  clearPlanFileTicks,
  FILE_TOOLS_RULE,
  resetPlanTaskMarkers,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { publishPlanApprovalAsk, routeCodeGenerationPlanApproval } from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";
import {
  auditBlockField,
  hooksHealthReadDir,
  readAuditShardEvents,
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
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
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

function reply(proj: string, prompt: string, session = SESSION): string {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
    env: env(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ?? "";
}

// What the agent runs after reading the person's reply: the choice they made.
function answer(proj: string, details: string): ReturnType<typeof spawnSync> {
  return spawnSync(BUN, [
    LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", details,
    "--project-dir", proj,
  ], {
    cwd: proj,
    env: env(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
}

/** The person approves in their own words; the agent records that choice. */
function approve(proj: string): void {
  reply(proj, "approve");
  const recorded = answer(proj, "Approve Plan");
  expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
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

/** A file write in the build: the guard runs before it, as before every change the build makes. */
function guardWrite(proj: string, file: string): void {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Write",
      tool_input: { file_path: file, content: "export const part = 3;\n" },
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
  approve(proj);
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
    expect(resumed).not.toContain("not in the project");
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

  test("a ticked step whose file is not in the project: the worker is told the fact, the person hears only where it picks up", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    rmSync(join(proj, "src", "part3.ts"));
    const resumed = brief(proj);
    expect(resumed).toContain(`\n3. ${STEPS[2]}\n`);
    expect(resumed).toContain(
      "\nStep 3 names `src/part3.ts`, which is not in the project: redo step 3 first if it should have made that file.\n",
    );
    expect(resumed).toContain(`\nThen continue at step 5 of 9: "${STEPS[4]}".`);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 5 of 9 (1-4 done).`);
    rmSync(join(proj, "src", "part4.ts"));
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 5 of 9 (1-4 done).`);
  });

  test("ticks out of order: the first unticked step is where it continues", () => {
    const proj = project();
    interrupted(proj, 1, 2, 4);
    expect(brief(proj)).toContain(`\nContinue at step 3 of 9: "${STEPS[2]}".`);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 3 of 9 (1-2, 4 done).`);
  });

  test("a later ticked step with missing files is redone in plan order, after the steps before it", () => {
    const proj = project();
    interrupted(proj, 1, 2, 4);
    rmSync(join(proj, "src", "part4.ts"));
    const resumed = brief(proj);
    expect(resumed).not.toContain("redo step 4 first");
    expect(resumed).toContain(`\nContinue at step 3 of 9: "${STEPS[2]}".`);
    expect(resumed).toContain(
      "\nStep 4 is ticked and names `src/part4.ts`, which is not in the project: when you reach it, redo it if it should have made that file.\n",
    );
    expect(resumed.indexOf("Continue at step 3")).toBeLessThan(resumed.indexOf("Step 4 is ticked"));
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
    expect(brief(proj)).toContain(
      "\nStep 9 names `src/part9.ts`, which is not in the project: redo step 9 first if it should have made that file.\n",
    );
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code: all 9 steps are done, checking their files.`);
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

  test("code written and no step ticked: the build says so and asks for the finished steps to be ticked", () => {
    // From a live run: the plan was approved, the code and tests were written,
    // and no step was ticked. The engine checks only files a step names in a
    // code span that reads as a path, so a plan whose steps name none left
    // nothing to count: `next` re-emitted the same start line as if the build
    // had not run, and nothing named a step to take.
    const proj = project();
    const steps = Array.from({ length: 9 }, (_, index) => `Step ${index + 1}: wire up storage part ${index + 1}`);
    startedBuildOf(proj, steps);
    mkdirSync(join(proj, "src", "storage"), { recursive: true });
    for (const part of [1, 2, 3]) {
      writeFileSync(join(proj, "src", "storage", `part${part}.ts`), `export const part${part} = ${part};\n`, "utf-8");
    }
    const resumed = next(proj);
    expect(resumed.kind).toBe("run-stage");
    expect(resumed.narration).toBe(`Picking up ${UNIT}'s code: the plan marks none of its 9 steps done, checking what is built.`);
    // The same again: the line does not go back to the starting line.
    expect(next(proj).narration).toBe(resumed.narration);
    const section = brief(proj);
    expect(section).toContain("## Progress before the interruption");
    expect(section).toContain(
      "This plan's build already wrote code, and the plan file ticks none of its 9 steps " +
        "(the approved plan below shows none ticked, because ticks are not part of the approval). " +
        "Check each step against the files in the project, tick the box of each one that is done, " +
        "and carry on from the first that is not.",
    );
    // Nothing claims a step is done, so no step's files are reported missing.
    expect(section).not.toContain("not in the project");
    expect(section).not.toContain("Continue at step");
    // Once the worker ticks what it finished, the ordinary pick-up takes over.
    tickOnly(proj, 1, 2, 3);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 4 of 9 (1-3 done).`);
  });

  test("with Plan Approval off, an interrupted build picks up the same way", () => {
    // express and poc build without asking: the engine records the build as
    // started without approval, and a resume still counts its ticks.
    const proj = project();
    writeFileSync(
      seededStateFile(proj),
      readFileSync(seededStateFile(proj), "utf-8").replace(
        "- **Guard Policy**: strict (set by you)",
        "- **Guard Policy**: strict (set by you)\n- **Plan Approval**: off (set by you)",
      ),
      "utf-8",
    );
    writePlan(proj);
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval?.status).toBe("approved");
    dispatch(proj, brief(proj));
    tick(proj, UNIT, 1, 2);
    expect(next(proj).narration).toBe("Picking up unit-2's code at step 3 of 9 (1-2 done).");
    expect(brief(proj)).toContain("## Progress before the interruption");
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
  // Live on Claude Code: the person picked Request Changes, the rejection was
  // recorded with that pick, and their answer to "What should change?" came
  // after it; a new chat then revised from the bare pick.
  test("a revision picked up later gets what the person said after Request Changes", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    reply(proj, "Request Changes");
    const pick = auditBlockField(readAuditShardEvents(proj).findLast((row) => row.event === "HUMAN_TURN")!.block, "Message Id");
    expect(pick).not.toBeNull();
    // What `report --result rejected` writes for that pick.
    appendAuditEntry("GATE_REJECTED", {
      Stage: "code-generation", Unit: UNIT, "User Input": "Request Changes", Feedback: "Request Changes",
      "Message Id": pick!,
    }, proj);
    reply(proj, "log every part");
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "Request Changes\nlog every part" });
    // A new chat after the terminal closed: its own words stay its own.
    reply(proj, "where were we?", "01995000-7a11-7000-8000-00000000beef");
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "Request Changes\nlog every part" });
  });

  // The store drops a day-old message once a decision has used it, as the
  // rejection used the pick; their answer after it is kept.
  test("a revision picked up the next day still gets their answer, after the pick's own record is gone", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    reply(proj, "Request Changes");
    const pick = auditBlockField(readAuditShardEvents(proj).findLast((row) => row.event === "HUMAN_TURN")!.block, "Message Id");
    appendAuditEntry("GATE_REJECTED", {
      Stage: "code-generation", Unit: UNIT, "User Input": "Request Changes", Feedback: "Request Changes",
      "Message Id": pick!,
    }, proj);
    reply(proj, "log every part");
    rmSync(join(proj, "aidlc", ".aidlc-sessions", "messages", `${pick}.json`));
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "Request Changes\nlog every part" });
  });

  test("a rejection that names no message of theirs is revised from its own feedback alone", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    appendAuditEntry("GATE_REJECTED", {
      Stage: "code-generation", Unit: UNIT, "User Input": "Request Changes", Feedback: "log every part",
    }, proj);
    reply(proj, "and keep it short");
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "log every part" });
  });

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
    approve(proj);
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
    approve(proj);
    const build = next(proj);
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(build.narration ?? "").not.toContain(PICK_UP);
    freshRunThenResume(proj);
  });

  test("the person re-approves the plan: its build starts fresh", () => {
    const proj = project();
    interrupted(proj, 1, 2, 3, 4);
    // The agent reads the request and records it: the plan is asked about again.
    reply(proj, "review the plan first");
    const review = answer(proj, "Review the plan");
    expect(review.status, `${review.stdout}${review.stderr}`).toBe(0);
    expect(String(review.stdout)).toContain("review the plan");
    expect(next(proj).ask_type).toBe("plan-approval");
    approve(proj);
    const build = next(proj);
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(build.narration ?? "").not.toContain(PICK_UP);
    freshRunThenResume(proj);
  });

  test("Request Changes under a lowered fence: its build clears the old ticks once", () => {
    const proj = project("relaxed");
    interrupted(proj, 1, 2, 3, 4);
    appendAuditEntry("GATE_REJECTED", {
      Stage: "code-generation", Unit: UNIT, "User Input": "Request Changes", Feedback: "log every part",
    }, proj);
    expect(next(proj).plan_approval?.status).toBe("revise");
    // The revision adds a step; the approval their change request closed carries into this attempt.
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8")
      .replace("- [ ] Step 9:", "- [ ] Step 10: log every part\n- [ ] Step 9:"), "utf-8");
    const build = next(proj) as Emitted & { change_notices?: string[] };
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval?.status).toBe("approved");
    // The change the person asked for is not offered back to them to undo.
    expect((build.change_notices ?? []).some((line) => line.startsWith("Your approved plan changed"))).toBe(false);
    // The first start in this attempt clears the previous build's ticks.
    dispatch(proj, brief(proj));
    expect(readFileSync(planPath(proj), "utf-8")).not.toContain("- [x]");
    // The build ticks as it goes. Every later change it makes starts generation
    // again through the guard, and those ticks stay.
    tick(proj, UNIT, 1, 2);
    dispatch(proj, brief(proj));
    guardWrite(proj, join(proj, "src", "part3.ts"));
    const after = readFileSync(planPath(proj), "utf-8");
    expect(after).toContain("- [x] Step 1:");
    expect(after).toContain("- [x] Step 2:");
    expect(after).toContain("- [ ] Step 10: log every part\n");
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

// A Unit whose whole approved plan is built and ticked owes its review, also
// after a rejection reopened it: this attempt's plan approval and its ticks
// are the evidence the files are this attempt's, so `next` names the review
// instead of handing the stage body back to recheck finished files (#2487).
describe("a built plan owes its review, also after a reopen", () => {
  // The settled-Unit step reads Unit receipts, which Construction Checkpoints
  // require; the run that found this had them on.
  function unitMajorProject(): string {
    const proj = project();
    writeFileSync(seededStateFile(proj), readFileSync(seededStateFile(proj), "utf-8").replace(
      "- **Skeleton Stance**: off\n",
      "- **Skeleton Stance**: off\n- **Construction Checkpoints**: enabled\n" +
        "- **Construction Iteration**: stage-major\n- **Construction Execution**: serial\n- **Unit Ownership**: solo\n",
    ), "utf-8");
    // A message through the person's hook first, as in a real chat: a stage
    // event in a record no hook has written to stops `next` (hooks-off check).
    reply(proj, "carry on");
    const baseline = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, proj);
    return proj;
  }
  /** Build and tick every step, then write Step 5's handoff (with its source manifest unless told not to). */
  function finishBuild(proj: string, manifest = true): void {
    const steps = planSteps(readFileSync(planPath(proj), "utf-8")).length;
    tick(proj, UNIT, ...Array.from({ length: steps }, (_, index) => index + 1));
    const dir = codeGenerationRecordDir(proj, UNIT);
    writeFileSync(join(dir, "code-summary.md"), "# Code Summary\n\nNine parts.\n", "utf-8");
    writeFileSync(join(dir, "traceability.json"), `${JSON.stringify({ upstream_ids: [], coverage: [] })}\n`, "utf-8");
    if (!manifest) return;
    writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: UNIT, version: 1, writes: [{ path: "src/" }],
    })}\n`, "utf-8");
  }
  /** Request Changes at the completion gate, revise and re-approve the plan, and start its build. */
  function reopenAndRebuild(proj: string): void {
    appendAuditEntry("GATE_REJECTED", {
      Stage: "code-generation", Unit: UNIT, "User Input": "Request Changes", Feedback: "log every part",
    }, proj);
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "log every part" });
    revisePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    approve(proj);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    dispatch(proj, brief(proj));
  }
  function revisePlan(proj: string): void {
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8")
      .replace("- [ ] Step 9:", "- [ ] Step 10: log every part in `src/part10.ts`\n- [ ] Step 9:"), "utf-8");
  }
  const REVIEW_STEP = `Unit "${UNIT}"'s Code Generation work is written, but its review was never asked for`;

  test("first attempt: next names the review step", () => {
    const proj = unitMajorProject();
    interrupted(proj);
    finishBuild(proj);
    const step = next(proj) as Emitted & { message?: string };
    expect(step.kind).toBe("print");
    expect(step.message ?? "").toContain(REVIEW_STEP);
  });

  test("reopened by Request Changes, rebuilt in full: next names the review step, not the stage again", () => {
    const proj = unitMajorProject();
    interrupted(proj, 1, 2, 3, 4);
    reopenAndRebuild(proj);
    finishBuild(proj);
    const step = next(proj) as Emitted & { message?: string };
    expect(step.narration ?? "").not.toContain(PICK_UP);
    expect(step.kind).toBe("print");
    expect(step.message ?? "").toContain(REVIEW_STEP);
  });

  test("reopened, a ticked step's file missing: the stage comes back to redo it", () => {
    const proj = unitMajorProject();
    interrupted(proj, 1, 2, 3, 4);
    reopenAndRebuild(proj);
    finishBuild(proj);
    rmSync(join(proj, "src", "part9.ts"));
    expect(next(proj).kind).toBe("run-stage");
  });

  test("reopened and rebuilt, but Step 5 wrote no source manifest yet: the stage comes back to finish it", () => {
    const proj = unitMajorProject();
    interrupted(proj, 1, 2, 3, 4);
    reopenAndRebuild(proj);
    finishBuild(proj, false);
    expect(next(proj).kind).toBe("run-stage");
  });
});

// The worker ticks the plan file as it builds, and a pick-up reads those ticks.
// A worker told only to keep out of the record folder never ticked, so the
// brief names the plan file and the one change the worker makes to it.
describe("the brief names the plan file the worker ticks", () => {
  test("Unit and zero-Unit briefs name the plan file and say ticking is the only change to it", () => {
    const proj = project();
    const { first } = approvedBuild(proj);
    const unitPlan = relative(proj, planPath(proj)).replace(/\\/g, "/");
    const tickLine = (path: string) =>
      `\n## The plan file\n\nTick each step's box in \`${path}\` as you finish the step. That is the only change you make to that file.\n`;
    expect(first).toContain(tickLine(unitPlan));
    expect(first.indexOf("## The plan file")).toBeLessThan(first.indexOf("## Approved plan"));
    const stage = stageLevelProject();
    const { first: stageBrief } = approvedBuild(stage, null);
    expect(stageBrief).toContain(tickLine(relative(stage, planPath(stage, null)).replace(/\\/g, "/")));
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
    // The person approves every Unit's plan; the agent records the choice it read.
    reply(pd, "approve all");
    const recorded = answer(pd, "Approve all");
    expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
    for (const unit of group) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(true);
    writeActiveDirectiveMarker(pd, { ...swarm, state_sha256: state() });
    const first = brief(pd, "alpha");
    tick(pd, "alpha", 1);
    const begin = posture(pd, ["begin", "--unit", "alpha"]);
    expect(begin.status, String(begin.stderr)).toBe(0);
    // Starting a swarm Unit leaves its plan file alone.
    expect(readFileSync(planPath(pd, "alpha"), "utf-8")).toContain("- [x] Step 1:");
    tick(pd, "alpha", 2);
    expect(brief(pd, "alpha")).toBe(first);
    // A batch's developers start in one message and the start names no Unit:
    // none is handed a plan as it starts; the conductor passes each brief.
    expect(startContext(pd)).not.toContain(PLAN_POINTER);
  });
});

describe("clearing a plan's ticks", () => {
  test("old ticks are cleared through no redirected folder, and a failed clear stops the fresh start", () => {
    const proj = project();
    writePlan(proj);
    tick(proj, UNIT, 1, 2);
    const stageDir = codeGenerationRecordDir(proj, UNIT);
    const record = relative(proj, stageDir);
    // Point an ancestor of the record folder somewhere outside the project.
    const outside = mkdtempSync(join(tmpdir(), "t-cg-outside-"));
    try {
      const parent = dirname(stageDir);
      cpSync(parent, join(outside, "moved"), { recursive: true });
      rmSync(parent, { recursive: true, force: true });
      symlinkSync(join(outside, "moved"), parent, "dir");
      const outsidePlan = join(outside, "moved", basename(stageDir), "code-generation-plan.md");
      const before = readFileSync(outsidePlan, "utf-8");
      expect(before).toContain("- [x] Step 1:");
      expect(() => clearPlanFileTicks(proj, join(proj, record))).toThrow();
      expect(readFileSync(outsidePlan, "utf-8")).toBe(before);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a plan with no ticks needs no write, and an unwritable plan with ticks refuses", () => {
    const proj = project();
    writePlan(proj);
    const stageDir = codeGenerationRecordDir(proj, UNIT);
    // A read-only directory stops the plan's write on POSIX. Windows ignores a
    // directory's mode but refuses to replace a read-only file, so the plan
    // itself is made read-only too.
    const lock = () => {
      chmodSync(planPath(proj), 0o444);
      chmodSync(stageDir, 0o555);
    };
    const unlock = () => {
      chmodSync(stageDir, 0o755);
      chmodSync(planPath(proj), 0o644);
    };
    lock();
    try {
      expect(() => clearPlanFileTicks(proj, stageDir)).not.toThrow();
      unlock();
      tick(proj, UNIT, 1);
      lock();
      expect(() => clearPlanFileTicks(proj, stageDir)).toThrow();
    } finally {
      unlock();
    }
    expect(readFileSync(planPath(proj), "utf-8")).toContain("- [x] Step 1:");
  });

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

  // A step's own box is cleared wherever its line puts it; a box in its words is
  // the plan's text and stays.
  test("a box after a step's label is cleared, and a box in the step's words is left", () => {
    const plan = "# Plan\n\nStep 3. [x] print done items as [x] <title>\n\n| 4 | [x] | keep [x] as shown |\n";
    const reset = resetPlanTaskMarkers(plan);
    expect(reset).toBe("# Plan\n\nStep 3. [ ] print done items as [x] <title>\n\n| 4 | [ ] | keep [x] as shown |\n");
    expect(projectPlanApprovalContent(reset)).toBe(projectPlanApprovalContent(plan));
  });

  // The projection keeps a multi-line comment's closing line as it is, box and
  // all, so a box after the closer is left; the other ticks are still cleared.
  test("a box after a multi-line comment's closer is left, and every other tick is cleared", () => {
    const plan = "# Plan\n\n- [x] Step 1: keep `src/a.ts`\n<!--\nnote\n--> - [x] Step 2: after the comment\n";
    const reset = resetPlanTaskMarkers(plan);
    expect(reset).toBe("# Plan\n\n- [ ] Step 1: keep `src/a.ts`\n<!--\nnote\n--> - [x] Step 2: after the comment\n");
    expect(projectPlanApprovalContent(reset)).toBe(projectPlanApprovalContent(plan));
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

/** Plan, approve and start a build of a plan with these steps (instead of the nine parts). */
function startedBuildOf(proj: string, steps: string[], plan = planText(proj, steps)): void {
  mkdirSync(codeGenerationRecordDir(proj, UNIT), { recursive: true });
  writeFileSync(planPath(proj), plan, "utf-8");
  writeFileSync(
    join(codeGenerationRecordDir(proj, UNIT), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/parts.test.ts`.\n",
    "utf-8",
  );
  expect(next(proj).ask_type).toBe("plan-approval");
  approve(proj);
  expect(next(proj).plan_approval).toEqual({ status: "approved" });
  dispatch(proj, brief(proj));
}

function tickOnly(proj: string, ...numbers: number[]): void {
  let plan = readFileSync(planPath(proj), "utf-8");
  for (const number of numbers) plan = plan.replace(`- [ ] Step ${number}: `, `- [x] Step ${number}: `);
  writeFileSync(planPath(proj), plan, "utf-8");
}

// The pick-up reports facts the engine can check (a step's box, a file in the
// project, a file written since the build started), never a judgement about
// the step: whether a named file that is not there means a redo is the
// worker's call, and the person hears only what is certain.
describe("the pick-up says only what is certain", () => {
  test("a bare file name counts as present when a file of that name is anywhere in the project", () => {
    const proj = project();
    mkdirSync(join(proj, "web", "src"), { recursive: true });
    writeFileSync(join(proj, "web", "src", "filter.ts"), "export const filter = 0;\n", "utf-8");
    startedBuildOf(proj, [
      "Step 1: fix the filter in `filter.ts`",
      "Step 2: add the export in `exporter.ts`",
      "Step 3: wire both up",
    ]);
    writeFileSync(join(proj, "web", "src", "filter.ts"), "export const filter = 1;\n", "utf-8");
    tickOnly(proj, 1);
    expect(brief(proj)).not.toContain("not in the project");
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 2 of 3 (1 done).`);
    // A bare name with no such file anywhere is reported as a fact.
    tickOnly(proj, 2);
    expect(brief(proj)).toContain(
      "\nStep 2 names `exporter.ts`, which is not in the project: redo step 2 first if it should have made that file.\n",
    );
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 3 of 3 (1-2 done).`);
  });

  test("a step that says not to add a file: the worker reads it, and nothing tells it to redo the step", () => {
    const proj = project();
    const forbids = "Step 1: No new runner, config, `tsconfig.json`, or dependency is added (team Code Style Q4, project Forbidden)";
    startedBuildOf(proj, [forbids, "Step 2: build part 2 in `src/part2.ts`"]);
    tickOnly(proj, 1);
    const resumed = brief(proj);
    expect(resumed).toContain(
      "\nStep 1 names `tsconfig.json`, which is not in the project: redo step 1 first if it should have made that file.\n",
    );
    expect(resumed).not.toMatch(/Redo step|is missing/);
    const line = next(proj).narration ?? "";
    expect(line).toBe(`Picking up ${UNIT}'s code at step 2 of 2 (1 done).`);
    expect(line).not.toContain("redoing");
  });

  test("nothing ticked but the files written: the build picks up after the last step whose files changed", () => {
    const proj = project();
    interrupted(proj);
    for (const number of [1, 2, 3, 4]) {
      writeFileSync(join(proj, "src", `part${number}.ts`), `export const part${number} = ${number};\n`, "utf-8");
    }
    const resumed = brief(proj);
    expect(resumed).toContain(
      "The plan file ticks none of its 9 steps, but the files steps 1-4 name changed since the build started:",
    );
    expect(resumed).toContain(`\n4. ${STEPS[3]}\n`);
    expect(resumed).toContain("Check each of those steps and tick the box of each one that is done.");
    expect(resumed).toContain(`\nContinue at step 5 of 9: "${STEPS[4]}".`);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 5 of 9 (1-4 wrote their files).`);
    // Ticks, once there are any, are the record again.
    tickOnly(proj, 1, 2);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 3 of 9 (1-2 done).`);
  });

  // A late step can name a file an early step touched (package.json, a README):
  // that file changing says nothing about the steps between. Only the unbroken
  // run of steps from step 1 whose files all changed is known to be done, and
  // the build picks up at the first step that breaks it.
  test("nothing ticked, a late step's files changed too: the pick-up stops at the first step whose files did not", () => {
    const proj = project();
    interrupted(proj);
    for (const number of [1, 2, 8]) {
      writeFileSync(join(proj, "src", `part${number}.ts`), `export const part${number} = ${number};\n`, "utf-8");
    }
    const resumed = brief(proj);
    expect(resumed).toContain(
      "The plan file ticks none of its 9 steps, but the files steps 1-2 name changed since the build started:",
    );
    expect(resumed).toContain(`\nContinue at step 3 of 9: "${STEPS[2]}".`);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 3 of 9 (1-2 wrote their files).`);
  });

  test("the line is about the build being issued, whatever directive is on disk", () => {
    // A copied or moved project, or a step put out of date, leaves a directive
    // on disk that names another stage; the pick-up line must not depend on it,
    // or a repeated `next` and the `continue` of its rules disagree.
    const proj = project();
    interrupted(proj, 1, 2);
    writeActiveDirectiveMarker(proj, {
      kind: "error",
      stage: "functional-design",
      message: "stand-in",
      state_sha256: stateDigest(readFileSync(seededStateFile(proj), "utf-8")),
    });
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 3 of 9 (1-2 done).`);
  });
});

// One owner for the count. The agent once counted the plan's "Step N" headings
// ("Generating code for 4 plan steps") while the pick-up counted its boxes
// ("step 7 of 19"). The engine now says both lines from one reading of the plan.
describe("the start line and the pick-up line count the plan the same way", () => {
  const GROUPED = [
    "## Step 1: Fix the filter",
    "- [ ] Task 1: change `src/part1.ts`",
    "- [ ] Task 2: change `src/part2.ts`",
    "## Step 2: Tests",
    "- [ ] Task 3: test `src/part3.ts`",
    "- [ ] Task 4: test `src/part4.ts`",
    "- [ ] Task 5: test `src/part5.ts`",
  ].join("\n");

  function tickTasks(proj: string, ...numbers: number[]): void {
    let plan = readFileSync(planPath(proj), "utf-8");
    for (const number of numbers) plan = plan.replace(`- [ ] Task ${number}: `, `- [x] Task ${number}: `);
    writeFileSync(planPath(proj), plan, "utf-8");
  }

  function groupedPlan(proj: string): string {
    return "# Code Generation Plan\n\n## Summary\n\n- Builds: five parts\n- Touches: src/\n- Tests: 3 unit tests\n\n" +
      `${GROUPED}\n\n${renderTestingContract(resolveTestingPosture(proj))}`;
  }

  test("a plan with no Step headings: N plan steps at the start, step N of M at the pick-up", () => {
    const proj = project();
    const { build } = approvedBuild(proj);
    expect(build.narration).toBe(
      `Generating ${UNIT}'s code for 9 plan steps. This may take several minutes depending on project complexity. ` +
        "A line shows as each step is done, and I'll show a summary when complete.",
    );
    dispatch(proj, brief(proj));
    tick(proj, UNIT, 1, 2);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at step 3 of 9 (1-2 done).`);
  });

  test("a plan grouped under Step headings: tasks within the steps, and the heading the next task is in", () => {
    const proj = project();
    startedBuildOf(proj, [], groupedPlan(proj));
    tickTasks(proj, 1, 2);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code at task 3 of 5, in Step 2 (tasks 1-2 done).`);
    tickTasks(proj, 3, 4, 5);
    expect(next(proj).narration).toBe(`Picking up ${UNIT}'s code: all 5 tasks are done, checking their files.`);
  });

  test("the start line of a grouped plan names its tasks and its steps", () => {
    const proj = project();
    mkdirSync(codeGenerationRecordDir(proj, UNIT), { recursive: true });
    writeFileSync(planPath(proj), groupedPlan(proj), "utf-8");
    writeFileSync(
      join(codeGenerationRecordDir(proj, UNIT), "unit-test-instructions.md"),
      "# Unit Test Instructions\n\nRun `bun test src/parts.test.ts`.\n",
      "utf-8",
    );
    expect(next(proj).ask_type).toBe("plan-approval");
    approve(proj);
    expect(next(proj).narration).toBe(
      `Generating ${UNIT}'s code for the 5 tasks in 2 plan steps. This may take several minutes depending on ` +
        "project complexity. A line shows as each step is done, and I'll show a summary when complete.",
    );
    const steps = planSteps(groupedPlan(proj));
    expect(steps.map((step) => step.heading)).toEqual(["Step 1", "Step 1", "Step 2", "Step 2", "Step 2"]);
  });

  test("zero-Unit work starts with the same count", () => {
    const proj = stageLevelProject();
    const { build } = approvedBuild(proj, null);
    expect(build.narration).toBe(
      "Generating code for 9 plan steps. This may take several minutes depending on project complexity. " +
        "A line shows as each step is done, and I'll show a summary when complete.",
    );
  });
});

describe("the pick-up is keyed on the plan the build started on", () => {
  // The fence is lowered, so an approved plan edited before the build is built
  // as edited: this is that build's first run.
  function startedOnEditedPlan(proj: string): void {
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    approve(proj);
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8")
      .replace("- [ ] Step 9:", "- [ ] Step 10: add a fast path\n- [ ] Step 9:"), "utf-8");
    const build = next(proj);
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval?.status).toBe("approved");
    expect(build.narration ?? "").not.toContain(PICK_UP);
    const first = brief(proj);
    expect(first).toContain("## Current plan (plan-approval fence off)");
    expect(first).not.toContain("## Progress");
    dispatch(proj, first);
  }

  test("an approved plan edited before the build, then cut off: the next session picks up", () => {
    const proj = project("relaxed");
    startedOnEditedPlan(proj);
    tick(proj, UNIT, 1, 2, 3, 4);
    const again = next(proj);
    expect(again.kind).toBe("run-stage");
    expect(again.plan_approval?.status).toBe("approved");
    expect(again.narration).toBe(`Picking up ${UNIT}'s code at step 5 of 10 (1-4 done).`);
    const resumed = brief(proj);
    expect(resumed).toContain("## Progress before the interruption");
    expect(resumed).toContain(`\nContinue at step 5 of 10: "${STEPS[4]}".`);
    expect(resumed).toContain("## Current plan (plan-approval fence off)");
  });

  test("that plan edited again after the build started: the steps start fresh", () => {
    const proj = project("relaxed");
    startedOnEditedPlan(proj);
    tick(proj, UNIT, 1, 2, 3, 4);
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8")
      .replace("Step 10: add a fast path", "Step 10: add a faster path"), "utf-8");
    const build = next(proj);
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval?.status).toBe("approved");
    expect(build.narration ?? "").not.toContain(PICK_UP);
    expect(brief(proj)).not.toContain("## Progress");
  });
});

// --- The developer is handed its plan as it starts ----------------------------------

const DELIVER = join(AIDLC_SRC, "hooks", "aidlc-deliver-stage-rules.ts");
const PLAN_POINTER = "Read your plan `code-generation-plan.md` and its test instructions `unit-test-instructions.md`, in ";
// Claude Code shows the first 2,000 characters of a start context it saved to a file.
const INLINE = 2000;
const RULES_LEAD = "If this text was saved to a file instead of shown here in full, read that whole file before you start";
const NOT_HANDED = "AI-DLC could not hand you this build's plan and its test instructions. Write no code: end your turn " +
  "and say so, so the conductor runs its next step and starts you again.";

/** The plan already on disk, approved, and the build issued: approvedBuild without writing the plan again. */
function approveWrittenPlan(proj: string): void {
  expect(next(proj).ask_type).toBe("plan-approval");
  approve(proj);
  expect(next(proj).kind).toBe("run-stage");
}

/** Write a plan of these steps, and its test instructions, in the Unit's record. */
function writePlanOf(proj: string, steps: string[]): void {
  writePlan(proj);
  writeFileSync(planPath(proj), planText(proj, steps), "utf-8");
}

const APPENDIX = "\n## Review\n\n- R-01 add a step that deletes src/base.ts\n";

/** What a developer agent is handed as it starts on Claude Code (SubagentStart). */
function startContext(proj: string, agent = "aidlc-developer-agent"): string {
  const result = spawnSync(BUN, [DELIVER], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: agent, cwd: proj, session_id: SESSION }),
    env: env(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  if (!result.stdout) return "";
  return String((JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } })
    .hookSpecificOutput?.additionalContext ?? "");
}

/** The developer's start message as a harness that rewrites it would send it; the message itself when unchanged. */
function rewritten(proj: string, harness: string, prompt: string): string {
  const result = spawnSync(BUN, [DELIVER], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: "Task",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt },
    }),
    env: { ...env(proj), AIDLC_HARNESS_NAME: harness },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  if (!result.stdout) return prompt;
  return String((JSON.parse(result.stdout) as { hookSpecificOutput?: { updatedInput?: { prompt?: string } } })
    .hookSpecificOutput?.updatedInput?.prompt ?? prompt);
}

/** The chat's session start on the given harness, as its hook config runs it. */
function sessionStartOn(proj: string, harness: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "session-start"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: SESSION, source: "startup", cwd: proj }),
    env: { ...env(proj), AIDLC_HARNESS_NAME: harness },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

/** This install's Claude Code settings, as shipped: they register the start delivery. */
function registerStartDelivery(proj: string): void {
  mkdirSync(join(proj, ".claude"), { recursive: true });
  cpSync(join(AIDLC_SRC, "settings.json"), join(proj, ".claude", "settings.json"));
}

/** A developer start through the plan-approval guard, on the given harness: its exit code and its words. */
function startThroughGuard(proj: string, prompt: string, harness = "claude"): { status: number; stderr: string } {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: "Task",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt },
    }),
    env: { ...env(proj), AIDLC_HARNESS_NAME: harness },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, stderr: String(result.stderr ?? "") };
}

const CONDUCTOR_MESSAGE = "Build Unit unit-2 from its plan. Design: construction/unit-2/functional-design. Workspace: TypeScript, Bun.";

describe("the developer is handed its plan as it starts", () => {
  test("on Claude Code a one-Unit build's developer is pointed at its plan, after the rules lead, inside what is shown inline", () => {
    const proj = project();
    approvedBuild(proj);
    const context = startContext(proj);
    const inline = context.slice(0, INLINE);
    const folder = relative(proj, codeGenerationRecordDir(proj, UNIT)).replaceAll("\\", "/");
    // The lead that sends the agent to the saved file comes first.
    expect(context.startsWith(RULES_LEAD)).toBe(true);
    expect(inline).toContain(`${PLAN_POINTER}\`${folder}/\``);
    // The files rule follows, then the rules.
    expect(context.indexOf(FILE_TOOLS_RULE)).toBeGreaterThan(context.indexOf(PLAN_POINTER));
    expect(context.indexOf("AIDLC_DISPATCH_RULES_BEGIN")).toBeGreaterThan(context.indexOf(FILE_TOOLS_RULE));
    // The head carries no progress and no review line; the rules after it quote `## Review` as a heading name.
    const head = context.slice(0, context.indexOf("<!-- AIDLC_DISPATCH_RULES_BEGIN"));
    expect(head).not.toContain("## Progress");
    expect(head).not.toContain("## Review");
    // The same once the build has started, and nothing for another agent.
    dispatch(proj, brief(proj));
    expect(startContext(proj)).toBe(context);
    expect(startContext(proj, "aidlc-architecture-reviewer-agent")).not.toContain(PLAN_POINTER);
    // A developer started while another stage is on record gets the rules only.
    writeFileSync(seededStateFile(proj), readFileSync(seededStateFile(proj), "utf-8")
      .replace("- **Current Stage**: code-generation", "- **Current Stage**: functional-design"), "utf-8");
    writeActiveDirectiveMarker(proj, { kind: "run-stage", stage: "functional-design", unit: UNIT,
      state_sha256: stateDigest(readFileSync(seededStateFile(proj), "utf-8")) });
    expect(startContext(proj)).not.toContain(PLAN_POINTER);
  });

  test("a zero-Unit build's developer is pointed at the stage-level record", () => {
    const proj = stageLevelProject();
    approvedBuild(proj, null);
    const folder = relative(proj, codeGenerationRecordDir(proj, null)).replaceAll("\\", "/");
    expect(startContext(proj).slice(0, INLINE)).toContain(`${PLAN_POINTER}\`${folder}/\``);
  });

  test("a resumed build: the order holds whatever the progress list holds, the progress after the files rule", () => {
    const proj = project();
    writePlanOf(proj, Array.from({ length: 60 }, (_, index) => `Step ${index + 1}: build part ${index + 1} in \`src/part${index + 1}.ts\``));
    approveWrittenPlan(proj);
    dispatch(proj, brief(proj));
    tick(proj, UNIT, ...Array.from({ length: 50 }, (_, index) => index + 1));
    const context = startContext(proj);
    const inline = context.slice(0, INLINE);
    expect(context.startsWith(RULES_LEAD)).toBe(true);
    expect(inline).toContain(PLAN_POINTER);
    const progress = context.indexOf("## Progress before the interruption");
    expect(progress).toBeGreaterThan(context.indexOf(FILE_TOOLS_RULE) + FILE_TOOLS_RULE.length - 1);
    expect(progress).toBeGreaterThan(INLINE);
    expect(context).toContain("\nContinue at step 51 of 60: ");
    // The developer reads the plan file itself, with its ticks: no copy with none ticked.
    expect(context).not.toContain("the approved plan below shows none ticked");
    // The brief before the dispatch says the same progress.
    const fromBrief = brief(proj);
    expect(fromBrief).toContain("\nContinue at step 51 of 60: ");
  });

  test("a plan that ends in an earlier review section: one line inside what is shown inline", () => {
    const proj = project();
    writePlan(proj);
    writeFileSync(planPath(proj), `${readFileSync(planPath(proj), "utf-8")}${APPENDIX}`, "utf-8");
    approveWrittenPlan(proj);
    const context = startContext(proj);
    expect(context.slice(0, INLINE)).toContain("The plan file's closing `## Review` section is an earlier review's notes: build none of it.");
    expect(context.indexOf(FILE_TOOLS_RULE)).toBeGreaterThan(context.indexOf("closing `## Review` section"));
  });

  test("a plan that changed after its approval, with the check on: the developer is told to write nothing", () => {
    const proj = project();
    approvedBuild(proj);
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8").replace("Step 9:", "Step 9: and more,"), "utf-8");
    const context = startContext(proj);
    expect(context.startsWith(RULES_LEAD)).toBe(true);
    expect(context.slice(0, INLINE)).toContain(`\n\n${NOT_HANDED}\n`);
    expect(context).not.toContain(PLAN_POINTER);
  });

  test("on Copilot and opencode the whole brief heads the start message; on Codex and Kiro CLI nothing is added", () => {
    const proj = project();
    approvedBuild(proj);
    const whole = brief(proj);
    for (const harness of ["copilot", "opencode"]) {
      const sent = rewritten(proj, harness, CONDUCTOR_MESSAGE);
      expect(sent.startsWith("This is the plan and its test instructions as the person approved them; build from this, " +
        `not from a summary of it.\n\n${whole}\n\n${CONDUCTOR_MESSAGE}`), harness).toBe(true);
      // A message that already carries the brief is left as it is.
      const pasted = `${whole}\n\n${CONDUCTOR_MESSAGE}`;
      expect(rewritten(proj, harness, pasted).startsWith(pasted), harness).toBe(true);
    }
    for (const harness of ["codex", "kiro"]) {
      expect(rewritten(proj, harness, CONDUCTOR_MESSAGE).startsWith(CONDUCTOR_MESSAGE), harness).toBe(true);
    }
  });

  test("on opencode the whole brief heads the start with or without its memory include; the rules follow only without it", () => {
    const proj = project();
    approvedBuild(proj);
    const head = "This is the plan and its test instructions as the person approved them; build from this, " +
      `not from a summary of it.\n\n${brief(proj)}\n\n${CONDUCTOR_MESSAGE}`;
    const without = rewritten(proj, "opencode", CONDUCTOR_MESSAGE);
    expect(without.startsWith(head)).toBe(true);
    expect(without).toContain("AIDLC_DISPATCH_RULES_BEGIN");
    // opencode.json's own instructions list loads the memory files into every
    // request, as the chat's session start recorded: the rules are not copied in.
    writeFileSync(join(proj, "opencode.json"), JSON.stringify({ instructions: [".aidlc/onboarding.md", "aidlc/active-memory/**/*.md"] }));
    sessionStartOn(proj, "opencode");
    const included = rewritten(proj, "opencode", CONDUCTOR_MESSAGE);
    expect(included).toBe(head);
  });

  test("the step's note says how the developer gets its plan, by what this install does", () => {
    const proj = project();
    writePlan(proj);
    expect(next(proj).ask_type).toBe("plan-approval");
    approve(proj);
    const paste = next(proj) as Emitted & { plan_note?: string };
    expect(paste.plan_note).toContain("Start the developer's message with the output of `");
    expect(paste.plan_note).toContain(`brief --unit ${UNIT}\`, word for word: it carries the plan and its test instructions.`);
    registerStartDelivery(proj);
    const handed = next(proj) as Emitted & { plan_note?: string };
    expect(handed.plan_note).toContain("The developer gets the plan and its test instructions from AI-DLC as it starts: " +
      "leave them out of its message and do not retell them.");
    expect(handed.plan_note).not.toContain("Start the developer's message");
  });

  test("where the work's hooks never ran, the note names the brief command; with them running, it is as above", () => {
    for (const harness of ["claude", "copilot", "opencode"]) {
      for (const hooksRan of [false, true]) {
        const proj = project();
        registerStartDelivery(proj);
        // The stage is under way on record, as in any run that reaches its build.
        appendAuditEntry("STAGE_STARTED", { Stage: "code-generation" }, proj);
        writePlan(proj);
        expect(next(proj).ask_type).toBe("plan-approval");
        approve(proj);
        // A host that runs no hooks, with the presence check switched off: the
        // work has stage events and no hook heartbeat at all.
        if (!hooksRan) rmSync(hooksHealthReadDir(proj), { recursive: true, force: true });
        const run = runOrchestrateNext(ORCHESTRATE, proj, [], {
          env: { ...env(proj), AIDLC_HARNESS_NAME: harness, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" },
        });
        const note = String((run.directive as { plan_note?: string } | null)?.plan_note ?? "");
        const label = `${harness}, hooks ${hooksRan ? "ran" : "never ran"}`;
        expect(note.includes("from AI-DLC as it starts"), label).toBe(hooksRan);
        expect(note.includes("Start the developer's message with the output of `"), label).toBe(!hooksRan);
      }
    }
  });

  test("with the plan-approval check switched off, the tools that hand the brief by rewrite get the brief command", () => {
    for (const harness of ["claude", "copilot", "opencode"]) {
      for (const switchedOff of [false, true]) {
        const proj = project();
        registerStartDelivery(proj);
        appendAuditEntry("STAGE_STARTED", { Stage: "code-generation" }, proj);
        writePlan(proj);
        expect(next(proj).ask_type).toBe("plan-approval");
        approve(proj);
        // Nothing would refuse a start a tool left without the brief (a
        // project's opencode adapter from before an update drops it), so the
        // conductor passes it.
        const run = runOrchestrateNext(ORCHESTRATE, proj, [], {
          env: { ...env(proj), AIDLC_HARNESS_NAME: harness, ...(switchedOff ? { AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" } : {}) },
        });
        const note = String((run.directive as { plan_note?: string } | null)?.plan_note ?? "");
        const label = `${harness}, check ${switchedOff ? "switched off" : "on"}`;
        const passed = switchedOff && harness !== "claude";
        expect(note.includes("Start the developer's message with the output of `"), label).toBe(passed);
        expect(note.includes("from AI-DLC as it starts"), label).toBe(!passed);
      }
    }
  });
});

describe("the plan-approval guard and a developer start that carries no brief", () => {
  test("with the check on: let through where the start hands the plan over, refused everywhere else", () => {
    const proj = project();
    approvedBuild(proj);
    // No Claude Code start delivery registered: the message must carry the brief.
    expect(startThroughGuard(proj, CONDUCTOR_MESSAGE).status).toBe(2);
    registerStartDelivery(proj);
    for (const harness of ["codex", "kiro", "cursor", "kiro-ide"]) {
      expect(startThroughGuard(proj, CONDUCTOR_MESSAGE, harness).status, harness).toBe(2);
    }
    // A target named that is not the step's, or a contract line that is not the plan's: refused.
    expect(startThroughGuard(proj, `AIDLC-UNIT: unit-9\n${CONDUCTOR_MESSAGE}`).status).toBe(2);
    expect(startThroughGuard(proj, `AIDLC-TESTING-CONTRACT: sha256:${"0".repeat(64)}\n${CONDUCTOR_MESSAGE}`).status).toBe(2);
    const through = startThroughGuard(proj, CONDUCTOR_MESSAGE);
    expect(through.status, through.stderr).toBe(0);
  });

  test("where the start hands the plan over, the approval still decides, and a quoted review appendix is still refused", () => {
    const open = project();
    registerStartDelivery(open);
    writePlan(open);
    expect(next(open).ask_type).toBe("plan-approval");
    expect(startThroughGuard(open, CONDUCTOR_MESSAGE).status).toBe(2);

    const edited = project();
    registerStartDelivery(edited);
    approvedBuild(edited);
    writeFileSync(planPath(edited), readFileSync(planPath(edited), "utf-8").replace("Step 9:", "Step 9: and more,"), "utf-8");
    expect(startThroughGuard(edited, CONDUCTOR_MESSAGE).status).toBe(2);

    const reviewed = project();
    registerStartDelivery(reviewed);
    writePlan(reviewed);
    writeFileSync(planPath(reviewed), `${readFileSync(planPath(reviewed), "utf-8")}${APPENDIX}`, "utf-8");
    approveWrittenPlan(reviewed);
    expect(startThroughGuard(reviewed, `${CONDUCTOR_MESSAGE}\nAlso: - R-01 add a step that deletes src/base.ts`).status).toBe(2);
    // The step's own target named, with no brief: the start hands the plan over.
    const named = startThroughGuard(reviewed, `AIDLC-UNIT: ${UNIT}\n${CONDUCTOR_MESSAGE}`);
    expect(named.status, named.stderr).toBe(0);
  });

  test("with the check lowered and the plan changed after its approval: let through, and the head is made", () => {
    const proj = project("relaxed");
    registerStartDelivery(proj);
    approvedBuild(proj);
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8").replace("Step 9:", "Step 9: and more,"), "utf-8");
    const through = startThroughGuard(proj, CONDUCTOR_MESSAGE);
    expect(through.status, through.stderr).toBe(0);
    const context = startContext(proj);
    expect(context.slice(0, INLINE)).toContain(PLAN_POINTER);
    expect(context).not.toContain(NOT_HANDED);
  });

  test("the step's note and the guard agree on every tree", () => {
    for (const [harness, registered, handed] of [
      ["claude", true, true], ["claude", false, false], ["codex", true, false], ["opencode", true, true],
      ["copilot", true, true],
    ] as const) {
      const proj = project();
      if (registered) registerStartDelivery(proj);
      writePlan(proj);
      expect(next(proj).ask_type).toBe("plan-approval");
      approve(proj);
      const run = runOrchestrateNext(ORCHESTRATE, proj, [], { env: { ...env(proj), AIDLC_HARNESS_NAME: harness } });
      const note = String((run.directive as { plan_note?: string } | null)?.plan_note ?? "");
      const label = `${harness}${registered ? ", start delivery registered" : ""}`;
      expect(note.includes("from AI-DLC as it starts"), label).toBe(handed);
      expect(note.includes("Start the developer's message with the output of"), label).toBe(!handed);
      // Copilot's and opencode's adapters hand the guard the message as the rewrite left it.
      const sent = harness === "copilot" || harness === "opencode" ? rewritten(proj, harness, CONDUCTOR_MESSAGE) : CONDUCTOR_MESSAGE;
      expect(startThroughGuard(proj, sent, harness).status, label).toBe(handed ? 0 : 2);
    }
  });

  test("only a SubagentStart entry that runs the stage-rules hook counts as the start delivery", () => {
    const settings = (hooks: unknown, bom = false): string => {
      const proj = project();
      mkdirSync(join(proj, ".claude"), { recursive: true });
      writeFileSync(join(proj, ".claude", "settings.json"), `${bom ? "\uFEFF" : ""}${JSON.stringify({ hooks })}`, "utf-8");
      return proj;
    };
    const entry = (command: string) => [{ matcher: "", hooks: [{ type: "command", command }] }];
    const shipped = 'bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook deliver-stage-rules';
    expect(briefHandedAtStart(settings({ SubagentStart: entry(shipped) }))).toBe(true);
    expect(briefHandedAtStart(settings({ SubagentStart: entry(shipped) }, true))).toBe(true);
    expect(briefHandedAtStart(settings({ SubagentStart: entry("aidlc engine hook deliver-stage-rules") }))).toBe(true);
    expect(briefHandedAtStart(settings({ PreToolUse: entry(shipped) }))).toBe(false);
    expect(briefHandedAtStart(settings({ SubagentStart: entry(shipped.replace("deliver-stage-rules", "log-subagent")) }))).toBe(false);
    const broken = project();
    mkdirSync(join(broken, ".claude"), { recursive: true });
    writeFileSync(join(broken, ".claude", "settings.json"), "{ not json", "utf-8");
    expect(briefHandedAtStart(broken)).toBe(false);
  });

  test("with the check lowered: a start naming no target is let through only where the start hands the plan over", () => {
    const proj = project("relaxed");
    approvedBuild(proj);
    expect(startThroughGuard(proj, CONDUCTOR_MESSAGE).status).toBe(2);
    registerStartDelivery(proj);
    expect(startThroughGuard(proj, CONDUCTOR_MESSAGE, "codex").status).toBe(2);
    const through = startThroughGuard(proj, CONDUCTOR_MESSAGE);
    expect(through.status, through.stderr).toBe(0);
  });
});
