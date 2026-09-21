import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const MAX_CHANGED_FILES = 500;
const MAX_REVIEW_BYTES = 100_000;
const CURRENT_AI_REVIEWS_FILE = "current-ai-reviews.json";
const AI_REVIEW_MARKER = "<!-- ai-pr-review context=";

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
  kind: "issue-comment" | "review" | "review-comment" | "ai-review";
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

export interface LinkedIssueDiscussion {
  number: number;
  title: string;
  state: string;
  body: string;
  actor: DiscussionActor;
  comments: DiscussionEntry[];
}

export interface ReviewDiscussion {
  version: 1;
  pullRequest: number;
  issueComments: DiscussionEntry[];
  reviews: DiscussionEntry[];
  reviewComments: DiscussionEntry[];
  linkedIssues: LinkedIssueDiscussion[];
}

export interface Finding {
  priority: Priority;
  category: FindingCategory;
  title: string;
  evidence: FindingEvidence[];
  problem: string;
  impact: string;
  requiredCorrection: string;
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
  findings: Finding[];
  residualRisk: string;
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
  kind: "issue-comment" | "review-comment",
): DiscussionEntry {
  const entry: DiscussionEntry = {
    id: integer(value.id, `${kind} id`),
    kind,
    actor: actor(value.user, value.author_association),
    body: text(value.body),
    createdAt: date(value.created_at),
    updatedAt: date(value.updated_at),
  };
  if (kind === "review-comment") {
    entry.commitId = text(value.commit_id);
    entry.path = text(value.path);
    entry.line = typeof value.line === "number" ? value.line : null;
    entry.side = typeof value.side === "string" ? value.side : null;
    entry.replyToId = typeof value.in_reply_to_id === "number" ? value.in_reply_to_id : null;
  }
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
  issueCommentsRaw: Record<string, unknown>[],
  reviewsRaw: Record<string, unknown>[],
  reviewCommentsRaw: Record<string, unknown>[],
  linkedIssuesRaw: Array<{
    issue: Record<string, unknown>;
    comments: Record<string, unknown>[];
  }>,
): { discussion: ReviewDiscussion; currentAiReviews: DiscussionEntry[] } {
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    throw new Error("pull request number must be a positive integer");
  }
  assertSha(head, "head");
  const normalizedReviews = reviewsRaw.map(reviewEntry).sort(byTimeAndId);
  const currentAiReviews = normalizedReviews.filter(
    entry => entry.kind === "ai-review" && entry.commitId === head,
  );
  const discussion: ReviewDiscussion = {
    version: 1,
    pullRequest,
    issueComments: issueCommentsRaw.map(value => commentEntry(value, "issue-comment")).sort(byTimeAndId),
    reviews: normalizedReviews.filter(
      entry => entry.kind !== "ai-review" || entry.commitId !== head,
    ),
    reviewComments: reviewCommentsRaw
      .map(value => commentEntry(value, "review-comment"))
      .sort(byTimeAndId),
    linkedIssues: linkedIssuesRaw
      .map(({ issue, comments }) => ({
        number: integer(issue.number, "linked issue number"),
        title: text(issue.title),
        state: text(issue.state),
        body: text(issue.body),
        actor: actor(issue.user, issue.author_association),
        comments: comments
          .map(value => commentEntry(value, "issue-comment"))
          .sort(byTimeAndId),
      }))
      .sort((left, right) => left.number - right.number),
  };
  return { discussion, currentAiReviews };
}

