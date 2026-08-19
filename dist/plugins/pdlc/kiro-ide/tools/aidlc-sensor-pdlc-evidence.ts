// aidlc-sensor-pdlc-evidence.ts — ADVISORY claim-grounding sensor (pdlc plugin).
//
// The machine-enforceable half of overconfidence prevention: checks that every
// substantive claim in the PR/FAQ and the prioritization scoring carries an
// inline source tag, and that the tag resolves to something real — a filled
// answer in the sibling questions file, a registered entry in that file's
// `## Sources` block, or an upstream pdlc artifact that exists on disk.
//
// Mirrors the mechanic of core's `claim-sources` sensor. It is NOT that sensor:
// claim-sources is hard-scoped to Intent Capture (its `matches:` glob and its
// tag vocabulary resolve against `aidlc-state.md` + `intent-capture-questions.md`),
// so importing it here would check the wrong deliverables. This one is scoped to
// two pdlc files and adds the tag form those files need: `[artifact:pdlc-<name>]`,
// for a claim carried forward from an upstream discovery artifact whose own
// claims were already tagged at the stage that wrote them.
//
// Self-contained — no import of the framework's aidlc-lib. A plugin tool ships
// in its own delta and must not depend on a sibling core tool being present.
//
// Interface: the dispatcher passes only `--stage <slug> --output-path <path>` to
// a plugin sensor (`--deliverables` and `--consumes` are threaded for two
// hardcoded core ids only), so everything else is derived from the fired path.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// The two deliverables this sensor owns, by filename stem. Widening the sensor
// to another pdlc artifact is one entry here plus a line in the manifest prose.
const TARGET_STEMS = new Set(["pdlc-prfaq", "pdlc-prioritization-scoring"]);
// The scoring-table checks apply to this stem only.
const SCORING_STEM = "pdlc-prioritization-scoring";

const ASSUMPTIONS_HEADING = "Assumptions & Open Questions";
const REVIEW_HEADING = "Review";

// Inline claim tags. `artifact:` is the pdlc addition (see the header comment).
const SOURCE_TAG_RE =
  /\[(desc|scope|assumption|Q\d+|memory:[A-Za-z0-9][A-Za-z0-9._-]*|artifact:pdlc-[a-z0-9-]+)\]/g;
// A `## Sources` register entry — a VISIBLE Markdown list item. `[Q<n>]` and
// `[assumption]` are never register entries: a question resolves against its own
// answer, an assumption against the assumptions section.
const SOURCE_ENTRY_RE =
  /^ {0,3}[-*+]\s+\[(desc|scope|memory:[A-Za-z0-9][A-Za-z0-9._-]*|artifact:pdlc-[a-z0-9-]+)\]\s+(.+?)\s*$/;
// A single-line link reference definition. A tag whose label is defined here
// renders as a link, not as literal text, so it grounds nothing.
const REFERENCE_DEF_RE = /^ {0,3}\[([^\]]+)\]:\s*\S/;
// A bare 0-10 score cell.
const SCORE_CELL_RE = /^(?:10|[0-9])$/;
// A declared score column — the primary scoring-table discriminator, because
// the prescribed per-criterion row shape (Criterion | Weight | Score |
// Rationale) carries only one score per row.
const SCORE_HEADER_RE = /score/i;
// The column that has to hold the reason for a score.
const RATIONALE_HEADER_RE = /rationale|reason|evidence|basis|why/i;
// Values that look filled but say nothing.
const EMPTY_RATIONALE_RE = /^(?:-+|n\/?a|tbd|todo|\.)$/i;
// Depth of the record-dir walk that resolves `[artifact:…]` citations.
const RECORD_WALK_MAX_DEPTH = 4;

interface Flags {
  stage?: string;
  outputPath?: string;
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
  line: number;
  inAssumptions: boolean;
}

interface SourceUniverse {
  registered: Set<string>;
  answeredQuestions: Set<string>;
  findings: string[];
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stage") flags.stage = argv[++i];
    else if (argv[i] === "--output-path") flags.outputPath = argv[++i];
  }
  return flags;
}

function fail(message: string): never {
  process.stderr.write(`aidlc-sensor-pdlc-evidence: ${message}\n`);
  process.exit(1);
}

function emit(result: Result): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

// The sensor fired on a write it does not own. A clean no-op, never a finding:
// the dispatcher fires on EVERY write under the record dir for a stage that
// imports this sensor, and most of those writes are some other artifact.
function passThrough(questionsFile: string, reason: string): never {
  emit({
    pass: true,
    findings: [],
    scanned_files: [],
    questions_file: questionsFile,
    findings_count: 0,
    reason,
  });
}

