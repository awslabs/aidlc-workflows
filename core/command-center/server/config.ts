import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cleanRepos } from "./repos";
export interface Config { version: 1; roots: string[]; pins: string[]; hidden: string[];
  /** Remote repo URLs: saved only, never fetched in phase 1. */
  repos: string[]; theme: "light" | "dark" | "auto";
  /** Opt-in behaviour; absent means every option is off. */
  settings?: { scanTranscripts: boolean } }
export const CONFIG_PATH = join(homedir(), ".aidlc", "dashboard.json");
const DEFAULT: Config = { version: 1, roots: [], pins: [], hidden: [], repos: [], theme: "auto" };
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
export function validateConfig(raw: unknown): Config {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const theme = o.theme === "light" || o.theme === "dark" || o.theme === "auto" ? o.theme : "auto";
  const settings = o.settings && typeof o.settings === "object" && !Array.isArray(o.settings) ? { scanTranscripts: (o.settings as Record<string, unknown>).scanTranscripts === true } : undefined;
  return { version: 1, roots: strs(o.roots), pins: strs(o.pins), hidden: strs(o.hidden), repos: cleanRepos(o.repos), theme, ...(settings ? { settings } : {}) };
}
/** Paths whose last load failed with a read error other than ENOENT: saving over them is refused. */
const unreadable = new Set<string>();
export class ConfigUnreadableError extends Error {
  constructor(path: string) { super(`${path} could not be read; not overwriting it`); this.name = "ConfigUnreadableError"; }
}
/**
 * Defaults when the file is absent; a file that is not valid JSON is renamed to `.corrupt-<ms>` (kept, not lost).
 * Any other read error (EACCES, EISDIR, EMFILE, …) returns defaults and leaves the file alone, and later saves
 * to that path are refused until a load succeeds.
 */
export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  let text: string;
  try { text = await Bun.file(path).text(); }
  catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") { unreadable.delete(path); return { ...DEFAULT }; }
    unreadable.add(path);
    console.error(`[command-center] ${path} could not be read (${(e as NodeJS.ErrnoException)?.code ?? e}); using defaults and leaving it untouched`);
    return { ...DEFAULT };
  }
  unreadable.delete(path);
  try { return validateConfig(JSON.parse(text)); } catch { await quarantine(path); return { ...DEFAULT }; }
}
async function quarantine(path: string): Promise<void> {
  try { await rename(path, `${path}.corrupt-${Date.now()}`); } catch { /* best effort */ }
}
let chain: Promise<void> = Promise.resolve();
export function saveConfig(cfg: Config, path = CONFIG_PATH): Promise<void> {
  const run = chain.then(async () => {
    if (unreadable.has(path)) throw new ConfigUnreadableError(path);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { await Bun.write(tmp, JSON.stringify(cfg, null, 2) + "\n"); await rename(tmp, path); }
    finally { await rm(tmp, { force: true }); }
  });
  chain = run.catch(() => {});
  return run;
}
