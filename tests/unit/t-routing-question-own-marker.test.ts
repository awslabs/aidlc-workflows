// covers: subcommand:aidlc-orchestrate:next, function:notePlanApprovalAskReply, function:consumeSharedDirectiveAsk,
// function:planApprovalKeptReplyWaits, function:openEngineQuestion, function:recordProtectedHumanResponse
//
// A number typed for a question the engine asks while another of its questions
// is open answers nothing by itself. With the code plan question open, a
// person typed "/aidlc also add a test for an empty title"; the agent asked
// where that work belongs ("Is this (1) part of that work ..."), and the
// person's "1" was once recorded as Approve Plan in their name: the build
// started without their test. No hook reads a typed reply for a pick now; the
// agent reads which question it answers, so:
//
//   - the number records nothing for the plan question, under Guard Policy off
//     and strict, through every harness's human-turn hook;
//   - "part of that work" asks the plan question again with the person's words
//     as their reply to it, so the change they asked for reaches the plan;
//   - the same holds for the new-work plan offer ("/aidlc --new-intent ..."),
//     a guard-recovery question (a routing "1" picks no remedy), and a Unit
//     checkpoint or verification-command question, in the chat that asked it
//     or in a new chat, and a stage's approval gate: a message sent while
//     another engine question is on screen (its HUMAN_TURN row names it) is
//     never their pick, nor counted as their reply to the gate or checkpoint,
//     nor handed to a later chat as their answer to the stage's own questions,
//     unless the agent names it with --message for the question it answered.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  followProposal,
  REPO_ROOT,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  latestMainWorkflowStageRunFloorForProject,
  personsGateReply,
  readAuditShardEvents,
  readProtectedResponse,
  reviewArtifactFingerprint,
  stateDigest,
  writeActiveDirectiveMarker,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  codeGenerationRecordDir,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION = "01995000-7a11-7000-8000-00000000b001";
const NEW_CHAT = "01995000-7a11-7000-8000-00000000b002";
const CHANGE = "also add a test for an empty title";

type Policy = "off" | "strict";
type Harness = "claude" | "kiro" | "kiro-ide" | "codex";

