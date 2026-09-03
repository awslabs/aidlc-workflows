import { Buffer } from "node:buffer";
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

export interface ReviewQuestionOption {
  letter: string | null;
  text: string;
}

export interface ReviewQuestion {
  id: string;
  title: string;
  prompt: string;
  options: ReviewQuestionOption[];
  multi: boolean;
  answer: string | null;
  note: string | null;
  confirmation: boolean;
}

export interface AnswerSubmissionEntry {
  id: string;
  labels?: string[];
  other?: string;
  note?: string;
}

interface MarkdownSectionLine {
  text: string;
  structural: boolean;
}

interface MarkdownH2Section {
  title: string;
  body: MarkdownSectionLine[];
}

const QUESTION_TITLE = /^Q([1-9][0-9]*)(?:[.:](?:[ \t]+.*)?)?$/;
const ANSWER_LINE = /^\[Answer\]:[ \t]*(.*)$/;
const NOTE_LINE = /^\[Note\]:[ \t]*(.*)$/;
const OPTION_LINE = /^([A-Z])\.\s+(.*)$/;
const SUMMARY_CONFIRMATION_TITLE = "Consolidated Summary Confirmation";
const MAX_ANSWER_ID_LENGTH = 128;
const MAX_ANSWER_TEXT_LENGTH = 64 * 1024;

function atxH2Title(line: string): string | null {
  const match = /^ {0,3}##(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (match === null) return null;
  return (match[1] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
}

function markdownH2Sections(source: string): MarkdownH2Section[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const sections: MarkdownH2Section[] = [];
  let current: MarkdownH2Section | null = null;
  let fenceCharacter: "`" | "~" | null = null;
  let fenceLength = 0;
  let inComment = false;
  let rawHtmlEnd: RegExp | null = null;

  for (const rawLine of lines) {
    if (rawHtmlEnd !== null) {
      if (current !== null) current.body.push({ text: rawLine, structural: false });
      if (rawHtmlEnd.test(rawLine)) rawHtmlEnd = null;
      continue;
    }
    if (fenceCharacter !== null) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rawLine);
      if (current !== null) current.body.push({ text: rawLine, structural: false });
      if (
        closing !== null &&
        closing[1][0] === fenceCharacter &&
        closing[1].length >= fenceLength
      ) {
        fenceCharacter = null;
        fenceLength = 0;
      }
      continue;
    }

    let line = "";
    let cursor = 0;
    while (cursor < rawLine.length) {
      if (inComment) {
        const end = rawLine.indexOf("-->", cursor);
        if (end === -1) {
          cursor = rawLine.length;
          continue;
        }
        inComment = false;
        cursor = end + 3;
        continue;
      }
      const start = rawLine.indexOf("<!--", cursor);
      if (start === -1) {
        line += rawLine.slice(cursor);
        break;
      }
      line += rawLine.slice(cursor, start);
      inComment = true;
      cursor = start + 4;
    }
    const rawHtml = /^ {0,3}<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(line);
    if (rawHtml !== null) {
      const closing = new RegExp(`</${rawHtml[1]}>`, "i");
      if (!closing.test(line.slice(rawHtml[0].length))) rawHtmlEnd = closing;
      if (current !== null) current.body.push({ text: line, structural: false });
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (
      opening !== null &&
      !(opening[1][0] === "`" && opening[2].includes("`"))
    ) {
      fenceCharacter = opening[1][0] as "`" | "~";
      fenceLength = opening[1].length;
      if (current !== null) current.body.push({ text: line, structural: false });
      continue;
    }

    const structural = !/^(?: {4}|\t)/.test(line);
    const title = structural ? atxH2Title(line) : null;
    if (title !== null) {
      current = { title, body: [] };
      sections.push(current);
    } else if (current !== null) {
      current.body.push({ text: line, structural });
    }
  }

  return sections;
}

function trimmedParagraphs(lines: readonly string[]): string {
  const normalized = lines.map((line) => line.replace(/[ \t]+$/, ""));
  while (normalized.length > 0 && normalized[0].trim() === "") normalized.shift();
  while (normalized.length > 0 && normalized[normalized.length - 1].trim() === "") {
    normalized.pop();
  }

  const compact: string[] = [];
  for (const line of normalized) {
    if (line.trim() === "") {
      if (compact.length > 0 && compact[compact.length - 1] !== "") compact.push("");
    } else {
      compact.push(line);
    }
  }
  return compact.join("\n");
}

