// The Markdown reader: markdownBlocks (block structure from the built-in
// Bun.markdown renderer), the visibleMarkdownLines projection, and the section
// helpers built on them. aidlc-lib.ts re-exports the names it exported before,
// so its callers are unchanged, and it loads this module at start: nothing here
// may import aidlc-lib.ts.

// Keep an opaque marker where an HTML comment was removed. It preserves the
// required whitespace boundary in `##<!-- comment --> Heading` while allowing
// comments inside a valid heading title.
const INVISIBLE_COMMENT_MARKER = "\u0000";
const INVISIBLE_LINE_MARKER = "\u0001";
const RAW_INVISIBLE_COMMENT_MARKER_ESCAPE = "\u0002";

export function stripInvisibleCommentMarkers(line: string): string {
  return line.replaceAll(INVISIBLE_COMMENT_MARKER, "");
}

export function restoreVisibleMarkdownMarkers(line: string): string {
  if (line.startsWith(INVISIBLE_LINE_MARKER)) return "";
  return line
    .replaceAll(INVISIBLE_COMMENT_MARKER, "")
    .replaceAll(INVISIBLE_LINE_MARKER, "")
    .replaceAll(RAW_INVISIBLE_COMMENT_MARKER_ESCAPE, INVISIBLE_COMMENT_MARKER);
}

// --- Helpers ---

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Markdown section helpers ---
// Used by practices-discovery affirmation (copy under ## Mandated /
// ## Forbidden) and the orchestrator (reads aidlc-team.md sections for
// stance lookup). Pure string operations against well-formed markdown.
// Caller is responsible for code-fence-free input — rules/aidlc-*.md
// never contain fenced ## lines per spec.
//
// Heading-match rules:
//   - Pass the full marker form ("## Walking Skeleton") as `heading`.
//   - Trailing whitespace on the actual heading line is tolerated.
//   - Sub-headings (`### Walking Skeleton`) never match `## Walking Skeleton`.
//   - On multiple matches of the same heading, the first wins.
//   - When the heading is absent, extract returns "" and append throws.

export function extractMarkdownSection(content: string, heading: string): string {
  // Returns the prose between `heading` (e.g. "## Walking Skeleton") and the
  // next `## ` heading at the same level (or end of file). The heading line
  // itself is not included in the output. Returns "" if heading is absent.
  // Headings inside fenced code blocks (```) are skipped — a teaching example
  // that contains `## Walking Skeleton` should not be mistaken for the actual
  // section.
  const stripped = stripFencedCodeBlocks(content);
  const headingRegex = new RegExp(
    `^${escapeRegex(heading)}[ \\t]*$`,
    "m",
  );
  const startMatch = headingRegex.exec(stripped);
  if (!startMatch) return "";
  const afterHeading = startMatch.index + startMatch[0].length;
  // Skip the newline immediately after the heading line, if any.
  const bodyStart = stripped[afterHeading] === "\n" ? afterHeading + 1 : afterHeading;
  // Find the next `## ` heading at the same level (not `### ` or deeper).
  const nextHeading = /^## [^\n]*$/m;
  nextHeading.lastIndex = bodyStart;
  const remainder = stripped.slice(bodyStart);
  const nextMatch = nextHeading.exec(remainder);
  const bodyEnd = nextMatch ? bodyStart + nextMatch.index : stripped.length;
  return stripped.slice(bodyStart, bodyEnd);
}

// Replace fenced-code contents with blank lines while preserving all other
// text. This is the long-standing extraction contract: HTML comments remain
// part of the returned section for callers that inspect them directly.
function stripFencedCodeBlocks(content: string): string {
  const lines = content.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      inFence = !inFence;
      lines[i] = "";
      continue;
    }
    if (inFence) lines[i] = "";
  }
  return lines.join("\n");
}


export type MarkdownContainer =
  | { kind: "blockQuote" }
  | { kind: "listItem"; ordered: boolean; start: number | null; id: number };

export type MarkdownLineKind =
  | "blank" | "paragraph" | "heading" | "thematicBreak" | "codeFenced" | "codeIndented"
  | "htmlFlow" | "definition" | "table" | "unknown";

export interface MarkdownSpan {
  start: number;
  end: number;
  kind: "codeText" | "htmlText" | "htmlComment";
  tokenStartLine: number;
  tokenEndLine: number;
}

export interface MarkdownLine {
  kind: MarkdownLineKind;
  // Lines of one rendered block share this id (and their containers array);
  // -1 for lines outside any block the renderer produced.
  block: number;
  containers: MarkdownContainer[];
  htmlKind: 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
  contentStart: number;
  invisible: MarkdownSpan[];
}

export interface MarkdownDefinition {
  label: string;
  startLine: number;
  endLine: number;
}

export interface MarkdownBlocks {
  lines: MarkdownLine[];
  definitions: MarkdownDefinition[];
  // Normalized label of every link reference definition in the document.
  labels: string[];
}

// Delimiters that serialize Bun.markdown.render output into a tree. The
// rendered source never contains them, so a document cannot forge structure.
const MARKDOWN_TREE_OPEN = "\u0001";
const MARKDOWN_TREE_META = "\u0002";
const MARKDOWN_TREE_BODY = "\u0003";
const MARKDOWN_TREE_CLOSE = "\u0004";
// biome-ignore lint/suspicious/noControlCharactersInRegex: these control characters are the tree delimiters being removed.
const MARKDOWN_TREE_DELIMITERS = /[\u0001-\u0004]/g;

interface RenderedMarkdownNode {
  tag: string;
  meta: string[];
  kids: Array<RenderedMarkdownNode | string>;
  parent: RenderedMarkdownNode | null;
  id: number;
}

