// The question record: every question AI-DLC asks carries one id on the row
// that asks it, and each turn of the person's carries the ids of the questions
// open where they replied and what the stage's questions file said then. The
// ids are the one space mintQuestionId keeps, so a stored question's id is its
// question's id. Nothing reads these records to decide anything yet; the proof
// that ties an answer to its question will live here too. The lib never imports
// this module (a load-time cycle): callers import it directly, and the audit
// writer reaches the ledger by a lazy require.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  auditBlockField,
  auditFilePath,
  planApprovalRuntimeFile,
  readActiveDirectiveMarker,
  readAuditShardEvents,
  readPlanApprovalRuntimeRecord,
  resolveInvokingSessionId,
  stateFilePath,
  writePlanApprovalRuntimeRecord,
} from "./aidlc-lib.ts";
import { visibleMarkdownLines } from "./aidlc-markdown.ts";
import { mintQuestionId } from "./aidlc-question-store.ts";

export const QUESTION_ID_FIELD = "Question Id";
// Beside the older `Question Kind` (three values readers test), never instead of it.
export const QUESTION_TYPE_FIELD = "Question Type";
export const QUESTION_CHAT_FIELD = "Question Chat";
export const QUESTION_SHOWS_FIELD = "Question Shows";
/** On QUESTION_ASKED: the sha256 of the engine's question text, so a question box answer names it. */
export const QUESTION_TEXT_FIELD = "Question Text SHA-256";
export const OPEN_QUESTIONS_FIELD = "Open Questions";
export const QUESTIONS_DIGEST_FIELD = "Questions Digest";

/** An engine question with no row of its own, asked when the engine hands it out. */
export const QUESTION_ASKED = "QUESTION_ASKED";
/** A question still open, shown in a chat it was not asked or shown in before. */
export const QUESTION_SHOWN = "QUESTION_SHOWN";

// Question Types are the words the record already uses: `gate`; a `log
// decision` checkpoint's own name (summary-confirmation, plan-approval,
// verification-command, construction-policy) or its Question Kind (answer-mode,
// learnings-note, assumption-confirmation), else `stage-question`;
// `unit-checkpoint` and `swarm-batch`; an engine ask's ask type (plan-approval
// for the code plan question); `system-install` for a go-ahead the install guard
// has the agent ask for.

// The engine's own asks other than the code plan question: one is the open
// step at a time, so a newer one, or another step, takes its place.
export const ENGINE_ASK_TYPES: ReadonlySet<string> = new Set([
  "scope-confirm", "compose-offer", "intent-pick", "unit-paused", "new-work-routing", "project-type",
  "construction-staffing", "repo-scope", "units-repos", "guard-recovery", "unit-claim",
  "legacy-plan-approval-recovery",
]);

// The questions a stage asks of its own (logged by the agent); they stay listed
// until their stage's gate is approved, since one reply may answer part of a batch.
const STAGE_OWN_TYPES: ReadonlySet<string> = new Set([
  "stage-question", "answer-mode", "learnings-note", "assumption-confirmation", "summary-confirmation",
]);

// The rows that ask a question (the ledger lists it) and the one that shows it again.
const ASKING_ROWS: ReadonlySet<string> = new Set([
  "STAGE_AWAITING_APPROVAL", "DECISION_RECORDED", "QUESTION_ASKED",
]);

/** `sha256:<hex>` over what a question shows the person, line endings normalized. */
export function questionShows(parts: ReadonlyArray<string | null | undefined>): string {
  const text = parts.map((part) => (part ?? "").replace(/\r\n?/g, "\n")).join("\n");
  return `sha256:${createHash("sha256").update(text, "utf-8").digest("hex")}`;
}

/**
 * One digest per H2 entry of a questions file (`Q3` for `## Q3. ...`, a named
 * section by its heading), over the entry as the person sees it with every
 * `[Answer]:` line blanked: an answer written in, by them or the agent, and a
 * clone's Windows line endings change nothing; an edit to the question does.
 */
