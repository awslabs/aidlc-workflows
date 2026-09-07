import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { GraphStage } from "./aidlc-graph.ts";
import { resolveArtifactInstances } from "./aidlc-artifact-resolution.ts";
import {
  artifactFormat,
  type ArtifactFormats,
  artifactKind,
} from "./aidlc-artifact-vocabulary.ts";
import {
  artifactFormatsForProject,
  assertNoSymlinkInChainOrThrow,
  readRegularFileNoFollowOrThrow,
  recordDir,
  toPosix,
} from "./aidlc-lib.ts";
import {
  atomicWriteJson,
  type ConsumedEntry,
  type CurrentPointer,
  type CurrentReviewState,
  currentPointerPath,
  manifestPath,
  mintReviewUiOpenLink,
  listFeedbackFiles,
  nextSequence,
  parseResponsesFile,
  pendingFeedback,
  pendingDecisions,
  readConsumed,
  reviewUiEnabled,
  reviewUiStrict,
  RESPONSES_PREFIX,
  responsesFileName,
  type ResponsesFile,
  stageReviewUiDir,
  type ReviewManifest,
  type ReviewManifestArtifact,
  sha256Hex,
  snapshotDir,
  writeConsumed,
  endsWithFor,
} from "./aidlc-review-ui-shared.ts";

export interface ReviewPublishStageNode {
  slug: string;
  phase: string;
  produces?: readonly string[];
  review_artifact?: string;
  for_each?: string;
  produces_kinds?: Readonly<Record<string, readonly string[]>>;
  /** Engine-resolved paths preserve the exact directive placement rules. */
  resolved_produces?: ReadonlyArray<{ name: string; path: string }>;
}

export interface PublishedReview {
  stageDir: string;
  manifest: ReviewManifest;
  pointer: CurrentPointer;
}

export interface FeedbackIngestion {
  files: string[];
  digest: string;
  combinedBody: string;
}

export interface PreparedReviewResponses {
  source: Buffer;
  sourcePath: string;
  targetPath: string;
  targetFile: string;
  parsed: ResponsesFile;
}

function projectRelative(projectDir: string, absolute: string): string {
  return toPosix(relative(projectDir, absolute));
}

function confinedProjectPath(projectDir: string, path: string): string {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Review artifact path escapes the project: ${path}`);
  }
  const absolute = resolve(projectDir, ...path.split("/"));
  const rel = relative(resolve(projectDir), absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Review artifact path escapes the project: ${path}`);
  }
  const posix = toPosix(rel);
  if (posix !== "aidlc" && !posix.startsWith("aidlc/")) {
    throw new Error(`Review artifact path is outside aidlc/: ${path}`);
  }
  return absolute;
}

function resolvedArtifacts(
  projectDir: string,
  stageNode: ReviewPublishStageNode,
  unit: string | null,
  formats: ArtifactFormats,
): Array<{ name: string; path: string }> {
  if (stageNode.resolved_produces) return [...stageNode.resolved_produces];
  const owner = stageNode as GraphStage;
  return (stageNode.produces ?? []).flatMap((name) =>
    resolveArtifactInstances(projectDir, name, owner, {
      ...(unit ? { runtimeUnits: [{ name: unit, kind: null }] } : {}),
      formats,
    }).map((instance) => ({ name, path: instance.relativePath })),
  );
}

function fallbackStageDir(
  record: string,
  stageNode: ReviewPublishStageNode,
  unit: string | null,
): string {
  return stageNode.for_each === "unit-of-work" && unit
    ? join(record, "construction", unit, stageNode.slug)
    : join(record, stageNode.phase, stageNode.slug);
}

function pointerFor(
  projectDir: string,
  stageNode: ReviewPublishStageNode,
  unit: string | null,
  revision: number,
  state: CurrentReviewState,
  stageDir: string,
  now: string,
  open: CurrentPointer["open"],
): CurrentPointer {
  return {
    version: 1,
    state,
    stage: stageNode.slug,
    unit,
    stage_dir: projectRelative(projectDir, stageDir),
    revision,
    updated_at: now,
    open,
    ends_with: endsWithFor(state),
  };
}

