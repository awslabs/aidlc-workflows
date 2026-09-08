import {
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { selfContainedMarkdownExport } from "./aidlc-review-ui-render.ts";
import { publishQuestionsRound, recordOfStageDir, reviewUiEnabled, sha256Hex } from "./aidlc-review-ui-shared.ts";

type HtmlText = { type: "text"; value: string };
type HtmlElement = {
	type: "element";
	tag: string;
	attrs: Record<string, string>;
	children: HtmlNode[];
};
type HtmlNode = HtmlText | HtmlElement;

type HtmlRoot = { children: HtmlNode[] };

export interface HtmlArtifactCheck {
	ok: boolean;
	findings: string[];
}

export interface HtmlArtifactIdentity {
	name?: string;
	stage?: string;
}

const VOID_ELEMENTS: Readonly<Record<string, true>> = {
	area: true,
	base: true,
	br: true,
	col: true,
	embed: true,
	hr: true,
	img: true,
	input: true,
	link: true,
	meta: true,
	param: true,
	source: true,
	track: true,
	wbr: true,
};
const RAW_ELEMENTS: Readonly<Record<string, true>> = {
	noscript: true,
	script: true,
	style: true,
	template: true,
};
const HIDDEN_ELEMENTS: Readonly<Record<string, true>> = {
	head: true,
	noscript: true,
	script: true,
	style: true,
	template: true,
};
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	copy: "©",
	gt: ">",
	hellip: "…",
	laquo: "«",
	lt: "<",
	mdash: "—",
	nbsp: " ",
	ndash: "–",
	quot: '"',
	raquo: "»",
	reg: "®",
};

function decodeEntities(value: string): string {
	return value.replace(
		/&(?:#(x[0-9a-f]+|\d+)|([a-z][a-z0-9]+));?/gi,
		(full, numeric: string | undefined, named: string | undefined) => {
			if (numeric) {
				const radix = numeric[0]?.toLowerCase() === "x" ? 16 : 10;
				const digits = radix === 16 ? numeric.slice(1) : numeric;
				const codePoint = Number.parseInt(digits, radix);
				if (
					Number.isFinite(codePoint) &&
					codePoint > 0 &&
					codePoint <= 0x10ffff &&
					!(codePoint >= 0xd800 && codePoint <= 0xdfff)
				) {
					return String.fromCodePoint(codePoint);
				}
			}
			if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? full;
			return full;
		},
	);
}

function tagEnd(html: string, start: number): number {
	let quote = "";
	for (let index = start + 1; index < html.length; index++) {
		const char = html[index];
		if (quote) {
			if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === ">") return index;
	}
	return -1;
}

function parseAttributes(source: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (const match of source.matchAll(pattern)) {
		const name = match[1].toLowerCase();
		attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
	}
	return attrs;
}

// A small stack tokenizer is used instead of HTMLRewriter because extraction is
// deliberately synchronous for sensor callers. It accepts unbalanced authoring
// HTML, observes quoted tag boundaries, and keeps output independent of a DOM.
function parseHtml(html: string): HtmlRoot {
	const root: HtmlRoot = { children: [] };
	const stack: Array<HtmlRoot | HtmlElement> = [root];
	let index = 0;
	while (index < html.length) {
		if (html.startsWith("<!--", index)) {
			const end = html.indexOf("-->", index + 4);
			index = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html[index] !== "<") {
			const end = html.indexOf("<", index);
			const value = html.slice(index, end === -1 ? html.length : end);
			if (value) stack.at(-1)?.children.push({ type: "text", value: decodeEntities(value) });
			index = end === -1 ? html.length : end;
			continue;
		}
		const end = tagEnd(html, index);
		if (end === -1) {
			stack.at(-1)?.children.push({ type: "text", value: decodeEntities(html.slice(index)) });
			break;
		}
		const token = html.slice(index, end + 1);
		if (/^<!|^<\?/i.test(token)) {
			index = end + 1;
			continue;
		}
		const closing = /^<\s*\/\s*([^\s>]+)/.exec(token);
		if (closing) {
			const tag = closing[1].toLowerCase();
			for (let depth = stack.length - 1; depth > 0; depth--) {
				const node = stack[depth];
				if ("tag" in node && node.tag === tag) {
					stack.length = depth;
					break;
				}
			}
			index = end + 1;
			continue;
		}
		const opening = /^<\s*([^\s/>]+)/.exec(token);
		if (!opening) {
			stack.at(-1)?.children.push({ type: "text", value: "<" });
			index++;
			continue;
		}
		const tag = opening[1].toLowerCase();
		const attrStart = token.indexOf(opening[1]) + opening[1].length;
		const attrEnd = token.length - (/\/\s*>$/.test(token) ? 2 : 1);
		const element: HtmlElement = {
			type: "element",
			tag,
			attrs: parseAttributes(token.slice(attrStart, attrEnd)),
			children: [],
		};
		stack.at(-1)?.children.push(element);
		index = end + 1;
		if (tag in RAW_ELEMENTS) {
			const close = new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, "i");
			const rest = html.slice(index);
			const match = close.exec(rest);
			const rawEnd = match ? index + (match.index ?? 0) : html.length;
			element.children.push({ type: "text", value: html.slice(index, rawEnd) });
			index = match ? rawEnd + match[0].length : html.length;
			continue;
		}
		if (!(tag in VOID_ELEMENTS) && !/\/\s*>$/.test(token)) stack.push(element);
	}
	return root;
}

