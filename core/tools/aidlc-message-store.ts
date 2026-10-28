import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  allowMainCheckoutChangeCommand,
  APPROVED_TOGETHER_WITH_FIELD,
  auditBlockField,
  type AuditShardEvent,
  type GuardRefusalEvent,
  HOOK_HEARTBEAT_STALE_SLACK_MS,
  hookLiveness,
  humanTurnMintAllowed,
  isReplyTurn,
  isRequestTurn,
  rowsAfterMark,
  mainCheckoutHeldByTeam,
  MESSAGE_SPENDING_EVENTS,
  type PersonsWords,
  promptHookRanRecently,
  readAuditShardEvents,
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  rejectionIsFreshAttempt,
  removeRecordFileNoFollow,
  resolveInvokingSessionId,
  sessionsDir,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";

export { MESSAGE_SPENDING_EVENTS, type PersonsWords };

// One record per message the person sends, written once by the human-turn hook
// as the message arrives. It records two things and reads no meaning into either:
// that the host delivered this in this chat, and exactly what was said: the
// text as the host delivered it, the flags the engine's own parser finds in a
// typed `/aidlc` line, and the words after them. Nothing is applied here: the
// agent reads the line and runs the setter the engine names. Which question a
// message answers is never written here: the conductor says that when it
// records a decision, and the engine then proves only that a message of the
// person's stands behind it.
//
// Each record is its own file in the gitignored session directory
// (`aidlc/.aidlc-sessions/messages/<id>.json`, beside the question store),
// written once and never rewritten, through no symlink, and read back only
// through the same no-follow path. The store keeps a day's worth and at most
// MESSAGE_MAX_RECORDS; older records go on the next write. The HUMAN_TURN row
// the hook mints names the record in its `Message Id` field; nothing names a
// record to the person.

export interface MessageRoute {
  /** A scope typed with the request (`/aidlc bugfix ...` or `--scope`). */
  scope: string | null;
  newIntent: boolean;
  skip: string[];
  add: string[];
  projectType: "greenfield" | "brownfield" | null;
}

export interface StoredMessage {
  /** Eight hex characters, minted like a question id. */
  id: string;
  /** The chat the message came through. Null is reserved for a command the person types at their own terminal. */
  session: string | null;
  at: string;
  source: "prompt" | "picker" | "terminal";
  /** As the host delivered it, cut at MESSAGE_TEXT_MAX_CHARS (`cut` says so). An empty text is a prompt whose words the host did not pass on. */
  text: PersonsWords;
  /**
   * What a question box carried back: one entry per question it asked, in the order shown, `reply` null where the
   * person left a question blank. A pick the box reported for a question it did not list follows them.
   */
  picker: Array<{ question: string; reply: PersonsWords | null }> | null;
  /**
   * The person's own words: the text after the entry word and after any flags. Null for a command with no words. A
   * question box keeps every reply it carried, one per question in the order shown, a pick with its note included.
   */
  words: PersonsWords | null;
  /** The settings typed as flags, as the config setter names them ("depth" "minimal", "guard.review-freeze" "off"). */
  settings: Array<{ key: string; value: string }>;
  route: MessageRoute;
  cut?: true;
}

/** A message as the hook hands it to the store: the same fields, with the person's words still text. */
export type NewMessage = Omit<StoredMessage, "id" | "text" | "picker" | "words"> & {
  text: string;
  picker: Array<{ question: string; reply: string | null }> | null;
  words: string | null;
};

export const MESSAGE_TEXT_MAX_CHARS = 8000;
/** A question box's question or reply is kept to this many characters. */
export const MESSAGE_PICKER_MAX_CHARS = 2000;
export const MESSAGE_MAX_RECORDS = 200;
const MESSAGE_ID = /^[0-9a-f]{8}$/;
// A ceiling against a corrupt or foreign file, not a size the hook can reach: every string it stores is cut
// (MESSAGE_TEXT_MAX_CHARS for the text and the words, MESSAGE_PICKER_MAX_CHARS per box entry).
const MESSAGE_MAX_BYTES = 256 * 1024;
const MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

export function isMessageId(id: string): boolean {
  return MESSAGE_ID.test(id);
}

function messageRel(projectDir: string, id?: string): string {
  const dir = join(sessionsDir(projectDir), "messages");
  return relative(projectDir, id === undefined ? dir : join(dir, `${id}.json`));
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPairList(value: unknown, first: string, second: string): boolean {
  return Array.isArray(value) && value.every((entry) =>
    entry !== null && typeof entry === "object" &&
    typeof (entry as Record<string, unknown>)[first] === "string" &&
    typeof (entry as Record<string, unknown>)[second] === "string");
}

function isPickerList(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) =>
    entry !== null && typeof entry === "object" &&
    typeof (entry as Record<string, unknown>).question === "string" &&
    ((entry as Record<string, unknown>).reply === null || typeof (entry as Record<string, unknown>).reply === "string"));
}

function parseMessage(id: string, raw: unknown): StoredMessage | null {
  const message = raw as Partial<StoredMessage> | null;
  const route = message?.route as Partial<MessageRoute> | undefined;
  if (
    message?.id === id &&
    (message.session === null || typeof message.session === "string") &&
    typeof message.at === "string" && !Number.isNaN(Date.parse(message.at)) &&
    (message.source === "prompt" || message.source === "picker" || message.source === "terminal") &&
    typeof message.text === "string" &&
    (message.picker === null || isPickerList(message.picker)) &&
    (message.words === null || typeof message.words === "string") &&
    isPairList(message.settings, "key", "value") &&
    route !== undefined && route !== null &&
    (route.scope === null || typeof route.scope === "string") &&
    typeof route.newIntent === "boolean" &&
    isStringList(route.skip) && isStringList(route.add) &&
    (route.projectType === null || route.projectType === "greenfield" || route.projectType === "brownfield") &&
    (message.cut === undefined || message.cut === true)
  ) {
    return message as StoredMessage;
  }
  return null;
}

