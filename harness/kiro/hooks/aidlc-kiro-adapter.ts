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
import { createHash, randomUUID } from "node:crypto";
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
  reviewerDispatchPath,
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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

// The NORMALIZED hook context, whichever channel delivered it: 1.x snake_case
// stdin { tool_name, tool_input, tool_response } or 0.12 camelCase USER_PROMPT
// { toolName, toolArgs, toolResult, toolSuccess }. PostToolUse write/shell
// captures have empty inputs; later 1.x builds populate some PreToolUse and
// delegation inputs (#543), so normalization preserves either shape.
interface IdeHookContext {
  channel?: "legacy" | "modern";
  sessionId?: string;
  event?: string;
  prompt?: string;
  userPrompt?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolSuccess?: boolean;
  malformedFields?: string[];
}

// Kiro does not always send tool_response as a string. Two live-captured shapes
// exist alongside the plain string - `{ items: [{ Text }] }` from a crew
// completion and `{ success, result: [...] }` from a write - and treating either
// as malformed dropped the whole event: no audit row, and the Stop hook's inflight
// marker never cleared.
//
// An object or array IS a recognized transport shape, so it decodes to whatever
// text it carries, which may legitimately be none. Malformed is reserved for a
// value that is no transport at all (a number, a boolean), because that is the
// case worth surfacing rather than silently reading as empty.
const TOOL_RESULT_TEXT_KEYS = ["Text", "text", "content", "items", "output", "result"];

function collectToolResultText(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value !== "") out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectToolResultText(entry, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of TOOL_RESULT_TEXT_KEYS) {
      if (key in record) collectToolResultText(record[key], out);
    }
  }
}

