// failed-fixture.ts - keep a failed fixture's evidence where CI uploads it.
//
// Fixture projects live under the OS temporary directory, which a hosted runner
// discards at teardown. The collectors publish only the run's log directory
// (AIDLC_TEST_LOG_DIR, under tests/logs/), and the CI sanitizer then redacts it
// before upload. retainFailedFixture copies a bounded snapshot of the project
// there. It copies regular files only, never follows a link or junction, and
// records every entry it left out, so a snapshot can neither escape the project
// nor grow without bound.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

export interface RetainLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Entries the walk may visit before it stops, copied or not. */
  maxEntries: number;
  /** Omissions listed by path; later ones are only counted by reason. */
  maxListedSkips: number;
}

export const RETAIN_LIMITS: RetainLimits = {
  maxFiles: 5_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEntries: 50_000,
  maxListedSkips: 500,
};

// Dependency and repository internals are reproducible and large.
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

export interface RetainedSnapshot {
  path: string;
  copied: number;
  bytes: number;
  skipped: Array<{ path: string; reason: string }>;
  /** Every omission by reason, including the unlisted ones. */
  skippedByReason: Record<string, number>;
  /** True when the walk stopped at maxEntries. */
  truncated: boolean;
}

let retainedCount = 0;

/**
 * Copy a bounded, link-safe snapshot of `project` beneath
 * `$AIDLC_TEST_LOG_DIR/failed-fixtures/<label>-<pid>-<n>/`. The workflow
 * record under `aidlc/` is copied first so the caps never starve it. Returns
 * null when no log directory is set (a local run keeps the original project).
 */
export function retainFailedFixture(
  project: string,
  label: string,
  limits: RetainLimits = RETAIN_LIMITS,
): RetainedSnapshot | null {
  // Called from a failing test's finally block: never replace its failure.
  try {
    return snapshotFixture(project, label, limits);
  } catch (error) {
    console.error(`failed-fixture snapshot of ${project} was not kept: ${String(error)}`);
    return null;
  }
}

function snapshotFixture(
  project: string,
  label: string,
  limits: RetainLimits,
): RetainedSnapshot | null {
  const logDir = process.env.AIDLC_TEST_LOG_DIR;
  if (!logDir) return null;
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "-") || "fixture";
  const destination = join(
    logDir,
    "failed-fixtures",
    `${safeLabel}-${process.pid}-${++retainedCount}`,
  );
  mkdirSync(destination, { recursive: true });
  const snapshot: RetainedSnapshot = {
    path: destination, copied: 0, bytes: 0, skipped: [], skippedByReason: {}, truncated: false,
  };
  const posix = (path: string) => relative(project, path).split(sep).join("/");
  const skip = (path: string, reason: string): void => {
    snapshot.skippedByReason[reason] = (snapshot.skippedByReason[reason] ?? 0) + 1;
    if (snapshot.skipped.length < limits.maxListedSkips) snapshot.skipped.push({ path: posix(path), reason });
  };
  let visited = 0;

  const visit = (path: string): void => {
    // A huge tree ends the walk rather than the other way round.
    if (visited >= limits.maxEntries) {
      snapshot.truncated = true;
      return;
    }
    visited += 1;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      skip(path, "unreadable");
      return;
    }
    // lstat reports symlinks and Windows junctions alike; never follow either.
    if (stat.isSymbolicLink()) {
      skip(path, "link");
      return;
    }
    if (stat.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(path).sort();
      } catch {
        skip(path, "unreadable");
        return;
      }
      for (const entry of entries) {
        if (snapshot.truncated) return;
        const child = join(path, entry);
        if (path === project && entry === "aidlc") continue;
        if (SKIPPED_DIRECTORIES.has(entry)) {
          skip(child, "excluded");
          continue;
        }
        visit(child);
      }
      return;
    }
    const refusal = !stat.isFile() ? "not-a-regular-file"
      : stat.size > limits.maxFileBytes ? "file-too-large"
      : snapshot.copied >= limits.maxFiles ? "file-limit"
      : snapshot.bytes + stat.size > limits.maxTotalBytes ? "total-limit"
      : null;
    if (refusal) {
      skip(path, refusal);
      return;
    }
    const target = join(destination, relative(project, path));
    try {
      mkdirSync(join(target, ".."), { recursive: true });
      copyFileSync(path, target);
    } catch {
      skip(path, "copy-failed");
      return;
    }
    snapshot.copied += 1;
    snapshot.bytes += stat.size;
  };

  if (existsSync(join(project, "aidlc"))) visit(join(project, "aidlc"));
  visit(project);
  writeFileSync(
    join(destination, "retained-fixture.json"),
    `${JSON.stringify({
      label,
      copied: snapshot.copied,
      bytes: snapshot.bytes,
      truncated: snapshot.truncated,
      skippedByReason: snapshot.skippedByReason,
      skipped: snapshot.skipped,
    }, null, 2)}\n`,
  );
  return snapshot;
}
