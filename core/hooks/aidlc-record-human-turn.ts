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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addPendingPersonLines,
  carryPendingPersonLines,
  clearSessionIntentHandoff,
  emptyPickerResult,
  enterHookWorkflow,
  hookStandsOutside,
  hostEnvelopeTurnText,
  clearPlanApprovalChallenge,
  planApprovalChallengeRelativePath,
  protectedQuestionRelativePath,
  withdrawProtectedQuestions,
  COMMAND_TURN_REPLY,
  QUESTION_TURN_REPLY,
  consumeSharedDirectiveAsk,
  forgetGateWords,
  hookContextLine,
  hooksHealthDir,
  humanTurnMintAllowed,
  isoTimestamp,
  keepPlanApprovalAskOverStateWrite,
  markHumanTurn,
  parseTypedGuardSwitchRequest,
  recordGateWords,
  recordPreWorkflowHeartbeat,
  resolveProjectDirFromHook,
  splitKiroCommandArgs,
  stateFilePath,
  stripRecommendedDecorator,
  validSessionId,
  withAuditLock,
  writeProjectHookStatusFile,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  applyTypedGuardSwitchPrompt,
  isTypedGuardSwitchPrompt,
  isTypedGuardSwitchQuestion,
  normalizeRetiredGuardPolicyField,
} from "../tools/aidlc-guard-switch.ts";
import {
  PLAN_APPROVAL_OVERRIDE_PHRASE_RE,
  type PlanApprovalPickerQuestion,
  recordPlanApprovalHumanResponse,
  recordPlanApprovalOverrideRequest,
  recordProtectedHumanResponse,
} from "../tools/aidlc-testing-posture.ts";
import {
  engineQuestionHoldsReplies,
  notePlanApprovalAskReply,
  openPlanApprovalQuestion,
} from "../tools/aidlc-plan-approval-ask.ts";
import { aidlcEntryWords, isAidlcCommandPrompt } from "../tools/aidlc-reply-reader.ts";

// "/aidlc approve the code plan" is the person's reply: the engine reads the
// words after the entry as nothing but words. Any flag, scope, verb or noun
// keeps it a command. Read only for a prompt that starts with the entry, so
// other prompts pay nothing; a failed read keeps it a command, as before.
async function aidlcEntryReply(prompt: string): Promise<string | null> {
  const words = aidlcEntryWords(prompt);
  if (words === null || words.length === 0) return null;
  try {
    const { nextArgsAreOnlyWords } = await import("../tools/aidlc-orchestrate.ts");
    return nextArgsAreOnlyWords(splitKiroCommandArgs(words)) ? words : null;
  } catch {
    return null;
  }
}