interface Emitted {
  kind: string;
  ask_type?: string;
  message?: string;
  continue_command?: string;
  new_intent_command?: string;
  compose_command?: string;
  plan_approval?: { status?: string; feedback?: string; editing?: boolean };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

// A one-step bug fix at Code Generation, its plan written and not yet approved.
function project(policy: Policy): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope bugfix)",
      policy === "off" ? "- **Guard Policy**: off (from scope bugfix)" : "- **Guard Policy**: strict (set by you)")
    .replace("- **Summary Confirmation**: on (from scope bugfix)", "- **Summary Confirmation**: off (from scope bugfix)")
    .replace("- **Learnings**: on (from scope bugfix)", "- **Learnings**: off (from scope bugfix)")
    .replace("- [-] requirements-analysis ", "- [x] requirements-analysis ")
    .replace("- [ ] code-generation ", "- [-] code-generation ")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
    .replace(/^- \*\*Lifecycle Phase\*\*:.*$/m, "- **Lifecycle Phase**: CONSTRUCTION")
    .replace("- **Inception**: Active", "- **Inception**: Verified")
    .replace("- **Construction**: Pending", "- **Construction**: Active");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "todo.ts"), "export const todo = (title: string) => title;\n", "utf-8");
  const requirements = join(seededRecordDir(proj), "inception", "requirements-analysis");
  mkdirSync(requirements, { recursive: true });
  writeFileSync(join(requirements, "requirements.md"), "# Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
  const dir = stageDir(proj);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: the blank-title fix\n- Touches: src/todo.ts\n" +
      "- Tests: 1 regression test\n\n## Steps\n\n- [ ] Step 1: add a failing test for a blank title in `src/todo.test.ts`\n" +
      "- [ ] Step 2: refuse a blank title in `src/todo.ts`\n\n" + renderTestingContract(resolveTestingPosture(proj)), "utf-8");
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/todo.test.ts`.\n", "utf-8");
  return proj;
}

const stageDir = (proj: string) => join(seededRecordDir(proj), "construction", "code-generation");

// Production guards, as a person's run has them: the fixture profile skips the
// human-presence check these cases are about.
function env(proj: string): NodeJS.ProcessEnv {
  return {
    ...testGuardEnvironment(process.env, "production"),
    CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
  };
}

function next(proj: string, args: string[] = []): Emitted {
  const options = { env: env(proj) };
  const result = followProposal(runOrchestrateNext(ORCHESTRATE, proj, args, options), ORCHESTRATE, proj, options);
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

function nextNamed(proj: string, command: string | undefined): Emitted {
  expect(command).toMatch(/ next( [\w-]+)+$/);
  return next(proj, (command as string).replace(/^.* next /, "").split(" "));
}

function run(proj: string, args: string[], input: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(BUN, args, {
    cwd: proj,
    input,
    env: { ...env(proj), ...extraEnv },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

// The person types `prompt`, through the host's own human-turn hook.
function say(proj: string, prompt: string, harness: Harness = "claude", session = SESSION, turn = "t1"): void {
  if (harness === "claude") {
    run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: proj, prompt }));
    return;
  }
  const tree = harness === "codex" ? ".codex" : ".kiro";
  if (!existsSync(join(proj, tree))) cpSync(join(REPO_ROOT, "dist", harness, tree), join(proj, tree), { recursive: true });
  const unset = { CLAUDE_PROJECT_DIR: undefined, AIDLC_UNATTENDED: undefined, USER_PROMPT: undefined };
  if (harness === "codex") {
    writeSessionPidEntry(proj, process.pid, SESSION);
    run(proj, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: turn, cwd: proj, prompt }),
      { ...unset, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined });
    return;
  }
  run(proj, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), harness === "kiro" ? "verb-intercept" : "record-human-turn"],
    JSON.stringify({ hook_event_name: harness === "kiro" ? "userPromptSubmit" : "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }),
    unset);
}

function answer(proj: string, details: string): string {
  const result = spawnSync(BUN, [
    LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", details, "--project-dir", proj,
  ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout;
}

// The message of the answer command's JSON line.
const recordedMessage = (out: string): string =>
  (JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { message?: string }).message ?? out;

function planAnswers(proj: string): string[] {
  return readAuditShardEvents(proj)
    .filter((row) => ["PLAN_APPROVAL_RECORDED", "QUESTION_ANSWERED"].includes(row.event) &&
      auditBlockField(row.block, "Checkpoint") === "plan-approval")
    .map((row) => `${row.event}: ${auditBlockField(row.block, "Details")}`);
}

function blankAnswer(proj: string): boolean {
  return /^\[Answer\]:[ \t]*$/m.test(readFileSync(join(stageDir(proj), "code-generation-questions.md"), "utf-8"));
}

function routingQuestionOverThePlan(proj: string, planQuestionOpen = true): Emitted {
  if (planQuestionOpen) expect(next(proj).ask_type).toBe("plan-approval");
  say(proj, `/aidlc ${CHANGE}`);
  const print = next(proj, [CHANGE]);
  expect(print.kind, JSON.stringify(print)).toBe("print");
  // Their words may answer the plan question as a change: the step says where
  // the agent passes it, or the revision asks them again what to change.
  if (planQuestionOpen) expect(print.message).toContain("--details 'Request Changes: <what they asked>'");
  const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(print.message ?? "")?.[1];
  expect(request, print.message).toBeDefined();
  const routing = next(proj, (request as string).split(" "));
  expect(routing.ask_type, JSON.stringify(routing)).toBe("new-work-routing");
  return routing;
}

describe("a misplaced --choice returns the agent to the pending answer command", () => {
  for (const harness of ["claude", "codex"] as const) {
    for (const words of ["Approve Plan", "looks good, build it"]) {
      test(`${harness}: ${words} is recorded once without a new-work question`, () => {
        const proj = project("strict");
        expect(next(proj).ask_type).toBe("plan-approval");
        say(proj, words, harness);
        const before = planAnswers(proj);
        const correction = next(proj, ["--choice", "Approve Plan"]);
        expect(correction.kind, JSON.stringify(correction)).toBe("print");
        expect(correction.message).toContain("answer --stage code-generation --checkpoint plan-approval");
        expect(correction.message).not.toContain("--request");
        expect(planAnswers(proj)).toEqual(before);
        answer(proj, "Approve Plan");
        const recorded = planAnswers(proj);
        expect(recorded).toContain("PLAN_APPROVAL_RECORDED: Approve Plan");
        // The existing answer owner handles a retry; next does not become a
        // second approval writer and the human is not asked to approve again.
        answer(proj, "Approve Plan");
        expect(planAnswers(proj)).toEqual(recorded);
        expect(next(proj).plan_approval?.status).toBe("approved");
      });
    }
  }

  for (const args of [["--choice", "Approve Plan"], ["--choice=Approve Plan"], ["--choice"]]) {
    test(`an argument without a human reply grants no approval: ${args.join(" ")}`, () => {
      const proj = project("strict");
      expect(next(proj).ask_type).toBe("plan-approval");
      const correction = next(proj, args);
      expect(correction.kind, JSON.stringify(correction)).toBe("print");
      expect(correction.message).toContain("answer --stage code-generation --checkpoint plan-approval");
      expect(correction.message).not.toContain("--request");
      const refused = spawnSync(BUN, [
        LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
        "--details", "Approve Plan", "--project-dir", proj,
      ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
      expect(refused.status).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).toContain("has not replied to the plan question");
      expect(planAnswers(proj)).toEqual([]);
      expect(blankAnswer(proj)).toBe(true);
      expect(next(proj).ask_type).toBe("plan-approval");
    });
  }
});

// The agent reports the approval with the verb it knows for a stage gate while
// the open question is the engine's plan question. The step it reads back is
// that question's answer command; nothing is recorded, nothing is re-asked.
describe("a stage report of the approval while the plan question is open names the plan answer command", () => {
  for (const replied of [true, false]) {
    test(replied ? "with the person's reply on record" : "with no reply yet", () => {
      const proj = project("strict");
      expect(next(proj).ask_type).toBe("plan-approval");
      if (replied) say(proj, "Approve Plan");
      const before = planAnswers(proj);
      const result = spawnSync(BUN, [
        ORCHESTRATE, "report", "--stage", "code-generation", "--result", "approved", "--project-dir", proj,
      ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
      const line = (result.stdout ?? "").split("\n").filter((entry) => entry.startsWith("{")).pop();
      expect(line, `${result.stdout}${result.stderr}`).toBeDefined();
      const step = JSON.parse(line as string) as Emitted;
      expect(step.kind, JSON.stringify(step)).toBe("print");
      expect(step.message).toContain("answer --stage code-generation --checkpoint plan-approval");
      expect(step.message).not.toContain("show the gate");
      expect(step.message).not.toContain("No reply from the person is on record");
      expect(planAnswers(proj)).toEqual(before);
      expect(readAuditShardEvents(proj).some((row) => row.event === "GATE_APPROVED")).toBe(false);
      // The command the step names: the agent records the answer it read.
      if (replied) {
        const recorded = spawnSync(BUN, [
          LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
          "--project-dir", proj,
        ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
        expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
      }
      const after = next(proj);
      if (replied) expect(after.plan_approval?.status, JSON.stringify(after)).toBe("approved");
      else expect(after.ask_type, JSON.stringify(after)).toBe("plan-approval");
    });
  }
});

describe("a number for the routing question answers it alone while the code plan question is open", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`${policy}: "1" records nothing for the plan; the plan question comes back with the person's words as their reply`, () => {
      const proj = project(policy);
      const routing = routingQuestionOverThePlan(proj);
      say(proj, "1");
      expect(planAnswers(proj)).toEqual([]);
      expect(blankAnswer(proj)).toBe(true);
      // Part of that work: the words were about the code plan, so they are the
      // answer to its question, read by the agent.
      const back = nextNamed(proj, routing.continue_command);
      expect(back.kind, JSON.stringify(back)).toBe("print");
      expect(back.message).toContain("--checkpoint plan-approval");
      expect(back.message).not.toContain("--request");
      expect(recordedMessage(answer(proj, `Request Changes: ${CHANGE}`))).toContain('Recorded "Request Changes"');
      expect(planAnswers(proj)).toEqual(["QUESTION_ANSWERED: Request Changes"]);
      const revise = next(proj);
      expect(revise.kind).toBe("run-stage");
      expect(revise.plan_approval?.status).toBe("revise");
      expect(revise.plan_approval?.feedback).toBe(CHANGE);
    });
  }

  // Parked at the plan question ("let's stop here"), the person comes back with
  // a change to the plan and chooses "part of that work, continue it": the work
  // is unparked and their words answer the plan question. Before, the agent was
  // told to unpark and re-run next, and the question came back with the words
  // unread.
  for (const policy of ["off", "strict"] as const) {
    test(`${policy}: parked at the plan question, "part of that work" unparks and the words answer the question`, () => {
      const proj = project(policy);
      expect(next(proj).ask_type).toBe("plan-approval");
      say(proj, "let's stop here for today");
      run(proj, [ORCHESTRATE, "park", "--project-dir", proj], "");
      const routing = routingQuestionOverThePlan(proj, false);
      say(proj, "1");
      const back = nextNamed(proj, routing.continue_command);
      expect(back.kind, JSON.stringify(back)).toBe("print");
      expect(back.message).toContain("unpark");
      // The re-run is the routing answer as it was, not a bare next.
      const rerun = /re-run `([^`]+)`/.exec(back.message ?? "")?.[1];
      expect(rerun, back.message).toContain("--continue --request");
      run(proj, [join(AIDLC_SRC, "tools", "aidlc-state.ts"), "unpark", "--project-dir", proj], "");
      const read = next(proj, (rerun as string).replace(/^next /, "").split(" "));
      expect(read.kind, JSON.stringify(read)).toBe("print");
      expect(read.message).toContain("--checkpoint plan-approval");
      expect(read.message).not.toContain("--request");
      expect(recordedMessage(answer(proj, `Request Changes: ${CHANGE}`))).toContain('Recorded "Request Changes"');
      const revise = next(proj);
      expect(revise.kind, JSON.stringify(revise)).toBe("run-stage");
      expect(revise.plan_approval?.status).toBe("revise");
      expect(revise.plan_approval?.feedback).toBe(CHANGE);
    });
  }

  test('off: an approved plan stays approved through a routing question at the build step', () => {
    const proj = project("off");
    expect(next(proj).ask_type).toBe("plan-approval");
    say(proj, "1");
    const recorded = spawnSync(BUN, [
      LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
      "--project-dir", proj,
    ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
    expect(planAnswers(proj)).toEqual(["PLAN_APPROVAL_RECORDED: Approve Plan"]);
    expect(next(proj).plan_approval?.status).toBe("approved");
    const routing = routingQuestionOverThePlan(proj, false);
    say(proj, "1");
    const build = nextNamed(proj, routing.continue_command);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval?.status).toBe("approved");
    expect(planAnswers(proj)).toEqual(["PLAN_APPROVAL_RECORDED: Approve Plan"]);
  });

  test('off: "2" records nothing for the plan and the new work gets the words', () => {
    const proj = project("off");
    const routing = routingQuestionOverThePlan(proj);
    say(proj, "2");
    expect(planAnswers(proj)).toEqual([]);
    expect(blankAnswer(proj)).toBe(true);
    expect(routing.new_intent_command).toContain("--new-intent");
  });

  test('off: "3" leaves the plan question as it was, not waiting for the person to edit the files', () => {
    const proj = project("off");
    routingQuestionOverThePlan(proj);
    say(proj, "3");
    expect(planAnswers(proj)).toEqual([]);
    const again = next(proj);
    expect(again.ask_type).toBe("plan-approval");
    expect(again.plan_approval?.editing).toBe(false);
  });

  for (const harness of ["kiro", "kiro-ide", "codex"] as const) {
    test(`${harness}: "1" through its own human-turn hook records nothing for the plan`, () => {
      const proj = project("off");
      routingQuestionOverThePlan(proj);
      say(proj, "1", harness);
      expect(planAnswers(proj)).toEqual([]);
      expect(blankAnswer(proj)).toBe(true);
    });
  }
});

describe("a number for the routing question picks no guard-recovery remedy", () => {
  test('"1" picks no remedy: the recovery question waits for the agent\'s reading', () => {
    const proj = project("off");
    expect(next(proj).ask_type).toBe("plan-approval");
    say(proj, "1");
    const recorded = spawnSync(BUN, [
      LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
      "--project-dir", proj,
    ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
    expect(next(proj).plan_approval?.status).toBe("approved");
    writeActiveDirectiveMarker(proj, {
      kind: "ask", ask_type: "guard-recovery", stage: "code-generation",
      remedies: [
        { op: "request-changes", action: 'Ask "What should change?"', interaction: "human-input" },
        { op: "restart-stage", action: "Start Code Generation again", interaction: "human-input" },
      ],
      state_sha256: stateDigest(readFileSync(seededStateFile(proj), "utf-8")),
    });
    say(proj, `/aidlc ${CHANGE}`);
    const print = next(proj, [CHANGE]);
    const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(print.message ?? "")?.[1];
    expect(request, print.message).toBeDefined();
    expect(next(proj, (request as string).split(" ")).ask_type).toBe("new-work-routing");
    say(proj, "1");
    const marker = JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json"), "utf-8"));
    expect(marker.guard_recovery_response?.selected_op ?? null).toBeNull();
  });
});

describe("the new-work plan offer answers itself alone while the code plan question is open", () => {
  // Words no ready-made plan fits get the offer to tailor one; words a plan
  // fits get the offer to go ahead with it.
  const offers = [["compose-offer", "add a csv export of the todo list"], ["scope-confirm", "fix the crash when the export list is empty"]];
  for (const policy of ["off", "strict"] as const) {
    for (const [askType, words] of offers) {
      test(`${policy}: "1" for the ${askType} offer records nothing for the plan`, () => {
        const proj = project(policy);
        expect(next(proj).ask_type).toBe("plan-approval");
        say(proj, `/aidlc --new-intent ${words}`);
        const offer = next(proj, ["--new-intent", words]);
        expect(offer.ask_type, JSON.stringify(offer)).toBe(askType);
        say(proj, "1");
        expect(planAnswers(proj)).toEqual([]);
        expect(blankAnswer(proj)).toBe(true);
      });
    }
  }
});

// A feature with two Units, built one at a time with checkpoints: alpha's
// design stages done, its verification command set and its code built, as
// the agent runs the engine's commands in the chat that asks.
const UNIT_STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

function checkpointProject(policy: Policy): string {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking
## Project Information
- **Project**: Construction checkpoint overlay
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Review Override**: none
- ${policy === "off" ? "**Guard Policy**: off (from scope feature)" : "**Guard Policy**: strict (set by you)"}
- **Summary Confirmation**: off (set by you)
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${UNIT_STAGES.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} \u2014 EXECUTE`).join("\n")}
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(proj, ["alpha", "beta"]);
  mkdirSync(join(proj, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(proj, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, proj);
  cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
  for (const slug of UNIT_STAGES.slice(0, 4)) coverStage(proj, slug);
  return proj;
}

function coverStage(proj: string, slug: string): void {
  const stage = findStageBySlug(slug)!;
  const output = join(seededRecordDir(proj), "construction", "alpha", slug);
  mkdirSync(output, { recursive: true });
  for (const name of stage.produces ?? []) {
    const file = join(output, artifactFilename(name));
    if (!existsSync(file)) writeFileSync(file, `# alpha ${name}\n`);
  }
  if (stage.workspace_requires) {
    writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
      stage: slug, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }],
    }));
  }
  const fingerprint = reviewArtifactFingerprint(proj, stage, "alpha", { requireRequiredArtifacts: true });
  expect(fingerprint).not.toBeNull();
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: slug, Unit: "alpha", Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(proj, slug, true, "alpha"),
    "Artifact Fingerprint": fingerprint!,
  }, proj);
}

