// aidlc-pr.ts - deterministic GitHub PR integration for Construction.
//
// The tool is deliberately observe-only with respect to settlement: it never
// merges a PR and never enables auto-merge. Outward writes used to publish a
// branch, create/update a PR, request human reviewers, or retarget a stacked
// child are disabled unless --execute is present. Every gh call is bounded by
// the external `timeout 10` wrapper because gh has no request-timeout setting.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntries, type AuditEntryInput } from "./aidlc-audit.ts";
import { artifactFilename } from "./aidlc-artifact-vocabulary.ts";
import {
  auditBlockField,
  claimAttemptFields,
  errorMessage,
  findAllEvents,
  getField,
  latestMainWorkflowStageRunFloorForProject,
  loadStageGraphAll,
  readAllAuditShards,
  readStateFile,
  recordDir,
  resolveProjectDir,
  reviewArtifactEntries,
  slugify,
  worktreePath,
} from "./aidlc-lib.ts";

const GH_TIMEOUT_SECONDS = 10;
const DEFAULT_STAGE = "pr-integration";
const DEFAULT_TEMPLATE = "## Summary\n\n## Testing\n\n## Risks\n";
const CORE_DOSSIER_ORDER = [
  "requirements",
  "unit-of-work",
  "functional-spec",
  "architecture-decisions",
  "code-review",
  "code-summary",
  "traceability",
  "build-test-results",
];
const OFFLINE_PATTERN =
  /dial tcp|proxyconnect|no such host|connection refused|i\/o timeout|could not resolve host|network is unreachable/i;

export interface PullReview {
  id: number | string;
  user?: { login?: string; type?: string } | string;
  author?: { login?: string } | string;
  state: string;
  submitted_at?: string;
  submittedAt?: string;
  commit_id?: string | null;
  commit?: { oid?: string | null } | null;
  body?: string;
}

export interface ReviewDismissal {
  event?: string;
  created_at?: string;
  actor?: { login?: string } | string;
  dismissed_review?: {
    review_id?: number | string;
    state?: string;
    dismissal_message?: string;
  };
}

export interface ReviewerVerdict {
  reviewer: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
  reviewId: string;
  submittedAt: string;
  commitId: string | null;
  stale: boolean;
  dismissedOriginalState?: string;
}

export interface PullSnapshot {
  repo: string;
  number: number;
  url: string;
  state: string;
  merged?: boolean;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string | null } | string | null;
  mergedBy?: { login?: string } | string | null;
  closedAt?: string | null;
  reviewDecision?: string | null;
  reviewRequests?: unknown[];
  isDraft?: boolean;
  mergeStateStatus?: string | null;
  mergeable?: string | boolean | null;
  headRefOid?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
  body?: string;
  reviews?: PullReview[];
  timeline?: ReviewDismissal[];
  reviewComments?: Array<Record<string, unknown>>;
  issueComments?: Array<Record<string, unknown>>;
}

export type PullVerdict =
  | "MERGED"
  | "CLOSED"
  | "CHANGES_REQUESTED"
  | "WAITING_FOR_REVIEW"
  | "STALE_APPROVAL"
  | "APPROVED"
  | "DRAFT"
  | "REVIEW_REQUIRED";

export interface PullEvaluation {
  repo: string;
  number: number;
  url: string;
  verdict: PullVerdict;
  mergeability: "unknown" | "conflicting" | "blocked" | "clean";
  reviewers: ReviewerVerdict[];
  requestedReviewers: string[];
  mergedAt: string | null;
  mergeCommit: string | null;
  mergedBy: string | null;
}

