#!/usr/bin/env bun
// Shared shape of a preview publication: the tag message that binds a preview
// tag in the publication repository to its source commit, and the plan record
// the authorize job hands to the promote job.
import { readFileSync } from "node:fs";
import {
  parseVersion,
  PREVIEW_CHANNEL,
  PREVIEW_VERSION,
  requireVersion,
} from "../core/tools/aidlc-channel.ts";

export type PreviewPlan = {
  schemaVersion: 1;
  version: string;
  tag: string;
  sourceRepository: string;
  sourceDigest: string;
  previousSourceDigest: string | null;
  notes: { name: string; body: string };
};

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SOURCE_LINE = /^Source: ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([a-f0-9]{40})$/m;

export function previewReleaseName(version: string): string {
  if (!PREVIEW_VERSION.test(version)) {
    throw new Error(`not a ${PREVIEW_CHANNEL} version id: ${version}`);
  }
  return `AI-DLC Workflow ${version}`;
}

// Annotated tag message: the human title, then the trailers the next run reads
// back to decide whether main has moved since this preview was cut.
export function previewTagMessage(options: {
  version: string;
  sourceRepository: string;
  sourceDigest: string;
}): string {
  const parsed = parseVersion(options.version);
  if (parsed.channel !== PREVIEW_CHANNEL || !parsed.date) {
    throw new Error(`not a ${PREVIEW_CHANNEL} version id: ${options.version}`);
  }
  if (!REPOSITORY.test(options.sourceRepository)) {
    throw new Error(`invalid source repository ${JSON.stringify(options.sourceRepository)}`);
  }
  if (!COMMIT.test(options.sourceDigest)) {
    throw new Error("source digest must be a lowercase 40-hex commit");
  }
  const date = `${parsed.date.slice(0, 4)}-${parsed.date.slice(4, 6)}-${parsed.date.slice(6, 8)}`;
  return [
    previewReleaseName(options.version),
    "",
    `Source: ${options.sourceRepository}@${options.sourceDigest}`,
    `Build date: ${date}`,
    "",
  ].join("\n");
}

export function parsePreviewTagSource(
  message: string,
): { repository: string; digest: string } | null {
  const match = SOURCE_LINE.exec(message);
  return match ? { repository: match[1], digest: match[2] } : null;
}

export function readPreviewPlan(path: string): PreviewPlan {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `${path}: invalid ${PREVIEW_CHANNEL} plan JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: ${PREVIEW_CHANNEL} plan must be an object`);
  }
  const plan = value as Partial<PreviewPlan>;
  if (
    plan.schemaVersion !== 1 ||
    typeof plan.version !== "string" ||
    !PREVIEW_VERSION.test(plan.version) ||
    plan.tag !== `v${plan.version}` ||
    typeof plan.sourceRepository !== "string" ||
    !REPOSITORY.test(plan.sourceRepository) ||
    typeof plan.sourceDigest !== "string" ||
    !COMMIT.test(plan.sourceDigest) ||
    (plan.previousSourceDigest !== null &&
      (typeof plan.previousSourceDigest !== "string" || !COMMIT.test(plan.previousSourceDigest))) ||
    !plan.notes ||
    typeof plan.notes !== "object" ||
    plan.notes.name !== previewReleaseName(plan.version) ||
    typeof plan.notes.body !== "string" ||
    plan.notes.body.trim().length === 0
  ) {
    throw new Error(`${path}: ${PREVIEW_CHANNEL} plan is missing or has invalid fields`);
  }
  requireVersion(plan.version);
  return plan as PreviewPlan;
}
