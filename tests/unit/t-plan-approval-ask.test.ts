// covers: function:routeCodeGenerationPlanApproval, function:publishPlanApprovalAsk, function:notePlanApprovalAskReply, function:recordPlanApprovalAnswer, function:requestPlanApprovalReviewNow, function:codeGenerationPlanReadiness, function:planSummaryLines,
// function:PLAN_APPROVAL_ASK_TYPE, function:planApprovalRuntimeFile, function:readPlanApprovalRuntimeRecord,
// function:writePlanApprovalRuntimeRecord, function:removePlanApprovalRuntimeRecord, function:releaseTakenGuardRecoveryReply, function:runStateContent,
// function:keepPlanApprovalAskOverStateWrite, function:planNote, function:preparePlanRecordFolders, function:parkedWhereItStands
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
//   - when the chat compacts, a guard-recovery question comes up, the work is
//     paused, or the person asks to build the Units one at a time after the
//     approval, the approved plan is built and not asked
//     about again, and editing, changes, review, a rejected gate, a new
//     attempt, and another Unit still ask; "review the plan first" said then
//     asks again; an answer typed after the chat compacts still counts;
//   - stopping for now: the park and the unpark the engine names get through
//     the guard, and coming back builds an approved plan or asks about the
//     same plan again; while the work is parked, the person's other work in
//     the project goes on and the files the plan names and its developer wait.
//   - the zero-Unit lockout reported in #1172 (refactor and bugfix, Brownfield,
//     rules in parts): one approval reaches the build, each refusal while a
//     part is the step names that part's `continue`, the stage-level handoff
//     and source edits go through, parking and coming back reach the build
//     with no new question, and a rules part left behind by a state that moved
//     back holds nothing.
//   - an isolated Code Generation run with the workflow at another stage: its
//     plan step, plan question and revision name that run's own `next`, which
//     brings back that run's step; the workflow's own steps keep the bare `next`.
//   - the step that writes a plan (stage-level, a Unit's, a parallel batch's)
//     makes each plan's record folder first, so a file tool that makes no
//     folders writes the plan; a route check makes nothing.
//   - an isolated Code Generation run in a project with no work: its plan
//     question is asked and answered as inside work, PLAN_APPROVAL_RECORDED
//     lands beside the run's start, and Approve Plan builds and the run
//     finishes; Request Changes, editing the files and "review the plan" go as
//     inside work.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  cleanupWorktreeFixture,
  createOrchestrationTestProject,
  DEFAULT_RECORD_DIR,
  FIXTURES_DIR,
  intentsDirOf,
  removeWorkspaceRecord,
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
  readActiveDirectiveMarker,
  findStageBySlug,
  artifactFilename,
  auditBlockField,
  readAuditShardEvents,
  reviewArtifactFingerprint,
  unitCompletedReceipts,
  readProtectedResponse,
  stateDigest,
  workspaceSourceFingerprint,
  workspaceSourceListing,
  writeActiveDirectiveMarker,
  personsWordsText,
  writeBaselineSourceSnapshot,
  writeSessionPidEntry,
  hooksHealthDir,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { listMessages, saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { FILE_TOOLS_RULE } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const SESSION = "01995000-7a11-7000-8000-000000000001";
const OTHER_SESSION = "01995000-7a11-7000-8000-000000000002";

interface Emitted {
  kind: string;
  ask_type?: string;
  stage?: string;
  mode?: string;
  narration?: string;
  question?: string;
  message?: string;
  response_route?: string;
  plan_note?: string;
  question_note?: string;
  plan_approval: {
    next?: string;
    status?: string;
    feedback?: string;
    note?: string;
    notice?: string;
    skipped?: boolean;
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

function writePlan(proj: string, extra = "", unit: string | null = null, touches = "src/slugify.ts"): void {
  mkdirSync(stageDir(proj, unit), { recursive: true });
  writeFileSync(
    join(stageDir(proj, unit), "code-generation-plan.md"),
    `# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: ${touches}\n` +
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

// The id of the message the hook kept for the latest turn (its HUMAN_TURN
// row's Message Id): what a setter names for the person's request.
function turnId(proj: string): string {
  const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1);
  const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
  expect(id).not.toBeNull();
  return id as string;
}

function answer(
  proj: string,
  details: string,
  extra: string[] = [],
  chat?: string,
): { code: number; recorded?: string; message: string } {
  const result = spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--details", details, ...extra, "--project-dir", proj,
  ], {
    cwd: proj,
    env: {
      ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
      ...(chat ? { AIDLC_SESSION_OVERRIDE: chat } : {}),
    },
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

// The person's reply at the plan question, and the agent's record of the
// choice it read from it: the hook records nothing from typed words.
function replyAndRecord(proj: string, typed: string, choice: string, session = SESSION): void {
  reply(proj, typed, session);
  const recorded = answer(proj, choice, [], session === SESSION ? undefined : session);
  expect(recorded.code, recorded.message).toBe(0);
}

function lower(proj: string, key: string, value: string): { code: number; out: string } {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", key, value, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
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
  expect(command).toMatch(/^bun \.claude\/tools\/[\w.-]+\.ts( [\w-]+)+( --reason '[^']*')?$/);
  // The engine's own reason for the person's skip is one quoted argument.
  const reason = /--reason '([^']*)'$/.exec(command)?.[1];
  const [, ...args] = command.replace(/ --reason '[^']*'$/, "").split(" ");
  if (reason !== undefined) args.push("--reason", reason);
  const result = spawnSync(BUN, args, {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, `${command}\n${result.stderr}`).toBe(0);
  return result.stdout ?? "";
}

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

  // The question says what already changed in the workspace since Code
  // Generation started (an agent that ran ahead of the plan, or the person's
  // own edits), so they approve with that in front of them. No refusal, no
  // new question: one line under the summary, in the chat and in the record.
  test("the plan question names source that already changed before approval", () => {
    const proj = project();
    const baseline = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, proj);
    // Writing the plan changes no source: the summary is the plan's alone.
    const asked = askFor(proj);
    expect(asked.plan_approval.targets?.[0].summary).toEqual([
      "Builds: slugify for titles", "Touches: src/slugify.ts", "Tests: 3 unit tests",
    ]);
    expect(questions(proj)).not.toContain("Already changed before you approved");
    writeFileSync(join(proj, "src", "extra.ts"), "export const extra = 1;\n", "utf-8");
    const one = next(proj);
    expect(one.kind, JSON.stringify(one)).toBe("ask");
    expect(one.plan_approval.targets?.[0].summary.at(-1)).toBe("Already changed before you approved: src/extra.ts.");
    expect(questions(proj)).toContain("- Already changed before you approved: src/extra.ts.");
    writeFileSync(join(proj, "src", "more.ts"), "export const more = 1;\n", "utf-8");
    expect(next(proj).plan_approval.targets?.[0].summary.at(-1))
      .toBe("Already changed before you approved (2 files): src/extra.ts, src/more.ts.");
  });

  // An AI-DLC update while the plan waits rewrites AI-DLC's own files (Codex's
  // skill under .agents/skills/): nothing ran ahead of the plan, so the
  // question names only the person's source.
  test("the plan question never names AI-DLC's own files an update changed", () => {
    const proj = project();
    const skill = join(proj, ".agents", "skills", "aidlc", "SKILL.md");
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, "AI-DLC 1\n", "utf-8");
    const baseline = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, proj);
    askFor(proj);
    writeFileSync(skill, "AI-DLC 2\n", "utf-8");
    const updated = next(proj);
    expect(updated.kind, JSON.stringify(updated)).toBe("ask");
    expect((updated.plan_approval.targets ?? [])[0].summary.some((line) => line.startsWith("Already changed"))).toBe(false);
    writeFileSync(join(proj, "src", "extra.ts"), "export const extra = 1;\n", "utf-8");
    expect(next(proj).plan_approval.targets?.[0].summary.at(-1)).toBe("Already changed before you approved: src/extra.ts.");
  });

  // The line measures from the stage's start or from the previous plan approval,
  // whichever is later, and leaves out what the plans approved since then name:
  // an earlier Unit's approved build is not something that ran ahead.
  test("a later Unit's question names nothing from an earlier Unit's approved build, and still names a stray file", () => {
    const proj = unitProject("unit-b", "unit-a");
    const baseline = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, proj);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, proj);
    writePlan(proj, "", "unit-b");
    writePlan(proj, "", "unit-a");
    const first = next(proj);
    expect(first.kind, JSON.stringify(first)).toBe("ask");
    expect((first.plan_approval.targets ?? []).map((target) => target.unit)).toEqual(["unit-b"]);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj).kind).toBe("run-stage");
    // unit-b's approved build writes the file its plan names (Touches: src/slugify.ts).
    writeFileSync(join(proj, "src", "slugify.ts"), "export const slugify = (s: string) => s;\n", "utf-8");
    const route = () => routeCodeGenerationPlanApproval(proj, {
      kind: "run-stage", stage: "code-generation", unit: "unit-a",
    } as Parameters<typeof routeCodeGenerationPlanApproval>[1]) as unknown as Emitted;
    const quiet = route();
    expect(quiet.kind, JSON.stringify(quiet)).toBe("ask");
    expect((quiet.plan_approval.targets ?? [])[0].summary.some((line) => line.startsWith("Already changed"))).toBe(false);
    writeFileSync(join(proj, "src", "stray.ts"), "export const stray = 1;\n", "utf-8");
    expect(route().plan_approval.targets?.[0].summary.at(-1)).toBe("Already changed before you approved: src/stray.ts.");
  });

  test("in a unit-major run the first question does not name what changed in earlier stages", () => {
    const proj = unitProject("unit-a");
    const statePath = seededStateFile(proj);
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace("- **Guard Policy**: relaxed (set by you)", "- **Guard Policy**: relaxed (set by you)\n- **Construction Iteration**: unit-major"), "utf-8");
    const atWorkflowStart = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": atWorkflowStart }, proj);
    // A change made during Inception, before Code Generation started.
    writeFileSync(join(proj, "src", "inception.ts"), "export const fromInception = 1;\n", "utf-8");
    const atStageStart = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": atStageStart }, proj);
    writePlan(proj, "", "unit-a");
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect((ask.plan_approval.targets ?? [])[0].summary.some((line) => line.startsWith("Already changed"))).toBe(false);
    writeFileSync(join(proj, "src", "stray.ts"), "export const stray = 1;\n", "utf-8");
    expect(next(proj).plan_approval.targets?.[0].summary.at(-1)).toBe("Already changed before you approved: src/stray.ts.");
  });

  // The status line switch is a display setting (#1407): typed while the plan
  // question is open, the chat route names the config command and ends the
  // turn, the guard lets that command through, and the plan question is still
  // the one waiting afterwards.
  test("/aidlc --statusline off while the plan waits ends the turn, passes the guard, and leaves the plan question open", () => {
    const proj = project();
    // The project's own installed tools, as the copy channel has them.
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    askFor(proj);
    const switched = next(proj, ["--statusline", "off"]);
    expect(switched.kind, JSON.stringify(switched)).toBe("print");
    const command = /^Run `([^`]+)`, print its output verbatim, then stop\./.exec(switched.message ?? "")?.[1];
    expect(command, switched.message).toBe("bun .claude/tools/aidlc.ts config --statusline off --harness claude");
    expect(switched.message).toContain("do NOT run `next`");
    const guarded = guardBash(proj, command as string);
    expect(guarded.code, guarded.stderr).toBe(0);
    expect(runInstalled(proj, command as string)).toContain("--statusline on brings");
    const still = next(proj);
    expect(still.kind, JSON.stringify(still)).toBe("ask");
    expect(still.ask_type).toBe("plan-approval");
  });

  // `/aidlc --config models` typed while the plan question is open: the chat
  // route ends the turn, the guard lets its read and the change the person
  // picked through, both run, and the plan question is still the one waiting.
  test("/aidlc --config models while the plan waits reads and lands the change, and leaves the plan question open", () => {
    const proj = project();
    // The project's own installed tools, as the copy channel has them.
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    askFor(proj);
    const configure = next(proj, ["--config", "models"]);
    expect(configure.kind, JSON.stringify(configure)).toBe("print");
    expect(configure.message).toContain("do NOT run `next`");
    const show = /Read current state first with `([^`]+)`/.exec(configure.message ?? "")?.[1];
    expect(show, configure.message).toBe("bun .claude/tools/aidlc.ts config models --show --json");
    const land = "bun .claude/tools/aidlc.ts config models --preset thorough --local --yes";
    for (const command of [show as string, land]) {
      const guarded = guardBash(proj, command);
      expect(guarded.code, `${command}\n${guarded.stderr}`).toBe(0);
      runInstalled(proj, command);
    }
    expect(readFileSync(join(proj, "aidlc.settings.local.json"), "utf-8")).toContain('"thorough"');
    const still = next(proj);
    expect(still.kind, JSON.stringify(still)).toBe("ask");
    expect(still.ask_type).toBe("plan-approval");
  });

  test("--status while the code plan question is open says it waits for the person's approval, naming the Unit", () => {
    const statusLine = (proj: string): string => {
      const result = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "status", "--project-dir", proj], {
        encoding: "utf-8",
        env: { ...process.env, AIDLC_UNATTENDED: "0" },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      return /^Status:\s+(.*)$/m.exec(result.stdout ?? "")?.[1] ?? "";
    };
    const proj = project();
    next(proj);
    askFor(proj);
    expect(statusLine(proj)).toBe("Awaiting your approval on the code plan");
    // They chose to edit the files themselves: the work waits on their edit.
    replyAndRecord(proj, "/aidlc 3", "I'll edit the files");
    expect(next(proj).plan_approval?.editing).toBe(true);
    expect(statusLine(proj)).toBe("Waiting for you to finish editing the code plan");
    const units = unitProject("unit-b", "unit-a");
    writePlan(units, "", "unit-b");
    writePlan(units, "", "unit-a");
    expect(next(units).ask_type).toBe("plan-approval");
    expect(statusLine(units)).toBe("Awaiting your approval on the code plan for unit-b");
  });

  test("--status for a named piece of work reads that work's code plan question", () => {
    const statusLine = (proj: string, target: string[]): string => {
      const result = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "status", ...target, "--project-dir", proj], {
        encoding: "utf-8",
        env: { ...process.env, AIDLC_UNATTENDED: "0" },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      return /^Status:\s+(.*)$/m.exec(result.stdout ?? "")?.[1] ?? "";
    };
    const proj = project();
    next(proj);
    askFor(proj);
    // Other work here, not selected and with no plan question of its own.
    const other = "fixture-other-0000000000000002";
    const intents = intentsDirOf(proj);
    mkdirSync(join(intents, other), { recursive: true });
    writeFileSync(join(intents, other, "aidlc-state.md"), readFileSync(seededStateFile(proj), "utf-8")
      .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: requirements-analysis"), "utf-8");
    const registry = JSON.parse(readFileSync(join(intents, "intents.json"), "utf-8"));
    registry.push({ uuid: "00000000-0000-7000-8000-000000000002", slug: "fixture-other", dirName: other, status: "in-flight" });
    writeFileSync(join(intents, "intents.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
    expect(statusLine(proj, ["--intent", DEFAULT_RECORD_DIR])).toBe("Awaiting your approval on the code plan");
    expect(statusLine(proj, ["--space", "default"])).toBe("Awaiting your approval on the code plan");
    expect(statusLine(proj, ["--intent", other])).not.toContain("code plan");
    replyAndRecord(proj, "/aidlc 3", "I'll edit the files");
    expect(next(proj).plan_approval?.editing).toBe(true);
    expect(statusLine(proj, ["--intent", DEFAULT_RECORD_DIR])).toBe("Waiting for you to finish editing the code plan");
    expect(statusLine(proj, ["--intent", other])).not.toContain("code plan");
  });

  test("a stage without a plan is planned first; a ready plan is asked for with its summary", () => {
    const proj = project();
    const planning = next(proj);
    expect(planning.kind).toBe("run-stage");
    expect(planning.stage).toBe("code-generation");
    expect(planning.plan_approval).toEqual({ status: "plan" });
    // The conductor writes the plan itself: the step says so (a Kiro run read the
    // stage's dispatched mode and handed the plan to the developer, which the
    // guard refused), and the person hears who does what.
    expect(planning.mode).toBe("inline");
    // The record's cursor is past User Stories to Infrastructure Design, never
    // started, so the count leaves them out, as a plan switch's line does.
    expect(planning.narration).toBe("Writing the code plan for Code Generation (stage 11 of 20) first; the developer builds from it.");

    const ask = askFor(proj);
    expect(ask.question).toBe("Approve the code plan?");
    expect(ask.response_route).toBe("next");
    expect(ask.plan_approval.choices).toEqual(["Approve Plan", "Request Changes", "I'll edit the files"]);
    expect(ask.plan_approval.editing).toBe(false);
    const [target] = ask.plan_approval.targets ?? [];
    expect(target.unit).toBeNull();
    expect(target.plan_path).toEndWith("construction/code-generation/code-generation-plan.md");
    expect(target.summary).toEqual(["Builds: slugify for titles", "Touches: src/slugify.ts", "Tests: 3 unit tests"]);
    expect(questions(proj)).toContain("## Plan Approval");
    expect(questions(proj)).toMatch(/^\[Approval Fingerprint\]: sha256:v3:[0-9a-f]{64}$/m);
    expect(questions(proj)).toMatch(/^\[Answer\]:$/m);
    // While the question is open, nothing is built. The plan file is AI-DLC's
    // record: a write to it passes, and a plan changed under the question is
    // asked about again by `next`. The code the plan names waits.
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-plan.md")).code).toBe(0);
    const blocked = guardWrite(proj, join(proj, "src", "slugify.ts"));
    expect(blocked.code).toBe(2);
    // Only the person's sentence: some hosts show a hook's refusal as written.
    // The agent's steps for it live in the skill's refusal clause.
    expect(blocked.stderr.trim()).toBe("Nothing is built or changed while the plan waits for your approval.");
    // A person's answer text for `log answer --details-file` is written in the
    // record's own answer-text folder, so no shell reads it; that alone passes.
    const answerText = join(seededRecordDir(proj), ".aidlc-engine", "answer-text");
    expect(guardWrite(proj, join(answerText, "answer.txt")).code).toBe(0);
    expect(guardWrite(proj, join(seededRecordDir(proj), ".aidlc-engine", "answer.txt")).code).toBe(2);
    // So are a stage's learnings picks for `learnings persist` (#1592): the
    // ritual runs while Code Generation is the current stage, so its file
    // must be writable while the plan waits.
    const learnings = join(seededRecordDir(proj), ".aidlc-engine", "learnings");
    expect(guardWrite(proj, join(learnings, "code-generation-selections.json")).code).toBe(0);
    // A traversal out of it lands on the plan file: AI-DLC's record, which
    // passes on its own (a plan changed under the question is asked about again).
    expect(guardWrite(proj, join(answerText, "..", "..", "construction", "code-generation", "code-generation-plan.md")).code)
      .toBe(0);
    // So does a person's request for `next --request-file`, directly inside the
    // project's request-text folder, the only place the engine reads it.
    const requestText = join(proj, "aidlc", ".aidlc-request-text");
    expect(guardWrite(proj, join(requestText, "request.txt")).code).toBe(0);
    expect(guardWrite(proj, join(requestText, "nested", "request.txt")).code).toBe(2);
    expect(guardWrite(proj, join(requestText, "..", "aidlc-state.md")).code).toBe(2);
  });

  // Only the build waits for the plan (K6c): a write to a file the waiting plan
  // does not name goes through, whatever its type, under every Guard Policy;
  // the files it names (its summary and its test command) wait. Once the
  // person's approval is on record, a side write made with `next` goes through.
  for (const policy of ["strict", "off"] as const) {
    test(`while the plan waits, a file it does not name can be written and its own files wait (${policy})`, () => {
      const proj = project(policy);
      askFor(proj);
      for (const path of [join(proj, "scratch", "notify.txt"), join(proj, "src", "base.ts"), join(proj, "README.md")]) {
        const result = guardWrite(proj, path);
        expect(result.code, `${path}\n${result.stderr}`).toBe(0);
      }
      expect(guardBash(proj, "echo 'approval needed' >> scratch/notify.txt").code).toBe(0);
      for (const path of [join(proj, "src", "slugify.ts"), join(proj, "src", "slugify.test.ts")]) {
        const blocked = guardWrite(proj, path);
        expect(blocked.code, path).toBe(2);
        expect(blocked.stderr.trim()).toBe("Nothing is built or changed while the plan waits for your approval.");
      }
      // The questions file is AI-DLC's record: an answer written there has no
      // receipt, so the write passes and approves nothing.
      expect(guardWrite(proj, join(stageDir(proj), "code-generation-questions.md")).code).toBe(0);
      expect(guardBash(proj, "echo 'export const s = 1;' > src/slugify.ts").code).toBe(2);
      reply(proj, "approve the plan, and write approval needed to scratch/notify.txt next time");
      expect(answer(proj, "Approve Plan").code).toBe(0);
      const side = guardWrite(proj, join(proj, "scratch", "notify.txt"));
      expect(side.code, side.stderr).toBe(0);
    });
  }

  // In a workspace whose repo folder has a space, the plan's files in that repo
  // are its build as they are in any other repo: they wait, and a file the
  // plan does not name goes through.
  test("while the plan waits, its files in a repo named with a space wait, as in any repo", () => {
    const proj = project("strict");
    const registry = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
    const rows = JSON.parse(readFileSync(registry, "utf-8"));
    rows[0].repos = ["api", "my lib"];
    writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
    for (const repo of ["api", "my lib"]) {
      mkdirSync(join(proj, repo, "src"), { recursive: true });
      writeFileSync(join(proj, repo, "src", "greet.py"), "def greet(name):\n    return name\n");
      for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]]) {
        expect(spawnSync("git", args, { cwd: join(proj, repo), encoding: "utf-8" }).status).toBe(0);
      }
    }
    writePlan(proj, "- [ ] Step 2: change `my lib/src/greet.py` and api/src/greet.py\n");
    const directive = next(proj);
    expect(directive.ask_type, JSON.stringify(directive)).toBe("plan-approval");
    for (const path of [join(proj, "my lib", "src", "greet.py"), join(proj, "api", "src", "greet.py")]) {
      expect(guardWrite(proj, path).code, path).toBe(2);
    }
    for (const path of [join(proj, "my lib", "notes.md"), join(proj, "api", "notes.md")]) {
      const result = guardWrite(proj, path);
      expect(result.code, `${path}\n${result.stderr}`).toBe(0);
    }
  });

  // A repo whose name ends another's after a space ("lib" beside "my lib") is
  // its own: the plan's "my lib/src/greet.py" names nothing in "lib", so a file
  // there the person asks to change goes through while the plan waits.
  test("while the plan waits, a file in \"lib\" beside \"my lib\" is not the plan's own", () => {
    const proj = project("strict");
    const registry = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
    const rows = JSON.parse(readFileSync(registry, "utf-8"));
    rows[0].repos = ["lib", "my lib"];
    writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
    for (const repo of ["lib", "my lib"]) {
      mkdirSync(join(proj, repo, "src"), { recursive: true });
      writeFileSync(join(proj, repo, "src", "greet.py"), "def greet(name):\n    return name\n");
      for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]]) {
        expect(spawnSync("git", args, { cwd: join(proj, repo), encoding: "utf-8" }).status).toBe(0);
      }
    }
    writePlan(proj, "- [ ] Step 2: change `my lib/src/greet.py`\n");
    const directive = next(proj);
    expect(directive.ask_type, JSON.stringify(directive)).toBe("plan-approval");
    expect(guardWrite(proj, join(proj, "my lib", "src", "greet.py")).code).toBe(2);
    const other = guardWrite(proj, join(proj, "lib", "src", "greet.py"));
    expect(other.code, other.stderr).toBe(0);
  });

  // K6c on Kiro IDE: the plan is written and the agent writes the person's
  // standing notify line in the same batch as the `next` that asks the plan
  // question, so the write is judged while the plan step is still current.
  // That window holds only the build too: a file the plan on disk does not
  // name goes through; before any plan is written, only a document does.
  for (const policy of ["strict", "off"] as const) {
    test(`before the plan question is asked, a file the plan does not name can be written (${policy})`, () => {
      const proj = project(policy);
      expect(next(proj).plan_approval.status).toBe("plan");
      expect(guardWrite(proj, join(proj, "scratch", "notify.txt")).code).toBe(0);
      expect(guardWrite(proj, join(proj, "src", "other.ts")).code).toBe(2);
      writePlan(proj);
      for (const path of [join(proj, "scratch", "notify.txt"), join(proj, "src", "base.ts")]) {
        const result = guardWrite(proj, path);
        expect(result.code, `${path}\n${result.stderr}`).toBe(0);
      }
      expect(guardBash(proj, "echo 'approval needed' >> scratch/notify.txt").code).toBe(0);
      for (const path of [join(proj, "src", "slugify.ts"), join(proj, "src", "slugify.test.ts")]) {
        expect(guardWrite(proj, path).code, path).toBe(2);
      }
      expect(guardBash(proj, "echo 'export const s = 1;' > src/slugify.ts").code).toBe(2);
    });
  }

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
    expect(next(proj).ask_type).toBe("plan-approval");
  });

  test("the agent records the approval it read from their words, and the next `next` builds", () => {
    const proj = project();
    askFor(proj);
    // The hook names the kept message for the agent and reads nothing into it.
    const said = reply(proj, "yes");
    expect(said).toContain("--message");
    expect(said).not.toMatch(/Approve|yes/);
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
    expect(build.mode).toBe("subagent");
    expect(build.narration).toMatch(/^Generating code for \d+ plan steps?\b/);
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
    // The plan file is AI-DLC's record: it can be written before they reply (a
    // changed plan is asked about again) and after their reply for what they asked.
    expect(guardWrite(proj, plan).code).toBe(0);
    reply(proj, "approve, but rename slugify to toSlug");
    expect(guardWrite(proj, plan).code).toBe(0);
    expect(guardWrite(proj, join(stageDir(proj), "unit-test-instructions.md")).code).toBe(0);
    // The questions file is AI-DLC's record too: it passes; the code still waits.
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-questions.md")).code).toBe(0);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    writePlan(proj, "- [ ] Step 2: rename slugify to toSlug\n");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.message).toContain("changed since it was shown");
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

  test("a typed pick records nothing at the hook; the agent's record approves, and recording it again is fine", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "1");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(answer(proj, "Approve Plan").message).toContain("already recorded");
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

  test("a pick typed after /aidlc is the agent's to read: next hands it the record step, and its record leads to the build", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "/aidlc 1");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    const read = next(proj, ["1"]);
    expect(read.kind, JSON.stringify(read)).toBe("print");
    expect(read.message).toContain("--checkpoint plan-approval");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // The person's latest pick stands: a Request Changes after an exact approval
  // is never reported as recorded while the approval builds.
  test("a later Request Changes after a recorded approval names the step that brings the plan back", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "/aidlc 1", "Approve Plan");
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    reply(proj, "/aidlc Request Changes");
    const read = next(proj, ["Request", "Changes"]);
    expect(read.kind, JSON.stringify(read)).toBe("print");
    expect(read.message).not.toContain("it is recorded");
    expect(read.message).toContain('"Review the plan" brings the question back');
    const reviewed = answer(proj, "Review the plan");
    expect(reviewed.code, reviewed.message).toBe(0);
    const again = next(proj);
    expect(again.kind, JSON.stringify(again)).toBe("ask");
    expect(again.ask_type).toBe("plan-approval");
  });

  // "I'll edit the files" after an answer is their latest word too: the
  // question waits in edit mode, with nothing built, until they say done.
  test("I'll edit the files after a recorded approval opens edit mode before anything is built", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "/aidlc 1", "Approve Plan");
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    reply(proj, "/aidlc 3");
    const read = next(proj, ["3"]);
    expect(read.kind, JSON.stringify(read)).toBe("print");
    expect(read.message).toContain("--checkpoint plan-approval");
    const edit = answer(proj, "I'll edit the files");
    expect(edit.code, edit.message).toBe(0);
    const again = next(proj);
    expect(again.kind, JSON.stringify(again)).toBe("ask");
    expect(again.ask_type).toBe("plan-approval");
    expect(again.plan_approval?.editing).toBe(true);
  });

  test("I'll edit the files with no reply after the recorded answer changes nothing", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "/aidlc 1", "Approve Plan");
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    const early = answer(proj, "I'll edit the files");
    expect(early.code).not.toBe(0);
    expect(early.message).toContain("they have not replied since");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("I'll edit the files after Request Changes opens edit mode", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "/aidlc 2", "Request Changes");
    replyAndRecord(proj, "/aidlc 3", "I'll edit the files");
    const again = next(proj);
    expect(again.kind, JSON.stringify(again)).toBe("ask");
    expect(again.plan_approval?.editing).toBe(true);
  });

  // Both halves of one message are done by the agent, which reads the line:
  // the hook keeps it as a reply, the setter lands the switch on this work,
  // and the choice typed after the flag answers the plan question.
  test("a switch typed before a plan choice: the agent lowers this work and records the choice from the one reply", () => {
    const proj = project("strict");
    askFor(proj);
    const before = readFileSync(seededStateFile(proj), "utf-8");
    reply(proj, "/aidlc --guard-policy relaxed Approve Plan");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
    const lowered = lower(proj, "guard-policy", "relaxed");
    expect(lowered.code, lowered.out).toBe(0);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("- **Guard Policy**: relaxed (set by you)");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // "Approve it, and turn the sensors off": the setting rides the answer, or
  // goes first, or follows it while that reply is in hand
  // (t-setting-rides-approval). Once the person has said more, the message that
  // gave the approval stands for no setting (t-setting-spent-message).
  test("an approval and a setting in one reply: riding the answer, the setting is theirs; once they say more, refused", () => {
    const proj = project();
    askFor(proj);
    const words = "approve it, and turn the sensors off";
    reply(proj, words);
    const id = turnId(proj);
    // The approval row lands in a later second than their reply.
    Bun.sleepSync(1100);
    const approved = answer(proj, "Approve Plan", ["--sensors", "off"]);
    expect(approved.code, approved.message).toBe(0);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("- **Sensors**: off (set by you)");
    reply(proj, "thanks");
    const set = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", "sensors", "on", "--message", id, "--project-dir", proj], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(set.status).not.toBe(0);
    expect(`${set.stdout}${set.stderr}`).not.toContain(id);
  });

  // The other order: the setter naming their message runs first, as the plan
  // question's own step says for a setting beside the answer. The setting takes
  // nothing of the reply away, so the approval in it still records.
  test("an approval and a setting in one reply: the setting run first, the approval still records", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "approve it, and turn the sensors off");
    const id = turnId(proj);
    const set = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", "sensors", "off", "--message", id, "--project-dir", proj], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(set.status, `${set.stdout}${set.stderr}`).toBe(0);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("- **Sensors**: off (set by you)");
    const approved = answer(proj, "Approve Plan");
    expect(approved.code, approved.message).toBe(0);
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
  });

  test("Guard Policy off typed before a plan choice lands on this work through the setter, which then builds", () => {
    const proj = project("strict");
    askFor(proj);
    reply(proj, "/aidlc --guard-policy off Approve Plan");
    const lowered = lower(proj, "guard-policy", "off");
    expect(lowered.code, lowered.out).toBe(0);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("- **Guard Policy**: off (set by you)");
    expect(answer(proj, "Approve Plan").code).toBe(0);
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
    reply(proj, "approve it");
    expect(answer(proj, "Approve Plan").code).toBe(0);
  });

  test("an answer from another chat on the same work counts", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "Approve Plan", "Approve Plan", OTHER_SESSION);
    expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // No host hands the hook dismissal text (measured on Claude Code and Codex,
  // 2026-10-12): a reply that is only "cancel" is the person's word. Kept, the
  // agent reads it and records the choice it read; dropped, the engine said they
  // had not replied and the agent asked the same question again. It names no
  // change, so the revision asks what should change.
  test("a reply that is only 'cancel' is kept, and the agent's reading of it is recorded with their word", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "cancel");
    const recorded = answer(proj, "Request Changes");
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.message).toContain('Recorded "Request Changes"');
    expect(auditText(proj)).toContain("**Person Reply**: cancel");
    expect(auditText(proj)).not.toContain("**User Input**: cancel");
    expect(next(proj).plan_approval).toEqual({ status: "revise" });
  });

  test("Request Changes in the person's words reaches the revision, and a revised plan is asked about again", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "rename slugify to toSlug");
    expect(answer(proj, "Request Changes: rename slugify to toSlug").message).toContain('Recorded "Request Changes"');
    const revise = next(proj);
    expect(revise.kind).toBe("run-stage");
    expect(revise.plan_approval).toEqual({ status: "revise", feedback: "rename slugify to toSlug" });
    expect(revise.mode).toBe("inline");
    expect(next(proj).plan_approval.status).toBe("revise");
    writePlan(proj, "- [ ] Step 2: rename slugify to toSlug\n");
    const again = next(proj);
    expect(again.kind).toBe("ask");
    expect(again.plan_approval.note).toBeUndefined();
  });

  // Two live runs typed "/aidlc go back to code generation for a second round:
  // also accept -S ..."; the plan question opened for that message, the change
  // was refused as no reply, and the person was asked to pick Request Changes.
  // Their message record in this chat is the proof, on finished work too,
  // where a prompt leaves no turn row.
  for (const finished of [false, true]) {
    test(`a change asked for in the message the question opened for is its Request Changes${finished ? ", on finished work" : ""}; an approval still needs a reply`, () => {
      const proj = project();
      writePlan(proj);
      const turns = () => auditText(proj).split("**Event**: HUMAN_TURN").length;
      if (finished) {
        // The first round, then the work finished. Message records keep whole
        // seconds: the second round comes in a later one.
        reply(proj, "build the slugify helper");
        Bun.sleepSync(1050 - (Date.now() % 1000));
        const path = seededStateFile(proj);
        writeFileSync(path, readFileSync(path, "utf-8")
          .replace(/^- \[[-R ]\] ([a-z-]+) \u2014 EXECUTE$/gm, "- [x] $1 \u2014 EXECUTE")
          .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: build-and-test")
          .replace(/^- \*\*Status\*\*:.*$/m, "- **Status**: Completed"));
      }
      const words = "go back to code generation: also accept -S as a short form of --shout";
      const before = turns();
      reply(proj, `/aidlc ${words}`);
      // A prompt on finished work leaves no turn row there.
      expect(turns() - before).toBe(finished ? 0 : 1);
      if (finished) {
        const back = spawnSync(BUN, [
          join(AIDLC_SRC, "tools", "aidlc-jump.ts"), "execute", "--target", "code-generation", "--direction", "backward",
          "--scope", "poc", "--project-dir", proj,
        ], { cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj }, encoding: "utf-8" });
        expect(back.status, `${back.stdout}${back.stderr}`).toBe(0);
      }
      expect(next(proj).ask_type).toBe("plan-approval");
      // Words typed before the question never approve it.
      expect(answer(proj, "Approve Plan", [], SESSION).message).toContain("has not replied to the plan question");
      // Another chat's message is not this chat's.
      expect(answer(proj, "Request Changes: also accept -S", [], OTHER_SESSION).message)
        .toContain("has not replied to the plan question");
      expect(answer(proj, "Request Changes: also accept -S", [], SESSION).message).toContain('Recorded "Request Changes"');
      const recorded = auditText(proj).split("\n---\n").find((block) => block.includes("**Details**: Request Changes"));
      expect(recorded).toContain("**User Input**: also accept -S");
      expect(recorded).toContain(`**Person Reply**: ${words}`);
      expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "also accept -S" });
      // The revised plan's question is a later one: it needs a reply of its own.
      writePlan(proj, "- [ ] Step 2: accept -S\n");
      expect(next(proj).ask_type).toBe("plan-approval");
      expect(answer(proj, "Request Changes", [], SESSION).message).toContain("has not replied to the plan question");
      expect(answer(proj, "Approve Plan", [], SESSION).message).toContain("has not replied to the plan question");
      replyAndRecord(proj, "1", "Approve Plan");
      expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
    });
  }

  // Two of this chat's messages in the same second cannot be told apart by
  // their records: neither is taken, and the agent names the one it means.
  test("two messages in the opening's second: neither is taken unless the agent names one", () => {
    const proj = project();
    writePlan(proj);
    const words = "/aidlc go back to code generation: also accept -S as a short form of --shout";
    reply(proj, words);
    const opening = listMessages(proj).find((m) => m.session === SESSION && personsWordsText(m.text) === words);
    expect(opening).toBeDefined();
    const { id: _id, ...rest } = opening!;
    saveMessage(proj, { ...rest, picker: null, text: "also make it blue", words: "also make it blue" });
    expect(next(proj).ask_type).toBe("plan-approval");
    expect(answer(proj, "Request Changes", [], SESSION).message).toContain("has not replied to the plan question");
    expect(answer(proj, "Request Changes", ["--message", opening!.id], SESSION).message).toContain('Recorded "Request Changes"');
    expect(auditText(proj)).toContain("**Person Reply**: go back to code generation: also accept -S as a short form of --shout");
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

  // A note the person adds in Codex's box comes back as a second entry beside
  // their pick: still one pick, so the plan is approved, not asked again.
  test("a Codex picker pick with the person's note approves the plan", () => {
    const proj = project();
    const ask = askFor(proj);
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(proj, ".codex"), { recursive: true });
    const session = "codex-plan-approval-session-note";
    writeSessionPidEntry(proj, process.pid, session);
    const result = spawnSync(BUN, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], {
      cwd: proj,
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: session,
        turn_id: "codex-turn-note",
        cwd: proj,
        tool_name: "request_user_input",
        tool_input: {
          questions: [{
            id: "plan",
            question: ask.question,
            options: ["Approve Plan (Recommended)", "Request Changes", "I'll edit the files"],
          }],
        },
        tool_response: JSON.stringify({
          answers: { plan: { answers: ["Approve Plan (Recommended)", "user_note: keep the old helper"] } },
        }),
        tool_use_id: "request-codex-turn-note",
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

  // Codex's other box (request_user_input_async) sends the answer back as a
  // new prompt in its own reply envelope, the agent's question beside it
  // (captured live on Codex CLI 0.164.0). The plan question keeps the answer
  // alone, as the words of a reply typed in the chat.
  test("an answer in Codex's async question box answers the plan question in the person's own words", () => {
    const proj = project();
    askFor(proj);
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(proj, ".codex"), { recursive: true });
    writeSessionPidEntry(proj, process.pid, SESSION);
    const reply = "<send_user_message_question_reply>\n" + JSON.stringify([{
      answer: "Approve Plan",
      question: "Approve the code plan? It builds slugify for titles and adds three unit tests.",
      questionItemId: JSON.stringify(["request_user_input_async", "call_e67db833bc2f5fc8811b5c62c85d35f2", 0]),
    }]) + "\n</send_user_message_question_reply>";
    const result = spawnSync(BUN, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], {
      cwd: proj,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: "codex-async-turn", cwd: proj, prompt: reply }),
      env: { ...process.env, AIDLC_UNATTENDED: undefined, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, result.stderr).toBe(0);
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(auditText(proj)).toContain("**Person Reply**: Approve Plan\n");
    expect(auditText(proj)).not.toContain("send_user_message_question_reply");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("a question records nothing; the agent answers it, and their next reply decides", () => {
    const proj = project();
    askFor(proj);
    expect(reply(proj, "what does step 1 do?")).not.toContain("step 1");
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

  // The person edits the plan files, then hands the plan back in their own words.
  // Their reply is kept; the agent reads which answer it is. The refusal and the
  // edit-mode question name the answer to record, with a place for what they
  // asked of the plan, so nobody goes round: the answer, the write and next,
  // and the plan is the agent's, with what they asked.
  test("edit mode: the person hands the plan back; the refusal names the answer to record, with what they asked of the plan", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
    expect(next(proj).plan_approval.editing).toBe(true);
    const planPath = join(stageDir(proj), "code-generation-plan.md");
    // Before they reply, the files are theirs.
    const waiting = guardWrite(proj, planPath);
    expect(waiting.code).toBe(2);
    expect(waiting.stderr).toContain("When they say they are done");
    expect(waiting.stderr).not.toContain("--checkpoint plan-approval");
    reply(proj, "you finish it");
    const handedBack = guardWrite(proj, planPath);
    expect(handedBack.code).toBe(2);
    expect(handedBack.stderr).toContain(
      "answer --stage code-generation --checkpoint plan-approval --details 'Request Changes: <what they asked of the plan>'");
    expect(handedBack.stderr).toContain('--details "Approve Plan"');
    const asked = next(proj);
    expect(asked.plan_approval.editing).toBe(true);
    expect(String(asked.plan_approval.note)).toContain("--details 'Request Changes: <what they asked of the plan>'");
    const recorded = answer(proj, "Request Changes: finish the plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(guardWrite(proj, planPath).code).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "finish the plan" });
  });

  test("edit mode: the agent cannot touch the files, and done approves them as the person left them", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
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
    replyAndRecord(proj, "3", "I'll edit the files");
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
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
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
    expect(ask.question).toBe("I repaired the plan's Testing Contract (the test rules your build follows). Build your edited plan?");
  });

  // The person's stop holds even when the plan they approved needs repair
  // first: the repair waits until they resume (#1411).
  test("edit mode: approve and stop parks even when the Testing Contract needs repair", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
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
    replyAndRecord(proj, "1", "Approve Plan");
    writeFileSync(join(proj, "src", "other.ts"), "export const other = 1;\n", "utf-8");
    const build = next(proj);
    expect(build.kind).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  test("under strict, a plan edited after approval is asked about again", () => {
    const proj = project("strict");
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    writePlan(proj, "- [ ] Step 2: add a fast path\n");
    expect(next(proj).kind).toBe("ask");
  });

  // With Guard Policy off or relaxed a changed file is not a new question: a
  // note added to the answered questions file, or a checkout that rewrote its
  // line endings, keeps the person's approval. Strict still asks.
  test.each(["relaxed", "off"] as const)("under %s, a note or new line endings in the answered questions file keep the approval", (policy) => {
    const proj = project(policy);
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    const path = join(stageDir(proj), "code-generation-questions.md");
    writeFileSync(path, `${readFileSync(path, "utf-8").replace(/\n/g, "\r\n")}\r\nNote: checked with the team.\r\n`, "utf-8");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  test("under strict, a note added to the answered questions file is asked about again", () => {
    const proj = project("strict");
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    const path = join(stageDir(proj), "code-generation-questions.md");
    writeFileSync(path, `${readFileSync(path, "utf-8")}\nNote: checked with the team.\n`, "utf-8");
    expect(next(proj).kind).toBe("ask");
  });

  test("'review the plan' after approval asks again before anything is built", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    reply(proj, "review the plan first");
    expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    const ask = next(proj);
    expect(ask.kind).toBe("ask");
    replyAndRecord(proj, "1", "Approve Plan");
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
    expect(answer(proj, "Approve Plan").message).toContain("has not replied since Request Changes was recorded");
    reply(proj, "no, I approved it");
    const corrected = answer(proj, "Approve Plan");
    expect(corrected.code, corrected.message).toBe(0);
    expect(corrected.message).toContain("correcting the Request Changes recorded before");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // The agent's Request Changes stands until the person replies again; then
  // their newer reply decides, as the agent reads it.
  test("a recorded Request Changes is refused as an approval until the person replies again", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "2", "Request Changes");
    expect(next(proj).plan_approval.status).toBe("revise");
    const refused = answer(proj, "Approve Plan");
    expect(refused.code).not.toBe(0);
    reply(proj, "ok, thanks");
    const read = answer(proj, "Approve Plan");
    expect(read.code, read.message).toBe(0);
    expect(read.message).toContain("correcting the Request Changes recorded before");
  });

  test("\"2\" then \"actually, approve it\": the agent records Approve Plan with no second question", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "2", "Request Changes");
    reply(proj, "actually, approve it");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(recorded.message).toContain("correcting the Request Changes recorded before");
    expect(auditText(proj)).toContain("**Person Reply**: actually, approve it");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("\"2\" then \"1\": the agent reads each reply, and its Approve Plan on the second is recorded", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "2", "Request Changes");
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // No tool holds the agent to a reading of "2": its Request Changes is
  // recorded, and an approval with no newer reply of theirs is not.
  test("\"2\" read as Request Changes, and no newer reply: an approval record is refused, before and after next", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "2", "Request Changes");
    expect(answer(proj, "Approve Plan").code).not.toBe(0);
    expect(next(proj).plan_approval.status).toBe("revise");
    expect(answer(proj, "Approve Plan").code).not.toBe(0);
    expect(evaluateCodeGenerationApproval(proj, { unit: null }).ok).toBe(false);
  });

  // Under strict, a revised plan is asked about again: the policy's purpose is
  // to ask. Under off and relaxed the person's own change request is not put
  // back to them (t-plan-revised-for-their-request.test.ts).
  test("a rejected gate sends the approved plan back with the person's words, then asks about the revised plan", () => {
    const proj = project("strict");
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
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

  // The same chain under a lowered fence: they asked for the change, so the
  // revised plan builds and the gate after it collects their judgement.
  test("under relaxed, the plan revised for their own change request builds with no second question", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    appendAuditEntry("GATE_REJECTED", {
      Stage: "code-generation", "User Input": "Request Changes", Feedback: "log every slug",
    }, proj);
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "log every slug" });
    writePlan(proj, "- [ ] Step 2: log every slug\n");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval?.status).toBe("approved");
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
    replyAndRecord(proj, "1", "Approve Plan");
    expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
    writePlan(proj, "- [ ] Step 2: add a fast path\n");
    expect(next(proj).kind).toBe("ask");
    expect(questions(proj)).toMatch(/^\[Answer\]:$/m);
  });

  test("Request Changes sends the plan back with the person's words, then asks about the revised plan", () => {
    const proj = withRulesInParts(project());
    askFor(proj);
    reply(proj, "rename slugify to toSlug");
    expect(answer(proj, "Request Changes: rename slugify to toSlug").message).toContain('Recorded "Request Changes"');
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
    replyAndRecord(proj, "1", "Approve Plan");
    expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
    reply(proj, "review the plan first");
    expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    expect(next(proj).kind).toBe("ask");
    replyAndRecord(proj, "1", "Approve Plan");
    const build = nextThroughParts(proj);
    expect(build.parts).toBeGreaterThan(1);
    expect(build.directive.plan_approval).toEqual({ status: "approved" });
  });

  test("after Request Changes and \"Review the plan\", Approve Plan waits for a new reply, then records", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "2", "Request Changes");
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

  // A question about the switch is kept whole as the person's words, no tool
  // reads it, so nothing is recorded or applied and the plan question stays open
  // for the agent to answer.
  test("\"skip plan approval?\" records nothing and leaves the plan question open", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "skip plan approval?");
    expect(auditText(proj)).not.toContain("**Event**: QUESTION_ANSWERED");
    expect(auditText(proj)).not.toContain("**Event**: CEREMONY_SET");
    // The plan files are AI-DLC's records and pass; the code waits, and the
    // question is still the step.
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-plan.md")).code).toBe(0);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("'review the plan first' said while the rules are arriving asks again before anything is built", () => {
    const proj = withRulesInParts(project());
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
    reply(proj, "review the plan first");
    expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    replyAndRecord(proj, "1", "Approve Plan");
    expect(nextThroughParts(proj).directive.plan_approval).toEqual({ status: "approved" });
  });

  for (const policy of ["strict", "relaxed", "off"] as const) {
    test(`nothing is built or handed to a worker until the stage's own step arrives (Guard Policy ${policy})`, () => {
      const proj = withRulesInParts(project(policy));
      askFor(proj);
      replyAndRecord(proj, "1", "Approve Plan");
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
    replyAndRecord(proj, "1", "Approve Plan");
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
    replyAndRecord(proj, "1", "Approve Plan");
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
      replyAndRecord(proj, "1", "Approve Plan");
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
    replyAndRecord(proj, "1", "Approve Plan");
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
    replyAndRecord(proj, "1", "Approve Plan");
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
        replyAndRecord(proj, "1", "Approve Plan");
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
  // answer for them meanwhile.
  test("the chat compacts while the question waits: the person's answer counts", () => {
    const proj = project();
    askFor(proj);
    interrupt(proj, "the chat compacts");
    // The plan file is a record and passes; the code still waits.
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-plan.md")).code).toBe(0);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(questions(proj)).toMatch(/^\[Answer\]: A\. Approve Plan$/m);
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });

  test("under strict, a plan edited after approval is asked about again", () => {
    const proj = project("strict");
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
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
    replyAndRecord(proj, "1", "Approve Plan");
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
    expect(answer(proj, "Request Changes: rename slugify to toSlug").code).toBe(0);
    interrupt(proj, "the chat compacts");
    const revise = next(proj);
    expect(revise.kind, JSON.stringify(revise)).toBe("run-stage");
    expect(revise.plan_approval).toEqual({ status: "revise", feedback: "rename slugify to toSlug" });
  });

  test("'review the plan' still asks again", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
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
    replyAndRecord(proj, "1", "Approve Plan");
    interrupt(proj, "the chat compacts");
    const route = (unit: string) => routeCodeGenerationPlanApproval(proj, {
      kind: "run-stage", stage: "code-generation", unit,
    } as Parameters<typeof routeCodeGenerationPlanApproval>[1]) as unknown as Emitted;
    expect(route("unit-2").plan_approval).toEqual({ status: "approved" });
    expect(route("unit-3")).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("one approval for several Units still builds all of them", () => {
    const { pd } = groupedProject();
    replyAndRecord(pd, "approve all", "Approve all");
    interrupt(pd, "the chat compacts");
    const routed = routeCodeGenerationPlanApproval(pd, { kind: "invoke-swarm", stage: "code-generation", units: GROUP });
    expect((routed as unknown as Emitted).plan_approval).toEqual({ status: "approved" });
  });

  // "Build them one at a time" after one approval for several Units: the
  // switch's state write retires the step the engine issued, not the person's
  // approval, so each Unit is built from its approved plan.
  test("one approval for several Units, then 'build them one at a time': each Unit is built, not asked about again", () => {
    const { pd } = groupedProject();
    replyAndRecord(pd, "approve all", "Approve all");
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
    reply(pd, "build them one at a time instead");
    for (const setter of [["set-construction-execution", "serial"], ["set-construction-iteration", "unit-major"]]) {
      const set = spawnSync(BUN, [STATE, ...setter, "--project-dir", pd], {
        cwd: pd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: pd, AIDLC_PROJECT_DIR: pd, AIDLC_UNATTENDED: "0" },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(set.status, `${set.stdout}${set.stderr}`).toBe(0);
    }
    for (const unit of GROUP) {
      const routed = routeCodeGenerationPlanApproval(pd, {
        kind: "run-stage", stage: "code-generation", unit,
      } as Parameters<typeof routeCodeGenerationPlanApproval>[1]) as unknown as Emitted;
      expect(routed.plan_approval, JSON.stringify(routed)).toEqual({ status: "approved" });
    }
  });

  // Only this work's own Code Generation step stands in when it is out of date.
  test("an out-of-date step of another stage or another piece of work is not read for the approval", () => {
    const { pd } = groupedProject();
    replyAndRecord(pd, "approve all", "Approve all");
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
    const file = join(activeDirectiveStorageDir(pd), "active-directive.json");
    const issued = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const route = (change: Record<string, unknown>) => {
      writeFileSync(file, JSON.stringify({ ...issued, state_sha256: stateDigest("# an earlier state\n"), ...change }));
      return routeCodeGenerationPlanApproval(pd, {
        kind: "run-stage", stage: "code-generation", unit: "alpha",
      } as Parameters<typeof routeCodeGenerationPlanApproval>[1]) as unknown as Emitted;
    };
    expect(route({}).plan_approval).toEqual({ status: "approved" });
    expect(route({ stage: "functional-design" }).kind).toBe("ask");
    expect(route({ intent_uuid: "01995000-7a11-7000-8000-00000000ffff" }).kind).toBe("ask");
  });

  // "Review the plan first" is the person's own request, whatever the engine
  // said last: the plan is shown for approval again before anything is built.
  for (const how of INTERRUPTIONS) {
    for (const unit of [null, "unit-2"]) {
      test(`${how}, then 'review the plan first': the plan is asked about again (${unit ?? "no Units"})`, () => {
        const proj = unit ? unitProject(unit) : project();
        writePlan(proj, "", unit);
        expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
        replyAndRecord(proj, "1", "Approve Plan");
        expect(next(proj).plan_approval).toEqual({ status: "approved" });
        interrupt(proj, how);
        reply(proj, "review the plan first");
        expect(answer(proj, "Review the plan").message).toContain("wants to review the plan");
        const ask = next(proj);
        expect(ask, JSON.stringify(ask)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
        expect(questions(proj, unit)).toMatch(/^\[Answer\]:$/m);
        replyAndRecord(proj, "1", "Approve Plan");
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
    replyAndRecord(proj, "1", "Approve Plan");
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
    replyAndRecord(proj, "1", "Approve Plan");
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
  test("before the question, the batch's plans can be written in the main workspace, and the code waits", () => {
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
    // A later Unit's plan is a record of this work too: it passes.
    expect(guardWrite(pd, join(codeGenerationRecordDir(pd, "later"), "code-generation-plan.md")).code).toBe(0);
    expect(guardWrite(pd, join(pd, "src", "alpha.ts")).code).toBe(2);
  });

  // With plan approval off the batch builds at once, so its one line names
  // every plan and asks nothing.
  test("with plan approval off, the batch's line names every plan and says they can be gone over at any time", () => {
    const pd = swarmFixture(true, GROUP, "off");
    const routed = swarmState(pd);
    expect(routed.plan_approval.skipped, JSON.stringify(routed)).toBe(true);
    expect(routed.plan_approval.notice).toContain("Plans written: ");
    expect(routed.plan_approval.notice).toContain("Starting code generation now. You can ask me to go over the plans at any time.");
    expect(routed.plan_approval.notice).not.toContain("?");
  });

  test("shows every Unit's summary, and 'approve all' approves each Unit separately", () => {
    const { pd, ask } = groupedProject();
    expect(ask.question).toBe("Approve these 2 code plans?");
    expect(ask.plan_approval.choices).toEqual(["Approve all", "Request Changes", "I'll edit the files"]);
    expect((ask.plan_approval.targets ?? []).map((target) => target.unit)).toEqual(GROUP);
    expect(ask.plan_approval.targets?.[1].summary).toEqual(["Builds: beta"]);
    replyAndRecord(pd, "approve all", "Approve all");
    for (const unit of GROUP) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(true);
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
  });

  // A reply while the person edits several Units' plans can be about some of
  // them ("alpha is finished; you finish beta"), so no answer for all of them is
  // named: the files stay theirs, and Request Changes or Approve Plan for the
  // Units they name is the agent's to record.
  test("edit mode on a grouped question: a reply names no answer for every Unit, and the files stay the person's", () => {
    const { pd } = groupedProject();
    reply(pd, "I'll edit the files");
    const editing = answer(pd, "I'll edit the files");
    expect(editing.code, editing.message).toBe(0);
    reply(pd, "alpha is finished; you finish beta");
    const plan = join(codeGenerationRecordDir(pd, "beta"), "code-generation-plan.md");
    const refused = guardWrite(pd, plan);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("When they say they are done");
    expect(refused.stderr).not.toContain("--checkpoint plan-approval");
    const asked = swarmState(pd);
    expect(asked.plan_approval.editing).toBe(true);
    expect(String(asked.plan_approval.note)).not.toContain("--checkpoint plan-approval");
    for (const unit of GROUP) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(false);
  });

  test("a change naming one Unit: the agent sends only that Unit back and approves the rest", () => {
    const { pd } = groupedProject();
    reply(pd, "change beta: use a lookup table");
    expect(answer(pd, "Request Changes: use a lookup table", ["--units", "beta"]).message).toContain("for alpha too");
    expect(answer(pd, "Approve Plan", ["--units", "alpha"]).message).toContain('Recorded "Approve Plan" for alpha');
    expect(evaluateCodeGenerationApproval(pd, { unit: "alpha" }).ok).toBe(true);
    expect(evaluateCodeGenerationApproval(pd, { unit: "beta" }).ok).toBe(false);
    expect(swarmState(pd).plan_approval).toEqual({
      status: "plan",
      units: [{ unit: "beta", status: "revise", feedback: "use a lookup table" }],
    });
  });

  test("a bare \"2\" for a group is the agent's to read: its Request Changes holds until a later reply", () => {
    const { pd } = groupedProject();
    replyAndRecord(pd, "2", "Request Changes");
    const refused = answer(pd, "Approve all");
    expect(refused.code).not.toBe(0);
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

  test("the plans' files are records and can be written at any point of the question; the code waits", () => {
    const { pd } = groupedProject();
    const file = (unit: string, name: string) => join(codeGenerationRecordDir(pd, unit), name);
    expect(guardWrite(pd, file("alpha", "code-generation-plan.md")).code).toBe(0);
    reply(pd, "2");
    for (const unit of GROUP) expect(guardWrite(pd, file(unit, "code-generation-plan.md")).code).toBe(0);
    reply(pd, "approve alpha; beta, add a test for an empty list, then approve it");
    for (const unit of GROUP) {
      expect(guardWrite(pd, file(unit, "code-generation-plan.md")).code).toBe(0);
      expect(guardWrite(pd, file(unit, "unit-test-instructions.md")).code).toBe(0);
      // An answer the agent writes into the questions file has no receipt.
      expect(guardWrite(pd, file(unit, "code-generation-questions.md")).code).toBe(0);
    }
    expect(guardWrite(pd, file("later", "code-generation-plan.md")).code).toBe(0);
    expect(guardWrite(pd, join(pd, "src", "alpha.ts")).code).toBe(2);
    expect(answer(pd, "Approve Plan", ["--units", "alpha"]).code).toBe(0);
    // After alpha's approval its plan file still passes: a plan changed after
    // the approval fails the fingerprint and is asked about again.
    expect(guardWrite(pd, file("alpha", "code-generation-plan.md")).code).toBe(0);
    expect(guardWrite(pd, file("beta", "code-generation-plan.md")).code).toBe(0);
    expect(guardWrite(pd, join(pd, "src", "alpha.ts")).code).toBe(2);
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
      replyAndRecord(proj, "1", "Approve Plan");
      expect(next(proj).plan_approval).toEqual({ status: "approved" });
      guardRecoveryQuestion(proj);
      reply(proj, words);
      const said = answer(proj, "Review the plan").message;
      expect(said).toContain("wants to review the plan");
      // The open recovery question keeps that they replied, and no remedy is picked from their words.
      expect(marker(proj).guard_recovery_response?.selected_op ?? null).toBeNull();
      expect(routeStage(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    });
  }

  test("'review the plan before building' during a protected checkpoint question picks nothing there", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
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
    replyAndRecord(proj, "1", "Approve Plan");
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

  test("a reply the agent records as the guard-recovery answer stays that answer when it records no review", () => {
    const proj = project();
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    guardRecoveryQuestion(proj);
    const words = "Request Changes: review the plan's error handling";
    reply(proj, words);
    const recorded = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "guard-recovery",
      "--details", words, "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
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
      expect(answer(pd, "Request Changes: use a lookup table", ["--units", "beta"]).code).toBe(0);
      expect(answer(pd, "Approve Plan", ["--units", group.filter((unit) => unit !== "beta").join(",")]).code).toBe(0);
      const swarm = (units: string[]) => {
        writeActiveDirectiveMarker(pd, { kind: "invoke-swarm", stage: "code-generation", units, state_sha256: state() });
        return routeCodeGenerationPlanApproval(pd, { kind: "invoke-swarm", stage: "code-generation", units }) as unknown as Emitted;
      };
      expect(swarm(group).plan_approval.units).toEqual([
        { unit: "beta", status: "revise", feedback: "use a lookup table" },
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
    replyAndRecord(pd, "approve all", "Approve all");
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
    replyAndRecord(pd, "approve all", "Approve all");
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
    replyAndRecord(pd, "1", "Approve Plan");
    expect(existsSync(legacy)).toBe(false);
    expect(planApprovalReviewRequested(pd, "unit:beta", other)).toBe(true);
    expect(swarmState(pd).plan_approval).toEqual({ status: "approved" });
  });
});

// An isolated Code Generation run (`next --stage code-generation --single`)
// while the workflow sits at another stage: every step of its plan names that
// run's own `next`, since a bare `next` routes the main workflow (a live agent
// that followed the plan step was handed Requirements Analysis).
describe("an isolated Code Generation run's plan steps name that run's own next", () => {
  const SINGLE = ["--stage", "code-generation", "--single"];
  const WORKFLOW_NEXT = "bun .claude/tools/aidlc-orchestrate.ts next";
  const OWN = `${WORKFLOW_NEXT} --stage code-generation --single --scope poc`;
  const planStep = (command: string) =>
    `Write this plan and its test instructions (Code Generation Steps 1 and 2), then run \`${command}\`: ` +
    "AI-DLC asks the person to approve the plan itself, never you.";
  // The project's own copy of the harness, as an installed project has it.
  function isolated(): string {
    const proj = project();
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    const stateFile = seededStateFile(proj);
    writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
      .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: requirements-analysis"), "utf-8");
    reply(proj, "/aidlc --stage code-generation --single");
    return proj;
  }
  // The command the step names, run as printed.
  const own = (proj: string): Emitted => next(proj, OWN.split(" ").slice(3));

  test("the plan step, the question and the build: each names it, and it brings back that run's step", () => {
    const proj = isolated();
    const state = readFileSync(seededStateFile(proj), "utf-8");
    const planning = next(proj, SINGLE);
    expect(planning, JSON.stringify(planning)).toMatchObject({ kind: "run-stage", stage: "code-generation", plan_approval: { status: "plan", next: OWN } });
    expect(planning.plan_note).toBe(planStep(OWN));
    writePlan(proj);
    const asked = own(proj);
    expect(asked, JSON.stringify(asked)).toMatchObject({ kind: "ask", ask_type: "plan-approval", stage: "code-generation", plan_approval: { next: OWN } });
    expect(String(asked.question_note)).toEndWith(`, then run \`${OWN}\`.`);
    expect(String(asked.question_note)).not.toContain(`\`${WORKFLOW_NEXT}\``);
    replyAndRecord(proj, "approve", "Approve Plan");
    expect(own(proj)).toMatchObject({ kind: "run-stage", stage: "code-generation", plan_approval: { status: "approved" } });
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(state);
  });

  test("Request Changes: the revision names it", () => {
    const proj = isolated();
    next(proj, SINGLE);
    writePlan(proj);
    const asked = own(proj);
    expect(asked.ask_type, JSON.stringify(asked)).toBe("plan-approval");
    replyAndRecord(proj, "rename slugify to toSlug", "Request Changes");
    const revising = own(proj);
    expect(revising, JSON.stringify(revising)).toMatchObject({ kind: "run-stage", stage: "code-generation", plan_approval: { status: "revise", next: OWN } });
    expect(revising.plan_note).toBe(
      `The person asked for changes to this plan: revise the plan and its test instructions from their words, then run \`${OWN}\`.`,
    );
  });

  test("the person edits the files: the reply's step names it", () => {
    const proj = isolated();
    next(proj, SINGLE);
    writePlan(proj);
    expect(own(proj).ask_type).toBe("plan-approval");
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
    expect(own(proj).plan_approval.editing).toBe(true);
    reply(proj, "you finish it");
    const editing = own(proj);
    expect(editing, JSON.stringify(editing)).toMatchObject({ kind: "ask", plan_approval: { editing: true, next: OWN } });
    expect(String(editing.plan_approval.note)).toEndWith(`Then run \`${OWN}\`.`);
    expect(String(editing.question_note)).not.toContain(`\`${WORKFLOW_NEXT}\``);
  });

  test("the workflow's own plan steps keep the bare next and carry no command of their own", () => {
    const proj = project();
    const planning = next(proj);
    expect(planning.plan_approval).toEqual({ status: "plan" });
    expect(planning.plan_note).toBe(planStep(WORKFLOW_NEXT));
    writePlan(proj);
    const asked = next(proj);
    expect(asked.ask_type).toBe("plan-approval");
    expect(asked.plan_approval).not.toHaveProperty("next");
    expect(String(asked.question_note)).toContain(`or run \`${WORKFLOW_NEXT}\` when it returns none.`);
    expect(String(asked.question_note)).toEndWith(`, then run \`${WORKFLOW_NEXT}\`.`);
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
    next(proj);
    reply(proj, "you finish it");
    expect(String(next(proj).plan_approval.note)).toEndWith(". Then run next.");
  });
});

// An isolated Code Generation run in a project with no work: its start is in
// the space's own record, and its plan question is the open step there, bound
// to the empty state its step was issued on, so the person's answer records
// (PLAN_APPROVAL_RECORDED beside the start) and the run builds and finishes as
// it does inside work.
describe("an isolated Code Generation run in a project with no work", () => {
  const SINGLE = ["--stage", "code-generation", "--single", "--scope", "enterprise"];
  const OWN_NEXT = "bun .claude/tools/aidlc-orchestrate.ts next";
  const SPACE_RECORD = ["aidlc", "spaces", "default", "intents"];
  const planDir = (proj: string) => join(proj, ...SPACE_RECORD, "construction", "code-generation");
  // A project with code and no work, the harness installed, and the run started.
  function noWork(start = true): string {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    removeWorkspaceRecord(proj);
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
    if (start) {
      reply(proj, "/aidlc --stage code-generation --single");
      expect(next(proj, SINGLE).plan_approval?.status).toBe("plan");
    }
    return proj;
  }
  function writeOwnPlan(proj: string, builds = "slugify for titles"): void {
    mkdirSync(planDir(proj), { recursive: true });
    writeFileSync(
      join(planDir(proj), "code-generation-plan.md"),
      `# Code Generation Plan\n\n## Summary\n\n- Builds: ${builds}\n- Touches: src/slugify.ts\n` +
        "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" +
        renderTestingContract(resolveTestingPosture(proj)),
      "utf-8",
    );
    writeFileSync(join(planDir(proj), "unit-test-instructions.md"),
      "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
  }
  function asked(proj: string): Emitted {
    const directive = next(proj, SINGLE);
    expect(directive, JSON.stringify(directive)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    return directive;
  }
  function events(proj: string): string[] {
    const dir = join(proj, ...SPACE_RECORD, "audit");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), "utf-8").split("\n---\n"))
      .flatMap((block) => /\*\*Event\*\*: (\S+)/.exec(block)?.[1] ?? []);
  }
  function builds(proj: string): void {
    expect(next(proj, SINGLE)).toMatchObject({ kind: "run-stage", stage: "code-generation", plan_approval: { status: "approved" } });
  }
  function finishes(proj: string): void {
    writeFileSync(join(proj, "src", "slugify.ts"), "export const slugify = (s: string) => s;\n", "utf-8");
    const result = spawnSync(BUN, [
      DISPATCHER, "engine", "orchestrate", "report", "--single", "--stage", "code-generation", "--result", "completed",
      "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect((JSON.parse(result.stdout || "{}") as { kind?: string }).kind, result.stdout).toBe("done");
    expect(events(proj).filter((event) => event === "STAGE_COMPLETED")).toHaveLength(1);
    expect(existsSync(join(proj, ...SPACE_RECORD, "aidlc-state.md"))).toBe(false);
    expect(existsSync(join(proj, ...SPACE_RECORD, "intents.json"))).toBe(false);
  }

  test("Approve Plan is recorded beside the run's start, and the run builds and finishes", () => {
    const proj = noWork();
    writeOwnPlan(proj);
    asked(proj);
    expect(existsSync(join(planDir(proj), "code-generation-questions.md"))).toBe(true);
    replyAndRecord(proj, "approve", "Approve Plan");
    expect(events(proj).filter((event) => event === "PLAN_APPROVAL_RECORDED")).toHaveLength(1);
    builds(proj);
    finishes(proj);
  });

  test("Request Changes: the revision names the run's own next, and the revised plan is asked about once", () => {
    const proj = noWork();
    writeOwnPlan(proj);
    asked(proj);
    replyAndRecord(proj, "rename slugify to toSlug", "Request Changes: rename slugify to toSlug");
    expect(next(proj, SINGLE)).toMatchObject({
      kind: "run-stage",
      plan_approval: { status: "revise", feedback: "rename slugify to toSlug", next: `${OWN_NEXT} ${SINGLE.join(" ")}` },
    });
    writeOwnPlan(proj, "toSlug for titles");
    expect(asked(proj).plan_approval.targets?.[0].summary[0]).toBe("Builds: toSlug for titles");
    replyAndRecord(proj, "ok, approve", "Approve Plan");
    builds(proj);
  });

  test("the person edits the files: after done, their approval builds", () => {
    const proj = noWork();
    writeOwnPlan(proj);
    asked(proj);
    replyAndRecord(proj, "I'll edit the files", "I'll edit the files");
    expect(asked(proj).plan_approval.editing).toBe(true);
    writeFileSync(join(planDir(proj), "unit-test-instructions.md"),
      "# Unit Test Instructions\n\nRun `bun test src`.\n", "utf-8");
    replyAndRecord(proj, "done", "Approve Plan");
    builds(proj);
  });

  test("review the plan first, said after approving: the plan is asked about again", () => {
    const proj = noWork();
    writeOwnPlan(proj);
    asked(proj);
    replyAndRecord(proj, "approve", "Approve Plan");
    reply(proj, "wait, review the plan first");
    const review = answer(proj, "Review the plan");
    expect(review.code, review.message).toBe(0);
    asked(proj);
  });

  test("with no run open the plan answer is refused as before and records nothing", () => {
    const proj = noWork(false);
    reply(proj, "approve");
    const refused = answer(proj, "Approve Plan");
    expect(refused.code).not.toBe(0);
    expect(events(proj)).not.toContain("PLAN_APPROVAL_RECORDED");
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
    const result = spawnSync(BUN, [ORCHESTRATE, "report", "--result", "resumed", "--choice", choice, "--project-dir", proj], {
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
    ["a scope change", "/aidlc --scope feature", ["--scope", "feature"]],
    ["a setting change", "/aidlc --depth minimal --review advisory", ["--depth", "minimal", "--review", "advisory"]],
    ["new work beside it", "/aidlc --new-intent add a csv export", ["--new-intent", "--scope", "poc", "add a csv export"]],
    ["a redo asked for on re-entry", "redo this stage from the start", null],
  ] as const)("%s: every command the engine names gets through", (_label, typed, args) => {
    const proj = waitingPlan();
    reply(proj, typed);
    const directive = args === null ? resumeReport(proj, "redo") : next(proj, [...args]);
    const commands = namedCommands(directive).map(filled);
    expect(commands.length, `no command named: ${JSON.stringify(directive)}`).toBeGreaterThan(0);
    for (const command of commands) {
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
    }
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
  });

  test("the review brief and the stage's question rows get through, and an added write does not", () => {
    const proj = waitingPlan();
    for (const command of protocolCommands()) {
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
      expect(guardBash(proj, `${command}; printf x > src/slugify.ts`).code, `${command} with a write`).toBe(2);
    }
  });

  test("a review the person asks for runs while the plan waits: its request is the engine's command, its files are records, the code waits", () => {
    const proj = waitingPlan();
    const request = "bun .claude/tools/aidlc.ts engine log review --stage code-generation --reviewer aidlc-architecture-reviewer-agent --iteration 2";
    // AI-DLC's own command: the log tool judges it, this guard does not.
    expect(guardBash(proj, request).code).toBe(0);
    reply(proj, "before I approve the plan, have the reviewer look at it again");
    expect(guardBash(proj, request).code, guardBash(proj, request).stderr).toBe(0);
    expect(guardBash(proj, `${request} --verdict READY`).code).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
    const reviewFile = ".aidlc-engine/reviews/code-generation/stage/a1/2.0123456789abcdef0123456789abcdef.review.md";
    const dispatch = join(record, ".aidlc-engine", "reviewer-dispatch.json");
    // The path as an agent types it in bash: from the project, with forward
    // slashes (bash reads a Windows backslash as an escape).
    const dispatchInShell = dispatch.slice(proj.length + 1).replace(/\\/g, "/");
    // The reviewer's own records pass, request or no request.
    expect(guardWrite(proj, join(record, reviewFile)).code).toBe(0);
    expect(guardWrite(proj, dispatch).code).toBe(0);
    appendAuditEntry("REVIEW_REQUESTED", {
      Stage: "code-generation", Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "2",
      "Request Id": "review:0123456789abcdef0123456789abcdef", "Review File": reviewFile,
    }, proj);
    expect(guardWrite(proj, join(record, reviewFile)).code).toBe(0);
    expect(guardWrite(proj, dispatch).code).toBe(0);
    expect(guardBash(proj, `rm ${dispatchInShell}`).code).toBe(0);
    // Other records pass too; the code the plan names still waits.
    expect(guardWrite(proj, join(record, ".aidlc-engine", "reviews", "code-generation", "stage", "a1", "3.other.review.md")).code).toBe(0);
    expect(guardWrite(proj, join(record, "construction", "code-generation", "code-summary.md")).code).toBe(0);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
    expect(guardBash(proj, `printf x > ${dispatchInShell}; printf x > src/slugify.ts`).code).toBe(2);
    // Once the review completes, its files are still the reviewer's records.
    appendAuditEntry("REVIEW_COMPLETED", {
      Stage: "code-generation", Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "2", Verdict: "READY",
      "Request Id": "review:0123456789abcdef0123456789abcdef",
    }, proj);
    expect(guardWrite(proj, join(record, reviewFile)).code).toBe(0);
    expect(guardWrite(proj, dispatch).code).toBe(0);
    // Audit rows are project text: a Review File outside the reviews folder
    // never opens a write while the plan waits.
    appendAuditEntry("REVIEW_REQUESTED", {
      Stage: "code-generation", Reviewer: "aidlc-architecture-reviewer-agent", Iteration: "3",
      "Request Id": "review:fedcba9876543210fedcba9876543210", "Review File": "../../../../../src/slugify.ts",
    }, proj);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
  });

  test("a jump waits for the person to ask (the jump tool checks no one); a skip is the engine's own command; the code waits", () => {
    const proj = waitingPlan();
    const jump = "bun .claude/tools/aidlc-jump.ts execute --target nfr-requirements --direction backward --scope poc";
    expect(guardBash(proj, jump).code).toBe(2);
    expect(guardBash(proj, "bun .claude/tools/aidlc.ts engine recompose --skip build-and-test").code).toBe(0);
    reply(proj, "/aidlc --stage nfr-requirements");
    expect(namedCommands(next(proj, ["--stage", "nfr-requirements"]))).toContain(jump);
    const verdict = guardBash(proj, jump);
    expect(verdict.code, verdict.stderr).toBe(0);
    expect(guardBash(proj, "bun .claude/tools/aidlc.ts engine recompose --skip build-and-test --scope feature").code).toBe(0);
    expect(guardWrite(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
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
    expect(planApprovalAskIsOpen(proj)).toBe(true);
    reply(proj, "approve the plan, but let's stop there for today");
    const said = answer(proj, "Approve Plan", ["--park"]);
    expect(said.code, said.message).toBe(0);
    expect(auditText(proj)).toContain("**Person Reply**: approve the plan, but let's stop there for today");
  });

  // Skipping Code Generation itself while its plan waits: the skip the engine
  // names gets through and runs, the plan question goes with the stage, and the
  // work goes on to Build and Test without asking about the plan again.
  test("a skip of Code Generation while its plan waits is carried out, and the plan is not asked about again", () => {
    const proj = project("strict");
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace("- [ ] code-generation", "- [-] code-generation"), "utf-8");
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    askFor(proj);
    reply(proj, "/aidlc --skip code-generation");
    const named = next(proj, ["--skip", "code-generation"]);
    const commands = namedCommands(named);
    expect(commands.some((command) => command.includes("engine recompose")), JSON.stringify(named)).toBe(false);
    const skip = commands.find((command) => command.includes("report --stage code-generation --result skipped"));
    expect(skip, JSON.stringify(named)).toBeDefined();
    const verdict = guardBash(proj, skip as string);
    expect(verdict.code, `${skip}\n${verdict.stderr}`).toBe(0);
    const reason = /--reason '([^']*)'/.exec(skip as string)?.[1];
    const skipped = spawnSync(BUN, [
      join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), "report", "--stage", "code-generation",
      "--result", "skipped", "--reason", String(reason), "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(skipped.status, `${skipped.stdout}${skipped.stderr}`).toBe(0);
    expect(readFileSync(file, "utf-8")).toContain("- [S] code-generation");
    expect(planApprovalAskIsOpen(proj)).toBe(false);
    for (let turn = 0; turn < 2; turn++) {
      const after = next(proj);
      expect(after.kind, JSON.stringify(after)).toBe("run-stage");
      expect(after.stage).toBe("build-and-test");
    }
  });

  // A scope or setting change asked for while the plan waits, alone or with a
  // skip: each step the engine names runs, and the plan question is still the
  // open step, answered with the person's words. A new scope tests the plan
  // its own way, so its answer names the plan's Testing Contract to render
  // again first.
  test.each([
    ["a scope change", "/aidlc --scope feature", ["--scope", "feature"], false],
    ["a depth change", "/aidlc --depth minimal", ["--depth", "minimal"], true],
    ["a review change", "/aidlc --review advisory", ["--review", "advisory"], true],
    [
      "a setting change with a skip",
      "/aidlc --depth minimal --skip feedback-optimization",
      ["--depth", "minimal", "--skip", "feedback-optimization"],
      true,
    ],
  ] as const)("%s while the plan waits runs, and the plan question stays open", (_label, typed, args, planCurrent) => {
    const proj = waitingPlan();
    // The setters read the plan's scope from the installed tree.
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    reply(proj, typed);
    const named = next(proj, [...args]);
    const commands = namedCommands(named);
    expect(commands.length, JSON.stringify(named)).toBeGreaterThan(0);
    for (const command of commands) {
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
      runInstalled(proj, command);
    }
    expect(planApprovalAskIsOpen(proj)).toBe(true);
    reply(proj, "approve the plan, but let's stop there for today");
    const said = answer(proj, "Approve Plan", ["--park"]);
    expect(said.code, said.message).toBe(0);
    expect(said.recorded).toBe("approve");
    if (planCurrent) {
      expect(auditText(proj)).toContain("**Person Reply**: approve the plan, but let's stop there for today");
    } else {
      expect(said.message).toContain("Testing Contract");
    }
  });

  // "From here on, stop after each Unit" while the plan waits: the agent runs
  // the Construction setter, says its line and keeps the plan question open, so
  // the person's next "approve" is kept as their answer to that question.
  test.each([
    ["checkpoints on", "from here on, stop after each Unit so I can look", ["set-construction-checkpoints enabled"]],
    ["checkpoints off", "no need to stop after each Unit", ["set-construction-checkpoints disabled"]],
    ["one Unit at a time", "build them one at a time", ["set-construction-iteration unit-major"]],
    ["stage by stage", "do it stage by stage across the Units", ["set-construction-iteration stage-major"]],
    [
      "checkpoints on and serial execution",
      "stop after each Unit, and run them one after another",
      ["set-construction-checkpoints enabled", "set-construction-execution serial"],
    ],
  ] as const)("a Construction setting (%s) while the plan waits keeps the plan question open", (_label, typed, setters) => {
    const proj = waitingPlan();
    reply(proj, typed);
    for (const setter of setters) {
      const command = `bun .claude/tools/aidlc.ts engine state ${setter}`;
      const verdict = guardBash(proj, command);
      expect(verdict.code, `${command}\n${verdict.stderr}`).toBe(0);
      runInstalled(proj, command);
    }
    expect(planApprovalAskIsOpen(proj)).toBe(true);
    reply(proj, "approve");
    const said = answer(proj, "Approve Plan");
    expect(said.code, said.message).toBe(0);
    expect(said.recorded).toBe("approve");
  });

  // "Use bun test to check each Unit" while the plans wait: the person approves
  // the command in the agent's question box, the agent records and applies it,
  // and the plan question is still the open step, so their next "approve both
  // plans" is kept as their answer to it.
  test("a verification command approved while the plans wait keeps the plan question open", () => {
    const { pd } = groupedProject();
    const tool = (name: string, args: string[]): void => {
      const run = spawnSync(BUN, [join(AIDLC_SRC, "tools", name), ...args, "--project-dir", pd], {
        cwd: pd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: pd, AIDLC_PROJECT_DIR: pd, AIDLC_UNATTENDED: "0" },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(run.status, `${name} ${args.join(" ")}\n${run.stdout}${run.stderr}`).toBe(0);
    };
    reply(pd, "before you build anything, use bun test as the verification command");
    const question = "Use this command to verify each completed Unit?";
    const route = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "bun test", "--session", SESSION];
    tool("aidlc-log.ts", ["decision", ...route, "--decision", question, "--options", "Approve,Request Changes"]);
    const asked = [{
      question, header: "Command", multiSelect: false,
      options: [{ label: "Approve", description: "" }, { label: "Request Changes", description: "" }],
    }];
    const picked = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
      cwd: pd,
      input: JSON.stringify({
        hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
        tool_input: { questions: asked },
        tool_response: { questions: asked, answers: { [question]: "Approve" } },
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: pd, AIDLC_PROJECT_DIR: pd, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(picked.status, picked.stderr).toBe(0);
    tool("aidlc-log.ts", ["answer", ...route, "--details", "Approve"]);
    tool("aidlc-state.ts", ["set-construction-verification-command", "bun test"]);
    expect(planApprovalAskIsOpen(pd)).toBe(true);
    reply(pd, "approve both plans");
    const said = answer(pd, "Approve all");
    expect(said.code, said.message).toBe(0);
    expect(said.recorded).toBe("approve");
  });

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
      replyAndRecord(proj, "1", "Approve Plan");
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

  // Under strict the person can still have the plan built, on their own word:
  // they say so however they like, after they were told why it cannot be
  // checked, and the agent records it with their words on the record. There is
  // no sentence to type.
  function writeBuildAnyway(proj: string, reason: string): void {
    const tags = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), "fingerprint", "--stage-level", "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(tags.status, tags.stderr).toBe(0);
    writeFileSync(
      join(stageDir(proj), "code-generation-questions.md"),
      `## Plan Approval\n${tags.stdout.trim()}\nA. Approve Plan\nB. Request Changes\n[Answer]: Approve Plan\n`,
      "utf-8",
    );
    writeFileSync(join(stageDir(proj), "override-reason.txt"), `${reason}\n`, "utf-8");
  }

  function buildAnyway(proj: string, env: Record<string, string> = {}): { status: number | null; out: string } {
    const result = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
      "--stage-level", "--session", SESSION, "--questions-file", join(stageDir(proj), "code-generation-questions.md"),
      "--details", "Approve Plan", "--override-file", join(stageDir(proj), "override-reason.txt"), "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", ...env },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  function auditBlock(proj: string, event: string): string | undefined {
    return auditText(proj).split("\n---\n").find((block) => block.includes(`**Event**: ${event}`));
  }

  test("strict: the refusal says they can have it built anyway, and their own words do it", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      const stopped = next(proj);
      expect(stopped.kind, JSON.stringify(stopped)).toBe("error");
      expect(stopped.message).toContain("built anyway");
      expect(stopped.message).not.toContain("type exactly");
      expect(stopped.message).not.toContain("Override Plan Approval:");
      reply(proj, "build it anyway, that folder is a dev mount");
      writeBuildAnyway(proj, "that folder is a dev mount");
      const built = buildAnyway(proj);
      expect(built.status, built.out).toBe(0);
      // The receipt prints no line for the person; the record keeps the override.
      expect(built.out).not.toContain("Recorded that you approved building this plan with no check of the project's files.");
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toContain("**Person Reply**: build it anyway, that folder is a dev mount");
      const recorded = auditBlock(proj, "PLAN_APPROVAL_RECORDED");
      expect(recorded).toContain("**Override**: yes");
      expect(recorded).toContain("**Person Reply**: build it anyway, that folder is a dev mount");
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
    });
  });

  test("strict: without a reply of theirs since the refusal nothing is recorded, and the line says to ask them", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      // Words from before they were told are no answer to it.
      reply(proj, "build it anyway");
      expect(next(proj).kind).toBe("error");
      writeBuildAnyway(proj, "the folder is a dev mount");
      const refused = buildAnyway(proj);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("end the turn");
      expect(refused.out).not.toContain("type exactly");
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toBeUndefined();
      expect(auditBlock(proj, "PLAN_APPROVAL_RECORDED")).toBeUndefined();
      // The refusal shown again does not move past their next reply.
      expect(next(proj).kind).toBe("error");
      reply(proj, "fine, build it anyway");
      expect(next(proj).kind).toBe("error");
      const built = buildAnyway(proj);
      expect(built.status, built.out).toBe(0);
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toContain("**Person Reply**: fine, build it anyway");
    });
  });

  test("strict: one reply has the plan built once", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      expect(next(proj).kind).toBe("error");
      reply(proj, "go ahead and build it anyway");
      writeBuildAnyway(proj, "go ahead");
      expect(buildAnyway(proj).status).toBe(0);
      const again = buildAnyway(proj);
      expect(again.status).not.toBe(0);
      expect(auditText(proj).split("**Event**: PLAN_APPROVAL_OVERRIDDEN").length).toBe(2);
    });
  });

  test("strict: a pick in a question box after the refusal has it built, with the pick on the record", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      expect(next(proj).kind).toBe("error");
      const asked = [{
        question: "How do you want to go on?", header: "Plan", multiSelect: false,
        options: [{ label: "Build it anyway", description: "" }, { label: "Fix the files first", description: "" }],
      }];
      const picked = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
        cwd: proj,
        input: JSON.stringify({
          hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
          tool_input: { questions: asked },
          tool_response: { questions: asked, answers: { "How do you want to go on?": "Build it anyway" } },
        }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(picked.status, picked.stderr).toBe(0);
      writeBuildAnyway(proj, "Build it anyway");
      const built = buildAnyway(proj);
      expect(built.status, built.out).toBe(0);
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toContain("**Person Reply**: Build it anyway");
    });
  });

  test("strict: a message that starts with the old override sentence is a reply like any other", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      expect(next(proj).kind).toBe("error");
      reply(proj, "Override Plan Approval: the walk is broken here");
      const turn = auditBlock(proj, "HUMAN_TURN");
      expect(turn).not.toContain("**Reply**: command");
      writeBuildAnyway(proj, "the walk is broken here");
      const built = buildAnyway(proj);
      expect(built.status, built.out).toBe(0);
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toContain("**Person Reply**: Override Plan Approval: the walk is broken here");
    });
  });

  test("an unattended run has no person to ask, and the line says so", () => {
    const proj = project("strict");
    unreadable(() => {
      // The plan step comes first, as in a run: the plan is written to it.
      expect(next(proj).plan_approval.status).toBe("plan");
      writePlan(proj);
      expect(next(proj).kind).toBe("error");
      const prompt = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
        cwd: proj,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: "build it anyway" }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "1" },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(prompt.status, prompt.stderr).toBe(0);
      writeBuildAnyway(proj, "unattended");
      const refused = buildAnyway(proj, { AIDLC_UNATTENDED: "1" });
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain("AIDLC_UNATTENDED=1 is set");
      expect(auditBlock(proj, "PLAN_APPROVAL_OVERRIDDEN")).toBeUndefined();
    });
  });

  // Starting the build of a plan approved before its files stopped being
  // readable names the repair and the next step. It offers no override:
  // `next` says how to go on, and is where the person hears it.
  test("strict: generation start on files that cannot be read says to repair them and run next", () => {
    const proj = project("strict");
    askFor(proj);
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    unreadable(() => {
      const begun = posture(proj, "begin", null);
      expect(begun.status).not.toBe(0);
      expect(begun.stderr).toContain("then run next");
      expect(begun.stderr).not.toContain("retry generation");
      expect(begun.stderr).not.toContain("Override Plan Approval");
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
    let park = "bun .claude/tools/aidlc.ts engine orchestrate park --person-asked";
    if (how === "typed") {
      const named = next(proj, ["park"]);
      expect(named.kind, JSON.stringify(named)).toBe("print");
      park = /Run `([^`]+ park --person-asked)`/.exec(named.message ?? "")?.[1] ?? "";
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

  // #3227: work parked at Code Generation is not being built, so the person's
  // other work in the project goes on under every Guard Policy, before and
  // after `next` says it is parked; the files the plan names and its developer
  // wait for the resume.
  test.each([
    ["at the plan question", "strict"],
    ["at the plan question", "relaxed"],
    ["after approval", "strict"],
    ["after approval", "off"],
  ] as const)("parked %s, other work in the project goes on and the plan's own files wait (%s)", (when, policy) => {
    const proj = project(policy);
    cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
    askFor(proj);
    if (when === "after approval") {
      reply(proj, "Approve the plan, but let's stop there for today");
      expect(answer(proj, "Approve Plan", ["--park"]).message).toContain("parked");
    } else {
      reply(proj, "let's stop here for today");
      const park = "bun .claude/tools/aidlc.ts engine orchestrate park --person-asked";
      expect(JSON.parse(runInstalled(proj, park)).kind).toBe("parked");
    }
    const otherWorkGoesOn = (point: string): void => {
      for (const command of [
        `python3 -c "open('notes.txt','w').write('x')"`,
        // The commit the way the agent writes one, its message in a here-document.
        "git commit -m \"$(cat <<'EOF'\nanother feature\nEOF\n)\"",
        "printf x > src/other.ts",
      ]) {
        const result = guardBash(proj, command);
        expect(result.code, `${point}: ${command}\n${result.stderr}`).toBe(0);
      }
      const edit = guardWrite(proj, join(proj, "src", "inline.ts"));
      expect(edit.code, `${point}\n${edit.stderr}`).toBe(0);
      const planned = guardWrite(proj, join(proj, "src", "slugify.ts"));
      expect(planned.code, point).toBe(2);
      expect(planned.stderr, point).toContain(" next`");
      expect(guardDispatch(proj, "AIDLC-STAGE: code-generation\n").code, point).toBe(2);
    };
    otherWorkGoesOn("parked");
    expect(next(proj).kind).toBe("parked");
    otherWorkGoesOn("after next says parked");
  });

  // A built Unit's files are not the parked build: with unit-a built and the
  // work parked at unit-b's Code Generation, a file only unit-a's plan names is
  // the person's other work, as it is at unit-b's plan question; unit-b's own
  // file and the developer wait for the resume.
  test.each(["at the plan question", "after approval"] as const)(
    "parked %s of a later Unit, a file only a built Unit's plan names goes on and the parked Unit's waits",
    (when) => {
      const proj = unitProject("unit-a", "unit-b");
      cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
      const state = seededStateFile(proj);
      writeFileSync(state, readFileSync(state, "utf-8")
        .replace("## Scope Configuration", "## Runtime State\n- **Revision Count**: 0\n\n## Scope Configuration")
        .replace("### CONSTRUCTION PHASE", "### INCEPTION PHASE\n- [x] units-generation \u2014 EXECUTE\n\n### CONSTRUCTION PHASE"));
      writePlan(proj, "", "unit-a", "src/a.ts");
      expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
      replyAndRecord(proj, "1", "Approve Plan");
      expect(next(proj)).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
      runInstalled(proj, "bun .claude/tools/aidlc-state.ts unit start --stage code-generation --unit unit-a");
      expect(next(proj)).toMatchObject({ kind: "run-stage", unit: "unit-a" });
      writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n");
      for (const name of ["code-summary", "traceability"]) {
        writeFileSync(join(stageDir(proj, "unit-a"), artifactFilename(name)), `# ${name}\nBuilt unit-a.\n`);
      }
      const stage = findStageBySlug("code-generation")!;
      const fields = {
        Stage: stage.slug, Unit: "unit-a", Reviewer: stage.reviewer!, Iteration: "1",
        "Artifact Fingerprint": reviewArtifactFingerprint(proj, stage, "unit-a")!,
      };
      appendAuditEntry("REVIEW_REQUESTED", fields, proj);
      appendAuditEntry("REVIEW_COMPLETED", { ...fields, Verdict: "READY" }, proj);
      next(proj);
      runInstalled(proj, "bun .claude/tools/aidlc-state.ts unit complete --stage code-generation --unit unit-a");
      expect(unitCompletedReceipts(proj, "code-generation").has("unit-a")).toBe(true);
      expect(next(proj)).toMatchObject({ kind: "run-stage", unit: "unit-b", plan_approval: { status: "plan" } });
      writePlan(proj, "", "unit-b", "src/b.ts");
      expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
      if (when === "after approval") {
        reply(proj, "Approve the plan, but let's stop there for today");
        expect(answer(proj, "Approve Plan", ["--park"]).message).toContain("parked");
      } else {
        reply(proj, "let's stop here for today");
        expect(JSON.parse(runInstalled(proj, "bun .claude/tools/aidlc.ts engine orchestrate park --person-asked")).kind)
          .toBe("parked");
      }
      const builtUnitsFilesGoOn = (point: string): void => {
        const built = guardWrite(proj, join(proj, "src", "a.ts"));
        expect(built.code, `${point}\n${built.stderr}`).toBe(0);
        const parked = guardWrite(proj, join(proj, "src", "b.ts"));
        expect(parked.code, point).toBe(2);
        expect(parked.stderr, point).toContain(" next`");
        expect(guardDispatch(proj, "AIDLC-UNIT: unit-b\n").code, point).toBe(2);
      };
      builtUnitsFilesGoOn("parked");
      expect(next(proj).kind).toBe("parked");
      builtUnitsFilesGoOn("after next says parked");
    },
  );
});

// From a live run under production guards: at the plan question the person
// asked "skip plan approval?" and the agent recorded "Approve Plan" from it and
// built the code. No tool reads the question: the hook keeps it whole, marks
// nothing, applies nothing and answers nothing, so the plan question stays open
// for the agent to answer it and offer; the choice, when they make it, is
// recorded from their words.
describe("a question about the switch is no answer to the plan question", () => {
  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, \"skip plan approval?\" records nothing, and the plan question stays open", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "skip plan approval?");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(auditText(proj)).not.toContain("**Event**: QUESTION_ANSWERED");
    expect(auditText(proj)).not.toContain("**Event**: CEREMONY_SET");
    const ask = next(proj);
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    reply(proj, "ok, approve it");
    const approved = answer(proj, "Approve Plan");
    expect(approved.code, approved.message).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });
});