export interface DetectionInput {
  repo: string;
  branch?: string;
  repository?: Record<string, unknown>;
  rules?: unknown[];
  branchInfo?: Record<string, unknown>;
  classicProtection?: Record<string, unknown> | null;
  classicError?: string | null;
  codeowners?: { path: string; content: string } | null;
  protectionUnavailable?: boolean;
  observedBranches?: string[];
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export class GitHubOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubOfflineError";
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const booleanNames = new Set(["execute", "refresh", "emit-feedback"]);
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (booleanNames.has(key)) {
      booleans.add(key);
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${value} expects a value`);
    }
    const current = flags.get(key) ?? [];
    current.push(next);
    flags.set(key, current);
    index++;
  }
  return { positional, flags, booleans };
}

function one(args: ParsedArgs, key: string): string | undefined {
  return args.flags.get(key)?.at(-1);
}

function many(args: ParsedArgs, key: string): string[] {
  return args.flags.get(key) ?? [];
}

function required(args: ParsedArgs, key: string): string {
  const value = one(args, key);
  if (!value) throw new Error(`Missing --${key} <value>`);
  return value;
}

function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function actorLogin(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const login = (value as { login?: unknown }).login;
    if (typeof login === "string") return login;
  }
  return "unknown";
}

function reviewTimestamp(review: PullReview): string {
  return review.submitted_at ?? review.submittedAt ?? "";
}

function reviewCommit(review: PullReview): string | null {
  return review.commit_id ?? review.commit?.oid ?? null;
}

function reviewActor(review: PullReview): string {
  return actorLogin(review.user ?? review.author);
}

function dismissalMap(
  timeline: readonly ReviewDismissal[],
): Map<string, ReviewDismissal> {
  const out = new Map<string, ReviewDismissal>();
  for (const event of timeline) {
    if (event.event !== "review_dismissed") continue;
    const id = event.dismissed_review?.review_id;
    if (id !== undefined) out.set(String(id), event);
  }
  return out;
}

export function foldReviewHistory(
  reviews: readonly PullReview[],
  timeline: readonly ReviewDismissal[] = [],
  headRefOid: string | null = null,
): ReviewerVerdict[] {
  const dismissals = dismissalMap(timeline);
  const ordered = [...reviews].sort((left, right) => {
    const a = reviewTimestamp(left);
    const b = reviewTimestamp(right);
    if (a !== b) return a < b ? -1 : 1;
    return String(left.id).localeCompare(String(right.id));
  });
  const latest = new Map<string, ReviewerVerdict>();
  for (const review of ordered) {
    const state = review.state.toUpperCase();
    if (state === "COMMENTED" || state === "PENDING") continue;
    if (
      state !== "APPROVED" &&
      state !== "CHANGES_REQUESTED" &&
      state !== "DISMISSED"
    ) {
      continue;
    }
    const reviewer = reviewActor(review);
    const commitId = reviewCommit(review);
    const dismissal = dismissals.get(String(review.id));
    latest.set(reviewer, {
      reviewer,
      state,
      reviewId: String(review.id),
      submittedAt: reviewTimestamp(review),
      commitId,
      stale:
        state === "APPROVED" &&
        headRefOid !== null &&
        commitId !== null &&
        commitId !== headRefOid,
      ...(dismissal?.dismissed_review?.state
        ? { dismissedOriginalState: dismissal.dismissed_review.state.toUpperCase() }
        : {}),
    });
  }
  return [...latest.values()].sort((a, b) =>
    a.reviewer.localeCompare(b.reviewer)
  );
}

function requestedReviewerNames(requests: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const request of requests) {
    if (typeof request === "string") {
      names.add(request);
      continue;
    }
    if (!request || typeof request !== "object") continue;
    const row = request as Record<string, unknown>;
    for (const key of ["login", "slug", "name"]) {
      if (typeof row[key] === "string") {
        names.add(row[key] as string);
        break;
      }
    }
  }
  return [...names].sort();
}

function mergeCommitOid(snapshot: PullSnapshot): string | null {
  if (typeof snapshot.mergeCommit === "string") return snapshot.mergeCommit;
  return snapshot.mergeCommit?.oid ?? null;
}

function mergedByLogin(snapshot: PullSnapshot): string | null {
  if (typeof snapshot.mergedBy === "string") return snapshot.mergedBy;
  return snapshot.mergedBy?.login ?? null;
}

export function evaluatePullSnapshot(snapshot: PullSnapshot): PullEvaluation {
  const state = snapshot.state.toUpperCase();
  const merged = state === "MERGED" || snapshot.merged === true;
  const reviewers = foldReviewHistory(
    snapshot.reviews ?? [],
    snapshot.timeline ?? [],
    snapshot.headRefOid ?? null,
  );
  const requestedReviewers = requestedReviewerNames(
    snapshot.reviewRequests ?? [],
  );
  const mergeState = (snapshot.mergeStateStatus ?? "").toUpperCase();
  const mergeable =
    typeof snapshot.mergeable === "string"
      ? snapshot.mergeable.toUpperCase()
      : snapshot.mergeable;
  const mergeability: PullEvaluation["mergeability"] =
    mergeState === "UNKNOWN" || mergeable === null
      ? "unknown"
      : mergeState === "DIRTY" || mergeable === "CONFLICTING" || mergeable === false
        ? "conflicting"
        : mergeState === "BLOCKED"
          ? "blocked"
          : "clean";

  let verdict: PullVerdict;
  // Terminal state is intentionally first: merged PRs can retain or receive a
  // CHANGES_REQUESTED aggregate after settlement.
  if (merged) {
    verdict = "MERGED";
  } else if (state === "CLOSED") {
    verdict = "CLOSED";
  } else if (snapshot.isDraft === true) {
    verdict = "DRAFT";
  } else if (reviewers.some((review) => review.state === "CHANGES_REQUESTED")) {
    verdict = "CHANGES_REQUESTED";
  } else if (requestedReviewers.length > 0) {
    verdict = "WAITING_FOR_REVIEW";
  } else if (reviewers.some((review) => review.state === "APPROVED" && review.stale)) {
    verdict = "STALE_APPROVAL";
  } else if (
    reviewers.some((review) => review.state === "APPROVED") ||
    snapshot.reviewDecision === "APPROVED"
  ) {
    verdict = "APPROVED";
  } else {
    verdict = "REVIEW_REQUIRED";
  }

  return {
    repo: snapshot.repo,
    number: snapshot.number,
    url: snapshot.url,
    verdict,
    mergeability,
    reviewers,
    requestedReviewers,
    mergedAt: snapshot.mergedAt ?? null,
    mergeCommit: mergeCommitOid(snapshot),
    mergedBy: mergedByLogin(snapshot),
  };
}

export function evaluateCoordinatedPulls(
  pulls: readonly PullEvaluation[],
): {
  state: "merged" | "partial" | "waiting" | "halt-and-ask";
  merged: string[];
  outstanding: string[];
  message: string;
} {
  const merged = pulls
    .filter((pull) => pull.verdict === "MERGED")
    .map((pull) => pull.url);
  const outstanding = pulls
    .filter((pull) => pull.verdict !== "MERGED")
    .map((pull) => `${pull.url} (${pull.verdict})`);
  const terminalProblem = pulls.some(
    (pull) =>
      pull.verdict === "CLOSED" || pull.verdict === "CHANGES_REQUESTED",
  );
  if (merged.length === pulls.length) {
    return {
      state: "merged",
      merged,
      outstanding: [],
      message: "All coordinated PRs are merged.",
    };
  }
  if (merged.length > 0 && terminalProblem) {
    return {
      state: "halt-and-ask",
      merged,
      outstanding,
      message:
        `Integration is partially irreversible: already merged siblings: ${merged.join(", ")}; ` +
        `blocked siblings: ${outstanding.join(", ")}. Reopen and revise, create a replacement PR, or abandon the remaining unit explicitly.`,
    };
  }
  if (merged.length > 0) {
    return {
      state: "partial",
      merged,
      outstanding,
      message: `Some coordinated PRs are merged; waiting on ${outstanding.join(", ")}.`,
    };
  }
  return {
    state: "waiting",
    merged,
    outstanding,
    message: `Waiting on ${outstanding.join(", ")}.`,
  };
}

export function stackingEligibility(input: {
  strategy: string;
  deleteBranchOnMerge: boolean;
}): { allowed: boolean; reason: string | null; recovery: string } {
  const strategy = input.strategy.toLowerCase();
  if (strategy !== "merge" && strategy !== "rebase") {
    return {
      allowed: false,
      reason: `stacking requires ancestry-preserving merge or rebase; received ${input.strategy}`,
      recovery:
        "Wait for the parent to merge, then branch from the updated target. If a child already carries phantom parent commits, rebase --onto the merged target before review.",
    };
  }
  if (input.deleteBranchOnMerge) {
    return {
      allowed: false,
      reason: "stacking is disabled because deleteBranchOnMerge can close children before retargeting",
      recovery:
        "Wait for the parent to merge. If a child was closed, restore the parent ref at its old SHA, reopen the child, retarget it, then remove the restored ref.",
    };
  }
  return {
    allowed: true,
    reason: null,
    recovery:
      "Retarget every child to the parent's base before deleting the parent branch. Recovery: restore ref, reopen, retarget.",
  };
}

function rulesetPullRequests(rules: readonly unknown[]): Record<string, unknown>[] {
  return rules
    .filter((rule): rule is Record<string, unknown> =>
      !!rule && typeof rule === "object"
    )
    .filter((rule) => rule.type === "pull_request");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

export function inferBranchPattern(branches: readonly string[]): string {
  const candidates = branches.filter(
    (branch) =>
      branch !== "main" &&
      branch !== "master" &&
      branch !== "develop" &&
      branch !== "development",
  );
  const ticketed = candidates
    .map((branch) =>
      /^([^/]+)\/([A-Z][A-Z0-9]+-[0-9]+)-.+$/.exec(branch)
    )
    .filter((match): match is RegExpExecArray => match !== null);
  if (ticketed.length > 0) {
    const prefix = ticketed
      .map((match) => match[1])
      .sort((a, b) => a.localeCompare(b))[0];
    return `${prefix}/{ticket}-{slug}`;
  }
  const prefixed = candidates
    .map((branch) => /^([^/]+)\/.+$/.exec(branch))
    .filter((match): match is RegExpExecArray => match !== null);
  if (prefixed.length > 0) {
    const counts = new Map<string, number>();
    for (const match of prefixed) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
    const prefix = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (prefix) return `${prefix}/{slug}`;
  }
  return "bolt-{slug}";
}

export function evaluateDetection(input: DetectionInput): Record<string, unknown> {
  const repository = input.repository ?? {};
  const defaultBranch =
    input.branch ??
    ((repository.defaultBranchRef as { name?: string } | undefined)?.name ?? "main");
  const permission =
    typeof repository.viewerPermission === "string"
      ? repository.viewerPermission
      : "UNKNOWN";
  const protectedFlag = input.branchInfo?.protected === true;
  const pullRules = rulesetPullRequests(input.rules ?? []);
  const ruleParams = pullRules.map((rule) =>
    rule.parameters && typeof rule.parameters === "object"
      ? (rule.parameters as Record<string, unknown>)
      : rule
  );
  const classic = input.classicProtection ?? null;
  const classicReview =
    classic?.required_pull_request_reviews &&
    typeof classic.required_pull_request_reviews === "object"
      ? (classic.required_pull_request_reviews as Record<string, unknown>)
      : {};
  const requiredApprovals = Math.max(
    numberValue(classicReview.required_approving_review_count),
    ...ruleParams.map((params) =>
      numberValue(params.required_approving_review_count)
    ),
  );
  const dismissStale =
    booleanValue(classicReview.dismiss_stale_reviews) ||
    ruleParams.some((params) =>
      booleanValue(
        params.dismiss_stale_reviews_on_push ?? params.dismiss_stale_reviews,
      )
    );
  const codeOwnerReview =
    booleanValue(classicReview.require_code_owner_reviews) ||
    ruleParams.some((params) =>
      booleanValue(params.require_code_owner_review)
    );
  const requiredChecks = new Set<string>();
  const branchChecks = (
    input.branchInfo?.protection as
      | { required_status_checks?: { contexts?: unknown } }
      | undefined
  )?.required_status_checks?.contexts;
  for (const check of stringArray(branchChecks)) requiredChecks.add(check);
  for (const rule of input.rules ?? []) {
    if (!rule || typeof rule !== "object") continue;
    const row = rule as Record<string, unknown>;
    if (row.type !== "required_status_checks") continue;
    const params =
      row.parameters && typeof row.parameters === "object"
        ? (row.parameters as Record<string, unknown>)
        : {};
    const checks = Array.isArray(params.required_status_checks)
      ? params.required_status_checks
      : [];
    for (const check of checks) {
      if (typeof check === "string") requiredChecks.add(check);
      if (
        check &&
        typeof check === "object" &&
        typeof (check as { context?: unknown }).context === "string"
      ) {
        requiredChecks.add((check as { context: string }).context);
      }
    }
  }
  const repoMergeMethods = [
    booleanValue(repository.mergeCommitAllowed) ? "merge" : null,
    booleanValue(repository.squashMergeAllowed) ? "squash" : null,
    booleanValue(repository.rebaseMergeAllowed) ? "rebase" : null,
  ].filter((value): value is string => value !== null);
  const branchMethodLists = ruleParams
    .map((params) => stringArray(params.allowed_merge_methods))
    .filter((values) => values.length > 0);
  const branchMergeMethods =
    branchMethodLists.length === 0
      ? repoMergeMethods
      : repoMergeMethods.filter((method) =>
          branchMethodLists.every((values) => values.includes(method))
        );
  const templates = Array.isArray(repository.pullRequestTemplates)
    ? repository.pullRequestTemplates
    : [];
  const detailUnknown =
    protectedFlag &&
    pullRules.length === 0 &&
    classic === null &&
    permission !== "ADMIN";
  const tier = input.protectionUnavailable
    ? "absent-protection"
    : protectedFlag
      ? detailUnknown
        ? "protected-details-unknown"
        : "protected"
      : "unprotected";

  return {
    repo: input.repo,
    branch: defaultBranch,
    viewerPermission: permission,
    protection: {
      tier,
      protected: protectedFlag,
      classicDetail:
        classic !== null
          ? "visible"
          : detailUnknown
            ? "unknown-below-admin"
            : input.classicError ?? "none",
      rulesetLayers: pullRules.length,
      effective: {
        requiredApprovals,
        dismissStaleReviews: dismissStale,
        requireCodeOwnerReview: codeOwnerReview,
        requiredChecks: [...requiredChecks].sort(),
      },
    },
    merge: {
      methods: branchMergeMethods,
      autoMergeAllowed: booleanValue(repository.autoMergeAllowed),
      deleteBranchOnMerge: booleanValue(repository.deleteBranchOnMerge),
    },
    pullRequestTemplates: templates,
    codeowners: input.codeowners,
    branchPattern: inferBranchPattern(input.observedBranches ?? []),
  };
}

function runCommand(command: string, args: string[], cwd?: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };
}

function runGh(args: string[]): CommandResult {
  const result = runCommand("timeout", [
    String(GH_TIMEOUT_SECONDS),
    "gh",
    ...args,
  ]);
  if (result.code === 124) {
    throw new GitHubOfflineError(
      `GitHub unreachable (timed out after ${GH_TIMEOUT_SECONDS}s)`,
    );
  }
  if (!result.ok && OFFLINE_PATTERN.test(result.stderr)) {
    throw new GitHubOfflineError(
      `GitHub unreachable: ${result.stderr.trim() || "network error"}`,
    );
  }
  return result;
}

function ghJson(args: string[], allowFailure = false): unknown {
  const result = runGh(args);
  if (!result.ok) {
    if (allowFailure) {
      return { __error: result.stderr.trim(), __code: result.code };
    }
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `gh exited ${result.code}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh returned invalid JSON: ${errorMessage(error)}`);
  }
}

function graphQlRepository(repo: string): Record<string, unknown> {
  const [owner, name] = splitRepo(repo);
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
    defaultBranchRef{name} viewerPermission isPrivate
    autoMergeAllowed mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge
    pullRequestTemplates{filename body}
    branchProtectionRules(first:100){nodes{pattern requiredApprovingReviewCount dismissesStaleReviews requiresCodeOwnerReviews}}
  }}`;
  const value = ghJson([
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-f",
    `query=${query}`,
  ]) as { data?: { repository?: Record<string, unknown> } };
  if (!value.data?.repository) {
    throw new Error(`GitHub repository not found: ${repo}`);
  }
  return value.data.repository;
}

function splitRepo(repo: string): [string, string] {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (!match) throw new Error(`Invalid repository "${repo}"; expected owner/name`);
  return [match[1], match[2]];
}

function decodeContent(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (typeof content !== "string") return "";
  return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf-8");
}

function detectLive(repo: string, branch?: string): Record<string, unknown> {
  const repository = graphQlRepository(repo);
  const defaultBranch =
    branch ??
    ((repository.defaultBranchRef as { name?: string } | undefined)?.name ?? "main");
  const rules = ghJson([
    "api",
    `repos/${repo}/rules/branches/${encodeURIComponent(defaultBranch)}`,
  ], true);
  const branchInfo = ghJson([
    "api",
    `repos/${repo}/branches/${encodeURIComponent(defaultBranch)}`,
  ]) as Record<string, unknown>;
  const permission = repository.viewerPermission;
  let classicProtection: Record<string, unknown> | null = null;
  let classicError: string | null = null;
  let protectionUnavailable = false;
  if (permission === "ADMIN") {
    const classic = ghJson([
      "api",
      `repos/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection`,
    ], true) as Record<string, unknown>;
    if (typeof classic.__error === "string") {
      classicError = classic.__error;
      protectionUnavailable = /upgrade|not available for private/i.test(classicError);
    } else {
      classicProtection = classic;
    }
  }
  let codeowners: { path: string; content: string } | null = null;
  for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const response = ghJson(["api", `repos/${repo}/contents/${path}`], true) as
      Record<string, unknown>;
    if (typeof response.__error === "string") continue;
    codeowners = { path, content: decodeContent(response) };
    break;
  }
  const observed = ghJson([
    "api",
    `repos/${repo}/branches?per_page=100`,
    "--paginate",
  ], true);
  const observedBranches = Array.isArray(observed)
    ? observed
        .map((branch) =>
          branch &&
          typeof branch === "object" &&
          typeof (branch as { name?: unknown }).name === "string"
            ? (branch as { name: string }).name
            : null
        )
        .filter((branch): branch is string => branch !== null)
    : [];
  return evaluateDetection({
    repo,
    branch: defaultBranch,
    repository,
    rules: Array.isArray(rules) ? rules : [],
    branchInfo,
    classicProtection,
    classicError,
    codeowners,
    protectionUnavailable,
    observedBranches,
  });
}

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function handleDetect(args: ParsedArgs): void {
  const fixturePath = one(args, "fixture");
  if (fixturePath) {
    json(evaluateDetection(fixture(fixturePath) as DetectionInput));
    return;
  }
  json(detectLive(required(args, "repo"), one(args, "branch")));
}

