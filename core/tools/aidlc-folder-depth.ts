// aidlc-folder-depth.ts - how deep a project folder can sit on Windows before
// AI-DLC's records cross the 260 characters Windows tools take. The one owner
// of the number and the words `aidlc config` and `aidlc doctor` say.

import { win32 } from "node:path";

// Copilot CLI's own permission check and Git for Windows without long paths
// refuse a longer path, so a record past it cannot be written or committed.
const WINDOWS_PATH_LIMIT = 260;

// The deepest path AI-DLC writes under the project folder with every part it
// names at its longest: the review brief kept beside a stage's review record,
// for the longest stage name with a reviewer, under work whose label is at the
// engine's 24-character cap (intentDirNameBase):
// aidlc/spaces/default/intents/<YYMMDD>-<label>/.aidlc-engine/reviews/requirements-analysis/stage/briefs/<sha256>.md
// The person's names come on top, so the line says "about": a Unit's name on
// per-Unit records, the `-2` of a second same-day intent, and the parallel
// build's Bolt checkout under .aidlc/worktrees/<bolt>/.
// t-windows-deep-folder checks the review paths the engine builds stay within it.
export const RECORD_DEPTH = 185;

export interface DeepFolder {
  /** The project folder's length in characters. */
  depth: number;
  /** What AI-DLC's records add under it (RECORD_DEPTH). */
  adds: number;
  /** Doctor's row after "Project folder: ". */
  facts: string;
  /** Doctor's fix. */
  fix: string;
  /** Config's one line. */
  note: string;
}

/**
 * On Windows, a project folder deep enough that AI-DLC's records would pass
 * 260 characters; null on any other platform and for a folder short enough.
 * Reads nothing but the path.
 */
export function deepFolder(projectDir: string, platform: NodeJS.Platform = process.platform): DeepFolder | null {
  if (platform !== "win32") return null;
  const folder = win32.resolve(projectDir);
  const depth = folder.length;
  if (depth + 1 + RECORD_DEPTH <= WINDOWS_PATH_LIMIT) return null;
  const facts = `${depth} characters deep; Windows tools refuse paths over ${WINDOWS_PATH_LIMIT} characters ` +
    `and AI-DLC's records add about ${RECORD_DEPTH}`;
  const fix = `move the project to a shorter folder (for example C:\\src\\${win32.basename(folder)})`;
  return { depth, adds: RECORD_DEPTH, facts, fix, note: `This project folder is ${facts}, so ${fix}.` };
}
