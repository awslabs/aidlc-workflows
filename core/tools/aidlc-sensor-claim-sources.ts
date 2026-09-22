import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	authoritativeProjectDescription,
	errorMessage,
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
	const labels = referenceLabels(body);
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
	// The confirmation's own scaffolding (its option lines and answer tag) is
	// not assumption text; blank it so the shared block splitter cannot fold it
	// into an adjacent entry. Every other line stays visible text: a Markdown
	// definition cannot interrupt a paragraph, so `[label]: url` directly under
	// an entry is that entry's lazy continuation.
	const confirmationEntries = confirmation.map((line) =>
		CONFIRMATION_SCAFFOLD_RE.test(line) ? "" : line,
	);
	const acceptedAssumptions = new Set(
		claimBlocksFromLines(confirmationEntries)
			.blocks.map((block) => block.text)
			.filter(
				(text) =>
					isListItem(text) && sourceTags(text, labels).includes("assumption"),
			)
			.map(normalizedAssumption)
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

function isTableSeparator(line: string): boolean {
	return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function isTableLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("|") && trimmed.endsWith("|");
}

function isListItem(line: string): boolean {
	return /^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(line);
}

function isNoneBlock(text: string): boolean {
	return /^None\.?$/i.test(text.trim());
}

function claimBlocks(
	body: string,
	definitionLines: ReadonlySet<number> = new Set(),
): {
	blocks: ClaimBlock[];
	hasAssumptionsSection: boolean;
} {
	return claimBlocksFromLines(
		visibleMarkdownLines(body, { preserveIndentedCode: true }).map((line, index) =>
			definitionLines.has(index) ? "" : line,
		),
	);
}

/**
 * Splits already-visible Markdown lines into claim blocks. Both sides of the
 * assumption comparison must use this same splitter: the deliverable's
 * `## Assumptions & Open Questions` entries and the questions file's
 * `## Assumption Confirmation` entries are matched by normalized block text,
 * so wrapped list items, thematic breaks, headings, tables, and HTML blocks
 * have to fold and flush identically on both sides.
 */
function claimBlocksFromLines(lines: string[]): {
	blocks: ClaimBlock[];
	hasAssumptionsSection: boolean;
} {
	const tableHeaders = new Set<number>();
	for (let index = 1; index < lines.length; index++) {
		if (isTableSeparator(lines[index]) && isTableLine(lines[index - 1])) {
			tableHeaders.add(index - 1);
		}
	}

	const blocks: ClaimBlock[] = [];
	let section = "";
	let skipReview = false;
	let hasAssumptionsSection = false;
	let pending: string[] = [];

	const flush = (): void => {
		const text = pending.join("\n").trimEnd();
		if (text.length > 0) {
			blocks.push({
				section,
				text,
				inAssumptions: section === ASSUMPTIONS_HEADING,
			});
		}
		pending = [];
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const h2 = h2Heading(line);
		if (h2 !== null) {
			flush();
			section = h2;
			skipReview = section === REVIEW_HEADING;
			if (section === ASSUMPTIONS_HEADING) hasAssumptionsSection = true;
			continue;
		}
		if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line)) {
			flush();
			continue;
		}
		if (skipReview) continue;
		if (line.trim().length === 0 || isThematicBreak(line)) {
			flush();
			continue;
		}
		if (isHtmlBlockStart(line)) {
			flush();
			pending.push(line);
			continue;
		}
		if (isTableLine(line)) {
			flush();
			if (!tableHeaders.has(index) && !isTableSeparator(line)) {
				blocks.push({
					section,
					text: line.trim(),
					inAssumptions: section === ASSUMPTIONS_HEADING,
				});
			}
			continue;
		}
		if (isListItem(line)) {
			flush();
			pending.push(line);
			continue;
		}
		pending.push(line);
	}
	flush();

	return { blocks, hasAssumptionsSection };
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

function htmlTagAt(text: string, start: number): HtmlTag | null {
	if (text[start] !== "<" || isEscaped(text, start)) return null;
	const tail = text.slice(start);
	const named = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)\b/.exec(tail);
	const autolink = /^<(?:https?:\/\/|mailto:|[^<>\s]+@)/i.test(tail);
	if (!named && !autolink) return null;

	let quote: "'" | '"' | null = null;
	let end = -1;
	for (let index = start + 1; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote && !isEscaped(text, index)) quote = null;
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

