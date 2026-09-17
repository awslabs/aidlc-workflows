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
  bindDevinReviewerAgent,
  clearDevinReviewerRegistrations,
  completeDevinReviewerRegistration,
  DEVIN_REVIEWER_PROFILE_RE,
  isNonAnswer,
  liveDevinReviewerRegistrations,
  liveDevinSubagents,
  markDevinReviewerIsolationDegraded,
  readDevinSubagentLedgerEntry,
  recordDevinSubagentLaunch,
  recordDevinSubagentTerminal,
  registerDevinReviewer,
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
//      real interactive session export (tests/fixtures/devin-hook-payloads/).

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

// --- run_subagent field normalization -----------------------------------------
//
// Devin's native run_subagent tool_input is {profile, task, is_background,
// title}; the core hooks expect {subagent_type, prompt, run_in_background}.
// normalizeSubagentInput produces the canonical shape while preserving every
// native field; denormalizeSubagentInput maps a core-emitted updatedInput back
// to the native shape so Devin receives the augmentation under the field it
// understands (`task`, not `prompt`).
//
// Field map:                        canonical wins when already present;
//   profile / agent → subagent_type   `profile` wins over `agent`
//   task            → prompt
//   is_background   → run_in_background

function normalizeSubagentInput(
  ti: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...ti };
  if (out.subagent_type === undefined) {
    const profile = out.profile ?? out.agent;
    if (profile !== undefined) out.subagent_type = profile;
  }
  if (out.prompt === undefined && out.task !== undefined) {
    out.prompt = out.task;
  }
  if (out.run_in_background === undefined && out.is_background !== undefined) {
    out.run_in_background = out.is_background;
  }
  return out;
}

function denormalizeSubagentInput(
  updatedInput: Record<string, unknown>,
  originalToolInput: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...updatedInput };
  if ("subagent_type" in out) {
    if ("profile" in originalToolInput) {
      out.profile = out.subagent_type;
      delete out.subagent_type;
    } else if ("agent" in originalToolInput) {
      out.agent = out.subagent_type;
      delete out.subagent_type;
    }
    // An already-canonical original keeps `subagent_type` in the output.
  }
  if ("task" in originalToolInput && "prompt" in out) {
    out.task = out.prompt;
    delete out.prompt;
  }
  if ("is_background" in originalToolInput && "run_in_background" in out) {
    out.is_background = out.run_in_background;
    delete out.run_in_background;
  }
  return out;
}

// --- run_subagent / read_subagent lifecycle -----------------------------------
//
// Devin reports a background subagent's launch and its terminal outcome through
// two different surfaces: run_subagent's PostToolUse response acknowledges the
// launch (`Background subagent started with agent_id=<id>...`), and the
// terminal result arrives later inside a read_subagent response
// (`Subagent <id> completed successfully: ...`). A foreground run_subagent
// response is already terminal (`Subagent agent_id=<id> completed
// successfully: ...`). The adapter therefore treats the run_subagent
// PostToolUse as "launch or foreground completion" and correlates the real
// terminal outcome by the Devin agent id carried in the response text.
//
// Outcome classification reads the response envelope's success/error fields
// plus the human-readable output text. Only the completion text is a live
// capture (3000.6.14); the failure/cancellation words follow the same
// "Subagent <id> <outcome>:" grammar. Anything unrecognized (including a
// blocking read that timed out mid-run) records no terminal state.

function toolResponseEnvelope(
  tr: unknown,
): { success: boolean | null; text: string } {
  if (typeof tr === "string") return { success: null, text: tr };
  if (tr !== null && typeof tr === "object" && !Array.isArray(tr)) {
    const obj = tr as Record<string, unknown>;
    return {
      success: typeof obj.success === "boolean" ? obj.success : null,
      text:
        typeof obj.output === "string"
          ? obj.output
          : typeof obj.error === "string"
            ? obj.error
            : "",
    };
  }
  return { success: null, text: "" };
}

