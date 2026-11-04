import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { intentRegistryFromText } from "../../../tools/aidlc-record-core.ts";
import { contain } from "../paths";
export interface IntentRef { space: string; dir: string; uuid: string | null; slug: string; scope: string | null; status: string; registered: boolean }
/** A record dir name must be a single path segment: no separators, no `..`, not empty, no NUL. */
export const safeDirName = (d: string): boolean => d !== "" && d !== "." && !/[/\\\0]/.test(d) && !d.includes("..");
/**
 * Intents per space: registry entries (`intents.json`) with a safe dir name, then unregistered record dirs
 * with an `aidlc-state.md`. Every read is realpath-contained in `<root>/aidlc`; unregistered dirs must also
 * resolve inside their `intents/` folder.
 */
export async function listIntents(projectRoot: string): Promise<IntentRef[]> {
  const base = join(projectRoot, "aidlc"); const spacesDir = join(base, "spaces");
  let spaces: string[] = [];
  try { spaces = (await readdir(spacesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
  const out: IntentRef[] = [];
  for (const space of spaces) {
    const idir = await contain(base, join(spacesDir, space, "intents")); if (!idir) continue;
    let reg: { uuid?: string; slug?: string; dirName?: string; scope?: string; status?: string }[] = [];
    const regFile = await contain(base, join(idir, "intents.json"));
    // The canonical reader: BOM, comments, trailing commas and both sides of a git conflict.
    try { reg = regFile ? (intentRegistryFromText(await Bun.file(regFile).text()) as typeof reg) : []; } catch { reg = []; }
    const seen = new Set<string>();
    for (const r of reg) {
      if (!r || typeof r !== "object") continue;
      const dir = typeof r.dirName === "string" ? r.dirName : typeof r.slug === "string" && typeof r.uuid === "string" ? `${r.slug}-${r.uuid.slice(-8)}` : null;
      if (!dir || !safeDirName(dir) || seen.has(dir)) continue; seen.add(dir);
      out.push({ space, dir, uuid: typeof r.uuid === "string" ? r.uuid : null, slug: typeof r.slug === "string" ? r.slug : dir, scope: typeof r.scope === "string" ? r.scope : null, status: typeof r.status === "string" ? r.status : "in-flight", registered: true });
    }
    let entries: string[] = [];
    try { entries = (await readdir(idir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "audit").map((d) => d.name).sort(); } catch { entries = []; }
    for (const d of entries) {
      if (seen.has(d)) continue;
      const rec = await contain(idir, join(idir, d)); if (!rec) continue;
      if (await contain(base, join(rec, "aidlc-state.md"))) out.push({ space, dir: d, uuid: null, slug: d, scope: null, status: "in-flight", registered: false });
    }
  }
  return out;
}
