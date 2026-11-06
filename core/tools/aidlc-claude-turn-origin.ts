// Who started a Claude Code turn, decided once Claude Code's own row for it is
// on the transcript (#3541).
//
// Claude Code hands its prompt hook the same keys for a turn it starts itself
// (a scheduled wake-up: a /loop tick, a CronCreate task, the loop it arms on
// its own) as for a message the person typed, and writes the turn's own row,
// the one that says who started it (`turnOrigin`), only after the hook returns
// (measured on 2.1.278 and 2.1.318). The row is there by the turn's first tool
// call or Stop: Claude Code writes it about 100 ms after the prompt, and every
// later step needs a model answer first. So the hook records such a turn as the
// person's, as every turn is recorded where nothing says otherwise, and keeps
// Claude Code's key for it here; settleClaudeTurns reads the row at the start of
// the next engine command or hook, before anything uses the turn, and when
// claudeTranscriptOrigin (aidlc-lib.ts, the one decider) says the host started
// it, takes the turn back: one HOST_TURN naming its Message Id after the
// HUMAN_TURN (readers skip that HUMAN_TURN: withdrawnTurnPositions in
// aidlc-record-core.ts), the message record removed, and what the hook kept as
// the turn's reply withdrawn through each record's own writer. Before any work
// exists, or in a chat outside it, the message is all the hook kept, and only
// it goes (the plan question for new work reads it: noReplySince). Nothing waits;
// the prompt is only the key to its own row. Any doubt leaves the turn the
// person's, as today: no row, no transcript, a key the store's retention
// dropped, a failure here.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  auditBlockField,
  auditFilePath,
  claudeTranscriptOrigin,
  enterHookWorkflow,
  guardRecoveryTextSha256,
  personsWordsText,
  readRegularFileNoFollowOrThrow,
  removeRecordFileNoFollow,
  transactActiveDirective,
  withAuditLock,
  withdrawProtectedReplyWords,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";
import { refuseEngineObserverWrite } from "./aidlc-locks.ts";
import { forgetMessage, isMessageId, readMessage } from "./aidlc-message-store.ts";
import { CLAUDE_TURNS_PENDING_DIR } from "./aidlc-claude-turn-pending.ts";
import { auditShardBlocks } from "./aidlc-record-core.ts";

/** A turn the hook kept as the person's by default (its message), with Claude Code's key for it. */
export interface PendingClaudeTurn {
  message: string;
  transcript: string;
  promptId: string;
  /** Its HUMAN_TURN is on the work's record, for a HOST_TURN to take back. */
  onRecord?: true;
}

// One small file per chat, written under the audit lock of the work that chat
// acts on (the lock its HUMAN_TURN was written under, the space's own before
// any work exists), so no two writers race.
const PENDING_MAX = 200;
const PENDING_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_TAIL_BYTES = 1 << 20;
// The message store keeps a day (MESSAGE_RETENTION_MS); a key older than that decides nothing more.
const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const CHAT_FILE = /^[A-Za-z0-9._-]{1,128}$/;

function pendingDir(projectDir: string): string {
  return join(projectDir, CLAUDE_TURNS_PENDING_DIR);
}

function pendingRel(projectDir: string, session: string): string {
  return relative(projectDir, join(pendingDir(projectDir), `${session}.json`));
}

function isPending(value: unknown): value is PendingClaudeTurn {
  const entry = value as Partial<PendingClaudeTurn> | null;
  return entry !== null && typeof entry === "object" && typeof entry.message === "string" &&
    isMessageId(entry.message) && typeof entry.transcript === "string" && entry.transcript.endsWith(".jsonl") &&
    typeof entry.promptId === "string" && entry.promptId.length > 0 &&
    (entry.onRecord === undefined || entry.onRecord === true);
}

function readPending(projectDir: string, session: string): PendingClaudeTurn[] {
  try {
    const raw = JSON.parse(
      readRegularFileNoFollowOrThrow(join(projectDir, pendingRel(projectDir, session)), "pending turns", PENDING_MAX_BYTES)
        .toString("utf-8"),
    ) as unknown;
    return Array.isArray(raw) ? raw.filter(isPending) : [];
  } catch {
    return [];
  }
}

