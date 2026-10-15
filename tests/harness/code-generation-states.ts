// code-generation-states.ts - every Code Generation state a person can be in,
// built through the installed tools, and the seven harness shapes of one tool
// call (and of a call to the person's MCP server) against the plan-approval guard.
//
// The no-dead-end sweep (tests/unit/t-code-generation-no-dead-end.test.ts)
// asks, in every state and for every harness: is the person's message kept,
// does `next` hand the agent a step, is that step's own work admitted by the
// guard, does every refusal name a way past the guard admits, and are the
// developer dispatch and a source write refused before the approval and
// admitted after it. The helpers here are the plan-approval ask test's
// (tests/unit/t-plan-approval-ask.test.ts).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDagBatches,
  seededRecordDir,
  seededStateFile,
  setupWorktreeFixture,
} from "./fixtures.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import {
  invalidateActiveDirectiveContext,
  latestPersonTurn,
  readAuditShardEvents,
  stateDigest,
  workspaceSourceListing,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

/** Worktree fixtures a state built; the sweep cleans them with cleanupWorktreeFixtures(). */
const worktreeFixtures: string[] = [];
export function cleanupWorktreeFixtures(): void {
  while (worktreeFixtures.length > 0) cleanupWorktreeFixture(worktreeFixtures.pop()!);
}

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
export const SESSION = "01995000-7a11-7000-8000-00000000c0de";
/** A chat that never ran the opening `next`: it has not joined the work. */
export const UNJOINED_SESSION = "01995000-7a11-7000-8000-00000000beef";

