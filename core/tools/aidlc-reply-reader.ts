// One reader for a person's reply to any question the engine asks: a stage
// gate, the summary confirmation, a construction policy or verification
// command, a Construction checkpoint, Plan Approval, and a guard-recovery ask.
// Each question passes its own choices; the reading rules are the same
// everywhere, so the person can answer in their own words at every question
// (a number, a letter, the option with a typo, "approved", "looks good", or
// what they want changed) instead of retyping an exact option label.
//
// This module is standalone (no aidlc-lib import) so aidlc-lib can use it for
// guard recovery and re-export the primitives below.

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

// How the engine reads a reply to a two-choice question (approve, or ask for
// changes). The conductor never interprets the reply: this deterministic
// reader works on the person's own words and infers what they meant. What a
// typed reply cannot show is WHICH question the person was answering, because
// the conductor writes the questions. So:
//   - saying which option, in words ("Approve", "approved", "Looks good.
//     Approved.") or by number, letter, or ordinal ("1", "A", "b.", "the
//     first one"), counts;
//   - any change request ("rename the handler", "looks good but split the
//     tests", "no", "not yet") counts as the change option, which can never
//     grant approval;
//   - a plain yes ("yes", "lgtm", "looks good") counts only when the reply is
//     bound to the question itself (the caller decides: the first reply after
//     the question, or a picker that asked it). Anywhere else it asks for a
//     one-reply confirmation instead, because it might answer some other
//     question;
//   - a question is answered by the conductor and records nothing;
//   - anything else ("maybe", "up to you", mixed signals) is unclear.
export type TwoChoiceReplyReading =
  | "approve" | "request-changes" | "confirm" | "question" | "unclear";

