import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  removeRecordFileNoFollow,
  sessionsDir,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";

// One record per message the person sends, written once by the human-turn hook
// as the message arrives. It proves two things and reads no meaning into either:
// that a real person said this in this chat, and exactly what they said: the
// text as the host delivered it, the flags the engine's own parser finds in a
// typed `/aidlc` line, the words after them, and the switch lines the hook
// applied to the open work. Which question a message answers is never written
// here: the conductor says that when it records a decision, and the engine then
// proves only that a message of the person's stands behind it.
//
// Each record is its own file in the gitignored session directory
// (`aidlc/.aidlc-sessions/messages/<id>.json`, beside the question store),
// written once and never rewritten, through no symlink, and read back only
// through the same no-follow path. The store keeps a day's worth and at most
// MESSAGE_MAX_RECORDS; older records go on the next write. The HUMAN_TURN row
// the hook mints names the record in its `Message` field; nothing names a
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
  /** What a question box carried back, one entry per question it asked, verbatim. */
  picker: Array<{ question: string; reply: string }> | null;
  /** The person's own words: the text after the entry word and after any flags. Null for a command with no words. */
  words: string | null;
  /** The settings typed as flags, as the config setter names them ("depth" "minimal", "guard.review-freeze" "off"). */
  settings: Array<{ key: string; value: string }>;
  route: MessageRoute;
  /** The lines the hook's typed-switch step produced for the work this chat has open. */
  applied: string[];
  cut?: true;
}

export const MESSAGE_TEXT_MAX_CHARS = 8000;
export const MESSAGE_MAX_RECORDS = 200;
const MESSAGE_ID = /^[0-9a-f]{8}$/;
const MESSAGE_MAX_BYTES = 64 * 1024;
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

function parseMessage(id: string, raw: unknown): StoredMessage | null {
  const message = raw as Partial<StoredMessage> | null;
  const route = message?.route as Partial<MessageRoute> | undefined;
  if (
    message?.id === id &&
    (message.session === null || typeof message.session === "string") &&
    typeof message.at === "string" && !Number.isNaN(Date.parse(message.at)) &&
    (message.source === "prompt" || message.source === "picker" || message.source === "terminal") &&
    typeof message.text === "string" &&
    (message.picker === null || isPairList(message.picker, "question", "reply")) &&
    (message.words === null || typeof message.words === "string") &&
    isPairList(message.settings, "key", "value") &&
    route !== undefined && route !== null &&
    (route.scope === null || typeof route.scope === "string") &&
    typeof route.newIntent === "boolean" &&
    isStringList(route.skip) && isStringList(route.add) &&
    (route.projectType === null || route.projectType === "greenfield" || route.projectType === "brownfield") &&
    isStringList(message.applied) &&
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

/**
 * Store one message and return it with a fresh id. Older records are pruned
 * after the write, so a store failure never costs the message just received.
 */
export function saveMessage(projectDir: string, message: Omit<StoredMessage, "id">): StoredMessage {
  const stored: StoredMessage = { ...message, id: mintMessageId(projectDir) };
  writeRecordFileNoFollow(projectDir, messageRel(projectDir, stored.id), `${JSON.stringify(stored)}\n`);
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
