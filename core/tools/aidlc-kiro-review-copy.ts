// The per-review reviewer copy on Kiro (kiro-ide), a preview feature.
//
// Kiro's hook payloads do not say which agent made a tool call, so the
// reviewer-scope PreToolUse hook cannot hold a per-unit reviewer to its unit
// there. What Kiro does enforce is the delegated
// agent's own `permissions`: an `fs_read` deny with an `exclude` refuses a read
// outside the exclude (relative, absolute and `..` forms alike) and leaves the
// denied files out of search results, and the agent file is read again at each
// dispatch (measured on Kiro CLI 2.31.0 and Kiro IDE 1.3.0). So the review
// request writes a copy of the installed reviewer whose rules add that deny for
// this review's unit, and the conductor dispatches the copy. The copy's name is
// derived from the request id, which is what binds it to one request.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { PREVIEW_CHANNEL, versionChannel } from "./aidlc-channel.ts";
import {
  decideFence,
  constructionSuffixComponents,
  installedHarnessName,
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
export function previewFeatureOn(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  version: string = AIDLC_VERSION,
): boolean {
  if (versionChannel(version) !== PREVIEW_CHANNEL) return false;
  return (env[PREVIEW_FEATURES_ENV] ?? "").split(",").some((entry) => entry.trim() === name);
}

const GLOB_CHARS = /[*?[\]{}]/;
// A double-quoted YAML scalar would need a quote, a backslash or a control
// character escaped: a path holding one is not rendered at all.
function unquotable(text: string): boolean {
  return [...text].some((ch) => ch === '"' || ch === "\\" || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
}

const CONSTRUCTION_GLOB = "aidlc/spaces/*/intents/*/construction";

/**
 * The `exclude` entries for one review: the unit's own subtree, then each exempt
 * path that lies in another unit's folder, by its part from `construction/` on
 * (the suffix the reviewer-scope hook matches exempt entries by). An absolute
 * path inside the project is read from the project, so a folder above it that
 * happens to be named `construction` is not taken for the Units' folder. Null
 * when the unit or an exempt path cannot be written as an exact pattern.
 */
export function reviewCopyExcludes(unit: string, exempt: readonly string[], projectDir?: string): string[] | null {
  if (unit === "" || unit === "." || unit === ".." || GLOB_CHARS.test(unit) || unquotable(unit) || unit.includes("/")) {
    return null;
  }
  const excludes = [`${CONSTRUCTION_GLOB}/${unit}/**`];
  for (const entry of exempt) {
    const inProject = projectDir !== undefined && isAbsolute(entry) ? relative(projectDir, entry) : "";
    const suffix = constructionSuffixComponents(inProject !== "" && !inProject.startsWith("..") ? inProject : entry);
    if (suffix === null) continue;
    const rest = suffix.slice(1);
    if (rest.length === 0 || rest[0].toLowerCase() === unit.toLowerCase()) continue;
    if (rest.some((c) => GLOB_CHARS.test(c) || unquotable(c) || c === "..")) return null;
    const pattern = `${CONSTRUCTION_GLOB}/${rest.join("/")}`;
    if (!excludes.includes(pattern)) excludes.push(pattern);
  }
  return excludes;
}

/**
 * The copy's text: the installed reviewer file with its `name` set to the copy's
 * name, its `display_name` marked as this review's, and one rule added at the
 * end of `permissions.rules` that denies reads under any unit's construction
 * folder except the excluded ones. Everything else (the person's own edits
 * included) stays as installed. Null when the file has no frontmatter, no
 * `name`, or no `permissions.rules` list in the shipped shape.
 */
export function renderReviewCopy(reviewerText: string, copyName: string, excludes: readonly string[]): string | null {
  const eol = reviewerText.includes("\r\n") ? "\r\n" : "\n";
  const lines = reviewerText.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const front = lines.slice(1, end);

  const nameAt = front.findIndex((line) => /^name:/.test(line));
  if (nameAt === -1) return null;
  front[nameAt] = `name: ${copyName}`;
  const displayAt = front.findIndex((line) => /^display_name:/.test(line));
  if (displayAt !== -1) {
    const value = front[displayAt].slice("display_name:".length).trim();
    // A double-quoted name takes the words inside its quotes; a plain one only
    // when it is plain words, so the result is always a quoted YAML string.
    // Any other form is left as it is.
    const quoted = /^"(.*)"$/.exec(value);
    if (quoted) front[displayAt] = `display_name: "${quoted[1]} (this review)"`;
    else if (/^[A-Za-z0-9][^"\\#:]*$/.test(value)) front[displayAt] = `display_name: "${value} (this review)"`;
  }

  const permissionsAt = front.findIndex((line) => /^permissions:\s*$/.test(line));
  if (permissionsAt === -1) return null;
  const rulesAt = front.findIndex((line, i) => i > permissionsAt && /^ {2}rules:\s*$/.test(line));
  if (rulesAt === -1 || !/^ {4}- /.test(front[rulesAt + 1] ?? "")) return null;
  let insertAt = rulesAt + 1;
  while (insertAt < front.length && (front[insertAt].trim() === "" || /^ {4}/.test(front[insertAt]))) insertAt++;
  front.splice(
    insertAt,
    0,
    "    - capability: fs_read",
    "      effect: deny",
    "      match:",
    `        - "${CONSTRUCTION_GLOB}/**"`,
    "      exclude:",
    ...excludes.map((pattern) => `        - "${pattern}"`),
  );
  return [lines[0], ...front, ...lines.slice(end)].join(eol);
}

// The installed agents folder (agentsDir's), checked for a link on the way that
// would lead the copy's write or removal somewhere else.
function writableAgentsDir(projectDir: string): string {
  return process.env.AIDLC_AGENTS_DIR ?? resolveHarnessPath(["agents"], { mutable: true, projectDir });
}

/**
 * Write this review's reviewer copy and return its agent name for the conductor
 * to dispatch, or null when this review is dispatched to the reviewer itself:
 * the feature is off, the project is not on Kiro (kiro-ide), the review is not a
 * Unit's, it runs in a parallel batch's worktree, the reviewer read-scope check
 * stands aside for this work, or the copy cannot be written. Never refuses: the
 * review goes on either way. A copy the feature asked for but could not write
 * leaves a line among the reviewer-scope drops doctor counts.
 */
export function prepareReviewCopy(
  projectDir: string,
  review: { requestId: string; reviewer: string; unit?: string; exempt: readonly string[] },
  build: { env?: NodeJS.ProcessEnv; version?: string } = {},
): string | null {
  const env = build.env ?? process.env;
  if (!review.unit || !previewFeatureOn(REVIEWER_READ_SCOPE_FEATURE, env, build.version)) return null;
  const copyName = scopedReviewCopyName(review.requestId);
  if (copyName === null) return null;
  const skipped = (why: string): null => {
    recordHookDrop(projectDir, "reviewer-scope", `reviewer copy for ${review.reviewer} (unit ${review.unit}) not written: ${why}`);
    return null;
  };
  try {
    if (installedHarnessName(projectDir) !== "kiro-ide") return null;
    if (swarmWorkerWorktreeMeta(projectDir) !== null) return null;
    if (resolveProjectFlag("AIDLC_DISABLE_REVIEWER_SCOPE_HOOK", env, projectDir) === "1") return null;
    if (decideFence(projectDir, "reviewer-scope").decision === "stand-aside") return null;
    const excludes = reviewCopyExcludes(review.unit, review.exempt, projectDir);
    if (excludes === null) return skipped("the unit or an exempt path holds a character a pattern cannot carry");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(review.reviewer)) return skipped("the reviewer name is not a plain agent name");
    const agents = writableAgentsDir(projectDir);
    const reviewerPath = join(agents, `${review.reviewer}.md`);
    if (!existsSync(reviewerPath)) return skipped(`${reviewerPath} is missing`);
    const text = renderReviewCopy(readFileSync(reviewerPath, "utf-8"), copyName, excludes);
    if (text === null) return skipped(`${reviewerPath} has no permissions.rules list in the installed shape`);
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
