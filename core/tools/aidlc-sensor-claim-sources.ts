import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
	assumptionConfirmation: string;
	findings: string[];
}

const ASSUMPTIONS_HEADING = "Assumptions & Open Questions";
const REVIEW_HEADING = "Review";
const SOURCE_TAG_RE =
	/\[(desc|scope|assumption|Q\d+|memory:[A-Za-z0-9][A-Za-z0-9._-]*)\]/g;

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

function sectionBody(body: string, heading: string): string | null {
	const lines = body.split(/\r?\n/);
	let collecting = false;
	const collected: string[] = [];
	for (const line of lines) {
		const match = /^##\s+(.+?)\s*$/.exec(line);
		if (match) {
			if (collecting) break;
			collecting = match[1] === heading;
			continue;
		}
		if (collecting) collected.push(line);
	}
	return collecting ? collected.join("\n") : null;
}

function answerIsFilled(answer: string): boolean {
	const normalized = answer.trim();
	return normalized.length > 0 && !/^_+$/.test(normalized);
}

function parseSourceUniverse(questionsPath: string): SourceUniverse {
	const findings: string[] = [];
	if (!existsSync(questionsPath)) {
		return {
			registered: new Set(),
			answeredQuestions: new Set(),
			assumptionsAccepted: false,
			assumptionConfirmation: "",
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
			assumptionConfirmation: "",
			findings: [
				`failed to read questions file ${questionsPath}: ${errorMessage(error)}`,
			],
		};
	}

	const registered = new Set<string>();
	const sources = sectionBody(body, "Sources");
	if (sources === null) {
		findings.push("questions file is missing ## Sources");
	} else {
		for (const match of sources.matchAll(
			/\[(desc|scope|memory:[A-Za-z0-9][A-Za-z0-9._-]*)\]/g,
		)) {
			const id = match[1];
			if (registered.has(id)) {
				findings.push(`duplicate source id [${id}] in ## Sources`);
			}
			registered.add(id);
		}
		for (const required of ["desc", "scope"]) {
			if (!registered.has(required)) {
				findings.push(`## Sources is missing [${required}]`);
			}
		}
	}

	const answeredQuestions = new Set<string>();
	const seenQuestions = new Set<string>();
	const questionMatches = [
		...body.matchAll(/^##\s+Q(\d+)\b[^\r\n]*$/gm),
	];
	for (const match of questionMatches) {
		const id = `Q${match[1]}`;
		if (seenQuestions.has(id)) {
			findings.push(`duplicate question id ${id}`);
		}
		seenQuestions.add(id);
		const start = (match.index ?? 0) + match[0].length;
		const nextH2 = body.indexOf("\n## ", start);
		const end = nextH2 >= 0 ? nextH2 : body.length;
		const section = body.slice(start, end);
		const answer = /^\[Answer\]:\s*(.*)$/m.exec(section)?.[1] ?? "";
		if (answerIsFilled(answer)) answeredQuestions.add(id);
	}

	const assumptionSection = sectionBody(body, "Assumption Confirmation");
	const assumptionAnswer =
		assumptionSection === null
			? ""
			: (/^\[Answer\]:\s*(.*)$/m.exec(assumptionSection)?.[1] ?? "");

	return {
		registered,
		answeredQuestions,
		assumptionsAccepted:
			answerIsFilled(assumptionAnswer) &&
			/^(?:A[.)]?\s*)?Accept assumptions\b/i.test(assumptionAnswer.trim()),
		assumptionConfirmation: assumptionSection ?? "",
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
	const lines = body.split(/\r?\n/);
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
	let inFence = false;

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
		const h2 = /^##\s+(.+?)\s*$/.exec(line);
		if (h2) {
			flush();
			section = h2[1];
			skipReview = section === REVIEW_HEADING;
			if (section === ASSUMPTIONS_HEADING) hasAssumptionsSection = true;
			continue;
		}
		if (/^#{1,6}\s+/.test(line)) {
			flush();
			continue;
		}
		if (/^\s*```/.test(line)) {
			flush();
			inFence = !inFence;
			continue;
		}
		if (inFence || skipReview || /^\s*<!--/.test(line)) continue;
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

function sourceTags(text: string): string[] {
	return [...text.matchAll(SOURCE_TAG_RE)].map((match) => match[1]);
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
				!normalizedAssumption(universe.assumptionConfirmation).includes(
					normalizedAssumption(block.text),
				)
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
	const universe = parseSourceUniverse(questionsPath);
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
