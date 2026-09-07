// Shared diff rendering: word-level HTML diffs and unified-diff parsing.
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

/**
 * Word-level diff as ops: [{ type: "eq" | "del" | "ins", text }]. Interleaved
 * fragments ("showsruns anin errormemory") are unreadable, so when the middle
 * alternates more than a few times the common prefix/suffix are kept and the
 * whole middle becomes one removal followed by one insertion — how a person
 * would mark the sentence.
 */
export function diffOps(before, after) {
  const left = tokens(String(before));
  const right = tokens(String(after));
  if (left.length * right.length > 40_000) {
    return [{ type: "del", text: String(before) }, { type: "ins", text: String(after) }].filter((op) => op.text);
  }
  const rows = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const ops = [];
  const push = (type, text) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      push("eq", left[i]); i += 1; j += 1;
    } else if (j < right.length && (i === left.length || rows[i][j + 1] > rows[i + 1][j])) {
      push("ins", right[j]); j += 1;
    } else {
      push("del", left[i]); i += 1;
    }
  }
  // Readability guard: a rewritten sentence comes out of the LCS as many short
  // alternating runs ("showsruns anin errormemory"). If the changed runs are
  // that choppy, keep the common prefix and suffix and show the middle as one
  // removal followed by one insertion. Clean insertions and deletions (few
  // runs, or long ones) keep their exact positions.
  const changeRuns = ops.filter((op) => op.type !== "eq" && /\S/.test(op.text));
  const shortRuns = changeRuns.filter((op) => (op.text.match(/\S+/g) || []).length <= 2).length;
  if (changeRuns.length > 3 && shortRuns >= changeRuns.length * 0.6) {
    let head = 0;
    while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
    let tail = 0;
    while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail += 1;
    return [
      { type: "eq", text: left.slice(0, head).join("") },
      { type: "del", text: left.slice(head, left.length - tail).join("") },
      { type: "ins", text: right.slice(head, right.length - tail).join("") },
      { type: "eq", text: left.slice(left.length - tail).join("") },
    ].filter((op) => op.text);
  }
  return ops;
}

export function wordDiffHtml(before, after) {
  return diffOps(before, after)
    .map((op) => op.type === "del" ? `<del>${escapeHtml(op.text)}</del>` : op.type === "ins" ? `<ins>${escapeHtml(op.text)}</ins>` : escapeHtml(op.text))
    .join("");
}

/**
 * Show a suggested edit as rendered tracked changes: `afterHtml` (the new
 * block, rendered) with removed text re-inserted as <del> at the place it
 * left and inserted text wrapped in <ins>. The diff runs over the visible
 * text of both renderings, so markup the edit did not touch stays intact.
 */
export function trackedChangesFragment(beforeHtml, afterHtml) {
  const template = document.createElement("template");
  template.innerHTML = afterHtml;
  const fragment = template.content;
  const beforeText = textOf(beforeHtml);
  const afterNodes = [];
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) afterNodes.push(node);
  const afterText = afterNodes.map((item) => item.data).join("");
  const ops = diffOps(beforeText, afterText);
  // Cursor over the after-text: (node index, offset within node).
  let index = 0;
  let offset = 0;
  const splitAt = () => {
    if (index >= afterNodes.length) return null;
    const current = afterNodes[index];
    if (offset === 0) return current;
    if (offset >= current.data.length) {
      index += 1;
      offset = 0;
      return afterNodes[index] ?? null;
    }
    const rest = current.splitText(offset);
    afterNodes.splice(index + 1, 0, rest);
    index += 1;
    offset = 0;
    return rest;
  };
  const advance = (length) => {
    let remaining = length;
    while (remaining > 0 && index < afterNodes.length) {
      const room = afterNodes[index].data.length - offset;
      if (remaining < room) {
        offset += remaining;
        remaining = 0;
      } else {
        remaining -= room;
        index += 1;
        offset = 0;
      }
    }
  };
  for (const op of ops) {
    if (op.type === "eq") {
      advance(op.text.length);
      continue;
    }
    if (op.type === "del") {
      const at = splitAt();
      const del = document.createElement("del");
      del.className = "sugg-del";
      del.textContent = op.text;
      if (at) at.parentNode.insertBefore(del, at);
      else (afterNodes.at(-1)?.parentNode ?? fragment).append(del);
      continue;
    }
    // ins: wrap the next op.text.length characters of after-text, node by node
    let remaining = op.text.length;
    while (remaining > 0 && index < afterNodes.length) {
      const start = splitAt();
      if (!start) break;
      const take = Math.min(remaining, start.data.length);
      if (take < start.data.length) {
        const rest = start.splitText(take);
        afterNodes.splice(index + 1, 0, rest);
      }
      const ins = document.createElement("ins");
      ins.className = "sugg-ins";
      start.parentNode.insertBefore(ins, start);
      ins.append(start);
      remaining -= take;
      index += 1;
      offset = 0;
    }
  }
  return fragment;
}

