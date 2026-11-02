export interface Question { id: string; title: string; prompt: string; options: { key: string; text: string }[]; answer: string | null; answers: string[]; answerText: string | null }
/** `## Q1.` / `## Q1:` / `## Q1 —` / `## Question 1 — …`, `###` and `####` too; the id is normalised to `Q<n>`. */
const QHEAD = /^(#{2,4})\s+(?:Question|Q)\s*(\d+)\s*(?:[.:)—–-]\s*)?(.*)$/i;
const HEAD = /^(#{1,6})\s/;
/** Options are written `A. text`, with or without a `- ` bullet. */
const OPT = /^(?:[-*]\s+)?([A-EX])\.\s+(.*)$/;
const INLINE_ANS = /^\[Answer\]:\s*(.*)$/;
const BATCH_ANS = /^\[Answer (?:Question|Q)\s*(\d+)\]:\s*(.*)$/i;
/**
 * A "select all that apply" answer: `C, D` / `c,d` / `A and B` / `C + D` — keys and nothing else. One key followed by
 * any other text is a single answer plus free text, so a second key is never assumed from prose.
 */
const MULTI = /^[A-EXa-ex](?:\s*(?:,|&|\+|\band\b)\s*[A-EXa-ex])+$/;
const KEYSEP = /\s*(?:,|&|\+|\band\b)\s*/;
function splitAnswer(raw: string): { answer: string | null; answers: string[]; answerText: string | null } {
  const v = raw.trim(); if (!v) return { answer: null, answers: [], answerText: null };
  if (MULTI.test(v)) {
    const keys = [...new Set(v.split(KEYSEP).map((k) => k.trim().toUpperCase()).filter(Boolean))];
    return { answer: keys[0]!, answers: keys, answerText: null };
  }
  const m = v.match(/^([A-Ea-eXx])(?=$|[\s.,):—–-])[\s.,):—–-]*(.*)$/s);
  if (!m) return { answer: "X", answers: ["X"], answerText: v };
  const k = m[1]!.toUpperCase();
  return { answer: k, answers: [k], answerText: (m[2] ?? "").trim() || null };
}
export function parseQuestions(md: string): { context: string[]; questions: Question[] } {
  const lines = md.split("\n"); const context: string[] = []; const questions: Question[] = [];
  let mode: "none" | "context" | "q" = "none"; let cur: Question | null = null;
  /** The heading depth of the open question: only a heading at that level or shallower closes it. */
  let depth = 0;
  /** True right after an option line: until a blank line, other non-option text wraps that option. */
  let wrap = false;
  for (const line of lines) {
    if (!line.trim()) { wrap = false; continue; }
    const h = line.match(QHEAD);
    if (h) { wrap = false; depth = h[1]!.length; cur = { id: `Q${h[2]}`, title: h[3]!.trim(), prompt: "", options: [], answer: null, answers: [], answerText: null }; questions.push(cur); mode = "q"; continue; }
    if (/^##\s+Context/i.test(line)) { mode = "context"; cur = null; continue; }
    const other = line.match(HEAD);
    if (other) {
      // A deeper heading (`### Notes` inside a `##` question) is part of the question; same level or shallower ends it.
      if (mode !== "q" || !cur || other[1]!.length <= depth) { mode = "none"; cur = null; }
      wrap = false; continue;
    }
    const b = line.match(BATCH_ANS);
    if (b) { const q = questions.find((x) => x.id === `Q${b[1]}`); if (q) Object.assign(q, splitAnswer(b[2]!)); continue; }
    if (mode === "context") { const c = line.match(/^- \*\*([^*]+)\*\*:\s*(.*)$/); if (c) context.push(`${c[1]}: ${c[2]!.replace(/\s*\[[^\]]*\]\s*$/, "")}`); continue; }
    if (mode === "q" && cur) {
      const o = line.match(OPT); if (o) { cur.options.push({ key: o[1]!, text: o[2]!.trim() }); wrap = true; continue; }
      const a = line.match(INLINE_ANS); if (a) { Object.assign(cur, splitAnswer(a[1]!)); wrap = false; continue; }
      if (wrap) { const last = cur.options[cur.options.length - 1]!; last.text = `${last.text} ${line.trim()}`; continue; }
      if (line.trim() && !cur.options.length) cur.prompt += (cur.prompt ? " " : "") + line.trim();
    }
  }
  return { context, questions };
}
