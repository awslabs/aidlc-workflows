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
// The same locked section keeps the words the person typed in this chat (the
// gate-words family in aidlc-lib.ts), so a Request Changes at a stage gate
// records what they said as the feedback instead of the conductor's rewording.
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
  forgetGateWords,
  humanTurnMintAllowed,
  markHumanTurn,
  recordGateWords,
  resolveProjectDirFromHook,
  stateFilePath,
  stripRecommendedDecorator,
  validSessionId,
  withAuditLock,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import { applyTypedGuardSwitchPrompt, isTypedGuardSwitchPrompt, normalizeRetiredGuardPolicyField } from "../tools/aidlc-guard-switch.ts";
import {
  PLAN_APPROVAL_OVERRIDE_PHRASE_RE,
  type PlanApprovalPickerQuestion,
  planApprovalReplyNotice,
  recordPlanApprovalHumanResponse,
  recordPlanApprovalOverrideRequest,
  recordProtectedHumanResponse,
} from "../tools/aidlc-testing-posture.ts";
import {
  recordPlanApprovalAskReply,
  recordPlanApprovalReviewRequest,
} from "../tools/aidlc-plan-approval-ask.ts";

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

function singlePickerQuestion(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const question = Array.isArray(input.questions)
    ? (input.questions.length === 1 ? input.questions[0] : null)
    : input;
  return question !== null && typeof question === "object" ? question as Record<string, unknown> : null;
}

// The option labels of a single-question picker, as strings or `{label}`.
function extractOptionLabels(value: unknown): string[] | null {
  const question = singlePickerQuestion(value);
  if (question === null) return null;
  const options = question.options;
  if (!Array.isArray(options)) return null;
  const labels = options.map((option) => {
    if (typeof option === "string") return option;
    const label = option !== null && typeof option === "object"
      ? (option as Record<string, unknown>).label
      : undefined;
    return typeof label === "string" ? label : null;
  });
  return labels.every((label): label is string => label !== null) ? labels : null;
}

// A multi-select picker, or a reply carrying more than one pick, is not a
// single choice, whichever pick happens to come first.
function carriesSeveralPicks(toolInput: unknown, toolResponse: unknown): boolean {
  if (singlePickerQuestion(toolInput)?.multiSelect === true) return true;
  let response = toolResponse;
  if (typeof response === "string") {
    try { response = JSON.parse(response); } catch { return false; }
  }
  if (response === null || typeof response !== "object") return false;
  const answers = (response as Record<string, unknown>).answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return false;
  return Object.values(answers).some((answer) => {
    const picks = answer !== null && typeof answer === "object" && !Array.isArray(answer)
      ? (answer as Record<string, unknown>).answers
      : answer;
    return Array.isArray(picks) && picks.length > 1;
  });
}

// The words a person typed into a single-choice picker's free-text field. A
// pick of one of the offered labels is the conductor's wording, not theirs.
function pickerFreeText(text: string, picker: PlanApprovalPickerQuestion | undefined): string {
  if (!picker || !text || picker.severalPicks || picker.options === null) return "";
  const typed = stripRecommendedDecorator(text).toLowerCase();
  return picker.options.some((label) => stripRecommendedDecorator(label).toLowerCase() === typed) ? "" : text;
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
  // Set when the reply is a picker selection: the question and labels the
  // harness reports it under, so it pairs only with the recorded question.
  let pickerQuestion: PlanApprovalPickerQuestion | undefined;
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
    } else if (parsed.tool_response !== undefined || parsed.toolResponse !== undefined) {
      pickerQuestion = {
        question: questionText,
        options: extractOptionLabels(parsed.tool_input ?? parsed.toolInput),
        severalPicks: carriesSeveralPicks(
          parsed.tool_input ?? parsed.toolInput,
          parsed.tool_response ?? parsed.toolResponse,
        ),
      };
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
      // A typed guard switch or break-glass request is an instruction to the
      // framework, not an answer to the pending Plan Approval question.
      const notAReply = typedPrompt.length > 0 && (
        typedPrompt.trim().startsWith("/") ||
        isTypedGuardSwitchPrompt(typedPrompt) ||
        PLAN_APPROVAL_OVERRIDE_PHRASE_RE.test(typedPrompt.trim())
      );
      let replyNotice: string | null = null;
      let keptWordsOffset: number | null = null;
      try {
        withAuditLock(projectDir, () => {
          appendAuditEntryUnlocked("HUMAN_TURN", sessionId ? { Session: sessionId } : {}, projectDir);
          // Keep what the person typed in this chat, so a Request Changes at a
          // stage gate records their own words rather than the conductor's
          // rewording (recordGateWords in aidlc-lib.ts). A slash command, typed
          // guard switch, or break-glass phrase instructs the framework; a
          // picked option is the conductor's label, so of a picker reply only
          // free text typed into it counts. Never blocks the turn.
          const typedWords = typedPrompt
            ? (notAReply ? "" : typedPrompt)
            : pickerFreeText(humanResponseText, pickerQuestion);
          if (sessionId && typedWords) {
            try {
              keptWordsOffset = recordGateWords(projectDir, sessionId, typedWords);
            } catch {
              // The words are a convenience; the turn and its HUMAN_TURN stand.
            }
          }
          // The engine's own Plan Approval question, when one is open, owns the
          // reply: it is read in the person's own words from whichever chat it
          // arrives in, and the hook records the answer itself.
          let engineQuestionAnswered = false;
          if (humanResponseText && !notAReply) {
            const reply = recordPlanApprovalAskReply(projectDir, sessionId, humanResponseText, pickerQuestion);
            if (reply) {
              replyNotice = reply.notice;
              engineQuestionAnswered = true;
            } else if (typedPrompt) {
              replyNotice = recordPlanApprovalReviewRequest(projectDir, typedPrompt);
            }
          }
          if (!engineQuestionAnswered && sessionId && humanResponseText) {
            const plan = existsSync(join(projectDir, planApprovalChallengeRelativePath(projectDir, sessionId)));
            const protectedQuestion = existsSync(join(projectDir, protectedQuestionRelativePath(projectDir, sessionId)));
            if (plan && protectedQuestion) {
              clearPlanApprovalChallenge(projectDir, sessionId);
              withdrawProtectedQuestions(projectDir, sessionId);
            } else if (protectedQuestion) {
              if (!notAReply) {
                const read = recordProtectedHumanResponse(projectDir, sessionId, humanResponseText, questionText);
                if (read.notice) replyNotice = read.notice;
              }
            } else if (!notAReply) {
              // With no active challenge, retain the legacy recovery phrase.
              const read = recordPlanApprovalHumanResponse(projectDir, sessionId, humanResponseText, pickerQuestion);
              if (read.reading) replyNotice = planApprovalReplyNotice(read.reading);
            }
          }
          if (sessionId && typedPrompt) {
            recordPlanApprovalOverrideRequest(projectDir, sessionId, typedPrompt);
          }
        });
      } catch {
        // Authority bookkeeping remains fail-open for the human's turn.
      }
      if (replyNotice) {
        process.stdout.write(`${JSON.stringify(
          pickerQuestion
            ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: replyNotice } }
            : { additionalContext: replyNotice },
        )}\n`);
      }
      try {
        // A reply the engine's guard-recovery ask took as its answer is that
        // ask's, not revision feedback for a stage gate.
        const offset = keptWordsOffset;
        if (consumeSharedDirectiveAsk(projectDir, humanResponseText) && offset !== null) {
          try {
            withAuditLock(projectDir, () => forgetGateWords(projectDir, sessionId, offset));
          } catch {
            // The words are a convenience; the turn stands.
          }
        }
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
