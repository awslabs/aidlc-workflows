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
  currentFingerprintForm,
  currentStageSourceBaseline,
  declaredProjectType,
  getField,
  isSourceFileName,
  personLineHeard,
  readAuditShardEvents,
  recordedSourceListingForCompare,
  repoDir,
  serializeSourceListing,
  sourceListingChangedKeys,
  sourceListingSha256,
  splitSourcePathKey,
  workStartSourceBaseline,
  workspaceSourceState,
} from "./aidlc-lib.ts";

const STAGE = "code-generation";
// As many as the left-out line names before "and N more".
const NAMED_MAX = 10;
// How far back a named file's history is searched for the content the build
// replaced, when HEAD does not hold it (the build may have committed its own).
const COMMITS_SEARCHED = 20;
const GIT_TIMEOUT_MS = 10_000;
// One read of git's copies (a lock file or a document can be megabytes).
const GIT_READ_MAX_BYTES = 1024 * 1024 * 1024;

interface BroughtFile {
  repo: string;
  path: string;
  deleted: boolean;
  // The content the build replaced, as the walk hashes it.
  sha: string;
}

interface ChangedFile extends BroughtFile {
  // The commit holding that content, as the person types it; null when none does.
  ref: string | null;
}

function git(dir: string, args: string[], input?: string): Buffer | null {
  try {
    const run = spawnSync("git", ["--literal-pathspecs", "-C", dir, ...args], {
      input, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_READ_MAX_BYTES,
    });
    return run.status === 0 ? run.stdout : null;
  } catch {
    return null;
  }
}

function holdsContent(blob: Buffer, sha: string): boolean {
  // Hashed first: a baseline taken over raw line endings maps to it only after.
  const text = committedTextSha256(blob);
  return text === sha || currentFingerprintForm(sha) === text;
}

// Which of `files` HEAD holds as they were, from one `git cat-file --batch`.
function heldAtHead(dir: string, files: readonly BroughtFile[]): Set<BroughtFile> {
  const held = new Set<BroughtFile>();
  const asked = files.filter((file) => !/[\r\n]/.test(file.path));
  if (asked.length === 0) return held;
  const out = git(dir, ["cat-file", "--batch"], asked.map((file) => `HEAD:./${file.path}\n`).join(""));
  if (out === null) return held;
  let at = 0;
  for (const file of asked) {
    const end = out.indexOf(10, at);
    if (end < 0) break;
    const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(out.subarray(at, end).toString("utf-8"));
    at = end + 1;
    if (header === null) continue;
    const size = Number(header[2]);
    if (header[1] === "blob" && holdsContent(out.subarray(at, at + size), file.sha)) held.add(file);
    at += size + 1;
  }
  return held;
}

