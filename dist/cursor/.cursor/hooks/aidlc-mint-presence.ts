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
// the project dir (no payload needed). No workflow state on disk means nothing
// to gate, so the hook exits without writing (same self-gate as
// aidlc-session-start.ts) - otherwise every prompt in a project that carries the
// harness shell but never ran the framework would scaffold and grow audit
// shards. The gate fails open on an empty ledger, so skipping the mint there is
// safe. The mint is fail-open (try/catch, exit 0): a mint failure must never
// block the human's turn.
import { existsSync } from "node:fs";
import { resolveProjectDirFromHook, stateFilePath } from "../tools/aidlc-lib.ts";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";

export async function run(_input: string): Promise<number> {
try {
  const projectDir = resolveProjectDirFromHook(import.meta.url);
  if (existsSync(stateFilePath(projectDir))) {
    appendAuditEntry("HUMAN_TURN", {}, projectDir);
  }
} catch {
  // Non-fatal — a mint failure must never block the human's turn.
}

return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
