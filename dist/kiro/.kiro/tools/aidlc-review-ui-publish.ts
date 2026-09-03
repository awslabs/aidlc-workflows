import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { GraphStage } from "./aidlc-graph.ts";
import { resolveArtifactInstances } from "./aidlc-artifact-resolution.ts";
import { artifactFormat, artifactKind } from "./aidlc-artifact-vocabulary.ts";
import {
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
  pendingFeedback,
  readConsumed,
  reviewUiEnabled,
  type ReviewManifest,
  type ReviewManifestArtifact,
  sha256Hex,
  snapshotDir,
  writeConsumed,
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
): Array<{ name: string; path: string }> {
  if (stageNode.resolved_produces) return [...stageNode.resolved_produces];
  const owner = stageNode as GraphStage;
  return (stageNode.produces ?? []).flatMap((name) =>
    resolveArtifactInstances(projectDir, name, owner, {
      ...(unit ? { runtimeUnits: [{ name: unit, kind: null }] } : {}),
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

  const resolved = resolvedArtifacts(projectDir, stageNode, unit);
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
      format: artifactFormat(item.name),
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
    mintReviewUiOpenLink(projectDir),
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
  const resolved = resolvedArtifacts(projectDir, stageNode, unit);
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
    mintReviewUiOpenLink(projectDir),
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
  const resolved = resolvedArtifacts(projectDir, stageNode, unit);
  return resolved.length > 0
    ? dirname(confinedProjectPath(projectDir, resolved[0].path))
    : fallbackStageDir(record, stageNode, unit);
}

/**
 * Consume every pending feedback file for the stage. Called by `report` ONLY
 * after the state transition that carried the feedback (GATE_REJECTED reason /
 * approval notes) has committed, so the failure mode is at-least-once: a crash
 * between the commit and this write re-ingests the same files on the next
 * report (a visible duplicate in the reason), never a silently lost round. The
 * inverse order would risk marking feedback consumed that no audit row holds.
 * `consumed.json` is written atomically (temp + rename) and keyed by
 * (file, sha256), so a rewritten feedback file is treated as new.
 */
export function ingestPendingFeedback(
  stageDir: string,
  result: "approved" | "rejected",
): FeedbackIngestion {
  if (!reviewUiEnabled()) return { files: [], digest: "", combinedBody: "" };
  const feedback = pendingFeedback(stageDir);
  if (feedback.length === 0) return { files: [], digest: "", combinedBody: "" };

  const consumedAt = new Date().toISOString();
  const consumed = readConsumed(stageDir);
  const entries: ConsumedEntry[] = feedback.map((item) => ({
    file: item.file,
    sha256: item.sha256,
    consumed_at: consumedAt,
    result,
  }));
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