// Setting flags, then the person's reply to the open code plan question
// ("/aidlc --guard-policy off approve the plan"): the setting is for the work
// open now and the words are their reply, one of its choices or their own
// words. Words after an explicit `--` describe new work. Null for anything else.
function planAnswerAfterSwitch(projectDir: string, prompt: string): string | null {
  try {
    const entry = /^(?:\/aidlc|\$aidlc|aidlc)(?:\s+|$)/i.exec(prompt.trim());
    if (entry !== null && splitKiroCommandArgs(prompt.trim().slice(entry[0].length)).includes("--")) return null;
    const parsed = parseTypedGuardSwitchRequest(prompt, { wordsAnswer: true });
    if (parsed.words === undefined || parsed.error !== null || parsed.settings.length === 0) return null;
    const question = openPlanApprovalQuestion(projectDir, parsed.words);
    return question !== null && !question.answered && !question.editing ? parsed.words : null;
  } catch {
    return null;
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

// What the agent does after an empty question box (emptyPickerResult).
// Codex's own instruction says to "continue with best judgment"; asking in
// the box again would only run out again.
const QUESTION_UNANSWERED_NOTICE =
  "The question box closed with no answer, so nothing was answered or recorded. " +
  "Ask the same question again in your reply as numbered options, not in the question box, " +
  "and end the turn; never pick an answer for the person.";

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
function pickerReplies(input: string): Array<{ question: string; reply: string }> {
  try {
    const payload = JSON.parse(input) as {
      tool_input?: unknown; toolInput?: unknown; tool_response?: unknown; toolResponse?: unknown; picker_reply?: unknown;
    };
    let response = payload.picker_reply ?? payload.tool_response ?? payload.toolResponse;
    if (typeof response === "string") response = JSON.parse(response);
    const answers = response !== null && typeof response === "object" ? (response as Record<string, unknown>).answers : null;
    if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return [];
    const toolInput = payload.tool_input ?? payload.toolInput;
    const asked = toolInput !== null && typeof toolInput === "object" &&
        Array.isArray((toolInput as Record<string, unknown>).questions)
      ? (toolInput as { questions: unknown[] }).questions
      : [];
    const shown = (key: string): string => {
      for (const entry of asked) {
        const question = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
        if (question.id === key && typeof question.question === "string") return question.question;
      }
      return key;
    };
    const replies: Array<{ question: string; reply: string }> = [];
    for (const [key, value] of Object.entries(answers)) {
      const picks = value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).answers
        : value;
      const reply = (Array.isArray(picks) ? picks : [picks])
        .filter((pick): pick is string => typeof pick === "string" && pick.trim() !== "")
        .join(", ");
      if (reply !== "") replies.push({ question: shown(key), reply });
    }
    return replies;
  } catch {
    return [];
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
  try {
    return await respond(input, notes, forThePerson);
  } finally {
    for (const queue of forThePerson) {
      try {
        queue();
      } catch {
        // A line the person may miss never blocks their turn.
      }
    }
    if (notes.length > 0) process.stdout.write(hookContextLine("UserPromptSubmit", notes.join("\n")));
  }
}

async function respond(input: string, notes: string[], forThePerson: Array<() => void>): Promise<number> {
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
  let pickerUnanswered = false;
  // Every pick a picker reply carried, for the record (pickerAnswerNote).
  let picked: string[] = [];
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
  } catch { /* presence still records without identity on legacy payloads */ }
  // A new prompt starts a new turn: a one-shot stop left from an earlier turn
  // (a switch's, or a creation's whose Stop never ran) is spent here, before
  // any early return, so nothing chains onto it or ends this turn on it (#1263).
  if (promptSubmitted && sessionId) {
    try { clearSessionIntentHandoff(projectDir, sessionId); } catch { /* per-user runtime state */ }
  }
  // A conversation that has not joined the selected workflow is not a human at
  // its gates: it mints nothing there and its typed switches do not reach it.
  const workflow = enterHookWorkflow(projectDir, sessionId);
  if (hookStandsOutside(workflow)) {
    // The record name is repository text, so the notice does not repeat it.
    if (typedPrompt && isTypedGuardSwitchPrompt(typedPrompt) && workflow.selection?.intent) {
      notes.push(
        "AIDLC Guard Policy: the typed switch was not applied because this conversation has not joined the selected workflow; " +
          "select its intent with the intent command first.",
      );
    }
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
  const mintAllowed = humanTurnMintAllowed();
  if (!mintAllowed && typedPrompt && isTypedGuardSwitchPrompt(typedPrompt)) {
    notes.push(
      "AIDLC Guard Policy: the typed switch was not applied because AIDLC_UNATTENDED=1 withholds human authority on this driver; run it from an attended session.",
    );
  }
  // Apply before the state-file gate: Guard Policy relaxed or off and plan
  // approval off are kept for the piece of work this chat starts next, and any
  // other first-use fence switch says to create it and type the switch again.
  const switchAnswer = typedPrompt ? planAnswerAfterSwitch(projectDir, typedPrompt) : null;
  if (mintAllowed && sessionId && typedPrompt) {
    try {
      // A switch typed before a plan choice keeps the plan question open over
      // its state write, so the choice after it is still its answer.
      const before = switchAnswer !== null ? readFileSync(stateFilePath(projectDir), "utf-8") : null;
      const outcome = applyTypedGuardSwitchPrompt(projectDir, sessionId, typedPrompt, { wordsAnswer: switchAnswer !== null });
      if (before !== null) {
        keepPlanApprovalAskOverStateWrite(projectDir, before, readFileSync(stateFilePath(projectDir), "utf-8"));
      }
      if (outcome !== null) {
        const lines = outcome.lines;
        // Only a switch that went through is already done, and only its line is
        // the engine's to say next. An outcome that changed nothing (a typo in a
        // companion flag, a rule the team holds) stays exactly as it was: the
        // agent reads it and answers the person itself.
        notes.push(outcome.applied
          ? `AIDLC Guard Policy: ${lines.join(" ")} Say that line to the person in your reply, in those words; the ` +
            "switch is already applied, so never run a setter for it."
          : `AIDLC Guard Policy: ${lines.join(" ")} Say that line to the person in your reply, in those words.`);
        // Whatever the switch did or did not do, the person hears it from the
        // engine's next step as well: a switch of theirs that changed nothing
        // (a word the parser cannot read, a rule their team holds) is exactly
        // what they must not be left guessing about.
        const session = sessionId;
        forThePerson.push(() => addPendingPersonLines(projectDir, session, lines));
      }
    } catch {
      // A switch failure must never block the human's turn.
    }
  }
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
      try {
        withAuditLock(projectDir, () => {
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
    if (mintAllowed) {
      // A typed guard switch or break-glass request is an instruction to the
      // framework, not an answer to the pending Plan Approval question; a
      // question about a switch ("skip plan approval?") is for the agent.
      const switchQuestion = typedPrompt.length > 0 && isTypedGuardSwitchQuestion(typedPrompt);
      const entryReply = switchAnswer ?? (typedPrompt.length > 0 ? await aidlcEntryReply(typedPrompt) : null);
      const notAReply = typedPrompt.length > 0 && switchAnswer === null && (
        (isAidlcCommandPrompt(typedPrompt) && entryReply === null) ||
        isTypedGuardSwitchPrompt(typedPrompt) ||
        switchQuestion ||
        PLAN_APPROVAL_OVERRIDE_PHRASE_RE.test(typedPrompt.trim())
      );
      // A reply typed after the entry is the words after it, so "/aidlc 1"
      // picks the first choice as "1" does.
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
          // Words typed after the entry with nothing of a command in them
          // ("/aidlc use postgres") are a reply.
          appendAuditEntryUnlocked("HUMAN_TURN", {
            ...(sessionId ? { Session: sessionId } : {}),
            ...(switchQuestion
              ? { Reply: QUESTION_TURN_REPLY }
              : notAReply || answersEngineQuestion ? { Reply: COMMAND_TURN_REPLY } : {}),
            ...(picked.length > 0 ? { Picked: JSON.stringify(picked) } : {}),
          }, projectDir);
          // Keep what the person typed in this chat, so a decision at a stage
          // gate records their own words beside the conductor's reading
          // (recordGateWords in aidlc-lib.ts). A slash command, typed guard
          // switch, or break-glass phrase instructs the framework; of a picker
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
          // A question about a switch ("skip plan approval?") reaches it too, as
          // words for the conductor to answer.
          const engineQuestionOwnsReply = replyText !== "" && (!notAReply || switchQuestion) &&
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
          if (sessionId && typedPrompt) {
            recordPlanApprovalOverrideRequest(projectDir, sessionId, typedPrompt);
          }
          // What the question box carried back goes on the record, question
          // by question, so the person's reply stands even when no answer is
          // logged for it. It decides nothing and spends no turn. Written
          // after the turn's words, which are kept at the shard's size just
          // after its row.
          if (pickerQuestion !== undefined && !notAReply) {
            for (const { question, reply } of pickerReplies(input)) {
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