// Bun.markdown hands inline raw HTML to the text callback as its own chunk.
// This only recognizes such a chunk; the renderer already decided it is HTML.
const RAW_HTML_CHUNK =
  /^<(?:[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|\/[A-Za-z][A-Za-z0-9-]*\s*>|!--(?:-?>|[\s\S]*?-->)|\?[\s\S]*?\?>|![A-Za-z][^>]*>|!\[CDATA\[[\s\S]*?\]\]>)$/;

// GFM task lists stay off: Bun.markdown (1.3.14 through at least 1.4.2) lets
// an empty task item such as `- [x]` swallow the next line, even a heading
// after a blank line. Checkboxes carry no meaning for any consumer.
const MARKDOWN_RENDER_OPTIONS = { tasklists: false } as const;

function renderMarkdownTree(source: string): RenderedMarkdownNode {
  const clean = (value: unknown): string => String(value ?? "").replace(MARKDOWN_TREE_DELIMITERS, "x");
  const open = (tag: string, ...meta: unknown[]): string =>
    MARKDOWN_TREE_OPEN + [tag, ...meta.map(clean)].join(MARKDOWN_TREE_META) + MARKDOWN_TREE_BODY;
  const node = (tag: string) => (children: string): string => open(tag) + children + MARKDOWN_TREE_CLOSE;
  const inline = (children: string): string => children;
  const serialized = Bun.markdown.render(source, {
    heading: (children, meta) => open("H", meta.level) + children + MARKDOWN_TREE_CLOSE,
    paragraph: node("P"),
    blockquote: node("Q"),
    list: (children, meta) => open("LIST", meta.ordered ? 1 : 0, meta.start ?? "") + children + MARKDOWN_TREE_CLOSE,
    listItem: node("L"),
    code: (children, meta) => open("C", meta?.language ?? "") + children + MARKDOWN_TREE_CLOSE,
    html: node("X"),
    hr: () => open("HR") + MARKDOWN_TREE_CLOSE,
    table: node("T"),
    thead: inline,
    tbody: inline,
    tr: node("TR"),
    th: node("TD"),
    td: node("TD"),
    strong: inline,
    emphasis: inline,
    strikethrough: inline,
    link: (children, meta) => open("A", meta.href, meta.title ?? "") + children + MARKDOWN_TREE_CLOSE,
    image: (children, meta) => open("I", meta.src, meta.title ?? "") + children + MARKDOWN_TREE_CLOSE,
    codespan: node("c"),
    text: (text) => {
      const chunk = clean(text);
      return RAW_HTML_CHUNK.test(chunk) ? open("x") + chunk + MARKDOWN_TREE_CLOSE : chunk;
    },
  }, MARKDOWN_RENDER_OPTIONS);
  const root: RenderedMarkdownNode = { tag: "root", meta: [], kids: [], parent: null, id: 0 };
  let current = root;
  let nextId = 1;
  for (let index = 0; index < serialized.length;) {
    const character = serialized[index];
    if (character === MARKDOWN_TREE_OPEN) {
      const body = serialized.indexOf(MARKDOWN_TREE_BODY, index);
      const [tag, ...meta] = serialized.slice(index + 1, body).split(MARKDOWN_TREE_META);
      const child: RenderedMarkdownNode = { tag, meta, kids: [], parent: current, id: nextId++ };
      current.kids.push(child);
      current = child;
      index = body + 1;
    } else if (character === MARKDOWN_TREE_CLOSE) {
      current = current.parent ?? root;
      index++;
    } else {
      let end = index;
      while (end < serialized.length && serialized[end] !== MARKDOWN_TREE_OPEN && serialized[end] !== MARKDOWN_TREE_CLOSE) end++;
      current.kids.push(serialized.slice(index, end));
      index = end;
    }
  }
  return root;
}

function renderedMarkdownText(node: RenderedMarkdownNode): string {
  return node.kids.map((kid) => typeof kid === "string" ? kid : renderedMarkdownText(kid)).join("");
}

interface MarkdownProbe {
  id: number;
  line: number;
  column: number;
  insert: string;
  core: string;
  role: "primary" | "comment" | "html" | "code";
}

interface MarkdownProbeHit {
  probe: MarkdownProbe;
  node: RenderedMarkdownNode;
  meta: boolean;
}

const MARKDOWN_CONTAINER_PREFIX = /^(?:[ \t]{0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)))*[ \t]*/;
const MARKDOWN_FENCE = /^(`{3,}|~{3,})/;
const MARKDOWN_THEMATIC_BREAK = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const MARKDOWN_SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;

// A column where inserting a probe word cannot change block structure: after
// the first letter or digit outside container markers, tags, entities and
// escapes. A line whose text is all inside brackets takes the probe after a
// closing bracket (a reference label must stay intact), then inside a label,
// then inside a link destination. The render comparison in probeMarkdown
// proves the choice for each document.
function markdownProbeColumn(line: string, from: number): number | null {
  let inTag = false;
  let inEntity = false;
  let brackets = 0;
  let destination = 0;
  let afterLabel: number | null = null;
  let inLabel: number | null = null;
  let inDestination: number | null = null;
  for (let index = from; index < line.length;) {
    const character = String.fromCodePoint(line.codePointAt(index)!);
    const next = index + character.length;
    if (inTag) {
      if (character === ">") inTag = false;
    } else if (character === "<") {
      inTag = true;
    } else if (character === "\\") {
      index = next < line.length ? next + String.fromCodePoint(line.codePointAt(next)!).length : next;
      continue;
    } else if (character === "&") {
      inEntity = true;
    } else if (inEntity && /[A-Za-z0-9#]/.test(character)) {
      // An entity name is not source text.
    } else {
      inEntity = false;
      if (destination > 0) {
        if (character === "(") destination++;
        else if (character === ")") destination--;
        else if (inDestination === null && /[\p{L}\p{N}]/u.test(character)) inDestination = next;
      } else if (character === "[") {
        brackets++;
      } else if (character === "]") {
        brackets = Math.max(0, brackets - 1);
        if (line[next] === "(") {
          destination = 1;
          index = next + 1;
          continue;
        }
        if (brackets === 0 && (next === line.length || /[ \t]/.test(line[next]))) afterLabel ??= next;
      } else if (/[\p{L}\p{N}]/u.test(character)) {
        if (brackets === 0) return next;
        inLabel ??= next;
      }
    }
    index = next;
  }
  return afterLabel ?? inLabel ?? inDestination;
}

// Block syntax whose shape a probe word would change: rules, setext
// underlines, fences and table delimiter rows.
const MARKDOWN_STRUCTURE_LINE =
  /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*|-+[ \t]*|`{3,}.*|~{3,}.*|\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*)$/;

// A line with no letter or digit outside markup (punctuation, emoji, entities)
// takes its probe where its content starts: inside a table row's first cell,
// or after a closing tag, whose block start condition still holds.
function markdownFallbackProbeColumn(line: string, start: number): number | null {
  const content = line.slice(start).trimEnd();
  if (content === "" || MARKDOWN_STRUCTURE_LINE.test(content)) return null;
  if (content.startsWith("|")) return start + /^\|[ \t]*/.exec(content)![0].length;
  if (content.startsWith("<")) return start + content.length;
  return start;
}

