// The pin's other fixtures (tests/unit/t-persons-words-pin.test.ts): a function that only keeps the person's words
// (copies them, tests them for presence) is a place that keeps; one that never touches them is no place.
import { personsWordsText } from "../../../core/tools/aidlc-lib.ts";
import type { StoredMessage } from "../../../core/tools/aidlc-message-store.ts";

/** Copies the words onto a row's fields, when there are any. */
export function personReplyFields(message: StoredMessage): Record<string, string> {
  return message.words !== null ? { "Person Reply": personsWordsText(message.words) } : {};
}

/** Reads only the record's id and time. */
export function messageStamp(message: StoredMessage): string {
  return `${message.id} ${message.at}`;
}
