// covers: function:routeCodeGenerationPlanApproval, function:publishPlanApprovalAsk, function:notePlanApprovalAskReply, function:recordPlanApprovalAnswer, function:requestPlanApprovalReviewNow, function:codeGenerationPlanReadiness, function:planSummaryLines,
// function:PLAN_APPROVAL_ASK_TYPE, function:planApprovalRuntimeFile, function:readPlanApprovalRuntimeRecord,
// function:writePlanApprovalRuntimeRecord, function:removePlanApprovalRuntimeRecord, function:releaseTakenGuardRecoveryReply,
// function:keepPlanApprovalAskOverStateWrite
//
// The engine asks for Plan Approval itself. These cases drive the real `next`,
// the real human-turn hook, and the real plan-approval guard over one poc
// workflow at Code Generation, and check what the person sees and what is
// recorded:
//
//   - a ready plan is asked for by the engine (summary, plan path, three
//     choices), and nothing the agent writes can answer it;
//   - the hook keeps the person's reply, from any chat on this work; the agent
//     reads it and records their choice (an exact pick like "1" the hook records
//     itself, and the agent cannot overrule it);
//   - an approval with an instruction edits the plan and approves it as it
//     stands, with no second question; a question records nothing;
//   - Request Changes carries the person's words to the revision;
//   - edit mode: after "done" the agent records the files as the person left
//     them, or what they wrote in the questions file, and a Testing Contract the
//     edit broke is repaired and then asked about once;
//   - after approval the build runs; code that moved elsewhere gives one line
//     and no new question, even under strict; an edited plan asks again under
//     strict; "review the plan" asks again on request;
//   - a rejected gate sends the plan back with the person's words first, so
//     the question shows the revised plan;
//   - when the stage rules are too big for one message and arrive in parts,
//     one approval still starts the build, and editing, changes, and review
//     (even said while the parts arrive) still ask again; nothing is built or
//     handed to a worker until the build step itself has arrived;
//   - when the chat compacts, a guard-recovery question comes up, or the work
//     is paused after the approval, the approved plan is built and not asked
//     about again, and editing, changes, review, a rejected gate, a new
//     attempt, and another Unit still ask; "review the plan first" said then
//     asks again; an answer typed after the chat compacts still counts;
//   - stopping for now: the park and the unpark the engine names get through
//     the guard, and coming back builds an approved plan or asks about the
//     same plan again.
//   - the zero-Unit lockout reported in #1172 (refactor and bugfix, Brownfield,
//     rules in parts): one approval reaches the build, each refusal while a
//     part is the step names that part's `continue`, the stage-level handoff
//     and source edits go through, parking and coming back reach the build
//     with no new question, and a rules part left behind by a state that moved
//     back holds nothing.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  activeDirectiveStorageDir,
  invalidateActiveDirectiveContext,
  keepPlanApprovalAskOverStateWrite,
  planApprovalAskIsOpen,
  mintProtectedQuestion,
  planApprovalRuntimeFile,
  readProtectedResponse,
  stateDigest,
  workspaceSourceFingerprint,
  workspaceSourceListing,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { FILE_TOOLS_RULE } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

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
  message?: string;
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