function decodeToolResultText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) || (value !== null && typeof value === "object")) {
    const parts: string[] = [];
    collectToolResultText(value, parts);
    return parts.join("\n");
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The targets whose forward depends on the tool payload. Every other
// target builds a fixed input (or reads only the filesystem), so it skips
// payload acquisition entirely and keeps its zero-latency path.
const PAYLOAD_TARGETS = new Set([
  "audit-and-sensors",
  "review-freeze",
  "state-transition-guard",
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

const TERMINAL_TOOLS = new Set(["execute_bash", "execute_pwsh", "shell"]);

// Kiro names its shell tool `execute_bash` on POSIX hosts, `execute_pwsh` on
// Windows, and `shell` in some generations. Every shell decision in this adapter
// (terminal guard, Plan Approval recovery routing, the forward to the core guard
// as `Bash`) goes through this one predicate so the three names cannot drift
// apart: a name a branch did not recognise failed open on that host.
function isKiroShellTool(toolName: string): boolean {
  return toolName === "execute_bash" || toolName === "execute_pwsh" || toolName === "shell";
}

// The payload as the platform sends it. Distinct from IdeHookContext above, which
// is the normalized view: the targets merged in from the pre-merge kiro row pass
// the platform's own field names straight through to the core hooks.
interface KiroHookInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  assistant_response?: string;
}

/** A delegation, normalized to the shape the core hooks expect. */
interface KiroDispatch {
  coreTool: "subagent" | "Task";
  coreInput: Record<string, unknown>;
  agents: string[];
  prompt: string;
}

function firstNonBlank(values: unknown[]): string {
  return values.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  ) ?? "";
}

// Delegation arrives under three tool names, and `orchestrate_subagent` was
// missing from the recognition set: its payload puts the personas in
// `tool_input.stages[].role`, the same shape the `subagent` alias uses, so it
// belongs on the crew path rather than the direct one. Until it was listed, an
// orchestrated delegation produced no dispatch at all — the guards saw nothing
// and the audit recorded nothing. (Measured on captured 2.18.1 payloads: keys
// `task`, `stages`, `repeat`, with `role` naming each stage's persona.)
// `subagent_response` is the shell Kiro emits so a delegate can hand its report
// back. It names no path and writes nothing, so it is not a write whose target
// went missing - which is what the opaque-mutation classifier asks. Left
// mutation-capable it diverted every delegate report during code-generation into
// the legacy recovery machinery and answered a pre-dispatch hook with exit 2.
const DISPATCH_AUXILIARY_TOOLS = new Set(["subagent_response"]);
// Deleting an artifact is a mutation a freeze or a review scope must be able to
// refuse, but it is not an artifact write, so it never becomes an audit row.
const DELETE_TOOLS = new Set(["delete_file"]);
const CREW_DISPATCH_TOOLS = new Set(["subagent", "orchestrate_subagent"]);
const DISPATCH_TOOL_NAMES = new Set([
  "subagent",
  "orchestrate_subagent",
  "invoke_sub_agent",
]);

// A window is closed by an event a crashed or abandoned session never sends, so
// entries expire. Without this a stuck entry would make state-transition-guard
// refuse the MAIN session's own lifecycle commands for the rest of the project's
// life, which is a worse failure than losing the attribution.
const DELEGATION_TTL_MS = 6 * 60 * 60 * 1000;

/** Run a packaged core hook body and hand back its exit code and stderr. The
 *  guards below map a 2 onto Kiro's reject contract; anything else fails open. */
function runCoreHook(
  hook: string,
  payload: Record<string, unknown>,
  cwd: string,
): { code: number; stderr: string } {
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const command = executable
    ? [executable, "engine", "hook", hook]
    : [process.execPath, join(HOOKS_DIR, `aidlc-${hook}.ts`)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(JSON.stringify(payload), "utf-8"),
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? 0, stderr: r.stderr?.toString() ?? "" };
}
// Which targets need the hook payload at all. Everything else keeps its
// zero-latency path, touching neither channel.
//
// The three merged in from the pre-merge kiro row read the RAW payload (`kiro`)
// rather than the normalized view, and they were missing here - so `input` was
// never read for them, `kiro` stayed `{}`, and each one returned 0 on its first
// field access. Three guards that looked wired and enforced nothing:
// reviewer-scope, guard-tool-call, deliver-stage-rules.
const INPUT_TARGETS = new Set([
  ...PAYLOAD_TARGETS,
  ...SESSION_ID_TARGETS,
  "verb-intercept",
  "reviewer-scope",
  "guard-tool-call",
  "deliver-stage-rules",
  // Not in PAYLOAD_TARGETS on purpose: a malformed payload here must fall back to
  // the audit-tail reconciliation, not drop the event.
  "sync-workflow-state",
]);
const LEGACY_SESSION_ID = "kiro-ide-legacy-current";
const KIRO_IDE_SESSION_FILE = ".kiro-ide-current-session";
const LEGACY_PLANNING_WRITE_TOOLS = new Set([
  "fs_write",
  "str_replace",
]);
const PLAN_APPROVAL_SAFE_READ_TOOLS = new Set([
  "read",
  "fs_read",
  "read_file",
  "read_files",
  "read_code",
  "list_directory",
  "file_search",
  "glob",
  "grep_search",
  "grep",
  "web_fetch",
  "web_search",
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

// The raw snake_case payload, alongside the normalized `ide` view above. The
// targets merged in from the pre-merge kiro row read it directly because they
// forward the platform's own field names to the core hooks rather than a
// normalized subset; `ide` cannot serve them without flattening shapes those
// hooks distinguish. Malformed stdin leaves it empty and each target falls open
// on its own terms, matching how it behaved before the merge.
let kiro: KiroHookInput = {};
if (!process.stdin.isTTY && input.length > 0) {
  try {
    const parsed: unknown = JSON.parse(input);
    if (isRecord(parsed)) kiro = parsed as KiroHookInput;
  } catch {
    kiro = {};
  }
}

// Child hooks resolve the project from the environment. Only override it when
// this process was itself given one, so a bare invocation keeps the inherited
// environment rather than pinning children to a directory nobody asked for.
const projectEnv = process.env.AIDLC_PROJECT_DIR
  ? {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
  }
  : process.env;

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
          // Needed to tell a dispatch window's opening edge from its closing
          // one; nothing else in this adapter branched on the event name,
          // because until the delegation latch every target was registered on a
          // single trigger.
          const rawEvent = parsed.hook_event_name ?? parsed.hookEventName;
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
          const decodedResult = rawResult === null || rawResult === undefined
            ? ""
            : decodeToolResultText(rawResult);
          if (decodedResult === null) malformedFields.push("toolResult");
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
            event: typeof rawEvent === "string" ? rawEvent : undefined,
            prompt: typeof rawPrompt === "string" ? rawPrompt : undefined,
            userPrompt: typeof rawPrompt === "string" ? rawPrompt : undefined,
            toolName: typeof rawName === "string" ? rawName : undefined,
            toolArgs: isRecord(rawArgs) ? rawArgs : undefined,
            toolResult: decodedResult ?? "",
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
  // Accept the native dispatcher anchor and the legacy filename shape so the
  // seam keeps working across both invocation channels.
  const expanded = prompt.match(
    /(?:engine\s+orchestrate|aidlc-orchestrate\.ts)\s+next ([^`\n]*)`/,
  );
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
        ? [executable, "engine", ...compiledArgs]
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

// --- Roll-forward marker family (aidlc/.aidlc-*) ---
//
// These three markers are the CROSS-PROCESS half of the seam. The engine
// done-guard (aidlc-orchestrate.ts) and the doctor bundle read them from a
// separate process that knows nothing about Kiro's session id, so they live at
// fixed project-relative paths. The per-session turn/latch.json files above are
// the harness-local shell-refusal dedup and are not a substitute for these.
function bumpFlatTurn(): number {
  try {
    mkdirSync(join(projectDir, "aidlc"), { recursive: true });
    const cp = join(projectDir, "aidlc", ".aidlc-turn-counter");
    const turn = existsSync(cp)
      ? (Number.parseInt(readFileSync(cp, "utf-8").trim(), 10) || 0) + 1
      : 1;
    writeFileSync(cp, `${turn}\n`, "utf-8");
    return turn;
  } catch {
    return 0; // turn-clock best-effort; a failure fails the seam open
  }
}

function writeReadOnlyLatch(turn: number, flag: string, source: string): void {
  try {
    mkdirSync(join(projectDir, "aidlc"), { recursive: true });
    writeFileSync(
      join(projectDir, "aidlc", ".aidlc-readonly-latch"),
      `${JSON.stringify({ turn, flag, source, ts: Date.now() })}\n`,
      "utf-8",
    );
  } catch {
    // Latch best-effort; without it the backstop simply fails open.
  }
}

function writeForwardingLatch(
  turn: number,
  invocation: TerminalInvocation,
): void {
  try {
    mkdirSync(join(projectDir, "aidlc"), { recursive: true });
    writeFileSync(
      join(projectDir, "aidlc", ".aidlc-forwarding-latch"),
      `${JSON.stringify({ turn, raw: invocation.raw, args: invocation.args })}\n`,
      "utf-8",
    );
  } catch {
    // Forwarding backstop best-effort.
  }
}

function clearForwardingLatch(): void {
  rmSync(join(projectDir, "aidlc", ".aidlc-forwarding-latch"), { force: true });
}

// A next carrying one of these is an explicit engine read, so the seam can run
// it off-band with the exact recovered argv instead of asking the model to
// reconstruct the call.
const PRE_DISPATCH_FLAGS = new Set([
  "--config",
  "--stage",
  "--phase",
  "--resume",
  "--depth",
  "--test-strategy",
  "--single",
  "--new-intent",
  "--new-scope",
  "--report",
]);

function shouldPreDispatchNext(args: string[]): boolean {
  if (args[0] === "compose") return true;
  if (args.some((arg) => PRE_DISPATCH_FLAGS.has(arg))) return true;
  // A scope choice is unambiguous only before a workflow exists. Over an active
  // intent, scope + freeform text may be new work and must stay with the
  // conductor's offer/confirm classification.
  return args.includes("--scope") && !existsSync(stateFilePath(projectDir));
}

function preDispatchNext(args: string[]): string | null {
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  try {
    const run = Bun.spawnSync(
      executable
        ? [executable, "engine", "orchestrate", "next", ...args]
        : [
            process.execPath,
            join(".kiro", "tools", "aidlc-orchestrate.ts"),
            "next",
            ...args,
          ],
      { cwd: projectDir, stdout: "pipe", stderr: "pipe", env: projectEnv },
    );
    const directive = decodeHarnessPlainText(run.stdout).trim();
    return run.exitCode === 0 && directive.length > 0 ? directive : null;
  } catch {
    return null; // advisory; the forwarding latch remains the floor
  }
}

if (target === "verb-intercept") {
  // The whole turn's only job here is to deterministically handle a terminal
  // command or an explicit engine read; anything else falls through to the
  // conductor untouched (exit 0, no output → Kiro proceeds to the LLM normally).
  // Advisory: any failure fails open.
  const sessionId = terminalSessionId();
  const sessionTurn = bumpTurn(sessionId);
  // Turn-clock: bump EVERY time this seam fires (it fires once per turn, and
  // BEFORE the command === null exit, so a bare-next turn still advances the
  // clock and a prior turn's latch goes stale). The latches below stamp THIS
  // value; the engine done-guard and the preToolUse backstop fire only when the
  // latch's turn === the current counter — turn-scoped, no time window, no wedge.
  const turn = bumpFlatTurn();
  const invocation = promptTerminalInvocation(ide.prompt ?? "");
  const command = classifyTerminalCommand(invocation.args);
  if (command === null) {
    if (
      invocation.raw.length > 0 && shouldPreDispatchNext(invocation.args)
    ) {
      const directive = preDispatchNext(invocation.args);
      if (directive !== null) {
        clearForwardingLatch();
        if (invocation.args[0] === "--config") {
          writeReadOnlyLatch(
            turn,
            invocation.args.join(" ").replace(/^--/, ""),
            "config-alias",
          );
        }
        process.stdout.write(
          "SYSTEM (deterministic engine pre-dispatch): The harness has ALREADY " +
            "run the exact first `aidlc-orchestrate.ts next` invocation with " +
            "every user argument preserved. Treat the JSON below as the " +
            "authoritative directive and act on it now. Do NOT call `next` " +
            "again for this invocation.\n\n" +
            `--- DIRECTIVE ---\n${directive}\n--- END DIRECTIVE ---\n`,
        );
        return 0;
      }
    }
    // Kiro occasionally drops the entire expanded $ARGUMENTS vector and runs a
    // bare next even though both the agent prompt and the skill say verbatim.
    // Keep the intended first call in a turn-bound latch; guard-tool-call
    // compares the shell-normalized argv and rejects a lossy call. A correct
    // first next consumes the latch, so later loop iterations in this turn are
    // bare.
    if (invocation.raw.length > 0) {
      writeForwardingLatch(turn, invocation);
      process.stdout.write(
        "SYSTEM (deterministic argument forwarding): Your immediate first tool " +
          "call must be exactly the engine call below. Preserve every argument; " +
          "do not run a bare `next`.\n\n" +
          `{{INVOKE}} engine orchestrate next ${invocation.raw}\n`,
      );
    }
    return 0; // non-terminal command — the conductor handles the directive
  }
  const result = runTerminalCommand(command);
  if (result === null) return 0;
  // Arm the read-only/nav latch with the CURRENT turn counter so the engine
  // done-guard and the preToolUse backstop know a bare advancing `next` THIS
  // SAME turn is the spurious roll-forward. Every classified terminal family
  // arms it, plugin utilities included.
  const forwarded =
    command.args ?? (command.arg !== undefined ? [command.arg] : []);
  writeReadOnlyLatch(
    turn,
    command.source === "read-only-flag"
      ? command.subcommand
      : (command.display ?? [command.subcommand, ...forwarded].join(" ")),
    command.source,
  );
  writeTerminalLatch(sessionId, sessionTurn, invocation, result);
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
// Wired by aidlc-record-human-turn.json (UserPromptSubmit). Payload-independent (never
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
// Wired by aidlc-enforce-approval-gate.json (PreToolUse). Hard-blocks tool calls ONLY while
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

// Maintain the delegation latch before any target runs, so a guard registered on
// the same event still sees an accurate inflight set. Placed here rather than
// inside one target because several targets are registered on the dispatch tools;
// the latch is keyed by payload, so being called from more than one of them for
// the same event is a no-op rather than a double count.
if (INPUT_TARGETS.has(target) && (ide.malformedFields?.length ?? 0) === 0) {
  const dispatchTool = ide.toolName ?? "";
  const isDispatch =
    DISPATCH_TOOL_NAMES.has(dispatchTool) ||
    (dispatchTool.startsWith("subagent_") && dispatchTool !== "subagent_response");
  if (isDispatch) {
    const latchSession = ide.sessionId?.trim() || rememberedKiroIdeSessionId();
    const payload: KiroHookInput = {
      tool_name: dispatchTool,
      tool_input: ide.toolArgs ?? {},
    };
    if (ide.event === "PreToolUse") {
      openDelegation(latchSession, payload, kiroDispatch(payload)?.agents ?? []);
    } else if (ide.event === "PostToolUse") {
      closeDelegation(latchSession, payload);
    }
  }
}


// ── Targets the CLI row carried before the merge ───────────────────────────
// These are engine- and shell-invoked rather than manifest-invoked, so the
// manifest walk cannot see them; t331 names them so a later edit cannot drop
// one silently.

function canonicalTool(
  name: string,
  input: Record<string, unknown> = {},
): string {
  if (name === "write" || name === "fs_write") {
    return ["str_replace", "append"].includes(String(input.command ?? ""))
      ? "Edit"
      : "Write";
  }
  if (name === "str_replace" || name === "fs_append") return "Edit";
  if (["read", "fs_read", "read_file", "read_files"].includes(name)) return "Read";
  // Every terminal spelling, not just the two POSIX ones: a manifest matcher that
  // names execute_pwsh reached this and fell through to the default, so the guard
  // returned 0 and the Windows path had no enforcement at all.
  if (TERMINAL_TOOLS.has(name)) return "Bash";
  return name;
}

function kiroDispatch(input: KiroHookInput): KiroDispatch | null {
  const tool = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  // Kiro emits this auxiliary response shell after a delegate completes. It
  // is not a dispatch and must never produce a completion or steering event.
  if (tool === "subagent_response") return null;
  const directAgent = firstNonBlank([
    toolInput.name,
    toolInput.subagent_type,
    toolInput.agent,
    toolInput.agent_name,
    toolInput.role,
  ]).trim();
  const directPrompt = firstNonBlank([toolInput.prompt, toolInput.task]);
  if (CREW_DISPATCH_TOOLS.has(tool)) {
    // The alias is used for both legacy crew payloads and direct dispatches.
    // Only a non-empty set of valid crew stages identifies the former; an
    // absent or empty/malformed stages field must fall through to direct
    // identity and prompt extraction so guards do not fail open.
    const stages = Array.isArray(toolInput.stages)
      ? toolInput.stages.filter(
          (stage): stage is { role?: unknown; prompt_template?: unknown } => {
            if (stage === null || typeof stage !== "object") return false;
            const role = (stage as { role?: unknown }).role;
            return typeof role === "string" && role.trim().length > 0;
          },
        )
      : [];
    if (stages.length > 0) {
      const agents = stages.map((stage) => {
        const role = typeof stage.role === "string" ? stage.role.trim() : "";
        return role || "unknown";
      });
      if (directAgent) agents.push(directAgent);
      const prompt = [
        firstNonBlank([toolInput.task]),
        firstNonBlank([toolInput.prompt]),
        ...stages
          .filter((stage) =>
            typeof stage.role === "string" && stage.role.trim() === "aidlc-developer-agent"
          )
          .map((stage) => firstNonBlank([stage.prompt_template])),
      ].filter((part) => part.length > 0).join("\n");
      return { coreTool: "subagent", coreInput: toolInput, agents, prompt };
    }
  }

  const named = /^subagent_(.+)$/.exec(tool);
  if (!DISPATCH_TOOL_NAMES.has(tool) && named === null) return null;
  const namedAgent = named?.[1]?.trim() ?? "";
  const agent = namedAgent || directAgent;
  const prompt = directPrompt;
  return {
    coreTool: "Task",
    coreInput: {
      ...toolInput,
      ...(agent ? { subagent_type: agent } : {}),
      // The shared hook scans prompt before task, so replace a blank prompt
      // with the selected nonblank fallback before forwarding the payload.
      ...(prompt ? { prompt } : {}),
    },
    agents: agent ? [agent] : [],
    prompt,
  };
}

if (target === "guard-tool-call") {
  const cmdStr = String(kiro.tool_input?.command ?? "");
  const cwd = projectDir;
  const m = cmdStr.match(
    /(?:engine\s+orchestrate|aidlc-orchestrate\.ts)\s+next\b([^\n]*)/,
  );
  const nextArgs = m ? splitKiroCommandArgs(m[1].trim()) : [];
  // A next carrying ANY advancing/config flag is a DELIBERATE move — only a truly
  // bare next is the spurious roll-forward. Mirrors the engine done-guard's
  // exemptions (the engine doesn't parse --init/--force — retired P4 — so listing
  // them here is a harmless superset).
  const ADVANCING_FLAGS = new Set([
    "--config", "--stage", "--phase", "--scope", "--resume", "--depth",
    "--test-strategy", "--single", "--init", "--force",
    "--new-scope", "--report",
  ]);
  // A leading `compose` verb is a deliberate composer dispatch (the engine's
  // Branch 0 exempts flags.compose the same way) - never the spurious bare
  // roll-forward this backstop exists to block.
  const isBareAdvancing =
    m !== null &&
    nextArgs[0] !== "compose" &&
    !nextArgs.some((a) => ADVANCING_FLAGS.has(a)) &&
    classifyTerminalCommand(nextArgs) === null;

  let counter = -1;
  let latchTurn = -2;
  try {
    const cp = join(cwd, "aidlc", ".aidlc-turn-counter");
    if (existsSync(cp)) {
      const n = Number.parseInt(readFileSync(cp, "utf-8").trim(), 10);
      if (Number.isFinite(n)) counter = n;
    }
    const lp = join(cwd, "aidlc", ".aidlc-readonly-latch");
    if (existsSync(lp)) {
      const r = JSON.parse(readFileSync(lp, "utf-8")) as { turn?: number };
      if (typeof r.turn === "number") latchTurn = r.turn;
    }
  } catch { /* fail open */ }

  // First-next argument fidelity. The userPromptSubmit hook records the exact
  // expanded argv for a non-terminal /aidlc command. Reject any altered first
  // next in the same turn, including the observed total-drop `next` call. Shell
  // Quoting and path-safe escapes normalize through splitKiroCommandArgs
  // before compare.
  try {
    const forwardingPath = join(cwd, "aidlc", ".aidlc-forwarding-latch");
    if (m !== null && existsSync(forwardingPath)) {
      const forwarding = JSON.parse(
        readFileSync(forwardingPath, "utf-8"),
      ) as { turn?: number; raw?: string; args?: string[] };
      if (
        forwarding.turn === counter &&
        Array.isArray(forwarding.args)
      ) {
        const matches =
          forwarding.args.length === nextArgs.length &&
          forwarding.args.every((arg, index) => arg === nextArgs[index]);
        if (!matches) {
          process.stderr.write(
            "The first aidlc-orchestrate next call dropped or changed the user's arguments. " +
              `Run exactly: {{INVOKE}} engine orchestrate next ${forwarding.raw ?? ""}\n`,
          );
          process.exit(2);
        }
        rmSync(forwardingPath, { force: true });
      }
    }
  } catch { /* fail open */ }

  if (isBareAdvancing && counter >= 0 && latchTurn === counter) {
    process.stderr.write(
      "This was a read-only command and AIDLC already ran it this turn: do not advance the workflow. Its output has already been shown to the user; end the turn.\n",
    );
    return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
  }

  // --- human-presence floor (second exit-2 branch) ---
  //
  // Refuse a tool call ONLY while an approval gate is actually OPEN (a stage sits
  // at [?] in the state file) and no HUMAN_TURN has been recorded since the last
  // gate resolution: the hard floor that stops a model under autopilot from
  // fabricating an approval (the verb-intercept seam above records a HUMAN_TURN
  // on a real human turn). The gate-open predicate is load-bearing: after a
  // legitimate approval the resolution follows the turn's HUMAN_TURN, and without
  // it the floor would block the mandated same-turn continuation into the next
  // stage. Distinct from the roll-forward latch above. Carve-outs mirror the core
  // gate: autonomous Construction (swarm/Bolt) first, then the deterministic
  // off-switch, then no-open-gate. Fail-open on any read/parse error: advisory,
  // must never wedge a legitimate turn.
  try {
    const content = existsSync(stateFilePath(cwd))
      ? readFileSync(stateFilePath(cwd), "utf-8")
      : null;
    if (isAutonomousMode(content)) return 0; // autonomous: never block
    if (humanPresenceGuardDisabled()) return 0; // deterministic off-switch
    if (!hasOpenGate(content)) return 0; // no gate awaits approval

    if (!humanActedSinceGate(cwd)) {
      process.stderr.write(
        "an approval gate is open and no human has acted since it opened: refusing the tool call. A real human must respond at the gate. End the turn.\n",
      );
      return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
    }
  } catch { /* fail open: advisory presence floor */ }

  return 0;
}


if (target === "reviewer-scope") {
  const tool = kiro.tool_name ?? "";
  const ti = kiro.tool_input ?? {};
  const canonical = canonicalTool(tool, ti);
  let coreTool = "";
  const coreInput: Record<string, unknown> = {};
  if (canonical === "Bash") {
    coreTool = "Bash";
    coreInput.command = (ti.command as string) ?? "";
  } else if (canonical === "Read") {
    coreTool = "Read";
    coreInput.paths = inputPaths(ti);
  } else if (canonical === "Write" || canonical === "Edit" || tool === "delete_file") {
    coreTool = canonical === "Write" ? "Write" : "Edit";
    const paths = inputPaths(ti);
    coreInput.file_path = paths[0] ?? "";
    coreInput.paths = paths;
  } else {
    return 0;
  }
  // The identity this guard compares against the dispatched reviewer. The
  // pre-merge row took it from the persona argv of a per-agent registration and
  // otherwise asserted `scoped_registration`, which was sound only BECAUSE the
  // registration itself was the reviewer's. A standalone manifest is global, so
  // that assertion would now claim every unattributed call is the reviewer's —
  // including the conductor's own. The latch replaces both: a name when exactly
  // one delegate is inflight, and nothing at all otherwise.
  //
  // The two persona-scoped guards behave DIFFERENTLY under ambiguity, and the
  // reason is what each one needs rather than a policy preference:
  //
  //   state-transition-guard needs only PRESENCE - "is a delegate acting" - so
  //   two inflight personas still answer its question, and it enforces.
  //   reviewer-scope needs IDENTITY: it compares against `dispatch.reviewer`.
  //   Two inflight personas mean the acting one is genuinely unknown, and
  //   enforcing anyway would refuse a call that may belong to the other one -
  //   a false refusal that stalls the workflow.
  //
  // Under ambiguity this guard used to pass the call through with an empty
  // identity, which is exactly the enforcement gap the persona axis exists to
  // close - a delegate could read outside its review while a second one happened
  // to be inflight. So resolve the ambiguity instead: read the dispatch record the
  // core hook itself reads, and if the reviewer it names is among the inflight
  // personas, that is the identity to forward. The window says a delegate is
  // acting and the record says which delegate this guard is for.
  //
  // The residual cost is a possible FALSE refusal: another delegate reaching
  // outside the reviewed artifact during the same window is refused as if it were
  // the reviewer. That is the direction to err in - this guard only bounds reads
  // and writes outside one artifact, and a refusal is recoverable where a missed
  // violation is not. Both outcomes under a live review are recorded as drops.
  const latched = inflightDelegates(
    ide.sessionId?.trim() || rememberedKiroIdeSessionId(),
  );
  let registeredAgent = latched.length === 1 ? latched[0] : "";
  if (registeredAgent === "" && latched.length > 1) {
    // No record means no review is in flight, which is the ordinary state of a
    // crew stage - the core hook fails open on its own and there is nothing to
    // report. Only a record that exists and cannot be attributed is a drop;
    // logging the recordless case appended a line per guarded call for the
    // whole stage, and a non-empty .drops file is a release signal here.
    const recordPath = reviewerDispatchPath(projectDir);
    const reviewInFlight = existsSync(recordPath);
    let dispatchedReviewer = "";
    if (reviewInFlight) {
      try {
        const record = JSON.parse(readFileSync(recordPath, "utf-8")) as { reviewer?: unknown };
        if (typeof record.reviewer === "string") dispatchedReviewer = record.reviewer.trim();
      } catch {
        dispatchedReviewer = ""; // malformed record: the core hook fails open on its own
      }
    }
    if (dispatchedReviewer !== "" && latched.includes(dispatchedReviewer)) {
      registeredAgent = dispatchedReviewer;
      recordHookDrop(
        projectDir,
        "kiro-adapter",
        `reviewer-scope: ${latched.length} delegates inflight (${
          latched.join(", ")
        }) — attributed to the dispatched reviewer "${dispatchedReviewer}"; a call from another delegate is refused as if it were the reviewer's`,
      );
    } else if (reviewInFlight) {
      recordHookDrop(
        projectDir,
        "kiro-adapter",
        `reviewer-scope: ${latched.length} delegates inflight (${
          latched.join(", ")
        }) and ${
          dispatchedReviewer === ""
            ? "the dispatch record names no reviewer"
            : `the dispatched reviewer "${dispatchedReviewer}" is not among them`
        } — read-scope not enforced`,
      );
    }
  }
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const command = executable
    ? [executable, "engine", "hook", "reviewer-scope"]
    : [process.execPath, join(HOOKS_DIR, "aidlc-reviewer-scope.ts")];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: coreTool,
        tool_input: coreInput,
        ...(registeredAgent.length > 0
          ? { agent_type: registeredAgent }
          : {}),
      }),
      "utf-8",
    ),
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: projectEnv,
  });
  const stderrText = r.stderr?.toString() ?? "";
  if (r.exitCode === 2) {
    process.stderr.write(stderrText);
    return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
  }
  return 0;
}


if (target === "deliver-stage-rules") {
  const dispatch = kiroDispatch(kiro);
  if (dispatch === null) return 0;
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const command = executable
    ? [executable, "engine", "hook", "deliver-stage-rules"]
    : [process.execPath, join(HOOKS_DIR, "aidlc-deliver-stage-rules.ts")];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(
      JSON.stringify({
        ...kiro,
        tool_name: dispatch.coreTool,
        tool_input: dispatch.coreInput,
      }),
      "utf-8",
    ),
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...projectEnv,
      AIDLC_DISPATCH_RULES_PRELOAD_FALLBACK: "1",
    },
  });
  if (r.exitCode === 2) {
    // A required rule file could not be loaded at all (missing/unreadable):
    // that is real missing steering with no preload to fall back on - the
    // one case that still blocks, with the core hook's repair guidance.
    process.stderr.write(r.stderr?.toString() ?? "");
    return 2;
  }
  if (r.exitCode === 3) {
    // The bundle is valid but too large for the hook rewrite channel. Kiro's
    // agent-v1 resources preload the same active memory files, so this is the
    // advisory fallback case rather than an unloadable-rule block.
    process.stderr.write(r.stderr?.toString() ?? "");
    return 0;
  }
  if ((r.stdout?.toString().trim() ?? "") !== "") {
    process.stderr.write(
      "Advisory: the AIDLC subagent brief did not carry the active-stage rule bundle verbatim. " +
        "The dispatch proceeded - Kiro agents preload the active memory tree natively - but keep " +
        "briefs aligned with the delivered load-steering content.\n",
    );
  }
  return 0;
}

