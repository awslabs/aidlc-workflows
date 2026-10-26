// The person's files the agent changed before they picked a plan for new work,
// said once when the pick starts the work, with the way back (Arden's call on
// an agent that edits the code while the plan question is still open: no guard,
// nothing blocked, one line). The plan-approval guard is the PreToolUse hook
// every harness runs on the agent's file and shell writes, so it keeps each
// write it sees while this chat's plan question is open (keepWritesBeforePick),
// with what the file was just before. The person's own edits, a teammate's pull
// and generated files reach no hook and are never kept. The work's creation
// names the kept files that still differ (sayWritesBeforePick) and keeps their
// earlier content with the work, so a file the person puts back is nobody's
// change when Code Generation accounts for its Units (putBackBeforePick).
//
// The same holds once the work has started, until Code Generation (Arden's
// call on an agent that edited the code at the Requirements Analysis gate):
// while the work is at a stage that writes only AI-DLC's own records, the guard
// keeps each write with the work (keepWritesDuringWork), and the work's next
// approval names the kept files that still differ (sayWritesDuringWork) with the
// same way back.
//
// Whether a file changed is the source listing's own reading of it
// (`stableFileSha256`), the one Code Generation's accounting compares. How it
// goes back is git's: `hash-object` with the repository's filters is the blob a
// commit of the file would hold, so a clean file under `core.autocrlf` reads as
// last committed. A file outside git cannot be put back.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  addPendingPersonLines,
  aidlcOwnedSourceKey,
  engineDir,
  findStageBySlug,
  getField,
  inertPath,
  normalizeStageName,
  readIssuedDirectiveMarker,
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  removeRecordFileNoFollow,
  sessionRecordPath,
  sourcePathKey,
  splitSourcePathKey,
  stableFileSha256,
  stageIndex,
  stateFilePathForSelection,
  type WorkflowSelection,
  writeEngineFileNoFollow,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";
import { quoted } from "./aidlc-brought-files.ts";
import { inQuestionChain, planQuestionWindow, type StoredQuestion } from "./aidlc-question-store.ts";

const KEPT_MAX_BYTES = 1024 * 1024;
const NAMED_MAX = 10;
const WORK_FILE = "before-pick.json";
const DURING_FILE = "during-work.json";
const GIT_TIMEOUT_MS = 10_000;

/** One file the agent wrote, as it was just before its first write. */
interface KeptFile {
  /** Project-relative, forward slashes. */
  path: string;
  /** The git repository holding it, project-relative ("" for the project's own), or null outside git. */
  repo: string | null;
  /** The path inside that repository. */
  inRepo: string;
  /** Its content as a source listing reads it; null when it did not exist. */
  listed: string | null;
  /** Its git blob id, or null (outside git, or it did not exist). */
  blob: string | null;
  /** HEAD when it was kept, or null. */
  head: string | null;
}

interface KeptWrites {
  question: string;
  files: KeptFile[];
}

/** One file the agent wrote while the work was before Code Generation, with the stage it was first written in. */
interface KeptDuringWork extends KeptFile {
  stage: string;
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout: GIT_TIMEOUT_MS });
  return r.status === 0 ? r.stdout.trim() : null;
}

function keptPath(projectDir: string, chat: string): string {
  const path = sessionRecordPath(projectDir, chat);
  return path ? relative(projectDir, `${path}.before-pick`) : "";
}

function readKept(projectDir: string, rel: string): KeptWrites | null {
  try {
    const saved = JSON.parse(
      readRegularFileNoFollowOrThrow(recordFileTargetOrThrow(projectDir, rel), "kept writes", KEPT_MAX_BYTES).toString("utf-8"),
    ) as Partial<KeptWrites>;
    return typeof saved.question === "string" && Array.isArray(saved.files) ? saved as KeptWrites : null;
  } catch {
    return null;
  }
}

function listedNow(projectDir: string, path: string): string | null {
  const abs = join(projectDir, path);
  try {
    return lstatSync(abs).isFile() ? stableFileSha256(abs) : null;
  } catch {
    return null;
  }
}

