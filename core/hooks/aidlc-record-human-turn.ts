// UserPromptSubmit and question-box PostToolUse hook: record a HUMAN_TURN event
// (human-presence gate).
//
// On every real human prompt, append a HUMAN_TURN event to the active intent's
// audit shard (the state machine's own append-only ledger). The approval /
// interview gate (handleApprove / handleAnswer) refuses unless a HUMAN_TURN was
// recorded since the last decision (and, at a stage gate, since the stage
// started). The hook records presence and order;
// it does not authenticate who launched the dispatcher.
//
// Presence remains the gate signal; the reply is also kept as the reply to the
// engine's open question (the code plan, a verification command, a policy, a
// checkpoint, guard recovery), with no choice read from its words: the agent
// reads it and records the choice through the question's own command. Only a
// pick in a question box, the host's own structure, is recorded as a choice
// here, and a legacy Kiro IDE window's nonce label, its one way to pick. The hook records the person's message whole, as typed, and applies
// nothing: a setting typed as a flag is the agent's to read and the setter's to
// apply, once the agent runs the command `next` names.
// appendAuditEntryUnlocked uses the workflow selection enterHookWorkflow pins
// for this chat. No workflow state means nothing to gate, so the hook skips
// ledger writes (same self-gate as aidlc-session-start.ts) - otherwise every
// prompt in a project that carries the harness shell but never ran the
// framework would scaffold and grow audit shards. The gate fails open on an
// empty ledger, so skipping the mint there is safe. The mint is fail-open
// (try/catch, exit 0): a mint failure must never block the human's turn.
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
// gate-words family in aidlc-lib.ts), for the steps that hand the agent replies
// a later chat or a Construction checkpoint still needs. A stage gate's record
// takes their words from the message record instead.
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
// park under it.
//
// Fail direction: the flag can only ever WITHHOLD authority. If it leaks into an
// interactive shell the human's approvals get refused until it is unset —
// annoying, and safe. The inverse mistake (a runner minting presence) is the one
// that cannot be undone, because the ledger is append-only.
//
// The MARKER is deliberately still written. It is not an authority signal, and
// suppressing it would change the Stop hook's conversational carve-out, which is
// a separate behaviour with its own tests.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_HOST_TEMPLATES,
  auditBlockField,
  carryPendingPersonLines,
  classifyTerminalCommand,
  claudeTranscriptOrigin,
  clearSessionIntentHandoff,
  emptyPickerResult,
  enterHookWorkflow,
  findStageBySlug,
  freshReviewReceipts,
  getField,
  hookStandsOutside,
  isolatedRunWithoutWork,
  hostEnvelopeTurnText,
  planApprovalChallengeRelativePath,
  COMMAND_TURN_REPLY,
  OPEN_QUESTION_FIELD,
  consumeSharedDirectiveAsk,
  hookContextLine,
  hooksHealthDir,
  hostTemplateOrigin,
  humanTurnMintAllowed,
  isoTimestamp,
  markHumanTurn,
  readAuditShardEvents,
  recordGateWords,
  recordPreWorkflowHeartbeat,
  resolveProjectDirFromHook,
  resolveReviewClass,
  sortAttemptEvents,
  splitKiroCommandArgs,
  stateFilePath,
  suppliedTurnOrigin,
  swarmWorkerWorktreeMeta,
  terminalCommandRelay,
  type TurnOrigin,
  validSessionId,
  withAuditLock,
  withTypedSpacing,
  writeProjectHookStatusFile,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntryUnlocked, maskSecretShapes, saySecretMaskedOnce } from "../tools/aidlc-audit.ts";
import { aidlcToolInvocation } from "../tools/aidlc-runtime-paths.ts";
import { normalizeRetiredGuardPolicyField } from "../tools/aidlc-guard-switch.ts";
import {
  type PlanApprovalPickerQuestion,
  recordPlanApprovalHumanResponse,
  recordProtectedHumanResponse,
} from "../tools/aidlc-testing-posture.ts";
import { notePlanApprovalAskReply, openEngineQuestion } from "../tools/aidlc-plan-approval-ask.ts";
import { openPlanQuestion } from "../tools/aidlc-question-store.ts";
import { boxQuestionId, QUESTION_ID_FIELD, turnQuestionFields } from "../tools/aidlc-questions.ts";
import { aidlcEntryWords, isAidlcCommandPrompt } from "../tools/aidlc-reply-reader.ts";
import { MESSAGE_PICKER_MAX_CHARS, MESSAGE_TEXT_MAX_CHARS, type NewMessage, saveMessage } from "../tools/aidlc-message-store.ts";

// The one parse of a typed line, for the message record (aidlc-message-store.ts)
// and for the turn's Reply mark: flags are syntax, read by the engine's own
// parser, and everything after them is the person's words. A prompt that does
// not start with the entry word is words only. A line the parser refuses keeps
// the words and no settings: the record proves what was said; the command
// itself is refused later. `command` is structure the parse holds: an
// `/aidlc` line with no words after its flags, with its words behind `--` (the
// person marked them as the work), or one the parser refused is a command to
// AIDLC and no reply to an open question; any line with words after the entry
// ("/aidlc approve the plan", "/aidlc --guard-policy off approve the plan") is a
// reply the agent may record. Nothing here reads what the words mean.
interface MessageParse extends Pick<NewMessage, "words" | "settings" | "route"> {
  command: boolean;
}

