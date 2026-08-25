// aidlc-review-brief.ts - deterministic review and summary decision context.
//
// Review artifacts remain receipt-frozen. Human finding dispositions therefore
// live on the tool-owned GATE_APPROVED / GATE_REJECTED audit rows and are folded
// into rendered briefs and future reviewer dispatch context at read time.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  auditBlockField,
  extractMarkdownSection,
  findStageBySlug,
  readAuditShardEvents,
  recordDir,
  resolveAuditProjectPath,
  resolveProjectDir,
  type ReviewArtifactEntry,
  reviewArtifactEntries,
  type ReviewFingerprintStage,
  toPosix,
} from "./aidlc-lib.js";

export const REVIEW_FINDING_DISPOSITIONS_FIELD =
  "Review Finding Dispositions";

export type ReviewFindingStatus =
  | "New"
  | "Unresolved"
  | "Resolved"
  | "Accepted risk"
  | `Rejected: ${string}`;

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
}

export interface ReviewArtifactContext {
  artifact: string;
  unit?: string;
  verdict: "READY" | "NOT-READY" | null;
  findings: ReviewFinding[];
}

export interface ReviewFindingDisposition {
  artifact: string;
  id: string;
  fingerprint: string;
  status: "Accepted risk" | `Rejected: ${string}`;
}

interface ReviewFindingDispositionEnvelope {
  version: 1;
  dispositions: ReviewFindingDisposition[];
}

export type ReviewBriefReason = "first" | "revision" | "stale";

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

function validFindingStatus(value: string): value is ReviewFindingStatus {
  return (
    value === "New" ||
    value === "Unresolved" ||
    value === "Resolved" ||
    value === "Accepted risk" ||
    /^Rejected: \S[\s\S]*$/.test(value)
  );
}

