// The helpers both plan-question test files use (tests/unit/t-plan-approval-ask.test.ts
// and tests/unit/t-plan-approval-ask-surroundings.test.ts): projects at Code
// Generation, and the real tools and hooks (`next`, the human-turn hook, the answer
// log, the plan-approval guard) run on them. Each test file keeps its own
// setDefaultTimeout and the afterEach that cleans up `created` and
// `worktreeFixtures`.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";
import { withCopyLaunchOptions } from "./copy-launch.ts";
import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seedBoltDagBatches,
  seededRecordDir,
  seededStateFile,
  setupWorktreeFixture,
} from "./fixtures.ts";
import {
  codeGenerationRecordDir,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  publishPlanApprovalAsk,
  routeCodeGenerationPlanApproval,
} from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";
import {
  invalidateActiveDirectiveContext,
  planApprovalRuntimeFile,
  auditBlockField,
  readAuditShardEvents,
  stateDigest,
  workspaceSourceListing,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

// The words a command the installed copy tree names starts with, ahead of its tool's file name.
export const COPY_TOOLS = withCopyLaunchOptions("bun .claude/tools/");
export const COPY_TOOLS_PATTERN = COPY_TOOLS.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export const BUN = process.execPath;
export const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
export const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
export const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
export const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
export const SESSION = "01995000-7a11-7000-8000-000000000001";
export const OTHER_SESSION = "01995000-7a11-7000-8000-000000000002";

export interface Emitted {
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

export const created: string[] = [];
export const worktreeFixtures: string[] = [];

export function project(policy: "strict" | "relaxed" | "off" = "relaxed", planApproval: "on" | "off" = "on"): string {
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

export function stageDir(proj: string, unit: string | null = null): string {
  return join(seededRecordDir(proj), "construction", ...(unit ? [unit] : []), "code-generation");
}

export function writePlan(proj: string, extra = "", unit: string | null = null, touches = "src/slugify.ts"): void {
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

export function next(proj: string, args: string[] = []): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, {
    env: { ...process.env, AIDLC_UNATTENDED: "0" },
  });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

export function reply(proj: string, prompt: string, session = SESSION): string {
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
export function turnId(proj: string): string {
  const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1);
  const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
  expect(id).not.toBeNull();
  return id as string;
}

export function answer(
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
export function replyAndRecord(proj: string, typed: string, choice: string, session = SESSION): void {
  reply(proj, typed, session);
  const recorded = answer(proj, choice, [], session === SESSION ? undefined : session);
  expect(recorded.code, recorded.message).toBe(0);
}

export function lower(proj: string, key: string, value: string): { code: number; out: string } {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", key, value, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function guardWrite(proj: string, path: string): { code: number; stderr: string } {
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

export function guardBash(proj: string, command: string): { code: number; stderr: string } {
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
export function runInstalled(proj: string, command: string): string {
  expect(command).toMatch(new RegExp(`^${COPY_TOOLS_PATTERN}[\\w.-]+\\.ts( [\\w-]+)+( --reason '[^']*')?$`));
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

export function resumeNamesUnpark(proj: string): string {
  const resume = next(proj, ["--resume"]);
  expect(resume.kind, JSON.stringify(resume)).toBe("print");
  const command = /Run `([^`]+ unpark)`/.exec(resume.message ?? "")?.[1];
  expect(command, resume.message).toBeDefined();
  return command as string;
}

export function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

export function questions(proj: string, unit: string | null = null): string {
  return readFileSync(join(stageDir(proj, unit), "code-generation-questions.md"), "utf-8");
}

export function askFor(proj: string): Emitted {
  writePlan(proj);
  const directive = next(proj);
  expect(directive.kind, JSON.stringify(directive)).toBe("ask");
  expect(directive.ask_type).toBe("plan-approval");
  return directive;
}

// Code Generation's rules can be too big for one message (large org, team, or
// project memory, or a harness with a small message budget). The build then
// arrives as numbered rule parts the agent fetches one after another. How many
// parts the rules need must never change what the person is asked.
export function withRulesInParts(proj: string): string {
  appendFileSync(
    join(proj, "aidlc", "spaces", "default", "memory", "org.md"),
    Array.from({ length: 180 }, (_, i) => `\n## Team practice ${i}\n\n${"x".repeat(320)}\n`).join(""),
    "utf-8",
  );
  return proj;
}

// A feature workflow at Code Generation, where the plan and build are per Unit.
export function unitProject(...units: string[]): string {
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
export function engineCall(proj: string, args: string[]): Emitted & { part?: number; receipt?: string } {
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
export function nextThroughParts(proj: string): { directive: Emitted; parts: number } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], {
    env: { ...process.env, AIDLC_UNATTENDED: "0" },
  });
  expect(result.status, result.out).toBe(0);
  return { directive: result.directive as unknown as Emitted, parts: result.steering.length };
}

export function posture(
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

export function guardDispatch(proj: string, prompt: string): { code: number; stderr: string } {
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
export function generationStarted(proj: string): boolean {
  const dir = dirname(planApprovalRuntimeFile(proj, "probe"));
  if (!existsSync(dir)) return false;
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .some((name) => /"status":\s*"generation"/.test(readFileSync(join(dir, name), "utf-8")));
}

// After the person approves, the engine may say something else before the
// agent next asks what to do: the chat compacts and the agent must re-read its
// instructions, a guard-recovery question comes up, or the work is paused. None
// of those is a decision about the plan (#1411).
export const INTERRUPTIONS = ["the chat compacts", "a guard-recovery question", "the work is paused"] as const;
export type Interruption = typeof INTERRUPTIONS[number];

export function interrupt(proj: string, how: Interruption): void {
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

// One question for several Units whose plans are ready together (a swarm batch).
export const GROUP = ["alpha", "beta"];

export function swarmFixture(plans: boolean, group: string[] = GROUP, planApproval: "on" | "off" = "on"): string {
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

export function groupedProject(): { pd: string; ask: Emitted } {
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

export function swarmState(pd: string): Emitted {
  writeActiveDirectiveMarker(pd, {
    kind: "invoke-swarm", stage: "code-generation", units: GROUP,
    state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
  });
  return routeCodeGenerationPlanApproval(pd, { kind: "invoke-swarm", stage: "code-generation", units: GROUP }) as unknown as Emitted;
}
