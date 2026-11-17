// The date `aidlc-learnings.ts persist` puts on a practice line it writes.
// After a sentence it is visible text, `(learned YYYY-MM-DD)`. After a memory
// field line (`Methodology: tdd`, `Mode: strict`) it is an HTML comment,
// because the memory readers take everything after the colon as the field's
// value and comments are not part of it. Field lines written before that carry
// the visible form inside the value, so the readers of a field that takes one
// of a fixed set of values read it through withoutLearnedDate.
//
// aidlc-lib.ts imports this file, so it imports nothing from aidlc-lib.ts.

/** The visible date as a regular-expression source, for matching a whole line. */
export const LEARNED_DATE_SOURCE = String.raw`\(learned \d{4}-\d{2}-\d{2}\)`;

const TRAILING_LEARNED_DATE = new RegExp(`[ \\t]+${LEARNED_DATE_SOURCE}$`);

/** The date persist writes after a learning's text on `date` (YYYY-MM-DD). */
export function learnedDate(date: string, fieldLine: boolean): string {
  return fieldLine ? `<!-- learned ${date} -->` : `(learned ${date})`;
}

/** A field value without the visible date persist once wrote at its end. */
export function withoutLearnedDate(value: string): string {
  return value.replace(TRAILING_LEARNED_DATE, "");
}