function readStoredMessage(projectDir: string, id: string): StoredMessage | null {
  if (!MESSAGE_ID.test(id)) return null;
  try {
    const target = recordFileTargetOrThrow(projectDir, messageRel(projectDir, id));
    return parseMessage(
      id,
      JSON.parse(readRegularFileNoFollowOrThrow(target, "message", MESSAGE_MAX_BYTES).toString("utf-8")),
    );
  } catch {
    // Missing, redirected, or unreadable: it stands for nothing.
    return null;
  }
}

/** Whether any message of the person's is on record for this project (the store keeps a day). */
export function hasStoredMessages(projectDir: string): boolean {
  return recordIds(projectDir).length > 0;
}

/** The message behind `id`; null when it is missing, unreadable, or not a record of ours. */
export function readMessage(projectDir: string, id: string): StoredMessage | null {
  return readStoredMessage(projectDir, id);
}

function recordIds(projectDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(recordFileTargetOrThrow(projectDir, messageRel(projectDir)));
  } catch {
    return [];
  }
  return names
    .map((name) => (name.endsWith(".json") ? name.slice(0, -".json".length) : ""))
    .filter((id) => MESSAGE_ID.test(id));
}

export function mintMessageId(
  projectDir: string,
  candidate: () => string = () => randomBytes(4).toString("hex"),
): string {
  for (;;) {
    const id = candidate();
    if (!MESSAGE_ID.test(id)) continue;
    if (!existsSync(recordFileTargetOrThrow(projectDir, messageRel(projectDir, id)))) return id;
  }
}

/** Every readable record of this project, oldest first (ties by id). */
export function listMessages(projectDir: string): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const id of recordIds(projectDir)) {
    const message = readStoredMessage(projectDir, id);
    if (message !== null) messages.push(message);
  }
  return messages.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Store one message and return it with a fresh id. Older records are pruned
 * after the write, so a store failure never costs the message just received.
 */
export function saveMessage(projectDir: string, message: NewMessage): StoredMessage {
  // Kept as it came; read back, the words are PersonsWords.
  const stored = { ...message, id: mintMessageId(projectDir) } as unknown as StoredMessage;
  const serialized = `${JSON.stringify(stored)}\n`;
  if (Buffer.byteLength(serialized, "utf-8") > MESSAGE_MAX_BYTES) {
    throw new Error("message record over the size the reader accepts");
  }
  writeRecordFileNoFollow(projectDir, messageRel(projectDir, stored.id), serialized);
  pruneExpiredMessages(projectDir);
  return stored;
}

/**
 * The latest message of `session` (null: a terminal message), or with `words`
 * the latest that carries the person's words. Nothing here reads what a
 * message answers.
 */
export function latestMessage(
  projectDir: string,
  session: string | null,
  options: { words?: true } = {},
): StoredMessage | null {
  let latest: StoredMessage | null = null;
  for (const id of recordIds(projectDir)) {
    const message = readStoredMessage(projectDir, id);
    if (message === null || message.session !== session) continue;
    if (options.words === true && message.words === null) continue;
    if (latest === null || message.at > latest.at || (message.at === latest.at && message.id > latest.id)) {
      latest = message;
    }
  }
  return latest;
}

/**
 * Whether the person has said nothing since `since` (a question's createdAt):
 * messages are on record and none came after it. Before any work exists this is
 * the form of a stage gate's reply-since-shown rule, as the record has no turn
 * rows yet. It reads the chat `session` when that chat has a message on record,
 * otherwise every chat's (a hook that kept another id for the same chat still
 * finds the reply). A message keeps whole seconds and a question milliseconds,
 * so a message in the question's own second counts as after it: a pick can come
 * that fast, and the request the question was asked about came at least two of
 * the agent's steps before it. A typed line that only sets something (settings,
 * no words, no route) is a command to AIDLC and no reply, as at a gate; a
 * prompt whose words the host did not pass on may be one. Nothing on record at
 * all is no reply only when the host skipped the prompt hook for the person's
 * message (promptMissedWhileHooksRun); otherwise there is nothing to tell by.
 */
export function noReplySince(projectDir: string, session: string | null, since: string): boolean {
  const all = listMessages(projectDir);
  if (all.length === 0) return promptMissedWhileHooksRun(projectDir);
  const chat = all.filter((message) => message.session === session);
  const from = Math.floor(Date.parse(since) / 1000) * 1000;
  const command = (message: StoredMessage): boolean =>
    message.source === "prompt" && message.words === null && message.settings.length > 0 &&
    message.route.scope === null && !message.route.newIntent && message.route.projectType === null &&
    message.route.skip.length === 0 && message.route.add.length === 0;
  return !(chat.length > 0 ? chat : all).some((message) => Date.parse(message.at) >= from && !command(message));
}