function pullSpec(value: string): { repo: string; number: number } {
  const match = /^([^#]+)#([1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error(`Invalid PR "${value}"; expected owner/repo#number`);
  splitRepo(match[1]);
  return { repo: match[1], number: Number(match[2]) };
}

function sleep(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function fetchPull(repo: string, number: number): PullSnapshot {
  let view: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    view = ghJson([
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "number,url,state,mergedAt,mergeCommit,mergedBy,closedAt,reviewDecision,reviewRequests,isDraft,mergeStateStatus,mergeable,headRefOid,headRefName,baseRefName,body",
    ]) as Record<string, unknown>;
    if (
      view.state === "MERGED" ||
      view.state === "CLOSED" ||
      view.mergeStateStatus !== "UNKNOWN"
    ) {
      break;
    }
    if (attempt < 3) sleep(5_000);
  }
  const reviews = ghJson([
    "api",
    `repos/${repo}/pulls/${number}/reviews?per_page=100`,
    "--paginate",
  ]) as PullReview[];
  const timeline = ghJson([
    "api",
    `repos/${repo}/issues/${number}/timeline?per_page=100`,
    "--paginate",
  ]) as ReviewDismissal[];
  const reviewComments = ghJson([
    "api",
    `repos/${repo}/pulls/${number}/comments?per_page=100`,
    "--paginate",
  ]) as Array<Record<string, unknown>>;
  const issueComments = ghJson([
    "api",
    `repos/${repo}/issues/${number}/comments?per_page=100`,
    "--paginate",
  ]) as Array<Record<string, unknown>>;
  return {
    repo,
    number,
    url: String(view.url ?? `https://github.com/${repo}/pull/${number}`),
    ...(view as Omit<PullSnapshot, "repo" | "number" | "url">),
    reviews,
    timeline,
    reviewComments,
    issueComments,
  };
}

function recordedPulls(path: string): PullSnapshot[] {
  const value = fixture(path) as { prs?: PullSnapshot[] } | PullSnapshot[];
  return Array.isArray(value) ? value : value.prs ?? [];
}

function latestKnown(projectDir: string, unit?: string): Record<string, unknown> | null {
  const audit = readAllAuditShards(projectDir);
  const rows = ["PR_OPENED", "PR_FEEDBACK", "PR_MERGED"]
    .flatMap((event) =>
      findAllEvents(audit, event).map((row) => ({ event, ...row }))
    )
    .filter((row) =>
      unit ? auditBlockField(row.block, "Unit") === unit : true
    )
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const latest = rows.at(-1);
  if (!latest) return null;
  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(latest.timestamp)) / 1000),
  );
  return {
    event: latest.event,
    timestamp: latest.timestamp,
    age_seconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
    repo: auditBlockField(latest.block, "Repo"),
    number: auditBlockField(latest.block, "PR Number"),
    url: auditBlockField(latest.block, "PR URL"),
    state: auditBlockField(latest.block, "State"),
  };
}

