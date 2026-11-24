// aidlc-brought-files.ts - the files the person brought: named to the plan
// writer and the builder before the build, and the ones a build changed or
// deleted said once with the question that approves it, each with its way back.
//
// The engine lists the project's files with their content hashes when the work
// starts (WORKFLOW_STARTED) and when Code Generation starts (STAGE_STARTED),
// with or without git and on every harness; this compares those listings with
// the files as they are now, so a write by a helper or a shell counts the same
// as the lead's. Those listings are AI-DLC's ignored copy, so a team clone that
// did not start the work has none, and a stage run on its own keeps none: each
// takes its own on this machine when its Code Generation first runs here
// (broughtListing). Unit by Unit, a Unit's approval compares from the files as
// that Unit's Code Generation found them (unitListingName), so its way back
// keeps what an earlier Unit's approval kept. Silent when no listing is here or
// one cannot be read. A file AI-DLC's install or a refresh wrote, as its install
// record says it wrote it, is AI-DLC's and not the build's change (an `aidlc
// update` and `aidlc config` while the work was open rewrite them). After a
// `git pull`, a file exactly as the remote branch of its own repository holds
// it is nobody's change in this work (remoteBranchCopies), and the readers of
// the build's changes leave it out.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { holdsRecordedWrite, markedPart, onlyMarkedPartChanged } from "./aidlc-distribution.ts";
import { isReadOnlyEngineProbe, readRegularFileNoFollowOrThrow } from "./aidlc-locks.ts";
import { discoverProjectHarnesses } from "./aidlc-runtime-paths.ts";
import {
  type AuditShardEvent,
  auditBlockField,
  committedTextSha256,
  constructionCheckpointsApply,
  currentFingerprintForm,
  currentStageSourceBaseline,
  declaredProjectType,
  engineDir,
  getField,
  isSourceFileName,
  parseSourceListing,
  personLineHeard,
  readAuditShardEvents,
  readRecordedSourceCheckouts,
  readUnitSourceManifest,
  recordDir,
  recordedCheckoutOfListingPath,
  recordedSourceListingForCompare,
  repoDir,
  serializeSourceListing,
  sourceClaimCovers,
  sourceListingChangedKeys,
  sourceListingSha256,
  sourcePathKey,
  splitSourcePathKey,
  workStartSourceBaseline,
  type WorkspaceSourceListing,
  workspaceSourceState,
  writeEngineFileNoFollow,
} from "./aidlc-lib.ts";

const STAGE = "code-generation";
// As many as the line, and the note for the build, name before "and N more".
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
      // A partial clone fetches no missing object for these reads, on a git that knows this.
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
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

// Each of `names` (an object, or `<commit>:./<path>`) from one `git cat-file
// --batch`: its bytes when it is a file's, otherwise null. Null when git could
// not be read.
function blobsAt(dir: string, names: readonly string[]): Array<Buffer | null> | null {
  if (names.length === 0) return [];
  const out = git(dir, ["cat-file", "--batch"], names.map((name) => `${name}\n`).join(""));
  if (out === null) return null;
  const blobs: Array<Buffer | null> = names.map(() => null);
  let at = 0;
  for (let index = 0; index < names.length; index++) {
    const end = out.indexOf(10, at);
    if (end < 0) break;
    const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(out.subarray(at, end).toString("utf-8"));
    at = end + 1;
    if (header === null) continue;
    const size = Number(header[2]);
    if (header[1] === "blob") blobs[index] = out.subarray(at, at + size);
    at += size + 1;
  }
  return blobs;
}

// Which of `files` HEAD holds as they were.
function heldAtHead(dir: string, files: readonly BroughtFile[]): Set<BroughtFile> {
  const asked = files.filter((file) => !/[\r\n]/.test(file.path));
  const blobs = blobsAt(dir, asked.map((file) => `HEAD:./${file.path}`)) ?? [];
  return new Set(asked.filter((file, index) => {
    const blob = blobs[index];
    return blob != null && holdsContent(blob, file.sha);
  }));
}

// The newest commit that touched `path` and holds the content the build
// replaced, with that content.
function committedCopy(dir: string, file: BroughtFile): { rev: string; blob: Buffer } | null {
  const revs = git(dir, ["rev-list", "-n", String(COMMITS_SEARCHED), "HEAD", "--", `./${file.path}`]);
  for (const rev of revs?.toString("utf-8").split("\n").filter(Boolean) ?? []) {
    const blob = git(dir, ["cat-file", "blob", `${rev}:./${file.path}`]);
    if (blob !== null && holdsContent(blob, file.sha)) return { rev, blob };
  }
  return null;
}

