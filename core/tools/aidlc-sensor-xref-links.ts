// aidlc-sensor-xref-links.ts — per-sensor script for the `xref-links` sensor.
//
// Advisory. Enforces the cross-reference convention in memory/org.md: a stable
// ID used as a cross-reference to the artifact that defines it should be a
// relative Markdown link to that definition's anchor, not a bare token, so a
// reader can click through. ADRs already do this; this generalizes it to the
// FR / NFR / US / AC / BR / ENT / unit families.
//
// What it does, per Markdown artifact it is fired on:
//   1. Collect every anchor the file DEFINES — a portable HTML anchor
//      `<a id="fr1-2"></a>` (recommended) or a Kramdown `{#fr1-2}` heading
//      attribute, whose value is an ID's canonical anchor form.
//   2. Find every BARE ID token (matching the known families) that is NOT
//      inside a fenced code block, an inline-code span, an inline or
//      reference-style Markdown link, or an HTML tag, and whose canonical
//      anchor is defined in this same file.
//   3. Skip the two convention exceptions: the token ON its own defining
//      heading line, and any token with no matching defined anchor (a forward
//      reference whose target does not exist yet stays bare).
//   4. Report each remaining bare token as an advisory finding — it has a
//      resolvable target in this file but was not linked.
//
// Cross-FILE resolution (linking `requirements.md#fr1-2` from another artifact)
// is deliberately out of scope for this deterministic sensor: it would need a
// record-wide anchor index. This sensor covers the same-file case, which is the
// dominant one (a decisions.md ADR referencing a sibling ADR, a requirements.md
// FR referencing another FR), and never fires on a token it cannot prove.
//
// Locked stdout JSON shape:
//   {"pass": <bool>, "unlinked": [{id, line, anchor}], "findings_count": <n>,
//    "reason"?: <string>}
//
// Exit codes:
//   0   pass or advisory findings (the JSON `pass` field carries the verdict)
//   1   the file could not be read (dispatcher reclassifies)

import { existsSync, readFileSync, statSync } from "node:fs";
import { errorMessage } from "./aidlc-lib.ts";

interface Unlinked {
  id: string;
  line: number;
  anchor: string;
}

interface Result {
  pass: boolean;
  unlinked: Unlinked[];
  findings_count: number;
  reason?: string;
}

interface Flags {
  outputPath?: string;
  stage?: string;
}

// The ID families that carry a definition anchor. Accepts both the dotted
// (FR1.2, US1.1) and the hyphenated (FR-1) forms org.md lists as stable IDs,
// and single-segment US/BR that early drafts use. Sub-segments are optional so
// FR1 / BR1 / US1 match as well as FR1.2 / BR1.1 / US1.1.
const ID_PATTERN =
  /\b(?:FR-?\d+(?:\.\d+)?|NFR-?\d+(?:\.\d+)?|US-?\d+(?:\.\d+)?|AC-?\d+(?:\.\d+){0,2}|BR-?\d+(?:\.\d+)?|ENT-\d+|ADR-\d+|unit-\d+)\b/g;

function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stage") out.stage = argv[++i];
    else if (arg === "--output-path") out.outputPath = argv[++i];
  }
  return out;
}

function emit(result: Result): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`aidlc-sensor-xref-links: ${message}\n`);
  process.exit(1);
}

