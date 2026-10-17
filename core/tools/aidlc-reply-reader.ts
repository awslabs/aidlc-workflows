// The deterministic part of a person's reply to any question the engine asks.
// The person drives: the conductor reads what they said, in context, and
// records the choice they made; the engine keeps their exact words and never
// reads meaning into them (tools for determinism, the model for knowledge, the
// human for judgement). What stays here is exact: a reply with no words in it,
// the "(Recommended)" label decoration, how a reply is shown in a message, and
// the labels each question offers.
//
// This module is standalone (no aidlc-lib import) so aidlc-lib can re-export
// the primitives below.

import { createHash } from "node:crypto";

// A reply with no words in it is nobody's answer. That is the only non-answer
// a reply's text can show: no host hands the hook dismissal text (measured
// 2026-10-12: Claude Code's Esc on AskUserQuestion fires no PostToolUse at all;
// Codex's Esc fires none either, and its box that runs out returns
// `{"answers":{}}`, which the human-turn hook reads by shape as
// QUESTION_UNANSWERED). So "cancel", "abort" or "timed out" as a whole reply are
// words a person typed, kept like any other words of theirs and read by the
// conductor; the engine never judges them.
export function isNonAnswer(text: string | undefined | null): boolean {
  return (text ?? "").trim().length === 0;
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
// A reply that is nothing but one offered option, by its number ("2") or its
// label in any case ("approve plan"), is an exact pick: syntax, not meaning, so
// a tool may record it straight away. Its letter ("b") is a pick only where the
// options were shown with letters (`lettered`), which is a questions file's own
// answer line; chat shows a picker or numbers, so a lone letter typed there is
// the person's words, and the conductor reads them. Surrounding quotes,
// markdown emphasis, one "(Recommended)", an option prefix before the label
// ("1. Approve"), and trailing punctuation are allowed; nothing else is. Any
// other reply is the conductor's to read. Returns the option's index, or null.
export function exactOptionPick(
  text: string | undefined | null,
  labels: readonly string[],
  lettered = false,
): number | null {
  const clean = (value: string): string => stripRecommendedDecorator(
    value.trim().replace(/^[`*_"'\s]+|[`*_"'\s]+$/g, ""),
  ).replace(/[\s.!]+$/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const reply = clean(text ?? "");
  if (!reply || labels.length === 0) return null;
  const index = (position: number): number | null => position >= 0 && position < labels.length ? position : null;
  const number = /^(?:option\s+)?[([#]?\s*(\d{1,2})\s*[)\]]?$/.exec(reply);
  if (number) return index(Number(number[1]) - 1);
  const letter = lettered ? /^(?:option\s+)?[([]?([a-z])[)\]]?$/.exec(reply) : null;
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

// What a question that needs the person's own reply (a Unit or batch
// checkpoint, the verification command, a Construction policy change) offers,
// in the order shown: Approve and Request Changes, or Request Changes alone (a
// batch whose files changed after its check, under a strict Guard Policy). Its
// row names them as its Options; its record keeps their digests.
export type ProtectedChoice = (typeof APPROVAL_GATE_CHOICES)[number];
const PROTECTED_CHOICE_SETS: readonly (readonly ProtectedChoice[])[] = [APPROVAL_GATE_CHOICES, ["Request Changes"]];

const choiceDigest = (choice: string): string => createHash("sha256").update(choice.toLowerCase(), "utf-8").digest("hex");

/** The offered choices these labels name, in order and in any case; null for any other list. */
export function protectedChoices(labels: readonly string[]): readonly ProtectedChoice[] | null {
  const named = labels.map((label) => label.trim().toLowerCase());
  return PROTECTED_CHOICE_SETS.find((set) => set.length === named.length &&
    set.every((choice, at) => choice.toLowerCase() === named[at])) ?? null;
}

/** What a question's record keeps for the choices it offers. */
export function protectedChoiceDigests(choices: readonly string[] = APPROVAL_GATE_CHOICES): string[] {
  const offered = protectedChoices(choices);
  if (offered === null) throw new Error("A protected question offers Approve and Request Changes, or Request Changes alone.");
  return offered.map(choiceDigest);
}

/** The choices a question's record says it offered; null when it names no offered set. */
export function offeredProtectedChoices(digests: unknown): readonly ProtectedChoice[] | null {
  if (!Array.isArray(digests)) return null;
  return PROTECTED_CHOICE_SETS.find((set) => set.length === digests.length &&
    set.every((choice, at) => choiceDigest(choice) === digests[at])) ?? null;
}

/**
 * The choice a reply that is exactly one of this question's offered options
 * picks, by its number or its label ("1", "request changes"). Null for any
 * other reply, a number it did not offer included: the conductor reads those.
 */
export function protectedQuestionPick(question: { options: unknown }, text: string | undefined): ProtectedChoice | null {
  const offered = offeredProtectedChoices(question.options) ?? [];
  const pick = exactOptionPick(text, offered);
  return pick === null ? null : offered[pick];
}

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