function olderCommit(dir: string, file: BroughtFile): string | null {
  const copy = committedCopy(dir, file);
  if (copy === null) return null;
  return git(dir, ["rev-parse", "--short", copy.rev])?.toString("utf-8").trim() || copy.rev;
}

/** A changed file as the remote branch of its own repository has it (remoteBranchCopies). */
export interface RemoteBranchCopy {
  // That branch's copy, as the walk hashes it; "" when it has no such file, or not as a file.
  sha: string;
  // The file is now exactly as that branch holds it: nobody's change in this work.
  held: boolean;
}

/**
 * Of `keys` (source paths changed from `start` to `now`), the files the remote
 * branch of their own repository moved on since this work found them: after a
 * `git pull`, a teammate's. That branch is the one the folder's checked-out
 * branch tracks, a remote's branch as this clone last fetched it, as far as
 * this checkout has merged it (their merge base), so nothing fetched and not
 * merged counts. Moved on: the branch holds the path otherwise than `start`
 * does, or not at all, and a commit on its history held it as `start` does (it
 * was the team's copy); a path `start` lacks, when the branch has it. `held`:
 * the file is now as the branch holds it (its mode, and its content against
 * git's copy as the walk reads both), nobody's change in this work; otherwise
 * the build changed it on top of the team's copy. The workspace's repository, a
 * recorded repo and a recorded checkout are each read in their own folder, never
 * fetched, and nothing is written there. With no such branch, or when git cannot
 * tell, a folder's files are not in the map and are named like any other
 * changed file. Never throws.
 */
export function remoteBranchCopies(
  projectDir: string,
  start: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>,
  keys: Iterable<string>,
): Map<string, RemoteBranchCopy> {
  const copies = new Map<string, RemoteBranchCopy>();
  try {
    const checkouts = readRecordedSourceCheckouts(projectDir);
    // Each folder's keys, by the path git knows each by there.
    const folders = new Map<string, Map<string, string>>();
    for (const key of keys) {
      const parsed = splitSourcePathKey(key);
      if (parsed === null) continue;
      const checkout = parsed.repo === "" ? recordedCheckoutOfListingPath(parsed.path, checkouts) : null;
      const path = checkout?.rest ?? parsed.path;
      if (path === "" || /[\r\n]/.test(path)) continue;
      const dir = checkout?.checkout.real ?? (parsed.repo === "" ? projectDir : repoDir(projectDir, parsed.repo));
      folders.set(dir, (folders.get(dir) ?? new Map<string, string>()).set(path, key));
    }
    for (const [dir, paths] of folders) {
      const branch = git(dir, ["rev-parse", "--symbolic-full-name", "@{upstream}"])?.toString("utf-8").trim();
      const base = branch?.startsWith("refs/remotes/") ? git(dir, ["merge-base", "HEAD", branch])?.toString("utf-8").trim() : undefined;
      if (!base) continue;
      // The branch's entries in this folder, by path: mode and object. A read that fails leaves the folder out.
      const listing = git(dir, ["ls-tree", "-r", "-z", base]);
      if (listing === null) continue;
      const tree = new Map<string, { mode: string; object: string }>();
      for (const line of listing.toString("utf-8").split("\0")) {
        const tab = line.indexOf("\t");
        const entry = tab > 0 && paths.has(line.slice(tab + 1)) ? /^(\d{6}) \w+ ([0-9a-f]+)$/.exec(line.slice(0, tab)) : null;
        if (entry !== null) tree.set(line.slice(tab + 1), { mode: entry[1], object: entry[2] });
      }
      const listed = [...paths.keys()].filter((path) => tree.has(path));
      const blobs = blobsAt(dir, listed.map((path) => tree.get(path)?.object ?? ""));
      if (blobs === null) continue;
      const theirs = new Map(listed.map((path, index) => [path, blobs[index]]));
      // Where git keeps no executable bit (core.fileMode off, as Git for Windows sets it), the file now counts with
      // either mode; what the work found compares exactly, so a teammate's change of the bit alone is still a move.
      const anyFileMode = git(dir, ["config", "--type=bool", "--get", "core.filemode"])?.toString("utf-8").trim() === "false";
      const file = (mode: string | undefined): boolean => mode === "100644" || mode === "100755";
      // Whether a listing entry is exactly the branch's copy: the same mode (`either`: the two file modes as one),
      // and the same content as the walk reads it, or for a submodule the same commit. An entry of the older listing
      // form, its object alone, never is.
      const asTheBranch = (path: string, entry: string | undefined, either = false): boolean => {
        const branch = tree.get(path);
        const [mode, sha] = entry?.split(" ") ?? [];
        if (branch === undefined || sha === undefined) return false;
        if (mode !== branch.mode && !(either && file(mode) && file(branch.mode))) return false;
        const blob = theirs.get(path);
        return mode === "160000" ? sha === branch.object : blob != null && holdsContent(blob, sha);
      };
      const added: string[] = [];
      const others = new Map<string, string>();
      for (const [path, key] of paths) {
        const was = start.get(key);
        if (was === undefined) {
          if (tree.has(path)) added.push(path);
        } else if (!asTheBranch(path, was)) {
          others.set(path, was.split(" ").at(-1) ?? "");
        }
      }
      const earlier = heldOnHistory(dir, base, others);
      for (const path of [...added, ...[...others.keys()].filter((one) => earlier.has(one))]) {
        const key = paths.get(path) ?? "";
        const blob = theirs.get(path);
        copies.set(key, {
          sha: blob == null ? "" : committedTextSha256(blob),
          held: tree.has(path) ? asTheBranch(path, now.get(key), anyFileMode) : !now.has(key),
        });
      }
    }
  } catch {
    // Nothing read: every file is named like any other changed file.
  }
  return copies;
}