// --- legacy-ide-notice: the one thing an unsupported host must still hear ---
//
// Wired by aidlc-legacy-ide-notice.kiro.hook, and that channel IS the version
// check: `.kiro.hook` manifests do not fire on a current Kiro IDE (measured - 0
// firings against a five-manifest control), so a firing means a 0.x host. The
// alternative to shipping this one legacy file is silence on 0.x, which is the
// failure this notice exists to end.
//
// Reads NEITHER channel. A 0.x host opens stdin and never closes it, so a read
// here would hang before the message could be printed - `core/tools/aidlc.ts`
// skips its own buffered read for this target for the same reason, and this target
// is deliberately absent from INPUT_TARGETS.
//
// Belt and braces on top of the channel: USER_PROMPT is how 0.12 delivers a
// hook's payload, so a non-empty one confirms the legacy channel. A host that
// carries none is not the host this notice is for, and it exits 0 silently
// rather than interrupting a session it cannot diagnose. On this trigger the
// variable holds the TOOL INPUT as JSON, not the user's prompt (measured on
// 0.12.333) - only its presence is read here, never its shape.
//
// Exit 2 AND the denial text, because 0.12 answers differently per seam and the
// two answers are complementary rather than alternative:
//
//   On `promptSubmit`, exit 2 does not stop anything. The runner turns any
//   non-zero exit into `HookFailedCommandError` ("Hook '<name>' command execution
//   failed"), and on that seam nothing downstream reads it as a refusal - the turn
//   continued, the notice arrived framed as a BROKEN HOOK, and a 0.x session's own
//   agent duly diagnosed it as misfiring and wrote `"enabled": false` into this
//   manifest (which does not even disable it - that host keeps enablement in
//   workspace state).
//   On `preToolUse`, exit 2 DOES refuse the call. Measured on 0.12.333 against a
//   probe: the read was refused outright and never retried.
//
// So the exit code is the enforcement and the text is the explanation. The text
// matters independently because this host's preToolUse contract tells the model
// that when a hook's output denies access it "is FORBIDDEN from retrying the tool
// invocation" and "MUST NOT proceed with the tool call under any circumstances" -
// so a denial that leads the output is read as a decision rather than a fault.
// Written to BOTH streams on purpose: `stdout || stderr` is the SUCCESS path's
// rule and does not apply here, and the delivery actually measured on a non-zero
// exit was via stderr. Writing both removes the guess.
//
// This refuses per TOOL CALL rather than per prompt, which is the right seam:
// nothing in AI-DLC advances without a tool, and the refusal lands exactly where
// work would have begun.
//
// Then a second gate, because the channel stopped being proof. A supported IDE
// does not RUN a `.kiro.hook` (measured on 1.0.437: nothing fired), but it does
// LIST one, labelled `legacy`, next to a `Migrate` button - so one click turns
// this manifest into a current-generation hook that a supported host runs. The
// USER_PROMPT gate above cannot catch that: 1.x populates USER_PROMPT for a
// runCommand hook too. Migrated, on `preToolUse`, this notice would deny every
// tool call on a host that AI-DLC fully supports.
//
// So read the host's version rather than trusting the channel. VSCODE_IPC_HOOK
// names the socket by version line - `.../Kiro/0.12-main.sock` on 0.12.333 and
// `.../Kiro/1.0.-main.sock` on 1.0.437, both measured, hence the optional third
// dot. Anything that is not a 0.x major stays silent, and so does an unparseable
// or absent value: this notice's whole job is to inform, and the worst outcome of
// a wrong guess is refusing work on a supported install. Silence is the failure
// mode to prefer, at the cost that a 0.x host which stops setting this variable
// gets no notice.
if (target === "legacy-ide-notice") {
  if ((process.env.USER_PROMPT ?? "").trim().length === 0) return 0;
  const hostLine = /\/(\d+)\.(\d+)\.?-main\.sock$/.exec(process.env.VSCODE_IPC_HOOK ?? "");
  if (hostLine === null || hostLine[1] !== "0") return 0;
  const notice = "ACCESS DENIED. Permission is not granted for this tool call.\n\n" +
    "AI-DLC no longer supports this version of Kiro IDE.\n\n" +
    "Update Kiro IDE, or run this project with Kiro CLI instead - one AI-DLC " +
    "install serves both. The workflow record under aidlc/ is unaffected and " +
    "resumes where it stopped once you are on a supported version.\n\n" +
    // Self-contained on purpose. This message is shown while every tool call is
    // being refused, and the install ships no docs/ tree, so a "see <path>"
    // pointer is unreadable twice over.
    "Supported: a current Kiro IDE, or Kiro CLI 2.21.1 or newer.\n";
  process.stdout.write(notice);
  process.stderr.write(notice);
  return 2; // The refusal this seam honours; the text says why.
}

