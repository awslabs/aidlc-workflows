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
// new-work-routing ask is about work that already exists.
export type QuestionOrigin = "front" | "routing";

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
  /** For a routing question: the items its continue and reshape routes may act on. */
  askedAbout?: { space: string; targets: QuestionTarget[] };
  createdAt: string;
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
    typeof question.text === "string" && question.text.trim() !== "" &&
    typeof question.proposedScope === "string" &&
    (question.origin === "front" || question.origin === "routing") &&
    typeof question.createdAt === "string" &&
    (question.askedAbout === undefined ||
      (typeof question.askedAbout?.space === "string" &&
        SPACE_NAME_REGEX.test(question.askedAbout.space) &&
        isTargetList(question.askedAbout.targets)))
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
  const days = question ? retentionDays(projectDir) : null;
  if (question && days !== null && Date.parse(question.createdAt) < Date.now() - days * DAY_MS) return null;
  return question;
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

// Remove questions older than the retention period. A file this process may
// not remove is left for the operating system's permissions to decide.
function pruneByRetention(projectDir: string): void {
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
  askedAbout?: { space: string; targets: QuestionTarget[] },
): StoredQuestion {
  pruneByRetention(projectDir);
  const question: StoredQuestion = {
    id: mintQuestionId(projectDir),
    text,
    proposedScope,
    origin,
    ...(askedAbout ? { askedAbout } : {}),
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