// --- Markdown reading -------------------------------------------------------

// Blank out fenced code blocks and strip HTML comments, preserving line numbers
// so findings can cite a line the author can navigate to.
function visibleMarkdownLines(body: string): string[] {
  const lines = body.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  const visible: string[] = [];
  let inComment = false;
  let fence: { marker: string; length: number } | null = null;

  for (const rawLine of lines) {
    if (fence) {
      const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(rawLine);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
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
      fence = { marker: opening[1][0], length: opening[1].length };
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

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}

function isTableLine(line: string): boolean {
  return line.trim().includes("|");
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(line);
}

function isThematicBreak(line: string): boolean {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
}

// A block that states an absence owes no source. An explicit allowlist, not a
// prefix match: "None in this set." is an absence, "None of the candidates
// cleared the bar" is a claim.
const ABSENCE_RE = /^(?:none|none in this set|none identified|not applicable|n\/?a)\.?$/i;

function isNoneBlock(text: string): boolean {
  return ABSENCE_RE.test(text.trim());
}

// The prescribed marker for a required field the run could not resolve. The
// upstream stages instruct writing `Unknown (open question) [assumption]` in
// place of a value, so `[assumption]` legitimately appears outside the
// assumptions section in exactly that form — and nowhere else.
const UNRESOLVED_MARKER_RE = /unknown \(open question\)/i;

function normalizedLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

// Labels the document defines as link references. Deliberately single-line only:
// the divergence from full CommonMark lands as a demand for a citation the
// document may not owe, never as a pass for an invisible tag.
function referenceLabels(lines: string[]): Set<string> {
  const labels = new Set<string>();
  for (const line of lines) {
    const match = REFERENCE_DEF_RE.exec(line);
    if (match) labels.add(normalizedLabel(match[1]));
  }
  return labels;
}

function sourceTags(text: string, labels: ReadonlySet<string>): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(SOURCE_TAG_RE)) {
    if (labels.has(normalizedLabel(match[1]))) continue;
    tags.push(match[1]);
  }
  return tags;
}

function hasSourceTag(text: string, labels: ReadonlySet<string>): boolean {
  SOURCE_TAG_RE.lastIndex = 0;
  let hasTag = false;
  let match: RegExpExecArray | null;
  match = SOURCE_TAG_RE.exec(text);
  while (match !== null) {
    if (!labels.has(normalizedLabel(match[1]))) {
      hasTag = true;
      break;
    }
    match = SOURCE_TAG_RE.exec(text);
  }
  SOURCE_TAG_RE.lastIndex = 0;
  return hasTag;
}

// --- The source universe ----------------------------------------------------

function answerIsFilled(answer: string): boolean {
  const normalized = answer.trim();
  return normalized.length > 0 && !/^_+$/.test(normalized);
}

// Every `pdlc-*.md` present under this run's record dir, by stem. Resolves
// `[artifact:pdlc-<name>]` citations: a citation to an upstream discovery
// artifact that was never written is not a source.
function recordArtifactStems(stageDir: string): Set<string> {
  const stems = new Set<string>();
  // <record>/<phase>/<stage>/<file>.md — two levels up is the record root.
  const recordRoot = resolve(stageDir, "..", "..");
  if (!existsSync(recordRoot)) return stems;

  const walk = (dir: string, depth: number): void => {
    if (depth > RECORD_WALK_MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "audit") continue;
      const path = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(path, depth + 1);
      else if (entry.startsWith("pdlc-") && entry.endsWith(".md")) {
        stems.add(basename(entry, ".md"));
      }
    }
  };
  walk(recordRoot, 0);
  return stems;
}

function validateRegisterEntry(
  id: string,
  value: string,
  artifactStems: ReadonlySet<string>,
  findings: string[],
): boolean {
  if (id === "desc" || id === "scope" || id.startsWith("memory:")) {
    // Shape only. The stage prose owns the exact wording of these three; this
    // sensor checks that the register declares them and that claims cite
    // something declared.
    return value.length > 0;
  }
  const name = id.slice("artifact:".length);
  if (!artifactStems.has(name)) {
    findings.push(
      `## Sources registers [${id}] but no ${name}.md exists under this run's record dir`,
    );
    return false;
  }
  return true;
}

