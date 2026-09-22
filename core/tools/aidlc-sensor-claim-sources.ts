import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	authoritativeProjectDescription,
	errorMessage,
	markdownBlocks,
	type MarkdownLine,
	readProjectDescriptionAuthority,
	visibleMarkdownLines,
} from "./aidlc-lib.ts";

interface Flags {
	stage?: string;
	outputPath?: string;
	deliverables?: string;
}

interface Result {
	pass: boolean;
	findings: string[];
	scanned_files: string[];
	questions_file: string;
	findings_count: number;
	reason?: string;
}

interface ClaimBlock {
	section: string;
	text: string;
	inAssumptions: boolean;
	listItem: boolean;
	rawHtml: boolean;
}

interface SourceUniverse {
	registered: Set<string>;
	canonicalScopeDeclaration?: string;
	answeredQuestions: Set<string>;
	assumptionsAccepted: boolean;
	acceptedAssumptions: Set<string>;
	pastedDocumentPresent: boolean;
	findings: string[];
}

interface RecordAuthority {
	projectDescription: string;
	pastedDocumentPresent: boolean;
	scope: string;
	projectRoot: string;
	activeSpace: string;
	findings: string[];
}

const ASSUMPTIONS_HEADING = "Assumptions & Open Questions";
const REVIEW_HEADING = "Review";
const ACCEPT_ASSUMPTIONS_ANSWER = "A. Accept assumptions";
// Lines the `## Assumption Confirmation` section owns as scaffolding rather
// than assumption text: its two fixed option literals and the answer tag.
const CONFIRMATION_SCAFFOLD_RE =
	/^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?(?:A\. Accept assumptions|B\. Convert to follow-up questions)\s*$|^\[Answer\]:/;
const ACTIVE_MEMORY_FILES = new Set(["org.md", "team.md", "project.md"]);
const NON_VISIBLE_HTML_ELEMENTS = new Set([
	"code",
	"pre",
	"script",
	"style",
	"template",
]);
const SOURCE_TAG_RE =
	/\[(desc|scope|assumption|Q\d+|memory:[A-Za-z0-9][A-Za-z0-9._-]*)\]/g;
const SOURCE_ENTRY_RE =
	/^ {0,3}[-*+]\s+\[(desc|scope|memory:[A-Za-z0-9][A-Za-z0-9._-]*)\]\s+(.+?)\s*$/;

function parseFlags(argv: string[]): Flags {
	const flags: Flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--stage") {
			flags.stage = argv[++i];
		} else if (arg === "--output-path") {
			flags.outputPath = argv[++i];
		} else if (arg === "--deliverables") {
			flags.deliverables = argv[++i] ?? "";
		}
	}
	return flags;
}

function fail(message: string): never {
	process.stderr.write(`aidlc-sensor-claim-sources: ${message}\n`);
	process.exit(1);
}