function textOf(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.textContent || "";
}

function tokens(value) {
  return value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
}

/**
 * Parse a unified diff into hunks of { afterStart, afterEnd, removed, added }
 * where afterStart/afterEnd are 1-based line numbers in the "after" file.
 * Context lines are dropped: the change is the point.
 */
export function parseUnifiedHunks(unified) {
  const hunks = [];
  let current = null;
  let afterLine = 0;
  for (const line of String(unified).split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      afterLine = Number(header[1]);
      current = null;
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("\\")) continue;
    if (line.startsWith("-")) {
      if (!current) current = { afterStart: afterLine, afterEnd: afterLine, removed: [], added: [] };
      current.removed.push(line.slice(1));
      if (hunks.at(-1) !== current) hunks.push(current);
      continue;
    }
    if (line.startsWith("+")) {
      if (!current) current = { afterStart: afterLine, afterEnd: afterLine, removed: [], added: [] };
      current.added.push(line.slice(1));
      current.afterEnd = afterLine;
      if (hunks.at(-1) !== current) hunks.push(current);
      afterLine += 1;
      continue;
    }
    // context line
    current = null;
    afterLine += 1;
  }
  return hunks;
}

// --- Markdown-aware edit summaries -----------------------------------------
//
// An edit made with the toolbar changes markers, not words: bolding "simple"
// turns it into "**simple**". A word diff of the raw source would report that
// as "+2 words · **", which tells the reader nothing. The summary therefore
// names the formatting it sees - "Bold “simple”", "Heading 2", "Bulleted
// list" - and counts words on the text with the markers stripped, so a real
// rewording is still "+3 words −1 word · “…”".

const INLINE = [
  { name: "Bold", re: /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g },
  { name: "Strikethrough", re: /~~([^~\n]+?)~~/g },
  { name: "Code", re: /`([^`\n]+?)`/g },
  { name: "Link", re: /\[([^\]\n]+?)\]\([^)\n]*\)/g },
  { name: "Italic", re: /(?<![*\w])\*(?!\*)([^*\n]+?)\*(?!\*)|(?<![_\w])_(?!_)([^_\n]+?)_(?!_)/g },
];

/** The text a reader sees: inline markers and line prefixes removed. */
export function plainText(markdown) {
  return String(markdown ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/, ""))
    .join("\n")
    .replace(/\[([^\]\n]+?)\]\([^)\n]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+?)`/g, "$1")
    .replace(/(?<![*\w])\*(?!\*)([^*\n]+?)\*(?!\*)/g, "$1")
    .replace(/(?<![_\w])_(?!_)([^_\n]+?)_(?!_)/g, "$1");
}

function inlineSpans(text) {
  const found = new Map();
  for (const { name, re } of INLINE) {
    for (const match of String(text).matchAll(re)) {
      const inner = (match[1] ?? match[2] ?? "").trim();
      if (inner) found.set(`${name}:${inner}`, { name, inner });
    }
  }
  return found;
}

