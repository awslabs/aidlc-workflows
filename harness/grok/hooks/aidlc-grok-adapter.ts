#!/usr/bin/env bun
// aidlc-grok-adapter.ts — the Grok Build hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core). One shim normalizes a
// Grok payload to the Claude-shaped stdin the core hooks already read, then
// subprocess-pipes into the named core hook.
//
// Tool names below are guide-derived (Grok Build user guide matcher aliases),
// not a captured live payload. Claude names pass through. Native names map:
//   run_terminal_command / Shell → Bash
//   read_file → Read (target_file becomes file_path)
//   search_replace / StrReplace / hashline_edit → Edit (path becomes file_path)
//   write → Write
//   grep → Grep
//   list_dir → LS
//   spawn_subagent → Task (subagent_type passes through)
//   ask_user_question → AskUserQuestion
//
// A question box's tool result is the live Grok shape, not Claude's: 
// `{ type: "AskUserQuestion", UserAnswered: { answers: [{ question, picked }] } }`.
// The core human-turn hook reads `{ answers: { [question]: label } }`. The
// adapter normalizes before it records the pick. A box that closed with
// nothing picked is `{ answers: {} }`.
//
// Grok's envelope accepts camelCase and Claude snake_case (tool_name /
// toolName, tool_input / toolInput, session_id / sessionId, tool_response /
// toolResult). A call inside a subagent carries subagentType. Stop can block
// with {"decision":"block"}. PreToolUse denies with {"decision":"deny","reason"}
// and exit 2.
// SessionStart reads only a top-level systemMessage, so the core
// additionalContext banner is copied there.
//
// Usage (wired in .grok/hooks/aidlc.json, cwd = project root):
//   bun .grok/hooks/aidlc-grok-adapter.ts <target>
// where <target> ∈ session-start | session-end | mint | guards |
//                  audit-and-sensors | task-failure | runtime-compile |
//                  validate-state | stop | subagent-stop

import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  promptMovesSelection,
  recordHookDrop,
  takeSessionSelectionNotice,
} from "../tools/aidlc-lib.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface GrokHookInput {
  hook_event_name?: string;
  hookEventName?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  tool_response?: unknown;
  toolResponse?: unknown;
  toolResult?: unknown;
  reason?: string;
  source?: string;
  prompt?: string;
  subagentType?: string;
  subagent_type?: string;
  stop_hook_active?: boolean;
}

/** Guide-derived until a live Grok hook payload is captured. */
export function claudeToolName(name: string): string {
  switch (name) {
    case "Bash":
    case "run_terminal_command":
    case "Shell":
      return "Bash";
    case "Read":
    case "read_file":
      return "Read";
    case "Write":
    case "write":
      return "Write";
    case "Edit":
    case "search_replace":
    case "StrReplace":
    case "hashline_edit":
      return "Edit";
    case "MultiEdit":
      return "MultiEdit";
    case "Grep":
    case "grep":
      return "Grep";
    case "Glob":
      return "Glob";
    case "LS":
    case "list_dir":
      return "LS";
    case "Task":
    case "spawn_subagent":
      return "Task";
    case "AskUserQuestion":
    case "ask_user_question":
      return "AskUserQuestion";
    case "Delete":
      return "Delete";
    case "NotebookEdit":
      return "NotebookEdit";
    default:
      return name;
  }
}

