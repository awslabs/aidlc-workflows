import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { errorMessage } from "./aidlc-lib.ts";

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
	answeredQuestions: Set<string>;
	assumptionsAccepted: boolean;
	acceptedAssumptions: Set<string>;
	findings: string[];
}

interface RecordAuthority {
	projectDescription: string;
	scope: string;
	projectRoot: string;
	activeSpace: string;
	findings: string[];
}

const ASSUMPTIONS_HEADING = "Assumptions & Open Questions";
const REVIEW_HEADING = "Review";
const ACCEPT_ASSUMPTIONS_ANSWER = "A. Accept assumptions";
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
const REFERENCE_TITLE_RE =
	/^ {0,3}(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))[ \t]*$/;

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

function visibleMarkdownLines(body: string): string[] {
	const lines = body.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
	const visible: string[] = [];
	let inComment = false;
	let fence: { marker: "`" | "~"; length: number } | null = null;

	for (const rawLine of lines) {
		if (fence) {
			const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(rawLine);
			if (
				closing &&
				closing[1][0] === fence.marker &&
				closing[1].length >= fence.length
			) {
				fence = null;
			}
			visible.push("");
			continue;
		}

		let line = "";
		let cursor = 0;
		while (cursor < rawLine.length) {
			if (inComment) {
				const end = rawLine.indexOf("-->", cursor);
				if (end < 0) {
					cursor = rawLine.length;
					break;
				}
				inComment = false;
				cursor = end + 3;
				continue;
			}

			const start = rawLine.indexOf("<!--", cursor);
			if (start < 0) {
				line += rawLine.slice(cursor);
				break;
			}
			line += rawLine.slice(cursor, start);
			inComment = true;
			cursor = start + 4;
		}

		const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (opening) {
			fence = {
				marker: opening[1][0] as "`" | "~",
				length: opening[1].length,
			};
			visible.push("");
			continue;
		}
		visible.push(line);
	}

	return visible;
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

	const projectDescription = stateField(stateBody, "Project");
	const scope = stateField(stateBody, "Scope");
	const projectRoot = projectRootFor(recordRoot, stateBody);
	const activeSpace = projectRoot
		? activeSpaceFor(projectRoot, recordRoot)
		: "";
	if (!projectDescription) {
		findings.push("aidlc-state.md is missing Project authority for [desc]");
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
	const sections = sectionsNamed(visibleMarkdownLines(memoryBody), heading);
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
			findings: [
				`failed to read questions file ${questionsPath}: ${errorMessage(error)}`,
			],
		};
	}

	const lines = visibleMarkdownLines(body);
	const authority = loadRecordAuthority(stageDir);
	findings.push(...authority.findings);
	const registered = new Set<string>();
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
						'[desc] must use Initial description: "<verbatim project description>"',
					);
				} else if (parsed !== authority.projectDescription) {
					findings.push(
						"[desc] does not exactly match Project in aidlc-state.md",
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
	const acceptedAssumptions = new Set(
		confirmation
			.filter((line) => isListItem(line))
			.filter((line) => sourceTags(line).includes("assumption"))
			.map(normalizedAssumption)
			.filter((entry) => entry.length > 0),
	);

	return {
		registered,
		answeredQuestions,
		assumptionsAccepted:
			assumptionAnswer.trim() === ACCEPT_ASSUMPTIONS_ANSWER,
		acceptedAssumptions,
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
	return /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
}

function isNoneBlock(text: string): boolean {
	return /^None\.?$/i.test(text.trim());
}

function claimBlocks(body: string): {
	blocks: ClaimBlock[];
	hasAssumptionsSection: boolean;
} {
	const lines = visibleMarkdownLines(body);
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
		const text = pending.join("\n").trim();
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
		if (line.trim().length === 0 || /^\s*---+\s*$/.test(line)) {
			flush();
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
			pending.push(line.trim());
			continue;
		}
		pending.push(line.trim());
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

function withoutReferenceDefinitions(text: string): string {
	const visible: string[] = [];
	let mayContinueDefinition = false;
	for (const line of text.split("\n")) {
		if (mayContinueDefinition && REFERENCE_TITLE_RE.test(line)) {
			visible.push("");
			mayContinueDefinition = false;
			continue;
		}

		const start = line.search(/\S/);
		if (start >= 0 && start <= 3 && line[start] === "[") {
			const labelEnd = matchingDelimiter(line, start, "[", "]");
			if (labelEnd >= 0 && line[labelEnd + 1] === ":") {
				visible.push("");
				mayContinueDefinition = true;
				continue;
			}
		}

		visible.push(line);
		mayContinueDefinition = false;
	}
	return visible.join("\n");
}

function visibleMarkdownLinkText(text: string): string {
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
			syntaxEnd = referenceEnd;
		} else if (!image) {
			visible += text[index];
			continue;
		}

		if (!image) visible += text.slice(labelStart + 1, labelEnd);
		index = syntaxEnd;
	}
	return visible;
}

function sourceTags(text: string): string[] {
	const withoutInlineCode = text.replace(/(`+)([\s\S]*?)\1/g, "");
	const visibleText = visibleMarkdownLinkText(
		withoutReferenceDefinitions(visibleHtmlText(withoutInlineCode)),
	);
	return [...visibleText.matchAll(SOURCE_TAG_RE)].map((match) => match[1]);
}

function normalizedAssumption(text: string): string {
	return text
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
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

	let hasAssumptions = false;
	for (const block of parsed.blocks) {
		const location = `${basename(path)}${block.section ? ` ## ${block.section}` : ""}`;
		const tags = sourceTags(block.text);

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
