#!/usr/bin/env bun
// aidlc-devin-adapter.ts — the Devin CLI hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). ONE shim normalizes the Devin payload to the
// ClaudeCodeHookInput shape and subprocess-pipes into the named core hook,
// forwarding stdout/exit code.
//
// Devin payloads are near-isomorphic to Claude Code's (same stdin JSON
// contract, same hookSpecificOutput/decision/exit-code output contract) with
// one load-bearing difference: the tool names differ. Devin calls its shell
// tool `exec` (not `Bash`), its edit tool `edit` (not `Edit`), its subagent
// tool `run_subagent` (not `Task`), its plan tool `todo_write` (not
// `TaskUpdate`), its question tool `ask_user_question` (not
// `AskUserQuestion`), and so on. The core hooks hardcode the Claude tool
// names (Bash/Edit/Write/Read/Task/TaskUpdate/...), so this shim translates
// Devin tool names to Claude tool names before piping.
//
// Tool-name map (Devin → Claude, confirmed in the Devin CLI hooks docs at
// lifecycle-hooks.mdx lines 355-365):
//   exec             → Bash
//   edit             → Edit
//   write            → Write
//   read             → Read
//   run_subagent     → Task
//   todo_write       → TaskUpdate
//   notebook_edit    → NotebookEdit
//   notebook_read    → NotebookRead
//   glob             → Glob
//   grep             → Grep
//   apply_patch      → (parse the *** Add|Update File: envelope, fan out
//                       one Write/Edit per file — same as codex)
//   webfetch         → WebFetch
//   ask_user_question→ AskUserQuestion
//   skill            → Skill
//   request_scope    → RequestScope
//
// DIFFERENCES FROM THE CODEX ADAPTER (do NOT copy these codex-specific parts):
//   1. No duplicate-delivery replay cache. Devin does not deliver every
//      event twice (codex does). The adapter runs the core hook and returns
//      directly — no DEDUPE_ROOT, slotDir, responseFile, pruneStale,
//      replayResponse, persistResponse, or bypassReplay.
//   2. No D-4 session-end reconcile. Devin HAS a SessionEnd event (codex does
//      not). The session-end target just pipes to aidlc-session-end.ts
//      verbatim. No reconcilePriorSession, no heartbeat file.
//   3. No bind-bash-session target. That is codex-specific (rewriting POSIX
//      bash input). Devin has no equivalent need.
//   4. Tool names differ (see map above). The adapter MUST translate Devin
//      tool names to the Claude tool names the core hooks hardcode.
//
// Output contracts:
//   - session-start: the core hook prints {"additionalContext": "..."};
//     Devin expects the hookSpecificOutput wrapper (same as codex/Claude) —
//     the shim re-wraps.
//   - continue-workflow: {"decision":"block","reason"} passes through VERBATIM
//     — the contract is identical on Devin (stop_hook_active included).
//   - PreToolUse guards (reviewer-scope, review-freeze, plan-approval-guard,
//     state-transition-guard, deliver-stage-rules): exit 2 + stderr to block;
//     exit 0 to allow.
//   - everything else: advisory; stdout ignored, exit 0.
//
// Usage (wired in .devin/hooks.v1.json):
//   bun .devin/hooks/aidlc-devin-adapter.ts <target>
// where <target> ∈ session-start | session-end | record-human-turn |
//                  state-transition-guard | reviewer-scope | review-freeze |
//                  plan-approval-guard | deliver-stage-rules | fold-usage |
//                  audit-and-sensors | sync-workflow-state | log-subagent |
//                  rebuild-stage-graph | validate-state | continue-workflow

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isNonAnswer, validSessionId } from "../tools/aidlc-lib.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

// --- Devin → Claude tool-name map -------------------------------------------
//
// The core hooks hardcode Claude tool names (Bash/Edit/Write/...). Devin uses
// different externally-visible names (exec/edit/write/...). This map translates
// before piping. apply_patch is special-cased (envelope parsing + fan-out), so
// it is absent from the map.
const DEVIN_TO_CLAUDE_TOOL: Record<string, string> = {
  exec: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  run_subagent: "Task",
  todo_write: "TaskUpdate",
  notebook_edit: "NotebookEdit",
  notebook_read: "NotebookRead",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  ask_user_question: "AskUserQuestion",
  skill: "Skill",
  request_scope: "RequestScope",
};

