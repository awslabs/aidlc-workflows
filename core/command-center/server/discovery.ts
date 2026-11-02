import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config";
const SKIP = new Set(["node_modules", ".git", "dist", "dist-release", "build", ".venv", ".cache", "aidlc"]);
export interface Found { path: string; origin: "root" | "pin"; root: string | null; exists: boolean }
async function isDir(p: string) { try { return (await stat(p)).isDirectory(); } catch { return false; } }
async function scan(dir: string, depth: number, out: string[]): Promise<void> {
  if (await isDir(join(dir, "aidlc"))) { out.push(dir); return; }
  if (depth === 0) return;
  let ents: Dirent[]; try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)) await scan(join(dir, e.name), depth - 1, out);
}
export async function discover(cfg: Config, maxDepth = 4): Promise<Found[]> {
  const hidden = new Set(cfg.hidden.map((h) => resolve(h))); const out: Found[] = []; const seen = new Set<string>();
  for (const r of cfg.roots) { const list: string[] = []; await scan(resolve(r), maxDepth, list); for (const p of list.sort()) if (!hidden.has(p) && !seen.has(p)) { seen.add(p); out.push({ path: p, origin: "root", root: resolve(r), exists: true }); } }
  for (const p of cfg.pins.map((x) => resolve(x))) if (!seen.has(p) && !hidden.has(p)) { seen.add(p); out.push({ path: p, origin: "pin", root: null, exists: await isDir(join(p, "aidlc")) }); }
  return out;
}