function visibleHtmlText(text: string): string {
	let visible = "";
	let hiddenElement = "";
	let hiddenDepth = 0;
	for (let index = 0; index < text.length; index++) {
		const tag = htmlTagAt(text, index);
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

// A definition keeps its meaning inside a block quote or a list item, and the
// two nest in either order and to any depth. Taking one of each off would read
// `> - [Q1]: url` and miss the equally valid `- > [Q1]: url`, so the markers
// come off until the line stops changing. Five or more spaces after a list
// marker leave at least four columns of indented-code content. A marker-only
// item requires one column after its marker for content on following lines.
type ContainerStep = { kind: "quote" } | { kind: "indent"; columns: number; item: string; marker: string };

interface ContainerLine {
	text: string;
	context: string;
	steps: ContainerStep[];
}

function containerLine(line: string, allocateItem: () => string): ContainerLine {
	let stripped = line;
	const context: string[] = [];
	const steps: ContainerStep[] = [];
	for (;;) {
		const quote = /^ {0,3}> ?/.exec(stripped);
		if (quote) {
			stripped = stripped.slice(quote[0].length);
			context.push("quote");
			steps.push({ kind: "quote" });
			continue;
		}
		// CommonMark gives thematic breaks precedence over list markers.
		if (isThematicBreak(stripped)) {
			return { text: stripped, context: context.join("/"), steps };
		}
		const list = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\t| {1,4}(?! )| (?= {4})|$)/.exec(
			stripped,
		);
		if (list) {
			const item = allocateItem();
			stripped = stripped.slice(list[0].length);
			context.push(item);
			steps.push({
				kind: "indent",
				columns: textColumns(list[0]) + (/[ \t]$/.test(list[0]) ? 0 : 1),
				item,
				marker: list[0].trim(),
			});
			continue;
		}
		return { text: stripped, context: context.join("/"), steps };
	}
}

// CommonMark's link-destination grammar, which is what separates a definition
// from a line that merely looks like one. A destination is either an
// angle-bracket run that has to close on the same line and hold no unescaped
// `<`, or a bare run that ends at the first space or control character and
// keeps its parentheses balanced. Returns the index just past the destination,
// or -1 when the text does not carry one.
function referenceDestinationEnd(text: string, start: number): number {
	if (text[start] === "<") {
		for (let index = start + 1; index < text.length; index++) {
			if (isEscaped(text, index)) continue;
			if (text[index] === ">") return index + 1;
			if (text[index] === "<") return -1;
		}
		return -1;
	}

	let depth = 0;
	let index = start;
	for (; index < text.length; index++) {
		// Space and every ASCII control character end a bare destination.
		const codePoint = text.codePointAt(index) ?? 0;
		if (codePoint <= 0x20 || codePoint === 0x7f) break;
		if (isEscaped(text, index)) continue;
		if (text[index] === "(") {
			depth++;
			if (depth > 32) return -1;
		} else if (text[index] === ")") {
			depth--;
			if (depth < 0) return -1;
		}
	}
	return depth === 0 && index > start ? index : -1;
}

interface ReferenceDefinition {
	label: string;
	endLine: number;
}

interface ReferenceAnalysis {
	labels: Set<string>;
	definitionLines: Set<number>;
}

interface ActiveListContainer {
	steps: ContainerStep[];
}

function contextFor(steps: ContainerStep[]): string {
	return steps.map((step) => step.kind === "quote" ? "quote" : step.item).join("/");
}

function contextParts(context: string): string[] {
	return context.length > 0 ? context.split("/") : [];
}

function sharedSteps(a: ContainerStep[], b: ContainerStep[]): number {
	let shared = 0;
	while (shared < a.length && shared < b.length) {
		const left = a[shared];
		const right = b[shared];
		if (left.kind !== right.kind) break;
		if (left.kind === "indent" && right.kind === "indent" && left.item !== right.item) break;
		shared++;
	}
	return shared;
}

function textColumns(text: string): number {
	let column = 0;
	for (const char of text) {
		if (char === "\t") {
			column += 4 - (column % 4);
		} else {
			column++;
		}
	}
	return column;
}

function firstContent(text: string): { index: number; column: number } | null {
	let column = 0;
	for (let index = 0; index < text.length; index++) {
		if (text[index] === " ") {
			column++;
			continue;
		}
		if (text[index] === "\t") {
			column += 4 - (column % 4);
			continue;
		}
		return { index, column };
	}
	return null;
}

function stripIndentColumns(text: string, required: number): string | null {
	let column = 0;
	let index = 0;
	while (column < required && index < text.length) {
		if (text[index] === " ") {
			column++;
			index++;
			continue;
		}
		if (text[index] === "\t") {
			column += 4 - (column % 4);
			index++;
			continue;
		}
		return null;
	}
	if (column < required) return null;
	return `${" ".repeat(column - required)}${text.slice(index)}`;
}

// Apply a container's raw requirements to a line: quote markers must be
// present; indentation must be present unless the remainder is blank and no
// quote requirement follows. Returns null when the container is not continued.
function stripContainerSteps(
	line: string,
	steps: ContainerStep[],
): { text: string; blank: boolean } | null {
	let text = line;
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		if (step.kind === "quote") {
			const quote = /^ {0,3}> ?/.exec(text);
			if (!quote) return null;
			text = text.slice(quote[0].length);
			continue;
		}
		if (/^[ \t]*$/.test(text)) {
			for (let later = index + 1; later < steps.length; later++) {
				if (steps[later].kind === "quote") return null;
			}
			return { text: "", blank: true };
		}
		const stripped = stripIndentColumns(text, step.columns);
		if (stripped === null) return null;
		text = stripped;
	}
	return { text, blank: /^[ \t]*$/.test(text) };
}

