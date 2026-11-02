// Folder choosing for Workspaces & settings. A browser file picker cannot return an absolute path, so the
// local server opens the OS folder chooser (fixed argv, no shell, no user input on the command line) and, as a
// fallback, lists sub-folder names for the in-app browser. Directory names only: file contents are never read.
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type PickResult = { path: string } | { cancelled: true } | { unavailable: string };
/** Runs argv to completion; kills the child when `signal` aborts. Rejects with `code: "ENOENT"` when the executable does not exist. */
export type SpawnFn = (argv: string[], signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>;
/** Arms `fn` after `ms`; returns a cancel function. Injectable so tests need not wait 10 minutes. */
export type TimerFn = (fn: () => void, ms: number) => () => void;
/** A chooser nobody answers is closed after this long, so the one-at-a-time lock cannot stay held forever. */
export const PICK_TIMEOUT_MS = 10 * 60_000;

export const bunSpawn: SpawnFn = async (argv, signal) => {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = () => p.kill();
  if (signal?.aborted) kill(); else signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } finally { signal?.removeEventListener("abort", kill); }
};
const realTimer: TimerFn = (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };

const PROMPT = "Choose a folder for the AI-DLC Command Center";
const MAC = ["osascript", "-e", `POSIX path of (choose folder with prompt "${PROMPT}")`];
const WIN_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  `$d.Description = '${PROMPT}'`,
  "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
].join("; ");
const WIN = ["powershell.exe", "-NoProfile", "-STA", "-Command", WIN_SCRIPT];
const ZENITY = ["zenity", "--file-selection", "--directory", `--title=${PROMPT}`];
const kdialog = () => ["kdialog", "--getexistingdirectory", homedir()];

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";

/** Strips the line ending and any trailing separator, except on a filesystem root (`/`, `C:\`). */
function tidy(out: string): string {
  const p = out.replace(/\r?\n$/, "").replace(/\r$/, "");
  if (p === "/" || /^[A-Za-z]:[\\/]$/.test(p)) return p;
  return p.replace(/[\\/]+$/, "") || p;
}
async function chosen(out: string): Promise<PickResult> {
  const p = tidy(out);
  if (!p) return { cancelled: true };
  try { if ((await stat(p)).isDirectory()) return { path: p }; } catch { /* fall through */ }
  return { unavailable: "the folder chooser returned a path that is not an existing folder" };
}

/**
 * Opens the OS folder chooser and waits for the user, at most PICK_TIMEOUT_MS: then the chooser is killed and the
 * result is `unavailable`. Never throws.
 */
export async function pickFolder(opts: { spawn?: SpawnFn; platform?: NodeJS.Platform; timer?: TimerFn } = {}): Promise<PickResult> {
  const ac = new AbortController();
  let expire!: (r: PickResult) => void;
  const expired = new Promise<PickResult>((r) => { expire = r; });
  const cancel = (opts.timer ?? realTimer)(() => {
    ac.abort();
    expire({ unavailable: `the folder chooser timed out after ${Math.round(PICK_TIMEOUT_MS / 60_000)} minutes and was closed` });
  }, PICK_TIMEOUT_MS);
  try { return await Promise.race([runPicker(opts.spawn ?? bunSpawn, opts.platform ?? process.platform, ac.signal), expired]); }
  finally { cancel(); }
}
async function runPicker(spawnFn: SpawnFn, platform: NodeJS.Platform, signal: AbortSignal): Promise<PickResult> {
  const spawn = (argv: string[]) => spawnFn(argv, signal);
  try {
    if (platform === "darwin") {
      const r = await spawn(MAC);
      if (r.code === 0) return chosen(r.stdout);
      if (/User cancel+ed|\(-128\)/.test(r.stderr)) return { cancelled: true };
      return { unavailable: `the macOS folder chooser failed: ${firstLine(r.stderr) || `exit ${r.code}`}` };
    }
    if (platform === "win32") {
      const r = await spawn(WIN);
      if (r.code === 0) return chosen(r.stdout);
      return { unavailable: `the Windows folder chooser failed: ${firstLine(r.stderr) || `exit ${r.code}`}` };
    }
    if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
      for (const argv of [ZENITY, kdialog()]) {
        let r: Awaited<ReturnType<typeof spawn>>;
        try { r = await spawn(argv); } catch (e) { if (isEnoent(e)) continue; throw e; }
        if (r.code === 0) return chosen(r.stdout);
        if (r.code === 1) return { cancelled: true };
        return { unavailable: `${argv[0]} failed: ${firstLine(r.stderr) || `exit ${r.code}`}` };
      }
      return { unavailable: "no folder chooser found (install zenity or kdialog)" };
    }
    return { unavailable: `no native folder chooser on ${platform}` };
  } catch (e) {
    if (isEnoent(e)) return { unavailable: "the system folder chooser is not installed" };
    return { unavailable: `the folder chooser could not start: ${(e as Error)?.message ?? e}` };
  }
}

export interface FolderEntry { name: string; path: string; isAidlc: boolean }
export interface FolderListing { path: string; parent: string | null; entries: FolderEntry[]; truncated: boolean }
export class FolderError extends Error {
  constructor(public status: 400 | 403 | 404, msg: string) { super(msg); this.name = "FolderError"; }
}
export const MAX_ENTRIES = 500;
const isDir = async (p: string) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

/**
 * Sub-folder names of an absolute folder (default: the home folder), resolved through symlinks. Dot-folders,
 * files and symlinks to files are left out; at most MAX_ENTRIES, sorted. `isAidlc`: it has an `aidlc/` folder.
 */
export async function listFolder(path?: string): Promise<FolderListing> {
  const want = path || homedir();
  if (!isAbsolute(want)) throw new FolderError(400, "path must be absolute");
  let real: string;
  try { real = await realpath(want); } catch (e) { throw codeError(e); }
  if (!(await isDir(real))) throw notAFolder();
  let ents: Dirent[];
  try { ents = await readdir(real, { withFileTypes: true }); } catch (e) { throw codeError(e); }
  const cands = ents.filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const dirs: string[] = [];
  // Symlinks are kept only when they lead to a folder; stop once the cap is passed (+1 to know it was hit).
  for (const e of cands) {
    if (e.isDirectory() || await isDir(join(real, e.name))) dirs.push(e.name);
    if (dirs.length > MAX_ENTRIES) break;
  }
  const truncated = dirs.length > MAX_ENTRIES;
  const kept = dirs.slice(0, MAX_ENTRIES);
  const entries = await Promise.all(kept.map(async (name) => ({ name, path: join(real, name), isAidlc: await isDir(join(real, name, "aidlc")) })));
  const parent = dirname(real);
  return { path: real, parent: parent === real ? null : parent, entries, truncated };
}
/** Missing paths and files get the same answer: the listing never says which one it was. */
const notAFolder = () => new FolderError(404, "not a folder");
function codeError(e: unknown): FolderError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return new FolderError(403, "permission denied");
  return notAFolder();
}
