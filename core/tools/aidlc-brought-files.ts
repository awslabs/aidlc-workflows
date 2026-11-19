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
// record or the fingerprints config keeps of its writes (keepSetupWrites) say,
// is AI-DLC's and not the build's change (an `aidlc update` and `aidlc config`
// while the work was open rewrite them).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { holdsRecordedWrite, markedPart, onlyMarkedPartChanged } from "./aidlc-distribution.ts";
import { isReadOnlyEngineProbe, readRegularFileNoFollowOrThrow, writeFileAtomic } from "./aidlc-locks.ts";
import { discoverProjectHarnesses, workspaceEngineFile } from "./aidlc-runtime-paths.ts";
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
  readUnitSourceManifest,
  recordDir,
  recordedSourceListingForCompare,
  repoDir,
  serializeSourceListing,
  sourceClaimCovers,
  sourceListingChangedKeys,
  sourceListingSha256,
  splitSourcePathKey,
  workStartSourceBaseline,
  type WorkspaceSourceListing,
  workspaceSourceState,
  writeEngineFileNoFollow,
} from "./aidlc-lib.ts";
import { HARNESS_IDENTITY_KEYS, jsoncDocumentValue, jsonEntryHash, refreshedTablesRel, unbaselinedGenerated } from "./aidlc-distribution.ts";
import { reposMoveToCommit } from "./aidlc-workspace-manifest.ts";

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
  // The repo's folder as the person types it from the workspace ("" for the
  // workspace itself): where repos.json or repos.local.json puts it.
  gitDir: string;
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

// What the project's AI-DLC installs recorded writing (each harness's
// `tools/data/aidlc-manifest.json`, kept by `aidlc config`): the files written
// whole, and the shared files that hold AI-DLC's marked part, each with the
// hash written; the settings files config merges with the project's own; the
// files written by a JSON policy with no hash of the whole; and the harness
// folders whose record was read. A record that cannot be read records nothing.
interface InstallRecord {
  whole: Map<string, string[]>;
  parts: Map<string, Array<{ marker: string; hash: string }>>;
  merged: Set<string>;
  unhashed: Set<string>;
  harnessDirs: string[];
}