export function questionEntryDigests(content: string): Record<string, string> {
  const lines = visibleMarkdownLines(content, { preserveIndentedCode: true });
  const entries: Array<{ key: string; lines: string[] }> = [];
  for (const line of lines) {
    const heading = /^ {0,3}##(?:[ \t]+|$)(.*)$/.exec(line);
    if (heading !== null) {
      const title = heading[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
      entries.push({ key: /^Q(\d+)\b/.exec(title)?.[0] ?? title, lines: [] });
    }
    const entry = entries.at(-1);
    if (entry === undefined) continue;
    entry.lines.push(/^\s*\[Answer\]:/.test(line) ? "[Answer]:" : line.trimEnd());
  }
  const digests: Record<string, string> = {};
  for (const entry of entries) {
    let key = entry.key;
    for (let n = 2; Object.hasOwn(digests, key); n++) key = `${entry.key}#${n}`;
    const body = entry.lines.join("\n").trimEnd();
    digests[key] = createHash("sha256").update(body, "utf-8").digest("hex").slice(0, 16);
  }
  return digests;
}

/** The chat a command runs in, or null where the host does not name it (Cursor, Copilot fall back to ancestry). */
export function commandChat(projectDir: string): string | null {
  try {
    return resolveInvokingSessionId(projectDir);
  } catch {
    return null;
  }
}

/** A fresh id from the one id space, never one this record already uses. */
export function newQuestionId(projectDir: string): string {
  let used: Set<string>;
  try {
    used = new Set(readAuditShardEvents(projectDir).flatMap((row) => {
      const id = auditBlockField(row.block, QUESTION_ID_FIELD);
      return id === null ? [] : [id];
    }));
  } catch {
    used = new Set();
  }
  for (;;) {
    const id = mintQuestionId(projectDir);
    if (!used.has(id)) return id;
  }
}

/** The fields an asking row carries: its new id, its type, the chat it was asked in, what it shows. */
export function askedQuestionFields(
  projectDir: string,
  ask: { type: string; shows: string; chat?: string | null; id?: string },
): Record<string, string> {
  const chat = ask.chat === undefined ? commandChat(projectDir) : ask.chat;
  return {
    [QUESTION_ID_FIELD]: ask.id ?? newQuestionId(projectDir),
    [QUESTION_TYPE_FIELD]: ask.type,
    ...(chat ? { [QUESTION_CHAT_FIELD]: chat } : {}),
    [QUESTION_SHOWS_FIELD]: ask.shows,
  };
}

/** A question on record: the row that asked it, the chats it was shown in, what it showed last. */
export interface RecordedQuestion {
  id: string;
  type: string;
  stage: string | null;
  unit: string | null;
  shows: string | null;
  chats: Set<string>;
  /** The questions file it was asked from, when it was asked from one. */
  questionsFile: string | null;
}

/** The question with this id on the record, with every chat it was asked or shown in. */
export function recordedQuestion(projectDir: string, id: string): RecordedQuestion | null {
  let found: RecordedQuestion | null = null;
  for (const row of readAuditShardEvents(projectDir)) {
    if (auditBlockField(row.block, QUESTION_ID_FIELD) !== id) continue;
    const chat = auditBlockField(row.block, QUESTION_CHAT_FIELD);
    if (found === null && ASKING_ROWS.has(row.event)) {
      found = {
        id,
        type: auditBlockField(row.block, QUESTION_TYPE_FIELD) ?? "",
        stage: auditBlockField(row.block, "Stage"),
        unit: auditBlockField(row.block, "Unit"),
        shows: auditBlockField(row.block, QUESTION_SHOWS_FIELD),
        chats: new Set(),
        questionsFile: auditBlockField(row.block, "Questions File"),
      };
    }
    if (found === null) continue;
    if (chat !== null) found.chats.add(chat);
    found.shows = auditBlockField(row.block, QUESTION_SHOWS_FIELD) ?? found.shows;
  }
  return found;
}

/**
 * The id an engine ask already has: the same ask type over the same state is
 * the same question (the open engine question's own rule), so the latest
 * engine ask on the committed record, when it is this one, keeps its id in a
 * new chat and in a clone. Null for a new question.
 */
export function engineAskQuestionId(projectDir: string, about: { type: string; stateDigest: string }): string | null {
  try {
    const rows = readAuditShardEvents(projectDir);
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row.event !== QUESTION_ASKED) continue;
      const type = auditBlockField(row.block, QUESTION_TYPE_FIELD) ?? "";
      if (!ENGINE_ASK_TYPES.has(type)) continue;
      return type === about.type && auditBlockField(row.block, "State Digest") === about.stateDigest
        ? auditBlockField(row.block, QUESTION_ID_FIELD)
        : null;
    }
  } catch {
    // A record that cannot be read asks a new question.
  }
  return null;
}

