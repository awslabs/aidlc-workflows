import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_REVIEW_BYTES = 100_000;
const MAX_COMMENT_BYTES = 65_536;
const MAX_CATALOG_ENTRIES = 200;
const MAX_CONVERSATION_ENTRIES = 50;
const MAX_CONVERSATION_BODY_CHARACTERS = 8_000;
const MAX_AIDA_REVIEW_CHARACTERS = 40_000;
const MAX_BUG_TEST_FILES = 5;
const AI_ISSUE_REVIEW_MARKER = "<!-- ai-issue-review issue=";

export type FindingLevel = "blocking-question" | "recommendation";
export type FindingCategory =
  | "intent"
  | "direction"
  | "user-experience"
  | "scope"
  | "feasibility"
  | "risks";

const FINDING_CATEGORIES: Array<{ value: FindingCategory; heading: string }> = [
  { value: "intent", heading: "Intent and Problem Clarity" },
  { value: "direction", heading: "Direction" },
  { value: "user-experience", heading: "User Experience" },
  { value: "scope", heading: "Scope and Outcomes" },
  { value: "feasibility", heading: "Feasibility and Dependencies" },
  { value: "risks", heading: "Risks and Open Decisions" },
];

export interface IssueMetadata {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
}

export interface IssueCatalogEntry {
  number: number;
  title: string;
  state: string;
  labels: string[];
}

