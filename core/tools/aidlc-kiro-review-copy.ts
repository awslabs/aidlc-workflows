// The per-review reviewer copy on Kiro (the KAS layout: kiro-ide).
//
// Kiro's hook payloads do not say which agent made a tool call, so the
// reviewer-scope PreToolUse hook cannot hold a per-unit reviewer to its unit
// there. What Kiro does enforce is the delegated agent's own `permissions`: an
// `fs_read` deny with an `exclude` refuses a read outside the exclude (relative,
// absolute and `..` forms alike) and leaves the denied files out of search
// results, and the agent file is read again at each dispatch (measured on Kiro
// CLI 2.31.0 and Kiro IDE 1.3.0). So the review request writes a copy of the
// installed reviewer whose rules add that deny for this review's unit, and the
// conductor dispatches the copy. The copy's name is derived from the request
// id, which is what binds it to one request.
//
// The copy opens no file of another unit, not even one the unit's design names
// as an integration point: the reviewer notes that point as a finding instead.

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type AuditShardEvent,
  attemptEventDefinitelyBefore,
  auditBlockField,
  decideFence,
  gateEventMatchesUnit,
  installedKiroLayout,
  isScopedReviewCopy,
  maximalAttemptEvents,
  readAuditShardEvents,
  recordDir,
  recordHookDrop,
  relativeRecordDir,
  resolveProjectFlag,
  reviewRequestBindingFromBlock,
  reviewRequestReplaces,
  scopedReviewCopyName,
  sortAttemptEvents,
  swarmWorkerWorktreeMeta,
  unitGateStatus,
  withAuditLock,
  writeFileAtomic,
} from "./aidlc-lib.ts";
import { resolveHarnessPath } from "./aidlc-runtime-paths.ts";

// Where the reviewer can reach the Units' folders: every intent's record, and
// a parallel batch's worktrees under .aidlc/worktrees/ (the reviewer's own
// filesystem rule reaches them). All of them are denied; only this review's
// Unit folder, in this intent's record, is opened again.
const DENIED_ROOTS = [
  "aidlc/spaces/*/intents/*/construction",
  ".aidlc/worktrees/*/aidlc/spaces/*/intents/*/construction",
];

/**
 * The copy's text: the installed reviewer file with its `name` set to the copy's
 * name, its `display_name` marked as this review's, and one rule added at the
 * end of `permissions.rules` that denies reads in every construction folder
 * (every intent's, and every batch worktree's) except this Unit's folder in
 * this intent's record. Everything else (the person's own edits included)
 * stays as installed. `record` is the intent record's path from the project
 * root (`aidlc/spaces/<space>/intents/<intent>`). Null when the record or the
 * unit cannot be written as an exact pattern, or the file has no frontmatter,
 * no `name`, or no `permissions.rules` list in the shipped shape.
 */