// Nothing on record: no prompt hook kept the person's message. While AI-DLC's
// hooks beat just now and the prompt hook did not, the host skipped that hook
// for their message (one that failed to start, as Copilot CLI's PowerShell
// check can), and their next message is seen. Otherwise there is nothing to
// tell by: the prompt hook ran and its store failed, the hooks are not running
// (the hooks-off step's), or an unattended driver, whose prompts are never kept.
// A chat outside the selected workflow returns before the prompt beat but keeps
// its message (hookStandsOutside in aidlc-record-human-turn.ts), so it never
// reaches this branch. The tool guards beat through hooksHealthDir and both
// readers here through hooksHealthReadDir, each for this project's selection.
function promptMissedWhileHooksRun(projectDir: string): boolean {
  if (!humanTurnMintAllowed() || promptHookRanRecently(projectDir)) return false;
  const newest = hookLiveness(projectDir, []).newestHeartbeat;
  const age = newest === null ? Number.NaN : Date.now() - newest.timestampMs;
  return age >= 0 && age <= HOOK_HEARTBEAT_STALE_SLACK_MS;
}

/**
 * Remove records older than a day, then the oldest beyond MESSAGE_MAX_RECORDS.
 * A message a turn of the work's record names since its last decision is no
 * older than the decision it may still back, so age does not remove it: a
 * stage answered one day and approved the next keeps the person's words for
 * the approval. A file this process may not remove is left for the operating
 * system's permissions to decide.
 */
export function pruneExpiredMessages(projectDir: string): void {
  const cutoff = Date.now() - MESSAGE_RETENTION_MS;
  const kept: Array<{ id: string; at: number }> = [];
  let unspent: Set<string> | null = null;
  const stillUnspent = (id: string): boolean => {
    unspent ??= unspentTurnMessages(projectDir);
    return unspent.has(id);
  };
  for (const id of recordIds(projectDir)) {
    try {
      const path = recordFileTargetOrThrow(projectDir, messageRel(projectDir, id));
      if (!lstatSync(path).isFile()) continue;
      const at = Date.parse(readStoredMessage(projectDir, id)?.at ?? "");
      const when = Number.isNaN(at) ? lstatSync(path).mtimeMs : at;
      if (when < cutoff && !stillUnspent(id)) removeRecordFileNoFollow(projectDir, messageRel(projectDir, id));
      else kept.push({ id, at: when });
    } catch {
      // Not ours to remove, or already gone: keep going.
    }
  }
  kept.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const { id } of kept.slice(0, Math.max(0, kept.length - MESSAGE_MAX_RECORDS))) {
    try {
      removeRecordFileNoFollow(projectDir, messageRel(projectDir, id));
    } catch {
      // As above.
    }
  }
}

