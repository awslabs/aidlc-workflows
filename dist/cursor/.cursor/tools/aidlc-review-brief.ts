// aidlc-review-brief.ts - deterministic review and summary decision context.
//
// Review artifacts remain receipt-frozen. Human finding dispositions therefore
// live on the tool-owned GATE_APPROVED / GATE_REJECTED audit rows and are folded
// into rendered briefs and future reviewer dispatch context at read time.

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  type AuditShardEvent,
  attemptEventAfterFrontier,
  attemptEventDefinitelyBefore,
  auditBlockField,
  extractMarkdownSection,
  findStageBySlug,
  latestReviewRecordRefs,
  parseReviewSection,
  readAuditShardEvents,
  readReviewRecord,
  readUnitSourceSnapshot,
  reviewRecordMatchesCompletion,
  recordDir,
  resolveAuditProjectPath,
  resolveProjectDir,
  type ReviewArtifactEntry,
  reviewArtifactEntries,
  type ReviewFinding,
  reviewFindingFingerprint,
  type ReviewFindingStatus,
  reviewInvalidationAttemptView,
  type ReviewFingerprintStage,
  reviewRecordFindings,
  maximalAttemptEvents,
  toPosix,
} from "./aidlc-lib.js";

export { reviewFindingFingerprint, type ReviewFinding, type ReviewFindingStatus };

export const REVIEW_FINDING_DISPOSITIONS_FIELD =
  "Review Finding Dispositions";

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

/**
 * Parse a legacy embedded review: the `## Review` section a reviewer wrote into
 * the artifact under the retired appendix protocol. Read for migration only;
 * new reviews live in review records.
 */