function h2Heading(line: string): string | null {
	const match = /^ {0,3}##(?:[ \t]+|$)(.*)$/.exec(line);
	if (!match) return null;
	return match[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
}

function sectionsNamed(lines: string[], heading: string): string[][] {
	const sections: string[][] = [];
	let current: string[] | null = null;
	for (const line of lines) {
		const h2 = h2Heading(line);
		if (h2 !== null) {
			if (current !== null) sections.push(current);
			current = h2 === heading ? [] : null;
			continue;
		}
		if (current !== null) current.push(line);
	}
	if (current !== null) sections.push(current);
	return sections;
}

function stateField(body: string, label: string): string {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return (
		new RegExp(`^- \\*\\*${escaped}\\*\\*:\\s*(.*)$`, "m").exec(body)?.[1]?.trim() ??
		""
	);
}

function findRecordRoot(stageDir: string): string | null {
	let cursor = resolve(stageDir);
	for (;;) {
		if (existsSync(join(cursor, "aidlc-state.md"))) return cursor;
		const parent = dirname(cursor);
		if (parent === cursor) return null;
		cursor = parent;
	}
}

function projectRootFor(recordRoot: string, stateBody: string): string {
	if (basename(recordRoot) === "aidlc-docs") return dirname(recordRoot);

	let cursor = recordRoot;
	for (;;) {
		if (basename(cursor) === "aidlc") return dirname(cursor);
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}

	const configured = stateField(stateBody, "Project Root");
	return configured ? resolve(configured) : "";
}

function activeSpaceFor(projectRoot: string, recordRoot: string): string {
	const cursorPath = join(projectRoot, "aidlc", "active-space");
	if (existsSync(cursorPath)) {
		try {
			return readFileSync(cursorPath, "utf-8").trim();
		} catch {
			return "";
		}
	}

	const spacesRoot = join(projectRoot, "aidlc", "spaces");
	const rel = relative(spacesRoot, recordRoot);
	if (!rel.startsWith("..") && !rel.startsWith(sep)) {
		const first = rel.split(sep)[0];
		if (first && first !== ".") return first;
	}
	return "";
}

function loadRecordAuthority(stageDir: string): RecordAuthority {
	const findings: string[] = [];
	const recordRoot = findRecordRoot(stageDir);
	if (!recordRoot) {
			return {
				projectDescription: "",
				pastedDocumentPresent: false,
				scope: "",
			projectRoot: "",
			activeSpace: "",
			findings: ["cannot verify source register: aidlc-state.md was not found"],
		};
	}

	let stateBody = "";
	try {
		stateBody = readFileSync(join(recordRoot, "aidlc-state.md"), "utf-8");
	} catch (error) {
		findings.push(
			`cannot verify source register: failed to read aidlc-state.md: ${errorMessage(error)}`,
		);
	}

	let rawProjectDescription = "";
	try {
		rawProjectDescription = readProjectDescriptionAuthority(
			recordRoot,
			stateBody,
		).description;
	} catch (error) {
		findings.push(
			`cannot verify source register: ${errorMessage(error)}`,
		);
	}
	const description = authoritativeProjectDescription(rawProjectDescription);
	if (description.error) {
		findings.push(`cannot verify source register: ${description.error}`);
	}
	const projectDescription = description.error
		? ""
		: description.description;
	const scope = stateField(stateBody, "Scope");
	const projectRoot = projectRootFor(recordRoot, stateBody);
	const activeSpace = projectRoot
		? activeSpaceFor(projectRoot, recordRoot)
		: "";
	if (!projectDescription) {
		findings.push("the record is missing authoritative project directions for [desc]");
	}
	if (!scope) findings.push("aidlc-state.md is missing Scope authority for [scope]");
	if (!projectRoot) {
		findings.push("cannot resolve the project root for memory source validation");
	}
	if (!activeSpace) {
		findings.push("cannot resolve the active space for memory source validation");
	}

	return {
		projectDescription,
		pastedDocumentPresent: description.pastedDocumentPresent,
		scope,
		projectRoot,
		activeSpace,
		findings,
	};
}

function parseQuotedValue(value: string): string | null {
	if (!/^"(?:\\.|[^"\\])*"$/.test(value)) return null;
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "string" ? parsed : null;
	} catch {
		return null;
	}
}

function memoryRuleMatches(
	id: string,
	value: string,
	authority: RecordAuthority,
	findings: string[],
): boolean {
	const match = /^`([^`#]+)#([^`#]+)`:\s*("(?:\\.|[^"\\])*")$/.exec(value);
	if (!match) {
		findings.push(
			`[${id}] must use \`aidlc/spaces/<space>/memory/<file>.md#<exact H2>\`: "<exact rule>"`,
		);
		return false;
	}

	const [, sourcePath, heading, quoted] = match;
	const rule = parseQuotedValue(quoted);
	if (rule === null) {
		findings.push(`[${id}] has an invalid quoted rule`);
		return false;
	}
	if (!authority.projectRoot || !authority.activeSpace) return false;

	const expectedPrefix = `aidlc/spaces/${authority.activeSpace}/memory/`;
	if (
		!sourcePath.startsWith(expectedPrefix) ||
		sourcePath.includes("\\") ||
		sourcePath.split("/").includes("..")
	) {
		findings.push(
			`[${id}] path must name a file under the active memory root ${expectedPrefix}`,
		);
		return false;
	}
	const memoryFile = sourcePath.slice(expectedPrefix.length);
	if (!ACTIVE_MEMORY_FILES.has(memoryFile)) {
		findings.push(
			`[${id}] must name an active memory file under ${expectedPrefix}: org.md, team.md, or project.md`,
		);
		return false;
	}

	const memoryRoot = resolve(authority.projectRoot, expectedPrefix);
	const sourceFile = resolve(authority.projectRoot, sourcePath);
	if (
		sourceFile !== memoryRoot &&
		!sourceFile.startsWith(`${memoryRoot}${sep}`)
	) {
		findings.push(`[${id}] path escapes the active memory root`);
		return false;
	}
	if (!existsSync(sourceFile)) {
		findings.push(`[${id}] memory source does not exist: ${sourcePath}`);
		return false;
	}

	let memoryBody = "";
	try {
		memoryBody = readFileSync(sourceFile, "utf-8");
	} catch (error) {
		findings.push(
			`[${id}] failed to read memory source ${sourcePath}: ${errorMessage(error)}`,
		);
		return false;
	}
	const sections = sectionsNamed(
		visibleMarkdownLines(memoryBody, { preserveIndentedCode: true }),
		heading,
	);
	if (sections.length !== 1) {
		findings.push(
			`[${id}] memory source must contain exactly one ## ${heading} heading`,
		);
		return false;
	}
	const entries = sections[0]
		.map((line) =>
			line.replace(/^ {0,3}(?:[-*+]|\d+\.)\s+/, "").trim(),
		)
		.filter((line) => line.length > 0 && !/^>/.test(line));
	if (!entries.includes(rule)) {
		findings.push(
			`[${id}] quoted rule does not exactly match an entry under ## ${heading}`,
		);
		return false;
	}
	return true;
}

