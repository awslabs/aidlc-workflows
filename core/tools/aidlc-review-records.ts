// Review records and their findings: the finding types, statuses and
// fingerprints, the reviewer's findings report and its parser, the review
// section readers, and the paths of review records and drafts. With them ride
// the helpers they use: toPosix, the unit-name check (validateUnitName,
// UNIT_NAME_REGEX, UNIT_NAME_MAX_LENGTH), REVIEW_REQUEST_ID_RE and
// ReviewVerdict. aidlc-lib.ts re-exports the names it exported before, so its
// callers are unchanged, and it loads this module at start: nothing here may
// import aidlc-lib.ts.
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { engineDirFor, errorMessage } from "./aidlc-locks.ts";
import { visibleMarkdownLines } from "./aidlc-markdown.ts";
const LEGACY_REVIEW_RECORDS_DIR = ".aidlc-reviews";

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export type ReviewVerdict = "READY" | "NOT-READY";
export const REVIEW_REQUEST_ID_RE = /^review:[0-9a-f]{32}$/;

// --- Review records --------------------------------------------------------
//
// The review result lives in a framework-owned record under the intent record,
// never inside the artifact it certifies. Only `aidlc-log.ts review --verdict`
// writes one, in the same locked transaction that appends REVIEW_COMPLETED;
// that row names the record and pins its bytes, so a record edited afterwards
// stops being the review. Every field the reviewer protocol used to demand in
// an appendix (verdict, reviewer, iteration, findings) is here, plus what binds
// it: the request id, the artifact fingerprint the reviewer was dispatched on,
// and the source fingerprints for workspace-writing stages.

export const REVIEW_RECORDS_DIR = toPosix(join(engineDirFor(""), "reviews"));
const REVIEW_RECORD_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const REVIEW_FINDING_FIXED_STATUS_VALUES = [
  "New",
  "Unresolved",
  "Resolved",
  "Accepted risk",
] as const;
const REVIEW_FINDING_REJECTED_PREFIX = "Rejected: ";

export type ReviewFindingStatus =
  | (typeof REVIEW_FINDING_FIXED_STATUS_VALUES)[number]
  | `${typeof REVIEW_FINDING_REJECTED_PREFIX}${string}`;

export interface ReviewFinding {
  artifact: string;
  unit?: string;
  id: string;
  severity: string;
  location: string;
  finding: string;
  requiredAction: string;
  status: ReviewFindingStatus;
  fingerprint: string;
  decidedAtSeverity?: string;
  reviewerNote?: string;
  notRechecked?: boolean;
  resolvedByReviewer?: boolean;
  resolvedInReview?: boolean;
  earlierDecision?: "Accepted risk" | `Rejected: ${string}`;
  reopenedReason?: string;
  relatedFindingId?: string;
  introducedInReview?: boolean;
  reviewRecord?: { path: string; digest: string };
}

/** One finding as stored in a review record (artifact and unit live on the record). */
export interface ReviewRecordFinding {
  id: string;
  severity: string;
  location: string;
  finding: string;
  required_action: string;
  status: ReviewFindingStatus;
}

export interface ReviewRecordDerivedFinding extends ReviewRecordFinding {
  decided_at_severity?: string;
  reviewer_note?: string;
  not_rechecked?: boolean;
  resolved_by_reviewer?: boolean;
  resolved_in_review?: boolean;
  earlier_decision?: "Accepted risk" | `Rejected: ${string}`;
  reopened_reason?: string;
  related_finding_id?: string;
  introduced_in_review?: boolean;
}