// The messages the work's turns name since its last decision. A record that
// cannot be read names none, so pruning goes by age as before.
function unspentTurnMessages(projectDir: string): Set<string> {
  try {
    const rows = readAuditShardEvents(projectDir);
    const spentAt = latestSpendingTimestamp(rows);
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.event !== "HUMAN_TURN" || (spentAt !== null && row.timestamp < spentAt)) continue;
      const id = auditBlockField(row.block, "Message Id");
      if (id !== null) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

export function latestSpendingTimestamp(rows: readonly AuditShardEvent[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (MESSAGE_SPENDING_EVENTS.has(row.event) && (latest === null || row.timestamp > latest)) latest = row.timestamp;
  }
  return latest;
}

// A message that can answer a question: it carries the person's words, and its
// turn was not only a command to AIDLC or a question about a switch (the marks
// the presence check reads on the HUMAN_TURN row).
export function messageIsReply(rows: readonly AuditShardEvent[], message: StoredMessage): boolean {
  if (message.words === null) return false;
  for (const row of rows) {
    if (row.event !== "HUMAN_TURN" || auditBlockField(row.block, "Message Id") !== message.id) continue;
    const mark = auditBlockField(row.block, "Reply");
    if (mark === "command" || mark === "question") return false;
  }
  return true;
}

// Whether a message was sent on this work: a HUMAN_TURN row of this record
// names it. The hook wrote that row only while the chat was on the work, so a
// chat that joined through its turn alone counts from that turn, and words a
// chat typed while it was on nothing (before the work was chosen here, or a
// cold workspace) or on other work never count, however the chat stands now.
// A message with no chat on it (one typed at the terminal) counts without that
// check.
function sentOnThisWork(rows: readonly AuditShardEvent[]): (message: StoredMessage) => boolean {
  const named = new Set<string>();
  for (const row of rows) {
    const id = row.event === "HUMAN_TURN" ? auditBlockField(row.block, "Message Id") : null;
    if (id !== null) named.add(id);
  }
  return (message) => message.session === null || named.has(message.id);
}

// The chats that have spoken on this work since the last spending row.
export function chatsSince(rows: readonly AuditShardEvent[], pd: string, spentAt: string | null): Set<string> {
  const onThisWork = sentOnThisWork(rows);
  return new Set(listMessages(pd)
    .filter((m) => (spentAt === null || m.at >= spentAt) && onThisWork(m))
    .map((m) => m.session ?? "terminal"));
}

// What a request is for, as the messages that can stand behind it go: any
// request, a setting, or turning plan approval off (planApprovalOffStands).
export type RequestKind = "any" | "setting" | "plan-approval-off";

// Which rows came since the waiting code plan question was shown, by their
// place on this clone's record after the question's own mark (the one its
// answer reads). Null when no plan question waits, or nothing can be ordered
// against it (an older question with no mark, another clone's, a copy of the
// tools without the plan question's module).
function sincePlanQuestion(pd: string): ((row: AuditShardEvent) => boolean) | null {
  let shown: import("./aidlc-lib.ts").AuditMark | "due" | null;
  try {
    // Typed by hand: a type import of the plan question module from here takes the tests' typecheck past its heap.
    const { planQuestionShown } = require("./aidlc-plan-approval-ask.ts") as {
      planQuestionShown(projectDir: string): import("./aidlc-lib.ts").AuditMark | "due" | null;
    };
    shown = planQuestionShown(pd);
  } catch {
    shown = null;
  }
  // A plan waiting for its question, not shown yet: nothing is sent since.
  if (shown === "due") return () => false;
  return shown === null ? null : rowsAfterMark(pd, shown);
}

// The ids of the messages whose turns come since the waiting plan question.
function messagesSince(rows: readonly AuditShardEvent[], since: (row: AuditShardEvent) => boolean): Set<string> {
  return new Set(rows.flatMap((row) => {
    const id = row.event === "HUMAN_TURN" && since(row) ? auditBlockField(row.block, "Message Id") : null;
    return id === null ? [] : [id];
  }));
}

// Arden's call: while the code plan question waits for the person, turning
// plan approval off stands only on a message they sent since that question was
// shown, named by its id or read as their turn. Three live Copilot CLI runs
// turned it off on a message that had approved something else before the plan
// was shown, and the plan was built without them, recorded as theirs. With no
// plan question waiting, a message stands as any request's does.
export function planApprovalOffStands(pd: string, turn: string | AuditShardEvent | null): boolean {
  const since = sincePlanQuestion(pd);
  if (since === null) return true;
  if (turn === null) return false;
  if (typeof turn !== "string") return turn.event === "HUMAN_TURN" && since(turn);
  return messagesSince(readAuditShardEvents(pd), since).has(turn);
}

// What the person reads when they asked before the plan was shown: why this
// plan is asked about once, and how to turn it off now. True also when the
// agent misread their words.
export const PLAN_APPROVAL_OFF_AFTER_SHOWN_LINE = "Turning plan approval off needs your word after the plan is " +
  "shown, so this plan is asked once; say so now and it is built without asking.";

// The step for an agent turning plan approval off on what came before the
// waiting plan question (planApprovalOffStands): the question, and the line
// only when the person's words did ask for it.
export function planApprovalOffWaitsStep(messageId?: string): string {
  return `${messageId === undefined ? "Plan approval stays on for now" : `Cannot turn plan approval off on message ${messageId}`}: ` +
    "the code plan question waits, and only a message the person sends since it was shown can turn plan approval " +
    "off. Show them the plan question as it is (run next for it, if it is not shown yet) and end the turn. If " +
    `their words did ask for plan approval off, say first, in one line: "${PLAN_APPROVAL_OFF_AFTER_SHOWN_LINE}"`;
}

// The person's messages in this chat a request can stand on (proveMessage's
// request form), newest first, so an agent that takes the first names their
// latest and not an old approval: the ids and times a refusal names so the
// agent can name the one that asked. Never their words: the agent has them. Another
// chat's ids would leave an agent that cannot tell the chats apart to pick one
// by its time; a message named from there still proves.
// For a setting, while the code plan question waits for the person, a message
// from before it that a decision has followed (it arrived before the last
// approval or decision) is not offered: a live Copilot CLI run took their
// "Approve" for the stage before from this list and turned plan approval off,
// set by them, with the question unanswered. For a setting, only what the
// setting's proof accepts is offered (messageReach), so no step names a message
// that already gave an approval or a decision; for turning plan approval off,
// only what can stand for it (planApprovalOffStands). Any other request still
// is offered such a message (going back to the plan their approval was for).
export function requestMessages(pd: string, kind: RequestKind = "any"): Array<{ id: string; at: string }> {
  try {
    const rows = readAuditShardEvents(pd);
    const spentAt = latestSpendingTimestamp(rows);
    const chat = windowChat(pd, rows, spentAt, true);
    if (chat === null) return [];
    const since = kind === "setting" ? sincePlanQuestion(pd) : null;
    const sent = since === null ? null : messagesSince(rows, since);
    const offered = (message: StoredMessage): boolean =>
      sent === null || sent.has(message.id) || spentAt === null || message.at >= spentAt;
    const planApprovalOff = kind === "plan-approval-off";
    return listMessages(pd)
      .filter((message) => message.session === chat && offered(message) &&
        "message" in messageProof(pd, message.id, kind === "any" ? "request" : "setting", { request: true, planApprovalOff }))
      .map((message) => ({ id: message.id, at: message.at }))
      .reverse();
  } catch {
    return [];
  }
}

// The step a refused request leads with: the agent names the message that asked
// for it, when one of theirs can stand behind it, else `otherwise`. `command` is
// the one to run with it when that is not the refused command, and `then` what
// follows it.
export function requestMessageStep(
  pd: string, otherwise: string, kind: RequestKind = "any", command = "the same command", then = "",
): string {
  const named = requestMessages(pd, kind);
  if (named.length === 0) return otherwise;
  return `If their message ${named.map((message) => `${message.id} (sent ${message.at})`).join(" or ")} asked for ` +
    `it, run ${command} with --message <id>${then ? `, then ${then}` : ""}. Otherwise: ${otherwise}`;
}

// The step for a change in the main checkout that a strict Guard Policy holds
// while the Units are built in parallel: when the person asked for it, the agent
// names their message and `swarm allow-change` records it. A strict the team
// holds in memory keeps the main checkout as approved, and that is said instead.
export function mainCheckoutChangeStep(pd: string, paths: readonly string[], otherwise: string, then: string): string {
  const held = mainCheckoutHeldByTeam(pd);
  return held !== null
    ? `${held} ${otherwise}`
    : requestMessageStep(pd, otherwise, "any", `\`${allowMainCheckoutChangeCommand(paths)}\``, then);
}

// The chat a command serves, when the engine can tell (the hook's override,
// Codex's thread id, the process ancestry); null when it cannot.
function invokingChat(pd: string): string | null {
  try {
    return resolveInvokingSessionId(pd);
  } catch {
    return null;
  }
}

// This chat, as the window reads it: the one the command serves, or with none
// named the one chat that has spoken on this work since the last decision.
function windowChat(
  pd: string, rows: readonly AuditShardEvent[], spentAt: string | null, request = false,
): string | null {
  const named = invokingChat(pd);
  if (named !== null) return named;
  const spoke = chatsSince(rows, pd, spentAt);
  if (spoke.size === 1 && !spoke.has("terminal")) return [...spoke][0];
  // A setting asked for in the message a piece of work starts with, before any
  // row of the work names a message: with no chat named, the one chat whose
  // messages still stand for a request (the decision such a message backed
  // itself, the routing that starts the work, leaves it standing) is this one.
  if (request && spoke.size === 0) {
    const standing = new Set(listMessages(pd).filter((m) => onlyItsOwnDecisionAfter(pd, rows, m))
      .map((m) => m.session ?? "terminal"));
    if (standing.size === 1 && !standing.has("terminal")) return [...standing][0];
  }
  return null;
}

// Whether the decisions recorded after `message` are the one decision it
// backed itself, so what else it asked for still stands: a stop, a cap lifted
// or a choice it left to the agent beside the approval it gave, in either
// order. One decision is one row, the stages approved together with it, or the
// plan approvals of every Unit, and the run's own approvals are none; a row
// that names a message earlier than this one was not backed by it, and a row
// that names none was the decision its window held. It reads
// ids, times and the engine's own rows, never words or what kind of reply it
// was. `after` says which rows came after the message: by default those of a
// later second; the presence read orders by the turn's own row
// (personTurnStands).
function onlyItsOwnDecisionAfter(
  pd: string,
  rows: readonly AuditShardEvent[],
  message: Pick<StoredMessage, "id" | "at" | "session">,
  after: (row: AuditShardEvent) => boolean = (row) => row.timestamp > message.at,
): boolean {
  return messageReach(pd, rows, message, after, false) === "stands";
}

// What a message still stands for after the decisions since it: "stands",
// "spent" (as onlyItsOwnDecisionAfter reads it), or, for a setting, "backed".
// Arden's rule for every setting change: a message that already backed an
// approval or another decision does not also stand for a setting, so their
// "Approve" never turns one of their checks off later (live Copilot CLI runs
// turned learnings and the summary confirmation off that way, recorded as
// theirs). A decision that names this message is one it backed, and so is the
// one decision after it that names none; one that names a later message of
// theirs is that message's. For a
// setting, a routing answer (it carries the settings before it to the work it
// names, as settingTheirs reads it) and a question box closed with nothing
// picked are no decision at all. A setting asked for beside an approval goes
// first, or rides the approval's own command (settingsBesideDecision).
function messageReach(
  pd: string,
  rows: readonly AuditShardEvent[],
  message: Pick<StoredMessage, "id" | "at" | "session">,
  after: (row: AuditShardEvent) => boolean,
  setting: boolean,
): "stands" | "spent" | "backed" {
  const decisions = new Set<string>();
  let unnamed = false;
  // One jump over several Units is one decision, as one plan answer over
  // several Units is, and so is one Request Changes for a batch of Units built
  // side by side (oneAnswerOf).
  let jump: { key: string; units: Set<string> } | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    // A row that names this message came from it, whatever its second.
    if (!after(row) && !(setting && auditBlockField(row.block, "Message Id") === message.id)) continue;
    // A grant of autonomous Construction uses up the message that gave it.
    if (row.event === "AUTONOMY_MODE_SET" && auditBlockField(row.block, "Mode") === "autonomous") return "spent";
    if (!MESSAGE_SPENDING_EVENTS.has(row.event)) continue;
    if (setting && (row.event === "REQUEST_ROUTED" || row.event === "QUESTION_UNANSWERED")) continue;
    // A stage approved together with another is part of that one approval;
    // the run's own approval (no User Input, or Autonomous) is no decision of
    // theirs, so a stop typed while the run approves its own gates still stands.
    if (
      row.event === "GATE_APPROVED" &&
      (auditBlockField(row.block, APPROVED_TOGETHER_WITH_FIELD) !== null ||
        auditBlockField(row.block, "User Input") === null || auditBlockField(row.block, "Autonomous") === "true")
    ) continue;
    const named = auditBlockField(row.block, "Message Id");
    if (setting && named === message.id) return "backed";
    unnamed ||= setting && named === null;
    if (named !== null && named !== message.id) {
      const backing = readMessage(pd, named);
      if (backing === null || backing.at < message.at || backing.session !== message.session) return "spent";
    }
    const answer = oneAnswerOf(row);
    const unit = auditBlockField(row.block, "Unit") ?? "";
    if (answer !== null && jump !== null && jump.key === answer && !jump.units.has(unit)) {
      jump.units.add(unit);
      continue;
    }
    jump = answer === null ? null : { key: answer, units: new Set([unit]) };
    decisions.add(row.event === "PLAN_APPROVAL_RECORDED" ? "plan" : String(index));
  }
  return decisions.size > 1 ? "spent" : unnamed ? "backed" : "stands";
}