function answerIsFilled(answer: string): boolean {
	const normalized = answer.trim();
	return normalized.length > 0 && !/^_+$/.test(normalized);
}

function parseSourceUniverse(
	questionsPath: string,
	stageDir: string,
): SourceUniverse {
	const findings: string[] = [];
	if (!existsSync(questionsPath)) {
		return {
			registered: new Set(),
				answeredQuestions: new Set(),
				assumptionsAccepted: false,
				acceptedAssumptions: new Set(),
				pastedDocumentPresent: false,
				findings: [`questions file missing: ${questionsPath}`],
		};
	}

	let body: string;
	try {
		body = readFileSync(questionsPath, "utf-8");
	} catch (error) {
		return {
			registered: new Set(),
				answeredQuestions: new Set(),
				assumptionsAccepted: false,
				acceptedAssumptions: new Set(),
				pastedDocumentPresent: false,
				findings: [
				`failed to read questions file ${questionsPath}: ${errorMessage(error)}`,
			],
		};
	}

	const lines = visibleMarkdownLines(body, { preserveIndentedCode: true });
	const authority = loadRecordAuthority(stageDir);
	findings.push(...authority.findings);
	const registered = new Set<string>();
	let canonicalScopeDeclaration: string | undefined;
	const seenSources = new Set<string>();
	const sourceSections = sectionsNamed(lines, "Sources");
	if (sourceSections.length === 0) {
		findings.push("questions file is missing ## Sources");
	} else {
		if (sourceSections.length > 1) {
			findings.push("questions file has duplicate ## Sources sections");
		}
		for (const line of sourceSections[0]) {
			const match = SOURCE_ENTRY_RE.exec(line);
			if (!match) continue;
			const [, id, value] = match;
			if (seenSources.has(id)) {
				findings.push(`duplicate source id [${id}] in ## Sources`);
			}
			seenSources.add(id);

			let valid = false;
			if (id === "desc") {
				const desc = /^Initial description:\s*("(?:\\.|[^"\\])*")$/.exec(
					value,
				);
				const parsed = desc ? parseQuotedValue(desc[1]) : null;
					if (parsed === null) {
						findings.push(
							'[desc] must use Initial description: "<authoritative user directions>"',
						);
				} else if (parsed !== authority.projectDescription) {
					findings.push(
						"[desc] does not exactly match the authoritative project description",
					);
				} else {
					valid = true;
				}
			} else if (id === "scope") {
				const scope =
					/^Workflow-selected scope:\s*`([^`]+)`\.?$/.exec(value)?.[1] ??
					"";
				if (!scope) {
					findings.push(
						"[scope] must use Workflow-selected scope: `<scope>`.",
					);
				} else if (scope !== authority.scope) {
					findings.push(
						"[scope] does not exactly match Scope in aidlc-state.md",
					);
				} else {
					valid = true;
					canonicalScopeDeclaration = `- [scope] Workflow-selected scope: \`${scope}\`.`;
				}
			} else {
				valid = memoryRuleMatches(id, value, authority, findings);
			}
			if (valid) registered.add(id);
		}
		for (const required of ["desc", "scope"]) {
			if (!seenSources.has(required)) {
				findings.push(`## Sources is missing [${required}]`);
			}
		}
	}

	const answeredQuestions = new Set<string>();
	const seenQuestions = new Set<string>();
	for (let index = 0; index < lines.length; index++) {
		const heading = h2Heading(lines[index]);
		const question = heading ? /^Q(\d+)\b/.exec(heading) : null;
		if (!question) continue;
		const id = `Q${question[1]}`;
		if (seenQuestions.has(id)) {
			findings.push(`duplicate question id ${id}`);
		}
		seenQuestions.add(id);
		let end = index + 1;
		while (end < lines.length && h2Heading(lines[end]) === null) end++;
		const answers = lines
			.slice(index + 1, end)
			.map((line) => /^\[Answer\]:\s*(.*)$/.exec(line)?.[1])
			.filter((answer): answer is string => answer !== undefined);
		if (answers.length > 1) {
			findings.push(`duplicate [Answer]: entries for ${id}`);
		}
		const answer = answers[0] ?? "";
		if (answerIsFilled(answer)) answeredQuestions.add(id);
		index = end - 1;
	}

	const confirmationSections = sectionsNamed(lines, "Assumption Confirmation");
	if (confirmationSections.length > 1) {
		findings.push("questions file has duplicate ## Assumption Confirmation sections");
	}
	const confirmation = confirmationSections[0] ?? [];
	const assumptionAnswers = confirmation
		.map((line) => /^\[Answer\]:\s*(.*)$/.exec(line)?.[1])
		.filter((answer): answer is string => answer !== undefined);
	if (assumptionAnswers.length > 1) {
		findings.push("duplicate [Answer]: entries for Assumption Confirmation");
	}
	const assumptionAnswer = assumptionAnswers[0] ?? "";
	// Parse the original document before projecting its confirmation entries:
	// a definition or lazy continuation keeps the same meaning on both sides.
	const confirmationStart = lines.findIndex(
		(line) => h2Heading(line) === "Assumption Confirmation",
	) + 1;
	const parsed = claimBlocks(body, {
		start: confirmationStart,
		end: confirmationStart + confirmation.length,
	});
	const acceptedAssumptions = new Set(
		parsed.blocks
			.filter((block) => block.listItem &&
				sourceTags(block.text, parsed.labels, block.rawHtml).includes("assumption"))
			.map((block) => normalizedAssumption(block.text))
			.filter((entry) => entry.length > 0),
	);

	return {
		registered,
		...(findings.length === 0 && canonicalScopeDeclaration !== undefined
			? { canonicalScopeDeclaration }
			: {}),
		answeredQuestions,
			assumptionsAccepted:
				assumptionAnswer.trim() === ACCEPT_ASSUMPTIONS_ANSWER,
			acceptedAssumptions,
			pastedDocumentPresent: authority.pastedDocumentPresent,
			findings,
	};
}

