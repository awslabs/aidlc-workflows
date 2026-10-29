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