function feedbackIdSet(projectDir: string): Set<string> {
  const ids = new Set<string>();
  for (const row of findAllEvents(readAllAuditShards(projectDir), "PR_FEEDBACK")) {
    const id = auditBlockField(row.block, "External ID");
    if (id) ids.add(id);
  }
  return ids;
}

function feedbackRows(
  projectDir: string,
  stage: string,
  unit: string,
  snapshots: readonly PullSnapshot[],
): AuditEntryInput[] {
  const floor = latestMainWorkflowStageRunFloorForProject(
    projectDir,
    stage,
    false,
    unit,
  );
  if (!floor) {
    throw new Error(`Cannot emit PR feedback without a current ${stage} run floor`);
  }
  const known = feedbackIdSet(projectDir);
  const attempt = claimAttemptFields(projectDir, unit);
  const rows: AuditEntryInput[] = [];
  const add = (
    snapshot: PullSnapshot,
    type: string,
    value: Record<string, unknown>,
    id: unknown,
    state: string,
    createdAt: unknown,
  ) => {
    const externalId = `${snapshot.repo}:${type}:${String(id)}`;
    if (known.has(externalId)) return;
    const actor = actorLogin(value.user ?? value.author ?? value.actor);
    const body = typeof value.body === "string" ? value.body : "";
    rows.push({
      eventType: "PR_FEEDBACK",
      fields: {
        Stage: stage,
        Unit: unit,
        "Run floor": floor,
        Repo: snapshot.repo,
        "PR Number": String(snapshot.number),
        "PR URL": snapshot.url,
        "Feedback Type": type,
        Actor: actor,
        "External ID": externalId,
        State: state,
        "Created At": typeof createdAt === "string" ? createdAt : "",
        ...(typeof value.path === "string" ? { Path: value.path } : {}),
        ...(typeof value.line === "number" ? { Line: String(value.line) } : {}),
        ...(body
          ? {
              "Body Digest": createHash("sha256")
                .update(body)
                .digest("hex"),
            }
          : {}),
        ...attempt,
      },
    });
  };
  for (const snapshot of snapshots) {
    for (const review of snapshot.reviews ?? []) {
      add(
        snapshot,
        "review",
        review as unknown as Record<string, unknown>,
        review.id,
        review.state.toUpperCase(),
        reviewTimestamp(review),
      );
    }
    for (const comment of snapshot.reviewComments ?? []) {
      add(
        snapshot,
        "review-comment",
        comment,
        comment.id,
        "COMMENTED",
        comment.created_at,
      );
    }
    for (const comment of snapshot.issueComments ?? []) {
      add(
        snapshot,
        "issue-comment",
        comment,
        comment.id,
        "COMMENTED",
        comment.created_at,
      );
    }
  }
  return rows;
}

