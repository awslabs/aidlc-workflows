// UserPromptSubmit hook: record a HUMAN_TURN event (human-presence gate).
//
// On every real human prompt, append a HUMAN_TURN event to the active intent's
// audit shard (the state machine's own append-only ledger). The approval /
// interview gate (handleApprove / handleAnswer) refuses unless a HUMAN_TURN was
// recorded since the last gate resolution. The hook records presence and order;
// it does not authenticate who launched the dispatcher.
//
// Presence remains the gate signal; the prompt payload also answers the single
// active protected challenge (plan, verification command, policy, or checkpoint).
// As the host's channel for the prompt, the hook applies a typed fence switch
// to this session's selected piece of work at prompt time. There is no request
// file for a later setter to consume.
// appendAuditEntryUnlocked resolves the active intent from the on-disk cursor. No workflow state means nothing
// to gate, so the hook skips ledger writes (same self-gate as
// aidlc-session-start.ts) - otherwise every prompt in a project that carries the
// harness shell but never ran the framework would scaffold and grow audit
// shards. The gate fails open on an empty ledger, so skipping the mint there is
// safe. The mint is fail-open (try/catch, exit 0): a mint failure must never
// block the human's turn.
//
// The same seam also touches the .aidlc-engine/human-turn marker (markHumanTurn). The
// ledger event serves the human-presence GATE; the marker serves the Stop hook's
// conversational carve-out, which needs a cheap "when was the last human prompt,
// relative to the last engine advance?" comparison that works on harnesses
// delivering no transcript. Both ride this seam, but AIDLC_UNATTENDED=1
// deliberately withholds only the authority-bearing ledger event while retaining
// the conversational marker. See the marker family in aidlc-lib.ts.
//
// UNATTENDED DRIVING (AIDLC_UNATTENDED=1). The mint is a presence ASSERTION, and
// this hook has no evidence for it: UserPromptSubmit carries no signal about who
// submitted, and its payload has no uncopyable caller identity. That is sound while every prompt comes
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
import { join } from "node:path";
import {
  clearPlanApprovalChallenge,
  planApprovalChallengeRelativePath,
  protectedQuestionRelativePath,
  withdrawProtectedQuestions,
  consumeSharedDirectiveAsk,
  humanTurnMintAllowed,
  markHumanTurn,
  resolveProjectDirFromHook,
  stateFilePath,
  validSessionId,
  withAuditLock,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import { applyTypedGuardSwitchPrompt, isTypedGuardSwitchPrompt, normalizeRetiredGuardPolicyField } from "../tools/aidlc-guard-switch.ts";
import {
  recordPlanApprovalHumanResponse,
  recordPlanApprovalOverrideRequest,
  recordProtectedHumanResponse,
} from "../tools/aidlc-testing-posture.ts";

function extractResponseText(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    // The parse is here to unwrap an ENVELOPE - a picker that delivers its
    // selection as JSON - so it hands over only for the shapes an envelope can
    // take: an object, an array, or a quoted string. A reply that is itself a
    // JSON scalar is not an envelope, and treating it as one reported no text at
    // all: "1" parses to a number, falls out of every branch below, and the
    // reply a numbered gate prompt invites was discarded. "true" and "null" went
    // the same way. Those keep the text the human actually typed.
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string" || (parsed !== null && typeof parsed === "object")) {
        return extractResponseText(parsed);
      }
    } catch {
      // Not JSON at all: the trimmed reply is the text.
    }
    return trimmed;
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

function extractQuestionText(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (Array.isArray(input.questions)) {
    // A protected question is asked alone. Never pair an arbitrary first answer
    // with a matching question elsewhere in a multi-question payload.
    if (input.questions.length !== 1) return "";
    return extractQuestionText(input.questions[0]);
  }
  return typeof input.question === "string" ? input.question : null;
}