function elements(nodes: readonly HtmlNode[]): HtmlElement[] {
	const found: HtmlElement[] = [];
	for (const node of nodes) {
		if (node.type === "text") continue;
		found.push(node, ...elements(node.children));
	}
	return found;
}

function textContent(node: HtmlNode | HtmlRoot): string {
	if ("type" in node && node.type === "text") return node.value;
	return node.children.map(textContent).join("");
}

function compact(value: string): string {
	return value.replace(/\s+/g, " ");
}

function inline(nodes: readonly HtmlNode[]): string {
	return nodes
		.map((node) => {
			if (node.type === "text") return compact(node.value);
			if (node.tag in HIDDEN_ELEMENTS) return "";
			const content = inline(node.children);
			switch (node.tag) {
				case "br":
					return "\n";
				case "strong":
				case "b":
					return content.trim() ? `**${content.trim()}**` : "";
				case "em":
				case "i":
					return content.trim() ? `*${content.trim()}*` : "";
				case "code": {
					const value = textContent(node).trim();
					const fence = value.includes("``") ? "```" : value.includes("`") ? "``" : "`";
					return value ? `${fence}${value}${fence}` : "";
				}
				case "a": {
					const label = content.trim();
					const href = node.attrs.href ?? "";
					return href ? `[${label || href}](${href})` : label;
				}
				case "img":
					return `![${node.attrs.alt ?? ""}](${node.attrs.src ?? ""})`;
				case "svg": {
					const title = elements(node.children).find((child) => child.tag === "title");
					const label = compact(
						title ? textContent(title) : node.attrs["aria-label"] ?? "untitled",
					).trim();
					return `[diagram: ${label || "untitled"}]`;
				}
				default:
					return content;
			}
		})
		.join("");
}

function listMarkdown(node: HtmlElement, depth = 0): string {
	const ordered = node.tag === "ol";
	const lines: string[] = [];
	for (const item of node.children) {
		if (item.type !== "element" || item.tag !== "li") continue;
		const nested = item.children.filter(
			(child): child is HtmlElement =>
				child.type === "element" && (child.tag === "ul" || child.tag === "ol"),
		);
		const contentNodes = item.children.filter(
			(child) => !nested.includes(child as HtmlElement),
		);
		const content = blocks(contentNodes).replace(/\n+/g, " ").trim();
		lines.push(`${"  ".repeat(depth)}${ordered ? "1." : "-"} ${content}`.trimEnd());
		for (const child of nested) lines.push(listMarkdown(child, depth + 1));
	}
	return lines.filter(Boolean).join("\n");
}