// The file at `rel` as it is now, with the repository it belongs to: the project's own (also when the project is
// a folder of a larger repository, where a checkout from the project root still names the file), or a repository
// nested in the project.
function fileNow(projectDir: string, rel: string): KeptFile {
  let folder = dirname(join(projectDir, rel));
  while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
  const top = git(folder, ["rev-parse", "--show-toplevel"]);
  let projectReal = projectDir;
  try {
    projectReal = realpathSync(projectDir);
  } catch {
    // Compared as spelled.
  }
  const fromProject = top === null ? null : relative(projectReal, resolve(top)).split("\\").join("/");
  const nested = fromProject !== null && fromProject !== "" && fromProject !== ".." && !fromProject.startsWith("../") &&
    !isAbsolute(fromProject);
  const repo = fromProject === null ? null : nested ? fromProject : "";
  const inRepo = nested ? relative(join(projectDir, fromProject), join(projectDir, rel)).split("\\").join("/") : rel;
  const listed = listedNow(projectDir, rel);
  const repoDir = repo === null ? null : join(projectDir, repo);
  return {
    path: rel, repo, inRepo, listed,
    blob: repoDir === null || listed === null ? null : git(repoDir, ["hash-object", "--", inRepo]),
    head: repoDir === null ? null : git(repoDir, ["rev-parse", "--verify", "-q", "HEAD"]),
  };
}

/**
 * Keep the agent's write targets (absolute, inside the project) while `question`, this chat's plan question for new
 * work, is open: each file's state just before the first write to it. AI-DLC's own files and `.git` are never kept.
 */
export function keepWritesBeforePick(
  projectDir: string,
  chat: string,
  question: StoredQuestion,
  targets: readonly string[],
): void {
  const rel = keptPath(projectDir, chat);
  if (targets.length === 0 || !rel) return;
  const saved = readKept(projectDir, rel);
  const kept: KeptWrites = saved?.question === question.id ? saved : { question: question.id, files: [] };
  const added = firstWrites(projectDir, kept.files, targets);
  if (added.length > 0) {
    writeRecordFileNoFollow(projectDir, rel, `${JSON.stringify({ ...kept, files: [...kept.files, ...added] })}\n`);
  }
}

// The targets not kept yet, each as it is just before this first write to it. AI-DLC's own files and `.git` are
// never kept.
function firstWrites(projectDir: string, kept: readonly KeptFile[], targets: readonly string[]): KeptFile[] {
  const owned = aidlcOwnedSourceKey(projectDir);
  const added: KeptFile[] = [];
  for (const target of targets) {
    const path = relative(projectDir, target).split("\\").join("/");
    if (!path || path.startsWith("../") || isAbsolute(path)) continue;
    if (path === ".git" || path.startsWith(".git/") || owned(sourcePathKey("", path))) continue;
    if (kept.some((file) => file.path === path) || added.some((file) => file.path === path)) continue;
    added.push(fileNow(projectDir, path));
  }
  return added;
}

/**
 * The stage the selected work is on while it is before Code Generation at a stage that writes only AI-DLC's own
 * records, or null. The stage is the work's Unit Stage when set (unit-major Construction keeps Current Stage on the
 * first per-Unit stage while a Unit works through the later ones), else its Current Stage; it declares no
 * `workspace_requires` (a stage that writes the person's code declares it) and sits before code-generation in the
 * stage graph. Between a Unit's build steps those fields are gone, and the step the engine last issued, a Code
 * Generation step, says the work is building.
 */
export function workBeforeCodeGeneration(projectDir: string, selection: WorkflowSelection): string | null {
  if (selection.intent === null) return null;
  let state: string;
  try {
    state = readFileSync(stateFilePathForSelection(projectDir, selection), "utf-8");
  } catch {
    return null;
  }
  const status = getField(state, "Status");
  if (status === "Completed" || status === "Archived") return null;
  const slug = normalizeStageName(getField(state, "Unit Stage") || getField(state, "Current Stage") || "");
  const stage = findStageBySlug(slug);
  const build = stageIndex("code-generation");
  if (stage === undefined || stage.workspace_requires === true || build < 0 || stageIndex(slug) >= build) return null;
  return readIssuedDirectiveMarker(projectDir) === null ? slug : null;
}

function readDuringWork(projectDir: string, intent?: string, space?: string): KeptDuringWork[] {
  try {
    const saved = JSON.parse(
      readRegularFileNoFollowOrThrow(join(engineDir(projectDir, intent, space), DURING_FILE), "kept writes", KEPT_MAX_BYTES)
        .toString("utf-8"),
    ) as { files?: unknown };
    return Array.isArray(saved.files) ? saved.files as KeptDuringWork[] : [];
  } catch {
    return [];
  }
}