function linePrefix(line) {
  const heading = line.match(/^\s{0,3}(#{1,6})\s+/);
  if (heading) return `Heading ${heading[1].length}`;
  if (/^\s{0,3}(?:[-*+])\s+\[[ xX]\]\s+/.test(line)) return "Task list";
  if (/^\s{0,3}(?:[-*+])\s+/.test(line)) return "Bulleted list";
  if (/^\s{0,3}\d+[.)]\s+/.test(line)) return "Numbered list";
  if (/^\s{0,3}>\s?/.test(line)) return "Quote";
  if (/^\s{0,3}\|/.test(line)) return "Table";
  if (/^\s{0,3}```/.test(line)) return "Code block";
  return "Paragraph";
}

/**
 * What changed in formatting between two Markdown texts, as short phrases:
 * ["Bold “simple”", "Heading 2 → Heading 3", "Bulleted list"]. Empty when only
 * words changed.
 */
export function formattingChanges(before, after) {
  const notes = [];
  const was = inlineSpans(before);
  const now = inlineSpans(after);
  const quote = (inner) => `“${inner.length > 40 ? `${inner.slice(0, 40)}…` : inner}”`;
  for (const [key, { name, inner }] of now) if (!was.has(key)) notes.push(`${name} ${quote(inner)}`);
  for (const [key, { name, inner }] of was) if (!now.has(key)) notes.push(`Removed ${name.toLowerCase()} ${quote(inner)}`);
  // Block-level: compare the line prefixes of lines whose visible text matches.
  const beforeLines = String(before ?? "").split("\n");
  const afterLines = String(after ?? "").split("\n");
  const seen = new Set();
  for (const line of afterLines) {
    const visible = plainText(line).trim();
    if (!visible) continue;
    const prefix = linePrefix(line);
    const twin = beforeLines.find((candidate) => plainText(candidate).trim() === visible);
    if (twin === undefined) continue;
    const previous = linePrefix(twin);
    if (previous === prefix) continue;
    const note = previous === "Paragraph" ? prefix : prefix === "Paragraph" ? `Removed ${previous.toLowerCase()}` : `${previous} → ${prefix}`;
    if (!seen.has(note)) { seen.add(note); notes.push(note); }
  }
  return notes;
}

/**
 * "+3 words −1 word · “…”" for a reworded block; "Bold “simple”" for a
 * formatting change; both when both happened. Words are counted and quoted
 * on the visible text, never on markers.
 */
export function editSummary(before, after) {
  const notes = formattingChanges(before, after);
  const ops = diffOps(plainText(before), plainText(after));
  const words = (text) => (String(text).match(/\S+/g) || []).length;
  const added = ops.filter((op) => op.type === "ins").reduce((total, op) => total + words(op.text), 0);
  const removed = ops.filter((op) => op.type === "del").reduce((total, op) => total + words(op.text), 0);
  const parts = [];
  if (added || removed) {
    const first = ops.find((op) => op.type === "ins")?.text || ops.find((op) => op.type === "del")?.text || "";
    const excerpt = first.replace(/\s+/g, " ").trim();
    const shown = excerpt.length > 90 ? `${excerpt.slice(0, 90)}…` : excerpt;
    const counts = [added ? `<ins>+${added} ${added === 1 ? "word" : "words"}</ins>` : "", removed ? `<del>−${removed} ${removed === 1 ? "word" : "words"}</del>` : ""].filter(Boolean).join(" ");
    parts.push(`${counts}${shown ? ` · <q>${escapeHtml(shown)}</q>` : ""}`);
  }
  for (const note of notes) parts.push(`<span class="fmt">${escapeHtml(note)}</span>`);
  if (!parts.length) parts.push(`<span class="fmt">Formatting</span>`);
  return parts.join(" · ");
}