function installRecord(projectDir: string): InstallRecord {
  const record: InstallRecord = { whole: new Map(), parts: new Map(), merged: new Set(), unhashed: new Set(), harnessDirs: [] };
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
      record.harnessDirs.push(harness.harnessDir);
      for (const [path, hash] of Object.entries(object(manifest.files))) {
        if (typeof hash === "string") add(record.whole, path, hash);
      }
      for (const path of Object.keys(object(manifest.entries))) record.merged.add(path);
      for (const [path, value] of Object.entries(object(manifest.rootContributions))) {
        const part = object(value);
        if (typeof part.hash !== "string") {
          record.unhashed.add(path);
          continue;
        }
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
// build (git's copy of it). With no copy, the fingerprints config kept of its
// own writes decide (onlySetupWroteSince).
function writtenByInstall(projectDir: string, record: InstallRecord, file: BroughtFile): boolean {
  if (!record.whole.has(file.path) && !record.parts.has(file.path)) return false;
  const bytes = bytesNow(projectDir, file.path);
  return bytes !== null &&
    holdsInstallWrite(record, file.path, bytes, () => committedCopy(projectDir, file)?.blob.toString("utf-8") ?? null);
}

// What AI-DLC's setup and refreshes wrote to each file holding its marked part
// (.gitignore, AGENTS.md). The listing a build starts from keeps only each
// file's fingerprint, and with no commit holding the file as the build found
// it, a refresh while the approval waits read as the build's change (#3981).
// `aidlc config` keeps, in the workspace's machine-local engine folder, each
// such file's run: the file as config found it, then as it left it after each
// write, while each write finds the file as the run's last. Config never
// changes the person's part, so every file in one run holds the person's part
// as the run began. When git's HEAD holds the file as config finds it, git's
// copy already tells the two apart (writtenByInstall) and no run is kept. A
// copy install keeps no install record, so there git's copy cannot tell
// AI-DLC's part, and the runs its session start writes (addRootBlocks) are
// kept whatever git holds. Read only by the approval's check; a record that
// cannot be read is none.
const SETUP_WRITES = "setup-writes.json";
// A run's newest fingerprints, as many as a long wait could need.
const SETUP_WRITES_KEPT = 32;

type SetupWrites = Record<string, string[]>;

function readSetupWrites(projectDir: string): SetupWrites {
  const runs: SetupWrites = {};
  try {
    const path = workspaceEngineFile(projectDir, SETUP_WRITES);
    const value: unknown = JSON.parse(readRegularFileNoFollowOrThrow(path, "what AI-DLC's setup wrote").toString("utf-8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return runs;
    for (const [file, run] of Object.entries(value)) {
      if (Array.isArray(run) && run.length > 0 && run.every((sha) => typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha))) {
        runs[file] = run;
      }
    }
  } catch {
    // No record, or one that cannot be read: none.
  }
  return runs;
}

/** A file config writes: its bytes as config found them (null: not there) and as it leaves them (null: removed). */
export interface SetupWrite {
  path: string;
  found: Buffer | null;
  left: Buffer | null;
}

/**
 * Keep the run of each file holding AI-DLC's marked part that `aidlc config`,
 * or a copy install's session start, just wrote, once its changes are in.
 * `recorded` is false for a writer with no install record of its part (the
 * session start). Best-effort: never throws, and writes nothing where the
 * engine folder is a link or cannot be made.
 */
export function keepSetupWrites(projectDir: string, writes: readonly SetupWrite[], recorded = true): void {
  if (writes.length === 0) return;
  try {
    const path = workspaceEngineFile(projectDir, SETUP_WRITES);
    const folder = lstatSync(dirname(path), { throwIfNoEntry: false });
    if (folder === undefined || !folder.isDirectory() || folder.isSymbolicLink()) return;
    const runs = readSetupWrites(projectDir);
    const was = JSON.stringify(runs);
    const found = writes.map((write) => ({
      repo: "", path: write.path, deleted: false, sha: write.found === null ? "" : committedTextSha256(write.found),
    }));
    const held = recorded ? heldAtHead(projectDir, found.filter((file) => file.sha !== "")) : new Set<BroughtFile>();
    writes.forEach((write, index) => {
      const file = found[index];
      const run = runs[write.path];
      if (held.has(file) || write.left === null) {
        delete runs[write.path];
        return;
      }
      const from = file.sha === "" ? [] : run?.at(-1) === file.sha ? run : [file.sha];
      runs[write.path] = [...from, committedTextSha256(write.left)].slice(-SETUP_WRITES_KEPT);
    });
    const now = JSON.stringify(runs);
    if (now !== was) writeFileAtomic(path, `${JSON.stringify(runs, null, 2)}\n`);
  } catch {
    // The approval names the file, as with no record.
  }
}

// Whether only AI-DLC's setup and refreshes wrote to the file since the build
// found it as `start`: that is in the file's run, and the file now (`now`, its
// listing entry) is the run's last.
function onlySetupWroteSince(runs: SetupWrites, path: string, start: string, now: string | undefined): boolean {
  const run = runs[path];
  const sha = now?.split(" ").at(-1);
  if (run === undefined || sha === undefined || run.at(-1) !== sha) return false;
  const current = currentFingerprintForm(start);
  return run.includes(start) || (current !== null && run.includes(current));
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
  let setupWrites: SetupWrites | undefined;
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
      setupWrites ??= readSetupWrites(projectDir);
      if (onlySetupWroteSince(setupWrites, file.path, file.sha, current.listing.get(key))) continue;
    }
    files.push(file);
  }
  if (files.length === 0) return null;
  return { files, attempt: sourceListingSha256(serializeSourceListing(before)) };
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
export function withWayBack(projectDir: string, files: readonly BroughtFile[]): ChangedFile[] {
  const ordered = inLineOrder(files);
  const atHead = new Set<BroughtFile>();
  for (const repo of new Set(ordered.map((file) => file.repo))) {
    const dir = repo === "" ? projectDir : repoDir(projectDir, repo);
    for (const file of heldAtHead(dir, ordered.filter((one) => one.repo === repo))) atHead.add(file);
  }
  const gitDirOf = (repo: string): string =>
    repo === "" ? "" : relative(projectDir, repoDir(projectDir, repo)).split(sep).join("/") || ".";
  return ordered.map((file, index) => {
    const gitDir = gitDirOf(file.repo);
    if (atHead.has(file)) return { ...file, ref: "HEAD", gitDir };
    if (index >= NAMED_MAX) return { ...file, ref: null, gitDir };
    return { ...file, ref: olderCommit(file.repo === "" ? projectDir : repoDir(projectDir, file.repo), file), gitDir };
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
    const dir = file.gitDir === "" ? "" : quoted(file.gitDir);
    if (file.ref === null || path === null || dir === null) continue;
    fromGit.push(file);
    const command = `git${dir ? ` -C ${dir}` : ""} checkout ${file.ref} --`;
    groups.set(command, [...(groups.get(command) ?? []), path]);
  }
  const commands = andList([...groups].map(([command, paths]) => `\`${command} ${paths.join(" ")}\``));
  const noCopy = named.filter((file) => file.ref === null);
  const noCommand = named.filter((file) => file.ref !== null && (quoted(file.path) === null || (file.gitDir !== "" && quoted(file.gitDir) === null)));
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

// Whether a file AI-DLC's install wrote holds that write now: the whole file,
// or in a shared file its marked part, with the person's part as `before` has
// it (git's copy of the file; null when there is none, and then which part
// changed cannot be told). writtenByInstall and ownFilesToCommit both ask it.
function holdsInstallWrite(record: InstallRecord, path: string, bytes: Buffer, before: () => string | null): boolean {
  if (wholeAsInstalled(record, path, bytes)) return true;
  const text = bytes.toString("utf-8");
  for (const { marker, hash } of record.parts.get(path) ?? []) {
    const now = markedPart(path, text, marker);
    if (now?.block == null || !holdsRecordedWrite(now.block, hash)) continue;
    const was = before();
    if (was !== null && onlyMarkedPartChanged(path, text, was, marker)) return true;
  }
  return false;
}

// The top-level keys whose values differ between two JSON (or JSONC) texts;
// null when either is not an object.
function changedTopKeys(text: string, before: string): string[] | null {
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const now = jsoncDocumentValue(text);
  const was = before === "" ? {} : jsoncDocumentValue(before);
  if (!object(now) || !object(was)) return null;
  const hash = (value: unknown): string => value === undefined ? "" : jsonEntryHash(value);
  return [...new Set([...Object.keys(now), ...Object.keys(was)])].filter((key) => hash(now[key]) !== hash(was[key]));
}

/**
 * What a yes to the offer after an update commits: AI-DLC's own files that git
 * shows changed here (outside aidlc/, a new one only in a folder git already
 * tracks), each still holding exactly what AI-DLC wrote with nothing of the
 * person's changed since HEAD, and the repo list's move with them.
 * `left` is the rest of AI-DLC's changed files, for the person to commit. Worked
 * out from the install records and git each time, so nothing is kept and the
 * person's work since the refresh counts.
 *
 * A settings file config merges with the project's own (the record's `entries`)
 * keeps the person's uncommitted words in what it records as its write, so its
 * hash cannot tell them apart: it goes in only when `changedBefore` says git
 * showed it unchanged before the refresh (the session start lists git's changes
 * before it refreshes), and with `changedBefore` null it is left. `held` names
 * the ones left because they had changed before the refresh.
 */
export function ownFilesToCommit(
  projectDir: string,
  changedBefore: ((path: string) => boolean) | null,
): { commit: string[]; left: string[]; held: string[] } {
  const commit: string[] = [];
  const left: string[] = [];
  const held: string[] = [];
  if (git(projectDir, ["rev-parse", "--verify", "--quiet", "HEAD"]) === null) return { commit, left, held };
  const record = installRecord(projectDir);
  const text = (out: Buffer | null): string[] => out?.toString("utf-8").split("\0").filter(Boolean) ?? [];
  const status = new Map<string, string>();
  const diff = text(git(projectDir, ["diff", "--name-status", "-z", "--no-renames", "--relative", "HEAD"]));
  for (let at = 0; at + 1 < diff.length; at += 2) status.set(diff[at + 1], diff[at]);
  const tracked = new Map<string, boolean>();
  const folderTracked = (folder: string): boolean => {
    if (!tracked.has(folder)) tracked.set(folder, (git(projectDir, ["ls-files", "--", folder])?.length ?? 0) > 0);
    return tracked.get(folder) ?? false;
  };
  for (const path of text(git(projectDir, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    const slash = path.indexOf("/");
    if (slash > 0 && folderTracked(path.slice(0, slash))) status.set(path, "?");
  }
  const atHead = (path: string): string | null => git(projectDir, ["cat-file", "blob", `HEAD:./${path}`])?.toString("utf-8") ?? null;
  const headRecords = new Map(record.harnessDirs.map((dir) => {
    try {
      const files = (JSON.parse(atHead(`${dir}/tools/data/aidlc-manifest.json`) ?? "{}") as { files?: Record<string, unknown> }).files;
      return [dir, typeof files === "object" && files !== null ? files : {}] as const;
    } catch {
      return [dir, {}] as const;
    }
  }));
  const generated = new Map<string, string>();
  for (const dir of record.harnessDirs) {
    for (const path of unbaselinedGenerated(dir)) generated.set(path, dir);
    const tables = refreshedTablesRel(dir, (rel) => record.whole.has(rel));
    if (tables !== undefined) generated.set(tables, dir);
  }
  // The graph, the grid and the tables are rendered from the person's own stage
  // and scope files too; they wait while one of those is not in this commit.
  const derived: string[] = [];
  for (const [path, code] of [...status].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (path.startsWith("aidlc/")) continue;
    const dir = generated.get(path);
    const bytes = code === "D" ? null : bytesNow(projectDir, path);
    const keysAsHead = (allowed: (key: string) => boolean): boolean => {
      const changed = bytes === null ? null : changedTopKeys(bytes.toString("utf-8"), atHead(path) ?? "");
      return changed?.every(allowed) === true;
    };
    let ours: boolean;
    if (record.harnessDirs.some((harness) => path === `${harness}/tools/data/aidlc-manifest.json`)) {
      ours = bytes !== null;
    } else if (dir !== undefined && path.endsWith("/tools/data/harness.json")) {
      // The keys a refresh takes from the release; the team's own (plugins, providers, trust) stay as HEAD has them.
      // ponytail: no hash is kept of this file, so an identity key hand-edited after the refresh goes in with it.
      ours = keysAsHead((key) => HARNESS_IDENTITY_KEYS.has(key));
    } else if (dir !== undefined && (path.endsWith("/stage-graph.json") || path.endsWith("/scope-grid.json") || path.endsWith("/tables.md"))) {
      derived.push(path);
      continue;
    } else if (record.whole.has(path) || record.parts.has(path)) {
      const merged = record.merged.has(path);
      if (merged && changedBefore?.(path) === true) held.push(path);
      ours = bytes !== null && holdsInstallWrite(record, path, bytes, () => atHead(path) ?? "") &&
        (!merged || changedBefore?.(path) === false);
    } else if (record.unhashed.has(path) || dir !== undefined) {
      ours = false;
    } else if (code === "D") {
      // A file a refresh removed: the last commit's record lists it, and HEAD holds what it wrote.
      const harness = record.harnessDirs.find((name) => typeof headRecords.get(name)?.[path] === "string");
      const hash = harness === undefined ? undefined : headRecords.get(harness)?.[path];
      const blob = git(projectDir, ["cat-file", "blob", `HEAD:./${path}`]);
      if (typeof hash !== "string" || blob === null) continue;
      ours = holdsRecordedWrite(blob, hash);
    } else {
      continue;
    }
    (ours ? commit : left).push(path);
  }
  const sources = (harness: string): boolean =>
    [...status.keys()].some((path) =>
      (path.startsWith(`${harness}/aidlc-common/stages/`) || path.startsWith(`${harness}/scopes/`)) && !commit.includes(path)
    ) || left.includes(`${harness}/tools/data/harness.json`);
  const composed = (git(projectDir, ["status", "--porcelain", "-uall", "--", "aidlc/scopes"])?.length ?? 0) > 0;
  for (const path of derived) {
    const harness = generated.get(path) ?? "";
    (composed || sources(harness) || bytesNow(projectDir, path) === null ? left : commit).push(path);
  }
  commit.push(...reposMoveToCommit(projectDir));
  return { commit, left, held };
}