// The conductor's call on #1677's asked form, from the same live run: a
// question about the check turns nothing off, the agent answers it and offers,
// and a yes is the ask. A request, plain or phrased as a question, is done at
// once by the setter the agent runs, naming their message. No tool reads the words.
describe("a question about plan approval turns nothing off; a request does", () => {
  // The setter as the agent runs it under production guards: no presence bypass,
  // naming the message that asked for it (the agent read it).
  function setter(proj: string, message: string): { code: number; out: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", "guard.plan-approval", "off", "--message", message], {
      cwd: proj,
      env,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }
  const offRows = (proj: string) => (auditText(proj).match(/\*\*Event\*\*: (GUARD_DISABLED|CEREMONY_SET)/g) ?? []).length;

  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, \"skip plan approval?\" lowers nothing by itself; a yes to the offer does, with their words", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "skip plan approval?");
    expect(offRows(proj)).toBe(0);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "yes");
    const lowered = setter(proj, turnId(proj));
    expect(lowered.code, lowered.out).toBe(0);
    expect(offRows(proj)).toBeGreaterThan(0);
    expect(auditText(proj)).toContain("**Person Reply**: yes");
  });

  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, a polite request phrased as a question lowers it at once", (policy) => {
    for (const words of ["can you turn plan approval off for this work?", "could we skip plan approval?"]) {
      const proj = project(policy);
      askFor(proj);
      reply(proj, words);
      const lowered = setter(proj, turnId(proj));
      expect(lowered.code, `${words}: ${lowered.out}`).toBe(0);
      expect(auditText(proj)).toContain(`**Person Reply**: ${words}`);
    }
  });

  test.each(["off", "relaxed", "strict"] as const)("under Guard Policy %s, \"skip plan approval for this work\" is done at once by the setter, with their words", (policy) => {
    const proj = project(policy);
    askFor(proj);
    reply(proj, "skip plan approval for this work");
    expect(offRows(proj)).toBe(0);
    const lowered = setter(proj, turnId(proj));
    expect(lowered.code, lowered.out).toBe(0);
    expect(offRows(proj)).toBeGreaterThan(0);
    expect(auditText(proj)).toContain("**Person Reply**: skip plan approval for this work");
    const after = next(proj);
    expect(after.kind === "ask" && after.ask_type === "plan-approval", JSON.stringify(after)).toBe(false);
  });

  // From a live run: the chat opened with `/aidlc`, the plan question came,
  // and "skip plan approval?" turned the check off, because the opening
  // command still read as a request. The person's latest word was a question.
  test("after the chat's opening /aidlc, \"skip plan approval?\" is the person's words and nothing is applied or recorded", () => {
    const proj = project("off");
    reply(proj, "/aidlc");
    askFor(proj);
    reply(proj, "skip plan approval?");
    // A question is the agent's to answer and offer on: the hook marks nothing,
    // nothing is recorded, and the plan question is still open.
    expect(offRows(proj)).toBe(0);
    expect(auditText(proj)).not.toContain("**Event**: QUESTION_ANSWERED");
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("after the chat's opening /aidlc, a request to skip plan approval is still done at once by the setter", () => {
    const proj = project("off");
    reply(proj, "/aidlc");
    askFor(proj);
    reply(proj, "skip plan approval for this work");
    const lowered = setter(proj, turnId(proj));
    expect(lowered.code, lowered.out).toBe(0);
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
      .replace("- [ ] functional-design \u2014 SKIP (bugfix scope)", "- [x] functional-design \u2014 EXECUTE")
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

function approveThroughParts(proj: string, scope: string): Emitted {
  writePlan(proj);
  const ask = next(proj);
  expect(ask.kind, JSON.stringify(ask)).toBe("ask");
  expect(ask.ask_type).toBe("plan-approval");
  expect(ask.plan_approval.targets?.map((target) => target.unit)).toEqual([null]);
  // The person picks Approve Plan, the first choice.
  replyAndRecord(proj, "1", "Approve Plan");
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
    // The plan file is a record and passes while the rules arrive; a source
    // write waits, and the refusal names the part's `continue`.
    expect(guardWrite(proj, join(stageDir(proj), "code-generation-plan.md")).code).toBe(0);
    const early = guardWrite(proj, join(proj, "src", "slugify.ts"));
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
        replyAndRecord(proj, "1", "Approve Plan");
        expect(engineCall(proj, ["next"])).toMatchObject({ kind: "load-steering", part: 1 });
      }
      const park = "bun .claude/tools/aidlc.ts engine orchestrate park";
      const parkAdmitted = guardBash(proj, park);
      expect(parkAdmitted.code, parkAdmitted.stderr).toBe(0);
      expect(JSON.parse(runInstalled(proj, park)).kind).toBe("parked");
      // Parked, a write to a file the plan names waits; the refusal names
      // `next`, and `next --resume` names the unpark, which the guard lets through.
      const parked = guardBash(proj, "printf changed > src/slugify.ts");
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
    replyAndRecord(proj, "1", "Approve Plan");
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

// The Copilot CLI's file tool makes no folders ("Parent directory does not
// exist"), and while the plan waits the guard refuses every PowerShell way of
// making one (New-Item, a variable, python), so on Windows the agent looped and
// then turned plan approval off before the plan question was ever asked. The
// engine makes the plan's folder when it issues the step that writes the plan.
describe("the plan's record folder is there before the plan is written", () => {
  const emptyFolder = (dir: string): void => {
    expect(existsSync(dir), dir).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  };

  test("a bugfix's stage-level plan step, with its rules in parts: the folder is there from the first part", () => {
    const proj = zeroUnitProject("bugfix");
    expect(existsSync(stageDir(proj))).toBe(false);
    const first = engineCall(proj, ["next"]);
    expect(first, JSON.stringify(first)).toMatchObject({ kind: "load-steering", stage: "code-generation", part: 1 });
    emptyFolder(stageDir(proj));
    const planning = continueEachPart(proj, first);
    expect(planning.plan_approval).toEqual({ status: "plan" });
    emptyFolder(stageDir(proj));
    // The plan is one plain file write into it.
    const write = guardWrite(proj, join(stageDir(proj), "code-generation-plan.md"));
    expect(write.code, write.stderr).toBe(0);
  });

  test("a Unit's plan step makes that Unit's folder only", () => {
    const proj = unitProject("unit-a");
    const step = next(proj) as Emitted & { unit?: string };
    expect(step).toMatchObject({ kind: "run-stage", unit: "unit-a", plan_approval: { status: "plan" } });
    emptyFolder(stageDir(proj, "unit-a"));
    expect(existsSync(stageDir(proj))).toBe(false);
  });

  test("a parallel batch's plan step makes each listed Unit's folder", () => {
    const pd = swarmFixture(false);
    // Installed as config installs it, and the person's message reached the
    // hooks, so `next` hands out the batch.
    mkdirSync(join(pd, ".claude"), { recursive: true });
    cpSync(join(AIDLC_SRC, "settings.json"), join(pd, ".claude", "settings.json"));
    reply(pd, "continue");
    const batch = next(pd);
    expect(batch.kind, JSON.stringify(batch)).toBe("invoke-swarm");
    expect(batch.plan_approval.status).toBe("plan");
    for (const unit of GROUP) emptyFolder(codeGenerationRecordDir(pd, unit));
    expect(existsSync(codeGenerationRecordDir(pd, "later"))).toBe(false);
  });

  test("a file where the folder goes, or a link out of the project, leaves the step as it was", () => {
    const blocked = project();
    mkdirSync(dirname(stageDir(blocked)), { recursive: true });
    writeFileSync(stageDir(blocked), "", "utf-8");
    expect(next(blocked).plan_approval).toEqual({ status: "plan" });
    expect(readFileSync(join(hooksHealthDir(blocked), "plan-approval-ask.drops"), "utf-8")).toContain("EEXIST");
    if (process.platform === "win32") return; // A link needs a privilege Windows does not give by default.
    const linked = project();
    const outside = mkdtempSync(join(tmpdir(), "t-plan-folder-outside-"));
    try {
      symlinkSync(outside, join(seededRecordDir(linked), "construction"));
      expect(next(linked).plan_approval).toEqual({ status: "plan" });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a route check makes nothing, and a written plan's folder keeps what it holds", () => {
    const proj = project();
    const probe = runOrchestrateNext(ORCHESTRATE, proj, [], { env: { ...process.env, AIDLC_ROUTE_CHECK: "1" } });
    expect(probe.directive).toMatchObject({ kind: "run-stage", stage: "code-generation" });
    expect(existsSync(stageDir(proj))).toBe(false);
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    emptyFolder(stageDir(proj));
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(readdirSync(stageDir(proj))).toEqual(expect.arrayContaining(["code-generation-plan.md", "unit-test-instructions.md"]));
  });
});

// A setting typed over the step in hand. A live run (Claude Code, 2026-10-11)
// typed "turn the specialist reviewers off for the rest of this work" while
// Code Generation was planning; the setting's state write retired the issued
// step (its state digest no longer matched), so the guard refused the plan
// write twice with "no matching v2 code-generation active directive" until a
// fresh `next`. The step stays current over the write, as it does over
// set-autonomy: a setting changes how the step runs, not which step it is.
describe("a setting typed over the step in hand keeps that step current", () => {
  // The setter `config set <key> <value>` runs (the dispatcher routes it here).
  const configSet = (proj: string, key: string, value: string): string => {
    const result = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "config-change", `--${key}`, value, "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return result.stdout ?? "";
  };
  const stateOf = (proj: string): string => readFileSync(seededStateFile(proj), "utf-8");
  const planFile = (proj: string): string => {
    mkdirSync(stageDir(proj), { recursive: true });
    return join(stageDir(proj), "code-generation-plan.md");
  };

  test("while the plan is written: the plan write still goes through after the setting", () => {
    const proj = project();
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    expect(readActiveDirectiveMarker(proj, stateOf(proj))?.kind).toBe("run-stage");
    expect(guardWrite(proj, planFile(proj)).code).toBe(0);
    configSet(proj, "review", "none");
    expect(stateOf(proj)).toContain("- **Review Override**: none");
    const kept = readActiveDirectiveMarker(proj, stateOf(proj));
    expect(kept?.kind).toBe("run-stage");
    expect(kept?.stage).toBe("code-generation");
    const write = guardWrite(proj, planFile(proj));
    expect(write.code, write.stderr).toBe(0);
    expect(write.stderr).not.toContain("no matching v2 code-generation active directive");
  });

  test("after approval, with the build issued: a source write goes through, and the review the setting turned off is refused", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "yes");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
    const source = join(proj, "src", "slugify.ts");
    expect(guardWrite(proj, source).code).toBe(0);
    configSet(proj, "review", "none");
    const write = guardWrite(proj, source);
    expect(write.code, write.stderr).toBe(0);
    // The step in hand was issued with a reviewer; the tool, not the directive,
    // decides a review: under none its budget is 0.
    const review = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-log.ts"), "review", "--stage", "code-generation",
      "--reviewer", "aidlc-architecture-reviewer-agent", "--iteration", "1", "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(review.status).not.toBe(0);
    expect(`${review.stdout}${review.stderr}`).toContain("REVIEW_BUDGET_EXHAUSTED");
  });

  test("the Guard Policy the person typed keeps the step too, with no plan question open", () => {
    const proj = project("strict");
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    expect(planApprovalAskIsOpen(proj)).toBe(false);
    // Their line changes nothing by itself; the setter the agent runs for it
    // does, and the step in hand is still the step after it.
    reply(proj, "/aidlc --guard-policy relaxed");
    expect(stateOf(proj)).toContain("- **Guard Policy**: strict");
    configSet(proj, "guard-policy", "relaxed");
    expect(stateOf(proj)).toContain("- **Guard Policy**: relaxed (set by you)");
    const kept = readActiveDirectiveMarker(proj, stateOf(proj));
    expect(kept?.kind).toBe("run-stage");
    expect(guardWrite(proj, planFile(proj)).code).toBe(0);
  });
});

// The governance protocol writes a phase-boundary verification report
// (<record>/verification/<boundary>-verification.md) as the next phase begins.
// A Codex run wrote the Inception->Construction one while Code Generation was
// planning and the guard refused it as a workspace path ("Blocked by hook" on
// the person's screen). It is AI-DLC's own record of a check, not source and
// not a plan-bound file: admitted while the Code Generation step is current,
// under the stage diary's fences. Source still waits for the approval.
describe("the phase-boundary verification report is written while the plan is", () => {
  const report = (proj: string, drive: "same" | "flipped" = "same"): string => {
    const target = join(seededRecordDir(proj), "verification", "inception-construction-verification.md");
    if (drive === "same") return target;
    return target.replace(/^([A-Za-z]):/, (_m, letter: string) =>
      `${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}:`);
  };

  test("a Write under <record>/verification/ goes through at the planning step; a source write still waits", () => {
    const proj = project();
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    const write = guardWrite(proj, report(proj));
    expect(write.code, write.stderr).toBe(0);
    const source = guardWrite(proj, join(proj, "src", "other.ts"));
    expect(source.code).toBe(2);
    expect(source.stderr).toContain("Code generation cannot modify workspace paths for the zero-Unit stage-level implementation");
    expect(source.stderr).toContain("Writes inside the selected code-generation record directory remain available for planning.");
    // The state and the engine's control files are not a report.
    expect(guardWrite(proj, join(seededRecordDir(proj), "verification", "..", "aidlc-state.md")).code).toBe(2);
  });

  // VS Code hosts report c:\ where the project dir carries C:; the drive letter
  // is folded, as the stage diary's is, so the same folder is the same folder.
  test.skipIf(process.platform !== "win32")("on Windows the report spelled with the other drive-letter case is the same folder", () => {
    const proj = project();
    expect(next(proj).plan_approval).toEqual({ status: "plan" });
    const write = guardWrite(proj, report(proj, "flipped"));
    expect(write.code, write.stderr).toBe(0);
  });
});

// #2551: the router's receipt recovery must survive the actual PreToolUse
// boundary, including a state write that legitimately retires its old marker.
describe("Code Generation receipt recovery through the Plan Approval hook", () => {
  function readyUnit(unitMajor = false): string {
    const proj = unitProject("unit-a", "unit-b");
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace(
      "- **Guard Policy**: relaxed (set by you)", "- **Guard Policy**: strict (set by you)",
    ).replace(
      "## Scope Configuration", "## Runtime State\n- **Revision Count**: 0\n\n## Scope Configuration",
    ).replace(
      "### CONSTRUCTION PHASE", "### INCEPTION PHASE\n- [x] units-generation — EXECUTE\n\n### CONSTRUCTION PHASE",
    ));
    if (unitMajor) {
      writeFileSync(state, readFileSync(state, "utf-8")
        .replace("## Runtime State", "## Runtime State\n- **Construction Iteration**: unit-major")
        .replace(/^- \[x\] (functional-design|nfr-requirements|nfr-design|infrastructure-design)/gm, "- [S] $1"));
    }
    writePlan(proj, "", "unit-a");
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    replyAndRecord(proj, "1", "Approve Plan");
    expect(next(proj)).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
    const start = `bun .claude/tools/aidlc-state.ts unit start --stage code-generation --unit unit-a`;
    expect(guardBash(proj, start).code).toBe(0);
    runInstalled(proj, start);
    expect(next(proj)).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
    const source = join(proj, "src", "slugify.ts");
    const write = guardWrite(proj, source);
    expect(write.code, write.stderr).toBe(0);
    writeFileSync(source, "export const slugify = (title: string) => title.toLowerCase();\n");

    for (const name of ["code-summary", "traceability"]) {
      writeFileSync(join(stageDir(proj, "unit-a"), artifactFilename(name)), `# ${name}\nBuilt unit-a.\n`);
    }
    const stage = findStageBySlug("code-generation")!;
    const fields = {
      Stage: stage.slug, Unit: "unit-a", Reviewer: stage.reviewer!, Iteration: "1",
      "Artifact Fingerprint": reviewArtifactFingerprint(proj, stage, "unit-a")!,
    };
    appendAuditEntry("REVIEW_REQUESTED", fields, proj);
    appendAuditEntry("REVIEW_COMPLETED", { ...fields, Verdict: "READY" }, proj);
    return proj;
  }

  function codexGuard(proj: string, command: string, toolUseId: string): ReturnType<typeof spawnSync> {
    return spawnSync(BUN, [join(REPO_ROOT, "dist", "codex", ".codex", "hooks", "aidlc-codex-adapter.ts"), "plan-approval-guard"], {
      cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_use_id: toolUseId,
        tool_name: "Bash", tool_input: { command } }),
      env: { ...process.env, AIDLC_PROJECT_DIR: proj, CLAUDE_PROJECT_DIR: proj, AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0" },
    });
  }

  for (const unitMajor of [false, true]) {
    test(`${unitMajor ? "unit-major" : "stage-major"}: next refreshes retired authority before its exact receipt command is guarded`, () => {
      const proj = readyUnit(unitMajor);
      reply(proj, "Use scope-dependent skeleton stance");
      runInstalled(proj, "bun .claude/tools/aidlc-state.ts set-skeleton-stance scope-dependent");
      expect(readActiveDirectiveMarker(proj, readFileSync(seededStateFile(proj), "utf-8"))).toBeNull();
      const complete = "bun .claude/tools/aidlc-state.ts unit complete --stage code-generation --unit unit-a";
      // A Unit's completion is the engine's own command, before `next` as
      // after: `unit complete` judges the Unit's approved plan itself.
      const early = guardBash(proj, complete);
      expect(early.code, early.stderr).toBe(0);
      expect(early.stderr).toBe("");
      // To the Codex tree's guard the `.claude` spelling is no installed command
      // of its own, so the build's check holds it until `next` refreshes the step.
      const staleCodex = codexGuard(proj, complete, "before-next");
      expect(staleCodex.status, String(staleCodex.stderr)).toBe(2);
      const probe = runOrchestrateNext(ORCHESTRATE, proj, [], {
        env: { ...process.env, AIDLC_ROUTE_CHECK: "1" },
      });
      expect(probe.directive).toMatchObject({ kind: "run-stage", unit: "unit-a" });
      expect(readActiveDirectiveMarker(proj, readFileSync(seededStateFile(proj), "utf-8"))).toBeNull();
      const recovered = next(proj) as Emitted & { unit_record_step?: string; gate_note?: string };
      const admitted = guardBash(proj, complete);
      expect(admitted.code, admitted.stderr).toBe(0);
      expect(recovered).toMatchObject({ kind: "run-stage", stage: "code-generation", plan_approval: { status: "approved" } });
      expect(recovered.unit_record_step).toContain(complete);
      expect(recovered.gate_note).toBe(recovered.unit_record_step);
      expect(recovered).toMatchObject({ mode: "inline" });
      expect(recovered).not.toHaveProperty("plan_note");
      expect(recovered.narration ?? "").not.toContain("Building");
      const codex = codexGuard(proj, complete, "after-next");
      expect(codex.status, String(codex.stderr)).toBe(0);
      // The state command still owns Unit/artifact admission; another Unit has
      // neither the outputs nor its review and cannot borrow this recovery.
      const other = spawnSync(BUN, [STATE, "unit", "complete", "--stage", "code-generation", "--unit", "unit-b", "--project-dir", proj], {
        cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        env: { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "0" },
      });
      expect(other.status, other.stderr).not.toBe(0);
      expect(unitCompletedReceipts(proj, "code-generation").has("unit-b")).toBe(false);
      next(proj);
      runInstalled(proj, complete);
      expect(unitCompletedReceipts(proj, "code-generation").has("unit-a")).toBe(true);
      expect(JSON.stringify(next(proj))).not.toContain("completion is not recorded");
    });

  }

  for (const missing of [true, false]) {
    test(`${missing ? "a missing artifact" : "a stale review"} keeps the normal work step`, () => {
      const proj = readyUnit();
      const summary = join(stageDir(proj, "unit-a"), "code-summary.md");
      if (missing) rmSync(summary);
      else writeFileSync(summary, "# Code summary\nChanged after review.\n");
      const routed = next(proj);
      expect(routed).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
      expect(routed).not.toHaveProperty("unit_record_step");
      if (missing) {
        const result = spawnSync(BUN, [STATE, "unit", "complete", "--stage", "code-generation", "--unit", "unit-a", "--project-dir", proj], {
          cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          env: { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "0", AIDLC_SKIP_REVIEWER_GATE_GUARD: "0" },
        });
        expect(result.status, result.stderr).not.toBe(0);
      }
      expect(unitCompletedReceipts(proj, "code-generation").has("unit-a")).toBe(false);
    });
  }

  test("a changed approved plan routes to approval instead of another refused receipt", () => {
    const proj = readyUnit();
    writeFileSync(join(stageDir(proj, "unit-a"), "code-generation-plan.md"),
      `${readFileSync(join(stageDir(proj, "unit-a"), "code-generation-plan.md"), "utf-8")}\nNew work to approve.\n`);
    // Review the changed files so the receipt-only candidate still exists.
    const stage = findStageBySlug("code-generation")!;
    const fields = { Stage: stage.slug, Unit: "unit-a", Reviewer: stage.reviewer!, Iteration: "2",
      "Artifact Fingerprint": reviewArtifactFingerprint(proj, stage, "unit-a")! };
    appendAuditEntry("REVIEW_REQUESTED", fields, proj);
    appendAuditEntry("REVIEW_COMPLETED", { ...fields, Verdict: "READY" }, proj);
    const recovered = next(proj);
    expect(recovered).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(JSON.stringify(recovered)).not.toContain("unit_record_step");
    // The guard admits the Unit's completion; `unit complete` holds it itself
    // while the changed plan waits for the person.
    const complete = "bun .claude/tools/aidlc-state.ts unit complete --stage code-generation --unit unit-a";
    const admitted = guardBash(proj, complete);
    expect(admitted.code, admitted.stderr).toBe(0);
    expect(admitted.stderr).toBe("");
    const held = spawnSync(BUN, [STATE, "unit", "complete", "--stage", "code-generation", "--unit", "unit-a", "--project-dir", proj], {
      cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    });
    expect(held.status, held.stderr).not.toBe(0);
    expect(held.stderr).toContain("The code plan is not approved yet");
    expect(unitCompletedReceipts(proj, "code-generation").has("unit-a")).toBe(false);
  });
});

// A typed "2" picks Request Changes and says nothing about what to change (on
// Codex the plan was once revised from "2"): the record keeps their "2" as
// their words, names no change, and the revision step has none to hand, so the
// agent asks what should change, once. A change they did say is the agent's
// reading, passed after the choice, and reaches the revision with no question.
describe("what to change is what the person said, as the agent read it", () => {
  const requestChangesRow = (proj: string): string =>
    auditText(proj).split("\n---\n").find((block) =>
      block.includes("**Details**: Request Changes") && block.includes("**Checkpoint**: plan-approval")) ?? "";

  test('a typed "2" records Request Changes with no change named, and the revision asks what should change', () => {
    const proj = project();
    askFor(proj);
    reply(proj, "2");
    const recorded = answer(proj, "Request Changes");
    expect(recorded.code, recorded.message).toBe(0);
    expect(requestChangesRow(proj)).toContain("**Person Reply**: 2");
    expect(requestChangesRow(proj)).not.toContain("**User Input**");
    expect(next(proj).plan_approval).toEqual({ status: "revise" });
  });

  test("a change they asked for, passed after the choice, reaches the revision with their words beside it", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "please add a test for the empty cart");
    const recorded = answer(proj, "Request Changes: add a test for the empty cart");
    expect(recorded.code, recorded.message).toBe(0);
    expect(requestChangesRow(proj)).toContain("**User Input**: add a test for the empty cart");
    expect(requestChangesRow(proj)).toContain("**Person Reply**: please add a test for the empty cart");
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "add a test for the empty cart" });
  });

  test("the stage tells the agent to pass what to change, and to ask when the reply only picked the choice", () => {
    const text = readFileSync(join(AIDLC_SRC, "aidlc-common", "stages", "construction", "code-generation.md"), "utf-8")
      .replace(/\s+/g, " ");
    expect(text).toContain("pass what to change after the choice (`--details 'Request Changes: <what they asked>'`");
    expect(text).toContain("when their reply only picked Request Changes, ask what should change before you record it");
    expect(text).not.toContain("a change request uses them as what to change");
    // Several plans asked about at once: the change that names a Unit goes with it.
    const grouped = readFileSync(join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol-construction.md"), "utf-8")
      .replace(/\s+/g, " ");
    expect(grouped).toContain("record `Request Changes: use Stripe` for that Unit");
  });
});
