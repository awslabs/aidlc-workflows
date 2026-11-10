import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
