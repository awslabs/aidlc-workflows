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
const MAX_DIFF_BYTES = 5_000_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_SNAPSHOT_BYTES = 20_000_000;
const MAX_REVIEW_BYTES = 100_000;

export type Priority = "P0" | "P1" | "P2" | "P3";
export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";
export type DiffSide = "LEFT" | "RIGHT";

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

export interface MetadataEvidence {
  source: "PR_TITLE" | "PR_BODY";
  quote: string;
}

export type FindingEvidence = DiffEvidence | MetadataEvidence;

export interface ReviewMetadata {
  title: string;
  body: string;
}

export interface Finding {
  priority: Priority;
  title: string;
  evidence: FindingEvidence[];
  problem: string;
  impact: string;
  requiredCorrection: string;
}

export interface StructuredReview {
  base: string;
  head: string;
  validation: string[];
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
    maxBuffer: MAX_SNAPSHOT_BYTES + MAX_DIFF_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
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

function rangesForFile(
  base: string,
  head: string,
  path: string,
  repoDir: string,
): { added: LineRange[]; deleted: LineRange[] } {
  const patch = git(
    ["diff", "--unified=0", "--no-color", `${base}...${head}`, "--", path],
    "utf8",
    repoDir,
  ) as string;
  const added: LineRange[] = [];
  const deleted: LineRange[] = [];
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? "1");
    const newStart = Number(match[3]);
    const newCount = Number(match[4] ?? "1");
    if (oldCount > 0) deleted.push({ start: oldStart, end: oldStart + oldCount - 1 });
    if (newCount > 0) added.push({ start: newStart, end: newStart + newCount - 1 });
  }
  return { added, deleted };
}

function writeSnapshot(outputDir: string, head: string, file: ChangedFile, repoDir: string): number {
  if (file.status.startsWith("D")) return 0;
  const content = git(["show", `${head}:${file.path}`], undefined, repoDir) as Buffer;
  if (content.byteLength > MAX_FILE_BYTES) {
    throw new Error(`${file.path} exceeds the ${MAX_FILE_BYTES}-byte snapshot limit`);
  }
  const snapshot = join("head", file.path);
  const destination = resolve(outputDir, snapshot);
  const root = `${resolve(outputDir)}${sep}`;
  if (!destination.startsWith(root)) throw new Error(`snapshot escaped context root: ${file.path}`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  file.snapshot = snapshot;
  return content.byteLength;
}

function contextDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (entry === "context-id.txt") continue;
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else {
        hash.update(relative(root, path));
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
    ["diff", "--binary", "--find-renames", `${base}...${head}`],
    undefined,
    repoDir,
  ) as Buffer;
  if (diff.byteLength > MAX_DIFF_BYTES) {
    throw new Error(`PR diff exceeds ${MAX_DIFF_BYTES} bytes`);
  }
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

  let snapshotBytes = 0;
  const files = entries.map(entry => {
    const ranges = rangesForFile(base, head, entry.path, repoDir);
    const file: ChangedFile = { ...entry, ...ranges };
    snapshotBytes += writeSnapshot(outputDir, head, file, repoDir);
    if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`head snapshots exceed ${MAX_SNAPSHOT_BYTES} bytes`);
    }
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

  if (!Array.isArray(candidate.validation) || candidate.validation.length === 0) {
    throw new Error("validation must be a non-empty string array");
  }
  const validation = candidate.validation.map((value, index) =>
    requiredText(value, `validation[${index}]`, 500),
  );
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
  return { base: expectedBase, head: expectedHead, validation, findings, residualRisk };
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
    "Validation performed:",
    ...review.validation.map(item => `- ${markdownText(item)}`),
  ];
  if (review.findings.length === 0) lines.push("", "No findings.");
  for (const finding of review.findings) {
    lines.push(
      "",
      `**${finding.priority}: ${markdownText(finding.title)}**`,
      "",
      `Evidence: ${finding.evidence
        .map(item => {
          if (item.source !== "DIFF") {
            const label = item.source === "PR_TITLE" ? "PR title" : "PR body";
            return `${label}: “${markdownText(item.quote)}”`;
          }
          return `<code>${codeText(item.path)}:${item.line}</code>${
            item.side === "LEFT" ? " (deleted line)" : ""
          }`;
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

function main(): void {
  const [command, ...args] = process.argv.slice(2);
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
    const review = validateStructuredReview(
      readFileSync(input, "utf8"),
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
    "usage: ai-pr-review.ts build-context|validate (run with --help in repository docs)",
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ai-pr-review: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