export function reviewFindingFingerprint(
  finding: Pick<
    ReviewFinding,
    "id" | "location" | "finding" | "requiredAction"
  >,
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

export function parseReviewArtifact(
  content: string,
  artifact: string,
  unit?: string,
): ReviewArtifactContext | null {
  const review = extractMarkdownSection(content, "## Review");
  if (!review) return null;

  const verdictMatch = review.match(
    /^\*\*Verdict:\*\*\s*(READY|NOT-READY)\s*$/m,
  );
  const lines = review.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex((line) => /^### Findings\s*$/.test(line));
  if (heading === -1) {
    return {
      artifact,
      ...(unit ? { unit } : {}),
      verdict: verdictMatch?.[1] as "READY" | "NOT-READY" | undefined ?? null,
      findings: [],
    };
  }
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i++) {
    if (/^### /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const table = lines
    .slice(heading + 1, end)
    .filter((line) => line.trim().startsWith("|"));
  if (table.length < 2) {
    return {
      artifact,
      ...(unit ? { unit } : {}),
      verdict: verdictMatch?.[1] as "READY" | "NOT-READY" | undefined ?? null,
      findings: [],
    };
  }
  const headers = splitMarkdownRow(table[0]);
  const required = [
    "ID",
    "Severity",
    "Location",
    "Finding",
    "Required action",
    "Status",
  ];
  for (const name of required) {
    if (!headers.includes(name)) {
      return {
        artifact,
        ...(unit ? { unit } : {}),
        verdict: verdictMatch?.[1] as "READY" | "NOT-READY" | undefined ?? null,
        findings: [],
      };
    }
  }
  const index = new Map(headers.map((name, position) => [name, position]));
  const findings: ReviewFinding[] = [];
  for (const line of table.slice(2)) {
    const cells = splitMarkdownRow(line);
    const value = (name: string): string =>
      cells[index.get(name) ?? -1]?.trim() ?? "";
    const id = value("ID");
    if (!/^R-[0-9]+$/.test(id)) {
      throw new Error(`${artifact}: invalid finding ID ${JSON.stringify(id)}`);
    }
    const status = value("Status");
    if (!validFindingStatus(status)) {
      throw new Error(
        `${artifact}#${id}: invalid finding status ${JSON.stringify(status)}`,
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
  return {
    artifact,
    ...(unit ? { unit } : {}),
    verdict: verdictMatch?.[1] as "READY" | "NOT-READY" | undefined ?? null,
    findings,
  };
}

function workspaceArtifactPath(
  projectDir: string,
  entry: ReviewArtifactEntry,
): string {
  return entry.path === null
    ? entry.logicalPath
    : toPosix(relative(projectDir, entry.path));
}

function entryUnit(logicalPath: string): string | undefined {
  return /^construction\/([^/]+)\//.exec(logicalPath)?.[1];
}

export function readReviewArtifactContexts(
  projectDir: string,
  stage: ReviewFingerprintStage,
  unit?: string,
): ReviewArtifactContext[] {
  const contexts: ReviewArtifactContext[] = [];
  const entries = reviewArtifactEntries(projectDir, stage, unit);
  if (entries === null) return contexts;
  for (const entry of entries) {
    if (entry.path === null || !existsSync(entry.path)) continue;
    const artifact = workspaceArtifactPath(projectDir, entry);
    const parsed = parseReviewArtifact(
      readFileSync(entry.path, "utf-8"),
      artifact,
      unit ?? entryUnit(entry.logicalPath),
    );
    if (parsed) contexts.push(parsed);
  }
  return contexts;
}

function dispositionKey(
  value: Pick<ReviewFindingDisposition, "artifact" | "id">,
): string {
  return `${value.artifact}\u0000${value.id}`;
}

export function serializeReviewFindingDispositions(
  dispositions: ReviewFindingDisposition[],
): string | undefined {
  if (dispositions.length === 0) return undefined;
  const envelope: ReviewFindingDispositionEnvelope = {
    version: 1,
    dispositions: [...dispositions].sort((a, b) =>
      dispositionKey(a).localeCompare(dispositionKey(b))
    ),
  };
  return JSON.stringify(envelope);
}

function parseDispositionField(
  value: string | null,
): ReviewFindingDisposition[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  const envelope = parsed as Partial<ReviewFindingDispositionEnvelope>;
  if (envelope.version !== 1 || !Array.isArray(envelope.dispositions)) {
    return [];
  }
  return envelope.dispositions.filter((entry): entry is ReviewFindingDisposition => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as Partial<ReviewFindingDisposition>;
    return (
      typeof row.artifact === "string" &&
      /^R-[0-9]+$/.test(row.id ?? "") &&
      /^sha256:[0-9a-f]{64}$/.test(row.fingerprint ?? "") &&
      (
        row.status === "Accepted risk" ||
        /^Rejected: \S[\s\S]*$/.test(row.status ?? "")
      )
    );
  });
}

export function readReviewFindingDispositions(
  projectDir: string,
  stageSlug: string,
): Map<string, ReviewFindingDisposition> {
  const events = readAuditShardEvents(projectDir)
    .filter((event) =>
      (event.event === "GATE_APPROVED" || event.event === "GATE_REJECTED") &&
      auditBlockField(event.block, "Stage") === stageSlug
    )
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shard === b.shard) return a.pos - b.pos;
      return a.shardIndex - b.shardIndex;
    });

  const result = new Map<string, ReviewFindingDisposition>();
  for (let start = 0; start < events.length;) {
    let end = start + 1;
    while (
      end < events.length &&
      events[end].timestamp === events[start].timestamp
    ) {
      end++;
    }
    const group = new Map<
      string,
      Array<{ shard: string; value: ReviewFindingDisposition }>
    >();
    for (const event of events.slice(start, end)) {
      for (
        const disposition of parseDispositionField(
          auditBlockField(event.block, REVIEW_FINDING_DISPOSITIONS_FIELD),
        )
      ) {
        const key = dispositionKey(disposition);
        const rows = group.get(key) ?? [];
        rows.push({ shard: event.shard, value: disposition });
        group.set(key, rows);
      }
    }
    for (const [key, rows] of group) {
      const serialized = new Set(rows.map((row) => JSON.stringify(row.value)));
      const shards = new Set(rows.map((row) => row.shard));
      if (shards.size > 1 && serialized.size > 1) {
        result.delete(key);
      } else {
        result.set(key, rows[rows.length - 1].value);
      }
    }
    start = end;
  }
  return result;
}

export function hydrateReviewArtifactContexts(
  contexts: ReviewArtifactContext[],
  dispositions: Map<string, ReviewFindingDisposition>,
): ReviewArtifactContext[] {
  return contexts.map((context) => ({
    ...context,
    findings: context.findings.map((finding) => {
      const disposition = dispositions.get(dispositionKey(finding));
      return disposition?.fingerprint === finding.fingerprint
        ? { ...finding, status: disposition.status }
        : finding;
    }),
  }));
}

export function acceptedRiskDispositionField(
  projectDir: string,
  stage: ReviewFingerprintStage,
): string | undefined {
  if (!stage.reviewer) return undefined;
  const hydrated = hydrateReviewArtifactContexts(
    readReviewArtifactContexts(projectDir, stage),
    readReviewFindingDispositions(projectDir, stage.slug),
  );
  const dispositions = hydrated.flatMap((context) =>
    context.findings
      .filter((finding) =>
        finding.status === "New" || finding.status === "Unresolved"
      )
      .map((finding): ReviewFindingDisposition => ({
        artifact: finding.artifact,
        id: finding.id,
        fingerprint: finding.fingerprint,
        status: "Accepted risk",
      }))
  );
  return serializeReviewFindingDispositions(dispositions);
}

function parseRejectedFindingSpec(
  spec: string,
): { artifact: string; id: string; reason: string } {
  const match = /^(.*)#(R-[0-9]+)=(\S[\s\S]*)$/.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid --reject-finding ${JSON.stringify(spec)}. Expected <review-artifact>#R-NN=<human reason>.`,
    );
  }
  return {
    artifact: toPosix(match[1].trim()),
    id: match[2],
    reason: match[3].trim(),
  };
}