// Of `found` (each path with the content the work found there), the ones a
// commit on `rev`'s history held so: read at and before each of the newest
// changes to the path there, from one path-limited `git log` and one read.
function heldOnHistory(dir: string, rev: string, found: ReadonlyMap<string, string>): Set<string> {
  const held = new Set<string>();
  if (found.size === 0) return held;
  const log = git(dir, ["log", "--stdin", "--no-show-signature", "--format=%x01%H", "--name-only", "--no-renames", "--relative", "-z"],
    `${rev}\n--\n${[...found.keys()].map((path) => `./${path}\n`).join("")}`);
  if (log === null) return held;
  const changes = new Map<string, string[]>();
  for (const entry of log.toString("utf-8").split("\x01").slice(1)) {
    const [commit, ...paths] = entry.split("\0");
    for (const path of paths.map((name) => name.replace(/^\n/, "")).filter(Boolean)) {
      const seen = changes.get(path) ?? [];
      if (seen.length < COMMITS_SEARCHED) changes.set(path, [...seen, commit]);
    }
  }
  const asked = [...changes].flatMap(([path, commits]) => commits.flatMap((commit) => [
    { path, name: `${commit}:./${path}` }, { path, name: `${commit}^:./${path}` },
  ]));
  const blobs = blobsAt(dir, asked.map((one) => one.name));
  if (blobs === null) return held;
  asked.forEach(({ path }, index) => {
    const blob = blobs[index];
    if (blob !== null && holdsContent(blob, found.get(path) ?? "")) held.add(path);
  });
  return held;
}

// What the project's AI-DLC installs recorded writing (each harness's
// `tools/data/aidlc-manifest.json`, kept by `aidlc config`): the files written
// whole, and the shared files that hold AI-DLC's marked part, each with the
// hash written. A record that cannot be read records nothing.
interface InstallRecord {
  whole: Map<string, string[]>;
  parts: Map<string, Array<{ marker: string; hash: string }>>;
}