function parseQuestionSection(
  section: MarkdownH2Section,
  id: string,
  confirmation: boolean,
): ReviewQuestion {
  let answer: string | null = null;
  let note: string | null = null;
  let contentEnd = section.body.length;

  for (let index = 0; index < section.body.length; index++) {
    const line = section.body[index];
    if (!line.structural) continue;
    const answerMatch = ANSWER_LINE.exec(line.text);
    if (answerMatch !== null) {
      contentEnd = Math.min(contentEnd, index);
      if (answer === null) answer = answerMatch[1].trim() || null;
      continue;
    }
    const noteMatch = NOTE_LINE.exec(line.text);
    if (noteMatch !== null) {
      contentEnd = Math.min(contentEnd, index);
      if (note === null) note = noteMatch[1].trim() || null;
    }
  }

  const options: ReviewQuestionOption[] = [];
  const promptLines: string[] = [];
  for (const line of section.body.slice(0, contentEnd)) {
    if (confirmation) {
      if (line.structural && (line.text === "- Looks correct" || line.text === "- Request changes")) {
        options.push({ letter: null, text: line.text.slice(2) });
      } else {
        promptLines.push(line.text);
      }
      continue;
    }

    const optionMatch = line.structural ? OPTION_LINE.exec(line.text) : null;
    if (optionMatch !== null && optionMatch[2].trim() !== "") {
      options.push({ letter: optionMatch[1], text: optionMatch[2].trim() });
    } else {
      promptLines.push(line.text);
    }
  }

  const prompt = trimmedParagraphs(promptLines);
  return {
    id,
    title: section.title,
    prompt,
    options,
    multi: !confirmation && /\(select all that apply\)/i.test(`${section.title}\n${prompt}`),
    answer,
    note,
    confirmation,
  };
}

export function parseQuestionsMarkdown(source: string): ReviewQuestion[] {
  const questions: ReviewQuestion[] = [];
  for (const section of markdownH2Sections(source)) {
    if (section.title === SUMMARY_CONFIRMATION_TITLE) {
      questions.push(parseQuestionSection(section, "summary-confirmation", true));
      continue;
    }
    const match = QUESTION_TITLE.exec(section.title);
    if (match !== null) questions.push(parseQuestionSection(section, `Q${match[1]}`, false));
  }
  return questions;
}

function invalidAnswer(message: string): never {
  throw new Error(`invalid question answers: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateQuestionAnswers(
  questions: readonly ReviewQuestion[],
  value: unknown,
): AnswerSubmissionEntry[] {
  if (!Array.isArray(value)) invalidAnswer("answers must be an array");

  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const seenIds = new Set<string>();
  const normalized: AnswerSubmissionEntry[] = [];

  for (let index = 0; index < value.length; index++) {
    const candidate: unknown = value[index];
    if (!isPlainObject(candidate)) invalidAnswer(`entry ${index + 1} must be a plain object`);

    const id = candidate.id;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ANSWER_ID_LENGTH) {
      invalidAnswer(`entry ${index + 1} has an invalid id`);
    }
    if (seenIds.has(id)) invalidAnswer(`duplicate question id "${id}"`);
    seenIds.add(id);

    const question = questionsById.get(id);
    if (question === undefined) invalidAnswer(`unknown question id "${id}"`);
    if (id === "summary-confirmation" || question.confirmation) {
      invalidAnswer(`question "${id}" is read-only`);
    }
    let labels: string[] | undefined;
    if (candidate.labels !== undefined) {
      if (!Array.isArray(candidate.labels) || candidate.labels.length > 26) {
        invalidAnswer(`question "${id}" has malformed labels`);
      }
      labels = [];
      const seenLabels = new Set<string>();
      const validLabels = new Set(
        question.options.flatMap((option) => option.letter === null ? [] : [option.letter]),
      );
      for (const rawLabel of candidate.labels) {
        if (typeof rawLabel !== "string" || !/^[A-Za-z]$/.test(rawLabel)) {
          invalidAnswer(`question "${id}" has malformed label`);
        }
        const label = rawLabel.toUpperCase();
        if (seenLabels.has(label)) invalidAnswer(`question "${id}" repeats label "${label}"`);
        if (!validLabels.has(label)) invalidAnswer(`label "${label}" is not valid for question "${id}"`);
        seenLabels.add(label);
        labels.push(label);
      }
      if (!question.multi && labels.length > 1) {
        invalidAnswer(`question "${id}" accepts only one label`);
      }
    }

    let other: string | undefined;
    if (candidate.other !== undefined) {
      if (
        typeof candidate.other !== "string" ||
        candidate.other.length > MAX_ANSWER_TEXT_LENGTH
      ) {
        invalidAnswer(`question "${id}" has invalid other text`);
      }
      other = candidate.other.trim();
    }

    const hasOtherLabel = labels?.includes("X") ?? false;
    if (hasOtherLabel && !other) invalidAnswer(`question "${id}" requires other text for label X`);
    if (!hasOtherLabel && candidate.other !== undefined) {
      invalidAnswer(`question "${id}" has other text without label X`);
    }

    let note: string | undefined;
    if (candidate.note !== undefined) {
      if (typeof candidate.note !== "string" || candidate.note.length > MAX_ANSWER_TEXT_LENGTH) {
        invalidAnswer(`question "${id}" has an invalid note`);
      }
      note = candidate.note.trim();
    }

    const entry: AnswerSubmissionEntry = { id };
    if (labels !== undefined) entry.labels = labels;
    if (other !== undefined) entry.other = other;
    if (note !== undefined) entry.note = note;
    normalized.push(entry);
  }

  return normalized;
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

/**
 * Render Markdown with stable heading ids and native Mermaid fence recognition.
 * `Bun.markdown.html` is the complete renderer; `Bun.markdown.render` with
 * callbacks emits ONLY the callback-handled nodes and degrades paragraphs,
 * lists, and tables to bare text, so headings/mermaid are post-processed here.
 */
export function renderMarkdown(markdown: string): string {
  if (typeof Bun.markdown?.html !== "function") {
    throw new Error("Bun.markdown.html is unavailable");
  }
  const ids = new Map<string, number>();
  const rendered = Bun.markdown.html(markdown)
    .replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, level: string, children: string) => {
      const base = headingSlug(children);
      const count = ids.get(base) ?? 0;
      ids.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count + 1}`;
      return `<h${level} id="${id}">${children}</h${level}>`;
    })
    .replace(
      /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
      (_match, source: string) => `<pre class="mermaid">${source.replace(/\n$/, "")}</pre>`,
    );
  return sanitizeHtml(rendered);
}