function isNoneBlock(text: string): boolean {
	return /^None\.?$/i.test(text.trim());
}

/** Project claim runs from the parser; confirmation uses the same document view. */
function claimBlocks(
	body: string,
	confirmationRange?: { start: number; end: number },
): {
	blocks: ClaimBlock[];
	labels: Set<string>;
	hasAssumptionsSection: boolean;
} {
	const structure = markdownBlocks(body);
	const lines = body.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
	const labels = new Set<string>();
	for (const definition of structure.definitions) {
		labels.add(definition.label);
		for (let index = definition.startLine; index <= definition.endLine; index++) {
			lines[index] = "";
		}
	}
	const blocks: ClaimBlock[] = [];
	let section = "";
	let hasAssumptionsSection = false;
	let pending: string[] = [];
	let pendingLine: MarkdownLine | null = null;
	let tableRow = 0;
	const sameContainers = (left: MarkdownLine, right: MarkdownLine): boolean =>
		left.containers.length === right.containers.length &&
		left.containers.every((container, index) => {
			const other = right.containers[index];
			return container.kind === other.kind &&
				(container.kind !== "listItem" || other.kind === "listItem" && container.id === other.id);
		});
	const flush = (): void => {
		const text = pending.join("\n").trimEnd();
		if (text && pendingLine) {
			blocks.push({
				section,
				text,
				inAssumptions: section === ASSUMPTIONS_HEADING,
				listItem: pendingLine.containers.some((container) => container.kind === "listItem"),
				rawHtml: pendingLine.kind === "htmlFlow",
			});
		}
		pending = [];
		pendingLine = null;
	};

	for (let index = confirmationRange?.start ?? 0; index < (confirmationRange?.end ?? lines.length); index++) {
		const line = structure.lines[index];
		let text = lines[index];
		// Keep raw claim spelling for exact declarations and assumptions. Only
		// parsed comments disappear here; sourceTags masks inline code separately.
		for (let span = line.invisible.length - 1; span >= 0; span--) {
			const invisible = line.invisible[span];
			if (invisible.kind === "htmlComment") {
				text = text.slice(0, invisible.start) + text.slice(invisible.end);
			}
		}
		if (line.kind === "heading") {
			flush();
			const heading = h2Heading(text);
			if (heading !== null) {
				section = heading;
				if (section === ASSUMPTIONS_HEADING) hasAssumptionsSection = true;
			}
			continue;
		}
		if (section === REVIEW_HEADING) continue;
		if (confirmationRange && line.kind === "paragraph" && CONFIRMATION_SCAFFOLD_RE.test(text)) {
			flush();
			continue;
		}
		if (line.kind === "table") {
			flush();
			const previous = structure.lines[index - 1];
			tableRow = previous?.kind === "table" && sameContainers(previous, line) ? tableRow + 1 : 0;
			// GFM tables begin with a header and delimiter; subsequent rows are claims.
			if (tableRow >= 2) {
				pendingLine = line;
				pending.push(text);
				flush();
			}
			continue;
		}
		// Indented code remains inspected by sensor policy; unlike fenced examples,
		// it must not hide unsupported definition-shaped claims.
		if (line.kind !== "paragraph" && line.kind !== "codeIndented" &&
			!(line.kind === "htmlFlow" && (line.htmlKind === 6 || line.htmlKind === 7))) {
			flush();
			continue;
		}
		if (pendingLine && (pendingLine.kind !== line.kind || !sameContainers(pendingLine, line))) flush();
		pendingLine ??= line;
		pending.push(text);
	}
	flush();
	return { blocks, labels, hasAssumptionsSection };
}

