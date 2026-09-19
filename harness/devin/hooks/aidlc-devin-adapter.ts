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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotateSubagentInflight,
  errorMessage,
  findSubagentInflight,
  isNonAnswer,
  recordHookDrop,
  validSessionId,
} from "../tools/aidlc-lib.ts";

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
// selection. Devin's PostToolUse tool_response is an object
// {success, output, error} where `output` is a JSON string; the normalizer
// extracts it before parsing. A non-string tool_response that lacks an
// `output` string field yields no selection → skip (advisory).
//
// Three inner answer shapes are recognized. The outer {answers: {...}}
// wrapper may be present (Claude Code, synthetic Devin fixtures) or absent
// (real Devin 3000.6.14 interactive export):
//   1. Claude Code: {answers: {<question id>: {answers: ["<string>"]}}}
//      — keyed by question id; value is a non-array object with an `answers`
//      array of plain strings.
//   2. Devin synthetic: {answers: {<question text>: [{selected: ["<label>"], custom_text: ""}]}}
//      — keyed by question TEXT (not id); value is an ARRAY of objects each
//      with a `selected` (string[]) and `custom_text` (string) field. For
//      "Other" free-text: {selected: ["Other"], custom_text: "<text>"}. For
//      multi-select: {selected: ["<opt1>", "<opt2>"], custom_text: ""}.
//   3. Devin 3000.6.14 native: {<question text>: {selected: ["<label>"], skipped: false}}
//      — keyed by question TEXT; value is a SINGLE object (not an array) with
//      a `selected` (string[]) and `skipped` (boolean) field. Captured from a
//      real interactive session export; the original export has been removed
//      from the working tree and is recoverable from Git history.

// Normalize Devin's PostToolUse tool_response into the JSON string the
// selection parsers expect. Devin delivers {success, output, error}; the
// answer payload is JSON-encoded inside `output`. If the caller already
// passed a string (test fixtures, codex), pass it through. Devin 3000.6.14
// prefixes the JSON with "User answered your questions:\n" — extract the
// JSON object starting at the first `{` so JSON.parse succeeds.
function normalizeToolResponse(toolResponse: unknown): string | null {
  if (typeof toolResponse === "string") return extractJsonFromString(toolResponse);
  if (
    toolResponse !== null &&
    typeof toolResponse === "object" &&
    !Array.isArray(toolResponse)
  ) {
    const obj = toolResponse as Record<string, unknown>;
    if (typeof obj.output === "string") return extractJsonFromString(obj.output);
  }
  return null;
}

// If the string is pure JSON, return it as-is. If it has a non-JSON prefix
// (e.g. "User answered your questions:\n{...}"), extract the JSON starting
// at the first `{` and return that substring.
function extractJsonFromString(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const braceIdx = s.indexOf("{");
  if (braceIdx > 0) return s.slice(braceIdx);
  return s;
}

// Distinguish a cancelled/dismissed ask_user_question from an answered one
// whose response shape the parser does not recognize. The adapter must only
// SKIP the HUMAN_TURN mint for genuine cancellations; an unrecognized answer
// shape still means the user interacted, and the gate fails closed without a
// HUMAN_TURN (the S08 bug on Devin 3000.6.14).
//
// Cancellation signals, in priority order:
//   1. tool_response.success === false — Devin marks a dismissed widget
//   2. the `output` string is a cancellation phrase (isNonAnswer)
// A `success: true` response is a positive answer signal — mint regardless of
// whether the inner answer shape is recognized. No `success` field falls
// through to the text check.
function isAskUserQuestionCancellation(devin: DevinHookInput): boolean {
  const tr = devin.tool_response;
  if (tr === null || tr === undefined) return false;
  if (typeof tr === "object" && !Array.isArray(tr)) {
    const obj = tr as Record<string, unknown>;
    if (obj.success === false) return true;
    if (obj.success === true) return false;
  }
  const json = normalizeToolResponse(tr);
  if (json === null) return false;
  return isNonAnswer(json);
}

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

