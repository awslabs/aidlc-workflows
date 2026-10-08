import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  listSpaces,
  readIntentRegistry,
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  removeRecordFileNoFollow,
  SPACE_NAME_REGEX,
  sessionsDir,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";
import { resolveAidlcSettings } from "./aidlc-settings.ts";

// The copy of a request an engine question was asked about, so its answer
// commands carry a short id instead of the request text. Each question gets
// its own file in the gitignored session directory, written once and never
// rewritten, with the same operating-system permissions as the rest of the
// workspace. The file is removed when the question starts work; an unanswered
// one is kept unless `question-retention-days` is set.

// Which ask stored a question: a cold-start ask names new work; a
// new-work-routing ask is about work that already exists. A `compose` entry is
// a report-only or task-less composition, described only when its plan is
// approved: it holds no text, and its approval saves the described request
// with `composedFrom` naming it.
export type QuestionOrigin = "front" | "routing" | "compose";

/** An item a routing question named, by folder and immutable uuid. */
export interface QuestionTarget {
  intent: string;
  uuid: string;
}

export interface StoredQuestion {
  id: string;
  text: string;
  proposedScope: string;
  origin: QuestionOrigin;
  /**
   * For a routing question: the items its continue and reshape routes may act
   * on. `pick` marks one asked while no work was selected, whose continue and
   * reshape need the person to pick one of `targets`.
   */
  askedAbout?: QuestionAskedAbout;
  /** The person asked for new work (`next --new-intent`), so its answer starts it. */
  newWork?: true;
  /**
   * The request this question was derived from, as that request's OWN root: the
   * `compose` entry a description was approved on, or the question whose answer
   * this one asks about. One hop always reaches the root, so words the person
   * typed for the first question reach the work the last one creates.
   */
  composedFrom?: string;
  /**
   * For a routing question shown with options: the asked workflow's state
   * digest when it was asked, or asked while none was selected, the digest of
   * the records it offered. It marks a question a reply naming one of its
   * options can answer; that answer finds its work by folder and uuid, however
   * far the work has moved on since.
   */
  stateSha256?: string;
  /**
   * For a routing question: the settings typed with the request, as `next`
   * flags, for an answer that starts new work and for one that acts on the
   * work it names. A reply that only names an option replays them.
   */
  settings?: QuestionSettings;
  /**
   * For a routing question that stopped an answer to another question (a plan
   * approval, a scope confirmation): that question's id. New work started from
   * the routing question answers it, so the work starts once.
   */
  approvedRequest?: string;
  createdAt: string;
}

export interface QuestionAskedAbout {
  space: string;
  targets: QuestionTarget[];
  pick?: true;
}

export interface QuestionSettings {
  newWork: string[];
  existingWork: string[];
}

// Flag names and their one-word values (a stage list joins slugs with commas,
// a check's flag names it after a dot) only: `next`'s own parser reads them
// back and checks each value.
const SETTING_TOKEN = /^(?:--)?[a-z0-9][a-z0-9.,-]*$/;

function isSettingTokens(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((token) => typeof token === "string" && SETTING_TOKEN.test(token));
}

export const QUESTION_UNAVAILABLE =
  "That question is no longer available; please describe the work again.";

const QUESTION_ID = /^[0-9a-f]{8}$/;
// A record folder name as the record list reports it: any single path
// component (legacy and migrated folders may hold spaces or punctuation), or
// "" for a workflow without one.
function isRecordName(name: string): boolean {
  return !/[\\/\0]/.test(name) && name !== "." && name !== "..";
}
const QUESTION_MAX_BYTES = 4 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isQuestionId(id: string): boolean {
  return QUESTION_ID.test(id);
}

// Every path is reached through no symlink, so a redirected session directory
// can never send a question's reads or writes outside the project.
function questionRel(projectDir: string, id?: string): string {
  const dir = join(sessionsDir(projectDir), "questions");
  return relative(projectDir, id === undefined ? dir : join(dir, `${id}.json`));
}

function isTargetList(value: unknown): value is QuestionTarget[] {
  return Array.isArray(value) && value.every((target) =>
    typeof target?.intent === "string" && isRecordName(target.intent) &&
    typeof target.uuid === "string"
  );
}

function parseQuestion(id: string, raw: unknown): StoredQuestion | null {
  const question = raw as Partial<StoredQuestion> | null;
  if (
    question?.id === id &&
    typeof question.text === "string" &&
    (question.origin === "compose" ? question.text === "" : question.text.trim() !== "") &&
    typeof question.proposedScope === "string" &&
    (question.origin === "front" || question.origin === "routing" || question.origin === "compose") &&
    typeof question.createdAt === "string" &&
    (question.composedFrom === undefined ||
      (typeof question.composedFrom === "string" && QUESTION_ID.test(question.composedFrom))) &&
    (question.askedAbout === undefined ||
      (typeof question.askedAbout?.space === "string" &&
        SPACE_NAME_REGEX.test(question.askedAbout.space) &&
        isTargetList(question.askedAbout.targets) &&
        (question.askedAbout.pick === undefined || question.askedAbout.pick === true))) &&
    (question.newWork === undefined || question.newWork === true) &&
    (question.stateSha256 === undefined ||
      (typeof question.stateSha256 === "string" && /^[0-9a-f]{64}$/.test(question.stateSha256))) &&
    (question.settings === undefined ||
      (isSettingTokens(question.settings?.newWork) && isSettingTokens(question.settings.existingWork))) &&
    (question.approvedRequest === undefined ||
      (typeof question.approvedRequest === "string" && QUESTION_ID.test(question.approvedRequest)))
  ) {
    return question as StoredQuestion;
  }
  return null;
}