function explicitListContainer(
	line: string,
	listItem: string,
	allocateItem: () => string,
): { line: ContainerLine; active: ActiveListContainer } | null {
	let text = line;
	const before: string[] = [];
	for (;;) {
		const quote = /^ {0,3}> ?/.exec(text);
		if (!quote) break;
		text = text.slice(quote[0].length);
		before.push("quote");
	}
	if (isThematicBreak(text)) return null;

	const marker =
		/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\t| {1,4}(?! )| (?= {4})|$)/.exec(text);
	if (!marker) return null;
	const after = containerLine(text.slice(marker[0].length), allocateItem);
	const steps: ContainerStep[] = [
		...before.map((): ContainerStep => ({ kind: "quote" })),
		{
			kind: "indent",
			columns: textColumns(marker[0]) + (/[ \t]$/.test(marker[0]) ? 0 : 1),
			item: listItem,
			marker: marker[0].trim(),
		},
		...after.steps,
	];
	return {
		line: {
			text: after.text,
			context: contextFor(steps),
			steps,
		},
		active: {
			steps,
		},
	};
}

// Container markers on the definition's first line are not repeated on its
// continuation lines. Preserve the active list item's exact quote/list nesting,
// indentation columns, and identity so continuations work through block quotes
// and tabs but never cross into a sibling item.
function documentContainerLines(lines: string[]): ContainerLine[] {
	const result: ContainerLine[] = [];
	let activeList: ActiveListContainer | null = null;
	let listItem = 0;
	const allocateItem = (): string => `list#${++listItem}`;

	for (const line of lines) {
		if (line.trim().length === 0) {
			result.push({
				text: line,
				context: activeList ? contextFor(activeList.steps) : "",
				steps: activeList?.steps ?? [],
			});
			continue;
		}

		// A marker meeting the active item's content indent is nested in that
		// item, not the start of a new list.
		if (activeList) {
			// Continue the deepest item whose raw requirements this line meets;
			// inner items close when only an outer prefix matches.
			let matched: ContainerStep[] | null = null;
			let inside: { text: string; blank: boolean } | null = null;
			for (let count = activeList.steps.length; count > 0; count--) {
				if (activeList.steps[count - 1].kind !== "indent") continue;
				const prefix = activeList.steps.slice(0, count);
				inside = stripContainerSteps(line, prefix);
				if (inside !== null) {
					matched = prefix;
					break;
				}
			}
			if (matched !== null && inside !== null) {
				const context = contextFor(matched);
				if (inside.blank) {
					result.push({ text: "", context, steps: matched });
					continue;
				}
				const after = containerLine(inside.text, allocateItem);
				const steps = [...matched, ...after.steps];
				activeList.steps = steps;
				result.push({
					text: after.text,
					context: [context, ...contextParts(after.context)].join("/"),
					steps,
				});
				continue;
			}
		}

		const explicitList = explicitListContainer(line, allocateItem(), allocateItem);
		if (explicitList) {
			activeList = explicitList.active;
			result.push(explicitList.line);
			continue;
		}

		activeList = null;
		result.push(containerLine(line, allocateItem));
	}

	return result;
}