/**
 * The id of the question of this type and stage the committed record still has
 * open: its latest asking row, with no row since that answers it (the ledger's
 * own closing rules). Null when there is none, or it was answered.
 */
export function openSlotQuestionId(projectDir: string, slot: { type: string; stage: string }): string | null {
  try {
    const rows = readAuditShardEvents(projectDir);
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (!ASKING_ROWS.has(row.event) || auditBlockField(row.block, QUESTION_TYPE_FIELD) !== slot.type) continue;
      if (auditBlockField(row.block, "Stage") !== slot.stage) continue;
      const id = auditBlockField(row.block, QUESTION_ID_FIELD);
      if (id === null) return null;
      const entry: LedgerEntry = {
        id, type: slot.type, stage: slot.stage, unit: auditBlockField(row.block, "Unit"), askedAt: row.timestamp, shownIn: {},
      };
      const closed = rows.slice(index + 1).some((later) =>
        answered(later.event, blockFields(later.block))?.(entry) === true);
      return closed ? null : id;
    }
  } catch {
    // Unknown: a new question.
  }
  return null;
}

function blockFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of ["Stage", "Unit", "Checkpoint"]) {
    const value = auditBlockField(block, name);
    if (value !== null) fields[name] = value;
  }
  return fields;
}

/** The latest asking row of this type for a stage and Unit, with its id. */
export function latestAskedQuestion(
  projectDir: string,
  match: { event: string; type: string; stage: string; unit?: string | null },
): { id: string; shows: string | null } | null {
  try {
    const rows = readAuditShardEvents(projectDir);
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row.event !== match.event || auditBlockField(row.block, QUESTION_TYPE_FIELD) !== match.type) continue;
      if (auditBlockField(row.block, "Stage") !== match.stage) continue;
      if (match.unit !== undefined && (auditBlockField(row.block, "Unit") ?? null) !== match.unit) continue;
      const id = auditBlockField(row.block, QUESTION_ID_FIELD);
      if (id !== null) return { id, shows: auditBlockField(row.block, QUESTION_SHOWS_FIELD) };
    }
  } catch {
    // Unknown: no id to hand on.
  }
  return null;
}

/**
 * The fields of a QUESTION_SHOWN row when the question is shown in a chat it
 * was neither asked nor shown in, or shows something else than it last did
 * (its plans edited while it waits), with what it shows now; null when that
 * chat already saw it as it is, or no chat can be named.
 */
export function shownAgainFields(
  projectDir: string,
  id: string,
  chat: string | null,
  shows?: string | null,
): Record<string, string> | null {
  const question = recordedQuestion(projectDir, id);
  if (question === null) return null;
  const changed = shows !== undefined && shows !== null && shows !== question.shows;
  if (!changed && (!chat || question.chats.has(chat))) return null;
  const now = shows ?? question.shows;
  return {
    [QUESTION_ID_FIELD]: id,
    [QUESTION_TYPE_FIELD]: question.type,
    ...(chat ? { [QUESTION_CHAT_FIELD]: chat } : {}),
    ...(now ? { [QUESTION_SHOWS_FIELD]: now } : {}),
    ...(question.stage !== null ? { Stage: question.stage } : {}),
    ...(question.unit !== null ? { Unit: question.unit } : {}),
    ...(question.questionsFile !== null ? { "Questions File": question.questionsFile } : {}),
  };
}