// The agent id appears inside the response text as `agent_id=<id>` (both the
// launch acknowledgement and the completion notice carry it).
function extractDevinAgentId(text: string): string {
  const m = /\bagent_id=([A-Za-z0-9_-]+)/.exec(text);
  if (m) return m[1];
  const m2 = /^Subagent ([A-Za-z0-9_-]+) /m.exec(text);
  return m2 ? m2[1] : "";
}

function classifySubagentOutcome(
  env: { success: boolean | null; text: string },
): "success" | "failure" | "cancelled" | null {
  // Classify the notification's grammar, never the free-form body: only the
  // first line's head (the part before the first ':') carries the state verb.
  // Captured grammar: "Subagent <id> completed successfully:" and
  // "Subagent <id> completed. Its full report is delivered …". The
  // failure/cancelled verb sets below are extrapolations of that same
  // "Subagent <id> <verb>" notification shape, not captured strings.
  const firstLine = env.text.split("\n", 1)[0] ?? "";
  const head = firstLine.split(":", 1)[0];
  if (/^Subagent\s+/i.test(head.trim())) {
    if (/\bcancell?ed\b/i.test(head)) return "cancelled";
    if (/\b(failed|failure|crashed|terminated|timed out)\b/i.test(head)) {
      return "failure";
    }
    if (/\b(completed|finished|succeeded)\b/i.test(head)) return "success";
  }
  // The envelope's own failure flag is terminal evidence even when the output
  // text does not spell a known outcome word.
  if (env.success === false) return "failure";
  return null;
}

// Emit the core SUBAGENT_COMPLETED record for an observed terminal state.
// Foreground completions also land here (they ARE the terminal signal for
// foreground dispatches). The in-flight-ledger release and audit row live in
// the core hook.
function emitSubagentCompleted(
  session: string,
  agentId: string,
  agentType: string,
  outcome: "success" | "failure" | "cancelled" | null,
  message: string,
): void {
  runCore(
    "aidlc-log-subagent.ts",
    JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Task",
      ...(session ? { session_id: session } : {}),
      agent_type: agentType || "unknown",
      ...(agentId ? { agent_id: agentId } : {}),
      ...(outcome ? { subagent_outcome: outcome } : {}),
      last_assistant_message: message.slice(0, 200),
    }),
  );
}

// --- reviewer identity attribution --------------------------------------------
//
// Devin child tool events carry the PARENT session_id and no
// agent_type/agent_id (captured 3000.6.14, C09 established the negative). The
// only per-event issuer signal is the tool_use_id format:
// "chatcmpl-tool-<hex>" marks the parent/conductor, "functions.<tool>:<n>"
// marks a subagent-issued call. Both formats are captured evidence, not a
// permanent vendor schema — an unrecognized or absent tool_use_id classifies
// as unknown, and an unknown caller during a live reviewer topology is
// refused rather than silently permitted.
type DevinIssuer = "conductor" | "subagent" | "unknown";

function devinIssuer(toolUseId: unknown): DevinIssuer {
  if (typeof toolUseId !== "string" || toolUseId.length === 0) return "unknown";
  if (toolUseId.startsWith("chatcmpl-tool-")) return "conductor";
  if (toolUseId.startsWith("functions.")) return "subagent";
  return "unknown";
}