const HTML_BLOCK_TAGS =
	"address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCK_RE = new RegExp(
	`^(?:<(?:script|pre|style|textarea)(?:[ \\t>]|$)|<!--|<\\?|<![A-Z]|<!\\[CDATA\\[|<\\/?(?:${HTML_BLOCK_TAGS})(?:[ \\t\\n\\f\\r\\/>]|$))`,
	"i",
);
const HTML_FINITE_BLOCKS: ReadonlyArray<readonly [RegExp, RegExp]> = [
	[/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
	[/^<!--/, /-->/],
	[/^<\?/, /\?>/],
	[/^<!\[CDATA\[/, /\]\]>/],
	[/^<![A-Za-z]/, />/],
];
const HTML_INLINE_TAG_LINE_RE =
	/^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;

function isThematicBreak(line: string): boolean {
	const content = firstContent(line);
	if (content === null || content.column > 3) return false;
	return /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(
		line.slice(content.index),
	);
}

function isHtmlBlockStart(line: string): boolean {
	const content = firstContent(line);
	return (
		content !== null &&
		content.column <= 3 &&
		HTML_BLOCK_RE.test(line.slice(content.index))
	);
}

function interruptsReferenceContinuation(text: string): boolean {
	const content = firstContent(text);
	if (!content) return true;
	// Once a reference definition has started, CommonMark accepts indented lazy
	// continuation lines. At that point four columns are content, not a fresh
	// indented-code block, and block-start tests do not interrupt the definition.
	if (content.column > 3) return false;
	const rest = text.slice(content.index);
	return (
		/^#{1,6}(?:[ \t]+|$)/.test(rest) ||
		isThematicBreak(text) ||
		/^(?:=+|-+)[ \t]*$/.test(rest) ||
		HTML_BLOCK_RE.test(rest)
	);
}

function continuesContext(lineContext: string, context: string): boolean {
	return (
		lineContext === context ||
		(lineContext === "" && context !== "") ||
		(lineContext !== "" && context.startsWith(`${lineContext}/`))
	);
}

function canContinueReference(
	lines: ContainerLine[],
	index: number,
	context: string,
): boolean {
	const line = lines[index];
	if (!line) return false;
	return (
		continuesContext(line.context, context) &&
		!interruptsReferenceContinuation(line.text)
	);
}

function referenceTitleEnd(
	lines: ContainerLine[],
	startLine: number,
	start: number,
): number | null {
	const context = lines[startLine].context;
	const opening = lines[startLine].text[start];
	if (opening !== '"' && opening !== "'" && opening !== "(") return null;
	const closing = opening === "(" ? ")" : opening;
	let lineIndex = startLine;
	let cursor = start + 1;

	for (;;) {
		const text = lines[lineIndex].text;
		for (; cursor < text.length; cursor++) {
			if (isEscaped(text, cursor)) continue;
			if (opening === "(" && text[cursor] === "(") return null;
			if (text[cursor] !== closing) continue;
			return /^[ \t]*$/.test(text.slice(cursor + 1)) ? lineIndex : null;
		}

		const next = lines[lineIndex + 1];
		if (!next || !canContinueReference(lines, lineIndex + 1, context)) {
			return null;
		}
		lineIndex++;
		cursor = 0;
	}
}

// Parse one complete CommonMark link-reference definition. Lines are consumed
// only after the label, destination, and optional title are certainly valid;
// malformed candidates remain visible prose and are inspected fail-closed.
function referenceDefinitionAt(
	lines: ContainerLine[],
	startLine: number,
): ReferenceDefinition | null {
	const context = lines[startLine].context;
	let lineIndex = startLine;
	let text = lines[lineIndex].text;
	const first = firstContent(text);
	if (!first || first.column > 3 || text[first.index] !== "[") return null;
	const start = first.index;

	let cursor = start + 1;
	let label = "";
	for (;;) {
		let closed = false;
		for (; cursor < text.length; cursor++) {
			if (isEscaped(text, cursor)) {
				label += text[cursor];
				continue;
			}
			if (text[cursor] === "[") return null;
			if (text[cursor] === "]") {
				closed = true;
				break;
			}
			label += text[cursor];
		}
		if (closed) break;

		const next = lines[lineIndex + 1];
		if (!next || !canContinueReference(lines, lineIndex + 1, context)) {
			return null;
		}
		label += "\n";
		lineIndex++;
		text = next.text;
		cursor = 0;
	}

	if (
		text[cursor + 1] !== ":" ||
		!/[^ \t\n\r]/.test(label) ||
		Array.from(label).length > 999
	) {
		return null;
	}

	let destinationLine = lineIndex;
	let destinationOffset = cursor + 2;
	let destinationText = text.slice(destinationOffset);
	let destination = firstContent(destinationText);
	if (!destination) {
		const next = lines[destinationLine + 1];
		if (
			!next ||
			!canContinueReference(lines, destinationLine + 1, context)
		) {
			return null;
		}
		destinationLine++;
		destinationOffset = 0;
		destinationText = next.text;
		destination = firstContent(destinationText);
		if (!destination) return null;
	}
	const destinationStart = destination.index;

	const destinationEnd = referenceDestinationEnd(
		destinationText,
		destinationStart,
	);
	if (destinationEnd < 0) return null;

	const rawTrailing = destinationText.slice(destinationEnd);
	if (/[^ \t]/.test(rawTrailing)) {
		if (!/^[ \t]+/.test(rawTrailing)) return null;
		const trailing = firstContent(rawTrailing);
		if (!trailing) return null;
		const titleStart =
			destinationOffset + destinationEnd + trailing.index;
		const titleEnd = referenceTitleEnd(lines, destinationLine, titleStart);
		return titleEnd === null ? null : { label, endLine: titleEnd };
	}

	const possibleTitle = lines[destinationLine + 1];
	if (
		possibleTitle &&
		canContinueReference(lines, destinationLine + 1, context)
	) {
		const title = firstContent(possibleTitle.text);
		if (
			title &&
			['"', "'", "("].includes(possibleTitle.text[title.index])
		) {
			const titleEnd = referenceTitleEnd(
				lines,
				destinationLine + 1,
				title.index,
			);
			if (titleEnd !== null) return { label, endLine: titleEnd };
		}
	}

	return { label, endLine: destinationLine };
}

// CommonMark label matching uses Unicode case folding after whitespace
// normalization. The lower-then-upper sequence matches markdown-it and folds
// variants such as `ss`, `ß`, and `ẞ` to the same key.
function normalizedReferenceLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();
}