// --- The ledger: the questions open in each chat, for the human-turn hook ---
//
// One small runtime file per record, beside open-engine-question.json, written
// only from the audit writer as rows land (under that record's lock), so the
// hook stamps a turn from one file read, never an audit scan. An entry leaves
// when the row that answers it lands, when a newer question takes its place,
// or past the cap; an engine question counts only while the active directive
// is still that question (the open engine question's rule). What the record
// cannot say here (a jump, a park) leaves it listed: a question listed that is
// no longer open is read as closed from the record; one left out of a turn
// could never be bound to it.

const LEDGER_CAP = 64;

interface LedgerEntry {
  id: string;
  type: string;
  stage: string | null;
  unit: string | null;
  askedAt: string;
  /** The chats it was shown in, with when; "file" for one in a questions file, "" for a chat the command could not name. */
  shownIn: Record<string, string>;
  /** sha256 of the question's exact text, so a question box answer names it. */
  text?: string;
  /** An engine question's state digest: it is open while the active directive asks it over that state. */
  stateDigest?: string;
}

interface Ledger {
  version: 1;
  questions: LedgerEntry[];
}

function recordKey(projectDir: string, auditPath: string): string {
  return relative(projectDir, dirname(auditPath)).replaceAll("\\", "/");
}

function recordFile(projectDir: string, auditPath: string, name: string): string {
  const key = createHash("sha256").update(recordKey(projectDir, auditPath), "utf-8").digest("hex").slice(0, 16);
  return planApprovalRuntimeFile(projectDir, `${name}-${key}.json`);
}

function ledgerPath(projectDir: string, auditPath: string): string {
  return recordFile(projectDir, auditPath, "open-questions");
}

// The questions file of the stage the engine handed out last, or that a
// question was asked or shown again from, from the project: its own file, no lock.
function questionsFilePath(projectDir: string, auditPath = auditFilePath(projectDir)): string {
  return recordFile(projectDir, auditPath, "stage-questions");
}

function writeQuestionsFile(projectDir: string, path: string, file: string): void {
  if (readRecordFile<{ file?: string }>(path, "Stage questions file")?.file === file) return;
  writePlanApprovalRuntimeRecord(projectDir, path, `${JSON.stringify({ version: 1, file })}\n`);
}

// A record not written yet is read as empty without waiting on it: the runtime
// reader waits out an atomic replace in progress, which a missing file costs
// on every turn.
function readRecordFile<T>(path: string, what: string): T | null {
  return existsSync(path) ? readPlanApprovalRuntimeRecord<T>(path, what) : null;
}

function readLedger(path: string): Ledger {
  const ledger = readRecordFile<Ledger>(path, "Open questions");
  return ledger?.version === 1 && Array.isArray(ledger.questions) ? ledger : { version: 1, questions: [] };
}

function writeLedger(projectDir: string, path: string, ledger: Ledger): void {
  const questions = ledger.questions.slice(-LEDGER_CAP);
  writePlanApprovalRuntimeRecord(projectDir, path, `${JSON.stringify({ ...ledger, questions })}\n`);
}

export function questionTextSha(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n").trim(), "utf-8").digest("hex");
}

// The question types a new ask of the same stage and Unit takes the place of:
// one gate, one plan question, one checkpoint of each kind, one engine ask.
function replaces(entry: LedgerEntry, type: string, stage: string | null, unit: string | null): boolean {
  if (ENGINE_ASK_TYPES.has(type) && ENGINE_ASK_TYPES.has(entry.type)) return true;
  if (STAGE_OWN_TYPES.has(type) && type !== "summary-confirmation") return false;
  return entry.type === type && entry.stage === stage && entry.unit === unit;
}

// The Question Type each Checkpoint name on today's rows belongs to (the ask
// rows and the answer rows name some of them differently).
const CHECKPOINT_TYPES: Readonly<Record<string, string>> = {
  "Consolidated Summary Confirmation": "summary-confirmation",
  "Construction Verification Command": "verification-command",
  "Construction Policy": "construction-policy",
  "Code Generation Plan Approval": "plan-approval",
  "plan-approval": "plan-approval",
  "Construction Unit Approval": "unit-checkpoint",
  "walking-skeleton": "unit-checkpoint",
  "construction-unit": "unit-checkpoint",
  "Swarm Batch Approval": "swarm-batch",
  "swarm-batch": "swarm-batch",
};