function pullSnapshots(args: ParsedArgs): PullSnapshot[] {
  const fixturePath = one(args, "fixture");
  if (fixturePath) return recordedPulls(fixturePath);
  const specs = [...many(args, "pr")];
  if (specs.length === 0 && one(args, "repo") && one(args, "number")) {
    specs.push(`${one(args, "repo")}#${one(args, "number")}`);
  }
  if (specs.length === 0) throw new Error("Supply --pr owner/repo#number");
  // Exactly one connectivity probe per sweep. An offline result aborts before
  // any per-PR call incurs its own timeout.
  const probe = runGh(["api", "rate_limit", "--jq", ".rate.remaining"]);
  if (!probe.ok) {
    throw new Error(probe.stderr.trim() || "GitHub connectivity probe failed");
  }
  return specs.map((spec) => {
    const parsed = pullSpec(spec);
    return fetchPull(parsed.repo, parsed.number);
  });
}

function sweepResult(
  snapshots: readonly PullSnapshot[],
): Record<string, unknown> {
  const pulls = snapshots.map(evaluatePullSnapshot);
  return {
    online: true,
    pulls,
    coordination: evaluateCoordinatedPulls(pulls),
  };
}

function handleSweep(args: ParsedArgs, syncOnly = false): void {
  const projectDir = resolveProjectDir(one(args, "project-dir"));
  try {
    const snapshots = pullSnapshots(args);
    let emitted = 0;
    const unit = one(args, "unit");
    if (unit && (syncOnly || args.booleans.has("emit-feedback"))) {
      const rows = feedbackRows(
        projectDir,
        one(args, "stage") ?? DEFAULT_STAGE,
        unit,
        snapshots,
      );
      if (rows.length > 0) {
        appendAuditEntries(rows, projectDir);
        emitted = rows.length;
      }
    }
    json({
      ...sweepResult(snapshots),
      feedback_emitted: emitted,
    });
  } catch (error) {
    if (!(error instanceof GitHubOfflineError)) throw error;
    json({
      online: false,
      error: error.message,
      last_known: latestKnown(projectDir, one(args, "unit")),
    });
  }
}

