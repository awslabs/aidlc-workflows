// covers: function:routeCodeGenerationPlanApproval, function:publishPlanApprovalAsk, function:recordPlanApprovalAskReply, function:recordPlanApprovalReviewRequest, function:codeGenerationPlanReadiness, function:planSummaryLines,
// function:PLAN_APPROVAL_ASK_TYPE, function:planApprovalRuntimeFile, function:readPlanApprovalRuntimeRecord,
// function:writePlanApprovalRuntimeRecord, function:removePlanApprovalRuntimeRecord
//
// The engine asks for Plan Approval itself. These cases drive the real `next`,
// the real human-turn hook, and the real plan-approval guard over one poc
// workflow at Code Generation, and check what the person sees and what is
// recorded:
//
//   - a ready plan is asked for by the engine (summary, plan path, three
//     choices), and nothing the agent writes can answer it;
//   - the reply is read in the person's own words, from any chat on this work;
//   - a plain yes counts right after the question, and asks for a confirm
//     after other conversation;
//   - Request Changes carries the person's words to the revision;
//   - edit mode: "done" approves the files as the person left them, an answer
//     written in the questions file counts, and a Testing Contract the edit
//     broke is repaired and then asked about once;
//   - after approval the build runs; code that moved elsewhere gives one line
//     and no new question, even under strict; an edited plan asks again under
//     strict; "review the plan" asks again on request;
//   - a rejected gate sends the plan back with the person's words first, so
//     the question shows the revised plan;
//   - when the stage rules are too big for one message and arrive in parts,
//     one approval still starts the build, and editing, changes, and review
//     (even said while the parts arrive) still ask again; nothing is built or
//     handed to a worker until the build step itself has arrived.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  cleanupWorktreeFixture,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seedBoltDagBatches,
  seededRecordDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";
import {
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  planApprovalReviewRequested,
  planSummaryLines,
  publishPlanApprovalAsk,
  routeCodeGenerationPlanApproval,
} from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";
import {
  planApprovalRuntimeFile,
  stateDigest,
  workspaceSourceListing,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const SESSION = "01995000-7a11-7000-8000-000000000001";
const OTHER_SESSION = "01995000-7a11-7000-8000-000000000002";

/** The directive fields these cases read. */
interface Emitted {
  kind: string;
  ask_type?: string;
  stage?: string;
  question?: string;
  response_route?: string;
  plan_approval: {
    status?: string;
    feedback?: string;
    note?: string;
    editing?: boolean;
    choices?: string[];
    targets?: Array<{ unit: string | null; plan_path: string; summary: string[] }>;
    units?: Array<{ unit: string; status: string; feedback?: string; note?: string }>;
  };
}

const created: string[] = [];
const worktreeFixtures: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  while (worktreeFixtures.length > 0) cleanupWorktreeFixture(worktreeFixtures.pop()!);
});

function project(policy: "strict" | "relaxed" | "off" = "relaxed", planApproval: "on" | "off" = "on"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  // poc ships with plan approval off; these cases are about the question, so
  // the person turned it on unless a case says otherwise.
  const planApprovalLine = planApproval === "on"
    ? "\n- **Plan Approval**: on (set by you)"
    : "\n- **Plan Approval**: off (from scope poc)";
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)", `- **Guard Policy**: ${policy} (from scope poc)${planApprovalLine}`)
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

function stageDir(proj: string, unit: string | null = null): string {
  return join(seededRecordDir(proj), "construction", ...(unit ? [unit] : []), "code-generation");
}