async function messageParse(typedPrompt: string): Promise<MessageParse> {
  const route = { scope: null, newIntent: false, skip: [] as string[], add: [] as string[], projectType: null };
  const entryWords = aidlcEntryWords(typedPrompt);
  // A `/aidlc-<runner>` entry starts a command too; its words are kept whole.
  if (entryWords === null) {
    return { words: typedPrompt.trim() || null, settings: [], route, command: isAidlcCommandPrompt(typedPrompt) };
  }
  const words = entryWords || null;
  try {
    const { parseNextFlags, typedSettingModifiers } = await import("../tools/aidlc-orchestrate.ts");
    const argv = splitKiroCommandArgs(entryWords);
    const flags = parseNextFlags(argv);
    if (flags.parseError) return { words, settings: [], route, command: true };
    // What they said, not what the engine acts on: a flag-shaped token `next`
    // does not take is still one of their words (personWords in the parse).
    // The parse joins the words with one space; the record keeps the spacing
    // they typed between them.
    const said = (flags.personWords ?? flags.intent)?.trim() || null;
    const modifiers = typedSettingModifiers(flags);
    const routed = {
      scope: flags.scope ?? flags.positionalScope ?? null,
      newIntent: flags.newIntent === true,
      skip: flags.planChanges?.skip ?? [],
      add: flags.planChanges?.add ?? [],
      projectType: flags.projectType ?? null,
    };
    // A line that routes work (a plan named, new work asked for, a project type,
    // a change to the plan's stages) is a command to AIDLC and no reply to an
    // open question, however many words of theirs ride with it: the words are
    // the work they are asking for. A line of words alone, or words after
    // settings, may be their reply, and the agent records it.
    const routes = routed.newIntent || routed.scope !== null || routed.projectType !== null ||
      routed.skip.length > 0 || routed.add.length > 0;
    return {
      words: said === null ? null : withTypedSpacing(said, entryWords),
      settings: modifiers.map((modifier) => {
        const space = modifier.indexOf(" ");
        return { key: modifier.slice(0, space), value: modifier.slice(space + 1) };
      }),
      route: routed,
      command: said === null || flags.markedWords === true || routes,
    };
  } catch {
    return { words, settings: [], route, command: true };
  }
}

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
  // A question box's result: the person's picks are under `answers`. The
  // questions Claude Code echoes beside them are the box's own words, so a box
  // submitted with nothing picked is no text, never its first question.
  if ("answers" in record) return "";
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

// What the agent does after an empty question box (emptyPickerResult) when the
// box carried no question or options the hook could read back (a payload shape
// it did not recognize): the generic instruction to re-ask as numbered prose.
// Codex's own instruction says to "continue with best judgment"; asking in
// the box again would only run out again.
const QUESTION_UNANSWERED_NOTICE =
  "The question box closed with no answer, so nothing was answered or recorded. " +
  "Ask the same question again in your reply as numbered options, not in the question box, " +
  "and end the turn; never pick an answer for the person.";

// The same question the empty box carried, rendered as numbered prose so the
// fallback is the engine's, not the conductor's to reconstruct (#2491): the
// recorded labels in their recorded order, each on its own line, an Other
// escape appended (the question file's permanent floor), then the reply line.
// Null when the box reported no question text or no option labels the hook
// could read, so the caller falls back to QUESTION_UNANSWERED_NOTICE. The
// labels are rendered verbatim; nothing is summarized or reordered.
function unansweredPickerProse(picker: PlanApprovalPickerQuestion | undefined): string | null {
  const question = picker?.question?.trim();
  const options = picker?.options;
  if (!question || options === null || options === undefined || options.length === 0) return null;
  const lines = [
    "The question box closed with no answer, so nothing was answered or recorded. " +
      "Ask the same question again in your reply as numbered options, not in the question box, " +
      "then end the turn; never pick an answer for the person.",
    "",
    question,
    "",
    ...options.map((label, index) => `${index + 1}. ${label}`),
    `${options.length + 1}. Other (please specify)`,
    "",
    picker?.severalPicks
      ? "Reply with the numbers you want (or just tell me)."
      : "Reply with a number (or just tell me).",
  ];
  return lines.join("\n");
}

// Rows after a review request that say the work went past it: a question was
// put to the person or answered, a checkpoint verified, a gate opened or
// decided, the stage left or the workflow started again. A message then
// answers that, not the review.
const PAST_REVIEW_REQUEST = new Set([
  "DECISION_RECORDED", "QUESTION_ANSWERED", "CHECKPOINT_VERIFICATION_RECORDED", "STAGE_AWAITING_APPROVAL",
  "GATE_APPROVED", "GATE_REJECTED", "STAGE_COMPLETED", "STAGE_JUMPED", "WORKFLOW_STARTED",
]);

