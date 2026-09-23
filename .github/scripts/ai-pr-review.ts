import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  acceptedRisks,
  deriveDecision,
  fileAnchor,
  headContainsAnchor,
  headFileSha256,
  isBlocking,
  ledgerVerdict,
  lineAnchor,
  loadLedgerComment,
  positionAnchor,
  quoteAnchor,
  readContextLine,
  readLedgerFile,
  reconcileLedger,
  type LedgerAnchor,
  type LedgerFinding,
  type LoadedLedger,
  writeLedgerFile,
} from "./ai-pr-ledger.ts";

const MAX_CHANGED_FILES = 500;
const MAX_REVIEW_BYTES = 100_000;
const CURRENT_AI_REVIEWS_FILE = "current-ai-reviews.json";
const DISCUSSION_FILE = "discussion.json";
const AI_REVIEW_MARKER = "<!-- ai-pr-review context=";
const AI_REVIEW_DECISION_MARKER = "<!-- ai-pr-review decision=";

export type Priority = "P0" | "P1" | "P2" | "P3";
export type FindingCategory =
  | "direction"
  | "user-experience"
  | "security"
  | "contracts"
  | "workflow-state"
  | "correctness";
export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";
export type DiffSide = "LEFT" | "RIGHT";
export type PullRequestDecision =
  | { actor: "author"; action: "change"; rationale: string }
  | { actor: "maintainer"; action: "merge"; rationale: string };
export type ReviewLabelOutcome =
  | "started"
  | "reviewed-change"
  | "reviewed-merge"
  | "review-error";

export interface ReviewLabelDefinition {
  name: string;
  color: string;
  description: string;
}

export const REVIEW_LABELS: readonly ReviewLabelDefinition[] = [
  {
    name: "aida:reviewed",
    color: "1F883D",
    description: "AIDA successfully reviewed the latest PR state",
  },
  {
    name: "aida:review-error",
    color: "D1242F",
    description: "AIDA could not produce a reliable review for the latest PR state",
  },
  {
    name: "next:author",
    color: "FBCA04",
    description: "AIDA indicates the PR author needs to act next",
  },
  {
    name: "next:maintainer",
    color: "0969DA",
    description: "AIDA indicates a maintainer needs to act next",
  },
  {
    name: "action:change",
    color: "D93F0B",
    description: "AIDA indicates changes are required before the PR proceeds",
  },
  {
    name: "action:merge",
    color: "0E8A16",
    description: "AIDA considers the PR ready for a maintainer merge decision",
  },
] as const;

const FINDING_CATEGORIES: Array<{ value: FindingCategory; heading: string }> = [
  { value: "direction", heading: "Direction" },
  { value: "user-experience", heading: "User Experience" },
  { value: "security", heading: "Security & Trust" },
  { value: "contracts", heading: "Contracts & Compatibility" },
  { value: "workflow-state", heading: "Workflow, State & Recovery" },
  { value: "correctness", heading: "Correctness & Reliability" },
];

export interface LineRange {
  start: number;
  end: number;
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: string;
  added: LineRange[];
  deleted: LineRange[];
  fileLevelEvidence: boolean;
  snapshot?: string;
}

export interface ChangedFileManifest {
  base: string;
  head: string;
  files: ChangedFile[];
}

export interface DiffEvidence {
  source: "DIFF";
  path: string;
  line: number;
  side: DiffSide;
}

export interface FileEvidence {
  source: "DIFF_FILE";
  path: string;
}

export interface MetadataEvidence {
  source: "PR_TITLE" | "PR_BODY";
  quote: string;
}

export type FindingEvidence = DiffEvidence | FileEvidence | MetadataEvidence;

export interface ReviewMetadata {
  title: string;
  body: string;
}

export interface DiscussionActor {
  login: string;
  association: string;
  maintainer: boolean;
}

export interface DiscussionEntry {
  id: number;
  kind: "review" | "review-comment" | "ai-review";
  actor: DiscussionActor;
  body: string;
  createdAt: string;
  updatedAt: string;
  state?: string;
  commitId?: string;
  path?: string;
  line?: number | null;
  side?: string | null;
  replyToId?: number | null;
}

export interface ReviewDiscussion {
  version: 1;
  pullRequest: number;
  reviews: DiscussionEntry[];
  reviewComments: DiscussionEntry[];
}

export interface Finding {
  priority: Priority;
  category: FindingCategory;
  title: string;
  evidence: FindingEvidence[];
  problem: string;
  impact: string;
  requiredCorrection: string;
  ledgerId?: string;
}

export interface UserExperienceAssessment {
  status: "changed" | "no-user-visible-change" | "uncertain";
  change: string;
  before: string | null;
  after: string | null;
  example: string | null;
  assessment: string;
}

// What the scoped lenses and the judge are asked to review at this head.
// `full`: the whole PR diff. `incremental`: only the lines of the PR diff that
// changed since the head AIDA last reviewed; everything else was reviewable
// then and its findings live in the ledger. Security lenses always see the
// full head, whatever the mode.
export interface ReviewScopeFile {
  path: string;
  // The base path of a renamed file (LEFT evidence cites it).
  previousPath?: string;
  // Head lines of the PR diff changed since the last review.
  added: LineRange[];
  // Base lines deleted since the last review, in the PR diff's LEFT coordinates
  // (a since-line that was itself added after the base has no base line and is
  // not listed).
  deleted: LineRange[];
  // The whole file was deleted since the last review.
  deletedFile: boolean;
}

export interface ReviewScope {
  mode: "full" | "incremental";
  since: string | null;
  reason: string;
  files: ReviewScopeFile[];
}

// A non-security finding the judge reported outside an incremental scope. It
// is published for transparency but never bears on the decision.
export interface DeferredFinding {
  priority: Priority;
  category: FindingCategory;
  title: string;
  paths: string[];
}

// The judge's explicit disposition of an open ledger entry. `findingIndex`
// names the restatement in `findings`; the validator binds the id to it.
export interface LedgerDisposition {
  id: string;
  disposition: "still-open" | "resolved";
  findingIndex: number | null;
}

export interface StructuredReview {
  base: string;
  head: string;
  inspection: {
    status: "complete";
    changedFiles: string[];
  };
  validation: string[];
  assessment: {
    readiness: {
      score: number;
      rationale: string;
    };
    risk: {
      score: number;
      rationale: string;
    };
  };
  userExperience: UserExperienceAssessment;
  decision: PullRequestDecision;
  findings: Finding[];
  residualRisk: string;
  ledger?: ReviewLedgerSummary;
  scope?: ReviewScope;
  deferred?: DeferredFinding[];
  dispositions?: LedgerDisposition[];
}

export interface ReviewLedgerSummary {
  accepted: LedgerFinding[];
  retained: LedgerFinding[];
  suppressed: number;
  reopened: number;
  resolvedIds: string[];
  open: number;
  migrated: boolean;
  decisionAdjusted: boolean;
  // Open entries the judge explicitly resolved at this head, open entries it
  // left without a disposition (retained by presence, as before), and blockers
  // it declared resolved without deterministic evidence (kept retained).
  resolvedByJudge: string[];
  undisposed: string[];
  unverifiedResolutions: string[];
}

export interface ReviewPayload {
  commit_id: string;
  body: string;
  event: ReviewEvent;
}

function assertSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character commit SHA`);
  }
}

function argValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function git(args: string[], encoding?: BufferEncoding, cwd = process.cwd()): Buffer | string {
  return execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gh(args: string[], executable = "gh"): unknown {
  return JSON.parse(execFileSync(executable, args, {
    encoding: "utf8",
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

function ghRaw(
  args: string[],
  executable = "gh",
  input?: string,
): string {
  return execFileSync(executable, args, {
    encoding: "utf8",
    input,
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function labelsForOutcome(outcome: ReviewLabelOutcome): string[] {
  if (outcome === "started") return [];
  if (outcome === "review-error") return ["aida:review-error"];
  if (outcome === "reviewed-change") {
    return ["aida:reviewed", "next:author", "action:change"];
  }
  return ["aida:reviewed", "next:maintainer", "action:merge"];
}

export function outcomeForLabels(labels: string[]): ReviewLabelOutcome {
  const managed = new Set(REVIEW_LABELS.map(definition => definition.name));
  const actual = [...new Set(labels.filter(label => managed.has(label)))].sort();
  for (const outcome of [
    "review-error",
    "reviewed-change",
    "reviewed-merge",
  ] as const) {
    const expected = [...labelsForOutcome(outcome)].sort();
    if (
      actual.length === expected.length &&
      actual.every((label, index) => label === expected[index])
    ) {
      return outcome;
    }
  }
  return "started";
}

function pullLabels(pull: Record<string, unknown>): string[] {
  return Array.isArray(pull.labels)
    ? pull.labels.map((value, index) =>
      text(record(value, `pull request labels[${index}]`).name)
    )
    : [];
}

function pullIsEligible(pull: Record<string, unknown>, expectedHead?: string): boolean {
  const head = record(pull.head, "pull request head");
  if (expectedHead !== undefined && head.sha !== expectedHead) return false;
  return pull.state === "open" && pull.draft !== true;
}

function removeManagedLabels(
  repository: string,
  pullRequest: number,
  labels: string[],
  ghExecutable: string,
): void {
  const managed = new Set(REVIEW_LABELS.map(definition => definition.name));
  for (const label of labels) {
    if (!managed.has(label)) continue;
    ghRaw(
      [
        "api",
        "--silent",
        "--method",
        "DELETE",
        `repos/${repository}/issues/${pullRequest}/labels/${encodeURIComponent(label)}`,
      ],
      ghExecutable,
    );
  }
}

export function reconcileReviewLabels(
  repository: string,
  pullRequest: number,
  outcome: ReviewLabelOutcome,
  expectedHead?: string,
  ghExecutable = "gh",
): boolean {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must use owner/name format");
  }
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    throw new Error("pull request number must be a positive integer");
  }
  if (expectedHead !== undefined) assertSha(expectedHead, "expected head");

  const readPull = (): Record<string, unknown> =>
    record(
      JSON.parse(ghRaw(["api", `repos/${repository}/pulls/${pullRequest}`], ghExecutable)),
      "pull request",
    );
  if (!pullIsEligible(readPull(), expectedHead)) return false;

  for (const definition of REVIEW_LABELS) {
    const endpoint = `repos/${repository}/labels/${encodeURIComponent(definition.name)}`;
    try {
      ghRaw(["api", "--silent", endpoint], ghExecutable);
    } catch {
      try {
        ghRaw(
          ["api", "--method", "POST", `repos/${repository}/labels`, "--input", "-"],
          ghExecutable,
          `${JSON.stringify(definition)}\n`,
        );
      } catch {
        // Another PR review can create the shared repository label between our
        // GET and POST. Confirm that it now exists before continuing.
        ghRaw(["api", "--silent", endpoint], ghExecutable);
      }
    }
  }

  const pullBeforeMutation = readPull();
  if (!pullIsEligible(pullBeforeMutation, expectedHead)) {
    removeManagedLabels(repository, pullRequest, pullLabels(pullBeforeMutation), ghExecutable);
    return false;
  }
  const labels = pullLabels(pullBeforeMutation);
  const managed = new Set(REVIEW_LABELS.map(definition => definition.name));
  const desired = new Set(labelsForOutcome(outcome));
  for (const label of labels) {
    if (!managed.has(label) || desired.has(label)) continue;
    ghRaw(
      [
        "api",
        "--silent",
        "--method",
        "DELETE",
        `repos/${repository}/issues/${pullRequest}/labels/${encodeURIComponent(label)}`,
      ],
      ghExecutable,
    );
  }
  const missing = [...desired].filter(label => !labels.includes(label));
  if (missing.length > 0) {
    ghRaw(
      [
        "api",
        "--silent",
        "--method",
        "POST",
        `repos/${repository}/issues/${pullRequest}/labels`,
        "--input",
        "-",
      ],
      ghExecutable,
      `${JSON.stringify({ labels: missing })}\n`,
    );
  }

  const pullAfterMutation = readPull();
  if (!pullIsEligible(pullAfterMutation, expectedHead)) {
    removeManagedLabels(repository, pullRequest, pullLabels(pullAfterMutation), ghExecutable);
    return false;
  }
  return true;
}

export type RefreshOutcome = "applied" | "moved" | "no-review";

// Applies a verdict re-derived from the findings ledger to every surface a
// command owns for the reviewed head: the managed labels and the bot's review
// state. `change` needs an active CHANGES_REQUESTED review from the bot on the
// head (a stale merge review cannot be dismissed, so a blocking one is posted
// under the same context); `merge` dismisses the bot's blocking reviews. The
// workflow check of the original run is not rewritten.
export function refreshVerdict(
  repository: string,
  pullRequest: number,
  head: string,
  decision: "merge" | "change",
  reason: string,
  ghExecutable = "gh",
): RefreshOutcome {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must use owner/name format");
  }
  assertSha(head, "head");
  const pull = record(
    JSON.parse(ghRaw(["api", `repos/${repository}/pulls/${pullRequest}`], ghExecutable)),
    "pull request",
  );
  if (!pullIsEligible(pull, head)) return "moved";
  const reviewsForHead = (): Record<string, unknown>[] =>
    paginatedRecords(`repos/${repository}/pulls/${pullRequest}/reviews`, ghExecutable).filter(
      review =>
        record(review.user ?? {}, "review user").login === "github-actions[bot]" &&
        text(review.commit_id) === head &&
        text(review.body).startsWith("<!-- ai-pr-review context="),
    );
  const desiredLabels = decision === "merge" ? "reviewed-merge" : "reviewed-change";

  // Converge the review gate first, then the derived labels. Each attempt
  // verifies both surfaces after mutation, so interruption or a concurrent
  // writer can be repaired by the same idempotent operation.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const reviews = reviewsForHead();
    if (reviews.length === 0) return "no-review";
    const blocking = reviews.filter(review => text(review.state) === "CHANGES_REQUESTED");
    if (decision === "merge") {
      for (const review of blocking) {
        ghRaw(
          [
            "api",
            "--method",
            "PUT",
            `repos/${repository}/pulls/${pullRequest}/reviews/${integer(review.id, "review id")}/dismissals`,
            "--input",
            "-",
          ],
          ghExecutable,
          `${JSON.stringify({ message: `The decision for this head was re-derived as maintainer/merge from the findings ledger (${reason}).` })}\n`,
        );
      }
    } else if (blocking.length === 0) {
      const contextMatch = /<!-- ai-pr-review context=([0-9a-f]{64}) -->/.exec(text(reviews[0].body));
      if (!contextMatch) return "no-review";
      const body = [
        `<!-- ai-pr-review context=${contextMatch[1]} -->`,
        "<!-- ai-pr-review decision=author/change -->",
        `The decision for \`${head}\` was re-derived as **author/change** from the findings ledger (${reason}). The open blocking findings are listed in the ledger comment; the earlier review body stays as the assessment of this head.`,
        "",
        "Reviewed by AIDA (AI-DLC Developer Agent).",
        "",
        `[AI-PR-REVIEWED] ${head}`,
      ].join("\n");
      ghRaw(
        ["api", "--method", "POST", `repos/${repository}/pulls/${pullRequest}/reviews`, "--input", "-"],
        ghExecutable,
        `${JSON.stringify({ commit_id: head, event: "REQUEST_CHANGES", body })}\n`,
      );
    }

    const gateApplied = reviewsForHead().some(review => text(review.state) === "CHANGES_REQUESTED") ===
      (decision === "change");
    if (!gateApplied) continue;
    if (!reconcileReviewLabels(repository, pullRequest, desiredLabels, head, ghExecutable)) {
      return "moved";
    }
    const labelsApplied = currentReviewLabelOutcome(repository, pullRequest, head, ghExecutable) === desiredLabels;
    const gateStillApplied = reviewsForHead().some(review => text(review.state) === "CHANGES_REQUESTED") ===
      (decision === "change");
    if (labelsApplied && gateStillApplied) return "applied";
  }
  throw new Error("review gate and labels did not converge after 3 attempts");
}

export function convergeLedgerVerdict(
  repository: string,
  pullRequest: number,
  head: string,
  reason: string,
  ghExecutable = "gh",
): RefreshOutcome {
  assertSha(head, "head");
  // The review and command workflows share one non-cancelling per-PR
  // concurrency group. No ledger command can overtake this mutation, so one
  // live read is the authority for the gate and label convergence below.
  const loaded = loadLedgerComment(repository, pullRequest, ghExecutable);
  const verdict = ledgerVerdict(loaded.ledger);
  if (!verdict || verdict.head !== head) return "moved";
  return refreshVerdict(
    repository,
    pullRequest,
    head,
    verdict.decision,
    reason,
    ghExecutable,
  );
}

export function currentReviewLabelOutcome(
  repository: string,
  pullRequest: number,
  expectedHead?: string,
  ghExecutable = "gh",
): ReviewLabelOutcome {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must use owner/name format");
  }
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    throw new Error("pull request number must be a positive integer");
  }
  if (expectedHead !== undefined) assertSha(expectedHead, "expected head");
  const pull = record(
    JSON.parse(ghRaw(["api", `repos/${repository}/pulls/${pullRequest}`], ghExecutable)),
    "pull request",
  );
  if (!pullIsEligible(pull, expectedHead)) return "started";
  return outcomeForLabels(pullLabels(pull));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function paginatedRecords(endpoint: string, ghExecutable = "gh"): Record<string, unknown>[] {
  const pages = gh(["api", "--paginate", "--slurp", endpoint], ghExecutable);
  if (!Array.isArray(pages)) throw new Error(`${endpoint} pagination did not return pages`);
  return pages.flatMap((page, index) => records(page, `${endpoint} page ${index}`));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function actor(value: unknown, association: unknown): DiscussionActor {
  const user = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const login = text(user.login) || "[deleted]";
  const normalizedAssociation = text(association).toUpperCase();
  return {
    login,
    association: normalizedAssociation,
    maintainer: ["OWNER", "MEMBER", "COLLABORATOR"].includes(normalizedAssociation),
  };
}

function date(value: unknown): string {
  return text(value);
}

function commentEntry(
  value: Record<string, unknown>,
): DiscussionEntry {
  const entry: DiscussionEntry = {
    id: integer(value.id, "review-comment id"),
    kind: "review-comment",
    actor: actor(value.user, value.author_association),
    body: text(value.body),
    createdAt: date(value.created_at),
    updatedAt: date(value.updated_at),
  };
  entry.commitId = text(value.commit_id);
  entry.path = text(value.path);
  entry.line = typeof value.line === "number" ? value.line : null;
  entry.side = typeof value.side === "string" ? value.side : null;
  entry.replyToId = typeof value.in_reply_to_id === "number" ? value.in_reply_to_id : null;
  return entry;
}

function reviewEntry(value: Record<string, unknown>): DiscussionEntry {
  const body = text(value.body);
  const reviewActor = actor(value.user, value.author_association);
  return {
    id: integer(value.id, "review id"),
    kind: reviewActor.login === "github-actions[bot]" && body.startsWith(AI_REVIEW_MARKER)
      ? "ai-review"
      : "review",
    actor: reviewActor,
    body,
    createdAt: date(value.submitted_at),
    updatedAt: date(value.submitted_at),
    state: text(value.state),
    commitId: text(value.commit_id),
  };
}

function byTimeAndId(left: DiscussionEntry, right: DiscussionEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id - right.id;
}

export function normalizeDiscussion(
  pullRequest: number,
  head: string,
  reviewsRaw: Record<string, unknown>[],
  reviewCommentsRaw: Record<string, unknown>[],
): { discussion: ReviewDiscussion; currentAiReviews: DiscussionEntry[] } {
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    throw new Error("pull request number must be a positive integer");
  }
  assertSha(head, "head");
  const normalizedReviews = reviewsRaw.map(reviewEntry).sort(byTimeAndId);
  const currentAiReviews = normalizedReviews.filter(
    entry => entry.kind === "ai-review" && entry.commitId === head,
  );
  const stableReviews = normalizedReviews
    .filter(entry => entry.kind !== "ai-review" || entry.commitId !== head)
    .map(entry => {
      if (entry.kind !== "ai-review") return entry;
      const stableEntry = { ...entry };
      delete stableEntry.state;
      return stableEntry;
    });
  const discussion: ReviewDiscussion = {
    version: 1,
    pullRequest,
    reviews: stableReviews,
    reviewComments: reviewCommentsRaw
      .map(value => commentEntry(value))
      .sort(byTimeAndId),
  };
  return { discussion, currentAiReviews };
}