const REPLY_APPROVAL_WORDS = new Set([
  "yes", "yep", "yeah", "yea", "yup", "ya", "yas", "yess", "y", "ok", "okay", "okey",
  "okie", "k", "kk", "sure", "alright", "lgtm", "sgtm", "wfm", "approve", "approved",
  "good", "great", "fine", "perfect", "excellent", "awesome", "nice", "cool",
  "proceed", "ship", "continue", "absolutely", "definitely", "certainly",
  "roger", "aye", "affirmative", "+1", "yah", "yeh", "ye", "yessir", "alrighty", "greenlit",
]);
// Words that agree only with a question asking whether something is correct
// (the summary confirmation). Asked whether to approve a plan, "correct" or
// "right" is not approval.
export const CORRECTNESS_AGREEMENT_WORDS: ReadonlySet<string> = new Set([
  "correct", "accurate", "right", "confirm", "confirmed", "true",
]);
const NO_AGREEMENT_WORDS: ReadonlySet<string> = new Set();
const REPLY_FILLER_WORDS = new Set([
  "looks", "look", "sounds", "seems", "it", "its", "that", "thats", "this", "all",
  "set", "thanks", "thank", "thx", "ty", "please", "pls", "plz", "lets", "let",
  "us", "ahead", "for", "me", "do", "is", "the", "plan", "plans", "to", "and",
  "then", "now", "just", "really", "very", "so", "im", "i", "happy", "with", "on",
  "board", "start", "begin", "build", "implement", "generate", "code", "coding",
  "a", "an", "of", "as", "totally", "indeed", "fully", "super", "pretty", "much",
  "well", "done", "here", "we", "be", "can", "will", "sir", "lol", "by", "ill",
]);
const REPLY_NEGATIVE_WORDS = new Set([
  "no", "nope", "nah", "naw", "nay", "n", "noo", "nooo", "negative", "not", "dont",
  "never", "stop", "wait", "hold", "reject", "rejected", "decline", "declined",
  "cant", "cannot", "wont", "shouldnt", "veto", "denied", "deny", "disapprove",
  "disapproved", "unapproved", "nevermind", "nvm", "halt", "abandon", "revert",
  "scrap", "abort", "withdraw", "withdrawn", "retract", "retracted", "revoke", "revoked",
  "rescind", "rescinded", "unapprove",
]);
const REPLY_CHANGE_WORDS = new Set([
  "change", "changes", "changed", "changing", "rename", "add", "adding", "remove",
  "delete", "drop", "split", "merge", "combine", "use", "using", "replace", "swap",
  "move", "update", "fix", "rewrite", "redo", "revise", "rework", "adjust",
  "tweak", "instead", "rather", "but", "except", "however", "though", "although",
  "include", "exclude", "skip", "reorder", "make", "should", "need", "needs",
  "must", "prefer", "missing", "forgot", "wrong", "incorrect", "typo", "bug",
  // A condition on approval is a change request until it is met.
  "provided", "once", "after", "pending", "assuming", "unless", "only", "until",
  "before", "if", "partial", "partially", "conditional", "conditionally",
  "rethink", "reconsider", "bump",
]);
// Phrases that mean no even though they contain a yes word. They are applied
// before the yes phrases, so "don't go ahead" never becomes "go ahead".
const REPLY_NEGATIVE_PHRASES: [RegExp, string][] = [
  [/\b(?:do not|don'?t|never|not|no) (?:approve|approved|approving|proceed|go(?: ahead)?|continue|ship(?: it)?|merge(?: it)?|deploy(?: it)?|start|begin|do it|generate|build|implement|write)(?: (?:the |any )?code)?(?: yet)?\b/g, " no "],
  [/\bnot (?:yet|now|today|ok|okay|good|fine|like this)\b/g, " no "],
  [/\b(?:not|isn'?t|aren'?t|wasn'?t) (?:quite |really |entirely |all )?(?:correct|right|accurate)\b/g, " no "],
  [/\b(?:can'?t|cannot|won'?t|not going to) approve(?: (?:it|this|that))?(?: yet)?\b/g, " no "],
  [/\b(?:never mind|no way|hell no|heck no|hold off|hang on|start over|try again|forget it|yeah right|as if|hard pass|i'?ll pass|pass on (?:this|it)|back to the drawing board|oh no)\b/g, " no "],
  // "yeah... no" is no; "yeah, no problem" is not.
  [/\byea+h*[ .,]+(?:no|nah)\b(?! (?:problems?|worries|issues?|changes?|concerns))/g, " no "],
];
// Phrases that mean yes, or that contain a change or negative word but approve.
const REPLY_APPROVAL_PHRASES: [RegExp, string][] = [
  [/\b(?:i )?have no (?:further |more )?(?:changes?|notes?|issues|problems?|concerns|objections|complaints|comments|questions?|requests?)\b/g, " fine "],
  [/\bno (?:further |more )?(?:changes?|notes?|issues|problems?|concerns|objections|complaints|comments|questions?|requests?)(?: needed)?\b/g, " fine "],
  [/\b(?:don'?t|do not) (?:change|touch) (?:anything|a thing)\b/g, " fine "],
  [/\b(?:leave|keep) it as(?: it)? is\b/g, " fine "],
  [/\bnothing needs? (?:to )?chang(?:e|ing)\b/g, " fine "],
  [/\bno need to change(?: anything)?\b/g, " fine "],
  [/\bnothing (?:else )?to (?:change|add)\b/g, " fine "],
  [/\b(?:the )?changes look (?:good|great|fine)\b/g, " fine "],
  [/\bnot bad\b/g, " fine "],
  [/\bwhy not\b/g, " sure "],
  [/\ball good\b/g, " fine "],
  [/\bthank you\b/g, " thanks "],
  [/\b(?:thumbs up|sounds like a plan|go for it|make it so|go ahead|of course|send it|green light|carry on|works for me|sure thing|hell yes|heck yes|full steam ahead|move forward|moving forward|oh yes)\b/g, " yes "],
  [/\blet'?s (?:build|start|begin|implement|code|ship)(?: (?:it|this))?\b/g, " yes "],
  // Go ahead with what was shown: "merge it", "please merge", "merge the PR",
  // "use that". Said with a no ("don't use it") it stays that person's words;
  // with its own object ("merge steps 2 and 3") it is a change.
  [/(?<!\b(?:not|dont|don't|never|no) )\b(?:merge|ship|land|deploy)(?: (?:it|this|that|the (?:pr|pull request|branch|changes?)))?(?= ?(?:$|[.!,;]))/g, " yes "],
  [/(?<!\b(?:not|dont|don't|never|no) )\buse (?:it|this|that)\b(?! (?:instead|but|except|with|for|to|as|in|on)\b)/g, " yes "],
  [/\b(?:approval granted|you have my approval|consider it approved|it'?s approved|this is approved)\b/g, " approved "],
  [/\bas long as\b/g, " provided "],
  [/\b(?:looks?|seems?) off\b/g, " wrong "],
  // "go" and "do it" say yes only as the whole reply or with "let's" or
  // "just": "I have to go" is leaving, not approving.
  [/^ (?:let'?s |just )?(?:do it|go(?: go)*) $/, " yes "],
  [/\blet'?s (?:do it|go)\b/g, " yes "],
  [/\b(?:good|ready) to go\b/g, " yes "],
];
const REPLY_UNCLEAR_RE =
  /\b(?:not sure|unsure|maybe|perhaps|idk|i don'?t know|dunno|hm+|up to you|your call|whatever you (?:think|want)|you decide|either (?:way|one)|good start|i'?m good|go on|(?:have|need|got) to (?:go|run|leave)|gotta (?:go|run)|gtg|brb|afk|(?:could|would|might|may|'d) (?:probably |likely )?approve)\b/;
// A reply that trails off ("ok so", "and then") has not answered yet.
const REPLY_TRAILING_RE = /^(?:ok(?:ay)?,? so|(?:ok(?:ay)?,? )?and then)$/;
// Taking back what was just said, with no "no" in it.
const REPLY_RETRACT_RE =
  /\b(?:scratch that|on second thought|oops|one sec|hold that thought|take (?:that|it) back|changed my mind)\b/;
const REPLY_QUESTION_RE =
  /^(?:what|whats|why|how|hows|which|who|where|when|does|do(?!\s+(?:not|it)\b)|did|is|are|was|were|isnt|doesnt|should|shall)\b/;
// A request for an explanation, even without a question mark.
const REPLY_EXPLAIN_RE =
  /^(?:(?:can|could|would) you (?:please )?)?(?:explain|clarify|elaborate|walk me through|tell me)\b/;
const REPLY_APPROVE_LABEL_RE =
  /^(?:i )?(?:hereby )?(?:approve|approved|approving|(?:approve|approving) (?:it|this|now|(?:the )?(?:code generation )?plans?)|plan approved)$/;
const REPLY_CHANGES_LABEL_RE =
  /^(?:request(?:ing)? changes|changes(?: please)?|changes requested)$/;
const REPLY_ORDINAL_RE =
  /^(?:the |option )?(?:(one|first|1st|former|top)|(two|second|2nd|latter|bottom))(?: one| option)?(?: please| thanks)?$/;
const REPLY_PICK_RE =
  /^(?:let'?s |i(?:'ll| will)? )?(?:pick|picking|select|selecting|choose|choosing|go with|going with|take|taking)\s+(?:option\s+)?([12ab]|approve(?: plan)?|request changes|(?:the )?(?:first|top|second|bottom)(?: one| option)?)(?: please| thanks)?$/;
// A pick phrase followed by an option's own label: "go with looks correct".
const REPLY_PICK_PREFIX_RE =
  /^(?:let'?s |i(?:'ll| will)? )?(?:pick|picking|select|selecting|choose|choosing|go with|going with|take|taking)\s+(.+?)(?: please| thanks)?$/;
// A yes or no said with the option it names: "yes 1", "no, 2".
const REPLY_AFFIRMED_OPTION_RE =
  /^(yes|yep|yeah|yup|ok|okay|sure|no|nope|nah)[\s,.:;-]+(?:option\s+)?([12ab])[.)!]?$/;
const REPLY_DIGIT_OPTION_RE = /^(?:option\s*|number\s*)?[(\[#]?\s*([12])\s*[)\].:,-]?(?=\s|$)(.*)$/;
const REPLY_LETTER_OPTION_RE = /^(?:option\s+)?[(\[]?([ab])(?:[)\].:,-]|\s*$)(.*)$/;
const REPLY_TYPO_TARGETS = ["approve", "approved", "changes", "request"];
// The words that name the approval option itself, not just agree.
const REPLY_APPROVE_NAMES = new Set(["approve", "approved", "approving"]);
// Courtesy and sign-off words that may accompany a named approval without
// qualifying it ("Approved, thanks for the thorough plan", "Keep me posted").
const REPLY_COURTESY_WORDS = new Set([
  "thanks", "thank", "thx", "ty", "cheers", "nice", "great", "good", "excellent", "job",
  "work", "detail", "details", "detailed", "thorough", "solid", "clear", "keep", "me",
  "posted", "updated", "sent", "from", "my", "phone", "iphone", "mobile", "ready",
]);
// Real words one slip from an option word, never corrected into it.
const REPLY_TYPO_REAL_WORDS = new Set(["chances", "charges", "changer", "bequest"]);
// Markup or code is pasted text, not an answer in the human's own words.
const REPLY_MARKUP_RE = /[<>{}=\\|]/;

// One slip: a wrong, missing, extra, or swapped letter.
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; }
    else if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function isKnownReplyWord(word: string): boolean {
  return REPLY_TYPO_TARGETS.includes(word) || REPLY_TYPO_REAL_WORDS.has(word) || REPLY_APPROVAL_WORDS.has(word) ||
    REPLY_FILLER_WORDS.has(word) || REPLY_NEGATIVE_WORDS.has(word) || REPLY_CHANGE_WORDS.has(word);
}

function normalizeReply(text: string): string {
  return stripRecommendedDecorator(text)
    // Fullwidth and circled digits read as digits ("\uFF11", "\u2460").
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u{1F44D}|\u{1F44C}|\u{1F197}|\u2705|\u2713|\u2611|\u2714/gu, " yes ")
    .replace(/\u{1F44E}|\u274C|\u{1F6D1}/gu, " no ")
    // Keycap digits ("1" + U+FE0F + U+20E3) read as the digit; invisible
    // characters (zero-width, direction marks) are not part of the reply.
    .replace(/[\uFE0F\u20E3\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
    // A sad or wry emoticon is a mixed signal; a smile adds nothing.
    .replace(/(^|\s)(?::'?-?[(\/\\|]|-_+-)(?=\s|$|[.!,])/g, "$1 no ")
    .replace(/(^|\s):-?[)D](?=\s|$|[.!,])/g, "$1 ")
    // Struck-through text is taken back; an unticked checkbox line is not
    // chosen and a ticked one is.
    .replace(/~~[^~]*~~/g, " ")
    .replace(/^[ \t]*(?:[-*+][ \t]*)?\[ \][^\n]*$/gm, "")
    .replace(/^[ \t]*(?:[-*+][ \t]*)?\[[xX]\][ \t]*/gm, "")
    // Markdown emphasis and list or heading markers are formatting.
    .replace(/[*_~]+/g, "")
    .replace(/^[ \t]*(?:[-+#]+|\u2022)[ \t]+/gm, "")
    // Quoted lines are the question, not the reply; line breaks end sentences.
    .replace(/^[ \t]*>.*$/gm, "")
    .trim()
    .replace(/\s*\n\s*/g, ". ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bapprove-?plan(s?)\b/g, "approve plan$1")
    .replace(/\brequest-?changes\b/g, "request changes")
    .replace(/\by+e+s+\b/g, "yes")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    // One slip in the option words still names the option ("aprove", "chanes").
    // A word the reader already knows ("change") is never corrected.
    .replace(/[a-z]{5,}/g, (word) =>
      isKnownReplyWord(word)
        ? word
        : REPLY_TYPO_TARGETS.find((target) => withinOneEdit(word, target)) ?? word);
}

function withReplyPhrases(text: string): string {
  let phrased = ` ${text} `;
  for (const [pattern, replacement] of [...REPLY_NEGATIVE_PHRASES, ...REPLY_APPROVAL_PHRASES]) {
    phrased = phrased.replace(pattern, replacement);
  }
  return phrased.replace(/\s+/g, " ").trim();
}

function replyWords(text: string): string[] {
  return withReplyPhrases(text)
    .split(/[^a-z0-9'+]+/)
    .map((word) => word.replace(/'/g, ""))
    .filter((word) => word.length > 0);
}

function readReplyWords(words: string[]): {
  approve: boolean; negative: boolean; change: boolean; other: boolean;
} {
  let approve = false; let negative = false; let change = false; let other = false;
  for (const word of words) {
    if (REPLY_CHANGE_WORDS.has(word)) change = true;
    else if (REPLY_NEGATIVE_WORDS.has(word)) negative = true;
    else if (REPLY_APPROVAL_WORDS.has(word)) approve = true;
    else if (!REPLY_FILLER_WORDS.has(word)) other = true;
  }
  return { approve, negative, change, other };
}

// Whether a reply that chose nothing still holds back ("hmm", "not sure",
// "scratch that"), as opposed to a courtesy that chose nothing ("thanks!").
export function replyHesitates(text: string): boolean {
  const reply = normalizeReply(text);
  return REPLY_UNCLEAR_RE.test(reply) || REPLY_RETRACT_RE.test(reply) || readReplyWords(replyWords(reply)).negative;
}

export function interpretTwoChoiceReply(
  text: string,
  options: readonly [string, string],
  bound: boolean,
  agree: ReadonlySet<string> = NO_AGREEMENT_WORDS,
): TwoChoiceReplyReading {
  // This question's own agreement words read as a plain yes.
  const wordsOf = (part: string): string[] => replyWords(part).map((word) => agree.has(word) ? "yes" : word);
  const reply = normalizeReply(text);
  const bare = reply.replace(/[\s.!,;:]+$/, "");
  const asks = bare.endsWith("?");
  const core = bare.replace(/[\s?]+$/, "");
  if (!core || isNonAnswer(core) || REPLY_MARKUP_RE.test(core) || REPLY_TRAILING_RE.test(core)) return "unclear";

  // The option named on its own. Followed by "?" it asks about the option.
  if (!asks) {
    if (core === options[0].toLowerCase() || REPLY_APPROVE_LABEL_RE.test(core)) return "approve";
    if (core === options[1].toLowerCase() || REPLY_CHANGES_LABEL_RE.test(core)) return "request-changes";
    const ordinal = REPLY_ORDINAL_RE.exec(core);
    if (ordinal) return ordinal[1] ? "approve" : "request-changes";
    const picked = REPLY_PICK_RE.exec(core);
    if (picked) return /^(?:1|a|approve|approve plan|(?:the )?(?:first|top)\b.*)$/.test(picked[1]) ? "approve" : "request-changes";
    const label = REPLY_PICK_PREFIX_RE.exec(core)?.[1];
    if (label === options[0].toLowerCase()) return "approve";
    if (label === options[1].toLowerCase()) return "request-changes";
  }
  if (REPLY_UNCLEAR_RE.test(reply)) return "unclear";

  // The option named by number or letter. Anything else said with "1" must
  // not ride on it: "1 concern" or "A: what's the timeline?" is not approval.
  const positional = REPLY_DIGIT_OPTION_RE.exec(core) ?? REPLY_LETTER_OPTION_RE.exec(core);
  if (positional) {
    const rest = positional[2].trim();
    if (asks || REPLY_QUESTION_RE.test(rest)) return "question";
    if (positional[1] === "2" || positional[1] === "b") return "request-changes";
    if (/\b[12]\b/.test(rest)) return "unclear";
    const flags = readReplyWords(wordsOf(rest));
    if (flags.change) return "request-changes";
    if (flags.negative || flags.other) return "unclear";
    return "approve";
  }
  // The yes or no must agree with the option: "yes 2" and "no 1" are unclear.
  const affirmed = asks ? null : REPLY_AFFIRMED_OPTION_RE.exec(core);
  if (affirmed) {
    const approveSide = affirmed[2] === "1" || affirmed[2] === "a";
    if (approveSide !== REPLY_APPROVAL_WORDS.has(affirmed[1])) return "unclear";
    return approveSide ? "approve" : "request-changes";
  }

  // A request phrased as a question ("can you split the tests?") is a change
  // request; an information question ("what does step 3 do?") is not an answer.
  if (REPLY_QUESTION_RE.test(withReplyPhrases(core)) || REPLY_EXPLAIN_RE.test(core)) return "question";
  // An information question after an agreement ("yes, what happens after
  // this?") is still a question: its words say nothing about what to change.
  if (asks) {
    const clauses = core.split(/[,.;:!]+\s*|\s+(?:and|but|so)\s+/).filter((clause) => clause.trim());
    const last = clauses.at(-1)?.trim() ?? "";
    if (
      clauses.length > 1 && (REPLY_QUESTION_RE.test(last) || REPLY_EXPLAIN_RE.test(last)) &&
      !readReplyWords(wordsOf(clauses.slice(0, -1).join(" "))).change
    ) return "question";
  }
  const flags = readReplyWords(wordsOf(core));
  if (flags.change) return "request-changes";
  if (flags.negative && !flags.approve && !flags.other) return "request-changes";
  if (asks) return "question";
  // "Looks good. Approved." or "I approve this plan" names the option. The
  // rest must be plain approval or courtesy: anything else ("as soon as the
  // tests pass", "just kidding") may qualify the approval or take it back.
  const words = wordsOf(core);
  if (
    words.some((word) => REPLY_APPROVE_NAMES.has(word)) && !flags.negative &&
    words.every((word) =>
      REPLY_APPROVAL_WORDS.has(word) || REPLY_FILLER_WORDS.has(word) || REPLY_COURTESY_WORDS.has(word))
  ) return "approve";
  if (flags.approve && !flags.negative && !flags.other) return bound ? "approve" : "confirm";
  return "unclear";
}

// Words that only say "change something" without saying what: a reply made of
// these (and fillers or a plain no) picks the change option but still needs
// the person's feedback. Anything else they said is the feedback.
const REPLY_BARE_CHANGE_WORDS = new Set([
  "change", "changes", "changed", "changing", "request", "requests", "requested", "requesting",
  "revise", "revision", "revisions", "edit", "edits", "tweak", "tweaks", "adjust", "adjustments",
  "update", "updates", "modify", "modifications", "fix", "fixes", "some", "few", "more", "option",
  "number", "choice", "second", "two", "2", "b", "bottom", "latter", "one", "pick", "select",
  "choose", "go", "take", "id", "like", "want", "wanted", "would", "make", "need", "needs",
  "should", "must", "please",
]);

// Whether a reply read as the change option also says what should change.
function replyCarriesFeedback(text: string, options: readonly [string, string]): boolean {
  const core = normalizeReply(text).replace(/[\s.!,;:?]+$/, "");
  const label = options[1].toLowerCase();
  const rest = core === label ? "" : core;
  return replyWords(rest).some((word) =>
    !REPLY_BARE_CHANGE_WORDS.has(word) && !REPLY_FILLER_WORDS.has(word) &&
    !REPLY_NEGATIVE_WORDS.has(word) && !REPLY_APPROVAL_WORDS.has(word) &&
    !REPLY_COURTESY_WORDS.has(word) && !CORRECTNESS_AGREEMENT_WORDS.has(word));
}

export interface TwoChoiceReply {
  reading: TwoChoiceReplyReading;
  // The person's own words when the reply asks for changes and says what.
  feedback: string | null;
}

export function readTwoChoiceReply(
  text: string,
  options: readonly [string, string],
  bound: boolean,
  agree: ReadonlySet<string> = NO_AGREEMENT_WORDS,
): TwoChoiceReply {
  const reading = interpretTwoChoiceReply(text, options, bound, agree);
  return {
    reading,
    feedback: reading === "request-changes" && replyCarriesFeedback(text, options) ? text.trim() : null,
  };
}

// --- The questions the engine asks -------------------------------------------

export const APPROVAL_GATE_CHOICES = ["Approve", "Request Changes"] as const;
export const ACCEPT_AS_IS_CHOICE = "Accept as-is";
export const SUMMARY_CONFIRMATION_CHOICES = ["Looks correct", "Request changes"] as const;

export type ApprovalGateChoice = "Approve" | typeof ACCEPT_AS_IS_CHOICE | "Request Changes";

export interface ApprovalGateReply {
  choice: ApprovalGateChoice | null;
  reading: TwoChoiceReplyReading;
  feedback: string | null;
}

// The third choice a gate offers after three revision cycles.
const ACCEPT_AS_IS_RE =
  /^(?:(?:option |choice |number )?(?:3|c|three)|(?:the )?third(?: one| option)?|accept(?:ed)?(?: it)?(?: as[ -]?is)?)$/;

// A stage gate, a Construction checkpoint, a construction policy, or a
// verification command: Approve or Request Changes, plus Accept as-is when the
// gate offers it. `bound` is whether a plain yes can answer this question: no
// other question is waiting for the same reply.
export function readApprovalGateReply(
  text: string,
  gate: { acceptAsIs?: boolean; bound: boolean },
): ApprovalGateReply {
  const core = normalizeReply(text).replace(/[\s.!,;:]+$/, "");
  if (gate.acceptAsIs && ACCEPT_AS_IS_RE.test(core)) {
    return { choice: ACCEPT_AS_IS_CHOICE, reading: "approve", feedback: null };
  }
  const reply = readTwoChoiceReply(text, APPROVAL_GATE_CHOICES, gate.bound);
  return {
    ...reply,
    choice: reply.reading === "approve" ? "Approve"
      : reply.reading === "request-changes" ? "Request Changes"
        : null,
  };
}

export interface SummaryConfirmationReply {
  choice: (typeof SUMMARY_CONFIRMATION_CHOICES)[number] | null;
  reading: TwoChoiceReplyReading;
  feedback: string | null;
}

// The consolidated summary confirmation. `bound`: the summary prompt is the
// question waiting for this reply, so a plain yes answers it.
export function readSummaryConfirmationReply(text: string, bound = true): SummaryConfirmationReply {
  const reply = readTwoChoiceReply(text, SUMMARY_CONFIRMATION_CHOICES, bound, CORRECTNESS_AGREEMENT_WORDS);
  return {
    ...reply,
    choice: reply.reading === "approve" ? SUMMARY_CONFIRMATION_CHOICES[0]
      : reply.reading === "request-changes" ? SUMMARY_CONFIRMATION_CHOICES[1]
        : null,
  };
}

// What the conductor does after a reply that recorded nothing, so the next
// step is never a guess and the person is asked at most one short follow-up.
export function replyFollowUp(
  reading: "confirm" | "question" | "unclear",
  choices: readonly string[],
): string {
  const numbered = choices.map((choice, index) => `"${index + 1}" for ${choice}`).join(", ");
  switch (reading) {
    case "confirm":
      return "The person said yes without naming a choice while another question was also waiting, so it " +
        `could be answering that one and nothing was recorded. Ask them to confirm in one reply (${numbered}) ` +
        "and end the turn.";
    case "question":
      return "The person asked a question, so nothing was recorded. Answer it, then ask again in the same " +
        `message with every offered choice (${numbered}) and end the turn.`;
    case "unclear":
      return "The reply did not clearly pick a choice, so nothing was recorded. Ask one short follow-up, " +
        `such as "${choices.map((choice, index) => `${choice} (${index + 1})`).join(", or ")}?", and end the turn.`;
  }
}

// --- A question with any number of options -------------------------------------

const OPTION_ORDINALS = [
  ["first", "1st", "top"], ["second", "2nd"], ["third", "3rd"], ["fourth", "4th"], ["fifth", "5th"],
  ["sixth", "6th"], ["seventh", "7th"], ["eighth", "8th"], ["ninth", "9th"], ["tenth", "10th"],
];
const OPTION_PICK_RE =
  /^(?:(?:let'?s |i(?:'ll| will)? )?(?:pick|picking|select|selecting|choose|choosing|go with|going with|take|taking|do)|(?:yes|yep|yeah|ok|okay|sure)[,.:;]?)\s+(.+)$/;
const OPTION_DIGIT_RE = /^(?:option|number|choice)?\s*[(\[#]?\s*(\d+)\s*[)\].:]?$/;
const OPTION_LETTER_RE = /^(?:option\s+)?[(\[]?([a-z])[)\].:]?$/;
const OPTION_ORDINAL_RE = /^(?:the )?(?:option )?([a-z0-9]+)(?: one| option)?$/;

function optionLabel(label: string): string {
  return normalizeReply(label).replace(/[\s.!,;:?]+$/, "");
}

// Which option a reply names: its number, letter, or ordinal ("2", "b.", "the
// second one", "last"), its label with markdown, "(Recommended)", case, and
// one slip ignored, or either of those after a pick phrase ("go with 2").
// `matches` lists every option the reply could name; `index` is set only when
// that is exactly one. A question, or a reply naming two options, names none.
export function readOptionReply(
  text: string,
  labels: readonly string[],
): { index: number | null; matches: number[] } {
  const none = { index: null, matches: [] as number[] };
  const reply = normalizeReply(text).replace(/[\s.!,;:]+$/, "");
  if (!reply || reply.endsWith("?") || isNonAnswer(reply)) return none;
  const normalizedLabels = labels.map(optionLabel);
  const matches = new Set<number>();
  const name = (candidate: string): void => {
    const digit = OPTION_DIGIT_RE.exec(candidate);
    if (digit) {
      const index = Number(digit[1]) - 1;
      if (index >= 0 && index < labels.length) matches.add(index);
      return;
    }
    const letter = OPTION_LETTER_RE.exec(candidate);
    if (letter) {
      const index = letter[1].charCodeAt(0) - 97;
      if (index < labels.length) matches.add(index);
      return;
    }
    const ordinal = OPTION_ORDINAL_RE.exec(candidate)?.[1];
    if (ordinal !== undefined) {
      const index = ordinal === "last" || ordinal === "bottom"
        ? labels.length - 1
        : OPTION_ORDINALS.findIndex((words) => words.includes(ordinal));
      if (index >= 0 && index < labels.length) matches.add(index);
    }
    normalizedLabels.forEach((label, index) => {
      if (candidate === label || (label.length >= 6 && withinOneEdit(candidate, label))) matches.add(index);
    });
  };
  name(reply);
  const picked = OPTION_PICK_RE.exec(reply)?.[1];
  if (picked !== undefined) name(picked);
  const found = [...matches].sort((a, b) => a - b);
  return { index: found.length === 1 ? found[0] : null, matches: found };
}
