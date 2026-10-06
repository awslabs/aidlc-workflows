// The deterministic part of a person's reply to any question the engine asks.
// The person drives: the conductor reads what they said, in context, and
// records the choice they made; the engine keeps their exact words and never
// reads meaning into them (tools for determinism, the model for knowledge, the
// human for judgement). What stays here is exact: host-made cancellation text
// that is not a person's answer, the "(Recommended)" label decoration, how a
// reply is shown in a message, and the labels each question offers.
//
// This module is standalone (no aidlc-lib import) so aidlc-lib can re-export
// the primitives below.

// A cancelled / auto-resolved structured-question widget is NOT a human
// answer. Harnesses that auto-complete a dismissed question hand the conductor
// a completed-looking object whose answer text is cancellation boilerplate
// ("Cancelled", "user dismissed", a timeout marker). Logging that as
// QUESTION_ANSWERED or passing it as an approval choice would launder a
// non-decision into human authority AND consume the turn's HUMAN_TURN. The
// vocabulary is deliberately tight (cancellation/dismissal/timeout semantics
// only): a substantive answer that merely CONTAINS these words ("cancel the
// standing order") does not match, because the whole trimmed string must be
// the cancellation phrase.
const NON_ANSWER_RE =
  /^(?:cancel(?:led|ed)?|cancellation|dismiss(?:ed)?|abort(?:ed)?|timed?[ -]?out|timeout|no (?:answer|response)|(?:user|question) (?:cancel(?:led|ed)|dismissed))[.!]?$/i;
export function isNonAnswer(text: string | undefined | null): boolean {
  const t = (text ?? "").trim();
  return t.length === 0 || NON_ANSWER_RE.test(t);
}

// Every harness question-rendering guide tells the conductor to append
// "(Recommended)" to the recommended option's label, and the picker returns the
// decorated label. Stage gates and Plan Approval remove the one trailing
// decorator before matching offered labels (case-insensitive, surrounding
// whitespace tolerated). Nothing else about the text changes.
const RECOMMENDED_DECORATOR_RE = /\s*\(recommended\)\s*$/i;
export function stripRecommendedDecorator(text: string): string {
  return text.replace(RECOMMENDED_DECORATOR_RE, "").trim();
}

const RECEIVED_REPLY_DISPLAY_LIMIT = 120;
export function formatReceivedReply(text: string | undefined | null): string {
  const normalized = (text ?? "").trim().replace(/\s+/g, " ") || "(empty)";
  const display =
    normalized.length <= RECEIVED_REPLY_DISPLAY_LIMIT
      ? normalized
      : `${normalized.slice(0, RECEIVED_REPLY_DISPLAY_LIMIT - 3)}...`;
  return JSON.stringify(display);
}

// --- Exact picks ---------------------------------------------------------------
//
// A reply that is nothing but one offered option, by its number ("2"), its
// letter ("b"), or its label in any case ("approve plan"), is an exact pick:
// syntax, not meaning, so a tool may record it straight away. Surrounding quotes,
// markdown emphasis, one "(Recommended)", an option prefix before the label
// ("1. Approve"), and trailing punctuation are allowed; nothing else is. Any
// other reply is the conductor's to read. Returns the option's index, or null.
export function exactOptionPick(text: string | undefined | null, labels: readonly string[]): number | null {
  const clean = (value: string): string => stripRecommendedDecorator(
    value.trim().replace(/^[`*_"'\s]+|[`*_"'\s]+$/g, ""),
  ).replace(/[\s.!]+$/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const reply = clean(text ?? "");
  if (!reply || labels.length === 0) return null;
  const index = (position: number): number | null => position >= 0 && position < labels.length ? position : null;
  const number = /^(?:option\s+)?[([#]?\s*(\d{1,2})\s*[)\]]?$/.exec(reply);
  if (number) return index(Number(number[1]) - 1);
  const letter = /^(?:option\s+)?[([]?([a-z])[)\]]?$/.exec(reply);
  if (letter) return index(letter[1].charCodeAt(0) - 97);
  const unprefixed = reply.replace(/^(?:(?:\d{1,2}|[a-z])[.):]\s+)/, "");
  const named = labels.findIndex((label) => clean(label) === unprefixed);
  // Two options with the same label: the words pick neither.
  if (named < 0 || labels.findLastIndex((label) => clean(label) === unprefixed) !== named) return null;
  // A prefix must name the same option as the label after it.
  const prefix = /^(\d{1,2}|[a-z])[.):]\s+/.exec(reply)?.[1];
  if (prefix !== undefined) {
    const prefixed = /^\d/.test(prefix) ? Number(prefix) - 1 : prefix.charCodeAt(0) - 97;
    if (prefixed !== named) return null;
  }
  return named;
}

// --- The questions the engine asks -------------------------------------------

export const APPROVAL_GATE_CHOICES = ["Approve", "Request Changes"] as const;

// A picker asks this question when it offers only its choices, each once, and
// both its approve and its change choice (the first two; "(Recommended)"
// stripped, any case, any order). Leaving out a further choice ("I'll edit the
// files") still asks it; a lone "Approve" or a label shown twice does not.
export function pickerOffersChoices(options: readonly string[], choices: readonly string[]): boolean {
  const offered = options.map((option) => stripRecommendedDecorator(option).trim().toLowerCase());
  const own = choices.map((choice) => choice.toLowerCase());
  return new Set(offered).size === offered.length &&
    offered.every((label) => own.includes(label)) &&
    own.slice(0, 2).every((label) => offered.includes(label));
}

// A picked label is one of these choices ("(Recommended)" stripped, any case).
export function isOneOfChoices(label: string, choices: readonly string[]): boolean {
  const picked = stripRecommendedDecorator(label).trim().toLowerCase();
  return choices.some((choice) => choice.toLowerCase() === picked);
}

// A prompt that is a command to AIDLC: its slash or Codex entry
// (`/aidlc ...`, `/aidlc-<runner> ...`, `$aidlc ...`). Other text that starts
// with a slash ("/api/users returns 500") is the person's own words.
export function isAidlcCommandPrompt(prompt: string): boolean {
  return /^[/$]aidlc(?:[-\s]|$)/i.test(prompt.trim());
}

// What the person typed after a plain `/aidlc` or `$aidlc` entry; null for any
// other prompt, a `/aidlc-<runner>` entry included. Whether those words are a
// command or a reply is the engine's reading of them (nextArgsAreOnlyWords).
export function aidlcEntryWords(prompt: string): string | null {
  const text = prompt.trim();
  const entry = /^[/$]aidlc(?:\s+|$)/i.exec(text);
  return entry === null ? null : text.slice(entry[0].length).trim();
}
export const ACCEPT_AS_IS_CHOICE = "Accept as-is";
export const SUMMARY_CONFIRMATION_CHOICES = ["Looks correct", "Request changes"] as const;
