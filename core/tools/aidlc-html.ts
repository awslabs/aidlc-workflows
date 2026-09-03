import {
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selfContainedMarkdownExport } from "./aidlc-review-ui-render.ts";

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
		if (["iframe", "object", "embed"].includes(element.tag)) {
			findings.push(`<${element.tag}> is not allowed`);
		}
		if (element.tag === "form" && "action" in element.attrs) {
			findings.push("<form action> is not allowed");
		}
		for (const attribute of ["src", "href"] as const) {
			const value = element.attrs[attribute];
			if (value === undefined) continue;
			const reason = unsafeReference(value);
			if (reason) findings.push(`<${element.tag}> ${attribute} has ${reason}: ${value}`);
		}
		for (const css of [element.attrs.style, element.tag === "style" ? textContent(element) : undefined]) {
			if (!css) continue;
			for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
				const value = match[2];
				const reason = unsafeReference(value);
				if (reason) findings.push(`CSS url() has ${reason}: ${value}`);
			}
		}
	}
	return { ok: findings.length === 0, findings };
}

function guideQuestionOptions(markdown: string): Map<string, Set<string>> {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const questions = new Map<string, Set<string>>();
	let current: Set<string> | null = null;
	let inFence = false;
	for (const line of lines) {
		if (/^\s{0,3}(?:```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const heading = /^\s{0,3}##[ \t]+Q([1-9][0-9]*)(?:[.:](?:[ \t]+.*)?)?[ \t]*#*[ \t]*$/.exec(line);
		if (heading) {
			const id = `Q${heading[1]}`;
			if (!questions.has(id)) questions.set(id, new Set());
			current = questions.get(id)!;
			continue;
		}
		if (/^\s{0,3}##(?:[ \t]|$)/.test(line)) {
			current = null;
			continue;
		}
		const option = /^\s*([A-Z])\.\s+/.exec(line);
		if (current && option) current.add(option[1]);
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
	const findings = [...base.findings];
	const questions = guideQuestionOptions(questionsMarkdown);
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
				} else if (!questions.get(sectionId)?.has(letter)) {
					findings.push(`recommendation "${letter}" is not an option for ${sectionId}`);
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

const USAGE = `Usage:
  bun aidlc-html.ts text <file>
  bun aidlc-html.ts check <file> [--name <name>] [--stage <slug>]
  bun aidlc-html.ts check --guide <file> --questions <md>
  bun aidlc-html.ts export <file> [--out <path>]`;

function usage(): number {
	process.stderr.write(`${USAGE}\n`);
	return 2;
}

function cli(argv: string[]): number {
	const [command, first, ...rest] = argv;
	if (!command || !first || !["text", "check", "export"].includes(command)) return usage();
	const guideMode = command === "check" && first === "--guide";
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
		const result = guideMode
			? checkGuideArtifact(
				readFileSync(path, "utf-8"),
				readFileSync(flags.questions, "utf-8"),
				identity,
			)
			: checkHtmlArtifact(readFileSync(path, "utf-8"), identity);
		if (!result.ok) process.stdout.write(`${result.findings.join("\n")}\n`);
		return result.ok ? 0 : 1;
	}
	if (Object.keys(flags).some((flag) => flag !== "out")) return usage();
	const output = exportSelfContained(path);
	if (flags.out) writeFileSync(flags.out, output, "utf-8");
	else process.stdout.write(output);
	return 0;
}

if (import.meta.main) {
	try {
		process.exitCode = cli(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`aidlc-html: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