/** The directive fields the sweep reads. */
export interface Step {
  kind: string;
  ask_type?: string;
  stage?: string;
  message?: string;
  question?: string;
  units?: string[];
  remedies?: Array<{ op?: string; action?: string; interaction?: string; command?: string }>;
  plan_approval?: {
    status?: string;
    editing?: boolean;
    skipped?: true;
    feedback?: string;
    targets?: Array<{ unit: string | null; plan_path?: string; questions_path?: string }>;
  };
  [key: string]: unknown;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function env(proj: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", ...extra };
}

function run(proj: string, argv: string[], input?: string, extra: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync(BUN, argv, {
    cwd: proj,
    input,
    env: env(proj, extra),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * A poc project at Code Generation with the Claude tree installed, so a
 * command spelled `bun .claude/tools/...` is the installed engine to the guard.
 * poc ships with plan approval off; the person turned it on unless a state says
 * otherwise.
 */
export function createCodeGenerationProject(
  policy: "strict" | "relaxed" | "off" = "relaxed",
  planApproval: "on" | "off" = "on",
): string {
  const proj = createOrchestrationTestProject();
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
  cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
  return proj;
}

export function stageDir(proj: string, unit: string | null = null): string {
  return join(seededRecordDir(proj), "construction", ...(unit ? [unit] : []), "code-generation");
}

export function writePlan(proj: string, extra = "", unit: string | null = null): void {
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

/** `next`, as the agent runs it; the parsed step, or a throw with the output. */
export function next(proj: string, args: string[] = []): Step {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: env(proj) });
  if (result.status !== 0 || result.directive === null) {
    throw new Error(`next ${args.join(" ")} gave status ${result.status} and no step:\n${result.out}`);
  }
  return result.directive as unknown as Step;
}

/** The person's message, through the real human-turn hook. */
export function reply(proj: string, prompt: string, session = SESSION): RunResult {
  return run(
    proj,
    [DISPATCHER, "engine", "hook", "record-human-turn"],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  );
}

/** What the agent records after reading the person's reply to the plan question. */
export function answer(proj: string, details: string, extra: string[] = []): RunResult {
  return run(proj, [LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--details", details, ...extra, "--project-dir", proj]);
}

/** A command line split into words the way a POSIX shell would, for plain words and single or double quotes. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let open = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      open = true;
    } else if (/\s/.test(ch)) {
      if (word.length > 0 || open) words.push(word);
      word = "";
      open = false;
    } else {
      word += ch;
    }
  }
  if (word.length > 0 || open) words.push(word);
  return words;
}

/** An engine command spelled `bun .claude/tools/... ...`, run as the agent would. */
export function runNamed(proj: string, command: string): RunResult {
  const words = shellWords(command);
  if (words[0] !== "bun") throw new Error(`not an engine command: ${command}`);
  return run(proj, [...words.slice(1)]);
}

export function auditEvents(proj: string) {
  return readAuditShardEvents(proj);
}

/**
 * The person's newest message, whole, as the hook kept it: the newest HUMAN_TURN
 * row names a Message Id, and the message store holds the text as the host
 * delivered it (a flags-only line included). Falls back to the engine's reader
 * of the person's words when the row carries no id.
 */
export function latestHumanTurnWords(proj: string): string | null {
  const rows = auditEvents(proj).filter((row) => row.event === "HUMAN_TURN");
  const last = rows.at(-1);
  if (!last) return null;
  const id = /\*\*Message Id\*\*: ([0-9a-f]{8})/.exec(last.block)?.[1];
  const stored = id ? readMessage(proj, id) : null;
  return stored?.text ?? latestPersonTurn(proj)?.words ?? null;
}

/** Every engine command a text names in backticks, in the tree's own spelling. */
export function namedCommands(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/`((?:bun \.[A-Za-z-]+\/tools\/[^`]+|aidlc [^`]+))`/g)) {
    const command = match[1].trim();
    if (!found.includes(command)) found.push(command);
  }
  return found;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export interface BuiltState {
  proj: string;
  /** The session whose guard calls the sweep makes. */
  session: string;
  /** The plan is approved: the developer dispatch and a source write go through. */
  approved: boolean;
  /** How the state was reached, for the report (a fallback says so here). */
  how: string;
  /** Units the state has plans for (invoke-swarm); null for stage-level work. */
  units?: string[];
}

export interface StateBuilder {
  id: string;
  name: string;
  build(): BuiltState;
}

/** The review a reviewer leaves for a stage, the shape the engine reads (tests/harness/scope-run.ts reviewText). */
function reviewText(reviewer: string): string {
  return `## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n`;
}

function approve(proj: string): void {
  reply(proj, "approve");
  const recorded = answer(proj, "Approve Plan");
  if (recorded.status !== 0) throw new Error(`Approve Plan was not recorded:\n${recorded.stdout}${recorded.stderr}`);
}

function askOpen(proj: string): Step {
  writePlan(proj);
  const step = next(proj);
  if (step.kind !== "ask" || step.ask_type !== "plan-approval") {
    throw new Error(`expected the plan question, got ${JSON.stringify(step)}`);
  }
  return step;
}

export const STATES: StateBuilder[] = [
  {
    id: "S1", name: "plan not yet written",
    build: () => {
      const proj = createCodeGenerationProject();
      const step = next(proj);
      if (step.kind !== "run-stage" || step.plan_approval?.status !== "plan") {
        throw new Error(`expected the planning step, got ${JSON.stringify(step)}`);
      }
      return { proj, session: SESSION, approved: false, how: "next after the state opened at Code Generation" };
    },
  },
  {
    id: "S2", name: "plan written, question not yet asked",
    build: () => {
      const proj = createCodeGenerationProject();
      next(proj);
      writePlan(proj);
      return { proj, session: SESSION, approved: false, how: "the planning step, then the plan and instructions written" };
    },
  },
  {
    id: "S3", name: "the Plan Approval question open",
    build: () => {
      const proj = createCodeGenerationProject();
      next(proj);
      askOpen(proj);
      return { proj, session: SESSION, approved: false, how: "next asked the plan question" };
    },
  },
  {
    id: "S4", name: "answered approve",
    build: () => {
      const proj = createCodeGenerationProject();
      next(proj);
      askOpen(proj);
      approve(proj);
      const step = next(proj);
      if (step.kind !== "run-stage" || step.plan_approval?.status !== "approved") {
        throw new Error(`expected the build step, got ${JSON.stringify(step)}`);
      }
      return { proj, session: SESSION, approved: true, how: "reply approve, Approve Plan recorded, next hands over the build" };
    },
  },
  {
    id: "S5", name: "answered Request changes",
    build: () => {
      const proj = createCodeGenerationProject();
      next(proj);
      askOpen(proj);
      reply(proj, "rename slugify to toSlug");
      const recorded = answer(proj, "Request Changes");
      if (recorded.status !== 0) throw new Error(`Request Changes was not recorded:\n${recorded.stdout}${recorded.stderr}`);
      const step = next(proj);
      if (step.kind !== "run-stage" || step.plan_approval?.status !== "revise") {
        throw new Error(`expected the revise step, got ${JSON.stringify(step)}`);
      }
      return { proj, session: SESSION, approved: false, how: "Request Changes recorded, next hands back the plan to revise" };
    },
  },
  {
    id: "S6", name: "the person editing the plan files themselves",
    build: () => {
      const proj = createCodeGenerationProject();
      next(proj);
      askOpen(proj);
      reply(proj, "I'll edit the files");
      const step = next(proj);
      if (step.kind !== "ask" || step.plan_approval?.editing !== true) {
        throw new Error(`expected edit mode, got ${JSON.stringify(step)}`);
      }
      return { proj, session: SESSION, approved: false, how: "reply I'll edit the files, next shows edit mode" };
    },
  },
  {
    id: "S6b", name: "the person edited the plan files, then handed them back",
    build: () => {
      const proj = createCodeGenerationProject();
      next(proj);
      askOpen(proj);
      reply(proj, "I'll edit the files");
      next(proj);
      reply(proj, "you finish it");
      return { proj, session: SESSION, approved: false, how: "edit mode, then the person said: you finish it" };
    },
  },
  {
    id: "S7", name: "plan approval off for this work",
    build: () => {
      const proj = createCodeGenerationProject("relaxed", "off");
      next(proj);
      writePlan(proj);
      const step = next(proj);
      if (step.kind !== "run-stage" || step.plan_approval?.status !== "approved") {
        throw new Error(`expected the build without asking, got ${JSON.stringify(step)}`);
      }
      return { proj, session: SESSION, approved: true, how: "scope poc has plan approval off; next builds without asking" };
    },
  },
  {
    id: "S8", name: "Guard Policy strict, the plan changed after approval",
    build: () => {
      const proj = createCodeGenerationProject("strict");
      next(proj);
      askOpen(proj);
      approve(proj);
      next(proj);
      writePlan(proj, "- [ ] Step 2: handle unicode\n");
      const step = next(proj);
      if (step.kind !== "ask" || step.ask_type !== "plan-approval") {
        throw new Error(`expected the plan asked about again, got ${JSON.stringify(step)}`);
      }
      return { proj, session: SESSION, approved: false, how: "approved, then the plan edited under strict: next asks again" };
    },
  },
  {
    id: "S9", name: "a recovery question left behind while the plan waits",
    build: () => {
      // The engine issues its recovery question from a guard's refusal routed
      // through `next`; no installed-tool route reaches one at Code Generation
      // in this harness (a denied completion here is an error, not an ask), so
      // the question is written as the engine writes it, over the open plan
      // question. The sweep's own `next` then shows what the engine does with a
      // recovery question left behind: that is the state a person meets.
      const proj = createCodeGenerationProject();
      next(proj);
      askOpen(proj);
      const state = readFileSync(seededStateFile(proj), "utf-8");
      writeActiveDirectiveMarker(proj, {
        kind: "ask", ask_type: "guard-recovery", stage: "code-generation",
        remedies: [{ op: "request-changes", action: 'Ask "What should change?"', interaction: "human-input" }],
        state_sha256: stateDigest(state),
      });
      return { proj, session: SESSION, approved: false,
        how: "the plan question open, then a recovery question written as the engine writes it" };
    },
  },
  {
    id: "S10", name: "a parallel batch out (invoke-swarm)",
    build: () => {
      // The swarm fixture of the ask test: a feature scope in swarm execution
      // with two Units in the first batch, their plans written, the real `next`
      // issuing the batch step.
      const group = ["alpha", "beta"];
      const proj = setupWorktreeFixture();
      worktreeFixtures.push(proj);
      seedAidlcMemory(proj);
      writeFileSync(seededStateFile(proj), `# State
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
      seedBoltDagBatches(proj, [group, ["later"]]);
      mkdirSync(join(proj, "src"), { recursive: true });
      const baseline = writeBaselineSourceSnapshot(proj, "code-generation", workspaceSourceListing(proj)!);
      appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, proj);
      appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, proj);
      cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
      for (const unit of group) writePlan(proj, "", unit);
      let how = "feature scope in swarm execution, two Unit plans written; next issued the batch step";
      const step = next(proj);
      if (step.kind !== "invoke-swarm") {
        writeActiveDirectiveMarker(proj, {
          kind: "invoke-swarm", stage: "code-generation", units: group,
          state_sha256: stateDigest(readFileSync(seededStateFile(proj), "utf-8")),
        });
        how = `the batch step written as the engine writes it (next said ${step.kind}${step.ask_type ? ` ${step.ask_type}` : ""})`;
      }
      return { proj, session: SESSION, approved: false, units: group, how };
    },
  },
  {
    id: "S11a", name: "no current step: the gate opened and retired it",
    build: () => {
      const proj = createCodeGenerationProject();
      // What a poc run has here: this stage in progress (the previous stage's
      // approval marks it [-], aidlc-state.ts) and Units Generation skipped
      // (core/scopes/aidlc-poc.md), so the stage's records are stage-level.
      const stateFile = seededStateFile(proj);
      writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
        .replace("- [ ] code-generation", "- [-] code-generation")
        .replace(/^(- \[.\] units-generation) \u2014 EXECUTE$/m, "$1 \u2014 SKIP"), "utf-8");
      next(proj);
      askOpen(proj);
      approve(proj);
      next(proj);
      // The build's outputs, the stage's review, then the gate.
      writeFileSync(join(stageDir(proj), "traceability.json"), "{}\n", "utf-8");
      writeFileSync(join(proj, "src", "slugify.ts"), "export const slugify = (s: string) => s;\n", "utf-8");
      const reviewer = "aidlc-architecture-reviewer-agent";
      const review = ["engine", "log", "review", "--stage", "code-generation", "--reviewer", reviewer, "--iteration", "1"];
      const requested = run(proj, [DISPATCHER, ...review]);
      const reviewFile = (JSON.parse(requested.stdout || "{}") as { reviewFile?: string }).reviewFile;
      if (requested.status !== 0 || !reviewFile) throw new Error(`no review file named:\n${requested.stdout}${requested.stderr}`);
      mkdirSync(dirname(join(proj, reviewFile)), { recursive: true });
      writeFileSync(join(proj, reviewFile), reviewText(reviewer), "utf-8");
      const recorded = run(proj, [DISPATCHER, ...review, "--verdict", "READY"]);
      if (recorded.status !== 0) throw new Error(`the review was not recorded:\n${recorded.stdout}${recorded.stderr}`);
      const opened = run(proj, [DISPATCHER, "engine", "orchestrate", "report", "--stage", "code-generation",
        "--result", "awaiting-approval"]);
      const gate = JSON.parse(opened.stdout || "{}") as { kind?: string };
      if (opened.status !== 0 || gate.kind !== "print") throw new Error(`the gate did not open:\n${opened.stdout}${opened.stderr}`);
      // No current step now: a door is refused naming `next` (the pin test
      // below the sweep). The sweep's own `next` makes the step current again,
      // and the approved plan opens the build's doors.
      return {
        proj, session: SESSION, approved: true,
        how: "approved, built, reviewed; report awaiting-approval opened the gate and retired the step; next re-issues it",
      };
    },
  },
  {
    id: "S11b", name: "no current step: the chat compacted",
    build: () => {
      const proj = createCodeGenerationProject();
      next(proj);
      askOpen(proj);
      const state = readFileSync(seededStateFile(proj), "utf-8");
      const marker = JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json"), "utf-8")) as { owner_session?: string };
      if (!invalidateActiveDirectiveContext(proj, state, marker.owner_session ?? SESSION)) {
        throw new Error("the step could not be marked as lost to compaction");
      }
      return { proj, session: SESSION, approved: false, how: "the plan question asked, then the chat compacted" };
    },
  },
  {
    id: "S12", name: "a second chat that has not joined the work",
    build: () => {
      const proj = createCodeGenerationProject();
      next(proj);
      askOpen(proj);
      return { proj, session: UNJOINED_SESSION, approved: false,
        how: "the plan question open; the guard calls come from a chat that never ran next" };
    },
  },
];

// ---------------------------------------------------------------------------
// The seven harness shapes of one tool call
// ---------------------------------------------------------------------------

export type ToolCall =
  | { tool: "Bash"; command: string }
  | { tool: "Write"; path: string }
  | { tool: "Edit"; path: string }
  | { tool: "Task"; agent: string; prompt: string };

export interface Verdict {
  /** 0 admitted, 2 refused (every harness's refusal is folded to 2). */
  code: number;
  /** What the harness would show the person on a refusal; "" when admitted. */
  said: string;
}

export interface Shape {
  name: string;
  /** The harness dir the tree installs into, for respelling engine commands. */
  dir: string;
  /** Install this harness's tree into the project (removing a sibling that shares the dir). */
  install(proj: string): void;
  call(proj: string, session: string, call: ToolCall): Verdict | Promise<Verdict>;
  /** A call to one of the person's MCP servers, named and delivered as this harness's own hook entry gets it. */
  mcp(proj: string, session: string): Verdict | Promise<Verdict>;
}

const MCP_INPUT = { message: "look this up" };

const DIST = join(REPO_ROOT, "dist");

function installTree(proj: string, harness: string, dir: string): void {
  const target = join(proj, dir);
  if (dir !== ".claude" && existsSync(target)) rmSync(target, { recursive: true, force: true });
  cpSync(join(DIST, harness, dir), target, { recursive: true });
}

/** A command spelled for one tree, respelled for another (`.claude/` -> `.codex/`). */
export function respell(command: string, dir: string): string {
  return command.replace(/\.(?:claude|codex|cursor|kiro|aidlc)\//g, `${dir}/`);
}

function spawnShape(proj: string, argv: string[], payload: unknown, extra: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync(BUN, argv, {
    cwd: proj,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...process.env, AIDLC_UNATTENDED: undefined, ...extra } as NodeJS.ProcessEnv,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function stderrVerdict(result: RunResult): Verdict {
  return { code: result.status === 2 ? 2 : result.status === 0 ? 0 : result.status, said: result.status === 0 ? "" : result.stderr.trim() };
}

function claudeInput(call: ToolCall, dir: string): { tool_name: string; tool_input: Record<string, unknown> } {
  switch (call.tool) {
    case "Bash": return { tool_name: "Bash", tool_input: { command: respell(call.command, dir) } };
    case "Write": return { tool_name: "Write", tool_input: { file_path: call.path, content: "x\n" } };
    case "Edit": return { tool_name: "Edit", tool_input: { file_path: call.path, old_string: "a", new_string: "b" } };
    case "Task": return { tool_name: "Task", tool_input: { subagent_type: call.agent, prompt: respell(call.prompt, dir) } };
  }
}

const claude: Shape = {
  name: "claude", dir: ".claude",
  install: (proj) => installTree(proj, "claude", ".claude"),
  call: (proj, session, call) => stderrVerdict(spawnShape(
    proj, [join(proj, ".claude", "hooks", "aidlc-plan-approval-guard.ts")],
    { hook_event_name: "PreToolUse", session_id: session, cwd: proj, ...claudeInput(call, ".claude") },
    { CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
  )),
  // settings.json sends no `mcp__` tool to the hooks; the group's own matchers are the next door.
  mcp: (proj, session) => stderrVerdict(spawnShape(
    proj, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "guard-tool-call"],
    { hook_event_name: "PreToolUse", session_id: session, cwd: proj, tool_name: "mcp__everything__echo", tool_input: MCP_INPUT },
    { CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
  )),
};

// Codex gives every tool call its own turn and call ids; its adapter replays a
// verdict only for a byte-identical delivery, so each call here carries its own.
let codexCall = 0;
const CODEX_ENV = { CLAUDE_PROJECT_DIR: undefined, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined, AIDLC_COMPILED_EXECUTABLE: "" };

const codex: Shape = {
  name: "codex", dir: ".codex",
  install: (proj) => installTree(proj, "codex", ".codex"),
  call: (proj, session, call) => {
    const native = call.tool === "Bash"
      ? { tool_name: "Bash", tool_input: { command: respell(call.command, ".codex") } }
      : call.tool === "Write"
        ? { tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${relative(proj, call.path)}\n+x\n*** End Patch\n` } }
        : call.tool === "Edit"
          ? { tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${relative(proj, call.path)}\n@@\n-a\n+b\n*** End Patch\n` } }
          : { tool_name: "spawn_agent", tool_input: { agent_type: call.agent, message: respell(call.prompt, ".codex") } };
    return stderrVerdict(spawnShape(
      proj, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "plan-approval-guard"],
      {
        hook_event_name: "PreToolUse", cwd: proj, session_id: session,
        turn_id: `turn-sweep-${++codexCall}`, tool_use_id: `call-sweep-${codexCall}`, ...native,
      },
      CODEX_ENV,
    ));
  },
  mcp: (proj, session) => stderrVerdict(spawnShape(
    proj, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "guard-tool-call"],
    {
      hook_event_name: "PreToolUse", cwd: proj, session_id: session,
      turn_id: `turn-sweep-${++codexCall}`, tool_use_id: `call-sweep-${codexCall}`,
      tool_name: "mcp__everything__echo", tool_input: MCP_INPUT,
    },
    CODEX_ENV,
  )),
};

const copilot: Shape = {
  name: "copilot", dir: ".aidlc",
  install: (proj) => installTree(proj, "copilot", ".aidlc"),
  call: (proj, session, call) => {
    const native = call.tool === "Bash"
      ? { tool_name: "run_in_terminal", tool_input: { command: respell(call.command, ".aidlc") } }
      : call.tool === "Write"
        ? { tool_name: "create_file", tool_input: { filePath: call.path, content: "x\n" } }
        : call.tool === "Edit"
          ? { tool_name: "replace_string_in_file", tool_input: { filePath: call.path, oldString: "a", newString: "b" } }
          : { tool_name: "runSubagent", tool_input: { subagent_type: call.agent, prompt: respell(call.prompt, ".aidlc") } };
    return copilotCall(proj, session, native);
  },
  // VS Code's name for an MCP tool, then the Copilot CLI's: both must pass.
  mcp: (proj, session) => {
    for (const tool_name of ["mcp_everything_echo", "everything-echo"]) {
      const verdict = copilotCall(proj, session, { tool_name, tool_input: MCP_INPUT });
      if (verdict.code !== 0) return { code: verdict.code, said: `${tool_name}: ${verdict.said}` };
    }
    return { code: 0, said: "" };
  },
};

function copilotCall(proj: string, session: string, native: Record<string, unknown>): Verdict {
  const result = spawnShape(
    proj, [join(proj, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), "guard-tool-call"],
    { hook_event_name: "PreToolUse", session_id: session, timestamp: new Date().toISOString(), cwd: proj, ...native },
    { AIDLC_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined, AIDLC_COMPILED_EXECUTABLE: undefined },
  );
  if (result.status !== 0) return { code: result.status, said: `adapter failed: ${result.stderr.trim()}` };
  const line = result.stdout.trim().split("\n").find((entry) => entry.startsWith("{"));
  const out = line ? JSON.parse(line) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } : {};
  const decision = out.hookSpecificOutput?.permissionDecision;
  return decision === "deny"
    ? { code: 2, said: out.hookSpecificOutput?.permissionDecisionReason ?? "" }
    : { code: 0, said: "" };
}

const cursor: Shape = {
  name: "cursor", dir: ".cursor",
  install: (proj) => installTree(proj, "cursor", ".cursor"),
  call: (proj, session, call) => {
    const native = call.tool === "Bash"
      ? { tool_name: "Shell", tool_input: { command: respell(call.command, ".cursor"), cwd: "", timeout: 30000 } }
      : call.tool === "Write"
        ? { tool_name: "Write", tool_input: { file_path: call.path, content: "x\n" } }
        : call.tool === "Edit"
          ? { tool_name: "Edit", tool_input: { file_path: call.path, old_string: "a", new_string: "b" } }
          : { tool_name: "Task", tool_input: { description: "build", subagent_type: call.agent, prompt: respell(call.prompt, ".cursor") } };
    return cursorCall(proj, session, native);
  },
  mcp: (proj, session) => cursorCall(proj, session, { tool_name: "MCP:echo", tool_input: MCP_INPUT }),
};

function cursorCall(proj: string, session: string, native: Record<string, unknown>): Verdict {
  const result = spawnShape(
    proj, [join(proj, ".cursor", "hooks", "aidlc-cursor-adapter.ts"), "guards"],
    {
      conversation_id: session, generation_id: session, model: "", tool_use_id: "toolu_sweep",
      session_id: session, hook_event_name: "preToolUse", cursor_version: "2026.07.23-e383d2b",
      workspace_roots: [proj], user_email: "user@example.com", transcript_path: null, cwd: proj, ...native,
    },
    {
      AIDLC_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".cursor",
      GIT_CONFIG_GLOBAL: join(proj, ".absent-global-gitconfig"), GIT_CONFIG_SYSTEM: join(proj, ".absent-system-gitconfig"),
    },
  );
  if (result.status !== 0) return { code: result.status, said: `adapter failed: ${result.stderr.trim()}` };
  const line = result.stdout.trim().split("\n").find((entry) => entry.startsWith("{"));
  const out = line ? JSON.parse(line) as { permission?: string; agent_message?: string } : {};
  return out.permission === "deny" ? { code: 2, said: out.agent_message ?? "" } : { code: 0, said: "" };
}

function kiroNative(call: ToolCall, dir: string): { tool_name: string; tool_input: Record<string, unknown> } {
  switch (call.tool) {
    case "Bash": return { tool_name: "execute_bash", tool_input: { command: respell(call.command, dir) } };
    case "Write": return { tool_name: "fs_write", tool_input: { command: "create", path: call.path, content: "x\n" } };
    case "Edit": return { tool_name: "fs_write", tool_input: { command: "str_replace", path: call.path, old_str: "a", new_str: "b" } };
    case "Task": return { tool_name: "invoke_sub_agent", tool_input: { name: call.agent, prompt: respell(call.prompt, dir), preset: null, contextFiles: [] } };
  }
}

const kiro: Shape = {
  name: "kiro", dir: ".kiro",
  install: (proj) => installTree(proj, "kiro", ".kiro"),
  call: (proj, session, call) => stderrVerdict(spawnShape(
    proj, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "plan-approval-guard"],
    { hook_event_name: "preToolUse", cwd: proj, session_id: session, ...kiroNative(call, ".kiro") },
    { CLAUDE_PROJECT_DIR: proj },
  )),
  // The agent registers this guard for execute_bash, fs_write and subagent only; the adapter is the next door.
  mcp: (proj, session) => stderrVerdict(spawnShape(
    proj, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "plan-approval-guard"],
    { hook_event_name: "preToolUse", cwd: proj, session_id: session, tool_name: "@everything/echo", tool_input: MCP_INPUT },
    { CLAUDE_PROJECT_DIR: proj },
  )),
};

const kiroIde: Shape = {
  name: "kiro-ide", dir: ".kiro",
  install: (proj) => installTree(proj, "kiro-ide", ".kiro"),
  call: (proj, session, call) => {
    const native = call.tool === "Task"
      ? { tool_name: `subagent_${call.agent}`, tool_input: { prompt: respell(call.prompt, ".kiro") } }
      : kiroNative(call, ".kiro");
    return stderrVerdict(spawnShape(
      proj, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "plan-approval-guard"],
      { hook_event_name: "PreToolUse", cwd: proj, session_id: session, ...native },
      { CLAUDE_PROJECT_DIR: proj, USER_PROMPT: undefined },
    ));
  },
  // The one card every non-read tool meets (aidlc-guard-tool-call.json).
  mcp: (proj, session) => stderrVerdict(spawnShape(
    proj, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "guard-tool-call"],
    { hook_event_name: "PreToolUse", cwd: proj, session_id: session, tool_name: "mcp_everything_echo", tool_input: MCP_INPUT },
    { CLAUDE_PROJECT_DIR: proj, USER_PROMPT: undefined },
  )),
};

const opencode: Shape = {
  name: "opencode", dir: ".aidlc",
  install: (proj) => installTree(proj, "opencode", ".aidlc"),
  call: (proj, session, call) => {
    const [tool, args] = call.tool === "Bash"
      ? ["bash", { command: respell(call.command, ".aidlc") }]
      : call.tool === "Write"
        ? ["write", { filePath: call.path, content: "x\n" }]
        : call.tool === "Edit"
          ? ["edit", { filePath: call.path, oldString: "a", newString: "b" }]
          : ["task", { subagent_type: call.agent, prompt: respell(call.prompt, ".aidlc") }];
    return opencodeCall(proj, session, tool, args);
  },
  mcp: (proj, session) => opencodeCall(proj, session, "everything_echo", MCP_INPUT),
};

// The shipped plugin with its own defaults: the shipped entrypoint list and the
// installed `bun .aidlc/tools/aidlc.ts engine` of the project.
async function opencodeCall(proj: string, session: string, tool: string, args: Record<string, unknown>): Promise<Verdict> {
  const { default: createAdapter } = await import("../../dist/opencode/.opencode/plugin/aidlc-opencode-adapter.ts");
  const client = {
    session: {
      get: async () => ({ data: {} }),
      prompt: async () => {},
    },
  };
  const adapter = await createAdapter({ client: client as never, directory: proj } as never);
  const before = (adapter as Record<string, (a: unknown, b: unknown) => Promise<void>>)["tool.execute.before"];
  try {
    await before({ tool, sessionID: session, callID: `sweep-${tool}` }, { args });
    return { code: 0, said: "" };
  } catch (error) {
    return { code: 2, said: error instanceof Error ? error.message : String(error) };
  }
}

export const SHAPES: Shape[] = [claude, codex, copilot, cursor, kiro, kiroIde, opencode];

export const DEVELOPER = "aidlc-developer-agent";
