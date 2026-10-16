// UserPromptSubmit hook: record a HUMAN_TURN event (human-presence gate).
//
// On every real human prompt, append a HUMAN_TURN event to the active intent's
// audit shard (the state machine's own append-only ledger). The approval /
// interview gate (handleApprove / handleAnswer) refuses unless a HUMAN_TURN was
// recorded since the last gate resolution (and, at a stage gate, after the gate
// was shown). The hook records presence and order;
// it does not authenticate who launched the dispatcher.
//
// Presence remains the gate signal; the prompt payload also answers the single
// active protected challenge (plan, verification command, policy, or checkpoint).
// The hook records the person's message whole and applies nothing: a setting
// typed as a flag is the agent's to read and the setter's to apply, once the
// agent runs the command `next` names.
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
  hostEnvelopeTurnText,
  clearPlanApprovalChallenge,
  planApprovalChallengeRelativePath,
  protectedQuestionRelativePath,
  withdrawProtectedQuestions,
  COMMAND_TURN_REPLY,
  consumeSharedDirectiveAsk,
  forgetGateWords,
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
  stripRecommendedDecorator,
  suppliedTurnOrigin,
  swarmWorkerWorktreeMeta,
  terminalCommandRelay,
  type TurnOrigin,
  validSessionId,
  withAuditLock,
  writeProjectHookStatusFile,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import { aidlcToolInvocation } from "../tools/aidlc-runtime-paths.ts";
import { normalizeRetiredGuardPolicyField } from "../tools/aidlc-guard-switch.ts";
import {
  type PlanApprovalPickerQuestion,
  recordPlanApprovalHumanResponse,
  recordProtectedHumanResponse,
} from "../tools/aidlc-testing-posture.ts";
import {
  engineQuestionHoldsReplies,
  notePlanApprovalAskReply,
  notePlanApprovalFileAnswer,
} from "../tools/aidlc-plan-approval-ask.ts";
import { aidlcEntryWords, isAidlcCommandPrompt } from "../tools/aidlc-reply-reader.ts";
import { MESSAGE_PICKER_MAX_CHARS, MESSAGE_TEXT_MAX_CHARS, saveMessage, type StoredMessage } from "../tools/aidlc-message-store.ts";

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
interface MessageParse extends Pick<StoredMessage, "words" | "settings" | "route"> {
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
      words: said,
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

// What the agent does after an empty question box (emptyPickerResult).
// Codex's own instruction says to "continue with best judgment"; asking in
// the box again would only run out again.
const QUESTION_UNANSWERED_NOTICE =
  "The question box closed with no answer, so nothing was answered or recorded. " +
  "Ask the same question again in your reply as numbered options, not in the question box, " +
  "and end the turn; never pick an answer for the person.";

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

// The words a person typed into a single-choice picker's free-text field. A
// pick of one of the offered labels is the conductor's wording, not theirs.
function pickerFreeText(text: string, picker: PlanApprovalPickerQuestion | undefined): string {
  if (!picker || !text || picker.severalPicks || picker.options === null) return "";
  const typed = stripRecommendedDecorator(text).toLowerCase();
  return picker.options.some((label) => stripRecommendedDecorator(label).toLowerCase() === typed) ? "" : text;
}

// A stage-gate choice picked in the picker is the person's exact pick: it is
// kept like a typed one, so a report of another choice is refused. Only a
// picker that offers the gate's own two choices is a gate picker.
const GATE_PICK_LABELS = ["approve", "request changes", "accept as-is"];
function pickedGateLabel(text: string, picker: PlanApprovalPickerQuestion | undefined): string {
  if (!picker || !text || picker.severalPicks || picker.options === null) return "";
  const offered = picker.options.map((option) => stripRecommendedDecorator(option).trim().toLowerCase());
  if (!offered.includes("approve") || !offered.includes("request changes")) return "";
  const label = stripRecommendedDecorator(text).trim();
  return GATE_PICK_LABELS.includes(label.toLowerCase()) ? label : "";
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
  const handover: { help: string | null } = { help: null };
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
    if (notes.length > 0) process.stdout.write(hookContextLine("UserPromptSubmit", notes.join("\n")));
  }
}