function installRecord(projectDir: string): InstallRecord {
  const record: InstallRecord = { whole: new Map(), parts: new Map() };
  const add = <T>(map: Map<string, T[]>, path: string, value: T): void => {
    map.set(path, [...(map.get(path) ?? []), value]);
  };
  const object = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  try {
    for (const harness of discoverProjectHarnesses(projectDir)) {
      let manifest: Record<string, unknown>;
      try {
        manifest = object(JSON.parse(readFileSync(join(harness.root, "tools", "data", "aidlc-manifest.json"), "utf-8")));
      } catch {
        continue;
      }
      for (const [path, hash] of Object.entries(object(manifest.files))) {
        if (typeof hash === "string") add(record.whole, path, hash);
      }
      for (const [path, value] of Object.entries(object(manifest.rootContributions))) {
        const part = object(value);
        if (typeof part.hash !== "string") continue;
        if (part.policy === "whole-file") add(record.whole, path, part.hash);
        if (part.policy === "managed-block") {
          add(record.parts, path, { marker: typeof part.marker === "string" && part.marker ? part.marker : basename(path), hash: part.hash });
        }
      }
    }
  } catch {
    // No harness the project can name: nothing is recorded.
  }
  return record;
}

// The file's bytes now, or null when it cannot be read.
function bytesNow(projectDir: string, path: string): Buffer | null {
  try {
    return readFileSync(join(projectDir, path));
  } catch {
    return null;
  }
}

// Whether this is a file AI-DLC's install wrote whole and it still holds what
// the install record says was written.
function wholeAsInstalled(record: InstallRecord, path: string, bytes: Buffer): boolean {
  return (record.whole.get(path) ?? []).some((hash) => holdsRecordedWrite(bytes, hash));
}

// Whether AI-DLC's install wrote this file as it is now: the whole file, or in
// a shared file its marked part, with the person's part as it was before the
// build (git's copy of it). With no copy, which part changed cannot be told,
// and the file is named.
function writtenByInstall(projectDir: string, record: InstallRecord, file: BroughtFile): boolean {
  if (!record.whole.has(file.path) && !record.parts.has(file.path)) return false;
  const bytes = bytesNow(projectDir, file.path);
  if (bytes === null) return false;
  if (wholeAsInstalled(record, file.path, bytes)) return true;
  const text = bytes.toString("utf-8");
  for (const { marker, hash } of record.parts.get(file.path) ?? []) {
    const now = markedPart(file.path, text, marker);
    if (now?.block == null || !holdsRecordedWrite(now.block, hash)) continue;
    const copy = committedCopy(projectDir, file);
    if (copy !== null && onlyMarkedPartChanged(file.path, text, copy.blob.toString("utf-8"), marker)) return true;
  }
  return false;
}

// A key of the source listing as the project's own file; null for a link's
// target or a recorded checkout, which are listed beside the project's files.
function listedFile(key: string): { repo: string; path: string } | null {
  const parsed = splitSourcePathKey(key);
  if (parsed === null || parsed.path.endsWith("@target") || /^[^/]*@checkout\//.test(parsed.path)) return null;
  return parsed;
}

// The listings this machine took, in AI-DLC's ignored engine folder of the
// record the run's audit is in (the space's own with no work).
const TAKEN_DIR = "brought-files";

interface Brought {
  listing: WorkspaceSourceListing;
  // Taken on this machine: an earlier build's code may be in it, so the files
  // the walk reads as code by name are never named from it.
  taken: boolean;
}

function inAuditOrder(rows: readonly AuditShardEvent[]): AuditShardEvent[] {
  return [...rows].sort((a, b) =>
    a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1) : a.shardIndex - b.shardIndex || a.pos - b.pos);
}

