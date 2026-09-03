import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { renderFeedbackFrontmatter, type DecisionHint } from "./aidlc-review-ui-shared.ts";

export type AnnotationKind = "comment" | "delete" | "looks-good" | "label" | "edit";

export interface ReviewAnnotation {
  artifact: string;
  kind: AnnotationKind;
  heading_path: string[];
  selection?: string;
  line_start?: number;
  line_end?: number;
  css_path?: string;
  body?: string;
  after?: string;
}

export interface FeedbackRequest {
  stage: string;
  unit: string | null;
  revision: number;
  decision_hint: DecisionHint;
  general?: string;
  annotations: ReviewAnnotation[];
}

export type DiffLine = {
  type: "context" | "add" | "delete";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface LineDiffResult {
  hunks: DiffHunk[];
  unified: string;
}

export class PathConfinementError extends Error {
  constructor(message = "path escapes the project aidlc directory") {
    super(message);
    this.name = "PathConfinementError";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve an existing project-relative POSIX path without following a symlink outside aidlc/. */
export function resolveProjectAidlcPath(projectDir: string, projectRelativePath: string): string {
  if (
    projectRelativePath.length === 0 ||
    projectRelativePath.includes("\0") ||
    projectRelativePath.includes("\\") ||
    projectRelativePath.startsWith("/")
  ) {
    throw new PathConfinementError();
  }
  const segments = projectRelativePath.split("/");
  if (segments[0] !== "aidlc" || segments.some((part) => part === ".." || part === "")) {
    throw new PathConfinementError();
  }

  const aidlcRoot = resolve(projectDir, "aidlc");
  const candidate = resolve(projectDir, ...segments);
  if (!isWithin(aidlcRoot, candidate)) throw new PathConfinementError();

  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = realpathSync(aidlcRoot);
    candidateReal = realpathSync(candidate);
  } catch (error) {
    if (!existsSync(candidate)) throw error;
    throw new PathConfinementError();
  }
  if (!isWithin(rootReal, candidateReal)) throw new PathConfinementError();
  return candidateReal;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|colon|tab|newline);?/gi, (_all, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "colon") return ":";
    if (lower === "tab") return "\t";
    if (lower === "newline") return "\n";
    const radix = lower.startsWith("#x") ? 16 : 10;
    const digits = lower.slice(radix === 16 ? 2 : 1);
    const codepoint = Number.parseInt(digits, radix);
    return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : "";
  });
}

function unsafeUrl(value: string): boolean {
  const normalized = decodeHtmlEntities(value)
    .replace(/[\u0000-\u0020\u007f]+/g, "")
    .toLowerCase();
  return normalized.startsWith("javascript:") || normalized.startsWith("data:text/html");
}