function branchPatternFromPractices(projectDir: string): string | null {
  const state = readStateFile(projectDir);
  const space = getField(state, "Space") ?? "default";
  for (const name of ["project.md", "team.md"]) {
    const path = join(projectDir, "aidlc", "spaces", space, "memory", name);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, "utf-8");
    const match =
      /^\s*-\s*\*\*Branch pattern\*\*:\s*`?([^`\r\n]+)`?\s*$/im.exec(body) ??
      /branches look like\s+`([^`]+)`/i.exec(body);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function branchName(
  projectDir: string,
  slug: string,
  explicit?: string,
  ticket?: string,
): string {
  const pattern = explicit ?? branchPatternFromPractices(projectDir);
  if (!pattern) return `bolt-${slug}`;
  return pattern
    .replace(/\{slug\}|<slug>/g, slug)
    .replace(/\{ticket\}|<ticket>/g, ticket ?? "no-ticket");
}

function humanReviewer(value: string): boolean {
  return !/\[bot\]$|-bot$|^github-actions$/i.test(value.trim());
}

function reviewersFromPractices(projectDir: string): string[] {
  let state = "";
  try {
    state = readStateFile(projectDir);
  } catch {
    return [];
  }
  const space = getField(state, "Space") ?? "default";
  const found = new Set<string>();
  for (const name of ["project.md", "team.md"]) {
    const path = join(projectDir, "aidlc", "spaces", space, "memory", name);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, "utf-8");
    const match = /^\s*-\s*\*\*Standing reviewers\*\*:\s*(.+)$/im.exec(body);
    if (!match) continue;
    for (const value of match[1].split(/[,\s]+/)) {
      const reviewer = value.replace(/^@/, "").trim();
      if (reviewer && humanReviewer(reviewer)) found.add(reviewer);
    }
  }
  return [...found].sort();
}

function evidenceEntries(
  projectDir: string,
  stageSlug: string,
  unit: string,
): Array<{ artifact: string; logicalPath: string; content: string | null }> {
  const graph = loadStageGraphAll();
  const stage = graph.find((entry) => entry.slug === stageSlug);
  if (!stage) throw new Error(`Stage not found: ${stageSlug}`);
  const consumes = stage.consumes ?? [];
  const rank = new Map(CORE_DOSSIER_ORDER.map((name, index) => [name, index]));
  const ordered = consumes.map((entry, index) => ({ entry, index })).sort((left, right) => {
    const a = rank.get(left.entry.artifact) ?? CORE_DOSSIER_ORDER.length + left.index;
    const b = rank.get(right.entry.artifact) ?? CORE_DOSSIER_ORDER.length + right.index;
    return a - b;
  }).map(({ entry }) => entry);
  return ordered.map((consume) => {
    const producer = graph.find((entry) =>
      (entry.produces ?? []).includes(consume.artifact)
    );
    if (!producer) {
      return {
        artifact: consume.artifact,
        logicalPath: consume.artifact,
        content: null,
      };
    }
    const entries = reviewArtifactEntries(projectDir, producer, unit) ?? [];
    const filename = artifactFilename(consume.artifact);
    const entry =
      entries.find((candidate) => basename(candidate.logicalPath) === filename) ??
      entries[0];
    if (!entry?.path || !existsSync(entry.path)) {
      return {
        artifact: consume.artifact,
        logicalPath: entry?.logicalPath ?? consume.artifact,
        content: null,
      };
    }
    try {
      if (!statSync(entry.path).isFile()) throw new Error("not a file");
      return {
        artifact: consume.artifact,
        logicalPath: entry.logicalPath,
        content: readFileSync(entry.path, "utf-8"),
      };
    } catch {
      return {
        artifact: consume.artifact,
        logicalPath: entry.logicalPath,
        content: null,
      };
    }
  });
}

export function composePrBody(input: {
  template: string;
  title: string;
  unit: string;
  marker?: string;
  siblingUrls?: string[];
  evidence: Array<{ artifact: string; logicalPath: string; content: string | null }>;
}): string {
  const template = input.template.trim() || DEFAULT_TEMPLATE.trim();
  const filled = template.replace(
    /^(##\s+([^\r\n]+))\s*$/gm,
    (_whole, heading: string, name: string) => {
      const normalized = name.trim().toLowerCase();
      const value = normalized === "summary"
        ? `${input.title}\n\nUnit: \`${input.unit}\``
        : normalized === "testing"
          ? "The PR's own CI is the per-unit test gate. See the evidence dossier below."
          : normalized === "risks"
            ? "See the evidence dossier and current review state."
            : "Filled from the active AI-DLC record.";
      return `${heading}\n\n${value}`;
    },
  );
  const dossier = input.evidence.map((entry) => {
    const digest = entry.content === null
      ? "missing"
      : createHash("sha256").update(entry.content).digest("hex");
    return [
      `### ${entry.artifact}`,
      "",
      `- Path: \`${entry.logicalPath}\``,
      `- SHA-256: \`${digest}\``,
    ].join("\n");
  }).join("\n\n");
  const coordination = input.marker
    ? [
        "",
        ...(input.siblingUrls?.length
          ? [`Coordinated PRs: ${input.siblingUrls.join(", ")}`, ""]
          : []),
        input.marker,
      ].join("\n")
    : "";
  return `${filled}\n\n<details>\n<summary>AIDLC evidence dossier</summary>\n\n${dossier}\n\n</details>${coordination}\n`;
}

function commandText(command: string, args: string[]): string {
  return [command, ...args]
    .map((value) => JSON.stringify(value))
    .join(" ");
}

function repoPathMap(args: ParsedArgs): Map<string, string> {
  const out = new Map<string, string>();
  for (const value of many(args, "repo-path")) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid --repo-path "${value}"; expected owner/repo=/path`);
    }
    out.set(value.slice(0, separator), value.slice(separator + 1));
  }
  return out;
}

function expectedRepoPath(
  projectDir: string,
  repo: string,
  mapping: ReadonlyMap<string, string>,
): string {
  const explicit = mapping.get(repo);
  if (explicit) return explicit;
  const name = splitRepo(repo)[1];
  if (basename(projectDir) === name) return projectDir;
  const sibling = join(projectDir, name);
  return existsSync(sibling) ? sibling : projectDir;
}

function openRecordPath(projectDir: string, unit: string): string {
  const record = recordDir(projectDir);
  if (!record) throw new Error("No active workflow record");
  return join(record, "construction", unit, DEFAULT_STAGE, "pr-record.md");
}

interface OpenPlan {
  repo: string;
  repoPath: string;
  base: string;
  head: string;
  title: string;
  template: string;
  body: string;
  bodyFile: string;
  commands: string[];
}

function openPlans(args: ParsedArgs): {
  projectDir: string;
  stage: string;
  unit: string;
  slug: string;
  reviewers: string[];
  marker?: string;
  plans: OpenPlan[];
} {
  const projectDir = resolveProjectDir(one(args, "project-dir"));
  const stage = one(args, "stage") ?? DEFAULT_STAGE;
  const unit = required(args, "unit");
  const slug = slugify(one(args, "slug") ?? unit);
  const repos = many(args, "repo");
  if (repos.length === 0) throw new Error("Supply at least one --repo owner/name");
  const parent = one(args, "parent-pr");
  if (parent) {
    const eligibility = stackingEligibility({
      strategy: one(args, "strategy") ?? "squash",
      deleteBranchOnMerge: one(args, "delete-branch-on-merge") === "true",
    });
    if (!eligibility.allowed) {
      throw new Error(`${eligibility.reason}. ${eligibility.recovery}`);
    }
  }
  const head = branchName(
    projectDir,
    slug,
    one(args, "branch-pattern"),
    one(args, "ticket"),
  );
  const title = one(args, "title") ?? `${unit}: integrate via PR`;
  const explicitTemplate = one(args, "template-file");
  const suppliedTemplate = explicitTemplate
    ? readFileSync(explicitTemplate, "utf-8")
    : null;
  const evidence = evidenceEntries(projectDir, stage, unit);
  const marker = repos.length > 1
    ? `AIDLC-Coordinated: bolt=${slug} repos=${repos.map((repo) => splitRepo(repo)[1]).join(",")}`
    : undefined;
  const mapping = repoPathMap(args);
  const recordPath = openRecordPath(projectDir, unit);
  const reviewers = [
    ...new Set([
      ...many(args, "reviewer").map((value) => value.replace(/^@/, "")),
      ...reviewersFromPractices(projectDir),
    ].filter(humanReviewer)),
  ].sort();
  const baseValues = many(args, "base");
  const plans = repos.map((repo, index) => {
    splitRepo(repo);
    const base = baseValues[index] ?? baseValues[0] ?? "main";
    const repository = suppliedTemplate === null && args.booleans.has("execute")
      ? graphQlRepository(repo)
      : null;
    const detectedTemplates = Array.isArray(repository?.pullRequestTemplates)
      ? repository.pullRequestTemplates
      : [];
    const detectedBody =
      detectedTemplates[0] &&
      typeof detectedTemplates[0] === "object" &&
      typeof (detectedTemplates[0] as { body?: unknown }).body === "string"
        ? (detectedTemplates[0] as { body: string }).body
        : null;
    const template = suppliedTemplate ?? detectedBody ?? DEFAULT_TEMPLATE;
    const body = composePrBody({
      template,
      title,
      unit,
      marker,
      evidence,
    });
    const bodyFile = `${recordPath}.${splitRepo(repo)[1]}.body.md`;
    const repoPath = expectedRepoPath(projectDir, repo, mapping);
    const commands = [
      commandText("git", ["-C", repoPath, "push", "-u", "origin", head]),
      commandText("gh", [
        "pr",
        "create",
        "-R",
        repo,
        "--base",
        base,
        "--head",
        head,
        "--title",
        title,
        "--body-file",
        bodyFile,
      ]),
      ...(reviewers.length > 0
        ? [
            commandText("gh", [
              "pr",
              "edit",
              "<number>",
              "-R",
              repo,
              "--add-reviewer",
              reviewers.join(","),
            ]),
          ]
        : []),
      ...(marker
        ? [
            commandText("gh", [
              "pr",
              "edit",
              "<number>",
              "-R",
              repo,
              "--body-file",
              bodyFile,
            ]),
          ]
        : []),
    ];
    return { repo, repoPath, base, head, title, template, body, bodyFile, commands };
  });
  return { projectDir, stage, unit, slug, reviewers, marker, plans };
}

function verifyPush(plan: OpenPlan): void {
  const local = runCommand("git", ["-C", plan.repoPath, "rev-parse", plan.head]);
  if (!local.ok) throw new Error(`Cannot resolve local branch ${plan.head}`);
  const remote = runCommand("git", [
    "-C",
    plan.repoPath,
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${plan.head}`,
  ]);
  if (!remote.ok || remote.stdout.split(/\s+/)[0] !== local.stdout.trim()) {
    throw new Error(`Push verification failed for ${plan.repo}:${plan.head}`);
  }
}

function createPr(plan: OpenPlan, bodyFile: string): PullSnapshot {
  const created = runGh([
    "pr",
    "create",
    "-R",
    plan.repo,
    "--base",
    plan.base,
    "--head",
    plan.head,
    "--title",
    plan.title,
    "--body-file",
    bodyFile,
  ]);
  if (!created.ok) {
    throw new Error(created.stderr.trim() || "gh pr create failed");
  }
  const url = created.stdout.trim().split(/\s+/).find((value) =>
    /^https:\/\/github\.com\//.test(value)
  );
  if (!url) throw new Error(`gh pr create returned no PR URL for ${plan.repo}`);
  const number = Number(url.split("/").at(-1));
  if (!Number.isInteger(number)) throw new Error(`Cannot parse PR number from ${url}`);
  return fetchPull(plan.repo, number);
}

