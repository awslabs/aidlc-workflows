import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";
export async function contain(root: string, candidate: string): Promise<string | null> {
  try { const r = await realpath(root); const c = await realpath(candidate); return c === r || c.startsWith(r + sep) ? c : null; } catch { return null; }
}
export function rewriteRecordedPath(recorded: string, projectRoot: string): string | null {
  if (!recorded.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(recorded)) return null;
  const norm = recorded.replace(/\\/g, "/"); const i = norm.lastIndexOf("/aidlc/");
  if (i < 0) return null;
  const base = join(projectRoot, "aidlc"); const out = join(projectRoot, norm.slice(i + 1));
  return out === base || out.startsWith(base + sep) ? out : null;
}
