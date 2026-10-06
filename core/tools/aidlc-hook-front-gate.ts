// aidlc-hook-front-gate.ts - a first look, before the engine loads, for the
// two Kiro IDE hooks that run after every shell command.
//
// Kiro IDE passes no shell command to its PostToolUse hooks, so
// rebuild-stage-graph and sync-workflow-state run after every `ls` or test run,
// and each one loads the whole engine to find, nearly always, that nothing
// changed. When the full hook finds nothing to do from a record's files it
// leaves a `<hook>.noop` mark in that record's hooks-health folder. This gate
// skips the hook only when every record in the project carries that mark and
// none of the record's files changed since. It never imports aidlc-lib, and
// whenever it cannot tell (a legacy layout, a link, a file it cannot read, a
// clock that moved, a change too close to the mark), the full hook runs.
import { closeSync, constants as fsConstants, lstatSync, openSync, readdirSync, type Stats, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const FRONT_GATED_TARGETS = ["rebuild-stage-graph", "sync-workflow-state"] as const;
export type FrontGatedTarget = (typeof FRONT_GATED_TARGETS)[number];

// A change this close to the mark may have landed after the full hook read
// the files, or share a coarse timestamp with it (2 s on FAT), so it counts.
export const NOOP_MARK_MARGIN_MS = 5000;
// A timestamp this far past now means the clock moved back since it was set.
const FUTURE_TOLERANCE_MS = 1000;
// More records than this are read by the full hook, not counted here.
const MAX_RECORDS = 200;

export function noopMarkName(hook: FrontGatedTarget): string {
  return `${hook}.noop`;
}

export function isFrontGatedTarget(target: string): target is FrontGatedTarget {
  return (FRONT_GATED_TARGETS as readonly string[]).includes(target);
}

/** The record's hooks-health folder, as hooksHealthDir in aidlc-lib names it. */
export function recordHooksHealthDir(recordRoot: string): string {
  return join(recordRoot, ".aidlc-engine", "hooks-health");
}

class Unsure extends Error {}

// lstat that treats a link, or anything unreadable other than absence, as unsure.
function entry(path: string): { kind: "file" | "dir"; mtimeMs: number; size: number } | null {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Unsure();
  }
  if (stat.isSymbolicLink()) throw new Unsure();
  if (stat.isDirectory()) return { kind: "dir", mtimeMs: stat.mtimeMs, size: 0 };
  if (stat.isFile()) return { kind: "file", mtimeMs: stat.mtimeMs, size: stat.size };
  throw new Unsure();
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    throw new Unsure();
  }
}

// Every record root: each space's intents folder (the record when no intent is
// selected) and each intent folder in it.
function recordRoots(projectDir: string): string[] {
  const workspace = join(projectDir, "aidlc");
  const root = entry(workspace);
  if (root === null) return [];
  if (root.kind !== "dir") throw new Unsure();
  const spacesDir = join(workspace, "spaces");
  const spaces = entry(spacesDir);
  if (spaces === null) return [];
  if (spaces.kind !== "dir") throw new Unsure();
  const roots: string[] = [];
  for (const space of list(spacesDir)) {
    const spaceEntry = entry(join(spacesDir, space));
    if (spaceEntry === null || spaceEntry.kind !== "dir") continue;
    const intents = join(spacesDir, space, "intents");
    const intentsEntry = entry(intents);
    if (intentsEntry === null) continue;
    if (intentsEntry.kind !== "dir") throw new Unsure();
    roots.push(intents);
    for (const name of list(intents)) {
      const record = entry(join(intents, name));
      if (record?.kind === "dir") roots.push(join(intents, name));
    }
    if (roots.length > MAX_RECORDS) throw new Unsure();
  }
  return roots;
}