// The refusal for a setting on a message that already backed a decision: it
// names no message (no refusal offers one), and its step is one that works.
function settingOnDecidedMessage(lowers: boolean): string {
  return "Cannot record this setting on that message: it already gave an approval or another decision, so it " +
    (lowers
      ? "does not also turn a check off. It stays on; go on with the open step."
      : "does not also stand for a setting. If their words asked for it, run the same command with no --message.");
}

// Rows that put a new question to the person: one the agent or a checkpoint
// asked, or a gate opened. The plan question's "asked after it" (askedAfter)
// and the window below read this one set.
export const QUESTION_ASKED_EVENTS: ReadonlySet<string> = new Set(["DECISION_RECORDED", "STAGE_AWAITING_APPROVAL"]);

// The follow-up a bare Request changes at the summary asks
// (stage-protocol-summary.md): the summary answer records it itself, right
// after the change request, and the window below takes it as part of that answer.
export const SUMMARY_CHANGES_QUESTION = "What should change?";

// A guard's refusal of an agent's action, one key per kind, so a new kind
// fails the typecheck until it is listed here.
const GUARD_REFUSALS: Record<GuardRefusalEvent, true> = {
  PLAN_APPROVAL_BLOCKED: true,
  STATE_TRANSITION_BLOCKED: true,
  STAGE_RULES_BLOCKED: true,
  REVIEW_FREEZE_BLOCKED: true,
  REVIEWER_SCOPE_BLOCKED: true,
};