export interface IssueConversationEntry {
  id: number;
  actor: {
    login: string;
    association: string;
    maintainer: boolean;
  };
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueConversation {
  version: 1;
  issue: number;
  comments: IssueConversationEntry[];
}

export interface CurrentAidaReview {
  id: number;
  body: string;
  updatedAt: string;
}

export interface IssueContext {
  base: string;
  issue: IssueMetadata;
  catalog: IssueCatalogEntry[];
  conversation: IssueConversation;
  currentAidaReview: CurrentAidaReview | null;
  contextId: string;
}

export interface IssueMetadataEvidence {
  source: "ISSUE_TITLE" | "ISSUE_BODY";
  quote: string;
}

export interface RepositoryEvidence {
  source: "REPOSITORY";
  path: string;
  quote: string;
}

export interface ExistingIssueEvidence {
  source: "EXISTING_ISSUE";
  issue: number;
  quote: string;
}

export interface IssueCommentEvidence {
  source: "ISSUE_COMMENT";
  comment: number;
  author: string;
  quote: string;
}

export type FindingEvidence =
  | IssueMetadataEvidence
  | RepositoryEvidence
  | ExistingIssueEvidence
  | IssueCommentEvidence;

export interface Finding {
  level: FindingLevel;
  category: FindingCategory;
  title: string;
  evidence: FindingEvidence[];
  concern: string;
  impact: string;
  suggestedIssueChange: string;
}

export interface StructuredIssueReview {
  issue: number;
  contextId: string;
  inspection: {
    status: "complete";
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

export interface IssueCommentPayload {
  body: string;
}

export interface BugTriage {
  issue: number;
  contextId: string;
  classification: "bug-report" | "not-bug" | "unclear";
  confidence: "high" | "medium" | "low";
  rationale: string;
  testFiles: string[];
}

export interface BugVerification {
  triage: BugTriage;
  status: "tests-passed" | "tests-failed" | "timed-out" | "setup-failed" | "not-run";
  exitCode: number | null;
  outputTail: string;
}

function argValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character commit SHA`);
  }
}

function assertContextId(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("context id must be a lowercase SHA-256 digest");
  }
}

export function canonicalIssue(value: unknown): IssueMetadata {
  const candidate = record(value, "issue");
  if (candidate.pull_request !== undefined) {
    throw new Error("requested issue is a pull request");
  }
  const user = candidate.user && typeof candidate.user === "object" && !Array.isArray(candidate.user)
    ? candidate.user as Record<string, unknown>
    : {};
  const issue = {
    number: positiveInteger(candidate.number, "issue.number"),
    title: text(candidate.title).trim(),
    body: text(candidate.body),
    state: text(candidate.state),
    author: text(user.login) || "[deleted]",
  };
  if (issue.title.length === 0) throw new Error("issue.title must be non-empty");
  if (issue.title.length > 1000) throw new Error("issue.title is too long");
  if (!["open", "closed"].includes(issue.state)) throw new Error("issue.state is invalid");
  return issue;
}

export function canonicalCatalog(value: unknown, currentIssue: number): IssueCatalogEntry[] {
  if (!Array.isArray(value)) throw new Error("issue catalog must be an array");
  const catalog = value
    .filter(entry => {
      const candidate = record(entry, "issue catalog entry");
      return candidate.pull_request === undefined && candidate.number !== currentIssue;
    })
    .slice(0, MAX_CATALOG_ENTRIES)
    .map((entry, index): IssueCatalogEntry => {
      const candidate = record(entry, `issue catalog[${index}]`);
      const labels = Array.isArray(candidate.labels)
        ? candidate.labels.map((label, labelIndex) => {
          if (typeof label === "string") return label;
          const labelRecord = record(label, `issue catalog[${index}].labels[${labelIndex}]`);
          return text(labelRecord.name);
        }).filter(Boolean)
        : [];
      return {
        number: positiveInteger(candidate.number, `issue catalog[${index}].number`),
        title: text(candidate.title).trim(),
        state: text(candidate.state),
        labels,
      };
    })
    .filter(entry => entry.title.length > 0 && ["open", "closed"].includes(entry.state));
  return catalog.sort((left, right) => left.number - right.number);
}

function boundedConversationBody(value: unknown): string {
  const body = text(value);
  if (body.length <= MAX_CONVERSATION_BODY_CHARACTERS) return body;
  const half = Math.floor(MAX_CONVERSATION_BODY_CHARACTERS / 2);
  return `${body.slice(0, half)}\n...[comment truncated]...\n${body.slice(-half)}`;
}

export function canonicalConversation(
  value: unknown,
  issue: number,
): IssueConversation {
  if (!Array.isArray(value)) throw new Error("issue conversation must be an array");
  const comments = value
    .map((entry, index): IssueConversationEntry | null => {
      const candidate = record(entry, `issue conversation[${index}]`);
      const user = candidate.user && typeof candidate.user === "object" &&
          !Array.isArray(candidate.user)
        ? candidate.user as Record<string, unknown>
        : {};
      const login = text(user.login) || "[deleted]";
      const body = boundedConversationBody(candidate.body);
      if (login === "github-actions[bot]" && body.startsWith(AI_ISSUE_REVIEW_MARKER)) {
        return null;
      }
      const association = text(candidate.author_association).toUpperCase();
      return {
        id: positiveInteger(candidate.id, `issue conversation[${index}].id`),
        actor: {
          login,
          association,
          maintainer: ["OWNER", "MEMBER", "COLLABORATOR"].includes(association),
        },
        body,
        createdAt: text(candidate.created_at),
        updatedAt: text(candidate.updated_at),
      };
    })
    .filter((entry): entry is IssueConversationEntry => entry !== null)
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id - right.id
    )
    .slice(-MAX_CONVERSATION_ENTRIES);
  return { version: 1, issue, comments };
}

export function canonicalCurrentAidaReview(
  value: unknown,
  issue: number,
): CurrentAidaReview | null {
  if (!Array.isArray(value)) throw new Error("issue comments must be an array");
  const marker = `${AI_ISSUE_REVIEW_MARKER}${issue} -->`;
  const reviews = value
    .map((entry, index): CurrentAidaReview | null => {
      const candidate = record(entry, `issue comments[${index}]`);
      const user = candidate.user && typeof candidate.user === "object" &&
          !Array.isArray(candidate.user)
        ? candidate.user as Record<string, unknown>
        : {};
      const body = text(candidate.body);
      if (text(user.login) !== "github-actions[bot]" || !body.startsWith(marker)) {
        return null;
      }
      return {
        id: positiveInteger(candidate.id, `issue comments[${index}].id`),
        body: body.slice(0, MAX_AIDA_REVIEW_CHARACTERS),
        updatedAt: text(candidate.updated_at),
      };
    })
    .filter((entry): entry is CurrentAidaReview => entry !== null)
    .sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.id - right.id
    );
  return reviews.at(-1) ?? null;
}

function contextDigest(
  base: string,
  issue: IssueMetadata,
  catalog: IssueCatalogEntry[],
  conversation: IssueConversation,
): string {
  const hash = createHash("sha256");
  for (const [name, value] of [
    ["base", base],
    ["issue", JSON.stringify(issue)],
    ["catalog", JSON.stringify(catalog)],
    ["conversation", JSON.stringify(conversation)],
  ]) {
    hash.update(name);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function buildImmutableContext(
  issueRaw: unknown,
  catalogRaw: unknown,
  commentsRaw: unknown,
  base: string,
  outputDir: string,
): IssueContext {
  assertSha(base, "base");
  const issue = canonicalIssue(issueRaw);
  const catalog = canonicalCatalog(catalogRaw, issue.number);
  const conversation = canonicalConversation(commentsRaw, issue.number);
  const currentAidaReview = canonicalCurrentAidaReview(commentsRaw, issue.number);
  const contextId = contextDigest(base, issue, catalog, conversation);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, "issue.json"), `${JSON.stringify(issue, null, 2)}\n`);
  writeFileSync(resolve(outputDir, "issue-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(
    resolve(outputDir, "conversation.json"),
    `${JSON.stringify(conversation, null, 2)}\n`,
  );
  writeFileSync(
    resolve(outputDir, "current-aida-review.json"),
    `${JSON.stringify(currentAidaReview, null, 2)}\n`,
  );
  writeFileSync(resolve(outputDir, "base-sha.txt"), `${base}\n`);
  writeFileSync(resolve(outputDir, "context-id.txt"), `${contextId}\n`);
  return { base, issue, catalog, conversation, currentAidaReview, contextId };
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} characters`);
  }
  if (/<!--|\[AI-ISSUE-/m.test(value)) {
    throw new Error(`${field} contains reserved review syntax`);
  }
  return value.trim();
}

function assertBaseSha(base: string): void {
  if (!/^[0-9a-f]{40}$/.test(base)) {
    throw new Error("trusted repository base must be a 40-character lowercase SHA");
  }
}

function repositoryFile(root: string, base: string, path: string): string {
  assertBaseSha(base);
  const parts = path.split("/");
  const hasUnsafeCharacter = [...path].some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === "\\" || character === ":";
  });
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    hasUnsafeCharacter ||
    parts.some(part => part === "" || part === "." || part === "..") ||
    parts[0].startsWith(".ai-issue-review-")
  ) {
    throw new Error(`unsafe repository evidence path: ${JSON.stringify(path)}`);
  }
  let entry: string;
  try {
    entry = execFileSync("git", ["ls-tree", "-z", base, "--", path], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1_000_000,
    });
  } catch {
    throw new Error(`repository evidence base is unavailable: ${base}`);
  }
  const separator = entry.indexOf("\t");
  const header = separator >= 0 ? entry.slice(0, separator) : "";
  const entryPath = separator >= 0 ? entry.slice(separator + 1, -1) : "";
  const mode = header.split(" ")[0];
  if ((mode !== "100644" && mode !== "100755") || entryPath !== path) {
    throw new Error(`repository evidence path is not a trusted base file: ${path}`);
  }
  try {
    return execFileSync("git", ["cat-file", "-p", `${base}:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10_000_000,
    });
  } catch {
    throw new Error(`repository evidence path cannot be read from trusted base: ${path}`);
  }
}

function trustedBugTestFile(root: string, base: string, path: string): string {
  if (
    !/^tests\/(smoke|unit|integration)\/[A-Za-z0-9._/-]+\.test\.ts$/.test(path) ||
    path.split("/").some(part => part === "." || part === "..")
  ) {
    throw new Error(`bug triage selected an unsupported test path: ${path}`);
  }
  repositoryFile(root, base, path);
  return path;
}

export function validateBugTriage(
  raw: string,
  expectedIssue: number,
  expectedContextId: string,
  expectedBase: string,
  repositoryRoot = process.cwd(),
): BugTriage {
  assertContextId(expectedContextId);
  assertBaseSha(expectedBase);
  if (Buffer.byteLength(raw, "utf8") > 20_000) {
    throw new Error("bug triage exceeds 20000 bytes");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("bug triage must be valid JSON");
  }
  const candidate = record(parsed, "bug triage");
  if (candidate.issue !== expectedIssue || candidate.contextId !== expectedContextId) {
    throw new Error("bug triage does not match the immutable context");
  }
  if (
    candidate.classification !== "bug-report" &&
    candidate.classification !== "not-bug" &&
    candidate.classification !== "unclear"
  ) {
    throw new Error("bug triage classification is invalid");
  }
  if (
    candidate.confidence !== "high" &&
    candidate.confidence !== "medium" &&
    candidate.confidence !== "low"
  ) {
    throw new Error("bug triage confidence is invalid");
  }
  if (!Array.isArray(candidate.testFiles) || candidate.testFiles.length > MAX_BUG_TEST_FILES) {
    throw new Error(`bug triage may select at most ${MAX_BUG_TEST_FILES} test files`);
  }
  const testFiles = [...new Set(candidate.testFiles.map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`bug triage testFiles[${index}] must be a string`);
    }
    return trustedBugTestFile(repositoryRoot, expectedBase, value);
  }))];
  if (candidate.classification !== "bug-report" && testFiles.length > 0) {
    throw new Error("non-bug triage cannot select test files");
  }
  return {
    issue: expectedIssue,
    contextId: expectedContextId,
    classification: candidate.classification,
    confidence: candidate.confidence,
    rationale: requiredText(candidate.rationale, "bug triage rationale", 1000),
    testFiles,
  };
}

export function validateBugVerification(
  value: unknown,
  expectedIssue: number,
  expectedContextId: string,
  expectedBase: string,
  repositoryRoot: string,
): BugVerification {
  const candidate = record(value, "bug verification");
  const triage = validateBugTriage(
    JSON.stringify(candidate.triage),
    expectedIssue,
    expectedContextId,
    expectedBase,
    repositoryRoot,
  );
  if (
    candidate.status !== "tests-passed" &&
    candidate.status !== "tests-failed" &&
    candidate.status !== "timed-out" &&
    candidate.status !== "setup-failed" &&
    candidate.status !== "not-run"
  ) {
    throw new Error("bug verification status is invalid");
  }
  if (
    candidate.exitCode !== null &&
    (typeof candidate.exitCode !== "number" || !Number.isInteger(candidate.exitCode))
  ) {
    throw new Error("bug verification exitCode is invalid");
  }
  const outputTail = text(candidate.outputTail);
  if (Buffer.byteLength(outputTail, "utf8") > 20_000) {
    throw new Error("bug verification output tail exceeds 20000 bytes");
  }
  if (triage.classification !== "bug-report" && candidate.status !== "not-run") {
    throw new Error("non-bug verification must not run tests");
  }
  if (triage.testFiles.length === 0 && candidate.status !== "not-run") {
    throw new Error("bug verification without selected tests must not run");
  }
  if (
    triage.classification === "bug-report" &&
    triage.testFiles.length > 0 &&
    candidate.status === "not-run"
  ) {
    throw new Error("bug verification with selected tests must record an execution result");
  }
  if (
    (candidate.status === "not-run" && candidate.exitCode !== null) ||
    (candidate.status !== "not-run" && candidate.exitCode === null)
  ) {
    throw new Error("bug verification exitCode does not match its status");
  }
  return {
    triage,
    status: candidate.status,
    exitCode: candidate.exitCode,
    outputTail,
  };
}

function assessmentDimension(
  assessment: Record<string, unknown>,
  name: "readiness" | "risk",
): StructuredIssueReview["assessment"]["readiness"] {
  const candidate = record(assessment[name], `assessment.${name}`);
  if (
    typeof candidate.score !== "number" ||
    !Number.isInteger(candidate.score) ||
    candidate.score < 1 ||
    candidate.score > 5
  ) {
    throw new Error(`assessment.${name}.score must be an integer from 1 through 5`);
  }
  return {
    score: candidate.score,
    rationale: requiredText(candidate.rationale, `assessment.${name}.rationale`, 1000),
  };
}

export function validateStructuredIssueReview(
  raw: string,
  expectedIssue: number,
  expectedContextId: string,
  expectedBase: string,
  metadata: IssueMetadata,
  catalog: IssueCatalogEntry[],
  conversation: IssueConversation,
  repositoryRoot = process.cwd(),
): StructuredIssueReview {
  assertContextId(expectedContextId);
  assertBaseSha(expectedBase);
  if (Buffer.byteLength(raw, "utf8") > MAX_REVIEW_BYTES) {
    throw new Error(`review exceeds ${MAX_REVIEW_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("review must be valid JSON");
  }
  const candidate = record(parsed, "review");
  if (candidate.issue !== expectedIssue || metadata.number !== expectedIssue) {
    throw new Error("review issue does not match the immutable context");
  }
  if (candidate.contextId !== expectedContextId) {
    throw new Error("review context id does not match the immutable context");
  }
  const inspection = record(candidate.inspection, "inspection");
  if (inspection.status !== "complete") throw new Error("inspection did not complete");
  if (!Array.isArray(candidate.validation) || candidate.validation.length === 0) {
    throw new Error("validation must be a non-empty string array");
  }
  const validation = candidate.validation.map((value, index) =>
    requiredText(value, `validation[${index}]`, 500)
  );
  const assessmentCandidate = record(candidate.assessment, "assessment");
  const assessment = {
    readiness: assessmentDimension(assessmentCandidate, "readiness"),
    risk: assessmentDimension(assessmentCandidate, "risk"),
  };
  if (!Array.isArray(candidate.findings)) throw new Error("findings must be an array");

  let recommendationsStarted = false;
  const findings = candidate.findings.map((value, index): Finding => {
    const finding = record(value, `findings[${index}]`);
    if (finding.level !== "blocking-question" && finding.level !== "recommendation") {
      throw new Error(`findings[${index}].level is invalid`);
    }
    if (finding.level === "recommendation") recommendationsStarted = true;
    else if (recommendationsStarted) {
      throw new Error("blocking questions must appear before recommendations");
    }
    if (
      typeof finding.category !== "string" ||
      !FINDING_CATEGORIES.some(category => category.value === finding.category)
    ) {
      throw new Error(`findings[${index}].category is invalid`);
    }
    if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
      throw new Error(`findings[${index}].evidence must be non-empty`);
    }
    const evidence = finding.evidence.map((value, evidenceIndex): FindingEvidence => {
      const item = record(value, `findings[${index}].evidence[${evidenceIndex}]`);
      if (item.source === "ISSUE_TITLE" || item.source === "ISSUE_BODY") {
        const quote = requiredText(
          item.quote,
          `findings[${index}].evidence[${evidenceIndex}].quote`,
          500,
        );
        const source = item.source === "ISSUE_TITLE" ? metadata.title : metadata.body;
        if (!source.includes(quote)) {
          throw new Error(`${item.source} evidence quote is not present in issue metadata`);
        }
        return { source: item.source, quote };
      }
      if (item.source === "REPOSITORY") {
        const path = requiredText(
          item.path,
          `findings[${index}].evidence[${evidenceIndex}].path`,
          500,
        );
        const quote = requiredText(
          item.quote,
          `findings[${index}].evidence[${evidenceIndex}].quote`,
          500,
        );
        if (!repositoryFile(repositoryRoot, expectedBase, path).includes(quote)) {
          throw new Error(`REPOSITORY evidence quote is not present in ${path}`);
        }
        return { source: "REPOSITORY", path, quote };
      }
      if (item.source === "EXISTING_ISSUE") {
        const issue = positiveInteger(
          item.issue,
          `findings[${index}].evidence[${evidenceIndex}].issue`,
        );
        const quote = requiredText(
          item.quote,
          `findings[${index}].evidence[${evidenceIndex}].quote`,
          500,
        );
        const catalogEntry = catalog.find(entry => entry.number === issue);
        if (!catalogEntry?.title.includes(quote)) {
          throw new Error(`EXISTING_ISSUE evidence quote is not present in issue #${issue}`);
        }
        return { source: "EXISTING_ISSUE", issue, quote };
      }
      if (item.source === "ISSUE_COMMENT") {
        const comment = positiveInteger(
          item.comment,
          `findings[${index}].evidence[${evidenceIndex}].comment`,
        );
        const quote = requiredText(
          item.quote,
          `findings[${index}].evidence[${evidenceIndex}].quote`,
          500,
        );
        const entry = conversation.comments.find(candidate => candidate.id === comment);
        if (!entry?.body.includes(quote)) {
          throw new Error(`ISSUE_COMMENT evidence quote is not present in comment ${comment}`);
        }
        if (item.author !== entry.actor.login) {
          throw new Error(`ISSUE_COMMENT evidence author does not match comment ${comment}`);
        }
        return {
          source: "ISSUE_COMMENT",
          comment,
          author: entry.actor.login,
          quote,
        };
      }
      throw new Error(`findings[${index}].evidence[${evidenceIndex}].source is invalid`);
    });
    const title = requiredText(finding.title, `findings[${index}].title`, 160);
    if (/[\r\n]/.test(title)) throw new Error(`findings[${index}].title must be one line`);
    return {
      level: finding.level,
      category: finding.category as FindingCategory,
      title,
      evidence,
      concern: requiredText(finding.concern, `findings[${index}].concern`, 3000),
      impact: requiredText(finding.impact, `findings[${index}].impact`, 1500),
      suggestedIssueChange: requiredText(
        finding.suggestedIssueChange,
        `findings[${index}].suggestedIssueChange`,
        2000,
      ),
    };
  });
  return {
    issue: expectedIssue,
    contextId: expectedContextId,
    inspection: { status: "complete" },
    validation,
    assessment,
    findings,
    residualRisk: requiredText(candidate.residualRisk, "residualRisk", 1000),
  };
}

function markdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]()#!|])/g, "\\$1");
}