// An engine command the agent runs in chat `session`, through the project's
// own dispatcher, its arguments as given (no shell: Windows has none to lend).
function engine(proj: string, args: string[], session = SESSION): { code: number; out: string } {
  const result = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", ...args], {
    cwd: proj,
    env: { ...env(proj), AIDLC_SESSION_OVERRIDE: session, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function verificationCommand(proj: string): string {
  const script = join(seededRecordDir(proj), "check.cjs");
  writeFileSync(script, "const fs=require('node:fs'); for(const unit of ['alpha','beta']) " +
    "if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit))process.exit(1);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(BUN)} ${quote(script)}`;
}

const verificationIdentity = (command: string) =>
  ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command];

function askVerification(proj: string): string {
  const command = verificationCommand(proj);
  const asked = engine(proj, ["log", "decision", ...verificationIdentity(command),
    "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]);
  expect(asked.code, asked.out).toBe(0);
  return command;
}

test("Codex: the verification question shown before it is logged takes the reply already given, then its receipt applies", () => {
  const proj = checkpointProject("strict");
  const command = verificationCommand(proj);
  writeFileSync(join(seededRecordDir(proj), "verification-command.txt"), command);
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command",
    "--command-file", "verification-command.txt"];
  // The agent showed the question, the person approved, then the agent logged
  // it: their reply answers it, as it does the agent's other questions.
  say(proj, "Approve", "codex");
  const asked = engine(proj, ["log", "decision", ...identity,
    "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]);
  expect(asked.code, asked.out).toBe(0);
  const approved = engine(proj, ["log", "answer", ...identity, "--details", "Approve"]);
  expect(approved.code, approved.out).toBe(0);
  const applied = engine(proj, ["state", "set-construction-verification-command",
    "--command-file", "verification-command.txt"]);
  expect(applied.code, applied.out).toBe(0);
  expect(readAuditShardEvents(proj).filter((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toHaveLength(1);
});

// alpha's checkpoint question, asked in chat a101 after its plan was approved and built.
function askCheckpoint(proj: string): void {
  const command = askVerification(proj);
  say(proj, "Approve");
  expect(engine(proj, ["log", "answer", ...verificationIdentity(command), "--details", "Approve"]).code).toBe(0);
  expect(engine(proj, ["state", "set-construction-verification-command", command]).code).toBe(0);
  next(proj);
  const dir = codeGenerationRecordDir(proj, "alpha");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: alpha\n- Touches: src/alpha.ts\n- Tests: 1 unit test\n\n" +
      "## Steps\n\n- [ ] Step 1: write alpha in `src/alpha.ts`\n\n" + renderTestingContract(resolveTestingPosture(proj)), "utf-8");
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/alpha.test.ts`.\n", "utf-8");
  expect(next(proj).ask_type).toBe("plan-approval");
  say(proj, "approve");
  expect(engine(proj, ["log", "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan"]).code)
    .toBe(0);
  next(proj);
  expect(engine(proj, ["testing-posture", "brief", "--unit", "alpha"]).code).toBe(0);
  writeFileSync(join(proj, "src", "alpha.ts"), "export const alpha = 2; // alpha\n", "utf-8");
  coverStage(proj, "code-generation");
  const checkpoint = next(proj) as Emitted & { construction_checkpoint?: { unit?: string } };
  expect(checkpoint.construction_checkpoint?.unit, JSON.stringify(checkpoint)).toBe("alpha");
  const verify = engine(proj, ["bolt", "checkpoint", "--action", "verify", "--unit", "alpha", "--kind", "unit"]);
  expect(verify.code, verify.out).toBe(0);
  const ask = engine(proj, ["bolt", "checkpoint", "--action", "ask", "--unit", "alpha", "--kind", "unit"]);
  expect(ask.code, ask.out).toBe(0);
}

function routingQuestionOverTheStep(proj: string, session = SESSION): Emitted {
  const words = "also handle an empty list";
  say(proj, `/aidlc ${words}`, "claude", session);
  const print = next(proj, [words]);
  expect(print.kind, JSON.stringify(print)).toBe("print");
  const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(print.message ?? "")?.[1];
  expect(request, print.message).toBeDefined();
  const routing = next(proj, (request as string).split(" "));
  expect(routing.ask_type, JSON.stringify(routing)).toBe("new-work-routing");
  return routing;
}

// What the hook kept as the person's reply to a protected question: no pick of theirs, none of the routing answer.
function keptReply(proj: string, session = SESSION): { choice: string | null; words: string | null } {
  const response = readProtectedResponse(proj, session);
  return { choice: response?.choice ?? null, words: response?.words ?? null };
}

describe("a number for the routing question is never kept as a Unit checkpoint or verification-command answer", () => {
  for (const policy of ["off", "strict"] as const) {
    for (const pick of ["1", "2"]) {
      test(`${policy}: "${pick}" at alpha's checkpoint question is no Approve or Request Changes pick`, () => {
        const proj = checkpointProject(policy);
        askCheckpoint(proj);
        routingQuestionOverTheStep(proj);
        say(proj, pick);
        expect(keptReply(proj)).toEqual({ choice: null, words: "also handle an empty list" });
      });
    }
  }

  test('a new chat: "1" there is no answer to the checkpoint question the first chat asked', () => {
    const proj = checkpointProject("off");
    askCheckpoint(proj);
    routingQuestionOverTheStep(proj, NEW_CHAT);
    say(proj, "1", "claude", NEW_CHAT);
    for (const session of [SESSION, NEW_CHAT]) {
      expect(keptReply(proj, session).choice).toBeNull();
      expect(keptReply(proj, session).words ?? "").not.toContain("1");
    }
  });

  test("the checkpoint question asked again after the routing question takes the person's next reply", () => {
    const proj = checkpointProject("off");
    askCheckpoint(proj);
    routingQuestionOverTheStep(proj);
    // Words while the routing question is open are not the checkpoint's by default.
    say(proj, "approve it");
    expect(keptReply(proj).words).toBe("also handle an empty list");
    // The engine asks the checkpoint again (a later second than the routing question).
    Bun.sleepSync(1100);
    const again = engine(proj, ["bolt", "checkpoint", "--action", "ask", "--unit", "alpha", "--kind", "unit"]);
    expect(again.code, again.out).toBe(0);
    say(proj, "approve");
    expect(keptReply(proj).choice).toBeNull();
    const approved = engine(proj, ["bolt", "checkpoint", "--action", "approve", "--unit", "alpha", "--kind", "unit", "--user-input", "approve"]);
    expect(approved.code, approved.out).toBe(0);
  });

  test('off: "1" at the verification-command question is no Approve pick', () => {
    const proj = checkpointProject("off");
    askVerification(proj);
    routingQuestionOverTheStep(proj);
    say(proj, "1");
    expect(keptReply(proj)).toEqual({ choice: null, words: "also handle an empty list" });
  });
});

// Feasibility at its approval gate ("Approve Feasibility?"), shown in chat a101.
// `started` writes the stage's own start row, as `next` does when it starts a
// stage: the floor a gate decision's reply must come after.
function gateProject(policy: Policy, started = false): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope feature)",
      `${policy === "off" ? "- **Guard Policy**: off (from scope feature)" : "- **Guard Policy**: strict (set by you)"}\n` +
        "- **Summary Confirmation**: off (set by you)"), "utf-8");
  say(proj, "/aidlc");
  expect(next(proj).kind).toBe("run-stage");
  if (started) appendAuditEntry("STAGE_STARTED", { Stage: "feasibility" }, proj);
  const stage = findStageBySlug("feasibility")!;
  const dir = join(seededRecordDir(proj), "ideation", "feasibility");
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n\n## Summary\n\nWritten for this case.\n`, "utf-8");
  }
  report(proj, "awaiting-approval");
  expect(readFileSync(seededStateFile(proj), "utf-8")).toMatch(/^- \[\?\] feasibility /m);
  return proj;
}