export function publishReviewManifest(
  projectDir: string,
  stageNode: ReviewPublishStageNode,
  unit: string | null,
  revision: number,
  state: CurrentReviewState,
): PublishedReview | null {
  if (!reviewUiEnabled()) return null;
  const record = recordDir(projectDir);
  if (!record) return null;
  const formats = artifactFormatsForProject(projectDir);

  const resolved = resolvedArtifacts(projectDir, stageNode, unit, formats);
  const stageDir = resolved.length > 0
    ? dirname(confinedProjectPath(projectDir, resolved[0].path))
    : fallbackStageDir(record, stageNode, unit);
  const projectRoot = realpathSync(projectDir);
  const artifacts: ReviewManifestArtifact[] = [];
  const snapshot = snapshotDir(stageDir, revision);

  for (const item of resolved) {
    const absolute = confinedProjectPath(projectDir, item.path);
    let bytes: Buffer | null = null;
    if (existsSync(absolute)) {
      assertNoSymlinkInChainOrThrow(projectRoot, relative(projectDir, absolute));
      bytes = readRegularFileNoFollowOrThrow(absolute, `review artifact "${item.path}"`);
      mkdirSync(snapshot, { recursive: true });
      writeFileSync(join(snapshot, basename(absolute)), bytes);
    }
    artifacts.push({
      name: item.name,
      path: toPosix(item.path),
      format: artifactFormat(item.name, formats),
      kind: artifactKind(item.name) ?? "document",
      sha256: bytes ? sha256Hex(bytes) : null,
      exists: bytes !== null,
    });
  }

  const now = new Date().toISOString();
  const questionsAbsolute = join(stageDir, `${stageNode.slug}-questions.md`);
  const reviewArtifact = stageNode.review_artifact
    ? artifacts.find((artifact) => artifact.name === stageNode.review_artifact)?.path ?? null
    : null;
  const manifest: ReviewManifest = {
    version: 1,
    stage: stageNode.slug,
    phase: stageNode.phase,
    unit,
    revision,
    opened_at: now,
    artifacts,
    review_artifact: reviewArtifact,
    questions_file: existsSync(questionsAbsolute)
      ? projectRelative(projectDir, questionsAbsolute)
      : null,
    guide: null,
  };
  const pointer = pointerFor(
    projectDir,
    stageNode,
    unit,
    revision,
    state,
    stageDir,
    now,
    reviewUiStrict() ? mintReviewUiOpenLink(projectDir) : null,
  );
  atomicWriteJson(manifestPath(stageDir), manifest);
  atomicWriteJson(currentPointerPath(record), pointer);
  return { stageDir, manifest, pointer };
}

export function publishReviewPointer(
  projectDir: string,
  stageNode: ReviewPublishStageNode,
  unit: string | null,
  revision: number,
  state: CurrentReviewState,
): CurrentPointer | null {
  if (!reviewUiEnabled()) return null;
  const record = recordDir(projectDir);
  if (!record) return null;
  const formats = artifactFormatsForProject(projectDir);
  const resolved = resolvedArtifacts(projectDir, stageNode, unit, formats);
  const stageDir = resolved.length > 0
    ? dirname(confinedProjectPath(projectDir, resolved[0].path))
    : fallbackStageDir(record, stageNode, unit);
  const pointer = pointerFor(
    projectDir,
    stageNode,
    unit,
    revision,
    state,
    stageDir,
    new Date().toISOString(),
    reviewUiStrict() ? mintReviewUiOpenLink(projectDir) : null,
  );
  atomicWriteJson(currentPointerPath(record), pointer);
  return pointer;
}

export function reviewStageDir(
  projectDir: string,
  stageNode: ReviewPublishStageNode,
  unit: string | null,
): string | null {
  if (!reviewUiEnabled()) return null;
  const record = recordDir(projectDir);
  if (!record) return null;
  const formats = artifactFormatsForProject(projectDir);
  const resolved = resolvedArtifacts(projectDir, stageNode, unit, formats);
  return resolved.length > 0
    ? dirname(confinedProjectPath(projectDir, resolved[0].path))
    : fallbackStageDir(record, stageNode, unit);
}

/**
 * Validate a revised-gate disposition list before the state transition. The
 * returned immutable plan is persisted only after `revise` commits.
 */
