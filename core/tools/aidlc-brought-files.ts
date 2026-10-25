// aidlc-brought-files.ts - the files the person brought that a build changed or
// deleted, said once with the question that approves the build, each with its
// way back.
//
// The engine lists the project's files with their content hashes when the work
// starts (WORKFLOW_STARTED) and when Code Generation starts (STAGE_STARTED),
// with or without git and on every harness; this compares those listings with
// the files as they are now, so a write by a helper or a shell counts the same
// as the lead's. Silent when a listing is not on this machine (AI-DLC's ignored
// copy: a team clone that did not start the work), or cannot be read.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import {
  committedTextSha256,
  constructionCheckpointsApply,
  currentStageSourceBaseline,
  getField,
  isSourceFileName,
  personLineHeard,
  recordedSourceListingForCompare,
  repoDir,
  serializeSourceListing,
  sourceListingEntriesEqual,
  sourceListingSha256,
  splitSourcePathKey,
  workStartSourceBaseline,
  workspaceSourceState,
} from "./aidlc-lib.ts";

const STAGE = "code-generation";
// As many as the left-out line names before "and N more".
const NAMED_MAX = 10;
// How far back a file's history is searched for the content the build replaced
// (the build may have committed its own version).
const COMMITS_SEARCHED = 20;
const GIT_TIMEOUT_MS = 10_000;

interface ChangedFile {
  repo: string;
  path: string;
  deleted: boolean;
  // The commit holding the content the build replaced, as the person types it; null when none does.
  ref: string | null;
}

function git(dir: string, args: string[]): Buffer | null {
  try {
    const run = spawnSync("git", ["--literal-pathspecs", "-C", dir, ...args], { timeout: GIT_TIMEOUT_MS });
    return run.status === 0 ? run.stdout : null;
  } catch {
    return null;
  }
}

// The commit whose copy of `path` is the content the build replaced: HEAD when
// it holds it, else the newest of the commits that touched the path.
function committedRef(dir: string, path: string, sha: string): string | null {
  const holds = (rev: string): boolean => {
    const blob = git(dir, ["cat-file", "blob", `${rev}:./${path}`]);
    return blob !== null && committedTextSha256(blob) === sha;
  };
  if (holds("HEAD")) return "HEAD";
  const revs = git(dir, ["rev-list", "-n", String(COMMITS_SEARCHED), "HEAD", "--", `./${path}`]);
  for (const rev of revs?.toString("utf-8").split("\n").filter(Boolean) ?? []) {
    if (!holds(rev)) continue;
    return git(dir, ["rev-parse", "--short", rev])?.toString("utf-8").trim() || rev;
  }
  return null;
}

/**
 * The files the work started with that this build changed or deleted. On a
 * brownfield project the code the work changes on purpose is not one of them:
 * a changed file counts there only when the source walk does not read it as
 * code by its name (a README, LICENSE, docs, .env). `attempt` names the build
 * attempt (its starting listing), so a redo says it again.
 */