export function authoritativeDiscussion(discussion: ReviewDiscussion): ReviewDiscussion {
  return {
    ...discussion,
    reviews: discussion.reviews.filter(
      entry => entry.actor.maintainer || entry.kind === "ai-review",
    ),
    reviewComments: discussion.reviewComments.filter(entry => entry.actor.maintainer),
  };
}

export function buildDiscussion(
  repository: string,
  pullRequest: number,
  head: string,
  output: string,
  currentAiOutput: string,
  identityOutput?: string,
  ghExecutable = "gh",
): void {
  const reviews = paginatedRecords(
    `repos/${repository}/pulls/${pullRequest}/reviews`,
    ghExecutable,
  );
  const reviewComments = paginatedRecords(
    `repos/${repository}/pulls/${pullRequest}/comments`,
    ghExecutable,
  );
  const normalized = normalizeDiscussion(
    pullRequest,
    head,
    reviews,
    reviewComments,
  );
  writeFileSync(output, `${JSON.stringify(normalized.discussion, null, 2)}\n`);
  writeFileSync(currentAiOutput, `${JSON.stringify(normalized.currentAiReviews, null, 2)}\n`);
  if (identityOutput) {
    writeFileSync(
      identityOutput,
      `${JSON.stringify(authoritativeDiscussion(normalized.discussion), null, 2)}\n`,
    );
  }
}

function safeRepoPath(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    [...path].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    path.split("/").some(part => part === ".." || part === ".")
  ) {
    throw new Error(`unsafe changed path: ${JSON.stringify(path)}`);
  }
  return path;
}

function parseNameStatus(raw: Buffer): Array<{ status: string; path: string; previousPath?: string }> {
  const fields = raw.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: Array<{ status: string; path: string; previousPath?: string }> = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) throw new Error("empty git diff status");
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = safeRepoPath(fields[index++] ?? "");
      const path = safeRepoPath(fields[index++] ?? "");
      entries.push({ status, path, previousPath });
    } else {
      entries.push({ status, path: safeRepoPath(fields[index++] ?? "") });
    }
  }
  return entries;
}

function rangesFromDiff(
  patch: string,
  expectedFiles: number,
): Array<{ added: LineRange[]; deleted: LineRange[]; fileLevelEvidence: boolean; hunks: DiffHunk[] }> {
  const sections = patch.split(/(?=^diff --git )/m).filter(section => section.startsWith("diff --git "));
  if (sections.length !== expectedFiles) {
    throw new Error(
      `git diff section count ${sections.length} does not match changed-file count ${expectedFiles}`,
    );
  }
  return sections.map(section => {
    const added: LineRange[] = [];
    const deleted: LineRange[] = [];
    const hunks: DiffHunk[] = [];
    for (const match of section.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const oldStart = Number(match[1]);
      const oldCount = Number(match[2] ?? "1");
      const newStart = Number(match[3]);
      const newCount = Number(match[4] ?? "1");
      hunks.push({ oldStart, oldCount, newStart, newCount });
      if (oldCount > 0) deleted.push({ start: oldStart, end: oldStart + oldCount - 1 });
      if (newCount > 0) added.push({ start: newStart, end: newStart + newCount - 1 });
    }
    return {
      added,
      deleted,
      fileLevelEvidence: added.length === 0 && deleted.length === 0,
      hunks,
    };
  });
}

function writeSnapshot(outputDir: string, head: string, file: ChangedFile, repoDir: string): void {
  if (file.status.startsWith("D")) return;
  const content = git(["show", `${head}:${file.path}`], undefined, repoDir) as Buffer;
  const snapshot = join("head", file.path);
  const destination = resolve(outputDir, snapshot);
  const root = `${resolve(outputDir)}${sep}`;
  if (!destination.startsWith(root)) throw new Error(`snapshot escaped context root: ${file.path}`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  file.snapshot = snapshot;
}

function contextDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const contextPath = relative(root, path);
      if (
        contextPath === "context-id.txt" ||
        contextPath === CURRENT_AI_REVIEWS_FILE ||
        contextPath === DISCUSSION_FILE
      ) continue;
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else {
        hash.update(contextPath);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

export function buildContext(
  base: string,
  head: string,
  outputDir: string,
  repoDir = process.cwd(),
): ChangedFileManifest {
  assertSha(base, "base");
  assertSha(head, "head");
  mkdirSync(outputDir, { recursive: true });

  const diff = git(
    ["diff", "--binary", "--find-renames", "--unified=0", `${base}...${head}`],
    undefined,
    repoDir,
  ) as Buffer;
  writeFileSync(join(outputDir, "pr.diff"), diff);

  const entries = parseNameStatus(
    git(
      ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`],
      undefined,
      repoDir,
    ) as Buffer,
  );
  if (entries.length > MAX_CHANGED_FILES) {
    throw new Error(`PR changes ${entries.length} files; limit is ${MAX_CHANGED_FILES}`);
  }
  const ranges = rangesFromDiff(diff.toString("utf8"), entries.length);

  const files = entries.map((entry, index) => {
    const { hunks: _hunks, ...range } = ranges[index];
    const file: ChangedFile = { ...entry, ...range };
    writeSnapshot(outputDir, head, file, repoDir);
    return file;
  });
  const manifest = { base, head, files };
  writeFileSync(join(outputDir, "changed-files.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const digest = contextDigest(outputDir);
  writeFileSync(join(outputDir, "context-id.txt"), `${digest}\n`);
  return manifest;
}

function commitAvailable(sha: string, repoDir: string): boolean {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`], "utf8", repoDir);
    return true;
  } catch {
    try {
      git(["fetch", "--no-tags", "--quiet", "origin", sha], "utf8", repoDir);
      git(["cat-file", "-e", `${sha}^{commit}`], "utf8", repoDir);
      return true;
    } catch {
      return false;
    }
  }
}

function isAncestor(ancestor: string, descendant: string, repoDir: string): boolean {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant], "utf8", repoDir);
    return true;
  } catch {
    return false;
  }
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function intersectRanges(left: LineRange[], right: LineRange[]): LineRange[] {
  const result: LineRange[] = [];
  for (const a of left) {
    for (const b of right) {
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (start <= end) result.push({ start, end });
    }
  }
  return result.sort((x, y) => x.start - y.start);
}