// The person wrote while a review the agent asked for in this workflow has no
// verdict (they may have stopped it): the agent hears to run `next` first,
// which names the step that finishes the review or the person's way on, so it
// never retries the review or records a result for it on its own. The trail
// names the open request; `next`'s own review receipts confirm it still waits
// for its verdict. Null when nothing waits, and on any read error.
function stoppedReviewNote(projectDir: string): string | null {
  try {
    const open = new Map<string, { stage: string; unit: string | undefined }>();
    for (const row of sortAttemptEvents(readAuditShardEvents(projectDir))) {
      if (PAST_REVIEW_REQUEST.has(row.event)) {
        open.clear();
        continue;
      }
      if (row.event !== "REVIEW_REQUESTED" && row.event !== "REVIEW_COMPLETED") continue;
      if (auditBlockField(row.block, "Workflow")?.startsWith("single-stage:")) continue;
      const stage = auditBlockField(row.block, "Stage");
      if (stage === null) continue;
      const unit = auditBlockField(row.block, "Unit") ?? undefined;
      const key = `${stage}\u0000${unit ?? ""}\u0000${auditBlockField(row.block, "Iteration") ?? ""}`;
      if (row.event === "REVIEW_REQUESTED") open.set(key, { stage, unit });
      else open.delete(key);
    }
    if (open.size === 0) return null;
    const state = readFileSync(stateFilePath(projectDir), "utf-8");
    for (const request of open.values()) {
      const stage = findStageBySlug(request.stage);
      if (!stage?.reviewer) continue;
      const reviewClass = resolveReviewClass(stage.review_class ?? "adversarial", getField(state, "Scope") ?? "", state);
      if (reviewClass === "none") continue;
      if (freshReviewReceipts(projectDir, state, stage, { reviewClass }).awaitingVerdict?.has(request.unit ?? "")) {
        return "A review was asked for and has no verdict yet (it may have been stopped). " +
          `Run \`${aidlcToolInvocation("orchestrate")} next\` before retrying it or recording anything, ` +
          "and follow the step it prints.";
      }
    }
  } catch {
    // A note, never a block: a read that fails says nothing.
  }
  return null;
}

// What a question box carried back, one entry per question it asked: the
// question as shown and the reply as given, verbatim. Claude Code keys each
// reply by its question; Codex keys it by the question's id, with a list of
// picks (its adapter passes the box's reply as picker_reply). Nothing here
// reads meaning into the reply.
// What the box carried back: one entry per question it asked, in the order
// shown, `reply` null where the person left a question blank (#2107: an entry
// only for answered questions read "asked and left blank" as "never asked"). A
// pick for a question the box did not list follows them. Strings are cut to the
// store's limit.
function pickerReplies(
  input: string,
  limit = Number.POSITIVE_INFINITY,
): { entries: Array<{ question: string; reply: string | null }>; cut: boolean } {
  let cut = false;
  const kept = (value: string): string => {
    if (value.length <= limit) return value;
    cut = true;
    return value.slice(0, limit);
  };
  try {
    const payload = JSON.parse(input) as {
      tool_input?: unknown; toolInput?: unknown; tool_response?: unknown; toolResponse?: unknown; picker_reply?: unknown;
    };
    let response = payload.picker_reply ?? payload.tool_response ?? payload.toolResponse;
    if (typeof response === "string") response = JSON.parse(response);
    const answers = response !== null && typeof response === "object" ? (response as Record<string, unknown>).answers : null;
    if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return { entries: [], cut };
    const picks = answers as Record<string, unknown>;
    const replyOf = (value: unknown): string | null => {
      const chosen = value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).answers
        : value;
      const reply = (Array.isArray(chosen) ? chosen : [chosen])
        .filter((pick): pick is string => typeof pick === "string" && pick.trim() !== "")
        .join(", ");
      return reply === "" ? null : kept(reply);
    };
    const toolInput = payload.tool_input ?? payload.toolInput;
    const asked = toolInput !== null && typeof toolInput === "object" &&
        Array.isArray((toolInput as Record<string, unknown>).questions)
      ? (toolInput as { questions: unknown[] }).questions
      : [];
    const entries: Array<{ question: string; reply: string | null }> = [];
    const used = new Set<string>();
    for (const entry of asked) {
      const question = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
      if (typeof question.question !== "string") continue;
      // Claude Code keys answers by the question text, Codex by the question id.
      const key = typeof question.id === "string" && question.id in picks
        ? question.id
        : question.question in picks ? question.question : null;
      if (key !== null) used.add(key);
      entries.push({ question: kept(question.question), reply: key === null ? null : replyOf(picks[key]) });
    }
    for (const [key, value] of Object.entries(picks)) {
      if (used.has(key)) continue;
      const reply = replyOf(value);
      if (reply !== null) entries.push({ question: kept(key), reply });
    }
    return { entries, cut };
  } catch {
    return { entries: [], cut };
  }
}

// The choices each question of a question box offered, keyed by the question
// as shown, for the record. A question whose choices the hook cannot read is
// left out.
function pickerOptions(input: string): Map<string, string[]> {
  const options = new Map<string, string[]>();
  try {
    const payload = JSON.parse(input) as { tool_input?: unknown; toolInput?: unknown };
    const toolInput = payload.tool_input ?? payload.toolInput;
    const asked = toolInput !== null && typeof toolInput === "object" &&
        Array.isArray((toolInput as Record<string, unknown>).questions)
      ? (toolInput as { questions: unknown[] }).questions
      : [];
    for (const entry of asked) {
      const question = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>).question : null;
      const labels = extractOptionLabels(entry);
      if (typeof question === "string" && labels !== null) options.set(question, labels);
    }
  } catch {
    // A payload that does not parse offers nothing to record.
  }
  return options;
}