export function broughtFilesChanged(
  projectDir: string,
  stateContent: string,
): { files: ChangedFile[]; attempt: string } | null {
  const brought = workStartSourceBaseline(projectDir, STAGE);
  if (brought.state !== "ready") return null;
  const before = currentStageSourceBaseline(projectDir, STAGE, false);
  if (before.state !== "ready") return null;
  const current = workspaceSourceState(projectDir);
  if (current === null) return null;
  const greenfield = getField(stateContent, "Project Type")?.trim().toLowerCase() === "greenfield";
  const files: ChangedFile[] = [];
  for (const [key, entry] of recordedSourceListingForCompare(projectDir, before.listing, current)) {
    if (!brought.listing.has(key)) continue;
    const parsed = splitSourcePathKey(key);
    // A link's target and a recorded checkout are listed beside the project's own files.
    if (parsed === null || parsed.path.endsWith("@target") || /^[^/]*@checkout\//.test(parsed.path)) continue;
    const now = current.listing.get(key);
    const deleted = now === undefined;
    if (!deleted && sourceListingEntriesEqual(now, entry)) continue;
    if (!deleted && !greenfield && isSourceFileName(basename(parsed.path))) continue;
    const sha = entry.split(" ").at(-1) ?? "";
    const dir = parsed.repo === "" ? projectDir : repoDir(projectDir, parsed.repo);
    files.push({ repo: parsed.repo, path: parsed.path, deleted, ref: committedRef(dir, parsed.path, sha) });
  }
  if (files.length === 0) return null;
  return { files, attempt: sourceListingSha256(serializeSourceListing(before.listing)) };
}

function andList(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

// A file's name as the person reads it: control characters become spaces.
function shown(file: ChangedFile): string {
  const name = file.repo ? `${file.repo}/${file.path}` : file.path;
  return Array.from(name, (char) => isControl(char) ? " " : char).join("");
}

// A path as bash, zsh, PowerShell and cmd all read it; null when no one quoting does.
function quoted(path: string): string | null {
  if (/^[A-Za-z0-9._/@+-]+$/.test(path)) return path;
  if (/["$`%!]/.test(path) || Array.from(path).some(isControl)) return null;
  return `"${path}"`;
}

export function broughtFilesLine(files: readonly ChangedFile[]): string {
  const ordered = [...files].sort((a, b) =>
    Number(b.deleted) - Number(a.deleted) ||
    Number(shown(a).includes("/")) - Number(shown(b).includes("/")) ||
    (shown(a) < shown(b) ? -1 : shown(a) > shown(b) ? 1 : 0)
  );
  const named = ordered.slice(0, NAMED_MAX);
  const more = ordered.length - named.length;
  const one = ordered.length === 1;
  const changed = named.filter((file) => !file.deleted).map(shown);
  const deleted = named.filter((file) => file.deleted).map(shown);
  const what = more > 0
    ? `The build changed or deleted ${ordered.length} files you had before this work started: ` +
      `${named.map(shown).join(", ")} and ${more} more.`
    : `The build ${[
      changed.length > 0 ? `changed ${andList(changed)}` : "",
      deleted.length > 0 ? `deleted ${andList(deleted)}` : "",
    ].filter(Boolean).join(" and ")}, ${one ? "a file" : "files"} you had before this work started.`;
  const groups = new Map<string, string[]>();
  const fromGit: ChangedFile[] = [];
  for (const file of ordered) {
    const path = file.ref === null ? null : quoted(file.path);
    if (file.ref === null || path === null) continue;
    fromGit.push(file);
    const repo = file.repo ? ` -C ${file.repo}` : "";
    const command = `git${repo} checkout ${file.ref} --`;
    groups.set(command, [...(groups.get(command) ?? []), path]);
  }
  const commands = andList([...groups].map(([command, paths]) => `\`${command} ${paths.join(" ")}\``));
  const noCopy = named.filter((file) => file.ref === null);
  const noCommand = named.filter((file) => file.ref !== null && quoted(file.path) === null);
  if (fromGit.length === 0 && noCommand.length === 0) {
    return `${what} ${one ? "There is no committed copy to put back." : "There are no committed copies to put back."}`;
  }
  let back = "";
  if (fromGit.length > 0) {
    const whole = noCopy.length === 0 && noCommand.length === 0 && ordered.every((file) => file.ref !== null);
    const which = whole ? (one ? "it" : "them") : more > 0 ? "the ones git holds" : andList(fromGit.map(shown));
    back = `To put ${which} back, run ${commands}`;
  }
  const rest = [
    noCommand.length > 0 ? `${andList(noCommand.map(shown))} can be put back from git` : "",
    noCopy.length > 0 && more === 0 ? `${andList(noCopy.map(shown))} ${noCopy.length === 1 ? "has" : "have"} no committed copy to put back` : "",
    noCopy.length > 0 && more > 0 ? "the others have no committed copy to put back" : "",
  ].filter(Boolean);
  const sentence = [back, ...rest].filter(Boolean).join("; ");
  return `${what} ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * The line for the question that approves the build, unless this chat already
 * heard it in this build attempt (the engine's say-once record; `key` is what
 * the caller marks once the person is shown it). With Unit checkpoints, each
 * Unit's checkpoint approves the build and the stage gate the engine settles
 * after them does not say it.
 */
export function unheardBroughtFilesLine(
  projectDir: string,
  stateContent: string | null,
  session: string | null | undefined,
  atCheckpoint = false,
): { line: string; key: string } | null {
  try {
    if (stateContent === null || constructionCheckpointsApply(stateContent) !== atCheckpoint) return null;
    const changed = broughtFilesChanged(projectDir, stateContent);
    if (changed === null) return null;
    const line = broughtFilesLine(changed.files);
    const key = `${changed.attempt}\u0000${line}`;
    return session && personLineHeard(projectDir, session, key) ? null : { line, key };
  } catch {
    // A line the person may miss never stops the gate.
    return null;
  }
}