function parseQuestionsFile(
  questionsPath: string,
  artifactStems: ReadonlySet<string>,
): SourceUniverse {
  const empty = { registered: new Set<string>(), answeredQuestions: new Set<string>() };
  if (!existsSync(questionsPath)) {
    return { ...empty, findings: [`questions file missing: ${questionsPath}`] };
  }
  let body: string;
  try {
    body = readFileSync(questionsPath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...empty, findings: [`failed to read ${questionsPath}: ${detail}`] };
  }

  const lines = visibleMarkdownLines(body);
  const findings: string[] = [];
  const registered = new Set<string>();

  const sourceSections = sectionsNamed(lines, "Sources");
  if (sourceSections.length === 0) {
    findings.push("questions file is missing ## Sources");
  } else {
    if (sourceSections.length > 1) {
      findings.push("questions file has duplicate ## Sources sections");
    }
    const seen = new Set<string>();
    for (const line of sourceSections[0]) {
      const match = SOURCE_ENTRY_RE.exec(line);
      if (!match) continue;
      const [, id, value] = match;
      if (seen.has(id)) findings.push(`duplicate source id [${id}] in ## Sources`);
      seen.add(id);
      if (validateRegisterEntry(id, value, artifactStems, findings)) registered.add(id);
    }
  }

  const answeredQuestions = new Set<string>();
  const seenQuestions = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const heading = h2Heading(lines[index]);
    const question = heading ? /^Q(\d+)\b/.exec(heading) : null;
    if (!question) continue;
    const id = `Q${question[1]}`;
    if (seenQuestions.has(id)) findings.push(`duplicate question id ${id}`);
    seenQuestions.add(id);
    let end = index + 1;
    while (end < lines.length && h2Heading(lines[end]) === null) end++;
    const answers = lines
      .slice(index + 1, end)
      .map((line) => /^\[Answer\]:\s*(.*)$/.exec(line)?.[1])
      .filter((answer): answer is string => answer !== undefined);
    if (answers.length > 1) findings.push(`duplicate [Answer]: entries for ${id}`);
    if (answerIsFilled(answers[0] ?? "")) answeredQuestions.add(id);
    index = end - 1;
  }

  return { registered, answeredQuestions, findings };
}

// --- Claim blocks -----------------------------------------------------------