// Whether the agent is still carrying out the reply that gave the latest
// decision (an approval, a change request, or its answer to the summary, the
// code plan, the Construction policy or the verification command), so a
// setting that reply asked for stands when run after the answer on that
// message, as it does riding the approval's own command
// (settingsBesideDecision): live Claude Code, Copilot CLI, Kiro CLI and
// opencode runs recorded "approve, and turn plan approval off" as the answer
// first, then lost the setting. The reply is over, and the message stands for
// no setting (messageReach), once the person has sent another message on this
// work (in any chat: a resume is one), a later decision is on record (the
// run's own approval included, which names no message), the message no longer
// stands as a request does (onlyItsOwnDecisionAfter: a grant of autonomy uses
// it up), a guard has refused the agent, or the next question is up: one asked
// or a gate opened (a live Copilot CLI run asked the next questions, then
// turned the summary confirmation off on the yes to the one before), other than
// the "What should change?" a bare Request changes at the summary asks
// (summaryFollowUpOf), or a code plan question shown since. The plan question
// the reply answered still reads as waiting while its answer is being written,
// so it counts by when it was shown (Kiro CLI ran the setter beside the plan
// answer). Ids, the engine's own rows and their places only, never words.
function answeringItsDecision(pd: string, rows: readonly AuditShardEvent[], message: StoredMessage): boolean {
  if (!onlyItsOwnDecisionAfter(pd, rows, message)) return false;
  let decision: AuditShardEvent | null = null;
  for (const row of rows) {
    if (!MESSAGE_SPENDING_EVENTS.has(row.event) || auditBlockField(row.block, APPROVED_TOGETHER_WITH_FIELD) !== null) continue;
    if (decision === null || rowAfter(row, decision, true)) decision = row;
  }
  if (decision === null || auditBlockField(decision.block, "Message Id") !== message.id) return false;
  const since = decision;
  const itsOwnFollowUp = summaryFollowUpOf(decision);
  const turn = rows.find((row) => row.event === "HUMAN_TURN" && auditBlockField(row.block, "Message Id") === message.id);
  const over = rows.some((row) =>
    (row.event === "HUMAN_TURN" && auditBlockField(row.block, "Message Id") !== message.id &&
      (turn === undefined ? row.timestamp > message.at : rowAfter(row, turn, true))) ||
    ((Object.hasOwn(GUARD_REFUSALS, row.event) || (QUESTION_ASKED_EVENTS.has(row.event) && !itsOwnFollowUp(row))) &&
      rowAfter(row, since, true))
  );
  const plan = sincePlanQuestion(pd);
  return !over && (plan === null || plan(since));
}

// The question a bare Request changes at the summary asks itself ("What should
// change?", for the same stage and Unit): the reply that asked for the change
// is still the one in hand, whether the summary answer or the agent logged it.
function summaryFollowUpOf(decision: AuditShardEvent): (row: AuditShardEvent) => boolean {
  if (decision.event !== "SUMMARY_CONFIRMATION_RECORDED") return () => false;
  const stage = auditBlockField(decision.block, "Stage");
  const unit = auditBlockField(decision.block, "Unit");
  return (row) => row.event === "DECISION_RECORDED" &&
    auditBlockField(row.block, "Decision") === SUMMARY_CHANGES_QUESTION &&
    auditBlockField(row.block, "Stage") === stage && auditBlockField(row.block, "Unit") === unit;
}

// Whether the only decision recorded after `message` is one redo or jump back
// (the rows of one reopen over its Units, reopenOf) naming no other message:
// the message asked for it, so a change asked for beside it still answers the
// question that reopen brought up. A change reopen is the person's Request
// Changes already on record (rejectionIsFreshAttempt) and spends the message,
// as a gate's Request Changes does. Ids, times and the engine's own rows only.
function onlyItsReopenAfter(rows: readonly AuditShardEvent[], message: Pick<StoredMessage, "id" | "at">): boolean {
  let reopen: string | null = null;
  for (const row of rows) {
    if (row.timestamp <= message.at || !MESSAGE_SPENDING_EVENTS.has(row.event)) continue;
    const key = reopenOf(row);
    const named = auditBlockField(row.block, "Message Id");
    if (
      key === null || !rejectionIsFreshAttempt(row.block) || (reopen !== null && key !== reopen) ||
      (named !== null && named !== message.id)
    ) return false;
    reopen = key;
  }
  return reopen !== null;
}