function writePending(projectDir: string, session: string, entries: readonly PendingClaudeTurn[]): void {
  if (entries.length === 0) removeRecordFileNoFollow(projectDir, pendingRel(projectDir, session));
  else writeRecordFileNoFollow(projectDir, pendingRel(projectDir, session), `${JSON.stringify(entries.slice(-PENDING_MAX))}\n`);
}

/**
 * Claude Code's key for a prompt the hook recorded as the person's by default:
 * the transcript its hook named and the prompt's id. Null for any other shape.
 */
export function claudeTurnKey(transcriptPath: unknown, promptId: unknown): { transcript: string; promptId: string } | null {
  if (typeof transcriptPath !== "string" || !transcriptPath.endsWith(".jsonl")) return null;
  if (typeof promptId !== "string" || !promptId.trim()) return null;
  return { transcript: transcriptPath, promptId: promptId.trim() };
}

/**
 * Keep a turn of `session` for settleClaudeTurns. The caller holds the audit
 * lock of the work this chat acts on (the space's own before any work exists).
 */
export function noteClaudeTurnPending(projectDir: string, session: string, entry: PendingClaudeTurn): void {
  if (!CHAT_FILE.test(session)) return;
  writePending(projectDir, session, [...readPending(projectDir, session).filter((kept) => kept.message !== entry.message), entry]);
}

// The rows of a Claude Code transcript's last megabyte, from its first whole line.
function transcriptRows(path: string): Array<Record<string, unknown>> | null {
  let text: string;
  try {
    const buffer = readFileSync(path);
    text = buffer.subarray(Math.max(0, buffer.length - TRANSCRIPT_TAIL_BYTES)).toString("utf-8");
    if (buffer.length > TRANSCRIPT_TAIL_BYTES) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return null;
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (row !== null && typeof row === "object") rows.push(row as Record<string, unknown>);
    } catch {
      // A line still being written, or not a row.
    }
  }
  return rows;
}

type Verdict = { kind: "host"; reason: string } | { kind: "person" } | { kind: "pending" };

// What Claude Code's own record says of the turn. Its prompt id's rows are not
// written yet: still to come, or, once a later prompt's rows are, never. They
// are there: the decider reads the turn's own row by them; a message typed
// into a running turn rides that turn's id with other text, and a row with
// neither mark (the desktop app's `sdk`) decides nothing, so both stay theirs.
function verdictOf(entry: PendingClaudeTurn, prompt: string, sentAt: number): Verdict {
  const rows = transcriptRows(entry.transcript);
  if (rows === null) return { kind: "pending" };
  const user = rows.filter((row) => row.type === "user" && typeof row.promptId === "string");
  if (!user.some((row) => row.promptId === entry.promptId)) {
    const later = user.some((row) => typeof row.timestamp === "string" && Date.parse(row.timestamp) > sentAt);
    return later ? { kind: "person" } : { kind: "pending" };
  }
  const origin = claudeTranscriptOrigin(entry.transcript, entry.promptId, prompt);
  return origin?.kind === "host" ? { kind: "host", reason: origin.reason } : { kind: "person" };
}

// Whether the record already holds the HOST_TURN that takes this message's turn back.
function alreadyTakenBack(projectDir: string, message: string): boolean {
  try {
    return auditShardBlocks(readFileSync(auditFilePath(projectDir), "utf-8")).some((block) =>
      auditBlockField(block, "Event") === "HOST_TURN" && auditBlockField(block, "Message Id") === message);
  } catch {
    return false;
  }
}

/**
 * Decide every pending Claude Code turn whose own row is on the transcript now.
 * Run at the start of each engine entry, before anything reads a turn.
 * Fail-open: any failure leaves the turns as they are, the person's.
 */
