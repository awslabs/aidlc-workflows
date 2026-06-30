// UserPromptSubmit hook: mint a human-presence marker (issue #451 gate).
//
// On every real human prompt, bump the per-turn clock (aidlc/.aidlc-turn-counter)
// and write aidlc/.aidlc-human-marker {turn, ts, consumed:false} at the workspace
// root. The approval/interview gate (handleApprove / handleAnswer) requires and
// consumes this marker so a model under autopilot cannot fabricate an approval
// with no human having acted at the gate since it opened.
//
// Presence-only: the prompt text is irrelevant, so stdin is not read. The mint
// is fail-open (try/catch, exit 0): a mint failure must never block the human's
// turn, and the gate fails open on a harness whose turn counter was never written.
import { mintHumanMarker, resolveProjectDirFromHook } from "../tools/aidlc-lib.ts";

try {
  const projectDir = resolveProjectDirFromHook(import.meta.url);
  mintHumanMarker(projectDir);
} catch {
  // Non-fatal — a mint failure must never block the human's turn.
}

process.exit(0);