// The newest change among a record's files this hook reads, or null when the
// hook has nothing in this record to look at.
function newestInput(record: string, hook: FrontGatedTarget, now: number): number | null {
  const state = entry(join(record, "aidlc-state.md"));
  if (state !== null && state.kind !== "file") throw new Unsure();
  let newestShard: number | null = null;
  const auditDir = join(record, "audit");
  const audit = entry(auditDir);
  if (audit !== null) {
    if (audit.kind !== "dir") throw new Unsure();
    for (const name of list(auditDir)) {
      if (!name.endsWith(".md")) continue;
      const shard = entry(join(auditDir, name));
      if (shard === null) continue;
      if (shard.kind !== "file") throw new Unsure();
      if (shard.size > 0) newestShard = Math.max(newestShard ?? 0, shard.mtimeMs);
    }
  }
  let inputs: number[];
  if (hook === "sync-workflow-state") {
    // The sync reads the state file and the audit tail; with no state it stops.
    if (state === null) return null;
    inputs = [state.mtimeMs, newestShard ?? 0];
  } else {
    // The rebuild reads the audit and compares the compiled graph with it.
    if (newestShard === null) return null;
    const graph = entry(join(record, "runtime-graph.json"));
    if (graph !== null && graph.kind !== "file") throw new Unsure();
    inputs = [newestShard, graph?.mtimeMs ?? 0, state?.mtimeMs ?? 0];
  }
  const newest = Math.max(...inputs);
  if (newest > now + FUTURE_TOLERANCE_MS) throw new Unsure();
  return newest;
}

// The mark's time, when the full hook left one this record's files have not outlived.
function markHolds(record: string, hook: FrontGatedTarget, newest: number, now: number): boolean {
  const health = recordHooksHealthDir(record);
  for (const part of [join(record, ".aidlc-engine"), health]) {
    const dir = entry(part);
    if (dir === null) return false;
    if (dir.kind !== "dir") throw new Unsure();
  }
  const mark = entry(join(health, noopMarkName(hook)));
  if (mark === null) return false;
  if (mark.kind !== "file") throw new Unsure();
  if (mark.mtimeMs > now + FUTURE_TOLERANCE_MS) return false;
  return mark.mtimeMs - newest >= NOOP_MARK_MARGIN_MS;
}

// Where the hooks would find the project: the explicit project environment,
// else the working folder and the project the adapter file sits in. The gate
// skips only when every one of them has nothing to do.
export function frontGateProjectDirs(adapterPath: string, cwd = process.cwd()): string[] {
  const explicit = process.env.AIDLC_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR;
  if (explicit) return [isAbsolute(explicit) ? explicit : resolve(cwd, explicit)];
  const dirs = [cwd];
  const hooksDir = dirname(adapterPath);
  const harnessDir = dirname(hooksDir);
  if (basename(hooksDir) === "hooks" && basename(harnessDir).startsWith(".")) dirs.push(dirname(harnessDir));
  return [...new Set(dirs.map((dir) => resolve(dir)))];
}

/**
 * Whether the hook has nothing to do in any of these projects. On a skipped
 * rebuild the record's existing heartbeat is refreshed, as the full hook would,
 * so hook liveness reads the same.
 */
export function frontGateSkips(target: string, projectDirs: readonly string[], now = Date.now()): boolean {
  if (!isFrontGatedTarget(target) || projectDirs.length === 0) return false;
  if (process.env.AIDLC_HOOK_DEBUG) return false;
  const marked: string[] = [];
  try {
    for (const projectDir of projectDirs) {
      // The flat layout before spaces is moved by the engine itself.
      if (entry(join(projectDir, "aidlc-docs")) !== null) return false;
      if (entry(join(projectDir, "aidlc", ".aidlc-hook-debug")) !== null) return false;
      for (const record of recordRoots(projectDir)) {
        const newest = newestInput(record, target, now);
        if (newest === null) continue;
        if (!markHolds(record, target, newest, now)) return false;
        marked.push(record);
      }
    }
  } catch {
    return false;
  }
  if (target === "rebuild-stage-graph") {
    const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const record of marked) refreshHeartbeat(join(recordHooksHealthDir(record), "rebuild-stage-graph.last"), stamp);
  }
  return true;
}

// Rewrite a heartbeat that is already there, never following a link, with
// the open flags the engine's own heartbeat writer uses.
function refreshHeartbeat(path: string, stamp: string): void {
  try {
    if (entry(path)?.kind !== "file") return;
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 0o644);
    try {
      writeSync(fd, stamp);
    } finally {
      closeSync(fd);
    }
  } catch {
    // A heartbeat that cannot be written is lost telemetry, never a blocked command.
  }
}