// What an answering row closes, by today's own fields on that row.
function answered(event: string, fields: Record<string, string>): ((entry: LedgerEntry) => boolean) | null {
  const stage = fields.Stage ?? null;
  const unit = fields.Unit ?? null;
  const checkpoint = fields.Checkpoint;
  const ofStage = (entry: LedgerEntry): boolean => stage === null || entry.stage === stage;
  const typed = (types: string[]) => (entry: LedgerEntry): boolean => types.includes(entry.type) && ofStage(entry);
  switch (event) {
    case "GATE_APPROVED":
    case "GATE_REJECTED": {
      if (checkpoint !== undefined) {
        const type = CHECKPOINT_TYPES[checkpoint];
        if (type === undefined) return null;
        return (entry) => entry.type === type && (unit === null || entry.unit === unit || type === "swarm-batch");
      }
      const approved = event === "GATE_APPROVED";
      return (entry) => ofStage(entry) && (entry.unit === unit || unit === null) &&
        (entry.type === "gate" || (approved && (STAGE_OWN_TYPES.has(entry.type) || entry.type === "plan-approval")));
    }
    case "PLAN_APPROVAL_RECORDED":
    case "PLAN_APPROVAL_SKIPPED":
    case "PLAN_APPROVAL_OVERRIDDEN":
      return typed(["plan-approval"]);
    case "VERIFICATION_COMMAND_RECORDED":
      return typed(["verification-command"]);
    case "CONSTRUCTION_POLICY_RECORDED":
      return typed(["construction-policy"]);
    case "SUMMARY_CONFIRMATION_RECORDED":
      return typed(["summary-confirmation"]);
    case "QUESTION_ANSWERED": {
      const type = checkpoint === undefined ? undefined : CHECKPOINT_TYPES[checkpoint];
      return type === undefined ? null : typed([type]);
    }
    case "SYSTEM_INSTALL_ALLOWED":
      return (entry) => entry.type === "system-install";
    case "REQUEST_ROUTED":
      return (entry) => ENGINE_ASK_TYPES.has(entry.type);
    default:
      return null;
  }
}

/**
 * The audit writer hands each row it appended here, under that record's lock:
 * an asking row lists its question, QUESTION_SHOWN the chat it was shown in, an
 * answering row closes the questions it answers. Never throws.
 */
export function noteQuestionRow(projectDir: string, auditPath: string, event: string, fields: Record<string, string>): void {
  try {
    const id = ASKING_ROWS.has(event) || event === QUESTION_SHOWN ? fields[QUESTION_ID_FIELD] : undefined;
    const close = answered(event, fields);
    if (id === undefined && close === null) return;
    const path = ledgerPath(projectDir, auditPath);
    const ledger = readLedger(path);
    const before = JSON.stringify(ledger.questions);
    const at = new Date().toISOString();
    let questions = close === null ? ledger.questions : ledger.questions.filter((entry) => !close(entry));
    if (id !== undefined) {
      const chat = fields[QUESTION_CHAT_FIELD] ?? "";
      const shownIn: Record<string, string> = { [chat]: at, ...(fields["Questions File"] ? { file: at } : {}) };
      const listed = questions.find((entry) => entry.id === id);
      if (event === QUESTION_SHOWN && listed !== undefined) {
        questions = questions.map((entry) => entry === listed ? { ...entry, shownIn: { ...entry.shownIn, ...shownIn } } : entry);
      } else if (listed === undefined || event !== QUESTION_SHOWN) {
        const type = fields[QUESTION_TYPE_FIELD] ?? "";
        const stage = fields.Stage ?? null;
        const unit = fields.Unit ?? null;
        questions = questions.filter((entry) => entry.id !== id && !replaces(entry, type, stage, unit));
        // The words a question box shows it in: the engine's question, or the agent's own logged question.
        const text = fields[QUESTION_TEXT_FIELD] ??
          (event === "DECISION_RECORDED" && fields.Decision ? questionTextSha(fields.Decision) : undefined);
        const stateDigest = fields["State Digest"];
        questions.push({
          id, type, stage, unit, askedAt: at, shownIn, ...(text ? { text } : {}), ...(stateDigest ? { stateDigest } : {}),
        });
      }
    }
    // Written only when it changed: most rows leave it as it is.
    if (JSON.stringify(questions) !== before) writeLedger(projectDir, path, { ...ledger, questions });
    if (id !== undefined && fields["Questions File"]) {
      writeQuestionsFile(projectDir, questionsFilePath(projectDir, auditPath), fields["Questions File"]);
    }
  } catch {
    // The ledger is bookkeeping for the hook's stamp; the row stands without it.
  }
}

