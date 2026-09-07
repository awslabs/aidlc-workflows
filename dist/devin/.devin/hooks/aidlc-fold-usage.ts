// PreToolUse + PostToolUse hook (every tool): fold the transcript's new turns
// into the durable usage ledger on EVERY llm call, not just at turn-end.
//
// Why. A non-final llm call always ends in a tool_use, so PostToolUse fires
// after every intermediate call; the final end_turn call has no tool_use and is
// caught by the Stop hook. Folding on BOTH keeps the usage ledger (and the
// statusline segment that reads it) current through the in-flight turn instead
// of lagging by a whole turn. PreToolUse also seals the completing assistant
// call before a lifecycle tool can advance Current Stage. The fold is cheap:
// the offset-aware reader parses
// only the bytes appended to each transcript file since the last fold, and its
// per-file cursor + HOLDBACK model make repeated folds idempotent (the last,
// not-yet-complete message-id group per file is held back - never counted until
// a later fold closes it or the Stop hook flushes - so no split-line group is
// double-counted or lost across a chunk boundary). Normal PreToolUse seals the
// main transcript; an engine-boundary PreToolUse flushes every source so
// completion rollups include final subagent calls; PostToolUse holds back; Stop
// flushes every source file.
//
// HARNESS SCOPE. This is the Claude-Code usage producer: the transcript reader
// in aidlc-usage.ts is Claude-Code-format-specific and this hook is wired only
// in the Claude harness's settings.json. Kiro / Codex / opencode wire no
// producer, so their ledger is never written and every usage consumer degrades
// silently to no-data.
//
// Contract. This hook OBSERVES only - it must never alter Claude Code's flow. It
// prints NOTHING on success (any stdout could be read as hook output), never
// throws (everything is wrapped), and exits 0 in every case.

import { existsSync, readFileSync } from "node:fs";
import {
  resolveProjectDirFromHook,
  isEngineToolCall,
  resolveWorkflowSelection,
  stateFilePathForSelection,
  validSessionId,
  writeCurrentSessionId,
} from "../tools/aidlc-lib.ts";
import { isLifecycleBoundaryCommand } from "./aidlc-state-transition-guard.ts";
import {
  type FoldMode,
  foldTranscriptIntoLedger,
  usageTrackingDisabled,
  writeCurrentTranscriptPath,
} from "../tools/aidlc-usage.ts";

// The Current Stage slug from the state file - a minimal substring match,
// replicating aidlc-continue-workflow.ts's currentStageSlug so byStage keys agree. Returns ""
// when the field is absent.
function currentStageSlug(stateContent: string): string {
  const stageMatch = stateContent.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
  return (stageMatch?.[1] ?? "").trim();
}

function isLifecycleBoundaryToolCall(name: string, input: unknown): boolean {
  if (!/^(bash|shell|execute_bash)$/i.test(name)) {
    return isEngineToolCall(name, input);
  }
  if (input === null || typeof input !== "object") return false;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && isLifecycleBoundaryCommand(command);
}

async function main(): Promise<void> {
  // TTY guard - no Claude Code JSON is coming on a terminal (tests/debug).
  if (process.stdin.isTTY) process.exit(0);

  // Kill switch - this hook fires around EVERY tool call, so exit before
  // reading stdin or touching the ledger. AIDLC_DISABLE_USAGE_TRACKING=1
  // silences the producer entirely (fold, pointers, session-id capture here).
  if (usageTrackingDisabled()) process.exit(0);

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  const input = await Bun.stdin.text();
  let sessionId = "";
  let transcriptPath: string | null = null;
  let foldMode: FoldMode = "holdback";
  try {
    const raw: unknown = JSON.parse(input);
    if (raw !== null && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.session_id === "string") {
        sessionId = validSessionId(obj.session_id) ?? "";
      }
      if (obj.hook_event_name === "PreToolUse") {
        const toolName = typeof obj.tool_name === "string" ? obj.tool_name : "";
        foldMode = isLifecycleBoundaryToolCall(toolName, obj.tool_input)
          ? "flush-all"
          : "seal-main";
      }
      if (typeof obj.transcript_path === "string" && obj.transcript_path.length > 0) {
        transcriptPath = obj.transcript_path;
      }
    }
  } catch {
    // Malformed / empty stdin - nothing to fold. Exit clean below.
  }

  if (!transcriptPath) process.exit(0);

  // Derive the current stage the same way aidlc-continue-workflow.ts does: read the state
  // file directly. Absent state => null so byStage is not polluted.
  let currentStage: string | null = null;
  try {
    const selection = resolveWorkflowSelection(projectDir, {
      sessionId: sessionId || undefined,
    });
    const statePath = stateFilePathForSelection(projectDir, selection);
    if (existsSync(statePath)) {
      currentStage = currentStageSlug(readFileSync(statePath, "utf-8")) || null;
    }
  } catch {
    currentStage = null;
  }

  if (sessionId) writeCurrentSessionId(projectDir, sessionId);
  writeCurrentTranscriptPath(projectDir, sessionId, transcriptPath);
  // PreToolUse seals the main assistant message. Before an engine call it also
  // closes completed subagent groups so lifecycle rollups include their final
  // calls; other PreToolUse events retain subagent holdback. PostToolUse is the
  // normal delayed-write fallback.
  foldTranscriptIntoLedger(projectDir, transcriptPath, currentStage, foldMode, {
    sessionId,
  });
}

// Fully guarded: nothing this hook does may throw into Claude Code or print to
// stdout on success. Any failure is swallowed and we exit 0.
try {
  await main();
} catch {
  // best-effort - usage bookkeeping never breaks a hook
}
process.exit(0);
