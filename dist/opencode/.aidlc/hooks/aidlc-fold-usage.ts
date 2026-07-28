// PostToolUse hook (every tool): fold the transcript's new turns into the
// durable usage ledger on EVERY llm call, not just at turn-end.
//
// Why. A non-final llm call always ends in a tool_use, so PostToolUse fires
// after every intermediate call; the final end_turn call has no tool_use and is
// caught by the Stop hook. Folding on BOTH keeps the usage ledger (and the
// statusline segment that reads it) current through the in-flight turn instead
// of lagging by a whole turn. The fold is cheap: the offset-aware reader parses
// only the bytes appended to each transcript file since the last fold, and its
// per-file cursor + HOLDBACK model make repeated folds idempotent (the last,
// not-yet-complete message-id group per file is held back - never counted until
// a later fold closes it or the Stop hook flushes - so no split-line group is
// double-counted or lost across a chunk boundary). This hook passes flush=false
// (mid-turn); the Stop hook passes flush=true (turn-end) to count the final group.
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
  stateFilePath,
} from "../tools/aidlc-lib.ts";
import {
  foldTranscriptIntoLedger,
  writeCurrentTranscriptPath,
} from "../tools/aidlc-usage.ts";

// The Current Stage slug from the state file - a minimal substring match,
// replicating aidlc-stop.ts's currentStageSlug so byStage keys agree. Returns ""
// when the field is absent.
function currentStageSlug(stateContent: string): string {
  const stageMatch = stateContent.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
  return (stageMatch?.[1] ?? "").trim();
}

async function main(): Promise<void> {
  // TTY guard - no Claude Code JSON is coming on a terminal (tests/debug).
  if (process.stdin.isTTY) process.exit(0);

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  const input = await Bun.stdin.text();
  let sessionId = "";
  let transcriptPath: string | null = null;
  try {
    const raw: unknown = JSON.parse(input);
    if (raw !== null && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.session_id === "string") sessionId = obj.session_id;
      if (typeof obj.transcript_path === "string" && obj.transcript_path.length > 0) {
        transcriptPath = obj.transcript_path;
      }
    }
  } catch {
    // Malformed / empty stdin - nothing to fold. Exit clean below.
  }

  if (!transcriptPath) process.exit(0);

  // Derive the current stage the same way aidlc-stop.ts does: read the state
  // file directly. Absent state => null so byStage is not polluted.
  let currentStage: string | null = null;
  try {
    const statePath = stateFilePath(projectDir);
    if (existsSync(statePath)) {
      currentStage = currentStageSlug(readFileSync(statePath, "utf-8")) || null;
    }
  } catch {
    currentStage = null;
  }

  writeCurrentTranscriptPath(projectDir, sessionId, transcriptPath);
  // flush=false: this is a MID-TURN fold (a non-final llm call ended in a
  // tool_use). The last message-id group per file may still be growing - its
  // real-usage line may not be written yet (new-style transcripts carry usage=0
  // on leading split lines) - so hold it back and let a later fold (a new group
  // closing it, or the Stop hook's flush=true) count it exactly once.
  foldTranscriptIntoLedger(projectDir, transcriptPath, currentStage, false);
}

// Fully guarded: nothing this hook does may throw into Claude Code or print to
// stdout on success. Any failure is swallowed and we exit 0.
try {
  await main();
} catch {
  // best-effort - usage bookkeeping never breaks a hook
}
process.exit(0);
