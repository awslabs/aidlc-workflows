// The per-review reviewer copy on Kiro (the KAS layout: kiro-ide), a preview
// feature.
//
// Kiro's hook payloads do not say which agent made a tool call, so the
// reviewer-scope PreToolUse hook cannot hold a per-unit reviewer to its unit
// there. What Kiro does enforce is the delegated agent's own `permissions`: an
// `fs_read` deny with an `exclude` refuses a read outside the exclude (relative,
// absolute and `..` forms alike) and leaves the denied files out of search
// results, and the agent file is read again at each dispatch (measured on Kiro
// CLI 2.31.0 and Kiro IDE 1.3.0). So the review request writes a copy of the
// installed reviewer whose rules add that deny for this review's unit, and the
// conductor dispatches the copy. The copy's name is derived from the request
// id, which is what binds it to one request.
//
// The copy opens no file of another unit, not even one the unit's design names
// as an integration point: the reviewer notes that point as a finding instead.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_CHANNEL, versionChannel } from "./aidlc-channel.ts";
import {
  decideFence,
  installedKiroLayout,
  recordHookDrop,
  resolveProjectFlag,
  scopedReviewCopyName,
  swarmWorkerWorktreeMeta,
  writeFileAtomic,
} from "./aidlc-lib.ts";
import { resolveHarnessPath } from "./aidlc-runtime-paths.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

/** The environment variable that turns preview features on, as a comma list. */
export const PREVIEW_FEATURES_ENV = "AIDLC_PREVIEW_FEATURES";
/** The preview feature this module implements. */
export const REVIEWER_READ_SCOPE_FEATURE = "reviewer-read-scope";

/**
 * Whether a preview feature is on: only in a preview build, and only when the
 * person started their tool with the feature named in AIDLC_PREVIEW_FEATURES.
 * Read from the process environment alone: a project `.env` cannot set an
 * AIDLC_* name (aidlc-runtime-paths.ts drops them), and no setting records it.
 */
export function previewFeatureOn(name: string, version: string = AIDLC_VERSION): boolean {
  if (versionChannel(version) !== PREVIEW_CHANNEL) return false;
  return (process.env[PREVIEW_FEATURES_ENV] ?? "").split(",").some((entry) => entry.trim() === name);
}

// Where the reviewer can reach the Units' folders: the project's record, and a
// parallel batch's worktrees under .aidlc/worktrees/ (the reviewer's own
// filesystem rule reaches them).
const CONSTRUCTION_ROOTS = [
  "aidlc/spaces/*/intents/*/construction",
  ".aidlc/worktrees/*/aidlc/spaces/*/intents/*/construction",
];

/**
 * The copy's text: the installed reviewer file with its `name` set to the copy's
 * name, its `display_name` marked as this review's, and one rule added at the
 * end of `permissions.rules` that denies reads in every unit's construction
 * folder except this unit's. Everything else (the person's own edits included)
 * stays as installed. Null when the unit cannot be written as an exact pattern,
 * or the file has no frontmatter, no `name`, or no `permissions.rules` list in
 * the shipped shape.
 */