function verifyOpen(plan: OpenPlan, snapshot: PullSnapshot, expectedBody: string): void {
  if (
    snapshot.state !== "OPEN" ||
    snapshot.headRefName !== plan.head ||
    snapshot.baseRefName !== plan.base ||
    snapshot.body !== expectedBody
  ) {
    throw new Error(
      `PR read-back verification failed for ${snapshot.url}: expected OPEN ${plan.head}->${plan.base} with exact body`,
    );
  }
}

function requestReviewers(
  snapshot: PullSnapshot,
  reviewers: readonly string[],
): PullSnapshot {
  if (reviewers.length === 0) return snapshot;
  const edited = runGh([
    "pr",
    "edit",
    String(snapshot.number),
    "-R",
    snapshot.repo,
    "--add-reviewer",
    reviewers.join(","),
  ]);
  if (!edited.ok) {
    throw new Error(edited.stderr.trim() || "review request failed");
  }
  const refreshed = fetchPull(snapshot.repo, snapshot.number);
  const requested = new Set(requestedReviewerNames(refreshed.reviewRequests ?? []));
  const missing = reviewers.filter((reviewer) => !requested.has(reviewer));
  if (missing.length > 0) {
    throw new Error(
      `Review request read-back verification failed for ${refreshed.url}; GitHub silently omitted: ${missing.join(", ")}`,
    );
  }
  return refreshed;
}

function emitOpenReceipts(
  projectDir: string,
  stage: string,
  unit: string,
  snapshots: readonly PullSnapshot[],
): void {
  const floor = latestMainWorkflowStageRunFloorForProject(
    projectDir,
    stage,
    false,
    unit,
  );
  if (!floor) throw new Error(`Cannot emit PR_OPENED without a current ${stage} run floor`);
  const attempt = claimAttemptFields(projectDir, unit);
  const entries: AuditEntryInput[] = snapshots.map((snapshot) => ({
    eventType: "PR_OPENED",
    fields: {
      Stage: stage,
      Unit: unit,
      "Run floor": floor,
      Repo: snapshot.repo,
      "PR Number": String(snapshot.number),
      "PR URL": snapshot.url,
      Head: snapshot.headRefName ?? "",
      Base: snapshot.baseRefName ?? "",
      ...(snapshots.length > 1
        ? { Coordination: snapshots.map((value) => value.url).join(",") }
        : {}),
      ...attempt,
    },
  }));
  entries.push({
    eventType: "UNIT_INTEGRATING",
    fields: {
      Stage: stage,
      Unit: unit,
      "Run floor": floor,
      Repos: snapshots.map((snapshot) => snapshot.repo).join(","),
      "PR URLs": snapshots.map((snapshot) => snapshot.url).join(","),
      ...attempt,
    },
  });
  appendAuditEntries(entries, projectDir);
}

function writePrRecord(
  projectDir: string,
  unit: string,
  snapshots: readonly PullSnapshot[],
): string {
  const path = openRecordPath(projectDir, unit);
  const body = [
    "# PR Record",
    "",
    "## PR Summary",
    "",
    `Unit \`${unit}\` opened ${snapshots.length} coordinated PR${snapshots.length === 1 ? "" : "s"}.`,
    "",
    "## Publication Plan",
    "",
    ...snapshots.flatMap((snapshot) => [
      `### ${snapshot.repo}#${snapshot.number}`,
      "",
      `- URL: ${snapshot.url}`,
      `- Head: ${snapshot.headRefName}`,
      `- Base: ${snapshot.baseRefName}`,
      "",
    ]),
    "## Evidence Dossier",
    "",
    ...snapshots.map((snapshot) =>
      `- ${snapshot.repo} body SHA-256: \`${createHash("sha256")
        .update(snapshot.body ?? "")
        .digest("hex")}\``
    ),
    "",
    "## Integration Status",
    "",
    ...snapshots.map((snapshot) =>
      `- ${snapshot.repo}#${snapshot.number}: ${snapshot.state}`
    ),
    "",
  ].join("\n");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
  return path;
}