export function settleClaudeTurns(projectDir: string): void {
  let chats: string[];
  try {
    chats = readdirSync(pendingDir(projectDir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((name) => CHAT_FILE.test(name));
  } catch {
    return; // Nothing was ever pending here.
  }
  // A chat's file goes once nothing of it is pending, so the common path costs one folder read.
  for (const chat of chats) {
    try {
      refuseEngineObserverWrite("settleClaudeTurns");
      // The record that chat's turns were written to, pinned as the hook pinned it.
      const pinned = enterHookWorkflow(projectDir, chat);
      try {
        const takenBack = withAuditLock(projectDir, () => {
          const left: PendingClaudeTurn[] = [];
          const hosts: Array<{ id: string; text: string }> = [];
          for (const entry of readPending(projectDir, chat)) {
            const message = readMessage(projectDir, entry.message);
            // Gone with the store's retention, or older than it: nothing left to decide.
            if (message === null || Date.now() - Date.parse(message.at) > PENDING_RETENTION_MS) continue;
            // The prompt as the hook got it is only the key to its own row. The
            // store cuts it at MESSAGE_TEXT_MAX_CHARS, so a longer wake-up never
            // matches its row and stays the person's, as every turn was.
            const prompt = personsWordsText(message.text);
            const verdict = verdictOf(entry, prompt, Date.parse(message.at));
            if (verdict.kind === "person") continue;
            // Pending, or taken back with its kept replies still to withdraw:
            // either way the entry stays until that is done.
            left.push(entry);
            if (verdict.kind === "pending") continue;
            if (entry.onRecord === true && !alreadyTakenBack(projectDir, entry.message)) {
              appendAuditEntryUnlocked("HOST_TURN", {
                Session: chat,
                Origin: "host",
                Reason: verdict.reason,
                Source: "record",
                "Message Id": entry.message,
              }, projectDir);
            }
            hosts.push({ id: entry.message, text: prompt });
          }
          writePending(projectDir, chat, left);
          return hosts;
        });
        // What the hook kept for the turn as the person's reply goes too,
        // through each record's own writer (as words routed to new work do),
        // and only then the message and its entry: a withdrawal that fails
        // is tried again on the next run.
        const done = new Set<string>();
        for (const { id, text } of takenBack) {
          if (!withdrawKeptReplies(projectDir, id, text)) continue;
          forgetMessage(projectDir, id);
          done.add(id);
        }
        if (done.size > 0) {
          withAuditLock(projectDir, () =>
            writePending(projectDir, chat, readPending(projectDir, chat).filter((entry) => !done.has(entry.message))));
        }
      } finally {
        pinned.restore();
      }
    } catch {
      // This chat's turns stay as they are: the person's, or taken back with
      // their replies withdrawn on a later run.
    }
  }
}

// Each record's own withdrawal, each tried even when another fails. True when all ran.
function withdrawKeptReplies(projectDir: string, id: string, text: string): boolean {
  const steps: Array<() => void> = [
    () => withdrawProtectedReplyWords(projectDir, { messageId: id }),
    // Typed by hand: a type import of the plan question module takes the tests' typecheck past its heap.
    () => (require("./aidlc-plan-approval-ask.ts") as {
      withdrawPlanApprovalReplies(projectDir: string, which: { messageId: string }): void;
    }).withdrawPlanApprovalReplies(projectDir, { messageId: id }),
    () => withdrawGuardRecoveryReply(projectDir, text),
  ];
  let all = true;
  for (const step of steps) {
    try {
      step();
    } catch {
      all = false;
    }
  }
  return all;
}

// The engine's guard-recovery question keeps the reply to it by the digest of
// its words (consumeSharedDirectiveAsk in aidlc-lib.ts). A reply that was a
// taken-back turn's goes, and the question stands as it was issued: the remedy
// is recorded on the person's own reply when it comes.
function withdrawGuardRecoveryReply(projectDir: string, text: string): void {
  const sha = guardRecoveryTextSha256(text);
  if (sha === null) return;
  transactActiveDirective(projectDir, (marker) =>
    marker?.guard_recovery_response?.selection_sha256 !== sha
      ? { marker, result: undefined, preserve: true }
      : {
        marker: { ...marker, revision: (marker.revision ?? 0) + 1, delivery: "issued", guard_recovery_response: undefined },
        result: undefined,
      });
}

