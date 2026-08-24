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
//      command as execute_pwsh. Newer builds may provide the prompt directly.
//
// Payload acquisition is GATED to tool-payload targets, the deterministic
// terminal-command seams, and lifecycle boundaries that carry modern session
// identity (SessionStart and Stop). Every other target is payload-independent
// and never touches stdin — block fires on EVERY PreToolUse, and a 2s stall on
// a never-closing stdin there would be felt on every tool call.
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
//     utilities before the model and inject sanitized UTF-8 plain text.
//   - terminal-command-guard: when the prompt is empty, recognize the exact
//     first `aidlc-orchestrate.ts next` PreToolUse call, run the same terminal
//     utility once per session/turn, and refuse the duplicate shell call with
//     its output. Payloads without session_id share the explicit legacy bucket.
//   - plan-approval-guard: populated inputs use exact target enforcement.
//     Legacy argument-less inputs permit only single-file planning writes,
//     hard-stop opaque shell/append/mutators, mediate Testing Contract +
//     fingerprint/decision/answer ownership after canonical record writes,
//     and bind approval to the directive-issued workspace source floor.
//   - session-start: retain the modern session_id or derive a legacy identity
//     from the measured IDE host-instance environment.
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
//                  session-end | verb-intercept | terminal-command-guard

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  classifyTerminalCommand,
  decodeHarnessPlainText,
  hasOpenGate,
  clearKiroIdeLegacyPlanApprovalHost,
  clearPlanApprovalViolation,
  getField,
  hookDebug,
  humanActedSinceGate,
  humanPresenceGuardDisabled,
  isAutonomousMode,
  kiroIdeLegacyPlanApprovalSessionId,
  markKiroIdeLegacyPlanApprovalHost,
  clearPlanApprovalLegacyWindow,
  recordHookDrop,
  readPlanApprovalViolation,
  readPlanApprovalLegacyWindow,
  readPlanApprovalLegacyWindows,
  readActiveDirectiveMarker,
  resolveProjectDirFromHook,
  sanitizeHarnessPlainText,
  writePlanApprovalLegacyWindow,
  writePlanApprovalViolation,
  sessionsDir,
  splitKiroCommandArgs,
  stateFilePath,
} from "../tools/aidlc-lib.ts";
import {
  approvalFingerprint,
  beginCodeGeneration,
  legacyPlanApprovalGuardState,
  parseTestingContract,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../tools/aidlc-testing-posture.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
  "log-subagent",
  "plan-approval-guard",
  "rebuild-stage-graph",
  "terminal-command-guard",
]);
const SESSION_ID_TARGETS = new Set([
  "session-start",
  "continue-workflow",
  "record-human-turn",
]);
const INPUT_TARGETS = new Set([
  ...PAYLOAD_TARGETS,
  ...SESSION_ID_TARGETS,
  "verb-intercept",
]);
const LEGACY_SESSION_ID = "kiro-ide-legacy-current";
const KIRO_IDE_SESSION_FILE = ".kiro-ide-current-session";
const LEGACY_PLANNING_WRITE_TOOLS = new Set([
  "fs_write",
  "str_replace",
]);
const PLAN_APPROVAL_SAFE_READ_TOOLS = new Set([
  "fs_read",
  "file_search",
  "grep_search",
  "thinking",
  "todo_list",
]);

function upsertTestingContract(plan: string, rendered: string): string {
  const section = /(^|\n)## Testing Contract[^\n]*\n[\s\S]*?(?=\n## |\s*$)/m;
  if (section.test(plan)) {
    return plan.replace(section, (_match, prefix: string) =>
      `${prefix}${rendered.trimEnd()}\n`
    );
  }
  return `${plan.trimEnd()}\n\n${rendered}`;
}