export function prepareReviewResponses(
  stageDir: string,
  sourcePath: string,
  stage: string,
  unit: string | null,
  revision: number,
): PreparedReviewResponses {
  let source: Buffer;
  try {
    source = readRegularFileNoFollowOrThrow(
      sourcePath,
      "review UI responses file",
      1024 * 1024,
    );
  } catch (error) {
    throw new Error(
      `Could not read --responses file "${sourcePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseResponsesFile(basename(sourcePath), source.toString("utf-8"));
  if (!parsed) {
    throw new Error(
      `Invalid --responses file "${sourcePath}": expected ` +
        '`# Feedback addressed: <stage> (revision N)` and unique lines `- aN: applied|kept|answered — <text>`.',
    );
  }
  if (parsed.stage !== stage) {
    throw new Error(
      `Invalid --responses file "${sourcePath}": heading stage "${parsed.stage}" does not match "${stage}".`,
    );
  }
  if (parsed.revision !== revision) {
    throw new Error(
      `Invalid --responses file "${sourcePath}": revision ${parsed.revision} does not match current revision ${revision}.`,
    );
  }
  const knownIds = new Set(
    listFeedbackFiles(stageDir)
      .filter((feedback) =>
        feedback.frontmatter.stage === stage && feedback.frontmatter.unit === unit
      )
      .flatMap((feedback) => feedback.remarks.map((remark) => remark.id)),
  );
  const unknown = parsed.entries
    .map((entry) => entry.remark_id)
    .filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid --responses file "${sourcePath}": unknown feedback remark id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }

  const sourceAbsolute = resolve(sourcePath);
  const reviewDir = stageReviewUiDir(stageDir);
  const sourceAlreadyPublished = dirname(sourceAbsolute) === resolve(reviewDir) &&
    /^responses-[0-9]{3,}\.md$/.test(basename(sourceAbsolute));
  const targetFile = sourceAlreadyPublished
    ? basename(sourceAbsolute)
    : responsesFileName(nextSequence(reviewDir, RESPONSES_PREFIX));
  return {
    source,
    sourcePath: sourceAbsolute,
    targetPath: join(reviewDir, targetFile),
    targetFile,
    parsed,
  };
}

export function persistReviewResponses(plan: PreparedReviewResponses): string {
  if (plan.sourcePath === plan.targetPath) return plan.targetFile;
  mkdirSync(dirname(plan.targetPath), { recursive: true });
  writeFileSync(plan.targetPath, plan.source, { flag: "wx" });
  return plan.targetFile;
}

/**
 * Consume pending browser feedback and decision files only after the lifecycle
 * transition commits. This preserves the same at-least-once crash boundary for
 * both record-side inputs.
 */
export function ingestPendingFeedback(
  stageDir: string,
  result: "approved" | "rejected",
  target?: { stage: string; unit: string | null; revision: number },
): FeedbackIngestion {
  if (!reviewUiEnabled()) return { files: [], digest: "", combinedBody: "" };
  const feedback = pendingFeedback(stageDir);
  const decisions = pendingDecisions(stageDir).filter((item) =>
    !target ||
    (
      item.submission.stage === target.stage &&
      item.submission.unit === target.unit &&
      item.submission.revision === target.revision
    )
  );
  if (feedback.length === 0 && decisions.length === 0) {
    return { files: [], digest: "", combinedBody: "" };
  }

  const consumedAt = new Date().toISOString();
  const consumed = readConsumed(stageDir);
  const entries: ConsumedEntry[] = [
    ...feedback.map((item): ConsumedEntry => ({
      file: item.file,
      sha256: item.sha256,
      consumed_at: consumedAt,
      result,
    })),
    ...decisions.map((item): ConsumedEntry => ({
      file: item.file,
      sha256: item.sha256,
      consumed_at: consumedAt,
      result: "decision-applied",
    })),
  ];
  writeConsumed(stageDir, {
    version: 1,
    entries: [...consumed.entries, ...entries],
  });

  return {
    files: feedback.map((item) => item.file),
    digest: sha256Hex(feedback.map((item) => item.body).join("")),
    combinedBody: feedback.map((item) => item.body).join("\n\n"),
  };
}