// Every pick a picker reply reports, in its order: one label per question, or
// several for a multi-select. AskUserQuestion keys answers by question; Codex's
// request_user_input nests them under each question's own `answers`.
function pickedLabels(toolResponse: unknown): string[] {
  let response = toolResponse;
  if (typeof response === "string") {
    try { response = JSON.parse(response); } catch { return []; }
  }
  if (response === null || typeof response !== "object") return [];
  const answers = (response as Record<string, unknown>).answers;
  if (answers === null || typeof answers !== "object") return [];
  const labels: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim()) labels.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const entry of value) add(entry);
    } else if (value !== null && typeof value === "object") {
      add((value as Record<string, unknown>).answers);
    }
  };
  for (const answer of Array.isArray(answers) ? answers : Object.values(answers)) add(answer);
  return labels;
}

// Deliberately not exported. This hook mints human authority, so importing the
// module from project code must not expose a callable function that accepts a
// fabricated UserPromptSubmit payload. Harnesses and the dispatcher execute it
// as a separate process through the host hook registration.
//
// What the agent should hear from this turn is printed once, as one context
// line: Claude Code reads a single hook response, and two lines make it drop both.
// The help a typed help request gets rides last, and only while the whole line
// fits what a host takes from a hook (Claude Code keeps 10,000 characters of a
// field); past that the agent runs the help itself, as with no hook.
const PROMPT_CONTEXT_MAX_CHARS = 9_500;

// The help, handed to the agent with the person's own line when that line asks
// for it and nothing else (the engine's own reading of a typed command), so the
// agent shows it with no command to run. Only AI-DLC's own help: a help typed
// after a command family (`knowledge help`) is that family's, and its command
// runs as before.
async function helpRelay(typedPrompt: string, projectDir: string, sessionId: string): Promise<string | null> {
  const entryWords = aidlcEntryWords(typedPrompt);
  if (entryWords === null) return null;
  const command = classifyTerminalCommand(splitKiroCommandArgs(entryWords), projectDir, sessionId || undefined);
  if (command?.subcommand !== "help" || command.source !== "read-only-flag") return null;
  const { renderHelpText } = await import("../tools/aidlc-utility.ts");
  return terminalCommandRelay(typedPrompt.trim(), renderHelpText());
}
//
// What the PERSON hears does not travel that way. A host may fold hook output
// away, an adapter may drop it, and an agent may not pass it on, which is how a
// check the person typed off went unsaid on every tool. So a line for them is
// queued for the engine's next step instead (addPendingPersonLines). It is
// queued once this turn is recorded, because a line belongs to the turn that is
// marked when it is written.
async function run(input: string): Promise<number> {
  const notes: string[] = [];
  const forThePerson: Array<() => void> = [];
  // Besides the notes, respond hands back the help line and the event the host
  // fired: a host takes a hook's context only under its own event (a box
  // answer's line named UserPromptSubmit is dropped on Claude Code).
  const handover: { help: string | null; event: "UserPromptSubmit" | "PostToolUse" } = {
    help: null, event: "UserPromptSubmit",
  };
  try {
    return await respond(input, notes, forThePerson, handover);
  } finally {
    for (const queue of forThePerson) {
      try {
        queue();
      } catch {
        // A line the person may miss never blocks their turn.
      }
    }
    if (handover.help !== null && [...notes, handover.help].join("\n").length <= PROMPT_CONTEXT_MAX_CHARS) {
      notes.push(handover.help);
    }
    if (notes.length > 0) process.stdout.write(hookContextLine(handover.event, notes.join("\n")));
  }
}