function next(proj: string, args: string[] = []): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, {
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

// What the agent runs after reading the person's reply: the choice they made.
function answer(
  proj: string,
  details: string,
  extra: string[] = [],
): { code: number; recorded?: string; message: string } {
  const result = spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--details", details, ...extra, "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const line = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").find((entry) => entry.startsWith("{"));
  const parsed = line ? JSON.parse(line) as { recorded?: string; message?: string; error?: string } : {};
  return {
    code: result.status ?? -1,
    ...(parsed.recorded ? { recorded: parsed.recorded } : {}),
    message: parsed.message ?? parsed.error ?? `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
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

function guardBash(proj: string, command: string): { code: number; stderr: string } {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Bash",
      tool_input: { command },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

// Runs an engine command the way the conductor would, after the guard let it
// through: the installed tools in the project, as the engine spelled them.
function runInstalled(proj: string, command: string): string {
  expect(command).toMatch(/^bun \.claude\/tools\/[\w.-]+\.ts( [\w-]+)+$/);
  const [, ...args] = command.split(" ");
  const result = spawnSync(BUN, args, {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, `${command}\n${result.stderr}`).toBe(0);
  return result.stdout ?? "";
}

// The command `next --resume` names to clear the park.
function resumeNamesUnpark(proj: string): string {
  const resume = next(proj, ["--resume"]);
  expect(resume.kind, JSON.stringify(resume)).toBe("print");
  const command = /Run `([^`]+ unpark)`/.exec(resume.message ?? "")?.[1];
  expect(command, resume.message).toBeDefined();
  return command as string;
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
  // From the person's own terminal no reply can be kept. The refusal names the
  // switch that builds the plan there, except where the team's strict Guard
  // Policy would refuse that switch: then it names that line, and a chat.
  test("at their own terminal the plan question names a step that works, and the team's strict line where it holds", () => {
    const terminal = (proj: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" };
      for (const key of Object.keys(env)) {
        if (/^(?:CLAUDECODE|CLAUDE_CODE_|CODEX_|CURSOR_|KIRO_|OPENCODE|COPILOT_|VSCODE_)/i.test(key)) delete env[key];
      }
      env.AIDLC_TEST_CONFIG_TTY = "1";
      env.TERM_PROGRAM = "";
      const result = spawnSync(BUN, [
        join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
        "--details", "Approve Plan", "--project-dir", proj,
      ], { cwd: proj, env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
      return `${result.stdout ?? ""}${result.stderr ?? ""}`;
    };
    const open = project();
    askFor(open);
    const switchStep = terminal(open);
    expect(switchStep).toContain("AI-DLC cannot see a chat in this terminal");
    expect(switchStep).toContain("config set guard.plan-approval off");

    const locked = project();
    const memory = join(locked, "aidlc", "spaces", "default", "memory", "project.md");
    const content = readFileSync(memory, "utf-8");
    writeFileSync(memory, content.includes("## Guard Policy\n")
      ? content.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
      : `${content.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`);
    askFor(locked);
    const lockStep = terminal(locked);
    expect(lockStep).toContain("AI-DLC cannot see a chat in this terminal");
    expect(lockStep).toContain("Your team set Guard Policy to strict in");
    expect(lockStep).toContain("open this folder in your AI tool and reply to it there");
    expect(lockStep).not.toContain("guard.plan-approval off");
  });

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
    // A person's answer text for `log answer --details-file` is written in the
    // record's own answer-text folder, so no shell reads it; that alone passes.
    const answerText = join(seededRecordDir(proj), ".aidlc-engine", "answer-text");
    expect(guardWrite(proj, join(answerText, "answer.txt")).code).toBe(0);
    expect(guardWrite(proj, join(seededRecordDir(proj), ".aidlc-engine", "answer.txt")).code).toBe(2);
    expect(guardWrite(proj, join(answerText, "..", "..", "construction", "code-generation", "code-generation-plan.md")).code)
      .toBe(2);
  });

  test("while the question is open, the old conductor commands point back to next, and a record needs their reply", () => {
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
    ] as const) {
      const refused = run(tool, [...args]);
      expect(refused.status, `${tool} ${args[0]}`).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain(redirect);
    }
    // The agent records the person's choice, but only after they replied.
    const early = run("aidlc-log.ts", ["answer", ...checkpoint, "--details", "Approve Plan"]);
    expect(early.status).not.toBe(0);
    expect(early.stdout + early.stderr).toContain("has not replied to the plan question");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
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

  test("the agent records the approval it read from their words, and the next `next` builds", () => {
    const proj = project();
    askFor(proj);
    expect(reply(proj, "yes")).toBe("");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.message).toContain('Recorded "Approve Plan"');
    expect(questions(proj)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
    expect(auditText(proj)).toContain("**Person Reply**: yes");
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
    reply(proj, text);
    const said = answer(proj, "Approve Plan", ["--park"]);
    expect(said.code, said.message).toBe(0);
    expect(said.message).toContain('Recorded "Approve Plan"');
    expect(said.message).toContain("parked");
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
  // The person's stop is theirs only while someone is there: an unattended
  // run's answer with --park still approves, and the run keeps moving.
  test("an unattended run's Approve Plan with --park approves but never parks an autonomous run", () => {
    const proj = project();
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace(
      "## Current Status", "## Current Status\n- **Construction Autonomy Mode**: autonomous",
    ), "utf-8");
    askFor(proj);
    reply(proj, "approve, and let's stop there for today");
    const result = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
      "--details", "Approve Plan", "--park", "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "1" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Recorded \\"Approve Plan\\"');
    expect(result.stdout).toContain("could not be parked");
    expect(readFileSync(file, "utf-8")).not.toContain("- **Parked**:");
  });

  // The approval is recorded before the stop. When the stop cannot be
  // recorded (a state with no Runtime State section, as a live run hit), the
  // person said stop, so nothing more runs until they say to go on.
  test("an approval whose stop cannot be recorded says so and does not send the agent on to the build", () => {
    const proj = project();
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace(/^## Runtime State\n/m, ""), "utf-8");
    askFor(proj);
    reply(proj, "approve the plan, but let's stop there for today");
    const said = answer(proj, "Approve Plan", ["--park", "--session", SESSION]);
    expect(said.code, said.message).toBe(0);
    expect(said.recorded).toBe("approve");
    expect(said.message).toContain("the stop they asked for could not be recorded");
    expect(said.message).toContain("Tell them in one line that the plan is approved");
    expect(said.message).toContain("Do not run next or start any work until they do.");
    expect(said.message).not.toMatch(/(?:^|[.;] )[Rr]un next\./);
    expect(readFileSync(file, "utf-8")).not.toContain("- **Parked**:");
  });

  test("an approval that asks to stop parks an autonomous run too", () => {
    const proj = project();
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace(
      "## Current Status", "## Current Status\n- **Construction Autonomy Mode**: autonomous",
    ), "utf-8");
    askFor(proj);
    reply(proj, "Approve the plan, but let's stop there for today");
    const said = answer(proj, "Approve Plan", ["--park"]);
    expect(said.message).toContain('Recorded "Approve Plan"');
    expect(said.message).toContain("The workflow is parked");
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

  // "Approve, but rename slugify to toSlug" is an approval plus an
  // instruction: the agent makes the change in the plan, then records the
  // approval, which covers the plan as it stands then. No second question.
  test("an approval with an instruction: the plan is edited, then approved as it stands, with no second question", () => {
    const proj = project();
    askFor(proj);
    const plan = join(stageDir(proj), "code-generation-plan.md");
    // Before they reply, the plan stays as shown.
    expect(guardWrite(proj, plan).code).toBe(2);
    reply(proj, "approve, but rename slugify to toSlug");
    // After it, the guard lets the agent change this plan and its test
    // instructions, and nothing else.
    expect(guardWrite(proj, plan).code).toBe(0);
    expect(guardWrite(proj, join(stageDir(proj), "unit-test-instructions.md")).code).toBe(0);
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-questions.md")).code).toBe(2);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    writePlan(proj, "- [ ] Step 2: rename slugify to toSlug\n");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.message).toContain("changed since it was shown");
    // The approval covers the plan as edited.
    expect(evaluateCodeGenerationApproval(proj, { unit: null }).ok).toBe(true);
    expect(auditText(proj)).toContain("**Person Reply**: approve, but rename slugify to toSlug");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("an approval with an instruction and a stop: edited, approved, and parked", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "approve, but rename slugify to toSlug, and let's stop for today");
    writePlan(proj, "- [ ] Step 2: rename slugify to toSlug\n");
    expect(answer(proj, "Approve Plan", ["--park"]).message).toContain("The workflow is parked");
    expect(next(proj).kind).toBe("parked");
  });

  test("an exact pick is recorded by the hook; the agent recording it too is fine, and a different choice is refused", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(answer(proj, "Approve Plan").message).toContain("already recorded");
    const overruled = answer(proj, "Request Changes");
    expect(overruled.code).not.toBe(0);
    expect(overruled.message).toContain('The person picked "Approve Plan"');
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // A new chat whose first message is "/aidlc approve the code plan": the words
  // answer the open question the first time. They are not asked about as new
  // work, and the agent's record of the choice is not refused.
  test("a reply typed after /aidlc in a new chat answers the plan question, with no new-work question", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "/aidlc approve the code plan", OTHER_SESSION);
    const read = next(proj, ["approve", "the", "code", "plan"]);
    expect(read.kind, JSON.stringify(read)).toBe("print");
    expect(read.ask_type).toBeUndefined();
    expect(read.message).toContain("--checkpoint plan-approval");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(auditText(proj)).toContain("**Person Reply**: approve the code plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("an exact pick typed after /aidlc is recorded at once, and its words lead straight to the build", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "/aidlc 1");
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    const read = next(proj, ["1"]);
    expect(read.kind, JSON.stringify(read)).toBe("print");
    expect(read.message).toContain("it is recorded");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // The person's latest pick stands: a Request Changes after an exact approval
  // is never reported as recorded while the approval builds.
  test("a later Request Changes after an exact approval names the step that brings the plan back", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "/aidlc 1");
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    reply(proj, "/aidlc Request Changes");
    const read = next(proj, ["Request", "Changes"]);
    expect(read.kind, JSON.stringify(read)).toBe("print");
    expect(read.message).not.toContain("it is recorded");
    expect(read.message).toContain("--details 'Review the plan'");
    const reviewed = answer(proj, "Review the plan");
    expect(reviewed.code, reviewed.message).toBe(0);
    const again = next(proj);
    expect(again.kind, JSON.stringify(again)).toBe("ask");
    expect(again.ask_type).toBe("plan-approval");
  });

  // Both halves of one message are done: the switch lands on this work, and
  // the choice typed after it answers the plan question.
  test("a switch typed before a plan choice applies to this work, and the choice is recorded", () => {
    const proj = project("strict");
    askFor(proj);
    reply(proj, "/aidlc --guard-policy relaxed Approve Plan");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("- **Guard Policy**: relaxed (set by you)");
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("Guard Policy off typed before a plan choice lands on this work, which then builds", () => {
    const proj = project("strict");
    askFor(proj);
    reply(proj, "/aidlc --guard-policy off Approve Plan");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("- **Guard Policy**: off (set by you)");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
  });

  test("a command typed after /aidlc is still no answer to the plan question", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "/aidlc --status");
    const early = answer(proj, "Approve Plan");
    expect(early.code).not.toBe(0);
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    // The step it names works once they reply.
    reply(proj, "approve it");
    expect(answer(proj, "Approve Plan").code).toBe(0);
  });

  test("an answer from another chat on the same work counts", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "Approve Plan", OTHER_SESSION);
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("Request Changes in the person's words reaches the revision, and a revised plan is asked about again", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "rename slugify to toSlug");
    expect(answer(proj, "Request Changes").message).toContain('Recorded "Request Changes"');
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

  // The agent may word the picker its own way: the pick counts by the choices
  // it offers, not by the question's wording. Several picks, or a picker that
  // offers none of the plan's choices, answer some other question.
  test("a picker the agent worded differently still answers the plan question by its choices", () => {
    const proj = project();
    askFor(proj);
    const pick = (question: string, options: string[], chosen: string, multiSelect = false) => {
      const asked = [{ question, header: "Plan", multiSelect, options: options.map((label) => ({ label, description: "" })) }];
      const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
        cwd: proj,
        input: JSON.stringify({
          hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
          tool_input: { questions: asked },
          tool_response: { questions: asked, answers: { [question]: chosen } },
        }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(result.status, result.stderr).toBe(0);
    };
    pick("Ready to build?", ["Yes", "No"], "Yes");
    pick("Which of these?", ["Approve Plan", "Request Changes"], "Approve Plan, Request Changes", true);
    // A picker sharing a label with the question, or adding one of its own, is
    // some other question, whichever option the person picked there.
    pick("Rename the module first?", ["Request Changes", "Something else"], "Something else");
    pick("Shall I build this plan?", ["Approve Plan", "Show me the plan first"], "Approve Plan");
    // Nor is a picker offering only its approve choice, or a label twice.
    pick("Shall I build this plan?", ["Approve Plan"], "Approve Plan");
    pick("Shall I build this plan?", ["Approve Plan", "Approve Plan", "Request Changes"], "Approve Plan");
    expect(answer(proj, "Approve Plan").message).toContain("has not replied to the plan question");
    pick("Shall I build this plan for slugify?", ["Approve Plan (Recommended)", "Request Changes", "I'll edit the files"],
      "Approve Plan (Recommended)");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
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

  // In a conversation that is not in English the question is translated, and
  // the choice labels stay exactly as given, so the pick still records.
  test("a Codex picker pick under a translated question approves the plan", () => {
    const proj = project();
    askFor(proj);
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(proj, ".codex"), { recursive: true });
    const session = "codex-plan-approval-session-fr";
    writeSessionPidEntry(proj, process.pid, session);
    const result = spawnSync(BUN, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], {
      cwd: proj,
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: session,
        turn_id: "codex-turn-fr",
        cwd: proj,
        tool_name: "request_user_input",
        tool_input: {
          questions: [{
            id: "plan",
            question: "El plan esta listo. Quieres aprobarlo?",
            options: ["Approve Plan (Recommended)", "Request Changes", "I'll edit the files"],
          }],
        },
        tool_response: JSON.stringify({ answers: { plan: { answers: ["Approve Plan (Recommended)"] } } }),
        tool_use_id: "request-codex-turn-fr",
      }),
      env: { ...process.env, AIDLC_UNATTENDED: undefined, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("a question records nothing; the agent answers it, and their next reply decides", () => {
    const proj = project();
    askFor(proj);
    expect(reply(proj, "what does step 1 do?")).toBe("");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).ask_type).toBe("plan-approval");
    reply(proj, "ok, go ahead");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(auditText(proj)).toContain("**Person Reply**: what does step 1 do?\\nok, go ahead");
  });

  // A question is the agent's to answer: the words are kept for it, nothing is
  // recorded, and a plain "yes" after it is the agent's to read too.
  test("a question about switching plan approval off, typed or in the picker, records nothing; the agent reads it", () => {
    const proj = project();
    const question = String(askFor(proj).question);
    reply(proj, "skip plan approval?");
    reply(proj, "yes");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    const asked = [{
      question, header: "Plan", multiSelect: false,
      options: [{ label: "Approve Plan (Recommended)", description: "" }, { label: "Request Changes", description: "" }],
    }];
    const picked = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
      cwd: proj,
      input: JSON.stringify({
        hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
        tool_input: { questions: asked },
        tool_response: { questions: asked, answers: { [question]: "skip plan approval?" } },
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(picked.status, picked.stderr).toBe(0);
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(auditText(proj)).not.toContain("**Event**: CEREMONY_SET");
    expect(auditText(proj)).not.toContain("**Event**: QUESTION_ANSWERED");
    expect(next(proj).kind).toBe("ask");
  });

  test("edit mode: the agent cannot touch the files, and done approves them as the person left them", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "I'll edit the files");
    const editing = next(proj);
    expect(editing.kind).toBe("ask");
    expect(editing.plan_approval.editing).toBe(true);
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-plan.md")).code).toBe(2);
    // The person edits in their own editor.
    writePlan(proj, "- [ ] Step 2: handle unicode\n");
    expect(next(proj).plan_approval.editing).toBe(true);
    reply(proj, "done");
    const said = answer(proj, "Approve Plan");
    expect(said.message).toContain('Recorded "Approve Plan"');
    expect(said.message).toContain("changed since it was shown");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("edit mode: what the person wrote in the questions file is read by the agent and recorded", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "3");
    const path = join(stageDir(proj), "code-generation-questions.md");
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace(/^\[Answer\]:$/m, "### My answer\n\n[Answer]: use a lookup table\n\n[Answer]:"),
      "utf-8",
    );
    reply(proj, "done");
    expect(answer(proj, "Request Changes", ["--reason", "use a lookup table"]).message).toContain('Recorded "Request Changes"');
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "use a lookup table" });
  });

  test("edit mode: a Testing Contract the edit broke is repaired, then asked about once", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "I'll edit the files");
    const planPath = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(planPath, readFileSync(planPath, "utf-8").replace('"version": 1', '"version": 1,,'), "utf-8");
    reply(proj, "done");
    expect(answer(proj, "Approve Plan").message).toContain("broke the Testing Contract block");
    const repair = next(proj);
    expect(repair.kind).toBe("run-stage");
    expect(repair.plan_approval.status).toBe("repair");
    writePlan(proj, "- [ ] Step 2: handle unicode\n");
    const ask = next(proj);
    expect(ask.kind).toBe("ask");
    expect(ask.question).toBe("I repaired the Testing Contract block. Build your edited plan?");
  });

  // The person's stop holds even when the plan they approved needs repair
  // first: the repair waits until they resume (#1411).
  test("edit mode: approve and stop parks even when the Testing Contract needs repair", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "I'll edit the files");
    const planPath = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(planPath, readFileSync(planPath, "utf-8").replace('"version": 1', '"version": 1,,'), "utf-8");
    reply(proj, "done, and let's stop for today");
    const said = answer(proj, "Approve Plan", ["--park"]);
    expect(said.message).toContain("broke the Testing Contract block");
    expect(said.message).toContain("The workflow is parked");
    expect(next(proj).kind).toBe("parked");
    const unpark = spawnSync(BUN, [STATE, "unpark", "--project-dir", proj], { encoding: "utf-8" });
    expect(unpark.status, unpark.stderr).toBe(0);
    const repair = next(proj);
    expect(repair.kind).toBe("run-stage");
    expect(repair.plan_approval.status).toBe("repair");
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

  // With Guard Policy off or relaxed a changed file is not a new question: a
  // note added to the answered questions file, or a checkout that rewrote its
  // line endings, keeps the person's approval. Strict still asks.
  test.each(["relaxed", "off"] as const)("under %s, a note or new line endings in the answered questions file keep the approval", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "1");
    const path = join(stageDir(proj), "code-generation-questions.md");
    writeFileSync(path, `${readFileSync(path, "utf-8").replace(/\n/g, "\r\n")}\r\nNote: checked with the team.\r\n`, "utf-8");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  test("under strict, a note added to the answered questions file is asked about again", () => {
    const proj = project("strict");
    askFor(proj);
    reply(proj, "1");
    const path = join(stageDir(proj), "code-generation-questions.md");
    writeFileSync(path, `${readFileSync(path, "utf-8")}\nNote: checked with the team.\n`, "utf-8");
    expect(next(proj).kind).toBe("ask");
  });

  test("'review the plan' after approval asks again before anything is built", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    reply(proj, "review the plan first");
    expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    const ask = next(proj);
    expect(ask.kind).toBe("ask");
    reply(proj, "1");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // From a live VS Code Copilot run: a request to run checks before deciding
  // was taken as Request Changes, and the approval that followed was lost.
  const BEFORE_DECIDING = "before I decide, run the AI-DLC doctor and the version check and show me what they say";
  const APPROVE_AND_STOP = "approve the plan, but let's stop there for today";

  // Agents may leave out the optional third choice: the pick still counts.
  test("a picker offering Approve Plan and Request Changes, without \"I'll edit the files\", answers the plan question", () => {
    const proj = project();
    askFor(proj);
    const question = "Build this plan?";
    const asked = [{ question, header: "Plan", multiSelect: false, options: [{ label: "Approve Plan" }, { label: "Request Changes" }] }];
    const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
      cwd: proj,
      input: JSON.stringify({
        hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
        tool_input: { questions: asked }, tool_response: { questions: asked, answers: { [question]: "Approve Plan" } },
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // A reply that starts with a path is the person's own words, not a command.
  test("a reply that starts with a slash path is a reply: the agent's Approve Plan records it", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "/src/slugify.ts looks right, approve the plan");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(auditText(proj)).toContain("**Person Reply**: /src/slugify.ts looks right, approve the plan");
  });

  test("a request to run checks before deciding records only the turn and the words; the question stays open", () => {
    const proj = project();
    askFor(proj);
    const turns = (auditText(proj).match(/\*\*Event\*\*: HUMAN_TURN/g) ?? []).length;
    reply(proj, BEFORE_DECIDING);
    expect((auditText(proj).match(/\*\*Event\*\*: HUMAN_TURN/g) ?? []).length).toBe(turns + 1);
    expect(auditText(proj)).not.toContain("**Event**: QUESTION_ANSWERED");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(auditText(proj)).not.toMatch(/\*\*(Details|User Input)\*\*: Request Changes/);
    expect(next(proj).kind).toBe("ask");
  });

  // From a live Codex run: asking to be asked another way was taken as Request
  // Changes, so the next step would have revised the plan with it as feedback.
  test.each([
    "Please ask me that with the question picker instead.",
    "Can you show it to me as a list instead?",
    "Please use the request_user_input question box for that plan question.",
  ])("%s is no answer: the turn and the words are kept, nothing is recorded, and the question stays open", (words) => {
    const proj = project();
    askFor(proj);
    const turns = (auditText(proj).match(/\*\*Event\*\*: HUMAN_TURN/g) ?? []).length;
    reply(proj, words);
    expect((auditText(proj).match(/\*\*Event\*\*: HUMAN_TURN/g) ?? []).length).toBe(turns + 1);
    const dir = dirname(planApprovalRuntimeFile(proj, "ask.json"));
    const kept = readdirSync(dir).filter((name) => name.startsWith("ask-") && name.endsWith(".json"))
      .flatMap((name) => (JSON.parse(readFileSync(join(dir, name), "utf-8")).replies ?? []) as Array<{ text: string }>);
    expect(kept.map((entry) => entry.text)).toContain(words);
    expect(auditText(proj)).not.toContain("**Event**: QUESTION_ANSWERED");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(auditText(proj)).not.toMatch(/\*\*(Details|User Input)\*\*: Request Changes/);
    expect(next(proj).kind).toBe("ask");
  });

  test("then \"approve the plan, but let's stop there for today\": the agent's Approve Plan with --park approves and parks in one step", () => {
    const proj = project();
    askFor(proj);
    reply(proj, BEFORE_DECIDING);
    reply(proj, APPROVE_AND_STOP);
    const recorded = answer(proj, "Approve Plan", ["--park"]);
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.message).toContain('Recorded "Approve Plan"');
    expect(recorded.message).toContain("The workflow is parked");
    expect(auditText(proj)).toContain(APPROVE_AND_STOP);
    expect(next(proj).kind).toBe("parked");
    // Back from the stop, the plan is approved: nothing is asked again.
    expect(spawnSync(BUN, [STATE, "unpark", "--project-dir", proj], { encoding: "utf-8" }).status).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("had the agent read the first as Request Changes, the approval after it corrects it directly and parks", () => {
    const proj = project();
    askFor(proj);
    reply(proj, BEFORE_DECIDING);
    expect(answer(proj, "Request Changes").code).toBe(0);
    reply(proj, APPROVE_AND_STOP);
    const corrected = answer(proj, "Approve Plan", ["--park"]);
    expect(corrected.code, corrected.message).toBe(0);
    expect(corrected.message).toContain("correcting the Request Changes recorded before");
    expect(corrected.message).toContain("The workflow is parked");
    expect(auditText(proj)).toContain(`**Person Reply**: ${APPROVE_AND_STOP}`);
    expect(next(proj).kind).toBe("parked");
    expect(spawnSync(BUN, [STATE, "unpark", "--project-dir", proj], { encoding: "utf-8" }).status).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // A misread is cheap: when the person says the Request Changes the agent
  // read was wrong, their next reply is the approval, recorded at once.
  test("a misread Request Changes is corrected in one step: the agent records the approval from their next reply", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "looks good, maybe rename later");
    answer(proj, "Request Changes");
    expect(next(proj).plan_approval.status).toBe("revise");
    // Not before they reply again.
    expect(answer(proj, "Approve Plan").message).toContain("has not replied since Request Changes was recorded");
    reply(proj, "no, I approved it");
    const corrected = answer(proj, "Approve Plan");
    expect(corrected.code, corrected.message).toBe(0);
    expect(corrected.message).toContain("correcting the Request Changes recorded before");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // An exact pick stands until the person replies again; then their newer
  // reply decides, as the agent reads it.
  test("an exact Request Changes pick is refused as an approval until the person replies again", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    expect(next(proj).plan_approval.status).toBe("revise");
    const refused = answer(proj, "Approve Plan");
    expect(refused.code).not.toBe(0);
    expect(refused.message).toContain('The person picked "Request Changes" for this plan and has not replied since');
    reply(proj, "ok, thanks");
    const read = answer(proj, "Approve Plan");
    expect(read.code, read.message).toBe(0);
    expect(read.message).toContain("correcting the Request Changes recorded before");
  });

  test("\"2\" then \"actually, approve it\": the agent records Approve Plan with no second question", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    reply(proj, "actually, approve it");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.message).toContain("correcting the Request Changes recorded before");
    // The correction carries the words that made it.
    expect(auditText(proj)).toContain("**Person Reply**: actually, approve it");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("\"2\" then \"1\": the second exact pick is recorded straight away, with no step for the agent", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    reply(proj, "1");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("\"2\" and no newer reply: an approval record is refused, before and after next", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    expect(answer(proj, "Approve Plan").message).toContain('The person picked "Request Changes" for this plan');
    expect(next(proj).plan_approval.status).toBe("revise");
    expect(answer(proj, "Approve Plan").message).toContain('The person picked "Request Changes" for this plan');
    expect(evaluateCodeGenerationApproval(proj, { unit: null }).ok).toBe(false);
  });

  test("a rejected gate sends the approved plan back with the person's words, then asks about the revised plan", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
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
      // A step that runs a project command which writes files on its own.
      writePlan(proj, "- [ ] Step 2: run `bun install` to add the slug dependency\n", unit);
      const ask = next(proj);
      expect(ask.kind, JSON.stringify(ask)).toBe("ask");
      expect(ask.ask_type).toBe("plan-approval");
      reply(proj, "yes");
      expect(answer(proj, "Approve Plan").message).toContain('Recorded "Approve Plan"');
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
      // The worker is told to do file work with its file tools, before the approved content.
      expect(brief.stdout).toContain(`## Files and commands\n\n${FILE_TOOLS_RULE}\n`);
      expect(brief.stdout.indexOf("## Files and commands")).toBeLessThan(brief.stdout.indexOf("## Approved plan"));
      // The rule is about the worker writing a file itself: a command the
      // person asks for or the plan names still runs, even a mkdir.
      expect(brief.stdout).toContain("Step 2: run `bun install` to add the slug dependency");
      expect(FILE_TOOLS_RULE).toContain("A command the person asks for, or one the plan names");
      expect(FILE_TOOLS_RULE).toContain("even a `mkdir`), still runs as written");
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
    reply(proj, "rename slugify to toSlug");
    expect(answer(proj, "Request Changes").message).toContain('Recorded "Request Changes"');
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
    reply(proj, "1");
    expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
    reply(proj, "review the plan first");
    expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    expect(next(proj).kind).toBe("ask");
    reply(proj, "1");
    const build = nextThroughParts(proj);
    expect(build.parts).toBeGreaterThan(1);
    expect(build.directive.plan_approval).toEqual({ status: "approved" });
  });

  // AIDA F34: the question shown again after "Review the plan" is a fresh one.
  test("after Request Changes and \"Review the plan\", Approve Plan waits for a new reply, then records", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    reply(proj, "review the plan first");
    expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    const shown = next(proj);
    expect(shown.kind, JSON.stringify(shown)).toBe("ask");
    const early = answer(proj, "Approve Plan");
    expect(early.code, early.message).not.toBe(0);
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    reply(proj, "ok, approve it");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // AIDA F34: a question about the switch is kept as words but is no reply, so
  // the plan's files stay closed.
  test("\"skip plan approval?\" leaves the plan files closed to edits", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "skip plan approval?");
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-plan.md")).code).toBe(2);
    expect(guardWrite(proj, join(stageDir(proj), "unit-test-instructions.md")).code).toBe(2);
  });

  test("'review the plan first' said while the rules are arriving asks again before anything is built", () => {
    const proj = withRulesInParts(project());
    askFor(proj);
    reply(proj, "1");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    reply(proj, "review the plan first");
    expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    reply(proj, "1");
    expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
  });

  for (const policy of ["strict", "relaxed", "off"] as const) {
    test(`nothing is built or handed to a worker until the stage's own step arrives (Guard Policy ${policy})`, () => {
      const proj = withRulesInParts(project(policy));
      askFor(proj);
      reply(proj, "1");
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
    reply(proj, "1");
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
    reply(proj, "1");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    // Not every such step has a person reviewing it (an autonomous checkpoint,
    // the settled swarm), so the plan is shown while the person is asking.
    for (const step of BUILT_STEPS) {
      const intent = partFor(proj, step);
      reply(proj, "review the plan first");
      const said = answer(proj, "Review the plan").message;
      expect(said, JSON.stringify(step)).toContain("show them the plan now");
      expect(said).toContain("y" in step
        ? "construction/unit-a/code-generation/code-generation-plan.md"
        : "construction/code-generation/code-generation-plan.md");
      expect(said).not.toContain("shown for approval before anything else is built");
      expect(said).not.toContain("When it arrives");
      expect(planApprovalReviewRequested(proj, "stage:code-generation", intent)).toBe(false);
    }
  });

  test("a route edited on the marker is not trusted: 'review the plan first' still asks again before anything is built", () => {
    for (const step of BUILT_STEPS) {
      const proj = withRulesInParts(project());
      askFor(proj);
      reply(proj, "1");
      expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
      // The route now claims a step after the build, but its receipt was minted
      // for the build's own part.
      const intent = partFor(proj, step, true);
      reply(proj, "review the plan first");
      const said = answer(proj, "Review the plan").message;
      expect(said, JSON.stringify(step)).toContain("shown for approval before anything else is built");
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
    reply(proj, "1");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    // unit-b's build part, its top-level Unit edited to unit-a: the request is
    // still kept for unit-b, whose plan is asked about before it is built.
    const intent = partFor(proj, {}, false, { unit: "unit-a" });
    reply(proj, "review the plan first");
    const before = answer(proj, "Review the plan").message;
    expect(before).toContain("shown for approval before anything else is built");
    expect(before).toContain("unit-b");
    expect(before).not.toContain("unit-a");
    expect(planApprovalReviewRequested(proj, "unit:unit-b", intent)).toBe(true);
    expect(planApprovalReviewRequested(proj, "unit:unit-a", intent)).toBe(false);
    // unit-b's gate part, edited the same way: unit-b's plan is the one shown.
    partFor(proj, { o: true }, false, { unit: "unit-a" });
    reply(proj, "review the plan first");
    const after = answer(proj, "Review the plan").message;
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
    reply(proj, "1");
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

// After the person approves, the engine may say something else before the
// agent next asks what to do: the chat compacts and the agent must re-read its
// instructions, a guard-recovery question comes up, or the work is paused. None
// of those is a decision about the plan (#1411).
const INTERRUPTIONS = ["the chat compacts", "a guard-recovery question", "the work is paused"] as const;
type Interruption = typeof INTERRUPTIONS[number];

function interrupt(proj: string, how: Interruption): void {
  const state = readFileSync(seededStateFile(proj), "utf-8");
  if (how === "the chat compacts") {
    const marker = JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json"), "utf-8"));
    expect(invalidateActiveDirectiveContext(proj, state, marker.owner_session)).toBe(true);
    return;
  }
  writeActiveDirectiveMarker(proj, how === "the work is paused"
    ? { kind: "parked", stage: "code-generation", state_sha256: stateDigest(state) }
    : { kind: "ask", ask_type: "guard-recovery", stage: "code-generation", remedies: [], state_sha256: stateDigest(state) });
}

describe("after approval, whatever the engine said last", () => {
  for (const how of INTERRUPTIONS) {
    for (const unit of [null, "unit-2"]) {
      test(`${how}: the approved plan is built, not asked about again (${unit ?? "no Units"})`, () => {
        const proj = unit ? unitProject(unit) : project();
        writePlan(proj, "", unit);
        expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
        reply(proj, "1");
        interrupt(proj, how);
        const build = next(proj);
        expect(build.kind, JSON.stringify(build)).toBe("run-stage");
        expect(build.plan_approval).toEqual({ status: "approved" });
        expect(questions(proj, unit)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
        const brief = posture(proj, "brief", unit);
        expect(brief.status, brief.stderr).toBe(0);
        expect(brief.stdout).toContain("## Approved plan");
        expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
      });
    }
  }

  // The chat can compact while the question waits for the person. The question
  // is still theirs: their answer counts, and nothing the agent writes can
  // change the plan or answer for them meanwhile.
  test("the chat compacts while the question waits: the person's answer counts", () => {
    const proj = project();
    askFor(proj);
    interrupt(proj, "the chat compacts");
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-plan.md")).code).toBe(2);
    reply(proj, "1");
    expect(questions(proj)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  test("under strict, a plan edited after approval is asked about again", () => {
    const proj = project("strict");
    askFor(proj);
    reply(proj, "1");
    interrupt(proj, "the chat compacts");
    writePlan(proj, "- [ ] Step 2: add a fast path\n");
    expect(next(proj).kind).toBe("ask");
    expect(questions(proj)).toMatch(/^\[Answer\]:$/m);
  });

  // A compaction while the build's rules are arriving: the approval still
  // holds, the rules start again from part 1, and nothing is built or handed
  // to a worker until the build step itself arrives.
  test("the chat compacts while the rules arrive: the approval holds, and the build still waits for them", () => {
    const proj = withRulesInParts(project());
    askFor(proj);
    reply(proj, "1");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    interrupt(proj, "the chat compacts");
    const again = engineCall(proj, ["next"]);
    expect(again, JSON.stringify(again)).toMatchObject({ kind: "load-steering", part: 1 });
    for (const verb of ["brief", "begin"] as const) {
      const refused = posture(proj, verb, null);
      expect(refused.status).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain("The Code Generation rules are still arriving");
      expect(refused.stdout + refused.stderr).toContain(`continue ${again.receipt}`);
    }
    expect(generationStarted(proj)).toBe(false);
    expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
    expect(questions(proj)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
    const brief = posture(proj, "brief", null);
    expect(brief.status, brief.stderr).toBe(0);
    expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
  });

  test("Request Changes still sends the unchanged plan back for revision", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "rename slugify to toSlug");
    expect(answer(proj, "Request Changes").code).toBe(0);
    interrupt(proj, "the chat compacts");
    const revise = next(proj);
    expect(revise.kind, JSON.stringify(revise)).toBe("run-stage");
    expect(revise.plan_approval).toEqual({ status: "revise", feedback: "rename slugify to toSlug" });
  });

  test("'review the plan' still asks again", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    reply(proj, "review the plan first");
        expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    interrupt(proj, "the work is paused");
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("an approval for one Unit is not an approval for another", () => {
    const proj = unitProject("unit-2");
    writePlan(proj, "", "unit-2");
    writePlan(proj, "", "unit-3");
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "1");
    interrupt(proj, "the chat compacts");
    const route = (unit: string) => routeCodeGenerationPlanApproval(proj, {
      kind: "run-stage", stage: "code-generation", unit,
    } as Parameters<typeof routeCodeGenerationPlanApproval>[1]) as unknown as Emitted;
    expect(route("unit-2").plan_approval).toEqual({ status: "approved" });
    expect(route("unit-3")).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("one approval for several Units still builds all of them", () => {
    const { pd } = groupedProject();
    reply(pd, "approve all");
    interrupt(pd, "the chat compacts");
    const routed = routeCodeGenerationPlanApproval(pd, { kind: "invoke-swarm", stage: "code-generation", units: GROUP });
    expect((routed as unknown as Emitted).plan_approval).toEqual({ status: "approved" });
  });

  // "Review the plan first" is the person's own request, whatever the engine
  // said last: the plan is shown for approval again before anything is built.
  for (const how of INTERRUPTIONS) {
    for (const unit of [null, "unit-2"]) {
      test(`${how}, then 'review the plan first': the plan is asked about again (${unit ?? "no Units"})`, () => {
        const proj = unit ? unitProject(unit) : project();
        writePlan(proj, "", unit);
        expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
        reply(proj, "1");
        expect(next(proj).plan_approval).toEqual({ status: "approved" });
        interrupt(proj, how);
        reply(proj, "review the plan first");
        expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
        const ask = next(proj);
        expect(ask, JSON.stringify(ask)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
        expect(questions(proj, unit)).toMatch(/^\[Answer\]:$/m);
        reply(proj, "1");
        expect(next(proj).plan_approval).toEqual({ status: "approved" });
      });
    }
  }

  test("plan approval off, the work is paused, then 'review the plan first': the plan is asked about before more is built", () => {
    const proj = project("relaxed", "off");
    writePlan(proj);
    expect(next(proj).plan_approval).toMatchObject({ status: "approved", skipped: true });
    interrupt(proj, "the work is paused");
    reply(proj, "review the plan first");
        expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("a rejected gate after the chat compacts still sends the plan back with the person's words", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    interrupt(proj, "the chat compacts");
    appendAuditEntry("GATE_REJECTED", {
      Stage: "code-generation", "User Input": "Request Changes", Feedback: "log every slug",
    }, proj);
    const revise = next(proj);
    expect(revise.kind, JSON.stringify(revise)).toBe("run-stage");
    expect(revise.plan_approval).toEqual({ status: "revise", feedback: "log every slug" });
  });

  test("a new attempt at the stage after a pause still asks again", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    interrupt(proj, "the work is paused");
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation" }, proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(questions(proj)).toMatch(/^\[Answer\]:$/m);
  });
});

// One question for several Units whose plans are ready together (a swarm batch).
const GROUP = ["alpha", "beta"];

function swarmFixture(plans: boolean, group: string[] = GROUP, planApproval: "on" | "off" = "on"): string {
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
- **Guard Policy**: strict (set by you)${planApproval === "off" ? "\n- **Plan Approval**: off (set by you)" : ""}
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
  seedBoltDagBatches(pd, [group, ["later"]]);
  mkdirSync(join(pd, "src"), { recursive: true });
  const baseline = writeBaselineSourceSnapshot(pd, "code-generation", workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, pd);
  if (!plans) return pd;
  const contract = renderTestingContract(resolveTestingPosture(pd));
  for (const unit of group) {
    const dir = codeGenerationRecordDir(pd, unit);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "code-generation-plan.md"),
      `# Plan for ${unit}\n\n## Summary\n\n- Builds: ${unit}\n\n## Steps\n- [ ] Implement ${unit}\n\n${contract}`, "utf-8");
    writeFileSync(join(dir, "unit-test-instructions.md"), `# Tests\n\nRun ${unit} tests.\n`, "utf-8");
  }
  return pd;
}

/** The piece of work the active directive belongs to, as the review request records it. */
function markerIntent(pd: string): string {
  const marker = JSON.parse(readFileSync(join(activeDirectiveStorageDir(pd), "active-directive.json"), "utf-8")) as { intent_uuid?: string };
  return marker.intent_uuid ?? "bare-space";
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
    reply(pd, "approve all");
    for (const unit of GROUP) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(true);
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
  });

  test("a change naming one Unit: the agent sends only that Unit back and approves the rest", () => {
    const { pd } = groupedProject();
    reply(pd, "change beta: use a lookup table");
    expect(answer(pd, "Request Changes", ["--units", "beta"]).message).toContain("for alpha too");
    expect(answer(pd, "Approve Plan", ["--units", "alpha"]).message).toContain('Recorded "Approve Plan" for alpha');
    expect(evaluateCodeGenerationApproval(pd, { unit: "alpha" }).ok).toBe(true);
    expect(evaluateCodeGenerationApproval(pd, { unit: "beta" }).ok).toBe(false);
    expect(swarmState(pd).plan_approval).toEqual({
      status: "plan",
      units: [{ unit: "beta", status: "revise", feedback: "change beta: use a lookup table" }],
    });
  });

  test("a bare Request Changes for a group binds: the agent's Approve all is refused until a later reply", () => {
    const { pd } = groupedProject();
    reply(pd, "2");
    const refused = answer(pd, "Approve all");
    expect(refused.code).not.toBe(0);
    expect(refused.message).toContain('The person picked "Request Changes"');
    expect(answer(pd, "I'll edit the files").code).not.toBe(0);
    for (const unit of GROUP) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(false);
    reply(pd, "only beta, use a lookup table; alpha is fine");
    expect(answer(pd, "Request Changes", ["--units", "beta"]).code).toBe(0);
    expect(answer(pd, "Approve Plan", ["--units", "alpha"]).code).toBe(0);
    expect(evaluateCodeGenerationApproval(pd, { unit: "alpha" }).ok).toBe(true);
  });

  // A misread in a group is fixed for the one plan it was about: the other
  // plan's approval stands, and nothing is revised that the person approved.
  test("approve alpha, change beta, then 'beta is fine too': the agent approves beta in one step", () => {
    const { pd } = groupedProject();
    reply(pd, "alpha is good; beta, maybe a lookup table?");
    expect(answer(pd, "Request Changes", ["--units", "beta"]).code).toBe(0);
    expect(answer(pd, "Approve Plan", ["--units", "alpha"]).message).toContain('Recorded "Approve Plan" for alpha');
    expect(answer(pd, "Approve Plan", ["--units", "beta"]).message)
      .toContain("has not replied since Request Changes was recorded");
    reply(pd, "no, beta is fine too");
    const corrected = answer(pd, "Approve Plan", ["--units", "beta"]);
    expect(corrected.code, corrected.message).toBe(0);
    expect(corrected.message).toContain("correcting the Request Changes recorded before");
    expect(auditText(pd)).toContain("**Person Reply**: no, beta is fine too");
    for (const unit of GROUP) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(true);
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
  });

  // The agent's own Request Changes for a plan is not turned into an approval
  // until the person speaks again, even while the question is still open.
  test("a Request Changes recorded for one plan holds until the person replies after it", () => {
    const { pd } = groupedProject();
    reply(pd, "2");
    reply(pd, "beta");
    expect(answer(pd, "Request Changes", ["--units", "beta"]).code).toBe(0);
    const refused = answer(pd, "Approve Plan", ["--units", "beta"]);
    expect(refused.code).not.toBe(0);
    expect(refused.message).toContain("has not replied since Request Changes was recorded");
    expect(evaluateCodeGenerationApproval(pd, { unit: "beta" }).ok).toBe(false);
    reply(pd, "actually, beta is fine as it is");
    expect(answer(pd, "Approve Plan", ["--units", "beta"]).code).toBe(0);
    expect(evaluateCodeGenerationApproval(pd, { unit: "beta" }).ok).toBe(true);
  });

  // After the person replies, the agent can change the plans the question asks
  // about, for what they said; a plan outside the question, an answered plan,
  // the questions file and code stay as they are.
  test("after a reply, only the asked plans' own plan files can change", () => {
    const { pd } = groupedProject();
    const file = (unit: string, name: string) => join(codeGenerationRecordDir(pd, unit), name);
    expect(guardWrite(pd, file("alpha", "code-generation-plan.md")).code).toBe(2);
    // A bare pick says no plan: nothing opens until the person says which.
    reply(pd, "2");
    for (const unit of GROUP) expect(guardWrite(pd, file(unit, "code-generation-plan.md")).code).toBe(2);
    reply(pd, "approve alpha; beta, add a test for an empty list, then approve it");
    for (const unit of GROUP) {
      expect(guardWrite(pd, file(unit, "code-generation-plan.md")).code).toBe(0);
      expect(guardWrite(pd, file(unit, "unit-test-instructions.md")).code).toBe(0);
      expect(guardWrite(pd, file(unit, "code-generation-questions.md")).code).toBe(2);
    }
    expect(guardWrite(pd, file("later", "code-generation-plan.md")).code).toBe(2);
    expect(guardWrite(pd, join(pd, "src", "alpha.ts")).code).toBe(2);
    expect(answer(pd, "Approve Plan", ["--units", "alpha"]).code).toBe(0);
    expect(guardWrite(pd, file("alpha", "code-generation-plan.md")).code).toBe(2);
    expect(guardWrite(pd, file("beta", "code-generation-plan.md")).code).toBe(0);
  });

  test("a change naming no Unit: the agent asks which, then records it for the one named", () => {
    const { pd } = groupedProject();
    reply(pd, "change the error handling");
    expect(evaluateCodeGenerationApproval(pd, { unit: "alpha" }).ok).toBe(false);
    reply(pd, "alpha");
    answer(pd, "Request Changes", ["--units", "alpha", "--reason", "change the error handling"]);
    answer(pd, "Approve Plan", ["--units", "beta"]);
    expect(evaluateCodeGenerationApproval(pd, { unit: "beta" }).ok).toBe(true);
    expect(swarmState(pd).plan_approval.units).toEqual([
      { unit: "alpha", status: "revise", feedback: "change the error handling" },
    ]);
  });
});

// "Review the plan" is the person's own request, which the agent reads and
// records. It is never also the answer to another open question, it holds for
// every plan in a group until that plan is answered, and it is recorded for the
// whole group or not at all.
describe("'review the plan' next to other questions and for groups", () => {
  // A guard-recovery question for the stage whose only choice is Request
  // Changes: the hook takes a reply that is not the bare pick as what should
  // change, until the agent reads it as something else.
  function guardRecoveryQuestion(proj: string): void {
    writeActiveDirectiveMarker(proj, {
      kind: "ask", ask_type: "guard-recovery", stage: "code-generation",
      remedies: [{ op: "request-changes", action: 'Ask "What should change?"', interaction: "human-input" }],
      state_sha256: stateDigest(readFileSync(seededStateFile(proj), "utf-8")),
    });
  }
  const marker = (proj: string) =>
    JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json"), "utf-8"));
  const routeStage = (proj: string) => routeCodeGenerationPlanApproval(proj, {
    kind: "run-stage", stage: "code-generation",
  } as Parameters<typeof routeCodeGenerationPlanApproval>[1]) as unknown as Emitted;

  for (const words of ["review the plan first", "review the plan before building"]) {
    test(`'${words}' during a guard-recovery question: the agent's review request answers nothing else`, () => {
      const proj = project();
      askFor(proj);
      reply(proj, "1");
      expect(next(proj).plan_approval).toEqual({ status: "approved" });
      guardRecoveryQuestion(proj);
      reply(proj, words);
      const said = answer(proj, "Review the plan").message;
      expect(said).toContain("wants to review the plan");
      expect(said).toContain("not taken as the answer to the open recovery question");
      // No remedy is chosen for them: the question still waits.
      expect(marker(proj).guard_recovery_response).toBeUndefined();
      expect(marker(proj).delivery).not.toBe("consumed");
      expect(routeStage(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    });
  }

  test("'review the plan before building' during a protected checkpoint question picks nothing there", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    mintProtectedQuestion(proj, { kind: "verification-command", session: SESSION, target: { commandSha256: "a".repeat(64) } });
    reply(proj, "review the plan before building");
    expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    expect(readProtectedResponse(proj, SESSION)?.choice).toBeUndefined();
    expect(routeStage(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  // The engine presents Code Generation's completion gate as its own
  // run-stage; the presentation is the stage's latest lifecycle row.
  test("'review the plan' at the stage's completion gate shows the plan now; during the build it asks again", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    appendAuditEntry("STAGE_AWAITING_APPROVAL", { Stage: "code-generation" }, proj);
    reply(proj, "review the plan");
    const atGate = answer(proj, "Review the plan").message;
    expect(atGate).toContain("show them the plan now");
    expect(atGate).toContain("construction/code-generation/code-generation-plan.md");
    expect(atGate).toContain("carry on with this gate");
    expect(atGate).not.toContain("before anything else is built");
    // Sent back at the gate: the plan is asked about before it is rebuilt.
    appendAuditEntry("STAGE_REVISING", { Stage: "code-generation" }, proj);
    reply(proj, "review the plan");
    expect(answer(proj, "Review the plan").message).toContain("shown for approval before anything else is built");
  });

  test("a reply that answers the guard-recovery question stays its answer when the agent records no review", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    guardRecoveryQuestion(proj);
    reply(proj, "Request Changes: review the plan's error handling");
    expect(marker(proj).guard_recovery_response).toMatchObject({ status: "ready", selected_op: "request-changes" });
    expect(routeStage(proj).plan_approval).toEqual({ status: "approved" });
  });

  for (const group of [GROUP, ["alpha", "beta", "gamma"]]) {
    test(`plan approval off: a review asked for during a pause holds for every plan in a group of ${group.length} until each is answered`, () => {
      const pd = swarmFixture(true, group, "off");
      const state = () => stateDigest(readFileSync(seededStateFile(pd), "utf-8"));
      writeActiveDirectiveMarker(pd, { kind: "parked", stage: "code-generation", state_sha256: state() });
      reply(pd, "review the plan first");
      expect(answer(pd, "Review the plan").message).toContain("wants to review the plan");
      writeActiveDirectiveMarker(pd, { kind: "invoke-swarm", stage: "code-generation", units: group, state_sha256: state() });
      const routed = routeCodeGenerationPlanApproval(pd, { kind: "invoke-swarm", stage: "code-generation", units: group });
      expect((routed as unknown as Emitted).kind).toBe("ask");
      writeActiveDirectiveMarker(pd, {
        kind: "ask", stage: "code-generation", ask_type: "plan-approval", units: group, state_sha256: state(),
      });
      publishPlanApprovalAsk(pd, routed as Parameters<typeof publishPlanApprovalAsk>[1]);
      reply(pd, "change beta: use a lookup table");
      // The agent sends beta back with their words and approves the rest.
      expect(answer(pd, "Request Changes", ["--units", "beta"]).code).toBe(0);
      expect(answer(pd, "Approve Plan", ["--units", group.filter((unit) => unit !== "beta").join(",")]).code).toBe(0);
      const swarm = (units: string[]) => {
        writeActiveDirectiveMarker(pd, { kind: "invoke-swarm", stage: "code-generation", units, state_sha256: state() });
        return routeCodeGenerationPlanApproval(pd, { kind: "invoke-swarm", stage: "code-generation", units }) as unknown as Emitted;
      };
      expect(swarm(group).plan_approval.units).toEqual([
        { unit: "beta", status: "revise", feedback: "change beta: use a lookup table" },
      ]);
      // The revised plan is shown before it is built, though plan approval is off.
      const dir = codeGenerationRecordDir(pd, "beta");
      writeFileSync(join(dir, "code-generation-plan.md"),
        readFileSync(join(dir, "code-generation-plan.md"), "utf-8").replace("- [ ] Implement beta", "- [ ] Implement beta with a lookup table"), "utf-8");
      const revised = swarm(group);
      expect(revised.kind, JSON.stringify(revised)).toBe("ask");
      expect((revised.plan_approval.targets ?? []).map((target) => target.unit)).toEqual(["beta"]);
    });
  }

  test("a review for a group is recorded for every plan or for none", () => {
    const { pd } = groupedProject();
    reply(pd, "approve all");
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
    // The second plan's request cannot be written.
    const key = createHash("sha256").update(`${markerIntent(pd)}\nunit:beta`, "utf-8").digest("hex").slice(0, 24);
    const blocked = planApprovalRuntimeFile(pd, `review-request-${key}.json`);
    mkdirSync(join(blocked, "occupied"), { recursive: true });
    reply(pd, "review the plan first");
    expect(answer(pd, "Review the plan").message).toContain("could not be recorded");
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
    rmSync(blocked, { recursive: true, force: true });
    expect(answer(pd, "Review the plan").message).toContain("wants to review the plan for alpha and beta");
    expect(swarmState(pd)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("a review is kept per piece of work, and one kept by an earlier release still counts until answered", () => {
    const { pd } = groupedProject();
    reply(pd, "approve all");
    const intent = markerIntent(pd);
    // Another piece of work in this checkout asks to review the same plan.
    const other = "01995000-7a11-7000-8000-0000000000aa";
    const otherKey = createHash("sha256").update(`${other}\nunit:beta`, "utf-8").digest("hex").slice(0, 24);
    writeFileSync(planApprovalRuntimeFile(pd, `review-request-${otherKey}.json`),
      `${JSON.stringify({ version: 1, targetId: "unit:beta", intentId: other, requestedAt: new Date().toISOString() })}\n`, "utf-8");
    expect(planApprovalReviewRequested(pd, "unit:beta", intent)).toBe(false);
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
    // A request an earlier release wrote, keyed by the plan alone.
    const legacyKey = createHash("sha256").update("unit:beta", "utf-8").digest("hex").slice(0, 24);
    const legacy = planApprovalRuntimeFile(pd, `review-request-${legacyKey}.json`);
    writeFileSync(legacy,
      `${JSON.stringify({ version: 1, targetId: "unit:beta", intentId: intent, requestedAt: new Date().toISOString() })}\n`, "utf-8");
    expect(planApprovalReviewRequested(pd, "unit:beta", intent)).toBe(true);
    const asked = swarmState(pd);
    expect(asked, JSON.stringify(asked)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect((asked.plan_approval.targets ?? []).map((target) => target.unit)).toEqual(["beta"]);
    writeActiveDirectiveMarker(pd, {
      kind: "ask", stage: "code-generation", ask_type: "plan-approval", units: ["beta"],
      state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
    });
    publishPlanApprovalAsk(pd, asked as unknown as Parameters<typeof publishPlanApprovalAsk>[1]);
    reply(pd, "1");
    expect(existsSync(legacy)).toBe(false);
    expect(planApprovalReviewRequested(pd, "unit:beta", other)).toBe(true);
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
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

// While a plan waits, what the person asks for runs the first time: every
// command the engine itself names for their request gets through the guard,
// and code still waits for the approved plan.
describe("what the engine names while a plan waits", () => {
  // Commands a directive names: its command fields and backticked commands.
  function namedCommands(directive: unknown): string[] {
    const out = new Set<string>();
    const visit = (value: unknown, key = ""): void => {
      if (typeof value === "string") {
        if (/(^|_)command$/.test(key) && /^(bun|aidlc)\b/.test(value)) out.add(value);
        for (const m of value.matchAll(/`((?:bun|aidlc) [^`]*)`/g)) out.add(m[1]);
      } else if (Array.isArray(value)) {
        for (const entry of value) visit(entry, key);
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) visit(v, k);
      }
    };
    visit(directive);
    return [...out];
  }
  // The protocol's own placeholders, filled the way the agent fills them here.
  function filled(command: string): string {
    return command
      .replaceAll("<slug>", "code-generation")
      .replaceAll('"<directive.stage>"', "code-generation")
      .replaceAll("<first|revision|stale>", "first")
      .replace(/"<[^"]*>"/g, '"x"');
  }
  // The review brief and the stage's question rows, as the shipped protocol names them.
  function protocolCommands(): string[] {
    const dir = join(AIDLC_SRC, "aidlc-common", "protocols");
    const text = ["stage-protocol.md", "stage-protocol-reviewer.md"]
      .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
    // A checkpoint row keeps its own rule, so only the plain question rows.
    const commands = [...text.matchAll(/`(bun \.claude\/tools\/[^`\n]*(?:aidlc-review-brief\.ts|engine log (?:decision|answer) --stage <slug>)[^`\n]*)`/g)]
      .map((m) => filled(m[1]))
      .filter((command) => !command.includes("--checkpoint"));
    expect(commands.length, "the protocol names no review brief or log row").toBeGreaterThan(3);
    return [...new Set(commands)];
  }
  function waitingPlan(): string {
    const proj = project("strict");
    cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
    askFor(proj);
    return proj;
  }
  function resumeReport(proj: string, choice: string): unknown {
    const result = spawnSync(BUN, [ORCHESTRATE, "report", "--result", "resumed", "--user-input", choice, "--project-dir", proj], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const line = (result.stdout ?? "").split("\n").filter((entry) => entry.startsWith("{")).pop();
    expect(line, `${result.stdout}${result.stderr}`).toBeDefined();
    return JSON.parse(line as string);
  }

  test.each([
    ["status", "/aidlc --status", ["--status"]],
    ["help", "/aidlc --help", ["--help"]],
    ["doctor", "/aidlc --doctor", ["--doctor"]],
    ["version", "/aidlc --version", ["--version"]],
    ["a jump back", "/aidlc --stage nfr-requirements", ["--stage", "nfr-requirements"]],
    ["a jump to Reverse Engineering", "/aidlc --stage reverse-engineering", ["--stage", "reverse-engineering"]],
    ["a redo of this stage", "/aidlc --stage code-generation", ["--stage", "code-generation"]],
    ["a skip", "/aidlc --skip build-and-test", ["--skip", "build-and-test"]],
    ["new work beside it", "/aidlc --new-intent add a csv export", ["--new-intent", "--scope", "poc", "add a csv export"]],
    ["the resume menu's redo", "redo this stage from the start", null],
  ] as const)("%s: every command the engine names gets through", (_label, typed, args) => {
    const proj = waitingPlan();
    reply(proj, typed);
    const directive = args === null ? resumeReport(proj, "2") : next(proj, [...args]);
    const commands = namedCommands(directive).map(filled);
    expect(commands.length, `no command named: ${JSON.stringify(directive)}`).toBeGreaterThan(0);
    for (const command of commands) {
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
    }
    // Code is still held for the plan.
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
  });

  test("the review brief and the stage's question rows get through, and an added write does not", () => {
    const proj = waitingPlan();
    for (const command of protocolCommands()) {
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
      expect(guardBash(proj, `${command}; printf x > src/a.ts`).code, `${command} with a write`).toBe(2);
    }
  });

  test("a review the person asks for runs while the plan waits: its request, its own review file and dispatch record, nothing else", () => {
    const proj = waitingPlan();
    const request = "bun .claude/tools/aidlc.ts engine log review --stage code-generation --reviewer aidlc-architecture-reviewer-agent --iteration 2";
    // A move the person asks for: it waits for them to have spoken.
    expect(guardBash(proj, request).code).toBe(2);
    reply(proj, "before I approve the plan, have the reviewer look at it again");
    expect(guardBash(proj, request).code, guardBash(proj, request).stderr).toBe(0);
    expect(guardBash(proj, `${request} --verdict READY`).code).toBe(0);
    // The request it records names the reviewer's file.
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
    const reviewFile = ".aidlc-engine/reviews/code-generation/stage/a1/2.0123456789abcdef0123456789abcdef.review.md";
    const dispatch = join(record, ".aidlc-engine", "reviewer-dispatch.json");
    expect(guardWrite(proj, join(record, reviewFile)).code).toBe(2);
    expect(guardWrite(proj, dispatch).code).toBe(2);
    appendAuditEntry("REVIEW_REQUESTED", {
      Stage: "code-generation", Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "2",
      "Request Id": "review:0123456789abcdef0123456789abcdef", "Review File": reviewFile,
    }, proj);
    expect(guardWrite(proj, join(record, reviewFile)).code).toBe(0);
    expect(guardWrite(proj, dispatch).code).toBe(0);
    expect(guardBash(proj, `rm ${dispatch}`).code).toBe(0);
    // Everything else still waits for the plan answer.
    expect(guardWrite(proj, join(record, ".aidlc-engine", "reviews", "code-generation", "stage", "a1", "3.other.review.md")).code).toBe(2);
    expect(guardWrite(proj, join(record, "construction", "code-generation", "code-summary.md")).code).toBe(2);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    expect(guardBash(proj, `printf x > ${dispatch}; printf x > src/a.ts`).code).toBe(2);
    // Once the review completes, its files wait again.
    appendAuditEntry("REVIEW_COMPLETED", {
      Stage: "code-generation", Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "2", Verdict: "READY",
      "Request Id": "review:0123456789abcdef0123456789abcdef",
    }, proj);
    expect(guardWrite(proj, join(record, reviewFile)).code).toBe(2);
    expect(guardWrite(proj, dispatch).code).toBe(2);
  });

  test("a move the person asked for waits for them to have spoken", () => {
    const proj = waitingPlan();
    const jump = "bun .claude/tools/aidlc-jump.ts execute --target nfr-requirements --direction backward --scope poc";
    expect(guardBash(proj, jump).code).toBe(2);
    expect(guardBash(proj, "bun .claude/tools/aidlc.ts engine recompose --skip build-and-test").code).toBe(2);
    reply(proj, "/aidlc --stage nfr-requirements");
    // The jump the engine printed for that request.
    expect(namedCommands(next(proj, ["--stage", "nfr-requirements"]))).toContain(jump);
    const verdict = guardBash(proj, jump);
    expect(verdict.code, verdict.stderr).toBe(0);
    // A skip passes with its own flags only.
    expect(guardBash(proj, "bun .claude/tools/aidlc.ts engine recompose --skip build-and-test --scope feature").code).toBe(2);
  });

  // From a live run: a skip typed while the plan waited left the plan
  // question behind, so the approval that followed was not kept against it
  // and the record carried the person's earlier question as their words.
  test("after a skip typed while the plan waits, the person's answer is kept with their words", () => {
    const proj = waitingPlan();
    // The skip reads the plan's scope from the installed tree.
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    reply(proj, "/aidlc --skip feedback-optimization");
    const named = next(proj, ["--skip", "feedback-optimization"]);
    const recompose = namedCommands(named).find((command) => command.includes("engine recompose"));
    expect(recompose, JSON.stringify(named)).toBeDefined();
    const verdict = guardBash(proj, recompose as string);
    expect(verdict.code, `${recompose}\n${verdict.stderr}`).toBe(0);
    runInstalled(proj, recompose as string);
    // The plan question is still the open step.
    expect(planApprovalAskIsOpen(proj)).toBe(true);
    reply(proj, "approve the plan, but let's stop there for today");
    const said = answer(proj, "Approve Plan", ["--park"]);
    expect(said.code, said.message).toBe(0);
    expect(auditText(proj)).toContain("**Person Reply**: approve the plan, but let's stop there for today");
  });

  // Only the skip's own write keeps the plan question open: any other change
  // to the work's state still leaves it out of date, and the engine asks again.
  test("a state change from anything but the skip still leaves the plan question out of date", () => {
    const proj = waitingPlan();
    expect(planApprovalAskIsOpen(proj)).toBe(true);
    const file = seededStateFile(proj);
    const before = readFileSync(file, "utf-8");
    const after = before.replace("- **Depth**: Standard", "- **Depth**: Minimal");
    expect(after).not.toBe(before);
    writeFileSync(file, after, "utf-8");
    expect(keepPlanApprovalAskOverStateWrite(proj, "# another state\n", after)).toBe(false);
    expect(planApprovalAskIsOpen(proj)).toBe(false);
  });

  // "This is existing code" at Code Generation: Reverse Engineering runs on
  // its own, and its own steps and writes are its work, not the build's.
  test("a Reverse Engineering run on its own at Code Generation is not held for the plan", () => {
    const proj = waitingPlan();
    reply(proj, "/aidlc --stage reverse-engineering --single");
    const run = next(proj, ["--stage", "reverse-engineering", "--single"]);
    expect(run.kind, JSON.stringify(run)).toBe("run-stage");
    expect(run.stage).toBe("reverse-engineering");
    const record = guardWrite(proj, join(seededRecordDir(proj), "inception", "reverse-engineering", "notes.md"));
    expect(record.code, record.stderr).toBe(0);
    const scan = guardBash(proj, "bun .claude/tools/aidlc.ts engine workspace codekb-scope-diff");
    expect(scan.code, scan.stderr).toBe(0);
    // The workspace source still waits for the approved plan, and so do the
    // work's state and a record hard-linked to source.
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    expect(guardBash(proj, "printf x > src/slugify.ts").code).toBe(2);
    expect(guardWrite(proj, seededStateFile(proj)).code).toBe(2);
    const linked = join(seededRecordDir(proj), "inception", "reverse-engineering", "linked.md");
    mkdirSync(dirname(linked), { recursive: true });
    linkSync(join(proj, "src", "base.ts"), linked);
    expect(guardWrite(proj, linked).code).toBe(2);
  });
});

// A project whose files cannot all be read (a very large repository, a link
// that loops) is no stop when Guard Policy is relaxed or off, or plan approval
// is off: the plan is asked about, or built as written, and the build starts
// with one line. Strict with plan approval on still names the repair.
describe("a project whose files cannot all be read", () => {
  function unreadable<T>(run: () => T): T {
    const before = process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES;
    process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES = "1";
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES;
      else process.env.AIDLC_TEST_SOURCE_MAX_ENTRIES = before;
    }
  }

  test.each(["relaxed", "off"] as const)("under %s the plan is asked, approved and built, with one line", (policy) => {
    const proj = project(policy);
    unreadable(() => {
      writePlan(proj);
      const asked = next(proj);
      expect(asked.kind, JSON.stringify(asked)).toBe("ask");
      expect(asked.ask_type).toBe("plan-approval");
      reply(proj, "1");
      expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
      const begun = posture(proj, "begin", null);
      expect(begun.status, begun.stderr).toBe(0);
      expect(begun.stdout).toContain("Building without a check of the project's files");
    });
  });

  test("plan approval off under strict builds the plan as written", () => {
    const proj = project("strict", "off");
    unreadable(() => {
      writePlan(proj);
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval?.status).toBe("approved");
      const begun = posture(proj, "begin", null);
      expect(begun.status, begun.stderr).toBe(0);
    });
  });

  test("strict with plan approval on still says what to repair before asking", () => {
    const proj = project("strict");
    unreadable(() => {
      writePlan(proj);
      const stopped = next(proj);
      expect(stopped.kind, JSON.stringify(stopped)).toBe("error");
      expect(stopped.message).toContain("cannot be presented");
    });
  });
});

describe("stopping for now at Code Generation", () => {
  // Coming back the next day: the unpark the engine names gets through the
  // guard, and the approved plan is built with no new question.
  test.each(["strict", "off"] as const)("after approve-and-stop, the resume the engine names builds the plan (%s)", (policy) => {
    const proj = project(policy);
    cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
    askFor(proj);
    reply(proj, "Approve the plan, but let's stop there for today");
    expect(answer(proj, "Approve Plan", ["--park"]).message).toContain("parked");
    const source = workspaceSourceFingerprint(proj);
    const unpark = resumeNamesUnpark(proj);
    const admitted = guardBash(proj, unpark);
    expect(admitted.code, admitted.stderr).toBe(0);
    runInstalled(proj, unpark);
    const build = next(proj, ["--resume"]);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
    expect(workspaceSourceFingerprint(proj)).toBe(source);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(0);
  });

  // Stopping before the plan is approved: the park gets through the guard
  // however it was asked for, and coming back asks about the same plan again.
  test.each([
    ["typed /aidlc park", "typed"],
    ["asked in words", "words"],
  ] as const)("a stop before approval parks and comes back to the plan question (%s)", (_label, how) => {
    const proj = project("strict");
    cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
    askFor(proj);
    const source = workspaceSourceFingerprint(proj);
    let park = "bun .claude/tools/aidlc.ts engine orchestrate park";
    if (how === "typed") {
      const named = next(proj, ["park"]);
      expect(named.kind, JSON.stringify(named)).toBe("print");
      park = /Run `([^`]+ park)`/.exec(named.message ?? "")?.[1] ?? "";
    }
    const parkAdmitted = guardBash(proj, park);
    expect(parkAdmitted.code, `${park}\n${parkAdmitted.stderr}`).toBe(0);
    expect(JSON.parse(runInstalled(proj, park)).kind).toBe("parked");
    expect(next(proj).kind).toBe("parked");
    const unpark = resumeNamesUnpark(proj);
    const unparkAdmitted = guardBash(proj, unpark);
    expect(unparkAdmitted.code, unparkAdmitted.stderr).toBe(0);
    runInstalled(proj, unpark);
    const back = next(proj, ["--resume"]);
    expect(back.kind, JSON.stringify(back)).toBe("ask");
    expect(back.ask_type).toBe("plan-approval");
    expect(workspaceSourceFingerprint(proj)).toBe(source);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
  });
});

// From a live run under production guards: at the plan question the person
// asked "skip plan approval?", a question about the switch the hook marks as a
// command turn, and nothing else. The agent recorded "Approve Plan" from it and
// built the code. A question or a command is no answer: the choice is refused,
// the question stays open, and the refusal names the real switch.
describe("a question about the switch is no answer to the plan question", () => {
  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, \"Approve Plan\" after only \"skip plan approval?\" is refused", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "skip plan approval?");
    const result = answer(proj, "Approve Plan");
    expect(result.code, result.message).not.toBe(0);
    expect(result.recorded).toBeUndefined();
    expect(result.message).toContain("not an answer");
    expect(result.message).toContain("engine config set guard.plan-approval off");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    // Their answer, when it comes, is recorded.
    reply(proj, "ok, approve it");
    const approved = answer(proj, "Approve Plan");
    expect(approved.code, approved.message).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });
});

// The conductor's call on #1677's asked form, from the same live run: a
// question about the check turns nothing off, the agent answers it and offers,
// and a yes is the ask. A request, plain or phrased as a question, turns it off
// at once. No tool reads more than that one asked form.
describe("a question about plan approval turns nothing off; a request does", () => {
  // The setter as the agent runs it under production guards: no presence bypass.
  function setter(proj: string): { code: number; out: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", "guard.plan-approval", "off"], {
      cwd: proj,
      env,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }
  const offRows = (proj: string) => (auditText(proj).match(/\*\*Event\*\*: (GUARD_DISABLED|CEREMONY_SET)/g) ?? []).length;

  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, \"skip plan approval?\" lowers nothing; a yes to the offer does, with their words", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "skip plan approval?");
    const refused = setter(proj);
    expect(refused.code, refused.out).not.toBe(0);
    expect(refused.out).toContain("asked a question about this check");
    expect(refused.out).toContain("offer to turn it off");
    expect(refused.out).not.toContain("They can also type");
    expect(offRows(proj)).toBe(0);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "yes");
    const lowered = setter(proj);
    expect(lowered.code, lowered.out).toBe(0);
    expect(offRows(proj)).toBeGreaterThan(0);
    expect(auditText(proj)).toContain("**Person Reply**: yes");
  });

  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, a polite request phrased as a question lowers it at once", (policy) => {
    for (const words of ["can you turn plan approval off for this work?", "could we skip plan approval?"]) {
      const proj = project(policy);
      askFor(proj);
      reply(proj, words);
      const lowered = setter(proj);
      expect(lowered.code, `${words}: ${lowered.out}`).toBe(0);
      expect(auditText(proj)).toContain(`**Person Reply**: ${words}`);
    }
  });

  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, \"skip plan approval for this work\" lowers it at once", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "skip plan approval for this work");
    expect(offRows(proj)).toBeGreaterThan(0);
    const after = next(proj);
    expect(after.kind === "ask" && after.ask_type === "plan-approval", JSON.stringify(after)).toBe(false);
  });

  // From a live run: the chat opened with `/aidlc`, the plan question came,
  // and "skip plan approval?" turned the check off, because the opening
  // command still read as a request. The person's latest word was a question.
  test("after the chat's opening /aidlc, \"skip plan approval?\" still lowers nothing", () => {
    const proj = project("off");
    reply(proj, "/aidlc");
    askFor(proj);
    reply(proj, "skip plan approval?");
    const refused = setter(proj);
    expect(refused.code, refused.out).not.toBe(0);
    expect(refused.out).toContain("asked a question about this check");
    expect(offRows(proj)).toBe(0);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("after the chat's opening /aidlc, a request to skip plan approval is still done at once", () => {
    const proj = project("off");
    reply(proj, "/aidlc");
    askFor(proj);
    reply(proj, "skip plan approval for this work");
    expect(offRows(proj)).toBeGreaterThan(0);
  });
});

// The lockout reported in #1172: a Brownfield refactor (or bugfix) workflow
// skips units-generation, so Code Generation is one zero-Unit, stage-level
// target. The person approved the plan; the rules then arrived in parts, and
// the build never started: the next part was refused, a fresh `next` started
// the parts over, and every worker handoff and source edit was refused while
// the step was a rules part. Parking to stop for the day was a trap of its
// own: the refusal named `next`, `next` named the unpark, and the unpark was
// refused. These cases drive that sequence end to end with the real engine,
// the real human-turn hook, and the real plan-approval guard.
function zeroUnitProject(scope: "refactor" | "bugfix"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  let state = readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope bugfix)",
      `- **Guard Policy**: off (from scope ${scope})\n- **Plan Approval**: on (from scope ${scope})`)
    .replace("- [-] requirements-analysis \u2014 EXECUTE", "- [x] requirements-analysis \u2014 EXECUTE")
    .replace("- [ ] code-generation \u2014 EXECUTE", "- [-] code-generation \u2014 EXECUTE")
    .replace("- **Lifecycle Phase**: INCEPTION", "- **Lifecycle Phase**: CONSTRUCTION")
    .replace("- **Current Stage**: requirements-analysis", "- **Current Stage**: code-generation")
    .replace("- **Next Stage**: code-generation", "- **Next Stage**: build-and-test");
  if (scope === "refactor") {
    state = state
      .replace("- **Scope**: bugfix", "- **Scope**: refactor")
      .replace("- [S] functional-design \u2014 SKIP (bugfix scope)", "- [x] functional-design \u2014 EXECUTE")
      .replaceAll("SKIP (bugfix scope)", "SKIP (refactor scope)");
  }
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
  return withRulesInParts(proj);
}

function activeMarker(proj: string): { kind?: string; stage?: string; unit?: string } {
  return JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json"), "utf-8"));
}

/** Each rules part's own `continue`, run once, to the directive after the last part. */
function continueEachPart(proj: string, first: Emitted & { part?: number; receipt?: string }): Emitted {
  let directive = first;
  let parts = 0;
  while (directive.kind === "load-steering") {
    expect(directive.stage).toBe("code-generation");
    expect(directive.part).toBe(++parts);
    directive = engineCall(proj, ["continue", String(directive.receipt)]);
  }
  expect(parts).toBeGreaterThan(1);
  return directive;
}

/** The person approves, the rules arrive in parts, and the build step arrives. */
function approveThroughParts(proj: string, scope: string): Emitted {
  writePlan(proj);
  const ask = next(proj);
  expect(ask.kind, JSON.stringify(ask)).toBe("ask");
  expect(ask.ask_type).toBe("plan-approval");
  expect(ask.plan_approval.targets?.map((target) => target.unit)).toEqual([null]);
  // The person picks Approve Plan, the first choice.
  reply(proj, "1");
  expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
  // The conductor re-enters naming the work's own scope, as reported. (New words
  // here would be new work, which the engine asks the person about.)
  const first = engineCall(proj, ["next", "--scope", scope]);
  expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
  // While a part is the step, the refusal names that part's own `continue`.
  const early = guardWrite(proj, join(proj, "src", "slugify.ts"));
  expect(early.code).toBe(2);
  expect(early.stderr).toContain(`continue ${first.receipt}\``);
  expect(early.stderr).not.toContain("cannot select one approval target");
  const build = continueEachPart(proj, first);
  expect(build.kind, JSON.stringify(build)).toBe("run-stage");
  expect(build.stage).toBe("code-generation");
  expect(build.plan_approval).toEqual({ status: "approved" });
  expect(activeMarker(proj)).toMatchObject({ kind: "run-stage", stage: "code-generation" });
  expect(activeMarker(proj).unit).toBeUndefined();
  return build;
}

/** The developer handoff with the markers the reporter used, and nothing else. */
function stageLevelHandoff(proj: string): { code: number; stderr: string } {
  const approval = evaluateCodeGenerationApproval(proj, { unit: null });
  expect(approval.ok, approval.reason).toBe(true);
  return guardDispatch(proj, `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: ${approval.contractHash}\n`);
}

describe("the zero-Unit Code Generation lockout reported in #1172", () => {
  for (const scope of ["refactor", "bugfix"] as const) {
    test(`one approval builds the stage-level plan: the parts, the handoff, and the source edits go through (${scope})`, () => {
      const proj = zeroUnitProject(scope);
      approveThroughParts(proj, scope);
      const handoff = stageLevelHandoff(proj);
      expect(handoff.code, handoff.stderr).toBe(0);
      expect(generationStarted(proj)).toBe(true);
      const edit = guardWrite(proj, join(proj, "src", "slugify.ts"));
      expect(edit.code, edit.stderr).toBe(0);
      // The approval was asked for once and still stands.
      expect(questions(proj)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
      expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
      expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
    });
  }

  // Before approval the planning rules can come in parts too: each part's
  // refusal names its own `continue`, the planning step lets the plan be
  // written, and the engine opens the question.
  test("before approval, the planning rules arrive in parts, the plan is written, and the question opens", () => {
    const proj = zeroUnitProject("refactor");
    const first = engineCall(proj, ["next"]);
    expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
    const early = guardWrite(proj, join(stageDir(proj), "code-generation-plan.md"));
    expect(early.code).toBe(2);
    expect(early.stderr).toContain(`continue ${first.receipt}\``);
    const planning = continueEachPart(proj, first);
    expect(planning.kind, JSON.stringify(planning)).toBe("run-stage");
    expect(planning.plan_approval).toEqual({ status: "plan" });
    for (const file of ["code-generation-plan.md", "unit-test-instructions.md"]) {
      const write = guardWrite(proj, join(stageDir(proj), file));
      expect(write.code, write.stderr).toBe(0);
    }
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  for (const when of ["while the rules arrive", "during the build"] as const) {
    test(`stopping for the day ${when}: the way back the refusal names gets through, and the plan is built with no new question`, () => {
      const proj = zeroUnitProject("refactor");
      if (when === "during the build") {
        approveThroughParts(proj, "refactor");
        expect(stageLevelHandoff(proj).code).toBe(0);
      } else {
        writePlan(proj);
        expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
        reply(proj, "1");
        expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
      }
      const park = "bun .claude/tools/aidlc.ts engine orchestrate park";
      const parkAdmitted = guardBash(proj, park);
      expect(parkAdmitted.code, parkAdmitted.stderr).toBe(0);
      expect(JSON.parse(runInstalled(proj, park)).kind).toBe("parked");
      // Parked, a workspace command is refused; the refusal names `next`, and
      // `next --resume` names the unpark, which the guard lets through.
      const parked = guardBash(proj, "git add -A");
      expect(parked.code).toBe(2);
      expect(parked.stderr).toContain(" next`");
      const unpark = resumeNamesUnpark(proj);
      const unparkAdmitted = guardBash(proj, unpark);
      expect(unparkAdmitted.code, unparkAdmitted.stderr).toBe(0);
      runInstalled(proj, unpark);
      const first = engineCall(proj, ["next", "--resume"]);
      expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
      const build = continueEachPart(proj, first);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
      const handoff = stageLevelHandoff(proj);
      expect(handoff.code, handoff.stderr).toBe(0);
      expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(0);
      expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
    });
  }

  // A merge that rewrote the state file left a Code Generation rules part as
  // the last thing published while the state went back to Functional Design.
  test("a rules part left over from before the state moved back holds nothing: the current stage runs", () => {
    const proj = zeroUnitProject("refactor");
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "1");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8")
      .replace("- [x] functional-design \u2014 EXECUTE", "- [-] functional-design \u2014 EXECUTE")
      .replace("- [-] code-generation \u2014 EXECUTE", "- [ ] code-generation \u2014 EXECUTE")
      .replace("- **Current Stage**: code-generation", "- **Current Stage**: functional-design"), "utf-8");
    expect(activeMarker(proj)).toMatchObject({ kind: "load-steering", stage: "code-generation" });
    const edit = guardWrite(proj, join(proj, "src", "slugify.ts"));
    expect(edit.code, edit.stderr).toBe(0);
    const current = nextThroughParts(proj).directive;
    expect(current.kind, JSON.stringify(current)).toBe("run-stage");
    expect(current.stage).toBe("functional-design");
  });
});