// The one answer a GATE_REJECTED row belongs to when that answer writes a row
// per Unit, one after another: a jump over several Units (reopenOf), or a
// batch checkpoint's Request Changes (each Unit's row carries its batch). Null
// for any other row. Only the spend rule groups by it: a batch's Request
// Changes is no redo (onlyItsReopenAfter reads reopenOf alone).
function oneAnswerOf(row: AuditShardEvent): string | null {
  const reopen = reopenOf(row);
  const batch = row.event === "GATE_REJECTED" ? auditBlockField(row.block, "Batch number") : null;
  if (reopen !== null || batch === null) return reopen;
  return `${auditBlockField(row.block, "Checkpoint") ?? ""}:${auditBlockField(row.block, "Stage") ?? ""}:${batch}`;
}

// The jump a GATE_REJECTED row belongs to, null for any other row: a jump over
// several Units writes one row per Unit, one after another, for the same target.
function reopenOf(row: AuditShardEvent): string | null {
  if (row.event !== "GATE_REJECTED") return null;
  const via = auditBlockField(row.block, "Reopen");
  if (via === null) return null;
  return `${via}:${auditBlockField(row.block, "Stage") ?? ""}:${auditBlockField(row.block, "Gate Stages") ?? ""}`;
}

// LLM maps, tool proves: the agent names the message its decision reads, an
// answer or a gate's choice; the engine proves the record exists, came through
// this chat or was sent on this work in another, carries the person's words
// and is not spent by a later decision, and reads no words. A message from any
// chat of this work proves: the agent reads one record, and the spending row
// settles a race between chats. A same-second tie with a spending row favours
// the message: one message can give an approval and the answers beside it. With
// `request`, the message backs what it asks for beside a decision
// (onlyItsOwnDecisionAfter): a cap lifted, a stop, or a choice it left to the
// agent; a setting (`what` "setting") only when it backed no decision itself
// (messageReach), and `lowers` says whether it turns a check off. With
// `reopened`, a message whose only decision since is the reopen it asked for
// (onlyItsReopenAfter) still answers the question that reopen brought up. With
// `planApprovalOff`, it also stands for turning plan approval off
// (planApprovalOffStands).
export function proveMessage(
  pd: string,
  id: string,
  what: "answer" | "decision" | "approval" | "change request" | "setting" | "request",
  options: { request?: boolean; reopened?: boolean; planApprovalOff?: boolean; lowers?: boolean } = {},
): { message: StoredMessage } | { refusal: string } {
  const proof = messageProof(pd, id, what, options);
  // A request's refusal leads with the messages that can stand behind it: the
  // agent has no other place to learn their ids, and a live Codex run guessed
  // the chat's id, then the person's words, before it found one.
  if (options.request !== true || !("refusal" in proof)) return proof;
  const kind: RequestKind = options.planApprovalOff === true ? "plan-approval-off" : what === "setting" ? "setting" : "any";
  return { refusal: requestMessageStep(pd, proof.refusal, kind) };
}

function messageProof(
  pd: string,
  id: string,
  what: "answer" | "decision" | "approval" | "change request" | "setting" | "request",
  options: { request?: boolean; reopened?: boolean; planApprovalOff?: boolean; lowers?: boolean },
): { message: StoredMessage } | { refusal: string } {
  const message = isMessageId(id) ? readMessage(pd, id) : null;
  if (message === null) {
    return {
      refusal: `Cannot record this ${what}: no message record ${id} exists in this project. Name the id of a ` +
        "message the person sent (the step for their reply names them), or wait for their reply.",
    };
  }
  const rows = readAuditShardEvents(pd);
  const spentAt = latestSpendingTimestamp(rows);
  const onThisWork = sentOnThisWork(rows);
  // This chat's own messages prove as they are (the one a piece of work starts
  // with is kept before any row of the work can name it); another chat's must
  // be this work's.
  const chat = windowChat(pd, rows, spentAt, options.request === true);
  if (message.session !== chat && !onThisWork(message)) {
    // The retry names this chat's replies on this work that no decision has
    // used, oldest first: the ids and times, never their words.
    const unspent = chat === null ? [] : listMessages(pd)
      .filter((m) => m.session === chat && (spentAt === null || m.at >= spentAt) && onThisWork(m) &&
        messageIsReply(rows, m))
      .map((m) => `${m.id} (sent ${m.at})`);
    return {
      refusal: unspent.length > 0
        ? `If the person's message ${unspent.join(" or ")} is the one you read, run the same command with ` +
          `--message <id>. Cannot record this ${what}: message ${id} was not sent on this piece of work.`
        : `Cannot record this ${what}: message ${id} was not sent on this piece of work. Show the person the ` +
          "question if you have not, end the turn, and record the choice they make.",
    };
  }
  if (!messageIsReply(rows, message)) {
    return {
      refusal: `Cannot record this ${what}: message ${id} carried no words of the person's own (a command to AIDLC, ` +
        "or a message with no words), so it answers nothing. Name a message that carries their reply.",
    };
  }
  // The waiting plan question is a setting's second boundary, and its step to
  // show that question leads.
  if (options.planApprovalOff === true && !planApprovalOffStands(pd, id)) return { refusal: planApprovalOffWaitsStep(id) };
  const reach = options.request === true
    ? messageReach(pd, rows, message, (row) => row.timestamp > message.at, what === "setting")
    : !(options.reopened === true && onlyItsReopenAfter(rows, message)) && spentAt !== null && message.at < spentAt
      ? "spent"
      : "stands";
  if (reach === "backed" && !answeringItsDecision(pd, rows, message)) {
    return { refusal: settingOnDecidedMessage(options.lowers === true) };
  }
  if (reach === "spent") {
    return {
      refusal: `Cannot record this ${what}: message ${id} arrived before the last approval or decision` +
        `${spentAt === null ? "" : ` (${spentAt})`}, ` +
        "so it is spent. Only a message the person sent after it can answer this question.",
    };
  }
  return { message };
}