// Canonical anchor form: lower-case, every non-alphanumeric run → one hyphen,
// trimmed of leading/trailing hyphens. Matches the rule stated in org.md
// (FR1.2 → fr1-2, ADR-001 → adr-001, ENT-001 → ent-001).
export function anchorFor(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Anchors this file DEFINES. Two forms are honored:
//   * a portable HTML anchor  `<a id="fr1-2"></a>`  — CommonMark/GitHub render
//     this into a real jump target, so it is the recommended form;
//   * the Kramdown/Pandoc  `{#fr1-2}`  attribute at end of a heading line, for
//     renderers that support it.
// Returns a map of anchor → the 1-based line it is defined on, so a token on
// its own defining line is exempt. The Kramdown form is only read at line end
// (a heading attribute); the HTML form is read anywhere on the line.
export function definedAnchors(content: string): Map<string, number> {
  const anchors = new Map<string, number>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kramdown = lines[i].match(/\{#([A-Za-z0-9-]+)\}\s*$/);
    if (kramdown && !anchors.has(kramdown[1])) anchors.set(kramdown[1], i + 1);
    // Any number of portable HTML anchors on the line — id/name may be
    // followed by other attributes or a self-close, e.g.
    // `<a id="fr1-2"></a>`, `<a id="fr1-2" class="x">`, `<a id="fr1-2"/>`.
    for (const m of lines[i].matchAll(
      /<a\s+[^>]*?(?:id|name)=["']([A-Za-z0-9-]+)["'][^>]*>/gi,
    )) {
      if (!anchors.has(m[1])) anchors.set(m[1], i + 1);
    }
  }
  return anchors;
}

// Blank out spans that are NOT bare cross-references, so the scan does not
// re-flag them: inline-code, inline links `[text](target)`, reference-style
// links `[text][ref]` / collapsed `[text][]`, and real HTML tags (including
// the portable-anchor definitions). The HTML pattern REQUIRES a tag-name
// letter after `<` or `</`, so a prose comparison like `x < FR2 > y` is left
// intact and the bare `FR2` between the operators is still scanned. Replacing
// with spaces preserves column positions.
function maskLinkedAndCode(line: string): string {
  return line
    .replace(/`[^`]*`/g, (m) => " ".repeat(m.length))
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => " ".repeat(m.length))
    .replace(/\[[^\]]*\]\[[^\]]*\]/g, (m) => " ".repeat(m.length))
    .replace(/<\/?[A-Za-z][^>]*>/g, (m) => " ".repeat(m.length));
}

// Line indices (0-based) that sit inside a CLOSED fenced code block, plus the
// fence delimiter lines themselves. Follows CommonMark: the closing fence must
// use the SAME character as the opener AND be at least as long, and be alone on
// its line (only trailing whitespace) — so a shorter or literal marker inside a
// longer fence is content, not a close. A fence that opens but never closes
// before EOF is NOT treated as a fence — its opener is left as ordinary text —
// so one stray ``` cannot blind the scanner to every ID in the rest of the file.
function fencedLineSet(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  let open = -1;
  let openChar = "";
  let openLen = 0;
  for (let i = 0; i < lines.length; i++) {
    // An opener may carry an info string; a closer may carry only whitespace.
    const m = lines[i].match(/^\s{0,3}(`{3,}|~{3,})([^\n]*)$/);
    if (!m) continue;
    const marker = m[1];
    const rest = m[2];
    if (open < 0) {
      // Info strings on a backtick opener may not contain a backtick.
      if (marker[0] === "`" && rest.includes("`")) continue;
      open = i;
      openChar = marker[0];
      openLen = marker.length;
    } else if (
      marker[0] === openChar &&
      marker.length >= openLen &&
      rest.trim() === ""
    ) {
      for (let j = open; j <= i; j++) fenced.add(j);
      open = -1;
      openChar = "";
      openLen = 0;
    }
  }
  // `open >= 0` here means an unterminated fence: deliberately NOT added.
  return fenced;
}

function scan(content: string): Unlinked[] {
  const anchors = definedAnchors(content);
  const lines = content.split(/\r?\n/);
  const fenced = fencedLineSet(lines);
  const found: Unlinked[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (fenced.has(i)) continue;
    const masked = maskLinkedAndCode(lines[i]);
    for (const match of masked.matchAll(ID_PATTERN)) {
      const id = match[0];
      const anchor = anchorFor(id);
      // Only flag a token whose target this file actually defines.
      const definedOn = anchors.get(anchor);
      if (definedOn === undefined) continue;
      // Exempt the token on its own defining line.
      if (definedOn === lineNo) continue;
      // Dedup identical (id, line) so a token repeated on one line counts once.
      const key = `${id}:${lineNo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ id, line: lineNo, anchor });
    }
  }
  return found;
}

export function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const path = flags.outputPath;
  if (!path) fail("missing --output-path");

  let content: string;
  try {
    if (!existsSync(path)) fail(`artifact is missing: ${path}`);
    if (!statSync(path).isFile()) fail(`artifact is not a file: ${path}`);
    content = readFileSync(path, "utf-8");
  } catch (error) {
    fail(`cannot read artifact ${path}: ${errorMessage(error)}`);
  }

  const unlinked = scan(content);
  emit({
    pass: unlinked.length === 0,
    unlinked,
    findings_count: unlinked.length,
  });
}

if (import.meta.main) {
  main();
}