function claimBlocks(lines: string[]): {
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
  let pendingLine = 0;

  const flush = (): void => {
    const text = pending.join("\n").trimEnd();
    if (text.length > 0) {
      blocks.push({
        section,
        text,
        line: pendingLine,
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
    if (line.trim().length === 0 || isThematicBreak(line) || REFERENCE_DEF_RE.test(line)) {
      flush();
      continue;
    }
    if (isTableLine(line)) {
      flush();
      if (!tableHeaders.has(index) && !isTableSeparator(line)) {
        blocks.push({
          section,
          text: line.trim(),
          line: index + 1,
          inAssumptions: section === ASSUMPTIONS_HEADING,
        });
      }
      continue;
    }
    if (isListItem(line)) {
      flush();
      pendingLine = index + 1;
      pending.push(line);
      continue;
    }
    if (pending.length === 0) pendingLine = index + 1;
    pending.push(line);
  }
  flush();

  return { blocks, hasAssumptionsSection };
}

function checkClaimTags(
  block: ClaimBlock,
  labels: ReadonlySet<string>,
  universe: SourceUniverse,
  findings: string[],
): { inBodyAssumption: boolean } {
  const location = `line ${block.line}${block.section ? ` (## ${block.section})` : ""}`;
  const tags = sourceTags(block.text, labels);
  if (tags.length === 0) {
    findings.push(`${location}: claim carries no source tag`);
    return { inBodyAssumption: false };
  }
  if (block.inAssumptions && !tags.includes("assumption")) {
    findings.push(`${location}: assumption/open question lacks [assumption]`);
  }
  let inBodyAssumption = false;
  for (const tag of tags) {
    if (tag === "assumption") {
      if (block.inAssumptions) continue;
      // Permitted outside the assumptions section only as the prescribed
      // unresolved-required-field marker — which must then also appear in the
      // assumptions section, checked by the caller.
      if (UNRESOLVED_MARKER_RE.test(block.text)) {
        inBodyAssumption = true;
        continue;
      }
      findings.push(
        `${location}: [assumption] outside ## ${ASSUMPTIONS_HEADING} must be the ` +
          `"Unknown (open question) [assumption]" marker for an unresolved required field`,
      );
      continue;
    }
    if (tag.startsWith("Q")) {
      if (!universe.answeredQuestions.has(tag)) {
        findings.push(`${location}: [${tag}] has no filled answer in the questions file`);
      }
      continue;
    }
    if (!universe.registered.has(tag)) {
      findings.push(`${location}: [${tag}] is not registered in the questions file's ## Sources`);
    }
  }
  return { inBodyAssumption };
}

// --- Scoring tables ---------------------------------------------------------

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

// A number attached to a judgment with no stated reason is the exact failure
// this sensor exists for: six weighted criteria scored 0-10 is where invented
// numbers hide. Applies to pdlc-prioritization-scoring.md only.
function scoringTableFindings(lines: string[], labels: ReadonlySet<string>): string[] {
  const findings: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!(isTableLine(lines[index]) && index + 1 < lines.length && isTableSeparator(lines[index + 1]))) {
      index++;
      continue;
    }
    const headerLine = index;
    const header = cellsOf(lines[headerLine]);
    const rows: { line: number; cells: string[] }[] = [];
    let cursor = headerLine + 2;
    while (cursor < lines.length && isTableLine(lines[cursor])) {
      if (!isTableSeparator(lines[cursor])) rows.push({ line: cursor + 1, cells: cellsOf(lines[cursor]) });
      cursor++;
    }
    index = cursor;

    // Either shape counts: a declared score column (the prescribed
    // per-criterion table), or a row carrying three or more bare 0-10 scores (a
    // candidate-per-row matrix). A weights-reference table matches neither.
    const isScoringTable =
      header.some((cell) => SCORE_HEADER_RE.test(cell)) ||
      rows.some((row) => row.cells.filter((cell) => SCORE_CELL_RE.test(cell)).length >= 3);
    if (!isScoringTable) continue;

    const rationaleColumn = header.findIndex((cell) => RATIONALE_HEADER_RE.test(cell));
    if (rationaleColumn < 0) {
      findings.push(
        `line ${headerLine + 1}: scoring table has no rationale/reason/evidence column — ` +
          `every score must state why it is that score`,
      );
      continue;
    }
    for (const row of rows) {
      const rationale = row.cells[rationaleColumn] ?? "";
      if (!hasSourceTag(rationale, labels)) {
        findings.push(`line ${row.line}: scoring row rationale carries no source tag`);
      }
      // A citation is not a reason. Strip the source tags first: a rationale
      // cell holding only `[Q3]` cites where a number came from and still never
      // says why the number is that number. A link-reference-defined tag is
      // neither a grounding citation nor explanatory prose.
      const value = rationale.replace(SOURCE_TAG_RE, "").trim();
      if (value.length === 0 || EMPTY_RATIONALE_RE.test(value)) {
        findings.push(`line ${row.line}: scoring row has no rationale beyond its source tag`);
      }
    }
  }
  return findings;
}

// --- Entry point ------------------------------------------------------------

export function main(argv: string[]): void {
  const flags = parseFlags(argv);
  if (!flags.outputPath) fail("--output-path is required");

  const firedPath = resolve(flags.outputPath);
  const stageDir = dirname(firedPath);
  // The stage slug names the sibling questions file. Fall back to the stage
  // directory name, which the engine-resolved record layout guarantees.
  const stageSlug = flags.stage ?? basename(stageDir);
  const questionsPath = resolve(join(stageDir, `${stageSlug}-questions.md`));
  const stem = basename(firedPath, ".md");

  if (!TARGET_STEMS.has(stem)) {
    passThrough(questionsPath, `${stem}.md is not a pdlc-evidence target`);
  }
  if (!existsSync(firedPath)) {
    passThrough(questionsPath, "deliverable not on disk yet");
  }

  let body: string;
  try {
    body = readFileSync(firedPath, "utf-8");
  } catch (error) {
    fail(`failed to read ${firedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const artifactStems = recordArtifactStems(stageDir);
  const universe = parseQuestionsFile(questionsPath, artifactStems);
  const findings = [...universe.findings];

  const lines = visibleMarkdownLines(body);
  const labels = referenceLabels(lines);
  const { blocks, hasAssumptionsSection } = claimBlocks(lines);
  if (!hasAssumptionsSection) {
    findings.push(`missing required section: ## ${ASSUMPTIONS_HEADING}`);
  }
  let inBodyAssumptions = 0;
  for (const block of blocks) {
    if (isNoneBlock(block.text)) continue;
    if (checkClaimTags(block, labels, universe, findings).inBodyAssumption) inBodyAssumptions++;
  }
  // An unresolved field marked in place must also surface where a reader looks
  // for the run's open questions — otherwise the marker hides the gap instead of
  // declaring it.
  if (inBodyAssumptions > 0 && !blocks.some((b) => b.inAssumptions && !isNoneBlock(b.text))) {
    findings.push(
      `${inBodyAssumptions} unresolved field(s) are marked [assumption] in place, but ` +
        `## ${ASSUMPTIONS_HEADING} lists none of them`,
    );
  }
  if (stem === SCORING_STEM) findings.push(...scoringTableFindings(lines, labels));

  emit({
    pass: findings.length === 0,
    findings,
    scanned_files: [firedPath],
    questions_file: questionsPath,
    findings_count: findings.length,
  });
}

if (import.meta.main) main(process.argv.slice(2));