interface DevinHookInput {
  hook_event_name?: string;
  session_id?: string;
  prompt_id?: string;
  cwd?: string;
  source?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  agent_type?: string;
  agent_id?: string;
  stop_hook_active?: boolean;
  prompt?: string;
  user_prompt?: string;
  message?: string;
  reason?: string;
  summary?: string;
}

// --- ask_user_question response parsing (for record-human-turn) --------------
//
// Mirrors the codex adapter: detect whether the user made an explicit
// selection in an ask_user_question response, and extract the text of that
// selection. Devin's PostToolUse tool_response may be an object
// {success, output, error} rather than a raw JSON string; in that case the
// string-typed guards return their defaults (no explicit selection → skip),
// which is the correct fail-open behavior for the human-turn recorder.

function offeredOptionLabels(toolInput: unknown): Map<string, Set<string>> {
  const offered = new Map<string, Set<string>>();
  if (toolInput === null || typeof toolInput !== "object") return offered;
  const questions = (toolInput as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return offered;
  for (const question of questions) {
    if (question === null || typeof question !== "object") continue;
    const record = question as Record<string, unknown>;
    if (typeof record.id !== "string" || !Array.isArray(record.options)) continue;
    const labels = new Set<string>();
    for (const option of record.options) {
      if (typeof option === "string") labels.add(option.trim());
      else if (option !== null && typeof option === "object") {
        const candidate = option as Record<string, unknown>;
        for (const key of ["label", "value", "text"] as const) {
          if (typeof candidate[key] === "string") labels.add(candidate[key].trim());
        }
      }
    }
    offered.set(record.id, labels);
  }
  return offered;
}

function hasExplicitHumanSelection(toolResponse: unknown, toolInput?: unknown): boolean {
  if (typeof toolResponse !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolResponse);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const response = parsed as Record<string, unknown>;
  if (Object.keys(response).length !== 1 || !("answers" in response)) return false;
  const answers = response.answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return false;
  const selections = Object.entries(answers as Record<string, unknown>);
  if (selections.length === 0) return false;
  const offered = offeredOptionLabels(toolInput);
  return selections.every(([questionId, selection]) => {
    if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return false;
    const record = selection as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !Array.isArray(record.answers)) return false;
    return record.answers.length > 0 && record.answers.every((answer) => {
      if (typeof answer !== "string" || answer.trim().length === 0) return false;
      return !isNonAnswer(answer) || offered.get(questionId)?.has(answer.trim()) === true;
    });
  });
}

function explicitHumanSelectionText(toolResponse: unknown): string {
  if (typeof toolResponse !== "string") return "";
  try {
    const parsed = JSON.parse(toolResponse) as {
      answers?: Record<string, { answers?: unknown[] }>;
    };
    for (const selection of Object.values(parsed.answers ?? {})) {
      for (const answer of selection.answers ?? []) {
        if (typeof answer === "string" && answer.trim()) return answer.trim();
      }
    }
  } catch {
    // Non-structured prompt payloads use the direct fields below.
  }
  return "";
}

// --- Core-hook subprocess plumbing ------------------------------------------

function runCore(hookFile: string, input: string): { stdout: string; code: number } {
  // Reuse the exact bun binary running this adapter; the child must not depend on
  // PATH containing bun (the hook environment often lacks the bun install dir).
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const command = executable
    ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
    : [process.execPath, join(HOOKS_DIR, hookFile)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(input, "utf-8"),
    stdout: "pipe",
    stderr: "ignore",
    cwd: projectDir,
    env: projectEnv,
  });
  return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
}

// Variant capturing stderr — the reviewer-scope / review-freeze /
// plan-approval-guard / state-transition-guard / deliver-stage-rules block
// channel (exit 2 + the reason on stderr) must survive the pipe, unlike the
// advisory hooks above.
function runCoreWithStderr(
  hookFile: string,
  input: string,
): { stdout: string; stderr: string; code: number } {
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const command = executable
    ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
    : [process.execPath, join(HOOKS_DIR, hookFile)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(input, "utf-8"),
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectDir,
    env: projectEnv,
  });
  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    code: r.exitCode ?? 0,
  };
}