// Deterministic review scope for a head. Incremental when AIDA already reviewed
// an ancestor of this head (`since`, from the ledger): the scope is the PR diff
// restricted to lines that changed between `since` and `head`, in head
// coordinates. Full on the first review, on a rewritten history (force-push),
// when the previous head is no longer fetchable, or when a maintainer asked
// with `/aida full`. Security lenses ignore the scope by contract.
export function buildScope(
  head: string,
  manifest: ChangedFileManifest,
  since: string | null,
  forceFull: boolean,
  repoDir = process.cwd(),
): ReviewScope {
  assertSha(head, "head");
  // Breadth (mode) and change evidence (files) are separate: a maintainer's
  // /aida full widens what the lenses review but keeps the deterministic
  // since-to-head change set when the previous head is known and ancestral, so
  // dispositions still have evidence to act on.
  const full = (reason: string, files: ReviewScopeFile[] = []): ReviewScope => ({ mode: "full", since, reason, files });
  if (since === null) return full("first review of this pull request");
  assertSha(since, "since");
  if (since === head) return full("this head was already reviewed");
  if (!commitAvailable(since, repoDir)) return full(`the previously reviewed head ${since.slice(0, 8)} is no longer available`);
  if (!isAncestor(since, head, repoDir)) return full(`history was rewritten since the review at ${since.slice(0, 8)}`);

  // Path lineage and line mapping come from the base..since diff: a since-path
  // is followed back to its base path, and a since-line to its base line.
  // The manifest is expressed against the merge base of base and head; the
  // prior diff must use the same coordinates.
  const priorDiff = git(["diff", "--binary", "--find-renames", "--unified=0", `${manifest.base}...${since}`], undefined, repoDir) as Buffer;
  const priorEntries = parseNameStatus(
    git(["diff", "--name-status", "-z", "--find-renames", `${manifest.base}...${since}`], undefined, repoDir) as Buffer,
  );
  const priorRanges = rangesFromDiff(priorDiff.toString("utf8"), priorEntries.length);
  const prior = new Map(priorEntries.map((entry, index) => [entry.path, { entry, ranges: priorRanges[index] }]));
  const basePathOf = (sincePath: string): string => prior.get(sincePath)?.entry.previousPath ?? sincePath;
  const sinceLineToBase = (sincePath: string, line: number): number | null => {
    const record = prior.get(sincePath);
    if (!record) return line;
    if (record.entry.status.startsWith("A")) return null;
    let offset = 0;
    for (const hunk of record.ranges.hunks) {
      if (line >= hunk.newStart && line < hunk.newStart + hunk.newCount) return null;
      if (line >= hunk.newStart + hunk.newCount) offset += hunk.oldCount - hunk.newCount;
    }
    return line + offset;
  };

  const diff = git(["diff", "--binary", "--find-renames", "--unified=0", `${since}..${head}`], undefined, repoDir) as Buffer;
  const entries = parseNameStatus(
    git(["diff", "--name-status", "-z", "--find-renames", `${since}..${head}`], undefined, repoDir) as Buffer,
  );
  const ranges = rangesFromDiff(diff.toString("utf8"), entries.length);
  const files: ReviewScopeFile[] = [];
  entries.forEach((entry, index) => {
    // The PR diff knows a file by its head path or its base path; a since-path
    // may differ from both after chained renames.
    const sincePath = entry.previousPath ?? entry.path;
    const names = new Set([entry.path, sincePath, basePathOf(sincePath), basePathOf(entry.path)]);
    const inPullRequest = manifest.files.find(
      file => names.has(file.path) || (file.previousPath !== undefined && names.has(file.previousPath)),
    );
    if (!inPullRequest) return;
    const range = ranges[index];
    // A change with no hunks since the review (mode, binary, pure rename) on a
    // file whose PR diff has hunks cannot be cited at file level: admit the
    // file's whole PR diff instead.
    const added = inPullRequest.fileLevelEvidence
      ? []
      : range.fileLevelEvidence
        ? inPullRequest.added
        : intersectRanges(range.added, inPullRequest.added);
    const deletedFile = entry.status.startsWith("D");
    const deleted = deletedFile
      ? []
      : mergeRanges(
          range.deleted.flatMap(hunk => {
            const lines: LineRange[] = [];
            for (let line = hunk.start; line <= hunk.end; line++) {
              const base = sinceLineToBase(sincePath, line);
              if (base !== null) lines.push({ start: base, end: base });
            }
            return lines;
          }),
        ).flatMap(candidate => intersectRanges([candidate], inPullRequest.deleted));
    if (added.length === 0 && deleted.length === 0 && !deletedFile && !range.fileLevelEvidence && !inPullRequest.fileLevelEvidence) return;
    files.push({
      path: inPullRequest.path,
      ...(inPullRequest.previousPath ? { previousPath: inPullRequest.previousPath } : {}),
      added,
      deleted,
      deletedFile,
    });
  });
  if (forceFull) return full("requested by a maintainer with /aida full", files);
  return { mode: "incremental", since, reason: `lines of the PR diff changed since the review at ${since.slice(0, 8)}`, files };
}

// The lines and files the security and prompt-attack lenses cited, read from
// their structured outputs (the same evidence shapes as the final review). A
// finding that cites one of them is never deferred, whatever category the judge
// chose: the exemption rests on the full-head lenses' own evidence, not on a
// model-selected label. Quotes need no entry: metadata evidence is always in
// scope. Unreadable or absent lens output contributes nothing.
export interface SecurityCitations {
  lines: Set<string>;
  files: Set<string>;
}

export function securityCitations(lensDir: string, manifest?: ChangedFileManifest): SecurityCitations {
  const cited: SecurityCitations = { lines: new Set(), files: new Set() };
  for (const name of ["security.json", "prompt-injection.json"]) {
    const file = join(lensDir, name);
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).candidates)) continue;
    for (const candidate of (parsed as { candidates: unknown[] }).candidates) {
      const evidence = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>).evidence : undefined;
      if (!Array.isArray(evidence)) continue;
      for (const item of evidence) {
        if (!item || typeof item !== "object") continue;
        const { source, path, line, side } = item as Record<string, unknown>;
        if (typeof path !== "string" || path.length === 0) continue;
        // Provenance is never lost to a sloppy citation: an item that names a
        // changed file but not a valid changed line exempts the whole file
        // (over-inclusion is safe; deferring a security finding is not).
        const changed = manifest?.files.find(file => file.path === path || file.previousPath === path);
        if (manifest && !changed) continue;
        if (source === "DIFF" && Number.isSafeInteger(line) && Number(line) >= 1 && (side === "LEFT" || side === "RIGHT")) {
          if (!changed || isChangedLine(changed, { source: "DIFF", path, line: Number(line), side })) {
            cited.lines.add(`${path}:${line}:${side}`);
            continue;
          }
        }
        if (source === "DIFF" || source === "DIFF_FILE") cited.files.add(changed?.path ?? path);
      }
    }
  }
  return cited;
}

const NO_CITATIONS: SecurityCitations = { lines: new Set(), files: new Set() };

export function findingInScope(
  finding: Pick<Finding, "category" | "evidence">,
  scope: ReviewScope,
  securityCited: SecurityCitations = NO_CITATIONS,
): boolean {
  if (scope.mode === "full" || finding.category === "security") return true;
  const within = (line: number, ranges: LineRange[]): boolean => ranges.some(range => line >= range.start && line <= range.end);
  return finding.evidence.some(item => {
    switch (item.source) {
      case "PR_TITLE":
      case "PR_BODY":
        // Metadata may have changed since the last review; quotes stay in scope.
        return true;
      case "DIFF_FILE":
        return securityCited.files.has(item.path) || scope.files.some(entry => entry.path === item.path);
      case "DIFF": {
        if (securityCited.lines.has(`${item.path}:${item.line}:${item.side}`) || securityCited.files.has(item.path)) return true;
        if (item.side === "LEFT") {
          const file = scope.files.find(entry => (entry.previousPath ?? entry.path) === item.path);
          return file !== undefined && (file.deletedFile || within(item.line, file.deleted));
        }
        const file = scope.files.find(entry => entry.path === item.path);
        return file !== undefined && within(item.line, file.added);
      }
      default:
        return false;
    }
  });
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} characters`);
  }
  if (/\[AI-PR-|<!--|^\*\*P[0-3]:/m.test(value)) {
    throw new Error(`${field} contains reserved review syntax`);
  }
  return value.trim();
}

function nullableText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  return requiredText(value, field, maxLength);
}

function isChangedLine(file: ChangedFile, evidence: DiffEvidence): boolean {
  const expectedPath = evidence.side === "RIGHT" ? file.path : (file.previousPath ?? file.path);
  if (evidence.path !== expectedPath) return false;
  const ranges = evidence.side === "RIGHT" ? file.added : file.deleted;
  return ranges.some(range => evidence.line >= range.start && evidence.line <= range.end);
}

export function decisionInvariantError(
  findings: Finding[],
  assessment: StructuredReview["assessment"],
  decision: PullRequestDecision,
  retainedBlocking = 0,
): string | null {
  // Severity-only contract: the next action follows open P0/P1 findings and
  // nothing else. Readiness and risk (`assessment`) inform the maintainer.
  void assessment;
  const blocking = findings.some(
    finding => finding.priority === "P0" || finding.priority === "P1",
  );
  if (decision.action === "merge" && blocking) {
    return "decision maintainer/merge is invalid while P0 or P1 findings remain";
  }
  if (decision.action === "merge" && retainedBlocking > 0) {
    return "decision maintainer/merge is invalid while retained open blocking findings remain";
  }
  if (decision.action === "change" && !blocking && retainedBlocking === 0) {
    return "decision author/change requires an open P0 or P1 finding";
  }
  return null;
}

export function enforceDecision(review: StructuredReview): StructuredReview {
  const error = decisionInvariantError(
    review.findings,
    review.assessment,
    review.decision,
    review.ledger?.retained.filter(entry => entry.priority === "P0" || entry.priority === "P1").length ?? 0,
  );
  if (error) throw new Error(error);
  return review;
}

export function validateStructuredReview(
  raw: string,
  expectedBase: string,
  expectedHead: string,
  manifest: ChangedFileManifest,
  metadata: ReviewMetadata,
): StructuredReview {
  return enforceDecision(parseStructuredReview(raw, expectedBase, expectedHead, manifest, metadata));
}

// The published rationale must agree with the published action. When a
// derivation overrides the judge, its explanation leads and the judge's text is
// kept only as an explicitly superseded note.
function supersededRationale(explanation: string, judge: string): string {
  return `${explanation} Judge's note, superseded by finding severity: ${judge}`;
}