function evidenceText(evidence: FindingEvidence): string {
  if (evidence.source === "ISSUE_TITLE") {
    return `issue title: “${markdownText(evidence.quote)}”`;
  }
  if (evidence.source === "ISSUE_BODY") {
    return `issue body: “${markdownText(evidence.quote)}”`;
  }
  if (evidence.source === "EXISTING_ISSUE") {
    return `issue #${evidence.issue}: “${markdownText(evidence.quote)}”`;
  }
  if (evidence.source === "ISSUE_COMMENT") {
    return `comment by @${markdownText(evidence.author)}: “${markdownText(evidence.quote)}”`;
  }
  if (evidence.source === "REPOSITORY") {
    return `<code>${markdownText(evidence.path)}</code>: “${markdownText(evidence.quote)}”`;
  }
  throw new Error("unsupported issue-review evidence");
}

export function renderIssueReview(
  review: StructuredIssueReview,
  bugVerification?: BugVerification,
): IssueCommentPayload {
  const blocking = review.findings.filter(finding => finding.level === "blocking-question").length;
  const recommendations = review.findings.length - blocking;
  const lines = [
    `<!-- ai-issue-review issue=${review.issue} -->`,
    `<!-- ai-issue-review context=${review.contextId} -->`,
    `I reviewed issue #${review.issue} and its current conversation as a proposed product and workflow change.`,
    "",
    "## Final Assessment",
    "",
    "Human decision aid only: **Readiness 5/5 is best; Risk 1/5 is best.** These scores do not prioritize, approve, reject, or implement the issue.",
    "",
    `Readiness: **${review.assessment.readiness.score}/5** — ${
      markdownText(review.assessment.readiness.rationale)
    }`,
    "",
    `Risk: **${review.assessment.risk.score}/5** — ${markdownText(review.assessment.risk.rationale)}`,
    "",
    `Findings: ${blocking} blocking ${
      blocking === 1 ? "question" : "questions"
    }, ${recommendations} ${recommendations === 1 ? "recommendation" : "recommendations"}.`,
    "",
    "Validation performed:",
    ...review.validation.map(item => `- ${markdownText(item)}`),
  ];

  if (bugVerification?.triage.classification === "bug-report") {
    const statusLabel = {
      "tests-passed": "selected tests passed; they did not reproduce a failure",
      "tests-failed": "selected tests failed; the failure must be compared with the report",
      "timed-out": "test execution timed out",
      "setup-failed": "the isolated test environment could not be prepared",
      "not-run": "not run",
    }[bugVerification.status];
    lines.push(
      "",
      "## Bug Verification",
      "",
      `Classification: **bug report** (${bugVerification.triage.confidence} confidence).`,
      "",
      `Execution: **${statusLabel}**.`,
      "",
      `Reason: ${markdownText(bugVerification.triage.rationale)}`,
    );
    if (bugVerification.triage.testFiles.length > 0) {
      lines.push(
        "",
        "Trusted tests selected:",
        ...bugVerification.triage.testFiles.map(path => `- <code>${markdownText(path)}</code>`),
      );
    } else {
      lines.push(
        "",
        "No existing trusted test was specific enough to run automatically.",
      );
    }
  }

  for (const category of FINDING_CATEGORIES) {
    lines.push("", `## ${category.heading}`);
    const categoryFindings = review.findings.filter(finding => finding.category === category.value);
    if (categoryFindings.length === 0) {
      lines.push("", "No material gap identified.");
      continue;
    }
    for (const finding of categoryFindings) {
      const label = finding.level === "blocking-question" ? "Blocking question" : "Recommendation";
      lines.push(
        "",
        `**${label}: ${markdownText(finding.title)}**`,
        "",
        `Evidence: ${finding.evidence.map(evidenceText).join(", ")}.`,
        "",
        `Concern: ${markdownText(finding.concern)}`,
        "",
        `Why it matters: ${markdownText(finding.impact)}`,
        "",
        `Suggested issue change: ${markdownText(finding.suggestedIssueChange)}`,
      );
    }
  }
  lines.push(
    "",
    `Residual risk: ${markdownText(review.residualRisk)}`,
    "",
    "Reviewed by AIDA (AI-DLC Developer Agent).",
  );
  const body = lines.join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) {
    throw new Error(`rendered comment exceeds ${MAX_COMMENT_BYTES} bytes`);
  }
  return { body };
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