/**
 * Keep the agent's write targets (absolute, inside the project) with `work` while it is at `stage`, before Code
 * Generation (workBeforeCodeGeneration): each file's state just before the first write to it since the work's last
 * approval.
 */
export function keepWritesDuringWork(
  projectDir: string,
  work: { intent: string; space: string },
  stage: string,
  targets: readonly string[],
): void {
  if (targets.length === 0) return;
  const kept = readDuringWork(projectDir, work.intent, work.space);
  const added = firstWrites(projectDir, kept, targets).map((file) => ({ ...file, stage }));
  if (added.length === 0) return;
  writeEngineFileNoFollow(projectDir, DURING_FILE, `${JSON.stringify({ files: [...kept, ...added] })}\n`, work.intent, work.space);
}

function andList(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, NAMED_MAX).map(inertPath);
  const more = paths.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : andList(shown);
}

// How each changed file goes back, worked out against git as it is at the pick: the content before the agent's
// first write is HEAD's now (a checkout puts it back), or the commit kept then still holds it (the agent
// committed its edit, or HEAD moved), or the file is new (deleting it undoes it), or nothing holds it. Null when
// no file is left to name: a path no command can quote is left out rather than misnamed.
function undoLine(projectDir: string, changed: readonly KeptFile[], lead: string): string | null {
  const named: string[] = [];
  const restore = new Map<string, string[]>();
  const fresh: string[] = [];
  const outsideGit: string[] = [];
  const lost: string[] = [];
  for (const file of changed) {
    if (file.listed === null) {
      fresh.push(file.path);
    } else if (file.repo === null) {
      outsideGit.push(file.path);
    } else {
      const arg = quoted(file.inRepo);
      const repoArg = file.repo ? quoted(file.repo) : "";
      // Unnamed rather than given a reason that may not hold: git could not read it at the write.
      if (arg === null || repoArg === null || file.blob === null) continue;
      const repoDir = join(projectDir, file.repo);
      const atHead = git(repoDir, ["rev-parse", "--verify", "-q", `HEAD:./${file.inRepo}`]);
      const atKept = atHead === file.blob || file.head === null
        ? null
        : git(repoDir, ["rev-parse", "--verify", "-q", `${file.head}:./${file.inRepo}`]);
      if (atHead === file.blob || atKept === file.blob) {
        // A tree-ish either way: `checkout -- <file>` restores from the index, where an edit the agent staged sits.
        const at = atHead === file.blob ? "HEAD " : `${(file.head as string).slice(0, 12)} `;
        const key = `${repoArg}\u0000${at}`;
        restore.set(key, [...(restore.get(key) ?? []), arg]);
      } else {
        lost.push(file.path);
      }
    }
    named.push(file.path);
  }
  if (named.length === 0) return null;
  const clauses: string[] = [];
  for (const [key, args] of restore) {
    const [repoArg, at] = key.split("\u0000");
    const command = `git ${repoArg ? `-C ${repoArg} ` : ""}checkout ${at}-- ${args.join(" ")}`;
    const one = args.length === 1;
    const as = at === "HEAD " ? "last committed" : `${one ? "it was" : "they were"} before`;
    clauses.push(`\`${command}\` puts ${one ? "it" : "them"} back as ${as}`);
  }
  if (fresh.length > 0) {
    clauses.push(`${listed(fresh)} ${fresh.length === 1 ? "is new: delete it" : "are new: delete them"} to undo that`);
  }
  if (outsideGit.length > 0) {
    clauses.push(
      `${listed(outsideGit)} ${outsideGit.length === 1 ? "is not in git, so its change" : "are not in git, so their changes"} ` +
        "cannot be undone",
    );
  }
  if (lost.length > 0) {
    clauses.push(
      `${listed(lost)} already had changes that were not committed, so ${lost.length === 1 ? "its change" : "their changes"} ` +
        "cannot be undone",
    );
  }
  return `${lead}, ${listed(named)} ${named.length === 1 ? "was" : "were"} changed; ${clauses.join("; ")}.`;
}

/**
 * At the commit point of the work that question `questionId` started: the kept files that differ from just before
 * the agent's first write are said once to the chat that made the pick, and their earlier content is kept with the
 * work. The kept writes are spent either way.
 */