// Resolve the identity fields forwarded to the core reviewer-scope hook.
// Direct payload agent_type/agent_id always win. A subagent-issued call while
// a reviewer registration is live in this session is attributed to the
// registered reviewer (the session-scoped registration IS the identity, the
// Kiro scoped-registration contract); multiple live registrations assert only
// scoped_registration so the core still enforces against the dispatch record.
// The conductor and sessions without any reviewer topology forward nothing.
// An unattributable caller during a live reviewer topology is refused —
// missing identity must not become silent permission.
function reviewerScopeIdentity(
  session: string,
  isWrite: boolean,
): { fields: Record<string, unknown>; blockReason: string | null } {
  const fields: Record<string, unknown> = {};
  if (devin.agent_type) fields.agent_type = devin.agent_type;
  if (devin.agent_id) fields.agent_id = devin.agent_id;
  if (fields.agent_type) return { fields, blockReason: null };

  const issuer = devinIssuer(devin.tool_use_id);
  const live = session
    ? liveDevinReviewerRegistrations(projectDir, session)
    : [];

  if (issuer === "conductor") return { fields, blockReason: null };
  if (issuer === "subagent") {
    if (live.length === 0) return { fields, blockReason: null };
    // A `functions.*` call is attributable to the reviewer only when the
    // reviewer is the ONLY subagent in flight for this session. Any other
    // live subagent makes the caller unattributable: reads stay allowed
    // (unattributed), writes refuse, and the session is marked degraded.
    const boundIds = new Set(
      live.map((r) => r.agentId).filter((id): id is string => !!id),
    );
    const concurrent = liveDevinSubagents(projectDir, session).filter(
      (entry) => !boundIds.has(entry.agentId),
    );
    if (concurrent.length > 0) {
      markDevinReviewerIsolationDegraded(projectDir, session);
      if (isWrite) {
        return {
          fields: {},
          blockReason:
            "AI-DLC reviewer isolation degraded: a reviewer is in flight " +
            "alongside other subagents in this session, so this " +
            "subagent-issued write cannot be attributed and is refused " +
            "rather than scoped. Dispatch reviewers serially (no other " +
            "subagent in flight) for guaranteed isolation.",
        };
      }
      return { fields, blockReason: null };
    }
    const distinct = new Set(live.map((r) => r.reviewer));
    if (distinct.size === 1) {
      fields.agent_type = live[0].reviewer;
    } else {
      fields.scoped_registration = true;
    }
    return { fields, blockReason: null };
  }
  // Unknown issuer.
  if (live.length > 0) {
    return {
      fields,
      blockReason:
        "AI-DLC reviewer isolation: this tool call cannot be attributed to a " +
        "caller (no agent_type and an unrecognized tool_use_id format) while a " +
        "reviewer is in flight for this session, so it is refused rather than " +
        "silently permitted.",
    };
  }
  return { fields, blockReason: null };
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
      // the core session-end hook, then retire this session's reviewer
      // registrations — reviewer identity is session-scoped and must not
      // outlive the session that minted it. Advisory.
      runCore("aidlc-session-end.ts", rawInput);
      if (payloadSessionId) {
        try {
          clearDevinReviewerRegistrations(projectDir, payloadSessionId);
        } catch {
          // Session runtime cleanup is best-effort.
        }
      }
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
      // edit/write/notebook_edit→ forward {PreToolUse, Edit|Write|NotebookEdit,
      //   {file_path|notebook_path}}.
      // read/notebook_read→ forward {PreToolUse, Read|NotebookRead, {file_path|
      //   notebook_path}} — the native read tools go through the same shared
      //   matcher (they are how a reviewer actually sweeps sibling units).
      // glob→ Glob {pattern, path}; grep→ Grep {path, glob: glob_pattern} —
      //   the core matcher wants the search root (`path`) plus the FILE-name
      //   glob under `glob` (Devin spells it `glob_pattern`); the content
      //   `pattern` is deliberately not forwarded: matching file content is
      //   not file access.
      // apply_patch→ fan out one Edit/Write per parsed file (Delete File /
      //   Move to included as Edit). Block on first out-of-scope file.
      // Identity: agent_type/agent_id forward when present on every branch;
      // otherwise reviewerScopeIdentity attributes a subagent-issued call to
      // this session's live reviewer registration and refuses an
      // unattributable call while that topology is in flight.
      const scopedTools = [
        "exec",
        "edit",
        "write",
        "notebook_edit",
        "apply_patch",
        "read",
        "notebook_read",
        "glob",
        "grep",
        "ls",
      ];
      if (!scopedTools.includes(tool)) return 0;

      const identity = reviewerScopeIdentity(
        payloadSessionId ?? "",
        ["exec", "edit", "write", "notebook_edit", "apply_patch"].includes(tool),
      );
      if (identity.blockReason !== null) {
        process.stderr.write(`${identity.blockReason}\n`);
        return 2;
      }
      const identityFields = identity.fields;

      if (tool === "exec") {
        const rewritten = rewriteStdinToolName(rawInput, devin);
        // The verbatim rewrite already carries agent_type/agent_id; merge the
        // attributed identity only when the payload itself carried none.
        let fwd = rewritten;
        if (Object.keys(identityFields).length > 0 && !devin.agent_type) {
          try {
            const parsed = JSON.parse(rewritten) as Record<string, unknown>;
            Object.assign(parsed, identityFields);
            fwd = JSON.stringify(parsed);
          } catch {
            // Keep the verbatim payload.
          }
        }
        const r = runCoreWithStderr("aidlc-reviewer-scope.ts", fwd);
        if (r.code === 2) {
          process.stderr.write(r.stderr);
          return 2;
        }
        return 0;
      }
      if (tool === "edit" || tool === "write" || tool === "notebook_edit") {
        const ti = devin.tool_input ?? {};
        const filePath = (ti.file_path ?? ti.notebook_path ?? ti.path) as
          | string
          | undefined;
        if (typeof filePath === "string" && filePath) {
          const fwd = JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: DEVIN_TO_CLAUDE_TOOL[tool],
            tool_input: { file_path: filePath },
            ...(devin.session_id ? { session_id: devin.session_id } : {}),
            ...(typeof devin.cwd === "string" ? { cwd: devin.cwd } : {}),
            ...identityFields,
          });
          const r = runCoreWithStderr("aidlc-reviewer-scope.ts", fwd);
          if (r.code === 2) {
            process.stderr.write(r.stderr);
            return 2;
          }
        }
        return 0;
      }
      if (tool === "read" || tool === "notebook_read") {
        const ti = devin.tool_input ?? {};
        const coreInput: Record<string, unknown> = {};
        if (typeof ti.file_path === "string") coreInput.file_path = ti.file_path;
        if (typeof ti.notebook_path === "string") {
          coreInput.notebook_path = ti.notebook_path;
        }
        if (typeof ti.path === "string") coreInput.path = ti.path;
        const fwd = JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: DEVIN_TO_CLAUDE_TOOL[tool],
          tool_input: coreInput,
          ...(devin.session_id ? { session_id: devin.session_id } : {}),
          ...(typeof devin.cwd === "string" ? { cwd: devin.cwd } : {}),
          ...identityFields,
        });
        const r = runCoreWithStderr("aidlc-reviewer-scope.ts", fwd);
        if (r.code === 2) {
          process.stderr.write(r.stderr);
          return 2;
        }
        return 0;
      }
      if (tool === "glob" || tool === "grep" || tool === "ls") {
        const ti = devin.tool_input ?? {};
        const coreInput: Record<string, unknown> = {};
        if (tool === "glob" && typeof ti.pattern === "string") {
          coreInput.pattern = ti.pattern;
        }
        if (typeof ti.path === "string") coreInput.path = ti.path;
        if (typeof ti.glob_pattern === "string") {
          coreInput.glob = ti.glob_pattern;
        }
        const fwd = JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: DEVIN_TO_CLAUDE_TOOL[tool],
          tool_input: coreInput,
          ...(devin.session_id ? { session_id: devin.session_id } : {}),
          ...(typeof devin.cwd === "string" ? { cwd: devin.cwd } : {}),
          ...identityFields,
        });
        const r = runCoreWithStderr("aidlc-reviewer-scope.ts", fwd);
        if (r.code === 2) {
          process.stderr.write(r.stderr);
          return 2;
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
            ...(devin.session_id ? { session_id: devin.session_id } : {}),
            ...(typeof devin.cwd === "string" ? { cwd: devin.cwd } : {}),
            ...identityFields,
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
      // agent_type/agent_id forward on every branch when present (the
      // write-freeze decision itself is caller-agnostic; the fields feed the
      // core hook's audit context).
      const freezeIdentity = {
        ...(devin.agent_type ? { agent_type: devin.agent_type } : {}),
        ...(devin.agent_id ? { agent_id: devin.agent_id } : {}),
      };
      if (tool === "exec") {
        const rewritten = rewriteStdinToolName(rawInput, devin);
        const r = runCoreWithStderr("aidlc-review-freeze.ts", rewritten);
        if (r.code === 2) {
          process.stderr.write(r.stderr);
          return 2;
        }
        return 0;
      }
      if (tool === "edit" || tool === "write" || tool === "notebook_edit") {
        const ti = devin.tool_input ?? {};
        const filePath = (ti.file_path ?? ti.notebook_path ?? ti.path) as
          | string
          | undefined;
        if (typeof filePath === "string" && filePath) {
          const fwd = JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: DEVIN_TO_CLAUDE_TOOL[tool],
            tool_input: { file_path: filePath },
            ...freezeIdentity,
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
            ...freezeIdentity,
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
      // Devin's native run_subagent carries the agent under `profile` (or the
      // older `agent`) and the brief under `task`. Normalize before reading so
      // the guard sees the canonical subagent_type/prompt.
      const normalized = normalizeSubagentInput(devin.tool_input ?? {});
      const subagentType =
        typeof normalized.subagent_type === "string"
          ? normalized.subagent_type
          : "";
      if (subagentType !== "aidlc-developer-agent") {
        return 0;
      }
      const prompt =
        typeof normalized.prompt === "string" ? normalized.prompt : "";
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
      // (run_subagent→Task) and the native run_subagent tool_input normalized
      // to the canonical shape so the core hook sees subagent_type/prompt.
      // When the core hook returns an updatedInput, translate it back to
      // Devin-native fields before writing stdout (the active-stage rule
      // bundle must land on `task`, not `prompt`).
      let rewritten = rewriteStdinToolName(rawInput, devin);
      const originalToolInput = devin.tool_input;
      if (tool === "run_subagent" && originalToolInput) {
        try {
          const parsed = JSON.parse(rewritten) as Record<string, unknown>;
          const normalized = normalizeSubagentInput(originalToolInput);
          parsed.tool_input = normalized;
          rewritten = JSON.stringify(parsed);
          // A review-only profile launch registers the session's reviewer
          // topology HERE, at dispatch time — the reviewer's own tool calls
          // (which carry no agent identity on Devin) run between this
          // PreToolUse and the PostToolUse that learns the agent id, so
          // registration cannot wait for the launch response. The task text
          // is never consulted: only the profile field is identity.
          const agentType = normalized.subagent_type;
          if (
            typeof agentType === "string" &&
            DEVIN_REVIEWER_PROFILE_RE.test(agentType) &&
            payloadSessionId
          ) {
            registerDevinReviewer(projectDir, payloadSessionId, agentType);
          }
        } catch {
          // Rewriting is best-effort; the un-normalized payload still pipes.
        }
      }
      const r = runCoreWithStderr("aidlc-deliver-stage-rules.ts", rewritten);
      if (r.stdout) {
        let stdout = r.stdout;
        if (tool === "run_subagent" && originalToolInput) {
          try {
            const out = JSON.parse(r.stdout) as Record<string, unknown>;
            const specific = out.hookSpecificOutput as
              | Record<string, unknown>
              | undefined;
            const updatedInput =
              (specific?.updatedInput ?? out.updatedInput) as
                | Record<string, unknown>
                | undefined;
            if (updatedInput && typeof updatedInput === "object") {
              const native = denormalizeSubagentInput(
                updatedInput,
                originalToolInput,
              );
              if (specific?.updatedInput) specific.updatedInput = native;
              else out.updatedInput = native;
              stdout = `${JSON.stringify(out)}\n`;
            }
          } catch {
            // Unparseable core output — pass through untouched.
          }
        }
        process.stdout.write(stdout);
      }
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
      // run_subagent PostToolUse → "launch or foreground completion".
      // Foreground: the response IS the terminal report — emit
      // SUBAGENT_COMPLETED as before, now with the agent id / profile /
      // outcome carried through.
      // Background: the response only acknowledges the launch — record the
      // agent in the correlation ledger (no terminal audit row) and let the
      // read_subagent observer emit completion when the real result arrives.
      // Advisory.
      if (tool === "run_subagent") {
        const normalized = normalizeSubagentInput(devin.tool_input ?? {});
        const env = toolResponseEnvelope(devin.tool_response);
        const agentId = extractDevinAgentId(env.text);
        const session = payloadSessionId ?? devin.session_id ?? "";
        const agentType =
          typeof normalized.subagent_type === "string"
            ? normalized.subagent_type
            : "unknown";
        if (normalized.run_in_background === true) {
          if (agentId) {
            recordDevinSubagentLaunch(projectDir, {
              agentId,
              session,
              agentType,
            });
            // Only a reviewer-profile launch may bind a pending reviewer
            // registration — otherwise the next non-reviewer subagent would
            // claim the reviewer's identity slot.
            if (session && DEVIN_REVIEWER_PROFILE_RE.test(agentType)) {
              bindDevinReviewerAgent(projectDir, session, agentId);
            }
          }
          return 0;
        }
        // Foreground completion — dedupe through the ledger so a later
        // read_subagent on the same agent cannot emit a second row.
        if (agentId) {
          const outcome = classifySubagentOutcome(env);
          const recorded = recordDevinSubagentTerminal(
            projectDir,
            agentId,
            outcome ?? "success",
            { session, agentType },
          );
          if (session) {
            completeDevinReviewerRegistration(projectDir, session, agentId);
          }
          if (recorded === "already") return 0;
          emitSubagentCompleted(
            session,
            agentId,
            agentType,
            outcome,
            env.text,
          );
          return 0;
        }
        // No agent id in the response: emit the completion unattributed, as
        // before (the core hook still audits Agent Type / message).
        emitSubagentCompleted(
          session,
          "",
          agentType,
          classifySubagentOutcome(env),
          env.text,
        );
      }
      return 0;
    }

    case "observe-subagent": {
      // read_subagent PostToolUse → the real background terminal signal.
      // Correlate by the agent id in tool_input; classify the response text;
      // record the terminal outcome through the ledger exactly once and emit
      // SUBAGENT_COMPLETED on first terminal observation only. A still-running
      // read records nothing; a repeated terminal read is a no-op. Advisory.
      if (tool === "read_subagent") {
        const agentId =
          typeof devin.tool_input?.agent_id === "string"
            ? devin.tool_input.agent_id
            : "";
        if (!agentId) return 0;
        const env = toolResponseEnvelope(devin.tool_response);
        const outcome = classifySubagentOutcome(env);
        if (outcome === null) return 0; // still running or unrecognized
        const session = payloadSessionId ?? devin.session_id ?? "";
        const existing = readDevinSubagentLedgerEntry(projectDir, agentId);
        const recorded = recordDevinSubagentTerminal(projectDir, agentId, outcome, {
          session: existing?.session ?? session,
          agentType: existing?.agentType ?? "unknown",
        });
        if (session) {
          completeDevinReviewerRegistration(projectDir, session, agentId);
        }
        if (recorded === "already") return 0;
        emitSubagentCompleted(
          existing?.session ?? session,
          agentId,
          existing?.agentType ?? "unknown",
          outcome,
          env.text,
        );
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