function runLegacyPlanTool(
  projectDir: string,
  tool: "aidlc-log.ts",
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(
    [process.execPath, join(HOOKS_DIR, "..", "tools", tool), ...args],
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

function resolvedPlanApprovalSessionId(ide: IdeHookContext): string {
  if (ide.sessionId?.trim()) return ide.sessionId.trim();
  try {
    return legacyPlanApprovalSessionId();
  } catch {
    return LEGACY_SESSION_ID;
  }
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
      [
        process.execPath,
        join(HOOKS_DIR, "..", "tools", "aidlc-orchestrate.ts"),
        ...args,
      ],
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
      continue_token?: string;
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
    if (!directive.continue_token) {
      return { ok: false, detail: "load-steering recovery omitted its token" };
    }
    args = [
      "continue",
      directive.continue_token,
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
  if (state.approved) return null;
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
      throw new Error(
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
    writeFileSync(questionsPath, withFingerprint, "utf-8");
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
      throw new Error(
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
    throw new Error(
      `legacy Plan Approval answer mediation failed: ${recorded.stderr.trim() || recorded.stdout.trim()}`,
    );
  }
  clearPlanApprovalLegacyWindow(projectDir, sessionId);
  return null;
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
// LOAD-BEARING (not debug-only): this is the base dir for resolve(projectDir,
// rawPath) that turns the IDE's workspace-relative write path into the absolute
// path the core write-audit-log's record-root check needs — the core fix of this
// harness. It also feeds hookDebug/recordHookDrop. Do not remove it.
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

// Persist the effective SessionStart identity under the existing gitignored
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
    /^(?:(?:"([^"]+)"|'([^']+)'|(\S+))\s+)?["']?\.kiro[\\/]tools[\\/]aidlc-orchestrate\.ts["']?\s+next(?:\s+([\s\S]*))?$/i,
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

  const compiledArgs = (() => {
    if (command.source === "plugin-verb") {
      if (command.subcommand === "plugin-list") {
        return ["plugin", "list", ...forwarded];
      }
      if (command.subcommand === "plugin-sync") {
        return ["plugin", "sync", ...forwarded];
      }
      if (command.subcommand === "select-plugins") {
        return ["plugin", "select", ...forwarded];
      }
      if (command.subcommand === "plugin-validate") {
        return ["plugin", "validate", ...forwarded];
      }
      if (command.subcommand === "plugin-build") {
        return ["plugin", "build", ...forwarded];
      }
      if (command.subcommand === "help") return ["plugin", "help"];
    }
    if (command.source === "knowledge-verb") {
      if (command.subcommand === "help") return ["knowledge", "help"];
      return ["knowledge", command.subcommand, ...forwarded];
    }
    if (command.subcommand === "space-create") {
      return ["space", "create", ...forwarded];
    }
    if (command.subcommand === "intent-create") {
      return ["intent", "create", ...forwarded];
    }
    return [command.subcommand, ...forwarded];
  })();
  const toolFile = command.source === "knowledge-verb"
    ? "aidlc-knowledge.ts"
    : "aidlc-utility.ts";
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;

  try {
    const result = Bun.spawnSync(
      executable
        ? [executable, ...compiledArgs]
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
        env: {
          ...process.env,
          AIDLC_PROJECT_DIR: projectDir,
          CLAUDE_PROJECT_DIR: projectDir,
        },
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
  return ide.sessionId?.trim() || LEGACY_SESSION_ID;
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
    "It carries no workflow work. Relay the output below verbatim, then STOP. " +
    "Do not call any AIDLC tool this turn.\n\n" +
    `--- OUTPUT (exit ${result.exitCode}) ---\n${result.output}\n` +
    "--- END OUTPUT ---\n"
  );
}

function terminalRefusal(result: TerminalResult): string {
  return (
    "AIDLC deterministic terminal command complete. The requested command has " +
    "already run inside the hook, and this shell call is intentionally refused " +
    "to keep Kiro's Windows shell transport from changing its UTF-8 output. " +
    "Do not retry or run another AIDLC command this turn. Relay the output below " +
    "verbatim to the user, then stop.\n\n" +
    `--- OUTPUT (exit ${result.exitCode}) ---\n${result.output}\n` +
    "--- END OUTPUT ---\n"
  );
}

if (target === "verb-intercept") {
  const sessionId = terminalSessionId();
  const turn = bumpTurn(sessionId);
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
  if (tool !== "execute_bash" && tool !== "execute_pwsh" && tool !== "shell") {
    return 0;
  }
  const rawCommand = typeof ide.toolArgs?.command === "string"
    ? ide.toolArgs.command
    : "";
  const invocation = toolTerminalInvocation(rawCommand);
  const sessionId = terminalSessionId();
  const turn = readTurn(sessionId) || bumpTurn(sessionId);
  const existing = readTerminalLatch(sessionId);
  if (
    existing?.turn === turn &&
    (
      invocation !== null ||
      /aidlc-(?:orchestrate|utility|knowledge)\.ts/i.test(rawCommand)
    )
  ) {
    process.stderr.write(terminalRefusal(existing));
    return 2;
  }
  if (invocation === null) return 0;
  const command = classifyTerminalCommand(invocation.args);
  if (command === null) return 0;
  const result = runTerminalCommand(command);
  if (result === null) return 0;
  writeTerminalLatch(sessionId, turn, invocation, result);
  process.stderr.write(terminalRefusal(result));
  return 2;
}

// --- mint: record a HUMAN_TURN event on prompt submit ---
//
// Wired by aidlc-mint.json (UserPromptSubmit). Payload-independent (never
// reads stdin — a mint must never wait on it), so resolve the project dir
// from process.cwd() — appendAuditEntry then resolves the
// active intent from the on-disk cursor (aidlc/spaces/<space>/intents/active-intent)
// using only that dir, so the event lands in the correct per-intent shard with
// no payload. One ledger event per human turn; no marker file, no turn counter.
// Gated on workflow state existing (same self-gate as the core mint hook) so a
// prompt in a project that never ran the framework does not scaffold audit
// shards. Fail-open (try/catch, exit 0) so a mint failure never blocks the
// human's turn.
//
// The seam ALSO touches the .aidlc-human-turn marker (markHumanTurn), which is
// what makes the Stop hook's conversational carve-out work on this harness. The
// IDE delivers no `transcript_path`, so the carve-out cannot read the turn
// history; it compares this marker's mtime against .aidlc-engine-touch instead.
// Both writes ride this one seam so the ledger and the marker can never
// disagree about when a human spoke. See the marker family in aidlc-lib.ts.
// --- block: the preToolUse human-presence floor ---
//
// Wired by aidlc-block.json (PreToolUse). Hard-blocks tool calls ONLY while
// an approval gate is actually OPEN (a stage sits at [?] in the state file) and
// no HUMAN_TURN has been recorded since the last gate resolution - the exit-2
// floor behind the core handleApprove check. The gate-open predicate is
// load-bearing: after a legitimate approval the resolution follows the turn's
// HUMAN_TURN, and without it the floor would block the mandated same-turn
// continuation into the next stage. Carve-outs mirror the core gate: autonomous
// Construction (swarm/Bolt has no human at the gate) and the deterministic
// off-switch. The IDE gives no cwd payload, so the project dir is process.cwd().
// All read from disk. Fail-open on any read/parse error (advisory).
if (target === "enforce-approval-gate") {
  try {
    const pd = process.cwd();
    const sp = stateFilePath(pd);
    const content = existsSync(sp) ? readFileSync(sp, "utf-8") : null;
    // Carve-outs first: autonomous Construction, the deterministic off-switch,
    // and no-open-gate (nothing awaits approval, so nothing to floor).
    if (isAutonomousMode(content)) return 0;
    if (humanPresenceGuardDisabled()) return 0;
    if (!hasOpenGate(content)) return 0;
    if (humanActedSinceGate(pd)) return 0; // a human acted at this gate
    process.stderr.write(
      "An approval gate is open and no human has acted since it opened. The gate " +
        "requires a typed human turn before any tool call proceeds. Acknowledge the " +
        "gate as a human, then continue.\n",
    );
    return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
  } catch {
    return 0; // advisory - any read/parse failure fails open
  }
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

// Map the IDE tool name to the canonical name the core hooks match on. Write
// creates a (possibly new) file; str_replace/fs_append always target an
// existing file → Edit (forces ARTIFACT_UPDATED in the core write-audit-log).
function canonicalWriteTool(name: string): "Write" | "Edit" | "" {
  if (name === "fs_write" || name === "create_file") return "Write";
  if (
    name === "str_replace" ||
    name === "fs_append" ||
    name === "delete_file" ||
    name === "apply_patch" ||
    name === "edit_file"
  ) return "Edit";
  return "";
}

function mutationCapableTool(name: string): boolean {
  return name.length > 0 && !PLAN_APPROVAL_SAFE_READ_TOOLS.has(name);
}

function inputPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) paths.push(value);
  };
  add(input.path);
  add(input.file_path);
  add(input.filePath);
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
// PRECEDENCE IS AN AUDIT-INTEGRITY PROPERTY, NOT A STYLE CHOICE. On IDE 1.x the
// tool name itself carries the delegate as `subagent_<agent>` (#543) — a
// platform-provided identity the delegate cannot author. It therefore WINS over
// the result prose: an incorrect or prompt-injected `**Agent:** <other>` line in
// agent-written output must not be able to misattribute a SUBAGENT_COMPLETED row
// to a different persona while a more authoritative identity is available.
//
// The prose markers (`**Reviewer:** <name>` / `**Agent:** <name>`, #459) stay as
// the fallback because they are the ONLY signal on the 0.12 `invoke_sub_agent`
// shape, which carries no structured identity. They also still cover a
// degenerate `subagent_` whose suffix is empty. With neither, "unknown".
function extractAgentIdentity(toolResult: string, toolName = ""): string {
  const structured =
    toolName.startsWith("subagent_") && toolName !== "subagent_response"
      ? toolName.slice("subagent_".length).trim()
      : "";
  if (structured !== "") return structured;
  const lines = toolResult.split("\n").slice(0, 8);
  for (const line of lines) {
    const m = line.match(/^\s*\*\*(?:Reviewer|Agent)\s*:\*\*\s*(.+?)\s*$/);
    if (m) return m[1].replace(/\*+$/, "").trim() || "unknown";
  }
  return "unknown";
}

type Forward = { hook: string; input: Record<string, unknown> } | null;

function buildForward(): Forward {
  if (PAYLOAD_TARGETS.has(target) && (ide.malformedFields?.length ?? 0) > 0) {
    recordHookDrop(
      projectDir,
      "kiro-adapter",
      `${target}: malformed hook context fields (${ide.malformedFields?.join(", ")}) — event not forwarded`,
    );
    if (target === "plan-approval-guard") {
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
      let codeGenerationRelevant = false;
      try {
        const statePath = stateFilePath(projectDir);
        if (existsSync(statePath)) {
          const state = readFileSync(statePath, "utf-8");
          const marker = readActiveDirectiveMarker(projectDir, state);
          codeGenerationRelevant =
            getField(state, "Current Stage")
              ?.trim()
              .toLowerCase()
              .replace(/\s+/g, "-") === "code-generation" ||
            marker?.stage === "code-generation";
        }
      } catch {
        codeGenerationRelevant = false;
      }
      if (!codeGenerationRelevant) return null;
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
      const sessionId =
        ide.sessionId?.trim() ||
        (() => {
          try {
            return legacyPlanApprovalSessionId();
          } catch {
            return rememberedKiroIdeSessionId();
          }
        })();
      if (ide.channel === "legacy") {
        markKiroIdeLegacyPlanApprovalHost(projectDir, sessionId);
      }
      return {
        hook: "aidlc-record-human-turn.ts",
        input: {
          hook_event_name: "UserPromptSubmit",
          session_id: sessionId,
          prompt: ide.userPrompt ?? "",
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
        (toolName === "" || mutationCapableTool(toolName))
      ) {
        let recoverySession = resolvedPlanApprovalSessionId(ide);
        try {
          recoverySession = legacyPlanApprovalSessionId();
          markKiroIdeLegacyPlanApprovalHost(projectDir, recoverySession);
        } catch {
          // Missing host identity remains fail closed below.
        }
        if (toolName === "execute_bash") {
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
      const opaqueMutation =
        toolName === "" ||
        (
          mutationCapableTool(toolName) &&
          (
            Object.keys(toolArgs).length === 0 ||
            (
              toolName !== "execute_bash" &&
              paths.length === 0
            )
          )
        );
      if (opaqueMutation) {
        const approvalSession = resolvedPlanApprovalSessionId(ide);
        const state = legacyPlanApprovalGuardState(projectDir);
        const writeWindows = readPlanApprovalLegacyWindows(projectDir);
        if (
          (!state.active || state.target === null) &&
          writeWindows.length > 0
        ) {
          if (toolName === "execute_bash") {
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
          if (toolName === "execute_bash") {
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
          if (durableCodeGeneration && toolName === "execute_bash") {
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
          if (toolName === "execute_bash") {
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
        if (state.active && !state.approved && !state.sourceFloorValid) {
          return {
            hook: "__legacy_plan_approval_block__",
            input: {
              reason:
                "Plan Approval fallback blocked this tool because workspace source changed after the Code Generation directive. Revert pre-approval source changes before continuing.",
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
        }
        if (
          state.active &&
          !state.approved &&
          (
            toolName === "" ||
            toolName === "execute_bash" ||
            toolName === "fs_append"
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
            !LEGACY_PLANNING_WRITE_TOOLS.has(toolName)
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
            LEGACY_PLANNING_WRITE_TOOLS.has(toolName) &&
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
          if (Object.keys(toolArgs).length > 0 && toolName !== "execute_bash") {
            return {
              hook: "__legacy_plan_approval_block__",
              input: {
                reason:
                  "Plan Approval blocked a mutation-capable payload whose target path is missing or unsupported.",
              },
            };
          }
          // Legacy planning and post-human answer recording remain usable. The
          // directive-issued source floor prevents any workspace mutation in
          // this opaque window from being authorized by the later receipt.
          return null;
        }
      }
      if (toolName === "") return null;
      if (PLAN_APPROVAL_SAFE_READ_TOOLS.has(toolName)) return null;
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
      if (toolName === "execute_bash") {
        return {
          hook: "aidlc-plan-approval-guard.ts",
          input: {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: {
              command:
                typeof toolArgs.command === "string" ? toolArgs.command : "",
            },
            cwd: projectDir,
          },
        };
      }
      let directAgent =
        [
          toolArgs.name,
          toolArgs.subagent_type,
          toolArgs.agent,
          toolArgs.agent_name,
          toolArgs.role,
        ].find((value): value is string =>
          typeof value === "string" && value.trim().length > 0
        )?.trim() ??
        (
          toolName.startsWith("subagent_") &&
            toolName !== "subagent_response"
            ? toolName.slice("subagent_".length).trim()
            : ""
        );
      if (toolName === "invoke_sub_agent" && directAgent === "") {
        // The old generic dispatch shape does not always expose the target.
        // Treat it as guarded generation rather than letting an ambiguous
        // trusted-agent dispatch bypass the Code Generation floor.
        directAgent = "aidlc-developer-agent";
      }
      if (
        directAgent === "aidlc-developer-agent" ||
        toolName === "invoke_sub_agent"
      ) {
        const prompt =
          [toolArgs.prompt, toolArgs.task, toolArgs.description]
            .find((value): value is string =>
              typeof value === "string" && value.trim().length > 0
            ) ?? "";
        return {
          hook: "aidlc-plan-approval-guard.ts",
          input: {
            hook_event_name: "PreToolUse",
            tool_name: "Task",
            tool_input: {
              subagent_type: directAgent,
              prompt,
            },
            cwd: projectDir,
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
          tool_name: "TaskUpdate",
          tool_input: { source: "ide-audit-sync" },
        },
      };
    }

    case "log-subagent": {
      // IDE 1.x has emitted both `invoke_sub_agent` and `subagent_<agent>` for
      // real delegate completions (#543, live on 1.0.89-1.0.138).
      //
      // DIVISION OF RESPONSIBILITY: the v2 matcher is deliberately BROAD
      // (`^(subagent_.+|invoke_sub_agent)$`) so a fork-added delegate whose
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

      const isSubagentCompletion =
        toolName === "invoke_sub_agent" ||
        (toolName.startsWith("subagent_") && toolName !== "subagent_response");
      if (!isSubagentCompletion) return null;

      // Identity comes from the structured `subagent_<agent>` tool name when the
      // platform supplies one, and only otherwise from the result's
      // `**Reviewer:**` / `**Agent:**` prose (#459) — the sole signal on the 0.12
      // `invoke_sub_agent` shape. Agent-authored prose must not override a
      // platform-provided identity. Forward the result text so
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
      return {
        hook: "aidlc-log-subagent.ts",
        input: {
          hook_event_name: "SubagentStop",
          session_id: ide.sessionId?.trim() || rememberedKiroIdeSessionId(),
          agent_type: extractAgentIdentity(result, toolName),
          agent_id: "",
          last_assistant_message: result,
        },
      };
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
      // counter under `.aidlc-stop-hook/`. Its `{"decision":"block"}` stdout is
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
      // the core hook falls back to the `.aidlc-human-turn` / `.aidlc-engine-touch`
      // mtime comparison, and the `record-human-turn` target above writes the
      // former. On this harness that changes which record
      // `continue-workflow.drops` gets and whether the counter advances — not
      // what the human sees.
      // Modern Stop carries the exact chat identity. Prefer it over the
      // workspace-global SessionStart marker so concurrent chats cannot consume
      // one another's post-create handoff receipt; retain the marker for legacy
      // agentStop and broken modern channels.
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
  const command = executable
    ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
    : [process.execPath, join(HOOKS_DIR, hookFile)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(JSON.stringify(input), "utf-8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder("utf-8").decode(
      r.stdout ?? new Uint8Array(),
    ),
    stderr: r.stderr?.toString() ?? "",
    code: r.exitCode ?? 0,
  };
}

const fwd = buildForward();
if (fwd === null) {
  hookDebug(projectDir, "kiro-adapter", "forward: null (no-op)", { target });
  return 0;
}
if (fwd.hook === "__legacy_plan_approval_block__") {
  process.stderr.write(`${String(fwd.input.reason ?? "Plan Approval blocked this tool.")}\n`);
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
    Object.keys(ide.toolArgs ?? {}).length === 0
  ) {
    try {
      processLegacyPlanApprovalWrite(
        projectDir,
        filePath,
        ide.sessionId?.trim() || legacyPlanApprovalSessionId(),
      );
    } catch (error) {
      recordHookDrop(
        projectDir,
        "kiro-adapter",
        `legacy Plan Approval mediation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  // Two core hooks ride the same write event, in audit-then-sensors order
  // (mirrors the Claude settings.json registration). Both advisory: exit 0.
  runCore("aidlc-write-audit-log.ts", fwd.input);
  runCore("aidlc-run-sensors.ts", fwd.input);
  return 0;
}

const result = runCore(fwd.hook, fwd.input);

if (target === "session-start" || target === "record-human-turn") {
  // Unwrap {"additionalContext": ...} → plain text on stdout (Kiro's context
  // channels). Anything unparseable passes through untouched.
  try {
    const parsed = JSON.parse(result.stdout) as { additionalContext?: string };
    if (parsed.additionalContext) {
      process.stdout.write(sanitizeHarnessPlainText(parsed.additionalContext));
    }
  } catch {
    if (result.stdout) {
      process.stdout.write(sanitizeHarnessPlainText(result.stdout));
    }
  }
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