function offeredOptionLabelsByText(toolInput: unknown): Map<string, Set<string>> {
  const offered = new Map<string, Set<string>>();
  if (toolInput === null || typeof toolInput !== "object") return offered;
  const questions = (toolInput as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return offered;
  for (const question of questions) {
    if (question === null || typeof question !== "object") continue;
    const record = question as Record<string, unknown>;
    if (typeof record.question !== "string" || !Array.isArray(record.options)) continue;
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
    offered.set(record.question, labels);
  }
  return offered;
}

function hasExplicitHumanSelection(toolResponse: unknown, toolInput?: unknown): boolean {
  const json = normalizeToolResponse(toolResponse);
  if (json === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const response = parsed as Record<string, unknown>;
  // The answers object may be wrapped in {answers: {...}} or be the top-level
  // object itself (real Devin 3000.6.14 interactive export has no wrapper).
  let answers: unknown = response;
  if ("answers" in response) answers = (response as Record<string, unknown>).answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return false;
  const selections = Object.entries(answers as Record<string, unknown>);
  if (selections.length === 0) return false;
  const offered = offeredOptionLabels(toolInput);
  const offeredByText = offeredOptionLabelsByText(toolInput);
  return selections.every(([questionKey, selection]) => {
    // Claude Code shape: non-array object with an `answers` array of strings.
    if (selection !== null && typeof selection === "object" && !Array.isArray(selection)) {
      const record = selection as Record<string, unknown>;
      if (Array.isArray(record.answers)) {
        return record.answers.length > 0 && record.answers.every((answer) => {
          if (typeof answer !== "string" || answer.trim().length === 0) return false;
          return !isNonAnswer(answer) || offered.get(questionKey)?.has(answer.trim()) === true;
        });
      }
      // Devin 3000.6.14 native shape: single object with `selected` array and
      // `skipped` boolean (not an array of objects like the synthetic shape).
      if (Array.isArray(record.selected)) {
        if (record.skipped === true) return false;
        const texts: string[] = [];
        for (const label of record.selected) {
          if (typeof label === "string") texts.push(label);
        }
        if (typeof record.custom_text === "string" && record.custom_text.trim().length > 0) {
          texts.push(record.custom_text);
        }
        if (texts.length === 0) return false;
        return texts.every((text) => {
          if (text.trim().length === 0) return false;
          return !isNonAnswer(text) || offeredByText.get(questionKey)?.has(text.trim()) === true;
        });
      }
      return false;
    }
    // Devin shape: array of {selected: string[], custom_text: string} objects.
    if (Array.isArray(selection)) {
      if (selection.length === 0) return false;
      return selection.every((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
        const record = entry as Record<string, unknown>;
        if (!Array.isArray(record.selected)) return false;
        const texts: string[] = [];
        for (const label of record.selected) {
          if (typeof label === "string") texts.push(label);
        }
        if (typeof record.custom_text === "string" && record.custom_text.trim().length > 0) {
          texts.push(record.custom_text);
        }
        if (texts.length === 0) return false;
        return texts.every((text) => {
          if (text.trim().length === 0) return false;
          return !isNonAnswer(text) || offeredByText.get(questionKey)?.has(text.trim()) === true;
        });
      });
    }
    return false;
  });
}

function explicitHumanSelectionText(toolResponse: unknown): string {
  const json = normalizeToolResponse(toolResponse);
  if (json === null) return "";
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    // The answers object may be wrapped in {answers: {...}} or be the top-level
    // object itself (real Devin 3000.6.14 interactive export has no wrapper).
    let answersObj: Record<string, unknown> | undefined;
    if (parsed.answers !== null && typeof parsed.answers === "object" && !Array.isArray(parsed.answers)) {
      answersObj = parsed.answers as Record<string, unknown>;
    } else {
      answersObj = parsed;
    }
    for (const selection of Object.values(answersObj)) {
      // Claude Code shape: object with an `answers` array of strings.
      if (selection !== null && typeof selection === "object" && !Array.isArray(selection)) {
        const record = selection as Record<string, unknown>;
        if (Array.isArray(record.answers)) {
          for (const answer of record.answers) {
            if (typeof answer === "string" && answer.trim()) return answer.trim();
          }
        }
        // Devin 3000.6.14 native shape: single object with `selected` array.
        if (Array.isArray(record.selected)) {
          for (const label of record.selected) {
            if (typeof label === "string" && label.trim()) return label.trim();
          }
          if (typeof record.custom_text === "string" && record.custom_text.trim()) {
            return record.custom_text.trim();
          }
        }
      }
      // Devin synthetic shape: array of {selected: string[], custom_text: string} objects.
      if (Array.isArray(selection)) {
        for (const entry of selection) {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
          const record = entry as Record<string, unknown>;
          if (Array.isArray(record.selected)) {
            for (const label of record.selected) {
              if (typeof label === "string" && label.trim()) return label.trim();
            }
          }
          if (typeof record.custom_text === "string" && record.custom_text.trim()) {
            return record.custom_text.trim();
          }
        }
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

// Lift tool_input.workdir into the top-level cwd field the core
// plan-approval-guard reads (parsed.cwd at aidlc-plan-approval-guard.ts:665).
// The guard's isFrameworkToolInvocation resolves framework-tool script
// paths against cwd (resolve(cwd, script) at line 487). Without this lift,
// a framework tool command run from a subdirectory (Devin
// passes the subdirectory as workdir) fails the framework-tool exemption
// because the guard resolves the script path against the project root.
function rewriteStdinCwd(rawInput: string, devin: DevinHookInput): string {
  const workdir = devin.tool_input?.workdir;
  if (typeof workdir !== "string" || !workdir) return rawInput;
  try {
    const parsed = JSON.parse(rawInput) as Record<string, unknown>;
    if (typeof parsed.cwd !== "string" || !parsed.cwd) {
      parsed.cwd = workdir;
      return JSON.stringify(parsed);
    }
    return rawInput;
  } catch {
    return rawInput;
  }
}

// Devin run_subagent native input: { profile, task, title, is_background? }.
// The core dispatch hooks read subagent_type / prompt / run_in_background, so
// both PreToolUse arms that handle run_subagent normalize through this one
// helper: `profile` is the only identity and `task` the only brief. The
// native keys ride along in `core` (spread first) so the core's field order —
// prompt before task — keeps the payload recognizable; the stage-rule arm's
// reverse translation strips the injected aliases before anything goes back
// to Devin.
function normalizeRunSubagentInput(ti: Record<string, unknown>): {
  core: Record<string, unknown>;
  profile: string;
} {
  const profile = typeof ti.profile === "string" ? ti.profile : "";
  const task = typeof ti.task === "string" ? ti.task : "";
  const core: Record<string, unknown> = { ...ti };
  if (profile) core.subagent_type = profile;
  if (task) core.prompt = task;
  if (ti.is_background === true) core.run_in_background = true;
  return { core, profile };
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

// --- Subagent lifecycle classification (log-subagent) -------------------------
//
// Devin emits no SubagentStart/SubagentStop hook events (C16 on 3000.10.31:
// the key is not loadable in either config location; SubagentStop exists in
// the binary only as an output-envelope name — which is exactly the payload
// shape we synthesize for the core hook). This arm reconstructs the Claude
// pair from the tool outputs Devin DOES produce. The output strings are an
// undocumented, versioned host contract pinned from the 3000.10.31 binary
// and tests/fixtures/devin-hook-payloads/captured-3000.10.31.json; every
// match is anchored at the start of the first output line and tolerant of
// the leading tab the binary emits.

// Extract the host's output text from a Devin PostToolUse tool_response
// ({success, output, error}); a bare-string response (synthetic fixtures) is
// itself the output.
function subagentToolOutput(toolResponse: unknown): string {
  if (typeof toolResponse === "string") return toolResponse;
  if (
    toolResponse !== null &&
    typeof toolResponse === "object" &&
    !Array.isArray(toolResponse)
  ) {
    const output = (toolResponse as Record<string, unknown>).output;
    if (typeof output === "string") return output;
  }
  return "";
}

function toolResponseFailed(toolResponse: unknown): boolean {
  return (
    toolResponse !== null &&
    typeof toolResponse === "object" &&
    !Array.isArray(toolResponse) &&
    (toolResponse as Record<string, unknown>).success === false
  );
}

// Strip the single leading tab the binary emits before the status line.
function unindentSubagentOutput(output: string): string {
  return output.startsWith("\t") ? output.slice(1) : output;
}

// "Background subagent started with agent_id=<id>. …" — the launch
// acknowledgment, the ONLY non-terminal run_subagent success output.
// Returns the embedded agent id, or null.
function matchSubagentLaunchAck(output: string): string | null {
  const m = /^Background subagent started with agent_id=([^\s.]+)/.exec(
    unindentSubagentOutput(output),
  );
  return m ? m[1] : null;
}

// Foreground / resumed run_subagent terminal envelopes:
//   "Subagent agent_id=<id> completed successfully:\n\n<report>"
//   "Subagent <id> exited with an error:…"
//   "Subagent error: …"      (dispatch-level error carrying no agent id)
// Returns {agentId} — agentId undefined for the id-less error form — or null
// when the output is not a terminal envelope.
function matchSubagentTerminal(output: string): { agentId?: string } | null {
  const out = unindentSubagentOutput(output);
  const m = /^Subagent (?:agent_id=)?(\S+) (?:completed successfully:|exited with an error)/.exec(
    out,
  );
  if (m) return { agentId: m[1] };
  if (/^Subagent error:/.test(out)) return {};
  return null;
}

// read_subagent terminal envelopes:
//   "Subagent <id> completed. Its full report is delivered in the
//    <subagent_completion_notification> message; you do not need to read it
//    again."                                        (first terminal read)
//   "Subagent <id> completed successfully:\n\n<report>"  (re-served report)
//   "Subagent <id> exited with an error. The error details are delivered in
//    the <subagent_completion_notification> message."   (error terminal —
//    binary-pinned; a denied-tool child reads as 'completed', C12)
// Returns the embedded agent id plus the message to forward: the re-served
// report when present, else the one-line status.
function matchSubagentReadTerminal(
  output: string,
): { agentId: string; message: string } | null {
  const m = /^Subagent (?:agent_id=)?(\S+) (?:completed|exited with an error)/.exec(
    unindentSubagentOutput(output),
  );
  if (!m) return null;
  return { agentId: m[1], message: subagentTerminalMessage(output) };
}

// "Subagent is still running." / "No subagent found with agent_id=…" — the
// non-terminal read outputs.
function isSubagentReadPending(output: string): boolean {
  const out = unindentSubagentOutput(output);
  return (
    /^Subagent is still running\./.test(out) ||
    /^No subagent found\b/.test(out)
  );
}

// "output minus the header line": the completed-successfully envelope
// carries the agent's report after its status line; every other terminal
// form is a one-line status forwarded whole (the core trims to 200 chars).
function subagentTerminalMessage(output: string): string {
  const out = unindentSubagentOutput(output);
  const nl = out.indexOf("\n");
  return nl < 0 ? out : out.slice(nl + 1).replace(/^\s+/, "");
}

// Forward a synthesized Claude-shaped SubagentStop payload to the core
// log-subagent hook. The core completes the in-flight entry by exact agent
// id when one is carried (falling back to the legacy session splice only
// when the session has no annotated entries) and appends SUBAGENT_COMPLETED.
function forwardSubagentStop(
  agentType: string | undefined,
  agentId: string | undefined,
  message: string,
): void {
  runCore(
    "aidlc-log-subagent.ts",
    JSON.stringify({
      hook_event_name: "SubagentStop",
      ...(devin.session_id ? { session_id: devin.session_id } : {}),
      ...(agentType ? { agent_type: agentType } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
      ...(message ? { last_assistant_message: message } : {}),
    }),
  );
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
      if (r.code === 0 && devin.hook_event_name === "SessionStart") {
        try {
          mkdirSync(join(projectDir, ".devin"), { recursive: true });
          writeFileSync(
            join(projectDir, ".devin", ".aidlc-session-start.local.json"),
            `${JSON.stringify({ lastRun: new Date().toISOString() })}\n`,
            "utf-8",
          );
        } catch {
          process.stderr.write("AI-DLC: could not write Devin SessionStart evidence; check .devin write permissions and rerun /aidlc --doctor after restarting Devin CLI.\n");
        }
      }
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
      // For ask_user_question PostToolUse, skip ONLY for genuine cancellations
      // (success:false or cancellation text). An unrecognized answer shape
      // still means the user interacted — the PostToolUse firing is evidence
      // of that — and the gate fails closed without a HUMAN_TURN (the S08 bug
      // on Devin 3000.6.14: the parser couldn't recognize the real interactive
      // tool_response shape, so it skipped the mint and every later gate
      // refused). For UserPromptSubmit and all other events, always forward.
      // Advisory, no stdout.
      if (
        tool === "ask_user_question" &&
        !hasExplicitHumanSelection(devin.tool_response, devin.tool_input) &&
        isAskUserQuestionCancellation(devin)
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
      // exec→Bash: pipe to the core guard (stderr variant). tool_input.workdir
      //   is lifted into the top-level cwd first so the guard resolves
      //   framework-tool script paths against the subdirectory (the cwd the
      //   conductor actually ran the command from), not the project root.
      // edit/write/apply_patch→ fan out one Write per touched path.
      // run_subagent→ normalize to the core Task shape
      //   {PreToolUse, Task, {subagent_type, prompt}}. Only block for the
      //   developer agent target (mirror codex's early-allow for non-developer).
      // Block contract: exit 2 + stderr.
      if (tool === "exec") {
        const rewritten = rewriteStdinCwd(rewriteStdinToolName(rawInput, devin), devin);
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
      // Normalize the native dispatch input and forward the core Task shape
      // {PreToolUse, Task, {subagent_type, prompt}}; only block for the
      // developer agent target (mirror codex's early-allow for non-developer).
      const normalized = normalizeRunSubagentInput(devin.tool_input ?? {});
      if (normalized.profile !== "aidlc-developer-agent") {
        return 0;
      }
      const fwd = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        ...(devin.session_id ? { session_id: devin.session_id } : {}),
        tool_input: {
          subagent_type: normalized.profile,
          prompt:
            typeof normalized.core.prompt === "string"
              ? normalized.core.prompt
              : "",
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
      // run_subagent → normalize to the core Task shape and pipe to
      // aidlc-deliver-stage-rules.ts. The core's updatedInput comes back in
      // the core shape, so translate it to Devin's native one by emitting
      // only `task` (Devin merges updatedInput into the tool arguments as a
      // subset, so the changed field alone is the smallest correct rewrite —
      // never the injected subagent_type/prompt/run_in_background aliases and
      // never the pass-through profile/title/is_background keys). The core
      // rewrites the brief under whichever string field it found first, so
      // `task` wins when it carries a new value and `prompt` (the injected
      // alias the core prefers) is the fallback. Exit 2 + stderr on a core
      // block; exit 3 (the preload-fallback path) cannot occur on Devin and
      // any other unexpected code fails open.
      if (tool !== "run_subagent") {
        return 0;
      }
      const normalized = normalizeRunSubagentInput(devin.tool_input ?? {});
      const task = typeof normalized.core.prompt === "string"
        ? normalized.core.prompt
        : "";
      const rewritten = JSON.stringify({
        ...devin,
        tool_name: "Task",
        tool_input: normalized.core,
      });
      const r = runCoreWithStderr("aidlc-deliver-stage-rules.ts", rewritten);
      if (r.code === 2) {
        process.stderr.write(r.stderr);
        return 2;
      }
      if (r.code !== 0) {
        if (r.stderr) process.stderr.write(r.stderr);
        return 0;
      }
      if (r.stdout.trim()) {
        try {
          const updated = (
            JSON.parse(r.stdout) as {
              hookSpecificOutput?: {
                updatedInput?: Record<string, unknown>;
              };
            }
          ).hookSpecificOutput?.updatedInput;
          const out =
            typeof updated?.task === "string" && updated.task !== task
              ? updated.task
              : typeof updated?.prompt === "string" && updated.prompt !== task
                ? updated.prompt
                : undefined;
          if (out !== undefined) {
            process.stdout.write(
              `${JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  updatedInput: { task: out },
                },
              })}\n`,
            );
          }
        } catch {
          // Unparseable core output — nothing to translate; allow.
        }
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
      // PostToolUse for run_subagent / read_subagent (the matcher is
      // ^(run_subagent|read_subagent)$). The synthesized SubagentStart/
      // SubagentStop pair, per the classifier helpers above:
      //   run_subagent + resume:<id>      → terminal under that agent id
      //   run_subagent + launch ack        → annotate the in-flight entry the
      //                                      deliver-stage-rules PreToolUse
      //                                      created; no core call, no audit
      //   run_subagent + terminal output   → forward a synthesized SubagentStop
      //   run_subagent + anything else     → fail-open terminal forward (the
      //                                      pre-correlation contract: a
      //                                      completion is never dropped)
      //   read_subagent + terminal output  → forward only while an annotated
      //                                      entry for that id is pending
      //                                      (repeated reads and foreign ids
      //                                      are no-ops)
      //   read_subagent + non-terminal     → no-op; unclassifiable → no-op +
      //                                      a log-subagent drop line
      const output = subagentToolOutput(devin.tool_response);
      const input = devin.tool_input ?? {};
      const profile =
        typeof input.profile === "string" && input.profile !== ""
          ? input.profile
          : undefined;
      if (tool === "run_subagent") {
        // A resume always runs foreground under the resumed agent id; an
        // annotated entry for that id (an unread earlier background run) is
        // completed by the core's exact-id path.
        const resume =
          typeof input.resume === "string" && input.resume !== ""
            ? input.resume
            : null;
        if (resume) {
          forwardSubagentStop(profile, resume, subagentTerminalMessage(output));
          return 0;
        }
        const launchedId =
          input.is_background === true ? matchSubagentLaunchAck(output) : null;
        if (launchedId !== null) {
          try {
            annotateSubagentInflight(projectDir, devin.session_id, {
              agentId: launchedId,
              ...(profile ? { agentType: profile } : {}),
            });
          } catch (error) {
            recordHookDrop(
              projectDir,
              "log-subagent",
              `could not annotate the background-subagent in-flight ledger: ${errorMessage(error)}`,
            );
          }
          return 0;
        }
        const terminal = matchSubagentTerminal(output);
        if (terminal !== null) {
          forwardSubagentStop(
            profile,
            terminal.agentId,
            subagentTerminalMessage(output),
          );
          return 0;
        }
        forwardSubagentStop(profile, undefined, output);
        return 0;
      }
      if (tool === "read_subagent") {
        if (toolResponseFailed(devin.tool_response)) return 0;
        const terminalRead = matchSubagentReadTerminal(output);
        if (terminalRead !== null) {
          try {
            const entry = findSubagentInflight(
              projectDir,
              devin.session_id,
              terminalRead.agentId,
            );
            if (entry) {
              forwardSubagentStop(
                entry.agentType,
                terminalRead.agentId,
                terminalRead.message,
              );
            }
          } catch (error) {
            recordHookDrop(
              projectDir,
              "log-subagent",
              `could not inspect the background-subagent in-flight ledger: ${errorMessage(error)}`,
            );
          }
          return 0;
        }
        if (!isSubagentReadPending(output)) {
          recordHookDrop(
            projectDir,
            "log-subagent",
            "unclassified read_subagent output",
          );
        }
        return 0;
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
