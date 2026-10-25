// aidlc-folder-depth.ts - how deep a project folder can sit on Windows before
// AI-DLC's records cross the 260 characters Windows tools take. The one owner
// of the number, the two machine settings that lift it, and the words
// `aidlc config`, `aidlc doctor` and the Units Generation gate say.

import { spawnSync } from "node:child_process";
import { join, win32 } from "node:path";

// Without Windows long paths (LongPathsEnabled, off by default) PowerShell and
// cmd refuse a longer path; Git for Windows refuses one unless its
// core.longpaths is on, whatever Windows says; Node and Bun take it either way.
// Copilot CLI's own permission check refuses one with both on.
const WINDOWS_PATH_LIMIT = 260;

// The harnesses whose own check refuses a longer path whatever the machine
// says, by distribution name: under them only a shorter folder helps.
const REFUSES_ON_ITS_OWN = new Map([["copilot", "Copilot CLI"]]);

const LONG_PATHS_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem";
const WINDOWS_WAY = `set LongPathsEnabled to 1 in ${LONG_PATHS_KEY} as an administrator`;
const GIT_WAY = "run git config --global core.longpaths true";

// The deepest path AI-DLC writes under the project folder with every part it
// names at its longest: the review brief kept beside a stage's review record,
// for the longest stage name with a reviewer, under work whose label is at the
// engine's 24-character cap (intentDirNameBase):
// aidlc/spaces/default/intents/<YYMMDD>-<label>/.aidlc-engine/reviews/requirements-analysis/stage/briefs/<sha256>.md
// The person's names come on top, so the line says "about": a Unit's name on
// per-Unit records (UNIT_RECORD_DEPTH, once the Units are named), the `-2` of
// a second same-day intent, and the parallel build's Bolt checkout under
// .aidlc/worktrees/<bolt>/.
// t-windows-deep-folder checks the review paths the engine builds stay within it.
export const RECORD_DEPTH = 185;

// The deepest per-Unit record is the review brief of the longest per-Unit
// stage name with a reviewer. Under the work's record folder it takes this
// many characters before the Unit's own name:
// /.aidlc-engine/reviews/infrastructure-design/units/<unit>/briefs/<sha256>.md
export const UNIT_RECORD_SUFFIX = 126;

// The same record in the default space with the label at its cap, the count
// when the work's own record folder is not known:
// aidlc/spaces/default/intents/<YYMMDD>-<label>/.aidlc-engine/reviews/infrastructure-design/units/<unit>/briefs/<sha256>.md
// t-windows-deep-folder-gate checks the per-Unit review paths stay within it.
export const UNIT_RECORD_DEPTH = 186;

/** The two settings that let a Windows path past 260 characters. */
export interface LongPaths {
  /** Windows' LongPathsEnabled is on. */
  windows: boolean;
  /** Git's core.longpaths is true, or there is no Git to refuse. */
  git: boolean;
}

/**
 * The machine's two long-path settings, read and never written: the registry
 * value, and core.longpaths as git config reports it for the folder (its own
 * repository's config, the person's global one and the system's). A read that
 * fails counts as off, which keeps the line.
 */
export function readLongPaths(folder: string): LongPaths {
  const options = { encoding: "utf-8", windowsHide: true, timeout: 10_000 } as const;
  const registry = spawnSync(
    join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"),
    ["query", LONG_PATHS_KEY, "/v", "LongPathsEnabled"],
    options,
  );
  const git = spawnSync("git", ["-C", folder, "config", "--type=bool", "--get", "core.longpaths"], options);
  return {
    windows: registry.status === 0 && /\bLongPathsEnabled\s+REG_DWORD\s+0x0*[1-9a-f]/i.test(registry.stdout),
    git: (git.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
      (git.status === 0 && git.stdout.trim() === "true"),
  };
}

export interface DeepFolder {
  /** The project folder's length in characters. */
  depth: number;
  /** What AI-DLC's records add under it: RECORD_DEPTH, or the per-Unit records' depth with the longest Unit name. */
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
 * 260 characters; null on any other platform, for a folder short enough, and
 * when the machine takes long paths (both settings on) and none of `harnesses`
 * refuses one on its own. With the work's Unit names, their per-Unit records
 * are counted too, under the work's own record folder (relative to the
 * project) when it is given. Reads the path, and the machine's two settings
 * only once the folder is too deep and no such harness is named.
 */
export function deepFolder(
  projectDir: string,
  platform: NodeJS.Platform = process.platform,
  units?: { names: readonly string[]; recordFolder?: string | null },
  machine: { harnesses?: readonly (string | null)[]; longPaths?: (folder: string) => LongPaths } = {},
): DeepFolder | null {
  if (platform !== "win32") return null;
  const folder = win32.resolve(projectDir);
  const depth = folder.length;
  const longest = Math.max(0, ...(units?.names ?? []).map((name) => name.length));
  const adds = units && units.names.length > 0
    ? (units.recordFolder ? units.recordFolder.length + UNIT_RECORD_SUFFIX : UNIT_RECORD_DEPTH) + longest
    : RECORD_DEPTH;
  if (depth + 1 + adds <= WINDOWS_PATH_LIMIT) return null;
  const shorter = `move the project to a shorter folder (for example C:\\src\\${win32.basename(folder)})`;
  const own = machine.harnesses?.map((name) => REFUSES_ON_ITS_OWN.get(name ?? "")).find(Boolean);
  let refuses: string;
  let fix: string;
  if (own) {
    refuses = `${own} refuses`;
    fix = shorter;
  } else {
    const on = (machine.longPaths ?? readLongPaths)(folder);
    if (on.windows && on.git) return null;
    refuses = on.windows ? "Git refuses" : "Windows tools refuse";
    fix = `${shorter}, or ${
      on.windows
        ? `turn Git's long paths on: ${GIT_WAY}`
        : on.git
        ? `turn Windows long paths on: ${WINDOWS_WAY}`
        : `turn long paths on: ${WINDOWS_WAY}, then ${GIT_WAY}`
    }`;
  }
  const facts = `${depth} characters deep; ${refuses} paths over ${WINDOWS_PATH_LIMIT} characters ` +
    `and AI-DLC's records add about ${adds}`;
  return { depth, adds, facts, fix, note: `This project folder is ${facts}, so ${fix}.` };
}