function isEscaped(text: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
		slashes++;
	}
	return slashes % 2 === 1;
}

function matchingDelimiter(
	text: string,
	start: number,
	opening: "[" | "(",
	closing: "]" | ")",
): number {
	let depth = 0;
	let quote: "'" | '"' | null = null;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (isEscaped(text, index)) continue;
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (
			opening === "(" &&
			depth === 1 &&
			(char === '"' || char === "'") &&
			/\s/.test(text[index - 1] ?? "")
		) {
			quote = char;
			continue;
		}
		if (char === opening) {
			depth++;
		} else if (char === closing) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

interface HtmlTag {
	end: number;
	name: string;
	closing: boolean;
	selfClosing: boolean;
	hidesContent: boolean;
}

function htmlTagAt(text: string, start: number, rawHtml: boolean): HtmlTag | null {
	if (text[start] !== "<" || !rawHtml && isEscaped(text, start)) return null;
	const tail = text.slice(start);
	const named = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)\b/.exec(tail);
	const autolink = /^<(?:https?:\/\/|mailto:|[^<>\s]+@)/i.test(tail);
	if (!named && !autolink) return null;

	let quote: "'" | '"' | null = null;
	let end = -1;
	for (let index = start + 1; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote && (rawHtml || !isEscaped(text, index))) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
		} else if (char === ">") {
			end = index;
			break;
		}
	}
	if (end < 0) return null;
	if (!named) {
		return {
			end,
			name: "",
			closing: false,
			selfClosing: true,
			hidesContent: false,
		};
	}

	const raw = text.slice(start, end + 1);
	const closing = named[1] === "/";
	const name = named[2].toLowerCase();
	const hiddenAttribute =
		/(?:^|\s)hidden(?:\s|=|\/?>)/i.test(raw) ||
		/\saria-hidden\s*=\s*(?:"true"|'true'|true)(?:\s|\/?>)/i.test(raw) ||
		/\sstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*')/i.test(
			raw,
		);
	return {
		end,
		name,
		closing,
		selfClosing: /\/\s*>$/.test(raw),
		hidesContent:
			!closing &&
			(NON_VISIBLE_HTML_ELEMENTS.has(name) || hiddenAttribute),
	};
}