/** A deliberately small allow-by-removal sanitizer for Bun.markdown output and embedded HTML. */
export function sanitizeHtml(input: string): string {
  let html = input;
  for (const tag of ["script", "iframe", "object", "embed", "form"]) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    let previous: string;
    do {
      previous = html;
      html = html.replace(paired, "");
    } while (html !== previous);
    html = html.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
  }

  return html.replace(/<([a-z][a-z0-9:-]*)(\s[^<>]*?)?>/gi, (_tag, name: string, rawAttrs = "") => {
    let attrs = rawAttrs as string;
    attrs = attrs.replace(
      /\s+on[a-z0-9_:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      "",
    );
    attrs = attrs.replace(
      /\s+(href|src|xlink:href|action|formaction|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (attribute, _key: string, _wrapped: string, double: string, single: string, bare: string) => {
        const value = double ?? single ?? bare ?? "";
        return unsafeUrl(value) ? "" : attribute;
      },
    );
    return `<${name}${attrs}>`;
  });
}

function headingSlug(value: string): string {
  const plain = decodeHtmlEntities(value.replace(/<[^>]+>/g, ""))
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return plain || "section";
}

/** Render Markdown with stable heading ids and native Mermaid fence recognition. */
export function renderMarkdown(markdown: string): string {
  if (typeof Bun.markdown?.render !== "function") {
    throw new Error("Bun.markdown.render is unavailable");
  }
  const ids = new Map<string, number>();
  const rendered = Bun.markdown.render(markdown, {
    heading: (children, { level }) => {
      const base = headingSlug(children);
      const count = ids.get(base) ?? 0;
      ids.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count + 1}`;
      return `<h${level} id="${id}">${children}</h${level}>`;
    },
    code: (children, metadata) => {
      const language = metadata?.language;
      const source = escapeHtml(children.replace(/\n$/, ""));
      if (language?.toLowerCase() === "mermaid") {
        return `<pre class="mermaid">${source}</pre>`;
      }
      const languageClass = language
        ? ` class="language-${escapeHtml(language.replace(/[^a-z0-9_-]/gi, ""))}"`
        : "";
      return `<pre><code${languageClass}>${source}</code></pre>`;
    },
  });
  return sanitizeHtml(rendered);
}

type DiffOp = { type: "context" | "add" | "delete"; text: string };

function splitLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lcsOperations(before: string, after: string): DiffOp[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      const offset = oldIndex * width + newIndex;
      table[offset] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * width + newIndex], table[offset + 1]);
    }
  }

  const operations: DiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push({ type: "context", text: oldLines[oldIndex] });
      oldIndex++;
      newIndex++;
    } else if (table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1]) {
      operations.push({ type: "delete", text: oldLines[oldIndex++] });
    } else {
      operations.push({ type: "add", text: newLines[newIndex++] });
    }
  }
  while (oldIndex < oldLines.length) operations.push({ type: "delete", text: oldLines[oldIndex++] });
  while (newIndex < newLines.length) operations.push({ type: "add", text: newLines[newIndex++] });
  return operations;
}

function createHunks(operations: DiffOp[], context: number): DiffHunk[] {
  const changed = operations
    .map((operation, index) => (operation.type === "context" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return [];

  const spans: Array<[number, number]> = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(operations.length, changed[0] + context + 1);
  for (const index of changed.slice(1)) {
    const nextStart = Math.max(0, index - context);
    const nextEnd = Math.min(operations.length, index + context + 1);
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else {
      spans.push([start, end]);
      start = nextStart;
      end = nextEnd;
    }
  }
  spans.push([start, end]);

  let oldCursor = 1;
  let newCursor = 1;
  const oldAt: number[] = [];
  const newAt: number[] = [];
  for (const operation of operations) {
    oldAt.push(oldCursor);
    newAt.push(newCursor);
    if (operation.type !== "add") oldCursor++;
    if (operation.type !== "delete") newCursor++;
  }

  return spans.map(([from, to]) => {
    let oldLine = oldAt[from] ?? oldCursor;
    let newLine = newAt[from] ?? newCursor;
    const lines: DiffLine[] = [];
    for (const operation of operations.slice(from, to)) {
      lines.push({
        type: operation.type,
        text: operation.text,
        oldLine: operation.type === "add" ? null : oldLine,
        newLine: operation.type === "delete" ? null : newLine,
      });
      if (operation.type !== "add") oldLine++;
      if (operation.type !== "delete") newLine++;
    }
    const oldLines = lines.filter((line) => line.type !== "add").length;
    const newLines = lines.filter((line) => line.type !== "delete").length;
    return {
      oldStart: oldLines === 0 ? Math.max(0, (oldAt[from] ?? oldCursor) - 1) : (oldAt[from] ?? oldCursor),
      oldLines,
      newStart: newLines === 0 ? Math.max(0, (newAt[from] ?? newCursor) - 1) : (newAt[from] ?? newCursor),
      newLines,
      lines,
    };
  });
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

export function lineDiff(
  before: string,
  after: string,
  labels: { before?: string; after?: string } = {},
  context = 3,
): LineDiffResult {
  const hunks = createHunks(lcsOperations(before, after), context);
  const output = [`--- ${labels.before ?? "a/source"}`, `+++ ${labels.after ?? "b/source"}`];
  for (const hunk of hunks) {
    output.push(`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`);
    for (const line of hunk.lines) {
      output.push(`${line.type === "add" ? "+" : line.type === "delete" ? "-" : " "}${line.text}`);
    }
  }
  return { hunks, unified: `${output.join("\n")}\n` };
}

function quotedSelection(selection: string): string {
  return selection.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function annotationHeading(annotation: ReviewAnnotation): string {
  const names: Record<Exclude<AnnotationKind, "edit">, string> = {
    comment: "Comment",
    delete: "Delete",
    "looks-good": "Looks good",
    label: "Label",
  };
  if (annotation.kind === "edit") return "### Edit (unified diff)";
  let heading = `### ${names[annotation.kind]}`;
  if (annotation.heading_path.length > 0) heading += ` — ${annotation.heading_path.join(" › ")}`;
  if (annotation.line_start !== undefined) {
    const end = annotation.line_end ?? annotation.line_start;
    heading += ` (lines ~${annotation.line_start}-${end})`;
  }
  if (annotation.css_path) heading += ` (element: ${annotation.css_path})`;
  return heading;
}

export function renderFeedbackMarkdown(
  input: FeedbackRequest,
  options: { created?: string; sources?: Readonly<Record<string, string>> } = {},
): string {
  const created = options.created ?? new Date().toISOString();
  const sections = new Map<string, ReviewAnnotation[]>();
  for (const annotation of input.annotations) {
    const artifact = basename(annotation.artifact);
    const existing = sections.get(artifact);
    if (existing) existing.push(annotation);
    else sections.set(artifact, [annotation]);
  }

  const body: string[] = [
    `# Review feedback: ${input.stage} (revision ${input.revision})`,
    "",
  ];
  for (const [artifact, annotations] of sections) {
    body.push(`## ${artifact}`, "");
    for (const annotation of annotations) {
      body.push(annotationHeading(annotation));
      if (annotation.kind === "edit") {
        const before = options.sources?.[artifact] ?? "";
        body.push(
          "```diff",
          lineDiff(before, annotation.after ?? "", {
            before: `a/${artifact}`,
            after: `b/${artifact}`,
          }).unified.trimEnd(),
          "```",
          "",
        );
        continue;
      }
      if (annotation.selection) body.push(quotedSelection(annotation.selection), "");
      if (annotation.kind === "label" && annotation.body) {
        body.push(`\`${annotation.body.replaceAll("`", "\\`")}\``, "");
      } else if (annotation.body) {
        body.push(annotation.body, "");
      }
    }
  }
  if (input.general?.trim()) body.push("## General notes", "", input.general.trim(), "");

  return `${renderFeedbackFrontmatter({
    aidlc_review_feedback: 1,
    stage: input.stage,
    unit: input.unit,
    revision: input.revision,
    created,
    decision_hint: input.decision_hint,
  })}${body.join("\n").trimEnd()}\n`;
}

export function injectBridge(html: string): string {
  const bridge = '<script src="/assets/bridge.js"></script>';
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head || head.index === undefined) return `${bridge}${html}`;
  const offset = head.index + head[0].length;
  return `${html.slice(0, offset)}${bridge}${html.slice(offset)}`;
}

const EXPORT_CSS = `
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.55}
body{max-width:70rem;margin:0 auto;padding:2rem}pre{overflow:auto;padding:1rem;background:#0001;border-radius:.4rem}
code{font-family:ui-monospace,SFMono-Regular,monospace}blockquote{border-left:.25rem solid #888;padding-left:1rem;margin-left:0}
table{border-collapse:collapse}th,td{border:1px solid #888;padding:.35rem .6rem}img{max-width:100%;height:auto}
`.trim();

export function selfContainedMarkdownExport(markdown: string, mermaidScript = ""): string {
  const script = mermaidScript
    ? `<script>${mermaidScript.replaceAll("</script", "<\\/script")}</script><script>mermaid.initialize({startOnLoad:true});</script>`
    : "";
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style>${EXPORT_CSS}</style>${script}</head><body>`,
    renderMarkdown(markdown),
    "</body></html>",
  ].join("");
}
