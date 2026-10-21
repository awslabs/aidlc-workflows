import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  auditBlockField,
  type AuditShardEvent,
  HOOK_HEARTBEAT_STALE_SLACK_MS,
  hookLiveness,
  humanTurnMintAllowed,
  promptHookRanRecently,
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  removeRecordFileNoFollow,
  sessionsDir,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";

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
  text: string;
  /**
   * What a question box carried back: one entry per question it asked, in the order shown, `reply` null where the
   * person left a question blank. A pick the box reported for a question it did not list follows them.
   */
  picker: Array<{ question: string; reply: string | null }> | null;
  /** The person's own words: the text after the entry word and after any flags. Null for a command with no words. */
  words: string | null;
  /** The settings typed as flags, as the config setter names them ("depth" "minimal", "guard.review-freeze" "off"). */
  settings: Array<{ key: string; value: string }>;
  route: MessageRoute;
  cut?: true;
}

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
export function saveMessage(projectDir: string, message: Omit<StoredMessage, "id">): StoredMessage {
  const stored: StoredMessage = { ...message, id: mintMessageId(projectDir) };
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
 * A file this process may not remove is left for the operating system's
 * permissions to decide.
 */
export function pruneExpiredMessages(projectDir: string): void {
  const cutoff = Date.now() - MESSAGE_RETENTION_MS;
  const kept: Array<{ id: string; at: number }> = [];
  for (const id of recordIds(projectDir)) {
    try {
      const path = recordFileTargetOrThrow(projectDir, messageRel(projectDir, id));
      if (!lstatSync(path).isFile()) continue;
      const at = Date.parse(readStoredMessage(projectDir, id)?.at ?? "");
      const when = Number.isNaN(at) ? lstatSync(path).mtimeMs : at;
      if (when < cutoff) removeRecordFileNoFollow(projectDir, messageRel(projectDir, id));
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

// Rows that spend the person's messages: a decision of another kind than an
// answer. One message backs at most one approval plus any answers, so answers
// never spend it.
export const MESSAGE_SPENDING_EVENTS: ReadonlySet<string> = new Set([
  "GATE_APPROVED",
  "GATE_REJECTED",
  "PLAN_APPROVAL_RECORDED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "VERIFICATION_COMMAND_RECORDED",
  "CONSTRUCTION_POLICY_RECORDED",
  "QUESTION_UNANSWERED",
  // A routing answer sends the words before it to the work they named.
  "REQUEST_ROUTED",
]);

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

// The chats that have spoken on this work since the last spending row. A message
// counts when a HUMAN_TURN row of this record names it: the hook wrote that row
// only while the chat was on the work, so a chat that joined through its turn
// alone counts from that turn, and words a chat typed while it was on nothing
// (before the work was chosen here, or a cold workspace) never count, however
// the chat stands now. A message with no chat on it (one typed at the
// terminal) counts without that check.
export function chatsSince(rows: readonly AuditShardEvent[], pd: string, spentAt: string | null): Set<string> {
  const named = new Set<string>();
  for (const row of rows) {
    const id = row.event === "HUMAN_TURN" ? auditBlockField(row.block, "Message Id") : null;
    if (id !== null) named.add(id);
  }
  return new Set(listMessages(pd)
    .filter((m) => (spentAt === null || m.at >= spentAt) && (m.session === null || named.has(m.id)))
    .map((m) => m.session ?? "terminal"));
}

// A quote's text as the person typed it, whatever the case, spacing or
// punctuation: compatibility forms folded, lower case, apostrophes dropped
// ("it's" and "its" read alike, a typographic one too), and anything else that
// is not a letter, digit, mark or emoji read as a space, with a run of emoji a
// word of its own. It reads no meaning.
function quoteText(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/['\u2018\u2019\u02BC]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\p{So}]+/gu, " ")
    .replace(/\p{So}+/gu, " $& ")
    .replace(/ {2,}/g, " ")
    .trim();
}

// Scripts written without spaces between words, where a word can end at any
// seam between two letters.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

// Whether a word can end at `at` in quoteText's `text`: either end, a space, or
// a seam beside an unspaced script, never one inside a number or before a mark
// (it belongs to the letter it follows).
function wordEdge(text: string, at: number): boolean {
  if (at === 0 || at === text.length) return true;
  const before = Array.from(text.slice(Math.max(0, at - 2), at)).at(-1) ?? "";
  const after = String.fromCodePoint(text.codePointAt(at) ?? 0);
  if (before === " " || after === " ") return true;
  if (/\p{M}/u.test(after)) return false;
  const opens = (c: string) => UNSPACED.test(c) && !/\p{N}/u.test(c);
  return opens(before) || opens(after);
}

/** Whether `said` holds the words `quoted` gives as whole words, case, spacing and punctuation aside. */
export function holdsQuote(said: string, quoted: string): boolean {
  const wanted = quoteText(quoted);
  if (wanted === "") return false;
  const text = quoteText(said);
  for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
    if (wordEdge(text, at) && wordEdge(text, at + wanted.length)) return true;
  }
  return false;
}

/**
 * What the person said, as the record holds it, for a quote of theirs to be
 * found in: every message the hook kept in this project, from any chat (what
 * they typed; of a question box, what they picked or wrote, never its
 * question), the picks and question-box replies on `rows`, and the request
 * that started the work. `everyTurnHeld` says whether every turn of theirs on
 * `rows` names a kept message with all its words in it. A host that passed no
 * words, a message too long to keep whole, a record gone with the day, or no
 * turn on record at all leaves it false, and then nothing proves a quote is
 * not theirs.
 */
export function personsSaidWords(
  projectDir: string,
  rows: readonly AuditShardEvent[],
): { said: string[]; everyTurnHeld: boolean } {
  const said: string[] = [];
  const kept = new Map<string, StoredMessage>();
  for (const message of listMessages(projectDir)) {
    kept.set(message.id, message);
    if (message.picker === null) said.push(message.source === "picker" ? message.words ?? "" : message.text);
    else for (const { reply } of message.picker) if (reply !== null) said.push(reply);
  }
  let turns = 0;
  let held = true;
  for (const row of rows) {
    if (row.event === "HUMAN_TURN") {
      turns++;
      const message = kept.get(auditBlockField(row.block, "Message Id") ?? "");
      if (message === undefined || message.cut === true || (message.source !== "picker" && message.text.trim() === "")) {
        held = false;
      }
      try {
        const picks = JSON.parse(auditBlockField(row.block, "Picked") ?? "[]") as unknown;
        if (Array.isArray(picks)) said.push(...picks.filter((pick): pick is string => typeof pick === "string"));
      } catch {
        // A row that does not parse adds nothing.
      }
    } else if (row.event === "QUESTION_REPLIED") {
      said.push(auditBlockField(row.block, "Reply") ?? "");
    } else if (row.event === "WORKFLOW_STARTED") {
      said.push(auditBlockField(row.block, "Request") ?? "");
    }
  }
  return { said, everyTurnHeld: turns > 0 && held };
}

/**
 * The reply of the person's that the agent quoted: a message of `session` that
 * is a reply, sent since the last decision or the chat's newest message (a
 * decision it led to itself, "looks fine, but turn the sensors off", leaves its
 * other half standing), whose words (or whole text) are exactly `quoted`,
 * spacing and case aside. The agent read the chat and names the reply; this
 * only finds the record that says it, and reads nothing into the words. Words
 * that are part of a reply, or of another chat's, find nothing. With no chat
 * named, the one chat that has spoken since the last decision is this one.
 */
export function replyOfTheirs(
  projectDir: string,
  session: string | null,
  quoted: string | undefined,
  rows: readonly AuditShardEvent[],
): StoredMessage | null {
  const plain = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = plain(quoted ?? "");
  if (wanted === "") return null;
  const spentAt = latestSpendingTimestamp(rows);
  // A command whose chat the engine cannot name is this work's one chat, as
  // proveMessage reads it: the only chat that has spoken since the last decision.
  if (session === null) {
    const chats = chatsSince(rows, projectDir, spentAt);
    if (chats.size !== 1 || chats.has("terminal")) return null;
    session = [...chats][0];
  }
  let found: StoredMessage | null = null;
  const chat = listMessages(projectDir).filter((message) => message.session === session);
  const newest = chat.at(-1)?.id;
  for (const message of chat) {
    if (message.words === null) continue;
    if (spentAt !== null && message.at < spentAt && message.id !== newest) continue;
    if (!messageIsReply(rows, message)) continue;
    if (plain(message.words) === wanted || plain(message.text) === wanted) found = message;
  }
  return found;
}