function readStoredQuestion(projectDir: string, id: string): StoredQuestion | null {
  if (!QUESTION_ID.test(id)) return null;
  try {
    const target = recordFileTargetOrThrow(projectDir, questionRel(projectDir, id));
    return parseQuestion(
      id,
      JSON.parse(readRegularFileNoFollowOrThrow(target, "question", QUESTION_MAX_BYTES).toString("utf-8")),
    );
  } catch {
    // Missing, redirected, or unreadable: it cannot stand for any request.
    return null;
  }
}

/**
 * The question behind `id`; null when it is missing, unreadable, or older than
 * the project's retention period (an expired question is never answered, even
 * before a later question prunes its file).
 */
export function readQuestion(projectDir: string, id: string): StoredQuestion | null {
  const question = readStoredQuestion(projectDir, id);
  if (question?.origin === "compose") return null;
  const days = question ? retentionDays(projectDir) : null;
  if (question && days !== null && Date.parse(question.createdAt) < Date.now() - days * DAY_MS) return null;
  return question;
}

/** The `compose` entry behind `id`, under the same expiry as any question. */
export function readComposeEntry(projectDir: string, id: string): StoredQuestion | null {
  const entry = readStoredQuestion(projectDir, id);
  if (entry?.origin !== "compose") return null;
  const days = retentionDays(projectDir);
  if (days !== null && Date.parse(entry.createdAt) < Date.now() - days * DAY_MS) return null;
  return entry;
}

// Unlimited unless `question-retention-days` is set for this project, or its
// environment override `AIDLC_QUESTION_RETENTION_DAYS` is set.
function retentionDays(projectDir: string): number | null {
  const override = process.env.AIDLC_QUESTION_RETENTION_DAYS;
  let days: number | undefined;
  if (override !== undefined) {
    days = Number(override);
  } else {
    try {
      days = resolveAidlcSettings(projectDir).flags?.questionRetentionDays;
    } catch {
      // Unreadable settings are reported by the config tools; keep everything.
    }
  }
  return days !== undefined && Number.isInteger(days) && days > 0 ? days : null;
}

/**
 * Remove questions older than the retention period. Every engine run that
 * engages the workflow calls this, so a set period holds whether or not another
 * question is asked; queries and observers never do. A file this process may
 * not remove is left for the operating system's permissions to decide.
 */
export function pruneExpiredQuestions(projectDir: string): void {
  const days = retentionDays(projectDir);
  if (days === null) return;
  const cutoff = Date.now() - days * DAY_MS;
  let names: string[];
  try {
    names = readdirSync(recordFileTargetOrThrow(projectDir, questionRel(projectDir)));
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (!QUESTION_ID.test(id)) continue;
    try {
      const path = recordFileTargetOrThrow(projectDir, questionRel(projectDir, id));
      if (!lstatSync(path).isFile()) continue;
      const asked = Date.parse(readStoredQuestion(projectDir, id)?.createdAt ?? "");
      if ((Number.isNaN(asked) ? lstatSync(path).mtimeMs : asked) < cutoff) {
        removeRecordFileNoFollow(projectDir, questionRel(projectDir, id));
      }
    } catch {
      // Not ours to remove, or already gone: keep going.
    }
  }
}

/**
 * The new-work question asked most recently, when it was asked within `withinMs`:
 * the request a reply at the compose gate or the scope confirmation is about.
 * A `compose` entry counts, so a reply at its gate answers that composition.
 */
export function latestFrontQuestionId(projectDir: string, withinMs: number): string | null {
  let names: string[];
  try {
    names = readdirSync(recordFileTargetOrThrow(projectDir, questionRel(projectDir)));
  } catch {
    return null;
  }
  let latest: { id: string; at: number } | null = null;
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (!QUESTION_ID.test(id)) continue;
    const question = readStoredQuestion(projectDir, id);
    const at = Date.parse(question?.createdAt ?? "");
    if (question === null || question.origin === "routing" || Number.isNaN(at) || Date.now() - at > withinMs) continue;
    if (latest === null || at > latest.at) latest = { id, at };
  }
  return latest?.id ?? null;
}

/**
 * The question stored most recently, of any origin (a `compose` entry
 * included), unexpired: the one a reply that only names an option is about.
 */