export function rejectedFindingDispositionField(
  projectDir: string,
  stage: ReviewFingerprintStage,
  specs: string[],
): string | undefined {
  if (specs.length === 0) return undefined;
  if (!stage.reviewer) {
    throw new Error(
      `Cannot reject review findings for "${stage.slug}": the stage has no reviewer.`,
    );
  }
  const hydrated = hydrateReviewArtifactContexts(
    readReviewArtifactContexts(projectDir, stage),
    readReviewFindingDispositions(projectDir, stage.slug),
  );
  const findings = hydrated.flatMap((context) => context.findings);
  const dispositions: ReviewFindingDisposition[] = [];
  const seen = new Set<string>();
  for (const raw of specs) {
    const spec = parseRejectedFindingSpec(raw);
    const key = dispositionKey(spec);
    if (seen.has(key)) {
      throw new Error(
        `Duplicate --reject-finding selector ${spec.artifact}#${spec.id}.`,
      );
    }
    seen.add(key);
    const finding = findings.find((candidate) =>
      candidate.artifact === spec.artifact && candidate.id === spec.id
    );
    if (!finding) {
      throw new Error(
        `Cannot reject ${spec.artifact}#${spec.id}: it is not a current review finding for "${stage.slug}".`,
      );
    }
    if (finding.status !== "New" && finding.status !== "Unresolved") {
      throw new Error(
        `Cannot reject ${spec.artifact}#${spec.id}: current status is ${finding.status}.`,
      );
    }
    dispositions.push({
      artifact: finding.artifact,
      id: finding.id,
      fingerprint: finding.fingerprint,
      status: `Rejected: ${spec.reason}`,
    });
  }
  return serializeReviewFindingDispositions(dispositions);
}

function markdownCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export function renderFindingsContext(
  contexts: ReviewArtifactContext[],
): string {
  if (contexts.length === 0) return "_No review findings were recorded._";
  const lines: string[] = [];
  for (const context of contexts) {
    lines.push(`**Review artifact:** \`${context.artifact}\``);
    lines.push("");
    lines.push(
      "| ID | Severity | Location | Finding | Required action | Status |",
      "|---|---|---|---|---|---|",
    );
    for (const finding of context.findings) {
      lines.push(
        `| ${markdownCell(finding.id)} | ${markdownCell(finding.severity)} | ` +
          `${markdownCell(finding.location)} | ${markdownCell(finding.finding)} | ` +
          `${markdownCell(finding.requiredAction)} | ${markdownCell(finding.status)} |`,
      );
    }
    if (context.findings.length === 0) {
      lines.push("| - | - | - | No findings | No action required | Resolved |");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function parseAuditPathArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export interface ReviewInvalidationDetails {
  changedUpstream: string[];
  invalidatedArtifacts: string[];
  invalidatedReviews: string[];
}

export function reviewInvalidationDetails(
  projectDir: string,
  stage: ReviewFingerprintStage,
  contexts: ReviewArtifactContext[],
): ReviewInvalidationDetails {
  const events = readAuditShardEvents(projectDir).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shard === b.shard) return a.pos - b.pos;
    return a.shardIndex - b.shardIndex;
  });
  let latestReview = -1;
  let latestJump = -1;
  for (let i = 0; i < events.length; i++) {
    if (
      events[i].event === "REVIEW_COMPLETED" &&
      auditBlockField(events[i].block, "Stage") === stage.slug
    ) {
      latestReview = i;
    }
    if (
      events[i].event === "STAGE_JUMPED" &&
      auditBlockField(events[i].block, "Direction") === "BACKWARD" &&
      auditBlockField(events[i].block, "Changed Upstream Artifacts")
    ) {
      latestJump = i;
    }
  }
  if (latestJump > latestReview) {
    const jump = events[latestJump].block;
    return {
      changedUpstream: parseAuditPathArray(
        auditBlockField(jump, "Changed Upstream Artifacts"),
      ),
      invalidatedArtifacts: parseAuditPathArray(
        auditBlockField(jump, "Invalidated Downstream Artifacts"),
      ),
      invalidatedReviews: parseAuditPathArray(
        auditBlockField(jump, "Invalidated Downstream Reviews"),
      ),
    };
  }

  const currentArtifacts = new Set(
    (reviewArtifactEntries(projectDir, stage) ?? []).map((entry) =>
      workspaceArtifactPath(projectDir, entry)
    ),
  );
  const changed = new Set<string>();
  for (const event of events.slice(latestReview + 1)) {
    if (event.event !== "ARTIFACT_CREATED" && event.event !== "ARTIFACT_UPDATED") {
      continue;
    }
    const file = auditBlockField(event.block, "File");
    if (!file) continue;
    const normalized = toPosix(
      relative(projectDir, resolveAuditProjectPath(projectDir, file)),
    );
    if (currentArtifacts.has(normalized)) changed.add(normalized);
  }
  return {
    changedUpstream: [...changed],
    invalidatedArtifacts: [],
    invalidatedReviews: changed.size > 0
      ? contexts.map((context) => `${context.artifact}#Review`)
      : [],
  };
}

