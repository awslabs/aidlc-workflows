import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  APPROVED_TOGETHER_WITH_FIELD,
  auditBlockField,
  type AuditShardEvent,
  HOOK_HEARTBEAT_STALE_SLACK_MS,
  hookLiveness,
  humanTurnMintAllowed,
  isReplyTurn,
  isRequestTurn,
  MESSAGE_SPENDING_EVENTS,
  type PersonsWords,
  promptHookRanRecently,
  readAuditShardEvents,
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
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
  /** The person's own words: the text after the entry word and after any flags. Null for a command with no words. */
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

// The person's messages in this chat a request can stand on (proveMessage's
// request form), newest first, so an agent that takes the first names their
// latest and not an old approval: the ids and times a refusal names so the
// agent can name the one that asked. Never their words: the agent has them. Another
// chat's ids would leave an agent that cannot tell the chats apart to pick one
// by its time; a message named from there still proves.
export function requestMessages(pd: string): Array<{ id: string; at: string }> {
  try {
    const rows = readAuditShardEvents(pd);
    const chat = windowChat(pd, rows, latestSpendingTimestamp(rows), true);
    if (chat === null) return [];
    return listMessages(pd)
      .filter((message) => message.session === chat &&
        "message" in messageProof(pd, message.id, "request", { request: true }))
      .map((message) => ({ id: message.id, at: message.at }))
      .reverse();
  } catch {
    return [];
  }
}

// The step a refused request leads with: the agent names the message that asked
// for it, when one of theirs can stand behind it, else `otherwise`.
export function requestMessageStep(pd: string, otherwise: string): string {
  const named = requestMessages(pd);
  if (named.length === 0) return otherwise;
  return `If their message ${named.map((message) => `${message.id} (sent ${message.at})`).join(" or ")} asked for ` +
    `it, run the same command with --message <id>. Otherwise: ${otherwise}`;
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
// backed itself, so what else it asked for still stands: a setting, a check
// turned off, a cap lifted or a grant beside the approval it gave ("approve,
// and turn plan approval off"), in either order. One decision is one row, the
// stages approved together with it, or the plan approvals of every Unit, and
// the run's own approvals are none; a row
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
  const decisions = new Set<string>();
  // One jump over several Units is one decision, as one plan answer over
  // several Units is.
  let jump: { key: string; units: Set<string> } | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!after(row)) continue;
    // A grant of autonomous Construction uses up the message that gave it.
    if (row.event === "AUTONOMY_MODE_SET" && auditBlockField(row.block, "Mode") === "autonomous") return false;
    if (!MESSAGE_SPENDING_EVENTS.has(row.event)) continue;
    // A stage approved together with another is part of that one approval;
    // the run's own approval (no User Input, or Autonomous) is no decision of
    // theirs, so a stop typed while the run approves its own gates still stands.
    if (
      row.event === "GATE_APPROVED" &&
      (auditBlockField(row.block, APPROVED_TOGETHER_WITH_FIELD) !== null ||
        auditBlockField(row.block, "User Input") === null || auditBlockField(row.block, "Autonomous") === "true")
    ) continue;
    const named = auditBlockField(row.block, "Message Id");
    if (named !== null && named !== message.id) {
      const backing = readMessage(pd, named);
      if (backing === null || backing.at < message.at || backing.session !== message.session) return false;
    }
    const reopen = reopenOf(row);
    const unit = auditBlockField(row.block, "Unit") ?? "";
    if (reopen !== null && jump !== null && jump.key === reopen && !jump.units.has(unit)) {
      jump.units.add(unit);
      continue;
    }
    jump = reopen === null ? null : { key: reopen, units: new Set([unit]) };
    decisions.add(row.event === "PLAN_APPROVAL_RECORDED" ? "plan" : String(index));
  }
  return decisions.size <= 1;
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
// (onlyItsOwnDecisionAfter): a setting, a lowering, a cap lifted, a grant, or a
// choice it left to the agent.
export function proveMessage(
  pd: string,
  id: string,
  what: "answer" | "decision" | "approval" | "change request" | "setting" | "request",
  options: { request?: boolean } = {},
): { message: StoredMessage } | { refusal: string } {
  const proof = messageProof(pd, id, what, options);
  // A request's refusal leads with the messages that can stand behind it: the
  // agent has no other place to learn their ids, and a live Codex run guessed
  // the chat's id, then the person's words, before it found one.
  if (options.request !== true || !("refusal" in proof)) return proof;
  return { refusal: requestMessageStep(pd, proof.refusal) };
}

function messageProof(
  pd: string,
  id: string,
  what: "answer" | "decision" | "approval" | "change request" | "setting" | "request",
  options: { request?: boolean },
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
  const spent = options.request === true
    ? !onlyItsOwnDecisionAfter(pd, rows, message)
    : spentAt !== null && message.at < spentAt;
  if (spent) {
    return {
      refusal: `Cannot record this ${what}: message ${id} arrived before the last approval or decision` +
        `${spentAt === null ? "" : ` (${spentAt})`}, ` +
        "so it is spent. Only a message the person sent after it can answer this question.",
    };
  }
  return { message };
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
 * one (proveMessage) instead.
 */
export function personTurnStands(
  pd: string,
  mode: "request" | "plain",
  options: { replies?: boolean; requests?: boolean; intent?: string; space?: string } = {},
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
  options: { replies?: boolean; requests?: boolean; intent?: string; space?: string } = {},
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
