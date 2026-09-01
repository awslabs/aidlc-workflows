// UserPromptSubmit hook: record a HUMAN_TURN event (human-presence gate).
//
// On every real human prompt, append a HUMAN_TURN event to the active intent's
// audit shard (the state machine's own append-only ledger). The approval /
// interview gate (handleApprove / handleAnswer) refuses unless a HUMAN_TURN was
// recorded since the last gate resolution, so a model under autopilot cannot
// fabricate an approval with no human having acted this turn.
//
// Presence remains the gate signal, while the prompt payload is also inspected
// for an exact protected Plan Approval choice. appendAuditEntry resolves the
// active intent from the on-disk cursor. No workflow state on disk means nothing
// to gate, so the hook exits without writing (same self-gate as
// aidlc-session-start.ts) - otherwise every prompt in a project that carries the
// harness shell but never ran the framework would scaffold and grow audit
// shards. The gate fails open on an empty ledger, so skipping the mint there is
// safe. The mint is fail-open (try/catch, exit 0): a mint failure must never
// block the human's turn.
//
// The same seam also touches the .aidlc-human-turn marker (markHumanTurn). The
// ledger event serves the human-presence GATE; the marker serves the Stop hook's
// conversational carve-out, which needs a cheap "when was the last human prompt,
// relative to the last engine advance?" comparison that works on harnesses
// delivering no transcript. Both ride this seam, but AIDLC_UNATTENDED=1
// deliberately withholds only the authority-bearing ledger event while retaining
// the conversational marker. See the marker family in aidlc-lib.ts.
//
// UNATTENDED DRIVING (AIDLC_UNATTENDED=1). The mint is a presence ASSERTION, and
// this hook has no evidence for it: UserPromptSubmit carries no signal about who
// submitted, and the hook reads no stdin. That is sound while every prompt comes
// from a person, but an unattended driver (an overnight runner resuming the
// workflow on a schedule, CI, a cron) submits prompts too — so it mints a fresh,
// spendable HUMAN_TURN on every cycle and "walking away" stops meaning "no new
// human turn". Measured: 10 runner-submitted prompts, zero humans, and
// humanActedSinceGate() answered true.
//
// So a driver that knows it is not a person says so, and the mint is skipped.
// This is the same doctrine the engine already applies elsewhere — an unattended
// autonomous Construction run "has no human at the gate", which is why
// aidlc-utility refuses scope changes and plan re-shapes and aidlc-state refuses
// park under it. This closes the one path where an unattended turn still
// manufactured a human.
//
// Fail direction: the flag can only ever WITHHOLD authority. If it leaks into an
// interactive shell the human's approvals get refused until it is unset —
// annoying, and safe. The inverse mistake (a runner minting presence) is the one
// that cannot be undone, because the ledger is append-only.
//
// The MARKER is deliberately still written. It is not an authority signal, and
// suppressing it would change the Stop hook's conversational carve-out, which is
// a separate behaviour with its own tests. Reviewers who want the marker
// suppressed too should say so — it is a one-line follow-on, not a silent choice.
import { existsSync } from "node:fs";
import {
  humanTurnMintAllowed,
  markHumanTurn,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import { recordPlanApprovalHumanResponse } from "../tools/aidlc-testing-posture.ts";

function extractResponseText(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return extractResponseText(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = extractResponseText(entry);
      if (text) return text;
    }
    return "";
  }
  if (value === null || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of [
    "answer",
    "answers",
    "selected",
    "selection",
    "value",
    "label",
    "text",
  ]) {
    if (!(key in record)) continue;
    const text = extractResponseText(record[key]);
    if (text) return text;
  }
  for (const entry of Object.values(record)) {
    const text = extractResponseText(entry);
    if (text) return text;
  }
  return "";
}

export async function run(input: string): Promise<number> {
try {
  const projectDir = resolveProjectDirFromHook(import.meta.url);
  if (existsSync(stateFilePath(projectDir))) {
    if (humanTurnMintAllowed()) {
      let sessionId = "";
      let humanResponseText = "";
      try {
        const parsed = JSON.parse(input) as {
          session_id?: unknown;
          prompt?: unknown;
          user_prompt?: unknown;
          message?: unknown;
          tool_response?: unknown;
          toolResponse?: unknown;
        };
        if (typeof parsed.session_id === "string") sessionId = parsed.session_id.trim();
        for (const candidate of [
          parsed.prompt,
          parsed.user_prompt,
          parsed.message,
          parsed.tool_response,
          parsed.toolResponse,
        ]) {
          const extracted = extractResponseText(candidate);
          if (extracted) {
            humanResponseText = extracted;
            break;
          }
        }
      } catch { /* presence still records without identity on legacy payloads */ }
      appendAuditEntry("HUMAN_TURN", sessionId ? { Session: sessionId } : {}, projectDir);
      if (sessionId && humanResponseText) {
        recordPlanApprovalHumanResponse(
          projectDir,
          sessionId,
          humanResponseText,
        );
      }
    }
    markHumanTurn(projectDir);
  }
} catch {
  // Non-fatal — a mint failure must never block the human's turn.
}

return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