export function parseStructuredReview(
  raw: string,
  expectedBase: string,
  expectedHead: string,
  manifest: ChangedFileManifest,
  metadata: ReviewMetadata,
  scope?: ReviewScope,
  securityCited: SecurityCitations = NO_CITATIONS,
): StructuredReview {
  assertSha(expectedBase, "base");
  assertSha(expectedHead, "head");
  if (Buffer.byteLength(raw, "utf8") > MAX_REVIEW_BYTES) {
    throw new Error(`review exceeds ${MAX_REVIEW_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("review must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("review must be a JSON object");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.base !== expectedBase || candidate.head !== expectedHead) {
    throw new Error("review base/head does not match the immutable context");
  }
  if (manifest.base !== expectedBase || manifest.head !== expectedHead) {
    throw new Error("changed-file manifest does not match the immutable context");
  }

  if (
    !candidate.inspection ||
    typeof candidate.inspection !== "object" ||
    Array.isArray(candidate.inspection)
  ) {
    throw new Error("inspection must be an object");
  }
  const inspectionCandidate = candidate.inspection as Record<string, unknown>;
  if (inspectionCandidate.status !== "complete") {
    throw new Error("inspection did not complete");
  }
  const inspection: StructuredReview["inspection"] = {
    status: "complete",
    changedFiles: manifest.files.map(file => file.path),
  };

  if (!Array.isArray(candidate.validation) || candidate.validation.length === 0) {
    throw new Error("validation must be a non-empty string array");
  }
  const validation = candidate.validation.map((value, index) =>
    requiredText(value, `validation[${index}]`, 500),
  );
  if (
    !candidate.assessment ||
    typeof candidate.assessment !== "object" ||
    Array.isArray(candidate.assessment)
  ) {
    throw new Error("assessment must be an object");
  }
  const assessmentCandidate = candidate.assessment as Record<string, unknown>;
  const assessmentDimension = (
    name: "readiness" | "risk",
  ): StructuredReview["assessment"]["readiness"] => {
    const value = assessmentCandidate[name];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`assessment.${name} must be an object`);
    }
    const dimension = value as Record<string, unknown>;
    if (
      typeof dimension.score !== "number" ||
      !Number.isInteger(dimension.score) ||
      dimension.score < 1 ||
      dimension.score > 5
    ) {
      throw new Error(`assessment.${name}.score must be an integer from 1 through 5`);
    }
    return {
      score: dimension.score,
      rationale: requiredText(
        dimension.rationale,
        `assessment.${name}.rationale`,
        1000,
      ),
    };
  };
  const assessment = {
    readiness: assessmentDimension("readiness"),
    risk: assessmentDimension("risk"),
  };
  const userExperienceCandidate = record(candidate.userExperience, "userExperience");
  if (
    userExperienceCandidate.status !== "changed" &&
    userExperienceCandidate.status !== "no-user-visible-change" &&
    userExperienceCandidate.status !== "uncertain"
  ) {
    throw new Error("userExperience.status is invalid");
  }
  const userExperience: UserExperienceAssessment = {
    status: userExperienceCandidate.status,
    change: requiredText(userExperienceCandidate.change, "userExperience.change", 1500),
    before: nullableText(userExperienceCandidate.before, "userExperience.before", 1500),
    after: nullableText(userExperienceCandidate.after, "userExperience.after", 1500),
    example: nullableText(userExperienceCandidate.example, "userExperience.example", 2000),
    assessment: requiredText(
      userExperienceCandidate.assessment,
      "userExperience.assessment",
      1500,
    ),
  };
  if (
    userExperience.status === "changed" &&
    (userExperience.before === null || userExperience.after === null)
  ) {
    throw new Error("changed user experience requires before and after descriptions");
  }
  if (
    userExperience.status === "no-user-visible-change" &&
    (userExperience.before !== null ||
      userExperience.after !== null ||
      userExperience.example !== null)
  ) {
    throw new Error(
      "no-user-visible-change requires null before, after, and example fields",
    );
  }
  if (!Array.isArray(candidate.findings)) throw new Error("findings must be an array");

  let previousRank = -1;
  const findings = candidate.findings.map((value, index): Finding => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`findings[${index}] must be an object`);
    }
    const finding = value as Record<string, unknown>;
    if (!/^(P0|P1|P2|P3)$/.test(String(finding.priority))) {
      throw new Error(`findings[${index}].priority is invalid`);
    }
    const priority = finding.priority as Priority;
    const rank = Number(priority.slice(1));
    if (rank < previousRank) throw new Error("findings must be ordered from P0 through P3");
    previousRank = rank;
    const category = finding.category;
    if (
      typeof category !== "string" ||
      !FINDING_CATEGORIES.some(candidateCategory => candidateCategory.value === category)
    ) {
      throw new Error(`findings[${index}].category is invalid`);
    }

    if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
      throw new Error(`findings[${index}].evidence must be non-empty`);
    }
    const evidence = finding.evidence.map((item, evidenceIndex): FindingEvidence => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`findings[${index}].evidence[${evidenceIndex}] must be an object`);
      }
      const record = item as Record<string, unknown>;
      if (record.source === "PR_TITLE" || record.source === "PR_BODY") {
        const quote = typeof record.quote === "string" ? record.quote.trim() : "";
        if (quote.length === 0 || quote.length > 500) {
          throw new Error(
            `findings[${index}].evidence[${evidenceIndex}].quote must be 1-500 characters`,
          );
        }
        const sourceText = record.source === "PR_TITLE" ? metadata.title : metadata.body;
        if (!sourceText.includes(quote)) {
          throw new Error(`${record.source} evidence quote is not present in PR metadata`);
        }
        return { source: record.source, quote };
      }
      if (record.source === "DIFF_FILE") {
        const path = typeof record.path === "string" ? record.path : "";
        const changed = manifest.files.find(file => file.path === path);
        if (!changed?.fileLevelEvidence) {
          throw new Error(`file evidence ${path} is not a changed file without line hunks`);
        }
        return { source: "DIFF_FILE", path };
      }
      if (record.source !== "DIFF") {
        throw new Error(`findings[${index}].evidence[${evidenceIndex}].source is invalid`);
      }
      const path = typeof record.path === "string" ? record.path : "";
      const line = typeof record.line === "number" ? record.line : 0;
      const side = record.side;
      if ((side !== "LEFT" && side !== "RIGHT") || !Number.isInteger(line) || line < 1) {
        throw new Error(`findings[${index}].evidence[${evidenceIndex}] has invalid line or side`);
      }
      const changed = manifest.files.find(file => file.path === path || file.previousPath === path);
      if (!changed || !isChangedLine(changed, { source: "DIFF", path, line, side })) {
        throw new Error(`evidence ${path}:${line} (${side}) is not a changed line`);
      }
      return { source: "DIFF", path, line, side };
    });

    const title = requiredText(finding.title, `findings[${index}].title`, 160);
    if (/[\r\n]/.test(title)) throw new Error(`findings[${index}].title must be one line`);
    // The judge's explicit identification of an existing ledger entry (null or
    // absent when the finding is new). Validated as a shape here; the ledger
    // decides whether the id exists.
    let ledgerId: string | undefined;
    if (finding.ledgerId !== undefined && finding.ledgerId !== null) {
      if (typeof finding.ledgerId !== "string" || !/^F[1-9][0-9]*$/.test(finding.ledgerId)) {
        throw new Error(`findings[${index}].ledgerId must be a ledger id such as F3`);
      }
      ledgerId = finding.ledgerId;
    }
    return {
      priority,
      category: category as FindingCategory,
      title,
      ...(ledgerId ? { ledgerId } : {}),
      evidence,
      problem: requiredText(finding.problem, `findings[${index}].problem`, 3000),
      impact: requiredText(finding.impact, `findings[${index}].impact`, 1500),
      requiredCorrection: requiredText(
        finding.requiredCorrection,
        `findings[${index}].requiredCorrection`,
        2000,
      ),
    };
  });

  const decisionCandidate = record(candidate.decision, "decision");
  const rationale = requiredText(decisionCandidate.rationale, "decision.rationale", 1000);
  const validPair =
    (decisionCandidate.actor === "author" && decisionCandidate.action === "change") ||
    (decisionCandidate.actor === "maintainer" && decisionCandidate.action === "merge");
  if (!validPair) throw new Error("decision must be author/change or maintainer/merge");
  // The publisher derives the next action from finding severity; the judge's
  // rationale is kept, its actor/action pair is not trusted to decide.
  const derivedAction = deriveDecision(findings.filter(finding => finding.priority === "P0" || finding.priority === "P1").length);
  // When severity overrides the judge's pair, the judge's action-bearing text is
  // superseded, not merely annotated, so the published rationale never argues
  // against the published action.
  const decision: PullRequestDecision =
    derivedAction === "change"
      ? {
          actor: "author",
          action: "change",
          rationale:
            decisionCandidate.action === "merge"
              ? supersededRationale("A P0 or P1 finding survives, so the next action is the author's regardless of the assessment above.", rationale)
              : rationale,
        }
      : {
          actor: "maintainer",
          action: "merge",
          rationale:
            decisionCandidate.action === "change"
              ? supersededRationale("No P0 or P1 finding survives, so the next action is the maintainer's merge decision; readiness and risk above inform it.", rationale)
              : rationale,
        };

  // Dispositions of open ledger entries. A still-open disposition with an index
  // binds that finding to the ledger id (the judge does not have to carry ids
  // per finding); a contradiction (two ids on one finding, one id twice) is a
  // validation error.
  const dispositions: LedgerDisposition[] = [];
  if (candidate.ledger !== undefined) {
    if (!Array.isArray(candidate.ledger)) throw new Error("ledger must be an array of dispositions");
    const seenIds = new Set<string>();
    candidate.ledger.forEach((value, index) => {
      const entry = record(value, `ledger[${index}]`);
      const id = typeof entry.id === "string" && /^F[1-9][0-9]*$/.test(entry.id) ? entry.id : null;
      if (id === null) throw new Error(`ledger[${index}].id must be a ledger id such as F3`);
      if (seenIds.has(id)) throw new Error(`ledger[${index}] disposes of ${id} twice`);
      seenIds.add(id);
      if (entry.disposition !== "still-open" && entry.disposition !== "resolved") {
        throw new Error(`ledger[${index}].disposition must be still-open or resolved`);
      }
      let findingIndex: number | null = null;
      if (entry.findingIndex !== null && entry.findingIndex !== undefined) {
        if (!Number.isInteger(entry.findingIndex) || Number(entry.findingIndex) < 0 || Number(entry.findingIndex) >= findings.length) {
          throw new Error(`ledger[${index}].findingIndex must name an entry of findings`);
        }
        findingIndex = Number(entry.findingIndex);
        if (entry.disposition === "resolved") throw new Error(`ledger[${index}] resolves ${id} but also restates it`);
        const bound = findings[findingIndex];
        if (bound.ledgerId !== undefined && bound.ledgerId !== id) {
          throw new Error(`ledger[${index}] binds ${id} to findings[${findingIndex}], which already carries ${bound.ledgerId}`);
        }
        findings[findingIndex] = { ...bound, ledgerId: id };
      }
      dispositions.push({ id, disposition: entry.disposition, findingIndex });
    });
  }
  // Direct ids and disposition bindings must form one mapping: one finding per
  // id, no id both resolved and restated, no binding that disagrees with a
  // direct id.
  const carriers = new Map<string, number[]>();
  findings.forEach((finding, index) => {
    if (finding.ledgerId) carriers.set(finding.ledgerId, [...(carriers.get(finding.ledgerId) ?? []), index]);
  });
  for (const [id, indexes] of carriers) {
    if (indexes.length > 1) throw new Error(`findings ${indexes.join(" and ")} both carry ledgerId ${id}`);
    const disposition = dispositions.find(entry => entry.id === id);
    if (disposition?.disposition === "resolved") throw new Error(`ledger resolves ${id} but findings[${indexes[0]}] restates it`);
    if (disposition && disposition.findingIndex !== null && disposition.findingIndex !== indexes[0]) {
      throw new Error(`ledger binds ${id} to findings[${disposition.findingIndex}] but findings[${indexes[0]}] carries it`);
    }
  }

  const residualRisk = requiredText(candidate.residualRisk, "residualRisk", 1000);
  const review: StructuredReview = {
    base: expectedBase,
    head: expectedHead,
    inspection,
    validation,
    assessment,
    userExperience,
    decision,
    findings,
    residualRisk,
    dispositions,
  };
  if (!scope) return review;
  // Convergence by construction: in an incremental scope a non-security finding
  // that cites only lines unchanged since the last review is deferred — shown,
  // never decisive. The decision is re-derived under the same invariants when
  // the deferral leaves it without a valid reason.
  const kept = findings.filter(finding => findingInScope(finding, scope, securityCited));
  const deferred: DeferredFinding[] = findings
    .filter(finding => !findingInScope(finding, scope, securityCited))
    .map(finding => ({
      priority: finding.priority,
      category: finding.category,
      title: finding.title,
      paths: [...new Set(finding.evidence.flatMap(item => ("path" in item ? [item.path] : [])))],
    }));
  review.scope = scope;
  review.deferred = deferred;
  if (deferred.length > 0) {
    review.findings = kept;
    if (decisionInvariantError(kept, assessment, decision) !== null) {
      const derived = deriveDecision(kept.filter(finding => finding.priority === "P0" || finding.priority === "P1").length);
      const plural = deferred.length === 1 ? "" : "s";
      review.decision =
        derived === "merge"
          ? {
              actor: "maintainer",
              action: "merge",
              rationale: `${decision.rationale} Re-derived: ${deferred.length} finding${plural} outside the incremental review scope ${deferred.length === 1 ? "was" : "were"} deferred and no blocking finding remains.`,
            }
          : {
              actor: "author",
              action: "change",
              rationale: `${decision.rationale} Re-derived after deferring ${deferred.length} finding${plural} outside the incremental review scope.`,
            };
    }
  }
  return review;
}

export function findingAnchors(
  finding: Finding,
  contextDir: string,
  repoDir: string,
): LedgerAnchor[] {
  const anchors: LedgerAnchor[] = [];
  for (const item of finding.evidence) {
    if (item.source === "DIFF") {
      const lineText = readContextLine(contextDir, repoDir, item.path, item.line, item.side);
      anchors.push(
        lineText === null
          ? positionAnchor(item.path, item.line, item.side)
          : lineAnchor(item.path, item.side, lineText),
      );
    } else if (item.source === "DIFF_FILE") {
      anchors.push(fileAnchor(item.path, headFileSha256(contextDir, item.path) ?? "deleted"));
    } else {
      anchors.push(quoteAnchor(item.quote));
    }
  }
  return anchors;
}

// Applies maintainer decisions recorded in the ledger to a parsed review.
//
// Decision rules are the SAME invariants the validator already enforces; only
// their inputs change: rejected findings with unchanged evidence are removed,
// accepted ones are set aside, and open blockers the judge omitted but whose
// cited code is unchanged are RETAINED and keep the next action with the author.
// A removed finding that was the sole reason for `author/change` leaves that
// decision without a valid reason under the invariants, so the consistent
// outcome is `maintainer/merge`, and the rationale says so.
export function applyLedgerToReview(
  review: StructuredReview,
  loaded: LoadedLedger,
  contextDir: string,
  repoDir: string,
  at = new Date().toISOString(),
): { review: StructuredReview; ledger: LoadedLedger["ledger"] } {
  const presence = (anchor: LedgerAnchor): boolean | null => headContainsAnchor(contextDir, anchor, repoDir);
  const inputs = review.findings.map(finding => ({
    ...(finding.ledgerId ? { ledgerId: finding.ledgerId } : {}),
    priority: finding.priority,
    category: finding.category,
    title: finding.title,
    anchors: findingAnchors(finding, contextDir, repoDir),
    finding,
  }));
  // Explicit dispositions for entries not restated among the kept findings: a
  // resolved entry closes at this head; a still-open one stays verdict-bearing.
  // (A restatement deferred by the scope counts as still-open, unrestated.)
  // Every id the judge used must name an OPEN entry of the live ledger: a
  // decided, resolved, or unknown id is a validation error, never a new finding.
  const openIds = new Set(loaded.ledger.findings.filter(entry => entry.status === "open").map(entry => entry.id));
  for (const entry of review.dispositions ?? []) {
    if (!openIds.has(entry.id)) throw new Error(`ledger disposition names ${entry.id}, which is not an open ledger entry`);
  }
  // A direct ledgerId must name a ledger entry. Naming a decided one drops the
  // id (the finding is recorded as new; a decision is never reachable from
  // model output); naming an unknown one is a validation error.
  const knownIds = new Set([...loaded.ledger.findings, ...(loaded.ledger.archivedDecisions ?? [])].map(entry => entry.id));
  for (const input of inputs) {
    if (!input.ledgerId || openIds.has(input.ledgerId)) continue;
    if (!knownIds.has(input.ledgerId)) throw new Error(`finding "${input.title}" carries ledgerId ${input.ledgerId}, which is not a ledger entry`);
    delete input.ledgerId;
  }
  const restatedIds = new Set(inputs.flatMap(input => (input.ledgerId ? [input.ledgerId] : [])));
  const dispositions = new Map<string, "resolved" | "still-open">();
  for (const entry of review.dispositions ?? []) {
    if (restatedIds.has(entry.id)) continue;
    dispositions.set(entry.id, entry.disposition);
  }
  // Change evidence exists whenever a previous reviewed head is known; only a
  // first review has none (null = unknown, never evidence).
  const changedFiles =
    review.scope && review.scope.since !== null
      ? new Set(review.scope.files.flatMap(file => [file.path, ...(file.previousPath ? [file.previousPath] : [])]))
      : null;
  const result = reconcileLedger(loaded, inputs, review.head, at, presence, dispositions, changedFiles);
  // The ledger's effective priority wins: a restatement never lowers an open
  // finding's priority.
  // The ledger's effective priority (and the title that came with it, when a
  // duplicate raised the entry) wins over the restatement's own.
  const kept = result.kept.map(entry => ({ ...entry.finding, priority: entry.priority, title: entry.title, ledgerId: entry.ledgerId }));
  // Every retained entry is rendered; only blocking ones bear on the verdict.
  const retained = result.retained;
  const retainedBlocking = retained.filter(entry => isBlocking(entry.priority));
  const accepted = acceptedRisks(result.ledger, presence);
  const removed = result.restatedAccepted.length + result.suppressed.length;
  let decision = review.decision;
  let decisionAdjusted = false;
  // The action is always re-derived from EFFECTIVE state after reconciliation:
  // kept findings at the ledger's priority (a P1 restated as P2 is still a P1)
  // plus retained blockers. Same one-line rule a later /aida command applies.
  const keptBlocking = kept.filter(finding => isBlocking(finding.priority));
  const derived = deriveDecision(retainedBlocking.length + keptBlocking.length);
  if (derived !== review.decision.action) {
    decisionAdjusted = true;
    if (derived === "change") {
      const causes: string[] = [];
      if (retainedBlocking.length > 0) {
        causes.push(
          `${retainedBlocking.length} open blocking finding${retainedBlocking.length === 1 ? "" : "s"} (${retainedBlocking.map(entry => entry.id).join(", ")}) ${
            retainedBlocking.length === 1 ? "was" : "were"
          } not restated this run and the cited code is unchanged`,
        );
      }
      const raised = keptBlocking.filter(finding => finding.ledgerId && review.findings.every(original => original.title !== finding.title || !isBlocking(original.priority)));
      if (raised.length > 0) {
        causes.push(`${raised.map(finding => finding.ledgerId).join(", ")} ${raised.length === 1 ? "keeps" : "keep"} the ledger's blocking priority`);
      }
      decision = {
        actor: "author",
        action: "change",
        rationale: supersededRationale(
          `Re-derived from the ledger: ${causes.length > 0 ? causes.join("; ") : "an open blocking finding remains"}, so the author still needs to act.`,
          review.decision.rationale,
        ),
      };
    } else {
      decision = {
        actor: "maintainer",
        action: "merge",
        rationale: supersededRationale(
          `Re-derived after applying ${removed} maintainer ledger decision${removed === 1 ? "" : "s"}: no blocking finding remains.`,
          review.decision.rationale,
        ),
      };
    }
  }
  // A full review requested with /aida full is consumed by the review that used it.
  if (review.scope?.mode === "full" && review.scope.reason.startsWith("requested by a maintainer")) {
    delete result.ledger.nextReview;
  }
  // Persist this head's verdict so a later /aida command re-derives the decision
  // under the same invariants without rerunning models.
  result.ledger.review = {
    head: review.head,
    readiness: review.assessment.readiness.score,
    risk: review.assessment.risk.score,
    decision: decision.action,
  };
  const adjusted: StructuredReview = {
    ...review,
    findings: kept,
    decision,
    ledger: {
      accepted,
      retained,
      suppressed: result.suppressed.length,
      reopened: result.reopenedIds.length,
      resolvedIds: result.resolvedIds,
      open: result.ledger.findings.filter(entry => entry.status === "open").length,
      migrated: loaded.migrated,
      decisionAdjusted,
      resolvedByJudge: result.resolvedByJudgeIds,
      undisposed: result.undisposedIds,
      unverifiedResolutions: result.unverifiedResolutionIds,
    },
  };
  return { review: enforceDecision(adjusted), ledger: result.ledger };
}