/** Guide-derived input aliases. Claude field names pass through. */
export function normalizeToolInput(
  toolName: string,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const src: Record<string, unknown> = { ...(input ?? {}) };
  if (
    (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") &&
    src.file_path == null &&
    typeof src.path === "string"
  ) {
    src.file_path = src.path;
  }
  if (toolName === "Read" && src.file_path == null && typeof src.target_file === "string") {
    src.file_path = src.target_file;
  }
  if (toolName === "Task" && src.subagent_type == null && typeof src.subagentType === "string") {
    src.subagent_type = src.subagentType;
  }
  return src;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickedFromRow(picked: unknown): string[] {
  if (typeof picked === "string") {
    const trimmed = picked.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (!Array.isArray(picked)) return [];
  return picked
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}

/**
 * Claude's question-box result from a Grok AskUserQuestion tool result.
 * Null when the payload is not a question box. `{ answers: {} }` is a box
 * that closed with nothing picked.
 */
export function claudePickerResponse(
  toolResponse: unknown,
): { answers: Record<string, unknown> } | null {
  let response: unknown = toolResponse;
  if (typeof response === "string") {
    const trimmed = response.trim();
    if (trimmed.startsWith("{")) {
      try {
        response = JSON.parse(trimmed) as unknown;
      } catch {
        return null;
      }
    }
  }
  const record = asRecord(response);
  if (record === null) return null;

  const claudeAnswers = asRecord(record.answers);
  if (claudeAnswers !== null) return { answers: claudeAnswers };

  const userAnswered = asRecord(record.UserAnswered);
  const list = Array.isArray(userAnswered?.answers)
    ? userAnswered.answers
    : Array.isArray(record.answers)
      ? record.answers
      : null;
  const grokBox = list !== null || userAnswered !== null || record.type === "AskUserQuestion";
  if (!grokBox) return null;

  const answers: Record<string, unknown> = {};
  for (const entry of list ?? []) {
    const row = asRecord(entry);
    if (row === null || typeof row.question !== "string" || row.question.trim() === "") continue;
    const picked = pickedFromRow(row.picked);
    if (picked.length === 0) continue;
    answers[row.question] = picked.length === 1 ? picked[0] : picked;
  }
  return { answers };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function run(target: string, input: string): Promise<number> {
  let payload: GrokHookInput = {};
  if (!process.stdin.isTTY) {
    if (input.length > 0) {
      try {
        payload = JSON.parse(input) as GrokHookInput;
      } catch {
        if (target === "guards") {
          return deny(
            "AIDLC could not read this tool call's hook input, so its safety checks could not run and the call was stopped. Retry it once.",
          );
        }
        return 0;
      }
    }
  }

  const projectDirRaw =
    process.env.AIDLC_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();
  const projectDir = isAbsolute(projectDirRaw)
    ? projectDirRaw
    : resolve(process.cwd(), projectDirRaw);
  const sessionId = stringField(payload.session_id) || stringField(payload.sessionId);
  const runningAgent = stringField(payload.subagentType) || stringField(payload.subagent_type);
  const rawToolName = stringField(payload.tool_name) || stringField(payload.toolName);
  const toolName = claudeToolName(rawToolName);
  const toolInput = normalizeToolInput(
    toolName,
    payload.tool_input ?? payload.toolInput,
  );
  const toolResponse = payload.tool_response ?? payload.toolResponse ?? payload.toolResult;
  const projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
  };

  function runCore(hookFile: string, stdinText: string): { stdout: string; code: number } {
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
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "ignore",
      cwd: projectDir,
      env: authorityToken
        ? { ...projectEnv, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: authorityToken }
        : projectEnv,
    });
    return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
  }

  function runCoreWithStderr(
    hookFile: string,
    stdinText: string,
  ): { stdout: string; stderr: string; code: number; signal: string | null } {
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
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectDir,
      env: authorityToken
        ? { ...projectEnv, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: authorityToken }
        : projectEnv,
    });
    return {
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
      code: r.exitCode ?? 1,
      signal: r.exitCode === null ? (r.signalCode ?? "a signal") : null,
    };
  }

  function deny(reason: string): number {
    process.stdout.write(`${JSON.stringify({ decision: "deny", reason })}\n`);
    process.stderr.write(`${reason}\n`);
    return 2;
  }

  function claudeShaped(eventName: string, nameOverride?: string): string {
    return JSON.stringify({
      hook_event_name: eventName,
      tool_name: nameOverride ?? toolName,
      tool_input: toolInput,
      cwd: typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : projectDir,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(runningAgent ? { agent_type: runningAgent } : {}),
    });
  }

  // Exit 2 is a guard's refusal. A guard that fails on its own refuses nothing.
  function blockedByGuard(file: string, stdinText: string): boolean {
    const r = runCoreWithStderr(file, stdinText);
    if (r.code === 0) return false;
    if (r.code !== 2) {
      const hook = file.replace(/^aidlc-|\.ts$/g, "");
      const lines = r.stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      const line = (lines.find((entry) => entry.startsWith("error:")) ??
        lines.filter((entry) => !/^Bun v\d/.test(entry)).at(-1) ?? "no error output")
        .replace(/\[(degraded|advisory)\]/gi, "($1)");
      const how = r.signal === null ? `exited ${r.code}` : `was stopped by ${r.signal}`;
      recordHookDrop(projectDir, hook, `${hook} ${how} under the Grok adapter: ${line.slice(0, 240)}`);
      return false;
    }
    const reason = r.stderr.trim() || "blocked by AIDLC guard hook";
    process.stdout.write(`${JSON.stringify({ decision: "deny", reason })}\n`);
    process.stderr.write(`${reason}\n`);
    return true;
  }

  function additionalContext(stdout: string): string | undefined {
    try {
      const parsed = JSON.parse(stdout) as {
        additionalContext?: unknown;
        hookSpecificOutput?: { additionalContext?: unknown };
      };
      if (typeof parsed.additionalContext === "string" && parsed.additionalContext.length > 0) {
        return parsed.additionalContext;
      }
      const nested = parsed.hookSpecificOutput?.additionalContext;
      if (typeof nested === "string" && nested.length > 0) return nested;
    } catch {
      // no context payload
    }
    return undefined;
  }

  switch (target) {
    case "session-start": {
      if (runningAgent) return 0;
      const fwd = JSON.stringify({
        hook_event_name: "SessionStart",
        source: payload.source ?? "startup",
        ...(sessionId ? { session_id: sessionId } : {}),
      });
      const r = runCore("aidlc-session-start.ts", fwd);
      const context = additionalContext(r.stdout);
      if (context) process.stdout.write(`${JSON.stringify({ systemMessage: context })}\n`);
      return 0;
    }

    case "session-end": {
      if (runningAgent) return 0;
      runCore("aidlc-session-end.ts", JSON.stringify({
        hook_event_name: "SessionEnd",
        reason: payload.reason ?? "other",
        ...(sessionId ? { session_id: sessionId } : {}),
      }));
      return 0;
    }

    case "mint": {
      if (runningAgent) return 0;
      const prompt = payload.prompt ?? "";
      if (sessionId) {
        runCore(
          "aidlc-session-start.ts",
          JSON.stringify({
            hook_event_name: "SessionStart",
            source: "resume",
            session_id: sessionId,
            rebind_check: true,
          }),
        );
        if (promptMovesSelection(prompt)) takeSessionSelectionNotice(projectDir, sessionId);
      }
      runCore(
        "aidlc-record-human-turn.ts",
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          ...(sessionId ? { session_id: sessionId } : {}),
          prompt,
        }),
      );
      return 0;
    }

    case "guards": {
      if (toolName === "Task") {
        if (runningAgent) {
          return deny(
            `AIDLC nested delegation is not allowed: ${runningAgent} must complete its delegated task directly and cannot invoke spawn_subagent.`,
          );
        }
        if (blockedByGuard("aidlc-plan-approval-guard.ts", claudeShaped("PreToolUse"))) return 2;
        return 0;
      }
      const reviewerToolName = toolName === "Delete" ? "Write" : toolName;
      const guards = [
        { file: "aidlc-state-transition-guard.ts", input: claudeShaped("PreToolUse") },
        { file: "aidlc-reviewer-scope.ts", input: claudeShaped("PreToolUse", reviewerToolName) },
        { file: "aidlc-review-freeze.ts", input: claudeShaped("PreToolUse", reviewerToolName) },
      ];
      const planToolName = toolName === "Delete" ? "Write" : toolName;
      if (["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(planToolName)) {
        guards.push({
          file: "aidlc-plan-approval-guard.ts",
          input: claudeShaped("PreToolUse", planToolName),
        });
      }
      for (const guard of guards) {
        if (blockedByGuard(guard.file, guard.input)) return 2;
      }
      return 0;
    }

    case "audit-and-sensors": {
      if (toolName === "Write" || toolName === "Edit") {
        const fwd = claudeShaped("PostToolUse");
        runCore("aidlc-write-audit-log.ts", fwd);
        runCore("aidlc-run-sensors.ts", fwd);
      }
      // The model's copy of the pick is already the tool result. This hook's
      // stdout is Grok PostToolUse JSON, so the core hook's own line stays here.
      if (toolName === "AskUserQuestion") {
        const picker = claudePickerResponse(toolResponse);
        if (picker !== null) {
          runCore(
            "aidlc-record-human-turn.ts",
            JSON.stringify({
              hook_event_name: "PostToolUse",
              tool_name: "AskUserQuestion",
              ...(sessionId ? { session_id: sessionId } : {}),
              tool_input: toolInput,
              tool_response: picker,
            }),
          );
        }
      }
      return 0;
    }

    case "task-failure":
      return 0;

    case "runtime-compile": {
      if (toolName === "Bash") runCore("aidlc-rebuild-stage-graph.ts", claudeShaped("PostToolUse"));
      return 0;
    }

    case "validate-state": {
      runCore("aidlc-validate-state.ts", JSON.stringify({
        hook_event_name: "PreCompact",
        ...(sessionId ? { session_id: sessionId } : {}),
      }));
      return 0;
    }

    case "stop": {
      // A Stop inside a subagent is not the main agent's gate. Session-end
      // reasons (channel_closed, shutdown) are not a completion to hold open.
      if (runningAgent) return 0;
      if (payload.reason && payload.reason !== "end_turn") return 0;
      const r = runCore("aidlc-continue-workflow.ts", JSON.stringify({
        hook_event_name: "Stop",
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(payload.stop_hook_active ? { stop_hook_active: true } : {}),
      }));
      try {
        const parsed = JSON.parse(r.stdout) as { decision?: string; reason?: string };
        if (parsed.decision === "block" && parsed.reason) {
          process.stdout.write(`${JSON.stringify({ decision: "block", reason: parsed.reason })}\n`);
        }
      } catch {
        // no block
      }
      return 0;
    }

    case "subagent-stop": {
      const agent = runningAgent || stringField(toolInput.subagent_type);
      runCore("aidlc-log-subagent.ts", JSON.stringify({
        hook_event_name: "SubagentStop",
        ...(agent ? { agent_type: agent } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
      }));
      return 0;
    }

    default:
      return 0;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text()));
}