// Re-wrap the core context output ({"additionalContext": ...}) into the
// hookSpecificOutput envelope Devin consumes (same contract as Claude Code
// and Codex for SessionStart / UserPromptSubmit).
function wrapContext(coreStdout: string, eventName: string): string {
  try {
    const parsed = JSON.parse(coreStdout) as { additionalContext?: string };
    if (parsed.additionalContext) {
      return `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: parsed.additionalContext,
        },
      })}\n`;
    }
  } catch {
    // unparseable core output — pass through untouched
  }
  return coreStdout;
}

// Rewrite tool_name in the raw stdin JSON from the Devin name to the Claude
// name the core hook hardcodes. Used by targets that pipe "verbatim with
// rewrite" (the rest of the payload passes through unchanged). If the tool
// name is not in the map, the stdin is returned verbatim.
function rewriteStdinToolName(rawInput: string, devin: DevinHookInput): string {
  const mapped = devin.tool_name ? DEVIN_TO_CLAUDE_TOOL[devin.tool_name] : undefined;
  if (!mapped) return rawInput;
  try {
    const parsed = JSON.parse(rawInput) as Record<string, unknown>;
    parsed.tool_name = mapped;
    return JSON.stringify(parsed);
  } catch {
    return rawInput;
  }
}

// --- apply_patch envelope parsing --------------------------------------------
//
// Same parser as the codex adapter: extracts *** Add|Update File: directives
// from the patch envelope text (tool_input.command) and returns one
// {path, tool} per file (Add → Write, Update → Edit). Delete File and Move to
// are handled by the caller (reviewer-scope / review-freeze) where they are
// sibling writes for scope purposes.

function patchedFiles(command: string): Array<{ path: string; tool: "Write" | "Edit" }> {
  const out: Array<{ path: string; tool: "Write" | "Edit" }> = [];
  for (const m of command.matchAll(/^\*\*\* (Add|Update) File: (.+)$/gm)) {
    const rel = m[2].trim();
    out.push({
      path: isAbsolute(rel) ? rel : join(projectDir, rel),
      tool: m[1] === "Add" ? "Write" : "Edit",
    });
  }
  return out;
}

// --- Targets ------------------------------------------------------------------

