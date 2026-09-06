// Shared diff rendering: word-level HTML diffs and unified-diff parsing.
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

export function wordDiffHtml(before, after) {
  const left = tokens(String(before));
  const right = tokens(String(after));
  if (left.length * right.length > 40_000) return `<del>${escapeHtml(before)}</del><ins>${escapeHtml(after)}</ins>`;
  // Interleaved fragments ("showsruns anin errormemory") are unreadable. Keep
  // the common prefix and suffix, and show everything between them as one
  // removal followed by one insertion — how a person would mark the sentence.
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
  let tail = 0;
  while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail += 1;
  const removed = left.slice(head, left.length - tail).join("");
  const added = right.slice(head, right.length - tail).join("");
  const alternations = (removed.match(/\S+/g) || []).length + (added.match(/\S+/g) || []).length;
  if (alternations > 3) {
    const prefix = escapeHtml(left.slice(0, head).join(""));
    const suffix = escapeHtml(left.slice(left.length - tail).join(""));
    return `${prefix}${removed ? `<del>${escapeHtml(removed)}</del>` : ""}${removed && added ? " " : ""}${added ? `<ins>${escapeHtml(added)}</ins>` : ""}${suffix}`;
  }
  const rows = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const parts = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      parts.push(escapeHtml(left[i])); i += 1; j += 1;
    } else if (j < right.length && (i === left.length || rows[i][j + 1] > rows[i + 1][j])) {
      parts.push(`<ins>${escapeHtml(right[j])}</ins>`); j += 1;
    } else {
      parts.push(`<del>${escapeHtml(left[i])}</del>`); i += 1;
    }
  }
  return parts.join("");
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
