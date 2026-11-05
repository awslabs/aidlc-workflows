import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