async function respond(
  input: string,
  notes: string[],
  forThePerson: Array<() => void>,
  handover: { help: string | null },
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
  // Every pick a picker reply carried, for the record (pickerAnswerNote).
  let picked: string[] = [];
  // Who sent this turn. An adapter that read its host's own signals says so in
  // `origin`; Claude Code's transcript is read here; anything unknown is a
  // person (kiroTurnOrigin, claudeTranscriptOrigin in aidlc-lib.ts).
  let turnOrigin: TurnOrigin = { kind: "person" };
  // An adapter whose own prompt hook runs a command the person typed and hands
  // the agent its output (Kiro's) says so; the help is then left to it.
  let relaysTerminalOutput = false;
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
      origin?: unknown;
      prompt_id?: unknown;
      transcript_path?: unknown;
      relays_terminal_output?: unknown;
    };
    relaysTerminalOutput = parsed.relays_terminal_output === true;
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
    for (const candidate of [
      prompt,
      userPrompt,
      message,
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
        [prompt, userPrompt, message].find(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        ) ?? "";
    } else if (parsed.tool_response !== undefined || parsed.toolResponse !== undefined) {
      pickerUnanswered = emptyPickerResult(parsed.tool_response ?? parsed.toolResponse);
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
      // names who started the turn. With no row, only the whole notice
      // sentence counts as the host's.
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
      const noWords: Pick<StoredMessage, "words" | "settings" | "route"> = {
        words: null, settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
      };
      const parsed: Pick<StoredMessage, "words" | "settings" | "route"> = typedParse !== null
        ? { words: typedParse.words, settings: typedParse.settings, route: typedParse.route }
        : promptSubmitted
        ? noWords
        : { ...noWords, words: humanResponseText.trim() || null };
      const full = promptSubmitted ? typedPrompt : humanResponseText;
      // Every stored string is cut (#2107: uncut words once put a record past the
      // reader's cap).
      const picker = promptSubmitted ? null : pickerReplies(input, MESSAGE_PICKER_MAX_CHARS);
      const words = parsed.words !== null && parsed.words.length > MESSAGE_TEXT_MAX_CHARS
        ? parsed.words.slice(0, MESSAGE_TEXT_MAX_CHARS)
        : parsed.words;
      const cut = full.length > MESSAGE_TEXT_MAX_CHARS || words !== parsed.words || picker?.cut === true;
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
  if (outside) {
    // A turn the host made (its notice or brief) is nobody's words here either:
    // kept, it would read as the person's prompt where their message is the
    // proof before any work exists (intent creation).
    if (turnOrigin.kind !== "host") keepMessage();
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
  // A turn the host made (its notice or brief, not the person's words): none of
  // the person's authority rides on it. No turn, no kept words, no reply, no
  // switch, no conversational marker. The record keeps that it happened and why,
  // with no text, so a turn that stopped counting is visible there.
  if (turnOrigin.kind === "host") {
    const host = turnOrigin;
    if (existsSync(stateFilePath(projectDir))) {
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
  if (existsSync(stateFilePath(projectDir))) {
    // Inside a workflow it lands in the record, before the mint branch and
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
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: QUESTION_UNANSWERED_NOTICE },
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
      // Another engine question on top (where the work belongs, which plan)
      // takes this reply: it answers no question beneath it, so no
      // checkpoint, verification command, gate, or legacy plan question keeps
      // it, and decisions on those skip it as they skip a command.
      const answersEngineQuestion = replyText !== "" && engineQuestionHoldsReplies(projectDir);
      let keptWordsOffset: number | null = null;
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
            ...(notAReply || answersEngineQuestion ? { Reply: COMMAND_TURN_REPLY } : {}),
            ...(picked.length > 0 ? { Picked: JSON.stringify(picked) } : {}),
            ...(messageId ? { "Message Id": messageId } : {}),
          }, projectDir);
          // Keep what the person typed in this chat, so a decision at a stage
          // gate records their own words beside the conductor's reading
          // (recordGateWords in aidlc-lib.ts). A command to AIDLC instructs
          // the framework; of a picker
          // reply, free text typed into it counts, and so does a picked gate
          // choice, which is their exact pick. Never blocks the turn.
          const typedWords = answersEngineQuestion ? "" : typedPrompt
            ? (notAReply ? "" : entryReply ?? typedPrompt)
            : pickerFreeText(humanResponseText, pickerQuestion) || pickedGateLabel(humanResponseText, pickerQuestion);
          if (sessionId && typedWords) {
            try {
              keptWordsOffset = recordGateWords(projectDir, sessionId, typedWords);
            } catch {
              // The words are a convenience; the turn and its HUMAN_TURN stand.
            }
          }
          // An open question keeps that the person replied to it and their
          // exact words. The conductor reads them and records the choice the
          // person made; nothing here reads meaning into them. The engine's own
          // Plan Approval question takes the reply from whichever chat it
          // arrives in.
          const engineQuestionOwnsReply = replyText !== "" && !notAReply &&
            notePlanApprovalAskReply(projectDir, sessionId, replyText, pickerQuestion);
          if (!engineQuestionOwnsReply && sessionId && replyText && !answersEngineQuestion) {
            const plan = existsSync(join(projectDir, planApprovalChallengeRelativePath(projectDir, sessionId)));
            const protectedQuestion = existsSync(join(projectDir, protectedQuestionRelativePath(projectDir, sessionId)));
            if (plan && protectedQuestion) {
              clearPlanApprovalChallenge(projectDir, sessionId);
              withdrawProtectedQuestions(projectDir, sessionId);
            } else if (protectedQuestion) {
              if (!notAReply) recordProtectedHumanResponse(projectDir, sessionId, replyText, questionText, pickerQuestion);
            } else if (!notAReply) {
              // With no question of its own here, a Unit or batch checkpoint
              // question another chat asked takes the reply: the person may
              // answer it in any chat.
              if (plan || !recordProtectedHumanResponse(projectDir, sessionId, replyText, questionText, pickerQuestion).recorded) {
                recordPlanApprovalHumanResponse(projectDir, sessionId, replyText, pickerQuestion);
              }
            }
          }
          // What the question box carried back goes on the record, question
          // by question, so the person's reply stands even when no answer is
          // logged for it. It decides nothing and spends no turn. Written
          // after the turn's words, which are kept at the shard's size just
          // after its row.
          if (pickerQuestion !== undefined && !notAReply) {
            for (const { question, reply } of pickerReplies(input).entries) {
              if (reply === null) continue; // a question left blank carried no pick
              appendAuditEntryUnlocked("QUESTION_REPLIED", {
                ...(sessionId ? { Session: sessionId } : {}),
                Question: question,
                Reply: reply,
              }, projectDir);
            }
          }
        });
      } catch {
        // Authority bookkeeping remains fail-open for the human's turn.
      }
      try {
        // The questions file invites the person to answer on its `[Answer]:`
        // line and say done. Their turn and their words are on record now, so
        // an exact choice they wrote there is recorded the way an exact pick
        // typed in chat is, and anything else they wrote is named for the
        // agent to read. Never blocks the turn.
        // Another engine question on screen owns the reply, and the plan
        // question's own record is bound to its own marker, so this reads the
        // file only while the plan question is the open step.
        if (!notAReply && !answersEngineQuestion && replyText) {
          const fileAnswer = notePlanApprovalFileAnswer(projectDir, sessionId, replyText);
          if (fileAnswer !== null) notes.push(fileAnswer);
        }
      } catch {
        // Their words stay on the line; the agent reads them.
      }
      try {
        // A reply the engine's guard-recovery ask took as its answer is that
        // ask's, not revision feedback for a stage gate.
        const offset = keptWordsOffset;
        // A command, or several picks, is no one remedy.
        const recoveryReply = notAReply || pickerQuestion?.severalPicks ? "" : replyText;
        if (consumeSharedDirectiveAsk(projectDir, recoveryReply) && offset !== null) {
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
