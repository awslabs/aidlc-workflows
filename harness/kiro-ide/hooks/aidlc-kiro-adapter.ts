#!/usr/bin/env bun
// aidlc-kiro-adapter.ts — the Kiro IDE hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). This is the IDE-specific adapter; the CLI harness ships
// its own (harness/kiro/) wired to kiro-cli's agent-JSON hook events and their
// payload shapes. They are deliberately separate files so neither carries a
// runtime "am I CLI or IDE?" branch.
//
// Kiro IDE hook context (live-captured on 0.12-main, 1.0.165, and 1.0.242 — see
// docs/reference/kiro-ide-hook-payload.md). The channel changed across IDE
// generations; the adapter accepts BOTH:
//   1. IDE 1.x (v2 hooks, `.kiro/hooks/aidlc-*.json`): context arrives as JSON
//      on STDIN, snake_case: { session_id, hook_event_name, cwd, tool_name,
//      tool_input, tool_response } — no success flag. USER_PROMPT is empty.
//      stdin is written AND closed, so a read resolves promptly. A non-empty
//      USER_PROMPT is nevertheless checked first to identify the legacy channel;
//      the stdin read retains a short broken-channel timeout.
//   2. IDE 0.12 (legacy `.kiro.hook` era): stdin was OPENED BUT NEVER
//      WRITTEN/CLOSED — reading it hangs. Context came through the
//      `USER_PROMPT` env var instead, camelCase: { toolName, toolArgs,
//      toolResult, toolSuccess }; that non-empty payload is consumed immediately.
//   3. Captured PostToolUse write/shell events have empty tool inputs, so their
//      file path is recoverable ONLY from toolResult/tool_response prose and
//      the shell command is not recoverable at all. Later 1.x builds populate
//      some PreToolUse and delegation inputs (#543); do not generalize the
//      PostToolUse limitation to every event.
//   4. The tool name arrives as the IDE tool name: `fs_write`, `str_replace`,
//      `fs_append`, `execute_bash`, etc. IDE 1.0.242's UserPromptSubmit payload
//      carries prompt:"", but its PreToolUse payload carries the exact shell
//      command as execute_pwsh. IDE 1.1.14's UserPromptSubmit carries the
//      typed prompt text (measured live), so only older builds such as
//      1.0.242 take the prompt-empty path below.
//
// Payload acquisition is GATED to tool-payload targets, the deterministic
// terminal-command seams, and lifecycle boundaries that carry modern session
// identity (SessionStart and Stop). Every other target is payload-independent
// and never touches stdin. The guard card fires on every PreToolUse but a
// read, and a 2s stall on a never-closing stdin there would be felt on nearly
// every tool call.
//
// Consequences, by target:
//   - audit-and-sensors: scrape the written file path from toolResult prose
//     (strict patterns, fail-open) and feed the core hooks the Claude-shaped
//     {tool_input:{file_path}}.
//   - rebuild-stage-graph: the command is unrecoverable, so drop the command
//     filter and always forward — the core hook self-gates on the audit tail.
//   - state-sync: payload-independent — the core hook reads the latest
//     STAGE_STARTED slug from the audit tail (no task payload needed).
//   - log-subagent: recovers the delegate's identity from the result prose or
//     the 1.x `subagent_<agent>` tool name, plus the message (#459/#543).
//   - verb-intercept: when UserPromptSubmit exposes `/aidlc ...`, run terminal
//     utilities before the model, as the prompt's session, and inject sanitized
//     UTF-8 plain text.
//   - terminal-command-guard: when the prompt is empty, recognize the exact
//     first `aidlc-orchestrate.ts next` PreToolUse call, run the same terminal
//     utility once per session/turn, and refuse the duplicate shell call with
//     its output. Missing session_id uses the host-derived or retained identity.
//     First, it refuses an execute_pwsh `aidlc` command that would put one of
//     & | < > ^ outside cmd.exe's quotes on the way through aidlc.cmd, that
//     holds a %NAME% pair cmd.exe would expand, that passes a value through a
//     PowerShell variable or expression, or that it cannot read far enough to
//     check. Then it refuses an AI-DLC command, on either channel, with an
//     argument PowerShell builds by running code (a grouping, $(...), @(...),
//     @{...} or {...}).
//   - guard-switch capability: an empty-prompt turn notes the limitation once
//     per session and refuses lowering (summary confirmation off included)
//     before a shell command runs. Non-empty
//     prompts need no special shell path: the core human-turn hook applied the
//     person's typed switch when the prompt arrived.
//   - plan-approval-guard: populated inputs use exact target enforcement.
//     Legacy argument-less inputs permit only single-file planning writes,
//     hard-stop opaque shell/append/mutators, mediate Testing Contract +
//     fingerprint/decision/answer ownership after canonical record writes,
//     and bind approval to the planned workspace source the questions file
//     records.
//   - review-freeze, state-transition-guard: forward a write or shell call in
//     the shared guards' shape; refuse a call they cannot read (malformed, no
//     tool name, a write naming no file, a shell call with no command).
//   - session-start: retain the modern session_id or derive a legacy identity
//     from the measured IDE host-instance environment.
//   - record-human-turn: Kiro IDE 1.1.14 runs no SessionStart hook when a chat
//     starts, so a prompt whose session_id is not the retained one, or was
//     never started, runs the core session-start first and prints its context
//     ahead of its own.
//   - stop: prefer the event-local modern session_id; use retained identity for
//     the legacy channel and broken modern payloads.
//   - session-end: read retained identity without probing payload.
//
// session-start emits {"additionalContext": "..."} — Kiro's context channel is
// plain stdout at exit 0, so the shim unwraps the JSON and prints the text.
// stop emits {"decision":"block","reason":"..."} — passed through verbatim.
//
// Usage (registered in .kiro/hooks/aidlc-*.json — the IDE's v2 hook schema,
// {"version":"v1","hooks":[{name,trigger,matcher,action}]}):
//   bun .kiro/hooks/aidlc-kiro-adapter.ts <target>
// where <target> ∈ record-human-turn | enforce-approval-gate | session-start |
//                  audit-and-sensors | rebuild-stage-graph |
//                  sync-workflow-state | log-subagent | continue-workflow |
//                  session-end | verb-intercept | terminal-command-guard |
//                  plan-approval-guard | review-freeze | state-transition-guard |
//                  guard-tool-call | person-message | after-shell | catch-up
// guard-tool-call, person-message and after-shell are registrations that run
// several of the others (KIRO_HOOK_GROUPS in aidlc-kiro-tool-names.ts): Kiro
// shows one card per hook run, so the person sees one card where they saw five,
// or two (#2022). Nothing is registered after a write or a command: the guard
// card notes the call it lets through, and catch-up, the first member of the
// next card that runs anyway, does what the after-write (audit-and-sensors) and
// after-command (after-shell) cards did. Kiro passes no PostToolUse output to the
// agent, so only the moment moves, and always to before the next call.

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  hookOutsideGate,
  KIRO_WORKFLOW_HOST_TEMPLATES,
  kiroTurnOrigin,
  enterHookWorkflow,
  classifyTerminalCommand,
  decodeHarnessPlainText,
  fenceCommandOutput,
  relayAsTextBlock,
  presenceFloorHolds,
  clearKiroIdeLegacyPlanApprovalHost,
  clearPlanApprovalViolation,
  getField,
  hookChildEnv,
  hookDebug,
  hookExecutionRecoveryText,
  humanPresenceGuardDisabled,
  isAutonomousMode,
  isSwitchableGuardFence,
  listIntentDirs,
  listSpaces,
  kiroIdeLegacyPlanApprovalSessionId,
  markKiroIdeLegacyPlanApprovalHost,
  clearPlanApprovalLegacyWindow,
  recordHookDrop,
  recordPreWorkflowHeartbeat,
  resolveProjectFlag,
  readPlanApprovalViolation,
  readPlanApprovalLegacyWindow,
  readPlanApprovalLegacyWindows,
  readActiveDirectiveMarker,
  readSessionBinding,
  readSessionIntentUuid,
  resolveProjectDirFromHook,
  sanitizeHarnessPlainText,
  writePlanApprovalLegacyWindow,
  writePlanApprovalViolation,
  sessionsDir,
  splitKiroCommandArgs,
  stateFilePath,
  UNBINDABLE_FINGERPRINT,
  workspaceSourceState,
  writeWorkspaceSourceSnapshot,
} from "../tools/aidlc-lib.ts";
import {
  approvalFingerprint,
  beginCodeGeneration,
  codeGenerationExecutionAllowed,
  codeGenerationPlanApprovalFence,
  evaluateCodeGenerationApproval,
  legacyPlanApprovalGuardState,
  parseTestingContract,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../tools/aidlc-testing-posture.ts";
import { normalizeRetiredGuardPolicyField } from "../tools/aidlc-guard-switch.ts";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { aidlcEngineCommand, aidlcInvocation } from "../tools/aidlc-runtime-paths.ts";
import { terminalDispatcherArgv } from "../tools/aidlc.ts";
import { noteKiroIdeTurn } from "../tools/aidlc-rules-held.ts";
import {
  canonicalWriteTool,
  isAuditedWriteTool,
  isKiroAppendTool,
  isKiroDelegationTool,
  isKiroGenericDelegationTool,
  isKiroPipelineDelegationTool,
  isKiroPowerShellTool,
  isKiroShellTool,
  isLegacyPlanningWriteTool,
  isPlanApprovalSafeReadTool,
  KIRO_HOOK_GROUPS,
  kiroNamedDelegate,
  mutationCapableTool,
} from "./aidlc-kiro-tool-names.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
// The NORMALIZED hook context, whichever channel delivered it: 1.x snake_case
// stdin { tool_name, tool_input, tool_response } or 0.12 camelCase USER_PROMPT
// { toolName, toolArgs, toolResult, toolSuccess }. PostToolUse write/shell
// captures have empty inputs; later 1.x builds populate some PreToolUse and
// delegation inputs (#543), so normalization preserves either shape.
interface IdeHookContext {
  channel?: "legacy" | "modern";
  sessionId?: string;
  prompt?: string;
  userPrompt?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolSuccess?: boolean;
  malformedFields?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The targets whose forward depends on the tool payload. Every other
// target builds a fixed input (or reads only the filesystem), so it skips
// payload acquisition entirely and keeps its zero-latency path.
const PAYLOAD_TARGETS = new Set([
  "audit-and-sensors",
  // The approval gate reads the payload session: concurrent chats in one IDE
  // process each have their own workflow and gate.
  "enforce-approval-gate",
  "log-subagent",
  "plan-approval-guard",
  "rebuild-stage-graph",
  "review-freeze",
  "state-transition-guard",
  "terminal-command-guard",
]);
const SESSION_ID_TARGETS = new Set([
  "session-start",
  "continue-workflow",
  "record-human-turn",
]);
// catch-up reads which card it runs in; note-call reads the call the guard let through.
const CATCH_UP = "catch-up";
const NOTE_CALL = "note-call";
const INPUT_TARGETS = new Set([
  ...PAYLOAD_TARGETS,
  ...SESSION_ID_TARGETS,
  "verb-intercept",
  CATCH_UP,
  NOTE_CALL,
  ...Object.keys(KIRO_HOOK_GROUPS),
]);
const LEGACY_SESSION_ID = "kiro-ide-legacy-current";
const KIRO_IDE_SESSION_FILE = ".kiro-ide-current-session";
function firstNonBlank(values: unknown[]): string {
  return values.find((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  )?.trim() ?? "";
}

interface KiroDelegationTarget {
  agent: string;
  prompt: string;
  stage: string;
}

// One entry per delegate the dispatch starts, in the order the platform runs
// them. `subagent_<agent>` names its delegate in the tool name, `invoke_sub_agent`
// in `tool_input.name`, and `orchestrate_subagent` per stage in
// `tool_input.stages[].role`; an `orchestrate_subagent` stage's own
// `prompt_template` is what that delegate receives. `agent` is "" when the
// payload names no delegate.
// A call with no arguments may build any Unit of a group, so continuing past a
// changed approved plan needs every Unit the active directive builds to be
// approved or to continue from its own approval: a Unit the person never
// approved is never built. A single-target directive has only its own target.
function everyUnitContinuesFromApproval(projectDir: string): boolean {
  try {
    const state = readFileSync(stateFilePath(projectDir), "utf-8");
    const marker = readActiveDirectiveMarker(projectDir, state);
    if (marker?.kind !== "invoke-swarm") return true;
    return (marker.units ?? []).every((unit) =>
      evaluateCodeGenerationApproval(projectDir, { unit }).ok ||
      codeGenerationExecutionAllowed(projectDir, { unit })
    );
  } catch {
    return false;
  }
}

// Whether the workflow is at Code Generation: the state's Current Stage or the
// active directive names it. Unreadable state is not Code Generation, matching
// the core guard's fail-open outside that stage.
function codeGenerationIsCurrent(projectDir: string): boolean {
  try {
    const statePath = stateFilePath(projectDir);
    if (!existsSync(statePath)) return false;
    const state = readFileSync(statePath, "utf-8");
    const marker = readActiveDirectiveMarker(projectDir, state);
    return getField(state, "Current Stage")
        ?.trim()
        .toLowerCase()
        .replace(/\s+/g, "-") === "code-generation" ||
      marker?.stage === "code-generation";
  } catch {
    return false;
  }
}

function kiroDelegationTargets(
  toolName: string,
  toolArgs: Record<string, unknown>,
): KiroDelegationTarget[] {
  if (isKiroPipelineDelegationTool(toolName)) {
    const stages = Array.isArray(toolArgs.stages) ? toolArgs.stages : [];
    return stages.filter(isRecord).map((stage) => ({
      agent: firstNonBlank([stage.role, stage.name]),
      prompt: firstNonBlank([stage.prompt_template, toolArgs.task]),
      stage: firstNonBlank([stage.name]),
    }));
  }
  const suffix = kiroNamedDelegate(toolName);
  return [{
    agent: suffix ||
      firstNonBlank([
        toolArgs.name,
        toolArgs.subagent_type,
        toolArgs.agent,
        toolArgs.agent_name,
        toolArgs.role,
      ]),
    prompt: firstNonBlank([toolArgs.prompt, toolArgs.task, toolArgs.description]),
    stage: "",
  }];
}

// `orchestrate_subagent` reports every stage in one result, each under a
// `## <stage name>` heading after a "Pipeline completed" line. Return that
// stage's section, or the whole result when the heading is absent.
function orchestrateStageOutput(result: string, stage: string): string {
  if (!stage) return result;
  const lines = result.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${stage}`);
  if (start < 0) return result;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \S/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

function upsertTestingContract(plan: string, rendered: string): string {
  const section = /(^|\n)## Testing Contract[^\n]*\n[\s\S]*?(?=\n## |\s*$)/m;
  if (section.test(plan)) {
    return plan.replace(section, (_match, prefix: string) =>
      `${prefix}${rendered.trimEnd()}\n`
    );
  }
  return `${plan.trimEnd()}\n\n${rendered}`;
}

function legacyToolCommand(
  tool: "aidlc-log.ts" | "aidlc-orchestrate.ts",
  args: string[],
): string[] {
  return aidlcEngineCommand(
    tool === "aidlc-log.ts" ? "log" : "orchestrate",
    args,
    join(HOOKS_DIR, "..", "tools", tool),
  );
}

function runLegacyPlanTool(
  projectDir: string,
  tool: "aidlc-log.ts",
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(
    legacyToolCommand(tool, args),
    {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  );
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

function legacyPlanApprovalSessionId(): string {
  const session = kiroIdeLegacyPlanApprovalSessionId();
  if (session) return session;
  throw new Error(
    "legacy Plan Approval requires the Kiro IDE host identity (VSCODE_IPC_HOOK or VSCODE_PID)",
  );
}

// Thrown only once Plan Approval mediation is engaged for a canonical planning
// write (the Testing Contract, decision, or answer step failed). Environment
// preconditions that fail before any mediation is in play are plain errors.
class LegacyPlanApprovalMediationError extends Error {}

function resolvedPlanApprovalSessionId(ide: IdeHookContext): string {
  if (ide.sessionId?.trim()) return ide.sessionId.trim();
  try {
    return legacyPlanApprovalSessionId();
  } catch {
    return LEGACY_SESSION_ID;
  }
}

// Whether this conversation stands outside the workflow the default resolution
// selects: that workflow's gates and local Plan Approval latches do not hold it.
let standsOutsideMemo: boolean | undefined;
function ideStandsOutside(pd: string, sessionId: string): boolean {
  if (standsOutsideMemo === undefined) {
    const workflow = enterHookWorkflow(pd, sessionId);
    try {
      standsOutsideMemo = hookOutsideGate(workflow);
    } finally {
      workflow.restore();
    }
  }
  return standsOutsideMemo;
}

function runLegacyRecoveryNext(
  projectDir: string,
  sessionId: string,
): { ok: boolean; detail: string; recoveryRequired?: boolean } {
  const priorViolation = readPlanApprovalViolation(projectDir);
  const priorState = legacyPlanApprovalGuardState(projectDir);
  const priorAuthority =
    priorState.violated === true && priorState.target !== null
      ? (() => {
          try {
            return resolveCodeGenerationAuthority(
              projectDir,
              priorState.target,
            );
          } catch {
            return null;
          }
        })()
      : null;
  const harnessViolation =
    priorAuthority !== null &&
    priorViolation?.reason === "unsupported legacy write target" &&
    priorViolation.markerRevision === priorAuthority.markerRevision &&
    (() => {
      const rel = relative(join(projectDir, ".kiro"), priorViolation.target);
      return rel === "" ||
        (
          !isAbsolute(rel) &&
          rel !== ".." &&
          !rel.startsWith(`..${sep}`)
        );
    })();
  let args = ["next", "--project-dir", projectDir];
  for (let step = 0; step < 64; step++) {
    const result = Bun.spawnSync(
      legacyToolCommand("aidlc-orchestrate.ts", args),
      {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      },
    );
    const stdout = result.stdout?.toString().trim() ?? "";
    const stderr = result.stderr?.toString().trim() ?? "";
    if ((result.exitCode ?? 1) !== 0) {
      return { ok: false, detail: stderr || stdout || "engine recovery failed" };
    }
    let directive: {
      kind?: string;
      ask_type?: string;
      receipt?: string;
      recovery_choice?: string;
    };
    try {
      directive = JSON.parse(stdout);
    } catch {
      return { ok: false, detail: "engine recovery emitted invalid JSON" };
    }
    if (directive.kind === "error") {
      return {
        ok: false,
        detail: stdout || "engine recovery returned an error directive",
      };
    }
    if (
      directive.kind === "ask" &&
      directive.ask_type === "legacy-plan-approval-recovery"
    ) {
      return {
        ok: false,
        recoveryRequired: true,
        detail: stdout,
      };
    }
    if (directive.kind !== "load-steering") {
      clearPlanApprovalViolation(projectDir);
      clearPlanApprovalLegacyWindow(projectDir, sessionId);
      if (harnessViolation && priorViolation && priorAuthority) {
        const state = legacyPlanApprovalGuardState(projectDir);
        if (state.active && state.target !== null) {
          const authority = resolveCodeGenerationAuthority(
            projectDir,
            state.target,
          );
          if (
            authority.intentId === priorAuthority.intentId &&
            authority.targetId === priorAuthority.targetId
          ) {
            writePlanApprovalViolation(projectDir, {
              ...priorViolation,
              markerRevision: authority.markerRevision,
            });
          }
        }
      }
      return { ok: true, detail: stdout };
    }
    if (!directive.receipt) {
      return { ok: false, detail: "load-steering recovery omitted its receipt" };
    }
    args = [
      "continue",
      directive.receipt,
      "--project-dir",
      projectDir,
    ];
  }
  return { ok: false, detail: "engine recovery exceeded 64 steering parts" };
}

function legacyRecoveryBlockReason(
  recovery: ReturnType<typeof runLegacyRecoveryNext>,
): string {
  if (recovery.recoveryRequired) {
    return (
      "Legacy Plan Approval recovery requires a human response. " +
      "Present exactly `Recover Plan Approval`, end the turn, then retry recovery. " +
      `The unknown original shell command remains blocked. Directive: ${recovery.detail}`
    );
  }
  return recovery.ok
    ? `Legacy Plan Approval recovery issued a fresh directive and blocked the unknown original shell command. Resume canonical planning from: ${recovery.detail}`
    : `Legacy Plan Approval recovery failed closed: ${recovery.detail}`;
}

function latestPlanApprovalAnswer(questions: string): string | null {
  const answers = Array.from(
    questions.matchAll(/^\[Answer\]:[ \t]*(.*?)\s*$/gm),
    (match) => match[1].trim(),
  );
  return answers.length === 0 ? null : answers[answers.length - 1];
}

function processLegacyPlanApprovalWrite(
  projectDir: string,
  filePath: string,
  sessionId: string,
): null {
  const normalizedPath = resolve(filePath);
  const writeWindow = readPlanApprovalLegacyWindow(projectDir, sessionId);
  const state = legacyPlanApprovalGuardState(projectDir);
  if (!state.active || state.target === null) {
    if (writeWindow) {
      writePlanApprovalViolation(projectDir, {
        version: 1,
        markerRevision: writeWindow.markerRevision,
        reason: "legacy write destroyed or invalidated Plan Approval authority",
        target: normalizedPath,
      });
    }
    return null;
  }
  // An approved plan, or one that changed since under a lowered check, is not
  // a planning window: its writes are the build's.
  if (
    state.approved ||
    (codeGenerationExecutionAllowed(projectDir, state.target) && everyUnitContinuesFromApproval(projectDir))
  ) return null;
  const authority = resolveCodeGenerationAuthority(projectDir, state.target);
  const planPath = join(authority.stageDir, "code-generation-plan.md");
  const instructionsPath = join(authority.stageDir, "unit-test-instructions.md");
  const questionsPath = join(authority.stageDir, "code-generation-questions.md");

  if (normalizedPath === planPath) {
    const contract = resolveTestingPosture(projectDir);
    const plan = readFileSync(planPath, "utf-8");
    if (parseTestingContract(plan)?.contract_sha256 !== contract.contract_sha256) {
      writeFileSync(
        planPath,
        upsertTestingContract(plan, renderTestingContract(contract)),
        "utf-8",
      );
    }
    clearPlanApprovalLegacyWindow(projectDir, sessionId);
    return null;
  }
  if (normalizedPath === instructionsPath) {
    clearPlanApprovalLegacyWindow(projectDir, sessionId);
    return null;
  }
  if (normalizedPath !== questionsPath) {
    writePlanApprovalViolation(projectDir, {
      version: 1,
      markerRevision: authority.markerRevision,
      reason: "unsupported legacy write target",
      target: normalizedPath,
    });
    return null;
  }

  let questions = readFileSync(questionsPath, "utf-8");
  const answer = latestPlanApprovalAnswer(questions);
  const targetArgs =
    state.target.unit === null
      ? ["--stage-level"]
      : ["--unit", state.target.unit];
  if (answer === "") {
    const plan = readFileSync(planPath, "utf-8");
    const instructions = readFileSync(instructionsPath, "utf-8");
    const contract = resolveTestingPosture(projectDir);
    if (parseTestingContract(plan)?.contract_sha256 !== contract.contract_sha256) {
      throw new LegacyPlanApprovalMediationError(
        "legacy Plan Approval mediation requires the current Testing Contract in code-generation-plan.md",
      );
    }
    const fingerprint = approvalFingerprint(
      plan,
      instructions,
      contract.contract_sha256,
      authority,
    );
    const withFingerprint = /^\[Approval Fingerprint\]:.*$/m.test(questions)
      ? questions.replace(
          /^\[Approval Fingerprint\]:.*$/m,
          `[Approval Fingerprint]: ${fingerprint}`,
        )
      : questions.replace(
          /^(\[Answer\]:)/m,
          `[Approval Fingerprint]: ${fingerprint}\n$1`,
        );
    // Core refuses a decision whose Plan Approval section lacks the planned
    // source. The legacy channel cannot run the fingerprint command itself, so
    // the adapter records the live workspace source here, falling back to the
    // unbindable marker when the workspace has no source fingerprint rather
    // than refusing the whole mediation. The listing behind the source is kept
    // exactly as the fingerprint command keeps it, so a later drift can be told
    // to the human as the files that changed.
    const plannedState = workspaceSourceState(projectDir);
    if (plannedState !== null) {
      writeWorkspaceSourceSnapshot(projectDir, "code-generation", plannedState);
    }
    const plannedSource = plannedState?.fingerprint ?? UNBINDABLE_FINGERPRINT;
    const withPlannedSource = /^\[Planned Source\]:.*$/m.test(withFingerprint)
      ? withFingerprint.replace(
          /^\[Planned Source\]:.*$/m,
          `[Planned Source]: ${plannedSource}`,
        )
      : withFingerprint.replace(
          /^(\[Answer\]:)/m,
          `[Planned Source]: ${plannedSource}\n$1`,
        );
    writeFileSync(questionsPath, withPlannedSource, "utf-8");
    const decision = runLegacyPlanTool(projectDir, "aidlc-log.ts", [
      "decision",
      "--stage",
      "code-generation",
      "--checkpoint",
      "plan-approval",
      "--session",
      sessionId,
      "--questions-file",
      questionsPath,
      "--decision",
      "Approve this exact Code Generation plan?",
      "--options",
      "Approve Plan,Request Changes",
      "--exact-option-labels",
      "true",
      "--legacy-directive-options",
      "true",
      ...targetArgs,
    ]);
    if (decision.code !== 0) {
      throw new LegacyPlanApprovalMediationError(
        `legacy Plan Approval decision mediation failed: ${decision.stderr.trim() || decision.stdout.trim()}`,
      );
    }
    clearPlanApprovalLegacyWindow(projectDir, sessionId);
    return null;
  }
  if (
    answer === "Approve Plan" ||
    answer === "Request Changes"
  ) {
    questions = questions.replace(
      /^\[Answer\]:[ \t]*.*$/m,
      `[Answer]: ${answer}`,
    );
    writeFileSync(questionsPath, questions, "utf-8");
  }
  if (answer !== "Approve Plan" && answer !== "Request Changes") return null;
  const recorded = runLegacyPlanTool(projectDir, "aidlc-log.ts", [
    "answer",
    "--stage",
    "code-generation",
    "--checkpoint",
    "plan-approval",
    "--session",
    sessionId,
    "--questions-file",
    questionsPath,
    "--details",
    answer,
    ...targetArgs,
  ]);
  if (recorded.code !== 0) {
    throw new LegacyPlanApprovalMediationError(
      `legacy Plan Approval answer mediation failed: ${recorded.stderr.trim() || recorded.stdout.trim()}`,
    );
  }
  clearPlanApprovalLegacyWindow(projectDir, sessionId);
  return null;
}

// --- cmd.exe metacharacters in an execute_pwsh `aidlc` command ---
//
// Native Windows `aidlc` is aidlc.cmd, so cmd.exe reads the command line that
// Windows PowerShell 5.1 builds for it. PowerShell 5.1 drops an empty
// argument, wraps an argument that holds a space or tab in double quotes, and
// leaves the argument's own double quotes as they are. cmd.exe then toggles
// its quote state at every double quote and acts on & | < > ^ outside quotes.
// So `--details 'Use "R & D" team'` (or the same with \") reaches cmd.exe as
// `--details "Use "R & D" team"`, and cmd.exe runs `D" team"` as a separate
// command; with > it would write a file. cmd.exe also replaces a %NAME% pair
// with that environment variable's value, even inside its quotes. The engine
// never sees the value as written, so this adapter refuses such a command
// before it runs. It also refuses an aidlc argument PowerShell resolves first
// (a variable or expression, whose result it cannot see) and an aidlc command
// it cannot read far enough to check. `bun .kiro/tools/...` invocations never
// pass through cmd.exe and are not checked for it (aidlcCodeArgumentHazard
// below checks both channels for PowerShell code).

// What cmd.exe does with each character it acts on outside its quotes.
const CMD_OPERATOR_EFFECTS: Record<string, string> = {
  "&": "run the rest as a separate command",
  "|": "send the output to the rest as another command",
  "<": "read input from a file named by the rest",
  ">": "write output to a file named by the rest",
  "^": "drop the character as an escape",
};

interface PowerShellWord {
  source: string; // the word as written in the command
  value: string; // the argument PowerShell passes, when `opaque` is false
  opaque: boolean; // PowerShell would expand or evaluate part of it
  code: boolean; // PowerShell runs code to build it: a grouping, $(...), @(...), @{...} or {...}
  redirect: boolean; // a PowerShell redirection, not an argument
}

// Splits a PowerShell command line into statements of words, as far as this
// check needs: single-quoted parts ('' is a literal '), double-quoted parts
// ("" is a literal "; $ or a backtick makes the word opaque), barewords, the
// statement ends ; | and newline, a leading & or . call operator,
// redirections, comments (# at the start of a word runs to the end of the
// line; <# ... #> is a block comment), and (...), $(...), @(...), @{...} and
// {...} groupings, whose statements are read as well, nested too (a $(...)
// inside a double-quoted string is not). A statement it cannot read to the end
// goes to `unreadable` with the words read before that point: one that uses
// the --% stop-parsing token (PowerShell passes the rest of that line as
// written, and the next line is read as usual), or the one holding an
// unterminated quote or block comment, where reading stops.
interface PowerShellReading {
  statements: PowerShellWord[][];
  unreadable: PowerShellWord[][];
}

// The index of the quote that closes the quoted string opening at `open`:
// '' and "" are literal quotes, and a backtick escapes the next character
// inside double quotes. -1 when it is not closed.
function quotedEnd(text: string, open: number): number {
  const quote = text[open];
  for (let j = open + 1; j < text.length; j++) {
    if (quote === '"' && text[j] === "`") {
      j++;
      continue;
    }
    if (text[j] !== quote) continue;
    if (text[j + 1] === quote) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// The index of the ) or } that closes the grouping opening at `open` (a ( or
// {), past nested groupings, quoted strings, escapes and comments. -1 when it
// is not closed.
function groupEnd(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === "'" || c === '"') {
      const close = quotedEnd(text, j);
      if (close < 0) return -1;
      j = close;
    } else if (c === "`") {
      j++;
    } else if (c === "#" && /[\s;({|]/.test(text[j - 1] ?? " ")) {
      while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
    } else if (c === "<" && text[j + 1] === "#") {
      const close = text.indexOf("#>", j + 2);
      if (close < 0) return -1;
      j = close + 1;
    } else if (c === "(" || c === "{") {
      depth++;
    } else if (c === ")" || c === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function powerShellStatements(command: string): PowerShellReading {
  const statements: PowerShellWord[][] = [];
  const unreadable: PowerShellWord[][] = [];
  let words: PowerShellWord[] = [];
  let i = 0;
  let skipNextWord = false;
  const endStatement = () => {
    if (words.length > 0) statements.push(words);
    words = [];
    skipNextWord = false;
  };
  const stopReading = (): PowerShellReading => {
    unreadable.push(words);
    return { statements, unreadable };
  };
  while (i < command.length) {
    const ch = command[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    // A backtick before a line break continues the statement on the next
    // line; CRLF, LF and CR are each one line break.
    if (ch === "`" && (command[i + 1] === "\n" || command[i + 1] === "\r")) {
      i += command[i + 1] === "\r" && command[i + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
      endStatement();
      i++;
      continue;
    }
    // A # that starts a word starts a comment, which runs to the end of the
    // line; the statement before it is still read. <# ... #> is a block
    // comment.
    if (ch === "#") {
      while (i < command.length && command[i] !== "\n" && command[i] !== "\r") i++;
      continue;
    }
    if (ch === "<" && command[i + 1] === "#") {
      const close = command.indexOf("#>", i + 2);
      if (close < 0) return stopReading();
      i = close + 2;
      continue;
    }
    // A leading & or . is the call operator; anywhere else & ends the command
    // and . is an argument.
    if (
      (ch === "&" || (ch === "." && words.length === 0)) &&
      /[ \t'"]/.test(command[i + 1] ?? " ")
    ) {
      if (words.length > 0) endStatement();
      i++;
      continue;
    }
    const redirect = /^(?:[0-9*]?>>?(?:&[0-9])?|<)/.exec(command.slice(i));
    if (redirect) {
      i += redirect[0].length;
      // `2>&1` merges streams and names no file; `2>$null` names its target
      // in the same word, `> out.txt` in the next one.
      if (!redirect[0].includes("&")) {
        if (i >= command.length || command[i] === " " || command[i] === "\t") skipNextWord = true;
        else {
          while (i < command.length && !/[ \t;|\n\r]/.test(command[i])) i++;
        }
      }
      words.push({ source: redirect[0], value: "", opaque: false, code: false, redirect: true });
      continue;
    }
    const start = i;
    let value = "";
    let opaque = false;
    let code = false;
    while (i < command.length && !/[ \t;|\n\r>]/.test(command[i])) {
      const c = command[i];
      if (c === "'") {
        const close = (() => {
          for (let j = i + 1; j < command.length; j++) {
            if (command[j] !== "'") continue;
            if (command[j + 1] === "'") {
              j++;
              continue;
            }
            return j;
          }
          return -1;
        })();
        if (close < 0) return stopReading();
        value += command.slice(i + 1, close).replaceAll("''", "'");
        i = close + 1;
      } else if (c === '"') {
        let j = i + 1;
        let closed = false;
        while (j < command.length) {
          const d = command[j];
          if (d === "`") {
            opaque = true;
            j += 2;
            continue;
          }
          if (d === "$") opaque = true;
          // A $(...) inside double quotes runs too.
          if (d === "$" && command[j + 1] === "(") code = true;
          if (d === '"') {
            if (command[j + 1] === '"') {
              value += '"';
              j += 2;
              continue;
            }
            closed = true;
            break;
          }
          value += d;
          j++;
        }
        if (!closed) return stopReading();
        i = j + 1;
      } else if (c === "$" && command[i + 1] === "{") {
        // ${name} is a variable, not a script block.
        const close = command.indexOf("}", i + 2);
        if (close < 0) return stopReading();
        opaque = true;
        i = close + 1;
      } else if (c === "(" || c === "{" || ((c === "$" || c === "@") && (command[i + 1] === "(" || command[i + 1] === "{"))) {
        // A grouping, subexpression, array or script block: PowerShell runs
        // the statements inside it (read here like any others, so an aidlc
        // call there is checked too) and passes their result, which this
        // check cannot see, so the word is opaque. Its text is not the word's.
        const open = c === "(" || c === "{" ? i : i + 1;
        const close = groupEnd(command, open);
        if (close < 0) return stopReading();
        const inner = powerShellStatements(command.slice(open + 1, close));
        statements.push(...inner.statements);
        unreadable.push(...inner.unreadable);
        opaque = true;
        code = true;
        i = close + 1;
      } else {
        // A backtick before a line break ends the word and continues the
        // statement; the loop above consumes it.
        if (c === "`" && (command[i + 1] === "\n" || command[i + 1] === "\r")) break;
        if (c === "`" || c === "$" || c === "@" || c === ")" || c === "}") opaque = true;
        value += c;
        i++;
      }
    }
    const source = command.slice(start, i);
    if (source === "--%") {
      unreadable.push(words);
      words = [];
      skipNextWord = false;
      while (i < command.length && command[i] !== "\n" && command[i] !== "\r") i++;
      continue;
    }
    if (skipNextWord) {
      skipNextWord = false;
      continue;
    }
    words.push({ source, value, opaque, code, redirect: false });
  }
  endStatement();
  return { statements, unreadable };
}

// The arguments of a statement whose program (its first word after a leading
// `$x =` assignment) is `aidlc` or `aidlc.cmd`, bare or by path; a & or .
// call operator is already dropped. Null for any other program.
function aidlcCommandArgs(words: PowerShellWord[]): PowerShellWord[] | null {
  const start = words.length > 2 && words[0].source.startsWith("$") && words[1].source === "=" ? 2 : 0;
  const program = words[start];
  if (program === undefined || program.opaque || !/(?:^|[\\/])aidlc(?:\.cmd)?$/i.test(program.value)) return null;
  return words.slice(start + 1);
}

// A %NAME% pair: cmd.exe replaces it with that environment variable's value,
// quoted or not, whenever NAME is defined, so the engine would record
// something else (or a secret). The name runs to the next % or to a :modifier
// (%NAME:~0,3%, %NAME:a=b%). A name that starts or ends with a space is not
// counted, so prose such as "between 10% and 20%" passes; no variable is
// named like that in practice.
const CMD_VARIABLE_PAIR = /%[^%\s=:](?:[^%\r\n=:]*[^%\s=:])?(?::[^%\r\n]*)?%/;

// The flag an `aidlc` argument is the value of: `--flag=value`, or the
// `--flag` word before it. Only a plain flag name is ever returned, so the
// refusal below never repeats text from the value itself.
function valueFlag(args: PowerShellWord[], index: number): string | null {
  const inline = /^(--[A-Za-z0-9][A-Za-z0-9-]*)=/.exec(args[index].source);
  if (inline) return inline[1];
  const previous = args[index - 1];
  if (previous !== undefined && !previous.opaque && /^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(previous.value)) {
    return previous.value;
  }
  return null;
}

// The aidlc flags whose value carries a person's words, from the Kiro IDE
// skill and the stage protocols: --details (log answer), --decision and
// --rationale (log decision), --reason (report, bolt checkpoint),
// --user-input (report, bolt and unit gates), --feedback (rejection feedback),
// --override (the typed break-glass reason), and --arguments (intent create,
// whose text is recorded as the request). --label is left out: intent create
// slugifies it into a folder name, so it never reaches the record as written.
// A value for one of these, or the request after `next`, must be written
// literally; a variable or expression for any other flag, or for a positional
// token (a receipt, slug or id the engine printed), is agent work and passes.
const FREE_TEXT_FLAGS: ReadonlySet<string> = new Set([
  "--details",
  "--decision",
  "--rationale",
  "--reason",
  "--user-input",
  "--feedback",
  "--override",
  "--arguments",
]);

type CmdHazard =
  | { kind: "metacharacter"; flag: string | null; char: string }
  | { kind: "variable"; flag: string | null }
  | { kind: "expression"; flag: string | null; request: boolean }
  | { kind: "unchecked" };

// Whether the opaque word at `index` carries a person's words: the value of a
// free-text flag, or (after `orchestrate next`) a positional word, which is
// the request. A word right after any other --flag is that flag's value.
function freeTextOpaque(args: PowerShellWord[], index: number): CmdHazard | null {
  const flag = valueFlag(args, index);
  if (flag !== null) return FREE_TEXT_FLAGS.has(flag) ? { kind: "expression", flag, request: false } : null;
  const next = args.findIndex(
    (word, at) => at > 0 && !word.opaque && word.value === "next" && args[at - 1].value === "orchestrate",
  );
  return next >= 0 && index > next ? { kind: "expression", flag: null, request: true } : null;
}

// The first `aidlc` (or `aidlc.cmd`, bare or by path) argument that cmd.exe
// would not pass on as written, in any statement, including one inside a
// grouping: a person's words that PowerShell resolves from a variable or
// expression before aidlc.cmd runs ($x, $env:X, $(...), or a double-quoted
// string holding $ or a backtick), whose result this check cannot see; one
// that puts a cmd.exe metacharacter outside cmd.exe's quotes (named by its
// flag, with that character); or one that holds a %NAME% pair, quoted or not.
// The literal text of any other opaque word is checked for the same two. A
// statement this check cannot read to the end is "unchecked" when its program
// is aidlc, so it fails closed; any other statement passes as before.
function cmdMetacharacterHazard(command: string): CmdHazard | null {
  const reading = powerShellStatements(command);
  for (const words of reading.statements) {
    const found = aidlcCommandArgs(words);
    if (found === null) continue;
    const args = found.filter((word) => !word.redirect);
    for (let index = 0; index < args.length; index++) {
      const word = args[index];
      if (!word.opaque) continue;
      const freeText = freeTextOpaque(args, index);
      if (freeText !== null) return freeText;
      // An opaque word's own text (not a grouping's) still counts: cmd.exe
      // expands a %NAME% pair in it whatever PowerShell resolves, and a
      // metacharacter in it may land outside cmd.exe's quotes.
      if (CMD_VARIABLE_PAIR.test(word.value)) return { kind: "variable", flag: valueFlag(args, index) };
      if (/[&|<>^]/.test(word.value)) return { kind: "expression", flag: valueFlag(args, index), request: false };
    }
    let line = "";
    const owners: number[] = [];
    args.forEach((word, index) => {
      if (word.opaque || word.value === "") return;
      const passed = /[ \t]/.test(word.value) ? `"${word.value}"` : word.value;
      line += `${line === "" ? "" : " "}${passed}`;
      while (owners.length < line.length) owners.push(index);
    });
    let quoted = false;
    for (let at = 0; at < line.length; at++) {
      const c = line[at];
      if (c === '"') quoted = !quoted;
      else if (!quoted && /[&|<>^]/.test(c)) {
        return { kind: "metacharacter", flag: valueFlag(args, owners[at]), char: c };
      }
    }
    const variable = CMD_VARIABLE_PAIR.exec(line);
    if (variable !== null) return { kind: "variable", flag: valueFlag(args, owners[variable.index]) };
  }
  if (reading.unreadable.some((words) => aidlcCommandArgs(words) !== null)) return { kind: "unchecked" };
  return null;
}

// A fixed template: only a plain flag name and one of & | < > ^ are filled
// in, never the value, so text in the value cannot add lines to the reason.
function cmdMetacharacterRefusal(hazard: CmdHazard): string {
  if (hazard.kind === "unchecked") {
    return (
      "AIDLC stopped this command before it ran. Its aidlc arguments could not be checked for characters " +
      "cmd.exe would act on (the aidlc command runs through aidlc.cmd). Run it again without the --% " +
      "stop-parsing token or a block comment, with each value in quotes and every quote closed.\n"
    );
  }
  const subject = hazard.kind === "expression" && hazard.request
    ? "The request after next"
    : hazard.flag === null
    ? "A value"
    : `The ${hazard.flag} value`;
  if (hazard.kind === "expression") {
    return (
      `AIDLC stopped this command before it ran. ${subject} comes from a PowerShell variable or expression, ` +
      "so AIDLC cannot check what cmd.exe would do with it (the aidlc command runs through aidlc.cmd). " +
      "Write the value itself in single quotes, then run the command again.\n"
    );
  }
  if (hazard.kind === "variable") {
    return (
      `AIDLC stopped this command before it ran. ${subject} holds a %NAME% pair, which cmd.exe ` +
      "(the aidlc command runs through aidlc.cmd) would replace with that environment variable's value " +
      "before AI-DLC sees it. Write it without the surrounding percent signs (for example APPDATA instead " +
      "of %APPDATA%), then run the command again.\n"
    );
  }
  return (
    `AIDLC stopped this command before it ran. ${subject} would reach cmd.exe ` +
    `(the aidlc command runs through aidlc.cmd) with ${hazard.char} outside its quotes, so cmd.exe would ` +
    `${CMD_OPERATOR_EFFECTS[hazard.char]} instead of passing it as text. Write that value's inner double ` +
    "quotes as single quotes (for example --details 'Use ''R & D'' team'), or leave the character out of " +
    "a label you wrote, then run the command again.\n"
  );
}

// --- PowerShell code in an AI-DLC command's arguments ---
//
// Every Kiro IDE agent's permissions run AI-DLC's own commands without a card
// (the engine namespace and AI-DLC's tool scripts, on both channels). Their
// ask rules catch `$`,
// a backtick, `@(`, `@{`, redirects, `&` and line breaks, but a glob cannot
// tell a bare grouping such as `--decision (Get-Content x)` from a quoted label
// such as 'Approve (Recommended)'. PowerShell runs the grouping before the
// command starts, so this adapter refuses an argument PowerShell builds by
// running code (a grouping, $(...), @(...), @{...} or {...}, bare or inside
// double quotes) on either channel's AI-DLC command. A quoted value passes.

// The arguments of a statement in which bun runs one of the copy channel's
// AI-DLC scripts, the dispatcher `aidlc.ts` or a tool `aidlc-<tool>.ts` in
// the harness tools folder (also through `run`, and after a leading `$x =`).
// Null for any other program.
function copyChannelCommandArgs(words: PowerShellWord[]): PowerShellWord[] | null {
  const start = words.length > 2 && words[0].source.startsWith("$") && words[1].source === "=" ? 2 : 0;
  const program = words[start];
  if (program === undefined || program.opaque || !/(?:^|[\\/])bun(?:\.exe)?$/i.test(program.value)) return null;
  let at = start + 1;
  if (words[at] !== undefined && !words[at].opaque && words[at].value === "run") at++;
  const script = words[at];
  if (
    script === undefined || script.opaque ||
    !/^(?:\.[\\/])?\.kiro[\\/]tools[\\/]aidlc(?:-[a-z0-9-]+)?\.ts$/i.test(script.value)
  ) {
    return null;
  }
  return words.slice(at + 1);
}

interface CodeArgumentHazard {
  flag: string | null;
  request: boolean;
}

// The first argument of an AI-DLC command (either channel), in any statement,
// that PowerShell builds by running code. Null when there is none.
function aidlcCodeArgumentHazard(command: string): CodeArgumentHazard | null {
  for (const words of powerShellStatements(command).statements) {
    const found = aidlcCommandArgs(words) ?? copyChannelCommandArgs(words);
    if (found === null) continue;
    const args = found.filter((word) => !word.redirect);
    const index = args.findIndex((word) => word.code);
    if (index < 0) continue;
    const flag = valueFlag(args, index);
    const next = args.findIndex(
      (word, at) => at > 0 && !word.opaque && word.value === "next" && args[at - 1].value === "orchestrate",
    );
    return { flag, request: flag === null && next >= 0 && index > next };
  }
  return null;
}

// A fixed template: only a plain flag name is filled in, never the value.
function aidlcCodeArgumentRefusal(hazard: CodeArgumentHazard): string {
  const subject = hazard.request
    ? "The request after next"
    : hazard.flag === null
    ? "A value"
    : `The ${hazard.flag} value`;
  return (
    `AIDLC stopped this command before it ran. ${subject} is PowerShell code, which PowerShell would run ` +
    "before the command starts. Write the value itself in single quotes, then run the command again.\n"
  );
}

// The tool a hook payload names, from either channel's spelling, or null when
// the payload cannot be read: then every member runs and judges it itself.
function payloadToolName(input: string): string | null {
  const raw = input.trim().length > 0 ? input : process.env.USER_PROMPT ?? "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const name = parsed.tool_name ?? parsed.toolName;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

// One registration, several targets (KIRO_HOOK_GROUPS). A member runs for the
// tools its own registration selected. Every member runs, in order, even after
// one refuses, as Kiro ran every hook; the call is refused when any member
// refuses, and Kiro hands the agent the text on stderr, so it carries each
// refusal once and nothing from a member that let the call through.
async function runHookGroup(
  members: ReadonlyArray<{ target: string; matcher: string }>,
  input: string,
  extraArgs: string[],
): Promise<number> {
  const toolName = payloadToolName(input);
  const write = process.stderr.write;
  const print = process.stdout.write;
  let code = 0;
  const refusals: string[] = [];
  const failures: string[] = [];
  // What each member gives the agent (Kiro reads a message card's stdout), one
  // after the other on lines of their own, as Kiro joined separate cards.
  const printed: string[] = [];
  for (const member of members) {
    if (toolName !== null && !new RegExp(member.matcher).test(toolName)) continue;
    standsOutsideMemo = undefined;
    let said = "";
    let out = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      said += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    let memberCode: number;
    try {
      memberCode = await run(member.target, input, extraArgs);
    } catch (error) {
      // A member that throws fails alone, as its own hook process did.
      said += `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
      memberCode = 1;
    } finally {
      process.stderr.write = write;
      process.stdout.write = print;
    }
    if (out !== "") printed.push(out);
    if (memberCode === 2) {
      code = 2;
      if (said && !refusals.includes(said)) refusals.push(said);
    } else if (memberCode !== 0) {
      if (code === 0) code = memberCode;
      if (said && !failures.includes(said)) failures.push(said);
    }
  }
  if (printed.length > 0) {
    process.stdout.write(printed.map((out, at) => at < printed.length - 1 && !out.endsWith("\n") ? `${out}\n` : out).join(""));
  }
  const text = code === 2 ? refusals : failures;
  if (code !== 0 && text.length > 0) process.stderr.write(text.join(""));
  return code;
}

// What Kiro would run after a write or a command, noted by the guard card that
// let the call through and done by the next card that runs anyway (catch-up).
// One file per call under the gitignored sessions folder; a card claims a file
// by renaming it, so two chats' cards never do the same call twice.
interface FileSnapshot {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
}
type PendingCall =
  | { kind: "write"; at: number; session: string; tool: "Write" | "Edit"; path: string; before: FileSnapshot }
  | { kind: "shell"; at: number; session: string; tool: string; command: string; records: Record<string, string[]> };

// A write still unchanged when another call starts may still be running; it
// waits this long for a later card, and a message or the turn's end ends it.
const PENDING_WRITE_WAIT_MS = 10 * 60 * 1000;
// A claim this old was left by a card that stopped before it finished.
const STALE_CLAIM_MS = 60 * 1000;
// Files up to this size are compared by content; larger ones by size and time.
const HASHED_FILE_LIMIT = 8 * 1024 * 1024;

function pendingCallsDir(projectDir: string): string {
  return join(sessionsDir(projectDir), "kiro-ide-pending");
}

function fileSnapshot(path: string): FileSnapshot {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    const snapshot: FileSnapshot = { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    if (stat.size <= HASHED_FILE_LIMIT) {
      snapshot.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
    return snapshot;
  } catch {
    return { exists: false };
  }
}

function fileChangedSince(path: string, before: FileSnapshot): boolean {
  const now = fileSnapshot(path);
  if (!now.exists) return false;
  if (!before.exists) return true;
  if (before.sha256 !== undefined && now.sha256 !== undefined) return before.sha256 !== now.sha256;
  return before.size !== now.size || before.mtimeMs !== now.mtimeMs;
}

// The record folders in every space, to tell which one a command made.
function recordDirs(projectDir: string): Record<string, string[]> {
  const records: Record<string, string[]> = {};
  for (const space of listSpaces(projectDir)) records[space.name] = listIntentDirs(projectDir, space.name);
  return records;
}

function writePendingCall(projectDir: string, call: PendingCall): void {
  try {
    const dir = pendingCallsDir(projectDir);
    mkdirSync(dir, { recursive: true });
    const name = `${String(call.at).padStart(15, "0")}-${process.pid}-${randomUUID().slice(0, 8)}.json`;
    writeFileSync(join(dir, name), `${JSON.stringify(call)}\n`, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    recordHookDrop(projectDir, "kiro-adapter", `catch-up note: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// The noted calls, oldest first, each claimed by this card.
function claimPendingCalls(projectDir: string): Array<{ call: PendingCall; done: () => void; keep: () => void }> {
  const dir = pendingCallsDir(projectDir);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const claimed: Array<{ call: PendingCall; done: () => void; keep: () => void }> = [];
  for (const name of names) {
    // A claim names the card's process and the time it claimed the call.
    const open = /^(\d{15}-\d+-[0-9a-f]{8}\.json)(?:\.claim-\d+-(\d+))?$/.exec(name);
    if (!open) continue;
    if (open[2] !== undefined && Date.now() - Number(open[2]) < STALE_CLAIM_MS) continue;
    const from = join(dir, name);
    const mine = join(dir, `${open[1]}.claim-${process.pid}-${Date.now()}`);
    try {
      renameSync(from, mine);
    } catch {
      continue;
    }
    const done = () => {
      try {
        unlinkSync(mine);
      } catch {
        // Already gone.
      }
    };
    let call: PendingCall;
    try {
      call = JSON.parse(readFileSync(mine, "utf-8")) as PendingCall;
    } catch {
      done();
      continue;
    }
    claimed.push({
      call,
      done,
      keep: () => {
        try {
          renameSync(mine, join(dir, open[1]));
        } catch {
          done();
        }
      },
    });
  }
  return claimed;
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
// guard-tool-call, person-message and after-shell run their members, each as
// its own target. A call the guard card lets through is noted for the next card.
const group = Object.hasOwn(KIRO_HOOK_GROUPS, target) ? KIRO_HOOK_GROUPS[target] : undefined;
if (group) {
  const code = await runHookGroup(group, input, _extraArgs);
  if (target === "guard-tool-call" && code !== 2) await run(NOTE_CALL, input);
  return code;
}

// LOAD-BEARING (not debug-only): this is the base dir for resolve(projectDir,
// rawPath) that turns the IDE's workspace-relative write path into the absolute
// path the core write-audit-log's record-root check needs — the core fix of this
// harness. It also feeds hookDebug/recordHookDrop. Do not remove it. Kiro IDE
// sets no project variable, and a compiled engine runs this file from its
// runtime payload, so there it is the directory Kiro IDE ran the hook in.
const projectDir = resolveProjectDirFromHook(import.meta.url);

// Normalize the hook context for the payload-dependent targets. IDE 1.x
// delivers it as JSON on stdin (the `input` argument); 0.12 delivered it via
// USER_PROMPT with stdin open-but-never-written. Prefer stdin, fall back to
// the env var so 0.12 keeps working. Field names differ per channel — 0.12
// camelCase {toolName, toolArgs, toolResult, toolSuccess}; 1.x snake_case
// {tool_name, tool_input, tool_response} (no success flag) — accept both.
let ide: IdeHookContext = {};
if (INPUT_TARGETS.has(target)) {
  let raw = input;
  const legacyPayload = process.env.USER_PROMPT ?? "";
  let channel: IdeHookContext["channel"] =
    raw.trim().length > 0
      ? legacyPayload.trim().length > 0 && raw === legacyPayload
        ? "legacy"
        : "modern"
      : undefined;
  if (raw.trim().length === 0) {
    raw = legacyPayload;
    if (raw.trim().length > 0) channel = "legacy";
  }
  if (raw.trim().length > 0) {
    if (target === "verb-intercept" && /^\s*\/aidlc(?![\w-])/.test(raw)) {
      ide = { channel, prompt: raw, userPrompt: raw };
    } else {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) {
          ide = { malformedFields: ["payload"] };
        } else {
          const rawName = parsed.toolName ?? parsed.tool_name;
          const rawArgs = parsed.toolArgs ?? parsed.tool_input;
          const rawResult = parsed.toolResult ?? parsed.tool_response;
          const rawSuccess = parsed.toolSuccess ?? parsed.tool_success;
          const rawSessionId = parsed.session_id ?? parsed.sessionId;
          const rawPrompt =
            parsed.prompt ??
            parsed.user_prompt ??
            parsed.userPrompt ??
            parsed.message;
          const malformedFields: string[] = [];
          if (
            rawPrompt !== null &&
            rawPrompt !== undefined &&
            typeof rawPrompt !== "string"
          ) {
            malformedFields.push("prompt");
          }
          if (
            rawName !== null &&
            rawName !== undefined &&
            typeof rawName !== "string"
          ) {
            malformedFields.push("toolName");
          }
          if (
            rawArgs !== null &&
            rawArgs !== undefined &&
            !isRecord(rawArgs)
          ) {
            malformedFields.push("toolArgs");
          }
          if (
            rawResult !== null &&
            rawResult !== undefined &&
            typeof rawResult !== "string"
          ) {
            malformedFields.push("toolResult");
          }
          if (
            rawSuccess !== null &&
            rawSuccess !== undefined &&
            typeof rawSuccess !== "boolean"
          ) {
            malformedFields.push("toolSuccess");
          }
          ide = {
            channel,
            sessionId: typeof rawSessionId === "string"
              ? rawSessionId
              : undefined,
            prompt: typeof rawPrompt === "string" ? rawPrompt : undefined,
            userPrompt: typeof rawPrompt === "string" ? rawPrompt : undefined,
            toolName: typeof rawName === "string" ? rawName : undefined,
            toolArgs: isRecord(rawArgs) ? rawArgs : undefined,
            toolResult: typeof rawResult === "string" ? rawResult : "",
            toolSuccess: typeof rawSuccess === "boolean"
              ? rawSuccess
              : undefined,
            malformedFields: malformedFields.length > 0
              ? malformedFields
              : undefined,
          };
        }
      } catch {
        if (target === "record-human-turn") {
          ide = { channel, prompt: raw, userPrompt: raw };
        } else {
          // Malformed context - advisory hooks fail open without forwarding an
          // event whose fields cannot be trusted.
          ide = { malformedFields: ["JSON"] };
        }
      }
    }
  }
}
hookDebug(projectDir, "kiro-adapter", "invoked", {
  target,
  hasStdinPayload: input.trim().length > 0,
  hasUserPrompt: (process.env.USER_PROMPT ?? "").length > 0,
  prompt: (ide.prompt ?? ide.userPrompt ?? "").slice(0, 160),
  toolName: ide.toolName ?? "",
  sessionId: ide.sessionId ?? "",
  toolResult: (ide.toolResult ?? "").slice(0, 160),
});
const promptEmpty = ide.prompt !== undefined && ide.prompt.trim() === "" &&
  (ide.malformedFields?.length ?? 0) === 0;

// Persist the effective startup or event-local prompt identity under the existing gitignored
// runtime dir so separate adapter processes can forward it to payload-free
// SessionEnd and use it when a legacy or broken-channel Stop has no event-local
// session_id. A legacy promptSubmit writes its host-derived id, replacing any
// stale modern value from a prior IDE generation in the same workspace.
function rememberKiroIdeSessionId(sessionId: string): void {
  if (!sessionId) return;
  try {
    const dir = sessionsDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, KIRO_IDE_SESSION_FILE), `${sessionId}\n`, "utf-8");
  } catch {
    // Per-user runtime state; lifecycle hooks retain the legacy fallback.
  }
}

function rememberedKiroIdeSessionId(): string {
  try {
    const sessionId = readFileSync(
      join(sessionsDir(projectDir), KIRO_IDE_SESSION_FILE),
      "utf-8",
    ).trim();
    return sessionId || LEGACY_SESSION_ID;
  } catch {
    return LEGACY_SESSION_ID;
  }
}

type TerminalCommand = NonNullable<
  ReturnType<typeof classifyTerminalCommand>
>;

interface TerminalInvocation {
  raw: string;
  args: string[];
}

interface TerminalResult {
  output: string;
  exitCode: number;
  typed: string;
  source: TerminalCommand["source"];
}

interface TerminalLatch extends TerminalResult {
  turn: number;
  raw: string;
  args: string[];
  ts: number;
}

function promptTerminalInvocation(prompt: string): TerminalInvocation {
  const expanded = prompt.match(/aidlc-orchestrate\.ts next ([^`\n]*)`/);
  const rawInvocation = expanded
    ? expanded[1]
    : prompt.match(/^\s*\/aidlc(?![\w-])([\s\S]*)$/)?.[1];
  if (rawInvocation === undefined) return { raw: "", args: [] };
  const raw = rawInvocation.trim();
  return { raw, args: splitKiroCommandArgs(raw) };
}

function toolTerminalInvocation(command: string): TerminalInvocation | null {
  const match = command.trim().match(
    /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+)*(?:(?:"([^"]+)"|'([^']+)'|(\S+))\s+)?["']?\.kiro[\\/]tools[\\/]aidlc-orchestrate\.ts["']?\s+next(?:\s+([\s\S]*))?$/i,
  );
  if (match === null) return null;
  const runner = match[1] ?? match[2] ?? match[3] ?? "";
  if (runner && !/(^|[\\/])bun(?:\.exe)?$/i.test(runner)) return null;
  const raw = (match[4] ?? "").trim();
  return { raw, args: splitKiroCommandArgs(raw) };
}

function terminalTyped(
  command: TerminalCommand,
  forwarded: string[],
): string {
  return command.source === "read-only-flag"
    ? `--${command.subcommand}`
    : (command.display ?? [command.subcommand, ...forwarded].join(" "));
}

function runTerminalCommand(command: TerminalCommand): TerminalResult | null {
  const forwarded =
    command.args ?? (command.arg !== undefined ? [command.arg] : []);
  const typed = terminalTyped(command, forwarded);
  if (command.error !== undefined) {
    return {
      output: sanitizeHarnessPlainText(command.error),
      exitCode: 1,
      typed,
      source: command.source,
    };
  }

  const toolFile = command.source === "knowledge-verb"
    ? "aidlc-knowledge.ts"
    : "aidlc-utility.ts";
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;

  try {
    const result = Bun.spawnSync(
      executable
        ? [executable, ...terminalDispatcherArgv(command)]
        : [
            process.execPath,
            join(".kiro", "tools", toolFile),
            command.subcommand,
            ...forwarded,
          ],
      {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
        // The command acts for the chat that typed it, even when this hook
        // runs before record-human-turn has started that chat's session.
        env: hookChildEnv(projectDir, ide.sessionId?.trim(), {
          AIDLC_PROJECT_DIR: projectDir,
          CLAUDE_PROJECT_DIR: projectDir,
        }),
      },
    );
    return {
      output: (
        decodeHarnessPlainText(result.stdout) +
        decodeHarnessPlainText(result.stderr)
      ).trim(),
      exitCode: result.exitCode ?? 1,
      typed,
      source: command.source,
    };
  } catch {
    return null;
  }
}

function terminalSessionId(): string {
  if (ide.sessionId?.trim()) return ide.sessionId.trim();
  try {
    return legacyPlanApprovalSessionId();
  } catch {
    return rememberedKiroIdeSessionId();
  }
}

function terminalSessionDir(sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(sessionsDir(projectDir), "kiro-terminal", key);
}

function turnCounterPath(sessionId: string): string {
  return join(terminalSessionDir(sessionId), "turn");
}

function terminalLatchPath(sessionId: string): string {
  return join(terminalSessionDir(sessionId), "latch.json");
}

// Written once the core session-start has run for a chat's session, from
// SessionStart or from the chat's first prompt. The retained marker is no
// evidence of a start: earlier adapters wrote it on every prompt without one.
function sessionStartedPath(sessionId: string): string {
  return join(terminalSessionDir(sessionId), "session-started");
}

function sessionStarted(sessionId: string): boolean {
  return existsSync(sessionStartedPath(sessionId));
}

function markSessionStarted(sessionId: string): void {
  if (!sessionId) return;
  try {
    mkdirSync(terminalSessionDir(sessionId), { recursive: true });
    writeFileSync(sessionStartedPath(sessionId), `${new Date().toISOString()}\n`, "utf-8");
  } catch {
    // Without the record the chat's next prompt starts the session again.
  }
}

function readTurn(sessionId: string): number {
  try {
    const value = Number.parseInt(
      readFileSync(turnCounterPath(sessionId), "utf-8").trim(),
      10,
    );
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function bumpTurn(sessionId: string): number {
  const turn = readTurn(sessionId) + 1;
  try {
    mkdirSync(terminalSessionDir(sessionId), { recursive: true });
    writeFileSync(turnCounterPath(sessionId), `${turn}\n`, "utf-8");
  } catch {
    return 0;
  }
  return turn;
}


function recordPromptEmpty(sessionId: string, turn: number): void {
  if (turn <= 0) return;
  try {
    writeFileSync(
      join(terminalSessionDir(sessionId), "prompt-empty"),
      promptEmpty ? `${turn}\n` : "",
      "utf-8",
    );
  } catch {
    // Without the marker, core setters still refuse to lower fences on their own.
  }
}

function notePromptCapability(sessionId: string): void {
  if (!promptEmpty) return;
  try {
    writeFileSync(join(terminalSessionDir(sessionId), "capability-noted"), "", { flag: "wx" });
  } catch {
    return;
  }
  process.stdout.write(
    "Guard settings cannot be lowered, and summary confirmation and plan approval cannot be turned off, for the active piece of work in this Kiro IDE session because this version does not provide the submitted message. To use a lower guard setting, update Kiro IDE or start a new piece of work from a scope whose default already uses that setting. " +
      `${summaryConfirmationWayOut()} ${planApprovalWayOut()} You can still select strict or turn a fence on. An existing Change Control: relaxed|off line is renamed to Guard Policy without changing its value.\n`,
  );
}

// The step that works now comes first: the recorded kill switch is the
// person's own terminal command, and recording it refreshes no project files,
// so it also covers the work running now. An updated build carries the typed
// switch again.
function summaryConfirmationWayOut(): string {
  return `To turn summary confirmation off now, run \`${aidlcInvocation()} config flags --bypass AIDLC_DISABLE_SUMMARY_CONFIRMATION --local --yes\` in a terminal: it turns it off for all work in this project, including the work running now (run it again with \`--clear-bypass\` in place of \`--bypass\` to turn it back on). After you update Kiro IDE, you can instead type \`/aidlc config set summary-confirmation off\` yourself.`;
}

// Plan approval off is read from what the person types or says, so this build
// cannot carry the typed switch, and it keeps its plan picker either way. The
// recorded switch still turns the Plan Approval check's refusals off now.
function planApprovalWayOut(): string {
  return `This Kiro IDE build still shows each plan here for you to approve; after you update Kiro IDE, you can type \`/aidlc config set plan-approval off\` to build plans without being asked. If the plan approval check refuses work wrongly meanwhile, run \`${aidlcInvocation()} config flags --bypass AIDLC_DISABLE_PLAN_APPROVAL_GUARD --local --yes\` in a terminal to turn that check off for all work in this project, including the work running now (run it again with \`--clear-bypass\` in place of \`--bypass\` to turn it back on).`;
}

// "summary" when the only lowering is summary confirmation off, which skips
// the person's `Looks correct` check; "plan" when it is plan approval off;
// "guard" when any guard setting lowers.
type GuardLowering = "guard" | "summary" | "plan" | null;

function loweringGuardSwitch(key: string, value: string | undefined): GuardLowering {
  if (key === "guard-policy" || key === "change-control") {
    return value === "relaxed" || value === "off" ? "guard" : null;
  }
  if (key === "summary-confirmation") return value === "off" ? "summary" : null;
  // `guard.plan-approval` is the same switch as `plan-approval`.
  if (key === "plan-approval" || key === "guard.plan-approval") return value === "off" ? "plan" : null;
  return key.startsWith("guard.") &&
    isSwitchableGuardFence(key.slice("guard.".length)) && value === "off" ? "guard" : null;
}

function loweringGuardFlags(args: string[], allowFences: boolean): GuardLowering {
  let lowering: GuardLowering = null;
  for (const [index, arg] of args.entries()) {
    const key = arg.toLowerCase();
    if (!key.startsWith("--")) continue;
    if (!allowFences && key !== "--guard-policy" && key !== "--change-control") continue;
    const found = loweringGuardSwitch(key.slice(2), args[index + 1]?.toLowerCase());
    if (found === "guard") return found;
    lowering ??= found;
  }
  return lowering;
}

function loweringGuardInvocation(
  rawCommand: string,
): GuardLowering {
  const match = rawCommand.trim().match(
    /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+)*(?:(?:"([^"]+)"|'([^']+)'|(\S+))\s+)?["']?(\.kiro[\\/]tools[\\/]aidlc(?:-utility)?\.ts)["']?(?:\s+([\s\S]*))?$/i,
  );
  if (match === null) return null;
  const runner = match[1] ?? match[2] ?? match[3] ?? "";
  if (runner && !/(^|[\\/])bun(?:\.exe)?$/i.test(runner)) return null;
  const args = splitKiroCommandArgs(match[5] ?? "");
  if (match[4].toLowerCase().endsWith("aidlc-utility.ts")) {
    const verb = args[0]?.toLowerCase();
    if (verb === "config-change" || verb === "scope-change") return loweringGuardFlags(args.slice(1), true);
    return verb === "intent-create" ? loweringGuardFlags(args.slice(1), false) : null;
  }
  // The intent setter lives under the dispatcher's `engine` namespace; the
  // public `aidlc config <section>` is machine configuration and never lowers.
  if (args[0]?.toLowerCase() !== "engine") return null;
  const noun = args[1]?.toLowerCase();
  const verb = args[2]?.toLowerCase();
  if (noun === "config" && verb === "set") {
    // `next` folds further settings into the same set as `--<key> <value>` pairs.
    const first = loweringGuardSwitch(args[3]?.toLowerCase() ?? "", args[4]?.toLowerCase());
    const rest = loweringGuardFlags(args.slice(5), true);
    return first === "guard" || rest === "guard" ? "guard" : first ?? rest;
  }
  if (noun === "scope" && verb === "change") return loweringGuardFlags(args.slice(3), true);
  return noun === "intent" && verb === "create" ? loweringGuardFlags(args.slice(3), false) : null;
}


function promptWasEmpty(sessionId: string, turn: number): boolean {
  if (turn <= 0) return false;
  try {
    return readFileSync(
      join(terminalSessionDir(sessionId), "prompt-empty"),
      "utf-8",
    ).trim() === String(turn);
  } catch {
    return false;
  }
}

function readTerminalLatch(sessionId: string): TerminalLatch | null {
  try {
    const parsed = JSON.parse(
      readFileSync(terminalLatchPath(sessionId), "utf-8"),
    ) as Partial<TerminalLatch>;
    if (
      typeof parsed.turn !== "number" ||
      typeof parsed.output !== "string" ||
      typeof parsed.exitCode !== "number" ||
      typeof parsed.typed !== "string" ||
      typeof parsed.source !== "string" ||
      typeof parsed.raw !== "string" ||
      !Array.isArray(parsed.args)
    ) {
      return null;
    }
    return parsed as TerminalLatch;
  } catch {
    return null;
  }
}

function writeTerminalLatch(
  sessionId: string,
  turn: number,
  invocation: TerminalInvocation,
  result: TerminalResult,
): void {
  if (turn <= 0) return;
  try {
    mkdirSync(terminalSessionDir(sessionId), { recursive: true });
    writeFileSync(
      terminalLatchPath(sessionId),
      `${JSON.stringify({
        turn,
        raw: invocation.raw,
        args: invocation.args,
        ...result,
        ts: Date.now(),
      })}\n`,
      "utf-8",
    );
  } catch {
    // Best-effort deduplication; the command output remains available.
  }
}

function terminalContext(result: TerminalResult): string {
  return (
    "SYSTEM (deterministic harness dispatch): The command " +
    `\`/aidlc ${result.typed}\` has ALREADY been run by the harness. ` +
    `It carries no workflow work. Relay the output below ${relayAsTextBlock(result.output)}, then STOP. ` +
    "Do not call any AIDLC tool this turn.\n\n" +
    fenceCommandOutput(result.output, result.exitCode)
  );
}

function terminalRefusal(result: TerminalResult): string {
  return (
    "AIDLC deterministic terminal command complete. The requested command has " +
    "already run inside the hook, and this shell call is intentionally refused " +
    "to keep Kiro's Windows shell transport from changing its UTF-8 output. " +
    "Do not retry or run another AIDLC command this turn. Relay the output below " +
    `to the user ${relayAsTextBlock(result.output)}, then stop.\n\n` +
    fenceCommandOutput(result.output, result.exitCode)
  );
}

// The guard card let this call through: note what Kiro would run after it, so
// the next card does it (catch-up). A project whose hook files still register
// the after-write or after-command card keeps that card doing it.
if (target === NOTE_CALL) {
  const toolName = ide.toolName ?? "";
  const toolArgs = ide.toolArgs ?? {};
  const session = ide.sessionId?.trim() || rememberedKiroIdeSessionId();
  const ownCard = (file: string) => existsSync(join(projectDir, ".kiro", "hooks", file));
  if (isKiroShellTool(toolName) && !ownCard("aidlc-after-shell.json")) {
    writePendingCall(projectDir, {
      kind: "shell",
      at: Date.now(),
      session,
      tool: toolName,
      command: typeof toolArgs.command === "string" ? toolArgs.command : "",
      records: recordDirs(projectDir),
    });
  } else if (isAuditedWriteTool(toolName) && !ownCard("aidlc-write-audit-log.json")) {
    const rawPath = inputPaths(toolArgs)[0];
    const tool = canonicalWriteTool(toolName);
    if (rawPath && tool !== "") {
      const path = isAbsolute(rawPath) ? rawPath : resolve(projectDir, rawPath);
      writePendingCall(projectDir, { kind: "write", at: Date.now(), session, tool, path, before: fileSnapshot(path) });
    }
  }
  return 0;
}

// What Kiro used to run in a card of its own after each write and each command,
// done first by the next card that runs anyway: before the checks of the next
// call, before the person's message is recorded, before the turn's end is
// judged. A write is recorded only when its file changed, with the session and
// input the after-write card gave the audit and the sensors; a command runs the
// after-shell pair, behind the same front gate, and hands the rebuild the record
// a command made, as the command's output did, so the chat joins its work.
async function catchUpPendingCalls(card: "call" | "message" | "turn-end"): Promise<void> {
  for (const claimed of claimPendingCalls(projectDir)) {
    const call = claimed.call;
    try {
      if (call.kind === "write") {
        if (!fileChangedSince(call.path, call.before)) {
          if (card === "call" && Date.now() - call.at < PENDING_WRITE_WAIT_MS) claimed.keep();
          else claimed.done();
          continue;
        }
        const event = {
          hook_event_name: "PostToolUse",
          session_id: call.session,
          tool_name: call.tool,
          tool_input: { file_path: call.path },
        };
        runCore("aidlc-write-audit-log.ts", event);
        runCore("aidlc-run-sensors.ts", event);
        claimed.done();
        continue;
      }
      const now = recordDirs(projectDir);
      const made = Object.entries(now).flatMap(([space, dirs]) =>
        dirs.filter((dir) => !(call.records[space] ?? []).includes(dir)).map((dir) => ({ space, dir })));
      const gate = await import("../tools/aidlc-hook-front-gate.ts");
      const dirs = gate.frontGateProjectDirs(fileURLToPath(import.meta.url));
      if (made.length === 0 && gate.FRONT_GATED_TARGETS.every((hook) => gate.frontGateSkips(hook, dirs))) {
        claimed.done();
        continue;
      }
      // Kiro gave no after-command output to the agent, and a message card's
      // output is the agent's context, so none of it is passed on.
      const print = process.stdout.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try {
        await run("after-shell", JSON.stringify({
          session_id: call.session,
          hook_event_name: "PostToolUse",
          cwd: projectDir,
          tool_name: call.tool,
          tool_input: { command: call.command },
          tool_response: made.length === 1 ? `Intent created: ${made[0].dir} (space: ${made[0].space})\n` : "",
        }));
      } finally {
        process.stdout.write = print;
      }
      claimed.done();
    } catch (error) {
      claimed.done();
      recordHookDrop(projectDir, "kiro-adapter", `catch-up: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (target === CATCH_UP) {
  let event = "";
  try {
    event = String((JSON.parse(input) as { hook_event_name?: unknown }).hook_event_name ?? "");
  } catch {
    // An unreadable payload is a tool call's card: the guard's checks judge it.
  }
  await catchUpPendingCalls(event === "UserPromptSubmit" ? "message" : "call");
  return 0;
}

if (target === "verb-intercept") {
  // Before a doctor request below runs, so it sees this message.
  recordPreWorkflowHeartbeat(projectDir, "terminal-command");
  const sessionId = terminalSessionId();
  const turn = bumpTurn(sessionId);
  recordPromptEmpty(sessionId, turn);
  notePromptCapability(sessionId);
  const invocation = promptTerminalInvocation(ide.prompt ?? "");
  const command = classifyTerminalCommand(invocation.args);
  if (command === null) return 0;
  const result = runTerminalCommand(command);
  if (result === null) return 0;
  writeTerminalLatch(sessionId, turn, invocation, result);
  process.stdout.write(terminalContext(result));
  return 0;
}

if (target === "terminal-command-guard") {
  if ((ide.malformedFields?.length ?? 0) > 0) return 0;
  const tool = ide.toolName ?? "";
  if (!isKiroShellTool(tool)) {
    return 0;
  }
  const rawCommand = typeof ide.toolArgs?.command === "string"
    ? ide.toolArgs.command
    : "";
  // A lone carriage return, on any shell and any agent (a delegated call
  // carries no agent identity, and this reads none). The agents' rules cannot
  // name one (delegate-shell-deny.ts RISKY_SHELL_FORMS); a carriage return
  // before a line feed is a line break, which they ask about.
  if (/\r(?!\n)/.test(rawCommand)) {
    process.stderr.write(
      "AIDLC stopped this command before it ran. It holds a carriage return: " +
        "put the whole command on one line and run it again.\n",
    );
    return 2;
  }
  // Before anything below runs a command: this call would not reach the
  // engine as written (see cmdMetacharacterHazard).
  const cmdHazard = isKiroPowerShellTool(tool) ? cmdMetacharacterHazard(rawCommand) : null;
  if (cmdHazard !== null) {
    process.stderr.write(cmdMetacharacterRefusal(cmdHazard));
    return 2;
  }
  const codeHazard = isKiroPowerShellTool(tool) ? aidlcCodeArgumentHazard(rawCommand) : null;
  if (codeHazard !== null) {
    process.stderr.write(aidlcCodeArgumentRefusal(codeHazard));
    return 2;
  }
  const invocation = toolTerminalInvocation(rawCommand);
  const lowering = loweringGuardInvocation(rawCommand);
  const sessionId = terminalSessionId();
  const turn = readTurn(sessionId) || bumpTurn(sessionId);
  const refused = invocation !== null ? loweringGuardFlags(invocation.args, false) : lowering;
  if (promptWasEmpty(sessionId, turn) && refused !== null) {
    process.stderr.write(refused === "summary"
      ? `Summary confirmation cannot be turned off for the active piece of work in this Kiro IDE session because this version does not provide the submitted message. ${summaryConfirmationWayOut()}\n`
      : refused === "plan"
      ? `Plan approval cannot be turned off for the active piece of work in this Kiro IDE session because this version does not provide the submitted message. ${planApprovalWayOut()}\n`
      : "Guard settings cannot be lowered for the active piece of work in this Kiro IDE session because this version does not provide the submitted message. Update Kiro IDE or start a new piece of work from a scope whose default already uses the lower setting. You can still select strict or turn a fence on.\n");
    return 2;
  }
  const existing = readTerminalLatch(sessionId);
  if (
    existing?.turn === turn &&
    (
      invocation !== null ||
      lowering ||
      /aidlc-(?:orchestrate|utility|knowledge)\.ts/i.test(rawCommand)
    )
  ) {
    process.stderr.write(terminalRefusal(existing));
    return 2;
  }
  if (invocation === null) return 0;
  const command = classifyTerminalCommand(invocation.args);
  if (command === null) return 0;
  // Kiro runs every PreToolUse hook even after one blocks, so while the
  // approval-gate hook refuses this call, running the command here would still
  // act, for example archive an intent, before the person replies.
  if (approvalGateAwaitsHuman()) return 0;
  const result = runTerminalCommand(command);
  if (result === null) return 0;
  writeTerminalLatch(sessionId, turn, invocation, result);
  process.stderr.write(terminalRefusal(result));
  return 2;
}

// UserPromptSubmit forwards to the core human-turn hook below. That hook
// applies typed switches before its state-file gate, then records HUMAN_TURN
// and the conversational Stop marker only when workflow state exists.
// The adapter separately tracks empty prompts against the terminal turn so
// lowering is refused when IDE 1.0.242 hides what the person typed.
// --- enforce-approval-gate: the preToolUse human-presence floor ---
//
// Run by aidlc-guard-tool-call.json (PreToolUse) for every tool but a read,
// which cannot answer or change anything. Hard-blocks tool calls ONLY while
// an approval gate is actually OPEN (a stage sits at [?] in the state file) and
// no HUMAN_TURN has been recorded since the last gate resolution - the exit-2
// floor behind the core handleApprove check. The gate-open predicate is
// load-bearing: after a legitimate approval the resolution follows the turn's
// HUMAN_TURN, and without it the floor would block the mandated same-turn
// continuation into the next stage. Carve-outs mirror the core gate: autonomous
// Construction (swarm/Bolt has no human at the gate) and the deterministic
// off-switch. The IDE gives no cwd payload, so the project dir is process.cwd().
// All read from disk. Fail-open on any read/parse error (advisory).
function approvalGateAwaitsHuman(): boolean {
  const pd = process.cwd();
  // The payload session stays pinned for the whole check, so the gate state and
  // the human-turn evidence come from the workflow this conversation selects,
  // not the one the shared cursor or process ancestry names.
  const workflow = enterHookWorkflow(pd, resolvedPlanApprovalSessionId(ide));
  try {
    if (hookOutsideGate(workflow)) return false;
    const sp = stateFilePath(pd);
    const content = existsSync(sp) ? readFileSync(sp, "utf-8") : null;
    // Carve-outs first: autonomous Construction, the deterministic off-switch,
    // and no-open-gate (nothing awaits approval, so nothing to floor).
    if (isAutonomousMode(content)) return false;
    if (humanPresenceGuardDisabled()) return false;
    // The shared rule: a gate the person must answer, and no turn of theirs
    // since it opened (see presenceFloorHolds).
    return presenceFloorHolds(pd, content, String(ide.toolArgs?.command ?? ""));
  } catch {
    return false; // advisory - any read/parse failure fails open
  } finally {
    workflow.restore();
  }
}

// The words the agent relays when the person's answer was not recorded: what
// happened and the step for the tool they are in, never why. The step is the
// one doctor names (the harness's hook-activation recovery), so the two never
// differ. A Kiro IDE hook process carries VSCODE_IPC_HOOK or VSCODE_PID and a
// Kiro CLI one carries neither (docs/reference/kiro-ide-hook-payload.md), so
// inside Kiro IDE the person gets its step alone: everything before the
// recovery's Kiro CLI sentence.
function unrecordedAnswerRelay(projectDir: string): string {
  const said = "Your answer was not recorded, so you don't need to answer again.";
  const recovery = hookExecutionRecoveryText(projectDir);
  const otherTools = recovery.indexOf(" In Kiro CLI,");
  const inKiroIde = Boolean(process.env.VSCODE_IPC_HOOK?.trim() || process.env.VSCODE_PID?.trim());
  if (inKiroIde && otherTools > 0) {
    return `Tell them exactly this, with nothing about why: "${said} ${recovery.slice(0, otherTools)}"`;
  }
  const lines = otherTools > 0 ? recovery.slice(otherTools + 1) : recovery;
  return `Tell them exactly this, with nothing about why, then only the line below for the tool they are in: "${said}" ${lines}`;
}

if (target === "enforce-approval-gate") {
  if (approvalGateAwaitsHuman()) {
    process.stderr.write(
      "An approval is waiting for the person's answer, so nothing runs until they give it: end the turn. " +
        `If they already answered, that answer was not recorded. ${unrecordedAnswerRelay(process.cwd())} ` +
        "If that does not fix it, `/aidlc --doctor` shows what else to fix.\n",
    );
    return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
  }
  return 0;
}

// Extract the absolute path of the file a write tool just touched from the
// IDE's toolResult prose. Captured PostToolUse write inputs are empty, so this
// is the ONLY path source on those events. Only the known Kiro wordings match; anything else returns "" so the caller
// can record a visible drop (no silent no-op).
//   fs_write    → "Created the <PATH> file."
//   str_replace → "Replaced text in <PATH>"           (may carry a trailing
//                  " (N occurrences)" or similar suffix — stripped below)
//   fs_append   → "Appended the text to the <PATH> file."
//
// Robustness (finding 4): trim first so a trailing newline does not defeat the
// `$` anchor, and for the open-ended str_replace form stop the capture before a
// trailing " (…)" parenthetical so a "Replaced text in foo.md (2 occurrences)"
// result yields "foo.md", not "foo.md (2 occurrences)".
function extractWrittenPath(toolResult: string): string {
  const s = toolResult.trim();
  let m = s.match(/^Created the (.+) file\.$/);
  if (m) return m[1].trim();
  m = s.match(/^Appended the text to the (.+) file\.$/);
  if (m) return m[1].trim();
  m = s.match(/^Replaced text in (.+?)(?:\s+\([^)]*\))?$/);
  if (m) return m[1].trim();
  return "";
}

// Does this toolResult describe a write that FAILED? Used only to keep the drop
// log honest: a failed write has no artifact to audit, so not forwarding it is
// correct behaviour and must NOT be recorded as harness decay (see the call
// site). The 1.x stdin channel carries no success flag, so error prose is the
// only signal available.
//
// EVIDENCE GRADING — only the first pattern is grounded in a capture:
//   ^Caught an error while   OBSERVED live on IDE 1.x (a str_replace whose old
//                            string matched multiple times). This is the case
//                            that motivated the fix.
//   ^Error:                  DEFENSIVE GUESS. Not observed; no capture in this
//   ^Failed to               repo or in docs/reference/kiro-ide-hook-payload.md
//   ^An error occurred       backs these three shapes.
// They are kept because the risk direction is mild and one-way: a match only
// suppresses a drop when path extraction has ALREADY failed and the payload has
// no structured success flag. Explicit `toolSuccess: true` remains authoritative.
// Masking real decay would therefore require a new flagless SUCCESS wording that
// begins with error prose — and the known success wordings ("Created the …",
// "Replaced text in …", "Appended the text to …") cannot collide with any of
// them. If a capture ever contradicts one, delete it rather than widening the set.
//
// Every pattern is start-anchored on purpose: a loose "contains 'error'" test
// would swallow a successful write to a file whose NAME mentions an error, which
// would hide exactly the decay this log exists to surface. Anything unrecognised
// is treated as a success and still earns a visible drop — the default stays
// biased toward reporting, not toward silence.
function isFailedWriteResult(toolResult: string): boolean {
  const s = toolResult.trim();
  return (
    /^Caught an error while /i.test(s) ||
    /^Error:/i.test(s) ||
    /^Failed to /i.test(s) ||
    /^An error occurred/i.test(s)
  );
}

// The shared guards' Write/Edit/Bash shape for a Kiro write or shell call, or
// null for any other tool. Kiro names the written text `text` (fs_write,
// fs_append; `content` under the 2.6.1 `write`) and a replacement
// `oldStr`/`newStr` (str_replace); the core reads `content` and
// `old_string`/`new_string`.
function guardToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
): { tool_name: string; tool_input: Record<string, unknown> } | null {
  const writeTool = canonicalWriteTool(toolName);
  if (writeTool) {
    const paths = inputPaths(toolArgs);
    const text = typeof toolArgs.text === "string"
      ? toolArgs.text
      : typeof toolArgs.content === "string" ? toolArgs.content : undefined;
    return {
      tool_name: writeTool,
      tool_input: {
        file_path: paths[0] ?? "",
        paths,
        ...(writeTool === "Write" && text !== undefined ? { content: text } : {}),
        ...(toolName === "fs_append" && text !== undefined ? { new_string: text } : {}),
        ...(typeof toolArgs.oldStr === "string" ? { old_string: toolArgs.oldStr } : {}),
        ...(typeof toolArgs.newStr === "string" ? { new_string: toolArgs.newStr } : {}),
        ...(toolArgs.replace_all === true ? { replace_all: true } : {}),
      },
    };
  }
  if (isKiroShellTool(toolName)) {
    return {
      tool_name: "Bash",
      tool_input: { command: typeof toolArgs.command === "string" ? toolArgs.command : "" },
    };
  }
  return null;
}

// The directory a Kiro shell call runs in: its own `cwd`, which every captured
// Kiro shell payload carries, else the project. Its relative paths resolve from
// there; the core finds the project from AIDLC_PROJECT_DIR, not from this.
function shellToolCwd(toolName: string, toolArgs: Record<string, unknown>): string {
  return isKiroShellTool(toolName) && typeof toolArgs.cwd === "string" && toolArgs.cwd !== ""
    ? resolve(projectDir, toolArgs.cwd)
    : projectDir;
}

// What review-freeze and state-transition-guard cannot read in this call, or
// null when they can. Every PreToolUse payload of the supported builds (Kiro
// IDE 1.1.70, Kiro CLI 2.24.1 and later) names the tool and fills its input,
// so a call they cannot read is refused rather than judged as one with no
// target. A readable command that writes nothing still goes to the guards.
function unreadableGuardCall(): string | null {
  if (Object.keys(ide).length === 0) return "no hook payload arrived";
  if ((ide.malformedFields?.length ?? 0) > 0) {
    return `its hook payload is malformed (${ide.malformedFields?.join(", ")})`;
  }
  const toolName = ide.toolName ?? "";
  if (toolName === "") return "its hook payload names no tool";
  const toolArgs = ide.toolArgs ?? {};
  if (canonicalWriteTool(toolName) !== "" && inputPaths(toolArgs).length === 0) {
    return `${toolName} names no file`;
  }
  if (
    isKiroShellTool(toolName) &&
    (typeof toolArgs.command !== "string" || toolArgs.command.trim() === "")
  ) {
    return `${toolName} carries no command`;
  }
  return null;
}

function inputPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) paths.push(value);
  };
  add(input.path);
  add(input.file_path);
  add(input.filePath);
  // `delete_file` names its target `targetFile` and carries no other path field
  // (every captured payload is {explanation, targetFile}). Without it a delete
  // had no target, so Plan Approval treated it as an opaque mutation.
  add(input.targetFile);
  if (Array.isArray(input.paths)) for (const path of input.paths) add(path);
  if (Array.isArray(input.operations)) {
    for (const operation of input.operations) {
      if (isRecord(operation)) add(operation.path);
    }
  }
  return [...new Set(paths)];
}

// Recover the delegated agent's identity from the hook payload.
//
// PRECEDENCE IS AN AUDIT-INTEGRITY PROPERTY, NOT A STYLE CHOICE. The platform
// names the delegate in the dispatch itself — the `subagent_<agent>` tool name
// (#543), `invoke_sub_agent`'s `tool_input.name`, or an `orchestrate_subagent`
// stage's `role` — an identity the delegate cannot author. It therefore WINS
// over the result prose: an incorrect or prompt-injected `**Agent:** <other>`
// line in agent-written output must not be able to misattribute a
// SUBAGENT_COMPLETED row to a different persona while a more authoritative
// identity is available.
//
// The prose markers (`**Reviewer:** <name>` / `**Agent:** <name>`, #459) stay as
// the fallback for a dispatch that names no delegate. With neither, "unknown".
function extractAgentIdentity(toolResult: string, structured = ""): string {
  if (structured.trim() !== "") return structured.trim();
  const lines = toolResult.split("\n").slice(0, 8);
  for (const line of lines) {
    const m = line.match(/^\s*\*\*(?:Reviewer|Agent)\s*:\*\*\s*(.+?)\s*$/);
    if (m) return m[1].replace(/\*+$/, "").trim() || "unknown";
  }
  return "unknown";
}

type Forward = { hook: string; input: Record<string, unknown> } | null;

// A lowered Plan Approval check (Guard Policy relaxed or off, or the person's
// own switch) lets changed content through once the plan is approved, as the
// core guard does; it never supplies the first approval. These refusals are the
// adapter's own, for payloads that hide their target, so they follow the same
// rule: an approved plan that changed since is still approved here, through the
// core's own continuation. An unreadable state keeps the check up.
function loweredPlanCheckAdmitsApprovedWork(): boolean {
  try {
    const state = legacyPlanApprovalGuardState(projectDir);
    if (!state.active || state.target === null) return false;
    if (
      !state.approved &&
      (!codeGenerationExecutionAllowed(projectDir, state.target) || !everyUnitContinuesFromApproval(projectDir))
    ) return false;
    return codeGenerationPlanApprovalFence(projectDir, state.target, {
      sessionId: resolvedPlanApprovalSessionId(ide),
    }).decision === "stand-aside";
  } catch {
    return false;
  }
}

// The chat session a prompt starts, when the prompt names a session other than
// the one this adapter last saw. Set by the record-human-turn route.
let promptSessionStart = "";

function buildForward(): Forward {
  // Ahead of the malformed-payload drop below: for these two guards an
  // unreadable call is refused, whatever the workflow, fence or off-switch.
  if (target === "review-freeze" || target === "state-transition-guard") {
    const unreadable = unreadableGuardCall();
    if (unreadable !== null) {
      return {
        hook: "__unreadable_guard_call__",
        input: {
          reason:
            `AI-DLC cannot check this Kiro tool call: ${unreadable}. ` +
            "AI-DLC supports Kiro IDE 1.1.70 or later and Kiro CLI 2.24.1 or later. If Kiro is older, update it; then try again.",
        },
      };
    }
  }
  if (PAYLOAD_TARGETS.has(target) && (ide.malformedFields?.length ?? 0) > 0) {
    recordHookDrop(
      projectDir,
      "kiro-adapter",
      `${target}: malformed hook context fields (${ide.malformedFields?.join(", ")}) — event not forwarded`,
    );
    if (
      target === "plan-approval-guard" &&
      !ideStandsOutside(projectDir, resolvedPlanApprovalSessionId(ide)) &&
      !loweredPlanCheckAdmitsApprovedWork()
    ) {
      const malformedToolName = ide.toolName ?? "";
      if (
        readPlanApprovalLegacyWindows(projectDir).length > 0 &&
        (
          malformedToolName === "" ||
          mutationCapableTool(malformedToolName)
        )
      ) {
        return {
          hook: "__legacy_plan_approval_block__",
          input: {
            reason:
              `Plan Approval denied a malformed mutation payload while a legacy write recovery latch is active (${ide.malformedFields?.join(", ")}).`,
          },
        };
      }
      if (!codeGenerationIsCurrent(projectDir)) return null;
      return {
        hook: "__legacy_plan_approval_block__",
        input: {
          reason:
            `Plan Approval denied a malformed PreToolUse payload (${ide.malformedFields?.join(", ")}).`,
        },
      };
    }
    return null;
  }

  switch (target) {
    case "session-start": {
      // Modern IDE payloads carry session_id. Legacy promptSubmit does not, so
      // bind the legacy channel to the measured IDE host instance.
      const sessionId =
        ide.sessionId?.trim() ||
        (() => {
          try {
            return legacyPlanApprovalSessionId();
          } catch {
            return LEGACY_SESSION_ID;
          }
          })();
      if (ide.channel === "legacy") {
        markKiroIdeLegacyPlanApprovalHost(projectDir, sessionId);
      } else if (ide.channel === "modern") {
        const legacyHostSession = kiroIdeLegacyPlanApprovalSessionId();
        if (legacyHostSession) {
          clearKiroIdeLegacyPlanApprovalHost(projectDir, legacyHostSession);
        }
      }
      rememberKiroIdeSessionId(sessionId);
      return {
        hook: "aidlc-session-start.ts",
        input: {
          hook_event_name: "SessionStart",
          source: "startup",
          session_id: sessionId,
        },
      };
    }

    case "record-human-turn": {
      recordPreWorkflowHeartbeat(projectDir, "record-human-turn");
      const eventSessionId = ide.sessionId?.trim();
      // Who sent the turn (kiroTurnOrigin): a message Kiro's own chat record
      // marks as its own, or one of Kiro's fixed workflow sentences (a Kiro
      // Workflows step's brief opens with one), is the host's; a session other
      // than the chat's decides nothing by itself, so a message typed in another
      // chat tab stays the person's. A host's turn is a side worker's: it starts no session here, is not
      // remembered as the chat, opens no turn, and the core hook records it as
      // HOST_TURN with nothing of the person's on it. Anything unknown is the
      // person's.
      const origin = kiroTurnOrigin({
        sessionId: eventSessionId,
        chatSessionId: process.env.KIRO_SESSION_ID,
        prompt: ide.userPrompt ?? "",
        templates: KIRO_WORKFLOW_HOST_TEMPLATES,
      });
      if (origin.kind === "host") {
        return {
          hook: "aidlc-record-human-turn.ts",
          input: {
            hook_event_name: "UserPromptSubmit",
            session_id: eventSessionId || terminalSessionId(),
            prompt: ide.userPrompt ?? "",
            origin,
          },
        };
      }
      const sessionId = terminalSessionId();
      // Kiro IDE 1.1.14 runs no SessionStart hook when a chat starts, so a
      // chat's first prompt is the first event that names its session. A prompt
      // from a chat other than the last one seen, or from a chat never started,
      // starts it. A host that does run SessionStart has already started it.
      if (
        eventSessionId &&
        (eventSessionId !== rememberedKiroIdeSessionId() || !sessionStarted(eventSessionId))
      ) {
        promptSessionStart = eventSessionId;
      }
      // Some IDE sessions submit real prompt events without a workspace
      // SessionStart callback. Retain only an event-supplied identity here;
      // never manufacture a current-session marker from the legacy fallback.
      if (eventSessionId) rememberKiroIdeSessionId(eventSessionId);
      // The chat's turn is open until its Stop, so `next` can tell which chats
      // may be running a command (#2023, aidlc-rules-held.ts).
      noteKiroIdeTurn(projectDir, eventSessionId, true);
      recordPromptEmpty(sessionId, readTurn(sessionId) || bumpTurn(sessionId));
      if (promptEmpty && !ideStandsOutside(projectDir, resolvedPlanApprovalSessionId(ide))) {
        try {
          const migration = normalizeRetiredGuardPolicyField(projectDir, sessionId);
          if (migration.normalized) {
            process.stdout.write(
              `SYSTEM (AIDLC Guard Policy migration): kept ${migration.value} and renamed the active intent's retired Change Control field to Guard Policy.\n`,
            );
          }
        } catch (error) {
          // The prompt must remain usable; an unchanged field keeps the normal
          // repeating migration notice as its recovery path.
          recordHookDrop(
            projectDir,
            "kiro-adapter",
            `Guard Policy field migration failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (process.env.AIDLC_DEBUG === "1") {
            process.stderr.write(
              `Guard Policy field migration failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            );
          }
        }
      }
      if (ide.channel === "legacy") {
        markKiroIdeLegacyPlanApprovalHost(projectDir, sessionId);
      }
      return {
        hook: "aidlc-record-human-turn.ts",
        input: {
          hook_event_name: "UserPromptSubmit",
          session_id: sessionId,
          prompt: ide.userPrompt ?? "",
          origin,
        },
      };
    }

    case "plan-approval-guard": {
      const toolName = ide.toolName ?? "";
      const toolArgs = ide.toolArgs ?? {};
      if (ide.channel === "legacy") {
        try {
          markKiroIdeLegacyPlanApprovalHost(
            projectDir,
            legacyPlanApprovalSessionId(),
          );
        } catch {
          // The guard's missing-authority branches below remain fail closed.
        }
      }
      const writeTool = canonicalWriteTool(toolName);
      const paths = inputPaths(toolArgs);
      const activeWriteWindows = readPlanApprovalLegacyWindows(projectDir);
      if (
        activeWriteWindows.length > 0 &&
        (toolName === "" || mutationCapableTool(toolName)) &&
        !ideStandsOutside(projectDir, resolvedPlanApprovalSessionId(ide))
      ) {
        let recoverySession = resolvedPlanApprovalSessionId(ide);
        try {
          recoverySession = legacyPlanApprovalSessionId();
          markKiroIdeLegacyPlanApprovalHost(projectDir, recoverySession);
        } catch {
          // Missing host identity remains fail closed below.
        }
        if (isKiroShellTool(toolName)) {
          const recovery = runLegacyRecoveryNext(
            projectDir,
            recoverySession,
          );
          return {
            hook: "__legacy_plan_approval_block__",
            input: { reason: legacyRecoveryBlockReason(recovery) },
          };
        }
        return {
          hook: "__legacy_plan_approval_block__",
          input: {
            reason:
              "Plan Approval blocked this mutation because a legacy write did not complete PostToolUse mediation. Exact human recovery is required before any legacy or modern write.",
          },
        };
      }
      // Delegation is attributable and must NOT be treated as opaque: falling into the
      // block below either refuses it outright or returns null (no mediation at all),
      // and both are wrong. Excluding it here lets control reach the delegation forward,
      // which hands a synthetic `Task` to the core guard so approval state decides.
      const opaqueMutation =
        toolName === "" ||
        (
          mutationCapableTool(toolName) &&
          !isKiroDelegationTool(toolName) &&
          (
            Object.keys(toolArgs).length === 0 ||
            (
              !isKiroShellTool(toolName) &&
              paths.length === 0
            )
          )
        );
      if (opaqueMutation && !ideStandsOutside(projectDir, resolvedPlanApprovalSessionId(ide))) {
        const approvalSession = resolvedPlanApprovalSessionId(ide);
        const state = legacyPlanApprovalGuardState(projectDir);
        const writeWindows = readPlanApprovalLegacyWindows(projectDir);
        if (
          (!state.active || state.target === null) &&
          writeWindows.length > 0
        ) {
          if (isKiroShellTool(toolName)) {
            const recovery = runLegacyRecoveryNext(projectDir, approvalSession);
            return {
              hook: "__legacy_plan_approval_block__",
              input: {
                reason: legacyRecoveryBlockReason(recovery),
              },
            };
          }
          return {
            hook: "__legacy_plan_approval_block__",
            input: {
              reason:
                "Legacy Plan Approval blocked this tool because the preceding argument-less write destroyed or invalidated its authority files. Repair authority or use the adapter-owned recovery shell path.",
            },
          };
        }
        let interruptedWrite = false;
        if (writeWindows.length > 0 && state.active && state.target !== null) {
          try {
            const authority = resolveCodeGenerationAuthority(
              projectDir,
              state.target,
            );
            interruptedWrite = writeWindows.some((window) =>
              authority.markerRevision === window.markerRevision &&
              authority.targetId === window.targetId &&
              authority.unit === window.unit
            );
          } catch {
            interruptedWrite = true;
          }
        }
        if (interruptedWrite && !state.approved) {
          if (isKiroShellTool(toolName)) {
            const recovery = runLegacyRecoveryNext(projectDir, approvalSession);
            return {
              hook: "__legacy_plan_approval_block__",
              input: {
                reason: legacyRecoveryBlockReason(recovery),
              },
            };
          }
          return {
            hook: "__legacy_plan_approval_block__",
            input: {
              reason:
                "Legacy Plan Approval blocked this tool because the preceding argument-less write did not complete PostToolUse mediation. Exact human recovery is required before another write.",
            },
          };
        }
        if (!state.active) {
          const statePath = stateFilePath(projectDir);
          const durableCodeGeneration =
            existsSync(statePath) &&
            getField(readFileSync(statePath, "utf-8"), "Current Stage")
              ?.trim()
              .toLowerCase()
              .replace(/\s+/g, "-") === "code-generation";
          if (durableCodeGeneration && isKiroShellTool(toolName)) {
            const recovery = runLegacyRecoveryNext(projectDir, approvalSession);
            return {
              hook: "__legacy_plan_approval_block__",
              input: {
                reason: legacyRecoveryBlockReason(recovery),
              },
            };
          }
          if (durableCodeGeneration) {
            return {
              hook: "__legacy_plan_approval_block__",
              input: {
                reason:
                  "Plan Approval fallback blocked this tool because Code Generation authority state is missing or corrupt.",
              },
            };
          }
        }
        if (state.active && state.violated) {
          if (isKiroShellTool(toolName)) {
            const recovery = runLegacyRecoveryNext(projectDir, approvalSession);
            return {
              hook: "__legacy_plan_approval_block__",
              input: {
                reason: legacyRecoveryBlockReason(recovery),
              },
            };
          }
          return {
            hook: "__legacy_plan_approval_block__",
            input: {
              reason:
                "Legacy Plan Approval was poisoned by an unsupported write target. Run a fresh `next` to issue a new directive before continuing.",
            },
          };
        }
        // An approved plan that changed since, under a lowered check, builds on.
        if (state.active && !state.approved && state.target !== null && loweredPlanCheckAdmitsApprovedWork()) {
          try {
            beginCodeGeneration(projectDir, state.target);
          } catch (error) {
            return {
              hook: "__legacy_plan_approval_block__",
              input: {
                reason:
                  `Legacy Code Generation could not start its protected authority: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
              },
            };
          }
          return null;
        }
        // Under a lowered check the person's answer accepts source drift, so
        // the plan is not shown again: the checks below wait while the question
        // is open, and name the answer's own write once the person has replied.
        let lowered = false;
        if (state.active && !state.approved && !state.sourceFloorValid && state.target !== null) {
          try {
            lowered = codeGenerationPlanApprovalFence(projectDir, state.target, {
              sessionId: resolvedPlanApprovalSessionId(ide),
            }).decision === "stand-aside";
          } catch {
            lowered = false;
          }
        }
        if (
          state.active &&
          !state.approved &&
          !state.sourceFloorValid &&
          !lowered &&
          !isLegacyPlanningWriteTool(toolName)
        ) {
          // The canonical planning writes stay open: re-presenting the plan is
          // the remedy, and it is a questions-file write. Blocking it here made
          // source drift before approval a dead end on this harness.
          return {
            hook: "__legacy_plan_approval_block__",
            input: {
              reason:
                "Plan Approval fallback blocked this tool because workspace source changed after the plan's source was recorded. Re-present the plan: write the Plan Approval section again with a blank [Answer]: so the write hook refreshes [Planned Source] and re-issues the decision, then approve.",
            },
          };
        }
        if (
          state.active &&
          !state.approved &&
          state.pending &&
          !state.humanAfterDecision
        ) {
          return {
            hook: "__legacy_plan_approval_block__",
            input: {
              reason:
                "Plan Approval is awaiting a human response. This Kiro IDE payload does not expose the tool target, so tool calls are blocked until the human answers.",
            },
          };
        }
        if (
          state.active &&
          state.approved &&
          state.target !== null &&
          (toolName === "" || mutationCapableTool(toolName))
        ) {
          try {
            beginCodeGeneration(projectDir, state.target);
          } catch (error) {
            return {
              hook: "__legacy_plan_approval_block__",
              input: {
                reason:
                  `Legacy Code Generation could not start its protected authority: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
              },
            };
          }
          if (loweredPlanCheckAdmitsApprovedWork()) return null;
        }
        if (
          state.active &&
          !state.approved &&
          (
            toolName === "" ||
            isKiroShellTool(toolName) ||
            isKiroAppendTool(toolName)
          )
        ) {
          return {
            hook: "__legacy_plan_approval_block__",
            input: {
              reason:
                "Legacy Plan Approval blocks opaque shell and append tools before approval. Author only the canonical plan, unit-test instructions, and questions files with fs_write/str_replace; the write hook injects the Testing Contract and owns fingerprint, decision, and answer recording.",
            },
          };
        }
        if (
          toolName === "" ||
          mutationCapableTool(toolName)
        ) {
          if (
            state.active &&
            !state.approved &&
            !isLegacyPlanningWriteTool(toolName)
          ) {
            return {
              hook: "__legacy_plan_approval_block__",
              input: {
                reason:
                  "Legacy Plan Approval permits only single-file planning writes before approval; this mutation-capable tool is not safely attributable.",
              },
            };
          }
          if (
            isLegacyPlanningWriteTool(toolName) &&
            state.target !== null
          ) {
            try {
              const authority = resolveCodeGenerationAuthority(
                projectDir,
                state.target,
              );
              writePlanApprovalLegacyWindow(projectDir, {
                version: 1,
                session: approvalSession,
                toolName,
                markerRevision: authority.markerRevision,
                targetId: authority.targetId,
                unit: authority.unit,
              });
            } catch (error) {
              return {
                hook: "__legacy_plan_approval_block__",
                input: {
                  reason:
                    `Legacy Plan Approval could not preserve its pre-write authority: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                },
              };
            }
          }
          // Only an active Code Generation window can refuse an unattributable
          // mutation. With no workflow this adapter has nothing to protect, and
          // denying here is what kept a Windows shell (`execute_pwsh`) from ever
          // running `aidlc-orchestrate.ts next` to start one.
          if (state.active && Object.keys(toolArgs).length > 0 && !isKiroShellTool(toolName)) {
            // A populated payload with no path the adapter can read goes to the
            // core guard under its own name, which decides an unlisted tool as
            // it does on every harness: held before approval, run after it.
            // A payload with no tool name gives the guard nothing to decide.
            if (toolName === "") {
              return {
                hook: "__legacy_plan_approval_block__",
                input: {
                  reason:
                    "Plan Approval blocked a mutation-capable payload whose target path is missing or unsupported.",
                },
              };
            }
            return {
              hook: "aidlc-plan-approval-guard.ts",
              input: {
                hook_event_name: "PreToolUse",
                tool_name: toolName,
                tool_input: toolArgs,
                cwd: projectDir,
              },
            };
          }
          // Legacy planning and post-human answer recording remain usable. The
          // planned-source binding prevents any workspace mutation in this
          // opaque window from being authorized by the later receipt: the
          // answer refuses when live source differs from the recorded tag.
          return null;
        }
      }
      if (toolName === "") return null;
      if (isPlanApprovalSafeReadTool(toolName)) return null;
      if (writeTool) {
        return {
          hook: "aidlc-plan-approval-guard.ts",
          input: {
            hook_event_name: "PreToolUse",
            tool_name: writeTool,
            tool_input: {
              file_path: paths[0] ?? "",
              paths,
            },
            cwd: projectDir,
          },
        };
      }
      if (isKiroShellTool(toolName)) {
        return {
          hook: "aidlc-plan-approval-guard.ts",
          input: {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: {
              command:
                typeof toolArgs.command === "string" ? toolArgs.command : "",
            },
            cwd: shellToolCwd(toolName, toolArgs),
            // The guard reads a PowerShell command the way PowerShell runs it.
            ...(isKiroPowerShellTool(toolName) ? { aidlc_shell: "powershell" } : {}),
          },
        };
      }
      if (isKiroDelegationTool(toolName)) {
        const generic = isKiroGenericDelegationTool(toolName);
        const named = kiroDelegationTargets(toolName, toolArgs);
        // A generic dispatch that names no delegate (or a pipeline with no
        // stage) is treated as guarded generation rather than letting an
        // ambiguous trusted-agent dispatch bypass the Code Generation floor.
        const targets = (named.length > 0
          ? named
          : [{ agent: "", prompt: firstNonBlank([toolArgs.task]), stage: "" }]
        ).map((t) => generic && t.agent === "" ? { ...t, agent: "aidlc-developer-agent" } : t);
        const taskInput = (t: KiroDelegationTarget) => ({
          hook_event_name: "PreToolUse",
          tool_name: "Task",
          tool_input: { subagent_type: t.agent, prompt: t.prompt },
          cwd: projectDir,
        });
        const developers = targets.filter((t) => t.agent === "aidlc-developer-agent");
        // The core guard decides, and starts generation for, one dispatch at a
        // time. A pipeline carrying two developer stages would be decided stage
        // by stage, so a later refusal could leave an earlier start recorded;
        // during Code Generation, refuse it before any stage is decided. Outside
        // that stage the core guard allows every dispatch, so the pipeline goes
        // through as it would without AI-DLC.
        if (developers.length > 1 && codeGenerationIsCurrent(projectDir) && !ideStandsOutside(projectDir, resolvedPlanApprovalSessionId(ide))) {
          return {
            hook: "__legacy_plan_approval_block__",
            input: {
              reason:
                "Plan Approval decides one aidlc-developer-agent per dispatch: " +
                "send each developer stage in its own orchestrate_subagent call.",
            },
          };
        }
        // Outside Code Generation, several developer stages go to the core guard
        // as one dispatch carrying every developer stage's prompt: a plan marker
        // on any stage then makes the whole pipeline a guarded dispatch, rather
        // than the first stage's prompt deciding for the rest.
        const forwarded = developers.length > 1
          ? { ...developers[0], prompt: developers.map((t) => t.prompt).join("\n") }
          : developers[0] ?? (generic ? targets[0] : undefined);
        if (forwarded) {
          return { hook: "aidlc-plan-approval-guard.ts", input: taskInput(forwarded) };
        }
        if (generic) return null;
      }
      return {
        hook: "aidlc-plan-approval-guard.ts",
        input: {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolArgs,
          cwd: projectDir,
        },
      };
    }

    // Kiro runs a project PreToolUse hook on a delegated agent's own calls too,
    // under the conductor's session and with no agent identity (measured on
    // IDE 1.2.4), so both guards judge a delegate's call as the conductor's.
    case "review-freeze":
    case "state-transition-guard": {
      const toolArgs = ide.toolArgs ?? {};
      const call = guardToolCall(ide.toolName ?? "", toolArgs);
      if (call === null) return null;
      return {
        hook: target === "review-freeze"
          ? "aidlc-review-freeze.ts"
          : "aidlc-state-transition-guard.ts",
        input: {
          hook_event_name: "PreToolUse",
          ...call,
          cwd: shellToolCwd(ide.toolName ?? "", toolArgs),
          // Both guards read a PowerShell command the way PowerShell runs it.
          ...(isKiroPowerShellTool(ide.toolName ?? "") ? { aidlc_shell: "powershell" } : {}),
        },
      };
    }
    case "audit-and-sensors": {
      // postToolUse(write) → write-audit-log THEN run-sensors (both ship core).
      // Captured PostToolUse write inputs are empty, so the file path comes
      // from the toolResult prose.
      //
      // A FAILED write must not be audited as a successful artifact update
      // (#417): the 0.12 channel sets toolSuccess=false and toolResult carries
      // error prose, and relying on that prose failing to match
      // extractWrittenPath's patterns is implicit — guard it explicitly. Only
      // false is treated as a failure; an absent success flag (the 1.x stdin
      // channel carries none) falls through to the path check so an
      // unknown-shape payload is never silently dropped here.
      if (ide.toolSuccess === false) {
        if (
          canonicalWriteTool(ide.toolName ?? "") !== "" &&
          Object.keys(ide.toolArgs ?? {}).length === 0
        ) {
          clearPlanApprovalLegacyWindow(
            projectDir,
            resolvedPlanApprovalSessionId(ide),
          );
        }
        return null;
      }
      // A payload target that ends up with NO context at all means acquisition
      // failed on both channels (stdin raced out AND USER_PROMPT was empty) —
      // a broken channel, not a legitimate no-op. Record a visible drop before
      // the tool-name check so `--doctor` can surface it; falling through would
      // exit silently at `canon === ""`, which is exactly the invisible-decay
      // failure class this harness exists to eliminate. Distinguished from a
      // non-write tool name (which DOES carry context and is a real no-op).
      if (!ide.toolName && (ide.toolResult ?? "").trim() === "") {
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          "audit-and-sensors: empty hook context (no stdin payload, no USER_PROMPT) — write not audited",
        );
        return null;
      }
      const canon = canonicalWriteTool(ide.toolName ?? "");
      if (canon === "") return null;
      const rawPath = extractWrittenPath(ide.toolResult ?? "");
      if (!rawPath) {
        // TWO DISTINCT CASES REACH HERE, and conflating them is what made the
        // drop log useless as a health signal:
        //   (a) The write FAILED. There is no artifact to audit, so not
        //       forwarding is CORRECT, not decay. The 1.x stdin channel carries
        //       no success flag (so the `toolSuccess === false` guard above
        //       cannot catch it), and the failure arrives only as error prose —
        //       e.g. a str_replace whose old string matched multiple times.
        //   (b) The write SUCCEEDED but its result wording matched no known
        //       pattern. THIS is the invisible decay this harness exists to
        //       eliminate, and the only case that belongs in the drop log.
        // Recording (a) as a drop made `--doctor` report decay on a workspace
        // whose hooks were working perfectly, which trains the reader to ignore
        // the channel that matters. So classify flagless payloads first: log (a)
        // at debug level and reserve the visible drop for (b). A structured
        // `toolSuccess: true` is authoritative and must never be overridden by
        // defensive prose guesses.
        if (ide.toolSuccess === undefined && isFailedWriteResult(ide.toolResult ?? "")) {
          if (Object.keys(ide.toolArgs ?? {}).length === 0) {
            clearPlanApprovalLegacyWindow(
              projectDir,
              resolvedPlanApprovalSessionId(ide),
            );
          }
          hookDebug(projectDir, "kiro-adapter", "audit-and-sensors: write failed, nothing to audit", {
            toolName: ide.toolName ?? "?",
            toolResult: (ide.toolResult ?? "").slice(0, 160),
          });
          return null;
        }
        if (Object.keys(ide.toolArgs ?? {}).length === 0) {
          try {
            const state = legacyPlanApprovalGuardState(projectDir);
            const writeWindow = readPlanApprovalLegacyWindow(
              projectDir,
              resolvedPlanApprovalSessionId(ide),
            );
            if (state.active && !state.approved && state.target !== null) {
              const authority = resolveCodeGenerationAuthority(
                projectDir,
                state.target,
              );
              writePlanApprovalViolation(projectDir, {
                version: 1,
                markerRevision: authority.markerRevision,
                reason: "legacy write target was not recoverable",
                target: "(unresolved write target)",
              });
            } else if (writeWindow) {
              writePlanApprovalViolation(projectDir, {
                version: 1,
                markerRevision: writeWindow.markerRevision,
                reason: "legacy write target was not recoverable after authority loss",
                target: "(unresolved write target)",
              });
            }
          } catch {
            // The next protected call still fails closed on missing authority.
          }
        }
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          `audit-and-sensors: ${ide.toolName ?? "?"} yielded no extractable path from toolResult: ${(ide.toolResult ?? "").slice(0, 120)}`,
        );
        return null;
      }
      // Kiro IDE reports the path RELATIVE to the workspace root; the core hooks
      // compare against an ABSOLUTE record root, so resolve it here. Absolute
      // paths (defensive) pass through untouched.
      const filePath = isAbsolute(rawPath) ? rawPath : resolve(projectDir, rawPath);
      return {
        hook: "__audit_and_sensors__", // handled specially below (two hooks)
        input: {
          hook_event_name: "PostToolUse",
          session_id: ide.sessionId?.trim() || rememberedKiroIdeSessionId(),
          tool_name: canon,
          tool_input: { file_path: filePath },
        },
      };
    }

    case "rebuild-stage-graph": {
      // The IDE does not surface the shell command (toolResult is only
      // stdout+exit), so the command filter cannot run here. The
      // ide-audit-sync marker tells the core hook to skip the command filter
      // and gate purely on the audit tail (idempotent + cheap); its own
      // MEMORY_EMPTY emit is not in the transition regex (no recursion).
      return {
        hook: "aidlc-rebuild-stage-graph.ts",
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "", source: "ide-audit-sync" },
          session_id: ide.sessionId?.trim() || rememberedKiroIdeSessionId(),
          tool_response: ide.toolResult ?? "",
        },
      };
    }

    case "sync-workflow-state": {
      // Payload-independent. The IDE gives no task payload (toolArgs is empty),
      // so instead of extracting a slug from the tool call, the core hook reads
      // the latest STAGE_STARTED slug from the audit tail and reconciles the
      // state file's Current Stage. The IDE_AUDIT_SYNC marker tells the core
      // hook to take that audit-tail path rather than parse a TaskUpdate.
      return {
        hook: "aidlc-sync-workflow-state.ts",
        input: {
          hook_event_name: "PostToolUse",
          session_id: ide.sessionId?.trim() || rememberedKiroIdeSessionId(),
          tool_name: "TaskUpdate",
          tool_input: { source: "ide-audit-sync" },
        },
      };
    }

    case "log-subagent": {
      // Kiro has emitted `invoke_sub_agent`, `subagent_<agent>` and, on Kiro CLI,
      // `orchestrate_subagent` for real delegate completions (#543).
      //
      // DIVISION OF RESPONSIBILITY: the v2 matcher is deliberately BROAD
      // (`^(subagent_.+|invoke_sub_agent|orchestrate_subagent)$`) so a fork-added delegate whose
      // name does not end in `-agent` still reaches this adapter; narrowing the
      // regex there would silently drop those completions. The exclusion of
      // `subagent_response` — the empty "Response recorded." shell that carries
      // non-empty prose but no identity, and would otherwise fabricate a
      // SUBAGENT_COMPLETED row with `Agent Type: unknown` — lives HERE, where it
      // also covers the direct and dispatcher entry points that bypass the
      // matcher entirely.
      const toolName = ide.toolName ?? "";
      const result = ide.toolResult ?? "";
      // A completely empty context means acquisition failed on both channels.
      // Check it before the tool-name gate; otherwise the empty name returns as
      // a legitimate non-delegate no-op and the broken channel stays invisible.
      if (toolName === "" && result.trim() === "") {
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          "log-subagent: empty hook context (no stdin payload, no USER_PROMPT) — SUBAGENT_COMPLETED not recorded",
        );
        return null;
      }

      if (!isKiroDelegationTool(toolName)) return null;

      // Identity comes from the dispatch's own structured field when the
      // platform supplies one, and only otherwise from the result's
      // `**Reviewer:**` / `**Agent:**` prose (#459). Agent-authored prose must
      // not override a platform-provided identity. Forward the result text so
      // SUBAGENT_COMPLETED also carries an output snippet.
      //
      // An EMPTY result on an otherwise recognized completion must NOT
      // fabricate a real SUBAGENT_COMPLETED row. Record a visible drop so
      // --doctor can surface the degradation.
      if (result.trim() === "") {
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          "log-subagent: empty tool payload — SUBAGENT_COMPLETED not recorded",
        );
        return null;
      }
      const sessionId = ide.sessionId?.trim() || rememberedKiroIdeSessionId();
      const completion = (t: KiroDelegationTarget | undefined) => {
        const output = isKiroPipelineDelegationTool(toolName)
          ? orchestrateStageOutput(result, t?.stage ?? "")
          : result;
        return {
          hook_event_name: "SubagentStop",
          session_id: sessionId,
          agent_type: extractAgentIdentity(output, t?.agent ?? ""),
          agent_id: "",
          last_assistant_message: output,
        };
      };
      const targets = kiroDelegationTargets(toolName, ide.toolArgs ?? {});
      if (targets.length === 0) {
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          "log-subagent: orchestrate_subagent payload names no stage — SUBAGENT_COMPLETED not recorded",
        );
        return null;
      }
      // A pipeline finishes every stage in one result: one row per stage, the
      // last through the ordinary forward.
      for (const t of targets.slice(0, -1)) {
        const r = runCore("aidlc-log-subagent.ts", completion(t));
        if (r.code !== 0) {
          recordHookDrop(
            projectDir,
            "kiro-adapter",
            `log-subagent: stage ${t.stage || t.agent} not recorded: ${r.stderr.trim() || `exit ${r.code}`}`,
          );
        }
      }
      return { hook: "aidlc-log-subagent.ts", input: completion(targets.at(-1)) };
    }

    case "continue-workflow":
      // ADVISORY ONLY ON THIS HARNESS. The IDE's `Stop` trigger cannot block and
      // does not forward the hook's output — matching what
      // aidlc-continue-workflow.json and the kiro-ide guide have always said.
      // Measured live on IDE 1.x with a probe hook: the command RAN (witness
      // file written), and neither its stdout nor its stderr reached the
      // agent's context. The Stop payload is only
      // `{session_id, hook_event_name, cwd}` — no transcript, no turn id. Kiro
      // documents `Stop` outside the blockable set (only PreToolUse,
      // UserPromptSubmit and PreTaskExec can block) and forwards stdout only for
      // SessionStart and UserPromptSubmit. There is no `{"decision":"block"}`
      // contract in Kiro for any trigger; that shape is Claude Code's.
      //
      // So the core hook still runs and its side effects are what matter here:
      // the `continue-workflow.drops` carve-out record and the no-progress
      // counter under `.aidlc-engine/stop-hook/`. Its `{"decision":"block"}` stdout is
      // produced and then discarded by the host. Forwarding-loop enforcement on
      // the IDE therefore rests on the conductor's own Stop protocol, NOT on
      // this hook. (An earlier revision of this comment claimed the block
      // contract was "identical to Claude's". It never was; the probe above
      // settles it.)
      //
      // Kiro also provides no `stop_hook_active`, so the flag defaults to false.
      // That makes decideBlock's `prior === null && stopHookActive` seeding branch
      // unreachable here: a hook joining an already-in-flight block sequence
      // starts its count at 1 instead of 2, i.e. one extra counted block before
      // releasing. The ceiling is run-mode aware (INTERACTIVE_BLOCK_CAP=2,
      // AUTONOMOUS_BLOCK_CAP=8), not the fixed 8 a still earlier revision promised.
      //
      // The absent transcript no longer leaves the conversational carve-out inert:
      // the core hook falls back to the `.aidlc-engine/human-turn` / `.aidlc-engine/engine-touch`
      // mtime comparison, and the `record-human-turn` target above writes the
      // former. On this harness that changes which record
      // `continue-workflow.drops` gets and whether the counter advances — not
      // what the human sees.
      // Modern Stop carries the exact chat identity. Prefer it over the
      // workspace-global SessionStart marker so concurrent chats cannot consume
      // one another's post-create or post-switch handoff receipt; retain the
      // marker for legacy agentStop and broken modern channels.
      noteKiroIdeTurn(projectDir, ide.sessionId?.trim(), false);
      return {
        hook: "aidlc-continue-workflow.ts",
        input: {
          hook_event_name: "Stop",
          stop_hook_active: false,
          session_id: ide.sessionId?.trim() || rememberedKiroIdeSessionId(),
        },
      };

    case "session-end":
      return {
        hook: "aidlc-session-end.ts",
        input: {
          hook_event_name: "SessionEnd",
          reason: "agent_stop",
          session_id: rememberedKiroIdeSessionId(),
        },
      };

    default:
      return null;
  }
}

function runCore(
  hookFile: string,
  input: Record<string, unknown>,
): { stdout: string; stderr: string; code: number } {
  // Reuse the exact bun binary running this adapter; the child must not depend on
  // PATH containing bun (the hook environment often lacks the bun install dir).
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const hook = hookFile.replace(/^aidlc-|\.ts$/g, "");
  const authorityToken = hook === "record-human-turn" ? randomUUID() : "";
  const command = executable
    ? authorityToken
      ? [executable, "--internal-aidlc-record-human-turn", join(HOOKS_DIR, hookFile)]
      : [executable, "engine", "hook", hook]
    : authorityToken
      ? [
          process.execPath,
          join(HOOKS_DIR, "..", "tools", "aidlc.ts"),
          "--internal-aidlc-record-human-turn",
          join(HOOKS_DIR, hookFile),
        ]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
  // The core hook runs from the same payload, so hand it this adapter's project
  // rather than let it derive one from its own path.
  const env = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
  };
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(JSON.stringify(input), "utf-8"),
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectDir,
    env: authorityToken
      ? { ...env, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: authorityToken }
      : env,
  });
  return {
    stdout: new TextDecoder("utf-8").decode(
      r.stdout ?? new Uint8Array(),
    ),
    stderr: r.stderr?.toString() ?? "",
    code: r.exitCode ?? 0,
  };
}

// The turn's end is judged on what its last write or command did.
if (target === "continue-workflow") await catchUpPendingCalls("turn-end");
const fwd = buildForward();
if (fwd === null) {
  hookDebug(projectDir, "kiro-adapter", "forward: null (no-op)", { target });
  return 0;
}
if (fwd.hook === "__legacy_plan_approval_block__") {
  // The switch that turns the Plan Approval check off turns the adapter's own
  // refusals off too, as it turns off the core guard before it reads anything.
  if (resolveProjectFlag("AIDLC_DISABLE_PLAN_APPROVAL_GUARD", process.env, projectDir) === "1") return 0;
  process.stderr.write(`${String(fwd.input.reason ?? "Plan Approval blocked this tool.")}\n`);
  return 2;
}
if (fwd.hook === "__unreadable_guard_call__") {
  process.stderr.write(`${String(fwd.input.reason)}\n`);
  return 2;
}
hookDebug(projectDir, "kiro-adapter", "forward", {
  target,
  hook: fwd.hook,
  tool_name: fwd.input.tool_name ?? "",
  file_path: (fwd.input.tool_input as { file_path?: string } | undefined)?.file_path ?? "",
});

if (fwd.hook === "__audit_and_sensors__") {
  const filePath =
    (fwd.input.tool_input as { file_path?: string } | undefined)?.file_path ?? "";
  if (
    filePath &&
    Object.keys(ide.toolArgs ?? {}).length === 0 &&
    !ideStandsOutside(projectDir, resolvedPlanApprovalSessionId(ide))
  ) {
    let mediationFailure: string | null = null;
    try {
      processLegacyPlanApprovalWrite(
        projectDir,
        filePath,
        ide.sessionId?.trim() || legacyPlanApprovalSessionId(),
      );
    } catch (error) {
      if (error instanceof LegacyPlanApprovalMediationError) {
        mediationFailure = error.message;
      } else {
        // An environment precondition (no host identity) failed before any
        // mediation was in play; the write is not a Plan Approval write.
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          `legacy Plan Approval mediation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (mediationFailure !== null) {
      // The write already happened; the two advisory hooks below still ride the
      // event. The mediation failure itself is surfaced as a visible block
      // reason rather than a silent drop, because the legacy write window stays
      // latched until the human recovers and a silent exit 0 hid why.
      runCore("aidlc-write-audit-log.ts", fwd.input);
      runCore("aidlc-run-sensors.ts", fwd.input);
      process.stderr.write(
        `Legacy Plan Approval mediation did not complete for this write: ${mediationFailure}\n`,
      );
      return 2;
    }
  }
  // Two core hooks ride the same write event, in audit-then-sensors order
  // (mirrors the Claude settings.json registration). Both advisory: exit 0.
  runCore("aidlc-write-audit-log.ts", fwd.input);
  runCore("aidlc-run-sensors.ts", fwd.input);
  return 0;
}

// The core guards judge the workflow of the session named in their payload; the
// routes above build their input from the tool call alone. Legacy events carry no
// session id, so send the host-derived identity SessionStart bound instead.
if (
  fwd.hook === "aidlc-plan-approval-guard.ts" ||
  fwd.hook === "aidlc-review-freeze.ts" ||
  fwd.hook === "aidlc-state-transition-guard.ts"
) {
  fwd.input.session_id = resolvedPlanApprovalSessionId(ide);
}
// A prompt that starts its chat's session runs session-start first, as
// SessionStart would have: the core hook binds the session, records its process
// ancestry, and returns the `AIDLC Runtime Session:` line or the workflow
// context, which go ahead of the prompt hook's own text. A session this adapter
// started before resumes, and so does one a SessionStart started before this
// record existed: it left a binding, or on older releases only an intent stamp,
// which the core hook follows only on resume.
const sessionStartResult = promptSessionStart
  ? runCore("aidlc-session-start.ts", {
      hook_event_name: "SessionStart",
      source:
        sessionStarted(promptSessionStart) ||
        readSessionBinding(projectDir, promptSessionStart) ||
        readSessionIntentUuid(projectDir, promptSessionStart)
          ? "resume"
          : "startup",
      session_id: promptSessionStart,
    })
  : null;
if (sessionStartResult?.code === 0) markSessionStarted(promptSessionStart);
const result = runCore(fwd.hook, fwd.input);
if (target === "session-start" && result.code === 0) {
  markSessionStarted(String(fwd.input.session_id ?? ""));
}

if (target === "session-start" || target === "record-human-turn") {
  // Unwrap {"additionalContext": ...} → plain text on stdout (Kiro's context
  // channels). Anything unparseable passes through untouched.
  const contextText = (stdout: string): string => {
    try {
      const parsed = JSON.parse(stdout) as { additionalContext?: string };
      return parsed.additionalContext
        ? sanitizeHarnessPlainText(parsed.additionalContext)
        : "";
    } catch {
      return stdout ? sanitizeHarnessPlainText(stdout) : "";
    }
  };
  const texts = [sessionStartResult?.stdout ?? "", result.stdout]
    .map(contextText)
    .filter((text) => text !== "");
  process.stdout.write(texts.join("\n"));
  return 0;
}

// Preserve the core hook's stdout and exit code for passthrough targets. On
// Kiro IDE 1.x the host discards Stop-hook output, so this relay does not imply
// a shared `{"decision":"block","reason"}` contract.
if (result.stdout) process.stdout.write(result.stdout);
if (result.code === 2 && result.stderr) process.stderr.write(result.stderr);
return result.code;
}

// The broken-channel ceiling for the 1.x stdin read. 2s in production; the
// AIDLC_IDE_STDIN_TIMEOUT_MS seam lets the latency tests raise it far above any
// plausible CI scheduling delay, so "did this path probe stdin at all?" becomes
// a deterministic assertion instead of a tight millisecond budget.
function stdinTimeoutMs(): number {
  const override = Number(process.env.AIDLC_IDE_STDIN_TIMEOUT_MS ?? "");
  return Number.isFinite(override) && override > 0 ? override : 2000;
}

async function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((settle) => {
        timeout = setTimeout(() => settle(""), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

if (import.meta.main) {
  const target = process.argv[2] ?? "";
  // Acquire input only for targets that need tool payload, session identity, or
  // the human response text. A non-empty
  // USER_PROMPT identifies the 0.12 channel and is consumed immediately: that
  // IDE leaves stdin open forever, so probing stdin first imposed a mandatory
  // 2s delay on every payload hook. IDE 1.x sends USER_PROMPT empty and writes
  // + closes stdin; retain the timeout only as a defensive broken-channel
  // ceiling. Every other target skips both channels (zero latency).
  let input = "";
  if (INPUT_TARGETS.has(target)) {
    const legacyPayload = process.env.USER_PROMPT ?? "";
    if (legacyPayload.trim().length > 0) {
      input = legacyPayload;
    } else if (!process.stdin.isTTY) {
      try {
        input = await readStdinWithTimeout(stdinTimeoutMs());
      } catch {
        input = "";
      }
    }
  }
  process.exit(await run(target, input, process.argv.slice(3)));
}