function report(proj: string, result: string, extra: string[] = []): { code: number; out: string } {
  const ran = spawnSync(BUN, [ORCHESTRATE, "report", "--stage", "feasibility", "--result", result, ...extra, "--project-dir", proj], {
    cwd: proj,
    env: { ...env(proj), AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  if (result === "awaiting-approval") expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
  return { code: ran.status ?? -1, out: `${ran.stdout ?? ""}${ran.stderr ?? ""}` };
}

describe("an answer to another question is no reply to a stage gate", () => {
  for (const policy of ["off", "strict"] as const) {
    for (const pick of ["1", "2"]) {
      test(`${policy}: routing "${pick}" is no reply the gate's record keeps`, () => {
        const proj = gateProject(policy);
        routingQuestionOverTheStep(proj);
        say(proj, pick);
        expect((personsGateReply(proj, SESSION, "feasibility").words ?? "").split("\n")).not.toContain(pick);
      });
    }
  }

  test('off: "1" for the new-work offer approves no gate the person never answered', () => {
    const proj = gateProject("off");
    const words = "fix the crash when the export list is empty";
    say(proj, `/aidlc --new-intent ${words}`);
    expect(next(proj, ["--new-intent", words]).ask_type).toBe("scope-confirm");
    say(proj, "1");
    expect(report(proj, "approved", ["--user-input", "Approve"]).out).toContain("no new human reply");
    expect(readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED")).toEqual([]);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toMatch(/^- \[\?\] feasibility /m);
  });
});

// The latest message id the human-turn hook kept.
const latestTurnMessage = (proj: string): string =>
  auditBlockField(readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1)?.block ?? "", "Message Id") ?? "";

describe("a message sent while another engine question was open answers the question the agent names", () => {
  test('off: an approval typed while the new-work offer is open approves the gate once the agent names it', () => {
    const proj = gateProject("off");
    const words = "fix the crash when the export list is empty";
    say(proj, `/aidlc --new-intent ${words}`);
    expect(next(proj, ["--new-intent", words]).ask_type).toBe("scope-confirm");
    say(proj, "approve feasibility first");
    const id = latestTurnMessage(proj);
    expect(readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1)?.block)
      .toContain("**Open Question**: scope-confirm");
    // By default it answers the offer on screen; the refusal names it for the agent, ids and times only.
    const refused = report(proj, "approved", ["--user-input", "Approve"]);
    expect(refused.out).toContain(`If their message ${id}`);
    expect(refused.out).not.toContain("approve feasibility first");
    expect(readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED")).toEqual([]);
    const approved = report(proj, "approved", ["--user-input", "Approve", "--message", id]);
    expect(approved.code, approved.out).toBe(0);
    const rows = readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED");
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Person Reply")).toBe("approve feasibility first");
    expect(auditBlockField(rows[0].block, "Message Id")).toBe(id);
  });

  // After the stage started: the refusal names the message sent while the
  // new-work offer was open, and naming it records the approval. It is no
  // "came before this stage started" (it came after), and nothing is asked again.
  for (const policy of ["off", "strict"] as const) {
    test(`${policy}: after the stage started, the message the refusal names approves the gate when the agent names it`, () => {
      const proj = gateProject(policy, true);
      const words = "fix the crash when the export list is empty";
      say(proj, `/aidlc --new-intent ${words}`);
      expect(next(proj, ["--new-intent", words]).ask_type).toBe("scope-confirm");
      say(proj, "approve feasibility first");
      const id = latestTurnMessage(proj);
      const refused = report(proj, "approved", ["--user-input", "Approve"]);
      expect(refused.out).toContain(`If their message ${id}`);
      const approved = report(proj, "approved", ["--user-input", "Approve", "--message", id]);
      expect(approved.code, approved.out).toBe(0);
      expect(approved.out).not.toContain("came before this stage started");
      const rows = readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED");
      expect(rows).toHaveLength(1);
      expect(auditBlockField(rows[0].block, "Message Id")).toBe(id);
      expect(auditBlockField(rows[0].block, "Person Reply")).toBe("approve feasibility first");
    });

    // The routed request, then "approve it" while the routing question is open:
    // the agent reads it as the gate's answer and names it.
    test(`${policy}: "approve it" typed while the routing question is open, after the stage started, records when the agent names it`, () => {
      const proj = gateProject(policy, true);
      routingQuestionOverTheStep(proj);
      say(proj, "approve it");
      const id = latestTurnMessage(proj);
      expect(readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1)?.block)
        .toContain("**Open Question**: new-work-routing");
      const approved = report(proj, "approved", ["--user-input", "Approve", "--message", id]);
      expect(approved.code, approved.out).toBe(0);
      expect(approved.out).not.toContain("came before this stage started");
      const rows = readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED");
      expect(rows).toHaveLength(1);
      expect(auditBlockField(rows[0].block, "Message Id")).toBe(id);
      expect(auditBlockField(rows[0].block, "Person Reply")).toBe("approve it");
    });
  }

  test("a checkpoint answer typed while the new-work offer is open is recorded once the agent names it, with no second question", () => {
    const proj = checkpointProject("off");
    askCheckpoint(proj);
    const words = "fix the crash when the export list is empty";
    say(proj, `/aidlc --new-intent ${words}`);
    expect(next(proj, ["--new-intent", words]).ask_type).toBe("scope-confirm");
    say(proj, "approve alpha");
    const id = latestTurnMessage(proj);
    expect(keptReply(proj).words ?? "").not.toContain("approve alpha");
    const approve = ["bolt", "checkpoint", "--action", "approve", "--unit", "alpha", "--kind", "unit", "--user-input", "Approve"];
    const refused = engine(proj, approve);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain(`If their message ${id}`);
    const approved = engine(proj, [...approve, "--message", id]);
    expect(approved.code, approved.out).toBe(0);
    const rows = readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED" && auditBlockField(row.block, "Unit") === "alpha");
    expect(auditBlockField(rows.at(-1)?.block ?? "", "Person Reply")).toBe("approve alpha");
  });
});

describe("an answer to the routing question is no answer to the stage's own questions", () => {
  test('codex: "2" for new work is not handed back as a reply to the open stage questions', () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
      .replace("- **Change Control**: strict (from scope bugfix)", "- **Guard Policy**: off (from scope bugfix)"), "utf-8");
    const dir = join(seededRecordDir(proj), "inception", "requirements-analysis");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requirements-analysis-questions.md"),
      "# Requirements Questions\n\n## Question 1\n\nWhich titles count as blank?\n\n[Answer]:\n", "utf-8");
    expect(next(proj).kind).toBe("run-stage");
    const words = "also handle an empty list";
    say(proj, `$aidlc ${words}`, "codex");
    const print = next(proj, [words]);
    const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(print.message ?? "")?.[1];
    expect(request, print.message).toBeDefined();
    expect(next(proj, (request as string).split(" ")).ask_type).toBe("new-work-routing");
    say(proj, "2", "codex");
    const later = next(proj) as Emitted & { kept_replies?: { replies: string[] } };
    expect(later.kind, JSON.stringify(later)).toBe("run-stage");
    expect(later.kept_replies?.replies ?? []).not.toContain("2");
  });
});