function handleOpen(args: ParsedArgs): void {
  const planned = openPlans(args);
  if (!args.booleans.has("execute")) {
    json({
      execute: false,
      dry_run: true,
      stage: planned.stage,
      unit: planned.unit,
      slug: planned.slug,
      marker: planned.marker ?? null,
      reviewers: planned.reviewers,
      plans: planned.plans.map((plan) => ({
        repo: plan.repo,
        base: plan.base,
        head: plan.head,
        body_file: plan.bodyFile,
        body: plan.body,
        commands: plan.commands,
      })),
    });
    return;
  }

  const temp = mkdtempSync(join(tmpdir(), "aidlc-pr-"));
  try {
    const snapshots: PullSnapshot[] = [];
    for (const plan of planned.plans) {
      const pushed = runCommand(
        "git",
        ["-C", plan.repoPath, "push", "-u", "origin", plan.head],
      );
      if (!pushed.ok) {
        throw new Error(
          pushed.stderr.trim() || `git push failed for ${plan.repo}`,
        );
      }
      verifyPush(plan);
      const bodyFile = join(temp, `${splitRepo(plan.repo)[1]}.md`);
      writeFileSync(bodyFile, plan.body, "utf-8");
      let snapshot = createPr(plan, bodyFile);
      verifyOpen(plan, snapshot, plan.body);
      snapshot = requestReviewers(snapshot, planned.reviewers);
      snapshots.push(snapshot);
    }

    if (snapshots.length > 1) {
      for (let index = 0; index < snapshots.length; index++) {
        const snapshot = snapshots[index];
        const plan = planned.plans[index];
        const siblingUrls = snapshots
          .filter((value) => value.url !== snapshot.url)
          .map((value) => value.url);
        const finalBody = composePrBody({
          template: plan.template,
          title: plan.title,
          unit: planned.unit,
          marker: planned.marker,
          siblingUrls,
          evidence: evidenceEntries(planned.projectDir, planned.stage, planned.unit),
        });
        const bodyFile = join(temp, `${splitRepo(plan.repo)[1]}-coordinated.md`);
        writeFileSync(bodyFile, finalBody, "utf-8");
        const edited = runGh([
          "pr",
          "edit",
          String(snapshot.number),
          "-R",
          snapshot.repo,
          "--body-file",
          bodyFile,
        ]);
        if (!edited.ok) throw new Error(edited.stderr.trim() || "PR body update failed");
        const refreshed = fetchPull(snapshot.repo, snapshot.number);
        verifyOpen(plan, refreshed, finalBody);
        snapshots[index] = refreshed;
      }
    }

    const record = writePrRecord(planned.projectDir, planned.unit, snapshots);
    emitOpenReceipts(
      planned.projectDir,
      planned.stage,
      planned.unit,
      snapshots,
    );
    json({
      execute: true,
      opened: snapshots.map((snapshot) => ({
        repo: snapshot.repo,
        number: snapshot.number,
        url: snapshot.url,
      })),
      record,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function existingMergedReceipt(
  projectDir: string,
  repo: string,
  number: number,
): boolean {
  return findAllEvents(readAllAuditShards(projectDir), "PR_MERGED").some(
    (row) =>
      auditBlockField(row.block, "Repo") === repo &&
      auditBlockField(row.block, "PR Number") === String(number),
  );
}

function runSibling(
  projectDir: string,
  tool: "aidlc-state.ts" | "aidlc-bolt.ts" | "aidlc-worktree.ts",
  args: string[],
): void {
  const path = fileURLToPath(new URL(`./${tool}`, import.meta.url));
  const result = runCommand(process.execPath, [
    path,
    "--project-dir",
    projectDir,
    ...args,
  ], projectDir);
  if (!result.ok) {
    throw new Error(
      `${tool} ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
}

function latestBoltStart(
  projectDir: string,
  slug: string,
  unit: string,
): { name: string; batch: string } | null {
  const rows = findAllEvents(readAllAuditShards(projectDir), "BOLT_STARTED")
    .filter((row) => {
      const recordedSlug = auditBlockField(row.block, "Bolt slug");
      const names = auditBlockField(row.block, "Bolt names") ?? "";
      return recordedSlug === slug || names.split(",").map((name) => name.trim()).includes(unit);
    });
  const row = rows.at(-1);
  if (!row) return null;
  return {
    name: auditBlockField(row.block, "Bolt names") ?? unit,
    batch: auditBlockField(row.block, "Batch number") ?? "1",
  };
}

function retargetChildren(args: ParsedArgs): string[] {
  const commands: string[] = [];
  for (const value of many(args, "child-pr")) {
    const separator = value.lastIndexOf(":");
    if (separator <= 0) {
      throw new Error(
        `Invalid --child-pr "${value}"; expected owner/repo#number:new-base`,
      );
    }
    const child = pullSpec(value.slice(0, separator));
    const base = value.slice(separator + 1);
    const command = [
      "pr",
      "edit",
      String(child.number),
      "-R",
      child.repo,
      "--base",
      base,
    ];
    commands.push(commandText("gh", command));
    if (!args.booleans.has("execute")) continue;
    const edited = runGh(command);
    if (!edited.ok) throw new Error(edited.stderr.trim() || "child retarget failed");
    const readBack = fetchPull(child.repo, child.number);
    if (readBack.baseRefName !== base || readBack.state !== "OPEN") {
      throw new Error(
        `Child retarget read-back failed for ${readBack.url}. Recovery: restore the parent ref at its old SHA, reopen the child, retarget it, then remove the restored ref.`,
      );
    }
  }
  return commands;
}

function handleFinalize(args: ParsedArgs): void {
  const projectDir = resolveProjectDir(one(args, "project-dir"));
  const stage = one(args, "stage") ?? DEFAULT_STAGE;
  const unit = required(args, "unit");
  let snapshots: PullSnapshot[];
  try {
    snapshots = pullSnapshots(args);
  } catch (error) {
    if (error instanceof GitHubOfflineError) {
      json({
        finalized: false,
        online: false,
        error: error.message,
        last_known: latestKnown(projectDir, unit),
      });
      return;
    }
    throw error;
  }
  const result = sweepResult(snapshots);
  const coordination = result.coordination as ReturnType<
    typeof evaluateCoordinatedPulls
  >;
  if (coordination.state !== "merged") {
    json({ finalized: false, ...result });
    return;
  }
  const retarget = retargetChildren(args);
  if (retarget.length > 0 && !args.booleans.has("execute")) {
    json({
      finalized: false,
      dry_run: true,
      reason: "retarget-children-before-branch-deletion",
      commands: retarget,
      recovery:
        "If a child was already closed, restore the parent ref at its old SHA, reopen the child, retarget it, then remove the restored ref.",
    });
    return;
  }
  const floor = latestMainWorkflowStageRunFloorForProject(
    projectDir,
    stage,
    false,
    unit,
  );
  if (!floor) throw new Error(`Cannot finalize without a current ${stage} run floor`);
  const attempt = claimAttemptFields(projectDir, unit);
  const mergeRows = snapshots
    .filter((snapshot) =>
      !existingMergedReceipt(projectDir, snapshot.repo, snapshot.number)
    )
    .map<AuditEntryInput>((snapshot) => ({
      eventType: "PR_MERGED",
      fields: {
        Stage: stage,
        Unit: unit,
        "Run floor": floor,
        Repo: snapshot.repo,
        "PR Number": String(snapshot.number),
        "PR URL": snapshot.url,
        "Merge Commit": mergeCommitOid(snapshot) ?? "",
        "Merged At": snapshot.mergedAt ?? "",
        ...(mergedByLogin(snapshot)
          ? { "Merged By": mergedByLogin(snapshot) as string }
          : {}),
        ...attempt,
      },
    }));
  if (mergeRows.length > 0) appendAuditEntries(mergeRows, projectDir);

  const slug = slugify(one(args, "slug") ?? unit);
  const bolt = latestBoltStart(projectDir, slug, unit);
  runSibling(projectDir, "aidlc-state.ts", [
    "unit",
    "complete",
    "--stage",
    stage,
    "--unit",
    unit,
  ]);
  if (bolt && existsSync(worktreePath(projectDir, slug))) {
    runSibling(projectDir, "aidlc-bolt.ts", [
      "complete",
      "--name",
      one(args, "bolt-name") ?? bolt.name,
      "--batch",
      one(args, "batch") ?? bolt.batch,
      "--merge",
      "--slug",
      slug,
    ]);
  }
  if (existsSync(worktreePath(projectDir, slug))) {
    runSibling(projectDir, "aidlc-worktree.ts", [
      "discard",
      "--slug",
      slug,
      "--reason",
      "integrated-via-pr",
    ]);
  }
  json({
    finalized: true,
    pulls: snapshots.map(evaluatePullSnapshot),
    metadata_consolidated: bolt !== null,
    unit_completed: true,
    worktree_retired: !existsSync(worktreePath(projectDir, slug)),
  });
}

let projectDirArg: string | undefined;

export function main(argv: string[]): void {
  const filtered: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--project-dir" && argv[index + 1]) {
      projectDirArg = argv[index + 1];
      filtered.push("--project-dir", argv[index + 1]);
      index++;
      continue;
    }
    filtered.push(argv[index]);
  }
  const command = filtered[0];
  try {
    const args = parseArgs(filtered.slice(1));
    if (projectDirArg && !one(args, "project-dir")) {
      args.flags.set("project-dir", [projectDirArg]);
    }
    switch (command) {
      case "detect":
        handleDetect(args);
        return;
      case "open":
        handleOpen(args);
        return;
      case "sweep":
        handleSweep(args);
        return;
      case "sync-feedback":
        handleSweep(args, true);
        return;
      case "finalize":
        handleFinalize(args);
        return;
      default:
        throw new Error(
          "Usage: aidlc-pr.ts <detect|open|sweep|sync-feedback|finalize> [flags]",
        );
    }
  } catch (error) {
    console.error(
      JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2),
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