function referenceAnalysis(body: string): ReferenceAnalysis {
	const visibleLines = visibleMarkdownLines(body, { preserveIndentedCode: true });
	const lines = documentContainerLines(visibleLines);
	const labels = new Set<string>();
	const definitionLines = new Set<number>();
	let block: "none" | "paragraph" | "html" = "none";
	let blockContext = "";
	let blockSteps: ContainerStep[] = [];
	let rejectedItem: string | null = null;
	let htmlEnd: RegExp | null = null;
	let htmlSteps: ContainerStep[] = [];

	// CommonMark §4.7: a link reference definition cannot interrupt a paragraph.
	// A definition-shaped line directly under prose is visible lazy continuation.
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const content = firstContent(line.text);
		if (block === "html") {
			// CommonMark §4.6: HTML never continues lazily. It continues only while
			// its container's raw quote markers and indentation are present; what
			// the raw content looks like as Markdown is irrelevant.
			const inside = stripContainerSteps(visibleLines[index], htmlSteps);
			if (inside === null) {
				block = "none";
				rejectedItem = null;
				htmlEnd = null;
			} else {
				if (htmlEnd ? htmlEnd.test(inside.text) : inside.blank) {
					block = "none";
					rejectedItem = null;
					htmlEnd = null;
				}
				continue;
			}
		}
		if (content === null) {
			// CommonMark §5.2: empty items cannot interrupt paragraphs, except
			// sibling items; a lone hyphen also closes prose as a setext underline.
			if (block === "paragraph" && !continuesContext(line.context, blockContext)) {
				const shared = sharedSteps(blockSteps, line.steps);
				const added = line.steps[shared];
				if (added?.kind === "indent") {
					if (added.marker !== "-" && shared === blockSteps.length) {
						rejectedItem = added.item;
						continue;
					}
				}
			}
			block = "none";
			rejectedItem = null;
			continue;
		}
		let continuation = false;
		if (block === "paragraph") {
			if (!continuesContext(line.context, blockContext)) {
				const shared = sharedSteps(blockSteps, line.steps);
				const added = line.steps[shared];
				// CommonMark §5.3: a new nested ordered list interrupts only at 1;
				// leaving the paragraph's container always allows a new item.
				if (added?.kind === "indent") {
					const digits = /^\d+/.exec(added.marker);
					const start = digits === null ? null : Number(digits[0]);
					continuation = added.item === rejectedItem ||
						(shared === blockSteps.length && start !== null && start !== 1);
					if (continuation) rejectedItem = added.item;
				}
				if (!continuation) {
					block = "none";
					rejectedItem = null;
					blockContext = line.context;
					blockSteps = line.steps;
				}
			}
		} else {
			blockContext = line.context;
			blockSteps = line.steps;
		}

		const rest = line.text.slice(content.index);
		if (content.column <= 3) {
			// CommonMark §4.6: kinds 1–5 end at their delimiter, not a blank line.
			const finite = HTML_FINITE_BLOCKS.find(([start]) => start.test(rest));
			if (finite) {
				if (finite[1].test(rest.slice(1))) {
					block = "none";
					rejectedItem = null;
				} else {
					block = "html";
					rejectedItem = null;
					htmlSteps = line.steps;
					htmlEnd = finite[1];
				}
				continue;
			}
			if (
				HTML_BLOCK_RE.test(rest) ||
				(block === "none" && HTML_INLINE_TAG_LINE_RE.test(rest))
			) {
				block = "html";
				rejectedItem = null;
				htmlSteps = line.steps;
				htmlEnd = null;
				continue;
			}
		}

		if (block === "none") {
			const definition = referenceDefinitionAt(lines, index);
			if (definition) {
				labels.add(normalizedReferenceLabel(definition.label));
				for (let line = index; line <= definition.endLine; line++) {
					definitionLines.add(line);
				}
				index = definition.endLine;
				blockContext = lines[index].context;
				blockSteps = lines[index].steps;
				continue;
			}
		}

		if (
			content.column <= 3 &&
			(/^#{1,6}(?:[ \t]+|$)/.test(rest) ||
				isThematicBreak(line.text) ||
				(block === "paragraph" && /^(?:=+|-+)[ \t]*$/.test(rest)))
		) {
			block = "none";
			rejectedItem = null;
			continue;
		}
		if (block === "none" && content.column > 3) continue;
		if (block !== "paragraph") rejectedItem = null;
		block = "paragraph";
	}

	return { labels, definitionLines };
}

// A reference resolves against definitions anywhere in the document.
function referenceLabels(body: string): Set<string> {
	return referenceAnalysis(body).labels;
}

function withoutReferenceDefinitions(text: string): string {
	const analysis = referenceAnalysis(text);
	return visibleMarkdownLines(text, { preserveIndentedCode: true })
		.map((line, index) => (analysis.definitionLines.has(index) ? "" : line))
		.join("\n");
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

function sourceTags(text: string, labels: Set<string>): string[] {
	const withoutInlineCode = text.replace(/(`+)([\s\S]*?)\1/g, "");
	const visibleText = visibleMarkdownLinkText(
		withoutReferenceDefinitions(visibleHtmlText(withoutInlineCode)),
		labels,
	);
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

	const references = referenceAnalysis(body);
	const parsed = claimBlocks(body, references.definitionLines);
	if (!parsed.hasAssumptionsSection) {
		findings.push(
			`${basename(path)}: missing ## ${ASSUMPTIONS_HEADING}`,
		);
	}

	const labels = references.labels;
	let hasAssumptions = false;
	for (const block of parsed.blocks) {
		const location = `${basename(path)}${block.section ? ` ## ${block.section}` : ""}`;
		const tags = sourceTags(block.text, labels);

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