type DiffOp = { type: "context" | "add" | "delete"; text: string };

function splitLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
function myersOperations(before: string, after: string): DiffOp[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const maximum = oldLines.length + newLines.length;
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];

  for (let distance = 0; distance <= maximum; distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const deleting = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      const adding = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      let oldIndex = diagonal === -distance || (diagonal !== distance && deleting < adding)
        ? adding
        : deleting + 1;
      if (!Number.isFinite(oldIndex)) oldIndex = 0;
      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < oldLines.length &&
        newIndex < newLines.length &&
        oldLines[oldIndex] === newLines[newIndex]
      ) {
        oldIndex++;
        newIndex++;
      }
      frontier.set(diagonal, oldIndex);
      if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
        const operations: DiffOp[] = [];
        let backOld = oldLines.length;
        let backNew = newLines.length;
        for (let step = distance; step > 0; step--) {
          const previous = trace[step];
          const currentDiagonal = backOld - backNew;
          const left = previous.get(currentDiagonal - 1) ?? Number.NEGATIVE_INFINITY;
          const down = previous.get(currentDiagonal + 1) ?? Number.NEGATIVE_INFINITY;
          const previousDiagonal = currentDiagonal === -step ||
              (currentDiagonal !== step && left < down)
            ? currentDiagonal + 1
            : currentDiagonal - 1;
          const previousOld = previous.get(previousDiagonal) ?? 0;
          const previousNew = previousOld - previousDiagonal;
          while (backOld > previousOld && backNew > previousNew) {
            operations.push({ type: "context", text: oldLines[--backOld] });
            backNew--;
          }
          if (backOld === previousOld) {
            operations.push({ type: "add", text: newLines[--backNew] });
          } else {
            operations.push({ type: "delete", text: oldLines[--backOld] });
          }
        }
        while (backOld > 0 && backNew > 0) {
          operations.push({ type: "context", text: oldLines[--backOld] });
          backNew--;
        }
        while (backOld > 0) operations.push({ type: "delete", text: oldLines[--backOld] });
        while (backNew > 0) operations.push({ type: "add", text: newLines[--backNew] });
        return operations.reverse();
      }
    }
  }
  return [];
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
  const hunks = createHunks(myersOperations(before, after), context);
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
  const created = options.created ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
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
    ? `<script>eval(atob("${Buffer.from(mermaidScript, "utf-8").toString("base64")}"))</script><script>mermaid.initialize({startOnLoad:true});</script>`
    : "";
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style>${EXPORT_CSS}</style>${script}</head><body>`,
    renderMarkdown(markdown),
    "</body></html>",
  ].join("");
}