export function renderReviewCopy(reviewerText: string, copyName: string, unit: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit)) return null;
  const text = reviewerText.replace(/^\uFEFF/, "");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const front = lines.slice(1, end);

  const nameAt = front.findIndex((line) => /^name:/.test(line));
  if (nameAt === -1) return null;
  front[nameAt] = `name: ${copyName}`;
  const displayAt = front.findIndex((line) => /^display_name:/.test(line));
  if (displayAt !== -1) {
    // A double-quoted name takes the words inside its quotes; a plain one only
    // when it is plain words, so the result is always a quoted YAML string.
    // Any other form is left as it is.
    const value = front[displayAt].slice("display_name:".length).trim();
    const quoted = /^"(.*)"$/.exec(value);
    if (quoted) front[displayAt] = `display_name: "${quoted[1]} (this review)"`;
    else if (/^[A-Za-z0-9][^"\\#:]*$/.test(value)) front[displayAt] = `display_name: "${value} (this review)"`;
  }

  // `rules:` must be the permissions block's own key: every line between them
  // belongs to that block (indented, or blank).
  const permissionsAt = front.findIndex((line) => /^permissions:\s*$/.test(line));
  if (permissionsAt === -1) return null;
  let rulesAt = permissionsAt + 1;
  while (rulesAt < front.length && !/^ {2}rules:\s*$/.test(front[rulesAt])) {
    if (front[rulesAt].trim() !== "" && !/^ /.test(front[rulesAt])) return null;
    rulesAt++;
  }
  if (rulesAt === front.length || !/^ {4}- /.test(front[rulesAt + 1] ?? "")) return null;
  let insertAt = rulesAt + 1;
  while (insertAt < front.length && (front[insertAt].trim() === "" || /^ {4}/.test(front[insertAt]))) insertAt++;
  front.splice(
    insertAt,
    0,
    "    - capability: fs_read",
    "      effect: deny",
    "      match:",
    ...CONSTRUCTION_ROOTS.map((root) => `        - "${root}/**"`),
    "      exclude:",
    ...CONSTRUCTION_ROOTS.map((root) => `        - "${root}/${unit}/**"`),
  );
  return [lines[0], ...front, ...lines.slice(end)].join(eol);
}

// The installed agents folder, refused when a link on the way would lead the
// copy's write or removal somewhere else.
function writableAgentsDir(projectDir: string): string {
  return resolveHarnessPath(["agents"], { mutable: true, projectDir });
}

/**
 * Write this review's reviewer copy and return its agent name for the conductor
 * to dispatch, or null when this review is dispatched to the reviewer itself:
 * the feature is off, the project's Kiro tree is not the KAS layout, the review
 * is not a Unit's, it runs in a parallel batch's worktree, the reviewer
 * read-scope check stands aside for this work, or the copy cannot be written.
 * Never refuses: the review goes on either way. A copy the feature asked for
 * but could not write leaves a line among the reviewer-scope drops doctor counts.
 */
export function prepareReviewCopy(
  projectDir: string,
  review: { requestId: string; reviewer: string; unit?: string },
  version: string = AIDLC_VERSION,
): string | null {
  if (!review.unit || !previewFeatureOn(REVIEWER_READ_SCOPE_FEATURE, version)) return null;
  const copyName = scopedReviewCopyName(review.requestId);
  if (copyName === null) return null;
  const skipped = (why: string): null => {
    recordHookDrop(projectDir, "reviewer-scope", `reviewer copy for ${review.reviewer} (unit ${review.unit}) not written: ${why}`);
    return null;
  };
  try {
    if (installedKiroLayout(projectDir) !== "kas") return null;
    if (swarmWorkerWorktreeMeta(projectDir) !== null) return null;
    if (resolveProjectFlag("AIDLC_DISABLE_REVIEWER_SCOPE_HOOK", process.env, projectDir) === "1") return null;
    if (decideFence(projectDir, "reviewer-scope").decision === "stand-aside") return null;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(review.reviewer)) return skipped("the reviewer name is not a plain agent name");
    const agents = writableAgentsDir(projectDir);
    const reviewerPath = join(agents, `${review.reviewer}.md`);
    if (!existsSync(reviewerPath)) return skipped(`${reviewerPath} is missing`);
    const text = renderReviewCopy(readFileSync(reviewerPath, "utf-8"), copyName, review.unit);
    if (text === null) {
      return skipped(`the unit name or ${reviewerPath} is not in the shape a copy is made from (frontmatter, name, permissions.rules)`);
    }
    writeFileAtomic(join(agents, `${copyName}.md`), text);
    return copyName;
  } catch (e) {
    return skipped(e instanceof Error ? e.message : String(e));
  }
}

/** Remove the reviewer copy of a request, if one was written. Best effort. */
export function removeReviewCopy(projectDir: string, requestId: string | null | undefined): void {
  const copyName = requestId ? scopedReviewCopyName(requestId) : null;
  if (copyName === null) return;
  try {
    rmSync(join(writableAgentsDir(projectDir), `${copyName}.md`), { force: true });
  } catch {
    // A copy left behind is dispatched by nobody: its request is closed.
  }
}
