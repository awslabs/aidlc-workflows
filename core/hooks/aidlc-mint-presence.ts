// UserPromptSubmit hook: record a HUMAN_TURN event (human-presence gate).
//
// On every real human prompt, append a HUMAN_TURN event to the active intent's
// audit shard (the state machine's own append-only ledger). The approval /
// interview gate (handleApprove / handleAnswer) refuses unless a HUMAN_TURN was
// recorded since the last gate resolution, so a model under autopilot cannot
// fabricate an approval with no human having acted this turn.
//
// Presence-only: the prompt text is irrelevant, so stdin is not read.
// appendAuditEntry resolves the active intent from the on-disk cursor using only
// the project dir (no payload needed). The mint is fail-open (try/catch, exit 0):
// a mint failure must never block the human's turn, and the gate fails open on a
// harness whose ledger has no HUMAN_TURN yet.
import { resolveProjectDirFromHook } from "../tools/aidlc-lib.ts";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";

try {
  const projectDir = resolveProjectDirFromHook(import.meta.url);
  appendAuditEntry("HUMAN_TURN", {}, projectDir);
} catch {
  // Non-fatal — a mint failure must never block the human's turn.
}

process.exit(0);