async function respond(
  input: string,
  notes: string[],
  forThePerson: Array<() => void>,
  handover: { help: string | null; event: "UserPromptSubmit" | "PostToolUse" },
): Promise<number> {
try {
  const projectDir = resolveProjectDirFromHook(import.meta.url);
  let sessionId = "";
  let promptSubmitted = false;
  let humanResponseText = "";
  let questionText: string | null = null;
  // What the person typed: the prompt text of a UserPromptSubmit payload that
  // names no tool. A picked option (AskUserQuestion PostToolUse, Codex
  // request_user_input, any adapter's picker payload) arrives under
  // tool_response instead.
  let typedPrompt = "";
  // Set when the reply is a picker selection: the question and labels the
  // harness reports it under, so it pairs only with the recorded question.
  let pickerQuestion: PlanApprovalPickerQuestion | undefined;
  let pickerUnanswered = false;
  // Every pick a picker reply carried, for the record.
  let picked: string[] = [];
  // Who sent this turn. An adapter that read its host's own signals says so in
  // `origin`; Claude Code's transcript is read here; anything unknown is a
  // person (kiroTurnOrigin, claudeTranscriptOrigin in aidlc-lib.ts).
  let turnOrigin: TurnOrigin = { kind: "person" };
  // An adapter whose own prompt hook runs a command the person typed and hands
  // the agent its output (Kiro's) says so; the help is then left to it.
  let relaysTerminalOutput = false;
  // An adapter whose host may show the person this hook's context line says
  // so; the message-id line is then left to the steps of `next`.
  let contextMayReachPerson = false;
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
      // The raw picker payload an adapter keeps aside when it normalizes
      // tool_response to the selected label (the Codex adapter does this): the
      // emptiness test and QUESTION_REPLIED rows read it first.
      picker_reply?: unknown;
      tool_input?: unknown;
      toolInput?: unknown;
      origin?: unknown;
      prompt_id?: unknown;
      transcript_path?: unknown;
      relays_terminal_output?: unknown;
      context_may_reach_person?: unknown;
    };
    relaysTerminalOutput = parsed.relays_terminal_output === true;
    contextMayReachPerson = parsed.context_may_reach_person === true;
    if (typeof parsed.session_id === "string") sessionId = validSessionId(parsed.session_id.trim()) ?? "";
    questionText = extractQuestionText(parsed.tool_input ?? parsed.toolInput);
    // A host that wraps the person's turn in its own context (Kiro Crew) hands
    // over the whole envelope as the prompt; only the person's turn is read.
    // tool_response is a picker payload, never an envelope, and stays as is.
    const ownTurn = (value: unknown): unknown =>
      typeof value === "string" ? hostEnvelopeTurnText(value) : value;
    const prompt = ownTurn(parsed.prompt);
    const userPrompt = ownTurn(parsed.user_prompt);
    const message = ownTurn(parsed.message);
    // What the person typed is kept as they typed it, whatever it looks like;
    // only a question box's payload (the host's own structure) is unwrapped.
    for (const typed of [prompt, userPrompt, message]) {
      const text = typeof typed === "string" ? typed.trim() : extractResponseText(typed);
      if (text) {
        humanResponseText = text;
        break;
      }
    }
    for (const payload of humanResponseText ? [] : [parsed.tool_response, parsed.toolResponse]) {
      const text = extractResponseText(payload);
      if (text) {
        humanResponseText = text;
        break;
      }
    }
    if (
      parsed.hook_event_name === "UserPromptSubmit" &&
      typeof parsed.tool_name !== "string"
    ) {
      promptSubmitted = true;
      typedPrompt =
        [prompt, userPrompt, message].find(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        ) ?? "";
    } else if (
      parsed.tool_response !== undefined || parsed.toolResponse !== undefined || parsed.picker_reply !== undefined
    ) {
      // The box's own result. The Codex adapter keeps the raw picker payload in
      // `picker_reply` and sets `tool_response` to the selected label (empty on
      // a dismissed box), so the emptiness test reads `picker_reply` first, the
      // same order `pickerReplies` uses; a host that puts the whole picker
      // result in `tool_response` is still read from there. `picked` and
      // `severalPicks` keep reading `tool_response`/`toolResponse`: in the raw
      // Codex box a note the person added is a second answer beside their
      // pick, which is still one pick.
      handover.event = "PostToolUse";
      const pickerResult = parsed.picker_reply ?? parsed.tool_response ?? parsed.toolResponse;
      pickerUnanswered = emptyPickerResult(pickerResult);
      picked = pickerUnanswered ? [] : pickedLabels(parsed.tool_response ?? parsed.toolResponse);
      pickerQuestion = {
        question: questionText,
        options: extractOptionLabels(parsed.tool_input ?? parsed.toolInput),
        severalPicks: carriesSeveralPicks(
          parsed.tool_input ?? parsed.toolInput,
          parsed.tool_response ?? parsed.toolResponse,
        ),
      };
    }
    const supplied = suppliedTurnOrigin(parsed.origin);
    if (supplied !== null) {
      turnOrigin = supplied;
    } else if (promptSubmitted && typedPrompt && typeof parsed.transcript_path === "string") {
      // Claude Code hands its transcript to the hook: its row for this prompt
      // names who started the turn. With no row (2.1.310 writes it only after
      // this hook returns), only the host's whole notice or message block
      // counts as the host's.
      turnOrigin = claudeTranscriptOrigin(parsed.transcript_path, parsed.prompt_id, typedPrompt) ??
        hostTemplateOrigin(typedPrompt, CLAUDE_HOST_TEMPLATES) ??
        { kind: "person" };
    }
  } catch { /* presence still records without identity on legacy payloads */ }
  // A new prompt starts a new turn: a one-shot stop left from an earlier turn
  // (a switch's, or a creation's whose Stop never ran) is spent here, before
  // any early return, so nothing chains onto it or ends this turn on it (#1263).
  if (promptSubmitted && sessionId) {
    try { clearSessionIntentHandoff(projectDir, sessionId); } catch { /* per-user runtime state */ }
  }
  // A conversation that has not joined the selected workflow is not a human at
  // its gates: it mints nothing there.
  // What the person said in it is still theirs: its message record (the chat's
  // own proof, kept beside the question store and outside every record) is.
  const workflow = enterHookWorkflow(projectDir, sessionId);
  const outside = hookStandsOutside(workflow);
  const mintAllowed = humanTurnMintAllowed();
  // A swarm worker's worktree is the copy the engine made for a worker, and a
  // prompt that arrives there (the brief of a session started there, such as a
  // headless `codex exec`) is the conductor's, never a person's turn. No authority row lands
  // in that record (finalize merges it back, and the merge refuses every
  // authority row), no words are kept, no switch is applied, and nothing is
  // said about it: there is no person there to read a line. The heartbeat and
  // the conversational marker still land, as under AIDLC_UNATTENDED=1.
  const workerWorktree = swarmWorkerWorktreeMeta(projectDir) !== null;
  const personHere = mintAllowed && !workerWorktree;
  // Their message held what looks like a key: the committed record never
  // keeps it whole, and they hear that once, with the engine's next step. A
  // shape check only (SECRET_SHAPES), never a reading of the words.
  const sayIfKeyShaped = (): void => {
    const theirText = [humanResponseText, ...picked].join("\n");
    if (!sessionId || !personHere || turnOrigin.kind === "host" || maskSecretShapes(theirText) === theirText) return;
    const session = sessionId;
    forThePerson.push(() => saySecretMaskedOnce(projectDir, session));
  };
  // A help request the person typed is answered here, before any work exists
  // or this chat joins one, on every host that hands this hook's line to the
  // agent (Claude Code, Codex). A host's own turn never gets it.
  if (personHere && promptSubmitted && typedPrompt && turnOrigin.kind !== "host" && !relaysTerminalOutput) {
    try {
      handover.help = await helpRelay(typedPrompt, projectDir, sessionId);
    } catch {
      // The agent runs the help itself, as with no hook.
    }
  }
  // The message record: proof that a person said this in this chat, and
  // exactly what they said (aidlc-message-store.ts). Written before the
  // state-file gate so a message before any work exists is kept, and for a
  // chat that has not joined the work here, under no lock (one atomic file).
  // It names no question: which question a message answers is the conductor's
  // call when it records a decision. Keyed on the EVENT, never on the text: a
  // prompt-submit whose prompt the host left empty is a prompt whose words are
  // unknown, not a picker reply. Fail-open: a store failure never blocks the
  // turn, and the row below still records it.
  // The one parse of a typed line, shared by the record and the turn's Reply
  // mark below. Null for a picker reply and for a prompt the host left empty.
  const typedParse = personHere && promptSubmitted && typedPrompt ? await messageParse(typedPrompt) : null;
  const keepMessage = (): string | null => {
    if (!personHere || pickerUnanswered || !(promptSubmitted || pickerQuestion !== undefined)) return null;
    try {
      const noWords: Pick<NewMessage, "words" | "settings" | "route"> = {
        words: null, settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
      };
      const parsed: Pick<NewMessage, "words" | "settings" | "route"> = typedParse !== null
        ? { words: typedParse.words, settings: typedParse.settings, route: typedParse.route }
        : promptSubmitted
        ? noWords
        : { ...noWords, words: humanResponseText.trim() || null };
      const full = promptSubmitted ? typedPrompt : humanResponseText;
      // Every stored string is cut (#2107: uncut words once put a record past the
      // reader's cap).
      const picker = promptSubmitted ? null : pickerReplies(input, MESSAGE_PICKER_MAX_CHARS);
      // A box's words are every reply it carried, one per question in the order
      // shown, each whole: several questions answered, or one answered with a
      // pick and the note Codex keeps beside it. Its first value alone was
      // kept as their reply to each question the box asked. Read at the words'
      // own cap, so a long answer keeps what a typed message would.
      const replies = promptSubmitted ? null : pickerReplies(input, MESSAGE_TEXT_MAX_CHARS);
      const picks = replies?.entries.flatMap(({ reply }) => (reply === null ? [] : [reply])) ?? [];
      const said = picks.length > 0 ? picks.join("\n") : parsed.words;
      const words = said !== null && said.length > MESSAGE_TEXT_MAX_CHARS
        ? said.slice(0, MESSAGE_TEXT_MAX_CHARS)
        : said;
      const cut = full.length > MESSAGE_TEXT_MAX_CHARS || words !== said || picker?.cut === true;
      return saveMessage(projectDir, {
        session: sessionId || null,
        at: isoTimestamp(),
        source: promptSubmitted ? "prompt" : "picker",
        text: full.slice(0, MESSAGE_TEXT_MAX_CHARS),
        ...(cut ? { cut: true as const } : {}),
        picker: picker === null ? null : picker.entries,
        ...parsed,
        words,
      }).id;
    } catch {
      // The record is a convenience here; the turn and its row stand without it.
      return null;
    }
  };
  // The agent learns the id of the message it can name with --message, never
  // its words: a reply typed or given in a question box, or a check the person
  // asks in chat to change with nothing waiting on them (without the id, every
  // such request met the setter's refusal first, and a setting asked in a box
  // answer was recorded on the message typed before it). On the work, every
  // such message gets it; outside the work or before any exists, only a reply
  // to this chat's plan question for new work, so a setting asked beside the
  // plan pick is recorded as theirs and no other prompt in a project with no
  // AI-DLC work open carries the line. Once a turn. The setter's proof of the
  // message still decides.
  let idSaid = false;
  const sayMessageId = (messageId: string | null, notAReply: boolean, onTheWork: boolean): void => {
    if (idSaid || !(promptSubmitted || pickerQuestion !== undefined) || !messageId || notAReply || contextMayReachPerson) {
      return;
    }
    try {
      if (!onTheWork && (!sessionId || openPlanQuestion(projectDir, sessionId) === null)) return;
    } catch {
      return;
    }
    idSaid = true;
    notes.push(`This message of the person's is on record as ${messageId}: a decision you record from it can ` +
      `name it with --message ${messageId}.`);
  };
  if (outside) {
    // A turn the host made (its notice or brief) is nobody's words here either:
    // kept, it would read as the person's prompt where their message is the
    // proof before any work exists (intent creation).
    if (turnOrigin.kind !== "host") sayMessageId(keepMessage(), typedParse?.command === true, false);
    sayIfKeyShaped();
    return 0;
  }
  // A field-only rename preserves the stored and effective value, so it carries
  // no switch authority. Kiro IDE's prompt-empty adapter performs the same
  // operation before forwarding because some builds discard core hook output.
  if (promptSubmitted && sessionId) {
    try {
      const migration = normalizeRetiredGuardPolicyField(projectDir, sessionId);
      if (migration.normalized) {
        notes.push(
          `AIDLC Guard Policy migration: kept ${migration.value} and renamed ` +
            "the active intent's retired Change Control field to Guard Policy.",
        );
      }
    } catch {
      // An unchanged retired field retains the normal migration notice.
    }
  }
  // The heartbeat says the host ran this hook. Before any workflow it lands
  // where doctor and `next` look then, so a tool that runs no hooks is known
  // from the person's first message, before any work.
  recordPreWorkflowHeartbeat(projectDir, "record-human-turn");
  // The rows below go in the work's record, or with no work in the space's own
  // while a stage run on its own is open there (its start is there).
  const inRecord = existsSync(stateFilePath(projectDir)) ||
    (workflow.selection !== null && isolatedRunWithoutWork(projectDir, workflow.selection));
  // A turn the host made (its notice or brief, not the person's words): none of
  // the person's authority rides on it. No turn, no kept words, no reply, no
  // switch, no conversational marker. The record keeps that it happened and why,
  // with no text, so a turn that stopped counting is visible there.
  if (turnOrigin.kind === "host") {
    const host = turnOrigin;
    if (inRecord) {
      try {
        writeProjectHookStatusFile(projectDir, hooksHealthDir(projectDir), "record-human-turn.last", isoTimestamp());
      } catch {
        // A heartbeat write failure is lost telemetry, never a blocked turn.
      }
      try {
        withAuditLock(projectDir, () => {
          appendAuditEntryUnlocked("HOST_TURN", {
            ...(sessionId ? { Session: sessionId } : {}),
            Origin: "host",
            Reason: host.reason,
            Source: host.source,
          }, projectDir);
        });
      } catch {
        // The row is the trace; its absence blocks nothing.
      }
    }
    return 0;
  }
  // The message record (keepMessage above). A setting typed on the line is in
  // it as the engine's own parser read it; nothing is applied here.
  const messageId = keepMessage();
  sayIfKeyShaped();
  if (inRecord) {
    // With a record it lands in the record, before the mint branch and
    // apart from it, so a hook that ran but withheld its mint (AIDLC_UNATTENDED=1,
    // or a turn with no pending question) is never mistaken for one that never
    // ran. Best-effort: a heartbeat failure never blocks the person's turn.
    try {
      writeProjectHookStatusFile(projectDir, hooksHealthDir(projectDir), "record-human-turn.last", isoTimestamp());
    } catch {
      // A heartbeat write failure is lost telemetry, never a blocked turn.
    }
    if (pickerUnanswered) {
      // No turn and no answer: the row spends any earlier turn, so a remark
      // typed before the box never carries an answer the person did not give.
      // (An authority row, so none in a swarm worker's worktree.)
      try {
        withAuditLock(projectDir, () => {
          if (workerWorktree) return;
          appendAuditEntryUnlocked("QUESTION_UNANSWERED", sessionId ? { Session: sessionId } : {}, projectDir);
        });
      } catch {
        // The question is asked again either way.
      }
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: unansweredPickerProse(pickerQuestion) ?? QUESTION_UNANSWERED_NOTICE,
        },
      })}\n`);
      return 0;
    }
    if (personHere) {
      // A command to AIDLC (an `/aidlc` line with no words after its flags, or
      // with its words behind `--`) is an instruction to the framework, not an
      // answer to the pending Plan Approval question.
      // A setting typed as a flag is in the message record; the agent reads the
      // line and runs the setter the engine names. The words after the entry
      // and its flags are the reply, so "/aidlc 1" picks the first choice as
      // "1" does, and "/aidlc --guard-policy off approve the plan" approves it.
      const commandLine = typedParse?.command === true;
      const notAReply = typedPrompt.length > 0 && commandLine;
      const entryReply = typedParse !== null && !commandLine && aidlcEntryWords(typedPrompt) !== null
        ? typedParse.words
        : null;
      const replyText = entryReply ?? humanResponseText;
      // Another engine question on top (where the work belongs, a new-work
      // offer, which record) was on screen when this came: the row names it,
      // and no question beneath keeps the message unless the agent names it
      // for one with --message. Structure only: which question it answers is
      // the agent's to read.
      const openQuestion = replyText !== "" && !notAReply ? openEngineQuestion(projectDir) : null;
      try {
        withAuditLock(projectDir, () => {
          // A turn that is only a command to AIDLC is no reply to an open
          // question: the row says so, and decisions on that question skip it.
          // Words typed after the entry and its flags ("/aidlc use postgres",
          // "/aidlc --guard-policy off approve the plan") are a reply.
          appendAuditEntryUnlocked("HUMAN_TURN", {
            ...(sessionId ? { Session: sessionId } : {}),
            Origin: "person",
            ...(promptSubmitted ? { Source: "typed" } : pickerQuestion !== undefined ? { Source: "picker" } : {}),
            ...(notAReply ? { Reply: COMMAND_TURN_REPLY } : {}),
            ...(openQuestion !== null ? { [OPEN_QUESTION_FIELD]: openQuestion } : {}),
            ...(picked.length > 0 ? { Picked: JSON.stringify(picked) } : {}),
            ...(messageId ? { "Message Id": messageId } : {}),
            // The questions open where they replied, and what the stage's
            // questions file said then (aidlc-questions.ts): facts of this
            // moment, read from one small file. Nothing decides on them here.
            ...turnQuestionFields(projectDir, sessionId),
          }, projectDir);
          // Keep what the person typed in this chat (recordGateWords in
          // aidlc-lib.ts). A command to AIDLC instructs the framework; the one
          // answer a single-choice box carried back counts, since the host
          // gives no mark between a pick and text typed into it (several picks
          // are the row's Picked). Never blocks the turn.
          const typedWords = openQuestion !== null ? "" : typedPrompt
            ? (notAReply ? "" : entryReply ?? typedPrompt)
            : pickerQuestion === undefined || pickerQuestion.severalPicks || pickerQuestion.options === null
            ? "" : humanResponseText;
          if (sessionId && typedWords) {
            try {
              recordGateWords(projectDir, sessionId, typedWords);
            } catch {
              // The words are a convenience; the turn and its HUMAN_TURN stand.
            }
          }
          // Each open question keeps that the person replied to it and their
          // exact words: the engine's own Plan Approval question (from whichever
          // chat the reply arrives in), this chat's question that needs their
          // own reply (a checkpoint, the verification command), or with none
          // here the one another chat asked, and the older plan question; a
          // message sent while another engine question was on screen only the
          // code plan's own record keeps. Nothing here pairs the reply with one
          // of them or reads meaning into it: the conductor reads it and records
          // the choice on the question it answers.
          if (replyText !== "" && !notAReply) {
            notePlanApprovalAskReply(projectDir, sessionId, replyText, pickerQuestion, messageId || undefined);
          }
          if (sessionId && replyText && !notAReply && openQuestion === null) {
            const plan = existsSync(join(projectDir, planApprovalChallengeRelativePath(projectDir, sessionId)));
            const kept = recordProtectedHumanResponse(projectDir, sessionId, replyText, questionText, pickerQuestion,
              messageId || undefined).recorded;
            if (plan || !kept) recordPlanApprovalHumanResponse(projectDir, sessionId, replyText, pickerQuestion);
          }
          // What the question box carried back goes on the record, question
          // by question, so the person's reply stands even when no answer is
          // logged for it. It decides nothing and spends no turn. Written
          // after the turn's words, which are kept at the shard's size just
          // after its row.
          if (pickerQuestion !== undefined && !notAReply) {
            const offered = pickerOptions(input);
            for (const { question, reply } of pickerReplies(input).entries) {
              if (reply === null) continue; // a question left blank carried no pick
              const options = offered.get(question);
              // The question it answered, by its id, when the box asked one
              // open here in the question's own words.
              const id = boxQuestionId(projectDir, sessionId, question);
              appendAuditEntryUnlocked("QUESTION_REPLIED", {
                ...(sessionId ? { Session: sessionId } : {}),
                Question: question,
                ...(id !== null ? { [QUESTION_ID_FIELD]: id } : {}),
                Reply: reply,
                ...(options !== undefined ? { Options: JSON.stringify(options) } : {}),
              }, projectDir);
            }
          }
        });
      } catch {
        // Authority bookkeeping remains fail-open for the human's turn.
      }
      sayMessageId(messageId, notAReply, true);
      try {
        // The engine's guard-recovery ask keeps that the person replied; a
        // pick in a question box that offered its remedies is the host's own
        // structure. A command is no reply.
        if (!notAReply) consumeSharedDirectiveAsk(projectDir, replyText, pickerQuestion);
      } catch {
        // Non-authority marker consumption is independently best-effort.
      }
    }
    // After the turn is kept, so the note never stands in its way.
    if (personHere && promptSubmitted && typedPrompt.trim().length > 0) {
      const note = stoppedReviewNote(projectDir);
      if (note !== null) notes.push(note);
    }
    markHumanTurn(projectDir);
    // This turn is now the one lines are keyed to. Anything the person has not
    // heard yet follows them into it: a line queued for the turn before is still
    // about what they asked for, and they may have answered a question the agent
    // asked of its own accord in between.
    if (sessionId) {
      const session = sessionId;
      forThePerson.push(() => carryPendingPersonLines(projectDir, session));
    }
  }
  // Before any work exists: the reply to this chat's plan question.
  sayMessageId(messageId, typedParse?.command === true, false);
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
