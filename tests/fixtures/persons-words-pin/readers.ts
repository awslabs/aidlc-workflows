// The pin's reds (tests/unit/t-persons-words-pin.test.ts): each exported function here reads the person's words to
// decide something, in one of the shapes a reader has taken before, and the scanner must find it as a place that
// decides. Never imported at run time; scanned only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField, gateWordsSinceUnitReview, personsGateReply, readProtectedResponse, sessionsDir,
} from "../../../core/tools/aidlc-lib.ts";
import { listMessages, type StoredMessage } from "../../../core/tools/aidlc-message-store.ts";

/** The words compared to a label. */
export function approvedByWords(message: StoredMessage): boolean {
  // @ts-expect-error PersonsWords is no string: the brand refuses this read
  return message.words === "Approve";
}

/** Through a local, after normalising, as the legacy nonce match normalises. */
export function approvedAfterNormalising(message: StoredMessage): boolean {
  // @ts-expect-error PersonsWords is no string: the brand refuses this read
  const said = message.text.trim().toLowerCase().replace(/\s*\(recommended\)\s*$/, "");
  return said.startsWith("approve");
}

/** A destructured field, searched. */
export function saidYes(message: StoredMessage): boolean {
  const { words } = message;
  // @ts-expect-error PersonsWords is no string: the brand refuses this read
  return words?.includes("yes") === true;
}

/** Handed to a helper that decides: both are places. */
export function looksLikeYes(text: string): boolean {
  return /^y(?:es)?$/i.test(text.trim());
}
export function latestSaidYes(projectDir: string): boolean {
  const latest = listMessages(projectDir).at(-1);
  // @ts-expect-error PersonsWords is no string: the brand refuses this read
  return latest !== undefined && looksLikeYes(latest.words ?? "");
}

/** A field the engine hands the words out in (personsGateReply().words), decoded as a number. */
export function gatePickNumber(projectDir: string, stage: string): number {
  return Number(personsGateReply(projectDir, null, stage).words);
}

/** The gate-words record, through the reader that hands its words out. */
export function reviewWordsApprove(projectDir: string, session: string, unit: string): boolean {
  return gateWordsSinceUnitReview(projectDir, session, unit, ["code-generation"])?.some((reply) => reply.words === "Approve") === true;
}

/** A field the engine hands the words out in (personsGateReply().words), in a switch. */
export function latestTurnChoice(projectDir: string): string {
  switch (personsGateReply(projectDir, null, "requirements-analysis").words) {
    case "1": return "Approve";
    default: return "none";
  }
}

/** The copy the protected response keeps. */
export function protectedSaidApprove(projectDir: string, session: string): boolean {
  return readProtectedResponse(projectDir, session)?.words === "Approve";
}

/** An audit row's Person Reply, read back from the record by its field name. */
export function approvalReplyWasApprove(block: string): boolean {
  return auditBlockField(block, "Event") === "GATE_APPROVED" && auditBlockField(block, "Person Reply") === "Approve";
}

/** A digest of their text compared to one kept from their text. */
export function sameReplyAsBefore(message: StoredMessage, kept: StoredMessage): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  // @ts-expect-error PersonsWords is no string: the brand refuses this read
  return digest(message.text) === digest(kept.text);
}

// Where the message records live: a reader that names it parses a record.
function messageRel(projectDir: string, id: string): string {
  return join(sessionsDir(projectDir), "messages", `${id}.json`);
}
/** The store's file parsed by hand, so no type says what it holds. */
export function storeFileSaysApprove(projectDir: string, id: string): boolean {
  const raw = JSON.parse(readFileSync(messageRel(projectDir, id), "utf-8")) as { words?: unknown };
  return raw.words === "Approve";
}