export function renderReviewBrief(
  projectDir: string,
  stage: ReviewFingerprintStage & { name: string },
  reason: ReviewBriefReason,
  unit?: string,
  fallbackFinding?: string,
): string {
  let contexts = hydrateReviewArtifactContexts(
    readReviewArtifactContexts(projectDir, stage, unit),
    readReviewFindingDispositions(projectDir, stage.slug),
  );
  if (contexts.length === 0 && fallbackFinding) {
    const entry = reviewArtifactEntries(projectDir, stage, unit)?.[0];
    const artifact = entry
      ? workspaceArtifactPath(projectDir, entry)
      : `${stage.phase}/${stage.slug}`;
    const finding: ReviewFinding = {
      artifact,
      ...(unit ? { unit } : {}),
      id: "R-01",
      severity: "Major",
      location: `${artifact} > review completion`,
      finding: fallbackFinding,
      requiredAction: "Request changes and rerun the reviewer.",
      status: "Unresolved",
      fingerprint: "",
    };
    finding.fingerprint = reviewFindingFingerprint(finding);
    contexts = [{
      artifact,
      ...(unit ? { unit } : {}),
      verdict: "NOT-READY",
      findings: [finding],
    }];
  }
  const findings = contexts.flatMap((context) => context.findings);
  const open = findings.filter((finding) =>
    finding.status === "New" || finding.status === "Unresolved"
  );
  const outcome =
    open.length > 0
      ? "Concerns remain for your decision."
      : findings.length > 0
        ? "No open findings remain."
        : contexts.some((context) => context.verdict === "NOT-READY")
          ? "The review did not complete with actionable findings."
          : "No blocking concerns were found.";
  const why = {
    first: "First review completed.",
    revision: "Revision re-checked.",
    stale: "Re-check required after upstream work changed.",
  }[reason];

  const lines = [
    `**Stage:** ${stage.name}`,
    `**Review outcome:** ${outcome}`,
    `**Why now:** ${why}`,
  ];
  if (reason === "stale") {
    const invalidation = reviewInvalidationDetails(
      projectDir,
      stage,
      contexts,
    );
    if (invalidation.changedUpstream.length > 0) {
      lines.push(
        `**Changed upstream:** ${invalidation.changedUpstream.map((path) => `\`${path}\``).join(", ")}`,
      );
    }
    if (invalidation.invalidatedArtifacts.length > 0) {
      lines.push(
        `**Downstream artifacts requiring re-check:** ${
          invalidation.invalidatedArtifacts.map((path) => `\`${path}\``).join(", ")
        }`,
      );
    }
    if (invalidation.invalidatedReviews.length > 0) {
      lines.push(
        `**Downstream reviews requiring re-check:** ${
          invalidation.invalidatedReviews.map((path) => `\`${path}\``).join(", ")
        }`,
      );
    }
  }
  lines.push(
    "",
    renderFindingsContext(contexts),
    "",
    "**Decision options:**",
    "- **Approve** - continue with the open findings accepted.",
    "- **Request Changes** - return to the listed artifacts so the required actions can be addressed.",
  );
  return lines.join("\n");
}

export function renderSummaryConfirmationBrief(
  projectDir: string,
  stage: ReviewFingerprintStage & { name: string },
  questionsFile: string,
  unit?: string,
): string {
  const absoluteQuestions = resolve(projectDir, questionsFile);
  const record = recordDir(projectDir);
  if (
    record === null ||
    (
      absoluteQuestions !== record &&
      !absoluteQuestions.startsWith(`${record}${sep}`)
    ) ||
    !existsSync(absoluteQuestions)
  ) {
    throw new Error(
      `Summary confirmation questions file must exist inside the active intent record: ${questionsFile}`,
    );
  }
  const entries = reviewArtifactEntries(projectDir, stage, unit) ?? [];
  const artifacts = entries.map((entry) =>
    `\`${workspaceArtifactPath(projectDir, entry)}\``
  );
  const generated = artifacts.length > 0
    ? artifacts.join(", ")
    : "the stage artifacts";
  const questions = toPosix(relative(projectDir, absoluteQuestions));
  return [
    `**Stage:** ${stage.name}`,
    `**Confirming:** Consolidated answers in \`${questions}\` before generating ${generated}.`,
    "**Why now:** All stage questions are answered; artifact generation will use this confirmed summary.",
    "**Decision options:**",
    "- **Looks correct** - record this confirmation and generate the named artifacts.",
    `- **Request changes** - leave the artifacts ungenerated and return to \`${questions}\`.`,
  ].join("\n");
}

function parseCliFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith("--") || i + 1 >= args.length) {
      throw new Error(`Expected --flag value, got ${JSON.stringify(flag)}.`);
    }
    flags[flag.slice(2)] = args[++i];
  }
  return flags;
}

export function main(argv: string[]): void {
  const command = argv[0];
  const flags = parseCliFlags(argv.slice(1));
  const projectDir = resolveProjectDir(flags["project-dir"]);
  const stageSlug = flags.stage;
  if (!stageSlug) throw new Error("Missing --stage <slug>.");
  const stage = findStageBySlug(stageSlug);
  if (!stage) throw new Error(`Unknown stage: ${stageSlug}`);

  if (command === "review") {
    const reason = flags.why as ReviewBriefReason | undefined;
    if (reason !== "first" && reason !== "revision" && reason !== "stale") {
      throw new Error("Review brief requires --why <first|revision|stale>.");
    }
    process.stdout.write(
      `${
        renderReviewBrief(
          projectDir,
          stage,
          reason,
          flags.unit,
          flags["fallback-finding"],
        )
      }\n`,
    );
    return;
  }
  if (command === "context") {
    const contexts = hydrateReviewArtifactContexts(
      readReviewArtifactContexts(projectDir, stage, flags.unit),
      readReviewFindingDispositions(projectDir, stage.slug),
    );
    process.stdout.write(`${renderFindingsContext(contexts)}\n`);
    return;
  }
  if (command === "summary") {
    if (!flags["questions-file"]) {
      throw new Error("Summary brief requires --questions-file <path>.");
    }
    process.stdout.write(
      `${
        renderSummaryConfirmationBrief(
          projectDir,
          stage,
          flags["questions-file"],
          flags.unit,
        )
      }\n`,
    );
    return;
  }
  throw new Error(
    `Unknown subcommand: ${command}. Valid: review, context, summary.`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`aidlc-review-brief: ${String(error)}\n`);
    process.exit(1);
  }
}