function visibleHtmlText(text: string, rawHtml = false): string {
	let visible = "";
	let hiddenElement = "";
	let hiddenDepth = 0;
	for (let index = 0; index < text.length; index++) {
		if (rawHtml && text.startsWith("<!--", index)) {
			const end = text.indexOf("-->", index + 4);
			if (end < 0) break;
			index = end + 2;
			continue;
		}
		const tag = htmlTagAt(text, index, rawHtml);
		if (tag) {
			if (hiddenElement && tag.name === hiddenElement) {
				if (tag.closing) {
					hiddenDepth--;
					if (hiddenDepth === 0) hiddenElement = "";
				} else if (!tag.selfClosing) {
					hiddenDepth++;
				}
			} else if (!hiddenElement && tag.hidesContent && !tag.selfClosing) {
				hiddenElement = tag.name;
				hiddenDepth = 1;
			}
			index = tag.end;
			continue;
		}
		if (!hiddenElement) visible += text[index];
	}
	return visible;
}

// Match the parser's Markdown-whitespace normalization and Unicode case fold
// when resolving inline reference labels against its document-wide definitions.
function normalizedReferenceLabel(label: string): string {
	return label.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}

function visibleMarkdownLinkText(text: string, labels: Set<string>): string {
	let visible = "";
	for (let index = 0; index < text.length; index++) {
		const image =
			text[index] === "!" &&
			text[index + 1] === "[" &&
			!isEscaped(text, index);
		const link = text[index] === "[" && !isEscaped(text, index);
		if (!image && !link) {
			visible += text[index];
			continue;
		}

		const labelStart = image ? index + 1 : index;
		const labelEnd = matchingDelimiter(text, labelStart, "[", "]");
		if (labelEnd < 0) {
			visible += text[index];
			continue;
		}

		const label = text.slice(labelStart + 1, labelEnd);
		let syntaxEnd = labelEnd;
		if (text[labelEnd + 1] === "(") {
			const destinationEnd = matchingDelimiter(text, labelEnd + 1, "(", ")");
			if (destinationEnd < 0) {
				visible += text[index];
				continue;
			}
			syntaxEnd = destinationEnd;
		} else if (text[labelEnd + 1] === "[") {
			const referenceEnd = matchingDelimiter(text, labelEnd + 1, "[", "]");
			if (referenceEnd < 0) {
				visible += text[index];
				continue;
			}
			// Full `[text][label]` and collapsed `[label][]` references. An empty
			// second pair points back at the first, and neither is a link unless
			// the document defines the label it names.
			const reference = text.slice(labelEnd + 2, referenceEnd);
			const named = reference.trim().length > 0 ? reference : label;
			if (!labels.has(normalizedReferenceLabel(named))) {
				visible += text[index];
				continue;
			}
			syntaxEnd = referenceEnd;
		} else if (!labels.has(normalizedReferenceLabel(label))) {
			// Shortcut `[label]` reference: also a link only once defined.
			visible += text[index];
			continue;
		}

		if (!image) visible += text.slice(labelStart + 1, labelEnd);
		index = syntaxEnd;
	}
	return visible;
}