if (target === "state-transition-guard") {
  // Refuses a hand-run `aidlc-state.ts <verb>`. The engine owns state
  // transitions, so the state file, the audit log and the compiled graph stay in
  // agreement. Distinct from terminal-command-guard, which keeps terminal
  // commands deterministic: this one protects workflow lifecycle state.
  if ((ide.malformedFields?.length ?? 0) > 0) return 0;
  const tool = ide.toolName ?? "";
  if (!TERMINAL_TOOLS.has(tool)) return 0;
  const command = typeof ide.toolArgs?.command === "string" ? ide.toolArgs.command : "";
  if (!command) return 0;
  const pd = process.cwd();
  // The core hook enforces only when it knows a DELEGATE is acting (an empty
  // agent_type returns 0), because the main session is allowed to run these
  // verbs. The pre-merge row got that identity from the persona argv of a
  // per-agent registration; the latch supplies it now.
  //
  // Every inflight name is forwarded rather than one being chosen, and that is
  // sound HERE precisely because this guard needs presence rather than identity -
  // see the longer note at reviewer-scope, which needs the opposite and therefore
  // declines under the same ambiguity.
  const delegates = inflightDelegates(ide.sessionId?.trim() || rememberedKiroIdeSessionId());
  const result = runCoreHook("state-transition-guard", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    ...(delegates.length > 0 ? { agent_type: delegates.join(", ") } : {}),
  }, pd);
  if (result.code === 2) {
    process.stderr.write(result.stderr);
    return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
  }
  return 0;
}