// The name this machine's listing takes. For a stage run on its own: its run's
// first isolated start since one last finished, so a run started over with
// other settings is the same run, as its kept copy is. For the work: the start
// listing this machine does not hold (the row workStartSourceBaseline reads).
function takenName(rows: readonly AuditShardEvent[], single: boolean): string | null {
  const ordered = inAuditOrder(rows);
  if (!single) {
    const started = ordered.filter((row) =>
      row.event === "WORKFLOW_STARTED" && !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:")).at(-1);
    const baseline = started === undefined ? null : auditBlockField(started.block, "Source Baseline");
    const hash = /^sha256:([0-9a-f]{64})$/.exec(baseline ?? "")?.[1];
    return hash === undefined ? null : `work-${hash.slice(0, 12)}.tsv`;
  }
  let start: AuditShardEvent | null = null;
  for (const row of ordered) {
    if (auditBlockField(row.block, "Workflow") !== `single-stage:${STAGE}` || auditBlockField(row.block, "Stage") !== STAGE) continue;
    if (row.event === "STAGE_COMPLETED") start = null;
    else if (row.event === "STAGE_STARTED") start ??= row;
  }
  if (start === null) return null;
  const id = createHash("sha256").update(`${start.timestamp}\n${basename(start.shard)}\n${start.pos}\n${start.block}`).digest("hex");
  return `single-${id.slice(0, 12)}.tsv`;
}

// What the work's Units built before this machine picked the work up (each
// Unit's source-manifest.json, kept with the record) is the work's own.
function withoutUnitClaims(projectDir: string, listing: WorkspaceSourceListing): WorkspaceSourceListing {
  const claims = unitSourceManifests(projectDir).map(({ manifest }) => manifest);
  if (claims.length === 0) return listing;
  return new Map([...listing].filter(([key]) => !claims.some((claim) => sourceClaimCovers(key, claim))));
}

type UnitSourceManifest = Extract<ReturnType<typeof readUnitSourceManifest>, { ok: true }>;

/** Each Unit's Code Generation `source-manifest.json` kept with the record, the ones that read. */
export function unitSourceManifests(projectDir: string): { unit: string; manifest: UnitSourceManifest }[] {
  const record = recordDir(projectDir);
  let units: string[] = [];
  try {
    units = record === null ? [] : readdirSync(join(record, "construction"));
  } catch {
    // Nothing built yet.
  }
  return units.flatMap((unit) => {
    const read = readUnitSourceManifest(projectDir, STAGE, unit);
    return read.ok ? [{ unit, manifest: read }] : [];
  });
}

// The listing the person's files are read from, by the note and the gate's
// compare alike: the one the work kept when it started; for a stage run on its
// own, or a clone that does not hold the work's, the one this machine took
// when that run's Code Generation first ran here, as the files there then are
// the person's. `take` lets that step take it, once; a read-only probe and the
// gate only read it.
function broughtListing(projectDir: string, rows: readonly AuditShardEvent[], single: boolean, take: boolean): Brought | null {
  if (!single) {
    const brought = workStartSourceBaseline(projectDir, STAGE, undefined, undefined, rows);
    if (brought.state === "ready") return { listing: brought.listing, taken: false };
    if (brought.state !== "missing") return null;
  }
  const name = takenName(rows, single);
  if (name === null) return null;
  const listing = takenListing(projectDir, name, take, () => {
    const now = workspaceSourceState(projectDir);
    return now === null ? null : single ? now.listing : withoutUnitClaims(projectDir, now.listing);
  });
  return listing === null ? null : { listing, taken: true };
}

// A listing this machine took, read when it is here; otherwise, with `take`
// and outside a read-only probe, taken now from `now`.
function takenListing(
  projectDir: string,
  name: string,
  take: boolean,
  now: () => WorkspaceSourceListing | null,
): WorkspaceSourceListing | null {
  const path = join(engineDir(projectDir), TAKEN_DIR, name);
  let here = true;
  try {
    lstatSync(path);
  } catch {
    here = false;
  }
  if (here) return parseSourceListing(readRegularFileNoFollowOrThrow(path, "the files listed when this run started").toString("utf-8"));
  if (!take || isReadOnlyEngineProbe()) return null;
  const listing = now();
  if (listing !== null) writeEngineFileNoFollow(projectDir, `${TAKEN_DIR}/${name}`, serializeSourceListing(listing));
  return listing;
}

// Where this build attempt started: the stage's own listing, or, on a machine
// that took its own (broughtListing) and does not hold the stage's, that one.
function attemptStart(projectDir: string, rows: readonly AuditShardEvent[], brought: Brought | null): WorkspaceSourceListing | null {
  const stage = currentStageSourceBaseline(projectDir, STAGE, false, undefined, undefined, rows);
  return stage.state === "ready" ? stage.listing : stage.state === "missing" && brought?.taken ? brought.listing : null;
}

// The files as a Unit's Code Generation found them in this attempt, taken here
// when its first step is handed out (broughtFileNames): its Request Changes
// keeps them, a new attempt takes them again.
function unitListingName(start: WorkspaceSourceListing, unit: string): string {
  const attempt = sourceListingSha256(serializeSourceListing(start));
  return `unit-${createHash("sha256").update(`${attempt}\n${unit}`).digest("hex").slice(0, 12)}.tsv`;
}

// That listing, when this machine took it.
function unitStartListing(projectDir: string, start: WorkspaceSourceListing, unit: string): WorkspaceSourceListing | null {
  return takenListing(projectDir, unitListingName(start, unit), false, () => null);
}

/**
 * The files as this build found them, for the paths it changed since
 * (`lookup source-changes`): a Unit's own listing when this machine took it,
 * so an earlier Unit's files are not this one's (`since: "unit"`), otherwise
 * the attempt's start (`since: "stage"`). Null when neither is here.
 */
export function buildStartListing(
  projectDir: string,
  unit: string | null,
): { listing: WorkspaceSourceListing; since: "unit" | "stage" } | null {
  const rows = readAuditShardEvents(projectDir);
  const brought = broughtListing(projectDir, rows, false, false);
  const start = attemptStart(projectDir, rows, brought);
  if (start === null) return null;
  // With no listing of the work's start, no Unit's own was taken either (broughtFileNames).
  const own = unit === null || brought === null ? null : unitStartListing(projectDir, start, unit);
  return own === null ? { listing: start, since: "stage" } : { listing: own, since: "unit" };
}

/**
 * The files the work started with that this build changed or deleted. On a
 * brownfield project the code the work changes on purpose is not one of them:
 * a changed file counts there only when the source walk does not read it as
 * code by its name (a README, LICENSE, docs, .env). `attempt` names the build
 * attempt (its starting listing), so a redo says it again. At a Unit's approval
 * (`unit`) the start is the files as that Unit found them, when this machine
 * took them, so an earlier Unit's change is not this one's to undo.
 */
export function broughtFilesChanged(
  projectDir: string,
  stateContent: string,
  unit: string | null = null,
): { files: BroughtFile[]; attempt: string } | null {
  const rows = readAuditShardEvents(projectDir);
  const brought = broughtListing(projectDir, rows, false, false);
  if (brought === null) return null;
  const start = attemptStart(projectDir, rows, brought);
  if (start === null) return null;
  const before = (unit === null ? null : unitStartListing(projectDir, start, unit)) ?? start;
  const current = workspaceSourceState(projectDir);
  if (current === null) return null;
  const greenfield = declaredProjectType(getField(stateContent, "Project Type") ?? undefined) === "Greenfield";
  const recorded = recordedSourceListingForCompare(projectDir, before, current);
  const files: BroughtFile[] = [];
  let install: InstallRecord | undefined;
  for (const key of sourceListingChangedKeys(recorded, current.listing)) {
    const entry = recorded.get(key);
    if (entry === undefined || !brought.listing.has(key)) continue;
    const parsed = listedFile(key);
    if (parsed === null) continue;
    const deleted = !current.listing.has(key);
    if ((brought.taken || (!deleted && !greenfield)) && isSourceFileName(basename(parsed.path))) continue;
    const file = { repo: parsed.repo, path: parsed.path, deleted, sha: entry.split(" ").at(-1) ?? "" };
    // AI-DLC installs at the project's root, never in a sibling repo.
    if (!deleted && file.repo === "") {
      install ??= installRecord(projectDir);
      if (writtenByInstall(projectDir, install, file)) continue;
    }
    files.push(file);
  }
  // A file the remote branch of its own repository holds as it is now is no change of the build's; one that branch
  // moved on and the build changed on top is put back as that branch has it, or as the work found it when the
  // branch has no such file.
  const remote = remoteBranchCopies(projectDir, recorded, current.listing, files.map((file) => sourcePathKey(file.repo, file.path)));
  const named = files.flatMap((file) => {
    const copy = remote.get(sourcePathKey(file.repo, file.path));
    return copy === undefined ? [file] : copy.held ? [] : [{ ...file, sha: copy.sha || file.sha }];
  });
  if (named.length === 0) return null;
  return { files: named, attempt: sourceListingSha256(serializeSourceListing(before)) };
}

/**
 * The files the project held when this work started, as the plan writer and
 * the builder are told them (`brought_files_note`): the listing the gate
 * compares, less the code itself on existing code and the files AI-DLC's
 * install wrote whole and still holds as written, in the order the gate's line
 * names them. `single` is a stage run on its own. Called on a step whose body
 * runs here, so it may take this machine's listing (broughtListing), and for a
 * Unit's step (`unit`) the files as that Unit found them (unitListingName).
 * Null when no listing is here or none is left.
 */
export function broughtFileNames(
  projectDir: string,
  stateContent: string | null,
  single = false,
  unit: string | null = null,
): string[] | null {
  try {
    if (stateContent === null && !single) return null;
    const rows = readAuditShardEvents(projectDir);
    const brought = broughtListing(projectDir, rows, single, true);
    if (brought === null) return null;
    if (unit !== null && !single) {
      try {
        const start = attemptStart(projectDir, rows, brought);
        if (start !== null) {
          takenListing(projectDir, unitListingName(start, unit), true, () => workspaceSourceState(projectDir)?.listing ?? null);
        }
      } catch {
        // Not taken: that Unit's approval compares from the attempt's start.
      }
    }
    const code = brought.taken || declaredProjectType(getField(stateContent ?? "", "Project Type") ?? undefined) !== "Greenfield";
    let install: InstallRecord | undefined;
    const files: BroughtFile[] = [];
    for (const key of brought.listing.keys()) {
      const parsed = listedFile(key);
      if (parsed === null || (code && isSourceFileName(basename(parsed.path)))) continue;
      if (parsed.repo === "") {
        install ??= installRecord(projectDir);
        const bytes = install.whole.has(parsed.path) ? bytesNow(projectDir, parsed.path) : null;
        if (bytes !== null && wholeAsInstalled(install, parsed.path, bytes)) continue;
      }
      files.push({ ...parsed, deleted: false, sha: "" });
    }
    return files.length === 0 ? null : inLineOrder(files).map(shown);
  } catch {
    // A note the build may go without never stops the step.
    return null;
  }
}

/**
 * The sentence for the plan writer and the builder, naming the first of `names` and counting the rest. Its reasons to
 * change one are the Code Generation stage rule's own (Critical Rules); the work's plan is not one of them, since with
 * Plan Approval off the plan is the agent's.
 */
export function broughtFilesNote(names: readonly string[]): string {
  const named = names.slice(0, NAMED_MAX).map((name) => `\`${name}\``).join(", ");
  const more = names.length > NAMED_MAX
    ? `, and ${names.length - NAMED_MAX} more that were here before this work started.`
    : ".";
  return `These files were in this project before this work started and are the person's: ${named}${more} ` +
    "Leave them as they are: change one only when the person asks for it or the work cannot be built without it.";
}

// The order the line names files in: deleted, then top-level, then by path.
function inLineOrder<T extends BroughtFile>(files: readonly T[]): T[] {
  return [...files].sort((a, b) =>
    Number(b.deleted) - Number(a.deleted) ||
    Number(shown(a).includes("/")) - Number(shown(b).includes("/")) ||
    (shown(a) < shown(b) ? -1 : shown(a) > shown(b) ? 1 : 0)
  );
}

// Each file with the commit that holds what the build replaced: HEAD for all of
// them in one read per repo, then the history of the named ones HEAD does not hold.
function withWayBack(projectDir: string, files: readonly BroughtFile[]): ChangedFile[] {
  const ordered = inLineOrder(files);
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

// The file's path quoted, or null when it or its repo's folder cannot be.
function quotedIn(file: ChangedFile): string | null {
  return file.repo && quoted(file.repo) === null ? null : quoted(file.path);
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
    const path = file.ref === null ? null : quotedIn(file);
    if (file.ref === null || path === null) continue;
    fromGit.push(file);
    const command = `git${file.repo ? ` -C ${quoted(file.repo)}` : ""} checkout ${file.ref} --`;
    groups.set(command, [...(groups.get(command) ?? []), path]);
  }
  const commands = andList([...groups].map(([command, paths]) => `\`${command} ${paths.join(" ")}\``));
  const noCopy = named.filter((file) => file.ref === null);
  const noCommand = named.filter((file) => file.ref !== null && quotedIn(file) === null);
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
 * files, so git is asked for each file's way back only when the line will be
 * said). With Unit
 * checkpoints, each Unit's checkpoint approves the build and the stage gate the
 * engine settles after them does not say it. `unit` names the Unit whose
 * approval it is (a team Unit's gate, a Unit's checkpoint).
 */
export function unheardBroughtFilesLine(
  projectDir: string,
  stateContent: string | null,
  session: string | null | undefined,
  atCheckpoint = false,
  unit: string | null = null,
): { line: string; key: string } | null {
  try {
    if (stateContent === null || constructionCheckpointsApply(stateContent) !== atCheckpoint) return null;
    const changed = broughtFilesChanged(projectDir, stateContent, unit);
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
