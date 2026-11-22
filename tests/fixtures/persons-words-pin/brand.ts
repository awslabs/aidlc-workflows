// The brand's reds (tests/unit/t-persons-words-pin.test.ts): the ways back to text the PersonsWords type does not
// refuse (no `as` in any of them), which the scanner must still find deciding, and an unwrap and a cast from places the lists do not name, which
// the brand check must name. Never imported at run time; scanned only.
import { personsWordsText } from "../../../core/tools/aidlc-lib.ts";
import type { StoredMessage } from "../../../core/tools/aidlc-message-store.ts";

/** A template makes the words text again. */
export function templateSaysApprove(message: StoredMessage): boolean {
  return `${message.words}` === "Approve";
}

/** As String() does. */
export function stringSaysApprove(message: StoredMessage): boolean {
  return String(message.text).startsWith("approve");
}

/** And a concatenation, which the engine's own lint allows. */
export function concatenatedSaysYes(message: StoredMessage): boolean {
  // biome-ignore lint/style/useTemplate: the concatenation is the red
  return message.text + "" === "yes";
}

/** And JSON.stringify. */
export function stringifiedSaysYes(message: StoredMessage): boolean {
  return JSON.stringify(message.words) === '"yes"';
}

/** A parameter typed `unknown` takes the brand as it is, and its body makes it text. */
function isYes(value: unknown): boolean {
  return String(value) === "yes";
}
export function handedOnSaysYes(message: StoredMessage): boolean {
  return isYes(message.words);
}

/** And a join. */
export function joinedSaysYes(message: StoredMessage): boolean {
  return [message.words].join(" ").includes("yes");
}

/** The unwrap, from a place no list allows. */
export function unwrappedSaysYes(message: StoredMessage): boolean {
  return message.words !== null && personsWordsText(message.words) === "yes";
}

/** A cast out of the brand, from a place no list names. */
export function castSaysYes(message: StoredMessage): boolean {
  return (message.text as unknown as string) === "yes";
}