function tableMarkdown(node: HtmlElement): string {
	const rows = elements(node.children).filter((child) => child.tag === "tr");
	const values = rows
		.map((row) =>
			row.children
				.filter(
					(cell): cell is HtmlElement =>
						cell.type === "element" && (cell.tag === "th" || cell.tag === "td"),
				)
				.map((cell) =>
					inline(cell.children)
						.replace(/\s*\n\s*/g, "<br>")
						.replace(/\|/g, "\\|")
						.replace(/\s+/g, " ")
						.trim(),
				),
		)
		.filter((row) => row.length > 0);
	if (values.length === 0) return "";
	const width = Math.max(...values.map((row) => row.length));
	const normalized = values.map((row) => [
		...row,
		...Array.from({ length: width - row.length }, () => ""),
	]);
	const line = (row: readonly string[]) => `| ${row.join(" | ")} |`;
	return [
		line(normalized[0]),
		line(Array.from({ length: width }, () => "---")),
		...normalized.slice(1).map(line),
	].join("\n");
}

function fencedCode(node: HtmlElement): string {
	const code = node.children.find(
		(child): child is HtmlElement => child.type === "element" && child.tag === "code",
	);
	const classes = code?.attrs.class ?? node.attrs.class ?? "";
	const language = /(?:^|\s)language-([A-Za-z0-9_-]+)/.exec(classes)?.[1] ?? "";
	const value = textContent(code ?? node).replace(/^\n|\n$/g, "");
	const fence = value.includes("```") ? "````" : "```";
	return `${fence}${language}\n${value}\n${fence}`;
}