function writePlan(proj: string, extra = "", unit: string | null = null): void {
  mkdirSync(stageDir(proj, unit), { recursive: true });
  writeFileSync(
    join(stageDir(proj, unit), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n${extra}\n` +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(
    join(stageDir(proj, unit), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n",
    "utf-8",
  );
}

function next(proj: string): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], {
    env: { ...process.env, AIDLC_UNATTENDED: "0" },
  });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

function reply(proj: string, prompt: string, session = SESSION): string {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ?? "";
}

function guardWrite(proj: string, path: string): { code: number; stderr: string } {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Write",
      tool_input: { file_path: path, content: "x\n" },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

function questions(proj: string, unit: string | null = null): string {
  return readFileSync(join(stageDir(proj, unit), "code-generation-questions.md"), "utf-8");
}

function askFor(proj: string): Emitted {
  writePlan(proj);
  const directive = next(proj);
  expect(directive.kind, JSON.stringify(directive)).toBe("ask");
  expect(directive.ask_type).toBe("plan-approval");
  return directive;
}

describe("the engine asks for Plan Approval", () => {
  test("a stage without a plan is planned first; a ready plan is asked for with its summary", () => {
    const proj = project();
    const planning = next(proj);
    expect(planning.kind).toBe("run-stage");
    expect(planning.stage).toBe("code-generation");
    expect(planning.plan_approval).toEqual({ status: "plan" });

    const ask = askFor(proj);
    expect(ask.question).toBe("Approve the code plan?");
    expect(ask.response_route).toBe("next");
    expect(ask.plan_approval.choices).toEqual(["Approve Plan", "Request Changes", "I'll edit the files"]);
    expect(ask.plan_approval.editing).toBe(false);
    const [target] = ask.plan_approval.targets ?? [];
    expect(target.unit).toBeNull();
    expect(target.plan_path).toEndWith("construction/code-generation/code-generation-plan.md");
    expect(target.summary).toEqual(["Builds: slugify for titles", "Touches: src/slugify.ts", "Tests: 3 unit tests"]);
    // The engine wrote the record the old ritual had the agent write.
    expect(questions(proj)).toContain("## Plan Approval");
    expect(questions(proj)).toMatch(/^\[Approval Fingerprint\]: sha256:v3:[0-9a-f]{64}$/m);
    expect(questions(proj)).toMatch(/^\[Answer\]:$/m);
    // While the question is open, nothing is built and the plan stays as shown.
    const blocked = guardWrite(proj, join(stageDir(proj), "code-generation-plan.md"));
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("The plan is waiting for the person to approve it");
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
  });

  test("while the question is open, the old conductor commands point back to next", () => {
    const proj = project();
    askFor(proj);
    const run = (tool: string, args: string[]) => spawnSync(BUN, [join(AIDLC_SRC, "tools", tool), ...args, "--project-dir", proj], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const redirect = "Plan Approval is asked by the engine now. Run next";
    const questionsFile = join(stageDir(proj), "code-generation-questions.md");
    const checkpoint = ["--stage", "code-generation", "--checkpoint", "plan-approval", "--stage-level",
      "--session", SESSION, "--questions-file", questionsFile];
    for (const [tool, args] of [
      ["aidlc-testing-posture.ts", ["fingerprint", "--stage-level"]],
      ["aidlc-log.ts", ["decision", ...checkpoint, "--decision", "Approve this plan?", "--options", "Approve Plan,Request Changes"]],
      ["aidlc-log.ts", ["answer", ...checkpoint, "--details", "Approve Plan"]],
    ] as const) {
      const refused = run(tool, [...args]);
      expect(refused.status, `${tool} ${args[0]}`).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain(redirect);
    }
    // A break-glass override is the person's own last resort and is not redirected.
    const override = run("aidlc-log.ts", ["answer", ...checkpoint, "--details", "Approve Plan", "--override", "source is unreadable"]);
    expect(override.stdout + override.stderr).not.toContain(redirect);
    const reasonFile = join(stageDir(proj), "override-reason.txt");
    writeFileSync(reasonFile, "source is unreadable\n", "utf-8");
    const overrideFile = run("aidlc-log.ts", ["answer", ...checkpoint, "--details", "Approve Plan", "--override-file", reasonFile]);
    expect(overrideFile.stdout + overrideFile.stderr).not.toContain(redirect);
    // The engine's question is untouched by the refusals.
    expect(next(proj).ask_type).toBe("plan-approval");
  });

  test("a plain yes right after the question approves the plan and the next `next` builds", () => {
    const proj = project();
    askFor(proj);
    const said = reply(proj, "yes");
    expect(said).toContain('recorded \\"Approve Plan\\"');
    expect(questions(proj)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    const build = next(proj);
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  // An approval and a request to stop the workflow for now is exactly that:
  // the plan is approved and the workflow parks, with no extra question (#1411).
  test.each([
    "Approve the plan, but let's stop there for today", "Approved. Stop here for today.", "lgtm, done for today",
  ])("%s approves the plan and parks the workflow", (text) => {
    const proj = project();
    askFor(proj);
    const said = reply(proj, text);
    expect(said).toContain('recorded \\"Approve Plan\\"');
    expect(said).toContain("parked");
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(auditText(proj)).toContain("**Event**: WORKFLOW_PARKED");
    expect(next(proj).kind).toBe("parked");
    // Resuming later builds the approved plan.
    const unpark = spawnSync(BUN, [STATE, "unpark", "--project-dir", proj], { encoding: "utf-8" });
    expect(unpark.status, unpark.stderr).toBe(0);
    const build = next(proj);
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  // Under autonomous Construction the person's stop still wins: nothing starts
  // building until they resume (#1411). t121 pins that Stop ends the turn.
  test("an approval that asks to stop parks an autonomous run too", () => {
    const proj = project();
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace(
      "## Current Status", "## Current Status\n- **Construction Autonomy Mode**: autonomous",
    ), "utf-8");
    askFor(proj);
    const said = reply(proj, "Approve the plan, but let's stop there for today");
    expect(said).toContain('recorded \\"Approve Plan\\"');
    expect(said).toContain("so it is parked");
    expect(readFileSync(file, "utf-8")).toMatch(/^- \*\*Parked By\*\*: person$/m);
    expect(next(proj).kind).toBe("parked");
    // Resuming clears the person's park; the CLI still refuses to park the run.
    const unpark = spawnSync(BUN, [STATE, "unpark", "--project-dir", proj], { encoding: "utf-8" });
    expect(unpark.status, unpark.stderr).toBe(0);
    expect(readFileSync(file, "utf-8")).not.toContain("Parked By");
    const selfPark = spawnSync(BUN, [STATE, "park", "--project-dir", proj], { encoding: "utf-8" });
    expect(selfPark.status).not.toBe(0);
    expect(next(proj).kind).toBe("run-stage");
  });

  test("an approval mixed with a change records nothing and asks once", () => {
    const proj = project();
    askFor(proj);
    const said = reply(proj, "approve, but rename slugify to toSlug");
    expect(said).toContain("nothing was recorded");
    expect(said).toContain("make the change first");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).ask_type).toBe("plan-approval");
  });

  test("an answer from another chat on the same work counts", () => {
    const proj = project();
    askFor(proj);
    expect(reply(proj, "Approve Plan", OTHER_SESSION)).toContain('recorded \\"Approve Plan\\"');
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("Request Changes in the person's words reaches the revision, and a revised plan is asked about again", () => {
    const proj = project();
    askFor(proj);
    expect(reply(proj, "rename slugify to toSlug")).toContain('recorded \\"Request Changes\\"');
    const revise = next(proj);
    expect(revise.kind).toBe("run-stage");
    expect(revise.plan_approval).toEqual({ status: "revise", feedback: "rename slugify to toSlug" });
    // Unchanged plan: still revising.
    expect(next(proj).plan_approval.status).toBe("revise");
    writePlan(proj, "- [ ] Step 2: rename slugify to toSlug\n");
    const again = next(proj);
    expect(again.kind).toBe("ask");
    expect(again.plan_approval.note).toBeUndefined();
  });

  // Codex answers through its request_user_input picker, which adds a
  // "(Recommended)" decoration. No session id or recorded challenge is needed.
  test("a Codex picker pick approves the plan, decoration and all", () => {
    const proj = project();
    const ask = askFor(proj);
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(proj, ".codex"), { recursive: true });
    const session = "codex-plan-approval-session";
    writeSessionPidEntry(proj, process.pid, session);
    const result = spawnSync(BUN, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], {
      cwd: proj,
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: session,
        turn_id: "codex-turn",
        cwd: proj,
        tool_name: "request_user_input",
        tool_input: {
          questions: [{
            id: "plan",
            question: ask.question,
            options: ["Approve Plan (Recommended)", "Request Changes", "I'll edit the files"],
          }],
        },
        tool_response: JSON.stringify({ answers: { plan: { answers: ["Approve Plan (Recommended)"] } } }),
        tool_use_id: "request-codex-turn",
      }),
      env: { ...process.env, AIDLC_UNATTENDED: undefined, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("a plain yes after other conversation asks for a confirm, and the question shown again binds it", () => {
    const proj = project();
    askFor(proj);
    expect(reply(proj, "what does step 1 do?")).toContain("asked a question, so nothing was recorded");
    expect(reply(proj, "yes")).toContain("nothing was recorded");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    const shown = next(proj);
    expect(shown.kind).toBe("ask");
    expect(shown.plan_approval.note).toContain("confirm");
    expect(reply(proj, "yes")).toContain('recorded \\"Approve Plan\\"');
  });

  test("edit mode: the agent cannot touch the files, and done approves them as the person left them", () => {
    const proj = project();
    askFor(proj);
    expect(reply(proj, "I'll edit the files")).toContain("edit the files themselves");
    const editing = next(proj);
    expect(editing.kind).toBe("ask");
    expect(editing.plan_approval.editing).toBe(true);
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-plan.md")).code).toBe(2);
    // The person edits in their own editor.
    writePlan(proj, "- [ ] Step 2: handle unicode\n");
    expect(next(proj).plan_approval.editing).toBe(true);
    const said = reply(proj, "done");
    expect(said).toContain('recorded \\"Approve Plan\\"');
    expect(said).toContain("as the person left them");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("edit mode: an answer written in the questions file counts, even under a subheading", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "3");
    const path = join(stageDir(proj), "code-generation-questions.md");
    writeFileSync(
      path,
      // Their own answer line under a subheading, with the engine's blank one
      // left in place after it: what they wrote is the answer.
      readFileSync(path, "utf-8").replace(/^\[Answer\]:$/m, "### My answer\n\n[Answer]: use a lookup table\n\n[Answer]:"),
      "utf-8",
    );
    expect(reply(proj, "done")).toContain('recorded \\"Request Changes\\"');
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "use a lookup table" });
  });

  test("edit mode: an example answer inside a code block is not an answer", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "3");
    const path = join(stageDir(proj), "code-generation-questions.md");
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace(/^\[Answer\]:$/m, "```\n[Answer]: Request Changes\n```\n\n[Answer]:"),
      "utf-8",
    );
    expect(reply(proj, "done")).toContain('recorded \\"Approve Plan\\"');
  });

  test("edit mode: a Testing Contract the edit broke is repaired, then asked about once", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "I'll edit the files");
    const planPath = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(planPath, readFileSync(planPath, "utf-8").replace('"version": 1', '"version": 1,,'), "utf-8");
    expect(reply(proj, "done")).toContain("broke the Testing Contract block");
    const repair = next(proj);
    expect(repair.kind).toBe("run-stage");
    expect(repair.plan_approval.status).toBe("repair");
    writePlan(proj, "- [ ] Step 2: handle unicode\n");
    const ask = next(proj);
    expect(ask.kind).toBe("ask");
    expect(ask.question).toBe("I repaired the Testing Contract block. Build your edited plan?");
  });

  test("after approval, code that moved elsewhere gives no new question even under strict", () => {
    const proj = project("strict");
    askFor(proj);
    reply(proj, "1");
    writeFileSync(join(proj, "src", "other.ts"), "export const other = 1;\n", "utf-8");
    const build = next(proj);
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  test("under strict, a plan edited after approval is asked about again", () => {
    const proj = project("strict");
    askFor(proj);
    reply(proj, "1");
    writePlan(proj, "- [ ] Step 2: add a fast path\n");
    expect(next(proj).kind).toBe("ask");
  });

  test("'review the plan' after approval asks again before anything is built", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "approve");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    expect(reply(proj, "review the plan first")).toContain("asked to review the plan");
    const ask = next(proj);
    expect(ask.kind).toBe("ask");
    reply(proj, "approve");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("a rejected gate sends the approved plan back with the person's words, then asks about the revised plan", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "approve");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    appendAuditEntry("GATE_REJECTED", {
      Stage: "code-generation", "User Input": "Request Changes", Feedback: "log every slug",
    }, proj);
    const revise = next(proj);
    expect(revise.kind).toBe("run-stage");
    expect(revise.plan_approval).toEqual({ status: "revise", feedback: "log every slug" });
    writePlan(proj, "- [ ] Step 2: log every slug\n");
    expect(next(proj).kind).toBe("ask");
  });
});

// Code Generation's rules can be too big for one message (large org, team, or
// project memory, or a harness with a small message budget). The build then
// arrives as numbered rule parts the agent fetches one after another. How many
// parts the rules need must never change what the person is asked.
function withRulesInParts(proj: string): string {
  appendFileSync(
    join(proj, "aidlc", "spaces", "default", "memory", "org.md"),
    Array.from({ length: 180 }, (_, i) => `\n## Team practice ${i}\n\n${"x".repeat(320)}\n`).join(""),
    "utf-8",
  );
  return proj;
}

// A feature workflow at Code Generation, where the plan and build are per Unit.
function unitProject(...units: string[]): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Per-Unit build
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: off
- **Guard Policy**: relaxed (set by you)

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
  seedBoltDag(proj, units);
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

/** One engine call, exactly as the agent makes it: no rule part is followed. */
function engineCall(proj: string, args: string[]): Emitted & { part?: number; receipt?: string } {
  const result = spawnSync(BUN, [ORCHESTRATE, ...args, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim());
}

/** `next`, then every rule part, to the directive after them. */
function nextThroughParts(proj: string): { directive: Emitted; parts: number } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], {
    env: { ...process.env, AIDLC_UNATTENDED: "0" },
  });
  expect(result.status, result.out).toBe(0);
  return { directive: result.directive as unknown as Emitted, parts: result.steering.length };
}