export function sayWritesBeforePick(
  projectDir: string,
  questionId: string,
  work: { dirName: string; space: string },
  pickingChat: string | null,
): void {
  const window = planQuestionWindow(projectDir, questionId);
  const rel = window ? keptPath(projectDir, window.chat) : "";
  if (!window || !rel) return;
  const kept = readKept(projectDir, rel);
  if (kept === null || !inQuestionChain(projectDir, kept.question, window.chain)) return;
  try {
    removeRecordFileNoFollow(projectDir, rel);
  } catch {
    // Already gone: nothing is kept for this chat.
  }
  const changed = kept.files.filter((file) => listedNow(projectDir, file.path) !== file.listed);
  if (changed.length === 0) return;
  keepWithWork(projectDir, changed, work.dirName, work.space);
  // "Before this work started": true whether the plan was picked at its question or typed with the request.
  const line = undoLine(projectDir, changed, "Before this work started");
  if (line !== null && pickingChat) addPendingPersonLines(projectDir, pickingChat, [line]);
}

/**
 * At an approval of the selected work (`approved`, the stage approved): the files kept since its last approval that
 * differ from just before the agent's first write are said once to `chat`, and their earlier content is kept with
 * the work. The kept writes are spent either way. When the approved stage writes the person's code (a jump took the
 * work into it with no approval since), they are spent unsaid: that stage's own accounting owns what changed, and a
 * checkout would take its edits back too.
 */
export function sayWritesDuringWork(projectDir: string, approved: string, chat: string | null): void {
  const path = join(engineDir(projectDir), DURING_FILE);
  if (!existsSync(path)) return;
  const kept = readDuringWork(projectDir);
  try {
    removeRecordFileNoFollow(projectDir, relative(projectDir, path));
  } catch {
    // Already gone: nothing is kept for this work.
  }
  if (findStageBySlug(approved)?.workspace_requires === true) return;
  const changed = kept.filter((file) => listedNow(projectDir, file.path) !== file.listed);
  if (changed.length === 0) return;
  keepWithWork(projectDir, changed);
  const stages = [...new Set(changed.map((file) => findStageBySlug(file.stage)?.name))]
    .filter((name): name is string => name !== undefined);
  const line = undoLine(projectDir, changed, stages.length > 0 ? `During ${andList(stages)}` : "Before Code Generation");
  if (line !== null && chat) addPendingPersonLines(projectDir, chat, [line]);
}

// What the changed files held before the agent's first write, kept with the work for putBackBeforePick; a path
// already kept keeps its first entry.
function keepWithWork(projectDir: string, changed: readonly KeptFile[], intent?: string, space?: string): void {
  const files = readWithWork(projectDir, intent, space);
  for (const file of changed) {
    if (!files.some((entry) => entry.path === file.path)) files.push({ path: file.path, listed: file.listed });
  }
  writeEngineFileNoFollow(projectDir, WORK_FILE, `${JSON.stringify({ files })}\n`, intent, space);
}

function readWithWork(projectDir: string, intent?: string, space?: string): Array<{ path: string; listed: string | null }> {
  try {
    const saved = JSON.parse(
      readRegularFileNoFollowOrThrow(join(engineDir(projectDir, intent, space), WORK_FILE), "kept writes", KEPT_MAX_BYTES)
        .toString("utf-8"),
    ) as { files?: unknown };
    return Array.isArray(saved.files) ? saved.files as Array<{ path: string; listed: string | null }> : [];
  } catch {
    return [];
  }
}

/**
 * For the selected work: whether a changed source path (`<repo>\0<path>`, with its listing entry now) holds again
 * exactly what it held before the agent's write that the pick or an approval named, which makes it nobody's change.
 */
export function putBackBeforePick(projectDir: string): (pathKey: string, entry: string | undefined) => boolean {
  const files = readWithWork(projectDir);
  if (files.length === 0) return () => false;
  const before = new Map(files.map((file) => [file.path, file.listed]));
  return (pathKey, entry) => {
    const parsed = splitSourcePathKey(pathKey);
    if (parsed === null) return false;
    const path = parsed.repo ? `${parsed.repo}/${parsed.path}` : parsed.path;
    if (!before.has(path)) return false;
    const now = entry === undefined ? null : entry.split(" ")[1] ?? null;
    return now === before.get(path);
  };
}