let lastValidateInput: string | null = null;

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "canonicalize") {
    const input = JSON.parse(readFileSync(argValue(args, "--input"), "utf8"));
    writeFileSync(
      argValue(args, "--output"),
      `${JSON.stringify(canonicalIssue(input), null, 2)}\n`,
    );
    return;
  }
  if (command === "canonicalize-conversation") {
    const input = JSON.parse(readFileSync(argValue(args, "--input"), "utf8"));
    writeFileSync(
      argValue(args, "--output"),
      `${JSON.stringify(
        canonicalConversation(input, Number(argValue(args, "--issue"))),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "validate-triage") {
    const input = readFileSync(argValue(args, "--input"), "utf8");
    const triage = validateBugTriage(
      input,
      Number(argValue(args, "--issue")),
      argValue(args, "--context-id"),
      argValue(args, "--base"),
      args.includes("--repository-root") ? argValue(args, "--repository-root") : process.cwd(),
    );
    writeFileSync(argValue(args, "--output"), `${JSON.stringify(triage, null, 2)}\n`);
    return;
  }
  if (command === "build-context") {
    const issue = JSON.parse(readFileSync(argValue(args, "--issue"), "utf8"));
    const catalog = JSON.parse(readFileSync(argValue(args, "--catalog"), "utf8"));
    const comments = JSON.parse(readFileSync(argValue(args, "--comments"), "utf8"));
    buildImmutableContext(
      issue,
      catalog,
      comments,
      argValue(args, "--base"),
      argValue(args, "--output"),
    );
    return;
  }
  if (command === "validate") {
    const input = argValue(args, "--input");
    const metadata = JSON.parse(
      readFileSync(argValue(args, "--metadata"), "utf8"),
    ) as IssueMetadata;
    const catalog = JSON.parse(
      readFileSync(argValue(args, "--catalog"), "utf8"),
    ) as IssueCatalogEntry[];
    const conversation = JSON.parse(
      readFileSync(argValue(args, "--conversation"), "utf8"),
    ) as IssueConversation;
    const bugVerification = args.includes("--bug-verification")
      ? validateBugVerification(
        JSON.parse(readFileSync(argValue(args, "--bug-verification"), "utf8")),
        Number(argValue(args, "--issue")),
        argValue(args, "--context-id"),
        argValue(args, "--base"),
        args.includes("--repository-root") ? argValue(args, "--repository-root") : process.cwd(),
      )
      : undefined;
    lastValidateInput = readFileSync(input, "utf8");
    const review = validateStructuredIssueReview(
      lastValidateInput,
      Number(argValue(args, "--issue")),
      argValue(args, "--context-id"),
      argValue(args, "--base"),
      metadata,
      catalog,
      conversation,
      args.includes("--repository-root") ? argValue(args, "--repository-root") : process.cwd(),
    );
    writeFileSync(
      argValue(args, "--output"),
      `${JSON.stringify(renderIssueReview(review, bugVerification), null, 2)}\n`,
    );
    return;
  }
  throw new Error(
    "usage: ai-issue-review.ts canonicalize|canonicalize-conversation|build-context|validate-triage|validate",
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::ai-issue-review ${escapeWorkflowCommand(message.slice(0, 1000))}\n`);
    if (lastValidateInput !== null) {
      process.stderr.write("::error::ai-issue-review final response was rejected\n");
    }
    process.exit(1);
  }
}
