// The doctor export is unpacked into local/ so collect.ts can read its report.json; it is never sent.

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Every regular file under `dir`. A symbolic link is not followed: an unpacked archive could point one
// outside the folder.
export function walkFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return [];
    return st.isDirectory() ? walkFiles(path) : [path];
  });
}

// GNU tar (Linux, and Git for Windows' tar ahead of Windows' own bsdtar) reads `C:\…` as a remote host
// unless told the archive is local; bsdtar and BusyBox tar have no such flag.
let gnu: boolean | null = null;
function localFlag(): string[] {
  gnu ??= /GNU tar/i.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "");
  return gnu ? ["--force-local"] : [];
}

export function extractArchive(archive: string, dir: string): void {
  execFileSync("tar", ["-xzf", archive, ...localFlag(), "-C", dir]);
}