export function parseReviewArtifact(
  content: string,
  artifact: string,
  unit?: string,
): ReviewArtifactContext | null {
  const review = extractMarkdownSection(content, "## Review");
  if (!review) return null;
  const parsed = parseReviewSection(review, artifact, unit);
  return {
    artifact,
    ...(unit ? { unit } : {}),
    verdict: parsed.verdict,
    findings: parsed.findings,
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

function entryUnit(logicalPath: string, stageSlug: string): string | undefined {
  const match = /^construction\/([^/]+)\/([^/]+)\//.exec(logicalPath);
  return match?.[2] === stageSlug ? match[1] : undefined;
}

/**
 * The current review per scope. A scope whose newest completion names a
 * review record renders that record (keyed to `review_artifact`, the artifact
 * the review is about); a scope without one falls back to the legacy embedded
 * `## Review` sections in its artifacts, so an intent reviewed before review
 * records keeps working until its next review.
 */
export function readReviewArtifactContexts(
  projectDir: string,
  stage: ReviewFingerprintStage,
  unit?: string,
): ReviewArtifactContext[] {
  const contexts: ReviewArtifactContext[] = [];
  const entries = reviewArtifactEntries(projectDir, stage, unit);
  if (entries === null) return contexts;
  const records = latestReviewRecordRefs(projectDir, stage);
  const recordScopes = new Set<string>();
  for (const entry of entries) {
    if (!entry.reviewAppendixTarget) continue;
    const scopeUnit = unit ?? entryUnit(entry.logicalPath, stage.slug);
    const ref = records.get(scopeUnit ?? "");
    if (!ref) continue;
    const record = readReviewRecord(projectDir, ref);
    // The record must be the review its paired row describes, for this scope:
    // a genuine record from another stage, Unit, or iteration that a row
    // happened to name is not this review.
    if (
      record === null ||
      record.stage !== stage.slug ||
      (record.unit ?? "") !== (scopeUnit ?? "") ||
      !reviewRecordMatchesCompletion(record, ref.completion)
    ) {
      continue;
    }
    const artifact = workspaceArtifactPath(projectDir, entry);
    recordScopes.add(scopeUnit ?? "");
    contexts.push({
      artifact,
      ...(scopeUnit ? { unit: scopeUnit } : {}),
      verdict: record.verdict,
      findings: reviewRecordFindings(record, artifact),
    });
  }
  for (const entry of entries) {
    if (entry.path === null || !existsSync(entry.path)) continue;
    const scopeUnit = unit ?? entryUnit(entry.logicalPath, stage.slug);
    if (recordScopes.has(scopeUnit ?? "")) continue;
    const artifact = workspaceArtifactPath(projectDir, entry);
    const parsed = parseReviewArtifact(
      readFileSync(entry.path, "utf-8"),
      artifact,
      scopeUnit,
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
  unit?: string,
): Map<string, ReviewFindingDisposition> {
  const events = readAuditShardEvents(projectDir)
    .filter((event) => {
      if (event.event !== "GATE_APPROVED" && event.event !== "GATE_REJECTED") {
        return false;
      }
      const gateStages = (auditBlockField(event.block, "Gate Stages") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (
        auditBlockField(event.block, "Stage") !== stageSlug &&
        !gateStages.includes(stageSlug)
      ) {
        return false;
      }
      const eventUnit = auditBlockField(event.block, "Unit");
      return unit === undefined || eventUnit === null || eventUnit === unit;
    })
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

type ReviewDispositionStages =
  | ReviewFingerprintStage
  | ReviewFingerprintStage[];

function dispositionStages(
  stages: ReviewDispositionStages,
): ReviewFingerprintStage[] {
  return Array.isArray(stages) ? stages : [stages];
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
  stages: ReviewDispositionStages,
  unit?: string,
): string | undefined {
  const dispositions = dispositionStages(stages).flatMap((stage) => {
    if (!stage.reviewer) return [];
    const hydrated = hydrateReviewArtifactContexts(
      readReviewArtifactContexts(projectDir, stage, unit),
      readReviewFindingDispositions(projectDir, stage.slug, unit),
    );
    return hydrated.flatMap((context) =>
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
  });
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
  stages: ReviewDispositionStages,
  specs: string[],
  unit?: string,
): string | undefined {
  if (specs.length === 0) return undefined;
  const stageList = dispositionStages(stages);
  if (!stageList.some((stage) => stage.reviewer)) {
    const subject = stageList.length === 1
      ? `stage "${stageList[0].slug}"`
      : `gate "${stageList.map((stage) => stage.slug).join(",")}"`;
    throw new Error(
      `Cannot reject review findings for ${subject}: ` +
        `the ${stageList.length === 1 ? "stage" : "gate"} has no reviewer.`,
    );
  }
  const findings = stageList.flatMap((stage) => {
    if (!stage.reviewer) return [];
    return hydrateReviewArtifactContexts(
      readReviewArtifactContexts(projectDir, stage, unit),
      readReviewFindingDispositions(projectDir, stage.slug, unit),
    ).flatMap((context) => context.findings);
  });
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
        `Cannot reject ${spec.artifact}#${spec.id}: it is not a current review finding for this gate.`,
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

function pathUnit(path: string, stageSlug: string): string | undefined {
  const match = /(?:^|\/)construction\/([^/]+)\/([^/]+)\//.exec(path);
  return match?.[2] === stageSlug ? match[1] : undefined;
}

function sourcePathDisplay(key: string): string | null {
  const separator = key.indexOf("\0");
  if (separator === -1 || key.indexOf("\0", separator + 1) !== -1) return null;
  const repo = key.slice(0, separator);
  const path = key.slice(separator + 1);
  if (path.length === 0) return null;
  return repo.length > 0 ? `${repo}/${path}` : path;
}

function changedUnitSourcePaths(
  projectDir: string,
  stageSlug: string,
  unit: string,
  beforeFingerprint: string | null,
  afterFingerprint: string | null,
): { paths: string[]; manifestChanged: boolean } {
  if (!beforeFingerprint || !afterFingerprint) {
    return { paths: [], manifestChanged: false };
  }
  const before = readUnitSourceSnapshot(
    projectDir,
    stageSlug,
    unit,
    beforeFingerprint,
  );
  const after = readUnitSourceSnapshot(
    projectDir,
    stageSlug,
    unit,
    afterFingerprint,
  );
  if (before === null || after === null) {
    return { paths: [], manifestChanged: false };
  }

  const paths = new Set<string>();
  for (const key of new Set([...before.listing.keys(), ...after.listing.keys()])) {
    if (before.listing.get(key) === after.listing.get(key)) continue;
    const display = sourcePathDisplay(key);
    if (display !== null) paths.add(display);
  }
  return {
    paths: [...paths].sort(),
    manifestChanged: before.manifestSha256 !== after.manifestSha256,
  };
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
  // Equal-second rows from different shards are causally unordered. Keep the
  // maximal boundary frontier instead of resolving ties by shard filename.
  const attemptView = reviewInvalidationAttemptView(
    readAuditShardEvents(projectDir),
    stage.slug,
  );
  const { events, floor: attemptFrontier } = attemptView;
  const inAttempt = (event: AuditShardEvent): boolean =>
    attemptEventAfterFrontier(attemptFrontier, event);

  const currentArtifacts = new Set(
    (reviewArtifactEntries(projectDir, stage) ?? []).map((entry) =>
      workspaceArtifactPath(projectDir, entry)
    ),
  );
  const currentReviews = new Set(
    contexts.map((context) => `${context.artifact}#Review`),
  );
  const changedUpstream = new Set<string>();
  const invalidatedArtifacts = new Set<string>();
  const invalidatedReviews = new Set<string>();

  const addContextReviews = (unit?: string): void => {
    const affected = unit
      ? contexts.filter((context) => context.unit === unit)
      : contexts;
    for (const context of affected) {
      invalidatedReviews.add(`${context.artifact}#Review`);
    }
  };

  const collectArtifactChanges = (
    reviewFrontier: AuditShardEvent[],
    before?: AuditShardEvent,
    unit?: string,
  ): void => {
    for (const event of events) {
      if (
        !inAttempt(event) ||
        !attemptEventAfterFrontier(reviewFrontier, event) ||
        (before !== undefined &&
          !attemptEventDefinitelyBefore(event, before))
      ) {
        continue;
      }
      if (
        event.event !== "ARTIFACT_CREATED" &&
        event.event !== "ARTIFACT_UPDATED"
      ) {
        continue;
      }
      const file = auditBlockField(event.block, "File");
      if (!file) continue;
      const normalized = toPosix(
        relative(projectDir, resolveAuditProjectPath(projectDir, file)),
      );
      if (currentArtifacts.has(normalized)) {
        const changedUnit = pathUnit(normalized, stage.slug);
        if (
          unit !== undefined &&
          changedUnit !== undefined &&
          changedUnit !== unit
        ) {
          continue;
        }
        changedUpstream.add(normalized);
        addContextReviews(changedUnit ?? unit);
        continue;
      }
      const sourceManifest =
        /(?:^|\/)construction\/([^/]+)\/([^/]+)\/source-manifest\.json$/.exec(
          normalized,
        );
      if (sourceManifest?.[2] === stage.slug) {
        if (unit !== undefined && sourceManifest[1] !== unit) continue;
        changedUpstream.add(normalized);
        addContextReviews(sourceManifest[1]);
      }
    }
  };

  // Recovery is stamped on REVIEW_REQUESTED. Pair each recovery request with
  // the receipt it replaces so those concrete changes survive the later
  // REVIEW_COMPLETED row.
  for (const event of events) {
    if (
      !inAttempt(event) ||
      event.event !== "REVIEW_REQUESTED" ||
      auditBlockField(event.block, "Stage") !== stage.slug ||
      auditBlockField(event.block, "Recovery") !== "stale-receipt"
    ) {
      continue;
    }
    const unit = auditBlockField(event.block, "Unit") ?? undefined;
    const staleReviewFrontier = maximalAttemptEvents(
      events.filter((candidate) =>
        inAttempt(candidate) &&
        candidate.event === "REVIEW_COMPLETED" &&
        auditBlockField(candidate.block, "Stage") === stage.slug &&
        (auditBlockField(candidate.block, "Unit") ?? undefined) === unit &&
        attemptEventDefinitelyBefore(candidate, event)
      ),
    );
    if (staleReviewFrontier.length === 0) continue;
    collectArtifactChanges(staleReviewFrontier, event, unit);

    if (unit && staleReviewFrontier.length === 1) {
      const staleReview = staleReviewFrontier[0];
      const sourceChanges = changedUnitSourcePaths(
        projectDir,
        stage.slug,
        unit,
        auditBlockField(
          staleReview.block,
          "Unit Source Fingerprint",
        ),
        auditBlockField(event.block, "Unit Source Fingerprint"),
      );
      for (const path of sourceChanges.paths) changedUpstream.add(path);
      if (sourceChanges.paths.length > 0) addContextReviews(unit);
      if (sourceChanges.manifestChanged) {
        const record = recordDir(projectDir);
        if (record !== null) {
          changedUpstream.add(
            toPosix(
              relative(
                projectDir,
                resolve(
                  record,
                  "construction",
                  unit,
                  stage.slug,
                  "source-manifest.json",
                ),
              ),
            ),
          );
          addContextReviews(unit);
        }
      }
    }
  }

  // Preserve newly stale receipts per Unit. A later receipt for Unit B must not
  // move Unit A's scan window past an A-specific write.
  const reviewScopes = new Map<string, AuditShardEvent[]>();
  for (const event of events) {
    if (
      !inAttempt(event) ||
      event.event !== "REVIEW_COMPLETED" ||
      auditBlockField(event.block, "Stage") !== stage.slug
    ) {
      continue;
    }
    const key = auditBlockField(event.block, "Unit") ?? "";
    const scope = reviewScopes.get(key) ?? [];
    scope.push(event);
    reviewScopes.set(key, scope);
  }
  for (const [key, reviews] of reviewScopes) {
    collectArtifactChanges(
      maximalAttemptEvents(reviews),
      undefined,
      key.length > 0 ? key : undefined,
    );
  }

  // A backward jump is itself an attempt boundary. Remove downstream paths
  // whose own stage gate has since consumed them, while preserving the changed
  // upstream source as context for stages that still require re-check.
  const boundary = attemptFrontier.length === 1
    ? attemptFrontier[0]
    : undefined;
  if (
    boundary?.event === "STAGE_JUMPED" &&
    auditBlockField(boundary.block, "Direction") === "BACKWARD"
  ) {
    const jumpChanged = parseAuditPathArray(
      auditBlockField(boundary.block, "Changed Upstream Artifacts"),
    );
    const jumpArtifacts = parseAuditPathArray(
      auditBlockField(boundary.block, "Invalidated Downstream Artifacts"),
    );
    const jumpReviews = parseAuditPathArray(
      auditBlockField(boundary.block, "Invalidated Downstream Reviews"),
    );
    const consumedArtifacts = new Set<string>();
    const consumedReviews = new Set<string>();
    for (const event of events) {
      if (
        event.event !== "GATE_APPROVED" &&
        event.event !== "GATE_REJECTED"
      ) {
        continue;
      }
      // Consume paths only when the gate is causally proven after the jump.
      // Equal-second cross-shard ties remain pending rather than hiding work
      // that may have been invalidated after that gate.
      if (!attemptEventDefinitelyBefore(boundary, event)) continue;
      const consumedStageSlug = auditBlockField(event.block, "Stage");
      const consumedStage = consumedStageSlug
        ? findStageBySlug(consumedStageSlug)
        : undefined;
      if (!consumedStage) continue;
      for (const entry of reviewArtifactEntries(projectDir, consumedStage) ?? []) {
        const path = workspaceArtifactPath(projectDir, entry);
        consumedArtifacts.add(path);
        consumedReviews.add(`${path}#Review`);
      }
    }
    const pendingArtifacts = jumpArtifacts.filter((path) =>
      !consumedArtifacts.has(path)
    );
    const pendingReviews = jumpReviews.filter((path) =>
      !consumedReviews.has(path)
    );
    const relevant =
      jumpChanged.some((path) => currentArtifacts.has(path)) ||
      pendingArtifacts.some((path) => currentArtifacts.has(path)) ||
      pendingReviews.some((path) => currentReviews.has(path));
    if (relevant) {
      for (const path of jumpChanged) changedUpstream.add(path);
      for (const path of pendingArtifacts) invalidatedArtifacts.add(path);
      for (const path of pendingReviews) invalidatedReviews.add(path);
    }
  }

  return {
    changedUpstream: [...changedUpstream].sort(),
    invalidatedArtifacts: [...invalidatedArtifacts].sort(),
    invalidatedReviews: [...invalidatedReviews].sort(),
  };
}

/**
 * The CHANGE_ACCEPTED rows for reviewed content of `stageSlug` in the current
 * attempt: the human line each carried and the paths it named, oldest first.
 */
export function acceptedReviewChanges(
  projectDir: string,
  stageSlug: string,
): Array<{ notice: string; changed: string[] | null }> {
  const attemptView = reviewInvalidationAttemptView(
    readAuditShardEvents(projectDir),
    stageSlug,
  );
  const accepted: Array<{ notice: string; changed: string[] | null }> = [];
  for (const event of attemptView.events) {
    if (
      event.event !== "CHANGE_ACCEPTED" ||
      !attemptEventAfterFrontier(attemptView.floor, event) ||
      auditBlockField(event.block, "Stage") !== stageSlug ||
      auditBlockField(event.block, "Checkpoint") !== "review-receipt"
    ) {
      continue;
    }
    const changed = auditBlockField(event.block, "Changed");
    accepted.push({
      notice: auditBlockField(event.block, "Details") ?? "Reviewed content changed after it was reviewed.",
      changed:
        changed === null || changed === "(paths unavailable)"
          ? null
          : changed.split(", ").map((path) => path.trim()).filter((path) => path.length > 0),
    });
  }
  return accepted;
}

export function renderReviewBrief(
  projectDir: string,
  stage: ReviewFingerprintStage & { name: string },
  reason: ReviewBriefReason,
  unit?: string,
  fallbackFinding?: string,
): string {
  // Per-Unit review dispatches are isolated, but their final human approval is
  // one stage-level gate. The last Unit is only the execution cursor.
  const contextUnit = stage.for_each === "unit-of-work" ? undefined : unit;
  let contexts = hydrateReviewArtifactContexts(
    readReviewArtifactContexts(projectDir, stage, contextUnit),
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
  // Reviewed content that changed after the receipt and was accepted under
  // Change Control `relaxed` (the ledger's CHANGE_ACCEPTED rows for this stage
  // in the current attempt). The verdict above is the reviewer's; these lines
  // tell the human what moved since it was recorded.
  for (const accepted of acceptedReviewChanges(projectDir, stage.slug)) {
    lines.push(`**Reviewed content differs:** ${accepted.notice}`);
    if (accepted.changed !== null) {
      lines.push(
        `**Changed after review:** ${accepted.changed.map((path) => `\`${path}\``).join(", ")}`,
      );
    }
  }
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