export function renderReviewCopy(reviewerText: string, copyName: string, record: string, unit: string): string | null {
  const plain = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const recordParts = record.split("/");
  if (!plain.test(unit) || recordParts.length !== 5 || recordParts[0] !== "aidlc" || recordParts[1] !== "spaces" ||
    recordParts[3] !== "intents" || !plain.test(recordParts[2]) || !plain.test(recordParts[4])) return null;
  const text = reviewerText.replace(/^\uFEFF/, "");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const front = lines.slice(1, end);

  const nameAt = front.findIndex((line) => /^name:/.test(line));
  if (nameAt === -1) return null;
  front[nameAt] = `name: ${copyName}`;
  const displayAt = front.findIndex((line) => /^display_name:/.test(line));
  if (displayAt !== -1) {
    // A double-quoted name takes the words inside its quotes; a plain one only
    // when it is plain words, so the result is always a quoted YAML string.
    // Any other form is left as it is.
    const value = front[displayAt].slice("display_name:".length).trim();
    const quoted = /^"(.*)"$/.exec(value);
    if (quoted) front[displayAt] = `display_name: "${quoted[1]} (this review)"`;
    else if (/^[A-Za-z0-9][^"\\#:]*$/.test(value)) front[displayAt] = `display_name: "${value} (this review)"`;
  }

  // `rules:` must be the permissions block's own key: every line between them
  // belongs to that block (indented, or blank).
  const permissionsAt = front.findIndex((line) => /^permissions:\s*$/.test(line));
  if (permissionsAt === -1) return null;
  let rulesAt = permissionsAt + 1;
  while (rulesAt < front.length && !/^ {2}rules:\s*$/.test(front[rulesAt])) {
    if (front[rulesAt].trim() !== "" && !/^ /.test(front[rulesAt])) return null;
    rulesAt++;
  }
  if (rulesAt === front.length || !/^ {4}- /.test(front[rulesAt + 1] ?? "")) return null;
  let insertAt = rulesAt + 1;
  while (insertAt < front.length && (front[insertAt].trim() === "" || /^ {4}/.test(front[insertAt]))) insertAt++;
  front.splice(
    insertAt,
    0,
    "    - capability: fs_read",
    "      effect: deny",
    "      match:",
    ...DENIED_ROOTS.map((root) => `        - "${root}/**"`),
    "      exclude:",
    `        - "${record}/construction/${unit}"`,
    `        - "${record}/construction/${unit}/**"`,
  );
  return [lines[0], ...front, ...lines.slice(end)].join(eol);
}

// The installed agents folder, refused when a link on the way would lead the
// copy's write or removal somewhere else.
function writableAgentsDir(projectDir: string): string {
  return resolveHarnessPath(["agents"], { mutable: true, projectDir });
}

/** What the review request does with the reviewer copy. */
export type ReviewCopyOutcome =
  /** Dispatch this agent: the reviewer with the review's read scope. */
  | { dispatchAgent: string }
  /** A copy was due and none could be written: this review runs
   *  without its read scope, and `notice` tells the person so in one line. */
  | { notice: string };

/**
 * Write this review's reviewer copy and say which agent the conductor
 * dispatches, or null when no copy is due and the review goes to the
 * reviewer itself: the project's Kiro tree is not the KAS layout, the review is
 * not a Unit's, it runs in a parallel batch's worktree, or the reviewer
 * read-scope check stands aside for this work. Never refuses. A copy that was
 * due but could not be written leaves
 * a line among the reviewer-scope drops doctor counts, naming the cause, and a
 * notice.
 */
export function prepareReviewCopy(
  projectDir: string,
  review: { requestId: string; reviewer: string; unit?: string },
): ReviewCopyOutcome | null {
  if (!review.unit) return null;
  // Doctor lists a drop by its reason up to the first ": ", cut short, so the
  // reason starts with a short cause and the details follow it.
  const drop = (cause: string, detail: string) =>
    recordHookDrop(
      projectDir,
      "reviewer-scope",
      `reviewer copy not written, ${cause}: ${review.reviewer} for unit ${review.unit}${detail ? `; ${detail}` : ""}`,
    );
  // Whether a copy is due here at all. A check that cannot be read
  // leaves the review as it always was, with a drop line and no notice: it is
  // not known that the person's check was on.
  try {
    if (installedKiroLayout(projectDir) !== "kas") return null;
    if (swarmWorkerWorktreeMeta(projectDir) !== null) return null;
    if (resolveProjectFlag("AIDLC_DISABLE_REVIEWER_SCOPE_HOOK", process.env, projectDir) === "1") return null;
    if (decideFence(projectDir, "reviewer-scope").decision === "stand-aside") return null;
  } catch (e) {
    drop("its conditions could not be read", e instanceof Error ? e.message : String(e));
    return null;
  }
  const skipped = (cause: string, detail = ""): ReviewCopyOutcome => {
    drop(cause, detail);
    return {
      notice:
        `This review of ${review.unit} can read other Units' files: AI-DLC could not hold the reviewer to this Unit ` +
        "this time.",
    };
  };
  const copyName = scopedReviewCopyName(review.requestId);
  if (copyName === null) return skipped("the request id names no copy", review.requestId);
  try {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(review.reviewer)) return skipped("the reviewer name is not plain");
    const record = relativeRecordDir(projectDir);
    if (record === null) return skipped("no intent record");
    const agents = writableAgentsDir(projectDir);
    const reviewerPath = join(agents, `${review.reviewer}.md`);
    if (!existsSync(reviewerPath)) return skipped("the reviewer file is missing", reviewerPath);
    const text = renderReviewCopy(
      readFileSync(reviewerPath, "utf-8"),
      copyName,
      record,
      review.unit,
    );
    if (text === null) {
      return skipped(
        "a name is not plain or the reviewer file is not in the installed shape",
        `${record}, unit ${review.unit}, ${reviewerPath}`,
      );
    }
    writeFileAtomic(join(agents, `${copyName}.md`), text);
    return { dispatchAgent: copyName };
  } catch (e) {
    return skipped("the copy could not be written", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Remove the reviewer copy of a request, if one was written. Best effort. It
 * does not ask the layout again: the name belongs to that one request, and a
 * layout read that answers differently at the verdict would leave the copy.
 */
export function removeReviewCopy(projectDir: string, requestId: string | null | undefined): void {
  const copyName = requestId ? scopedReviewCopyName(requestId) : null;
  if (copyName === null) return;
  try {
    rmSync(join(writableAgentsDir(projectDir), `${copyName}.md`), { force: true });
  } catch {
    // A copy left behind is dispatched by nobody: its request is closed.
  }
}

// Whether a copy's review is over for good, on what the record's ledger shows
// after the request's latest rows (a retry included; rows whose order is not
// known are all latest): its verdict, a request that replaces it, or the
// person approving the Unit or the whole stage, even when the Unit was opened
// again since. An approval over an unfinished review keeps the request open,
// so a verdict that comes in later is still recorded; only the copy goes,
// since nothing dispatches it again. Nothing else retires a copy: a review
// sent back (Request Changes, a jump back) keeps it until one of those is
// recorded. A request of the main workflow reads no row of an isolated stage
// run (`--single`), whose approvals are its own, and an isolated run's copy
// goes with its verdict or replacement only.
function reviewCopyRetired(projectDir: string, rows: readonly AuditShardEvent[], latest: readonly AuditShardEvent[]): boolean {
  const request = latest[0];
  const requestId = auditBlockField(request.block, "Request Id");
  const stage = auditBlockField(request.block, "Stage");
  const unit = auditBlockField(request.block, "Unit");
  if (requestId === null || stage === null || unit === null) return false;
  const binding = reviewRequestBindingFromBlock(request.block);
  const after = sortAttemptEvents(rows.filter((row) => latest.every((mine) => attemptEventDefinitelyBefore(mine, row))));
  const closed = after.some((row) =>
    (row.event === "REVIEW_COMPLETED" && auditBlockField(row.block, "Request Id") === requestId) ||
    (row.event === "REVIEW_REQUESTED" && reviewRequestReplaces(row.block, { binding })));
  if (closed) return true;
  const isolated = (row: AuditShardEvent) => auditBlockField(row.block, "Workflow")?.startsWith("single-stage:") === true;
  if (latest.some(isolated)) return false;
  const main = after.filter((row) => !isolated(row));
  // A stage gate's approval names no Unit and no checkpoint; a batch of Units
  // built side by side is approved as a checkpoint naming its Units.
  if (main.some((row) => row.event === "GATE_APPROVED" && auditBlockField(row.block, "Checkpoint") === null &&
    gateEventMatchesUnit(row.block, stage, undefined))) return true;
  // The Unit as it stood at each of its approvals since, with the rows another
  // clone's log holds for that same second (their order against it is not
  // known): a later reopen does not bring the review back.
  const notIsolated = rows.filter((row) => !isolated(row));
  return main.some((row) => {
    if (row.event !== "GATE_APPROVED" || !gateEventMatchesUnit(row.block, stage, unit)) return false;
    const upTo = sortAttemptEvents([
      ...main.filter((other) => !attemptEventDefinitelyBefore(row, other)),
      ...notIsolated.filter((other) => other.timestamp === row.timestamp && other.shard !== row.shard && !main.includes(other)),
    ]);
    return (["per-stage", "unit-end"] as const).some((scope) =>
      unitGateStatus(projectDir, stage, unit, scope, upTo) === "approved");
  });
}

/**
 * Remove the reviewer copies of reviews that are over for good
 * (reviewCopyRetired), so a review that never got its verdict does not leave
 * its copy in Kiro's agent list: run when a chat starts and at each review
 * request and verdict, on the record that chat or command works in. A copy a
 * review in another chat may still dispatch is kept: the ledger cannot tell a
 * chat that was closed from one still running. The ledger is read and the
 * copies removed under the record's audit lock, so a retry recorded meanwhile
 * (the same request, its copy written again) is read before its copy is
 * judged. Kiro (kiro-ide) only; best effort. Every copy is kept when the
 * lock is busy for more than a second, the ledger cannot be read whole, or the
 * record is not the one the engine reads for this folder (the Unit and gate
 * readers take that one).
 */
export function sweepReviewCopies(projectDir: string, record: { intent?: string; space?: string } = {}): void {
  const { intent, space } = record;
  try {
    if (installedKiroLayout(projectDir) !== "kas") return;
    const agents = writableAgentsDir(projectDir);
    // lstat, not the folder listing's file type: some mounts report none.
    const copies = readdirSync(agents)
      .filter((name) => {
        if (!name.endsWith(".md") || !isScopedReviewCopy(name)) return false;
        try {
          return lstatSync(join(agents, name)).isFile();
        } catch {
          // Gone, or being removed by another chat: not this sweep's.
          return false;
        }
      })
      .map((name) => name.slice(0, -".md".length));
    if (copies.length === 0) return;
    // Ten tries a tenth of a second apart: a chat's start does not wait on
    // another chat's long command for the lock.
    withAuditLock(projectDir, () => {
      if (recordDir(projectDir, intent, space) !== recordDir(projectDir)) return;
      const unreadable: string[] = [];
      const rows = readAuditShardEvents(projectDir, intent, space, unreadable);
      if (unreadable.length > 0) return;
      // Each copy's request rows; a name two request ids share is no one's.
      const requests = new Map<string, AuditShardEvent[] | null>();
      for (const row of rows) {
        if (row.event !== "REVIEW_REQUESTED") continue;
        const id = auditBlockField(row.block, "Request Id");
        const name = id === null ? null : scopedReviewCopyName(id);
        if (name === null) continue;
        const seen = requests.get(name);
        if (seen === undefined) requests.set(name, [row]);
        else if (seen !== null && auditBlockField(seen[0].block, "Request Id") === id) seen.push(row);
        else requests.set(name, null);
      }
      for (const copyName of copies) {
        const own = requests.get(copyName);
        if (!own) continue;
        try {
          if (reviewCopyRetired(projectDir, rows, maximalAttemptEvents(own))) rmSync(join(agents, `${copyName}.md`), { force: true });
        } catch {
          // This copy stays; the next sweep reads it again.
        }
      }
    }, intent, space, 10);
  } catch {
    // Nothing removed: the copies are AI-DLC's own gitignored files.
  }
}