// The message a reading step kept the person's words under, when no turn on
// this work's record names it and it can answer the open question: their chat
// had not joined the work when it came (a teammate's clone, where the
// selection is not committed, so the human-turn hook kept the message and
// wrote no turn), and the answer's own proof takes it. The work was on record
// before it came: the message a piece of work starts with is kept the same way,
// and it answers no question the work asks later. The step names it on its
// answer command, by its id. No turn is made for it, so what a gate joins
// (personsGateReply) stays the turns on the record. Null otherwise, and on any
// read error.
export function messageBeforeJoining(pd: string, id: string | undefined): string | null {
  if (id === undefined) return null;
  try {
    const message = readMessage(pd, id);
    const rows = readAuditShardEvents(pd);
    if (message === null || sentOnThisWork(rows)(message) || !rows.some((row) => row.timestamp < message.at)) return null;
    return "message" in proveMessage(pd, id, "answer") ? id : null;
  } catch {
    return null;
  }
}

// Whether `a` comes after `b` on the record: a later second, or the same second
// and a later place in the same shard. Rows of one second in two shards are
// unordered; `crossShard` says how such a pair reads.
function rowAfter(a: AuditShardEvent, b: AuditShardEvent, crossShard: boolean): boolean {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp;
  return a.shardIndex === b.shardIndex ? a.pos > b.pos : crossShard;
}

/**
 * Presence for what a command asks for, by the one spend rule: the person's
 * latest turn on the work's record still stands behind it. `request` is the
 * message proof's request form (at most one decision of theirs after the turn:
 * a stop, a scope change, a check a host lets through); `plain` stands only
 * while no decision follows the turn (going back to an approved plan, what the
 * folder is, a jump), so the approval a message gave never also stands behind
 * work the agent undoes on its own. An answer never spends either. With
 * `replies` the turn is a reply; with `requests`, anything but an older
 * record's question about a switch, which ends the reach of the turns before
 * it; with neither, any turn. Presence is a fact about the turn, not its words:
 * a command line, a host that passed no text and a record the store pruned all
 * count, ordered by the row's place in its shard. The turn is this chat's when
 * the engine and the row both name a chat, else the latest whatever its chat,
 * so a missing fact fails toward the person. It reads ids, times and the
 * engine's own rows, never words. A command that names its message proves that
 * one (proveMessage) instead. With `planApprovalOff`, the turn also stands for
 * turning plan approval off (planApprovalOffStands).
 */
export function personTurnStands(
  pd: string,
  mode: "request" | "plain",
  options: { replies?: boolean; requests?: boolean; intent?: string; space?: string; planApprovalOff?: boolean } = {},
): boolean {
  return standingPersonTurn(pd, mode, options) !== null;
}

/**
 * The turn personTurnStands reads, when it stands: its HUMAN_TURN row (whose
 * Message Id names the message behind what the command does), else null.
 */
export function standingPersonTurn(
  pd: string,
  mode: "request" | "plain",
  options: { replies?: boolean; requests?: boolean; intent?: string; space?: string; planApprovalOff?: boolean } = {},
): AuditShardEvent | null {
  try {
    const unreadable: string[] = [];
    const rows = readAuditShardEvents(pd, options.intent, options.space, unreadable);
    if (unreadable.length > 0) return null;
    const chat = invokingChat(pd);
    let turn: AuditShardEvent | undefined;
    for (const row of rows) {
      if (row.event !== "HUMAN_TURN") continue;
      const session = auditBlockField(row.block, "Session");
      if (chat !== null && session !== null && session !== chat) continue;
      if (options.replies === true && !isReplyTurn(row)) continue;
      if (turn === undefined || rowAfter(row, turn, row.shardIndex > turn.shardIndex)) turn = row;
    }
    if (turn === undefined || (options.requests === true && !isRequestTurn(turn))) return null;
    const of = turn;
    // A row of the turn's own second in another shard cannot be ordered
    // against it, so it reads as after: the record cannot say it came first.
    const after = (row: AuditShardEvent): boolean => row !== of && rowAfter(row, of, true);
    if (mode === "plain") {
      // Words sent on to separate new work reply to no question here: what
      // they asked for still stands, unless the turn read is a reply.
      return rows.some((row) =>
        after(row) &&
        ((MESSAGE_SPENDING_EVENTS.has(row.event) && (row.event !== "REQUEST_ROUTED" || options.replies === true)) ||
          (row.event === "AUTONOMY_MODE_SET" && auditBlockField(row.block, "Mode") === "autonomous")))
        ? null
        : of;
    }
    const id = auditBlockField(of.block, "Message Id");
    if (options.planApprovalOff === true && !planApprovalOffStands(pd, of)) return null;
    const kept = id === null ? null : readMessage(pd, id);
    return onlyItsOwnDecisionAfter(
      pd,
      rows,
      kept ?? { id: id ?? "", at: of.timestamp, session: auditBlockField(of.block, "Session") },
      after,
    ) ? of : null;
  } catch {
    return null;
  }
}