function escapeWorkflowCommand(value: string): string {
  let escaped = "";
  for (const character of value) {
    if (character === "%") escaped += "%25";
    else if (character === "\r") escaped += "%0D";
    else if (character === "\n") escaped += "%0A";
    else {
      const code = character.charCodeAt(0);
      if (code >= 32 && code !== 127) escaped += character;
    }
  }
  return escaped;
}

function truncateCodePoints(value: string, maxLength: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= maxLength ? value : `${codePoints.slice(0, maxLength - 1).join("")}…`;
}

export function rejectedReviewDiagnostics(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ["::error::ai-pr-review final response is not a JSON object"];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["::error::ai-pr-review final response is not a JSON object"];
  }
  const candidate = parsed as Record<string, unknown>;
  const lines: string[] = [];
  const append = (field: string, value: string, maxLength: number): void => {
    const bounded = truncateCodePoints(value, maxLength);
    lines.push(`::error::ai-pr-review ${field}: ${escapeWorkflowCommand(bounded)}`);
  };
  const inspection = candidate.inspection;
  const status = inspection && typeof inspection === "object" && !Array.isArray(inspection)
    ? (inspection as Record<string, unknown>).status
    : undefined;
  append("inspection.status", typeof status === "string" ? status : "<non-string>", 32);
  if (Array.isArray(candidate.validation)) {
    for (let index = 0; index < Math.min(candidate.validation.length, 8); index++) {
      const value = candidate.validation[index];
      if (typeof value === "string") append(`validation[${index}]`, value, 300);
    }
  }
  if (typeof candidate.residualRisk === "string") {
    append("residualRisk", candidate.residualRisk, 300);
  }
  return lines;
}

function markdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]()#!|])/g, "\\$1");
}

function codeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderReview(review: StructuredReview, contextId: string): ReviewPayload {
  if (!/^[0-9a-f]{64}$/.test(contextId)) {
    throw new Error("context id must be a lowercase SHA-256 digest");
  }
  const lines = [
    `<!-- ai-pr-review context=${contextId} -->`,
    `${AI_REVIEW_DECISION_MARKER}${review.decision.actor}/${review.decision.action} -->`,
    `Reviewed \`${review.head}\` against \`${review.base}\` and current repository behavior.`,
    "",
    `Inspection: ${review.inspection.changedFiles.length} changed ${
      review.inspection.changedFiles.length === 1 ? "file" : "files"
    }.${
      review.scope
        ? review.scope.mode === "incremental"
          ? ` Scope: **incremental** — ${review.scope.files.length} file${review.scope.files.length === 1 ? "" : "s"} with lines changed since the review at \`${(review.scope.since ?? "").slice(0, 8)}\`; the security lenses reviewed the full head. Findings on lines unchanged since that review are deferred, not decisive.`
          : ` Scope: **full head** (${markdownText(review.scope.reason)}).`
        : ""
    }`,
    "",
    "## Final Assessment",
    "",
    "Human decision aid only: **Readiness 5/5 is best; Risk 1/5 is best.** These scores inform the maintainer; the next action below follows finding severity (any open P0/P1 → author/change) and does not approve or merge the PR.",
    "",
    `Readiness: **${review.assessment.readiness.score}/5** — ${
      markdownText(review.assessment.readiness.rationale)
    }`,
    "",
    `Risk: **${review.assessment.risk.score}/5** — ${
      markdownText(review.assessment.risk.rationale)
    }`,
    "",
    `Decision required: **${
      review.decision.action === "change"
        ? "Author — make changes before this PR proceeds."
        : "Maintainer — decide whether to merge this PR."
    }** ${markdownText(review.decision.rationale)}`,
    "",
    "Validation performed:",
    ...review.validation.map(item => `- ${markdownText(item)}`),
  ];
  const appendFinding = (finding: Finding): void => {
    lines.push(
      "",
      `**${finding.priority}${finding.ledgerId ? ` [${finding.ledgerId}]` : ""}: ${markdownText(finding.title)}**`,
      "",
      `Evidence: ${finding.evidence
        .map(item => {
          if (item.source === "DIFF") {
            return `<code>${codeText(item.path)}:${item.line}</code>${
              item.side === "LEFT" ? " (deleted line)" : ""
            }`;
          }
          if (item.source === "DIFF_FILE") {
            return `<code>${codeText(item.path)}</code> (file-level change)`;
          }
          const label = item.source === "PR_TITLE" ? "PR title" : "PR body";
          return `${label}: “${markdownText(item.quote)}”`;
        })
        .join(", ")}.`,
      "",
      `Problem: ${markdownText(finding.problem)}`,
      "",
      `Impact: ${markdownText(finding.impact)}`,
      "",
      `Required correction: ${markdownText(finding.requiredCorrection)}`,
    );
  };
  const blocking = review.findings.filter(
    finding => finding.priority === "P0" || finding.priority === "P1",
  ).length;
  const advisory = review.findings.length - blocking;
  lines.push(
    "",
    `Findings: ${blocking} blocking, ${advisory} advisory.`,
  );
  if (review.ledger) {
    const summary = review.ledger;
    lines.push(
      "",
      `Ledger: ${summary.open} open, ${summary.retained.filter(entry => entry.priority === "P0" || entry.priority === "P1").length} retained blocking${
        summary.retained.some(entry => entry.priority !== "P0" && entry.priority !== "P1")
          ? `, ${summary.retained.filter(entry => entry.priority !== "P0" && entry.priority !== "P1").length} retained advisory`
          : ""
      }, ${summary.accepted.length} accepted, ${summary.suppressed} suppressed as rejected by a maintainer${
        summary.reopened > 0 ? `, ${summary.reopened} reopened on new evidence` : ""
      }${summary.resolvedIds.length > 0 ? `, resolved ${summary.resolvedIds.join(", ")}` : ""}${
        summary.resolvedByJudge.length > 0 ? ` (${summary.resolvedByJudge.join(", ")} declared corrected by the judge)` : ""
      }${summary.undisposed.length > 0 ? `; ${summary.undisposed.length} open entr${summary.undisposed.length === 1 ? "y" : "ies"} left undisposed by the judge (${summary.undisposed.join(", ")})` : ""}${
        summary.unverifiedResolutions.length > 0
          ? `; the judge declared ${summary.unverifiedResolutions.join(", ")} corrected but the cited code and files are unchanged, so ${summary.unverifiedResolutions.length === 1 ? "it stays" : "they stay"} retained until a maintainer accepts`
          : ""
      }.${
        summary.decisionAdjusted ? " The next decision was re-derived from the ledger." : ""
      }${
        summary.migrated ? " The ledger was migrated from schema v1; earlier decisions were reset." : ""
      } Maintainers act on findings with \`/aida\` commands in the ledger comment.`,
    );
  }
  if (review.findings.length === 0) lines.push("", "No findings.");
  const populatedCategories = FINDING_CATEGORIES
    .map((category, categoryOrder) => ({
      ...category,
      categoryOrder,
      findings: review.findings.filter(finding => finding.category === category.value),
    }))
    .filter(category =>
      category.value === "user-experience" || category.findings.length > 0
    )
    .sort((left, right) => {
      const leftRank = left.findings.length > 0
        ? Number(left.findings[0].priority.slice(1))
        : 4;
      const rightRank = right.findings.length > 0
        ? Number(right.findings[0].priority.slice(1))
        : 4;
      return leftRank - rightRank || left.categoryOrder - right.categoryOrder;
    });
  for (const category of populatedCategories) {
    lines.push("", `## ${category.heading}`);
    if (category.value === "user-experience") {
      lines.push(
        "",
        `**User experience change:** ${markdownText(review.userExperience.change)}`,
      );
      if (review.userExperience.before !== null) {
        lines.push("", `**Before:** ${markdownText(review.userExperience.before)}`);
      }
      if (review.userExperience.after !== null) {
        lines.push("", `**After:** ${markdownText(review.userExperience.after)}`);
      }
      if (review.userExperience.example !== null) {
        lines.push("", `**Example:** ${markdownText(review.userExperience.example)}`);
      }
      lines.push("", `**Assessment:** ${markdownText(review.userExperience.assessment)}`);
    }
    for (const finding of category.findings) {
      appendFinding(finding);
    }
  }
  const retainedBlockingEntries = review.ledger?.retained.filter(entry => entry.priority === "P0" || entry.priority === "P1") ?? [];
  const retainedAdvisoryEntries = review.ledger?.retained.filter(entry => entry.priority !== "P0" && entry.priority !== "P1") ?? [];
  if (retainedAdvisoryEntries.length > 0) {
    lines.push("", "## Retained advisory findings", "", "Open P2/P3 findings from the ledger that the judge marked still open without restating them. They do not affect the decision.");
    for (const entry of retainedAdvisoryEntries) {
      lines.push("", `**${entry.priority} [${entry.id}]: ${markdownText(entry.title)}** — first reported at \`${entry.firstSeen.head.slice(0, 8)}\`.`);
    }
  }
  if (retainedBlockingEntries.length > 0) {
    lines.push(
      "",
      "## Retained blocking findings",
      "",
      "Open P0/P1 findings from the ledger that this review did not restate and whose cited code is unchanged. They keep the next action with the author until the code changes or a maintainer accepts them.",
    );
    for (const entry of retainedBlockingEntries) {
      const paths = [...new Set(entry.anchors.map(anchor => anchor.path).filter((path): path is string => Boolean(path)))];
      lines.push(
        "",
        `**${entry.priority} [${entry.id}]: ${markdownText(entry.title)}** — first reported at \`${entry.firstSeen.head.slice(0, 8)}\`${
          paths.length > 0 ? `; cited: ${paths.map(path => `<code>${codeText(path)}</code>`).join(", ")}` : ""
        }.`,
      );
    }
  }
  if (review.deferred && review.deferred.length > 0) {
    lines.push(
      "",
      "## Deferred (outside the review scope)",
      "",
      `Reported by the judge but citing only lines unchanged since the review at \`${(review.scope?.since ?? "").slice(0, 8)}\`. They do not affect the decision; comment \`/aida full\` to have the next review cover the whole head.`,
    );
    for (const entry of review.deferred) {
      lines.push(
        "",
        `**${entry.priority} · ${entry.category}: ${markdownText(entry.title)}**${
          entry.paths.length > 0 ? ` — ${entry.paths.map(path => `<code>${codeText(path)}</code>`).join(", ")}` : ""
        }`,
      );
    }
  }
  if (review.ledger && review.ledger.accepted.length > 0) {
    lines.push("", "## Accepted risks");
    for (const entry of review.ledger.accepted) {
      const decision = entry.decision;
      lines.push(
        "",
        `**${entry.priority} [${entry.id}]: ${markdownText(entry.title)}** — accepted by @${
          markdownText(decision?.by ?? "unknown")
        } on ${markdownText((decision?.at ?? "").slice(0, 10))}: ${markdownText(decision?.reason ?? "")}`,
      );
    }
  }
  lines.push(
    "",
    `Residual risk: ${markdownText(review.residualRisk)}`,
    "",
    "Reviewed by AIDA (AI-DLC Developer Agent).",
    "",
    `[AI-PR-REVIEWED] ${review.head}`,
  );
  const retainedBlocking = (review.ledger?.retained.some(entry => entry.priority === "P0" || entry.priority === "P1")) ?? false;
  const event = retainedBlocking ||
      review.findings.some(item => item.priority === "P0" || item.priority === "P1")
    ? "REQUEST_CHANGES"
    : "COMMENT";
  return { commit_id: review.head, body: lines.join("\n"), event };
}