export function latestQuestion(projectDir: string): StoredQuestion | null {
  let names: string[];
  try {
    names = readdirSync(recordFileTargetOrThrow(projectDir, questionRel(projectDir)));
  } catch {
    return null;
  }
  let latest: { question: StoredQuestion; at: number } | null = null;
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (!QUESTION_ID.test(id)) continue;
    const question = readStoredQuestion(projectDir, id);
    const at = Date.parse(question?.createdAt ?? "");
    if (question === null || Number.isNaN(at)) continue;
    if (latest === null || at > latest.at) latest = { question, at };
  }
  if (latest === null) return null;
  const { question } = latest;
  return question.origin === "compose" ? readComposeEntry(projectDir, question.id) : readQuestion(projectDir, question.id);
}

/**
 * The first new-work question asked at or after `since` and within `withinMs`
 * of it: the request described right after words said before any was open. A
 * `compose` entry counts, so words said just before a composition answer it.
 * With `routing`, a routing question counts too: words typed with a description
 * beside open work answer the routing question that description becomes.
 */
export function firstFrontQuestionSince(
  projectDir: string,
  since: string,
  withinMs: number,
  options: { routing?: boolean } = {},
): string | null {
  const from = Date.parse(since);
  if (Number.isNaN(from)) return null;
  let names: string[];
  try {
    names = readdirSync(recordFileTargetOrThrow(projectDir, questionRel(projectDir)));
  } catch {
    return null;
  }
  let first: { id: string; at: number } | null = null;
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (!QUESTION_ID.test(id)) continue;
    const question = readStoredQuestion(projectDir, id);
    const at = Date.parse(question?.createdAt ?? "");
    if (question === null || (question.origin === "routing" && !options.routing) || Number.isNaN(at) ||
      at < from || at - from > withinMs) continue;
    if (first === null || at < first.at) first = { id, at };
  }
  return first?.id ?? null;
}

// Whether a work-list row already names `id` as the question that started it.
function startedWorkUses(projectDir: string, id: string): boolean {
  return listSpaces(projectDir).some(({ name }) =>
    readIntentRegistry(projectDir, name).some((row) => row.request === id)
  );
}

/**
 * A fresh question id: never one a stored question or a work-list row already
 * uses, so a new answer can never be mistaken for a repeat of old work.
 */
export function mintQuestionId(
  projectDir: string,
  candidate: () => string = () => randomBytes(4).toString("hex"),
): string {
  for (;;) {
    const id = candidate();
    if (!QUESTION_ID.test(id)) continue;
    const taken = existsSync(recordFileTargetOrThrow(projectDir, questionRel(projectDir, id))) ||
      startedWorkUses(projectDir, id);
    if (!taken) return id;
  }
}

/**
 * Store the request a question is about and return it with a fresh id. Asking
 * twice is two questions, so each keeps its own id and file.
 */
export function saveQuestion(
  projectDir: string,
  text: string,
  proposedScope: string,
  origin: QuestionOrigin = "front",
  askedAbout?: QuestionAskedAbout,
  newWork = false,
  composedFrom?: string,
  stateSha256?: string,
  settings?: QuestionSettings,
  approvedRequest?: string,
): StoredQuestion {
  pruneExpiredQuestions(projectDir);
  // A question derived from another keeps that one's root, never the parent, so
  // a chain of asks stays one hop from where the person's words were said.
  const root = composedFrom ? readStoredQuestion(projectDir, composedFrom)?.composedFrom ?? composedFrom : undefined;
  const question: StoredQuestion = {
    id: mintQuestionId(projectDir),
    text,
    proposedScope,
    origin,
    ...(askedAbout ? { askedAbout } : {}),
    ...(newWork ? { newWork: true as const } : {}),
    ...(root ? { composedFrom: root } : {}),
    ...(stateSha256 ? { stateSha256 } : {}),
    ...(settings && (settings.newWork.length > 0 || settings.existingWork.length > 0) ? { settings } : {}),
    ...(approvedRequest && QUESTION_ID.test(approvedRequest) ? { approvedRequest } : {}),
    createdAt: new Date().toISOString(),
  };
  writeRecordFileNoFollow(projectDir, questionRel(projectDir, question.id), `${JSON.stringify(question)}\n`);
  return question;
}

/** Remove a question's copy once it started work; a missing file is already gone. */
export function deleteQuestion(projectDir: string, id: string): void {
  if (!QUESTION_ID.test(id)) return;
  try {
    if (existsSync(recordFileTargetOrThrow(projectDir, questionRel(projectDir, id)))) {
      removeRecordFileNoFollow(projectDir, questionRel(projectDir, id));
    }
  } catch {
    // Best effort: the work list already records which question started the work.
  }
}

/**
 * Whether a routing question's continue or reshape route may act on the
 * selected item: only the item, or one of the items, its question named.
 */
export function questionTargetSelected(
  question: StoredQuestion,
  selection: { space: string; intent: string | null; uuid: string | null },
): boolean {
  return question.askedAbout?.space === selection.space &&
    question.askedAbout.targets.some((target) =>
      target.intent === (selection.intent ?? "") && target.uuid === (selection.uuid ?? "")
    );
}