export interface ReviewRecord {
  version: 1;
  stage: string;
  unit: string | null;
  workflow: string | null;
  attempt: string;
  iteration: number;
  reviewer: string;
  verdict: ReviewVerdict;
  request_id: string | null;
  request_challenge: string | null;
  artifact_fingerprint: string;
  source_fingerprint: string | null;
  unit_source_fingerprint: string | null;
  findings: ReviewRecordFinding[];
  derived_findings?: ReviewRecordDerivedFinding[];
  body: string;
  recorded_at: string;
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const body = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      cell += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

/** Human-readable form of the same values used by the type and predicate. */
export const REVIEW_FINDING_STATUS_VALUES =
  `${REVIEW_FINDING_FIXED_STATUS_VALUES.join(", ")}, or ` +
  `"${REVIEW_FINDING_REJECTED_PREFIX}<reason>"`;

export function validReviewFindingStatus(value: string): value is ReviewFindingStatus {
  const rejectedReason = value.startsWith(REVIEW_FINDING_REJECTED_PREFIX)
    ? value.slice(REVIEW_FINDING_REJECTED_PREFIX.length)
    : null;
  return (
    REVIEW_FINDING_FIXED_STATUS_VALUES.some((status) => status === value) ||
    (rejectedReason !== null && /^\S[\s\S]*$/.test(rejectedReason))
  );
}

export function reviewFindingFingerprint(
  finding: Pick<ReviewFinding, "id" | "location" | "finding" | "requiredAction">,
): string {
  return `sha256:${
    createHash("sha256")
      .update(
        JSON.stringify([
          finding.id,
          finding.location,
          finding.finding,
          finding.requiredAction,
        ]),
      )
      .digest("hex")
  }`;
}

/** The canonical verdict line of one review section, or null when it has none. */
export function reviewSectionVerdict(review: string): ReviewVerdict | null {
  const verdictMatch = review.match(/^\*\*Verdict:\*\*\s*(READY|NOT-READY)\s*$/m);
  return (verdictMatch?.[1] as ReviewVerdict | undefined) ?? null;
}

/** The lines under a review's `### Findings` heading, up to the next H3; null without one. */
export function reviewFindingsSectionLines(review: string): string[] | null {
  const lines = review.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex((line) => /^### Findings\s*$/.test(line));
  if (heading === -1) return null;
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i++) {
    if (/^### /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(heading + 1, end);
}

export interface ReviewerPriorFindingReport {
  id: string;
  now: "fixed" | "still-applies";
  severity: string;
  note: string;
}

export interface ReviewerNewFindingReport {
  suppliedId?: string;
  severity: string;
  location: string;
  finding: string;
  requiredAction: string;
}

export interface ReviewerFindingsReport {
  prior: ReviewerPriorFindingReport[];
  newFindings: ReviewerNewFindingReport[];
  /** The report left out its Prior findings table. A first review has no
   *  prior findings, so there it reads as empty; a later review is refused. */
  priorMissing?: true;
}

export const REVIEW_FINDINGS_REPORT_RETRY_MESSAGE =
  "the findings report could not be read. Write the whole review again with the required Prior findings and New findings tables";

// The same sentence with the fault named (the rule, the row and the cell), so
// the reviewer fixes that cell on the retry instead of repeating the mistake
// and spending the one retry on it. The opening is the generic message's.
export function findingsReportUnreadableMessage(fault: string): string {
  return `the findings report could not be read: ${fault}. Write the whole review again with the required Prior findings and New findings tables`;
}

function findingsReportUnreadable(fault: string): Error {
  return new Error(findingsReportUnreadableMessage(fault));
}

function markdownRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function reportTable(
  lines: string[],
  heading: string,
  requiredHeaders: string[],
  optionalHeaders: string[] = [],
): { headers: string[]; rows: string[][] } {
  const headingIndex = lines.findIndex((line) =>
    line.trim().toLowerCase() === `**${heading.toLowerCase()}**`
  );
  if (headingIndex === -1) {
    throw findingsReportUnreadable(`the ${heading} heading (**${heading}**) is missing`);
  }
  let tableStart = headingIndex + 1;
  while (tableStart < lines.length && lines[tableStart].trim() === "") tableStart++;
  if (
    tableStart + 1 >= lines.length ||
    !lines[tableStart].trim().startsWith("|") ||
    !lines[tableStart + 1].trim().startsWith("|")
  ) {
    throw findingsReportUnreadable(
      `no table follows the ${heading} heading; write its header row ${markdownRow(requiredHeaders)} ` +
        `and the separator row ${markdownRow(requiredHeaders.map(() => "---"))}`,
    );
  }
  const headers = splitMarkdownRow(lines[tableStart]);
  const allowed = new Set([...requiredHeaders, ...optionalHeaders]);
  if (
    requiredHeaders.some((header) => !headers.includes(header)) ||
    headers.some((header) => !allowed.has(header))
  ) {
    throw findingsReportUnreadable(
      `the ${heading} table header is ${markdownRow(headers)}; it must be ${markdownRow(requiredHeaders)}` +
        (optionalHeaders.length > 0 ? ` (an extra ${optionalHeaders.join(" or ")} column is allowed)` : ""),
    );
  }
  const separator = splitMarkdownRow(lines[tableStart + 1]);
  if (
    separator.length !== headers.length ||
    separator.some((cell) => !/^:?-{3,}:?$/.test(cell))
  ) {
    throw findingsReportUnreadable(
      `the ${heading} table separator row must have one |---| cell per column (${headers.length})`,
    );
  }
  const rows: string[][] = [];
  for (let i = tableStart + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) break;
    const cells = splitMarkdownRow(lines[i]);
    // A row with nothing in any cell says nothing: the table reads as if the
    // row were not there.
    if (cells.every((cell) => cell.trim() === "")) continue;
    if (cells.length > headers.length) {
      throw findingsReportUnreadable(
        `${heading} row ${rows.length + 1} has ${cells.length} cells for ${headers.length} columns; ` +
          "escape | inside a cell as \\| (also inside a code span)",
      );
    }
    rows.push([
      ...cells,
      ...Array.from({ length: headers.length - cells.length }, () => ""),
    ]);
  }
  return { headers, rows };
}

/**
 * Parse the engine-owned findings report. Null means the review uses the
 * transition six-column format instead.
 */
export function parseReviewerFindingsReport(
  review: string,
): ReviewerFindingsReport | null {
  const section = reviewFindingsSectionLines(review);
  if (section === null) return null;
  const visible = visibleMarkdownLines(section.join("\n"));
  const hasPrior = visible.some((line) =>
    line.trim().toLowerCase() === "**prior findings**"
  );
  const hasNew = visible.some((line) =>
    line.trim().toLowerCase() === "**new findings**"
  );
  if (!hasPrior && !hasNew) return null;
  if (!hasNew) {
    throw findingsReportUnreadable("the New findings heading (**New findings**) is missing");
  }
  const priorTable = hasPrior
    ? reportTable(
      visible,
      "Prior findings",
      ["ID", "Now", "Severity", "Note"],
    )
    : { headers: ["ID", "Now", "Severity", "Note"], rows: [] };
  const newTable = reportTable(
    visible,
    "New findings",
    ["Severity", "Location", "Finding", "Required action"],
    ["ID"],
  );
  const priorIndex = new Map(
    priorTable.headers.map((header, index) => [header, index]),
  );
  const newIndex = new Map(
    newTable.headers.map((header, index) => [header, index]),
  );
  const prior = priorTable.rows.map((cells, index): ReviewerPriorFindingReport => {
    const value = (header: string): string =>
      cells[priorIndex.get(header) ?? -1]?.trim() ?? "";
    const now = value("Now").toLowerCase();
    if (
      now !== "fixed" &&
      now !== "resolved" &&
      now !== "still applies" &&
      now !== "open" &&
      now !== "unresolved"
    ) {
      throw findingsReportUnreadable(
        `Prior findings row ${index + 1} has Now "${value("Now")}"; write Fixed or Still applies`,
      );
    }
    const id = value("ID");
    if (!/^R-[0-9]+$/.test(id)) {
      throw findingsReportUnreadable(
        `Prior findings row ${index + 1} has ID "${id}"; use the engine's R-<n> id from the review context`,
      );
    }
    return {
      id,
      now: now === "fixed" || now === "resolved"
        ? "fixed"
        : "still-applies",
      severity: value("Severity"),
      note: value("Note"),
    };
  });
  const newFindings = newTable.rows.map(
    (cells, index): ReviewerNewFindingReport => {
      const value = (header: string): string =>
        cells[newIndex.get(header) ?? -1]?.trim() ?? "";
      // A placeholder row (blank or dash cells, or "No findings") is refused:
      // an empty table is how a review says there is nothing new.
      if (
        ["Severity", "Location", "Finding", "Required action"].some((header) =>
          /^(?:-*|n\/?a|none)$/i.test(value(header))
        ) ||
        value("Finding").toLowerCase() === "no findings"
      ) {
        throw findingsReportUnreadable(
          `New findings row ${index + 1} is a placeholder; leave the table empty when there is nothing new`,
        );
      }
      return {
        ...(newIndex.has("ID") && value("ID").length > 0
          ? { suppliedId: value("ID") }
          : {}),
        severity: value("Severity"),
        location: value("Location"),
        finding: value("Finding"),
        requiredAction: value("Required action"),
      };
    },
  );
  return { prior, newFindings, ...(hasPrior ? {} : { priorMissing: true as const }) };
}

/**
 * Parse one review section (a record body, or the text under a legacy `## Review`
 * heading): the canonical verdict line and the `### Findings` table. Throws on a
 * malformed finding row so a bad review is refused rather than half-rendered.
 */
export function parseReviewSection(
  review: string,
  artifact: string,
  unit?: string,
): {
  verdict: ReviewVerdict | null;
  findings: ReviewFinding[];
  // Whether a findings TABLE was present at all. A reviewer that wrote prose
  // under the heading is a different case from one that wrote the canonical
  // table and no rows, and the caller refuses only the second.
  tablePresent: boolean;
} {
  const verdict = reviewSectionVerdict(review);
  const section = reviewFindingsSectionLines(review);
  if (section === null) return { verdict, findings: [], tablePresent: false };
  const table = section.filter((line) => line.trim().startsWith("|"));
  if (table.length < 2) return { verdict, findings: [], tablePresent: false };
  const headers = splitMarkdownRow(table[0]);
  // Every cell the record schema needs is addressed by column name, so a
  // renamed or dropped column is refused rather than read as "no findings":
  // returning an empty list here records the reviewer's verdict while dropping
  // the rows it rests on. Name both headers so the review can be rewritten.
  const expected = ["ID", "Severity", "Location", "Finding", "Required action", "Status"];
  const missing = expected.filter((name) => !headers.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `${artifact}: findings table header declares ${headers.join(" | ")}. ` +
        `Expected columns: ${expected.join(" | ")}. Missing: ${missing.join(", ")}`,
    );
  }
  const index = new Map(headers.map((name, position) => [name, position]));
  const findings: ReviewFinding[] = [];
  for (const line of table.slice(2)) {
    const cells = splitMarkdownRow(line);
    // Check arity before positional reads: a missing cell can shift later
    // values left, but its intended column cannot be recovered reliably.
    // Show the expected order and offer a hint when a trailing status fits.
    if (cells.length !== headers.length) {
      const rowId = cells[index.get("ID") ?? 0]?.trim() || "?";
      if (cells.length < headers.length) {
        const lastCell = cells.at(-1) ?? "";
        const hint = headers.at(-1) === "Status" && validReviewFindingStatus(lastCell)
          ? `The last cell ${JSON.stringify(lastCell)} looks like Status; check earlier cells for a missing value or "|" separator`
          : 'Check for a missing cell or "|" separator';
        throw new Error(
          `${artifact}#${rowId}: row has ${cells.length} cells, header declares ${headers.length}. ` +
            `Expected columns: ${headers.join(" | ")}. ${hint}`,
        );
      }
      throw new Error(
        `${artifact}#${rowId}: row has ${cells.length} cells, header declares ${headers.length}: ${
          cells.length - headers.length
        } unexpected extra cell(s)`,
      );
    }
    const value = (name: string): string =>
      cells[index.get(name) ?? -1]?.trim() ?? "";
    const id = value("ID");
    if (!/^R-[0-9]+$/.test(id)) {
      throw new Error(`${artifact}: invalid finding ID ${JSON.stringify(id)}`);
    }
    const status = value("Status");
    if (!validReviewFindingStatus(status)) {
      // Name the accepted set: "Fixed" is the word a reviewer reaches for once a
      // human has fixed something, so the rejected value alone leaves them
      // guessing at an enum that is right here.
      throw new Error(
        `${artifact}#${id}: invalid finding status ${JSON.stringify(status)}. ` +
          `Valid statuses: ${REVIEW_FINDING_STATUS_VALUES}.`,
      );
    }
    const finding: ReviewFinding = {
      artifact,
      ...(unit ? { unit } : {}),
      id,
      severity: value("Severity"),
      location: value("Location"),
      finding: value("Finding"),
      requiredAction: value("Required action"),
      status,
      fingerprint: "",
    };
    finding.fingerprint = reviewFindingFingerprint(finding);
    findings.push(finding);
  }
  return { verdict, findings, tablePresent: true };
}

const UNREADABLE_FINDINGS_TABLE_ID = "R-00";
const UNREADABLE_FINDINGS_TABLE_LOCATION = "review findings table";

/**
 * The one finding that stands in for a findings table that could not be read.
 * The reviewer's rows are not guessed at: this names why the table is
 * unreadable, and the gate shows the reviewer's findings section as written
 * beside it. `R-00` is outside the reviewer's own `R-01`.. numbering, so it
 * never collides with the rows it stands in for, here or carried forward.
 */
export function unreadableFindingsTableFinding(
  artifact: string,
  reason: string,
  unit?: string,
): ReviewFinding {
  const finding: ReviewFinding = {
    artifact,
    ...(unit ? { unit } : {}),
    id: UNREADABLE_FINDINGS_TABLE_ID,
    severity: "Major",
    location: `${artifact} > ${UNREADABLE_FINDINGS_TABLE_LOCATION}`,
    // The parser joins column names with " | "; commas keep this one cell if
    // a reviewer carries the finding forward without the table escaping.
    finding: `The reviewer's findings table could not be read, so its rows are not listed here: ${
      reason.replace(/\s*\|\s*/g, ", ")
    }`,
    requiredAction: "Address the reviewer's findings as written below this table.",
    status: "Unresolved",
    fingerprint: "",
  };
  finding.fingerprint = reviewFindingFingerprint(finding);
  return finding;
}

export function isUnreadableFindingsTableFinding(
  finding: Pick<ReviewFinding, "id" | "location">,
): boolean {
  return (
    finding.id === UNREADABLE_FINDINGS_TABLE_ID &&
    finding.location.endsWith(` > ${UNREADABLE_FINDINGS_TABLE_LOCATION}`)
  );
}

/**
 * Read a review's findings table the way a record admits it: its rows, or why
 * it cannot be read (a header missing a column the record addresses, a
 * malformed row, or a canonical table with no rows under NOT-READY, where the
 * gate would render "No findings" over a rejection). Prose under the heading,
 * or no heading at all, is not unreadable here: the reviewer protocol already
 * classifies that shape as an incomplete review, and refusing it would reject
 * bodies that predate the table contract.
 */
export function readFindingsTable(
  review: string,
  artifact: string,
  verdict: ReviewVerdict | null,
  unit?: string,
): {
  findings: ReviewFinding[];
  unreadable: string | null;
  report?: ReviewerFindingsReport;
} {
  try {
    const report = parseReviewerFindingsReport(review);
    if (report !== null) {
      if (
        verdict === "NOT-READY" &&
        report.prior.length === 0 &&
        report.newFindings.length === 0
      ) {
        return {
          findings: [],
          unreadable:
            "a NOT-READY review with a findings report must record at least one finding in it",
        };
      }
      const findings = report.newFindings.map((row, index) => {
        const finding: ReviewFinding = {
          artifact,
          ...(unit ? { unit } : {}),
          id: `R-${String(index + 1).padStart(2, "0")}`,
          severity: row.severity,
          location: row.location,
          finding: row.finding,
          requiredAction: row.requiredAction,
          status: "New",
          fingerprint: "",
        };
        finding.fingerprint = reviewFindingFingerprint(finding);
        return finding;
      });
      return { findings, unreadable: null, report };
    }
    const parsed = parseReviewSection(review, artifact, unit);
    if (verdict === "NOT-READY" && parsed.tablePresent && parsed.findings.length === 0) {
      return {
        findings: [],
        unreadable:
          "a NOT-READY review with a findings table must record at least one finding in it",
      };
    }
    return { findings: parsed.findings, unreadable: null };
  } catch (parseError) {
    return { findings: [], unreadable: errorMessage(parseError) };
  }
}

/** A stable, path-safe name for a review attempt, derived from its floor identity. */
export function reviewAttemptId(floor: string): string {
  return createHash("sha256").update(floor.length === 0 ? "unstarted" : floor).digest("hex").slice(0, 16);
}
export function reviewRecordRelativePath(
  stage: string,
  unit: string | undefined,
  attemptId: string,
  iteration: number,
): string {
  if (!REVIEW_RECORD_SEGMENT_RE.test(stage)) throw new Error(`Invalid stage slug "${stage}".`);
  const unitProblem = unit === undefined ? null : validateUnitName(unit);
  if (unitProblem !== null) throw new Error(unitProblem);
  return unit === undefined
    ? `${REVIEW_RECORDS_DIR}/${stage}/stage/${attemptId}/${iteration}.json`
    : `${REVIEW_RECORDS_DIR}/${stage}/units/${unit}/${attemptId}/${iteration}.json`;
}

/**
 * Where the reviewer writes its review for one request: the scratch slot the
 * request opens (deleting any earlier draft) and the verdict consumes. The
 * record beside it is the review; the draft is the reviewer's input to it.
 * A request with an id has a slot of its own, so a reviewer of a replaced
 * request that writes late never fills the replacement's slot; a request
 * recorded before request ids keeps the pass's shared slot.
 */
export function reviewDraftRelativePath(
  stage: string,
  unit: string | undefined,
  attemptId: string,
  iteration: number,
  requestId: string | null = null,
): string {
  if (!REVIEW_RECORD_SEGMENT_RE.test(stage)) throw new Error(`Invalid stage slug "${stage}".`);
  const unitProblem = unit === undefined ? null : validateUnitName(unit);
  if (unitProblem !== null) throw new Error(unitProblem);
  if (requestId !== null && !REVIEW_REQUEST_ID_RE.test(requestId)) {
    throw new Error(`Invalid review request id "${requestId}".`);
  }
  const name = requestId === null
    ? `${iteration}.review.md`
    : `${iteration}.${requestId.slice("review:".length)}.review.md`;
  return unit === undefined
    ? `${REVIEW_RECORDS_DIR}/${stage}/stage/${attemptId}/${name}`
    : `${REVIEW_RECORDS_DIR}/${stage}/units/${unit}/${attemptId}/${name}`;
}

/** Whether `path` has exactly one supported stage or Unit record shape. */
export function isReviewRecordRelativePath(path: string): boolean {
  // Audit rows keep their original path and digest across an upgrade.
  const prefix = [REVIEW_RECORDS_DIR, LEGACY_REVIEW_RECORDS_DIR]
    .find((dir) => path.startsWith(`${dir}/`));
  if (prefix === undefined) return false;
  const parts = [prefix, ...path.slice(prefix.length + 1).split("/")];
  if (!REVIEW_RECORD_SEGMENT_RE.test(parts[1] ?? "")) return false;
  if (parts[2] === "stage") {
    return parts.length === 5 &&
      /^[0-9a-f]{16}$/.test(parts[3]) &&
      /^[1-9][0-9]*\.json$/.test(parts[4]);
  }
  return parts.length === 6 &&
    parts[2] === "units" &&
    REVIEW_RECORD_SEGMENT_RE.test(parts[3]) &&
    /^[0-9a-f]{16}$/.test(parts[4]) &&
    /^[1-9][0-9]*\.json$/.test(parts[5]);
}
// New workflows author lowercase kebab-case names, but pre-lifecycle DAGs
// accepted other filesystem-safe names. Keep those existing identifiers
// routable while still excluding separators, traversal, whitespace, and
// control characters.
export const UNIT_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const UNIT_NAME_MAX_LENGTH = 64;

// Unit names become path components under construction/<unit>/ and are also
// mirrored into single-line state fields. Keep one canonical validator for the
// authored DAG, cached runtime graph, and lifecycle CLI. Lowercase kebab-case is
// the authoring convention; leading digits, uppercase letters, underscores,
// and dots remain accepted for safe legacy DAG names.
export function validateUnitName(name: string): string | null {
  if (!name) return "Unit name is empty";
  if (name.length > UNIT_NAME_MAX_LENGTH) {
    return `Unit name "${name.slice(0, 32)}..." is ${name.length} chars; max is ${UNIT_NAME_MAX_LENGTH}`;
  }
  if (!UNIT_NAME_REGEX.test(name)) {
    return (
      `Invalid Unit name "${name}" - must match ${UNIT_NAME_REGEX} ` +
      "(ASCII letter/digit, then ASCII letters/digits/dot/underscore/hyphen)"
    );
  }
  return null;
}