function sourceTags(text: string, labels: Set<string>, rawHtml = false): string[] {
	// Spaces keep code removal from manufacturing a tag across its boundaries.
	const withoutInlineCode = rawHtml ? text : text.replace(/(`+)([\s\S]*?)\1/g, (span) => " ".repeat(span.length));
	const htmlText = visibleHtmlText(withoutInlineCode, rawHtml);
	const visibleText = rawHtml ? htmlText : visibleMarkdownLinkText(htmlText, labels);
	return [...visibleText.matchAll(SOURCE_TAG_RE)].map((match) => match[1]);
}

function normalizedAssumption(text: string): string {
	return text
		.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "")
		.replace(SOURCE_TAG_RE, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function inspectDeliverable(
	path: string,
	universe: SourceUniverse,
): { findings: string[]; hasAssumptions: boolean } {
	const findings: string[] = [];
	let body: string;
	try {
		body = readFileSync(path, "utf-8");
	} catch (error) {
		return {
			findings: [`${basename(path)}: failed to read: ${errorMessage(error)}`],
			hasAssumptions: false,
		};
	}

	const parsed = claimBlocks(body);
	if (!parsed.hasAssumptionsSection) {
		findings.push(
			`${basename(path)}: missing ## ${ASSUMPTIONS_HEADING}`,
		);
	}

	const labels = parsed.labels;
	let hasAssumptions = false;
	for (const block of parsed.blocks) {
		const location = `${basename(path)}${block.section ? ` ## ${block.section}` : ""}`;
		const tags = sourceTags(block.text, labels, block.rawHtml);

		// A validated source declaration names the source; it is not a claim
		// grounded by that source. Match the whole canonical block and require
		// a visible literal label so extra prose or a Markdown link cannot hide.
		if (
			block.section === "Sources" &&
			universe.registered.has("scope") &&
			block.text === universe.canonicalScopeDeclaration &&
			tags.length === 1 && tags[0] === "scope"
		) {
			continue;
		}

		if (block.inAssumptions) {
			if (isNoneBlock(block.text)) continue;
			hasAssumptions = true;
			if (!tags.includes("assumption")) {
				findings.push(`${location}: assumption/open question lacks [assumption]`);
			} else if (
				universe.assumptionsAccepted &&
				!universe.acceptedAssumptions.has(normalizedAssumption(block.text))
			) {
				findings.push(
					`${location}: retained assumption is not listed in ## Assumption Confirmation`,
				);
			}
		} else {
			if (tags.length === 0) {
				findings.push(`${location}: claim block has no source tag`);
				continue;
			}
			if (tags.includes("assumption")) {
				findings.push(
					`${location}: [assumption] is outside ## ${ASSUMPTIONS_HEADING}`,
				);
			}
		}

			for (const tag of tags) {
				if (tag === "assumption") continue;
				if (tag === "desc" && universe.pastedDocumentPresent) {
					findings.push(
						`${location}: [desc] cannot ground artifacts when the initial request contains <document>; use confirmed [Q<n>]`,
					);
					continue;
				}
				if (tag.startsWith("Q")) {
				if (!universe.answeredQuestions.has(tag)) {
					findings.push(`${location}: [${tag}] has no filled answer`);
				}
				continue;
			}
			if (!universe.registered.has(tag)) {
				findings.push(`${location}: [${tag}] is not registered in ## Sources`);
			}
			if (tag === "scope") {
				if (block.section !== "Initial Scope Signal") {
					findings.push(
						`${location}: [scope] is valid only in ## Initial Scope Signal`,
					);
				}
				if (!/workflow-selected/i.test(block.text)) {
					findings.push(
						`${location}: [scope] claim is not labeled workflow-selected`,
					);
				}
			}
		}
	}

	return { findings, hasAssumptions };
}

export function main(argv: string[]): void {
	const flags = parseFlags(argv);
	if (!flags.outputPath) fail("--output-path is required");
	if (!existsSync(flags.outputPath)) {
		fail(`--output-path not found: ${flags.outputPath}`);
	}

	const firedPath = resolve(flags.outputPath);
	const stageDir = dirname(firedPath);
	const deliverables = (flags.deliverables ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	const firedBase = basename(firedPath);
	const firedIsScaffolding =
		firedBase === "memory.md" ||
		firedBase.endsWith("-questions.md") ||
		firedBase.endsWith("-timestamp.md");
	const scanPaths =
		deliverables.length > 0
			? deliverables
					.map((stem) => resolve(join(stageDir, `${stem}.md`)))
					.filter((path) => existsSync(path))
			: firedIsScaffolding
				? []
				: [firedPath];

	if (scanPaths.length === 0) {
		const result: Result = {
			pass: true,
			findings: [],
			scanned_files: [],
			questions_file: resolve(
				join(stageDir, `${flags.stage ?? "intent-capture"}-questions.md`),
			),
			findings_count: 0,
			reason: "no deliverables on disk yet",
		};
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exit(0);
	}

	const questionsPath = resolve(
		join(stageDir, `${flags.stage ?? "intent-capture"}-questions.md`),
	);
	const universe = parseSourceUniverse(questionsPath, stageDir);
	const findings = [...universe.findings];
	let hasAssumptions = false;
	for (const path of scanPaths) {
		const inspected = inspectDeliverable(path, universe);
		findings.push(...inspected.findings);
		hasAssumptions ||= inspected.hasAssumptions;
	}
	if (hasAssumptions && !universe.assumptionsAccepted) {
		findings.push(
			"retained assumptions require an answered ## Assumption Confirmation with Accept assumptions",
		);
	}

	const result: Result = {
		pass: findings.length === 0,
		findings,
		scanned_files: scanPaths,
		questions_file: questionsPath,
		findings_count: findings.length,
	};
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(0);
}

if (import.meta.main) main(process.argv.slice(2));