// The newest commit that touched `path` and holds the content the build replaced.
function olderCommit(dir: string, file: BroughtFile): string | null {
  const revs = git(dir, ["rev-list", "-n", String(COMMITS_SEARCHED), "HEAD", "--", `./${file.path}`]);
  for (const rev of revs?.toString("utf-8").split("\n").filter(Boolean) ?? []) {
    const blob = git(dir, ["cat-file", "blob", `${rev}:./${file.path}`]);
    if (blob === null || !holdsContent(blob, file.sha)) continue;
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
): { files: BroughtFile[]; attempt: string } | null {
  const rows = readAuditShardEvents(projectDir);
  const brought = workStartSourceBaseline(projectDir, STAGE, undefined, undefined, rows);
  if (brought.state !== "ready") return null;
  const before = currentStageSourceBaseline(projectDir, STAGE, false, undefined, undefined, rows);
  if (before.state !== "ready") return null;
  const current = workspaceSourceState(projectDir);
  if (current === null) return null;
  const greenfield = declaredProjectType(getField(stateContent, "Project Type") ?? undefined) === "Greenfield";
  const recorded = recordedSourceListingForCompare(projectDir, before.listing, current);
  const files: BroughtFile[] = [];
  for (const key of sourceListingChangedKeys(recorded, current.listing)) {
    const entry = recorded.get(key);
    if (entry === undefined || !brought.listing.has(key)) continue;
    const parsed = splitSourcePathKey(key);
    // A link's target and a recorded checkout are listed beside the project's own files.
    if (parsed === null || parsed.path.endsWith("@target") || /^[^/]*@checkout\//.test(parsed.path)) continue;
    const deleted = !current.listing.has(key);
    if (!deleted && !greenfield && isSourceFileName(basename(parsed.path))) continue;
    files.push({ repo: parsed.repo, path: parsed.path, deleted, sha: entry.split(" ").at(-1) ?? "" });
  }
  if (files.length === 0) return null;
  return { files, attempt: sourceListingSha256(serializeSourceListing(before.listing)) };
}

// Each file with the commit that holds what the build replaced: HEAD for all of
// them in one read per repo, then the history of the named ones HEAD does not hold.
function withWayBack(projectDir: string, files: readonly BroughtFile[]): ChangedFile[] {
  const ordered = [...files].sort((a, b) =>
    Number(b.deleted) - Number(a.deleted) ||
    Number(shown(a).includes("/")) - Number(shown(b).includes("/")) ||
    (shown(a) < shown(b) ? -1 : shown(a) > shown(b) ? 1 : 0)
  );
  const atHead = new Set<BroughtFile>();
  for (const repo of new Set(ordered.map((file) => file.repo))) {
    const dir = repo === "" ? projectDir : repoDir(projectDir, repo);
    for (const file of heldAtHead(dir, ordered.filter((one) => one.repo === repo))) atHead.add(file);
  }
  return ordered.map((file, index) => {
    if (atHead.has(file)) return { ...file, ref: "HEAD" };
    if (index >= NAMED_MAX) return { ...file, ref: null };
    return { ...file, ref: olderCommit(file.repo === "" ? projectDir : repoDir(projectDir, file.repo), file) };
  });
}

function andList(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

// A file's name as the person reads it: control characters become spaces.
function shown(file: BroughtFile): string {
  const name = file.repo ? `${file.repo}/${file.path}` : file.path;
  return Array.from(name, (char) => isControl(char) ? " " : char).join("");
}

// A path as bash, zsh, PowerShell and cmd all pass it to git, and git reads it
// as that one file; null when no quoting does both.
export function quoted(path: string): string | null {
  if (/^[A-Za-z0-9._/@+-]+$/.test(path)) return path;
  if (/["$`%!*?[\]\\]/.test(path) || Array.from(path).some(isControl)) return null;
  return `"${path}"`;
}

/** The line, the files in the order it names them (deleted, then top-level, then by path). */
export function broughtFilesLine(ordered: readonly ChangedFile[]): string {
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
    const command = `git${file.repo ? ` -C ${file.repo}` : ""} checkout ${file.ref} --`;
    groups.set(command, [...(groups.get(command) ?? []), path]);
  }
  const commands = andList([...groups].map(([command, paths]) => `\`${command} ${paths.join(" ")}\``));
  const noCopy = named.filter((file) => file.ref === null);
  const noCommand = named.filter((file) => file.ref !== null && quoted(file.path) === null);
  // Past the named ones, only HEAD is read, so nothing is said of the rest
  // that git may hold further back.
  if (fromGit.length === 0 && noCommand.length === 0) {
    if (more > 0) return `${what} Of the files named here, none has a committed copy to put back.`;
    return `${what} ${one ? "There is no committed copy to put back." : "There are no committed copies to put back."}`;
  }
  const whole = noCopy.length === 0 && noCommand.length === 0 && ordered.every((file) => file.ref !== null);
  const back = whole ? `To put ${one ? "it" : "them"} back` : more > 0
    ? "To put back the ones found in git"
    : `To put ${andList(fromGit.map(shown))} back`;
  // Every clause opens with fixed words, so no file name is ever capitalized.
  const clauses = [
    fromGit.length > 0 ? `${back}, run ${commands}` : "",
    noCommand.length > 0
      ? `${fromGit.length > 0 ? "git also holds" : "Git holds"} ${andList(noCommand.map(shown))}`
      : "",
    noCopy.length > 0
      ? `${andList(noCopy.map(shown))} ${noCopy.length === 1 ? "has" : "have"} no committed copy to put back`
      : "",
  ].filter(Boolean);
  return `${what} ${clauses.join("; ")}.`;
}

/**
 * The line for the question that approves the build, unless this chat already
 * heard it in this build attempt (the engine's say-once record; `key` is what
 * the caller marks once the person is shown it, and names the attempt and the
 * files, so git is asked only when the line will be said). With Unit
 * checkpoints, each Unit's checkpoint approves the build and the stage gate the
 * engine settles after them does not say it.
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
    const names = changed.files.map((file) => `${file.deleted ? "-" : "~"}${file.repo}/${file.path}`).sort();
    const key = `${changed.attempt}\u0000${names.join("\u0000")}`;
    if (session && personLineHeard(projectDir, session, key)) return null;
    return { line: broughtFilesLine(withWayBack(projectDir, changed.files)), key };
  } catch {
    // A line the person may miss never stops the gate.
    return null;
  }
}