function posture(
  proj: string,
  verb: "brief" | "begin",
  unit: string | null,
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), verb,
    ...(unit ? ["--unit", unit] : ["--stage-level"]), "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
}

function guardDispatch(proj: string, prompt: string): { code: number; stderr: string } {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Agent",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

/** Whether code generation has started: an approval receipt crossed into generation. */
function generationStarted(proj: string): boolean {
  const dir = dirname(planApprovalRuntimeFile(proj, "probe"));
  if (!existsSync(dir)) return false;
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .some((name) => /"status":\s*"generation"/.test(readFileSync(join(dir, name), "utf-8")));
}

describe("when the stage rules arrive in parts", () => {
  for (const unit of [null, "unit-2"]) {
    test(`one approval, then the rules in parts, then the build (${unit ?? "no Units"})`, () => {
      const proj = withRulesInParts(unit ? unitProject(unit) : project());
      writePlan(proj, "", unit);
      const ask = next(proj);
      expect(ask.kind, JSON.stringify(ask)).toBe("ask");
      expect(ask.ask_type).toBe("plan-approval");
      expect(reply(proj, "yes")).toContain('recorded \\"Approve Plan\\"');
      // A fresh `next` partway through (a restart, or the end-of-turn check)
      // starts the rules over; it never brings the question back.
      const first = engineCall(proj, ["next"]);
      expect(first).toMatchObject({ kind: "load-steering", part: 1 });
      expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1, receipt: first.receipt });
      const second = engineCall(proj, ["continue", String(first.receipt)]);
      expect(second, JSON.stringify(second)).toMatchObject({ kind: "load-steering", part: 2 });
      const build = nextThroughParts(proj);
      expect(build.parts).toBeGreaterThan(1);
      expect(build.directive.kind, JSON.stringify(build.directive)).toBe("run-stage");
      expect(build.directive.plan_approval).toEqual({ status: "approved" });
      // The person's answer stays recorded, so the build can start from it.
      expect(questions(proj, unit)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
      const brief = posture(proj, "brief", unit);
      expect(brief.status, brief.stderr).toBe(0);
      expect(brief.stdout).toContain("## Approved plan");
      expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
    });
  }

  test("under strict, a plan edited after approval is asked about again", () => {
    const proj = withRulesInParts(project("strict"));
    askFor(proj);
    reply(proj, "1");
    expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
    writePlan(proj, "- [ ] Step 2: add a fast path\n");
    expect(next(proj).kind).toBe("ask");
    expect(questions(proj)).toMatch(/^\[Answer\]:$/m);
  });

  test("Request Changes sends the plan back with the person's words, then asks about the revised plan", () => {
    const proj = withRulesInParts(project());
    askFor(proj);
    expect(reply(proj, "rename slugify to toSlug")).toContain('recorded \\"Request Changes\\"');
    const revise = nextThroughParts(proj);
    expect(revise.parts).toBeGreaterThan(1);
    expect(revise.directive.kind, JSON.stringify(revise.directive)).toBe("run-stage");
    expect(revise.directive.plan_approval).toEqual({ status: "revise", feedback: "rename slugify to toSlug" });
    writePlan(proj, "- [ ] Step 2: rename slugify to toSlug\n");
    expect(next(proj).kind).toBe("ask");
  });

  test("'review the plan' after approval asks again, and one approval builds", () => {
    const proj = withRulesInParts(project());
    askFor(proj);
    reply(proj, "approve");
    expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
    expect(reply(proj, "review the plan first")).toContain("asked to review the plan");
    expect(next(proj).kind).toBe("ask");
    reply(proj, "approve");
    const build = nextThroughParts(proj);
    expect(build.parts).toBeGreaterThan(1);
    expect(build.directive.plan_approval).toEqual({ status: "approved" });
  });

  test("'review the plan first' said while the rules are arriving asks again before anything is built", () => {
    const proj = withRulesInParts(project());
    askFor(proj);
    reply(proj, "approve");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    expect(reply(proj, "review the plan first")).toContain("asked to review the plan");
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    reply(proj, "approve");
    expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
  });

  for (const policy of ["strict", "relaxed", "off"] as const) {
    test(`nothing is built or handed to a worker until the stage's own step arrives (Guard Policy ${policy})`, () => {
      const proj = withRulesInParts(project(policy));
      askFor(proj);
      reply(proj, "approve");
      const first = engineCall(proj, ["next"]);
      expect(first).toMatchObject({ kind: "load-steering", part: 1 });
      // One line, the same everywhere and under every Guard Policy: the rules
      // are still arriving, the command that fetches the next part, and how to
      // start over for whoever does not hold the earlier parts.
      const brief = posture(proj, "brief", null);
      expect(brief.status).not.toBe(0);
      const reason = String((JSON.parse(brief.stderr.trim()) as { error?: string }).error);
      expect(reason).toStartWith("The Code Generation rules are still arriving (part 1 of ");
      expect(reason).toContain(`continue ${first.receipt}\``);
      expect(reason).toMatch(/If you do not have the earlier parts, run `[^`]* next` instead\.$/);
      expect(reason).not.toContain("build step");
      const begin = posture(proj, "begin", null);
      expect(begin.status).not.toBe(0);
      expect((JSON.parse(begin.stderr.trim()) as { error?: string }).error).toBe(reason);
      const dispatch = guardDispatch(proj, "AIDLC-STAGE: code-generation\n");
      expect(dispatch.code).toBe(2);
      expect(dispatch.stderr.trim()).toBe(reason);
      const write = guardWrite(proj, join(proj, "src", "slugify.ts"));
      expect(write.code).toBe(2);
      expect(write.stderr.trim()).toBe(reason);
      expect(generationStarted(proj)).toBe(false);
      // Once the build step has arrived, the same brief goes to the worker.
      expect(nextThroughParts(proj).directive.kind).toBe("run-stage");
      const ready = posture(proj, "brief", null);
      expect(ready.status, ready.stderr).toBe(0);
      const handed = guardDispatch(proj, ready.stdout);
      expect(handed.code, handed.stderr).toBe(0);
      expect(generationStarted(proj)).toBe(true);
    });
  }

  test("a part receipt that is not the engine's own is never put in a command: the line names a fresh `next`", () => {
    const proj = withRulesInParts(project());
    askFor(proj);
    reply(proj, "approve");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    const markerPath = join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
    const part = JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
    const forged = "$(touch pwned); `id`";
    writeFileSync(markerPath, `${JSON.stringify({
      ...part,
      continue_token: forged,
      continue_token_sha256: createHash("sha256").update(forged, "utf-8").digest("hex"),
    }, null, 2)}\n`, "utf-8");
    const brief = posture(proj, "brief", null);
    expect(brief.status).not.toBe(0);
    const reason = String((JSON.parse(brief.stderr.trim()) as { error?: string }).error);
    expect(reason).toStartWith("The Code Generation rules are still arriving (part 1 of ");
    expect(reason).toMatch(/Run `[^`]* next` and follow each part until the Code Generation step itself arrives/);
    expect(reason).not.toContain("pwned");
    expect(reason).not.toContain(" continue ");
    const write = guardWrite(proj, join(proj, "src", "slugify.ts"));
    expect(write.code).toBe(2);
    expect(write.stderr.trim()).toBe(reason);
  });

  // Each step that follows a build: the completion gate, a Unit checkpoint, a
  // swarm batch checkpoint, and the settled swarm.
  const BUILT_STEPS = [{ o: true }, { j: "unit" }, { y: { batch: 1, units: ["unit-a"] } }, { z: true }];

  const published = new Map<string, Record<string, unknown>>();

  /**
   * The rules part as the engine first published it, rewritten to deliver
   * `step`; signed as the engine signs it unless `forged`.
   */
  function partFor(proj: string, step: Record<string, unknown>, forged = false, top: Record<string, unknown> = {}): string {
    const markerPath = join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
    if (!published.has(proj)) published.set(proj, JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>);
    const part = published.get(proj)!;
    const payload = { ...(part.steering_payload as Record<string, unknown>), ...step };
    const key = Buffer.from(readFileSync(join(dirname(markerPath), "steering-token-key"), "utf-8").trim(), "base64url");
    const receipt = createHmac("sha256", key).update(JSON.stringify(payload), "utf-8").digest("base64url").slice(0, 8);
    writeFileSync(markerPath, `${JSON.stringify({
      ...part,
      steering_payload: payload,
      ...(forged ? {} : { steering_payload_receipt: receipt }),
      ...top,
    }, null, 2)}\n`, "utf-8");
    return String(part.intent_uuid ?? "bare-space");
  }

  test("'review the plan first' while a gate's or checkpoint's rules arrive shows the plan now", () => {
    const proj = withRulesInParts(project());
    askFor(proj);
    reply(proj, "approve");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    // Not every such step has a person reviewing it (an autonomous checkpoint,
    // the settled swarm), so the plan is shown while the person is asking.
    for (const step of BUILT_STEPS) {
      const intent = partFor(proj, step);
      const said = reply(proj, "review the plan first");
      expect(said, JSON.stringify(step)).toContain("show them the plan now");
      expect(said).toContain("y" in step
        ? "construction/unit-a/code-generation/code-generation-plan.md"
        : "construction/code-generation/code-generation-plan.md");
      expect(said).not.toContain("shown for approval again before anything else is built");
      expect(said).not.toContain("When it arrives");
      expect(planApprovalReviewRequested(proj, "stage:code-generation", intent)).toBe(false);
    }
  });

  test("a route edited on the marker is not trusted: 'review the plan first' still asks again before anything is built", () => {
    for (const step of BUILT_STEPS) {
      const proj = withRulesInParts(project());
      askFor(proj);
      reply(proj, "approve");
      expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
      // The route now claims a step after the build, but its receipt was minted
      // for the build's own part.
      const intent = partFor(proj, step, true);
      const said = reply(proj, "review the plan first");
      expect(said, JSON.stringify(step)).toContain("shown for approval again before anything else is built");
      expect(said).not.toContain("show them the plan now");
      expect(said).not.toContain("unit-a");
      expect(planApprovalReviewRequested(proj, "stage:code-generation", intent)).toBe(true);
    }
  });

  test("a signed rules part names its own Unit: a top-level Unit edited beside it changes nothing", () => {
    const proj = withRulesInParts(unitProject("unit-b", "unit-a"));
    writePlan(proj, "", "unit-a");
    writePlan(proj, "", "unit-b");
    expect(next(proj).kind).toBe("ask");
    reply(proj, "yes");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    // unit-b's build part, its top-level Unit edited to unit-a: the request is
    // still kept for unit-b, whose plan is asked about before it is built.
    const intent = partFor(proj, {}, false, { unit: "unit-a" });
    const before = reply(proj, "review the plan first");
    expect(before).toContain("shown for approval again before anything else is built");
    expect(before).toContain("unit-b");
    expect(before).not.toContain("unit-a");
    expect(planApprovalReviewRequested(proj, "unit:unit-b", intent)).toBe(true);
    expect(planApprovalReviewRequested(proj, "unit:unit-a", intent)).toBe(false);
    // unit-b's gate part, edited the same way: unit-b's plan is the one shown.
    partFor(proj, { o: true }, false, { unit: "unit-a" });
    const after = reply(proj, "review the plan first");
    expect(after).toContain("show them the plan now");
    expect(after).toContain("construction/unit-b/code-generation/code-generation-plan.md");
    expect(after).not.toContain("unit-a");
    expect(planApprovalReviewRequested(proj, "unit:unit-a", intent)).toBe(false);
  });

  test("a rules part for one Unit carries nothing for another Unit, even an approved one, or for the stage", () => {
    const proj = withRulesInParts(unitProject("unit-b", "unit-a"));
    writePlan(proj, "", "unit-a");
    writePlan(proj, "", "unit-b");
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect((ask.plan_approval.targets ?? []).map((target) => target.unit)).toEqual(["unit-b"]);
    reply(proj, "yes");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    expect(evaluateCodeGenerationApproval(proj, { unit: "unit-b" }).ok).toBe(true);
    // The same part as it would be published for unit-a (say, sent back at its
    // gate while unit-b's plan stands approved).
    const markerPath = join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
    const part = JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
    expect(part).toMatchObject({ kind: "load-steering", stage: "code-generation", unit: "unit-b" });
    writeFileSync(markerPath, `${JSON.stringify({ ...part, unit: "unit-a" }, null, 2)}\n`, "utf-8");
    const approved = evaluateCodeGenerationApproval(proj, { unit: "unit-b" });
    expect(approved.ok).toBe(false);
    expect(approved.reason).toContain('does not match active directive unit "unit-a"');
    expect(evaluateCodeGenerationApproval(proj, { unit: "unit-a" }).ok).toBe(false);
    const stage = evaluateCodeGenerationApproval(proj, { unit: null });
    expect(stage.ok).toBe(false);
    expect(stage.reason).toBe("Stage-level Code Generation approval requires a zero-Unit run-stage directive");
  });
});

// One question for several Units whose plans are ready together (a swarm batch).
const GROUP = ["alpha", "beta"];

function swarmFixture(plans: boolean): string {
  const pd = setupWorktreeFixture();
  worktreeFixtures.push(pd);
  seedAidlcMemory(pd);
  writeFileSync(seededStateFile(pd), `# State
## Project Information
- **Project**: Grouped plan approval
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
  seedBoltDagBatches(pd, [GROUP, ["later"]]);
  mkdirSync(join(pd, "src"), { recursive: true });
  const baseline = writeBaselineSourceSnapshot(pd, "code-generation", workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, pd);
  if (!plans) return pd;
  const contract = renderTestingContract(resolveTestingPosture(pd));
  for (const unit of GROUP) {
    const dir = codeGenerationRecordDir(pd, unit);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "code-generation-plan.md"),
      `# Plan for ${unit}\n\n## Summary\n\n- Builds: ${unit}\n\n## Steps\n- [ ] Implement ${unit}\n\n${contract}`, "utf-8");
    writeFileSync(join(dir, "unit-test-instructions.md"), `# Tests\n\nRun ${unit} tests.\n`, "utf-8");
  }
  return pd;
}

function groupedProject(): { pd: string; ask: Emitted } {
  const pd = swarmFixture(true);
  const state = () => stateDigest(readFileSync(seededStateFile(pd), "utf-8"));
  writeActiveDirectiveMarker(pd, { kind: "invoke-swarm", stage: "code-generation", units: GROUP, state_sha256: state() });
  const routed = routeCodeGenerationPlanApproval(pd, { kind: "invoke-swarm", stage: "code-generation", units: GROUP });
  const ask = routed as unknown as Emitted;
  expect(ask.kind).toBe("ask");
  writeActiveDirectiveMarker(pd, {
    kind: "ask", stage: "code-generation", ask_type: "plan-approval", units: GROUP, state_sha256: state(),
  });
  publishPlanApprovalAsk(pd, routed as Parameters<typeof publishPlanApprovalAsk>[1]);
  return { pd, ask };
}

function swarmState(pd: string): Emitted {
  writeActiveDirectiveMarker(pd, {
    kind: "invoke-swarm", stage: "code-generation", units: GROUP,
    state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
  });
  return routeCodeGenerationPlanApproval(pd, { kind: "invoke-swarm", stage: "code-generation", units: GROUP }) as unknown as Emitted;
}

describe("one question for several ready Units", () => {
  test("before the question, the batch's plans can be written in the main workspace, and nothing else", () => {
    const pd = swarmFixture(false);
    writeActiveDirectiveMarker(pd, {
      kind: "invoke-swarm", stage: "code-generation", units: GROUP,
      state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
    });
    expect(swarmState(pd).plan_approval.status).toBe("plan");
    for (const unit of GROUP) {
      const written = guardWrite(pd, join(codeGenerationRecordDir(pd, unit), "code-generation-plan.md"));
      expect(written.code, written.stderr).toBe(0);
    }
    expect(guardWrite(pd, join(codeGenerationRecordDir(pd, "later"), "code-generation-plan.md")).code).toBe(2);
    expect(guardWrite(pd, join(pd, "src", "alpha.ts")).code).toBe(2);
  });

  test("shows every Unit's summary, and 'approve all' approves each Unit separately", () => {
    const { pd, ask } = groupedProject();
    expect(ask.question).toBe("Approve these 2 code plans?");
    expect(ask.plan_approval.choices).toEqual(["Approve all", "Request Changes", "I'll edit the files"]);
    expect((ask.plan_approval.targets ?? []).map((target) => target.unit)).toEqual(GROUP);
    expect(ask.plan_approval.targets?.[1].summary).toEqual(["Builds: beta"]);
    expect(reply(pd, "approve all")).toContain('recorded \\"Approve Plan\\" for alpha and beta');
    for (const unit of GROUP) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(true);
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
  });

  test("a change naming one Unit sends only that Unit back and approves the rest", () => {
    const { pd } = groupedProject();
    expect(reply(pd, "change beta: use a lookup table")).toContain('recorded \\"Request Changes\\" for beta');
    expect(evaluateCodeGenerationApproval(pd, { unit: "alpha" }).ok).toBe(true);
    expect(evaluateCodeGenerationApproval(pd, { unit: "beta" }).ok).toBe(false);
    expect(swarmState(pd).plan_approval).toEqual({
      status: "plan",
      units: [{ unit: "beta", status: "revise", feedback: "change beta: use a lookup table" }],
    });
  });

  test("a change naming no Unit asks once which plan, then applies to the one named", () => {
    const { pd } = groupedProject();
    const which = reply(pd, "change the error handling");
    expect(which).toContain("Which plan should change: alpha, beta, or all?");
    expect(evaluateCodeGenerationApproval(pd, { unit: "alpha" }).ok).toBe(false);
    expect(reply(pd, "alpha")).toContain('recorded \\"Request Changes\\" for alpha');
    expect(evaluateCodeGenerationApproval(pd, { unit: "beta" }).ok).toBe(true);
    expect(swarmState(pd).plan_approval.units).toEqual([
      { unit: "alpha", status: "revise", feedback: "change the error handling" },
    ]);
  });
});

describe("the question's summary", () => {
  test("uses the plan's Summary section, or counts plan steps without one", () => {
    expect(planSummaryLines("# P\n\n## Summary\n\n- Builds: x\n- Tests: 2\n\n## Steps\n- [ ] a\n", "t"))
      .toEqual(["Builds: x", "Tests: 2"]);
    // Only what renders reaches the question.
    expect(planSummaryLines("# P\n\n## Summary\n\n<!-- run this first -->\n- Builds: x\n```\n- Touches: hidden\n```\n", "t"))
      .toEqual(["Builds: x"]);
    expect(planSummaryLines("# P\n\n- [ ] a\n- [x] b\n", "run it"))
      .toEqual(["2 plan steps", "Tests: see unit-test-instructions.md"]);
  });
});