/** The engine handed out a stage's step: its questions file is the one a turn's digest reads. */
export function noteQuestionsFile(projectDir: string, file: string): void {
  try {
    writeQuestionsFile(projectDir, questionsFilePath(projectDir), file);
  } catch {
    // Bookkeeping only.
  }
}

// The engine question that is the open step now, as its active directive names it.
function openEngineAsk(projectDir: string): { type: string; stateDigest: string } | null {
  try {
    const marker = readActiveDirectiveMarker(projectDir, readFileSync(stateFilePath(projectDir), "utf-8"));
    return marker?.version === 2 && marker.kind === "ask" && typeof marker.ask_type === "string"
      ? { type: marker.ask_type, stateDigest: marker.state_sha256 }
      : null;
  } catch {
    return null;
  }
}

// The questions listed for this record that are open in `chat`: shown there, in
// the questions file, or by a command whose chat was unknown; an engine
// question only while it is the open step.
function openIn(projectDir: string, chat: string): LedgerEntry[] {
  const ledger = readLedger(ledgerPath(projectDir, auditFilePath(projectDir)));
  const engineAsk = ledger.questions.some((entry) => ENGINE_ASK_TYPES.has(entry.type)) ? openEngineAsk(projectDir) : null;
  return ledger.questions.filter((entry) =>
    ((chat !== "" && Object.hasOwn(entry.shownIn, chat)) || Object.hasOwn(entry.shownIn, "file") ||
      Object.hasOwn(entry.shownIn, "")) &&
    (!ENGINE_ASK_TYPES.has(entry.type) ||
      (engineAsk !== null && engineAsk.type === entry.type && engineAsk.stateDigest === entry.stateDigest)));
}

/**
 * What the human-turn hook stamps on a turn in `chat`: the ids open there (a
 * question shown in this chat, in the questions file, or by a command whose
 * chat was unknown) and the digest of each entry of the stage's questions file.
 * Reads one small file and that questions file; never the audit.
 */
export function turnQuestionFields(projectDir: string, chat: string): Record<string, string> {
  try {
    const open = openIn(projectDir, chat).map((entry) => entry.id);
    const fields: Record<string, string> = open.length > 0 ? { [OPEN_QUESTIONS_FIELD]: open.join(", ") } : {};
    const file = readRecordFile<{ file?: unknown }>(questionsFilePath(projectDir), "Stage questions file")?.file;
    if (typeof file === "string" && file !== "") {
      const path = join(projectDir, file);
      if (existsSync(path)) {
        const entries = questionEntryDigests(readFileSync(path, "utf-8"));
        if (Object.keys(entries).length > 0) fields[QUESTIONS_DIGEST_FIELD] = JSON.stringify({ file, entries });
      }
    }
    return fields;
  } catch {
    return {};
  }
}

/** The id of the open question shown in `chat` whose exact text a question box carried, else null. */
export function boxQuestionId(projectDir: string, chat: string, question: string): string | null {
  try {
    const sha = questionTextSha(question);
    return openIn(projectDir, chat).findLast((entry) => entry.text === sha)?.id ?? null;
  } catch {
    return null;
  }
}