// Deliberately not exported. This hook mints human authority, so importing the
// module from project code must not expose a callable function that accepts a
// fabricated UserPromptSubmit payload. Harnesses and the dispatcher execute it
// as a separate process through the host hook registration.
async function run(input: string): Promise<number> {
try {
  const projectDir = resolveProjectDirFromHook(import.meta.url);
  let sessionId = "";
  let promptSubmitted = false;
  let humanResponseText = "";
  let questionText: string | null = null;
  // The break-glass phrase counts only when the human TYPED it: the prompt
  // text of a UserPromptSubmit payload that names no tool. A picked option
  // (AskUserQuestion PostToolUse, Codex request_user_input, any adapter's
  // picker payload) arrives under tool_response and never opens it.
  let typedPrompt = "";
  try {
    const parsed = JSON.parse(input) as {
      hook_event_name?: unknown;
      tool_name?: unknown;
      session_id?: unknown;
      prompt?: unknown;
      user_prompt?: unknown;
      message?: unknown;
      tool_response?: unknown;
      toolResponse?: unknown;
      tool_input?: unknown;
      toolInput?: unknown;
    };
    if (typeof parsed.session_id === "string") sessionId = validSessionId(parsed.session_id.trim()) ?? "";
    questionText = extractQuestionText(parsed.tool_input ?? parsed.toolInput);
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
    if (
      parsed.hook_event_name === "UserPromptSubmit" &&
      typeof parsed.tool_name !== "string"
    ) {
      promptSubmitted = true;
      typedPrompt =
        [parsed.prompt, parsed.user_prompt, parsed.message].find(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        ) ?? "";
    }
  } catch { /* presence still records without identity on legacy payloads */ }
  // A field-only rename preserves the stored and effective value, so it carries
  // no switch authority. Kiro IDE's prompt-empty adapter performs the same
  // operation before forwarding because some builds discard core hook output.
  if (promptSubmitted && sessionId) {
    try {
      const migration = normalizeRetiredGuardPolicyField(projectDir, sessionId);
      if (migration.normalized) {
        process.stdout.write(`${JSON.stringify({
          additionalContext:
            `AIDLC Guard Policy migration: kept ${migration.value} and renamed ` +
            "the active intent's retired Change Control field to Guard Policy.",
        })}\n`);
      }
    } catch {
      // An unchanged retired field retains the normal migration notice.
    }
  }
  const mintAllowed = humanTurnMintAllowed();
  if (!mintAllowed && typedPrompt && isTypedGuardSwitchPrompt(typedPrompt)) {
    process.stdout.write(`${JSON.stringify({
      additionalContext: "AIDLC Guard Policy: the typed switch was not applied because AIDLC_UNATTENDED=1 withholds human authority on this driver; run it from an attended session.",
    })}\n`);
  }
  // Apply before the state-file gate so a first-use switch reports that the
  // person must create the piece of work, then type the switch again.
  if (mintAllowed && sessionId && typedPrompt) {
    try {
      const outcome = applyTypedGuardSwitchPrompt(projectDir, sessionId, typedPrompt);
      if (outcome !== null) {
        process.stdout.write(`${JSON.stringify({ additionalContext: `AIDLC Guard Policy: ${outcome.lines.join(" ")}` })}\n`);
      }
    } catch {
      // A switch failure must never block the human's turn.
    }
  }
  if (existsSync(stateFilePath(projectDir))) {
    if (mintAllowed) {
      try {
        withAuditLock(projectDir, () => {
          appendAuditEntryUnlocked("HUMAN_TURN", sessionId ? { Session: sessionId } : {}, projectDir);
          if (sessionId && humanResponseText) {
            const plan = existsSync(join(projectDir, planApprovalChallengeRelativePath(projectDir, sessionId)));
            const protectedQuestion = existsSync(join(projectDir, protectedQuestionRelativePath(projectDir, sessionId)));
            if (plan && protectedQuestion) {
              clearPlanApprovalChallenge(projectDir, sessionId);
              withdrawProtectedQuestions(projectDir, sessionId);
            } else if (protectedQuestion) {
              recordProtectedHumanResponse(projectDir, sessionId, humanResponseText, questionText);
            } else {
              // With no active challenge, retain the legacy recovery phrase.
              recordPlanApprovalHumanResponse(projectDir, sessionId, humanResponseText);
            }
          }
          if (sessionId && typedPrompt) {
            recordPlanApprovalOverrideRequest(projectDir, sessionId, typedPrompt);
          }
        });
      } catch {
        // Authority bookkeeping remains fail-open for the human's turn.
      }
      try {
        consumeSharedDirectiveAsk(projectDir, humanResponseText);
      } catch {
        // Non-authority marker consumption is independently best-effort.
      }
    }
    markHumanTurn(projectDir);
  }
} catch {
  // Non-fatal — a mint failure must never block the human's turn.
}

return 0;
}

// There is intentionally no import.meta.main fallback. The dispatcher is the
// only process allowed to activate this authority-bearing hook; executing the
// script path directly consumes no payload and mints nothing.
if (
  process.argv.includes("--internal-aidlc-record-human-turn") &&
  (process.env.AIDLC_INTERNAL_HUMAN_TURN_TOKEN ?? "") !== ""
) {
  process.exit(await run(await Bun.stdin.text()));
}