let lastValidateInput: string | null = null;

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build-discussion") {
    buildDiscussion(
      argValue(args, "--repo"),
      Number(argValue(args, "--pr")),
      argValue(args, "--head"),
      argValue(args, "--output"),
      argValue(args, "--current-ai-output"),
      args.includes("--identity-output") ? argValue(args, "--identity-output") : undefined,
    );
    return;
  }
  if (command === "build-context") {
    buildContext(
      argValue(args, "--base"),
      argValue(args, "--head"),
      argValue(args, "--output"),
    );
    return;
  }
  if (command === "build-scope") {
    const manifest = JSON.parse(readFileSync(argValue(args, "--manifest"), "utf8")) as ChangedFileManifest;
    const ledgerFile = readLedgerFile(argValue(args, "--ledger"));
    const scope = buildScope(
      argValue(args, "--head"),
      manifest,
      ledgerFile.ledger.review?.head ?? null,
      ledgerFile.ledger.nextReview?.scope === "full",
      args.includes("--repo-dir") ? argValue(args, "--repo-dir") : process.cwd(),
    );
    writeFileSync(argValue(args, "--output"), `${JSON.stringify(scope, null, 2)}\n`);
    process.stdout.write(`${scope.mode}: ${scope.reason}${scope.mode === "incremental" ? ` (${scope.files.length} files)` : ""}\n`);
    return;
  }
  if (command === "validate") {
    const base = argValue(args, "--base");
    const head = argValue(args, "--head");
    const contextId = argValue(args, "--context-id");
    const input = argValue(args, "--input");
    const manifestPath = argValue(args, "--manifest");
    const metadataPath = argValue(args, "--metadata");
    const output = argValue(args, "--output");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ChangedFileManifest;
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as ReviewMetadata;
    lastValidateInput = readFileSync(input, "utf8");
    const scope = args.includes("--scope")
      ? (JSON.parse(readFileSync(argValue(args, "--scope"), "utf8")) as ReviewScope)
      : undefined;
    const securityCited = args.includes("--lens-dir") ? securityCitations(argValue(args, "--lens-dir"), manifest) : NO_CITATIONS;
    let review: StructuredReview;
    if (args.includes("--ledger")) {
      const ledgerFile = readLedgerFile(argValue(args, "--ledger"));
      const loaded: LoadedLedger = {
        ledger: ledgerFile.ledger,
        commentId: null,
        digest: ledgerFile.expectedDigest,
        migrated: ledgerFile.migrated,
      };
      const applied = applyLedgerToReview(
        parseStructuredReview(lastValidateInput, base, head, manifest, metadata, scope, securityCited),
        loaded,
        argValue(args, "--context-dir"),
        args.includes("--repo-dir") ? argValue(args, "--repo-dir") : process.cwd(),
      );
      review = applied.review;
      if (args.includes("--ledger-output")) {
        // Transport fields ride along: the migration note and the live digest for
        // the publish-time compare-and-swap.
        writeLedgerFile(argValue(args, "--ledger-output"), applied.ledger, loaded.migrated, loaded.digest);
      }
    } else {
      review = enforceDecision(parseStructuredReview(lastValidateInput, base, head, manifest, metadata, scope, securityCited));
    }
    const payload = renderReview(review, contextId);
    writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
    if (args.includes("--decision-output")) {
      writeFileSync(
        argValue(args, "--decision-output"),
        `${JSON.stringify(review.decision, null, 2)}\n`,
      );
    }
    process.stdout.write(`${payload.event}\n`);
    return;
  }
  if (command === "labels") {
    const expectedHead = args.includes("--expected-head")
      ? argValue(args, "--expected-head")
      : undefined;
    const outcome = argValue(args, "--outcome");
    if (
      outcome !== "started" &&
      outcome !== "reviewed-change" &&
      outcome !== "reviewed-merge" &&
      outcome !== "review-error"
    ) {
      throw new Error("label outcome is invalid");
    }
    const applied = reconcileReviewLabels(
      argValue(args, "--repo"),
      Number(argValue(args, "--pr")),
      outcome,
      expectedHead,
    );
    process.stdout.write(applied ? "applied\n" : "stale\n");
    return;
  }
  if (command === "refresh-verdict") {
    const decision = argValue(args, "--decision");
    if (decision !== "merge" && decision !== "change") throw new Error("decision must be merge or change");
    process.stdout.write(`${refreshVerdict(
      argValue(args, "--repo"),
      Number(argValue(args, "--pr")),
      argValue(args, "--head"),
      decision,
      args.includes("--reason") ? argValue(args, "--reason") : "maintainer decision",
    )}\n`);
    return;
  }
  if (command === "converge-verdict") {
    process.stdout.write(`${convergeLedgerVerdict(
      argValue(args, "--repo"),
      Number(argValue(args, "--pr")),
      argValue(args, "--head"),
      args.includes("--reason") ? argValue(args, "--reason") : "maintainer decision",
    )}\n`);
    return;
  }
  if (command === "label-state") {
    const expectedHead = args.includes("--expected-head")
      ? argValue(args, "--expected-head")
      : undefined;
    process.stdout.write(`${currentReviewLabelOutcome(
      argValue(args, "--repo"),
      Number(argValue(args, "--pr")),
      expectedHead,
    )}\n`);
    return;
  }
  throw new Error(
    "usage: ai-pr-review.ts build-discussion|build-context|build-scope|validate|label-state|labels|refresh-verdict|converge-verdict (run with --help in repository docs)",
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    // Validator messages interpolate model-controlled evidence paths. The runner's
    // legacy ##[cmd] parser matches anywhere in an unframed line, so the leading error
    // must be a framed V2 command with escaped data, like the diagnostics.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::ai-pr-review ${escapeWorkflowCommand(truncateCodePoints(message, 1000))}\n`);
    if (lastValidateInput !== null) {
      for (const line of rejectedReviewDiagnostics(lastValidateInput)) {
        process.stderr.write(`${line}\n`);
      }
    }
    process.exit(1);
  }
}
