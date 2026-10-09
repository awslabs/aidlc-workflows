// covers: subcommand:aidlc-orchestrate:next, function:withdrawRoutedWords, function:withdrawPlanApprovalReplies,
// function:withdrawProtectedReplyWords, audit:REQUEST_ROUTED
//
// Words the person sends to separate new work, or to reshaping the plan, at
// the routing question are no reply to the question the work in progress has
// open. Before, "/aidlc also handle an empty list" typed at a Unit checkpoint,
// a stage gate, a stage's questions or the code plan question stayed kept as
// the reply to it after the person answered "2" (a separate new piece of
// work): an approval of the old question went through on words meant for the
// new work, and a later chat was handed them as the stage's answer. Now the
// engine takes them back from the old question when the person sends them
// elsewhere, so that question waits for a reply of its own. Said to be part of
// the work in progress ("1"), they stay its reply.
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
  personsLatestGatePick,
  readAuditShardEvents,
  readProtectedResponse,
  reviewArtifactFingerprint,
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
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: env(proj) });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

// A command the engine named, run as given: its `next` arguments.
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
function say(proj: string, prompt: string, harness: Harness = "claude", session = SESSION): void {
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
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: "t1", cwd: proj, prompt }),
      { ...unset, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined });
    return;
  }
  run(proj, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), harness === "kiro" ? "verb-intercept" : "record-human-turn"],
    JSON.stringify({ hook_event_name: harness === "kiro" ? "userPromptSubmit" : "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }),
    unset);
}

// Every plan question answer on record: the event and its choice.
function planAnswers(proj: string): string[] {
  return readAuditShardEvents(proj)
    .filter((row) => ["PLAN_APPROVAL_RECORDED", "QUESTION_ANSWERED"].includes(row.event) &&
      auditBlockField(row.block, "Checkpoint") === "plan-approval")
    .map((row) => `${row.event}: ${auditBlockField(row.block, "Details")}`);
}

// The plan question, then the person's change typed with /aidlc, and the
// routing question the print sends it to.
function routingQuestionOverThePlan(proj: string, planQuestionOpen = true): Emitted {
  if (planQuestionOpen) expect(next(proj).ask_type).toBe("plan-approval");
  say(proj, `/aidlc ${CHANGE}`);
  const print = next(proj, [CHANGE]);
  expect(print.kind, JSON.stringify(print)).toBe("print");
  const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(print.message ?? "")?.[1];
  expect(request, print.message).toBeDefined();
  const routing = next(proj, (request as string).split(" "));
  expect(routing.ask_type, JSON.stringify(routing)).toBe("new-work-routing");
  return routing;
}

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

// The check command the person approves, quoted for the shell that runs it here.
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

// The person's change typed with /aidlc in `session`, and the routing question
// the print sends it to.
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

// Feasibility at its approval gate ("Approve Feasibility?"), shown in chat a101.
function gateProject(policy: Policy): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope feature)",
      `${policy === "off" ? "- **Guard Policy**: off (from scope feature)" : "- **Guard Policy**: strict (set by you)"}\n` +
        "- **Summary Confirmation**: off (set by you)"), "utf-8");
  say(proj, "/aidlc");
  expect(next(proj).kind).toBe("run-stage");
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


// The routing question's answer for separate new work, run as it is named.
function sendToNewWork(proj: string, routing: Emitted): void {
  const printed = nextNamed(proj, routing.new_intent_command);
  expect(printed.kind, JSON.stringify(printed)).toBe("print");
}

describe("words sent to separate new work leave the question the work in progress has open", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`${policy}: a stage gate approves only on a reply of its own`, () => {
      const proj = gateProject(policy);
      const routing = routingQuestionOverTheStep(proj);
      say(proj, "2");
      sendToNewWork(proj, routing);
      expect(personsLatestGatePick(proj, SESSION, { stage: "feasibility" })).toBeNull();
      expect(report(proj, "approved", ["--user-input", "Approve"]).out).toContain("no new human reply");
      say(proj, "approve");
      expect(report(proj, "approved", ["--user-input", "Approve"]).out).toContain("Committed approve");
      const approved = readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED");
      expect(approved.map((row) => auditBlockField(row.block, "Person Reply"))).toEqual(["approve"]);
    });

    test(`${policy}: the code plan question keeps none of them as its reply`, () => {
      const proj = project(policy);
      const routing = routingQuestionOverThePlan(proj);
      say(proj, "2");
      sendToNewWork(proj, routing);
      // Back at the work in progress, its plan question is asked again.
      expect(next(proj).ask_type).toBe("plan-approval");
      const refused = spawnSync(BUN, [
        LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
        "--project-dir", proj,
      ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
      expect(refused.status).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).toContain("has not replied");
      expect(planAnswers(proj)).toEqual([]);
    });
  }

  test("a Unit checkpoint keeps none of them, and approves only on a reply of its own", () => {
    const proj = checkpointProject("off");
    askCheckpoint(proj);
    const routing = routingQuestionOverTheStep(proj);
    say(proj, "2");
    sendToNewWork(proj, routing);
    expect(keptReply(proj)).toEqual({ choice: null, words: null });
    expect(engine(proj, ["bolt", "checkpoint", "--action", "approve", "--unit", "alpha", "--kind", "unit", "--user-input", "approve"]).code)
      .not.toBe(0);
  });

  test("codex: a later chat is not handed them as the stage's answer", () => {
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
    const routing = next(proj, (request as string).split(" "));
    expect(routing.ask_type).toBe("new-work-routing");
    say(proj, "2", "codex");
    sendToNewWork(proj, routing);
    const later = next(proj) as Emitted & { kept_replies?: { replies: string[] } };
    expect(later.kind, JSON.stringify(later)).toBe("run-stage");
    expect(later.kept_replies?.replies ?? []).not.toContain(words);
  });
});

describe("words said to be part of the work in progress stay its reply", () => {
  test('"1": the Unit checkpoint keeps them', () => {
    const proj = checkpointProject("off");
    askCheckpoint(proj);
    const routing = routingQuestionOverTheStep(proj);
    say(proj, "1");
    nextNamed(proj, routing.continue_command);
    expect(keptReply(proj)).toEqual({ choice: null, words: "also handle an empty list" });
  });
});