function blocks(nodes: readonly HtmlNode[]): string {
	const parts: string[] = [];
	for (const node of nodes) {
		if (node.type === "text") {
			const value = compact(node.value).trim();
			if (value) parts.push(value);
			continue;
		}
		if (node.tag in HIDDEN_ELEMENTS) continue;
		if (/^h[1-6]$/.test(node.tag)) {
			parts.push(`${"#".repeat(Number(node.tag[1]))} ${inline(node.children).trim()}`);
			continue;
		}
		switch (node.tag) {
			case "p":
				parts.push(inline(node.children).trim());
				break;
			case "ul":
			case "ol":
				parts.push(listMarkdown(node));
				break;
			case "table":
				parts.push(tableMarkdown(node));
				break;
			case "pre":
				parts.push(fencedCode(node));
				break;
			case "blockquote": {
				const quoted = blocks(node.children)
					.split("\n")
					.map((line) => `> ${line}`)
					.join("\n");
				parts.push(quoted);
				break;
			}
			case "hr":
				parts.push("---");
				break;
			case "img":
			case "svg":
			case "a":
			case "code":
				parts.push(inline([node]).trim());
				break;
			default: {
				const content = blocks(node.children);
				if (content.trim()) parts.push(content);
				break;
			}
		}
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/** Project authoring HTML into deterministic Markdown for machine consumers. */
export function htmlToMarkdown(html: string): string {
	const root = parseHtml(html);
	const body = elements(root.children).find((node) => node.tag === "body");
	const children = body?.children ?? root.children;
	const summary = children.find(
		(node): node is HtmlElement =>
			node.type === "element" &&
			node.tag === "section" &&
			node.attrs["data-aidlc"] === "summary",
	);
	const ordered = summary
		? [summary, ...children.filter((node) => node !== summary)]
		: [...children];
	const markdown = blocks(ordered)
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return markdown ? `${markdown}\n` : "";
}

/** Read Markdown verbatim or project an HTML artifact to Markdown. */
export function readArtifactText(path: string): string {
	const body = readFileSync(path, "utf-8");
	return path.toLowerCase().endsWith(".html") ? htmlToMarkdown(body) : body;
}


function unsafeReference(value: string): string | null {
	const normalized = value.trim();
	if (!normalized || normalized.startsWith("#") || /^data:/i.test(normalized)) return null;
	if (/^(?:https?:)?\/\//i.test(normalized)) return "external URL";
	if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return "unsupported URL scheme";
	if (normalized.startsWith("/")) return "non-sibling path";
	if (normalized.split(/[?#]/, 1)[0].split("/").includes("..")) return "parent path";
	return null;
}

/** Check one HTML artifact against the offline, reviewable authoring contract. */
export function checkHtmlArtifact(
	html: string,
	identity: HtmlArtifactIdentity = {},
): HtmlArtifactCheck {
	const findings: string[] = [];
	const root = parseHtml(html);
	const all = elements(root.children);
	const htmlElement = all.find((node) => node.tag === "html");
	const head = all.find((node) => node.tag === "head");
	const body = all.find((node) => node.tag === "body");
	if (!/^\s*<!doctype\s+html\s*>/i.test(html)) findings.push("missing <!doctype html>");
	if (!htmlElement?.attrs.lang?.trim()) findings.push("missing <html lang>");
	if (!all.some((node) => node.tag === "meta" && "charset" in node.attrs)) {
		findings.push("missing <meta charset>");
	}
	const title = head?.children.find(
		(node): node is HtmlElement => node.type === "element" && node.tag === "title",
	);
	if (!title || !textContent(title).trim()) findings.push("missing <title>");
	for (const [metaName, expected] of [
		["aidlc-artifact", identity.name],
		["aidlc-stage", identity.stage],
	] as const) {
		const meta = all.find(
			(node) =>
				node.tag === "meta" && node.attrs.name?.toLowerCase() === metaName,
		);
		if (!meta) {
			findings.push(`missing <meta name="${metaName}">`);
		} else if (expected !== undefined && meta.attrs.content !== expected) {
			findings.push(
				`<meta name="${metaName}"> content must be "${expected}"`,
			);
		}
	}
	const meaningfulBody = (body?.children ?? []).filter(
		(node) => node.type === "element" || node.value.trim().length > 0,
	);
	const first = meaningfulBody[0];
	if (
		first?.type !== "element" ||
		first.tag !== "section" ||
		first.attrs["data-aidlc"] !== "summary"
	) {
		findings.push('body must begin with <section data-aidlc="summary">');
	}
	const elementChildren = (body?.children ?? []).filter(
		(node): node is HtmlElement => node.type === "element",
	);
	const reviewSections = elementChildren.filter(
		(node) => node.tag === "section" && node.attrs["data-aidlc"] === "review",
	);
	if (
		reviewSections.length > 0 &&
		reviewSections.some((node) => node !== elementChildren.at(-1))
	) {
		findings.push('the <section data-aidlc="review"> must be the last body element');
	}
	for (const element of all) {
		if (["iframe", "object", "embed", "base"].includes(element.tag)) {
			findings.push(`<${element.tag}> is not allowed`);
		}
		if (element.tag === "meta" && /^refresh$/i.test(element.attrs["http-equiv"] ?? "")) {
			findings.push("<meta http-equiv=\"refresh\"> is not allowed");
		}
		if (element.tag === "form" && "action" in element.attrs) {
			findings.push("<form action> is not allowed");
		}
		// Every attribute a browser will fetch or navigate to, not just src/href.
		for (const attribute of ["src", "href", "poster", "data", "formaction", "ping", "xlink:href", "action", "cite", "longdesc", "manifest"] as const) {
			const value = element.attrs[attribute];
			if (value === undefined) continue;
			const reason = unsafeReference(value);
			if (reason) findings.push(`<${element.tag}> ${attribute} has ${reason}: ${value}`);
		}
		for (const attribute of ["srcset", "imagesrcset"] as const) {
			const value = element.attrs[attribute];
			if (value === undefined) continue;
			for (const candidate of value.split(",")) {
				const url = candidate.trim().split(/\s+/, 1)[0];
				const reason = url ? unsafeReference(url) : null;
				if (reason) findings.push(`<${element.tag}> ${attribute} has ${reason}: ${url}`);
			}
		}
		for (const css of [element.attrs.style, element.tag === "style" ? textContent(element) : undefined]) {
			if (!css) continue;
			for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
				const value = match[2];
				const reason = unsafeReference(value);
				if (reason) findings.push(`CSS url() has ${reason}: ${value}`);
			}
			for (const match of css.matchAll(/@import\s+(['"])(.*?)\1/gi)) {
				const reason = unsafeReference(match[2]);
				if (reason) findings.push(`CSS @import has ${reason}: ${match[2]}`);
			}
		}
	}
	return { ok: findings.length === 0, findings };
}

export interface GuideQuestion {
	id: string;
	title: string;
	/** Letter → option text, in file order. */
	options: Map<string, string>;
	/** Option-looking lines the parser had to ignore (`- A. …`, `1. …`, indented letters). */
	rejectedOptionLines: string[];
	/** `[Answer]:` lines in the section; `answers-apply` requires exactly one. */
	answerLines: number;
	/** Times this `## Q<n>` heading appears; `answers-apply` refuses duplicates. */
	occurrences: number;
}

/**
 * The questions file is authoritative for every guide check and for the review
 * UI's form, and all of them read options the same way: a bare `A. text` line
 * starting at column 0 under a `## Q<n>` heading. Anything else — a Markdown
 * bullet (`- A. text`), a numbered item, an indented letter — is prose to the
 * parsers, which is why a question can end up with zero options.
 */
export function parseGuideQuestions(markdown: string): GuideQuestion[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const questions: GuideQuestion[] = [];
	let current: GuideQuestion | null = null;
	let inFence = false;
	for (const line of lines) {
		if (/^\s{0,3}(?:```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const heading = /^\s{0,3}##[ \t]+(Q([1-9][0-9]*)(?:[.:][ \t]*(.*?))?)[ \t]*#*[ \t]*$/.exec(line);
		if (heading) {
			const id = `Q${heading[2]}`;
			const existing = questions.find((question) => question.id === id);
			if (existing) {
				// A duplicate heading is reported, never merged: its options and tags
				// stay out of the first occurrence so that diagnosis stays local.
				existing.occurrences += 1;
				current = null;
				continue;
			}
			current = { id, title: (heading[3] ?? "").trim() || id, options: new Map(), rejectedOptionLines: [], answerLines: 0, occurrences: 1 };
			questions.push(current);
			continue;
		}
		if (/^\s{0,3}##(?:[ \t]|$)/.test(line)) {
			current = null;
			continue;
		}
		if (!current) continue;
		if (/^\s*\[Answer\]:/.test(line)) {
			current.answerLines += 1;
			continue;
		}
		const option = /^([A-Z])\.\s+(.*?)\s*$/.exec(line);
		if (option) {
			current.options.set(option[1], option[2]);
			continue;
		}
		// A line that was clearly meant as an option but will never parse as one.
		if (/^\s*(?:[-*+]\s+)?(?:[A-Z]|[0-9]+)[.)]\s+\S/.test(line) && !/^\[Answer\]:/.test(line)) {
			current.rejectedOptionLines.push(line.trim());
		}
	}
	return questions;
}

/** Check a browser explainer against its authoritative questions file. */
export function checkGuideArtifact(
	html: string,
	questionsMarkdown: string,
	identity: HtmlArtifactIdentity = {},
): HtmlArtifactCheck {
	const base = checkHtmlArtifact(html, identity);
	const findings = base.findings.map((finding) =>
		finding === 'body must begin with <section data-aidlc="summary">'
			? 'body must begin with <section data-aidlc="summary"> holding one paragraph on what this round decides (run `aidlc-html.ts scaffold --guide <questions.md>` for a skeleton that already passes)'
			: finding,
	);
	const parsed = parseGuideQuestions(questionsMarkdown);
	const questions = new Map(parsed.map((question) => [question.id, new Set(question.options.keys())]));
	// A question with no parsable options makes every recommendation for it
	// "not an option" — say what is actually wrong, once, instead.
	const unparsable = new Set<string>();
	for (const question of parsed) {
		if (question.options.size > 0) continue;
		unparsable.add(question.id);
		const sample = question.rejectedOptionLines[0];
		findings.push(
			`${question.id} has no parsable options in the questions file` +
				(sample ? ` (saw "${sample}")` : "") +
				': options must be bare lines "A. text" starting at column 0 — no "- " bullet, no numbering, no indent. Fix the questions file, then re-check.',
		);
	}
	// The structural invariants `answers-apply` enforces after the human has
	// saved — exactly one `[Answer]:` per question, an `X. Other` escape — are
	// checked here, before the round is shown, so a malformed file is fixed by
	// the agent instead of refusing the human's saved answers.
	for (const question of parsed) {
		if (question.occurrences > 1) {
			findings.push(
				`${question.id} appears ${question.occurrences} times in the questions file — answers-apply refuses duplicate sections. Fix the questions file, then re-check.`,
			);
		}
		if (unparsable.has(question.id)) continue;
		if (question.answerLines !== 1) {
			findings.push(
				`${question.id} must contain exactly one [Answer]: line (found ${question.answerLines}) — answers-apply would refuse the saved round. Fix the questions file, then re-check.`,
			);
		}
		if (!question.options.has("X")) {
			findings.push(
				`${question.id} has no "X. Other (please specify)" option: every ordinary question ends with one so the browser form and the terminal both offer an escape. Fix the questions file, then re-check.`,
			);
		}
	}
	const root = parseHtml(html);
	const guideSections = elements(root.children).filter(
		(node) => node.tag === "section" && "data-aidlc-question" in node.attrs,
	);
	const sectionsById = new Map<string, HtmlElement[]>();
	for (const section of guideSections) {
		const id = section.attrs["data-aidlc-question"];
		const matches = sectionsById.get(id) ?? [];
		matches.push(section);
		sectionsById.set(id, matches);
		if (!questions.has(id)) {
			findings.push(`guide has extra question section "${id}"`);
		}
	}
	for (const id of questions.keys()) {
		const count = sectionsById.get(id)?.length ?? 0;
		if (count === 0) findings.push(`guide is missing question section "${id}"`);
		else if (count > 1) findings.push(`guide has ${count} sections for question "${id}"`);
	}

	// Unfilled prose is not a finished guide. The review UI shows a browser round
	// only once this check passes, so an untouched scaffold paragraph (or a table
	// row with empty cells) must fail here rather than reach the human half-done.
	// `elements()` flattens every descendant; the walk below wants direct children
	// so headings pair with the paragraphs beneath them and cells are counted once.
	const direct = (node: HtmlElement | HtmlRoot): HtmlElement[] =>
		node.children.filter((child): child is HtmlElement => child.type === "element");
	const summary = elements(root.children).find(
		(node) => node.tag === "section" && node.attrs["data-aidlc"] === "summary",
	);
	if (summary && !textContent(summary).trim()) findings.push("summary section is empty: say what this round decides");
	for (const section of guideSections) {
		const id = section.attrs["data-aidlc-question"];
		let heading = "";
		for (const child of direct(section)) {
			if (child.tag === "h3") heading = textContent(child).trim();
			else if (child.tag === "p" && !textContent(child).trim()) {
				findings.push(`${id} has an empty paragraph${heading ? ` under "${heading}"` : ""}`);
			} else if (child.tag === "table") {
				const emptyCells = elements(child.children)
					.filter((cell) => cell.tag === "td" && !textContent(cell).trim()).length;
				if (emptyCells > 0) findings.push(`${id} trade-off table has ${emptyCells} empty cell${emptyCells === 1 ? "" : "s"}`);
			}
		}
	}

	const visit = (nodes: readonly HtmlNode[], questionId: string | null): void => {
		for (const node of nodes) {
			if (node.type === "text") continue;
			const sectionId = node.tag === "section" && "data-aidlc-question" in node.attrs
				? node.attrs["data-aidlc-question"]
				: questionId;
			if ("data-aidlc-recommend" in node.attrs) {
				const letter = node.attrs["data-aidlc-recommend"];
				if (!sectionId) {
					findings.push(`recommendation "${letter}" is outside a question section`);
				} else if (!letter) {
					findings.push(`${sectionId} recommendation is empty: set data-aidlc-recommend to one of ${[...(questions.get(sectionId) ?? [])].join(", ") || "its options"}`);
				} else if (!unparsable.has(sectionId) && !questions.get(sectionId)?.has(letter)) {
					findings.push(`recommendation "${letter}" is not an option for ${sectionId} (offered: ${[...(questions.get(sectionId) ?? [])].join(", ")})`);
				}
			}
			visit(node.children, sectionId);
		}
	};
	visit(root.children, null);
	return { ok: findings.length === 0, findings };
}

function localAssetPath(baseDir: string, reference: string): string | null {
	if (unsafeReference(reference)) return null;
	const clean = reference.split(/[?#]/, 1)[0];
	if (!clean || clean.startsWith("#") || /^data:/i.test(clean)) return null;
	const candidate = resolve(baseDir, clean);
	const root = resolve(baseDir);
	if (candidate !== root && !candidate.startsWith(`${root}/`)) return null;
	return existsSync(candidate) ? candidate : null;
}

function attributeValue(tag: string, name: string): string | null {
	const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
	const match = pattern.exec(tag);
	return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function mimeType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".svg": return "image/svg+xml";
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".gif": return "image/gif";
		case ".webp": return "image/webp";
		default: return "application/octet-stream";
	}
}

function inlineHtmlAssets(path: string, html: string): string {
	const baseDir = dirname(path);
	let output = html.replace(/<link\b[^>]*>/gi, (tag) => {
		if (attributeValue(tag, "rel")?.toLowerCase() !== "stylesheet") return tag;
		const href = attributeValue(tag, "href");
		const asset = href ? localAssetPath(baseDir, href) : null;
		return asset ? `<style>${readFileSync(asset, "utf-8")}</style>` : tag;
	});
	output = output.replace(/<script\b[^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => {
		const src = attributeValue(tag, "src");
		const asset = src ? localAssetPath(baseDir, src) : null;
		return asset ? `<script>${readFileSync(asset, "utf-8")}</script>` : tag;
	});
	return output.replace(/<img\b[^>]*>/gi, (tag) => {
		const src = attributeValue(tag, "src");
		const asset = src ? localAssetPath(baseDir, src) : null;
		if (!asset) return tag;
		const data = readFileSync(asset).toString("base64");
		const uri = `data:${mimeType(asset)};base64,${data}`;
		return tag.replace(
			/(\bsrc\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
			`$1"${uri}"`,
		);
	});
}

/** Produce an offline HTML export from a Markdown or authored HTML artifact. */
export function exportSelfContained(path: string): string {
	if (path.toLowerCase().endsWith(".html")) {
		return inlineHtmlAssets(path, readFileSync(path, "utf-8"));
	}
	const markdown = readFileSync(path, "utf-8");
	let mermaid = "";
	if (/^```mermaid(?:\s|$)/im.test(markdown)) {
		const ownDir = dirname(fileURLToPath(import.meta.url));
		mermaid = readFileSync(
			join(ownDir, "data", "review-ui", "vendor", "mermaid.min.js"),
			"utf-8",
		);
	}
	return selfContainedMarkdownExport(markdown, mermaid);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export type GuideDepth = "minimal" | "standard";

/**
 * A guide skeleton that already satisfies `check --guide`: head identity, the
 * summary section, one section per question with the real option letters and
 * text in the trade-off rows, and an empty `data-aidlc-recommend` to fill.
 * The conductor writes prose into it instead of reconstructing the contract
 * from memory — the format round-trip that used to cost a hundred seconds.
 * `minimal` keeps only "Why now" and the recommendation per question.
 */
export function scaffoldGuide(
	questionsMarkdown: string,
	stage: string,
	depth: GuideDepth = "standard",
): string {
	const questions = parseGuideQuestions(questionsMarkdown);
	const sections = questions.map((question) => {
		const options = [...question.options.entries()];
		const rows = options
			.map(([letter, text]) => `        <tr><th scope="row">${letter}. ${escapeHtml(text)}</th><td></td><td></td><td></td></tr>`)
			.join("\n");
		const tradeoffs = depth === "minimal"
			? ""
			: `
  <h3>Trade-offs</h3>
  <table>
    <thead><tr><th>Option</th><th>You get</th><th>You give up</th><th>Cost / risk</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
		const related = depth === "minimal"
			? ""
			: `
  <h3>Related decisions</h3>
  <p>None found</p>`;
		return `<section data-aidlc-question="${question.id}" id="${question.id}">
  <h2>${escapeHtml(question.title)}</h2>
  <h3>Why now</h3>
  <p></p>${tradeoffs}
  <h3>Recommendation</h3>
  <p data-aidlc-recommend=""></p>${related}
</section>`;
	});
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="aidlc-artifact" content="${escapeHtml(stage)}-questions-guide">
<meta name="aidlc-stage" content="${escapeHtml(stage)}">
<title>${escapeHtml(stage)} — question guide</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5e1;padding:.4rem .6rem;text-align:left;vertical-align:top}
th[scope=row]{white-space:nowrap}h2{margin-top:2.5rem}
</style>
</head>
<body>
<section data-aidlc="summary">
  <p></p>
</section>
${sections.join("\n")}
</body>
</html>
`;
}

const USAGE = `Usage:
  bun aidlc-html.ts text <file>
  bun aidlc-html.ts check <file> [--name <name>] [--stage <slug>]
  bun aidlc-html.ts check --guide <file> --questions <md>
  bun aidlc-html.ts scaffold --guide <questions.md> [--out <file>] [--depth minimal|standard] [--stage <slug>]
  bun aidlc-html.ts export <file> [--out <path>]`;

function usage(): number {
	process.stderr.write(`${USAGE}\n`);
	return 2;
}

function publishRound(guidePath: string, questionsPath: string, questionsSource: string, stage: string): void {
	if (!reviewUiEnabled()) return;
	const owner = recordOfStageDir(dirname(resolve(guidePath)));
	if (!owner || owner.currentStage !== stage) return;
	const rel = (target: string): string => relative(owner.projectDir, resolve(target)).split(sep).join("/");
	publishQuestionsRound(owner.recordDir, {
		stage,
		unit: null,
		stageDir: rel(dirname(resolve(guidePath))),
		questionsFile: rel(questionsPath),
		questionsSha256: sha256Hex(questionsSource),
		guide: rel(guidePath),
	});
}

function cli(argv: string[]): number {
	const [command, first, ...rest] = argv;
	if (!command || !first || !["text", "check", "export", "scaffold"].includes(command)) return usage();
	const guideMode = (command === "check" || command === "scaffold") && first === "--guide";
	if (command === "scaffold" && !guideMode) return usage();
	const path = guideMode ? rest[0] : first;
	const args = guideMode ? rest.slice(1) : rest;
	if (!path || !existsSync(path)) {
		process.stderr.write(`aidlc-html: file not found: ${path ?? ""}\n`);
		return 1;
	}
	const flags: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!flag?.startsWith("--") || value === undefined) return usage();
		flags[flag.slice(2)] = value;
	}
	if (command === "scaffold") {
		if (Object.keys(flags).some((flag) => !["out", "depth", "stage"].includes(flag))) return usage();
		const depth = flags.depth ?? "standard";
		if (depth !== "minimal" && depth !== "standard") return usage();
		// `<slug>-questions.md` names its stage; --stage overrides for odd layouts.
		const stage = flags.stage ?? basename(path).replace(/-questions\.md$/i, "");
		const html = scaffoldGuide(readFileSync(path, "utf-8"), stage, depth);
		if (flags.out) writeFileSync(flags.out, html, "utf-8");
		else process.stdout.write(html);
		return 0;
	}
	if (command === "text") {
		if (args.length > 0) return usage();
		process.stdout.write(readArtifactText(path));
		return 0;
	}
	if (command === "check") {
		const allowed = guideMode ? ["questions"] : ["name", "stage"];
		if (Object.keys(flags).some((flag) => !allowed.includes(flag))) return usage();
		if (guideMode && (!flags.questions || !existsSync(flags.questions))) {
			process.stderr.write(`aidlc-html: questions file not found: ${flags.questions ?? ""}\n`);
			return 1;
		}
		const artifactName = basename(path).replace(/\.html$/i, "");
		const identity = {
			name: flags.name ?? artifactName,
			stage: flags.stage ?? (
				guideMode
					? artifactName.replace(/-questions-guide$/, "")
					: basename(dirname(path))
			),
		};
		const questionsSource = guideMode ? readFileSync(flags.questions, "utf-8") : "";
		const result = guideMode
			? checkGuideArtifact(readFileSync(path, "utf-8"), questionsSource, identity)
			: checkHtmlArtifact(readFileSync(path, "utf-8"), identity);
		if (!result.ok) process.stdout.write(`${result.findings.join("\n")}\n`);
		// A passing guide for the current stage IS the round's publication: the
		// review daemon shows the form and the Stop hook holds for the answers
		// from this record onward, and only from it.
		if (result.ok && guideMode) publishRound(path, flags.questions, questionsSource, identity.stage);
		return result.ok ? 0 : 1;
	}
	if (Object.keys(flags).some((flag) => flag !== "out")) return usage();
	const output = exportSelfContained(path);
	if (flags.out) writeFileSync(flags.out, output, "utf-8");
	else process.stdout.write(output);
	return 0;
}

/** Dispatcher entry (`aidlc engine html <verb>`): same CLI, argv supplied. */
export async function main(argv: string[]): Promise<void> {
	try {
		process.exitCode = cli(argv);
	} catch (error) {
		process.stderr.write(`aidlc-html: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