let projectDir = "";
let projectEnv: Record<string, string | undefined> = {};
let rawInput = "";
let devin: DevinHookInput = {};

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
  rawInput = "";
  devin = {};
  if (!process.stdin.isTTY) {
    try {
      rawInput = input;
      if (rawInput.length > 0) devin = JSON.parse(rawInput) as DevinHookInput;
    } catch {
      return 0; // malformed stdin — advisory hooks fail open
    }
  }

  const projectDirRaw =
    process.env.DEVIN_PROJECT_DIR ?? devin.cwd ?? process.cwd();
  projectDir = isAbsolute(projectDirRaw)
    ? projectDirRaw
    : resolve(process.cwd(), projectDirRaw);
  const payloadSessionId = validSessionId(devin.session_id);
  if (payloadSessionId) {
    process.env.AIDLC_SESSION_OVERRIDE = payloadSessionId;
    process.env.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
  }
  projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
    DEVIN_PROJECT_DIR: projectDir,
  };

  const tool = devin.tool_name ?? "";

  switch (target) {
    case "session-start": {
      // Forward {hook_event_name:"SessionStart", source, session_id?} to the
      // core session-start hook; re-wrap the core's {"additionalContext":...}
      // stdout into hookSpecificOutput.{hookEventName:"SessionStart",
      // additionalContext}. This delivers the welcome message (replacing
      // Claude's companyAnnouncements).
      const fwd = JSON.stringify({
        hook_event_name: "SessionStart",
        source: devin.source ?? "startup",
        ...(devin.session_id ? { session_id: devin.session_id } : {}),
      });
      const r = runCore("aidlc-session-start.ts", fwd);
      const wrapped = wrapContext(r.stdout, "SessionStart");
      if (wrapped) process.stdout.write(wrapped);
      return 0;
    }

    case "session-end": {
      // Devin HAS a SessionEnd event (unlike codex). Pipe stdin verbatim to
      // the core session-end hook. Advisory.
      runCore("aidlc-session-end.ts", rawInput);
      return 0;
    }

    case "record-human-turn": {
      // For ask_user_question PostToolUse with no explicit human selection,
      // skip. Otherwise forward {hook_event_name:"UserPromptSubmit",
      // session_id?, prompt: <text>} to the core record-human-turn hook.
      // The text is devin.prompt (Devin UserPromptSubmit carries `prompt`).
      // Advisory, no stdout.
      if (
        tool === "ask_user_question" &&
        !hasExplicitHumanSelection(devin.tool_response, devin.tool_input)
      ) {
        return 0;
      }
      const responseText =
        explicitHumanSelectionText(devin.tool_response) ||
        devin.prompt ||
        devin.user_prompt ||
        devin.message ||
        "";
      runCore(
        "aidlc-record-human-turn.ts",
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          ...(devin.session_id ? { session_id: devin.session_id } : {}),
          prompt: responseText,
        }),
      );
      return 0;
    }

    case "state-transition-guard": {
      // Only exec can name aidlc-state.ts. For exec, rewrite tool_name to
      // Bash and pipe to the core state-transition-guard (stderr variant;
      // exit 2 + stderr preserved, exit on 2). Everything else permits.
      if (tool === "exec") {
        const rewritten = rewriteStdinToolName(rawInput, devin);
        const r = runCoreWithStderr("aidlc-state-transition-guard.ts", rewritten);
        if (r.code === 2) {
          process.stderr.write(r.stderr);
          process.exit(2);
        }
      }
      process.exit(0);
      break;
    }

    case "reviewer-scope": {
      // PreToolUse: the per-unit reviewer read-scope bound.
      // exec→Bash: pipe verbatim-with-rewrite (stderr variant; exit 2 + stderr).
      // edit/write→ forward {PreToolUse, Edit|Write, {file_path}}.
      // apply_patch→ fan out one Edit/Write per parsed file (Delete File /
      //   Move to included as Edit). Forward agent_type/agent_id if present.
      //   Block on first out-of-scope file.
      // Everything else permits.
      if (tool === "exec") {
        const rewritten = rewriteStdinToolName(rawInput, devin);
        const r = runCoreWithStderr("aidlc-reviewer-scope.ts", rewritten);
        if (r.code === 2) {
          process.stderr.write(r.stderr);
          return 2;
        }
        return 0;
      }
      if (tool === "edit" || tool === "write") {
        const filePath = devin.tool_input?.file_path as string | undefined;
        if (typeof filePath === "string" && filePath) {
          const fwd = JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: DEVIN_TO_CLAUDE_TOOL[tool],
            tool_input: { file_path: filePath },
          });
          const r = runCoreWithStderr("aidlc-reviewer-scope.ts", fwd);
          if (r.code === 2) {
            process.stderr.write(r.stderr);
            return 2;
          }
        }
        return 0;
      }
      if (tool === "apply_patch") {
        const command = (devin.tool_input?.command as string) ?? "";
        const targets: Array<{ path: string; tool: string }> = patchedFiles(command);
        for (const m of command.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm)) {
          const rel = m[1].trim();
          targets.push({ path: isAbsolute(rel) ? rel : join(projectDir, rel), tool: "Edit" });
        }
        for (const f of targets) {
          const fwd = JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: f.tool,
            tool_input: { file_path: f.path },
            ...(devin.agent_type ? { agent_type: devin.agent_type } : {}),
            ...(devin.agent_id ? { agent_id: devin.agent_id } : {}),
          });
          const r = runCoreWithStderr("aidlc-reviewer-scope.ts", fwd);
          if (r.code === 2) {
            process.stderr.write(r.stderr);
            return 2;
          }
        }
        return 0;
      }
      return 0;
    }

    case "review-freeze": {
      // Same shape as reviewer-scope but piping to aidlc-review-freeze.ts.
      if (tool === "exec") {
        const rewritten = rewriteStdinToolName(rawInput, devin);
        const r = runCoreWithStderr("aidlc-review-freeze.ts", rewritten);
        if (r.code === 2) {
          process.stderr.write(r.stderr);
          return 2;
        }
        return 0;
      }
      if (tool === "edit" || tool === "write") {
        const filePath = devin.tool_input?.file_path as string | undefined;
        if (typeof filePath === "string" && filePath) {
          const fwd = JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: DEVIN_TO_CLAUDE_TOOL[tool],
            tool_input: { file_path: filePath },
          });
          const r = runCoreWithStderr("aidlc-review-freeze.ts", fwd);
          if (r.code === 2) {
            process.stderr.write(r.stderr);
            return 2;
          }
        }
        return 0;
      }
      if (tool === "apply_patch") {
        const command = (devin.tool_input?.command as string) ?? "";
        const targets: Array<{ path: string; tool: string }> = patchedFiles(command);
        for (const m of command.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm)) {
          const rel = m[1].trim();
          targets.push({ path: isAbsolute(rel) ? rel : join(projectDir, rel), tool: "Edit" });
        }
        for (const f of targets) {
          const fwd = JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: f.tool,
            tool_input: { file_path: f.path },
          });
          const r = runCoreWithStderr("aidlc-review-freeze.ts", fwd);
          if (r.code === 2) {
            process.stderr.write(r.stderr);
            return 2;
          }
        }
        return 0;
      }
      return 0;
    }

    case "plan-approval-guard": {
      // PreToolUse: code-generation's plan-before-generation ordering.
      // exec→Bash: pipe to the core guard (stderr variant).
      // edit/write/apply_patch→ fan out one Write per touched path.
      // run_subagent→ normalize to the core Task shape
      //   {PreToolUse, Task, {subagent_type, prompt}}. Only block for the
      //   developer agent target (mirror codex's early-allow for non-developer).
      // Block contract: exit 2 + stderr.
      if (tool === "exec") {
        const rewritten = rewriteStdinToolName(rawInput, devin);
        const r = runCoreWithStderr("aidlc-plan-approval-guard.ts", rewritten);
        if (r.code === 2) {
          process.stderr.write(r.stderr);
          return 2;
        }
        return 0;
      }
      if (tool === "edit" || tool === "write") {
        const filePath = devin.tool_input?.file_path as string | undefined;
        if (typeof filePath === "string" && filePath) {
          const fwd = JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Write",
            tool_input: { file_path: filePath },
          });
          const r = runCoreWithStderr("aidlc-plan-approval-guard.ts", fwd);
          if (r.code === 2) {
            process.stderr.write(r.stderr);
            return 2;
          }
        }
        return 0;
      }
      if (tool === "apply_patch") {
        const command = (devin.tool_input?.command as string) ?? "";
        const targets: Array<{ path: string; tool: string }> = patchedFiles(command);
        for (const m of command.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm)) {
          const rel = m[1].trim();
          targets.push({ path: isAbsolute(rel) ? rel : join(projectDir, rel), tool: "Edit" });
        }
        for (const f of targets) {
          const r = runCoreWithStderr(
            "aidlc-plan-approval-guard.ts",
            JSON.stringify({
              hook_event_name: "PreToolUse",
              tool_name: "Write",
              tool_input: { file_path: f.path },
            }),
          );
          if (r.code === 2) {
            process.stderr.write(r.stderr);
            return 2;
          }
        }
        return 0;
      }
      if (tool !== "run_subagent") {
        return 0;
      }
      // Devin run_subagent tool_input has `prompt` and possibly `agent`/`profile`.
      // Use `agent`/`profile` as subagent_type; only block for the developer agent.
      const ti = devin.tool_input ?? {};
      const subagentType =
        (typeof ti.agent === "string" ? ti.agent : "") ||
        (typeof ti.profile === "string" ? ti.profile : "");
      if (subagentType !== "aidlc-developer-agent") {
        return 0;
      }
      const prompt = typeof ti.prompt === "string" ? ti.prompt : "";
      const fwd = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: subagentType,
          prompt,
        },
      });
      const r = runCoreWithStderr("aidlc-plan-approval-guard.ts", fwd);
      if (r.code === 2) {
        process.stderr.write(r.stderr);
        return 2;
      }
      return 0;
    }

    case "deliver-stage-rules": {
      // Pipe to aidlc-deliver-stage-rules.ts with tool_name rewritten
      // (run_subagent→Task). Use the stderr variant; forward stdout, exit 2 +
      // stderr on block.
      const rewritten = rewriteStdinToolName(rawInput, devin);
      const r = runCoreWithStderr("aidlc-deliver-stage-rules.ts", rewritten);
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.code === 2) {
        process.stderr.write(r.stderr);
        return 2;
      }
      return 0;
    }

    case "fold-usage": {
      // Pipe stdin (with tool_name rewrite) to aidlc-fold-usage.ts. Advisory.
      const rewritten = rewriteStdinToolName(rawInput, devin);
      runCore("aidlc-fold-usage.ts", rewritten);
      return 0;
    }

    case "audit-and-sensors": {
      // edit/write→ forward {PostToolUse, Edit|Write, {file_path}} to
      //   aidlc-write-audit-log.ts THEN aidlc-run-sensors.ts.
      // apply_patch→ fan out per parsed file (Add→Write, Update→Edit).
      // Advisory.
      if (tool === "edit" || tool === "write") {
        const filePath = devin.tool_input?.file_path as string | undefined;
        if (typeof filePath === "string" && filePath) {
          const fwd = JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: DEVIN_TO_CLAUDE_TOOL[tool],
            tool_input: { file_path: filePath },
          });
          runCore("aidlc-write-audit-log.ts", fwd);
          runCore("aidlc-run-sensors.ts", fwd);
        }
        return 0;
      }
      if (tool === "apply_patch") {
        const command = (devin.tool_input?.command as string) ?? "";
        for (const f of patchedFiles(command)) {
          const fwd = JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: f.tool,
            tool_input: { file_path: f.path },
          });
          runCore("aidlc-write-audit-log.ts", fwd);
          runCore("aidlc-run-sensors.ts", fwd);
        }
        return 0;
      }
      return 0;
    }

    case "sync-workflow-state": {
      // todo_write→ map to the TaskUpdate shape. Devin todo_write tool_input
      // has todos:[{content, status, ...}]. Find the first in_progress todo,
      // forward {PostToolUse, TaskUpdate, {status:"in_progress",
      // activeForm: <content>}}. Advisory.
      if (tool === "todo_write") {
        const todos =
          (devin.tool_input?.todos as Array<{
            content?: string;
            status?: string;
            title?: string;
          }>) ?? [];
        const active = todos.find((t) => t.status === "in_progress");
        if (active) {
          const activeForm = active.content ?? active.title ?? "";
          if (activeForm) {
            runCore(
              "aidlc-sync-workflow-state.ts",
              JSON.stringify({
                hook_event_name: "PostToolUse",
                tool_name: "TaskUpdate",
                tool_input: { status: "in_progress", activeForm },
              }),
            );
          }
        }
      }
      return 0;
    }

    case "log-subagent": {
      // run_subagent PostToolUse → pipe to aidlc-log-subagent.ts (rewriting
      // tool_name to Task if needed, but the core hook reads
      // agent_type/agent_id — forward those). This replaces the absent
      // SubagentStop event. Advisory.
      if (tool === "run_subagent") {
        const rewritten = rewriteStdinToolName(rawInput, devin);
        runCore("aidlc-log-subagent.ts", rewritten);
      }
      return 0;
    }

    case "rebuild-stage-graph": {
      // exec PostToolUse → rewrite tool_name to Bash and pipe verbatim to
      // aidlc-rebuild-stage-graph.ts. Advisory.
      if (tool === "exec") {
        const rewritten = rewriteStdinToolName(rawInput, devin);
        runCore("aidlc-rebuild-stage-graph.ts", rewritten);
      }
      return 0;
    }

    case "validate-state": {
      // PostCompaction → pipe stdin verbatim to aidlc-validate-state.ts (the
      // core hook reads no stdin fields). Advisory.
      runCore("aidlc-validate-state.ts", rawInput);
      return 0;
    }

    case "continue-workflow": {
      // Stop → pipe stdin verbatim to aidlc-continue-workflow.ts; forward
      // {"decision":"block","reason"} stdout + exit code verbatim (contract
      // identical on Devin; stop_hook_active is in stdin).
      const r = runCore("aidlc-continue-workflow.ts", rawInput);
      if (r.stdout) process.stdout.write(r.stdout);
      return r.code;
    }

    default:
      // Fail open.
      return 0;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)));
}
