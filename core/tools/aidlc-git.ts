import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";

export function gitSubmoduleNames(checkoutDir: string, platformArgs: readonly string[], commit?: string): Map<string, string> {
  const names = new Map<string, string>();
  if (commit === undefined && !existsSync(join(checkoutDir, ".gitmodules"))) return names;
  const source = commit === undefined ? ["-f", ".gitmodules"] : ["--blob", `${commit}:.gitmodules`];
  const listed = spawnSync("git", [
    ...platformArgs, "config", ...source, "-z", "--get-regexp", "^submodule\\..*\\.path$",
  ], { cwd: checkoutDir, encoding: "utf-8", timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS });
  if (listed.status !== 0) return names;
  for (const record of listed.stdout.split("\0")) {
    const newline = record.indexOf("\n");
    if (newline === -1) continue;
    const key = record.slice(0, newline);
    names.set(record.slice(newline + 1), key.slice("submodule.".length, -".path".length));
  }
  return names;
}

// Run git in the workspace, fail-safe: returns null on any spawn/exec problem so
// callers fall back to the filesystem check rather than trapping. The person's
// own git settings apply: this is their machine and their project, and git here
// behaves as it does in their terminal. `outside` is a checkout outside the
// project: --no-optional-locks keeps git from refreshing its index there, so
// asking it writes nothing.
export function git(pd: string, args: string[], outside = false): string | null {
  try {
    const r = spawnSync("git", outside ? ["--no-optional-locks", ...args] : args, {
      cwd: pd,
      encoding: "utf-8",
      timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS,
    });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout;
  } catch {
    return null;
  }
}

// True when `pd` is inside a git work tree. (`--is-inside-work-tree` prints
// "true"/"false"; a non-repo exits non-zero -> git() returns null -> false.)
export function isGitRepo(pd: string, outside = false): boolean {
  return git(pd, ["rev-parse", "--is-inside-work-tree"], outside)?.trim() === "true";
}

// Where a folder sits in its git repository: the repository's top as git
// prints it, and the folder's path from there, "" at the top and "apps/web/"
// in a package of a monorepo ("/"-separated and ending in "/" on every
// platform). git prints and reads some paths from the top (status and diff
// name lists, REV:path, update-index --cacheinfo) while AI-DLC's record paths
// are from the project folder; this is the one reading of where the project
// sits, and inRepo and inProject cross between the two frames. Null outside a
// work tree.
export interface ProjectInRepo {
  top: string;
  prefix: string;
}

// A found answer is kept for the process; a folder git does not know is asked
// again, so one made a repository later in the same process is seen.
const projectsInRepo = new Map<string, ProjectInRepo>();

export function projectInRepo(dir: string): ProjectInRepo | null {
  const key = resolve(dir);
  const known = projectsInRepo.get(key);
  if (known !== undefined) return known;
  const printed = git(dir, ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (printed === null) return null;
  // Only the line ends are cut, so a folder name's own spaces stay.
  const [top, prefix = ""] = printed.split(/\r?\n/);
  if (!top) return null;
  const found = { top, prefix };
  projectsInRepo.set(key, found);
  return found;
}

// A project path as git takes it from the repository's top.
export function inRepo(prefix: string, projectPath: string): string {
  return `${prefix}${projectPath}`;
}

// A path git printed from the repository's top as a project path, or null when
// it is outside the project; what such a path is to it is each caller's.
export function inProject(prefix: string, repoPath: string): string | null {
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
}

export type GitDirs = { ok: true; common: string; own: string } | { ok: false; stderr: string };

// The repository's shared git directory and this checkout's own one (they
// differ only in a linked worktree), or git's own words when it cannot say.
// git prints both relative to the folder it ran in, so they are resolved
// against `dir`, never against the repository's top: the two are the same only
// at the top, and from a folder the top climbs too high, where a git directory
// that happens to sit there (a repository vendored in another, a home folder
// that is one) would be another repository's. `env` and `timeout` are the
// caller's, for a read that must ignore git's repository-redirect variables.
export function gitCommonDirOf(
  dir: string,
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): GitDirs {
  try {
    const r = spawnSync("git", ["rev-parse", "--git-common-dir", "--git-dir"], {
      cwd: dir,
      encoding: "utf-8",
      env: options.env,
      timeout: options.timeout ?? DEFAULT_SUBPROCESS_TIMEOUT_MS,
    });
    const [common, own] = (r.stdout ?? "").trim().split(/\r?\n/);
    if (r.status !== 0 || !common || !own) return { ok: false, stderr: (r.stderr ?? "").trim() };
    return { ok: true, common: resolve(dir, common), own: resolve(dir, own) };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

// A folder a person made a Git checkout of: a real .git entry (a folder, or a
// worktree's or submodule's file), by lstat, so no link is followed. A commit
// can never carry a .git entry, so a committed folder merely shaped like a repo
// never passes and git never runs on its config.
export function hasRealGitEntry(dir: string): boolean {
  try {
    const entry = lstatSync(join(dir, ".git"));
    return entry.isDirectory() || entry.isFile();
  } catch {
    return false;
  }
}

// Parse .gitmodules (ini-like) into submodule entries. Pure and exported for
// direct unit testing. Line-oriented, tolerant: malformed content degrades to
// whatever parses (total garbage yields []); it never throws. An entry with no
// path is dropped, as is any path that is absolute or escapes the project via a
// `..` segment (a caller joins path under projectDir and must not follow it out).
export function parseGitmodules(
  content: string
): Array<{ name: string; path: string; url: string }> {
  const entries: Array<{ name: string; path: string; url: string }> = [];
  let current: { name: string; path: string; url: string } | null = null;
  const finish = () => {
    if (!current) return;
    const p = current.path;
    const isUnsafe =
      p === "" ||
      p.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(p) || // Windows drive-absolute
      p.split(/[/\\]/).includes("..");
    if (!isUnsafe) entries.push(current);
    current = null;
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      finish();
      const m = line.match(/^\[submodule\s+"(.+)"\]$/);
      current = m ? { name: m[1], path: "", url: "" } : null;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "path") current.path = value;
    else if (key === "url") current.url = value;
  }
  finish();
  return entries;
}

// A path .gitmodules lists, as the '/'-joined path from the project the scan
// walks (a Windows path's backslashes, a leading ./ and a trailing slash read
// the same).
export function submodulePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

// Whether `name` is a folder the project's .gitmodules lists.
export function isProjectSubmodule(projectDir: string, name: string): boolean {
  let content: string;
  try {
    content = readFileSync(join(projectDir, ".gitmodules"), "utf-8");
  } catch {
    return false;
  }
  return parseGitmodules(content).some((entry) => submodulePath(entry.path) === name);
}

// Whether remove-repo can take `name` off work that records only it: a
// submodule the project lists, in a project that is a checkout of its own, so
// the project folder is the work's repo again, as in any one-repo project.
// remove-repo and the Unit source manifest's reader read this one rule.
export function submoduleLeavesProjectRepo(projectDir: string, name: string): boolean {
  return hasRealGitEntry(projectDir) && isProjectSubmodule(projectDir, name);
}
