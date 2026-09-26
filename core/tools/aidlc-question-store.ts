import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  removeRecordFileNoFollow,
  resolveProjectFlag,
  SPACE_NAME_REGEX,
  sessionsDir,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";

// The private copy of a request an engine question was asked about, so its
// answer commands carry a short id instead of the request text. Each question
// gets its own file, written once and never rewritten; the file is removed
// when the question starts work, and an unanswered one is kept unless
// `question-retention-days` is set.

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
const POSIX = process.platform !== "win32";

export function isQuestionId(id: string): boolean {
  return QUESTION_ID.test(id);
}

// One file per question in this clone's gitignored session directory. Every
// path is reached through no symlink, and on POSIX the directory is
// owner-only because questions hold request text.
function questionRel(projectDir: string, id?: string): string {
  const dir = join(sessionsDir(projectDir), "questions");
  return relative(projectDir, id === undefined ? dir : join(dir, `${id}.json`));
}

// Another account's file is not this user's question, and is never touched.
function ownedByAnotherAccount(target: string): boolean {
  return POSIX && lstatSync(target).uid !== process.getuid?.();
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

/** The question behind `id`; null when it is missing, unreadable, or another account's. */
export function readQuestion(projectDir: string, id: string): StoredQuestion | null {
  if (!QUESTION_ID.test(id)) return null;
  try {
    const target = recordFileTargetOrThrow(projectDir, questionRel(projectDir, id));
    if (ownedByAnotherAccount(target)) return null;
    return parseQuestion(
      id,
      JSON.parse(readRegularFileNoFollowOrThrow(target, "question", QUESTION_MAX_BYTES).toString("utf-8")),
    );
  } catch {
    // Missing, redirected, or unreadable: it cannot stand for any request.
    return null;
  }
}

// Test-only: pause between checking a path and opening it, so a test can swap
// an ancestor inside that window.
function waitAtPermissionBarrier(kind: "directory" | "file"): void {
  const barrier = process.env.AIDLC_TEST_QUESTION_CHMOD_BARRIER?.trim();
  if (!barrier) return;
  writeFileSync(`${barrier}.${kind}.checked`, "checked\n", "utf-8");
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30_000;
  while (!existsSync(`${barrier}.${kind}.release`)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting at the question permission barrier");
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

// Set a mode through a descriptor opened without following a link. O_NOFOLLOW
// guards only the last component, so after opening, re-check the whole chain
// and prove the path still names the descriptor's own file, inside the
// project, before changing anything: a swapped ancestor aborts the change.
function chmodNoFollow(projectDir: string, rel: string, mode: number, directory: boolean): void {
  const path = recordFileTargetOrThrow(projectDir, rel);
  waitAtPermissionBarrier(directory ? "directory" : "file");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0),
  );
  try {
    const opened = fstatSync(fd);
    const projectReal = realpathSync(projectDir);
    const currentReal = realpathSync(recordFileTargetOrThrow(projectDir, rel));
    const current = statSync(currentReal);
    if (
      (directory ? !opened.isDirectory() : !opened.isFile()) ||
      !currentReal.startsWith(`${projectReal}${sep}`) ||
      current.dev !== opened.dev || current.ino !== opened.ino
    ) {
      throw new Error(`${path} changed while its permissions were being set`);
    }
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

// Create the directory owner-only, and tighten one left wider by an earlier
// run or a different umask. A private directory also covers the atomic
// writer's temporary file, which is created with the process default mode.
function ensurePrivateDir(projectDir: string): void {
  const rel = questionRel(projectDir);
  const dir = recordFileTargetOrThrow(projectDir, rel);
  // Only this leaf is private; the shared workspace parents keep their modes.
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (POSIX) chmodNoFollow(projectDir, rel, 0o700, true);
}

// Unlimited unless `question-retention-days` (or its environment override) is
// set to a positive number of days.
function retentionDays(): number | null {
  const days = Number(resolveProjectFlag("AIDLC_QUESTION_RETENTION_DAYS"));
  return Number.isInteger(days) && days > 0 ? days : null;
}

// Remove this account's questions older than the retention period. Called
// with the directory already private; another account's files are left alone.
function pruneByRetention(projectDir: string): void {
  const days = retentionDays();
  if (days === null) return;
  const cutoff = Date.now() - days * DAY_MS;
  try {
    const dir = recordFileTargetOrThrow(projectDir, questionRel(projectDir));
    for (const name of readdirSync(dir)) {
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      const path = join(dir, name);
      if (!QUESTION_ID.test(id) || !lstatSync(path).isFile() || ownedByAnotherAccount(path)) continue;
      const asked = Date.parse(readQuestion(projectDir, id)?.createdAt ?? "");
      if ((Number.isNaN(asked) ? lstatSync(path).mtimeMs : asked) < cutoff) {
        removeRecordFileNoFollow(projectDir, questionRel(projectDir, id));
      }
    }
  } catch {
    // No directory yet, or one this process must not touch: nothing to prune.
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
  ensurePrivateDir(projectDir);
  pruneByRetention(projectDir);
  let id = randomBytes(4).toString("hex");
  while (existsSync(recordFileTargetOrThrow(projectDir, questionRel(projectDir, id)))) {
    id = randomBytes(4).toString("hex");
  }
  const question: StoredQuestion = {
    id,
    text,
    proposedScope,
    origin,
    ...(askedAbout ? { askedAbout } : {}),
    createdAt: new Date().toISOString(),
  };
  const rel = questionRel(projectDir, id);
  writeRecordFileNoFollow(projectDir, rel, `${JSON.stringify(question)}\n`);
  if (POSIX) chmodNoFollow(projectDir, rel, 0o600, false);
  return question;
}

/** Remove a question's copy once it started work; a missing file is already gone. */
export function deleteQuestion(projectDir: string, id: string): void {
  if (!QUESTION_ID.test(id)) return;
  try {
    const target = recordFileTargetOrThrow(projectDir, questionRel(projectDir, id));
    if (existsSync(target) && !ownedByAnotherAccount(target)) {
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