if (target === "review-freeze") {
  // Freezes artifact writes once a reviewer receipt is terminal, so a late edit
  // cannot reopen a closed review loop. PreToolUse because it must refuse; the
  // PostToolUse audit hook sees the same tools and cannot block.
  if ((ide.malformedFields?.length ?? 0) > 0) return 0;
  const tool = ide.toolName ?? "";
  const args = ide.toolArgs ?? {};
  const shell = TERMINAL_TOOLS.has(tool);
  const write = canonicalWriteTool(tool);
  // canonicalWriteTool signals "not a write tool" with "", not null. Compared
  // against null this gate never fired, and a tool that is neither shell nor
  // write reached the core hook with an empty tool_name.
  if (!shell && write === "") return 0;
  const paths = inputPaths(args);
  const pd = process.cwd();
  const result = runCoreHook("review-freeze", {
    hook_event_name: "PreToolUse",
    tool_name: shell ? "Bash" : write,
    tool_input: shell
      ? { command: typeof args.command === "string" ? args.command : "" }
      : { file_path: paths[0] ?? "", paths },
    cwd: pd,
  }, pd);
  if (result.code === 2) {
    process.stderr.write(result.stderr);
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

// Map the IDE tool name to the canonical name the core hooks match on. Write
// creates a (possibly new) file; str_replace/fs_append always target an
// existing file → Edit (forces ARTIFACT_UPDATED in the core write-audit-log).
function canonicalWriteTool(
  name: string,
  input: Record<string, unknown> = {},
): "Write" | "Edit" | "" {
  // `write` belongs here for the same reason canonicalTool already accepts it:
  // tests/fixtures/kiro-hook-payloads/payloads.json calls these names the
  // defensive adapter vocabulary from the v3/IDE census. Omitting it made
  // audit-and-sensors skip the event, so a write under that spelling produced no
  // ARTIFACT row and fired no sensor.
  if (name === "fs_write" || name === "create_file" || name === "write") {
    // `write`/`fs_write` carry the mode in `command`, exactly as canonicalTool
    // reads it. Without this an edit under those spellings was audited as a
    // create, so the audit said Write where the artifact was amended.
    return ["str_replace", "append"].includes(String(input.command ?? ""))
      ? "Edit"
      : "Write";
  }
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
  return (
    name.length > 0 &&
    !PLAN_APPROVAL_SAFE_READ_TOOLS.has(name) &&
    !DISPATCH_AUXILIARY_TOOLS.has(name)
  );
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

// The delegation latch — how a delegate's own tool calls get an identity again.
//
// v3 hook payloads carry no acting-agent field: every event delivers the same
// keys (session_id, hook_event_name, cwd, tool_name, tool_input, tool_response,
// prompt, file_path). The agent-v1 registration channel this row used to have
// supplied that identity out of band — the guards were registered inside each
// persona's own agent config with the persona as argv — and standalone hook
// manifests have no agent-scope field, so that channel is gone with the merge.
//
// What replaces it is measured, not inferred. Across 615 captured payloads (Kiro
// CLI 2.18.1 / 2.19.2 / 2.20.1 and IDE 1.x) a delegate's OWN tool calls do reach
// the workspace hooks, strictly nested inside the dispatch event's
// PreToolUse..PostToolUse window, and the dispatch event names the delegate in
// one of three places: the `subagent_<agent>` tool name, `tool_input.name`
// (invoke_sub_agent), or `tool_input.stages[].role` (orchestrate_subagent). So
// open on the dispatch's PreToolUse, close on its PostToolUse, and every tool
// call in between belongs to that delegate.
//
// Keyed by the dispatch payload rather than counted, so a redelivery of the same
// event is idempotent — several manifests can match one tool call, and each match
// invokes this adapter separately.
//
// Ambiguity is reported, never guessed. Delegates run in parallel (measured:
// three `requirement-detailer` dispatches opened before any closed), and with two
// DIFFERENT personas inflight a nested call cannot be attributed to either. This
// reports the whole inflight set and the callers decide; nothing here picks one.
function delegationLedgerPath(sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(sessionsDir(projectDir), "kiro-delegation", key, "windows.ndjson");
}

// An APPEND-ONLY ledger, not a read-modify-write map. Two reasons, both measured
// against the map this replaces:
//
//   - Two identical concurrent dispatches (same persona, same prompt) hash to the
//     same key, so a keyed map collapsed them into one entry and the FIRST close
//     released both - enforcement dropped while a delegate was still running.
//     A ledger records each open separately and each close cancels exactly one.
//   - Read-modify-write has no lock here, so two adapter processes opening
//     windows at once could lose one another's update. An append is a single
//     small write; nothing is read first, so there is nothing to lose.
//
// A close cancels the most recent open with the same dispatch key (LIFO). If a
// redelivery of one event ever appends a second open - our manifests register the
// dispatch matcher once, so it does not happen today - the stray entry expires by
// TTL, and until then the error is "a delegate is believed inflight", which fails
// toward refusing rather than toward letting a lifecycle verb through.
// `group` is what makes ONE DISPATCH one window. A crew dispatch names several
// personas, so it appends several opens under the same dispatch key; without a
// group id a single close cancelled only the most recent of them and the rest sat
// inflight until the TTL, which kept the lifecycle guard refusing the main
// session's own verbs. A close now cancels the whole most-recent group for that
// key - and two IDENTICAL dispatches still need two closes, because they are two
// groups.
type DelegationRecord =
  | { op: "open"; agent: string; key: string; group: string; ts: number }
  | { op: "close"; key: string; ts: number };

function readDelegationLedger(sessionId: string): DelegationRecord[] {
  let raw = "";
  try {
    raw = readFileSync(delegationLedgerPath(sessionId), "utf-8");
  } catch {
    return [];
  }
  const out: DelegationRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn final line: ignore it rather than discard the ledger
    }
    if (!isRecord(parsed)) continue;
    const key = typeof parsed.key === "string" ? parsed.key : "";
    const ts = typeof parsed.ts === "number" ? parsed.ts : 0;
    if (key === "") continue;
    if (parsed.op === "open") {
      const agent = typeof parsed.agent === "string" ? parsed.agent.trim() : "";
      // A record written before groups existed replays as its own group, so an
      // in-flight upgrade cannot strand it.
      const group = typeof parsed.group === "string" && parsed.group !== ""
        ? parsed.group
        : `${key}:${ts}`;
      if (agent !== "") out.push({ op: "open", agent, key, group, ts });
    } else if (parsed.op === "close") {
      out.push({ op: "close", key, ts });
    }
  }
  return out;
}

function appendDelegationRecords(sessionId: string, records: DelegationRecord[]): void {
  if (records.length === 0) return;
  try {
    const path = delegationLedgerPath(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf-8",
    );
  } catch {
    // Best-effort attribution. A ledger we cannot append to costs the agent_type
    // on the calls inside this window; it must never fail the tool call itself.
  }
}

// One dispatch, one key. Pre and Post carry byte-identical tool_input for the
// same dispatch (measured), so hashing the pair identifies the window without
// needing an id the payload does not have. It does NOT distinguish two identical
// dispatches - that is what the ledger's one-open-one-close accounting is for.
function delegationKey(input: KiroHookInput): string {
  return createHash("sha256")
    .update(`${input.tool_name ?? ""} ${JSON.stringify(input.tool_input ?? {})}`)
    .digest("hex");
}

function openDelegation(sessionId: string, input: KiroHookInput, agents: string[]): void {
  const named = agents.map((agent) => agent.trim()).filter((agent) => agent.length > 0);
  if (named.length === 0) return;
  const key = delegationKey(input);
  const ts = Date.now();
  const group = `${ts.toString(36)}-${randomUUID()}`;
  appendDelegationRecords(
    sessionId,
    named.map((agent) => ({ op: "open" as const, agent, key, group, ts })),
  );
}

function closeDelegation(sessionId: string, input: KiroHookInput): void {
  appendDelegationRecords(sessionId, [
    { op: "close", key: delegationKey(input), ts: Date.now() },
  ]);
}

/** Opens that no close has cancelled and that have not expired. */
function liveDelegationOpens(
  sessionId: string,
): Array<{ agent: string; key: string; group: string; ts: number }> {
  const now = Date.now();
  const opens: Array<{ agent: string; key: string; group: string; ts: number }> = [];
  for (const record of readDelegationLedger(sessionId)) {
    if (record.op === "open") {
      if (now - record.ts > DELEGATION_TTL_MS) continue;
      opens.push({ agent: record.agent, key: record.key, group: record.group, ts: record.ts });
      continue;
    }
    // Cancel the most recent GROUP for this key - every persona that dispatch
    // named, not just the last one appended. A later group is the one still
    // running if an earlier identical dispatch already reported.
    let group: string | null = null;
    for (let i = opens.length - 1; i >= 0; i--) {
      if (opens[i].key === record.key) {
        group = opens[i].group;
        break;
      }
    }
    if (group === null) continue;
    for (let i = opens.length - 1; i >= 0; i--) {
      if (opens[i].group === group) opens.splice(i, 1);
    }
  }
  return opens;
}

/** Distinct personas whose delegation window is open right now. */
function inflightDelegates(sessionId: string): string[] {
  return [...new Set(liveDelegationOpens(sessionId).map((open) => open.agent))];
}

// There is deliberately NO compaction. The obvious form - decide nothing is
// inflight, then truncate - is a check-then-act race: an append landing between
// the two is erased, and a lost open means a delegate's calls stop being
// attributed. An earlier version of this file claimed the race could not happen
// "when nothing is inflight", which was wrong: nothing prevents another adapter
// process from opening a window in that gap. Records are small and expire by TTL,
// so an unbounded ledger costs disk rather than correctness.

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
      // A dispatch auxiliary is inert here and must not be forwarded: the core
      // guard treats any tool it does not recognize as mutation-capable, so
      // handing it the delegate's response shell refuses a call that writes
      // nothing. Excluding it from mutationCapableTool is not enough - that only
      // keeps it out of the legacy machinery below.
      if (DISPATCH_AUXILIARY_TOOLS.has(toolName)) return null;
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
      // A delegation is never an opaque mutation. The classifier asks "is this a
      // write whose target the host failed to report?", which is why a
      // mutation-capable tool with no path counts - but a dispatch has no path by
      // construction: its payload is a prompt. Without this carve-out every
      // delegation during code-generation was diverted into the legacy 0.x
      // recovery machinery, which pre-empts the core guard and answers with a
      // recovery message instead of the guard's own reasoning. Measured on a
      // seeded fixture: all three dispatch shapes hit the "authority state is
      // missing or corrupt" fallback instead of reaching plan-approval-guard.
      const dispatching =
        DISPATCH_TOOL_NAMES.has(toolName) ||
        (toolName.startsWith("subagent_") && toolName !== "subagent_response");
      const opaqueMutation =
        toolName === "" ||
        (
          !dispatching &&
          mutationCapableTool(toolName) &&
          (
            Object.keys(toolArgs).length === 0 ||
            (
              !isKiroShellTool(toolName) &&
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
            isKiroShellTool(toolName) ||
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
          if (state.active && Object.keys(toolArgs).length > 0 && !isKiroShellTool(toolName)) {
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
      // The crew shape puts the roles inside `tool_input.stages[]`, so the direct
      // extraction above never sees the developer. Without this the payload fell
      // through to the generic branch and the core guard answered "unknown
      // mutation-capable tool: subagent" instead of the Code Generation refusal.
      // kiroDispatch already normalizes that shape - including skipping malformed
      // stages - so route through it rather than re-reading stages here.
      if (CREW_DISPATCH_TOOLS.has(toolName)) {
        const crew = kiroDispatch({ tool_name: toolName, tool_input: toolArgs });
        if (crew?.agents.includes("aidlc-developer-agent")) {
          return {
            hook: "aidlc-plan-approval-guard.ts",
            input: {
              hook_event_name: "PreToolUse",
              tool_name: "Task",
              tool_input: {
                subagent_type: "aidlc-developer-agent",
                prompt: crew.prompt,
              },
              cwd: projectDir,
            },
          };
        }
      }
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
      const canon = canonicalWriteTool(ide.toolName ?? "", ide.toolArgs ?? {});
      if (canon === "") return null;
      // A delete is not an artifact write. The write-audit manifest's matcher says
      // the same by omitting delete_file, and t147 pins that a delete leaves no
      // audit heartbeat - so state it here too, where the direct and dispatcher
      // entry points bypass that matcher entirely.
      if (DELETE_TOOLS.has(ide.toolName ?? "")) return null;
      // Prefer the tool input. The comment above is written for the IDE's captured
      // PostToolUse writes, which carry empty inputs - but one row now also serves
      // the CLI, which POPULATES them, and scraping prose there either found the
      // wrong path or none. The prose remains the fallback, unchanged, for the
      // surface that has nothing else.
      const inputWritePaths = inputPaths(ide.toolArgs ?? {});
      const rawPath = inputWritePaths[0] ?? extractWrittenPath(ide.toolResult ?? "");
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
      const absolute = (path: string): string =>
        isAbsolute(path) ? path : resolve(projectDir, path);
      const filePath = absolute(rawPath);
      // A batch write names every target in `operations[]`, and forwarding only
      // the first audited one artifact of two. Carry the whole list when there is
      // one; the core hook reads `paths` and falls back to `file_path`.
      const allPaths = inputWritePaths.length > 1
        ? inputWritePaths.map(absolute)
        : undefined;
      return {
        hook: "__audit_and_sensors__", // handled specially below (two hooks)
        input: {
          hook_event_name: "PostToolUse",
          tool_name: canon,
          tool_input: {
            file_path: filePath,
            ...(allPaths ? { paths: allPaths } : {}),
          },
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
      // Two paths, because one row serves two surfaces. The IDE gives no task
      // payload (toolArgs is empty), so the core hook reads the latest
      // STAGE_STARTED slug from the audit tail - that is what the ide-audit-sync
      // marker selects. The CLI DOES give the payload: a todo_list create whose
      // task description ends in "[slug]". Reading the slug straight from it is
      // exact where the audit tail is a reconstruction, so prefer it and keep the
      // marker as the fallback.
      const todoSlug = (() => {
        const args = ide.toolArgs ?? {};
        if (String(args.command ?? "") !== "create") return "";
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        for (let i = tasks.length - 1; i >= 0; i--) {
          const task = tasks[i];
          if (!isRecord(task)) continue;
          const description = typeof task.task_description === "string"
            ? task.task_description
            : "";
          const match = description.match(/\[([a-z][a-z0-9-]*)\]$/);
          if (match) return match[1];
        }
        return "";
      })();
      if (todoSlug !== "") {
        return {
          hook: "aidlc-sync-workflow-state.ts",
          input: {
            hook_event_name: "PostToolUse",
            tool_name: "TaskUpdate",
            tool_input: {
              status: "in_progress",
              activeForm: `Running [${todoSlug}]`,
            },
          },
        };
      }
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

      // The PreToolUse registration exists only to open the delegation window,
      // which the latch already did before this switch ran. It carries no result
      // by definition, so returning early here keeps the empty-payload drop below
      // meaning what it says: a COMPLETION that arrived without its output.
      if (ide.event === "PreToolUse") return null;

      const isSubagentCompletion =
        DISPATCH_TOOL_NAMES.has(toolName) ||
        (toolName.startsWith("subagent_") && toolName !== "subagent_response");
      if (!isSubagentCompletion) return null;

      // Identity comes from the structured `subagent_<agent>` tool name when the
      // platform supplies one, and only otherwise from the result's
      // `**Reviewer:**` / `**Agent:**` prose (#459) — the sole signal on the 0.12
      // `invoke_sub_agent` shape. Agent-authored prose must not override a
      // platform-provided identity. Forward the result text so
      // SUBAGENT_COMPLETED also carries an output snippet.
      //
      // Identity, from the most authoritative source down. The crew and direct
      // shapes name their persona in the PAYLOAD (`stages[].role`, `name`), which
      // neither the tool name nor the result prose carries - a pipeline completion
      // recorded `Agent Type: unknown` without this. kiroDispatch already reads
      // both, so prefer it and keep the tool-name/prose recovery for the shapes
      // where that is the only signal.
      const dispatchedAgent = DISPATCH_TOOL_NAMES.has(toolName)
        ? kiroDispatch({ tool_name: toolName, tool_input: ide.toolArgs ?? {} })
          ?.agents.find((agent) => agent !== "" && agent !== "unknown")
        : undefined;
      const agentType = dispatchedAgent ?? extractAgentIdentity(result, toolName);

      // An empty result must not fabricate a row WITH NO IDENTITY - that is the
      // `Agent Type: unknown` fiction this drop exists to prevent. When the
      // payload did name the delegate there is nothing fabricated: the completion
      // happened, and only its output snippet is missing.
      if (result.trim() === "" && agentType === "unknown") {
        recordHookDrop(
          projectDir,
          "kiro-adapter",
          "log-subagent: empty tool payload and no delegate identity — SUBAGENT_COMPLETED not recorded",
        );
        return null;
      }
      return {
        hook: "aidlc-log-subagent.ts",
        input: {
          hook_event_name: "SubagentStop",
          session_id: ide.sessionId?.trim() || rememberedKiroIdeSessionId(),
          agent_type: agentType,
          agent_id: "",
          last_assistant_message: result,
        },
      };
    }

    case "continue-workflow":
      // ADVISORY ONLY ON THIS HARNESS. The IDE's `Stop` trigger cannot block and
      // does not forward the hook's output — matching what
      // aidlc-continue-workflow.json and the Kiro guide have always said.
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
    ? [executable, "engine", "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
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
  //
  // A batch write names several targets in one event, and the core audit hook
  // records ONE artifact per invocation - it reads `file_path` and has no `paths`
  // handling - so a batch of two produced one row. Invoke per path instead of
  // forwarding a list the hook cannot see.
  const batchPaths =
    (fwd.input.tool_input as { paths?: unknown } | undefined)?.paths;
  const targets = Array.isArray(batchPaths)
    ? batchPaths.filter((path): path is string => typeof path === "string" && path !== "")
    : [filePath];
  for (const target of targets.length > 0 ? targets : [filePath]) {
    const perWrite = {
      ...fwd.input,
      tool_input: { file_path: target },
    };
    runCore("aidlc-write-audit-log.ts", perWrite);
    runCore("aidlc-run-sensors.ts", perWrite);
  }
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