function linkedIssueNumbers(
  repository: string,
  pullRequest: number,
  ghExecutable = "gh",
): number[] {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) throw new Error("repository must be owner/name");
  const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String) {
    repository(owner:$owner,name:$name) {
      pullRequest(number:$number) {
        closingIssuesReferences(first:100,after:$endCursor) {
          nodes { number }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  const pages = gh([
    "api", "graphql", "--paginate", "--slurp",
    "-f", `query=${query}`,
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `number=${pullRequest}`,
  ], ghExecutable);
  if (!Array.isArray(pages)) throw new Error("linked issue query did not return pages");
  const numbers = new Set<number>();
  for (const [index, pageValue] of pages.entries()) {
    const page = record(pageValue, `linked issue page ${index}`);
    const data = record(page.data, `linked issue page ${index} data`);
    const repositoryValue = record(data.repository, `linked issue page ${index} repository`);
    const pr = record(repositoryValue.pullRequest, `linked issue page ${index} pull request`);
    const references = record(pr.closingIssuesReferences, `linked issue page ${index} references`);
    for (const node of records(references.nodes, `linked issue page ${index} nodes`)) {
      numbers.add(integer(node.number, "linked issue number"));
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

export function buildDiscussion(
  repository: string,
  pullRequest: number,
  head: string,
  output: string,
  currentAiOutput: string,
  ghExecutable = "gh",
): void {
  const issueComments = paginatedRecords(
    `repos/${repository}/issues/${pullRequest}/comments`,
    ghExecutable,
  );
  const reviews = paginatedRecords(
    `repos/${repository}/pulls/${pullRequest}/reviews`,
    ghExecutable,
  );
  const reviewComments = paginatedRecords(
    `repos/${repository}/pulls/${pullRequest}/comments`,
    ghExecutable,
  );
  const linkedIssues = linkedIssueNumbers(repository, pullRequest, ghExecutable).map(number => ({
    issue: record(
      gh(["api", `repos/${repository}/issues/${number}`], ghExecutable),
      `linked issue ${number}`,
    ),
    comments: paginatedRecords(`repos/${repository}/issues/${number}/comments`, ghExecutable),
  }));
  const normalized = normalizeDiscussion(
    pullRequest,
    head,
    issueComments,
    reviews,
    reviewComments,
    linkedIssues,
  );
  writeFileSync(output, `${JSON.stringify(normalized.discussion, null, 2)}\n`);
  writeFileSync(currentAiOutput, `${JSON.stringify(normalized.currentAiReviews, null, 2)}\n`);
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
): Array<{ added: LineRange[]; deleted: LineRange[]; fileLevelEvidence: boolean }> {
  const sections = patch.split(/(?=^diff --git )/m).filter(section => section.startsWith("diff --git "));
  if (sections.length !== expectedFiles) {
    throw new Error(
      `git diff section count ${sections.length} does not match changed-file count ${expectedFiles}`,
    );
  }
  return sections.map(section => {
    const added: LineRange[] = [];
    const deleted: LineRange[] = [];
    for (const match of section.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const oldStart = Number(match[1]);
      const oldCount = Number(match[2] ?? "1");
      const newStart = Number(match[3]);
      const newCount = Number(match[4] ?? "1");
      if (oldCount > 0) deleted.push({ start: oldStart, end: oldStart + oldCount - 1 });
      if (newCount > 0) added.push({ start: newStart, end: newStart + newCount - 1 });
    }
    return {
      added,
      deleted,
      fileLevelEvidence: added.length === 0 && deleted.length === 0,
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
      if (contextPath === "context-id.txt" || contextPath === CURRENT_AI_REVIEWS_FILE) continue;
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
    const file: ChangedFile = { ...entry, ...ranges[index] };
    writeSnapshot(outputDir, head, file, repoDir);
    return file;
  });
  const manifest = { base, head, files };
  writeFileSync(join(outputDir, "changed-files.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const digest = contextDigest(outputDir);
  writeFileSync(join(outputDir, "context-id.txt"), `${digest}\n`);
  return manifest;
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

function isChangedLine(file: ChangedFile, evidence: DiffEvidence): boolean {
  const expectedPath = evidence.side === "RIGHT" ? file.path : (file.previousPath ?? file.path);
  if (evidence.path !== expectedPath) return false;
  const ranges = evidence.side === "RIGHT" ? file.added : file.deleted;
  return ranges.some(range => evidence.line >= range.start && evidence.line <= range.end);
}

export function validateStructuredReview(
  raw: string,
  expectedBase: string,
  expectedHead: string,
  manifest: ChangedFileManifest,
  metadata: ReviewMetadata,
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
    return {
      priority,
      category: category as FindingCategory,
      title,
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

  const residualRisk = requiredText(candidate.residualRisk, "residualRisk", 1000);
  return {
    base: expectedBase,
    head: expectedHead,
    inspection,
    validation,
    assessment,
    findings,
    residualRisk,
  };
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
    `Reviewed \`${review.head}\` against \`${review.base}\` and current repository behavior.`,
    "",
    `Inspection: ${review.inspection.changedFiles.length} changed ${
      review.inspection.changedFiles.length === 1 ? "file" : "files"
    }.`,
    "",
    "## Final Assessment",
    "",
    "Scale: readiness 5 is strongest; risk 5 is highest.",
    "",
    `Readiness: **${review.assessment.readiness.score}/5** — ${
      markdownText(review.assessment.readiness.rationale)
    }`,
    "",
    `Risk: **${review.assessment.risk.score}/5** — ${
      markdownText(review.assessment.risk.rationale)
    }`,
    "",
    "Validation performed:",
    ...review.validation.map(item => `- ${markdownText(item)}`),
  ];
  const blocking = review.findings.filter(
    finding => finding.priority === "P0" || finding.priority === "P1",
  ).length;
  const advisory = review.findings.length - blocking;
  lines.push(
    "",
    `Findings: ${blocking} blocking, ${advisory} advisory.`,
  );
  if (review.findings.length === 0) lines.push("", "No findings.");
  const populatedCategories = FINDING_CATEGORIES
    .map((category, categoryOrder) => ({
      ...category,
      categoryOrder,
      findings: review.findings.filter(finding => finding.category === category.value),
    }))
    .filter(category => category.findings.length > 0)
    .sort((left, right) => {
      const leftRank = Number(left.findings[0].priority.slice(1));
      const rightRank = Number(right.findings[0].priority.slice(1));
      return leftRank - rightRank || left.categoryOrder - right.categoryOrder;
    });
  for (const category of populatedCategories) {
    lines.push("", `## ${category.heading}`);
    for (const finding of category.findings) {
      lines.push(
        "",
        `**${finding.priority}: ${markdownText(finding.title)}**`,
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
    }
  }
  lines.push(
    "",
    `Residual risk: ${markdownText(review.residualRisk)}`,
    "",
    `[AI-PR-REVIEWED] ${review.head}`,
  );
  const event = review.findings.some(item => item.priority === "P0" || item.priority === "P1")
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
    const review = validateStructuredReview(
      lastValidateInput,
      base,
      head,
      manifest,
      metadata,
    );
    const payload = renderReview(review, contextId);
    writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write(`${payload.event}\n`);
    return;
  }
  throw new Error(
    "usage: ai-pr-review.ts build-discussion|build-context|validate (run with --help in repository docs)",
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