function markdownProbes(source: string[], prefix: string): MarkdownProbe[] {
  const probes: MarkdownProbe[] = [];
  const add = (line: number, column: number, role: MarkdownProbe["role"], shape: (core: string) => string): void => {
    const core = `${prefix}${probes.length}z`;
    probes.push({ id: probes.length, line, column, insert: shape(core), core, role });
  };
  source.forEach((line, index) => {
    const start = MARKDOWN_CONTAINER_PREFIX.exec(line)![0].length;
    const atx = /^#{1,6}(?=[ \t]|$)[ \t]*/.exec(line.slice(start));
    // Raw HTML that opens a line, and any HTML heading tag, carries a probe
    // inside the construct where every HTML block start condition still holds.
    const opening = /^<(?:([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)|\?|![A-Za-z]|!\[CDATA\[)/.exec(line.slice(start));
    if (atx) {
      // A word at the start of heading content keeps the heading, and any
      // block containing it, intact.
      const rest = line.length > start + atx[0].length;
      add(index, start + atx[0].length, "primary", (core) =>
        !/[ \t]$/.test(atx[0]) ? ` ${core}` : rest ? `${core} ` : core);
    } else {
      const column = markdownProbeColumn(line, start);
      const next = source[index + 1];
      if (column !== null) {
        add(index, column, "primary", (core) => core);
      } else if (line.trim() !== "" && next !== undefined &&
        MARKDOWN_SETEXT_UNDERLINE.test(next.slice(/^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}/.exec(next)![0].length))) {
        // Setext heading text without a letter or digit: probe before any
        // trailing whitespace, which the heading content drops.
        add(index, line.trimEnd().length, "primary", (core) => core);
      } else if (!opening) {
        const fallback = markdownFallbackProbeColumn(line, start);
        if (fallback !== null) add(index, fallback, "primary", (core) => core);
      }
    }
    for (let offset = line.indexOf("<!--"); offset >= 0; offset = line.indexOf("<!--", offset + 4)) {
      // `<!-->` and `<!--->` are complete comments that a probe would reopen.
      if (!/^<!---?>/.test(line.slice(offset))) add(index, offset + 4, "comment", (core) => core);
    }
    // After every backtick run (and one padding space), so each code span
    // carries a probe and gets exact columns; a fence line would take it as
    // an info string.
    if (!MARKDOWN_FENCE.test(line.slice(start))) {
      for (const run of line.matchAll(/`+ ?/g)) add(index, run.index + run[0].length, "code", (core) => core);
    }
    if (opening) {
      const column = start + opening[0].length;
      add(index, column, "html", (core) => opening[1] ? ` ${core}` : core);
    }
    for (const tag of line.matchAll(/<h[1-6](?=[\s/>]|$)/gi)) {
      if (tag.index !== start) add(index, tag.index + tag[0].length, "html", (core) => ` ${core}`);
    }
  });
  return probes;
}

function withMarkdownProbes(source: string[], probes: MarkdownProbe[]): string {
  const byLine = new Map<number, MarkdownProbe[]>();
  for (const probe of probes) byLine.set(probe.line, [...(byLine.get(probe.line) ?? []), probe]);
  return source.map((line, index) => {
    let probed = line;
    for (const probe of (byLine.get(index) ?? []).sort((a, b) => b.column - a.column || b.id - a.id)) {
      probed = probed.slice(0, probe.column) + probe.insert + probed.slice(probe.column);
    }
    return probed;
  }).join("\n");
}

function withoutMarkdownProbes(text: string, prefix: string, probes: MarkdownProbe[]): string {
  return text.replace(new RegExp(`( ?)${prefix}(\\d+)z( ?)`, "g"), (match, before: string, id: string, after: string) => {
    const probe = probes[Number(id)];
    if (!probe) return match;
    return (probe.insert.startsWith(" ") ? "" : before) + (probe.insert.endsWith(" ") ? "" : after);
  });
}

function locateMarkdownProbes(
  tree: RenderedMarkdownNode,
  prefix: string,
  probes: MarkdownProbe[],
  hits: Map<number, MarkdownProbeHit>,
): void {
  const pattern = new RegExp(`${prefix}(\\d+)z`, "g");
  const record = (id: number, node: RenderedMarkdownNode, meta: boolean): void => {
    if (probes[id]) hits.set(id, { probe: probes[id], node, meta });
  };
  const visit = (node: RenderedMarkdownNode): void => {
    for (const value of node.meta) {
      for (const match of value.matchAll(pattern)) record(Number(match[1]), node, true);
    }
    for (const kid of node.kids) {
      if (typeof kid !== "string") visit(kid);
      else for (const match of kid.matchAll(pattern)) record(Number(match[1]), node, false);
    }
  };
  visit(tree);
}

const MARKDOWN_PROBE_RENDER_BUDGET = 256;

// Keep only probes whose insertion leaves Bun.markdown's HTML byte-identical,
// then read where each one rendered.
function probeMarkdown(source: string[], prefix: string): {
  probes: MarkdownProbe[];
  accepted: Set<number>;
  hits: Map<number, MarkdownProbeHit>;
} {
  const probes = markdownProbes(source, prefix);
  const original = Bun.markdown.html(source.join("\n"), MARKDOWN_RENDER_OPTIONS);
  // Past this many renders a group that changes the rendering is dropped
  // whole, which leaves its lines unclassified rather than slow.
  let budget = MARKDOWN_PROBE_RENDER_BUDGET;
  const neutral = (subset: MarkdownProbe[]): boolean => {
    budget--;
    return withoutMarkdownProbes(Bun.markdown.html(withMarkdownProbes(source, subset), MARKDOWN_RENDER_OPTIONS), prefix, probes) === original;
  };
  // Bisect to the probes that change the rendering, so one bad probe costs a
  // logarithmic number of renders rather than one render per probe.
  const groups: MarkdownProbe[][] = [];
  const settle = (subset: MarkdownProbe[]): void => {
    if (subset.length === 0 || budget <= 0) return;
    if (neutral(subset)) {
      groups.push(subset);
    } else if (subset.length > 1) {
      const half = Math.ceil(subset.length / 2);
      settle(subset.slice(0, half));
      settle(subset.slice(half));
    }
  };
  settle(probes);
  const kept = groups.flat();
  const hits = new Map<number, MarkdownProbeHit>();
  const accepted = new Set(kept.map((probe) => probe.id));
  // Groups that are neutral apart may still interact; then read each alone.
  const renders = groups.length <= 1 || neutral(kept) ? [kept] : groups;
  for (const group of renders) {
    locateMarkdownProbes(renderMarkdownTree(withMarkdownProbes(source, group)), prefix, probes, hits);
  }
  return { probes, accepted, hits };
}

/** CommonMark label matching: collapse whitespace, then Unicode case-fold. */
export function normalizeMarkdownLabel(label: string): string {
  return label.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}

// Every bracketed label is referenced ahead of the document, each in its own
// paragraph so no inline construct can span two of them; the ones the
// renderer turns into links are defined somewhere in the document.
function markdownDefinedLabels(source: string, rendered: string): string[] {
  const candidates = [...new Set(
    [...source.matchAll(/\[((?:\\.|[^\\[\]])+)\]/g)]
      .map((match) => match[1].replace(/[\t\n\r ]+/g, " ").trim())
      .filter((label) => label.length > 0 && label.length <= 999),
  )];
  if (candidates.length === 0) return [];
  let prefix = "aidlclabel";
  while (source.includes(prefix) || rendered.includes(prefix)) prefix += "x";
  const references = candidates.map((label, index) => `[${label}]${prefix}${index}z`).join("\n\n");
  const tree = renderMarkdownTree(`${references}\n\n${source}`);
  const marker = new RegExp(`^${prefix}(\\d+)z`);
  const defined = new Set<string>();
  // The marker prefix is absent from the document and from its rendering
  // (entities cannot spell it), so only reference paragraphs match.
  for (const paragraph of tree.kids) {
    if (typeof paragraph === "string" || paragraph.tag !== "P") continue;
    paragraph.kids.forEach((kid, index) => {
      const match = typeof kid === "string" ? marker.exec(kid) : null;
      const previous = paragraph.kids[index - 1];
      if (match && Number(match[1]) < candidates.length && typeof previous !== "string" && previous?.tag === "A") {
        defined.add(normalizeMarkdownLabel(candidates[Number(match[1])]));
      }
    });
  }
  return [...defined].sort();
}

// Only classify a block the renderer already produced: its extent and whether
// it can interrupt a paragraph come from Bun.markdown, not this tag list.
const MARKDOWN_HTML_BLOCK_TAG =
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\t >]|\/>|$)/i;

function markdownHtmlKind(firstLine: string): NonNullable<MarkdownLine["htmlKind"]> {
  if (/^<(?:script|pre|style|textarea)(?:[\t >]|$)/i.test(firstLine)) return 1;
  if (firstLine.startsWith("<!--")) return 2;
  if (firstLine.startsWith("<?")) return 3;
  if (/^<![A-Za-z]/.test(firstLine)) return 4;
  if (firstLine.startsWith("<![CDATA[")) return 5;
  if (MARKDOWN_HTML_BLOCK_TAG.test(firstLine)) return 6;
  return 7;
}

// Content that opens an ATX heading, a fence, or an HTML block of any kind
// (kind 7 is a complete tag alone on its line).
const MARKDOWN_TABLE_BREAK = new RegExp([
  /^#{1,6}(?:[ \t]|$)/.source,
  /^(?:`{3,}|~{3,})/.source,
  /^<(?:(?:script|pre|style|textarea)(?:[\t >]|$)|!--|\?|![A-Za-z]|!\[CDATA\[)/.source,
  MARKDOWN_HTML_BLOCK_TAG.source,
  /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>[ \t]*$/.source,
].join("|"), "i");

// Column after the line's container prefixes and indentation. A list item's
// marker appears only on its first line; later lines carry indentation.
function markdownContentStart(line: string, containers: Array<"quote" | "marker" | "indent">): number {
  let position = 0;
  for (const container of containers) {
    const prefix = container === "quote" ? /^[ \t]{0,3}>[ \t]?/
      : container === "marker" ? /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/
      : /^[ \t]*/;
    position += prefix.exec(line.slice(position))?.[0].length ?? 0;
  }
  return position + /^[ \t]*/.exec(line.slice(position))![0].length;
}

const MARKDOWN_RAW_BLOCKS: ReadonlySet<string> = new Set(["C", "X"]);
const MARKDOWN_LEAF_BLOCKS: ReadonlySet<string> = new Set(["H", "P", "C", "X", "TD", "L"]);
const MARKDOWN_INLINE_SPANS: ReadonlySet<string> = new Set(["x", "c", "C", "X"]);

/**
 * CommonMark/GFM source structure as Bun.markdown renders it; all positions
 * index BOM/CRLF-normalized raw lines. The renderer reports no source
 * positions, so each line carries a probe word placed where it cannot change
 * block structure (the rendered HTML proves it); where a probe renders
 * locates the line's block, containers and inline code or HTML.
 */
export function markdownBlocks(content: string): MarkdownBlocks {
  if (typeof Bun.markdown?.render !== "function" || typeof Bun.markdown.html !== "function") {
    throw new Error(`Markdown analysis requires Bun.markdown (Bun 1.3.8 or newer); this is Bun ${Bun.version}`);
  }
  const raw = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  // Bun.markdown (through at least 1.4.2) continues a GFM table through a line
  // that starts a heading, fence or HTML block; GFM ends the table there.
  // Render such a line after a blank one (keeping its quote markers) and map
  // positions back to the source.
  let rendered = raw;
  let origin = raw.map((_, index) => index);
  // It also closes a quote's or list item's fenced block at a fence line
  // outside that container, where CommonMark ends the container and opens a
  // new fence; an HTML comment line there ends the container first. And it
  // opens an HTML block at a tag indented four or more columns under a
  // paragraph, which CommonMark continues; a no-break space in place of the
  // last indentation column keeps the line's columns and makes it text. Each
  // round repairs at least one line that can never need it again.
  for (let round = 0; ; round++) {
    const { repairs, ...blocks } = classifyMarkdownLines(rendered);
    if (repairs.size === 0 || round >= raw.length) {
      return rendered === raw ? blocks : withSourceLines(blocks, origin, raw, rendered);
    }
    const next: string[] = [];
    const nextOrigin: number[] = [];
    rendered.forEach((line, index) => {
      const repair = repairs.get(index);
      if (repair?.insert !== undefined) {
        next.push(repair.insert);
        nextOrigin.push(-1);
      }
      next.push(repair?.replace ?? line);
      nextOrigin.push(origin[index]);
    });
    rendered = next;
    origin = nextOrigin;
  }
}

interface MarkdownRepair {
  // A line to render before this one, or a same-length replacement for it.
  insert?: string;
  replace?: string;
}

// Repairs that make Bun.markdown end a table, a container or a paragraph
// where CommonMark/GFM does.
function markdownRepairs(
  raw: string[],
  blocks: MarkdownBlocks,
  fences: Array<{ opener: number; closer: number }>,
  indentedHtml: number[],
  fenceLineInside: (closer: number) => boolean,
): Map<number, MarkdownRepair> {
  const repairs = new Map<number, MarkdownRepair>();
  const quotes = (line: string): string => /^(?:[ \t]{0,3}>[ \t]?)*/.exec(line)![0];
  // A heading or fence ends the table without changing how the lines after it
  // read, so every such break is repaired at once; an HTML block may run over
  // the rest of the table, which is then repaired next round.
  const stopped = new Set<number>();
  blocks.lines.forEach((line, index) => {
    const previous = blocks.lines[index - 1];
    if (line.kind !== "table" || previous?.kind !== "table" || previous.block !== line.block || stopped.has(line.block)) return;
    const content = raw[index].slice(line.contentStart);
    if (!MARKDOWN_TABLE_BREAK.test(content)) return;
    if (content.startsWith("<")) stopped.add(line.block);
    repairs.set(index, { insert: quotes(raw[index]).replace(/[ \t]+$/, "") });
  });
  for (const index of indentedHtml) {
    const start = blocks.lines[index].contentStart;
    // Bun opens such a block only under paragraph text, placed or not.
    const previous = blocks.lines[index - 1]?.kind;
    if ((previous !== "paragraph" && previous !== "unknown") || !/[ \t]/.test(raw[index][start - 1] ?? "")) continue;
    repairs.set(index, { replace: `${raw[index].slice(0, start - 1)}\u00A0${raw[index].slice(start)}` });
  }
  for (const { opener, closer } of fences) {
    // A fence line is never a lazy continuation, so the opener carries every
    // quote marker of its container path; a fence placed only lexically has
    // no container path, so its own markers are the evidence.
    const containers = blocks.lines[opener].containers;
    const openerQuotes = quotes(raw[opener]);
    const closerQuotes = quotes(raw[closer]);
    const count = (prefix: string): number => prefix.match(/>/g)?.length ?? 0;
    const depth = Math.max(count(openerQuotes), containers.filter((container) => container.kind === "blockQuote").length);
    const indent = (line: string, prefix: string): number => /^[ \t]*/.exec(line.slice(prefix.length))![0].length;
    // The item's content column when the opener carries the marker; any
    // indentation otherwise.
    const marker = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(raw[opener].slice(openerQuotes.length));
    // An indented opener placed only lexically continues the list item above it.
    let above = opener - 1;
    while (above >= 0 && blocks.lines[above].kind === "blank") above--;
    const listed = marker !== null || containers.some((container) => container.kind === "listItem") ||
      (containers.length === 0 && indent(raw[opener], openerQuotes) > 0 && above >= 0 &&
        blocks.lines[above].containers.some((container) => container.kind === "listItem"));
    // Without the marker on the opener the item's content column is not in
    // view: a closer indented at least as far as the opener is inside the
    // item, an unindented one outside it, and Bun places any other.
    const closerIndent = indent(raw[closer], closerQuotes);
    const outside = count(closerQuotes) < depth || (listed && (marker
      ? closerIndent < marker[0].length
      : closerIndent === 0 || (closerIndent < indent(raw[opener], openerQuotes) && !fenceLineInside(closer))));
    if (outside) repairs.set(closer, { insert: `${closerQuotes}<!-- -->` });
  }
  return repairs;
}

function withSourceLines(blocks: MarkdownBlocks, origin: number[], raw: string[], rendered: string[]): MarkdownBlocks {
  const lines: MarkdownLine[] = new Array(raw.length);
  origin.forEach((source, index) => {
    if (source < 0) return;
    const line = blocks.lines[index];
    // A replaced line's no-break space is source indentation.
    const contentStart = rendered[index] === raw[source]
      ? line.contentStart
      : line.contentStart + /^[ \t]*/.exec(raw[source].slice(line.contentStart))![0].length;
    lines[source] = {
      ...line,
      contentStart,
      invisible: line.invisible.map((span) => ({
        ...span, tokenStartLine: origin[span.tokenStartLine], tokenEndLine: origin[span.tokenEndLine],
      })),
    };
  });
  return {
    lines,
    definitions: blocks.definitions.map((definition) => ({
      ...definition, startLine: origin[definition.startLine], endLine: origin[definition.endLine],
    })),
    labels: blocks.labels,
  };
}

function classifyMarkdownLines(raw: string[]): MarkdownBlocks & { repairs: Map<number, MarkdownRepair> } {
  // Tree delimiters and NUL never reach the renderer; one-for-one keeps columns.
  const source = raw.map((line) => line.replaceAll("\u0000", "\uFFFD").replace(MARKDOWN_TREE_DELIMITERS, "x"));
  // The probe prefix appears neither in the source nor in its rendering, where
  // an entity such as `&#101;` could otherwise spell it.
  const rendering = Bun.markdown.html(source.join("\n"), MARKDOWN_RENDER_OPTIONS).replace(MARKDOWN_TREE_DELIMITERS, "x");
  let prefix = "aidlcprobe";
  while (source.some((line) => line.includes(prefix)) || rendering.includes(prefix)) prefix += "x";
  const { probes, accepted, hits } = probeMarkdown(source, prefix);
  const located = [...hits.values()].sort((a, b) => a.probe.id - b.probe.id);
  const labels = markdownDefinedLabels(source.join("\n"), rendering);
  const labelLine = (index: number): boolean =>
    /^\[(?:\\.|[^\\[\]])+\]:/.test(raw[index].slice(MARKDOWN_CONTAINER_PREFIX.exec(raw[index])![0].length));
  // The label line of a link reference definition spanning `index`; its
  // destination and title lines follow the label.
  const definitionStart = (index: number): number | null => {
    for (let line = index; line >= Math.max(0, index - 2) && raw[line].trim() !== ""; line--) {
      if (labelLine(line)) return line;
    }
    return null;
  };
  const definitionLines = new Set<number>();

  const containers = new Map<number, MarkdownContainer>();
  const paths = new Map<number, MarkdownContainer[]>();
  // One shared array per rendered block, outermost container first.
  const pathOf = (block: RenderedMarkdownNode): MarkdownContainer[] => {
    let path = paths.get(block.id);
    if (path) return path;
    path = [];
    for (let node: RenderedMarkdownNode | null = block; node; node = node.parent) {
      if (node.tag !== "Q" && node.tag !== "L") continue;
      let container = containers.get(node.id);
      if (!container) {
        const list = node.parent?.tag === "LIST" ? node.parent : null;
        container = node.tag === "Q" ? { kind: "blockQuote" } : {
          kind: "listItem",
          ordered: list?.meta[0] === "1",
          start: list?.meta[1] ? Number(list.meta[1]) : null,
          id: node.id,
        };
        containers.set(node.id, container);
      }
      path.unshift(container);
    }
    paths.set(block.id, path);
    return path;
  };
  const nearest = (node: RenderedMarkdownNode | null, tags: ReadonlySet<string>): RenderedMarkdownNode | null => {
    for (let current = node; current; current = current.parent) if (tags.has(current.tag)) return current;
    return null;
  };

  // The first source line of each list item is the lowest probe inside it.
  const itemStarts = new Map<number, number>();
  for (const hit of located) {
    for (let node: RenderedMarkdownNode | null = hit.node; node; node = node.parent) {
      if (node.tag === "L") itemStarts.set(node.id, Math.min(itemStarts.get(node.id) ?? Infinity, hit.probe.line));
    }
  }
  // Lines up to an item's first probe (a bare marker or fence line) carry its marker.
  const prefixesOf = (index: number, block: RenderedMarkdownNode): Array<"quote" | "marker" | "indent"> =>
    pathOf(block).map((container) => container.kind === "blockQuote" ? "quote"
      : index <= (itemStarts.get(container.id) ?? Infinity) ? "marker" : "indent");

  const lines: MarkdownLine[] = raw.map((line) => ({
    kind: line.trim() === "" ? "blank" : "unknown",
    block: -1, containers: [], htmlKind: null, contentStart: markdownContentStart(line, []), invisible: [],
  }));
  const assigned = new Set<number>();
  const assign = (index: number, kind: MarkdownLineKind, block: RenderedMarkdownNode, htmlKind: MarkdownLine["htmlKind"] = null): void => {
    if (index < 0 || index >= lines.length || assigned.has(index)) return;
    assigned.add(index);
    lines[index] = {
      kind, block: block.id, containers: pathOf(block), htmlKind,
      contentStart: markdownContentStart(raw[index], prefixesOf(index, block)), invisible: [],
    };
  };
  const contentOf = (index: number, block: RenderedMarkdownNode): string =>
    raw[index].slice(markdownContentStart(raw[index], prefixesOf(index, block)));
  const lineCount = (text: string): number =>
    text === "" ? 0 : text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;

  // Code and HTML blocks render their source text line for line, so one
  // located probe fixes the whole block's extent.
  const extents = new Map<number, { start: number; count: number; node: RenderedMarkdownNode; indented: boolean }>();
  const leading = (text: string): number => /^[ \t]*/.exec(text)![0].length;
  for (const hit of located) {
    const block = hit.meta ? null : nearest(hit.node, MARKDOWN_RAW_BLOCKS);
    if (!block || extents.has(block.id)) continue;
    const text = renderedMarkdownText(block);
    const before = withoutMarkdownProbes(text.slice(0, text.indexOf(hit.probe.core)), prefix, probes).split("\n");
    const after = withoutMarkdownProbes(text.slice(text.indexOf(hit.probe.core)), prefix, probes).split("\n");
    // Indented code drops four columns of indentation; fenced content keeps
    // its source indentation. Measurable outside list items, whose own
    // indentation the renderer also drops.
    const rendered = before[before.length - 1] + after[0];
    const quoteless = raw[hit.probe.line].slice(/^(?:[ \t]{0,3}>[ \t]?)*/.exec(raw[hit.probe.line])![0].length);
    const listed = pathOf(block).some((container) => container.kind === "listItem");
    extents.set(block.id, {
      start: hit.probe.line - (before.length - 1),
      count: lineCount(withoutMarkdownProbes(text, prefix, probes)),
      node: block,
      indented: block.tag === "C" && !listed && leading(quoteless) - leading(rendered) >= 4,
    });
  }
  const openers = new Map<number, number>();
  for (const hit of located) if (hit.meta && hit.node.tag === "C") openers.set(hit.node.id, hit.probe.line);
  const closers = new Set<number>();
  const fences: Array<{ opener: number; closer: number }> = [];
  // HTML blocks whose first line keeps four or more columns of indentation,
  // which no HTML block start allows.
  const indentedHtml: number[] = [];
  for (const { start, count, node, indented } of [...extents.values()].sort((a, b) => a.start - b.start)) {
    if (node.tag === "X") {
      const first = withoutMarkdownProbes(renderedMarkdownText(node), prefix, probes).split("\n")[0];
      if (/^(?: {4}| {0,3}\t)/.test(first)) indentedHtml.push(start);
      for (let index = start; index < start + count; index++) assign(index, "htmlFlow", node, markdownHtmlKind(first.trimStart()));
      continue;
    }
    const opener = start - 1;
    const fenced = node.meta[0] !== "" || openers.has(node.id) ||
      (!indented && opener >= 0 && !closers.has(opener) && MARKDOWN_FENCE.test(contentOf(opener, node)));
    const kind = fenced ? "codeFenced" : "codeIndented";
    if (fenced) assign(opener, kind, node);
    for (let index = start; index < start + count; index++) assign(index, kind, node);
    const closer = start + count;
    if (fenced && closer < raw.length && MARKDOWN_FENCE.test(contentOf(closer, node))) {
      closers.add(closer);
      assign(closer, kind, node);
      if (opener >= 0) fences.push({ opener, closer });
    }
  }
  // A fenced block whose content carries no probe is located by its info string.
  for (const hit of located) {
    if (!hit.meta || hit.node.tag !== "C" || extents.has(hit.node.id)) continue;
    const count = lineCount(withoutMarkdownProbes(renderedMarkdownText(hit.node), prefix, probes));
    for (let index = hit.probe.line; index <= hit.probe.line + count; index++) assign(index, "codeFenced", hit.node);
    const closer = hit.probe.line + count + 1;
    if (closer < raw.length && MARKDOWN_FENCE.test(contentOf(closer, hit.node))) {
      assign(closer, "codeFenced", hit.node);
      fences.push({ opener: hit.probe.line, closer });
    }
  }

  // Blocks with inline content: a probe's line belongs to its leaf block, and
  // lines between two members of one block are its continuation lines.
  const members = new Map<number, { node: RenderedMarkdownNode; lines: number[] }>();
  const blockOf = (hit: MarkdownProbeHit): RenderedMarkdownNode | null => {
    const leaf = nearest(hit.node, MARKDOWN_LEAF_BLOCKS);
    return leaf ? nearest(leaf, new Set(["T"])) ?? leaf : null;
  };
  const join = (block: RenderedMarkdownNode, line: number): void => {
    const entry = members.get(block.id) ?? { node: block, lines: [] };
    entry.lines.push(line);
    members.set(block.id, entry);
  };
  // A GFM table row is one source line after the header and delimiter rows,
  // so any located row fixes the table's extent, even with no probe in its
  // header (a row of dashes looks like a delimiter).
  const tables = new Map<number, { header: number; rows: number }>();
  for (const hit of located) {
    if (hit.meta || nearest(hit.node, MARKDOWN_RAW_BLOCKS)) continue;
    const block = blockOf(hit);
    if (!block) continue;
    join(block, hit.probe.line);
    if (block.tag !== "T") continue;
    const rows = block.kids.filter((kid) => typeof kid !== "string" && kid.tag === "TR");
    const row = rows.indexOf(nearest(hit.node, new Set(["TR"]))!);
    if (row < 0) continue;
    const header = hit.probe.line - row - (row > 0 ? 1 : 0);
    tables.set(block.id, { header: Math.min(tables.get(block.id)?.header ?? header, header), rows: rows.length });
  }
  for (const hit of located) {
    if (!hit.meta || hit.node.tag === "C") continue;
    // A definition's destination and title surface in every link that
    // references it, not where the definition sits. Only an inline link's
    // destination continuing its own paragraph's lines joins that paragraph.
    const block = blockOf(hit);
    const own = block ? members.get(block.id)?.lines ?? [] : [];
    if (definitionStart(hit.probe.line) !== null) definitionLines.add(hit.probe.line);
    else if (block && own.some((line) => Math.abs(line - hit.probe.line) <= 1)) join(block, hit.probe.line);
  }
  const ordered = [...members.values()].sort((a, b) => Math.min(...a.lines) - Math.min(...b.lines));
  const kindOf = (node: RenderedMarkdownNode): MarkdownLineKind =>
    node.tag === "H" ? "heading" : node.tag === "T" ? "table" : "paragraph";
  // Each probe's own line first, so one block's range never overwrites a
  // line another block rendered (a heading inside a tight list item).
  for (const { node, lines: memberLines } of ordered) {
    for (const index of memberLines) assign(index, kindOf(node), node);
  }
  for (const { node, lines: memberLines } of ordered) {
    const table = tables.get(node.id);
    const first = table ? Math.max(0, table.header) : Math.min(...memberLines);
    const last = table ? Math.min(raw.length - 1, table.header + table.rows) : Math.max(...memberLines);
    const kind = kindOf(node);
    for (let index = first; index <= last; index++) assign(index, kind, node);
    const next = last + 1;
    if (next >= raw.length) continue;
    if (node.tag === "H" && !/^#{1,6}(?:[ \t]|$)/.test(contentOf(first, node)) &&
      MARKDOWN_SETEXT_UNDERLINE.test(contentOf(next, node))) {
      assign(next, "heading", node);
    }
  }

  // An accepted primary probe that rendered nowhere was consumed by a link
  // reference definition; consecutive consumed lines form one definition.
  const consumed = new Set(probes
    .filter((probe) => probe.role === "primary" && accepted.has(probe.id) && !hits.has(probe.id))
    .map((probe) => probe.line)
    .concat([...definitionLines])
    .filter((line) => !assigned.has(line)));
  const definitions: MarkdownDefinition[] = [];
  for (let index = 0; index < raw.length; index++) {
    if (!consumed.has(index)) continue;
    // Each label line starts its own definition.
    let end = index;
    while (consumed.has(end + 1) && !labelLine(end + 1)) end++;
    const opening = definitionStart(index);
    const start = opening !== null && opening < index && !assigned.has(opening) ? opening : index;
    const label = /^\[((?:\\.|[^\\[\]])+)\]:/.exec(raw.slice(start, end + 1).join("\n").slice(MARKDOWN_CONTAINER_PREFIX.exec(raw[start])![0].length));
    definitions.push({ label: label ? normalizeMarkdownLabel(label[1]) : "", startLine: start, endLine: end });
    for (let line = start; line <= end; line++) {
      assigned.add(line);
      lines[line].kind = "definition";
    }
    index = end;
  }
  // A fence with neither an info string nor probe-bearing content. Only lines
  // without letters or digits are still unplaced, so none of them can carry a
  // heading or control tag.
  for (let index = 0; index < raw.length; index++) {
    const opener = MARKDOWN_FENCE.exec(raw[index].slice(MARKDOWN_CONTAINER_PREFIX.exec(raw[index])![0].length));
    if (assigned.has(index) || !opener) continue;
    let end = index;
    for (let line = index; line < raw.length && (line === index || !assigned.has(line)); line++) {
      end = line;
      assigned.add(line);
      lines[line].kind = "codeFenced";
      const closing = /^(`{3,}|~{3,})[ \t]*$/.exec(raw[line].slice(MARKDOWN_CONTAINER_PREFIX.exec(raw[line])![0].length));
      if (line > index && closing && closing[1][0] === opener[1][0] && closing[1].length >= opener[1].length) {
        fences.push({ opener: index, closer: line });
        break;
      }
    }
    index = end;
  }
  for (let index = 0; index < raw.length; index++) {
    // After any quote and list markers, but keeping plain indentation.
    const content = raw[index].slice(/^(?:[ \t]{0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)))*/.exec(raw[index])![0].length);
    if (lines[index].kind === "unknown" && (MARKDOWN_THEMATIC_BREAK.test(raw[index]) || MARKDOWN_THEMATIC_BREAK.test(content))) {
      lines[index].kind = "thematicBreak";
    }
  }

  // Inline code and raw HTML keep their line breaks when rendered, so a located
  // probe gives exact source columns on every line the span covers.
  const spans = new Set<number>();
  for (const hit of located) {
    const span = hit.meta ? null : nearest(hit.node, MARKDOWN_INLINE_SPANS);
    if (!span || MARKDOWN_RAW_BLOCKS.has(span.tag) || spans.has(span.id)) continue;
    // Chunks inside code or a raw HTML block are that block's literal text.
    if (nearest(span.parent, new Set(["c", "C", "X"]))) continue;
    spans.add(span.id);
    const text = renderedMarkdownText(span);
    // Measure from the whole insertion, which may include a separating space.
    const inserted = text.includes(hit.probe.insert) ? hit.probe.insert : hit.probe.core;
    const at = text.indexOf(inserted);
    const before = withoutMarkdownProbes(text.slice(0, at), prefix, probes).split("\n");
    const after = withoutMarkdownProbes(text.slice(at + inserted.length), prefix, probes).split("\n");
    const startLine = hit.probe.line - (before.length - 1);
    const endLine = hit.probe.line + (after.length - 1);
    let startColumn = startLine === hit.probe.line
      ? hit.probe.column - before[0].length
      : raw[startLine].length - before[0].length;
    let endColumn = endLine === hit.probe.line
      ? hit.probe.column + after[0].length
      : lines[endLine].contentStart + after[after.length - 1].length;
    const kind: MarkdownSpan["kind"] = span.tag === "c" ? "codeText" : text.startsWith("<!--") ? "htmlComment" : "htmlText";
    if (kind === "codeText") {
      // The span includes its backtick runs and any stripped padding space.
      startColumn -= /(`+) ?$/.exec(raw[startLine].slice(0, startColumn))?.[0].length ?? 0;
      endColumn += /^ ?(`+)/.exec(raw[endLine].slice(endColumn))?.[0].length ?? 0;
    }
    for (let index = startLine; index <= endLine; index++) {
      lines[index].invisible.push({
        start: index === startLine ? startColumn : lines[index].contentStart,
        end: index === endLine ? endColumn : raw[index].length,
        kind, tokenStartLine: startLine, tokenEndLine: endLine,
      });
    }
  }
  for (const line of lines) line.invisible.sort((a, b) => a.start - b.start);
  const blocks = { lines, definitions, labels };
  // With its fence replaced by a word, a line inside the list item holding an
  // unclosed fenced block renders inside that code block; outside, it cannot
  // (a fence content line has no lazy continuation).
  const fenceLineInside = (closer: number): boolean => {
    const word = `${prefix}fence${closer}z`;
    const indentation = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*/.exec(source[closer])![0];
    const tree = renderMarkdownTree(source.map((line, index) => index === closer ? indentation + word : line).join("\n"));
    const holder = (node: RenderedMarkdownNode): RenderedMarkdownNode | null => {
      for (const kid of node.kids) {
        const found = typeof kid === "string" ? (kid.includes(word) ? node : null) : holder(kid);
        if (found) return found;
      }
      return null;
    };
    return nearest(holder(tree), new Set(["C"])) !== null;
  };
  return { ...blocks, repairs: markdownRepairs(raw, blocks, fences, indentedHtml, fenceLineInside) };
}

// Project parser-owned ranges without changing the historical line/marker API.
// In particular, same-line code remains verbatim and retained digest input is
// still raw source; these strings only select headings and control fields.
export function visibleMarkdownLines(
	content: string,
	options: { preserveIndentedCode?: boolean; preserveCommentBoundaries?: boolean } = {},
): string[] {
	return projectVisibleMarkdownLines(content, markdownBlocks(content), options);
}

export function projectVisibleMarkdownLines(
	content: string,
	blocks: MarkdownBlocks,
	options: { preserveIndentedCode?: boolean; preserveCommentBoundaries?: boolean },
): string[] {
	const raw = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
	return raw.map((source, index) => {
		const block = blocks.lines[index];
		const line = source.replaceAll(INVISIBLE_COMMENT_MARKER, RAW_INVISIBLE_COMMENT_MARKER_ESCAPE);
		if (block.kind === "codeFenced" || (block.kind === "codeIndented" && !options.preserveIndentedCode)) return "";
		if (block.kind === "htmlFlow" && block.htmlKind !== 2) {
			if (block.htmlKind! <= 5) return "";
			return options.preserveCommentBoundaries ? INVISIBLE_LINE_MARKER + line : "";
		}
		// Keep the legacy lexical indentation projection, even when indentation
		// continues a paragraph rather than opening an indented-code block.
		// Container prefixes and inline continuation eligibility remain parser-owned.
		if (!options.preserveIndentedCode && block.kind !== "htmlFlow" &&
			!block.invisible.some((span) => span.tokenStartLine! < index) &&
			/(?:^|> ?)(?: {4}|\t)/.test(line.slice(0, block.contentStart))) return "";
		let visible = "";
		let cursor = 0;
		if (block.kind === "htmlFlow" && block.htmlKind === 2) {
			// The parser determines comment-block extent and container exits. Only
			// project delimiters here; fence/code-looking bytes inside are literal.
			const previous = blocks.lines[index - 1];
			// Every leaf block shares one container-path array across its lines.
			const continued = previous?.kind === "htmlFlow" && previous.htmlKind === 2 &&
				previous.containers === block.containers;
			const opening = continued ? -1 : line.indexOf("<!--", block.contentStart);
			const closing = line.indexOf("-->", opening < 0 ? block.contentStart : opening + 4);
			if (opening >= 0) visible = line.slice(0, opening) + INVISIBLE_COMMENT_MARKER;
			if (closing >= 0) visible += INVISIBLE_COMMENT_MARKER + line.slice(closing + 3)
				.replace(/<!--[\s\S]*?-->/g, INVISIBLE_COMMENT_MARKER + INVISIBLE_COMMENT_MARKER);
			return options.preserveCommentBoundaries ? visible : restoreVisibleMarkdownMarkers(visible);
		}
		for (const span of block.invisible) {
			const continued = span.tokenStartLine! < index;
			const continues = span.tokenEndLine! > index;
			if (span.kind === "codeText") {
				if (!continued && !continues) continue;
				if (continued && continues) return "";
				visible += continued ? INVISIBLE_LINE_MARKER : line.slice(cursor, span.start) + INVISIBLE_LINE_MARKER;
				cursor = span.end;
			} else if (span.kind === "htmlComment") {
				if (continued && !visible.startsWith(INVISIBLE_LINE_MARKER)) visible = INVISIBLE_LINE_MARKER + visible;
				visible += line.slice(cursor, span.start);
				if (!continued) visible += INVISIBLE_COMMENT_MARKER;
				if (!continues) visible += INVISIBLE_COMMENT_MARKER;
				cursor = span.end;
			} else if (continued && !visible.startsWith(INVISIBLE_LINE_MARKER)) {
				visible = INVISIBLE_LINE_MARKER + visible;
			}
		}
		visible += line.slice(cursor);
		return options.preserveCommentBoundaries ? visible : restoreVisibleMarkdownMarkers(visible);
	});
}

export function appendUnderHeading(
  content: string,
  heading: string,
  newContent: string,
): string {
  // Inserts `newContent` immediately before the next `## ` heading after
  // `heading` (or at end-of-file when `heading` is the last `## ` section).
  // Throws if `heading` is not present in `content`.
  const headingRegex = new RegExp(
    `^${escapeRegex(heading)}[ \\t]*$`,
    "m",
  );
  const startMatch = headingRegex.exec(content);
  if (!startMatch) {
    throw new Error(`appendUnderHeading: heading not found: ${heading}`);
  }
  const afterHeading = startMatch.index + startMatch[0].length;
  const bodyStart = content[afterHeading] === "\n" ? afterHeading + 1 : afterHeading;
  const nextHeading = /^## [^\n]*$/m;
  const remainder = content.slice(bodyStart);
  const nextMatch = nextHeading.exec(remainder);
  const insertAt = nextMatch ? bodyStart + nextMatch.index : content.length;
  // When the insertion point is a following `## ` heading, callers that pass
  // single-`\n`-terminated content would abut the heading with no separating
  // blank line, producing malformed markdown (e.g. a bullet directly above
  // `## Scope Overrides` in project.md). Add exactly one blank line in that
  // case — but only when a heading actually follows (never in the terminal
  // end-of-file append) and the content does not already end with a blank line.
  const separator =
    nextMatch && newContent.endsWith("\n") && !newContent.endsWith("\n\n")
      ? "\n"
      : "";
  return content.slice(0, insertAt) + newContent + separator + content.slice(insertAt);
}

export function replaceSection(
  content: string,
  heading: string,
  newContent: string,
): string {
  // Replaces the prose between `heading` and the next `## ` heading (or EOF)
  // with `newContent`. The heading line itself is preserved. Throws if
  // `heading` is not present. Used by practices-discovery affirmation:
  // re-runs overwrite aidlc-team.md sections rather than accumulating duplicates.
  const headingRegex = new RegExp(
    `^${escapeRegex(heading)}[ \\t]*$`,
    "m",
  );
  const startMatch = headingRegex.exec(content);
  if (!startMatch) {
    throw new Error(`replaceSection: heading not found: ${heading}`);
  }
  const afterHeading = startMatch.index + startMatch[0].length;
  const bodyStart = content[afterHeading] === "\n" ? afterHeading + 1 : afterHeading;
  const nextHeading = /^## [^\n]*$/m;
  const remainder = content.slice(bodyStart);
  const nextMatch = nextHeading.exec(remainder);
  const bodyEnd = nextMatch ? bodyStart + nextMatch.index : content.length;
  return content.slice(0, bodyStart) + newContent + content.slice(bodyEnd);
}
